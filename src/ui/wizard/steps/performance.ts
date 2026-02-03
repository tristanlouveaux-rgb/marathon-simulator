import type { OnboardingState } from '@/types/onboarding';
import type { PBs } from '@/types/training';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Consolidated Performance step: PBs + Prominent Recent Hard Run
 */
export function renderPerformance(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(5, 7)}

      <div class="max-w-lg w-full">
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Your Performance
        </h2>
        <p class="text-gray-400 text-center mb-8">
          Enter at least one PB to calibrate your plan
        </p>

        <div class="space-y-6">
          <!-- PBs -->
          <div class="bg-gray-800 rounded-xl p-5 space-y-4">
            <h3 class="text-sm font-medium text-white mb-3">All-time PBs</h3>
            ${renderPBInput('5K', 'pb-5k', state.pbs.k5, 'mm:ss', '17:30', false)}
            ${renderPBInput('10K', 'pb-10k', state.pbs.k10, 'mm:ss', '36:00', false)}
            ${renderPBInput('Half Marathon', 'pb-half', state.pbs.h, 'h:mm or h:mm:ss', '1:20', true)}
            ${renderPBInput('Marathon', 'pb-marathon', state.pbs.m, 'h:mm or h:mm:ss', '3:12', true)}
            <p class="text-xs text-gray-500">Leave blank if you haven't raced this distance</p>
          </div>

          <!-- Recent Hard Run — PROMINENT -->
          <div class="bg-gradient-to-br from-blue-950/40 to-gray-800 rounded-xl p-5 border border-blue-800/40">
            <div class="flex items-center gap-3 mb-4">
              <div class="w-8 h-8 bg-blue-900/50 rounded-full flex items-center justify-center flex-shrink-0">
                <svg class="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/>
                </svg>
              </div>
              <div>
                <h3 class="text-sm font-medium text-blue-300">Recent Hard Run</h3>
                <p class="text-xs text-blue-400/70">This helps gauge your <em>current</em> fitness vs. your all-time PBs</p>
              </div>
            </div>

            <label class="flex items-center gap-3 cursor-pointer mb-4">
              <input type="checkbox" id="has-recent" ${state.recentRace ? 'checked' : ''}
                class="w-5 h-5 rounded bg-gray-900 border-gray-700 text-emerald-500
                       focus:ring-emerald-500 focus:ring-offset-gray-800">
              <span class="text-sm text-gray-300">I've done a hard run recently</span>
            </label>

            <div id="recent-race-form" class="${state.recentRace ? '' : 'hidden'} space-y-3 pt-3 border-t border-blue-800/30">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Distance</label>
                  <select id="recent-distance"
                    class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none">
                    <option value="5" ${state.recentRace?.d === 5 ? 'selected' : ''}>5K</option>
                    <option value="10" ${state.recentRace?.d === 10 ? 'selected' : ''}>10K</option>
                    <option value="21.1" ${state.recentRace?.d === 21.1 ? 'selected' : ''}>Half Marathon</option>
                    <option value="42.2" ${state.recentRace?.d === 42.2 ? 'selected' : ''}>Marathon</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Weeks ago</label>
                  <input type="number" id="recent-weeks" min="0" max="52" value="${state.recentRace?.weeksAgo || 2}"
                    class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none">
                </div>
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">Time</label>
                <input type="text" id="recent-time" placeholder="mm:ss or h:mm:ss"
                  value="${state.recentRace ? formatTime(state.recentRace.t) : ''}"
                  class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none">
              </div>
            </div>
          </div>

          <div id="pb-error" class="hidden text-center text-red-400 text-sm">
            Please enter at least one personal best
          </div>
        </div>

        <button id="continue-perf"
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

function renderPBInput(label: string, id: string, value: number | undefined, placeholder: string, example: string, isLong: boolean): string {
  return `
    <div class="flex items-center gap-3">
      <label class="w-28 text-sm text-gray-400">${label}</label>
      <input type="text" id="${id}" placeholder="${placeholder}" value="${value ? formatTime(value, isLong) : ''}"
        class="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white text-sm focus:border-emerald-500 focus:outline-none placeholder:text-gray-600">
      <span class="text-xs text-gray-600 w-16">e.g. ${example}</span>
    </div>
  `;
}

