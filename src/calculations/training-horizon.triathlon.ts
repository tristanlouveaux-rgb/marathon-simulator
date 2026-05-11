/**
 * Per-discipline training-horizon adjusters for triathlon. Mirrors the marathon
 * model in `src/calculations/training-horizon.ts` (`applyTrainingHorizonAdjustment`)
 * with separate constants for swim CSS and bike FTP. The run version is a thin
 * wrapper around the existing marathon function with `target_distance: 'marathon'`
 * (IM) or `'half'` (70.3).
 *
 * **Direction conventions** (read the constants file before editing):
 *   - CSS: lower sec/100m = faster. `improvement_pct` is a *reduction*.
 *   - FTP: higher watts = faster.
 *   - VDOT: higher = faster.
 *
 * **Adaptation ratio**: scales the projected gain up or down based on observed
 * training response (HR-at-power drift, HRV trend, decoupling). Phase 1 ships
 * with `adaptationRatio = 1.0` defaults — the architecture supports live
 * signals being wired in Phase 2 without API changes.
 *
 * **Adherence penalty**: subtracted from `improvement_pct` per discipline
 * (computed via `computeTriAdherence`). A missed long ride does not penalise
 * the run projection.
 */

import type { AbilityBand } from '@/types';
import {
  SWIM_HORIZON_PARAMS,
  BIKE_HORIZON_PARAMS,
  RUN_HORIZON_PARAMS_703,
  RUN_HORIZON_PARAMS_IM,
  TRI_K_SESSIONS,
  TRI_TAPER_WEEKS,
  type DisciplineHorizonParams,
} from '@/constants/triathlon-horizon-params';
import type { TriathlonDistance } from '@/types/triathlon';

// ───────────────────────────────────────────────────────────────────────────
// Shared shape (mirrors `TrainingHorizonInput`/`TrainingHorizonResult`)
// ───────────────────────────────────────────────────────────────────────────

// `returning` raised 1.15 → 1.35 (recalibration 2026-05-06) — see
// `training-horizon.ts` EXP_FACTORS for the science. Kept in lockstep across
// running and triathlon since the underlying physiology (re-adaptation
// advantage) is modality-agnostic.
const EXP_FACTORS: Record<string, number> = {
  total_beginner: 0.75, beginner: 0.80,
  novice: 0.90, intermediate: 1.0,
  advanced: 1.05, competitive: 1.05,
  returning: 1.35,
  hybrid: 1.10,
};

export interface TriHorizonInput {
  baseline: number;                  // current CSS sec/100m, FTP watts, or VDOT
  weeks_remaining: number;
  sessions_per_week: number;
  ability_band: AbilityBand;
  taper_weeks?: number;
  experience_level?: string;
  /** 1.0 default. > 1.0 = athlete adapting faster than expected; < 1.0 = slower. */
  adaptation_ratio?: number;
  /** % to subtract from improvement_pct (per discipline). */
  adherence_penalty_pct?: number;
}

