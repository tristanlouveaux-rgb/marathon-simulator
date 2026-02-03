import type { OnboardingState } from '@/types/onboarding';
import type { CommuteConfig } from '@/types/state';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Consolidated Background step: Experience Level + Commute + Active Lifestyle
 */
export function renderBackground(container: HTMLElement, state: OnboardingState): void {
  const config = state.commuteConfig || { enabled: true, distanceKm: 5, isBidirectional: false, commuteDaysPerWeek: 2 };

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(3, 7)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Your Background
        </h2>
        <p class="text-gray-400 text-center mb-8">
          Help us understand your fitness profile
        </p>

        <div class="space-y-6">
          <!-- Experience Level -->
          <div>
            <label class="block text-sm text-gray-400 mb-3">Running Background</label>
            <div class="space-y-2">
              ${renderExperienceOptions(state.experienceLevel)}
            </div>
          </div>

          <!-- Commute Toggle + Inline Config -->
          <div>
            <label class="block text-sm text-gray-400 mb-3">Do you run to work? (5km+)</label>
            <div class="space-y-2">
              <button id="commute-yes"
                class="w-full p-3 rounded-xl border-2 text-left transition-all
                       ${state.runsToWork === true
                         ? 'border-emerald-500 bg-emerald-950/30'
                         : 'border-gray-700 bg-gray-800 hover:border-gray-600'}">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium ${state.runsToWork === true ? 'text-emerald-400' : 'text-white'}">Yes</span>
                  ${state.runsToWork === true ? '<svg class="w-4 h-4 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' : ''}
                </div>
              </button>
              <button id="commute-no"
                class="w-full p-3 rounded-xl border-2 text-left transition-all
                       ${state.runsToWork === false
                         ? 'border-emerald-500 bg-emerald-950/30'
                         : 'border-gray-700 bg-gray-800 hover:border-gray-600'}">
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium ${state.runsToWork === false ? 'text-emerald-400' : 'text-white'}">No</span>
                  ${state.runsToWork === false ? '<svg class="w-4 h-4 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' : ''}
                </div>
              </button>
            </div>

            <!-- Inline commute config -->
            <div id="commute-config" class="${state.runsToWork === true ? '' : 'hidden'} mt-3 bg-gray-800 rounded-xl p-4 space-y-3">
              <div class="grid grid-cols-3 gap-2">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Distance (km)</label>
                  <input type="number" id="commute-distance" min="1" max="25" step="0.5" value="${config.distanceKm}"
                    class="w-full px-2 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none">
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Days/week</label>
                  <div class="flex gap-1">
                    ${[1, 2, 3, 4, 5].map(n => `
                      <button data-days="${n}" class="commute-day flex-1 py-1.5 text-xs rounded font-medium transition-all
                        ${config.commuteDaysPerWeek === n ? 'bg-emerald-600 text-white' : 'bg-gray-900 text-gray-400'}">
                        ${n}
                      </button>
                    `).join('')}
                  </div>
                </div>
                <div class="flex items-end">
                  <label class="flex items-center gap-2 cursor-pointer pb-1.5">
                    <input type="checkbox" id="commute-bidir" ${config.isBidirectional ? 'checked' : ''}
                      class="w-4 h-4 rounded bg-gray-900 border-gray-700 text-emerald-500">
                    <span class="text-xs text-gray-300">Both ways</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- Active Lifestyle Toggle -->
          <div class="bg-gray-800 rounded-xl p-4 flex items-center justify-between">
            <div>
              <div class="text-sm text-white font-medium">Active Job / Lifestyle</div>
              <div class="text-xs text-gray-400">Do you spend most of the day on your feet? (e.g. Waiter, Nurse, Manual Labor)</div>
            </div>
            <button id="toggle-active"
              class="w-12 h-6 rounded-full transition-colors ${state.activeLifestyle ? 'bg-emerald-600' : 'bg-gray-600'} relative">
              <span class="block w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform ${state.activeLifestyle ? 'translate-x-6' : 'translate-x-0.5'}"></span>
            </button>
          </div>
        </div>

        <button id="continue-background"
          class="mt-8 w-full py-3 bg-emerald-600 hover:bg-emerald-500
                 text-white font-medium rounded-xl transition-all">
          Continue
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state);
}

