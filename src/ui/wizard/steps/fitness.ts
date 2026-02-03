import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Consolidated Fitness step: Have Watch? [No] -> Auto-advance. [Yes] -> LT/VO2/HR inputs.
 */
export function renderFitness(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(6, 7)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Fitness Data
        </h2>
        <p class="text-gray-400 text-center mb-6">
          Do you have data from a smartwatch?
        </p>

        <!-- Yes/No -->
        <div class="bg-gray-800 rounded-xl p-5 mb-4">
          <div class="grid grid-cols-2 gap-3 mb-3">
            <button id="has-watch-yes"
              class="py-3 rounded-xl font-medium transition-all border-2
                     ${state.hasSmartwatch === true
                       ? 'bg-emerald-600 text-white border-emerald-400'
                       : 'bg-gray-700 text-gray-300 border-transparent hover:border-gray-600'}">
              Yes
            </button>
            <button id="has-watch-no"
              class="py-3 rounded-xl font-medium transition-all border-2
                     ${state.hasSmartwatch === false
                       ? 'bg-emerald-600 text-white border-emerald-400'
                       : 'bg-gray-700 text-gray-300 border-transparent hover:border-gray-600'}">
              No
            </button>
          </div>
          <p class="text-xs text-gray-500">Garmin, Apple Watch, Polar, COROS, etc.</p>
        </div>

        <!-- Fitness inputs (shown when yes) -->
        <div id="fitness-inputs" class="${state.hasSmartwatch === true ? '' : 'hidden'} space-y-4">
          <div class="bg-gray-800 rounded-xl p-5">
            <h3 class="text-sm font-medium text-white mb-3">Lactate Threshold Pace <span class="text-xs text-gray-500">(Optional)</span></h3>
            <p class="text-xs text-gray-400 mb-3">Fastest pace you can sustain for ~1 hour</p>
            <div class="flex gap-2 items-center">
              <input type="number" id="lt-min" min="2" max="10" placeholder="min"
                value="${state.ltPace ? Math.floor(state.ltPace / 60) : ''}"
                class="w-20 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
              <span class="text-gray-500">:</span>
              <input type="number" id="lt-sec" min="0" max="59" placeholder="sec"
                value="${state.ltPace ? Math.floor(state.ltPace % 60) : ''}"
                class="w-20 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
              <span class="text-gray-400 text-sm">/km</span>
            </div>
          </div>

          <div class="bg-gray-800 rounded-xl p-5">
            <h3 class="text-sm font-medium text-white mb-3">VO2 Max <span class="text-xs text-gray-500">(Optional)</span></h3>
            <div class="flex gap-2 items-center">
              <input type="number" id="vo2-input" min="20" max="90" step="0.1" placeholder="e.g. 52"
                value="${state.vo2max || ''}"
                class="w-28 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
              <span class="text-gray-400 text-sm">ml/kg/min</span>
            </div>
          </div>

          <!-- Heart Rate Data -->
          <div class="bg-gray-800 rounded-xl p-5">
            <h3 class="text-sm font-medium text-white mb-3">Heart Rate <span class="text-xs text-gray-500">(Optional)</span></h3>
            <p class="text-xs text-gray-400 mb-3">For personalised HR training zones</p>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-gray-400 mb-1">Resting HR</label>
                <div class="flex gap-2 items-center">
                  <input type="number" id="resting-hr" min="30" max="100" placeholder="e.g. 52"
                    value="${state.restingHR || ''}"
                    class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
                  <span class="text-gray-400 text-xs">bpm</span>
                </div>
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">Max HR</label>
                <div class="flex gap-2 items-center">
                  <input type="number" id="max-hr" min="120" max="220" placeholder="e.g. 190"
                    value="${state.maxHR || ''}"
                    class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
                  <span class="text-gray-400 text-xs">bpm</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <button id="continue-fitness"
          class="mt-6 w-full py-3 bg-emerald-600 hover:bg-emerald-500
                 text-white font-medium rounded-xl transition-all
                 ${state.hasSmartwatch === null ? 'opacity-50 cursor-not-allowed' : ''}"
          ${state.hasSmartwatch === null ? 'disabled' : ''}>
          Continue
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state);
}

function wireEventHandlers(state: OnboardingState): void {
  const fitnessInputs = document.getElementById('fitness-inputs');

  // Yes → show inputs
  document.getElementById('has-watch-yes')?.addEventListener('click', () => {
    updateOnboarding({ hasSmartwatch: true });
    rerender(state);
  });

  // No → auto-advance immediately
  document.getElementById('has-watch-no')?.addEventListener('click', () => {
    updateOnboarding({ hasSmartwatch: false, ltPace: null, vo2max: null, restingHR: null, maxHR: null });
    nextStep();
  });

  // Continue
  document.getElementById('continue-fitness')?.addEventListener('click', () => {
    if (state.hasSmartwatch === null) return;

    if (state.hasSmartwatch) {
      const ltMin = +(document.getElementById('lt-min') as HTMLInputElement)?.value || 0;
      const ltSec = +(document.getElementById('lt-sec') as HTMLInputElement)?.value || 0;
      const vo2 = +(document.getElementById('vo2-input') as HTMLInputElement)?.value || null;
      const ltPace = (ltMin > 0 || ltSec > 0) ? ltMin * 60 + ltSec : null;
      const restingHR = +(document.getElementById('resting-hr') as HTMLInputElement)?.value || null;
      const maxHR = +(document.getElementById('max-hr') as HTMLInputElement)?.value || null;

      updateOnboarding({ ltPace, vo2max: vo2, restingHR, maxHR });
    }
    nextStep();
  });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderFitness(container, currentState);
    }
  });
}
