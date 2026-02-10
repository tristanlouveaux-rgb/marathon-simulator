/**
 * Advanced Intelligent Injury Management System - Type Definitions
 */

import type { SportKey } from './activities';
import type { Workout } from './state';

/** Pain history entry for trend analysis */
export interface PainHistoryEntry {
  date: string;       // ISO date string
  pain: number;       // Pain level 0-10
}

/** Morning pain response for weekly gate evaluation */
export interface MorningPainResponse {
  date: string;
  response: 'worse' | 'same' | 'better';
  painLevel: number;
}

/** Severity classification for return-to-run gating */
export type SeverityClass = 'niggle' | 'moderate' | 'severe';

/** Gate decision from weekly return-to-run evaluation */
export interface GateDecision {
  decision: 'progress' | 'hold' | 'regress';
  reason: string;
  newLevel: number;
}

/** Injury type identifiers */
export type InjuryType =
  | 'achilles'
  | 'runners_knee'
  | 'stress_fracture'
  | 'shin_splints'
  | 'plantar_fasciitis'
  | 'it_band'
  | 'hamstring'
  | 'hip_flexor'
  | 'general';

/** Body part location for injury */
export type InjuryLocation = 'foot' | 'knee' | 'calf' | 'hamstring' | 'hip' | 'back' | 'other';

/** Training context mode */
export type TrainingContext = 'training' | 'rehab' | 'recovery';

/**
 * Physio-Grade Injury Phase
 * Defines the clinical progression through injury recovery
 */
export type InjuryPhase =
  | 'acute'           // Phase 1: 72h minimum rest, no activity
  | 'rehab'           // Phase 2: Cross-training + rehab strength only
  | 'test_capacity'   // Phase 3: Must pass capacity tests to progress
  | 'return_to_run'   // Phase 4: Walk/run intervals, graded exposure
  | 'graduated_return' // Phase 5: Normal workouts with reduced hard sessions, 2-week check-in
  | 'resolved';       // Fully recovered, normal training

/** Capacity test types for test_capacity phase */
export type CapacityTestType =
  | 'single_leg_hop'      // 10x single leg hop pain-free
  | 'pain_free_walk'      // 30min walk pain-free
  | 'isometric_hold'      // Pain-free isometric contraction
  | 'stair_test'          // Up/down stairs pain-free
  | 'squat_test';         // Bodyweight squat pain-free

/** Capacity test result */
export interface CapacityTestResult {
  testType: CapacityTestType;
  date: string;
  passed: boolean;
  painDuring: number;
  painAfter: number;
  notes: string;
}

/** Phase transition record */
export interface PhaseTransition {
  fromPhase: InjuryPhase;
  toPhase: InjuryPhase;
  date: string;
  reason: string;
  wasRegression: boolean;
}

/** Recovery phase after injury */
export type RecoveryPhase =
  | 'no_load'          // Complete rest
  | 'test_phase'       // Diagnostic runs only
  | 'phase_1'          // Limited training
  | 'phase_2'          // Moderate training
  | 'full_training';   // Normal training

/** Trend detection result */
export type TrendType =
  | 'acute_spike'      // Pain increased >2 points in 24h
  | 'chronic_plateau'  // Stable pain for >5 days
  | 'improving'        // Pain decreasing
  | 'stable'           // No significant change
  | 'worsening';       // Gradual increase

/** Trend analysis result */
export interface TrendAnalysis {
  trend: TrendType;
  daysSinceTrendStart: number;
  averagePain: number;
  painDelta24h: number;
  recommendation: TrendRecommendation;
}

/** Recommendation based on trend */
export interface TrendRecommendation {
  action: 'emergency_shutdown' | 'rehab_block' | 'continue' | 'progress' | 'monitor';
  restDays: number;
  switchToRehab: boolean;
  message: string;
}

/** Injury state with full history tracking */
export interface InjuryState {
  active: boolean;
  type: InjuryType;
  location: InjuryLocation;          // Body part location
  locationDetail: string;            // Additional location details (e.g., "left", "right")
  currentPain: number;               // Current pain level 0-10
  history: PainHistoryEntry[];       // Pain history for trend analysis
  startDate: string;                 // ISO date when injury started
  context: TrainingContext;          // Current training context
  recoveryPhase: RecoveryPhase;      // Current recovery phase (legacy)
  lastTestRunDate: string | null;    // Last diagnostic test run
  testRunPainResult: number | null;  // Pain level after last test run
  emergencyShutdownUntil: string | null;  // Date when shutdown ends
  rehabBlockStartDate: string | null;     // When rehab block started
  physioNotes: string;               // Notes from physiotherapist
  expectedDurationWeeks: number;     // Expected recovery duration in weeks

