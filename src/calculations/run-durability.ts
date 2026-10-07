/**
 * Long-run durability cap for running mode.
 *
 * **Side of the line**: tracking. Applies a multiplicative penalty to the
 * race-time prediction when the user's longest single run in the last 12
 * weeks falls below the distance-specific threshold. Orthogonal to the
 * existing `marathonSpecificityPenalty` (which gates on weekly volume) —
 * both can fire and capture different deficits:
 *   - Volume penalty:    aerobic-base shortfall (weekly km too low)
 *   - Durability penalty: endurance-economy shortfall (longest run too short)
 *
 * A runner doing 60 km/wk in 10 km chunks isn't marathon-ready in the same
 * way as one doing 60 km/wk with a 30 km long run.
 *
 * Thresholds are distance-specific. Penalty scales linearly with the
 * shortfall ratio and is capped at a per-distance maximum.
 *
 * **Science basis**:
 *   - Karp JR (2007) "Training characteristics of qualifiers for the U.S.
 *     Olympic Marathon Trials" Int J Sports Physiol Perform 2:72–92 —
 *     qualifiers averaged 32 km longest run in marathon build; weekly km
 *     varied widely.
 *   - Daniels J (2014) "Daniels' Running Formula" 3rd ed. Marathon-specific
 *     long-run prescription scales with goal pace; absolute minimum 25 km
 *     for finish-focused marathoners, 30+ km for time-goal marathoners.
 *   - Pfitzinger P & Douglas S (2009) "Advanced Marathoning" 2nd ed —
 *     volume-shortened marathoners (no 30+ km long runs) finish 2–6%
 *     slower than matched-volume controls who do long runs.
 *
 * Confidence: medium. Thresholds are calibrated to typical race-prep
 * literature; the linear shortfall ramp is a pragmatic shape (Daniels and
 * Pfitzinger imply a saturating curve, but small-N would make tuning
 * brittle so linear is the honest compromise).
 */

import type { RaceDistance } from '@/types/training';

/** Run durability outcome — surfaced for UI and applied to the prediction. */
export interface RunDurabilityResult {
  /** Longest single run in the last 12 weeks (seconds). 0 = no runs found. */
  longestRunSec: number;
  /** Distance-specific threshold the engine compares against (seconds). */
  thresholdSec: number;
  /** Multiplier applied to the prediction (≥ 1.0; 1.0 = no penalty). */
  multiplier: number;
  /** Set when the penalty fires; UI banner uses this as a hint to surface. */
  limitingFactor: 'long_run_shortfall' | null;
  /** Fraction of the threshold the user has met (0–1+). UI progress bar reads this. */
  metFraction: number;
  /**
   * Count of qualifying long runs (≥ `LONG_RUN_QUALIFYING_FRACTION` of the
   * distance threshold) in the look-back window. Accumulated time-on-feet:
   * repeated long-run exposure, not just the single peak.
   */
  qualifyingLongRunCount: number;
  /** Target count for full consistency credit (`LONG_RUN_CONSISTENCY_TARGET`). */
  consistencyTarget: number;
  /**
   * Consistency credit (0–1) = `min(1, qualifyingLongRunCount / target)`. Softens
   * the peak-shortfall penalty: regular long runs build the same connective-tissue
   * durability a single peak run does, so they buy down the shortfall.
   */
  consistencyCredit: number;
}

/**
 * Long-run threshold per race distance (seconds). The penalty is zero when
 * `longestRunSec ≥ threshold`. Calibrated against typical race-prep
 * literature (Karp 2007; Daniels 2014; Pfitzinger 2009).
 */
export const LONG_RUN_THRESHOLD_SEC: Record<RaceDistance, number> = {
  '5k':       35 * 60,    // 35 min easy. A 5K racer who can't run 35 min has economy issues
  '10k':      75 * 60,    // 75 min easy
  'half':    105 * 60,    // 1h45. Typical half-marathon build long run
  'marathon': 165 * 60,   // 2h45 (≈ 30 km easy). Daniels minimum for time-goal marathoners
};

/**
 * Maximum penalty per distance. Shorter distances have less endurance
 * sensitivity so the cap is smaller. Marathon is the most durability-
 * dependent (Pfitzinger reports 2–6% gap for volume-shortened cohorts).
 */
export const LONG_RUN_MAX_PENALTY: Record<RaceDistance, number> = {
  '5k':       0.02,
  '10k':      0.03,
  'half':     0.04,
  'marathon': 0.05,
};

/**
 * A run counts toward accumulated time-on-feet ("a long run") when its duration
 * reaches this fraction of the distance threshold. 0.70 keeps the bar high enough
 * that only genuine long efforts qualify — and, because the longest run IS the
 * peak, no run can qualify unless the peak itself is already ≥ 70% of threshold.
 * That is what makes the softening self-consistent: a runner whose peak is short
 * earns zero consistency credit, so a sparse short-peak athlete keeps the full
 * penalty (see `applyLongRunCap`).
 */