export interface TriHorizonResult {
  improvement_pct: number;
  projected: number;       // projected CSS / FTP / VDOT after horizon
  components: {
    week_factor: number;
    session_factor: number;
    undertrain_penalty: number;
    taper_bonus: number;
    adherence_penalty: number;
    adaptation_ratio: number;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Generic core — used by swim and bike. Run uses the marathon function.
// ───────────────────────────────────────────────────────────────────────────

function computeImprovementPct(
  params: DisciplineHorizonParams,
  input: TriHorizonInput,
): { improvementPct: number; components: TriHorizonResult['components'] } {
  const adaptation = input.adaptation_ratio ?? 1.0;
  const adherencePen = input.adherence_penalty_pct ?? 0;

  const empty: TriHorizonResult['components'] = {
    week_factor: 0,
    session_factor: 0,
    undertrain_penalty: 0,
    taper_bonus: 0,
    adherence_penalty: adherencePen,
    adaptation_ratio: adaptation,
  };

  if (input.weeks_remaining <= 0) {
    return { improvementPct: 0, components: empty };
  }

  const max_gain  = params.max_gain_pct[input.ability_band];
  const tau       = params.tau_weeks[input.ability_band];
  const refSess   = params.ref_sessions[input.ability_band];
  const minSess   = params.min_sessions[input.ability_band];
  const taperBon  = params.taper_bonus_pct[input.ability_band];

  const taper_eff = input.taper_weeks ?? 0;
  const weeks_eff = Math.max(0, input.weeks_remaining - taper_eff);

  const weekFactor = weeks_eff > 0 ? (1 - Math.exp(-weeks_eff / tau)) : 0;
  const sessionFactor = 1 / (1 + Math.exp(-TRI_K_SESSIONS * (input.sessions_per_week - refSess)));
  const expFactor = EXP_FACTORS[input.experience_level ?? 'intermediate'] ?? 1.0;

  let improvementPct = max_gain * weekFactor * sessionFactor * expFactor;

  // Undertraining
  let undertrainPenalty = 0;
  if (input.sessions_per_week < minSess) {
    undertrainPenalty = params.undertrain_penalty_pct * (minSess - input.sessions_per_week) / Math.max(1, minSess);
  }

  // Taper bonus — scales by how much of the planned taper duration the
  // athlete actually has time for. For races with a full taper window
  // available (weeks_remaining ≥ planned taper) → full bonus. Race tomorrow
  // (weeks_remaining = 0) → zero bonus. Previously the formula always
  // returned the full bonus when taper_eff > 0 (Math.min(1, x/max(1,x)) is
  // always 1 for x > 0) — predicted "full taper benefit" even with no time
  // to taper. Now taperRatio is the meaningful share.
  const plannedTaperWeeks = input.taper_weeks ?? 0;
  const actualTaperWeeks = Math.max(0, Math.min(plannedTaperWeeks, input.weeks_remaining));
  const taperRatio = plannedTaperWeeks > 0 ? actualTaperWeeks / plannedTaperWeeks : 0;
  const taperBonus = taperBon * taperRatio;

  improvementPct = improvementPct + taperBonus - undertrainPenalty - adherencePen;
  improvementPct *= adaptation;

  // Bounds. Clamp at 0 minimum (not max_slowdown_pct) — a *training* projection
  // should never predict fitness LOSS. The negative-floor was hiding a
  // degenerate case where weeksRemaining ≈ 0 + zero planned sessions made
  // taper_bonus 0 and undertrain_penalty large, producing negative improvement
  // and thus "training will make you slower" projections (e.g., race tomorrow
  // showed VDOT 49.6 → 48.8). Floor at 0 means worst-case projection = current
  // fitness, which is the correct semantic ("no time to improve, but also no
  // regression from training itself").
  improvementPct = Math.max(
    0,
    Math.min(params.max_gain_cap_pct, improvementPct),
  );

  return {
    improvementPct,
    components: {
      week_factor: weekFactor,
      session_factor: sessionFactor,
      undertrain_penalty: undertrainPenalty,
      taper_bonus: taperBonus,
      adherence_penalty: adherencePen,
      adaptation_ratio: adaptation,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Swim — CSS (lower = faster, improvement_pct is a REDUCTION)
// ───────────────────────────────────────────────────────────────────────────

export function applyTriHorizonSwim(input: TriHorizonInput): TriHorizonResult {
  const { improvementPct, components } = computeImprovementPct(SWIM_HORIZON_PARAMS, input);
  const projected = input.baseline * (1 - improvementPct / 100);
  console.log(`[TriHorizon:swim] band=${input.ability_band} sess=${input.sessions_per_week} weeks_rem=${input.weeks_remaining} → max_gain=${SWIM_HORIZON_PARAMS.max_gain_pct[input.ability_band]} week=${components.week_factor.toFixed(3)} sess=${components.session_factor.toFixed(3)} exp=${(EXP_FACTORS[input.experience_level ?? 'intermediate'] ?? 1.0).toFixed(2)} undertrain=${components.undertrain_penalty.toFixed(2)} taper=${components.taper_bonus.toFixed(2)} → improvement_pct=${improvementPct.toFixed(2)} CSS ${input.baseline.toFixed(0)} → ${projected.toFixed(0)}`);
  return { improvement_pct: improvementPct, projected, components };
}

// ───────────────────────────────────────────────────────────────────────────
// Bike — FTP (higher = faster, improvement_pct is a GAIN)
// ───────────────────────────────────────────────────────────────────────────

export function applyTriHorizonBike(input: TriHorizonInput): TriHorizonResult {
  const { improvementPct, components } = computeImprovementPct(BIKE_HORIZON_PARAMS, input);
  const projected = input.baseline * (1 + improvementPct / 100);
  console.log(`[TriHorizon:bike] band=${input.ability_band} sess=${input.sessions_per_week} weeks_rem=${input.weeks_remaining} → max_gain=${BIKE_HORIZON_PARAMS.max_gain_pct[input.ability_band]} week=${components.week_factor.toFixed(3)} sess=${components.session_factor.toFixed(3)} exp=${(EXP_FACTORS[input.experience_level ?? 'intermediate'] ?? 1.0).toFixed(2)} undertrain=${components.undertrain_penalty.toFixed(2)} taper=${components.taper_bonus.toFixed(2)} → improvement_pct=${improvementPct.toFixed(2)} FTP ${input.baseline.toFixed(0)}W → ${projected.toFixed(0)}W (+${(projected - input.baseline).toFixed(1)}W)`);
  return { improvement_pct: improvementPct, projected, components };
}

// ───────────────────────────────────────────────────────────────────────────
// Run — delegate to existing marathon function. VDOT (higher = faster).
// ───────────────────────────────────────────────────────────────────────────

export interface TriHorizonRunInput extends TriHorizonInput {
  triathlon_distance: TriathlonDistance;
  // runner_type and hm_pb_seconds are accepted for call-site compatibility
  // but unused — triathlon run uses per-discipline params not the marathon
  // guardrails.
  runner_type?: string;
  hm_pb_seconds?: number;
  weekly_volume_km?: number;
}

export function applyTriHorizonRun(input: TriHorizonRunInput): TriHorizonResult {
  // Use triathlon-calibrated run params (ref_sessions 3/wk for 70.3, 3.5/wk
  // for IM) rather than marathon params (ref 5/wk). A triathlete doing 3
  // focused runs/week alongside swim + bike is training optimally — the
  // marathon model would wrongly penalise them as undertrained.
  const params = input.triathlon_distance === 'ironman'
    ? RUN_HORIZON_PARAMS_IM
    : RUN_HORIZON_PARAMS_703;

  const { improvementPct, components } = computeImprovementPct(params, input);
  const projected = input.baseline + input.baseline * (improvementPct / 100);
  console.log(`[TriHorizon:run] dist=${input.triathlon_distance} band=${input.ability_band} sess=${input.sessions_per_week} weeks_rem=${input.weeks_remaining} → max_gain=${params.max_gain_pct[input.ability_band]} week=${components.week_factor.toFixed(3)} sess=${components.session_factor.toFixed(3)} exp=${(EXP_FACTORS[input.experience_level ?? 'intermediate'] ?? 1.0).toFixed(2)} undertrain=${components.undertrain_penalty.toFixed(2)} taper=${components.taper_bonus.toFixed(2)} → improvement_pct=${improvementPct.toFixed(2)} VDOT ${input.baseline.toFixed(1)} → ${projected.toFixed(1)} (+${(projected - input.baseline).toFixed(2)})`);
  return { improvement_pct: improvementPct, projected, components };
}

// ───────────────────────────────────────────────────────────────────────────
// Helper: pick taper weeks per discipline
// ───────────────────────────────────────────────────────────────────────────

export function defaultTaperWeeks(
  discipline: 'swim' | 'bike' | 'run',
  triathlonDistance: TriathlonDistance,
): number {
  return TRI_TAPER_WEEKS[discipline][triathlonDistance];
}
