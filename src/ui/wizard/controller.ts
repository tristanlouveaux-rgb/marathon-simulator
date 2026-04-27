import type { OnboardingStep, OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderStep } from './renderer';

/** Consolidated wizard: welcome → goals → connect-strava → review → race-target →
 *  schedule → initializing → runner-type → plan-preview-v2 → main-view.
 *  `manual-entry` is a branch off connect-strava/review, not in the linear order.
 *  `triathlon-setup` is a branch off goals (see nextStep), replacing race-target,
 *  schedule, and runner-type for triathlon users. */
const STEP_ORDER: OnboardingStep[] = [
  'welcome',
  'goals',
  'connect-strava',
  'review',
  'race-target',
  'schedule',
  'initializing',
  'runner-type',
  'plan-preview-v2',
  'main-view',
];

/**
 * Initialize the onboarding wizard
 */
export function initWizard(): void {
  const s = getState();

  if (!s.onboarding) {
    updateState({
      onboarding: { ...defaultOnboardingState },
      hasCompletedOnboarding: false,
    });
    saveState();
  }

  // After soft reset: skip welcome if name already exists
  if (s.onboarding?.name && s.onboarding.currentStep === 'welcome') {
    updateState({
      onboarding: { ...s.onboarding, currentStep: 'goals' },
    });
    saveState();
  }

  // Migration: if persisted currentStep is no longer in the wizard (legacy step
  // removed during cleanup), bump the user to 'goals'. Preserves name/PBs.
  const current = getState().onboarding;
  if (current && !STEP_ORDER.includes(current.currentStep) && current.currentStep !== 'manual-entry') {
    updateState({
      onboarding: { ...current, currentStep: current.name ? 'goals' : 'welcome' },
    });
    saveState();
  }

  renderCurrentStep();
}

/**
 * Get current onboarding state
 */
export function getOnboardingState(): OnboardingState | undefined {
  return getState().onboarding;
}

/**
 * Update onboarding state with partial values
 */
export function updateOnboarding(updates: Partial<OnboardingState>): void {
  const s = getState();
  if (!s.onboarding) return;

  updateState({
    onboarding: {
      ...s.onboarding,
      ...updates,
    },
  });
  saveState();
}

/**
 * Navigate to a specific step
 */
export function goToStep(step: OnboardingStep): void {
  const s = getState();
  if (!s.onboarding) return;

  updateState({
    onboarding: {
      ...s.onboarding,
      currentStep: step,
    },
  });
  saveState();
  renderCurrentStep();
}

/**
 * Advance to the next step
 */
