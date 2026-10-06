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
import type { EventType, TriConfig, Discipline, HyroxConfig } from './triathlon';
import type { StrengthLog, BodyweightProgressEntry } from './strength-log';

/** Cross-modal VO2max estimate confidence tier. Mirrors `hrCalibratedVdot.confidence`. */
export type VO2Confidence = 'high' | 'medium' | 'low' | 'none';

/** A single per-discipline VO2max estimate. */
export interface VO2Estimate {
  /** Estimated VO2max in ml/kg/min. Null when no usable data. */
  value: number | null;
  /** Confidence in this value. */
  confidence: VO2Confidence;
  /** Which estimator produced the value. */
  source:
    | 'effort-calibrated'   // Running pace–%VO2R regression (Daniels via cv())
    | 'acsm-ftp'            // Cycling 10.8 × W/kg + 7
    | 'uth-sorensen'        // 15.3 × HRmax/HRrest across all aerobic activity
    | 'sustained-hr-cross-training'  // Swain %HRR × cardiac ceiling × duration credit
    | 'none';
  /** Number of points / activities feeding the estimate. */
  n: number;
  /** Short human caption. */
  detail?: string;
}

/** Benchmark check-in types (4-tier system) */
export type BenchmarkType =
  | 'easy_checkin'       // 30 min easy–steady, track pace at same effort
  | 'threshold_check'    // 20 min "comfortably hard". Proxy for LT
  | 'speed_check'        // 12-min Cooper test or 3km TT. VO2/speed signal
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
  /** Default backpack mass carried on commute runs, in kg. Used by the load-carriage
   *  adjustment in the fitness model (Phase 3). 0 or undefined = no pack. */
  backpackKg?: number;
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
  /** Triathlon or HYROX discipline the workout belongs to.
   *  Undefined = running (default for back-compat).
   *  'station' and 'brick' are HYROX-only values. */
  discipline?: Discipline | 'station' | 'brick';
  /** Brick workouts carry two ordered segments (bike → run typically). Only set when t === 'brick'. */
  brickSegments?: import('./triathlon').BrickSegments['segments'];
  rpe?: number;                 // Expected RPE (alternative to r)
  dayOfWeek?: number;           // Day of week (0=Mon, 6=Sun)
  dayName?: string;             // Day name
  aerobic?: number;             // Aerobic load
  anaerobic?: number;           // Anaerobic load
  skipped?: boolean;            // Was this skipped from previous week
  skipCount?: number;           // Number of times skipped
  pushCount?: number;           // Times the lineage has been pushed to a later week (carried across clones; gates second-push)
  originalName?: string;        // Original name if renamed
  status?: 'planned' | 'reduced' | 'replaced' | 'skipped' | 'completed';
  modReason?: string;           // Modification reason
  confidence?: 'high' | 'medium' | 'low';
  originalDistance?: string;    // Original distance before modification
  autoCompleted?: boolean;      // Auto-completed by cross-training
  completedBySport?: string;    // Sport that completed this workout
  hrTarget?: {                   // Heart rate target (conditional. Only if HR data available)
    zone: string;
    min: number;
    max: number;
    label: string;
  };
  commute?: boolean;             // This is a commute run
  /** Set by the generator on the workout that fills the week's long-run slot,
   *  for every long-run variant (steady `t:'long'` and the fast-finish
   *  `t:'progressive'`). Read it only through `isLongRun()` (workouts/long-run.ts),
   *  which also honours a plain `t:'long'`. Undefined = not the long-run slot. */
  longRun?: boolean;
  testType?: string; // For physio capacity tests
  /** Canonical session duration in minutes. Set by the plan engine at
   * generation time so downstream code (scheduler capacity, card chips,
   * detail modal) doesn't have to parse the description string. */
  estimatedDurationMin?: number;
  /** Original (plan) session minutes before a user scale. Carried so the Adjust
   *  overlay can anchor its slider to the plan, and reopen at the right position. */
  originalDurationMin?: number;
  /** Chosen intensity rung for a user-scaled bike/swim session (a key from
   *  BIKE_INTENSITY_LADDER / SWIM_INTENSITY_LADDER, e.g. 'bike_tempo'). Set by the
   *  per-session Adjust "Harder/Easier" control on object-mode (tri/cycling/HYROX)
   *  sessions; the target watts/pace are derived live from FTP/CSS at this rung. */
  intensityLevel?: string;
  /** Generation-time intensityLevel before the first user rung change (null =
   *  "had none"). Anchors description retargeting on re-adjusts and lets Reset
   *  restore a generation-stamped rung instead of clearing it. */
  originalIntensityLevel?: string | null;
  /** Garmin/Strava activity ID matched to this workout. Populated by the tri matcher so
   *  the effort multiplier can read powerAdherence from the matched actual. */
  matchedActivityId?: string;
  /** Strava activity ID if this workout was paired via Strava enrich */
  stravaId?: string | null;
  /** iTRIMP from Strava HR stream (set on Garmin-sourced adhoc workouts after Strava enrich) */
  iTrimp?: number | null;
  /** Target pace in sec/km set when a session is generated with an effort selection. */
  targetPaceSecKm?: number;
  /** HYROX mode: MusculoTendon Load for this session. Sum of component MTLs
   *  (run segments + station components). Undefined for non-HYROX workouts. */
  musculoTendonLoad?: number;
  /** HYROX mode: component breakdown for brick and station sessions.
   *  Used by plan-view workout cards and the detail modal. */
  hyroxComponents?: import('./triathlon').HyroxComponent[];
  /** HYROX mode: prescribed number of rounds through the component circuit.
   *  The detail modal renders "N rounds" and the guided parser expands the
   *  component list by this factor. Absent defaults to 1 round. */
  hyroxRounds?: number;
  /** HYROX mode: prescribed rest in seconds BETWEEN rounds (inter-round rest),
   *  distinct from per-component inter-station rest. Absent = 0. */
  hyroxRoundRestSec?: number;
  /** HYROX mode: per-station substitution picks when the user lacks equipment.
   *  Keyed by HyroxStation id, value is the substitution id from
   *  `HYROX_STATION_SUBSTITUTIONS`. Display layer overlays the substitute name.
   *  Component MTL is recomputed from the substitution's mtlFactor. */
  hyroxStationSubs?: Record<string, string>;
  /** HYROX mode: snapshot of the original component MTL values before any swaps,
   *  keyed by HyroxStation. Used to revert correctly when a swap is undone. */
  hyroxOriginalMtls?: Record<string, number>;
  /** ISO timestamp set when the AI coach mutated this workout via an Apply card.
   *  Used by the plan-view card to render a "Coach" badge. Distinct from
   *  modReason so we can tell AI-driven mods apart from engine auto-reductions. */
  aiModifiedAt?: string;
  /** Heart-rate zone cap set by the AI coach's `adjust_intensity` tool. The
   *  workout card displays "Z2 cap" / "Z3 cap" chip when this is set. The plan
   *  engine doesn't enforce the cap directly. RPE is downgraded server-side
   *  by setting `rpe`. This field is the visible signal and the coach's
   *  memory of its own past cap calls. */
  zoneCap?: 2 | 3;
  /** Snapshot of pre-mod fields so an Undo can restore the workout cleanly.
   *  Set on the first AI mod; subsequent mods do not overwrite it. */
  aiPreModSnapshot?: { n: string; d: string; t: string; aerobic?: number; anaerobic?: number; estimatedDurationMin?: number; status?: Workout['status'] };
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
  /** Stable slot id (`W{week}-{type}-{idx}` from the generator) the mod targets.
   *  Preferred match key for user-scale mods: running workouts are regenerated
   *  every render and `assignDefaultDays` reshuffles `dayOfWeek` whenever the week
   *  set changes, so matching by (name, dayOfWeek) loses the mod and the change
   *  reverts. The id survives day reshuffling. Optional for back-compat with mods
   *  written before this field existed (they fall back to name+day matching). */
  workoutId?: string;
  status: string;
  modReason: string;
  confidence?: string;
  originalDistance?: string;
  newDistance: string;
  newType?: string;    // New workout type if downgraded (e.g., 'easy')
  newRpe?: number;     // New RPE to match downgraded type
  autoReduceNote?: string; // Set when mod was silently applied by Tier 1 auto-reduce
  /** yyyy-mm-dd the mod was applied. Stamped by the ACWR reduction flow so
   *  `undoACWRReduction` can remove exactly that day's mods and nothing else. */
  appliedAt?: string;
  /** ISO timestamp when the AI coach created this mod. Used to render a
   *  "Coach" badge in the plan view. */
  aiModifiedAt?: string;
  /** ISO timestamp when the user manually scaled this workout via the per-card
   *  "Adjust" control (workout-scaling.ts). Distinct from `aiModifiedAt` so the
   *  card shows an "Adjusted" chip (not "Coach") and the reset path targets only
   *  user mods. The mod still uses the standard newDistance/newType/newRpe fields. */
  userScaledAt?: string;
  /** Scaled session duration in minutes, carried so the duration chip and weekly
   *  total stay honest after a user duration scale (the generator otherwise
   *  re-derives full-length estimatedDurationMin each render). */
  newDurationMin?: number;
  /** Original (plan) session minutes, the reference the user-scale slider anchors
   *  to. Applied back onto the workout so a reopened Adjust overlay scales from
   *  the plan, not from the already-scaled state. */
  originalDurationMin?: number;
  /** When the AI capped intensity (adjust_intensity), this is the zone cap. */
  zoneCap?: 2 | 3;
}

