import type { OnboardingState } from '@/types/onboarding';
import type { RunnerType } from '@/types/training';
import { getState, updateState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Render the runner type confirmation page (Step 8)
 * Shows calculated runner type and allows override
 */
export function renderRunnerType(container: HTMLElement, state: OnboardingState): void {
  const calculatedType = state.calculatedRunnerType || 'Balanced';
  const showOverride = state.confirmedRunnerType !== null && state.confirmedRunnerType !== calculatedType;

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(9, 10)}

      <div class="max-w-lg w-full">
        <!-- Title -->
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Your Runner Profile
        </h2>
        <p class="text-gray-400 text-center mb-8">
          Based on your personal bests, we've analyzed your running characteristics
        </p>

        <!-- Runner Type Display -->
        <div class="bg-gray-800 rounded-xl p-6 mb-6 ${!state.confirmedRunnerType || state.confirmedRunnerType === calculatedType ? 'ring-2 ring-amber-500/60' : ''}"
          ${renderRunnerTypeSpectrum(calculatedType, state.confirmedRunnerType)}

          <div class="mt-6 text-center">
            <div class="text-sm text-gray-400 mb-2">You are a</div>
            <div class="text-3xl font-bold ${getTypeColor(state.confirmedRunnerType || calculatedType)}">
              ${state.confirmedRunnerType || calculatedType}
            </div>
            <div class="text-sm text-gray-400 mt-2">
              ${getTypeDescription(state.confirmedRunnerType || calculatedType)}
            </div>
          </div>
        </div>

        <!-- Explanation -->
        <div class="bg-gray-800/50 rounded-xl p-4 mb-6">
          <h3 class="text-sm font-medium text-white mb-2">What does this mean?</h3>
          <p class="text-xs text-gray-400 leading-relaxed">
            ${getTypeExplanation(state.confirmedRunnerType || calculatedType)}
          </p>
        </div>

        <!-- Confirmation -->
        <div class="text-center mb-6">
          <p class="text-gray-300 mb-4">Does this feel right to you?</p>

          <div class="flex gap-3 justify-center">
            <button id="confirm-type"
              class="px-8 py-3 bg-emerald-600 hover:bg-emerald-500
                     text-white font-medium rounded-xl transition-all">
              Yes, that's me
            </button>
            <button id="show-override"
              class="px-6 py-3 bg-gray-700 hover:bg-gray-600
                     text-gray-200 font-medium rounded-xl transition-all">
              Override
            </button>
          </div>
        </div>

        <!-- Override options (hidden by default) -->
        <div id="override-options" class="${showOverride ? '' : 'hidden'} mt-6">
          <p class="text-sm text-gray-400 text-center mb-4">Select your runner type:</p>
          <div class="grid grid-cols-3 gap-3">
            ${renderTypeOption('Speed', state.confirmedRunnerType === 'Speed')}
            ${renderTypeOption('Balanced', state.confirmedRunnerType === 'Balanced')}
            ${renderTypeOption('Endurance', state.confirmedRunnerType === 'Endurance')}
          </div>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state, calculatedType);
}

function renderRunnerTypeSpectrum(calculatedType: RunnerType, confirmedType: RunnerType | null): string {
  const activeType = confirmedType || calculatedType;
  const positions = {
    Speed: '16.67%',
    Balanced: '50%',
    Endurance: '83.33%',
  };

  return `
    <div class="relative">
      <!-- Spectrum bar -->
      <div class="h-3 rounded-full bg-gradient-to-r from-orange-500 via-emerald-500 to-blue-500 opacity-80"></div>

      <!-- Labels -->
      <div class="flex justify-between mt-2 text-xs text-gray-500">
        <span>Speed</span>
        <span>Balanced</span>
        <span>Endurance</span>
      </div>

      <!-- Indicator -->
      <div class="absolute top-0 -mt-1 transition-all duration-500"
           style="left: ${positions[activeType]}; transform: translateX(-50%);">
        <div class="w-5 h-5 rounded-full bg-white shadow-lg border-2 ${getBorderColor(activeType)}"></div>
      </div>
    </div>
  `;
}

function renderTypeOption(type: RunnerType, isSelected: boolean): string {
  return `
    <button data-type="${type}"
      class="type-option py-4 rounded-xl font-medium transition-all
             ${isSelected
               ? 'bg-emerald-600 text-white border-2 border-emerald-400'
               : 'bg-gray-700 text-gray-300 border-2 border-transparent hover:border-gray-600'}">
      ${type}
    </button>
  `;
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

function getTypeDescription(type: RunnerType): string {
  switch (type) {
    case 'Speed':
      return 'Fast-twitch dominant, excels at shorter distances';
    case 'Balanced':
      return 'Well-rounded profile, adaptable across distances';
    case 'Endurance':
      return 'Slow-twitch dominant, thrives at longer distances';
    default:
      return '';
  }
}

function getTypeExplanation(type: RunnerType): string {
  switch (type) {
    case 'Speed':
      return 'Your performance drops off more at longer distances compared to your shorter race times. ' +
             'Your training will include more speed work and VO2max sessions to leverage your strengths, ' +
             'with targeted long runs to build the endurance base you need.';
    case 'Balanced':
      return 'Your performance is consistent across different distances. ' +
             'Your training will be well-rounded with a mix of speed work, threshold sessions, ' +
             'and endurance runs to maintain your versatility.';
    case 'Endurance':
      return 'Your longer race times are relatively strong compared to your shorter distances. ' +
             'Your training will focus on threshold work and marathon-pace sessions to build on your ' +
             'aerobic strengths, with some speed work to improve your top-end speed.';
    default:
      return '';
  }
}

function wireEventHandlers(state: OnboardingState, calculatedType: RunnerType): void {
  // Confirm button
  document.getElementById('confirm-type')?.addEventListener('click', () => {
    // Use confirmed type or calculated type
    const finalType = state.confirmedRunnerType || calculatedType;
    applyRunnerType(finalType);
    nextStep();
  });

  // Show override options
  document.getElementById('show-override')?.addEventListener('click', () => {
    const overrideEl = document.getElementById('override-options');
    if (overrideEl) {
      overrideEl.classList.toggle('hidden');
    }
  });

  // Type selection
  document.querySelectorAll('.type-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-type') as RunnerType;
      updateOnboarding({ confirmedRunnerType: type });
      // Also update the simulator state runner type
      updateState({ typ: type });
      saveState();
      rerender(state);
    });
  });
}

function applyRunnerType(type: RunnerType): void {
  const s = getState();
  updateState({ typ: type });
  saveState();
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
