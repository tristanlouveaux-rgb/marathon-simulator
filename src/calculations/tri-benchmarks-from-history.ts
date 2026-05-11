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
import { SWIM_TYPE_MULTIPLIER } from '@/constants/triathlon-course-factors';

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

/** True for OPEN_WATER_SWIMMING (and any activity-type string that contains
 *  "open"). Pool swims (SWIMMING / LAP_SWIMMING) are NOT open-water. */
export function isOpenWaterSwim(activityType: string | null | undefined): boolean {
  if (!activityType) return false;
  const s = activityType.toLowerCase();
  return s.includes('open') && s.includes('water');
}

/**
 * Resolve a swim activity's environment tag. Order:
 *   1. Explicit per-activity tag wins (user set it in the activity card).
 *   2. Pool swims auto-tag as `pool` from activityType.
 *   3. Open-water swims fall back to the user's profile default
 *      (`triConfig.swim.defaultOwSwimEnvironment`).
 *   4. If no default, returns undefined — caller treats as wetsuit-lake (1.0)
 *      so we don't fabricate a number.
 */
export function resolveSwimEnvironment(
  activity: { activityType?: string | null; swimEnvironment?: import('../constants/triathlon-course-factors').AthleteSwimEnvironment },
  defaultOw?: 'wetsuit-lake' | 'non-wetsuit-lake' | 'ocean' | 'river',
): import('../constants/triathlon-course-factors').AthleteSwimEnvironment | undefined {
  if (activity.swimEnvironment) return activity.swimEnvironment;
  if (isOpenWaterSwim(activity.activityType)) return defaultOw;
  return 'pool';
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
  /**
   * Confidence tier for this estimate. Mirrors `FtpEstimate.confidence`.
   *   high   — recent (≤4w) test-grade swim (≥1500m AND faster than the user's
   *            recent median by ≥3 s/100m, indicating a genuine hard effort).
   *   medium — best sustained swim is recent (≤4w) OR test-grade within 8w.
   *   low    — only short / non-recent / consistent-easy-pace swims available.
   *   none   — no sustained swim within 12w, or no swim activities at all.
   * The estimator still returns a `cssSecPer100m` at low confidence — race-time
   * prediction can't gate on confidence. Confidence drives the UI caption and
   * the test-card prompt (run a CSS test to upgrade to a gold-standard value).
   */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Age of the best swim in weeks (rounded to 0.1). Surfaced in captions. */
  sourceWeeksOld?: number;
}

// CSS estimator tunables — same recency tiers as FTP for consistency.
const CSS_HARD_CUTOFF_WEEKS = 12;     // > 12w → confidence='none'
const CSS_HIGH_TIER_WEEKS = 4;        // ≤ 4w + test-grade → 'high'
const CSS_MED_TIER_WEEKS = 8;         // ≤ 8w + test-grade → 'medium'
const CSS_TEST_GRADE_METRES = 1500;   // ≥ 1500m sustained ≈ Dekerle 2002 30-min threshold proxy
const CSS_HARD_EFFORT_DELTA = 3;      // Best swim ≥3 s/100m faster than median ⇒ genuine hard effort
const CSS_BUFFER_SEC_PER_100M = 5;    // Conservative buffer applied to fastest sustained pace

/**
 * Estimate CSS from a list of swim activities.
 *
 * Method: scan activities of at least 800m (threshold for "sustained" effort).
 * For each, compute avg pace in sec/100m, then NORMALISE to a wetsuit-lake
 * baseline by dividing by `SWIM_TYPE_MULTIPLIER[env]`. Take the BEST (fastest)
 * normalised sustained pace as CSS_estimate, then add a conservative buffer
 * of +5s/100m so we don't overestimate from a one-off hot session.
 *
 * Why normalise: a non-wetsuit lake swim is ~4% slower than the equivalent
 * effort would have been with a wetsuit, an ocean swim ~5%, etc. Pooling
 * raw paces from mixed environments biases CSS towards whichever environment
 * dominates the recent training data. Race-side then re-applies the course
 * factor for the actual race environment cleanly.
 *
 * Science: CSS is formally the 30-min threshold pace (Dekerle 2002). A
 * 1500m+ sustained swim at steady effort approximates lactate threshold for
 * trained swimmers. The wetsuit-lake reference is anchored on Toussaint 1989
 * + Cordain 1991 + de la Fuente Pacheco 2020 (~14% drag, ~5–6% time benefit).
 * Pool ≡ wetsuit-lake (pool→OW penalty cancels wetsuit benefit; see
 * `triathlon-course-factors.ts`). The CSS test (400m + 200m max) remains the
 * gold standard and the user is prompted to run it at any time.
 *
 * Confidence: see `CssEstimate.confidence`. Recency, sustained distance, and
 * pace-deviation from the user's own median together drive the tier. A pool
 * full of easy-pace 1km swims at 130 s/100m gives a *low*-confidence CSS of
 * ~135 s/100m — likely too slow because no real hard effort exists in the
 * data — and the UI prompts the user to run a paired-TT test.
 */
