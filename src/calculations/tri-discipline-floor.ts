/**
 * Per-discipline TSS floor for triathlon-mode plan modifications.
 *
 * Mirror of running's `computeRunningFloorKm` (`fitness-model.ts:1312`) but
 * expressed in TSS and applied per discipline (swim / bike / run). Used by
 * `detectCrossTrainingOverload` to bound how much of a discipline's planned
 * load can be reduced when the user accepts a cross-training overload mod.
 *
 * **Side of the line**: planning. Pure read-only function.
 *
 * Logic mirrors running:
 *   1. Taper phase → no floor (the entire point of taper is volume drop).
 *   2. Hot per-discipline ramp (ACWR > 1.3) → no floor (injury prevention
 *      wins; we're already in a high-load state and shouldn't artificially
 *      hold volume up).
 *   3. Otherwise → floor = 65% of the discipline's planned weekly TSS.
 *      The 65% figure is pragmatic, mirrors running's intent of preserving
 *      ~⅔ of weekly volume during base/build/peak, and intentionally leaves
 *      room for v2.5 calibration once we have data.
 *   4. Discipline absent from plan → return 0 (nothing to protect).
 */

import type { SimulatorState, Week } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { perDisciplineACWR } from './fitness-model.triathlon';

/** ACWR ratio above which the floor is suspended (mirrors running's 'caution'/'high' ACWR threshold). */
const ACWR_HOT_THRESHOLD = 1.3;

/** Fraction of planned discipline TSS the floor preserves during base/build/peak. */
const FLOOR_FRACTION_OF_PLAN = 0.65;

export function computeTriDisciplineFloorTSS(
  state: SimulatorState,
  discipline: Discipline,
  weekIdx: number,
): number {
  const wk = (state.wks ?? [])[weekIdx];
  if (!wk) return 0;

  // Rule 1: taper → no floor.
  if (wk.ph === 'taper') return 0;

  // Rule 2: hot ramp → no floor.
  const fit = state.triConfig?.fitness?.[discipline];
  if (fit) {
    const acwr = perDisciplineACWR(fit);
    if (acwr != null && acwr > ACWR_HOT_THRESHOLD) return 0;
  }

  // Rule 3 + 4: fraction-of-plan floor.
  const plannedTSS = sumPlannedTSSByDiscipline(wk, discipline);
  if (plannedTSS <= 0) return 0;
  return plannedTSS * FLOOR_FRACTION_OF_PLAN;
}

/**
 * Sum of (aerobic + anaerobic) over the week's tri workouts of the given
 * discipline. Includes completed/replaced/skipped — this is "what was
 * originally planned" not "what's still upcoming" (the floor is a per-week
 * volume target, not a per-remaining-session constraint).
 */
export function sumPlannedTSSByDiscipline(wk: Week, discipline: Discipline): number {
  return (wk.triWorkouts ?? [])
    .filter(w => w.discipline === discipline)
    .reduce((acc, w) => acc + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);
}
