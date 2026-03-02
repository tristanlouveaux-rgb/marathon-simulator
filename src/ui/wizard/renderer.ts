import type { OnboardingStep, OnboardingState } from '@/types/onboarding';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { renderWelcome } from './steps/welcome';
import { renderGoals } from './steps/goals';
import { renderBackground } from './steps/background';
import { renderVolume } from './steps/volume';
import { renderPerformance } from './steps/performance';
import { renderFitness } from './steps/fitness';
import { renderStravaHistory } from './steps/strava-history';
import { renderPhysiology } from './steps/physiology';
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

  // Render step, then inject persistent banner after (since steps overwrite innerHTML)
  const shouldShowBanner = step !== 'welcome' && step !== 'main-view' && step !== 'initializing';

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

    case 'strava-history':
      renderStravaHistory(container, state);
      break;

    case 'physiology':
      renderPhysiology(container, state);
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

  // Inject banner after step renders (steps overwrite innerHTML)
  const existing = document.getElementById('onboarding-banner');
  if (existing) existing.remove();
  if (shouldShowBanner) {
    const banner = document.createElement('div');
    banner.id = 'onboarding-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:50;background:var(--c-surface);border-bottom:1px solid var(--c-border);padding:12px 16px;text-align:center;backdrop-filter:blur(4px)';
    banner.innerHTML = `<p style="font-size:13px;color:var(--c-muted)">This takes a little longer than most running apps — we're building a <span style="font-weight:600;color:var(--c-black)">holistic picture of you</span> as a runner.</p>`;
    document.body.appendChild(banner);
  }

  // Inject "Return to plan →" button for mid-plan edit sessions
  const existingReturn = document.getElementById('wizard-return-btn');
  if (existingReturn) existingReturn.remove();
  const isMidPlan = getState().wks.length > 0;
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
      style="position:fixed;bottom:32px;left:32px;display:flex;align-items:center;gap:8px;color:var(--c-muted);background:none;border:none;cursor:pointer;font-size:14px;z-index:50"
    >
      <svg style="width:18px;height:18px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
      </svg>
      Back
    </button>
  `;
}
