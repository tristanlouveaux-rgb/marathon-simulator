import type { TrainingHorizonInput, TrainingHorizonResult, RaceDistance, AbilityBand, RunnerType } from '@/types';
import { TRAINING_HORIZON_PARAMS, TAPER_NOMINAL, EXPECTED_GAINS } from '@/constants';
import { REF_KM_PER_SESSION, HOURS_TO_KM_RATE } from '@/constants/training-params';
import { inferLevel } from './fatigue';

/**
 * Build-phase volume factor: empirical average ratio of `mean weekly km across
 * non-taper weeks` to `sessions × REF_KM_PER_SESSION` for canonical periodised
 * plans. Pfitzinger 18-week intermediate marathon plans average ~50-55 km/wk
 * across the 15 non-taper weeks for 4 sessions and ~65 km/wk for 5 sessions —
 * 1.14-1.25× the bare `sessions × ref` reference. Daniels Q-plans show similar
 * build-phase ramp shape. We use 1.2 as the centre of this empirical range.
 *
 * This factor is what makes "plan-prescribed dose" different from "maintenance
 * dose at the current session count": a periodised plan ramps volume above the
 * maintenance level to drive adaptation, then tapers below it for race day.
 * The horizon model already removes taper weeks from `weeks_eff`, so we feed
 * the *build-phase* mean — not peak (which would over-state the integral) and
 * not the bare reference (which assumes flat maintenance volume).
 */
const PLAN_BUILD_PHASE_FACTOR = 1.2;

/**
 * Plan-prescribed mean weekly running volume across the build phase.
 * Used as the dose input to the horizon model — represents what the plan
 * WILL deliver if the user follows it, not what they're currently doing.
 *
 * Formula: `sessions × REF_KM_PER_SESSION[distance] × PLAN_BUILD_PHASE_FACTOR`.
 * `REF_KM_PER_SESSION` is calibrated to Daniels/Pfitzinger intermediate plans
 * (marathon=11 km, half=10, 10K=9, 5K=8). The build-phase factor lifts the
 * reference to match periodised mean.
 *
 * Returns null when sessions are unknown — caller should fall back to the
 * legacy `s.wkm` heuristic in that case.
 */
export function getPlanPrescribedMeanWeeklyKm(
  sessionsPerWeek: number | null | undefined,
  targetDistance: RaceDistance,
): number | null {
  if (sessionsPerWeek == null || sessionsPerWeek <= 0) return null;
  const ref = REF_KM_PER_SESSION[targetDistance];
  if (!ref) return null;
  return sessionsPerWeek * ref * PLAN_BUILD_PHASE_FACTOR;
}

/**
 * Convert raw `sessions_per_week` into dose-aware effective sessions.
 *
 * The base horizon model treats every session as a "standard" stimulus dose,
 * which fails for users whose time budget produces very short or very long
 * sessions. A 4×30-min marathon plan delivers roughly half the dose of a
 * 4×60-min marathon plan; both currently feed the same `session_factor`.
 *
 * We compute `actual_km_per_session` from history (`weekly_volume_km`) when
 * available, fall back to `weekly_volume_hours × HOURS_TO_KM_RATE` for new
 * users, then ratio against `REF_KM_PER_SESSION[distance]`. Clamped to
 * `[0.5, 1.3]` to keep the logistic in its meaningful range and prevent a
 * single absurdly long-session plan from over-claiming gain.
 */