/** Simple cross-training record (old format) */
export interface SimpleCross {
  s: string;   // Sport name
  d: number;   // Duration in minutes
  ae: number;  // Aerobic effect
  an: number;  // Anaerobic effect
  l: number;   // Load
}

/**
 * Per-session record used to fit the user's personal recovery rate (`k_user`).
 *
 * Created when a workout is completed (live) or reconstructed from history
 * (one-shot backfill on first launch). `observedHours` is filled in once the
 * user's HRV/RHR composite z-score returns to baseline. Or capped at 96h
 * (right-censored). The fitter aggregates `observed/predicted` ratios across
 * recent entries to update `s.adaptiveRecovery.kUserHours`.
 *
 * See `src/calculations/adaptive-recovery.ts` for the fitting logic and
 * `docs/SCIENCE_LOG.md` for the rationale.
 */
export interface SessionImpactEntry {
  garminId: string;                 // ties back to the matched activity
  date: string;                     // YYYY-MM-DD of the session
  tss: number;                      // run-equiv TSS at completion
  ctlAtTime: number;                // daily-equiv CTL at session time
  recoveryMultAtTime: number;       // sport/intensity multiplier used in countdown
  recoveryAdjAtTime: number;        // transient HRV/RHR/sleep adjustment used
  predictedHours: number;           // readiness-debt estimate (countdown model); not the fit basis
  /** Session intensity band (HR-zone or RPE derived). The fit compares observed
   *  recovery to the literature expectation for this band. See `classifySessionIntensity`. */
  intensityBand?: 'easy' | 'moderate' | 'hard';
  /** Literature-anchored expected HRV/RHR return time for the intensity band
   *  (Stanley et al. 2013). The fit basis: index = observedHours / expectedRecoveryHours. */
  expectedRecoveryHours?: number;
  observedHours?: number;           // hours until composite signal returned to baseline
  rightCensored?: boolean;          // true if observed hit the 96h cap without recovery
  signalsUsed: Array<'hrv' | 'rhr' | 'checkin' | 'rpe'>;
  rpeNextSession?: { expected: number; actual: number };
  source: 'live' | 'historical-backfill';
  fitWeight: number;                // 1.0 for live, 0.7 for historical
}

/**
 * Learned recovery personalisation. Tracks the user's `k_user` (the multiplier
 * that replaces the population constant of 8 in the recovery countdown) and the
 * confidence with which it has been fit.
 *
 * Confidence gating:
 *   - none/low (< 16 sessions):  population default; UI shows "learning"
 *   - medium  (16–29 sessions):  k_user used in recovery countdown only
 *   - high    (30+ sessions):    k_user used in countdown AND ACWR ceiling shift
 *
 * Updated weekly on rollover. See `fitKUser` in `adaptive-recovery.ts`.
 */
export interface AdaptiveRecovery {
  kUserHours: number;               // default 8 until learned; clamped [5, 13]. = 8 × recovery index
  confidence: 'none' | 'low' | 'medium' | 'high';
  sessionsObserved: number;         // count of clean-window observations used in the fit
  lastFitAt?: string;               // ISO date of last weekly fit
  emaHalfLifeWeeks: number;         // 4. Recency decay for the fit
  history?: Array<{ date: string; k: number; n: number }>; // sparkline (cap 12)
  notifiedMilestones?: string[];    // e.g. 'first-medium', 'first-high'
  /** True when the athlete trains too densely to read recovery cleanly: many
   *  closed sessions, but few survive the clean-window filter. The card explains
   *  this instead of showing a misleading value. */
  densityLimited?: boolean;
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
  ltPace?: number;        // sec/km. From physiology_snapshots
  ltHR?: number;          // bpm at lactate threshold. From physiology_snapshots
  respiratoryRate?: number; // breaths/min (sleeping/resting). Apple Health / Garmin-via-Apple-Health.
  spo2?: number;            // blood oxygen saturation, percent (0–100). Recovery / altitude / illness signal.
  /** Values the Apple Health physiology sync last wrote into this entry, by
   *  field. While Apple is a supplementary source (Garmin primary), a field
   *  whose current value still equals its value here came from Apple, so a
   *  newer Apple read may refresh it. A field whose value differs was written
   *  by the primary source and is kept. Garmin writers drop a field from here
   *  whenever they write it, even at the same value (releaseAppleOwnership in
   *  src/data/physiology-provenance.ts). Absent on entries Apple never wrote. */
  appleValues?: Partial<Record<ApplePhysiologyField, number>>;
}

