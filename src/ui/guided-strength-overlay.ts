/**
 * Guided strength-session overlay. Full-screen modal driven by
 * `StrengthGuideController`: shows the current exercise, an auto rest
 * countdown between sets, the elapsed clock, voice + haptic cues, and a
 * 1-tap RPE on finish. Mode-agnostic. Any strength card (running / tri /
 * HYROX) can launch it.
 *
 * Reuses the existing guided primitives: `VoiceCoach` (voice cues),
 * `enableScreenAwake` / `disableScreenAwake`, and `completeStrengthSession`
 * for the completion write. Haptics use `navigator.vibrate` with a try/catch
 * (web; native iOS no-ops gracefully. Voice covers it).
 *
 * UX: vertically centered per `docs/UX_PATTERNS.md → Overlays and Modals`.
 */

import type { Workout } from '@/types';
import type { HyroxComponent } from '@/types/triathlon';
import { parseGuidedSession, type GuidedSet, type StrengthSession } from '@/guided/strength-model';
import { StrengthGuideController, type StrengthCueEvent } from '@/guided/strength-controller';
import { VoiceCoach } from '@/guided/voice';
import { enableScreenAwake, disableScreenAwake } from '@/guided/keep-awake';
import { completeStrengthSession } from '@/guided/strength-complete';
import { GpsTracker } from '@/gps/tracker';
import { createGpsProvider } from '@/gps/providers';
import { formatKm, formatPace } from '@/utils/format';
import { getState } from '@/state/store';
import { summariseHyroxSession, summariseHyroxRuns } from '@/calculations/hyrox-session-benchmarks';
import type { SetRecord } from '@/guided/strength-controller';
import type { TrainingPhase } from '@/types/training';
import type { RirBucket } from '@/types/strength-log';
import { suggestNextWeight } from '@/calculations/strength-progression';
import { STRENGTH_MIN_INCREMENT_KG } from '@/constants/strength-constants';
import { applyRememberedSwaps } from '@/state/strength-swaps';

const OVERLAY_ID = 'guided-strength-overlay';

type GpsState = 'off' | 'acquiring' | 'tracking' | 'denied';

interface OverlayState {
  workout: Workout;
  session: StrengthSession;
  controller: StrengthGuideController;
  voice: VoiceCoach;
  cuesOn: boolean;
  finished: boolean;
  finishRpe: number | null;
  onClose?: () => void;
  // ── GPS bridge for HYROX run components ──
  /** Tracker is created once per session when the workout has at least one
   *  run component; null for strength-only sessions or when GPS init failed. */
  gps: GpsTracker | null;
  /** Status surfaced to the UI so the user knows whether auto-advance is live. */
  gpsState: GpsState;
  /** Tracker.totalDistance reading at the moment the current run set entered
   *  `active`. We auto-advance when `totalDistance - baseline >= component.distanceM`. */
  runDistanceBaseline: number;
  /** The currently-active run component, or null when the active set is a
   *  station / strength set. Cleared on every non-run setStart and on auto-fire. */
  activeRun: HyroxComponent | null;
  // ── Strength weight capture ──
  /** Per-exercise working weight + RIR the user entered, keyed by exerciseIndex.
   *  Merged onto the SetRecords at finish. The controller stays weight-agnostic. */
  exerciseInputs: Map<number, { weightKg?: number; rirBucket?: RirBucket }>;
  /** Per-exercise pre-computed last/suggested weight, keyed by exerciseIndex. */
  suggestions: Map<number, ExerciseSuggestion>;
}

interface ExerciseSuggestion {
  liftKey: string;
  lastWeightKg?: number;
  lastReps?: string;
  suggestedKg?: number;
  bumped?: boolean;
}

let active: OverlayState | null = null;

/** Open the guided strength overlay for a workout. */
export function openGuidedStrength(workout: Workout, opts: { onClose?: () => void } = {}): void {
  // Single active overlay at a time.
  if (active) closeOverlay();

  // Honour the user's remembered equipment swaps wherever a session is started
  // (the pre-session modal, the tri/HYROX detail modals, the home hero). No-op
  // for HYROX (parsed from components) and for sessions with no swapped lines.
  workout = applyRememberedSwaps(workout);

  const session = parseGuidedSession(workout);
  if (!session || session.sets.length === 0) {
    // Nothing to guide; just no-op (caller can fall back to mark-done).
    return;
  }

  const voice = new VoiceCoach();
  const controller = new StrengthGuideController(session, {
    onCue: (e) => handleCue(e),
    manualAdvance: session.manualAdvance === true,
  });

  const suggestions = buildExerciseSuggestions(session, workout);
  const exerciseInputs = new Map<number, { weightKg?: number; rirBucket?: RirBucket }>();
  // Pre-seed the suggested weight so a user who lifts the suggestion gets it
  // logged without touching the stepper. First-timers (no suggestion) stay blank.
  for (const [exIdx, sug] of suggestions) {
    if (sug.suggestedKg != null) exerciseInputs.set(exIdx, { weightKg: sug.suggestedKg });
  }

  active = {
    workout,
    session,
    controller,
    voice,
    cuesOn: true,
    finished: false,
    finishRpe: null,
    onClose: opts.onClose,
    gps: null,
    gpsState: 'off',
    runDistanceBaseline: 0,
    activeRun: null,
    exerciseInputs,
    suggestions,
  };

  mount();
  void enableScreenAwake().catch(() => {});
  // Spin up GPS before controller.start() so the tracker reference is in place
  // when the synchronous setStart cue fires for the first set.
  startGpsIfRunsPresent();
  // 3-2-1 "get ready" countdown before the first set goes active, instead of
  // dropping the user straight into a live set. start() emits countdownStart
  // synchronously, so handleCue swaps mount()'s first render for renderCountdown
  // before the browser paints (no flash of the active view).
  controller.start(INITIAL_COUNTDOWN_SECONDS);
}

/** Pre-session "get ready" countdown before the first set. Tristan: 3-2-1. */
const INITIAL_COUNTDOWN_SECONDS = 3;

// ─── GPS bridge for HYROX run components ─────────────────────────────────────

/** True if the workout has at least one run-typed hyroxComponent. */
function hasRunComponents(workout: Workout): boolean {
  const components = (workout as any).hyroxComponents as HyroxComponent[] | undefined;
  return Array.isArray(components) && components.some(c => c.type === 'run' && (c.distanceM ?? 0) > 0);
}

/** Look up the HyroxComponent that backs the currently-active set, if any. */
function getActiveRunComponent(): HyroxComponent | null {
  if (!active) return null;
  const components = (active.workout as any).hyroxComponents as HyroxComponent[] | undefined;
  if (!components) return null;
  const cur = active.controller.currentSet();
  if (!cur) return null;
  const c = components[cur.exerciseIndex];
  return (c && c.type === 'run' && (c.distanceM ?? 0) > 0) ? c : null;
}

