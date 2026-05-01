/**
 * Triathlon skip handler — push to next week, drop on second skip.
 *
 * Mirrors the established race-mode running rule: a missed workout slides to
 * next week on the first skip; a second skip drops the workout permanently
 * and the prediction reflects it via `tri-adherence.ts`'s adherence penalty.
 *
 * **Side of the line**: planning. Mutates `state.wks[*].triWorkouts`.
 *
 * Usage:
 *   import { skipTriWorkout } from '@/calculations/tri-skip-handler';
 *   skipTriWorkout(state, workoutId);
 *
 * Caller is responsible for `saveState()` after.
 */

import type { SimulatorState, Workout } from '@/types/state';

export interface SkipResult {
  outcome: 'pushed' | 'dropped' | 'not-found';
  workoutId: string;
  /** When `pushed`, the index of the destination week. */
  pushedToWeek?: number;
}

export function skipTriWorkout(state: SimulatorState, workoutId: string): SkipResult {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const wk = wks[currentWeek];
  const workouts = wk?.triWorkouts;
  if (!workouts) return { outcome: 'not-found', workoutId };

  const idx = workouts.findIndex(w => w.id === workoutId);
  if (idx < 0) return { outcome: 'not-found', workoutId };

  const workout = workouts[idx];
  const priorSkipCount = workout.skipCount ?? 0;
  const newSkipCount = priorSkipCount + 1;

  // Mark as skipped regardless of outcome — adherence penalty picks this up.
  workout.status = 'skipped';
  workout.skipCount = newSkipCount;

  if (newSkipCount === 1) {
    // First skip: push a clone to next week.
    const nextWk = wks[currentWeek + 1];
    if (!nextWk) {
      // No next week available (e.g. race week or last plan week) — drop.
      return { outcome: 'dropped', workoutId };
    }
    if (!nextWk.triWorkouts) nextWk.triWorkouts = [];

    const clone: Workout = {
      ...workout,
      id: `${workout.id}__push${newSkipCount}`,
      status: 'planned',
      skipCount: 0,                  // Reset for next week's tracking
      originalName: workout.originalName ?? workout.n,
      dayOfWeek: pickFreeDayOfWeek(workout.dayOfWeek, nextWk.triWorkouts),
    };
    nextWk.triWorkouts.push(clone);

    return { outcome: 'pushed', workoutId, pushedToWeek: currentWeek + 1 };
  }

  // Second or later skip: drop. Already marked `'skipped'` above.
  return { outcome: 'dropped', workoutId };
}

/**
 * Prefer the workout's original day-of-week if free in the destination week,
 * otherwise pick the first available day. Returns the chosen day-of-week
 * (0=Mon..6=Sun).
 */
function pickFreeDayOfWeek(preferredDow: number | undefined, existing: Workout[]): number {
  const usedDays = new Set(existing.map(w => w.dayOfWeek).filter((d): d is number => d != null));
  if (preferredDow != null && !usedDays.has(preferredDow)) return preferredDow;
  // Fallback: first free day in 0..6 order.
  for (let d = 0; d < 7; d++) {
    if (!usedDays.has(d)) return d;
  }
  // All slots taken — keep preferred (caller may need to merge).
  return preferredDow ?? 0;
}
