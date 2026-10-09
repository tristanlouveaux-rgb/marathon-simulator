/**
 * Prediction inputs. Source-agnostic helper for building the training-volume
 * and training-pace signals that feed `blendPredictions` (and Tanda 2011).
 *
 * Used by both the live stats view (garminActuals) and onboarding (Strava
 * scraped history). Keeping the logic here as a pure function means one
 * code path, one set of tests, and no drift between the two surfaces.
 *
 * The computation mirrors Tanda's paper methodology as closely as practical:
 *   - Window: up to 8 weeks anchored on the most recent activity
 *   - P: unweighted arithmetic mean of per-session pace across training runs
 *   - K: mean weekly running km across the window
 *   - Races filtered from P (race effort, below) but kept in K
 *   - Recent run = the newest race effort. Race effort: more than 15% faster
 *     than the window's median pace AND, when the run has an average HR and the
 *     athlete's HR zones are known, an average HR at race level on the HR
 *     effort scale (at or above the top of the threshold zone, Z5). Easy runs
 *     never pass the pace test; a tempo run with a tempo-level HR now fails the
 *     HR test. Without HR the test is pace-only, so a tempo-paced run with no
 *     HR still counts (known limitation, pinned in
 *     initialization.easy-runs-vdot.test.ts)
 *
 * See `docs/SCIENCE_LOG.md` for the Tanda entry and the rationale behind each
 * filter / guard.
 */

import type { SimulatorState } from '@/types';

export interface RunActivityInput {
  /** ISO string or Date. Used for ordering and window selection. */
  startTime: string | Date;
  /** Distance in km. */
  distKm: number;
  /** Duration in seconds. */
  durSec: number;
  /** Optional — not used today but available for future workout-detection. */
  activityName?: string;
  activityType?: string;
  /** Average heart rate (bpm). Populated when available; consumed by
   *  `computeHRCalibratedVdot` for effort-calibrated VDOT estimation. */
  avgHR?: number | null;
  /** HR drift % (positive = HR rose over the second half). Populated by
   *  stream processing when available; consumed by HR-calibrated VDOT as
   *  an aerobic-decoupling filter. */
  hrDrift?: number | null;
}