/**
 * Start a GPS tracker for the whole session when at least one component is a
 * run. Errors and permission denials degrade gracefully to fully-manual mode —
 * the controller still works exactly as before; the user just taps "Complete
 * set" themselves when they finish each run.
 */
function startGpsIfRunsPresent(): void {
  if (!active) return;
  if (!hasRunComponents(active.workout)) return;
  try {
    const provider = createGpsProvider();
    const tracker = new GpsTracker(provider);
    active.gps = tracker;
    active.gpsState = 'acquiring';
    tracker.onUpdate(() => onGpsUpdate());
    void tracker.start().then(ok => {
      if (!active) return;
      if (!ok) {
        active.gps = null;
        active.gpsState = 'denied';
        // Re-render so the user sees the "manual mode" hint.
        if (active.controller.phase === 'active') renderActive();
      }
    }).catch(() => {
      if (!active) return;
      active.gps = null;
      active.gpsState = 'denied';
      if (active.controller.phase === 'active') renderActive();
    });
  } catch {
    if (active) { active.gps = null; active.gpsState = 'denied'; }
  }
}

function stopGps(): void {
  if (!active?.gps) return;
  try { active.gps.stop(); } catch { /* no-op */ }
  active.gps = null;
}

/**
 * Called on every GPS live-data update. When the active set is a run with a
 * prescribed distance, fire `completeSet()` once the delta from the run's
 * baseline reaches the target. Also patches the inline distance/pace readout.
 */
function onGpsUpdate(): void {
  if (!active?.gps) return;
  const live = active.gps.getLiveData();
  if (active.gpsState === 'acquiring' && live.status === 'tracking') {
    active.gpsState = 'tracking';
  }
  if (!active.activeRun) return;
  const target = active.activeRun.distanceM ?? 1000;
  const delta = Math.max(0, live.totalDistance - active.runDistanceBaseline);
  patchRunReadout(delta, target, live.currentPace ?? 0);
  if (delta >= target) {
    // Clear first so a redundant update can't double-fire.
    active.activeRun = null;
    active.controller.completeSet();
  }
}

function patchRunReadout(delta: number, target: number, secPerKm: number): void {
  if (!active) return;
  const node = document.getElementById('gs-run-readout');
  if (!node) return;
  node.innerHTML = buildRunReadoutInner(delta, target, secPerKm);
}

/**
 * Outer block shown in `renderActive` when the active set is a run component.
 * Returns an empty string for stations / strength so the existing layout is
 * unaffected. The inner readout starts at 0 / target /. And is patched on
 * GPS updates and ticks.
 */
function renderRunReadoutBlock(): string {
  if (!active?.activeRun) return '';
  const target = active.activeRun.distanceM ?? 1000;
  const live = active.gps?.getLiveData();
  const delta = live ? Math.max(0, live.totalDistance - active.runDistanceBaseline) : 0;
  const pace = live?.currentPace ?? 0;
  const hint = active.gpsState === 'tracking'
    ? 'Auto-advances when the distance is reached.'
    : active.gpsState === 'acquiring'
      ? 'GPS searching… you can tap Complete set to advance manually.'
      : active.gpsState === 'denied'
        ? 'GPS unavailable. Tap Complete set when you finish the run.'
        : '';
  return `
    <div style="background:rgba(15,23,42,0.04);border-radius:12px;padding:12px 14px;margin-bottom:18px">
      <div id="gs-run-readout">${buildRunReadoutInner(delta, target, pace)}</div>
      ${hint ? `<div style="font-size:11px;color:var(--c-muted);margin-top:8px;line-height:1.4">${hint}</div>` : ''}
    </div>`;
}