export const LONG_RUN_QUALIFYING_FRACTION = 0.70;

/**
 * Qualifying long runs needed for full consistency credit, over the 12-week
 * window. ~8 ≈ one every 10 days — Pfitzinger & Douglas (2009) "Advanced
 * Marathoning" prescribe a long run every 7–10 days through a build. This is the
 * accumulated-exposure analogue of the single-peak threshold above.
 */
export const LONG_RUN_CONSISTENCY_TARGET = 8;

/**
 * Look-back window (weeks) for the longest run and the qualifying-run count.
 * The value every caller already passes (`getLongestRunSec(s, 12)`,
 * `getQualifyingLongRunCount(s, rd, 12)`), named so the race-day planned
 * durability below reads the same window.
 */
export const DURABILITY_WINDOW_WEEKS = 12;

/**
 * Compute the durability penalty given the longest recent run and race
 * distance. Linear shortfall ramp capped at the per-distance maximum.
 *
 * `qualifyingLongRunCount` is accumulated time-on-feet: the number of long runs
 * (≥ `LONG_RUN_QUALIFYING_FRACTION` of threshold) in the window. It SOFTENS the
 * peak-shortfall penalty without ever increasing it:
 *
 *   penalty = peakShortfall × maxPenalty × (1 − consistencyCredit)
 *
 * Three regimes (these are the guarantees the model promises):
 *   - peak run ≥ threshold      → no penalty (unchanged; softening is moot).
 *   - peak short BUT many longs → penalty reduced toward zero as credit → 1.
 *   - peak short AND sparse     → full penalty (count is 0 because no run can
 *                                 qualify when the peak itself is below the bar).
 */
export function applyLongRunCap(
  longestRunSec: number,
  distance: RaceDistance,
  qualifyingLongRunCount: number = 0,
): RunDurabilityResult {
  const thresholdSec = LONG_RUN_THRESHOLD_SEC[distance];
  const maxPenalty = LONG_RUN_MAX_PENALTY[distance];
  const consistencyTarget = LONG_RUN_CONSISTENCY_TARGET;
  const consistencyCredit = Math.min(1, Math.max(0, qualifyingLongRunCount) / consistencyTarget);

  if (longestRunSec <= 0) {
    // No long runs found. Apply maximum penalty (matches the volume-zero case).
    // No run can qualify, so consistency credit is structurally zero here.
    return {
      longestRunSec: 0,
      thresholdSec,
      multiplier: 1 + maxPenalty,
      limitingFactor: 'long_run_shortfall',
      metFraction: 0,
      qualifyingLongRunCount: 0,
      consistencyTarget,
      consistencyCredit: 0,
    };
  }

  const metFraction = longestRunSec / thresholdSec;
  if (metFraction >= 1) {
    return {
      longestRunSec,
      thresholdSec,
      multiplier: 1,
      limitingFactor: null,
      metFraction,
      qualifyingLongRunCount,
      consistencyTarget,
      consistencyCredit,
    };
  }

  const shortfallRatio = 1 - metFraction; // 0 = met, 1 = no long runs at all
  const penalty = maxPenalty * shortfallRatio * (1 - consistencyCredit);
  return {
    longestRunSec,
    thresholdSec,
    multiplier: 1 + penalty,
    // Only flag as limiting while the softened penalty still bites. Full
    // consistency credit zeroes the penalty → durability no longer the limiter.
    limitingFactor: penalty > 0 ? 'long_run_shortfall' : null,
    metFraction,
    qualifyingLongRunCount,
    consistencyTarget,
    consistencyCredit,
  };
}

/**
 * Durability the plan itself builds by race day: `applyLongRunCap` over the
 * runs in the `DURABILITY_WINDOW_WEEKS` weeks that end with race week. Same
 * model, constants and window as the logged-run cap (longest run plus the count
 * of runs over the qualifying bar). Plan weeks contribute the running sessions
 * the plan prescribes; when the plan is shorter than the window, the weeks
 * before plan start contribute the runs actually logged there
 * (`preplanRunSec`, see `getRunDurationsBetweenSec`).
 *
 * Why: the race-day forecast is end-of-plan fitness and assumes the plan is
 * followed. It used to drop the durability cap on the stated assumption that
 * the plan delivers the threshold long run by race day. That only holds when
 * the plan's own long runs reach the threshold: the plan caps its long run by
 * the 10% rule (plan_engine LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST), the weekly
 * budget (archetype ramp, hours target) and, for the half and 10K, a distance
 * ramp that peaks below LONG_RUN_THRESHOLD_SEC. This reads them instead of
 * assuming.
 *
 * `plannedRunMinByWeek[i]` = the minutes of every running session in plan week
 * i + 1 (plan_engine `plannedRunMinutesByWeek`). Pure.
 *
 * Tracking side: it describes what the plan delivers and never changes it.
 * Limitation: plan weeks count as prescribed, also once they are in the past
 * (a long run skipped or extended in week 3 does not move the race-day value).
 */
