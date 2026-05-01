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

import type { AbilityBand, RaceDistance, RunnerType } from '@/types';
import {
  SWIM_HORIZON_PARAMS,
  BIKE_HORIZON_PARAMS,
  TRI_K_SESSIONS,
  TRI_TAPER_WEEKS,
  type DisciplineHorizonParams,
} from '@/constants/triathlon-horizon-params';
import type { TriathlonDistance } from '@/types/triathlon';
import { applyTrainingHorizonAdjustment } from './training-horizon';

// ───────────────────────────────────────────────────────────────────────────
// Shared shape (mirrors `TrainingHorizonInput`/`TrainingHorizonResult`)
// ───────────────────────────────────────────────────────────────────────────

const EXP_FACTORS: Record<string, number> = {
  total_beginner: 0.75, beginner: 0.80,
  novice: 0.90, intermediate: 1.0,
  advanced: 1.05, competitive: 1.05,
  returning: 1.15,
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

  // Taper bonus — full bonus when taper duration meets the discipline default
  const taperBonus = taperBon * Math.min(1, taper_eff / Math.max(1, taper_eff || 1));

  improvementPct = improvementPct + taperBonus - undertrainPenalty - adherencePen;
  improvementPct *= adaptation;

  // Bounds
  improvementPct = Math.max(
    -params.max_slowdown_pct,
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
  return { improvement_pct: improvementPct, projected, components };
}

// ───────────────────────────────────────────────────────────────────────────
// Bike — FTP (higher = faster, improvement_pct is a GAIN)
// ───────────────────────────────────────────────────────────────────────────

export function applyTriHorizonBike(input: TriHorizonInput): TriHorizonResult {
  const { improvementPct, components } = computeImprovementPct(BIKE_HORIZON_PARAMS, input);
  const projected = input.baseline * (1 + improvementPct / 100);
  return { improvement_pct: improvementPct, projected, components };
}

// ───────────────────────────────────────────────────────────────────────────
// Run — delegate to existing marathon function. VDOT (higher = faster).
// ───────────────────────────────────────────────────────────────────────────

export interface TriHorizonRunInput extends TriHorizonInput {
  triathlon_distance: TriathlonDistance;
  runner_type?: RunnerType;
  hm_pb_seconds?: number;
  weekly_volume_km?: number;
}

export function applyTriHorizonRun(input: TriHorizonRunInput): TriHorizonResult {
  // Map triathlon distance to the running-side `target_distance` so we
  // pick up the correct marathon (IM) / half (70.3) horizon constants.
  const target_distance: RaceDistance = input.triathlon_distance === 'ironman' ? 'marathon' : 'half';

  const result = applyTrainingHorizonAdjustment({
    baseline_vdot: input.baseline,
    target_distance,
    weeks_remaining: input.weeks_remaining,
    sessions_per_week: input.sessions_per_week,
    runner_type: input.runner_type ?? 'Balanced',
    ability_band: input.ability_band,
    taper_weeks: input.taper_weeks ?? 0,
    experience_level: input.experience_level,
    weekly_volume_km: input.weekly_volume_km,
    hm_pb_seconds: input.hm_pb_seconds,
  });

  // Apply adaptation + adherence on top of the marathon-style gain (the
  // marathon function does not yet take these inputs).
  const adaptation = input.adaptation_ratio ?? 1.0;
  const adherencePen = input.adherence_penalty_pct ?? 0;
  let improvementPct = result.improvement_pct - adherencePen;
  improvementPct *= adaptation;
  // Clamp to the same marathon bounds (15% cap, 3% slowdown) — values from
  // `TRAINING_HORIZON_PARAMS.max_gain_cap_pct/max_slowdown_pct`.
  improvementPct = Math.max(-3.0, Math.min(15.0, improvementPct));

  const projected = input.baseline + input.baseline * (improvementPct / 100);
  return {
    improvement_pct: improvementPct,
    projected,
    components: {
      week_factor: result.components.week_factor,
      session_factor: result.components.session_factor,
      undertrain_penalty: result.components.undertrain_penalty,
      taper_bonus: result.components.taper_bonus,
      adherence_penalty: adherencePen,
      adaptation_ratio: adaptation,
    },
  };
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