function buildRunReadoutInner(delta: number, target: number, secPerKm: number): string {
  const unit = getState().unitPref ?? 'km';
  const targetKm = target / 1000;
  const deltaKm = delta / 1000;
  const paceStr = secPerKm > 0 ? formatPace(secPerKm, unit) : '—';
  const distStr = `${formatKm(deltaKm, unit, 2)} / ${formatKm(targetKm, unit, targetKm % 1 === 0 ? 0 : 1)}`;
  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px;color:#0F172A;font-variant-numeric:tabular-nums">
      <span style="color:var(--c-muted);font-size:11px">Distance</span>
      <span style="font-weight:600">${distStr}</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px;color:#0F172A;font-variant-numeric:tabular-nums;margin-top:4px">
      <span style="color:var(--c-muted);font-size:11px">Pace</span>
      <span style="font-weight:600">${paceStr}</span>
    </div>`;
}

// ─── Strength weight capture (stepper + RIR) ─────────────────────────────────

/**
 * Pre-compute, per trackable exercise, the last working weight and the phase-
 * aware suggested weight for this session. Suggestion holds in peak/taper/deload
 * and only bumps in base/build when the last session left reps in reserve. The
 * displayed lifts are loaded templates (injury sessions are bodyweight and carry
 * no liftKey), so injuryKind is 'normal' here.
 */
function buildExerciseSuggestions(session: StrengthSession, workout: Workout): Map<number, ExerciseSuggestion> {
  const s = getState();
  const wk = s.wks?.[(s.w ?? 1) - 1];
  const phase = (wk?.ph as TrainingPhase) ?? 'base';
  const isDeload = phase === 'taper' || !!(wk as any)?.forceDeload || /\(deload\)/i.test(workout.n || '');
  const lifts = s.strengthLog?.lifts ?? {};

  const out = new Map<number, ExerciseSuggestion>();
  const seen = new Set<number>();
  for (const set of session.sets) {
    if (seen.has(set.exerciseIndex)) continue;
    seen.add(set.exerciseIndex);
    if (!set.liftKey) continue;
    const entry = lifts[set.liftKey];
    if (!entry) { out.set(set.exerciseIndex, { liftKey: set.liftKey }); continue; }
    const sug = suggestNextWeight({
      lastWeightKg: entry.lastWeightKg,
      lastRir: entry.lastRir,
      phase,
      isDeload,
      injuryKind: 'normal',
    });
    out.set(set.exerciseIndex, {
      liftKey: set.liftKey,
      lastWeightKg: entry.lastWeightKg,
      lastReps: entry.lastReps,
      suggestedKg: sug.weightKg,
      bumped: sug.changed,
    });
  }
  return out;
}

/** "62.5kg" / "60kg" — drop a trailing .0. */
function fmtKg(kg: number): string {
  return `${trimNum(kg)}kg`;
}

/**
 * First-time guidance: with no weight history, tell the user how hard it should
 * feel so they can pick a starting load. Anchored to the project's RIR-2
 * autoregulation target (Helms et al. 2016): the working set should leave ~2
 * reps in reserve, so an all-out set would be ~reps+2. No 1RM needed.
 */
function firstTimeWeightCue(reps: string): string {
  const m = reps.match(/(\d+)/);
  if (!m) return 'First time. Pick a weight that is challenging but stays controlled.';
  const n = Number(m[1]);
  return `First time. Choose a weight you could lift about ${n + 2} times all-out, so ${n} reps feels hard with 2 left in reserve.`;
}
function trimNum(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/**
 * Weight stepper (first set) or read-only working-weight line (later sets), plus
 * the one-tap RIR row on the final set of a trackable exercise. Returns '' for
 * non-trackable movements and HYROX (no liftKey).
 */
function renderWeightBlock(cur: GuidedSet): string {
  if (!active || !cur.liftKey) return '';
  const exIdx = cur.exerciseIndex;
  const input = active.exerciseInputs.get(exIdx);
  const sug = active.suggestions.get(exIdx);
  const curWeight = input?.weightKg;
  const isFirstSet = cur.setIndex === 0;
  const isLastSet = cur.setIndex === cur.setCount - 1;

  // The stepper is editable on EVERY set, so the weight can be adjusted as you
  // go (corrected mid-exercise, dropped for a back-off set, etc.). The rich
  // last/suggested caption only shows on the first set; later sets get a short
  // label so the control stays compact.
  const caption = isFirstSet
    ? (sug?.lastWeightKg
        ? `Last time: ${fmtKg(sug.lastWeightKg)}${sug.lastReps ? ` × ${escapeHtml(sug.lastReps)}` : ''}${sug.bumped && sug.suggestedKg != null ? ` · suggested ${fmtKg(sug.suggestedKg)}` : ''}`
        : firstTimeWeightCue(cur.reps))
    : `Working weight · set ${cur.setIndex + 1} of ${cur.setCount}`;
  const val = curWeight != null ? trimNum(curWeight) : '';
  let html = `
      <div style="margin-bottom:16px">
        <div style="font-size:12px;color:var(--c-muted);margin-bottom:8px">${caption}</div>
        <div style="display:flex;align-items:center;gap:10px">
          <button id="gs-w-minus" aria-label="Decrease weight" style="width:44px;height:44px;flex-shrink:0;background:transparent;border:1px solid var(--c-border);border-radius:10px;font-size:20px;font-weight:600;color:#0F172A;cursor:pointer;font-family:var(--f)">−</button>
          <div style="flex:1;display:flex;align-items:baseline;justify-content:center;gap:5px;border:1px solid var(--c-border);border-radius:10px;padding:8px 10px">
            <input id="gs-w-input" inputmode="decimal" value="${val}" placeholder="—" aria-label="Working weight in kilograms" style="width:72px;text-align:right;border:none;background:transparent;font-size:22px;font-weight:700;color:#0F172A;font-variant-numeric:tabular-nums;font-family:var(--f);outline:none"/>
            <span style="font-size:14px;color:var(--c-muted)">kg</span>
          </div>
          <button id="gs-w-plus" aria-label="Increase weight" style="width:44px;height:44px;flex-shrink:0;background:transparent;border:1px solid var(--c-border);border-radius:10px;font-size:20px;font-weight:600;color:#0F172A;cursor:pointer;font-family:var(--f)">+</button>
        </div>
      </div>`;

  if (isLastSet) html += renderRirRow(exIdx, input?.rirBucket);
  return html;
}

function renderRirRow(exIdx: number, selected: RirBucket | undefined): string {
  const opts: Array<[RirBucket, string]> = [
    ['reps-left', 'Had reps left'],
    ['about-right', 'About right'],
    ['barely', 'Barely'],
  ];
  const btns = opts.map(([k, label]) => {
    const sel = selected === k;
    return `<button class="gs-rir" data-rir="${k}" style="flex:1;padding:10px 4px;background:${sel ? '#0F172A' : 'transparent'};color:${sel ? '#FAF9F6' : '#0F172A'};border:1px solid ${sel ? '#0F172A' : 'var(--c-border)'};border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;font-family:var(--f);line-height:1.2">${label}</button>`;
  }).join('');
  return `
    <div style="margin-bottom:16px" data-ex="${exIdx}">
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:8px">How did the last set feel?</div>
      <div style="display:flex;gap:6px">${btns}</div>
    </div>`;
}

/** Wire the stepper + RIR controls after renderActive sets innerHTML. */
function wireWeightControls(cur: GuidedSet): void {
  if (!active || !cur.liftKey) return;
  const exIdx = cur.exerciseIndex;
  const input = document.getElementById('gs-w-input') as HTMLInputElement | null;

  const store = (patch: { weightKg?: number; rirBucket?: RirBucket }) => {
    const prev = active!.exerciseInputs.get(exIdx) ?? {};
    active!.exerciseInputs.set(exIdx, { ...prev, ...patch });
  };
  const readInput = (): number | undefined => {
    if (!input) return undefined;
    const n = parseFloat(input.value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  input?.addEventListener('input', () => store({ weightKg: readInput() }));

  const adjust = (delta: number) => {
    const base = readInput() ?? 0;
    const v = Math.max(0, Math.round((base + delta) * 100) / 100);
    const out = v > 0 ? v : undefined;
    if (input) input.value = out != null ? trimNum(out) : '';
    store({ weightKg: out });
  };
  document.getElementById('gs-w-minus')?.addEventListener('click', () => adjust(-STRENGTH_MIN_INCREMENT_KG));
  document.getElementById('gs-w-plus')?.addEventListener('click', () => adjust(STRENGTH_MIN_INCREMENT_KG));

  // Restyle the RIR buttons in place rather than re-rendering the whole active
  // screen — a full renderActive() would wipe a half-typed weight and flash the
  // live clocks. Mirrors the in-place RPE restyle on the finish screen.
  const restyleRir = (sel: RirBucket) => {
    document.querySelectorAll<HTMLButtonElement>('.gs-rir').forEach(b => {
      const isSel = b.dataset.rir === sel;
      b.style.background = isSel ? '#0F172A' : 'transparent';
      b.style.color = isSel ? '#FAF9F6' : '#0F172A';
      b.style.borderColor = isSel ? '#0F172A' : 'var(--c-border)';
    });
  };
  document.querySelectorAll<HTMLButtonElement>('.gs-rir').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.rir as RirBucket;
      store({ rirBucket: k });
      restyleRir(k);
    });
  });
}

// ─── Cue handler (DOM updates + voice + haptics) ─────────────────────────────

function handleCue(e: StrengthCueEvent): void {
  if (!active) return;

  if (e.type === 'setStart' && e.set) {
    // HYROX bridge: if this set maps to a run component, take the current GPS
    // baseline so auto-advance fires once the prescribed distance is run.
    // Stations / strength sets clear activeRun, so onGpsUpdate is a no-op.
    const runC = getActiveRunComponent();
    active.activeRun = runC;
    if (runC && active.gps) {
      active.runDistanceBaseline = active.gps.getLiveData().totalDistance;
    }
    speak(`Next: ${e.set.exerciseName}`);
    renderActive();
    return;
  }
  if (e.type === 'restStart' && e.set) {
    active.activeRun = null;
    speak(`Rest ${e.restRemainingSec ?? 0} seconds`);
    renderResting();
    return;
  }
  if (e.type === 'pauseStart') {
    active.activeRun = null;
    pulse([80, 60, 80]);
    speak(`Station logged. Start when you're ready.`);
    renderPaused();
    return;
  }
  if (e.type === 'countdownStart') {
    speak('Get ready');
    renderCountdown();
    return;
  }
  if (e.type === 'restEnd') {
    pulse([80, 60, 80]);
    return;
  }
  if (e.type === 'tick') {
    patchClocks();
    return;
  }
  if (e.type === 'complete') {
    active.activeRun = null;
    stopGps();
    speak('Session complete');
    pulse([120, 60, 120]);
    active.finished = true;
    renderFinish();
    return;
  }
}

