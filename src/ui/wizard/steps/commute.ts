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
    <div class="min-h-screen flex flex-col items-center justify-center px-6 py-12" style="background:var(--c-bg)">
      ${renderProgressIndicator(4, 10)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light mb-2 text-center" style="color:var(--c-black)">
          Run Commute
        </h2>
        <p class="text-center mb-8" style="color:var(--c-faint)">
          Do you run more than 5km to work?
        </p>

        <!-- Yes / No Toggle -->
        <div class="flex gap-3 justify-center mb-6">
          <button id="commute-yes"
            class="flex-1 max-w-[160px] py-4 rounded-xl font-medium transition-all"
            style="${state.runsToWork === true
              ? 'background:var(--c-ok);color:#FDFCF7;border:2px solid var(--c-ok)'
              : 'background:rgba(0,0,0,0.06);color:var(--c-muted);border:2px solid transparent'}">
            Yes
          </button>
          <button id="commute-no"
            class="flex-1 max-w-[160px] py-4 rounded-xl font-medium transition-all"
            style="${state.runsToWork === false
              ? 'background:var(--c-black);color:#FDFCF7;border:2px solid var(--c-black)'
              : 'background:rgba(0,0,0,0.06);color:var(--c-muted);border:2px solid transparent'}">
            No
          </button>
        </div>

        <!-- Expandable Config (shown when Yes) -->
        <div id="commute-config" style="display:${state.runsToWork === true ? '' : 'none'}">
          <div class="rounded-xl p-6 space-y-5 mb-4" style="background:rgba(0,0,0,0.06)">
            <!-- Distance -->
            <div>
              <label class="block text-sm mb-2" style="color:var(--c-faint)">One-way distance (km)</label>
              <input type="number" id="commute-distance"
                min="1" max="25" step="0.5"
                value="${config.distanceKm}"
                class="w-full px-4 py-3 rounded-lg text-lg focus:outline-none"
                style="background:var(--c-bg);border:1px solid var(--c-border);color:var(--c-black)">
            </div>

            <!-- Bidirectional -->
            <label class="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" id="commute-bidirectional"
                ${config.isBidirectional ? 'checked' : ''}
                class="w-5 h-5 rounded">
              <div>
                <span class="text-sm" style="color:var(--c-black)">Run both ways</span>
                <p class="text-xs" style="color:var(--c-faint)">Count morning and evening as separate runs</p>
              </div>
            </label>

            <!-- Days per week -->
            <div>
              <label class="block text-sm mb-2" style="color:var(--c-faint)">Days per week</label>
              <div class="flex gap-2">
                ${[1, 2, 3, 4, 5].map(n => `
                  <button data-days="${n}"
                    class="commute-day flex-1 py-3 rounded-lg font-medium transition-all"
                    style="${config.commuteDaysPerWeek === n
                      ? 'background:var(--c-black);color:#FDFCF7;border:none'
                      : 'background:var(--c-bg);color:var(--c-muted);border:1px solid var(--c-border)'}">
                    ${n}
                  </button>
                `).join('')}
              </div>
            </div>
          </div>
        </div>

        <!-- No-commute note -->
        <div id="no-commute-note" style="display:${state.runsToWork === false ? '' : 'none'}">
          <p class="text-sm text-center mb-4" style="color:var(--c-faint)">
            No problem — you can always add commute runs later in settings.
          </p>
        </div>

        <button id="continue-commute"
          class="w-full py-3 rounded-xl transition-all font-medium"
          style="background:var(--c-black);color:#FDFCF7;border:none;${state.runsToWork === null ? 'opacity:0.5;cursor:not-allowed' : ''}"
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
  // Yes - show config first, user confirms with Continue
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

  // No - auto-advance immediately (no config needed)
  document.getElementById('commute-no')?.addEventListener('click', () => {
    updateOnboarding({ runsToWork: false, commuteConfig: null });
    nextStep();
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
