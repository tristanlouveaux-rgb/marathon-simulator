import type { OnboardingState } from '@/types/onboarding';
import { MILESTONE_THRESHOLDS, MILESTONE_LABELS } from '@/types/onboarding';
import type { PBs, RecentRun } from '@/types/training';
import { cv } from '@/calculations/vdot';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

const INPUT = 'background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black);border-radius:8px;padding:8px 12px;font-size:14px;outline:none;box-sizing:border-box';

/**
 * Render the PB collection page
 */
export function renderPBs(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(6, 10)}

      <div style="width:100%;max-width:480px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Your Personal Bests
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
          Enter at least one PB to help us calibrate your plan
        </p>

        <div style="display:flex;flex-direction:column;gap:16px">
          <!-- PB Inputs -->
          <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:20px">
            <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:16px">All-time PBs</h3>

            ${renderPBInput('5K', 'pb-5k', state.pbs.k5, 'mm:ss', '17:30', false)}
            ${renderPBInput('10K', 'pb-10k', state.pbs.k10, 'mm:ss', '36:00', false)}
            ${renderPBInput('Half Marathon', 'pb-half', state.pbs.h, 'h:mm or h:mm:ss', '1:20', true)}
            ${renderPBInput('Marathon', 'pb-marathon', state.pbs.m, 'h:mm or h:mm:ss', '3:12', true)}

            <p style="font-size:12px;color:var(--c-faint);margin-top:12px">
              Leave blank if you haven't raced this distance
            </p>
          </div>

          <!-- Recent Hard Run -->
          <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:20px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <h3 style="font-size:14px;font-weight:500;color:var(--c-black)">Recent Hard Run</h3>
              <span style="font-size:12px;color:var(--c-faint)">Optional</span>
            </div>

            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:10px">
              <input type="checkbox" id="has-recent"
                ${state.recentRace ? 'checked' : ''}
                style="width:18px;height:18px;accent-color:var(--c-black)">
              <span style="font-size:14px;color:var(--c-black)">I've done a hard run recently</span>
            </label>

            <p style="font-size:12px;color:var(--c-muted);margin-bottom:12px">
              Your all-time PBs show your potential, but a recent effort helps gauge current fitness for more accurate pacing.
            </p>

            <div id="recent-race-form" style="${state.recentRace ? '' : 'display:none;'}padding-top:12px;border-top:1px solid var(--c-border)">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                <div>
                  <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Distance (km)</label>
                  <select id="recent-distance" style="${INPUT}">
                    <option value="5" ${state.recentRace?.d === 5 ? 'selected' : ''}>5K</option>
                    <option value="10" ${state.recentRace?.d === 10 ? 'selected' : ''}>10K</option>
                    <option value="21.1" ${state.recentRace?.d === 21.1 ? 'selected' : ''}>Half Marathon</option>
                    <option value="42.2" ${state.recentRace?.d === 42.2 ? 'selected' : ''}>Marathon</option>
                  </select>
                </div>
                <div>
                  <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Weeks ago</label>
                  <input type="number" id="recent-weeks" min="0" max="52"
                    value="${state.recentRace?.weeksAgo || 2}"
                    style="${INPUT}">
                </div>
              </div>
              <div>
                <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Time</label>
                <input type="text" id="recent-time"
                  placeholder="mm:ss or h:mm:ss"
                  value="${state.recentRace ? formatTime(state.recentRace.t) : ''}"
                  style="${INPUT};width:100%">
              </div>
            </div>
          </div>

          <!-- Validation message -->
          <div id="pb-error" style="display:none;text-align:center;color:var(--c-warn);font-size:14px">
            Please enter at least one personal best
          </div>
        </div>

        <button id="continue-pbs"
          style="margin-top:24px;width:100%;padding:14px 20px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
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
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <label style="width:110px;font-size:13px;color:var(--c-muted);flex-shrink:0">${label}</label>
      <input type="text" id="${id}"
        placeholder="${placeholder}"
        value="${value ? formatTime(value, isLong) : ''}"
        style="${INPUT};flex:1">
      <span style="font-size:11px;color:var(--c-faint);width:60px;flex-shrink:0">e.g. ${example}</span>
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
  if (!timeStr || !timeStr.trim()) return null;
  const parts = timeStr.trim().split(':').map(p => parseInt(p, 10));
  if (parts.some(isNaN)) return null;

  if (parts.length === 2) {
    const [first, second] = parts;
    if (first < 0 || second < 0 || second >= 60) return null;
    if (forLongDistance && first >= 1 && first <= 6 && second < 60) return first * 3600 + second * 60;
    return first * 60 + second;
  } else if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    if (hours < 0 || minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

function isLongDistance(key: string): boolean {
  return key === 'h' || key === 'm';
}

function wireEventHandlers(state: OnboardingState): void {
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
        if (time !== null) { (newPbs as any)[key] = time; } else { delete (newPbs as any)[key]; }
        updateOnboarding({ pbs: newPbs });
      });
    }
  });

  const hasRecentCheckbox = document.getElementById('has-recent') as HTMLInputElement;
  const recentForm = document.getElementById('recent-race-form');

  if (hasRecentCheckbox && recentForm) {
    hasRecentCheckbox.addEventListener('change', () => {
      recentForm.style.display = hasRecentCheckbox.checked ? '' : 'none';
      if (!hasRecentCheckbox.checked) updateOnboarding({ recentRace: null });
    });
  }

  const recentDistanceSelect = document.getElementById('recent-distance') as HTMLSelectElement;
  const recentWeeksInput = document.getElementById('recent-weeks') as HTMLInputElement;
  const recentTimeInput = document.getElementById('recent-time') as HTMLInputElement;

  const updateRecentRace = () => {
    if (!hasRecentCheckbox?.checked) return;
    const distance = parseFloat(recentDistanceSelect?.value || '5');
    const weeksAgo = parseInt(recentWeeksInput?.value || '2');
    const time = parseTime(recentTimeInput?.value || '');
    if (time !== null) updateOnboarding({ recentRace: { d: distance, t: time, weeksAgo } });
  };

  recentDistanceSelect?.addEventListener('change', updateRecentRace);
  recentWeeksInput?.addEventListener('blur', updateRecentRace);
  recentTimeInput?.addEventListener('blur', updateRecentRace);

  document.getElementById('continue-pbs')?.addEventListener('click', () => {
    const pbs: PBs = {};
    pbInputs.forEach(({ id, key }) => {
      const input = document.getElementById(id) as HTMLInputElement;
      if (input) {
        const time = parseTime(input.value, isLongDistance(key));
        if (time !== null) (pbs as any)[key] = time;
      }
    });

    if (Object.keys(pbs).length === 0) {
      const errorEl = document.getElementById('pb-error');
      if (errorEl) errorEl.style.display = '';
      return;
    }

    updateOnboarding({ pbs });

    if (hasRecentCheckbox?.checked) {
      const distance = parseFloat(recentDistanceSelect?.value || '5');
      const weeksAgo = parseInt(recentWeeksInput?.value || '2');
      const time = parseTime(recentTimeInput?.value || '');
      if (time !== null) updateOnboarding({ recentRace: { d: distance, t: time, weeksAgo } });
    }

    if (shouldRecommendUpgrade(state, pbs)) {
      showUpgradeModal(state, pbs);
    } else {
      nextStep();
    }
  });
}