// ─── Mount / unmount ─────────────────────────────────────────────────────────

function mount(): void {
  removeNode();
  const node = document.createElement('div');
  node.id = OVERLAY_ID;
  node.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  node.style.background = 'rgba(0,0,0,0.55)';
  document.body.appendChild(node);
  renderActive();
}

function removeNode(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

export function closeOverlay(): void {
  if (!active) { removeNode(); return; }
  active.controller.destroy();
  active.voice.cancel();
  stopGps();
  void disableScreenAwake().catch(() => {});
  const onClose = active.onClose;
  active = null;
  removeNode();
  onClose?.();
}

// ─── Renders ────────────────────────────────────────────────────────────────

function shellOpen(headerRight: string): string {
  return `
    <div style="
      background:#fff;
      width:100%;max-width:520px;
      max-height:92vh;overflow-y:auto;
      border-radius:20px;
      box-shadow:0 10px 40px rgba(0,0,0,0.3);
      position:relative;
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 6px">
        ${headerRight}
        <button id="gs-close" style="width:32px;height:32px;background:transparent;border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted)" aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>`;
}

function shellClose(): string { return `</div>`; }

function muteButton(cuesOn: boolean): string {
  const label = cuesOn ? 'Mute' : 'Unmute';
  const icon = cuesOn
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19 12a4 4 0 0 0-2.2-3.6"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
  return `
    <button id="gs-mute" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:6px 4px">
      ${icon}<span>${label}</span>
    </button>`;
}

function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Row of per-exercise progress rings. Fill = sets done / sets in that exercise;
 * the exercise currently active (or just rested from) carries a small indicator
 * dot. Visual-only: the fill is the indicator, no in-ring text. Re-renders on
 * setStart and restEnd via the existing render paths; mid-tick state never
 * changes which set is done, so no per-tick patching is needed.
 */
function renderProgressRings(): string {
  if (!active) return '';
  const totalDone = active.controller.completedSets;
  const curEx = active.controller.currentSet()?.exerciseIndex;

  // Group sets by exercise, in order.
  const counts: number[] = [];
  for (const s of active.session.sets) {
    counts[s.exerciseIndex] = (counts[s.exerciseIndex] ?? 0) + 1;
  }

  let consumed = 0;
  const rings: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    const setCount = counts[i] ?? 0;
    const done = Math.max(0, Math.min(setCount, totalDone - consumed));
    consumed += setCount;
    rings.push(buildProgressRing(done, setCount, i === curEx, i + 1));
  }
  if (!rings.length) return '';
  return `<div role="list" aria-label="Exercise progress" style="display:flex;gap:10px;justify-content:center;align-items:flex-start;margin:4px 0 18px;flex-wrap:wrap">${rings.join('')}</div>`;
}

function buildProgressRing(done: number, total: number, isCurrent: boolean, label: number): string {
  const r = 13;
  const circumference = 2 * Math.PI * r;
  const fraction = total > 0 ? done / total : 0;
  const offset = circumference * (1 - fraction);
  const accent = '#0F172A';
  const aria = `Exercise ${label}: ${done} of ${total} sets done${isCurrent ? ', current' : ''}`;
  const indicatorDot = isCurrent
    ? `<circle cx="16" cy="34" r="2" fill="${accent}"/>`
    : '';
  return `
    <div role="listitem" aria-label="${aria}" style="display:flex;flex-direction:column;align-items:center;width:32px">
      <svg width="32" height="38" viewBox="0 0 32 38" aria-hidden="true">
        <circle cx="16" cy="16" r="${r}" stroke="rgba(0,0,0,0.12)" stroke-width="2.5" fill="none"/>
        <circle cx="16" cy="16" r="${r}" stroke="${accent}" stroke-width="2.5" fill="none"
          stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
          transform="rotate(-90 16 16)" stroke-linecap="round"/>
        ${indicatorDot}
      </svg>
    </div>`;
}

function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  if (s >= 60) {
    const m = Math.floor(s / 60); const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }
  return `${s}s`;
}

/**
 * Full ordered workout list shown beneath the active-exercise hero. One row per
 * exercise (HYROX: one per station). Completed exercises are ticked and dimmed,
 * the current one carries a filled dot + "now", upcoming ones a hollow dot. Lets
 * the athlete see the whole session, not just what's next. Re-renders on every
 * setStart / restEnd via the normal render paths (mid-tick never changes which
 * exercise is done, so no per-tick patch needed).
 */
function renderWorkoutList(): string {
  if (!active) return '';
  const sets = active.session.sets;
  const totalDone = active.controller.completedSets;
  const curEx = active.controller.currentSet()?.exerciseIndex;
  const oneShot = sets.every(s => s.setCount === 1);

  // Group sets by exercise, in order; first set carries the prescription.
  const order: number[] = [];
  const firstSet = new Map<number, GuidedSet>();
  const counts = new Map<number, number>();
  for (const s of sets) {
    if (!firstSet.has(s.exerciseIndex)) { firstSet.set(s.exerciseIndex, s); order.push(s.exerciseIndex); }
    counts.set(s.exerciseIndex, (counts.get(s.exerciseIndex) ?? 0) + 1);
  }
  if (order.length <= 1) return '';

  let consumed = 0;
  const rows = order.map(exIdx => {
    const ex = firstSet.get(exIdx)!;
    const cnt = counts.get(exIdx) ?? 1;
    const doneHere = Math.max(0, Math.min(cnt, totalDone - consumed));
    consumed += cnt;
    const isDone = doneHere >= cnt;
    const isCurrent = exIdx === curEx && !isDone;
    const prescription = oneShot
      ? escapeHtml(ex.reps)
      : (ex.reps ? `${cnt} × ${escapeHtml(ex.reps)}` : `${cnt} set${cnt > 1 ? 's' : ''}`);

    const marker = isDone
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F172A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
      : isCurrent
        ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#0F172A"></span>`
        : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--c-border)"></span>`;
    const nameWeight = isCurrent ? '700' : '500';
    const nameColor = isDone ? 'var(--c-muted)' : '#0F172A';
    return `
      <li style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--c-border);${isDone ? 'opacity:0.55' : ''}">
        <span style="width:16px;display:flex;justify-content:center;flex-shrink:0">${marker}</span>
        <span style="flex:1;min-width:0;font-size:13px;font-weight:${nameWeight};color:${nameColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(ex.exerciseName)}${isCurrent ? `<span style="font-size:11px;color:var(--c-faint);font-weight:500;margin-left:7px">now</span>` : ''}</span>
        <span style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums;flex-shrink:0">${prescription}</span>
      </li>`;
  }).join('');

  const heading = oneShot ? 'Stations' : 'Workout';
  return `
    <div style="font-size:11px;color:var(--c-faint);margin-bottom:2px">${heading}</div>
    <ul style="margin:0;padding:0;list-style:none">${rows}</ul>`;
}

