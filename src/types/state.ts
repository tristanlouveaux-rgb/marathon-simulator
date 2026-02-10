import type {
  PBs,
  Paces,
  RaceDistance,
  RunnerType,
  RecentRun,
  TrainingPhase
} from './training';
import type { CrossTrainingAdjustment, LoadBudget } from './activities';
import type { OnboardingState, Marathon, RecurringActivity, TrainingFocus } from './onboarding';

/** Benchmark check-in types (4-tier system) */
export type BenchmarkType =
  | 'easy_checkin'       // 30 min easy–steady, track pace at same effort
  | 'threshold_check'    // 20 min "comfortably hard" — proxy for LT
  | 'speed_check'        // 12-min Cooper test or 3km TT — VO2/speed signal
  | 'race_simulation';   // 5k/10k TT (advanced only, opt-in)

/** Benchmark result from an optional check-in */
export interface BenchmarkResult {
  week: number;
  blockNumber: number;
  focus: TrainingFocus;
  type: BenchmarkType;
  distanceKm?: number;       // Distance covered (for cooper/TT)
  durationSec?: number;      // Duration of the effort
  avgPaceSecKm?: number;     // Average pace
  source: 'garmin' | 'manual' | 'skipped';
  timestamp: string;
}

/** A benchmark option presented to the user */
export interface BenchmarkOption {
  type: BenchmarkType;
  label: string;
  description: string;
  recommended?: boolean;      // Smart default for this user
}

/** Commute run configuration */
export interface CommuteConfig {
  enabled: boolean;
  distanceKm: number;           // One-way distance
  isBidirectional: boolean;     // true = to+from work
  commuteDaysPerWeek: number;   // 1-5 commute days per week
}

/** Cross-training summary for week */
export interface CrossTrainingSummary {
  totalLoadApplied: number;
  totalLoadOverflow: number;
  workoutsReplaced: number;
  workoutsReduced: number;
  budgetUtilization: {
    replacement: number;      // 0-1 fraction
    adjustment: number;       // 0-1 fraction
  };
}

/** Workout definition from library */
export interface WorkoutDefinition {
  n: string;       // Name
  d: string;       // Description (distance/intervals)
  r: number;       // Expected RPE
}

/** Workout with additional metadata */
export interface Workout extends WorkoutDefinition {
  id?: string;                  // Stable unique ID (e.g., "W1-easy-0")
  t: string;                    // Workout type
  rpe?: number;                 // Expected RPE (alternative to r)
  dayOfWeek?: number;           // Day of week (0=Mon, 6=Sun)
  dayName?: string;             // Day name
  aerobic?: number;             // Aerobic load
  anaerobic?: number;           // Anaerobic load
  skipped?: boolean;            // Was this skipped from previous week
  skipCount?: number;           // Number of times skipped
  originalName?: string;        // Original name if renamed
  status?: 'planned' | 'reduced' | 'replaced' | 'skipped';
  modReason?: string;           // Modification reason
  confidence?: 'high' | 'medium' | 'low';
  originalDistance?: string;    // Original distance before modification
  autoCompleted?: boolean;      // Auto-completed by cross-training
  completedBySport?: string;    // Sport that completed this workout
  hrTarget?: {                   // Heart rate target (conditional — only if HR data available)
    zone: string;
    min: number;
    max: number;
    label: string;
  };
  commute?: boolean;             // This is a commute run
  testType?: string; // For physio capacity tests
}

/** Skipped workout record */
export interface SkippedWorkout {
  n: string;            // Workout name
  t: string;            // Workout type
  workout: Workout;     // Full workout data
  skipCount: number;    // Number of times skipped
}

/** Workout modification record (for persistence) */
export interface WorkoutMod {
  name: string;
  dayOfWeek?: number;  // Added for unique identification when names collide
  status: string;
  modReason: string;
  confidence?: string;
  originalDistance?: string;
  newDistance: string;
  newType?: string;    // New workout type if downgraded (e.g., 'easy')
  newRpe?: number;     // New RPE to match downgraded type
}

/** Simple cross-training record (old format) */
export interface SimpleCross {
  s: string;   // Sport name
  d: number;   // Duration in minutes
  ae: number;  // Aerobic effect
  an: number;  // Anaerobic effect
  l: number;   // Load
}

/** Week data */
export interface Week {
  w: number;                            // Week number
  ph: TrainingPhase;                    // Training phase
  rated: Record<string, number | 'skip'>; // Workout ratings
  ratedChanges?: Record<string, number>;  // VDOT changes from ratings
  skip: SkippedWorkout[];               // Skipped workouts to carry forward
  cross: SimpleCross[];                 // Cross-training activities (old format)
  wkGain: number;                       // Week VDOT gain
  workoutMods: WorkoutMod[];            // Stored workout modifications
  workoutMoves?: Record<string, number>; // Manual workout day moves
  adjustments: CrossTrainingAdjustment[]; // Cross-training adjustments
  unspentLoad: number;                  // Unspent cross-training load
  extraRunLoad: number;                 // Extra run load
  crossVDOTBonus?: number;              // Bonus from cross-training
  crossTrainingBonus?: number;          // Display bonus
  crossTrainingSummary?: CrossTrainingSummary; // Detailed cross-training summary
  injuryState?: import('./injury').InjuryState; // Injury state for this week
  adhocWorkouts?: Workout[];                    // Ad-hoc workouts (e.g. "Just Run")
  injuryCheckedIn?: boolean;                    // Whether injury was updated this week
  passedCapacityTests?: string[];               // Capacity tests passed this week
}