export function estimateCSSFromSwimActivities(
  activities: Array<Pick<GarminActual, 'activityType' | 'distanceKm' | 'durationSec' | 'startTime' | 'swimEnvironment'>>,
  referenceDateISO: string = new Date().toISOString(),
  defaultOwEnvironment?: 'wetsuit-lake' | 'non-wetsuit-lake' | 'ocean' | 'river',
): CssEstimate {
  const swims = activities.filter((a) => classifyActivity(a.activityType) === 'swim');
  if (swims.length === 0) return { swimActivityCount: 0, confidence: 'none' };

  // Filter to sustained swims (≥ 800m is our threshold for reliable pace data).
  const sustained = swims.filter((a) => (a.distanceKm ?? 0) * 1000 >= 800 && (a.durationSec ?? 0) > 60);
  if (sustained.length === 0) return { swimActivityCount: swims.length, confidence: 'none' };

  const refTs = Date.parse(referenceDateISO);
  const refValid = Number.isFinite(refTs);

  // Per-100m pace for each — LOWER is faster. Tag with weeks-old for recency.
  // Pace is normalised to a wetsuit-lake equivalent by dividing by the env
  // multiplier (e.g. an ocean swim at 105 s/100m raw → 100 s/100m baseline,
  // because ocean is +5% slower than baseline; the same effort in a wetsuit
  // lake would have been ~5% faster).
  const withPace = sustained
    .map((a) => {
      const metres = (a.distanceKm ?? 0) * 1000;
      const rawPace = (a.durationSec ?? 0) / (metres / 100);
      const env = resolveSwimEnvironment(a, defaultOwEnvironment);
      const factor = env ? SWIM_TYPE_MULTIPLIER[env] : 1.0;
      const pace = rawPace / factor;
      let weeksOld = 0;
      if (a.startTime && refValid) {
        const aTs = Date.parse(a.startTime);
        if (Number.isFinite(aTs)) weeksOld = Math.max(0, (refTs - aTs) / (7 * 86400 * 1000));
      }
      return { pace, metres, iso: a.startTime ?? undefined, weeksOld };
    })
    .filter((x) => x.pace > 40 && x.pace < 360);  // sanity: between 40s/100m (elite sprint) and 6:00/100m (slow)

  if (withPace.length === 0) return { swimActivityCount: swims.length, confidence: 'none' };

  // Recency window — only swims within the hard cutoff drive the confidence tier.
  const recent = withPace.filter((x) => x.weeksOld <= CSS_HARD_CUTOFF_WEEKS);
  if (recent.length === 0) {
    // We have sustained swims but they're all stale. Still return a number
    // (some signal beats none) but flag it 'none' so the UI prompts a test.
    const best = withPace.reduce((acc, x) => (x.pace < acc.pace ? x : acc));
    return {
      cssSecPer100m: Math.round(best.pace + CSS_BUFFER_SEC_PER_100M),
      swimActivityCount: swims.length,
      sourceActivityISO: best.iso,
      sourceDistanceM: Math.round(best.metres),
      sourceWeeksOld: Math.round(best.weeksOld * 10) / 10,
      confidence: 'none',
    };
  }

  // Best sustained pace (fastest) within the recency window is our CSS anchor.
  const best = recent.reduce((acc, x) => (x.pace < acc.pace ? x : acc));
  const cssEstimate = Math.round(best.pace + CSS_BUFFER_SEC_PER_100M);

  // Hard-effort signal: how much faster is the best swim than the median?
  // If they're close, the user probably hasn't done a hard swim, so the +5s
  // buffer is too small (real CSS is faster than easy-aerobic + 5).
  const sortedPaces = [...recent.map((x) => x.pace)].sort((a, b) => a - b);
  const median = sortedPaces[Math.floor(sortedPaces.length / 2)];
  const isHardEffort = median - best.pace >= CSS_HARD_EFFORT_DELTA;
  const isTestGradeDistance = best.metres >= CSS_TEST_GRADE_METRES;

  let confidence: CssEstimate['confidence'];
  if (best.weeksOld <= CSS_HIGH_TIER_WEEKS && isTestGradeDistance && isHardEffort) {
    confidence = 'high';
  } else if (best.weeksOld <= CSS_HIGH_TIER_WEEKS) {
    // Recent but either short OR no clear hard-effort signal.
    confidence = 'medium';
  } else if (best.weeksOld <= CSS_MED_TIER_WEEKS && isTestGradeDistance) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    cssSecPer100m: cssEstimate,
    swimActivityCount: swims.length,
    sourceActivityISO: best.iso,
    sourceDistanceM: Math.round(best.metres),
    sourceWeeksOld: Math.round(best.weeksOld * 10) / 10,
    confidence,
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
  /** True when FTP was derived from real power data (curve or whole-ride NP). */
  derivedFromPower: boolean;
  /**
   * Confidence in the estimate. With the power-curve top-1 estimator the
   * tiers are purely a function of the source ride's age:
   *   high   — top-1 candidate within 4 weeks
   *   medium — top-1 candidate within 4–8 weeks
   *   low    — top-1 candidate within 8–12 weeks, OR fallback whole-ride logic
   *   none   — no candidate within 12 weeks
   */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Number of rides that contributed (passed quality + recency filters). */
  contributingRideCount?: number;
  /** Age of the most recent ride that contributed (weeks). */
  newestContributingRideWeeksOld?: number;
  /** ISO date of the source ride (top-1 in the new estimator). Optional —
   * the caption uses this to surface "{date}" without re-deriving. */
  sourceRideISO?: string;
  /** Which window in the power curve drove the estimate, or 'whole-ride' for
   * the legacy fallback. Optional — the caption surfaces this as
   * "20-min interval" / "60-min effort" / "long ride". */
  sourceWindow?: '10-min' | '20-min' | '30-min' | '60-min' | 'whole-ride';
  /** The watts at the source window (e.g. p1200 = 310). For UI captions. */
  sourceWatts?: number;
  /** Funnel breakdown of why rides were rejected. Populated whenever the
   * fallback path runs (with or without success), so the UI can render a
   * "why don't we have an FTP?" drill-down without re-running the estimator. */
  diagnostics?: {
    totalRides: number;
    withCurve: number;
    withDeviceWattsTrue: number;
    withDeviceWattsFalse: number;
    withNP: number;
    withAvgWatts: number;
    /** Fallback-path funnel — counts at each rejection stage. */
    funnel: {
      noUsablePower: number;     // NP and avg both ≤ FALLBACK_MIN_W (or both null)
      tooShort: number;          // duration < 20 min
      tooOld: number;            // > HARD_CUTOFF_WEEKS old
    };
    /** Top 5 candidates after all filters, for the debug overlay. Empty when
     * the funnel rejected everything — in that case the rejection reason
     * counts above tell you why. */
    topCandidates: Array<{
      startISO?: string;
      durationMin: number;
      np: number | null;
      avgWatts: number | null;
      deviceWatts: boolean | null;
      weeksOld: number;
      power: number;
    }>;
  };
}

