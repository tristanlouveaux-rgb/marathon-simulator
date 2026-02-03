import type { OnboardingState } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Render the fitness data collection page (Step 6.5 - between PBs and Initializing)
 * Asks about smartwatch and collects LT threshold and VO2 max if available
 */
export function renderFitnessData(container: HTMLElement, state: OnboardingState): void {
  const hasLT = state.ltPace !== null && state.ltPace !== undefined;
  const hasVO2 = state.vo2max !== null && state.vo2max !== undefined;

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(7, 10)}

      <div class="max-w-lg w-full">
        <!-- Title -->
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Fitness Data
        </h2>
        <p class="text-gray-400 text-center mb-6">
          Do you have data from a smartwatch or fitness tracker?
        </p>

        <!-- Why we want this data -->
        <div class="bg-blue-900/30 border border-blue-700/50 rounded-xl p-4 mb-6">
          <div class="flex gap-3">
            <svg class="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
            </svg>
            <div class="text-sm">
              <p class="text-blue-300 font-medium mb-1">Why we ask for this data</p>
              <p class="text-blue-200/70 text-xs leading-relaxed">
                Your Lactate Threshold (LT) pace and VO2 max are powerful predictors of race performance.
                Combined with your PBs, they allow us to create more accurate pace zones and better
                forecasts. If your fitness improves faster than expected, we'll automatically
                adjust your training and predictions.
              </p>
            </div>
          </div>
        </div>

        <!-- Smartwatch question -->
        <div class="bg-gray-800 rounded-xl p-5 mb-4">
          <h3 class="text-sm font-medium text-white mb-4">Do you have a compatible smartwatch?</h3>

          <div class="grid grid-cols-2 gap-3 mb-4">
            <button id="has-watch-yes"
              class="py-3 rounded-xl font-medium transition-all
                     ${state.hasSmartwatch === true
                       ? 'bg-emerald-600 text-white border-2 border-emerald-400'
                       : 'bg-gray-700 text-gray-300 border-2 border-transparent hover:border-gray-600'}">
              Yes
            </button>
            <button id="has-watch-no"
              class="py-3 rounded-xl font-medium transition-all
                     ${state.hasSmartwatch === false
                       ? 'bg-emerald-600 text-white border-2 border-emerald-400'
                       : 'bg-gray-700 text-gray-300 border-2 border-transparent hover:border-gray-600'}">
              No
            </button>
          </div>

          <p class="text-xs text-gray-500">
            Garmin, Apple Watch, Polar, COROS, and similar devices can provide this data.
            We're working on direct sync - for now, please enter values manually.
          </p>
        </div>

        <!-- Fitness data inputs (shown when has watch) -->
        <div id="fitness-inputs" class="${state.hasSmartwatch ? '' : 'hidden'} space-y-4">
          <!-- LT Threshold -->
          <div class="bg-gray-800 rounded-xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-medium text-white">Lactate Threshold Pace</h3>
              <span class="text-xs text-gray-500">Optional</span>
            </div>
            <p class="text-xs text-gray-400 mb-3">
              Your LT pace is the fastest pace you can sustain for about an hour.
              Find this in your watch's training status or physiology metrics.
            </p>
            <div class="flex gap-2 items-center">
              <input type="number" id="lt-min" min="2" max="10" placeholder="min"
                value="${hasLT ? Math.floor((state.ltPace || 0) / 60) : ''}"
                class="w-20 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                       text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
              <span class="text-gray-500">:</span>
              <input type="number" id="lt-sec" min="0" max="59" placeholder="sec"
                value="${hasLT ? Math.floor((state.ltPace || 0) % 60) : ''}"
                class="w-20 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                       text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
              <span class="text-gray-400 text-sm">/km</span>
            </div>
          </div>

          <!-- VO2 Max -->
          <div class="bg-gray-800 rounded-xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-medium text-white">VO2 Max</h3>
              <span class="text-xs text-gray-500">Optional</span>
            </div>
            <p class="text-xs text-gray-400 mb-3">
              Your VO2 max measures aerobic capacity. Most smartwatches estimate this
              from your heart rate and pace data.
            </p>
            <div class="flex gap-2 items-center">
              <input type="number" id="vo2-input" min="20" max="90" step="0.1" placeholder="e.g. 52"
                value="${hasVO2 ? state.vo2max : ''}"
                class="w-28 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                       text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
              <span class="text-gray-400 text-sm">ml/kg/min</span>
            </div>
          </div>

          <!-- Heart Rate -->
          <div class="bg-gray-800 rounded-xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-medium text-white">Heart Rate Data</h3>
              <span class="text-xs text-gray-500">Optional</span>
            </div>
            <p class="text-xs text-gray-400 mb-3">
              If your watch reports resting and/or max heart rate, we'll calculate personalised HR zones for each workout.
            </p>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs text-gray-400 mb-1">Resting HR</label>
                <div class="flex gap-2 items-center">
                  <input type="number" id="resting-hr" min="30" max="100" placeholder="e.g. 52"
                    value="${state.restingHR || ''}"
                    class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                           text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
                  <span class="text-gray-400 text-xs">bpm</span>
                </div>
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">Max HR</label>
                <div class="flex gap-2 items-center">
                  <input type="number" id="max-hr" min="120" max="220" placeholder="e.g. 190"
                    value="${state.maxHR || ''}"
                    class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                           text-white text-sm focus:border-emerald-500 focus:outline-none text-center">
                  <span class="text-gray-400 text-xs">bpm</span>
                </div>
              </div>
            </div>
          </div>

          <!-- Sync buttons (future) -->
          <div class="bg-gray-800/50 rounded-xl p-4">
            <p class="text-xs text-gray-500 mb-3">Coming soon: automatic sync</p>
            <div class="flex gap-2">
              <button disabled class="flex-1 py-2 bg-gray-700/50 text-gray-500 rounded-lg text-xs font-medium cursor-not-allowed">
                Connect Garmin
              </button>
              <button disabled class="flex-1 py-2 bg-gray-700/50 text-gray-500 rounded-lg text-xs font-medium cursor-not-allowed">
                Connect Apple Health
              </button>
            </div>
          </div>
        </div>

        <!-- No watch message -->
        <div id="no-watch-message" class="${state.hasSmartwatch === false ? '' : 'hidden'}">
          <div class="bg-gray-800/50 rounded-xl p-4 text-center">
            <p class="text-sm text-gray-400">
              No problem! We'll use your PBs to estimate your fitness level.
              You can always add this data later if you get a smartwatch.
            </p>
          </div>
        </div>

        <button id="continue-fitness"
          class="mt-6 w-full py-3 bg-emerald-600 hover:bg-emerald-500
                 text-white font-medium rounded-xl transition-all">
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
  const noWatchMessage = document.getElementById('no-watch-message');
  const yesBtn = document.getElementById('has-watch-yes');
  const noBtn = document.getElementById('has-watch-no');

  // Yes button
  yesBtn?.addEventListener('click', () => {
    updateOnboarding({ hasSmartwatch: true });
    yesBtn.classList.add('bg-emerald-600', 'text-white', 'border-emerald-400');
    yesBtn.classList.remove('bg-gray-700', 'text-gray-300', 'border-transparent');
    noBtn?.classList.remove('bg-emerald-600', 'text-white', 'border-emerald-400');
    noBtn?.classList.add('bg-gray-700', 'text-gray-300', 'border-transparent');
    fitnessInputs?.classList.remove('hidden');
    noWatchMessage?.classList.add('hidden');
  });

  // No button
  noBtn?.addEventListener('click', () => {
    updateOnboarding({ hasSmartwatch: false, ltPace: null, vo2max: null, restingHR: null, maxHR: null });
    noBtn.classList.add('bg-emerald-600', 'text-white', 'border-emerald-400');
    noBtn.classList.remove('bg-gray-700', 'text-gray-300', 'border-transparent');
    yesBtn?.classList.remove('bg-emerald-600', 'text-white', 'border-emerald-400');
    yesBtn?.classList.add('bg-gray-700', 'text-gray-300', 'border-transparent');
    fitnessInputs?.classList.add('hidden');
    noWatchMessage?.classList.remove('hidden');
  });

  // Continue button
  document.getElementById('continue-fitness')?.addEventListener('click', () => {
    if (state.hasSmartwatch) {
      // Collect LT, VO2, and HR only when user has a watch
      const ltMin = +(document.getElementById('lt-min') as HTMLInputElement)?.value || 0;
      const ltSec = +(document.getElementById('lt-sec') as HTMLInputElement)?.value || 0;
      const vo2 = +(document.getElementById('vo2-input') as HTMLInputElement)?.value || null;

      const ltPace = (ltMin > 0 || ltSec > 0) ? ltMin * 60 + ltSec : null;
      const restingHR = +(document.getElementById('resting-hr') as HTMLInputElement)?.value || null;
      const maxHR = +(document.getElementById('max-hr') as HTMLInputElement)?.value || null;

      updateOnboarding({
        ltPace: ltPace,
        vo2max: vo2,
        restingHR: restingHR,
        maxHR: maxHR,
      });
    }

    nextStep();
  });
}
