/**
 * One plan-change mod per workout: write and remove rules (audit A2, A3, A15).
 *
 * Every running plan change lives in wk.workoutMods and is re-applied at render
 * by the canonical resolver (ui/week-resolve.ts), in array order. Flows used to
 * APPEND a new mod each time, so the last one written won: a later small ride
 * brought back a replaced run, or undid a deeper cut. The flows now size their
 * change against the resolved week (mods already applied) and write it with
 * upsertWorkoutMod, which REPLACES the workout's current mod and keeps the
 * replaced one on `previousMod`. removeWorkoutMods restores what a removed mod
 * replaced, so undo and re-review keep their old meaning. The week they size from
 * is the plan layers only (ui/week-resolve.ts resolveWeekForPlanChanges): the
 * illness, holiday and bridge layers are re-applied on top of every mod at render,
 * so their output must never be written into one.
 *
 * Planning side: these helpers change prescriptions only. Tracking (actuals,
 * load, prediction) never reads them.
 *
 * Two kinds of mod are outside the one-per-workout rule:
 *   - pending timing suggestions ('Timing:'), a label layer owned by
 *     mergeTimingMods;
 *   - a user's own Adjust (userScaledAt). It is the user's explicit choice for
 *     that session, so automatic and suggested changes leave it alone (the same
 *     rule the holiday bridge follows, holiday-modal.ts applyBridgeModsAllDisciplines).
 */

import type { Week, WorkoutMod, Workout } from '@/types';
import { isTimingMod } from '@/cross-training/timing-mod-reason';
import { parseDistanceKm, isSimpleDistanceDesc } from './workout-scaling';
import { isStoodDownByLayer } from './render-layer';

type ModKey = Pick<WorkoutMod, 'name' | 'dayOfWeek' | 'workoutId'>;

/** True when two mods target the same session. The stable slot id decides when
 *  both carry one; otherwise name plus day (the legacy key). */
export function modsTargetSameWorkout(a: ModKey, b: ModKey): boolean {
  if (a.workoutId && b.workoutId) return a.workoutId === b.workoutId;
  return a.name === b.name
    && (a.dayOfWeek == null || b.dayOfWeek == null || a.dayOfWeek === b.dayOfWeek);
}

/** A session the user scaled by hand through Adjust. Suggestion flows do not offer
 *  cuts on it and automatic writes do not replace its mod. */
export function isUserAdjusted(w: object | null | undefined): boolean {
  return !!(w as { userScaledAt?: string } | null | undefined)?.userScaledAt;
}

/** Drop sessions no suggestion may cut from a candidate list before it is handed
 *  to the cross-training suggester: user-adjusted sessions (their Adjust stands)
 *  and sessions a holiday or an illness rest day stands down this week (they are
 *  not run, so cutting them absorbs no load). An illness- or bridge-scaled session
 *  stays a candidate; the plan-layers week it comes from carries its plan values,
 *  and the layer scales the cut session once at render. */
export function adjustableWorkouts<T extends object>(workouts: T[]): T[] {
  return workouts.filter(w => !isUserAdjusted(w) && !isStoodDownByLayer(w));
}

export interface UpsertOptions {
  /** A user-initiated change (e.g. the readiness "Convert to easy" action) may
   *  replace the user's own Adjust. Automatic and suggested changes may not. */
  replaceUserAdjust?: boolean;
}

/**
 * Write `mod` as the plan change for its workout, replacing the mod the workout
 * already carries instead of stacking a second one.
 *
 *   - The replaced mod is kept on `previousMod` (see removeWorkoutMods).
 *   - The plan's original description is kept: `originalDistance` comes from the
 *     replaced mod, and a "(was Xkm)" note in the new description is rewritten to
 *     that original distance (plain distance runs only), so a second cut still
 *     reads against the plan.
 *   - Pending timing suggestions are a separate label layer and are never replaced.
 *   - A user Adjust mod is never replaced unless `opts.replaceUserAdjust`.
 *
 * Returns false when nothing was written (the workout carries a user Adjust).
 */
