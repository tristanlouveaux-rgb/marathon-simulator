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
import type { EventType, TriConfig, Discipline } from './triathlon';

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
  /** Triathlon discipline the workout belongs to. Undefined = running (default for back-compat). */
  discipline?: Discipline;
  /** Brick workouts carry two ordered segments (bike → run typically). Only set when t === 'brick'. */
  brickSegments?: import('./triathlon').BrickSegments['segments'];
  rpe?: number;                 // Expected RPE (alternative to r)
  dayOfWeek?: number;           // Day of week (0=Mon, 6=Sun)
  dayName?: string;             // Day name
  aerobic?: number;             // Aerobic load
  anaerobic?: number;           // Anaerobic load
  skipped?: boolean;            // Was this skipped from previous week
  skipCount?: number;           // Number of times skipped
  originalName?: string;        // Original name if renamed
  status?: 'planned' | 'reduced' | 'replaced' | 'skipped' | 'completed';
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
  /** Canonical session duration in minutes. Set by the plan engine at
   * generation time so downstream code (scheduler capacity, card chips,
   * detail modal) doesn't have to parse the description string. */
  estimatedDurationMin?: number;
  /** Strava activity ID if this workout was paired via Strava enrich */
  stravaId?: string | null;
  /** iTRIMP from Strava HR stream (set on Garmin-sourced adhoc workouts after Strava enrich) */
  iTrimp?: number | null;
  /** Target pace in sec/km set when a session is generated with an effort selection. */
  targetPaceSecKm?: number;
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
  autoReduceNote?: string; // Set when mod was silently applied by Tier 1 auto-reduce
}

/** Simple cross-training record (old format) */
export interface SimpleCross {
  s: string;   // Sport name
  d: number;   // Duration in minutes
  ae: number;  // Aerobic effect
  an: number;  // Anaerobic effect
  l: number;   // Load
}

/** Single day of Garmin physiology data */
export interface PhysiologyDayEntry {
  date: string;           // YYYY-MM-DD
  restingHR?: number;
  maxHR?: number;
  hrvRmssd?: number;
  vo2max?: number;
  sleepScore?: number;
  sleepDurationSec?: number;  // total sleep in seconds (from Garmin)
  sleepDeepSec?: number;      // deep sleep in seconds
  sleepRemSec?: number;       // REM sleep in seconds
  sleepLightSec?: number;     // light sleep in seconds (direct from Garmin, preferred over derived)
  sleepAwakeSec?: number;     // awake time in seconds
  stressAvg?: number;
  steps?: number;              // total steps for this day (intra-day for today, full-day for past days)
  activeCalories?: number;     // active kcal from Garmin epochs (non-BMR energy expenditure)
  activeMinutes?: number;      // minutes in ACTIVE or HIGHLY_ACTIVE intensity (15-min epoch granularity)
  highlyActiveMinutes?: number; // minutes in HIGHLY_ACTIVE intensity only
  ltPace?: number;        // sec/km — from physiology_snapshots
  ltHR?: number;          // bpm at lactate threshold — from physiology_snapshots
}

/**
 * A Garmin cross-training activity awaiting user reduce/replace/keep decision.
 * Stored in wk.garminPending so it survives between syncs.
 * Processed sequentially by processPendingCrossTraining() in activitySync.ts.
 */
export interface GarminPendingItem {
  garminId: string;
  activityType: string;    // Raw Garmin type e.g. 'WALKING'
  appType: string;         // Mapped type: 'gym' | 'ride' | 'swim' | 'walk'
  startTime: string;       // ISO timestamp of when the activity occurred
  durationSec: number;
  distanceM: number | null;
  avgPaceSecKm?: number | null;  // Strava moving pace (sec/km) — null if not from Strava or not available
  avgHR: number | null;
  maxHR: number | null;
  aerobicEffect: number | null;   // Garmin Training Effect aerobic (0-5)
  anaerobicEffect: number | null; // Garmin Training Effect anaerobic (0-5)
  garminRpe: number | null;
  calories: number | null;
  iTrimp?: number | null;
  hrZones?: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
  polyline?: string | null;
  kmSplits?: number[] | null;
  /** Ride power fields (null on non-rides / rides without a power meter). */
  averageWatts?: number | null;
  normalizedPowerW?: number | null;  // Strava weighted_average_watts ≈ NP
  maxWatts?: number | null;
  deviceWatts?: boolean | null;       // true = real power meter, false = Strava estimate
  kilojoules?: number | null;
}

