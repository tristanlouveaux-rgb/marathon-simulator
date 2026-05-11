import type { RaceDistance, RunnerType, PBs, RecentRun } from './training';
import type { CommuteConfig } from './state';

export type RunnerExperience =
  | 'total_beginner'
  | 'beginner'
  | 'novice'
  | 'intermediate'
  | 'advanced'
  | 'competitive'
  | 'returning'
  | 'hybrid';

/** Onboarding wizard step identifiers */
export type OnboardingStep =
  | 'welcome'
  | 'goals'
  | 'connect-strava'
  | 'manual-entry'
  | 'about-you'
  | 'review'
  | 'race-target'
  | 'schedule'
  | 'plan-preview-v2'
  | 'initializing'
  | 'runner-type'
  | 'triathlon-setup'
  | 'tri-past-race'
  | 'cycling-setup'
  | 'hyrox-setup'
  | 'workout-preview'
  | 'tri-workout-preview'
  | 'hyrox-workout-preview'
  | 'main-view';

/** Race distances supported for past-race entry (includes sprint/olympic not in active race plans). */
export type PastTriathlonDistance = 'sprint' | 'olympic' | '70.3' | 'ironman';

/** Distances (m) for each past-race format — used to derive CSS and run pace from leg times. */
export const PAST_TRI_LEG_DISTANCES: Record<PastTriathlonDistance, { swimM: number; bikeKm: number; runKm: number }> = {
  'sprint':   { swimM: 750,  bikeKm: 20,    runKm: 5    },
  'olympic':  { swimM: 1500, bikeKm: 40,    runKm: 10   },
  '70.3':     { swimM: 1900, bikeKm: 90,    runKm: 21.1 },
  'ironman':  { swimM: 3800, bikeKm: 180.2, runKm: 42.2 },
};

/** A past triathlon result entered during onboarding. Used to seed CSS and run-VDOT benchmarks. */
export interface TriPastRaceEntry {
  distance: PastTriathlonDistance;
  /** ISO month string (YYYY-MM) or full date (YYYY-MM-DD). */
  dateISO: string;
  totalSec: number;
  perLeg?: {
    swim: number;   // seconds
    bike: number;   // seconds
    run: number;    // seconds
  };
  source: 'manual' | 'strava';
}

/** Recurring cross-training activity from onboarding */
export interface RecurringActivity {
  sport: string;
  durationMin: number;
  frequency: number;         // Times per week (1-7)
  intensity: 'easy' | 'moderate' | 'hard';
}

/** Training focus for non-event users.
 * 'track' = Just-Track mode: activity tracking only, no plan generated. */
export type TrainingFocus = 'speed' | 'endurance' | 'both' | 'track';

/** Marathon/race event data */
export interface Marathon {
  id: string;
  name: string;
  city: string;
  country: string;
  date: string;                    // ISO date string
  distance: 'half' | 'marathon';
  weeksUntil?: number;             // Computed at runtime
  imageUrl?: string;               // Optional city/race tile image
  /** Per-race course facts. Optional — populated from marathon-course-profiles.ts.
   * Only `runElevationM`, `climate`, `altitudeM`, `runProfile` are used for running. */
  profile?: CourseProfile;
}

/**
 * Per-leg published facts about an IRONMAN course. The prediction engine
 * (separate agent) consumes these to produce time deltas vs an IM-typical
 * course. We do NOT store derived multipliers here — only sourced facts.
 */
export interface CourseProfile {
  /** Total bike elevation gain in metres (published in athlete guide). */
  bikeElevationM?: number;
  /** Total run elevation gain in metres (published in athlete guide). */
  runElevationM?: number;
  /** Categorical bike profile, derived consistently from elevation/route. */
  bikeProfile?: 'flat' | 'rolling' | 'hilly' | 'mountainous';
  /** Categorical run profile. */
  runProfile?: 'flat' | 'rolling' | 'hilly';
  /** Water and current character. */
  swimType?: 'wetsuit-lake' | 'non-wetsuit-lake' | 'ocean' | 'ocean-current-assisted' | 'river';
  /** Typical race-day climate. */
  climate?: 'cool' | 'temperate' | 'warm' | 'hot' | 'hot-humid';
  /** Venue altitude in metres above sea level. */
  altitudeM?: number;
  /** Wind exposure on the bike + run course. */
  windExposure?: 'sheltered' | 'mixed' | 'exposed';
  /** Free-form course notes (e.g. "2× Madonna climb", "current-assisted point-to-point swim"). */
  notes?: string;
}

