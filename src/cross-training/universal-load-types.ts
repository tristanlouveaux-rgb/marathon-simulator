/**
 * universal-load-types.ts
 * =======================
 * Types for the Universal Load Currency system.
 * Defines inputs, outputs, and plan adjustments.
 */

import type { SportKey, RaceDistance, WorkoutType, Workout, CrossActivity } from '@/types';

// ---------------------------------------------------------------------------
// Activity Input Types
// ---------------------------------------------------------------------------

/** HR zone data for Tier B calculations */
export interface HRZoneData {
  zone1Minutes: number;  // Recovery zone
  zone2Minutes: number;  // Easy aerobic
  zone3Minutes: number;  // Moderate aerobic
  zone4Minutes: number;  // Threshold
  zone5Minutes: number;  // VO2max/anaerobic
}

/** HR configuration for zone calculation */
export interface ZonesConfig {
  maxHR?: number;
  restingHR?: number;
  age?: number;
  lthrPct?: number;  // Lactate threshold as % of maxHR (default ~0.88)
}

/** Input for logged cross-training activity */
export interface ActivityInput {
  sport: SportKey | string;
  durationMin: number;
  rpe?: number;                    // 1-10 scale

  // Tier A: Garmin/Firstbeat data
  garminAerobicLoad?: number;
  garminAnaerobicLoad?: number;

  // Tier B: HR data
  hrZones?: HRZoneData;
  avgHR?: number;
  maxHRReached?: number;

  // Metadata
  dayOfWeek?: number;              // 0=Mon, 6=Sun
  fromGarmin?: boolean;
  activityId?: string | number;
}

// ---------------------------------------------------------------------------
// Universal Load Result
// ---------------------------------------------------------------------------

/** Data tier used for calculation */
export type DataTier = 'garmin' | 'hr' | 'rpe';

/** Computed universal load from any activity */
export interface UniversalLoadResult {
  // Core load values
  aerobicLoad: number;
  anaerobicLoad: number;
  baseLoad: number;             // aerobicLoad + anaerobicLoad

  // Derived values (spec-defined)
  fatigueCostLoad: number;      // FCL: baseLoad * recoveryMult (NOT saturated)
  runReplacementCredit: number; // RRC: saturated + goal-adjusted

  // Metadata
  tier: DataTier;
  confidence: number;           // 0..1
  sportKey: SportKey;
  sportMult: number;
  recoveryMult: number;
  runSpec: number;

  // Explanation strings for UI
  explanations: string[];
  equivalentEasyKm: number;     // For "≈ X km easy" messaging
}

// ---------------------------------------------------------------------------
// Plan Adjustment Types
// ---------------------------------------------------------------------------

/** Action to take on a workout */
export type AdjustmentAction = 'replace' | 'downgrade' | 'reduce';

/** Single edit to a planned workout */
export interface PlanEdit {
  workoutId: string;
  dayOfWeek: number;
  action: AdjustmentAction;
  originalType: WorkoutType;
  originalDistanceKm: number;
  newType: WorkoutType;
  newDistanceKm: number;
  loadReduction: number;        // Amount of load "absorbed"
  rationale: string;
}

/** Severity of the activity relative to weekly plan */
export type Severity = 'light' | 'heavy' | 'extreme';

/** Outcome for a given user choice */
export interface ChoiceOutcome {
  edits: PlanEdit[];
  summary: string;
  totalLoadReduction: number;
}

/** The 3-option suggestion payload for UI */
export interface SuggestionPayload {
  // Activity summary
  sportName: string;
  durationMin: number;
  rpe: number;
  equivalentEasyKm: number;

  // Computed loads
  fatigueCostLoad: number;
  runReplacementCredit: number;
  confidence: number;
  tier: DataTier;

  // Severity and messaging
  severity: Severity;
  headline: string;
  summary: string;              // Includes equivalence statement
  warnings: string[];

  // The 3 choices
  keepOutcome: ChoiceOutcome;           // Option A
  recommendedOutcome: ChoiceOutcome;    // Option B (replace + reduce chain)
  conservativeOutcome: ChoiceOutcome;   // Option C (reduce/downgrade only)

  // Extreme mode flag
  isExtremeSession: boolean;

  // For reversion tracking
  canRevert: boolean;
  reversionDeadline?: Date;
}

// ---------------------------------------------------------------------------
// Planned Run Representation
// ---------------------------------------------------------------------------

/** Planned run with expected loads (for matcher) */
export interface PlannedRun {
  workoutId: string;
  dayIndex: number;             // 0=Mon, 6=Sun
  workoutType: WorkoutType;
  plannedDistanceKm: number;
  plannedAerobic: number;
  plannedAnaerobic: number;
  status: 'planned' | 'reduced' | 'replaced' | 'skipped';
  isLongRun: boolean;
  isQuality: boolean;
}

// ---------------------------------------------------------------------------
// Athlete Context for Matching
// ---------------------------------------------------------------------------

/** Context for goal-based adjustments */
export interface AthleteContext {
  raceGoal: RaceDistance;
  plannedRunsPerWeek: number;
  injuryMode: boolean;
  easyPaceSecPerKm?: number;
  weeklyPlannedLoad?: number;
}

// ---------------------------------------------------------------------------
// Cross-Activity for Legacy Compatibility
// ---------------------------------------------------------------------------

/** Convert CrossActivity to ActivityInput */
export function crossActivityToInput(act: CrossActivity): ActivityInput {
  return {
    sport: act.sport,
    durationMin: act.duration_min,
    rpe: act.rpe,
    garminAerobicLoad: act.fromGarmin ? act.aerobic_load : undefined,
    garminAnaerobicLoad: act.fromGarmin ? act.anaerobic_load : undefined,
    dayOfWeek: act.dayOfWeek,
    fromGarmin: act.fromGarmin,
    activityId: act.id,
  };
}
