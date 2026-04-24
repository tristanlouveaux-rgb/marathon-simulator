/**
 * Derive triathlon benchmarks from historic activity data.
 *
 * **Side of the line**: tracking. These functions look at what the athlete
 * has actually done (Strava / Garmin synced activities) and produce best
 * estimates for the benchmarks the prediction engine needs — CSS, FTP,
 * per-discipline CTL.
 *
 * Pure functions only. No state mutation, no I/O — the call sites in
 * `initialization.triathlon.ts` / `main.ts` are the ones that read state
 * and write back.
 *
 * **What works today**:
 *   - CSS estimate from swim activity pace
 *   - Per-discipline CTL baseline from historic activity TSS
 *
 * **What's scaffolded but returns undefined**:
 *   - FTP estimate from bike power curve — requires average_watts /
 *     normalized_power in the garmin_activities schema, which the edge
 *     function doesn't persist yet. Feature-flagged via the presence of
 *     power fields on the activity; when the data lands the function
 *     will produce an estimate automatically.
 */

import type { GarminActual } from '@/types/state';
import type { PerDisciplineFitness } from '@/types/triathlon';
import { CTL_TAU_DAYS, ATL_TAU_DAYS } from '@/constants/triathlon-constants';

// ───────────────────────────────────────────────────────────────────────────
// Activity classification — shared helpers
// ───────────────────────────────────────────────────────────────────────────

/** Strava + Garmin emit various strings for the same sport. Normalise to one. */
export function classifyActivity(activityType: string | null | undefined): 'swim' | 'bike' | 'run' | 'other' {
  if (!activityType) return 'other';
  const s = activityType.toLowerCase();
  if (s.includes('swim')) return 'swim';
  if (s.includes('ride') || s.includes('cycl') || s.includes('bike') || s.includes('biking') || s.includes('virtualride')) return 'bike';
  if (s === 'run' || s.includes('running')) return 'run';
  return 'other';
}

// ───────────────────────────────────────────────────────────────────────────
// CSS (swim) from activity history
// ───────────────────────────────────────────────────────────────────────────

export interface CssEstimate {
  /** Recommended CSS in seconds per 100m. Undefined if insufficient data. */
  cssSecPer100m?: number;
  /** Number of swim activities we looked at (for user-facing confidence). */
  swimActivityCount: number;
  /** ISO timestamp of the best sustained swim that drove the estimate. */
  sourceActivityISO?: string;
  /** Distance of the best sustained swim in metres. */
  sourceDistanceM?: number;
}

/**
 * Estimate CSS from a list of swim activities.
 *
 * Method: scan activities of at least 800m (threshold for "sustained" effort).
 * For each, compute avg pace in sec/100m. Take the BEST (fastest) sustained
 * pace observed as CSS_estimate, then add a conservative buffer of +5s/100m
 * so we don't overestimate from a one-off hot session.
 *
 * Science: CSS is formally the 30-min threshold pace (Dekerle 2002). A
 * 1500m+ sustained swim at steady effort approximates lactate threshold for
 * trained swimmers. We trade precision for robustness — the CSS test
 * (400m + 200m max) remains the gold standard and the user is prompted to
 * run it at any time from the Stats page.
 */
