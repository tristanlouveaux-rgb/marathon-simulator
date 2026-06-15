/**
 * Shared strength/gym workout detail modal.
 *
 * Strength sessions used to render their full exercise list inline on the plan
 * card as a run-on paragraph ("3×12 Bodyweight Squat (...) (45s rest) 3×10 each
 * leg Reverse Lunge ..."), which read as gibberish. Instead the card now shows
 * the headline + "N exercises · tap to view"; tapping opens this modal, which
 * lays the session out as clean per-exercise rows.
 *
 * For loaded lifts the row also carries the working-weight memory ("Last: 60kg
 * × 8 · suggested 62.5kg") and is tappable through to the per-lift trend.
 *
 * Mode-agnostic: running, triathlon, and HYROX strength sessions share the
 * description format and this modal. Rows are parsed by the canonical
 * `parseStrengthSession`. Start/Done reuse the canonical cross-mode handlers.
 * The quick "Mark as done" path offers a skippable confirm-weights step so a
 * non-guided completion still records the weights.
 */

import type { Workout } from '@/types';
import type { TrainingPhase } from '@/types/training';
import type { SetRecord } from '@/guided/strength-controller';
import { parseStrengthSession, type GuidedSet, type StrengthSession } from '@/guided/strength-model';
import { getState } from '@/state/store';
import { suggestNextWeight } from '@/calculations/strength-progression';
import { STRENGTH_MIN_INCREMENT_KG } from '@/constants/strength-constants';
import { alternativesFor, swapKeyForName } from '@/calculations/strength-alternatives';
import { applyRememberedSwaps, getStrengthSwaps, setStrengthSwap, clearStrengthSwap } from '@/state/strength-swaps';
import type { RunningPoolExercise } from '@/workouts/running-pool';

const OVERLAY_ID = 'strength-workout-detail-overlay';

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "45s rest" / "2 min rest". */
function restLabel(sec: number): string {
  if (sec <= 0) return '';
  return sec >= 60 ? `${Math.round(sec / 60)} min rest` : `${sec}s rest`;
}

