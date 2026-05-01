import type { OnboardingState, RecurringActivity } from '@/types/onboarding';
import { nextStep, updateOnboarding } from '../controller';
import { renderProgressIndicator, renderBackButton } from '../renderer';
import { SPORT_LABELS } from '@/constants/sports';

/**
 * Page 6 — Schedule.
 *
 * Consolidates the legacy `frequency.ts` + `activities.ts` into one screen:
 *  - Runs per week (3 to 7)
 *  - Running-focused gym sessions per week (0 to 3)
 *  - "What else do you do regularly" multi-select with per-activity frequency
 *
 * Writes: `runsPerWeek`, `gymSessionsPerWeek`, `recurringActivities`,
 *         `activeLifestyle` (set true iff any recurring activity is added),
 *         `sportsPerWeek` (kept in sync for legacy consumers — sum of freqs).
 *
 * Aesthetic clone of `goals.ts` / `review.ts`:
 * - Apple 3-layer shadow (`.shadow-ap`)
 * - Monochrome pills, selected = black fill
 * - Entry animation `scRise`
 * - No accent colour, no tinted backgrounds, no emoji
 */

/**
 * Runs-per-week range. Event-training users start at 2 (1 run/week isn't a
 * running plan, it's cross-training). Non-event users (continuous fitness /
 * just-track / no specific race) may select 1 — they're maintaining, not
 * building toward a distance. A conditional caption below 3 explains that
 * cross-training fills the adaptation gap for users running less frequently.
 */
const RUNS_PER_WEEK_EVENT_OPTIONS = [2, 3, 4, 5, 6, 7];
const RUNS_PER_WEEK_NON_EVENT_OPTIONS = [1, 2, 3, 4, 5, 6, 7];
/** Gym sessions range. 0-to-3 is the onboarding-state comment range (`gymSessionsPerWeek`). */
const GYM_OPTIONS = [0, 1, 2, 3];
/** Activity frequency range (times per week). Matches `activities.ts` 1 to 7. */
const ACT_FREQ_OPTIONS = [1, 2, 3, 4, 5, 6, 7];
/** Default duration (min) when the user adds an activity. 60 lands on the
 * typical session length for gym, swim, cycle, team sport. User can slide
 * 15-120 per activity. Locked 2026-04-22. */
const DEFAULT_ACTIVITY_DURATION_MIN = 60;
/** Per-activity duration slider bounds (min). */
const DUR_MIN = 15;
const DUR_MAX = 120;
const DUR_STEP = 15;

/** Sports catalogue — flattened from SPORT_LABELS, ordered as the constants file lists them. */
const SPORT_ENTRIES = Object.entries(SPORT_LABELS) as [string, string][];

/** Module-local UI flag — whether the sport picker grid is expanded. Persists
 * across rerender()s within the same session because state shape doesn't own
 * this bit. Reset to false on Continue. */
let showSportPicker = false;

/** Heuristic intensity mapper, mirrored from legacy `activities.ts`. */
function inferIntensity(sportKey: string): 'easy' | 'moderate' | 'hard' {
  const hard = ['soccer', 'rugby', 'basketball', 'boxing', 'crossfit', 'martial_arts', 'jump_rope'];
  const easy = ['swimming', 'yoga', 'pilates', 'walking', 'hiking'];
  if (hard.includes(sportKey)) return 'hard';
  if (easy.includes(sportKey)) return 'easy';
  return 'moderate';
}

