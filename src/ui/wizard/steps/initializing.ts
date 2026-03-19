import type { OnboardingState } from '@/types/onboarding';
import { MILESTONE_THRESHOLDS, MILESTONE_LABELS } from '@/types/onboarding';
import { initializeSimulator } from '@/state/initialization';
import { cv } from '@/calculations/vdot';
import type { PBs } from '@/types/training';
import { nextStep, updateOnboarding } from '../controller';
import { getState } from '@/state/store';
import { renderProgressIndicator } from '../renderer';

// Re-export for backwards compatibility
export { initializeSimulator as initializeSimulatorFromOnboarding } from '@/state/initialization';
export type { CalculationResult } from '@/state/initialization';

/**
 * Render the initialization animation
 * Shows loading animation while calculating the plan
 */
export function renderInitializing(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px">
      ${renderProgressIndicator(7, 8)}

      <div style="max-width:480px;width:100%;text-align:center">
        <div id="init-animation" style="margin-bottom:32px">
          <div style="position:relative;width:80px;height:80px;margin:0 auto">
            <svg class="animate-spin-slow" style="width:100%;height:100%" viewBox="0 0 100 100">
              <path fill="currentColor" style="color:var(--c-black);opacity:0.15" d="M50 15a35 35 0 0 1 35 35 35 35 0 0 1-35 35 35 35 0 0 1-35-35 35 35 0 0 1 35-35m0-5a40 40 0 0 0-40 40 40 40 0 0 0 40 40 40 40 0 0 0 40-40 40 40 0 0 0-40-40z"/>
              <circle cx="50" cy="50" r="25" fill="none" style="color:var(--c-black);opacity:0.25" stroke="currentColor" stroke-width="4" stroke-dasharray="20 10"/>
            </svg>
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
              <svg style="width:32px;height:32px;color:var(--c-black)" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
              </svg>
            </div>
          </div>
        </div>

        <h2 id="init-title" style="font-size:1.5rem;font-weight:300;color:var(--c-black);margin-bottom:12px">
          Analyzing your physiology...
        </h2>

        <p id="init-status" style="font-size:14px;color:var(--c-muted)">
          Building a custom plan tailored to you
        </p>

        <div id="init-steps" style="margin-top:32px;display:flex;flex-direction:column;gap:12px;text-align:left;max-width:240px;margin-left:auto;margin-right:auto">
          <div id="step-pbs" style="display:flex;align-items:center;gap:12px;font-size:14px">
            <div id="step-pbs-icon" style="width:20px;height:20px;border-radius:50%;background:var(--c-black);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <svg style="width:10px;height:10px;color:#FDFCF7" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16z" clip-rule="evenodd"/>
              </svg>
            </div>
            <span id="step-pbs-text" style="color:var(--c-black)">Analyzing personal bests</span>
          </div>
          <div id="step-profile" style="display:flex;align-items:center;gap:12px;font-size:14px;opacity:0.4">
            <div id="step-profile-icon" style="width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <div style="width:6px;height:6px;border-radius:50%;background:rgba(0,0,0,0.4)"></div>
            </div>
            <span id="step-profile-text" style="color:var(--c-faint)">Calculating runner profile</span>
          </div>
          <div id="step-plan" style="display:flex;align-items:center;gap:12px;font-size:14px;opacity:0.4">
            <div id="step-plan-icon" style="width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <div style="width:6px;height:6px;border-radius:50%;background:rgba(0,0,0,0.4)"></div>
            </div>
            <span id="step-plan-text" style="color:var(--c-faint)">Generating training plan</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes spin-slow {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .animate-spin-slow {
      animation: spin-slow 3s linear infinite;
    }
  `;
  document.head.appendChild(style);

  runInitialization(state);
}

async function runInitialization(state: OnboardingState): Promise<void> {
  // Mid-plan: user arrived via "Edit Settings". Keep existing plan — just advance.
  if (getState().wks.length > 0) {
    nextStep();
    return;
  }

  await delay(600);

  updateStep('step-pbs', true);
  updateStatus('Mapping your physiology to training zones');

  // Smart recommendation: pause if volume upgrade is warranted
  await checkVolumeRecommendation(state);

  updateStep('step-profile', false);
  await delay(500);

  const result = initializeSimulator(state);

  if (!result.success) {
    showError(result.error || 'Failed to initialize plan');
    return;
  }

  updateStep('step-profile', true);
  updateStep('step-plan', false);
  updateStatus('Building your custom training plan');
  await delay(600);

  updateStep('step-plan', true);
  updateStatus('Your plan is ready!');

  const titleEl = document.getElementById('init-title');
  if (titleEl) {
    titleEl.textContent = 'Your plan is ready!';
    titleEl.style.color = 'var(--c-black)';
  }

  updateOnboarding({ calculatedRunnerType: result.runnerType });

  await delay(800);
  nextStep();
}

function updateStep(stepId: string, complete: boolean): void {
  const stepEl = document.getElementById(stepId);
  if (!stepEl) return;
  stepEl.style.opacity = '1';
  const iconEl = document.getElementById(`${stepId}-icon`);
  const textEl = document.getElementById(`${stepId}-text`);
  if (complete && iconEl) {
    iconEl.style.background = 'var(--c-black)';
    iconEl.innerHTML = `<svg style="width:10px;height:10px;color:#FDFCF7" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`;
    if (textEl) textEl.style.color = 'var(--c-black)';
  } else if (iconEl) {
    iconEl.style.background = 'var(--c-black)';
    iconEl.innerHTML = `<svg style="width:10px;height:10px;color:#FDFCF7" class="animate-pulse" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16z" clip-rule="evenodd"/></svg>`;
    if (textEl) textEl.style.color = 'var(--c-muted)';
  }
}

function updateStatus(text: string): void {
  const el = document.getElementById('init-status');
  if (el) el.textContent = text;
}

function showError(message: string): void {
  const t = document.getElementById('init-title');
  const s = document.getElementById('init-status');
  if (t) { t.textContent = 'Initialization failed'; t.style.color = 'var(--c-warn)'; }
  if (s) { s.textContent = message; s.style.color = 'var(--c-warn)'; }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** PB keys to meters */
const PB_METERS: Record<string, number> = { k5: 5000, k10: 10000, h: 21097, m: 42195 };

/** Best VDOT from PBs */
function bestVdot(pbs: PBs): number {
  let best = 0;
  for (const [key, meters] of Object.entries(PB_METERS)) {
    const t = (pbs as any)[key] as number | undefined;
    if (t && t > 0) best = Math.max(best, cv(meters, t));
  }
  return best;
}

/** Race distance key to meters */
function distMeters(dist: string): number {
  return dist === 'marathon' ? 42195 : dist === 'half' ? 21097 : dist === '10k' ? 10000 : 5000;
}

/**
 * Check if runner should be recommended a volume upgrade.
 * Returns a promise that resolves after the user dismisses the modal (or immediately if no recommendation).
 */
function checkVolumeRecommendation(_state: OnboardingState): Promise<void> {
  // Milestone nudging is handled on the assessment page via plan comparison cards.
  // No popup needed here — the user sees both plans with times and can choose.
  return Promise.resolve();
}