/** Optional fields the activity MAY carry once the edge function is extended. */
export interface PoweredActivity {
  activityType: string | null | undefined;
  durationSec: number;
  /** ISO timestamp — required for recency weighting. Rides without it skip the
   * decay (treated as current) but lose the staleness signal. */
  startTime?: string | null;
  averageWatts?: number | null;
  maxWatts?: number | null;
  normalizedPowerW?: number | null;
  /** Strava's `device_watts` flag — true when power came from a real power
   * meter, false when Strava estimated it from speed + elevation. Estimated
   * power on Strava is unreliable (often off by 30–50%) and should never
   * anchor an FTP estimate when real-meter rides exist. */
  deviceWatts?: boolean | null;
  /** Mean-max power curve (best sustained watts over fixed windows) computed
   * by the edge function from the watts stream. When present, the FTP
   * estimator reads this directly and ignores whole-ride NP — a 110-min ride
   * with two 20-min all-out efforts at 310 W gets FTP ≈ 295 W (310 × 0.95)
   * regardless of how soft the rest of the ride was. */
  powerCurve?: { p600: number | null; p1200: number | null; p1800: number | null; p3600: number | null } | null;
}

// ── Tunables (documented in docs/SCIENCE_LOG.md → FTP from Ride History) ─
const HARD_CUTOFF_WEEKS = 12;          // > 12w old → no current estimate
const HIGH_TIER_WEEKS   = 4;           // ≤ 4w → confidence='high'
const MED_TIER_WEEKS    = 8;           // ≤ 8w → confidence='medium'

// Mean-max → FTP multipliers. Read off the Coggan / Monod-style power-duration
// curve assuming the rider went near-max for the window:
//   p600  (10 min) × 0.92
//   p1200 (20 min) × 0.95   ← classic Coggan 20-min FTP test
//   p1800 (30 min) × 0.97
//   p3600 (60 min) × 1.00   ← FTP by definition
const PC_MULTIPLIERS = {
  p600:  0.92,
  p1200: 0.95,
  p1800: 0.97,
  p3600: 1.00,
} as const;

/**
 * Estimate FTP from bike activities.
 *
 * **Primary path — power curve top-1 within 12 weeks**:
 *   For every cycling ride that has a `powerCurve` (mean-max watts for
 *   [600, 1200, 1800, 3600] s, computed from the watts stream by the edge
 *   function), compute a per-ride FTP candidate as
 *     candidate = max(p600 × 0.92, p1200 × 0.95, p1800 × 0.97, p3600 × 1.00)
 *   The best candidate within the last 12 weeks is the FTP.
 *
 *   Why max-of-windows: a ride with a 20-min all-out interval will show p1200
 *   at near-FTP power, while p3600 is dragged down by the recovery between
 *   intervals. We want whichever window produced the strongest signal.
 *
 *   Why top-1 (not weighted mean): with the curve we read intensity directly,
 *   so the strongest single ride is the most informative single data point.
 *   Averaging dilutes a fresh test with stale ones.
 *
 *   Outlier guard: if the top candidate's `p1200 > 1.4 × p3600`, the curve
 *   is suspicious (the meter likely spiked or the watts stream had a bad
 *   segment). Use the second-best candidate.
 *
 * **Fallback — whole-ride NP for older or curve-less rides**:
 *   When no candidate has a `powerCurve` (e.g. mid-backfill state, rides
 *   older than the stream-fetch budget window, or rides without a real
 *   meter), degrade gracefully to a conservative whole-ride NP estimate.
 *   This is a *floor* (NP × 1.00 for any duration), explicitly tagged
 *   `confidence: 'low'` so the UI prompts for a fresh test. Better than
 *   showing "--" for every triathlete who hasn't synced a curve yet.
 *
 * Confidence is primarily a function of the source ride's age:
 *   ≤ 4 weeks  → high
 *   ≤ 8 weeks  → medium
 *   ≤ 12 weeks → low
 *   > 12 weeks → none (return undefined ftpWatts)
 *
 * **device_watts handling**: Strava's `device_watts` flag is unreliable on
 * Garmin → Strava transfers — it routinely arrives `null` (or even `false`)
 * on real power-meter rides. So:
 *   - `deviceWatts === false` → reject (Strava explicitly says estimated).
 *   - `deviceWatts === true`  → accept at the age-based confidence.
 *   - `deviceWatts == null`   → accept but downgrade one tier (high→medium,
 *                               medium→low, low stays low). The 'low' tag
 *                               surfaces the existing UI prompt for a fresh
 *                               test, which is the right safety net.
 *
 * The alternative — refuse to estimate FTP for any ride with an unknown flag
 * — leaves new triathletes staring at "--" forever even when their rides
 * carry valid power data. That outcome is worse than a one-tier downgrade.
 */