/** "28m" / "1h 5m". */
function durLabel(min: number | undefined): string | null {
  if (!min) return null;
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`;
}

/** "62.5kg" / "60kg" — drop a trailing .0. */
function fmtKg(kg: number): string { return `${trimNum(kg)}kg`; }
function trimNum(n: number): string { return (Math.round(n * 100) / 100).toString(); }

interface PhaseContext { phase: TrainingPhase; isDeload: boolean; }

function phaseContext(workout: Workout): PhaseContext {
  const s = getState();
  const wk = s.wks?.[(s.w ?? 1) - 1];
  const phase = (wk?.ph as TrainingPhase) ?? 'base';
  const isDeload = phase === 'taper' || !!(wk as any)?.forceDeload || /\(deload\)/i.test(workout.n || '');
  return { phase, isDeload };
}

interface LiftMemo {
  lastWeightKg?: number;
  lastReps?: string;
  suggestedKg?: number;
  bumped: boolean;
  hasHistory: boolean;
}

/** Per-lift last/suggested memo for a trackable exercise, or null. */
function liftMemo(set: GuidedSet, ctx: PhaseContext): LiftMemo | null {
  if (!set.liftKey) return null;
  const entry = getState().strengthLog?.lifts?.[set.liftKey];
  if (!entry) return { bumped: false, hasHistory: false };
  const sug = suggestNextWeight({
    lastWeightKg: entry.lastWeightKg,
    lastRir: entry.lastRir,
    phase: ctx.phase,
    isDeload: ctx.isDeload,
    injuryKind: 'normal',
  });
  return {
    lastWeightKg: entry.lastWeightKg,
    lastReps: entry.lastReps,
    suggestedKg: sug.weightKg,
    bumped: sug.changed,
    hasHistory: true,
  };
}

/** Unique exercises (first set carries the prescription), in order. */
function uniqueExercises(sets: GuidedSet[]): GuidedSet[] {
  const byExercise = new Map<number, GuidedSet>();
  for (const set of sets) {
    if (!byExercise.has(set.exerciseIndex)) byExercise.set(set.exerciseIndex, set);
  }
  return [...byExercise.values()];
}

interface RowSwapInfo {
  originalName: string;
  swappable: boolean;
  swapped: boolean;
}

/** One clean row per exercise. Loaded lifts gain a memo sub-line + drill-down.
 *  Swappable movements gain a "Swap" control; swapped ones note their origin. */
function renderRows(sets: GuidedSet[], ctx: PhaseContext, swapInfo: Map<number, RowSwapInfo>): string {
  return uniqueExercises(sets).map(ex => {
    const prescription = ex.reps
      ? `${ex.setCount} × ${esc(ex.reps)}`
      : `${ex.setCount} set${ex.setCount > 1 ? 's' : ''}`;
    const meta = [ex.cue ? esc(ex.cue) : '', restLabel(ex.restSec)].filter(Boolean).join(' · ');
    const memo = liftMemo(ex, ctx);
    const tappable = !!(memo?.hasHistory && ex.liftKey);
    const swap = swapInfo.get(ex.exerciseIndex);

    let memoLine = '';
    if (memo?.hasHistory && memo.lastWeightKg != null) {
      const last = `Last: ${fmtKg(memo.lastWeightKg)}${memo.lastReps ? ` × ${esc(memo.lastReps)}` : ''}`;
      const suggested = memo.bumped && memo.suggestedKg != null ? ` · suggested ${fmtKg(memo.suggestedKg)}` : '';
      memoLine = `<div style="font-size:12px;color:var(--c-muted);margin-top:3px">${last}${suggested}</div>`;
    }
    const swappedLine = swap?.swapped
      ? `<div style="font-size:12px;color:var(--c-muted);margin-top:3px">Swapped from ${esc(swap.originalName)}</div>`
      : '';
    const chevron = tappable
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-faint)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="m9 18 6-6-6-6"/></svg>`
      : '';
    // The swap control is a secondary nav action: muted text, no fill, no colour.
    const swapBtn = swap?.swappable
      ? `<button class="strength-swap-btn" data-ex="${ex.exerciseIndex}" style="margin-top:6px;padding:0;background:transparent;border:none;font-size:12px;font-weight:500;color:var(--c-muted);cursor:pointer;font-family:var(--f)">${swap.swapped ? 'Change swap' : 'Swap exercise'}</button>`
      : '';
    return `
      <div>
        <div class="${tappable ? 'strength-lift-row' : ''}" ${tappable ? `data-lift="${esc(ex.liftKey!)}" data-name="${esc(ex.exerciseName)}" style="cursor:pointer"` : ''}>
          <div style="display:flex;gap:12px;padding:12px 0 ${swapBtn ? '4px' : '12px'};border-bottom:${swapBtn ? 'none' : '1px solid var(--c-border)'}">
            <span style="flex-shrink:0;width:3px;border-radius:2px;background:var(--c-border-strong)"></span>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
                <span style="font-size:14px;font-weight:600;color:var(--c-black)">${esc(ex.exerciseName)}</span>
                <span style="display:flex;align-items:center;gap:6px;flex-shrink:0"><span style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">${prescription}</span>${chevron}</span>
              </div>
              ${meta ? `<div style="font-size:12px;color:var(--c-muted);line-height:1.45;margin-top:2px">${meta}</div>` : ''}
              ${memoLine}
              ${swappedLine}
            </div>
          </div>
        </div>
        ${swapBtn ? `<div style="padding:0 0 12px 15px;border-bottom:1px solid var(--c-border)">${swapBtn}</div>` : ''}
      </div>`;
  }).join('');
}

/** "3 × 5" / "3 × 8 each leg" — the prescription summary for a candidate. */
function altPrescription(ex: RunningPoolExercise): string {
  return `${ex.sets} × ${esc(ex.reps)}`;
}

/** The swap sub-view body: same-pattern alternatives + a revert-to-original
 *  option when the movement is currently swapped. */
function renderSwapOptions(originalName: string, currentSwapped: boolean): string {
  const alts = alternativesFor(originalName);
  const optionRow = (label: string, sub: string, attrs: string) => `
    <button class="${attrs}" style="width:100%;text-align:left;display:flex;gap:12px;padding:12px 0;border:none;border-bottom:1px solid var(--c-border);background:transparent;cursor:pointer;font-family:var(--f)">
      <span style="flex-shrink:0;width:3px;border-radius:2px;background:var(--c-border-strong)"></span>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600;color:var(--c-black)">${esc(label)}</div>
        ${sub ? `<div style="font-size:12px;color:var(--c-muted);line-height:1.45;margin-top:2px">${sub}</div>` : ''}
      </div>
    </button>`;
  const revert = currentSwapped
    ? optionRow(`Keep ${originalName}`, 'Revert to the original movement.', `swap-revert`)
    : '';
  const altRows = alts.map(ex =>
    optionRow(ex.name, `${altPrescription(ex)} · ${esc(ex.cue)}`, `swap-pick" data-alt="${esc(ex.name)}`),
  ).join('');
  return `${revert}${altRows}`;
}

