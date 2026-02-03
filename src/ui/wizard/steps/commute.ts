import type { OnboardingState } from '@/types/onboarding';
import type { CommuteConfig } from '@/types/state';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Render the commute question (Step 4)
 * Single-page inline layout: Yes/No toggle with expandable config
 */
export function renderCommute(container: HTMLElement, state: OnboardingState): void {
  const config = state.commuteConfig || {
    enabled: true,
    distanceKm: 5,
    isBidirectional: false,
    commuteDaysPerWeek: 2,
  };

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(4, 10)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Run Commute
        </h2>
        <p class="text-gray-400 text-center mb-8">
          Do you run more than 5km to work?
        </p>

        <!-- Yes / No Toggle -->
        <div class="flex gap-3 justify-center mb-6">
          <button id="commute-yes"
            class="flex-1 max-w-[160px] py-4 rounded-xl font-medium transition-all border-2
                   ${state.runsToWork === true
                     ? 'bg-emerald-600 text-white border-emerald-500'
                     : 'bg-gray-800 text-gray-400 border-transparent hover:border-gray-600'}">
            Yes
          </button>
          <button id="commute-no"
            class="flex-1 max-w-[160px] py-4 rounded-xl font-medium transition-all border-2
                   ${state.runsToWork === false
                     ? 'bg-gray-700 text-white border-gray-500'
                     : 'bg-gray-800 text-gray-400 border-transparent hover:border-gray-600'}">
            No
          </button>
        </div>

        <!-- Expandable Config (shown when Yes) -->
        <div id="commute-config" class="${state.runsToWork === true ? '' : 'hidden'}">
          <div class="bg-gray-800 rounded-xl p-6 space-y-5 mb-4">
            <!-- Distance -->
            <div>
              <label class="block text-sm text-gray-400 mb-2">One-way distance (km)</label>
              <input type="number" id="commute-distance"
                min="1" max="25" step="0.5"
                value="${config.distanceKm}"
                class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg
                       text-white text-lg focus:border-emerald-500 focus:outline-none">
            </div>

            <!-- Bidirectional -->
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" id="commute-bidirectional"
                ${config.isBidirectional ? 'checked' : ''}
                class="w-5 h-5 rounded bg-gray-900 border-gray-700 text-emerald-500
                       focus:ring-emerald-500 focus:ring-offset-gray-800">
              <div>
                <span class="text-white text-sm">Run both ways</span>
                <p class="text-xs text-gray-500">Count morning and evening as separate runs</p>
              </div>
            </label>

            <!-- Days per week -->
            <div>
              <label class="block text-sm text-gray-400 mb-2">Days per week</label>
              <div class="flex gap-2">
                ${[1, 2, 3, 4, 5].map(n => `
                  <button data-days="${n}"
                    class="commute-day flex-1 py-3 rounded-lg font-medium transition-all
                           ${config.commuteDaysPerWeek === n
                             ? 'bg-emerald-600 text-white'
                             : 'bg-gray-900 text-gray-400 hover:bg-gray-750'}">
                    ${n}
                  </button>
                `).join('')}
              </div>
            </div>
          </div>
        </div>

        <!-- No-commute note -->
        <div id="no-commute-note" class="${state.runsToWork === false ? '' : 'hidden'}">
          <p class="text-sm text-gray-500 text-center mb-4">
            No problem — you can always add commute runs later in settings.
          </p>
        </div>

        <button id="continue-commute"
          class="w-full py-3 bg-emerald-600 hover:bg-emerald-500
                 text-white font-medium rounded-xl transition-all
                 ${state.runsToWork === null ? 'opacity-50 cursor-not-allowed' : ''}"
          ${state.runsToWork === null ? 'disabled' : ''}>
          Continue
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state, config);
}

function wireEventHandlers(state: OnboardingState, config: CommuteConfig): void {
  document.getElementById('commute-yes')?.addEventListener('click', () => {
    updateOnboarding({
      runsToWork: true,
      commuteConfig: state.commuteConfig || {
        enabled: true,
        distanceKm: 5,
        isBidirectional: false,
        commuteDaysPerWeek: 2,
      },
    });
    rerender(state);
  });

  document.getElementById('commute-no')?.addEventListener('click', () => {
    updateOnboarding({ runsToWork: false, commuteConfig: null });
    rerender(state);
  });

  // Config fields
  const distanceInput = document.getElementById('commute-distance') as HTMLInputElement;
  if (distanceInput) {
    distanceInput.addEventListener('change', () => {
      updateCommuteConfig(state, { distanceKm: parseFloat(distanceInput.value) || 5 });
    });
  }

  const bidirectionalCheckbox = document.getElementById('commute-bidirectional') as HTMLInputElement;
  if (bidirectionalCheckbox) {
    bidirectionalCheckbox.addEventListener('change', () => {
      updateCommuteConfig(state, { isBidirectional: bidirectionalCheckbox.checked });
    });
  }

  document.querySelectorAll('.commute-day').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.getAttribute('data-days') || '2');
      updateCommuteConfig(state, { commuteDaysPerWeek: days });
      rerender(state);
    });
  });

  document.getElementById('continue-commute')?.addEventListener('click', () => {
    if (state.runsToWork !== null) nextStep();
  });
}

function updateCommuteConfig(state: OnboardingState, updates: Partial<CommuteConfig>): void {
  const current = state.commuteConfig || {
    enabled: true,
    distanceKm: 5,
    isBidirectional: false,
    commuteDaysPerWeek: 2,
  };
  updateOnboarding({ commuteConfig: { ...current, ...updates } });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderCommute(container, currentState);
    }
  });
}
