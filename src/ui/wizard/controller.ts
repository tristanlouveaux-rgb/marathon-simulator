import type { OnboardingStep, OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderStep } from './renderer';

/** Consolidated wizard (re-ordered 2026-04-27): welcome → connect-strava → goals →
 *  race-target → schedule → review → initializing → plan-preview-v2 → main-view.
 *
 *  Connect first so backfill + physio sync can run in the background while the
 *  user picks goal/volume; the merged "Athlete Profile" review then displays
 *  what we know once the data has settled (with a wait spinner if not).
 *
 *  `manual-entry` is a branch off connect-strava when the user skips Strava.
 *  `triathlon-setup` is a branch off goals, replacing race-target + schedule
 *  for triathlon users.
 *  `runner-type` was merged into `review` — no longer a separate step. */
const STEP_ORDER: OnboardingStep[] = [
  'welcome',
  'goals',
  'connect-strava',
  'race-target',
  'schedule',
  'review',
  'initializing',
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

  // After soft reset: skip welcome if name already exists. The returning user
  // lands on goals (the post-restructure entry point — connect-strava now sits
  // after goals so triathletes see Strava+watch connect once they've picked
  // their mode).
  if (s.onboarding?.name && s.onboarding.currentStep === 'welcome') {
    updateState({
      onboarding: { ...s.onboarding, currentStep: 'goals' },
    });
    saveState();
  }

  // Migration: if persisted currentStep is no longer in the wizard (legacy step
  // removed during cleanup, e.g. 'runner-type' after the merge into review),
  // bump the user to a sensible re-entry point. Preserves name/PBs.
  const current = getState().onboarding;
  if (current && !STEP_ORDER.includes(current.currentStep) && current.currentStep !== 'manual-entry' && current.currentStep !== 'triathlon-setup') {
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

  // Branch: triathlon users route from goals → triathlon-setup → review →
  // initializing → main-view. The consolidated triathlon-setup step replaces
  // race-target + schedule for this flow (§18.9). Review is shared so tri
  // athletes still see the unified Athlete Profile reveal.
  if (s.onboarding.trainingMode === 'triathlon') {
    if (s.onboarding.currentStep === 'goals') {
      goToStep('connect-strava');
      return;
    }
    if (s.onboarding.currentStep === 'connect-strava') {
      goToStep('triathlon-setup');
      return;
    }
    if (s.onboarding.currentStep === 'triathlon-setup') {
      goToStep('review');
      return;
    }
    if (s.onboarding.currentStep === 'initializing') {
      completeOnboarding();
      goToStep('main-view');
      return;
    }
  }

  // Branch: if leaving connect-strava with skippedStrava, route to manual-entry
  // (where the user enters PBs by hand). Otherwise the linear order takes us to
  // 'goals' next.
  if (s.onboarding.currentStep === 'connect-strava' && s.onboarding.skippedStrava) {
    goToStep('manual-entry');
    return;
  }

  // Branch: manual-entry rejoins the linear order after connect-strava. Since
  // connect-strava now sits after goals, the user has already picked a mode by
  // the time they take the manual detour — route them to the mode-appropriate
  // next step (triathlon-setup for tri, race-target for running).
  if (s.onboarding.currentStep === 'manual-entry') {
    if (s.onboarding.trainingMode === 'triathlon') {
      goToStep('triathlon-setup');
    } else {
      goToStep('race-target');
    }
    return;
  }

  // Branch: race-target → schedule for everyone except track-only. Track-only
  // users skip schedule (no plan to size) but still see the review/profile
  // reveal so they get the same "this is who you are" moment.
  if (s.onboarding.currentStep === 'race-target' && s.onboarding.trackOnly) {
    goToStep('review');
    return;
  }

  // Branch: review → initializing. Initialising runs plan generation; track-only
  // short-circuits inside initializeSimulator(). Linear order would also send us
  // to 'initializing' next, but making it explicit keeps intent visible.
  if (s.onboarding.currentStep === 'review') {
    goToStep('initializing');
    return;
  }

  // Branch: after initialization in Just-Track mode, skip plan-preview-v2 and
  // land on main-view. Plan-preview only makes sense when a plan was generated.
  if (s.onboarding.currentStep === 'initializing' && s.onboarding.trackOnly) {
    completeOnboarding();
    goToStep('main-view');
    return;
  }

  const currentIdx = STEP_ORDER.indexOf(s.onboarding.currentStep);
  let nextIdx = currentIdx + 1;

  // Just-Track users: skip any remaining plan-dependent screens (plan-preview-v2).
  // Belt-and-braces on top of the explicit branches above.
  if (s.onboarding.trackOnly) {
    while (nextIdx < STEP_ORDER.length && STEP_ORDER[nextIdx] === 'plan-preview-v2') {
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

  // Branch: manual-entry back → connect-strava. The user landed here by tapping
  // "Enter manually" on the connect step; clear skippedStrava so they can try
  // OAuth again if they changed their mind.
  if (s.onboarding.currentStep === 'manual-entry') {
    updateState({
      onboarding: { ...s.onboarding, skippedStrava: false, currentStep: 'connect-strava' },
    });
    saveState();
    renderCurrentStep();
    return;
  }

  // Branch: review back depends on mode. Triathlon: → triathlon-setup. Track-only:
  // → race-target (no schedule step in their path). Everyone else: → schedule.
  if (s.onboarding.currentStep === 'review') {
    if (s.onboarding.trainingMode === 'triathlon') {
      goToStep('triathlon-setup');
    } else if (s.onboarding.trackOnly) {
      goToStep('race-target');
    } else {
      goToStep('schedule');
    }
    return;
  }

  // Branch: race-target back → goals (the immediately-preceding step in the new
  // linear order).
  if (s.onboarding.currentStep === 'race-target') {
    goToStep('goals');
    return;
  }

  // Branch: goals back → welcome (immediately-preceding step in the new
  // post-restructure order — connect-strava now sits after goals).
  if (s.onboarding.currentStep === 'goals') {
    goToStep('welcome');
    return;
  }

  const currentIdx = STEP_ORDER.indexOf(s.onboarding.currentStep);
  if (currentIdx <= 0) return;

  let prevIdx = currentIdx - 1;

  // Skip 'initializing' when going back — silent auto-advance step.
  while (prevIdx > 0 && STEP_ORDER[prevIdx] === 'initializing') {
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

  // Flip onboarding mode. Do NOT wipe wks/w/tw here — initializeSimulator
  // replaces them when the wizard completes, and wiping early destroys all
  // historical stats (activity matches, CTL history, VDOT chart data).
  updateState({
    hasCompletedOnboarding: false,
    trackOnly: false,
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
