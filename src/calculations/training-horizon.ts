import type { TrainingHorizonInput, TrainingHorizonResult, RaceDistance, AbilityBand, RunnerType } from '@/types';
import { TRAINING_HORIZON_PARAMS, TAPER_NOMINAL, EXPECTED_GAINS } from '@/constants';
import { inferLevel } from './fatigue';

/**
 * Core training horizon calculation - returns VDOT gain from non-linear model
 * @param params - Training horizon input parameters
 * @returns Training horizon result with VDOT gain and components
 */
export function applyTrainingHorizonAdjustment(params: TrainingHorizonInput): TrainingHorizonResult {
  const {
    baseline_vdot,
    target_distance,
    weeks_remaining,
    sessions_per_week,
    runner_type,
    ability_band,
    taper_weeks
  } = params;

  // Safety checks
  if (weeks_remaining <= 0) {
    return {
      vdot_gain: 0,
      improvement_pct: 0,
      components: {
        week_factor: 0,
        session_factor: 0,
        type_modifier: 1,
        undertrain_penalty: 0,
        taper_bonus: 0
      }
    };
  }

  // Get parameters for this distance/ability
  const distance_key = target_distance;
  const max_gain = TRAINING_HORIZON_PARAMS.max_gain_pct[distance_key]?.[ability_band] || 5.0;
  const tau = TRAINING_HORIZON_PARAMS.tau_weeks[distance_key]?.[ability_band] || 8.0;
  const ref_sessions = TRAINING_HORIZON_PARAMS.ref_sessions[distance_key]?.[ability_band] || 4.0;
  const type_mod = TRAINING_HORIZON_PARAMS.type_modifier[distance_key]?.[runner_type] || 1.0;

  // Effective training weeks (exclude taper from fitness gains)
  const taper_eff = taper_weeks || 0;
  const weeks_eff = Math.max(0, weeks_remaining - taper_eff);

  // Week factor: saturating exponential (1 - e^(-w/tau))
  // Early weeks: rapid gains; later weeks: diminishing returns
  const week_factor = weeks_eff > 0 ? (1 - Math.exp(-weeks_eff / tau)) : 0;

  // Session factor: logistic centered at ref_sessions
  // Below ref: slower gains; at ref: optimal; above ref: diminishing returns
  const k = TRAINING_HORIZON_PARAMS.k_sessions;
  const session_factor = 1 / (1 + Math.exp(-k * (sessions_per_week - ref_sessions)));

  // Experience factor (7 levels)
  const EXP_FACTORS: Record<string, number> = {
    total_beginner: 0.75, beginner: 0.80,
    novice: 0.90, intermediate: 1.0,
    advanced: 1.05, competitive: 1.05,
    returning: 1.15,
    hybrid: 1.10,
  };
  const exp_factor = EXP_FACTORS[params.experience_level || 'intermediate'] || 1.0;

  // Base improvement (product of all factors)
  let improvement_pct = max_gain * type_mod * week_factor * session_factor * exp_factor;

  // Undertraining penalty (if sessions too low)
  const min_sess = TRAINING_HORIZON_PARAMS.min_sessions[distance_key] || 3.0;
  let undertrain_penalty = 0;
  if (sessions_per_week < min_sess) {
    const penalty_pct = TRAINING_HORIZON_PARAMS.undertrain_penalty_pct[distance_key] || 2.5;
    undertrain_penalty = penalty_pct * (min_sess - sessions_per_week) / min_sess;
  }

  // Taper bonus (small freshness gain)
  const taper_nominal = TAPER_NOMINAL[distance_key] || 2;
  const taper_ratio = taper_eff > 0 ? Math.min(taper_eff / taper_nominal, 1) : 0;
  const taper_bonus = TRAINING_HORIZON_PARAMS.taper_bonus_pct[distance_key] * taper_ratio;

  // Final improvement (with bounds)
  improvement_pct = improvement_pct + taper_bonus - undertrain_penalty;
  improvement_pct = Math.max(
    -TRAINING_HORIZON_PARAMS.max_slowdown_pct,
    Math.min(TRAINING_HORIZON_PARAMS.max_gain_cap_pct, improvement_pct)
  );

  // UNIVERSAL GUARDRAILS — cap improvement if volume/experience is insufficient
  improvement_pct = applyGuardrails(
    baseline_vdot, improvement_pct, target_distance, params
  );

  // Convert to VDOT gain
  const vdot_gain = baseline_vdot * (improvement_pct / 100);

  return {
    vdot_gain,
    improvement_pct,
    components: {
      week_factor,
      session_factor,
      type_modifier: type_mod,
      undertrain_penalty,
      taper_bonus
    }
  };
}

/**
 * Universal guardrails — cap VDOT gain if volume/experience/PBs don't support the projection.
 * Returns the (possibly reduced) improvement_pct.
 *
 * VDOT reference points (approx):
 *   Marathon: sub-3→54, sub-3:30→48, sub-4→43
 *   Half:    sub-1:30→54, sub-1:45→47, sub-2:00→41
 *   10k:     sub-40→53, sub-50→43
 *   5k:      sub-20→52, sub-25→42
 */
/**
 * Experience level rank (higher = more experienced).
 * Used as the primary gatekeeper for time barriers.
 */
const EXP_RANK: Record<string, number> = {
  total_beginner: 0, beginner: 1, novice: 2,
  intermediate: 3, advanced: 4, competitive: 5, returning: 5, hybrid: 3,
};