export function upsertWorkoutMod(wk: Week, mod: WorkoutMod, opts: UpsertOptions = {}): boolean {
  const mods = wk.workoutMods ?? (wk.workoutMods = []);
  const matches = mods.filter(m => !isTimingMod(m.modReason) && modsTargetSameWorkout(m, mod));

  if (!mod.userScaledAt && !opts.replaceUserAdjust && matches.some(m => m.userScaledAt)) return false;

  const next: WorkoutMod = { ...mod };
  // The effective mod is the last one in array order (the resolver applies mods
  // in order). Earlier matches are mods appended on top of one another (from before
  // this rule, or by a writer that still appends, such as the Adjust overlay); they
  // are folded into the chain under the last one, oldest deepest, so removing a
  // later mod still gives each earlier one back instead of dropping it.
  let prev: WorkoutMod | undefined;
  for (const m of matches) prev = prev && !m.previousMod ? { ...m, previousMod: prev } : m;
  if (prev) {
    if (prev.originalDistance != null) {
      next.originalDistance = prev.originalDistance;
      // Only a plain distance run has one honest original distance; a structured
      // session's first km token is its warm-up.
      const origKm = isSimpleDistanceDesc(prev.originalDistance) ? parseDistanceKm(prev.originalDistance) : null;
      if (origKm != null && next.newDistance) {
        next.newDistance = next.newDistance.replace(/\(was \d+(?:\.\d+)?\s*km\)/, `(was ${origKm}km)`);
      }
    }
    next.previousMod = prev;
  }

  wk.workoutMods = [...mods.filter(m => !matches.includes(m)), next];
  return true;
}

/** Copy of a mod chain with every link matching `pred` removed. */
function pruneChain(m: WorkoutMod | undefined, pred: (m: WorkoutMod) => boolean): WorkoutMod | undefined {
  if (!m) return undefined;
  const rest = pruneChain(m.previousMod, pred);
  if (pred(m)) return rest;
  const copy: WorkoutMod = { ...m };
  if (rest) copy.previousMod = rest;
  else delete copy.previousMod;
  return copy;
}

/**
 * Remove every mod matching `pred`, including ones buried in a `previousMod`
 * chain. A removed mod is replaced by the mod it had replaced, so undoing an ACWR
 * cut that was written over a cross-training cut brings the cross-training cut
 * back rather than the unmodified session.
 */
export function removeWorkoutMods(wk: Week, pred: (m: WorkoutMod) => boolean): void {
  if (!wk.workoutMods?.length) return;
  const out: WorkoutMod[] = [];
  for (const m of wk.workoutMods) {
    const kept = pruneChain(m, pred);
    if (kept) out.push(kept);
  }
  wk.workoutMods = out;
}

/** The fields of an accepted suggester adjustment that become a mod. */
interface AdjustmentKey { workoutId: string; dayIndex: number }

/**
 * Persist accepted cross-training / ACWR adjustments. `modified` is the output of
 * applyAdjustments on the resolved week; each adjusted workout's new prescription
 * is upserted (one mod per workout, stamped with its stable slot id so it still
 * matches after a drag-move or a day reshuffle). Returns the number written.
 */
export function writeAdjustmentMods(
  wk: Week,
  modified: Workout[],
  adjustments: AdjustmentKey[],
  modReason: string,
  extra: Partial<WorkoutMod> = {},
): number {
  let written = 0;
  for (const adj of adjustments) {
    const mw = modified.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
    if (!mw) continue;
    const ok = upsertWorkoutMod(wk, {
      name: mw.n,
      dayOfWeek: mw.dayOfWeek,
      workoutId: mw.id,
      status: mw.status || 'reduced',
      modReason,
      confidence: mw.confidence,
      originalDistance: mw.originalDistance,
      newDistance: mw.d,
      newType: mw.t,
      newRpe: mw.rpe || mw.r,
      ...extra,
    });
    if (ok) written++;
  }
  return written;
}
