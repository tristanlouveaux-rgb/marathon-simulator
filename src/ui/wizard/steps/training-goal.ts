import type { OnboardingState } from '@/types/onboarding';
import type { RaceDistance } from '@/types/training';
import { nextStep, updateOnboarding, previousStep } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Render the training goal selection (Step 2)
 * Asks if training for event, then shows distance or focus options
 */
export function renderTrainingGoal(container: HTMLElement, state: OnboardingState): void {
  const showDistanceOptions = state.trainingForEvent === true;
  const showFocusOptions = state.trainingForEvent === false;
  const showInitialQuestion = state.trainingForEvent === null;

  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(2, 10)}

      <div class="max-w-lg w-full">
        <!-- Title -->
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          ${showInitialQuestion ? 'Training Goal' :
            showDistanceOptions ? 'Select Your Distance' :
            'What are you focusing on?'}
        </h2>

        ${showInitialQuestion ? renderInitialQuestion() : ''}
        ${showDistanceOptions ? renderDistanceOptions() : ''}
        ${showFocusOptions ? renderFocusOptions() : ''}
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state);
}

function renderInitialQuestion(): string {
  return `
    <p class="text-gray-400 text-center mb-8">Are you training for a specific event?</p>

    <div class="flex gap-4 justify-center">
      <button id="train-yes"
        class="flex-1 max-w-[180px] py-6 bg-gray-800 hover:bg-gray-750
               border-2 border-transparent hover:border-emerald-500/50 rounded-xl transition-all
               text-white font-medium text-lg">
        Yes
      </button>
      <button id="train-no"
        class="flex-1 max-w-[180px] py-6 bg-gray-800 hover:bg-gray-750
               border-2 border-transparent hover:border-emerald-500/50 rounded-xl transition-all
               text-white font-medium text-lg">
        No
      </button>
    </div>
  `;
}

function renderDistanceOptions(): string {
  return `
    <p class="text-gray-400 text-center mb-8">Choose your target race distance</p>

    <div class="grid grid-cols-2 gap-4">
      ${renderDistanceCard('5k', '5K', 'Speed focused', '3.1 miles')}
      ${renderDistanceCard('10k', '10K', 'Versatile distance', '6.2 miles')}
      ${renderDistanceCard('half', 'Half Marathon', 'Endurance + speed', '13.1 miles')}
      ${renderDistanceCard('marathon', 'Marathon', 'Ultimate endurance', '26.2 miles')}
    </div>

    <button id="change-goal"
      class="mt-6 w-full text-center text-sm text-gray-500 hover:text-gray-300 transition-colors">
      Change my goal
    </button>
  `;
}

function renderDistanceCard(id: string, label: string, desc: string, miles: string): string {
  return `
    <button id="dist-${id}"
      class="p-5 bg-gray-800 hover:bg-gray-750
             border-2 border-transparent hover:border-emerald-500/50 rounded-xl transition-all
             text-left group">
      <div class="text-xl font-semibold text-white mb-1 group-hover:text-emerald-400 transition-colors">
        ${label}
      </div>
      <div class="text-sm text-gray-400 mb-2">${desc}</div>
      <div class="text-xs text-gray-600">${miles}</div>
    </button>
  `;
}

function renderFocusOptions(): string {
  return `
    <p class="text-gray-400 text-center mb-8">Let us build the perfect plan for you</p>

    <div class="space-y-3">
      ${renderFocusCard('speed', 'Speed', 'Build raw speed and leg turnover', '5K training focus')}
      ${renderFocusCard('endurance', 'Endurance', 'Develop aerobic base and stamina', 'Half marathon training')}
      ${renderFocusCard('both', 'Balanced', 'Best of both worlds', '10K training focus')}
    </div>

    <button id="change-goal"
      class="mt-6 w-full text-center text-sm text-gray-500 hover:text-gray-300 transition-colors">
      Change my goal
    </button>
  `;
}

function renderFocusCard(id: string, label: string, desc: string, planType: string): string {
  return `
    <button id="focus-${id}"
      class="w-full p-4 bg-gray-800 hover:bg-gray-750
             border-2 border-transparent hover:border-emerald-500/50 rounded-xl transition-all
             flex justify-between items-center group">
      <div class="text-left">
        <div class="text-lg font-medium text-white group-hover:text-emerald-400 transition-colors">
          ${label}
        </div>
        <div class="text-sm text-gray-400">${desc}</div>
      </div>
      <div class="text-xs text-emerald-500/80 bg-emerald-950/50 px-3 py-1.5 rounded-full border border-emerald-800/30">
        ${planType}
      </div>
    </button>
  `;
}

function wireEventHandlers(state: OnboardingState): void {
  // Initial question handlers
  document.getElementById('train-yes')?.addEventListener('click', () => {
    updateOnboarding({ trainingForEvent: true });
    rerender(state);
  });

  document.getElementById('train-no')?.addEventListener('click', () => {
    updateOnboarding({ trainingForEvent: false });
    rerender(state);
  });

  // Change goal handler
  document.getElementById('change-goal')?.addEventListener('click', () => {
    updateOnboarding({
      trainingForEvent: null,
      raceDistance: null,
      trainingFocus: null,
    });
    rerender(state);
  });

  // Distance selection handlers
  const distances: RaceDistance[] = ['5k', '10k', 'half', 'marathon'];
  distances.forEach(dist => {
    document.getElementById(`dist-${dist}`)?.addEventListener('click', () => {
      // For 5k/10k, set default plan duration since no event selection
      const defaultWeeks = dist === '5k' ? 8 : dist === '10k' ? 10 : 16;
      updateOnboarding({
        raceDistance: dist,
        planDurationWeeks: defaultWeeks,
      });
      nextStep();
    });
  });

  // Focus selection handlers
  const focusMap: Record<string, { distance: RaceDistance; weeks: number }> = {
    speed: { distance: '5k', weeks: 8 },
    endurance: { distance: 'half', weeks: 12 },
    both: { distance: '10k', weeks: 10 },
  };

  Object.entries(focusMap).forEach(([focus, { distance, weeks }]) => {
    document.getElementById(`focus-${focus}`)?.addEventListener('click', () => {
      updateOnboarding({
        trainingFocus: focus as 'speed' | 'endurance' | 'both',
        raceDistance: distance,
        planDurationWeeks: weeks,
      });
      nextStep();
    });
  });
}

function rerender(state: OnboardingState): void {
  // Re-import and re-render the same step
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) {
        renderTrainingGoal(container, currentState);
      }
    }
  });
}