/** PhysiologyDayEntry fields the Apple Health physiology sync can write. */
export type ApplePhysiologyField =
  | 'sleepScore' | 'sleepDurationSec' | 'sleepDeepSec' | 'sleepRemSec'
  | 'sleepLightSec' | 'sleepAwakeSec' | 'restingHR' | 'hrvRmssd' | 'steps'
  | 'respiratoryRate' | 'spo2';

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
  avgPaceSecKm?: number | null;  // Strava moving pace (sec/km). Null if not from Strava or not available
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
  repData?: ActivityRepData | null;
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
  /** Average HR (bpm) for each completed km, parallel-indexed to kmSplits.
   *  Runs only, populated when Strava's splits_metric or the HR stream had
   *  per-km HR data. Drives the per-km point input to the VO2 HR-calibrated
   *  regression. Within-run variation (e.g. a tempo finish on a long run)
   *  becomes multiple regression points instead of one diluted (avgPace,
   *  avgHR) point. Same indexing as kmSplits; readers should pair index-by-
   *  index and skip entries where either value is missing/zero. */
  kmHRSplits?: number[] | null;
  /** Encoded polyline from Strava (Google polyline format) for map rendering */
  polyline?: string | null;
  /** Raw activity type from Garmin/Strava (e.g. 'RUNNING', 'CYCLING', 'WALKING').
   *  Used to distinguish runs from cross-training when plannedType is null. */
  activityType?: string | null;
  /** Plan workout type at the time of matching (e.g. 'easy', 'long', 'threshold', 'vo2').
   *  Used by iTRIMP intensity calibration. Null for non-run matches or pre-migration actuals. */
  plannedType?: string | null;
  /** Muscle groups worked, ordered most-worked first (strength/gym sessions only).
   *  Derived at completion from the parsed exercise list. Drives the "Worked"
   *  chip summary on the post-session recap and the activity-log detail. */
  workedMuscleGroups?: string[];
  /** Per-lift breakdown logged at completion (strength/gym sessions only): what
   *  you hit and the weight. Stamped onto the activity so tapping a past gym
   *  session shows its weights, independent of the rolling per-lift memory. */
  loggedLifts?: Array<{
    exerciseName: string;
    weightKg?: number;
    reps: string;
    /** Working sets logged for this exercise. Optional — absent on sessions
     *  logged before set-count capture; tonnage readers treat absent as 1. */
    sets?: number;
    estimatedOneRmKg?: number;
    liftKey?: string;
  }>;
  /** Derived leg load (raw units, pre-decay/pre-RBE) for a strength/gym session,
   *  stamped at completion from the worked leg groups × %1RM × session RPE. Read
   *  by the leg-load ledger (`recentLegLoads`) so heavy leg days feed recovery the
   *  same way runs and cross-training do. Absent for non-strength activities and
   *  for synced strength sessions with no exercise detail. See strength-leg-load.ts. */
  legLoadRaw?: number;
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
  /** True when this activity's rich fields (HR zones, splits, route, iTRIMP) were
   *  added by the user uploading the original file from the activity detail page
   *  ("Add detail from Strava"). The `garminId` provenance prefix is preserved, so
   *  a later live Strava row for the same session still wins via the Strava-upgrade
   *  path. Used to flip the detail caption and to hide the enrich action once done. */
  enrichedFromFile?: boolean;
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
  /** Power adherence for bike workouts: adjusted actual NP vs FTP-derived target,
   *  with a per-session-type tolerance band applied (soft gradient within band).
   *  1.0 = on target. <1.0 = below target, >1.0 = above. Null when no power meter or no FTP target. */
  powerAdherence?: number | null;
  /** Per-rep interval analysis. Present on run/bike interval sessions where
   *  Strava laps or stream-detection produced a clean rep cluster. */
  repData?: ActivityRepData | null;
  /** Swim environment tag — drives CSS pace normalisation to a wetsuit-lake
   *  baseline so pool/lake/ocean swims pool into one CSS estimate consistently.
   *  Auto-tagged as `pool` for SWIMMING/LAP_SWIMMING activityType. For
   *  OPEN_WATER_SWIMMING the tag falls back to
   *  `triConfig.swim.defaultOwSwimEnvironment` (set once during onboarding).
   *  See `SWIM_TYPE_MULTIPLIER` in triathlon-course-factors.ts. */
  swimEnvironment?: import('../constants/triathlon-course-factors').AthleteSwimEnvironment;
  /** True when the user has tagged this activity as a commute run (to or
   *  from work). Drives matching toward Commute plan slots and is consumed
   *  by the load-carriage adjustment when paired with `backpackKg`. Auto-
   *  defaulted on by the matcher when an activity lands on a configured
   *  commute slot; user can confirm or untag via the activity-review chip. */
  commute?: boolean;
  /** Backpack mass (kg) carried on this commute run. Defaults to the user's
   *  `commuteConfig.backpackKg`; user can override on a per-activity basis
   *  via the activity-review numeric field. Undefined or 0 = no pack. */
  backpackKg?: number;
  /** User-set RPE (1–10) for this activity. Currently exposed on the activity-
   *  detail page for strength sessions, where HR-based TSS systematically
   *  under-counts neuromuscular load. When set on a strength activity, replaces
   *  the iTRIMP-derived TSS with `durationMin × TL_PER_MIN[rpe] × runSpec`. */
  rpe?: number;
  /** User-set leg-feel tag for strength sessions. Drives a leg-load entry that
   *  feeds the readiness leg-load floor and slows the leg-load decay half-life:
   *  `moderate` → 0.15 load/min, half-life ×1.05; `heavy` → 0.35 load/min,
   *  half-life ×1.20. `none` writes no entry. */
  legFeel?: 'none' | 'moderate' | 'heavy';
  /** HYROX guided-session recap, set when a guided station/brick session is
   *  logged from the in-app player. Lets the activity-detail page show the same
   *  per-station best rounds + run legs the finish screen showed. Preserved when
   *  a watch/Strava recording upgrades the guided actual. Guided actuals are
   *  identified by `garminId` starting with `'guided-'`. See SCIENCE_LOG §AP. */
  hyroxSession?: {
    rounds: number;
    stations: Array<{ station: import('./triathlon').HyroxStation; bestSec: number }>;
    runs: Array<{ round: number; durationSec: number; distanceM: number; paceSecKm: number }>;
  };
}

/** Per-lap split from Garmin activity details */
export interface GarminLap {
  index: number;
  distanceM: number;
  durationSec: number;
  avgPaceSecKm: number;
  avgHR?: number;
}

/** A single rep within a detected interval session (run or bike). */
export interface ActivityRep {
  /** 1-based index within the rep set (recovery/warmup laps excluded). */
  index: number;
  distanceM: number;
  durationSec: number;
  /** sec/km — null when distance was 0 (rare device glitches). */
  paceSecKm?: number | null;
  /** Average HR for the rep — null when no HR stream/lap data. */
  avgHR?: number | null;
  /** Average watts — bike only, null otherwise. */
  avgWatts?: number | null;
}

/**
 * Detected interval reps + per-rep adherence aggregate. Set on `GarminActual`
 * when the activity is recognised as a structured interval session and
 * detection found a clean rep cluster.
 */
export interface ActivityRepData {
  reps: ActivityRep[];
  /** Where the reps came from. 'strava-laps' = user pressed lap on watch.
   *  'auto-detected' = derived from pace/power stream. */
  source: 'strava-laps' | 'auto-detected';
  /** Aggregate score against the prescribed workout. Null when no plan
   *  target is parseable. Computed lazily on the client (not stored in DB). */
  score?: {
    /** Reps within the per-rep tolerance band. */
    inBand: number;
    /** Total reps that were attempted to match. */
    total: number;
    /** Fade %: (last-half avg − first-half avg) / first-half avg × 100.
     *  Positive = slowed/dropped power. Negative = negative split. */
    fadePct: number;
    /** Mean per-rep adherence (1.0 = on target). */
    avgAdherence: number;
    /** Prescribed-workout description that was parsed (for transparency). */
    parsedFrom?: string;
  };
}

/** Unspent load item — excess load from overflow/surplus activities */
export interface UnspentLoadItem {
  garminId: string;
  displayName: string;        // e.g. "Tennis", "HIIT", "Run +5.2km surplus"
  sport: string;              // normalised sport label
  durationMin: number;
  /** Garmin Training Effect (0–5 scale) — NOT TSS. Only consumed TE-aware
   *  (excess-load-card infers an RPE from it). Never sum with load fields
   *  (ISSUE-263: Workout.aerobic is canonical TSS; this field is not). */
  aerobic: number;
  /** Garmin Training Effect anaerobic (0–5 scale) — NOT TSS. See above. */
  anaerobic: number;
  date: string;               // ISO date string
  reason: 'overflow' | 'surplus_run' | 'unmatched';
}

