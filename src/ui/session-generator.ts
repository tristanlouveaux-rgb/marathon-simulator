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
import { generateSwimSession, describeSwimSession, estimateDistanceMetres, SWIM_VARIANT_COUNT, type SwimSessionKind } from '@/workouts/swim';
import { generateBikeSession, describeBikeSession, BIKE_VARIANT_COUNT, type BikeSessionKind } from '@/workouts/bike';
import { BIKE_ADHERENCE_BAND } from '@/constants/triathlon-constants';
import { formatKm, formatPace } from '@/utils/format';
import type { UnitPref } from '@/utils/format';
import { computeReadinessACWR } from '@/calculations/fitness-model';
import { blendPredictions } from '@/calculations/predictions';
import type { TrainingPhase } from '@/types/training';

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

function formatSwimPace(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Inline styles for a picker tile (discipline / kind cards). Mirrors the
 * wizard `.tri-card` aesthetic — white surface, soft elevation, inset
 * highlight, full-width tap target.
 */
function tilePickerStyle(): string {
  return `width:100%;display:flex;flex-direction:column;align-items:flex-start;padding:14px 16px;border-radius:14px;cursor:pointer;margin-bottom:10px;text-align:left;
    background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);font-family:var(--f);
    box-shadow:0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.4);
    transition:transform 120ms ease, box-shadow 120ms ease`;
}

/**
 * Discipline-aware recovery line. Reads per-discipline TSB from
 * `triConfig.fitness` rather than the global ACWR — so a bike modal reflects
 * bike fatigue, not combined load. Returns a one-line factual string.
 *
 * Thresholds: TSB ≤ -10 = high fatigue, ≤ -5 = elevated, > 5 = fresh,
 * else neutral. Anchored to Banister TSB conventions (Coggan & Allen 2019).
 */
function disciplineRecoveryLine(state: ReturnType<typeof getState>, discipline: 'swim' | 'bike' | 'run'): string {
  const fit = state.triConfig?.fitness?.[discipline];
  const label = discipline === 'swim' ? 'Swim' : discipline === 'bike' ? 'Cycling' : 'Run';
  if (!fit || fit.directCount == null || fit.directCount < 2) {
    return `Not enough ${label.toLowerCase()} history yet. Pace yourself by feel.`;
  }
  const tsb = fit.tsb;
  if (tsb <= -10) return `${label} load is high. Z2 is appropriate today.`;
  if (tsb <= -5)  return `${label} load is elevated. Easy or moderate intensity.`;
  if (tsb >= 8)   return `${label} freshness is high. Any intensity works.`;
  return `${label} load is balanced. Any intensity is appropriate.`;
}

/** Modal shell with sun-glint, matching the canonical Mosaic surface. */
function modalShellOpen(maxHeight: string = '85vh'): string {
  return `<div class="w-full max-w-sm rounded-2xl" style="background:#ffffff;position:relative;overflow:hidden;border:1px solid var(--c-border);box-shadow:0 4px 16px rgba(0,0,0,0.06), 0 16px 48px rgba(0,0,0,0.08);max-height:${maxHeight};display:flex;flex-direction:column">
    <div aria-hidden="true" style="position:absolute;top:-30px;left:-30px;width:380px;height:380px;pointer-events:none;
      background:radial-gradient(ellipse 55% 55% at 22% 22%, rgba(255,248,229,0.5) 0%, rgba(255,248,229,0.18) 30%, transparent 70%)"></div>
    <div style="position:relative;padding:22px;overflow-y:auto">`;
}
function modalShellClose(): string { return `</div></div>`; }

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
  {
    slot: 'vibes', label: 'Run by Feel',
    subtitle: 'Pace by feel. No targets.',
    rpe: 4, defaultMinutes: 35, workRatio: 1.0,
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

  // Mode-aware session list:
  //   running / fitness  → all session types (existing behaviour)
  //   triathlon          → discipline picker first (swim / bike / run + Run by Feel).
  //                        When the run discipline is chosen, the run-type list is
  //                        identical to running mode minus 'vibes' (vibes is its own
  //                        discipline-step slot). Save path forks to triWorkouts.
  //   hyrox              → Run by Feel only (jumps straight to the vibes view).
  const isTri = s.eventType === 'triathlon';
  const isHyrox = s.eventType === 'hyrox';
  // Run-types list is identical across modes; in tri mode it's the third step
  // after the user picks "Run" from the discipline picker.
  const availableTypes: SessionTypeOption[] = SESSION_TYPES;

  // Tri-mode flow state. Tracks which discipline the user picked. When
  // selectedDiscipline === 'run' the existing renderStep1/Step2 are reused
  // with the save path tagged for triWorkouts.
  type TriDiscipline = 'swim' | 'bike' | 'run';
  let selectedDiscipline: TriDiscipline | null = null;

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

  // step 0 = tri discipline picker (tri only)
  // step 1 = type picker (run-types or swim/bike kind)
  // step 2 = duration picker (with variant preview + drill-down link)
  // step 3 = variant drill-down picker
  let step: 0 | 1 | 2 | 3 = isTri ? 0 : 1;
  let selectedType: SessionTypeOption | null = null;
  let selectedSwimKind: 'technique' | 'endurance' | 'threshold' | 'speed' | 'time_trial' | null = null;
  let selectedBikeKind: BikeSessionKind | 'time_trial' | null = null;
  // null = use rotation default; number = explicit user choice (frozen on save).
  let selectedSwimVariant: number | null = null;
  let selectedBikeVariant: number | null = null;

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  // Hyrox: jump straight to Run by Feel.
  if (isHyrox) { renderVibes(); return; }

  function render() {
    if (step === 0) renderTriDiscipline();
    else if (step === 1) {
      if (isTri && selectedDiscipline === 'swim') renderSwimKind();
      else if (isTri && selectedDiscipline === 'bike') renderBikeKind();
      else renderStep1();
    } else if (step === 2) {
      if (isTri && selectedDiscipline === 'swim') renderSwimDuration();
      else if (isTri && selectedDiscipline === 'bike') renderBikeDuration();
      else renderStep2();
    } else {
      // step 3 — variant drill-down
      if (isTri && selectedDiscipline === 'swim') renderSwimVariantList();
      else if (isTri && selectedDiscipline === 'bike') renderBikeVariantList();
    }
  }

  // ── Step 1: Pick session type ──────────────────────────────────────────────

  function renderStep1() {
    const isTriRun = isTri && selectedDiscipline === 'run';
    const title = isTriRun ? 'Run session' : 'Generate session';
    const subtitle = isTriRun ? 'Pick a run type.' : 'Pick a session type.';

    modal.innerHTML = `
      <style>
        @keyframes sg-vibes-shimmer {
          0%,100% { transform:translateX(-140%) skewX(-16deg); opacity:0 }
          8%      { opacity:1 }
          40%     { transform:translateX(280%) skewX(-16deg); opacity:0 }
        }
        .sg-vibes-tile { position:relative; overflow:hidden }
        .sg-vibes-tile-shimmer { position:absolute; top:0; bottom:0; left:0; width:50%; pointer-events:none;
          background:linear-gradient(112deg,
            transparent 5%,
            rgba(0,0,0,0.05) 22%,
            rgba(255,255,255,0.6) 38%,
            rgba(255,255,255,1) 50%,
            rgba(255,255,255,0.6) 62%,
            rgba(0,0,0,0.04) 78%,
            transparent 95%
          );
          animation:sg-vibes-shimmer 7s cubic-bezier(0.4,0,0.2,1) 0.3s infinite }
      </style>
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${title}</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">${subtitle}</div>

        ${availableTypes.map((opt, i) => {
          const isVibes = opt.slot === 'vibes';
          return `
          <button class="sg-type-btn ${isVibes ? 'sg-vibes-tile' : ''}" data-idx="${i}" style="${tilePickerStyle()}">
            ${isVibes ? `<div class="sg-vibes-tile-shimmer"></div>` : ''}
            <div style="position:relative;font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">${opt.label}</div>
            <div style="position:relative;font-size:12px;color:var(--c-muted);line-height:1.45">${opt.subtitle}</div>
          </button>
        `;
        }).join('')}

        <button id="sg-cancel" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">
          ${isTriRun ? 'Back' : 'Cancel'}
        </button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-cancel')?.addEventListener('click', () => {
      if (isTriRun) { step = 0; render(); }
      else modal.remove();
    });
    modal.querySelectorAll('.sg-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
        selectedType = availableTypes[idx];
        step = 2;
        render();
      });
    });
  }

  // ── Tri mode — Discipline picker (Step 0) ──────────────────────────────────

  function renderTriDiscipline() {
    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl" style="background:#ffffff;position:relative;overflow:hidden;border:1px solid var(--c-border);box-shadow:0 4px 16px rgba(0,0,0,0.06), 0 16px 48px rgba(0,0,0,0.08);max-height:85vh;display:flex;flex-direction:column">
        <div aria-hidden="true" style="position:absolute;top:-30px;left:-30px;width:380px;height:380px;pointer-events:none;
          background:radial-gradient(ellipse 55% 55% at 22% 22%, rgba(255,248,229,0.5) 0%, rgba(255,248,229,0.18) 30%, transparent 70%)"></div>

        <div style="position:relative;padding:22px 22px 18px;overflow-y:auto">
          <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Add session</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">Pick a discipline.</div>

          <button class="sg-disc-btn" data-disc="swim" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">Swim</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">Technique, endurance, CSS intervals or speed.</div>
          </button>
          <button class="sg-disc-btn" data-disc="bike" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">Bike</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">Endurance, sweet spot, threshold or VO2.</div>
          </button>
          <button class="sg-disc-btn" data-disc="run" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">Run</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">Easy, long, threshold, VO2 or Run by Feel.</div>
          </button>

          <button id="sg-disc-cancel" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.getElementById('sg-disc-cancel')?.addEventListener('click', () => modal.remove());
    modal.querySelectorAll('.sg-disc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const disc = (btn as HTMLElement).dataset.disc;
        selectedDiscipline = disc as TriDiscipline;
        step = 1;
        render();
      });
    });
  }

  // ── Tri mode — Swim kind picker ────────────────────────────────────────────

  type SwimKindKey = SwimSessionKind | 'time_trial';
  const SWIM_OPTIONS: Array<{ kind: SwimKindKey; label: string; subtitle: string; cssOffsetSec: number; bandSec: number; minMin: number; maxMin: number; defaultMin: number }> = [
    // cssOffsetSec = sec/100m above (or below) CSS for this kind. bandSec = ±tolerance.
    // minMin/maxMin = sensible duration window per kind (a 90-min CSS-pace block is a race, not training).
    { kind: 'technique',  label: 'Technique',     subtitle: 'Drills and short reps. Low intensity.',  cssOffsetSec: +18, bandSec: 6, minMin: 20, maxMin: 60,  defaultMin: 30 },
    { kind: 'endurance',  label: 'Endurance',     subtitle: 'Continuous or long aerobic intervals.',  cssOffsetSec: +6,  bandSec: 4, minMin: 30, maxMin: 90,  defaultMin: 50 },
    { kind: 'threshold',  label: 'CSS intervals', subtitle: 'Threshold reps at critical swim speed.', cssOffsetSec: 0,   bandSec: 2, minMin: 30, maxMin: 75,  defaultMin: 45 },
    { kind: 'speed',      label: 'Speed',         subtitle: 'Short reps above CSS.',                  cssOffsetSec: -6,  bandSec: 3, minMin: 25, maxMin: 50,  defaultMin: 35 },
    { kind: 'time_trial', label: 'CSS test',      subtitle: '400m all-out. Sets your benchmark.',     cssOffsetSec: -6,  bandSec: 3, minMin: 30, maxMin: 30,  defaultMin: 30 },
  ];

  function renderSwimKind() {
    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Swim session</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">Pick a swim type.</div>

        ${SWIM_OPTIONS.map((opt, i) => `
          <button class="sg-swim-btn" data-idx="${i}" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">${opt.label}</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">${opt.subtitle}</div>
          </button>
        `).join('')}

        <button id="sg-swim-back" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">
          Back
        </button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-swim-back')?.addEventListener('click', () => { step = 0; render(); });
    modal.querySelectorAll('.sg-swim-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
        selectedSwimKind = SWIM_OPTIONS[idx].kind;
        selectedSwimVariant = null;
        step = 2;
        render();
      });
    });
  }

  // ── Tri mode — Swim duration picker ────────────────────────────────────────

  function renderSwimDuration() {
    if (!selectedSwimKind) return;
    if (selectedSwimKind === 'time_trial') { renderSwimTT(); return; }

    const opt = SWIM_OPTIONS.find(o => o.kind === selectedSwimKind)!;
    const tri = s.triConfig;
    const cssSecPer100m = tri?.swim?.cssSecPer100m;
    const skill = tri?.skillRating?.swim ?? 3;
    const phase = (s.wks?.[(s.w ?? 1) - 1]?.ph as TrainingPhase) ?? 'base';
    const sKind = selectedSwimKind as SwimSessionKind;

    let timeMin = opt.defaultMin;
    const minMin = opt.minMin;
    const maxMin = opt.maxMin;

    // Resolve effective variant: explicit user pick, else weekIndex rotation default.
    const defaultVariantIdx = (Math.abs(((s.w ?? 1) - 1)) % SWIM_VARIANT_COUNT[sKind]);

    function previewText(): string {
      const totalM = estimateDistanceMetres(timeMin, skill as 1|2|3|4|5, cssSecPer100m);
      const v = selectedSwimVariant ?? defaultVariantIdx;
      // Strip leading "{m}m total. " — the duration row already shows minutes; metres adds noise.
      return describeSwimSession(sKind, totalM, cssSecPer100m, skill as 1|2|3|4|5, s.w ?? 1, 0, v)
        .replace(/^\d+m total\.\s*/, '');
    }

    function renderContent() {
      modal.innerHTML = `
        ${modalShellOpen('auto')}
          <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${opt.label}</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">${opt.subtitle}</div>

          ${cssSecPer100m ? `
            <div style="margin-bottom:14px;padding:12px 14px;background:rgba(0,0,0,0.03);border-radius:12px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
                <div style="font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em">Target</div>
                <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em">${formatSwimPace(cssSecPer100m + opt.cssOffsetSec - opt.bandSec)}–${formatSwimPace(cssSecPer100m + opt.cssOffsetSec + opt.bandSec)}/100m</div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:11px;color:var(--c-faint)">
                <span>${opt.cssOffsetSec === 0 ? 'At CSS' : opt.cssOffsetSec > 0 ? `CSS +${opt.cssOffsetSec}s/100m` : `CSS ${opt.cssOffsetSec}s/100m`}</span>
                <span>${formatSwimPace(cssSecPer100m)}/100m CSS</span>
              </div>
            </div>
          ` : `
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:14px;padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.5">
              No CSS set yet. Distance is estimated from skill level.
            </div>
          `}

          <div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
              <div style="font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em">Duration</div>
              <div id="sg-swim-label" style="font-size:14px;font-weight:600;color:var(--c-black)">${timeMin} min</div>
            </div>
            <input type="range" id="sg-swim-slider" class="m-slider-glass" min="${minMin}" max="${maxMin}" value="${timeMin}" step="5">
            <div style="display:flex;justify-content:space-between;margin-top:2px">
              <span style="font-size:10px;color:var(--c-faint)">${minMin} min</span>
              <span style="font-size:10px;color:var(--c-faint)">${maxMin} min</span>
            </div>
          </div>

          <div style="margin-bottom:14px;padding:12px 14px;background:rgba(0,0,0,0.03);border-radius:12px">
            <div style="font-size:10px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">What you'll do</div>
            <div id="sg-swim-preview" style="font-size:13px;color:var(--c-black);line-height:1.5">${previewText()}</div>
            <button id="sg-swim-variants" style="background:none;border:none;padding:0;margin-top:8px;font-size:12px;color:var(--c-muted);cursor:pointer;font-family:var(--f)">Different structure →</button>
          </div>

          <div style="font-size:12px;color:var(--c-muted);margin:10px 0 18px;line-height:1.5">${disciplineRecoveryLine(s, 'swim')}</div>

          <button id="sg-swim-confirm" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">
            Add to plan
          </button>
          <button id="sg-swim-back2" class="m-btn-glass m-btn-glass--inset" style="width:100%">
            Back
          </button>
        ${modalShellClose()}
      `;

      const slider = modal.querySelector('#sg-swim-slider') as HTMLInputElement;
      const lbl = modal.querySelector('#sg-swim-label');
      const prev = modal.querySelector('#sg-swim-preview');
      slider?.addEventListener('input', () => {
        timeMin = parseInt(slider.value, 10);
        if (lbl) lbl.textContent = `${timeMin} min`;
        if (prev) prev.textContent = previewText();
      });

      document.getElementById('sg-swim-variants')?.addEventListener('click', () => { step = 3; render(); });
      document.getElementById('sg-swim-back2')?.addEventListener('click', () => {
        // Going back to kind picker — clear any explicit variant so the next kind starts fresh.
        selectedSwimVariant = null;
        step = 1;
        render();
      });
      document.getElementById('sg-swim-confirm')?.addEventListener('click', async () => {
        modal.remove();
        const wo = generateSwimSession({
          phase, skill: skill as 1 | 2 | 3 | 4 | 5,
          weekIndex: s.w ?? 1, totalWeeks: s.tw ?? 18,
          targetMinutes: timeMin, kind: sKind, cssSecPer100m,
          variantIndex: selectedSwimVariant ?? defaultVariantIdx,
        });
        await saveTriAdhoc(wo, 'swim');
      });
    }

    renderContent();
  }

  // ── Tri mode — Swim variant drill-down ────────────────────────────────────

  function renderSwimVariantList() {
    if (!selectedSwimKind || selectedSwimKind === 'time_trial') return;
    const sKind = selectedSwimKind as SwimSessionKind;
    const opt = SWIM_OPTIONS.find(o => o.kind === sKind)!;
    const tri = s.triConfig;
    const cssSecPer100m = tri?.swim?.cssSecPer100m;
    const skill = (tri?.skillRating?.swim ?? 3) as 1|2|3|4|5;
    // Use the current default duration to render previews consistently.
    const previewMin = opt.defaultMin;
    const totalM = estimateDistanceMetres(previewMin, skill, cssSecPer100m);
    const count = SWIM_VARIANT_COUNT[sKind];

    const variantTiles = Array.from({ length: count }, (_, i) => {
      const desc = describeSwimSession(sKind, totalM, cssSecPer100m, skill, s.w ?? 1, 0, i)
        .replace(/^\d+m total\.\s*/, '');
      return `
        <button class="sg-swim-variant-btn" data-idx="${i}" style="${tilePickerStyle()}">
          <div style="font-size:12px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Variant ${i + 1}</div>
          <div style="font-size:13px;color:var(--c-black);line-height:1.5">${desc}</div>
        </button>
      `;
    }).join('');

    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${opt.label} — pick a structure</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">All target the same intensity. Pick the rep shape you prefer.</div>
        ${variantTiles}
        <button id="sg-swim-variant-back" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">
          Back
        </button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-swim-variant-back')?.addEventListener('click', () => { step = 2; render(); });
    modal.querySelectorAll('.sg-swim-variant-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedSwimVariant = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
        step = 2;
        render();
      });
    });
  }

  // ── Tri mode — Swim CSS test (Time Trial) ─────────────────────────────────

  function renderSwimTT() {
    const tri = s.triConfig;
    const cssSecPer100m = tri?.swim?.cssSecPer100m;

    modal.innerHTML = `
      ${modalShellOpen('auto')}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">CSS test</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">A 400m all-out swim. Sets your Critical Swim Speed benchmark.</div>

        <div style="margin-bottom:14px;padding:12px 14px;background:rgba(0,0,0,0.03);border-radius:12px">
          <div style="font-size:10px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Protocol</div>
          <div style="font-size:13px;color:var(--c-black);line-height:1.55">600m easy warm-up with 4×50m drills. 4×100m progressively faster, 30s rest. Main: <strong>400m all-out</strong>. 200m easy cool-down.</div>
        </div>

        ${cssSecPer100m ? `
          <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.5">
            Current CSS: ${formatSwimPace(cssSecPer100m)}/100m. A 400m faster than ${formatSwimPace(cssSecPer100m * 4)} updates it.
          </div>
        ` : ''}

        <div style="font-size:11px;color:var(--c-muted);padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.55;margin-bottom:16px">
          Allow 24–48 hours of easy training afterwards. Best done fresh — not after a hard bike or run day.
        </div>

        <button id="sg-swim-tt-confirm" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">
          Add to plan
        </button>
        <button id="sg-swim-tt-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">
          Back
        </button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-swim-tt-back')?.addEventListener('click', () => { step = 1; render(); });
    document.getElementById('sg-swim-tt-confirm')?.addEventListener('click', async () => {
      modal.remove();
      const wo: Workout = {
        n: 'CSS test',
        d: '600m easy warm-up + 4×50m drills. 4×100m build, 30s rest. Main: 400m all-out. 200m cool-down.',
        r: 9, rpe: 9,
        t: 'swim_threshold',
        discipline: 'swim',
        aerobic: 25, anaerobic: 35,
        estimatedDurationMin: 30,
      };
      await saveTriAdhoc(wo, 'swim');
    });
  }

  // ── Tri mode — Bike kind picker ────────────────────────────────────────────

  type BikeKindKey = BikeSessionKind | 'time_trial';
  const BIKE_OPTIONS: Array<{ kind: BikeKindKey; label: string; subtitle: string; pct: number; bandKey: string; minMin: number; maxMin: number; defaultMin: number; stepMin: number }> = [
    // pct = canonical midpoint %FTP for this kind. bandKey looks up BIKE_ADHERENCE_BAND for the
    // soft-gradient watt range. Coggan & Allen 2019 zones.
    // minMin/maxMin = sensible duration window. VO2 above 75min is not a real session.
    { kind: 'endurance',  label: 'Endurance',  subtitle: 'Aerobic ride at Z2.',                            pct: 0.65, bandKey: 'bike_endurance',  minMin: 45, maxMin: 300, defaultMin: 90,  stepMin: 15 },
    { kind: 'tempo',      label: 'Tempo',      subtitle: 'Sustained Z3 effort.',                           pct: 0.82, bandKey: 'bike_tempo',      minMin: 45, maxMin: 150, defaultMin: 60,  stepMin: 10 },
    { kind: 'sweet_spot', label: 'Sweet spot', subtitle: '88–94% FTP. High stimulus, manageable fatigue.', pct: 0.91, bandKey: 'bike_sweet_spot', minMin: 45, maxMin: 120, defaultMin: 75,  stepMin: 10 },
    { kind: 'threshold',  label: 'Threshold',  subtitle: 'Intervals at FTP.',                              pct: 1.00, bandKey: 'bike_threshold',  minMin: 45, maxMin: 90,  defaultMin: 60,  stepMin: 5  },
    { kind: 'vo2',        label: 'VO2',        subtitle: 'Hard intervals above threshold.',                pct: 1.15, bandKey: 'bike_vo2',        minMin: 30, maxMin: 75,  defaultMin: 50,  stepMin: 5  },
    { kind: 'hills',      label: 'Hills',      subtitle: 'Climbing repeats.',                              pct: 0.95, bandKey: 'bike_hills',      minMin: 45, maxMin: 120, defaultMin: 60,  stepMin: 5  },
    { kind: 'time_trial', label: 'FTP test',   subtitle: '20-min all-out. Sets your benchmark.',           pct: 1.00, bandKey: 'bike_threshold',  minMin: 70, maxMin: 70,  defaultMin: 70,  stepMin: 5  },
  ];

  function renderBikeKind() {
    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Bike session</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">Pick a bike type.</div>

        ${BIKE_OPTIONS.map((opt, i) => `
          <button class="sg-bike-btn" data-idx="${i}" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">${opt.label}</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">${opt.subtitle}</div>
          </button>
        `).join('')}

        <button id="sg-bike-back" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">
          Back
        </button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-bike-back')?.addEventListener('click', () => { step = 0; render(); });
    modal.querySelectorAll('.sg-bike-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
        selectedBikeKind = BIKE_OPTIONS[idx].kind;
        selectedBikeVariant = null;
        step = 2;
        render();
      });
    });
  }

  // ── Tri mode — Bike duration picker ────────────────────────────────────────

  function renderBikeDuration() {
    if (!selectedBikeKind) return;
    if (selectedBikeKind === 'time_trial') { renderBikeTT(); return; }

    const opt = BIKE_OPTIONS.find(o => o.kind === selectedBikeKind)!;
    const tri = s.triConfig;
    const ftp = tri?.bike?.ftp;
    const hasPowerMeter = tri?.bike?.hasPowerMeter ?? false;
    const skill = tri?.skillRating?.bike ?? 3;
    const phase = (s.wks?.[(s.w ?? 1) - 1]?.ph as TrainingPhase) ?? 'base';
    const bKind = selectedBikeKind as BikeSessionKind;

    let timeMin = opt.defaultMin;
    const minMin = opt.minMin;
    const maxMin = opt.maxMin;
    const stepMin = opt.stepMin;
    const fmtCap = (m: number) => m >= 60 ? `${Math.round(m / 6) / 10}h`.replace('.0h', 'h') : `${m} min`;

    // Resolve target watt band from the BIKE_ADHERENCE_BAND constants.
    const band = BIKE_ADHERENCE_BAND[opt.bandKey] ?? 0.07;
    const targetMid = ftp ? Math.round(ftp * opt.pct) : null;
    const targetLo  = ftp ? Math.round(ftp * opt.pct * (1 - band)) : null;
    const targetHi  = ftp ? Math.round(ftp * opt.pct * (1 + band)) : null;

    const defaultVariantIdx = (Math.abs(((s.w ?? 1) - 1)) % BIKE_VARIANT_COUNT[bKind]);

    function previewText(): string {
      const v = selectedBikeVariant ?? defaultVariantIdx;
      return describeBikeSession(bKind, timeMin, ftp, hasPowerMeter, s.w ?? 1, 0, v);
    }

    function renderContent() {
      modal.innerHTML = `
        ${modalShellOpen('auto')}
          <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${opt.label}</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">${opt.subtitle}</div>

          ${ftp && targetLo && targetHi ? `
            <div style="margin-bottom:14px;padding:12px 14px;background:rgba(0,0,0,0.03);border-radius:12px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
                <div style="font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em">Target</div>
                <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em">${targetLo}–${targetHi}W</div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:11px;color:var(--c-faint)">
                <span>${Math.round(opt.pct * 100)}% FTP${hasPowerMeter ? '' : ' · HR-based'}</span>
                <span>${ftp}W FTP · ~${targetMid}W mid</span>
              </div>
            </div>
          ` : `
            <div style="font-size:11px;color:var(--c-muted);margin-bottom:14px;padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.5">
              No FTP set yet. Targets shown as HR zones in the workout description.
            </div>
          `}

          <div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
              <div style="font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em">Duration</div>
              <div id="sg-bike-label" style="font-size:14px;font-weight:600;color:var(--c-black)">${timeMin} min</div>
            </div>
            <input type="range" id="sg-bike-slider" class="m-slider-glass" min="${minMin}" max="${maxMin}" value="${timeMin}" step="${stepMin}">
            <div style="display:flex;justify-content:space-between;margin-top:2px">
              <span style="font-size:10px;color:var(--c-faint)">${fmtCap(minMin)}</span>
              <span style="font-size:10px;color:var(--c-faint)">${fmtCap(maxMin)}</span>
            </div>
          </div>

          <div style="margin-bottom:14px;padding:12px 14px;background:rgba(0,0,0,0.03);border-radius:12px">
            <div style="font-size:10px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">What you'll do</div>
            <div id="sg-bike-preview" style="font-size:13px;color:var(--c-black);line-height:1.5">${previewText()}</div>
            <button id="sg-bike-variants" style="background:none;border:none;padding:0;margin-top:8px;font-size:12px;color:var(--c-muted);cursor:pointer;font-family:var(--f)">Different structure →</button>
          </div>

          <div style="font-size:12px;color:var(--c-muted);margin:10px 0 18px;line-height:1.5">${disciplineRecoveryLine(s, 'bike')}</div>

          <button id="sg-bike-confirm" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">
            Add to plan
          </button>
          <button id="sg-bike-back2" class="m-btn-glass m-btn-glass--inset" style="width:100%">
            Back
          </button>
        ${modalShellClose()}
      `;

      const slider = modal.querySelector('#sg-bike-slider') as HTMLInputElement;
      const lbl = modal.querySelector('#sg-bike-label');
      const prev = modal.querySelector('#sg-bike-preview');
      slider?.addEventListener('input', () => {
        timeMin = parseInt(slider.value, 10);
        if (lbl) lbl.textContent = `${timeMin} min`;
        if (prev) prev.textContent = previewText();
      });

      document.getElementById('sg-bike-variants')?.addEventListener('click', () => { step = 3; render(); });
      document.getElementById('sg-bike-back2')?.addEventListener('click', () => {
        selectedBikeVariant = null;
        step = 1;
        render();
      });
      document.getElementById('sg-bike-confirm')?.addEventListener('click', async () => {
        modal.remove();
        const wo = generateBikeSession({
          phase, skill: skill as 1 | 2 | 3 | 4 | 5,
          weekIndex: s.w ?? 1, totalWeeks: s.tw ?? 18,
          targetMinutes: timeMin, kind: bKind, ftp, hasPowerMeter,
          variantIndex: selectedBikeVariant ?? defaultVariantIdx,
        });
        await saveTriAdhoc(wo, 'bike');
      });
    }

    renderContent();
  }

  // ── Tri mode — Bike variant drill-down ────────────────────────────────────

  function renderBikeVariantList() {
    if (!selectedBikeKind || selectedBikeKind === 'time_trial') return;
    const bKind = selectedBikeKind as BikeSessionKind;
    const opt = BIKE_OPTIONS.find(o => o.kind === bKind)!;
    const tri = s.triConfig;
    const ftp = tri?.bike?.ftp;
    const hasPowerMeter = tri?.bike?.hasPowerMeter ?? false;
    const previewMin = opt.defaultMin;
    const count = BIKE_VARIANT_COUNT[bKind];

    const variantTiles = Array.from({ length: count }, (_, i) => {
      const desc = describeBikeSession(bKind, previewMin, ftp, hasPowerMeter, s.w ?? 1, 0, i);
      return `
        <button class="sg-bike-variant-btn" data-idx="${i}" style="${tilePickerStyle()}">
          <div style="font-size:12px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Variant ${i + 1}</div>
          <div style="font-size:13px;color:var(--c-black);line-height:1.5">${desc}</div>
        </button>
      `;
    }).join('');

    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${opt.label} — pick a structure</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">All target the same intensity. Pick the rep shape you prefer.</div>
        ${variantTiles}
        <button id="sg-bike-variant-back" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">
          Back
        </button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-bike-variant-back')?.addEventListener('click', () => { step = 2; render(); });
    modal.querySelectorAll('.sg-bike-variant-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedBikeVariant = parseInt((btn as HTMLElement).dataset.idx || '0', 10);
        step = 2;
        render();
      });
    });
  }

  // ── Tri mode — Bike FTP test (Time Trial) ─────────────────────────────────

  function renderBikeTT() {
    const tri = s.triConfig;
    const ftp = tri?.bike?.ftp;

    modal.innerHTML = `
      ${modalShellOpen('auto')}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">FTP test</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">A 20-min all-out effort. Sets your Functional Threshold Power. Coggan & Allen 2019 protocol.</div>

        <div style="margin-bottom:14px;padding:12px 14px;background:rgba(0,0,0,0.03);border-radius:12px">
          <div style="font-size:10px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Protocol</div>
          <div style="font-size:13px;color:var(--c-black);line-height:1.55">20min Warm up. 3×1min @ 100rpm fast spin, 1min easy. 5min all-out. 10min easy. <strong>20min all-out</strong> — pace evenly. 10min Cool down.</div>
        </div>

        ${ftp ? `
          <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.5">
            Current FTP: ${ftp}W. Target the highest 20-min average you can hold. New FTP = 95% of that average.
          </div>
        ` : ''}

        <div style="font-size:11px;color:var(--c-muted);padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.55;margin-bottom:16px">
          Allow 48 hours of easy training afterwards. Best done fresh — not after a hard run or another bike day.
        </div>

        <button id="sg-bike-tt-confirm" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">
          Add to plan
        </button>
        <button id="sg-bike-tt-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">
          Back
        </button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-bike-tt-back')?.addEventListener('click', () => { step = 1; render(); });
    document.getElementById('sg-bike-tt-confirm')?.addEventListener('click', async () => {
      modal.remove();
      const wo: Workout = {
        n: 'FTP test',
        d: '20min Warm up. 3×1min fast spin / 1min easy. 5min all-out. 10min easy. 20min all-out (pace evenly). 10min Cool down.',
        r: 9, rpe: 9,
        t: 'bike_threshold',
        discipline: 'bike',
        aerobic: 70, anaerobic: 50,
        estimatedDurationMin: 70,
      };
      await saveTriAdhoc(wo, 'bike');
    });
  }

  // ── Tri mode — Save adhoc workout into triWorkouts ────────────────────────

  async function saveTriAdhoc(wo: Workout, discipline: TriDiscipline): Promise<void> {
    const { DAY_NAMES } = await import('@/workouts/scheduler.triathlon');
    const jsDay = new Date().getDay();
    const ourDay = jsDay === 0 ? 6 : jsDay - 1;

    const ms = getMutableState();
    const wk = ms.wks?.[(ms.w ?? 1) - 1];
    if (!wk) return;
    if (!wk.triWorkouts) wk.triWorkouts = [];
    wk.triWorkouts.push({
      ...wo,
      id: `adhoc-${Date.now()}`,
      discipline,
      dayOfWeek: ourDay,
      dayName: DAY_NAMES[ourDay],
    });
    saveState();

    const { renderTriathlonPlanView } = await import('./triathlon/plan-view');
    renderTriathlonPlanView();
  }

  // ── Step 2: Set effort + distance/time ────────────────────────────────────

  function renderStep2() {
    if (!selectedType) return;

    if (selectedType.slot === 'time_trial') { renderTimeTrial(); return; }
    if (selectedType.slot === 'vibes') { renderVibes(); return; }

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
            <div style="font-size:12px;color:var(--c-muted);margin-bottom:10px">${isTri ? disciplineRecoveryLine(s, 'run') : recoveryLine}</div>
            <div style="display:flex;gap:6px">
              ${EFFORT_OPTIONS.map(opt => {
                const sel = opt.key === selectedEffort;
                const isRec = opt.key === recommendedEffort;
                return `
                  <button class="sg-effort-btn" data-effort="${opt.key}"
                    style="flex:1;display:flex;flex-direction:column;align-items:center;padding:10px 6px;border-radius:10px;cursor:pointer;font-family:var(--f);transition:transform 120ms ease, box-shadow 120ms ease;
                           border:1px solid ${sel ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.06)'};
                           background:${sel ? '#0A0A0A' : 'rgba(255,255,255,0.95)'};
                           box-shadow:${sel ? '0 0 0 1px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.10)' : '0 1px 2px rgba(0,0,0,0.04), 0 4px 10px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.4)'}">
                    <div style="font-size:12px;font-weight:600;color:${sel ? '#FDFCF7' : 'var(--c-black)'};margin-bottom:1px">${opt.label}</div>
                    <div style="font-size:11px;color:${sel ? 'rgba(253,252,247,0.65)' : 'var(--c-muted)'}">${formatPace(opt.pace, up)}</div>
                    <div style="font-size:9px;font-weight:500;margin-top:3px;color:${sel ? 'rgba(253,252,247,0.5)' : 'var(--c-faint)'}">
                      ${isRec ? 'Suggested' : ' '}
                    </div>
                  </button>
                `;
              }).join('')}
            </div>
            ${selectedEffort === 'hard' && selectedType!.slot === 'easy' ? `
              <div style="font-size:11px;color:var(--c-muted);margin-top:8px;padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.5">
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
            style="flex:1;padding:9px 10px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f);transition:transform 120ms ease, box-shadow 120ms ease;
                   border:1px solid ${isDistance ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.06)'};
                   background:${isDistance ? '#0A0A0A' : 'rgba(255,255,255,0.95)'};
                   color:${isDistance ? '#FDFCF7' : 'var(--c-muted)'};
                   box-shadow:${isDistance ? '0 0 0 1px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.10)' : '0 1px 2px rgba(0,0,0,0.04), 0 4px 10px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.4)'}">
            Distance
          </button>
          <button id="sg-mode-time"
            style="flex:1;padding:9px 10px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f);transition:transform 120ms ease, box-shadow 120ms ease;
                   border:1px solid ${!isDistance ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.06)'};
                   background:${!isDistance ? '#0A0A0A' : 'rgba(255,255,255,0.95)'};
                   color:${!isDistance ? '#FDFCF7' : 'var(--c-muted)'};
                   box-shadow:${!isDistance ? '0 0 0 1px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.10)' : '0 1px 2px rgba(0,0,0,0.04), 0 4px 10px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.4)'}">
            Time
          </button>
        </div>

        <div style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
            <div style="font-size:11px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em">${isDistance ? 'Distance' : 'Duration'}</div>
            <div id="sg-value-label" style="font-size:14px;font-weight:600;color:var(--c-black)">${isDistance ? distLabel : timeMin + ' min'}</div>
          </div>
          <input type="range" id="sg-slider" class="m-slider-glass"
            min="${isDistance ? minKm : 15}" max="${isDistance ? maxKm : 120}"
            value="${isDistance ? distanceKm : timeMin}"
            step="${isDistance ? 1 : 5}">
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
      ${modalShellOpen('auto')}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${selectedType.label}</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">${selectedType.subtitle}</div>

        <div id="sg-step2-inner"></div>

        <button id="sg-confirm" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">
          Add to plan
        </button>
        <button id="sg-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">
          Back
        </button>
      ${modalShellClose()}
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

      if (isTri) {
        // Triathlon: tag as run discipline and route into triWorkouts.
        saveTriAdhoc(session, 'run');
        return;
      }

      const ms = getMutableState();
      const wk = ms.wks?.[ms.w - 1];
      if (!wk) return;
      if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
      wk.adhocWorkouts.push(session);
      saveState();

      import('./main-view').then(({ renderMainView }) => renderMainView());
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
        ${modalShellOpen('auto')}
          <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Time Trial</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">Based on your current fitness. Pick a distance.</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
            ${predictions.map(d => {
              const sel = d.label === selectedDist.label;
              const timeStr = d.predictedSec ? fmtTimeSec(d.predictedSec) : '—';
              return `
                <button class="sg-tt-btn" data-label="${d.label}"
                  style="display:flex;flex-direction:column;align-items:flex-start;padding:12px 14px;border-radius:12px;cursor:pointer;font-family:var(--f);transition:transform 120ms ease, box-shadow 120ms ease;
                         border:1px solid ${sel ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.06)'};
                         background:${sel ? '#0A0A0A' : 'rgba(255,255,255,0.95)'};
                         box-shadow:${sel ? '0 0 0 1px rgba(0,0,0,0.9), 0 4px 12px rgba(0,0,0,0.10)' : '0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.4)'}">
                  <div style="font-size:13px;font-weight:600;color:${sel ? '#FDFCF7' : 'var(--c-black)'};margin-bottom:3px">${d.label}</div>
                  <div style="font-size:12px;color:${sel ? 'rgba(253,252,247,0.65)' : 'var(--c-muted)'}">${timeStr}</div>
                </button>
              `;
            }).join('')}
          </div>

          <div style="font-size:11px;color:var(--c-muted);padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.55;margin-bottom:16px">
            A time trial creates significant fatigue. Allow 2 to 3 days of easy running afterwards. Not appropriate if a race or key session falls within the next 5 days.
          </div>

          <button id="sg-tt-confirm" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">
            Add to plan
          </button>
          <button id="sg-tt-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">
            Back
          </button>
        ${modalShellClose()}
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

        if (isTri) {
          saveTriAdhoc(session, 'run');
          return;
        }

        const ms = getMutableState();
        const wk = ms.wks?.[ms.w - 1];
        if (!wk) return;
        if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
        wk.adhocWorkouts.push(session);
        saveState();

        import('./main-view').then(({ renderMainView }) => renderMainView());
      });
    }

    renderContent();
  }

  // ── Run by Feel step ───────────────────────────────────────────────────────

  function renderVibes() {
    modal.innerHTML = `
      <style>
        @keyframes sg-vibes-glint {
          0%   { opacity:0.35; transform:translate(0,0) scale(1) }
          35%  { opacity:0.95; transform:translate(8px,6px) scale(1.06) }
          70%  { opacity:0.85; transform:translate(-4px,-2px) scale(1.02) }
          100% { opacity:1;    transform:translate(0,0) scale(1) }
        }
        @keyframes sg-vibes-sweep {
          0%   { transform:translateX(-110%) skewX(-18deg); opacity:0 }
          15%  { opacity:0.55 }
          70%  { opacity:0.4 }
          100% { transform:translateX(220%) skewX(-18deg); opacity:0 }
        }
        .sg-vibes-glint { animation:sg-vibes-glint 2.4s cubic-bezier(0.2,0.8,0.2,1) 1 both }
        .sg-vibes-sweep { animation:sg-vibes-sweep 2.6s cubic-bezier(0.4,0,0.2,1) 0.2s 1 both }
      </style>
      <div class="w-full max-w-sm rounded-2xl" style="background:#ffffff;position:relative;overflow:hidden;border:1px solid var(--c-border);box-shadow:0 4px 16px rgba(0,0,0,0.06), 0 16px 48px rgba(0,0,0,0.08)">
        <div aria-hidden="true" class="sg-vibes-glint" style="position:absolute;top:-30px;left:-30px;width:380px;height:380px;pointer-events:none;
          background:radial-gradient(ellipse 55% 55% at 22% 22%, rgba(255,248,229,0.65) 0%, rgba(255,248,229,0.22) 30%, transparent 70%)"></div>
        <div aria-hidden="true" class="sg-vibes-sweep" style="position:absolute;top:0;bottom:0;left:0;width:50%;pointer-events:none;
          background:linear-gradient(105deg, transparent 30%, rgba(255,248,229,0.55) 50%, transparent 70%);mix-blend-mode:screen"></div>

        <button id="sg-vibes-close" aria-label="Close"
          style="position:absolute;top:14px;right:14px;width:28px;height:28px;border-radius:50%;border:none;background:transparent;color:var(--c-muted);cursor:pointer;font-size:18px;line-height:1;display:flex;align-items:center;justify-content:center;font-family:var(--f);z-index:2">×</button>

        <div style="position:relative;padding:24px">
          <div style="font-size:20px;font-weight:700;color:var(--c-black);margin-bottom:10px;letter-spacing:-0.01em">Run by Feel</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.6">
            Sometimes plans are too prescriptive. Listening to your body allows you to push yourself.
          </div>

          <ol style="list-style:none;padding:0;margin:0 0 18px 0">
            <li style="display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;font-size:13px;line-height:20px">
              <span style="flex:0 0 20px;height:20px;border-radius:50%;background:var(--c-black);color:#fff;font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;font-family:var(--f);font-variant-numeric:tabular-nums">1</span>
              <span style="color:var(--c-black)">Run 5km at easy pace. Put on some good music, take photos of things that are cool, just enjoy</span>
            </li>
            <li style="display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:20px">
              <span style="flex:0 0 20px;height:20px;border-radius:50%;background:var(--c-black);color:#fff;font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;font-family:var(--f);font-variant-numeric:tabular-nums">2</span>
              <span style="color:var(--c-black)">If at 5km you want to stop, stop. Otherwise keep running until it's no longer fun</span>
            </li>
          </ol>

          <div style="font-size:13px;color:var(--c-black);line-height:1.55;margin-bottom:14px;font-style:italic">
            Tristan (our founder) got his half marathon PB on one of these.
          </div>

          <button id="sg-vibes-science"
            style="background:none;border:none;padding:0;font-size:11px;color:var(--c-muted);cursor:pointer;text-align:left;font-family:var(--f);margin-bottom:22px;line-height:1.5">
            Click here for the science
          </button>

          <button id="sg-vibes-confirm" class="m-btn-glass" style="width:100%">
            Add to plan
          </button>
        </div>
      </div>
    `;

    document.getElementById('sg-vibes-close')?.addEventListener('click', () => modal.remove());
    document.getElementById('sg-vibes-science')?.addEventListener('click', () => openVibesScienceModal());
    document.getElementById('sg-vibes-confirm')?.addEventListener('click', async () => {
      modal.remove();

      const jsDay = new Date().getDay();
      const ourDay = jsDay === 0 ? 6 : jsDay - 1;

      const ms = getMutableState();
      const wk = ms.wks?.[ms.w - 1];
      if (!wk) return;

      if (ms.eventType === 'triathlon' || ms.eventType === 'hyrox') {
        // Triathlon and hyrox both store sessions on wk.triWorkouts.
        const { DAY_NAMES } = await import('@/workouts/scheduler.triathlon');
        if (!wk.triWorkouts) wk.triWorkouts = [];
        wk.triWorkouts.push({
          id: `adhoc-${Date.now()}`,
          t: 'vibes',
          n: 'Run by Feel',
          d: '5km easy, then keep going if it\'s still fun',
          r: 4,
          rpe: 4,
          dayOfWeek: ourDay,
          dayName: DAY_NAMES[ourDay],
          discipline: 'run',
        });
        ms.vibesRunNudgeDismissed = true;
        saveState();
        if (ms.eventType === 'triathlon') {
          const { renderTriathlonPlanView } = await import('./triathlon/plan-view');
          renderTriathlonPlanView();
        } else {
          const { renderHyroxPlanView } = await import('./hyrox/plan-view');
          renderHyroxPlanView();
        }
      } else {
        // Running / fitness: adhocWorkouts path.
        if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
        wk.adhocWorkouts.push({
          id: `adhoc-${Date.now()}`,
          t: 'vibes',
          n: 'Run by Feel',
          d: '5km easy, then keep going if it\'s still fun',
          r: 4,
          rpe: 4,
          dayOfWeek: ourDay,
        });
        ms.vibesRunNudgeDismissed = true;
        saveState();
        import('./main-view').then(({ renderMainView }) => renderMainView());
      }
    });
  }

  render();
}

