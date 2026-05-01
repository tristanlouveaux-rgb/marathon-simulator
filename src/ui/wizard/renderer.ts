import type { OnboardingStep, OnboardingState } from '@/types/onboarding';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderWelcome } from './steps/welcome';
import { renderGoals } from './steps/goals';
import { renderConnectStrava } from './steps/connect-strava';
import { renderManualEntry } from './steps/manual-entry';
import { renderReview } from './steps/review';
import { renderInitializing } from './steps/initializing';
import { renderRaceTarget } from './steps/race-target';
import { renderSchedule } from './steps/schedule';
import { renderPlanPreviewV2 } from './steps/plan-preview-v2';
import { renderRunnerType } from './steps/runner-type';
import { renderTriathlonSetup } from './steps/triathlon-setup';

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

  switch (step) {
    // --- New consolidated steps ---
    case 'welcome':
      renderWelcome(container);
      break;

    case 'goals':
      renderGoals(container, state);
      break;

    case 'connect-strava':
      renderConnectStrava(container, state);
      break;

    case 'manual-entry':
      renderManualEntry(container, state);
      break;

    case 'review':
      renderReview(container, state);
      break;

    case 'initializing':
      renderInitializing(container, state);
      break;

    case 'race-target':
      renderRaceTarget(container, state);
      break;

    case 'schedule':
      renderSchedule(container, state);
      break;

    case 'plan-preview-v2':
      renderPlanPreviewV2(container, state);
      break;

    case 'runner-type':
      renderRunnerType(container, state);
      break;

    case 'triathlon-setup':
      renderTriathlonSetup(container, state);
      break;

    case 'main-view':
      transitionToMainView();
      break;

    default:
      console.error(`Unknown step: ${step}`);
  }

  // Kill any lingering banner from prior render
  document.getElementById('onboarding-banner')?.remove();

  // Inject "Return to plan →" button for mid-plan edit sessions
  const existingReturn = document.getElementById('wizard-return-btn');
  if (existingReturn) existingReturn.remove();
  const isMidPlan = (getState().wks?.length ?? 0) > 0;
  const showReturn = isMidPlan && step !== 'welcome' && step !== 'main-view' && step !== 'initializing';
  if (showReturn) {
    const btn = document.createElement('button');
    btn.id = 'wizard-return-btn';
    btn.style.cssText = 'position:fixed;bottom:32px;right:32px;display:flex;align-items:center;gap:6px;color:var(--c-muted);background:none;border:none;cursor:pointer;font-size:14px;z-index:50';
    btn.innerHTML = `Return to plan <svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;
    btn.addEventListener('click', () => {
      const s = getMutableState();
      s.hasCompletedOnboarding = true;
      saveState();
      document.getElementById('onboarding-banner')?.remove();
      document.getElementById('wizard-return-btn')?.remove();
      import('@/ui/main-view').then(({ renderMainView }) => {
        renderMainView();
      });
    });
    document.body.appendChild(btn);
  }
}

/**
 * Transition to the main workout view
 */
function transitionToMainView(): void {
  // Mark onboarding complete so future reloads route directly to renderMainView()
  // and detectMissedWeeks() works correctly.
  const s = getMutableState();
  s.hasCompletedOnboarding = true;
  saveState();
  document.getElementById('onboarding-banner')?.remove();
  document.getElementById('wizard-return-btn')?.remove();
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

    let dotStyle = 'height:8px;border-radius:4px;transition:all 0.3s;';
    if (isActive) {
      dotStyle += 'width:28px;background:var(--c-black);';
    } else if (isCompleted) {
      dotStyle += 'width:8px;background:rgba(0,0,0,0.4);';
    } else {
      dotStyle += 'width:8px;background:rgba(0,0,0,0.12);';
    }

    dots.push(`<div style="${dotStyle}"></div>`);
  }

  return `
    <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:32px">
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
      class="m-btn-glass"
      style="position:fixed;bottom:32px;left:32px;padding:10px 16px;font-size:13px;z-index:50"
    >
      <svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
      </svg>
      Back
    </button>
  `;
}
