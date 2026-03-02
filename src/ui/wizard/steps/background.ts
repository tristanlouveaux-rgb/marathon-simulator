import type { OnboardingState } from '@/types/onboarding';
import type { CommuteConfig } from '@/types/state';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

const INPUT = 'background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black);border-radius:8px;padding:7px 10px;font-size:13px;width:100%;box-sizing:border-box;outline:none';

function selRow(selected: boolean): string {
  return selected
    ? 'background:rgba(0,0,0,0.04);border:2px solid var(--c-black)'
    : 'background:var(--c-surface);border:2px solid var(--c-border-strong)';
}

/**
 * Consolidated Background step: Experience Level + Commute + Active Lifestyle
 */
export function renderBackground(container: HTMLElement, state: OnboardingState): void {
  const config = state.commuteConfig || { enabled: true, distanceKm: 5, isBidirectional: false, commuteDaysPerWeek: 2 };

  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(3, 7)}

      <div style="width:100%;max-width:480px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Your Background
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
          Help us understand your fitness profile
        </p>

        <div style="display:flex;flex-direction:column;gap:20px">
          <!-- Experience Level -->
          <div>
            <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">Running Background</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              ${renderExperienceOptions(state.experienceLevel)}
            </div>
          </div>

          <!-- Commute Toggle -->
          <div>
            <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">Do you run to work? (5km+)</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              <button id="commute-yes"
                style="${selRow(state.runsToWork === true)};border-radius:10px;padding:12px 16px;cursor:pointer;transition:all 0.15s;text-align:left;width:100%">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <span style="font-size:14px;font-weight:500;color:var(--c-black)">Yes</span>
                  ${state.runsToWork === true ? '<svg style="width:16px;height:16px;color:var(--c-black)" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>' : ''}
                </div>
              </button>
              <button id="commute-no"
                style="${selRow(state.runsToWork === false)};border-radius:10px;padding:12px 16px;cursor:pointer;transition:all 0.15s;text-align:left;width:100%">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <span style="font-size:14px;font-weight:500;color:var(--c-black)">No</span>
                  ${state.runsToWork === false ? '<svg style="width:16px;height:16px;color:var(--c-black)" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>' : ''}
                </div>
              </button>
            </div>

            <!-- Inline commute config -->
            <div id="commute-config" style="${state.runsToWork === true ? '' : 'display:none;'}margin-top:12px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;padding:16px">
              <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
                <div>
                  <label style="display:block;font-size:11px;color:var(--c-muted);margin-bottom:4px">Distance (km)</label>
                  <input type="number" id="commute-distance" min="1" max="25" step="0.5" value="${config.distanceKm}"
                    style="${INPUT}">
                </div>
                <div>
                  <label style="display:block;font-size:11px;color:var(--c-muted);margin-bottom:4px">Days/week</label>
                  <div style="display:flex;gap:3px">
                    ${[1, 2, 3, 4, 5].map(n => `
                      <button data-days="${n}" class="commute-day" style="flex:1;padding:6px 2px;font-size:11px;border-radius:6px;cursor:pointer;font-weight:500;transition:all 0.15s;border:none;
                        ${config.commuteDaysPerWeek === n ? 'background:var(--c-black);color:#FDFCF7' : 'background:var(--c-bg);color:var(--c-black)'}">
                        ${n}
                      </button>
                    `).join('')}
                  </div>
                </div>
                <div style="display:flex;align-items:flex-end">
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding-bottom:2px">
                    <input type="checkbox" id="commute-bidir" ${config.isBidirectional ? 'checked' : ''}
                      style="width:16px;height:16px;accent-color:var(--c-black)">
                    <span style="font-size:12px;color:var(--c-black)">Both ways</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- Active Lifestyle Toggle -->
          <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;padding:16px;display:flex;align-items:center;justify-content:space-between">
            <div style="flex:1;margin-right:16px">
              <div style="font-size:14px;font-weight:500;color:var(--c-black)">Active Job / Lifestyle</div>
              <div style="font-size:12px;color:var(--c-muted);margin-top:2px">Do you spend most of the day on your feet? (e.g. Waiter, Nurse, Manual Labor)</div>
            </div>
            <button id="toggle-active"
              style="width:48px;height:26px;border-radius:13px;border:none;cursor:pointer;transition:background 0.2s;position:relative;flex-shrink:0;background:${state.activeLifestyle ? 'var(--c-black)' : 'rgba(0,0,0,0.15)'}">
              <span style="display:block;width:20px;height:20px;background:white;border-radius:50%;position:absolute;top:3px;transition:transform 0.2s;transform:${state.activeLifestyle ? 'translateX(25px)' : 'translateX(3px)'}"></span>
            </button>
          </div>
        </div>

        <button id="continue-background"
          style="margin-top:24px;width:100%;padding:14px 20px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
          Continue
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state);
}