/** Confirm-weights sub-view: a stepper per trackable lift before a quick log. */
function renderConfirmWeights(sets: GuidedSet[], ctx: PhaseContext, entered: Map<number, number>): string {
  const rows = uniqueExercises(sets).filter(ex => ex.liftKey).map(ex => {
    const memo = liftMemo(ex, ctx);
    const val = entered.get(ex.exerciseIndex);
    const caption = memo?.hasHistory && memo.lastWeightKg != null
      ? `Last ${fmtKg(memo.lastWeightKg)}${memo.bumped && memo.suggestedKg != null ? ` · suggested ${fmtKg(memo.suggestedKg)}` : ''}`
      : 'First time';
    return `
      <div style="padding:12px 0;border-bottom:1px solid var(--c-border)" data-ex="${ex.exerciseIndex}">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px">
          <span style="font-size:14px;font-weight:600;color:var(--c-black)">${esc(ex.exerciseName)}</span>
          <span style="font-size:11px;color:var(--c-faint)">${caption}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <button class="cw-minus" data-ex="${ex.exerciseIndex}" aria-label="Decrease weight" style="width:42px;height:42px;flex-shrink:0;background:transparent;border:1px solid var(--c-border);border-radius:10px;font-size:20px;font-weight:600;color:var(--c-black);cursor:pointer;font-family:var(--f)">−</button>
          <div style="flex:1;display:flex;align-items:baseline;justify-content:center;gap:5px;border:1px solid var(--c-border);border-radius:10px;padding:8px 10px">
            <input class="cw-input" data-ex="${ex.exerciseIndex}" inputmode="decimal" value="${val != null ? trimNum(val) : ''}" placeholder="—" aria-label="Working weight in kilograms" style="width:72px;text-align:right;border:none;background:transparent;font-size:20px;font-weight:700;color:var(--c-black);font-variant-numeric:tabular-nums;font-family:var(--f);outline:none"/>
            <span style="font-size:13px;color:var(--c-muted)">kg</span>
          </div>
          <button class="cw-plus" data-ex="${ex.exerciseIndex}" aria-label="Increase weight" style="width:42px;height:42px;flex-shrink:0;background:transparent;border:1px solid var(--c-border);border-radius:10px;font-size:20px;font-weight:600;color:var(--c-black);cursor:pointer;font-family:var(--f)">+</button>
        </div>
      </div>`;
  }).join('');
  return rows;
}

/**
 * Open the strength detail modal for a gym/strength workout.
 * No-op if the workout has no parseable exercises.
 */
