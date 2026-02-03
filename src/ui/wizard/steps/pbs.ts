import type { OnboardingState } from '@/types/onboarding';
import { MILESTONE_THRESHOLDS, MILESTONE_LABELS } from '@/types/onboarding';
import type { PBs, RecentRun } from '@/types/training';
import { cv } from '@/calculations/vdot';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

/**
 * Render the PB collection page (Step 6)
 * Collects personal bests and optional recent race
 */
export function renderPBs(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div class="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-6 py-12">
      ${renderProgressIndicator(6, 10)}

      <div class="max-w-lg w-full">
        <!-- Title -->
        <h2 class="text-2xl md:text-3xl font-light text-white mb-2 text-center">
          Your Personal Bests
        </h2>
        <p class="text-gray-400 text-center mb-8">
          Enter at least one PB to help us calibrate your plan
        </p>

        <div class="space-y-6">
          <!-- PB Inputs -->
          <div class="bg-gray-800 rounded-xl p-5 space-y-4">
            <h3 class="text-sm font-medium text-white mb-3">All-time PBs</h3>

            ${renderPBInput('5K', 'pb-5k', state.pbs.k5, 'mm:ss', '17:30', false)}
            ${renderPBInput('10K', 'pb-10k', state.pbs.k10, 'mm:ss', '36:00', false)}
            ${renderPBInput('Half Marathon', 'pb-half', state.pbs.h, 'h:mm or h:mm:ss', '1:20', true)}
            ${renderPBInput('Marathon', 'pb-marathon', state.pbs.m, 'h:mm or h:mm:ss', '3:12', true)}

            <p class="text-xs text-gray-500 mt-2">
              Leave blank if you haven't raced this distance
            </p>
          </div>

          <!-- Recent Hard Run (Optional) -->
          <div class="bg-gray-800 rounded-xl p-5">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-medium text-white">Recent Hard Run</h3>
              <span class="text-xs text-gray-500">Optional</span>
            </div>

            <label class="flex items-center gap-3 cursor-pointer mb-4">
              <input type="checkbox" id="has-recent"
                ${state.recentRace ? 'checked' : ''}
                class="w-5 h-5 rounded bg-gray-900 border-gray-700 text-emerald-500
                       focus:ring-emerald-500 focus:ring-offset-gray-800">
              <span class="text-sm text-gray-300">I've done a hard run recently</span>
            </label>

            <p class="text-xs text-gray-500 mb-4">
              Your all-time PBs show your potential, but a recent hard effort helps us
              gauge your current fitness level. This allows for more accurate pacing.
            </p>

            <div id="recent-race-form" class="${state.recentRace ? '' : 'hidden'} space-y-4 pt-2 border-t border-gray-700">
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Distance (km)</label>
                  <select id="recent-distance"
                    class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                           text-white text-sm focus:border-emerald-500 focus:outline-none">
                    <option value="5" ${state.recentRace?.d === 5 ? 'selected' : ''}>5K</option>
                    <option value="10" ${state.recentRace?.d === 10 ? 'selected' : ''}>10K</option>
                    <option value="21.1" ${state.recentRace?.d === 21.1 ? 'selected' : ''}>Half Marathon</option>
                    <option value="42.2" ${state.recentRace?.d === 42.2 ? 'selected' : ''}>Marathon</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs text-gray-400 mb-1">Weeks ago</label>
                  <input type="number" id="recent-weeks" min="0" max="52"
                    value="${state.recentRace?.weeksAgo || 2}"
                    class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                           text-white text-sm focus:border-emerald-500 focus:outline-none">
                </div>
              </div>
              <div>
                <label class="block text-xs text-gray-400 mb-1">Time</label>
                <input type="text" id="recent-time"
                  placeholder="mm:ss or h:mm:ss"
                  value="${state.recentRace ? formatTime(state.recentRace.t) : ''}"
                  class="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
                         text-white text-sm focus:border-emerald-500 focus:outline-none">
              </div>
            </div>
          </div>

          <!-- Validation message -->
          <div id="pb-error" class="hidden text-center text-red-400 text-sm">
            Please enter at least one personal best
          </div>
        </div>

        <button id="continue-pbs"
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

function renderPBInput(
  label: string,
  id: string,
  value: number | undefined,
  placeholder: string,
  example: string,
  isLong: boolean = false
): string {
  return `
    <div class="flex items-center gap-3">
      <label class="w-28 text-sm text-gray-400">${label}</label>
      <input type="text" id="${id}"
        placeholder="${placeholder}"
        value="${value ? formatTime(value, isLong) : ''}"
        class="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg
               text-white text-sm focus:border-emerald-500 focus:outline-none
               placeholder:text-gray-600">
      <span class="text-xs text-gray-600 w-16">e.g. ${example}</span>
    </div>
  `;
}

function formatTime(seconds: number, isLong: boolean = false): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    // For long distances, show h:mm format for cleaner display if seconds is 0
    if (isLong && secs === 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}`;
    }
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Parse time string with intelligent format detection.
 * Handles both mm:ss and h:mm:ss formats.
 * For longer distances (half/marathon), if mm:ss format looks like hours:minutes
 * (e.g., "3:12" meaning 3:12:00), it auto-converts.
 */
function parseTime(timeStr: string, forLongDistance: boolean = false): number | null {
  if (!timeStr || !timeStr.trim()) return null;

  const parts = timeStr.trim().split(':').map(p => parseInt(p, 10));

  if (parts.some(isNaN)) return null;

  if (parts.length === 2) {
    const [first, second] = parts;
    if (first < 0 || second < 0 || second >= 60) return null;

    // For long distances (half/marathon), if the first number is small (1-6)
    // and second is reasonable for minutes (0-59), interpret as h:mm
    // e.g., "3:12" for marathon should be 3 hours 12 minutes, not 3 min 12 sec
    if (forLongDistance && first >= 1 && first <= 6 && second < 60) {
      // Likely h:mm format (missing seconds)
      return first * 3600 + second * 60;
    }

    // Standard mm:ss format
    return first * 60 + second;
  } else if (parts.length === 3) {
    // h:mm:ss
    const [hours, minutes, seconds] = parts;
    if (hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  return null;
}

/**
 * Determine if a PB field is for a long distance (half/marathon)
 */
function isLongDistance(key: string): boolean {
  return key === 'h' || key === 'm';
}

function wireEventHandlers(state: OnboardingState): void {
  // PB inputs - save on blur
  const pbInputs = [
    { id: 'pb-5k', key: 'k5' },
    { id: 'pb-10k', key: 'k10' },
    { id: 'pb-half', key: 'h' },
    { id: 'pb-marathon', key: 'm' },
  ];

  pbInputs.forEach(({ id, key }) => {
    const input = document.getElementById(id) as HTMLInputElement;
    if (input) {
      input.addEventListener('blur', () => {
        const time = parseTime(input.value, isLongDistance(key));
        const newPbs: PBs = { ...state.pbs };

        if (time !== null) {
          (newPbs as any)[key] = time;
        } else {
          delete (newPbs as any)[key];
        }

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

      if (!hasRecentCheckbox.checked) {
        updateOnboarding({ recentRace: null });
      }
    });
  }

  // Recent race inputs
  const recentDistanceSelect = document.getElementById('recent-distance') as HTMLSelectElement;
  const recentWeeksInput = document.getElementById('recent-weeks') as HTMLInputElement;
  const recentTimeInput = document.getElementById('recent-time') as HTMLInputElement;

  const updateRecentRace = () => {
    if (!hasRecentCheckbox?.checked) return;

    const distance = parseFloat(recentDistanceSelect?.value || '5');
    const weeksAgo = parseInt(recentWeeksInput?.value || '2');
    const time = parseTime(recentTimeInput?.value || '');

    if (time !== null) {
      updateOnboarding({
        recentRace: {
          d: distance,
          t: time,
          weeksAgo: weeksAgo,
        },
      });
    }
  };

  recentDistanceSelect?.addEventListener('change', updateRecentRace);
  recentWeeksInput?.addEventListener('blur', updateRecentRace);
  recentTimeInput?.addEventListener('blur', updateRecentRace);

  // Continue button
  document.getElementById('continue-pbs')?.addEventListener('click', () => {
    // Collect current values from form
    const pbs: PBs = {};
    pbInputs.forEach(({ id, key }) => {
      const input = document.getElementById(id) as HTMLInputElement;
      if (input) {
        const time = parseTime(input.value, isLongDistance(key));
        if (time !== null) {
          (pbs as any)[key] = time;
        }
      }
    });

    // Validate - need at least one PB
    if (Object.keys(pbs).length === 0) {
      const errorEl = document.getElementById('pb-error');
      if (errorEl) {
        errorEl.classList.remove('hidden');
      }
      return;
    }

    // Update state and continue
    updateOnboarding({ pbs });

    // Check and update recent race
    if (hasRecentCheckbox?.checked) {
      const distance = parseFloat(recentDistanceSelect?.value || '5');
      const weeksAgo = parseInt(recentWeeksInput?.value || '2');
      const time = parseTime(recentTimeInput?.value || '');

      if (time !== null) {
        updateOnboarding({
          recentRace: {
            d: distance,
            t: time,
            weeksAgo: weeksAgo,
          },
        });
      }
    }

    // Smart assessment: check if runner is close to a milestone but under-training
    if (shouldRecommendUpgrade(state, pbs)) {
      showUpgradeModal(state, pbs);
    } else {
      nextStep();
    }
  });
}

/** PB distance keys mapped to meters */
const PB_METERS: Record<string, number> = {
  k5: 5000,
  k10: 10000,
  h: 21097,
  m: 42195,
};

/** Compute best VDOT from a set of PBs */
function bestVdot(pbs: PBs): number {
  let best = 0;
  for (const [key, meters] of Object.entries(PB_METERS)) {
    const t = (pbs as any)[key] as number | undefined;
    if (t && t > 0) {
      best = Math.max(best, cv(meters, t));
    }
  }
  return best;
}

/** Check if runner should be recommended to upgrade runs/week */
function shouldRecommendUpgrade(state: OnboardingState, pbs: PBs): boolean {
  if (!state.trainingForEvent || !state.raceDistance) return false;
  if (state.runsPerWeek >= 4) return false;

  const vdot = bestVdot(pbs);
  if (vdot === 0) return false;

  const thresholds = MILESTONE_THRESHOLDS[state.raceDistance];
  if (!thresholds) return false;

  // Check each milestone: is the runner's VDOT within 4% of the required VDOT?
  for (const targetTime of thresholds) {
    const dist = state.raceDistance === 'marathon' ? 42195
      : state.raceDistance === 'half' ? 21097
      : state.raceDistance === '10k' ? 10000
      : 5000;
    const requiredVdot = cv(dist, targetTime);
    const gap = (requiredVdot - vdot) / requiredVdot;

    // Within 0-4% means close but not quite there
    if (gap > 0 && gap < 0.04) return true;
  }

  return false;
}

/** Find the nearest milestone label for display */
function nearestMilestoneLabel(state: OnboardingState, pbs: PBs): string {
  const vdot = bestVdot(pbs);
  const dist = state.raceDistance!;
  const thresholds = MILESTONE_THRESHOLDS[dist];
  const labels = MILESTONE_LABELS[dist];
  const meters = dist === 'marathon' ? 42195 : dist === 'half' ? 21097 : dist === '10k' ? 10000 : 5000;

  let closestLabel = labels[0];
  let closestGap = Infinity;

  for (let i = 0; i < thresholds.length; i++) {
    const requiredVdot = cv(meters, thresholds[i]);
    const gap = (requiredVdot - vdot) / requiredVdot;
    if (gap > 0 && gap < closestGap) {
      closestGap = gap;
      closestLabel = labels[i];
    }
  }

  return closestLabel;
}

/** Show the upgrade recommendation modal */
function showUpgradeModal(state: OnboardingState, pbs: PBs): void {
  const label = nearestMilestoneLabel(state, pbs);

  const overlay = document.createElement('div');
  overlay.id = 'upgrade-modal-overlay';
  overlay.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4';
  overlay.innerHTML = `
    <div class="bg-gray-900 rounded-2xl max-w-md w-full p-6 space-y-5">
      <h3 class="text-lg font-medium text-white text-center">Recommendation</h3>
      <p class="text-gray-300 text-sm text-center leading-relaxed">
        To secure your <span class="text-emerald-400 font-medium">${label}</span> goal safely,
        we strongly recommend <span class="text-white font-medium">4 runs/week</span> to build durability.
      </p>
      <div class="flex flex-col gap-3">
        <button id="btn-upgrade-runs"
          class="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-xl transition-all">
          Upgrade to 4 Runs
        </button>
        <button id="btn-keep-runs"
          class="w-full py-3 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-xl transition-all">
          Keep ${state.runsPerWeek} Runs
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('btn-upgrade-runs')?.addEventListener('click', () => {
    updateOnboarding({ runsPerWeek: 4 });
    overlay.remove();
    nextStep();
  });

  document.getElementById('btn-keep-runs')?.addEventListener('click', () => {
    overlay.remove();
    nextStep();
  });
}