function renderExperienceOptions(current: string): string {
  const options = [
    { key: 'total_beginner', title: 'Total Beginner', desc: 'Never run before' },
    { key: 'beginner', title: 'Beginner', desc: 'Running < 6 months' },
    { key: 'novice', title: 'Novice', desc: 'Occasional 5ks/10ks' },
    { key: 'intermediate', title: 'Intermediate', desc: 'Consistent runner, raced before' },
    { key: 'advanced', title: 'Advanced', desc: 'Dedicated, year-round training' },
    { key: 'competitive', title: 'Competitive', desc: 'High performance / Club level' },
    { key: 'returning', title: 'Returning Athlete', desc: 'Strong history, rebuilding' },
    { key: 'hybrid', title: 'Hybrid Athlete', desc: 'Fit from other sports, low miles' },
  ];

  return options.map(o => `
    <button data-exp="${o.key}"
      style="${
        current === o.key
          ? 'background:rgba(0,0,0,0.04);border:2px solid var(--c-black)'
          : 'background:var(--c-surface);border:2px solid var(--c-border-strong)'
      };border-radius:10px;padding:12px 16px;cursor:pointer;transition:all 0.15s;text-align:left;width:100%" class="exp-btn">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <span style="font-size:14px;font-weight:500;color:var(--c-black)">${o.title}</span>
          <span style="font-size:12px;color:var(--c-muted);margin-left:8px">${o.desc}</span>
        </div>
        ${current === o.key ? '<svg style="width:16px;height:16px;flex-shrink:0;color:var(--c-black)" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>' : ''}
      </div>
    </button>
  `).join('');
}

function wireEventHandlers(state: OnboardingState): void {
  // Experience
  document.querySelectorAll('.exp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const exp = btn.getAttribute('data-exp') as OnboardingState['experienceLevel'];
      if (exp) { updateOnboarding({ experienceLevel: exp }); rerender(state); }
    });
  });

  // Commute yes/no
  document.getElementById('commute-yes')?.addEventListener('click', () => {
    updateOnboarding({
      runsToWork: true,
      commuteConfig: state.commuteConfig || { enabled: true, distanceKm: 5, isBidirectional: false, commuteDaysPerWeek: 2 },
    });
    rerender(state);
  });

  document.getElementById('commute-no')?.addEventListener('click', () => {
    updateOnboarding({ runsToWork: false, commuteConfig: null });
    rerender(state);
  });

  // Commute config
  const distInput = document.getElementById('commute-distance') as HTMLInputElement;
  if (distInput) {
    distInput.addEventListener('change', () => {
      updateCommuteConfig(state, { distanceKm: parseFloat(distInput.value) || 5 });
    });
  }

  const bidirCheckbox = document.getElementById('commute-bidir') as HTMLInputElement;
  if (bidirCheckbox) {
    bidirCheckbox.addEventListener('change', () => {
      updateCommuteConfig(state, { isBidirectional: bidirCheckbox.checked });
    });
  }

  document.querySelectorAll('.commute-day').forEach(btn => {
    btn.addEventListener('click', () => {
      const days = parseInt(btn.getAttribute('data-days') || '2');
      updateCommuteConfig(state, { commuteDaysPerWeek: days });
      rerender(state);
    });
  });

  // Active lifestyle
  document.getElementById('toggle-active')?.addEventListener('click', () => {
    updateOnboarding({ activeLifestyle: !state.activeLifestyle });
    rerender(state);
  });

  // Continue
  document.getElementById('continue-background')?.addEventListener('click', () => nextStep());
}

function updateCommuteConfig(state: OnboardingState, updates: Partial<CommuteConfig>): void {
  const current = state.commuteConfig || { enabled: true, distanceKm: 5, isBidirectional: false, commuteDaysPerWeek: 2 };
  updateOnboarding({ commuteConfig: { ...current, ...updates } });
}

function rerender(state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderBackground(container, currentState);
    }
  });
}
