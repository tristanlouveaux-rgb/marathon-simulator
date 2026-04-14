/**
 * Session generator — standalone modal for creating ad-hoc workouts.
 *
 * Used from plan view (general) and holiday banner.
 * Two-step flow: pick session type → set distance or time → generates structured workout.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { Workout } from '@/types';
import { intentToWorkout } from '@/workouts/intent_to_workout';
import type { SessionIntent, SlotType } from '@/workouts/intent_to_workout';
import { formatKm, formatPace } from '@/utils/format';
import type { UnitPref } from '@/utils/format';

const MODAL_ID = 'session-generator-modal';

interface SessionTypeOption {
  slot: SlotType;
  label: string;
  subtitle: string;
  rpe: number;
  defaultMinutes: number; // default total session time
  workRatio: number;      // fraction of total that is "work" (rest is warm-up/cool-down)
}

const SESSION_TYPES: SessionTypeOption[] = [
  {
    slot: 'easy', label: 'Easy Run',
    subtitle: 'Comfortable pace, aerobic development',
    rpe: 3, defaultMinutes: 40, workRatio: 1.0,
  },
  {
    slot: 'long', label: 'Long Run',
    subtitle: 'Extended easy effort, endurance building',
    rpe: 3, defaultMinutes: 75, workRatio: 1.0,
  },
  {
    slot: 'threshold', label: 'Threshold',
    subtitle: 'Sustained effort at lactate threshold',
    rpe: 7, defaultMinutes: 45, workRatio: 0.5,
  },
  {
    slot: 'vo2', label: 'VO2 Intervals',
    subtitle: 'High-intensity repeats with recovery',
    rpe: 8, defaultMinutes: 40, workRatio: 0.35,
  },
  {
    slot: 'marathon_pace', label: 'Marathon Pace',
    subtitle: 'Race-specific sustained effort',
    rpe: 6, defaultMinutes: 50, workRatio: 0.6,
  },
  {
    slot: 'progressive', label: 'Progressive Run',
    subtitle: 'Start easy, finish at marathon pace or faster',
    rpe: 5, defaultMinutes: 45, workRatio: 0.4,
  },
];

/** Open the session generator modal. Adds the workout to the current week's adhocWorkouts. */
// ─── Variant definitions (matching plan_engine.ts rotation) ─────────────────

const THRESH_VARIANTS = [
  { id: 'thr_20cont', reps: undefined, repMin: undefined, recMin: undefined },    // continuous tempo
  { id: 'thr_3x8',   reps: 3, repMin: 8, recMin: 2 },
  { id: 'thr_2x12',  reps: 2, repMin: 12, recMin: 3 },
  { id: 'thr_cruise_5x5', reps: 5, repMin: 5, recMin: 1 },
];

const VO2_VARIANTS = [
  { id: 'vo2_5x3',  reps: 5, repMin: 3, recMin: 2 },
  { id: 'vo2_6x2',  reps: 6, repMin: 2, recMin: 2 },
  { id: 'vo2_5x4',  reps: 5, repMin: 4, recMin: 2.5 },
  { id: 'vo2_12x1', reps: 12, repMin: 1, recMin: 1 },
];

function buildSessionIntent(
  slot: SlotType, totalMinutes: number, workMinutes: number, weekIndex: number,
): SessionIntent {
  let reps: number | undefined;
  let repMinutes: number | undefined;
  let recoveryMinutes: number | undefined;
  let variantId = slot as string;

  if (slot === 'threshold') {
    const v = THRESH_VARIANTS[(weekIndex - 1) % THRESH_VARIANTS.length];
    variantId = v.id;
    reps = v.reps;
    repMinutes = v.repMin;
    recoveryMinutes = v.recMin;
  } else if (slot === 'vo2') {
    const v = VO2_VARIANTS[(weekIndex - 1) % VO2_VARIANTS.length];
    variantId = v.id;
    reps = v.reps;
    repMinutes = v.repMin;
    recoveryMinutes = v.recMin;
  }

  return {
    dayIndex: todayDayIndex(),
    slot,
    totalMinutes,
    workMinutes,
    reps,
    repMinutes,
    recoveryMinutes,
    variantId,
    notes: '',
  };
}

