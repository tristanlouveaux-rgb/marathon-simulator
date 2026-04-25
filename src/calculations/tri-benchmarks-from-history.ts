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
 * **What works when the user rides with a power meter**:
 *   - FTP estimate from best normalised power (NP) across all eligible
 *     rides, via Allen & Coggan's 0.95 × 20-min NP rule. The edge
 *     function persists `average_watts`, `normalized_power`, `max_watts`
 *     and the `device_watts` flag onto each Strava ride as of the
 *     2026-04-24 schema migration.
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
// CSS from paired test (Smith-Norris formula)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Compute CSS from a paired 400m + 200m test (Smith & Norris 2019).
 *
 * Formula:
 *   CSS_m_per_sec = (400 − 200) / (t400 − t200)
 *   CSS_sec_per_100m = 100 / CSS_m_per_sec
 *
 * This is the **gold-standard** swim threshold estimate. The user does
 * the test once (400m all-out, full rest, then 200m all-out) and the
 * formula gives the steady-state pace at which they'd hold lactate.
 *
 * Returns null if either input is missing or the math is degenerate
 * (negative pace, etc.).
 */
export function computeCSSFromPair(t400Sec: number | undefined | null, t200Sec: number | undefined | null): number | null {
  if (!t400Sec || t400Sec <= 0) return null;
  if (!t200Sec || t200Sec <= 0) return null;
  if (t400Sec <= t200Sec) return null;  // 400m must be slower than 200m
  const speedMps = (400 - 200) / (t400Sec - t200Sec);
  if (!isFinite(speedMps) || speedMps <= 0) return null;
  const cssSecPer100m = 100 / speedMps;
  // Sanity bounds: 50 s/100m (elite) to 240 s/100m (very slow). Outside →
  // user mis-entered. Return null and let the fallback path handle.
  if (cssSecPer100m < 50 || cssSecPer100m > 240) return null;
  return Math.round(cssSecPer100m);
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
  /** Strava's `device_watts` flag — true when power came from a real power
   * meter, false when Strava estimated it from speed + elevation. Estimated
   * power on Strava is unreliable (often off by 30–50%) and should never
   * anchor an FTP estimate when real-meter rides exist. */
  deviceWatts?: boolean | null;
}

/**
 * Estimate FTP from bike activities carrying power data.
 *
 * Strava's activity LIST endpoint returns `average_watts` (whole-activity
 * average) and `weighted_average_watts` (NP). NP is the gold standard
 * for FTP — best 1-hour NP × 0.95 ≈ FTP (Allen & Coggan 2010). When NP
 * isn't present we fall back to `average_watts` with a duration-aware
 * Intensity Factor (IF) inversion:
 *
 *   - Short rides (≤ 30 min): assume IF 0.95 (test/intervals)
 *   - Threshold/sweet-spot range (30–90 min): assume IF 0.85
 *   - Long endurance (> 90 min): assume IF 0.70
 *
 * Robustness improvements over the naïve max():
 *   - Take the **median of the top-3 candidates** rather than the single
 *     best ride. Protects against one-off power-meter spikes or
 *     particularly hot test efforts that aren't representative of the
 *     athlete's repeatable threshold.
 *   - Drop candidate values that are >2× the second-best (clear outliers).
 *   - Final cap at 500W as a sanity floor.
 */
