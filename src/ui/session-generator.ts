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
import { computeReadinessACWR } from '@/calculations/fitness-model';
import { blendPredictions } from '@/calculations/predictions';

const MODAL_ID = 'session-generator-modal';

type EffortKey = 'easy' | 'steady' | 'hard';

const TIME_TRIAL_DISTANCES = [
  { label: '5K',       dist: 5000,  km: 5 },
  { label: '10K',      dist: 10000, km: 10 },
  { label: 'Half',     dist: 21097, km: 21.097 },
  { label: 'Marathon', dist: 42195, km: 42.195 },
];

function fmtTimeSec(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.round(totalSec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface SessionTypeOption {
  slot: SlotType | 'time_trial';
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
  {
    slot: 'time_trial', label: 'Time Trial',
    subtitle: 'Race-effort test at a target distance',
    rpe: 9, defaultMinutes: 25, workRatio: 1.0,
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

  // Recovery signal for effort recommendation
  const acwr = computeReadinessACWR(s);
  let recoveryLine: string;
  let recommendedEffort: EffortKey;
  if (acwr.status === 'high') {
    recoveryLine = 'High training load. Zone 2 is appropriate today.';
    recommendedEffort = 'easy';
  } else if (acwr.status === 'caution') {
    recoveryLine = 'Elevated load. Zone 2 or steady is appropriate.';
    recommendedEffort = 'easy';
  } else {
    recoveryLine = 'Load is balanced. Any effort is appropriate.';
    recommendedEffort = 'steady';
  }

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

  // ── Step 2: Set effort + distance/time ────────────────────────────────────

  function renderStep2() {
    if (!selectedType) return;

    if (selectedType.slot === 'time_trial') { renderTimeTrial(); return; }

    const defaultMin = selectedType.defaultMinutes;
    const defaultKm = Math.round(defaultMin * 60 / easyPace);
    const minKm = selectedType.slot === 'long' ? 8 : 3;
    const maxKm = selectedType.slot === 'long' ? 35 : selectedType.slot === 'easy' ? 18 : 15;

    let mode: 'distance' | 'time' = 'distance';
    let distanceKm = Math.min(maxKm, Math.max(minKm, defaultKm));
    let timeMin = defaultMin;

    // Effort picker applies to open-ended sessions. Structured sessions have a fixed target pace.
    const hasEffortPicker = selectedType.slot === 'easy' || selectedType.slot === 'long';

    // Long runs cap at Steady — threshold pace for 20+ km is race simulation, not training.
    const EFFORT_OPTIONS: Array<{ key: EffortKey; label: string; pace: number; desc: string }> = selectedType.slot === 'long'
      ? [
          { key: 'easy',   label: 'Zone 2', pace: s.pac.e, desc: 'Aerobic base' },
          { key: 'steady', label: 'Steady', pace: s.pac.m, desc: 'Marathon effort' },
        ]
      : [
          { key: 'easy',   label: 'Zone 2',    pace: s.pac.e, desc: 'Aerobic base' },
          { key: 'steady', label: 'Steady',    pace: s.pac.m, desc: 'Marathon effort' },
          { key: 'hard',   label: 'Threshold', pace: s.pac.t, desc: 'Half marathon effort' },
        ];

    let selectedEffort: EffortKey = recommendedEffort;
    let effortPace = hasEffortPicker
      ? (EFFORT_OPTIONS.find(o => o.key === selectedEffort)?.pace ?? easyPace)
      : easyPace;

    // Fixed pace label for structured sessions
    function structuredPaceLabel(): string {
      switch (selectedType!.slot) {
        case 'threshold':     return formatPace(s.pac.t, up);
        case 'vo2':           return formatPace(s.pac.i, up);
        case 'marathon_pace': return formatPace(s.pac.m, up);
        case 'progressive':   return `${formatPace(s.pac.e, up)} to ${formatPace(s.pac.m, up)}`;
        default:              return formatPace(easyPace, up);
      }
    }

    function renderContent() {
      const isDistance = mode === 'distance';
      const paceForEst = hasEffortPicker ? effortPace : easyPace;
      const distLabel = formatKm(distanceKm, up);
      const estMinutes = isDistance ? Math.round(distanceKm * paceForEst / 60) : timeMin;
      const estKm = isDistance ? distanceKm : Math.round(timeMin * 60 / paceForEst);

      // Structured sessions already show target pace above the slider — don't repeat it here.
      const secondaryInfo = hasEffortPicker
        ? (isDistance ? `~${estMinutes} min at ${formatPace(effortPace, up)}` : `~${formatKm(estKm, up)} at ${formatPace(effortPace, up)}`)
        : (isDistance ? `~${estMinutes} min` : `~${formatKm(estKm, up)}`);

      const inner = modal.querySelector('#sg-step2-inner');
      if (!inner) return;

      inner.innerHTML = `
        ${hasEffortPicker ? `
          <div style="margin-bottom:16px">
            <div style="font-size:12px;color:var(--c-muted);margin-bottom:10px">${recoveryLine}</div>
            <div style="display:flex;gap:6px">
              ${EFFORT_OPTIONS.map(opt => {
                const sel = opt.key === selectedEffort;
                const isRec = opt.key === recommendedEffort;
                return `
                  <button class="sg-effort-btn" data-effort="${opt.key}"
                    style="flex:1;display:flex;flex-direction:column;align-items:center;padding:10px 6px;border-radius:10px;cursor:pointer;font-family:var(--f);
                           border:1px solid ${sel ? 'var(--c-black)' : 'var(--c-border)'};
                           background:${sel ? 'var(--c-black)' : 'transparent'}">
                    <div style="font-size:12px;font-weight:600;color:${sel ? '#fff' : 'var(--c-black)'};margin-bottom:1px">${opt.label}</div>
                    <div style="font-size:11px;color:${sel ? 'rgba(255,255,255,0.65)' : 'var(--c-muted)'}">${formatPace(opt.pace, up)}</div>
                    <div style="font-size:9px;font-weight:500;margin-top:3px;color:${sel ? 'rgba(255,255,255,0.5)' : 'var(--c-faint)'}">
                      ${isRec ? 'Suggested' : ' '}
                    </div>
                  </button>
                `;
              }).join('')}
            </div>
            ${selectedEffort === 'hard' && selectedType!.slot === 'easy' ? `
              <div style="font-size:11px;color:var(--c-muted);margin-top:8px;padding:8px 10px;border:1px solid var(--c-border);border-radius:8px;line-height:1.5">
                Threshold effort carries significant load. Only use this if you are replacing a planned quality session or are very fresh.
              </div>
            ` : ''}
          </div>
        ` : `
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
            <div style="font-size:13px;color:var(--c-muted)">Target pace</div>
            <div style="font-size:14px;font-weight:600;color:var(--c-black)">${structuredPaceLabel()}</div>
          </div>
        `}

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

      // Wire effort buttons
      if (hasEffortPicker) {
        inner.querySelectorAll('.sg-effort-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const key = (btn as HTMLElement).dataset.effort as EffortKey;
            selectedEffort = key;
            effortPace = EFFORT_OPTIONS.find(o => o.key === key)?.pace ?? easyPace;
            renderContent();
          });
        });
      }

      // Wire mode toggle
      inner.querySelector('#sg-mode-dist')?.addEventListener('click', () => {
        if (mode === 'distance') return;
        mode = 'distance';
        distanceKm = Math.min(maxKm, Math.max(minKm, Math.round(timeMin * 60 / (hasEffortPicker ? effortPace : easyPace))));
        renderContent();
      });
      inner.querySelector('#sg-mode-time')?.addEventListener('click', () => {
        if (mode === 'time') return;
        mode = 'time';
        timeMin = Math.round(distanceKm * (hasEffortPicker ? effortPace : easyPace) / 60 / 5) * 5;
        renderContent();
      });

      // Wire slider
      const slider = inner.querySelector('#sg-slider') as HTMLInputElement;
      slider?.addEventListener('input', () => {
        const val = parseInt(slider.value, 10);
        if (isDistance) { distanceKm = val; } else { timeMin = val; }
        const pace = hasEffortPicker ? effortPace : easyPace;
        const lbl = inner.querySelector('#sg-value-label');
        if (lbl) lbl.textContent = isDistance ? formatKm(distanceKm, up) : `${timeMin} min`;
        const info = inner.querySelector('#sg-secondary-info');
        if (info) {
          const estM = isDistance ? Math.round(distanceKm * pace / 60) : timeMin;
          const estK = isDistance ? distanceKm : Math.round(timeMin * 60 / pace);
          info.textContent = hasEffortPicker
            ? (isDistance ? `~${estM} min at ${formatPace(pace, up)}` : `~${formatKm(estK, up)} at ${formatPace(pace, up)}`)
            : (isDistance ? `~${estM} min` : `~${formatKm(estK, up)}`);
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

      const pace = hasEffortPicker ? effortPace : easyPace;
      const totalMinutes = mode === 'time' ? timeMin : Math.round(distanceKm * pace / 60);
      const workMinutes = Math.round(totalMinutes * selectedType.workRatio);

      const weekIdx = s.w || 1;
      const intent = buildSessionIntent(selectedType.slot as SlotType, totalMinutes, workMinutes, weekIdx);

      const workout = intentToWorkout(intent, s.rd, s.typ, easyPace);

      // intentToWorkout derives km from totalMinutes at easy pace, which is wrong when the user
      // chose a different effort. Override d to match what the slider actually showed.
      const correctedKm = hasEffortPicker
        ? (mode === 'distance' ? distanceKm : Math.round(timeMin * 60 / effortPace))
        : null;

      // For effort-selected sessions, override RPE to match chosen intensity
      const rpeOverride = hasEffortPicker
        ? (selectedEffort === 'easy' ? 3 : selectedEffort === 'steady' ? 5 : 7)
        : undefined;

      const jsDay = new Date().getDay();
      const ourDay = jsDay === 0 ? 6 : jsDay - 1;

      const session: Workout = {
        id: `adhoc-${Date.now()}`,
        t: workout.t,
        n: workout.n,
        d: correctedKm !== null ? `${correctedKm}km` : workout.d,
        r: workout.r,
        rpe: rpeOverride ?? workout.rpe ?? workout.r,
        dayOfWeek: ourDay,
        ...(hasEffortPicker ? { targetPaceSecKm: effortPace } : {}),
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

  // ── Time Trial step ────────────────────────────────────────────────────────

  function renderTimeTrial() {
    const vdot = s.v ?? 50;
    const hasBlendInputs = !!(s.lt || s.vo2 || s.pbs?.k5 || s.pbs?.k10 || s.pbs?.h || s.pbs?.m);

    const predictions = TIME_TRIAL_DISTANCES.map(d => {
      const sec = hasBlendInputs
        ? blendPredictions(d.dist, s.pbs ?? {}, s.lt ?? null, s.vo2 ?? vdot,
            s.b ?? 1.06, s.typ ?? 'Balanced', s.rec ?? null,
            s.athleteTier ?? undefined)
        : null;
      return { ...d, predictedSec: sec };
    });

    let selectedDist = predictions[0];

    function renderContent() {
      modal.innerHTML = `
        <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface)">
          <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:4px">Time Trial</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px">Based on your current fitness. Pick a distance.</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
            ${predictions.map(d => {
              const sel = d.label === selectedDist.label;
              const timeStr = d.predictedSec ? fmtTimeSec(d.predictedSec) : '—';
              return `
                <button class="sg-tt-btn" data-label="${d.label}"
                  style="display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;cursor:pointer;font-family:var(--f);
                         border:1px solid ${sel ? 'var(--c-black)' : 'var(--c-border)'};
                         background:${sel ? 'var(--c-black)' : 'transparent'}">
                  <div style="font-size:13px;font-weight:600;color:${sel ? '#fff' : 'var(--c-black)'};margin-bottom:3px">${d.label}</div>
                  <div style="font-size:12px;color:${sel ? 'rgba(255,255,255,0.65)' : 'var(--c-muted)'}">${timeStr}</div>
                </button>
              `;
            }).join('')}
          </div>

          <div style="font-size:11px;color:var(--c-muted);padding:10px 12px;border:1px solid var(--c-border);border-radius:8px;line-height:1.55;margin-bottom:16px">
            A time trial creates significant fatigue. Allow 2 to 3 days of easy running afterwards. Not appropriate if a race or key session falls within the next 5 days.
          </div>

          <button id="sg-tt-confirm"
            style="width:100%;padding:12px;border-radius:12px;border:none;
                   background:var(--c-accent);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--f);margin-bottom:8px">
            Add to plan
          </button>
          <button id="sg-tt-back"
            style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
                   background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">
            Back
          </button>
        </div>
      `;

      modal.querySelectorAll('.sg-tt-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          selectedDist = predictions.find(d => d.label === (btn as HTMLElement).dataset.label)!;
          renderContent();
        });
      });

      document.getElementById('sg-tt-back')?.addEventListener('click', () => { step = 1; render(); });
      document.getElementById('sg-tt-confirm')?.addEventListener('click', () => {
        modal.remove();

        const jsDay = new Date().getDay();
        const ourDay = jsDay === 0 ? 6 : jsDay - 1;
        const paceSecKm = selectedDist.predictedSec
          ? Math.round(selectedDist.predictedSec / selectedDist.km)
          : undefined;

        const session: Workout = {
          id: `adhoc-${Date.now()}`,
          t: 'threshold',
          n: `${selectedDist.label} Time Trial`,
          d: `${selectedDist.km}km race effort${selectedDist.predictedSec ? `. Target: ${fmtTimeSec(selectedDist.predictedSec)}` : ''}`,
          r: 9,
          rpe: 9,
          dayOfWeek: ourDay,
          ...(paceSecKm ? { targetPaceSecKm: paceSecKm } : {}),
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

    renderContent();
  }

  render();
}

function todayDayIndex(): number {
  const js = new Date().getDay();
  return js === 0 ? 6 : js - 1;
}