/** Actual data from a matched Garmin activity */
export interface GarminActual {
  garminId: string;
  /** ISO timestamp of when the activity started — used for date display */
  startTime?: string | null;
  distanceKm: number;
  durationSec: number;
  avgPaceSecKm: number | null;
  avgHR: number | null;
  maxHR: number | null;
  calories: number | null;
  aerobicEffect?: number | null;
  anaerobicEffect?: number | null;
  laps?: GarminLap[];
  /** Human-readable activity name (e.g. "Tennis", "HIIT") — set for gym/cross slot matches */
  displayName?: string;
  /** Human-readable matched slot name (e.g. "Easy Run", "Long Run") — set for run slot matches */
  workoutName?: string;
  /** iTRIMP computed from HR stream (null if insufficient HR data) */
  iTrimp?: number | null;
  /** Strava activity ID if this was enriched/matched via Strava (numeric as string) */
  stravaId?: string | null;
  /** Time (seconds) spent in each HR zone, computed from Strava HR stream */
  hrZones?: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
  /** Pace (sec/km) for each completed km — runs only */
  kmSplits?: number[] | null;
  /** Encoded polyline from Strava (Google polyline format) for map rendering */
  polyline?: string | null;
  /** Raw activity type from Garmin/Strava (e.g. 'RUNNING', 'CYCLING', 'WALKING').
   *  Used to distinguish runs from cross-training when plannedType is null. */
  activityType?: string | null;
  /** Plan workout type at the time of matching (e.g. 'easy', 'long', 'threshold', 'vo2').
   *  Used by iTRIMP intensity calibration. Null for non-run matches or pre-migration actuals. */
  plannedType?: string | null;
  /** HR effort score: how hard this was relative to target zone.
   *  0.8 = undercooked, 1.0 = nailed it, 1.2 = overcooked. Null if no HR data or no target zone. */
  hrEffortScore?: number | null;
  /** HR drift %: (avgHR_2nd_half - avgHR_1st_half) / avgHR_1st_half × 100.
   *  Only computed for steady-state runs > 20 min. Null otherwise. */
  hrDrift?: number | null;
  /** Ambient temperature in °C at start of activity (from Open-Meteo).
   *  Only fetched for outdoor DRIFT_TYPES runs with a start location. Used to
   *  heat-correct drift: driftAdjusted = drift - 0.15 * max(0, temp - 15). */
  ambientTempC?: number | null;
  /** Pace adherence: actual pace vs target pace ratio.
   *  1.0 = nailed it, <1.0 = ran faster than target, >1.0 = ran slower.
   *  Only computed for runs with both actual pace and a target pace from the plan. */
  paceAdherence?: number | null;
  /** Planned distance in km at the time of matching (from the workout description).
   *  Null if the workout description could not be parsed for a distance. */
  plannedDistanceKm?: number | null;
  /** Elevation gain in metres (from Strava total_elevation_gain). Null if unavailable. */
  elevationGainM?: number | null;
  /** User-set sport override. When present, supersedes activityType-derived sport for load/impact/leg-load
   *  calculations. Set via the "Change sport" control on the activity detail page. */
  manualSport?: import('./activities').SportKey;
  /** Ride power fields. Null on non-rides, on rides without a power meter,
   * and on rows persisted before the power columns landed. */
  averageWatts?: number | null;
  normalizedPowerW?: number | null;
  maxWatts?: number | null;
  deviceWatts?: boolean | null;
  kilojoules?: number | null;
  /** Best mean-max watts for fixed time windows, computed from the watts
   * stream during sync. Drives the FTP estimator (top-1 candidate ride
   * within 12 weeks). Null on non-rides, on rides without a real power
   * meter, and on rows that never received a stream fetch (older than 26
   * weeks or below the budget cutoff). Fields may be individually null
   * when the ride was shorter than that window. */
  powerCurve?: { p600: number | null; p1200: number | null; p1800: number | null; p3600: number | null } | null;
}