/** Week data */
export interface Week {
  w: number;                            // Week number
  ph: TrainingPhase;                    // Training phase
  /** True for the time-trial week at the end of cycle 1 in double-periodization
   *  plans (≥33 weeks). Phase stays 'peak' so existing peak-phase logic applies;
   *  the workout generator and Phase Timeline read this flag to swap content
   *  and label. See src/workouts/phases.ts. */
  checkpoint?: boolean;
  rated: Record<string, number | 'skip'>; // Workout ratings
  ratedChanges?: Record<string, number>;  // VDOT changes from ratings
  skip: SkippedWorkout[];               // Skipped workouts to carry forward
  /** Race-time penalty (seconds) charged into `s.timp` per workout id when a
   *  session is skipped a second time, or auto-dropped at week advance. Recorded
   *  so an un-skip can refund EXACTLY what was charged (s.timp is otherwise a
   *  one-way accumulator). Optional: absent on weeks with no penalised skips. */
  skipPenalty?: Record<string, number>;
  cross: SimpleCross[];                 // Cross-training activities (old format)
  wkGain: number;                       // Week VDOT gain
  workoutMods: WorkoutMod[];            // Stored workout modifications
  workoutMoves?: Record<string, number>; // Manual workout day moves
  adjustments: CrossTrainingAdjustment[]; // Cross-training adjustments
  unspentLoad: number;                  // Unspent cross-training load
  unspentLoadItems?: UnspentLoadItem[]; // Individual items making up unspentLoad
  extraRunLoad: number;                 // Extra run load (kept for backward compat)
  // `actualTSS` is retired (audit B18): it was an add-only running total that
  // drifted from the activities. A week's actual load is derived on demand by
  // computeWeekActualTSS (fitness-model.ts). Legacy stored values are stripped
  // on load and never read.
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
  autoReviewShownDate?: string;                  // YYYY-MM-DD (local) the Match Activities screen last auto-opened this week — caps auto-open to once/day (manual "Review" always works)
  injuryCheckedIn?: boolean;                    // Whether injury was updated this week
  strengthNudgeSeen?: boolean;                  // Whether the injury-driven "add a strength session" nudge was offered this week (once-only guard)
  passedCapacityTests?: string[];               // Capacity tests passed this week
  completedKm?: number;                         // Total km completed this week (stored on week advance)
  effortScore?: number;                          // Average (actual RPE - expected RPE) for rated run workouts (legacy blended)
  rpeEffort?: number;                            // Pure RPE deviation: avg(rating - expected) across rated runs
  hrEffort?: number;                             // Average hrEffortScore from Strava HR data (1.0 = on target)
  weekAdjustmentReason?: string;                // Why this week was lightened (ACWR-driven; shown in banner)
  scheduledAcwrStatus?: 'safe' | 'caution' | 'high' | 'unknown'; // ACWR status at week-advance time. Passed to generator
  /** ACWR ratio (acute÷chronic) at week-advance time. Drives the very-high (≥1.6) escalation
   *  that re-raises the ease-back choice even after a prior 'keep'. Stamped with scheduledAcwrStatus. */
  scheduledAcwrRatio?: number;
  /** Chronic weekly TSS (acwr.ctl) at week-advance time — the L_max denominator for the ease-back
   *  ladder (ISSUE-295). Stamped with scheduledAcwrStatus, read by the generator + debrief preview. */
  scheduledChronicTSS?: number;
  /** Effective ACWR ceiling (tier safeUpper + recovery shift) at week-advance time. L_max = this × chronic. */
  scheduledSafeUpper?: number;
  /** The athlete's ease-back choice for a high-ACWR week (ISSUE-295). 'keep' = ramp on (plan intact);
   *  'ease'/unset = apply the intensity-first reduction ladder. Set from the week-debrief toggle. */
  acwrChoice?: 'ease' | 'keep';
  /** Load-gap re-anchor ratio (actual ÷ plan-expected load) of the PREVIOUS week, stamped on this
   *  week at rollover. < 1 re-anchors this week's prescribed volume down in proportion
   *  (plan_engine.ctlGapMultiplier). Single-scalar modes: RUNNING (combined CTL) and HYROX (MTL).
   *  Set in events.next(), read at generation. Stored, never recomputed at render. Mirror of
   *  scheduledAcwrStatus. (Triathlon uses the per-discipline `ctlRatioByDiscipline` instead.) */
  ctlRatio?: number;
  /** Triathlon per-discipline load-gap re-anchor: swim/bike/run ratios of the PREVIOUS week's
   *  completion, stamped at rollover. Only disciplines that fell behind (< 1) are present. Read by
   *  applyTriEffortMultipliers, which scales that discipline's upcoming durations down. */
  ctlRatioByDiscipline?: { swim?: number; bike?: number; run?: number };
  /** True when multi-week detraining (VDOT loss or the ≥3-week base downgrade) was applied to this
   *  week on launch. Suppresses the CTL-gap re-anchor for the week so the two re-anchoring paths
   *  don't double-count. Set in welcome-back.advanceWeekToToday. */
  detrainApplied?: boolean;
  carriedTSS?: { base: number; threshold: number; intensity: number }; // Excess TSS by zone (actual > plan), decays via CTL
  /** Triathlon-mode equivalent of `carriedTSS`: cross-training TSS pushed forward
   *  from this week to next via the tri suggestion modal's "Push to next week"
   *  button. Single number (cross-training stimulus isn't decomposed by zone).
   *  Decayed via 7-day ATL τ when read by `computeDecayedTriCarry` (Tier 2). */
  carriedCrossTrainingTSS?: number;
  acwrOverridden?: boolean;                     // User dismissed "Reduce this week". Adds synthetic ATL debt
  /** Undo snapshot for the most recent ACWR reduction (readiness "Reduce session
   *  load" flow). Set when the user confirms Replace/Reduce in the suggestion
   *  modal; lets the Home readiness card show "Session load reduced" with an
   *  Undo for the rest of that day. Undo removes the matching `appliedAt`-stamped
   *  ACWR workoutMods and restores the unspent items that were cleared. A second
   *  reduction overwrites the snapshot (undo targets the latest only). */
  acwrReductionUndo?: {
    date: string;                               // yyyy-mm-dd the reduction was applied
    sportLabel: string;                         // what drove it, for the undo caption
    unspentLoadItems?: UnspentLoadItem[];       // items cleared on apply, restored on undo
    unspentLoad?: number;
  };
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
   * weeks leave this undefined. Triathlon generation is stateful. The plan
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

/**
 * Single running race outcome. Predicted vs actual logged after a target race.
 * Mirrors `TriRaceLogEntry` for running mode. Idempotent on `dateISO`.
 */
export interface RunRaceLogEntry {
  /** ISO date the race ran (YYYY-MM-DD). */
  dateISO: string;
  /** Race distance at the time of the race. */
  distance: RaceDistance;
  /** Cached blended prediction at the moment the race was detected (seconds). */
  predictedTotalSec: number;
  /** Sum of actual race-day running activity duration in seconds. */
  actualTotalSec: number;
  /** Distance of the matched race-day run (km) — for context, not used in calibration. */
  actualDistanceKm?: number;
  /** `state.v` (VDOT) at log time — for retrospective accuracy analysis. */
  predictionVdotSnapshot?: number;
  /** Race name from `selectedMarathon`, if available. */
  raceName?: string;
}

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

