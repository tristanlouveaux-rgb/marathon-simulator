import type { OnboardingState, Marathon } from '@/types/onboarding';
import type { RaceDistance } from '@/types/training';
import { getMarathonsByDistance, formatRaceDate, calculateWeeksUntil } from '@/data/marathons';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';

// Inline style constants
const CARD = 'background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:20px;margin-bottom:16px';
const INPUT = 'background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black);border-radius:8px;padding:8px 12px;font-size:14px;width:100%;box-sizing:border-box;outline:none';

function selBtn(selected: boolean): string {
  return selected
    ? 'background:var(--c-black);color:#FDFCF7;border:2px solid var(--c-black);border-radius:10px;padding:12px;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.15s;width:100%'
    : 'background:var(--c-surface);color:var(--c-black);border:2px solid var(--c-border-strong);border-radius:10px;padding:12px;font-size:14px;cursor:pointer;transition:all 0.15s;width:100%';
}

/**
 * Consolidated Goals step: Training for Event? -> Distance -> Event Selection (inline)
 */
export function renderGoals(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(2, 7)}

      <div style="width:100%;max-width:480px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Training Goal
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
          What are you training for?
        </p>

        <div style="display:flex;flex-direction:column;gap:16px">
          <!-- Event Toggle -->
          <div style="display:flex;gap:12px;justify-content:center">
            <button id="goal-event" style="flex:1;max-width:180px;${selBtn(state.trainingForEvent === true)}">
              Race
            </button>
            <button id="goal-general" style="flex:1;max-width:180px;${selBtn(state.trainingForEvent === false)}">
              General Fitness
            </button>
          </div>

          <!-- Distance Selection -->
          ${state.trainingForEvent !== null ? renderDistanceSelection(state) : ''}

          <!-- Week selector for 5k/10k races -->
          ${state.trainingForEvent && (state.raceDistance === '5k' || state.raceDistance === '10k')
            ? renderWeekSelector(state)
            : ''}

          <!-- Event Selection (inline, for half/marathon) -->
          ${state.trainingForEvent && (state.raceDistance === 'half' || state.raceDistance === 'marathon')
            ? renderInlineEventSelection(state)
            : ''}

          <!-- Focus Selection (for general fitness) -->
          ${state.trainingForEvent === false ? renderFocusSelection(state) : ''}

          <!-- Speed focus note -->
          ${state.trainingFocus === 'speed' ? `
            <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:12px">
              <p style="font-size:12px;color:var(--c-caution-text)"><strong>Note:</strong> Speed-focused training is more intense. Expect higher RPE sessions and ensure adequate recovery.</p>
            </div>
          ` : ''}
        </div>

        <button id="continue-goals"
          style="margin-top:24px;width:100%;padding:14px 20px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;opacity:${canContinue(state) ? '1' : '0.4'}"
          ${canContinue(state) ? '' : 'disabled'}>
          Continue
        </button>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireEventHandlers(state);
}

function canContinue(state: OnboardingState): boolean {
  if (state.trainingForEvent === null) return false;
  if (!state.raceDistance) return false;
  if (state.trainingForEvent && (state.raceDistance === 'half' || state.raceDistance === 'marathon')) {
    return !!(state.selectedRace || state.customRaceDate);
  }
  return true;
}

function renderDistanceSelection(state: OnboardingState): string {
  if (state.trainingForEvent === false) return '';
  const distances: { id: RaceDistance; label: string; sub: string }[] = [
    { id: '5k', label: '5K', sub: '3.1 miles' },
    { id: '10k', label: '10K', sub: '6.2 miles' },
    { id: 'half', label: 'Half', sub: '13.1 miles' },
    { id: 'marathon', label: 'Marathon', sub: '26.2 miles' },
  ];

  return `
    <div>
      <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">Distance</label>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        ${distances.map(d => `
          <button data-dist="${d.id}" style="${
            state.raceDistance === d.id
              ? 'background:var(--c-black);color:#FDFCF7;border:2px solid var(--c-black)'
              : 'background:var(--c-surface);color:var(--c-black);border:2px solid var(--c-border-strong)'
          };border-radius:10px;padding:10px 4px;cursor:pointer;transition:all 0.15s;text-align:center" class="dist-btn">
            <div style="font-size:14px;font-weight:500">${d.label}</div>
            <div style="font-size:11px;opacity:0.6;margin-top:2px">${d.sub}</div>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderWeekSelector(state: OnboardingState): string {
  const weeks = state.planDurationWeeks || (state.raceDistance === '5k' ? 8 : 10);
  const min = 4;
  const max = 52;
  return `
    <div>
      <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">Plan duration</label>
      <div style="display:flex;align-items:center;gap:12px">
        <button id="weeks-minus"
          style="width:40px;height:40px;border-radius:8px;background:var(--c-surface);border:1.5px solid var(--c-border-strong);color:var(--c-black);font-size:18px;cursor:pointer;opacity:${weeks <= min ? '0.3' : '1'}"
          ${weeks <= min ? 'disabled' : ''}>−</button>
        <div style="flex:1;text-align:center">
          <span style="font-size:24px;font-weight:300;color:var(--c-black)">${weeks}</span>
          <span style="font-size:14px;color:var(--c-muted);margin-left:4px">weeks</span>
        </div>
        <button id="weeks-plus"
          style="width:40px;height:40px;border-radius:8px;background:var(--c-surface);border:1.5px solid var(--c-border-strong);color:var(--c-black);font-size:18px;cursor:pointer;opacity:${weeks >= max ? '0.3' : '1'}"
          ${weeks >= max ? 'disabled' : ''}>+</button>
      </div>
    </div>
  `;
}

