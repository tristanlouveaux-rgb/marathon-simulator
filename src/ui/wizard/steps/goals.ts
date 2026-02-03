import type { OnboardingState, Marathon } from '@/types/onboarding';
import type { RaceDistance } from '@/types/training';
import { getMarathonsByDistance, formatRaceDate, calculateWeeksUntil } from '@/data/marathons';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Consolidated Goals step: Training for Event? -> Distance -> Event Selection (inline)
 */
export function renderGoals(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(2, 7)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Training Goal
        </h2>
        <p class="text-gray-400 text-center mb-8">
          What are you training for?
        </p>

        <div class="space-y-6">
          <!-- Event Toggle -->
          <div class="flex gap-3 justify-center">
            <button id="goal-event"
              class="flex-1 max-w-[180px] py-4 rounded-xl font-medium transition-all border-2
                     ${state.trainingForEvent === true
                       ? 'bg-emerald-600 text-white border-emerald-500'
                       : 'bg-gray-800 text-gray-400 border-transparent hover:border-gray-600'}">
              Race
            </button>
            <button id="goal-general"
              class="flex-1 max-w-[180px] py-4 rounded-xl font-medium transition-all border-2
                     ${state.trainingForEvent === false
                       ? 'bg-gray-700 text-white border-gray-500'
                       : 'bg-gray-800 text-gray-400 border-transparent hover:border-gray-600'}">
              General Fitness
            </button>
          </div>

          <!-- Distance Selection (shown after choosing event or general) -->
          ${state.trainingForEvent !== null ? renderDistanceSelection(state) : ''}

          <!-- Event Selection (inline, for half/marathon) -->
          ${state.trainingForEvent && (state.raceDistance === 'half' || state.raceDistance === 'marathon')
            ? renderInlineEventSelection(state)
            : ''}

          <!-- Focus Selection (for general fitness) -->
          ${state.trainingForEvent === false ? renderFocusSelection(state) : ''}

          <!-- Speed focus warning -->
          ${state.trainingFocus === 'speed' ? `
            <div class="bg-amber-950/30 border border-amber-800/50 rounded-lg p-3 text-xs text-amber-300">
              <strong>Note:</strong> Speed-focused training is more intense. Expect higher RPE sessions and ensure adequate recovery between workouts.
            </div>
          ` : ''}
        </div>

        <button id="continue-goals"
          class="mt-8 w-full py-3 bg-emerald-600 hover:bg-emerald-500
                 text-white font-medium rounded-xl transition-all
                 ${canContinue(state) ? '' : 'opacity-50 cursor-not-allowed'}"
          ${canContinue(state) ? '' : 'disabled'}>
          Continue
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state);
}

function canContinue(state: OnboardingState): boolean {
  if (state.trainingForEvent === null) return false;
  if (!state.raceDistance) return false;
  if (state.trainingForEvent && (state.raceDistance === 'half' || state.raceDistance === 'marathon')) {
    return !!(state.selectedRace || state.customRaceDate);
  }
  return true;
}