const PB_METERS: Record<string, number> = { k5: 5000, k10: 10000, h: 21097, m: 42195 };

function bestVdot(pbs: PBs): number {
  let best = 0;
  for (const [key, meters] of Object.entries(PB_METERS)) {
    const t = (pbs as any)[key] as number | undefined;
    if (t && t > 0) best = Math.max(best, cv(meters, t));
  }
  return best;
}

function shouldRecommendUpgrade(state: OnboardingState, pbs: PBs): boolean {
  if (!state.trainingForEvent || !state.raceDistance) return false;
  if (state.runsPerWeek >= 4) return false;
  const vdot = bestVdot(pbs);
  if (vdot === 0) return false;
  const thresholds = MILESTONE_THRESHOLDS[state.raceDistance];
  if (!thresholds) return false;
  for (const targetTime of thresholds) {
    const dist = state.raceDistance === 'marathon' ? 42195 : state.raceDistance === 'half' ? 21097 : state.raceDistance === '10k' ? 10000 : 5000;
    const requiredVdot = cv(dist, targetTime);
    const gap = (requiredVdot - vdot) / requiredVdot;
    if (gap > 0 && gap < 0.04) return true;
  }
  return false;
}

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
    if (gap > 0 && gap < closestGap) { closestGap = gap; closestLabel = labels[i]; }
  }
  return closestLabel;
}

function showUpgradeModal(state: OnboardingState, pbs: PBs): void {
  const label = nearestMilestoneLabel(state, pbs);

  const overlay = document.createElement('div');
  overlay.id = 'upgrade-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border:1px solid var(--c-border-strong);border-radius:16px;max-width:400px;width:100%;padding:24px">
      <h3 style="font-size:17px;font-weight:600;color:var(--c-black);text-align:center;margin-bottom:12px">Recommendation</h3>
      <p style="font-size:14px;color:var(--c-muted);text-align:center;line-height:1.5;margin-bottom:20px">
        To secure your <span style="font-weight:600;color:var(--c-black)">${label}</span> goal safely,
        we recommend <span style="font-weight:600;color:var(--c-black)">4 runs/week</span> to build durability.
      </p>
      <div style="display:flex;flex-direction:column;gap:10px">
        <button id="btn-upgrade-runs"
          style="width:100%;padding:13px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:10px;font-size:15px;font-weight:500;cursor:pointer">
          Upgrade to 4 Runs
        </button>
        <button id="btn-keep-runs"
          style="width:100%;padding:13px;background:var(--c-surface);color:var(--c-black);border:1.5px solid var(--c-border-strong);border-radius:10px;font-size:15px;cursor:pointer">
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
