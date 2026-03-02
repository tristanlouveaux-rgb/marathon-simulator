import type { OnboardingState } from '@/types/onboarding';
import type { PBs } from '@/types/training';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

const INPUT = 'background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black);border-radius:8px;padding:8px 12px;font-size:14px;outline:none;box-sizing:border-box';

/**
 * Consolidated Performance step: PBs + Prominent Recent Hard Run
 */
export function renderPerformance(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(5, 7)}

      <div style="width:100%;max-width:480px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Your Performance
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
          Enter at least one PB to calibrate your plan
        </p>

        <div style="display:flex;flex-direction:column;gap:16px">
          <!-- PBs -->
          <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:20px">
            <h3 style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:16px">All-time PBs</h3>
            ${renderPBInput('5K', 'pb-5k', state.pbs.k5, 'mm:ss', '17:30', false)}
            ${renderPBInput('10K', 'pb-10k', state.pbs.k10, 'mm:ss', '36:00', false)}
            ${renderPBInput('Half Marathon', 'pb-half', state.pbs.h, 'h:mm or h:mm:ss', '1:20', true)}
            ${renderPBInput('Marathon', 'pb-marathon', state.pbs.m, 'h:mm or h:mm:ss', '3:12', true)}
            <p style="font-size:12px;color:var(--c-faint);margin-top:12px">Leave blank if you haven't raced this distance</p>
          </div>

          <!-- Recent Hard Run -->
          <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:20px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
              <div style="width:32px;height:32px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0">
                <svg style="width:16px;height:16px;color:var(--c-black)" fill="currentColor" viewBox="0 0 20 20">
                  <path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"/>
                </svg>
              </div>
              <div>
                <h3 style="font-size:14px;font-weight:500;color:var(--c-black)">Recent Hard Run</h3>
                <p style="font-size:12px;color:var(--c-muted);margin-top:1px">Helps gauge your <em>current</em> fitness vs. your all-time PBs</p>
              </div>
            </div>

            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:12px">
              <input type="checkbox" id="has-recent" ${state.recentRace ? 'checked' : ''}
                style="width:18px;height:18px;accent-color:var(--c-black)">
              <span style="font-size:14px;color:var(--c-black)">I've done a hard run recently</span>
            </label>

            <div id="recent-race-form" style="${state.recentRace ? '' : 'display:none;'}padding-top:12px;border-top:1px solid var(--c-border)">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                <div>
                  <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Distance</label>
                  <select id="recent-distance" style="${INPUT};width:100%">
                    <option value="5" ${state.recentRace?.d === 5 ? 'selected' : ''}>5K</option>
                    <option value="10" ${state.recentRace?.d === 10 ? 'selected' : ''}>10K</option>
                    <option value="21.1" ${state.recentRace?.d === 21.1 ? 'selected' : ''}>Half Marathon</option>
                    <option value="42.2" ${state.recentRace?.d === 42.2 ? 'selected' : ''}>Marathon</option>
                  </select>
                </div>
                <div>
                  <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Weeks ago</label>
                  <input type="number" id="recent-weeks" min="0" max="52" value="${state.recentRace?.weeksAgo || 2}"
                    style="${INPUT};width:100%">
                </div>
              </div>
              <div>
                <label style="display:block;font-size:12px;color:var(--c-muted);margin-bottom:4px">Time</label>
                <input type="text" id="recent-time" placeholder="mm:ss or h:mm:ss"
                  value="${state.recentRace ? formatTime(state.recentRace.t) : ''}"
                  style="${INPUT};width:100%">
              </div>
            </div>
          </div>

          <div id="pb-error" style="display:none;text-align:center;color:var(--c-warn);font-size:14px">
            Please enter at least one personal best
          </div>
        </div>

        <button id="continue-perf"
          style="margin-top:24px;width:100%;padding:14px 20px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
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
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <label style="width:110px;font-size:13px;color:var(--c-muted);flex-shrink:0">${label}</label>
      <input type="text" id="${id}" placeholder="${placeholder}" value="${value ? formatTime(value, isLong) : ''}"
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

  const hasRecentCheckbox = document.getElementById('has-recent') as HTMLInputElement;
  const recentForm = document.getElementById('recent-race-form');
  if (hasRecentCheckbox && recentForm) {
    hasRecentCheckbox.addEventListener('change', () => {
      recentForm.style.display = hasRecentCheckbox.checked ? '' : 'none';
      if (!hasRecentCheckbox.checked) updateOnboarding({ recentRace: null });
    });
  }

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
      const errorEl = document.getElementById('pb-error');
      if (errorEl) errorEl.style.display = '';
      return;
    }

    const PB_RANGES: Record<string, [number, number]> = {
      k5: [12 * 60, 45 * 60],
      k10: [25 * 60, 90 * 60],
      h: [60 * 60, 4 * 3600],
      m: [2 * 3600, 7 * 3600],
    };
    for (const [key, time] of Object.entries(pbs)) {
      const range = PB_RANGES[key];
      if (range && (time < range[0] || time > range[1])) {
        const errorEl = document.getElementById('pb-error');
        if (errorEl) { errorEl.textContent = 'That time looks unusual. Please double-check your entries.'; errorEl.style.display = ''; }
        return;
      }
    }

    updateOnboarding({ pbs });
    if (hasRecentCheckbox?.checked) updateRecent();
    nextStep();
  });
}