/** Triathlon event data — IRONMAN-branded full and 70.3 races. */
export interface Triathlon {
  id: string;
  name: string;
  city: string;
  country: string;
  date: string;                    // ISO date string
  distance: '70.3' | 'ironman';
  weeksUntil?: number;             // Computed at runtime
  /** Per-leg course facts. Optional — populated from triathlon-course-profiles.ts. */
  profile?: CourseProfile;
}

/** Milestone target for goal-setting */
export interface MilestoneTarget {
  time: number;           // Target time in seconds

  label: string;          // e.g., "Sub-4 Marathon"
  distance: RaceDistance;
  extraWorkout?: string;  // Suggested extra workout type
}

/** Milestone thresholds by distance (in seconds) */
export const MILESTONE_THRESHOLDS: Record<RaceDistance, number[]> = {
  '5k': [25 * 60, 22 * 60, 20 * 60, 18 * 60],           // 25:00, 22:00, 20:00, 18:00
  '10k': [50 * 60, 45 * 60, 40 * 60],                    // 50:00, 45:00, 40:00
  'half': [2 * 3600, 1.75 * 3600, 1.5 * 3600],          // 2:00:00, 1:45:00, 1:30:00
  'marathon': [4 * 3600, 3.5 * 3600, 3 * 3600],         // 4:00:00, 3:30:00, 3:00:00
};

/** Milestone labels by distance */
export const MILESTONE_LABELS: Record<RaceDistance, string[]> = {
  '5k': ['Sub-25', 'Sub-22', 'Sub-20', 'Sub-18'],
  '10k': ['Sub-50', 'Sub-45', 'Sub-40'],
  'half': ['Sub-2 Hour', 'Sub-1:45', 'Sub-1:30'],
  'marathon': ['Sub-4 Hour', 'Sub-3:30', 'Sub-3 Hour'],
};