function computeEffectiveSessions(
  sessions_per_week: number,
  distance: RaceDistance,
  weekly_volume_km?: number,
  weekly_volume_hours?: number,
): number {
  const ref = REF_KM_PER_SESSION[distance];
  if (!ref || sessions_per_week <= 0) return sessions_per_week;

  let km_proxy: number | null = null;
  if (weekly_volume_km != null && weekly_volume_km > 0) {
    km_proxy = weekly_volume_km;
  } else if (weekly_volume_hours != null && weekly_volume_hours > 0) {
    km_proxy = weekly_volume_hours * HOURS_TO_KM_RATE;
  }
  if (km_proxy == null) return sessions_per_week;

  const actual_km_per_session = km_proxy / sessions_per_week;
  const dose_factor = Math.max(0.5, Math.min(1.3, actual_km_per_session / ref));
  return sessions_per_week * dose_factor;
}

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
  const ref_sessions = TRAINING_HORIZON_PARAMS.ref_sessions[distance_key]?.[ability_band] || 4.0;
  const type_mod = TRAINING_HORIZON_PARAMS.type_modifier[distance_key]?.[runner_type] || 1.0;

  // Effective training weeks (exclude taper from fitness gains)
  const taper_eff = taper_weeks || 0;
  const weeks_eff = Math.max(0, weeks_remaining - taper_eff);

  // ── Week factor: dual-tau saturation (2026-05-12 audit #12) ─────────────
  //
  // weekFactor = w_fast * (1 - exp(-t/tau_fast)) + w_slow * (1 - exp(-t/tau_slow))
  //   where w_fast + w_slow = 1.
  //
  // Captures the documented two-phase adaptation profile for endurance
  // running: VO2max (fast) plateaus by ~18-24 weeks; LT + fractional
  // utilization + economy (slow) continue to ~52 weeks. Per-distance slow
  // weights skew toward LT/economy for longer races (marathon = 0.55 slow,
  // 5K = 0.30 slow) per Joyner & Coyle (2008) decomposition.
  //
  // Falls back to legacy single-tau if dual-tau params are missing (defensive
  // — the constants are populated in `training-params.ts`).
  let week_factor: number;
  if (weeks_eff <= 0) {
    week_factor = 0;
  } else {
    const tauFastTable = TRAINING_HORIZON_PARAMS.tau_fast_weeks;
    const tauSlowTable = TRAINING_HORIZON_PARAMS.tau_slow_weeks;
    const slowWeightTable = TRAINING_HORIZON_PARAMS.slow_weight;
    const tauFast = tauFastTable?.[distance_key]?.[ability_band];
    const tauSlow = tauSlowTable?.[distance_key]?.[ability_band];
    const slowWeight = slowWeightTable?.[distance_key];
    if (tauFast != null && tauSlow != null && slowWeight != null) {
      const fastWeight = 1 - slowWeight;
      const fastComponent = 1 - Math.exp(-weeks_eff / tauFast);
      const slowComponent = 1 - Math.exp(-weeks_eff / tauSlow);
      week_factor = fastWeight * fastComponent + slowWeight * slowComponent;
    } else {
      // Defensive fallback to single-tau (legacy behaviour)
      const tau = TRAINING_HORIZON_PARAMS.tau_weeks[distance_key]?.[ability_band] || 8.0;
      week_factor = 1 - Math.exp(-weeks_eff / tau);
    }
  }

  // Dose-aware effective sessions: scale raw count by km/session vs. reference.
  // 4×30-min marathon plan ≠ 4×80-min marathon plan in terms of stimulus.
  const effective_sessions = computeEffectiveSessions(
    sessions_per_week,
    distance_key,
    params.weekly_volume_km,
    params.weekly_volume_hours,
  );

  // Session factor: logistic centered at ref_sessions
  // Below ref: slower gains; at ref: optimal; above ref: diminishing returns
  const k = TRAINING_HORIZON_PARAMS.k_sessions;
  const session_factor = 1 / (1 + Math.exp(-k * (effective_sessions - ref_sessions)));

  // Experience factor (7 levels). `returning` raised 1.15 → 1.35 (recalibration
  // 2026-05-06): Mujika & Padilla (2003) and Coyle (1985) detraining-then-
  // retraining studies show returning athletes regain capacity 1.5-2× faster
  // than novices reach the same level — physiological "muscle memory" via
  // satellite cell pools, capillary density preservation, and persistent
  // mitochondrial enzyme expression. The previous 1.15 only captured a small
  // fraction of this re-adaptation advantage.
  const EXP_FACTORS: Record<string, number> = {
    total_beginner: 0.75, beginner: 0.80,
    novice: 0.90, intermediate: 1.0,
    advanced: 1.05, competitive: 1.05,
    returning: 1.35,
    hybrid: 1.10,
  };
  const exp_factor = EXP_FACTORS[params.experience_level || 'intermediate'] || 1.0;

  // Base improvement (product of all factors)
  let improvement_pct = max_gain * type_mod * week_factor * session_factor * exp_factor;

  // Undertraining penalty (if effective dose too low) — using effective_sessions
  // so a user running 4× very short sessions still trips the penalty.
  const min_sess = TRAINING_HORIZON_PARAMS.min_sessions[distance_key] || 3.0;
  let undertrain_penalty = 0;
  if (effective_sessions < min_sess) {
    const penalty_pct = TRAINING_HORIZON_PARAMS.undertrain_penalty_pct[distance_key] || 2.5;
    undertrain_penalty = penalty_pct * (min_sess - effective_sessions) / min_sess;
  }

  // Taper bonus (small freshness gain). Cap by weeks_remaining so an athlete
  // with no time to taper doesn't get the full freshness bonus. Previously
  // `taper_eff = taper_weeks` (planned duration) was used directly, so a
  // race tomorrow still got "you'll be fully tapered" credit. Now scales
  // by the actual taper window the athlete has access to.
  const taper_nominal = TAPER_NOMINAL[distance_key] || 2;
  const actual_taper_weeks = Math.max(0, Math.min(taper_eff, weeks_remaining));
  const taper_ratio = taper_nominal > 0 ? Math.min(actual_taper_weeks / taper_nominal, 1) : 0;
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