function formatTime(seconds: number, isLong: boolean = false): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    if (isLong && secs === 0) return `${hours}:${minutes.toString().padStart(2, '0')}`;
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function parseTime(timeStr: string, forLongDistance: boolean = false): number | null {
  if (!timeStr?.trim()) return null;
  const parts = timeStr.trim().split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) {
    const [first, second] = parts;
    if (first < 0 || second < 0 || second >= 60) return null;
    if (forLongDistance && first >= 1 && first <= 6 && second < 60) return first * 3600 + second * 60;
    return first * 60 + second;
  } else if (parts.length === 3) {
    const [h, m, s] = parts;
    if (h < 0 || m < 0 || m >= 60 || s < 0 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }
  return null;
}

function isLongDist(key: string): boolean { return key === 'h' || key === 'm'; }

function wireEventHandlers(state: OnboardingState): void {
  const pbInputs = [
    { id: 'pb-5k', key: 'k5' },
    { id: 'pb-10k', key: 'k10' },
    { id: 'pb-half', key: 'h' },
    { id: 'pb-marathon', key: 'm' },
  ];

  // PB blur handlers
  pbInputs.forEach(({ id, key }) => {
    const input = document.getElementById(id) as HTMLInputElement;
    if (input) {
      input.addEventListener('blur', () => {
        const time = parseTime(input.value, isLongDist(key));
        const newPbs: PBs = { ...state.pbs };
        if (time !== null) (newPbs as any)[key] = time;
        else delete (newPbs as any)[key];
        updateOnboarding({ pbs: newPbs });
      });
    }
  });

  // Recent race toggle
  const hasRecentCheckbox = document.getElementById('has-recent') as HTMLInputElement;
  const recentForm = document.getElementById('recent-race-form');
  if (hasRecentCheckbox && recentForm) {
    hasRecentCheckbox.addEventListener('change', () => {
      recentForm.classList.toggle('hidden', !hasRecentCheckbox.checked);
      if (!hasRecentCheckbox.checked) updateOnboarding({ recentRace: null });
    });
  }

  // Recent race fields
  const recentDist = document.getElementById('recent-distance') as HTMLSelectElement;
  const recentWeeks = document.getElementById('recent-weeks') as HTMLInputElement;
  const recentTime = document.getElementById('recent-time') as HTMLInputElement;

  const updateRecent = () => {
    if (!hasRecentCheckbox?.checked) return;
    const d = parseFloat(recentDist?.value || '5');
    const w = parseInt(recentWeeks?.value || '2');
    const t = parseTime(recentTime?.value || '');
    if (t !== null) updateOnboarding({ recentRace: { d, t, weeksAgo: w } });
  };

  recentDist?.addEventListener('change', updateRecent);
  recentWeeks?.addEventListener('blur', updateRecent);
  recentTime?.addEventListener('blur', updateRecent);

  // Continue
  document.getElementById('continue-perf')?.addEventListener('click', () => {
    const pbs: PBs = {};
    pbInputs.forEach(({ id, key }) => {
      const input = document.getElementById(id) as HTMLInputElement;
      if (input) {
        const time = parseTime(input.value, isLongDist(key));
        if (time !== null) (pbs as any)[key] = time;
      }
    });

    if (Object.keys(pbs).length === 0) {
      document.getElementById('pb-error')?.classList.remove('hidden');
      return;
    }

    // Sanity check PB values
    const PB_RANGES: Record<string, [number, number]> = {
      k5: [12 * 60, 45 * 60],        // 12:00 - 45:00
      k10: [25 * 60, 90 * 60],       // 25:00 - 1:30:00
      h: [60 * 60, 4 * 3600],        // 1:00:00 - 4:00:00
      m: [2 * 3600, 7 * 3600],       // 2:00:00 - 7:00:00
    };
    for (const [key, time] of Object.entries(pbs)) {
      const range = PB_RANGES[key];
      if (range && (time < range[0] || time > range[1])) {
        const errorEl = document.getElementById('pb-error');
        if (errorEl) {
          errorEl.textContent = `That time looks unusual. Please double-check your entries.`;
          errorEl.classList.remove('hidden');
        }
        return;
      }
    }

    updateOnboarding({ pbs });
    if (hasRecentCheckbox?.checked) updateRecent();
    nextStep();
  });
}