/** State schema version for migrations */
export const STATE_SCHEMA_VERSION = 2;

/** Version where runner type semantics were fixed (Speed↔Endurance swap) */
export const RUNNER_TYPE_SEMANTICS_FIX_VERSION = 2;

/** Main simulator state */
export interface SimulatorState {
  // Schema version (for migrations)
  schemaVersion?: number;

  // Week tracking
  w: number;              // Current week
  tw: number;             // Total weeks

  // VDOT tracking
  v: number;              // Starting VDOT
  iv: number;             // Initial VDOT (same as v)
  rpeAdj: number;         // RPE adjustment to VDOT
  physioAdj?: number;     // VDOT adjustment from manual physiology gains
  expectedFinal: number;  // Expected final VDOT

  // Plan configuration
  rd: RaceDistance;       // Race distance
  epw: number;            // Exercises per week (total including cross-training)
  rw: number;             // Runs per week (derived: min(epw, 7))
  wkm: number;            // Weekly km

  // Personal records
  pbs: PBs;               // All-time PBs
  rec: RecentRun | null;  // Recent race/time trial

  // Physiology
  lt: number | null;      // Current LT pace (sec/km)
  ltPace?: number | null; // LT pace alias
  vo2: number | null;     // Current VO2max
  initialLT: number | null;   // Initial LT at week 0
  initialVO2: number | null;  // Initial VO2 at week 0
  maxHR?: number;             // Maximum Heart Rate
  restingHR?: number;         // Resting Heart Rate

  // Race time tracking
  initialBaseline: number | null;   // Initial race time prediction
  currentFitness: number | null;    // Current race time estimate
  forecastTime: number | null;      // Forecast race time after training

  // Runner profile
  typ: RunnerType;                      // Effective runner type (used by engine)
  calculatedRunnerType?: RunnerType;    // Runner type calculated from PBs
  b: number;                            // Fatigue exponent

  // Training data
  wks: Week[];            // All weeks
  pac: Paces;             // Current paces
  skip: number[];         // Skip tracking (deprecated)
  timp: number;           // Total time impact from skips

  // Tracking
  adaptationRatio?: number;    // How athlete responds vs expected
  week1EasyPace?: number;      // Week 1 easy pace for tracking

  // Physiology tracking state
  physiologyTracking?: {
    measurements: Array<{
      week: number;
      ltPaceSecKm: number | null;
      vo2max: number | null;
      source: 'watch' | 'manual' | 'test';
      timestamp?: string;
    }>;
    lastAssessmentStatus?: 'excellent' | 'good' | 'onTrack' | 'slow' | 'concerning' | 'needsData';
    lastAssessmentMessage?: string;
  };

  // Commute configuration
  commuteConfig?: CommuteConfig;

  // Recurring cross-training activities (from onboarding)
  recurringActivities?: RecurringActivity[];

  // Onboarding state
  onboarding?: OnboardingState;
  hasCompletedOnboarding?: boolean;

  // Admin and trial
  isAdmin?: boolean;
  trialExpiry?: string;  // ISO date string

  // Integrations
  stravaConnected?: boolean;

  // Selected event (locked from onboarding)
  selectedMarathon?: Marathon;

  // Injury recovery tracking
  rehabWeeksDone?: number;        // Weeks completed during injury (plan pointer frozen)
  lastMorningPainDate?: string;   // ISO date string of last morning pain check
  injuryState?: import('./injury').InjuryState; // Active injury state

  // Continuous (non-event) training
  continuousMode?: boolean;       // True for non-event users — plan loops instead of completing
  blockNumber?: number;           // Current 4-week block number (1-based)
  benchmarkResults?: BenchmarkResult[]; // History of optional benchmark check-ins

  // Long race plan structure (>16 weeks)
  racePhaseStart?: number;        // 1-indexed week where race-specific training begins (last 16 weeks)

  // Recovery tracking
  recoveryHistory?: import('../recovery/engine').RecoveryEntry[];
  lastRecoveryPromptDate?: string;   // ISO date — one-prompt-per-day guard
}

/** Workout parsing result */
export interface ParsedWorkout {
  totalDistance: number;   // Total distance in meters
  workTime: number;        // Work time in seconds
  totalTime: number;       // Total time including rest
  avgPace: number | null;  // Average pace in sec/km
  paceZone: string | null; // Primary pace zone
  format: string;          // Detected format
}