/** Per-lap split from Garmin activity details */
export interface GarminLap {
  index: number;
  distanceM: number;
  durationSec: number;
  avgPaceSecKm: number;
  avgHR?: number;
}

/** Unspent load item — excess load from overflow/surplus activities */
export interface UnspentLoadItem {
  garminId: string;
  displayName: string;        // e.g. "Tennis", "HIIT", "Run +5.2km surplus"
  sport: string;              // normalised sport label
  durationMin: number;
  aerobic: number;
  anaerobic: number;
  date: string;               // ISO date string
  reason: 'overflow' | 'surplus_run' | 'unmatched';
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
  unspentLoadItems?: UnspentLoadItem[]; // Individual items making up unspentLoad
  extraRunLoad: number;                 // Extra run load (kept for backward compat)
  actualTSS?: number;                   // Training Stress Score this week (TSS-calibrated, all activities)
  actualImpactLoad?: number;            // Musculoskeletal leg/impact stress this week
  crossVDOTBonus?: number;              // Bonus from cross-training
  crossTrainingBonus?: number;          // Display bonus
  crossTrainingSummary?: CrossTrainingSummary; // Detailed cross-training summary
  injuryState?: import('./injury').InjuryState; // Injury state for this week
  adhocWorkouts?: Workout[];                    // Ad-hoc workouts (e.g. "Just Run")
  gpsRecordings?: Record<string, string>;          // workoutId → GpsRecording.id
  garminMatched?: Record<string, string>;                         // garmin_id → workoutId | '__pending__' (prevents re-matching)
  garminActuals?: Record<string, GarminActual>;                  // workoutId → actual data from Garmin
  garminPending?: GarminPendingItem[];                           // All Garmin activities queued for review (kept after processing for re-review)
  garminReviewChoices?: Record<string, 'integrate' | 'log'>;    // Last user choice per garmin_id (for re-review pre-population)
  injuryCheckedIn?: boolean;                    // Whether injury was updated this week
  passedCapacityTests?: string[];               // Capacity tests passed this week
  completedKm?: number;                         // Total km completed this week (stored on week advance)
  effortScore?: number;                          // Average (actual RPE - expected RPE) for rated run workouts (legacy blended)
  rpeEffort?: number;                            // Pure RPE deviation: avg(rating - expected) across rated runs
  hrEffort?: number;                             // Average hrEffortScore from Strava HR data (1.0 = on target)
  weekAdjustmentReason?: string;                // Why this week was lightened (ACWR-driven; shown in banner)
  scheduledAcwrStatus?: 'safe' | 'caution' | 'high' | 'unknown'; // ACWR status at week-advance time — passed to generator
  carriedTSS?: { base: number; threshold: number; intensity: number }; // Excess TSS by zone (actual > plan), decays via CTL
  acwrOverridden?: boolean;                     // User dismissed "Reduce this week" — adds synthetic ATL debt
  recoveryDebt?: 'orange' | 'red';             // Set when recovery check-in fires a warning this week
  hasCarriedLoad?: boolean;                     // Set when unresolved excess load was carried in from the previous week
  carryOverCardDismissed?: boolean;             // User dismissed the carry-over card for this week
  kmNudge?: { floorKm: number; hasReductions: boolean; }; // Under-load nudge: signal to show km-floor card in plan view
  kmNudgeDismissed?: boolean;                   // User dismissed the km nudge for this week
  ltAutoUpdate?: {
    week: number;
    newLT: number;
    previousLT: number | null;
    source: string;
    confidence: string;
  };

  /**
   * Triathlon-only: per-week generated workouts (swim/bike/run/brick/gym).
   * Running mode regenerates workouts on the fly from VDOT + phase, so running
   * weeks leave this undefined. Triathlon generation is stateful — the plan
   * engine runs once at initialisation and we store the results here so views
   * can read them without re-deriving from triConfig on every render.
   * Set by `plan_engine.triathlon.ts:generateTriathlonPlan`.
   */
  triWorkouts?: Workout[];
}