function renderFocusSelection(state: OnboardingState): string {
  const options: { id: string; label: string; desc: string; dist: RaceDistance; weeks: number }[] = [
    { id: 'speed', label: 'Speed', desc: 'Build raw speed', dist: '5k', weeks: 8 },
    { id: 'both', label: 'Balanced', desc: 'Speed + endurance', dist: '10k', weeks: 10 },
    { id: 'endurance', label: 'Endurance', desc: 'Aerobic base', dist: 'half', weeks: 12 },
  ];

  return `
    <div>
      <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">Focus</label>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${options.map(o => `
          <button data-focus="${o.id}" data-focus-dist="${o.dist}" data-focus-weeks="${o.weeks}"
            style="${
              state.trainingFocus === o.id
                ? 'background:rgba(0,0,0,0.04);border:2px solid var(--c-black);color:var(--c-black)'
                : 'background:var(--c-surface);border:2px solid var(--c-border-strong);color:var(--c-black)'
            };border-radius:10px;padding:12px 16px;cursor:pointer;transition:all 0.15s;text-align:left;width:100%" class="focus-btn">
            <span style="font-size:14px;font-weight:500">${o.label}</span>
            <span style="font-size:12px;color:var(--c-muted);margin-left:8px">${o.desc}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function renderInlineEventSelection(state: OnboardingState): string {
  const distance = state.raceDistance === 'marathon' ? 'marathon' : 'half';
  const races = getMarathonsByDistance(distance);

  return `
    <div>
      <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">Select your event</label>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto;padding-right:4px">
        ${races.slice(0, 8).map(race => `
          <button data-race-id="${race.id}"
            style="${
              state.selectedRace?.id === race.id
                ? 'background:rgba(0,0,0,0.04);border:2px solid var(--c-black)'
                : 'background:var(--c-surface);border:2px solid var(--c-border-strong)'
            };border-radius:10px;padding:12px 16px;cursor:pointer;transition:all 0.15s;text-align:left;width:100%" class="race-card">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <span style="font-size:14px;font-weight:500;color:var(--c-black)">${race.name}</span>
                <span style="font-size:12px;color:var(--c-muted);margin-left:8px">${formatRaceDate(race.date)}</span>
              </div>
              <span style="font-size:12px;font-weight:600;color:${race.weeksUntil && race.weeksUntil < 12 ? 'var(--c-caution)' : 'var(--c-ok)'}">${race.weeksUntil}wk</span>
            </div>
          </button>
        `).join('')}
      </div>

      <!-- Custom date toggle -->
      <div style="margin-top:12px">
        <button id="toggle-custom-date" style="font-size:12px;color:var(--c-faint);background:none;border:none;cursor:pointer">
          ${state.customRaceDate !== null ? 'Browse races' : 'Enter custom date'}
        </button>
        ${state.customRaceDate !== null ? `
          <div style="margin-top:8px">
            <input type="date" id="custom-date-input" value="${state.customRaceDate || ''}"
              style="${INPUT}">
            ${state.customRaceDate ? `<p id="custom-date-weeks-display" style="font-size:12px;color:var(--c-ok);margin-top:4px">${calculateWeeksUntil(state.customRaceDate)} weeks of training</p>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function wireEventHandlers(state: OnboardingState): void {
  const races = (state.raceDistance === 'half' || state.raceDistance === 'marathon')
    ? getMarathonsByDistance(state.raceDistance === 'marathon' ? 'marathon' : 'half')
    : [];

  document.getElementById('goal-event')?.addEventListener('click', () => {
    updateOnboarding({ trainingForEvent: true, trainingFocus: null });
    rerender(state);
  });

  document.getElementById('goal-general')?.addEventListener('click', () => {
    updateOnboarding({ trainingForEvent: false, selectedRace: null, customRaceDate: null });
    rerender(state);
  });

  // Distance buttons
  document.querySelectorAll('.dist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dist = btn.getAttribute('data-dist') as RaceDistance;
      const defaultWeeks = dist === '5k' ? 8 : dist === '10k' ? 10 : 16;
      updateOnboarding({ raceDistance: dist, planDurationWeeks: defaultWeeks, selectedRace: null, customRaceDate: null });
      rerender(state);
    });
  });

  // Focus buttons
  document.querySelectorAll('.focus-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const focus = btn.getAttribute('data-focus') as 'speed' | 'endurance' | 'both';
      const dist = btn.getAttribute('data-focus-dist') as RaceDistance;
      const weeks = parseInt(btn.getAttribute('data-focus-weeks') || '10');
      updateOnboarding({ trainingFocus: focus, raceDistance: dist, planDurationWeeks: weeks });
      rerender(state);
    });
  });

  // Race cards
  document.querySelectorAll('.race-card').forEach(card => {
    card.addEventListener('click', () => {
      const raceId = card.getAttribute('data-race-id');
      const race = races.find(r => r.id === raceId);
      if (race) {
        updateOnboarding({ selectedRace: race, planDurationWeeks: race.weeksUntil || 16, customRaceDate: null });
        rerender(state);
      }
    });
  });

  // Week stepper for 5k/10k
  document.getElementById('weeks-minus')?.addEventListener('click', () => {
    import('../controller').then(({ getOnboardingState }) => {
      const current = getOnboardingState() || state;
      const weeks = (current.planDurationWeeks || 8) - 1;
      if (weeks >= 4) {
        updateOnboarding({ planDurationWeeks: weeks });
        rerender(state);
      }
    });
  });
  document.getElementById('weeks-plus')?.addEventListener('click', () => {
    import('../controller').then(({ getOnboardingState }) => {
      const current = getOnboardingState() || state;
      const weeks = (current.planDurationWeeks || 8) + 1;
      if (weeks <= 52) {
        updateOnboarding({ planDurationWeeks: weeks });
        rerender(state);
      }
    });
  });

  // Custom date toggle
  document.getElementById('toggle-custom-date')?.addEventListener('click', () => {
    if (state.customRaceDate !== null) {
      updateOnboarding({ customRaceDate: null });
    } else {
      updateOnboarding({ customRaceDate: '', selectedRace: null });
    }
    rerender(state);
  });

  // Custom date input
  const dateInput = document.getElementById('custom-date-input') as HTMLInputElement;
  if (dateInput) {
    const maxDate = new Date();
    maxDate.setFullYear(maxDate.getFullYear() + 1);
    dateInput.max = maxDate.toISOString().split('T')[0];

    dateInput.addEventListener('change', () => {
      if (dateInput.value) {
        const weeks = calculateWeeksUntil(dateInput.value);
        updateOnboarding({ customRaceDate: dateInput.value, planDurationWeeks: weeks, selectedRace: null });
        const weeksEl = document.getElementById('custom-date-weeks-display');
        if (weeksEl) {
          weeksEl.textContent = `${weeks} weeks of training`;
        } else {
          rerender(state);
        }
      }
    });
  }

  // Continue
  document.getElementById('continue-goals')?.addEventListener('click', () => {
    import('../controller').then(({ getOnboardingState }) => {
      const current = getOnboardingState() || state;
      if (current.customRaceDate) {
        const weeks = calculateWeeksUntil(current.customRaceDate);
        if (weeks < 4) {
          const input = document.getElementById('custom-date-input') as HTMLInputElement;
          if (input) { input.setCustomValidity('Race must be at least 4 weeks away'); input.reportValidity(); }
          return;
        }
        if (weeks > 52) {
          const input = document.getElementById('custom-date-input') as HTMLInputElement;
          if (input) { input.setCustomValidity('Race must be within 1 year'); input.reportValidity(); }
          return;
        }
      }
      if (canContinue(current)) nextStep();
    });
  });
}

function rerender(_state: OnboardingState): void {
  import('../controller').then(({ getOnboardingState }) => {
    const currentState = getOnboardingState();
    if (currentState) {
      const container = document.getElementById('app-root');
      if (container) renderGoals(container, currentState);
    }
  });
}