  /** HYROX-specific configuration. Present only when eventType === 'hyrox'. */
  hyroxConfig?: HyroxConfig;

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
  strengthLog?: StrengthLog; // Per-lift working-weight memory + est1RM benchmark
  bodyweightProgress?: Record<string, BodyweightProgressEntry>; // Beginner/novice bodyweight ladder rung per movement family (src/calculations/bodyweight-progression.ts)
  /** Remembered exercise swaps for gym sessions (equipment substitutions), keyed
   *  by the original movement's swap-key -> { original display name, substitute
   *  pool-exercise name }. A swap auto-applies to every future session containing
   *  that movement, stays visible + re-editable in the pre-session modal, and is
   *  reviewable / revertible from Account. See strength-alternatives.ts. */
  strengthSwaps?: Record<string, { from: string; to: string }>;
  wkm: number;            // Weekly km

  // Personal records
  pbs: PBs;               // All-time PBs
  /** Tombstones for PBs the user explicitly deleted (per-distance, the deleted
   *  time in seconds). Suppresses passive resurrection: the cross-store
   *  `effectivePhysiologyPbs` merge and the Strava/Apple auto-fill must not
   *  re-introduce a deleted PB unless a genuinely faster time is observed.
   *  Cleared when the user explicitly re-enters a PB for that distance. See
   *  ISSUE-297 RC3. Optional so fresh installs need no migration. */
  deletedPbs?: Partial<Record<keyof PBs, number>>;
  startingFitnessEstimated?: boolean; // pbs is a conservative no-PB beginner/hybrid seed (see beginner-fitness.ts), not a real time — yields to real runs; label honestly in UI
  rec: RecentRun | null;  // Recent race/time trial

  // Physiology
  lt: number | null;      // Current LT pace (sec/km). Resolved via resolveLT(). Override > Garmin (fresh) > derived.
  ltPace?: number | null; // LT pace alias
  ltHR?: number;          // LT heart rate (bpm). Resolved same as lt
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
  /** ISO date (YYYY-MM-DD) when s.vo2 was last written by a sync path.
   *  Used by getPhysiologicalVdot's freshness gate so Garmin users whose
   *  daily_metrics.vo2max updates from cycling don't mask a stale running VO2. */
  vo2UpdatedAt?: string;
  /** Run VDOT derived from a real race run leg (triathlon 70.3/IM/etc.), already
   *  fatigue-discounted to a "fresh-run equivalent" via the published bike-to-run
   *  discounts. A real race is the strongest race-validated running signal, so
   *  `getPhysiologicalVdot` ranks this ABOVE the device (watch VO2max) tier when
   *  recent, and `refreshBlendedFitness` anchors `s.v` to it. The watch VO2max is
   *  inflated for triathletes (cycling/swimming build it too) and must yield to a
   *  recent race it contradicts. Seeded at onboarding (past race) and on race-outcome
   *  logging. `dateISO` may be YYYY-MM or YYYY-MM-DD. Optional (fresh-install safe). */
  raceRunVdot?: {
    vdot: number;
    dateISO: string;
    distance: string;
    source: 'onboarding-past-race' | 'logged-race';
  };
  /** Demonstrated bike speed (km/h) from a real race bike leg. A race split bakes
   *  in the athlete's true CdA, weight, position and fitness, so it anchors the
   *  bike-leg projection far better than a generic FTP→speed model (which left a
   *  36 km/h 70.3 rider projected at 27 km/h for the Ironman). `raceDistance` gives
   *  the intensity factor the leg was ridden at, so the projection scales to the
   *  target leg's intensity (speed ∝ power^⅓) or reverse-solves a personal CdA when
   *  weights are known. Seeded at onboarding (past race) and on race-outcome
   *  logging; recency-gated at read. Optional (fresh-install safe). */
  raceBikeKph?: {
    kph: number;
    raceDistance: import('./triathlon').TriathlonDistance;
    dateISO: string;
    source: 'onboarding-past-race' | 'logged-race';
  };
  initialLT: number | null;   // Initial LT at week 0
  initialVO2: number | null;  // Initial VO2 at week 0
  maxHR?: number;             // Maximum Heart Rate
  restingHR?: number;         // Resting Heart Rate

  // Race time tracking
  initialBaseline: number | null;   // Initial race time PREDICTION at plan generation (NOT a user-set goal. See raceGoalTimeSec)
  currentFitness: number | null;    // Current race time estimate
  forecastTime: number | null;      // Forecast race time after training (raw VDOT)
  /** User-set race-day goal (seconds). Null/undefined = no goal set. Only when this
   *  is populated do we render the "Goal" reference line + "Chance of beating goal"
   *  callout. Distinct from `initialBaseline` (the model's initial prediction). */
  raceGoalTimeSec?: number;
  /** Forecast race time after applying course factors (climate/altitude/elevation).
   * Populated only when `selectedMarathon.profile` exists. Falls back to `forecastTime`. */
  forecastTimeAdjusted?: number;
  /** Race-day footwear. 'supershoes' = carbon-plated racing flats (Vaporfly,
   *  Alphafly, Adios Pro, etc.) which deliver ~3% running-economy gains
   *  (Hoogkamer 2018; Barnes & Kilding 2019). 'standard' = traditional racing
   *  shoes with no plate / lower-bounce midsole. Undefined treated as
   *  'standard' so existing users default to no boost.
   *  Applied as a 3% pace boost on `forecastTime` and `forecastTimeAdjusted`. */
  shoeKind?: 'standard' | 'supershoes';
  /** Itemised course factors backing `forecastTimeAdjusted` for UI display. */
  forecastCourseFactors?: Array<{
    kind: 'climate' | 'altitude' | 'run-elevation' | 'wind' | 'heat-acclim';
    label: string;
    value: string;
    deltaSec: number;
    multiplier: number;
  }>;

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
  // Refreshed on every launch from session.user.is_anonymous. Never persisted
  // beyond the current run. Drives the guest-account banner and the Account
  // view's "Save your account" affordance.
  isGuestAccount?: boolean;
  // User dismissed the one-time Home banner. The Account view section stays.
  guestBannerDismissed?: boolean;
  // Existing anonymous (guest) users are shown a one-time launch modal after the
  // account-required migration (2026-07-26): "accounts are now required, save
  // your history". Set when that modal is created so it never re-pops. New users
  // never see it (they create an account up front). See account-required-notice.ts.
  accountRequiredNoticeSeen?: boolean;
  // User dismissed the "add HR + splits from Strava" enrich-prompt Home banner.
  // Shown to non-Strava-connected users whose activities synced thin through
  // Apple Health. The Account > Strava History affordance stays regardless.
  enrichPromptDismissed?: boolean;

  // User dismissed (or accepted) the build-phase Vibes Run nudge for the current plan.
  // Reset implicitly when state is reset (new plan).
  vibesRunNudgeDismissed?: boolean;

  // Integrations
  stravaConnected?: boolean;
  wearable?: 'garmin' | 'apple' | 'strava';  // Legacy. Use accessors in src/data/sources.ts
  connectedSources?: {
    activity?: 'strava' | 'garmin' | 'apple' | 'polar' | 'phone';
    physiology?: 'garmin' | 'apple' | 'whoop' | 'oura';
  };

  // Physiology / accuracy
  biologicalSex?: 'male' | 'female' | 'prefer_not_to_say';  // Used for iTRIMP β coefficient (unset → male default)
  bodyWeightKg?: number;  // Bodyweight in kg. FTP→W/kg, load refinements. Falls back to 75kg M / 62kg F when unset.
  heightCm?: number;      // Height in cm. With bodyWeightKg → body surface area for heat personalisation. Optional; absent → no heat-size adjustment.
  bodyMassSwapEnabled?: boolean;  // Cross-training swap opt-in. undefined = undecided (default-on for heavy users, onboarding popup pending); true = kept; false = user turned it off.
  plyoInGymEnabled?: boolean;  // Contrast power-block in build-phase running-strength gym sessions (heavy lift + matched jump). Default-on for intermediate+; undefined/true = on, false = user turned it off in Settings.