/** State schema version for migrations */
export const STATE_SCHEMA_VERSION = 4;

/** Version where runner type semantics were fixed (Speed↔Endurance swap) */
export const RUNNER_TYPE_SEMANTICS_FIX_VERSION = 2;

/** Version where triathlon fields (eventType, triConfig, Workout.discipline) were introduced.
 * State at this version or higher is guaranteed to have `eventType` set
 * (defaults to 'running' for existing users during migration). */
export const TRIATHLON_FIELDS_VERSION = 3;

/** Version where `s.vo2` and `physiologyHistory[].vo2max` became running-specific only.
 * Pre-v4 these fields could carry `daily_metrics.vo2max` values, which include
 * Garmin's generic cardio estimate and can be cycling-derived. Migration clears
 * any persisted `s.vo2` so the next physiology sync repopulates it strictly from
 * `physiology_snapshots.vo2_max_running` (or leaves it null, falling back to
 * estimated VDOT). */
export const VO2_DEVICE_ONLY_VERSION = 4;

/** Main simulator state */
export interface SimulatorState {
  // Schema version (for migrations)
  schemaVersion?: number;

  /**
   * What this user is training for. Undefined/absent = running (back-compat
   * with all state written before triathlon mode landed). When this is
   * 'triathlon', `triConfig` is expected to be populated and the plan engine
   * forks to `plan_engine.triathlon.ts`. See docs/TRIATHLON.md §5, §18.
   */
  eventType?: EventType;

  /** Triathlon-specific configuration. Present only when eventType === 'triathlon'. */
  triConfig?: TriConfig;

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
  gs?: number;            // Gym sessions per week (0-3)
  wkm: number;            // Weekly km

  // Personal records
  pbs: PBs;               // All-time PBs
  rec: RecentRun | null;  // Recent race/time trial

  // Physiology
  lt: number | null;      // Current LT pace (sec/km). Resolved via resolveLT() — override > Garmin (fresh) > derived.
  ltPace?: number | null; // LT pace alias
  ltHR?: number;          // LT heart rate (bpm) — resolved same as lt
  /** User-entered LT override. When present, wins over Garmin and derived values. */
  ltOverride?: {
    ltPaceSecKm: number;
    ltHR?: number;
    setAt: string;  // ISO timestamp
  };
  /** Pending LT suggestion when Garmin and our derived value disagree by >10s/km.
   *  UI surfaces this on the LT detail page so the user picks the source they trust. */
  ltSuggestion?: {
    garmin: { ltPaceSecKm: number; ltHR?: number | null; asOf: string };
    derived: { ltPaceSecKm: number; ltHR: number | null; provenance: string };
    detectedAt: string; // ISO
  };
  /** ISO date the active LT value was last recomputed (Garmin reading or derivation run). */
  ltUpdatedAt?: string;
  /** Source of the active s.lt value — drives the provenance caption. */
  ltSource?: 'override' | 'garmin' | 'blended' | 'daniels' | 'critical-speed' | 'empirical';
  /** Confidence label for the active s.lt value. */
  ltConfidence?: 'high' | 'medium' | 'low';
  /** Latest Garmin LT reading recorded by the sync (kept even when not active). */
  garminLT?: { ltPaceSecKm: number; ltHR?: number | null; asOf: string };
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
      source: 'watch' | 'manual' | 'test' | 'auto_lt';
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

  // Auth
  // True when the Supabase session is anonymous (auto-created on first launch).
  // Refreshed on every launch from session.user.is_anonymous — never persisted
  // beyond the current run. Drives the guest-account banner and the Account
  // view's "Save your account" affordance.
  isGuestAccount?: boolean;
  // User dismissed the one-time Home banner. The Account view section stays.
  guestBannerDismissed?: boolean;

  // Integrations
  stravaConnected?: boolean;
  wearable?: 'garmin' | 'apple' | 'strava';  // Legacy — use accessors in src/data/sources.ts
  connectedSources?: {
    activity?: 'strava' | 'garmin' | 'apple' | 'polar' | 'phone';
    physiology?: 'garmin' | 'apple' | 'whoop' | 'oura';
  };