function renderActive(): void {
  if (!active) return;
  const cur = active.controller.currentSet();
  if (!cur) return;
  const idx = active.session.sets.indexOf(cur);
  const total = active.session.sets.length;
  // When every step is a one-shot (HYROX), suppress the redundant "Set 1 of 1"
  // and use "Station" terminology for the overall position counter.
  const oneShot = active.session.sets.every(s => s.setCount === 1);
  const positionLabel = oneShot ? `Station ${idx + 1} of ${total}` : `Set ${idx + 1} of ${total}`;

  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  node.innerHTML = `
    ${shellOpen(muteButton(active.cuesOn))}
      <div style="padding:6px 22px 22px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px">
          <div>
            <div id="gs-elapsed" style="font-size:34px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;line-height:1">${fmtElapsed(active.controller.elapsedSec)}</div>
            <div style="font-size:11px;color:var(--c-muted);margin-top:4px">Session · ${positionLabel}</div>
          </div>
          <div style="text-align:right">
            <div id="gs-set-elapsed" style="font-size:22px;font-weight:600;color:#0F172A;letter-spacing:-0.01em;font-variant-numeric:tabular-nums;line-height:1">${fmtElapsed(active.controller.currentSetElapsedSec)}</div>
            <div style="font-size:11px;color:var(--c-muted);margin-top:4px">${oneShot ? 'This station' : 'This set'}${cur.setCount > 1 ? ` · ${cur.setIndex + 1}/${cur.setCount}` : ''}</div>
          </div>
        </div>

        <div style="font-size:24px;font-weight:700;color:#0F172A;line-height:1.2;letter-spacing:-0.01em;margin-bottom:6px">${escapeHtml(cur.exerciseName)}</div>
        ${cur.reps ? `<div style="font-size:14px;color:#0F172A;margin-bottom:8px">${escapeHtml(cur.reps)}</div>` : ''}
        ${cur.cue ? `<div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:18px">${escapeHtml(cur.cue)}</div>` : ''}
        ${renderWeightBlock(cur)}
        ${renderRunReadoutBlock()}

        <button id="gs-complete" class="m-btn-primary" style="width:100%;padding:14px;font-size:15px;margin-bottom:8px">
          Complete set
        </button>
        <button id="gs-finish" class="m-btn-secondary" style="width:100%;padding:11px;font-size:13px;margin-bottom:18px">
          Finish session
        </button>

        ${renderWorkoutList()}
      </div>
    ${shellClose()}
  `;
  wireCommonControls();
  wireWeightControls(cur);
  document.getElementById('gs-complete')?.addEventListener('click', () => active?.controller.completeSet());
  document.getElementById('gs-finish')?.addEventListener('click', () => active?.controller.finish());
}

function renderResting(): void {
  if (!active) return;
  const next = active.controller.nextSet();
  const last = active.controller.lastRecord();
  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  node.innerHTML = `
    ${shellOpen(muteButton(active.cuesOn))}
      <div style="padding:6px 22px 22px;text-align:center">
        <div style="font-size:12px;letter-spacing:0.04em;color:var(--c-muted);margin-bottom:6px">Rest</div>
        <div id="gs-rest" style="font-size:72px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1;margin-bottom:10px">${fmtCountdown(active.controller.restRemainingSec)}</div>

        ${last ? `<div style="font-size:12px;color:var(--c-muted);margin-bottom:14px">Logged: ${escapeHtml(last.exerciseName)}${last.setCount > 1 ? ` set ${last.setIndex + 1}` : ''} <span style="color:#0F172A;font-weight:600;font-variant-numeric:tabular-nums">${fmtElapsed(last.durationSec)}</span></div>` : ''}

        ${renderProgressRings()}

        ${next ? `
          <div style="font-size:12px;color:var(--c-muted);margin-bottom:4px">Next</div>
          <div style="font-size:17px;font-weight:600;color:#0F172A;margin-bottom:4px">${escapeHtml(next.exerciseName)}</div>
          <div style="font-size:13px;color:var(--c-muted);margin-bottom:22px">${next.setCount > 1 ? `Set ${next.setIndex + 1} of ${next.setCount}` : ''}${next.setCount > 1 && next.reps ? ' · ' : ''}${escapeHtml(next.reps)}</div>
        ` : ''}

        <div style="display:flex;gap:10px">
          <button id="gs-extend" class="m-btn-secondary" style="flex:1;padding:12px;font-size:13px">+30s</button>
          <button id="gs-skip" class="m-btn-primary" style="flex:1;padding:12px;font-size:13px">Skip rest</button>
        </div>

        <div id="gs-elapsed-small" style="margin-top:14px;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">Elapsed ${fmtElapsed(active.controller.elapsedSec)}</div>
      </div>
    ${shellClose()}
  `;
  wireCommonControls();
  document.getElementById('gs-extend')?.addEventListener('click', () => active?.controller.extendRest(30));
  document.getElementById('gs-skip')?.addEventListener('click', () => active?.controller.skipRest());
}

/** Pre-station countdown — visible 5..1 number after the user taps Start. */
const COUNTDOWN_SECONDS = 5;

/**
 * Unbounded-rest screen for manual-advance sessions (HYROX). The rest-elapsed
 * timer ticks up so you can see how long you've been recovering; the recent-
 * station log shows the times just captured; tapping "Start next station"
 * triggers the 5-second pre-station countdown.
 */
function renderPaused(): void {
  if (!active) return;
  const next = active.controller.nextSet();
  const last = active.controller.lastRecord();
  const recent = active.controller.setRecords.slice(-3).reverse(); // most-recent first
  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  node.innerHTML = `
    ${shellOpen(muteButton(active.cuesOn))}
      <div style="padding:6px 22px 22px">
        <div style="font-size:11px;letter-spacing:0.04em;color:var(--c-muted);text-align:center;margin-bottom:4px">Rest</div>
        <div id="gs-pause-elapsed" style="font-size:64px;font-weight:700;color:#0F172A;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;line-height:1;text-align:center;margin-bottom:14px">${fmtElapsed(active.controller.pauseElapsedSec)}</div>

        ${last ? `<div style="text-align:center;font-size:12px;color:var(--c-muted);margin-bottom:18px">${escapeHtml(last.exerciseName)}${last.setCount > 1 ? ` set ${last.setIndex + 1}` : ''} logged <span style="color:#0F172A;font-weight:600;font-variant-numeric:tabular-nums">${fmtElapsed(last.durationSec)}</span></div>` : ''}

        ${renderProgressRings()}

        ${recent.length > 1 ? `
          <div style="font-size:11px;color:var(--c-faint);letter-spacing:0.04em;margin-bottom:6px">Recent</div>
          <ul style="margin:0 0 18px;padding:0;list-style:none;font-size:12px;color:var(--c-muted);line-height:1.7">
            ${recent.map(r => `<li style="display:flex;justify-content:space-between;border-bottom:1px solid var(--c-border);padding:4px 0"><span>${escapeHtml(r.exerciseName)}${r.setCount > 1 ? ` · set ${r.setIndex + 1}` : ''}</span><span style="font-variant-numeric:tabular-nums;color:#0F172A;font-weight:500">${fmtElapsed(r.durationSec)}</span></li>`).join('')}
          </ul>
        ` : ''}

        ${next ? `
          <div style="text-align:center;font-size:13px;color:var(--c-muted);margin-bottom:4px">Take your time. Start when you're ready.</div>
          <div style="text-align:center;font-size:18px;font-weight:600;color:#0F172A;margin-bottom:4px">Next: ${escapeHtml(next.exerciseName)}</div>
          <div style="text-align:center;font-size:13px;color:var(--c-muted);margin-bottom:20px">${escapeHtml(next.reps)}</div>
        ` : ''}

        <button id="gs-next" class="m-btn-primary" style="width:100%;padding:14px;font-size:15px;margin-bottom:8px">Start next station</button>
        <button id="gs-finish" class="m-btn-secondary" style="width:100%;padding:11px;font-size:13px">Finish session</button>

        <div id="gs-elapsed-small" style="margin-top:14px;text-align:center;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">Total elapsed ${fmtElapsed(active.controller.elapsedSec)}</div>
      </div>
    ${shellClose()}
  `;
  wireCommonControls();
  document.getElementById('gs-next')?.addEventListener('click', () => active?.controller.startNextSet(COUNTDOWN_SECONDS));
  document.getElementById('gs-finish')?.addEventListener('click', () => active?.controller.finish());
}

/**
 * Big "get ready" countdown — 3..2..1 before the first set, 5..1 between
 * stations. Auto-advances to `renderActive` when the controller transitions out
 * of `countdown`.
 */
function renderCountdown(): void {
  if (!active) return;
  const next = active.controller.nextSet();
  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  node.innerHTML = `
    ${shellOpen('<div></div>')}
      <div style="padding:18px 22px 36px;text-align:center">
        <div style="font-size:12px;letter-spacing:0.04em;color:var(--c-muted);margin-bottom:8px">Get ready</div>
        <div id="gs-countdown" style="font-size:128px;font-weight:700;color:#0F172A;letter-spacing:-0.04em;font-variant-numeric:tabular-nums;line-height:1;margin-bottom:16px">${active.controller.countdownRemainingSec}</div>
        ${next ? `
          <div style="font-size:18px;font-weight:600;color:#0F172A;margin-bottom:4px">${escapeHtml(next.exerciseName)}</div>
          <div style="font-size:13px;color:var(--c-muted)">${escapeHtml(next.reps)}</div>
        ` : ''}
      </div>
    ${shellClose()}
  `;
  // Tap the X to abort the countdown back to paused isn't worth wiring. Let
  // the countdown finish (it's 5 seconds). The close button uses the normal
  // confirm-finish flow if the user really wants out.
  document.getElementById('gs-close')?.addEventListener('click', () => {
    if (!active) return;
    showFinishConfirm(() => active?.controller.finish());
  });
}

/**
 * In-app finish confirmation. Replaces the native `confirm()` dialog, which
 * renders as a "localhost says…" system box in the browser and behaves poorly
 * in the iOS WKWebView. A small centered card layered over the overlay shell.
 */
function showFinishConfirm(onConfirm: () => void): void {
  const host = document.getElementById(OVERLAY_ID);
  if (!host || host.querySelector('#gs-confirm')) return;
  const el = document.createElement('div');
  el.id = 'gs-confirm';
  el.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);z-index:10;padding:20px';
  el.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:340px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3)">
      <div style="font-size:16px;font-weight:600;color:#0F172A;margin-bottom:6px">Finish the session?</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:18px">Your time so far will be logged.</div>
      <div style="display:flex;gap:10px">
        <button id="gs-confirm-cancel" class="m-btn-glass m-btn-glass--inset" style="flex:1;padding:12px;font-size:14px">Keep going</button>
        <button id="gs-confirm-yes" class="m-btn-primary" style="flex:1;padding:12px;font-size:14px">Finish</button>
      </div>
    </div>`;
  host.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
  el.querySelector('#gs-confirm-cancel')?.addEventListener('click', () => el.remove());
  el.querySelector('#gs-confirm-yes')?.addEventListener('click', () => { el.remove(); onConfirm(); });
}