export function renderSchedule(container: HTMLElement, state: OnboardingState): void {
  const isNonEvent = state.trainingForEvent === false || state.continuousMode === true || state.trainingMode === 'fitness';
  const runsOptions = isNonEvent ? RUNS_PER_WEEK_NON_EVENT_OPTIONS : RUNS_PER_WEEK_EVENT_OPTIONS;
  container.innerHTML = `
    <style>
      @keyframes scRise { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:translateY(0) } }
      .sc-rise { opacity:0; animation: scRise 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }

      .shadow-ap { box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.08); }

      .sc-micro { display:block; font-size:11px; color:var(--c-faint); letter-spacing:0.08em; margin:0 0 10px; }

      /* Numeric pill grid (runs / gym). */
      .sc-num-grid { display:grid; gap:8px; }
      .sc-num {
        background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:14px;
        padding:12px 6px; color:var(--c-black); cursor:pointer;
        display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:500;
        transition: transform 0.12s ease, box-shadow 0.2s ease;
      }
      .sc-num:active { transform: translateY(0.5px) scale(0.99); }
      .sc-num.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); box-shadow: 0 0 0 1px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.10); }

      /* Section card wrapper — used for the "other activities" group. */
      .sc-section { display:flex; flex-direction:column; gap:14px; }

      /* Sport picker — single row on mobile, grid of chips. */
      .sc-chip-grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:8px; }
      .sc-chip {
        background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:12px;
        padding:10px 6px; color:var(--c-black); cursor:pointer;
        font-size:13px; font-weight:500; text-align:center;
        transition: transform 0.12s ease, box-shadow 0.2s ease;
      }
      .sc-chip:active { transform: translateY(0.5px) scale(0.99); }
      .sc-chip.selected { background:#0A0A0A; color:#FDFCF7; border-color: rgba(0,0,0,0.9); }

      /* Active-row card — edits an existing recurring activity. */
      .sc-active {
        display:flex; align-items:center; gap:12px; width:100%;
        background:#FFFFFF; border:1px solid rgba(0,0,0,0.06); border-radius:16px;
        padding:12px 14px;
      }
      .sc-active-body { flex:1; min-width:0; }
      .sc-active-title { font-size:14px; font-weight:500; color:var(--c-black); margin:0; line-height:1.2; }
      .sc-active-sub { font-size:11.5px; color:var(--c-faint); margin:3px 0 0; }

      .sc-freq-row { display:flex; align-items:center; gap:6px; flex-shrink:0; }
      .sc-freq-btn {
        width:26px; height:26px; border-radius:8px; border:1px solid rgba(0,0,0,0.1);
        background:#FFFFFF; color:var(--c-black); cursor:pointer; font-size:14px; line-height:1;
      }
      .sc-freq-btn[disabled] { opacity:0.3; cursor:not-allowed; }
      .sc-freq-val { min-width:24px; text-align:center; font-size:14px; font-weight:500; color:var(--c-black); font-variant-numeric: tabular-nums; }

      /* Small X icon button — replaces the old underlined "Remove" link for less visual weight. */
      .sc-remove-x {
        flex:0 0 auto; width:28px; height:28px; border-radius:50%;
        background:rgba(0,0,0,0.04); border:1px solid rgba(0,0,0,0.06); color:var(--c-muted);
        display:flex; align-items:center; justify-content:center; cursor:pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }
      .sc-remove-x:hover { background:rgba(0,0,0,0.07); color:var(--c-black); }
      .sc-remove-x:active { transform: scale(0.95); }

      /* Per-activity duration slider — monochrome, matches readiness-view sliders. */
      .sc-dur-slider { -webkit-appearance:none; appearance:none; width:100%; height:4px; border-radius:2px; background:rgba(0,0,0,0.1); outline:none; cursor:pointer; }
      .sc-dur-slider::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; border-radius:50%; background:#0A0A0A; border:2px solid #FDFCF7; box-shadow: 0 1px 3px rgba(0,0,0,0.2); cursor:pointer; }
      .sc-dur-slider::-moz-range-thumb { width:20px; height:20px; border-radius:50%; background:#0A0A0A; border:2px solid #FDFCF7; box-shadow: 0 1px 3px rgba(0,0,0,0.2); cursor:pointer; border:none; }

      /* Toggle-open "add another" link. */
      .sc-add-toggle {
        background:none; border:none; color:var(--c-muted); font-size:13px; cursor:pointer;
        padding:10px 6px; text-decoration:underline;
      }
      .sc-add-toggle:active { color:var(--c-black); }

      /* CTA. */
      .sc-cta { width:100%; height:50px; border-radius:25px; background:#0A0A0A; color:#FDFCF7; border:none; font-size:15px; font-weight:500; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:10px; box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.1), 0 8px 22px -8px rgba(0,0,0,0.35); transition: transform 0.12s ease; }
      .sc-cta:active { transform: translateY(1px); }
    </style>

    <div style="min-height:100vh;background:var(--c-bg);position:relative;overflow:hidden;display:flex;flex-direction:column">

      <div aria-hidden="true" style="position:absolute;inset:0;background:radial-gradient(ellipse 720px 560px at 50% 30%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 72%);pointer-events:none"></div>

      <div style="position:relative;z-index:1;padding:48px 20px 24px;flex:1;display:flex;flex-direction:column;align-items:center">
        ${renderProgressIndicator(5, 7)}

        <div class="sc-rise" style="width:100%;max-width:480px;text-align:center;margin-top:4px;animation-delay:0.05s">
          <h2 style="font-size:clamp(1.6rem,5.6vw,2.1rem);font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 8px;line-height:1.15">
            Your weekly schedule
          </h2>
          <p style="font-size:13px;color:var(--c-faint);margin:0">
            How often you train. Cross-training counts.
          </p>
        </div>

        <div class="sc-rise" style="width:100%;max-width:480px;margin-top:24px;animation-delay:0.12s;display:flex;flex-direction:column;gap:22px">

          <div>
            <label class="sc-micro">RUNS PER WEEK</label>
            <div class="sc-num-grid" style="grid-template-columns:repeat(${runsOptions.length},1fr)">
              ${runsOptions.map(n => `
                <button data-runs="${n}" class="sc-num ${state.runsPerWeek === n ? 'selected' : ''}">${n}</button>
              `).join('')}
            </div>
            ${state.runsPerWeek === 1 ? `
              <p style="font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4">
                One run per week maintains a baseline. Cross-training carries the aerobic load.
              </p>
            ` : state.runsPerWeek < 3 ? `
              <p style="font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4">
                Two runs per week works if you're cross-training regularly. The aerobic stimulus from swimming, cycling or team sport helps bridge the gap.
              </p>
            ` : ''}
          </div>

          <div>
            <label class="sc-micro">GYM SESSIONS PER WEEK</label>
            <div class="sc-num-grid" style="grid-template-columns:repeat(${GYM_OPTIONS.length},1fr)">
              ${GYM_OPTIONS.map(n => `
                <button data-gym="${n}" class="sc-num ${state.gymSessionsPerWeek === n ? 'selected' : ''}">${n}</button>
              `).join('')}
            </div>
            <p style="font-size:11.5px;color:var(--c-faint);margin:8px 0 0;line-height:1.4">
              Strength work built around running. Leave at 0 if you don't lift.
            </p>
          </div>

          ${renderOtherActivities(state)}

        </div>
      </div>

      <div class="sc-rise" style="position:relative;z-index:1;padding:12px 20px 28px;animation-delay:0.28s">
        <div style="max-width:480px;margin:0 auto">
          <button id="sc-continue" class="sc-cta">Continue</button>
        </div>
      </div>

      ${renderBackButton(true)}
    </div>
  `;

  wireHandlers(state);
}

