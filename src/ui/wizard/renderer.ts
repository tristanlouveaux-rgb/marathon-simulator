import type { OnboardingStep, OnboardingState } from '@/types/onboarding';
import { renderWelcome } from './steps/welcome';
import { renderGoals } from './steps/goals';
import { renderBackground } from './steps/background';
import { renderVolume } from './steps/volume';
import { renderPerformance } from './steps/performance';
import { renderFitness } from './steps/fitness';
import { renderInitializing } from './steps/initializing';
import { renderAssessment } from './steps/assessment';

// Legacy step imports (kept for backwards compat if state references old steps)
import { renderTrainingGoal } from './steps/training-goal';
import { renderEventSelection } from './steps/event-selection';
import { renderCommute } from './steps/commute';
import { renderFrequency } from './steps/frequency';
import { renderActivities } from './steps/activities';
import { renderPBs } from './steps/pbs';
import { renderFitnessData } from './steps/fitness-data';
import { renderRunnerType } from './steps/runner-type';
import { renderPlanPreview } from './steps/plan-preview';

/**
 * Get the app root container
 */
function getAppRoot(): HTMLElement | null {
  return document.getElementById('app-root');
}

/**
 * Render a specific wizard step
 */
export function renderStep(step: OnboardingStep, state: OnboardingState): void {
  const container = getAppRoot();
  if (!container) {
    console.error('App root container not found');
    return;
  }

  // Clear existing content
  container.innerHTML = '';

  // Add persistent top banner (except on welcome and main-view)
  if (step !== 'welcome' && step !== 'main-view') {
    const banner = document.createElement('div');
    banner.className = 'fixed top-0 left-0 right-0 z-50 bg-gray-900/90 backdrop-blur border-b border-gray-800 px-4 py-2 text-center';
    banner.innerHTML = `<p class="text-xs text-gray-400">Building your perfect plan... <span class="text-gray-500">Takes ~2 mins</span></p>`;
    container.appendChild(banner);
  }

  switch (step) {
    // --- New consolidated steps ---
    case 'welcome':
      renderWelcome(container);
      break;

    case 'goals':
      renderGoals(container, state);
      break;

    case 'background':
      renderBackground(container, state);
      break;

    case 'volume':
      renderVolume(container, state);
      break;

    case 'performance':
      renderPerformance(container, state);
      break;

    case 'fitness':
      renderFitness(container, state);
      break;

    case 'initializing':
      renderInitializing(container, state);
      break;

    case 'assessment':
      renderAssessment(container, state);
      break;

    case 'main-view':
      transitionToMainView();
      break;

    // --- Legacy steps (fallback) ---
    case 'training-goal':
      renderTrainingGoal(container, state);
      break;

    case 'event-selection':
      renderEventSelection(container, state);
      break;

    case 'commute':
      renderCommute(container, state);
      break;

    case 'frequency':
      renderFrequency(container, state);
      break;

    case 'activities':
      renderActivities(container, state);
      break;

    case 'pbs':
      renderPBs(container, state);
      break;

    case 'fitness-data':
      renderFitnessData(container, state);
      break;

    case 'runner-type':
      renderRunnerType(container, state);
      break;

    case 'plan-preview':
      renderPlanPreview(container, state);
      break;

    default:
      console.error(`Unknown step: ${step}`);
  }
}

/**
 * Transition to the main workout view
 */
function transitionToMainView(): void {
  import('@/ui/main-view').then(({ renderMainView }) => {
    renderMainView();
  });
}

/**
 * Generate progress indicator HTML
 */
export function renderProgressIndicator(currentStep: number, totalSteps: number): string {
  const dots = [];
  for (let i = 1; i <= totalSteps; i++) {
    const isActive = i === currentStep;
    const isCompleted = i < currentStep;

    let dotClass = 'w-2 h-2 rounded-full transition-all duration-300 ';
    if (isActive) {
      dotClass += 'w-8 bg-emerald-500';
    } else if (isCompleted) {
      dotClass += 'bg-emerald-600';
    } else {
      dotClass += 'bg-gray-700';
    }

    dots.push(`<div class="${dotClass}"></div>`);
  }

  return `
    <div class="flex items-center justify-center gap-2 mb-8">
      ${dots.join('')}
    </div>
  `;
}

/**
 * Generate back button HTML
 */
export function renderBackButton(show: boolean = true): string {
  if (!show) return '';

  return `
    <button
      onclick="window.wizardPrev()"
      class="fixed bottom-8 left-8 flex items-center gap-2 text-gray-400 hover:text-white
             transition-colors duration-200"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
      </svg>
      <span class="text-sm">Back</span>
    </button>
  `;
}
