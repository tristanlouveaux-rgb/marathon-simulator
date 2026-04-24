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
  | 'review'
  | 'race-target'
  | 'schedule'
  | 'plan-preview-v2'
  | 'initializing'
  | 'runner-type'
  | 'triathlon-setup'
  | 'main-view';

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


  // Step 2: Training Goal
  trainingMode?: 'running' | 'hyrox' | 'triathlon' | 'fitness' | null;
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
