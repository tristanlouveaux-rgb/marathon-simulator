import type { OnboardingState } from '@/types/onboarding';
import { MILESTONE_THRESHOLDS, MILESTONE_LABELS } from '@/types/onboarding';
import { initializeSimulator } from '@/state/initialization';
import { cv } from '@/calculations/vdot';
import type { PBs } from '@/types/training';
import { nextStep, updateOnboarding } from '../controller';
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
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(7, 7)}

      <div class="max-w-lg w-full text-center">
        <div id="init-animation" class="mb-8">
          <div class="relative w-24 h-24 mx-auto">
            <svg class="w-full h-full animate-spin-slow" viewBox="0 0 100 100">
              <path fill="currentColor" class="text-emerald-600" d="M50 15a35 35 0 0 1 35 35 35 35 0 0 1-35 35 35 35 0 0 1-35-35 35 35 0 0 1 35-35m0-5a40 40 0 0 0-40 40 40 40 0 0 0 40 40 40 40 0 0 0 40-40 40 40 0 0 0-40-40z"/>
              <circle cx="50" cy="50" r="25" fill="none" stroke="currentColor" class="text-emerald-500" stroke-width="4" stroke-dasharray="20 10"/>
            </svg>
            <div class="absolute inset-0 flex items-center justify-center">
              <svg class="w-10 h-10 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M6.267 3.455a3.066 3.066 0 001.745-.723 3.066 3.066 0 013.976 0 3.066 3.066 0 001.745.723 3.066 3.066 0 012.812 2.812c.051.643.304 1.254.723 1.745a3.066 3.066 0 010 3.976 3.066 3.066 0 00-.723 1.745 3.066 3.066 0 01-2.812 2.812 3.066 3.066 0 00-1.745.723 3.066 3.066 0 01-3.976 0 3.066 3.066 0 00-1.745-.723 3.066 3.066 0 01-2.812-2.812 3.066 3.066 0 00-.723-1.745 3.066 3.066 0 010-3.976 3.066 3.066 0 00.723-1.745 3.066 3.066 0 012.812-2.812zm7.44 5.252a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
              </svg>
            </div>
          </div>
        </div>

        <h2 id="init-title" class="text-2xl font-light text-white mb-3">
          Analyzing your physiology...
        </h2>

        <p id="init-status" class="text-gray-400 text-sm">
          Building a custom plan tailored to you
        </p>

        <div id="init-steps" class="mt-8 space-y-3 text-left max-w-xs mx-auto">
          <div id="step-pbs" class="flex items-center gap-3 text-sm">
            <div class="w-5 h-5 rounded-full bg-emerald-600 flex items-center justify-center">
              <svg class="w-3 h-3 text-white animate-pulse" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16z" clip-rule="evenodd"/>
              </svg>
            </div>
            <span class="text-gray-400">Analyzing personal bests</span>
          </div>
          <div id="step-profile" class="flex items-center gap-3 text-sm opacity-50">
            <div class="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center">
              <div class="w-2 h-2 rounded-full bg-gray-500"></div>
            </div>
            <span class="text-gray-500">Calculating runner profile</span>
          </div>
          <div id="step-plan" class="flex items-center gap-3 text-sm opacity-50">
            <div class="w-5 h-5 rounded-full bg-gray-700 flex items-center justify-center">
              <div class="w-2 h-2 rounded-full bg-gray-500"></div>
            </div>
            <span class="text-gray-500">Generating training plan</span>
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
    titleEl.classList.add('text-emerald-400');
  }

  updateOnboarding({ calculatedRunnerType: result.runnerType });

  await delay(800);
  nextStep();
}

function updateStep(stepId: string, complete: boolean): void {
  const stepEl = document.getElementById(stepId);
  if (!stepEl) return;
  stepEl.classList.remove('opacity-50');
  const iconContainer = stepEl.querySelector('div');
  const textEl = stepEl.querySelector('span');
  if (complete && iconContainer) {
    iconContainer.innerHTML = `<svg class="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>`;
    iconContainer.classList.remove('bg-gray-700');
    iconContainer.classList.add('bg-emerald-600');
    if (textEl) { textEl.classList.remove('text-gray-500'); textEl.classList.add('text-emerald-400'); }
  } else if (iconContainer) {
    iconContainer.innerHTML = `<svg class="w-3 h-3 text-white animate-pulse" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16z" clip-rule="evenodd"/></svg>`;
    iconContainer.classList.remove('bg-gray-700');
    iconContainer.classList.add('bg-emerald-600');
    if (textEl) { textEl.classList.remove('text-gray-500'); textEl.classList.add('text-gray-400'); }
  }
}

function updateStatus(text: string): void {
  const el = document.getElementById('init-status');
  if (el) el.textContent = text;
}

function showError(message: string): void {
  const t = document.getElementById('init-title');
  const s = document.getElementById('init-status');
  if (t) { t.textContent = 'Initialization failed'; t.classList.add('text-red-400'); }
  if (s) { s.textContent = message; s.classList.add('text-red-400'); }
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

  /* eslint-disable no-unreachable */
  const state = _state;
  if (!state.trainingForEvent || !state.raceDistance) return Promise.resolve();
  if (state.runsPerWeek >= 4) return Promise.resolve();

  const vdot = bestVdot(state.pbs);
  if (vdot === 0) return Promise.resolve();

  const thresholds = MILESTONE_THRESHOLDS[state.raceDistance];
  const labels = MILESTONE_LABELS[state.raceDistance];
  if (!thresholds) return Promise.resolve();

  const meters = distMeters(state.raceDistance);
  let goalLabel: string | null = null;

  for (let i = 0; i < thresholds.length; i++) {
    const requiredVdot = cv(meters, thresholds[i]);
    const gap = (requiredVdot - vdot) / requiredVdot;
    if (gap > 0 && gap < 0.04) {
      goalLabel = labels[i];
      break;
    }
  }

  if (!goalLabel) return Promise.resolve();

  // Show modal and wait for user decision
  return new Promise<void>(resolve => {
    const overlay = document.createElement('div');
    overlay.id = 'volume-rec-overlay';
    overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
    overlay.innerHTML = `
      <div class="bg-gray-900 rounded-2xl max-w-md w-full p-6 space-y-5">
        <h3 class="text-lg font-medium text-emerald-400 text-center">Analysis Complete</h3>
        <p class="text-gray-300 text-sm text-center leading-relaxed">
          You are close to your <span class="text-white font-medium">${goalLabel}</span> goal.
          We recommend adding <span class="text-white font-medium">1 run/week</span> to bridge the endurance gap.
        </p>
        <div class="flex flex-col gap-3">
          <button id="btn-optimize-plan"
            class="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition-all">
            Optimize Plan (Recommended)
          </button>
          <button id="btn-keep-volume"
            class="w-full py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-xl transition-all">
            No, keep current volume
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    document.getElementById('btn-optimize-plan')?.addEventListener('click', () => {
      updateOnboarding({ runsPerWeek: state.runsPerWeek + 1 });
      overlay.remove();
      resolve();
    });

    document.getElementById('btn-keep-volume')?.addEventListener('click', () => {
      overlay.remove();
      resolve();
    });
  });
}
