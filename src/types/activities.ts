/** Supported cross-training sports */
export type SportKey =
  | 'soccer'
  | 'rugby'
  | 'basketball'
  | 'tennis'
  | 'swimming'
  | 'cycling'
  | 'strength'
  | 'extra_run'
  | 'hiking'
  | 'rowing'
  | 'yoga'
  | 'martial_arts'
  | 'climbing'
  | 'boxing'
  | 'crossfit'
  | 'pilates'
  | 'dancing'
  | 'skiing'
  | 'skating'
  | 'elliptical'
  | 'stair_climbing'
  | 'jump_rope'
  | 'walking'
  | 'padel'
  | 'generic_sport'
  | 'hybrid_test_sport';

/** Extended model for future decoupled fitness/fatigue mechanics (not yet used in scoring) */
export interface ExtendedModel {
  aerobicTransfer: number;    // Aerobic fitness adaptation transfer (0-1)
  anaerobicTransfer: number;  // Anaerobic fitness adaptation transfer (0-1)
  impactLoading: number;      // Musculoskeletal impact stress factor (0-2)
}

/** Sport database entry */
export interface SportConfig {
  mult: number;            // Load multiplier
  noReplace: string[];     // Workout types this sport can't replace
  runSpec: number;         // Running specificity (0-1)
  recoveryMult?: number;   // Recovery cost multiplier (>=1 for team sports, <1 for low impact)
  extendedModel?: ExtendedModel;  // Future: decoupled fitness/fatigue model (read but not scored)
  impactPerMin?: number;   // Musculoskeletal impact load per minute (0 for cycling/swimming)
  legLoadPerMin?: number;  // Leg fatigue load per minute — vertical sports highest, flat sustained moderate, 0 for non-leg
  volumeTransfer?: number; // GPS km credit toward running volume bar (0–1). Only GPS sports with real distance.
  intermittent?: boolean;  // True for sports with high-HR bursts + rest (football, rugby, basketball)
}

/** Cross-training activity */
export interface CrossActivity {
  id: number;
  date: Date;
  week: number;
  sport: SportKey | string;
  duration_min: number;
  rpe: number;
  aerobic_load: number;
  anaerobic_load: number;
  dayOfWeek: number;
  aerobic: number;
  anaerobic: number;
  fromGarmin: boolean;
  applied: boolean;
  renderCycle: number;
  appliedToNextWeek?: boolean;
  iTrimp?: number | null;
  hrZones?: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
}

/** Intensity profile for load matching */
export interface IntensityProfile {
  total: number;
  anaerobicRatio: number;
  weighted: number;
}

/** Cross-training adjustment record for UI display */
export interface CrossTrainingAdjustment {
  sport: string;
  load: number;
  impact: string;
  vdotChange: number;
}

/** Workout load calculation result */
export interface WorkoutLoad {
  aerobic: number;       // base + threshold (backward compat for cross-training matcher)
  anaerobic: number;     // intensity (backward compat for cross-training matcher)
  total: number;
  tl?: number;           // TSS-calibrated load for this workout
  impactLoad?: number;   // Musculoskeletal impact load
  // 3-zone breakdown (Z1+Z2 / Z3 / Z4+Z5) — used for display only
  base?: number;
  threshold?: number;
  intensity?: number;
}

/** Load budget for cross-training modifications */
export interface LoadBudget {
  replacementBudget: number;     // Total load available for full replacements
  adjustmentBudget: number;      // Total load available for adjustments
  replacementConsumed: number;   // Load already consumed by replacements
  adjustmentConsumed: number;    // Load already consumed by adjustments
  totalWorkoutLoad: number;      // Total workout load this budget is based on
  previousWeekLoad: number;      // Load from previous week (decayed)
}
