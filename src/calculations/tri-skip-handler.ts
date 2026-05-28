/**
 * Triathlon push / drop handler — explicit user actions on a missed workout.
 *
 * Mirrors the established race-mode running rule: a missed workout may be
 * moved forward by one week, or dropped permanently. A workout cannot be
 * pushed twice — once a clone exists in next week, the only remaining
 * action is to drop. Adherence-penalised by `tri-adherence.ts` when the
 * status is `'skipped'`.
 *
 * **Side of the line**: planning. Mutates `state.wks[*].triWorkouts`.
 *
 * Usage:
 *   import { pushTriWorkout, dropTriWorkout } from '@/calculations/tri-skip-handler';
 *   pushTriWorkout(state, workoutId);
 *   dropTriWorkout(state, workoutId);
 *
 * Caller is responsible for `saveState()` after.
 */

import type { SimulatorState, Workout } from '@/types/state';

export interface SkipResult {
  outcome: 'pushed' | 'dropped' | 'not-found' | 'already-pushed';
  workoutId: string;
  /** When `pushed`, the index of the destination week. */
  pushedToWeek?: number;
}

/**
 * Push a missed workout to next week. Allowed once per lineage —
 * `pushCount >= 1` returns `'already-pushed'` and the caller must drop instead.
 */
export function pushTriWorkout(state: SimulatorState, workoutId: string): SkipResult {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const wk = wks[currentWeek];
  const workouts = wk?.triWorkouts;
  if (!workouts) return { outcome: 'not-found', workoutId };

  const idx = workouts.findIndex(w => w.id === workoutId);
  if (idx < 0) return { outcome: 'not-found', workoutId };

  const workout = workouts[idx];
  const priorPushCount = workout.pushCount ?? 0;

  // Once pushed already, the only remaining action is drop.
  if (priorPushCount >= 1) {
    return { outcome: 'already-pushed', workoutId };
  }

  const nextWk = wks[currentWeek + 1];
  if (!nextWk) {
    // No next week available (e.g. race week) — fall back to drop semantics.
    workout.status = 'skipped';
    workout.skipCount = (workout.skipCount ?? 0) + 1;
    return { outcome: 'dropped', workoutId };
  }
  if (!nextWk.triWorkouts) nextWk.triWorkouts = [];

  // Mark original as skipped — but pushCount stays on original AND propagates
  // to the clone so the lineage can't be pushed again.
  const newPushCount = priorPushCount + 1;
  workout.status = 'skipped';
  workout.skipCount = (workout.skipCount ?? 0) + 1;
  workout.pushCount = newPushCount;

  // Strip execution-specific fields so the clone is treated as a fresh planned
  // workout in the destination week (not auto-marked done via a stale match).
  const {
    matchedActivityId: _m,
    iTrimp: _i,
    stravaId: _s,
    autoCompleted: _ac,
    completedBySport: _cb,
    ...rest
  } = workout;
  const clone: Workout = {
    ...rest,
    id: `${workout.id}__push${newPushCount}`,
    status: 'planned',
    skipCount: 0,                  // Reset per-week skip tracking
    pushCount: newPushCount,       // Carry lineage forward — clone can't be pushed again
    originalName: workout.originalName ?? workout.n,
    dayOfWeek: pickFreeDayOfWeek(workout.dayOfWeek, nextWk.triWorkouts),
  };
  nextWk.triWorkouts.push(clone);

  return { outcome: 'pushed', workoutId, pushedToWeek: currentWeek + 1 };
}

/**
 * Drop a workout permanently. Marks it as `'skipped'` so the adherence
 * model picks it up as a missed session.
 */
export function dropTriWorkout(state: SimulatorState, workoutId: string): SkipResult {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const wk = wks[currentWeek];
  const workouts = wk?.triWorkouts;
  if (!workouts) return { outcome: 'not-found', workoutId };

  const idx = workouts.findIndex(w => w.id === workoutId);
  if (idx < 0) return { outcome: 'not-found', workoutId };

  const workout = workouts[idx];
  workout.status = 'skipped';
  workout.skipCount = (workout.skipCount ?? 0) + 1;
  return { outcome: 'dropped', workoutId };
}

/**
 * @deprecated Kept for backwards compatibility with any older callers — prefer
 * the explicit `pushTriWorkout` / `dropTriWorkout` pair. First call pushes,
 * subsequent calls on the same lineage drop.
 */
export function skipTriWorkout(state: SimulatorState, workoutId: string): SkipResult {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const workouts = wks[currentWeek]?.triWorkouts;
  if (!workouts) return { outcome: 'not-found', workoutId };
  const workout = workouts.find(w => w.id === workoutId);
  if (!workout) return { outcome: 'not-found', workoutId };

  const priorPushCount = workout.pushCount ?? 0;
  if (priorPushCount >= 1) return dropTriWorkout(state, workoutId);
  const result = pushTriWorkout(state, workoutId);
  if (result.outcome === 'already-pushed') return dropTriWorkout(state, workoutId);
  return result;
}

/**
 * Prefer the workout's original day-of-week if free in the destination week,
 * otherwise pick the first available day. Returns the chosen day-of-week
 * (0=Mon..6=Sun).
 */
function pickFreeDayOfWeek(preferredDow: number | undefined, existing: Workout[]): number {
  const usedDays = new Set(existing.map(w => w.dayOfWeek).filter((d): d is number => d != null));
  if (preferredDow != null && !usedDays.has(preferredDow)) return preferredDow;
  for (let d = 0; d < 7; d++) {
    if (!usedDays.has(d)) return d;
  }
  return preferredDow ?? 0;
}
