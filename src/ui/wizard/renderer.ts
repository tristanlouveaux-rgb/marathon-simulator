import type { OnboardingStep, OnboardingState } from '@/types/onboarding';
import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { releaseHeldTrimpSyncs } from '@/data/trimp-sex-gate';
import { restoreJustTrackIfNoPlanBuilt } from './controller';
import { renderWelcome } from './steps/welcome';
import { renderGoals } from './steps/goals';
import { renderConnectData } from './steps/connect-data';
import { renderManualEntry } from './steps/manual-entry';
import { renderAboutYou } from './steps/about-you';
import { renderReview } from './steps/review';
import { renderInitializing } from './steps/initializing';
import { renderRaceTarget } from './steps/race-target';
import { renderSchedule } from './steps/schedule';
import { renderPlanPreviewV2 } from './steps/plan-preview-v2';
import { renderCoachContract } from './steps/coach-contract';
import { renderRunnerType } from './steps/runner-type';
import { renderTriathlonSetup } from './steps/triathlon-setup';
import { renderTriPastRace } from './steps/tri-past-race';
import { renderCyclingSetup } from './steps/cycling-setup';
import { renderHyroxSetup } from './steps/hyrox-setup';
import { renderWorkoutPreview } from './steps/workout-preview';
import { renderTriWorkoutPreview } from './steps/tri-workout-preview';
import { renderTriPlanForecast } from './steps/tri-plan-forecast';
import { renderHyroxWorkoutPreview } from './steps/hyrox-workout-preview';
import { renderCommute } from './steps/commute';

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

    case 'connect-data':
      renderConnectData(container, state);
      break;

    case 'manual-entry':
      renderManualEntry(container, state);
      break;

    case 'about-you':
      renderAboutYou(container, state);
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

    case 'commute':
      renderCommute(container, state);
      break;

    case 'plan-preview-v2':
      renderPlanPreviewV2(container, state);
      break;

    case 'coach-contract':
      renderCoachContract(container, state);
      break;

    case 'runner-type':
      renderRunnerType(container, state);
      break;

    case 'triathlon-setup':
      renderTriathlonSetup(container, state);
      break;

    case 'tri-past-race':
      renderTriPastRace(container, state);
      break;

    case 'cycling-setup':
      renderCyclingSetup(container, state);
      break;

    case 'hyrox-setup':
      renderHyroxSetup(container, state);
      break;

    case 'workout-preview':
      renderWorkoutPreview(container, state);
      break;

    case 'tri-workout-preview':
      renderTriWorkoutPreview(container, state);
      break;

    case 'tri-plan-forecast':
      renderTriPlanForecast(container, state);
      break;

    case 'hyrox-workout-preview':
      renderHyroxWorkoutPreview(container, state);
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
    btn.style.cssText = 'position:fixed;bottom:calc(32px + env(safe-area-inset-bottom, 0px));right:32px;display:flex;align-items:center;gap:6px;color:var(--c-muted);background:none;border:none;cursor:pointer;font-size:14px;z-index:50';
    btn.innerHTML = `Return to plan <svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;
    btn.addEventListener('click', () => {
      // Backing out of a Just-Track upgrade (no plan was built): drop any mode
      // picked on the way, so the user is wholly back in Just-Track. Runs
      // before getMutableState because it replaces the state object.
      restoreJustTrackIfNoPlanBuilt();
      const s = getMutableState();
      s.hasCompletedOnboarding = true;
      saveState();
      // Leaving the wizard opens the sex gate (trimp-sex-gate.ts): the launch
      // syncs it held at goals / connect-data / about-you run now with the
      // canonical s.biologicalSex. No step change follows, so nothing else
      // would release them before the next launch.
      void releaseHeldTrimpSyncs(s);
      document.getElementById('onboarding-banner')?.remove();
      document.getElementById('wizard-return-btn')?.remove();
      // On-demand has no plan — land on Home (where sessions are generated), not the
      // empty Plan view that renderMainView() shows.
      if (s.trackOnly) {
        import('@/ui/home-view').then(({ renderHomeView }) => renderHomeView());
      } else {
        import('@/ui/main-view').then(({ renderMainView }) => renderMainView());
      }
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
  // On-demand lands on Home (no plan to show); other modes land on the Plan view.
  if (s.trackOnly) {
    import('@/ui/home-view').then(({ renderHomeView }) => renderHomeView());
  } else {
    import('@/ui/main-view').then(({ renderMainView }) => renderMainView());
  }
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
      style="position:fixed;bottom:calc(32px + env(safe-area-inset-bottom, 0px));left:32px;padding:10px 16px;font-size:13px;z-index:50"
    >
      <svg style="width:16px;height:16px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
      </svg>
      Back
    </button>
  `;
}