export interface PredictionInputs {
  /** Mean weekly running km across the window. */
  weeklyKm: number;
  /** Unweighted mean of per-session pace (sec/km) across training runs. Null
   *  when insufficient data or window is stale. */
  avgPaceSecPerKm: number | null;
  /** Most recent RACE EFFORT in the window: a qualifying run at least 15%
   *  faster than the window's median pace (RACE_FILTER_RATIO, the same test
   *  that removes races from P) whose average HR, when the run has one and
   *  `raceHrFloorBpm` is known, is at race level (at or above the floor). Null
   *  when the window holds only training runs. Every consumer treats this as a
   *  race or time trial (blend `predictFromRecent`, the engine-floor slowness
   *  gate, the demonstrated-PB floor), so an easy run must never fill it. With
   *  no HR the test is pace-only: a tempo or threshold session, or a parkrun at
   *  tempo effort, passes it and is read as a race (known limitation, pinned in
   *  initialization.easy-runs-vdot.test.ts). */
  recentRun: { d: number; t: number; weeksAgo: number } | null;
  /** Number of weeks in the analysis window (up to 8). */
  weeksCovered: number;
  /** Number of runs counted toward K. */
  runsCounted: number;
  /** Number of runs counted toward P (after race-outlier filter). */
  paceRunsCounted: number;
  /** True if the most recent run is >28 days old — P is unreliable. */
  isStale: boolean;
  /** High: ≥8 sessions over ≥6 weeks. Medium: ≥4 sessions over ≥3 weeks.
   *  Low: ≥3 sessions. None: insufficient for Tanda. */
  paceConfidence: 'high' | 'medium' | 'low' | 'none';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_WEEKS = 8;
const STALE_DAYS = 28;
const MIN_DIST_KM = 3;
const MIN_PACE = 180;   // 3:00 /km. Faster = sprint interval, treat as suspect
const MAX_PACE = 480;   // 8:00 /km. Slower = walk / hike / treadmill drift
const RACE_FILTER_RATIO = 0.85; // faster than 85% of median = race effort
/** Activity-name patterns that signal non-training data even if the pace passes
 *  the band check. Treadmill GPS drift can produce plausible paces; walks
 *  often log as "Walk" while still hitting the run-pace floor. Drop on name. */
const NON_TRAINING_NAME_RE = /treadmill|walk/i;
/** After all the hard filters above, drop the slowest 10% of the remaining
 *  set. Pure noise filter. The slowest tail tends to be aborted runs, mid-run
 *  walk breaks logged as separate activities, or warm-down jogs without GPS. */
const SLOW_TAIL_DROP_FRACTION = 0.10;

/** Dedup key buckets startTime to the nearest 5 minutes and distance to 0.1 km.
 *  5-min window catches Strava/Garmin dual-logs where GPS-start vs watch-start
 *  can differ by 1–2 minutes. */
function dedupKey(a: RunActivityInput): string {
  const ts = new Date(a.startTime).getTime();
  const bucket = Math.round(ts / (5 * 60000));
  const distBucket = Math.round(a.distKm * 10);
  return `${bucket}:${distBucket}`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute prediction inputs from an arbitrary list of run activities.
 * Pure function. No state dependency, fully testable.
 *
 * @param runs  All running activities available. Non-runs, walks, and paces
 *              outside 3:00–7:30 /km are filtered out.
 * @param now   Anchor time for the 8-week window. Defaults to current time;
 *              pass explicitly in tests for determinism.
 * @param raceHrFloorBpm  The lowest average HR that reads as a race effort on
 *              the athlete's HR effort scale (`raceEffortHrFloorForState`,
 *              heart-rate.ts: the top of the threshold zone). When set, a run
 *              that has an average HR must reach it to count as a race effort.
 *              Null or omitted: pace-only, as before. Every caller that has the
 *              athlete's state passes it, so the recent run and Tanda's P are
 *              the same on every surface.
 */
export function computePredictionInputs(
  runs: RunActivityInput[],
  now: Date = new Date(),
  raceHrFloorBpm?: number | null,
): PredictionInputs {
  const empty: PredictionInputs = {
    weeklyKm: 0,
    avgPaceSecPerKm: null,
    recentRun: null,
    weeksCovered: 0,
    runsCounted: 0,
    paceRunsCounted: 0,
    isStale: false,
    paceConfidence: 'none',
  };

  if (!runs || runs.length === 0) return empty;

  // ── Sanitise + dedup ─────────────────────────────────────────────────────
  const seen = new Set<string>();
  const qualifying: Array<{ startMs: number; distKm: number; durSec: number; paceSecPerKm: number; avgHR: number | null }> = [];
  for (const r of runs) {
    if (!r.distKm || r.distKm < MIN_DIST_KM || !r.durSec || r.durSec <= 0) continue;
    const pace = r.durSec / r.distKm;
    if (pace < MIN_PACE || pace > MAX_PACE) continue;
    // Name-based reject for treadmill / walk activities. Treadmills produce
    // GPS-less paces from accelerometer estimates that drift; walks frequently
    // sit just inside the slow pace band. Both pollute Tanda's P regardless.
    const nm = (r.activityName ?? '').trim();
    if (nm && NON_TRAINING_NAME_RE.test(nm)) continue;
    const key = dedupKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    qualifying.push({
      startMs: new Date(r.startTime).getTime(),
      distKm: r.distKm,
      durSec: r.durSec,
      paceSecPerKm: pace,
      avgHR: r.avgHR != null && r.avgHR > 0 ? r.avgHR : null,
    });
  }
  if (qualifying.length === 0) return empty;

  // ── Drop the slowest 10% by pace (noise tail) ────────────────────────────
  // After the hard pace/distance/name filters, the slowest tail in any sample
  // tends to be aborted runs, mid-run walk breaks logged as separate activities,
  // or untracked warm-downs. They distort P (Tanda's training pace) far more
  // than they inform K. Drop floor: keep at least 3 runs so a sparse log isn't
  // wiped out by trimming.
  if (qualifying.length >= 5) {
    const dropCount = Math.floor(qualifying.length * SLOW_TAIL_DROP_FRACTION);
    if (dropCount > 0) {
      qualifying.sort((a, b) => a.paceSecPerKm - b.paceSecPerKm); // fastest → slowest
      qualifying.splice(qualifying.length - dropCount, dropCount);
    }
  }

  // ── Window: 8 weeks back from the most recent qualifying run ─────────────
  // Anchoring on the most recent run (not `now`) means a user who just logged
  // their first run after a 3-month break still gets meaningful metrics on
  // that single week, with isStale reflecting the gap before it.
  qualifying.sort((a, b) => b.startMs - a.startMs);
  const latestMs = qualifying[0].startMs;
  const ageDays = Math.floor((now.getTime() - latestMs) / DAY_MS);
  const isStale = ageDays > STALE_DAYS;

  const windowStartMs = latestMs - WINDOW_WEEKS * 7 * DAY_MS;
  const inWindow = qualifying.filter(q => q.startMs >= windowStartMs);

  if (inWindow.length === 0) return { ...empty, isStale };

  // One race-effort test for the window, shared by the recent run and P: a run
  // more than 15% faster than the median pace is a race or time trial
  // (RACE_FILTER_RATIO). SCIENCE_LOG "Effort-Calibrated VDOT from HR" defines
  // the hard-effort signal the same way. Pace alone cannot tell a race from a
  // tempo or threshold session, so a run that carries an average HR must also
  // be at race level on the HR effort scale: at or above the top of the
  // threshold zone (raceHrFloorBpm). A tempo run averages inside the threshold
  // zone (Z4, the zone threshold and tempo sessions target); a 5K to 10K race
  // averages above it. A run without HR, or an athlete without HR zones, keeps
  // the pace-only test.
  const medianPace = median(inWindow.map(q => q.paceSecPerKm));
  const hrFloor = raceHrFloorBpm != null && raceHrFloorBpm > 0 ? raceHrFloorBpm : null;
  const isRaceEffort = (q: { paceSecPerKm: number; avgHR: number | null }): boolean =>
    q.paceSecPerKm < medianPace * RACE_FILTER_RATIO
    && (hrFloor == null || q.avgHR == null || q.avgHR >= hrFloor);

  // ── Recent run (the newest race effort in the window) ────────────────────
  // Consumers project this run to the target distance as a race performance
  // (predictFromRecent) and read a slower projection as demonstrated loss of
  // fitness (the engine floor in refreshBlendedFitness / initialization, the
  // demonstrated-PB floor). An easy run projected that way reads as a much
  // slower race: a 10K 45:00 runner's 16 km easy run at 5:52/km projected the
  // engine VDOT from 45.3 down to about 37, the same with or without a zone-2
  // heart rate. Easy runs feed P (Tanda) and the HR calibration instead.
  // With HR, a tempo run at a tempo-level HR is a training run. Without HR a
  // tempo-paced training run still passes the race test (known limitation,
  // pinned in initialization.easy-runs-vdot.test.ts).
  const newest = inWindow.find(q => isRaceEffort(q));
  const recentRun = newest
    ? {
      d: newest.distKm,
      t: newest.durSec,
      weeksAgo: Math.max(0, Math.round((now.getTime() - newest.startMs) / (7 * DAY_MS))),
    }
    : null;

  // ── K: weekly km ─────────────────────────────────────────────────────────
  // Sum km per week-offset (0 = week of latest run, 1 = week prior, etc.),
  // then mean across the effective window. Zero-running weeks inside the
  // window count as 0. They're real information about volume. But we cap
  // the window at the actual training history available, so a brand-new user
  // with 2 weeks of Strava data doesn't get their K divided by 8.
  const weekKm = new Map<number, number>();
  for (const q of inWindow) {
    const weekIdx = Math.floor((latestMs - q.startMs) / (7 * DAY_MS));
    weekKm.set(weekIdx, (weekKm.get(weekIdx) || 0) + q.distKm);
  }

  // Determine weeks of available history from the earliest qualifying run
  // *anywhere* in `qualifying` (not just inWindow). If the user has runs
  // pre-dating the 8-week window, they have full training history → 8 weeks.
  // If their earliest ever run is more recent than 8 weeks, use that span.
  const earliestAnywhereMs = qualifying[qualifying.length - 1].startMs;
  const weeksOfHistoryFloat = (latestMs - earliestAnywhereMs) / (7 * DAY_MS);
  const weeksInWindow = Math.min(WINDOW_WEEKS, Math.max(1, Math.ceil(weeksOfHistoryFloat) + 1));

  let kmSum = 0;
  for (let wi = 0; wi < weeksInWindow; wi++) {
    kmSum += weekKm.get(wi) || 0;
  }
  const weeklyKm = weeksInWindow > 0 ? kmSum / weeksInWindow : 0;

  // ── P: unweighted mean of training paces (race-filtered) ─────────────────
  // Tanda's paper uses unweighted mean across training sessions. We filter
  // race efforts by detecting runs meaningfully faster than median. Those
  // are not "training pace" and would skew P fast.
  const trainingPaces = inWindow.filter(q => !isRaceEffort(q)).map(q => q.paceSecPerKm);

  let avgPaceSecPerKm: number | null = null;
  let paceConfidence: PredictionInputs['paceConfidence'] = 'none';

  if (!isStale && trainingPaces.length >= 3) {
    avgPaceSecPerKm = trainingPaces.reduce((a, b) => a + b, 0) / trainingPaces.length;
    if (trainingPaces.length >= 8 && weeksInWindow >= 6) paceConfidence = 'high';
    else if (trainingPaces.length >= 4 && weeksInWindow >= 3) paceConfidence = 'medium';
    else paceConfidence = 'low';
  }

  return {
    weeklyKm,
    avgPaceSecPerKm,
    recentRun,
    weeksCovered: weeksInWindow,
    runsCounted: inWindow.length,
    paceRunsCounted: trainingPaces.length,
    isStale,
    paceConfidence,
  };
}

/**
 * Resolve the weekly-km signal for the prediction blend.
 *
 * History-derived volume (computePredictionInputs over synced runs) is the
 * primary signal. When the 8-week window contains NO qualifying runs at all
 * (`weeksCovered === 0`), fall back to `detectedWeeklyKm` — which carries
 * the user's typed weekly volume from manual entry when nothing was scraped
 * (and the last history aggregation otherwise). A stated volume is weaker
 * than measured history but strictly better than treating an empty scrape
 * as "explicitly zero recent training": the volume-sensitive blend terms
 * (lowVolumeDiscount weight shift, marathon-specificity penalty) otherwise
 * fire at maximum severity against a user who told us what they run.
 * Real case, 2026-06-04: typed "10 km/week" + 0 scraped activities → blend
 * saw weeklyKm=0.
 *
 * When neither signal exists, returns `inputs.weeklyKm` (0) unchanged —
 * preserving blendPredictions' "explicit zero is signal" contract. For a
 * user with real history but an empty recent window, `detectedWeeklyKm`
 * is itself recomputed from the last 4 aggregated weeks (≈0), so the
 * fallback cannot resurrect stale volume there.
 */
export function resolveWeeklyKmSignal(
  inputs: Pick<PredictionInputs, 'weeklyKm' | 'weeksCovered'>,
  detectedWeeklyKm: number | null | undefined,
): number {
  if (inputs.weeksCovered > 0) return inputs.weeklyKm;
  if (detectedWeeklyKm != null && detectedWeeklyKm > 0) return detectedWeeklyKm;
  return inputs.weeklyKm;
}

/**
 * Assemble `RunActivityInput[]` from whichever sources are available in the
 * current state. Preference order:
 *   - `s.wks[].garminActuals` (live sync. Authoritative for returning users)
 *   - `s.onboardingRunHistory` (seeded by backfill response. First-session data)
 * Both may coexist for a user mid-onboarding; we merge and let the dedup in
 * `computePredictionInputs` collapse overlaps.
 */
export function collectRunsFromState(s: SimulatorState): RunActivityInput[] {
  const runs: RunActivityInput[] = [];
  const weeks = s.wks ?? [];
  for (const wk of weeks) {
    const actuals = (wk as { garminActuals?: Record<string, unknown> }).garminActuals;
    if (!actuals) continue;
    for (const val of Object.values(actuals)) {
      const a = val as {
        activityType?: string; startTime?: string; distanceKm?: number; durationSec?: number;
        activityName?: string; avgHR?: number | null; hrDrift?: number | null;
      };
      const aType = (a.activityType || '').toUpperCase();
      if (aType !== 'RUNNING' && !aType.includes('RUN')) continue;
      if (!a.startTime || !a.distanceKm || !a.durationSec) continue;
      runs.push({
        startTime: a.startTime,
        distKm: a.distanceKm,
        durSec: a.durationSec,
        activityName: a.activityName,
        activityType: a.activityType,
        avgHR: a.avgHR ?? null,
        hrDrift: a.hrDrift ?? null,
      });
    }
  }
  if (s.onboardingRunHistory && s.onboardingRunHistory.length > 0) {
    for (const r of s.onboardingRunHistory) runs.push(r);
  }
  return runs;
}