export function plannedRaceDayDurability(
  plannedRunMinByWeek: ReadonlyArray<ReadonlyArray<number>>,
  distance: RaceDistance,
  preplanRunSec: ReadonlyArray<number> = [],
): RunDurabilityResult {
  const durationsSec: number[] = [];
  for (const week of plannedRunMinByWeek.slice(-DURABILITY_WINDOW_WEEKS)) {
    for (const min of week) if (min > 0) durationsSec.push(min * 60);
  }
  if (plannedRunMinByWeek.length < DURABILITY_WINDOW_WEEKS) {
    for (const sec of preplanRunSec) if (sec > 0) durationsSec.push(sec);
  }
  const longestSec = durationsSec.reduce((m, sec) => (sec > m ? sec : m), 0);
  return applyLongRunCap(longestSec, distance, countQualifyingLongRuns(durationsSec, distance));
}

/**
 * Longest single run in the last 12 weeks (seconds). Reads `garminActuals`
 * across the `wks` array and the optional `onboardingRunHistory`. Returns 0
 * when no runs are found.
 */
interface RunActual {
  startTime?: string | null;
  activityType?: string | null;
  durationSec?: number | null;
}

type DurabilityState = {
  wks?: ReadonlyArray<{ garminActuals?: Record<string, RunActual> }> | null;
  onboardingRunHistory?: ReadonlyArray<{ startTime?: string; durSec?: number }> | null;
};

/**
 * All run durations (seconds) in the look-back window — the single traversal
 * that both `getLongestRunSec` (peak) and `getQualifyingLongRunCount`
 * (accumulated exposure) derive from, so the two numbers can never disagree
 * about which runs are in scope.
 */
export function getRunDurationsSec(state: DurabilityState, weeks: number = DURABILITY_WINDOW_WEEKS): number[] {
  const lookbackMs = weeks * 7 * 24 * 3600 * 1000;
  return getRunDurationsBetweenSec(state, Date.now() - lookbackMs, Infinity);
}

/**
 * Run durations (seconds) with a start time in [fromMs, toMs): the traversal
 * behind `getRunDurationsSec` (logged `garminActuals` runs across `wks`, plus
 * `onboardingRunHistory`), for an explicit window. The race-day planned
 * durability reads it for the weeks before plan start that still sit inside
 * the race-day window.
 */
export function getRunDurationsBetweenSec(state: DurabilityState, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  const outside = (startTime: string): boolean => {
    const t = Date.parse(startTime);
    return t < fromMs || t >= toMs;
  };

  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const a of Object.values(wk.garminActuals)) {
      if (!a?.startTime || !a.activityType || !a.durationSec) continue;
      const t = a.activityType.toUpperCase();
      if (t !== 'RUNNING' && !t.includes('RUN')) continue;
      if (outside(a.startTime)) continue;
      out.push(a.durationSec);
    }
  }

  // Onboarding history may push the bar higher when synced activity is thin.
  for (const r of state.onboardingRunHistory ?? []) {
    if (!r?.durSec || !r.startTime) continue;
    if (outside(r.startTime)) continue;
    out.push(r.durSec);
  }

  return out;
}

/** Longest single run in the window (seconds). 0 when no runs found. */
export function getLongestRunSec(state: DurabilityState, weeks: number = DURABILITY_WINDOW_WEEKS): number {
  let max = 0;
  for (const sec of getRunDurationsSec(state, weeks)) {
    if (sec > max) max = sec;
  }
  return max;
}

/**
 * Count of qualifying long runs in a list of run durations — pure, for callers
 * that already hold the durations array (e.g. the per-distance forecast loop,
 * which collects once and counts per distance).
 */
export function countQualifyingLongRuns(
  durationsSec: readonly number[],
  distance: RaceDistance,
): number {
  const bar = LONG_RUN_QUALIFYING_FRACTION * LONG_RUN_THRESHOLD_SEC[distance];
  let n = 0;
  for (const sec of durationsSec) {
    if (sec >= bar) n++;
  }
  return n;
}

/**
 * Accumulated time-on-feet: how many long runs (≥ 70% of the distance threshold)
 * the athlete has logged in the window. Reads from the same traversal as
 * `getLongestRunSec` so peak and exposure stay in lock-step.
 */
export function getQualifyingLongRunCount(
  state: DurabilityState,
  distance: RaceDistance,
  weeks: number = DURABILITY_WINDOW_WEEKS,
): number {
  return countQualifyingLongRuns(getRunDurationsSec(state, weeks), distance);
}
