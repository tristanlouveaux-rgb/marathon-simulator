import type { OnboardingStep, OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderStep } from './renderer';

/** Consolidated wizard step order (~5 user-facing steps + init + main-view) */
const STEP_ORDER: OnboardingStep[] = [
  'welcome',
  'goals',
  'background',
  'volume',
  'performance',
  'fitness',
  'initializing',
  'runner-type',
  'assessment',
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

  const currentIdx = STEP_ORDER.indexOf(s.onboarding.currentStep);
  let nextIdx = currentIdx + 1;

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

  const currentIdx = STEP_ORDER.indexOf(s.onboarding.currentStep);
  if (currentIdx <= 0) return;

  let prevIdx = currentIdx - 1;

  // Skip 'initializing' when going back (it's an auto-advance animation)
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

window.wizardNext = nextStep;
window.wizardPrev = previousStep;
window.wizardGoTo = goToStep;