  // Physiology / accuracy
  biologicalSex?: 'male' | 'female' | 'prefer_not_to_say';  // Used for iTRIMP β coefficient (unset → male default)
  bodyWeightKg?: number;  // Bodyweight in kg. FTP→W/kg, load refinements. Falls back to 75kg M / 62kg F when unset.

  // Plan start date (ISO YYYY-MM-DD) — anchor for all week date ranges
  planStartDate?: string;

  // Selected event (locked from onboarding)
  selectedMarathon?: Marathon;

  // Athlete tier (for ACWR thresholds and plan ramp rate)
  athleteTier?: 'beginner' | 'recreational' | 'trained' | 'performance' | 'high_volume';
  athleteTierOverride?: 'beginner' | 'recreational' | 'trained' | 'performance' | 'high_volume';

  // iTRIMP intensity thresholds — personalised from Strava labelled runs (Phase C2)
  // Defaults: easy < 70 TSS/hr, tempo 70–95 TSS/hr, vo2 > 95 TSS/hr
  intensityThresholds?: {
    easy: number;              // TSS/hr upper bound for easy zone (default 70)
    tempo: number;             // TSS/hr upper bound for tempo/threshold (default 95)
    calibratedFrom?: number;   // Number of labelled sessions used for calibration
  };

  // Phase C — Strava history (populated by fetchStravaHistory() / history mode edge fn)
  // Blended race-time prediction cache — refreshed at onboarding + weekly rollover.
  // Computed by refreshBlendedFitness() from wizard data + per-run history (Tanda).
  // Consumers (stats view, plan engine) read this instead of re-blending on every render.
  blendedRaceTimeSec?: number;              // Predicted time for s.rd at current fitness
  blendedEffectiveVdot?: number;            // VDOT back-solved from blended prediction, for pace derivation
  blendedLastRefreshedISO?: string;         // When the cache was last recomputed
  // HR-calibrated VDOT — Swain regression of pace on %VO2R across recent runs.
  // Cached so the onboarding review screen can describe the method + confidence
  // without re-running the regression. See effort-calibrated-vdot.ts.
  hrCalibratedVdot?: {
    vdot: number | null;
    confidence: 'high' | 'medium' | 'low' | 'none';
    n: number;
    r2: number | null;
    reason?: 'no-rhr' | 'no-maxhr' | 'no-points' | 'bad-fit' | 'too-few-points';
    alpha?: number | null;
    beta?: number | null;
    points?: Array<{ vo2r: number; paceSecKm: number; durationSec: number }>;
  };

  // Per-run summary cached at onboarding so the first blend has Tanda inputs
  // without waiting a week for standalone sync to fill garminActuals.
  // The rich quality fields (avgPaceSecKm, kmSplits, hrDrift, elevation, temp)
  // are optional — populated when we can seed from the DB (post-backfill, via
  // `loadActivitiesFromDB`), absent when seeded only from the edge function's
  // lightweight `result.runs` summary. The empirical LT path treats absent
  // fields as "filter does not apply", so coarsely-seeded entries still feed
  // duration + HR-band gates while richer seeds also gate on decoupling/CV.
  onboardingRunHistory?: Array<{
    startTime: string;
    distKm: number;
    durSec: number;
    activityType: string;
    activityName?: string;
    avgHR?: number | null;
    avgPaceSecKm?: number | null;
    hrDrift?: number | null;
    kmSplits?: number[] | null;
    elevationGainM?: number | null;
    ambientTempC?: number | null;
  }>;