function renderOtherActivities(state: OnboardingState): string {
  const active = state.recurringActivities;
  const activeKeys = new Set(active.map(a => a.sport));
  const showPicker = showSportPicker;

  return `
    <div class="sc-section">
      <div>
        <label class="sc-micro">OTHER SPORTS YOU DO REGULARLY</label>
        <p style="font-size:11.5px;color:var(--c-faint);margin:0 0 12px;line-height:1.4">
          Optional. Helps us size cross-training load and avoid doubling up on hard days.
        </p>
      </div>

      ${active.length > 0 ? `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${active.map((a, i) => renderActiveRow(a, i)).join('')}
        </div>
      ` : ''}

      ${showPicker ? renderSportPicker(activeKeys) : (activeKeys.size >= SPORT_ENTRIES.length ? '' : `
        <div style="text-align:${active.length > 0 ? 'left' : 'center'}">
          <button id="sc-add-open" class="sc-add-toggle">${active.length > 0 ? 'Add another' : 'Add an activity'}</button>
        </div>
      `)}
    </div>
  `;
}

function renderActiveRow(a: RecurringActivity, idx: number): string {
  const label = SPORT_LABELS[a.sport as keyof typeof SPORT_LABELS] ?? a.sport;
  return `
    <div class="sc-active shadow-ap" data-idx="${idx}" style="flex-direction:column;align-items:stretch;gap:12px;padding:14px 14px 16px;position:relative">
      <!-- Title row — X icon top-right for Remove. -->
      <div style="display:flex;align-items:center;gap:12px">
        <p class="sc-active-title" style="flex:1">${label}</p>
        <button class="sc-remove-x" data-remove="${idx}" aria-label="Remove ${label}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <!-- Frequency stepper row. -->
      <div style="display:flex;align-items:center;gap:10px">
        <span class="sc-active-sub" style="flex:1;margin:0">Sessions per week</span>
        <div class="sc-freq-row">
          <button class="sc-freq-btn" data-freq-dec="${idx}" ${a.frequency <= 1 ? 'disabled' : ''}>−</button>
          <span class="sc-freq-val">${a.frequency}</span>
          <button class="sc-freq-btn" data-freq-inc="${idx}" ${a.frequency >= ACT_FREQ_OPTIONS[ACT_FREQ_OPTIONS.length - 1] ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <!-- Duration slider with inline readout. -->
      <div style="display:flex;align-items:center;gap:12px">
        <span class="sc-active-sub" style="flex:0 0 auto;margin:0;min-width:68px"><span data-dur-readout="${idx}">${a.durationMin}</span> min</span>
        <input type="range"
          class="sc-dur-slider"
          data-dur="${idx}"
          min="${DUR_MIN}" max="${DUR_MAX}" step="${DUR_STEP}" value="${a.durationMin}"
          aria-label="${label} duration in minutes"
          style="flex:1"
        />
      </div>
    </div>
  `;
}

