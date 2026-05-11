/**
 * HYROX per-station / per-class training-horizon adjuster. Mirrors the structural
 * shape of `training-horizon.triathlon.ts` (week-factor exponential + session-
 * factor sigmoid + undertrain penalty + taper bonus + adherence penalty +
 * adaptation ratio) but uses three station classes (cardio_erg /
 * strength_endurance / grip_carry) plus a RoxZone curve.
 *
 * **Direction convention**: every Hyrox time-based metric (station seconds,
 * roxzone seconds) is REDUCTION. `improvement_pct = 5` means a 5% time
 * reduction. `projectedSec = baseSec * (1 - improvement_pct / 100)`.
 *
 * **Floor at 0% gain**: lessons-learnt from the triathlon model. A negative
 * floor produced "training will make you slower" projections in degenerate
 * cases (race tomorrow + zero planned sessions hits the undertrain penalty
 * hard). We clamp at 0 — worst case = current fitness, never regression.
 *
 * Phase 1 ships with `adaptation_ratio = 1.0` defaults. The architecture
 * supports future per-class adaptation signals (HR-at-power drift on erg
 * sessions, sled-push pace decay across reps, etc.) being wired in without
 * API changes.
 */

import type { AbilityBand, HyroxStation } from '@/types/triathlon';
import {
  STATION_CLASS,
  CARDIO_ERG_HORIZON_PARAMS,
  STRENGTH_ENDURANCE_HORIZON_PARAMS,
  GRIP_CARRY_HORIZON_PARAMS,
  ROXZONE_HORIZON_PARAMS,
  HYROX_K_SESSIONS,
  HYROX_TAPER_WEEKS,
  type HyroxHorizonParams,
  type HyroxStationClass,
  getStationClassHorizonParams,
} from '@/constants/hyrox-horizon-params';

// Mirrors EXP_FACTORS in training-horizon.triathlon.ts — same physiology
// (re-adaptation advantage / cold-start penalty) is modality-agnostic. Kept
// in lockstep deliberately.
const EXP_FACTORS: Record<string, number> = {
  total_beginner: 0.75, beginner: 0.80,
  novice: 0.90, intermediate: 1.0,
  advanced: 1.05, competitive: 1.05,
  returning: 1.35,
  hybrid: 1.10,
};

export interface HyroxHorizonInput {
  /** Current time in seconds (calibrated baseSec or band seed). */
  baseline: number;
  weeks_remaining: number;
  /** Hyrox-style sessions/wk (multi-station workouts; same count drives all classes). */
  sessions_per_week: number;
  ability_band: AbilityBand;
  /** Defaults to HYROX_TAPER_WEEKS when unset. */
  taper_weeks?: number;
  /** Maps to EXP_FACTORS bucket. Falls back to 'intermediate'. */
  experience_level?: string;
  /** 1.0 default. > 1.0 = adapting faster than expected. */
  adaptation_ratio?: number;
  /** % to subtract from improvement_pct (per-class adherence shortfall). */
  adherence_penalty_pct?: number;
}

export interface HyroxHorizonResult {
  improvement_pct: number;   // always ≥ 0; reduction direction
  projected: number;         // projected time in seconds
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
// Generic core — shared across all four curve types.
// ───────────────────────────────────────────────────────────────────────────

function computeImprovementPct(
  params: HyroxHorizonParams,
  input: HyroxHorizonInput,
): { improvementPct: number; components: HyroxHorizonResult['components'] } {
  const adaptation = input.adaptation_ratio ?? 1.0;
  const adherencePen = input.adherence_penalty_pct ?? 0;

  const empty: HyroxHorizonResult['components'] = {
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

  // Default taper used unless caller overrides. Single Hyrox-wide value
  // (HYROX_TAPER_WEEKS) — see hyrox-horizon-params header for rationale.
  const taper_eff = input.taper_weeks ?? HYROX_TAPER_WEEKS;
  const weeks_eff = Math.max(0, input.weeks_remaining - taper_eff);

  // Saturating exponential: longer horizon → asymptotic max_gain.
  const weekFactor = weeks_eff > 0 ? (1 - Math.exp(-weeks_eff / tau)) : 0;

  // Logistic dose-response — k=0.7 mirrors triathlon (recalibrated).
  const sessionFactor = 1 / (1 + Math.exp(-HYROX_K_SESSIONS * (input.sessions_per_week - refSess)));

  const expFactor = EXP_FACTORS[input.experience_level ?? 'intermediate'] ?? 1.0;

  let improvementPct = max_gain * weekFactor * sessionFactor * expFactor;

  // Undertraining penalty when below minSess.
  let undertrainPenalty = 0;
  if (input.sessions_per_week < minSess) {
    undertrainPenalty = params.undertrain_penalty_pct * (minSess - input.sessions_per_week) / Math.max(1, minSess);
  }

  // Taper bonus scaled by how much of the planned taper window the athlete
  // has time for. Race tomorrow → 0 bonus; full taper window → full bonus.
  // (Mirrors the triathlon fix that prevented "full taper benefit" being
  // claimed when there was no time to taper.)
  const plannedTaperWeeks = taper_eff;
  const actualTaperWeeks = Math.max(0, Math.min(plannedTaperWeeks, input.weeks_remaining));
  const taperRatio = plannedTaperWeeks > 0 ? actualTaperWeeks / plannedTaperWeeks : 0;
  const taperBonus = taperBon * taperRatio;

  improvementPct = improvementPct + taperBonus - undertrainPenalty - adherencePen;
  improvementPct *= adaptation;

  // Floor at 0 (never predict regression from training itself); cap at the
  // class-specific hard ceiling.
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
// Per-station horizon — looks up the station's class, then applies the curve.
// ───────────────────────────────────────────────────────────────────────────

export function applyHyroxStationHorizon(
  station: HyroxStation,
  input: HyroxHorizonInput,
): HyroxHorizonResult {
  const cls = STATION_CLASS[station];
  const params = getStationClassHorizonParams(cls);
  const { improvementPct, components } = computeImprovementPct(params, input);
  const projected = input.baseline * (1 - improvementPct / 100);
  return { improvement_pct: improvementPct, projected, components };
}

/** Class-direct variant — useful when iterating by class rather than station. */
export function applyHyroxClassHorizon(
  cls: HyroxStationClass,
  input: HyroxHorizonInput,
): HyroxHorizonResult {
  const params = getStationClassHorizonParams(cls);
  const { improvementPct, components } = computeImprovementPct(params, input);
  const projected = input.baseline * (1 - improvementPct / 100);
  return { improvement_pct: improvementPct, projected, components };
}

// ───────────────────────────────────────────────────────────────────────────
// RoxZone horizon — separate curve, same math.
// ───────────────────────────────────────────────────────────────────────────

export function applyHyroxRoxzoneHorizon(input: HyroxHorizonInput): HyroxHorizonResult {
  const { improvementPct, components } = computeImprovementPct(ROXZONE_HORIZON_PARAMS, input);
  const projected = input.baseline * (1 - improvementPct / 100);
  return { improvement_pct: improvementPct, projected, components };
}

// ───────────────────────────────────────────────────────────────────────────
// Re-exports for parity with the triathlon side's API surface.
// ───────────────────────────────────────────────────────────────────────────

export {
  CARDIO_ERG_HORIZON_PARAMS,
  STRENGTH_ENDURANCE_HORIZON_PARAMS,
  GRIP_CARRY_HORIZON_PARAMS,
  ROXZONE_HORIZON_PARAMS,
  STATION_CLASS,
  HYROX_TAPER_WEEKS,
};