  // Plan start date (ISO YYYY-MM-DD). Anchor for all week date ranges
  planStartDate?: string;

  // Date this plan instance was created/regenerated (ISO YYYY-MM-DD). Days in the
  // current week that fall BEFORE this date were never schedulable, so they must
  // not read "Missed" on a freshly built plan (e.g. onboard mid-week → yesterday).
  // Set only on a genuine plan build, never on a per-launch re-anchor. Optional:
  // absent → no pre-creation suppression (legacy behaviour preserved).
  planCreatedAt?: string;

  // Selected event (locked from onboarding)
  selectedMarathon?: Marathon;

  /**
   * Running race-outcome log. Predicted vs actual after a target race.
   * Idempotent per `dateISO`. Mirrors `triConfig.raceLog` in triathlon mode.
   * Append-only; consumed by post-race retrospective surfaces. Optional so
   * existing state objects keep working without migration.
   */
  runRaceLog?: RunRaceLogEntry[];

  /**
   * Per-user prediction calibration for running mode (tier 1: per-distance
   * additive bias once ≥2 races at the same distance are logged). Computed
   * from `runRaceLog` and applied to `blendedRaceTimeSec` + `forecastTime` so
   * the user-facing prediction learns from their own race history. See
   * `src/calculations/run-calibration.ts`.
   */
  runCalibration?: import('@/calculations/run-calibration').RunCalibration;

  /**
   * Long-run durability result. Multiplier applied to `blendedRaceTimeSec`
   * (today's prediction) when the user's longest recent run falls below the
   * distance-specific threshold. NOT applied to `forecastTime`. The
   * projection assumes the plan delivers long runs before race day. See
   * `src/calculations/run-durability.ts`.
   */
  runDurability?: import('@/calculations/run-durability').RunDurabilityResult;

  // Athlete tier (for ACWR thresholds and plan ramp rate)
  athleteTier?: 'beginner' | 'recreational' | 'trained' | 'performance' | 'high_volume';
  athleteTierOverride?: 'beginner' | 'recreational' | 'trained' | 'performance' | 'high_volume';

  // iTRIMP intensity thresholds. Personalised from Strava labelled runs (Phase C2)
  // Defaults: easy < 70 TSS/hr, tempo 70–95 TSS/hr, vo2 > 95 TSS/hr
  intensityThresholds?: {
    easy: number;              // TSS/hr upper bound for easy zone (default 70)
    tempo: number;             // TSS/hr upper bound for tempo/threshold (default 95)
    calibratedFrom?: number;   // Number of labelled sessions used for calibration
  };

  // Phase C. Strava history (populated by fetchStravaHistory() / history mode edge fn)
  // Blended race-time prediction cache. Refreshed at onboarding + weekly rollover.
  // Computed by refreshBlendedFitness() from wizard data + per-run history (Tanda).
  // Consumers (stats view, plan engine) read this instead of re-blending on every render.
  blendedRaceTimeSec?: number;              // Predicted time for s.rd at current fitness
  blendedEffectiveVdot?: number;            // VDOT back-solved from blended prediction, for pace derivation
  /** Peak-volume race-time anchor for the FORECAST (ISSUE-297): a blendPredictions
   *  at the plan's `computePeakWeeklyKm`, so the race-day projection credits the
   *  volume the plan builds toward rather than today's penalised volume. Surfaces
   *  that recompute the live forecast (renderer, plan-preview) pass this as
   *  `blendedAnchorSec` instead of `blendedRaceTimeSec`. Written by
   *  refreshBlendedFitness + initializeSimulator. */
  forecastBlendAnchorSec?: number;
  blendedLastRefreshedISO?: string;         // When the cache was last recomputed
  // True when the blend had NO measured run data and was sized from the
  // runs/week volume estimate (no synced history, no typed weekly km). The UI
  // shows an honest "estimate, sharpens once your runs sync" caption. Cleared
  // the moment real run data lands and the refresh re-runs.
  blendedFromEstimate?: boolean;
  // HR-calibrated VDOT. Swain regression of pace on %VO2R across recent runs.
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

  // Cross-modal VO2max. Per-discipline estimates plus a cardiac ceiling that
  // captures contributions from any aerobic sport via HR data. Computed every
  // launch from the last 8 weeks of activities. See SCIENCE_LOG → "Cross-Modal
  // VO2max" for the formulas, transfer coefficients, and citations.
  vo2Source?: 'mosaic' | 'device';
  /** Manual VO2max override. When present, takes priority over `vo2Source`
   *  (mosaic|device) and over the orchestrator's computed headline.
   *  Mirrors the LT override pattern (`override > Garmin > derived`). The
   *  Mosaic / Watch toggle UI shows a third "Manual" pill while this is set;
   *  the user clicks Reset to remove the override and restore the toggle. */
  vo2Override?: {
    value: number;            // ml/kg/min
    setAt: string;            // ISO timestamp
  };
  vo2Estimates?: {
    /** Running VO2max — effort-calibrated regression, lifted by cardiac ceiling. */
    running: VO2Estimate;
    /** Cycling VO2max — ACSM W/kg, lifted by cardiac ceiling. */
    cycling: VO2Estimate;
    /** Cardiac ceiling — Uth-Sørensen across all aerobic activity. */
    cardiac: VO2Estimate;
    /** Cross-training VO2max — sustained-HR aerobic capacity from non-run,
     *  non-bike sport. Hidden when fewer than 3 qualifying sessions. */
    crossTraining: VO2Estimate;
    /** Highest demonstrated across all sources — the headline figure. */
    headline: { value: number | null; confidence: VO2Confidence; sport: 'running' | 'cycling' | 'cardiac' | null };
    /** ISO timestamp of the most recent recompute. */
    computedAt: string;
  };

  // Per-run summary cached at onboarding so the first blend has Tanda inputs
  // without waiting a week for standalone sync to fill garminActuals.
  // The rich quality fields (avgPaceSecKm, kmSplits, hrDrift, elevation, temp)
  // are optional. Populated when we can seed from the DB (post-backfill, via
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

  /**
   * Slim per-activity history across ALL disciplines (swim/bike/run), distilled
   * from the DB activity log at launch (`loadActivitiesFromDB`). Persisted so
   * per-discipline weekly volume and longest-session signals survive a fresh
   * sign-in, where `wks[].garminActuals` is empty until activities re-match
   * forward. `onboardingRunHistory` already gives run this resilience; this
   * extends the same coverage to swim and bike (the Endurance readiness card
   * read garminActuals-only and so collapsed to 0 after sign-in). Capped to the
   * last 12 weeks (the readiness longest-session window) and holds only the
   * fields the volume/longest helpers need — no polylines/splits — to keep the
   * snapshot small. Read by `iterateRecentActuals` in tri-volume-by-discipline. */
  recentDisciplineActivity?: Array<{
    activityType: string;
    startTime: string;
    durationSec: number;
    distanceKm: number;
  }>;