function renderExperienceOptions(current: string): string {
  const options = [
    { key: 'total_beginner', title: 'Total Beginner', desc: 'Never run before' },
    { key: 'beginner', title: 'Beginner', desc: 'Running < 6 months' },
    { key: 'novice', title: 'Novice', desc: 'Occasional 5ks/10ks' },
    { key: 'intermediate', title: 'Intermediate', desc: 'Consistent runner, raced before' },
    { key: 'advanced', title: 'Advanced', desc: 'Dedicated, year-round training' },
    { key: 'competitive', title: 'Competitive', desc: 'High performance / Club level' },
    { key: 'returning', title: 'Returning Athlete', desc: 'Strong history, rebuilding' },
    { key: 'hybrid', title: 'Hybrid Athlete', desc: 'Fit from other sports, low miles' },
  ];

  return options.map(o => `
    <button data-exp="${o.key}"
      class="exp-btn w-full p-3 rounded-xl border-2 text-left transition-all
             ${current === o.key
               ? 'border-emerald-500 bg-emerald-950/30'
               : 'border-gray-700 bg-gray-800 hover:border-gray-600'}">
      <div class="flex items-center justify-between">
        <div>
          <span class="text-sm font-medium ${current === o.key ? 'text-emerald-400' : 'text-white'}">${o.title}</span>
          <span class="text-xs text-gray-400 ml-2">${o.desc}</span>
        </div>
        ${current === o.key ? '<svg class="w-4 h-4 text-emerald-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' : ''}
      </div>
    </button>
  `).join('');
}

function wireEventHandlers(state: OnboardingState): void {
  // Experience
  document.querySelectorAll('.exp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const exp = btn.getAttribute('data-exp') as OnboardingState['experienceLevel'];
      if (exp) { updateOnboarding({ experienceLevel: exp }); rerender(state); }
    });
  });

  // Commute yes/no
  document.getElementById('commute-yes')?.addEventListener('click', () => {
    updateOnboarding({
      runsToWork: true,
      commuteConfig: state.commuteConfig || { enabled: true, distanceKm: 5, isBidirectional: false, commuteDaysPerWeek: 2 },
    });
    rerender(state);
  });

  document.getElementById('commute-no')?.addEventListener('click', () => {
    updateOnboarding({ runsToWork: false, commuteConfig: null });
    rerender(state);
  });

  // Commute config
  const distInput = document.getElementById('commute-distance') as HTMLInputElement;
  if (distInput) {
    distInput.addEventListener('change', () => {
      updateCommuteConfig(state, { distanceKm: parseFloat(distInput.value) || 5 });
    });
  }

  const bidirCheckbox = document.getElementById('commute-bidir') as HTMLInputElement;
  if (bidirCheckbox) {
    bidirCheckbox.addEventListener('change', () => {
      updateCommuteConfig(state, { isBidirectional: bidirCheckbox.checked });
    });
  }

  document.querySelectorAll('.commute-day').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.getAttribute('data-days') || '2');
      updateCommuteConfig(state, { commuteDaysPerWeek: days });
      rerender(state);
    });
  });

  // Active lifestyle
  document.getElementById('toggle-active')?.addEventListener('click', () => {
    updateOnboarding({ activeLifestyle: !state.activeLifestyle });
    rerender(state);
  });

  // Continue
  document.getElementById('continue-background')?.addEventListener('click', () => nextStep());
}

function updateCommuteConfig(state: OnboardingState, updates: Partial<CommuteConfig>): void {
  const current = state.commuteConfig || { enabled: true, distanceKm: 5, isBidirectional: false, commuteDaysPerWeek: 2 };
  updateOnboarding({ commuteConfig: { ...current, ...updates } });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderBackground(container, currentState);
    }
  });
}
