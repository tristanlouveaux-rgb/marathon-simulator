/**
 * Prediction inputs — source-agnostic helper for building the training-volume
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
 *   - Races filtered from P (15% faster than median = race effort) but kept in K
 *
 * See `docs/SCIENCE_LOG.md` for the Tanda entry and the rationale behind each
 * filter / guard.
 */

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
  /** Most recent qualifying run (≥2 km, sane pace). Null if none found. */
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
const MIN_DIST_KM = 2;
const MIN_PACE = 180;   // 3:00 /km — faster = sprint interval, treat as suspect
const MAX_PACE = 450;   // 7:30 /km — slower = walk / hike
const RACE_FILTER_RATIO = 0.85; // faster than 85% of median = race effort

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
 * Pure function — no state dependency, fully testable.
 *
 * @param runs  All running activities available. Non-runs, walks, and paces
 *              outside 3:00–7:30 /km are filtered out.
 * @param now   Anchor time for the 8-week window. Defaults to current time;
 *              pass explicitly in tests for determinism.
 */
export function computePredictionInputs(
  runs: RunActivityInput[],
  now: Date = new Date(),
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
  const qualifying: Array<{ startMs: number; distKm: number; durSec: number; paceSecPerKm: number }> = [];
  for (const r of runs) {
    if (!r.distKm || r.distKm < MIN_DIST_KM || !r.durSec || r.durSec <= 0) continue;
    const pace = r.durSec / r.distKm;
    if (pace < MIN_PACE || pace > MAX_PACE) continue;
    const key = dedupKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    qualifying.push({
      startMs: new Date(r.startTime).getTime(),
      distKm: r.distKm,
      durSec: r.durSec,
      paceSecPerKm: pace,
    });
  }
  if (qualifying.length === 0) return empty;

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

  // ── Recent run (the newest qualifying run in the window) ─────────────────
  const newest = inWindow[0];
  const weeksAgoFloat = (now.getTime() - newest.startMs) / (7 * DAY_MS);
  const recentRun = {
    d: newest.distKm,
    t: newest.durSec,
    weeksAgo: Math.max(0, Math.round(weeksAgoFloat)),
  };

  // ── K: weekly km ─────────────────────────────────────────────────────────
  // Sum km per week-offset (0 = week of latest run, 1 = week prior, etc.),
  // then mean across the effective window. Zero-running weeks inside the
  // window count as 0 — they're real information about volume — but we cap
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
  // race efforts by detecting runs meaningfully faster than median — those
  // are not "training pace" and would skew P fast.
  const paces = inWindow.map(q => q.paceSecPerKm);
  const medianPace = median(paces);
  const trainingPaces = paces.filter(p => p >= medianPace * RACE_FILTER_RATIO);

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
