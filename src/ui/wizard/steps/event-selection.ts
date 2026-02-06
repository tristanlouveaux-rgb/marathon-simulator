import type { OnboardingState, Marathon } from '@/types/onboarding';
import { getMarathonsByDistance, formatRaceDate, calculateWeeksUntil } from '@/data/marathons';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Render the event selection page (Step 3)
 * Shows scrollable list of marathons/halfs with weeks until race
 */
export function renderEventSelection(container: HTMLElement, state: OnboardingState): void {
  const distance = state.raceDistance === 'marathon' ? 'marathon' : 'half';
  const races = getMarathonsByDistance(distance);
  const showCustomInput = state.customRaceDate !== null;

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center px-6 py-12">
      ${renderProgressIndicator(3, 10)}

      <div class="max-w-lg w-full flex-1 flex flex-col">
        <!-- Title -->
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Select Your ${distance === 'marathon' ? 'Marathon' : 'Half Marathon'}
        </h2>
        <p class="text-gray-400 text-center mb-6">
          Choose your target race or enter a custom date
        </p>

        ${showCustomInput ? renderCustomDateInput(state) : renderRaceList(races, state)}

        <!-- Manual Entry Toggle -->
        <div class="mt-4 pt-4 border-t border-gray-800">
          ${showCustomInput ? `
            <button id="show-races"
              class="w-full text-center text-sm text-gray-500 hover:text-gray-300 transition-colors py-2">
              Browse races instead
            </button>
          ` : `
            <button id="custom-race"
              class="w-full text-center text-sm text-gray-500 hover:text-gray-300 transition-colors py-2">
              Can't find your race? Enter custom date
            </button>
          `}
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(races, state);
}

function renderRaceList(races: Marathon[], state: OnboardingState): string {
  if (races.length === 0) {
    return `
      <div class="text-center text-gray-400 py-8">
        No upcoming races found. Please enter a custom date.
      </div>
    `;
  }

  const raceItems = races.map(race => renderRaceCard(race, state.selectedRace?.id === race.id)).join('');

  return `
    <div class="flex-1 overflow-y-auto space-y-3 max-h-[400px] pr-2 scrollbar-thin">
      ${raceItems}
    </div>
  `;
}

function renderRaceCard(race: Marathon, isSelected: boolean): string {
  const weeksText = race.weeksUntil === 1 ? '1 week' : `${race.weeksUntil} weeks`;
  const urgencyClass = race.weeksUntil && race.weeksUntil < 12 ? 'text-amber-400' : 'text-emerald-400';

  return `
    <button data-race-id="${race.id}"
      class="race-card w-full p-4 bg-gray-800 hover:bg-gray-750
             border-2 ${isSelected ? 'border-emerald-500 bg-emerald-950/20' : 'border-transparent hover:border-gray-700'}
             rounded-xl transition-all text-left">
      <div class="flex justify-between items-start">
        <div class="flex-1">
          <div class="font-medium text-white ${isSelected ? 'text-emerald-400' : ''}">${race.name}</div>
          <div class="text-sm text-gray-400">${race.city}, ${race.country}</div>
          <div class="text-xs text-gray-500 mt-1">${formatRaceDate(race.date)}</div>
        </div>
        <div class="text-right">
          <div class="text-lg font-bold ${urgencyClass}">${weeksText}</div>
          <div class="text-xs text-gray-500">away</div>
        </div>
      </div>
      ${isSelected ? `
        <div class="mt-2 text-xs text-emerald-400 flex items-center gap-1">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
          </svg>
          Selected
        </div>
      ` : ''}
    </button>
  `;
}

function renderCustomDateInput(state: OnboardingState): string {
  const minDate = new Date();
  minDate.setDate(minDate.getDate() + 56); // 8 weeks minimum
  const minDateStr = minDate.toISOString().split('T')[0];

  const maxDate = new Date();
  maxDate.setMonth(maxDate.getMonth() + 12); // 12 months max
  const maxDateStr = maxDate.toISOString().split('T')[0];

  const weeksText = state.customRaceDate
    ? `${calculateWeeksUntil(state.customRaceDate)} weeks of training`
    : '';

  return `
    <div class="bg-gray-800 rounded-xl p-6">
      <label class="block text-sm text-gray-400 mb-2">Race Date</label>
      <input type="date" id="custom-date-input"
        min="${minDateStr}" max="${maxDateStr}"
        value="${state.customRaceDate || ''}"
        class="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg
               text-white text-lg focus:border-emerald-500 focus:outline-none">

      ${weeksText ? `
        <div class="mt-3 text-center text-emerald-400 font-medium">
          ${weeksText}
        </div>
      ` : ''}
    </div>
  `;
}

function wireEventHandlers(races: Marathon[], state: OnboardingState): void {
  // Race card selection - auto-advance on selection
  document.querySelectorAll('.race-card').forEach(card => {
    card.addEventListener('click', () => {
      const raceId = card.getAttribute('data-race-id');
      const race = races.find(r => r.id === raceId);
      if (race) {
        updateOnboarding({
          selectedRace: race,
          planDurationWeeks: race.weeksUntil || 16,
          customRaceDate: null,
        });
        // Auto-advance immediately after selection
        nextStep();
      }
    });
  });

  // Custom race toggle
  document.getElementById('custom-race')?.addEventListener('click', () => {
    updateOnboarding({
      customRaceDate: '',
      selectedRace: null,
    });
    rerender(state);
  });

  // Back to race list
  document.getElementById('show-races')?.addEventListener('click', () => {
    updateOnboarding({
      customRaceDate: null,
    });
    rerender(state);
  });

  // Custom date input - auto-advance on valid date
  const dateInput = document.getElementById('custom-date-input') as HTMLInputElement;
  if (dateInput) {
    dateInput.addEventListener('change', () => {
      const dateValue = dateInput.value;
      if (dateValue) {
        const weeks = calculateWeeksUntil(dateValue);
        updateOnboarding({
          customRaceDate: dateValue,
          planDurationWeeks: weeks,
          selectedRace: null,
        });
        // Auto-advance immediately after valid date
        nextStep();
      }
    });
  }
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) {
        renderEventSelection(container, currentState);
      }
    }
  });
}
