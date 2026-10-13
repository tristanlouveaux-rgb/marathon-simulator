/**
 * Session generator. Standalone modal for creating ad-hoc workouts.
 *
 * Used from plan view (general) and holiday banner.
 * Two-step flow: pick session type → set distance or time → generates structured workout.
 */

import { getState, getMutableState, saveState } from '@/state';
import type { Workout, RaceDistance } from '@/types';
import { intentToWorkout } from '@/workouts/intent_to_workout';
import type { SessionIntent, SlotType } from '@/workouts/intent_to_workout';
import { generateSwimSession, describeSwimSession, estimateDistanceMetres, SWIM_VARIANT_COUNT, type SwimSessionKind } from '@/workouts/swim';
import { generateBikeSession, describeBikeSession, BIKE_VARIANT_COUNT, type BikeSessionKind } from '@/workouts/bike';
import { generateGymWorkouts, type GymFocus } from '@/workouts/gym';
import { generateHyroxBrick } from '@/workouts/hyrox-generators';
import { hyroxLoadTierForState } from '@/calculations/hyrox-division';
import { injuryStrengthDecision } from '@/workouts/injury-strength';
import type { GymGoal } from '@/constants/strength-constants';
import { tuneGymWorkout, hyroxBandForIntensity, type GymRestStyle, type GymIntensity } from '@/workouts/gym-pool';
import { buildRunningStrengthWorkout, buildPlyometricsWorkout } from '@/workouts/running-pool';

/** Gym Focus options in the generator, plus the HYROX brick (its own path). */
type GymFocusChoice = GymFocus | 'hyrox';
import { BIKE_ADHERENCE_BAND } from '@/constants/triathlon-constants';
import { formatKm, fpModel, fmtModelPaceKm, ft } from '@/utils/format';
import type { UnitPref } from '@/utils/format';
import { computeReadinessACWR } from '@/calculations/fitness-model';
import { predictStandardDistances } from '@/calculations/blended-fitness';
import { buildSessionRecommendation } from '@/calculations/session-recommendation';
import type { TrainingPhase } from '@/types/training';

const MODAL_ID = 'session-generator-modal';

type EffortKey = 'easy' | 'steady' | 'hard';

const TIME_TRIAL_DISTANCES: ReadonlyArray<{ label: string; key: RaceDistance; dist: number; km: number }> = [
  { label: '5K',       key: '5k',       dist: 5000,  km: 5 },
  { label: '10K',      key: '10k',      dist: 10000, km: 10 },
  { label: 'Half',     key: 'half',     dist: 21097, km: 21.097 },
  { label: 'Marathon', key: 'marathon', dist: 42195, km: 42.195 },
];

/**
 * The Time Trial step's predicted times: the four standard-distance
 * predictions the Forecast tab shows (predictStandardDistances: PB age
 * weights, the HR-tested recent race, the measured weekly km, calibration and
 * the durability cap), so they cannot disagree with it. The local blend this
 * step ran passed none of those (2026-10-11). Null where no prediction exists.
 */
export function timeTrialPredictions(
  s: Parameters<typeof predictStandardDistances>[0],
): Array<(typeof TIME_TRIAL_DISTANCES)[number] & { predictedSec: number | null }> {
  const standard = predictStandardDistances(s);
  return TIME_TRIAL_DISTANCES.map(d => ({ ...d, predictedSec: standard[d.key] }));
}

