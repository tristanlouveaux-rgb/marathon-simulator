import type { OnboardingState, RecurringActivity } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { SPORT_LABELS } from '@/constants/sports';

const SPORT_OPTIONS = Object.values(SPORT_LABELS);

/**
 * Render the activities step (Step 5b)
 * Asks about active lifestyle and recurring cross-training activities
 */
export function renderActivities(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(6, 11)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Active Lifestyle
        </h2>
        <p class="text-gray-400 text-center mb-8">
          Tell us about your other activities so we can optimise your plan.
        </p>

        <div class="space-y-6">
          <!-- Active Lifestyle Toggle -->
          <div class="bg-gray-800 rounded-xl p-4 flex items-center justify-between">
            <div>
              <div class="text-sm text-white font-medium">Generally active lifestyle?</div>
              <div class="text-xs text-gray-400">Walking, stairs, active job, etc.</div>
            </div>
            <button id="toggle-active"
              class="w-12 h-6 rounded-full transition-colors ${state.activeLifestyle ? 'bg-emerald-600' : 'bg-gray-600'} relative">
              <span class="block w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform ${state.activeLifestyle ? 'translate-x-6' : 'translate-x-0.5'}"></span>
            </button>
          </div>

          <!-- Disclaimer -->
          <div class="bg-gray-800/50 rounded-xl p-3 space-y-2">
            <p class="text-xs text-gray-400">
              Don't worry about getting this perfect — your watch sync and manual logs will capture everything automatically. This just helps us build a smarter starting plan.
            </p>
            <p class="text-xs text-gray-500">
              <span class="text-gray-400 font-medium">Running benefit</span> = how much a sport improves your running fitness.
              High benefit (e.g. cycling, rowing) builds aerobic fitness that carries over to running.
              Low benefit (e.g. swimming, yoga) aids recovery but is less running-specific.
            </p>
          </div>

          <!-- Add Activity Form -->
          <div class="bg-gray-800 rounded-xl p-4">
            <div class="text-sm text-white font-medium mb-3">Recurring Activities</div>
            <div class="grid grid-cols-4 gap-2 mb-3">
              <select id="act-sport" class="col-span-1 text-xs bg-gray-700 border border-gray-600 rounded-lg px-2 py-2 text-gray-200">
                <option value="" disabled selected>Select sport...</option>
                ${SPORT_OPTIONS.map(s => `<option value="${s}">${s}</option>`).join('')}
              </select>
              <input type="number" id="act-dur" placeholder="Min" min="10" max="300"
                class="text-xs bg-gray-700 border border-gray-600 rounded-lg px-2 py-2 text-gray-200">
              <input type="number" id="act-freq" placeholder="x/wk" min="1" max="7"
                class="text-xs bg-gray-700 border border-gray-600 rounded-lg px-2 py-2 text-gray-200">
              <button id="btn-add-activity"
                class="text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-colors">
                + Add
              </button>
            </div>

            <!-- Activity List -->
            <div id="activity-list" class="space-y-2">
              ${renderActivityList(state.recurringActivities)}
            </div>

            ${state.recurringActivities.length === 0 ? `
              <p class="text-xs text-gray-500 mt-2">No activities added yet. You can skip this step.</p>
            ` : ''}
          </div>
        </div>

        <button id="continue-activities"
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

function renderActivityList(activities: RecurringActivity[]): string {
  if (activities.length === 0) return '';

  return activities.map((a, i) => `
    <div class="flex items-center justify-between bg-gray-700/50 rounded-lg px-3 py-2">
      <div class="flex items-center gap-3">
        <span class="text-sm text-white font-medium">${a.sport}</span>
        <span class="text-xs text-gray-400">${a.durationMin}min</span>
        <span class="text-xs text-gray-400">${a.frequency}x/wk</span>
        <span class="text-xs px-1.5 py-0.5 rounded ${a.intensity === 'hard' ? 'bg-red-900/50 text-red-300' :
      a.intensity === 'moderate' ? 'bg-amber-900/50 text-amber-300' :
        'bg-emerald-900/50 text-emerald-300'
    }" title="How much this sport benefits running fitness">${a.intensity === 'hard' ? 'High running benefit' :
      a.intensity === 'moderate' ? 'Some running benefit' :
        'Low running benefit'
    }</span>
      </div>
      <button data-remove="${i}" class="remove-activity text-gray-500 hover:text-red-400 text-xs transition-colors">Remove</button>
    </div>
  `).join('');
}

function inferIntensity(sport: string): 'easy' | 'moderate' | 'hard' {
  const hard = ['soccer', 'rugby', 'basketball', 'boxing', 'crossfit', 'martial arts', 'jump rope'];
  const easy = ['swimming', 'yoga', 'pilates', 'walking', 'hiking'];
  const s = sport.toLowerCase();
  if (hard.some(h => s.includes(h))) return 'hard';
  if (easy.some(e => s.includes(e))) return 'easy';
  return 'moderate';
}

function wireEventHandlers(state: OnboardingState): void {
  // Toggle active lifestyle
  document.getElementById('toggle-active')?.addEventListener('click', () => {
    updateOnboarding({ activeLifestyle: !state.activeLifestyle });
    rerender(state);
  });

  // Add activity
  document.getElementById('btn-add-activity')?.addEventListener('click', () => {
    const sport = (document.getElementById('act-sport') as HTMLSelectElement)?.value;
    const dur = parseInt((document.getElementById('act-dur') as HTMLInputElement)?.value);
    const freq = parseInt((document.getElementById('act-freq') as HTMLInputElement)?.value);

    if (!sport || isNaN(dur) || dur <= 0 || isNaN(freq) || freq < 1) {
      return; // Silent fail — fields not filled
    }

    const activity: RecurringActivity = {
      sport,
      durationMin: Math.min(dur, 300),
      frequency: Math.min(freq, 7),
      intensity: inferIntensity(sport),
    };

    const updated = [...state.recurringActivities, activity];
    // Also update legacy sportsPerWeek as sum of frequencies
    const totalFreq = updated.reduce((sum, a) => sum + a.frequency, 0);
    updateOnboarding({ recurringActivities: updated, sportsPerWeek: totalFreq });
    rerender(state);
  });

  // Remove activity
  document.querySelectorAll('.remove-activity').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-remove') || '-1');
      if (idx >= 0) {
        const updated = state.recurringActivities.filter((_, i) => i !== idx);
        const totalFreq = updated.reduce((sum, a) => sum + a.frequency, 0);
        updateOnboarding({ recurringActivities: updated, sportsPerWeek: totalFreq });
        rerender(state);
      }
    });
  });

  // Continue
  document.getElementById('continue-activities')?.addEventListener('click', () => {
    nextStep();
  });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) {
        renderActivities(container, currentState);
      }
    }
  });
}