  // Physio-Grade Injury System fields
  injuryPhase: InjuryPhase;          // Current clinical phase
  painLatency: boolean;              // Did pain increase 24h post-activity?
  acutePhaseStartDate: string | null;     // When acute phase started (72h minimum)
  capacityTestsPassed: CapacityTestType[];  // Tests passed in test_capacity phase
  capacityTestHistory: CapacityTestResult[]; // History of all capacity tests
  phaseTransitions: PhaseTransition[];       // History of phase changes
  lastActivityDate: string | null;           // Last workout/activity date
  morningPainYesterday: number | null;       // Pain level yesterday morning (for latency check)
  canRun: 'yes' | 'limited' | 'no';         // Self-reported running ability

  // Response-gated return-to-run fields
  returnToRunLevel: number;                  // Current protocol level (1-8), default 1
  severityClass: SeverityClass;              // Derived from peak pain
  morningPainResponses: MorningPainResponse[]; // This week's morning data
  holdCount: number;                         // Consecutive holds at current level, default 0

  // Cross-training preference
  preferredCrossTraining: string | null;     // User's chosen activity, default null

  // Zero-pain tracking for early exit prompt
  zeroPainWeeks: number;                     // Consecutive weeks with pain 0, default 0

  // Graduated return phase tracking
  graduatedReturnWeeksLeft: number;          // Weeks remaining in graduated return (default 2)
}

/** Test run (diagnostic run) workout definition */
export interface TestRunWorkout extends Workout {
  t: 'test_run';
  intervals: TestRunInterval[];
  completionCriteria: TestRunCriteria;
}

/** Test run interval structure */
export interface TestRunInterval {
  type: 'run' | 'walk';
  durationMinutes: number;
  targetPace?: string;     // Optional pace guidance
}

/** Criteria to pass a test run */
export interface TestRunCriteria {
  maxPainAllowed: number;          // Max pain to pass (typically 2)
  requiresNoSwelling: boolean;
  requiresNormalGait: boolean;
}

/** Test run result */
export interface TestRunResult {
  date: string;
  painDuring: number;
  painAfter: number;
  completed: boolean;
  swellingObserved: boolean;
  gaitNormal: boolean;
  passed: boolean;
  nextPhase: RecoveryPhase;
}

/** Injury protocol for specific injury types */
export interface InjuryProtocol {
  injuryType: InjuryType;
  displayName: string;
  bannedActivities: SportKey[];
  allowedActivities: SportKey[];
  priorityActivities: SportKey[];  // Recommended activities
  bannedWorkoutTypes: string[];    // e.g., 'hill_repeats', 'intervals'
  recoveryNotes: string;
  typicalRecoveryWeeks: { min: number; max: number };
}

/** Injury adaptation result */
export interface InjuryAdaptation {
  originalWorkout: Workout;
  adaptedWorkout: Workout | null;    // null = workout removed
  adaptationType: 'replaced' | 'modified' | 'removed' | 'unchanged';
  replacementActivity?: SportKey;
  reason: string;
}

/** Weekly plan after injury adaptation */
export interface InjuryAdaptedPlan {
  workouts: Workout[];
  adaptations: InjuryAdaptation[];
  injuryState: InjuryState;
  trendAnalysis: TrendAnalysis;
  warnings: string[];
  recommendations: string[];
}

/** Default injury state factory */
export function createDefaultInjuryState(): InjuryState {
  return {
    active: false,
    type: 'general',
    location: 'other',
    locationDetail: '',
    currentPain: 0,
    history: [],
    startDate: new Date().toISOString(),
    context: 'training',
    recoveryPhase: 'full_training',
    lastTestRunDate: null,
    testRunPainResult: null,
    emergencyShutdownUntil: null,
    rehabBlockStartDate: null,
    physioNotes: '',
    expectedDurationWeeks: 0,

    // Physio-Grade defaults
    injuryPhase: 'resolved',
    painLatency: false,
    acutePhaseStartDate: null,
    capacityTestsPassed: [],
    capacityTestHistory: [],
    phaseTransitions: [],
    lastActivityDate: null,
    morningPainYesterday: null,
    canRun: 'no',

    // Response-gated return-to-run defaults
    returnToRunLevel: 1,
    severityClass: 'moderate',
    morningPainResponses: [],
    holdCount: 0,

    // Cross-training preference
    preferredCrossTraining: null,

    // Zero-pain tracking
    zeroPainWeeks: 0,

    // Graduated return
    graduatedReturnWeeksLeft: 2,
  };
}