function applyGuardrails(
  baseline_vdot: number,
  improvement_pct: number,
  distance: RaceDistance,
  params: TrainingHorizonInput
): number {
  const expLvl = params.experience_level || 'intermediate';
  const rank = EXP_RANK[expLvl] ?? 3;
  const hmPb = params.hm_pb_seconds || Infinity;
  const projVdot = baseline_vdot + baseline_vdot * (improvement_pct / 100);

  // Helper: cap projected VDOT just below a barrier ceiling.
  // Skip the cap if the runner's baseline is already within 2 VDOT of the
  // ceiling — they've already demonstrated fitness at that level.
  const capAt = (ceiling: number): number => {
    if (baseline_vdot >= ceiling - 2) return improvement_pct;
    if (projVdot <= ceiling) return improvement_pct;
    const maxGain = ceiling - baseline_vdot;
    const maxPct = (maxGain / baseline_vdot) * 100;
    return Math.min(improvement_pct, Math.max(0, maxPct));
  };

  // --- Marathon ---
  if (distance === 'marathon') {
    // Sub-3 (VDOT 54): requires Advanced+ OR hmPB < 1:28
    if (rank < 4 && hmPb > 5280) improvement_pct = capAt(53.5);
    // Sub-3:30 (VDOT 48): requires Intermediate+
    if (rank < 3) improvement_pct = capAt(47.5);
    // Sub-4 (VDOT 43): requires Novice+
    if (rank < 2) improvement_pct = capAt(42.5);
  }

  // --- Half Marathon ---
  if (distance === 'half') {
    // Sub-1:30 (VDOT 54): requires Advanced+
    if (rank < 4) improvement_pct = capAt(53.5);
    // Sub-1:45 (VDOT 47): requires Intermediate+
    if (rank < 3) improvement_pct = capAt(46.5);
    // Sub-2:00 (VDOT 41): requires Novice+
    if (rank < 2) improvement_pct = capAt(40.5);
  }

  // --- 10k ---
  if (distance === '10k') {
    // Sub-40 (VDOT 53): requires Intermediate+
    if (rank < 3) improvement_pct = capAt(52.5);
    // Sub-50 (VDOT 43): requires Novice+
    if (rank < 2) improvement_pct = capAt(42.5);
  }

  // --- 5k ---
  if (distance === '5k') {
    // Sub-20 (VDOT 52): requires Intermediate+
    if (rank < 3) improvement_pct = capAt(51.5);
  }

  return improvement_pct;
}

/**
 * Calculate dynamic skip penalty based on context
 * @param workoutType - Type of workout being skipped
 * @param raceDistance - Target race distance
 * @param weeksRemaining - Weeks remaining in plan
 * @param totalWeeks - Total weeks in plan
 * @param cumulativeSkips - Number of skips so far
 * @returns Penalty in seconds
 */
export function calculateSkipPenalty(
  workoutType: string,
  raceDistance: RaceDistance,
  weeksRemaining: number,
  totalWeeks: number,
  cumulativeSkips: number
): number {
  const TIM: Record<RaceDistance, Record<string, number>> = {
    '5k': { easy: 5, vo2: 20, threshold: 15, intervals: 20, long: 10 },
    '10k': { easy: 8, vo2: 18, threshold: 15, intervals: 18, race_pace: 15, long: 15 },
    'half': { easy: 10, vo2: 15, threshold: 25, race_pace: 20, mixed: 18, long: 30, progressive: 25 },
    'marathon': { easy: 15, threshold: 30, marathon_pace: 35, mixed: 25, long: 60, progressive: 35 }
  };

  const basePenalty = TIM[raceDistance]?.[workoutType] || 20;

  // Proximity factor: Skips hurt more as race approaches
  const weeksOut = totalWeeks - weeksRemaining;
  let proximityFactor = 1.0;
  if (weeksOut >= 10) proximityFactor = 0.5;
  else if (weeksOut >= 6) proximityFactor = 0.8;
  else if (weeksOut >= 3) proximityFactor = 1.2;
  else proximityFactor = 1.5;

  // Cumulative skip factor: Each additional skip compounds
  let skipFactor = 1.0;
  if (cumulativeSkips >= 4) skipFactor = 2.0 + (cumulativeSkips - 4) * 0.3;
  else if (cumulativeSkips === 3) skipFactor = 1.7;
  else if (cumulativeSkips === 2) skipFactor = 1.3;
  else if (cumulativeSkips === 1) skipFactor = 1.0;

  return Math.round(basePenalty * proximityFactor * skipFactor);
}

/**
 * Calculate expected physiology values at a given week based on predicted trajectory
 * @param initialLT - Starting LT pace (sec/km) at week 0
 * @param initialVO2 - Starting VO2max at week 0
 * @param currentWeek - Current training week
 * @param baselineVDOT - Baseline VDOT for determining ability level
 * @returns Expected LT and VO2 values at the current week
 */
export function getExpectedPhysiology(
  initialLT: number | null,
  initialVO2: number | null,
  currentWeek: number,
  baselineVDOT: number
): { expectedLT: number | null; expectedVO2: number | null } {
  const level = inferLevel(baselineVDOT);
  const gains = EXPECTED_GAINS[level] || EXPECTED_GAINS.intermediate;

  const weeksElapsed = currentWeek - 1;

  // LT pace decreases (gets faster) over time
  const expectedLT = initialLT
    ? initialLT * (1 - gains.lt * weeksElapsed)
    : null;

  // VO2max increases over time
  const expectedVO2 = initialVO2
    ? initialVO2 * (1 + gains.vo2 * weeksElapsed)
    : null;

  return { expectedLT, expectedVO2 };
}