function renderSportPicker(activeKeys: Set<string>): string {
  return `
    <div>
      <div class="sc-chip-grid">
        ${SPORT_ENTRIES.map(([key, label]) => {
          const selected = activeKeys.has(key);
          return `
            <button data-sport-add="${key}" class="sc-chip ${selected ? 'selected' : ''}">${label}</button>
          `;
        }).join('')}
      </div>
      <div style="text-align:center;margin-top:10px">
        <button id="sc-add-close" class="sc-add-toggle">Done</button>
      </div>
    </div>
  `;
}

/* ---------- Handlers ---------- */

function wireHandlers(state: OnboardingState): void {
  // Runs per week.
  document.querySelectorAll<HTMLElement>('[data-runs]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.getAttribute('data-runs') || '0', 10);
      if (!Number.isNaN(n)) { updateOnboarding({ runsPerWeek: n }); rerender(); }
    });
  });

  // Gym sessions.
  document.querySelectorAll<HTMLElement>('[data-gym]').forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.getAttribute('data-gym') || '0', 10);
      if (!Number.isNaN(n)) { updateOnboarding({ gymSessionsPerWeek: n }); rerender(); }
    });
  });

  // Open the sport picker.
  document.getElementById('sc-add-open')?.addEventListener('click', () => {
    showSportPicker = true;
    rerender();
  });
  document.getElementById('sc-add-close')?.addEventListener('click', () => {
    showSportPicker = false;
    rerender();
  });

  // Add / toggle a sport.
  document.querySelectorAll<HTMLElement>('[data-sport-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sport = btn.getAttribute('data-sport-add');
      if (!sport) return;
      const current = state.recurringActivities;
      const existing = current.findIndex(a => a.sport === sport);
      let next: RecurringActivity[];
      if (existing >= 0) {
        // Toggle off — remove.
        next = current.filter((_, i) => i !== existing);
      } else {
        next = [
          ...current,
          {
            sport,
            durationMin: DEFAULT_ACTIVITY_DURATION_MIN,
            frequency: 1,
            intensity: inferIntensity(sport),
          },
        ];
      }
      const totalFreq = next.reduce((sum, a) => sum + a.frequency, 0);
      updateOnboarding({
        recurringActivities: next,
        sportsPerWeek: totalFreq,
        activeLifestyle: next.length > 0 ? true : state.activeLifestyle,
      });
      rerender();
    });
  });

  // Frequency +/- on an existing activity.
  document.querySelectorAll<HTMLElement>('[data-freq-inc]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-freq-inc') || '-1', 10);
      adjustFrequency(state, i, +1);
    });
  });
  document.querySelectorAll<HTMLElement>('[data-freq-dec]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-freq-dec') || '-1', 10);
      adjustFrequency(state, i, -1);
    });
  });

  // Duration slider per active row. `input` event for live readout, `change` for persist.
  document.querySelectorAll<HTMLInputElement>('input[data-dur]').forEach(slider => {
    const idx = parseInt(slider.getAttribute('data-dur') || '-1', 10);
    if (idx < 0) return;
    const readout = document.querySelector<HTMLElement>(`[data-dur-readout="${idx}"]`);
    slider.addEventListener('input', () => {
      if (readout) readout.textContent = slider.value;
    });
    slider.addEventListener('change', () => {
      const mins = parseInt(slider.value, 10);
      if (!Number.isFinite(mins)) return;
      const next = state.recurringActivities.map((a, i) => i === idx ? { ...a, durationMin: mins } : a);
      updateOnboarding({ recurringActivities: next });
      // No rerender — the live readout handles display; skipping rerender keeps slider focus.
    });
  });

  // Remove row.
  document.querySelectorAll<HTMLElement>('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-remove') || '-1', 10);
      if (i < 0) return;
      const next = state.recurringActivities.filter((_, idx) => idx !== i);
      const totalFreq = next.reduce((sum, a) => sum + a.frequency, 0);
      updateOnboarding({
        recurringActivities: next,
        sportsPerWeek: totalFreq,
        activeLifestyle: next.length > 0,
      });
      rerender();
    });
  });

  // Continue.
  document.getElementById('sc-continue')?.addEventListener('click', () => {
    showSportPicker = false;
    nextStep();
  });
}

function adjustFrequency(state: OnboardingState, idx: number, delta: 1 | -1): void {
  if (idx < 0 || idx >= state.recurringActivities.length) return;
  const cur = state.recurringActivities[idx];
  const nextFreq = cur.frequency + delta;
  if (nextFreq < 1 || nextFreq > ACT_FREQ_OPTIONS[ACT_FREQ_OPTIONS.length - 1]) return;
  const next = state.recurringActivities.map((a, i) => i === idx ? { ...a, frequency: nextFreq } : a);
  const totalFreq = next.reduce((sum, a) => sum + a.frequency, 0);
  updateOnboarding({ recurringActivities: next, sportsPerWeek: totalFreq });
  rerender();
}

function rerender(): void {
  import('../controller').then(({ getOnboardingState }) => {
    const cur = getOnboardingState();
    if (!cur) return;
    const container = document.getElementById('app-root');
    if (container) renderSchedule(container, cur);
  });
}
