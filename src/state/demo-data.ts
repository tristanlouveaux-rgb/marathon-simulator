import type { OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';
import { updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { initializeSimulator } from '@/state/initialization';

/**
 * App Store reviewer demo data.
 *
 * A fresh-install reviewer has no Apple Watch or Strava history on their test device,
 * so a normal sign-up would leave the stats and forecast surfaces sparse — an App Store
 * guideline 2.1 ("app appears incomplete") rejection risk. This seeds a realistic,
 * fully-onboarded running account: PBs, a recent race, fitness markers, and a generated
 * 16-week marathon plan. The reviewer immediately sees a complete, functional app — a
 * real plan with workouts, a race forecast with a finish time, and a populated home.
 *
 * Triggered by entering the reviewer code on the connect-data step (documented in the
 * App Store reviewer notes). The numbers are illustrative sample data by design, not
 * derived from a real athlete. Activity-history charts (weekly TSS, VDOT trend) start
 * empty, which is the normal state for a brand-new account and reads as such.
 */

/** A believable returning marathoner: ~19:15 / 40:00 / 1:27:30 PBs, 5 runs/week, cross-trains. */
const REVIEWER_ONBOARDING: Partial<OnboardingState> = {
  name: 'Sample Athlete',
  trainingMode: 'running',
  trainingForEvent: true,
  raceDistance: 'marathon',
  selectedRace: {
    id: 'london-2026',
    name: 'London Marathon',
    city: 'London',
    country: 'UK',
    date: '2026-04-26',
    distance: 'marathon',
  },
  planDurationWeeks: 16,
  age: 34,
  biologicalSex: 'male',
  runsPerWeek: 5,
  gymSessionsPerWeek: 1,
  sportsPerWeek: 2,
  experienceLevel: 'returning',
  activeLifestyle: true,
  recurringActivities: [
    { sport: 'Cycling', durationMin: 60, frequency: 1, intensity: 'moderate' },
    { sport: 'Swimming', durationMin: 45, frequency: 1, intensity: 'easy' },
  ],
  weeklyTrainingHours: 7,
  pbs: { k5: 1155, k10: 2400, h: 5250 },
  recentRace: { d: 10, t: 2400, weeksAgo: 3 },
  hasSmartwatch: true,
  ltPace: 245,
  vo2max: 53,
};

/**
 * Seed a complete, onboarded reviewer account and mark onboarding done. Returns
 * true on success. The caller should reload afterwards so the app boots into the
 * populated main view.
 */
export function seedReviewerDemo(): boolean {
  const onboarding: OnboardingState = { ...defaultOnboardingState, ...REVIEWER_ONBOARDING };
  updateState({ onboarding });

  const result = initializeSimulator(onboarding);
  if (!result.success) return false;

  // Mirror completeOnboarding() without coupling to the wizard controller.
  const trialExpiry = new Date();
  trialExpiry.setDate(trialExpiry.getDate() + 21);

  updateState({
    hasCompletedOnboarding: true,
    trialExpiry: trialExpiry.toISOString(),
    onboarding: {
      ...onboarding,
      currentStep: 'main-view',
      calculatedRunnerType: result.runnerType ?? null,
      confirmedRunnerType: result.runnerType ?? null,
    },
  });
  saveState();
  return true;
}