  /** ISO timestamp of the user's earliest Strava activity, fetched once on first
   * triathlon prediction. Drives years-of-training → experience-level mapping in
   * the horizon adjuster (Joyner & Coyle 2008. Durability scales with years
   * beyond what CTL captures). Null if Strava is not connected or fetch failed. */
  firstStravaActivityISO?: string | null;
  stravaHistoryFetched?: boolean;           // True once history has been loaded at least once
  stravaHistoryAccepted?: boolean;          // True when user clicked "Use this" in the history summary wizard step
  /** True when the user has explicitly provided or accepted their weekly volume
   * from a non-Strava source (typed it in manual entry, or it was derived from
   * an import). Source-agnostic companion to `stravaHistoryAccepted`; either
   * flag lets `detectedWeeklyKm` seed the plan's starting `s.wkm`. We only seed
   * plan volume from a number the user gave or accepted, never a silent derive. */
  weeklyVolumeConfirmed?: boolean;
  /** True once the 364-day Apple Health backfill has run at least once.
   * Subsequent launches use the 28-day incremental window. Same role as
   * `stravaHistoryFetched` for the Apple-only path. */
  appleHistoryFetched?: boolean;
  /** One-time migration flag (build 24+). Pre-build-23, the Apple workout sync
   *  was gated on an activity source the connect never set, so many users never
   *  got their history (or only a partial 14-day window after a manual sync,
   *  with `appleHistoryFetched` stuck true). On first launch after the fix we
   *  force ONE full re-backfill for every Apple-connected user, then set this so
   *  it never re-runs. Heals already-set-up users without any manual action. */
  appleHistoryResyncDone?: boolean;
  /** ISO timestamp of the most recent successful Apple-history aggregation.
   * Mirrors `historicLastRefreshedAt` for the Apple path; used to decide
   * whether to refresh weekly baselines on launch. */
  appleHistoryLastRefreshedAt?: string;
  /** True once the deep (multi-year) Apple Health history pull has run at
   * least once. Separate from `appleHistoryFetched` (which covers the
   * 52-week HR-enriched window). This flag tracks the older, lighter
   * pull whose only purpose is surfacing historic races and PBs. */
  appleDeepHistoryFetched?: boolean;
  /** Device-local flag: the user has authorized Apple HealthKit on THIS device
   * (the permission sheet was presented and granted). Set by `connectAppleHealth()`.
   * Distinct from `connectedSources.physiology` (the single labelled primary):
   * Apple Health can run as a SUPPLEMENTARY physiology + activity source alongside
   * a Garmin/Strava primary. Launch reads this to additively run the Apple sync
   * (gap-fills physiology, prefers Garmin) without demoting the primary source. */
  appleHealthConnected?: boolean;
  /** Device-local, one-time: the HealthKit `heartRate` read type has been
   *  included in a permission request on this install. Builds after ae0545e
   *  never asked for it, so every Apple workout arrived without its HR stream
   *  and was costed on duration alone. The workout sync asks once before its
   *  first HR read; iOS shows the sheet only for types it has not asked about,
   *  so a user who already answered sees nothing. */
  appleHeartRatePermissionRequested?: boolean;
  /** ISSUE-263: one-time load-currency migration ran (pre-2026-06-04 stored
   *  workout loads restamped to canonical TSS). Optional — fresh installs
   *  start canonical and the migration is a no-op. */
  loadCurrencyV2?: boolean;
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
  ctlBaseline?: number;                     // Signal A CTL. 42-day EMA of run-equiv load; seeds fitness model
  tssPerActiveMinute?: number;              // Personal TSS per active minute, calibrated from logged activities
  signalBBaseline?: number;                 // Signal B baseline. 8-week EMA of raw physiological TSS; used for excess load thresholds
  sportBaselineByType?: Record<string, {    // Per-sport session averages from history (Phase 2 calibration)
    avgSessionRawTSS: number;               //   avg raw TSS per session
    sessionsPerWeek: number;                //   avg sessions per week in the history window
  }>;
  detectedWeeklyKm?: number;               // Average weekly running km from history (for plan starting volume)
  extendedHistoryWeeks?: number;            // How many weeks are loaded in extended view (16 or 52)
  extendedHistoryTSS?: number[];
  extendedHistoryKm?: number[];
  extendedHistoryZones?: { base: number; threshold: number; intensity: number }[];

  // Athlete archetype. Re-detected at onboarding and on the 7-day refresh.
  // Drives plan-engine ramp slope and predictor confidence band. See
  // src/calculations/athlete-archetype.ts for the classifier.
  athleteArchetype?: import('@/calculations/athlete-archetype').ArchetypeResult;

  // Injury recovery tracking
  rehabWeeksDone?: number;        // Weeks completed during injury (plan pointer frozen)
  lastMorningPainDate?: string;   // ISO date string of last morning pain check
  injuryState?: import('./injury').InjuryState; // Active injury state

  // Illness tracking
  illnessState?: {
    startDate: string;              // ISO date when the CURRENT schedule was built (rolls forward on re-report)
    onsetDate?: string;              // ISO date of original first report; preserved across re-reports for "Day N" display
    severity: 'light' | 'resting'; // legacy tier. Derived from schedule[0] when v2 fields present
    active: boolean;                // false once user marks recovered

    // ─── v2 fields (optional, additive) ──────────────────────────────────────
    // Classification derived from symptom inputs (Friman/Schwellnus rule).
    classification?: {
      neckRule: 'above' | 'below';
      severityTier: 'mild' | 'moderate' | 'severe';
      hasSystemic: boolean;          // fever | body aches override → below-neck regardless
      rhrFlag: 'normal' | 'elevated' | 'high';
    };

    // Day-by-day plan modification schedule. Indexed by days since startDate.
    // Beyond schedule end → no modification (user is back to full).
    schedule?: Array<{
      dateOffsetDays: number;        // 0 = startDate, 1 = +1 day, ...
      capacity: 'rest' | 'easy_only' | 'reduced' | 'full';
      volumeFactor: number;          // 0–1, applied to planned distance/duration
      intensityCeiling: 'rest' | 'easy' | 'steady' | 'full';
    }>;

    // Raw form inputs (kept for transparency / future LLM context).
    symptoms?: Array<'fever' | 'body_aches' | 'cough' | 'runny_nose' | 'sore_throat' | 'gi' | 'headache' | 'fatigue'>;
    illnessType?: 'flu_chest' | 'head_cold' | 'gi' | 'other';
    severity1to10?: number;
    dayOfSymptoms?: '1-2' | '3-5' | '6+';
    userCapacityOverride?: 'easy_only' | 'walks' | 'rest';
    rhrDeltaBpm?: number;            // signed delta vs 28d baseline (positive = elevated)
    rhrSource?: 'auto' | 'manual';   // auto = from physioHistory, manual = user entered
    resolvedDate?: string;            // ISO when user marked recovered (return-to-train ramp starts)
  };