export function estimateFTPFromBikeActivities(
  activities: PoweredActivity[],
  referenceDateISO: string = new Date().toISOString(),
): FtpEstimate {
  const rides = activities.filter((a) => classifyActivity(a.activityType) === 'bike');
  if (rides.length === 0) {
    return {
      bikeActivityCount: 0,
      derivedFromPower: false,
      confidence: 'none',
      diagnostics: {
        totalRides: 0,
        withCurve: 0,
        withDeviceWattsTrue: 0,
        withDeviceWattsFalse: 0,
        withNP: 0,
        withAvgWatts: 0,
        funnel: { noUsablePower: 0, tooShort: 0, tooOld: 0 },
        topCandidates: [],
      },
    };
  }

  const refTs = Date.parse(referenceDateISO);
  const refValid = Number.isFinite(refTs);

  // Inventory counts — surface in `diagnostics` on every return so the UI
  // overlay can render the breakdown without re-running the estimator.
  const inventory = {
    totalRides: rides.length,
    withCurve: rides.filter((r) => r.powerCurve != null && Object.keys(r.powerCurve as object).length > 0).length,
    withDeviceWattsTrue: rides.filter((r) => r.deviceWatts === true).length,
    withDeviceWattsFalse: rides.filter((r) => r.deviceWatts === false).length,
    withNP: rides.filter((r) => r.normalizedPowerW != null && r.normalizedPowerW > 0).length,
    withAvgWatts: rides.filter((r) => r.averageWatts != null && r.averageWatts > 0).length,
  };

  // Walk every ride. If it has a power curve, build a curve-based candidate.
  // Real power-meter rides only — Strava-estimated power is unreliable for
  // FTP-grade signal extraction.
  type CurveCandidate = {
    watts: number;
    window: '10-min' | '20-min' | '30-min' | '60-min';
    weeksOld: number;
    startISO?: string;
    p1200: number | null;
    p3600: number | null;
    flagKnown: boolean;
  };
  const curveCandidates: CurveCandidate[] = [];

  for (const r of rides) {
    const pc = r.powerCurve;
    if (!pc) continue;
    // No `device_watts` gate. The flag is structurally unreliable on
    // Garmin → Strava transfers (it routinely arrives `false` even on real
    // power-meter rides — see activity-detail.ts:142, bike-setup-view.ts:294).
    // The existence of a `power_curve` itself is a stronger signal: it's only
    // computed by the edge function from a non-empty watts stream. We
    // downgrade confidence by one tier when the flag isn't explicitly true.

    let weeksOld = 0;
    if (r.startTime && refValid) {
      const aTs = Date.parse(r.startTime);
      if (Number.isFinite(aTs)) {
        weeksOld = Math.max(0, (refTs - aTs) / (7 * 86400 * 1000));
      }
    }
    if (weeksOld > HARD_CUTOFF_WEEKS) continue;

    // Per-window candidate values. Take the max — whichever window gave the
    // strongest signal wins for this ride.
    type WK = '10-min' | '20-min' | '30-min' | '60-min';
    const perWindow: Array<{ watts: number; window: WK }> = [];
    if (pc.p600  != null && pc.p600  > 80) perWindow.push({ watts: pc.p600  * PC_MULTIPLIERS.p600,  window: '10-min' });
    if (pc.p1200 != null && pc.p1200 > 80) perWindow.push({ watts: pc.p1200 * PC_MULTIPLIERS.p1200, window: '20-min' });
    if (pc.p1800 != null && pc.p1800 > 80) perWindow.push({ watts: pc.p1800 * PC_MULTIPLIERS.p1800, window: '30-min' });
    if (pc.p3600 != null && pc.p3600 > 80) perWindow.push({ watts: pc.p3600 * PC_MULTIPLIERS.p3600, window: '60-min' });
    if (perWindow.length === 0) continue;

    const best = perWindow.reduce((acc, x) => (x.watts > acc.watts ? x : acc));
    curveCandidates.push({
      watts: best.watts,
      window: best.window,
      weeksOld,
      startISO: r.startTime ?? undefined,
      p1200: pc.p1200,
      p3600: pc.p3600,
      flagKnown: r.deviceWatts === true,
    });
  }

  // Top-1 selection with outlier guard on the suspect curve shape
  // (p1200 ≫ p3600 means the meter spiked during a 20-min window or the
  // stream had garbage — second-best is safer).
  if (curveCandidates.length > 0) {
    const sorted = [...curveCandidates].sort((a, b) => b.watts - a.watts);
    let pick = sorted[0];
    if (
      sorted.length >= 2 &&
      pick.p1200 != null &&
      pick.p3600 != null &&
      pick.p3600 > 0 &&
      pick.p1200 / pick.p3600 > 1.4
    ) {
      pick = sorted[1];
    }

    const ftp = Math.min(500, Math.round(pick.watts));
    const baseConf: 'high' | 'medium' | 'low' =
      pick.weeksOld <= HIGH_TIER_WEEKS ? 'high'
      : pick.weeksOld <= MED_TIER_WEEKS ? 'medium'
      : 'low';
    // Downgrade one tier when the device_watts flag isn't explicitly true —
    // the underlying signal might be Strava-estimated rather than a real
    // meter. high → medium → low. (low stays low; can't go below.)
    const confidence: 'high' | 'medium' | 'low' = pick.flagKnown
      ? baseConf
      : baseConf === 'high' ? 'medium' : 'low';

    return {
      ftpWatts: ftp,
      bikeActivityCount: rides.length,
      derivedFromPower: true,
      confidence,
      contributingRideCount: 1,
      newestContributingRideWeeksOld: Math.round(pick.weeksOld * 10) / 10,
      sourceRideISO: pick.startISO,
      sourceWindow: pick.window,
      diagnostics: {
        ...inventory,
        funnel: { noUsablePower: 0, tooShort: 0, tooOld: 0 },
        topCandidates: [],
      },
      sourceWatts: Math.round(
        pick.window === '10-min' ? pick.watts / PC_MULTIPLIERS.p600
        : pick.window === '20-min' ? pick.watts / PC_MULTIPLIERS.p1200
        : pick.window === '30-min' ? pick.watts / PC_MULTIPLIERS.p1800
        : pick.watts / PC_MULTIPLIERS.p3600
      ),
    };
  }

  // Fallback: no power curves available. Use the strongest qualifying ride's
  // whole-ride NP as a conservative floor. Better than '--' while the
  // backfill catches up. Tagged 'low' confidence so the UI nudges a test.
  //
  // Selection: highest NP (or averageWatts when NP missing) within 12 weeks.
  // We pick the *strongest* — not the *freshest* — because whole-ride NP × 1.0
  // is an underestimate by construction, and the freshest ride might be a Z2
  // endurance spin or recovery ride that pegs FTP unreasonably low. The
  // strongest recent ride is the best anchor we have without a power curve.
  //
  // No `device_watts` gate. Strava's flag is structurally unreliable on
  // Garmin → Strava transfers — the user's real-meter rides routinely arrive
  // tagged `device_watts: false`. Refusing those leaves real power-meter
  // owners with FTP=null forever. We rely instead on a hard NP/avg threshold
  // (>= 120 W) that's well above what Strava's speed-based estimation
  // produces on casual rides — that's the actual filter we want anyway.
  const FALLBACK_MIN_W = 120;
  const ridesAfterPower = rides.filter((r) => {
    const np = r.normalizedPowerW;
    const avg = r.averageWatts;
    return (np != null && np > FALLBACK_MIN_W) || (avg != null && avg > FALLBACK_MIN_W);
  });
  const ridesAfterDuration = ridesAfterPower.filter((r) => r.durationSec >= 20 * 60);
  const candidates = ridesAfterDuration
    .map((r) => {
      let weeksOld = Number.POSITIVE_INFINITY;
      if (r.startTime && refValid) {
        const aTs = Date.parse(r.startTime);
        if (Number.isFinite(aTs)) weeksOld = Math.max(0, (refTs - aTs) / (7 * 86400 * 1000));
      }
      const power = r.normalizedPowerW ?? r.averageWatts ?? 0;
      return { r, weeksOld, power };
    })
    .filter((x) => x.weeksOld <= HARD_CUTOFF_WEEKS)
    // Sort by power DESC. Tiebreak by recency (fresher first) so equal-NP
    // rides converge on the most recent.
    .sort((a, b) => b.power - a.power || a.weeksOld - b.weeksOld);
  const fallback = candidates[0];

  // Build the funnel diagnostics regardless of fallback success — the UI
  // overlay needs the breakdown for both the "no FTP" and the "low-confidence"
  // explanations. `inventory` was computed earlier (shared with curve path).
  const tooShort = ridesAfterPower.length - ridesAfterDuration.length;
  const tooOld = ridesAfterDuration.length - candidates.length;
  const buildDiagnostics = () => ({
    ...inventory,
    funnel: {
      noUsablePower: rides.length - ridesAfterPower.length,
      tooShort,
      tooOld,
    },
    topCandidates: candidates.slice(0, 5).map((c) => ({
      startISO: c.r.startTime ?? undefined,
      durationMin: Math.round(c.r.durationSec / 60),
      np: c.r.normalizedPowerW ?? null,
      avgWatts: c.r.averageWatts ?? null,
      deviceWatts: c.r.deviceWatts ?? null,
      weeksOld: Math.round(c.weeksOld * 10) / 10,
      power: Math.round(c.power),
    })),
  });

  if (!fallback) {
    // Diagnostic: surface where the funnel collapsed so the next "why is
    // FTP still --?" is one log line away.
    console.log(
      `[ftp-estimator] fallback rejected all rides — total:${rides.length} ` +
      `noUsablePower(NP&avg≤${FALLBACK_MIN_W}):${rides.length - ridesAfterPower.length} ` +
      `tooShort(<20min):${tooShort} tooOld(>${HARD_CUTOFF_WEEKS}w):${tooOld}`
    );
    return {
      bikeActivityCount: rides.length,
      derivedFromPower: false,
      confidence: 'none',
      diagnostics: buildDiagnostics(),
    };
  }

  // Diagnostic: top 5 candidates so we can verify the picked ride is the
  // strongest the user actually did. If a known hard interval session is
  // ranked below an unexpected ride, the dedup or the watts stream is the
  // suspect — not the estimator.
  const top = candidates.slice(0, 5).map((c) => {
    const dateStr = c.r.startTime ? c.r.startTime.slice(0, 10) : '?';
    const dur = Math.round(c.r.durationSec / 60);
    const np = c.r.normalizedPowerW;
    const avg = c.r.averageWatts;
    const flag = c.r.deviceWatts === true ? 'true' : c.r.deviceWatts === false ? 'false' : 'null';
    return `${dateStr}(${dur}m,NP=${np ?? '-'}/avg=${avg ?? '-'},dw=${flag},${c.weeksOld.toFixed(1)}w)`;
  }).join(' | ');
  console.log(`[ftp-estimator] fallback top candidates: ${top}`);
  console.log(`[ftp-estimator] picked → ${candidates[0].r.startTime?.slice(0, 10)} ${candidates[0].power}W (NP=${candidates[0].r.normalizedPowerW ?? 'null'} avg=${candidates[0].r.averageWatts ?? 'null'})`);

  const np = fallback.power;
  // Confidence stays 'low' (whole-ride NP × 1.0 is conservative anyway). If
  // the source ride's flag isn't explicitly true we already can't go lower.
  return {
    ftpWatts: Math.min(500, Math.round(np)),
    bikeActivityCount: rides.length,
    derivedFromPower: true,
    confidence: 'low',
    contributingRideCount: 1,
    newestContributingRideWeeksOld: Math.round(fallback.weeksOld * 10) / 10,
    sourceRideISO: fallback.r.startTime ?? undefined,
    sourceWindow: 'whole-ride',
    sourceWatts: Math.round(np),
    diagnostics: buildDiagnostics(),
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
  /** ATL contribution from cross-training (non-swim/bike/run) activities. */
  crossTrainingAtl?: number;
  /** CTL from non-swim/bike/run activities — same decay (42d) as discipline CTLs. */
  crossTrainingCtl?: number;
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
    swim: { ctlSum: 0, atlSum: 0, directCount: 0 },
    bike: { ctlSum: 0, atlSum: 0, directCount: 0 },
    run:  { ctlSum: 0, atlSum: 0, directCount: 0 },
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
      if (w === 1.0) acc[d].directCount++;
    }
    combinedSum += c.tss * ctlDecay;
  }

  const normalise = (sum: number, tau: number) => (sum / tau) * 7;

  const finalise = (sums: { ctlSum: number; atlSum: number; directCount: number }): PerDisciplineFitness => {
    const ctl = Math.round(normalise(sums.ctlSum, CTL_TAU_DAYS) * 10) / 10;
    const atl = Math.round(normalise(sums.atlSum, ATL_TAU_DAYS) * 10) / 10;
    return { ctl, atl, tsb: Math.round((ctl - atl) * 10) / 10, directCount: sums.directCount };
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
/**
 * Direct per-discipline CTL/ATL — own-discipline activity only, NO cross-
 * transfer matrix. Used for the user-facing "Training load" display so an
 * athlete with zero swims doesn't see 8.4 swim fatigue from bike spillover.
 * The matrix-adjusted version (`estimatePerDisciplineCTLFromActivities`) is
 * still right for race-prediction inputs (cardiovascular fitness genuinely
 * transfers across disciplines), but the user expects "swim load" to mean
 * "what I've done in the pool".
 */
export function estimateDirectPerDisciplineCTLFromActivities(
  activities: Array<Pick<GarminActual, 'activityType' | 'durationSec' | 'startTime' | 'iTrimp'>>,
  referenceDateISO: string = new Date().toISOString(),
): PerDisciplineCtlEstimate {
  const refTs = Date.parse(referenceDateISO);
  if (!Number.isFinite(refTs)) return zeroEstimate(activities.length);

  const acc = {
    swim: { ctlSum: 0, atlSum: 0, directCount: 0 },
    bike: { ctlSum: 0, atlSum: 0, directCount: 0 },
    run:  { ctlSum: 0, atlSum: 0, directCount: 0 },
  };
  let combinedSum = 0;
  let crossAtlSum = 0;
  let crossCtlSum = 0;
  let count = 0;

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

    const ctlDecay = Math.exp(-day / CTL_TAU_DAYS);
    const atlDecay = Math.exp(-day / ATL_TAU_DAYS);

    if (sport === 'other') {
      // Cross-training: track ATL and CTL for readiness bar but don't count toward discipline CTLs.
      crossAtlSum += tss * atlDecay;
      crossCtlSum += tss * ctlDecay;
      continue;
    }

    count += 1;
    acc[sport].ctlSum += tss * ctlDecay;
    acc[sport].atlSum += tss * atlDecay;
    acc[sport].directCount++;
    combinedSum += tss * ctlDecay;
  }

  const normalise = (sum: number, tau: number) => (sum / tau) * 7;
  const finalise = (sums: { ctlSum: number; atlSum: number; directCount: number }): PerDisciplineFitness => {
    const ctl = Math.round(normalise(sums.ctlSum, CTL_TAU_DAYS) * 10) / 10;
    const atl = Math.round(normalise(sums.atlSum, ATL_TAU_DAYS) * 10) / 10;
    return { ctl, atl, tsb: Math.round((ctl - atl) * 10) / 10, directCount: sums.directCount };
  };

  return {
    swim: finalise(acc.swim),
    bike: finalise(acc.bike),
    run:  finalise(acc.run),
    combinedCtl: Math.round(normalise(combinedSum, CTL_TAU_DAYS) * 10) / 10,
    crossTrainingAtl: Math.round(normalise(crossAtlSum, ATL_TAU_DAYS) * 10) / 10,
    crossTrainingCtl: Math.round(normalise(crossCtlSum, CTL_TAU_DAYS) * 10) / 10,
    activityCount: count,
  };
}

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
    swim: { ctl: 0, atl: 0, tsb: 0, directCount: 0 },
    bike: { ctl: 0, atl: 0, tsb: 0, directCount: 0 },
    run:  { ctl: 0, atl: 0, tsb: 0, directCount: 0 },
    combinedCtl: 0,
    crossTrainingAtl: 0,
    crossTrainingCtl: 0,
    activityCount: count,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CSS test detection
