import type { OnboardingState, RecurringActivity } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { SPORT_LABELS } from '@/constants/sports';

const SPORT_OPTIONS = Object.values(SPORT_LABELS);

const SEL_INPUT = 'background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black);border-radius:8px;padding:7px 10px;font-size:12px;box-sizing:border-box;outline:none';

function numBtn(selected: boolean): string {
  return selected
    ? 'background:var(--c-black);color:#FDFCF7;border:2px solid var(--c-black);border-radius:8px;padding:10px 4px;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.15s;width:100%'
    : 'background:var(--c-surface);color:var(--c-black);border:2px solid var(--c-border-strong);border-radius:8px;padding:10px 4px;font-size:14px;cursor:pointer;transition:all 0.15s;width:100%';
}

/**
 * Consolidated Volume step: Runs/Week + Sports/Week + Inline Activities
 */
export function renderVolume(container: HTMLElement, state: OnboardingState): void {
  container.innerHTML = `
    <div style="min-height:100vh;background:var(--c-bg);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px 96px">
      ${renderProgressIndicator(4, 7)}

      <div style="width:100%;max-width:480px">
        <h2 style="font-size:clamp(1.4rem,5vw,1.9rem);font-weight:300;color:var(--c-black);text-align:center;margin-bottom:8px">
          Training Volume
        </h2>
        <p style="font-size:15px;color:var(--c-muted);text-align:center;margin-bottom:32px">
          How much time can you dedicate?
        </p>

        <div style="display:flex;flex-direction:column;gap:20px">
          <!-- Runs per week -->
          <div>
            <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">Runs per week</label>
            <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px">
              ${[1, 2, 3, 4, 5, 6, 7].map(n => `
                <button data-runs="${n}" style="${numBtn(state.runsPerWeek === n)}" class="runs-btn">${n}</button>
              `).join('')}
            </div>
            <p style="font-size:12px;color:var(--c-faint);margin-top:6px">${getRunsRec(state.runsPerWeek)}</p>
          </div>

          <!-- Gym sessions -->
          <div>
            <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">
              Gym sessions per week <span style="color:var(--c-faint)">(optional)</span>
            </label>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px">
              ${[0, 1, 2, 3].map(n => `
                <button data-gym="${n}" style="${numBtn(state.gymSessionsPerWeek === n)}" class="gym-btn">${n}</button>
              `).join('')}
            </div>
            <p style="font-size:12px;color:var(--c-faint);margin-top:6px">${getGymRec(state.gymSessionsPerWeek)}</p>
            ${state.gymSessionsPerWeek > 0 ? '<p style="font-size:11px;color:var(--c-faint);margin-top:4px">Running-focused strength &amp; plyometrics.</p>' : ''}
          </div>

          <!-- Other sports -->
          <div>
            <label style="display:block;font-size:13px;color:var(--c-muted);margin-bottom:10px">
              Other sports sessions per week <span style="color:var(--c-faint)">(optional)</span>
            </label>
            <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px">
              ${[0, 1, 2, 3, 4, 5].map(n => `
                <button data-sports="${n}" style="${numBtn(state.sportsPerWeek === n)}" class="sports-btn">${n}</button>
              `).join('')}
            </div>
          </div>

          <!-- Inline Activities -->
          ${state.sportsPerWeek > 0 ? renderInlineActivities(state) : ''}
        </div>

        <button id="continue-volume"
          style="margin-top:24px;width:100%;padding:14px 20px;background:var(--c-black);color:#FDFCF7;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer">
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
    <div style="background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;padding:16px">
      <div style="font-size:14px;font-weight:500;color:var(--c-black);margin-bottom:8px">Recurring Activities</div>
      <p style="font-size:12px;color:var(--c-muted);margin-bottom:8px">
        Don't worry about getting this perfect — your watch sync will capture everything automatically.
      </p>
      <p style="font-size:12px;color:var(--c-muted);margin-bottom:8px">
        Each sport is tagged by <span style="color:var(--c-black);font-weight:500">running benefit</span> — how much it improves your running fitness.
      </p>
      <p style="font-size:11px;color:var(--c-faint);margin-bottom:10px">If you don't play a specific sport regularly, choose "General Sport".</p>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:6px;margin-bottom:10px">
        <select id="act-sport" style="${SEL_INPUT}">
          <option value="" disabled selected>Select sport...</option>
          <option value="General Sport">General Sport</option>
          ${SPORT_OPTIONS.filter(s => s !== 'General Sport' && s !== 'Hybrid Test Sport').map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <input type="number" id="act-dur" placeholder="Min" min="10" max="300"
          style="${SEL_INPUT}">
        <input type="number" id="act-freq" placeholder="x/wk" min="1" max="7"
          style="${SEL_INPUT}">
        <button id="btn-add-activity"
          style="background:var(--c-black);color:#FDFCF7;border:none;border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;padding:0 8px">
          + Add
        </button>
      </div>

      <div id="activity-list" style="display:flex;flex-direction:column;gap:6px">
        ${state.recurringActivities.map((a, i) => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:var(--c-bg);border:1px solid var(--c-border);border-radius:8px;padding:8px 12px">
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:13px;font-weight:500;color:var(--c-black)">${a.sport}</span>
              <span style="font-size:11px;color:var(--c-muted)">${a.durationMin}min ${a.frequency}x/wk</span>
              <span style="font-size:11px;padding:2px 6px;border-radius:4px;${a.intensity === 'hard' ? 'background:rgba(239,68,68,0.08);color:var(--c-warn)' : a.intensity === 'moderate' ? 'background:rgba(245,158,11,0.08);color:var(--c-caution)' : 'background:rgba(34,197,94,0.08);color:var(--c-ok)'}">${a.intensity === 'hard' ? 'High benefit' : a.intensity === 'moderate' ? 'Some benefit' : 'Low benefit'}</span>
            </div>
            <button data-remove="${i}" class="remove-activity" style="font-size:11px;color:var(--c-faint);background:none;border:none;cursor:pointer">Remove</button>
          </div>
        `).join('')}
      </div>

      ${state.recurringActivities.length === 0 ? `<p style="font-size:12px;color:var(--c-faint);margin-top:6px">No activities added yet.</p>` : ''}
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

function getGymRec(gym: number): string {
  if (gym === 0) return 'No gym — that\'s fine, running is king';
  if (gym === 1) return 'Good maintenance dose for any runner';
  if (gym === 2) return 'Recommended for most training plans';
  return 'Optimal for base phase; auto-reduces in taper';
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

  // Gym sessions
  document.querySelectorAll('.gym-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const gym = parseInt(btn.getAttribute('data-gym') || '0');
      updateOnboarding({ gymSessionsPerWeek: gym });
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
