import type { OnboardingState, RecurringActivity } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { SPORT_LABELS } from '@/constants/sports';

const SPORT_OPTIONS = Object.values(SPORT_LABELS);

/**
 * Consolidated Volume step: Runs/Week + Sports/Week + Inline Activities
 */
export function renderVolume(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(4, 7)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Training Volume
        </h2>
        <p class="text-gray-400 text-center mb-8">
          How much time can you dedicate?
        </p>

        <div class="space-y-6">
          <!-- Runs per week -->
          <div>
            <label class="block text-sm text-gray-400 mb-3">Runs per week</label>
            <div class="grid grid-cols-7 gap-2">
              ${[1, 2, 3, 4, 5, 6, 7].map(n => `
                <button data-runs="${n}"
                  class="runs-btn py-3 rounded-lg font-medium transition-all
                         ${state.runsPerWeek === n
                           ? 'bg-emerald-600 text-white'
                           : 'bg-gray-800 text-gray-400 hover:bg-gray-750'}">
                  ${n}
                </button>
              `).join('')}
            </div>
            <p class="text-xs text-gray-500 mt-2">${getRunsRec(state.runsPerWeek)}</p>
          </div>

          <!-- Other sports -->
          <div>
            <label class="block text-sm text-gray-400 mb-3">
              Other sports sessions per week <span class="text-gray-600">(optional)</span>
            </label>
            <div class="grid grid-cols-6 gap-2">
              ${[0, 1, 2, 3, 4, 5].map(n => `
                <button data-sports="${n}"
                  class="sports-btn py-3 rounded-lg font-medium transition-all
                         ${state.sportsPerWeek === n
                           ? 'bg-emerald-600 text-white'
                           : 'bg-gray-800 text-gray-400 hover:bg-gray-750'}">
                  ${n}
                </button>
              `).join('')}
            </div>
          </div>

          <!-- Inline Activities (shown when sports > 0) -->
          ${state.sportsPerWeek > 0 ? renderInlineActivities(state) : ''}
        </div>

        <button id="continue-volume"
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

function renderInlineActivities(state: OnboardingState): string {
  return `
    <div class="bg-gray-800 rounded-xl p-4">
      <div class="text-sm text-white font-medium mb-3">Recurring Activities</div>
      <p class="text-xs text-gray-400 mb-3">
        Don't worry about getting this perfect — your watch sync and manual logs will capture everything automatically.
      </p>

      <p class="text-xs text-gray-500 mb-2">Select intensity based on how well this activity translates to running fitness.</p>
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

      <div id="activity-list" class="space-y-2">
        ${state.recurringActivities.map((a, i) => `
          <div class="flex items-center justify-between bg-gray-700/50 rounded-lg px-3 py-2">
            <div class="flex items-center gap-3">
              <span class="text-sm text-white font-medium">${a.sport}</span>
              <span class="text-xs text-gray-400">${a.durationMin}min ${a.frequency}x/wk</span>
              <span class="text-xs px-1.5 py-0.5 rounded ${
                a.intensity === 'hard' ? 'bg-red-900/50 text-red-300' :
                a.intensity === 'moderate' ? 'bg-amber-900/50 text-amber-300' :
                'bg-emerald-900/50 text-emerald-300'
              }">${
                a.intensity === 'hard' ? 'High Transfer' :
                a.intensity === 'moderate' ? 'Moderate Transfer' :
                'Low Transfer'
              }</span>
            </div>
            <button data-remove="${i}" class="remove-activity text-gray-500 hover:text-red-400 text-xs">Remove</button>
          </div>
        `).join('')}
      </div>

      ${state.recurringActivities.length === 0 ? `<p class="text-xs text-gray-500 mt-2">No activities added yet.</p>` : ''}
      <p class="text-xs text-gray-600 mt-3">Don't know exact volume? Safe to underestimate — we'll sync actuals from your device.</p>
    </div>
  `;
}

function inferIntensity(sport: string): 'easy' | 'moderate' | 'hard' {
  const hard = ['soccer', 'rugby', 'basketball', 'boxing', 'crossfit', 'martial arts', 'jump rope'];
  const easy = ['swimming', 'yoga', 'pilates', 'walking', 'hiking'];
  const s = sport.toLowerCase();
  if (hard.some(h => s.includes(h))) return 'hard';
  if (easy.some(e => s.includes(e))) return 'easy';
  return 'moderate';
}

function getRunsRec(runs: number): string {
  if (runs <= 2) return 'Good for beginners or limited time';
  if (runs <= 3) return 'Solid foundation for most runners';
  if (runs <= 4) return 'Recommended for intermediate runners';
  if (runs <= 5) return 'Optimal for most training plans';
  return 'Advanced training volume';
}

function wireEventHandlers(state: OnboardingState): void {
  // Runs
  document.querySelectorAll('.runs-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const runs = parseInt(btn.getAttribute('data-runs') || '4');
      updateOnboarding({ runsPerWeek: runs });
      rerender(state);
    });
  });

  // Sports
  document.querySelectorAll('.sports-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sports = parseInt(btn.getAttribute('data-sports') || '0');
      updateOnboarding({ sportsPerWeek: sports });
      rerender(state);
    });
  });

  // Add activity
  document.getElementById('btn-add-activity')?.addEventListener('click', () => {
    const sport = (document.getElementById('act-sport') as HTMLSelectElement)?.value;
    const dur = parseInt((document.getElementById('act-dur') as HTMLInputElement)?.value);
    const freq = parseInt((document.getElementById('act-freq') as HTMLInputElement)?.value);
    if (!sport || isNaN(dur) || dur <= 0 || isNaN(freq) || freq < 1) return;

    const activity: RecurringActivity = {
      sport, durationMin: Math.min(dur, 300), frequency: Math.min(freq, 7), intensity: inferIntensity(sport),
    };
    const updated = [...state.recurringActivities, activity];
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
  document.getElementById('continue-volume')?.addEventListener('click', () => nextStep());
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderVolume(container, currentState);
    }
  });
}