/**
 * Run by Feel science explainer modal. Surfaces the literature behind the workout.
 * Opened from the session-generator Run by Feel step and the build-phase nudge card.
 */
export function openVibesScienceModal(): void {
  const id = 'vibes-science-modal';
  document.getElementById(id)?.remove();

  const modal = document.createElement('div');
  modal.id = id;
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.55)';
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  modal.innerHTML = `
    <div class="w-full max-w-sm rounded-2xl p-5" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
      <div style="font-size:16px;font-weight:600;color:var(--c-black);margin-bottom:14px">Why Run by Feel works</div>

      <div style="font-size:13px;line-height:1.55;margin-bottom:14px">
        <div style="font-weight:600;color:var(--c-black);margin-bottom:3px">Fartlek (Holmér, 1937)</div>
        <div style="color:var(--c-muted)">Speed play in Swedish. Unstructured pace variation builds aerobic capacity precisely because the runner self-selects intensity.</div>
      </div>

      <div style="font-size:13px;line-height:1.55;margin-bottom:14px">
        <div style="font-weight:600;color:var(--c-black);margin-bottom:3px">Central governor (Noakes, 2001)</div>
        <div style="color:var(--c-muted)">The brain holds back reserves for "the planned effort". Running without targets sometimes lets you tap into them.</div>
      </div>

      <div style="font-size:13px;line-height:1.55;margin-bottom:14px">
        <div style="font-weight:600;color:var(--c-black);margin-bottom:3px">Flow state (Csikszentmihalyi, 1990)</div>
        <div style="color:var(--c-muted)">Removing the cognitive load of pace-watching lowers sympathetic arousal. Cheaper oxygen at the same pace.</div>
      </div>

      <div style="font-size:13px;line-height:1.55;margin-bottom:14px">
        <div style="font-weight:600;color:var(--c-black);margin-bottom:3px">Born to Run (McDougall, 2009)</div>
        <div style="color:var(--c-muted)">Persistence hunting and the Tarahumara. The argument that humans evolved to run for joy, not for splits.</div>
      </div>

      <div style="font-size:13px;line-height:1.55;margin-bottom:18px">
        <div style="font-weight:600;color:var(--c-black);margin-bottom:3px">Self-determination theory (Deci & Ryan, 1985)</div>
        <div style="color:var(--c-muted)">Autonomy-supportive sessions improve adherence and effort tolerance over a full training cycle.</div>
      </div>

      <button id="vibes-science-close"
        style="width:100%;padding:11px;border-radius:12px;border:1px solid var(--c-border);
               background:transparent;font-size:13px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">
        Close
      </button>
    </div>
  `;

  document.body.appendChild(modal);
  document.getElementById('vibes-science-close')?.addEventListener('click', () => modal.remove());
}

function todayDayIndex(): number {
  const js = new Date().getDay();
  return js === 0 ? 6 : js - 1;
}
