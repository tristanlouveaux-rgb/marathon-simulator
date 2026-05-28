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
 *   - Daniels J (2014) "Daniels' Running Formula" 3rd ed — marathon-specific
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
}

/**
 * Long-run threshold per race distance (seconds). The penalty is zero when
 * `longestRunSec ≥ threshold`. Calibrated against typical race-prep
 * literature (Karp 2007; Daniels 2014; Pfitzinger 2009).
 */
export const LONG_RUN_THRESHOLD_SEC: Record<RaceDistance, number> = {
  '5k':       35 * 60,    // 35 min easy — a 5K racer who can't run 35 min has economy issues
  '10k':      75 * 60,    // 75 min easy
  'half':    105 * 60,    // 1h45 — typical half-marathon build long run
  'marathon': 165 * 60,   // 2h45 (≈ 30 km easy) — Daniels minimum for time-goal marathoners
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
 * Compute the durability penalty given the longest recent run and race
 * distance. Linear shortfall ramp capped at the per-distance maximum.
 */
export function applyLongRunCap(
  longestRunSec: number,
  distance: RaceDistance,
): RunDurabilityResult {
  const thresholdSec = LONG_RUN_THRESHOLD_SEC[distance];
  const maxPenalty = LONG_RUN_MAX_PENALTY[distance];

  if (longestRunSec <= 0) {
    // No long runs found — apply maximum penalty (matches the volume-zero case).
    return {
      longestRunSec: 0,
      thresholdSec,
      multiplier: 1 + maxPenalty,
      limitingFactor: 'long_run_shortfall',
      metFraction: 0,
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
    };
  }

  const shortfallRatio = 1 - metFraction; // 0 = met, 1 = no long runs at all
  const penalty = maxPenalty * shortfallRatio;
  return {
    longestRunSec,
    thresholdSec,
    multiplier: 1 + penalty,
    limitingFactor: 'long_run_shortfall',
    metFraction,
  };
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

export function getLongestRunSec(
  state: {
    wks?: ReadonlyArray<{ garminActuals?: Record<string, RunActual> }> | null;
    onboardingRunHistory?: ReadonlyArray<{ startTime?: string; durSec?: number }> | null;
  },
  weeks: number = 12,
): number {
  const nowMs = Date.now();
  const lookbackMs = weeks * 7 * 24 * 3600 * 1000;
  let max = 0;

  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const a of Object.values(wk.garminActuals)) {
      if (!a?.startTime || !a.activityType || !a.durationSec) continue;
      const t = a.activityType.toUpperCase();
      if (t !== 'RUNNING' && !t.includes('RUN')) continue;
      if (nowMs - Date.parse(a.startTime) > lookbackMs) continue;
      if (a.durationSec > max) max = a.durationSec;
    }
  }

  // Onboarding history may push the bar higher when synced activity is thin.
  for (const r of state.onboardingRunHistory ?? []) {
    if (!r?.durSec || !r.startTime) continue;
    if (nowMs - Date.parse(r.startTime) > lookbackMs) continue;
    if (r.durSec > max) max = r.durSec;
  }

  return max;
}