/**
 * In-app discard confirmation for the finish screen. Closing the overlay there
 * never persists the session (only "Save and close" calls completeStrengthSession),
 * so a stray tap would silently lose the logged sets. This double-checks first.
 * Same centered-card pattern as showFinishConfirm; the confirm button is red.
 */
function showDiscardConfirm(onConfirm: () => void): void {
  const host = document.getElementById(OVERLAY_ID);
  if (!host || host.querySelector('#gs-confirm')) return;
  const el = document.createElement('div');
  el.id = 'gs-confirm';
  el.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);z-index:10;padding:20px';
  el.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:340px;width:100%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3)">
      <div style="font-size:16px;font-weight:600;color:#0F172A;margin-bottom:6px">Discard this session?</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:18px">Your sets and time will not be saved.</div>
      <div style="display:flex;gap:10px">
        <button id="gs-confirm-cancel" class="m-btn-glass m-btn-glass--inset" style="flex:1;padding:12px;font-size:14px">Keep it</button>
        <button id="gs-confirm-yes" class="m-btn-danger" style="flex:1;padding:12px;font-size:14px">Discard</button>
      </div>
    </div>`;
  host.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) el.remove(); });
  el.querySelector('#gs-confirm-cancel')?.addEventListener('click', () => el.remove());
  el.querySelector('#gs-confirm-yes')?.addEventListener('click', () => { el.remove(); onConfirm(); });
}

/** Format a time delta: "8s" under a minute, "1:20" above. */
function fmtDelta(sec: number): string {
  const a = Math.abs(Math.round(sec));
  return a >= 60 ? fmtElapsed(a) : `${a}s`;
}

/**
 * HYROX end-of-session summary. Run legs (bricks) list time + pace per round so
 * the athlete can see fade across the brick — no benchmark, run fitness lives in
 * pace/VDOT. Station rows show the best round, field rank, and whether it beat
 * (and updated) the stored benchmark. Technique rows show "Technique pace" since
 * the times are submaximal by design. Mirrors `summariseHyroxSession` /
 * `summariseHyroxRuns`.
 */
function buildHyroxFinishSummary(workout: Workout, records: SetRecord[]): string {
  const results = summariseHyroxSession(workout, records, getState());
  const runLegs = summariseHyroxRuns(workout, records);
  if (!results.length && !runLegs.length) return '';
  const unit = getState().unitPref ?? 'km';

  // Run legs first, in round order (bricks). Time + pace, no benchmark.
  const runRows = runLegs.map(leg => {
    const distLabel = formatKm(leg.distanceM / 1000, unit, leg.distanceM % 1000 === 0 ? 0 : 1);
    return `<li style="padding:8px 0;border-bottom:1px solid var(--c-border)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px"><span>Run<span style="color:var(--c-muted);font-size:11px;margin-left:6px">round ${leg.round} · ${distLabel}</span></span><span style="font-variant-numeric:tabular-nums;color:#0F172A;font-weight:600">${fmtElapsed(leg.durationSec)}</span></div>
      <div style="font-size:11px;color:var(--c-muted);margin-top:2px">${formatPace(leg.paceSecKm, unit)}</div>
    </li>`;
  }).join('');

  const multiRound = ((workout as any).hyroxRounds ?? 1) > 1;
  const stationRows = results.map(r => {
    const nameLabel = `${escapeHtml(r.displayName)}${multiRound ? '<span style="color:var(--c-muted);font-size:11px;margin-left:6px">best round</span>' : ''}`;
    let sub = '';
    if (r.isImprovement) {
      const detail = r.benchmarkSec != null && r.deltaSec != null
        ? `Benchmark updated. ${fmtDelta(r.deltaSec)} faster than your best.`
        : 'New session best recorded.';
      sub = `<div style="font-size:11px;color:#15803d;margin-top:2px">${detail}</div>`;
    } else if (r.percentile == null) {
      sub = `<div style="font-size:11px;color:var(--c-faint);margin-top:2px">Technique pace</div>`;
    } else {
      const parts = [`Faster than ${r.percentile}% of the field`];
      if (r.deltaSec != null && r.deltaSec < 0) parts.push(`${fmtDelta(r.deltaSec)} off your best`);
      sub = `<div style="font-size:11px;color:var(--c-muted);margin-top:2px">${parts.join(' · ')}</div>`;
    }
    return `<li style="padding:8px 0;border-bottom:1px solid var(--c-border)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px"><span>${nameLabel}</span><span style="font-variant-numeric:tabular-nums;color:#0F172A;font-weight:600">${fmtElapsed(r.bestSec)}</span></div>
      ${sub}
    </li>`;
  }).join('');
  return `<ul style="margin:0 0 22px;padding:0;list-style:none">${runRows}${stationRows}</ul>`;
}

function renderFinish(): void {
  if (!active) return;
  const node = document.getElementById(OVERLAY_ID);
  if (!node) return;
  const elapsed = active.controller.elapsedSec;
  const elapsedMin = Math.max(1, Math.round(elapsed / 60));
  const sets = active.session.sets.length;
  const ex = active.session.exerciseCount;
  const initial = active.workout.rpe ?? active.workout.r ?? 5;
  const records = active.controller.setRecords;
  const oneShot = active.session.sets.every(s => s.setCount === 1);
  active.finishRpe = initial;

  // Per-set or per-station breakdown of measured times.
  const isHyrox = Array.isArray((active.workout as any).hyroxComponents) && (active.workout as any).hyroxComponents.length > 0;
  let breakdownHtml = '';
  if (records.length && isHyrox) {
    // HYROX: per-station best round vs benchmark + percentile + "new best".
    breakdownHtml = buildHyroxFinishSummary(active.workout, records);
  } else if (records.length) {
    if (oneShot) {
      // HYROX / one-shot: numbered list with the station name + time.
      const rows = records.map((r, i) =>
        `<li style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--c-border);font-size:13px"><span><span style="color:var(--c-faint);font-variant-numeric:tabular-nums;margin-right:8px">${i + 1}.</span>${escapeHtml(r.exerciseName)}</span><span style="font-variant-numeric:tabular-nums;color:#0F172A;font-weight:600">${fmtElapsed(r.durationSec)}</span></li>`
      ).join('');
      breakdownHtml = `<ul style="margin:0 0 22px;padding:0;list-style:none">${rows}</ul>`;
    } else {
      // Strength: group by exercise, show the working weight · N sets · total
      // time. Weight comes from the per-exercise inputs (records aren't merged
      // until save). Keeps the summary tight when a session has 20+ sets.
      const byEx = new Map<number, { name: string; total: number; setCount: number }>();
      for (const r of records) {
        const cur = byEx.get(r.exerciseIndex) ?? { name: r.exerciseName, total: 0, setCount: 0 };
        cur.total += r.durationSec;
        cur.setCount += 1;
        byEx.set(r.exerciseIndex, cur);
      }
      const rows = Array.from(byEx.entries()).map(([exIdx, g]) => {
        const w = active!.exerciseInputs.get(exIdx)?.weightKg;
        const weightLabel = w != null ? `<span style="color:#0F172A;font-weight:600">${fmtKg(w)}</span> · ` : '';
        return `<li style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--c-border);font-size:13px"><span>${escapeHtml(g.name)}</span><span style="font-variant-numeric:tabular-nums;color:var(--c-muted);flex-shrink:0">${weightLabel}${g.setCount} ${g.setCount === 1 ? 'set' : 'sets'} · <span style="color:#0F172A;font-weight:600">${fmtElapsed(g.total)}</span></span></li>`;
      }).join('');
      breakdownHtml = `<ul style="margin:0 0 22px;padding:0;list-style:none">${rows}</ul>`;
    }
  }

  node.innerHTML = `
    ${shellOpen('<div></div>')}
      <div style="padding:6px 22px 22px">
        <div style="font-size:11px;letter-spacing:0.04em;color:var(--c-muted);margin-bottom:4px">Session complete</div>
        <div style="font-size:36px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1;margin-bottom:6px;font-variant-numeric:tabular-nums">${elapsedMin} min</div>
        <div style="font-size:13px;color:var(--c-muted);margin-bottom:18px">${
          isHyrox
            ? (() => {
                // Count stations (non-run) separately so a brick's run leg isn't mislabelled a station.
                const comps = ((active.workout as any).hyroxComponents ?? []) as Array<{ type: string }>;
                const stationCount = comps.filter(c => c.type !== 'run').length || ex;
                const hasRun = comps.some(c => c.type === 'run');
                const rd = (active.workout as any).hyroxRounds ?? 1;
                const stations = `${stationCount} ${stationCount === 1 ? 'station' : 'stations'}`;
                const head = rd > 1 ? `${rd} rounds` : '1 round';
                return hasRun ? `${head} of run + ${stations}` : `${head} across ${stations}`;
              })()
            : (oneShot ? `${ex} ${ex === 1 ? 'station' : 'stations'}` : `${sets} sets across ${ex} exercise${ex === 1 ? '' : 's'}`)
        }.</div>

        ${breakdownHtml}

        <div style="font-size:13px;color:#0F172A;font-weight:500;margin-bottom:10px">How did it feel?</div>
        <div id="gs-rpe-row" style="display:flex;gap:5px;margin-bottom:22px;flex-wrap:wrap">
          ${Array.from({ length: 10 }, (_, i) => i + 1).map(n => `
            <button data-rpe="${n}" class="gs-rpe" style="
              flex:1;min-width:36px;padding:10px 0;
              background:${n === initial ? '#0F172A' : 'transparent'};
              color:${n === initial ? '#FAF9F6' : '#0F172A'};
              border:1px solid ${n === initial ? '#0F172A' : 'var(--c-border)'};
              border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--f);font-variant-numeric:tabular-nums">${n}</button>
          `).join('')}
        </div>

        <button id="gs-save" class="m-btn-primary" style="width:100%;padding:14px;font-size:15px">
          Save and close
        </button>
        <button id="gs-discard" style="width:100%;padding:11px;margin-top:8px;background:transparent;color:#EF4444;border:none;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">
          Discard session
        </button>
      </div>
    ${shellClose()}
  `;
  // Mute button hidden on finish (no further cues to mute). Closing the overlay
  // here never persists the session, so both the × and the explicit Discard
  // link double-check before throwing the logged sets away.
  document.getElementById('gs-close')?.addEventListener('click', () => showDiscardConfirm(() => closeOverlay()));
  document.getElementById('gs-discard')?.addEventListener('click', () => showDiscardConfirm(() => closeOverlay()));

  document.querySelectorAll<HTMLButtonElement>('.gs-rpe').forEach(btn => {
    btn.addEventListener('click', () => {
      const rpe = parseInt(btn.dataset.rpe || '5', 10);
      if (!active) return;
      active.finishRpe = rpe;
      document.querySelectorAll<HTMLButtonElement>('.gs-rpe').forEach(b => {
        const isSel = parseInt(b.dataset.rpe || '0', 10) === rpe;
        b.style.background = isSel ? '#0F172A' : 'transparent';
        b.style.color = isSel ? '#FAF9F6' : '#0F172A';
        b.style.borderColor = isSel ? '#0F172A' : 'var(--c-border)';
      });
    });
  });

  document.getElementById('gs-save')?.addEventListener('click', () => {
    if (!active) return;
    const rpe = active.finishRpe ?? initial;
    const wo = active.workout;
    // Merge the per-exercise weight + RIR the user entered onto the records.
    const enriched = records.map(r => {
      const inp = active!.exerciseInputs.get(r.exerciseIndex);
      return inp ? { ...r, weightKg: inp.weightKg ?? r.weightKg, rirBucket: inp.rirBucket ?? r.rirBucket } : r;
    });
    const result = completeStrengthSession(wo, { rpe, durationSec: elapsed, records: enriched });
    closeOverlay();
    // Standard gym sessions get the muscle-group + HR recap (no-op for HYROX,
    // which has its own benchmark recap).
    if (!result.isHyrox) {
      import('@/ui/strength-summary-card').then(({ openStrengthSummary }) => openStrengthSummary(wo, result));
    }
  });
}