  /** ISO timestamp of the user's earliest Strava activity, fetched once on first
   * triathlon prediction. Drives years-of-training → experience-level mapping in
   * the horizon adjuster (Joyner & Coyle 2008 — durability scales with years
   * beyond what CTL captures). Null if Strava is not connected or fetch failed. */
  firstStravaActivityISO?: string | null;
  stravaHistoryFetched?: boolean;           // True once history has been loaded at least once
  stravaHistoryAccepted?: boolean;          // True when user clicked "Use this" in the history summary wizard step
  ambientTempHealDone?: boolean;            // True once the post-column backfill heal has fetched ambient_temp_c for historical runs
  /** ISO timestamp of the most recent successful backfillStravaHistory completion.
   * Drives the weekly refresh of historicWeeklyTSS / signalBBaseline / ctlBaseline:
   * if older than 7 days, startup re-runs backfill so the baselines track recent
   * training instead of freezing at first-sync values. */
  historicLastRefreshedAt?: string;
  /** ISO timestamp of the most recent successful DB-duplicate cleanup pass. Triggers
   * a re-scan after ~30 days. Cleared when a re-scan should fire on next launch. */
  dbDedupCompletedAt?: string;
  historicWeeklyTSS?: number[];             // Signal A: running-equiv TSS per week, oldest first (8 weeks)
  historicWeeklyRawTSS?: number[];          // Signal B: raw physiological TSS per week, oldest first (no runSpec discount)
  historicWeeklyKm?: number[];              // Running km per week, oldest first (8 weeks)
  historicWeeklyZones?: { base: number; threshold: number; intensity: number }[];  // Zone breakdown per week
  ctlBaseline?: number;                     // Signal A CTL — 42-day EMA of run-equiv load; seeds fitness model
  tssPerActiveMinute?: number;              // Personal TSS per active minute, calibrated from logged activities
  signalBBaseline?: number;                 // Signal B baseline — 8-week EMA of raw physiological TSS; used for excess load thresholds
  sportBaselineByType?: Record<string, {    // Per-sport session averages from history (Phase 2 calibration)
    avgSessionRawTSS: number;               //   avg raw TSS per session
    sessionsPerWeek: number;                //   avg sessions per week in the history window
  }>;
  detectedWeeklyKm?: number;               // Average weekly running km from history (for plan starting volume)
  extendedHistoryWeeks?: number;            // How many weeks are loaded in extended view (16 or 52)
  extendedHistoryTSS?: number[];
  extendedHistoryKm?: number[];
  extendedHistoryZones?: { base: number; threshold: number; intensity: number }[];

  // Injury recovery tracking
  rehabWeeksDone?: number;        // Weeks completed during injury (plan pointer frozen)
  lastMorningPainDate?: string;   // ISO date string of last morning pain check
  injuryState?: import('./injury').InjuryState; // Active injury state

  // Illness tracking
  illnessState?: {
    startDate: string;              // ISO date when illness was reported
    severity: 'light' | 'resting'; // light = still running reduced; resting = full rest
    active: boolean;                // false once user marks recovered
  };

  // Holiday tracking
  holidayState?: {
    startDate: string;              // ISO YYYY-MM-DD
    endDate: string;                // ISO YYYY-MM-DD
    canRun: 'yes' | 'maybe' | 'no';
    holidayType: 'relaxation' | 'active' | 'working';
    active: boolean;
    preHolidayShifts?: Record<string, number>;  // workoutId → new dayOfWeek
    welcomeBackShown?: boolean;
    preHolidayWeeklyTSS?: number;   // snapshot for rebuild calibration
  };
  holidayHistory?: Array<{
    startDate: string;
    endDate: string;
    holidayType: 'relaxation' | 'active' | 'working';
    actualTSSRatio?: number;
  }>;

  // Just-Track mode — activity tracking only, no plan generated.
  // Mirrors s.onboarding.trackOnly so views can branch without reading onboarding.
  // When true: s.wks is []; s.w is 0; today-workout / plan widgets are hidden.
  // Strava/Garmin/Apple sync, physiology sync, activity matching still run normally.
  trackOnly?: boolean;

  // Continuous (non-event) training
  continuousMode?: boolean;       // True for non-event users — plan loops instead of completing
  blockNumber?: number;           // Current 4-week block number (1-based)
  benchmarkResults?: BenchmarkResult[]; // History of optional benchmark check-ins

  // Long race plan structure (>16 weeks)
  racePhaseStart?: number;        // 1-indexed week where race-specific training begins (last 16 weeks)

  // Recovery tracking
  recoveryHistory?: import('../recovery/engine').RecoveryEntry[];
  lastRecoveryPromptDate?: string;   // ISO date — one-prompt-per-day guard