export function nextStep(): void {
  const s = getState();
  if (!s.onboarding) return;

  // Branch: triathlon users route from goals → triathlon-setup → initializing →
  // main-view. The consolidated triathlon-setup step replaces race-target,
  // schedule, and runner-type for this flow (§18.9).
  if (s.onboarding.trainingMode === 'triathlon') {
    if (s.onboarding.currentStep === 'goals') {
      goToStep('triathlon-setup');
      return;
    }
    if (s.onboarding.currentStep === 'triathlon-setup') {
      goToStep('initializing');
      return;
    }
    if (s.onboarding.currentStep === 'initializing') {
      completeOnboarding();
      goToStep('main-view');
      return;
    }
  }

  // Branch: if leaving connect-strava with skippedStrava, route to manual-entry
  if (s.onboarding.currentStep === 'connect-strava' && s.onboarding.skippedStrava) {
    goToStep('manual-entry');
    return;
  }

  // Branch: review diverts to manual-entry when Strava data is insufficient.
  if (s.onboarding.currentStep === 'review' && s.onboarding.skippedStrava) {
    goToStep('manual-entry');
    return;
  }

  // Branch: manual-entry replaces background/volume/performance/fitness/strava-history.
  // Track-only users skip race-target (they already declared their goal on the Goals
  // tile); others advance to race-target.
  if (s.onboarding.currentStep === 'manual-entry') {
    goToStep(s.onboarding.trackOnly ? 'initializing' : 'race-target');
    return;
  }

  // Branch: review (on success) advances to race-target — skips legacy detail screens.
  // Track-only users skip race-target entirely for the same reason.
  if (s.onboarding.currentStep === 'review') {
    goToStep(s.onboarding.trackOnly ? 'initializing' : 'race-target');
    return;
  }

  // Branch: after race-target with Just-Track selected, jump straight to the
  // initializing screen. Schedule + physiology + plan-preview-v2 are all plan-
  // relevant and the initializing short-circuit in initializeSimulator() handles
  // state setup. Avoids five unnecessary screens for a pure tracker.
  if (s.onboarding.currentStep === 'race-target' && s.onboarding.trackOnly) {
    goToStep('initializing');
    return;
  }

  // Branch: after initialization completes in Just-Track mode, skip runner-type +
  // plan-preview-v2 (both depend on a generated plan) and go straight to main-view.
  if (s.onboarding.currentStep === 'initializing' && s.onboarding.trackOnly) {
    completeOnboarding();
    goToStep('main-view');
    return;
  }

  const currentIdx = STEP_ORDER.indexOf(s.onboarding.currentStep);
  let nextIdx = currentIdx + 1;

  // Just-Track users: skip any remaining plan-dependent screens and land on main-view.
  // Belt-and-braces on top of the 'race-target' and 'initializing' branches above.
  if (s.onboarding.trackOnly) {
    while (nextIdx < STEP_ORDER.length && (
      STEP_ORDER[nextIdx] === 'schedule' ||
      STEP_ORDER[nextIdx] === 'runner-type' ||
      STEP_ORDER[nextIdx] === 'plan-preview-v2'
    )) {
      nextIdx++;
    }
  }

  if (nextIdx < STEP_ORDER.length) {
    const completedSteps = s.onboarding.completedSteps.includes(s.onboarding.currentStep)
      ? s.onboarding.completedSteps
      : [...s.onboarding.completedSteps, s.onboarding.currentStep];

    updateState({
      onboarding: {
        ...s.onboarding,
        currentStep: STEP_ORDER[nextIdx],
        completedSteps,
      },
    });
    saveState();
    renderCurrentStep();
  }
}

/**
 * Go back to the previous step
 */
export function previousStep(): void {
  const s = getState();
  if (!s.onboarding) return;

  // Branch: triathlon-setup back → goals.
  if (s.onboarding.currentStep === 'triathlon-setup') {
    goToStep('goals');
    return;
  }

  // Branch: manual-entry back → goals.
  // We can't go back to connect-strava: if Strava is connected it auto-advances,
  // and review auto-diverts back to manual-entry when the data is thin. Clearing
  // skippedStrava doesn't help because review re-sets it. Goals is the last
  // screen the user actually interacted with before the Strava flow swallowed
  // them, so it's the right back target.
  if (s.onboarding.currentStep === 'manual-entry') {
    updateState({
      onboarding: { ...s.onboarding, skippedStrava: false, currentStep: 'goals' },
    });
    saveState();
    renderCurrentStep();
    return;
  }

  // Branch: review back → goals. Same reasoning: connect-strava auto-advances
  // when connected, so there's no stable screen to land on between review and
  // goals.
  if (s.onboarding.currentStep === 'review') {
    updateState({
      onboarding: { ...s.onboarding, skippedStrava: false, currentStep: 'goals' },
    });
    saveState();
    renderCurrentStep();
    return;
  }

  // Branch: race-target back → whichever of review/manual-entry the user came from.
  if (s.onboarding.currentStep === 'race-target') {
    goToStep(s.onboarding.skippedStrava ? 'manual-entry' : 'review');
    return;
  }

  const currentIdx = STEP_ORDER.indexOf(s.onboarding.currentStep);
  if (currentIdx <= 0) return;

  let prevIdx = currentIdx - 1;

  // Skip 'initializing' and 'runner-type' when going back — silent auto-advance steps.
  while (prevIdx > 0 && (
    STEP_ORDER[prevIdx] === 'initializing' ||
    STEP_ORDER[prevIdx] === 'runner-type'
  )) {
    prevIdx--;
  }

  if (prevIdx >= 0) {
    updateState({
      onboarding: {
        ...s.onboarding,
        currentStep: STEP_ORDER[prevIdx],
      },
    });
    saveState();
    renderCurrentStep();
  }
}

/**
 * Mark onboarding as complete and transition to main view
 */
