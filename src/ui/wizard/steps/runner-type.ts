import type { OnboardingState } from '@/types/onboarding';
import type { RunnerType } from '@/types/training';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

const TYPE_DESCRIPTIONS: Record<RunnerType, string> = {
  Speed:
    'You excel at shorter, faster races. Your training will build on that speed while developing the endurance to carry it further.',
  Balanced:
    'You perform consistently across all distances. Your training blends speed and endurance work in equal measure.',
  Endurance:
    'You shine over longer distances. Your training will sharpen your speed while building on your natural aerobic strength.',
};

/**
 * Render the runner type confirmation page.
 * Shows calculated runner type with option to override.
 */
export function renderRunnerType(container: HTMLElement, state: OnboardingState): void {
  const calculatedType = state.calculatedRunnerType || 'Balanced';
  const activeType = state.confirmedRunnerType || calculatedType;

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(7, 8)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Your Runner Profile
        </h2>
        <p class="text-gray-400 text-center mb-10">
          Based on your personal bests, we've assessed your running style.
        </p>

        <div class="bg-gray-900 rounded-xl p-6 border border-gray-800">
          <!-- Spectrum -->
          ${renderSpectrum(activeType)}

          <!-- Type selector -->
          <div class="grid grid-cols-3 gap-3 mt-8">
            ${renderTypeButton('Speed', activeType)}
            ${renderTypeButton('Balanced', activeType)}
            ${renderTypeButton('Endurance', activeType)}
          </div>

          <!-- Description -->
          <p id="type-description" class="text-sm text-gray-400 leading-relaxed mt-5">
            ${TYPE_DESCRIPTIONS[activeType]}
          </p>

          <p class="text-xs text-gray-500 mt-4">
            This shapes your race prediction and training emphasis. Tap to change if it doesn't feel right.
          </p>

          <button id="confirm-type"
            class="w-full mt-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition-all">
            Continue
          </button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state, calculatedType);
}

function renderSpectrum(activeType: RunnerType): string {
  const positions: Record<RunnerType, string> = {
    Speed: '16.67%',
    Balanced: '50%',
    Endurance: '83.33%',
  };

  return `
    <div class="relative pt-1">
      <div class="h-2.5 rounded-full bg-gradient-to-r from-orange-500 via-emerald-500 to-blue-500 opacity-80"></div>
      <div class="absolute top-0 transition-all duration-500"
           style="left: ${positions[activeType]}; transform: translateX(-50%);">
        <div class="w-5 h-5 rounded-full bg-white shadow-lg border-2 ${getBorderColor(activeType)}"></div>
      </div>
      <div class="flex justify-between mt-2.5 text-xs text-gray-500">
        <span>Speed</span>
        <span>Balanced</span>
        <span>Endurance</span>
      </div>
    </div>
  `;
}

function renderTypeButton(type: RunnerType, activeType: RunnerType): string {
  const isActive = type === activeType;
  return `
    <button data-type="${type}"
      class="type-option py-3 rounded-lg border text-sm font-medium text-center transition-all
        ${isActive
          ? `border-${getColorName(type)}-600 bg-${getColorName(type)}-600/20 ${getTypeColor(type)}`
          : 'border-gray-700 text-gray-400 hover:bg-gray-800'}">
      ${type}
    </button>
  `;
}

function getColorName(type: RunnerType): string {
  switch (type) {
    case 'Speed': return 'orange';
    case 'Balanced': return 'emerald';
    case 'Endurance': return 'blue';
    default: return 'gray';
  }
}

function getTypeColor(type: RunnerType): string {
  switch (type) {
    case 'Speed': return 'text-orange-400';
    case 'Balanced': return 'text-emerald-400';
    case 'Endurance': return 'text-blue-400';
    default: return 'text-white';
  }
}

function getBorderColor(type: RunnerType): string {
  switch (type) {
    case 'Speed': return 'border-orange-500';
    case 'Balanced': return 'border-emerald-500';
    case 'Endurance': return 'border-blue-500';
    default: return 'border-gray-500';
  }
}

function wireEventHandlers(state: OnboardingState, calculatedType: RunnerType): void {
  // Confirm / Continue
  document.getElementById('confirm-type')?.addEventListener('click', () => {
    const finalType = state.confirmedRunnerType || calculatedType;
    updateState({ typ: finalType });
    saveState();
    nextStep();
  });

  // Type selection — tap to switch
  document.querySelectorAll('.type-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type') as RunnerType;
      updateOnboarding({ confirmedRunnerType: type });
      updateState({ typ: type });
      saveState();
      rerender(state);
    });
  });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) {
        renderRunnerType(container, currentState);
      }
    }
  });
}
