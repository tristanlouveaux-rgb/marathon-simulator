/**
 * Per-discipline effort multiplier — mirrors running's `effortMultiplier`
 * (`src/workouts/plan_engine.ts:113`) for tri.
 *
 * **Mirror rule (CLAUDE.md)**: when running's `effortMultiplier` formula
 * changes, this must change too. Running uses `1 - score * 0.05` clamped
 * [0.85, 1.15]; tri replicates exactly per discipline.
 *
 * **Side of the line**: planning. Pure function over state.
 *
 * Effect:
 *   - score < 0 (rated easier than planned) → multiplier > 1.0 → upcoming
 *     sessions of that discipline get longer
 *   - score > 0 (rated harder than planned) → multiplier < 1.0 → shorter
 *
 * Pace/watts/CSS targets auto-update separately via marker re-derivation
 * from history (`refreshBlendedFitness` for run, `deriveTriBenchmarksFromHistory`
 * for swim/bike). This module only scales DURATION.
 */

import type { SimulatorState, Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import {
  TRI_EFFORT_LOOKBACK_WEEKS,
  TRI_EFFORT_MULT_BOUNDS,
} from '@/constants/triathlon-constants';

/**
 * Per-discipline trailing effortScore over the last
 * `TRI_EFFORT_LOOKBACK_WEEKS` completed weeks. Skipped workouts excluded.
 *
 * effortScore = mean(actualRpe - expectedRpe) across rated workouts of the
 * discipline. Skipping is symmetric: positive = overcooked, negative = easy.
 *
 * Returns 0 when there's no data (= neutral, multiplier 1.0).
 */
export function triTrailingEffortScore(state: SimulatorState, discipline: Discipline): number {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const samples: number[] = [];
  // Walk back across completed weeks, collecting per-week deviation means.
  for (let w = currentWeek - 1; w >= 0 && samples.length < TRI_EFFORT_LOOKBACK_WEEKS; w--) {
    const wk = wks[w];
    if (!wk?.triWorkouts || !wk.rated) continue;
    const weekDeviations: number[] = [];
    for (const workout of wk.triWorkouts) {
      if ((workout.discipline ?? 'run') !== discipline) continue;
      if (!workout.id) continue;
      const expected = (workout as { rpe?: number }).rpe ?? workout.r;
      if (expected == null) continue;
      const rated = wk.rated[workout.id];
      if (typeof rated !== 'number') continue;  // skipped or unrated
      weekDeviations.push(rated - expected);
    }
    if (weekDeviations.length > 0) {
      samples.push(weekDeviations.reduce((a, b) => a + b, 0) / weekDeviations.length);
    }
  }
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/**
 * Per-discipline effort multiplier. Mirrors running's `effortMultiplier`:
 * `1 - score * 0.05`, clamped to [0.85, 1.15].
 */
export function triEffortMultiplier(state: SimulatorState, discipline: Discipline): number {
  const score = triTrailingEffortScore(state, discipline);
  const raw = 1 - score * 0.05;
  return Math.max(TRI_EFFORT_MULT_BOUNDS[0], Math.min(TRI_EFFORT_MULT_BOUNDS[1], raw));
}

/**
 * Apply per-discipline effort multipliers to a list of upcoming triWorkouts
 * by scaling each workout's `estimatedDurationMin`. Mutates in place.
 *
 * Caller invokes this during plan generation/regeneration so each new week
 * reflects the trailing-2-week effort signal.
 */
export function applyTriEffortMultipliers(
  state: SimulatorState,
  workouts: Workout[],
): void {
  const multipliers: Record<Discipline, number> = {
    swim: triEffortMultiplier(state, 'swim'),
    bike: triEffortMultiplier(state, 'bike'),
    run:  triEffortMultiplier(state, 'run'),
  };
  for (const workout of workouts) {
    const d = workout.discipline;
    if (d !== 'swim' && d !== 'bike' && d !== 'run') continue;
    if (!workout.estimatedDurationMin || workout.estimatedDurationMin <= 0) continue;
    const mult = multipliers[d];
    if (mult === 1.0) continue;
    workout.estimatedDurationMin = Math.round(workout.estimatedDurationMin * mult);
  }
}
