/**
 * Run-leg durability cap — the triathlon-specific machinery the marathon side
 * does not need.
 *
 * **Why this exists**: capacity markers (CSS / FTP / VDOT) describe single-bout
 * capacity. The IM run leg requires holding sub-LT pace for 3+ hours after
 * 5+ hours of cumulative work. An athlete with strong markers but no recent
 * long sessions will crack on race day. The fixed 11% IM / 5% 70.3 fatigue
 * discount is an *average*; durability-deficient athletes cluster well below it.
 *
 * **Confidence: low** (stated explicitly per CLAUDE.md). Sources are
 * suggestive but not specific enough for a closed-form mapping:
 *   - Coyle 1988 *Exerc Sport Sci Rev* "Endurance specificity"
 *   - Joyner & Coyle 2008 *J Physiol* "Endurance exercise performance: the
 *     physiology of champions"
 *   - Rüst et al. 2012 *J Strength Cond Res* — IM marathon time correlates
 *     strongly with longest training run + weekly volume in build (r ≈ 0.55–0.70)
 *   - Friel "Triathlete's Training Bible" — build-phase specificity guidelines.
 *
 * Because the literature does not justify a larger penalty, the cap is bounded
 * at +5%. Do not increase without new evidence.
 *
 * **Side of the line**: tracking. Pure function.
 */

import type { TriathlonDistance } from '@/types/triathlon';

export interface DurabilityInputs {
  /** Longest single ride duration in seconds, last 12 weeks. */
  longestRideSec: number;
  /** Longest single run duration in seconds, last 12 weeks. */
  longestRunSec: number;
}

/**
 * Long-session thresholds (seconds). Anchored to Friel's "Triathlete's Training
 * Bible" build-phase guidelines: IM athletes regularly include 4.5h+ rides and
 * 2h+ long runs in the 12 weeks before race day; 70.3 athletes 2.5h+ rides and
 * 1.5h+ long runs.
 *
 * These are *threshold-met* values. Below them, the run leg is penalised
 * proportionally.
 */
export const DURABILITY_THRESHOLDS: Record<TriathlonDistance, { longRideSec: number; longRunSec: number }> = {
  ironman: { longRideSec: 4.5 * 3600, longRunSec: 2.0 * 3600 },
  '70.3':  { longRideSec: 2.5 * 3600, longRunSec: 1.5 * 3600 },
};

/** Maximum penalty applied to the run leg in absolute terms. Bounded at +5%. */
export const MAX_DURABILITY_PENALTY = 0.05;

export type LimitingFactor =
  | 'long_ride_volume'
  | 'long_run_volume'
  | 'volume_durability'
  | null;

export interface DurabilityResult {
  /** Multiplier applied to the run leg time (1.0–1.05). */
  multiplier: number;
  /** UI hook: which dimension is binding, if any. */
  limitingFactor: LimitingFactor;
  /** Diagnostic — how short of each threshold the athlete is (0 = met, 1 = absent). */
  rideShortfall: number;
  runShortfall: number;
}

/**
 * Returns the run-leg durability multiplier and a `limitingFactor` for the UI.
 *
 * - 0% penalty if both thresholds met.
 * - Each missed threshold contributes up to half of `MAX_DURABILITY_PENALTY`.
 * - Linear interpolation between threshold and 50% of threshold; below 50% the
 *   penalty is fully applied.
 */
export function applyDurabilityCap(
  inputs: DurabilityInputs,
  distance: TriathlonDistance,
): DurabilityResult {
  const { longRideSec, longRunSec } = DURABILITY_THRESHOLDS[distance];

  const rideShortfall = computeShortfall(inputs.longestRideSec, longRideSec);
  const runShortfall  = computeShortfall(inputs.longestRunSec,  longRunSec);

  const half = MAX_DURABILITY_PENALTY / 2;
  const penalty = rideShortfall * half + runShortfall * half;

  let limitingFactor: LimitingFactor = null;
  const rideBad = rideShortfall >= 0.5;  // < 50% of threshold = "binding"
  const runBad  = runShortfall  >= 0.5;
  if (rideBad && runBad)        limitingFactor = 'volume_durability';
  else if (rideBad)             limitingFactor = 'long_ride_volume';
  else if (runBad)              limitingFactor = 'long_run_volume';

  return {
    multiplier: 1 + Math.min(MAX_DURABILITY_PENALTY, Math.max(0, penalty)),
    limitingFactor,
    rideShortfall,
    runShortfall,
  };
}

/**
 * 0 if `actual >= threshold` (met).
 * 1 if `actual <= threshold/2` (absent).
 * Linear interpolation between.
 */
function computeShortfall(actualSec: number, thresholdSec: number): number {
  if (actualSec >= thresholdSec) return 0;
  const halfThresh = thresholdSec / 2;
  if (actualSec <= halfThresh) return 1;
  return (thresholdSec - actualSec) / halfThresh;
}