// ───────────────────────────────────────────────────────────────────────────

export interface CssTestSignal {
  likely: boolean;
  /** Estimated CSS in sec/100m if we can infer it from distance + duration. Null if not enough signal. */
  estimatedCss: number | null;
  reason: string;
}

/**
 * Heuristic: a swim activity looks like a CSS test (400m + 200m all-out) when:
 *   - activityType is swim-related (SWIMMING, OPEN_WATER_SWIMMING, etc.)
 *   - total distance is 600–1400m (WU + 400 + rest + 200 + CD)
 *   - pace is faster than 2:30/100m (slow swimmers doing a test still go hard)
 *
 * When `likely`, we can also estimate CSS from the whole-session pace because:
 *   the WU + CD drag the average slower than the test efforts, so whole-session
 *   pace is a conservative (safe) CSS estimate. We apply a 5s/100m buffer to
 *   account for that bias — same buffer used by the existing CSS-from-history estimator.
 */
export function looksLikeCssTest(a: Pick<GarminActual, 'activityType' | 'distanceKm' | 'durationSec' | 'hrZones'>): CssTestSignal {
  const type = (a.activityType ?? '').toLowerCase();
  if (!type.includes('swim')) {
    return { likely: false, estimatedCss: null, reason: `Not a swim activity (${a.activityType ?? 'unknown'})` };
  }

  const distM = (a.distanceKm ?? 0) * 1000;
  if (distM < 600 || distM > 1400) {
    return { likely: false, estimatedCss: null, reason: `Distance outside CSS test range (${Math.round(distM)}m)` };
  }

  const hundredMChunks = distM / 100;
  const pace = (a.durationSec ?? 0) / hundredMChunks; // sec/100m
  if (pace >= 150) {
    return { likely: false, estimatedCss: null, reason: `Pace too slow for a test effort (${Math.round(pace)}s/100m)` };
  }

  // HR confirmation: if HR zones are available, require z4+z5 > 25% of total
  // time to confirm the swim involved genuine high-intensity efforts. Without HR
  // data we fall back to the pace/distance heuristic alone.
  const hz = a.hrZones;
  if (hz) {
    const total = hz.z1 + hz.z2 + hz.z3 + hz.z4 + hz.z5;
    const hiPct = total > 0 ? (hz.z4 + hz.z5) / total : 0;
    if (hiPct < 0.25) {
      return { likely: false, estimatedCss: null, reason: `Low HR intensity (${Math.round(hiPct * 100)}% Z4+Z5 — likely easy swim, not a test)` };
    }
  }

  const estimatedCss = Math.round(pace + CSS_BUFFER_SEC_PER_100M);
  return {
    likely: true,
    estimatedCss,
    reason: `Short swim (${Math.round(distM)}m) at test-grade intensity${hz ? ' + high HR' : ''}`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// FTP test detection
// ───────────────────────────────────────────────────────────────────────────

export interface FtpTestSignal {
  likely: boolean;
  /** Best 20-min power from powerCurve, or null if not available */
  best20MinW: number | null;
  /** Estimated FTP (best20MinW × 0.95), or null */
  estimatedFtp: number | null;
  reason: string;
}

/**
 * Heuristic: a bike activity looks like a 20-min FTP test when:
 *   - activityType is cycling-related
 *   - powerCurve.p1200 exists (best 20-min power was recorded) AND p1200 >= 80W
 *   - p1200 >= 0.85 × averageWatts (the test segment dominated the ride, i.e.
 *     the user wasn't cruising easy for an hour then hammered 20 min)
 *   OR alternatively: averageWatts exists and duration is 1000–1400s (16–23 min)
 *     meaning the whole ride WAS basically the 20-min effort
 *
 * FTP = best20MinW × 0.95 (Coggan standard)
 */
export function looksLikeFtpTest(a: Pick<GarminActual, 'activityType' | 'durationSec' | 'averageWatts' | 'normalizedPowerW' | 'deviceWatts' | 'powerCurve'>): FtpTestSignal {
  const type = (a.activityType ?? '').toLowerCase();
  const isCycling = type.includes('cycl') || type.includes('bike') || type.includes('ride') || type.includes('biking');
  if (!isCycling) {
    return { likely: false, best20MinW: null, estimatedFtp: null, reason: `Not a cycling activity (${a.activityType ?? 'unknown'})` };
  }

  if (a.deviceWatts !== true) {
    return { likely: false, best20MinW: null, estimatedFtp: null, reason: 'No real power meter (device_watts not true)' };
  }

  const p1200 = a.powerCurve?.p1200;
  if (p1200 != null && p1200 >= 80) {
    const avgW = a.averageWatts ?? 0;
    if (p1200 >= avgW * 0.85) {
      const estimatedFtp = Math.round(p1200 * 0.95);
      return {
        likely: true,
        best20MinW: p1200,
        estimatedFtp,
        reason: `Best 20-min power ${Math.round(p1200)}W dominated the ride (${Math.round(p1200 / Math.max(avgW, 1) * 100)}% of avg)`,
      };
    }
    return {
      likely: false,
      best20MinW: p1200,
      estimatedFtp: null,
      reason: `20-min power (${Math.round(p1200)}W) was less than 85% of avg watts — likely an interval-training ride, not a standalone FTP test`,
    };
  }

  // Fallback: no power curve, but the whole ride duration is 16–23 min (the effort IS the test)
  const dur = a.durationSec ?? 0;
  const avgW = a.averageWatts ?? 0;
  if (dur >= 1000 && dur <= 1400 && avgW >= 80) {
    const estimatedFtp = Math.round(avgW * 0.95);
    return {
      likely: true,
      best20MinW: avgW,
      estimatedFtp,
      reason: `Whole ride was ~${Math.round(dur / 60)} min at ${Math.round(avgW)}W — consistent with a solo FTP effort`,
    };
  }

  return {
    likely: false,
    best20MinW: p1200 ?? null,
    estimatedFtp: null,
    reason: p1200 != null
      ? `20-min power exists (${Math.round(p1200)}W) but ride pattern does not match a standalone test`
      : 'No power curve and ride duration outside 16–23 min test window',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-week fitness history snapshots
// ───────────────────────────────────────────────────────────────────────────

export interface FitnessHistoryEntry {
  weekISO: string;
  swimCtl: number;
  bikeCtl: number;
  runCtl: number;
  combinedCtl: number;
  swimKm?: number;
  bikeKm?: number;
  runKm?: number;
}

/**
 * Build a chronological list of per-week CTL snapshots from a single activity
 * log. Each entry uses `estimatePerDisciplineCTLFromActivities` with the
 * reference date stepped back one week at a time, which gives the same
 * Banister 42d EMA the live `fitness` snapshot uses — just evaluated at past
 * points in time. Earliest entries naturally read 0 because the 120-day
 * look-back ran off the end of the activity log.
 */
export function buildTriFitnessHistory(
  activities: Array<Pick<GarminActual, 'activityType' | 'durationSec' | 'startTime' | 'iTrimp' | 'distanceKm'>>,
  referenceDateISO: string = new Date().toISOString(),
  weeks = 12,
): FitnessHistoryEntry[] {
  const refTs = Date.parse(referenceDateISO);
  if (!Number.isFinite(refTs) || weeks <= 0) return [];

  const out: FitnessHistoryEntry[] = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const weekTs = refTs - k * 7 * 86400000;
    const weekISO = new Date(weekTs).toISOString();
    // Direct per-discipline (no transfer matrix) — matches the on-screen
    // "Training load" card. Users expect "my swim CTL" to mean "what I've
    // done in the pool", not "swim-equivalent cross-training stimulus".
    // combinedCtl uses the matrix-aggregate which is a meaningful "total
    // training" signal.
    const direct = estimateDirectPerDisciplineCTLFromActivities(activities, weekISO);
    const matrix = estimatePerDisciplineCTLFromActivities(activities, weekISO);

    // Weekly km per discipline: sum activities in the 7-day window ending at
    // weekTs. Half-open [weekTs-7d, weekTs) so consecutive weeks don't overlap.
    const weekStart = weekTs - 7 * 86400000;
    let swimKm = 0, bikeKm = 0, runKm = 0;
    for (const a of activities) {
      if (!a.startTime) continue;
      const aTs = Date.parse(a.startTime);
      if (!Number.isFinite(aTs) || aTs < weekStart || aTs >= weekTs) continue;
      const disc = classifyActivity(a.activityType);
      const km = a.distanceKm ?? 0;
      if (disc === 'swim') swimKm += km;
      else if (disc === 'bike') bikeKm += km;
      else if (disc === 'run') runKm += km;
    }

    out.push({
      weekISO,
      swimCtl: direct.swim.ctl,
      bikeCtl: direct.bike.ctl,
      runCtl: direct.run.ctl,
      combinedCtl: matrix.combinedCtl,
      swimKm,
      bikeKm,
      runKm,
    });
  }
  const totalSwimKm = out.reduce((s, e) => s + (e.swimKm ?? 0), 0);
  const totalBikeKm = out.reduce((s, e) => s + (e.bikeKm ?? 0), 0);
  const totalRunKm  = out.reduce((s, e) => s + (e.runKm  ?? 0), 0);
  console.log(`[tri:km-history] ${out.length}w — swim ${totalSwimKm.toFixed(1)}km bike ${totalBikeKm.toFixed(1)}km run ${totalRunKm.toFixed(1)}km`);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level helper for call sites
// ───────────────────────────────────────────────────────────────────────────

export interface TriBenchmarks {
  css: CssEstimate;
  ftp: FtpEstimate;
  fitness: PerDisciplineCtlEstimate;
  fitnessHistory: FitnessHistoryEntry[];
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
  direct: DirectBenchmarkInputs = {},
  /** Athlete's default open-water environment tag. Read from
   *  `triConfig.swim.defaultOwSwimEnvironment` by callers. When undefined,
   *  un-tagged OW swims contribute pace at the wetsuit-lake baseline (factor
   *  1.0) — the safe fallback that doesn't fabricate a number. */
  defaultOwSwimEnvironment?: 'wetsuit-lake' | 'non-wetsuit-lake' | 'ocean' | 'river',
): TriBenchmarks {
  // Prefer paired-TT CSS when both 400m and 200m are provided. Otherwise
  // fall back to the best-sustained-pace estimate from swim activities.
  // Paired-TT is gold-standard so we tag it 'high' confidence regardless of
  // the activity-history estimator's tier.
  const cssFromPair = computeCSSFromPair(direct.swim400Sec, direct.swim200Sec);
  const swimEst = estimateCSSFromSwimActivities(activities, referenceDateISO, defaultOwSwimEnvironment);
  const css: CssEstimate = cssFromPair != null
    ? {
        cssSecPer100m: cssFromPair,
        swimActivityCount: swimEst.swimActivityCount,
        sourceActivityISO: undefined,
        sourceDistanceM: undefined,
        confidence: 'high',
      }
    : swimEst;

  return {
    css,
    ftp: estimateFTPFromBikeActivities(activities as unknown as PoweredActivity[], referenceDateISO),
    fitness: estimatePerDisciplineCTLFromActivities(activities, referenceDateISO),
    fitnessHistory: buildTriFitnessHistory(activities, referenceDateISO),
  };
}