// ─── Patch the live clock + countdown without re-rendering the whole view ──

function patchClocks(): void {
  if (!active) return;
  const phase = active.controller.phase;
  const el = document.getElementById('gs-elapsed');
  if (el) el.textContent = fmtElapsed(active.controller.elapsedSec);
  // Live per-station clock alongside the session clock (active phase only).
  if (phase === 'active') {
    const setEl = document.getElementById('gs-set-elapsed');
    if (setEl) setEl.textContent = fmtElapsed(active.controller.currentSetElapsedSec);
  }
  // GPS readout patches on every tick too. Keeps the distance/pace fresh
  // even when GPS updates lag (e.g. indoors with weak signal).
  if (phase === 'active' && active.activeRun && active.gps) {
    const live = active.gps.getLiveData();
    const target = active.activeRun.distanceM ?? 1000;
    const delta = Math.max(0, live.totalDistance - active.runDistanceBaseline);
    patchRunReadout(delta, target, live.currentPace ?? 0);
  }
  const elSmall = document.getElementById('gs-elapsed-small');
  if (elSmall) {
    const label = phase === 'paused' ? 'Total elapsed' : 'Elapsed';
    elSmall.textContent = `${label} ${fmtElapsed(active.controller.elapsedSec)}`;
  }
  const rest = document.getElementById('gs-rest');
  if (rest && phase === 'resting') {
    rest.textContent = fmtCountdown(active.controller.restRemainingSec);
  }
  const pauseEl = document.getElementById('gs-pause-elapsed');
  if (pauseEl && phase === 'paused') {
    pauseEl.textContent = fmtElapsed(active.controller.pauseElapsedSec);
  }
  const cd = document.getElementById('gs-countdown');
  if (cd && phase === 'countdown') {
    const prev = parseInt(cd.textContent || '0', 10);
    const next = active.controller.countdownRemainingSec;
    if (next !== prev) {
      cd.textContent = String(next);
      pulse(40);  // soft tick each second
    }
  }
}

// ─── Common controls (mute, close) ──────────────────────────────────────────

function wireCommonControls(): void {
  document.getElementById('gs-mute')?.addEventListener('click', () => {
    if (!active) return;
    active.cuesOn = !active.cuesOn;
    if (!active.cuesOn) active.voice.cancel();
    // Re-render header to update the icon/label.
    if (active.controller.phase === 'resting') renderResting();
    else if (active.controller.phase === 'active') renderActive();
  });
  document.getElementById('gs-close')?.addEventListener('click', () => {
    if (!active) return;
    if (active.finished) { closeOverlay(); return; }
    // Confirm before discarding an in-progress session (in-app dialog, not native confirm()).
    showFinishConfirm(() => active?.controller.finish());
  });
}

// ─── Cue side-effects ───────────────────────────────────────────────────────

function speak(text: string): void {
  if (!active?.cuesOn) return;
  try { active.voice.speak(text); } catch { /* no-op */ }
}

function pulse(pattern: number | number[]): void {
  if (!active?.cuesOn) return;
  try {
    if (typeof navigator !== 'undefined' && typeof (navigator as any).vibrate === 'function') {
      (navigator as any).vibrate(pattern);
    }
  } catch { /* no-op */ }
}

// ─── HTML escape ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