/** Onboarding wizard state */
export interface OnboardingState {
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];

  // Name
  name: string;
  age?: number;                   // Runner age
  bodyWeightKg?: number;          // Bodyweight in kg. Used for FTP→W/kg cycling tier
                                  // and load refinements. Optional; falls back to
                                  // sex-based default (75kg male / 62kg female).


  // Step 2: Training Goal
  trainingMode?: 'running' | 'hyrox' | 'triathlon' | 'cycling' | 'fitness' | null;
  trainingForEvent: boolean | null;
  raceDistance: RaceDistance | null;
  trainingFocus: TrainingFocus | null;

  // Step 3: Event Selection
  selectedRace: Marathon | null;
  customRaceDate: string | null;  // ISO date for manual entry
  planDurationWeeks: number;

  // Step 4: Commute
  runsToWork: boolean | null;
  commuteConfig: CommuteConfig | null;

  // Step 5: Training Frequency
  runsPerWeek: number;
  gymSessionsPerWeek: number;  // 0-3 running-focused gym sessions
  sportsPerWeek: number;  // Legacy — derived from recurringActivities
  experienceLevel: RunnerExperience;

  // Step 5b: Active Lifestyle & Recurring Activities
  activeLifestyle: boolean;
  recurringActivities: RecurringActivity[];

  // Step 6: PBs
  pbs: PBs;
  /**
   * ISO start dates of the activities that produced each PB. Used by
   * `blendPredictions` to scale the marathon-specificity penalty: a recent
   * marathon PB is *demonstrated current capability*, so the penalty (which
   * assumes PB might be stale and over-state current marathon-specific
   * fitness) should be reduced when the PB is fresh. Optional — when absent,
   * the penalty applies at full strength (legacy behaviour).
   */
  pbDates?: { k5?: string; k10?: string; h?: string; m?: string };
  recentRace: RecentRun | null;

  // Step 7: Fitness Data (smartwatch)
  hasSmartwatch: boolean | null;
  watchType?: 'garmin' | 'apple' | 'strava';  // Which device the user selected
  biologicalSex?: 'male' | 'female' | 'prefer_not_to_say';  // For iTRIMP β coefficient
  ltPace: number | null;      // LT pace in seconds per km
  vo2max: number | null;      // VO2 max in ml/kg/min
  restingHR: number | null;   // Resting heart rate in bpm
  maxHR: number | null;       // Max heart rate in bpm

  // Step 9: Runner Type
  calculatedRunnerType: RunnerType | null;
  confirmedRunnerType: RunnerType | null;

  // Step 9: Milestone Targeting
  targetMilestone: MilestoneTarget | null;
  acceptedMilestoneChallenge: boolean;

  // Continuous training (non-event)
  continuousMode?: boolean;       // True when user is not training for a specific event

  // Step 3: Connect Strava
  skippedStrava?: boolean;         // True if user chose "Enter manually" on the Connect Strava step

  // Step 5 (fitness path): "Just track" — activity tracking only, no plan generated
  trackOnly?: boolean;

  // ─────────────────────────────────────────────────────────────────────
  // Triathlon-specific onboarding fields (active when trainingMode === 'triathlon').
  // All optional — the wizard populates them via the triathlon fork (§18.9).
  // ─────────────────────────────────────────────────────────────────────

  /** 70.3 or Ironman. Present only for triathlon mode. */
  triDistance?: import('./triathlon').TriathlonDistance;

  /** Upstream of the split picker (§18.2). Total weekly training hours the user commits to. */
  triTimeAvailableHoursPerWeek?: number;

  /** Mon–Fri combined training hours. Weekend (Sat+Sun) gets the rest. */
  triWeekdayHoursPerWeek?: number;

  /** Volume split across swim/bike/run. User adjusts from preset in onboarding. Sums to 1.0. */
  triVolumeSplit?: import('./triathlon').TriVolumeSplit;

  /** Three self-rating sliders (1-5) that replace runner type for tri users (§18.7). */
  triSkillRating?: import('./triathlon').TriSkillRating;

  /** Bike benchmarks — FTP if known, has-power-meter flag, otherwise HR fallback. */
  triBike?: import('./triathlon').BikeBenchmarks;

  /** Swim benchmarks — CSS if known or derivable from 400m/200m test. */
  triSwim?: import('./triathlon').SwimBenchmarks;

  /** True when the wizard used the Strava express path (§18.9) to auto-fill tri fields. */
  triUsedStravaExpressPath?: boolean;

  /** Past triathlon result entered on the tri-past-race wizard step. Seeds CSS + run-VDOT benchmarks. */
  triPastRace?: TriPastRaceEntry | null;

  /** Selected IRONMAN-branded race (sets customRaceDate from race.date). */
  selectedTriathlonId?: string | null;

  // ─────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────
  // Running-specific onboarding fields (active when trainingMode is null / 'running').
  // ─────────────────────────────────────────────────────────────────────

  /** Peak weekly training hours for running. Used by the plan engine to right-size
   *  easy and long session durations. Quality session durations are never reduced. */
  weeklyTrainingHours?: number;
  /** How much of weeklyTrainingHours falls on Mon–Fri (remainder lands Sat–Sun). */
  weekdayTrainingHours?: number;
  /** Running session types the user has opted out of on the workout-preview step.
   *  Filtered from the quality priority list in plan_engine. Empty / undefined = include all. */
  runningExcludedWorkouts?: string[];
  /** When the plan-view "budget overflow" banner is dismissed via "Accept shorter sessions",
   *  we record the hours value at dismissal time. The banner stays hidden as long as
   *  weeklyTrainingHours equals this value; if the user later changes their hours target,
   *  the banner re-arms so the trade-off can be re-surfaced. */
  budgetAcceptedAtHours?: number;

  // Cycling-specific onboarding fields (active when trainingMode === 'cycling').
  // V1 covers Gran Fondo / sportive / audax targets. Reuses triBike for FTP
  // and triTimeAvailableHoursPerWeek / triWeekdayHoursPerWeek for hours.
  // ─────────────────────────────────────────────────────────────────────

  /** Cycling event target distance — sportive / Gran Fondo / audax presets. */
  cyclingDistance?: '50km' | '100km' | '160km' | '200km' | '300km';

  /** Optional cycling event ID — picks a famous event (Étape, Marmotte, etc.).
   *  When set, climate/altitude are sourced from CYCLING_EVENT_PROFILES. */
  cyclingEventId?: string;

  /** Typical race-day climate. Anchored to wet-bulb temperature (see triathlon-course-factors).
   *  Falls back to undefined = no climate penalty. Auto-populated from cyclingEventId. */
  cyclingClimate?: 'cool' | 'temperate' | 'warm' | 'hot' | 'hot-humid';

  /** Course altitude in metres (peak or sustained, whichever is more limiting).
   *  Used by altitudeBikeMultiplier; under 500 m has no effect. */
  cyclingAltitudeM?: number;

  /**
   * Bike workout kinds the user has opted out of on the workout-preview step.
   * Plan engine substitutes excluded kinds with the closest in-tier sibling.
   * Empty / undefined = include all 9 kinds (default).
   */
  cyclingExcludedWorkouts?: string[];

  // ─────────────────────────────────────────────────────────────────────
  // HYROX-specific onboarding fields (active when trainingMode === 'hyrox').
  // ─────────────────────────────────────────────────────────────────────

  /** Competition format. */
  hyroxFormat?: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

  /** Which format the user's *previous* HYROX time was set in (may differ from current target format). */
  hyroxPreviousTimeFormat?: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

  /** Which past HYROX event the previous time was set at (id from `HYROX_WORLD_SERIES`).
   *  Drives venue-aware scaling when comparing past time to a future race at a different venue. */
  hyroxPreviousTimeRaceId?: string;

  /** ISO date (YYYY-MM-DD) of the previous HYROX time. Required when no event ID
   *  is selected so the staleness model has a reference point. Derived from
   *  the picked event's date when an event is selected. */
  hyroxPreviousRaceDate?: string;

  /** Selected HYROX venue id (from `HYROX_VENUES`). Drives course-factor adjustments.
   *  Populated automatically when user picks a specific race from the race calendar. */
  hyroxVenueId?: string;

  /** Selected HYROX race event id (from `HYROX_WORLD_SERIES`). When set, the venue is
   *  derived from the event so the user does not pick venue separately. */
  hyroxRaceEventId?: string;

  /** Previous HYROX finish time in seconds — drives ability band derivation.
   *  Shown live on hyrox-setup as the band classification updates. */
  previousHyroxTimeSec?: number;

  /** Per-station split times from a previous HYROX race (seconds each).
   *  Entered optionally in hyrox-setup. Seeds stationBenchmarks at init time. */
  hyroxPreviousStationSplits?: Partial<Record<string, number>>;

  /** Sled access at the athlete's training venue. */
  hyroxSledAccess?: 'always' | 'sometimes' | 'never';

  /** Whether the athlete's gym has a SkiErg. */
  hyroxHasSkiErg?: boolean;

  /** Whether the athlete's gym has a row erg. */
  hyroxHasRowErg?: boolean;

  /** Total weekly sessions target (runs + stations + bricks combined).
   *  Overrides the band default from HYROX_WEEKLY_SESSIONS. */
  hyroxWeeklySessionCount?: number;

  /** 1km run pace (seconds/km) derived from previous HYROX race results paste.
   *  Seeds hyroxConfig.hyroxRunPaceSecKm at init time and drives the forecast engine. */
  hyroxRunPaceSecKm?: number;
}