export function estimateCSSFromSwimActivities(
  activities: Array<Pick<GarminActual, 'activityType' | 'distanceKm' | 'durationSec' | 'startTime'>>
): CssEstimate {
  const swims = activities.filter((a) => classifyActivity(a.activityType) === 'swim');
  if (swims.length === 0) return { swimActivityCount: 0 };

  // Filter to sustained swims (≥ 800m is our threshold for reliable pace data).
  const sustained = swims.filter((a) => (a.distanceKm ?? 0) * 1000 >= 800 && (a.durationSec ?? 0) > 60);
  if (sustained.length === 0) return { swimActivityCount: swims.length };

  // Per-100m pace for each — LOWER is faster.
  const withPace = sustained
    .map((a) => {
      const metres = (a.distanceKm ?? 0) * 1000;
      const pace = (a.durationSec ?? 0) / (metres / 100);
      return { pace, metres, iso: a.startTime ?? undefined };
    })
    .filter((x) => x.pace > 40 && x.pace < 360);  // sanity: between 40s/100m (elite sprint) and 6:00/100m (slow)

  if (withPace.length === 0) return { swimActivityCount: swims.length };

  // Best sustained pace (fastest) is our CSS anchor. Conservative buffer.
  const best = withPace.reduce((acc, x) => (x.pace < acc.pace ? x : acc));
  const cssEstimate = Math.round(best.pace + 5);

  return {
    cssSecPer100m: cssEstimate,
    swimActivityCount: swims.length,
    sourceActivityISO: best.iso,
    sourceDistanceM: Math.round(best.metres),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// FTP (bike) from power curve — SCAFFOLDED, returns undefined without power
// ───────────────────────────────────────────────────────────────────────────

export interface FtpEstimate {
  ftpWatts?: number;
  bikeActivityCount: number;
  /** True when FTP was derived from a best-20-min average power. */
  derivedFromPower: boolean;
}

/** Optional fields the activity MAY carry once the edge function is extended. */
export interface PoweredActivity {
  activityType: string | null | undefined;
  durationSec: number;
  averageWatts?: number | null;
  maxWatts?: number | null;
  normalizedPowerW?: number | null;
}

/**
 * Estimate FTP from bike activities carrying power data.
 * Best 20-min average × 0.95 is the classical 20-min test approximation
 * (Allen & Coggan 2010).
 *
 * Returns `ftpWatts: undefined` and `derivedFromPower: false` when no
 * activities carry power data — the current state of the schema. Once
 * `average_watts` lands on `garmin_activities`, this function lights up.
 */
export function estimateFTPFromBikeActivities(activities: PoweredActivity[]): FtpEstimate {
  const rides = activities.filter((a) => classifyActivity(a.activityType) === 'bike');
  if (rides.length === 0) return { bikeActivityCount: 0, derivedFromPower: false };

  // Only rides with a full 20-min duration + power data count.
  const eligible = rides.filter((r) =>
    r.durationSec >= 20 * 60 &&
    (r.normalizedPowerW != null && r.normalizedPowerW > 80) ||
    (r.averageWatts != null && r.averageWatts > 80)
  );
  if (eligible.length === 0) return { bikeActivityCount: rides.length, derivedFromPower: false };

  // Take highest NP (or avg_watts fallback) across eligible rides. Coggan 20-min × 0.95.
  const bestPower = Math.max(...eligible.map((r) => r.normalizedPowerW ?? r.averageWatts ?? 0));
  const ftp = Math.round(bestPower * 0.95);

  return {
    ftpWatts: ftp,
    bikeActivityCount: rides.length,
    derivedFromPower: true,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-discipline CTL from activity TSS history
// ───────────────────────────────────────────────────────────────────────────

export interface PerDisciplineCtlEstimate {
  swim: PerDisciplineFitness;
  bike: PerDisciplineFitness;
  run: PerDisciplineFitness;
  combinedCtl: number;
  /** Total activities contributing. */
  activityCount: number;
}

/**
 * Seed per-discipline CTL / ATL / TSB from activity history.
 *
 * Uses raw physiological TSS (Signal B) per activity, weighted by the
 * transfer matrix into swim / bike / run tracks. Combined CTL is the raw
 * sum of TSS contributions (matching the model introduced in §8 feedback).
 *
 * For activities with no iTrimp, estimates TSS as duration × 60 (so a
 * 60-min ride ≈ 60 TSS at moderate effort). Conservative and good enough
 * for seeding — real CTL converges quickly once new activities sync in.
 */
export function estimatePerDisciplineCTLFromActivities(
  activities: Array<Pick<GarminActual, 'activityType' | 'durationSec' | 'startTime' | 'iTrimp'>>,
  referenceDateISO: string = new Date().toISOString()
): PerDisciplineCtlEstimate {
  const refTs = Date.parse(referenceDateISO);
  if (!Number.isFinite(refTs)) {
    return zeroEstimate(activities.length);
  }

  type Contribution = { day: number; sport: 'swim' | 'bike' | 'run' | 'other'; tss: number };
  const contribs: Contribution[] = [];

  for (const a of activities) {
    const sport = classifyActivity(a.activityType);
    const iso = a.startTime;
    if (!iso) continue;
    const aTs = Date.parse(iso);
    if (!Number.isFinite(aTs)) continue;
    const day = Math.floor((refTs - aTs) / 86400000);
    if (day < 0 || day > 120) continue;

    const tss = estimateTss(a, sport);
    if (tss <= 0) continue;
    contribs.push({ day, sport, tss });
  }

  if (contribs.length === 0) return zeroEstimate(activities.length);

  // Apply transfer matrix: own-sport at 1.0, others at reduced weights.
  const matrix: Record<'swim' | 'bike' | 'run' | 'other', { swim: number; bike: number; run: number }> = {
    swim:  { swim: 1.00, bike: 0.20, run: 0.30 },
    bike:  { swim: 0.20, bike: 1.00, run: 0.75 },
    run:   { swim: 0.25, bike: 0.70, run: 1.00 },
    other: { swim: 0.00, bike: 0.15, run: 0.25 },  // conservative for unknown activities
  };

  const acc = {
    swim: { ctlSum: 0, atlSum: 0 },
    bike: { ctlSum: 0, atlSum: 0 },
    run:  { ctlSum: 0, atlSum: 0 },
  };
  let combinedSum = 0;

  for (const c of contribs) {
    const ctlDecay = Math.exp(-c.day / CTL_TAU_DAYS);
    const atlDecay = Math.exp(-c.day / ATL_TAU_DAYS);
    const weights = matrix[c.sport];
    for (const d of ['swim', 'bike', 'run'] as const) {
      const w = weights[d];
      if (w <= 0) continue;
      const contribution = c.tss * w;
      acc[d].ctlSum += contribution * ctlDecay;
      acc[d].atlSum += contribution * atlDecay;
    }
    combinedSum += c.tss * ctlDecay;
  }

  const normalise = (sum: number, tau: number) => (sum / tau) * 7;

  const finalise = (sums: { ctlSum: number; atlSum: number }): PerDisciplineFitness => {
    const ctl = Math.round(normalise(sums.ctlSum, CTL_TAU_DAYS) * 10) / 10;
    const atl = Math.round(normalise(sums.atlSum, ATL_TAU_DAYS) * 10) / 10;
    return { ctl, atl, tsb: Math.round((ctl - atl) * 10) / 10 };
  };

  return {
    swim: finalise(acc.swim),
    bike: finalise(acc.bike),
    run:  finalise(acc.run),
    combinedCtl: Math.round(normalise(combinedSum, CTL_TAU_DAYS) * 10) / 10,
    activityCount: contribs.length,
  };
}

function estimateTss(
  a: Pick<GarminActual, 'durationSec' | 'iTrimp'>,
  sport: 'swim' | 'bike' | 'run' | 'other'
): number {
  // Prefer stored iTrimp (Signal B raw) if present.
  if (a.iTrimp != null && a.iTrimp > 0) return a.iTrimp;
  // Fallback: coarse estimate per minute, tuned per sport.
  const minutes = (a.durationSec ?? 0) / 60;
  if (minutes <= 0) return 0;
  const perMinute: Record<typeof sport, number> = {
    swim: 0.9,
    bike: 1.0,
    run: 1.1,
    other: 0.6,
  };
  return Math.round(minutes * perMinute[sport]);
}

function zeroEstimate(count: number): PerDisciplineCtlEstimate {
  return {
    swim: { ctl: 0, atl: 0, tsb: 0 },
    bike: { ctl: 0, atl: 0, tsb: 0 },
    run:  { ctl: 0, atl: 0, tsb: 0 },
    combinedCtl: 0,
    activityCount: count,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level helper for call sites
// ───────────────────────────────────────────────────────────────────────────

export interface TriBenchmarks {
  css: CssEstimate;
  ftp: FtpEstimate;
  fitness: PerDisciplineCtlEstimate;
}

/**
 * One-shot derivation used by initialisation. Accepts the activity log
 * (typically flattened from `state.wks[*].garminActuals`) and returns
 * every benchmark the prediction engine cares about.
 */
export function deriveTriBenchmarksFromHistory(
  activities: GarminActual[],
  referenceDateISO: string = new Date().toISOString()
): TriBenchmarks {
  return {
    css: estimateCSSFromSwimActivities(activities),
    ftp: estimateFTPFromBikeActivities(activities as unknown as PoweredActivity[]),
    fitness: estimatePerDisciplineCTLFromActivities(activities, referenceDateISO),
  };
}
