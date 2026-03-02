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
    <div class="min-h-screen flex flex-col items-center px-6 py-12" style="background:var(--c-bg)">
      ${renderProgressIndicator(3, 10)}

      <div class="max-w-lg w-full flex-1 flex flex-col">
        <!-- Title -->
        <h2 class="text-2xl md:text-3xl font-light mb-2 text-center" style="color:var(--c-black)">
          Select Your ${distance === 'marathon' ? 'Marathon' : 'Half Marathon'}
        </h2>
        <p class="text-center mb-6" style="color:var(--c-faint)">
          Choose your target race or enter a custom date
        </p>

        ${showCustomInput ? renderCustomDateInput(state) : renderRaceList(races, state)}

        <!-- Manual Entry Toggle -->
        <div class="mt-4 pt-4" style="border-top:1px solid var(--c-border)">
          ${showCustomInput ? `
            <button id="show-races"
              class="w-full text-center text-sm py-2 transition-colors" style="color:var(--c-faint);background:none;border:none">
              Browse races instead
            </button>
          ` : `
            <button id="custom-race"
              class="w-full text-center text-sm py-2 transition-colors" style="color:var(--c-faint);background:none;border:none">
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
      <div class="text-center py-8" style="color:var(--c-faint)">
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
  const urgencyStyle = race.weeksUntil && race.weeksUntil < 12 ? 'color:var(--c-caution)' : 'color:var(--c-ok)';

  return `
    <button data-race-id="${race.id}"
      class="race-card w-full p-4 rounded-xl transition-all text-left"
      style="${isSelected
        ? 'background:rgba(78,159,229,0.08);border:2px solid var(--c-accent)'
        : 'background:rgba(0,0,0,0.06);border:2px solid transparent'}">
      <div class="flex justify-between items-start">
        <div class="flex-1">
          <div class="font-medium" style="${isSelected ? 'color:var(--c-accent)' : 'color:var(--c-black)'}">${race.name}</div>
          <div class="text-sm" style="color:var(--c-muted)">${race.city}, ${race.country}</div>
          <div class="text-xs mt-1" style="color:var(--c-faint)">${formatRaceDate(race.date)}</div>
        </div>
        <div class="text-right">
          <div class="text-lg font-bold" style="${urgencyStyle}">${weeksText}</div>
          <div class="text-xs" style="color:var(--c-faint)">away</div>
        </div>
      </div>
      ${isSelected ? `
        <div class="mt-2 text-xs flex items-center gap-1" style="color:var(--c-ok)">
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
    <div class="rounded-xl p-6" style="background:rgba(0,0,0,0.06)">
      <label class="block text-sm mb-2" style="color:var(--c-faint)">Race Date</label>
      <input type="date" id="custom-date-input"
        min="${minDateStr}" max="${maxDateStr}"
        value="${state.customRaceDate || ''}"
        class="w-full px-4 py-3 rounded-lg text-lg focus:outline-none"
        style="background:var(--c-bg);border:1px solid var(--c-border);color:var(--c-black)">

      ${weeksText ? `
        <div class="mt-3 text-center font-medium" style="color:var(--c-ok)">
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