export function openStrengthWorkoutDetail(workout: Workout): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const baseSession = parseStrengthSession(workout);
  if (!baseSession) return;
  const originalSession: StrengthSession = baseSession;
  const ctx = phaseContext(workout);

  // Original display name per exercise index. A swap replaces a line in place,
  // so the effective session keeps the same exercise indices; this lets each
  // row recover its original movement to key the swap + offer a revert.
  const originalNameByIndex = new Map<number, string>();
  for (const ex of uniqueExercises(originalSession.sets)) {
    originalNameByIndex.set(ex.exerciseIndex, ex.exerciseName);
  }

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto';

  let mode: 'detail' | 'confirm' | 'swap' = 'detail';
  let swapForIndex: number | null = null;
  const entered = new Map<number, number>();

  // Effective (swap-applied) state, recomputed each build so a swap re-renders.
  let effectiveWorkout: Workout = workout;
  let session: StrengthSession = originalSession;
  let trackable: GuidedSet[] = [];
  let swapInfo = new Map<number, RowSwapInfo>();

  function recompute(): void {
    const swaps = getStrengthSwaps();
    effectiveWorkout = applyRememberedSwaps(workout);
    session = parseStrengthSession(effectiveWorkout) ?? originalSession;
    trackable = uniqueExercises(session.sets).filter(ex => ex.liftKey);
    swapInfo = new Map();
    for (const ex of uniqueExercises(session.sets)) {
      const originalName = originalNameByIndex.get(ex.exerciseIndex) ?? ex.exerciseName;
      swapInfo.set(ex.exerciseIndex, {
        originalName,
        swappable: alternativesFor(originalName).length > 0,
        swapped: !!swaps[swapKeyForName(originalName)],
      });
    }
    // Seed confirm-weights with each not-yet-entered lift's suggested (or last)
    // weight; the guard preserves anything the user already typed.
    for (const ex of trackable) {
      if (entered.has(ex.exerciseIndex)) continue;
      const memo = liftMemo(ex, ctx);
      const seed = memo?.bumped ? memo.suggestedKg : memo?.lastWeightKg;
      if (seed != null) entered.set(ex.exerciseIndex, seed);
    }
  }

  const close = () => overlay.remove();

  function completeAndClose(records?: SetRecord[]): void {
    import('@/guided/strength-complete').then(({ completeStrengthSession }) => {
      const result = completeStrengthSession(effectiveWorkout, records ? { records } : {});
      close();
      import('@/ui/strength-summary-card').then(({ openStrengthSummary }) => openStrengthSummary(effectiveWorkout, result));
    });
  }

  function syntheticRecords(): SetRecord[] {
    const recs: SetRecord[] = [];
    for (const ex of trackable) {
      const w = entered.get(ex.exerciseIndex);
      if (w == null || !(w > 0)) continue;
      recs.push({
        exerciseName: ex.exerciseName,
        exerciseIndex: ex.exerciseIndex,
        setIndex: 0,
        setCount: ex.setCount,
        reps: ex.reps,
        durationSec: 0,
        liftKey: ex.liftKey,
        weightKg: w,
      });
    }
    return recs;
  }

  function detailView(): string {
    const rpe = workout.rpe ?? (workout as any).r ?? null;
    const dur = durLabel(workout.estimatedDurationMin);
    const chips: string[] = [];
    if (dur) chips.push(dur);
    if (rpe != null) chips.push(`RPE ${rpe}`);
    chips.push(`${session!.exerciseCount} exercise${session!.exerciseCount === 1 ? '' : 's'}`);
    const chipsHtml = chips.map((t, i) =>
      `${i > 0 ? '<span style="color:var(--c-faint);margin:0 8px">·</span>' : ''}<span>${esc(t)}</span>`,
    ).join('');
    const doneLabel = trackable.length ? 'Log weights and mark done' : 'Mark as done';
    return `
      <div style="padding:20px 22px 14px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px">
          <div style="font-size:20px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;line-height:1.2">${esc(session!.title)}</div>
          <button id="strength-detail-close" style="width:30px;height:30px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted);flex-shrink:0" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">${chipsHtml}</div>
      </div>

      <div style="padding:4px 22px">
        ${renderRows(session.sets, ctx, swapInfo)}
        ${session.stretch ? `<div style="font-size:12px;color:var(--c-muted);line-height:1.45;padding:12px 0">${esc(session.stretch)}</div>` : ''}
      </div>

      <div style="padding:8px 22px 18px;display:flex;flex-direction:column;gap:10px">
        <button id="strength-detail-start" class="m-btn-primary" style="width:100%;padding:14px;font-size:15px">Start session</button>
        <button id="strength-detail-done" class="m-btn-secondary" style="width:100%;padding:11px;font-size:13px">${doneLabel}</button>
      </div>`;
  }

  function confirmView(): string {
    return `
      <div style="padding:20px 22px 14px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px">
          <div style="font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;line-height:1.2">Weights used</div>
          <button id="strength-detail-close" style="width:30px;height:30px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted);flex-shrink:0" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style="font-size:12px;color:var(--c-muted)">Confirm or adjust. We remember these for next time.</div>
      </div>

      <div style="padding:4px 22px">
        ${renderConfirmWeights(session!.sets, ctx, entered)}
      </div>

      <div style="padding:8px 22px 18px;display:flex;flex-direction:column;gap:10px">
        <button id="cw-save" class="m-btn-primary" style="width:100%;padding:14px;font-size:15px">Save and mark done</button>
        <button id="cw-skip" style="width:100%;padding:11px;background:transparent;color:var(--c-muted);border:none;font-size:13px;font-weight:500;cursor:pointer;font-family:var(--f)">Skip, no weights</button>
      </div>`;
  }

  function swapView(): string {
    const info = swapForIndex != null ? swapInfo.get(swapForIndex) : undefined;
    const originalName = info?.originalName ?? '';
    return `
      <div style="padding:20px 22px 14px;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:4px">
          <button id="strength-swap-back" style="width:30px;height:30px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted);flex-shrink:0" aria-label="Back">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div style="flex:1;font-size:18px;font-weight:700;color:var(--c-black);letter-spacing:-0.02em;line-height:1.2">Swap exercise</div>
          <button id="strength-detail-close" style="width:30px;height:30px;background:var(--c-bg);border:1px solid var(--c-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--c-muted);flex-shrink:0" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div style="font-size:12px;color:var(--c-muted);line-height:1.45">Pick a movement that trains the same pattern as ${esc(originalName)}. We remember it for next time.</div>
      </div>

      <div style="padding:4px 22px 18px">
        ${renderSwapOptions(originalName, !!info?.swapped)}
      </div>`;
  }

  function build(): void {
    recompute();
    overlay.innerHTML = `
      <div style="background:var(--c-surface);width:100%;max-width:520px;max-height:90vh;overflow-y:auto;border-radius:20px;box-shadow:0 10px 40px rgba(0,0,0,0.3);position:relative">
        ${mode === 'confirm' ? confirmView() : mode === 'swap' ? swapView() : detailView()}
      </div>`;

    overlay.querySelector('#strength-detail-close')?.addEventListener('click', close);

    if (mode === 'swap') {
      const originalName = (swapForIndex != null ? swapInfo.get(swapForIndex) : undefined)?.originalName ?? '';
      overlay.querySelector('#strength-swap-back')?.addEventListener('click', () => { mode = 'detail'; build(); });
      overlay.querySelectorAll<HTMLButtonElement>('.swap-pick').forEach(btn => {
        btn.addEventListener('click', () => {
          const alt = btn.dataset.alt;
          if (!alt || !originalName) return;
          setStrengthSwap(originalName, alt);
          entered.clear();   // the lift at this index changed; reseed fresh
          mode = 'detail';
          build();
        });
      });
      overlay.querySelector('.swap-revert')?.addEventListener('click', () => {
        if (!originalName) return;
        clearStrengthSwap(originalName);
        entered.clear();
        mode = 'detail';
        build();
      });
      return;
    }

    if (mode === 'detail') {
      overlay.querySelector('#strength-detail-start')?.addEventListener('click', () => {
        close();
        import('@/ui/guided-strength-overlay').then(({ openGuidedStrength }) => openGuidedStrength(effectiveWorkout));
      });
      overlay.querySelector('#strength-detail-done')?.addEventListener('click', () => {
        if (trackable.length) { mode = 'confirm'; build(); }
        else completeAndClose();
      });
      overlay.querySelectorAll<HTMLButtonElement>('.strength-swap-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          swapForIndex = parseInt(btn.dataset.ex || '-1', 10);
          mode = 'swap';
          build();
        });
      });
      overlay.querySelectorAll<HTMLElement>('.strength-lift-row').forEach(row => {
        row.addEventListener('click', () => {
          const key = row.dataset.lift;
          const name = row.dataset.name || '';
          if (!key) return;
          import('@/ui/strength-lift-detail').then(({ openStrengthLiftDetail }) => openStrengthLiftDetail(key, name));
        });
      });
      return;
    }

    // confirm-weights wiring
    const readInput = (ex: number): number | undefined => {
      const el = overlay.querySelector<HTMLInputElement>(`.cw-input[data-ex="${ex}"]`);
      if (!el) return undefined;
      const n = parseFloat(el.value);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const setVal = (ex: number, v: number | undefined) => {
      if (v != null) entered.set(ex, v); else entered.delete(ex);
    };
    overlay.querySelectorAll<HTMLInputElement>('.cw-input').forEach(input => {
      const ex = parseInt(input.dataset.ex || '-1', 10);
      input.addEventListener('input', () => setVal(ex, readInput(ex)));
    });
    const adjust = (ex: number, delta: number) => {
      const input = overlay.querySelector<HTMLInputElement>(`.cw-input[data-ex="${ex}"]`);
      const base = readInput(ex) ?? 0;
      const v = Math.max(0, Math.round((base + delta) * 100) / 100);
      const out = v > 0 ? v : undefined;
      if (input) input.value = out != null ? trimNum(out) : '';
      setVal(ex, out);
    };
    overlay.querySelectorAll<HTMLButtonElement>('.cw-minus').forEach(btn =>
      btn.addEventListener('click', () => adjust(parseInt(btn.dataset.ex || '-1', 10), -STRENGTH_MIN_INCREMENT_KG)));
    overlay.querySelectorAll<HTMLButtonElement>('.cw-plus').forEach(btn =>
      btn.addEventListener('click', () => adjust(parseInt(btn.dataset.ex || '-1', 10), STRENGTH_MIN_INCREMENT_KG)));
    overlay.querySelector('#cw-save')?.addEventListener('click', () => completeAndClose(syntheticRecords()));
    overlay.querySelector('#cw-skip')?.addEventListener('click', () => completeAndClose());
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  build();
}