function renderDistanceSelection(state: OnboardingState): string {
  if (state.trainingForEvent === false) return ''; // Focus selection handles this
  const distances: { id: RaceDistance; label: string; sub: string }[] = [
    { id: '5k', label: '5K', sub: '3.1 miles' },
    { id: '10k', label: '10K', sub: '6.2 miles' },
    { id: 'half', label: 'Half', sub: '13.1 miles' },
    { id: 'marathon', label: 'Marathon', sub: '26.2 miles' },
  ];

  return `
    <div>
      <label class="block text-sm text-gray-400 mb-3">Distance</label>
      <div class="grid grid-cols-4 gap-2">
        ${distances.map(d => `
          <button data-dist="${d.id}"
            class="dist-btn py-3 rounded-xl text-center transition-all border-2
                   ${state.raceDistance === d.id
                     ? 'bg-emerald-600 text-white border-emerald-500'
                     : 'bg-gray-800 text-gray-400 border-transparent hover:border-gray-600'}">
            <div class="font-medium text-sm">${d.label}</div>
            <div class="text-xs opacity-60">${d.sub}</div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderFocusSelection(state: OnboardingState): string {
  const options: { id: string; label: string; desc: string; dist: RaceDistance; weeks: number }[] = [
    { id: 'speed', label: 'Speed', desc: 'Build raw speed', dist: '5k', weeks: 8 },
    { id: 'both', label: 'Balanced', desc: 'Speed + endurance', dist: '10k', weeks: 10 },
    { id: 'endurance', label: 'Endurance', desc: 'Aerobic base', dist: 'half', weeks: 12 },
  ];

  return `
    <div>
      <label class="block text-sm text-gray-400 mb-3">Focus</label>
      <div class="space-y-2">
        ${options.map(o => `
          <button data-focus="${o.id}" data-focus-dist="${o.dist}" data-focus-weeks="${o.weeks}"
            class="focus-btn w-full p-3 rounded-xl border-2 text-left transition-all
                   ${state.trainingFocus === o.id
                     ? 'border-emerald-500 bg-emerald-950/30'
                     : 'border-gray-700 bg-gray-800 hover:border-gray-600'}">
            <span class="text-sm font-medium ${state.trainingFocus === o.id ? 'text-emerald-400' : 'text-white'}">${o.label}</span>
            <span class="text-xs text-gray-400 ml-2">${o.desc}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderInlineEventSelection(state: OnboardingState): string {
  const distance = state.raceDistance === 'marathon' ? 'marathon' : 'half';
  const races = getMarathonsByDistance(distance);

  return `
    <div>
      <label class="block text-sm text-gray-400 mb-3">Select your event</label>
      <div class="space-y-2 max-h-[200px] overflow-y-auto pr-1">
        ${races.slice(0, 8).map(race => `
          <button data-race-id="${race.id}"
            class="race-card w-full p-3 rounded-xl border-2 text-left transition-all
                   ${state.selectedRace?.id === race.id
                     ? 'border-emerald-500 bg-emerald-950/30'
                     : 'border-gray-700 bg-gray-800 hover:border-gray-600'}">
            <div class="flex justify-between items-center">
              <div>
                <span class="text-sm font-medium ${state.selectedRace?.id === race.id ? 'text-emerald-400' : 'text-white'}">${race.name}</span>
                <span class="text-xs text-gray-400 ml-2">${formatRaceDate(race.date)}</span>
              </div>
              <span class="text-xs font-bold ${race.weeksUntil && race.weeksUntil < 12 ? 'text-amber-400' : 'text-emerald-400'}">${race.weeksUntil}wk</span>
            </div>
          </button>
        `).join('')}
      </div>

      <!-- Custom date toggle -->
      <div class="mt-3">
        <button id="toggle-custom-date" class="text-xs text-gray-500 hover:text-gray-300 transition-colors">
          ${state.customRaceDate !== null ? 'Browse races' : 'Enter custom date'}
        </button>
        ${state.customRaceDate !== null ? `
          <div class="mt-2">
            <input type="date" id="custom-date-input" value="${state.customRaceDate || ''}"
              class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                     text-white text-sm focus:border-emerald-500 focus:outline-none">
            ${state.customRaceDate ? `<p class="text-xs text-emerald-400 mt-1">${calculateWeeksUntil(state.customRaceDate)} weeks of training</p>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function wireEventHandlers(state: OnboardingState): void {
  const races = (state.raceDistance === 'half' || state.raceDistance === 'marathon')
    ? getMarathonsByDistance(state.raceDistance === 'marathon' ? 'marathon' : 'half')
    : [];

  document.getElementById('goal-event')?.addEventListener('click', () => {
    updateOnboarding({ trainingForEvent: true, trainingFocus: null });
    rerender(state);
  });

  document.getElementById('goal-general')?.addEventListener('click', () => {
    updateOnboarding({ trainingForEvent: false, selectedRace: null, customRaceDate: null });
    rerender(state);
  });

  // Distance buttons
  document.querySelectorAll('.dist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dist = btn.getAttribute('data-dist') as RaceDistance;
      const defaultWeeks = dist === '5k' ? 8 : dist === '10k' ? 10 : 16;
      updateOnboarding({ raceDistance: dist, planDurationWeeks: defaultWeeks, selectedRace: null, customRaceDate: null });
      rerender(state);
    });
  });

  // Focus buttons
  document.querySelectorAll('.focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const focus = btn.getAttribute('data-focus') as 'speed' | 'endurance' | 'both';
      const dist = btn.getAttribute('data-focus-dist') as RaceDistance;
      const weeks = parseInt(btn.getAttribute('data-focus-weeks') || '10');
      updateOnboarding({ trainingFocus: focus, raceDistance: dist, planDurationWeeks: weeks });
      rerender(state);
    });
  });

  // Race cards
  document.querySelectorAll('.race-card').forEach(card => {
    card.addEventListener('click', () => {
      const raceId = card.getAttribute('data-race-id');
      const race = races.find(r => r.id === raceId);
      if (race) {
        updateOnboarding({ selectedRace: race, planDurationWeeks: race.weeksUntil || 16, customRaceDate: null });
        rerender(state);
      }
    });
  });

  // Custom date toggle
  document.getElementById('toggle-custom-date')?.addEventListener('click', () => {
    if (state.customRaceDate !== null) {
      updateOnboarding({ customRaceDate: null });
    } else {
      updateOnboarding({ customRaceDate: '', selectedRace: null });
    }
    rerender(state);
  });

  // Custom date input
  const dateInput = document.getElementById('custom-date-input') as HTMLInputElement;
  if (dateInput) {
    // Set min date to 4 weeks from now
    const minDate = new Date();
    minDate.setDate(minDate.getDate() + 28);
    dateInput.min = minDate.toISOString().split('T')[0];

    dateInput.addEventListener('change', () => {
      if (dateInput.value) {
        const weeks = calculateWeeksUntil(dateInput.value);
        if (weeks < 4) {
          dateInput.setCustomValidity('Race must be at least 4 weeks away');
          dateInput.reportValidity();
          return;
        }
        dateInput.setCustomValidity('');
        updateOnboarding({ customRaceDate: dateInput.value, planDurationWeeks: weeks, selectedRace: null });
        rerender(state);
      }
    });
  }

  // Continue
  document.getElementById('continue-goals')?.addEventListener('click', () => {
    if (canContinue(state)) nextStep();
  });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderGoals(container, currentState);
    }
  });
}