  // Holiday tracking
  holidayState?: {
    startDate: string;              // ISO YYYY-MM-DD
    endDate: string;                // ISO YYYY-MM-DD
    canRun: 'yes' | 'maybe' | 'no';
    canSwim?: boolean;              // triathlon only: pool/open-water access while away (bike is always assumed unavailable on holiday)
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

  // Just-Track mode. Activity tracking only, no plan generated.
  // Mirrors s.onboarding.trackOnly so views can branch without reading onboarding.
  // When true: s.wks is []; s.w is 0; today-workout / plan widgets are hidden.
  // Strava/Garmin/Apple sync, physiology sync, activity matching still run normally.
  trackOnly?: boolean;

  // Continuous (non-event) training
  continuousMode?: boolean;       // True for non-event users. Plan loops instead of completing
  blockNumber?: number;           // Current 4-week block number (1-based)
  benchmarkResults?: BenchmarkResult[]; // History of optional benchmark check-ins

  // Long race plan structure (>16 weeks)
  /** @deprecated Legacy field from the >16w block-cycle prefix model.
   *  No longer set on new plans (always undefined). Kept in the interface so
   *  reads from persisted state don't throw. Safe to remove after all users
   *  have re-initialised a plan. */
  racePhaseStart?: number;

  // Recovery tracking
  recoveryHistory?: import('../recovery/engine').RecoveryEntry[];
  lastRecoveryPromptDate?: string;   // ISO date. One-prompt-per-day guard

  // Garmin physiology history (last 7 days from daily_metrics)
  physiologyHistory?: PhysiologyDayEntry[];

  // Personalised recovery learning. Fitted from the session impact log.
  // Replaces the population recovery constant (8) when confidence is medium
  // or higher. See `src/calculations/adaptive-recovery.ts`.
  adaptiveRecovery?: AdaptiveRecovery;

  // Per-session evidence for the recovery-rate fitter. Capped at 90 days of
  // entries. Populated live as workouts are completed plus a one-shot
  // historical backfill on first launch.
  sessionImpactLog?: SessionImpactEntry[];

  // Leg load history. Recent cross-training entries used to compute decayed leg fatigue signal.
  // `recoveryMultOverride` lets a per-entry tag (e.g. strength session with heavy leg-feel)
  // override the sport's default recoveryMult for the half-life calc, so a heavy squat day
  // decays slower than the strength baseline.
  recentLegLoads?: Array<{ load: number; sport: string; sportLabel: string; timestampMs: number; garminId?: string; rbeProtected?: boolean; recoveryMultOverride?: number }>;

  // Persistent mapping from normalized activity name → user-chosen sport. When an activity with
  // the same name is synced in future, it auto-applies the mapped sport. Populated when user
  // reclassifies an activity via the sport picker.
  sportNameMappings?: Record<string, import('./activities').SportKey>;

  // Activities the user has explicitly discarded. Future syncs (Strava + Garmin) skip these IDs
  // so a backfill duplicate that was deleted does not re-import. Stores the raw garminId
  // (numeric for Garmin, "strava-{id}" for Strava).
  ignoredGarminIds?: string[];

  /** Apple Health activity ids removed because a Strava record of the same session
   *  won (see `collapseAppleStravaTwins` in calculations/cross-source-twins.ts).
   *  Read next to `ignoredGarminIds` in matchAndAutoComplete and the Apple upload,
   *  so the superseded copy never re-imports. Kept apart from `ignoredGarminIds`,
   *  which records the user's own discards. */
  supersededGarminIds?: string[];
  /** The one-time forced garmin_activities twin cleanup (cleanupDbDuplicates,
   *  regardless of its 30-day cadence) for Strava-connected users has run: set by
   *  the first Strava sync after the 2026-10-05 change (Apple workouts off while
   *  Strava is connected). Gates only that DB pass; the local Apple/Strava twin
   *  collapse keeps running at launch and after each Strava sync. */
  appleStravaTwinCleanupDone?: boolean;

  // LT auto-estimation state
  ltEstimation?: import('../calculations/lt-estimator').LTEstimationState;

  // VDOT history. Appended whenever VDOT changes, capped at last 20 entries
  vdotHistory?: Array<{ week: number; vdot: number; date?: string }>;

  // Display preferences
  unitPref?: 'km' | 'mi';   // Distance unit preference (default 'km')

  // Guided runs. Phone-driven coaching during a tracked run
  guidedRunsEnabled?: boolean;        // Master on/off (default off until user opts in)
  guidedSplitAnnouncements?: boolean; // Per-km voice splits (default true; off if Strava/Garmin already doing it)
  guidedVoiceRate?: number;           // Speech rate multiplier, 0.8–1.4, default 1.0
  guidedKeepScreenOn?: boolean;       // Keep screen on during guided runs (Screen Wake Lock). Default true; web-only interim until Capacitor KeepAwake.
  gpsAutoPause?: boolean;             // Speed-based auto-pause/resume during tracked runs (default true; off keeps the clock running while stopped).

  // Sleep target. User-set override in seconds; if absent, derived from 75th percentile of last 30 nights
  sleepTargetSec?: number;

  // Today's subjective feeling. One-tap daily check-in from the Coach sub-page.
  // Expires at end of day (check `date === todayISO()` before reading).
  todayFeeling?: { value: 'struggling' | 'ok' | 'good' | 'great'; date: string } | null;

  // Completed plan history. Appended when the user finishes the plan-complete debrief.
  completedPlans?: CompletedPlanSummary[];

  // Archived weeks from prior plans. Captured by `initializeSimulator` whenever
  // `s.wks` is replaced with a fresh plan, so daily activity history (garminActuals,
  // adhocWorkouts, ratings) survives plan resets. Read by rolling-load, coach,
  // freshness, and stats views as an historic data source independent of the
  // current plan's date range. Capped to keep state size bounded.
  previousPlanWks?: Array<{
    planStartDate: string;       // ISO date for week 1 of that plan
    weeks: any[];                // Week[]. Typed loosely to avoid forward-ref churn
    archivedAt: string;          // ISO date when archived
  }>;

  /**
   * Timestamp of the last successful auto-restore from `garmin_activities`.
   * `main.ts` boot sequence checks this and re-runs the restore if older than
   * 24h, so a long-term user who clears localStorage (or whose state ever gets
   * partially wiped) self-heals on the next launch. Strava's table is the
   * source of truth, local `previousPlanWks` is a hot cache.
   */
  lastHistoryAutoRestoreISO?: string;

  /** One-time health-disclaimer acknowledgement. Surfaced as a launch modal
   *  for any user (new or existing) until ticked. App Store §1.4 requires
   *  this disclosure for any health/fitness-recommendation app. */
  healthDisclaimerAcknowledged?: boolean;
  healthDisclaimerAcknowledgedISO?: string;

  // AI Coach
  coachConsentGiven?: boolean;      // one-time AI-data-disclosure accepted
  coachIntroSeen?: boolean;         // one-time "what the coach can do" overlay dismissed
  /** Persistent memory the coach maintains about the athlete across sessions.
   *  Each fact is a short statement (preference, constraint, motivation). Capped
   *  at 15. When full, oldest is dropped on the next remember. Written via the
   *  `remember` tool's Apply card so the user confirms each memory write. */
  coachMemory?: {
    lastUpdatedISO: string;
    facts: Array<{ text: string; addedISO: string }>;
  };
  /** What the athlete cares most about in this training block, captured by a
   *  one-time 2-click flow the first time they open Coach. Used by the coach to
   *  weight recommendations. "healthy" + "injury" leans toward reductions;
   *  "time" + "none" leans toward pushing. Re-prompt every 12 weeks via setISO. */
  coachPriorities?: {
    priority: 'time' | 'finish' | 'healthy' | 'fun';
    constraint: 'time' | 'energy' | 'injury' | 'none';
    setISO: string;
  };
  coachPrioritiesSeen?: boolean;
  /** Queue of proactive insights the deterministic trigger detector has surfaced.
   *  Home view renders the top unseen entry. Tapping marks `seen` true and opens
   *  Coach with the primer prefilled. Tapping the X dismisses without opening. */
  coachInsightQueue?: Array<{
    /** Trigger id — also used as the one-time guard so the same condition
     *  fires at most once per event ('hrv_crash_2026-05-14', etc.). */
    triggerId: string;
    /** Short headline rendered on the Home card. */
    headline: string;
    /** Primer text sent as the user's first message when Coach opens. */
    primer: string;
    createdISO: string;
    seen?: boolean;
  }>;

  // Route safety map
  safetyRatingIntroSeen?: boolean;  // one-time first-look popup on activity detail dismissed

  // Post-first-run coachmark pointing at the Check-in button (log soreness/niggles).
  // Shown once, after the user's first completed run, then never again.
  checkinHintSeen?: boolean;
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
  // Granular stats. Preserved so "Total" tab can show all-time aggregates
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