/** Open the session generator modal. Adds the workout to the current week's adhocWorkouts. */
export function openSessionGenerator(): void {
  document.getElementById(MODAL_ID)?.remove();

  const s = getState();
  const up: UnitPref = s.unitPref ?? 'km';
  const easyPace = s.pac?.e || 330;

  let step = 1;
  let selectedType: SessionTypeOption | null = null;

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  function render() {
    if (step === 1) renderStep1();
    else renderStep2();
  }

  // ── Step 1: Pick session type ──────────────────────────────────────────────

  function renderStep1() {
    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Generate session</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px">Pick a session type.</div>

        ${SESSION_TYPES.map((opt, i) => `
          <button class="sg-type-btn" data-idx="${i}"
            style="width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;
                   border:1px solid var(--c-border);background:transparent;cursor:pointer;margin-bottom:8px;text-align:left">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">${opt.label}</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.4">${opt.subtitle}</div>
          </button>
        `).join('')}

        <button id="sg-cancel"
          style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                 background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f);margin-top:6px">
          Cancel
        </button>
      </div>
    `;

    document.getElementById('sg-cancel')?.addEventListener('click', () => modal.remove());
    modal.querySelectorAll('.sg-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
        selectedType = SESSION_TYPES[idx];
        step = 2;
        render();
      });
    });
  }

  // ── Step 2: Set distance or time ───────────────────────────────────────────

  function renderStep2() {
    if (!selectedType) return;

    const defaultMin = selectedType.defaultMinutes;
    const defaultKm = Math.round(defaultMin * 60 / easyPace);

    // Distance range based on session type
    const minKm = selectedType.slot === 'long' ? 8 : 3;
    const maxKm = selectedType.slot === 'long' ? 35 : selectedType.slot === 'easy' ? 18 : 15;

    let mode: 'distance' | 'time' = 'distance';
    let distanceKm = Math.min(maxKm, Math.max(minKm, defaultKm));
    let timeMin = defaultMin;

    function renderContent() {
      const isDistance = mode === 'distance';
      const distLabel = formatKm(distanceKm, up);
      const estMinutes = isDistance ? Math.round(distanceKm * easyPace / 60) : timeMin;
      const estKm = isDistance ? distanceKm : Math.round(timeMin * 60 / easyPace);

      const secondaryInfo = isDistance
        ? `~${estMinutes} min at ${formatPace(easyPace, up)}`
        : `~${formatKm(estKm, up)} at ${formatPace(easyPace, up)}`;

      const inner = modal.querySelector('#sg-step2-inner');
      if (!inner) return;

      inner.innerHTML = `
        <div style="display:flex;gap:6px;margin-bottom:18px">
          <button id="sg-mode-dist"
            style="flex:1;padding:8px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f);
                   border:1px solid ${isDistance ? 'var(--c-black)' : 'var(--c-border)'};
                   background:${isDistance ? 'var(--c-black)' : 'transparent'};
                   color:${isDistance ? '#fff' : 'var(--c-muted)'}">
            Distance
          </button>
          <button id="sg-mode-time"
            style="flex:1;padding:8px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f);
                   border:1px solid ${!isDistance ? 'var(--c-black)' : 'var(--c-border)'};
                   background:${!isDistance ? 'var(--c-black)' : 'transparent'};
                   color:${!isDistance ? '#fff' : 'var(--c-muted)'}">
            Time
          </button>
        </div>

        <div style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em">${isDistance ? 'Distance' : 'Duration'}</div>
            <div id="sg-value-label" style="font-size:14px;font-weight:600;color:var(--c-black)">${isDistance ? distLabel : timeMin + ' min'}</div>
          </div>
          <input type="range" id="sg-slider"
            min="${isDistance ? minKm : 15}" max="${isDistance ? maxKm : 120}"
            value="${isDistance ? distanceKm : timeMin}"
            step="${isDistance ? 1 : 5}"
            style="width:100%;accent-color:var(--c-black)">
          <div style="display:flex;justify-content:space-between;margin-top:2px">
            <span style="font-size:10px;color:var(--c-faint)">${isDistance ? formatKm(minKm, up) : '15 min'}</span>
            <span style="font-size:10px;color:var(--c-faint)">${isDistance ? formatKm(maxKm, up) : '120 min'}</span>
          </div>
        </div>

        <div id="sg-secondary-info" style="font-size:12px;color:var(--c-muted);margin-bottom:18px">${secondaryInfo}</div>
      `;

      // Wire mode toggle
      inner.querySelector('#sg-mode-dist')?.addEventListener('click', () => {
        if (mode === 'distance') return;
        mode = 'distance';
        distanceKm = Math.min(maxKm, Math.max(minKm, Math.round(timeMin * 60 / easyPace)));
        renderContent();
      });
      inner.querySelector('#sg-mode-time')?.addEventListener('click', () => {
        if (mode === 'time') return;
        mode = 'time';
        timeMin = Math.round(distanceKm * easyPace / 60 / 5) * 5; // round to 5min
        renderContent();
      });

      // Wire slider
      const slider = inner.querySelector('#sg-slider') as HTMLInputElement;
      slider?.addEventListener('input', () => {
        const val = parseInt(slider.value, 10);
        if (isDistance) {
          distanceKm = val;
        } else {
          timeMin = val;
        }
        const lbl = inner.querySelector('#sg-value-label');
        if (lbl) lbl.textContent = isDistance ? formatKm(distanceKm, up) : `${timeMin} min`;
        const info = inner.querySelector('#sg-secondary-info');
        if (info) {
          const estM = isDistance ? Math.round(distanceKm * easyPace / 60) : timeMin;
          const estK = isDistance ? distanceKm : Math.round(timeMin * 60 / easyPace);
          info.textContent = isDistance
            ? `~${estM} min at ${formatPace(easyPace, up)}`
            : `~${formatKm(estK, up)} at ${formatPace(easyPace, up)}`;
        }
      });
    }

    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
        <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">${selectedType.label}</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px">${selectedType.subtitle}</div>

        <div id="sg-step2-inner"></div>

        <button id="sg-confirm"
          style="width:100%;padding:12px;border-radius:12px;border:none;
                 background:var(--c-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--f);margin-bottom:8px">
          Add to plan
        </button>
        <button id="sg-back"
          style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                 background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">
          Back
        </button>
      </div>
    `;

    renderContent();

    document.getElementById('sg-back')?.addEventListener('click', () => { step = 1; render(); });
    document.getElementById('sg-confirm')?.addEventListener('click', () => {
      if (!selectedType) return;
      modal.remove();

      const totalMinutes = mode === 'time' ? timeMin : Math.round(distanceKm * easyPace / 60);
      const workMinutes = Math.round(totalMinutes * selectedType.workRatio);

      // Pick a variant matching the plan engine's rotation by current week
      const weekIdx = s.w || 1;
      const intent = buildSessionIntent(selectedType.slot, totalMinutes, workMinutes, weekIdx);

      const workout = intentToWorkout(intent, s.rd, s.typ, easyPace);

      const jsDay = new Date().getDay();
      const ourDay = jsDay === 0 ? 6 : jsDay - 1;

      const session: Workout = {
        id: `adhoc-${Date.now()}`,
        t: workout.t,
        n: workout.n,
        d: workout.d,
        r: workout.r,
        rpe: workout.rpe ?? workout.r,
        dayOfWeek: ourDay,
      };

      const ms = getMutableState();
      const wk = ms.wks?.[ms.w - 1];
      if (!wk) return;
      if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
      wk.adhocWorkouts.push(session);
      saveState();

      import('./plan-view').then(({ renderPlanView }) => renderPlanView());
    });
  }

  render();
}

function todayDayIndex(): number {
  const js = new Date().getDay();
  return js === 0 ? 6 : js - 1;
}