export function completeOnboarding(): void {
  const s = getState();
  if (!s.onboarding) return;

  const trialExpiry = new Date();
  trialExpiry.setDate(trialExpiry.getDate() + 21);

  updateState({
    hasCompletedOnboarding: true,
    trialExpiry: trialExpiry.toISOString(),
    onboarding: {
      ...s.onboarding,
      currentStep: 'main-view',
      completedSteps: [...s.onboarding.completedSteps, s.onboarding.currentStep],
    },
  });
  saveState();
}

/**
 * Upgrade from Just-Track mode: relaunch the wizard at the training-goal step
 * so the user walks goals → race/target → schedule → plan-preview and a plan
 * is generated. Clears `trackOnly` on both the onboarding record and global
 * state; preserves name, PBs, physiology, and Strava-derived fitness baselines
 * (ctlBaseline / historicWeeklyTSS / athleteTier).
 *
 * Wipes `s.wks` (skeleton tracking weeks with no planned workouts) so the
 * initializing step's mid-plan guard (`wks.length > 0 → skip plan gen`)
 * doesn't short-circuit the upgrade. Any activities previously matched into
 * these weeks' `garminActuals` re-sync from `garmin_activities` on the next
 * poll — server-side history is the source of truth.
 */
export function upgradeFromTrackOnly(): void {
  const s = getState();
  if (!s.onboarding) return;

  // Flip onboarding mode and blank the rolling tracking weeks so plan init
  // runs fresh. fitness baselines (CTL, athlete tier, historic km) live on
  // other state fields and are preserved.
  updateState({
    hasCompletedOnboarding: false,
    trackOnly: false,
    wks: [],
    w: 1,
    tw: 0,
    onboarding: {
      ...s.onboarding,
      trackOnly: false,
      trainingFocus: s.onboarding.trainingFocus === 'track' ? null : s.onboarding.trainingFocus,
      currentStep: 'goals',
    },
  });
  saveState();
  renderCurrentStep();
}

/**
 * Downgrade from a generated plan to Just-Track mode. Preserves activity
 * history, CTL, PBs, physiology, and Strava connection — just flips the plan
 * off. Users typically reach this after race day, end of a continuous block,
 * or deliberately via Account → Advanced.
 *
 * The initializing step detects the mode change (`!!onboarding.trackOnly !==
 * !!s.trackOnly`) and re-runs `initializeSimulator`, which takes the trackOnly
 * branch and rewrites `s.wks` as the rolling one-week bucket. Accumulated
 * garminActuals for the current week survive; prior planned weeks are dropped
 * from local state but remain in server-side `garmin_activities`.
 */
export function downgradeToTrackOnly(): void {
  const s = getState();
  if (!s.onboarding) return;
  updateState({
    hasCompletedOnboarding: false,
    onboarding: {
      ...s.onboarding,
      trackOnly: true,
      trainingFocus: 'track',
      continuousMode: true,
      trainingForEvent: null,
      raceDistance: null,
      selectedRace: null,
      customRaceDate: null,
      currentStep: 'initializing',
    },
  });
  saveState();
  renderCurrentStep();
}

/**
 * Reset onboarding to start fresh
 */
export function resetOnboarding(): void {
  updateState({
    onboarding: { ...defaultOnboardingState },
    hasCompletedOnboarding: false,
  });
  saveState();
  renderCurrentStep();
}

/**
 * Get the current step index (1-based for display)
 */
export function getCurrentStepNumber(): number {
  const s = getState();
  if (!s.onboarding) return 1;
  return STEP_ORDER.indexOf(s.onboarding.currentStep) + 1;
}

/**
 * Get total number of steps (excluding main-view)
 */
export function getTotalSteps(): number {
  return STEP_ORDER.length - 1;
}

/**
 * Check if we can go back
 */
export function canGoBack(): boolean {
  const s = getState();
  if (!s.onboarding) return false;
  return STEP_ORDER.indexOf(s.onboarding.currentStep) > 0;
}

/**
 * Render the current step
 */
function renderCurrentStep(): void {
  const s = getState();
  if (!s.onboarding) return;
  renderStep(s.onboarding.currentStep, s.onboarding);
}

// Expose functions globally for onclick handlers
declare global {
  interface Window {
    wizardNext: typeof nextStep;
    wizardPrev: typeof previousStep;
    wizardGoTo: typeof goToStep;
  }
}

if (typeof window !== 'undefined') {
  window.wizardNext = nextStep;
  window.wizardPrev = previousStep;
  window.wizardGoTo = goToStep;
}