  // Garmin physiology history (last 7 days from daily_metrics)
  physiologyHistory?: PhysiologyDayEntry[];

  // Leg load history — recent cross-training entries used to compute decayed leg fatigue signal
  recentLegLoads?: Array<{ load: number; sport: string; sportLabel: string; timestampMs: number; garminId?: string; rbeProtected?: boolean }>;

  // Persistent mapping from normalized activity name → user-chosen sport. When an activity with
  // the same name is synced in future, it auto-applies the mapped sport. Populated when user
  // reclassifies an activity via the sport picker.
  sportNameMappings?: Record<string, import('./activities').SportKey>;

  // Activities the user has explicitly discarded. Future syncs (Strava + Garmin) skip these IDs
  // so a backfill duplicate that was deleted does not re-import. Stores the raw garminId
  // (numeric for Garmin, "strava-{id}" for Strava).
  ignoredGarminIds?: string[];

  // LT auto-estimation state
  ltEstimation?: import('../calculations/lt-estimator').LTEstimationState;

  // VDOT history — appended whenever VDOT changes, capped at last 20 entries
  vdotHistory?: Array<{ week: number; vdot: number; date?: string }>;

  // Display preferences
  unitPref?: 'km' | 'mi';   // Distance unit preference (default 'km')

  // Guided runs — phone-driven coaching during a tracked run
  guidedRunsEnabled?: boolean;        // Master on/off (default off until user opts in)
  guidedSplitAnnouncements?: boolean; // Per-km voice splits (default true; off if Strava/Garmin already doing it)
  guidedVoiceRate?: number;           // Speech rate multiplier, 0.8–1.4, default 1.0
  guidedKeepScreenOn?: boolean;       // Keep screen on during guided runs (Screen Wake Lock). Default true; web-only interim until Capacitor KeepAwake.

  // Sleep target — user-set override in seconds; if absent, derived from 75th percentile of last 30 nights
  sleepTargetSec?: number;

  // Today's subjective feeling — one-tap daily check-in from the Coach sub-page.
  // Expires at end of day (check `date === todayISO()` before reading).
  todayFeeling?: { value: 'struggling' | 'ok' | 'good' | 'great'; date: string } | null;

  // Completed plan history — appended when the user finishes the plan-complete debrief.
  completedPlans?: CompletedPlanSummary[];

  // Archived weeks from prior plans. Captured by `initializeSimulator` whenever
  // `s.wks` is replaced with a fresh plan, so daily activity history (garminActuals,
  // adhocWorkouts, ratings) survives plan resets. Read by rolling-load, coach,
  // freshness, and stats views as an historic data source independent of the
  // current plan's date range. Capped to keep state size bounded.
  previousPlanWks?: Array<{
    planStartDate: string;       // ISO date for week 1 of that plan
    weeks: any[];                // Week[] — typed loosely to avoid forward-ref churn
    archivedAt: string;          // ISO date when archived
  }>;

  /**
   * Timestamp of the last successful auto-restore from `garmin_activities`.
   * `main.ts` boot sequence checks this and re-runs the restore if older than
   * 24h, so a long-term user who clears localStorage (or whose state ever gets
   * partially wiped) self-heals on the next launch — Strava's table is the
   * source of truth, local `previousPlanWks` is a hot cache.
   */
  lastHistoryAutoRestoreISO?: string;
}

/** Summary of a completed training plan, stored permanently for plan-history view in Stats. */
export interface CompletedPlanSummary {
  completionDate: string;       // ISO date (YYYY-MM-DD)
  planStartDate: string;
  totalWeeks: number;
  raceDistance: string;
  raceName?: string;
  totalActualKm: number;
  peakWeekKm: number;
  adherencePct: number | null;
  vdotStart: number;
  vdotEnd: number;
  predictedTimeSec?: number;
  weeklyKm: number[];
  weeklyPhases: string[];
  // Granular stats — preserved so "Total" tab can show all-time aggregates
  totalRuns?: number;
  longestRunKm?: number;
  totalTimeSec?: number;
  totalCalories?: number;
  fastest5kSec?: number;
  fastest10kSec?: number;
  fastestHalfSec?: number;
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