export function estimateFTPFromBikeActivities(activities: PoweredActivity[]): FtpEstimate {
  const rides = activities.filter((a) => classifyActivity(a.activityType) === 'bike');
  if (rides.length === 0) return { bikeActivityCount: 0, derivedFromPower: false };

  // Eligible: ≥ 20 min long + power data present.
  const baseEligible = rides.filter((r) => {
    if (r.durationSec < 20 * 60) return false;
    const hasNp = r.normalizedPowerW != null && r.normalizedPowerW > 80;
    const hasAvg = r.averageWatts != null && r.averageWatts > 80;
    return hasNp || hasAvg;
  });
  if (baseEligible.length === 0) return { bikeActivityCount: rides.length, derivedFromPower: false };

  // **Prefer real power-meter rides over Strava-estimated ones.** Strava
  // estimates power from speed + elevation when no meter is present, and the
  // result is unreliable (often 30–50% off) — never let estimated rides
  // anchor an FTP. Only fall back to estimated when zero real-meter rides
  // exist.
  const realMeterRides = baseEligible.filter((r) => r.deviceWatts === true);
  const eligible = realMeterRides.length > 0 ? realMeterRides : baseEligible;

  // Compute candidate FTP per ride.
  const candidates: number[] = [];
  for (const r of eligible) {
    let candidate = 0;
    if (r.normalizedPowerW != null && r.normalizedPowerW > 80) {
      candidate = r.normalizedPowerW * 0.95;
    } else if (r.averageWatts != null && r.averageWatts > 80) {
      const dur = r.durationSec;
      let assumedIF: number;
      if (dur <= 30 * 60) assumedIF = 0.95;
      else if (dur <= 90 * 60) assumedIF = 0.85;
      else assumedIF = 0.70;
      candidate = r.averageWatts / assumedIF;
    }
    if (candidate > 80) candidates.push(candidate);
  }
  if (candidates.length === 0) return { bikeActivityCount: rides.length, derivedFromPower: false };

  candidates.sort((a, b) => b - a);  // descending

  // Outlier drop: a candidate >2× the second-best AND >120% of the body of
  // the data is a glitch. Skip when only 1 candidate (no comparison) or 2
  // candidates (would discard half the signal).
  if (candidates.length >= 3 && candidates[0] > candidates[1] * 2) {
    candidates.shift();
  }

  // Take median of top-3 (or top-N if fewer). Robust to single outliers.
  const top = candidates.slice(0, Math.min(3, candidates.length));
  const median = top.length === 1
    ? top[0]
    : top.length === 2
      ? (top[0] + top[1]) / 2
      : top[1];  // sorted desc, idx 1 is the middle

  const ftp = Math.min(500, Math.round(median));

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

/**
 * Convert an activity to its Signal-B TSS-equivalent.
 *
 * iTRIMP (Banister 1991) is the canonical raw physiological load metric
 * stored on garmin_activities. To compare it against TSS-space (where
 * 100 = 1h at threshold), divide by 150 — the same conversion the
 * running-side activity-matcher uses (`rawITrimp * 100 / 15000`).
 *
 * Without this conversion, CTL estimates run ~150× too high (e.g. 2296
 * instead of ~15 for a base of one 60-min Z2 run per day).
 */
function estimateTss(
  a: Pick<GarminActual, 'durationSec' | 'iTrimp'>,
  sport: 'swim' | 'bike' | 'run' | 'other'
): number {
  if (a.iTrimp != null && a.iTrimp > 0) {
    return a.iTrimp / 150;
  }
  // Fallback when iTRIMP is missing: coarse TSS estimate per minute.
  // Values tuned so a 60-min Z2 ride ≈ 60 TSS, 60-min easy run ≈ 65 TSS.
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
 * Optional benchmark inputs the user can provide directly. When present,
 * these take priority over the activity-history fallbacks. Mirrors the
 * "test workout" results the user enters via the Refine-your-benchmarks
 * card.
 */
export interface DirectBenchmarkInputs {
  /** 400m time-trial result (seconds). Pairs with t200Sec via Smith-Norris. */
  swim400Sec?: number;
  /** 200m time-trial result (seconds). Pairs with t400Sec. */
  swim200Sec?: number;
}

/**
 * One-shot derivation used by initialisation. Accepts the activity log
 * (typically flattened from `state.wks[*].garminActuals`) plus any
 * direct benchmark inputs, and returns every benchmark the prediction
 * engine cares about.
 */
export function deriveTriBenchmarksFromHistory(
  activities: GarminActual[],
  referenceDateISO: string = new Date().toISOString(),
  direct: DirectBenchmarkInputs = {}
): TriBenchmarks {
  // Prefer paired-TT CSS when both 400m and 200m are provided. Otherwise
  // fall back to the best-sustained-pace estimate from swim activities.
  const cssFromPair = computeCSSFromPair(direct.swim400Sec, direct.swim200Sec);
  const swimEst = estimateCSSFromSwimActivities(activities);
  const css: CssEstimate = cssFromPair != null
    ? {
        cssSecPer100m: cssFromPair,
        swimActivityCount: swimEst.swimActivityCount,
        sourceActivityISO: undefined,
        sourceDistanceM: undefined,
      }
    : swimEst;

  return {
    css,
    ftp: estimateFTPFromBikeActivities(activities as unknown as PoweredActivity[]),
    fitness: estimatePerDisciplineCTLFromActivities(activities, referenceDateISO),
  };
}