function formatSwimPace(secPer100m: number): string {
  // Round once, before splitting, so 119.6 s reads 2:00, never 1:60.
  const t = Math.round(secPer100m);
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Inline styles for a picker tile (discipline / kind cards). Mirrors the
 * wizard `.tri-card` aesthetic. White surface, soft elevation, inset
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
 * `triConfig.fitness` rather than the global ACWR. So a bike modal reflects
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

// Recovery effort band (from buildSessionRecommendation.recommendedSlot) → a
// concrete run session type for the "Suggested session" path. Walks up the
// existing RPE ladder only: easy (rpe 3) → progressive (rpe 5) → threshold
// (rpe 7). It deliberately stops short of VO2 (rpe 8) and Time Trial — the
// system never proposes the highest-risk sessions unprompted; those stay opt-in
// via "Pick your own". No new durations or constants: each mapped type carries
// its own `defaultMinutes`.
const SUGGESTED_SLOT_BY_EFFORT: Record<'easy' | 'steady' | 'hard', SlotType> = {
  easy: 'easy',
  steady: 'progressive',
  hard: 'threshold',
};

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
  // On-demand mode (formerly "Just track"): no plan, but the user can generate a
  // session in any discipline we support — run, bike, swim, gym. It reuses the same
  // discipline picker as tri, but every result saves to adhocWorkouts (the single
  // running/fitness store), never triWorkouts, and re-renders the main view.
  const isOnDemand = s.trackOnly === true;
  // Run-types list is identical across modes; in tri mode it's the third step
  // after the user picks "Run" from the discipline picker.
  const availableTypes: SessionTypeOption[] = SESSION_TYPES;

  // Tri-mode flow state. Tracks which discipline the user picked. When
  // selectedDiscipline === 'run' the existing renderStep1/Step2 are reused
  // with the save path tagged for triWorkouts.
  type TriDiscipline = 'swim' | 'bike' | 'run';
  // On-demand can additionally pick 'gym'. Tri/run flows never set it.
  type GenDiscipline = TriDiscipline | 'gym';
  let selectedDiscipline: GenDiscipline | null = null;
  // True once the user reached a discipline via the picker (tri always; on-demand
  // when they chose "Pick your own"). Drives whether "Run" shows a Back vs Cancel.
  // Running mode (a plan-following runner — not on-demand/tri/hyrox) now also gets
  // the discipline picker: Run / Gym / Bike / Swim as top-level tiles, so Gym is no
  // longer buried at the bottom of the run-type list and swim/cycling are reachable
  // as cross-training. Swim/bike save as adhoc and the generators degrade gracefully
  // without FTP/CSS.
  const isRunningMode = !isTri && !isHyrox && !isOnDemand;
  const hasDisciplinePicker = isTri || isOnDemand || isRunningMode;

  // Recovery signal for effort recommendation (vibes / Run by Feel step only).
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

  // Suggestion caption shown above the type / discipline picker. Reads the
  // same composite the home Readiness ring uses (readiness, injury, HRV,
  // sleep, freshness) so the picker reflects what the rest of the app knows
  // about today. Caption-only — picker still accepts any choice.
  const sessionRec = buildSessionRecommendation(s);

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
  // Gym sub-flow: Focus → (Goal → rest, for upper/full) → preview. Running/Lower
  // skip straight to preview (they use the existing running-supportive templates).
  let selectedGymFocus: GymFocusChoice | null = null;
  let selectedGymGoal: GymGoal | null = null;
  let selectedGymRestStyle: GymRestStyle = 'traditional';
  let selectedGymMinutes = 45;
  let selectedGymIntensity: GymIntensity = 'standard';
  let gymStep: 'focus' | 'goal' | 'rest' | 'preview' = 'focus';

  const modal = document.createElement('div');
  modal.id = MODAL_ID;
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  modal.style.background = 'rgba(0,0,0,0.45)';
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  // Hyrox: jump straight to Run by Feel.
  if (isHyrox) { renderVibes(); return; }

  function render() {
    // Gym has its own multi-step sub-flow (gymStep), independent of `step`.
    if (selectedDiscipline === 'gym') {
      if (gymStep === 'goal') renderGymGoal();
      else if (gymStep === 'rest') renderGymRestStyle();
      else if (gymStep === 'preview') renderGymSession();
      else renderGymFocus();
      return;
    }
    if (step === 0) renderTriDiscipline();
    else if (step === 1) {
      if (hasDisciplinePicker && selectedDiscipline === 'swim') renderSwimKind();
      else if (hasDisciplinePicker && selectedDiscipline === 'bike') renderBikeKind();
      else renderStep1();
    } else if (step === 2) {
      if (hasDisciplinePicker && selectedDiscipline === 'swim') renderSwimDuration();
      else if (hasDisciplinePicker && selectedDiscipline === 'bike') renderBikeDuration();
      else renderStep2();
    } else {
      // step 3. Variant drill-down
      if (hasDisciplinePicker && selectedDiscipline === 'swim') renderSwimVariantList();
      else if (hasDisciplinePicker && selectedDiscipline === 'bike') renderBikeVariantList();
    }
  }

  /**
   * Render the recommendation caption. Returns empty string when there's
   * nothing to say (no injury and no readiness signal yet — e.g. fresh user
   * with no physiology / load history). Single-line, no decorative icons,
   * no colour — matches the project's consultant-tone copy rules.
   */
  function renderRecommendationCaption(): string {
    if (!sessionRec.caption) return '';
    // Caption text is assembled from enum-driven helpers (computeReadiness
    // sentence + buildInjuryCaption). No user-input strings flow through it,
    // so a light escape on the four meta characters is enough.
    const safe = String(sessionRec.caption)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `
      <div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">
        ${safe}
      </div>`;
  }

  // ── Step 1: Pick session type ──────────────────────────────────────────────

  function renderStep1() {
    // Reached "Run" via the discipline picker (tri always; on-demand when the user
    // chose "Pick your own"). Then the back button returns to the picker, not closes.
    const isTriRun = hasDisciplinePicker && selectedDiscipline === 'run';
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
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">${subtitle}</div>
        ${renderRecommendationCaption()}

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

        ${!hasDisciplinePicker ? `
        <button class="sg-gym-entry" style="${tilePickerStyle()}">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">Gym</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.45">Running strength, upper, lower or full body.</div>
        </button>` : ''}

        <button id="sg-cancel" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">
          ${isTriRun ? 'Back' : 'Cancel'}
        </button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-cancel')?.addEventListener('click', () => {
      if (isTriRun) { step = 0; render(); }
      else modal.remove();
    });
    modal.querySelector('.sg-gym-entry')?.addEventListener('click', () => {
      selectedDiscipline = 'gym';
      gymStep = 'focus';
      render();
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

  // ── Tri mode. Discipline picker (Step 0) ──────────────────────────────────

  function renderTriDiscipline() {
    const DISC_TILES: Record<'run' | 'bike' | 'swim' | 'gym', { label: string; sub: string }> = {
      run: { label: 'Run', sub: 'Easy, long, threshold, VO2 or Run by Feel.' },
      gym: { label: 'Gym', sub: 'Running strength, plyometrics, upper, lower or full body.' },
      bike: { label: 'Bike', sub: 'Endurance, sweet spot, threshold or VO2.' },
      swim: { label: 'Swim', sub: 'Technique, endurance, CSS intervals or speed.' },
    };
    // Running mode leads with Gym (the cross-sell in a running app); tri / on-demand
    // keep the swim/bike/run sports first, gym last.
    const discOrder: Array<'run' | 'bike' | 'swim' | 'gym'> = isRunningMode
      ? ['run', 'gym', 'bike', 'swim']
      : ['run', 'bike', 'swim', 'gym'];
    const discButtons = discOrder.map(d => `
          <button class="sg-disc-btn" data-disc="${d}" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">${DISC_TILES[d].label}</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">${DISC_TILES[d].sub}</div>
          </button>`).join('');
    modal.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl" style="background:#ffffff;position:relative;overflow:hidden;border:1px solid var(--c-border);box-shadow:0 4px 16px rgba(0,0,0,0.06), 0 16px 48px rgba(0,0,0,0.08);max-height:85vh;display:flex;flex-direction:column">
        <div aria-hidden="true" style="position:absolute;top:-30px;left:-30px;width:380px;height:380px;pointer-events:none;
          background:radial-gradient(ellipse 55% 55% at 22% 22%, rgba(255,248,229,0.5) 0%, rgba(255,248,229,0.18) 30%, transparent 70%)"></div>

        <div style="position:relative;padding:22px 22px 18px;overflow-y:auto">
          <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Add session</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">Pick a discipline.</div>
          ${renderRecommendationCaption()}

          ${discButtons}

          <button id="sg-disc-cancel" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">
            ${!isTri ? 'Back' : 'Cancel'}
          </button>
        </div>
      </div>
    `;

    document.getElementById('sg-disc-cancel')?.addEventListener('click', () => {
      // Running + on-demand reach the picker via the entry chooser, so Back returns
      // there. Tri opens straight to the picker, so its button closes the modal.
      if (!isTri) renderEntryChoice();
      else modal.remove();
    });
    modal.querySelectorAll('.sg-disc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const disc = (btn as HTMLElement).dataset.disc as GenDiscipline;
        // On-demand: offer an optional benchmark capture before bike/swim when none is
        // set yet. FTP unlocks watt targets; CSS unlocks pace targets. Both skippable —
        // the generators fall back to RPE/duration when the benchmark is absent.
        if (isOnDemand && disc === 'bike' && !s.triConfig?.bike?.ftp) { renderBenchmarkPrompt('bike'); return; }
        if (isOnDemand && disc === 'swim' && !s.triConfig?.swim?.cssSecPer100m) { renderBenchmarkPrompt('swim'); return; }
        selectedDiscipline = disc;
        if (disc === 'gym') { gymStep = 'focus'; render(); return; }
        step = 1;
        render();
      });
    });
  }

  // ── Tri mode. Swim kind picker ────────────────────────────────────────────

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

  // ── Tri mode. Swim duration picker ────────────────────────────────────────

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
      // Strip leading "{m}m total. ". The duration row already shows minutes; metres adds noise.
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
            <div style="margin-bottom:14px;padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.5">
              <div style="font-size:11px;color:var(--c-muted)">No CSS set yet. Distance is estimated from skill level.</div>
              <button id="sg-swim-add-css" style="background:none;border:none;padding:0;margin-top:6px;font-size:12px;color:var(--c-muted);cursor:pointer;font-family:var(--f)">Add your CSS →</button>
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

      document.getElementById('sg-swim-add-css')?.addEventListener('click', () => renderBenchmarkPrompt('swim', 2));
      document.getElementById('sg-swim-variants')?.addEventListener('click', () => { step = 3; render(); });
      document.getElementById('sg-swim-back2')?.addEventListener('click', () => {
        // Going back to kind picker. Clear any explicit variant so the next kind starts fresh.
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

  // ── Tri mode. Swim variant drill-down ────────────────────────────────────

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
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${opt.label}. Pick a structure</div>
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

  // ── Tri mode. Swim CSS test (Time Trial) ─────────────────────────────────

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
          Allow 24–48 hours of easy training afterwards. Best done fresh. Not after a hard bike or run day.
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

  // ── Tri mode. Bike kind picker ────────────────────────────────────────────

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

  // ── Tri mode. Bike duration picker ────────────────────────────────────────

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
            <div style="margin-bottom:14px;padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.5">
              <div style="font-size:11px;color:var(--c-muted)">No FTP set yet. Targets shown as HR zones in the workout description.</div>
              <button id="sg-bike-add-ftp" style="background:none;border:none;padding:0;margin-top:6px;font-size:12px;color:var(--c-muted);cursor:pointer;font-family:var(--f)">Add your FTP →</button>
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

      document.getElementById('sg-bike-add-ftp')?.addEventListener('click', () => renderBenchmarkPrompt('bike', 2));
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

  // ── Tri mode. Bike variant drill-down ────────────────────────────────────

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
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${opt.label}. Pick a structure</div>
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

  // ── Tri mode. Bike FTP test (Time Trial) ─────────────────────────────────

  function renderBikeTT() {
    const tri = s.triConfig;
    const ftp = tri?.bike?.ftp;

    modal.innerHTML = `
      ${modalShellOpen('auto')}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">FTP test</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">A 20-min all-out effort. Sets your Functional Threshold Power. Coggan & Allen 2019 protocol.</div>

        <div style="margin-bottom:14px;padding:12px 14px;background:rgba(0,0,0,0.03);border-radius:12px">
          <div style="font-size:10px;font-weight:600;color:var(--c-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Protocol</div>
          <div style="font-size:13px;color:var(--c-black);line-height:1.55">20min Warm up. 3×1min @ 100rpm fast spin, 1min easy. 5min all-out. 10min easy. <strong>20min all-out</strong>: pace evenly. 10min Cool down.</div>
        </div>

        ${ftp ? `
          <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.5">
            Current FTP: ${ftp}W. Target the highest 20-min average you can hold. New FTP = 95% of that average.
          </div>
        ` : ''}

        <div style="font-size:11px;color:var(--c-muted);padding:10px 12px;background:rgba(0,0,0,0.03);border-radius:10px;line-height:1.55;margin-bottom:16px">
          Allow 48 hours of easy training afterwards. Best done fresh. Not after a hard run or another bike day.
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

  // ── Tri mode. Save adhoc workout into triWorkouts ────────────────────────

  async function saveTriAdhoc(wo: Workout, discipline: TriDiscipline | 'gym'): Promise<void> {
    const jsDay = new Date().getDay();
    const ourDay = jsDay === 0 ? 6 : jsDay - 1;

    const ms = getMutableState();
    const wk = ms.wks?.[(ms.w ?? 1) - 1];
    if (!wk) return;

    // Every non-triathlon mode (on-demand, running, fitness) is single-store: each
    // discipline (run / bike / swim / gym) lands in adhocWorkouts and re-renders the
    // main/plan view. Only triathlon uses triWorkouts + the tri plan view.
    if (!isTri) {
      if (!wk.adhocWorkouts) wk.adhocWorkouts = [];
      const adhoc: Workout = { ...wo, id: `adhoc-${Date.now()}`, dayOfWeek: ourDay };
      // Tag run/bike/swim with their discipline so the session detail view (and any
      // discipline-aware display) renders them correctly rather than falling back to
      // "run". Gym is identified by t:'gym', so it needs no discipline tag.
      if (discipline !== 'gym') adhoc.discipline = discipline;
      wk.adhocWorkouts.push(adhoc);
      saveState();
      // Land on the Plan view, where the new session now shows as a "Planned"
      // activity card (buildTrackOnlyUpcoming) — consistent with how running/tri
      // render their plan after generating, instead of a loose home to-do.
      const { renderMainView } = await import('./main-view');
      renderMainView();
      return;
    }

    const { DAY_NAMES } = await import('@/workouts/scheduler.triathlon');
    if (!wk.triWorkouts) wk.triWorkouts = [];
    // A generated HYROX brick carries its own 'brick' discipline + hyroxComponents;
    // preserve it rather than overwriting with the placeholder 'gym', so the card
    // taps through to the guided HYROX player.
    const finalDiscipline = (wo as any).hyroxComponents?.length
      ? (wo as any).discipline
      : (discipline as TriDiscipline);
    wk.triWorkouts.push({
      ...wo,
      id: `adhoc-${Date.now()}`,
      discipline: finalDiscipline,
      dayOfWeek: ourDay,
      dayName: DAY_NAMES[ourDay],
    });
    saveState();

    const { renderTriathlonPlanView } = await import('./triathlon/plan-view');
    renderTriathlonPlanView();
  }

  // ── On-demand: optional FTP / CSS capture before bike / swim ───────────────
  // Shown once, only when the benchmark is missing. Saving stores a 'user'-sourced
  // value on triConfig (the canonical benchmark home — cycling mode reuses it too).
  // eventType stays non-triathlon, so this never flips the user into triathlon UI.
  // Skipping proceeds with RPE/duration targets — the generators degrade gracefully.
  function renderBenchmarkPrompt(disc: 'bike' | 'swim', returnStep?: 0 | 1 | 2 | 3) {
    const isBike = disc === 'bike';
    const title = isBike ? 'Add your FTP?' : 'Add your CSS?';
    const blurb = isBike
      ? 'Functional Threshold Power in watts. Adding it shows watt targets on your bike sessions. Skip and sessions use perceived effort instead.'
      : 'Critical Swim Speed: your threshold pace per 100m. Adding it shows pace targets on your swim sessions. Skip and distance is estimated from skill level.';

    modal.innerHTML = `
      ${modalShellOpen('auto')}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${title}</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:16px;line-height:1.5">${blurb}</div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-size:12px;font-weight:600;color:var(--c-muted);margin-bottom:8px">${isBike ? 'FTP (watts)' : 'CSS (min:sec per 100m)'}</label>
          <input type="${isBike ? 'number' : 'text'}" id="sg-bench-input" inputmode="${isBike ? 'numeric' : 'text'}"
            placeholder="${isBike ? '220' : '1:45'}"
            style="width:100%;box-sizing:border-box;background:var(--c-bg);border:1.5px solid var(--c-border-strong);color:var(--c-black);border-radius:10px;padding:12px 14px;font-size:16px;outline:none">
        </div>

        <button id="sg-bench-save" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Save and continue</button>
        <button id="sg-bench-skip" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Skip</button>
        <button id="sg-bench-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">Back</button>
      ${modalShellClose()}
    `;

    // returnStep set → reached inline from a duration preview ("Add FTP"), so go
    // back there; otherwise it's the on-demand pre-flow (→ kind picker / picker).
    const proceed = () => { selectedDiscipline = disc; step = returnStep ?? 1; render(); };

    document.getElementById('sg-bench-back')?.addEventListener('click', () => { step = returnStep ?? 0; render(); });
    document.getElementById('sg-bench-skip')?.addEventListener('click', proceed);
    document.getElementById('sg-bench-save')?.addEventListener('click', () => {
      const raw = (document.getElementById('sg-bench-input') as HTMLInputElement)?.value?.trim() ?? '';
      const ms = getMutableState();
      if (!ms.triConfig) ms.triConfig = {} as NonNullable<typeof ms.triConfig>;
      if (isBike) {
        const ftp = parseInt(raw, 10);
        if (ftp > 0) {
          ms.triConfig.bike = { ...(ms.triConfig.bike ?? {}), ftp, ftpSource: 'user', ftpConfidence: 'medium' };
          saveState();
        }
      } else {
        // Parse "m:ss" or plain seconds → sec/100m.
        let css = 0;
        if (raw.includes(':')) {
          const [m, sec] = raw.split(':');
          css = (parseInt(m, 10) || 0) * 60 + (parseInt(sec, 10) || 0);
        } else {
          css = parseInt(raw, 10) || 0;
        }
        if (css > 0) {
          ms.triConfig.swim = { ...(ms.triConfig.swim ?? {}), cssSecPer100m: css, cssSource: 'user' };
          saveState();
        }
      }
      proceed();
    });
  }

  // ── On-demand: gym session ─────────────────────────────────────────────────
  // ── Gym sub-flow: Focus → (Goal → rest, upper/full only) → preview ──────────

  function gymBackToDisciplines() {
    selectedDiscipline = null;
    step = hasDisciplinePicker ? 0 : 1;
    render();
  }

  function renderGymFocus() {
    // Fresh focus selection clears any goal/rest chosen on a prior pass.
    selectedGymGoal = null;
    selectedGymRestStyle = 'traditional';
    const FOCI: Array<{ k: GymFocusChoice; label: string; sub: string }> = [
      { k: 'running', label: 'Running strength', sub: 'Lower body + core for running economy. Matched to your phase.' },
      { k: 'plyometrics', label: 'Plyometrics', sub: 'Explosive jumps and bounds for reactive strength and economy.' },
      { k: 'lower', label: 'Lower body', sub: 'Squats, hinges, single-leg and calves.' },
      { k: 'upper', label: 'Upper body', sub: 'Press, pull and arms.' },
      { k: 'full', label: 'Full body', sub: 'A squat, hinge, press, pull and core.' },
    ];
    // HYROX renders + guides correctly via the ad-hoc / tri card path; the running
    // plan card can't host a brick yet, so only offer it where it works (tri /
    // on-demand). Running mode now has the discipline picker too, but must NOT get
    // a HYROX brick focus.
    if (isTri || isOnDemand) {
      FOCI.push({ k: 'hyrox', label: 'HYROX', sub: 'Runs paired with sled, ski-erg and carry stations.' });
    }
    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Gym session</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">What do you want to train?</div>
        ${FOCI.map(f => `
          <button class="sg-gym-focus" data-focus="${f.k}" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">${f.label}</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">${f.sub}</div>
          </button>`).join('')}
        <button id="sg-gym-focus-back" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">Back</button>
      ${modalShellClose()}
    `;
    document.getElementById('sg-gym-focus-back')?.addEventListener('click', gymBackToDisciplines);
    modal.querySelectorAll('.sg-gym-focus').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedGymFocus = (btn as HTMLElement).dataset.focus as GymFocusChoice;
        // Lower / Upper / Full are goal-driven (goal → rest). Running, Plyometrics
        // and HYROX own their prescription (no goal/load choice) — all skip
        // straight to the preview.
        gymStep = (selectedGymFocus === 'running' || selectedGymFocus === 'plyometrics' || selectedGymFocus === 'hyrox') ? 'preview' : 'goal';
        render();
      });
    });
  }

  function renderGymGoal() {
    const GOALS: Array<{ k: GymGoal; label: string; sub: string }> = [
      { k: 'strength', label: 'Strength', sub: 'Heavy, low reps (about 4x5). Longer rests.' },
      { k: 'muscle', label: 'Muscle', sub: 'Moderate reps (about 3x10). Shorter rests.' },
      { k: 'general', label: 'General fitness', sub: 'Higher reps (about 3x12), lighter load.' },
    ];
    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Gym session</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">Pick a goal. It sets the reps and load.</div>
        ${GOALS.map(g => `
          <button class="sg-gym-goal" data-goal="${g.k}" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">${g.label}</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">${g.sub}</div>
          </button>`).join('')}
        <button id="sg-gym-goal-back" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">Back</button>
      ${modalShellClose()}
    `;
    document.getElementById('sg-gym-goal-back')?.addEventListener('click', () => { gymStep = 'focus'; render(); });
    modal.querySelectorAll('.sg-gym-goal').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedGymGoal = (btn as HTMLElement).dataset.goal as GymGoal;
        gymStep = 'rest';
        render();
      });
    });
  }

  function renderGymRestStyle() {
    const STYLES: Array<{ k: GymRestStyle; label: string; sub: string }> = [
      { k: 'traditional', label: 'Straight sets', sub: 'Full rest between sets.' },
      { k: 'circuit', label: 'Circuit', sub: 'Short rests. Keep moving between exercises.' },
    ];
    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Gym session</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">How do you want to pace it?</div>
        ${STYLES.map(t => `
          <button class="sg-gym-rest" data-rest="${t.k}" style="${tilePickerStyle()}">
            <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">${t.label}</div>
            <div style="font-size:12px;color:var(--c-muted);line-height:1.45">${t.sub}</div>
          </button>`).join('')}
        <button id="sg-gym-rest-back" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">Back</button>
      ${modalShellClose()}
    `;
    document.getElementById('sg-gym-rest-back')?.addEventListener('click', () => { gymStep = 'goal'; render(); });
    modal.querySelectorAll('.sg-gym-rest').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedGymRestStyle = (btn as HTMLElement).dataset.rest as GymRestStyle;
        gymStep = 'preview';
        render();
      });
    });
  }

  // Preview screen. Running / Lower use the phase- and ability-matched templates;
  // Upper / Full use the goal-driven pool (injury-aware: returns [] when an injury
  // pauses loaded strength).
  function renderGymSession() {
    const phase = (s.wks?.[(s.w ?? 1) - 1]?.ph as TrainingPhase) ?? 'base';
    const fitnessLevel = s.onboarding?.experienceLevel ?? 'intermediate';
    // Beginners/novices never get the heavy @80% running-strength pool — mirrors
    // the gym.ts gate (total_beginner/beginner → bodyweight; novice/returning →
    // light templates). They route through generateGymWorkouts instead.
    const isBeginnerOrNovice = ['total_beginner', 'beginner', 'novice', 'returning'].includes(fitnessLevel);
    const focus = selectedGymFocus ?? 'running';
    // Injury wins over the chosen focus: when loaded strength is paused/adapted,
    // the session is the rehab one and the time/intensity controls are hidden.
    const inj = injuryStrengthDecision(s.injuryState ?? null);
    const injured = inj.kind !== 'normal';
    let wo: Workout | undefined;
    if (focus === 'hyrox') {
      // A HYROX brick combines running with loaded stations; it can't be made
      // injury-safe (you can't half a brick), so suppress it when injured —
      // never prescribe a run when running is blocked. Time → targetMinutes,
      // intensity → station band.
      wo = injured ? undefined : generateHyroxBrick({
        kind: 'brick',
        targetMinutes: selectedGymMinutes,
        band: hyroxBandForIntensity(selectedGymIntensity),
        stationAccess: s.hyroxConfig?.stationAccess ?? { skiErg: true, rowErg: true, sled: 'sometimes' },
        phase,
        slotIndex: s.w ?? 1,
        bodyWeightKg: s.bodyWeightKg ?? 75,
        // The athlete's rulebook tier (format x biological sex x division), so
        // station MTL uses their race loads. Outside HYROX mode there is no
        // config: Open singles plus biological sex.
        loadTier: hyroxLoadTierForState(s),
      });
    } else if (focus === 'running' && !injured && !isBeginnerOrNovice) {
      // World-class running strength: a rotating, balanced, evidence-based pool
      // (varies by week, time scales the exercise count). Owns its own sizing,
      // so it bypasses generateGymWorkouts + tuneGymWorkout. INTERMEDIATE+ ONLY —
      // the pool leads with heavy @80% barbell compounds (§BA), unsafe for a
      // beginner. Beginners/novices fall through to generateGymWorkouts below,
      // which returns their bodyweight-appropriate templates.
      wo = buildRunningStrengthWorkout(s.w ?? 1, selectedGymMinutes, selectedGymIntensity, selectedGymRestStyle, phase, s.plyoInGymEnabled !== false);
    } else if (focus === 'plyometrics' && !injured) {
      // Standalone explosive session from the plyo pool. Low-intensity plyo is
      // safe for everyone, so (unlike running strength) beginners get it too —
      // but clamped to the easier tier, which never serves depth jumps or
      // single-leg bounds. Intensity selects difficulty tier, not load. When
      // injured, plyo is suppressed (it's higher-impact than loaded strength):
      // it falls through to the injury-adapted path below.
      const plyoIntensity: GymIntensity = isBeginnerOrNovice ? 'easier' : selectedGymIntensity;
      // Foot-contact ceiling by ability (literature 80→140 progression): beginners
      // 100, intermediate 120, advanced/competitive 140.
      const plyoCeiling = ['advanced', 'competitive'].includes(fitnessLevel) ? 140 : isBeginnerOrNovice ? 100 : 120;
      wo = buildPlyometricsWorkout(s.w ?? 1, selectedGymMinutes, plyoIntensity, selectedGymRestStyle, phase, plyoCeiling);
    } else {
      // Lower / Upper / Full (goal-driven pool), or the injury-adapted session
      // for any focus (generateGymWorkouts returns it; never tuned).
      const gymList = generateGymWorkouts(
        phase, 1, fitnessLevel, s.w ?? 1, s.tw ?? 18, s.v, s.injuryState ?? null,
        focus, selectedGymGoal ?? undefined, selectedGymRestStyle,
        s.plyoInGymEnabled !== false, s.bodyweightProgress, !!s.continuousMode,
      );
      wo = gymList[0];
      if (wo && !injured) wo = tuneGymWorkout(wo, selectedGymMinutes, selectedGymIntensity);
    }
    const gymBack = () => {
      gymStep = (focus === 'running' || focus === 'plyometrics' || focus === 'hyrox') ? 'focus' : 'rest';
      render();
    };

    const esc = (str: string) => String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // wo.d is a newline-joined list of exercise lines. Render each as its own row so
    // it reads as a session, not a wall of text. Trailing parenthetical (rest / cue)
    // is split onto a muted sub-line where present.
    const exerciseRows = wo ? String(wo.d ?? '').split('\n').filter(l => l.trim()).map(line => {
      const m = line.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      // Keep the "@80% 1RM" load here (unlike the guided session / cards, which
      // strip it): in the generator preview it's the visible signal that the
      // Easier / Harder control is changing the load.
      const main = m ? m[1].trim() : line.trim();
      const note = m ? m[2].trim() : '';
      return `
        <div style="padding:11px 0;border-top:1px solid rgba(0,0,0,0.05)">
          <div style="font-size:13px;color:var(--c-black);line-height:1.4">${esc(main)}</div>
          ${note ? `<div style="font-size:11px;color:var(--c-muted);margin-top:2px;line-height:1.4">${esc(note)}</div>` : ''}
        </div>`;
    }).join('') : '';

    // Time + intensity controls. Shown only for a real (non-rehab) session — the
    // injury-adapted session is fixed. Changing one re-renders the preview live.
    const showTune = !!wo && !injured;
    const tile = (sel: boolean, extra = '') =>
      `flex:1;padding:9px 4px;background:${sel ? '#0F172A' : 'transparent'};color:${sel ? '#fff' : '#0F172A'};border:1px solid ${sel ? '#0F172A' : 'var(--c-border)'};border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--f);${extra}`;
    // Time control: a slider. Plyo is a short, contact-dosed session (12–30 min);
    // other focuses run 20–90. Clamp the stored minutes into the active range so
    // switching focus can't leave the slider out of bounds.
    const isPlyo = focus === 'plyometrics';
    // Plyo is short (12-30); intermediate+ can extend to 60, where time past 30
    // becomes appended strength (a "Power + Strength" session). Beginners stay
    // capped at the pure plyo dose.
    const plyoMax = isBeginnerOrNovice ? 30 : 60;
    const tMin = isPlyo ? 12 : 20, tMax = isPlyo ? plyoMax : 90, tStep = isPlyo ? 2 : 5;
    if (selectedGymMinutes < tMin || selectedGymMinutes > tMax) selectedGymMinutes = isPlyo ? 20 : 45;
    // Snap onto the slider's step grid so the thumb and the state agree (45 is
    // not on plyo's 12+2k grid; the browser would show 46 while we held 45).
    selectedGymMinutes = tMin + Math.round((selectedGymMinutes - tMin) / tStep) * tStep;
    const intensityTiles = ([['easier', 'Easier'], ['standard', 'As prescribed'], ['harder', 'Harder']] as Array<[GymIntensity, string]>)
      .map(([k, label]) => `<button class="sg-gym-inten" data-inten="${k}" style="${tile(selectedGymIntensity === k)}">${label}</button>`).join('');
    const tuneControls = showTune ? `
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
          <span style="font-size:11px;color:var(--c-faint)">How long have you got?</span>
          <span id="sg-gym-time-label" style="font-size:12px;color:var(--c-black);font-weight:600;font-variant-numeric:tabular-nums">${selectedGymMinutes}m</span>
        </div>
        <input type="range" id="sg-gym-time-slider" class="m-slider-glass" min="${tMin}" max="${tMax}" step="${tStep}" value="${selectedGymMinutes}" style="margin:2px 0 14px">
        <div style="font-size:11px;color:var(--c-faint);margin-bottom:6px">Intensity</div>
        <div style="display:flex;gap:6px">${intensityTiles}</div>
      </div>` : '';

    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Gym session</div>
        ${wo ? `
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">${injured ? 'Adapted to your injury.' : 'Matched to your goal and ability. Tune the time and intensity below.'}</div>
          ${renderRecommendationCaption()}
          ${tuneControls}
          <div style="padding:4px 16px 10px;border-radius:14px;background:#fff;border:1px solid rgba(0,0,0,0.06);box-shadow:0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05);margin-bottom:14px">
            <div style="font-size:17px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;padding:14px 0 4px">${esc(wo.n)}</div>
            ${exerciseRows}
          </div>
          <button id="sg-gym-confirm" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Add session</button>
        ` : `
          <div style="font-size:13px;color:var(--c-black);line-height:1.55;margin-bottom:14px;padding:14px;border-radius:12px;background:#fff;border:1px solid rgba(0,0,0,0.06)">${focus === 'hyrox' ? 'A HYROX session includes running, which is paused while you recover. Pick a different focus, or rest the affected area until the injury clears.' : 'Loaded strength is paused while you recover. Focus on the rehab for the affected area until the injury clears.'}</div>
        `}
        <button id="sg-gym-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">Back</button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-gym-back')?.addEventListener('click', gymBack);
    const timeSlider = document.getElementById('sg-gym-time-slider') as HTMLInputElement | null;
    const timeLabel = document.getElementById('sg-gym-time-label');
    // Live label while dragging (cheap textContent); rebuild the session on release.
    timeSlider?.addEventListener('input', () => { if (timeLabel) timeLabel.textContent = `${timeSlider.value}m`; });
    timeSlider?.addEventListener('change', () => {
      selectedGymMinutes = Number(timeSlider.value) || selectedGymMinutes;
      renderGymSession();
    });
    modal.querySelectorAll('.sg-gym-inten').forEach(btn => btn.addEventListener('click', () => {
      selectedGymIntensity = (btn as HTMLElement).dataset.inten as GymIntensity;
      renderGymSession();
    }));
    document.getElementById('sg-gym-confirm')?.addEventListener('click', async () => {
      if (!wo) return; // confirm only renders when a session exists
      modal.remove();
      await saveTriAdhoc(wo, 'gym');
    });
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

    // Long runs cap at Steady. Threshold pace for 20+ km is race simulation, not training.
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
        case 'threshold':     return fpModel(s.pac.t, up);
        case 'vo2':           return fpModel(s.pac.i, up);
        case 'marathon_pace': return fpModel(s.pac.m, up);
        case 'progressive':   return `${fpModel(s.pac.e, up)} to ${fpModel(s.pac.m, up)}`;
        default:              return fpModel(easyPace, up);
      }
    }

    function renderContent() {
      const isDistance = mode === 'distance';
      const paceForEst = hasEffortPicker ? effortPace : easyPace;
      const distLabel = formatKm(distanceKm, up);
      const estMinutes = isDistance ? Math.round(distanceKm * paceForEst / 60) : timeMin;
      const estKm = isDistance ? distanceKm : Math.round(timeMin * 60 / paceForEst);

      // Structured sessions already show target pace above the slider. Don't repeat it here.
      const secondaryInfo = hasEffortPicker
        ? (isDistance ? `~${estMinutes} min at ${fpModel(effortPace, up)}` : `~${formatKm(estKm, up)} at ${fpModel(effortPace, up)}`)
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
                    <div style="font-size:11px;color:${sel ? 'rgba(253,252,247,0.65)' : 'var(--c-muted)'}">${fpModel(opt.pace, up)}</div>
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
            ? (isDistance ? `~${estM} min at ${fpModel(pace, up)}` : `~${formatKm(estK, up)} at ${fpModel(pace, up)}`)
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
        // Persisted objects never regenerate, so the chosen effort pace is
        // embedded in the description (the card's Target row dedupes on it).
        d: correctedKm !== null
          ? `${correctedKm}km @ ${fmtModelPaceKm(effortPace)}/km` // the whole second, as the picker label shows it
          : workout.d,
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

      // Land on the plan view in every mode (on-demand included) so the new
      // session shows as a planned activity, consistent with the gym/bike/swim path.
      import('./main-view').then(({ renderMainView }) => renderMainView());
    });
  }

  // ── Time Trial step ────────────────────────────────────────────────────────

  function renderTimeTrial() {
    const predictions = timeTrialPredictions(s);

    let selectedDist = predictions[0];

    function renderContent() {
      modal.innerHTML = `
        ${modalShellOpen('auto')}
          <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Time Trial</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px;line-height:1.5">Based on your current fitness. Pick a distance.</div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
            ${predictions.map(d => {
              const sel = d.label === selectedDist.label;
              const timeStr = d.predictedSec ? ft(d.predictedSec) : '—';
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
          d: `${selectedDist.km}km race effort${selectedDist.predictedSec ? `. Target: ${ft(selectedDist.predictedSec)}` : ''}`,
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

      // On-demand sessions live on the Plan tab now; renderMainView() shows the
      // track Plan with the new session, so generating lands there for every mode.
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
      // On-demand sessions live on the Plan tab now; renderMainView() shows the
      // track Plan with the new session, so generating lands there for every mode.
      import('./main-view').then(({ renderMainView }) => renderMainView());
      }
    });
  }

  // ── Entry: Suggested vs Pick your own (running / fitness incl. Just-Track) ──
  // The chooser only fronts the single-discipline run/fitness flow. Tri opens
  // straight to its discipline picker (step 0) and hyrox returned to renderVibes
  // above — recovery can't choose a discipline, so a cross-discipline auto-
  // suggestion would be guesswork.
  function renderEntryChoice() {
    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">Add a session</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">How do you want to start?</div>
        ${renderRecommendationCaption()}

        <button id="sg-entry-suggested" style="${tilePickerStyle()}">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">Suggested session</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.45">We read your recovery and pick the effort and duration. Adjust anything before adding it.</div>
        </button>
        <button id="sg-entry-pick" style="${tilePickerStyle()}">
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:3px">Pick your own</div>
          <div style="font-size:12px;color:var(--c-muted);line-height:1.45">${hasDisciplinePicker ? 'Choose a discipline (run, gym, bike or swim) and set it up yourself.' : 'Browse every session type and set it up yourself.'}</div>
        </button>

        <button id="sg-entry-cancel" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-top:10px">Cancel</button>
      ${modalShellClose()}
    `;
    document.getElementById('sg-entry-suggested')?.addEventListener('click', () => renderSuggestion());
    document.getElementById('sg-entry-pick')?.addEventListener('click', () => { step = hasDisciplinePicker ? 0 : 1; render(); });
    document.getElementById('sg-entry-cancel')?.addEventListener('click', () => modal.remove());
  }

  // ── Suggested session card ─────────────────────────────────────────────────
  // Concrete typed session built from the recovery read. Effort comes from
  // sessionRec.recommendedSlot (readiness/ACWR/HRV/sleep composite); the type is
  // mapped via SUGGESTED_SLOT_BY_EFFORT; the duration is the type's own default.
  // Nothing invented here. With no recovery data yet we fall back to the lowest-
  // risk option (Easy Run) rather than the band default, since suggesting a
  // structured session to someone we know nothing about is the wrong default.
  function renderSuggestion() {
    const effort: 'easy' | 'steady' | 'hard' =
      sessionRec.readinessScore == null ? 'easy' : sessionRec.recommendedSlot;

    // The run stays the suggestion. On a genuine low-recovery read (not just "no
    // data yet") we nudge a lower-impact swap rather than overriding it. The swaps
    // (easy bike, or easy gym when strength is in the plan) are always offered.
    const lowRecovery = effort === 'easy' && sessionRec.readinessScore != null;
    const planHasStrength = (s.gs ?? 0) > 0;
    const phaseNow = (s.wks?.[(s.w ?? 1) - 1]?.ph as TrainingPhase) ?? 'base';
    const fitLevel = s.onboarding?.experienceLevel ?? 'intermediate';
    const buildEasyBike = () => generateBikeSession({
      phase: phaseNow, skill: (s.triConfig?.skillRating?.bike ?? 3) as 1 | 2 | 3 | 4 | 5,
      weekIndex: s.w ?? 1, totalWeeks: s.tw ?? 18, targetMinutes: 45, kind: 'endurance',
      ftp: s.triConfig?.bike?.ftp, hasPowerMeter: !!s.triConfig?.bike?.ftp,
    });
    const buildEasyGym = () => generateGymWorkouts(
      phaseNow, 2, fitLevel, s.w ?? 1, s.tw ?? 18, s.v, s.injuryState ?? null,
      'running', undefined, 'traditional', s.plyoInGymEnabled !== false, s.bodyweightProgress,
      !!s.continuousMode,
    )[0];

    const slot = SUGGESTED_SLOT_BY_EFFORT[effort];
    const type = SESSION_TYPES.find(t => t.slot === slot) ?? SESSION_TYPES[0];
    const mins = type.defaultMinutes;
    const km = Math.round(mins * 60 / easyPace);

    // One-line "why this session", framed off the effort band. Qualitative, no
    // numbers — the readiness caption above already carries the score.
    const whyLine =
      effort === 'easy' ? 'Recovery signals are low. Keep it aerobic and easy today.'
      : effort === 'steady' ? 'Recovery is moderate. A controlled progressive run fits today.'
      : 'Recovery is strong. You can absorb a threshold session today.';

    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:10px;line-height:1.5">Suggested for today</div>

        <div style="padding:16px;border-radius:14px;background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);box-shadow:0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.4);margin-bottom:14px">
          <div style="font-size:20px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${type.label}</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:10px;font-variant-numeric:tabular-nums">${mins} min · ${formatKm(km, up)}</div>
          ${sessionRec.caption ? `<div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:6px">${String(sessionRec.caption).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>` : ''}
          <div style="font-size:13px;color:var(--c-black);line-height:1.5">${whyLine}</div>
        </div>

        ${lowRecovery ? `<div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:10px">Recovery is low. An easy bike${planHasStrength ? ' or gym session' : ''} is a lower-impact swap today.</div>` : ''}
        <button id="sg-sugg-accept" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Accept</button>
        <button id="sg-sugg-adjust" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Adjust</button>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button id="sg-sugg-swap-bike" style="flex:1;padding:11px 8px;background:transparent;border:1px solid var(--c-border);border-radius:10px;color:var(--c-black);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">Swap for an easy bike</button>
          ${planHasStrength ? `<button id="sg-sugg-swap-gym" style="flex:1;padding:11px 8px;background:transparent;border:1px solid var(--c-border);border-radius:10px;color:var(--c-black);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">Swap for easy gym</button>` : ''}
        </div>
        <button id="sg-sugg-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">Back</button>
      ${modalShellClose()}
    `;

    document.getElementById('sg-sugg-back')?.addEventListener('click', () => renderEntryChoice());
    document.getElementById('sg-sugg-swap-bike')?.addEventListener('click', () => {
      const wo = buildEasyBike();
      if (wo) renderRecoverySuggestion(wo, 'bike');
    });
    document.getElementById('sg-sugg-swap-gym')?.addEventListener('click', () => {
      const wo = buildEasyGym();
      if (wo) renderRecoverySuggestion(wo, 'gym');
    });

    // Adjust: pre-select the suggested type and drop into its normal setup step
    // (duration / effort), so the user tweaks this exact session rather than
    // restarting from the type list.
    document.getElementById('sg-sugg-adjust')?.addEventListener('click', () => {
      selectedType = type;
      step = 2;
      render();
    });

    // Accept: commit the suggested session. Mirrors renderStep2's non-effort
    // save path exactly (same buildSessionIntent → intentToWorkout → adhoc push).
    document.getElementById('sg-sugg-accept')?.addEventListener('click', () => {
      modal.remove();
      const workMinutes = Math.round(mins * type.workRatio);
      const weekIdx = s.w || 1;
      const intent = buildSessionIntent(type.slot as SlotType, mins, workMinutes, weekIdx);
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

      // Land on the plan view in every mode (on-demand included) so the new
      // session shows as a planned activity, consistent with the gym/bike/swim path.
      import('./main-view').then(({ renderMainView }) => renderMainView());
    });
  }

  /** Low-recovery alternative card: a pre-built strength or easy-bike session
   *  (built by `renderSuggestion`'s diversion). Accept saves it; Adjust drops into
   *  that discipline's setup; "Rather run?" forces the run suggestion. */
  function renderRecoverySuggestion(wo: Workout, disc: 'gym' | 'bike') {
    // Recovery-agnostic copy: the swap is reachable on any day (the low-recovery
    // nudge lives on the run card), so this card must not claim recovery is low.
    const why = disc === 'gym'
      ? 'A strength session keeps training productive without the impact of a run.'
      : 'An easy bike holds the aerobic stimulus and takes the pounding off your legs.';
    const dur = (wo as { estimatedDurationMin?: number }).estimatedDurationMin;
    const esc = (str: string) => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const previewLines = String(wo.d ?? '').split('\n').filter(l => l.trim()).slice(0, 3)
      .map(l => `<div style="font-size:12px;color:var(--c-muted);line-height:1.5">${esc(l)}</div>`).join('');
    modal.innerHTML = `
      ${modalShellOpen()}
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:10px;line-height:1.5">Suggested for today</div>
        <div style="padding:16px;border-radius:14px;background:rgba(255,255,255,0.95);border:1px solid rgba(0,0,0,0.06);box-shadow:0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.4);margin-bottom:14px">
          <div style="font-size:20px;font-weight:700;color:var(--c-black);letter-spacing:-0.01em;margin-bottom:4px">${esc(wo.n)}</div>
          ${dur ? `<div style="font-size:13px;color:var(--c-muted);margin-bottom:10px;font-variant-numeric:tabular-nums">${dur} min</div>` : ''}
          <div style="font-size:13px;color:var(--c-black);line-height:1.5;margin-bottom:8px">${why}</div>
          ${previewLines}
        </div>
        <button id="sg-rsug-accept" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Accept</button>
        <button id="sg-rsug-adjust" class="m-btn-glass m-btn-glass--inset" style="width:100%;margin-bottom:8px">Adjust</button>
        <button id="sg-rsug-back" class="m-btn-glass m-btn-glass--inset" style="width:100%">Back</button>
        <button id="sg-rsug-run" style="width:100%;margin-top:12px;font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;font-family:var(--f)">Back to the run suggestion →</button>
      ${modalShellClose()}
    `;
    document.getElementById('sg-rsug-back')?.addEventListener('click', () => renderEntryChoice());
    document.getElementById('sg-rsug-run')?.addEventListener('click', () => renderSuggestion());
    document.getElementById('sg-rsug-accept')?.addEventListener('click', async () => {
      modal.remove();
      await saveTriAdhoc(wo, disc);
    });
    document.getElementById('sg-rsug-adjust')?.addEventListener('click', () => {
      if (disc === 'gym') { selectedDiscipline = 'gym'; selectedGymFocus = 'running'; gymStep = 'preview'; render(); }
      else { selectedDiscipline = 'bike'; step = 1; render(); }
    });
  }

  // Running / fitness (incl. Just-Track) open with the chooser; tri goes
  // straight to its discipline picker.
  if (isTri) render();
  else renderEntryChoice();
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