/** Default onboarding state */
export const defaultOnboardingState: OnboardingState = {
  currentStep: 'welcome',
  completedSteps: [],
  name: '',
  trainingMode: null,
  trainingForEvent: null,
  raceDistance: null,
  trainingFocus: null,
  selectedRace: null,
  customRaceDate: null,
  planDurationWeeks: 16,
  runsToWork: null,
  commuteConfig: null,
  runsPerWeek: 4,
  gymSessionsPerWeek: 0,
  sportsPerWeek: 0,
  experienceLevel: 'intermediate',
  activeLifestyle: false,
  recurringActivities: [],
  pbs: {},
  recentRace: null,
  hasSmartwatch: null,
  ltPace: null,
  vo2max: null,
  restingHR: null,
  maxHR: null,
  calculatedRunnerType: null,
  confirmedRunnerType: null,
  targetMilestone: null,
  acceptedMilestoneChallenge: false,
  skippedStrava: false,
  trackOnly: false,
};

/**
 * Find the closest milestone target if within threshold percentage
 * @param predictedTime - Predicted race time in seconds
 * @param distance - Target race distance
 * @param thresholdPct - How close to milestone to trigger (default 5%)
 */
export function findNearestMilestone(
  predictedTime: number,
  distance: RaceDistance,
  thresholdPct: number = 0.05,
  experienceLevel?: string
): MilestoneTarget | null {
  // Scale threshold by experience: beginners get tighter gate, advanced get wider
  const EXP_THRESHOLD: Record<string, number> = {
    total_beginner: 0.02, beginner: 0.02,
    novice: 0.03, intermediate: 0.05,
    advanced: 0.06, competitive: 0.07,
    returning: 0.07,
    hybrid: 0.05,
  };
  if (experienceLevel) {
    thresholdPct = EXP_THRESHOLD[experienceLevel] || thresholdPct;
  }
  const thresholds = MILESTONE_THRESHOLDS[distance];
  const labels = MILESTONE_LABELS[distance];

  for (let i = 0; i < thresholds.length; i++) {
    const milestone = thresholds[i];
    // Check if predicted time is within threshold% above the milestone
    if (predictedTime > milestone && predictedTime <= milestone * (1 + thresholdPct)) {
      return {
        time: milestone,
        label: labels[i],
        distance,
        extraWorkout: getExtraWorkoutSuggestion(distance),
      };
    }
  }

  return null;
}

/**
 * Get suggested extra workout for milestone targeting
 */
function getExtraWorkoutSuggestion(distance: RaceDistance): string {
  switch (distance) {
    case '5k':
      return 'Add one VO2max interval session per week';
    case '10k':
      return 'Add one threshold tempo run per week';
    case 'half':
      return 'Add one longer tempo or progression run per week';
    case 'marathon':
      return 'Add one marathon-pace long run segment per week';
    default:
      return 'Add one quality session per week';
  }
}
