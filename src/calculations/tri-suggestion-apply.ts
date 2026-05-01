/**
 * Apply accepted suggestion mods to `state.wks[*].triWorkouts`.
 *
 * Mirrors how running-side `mergeTimingMods` mutates `wk.workoutMods`. For
 * tri we mutate the planned workouts directly (mark replaced/reduced, attach
 * a `modReason`) so the plan engine and the matcher both see the change.
 *
 * **Side of the line**: planning. Mutates state. Caller must `saveState()`.
 */

import type { SimulatorState, Workout } from '@/types/state';
import type { TriSuggestionMod } from './tri-suggestion-aggregator';

export interface ApplyResult {
  applied: number;
  skipped: number;
  /** Workout IDs touched, useful for the modal's "applied X mods" toast. */
  touched: string[];
}

export function applyTriSuggestions(state: SimulatorState, mods: TriSuggestionMod[]): ApplyResult {
  let applied = 0;
  let skipped = 0;
  const touched: string[] = [];

  for (const mod of mods) {
    if (!mod.targetWorkoutId) { skipped += 1; continue; }
    const workout = findWorkoutById(state, mod.targetWorkoutId);
    if (!workout) { skipped += 1; continue; }

    switch (mod.action) {
      case 'swap_easy':
        // Replace with easy/recovery of same discipline + matching duration.
        applySwapEasy(workout, mod);
        applied += 1;
        touched.push(workout.id ?? '');
        break;
      case 'downgrade_today':
        // Drop one intensity tier (threshold→tempo, vo2→threshold, tempo→endurance).
        applyDowngrade(workout, mod);
        applied += 1;
        touched.push(workout.id ?? '');
        break;
      case 'trim_volume': {
        // Reduce planned duration by ~15-25% (volume-ramp violations).
        applyTrim(workout, mod);
        applied += 1;
        touched.push(workout.id ?? '');
        break;
      }
    }
  }

  return { applied, skipped, touched };
}

function findWorkoutById(state: SimulatorState, id: string): Workout | undefined {
  for (const wk of state.wks ?? []) {
    const w = wk.triWorkouts?.find(x => x.id === id);
    if (w) return w;
  }
  return undefined;
}

function applySwapEasy(workout: Workout, mod: TriSuggestionMod): void {
  workout.status = 'replaced';
  workout.modReason = `Swapped to easy — ${mod.source === 'rpe_blown' ? 'high RPE yesterday' : 'low readiness'}`;
  workout.originalName = workout.originalName ?? workout.n;
  workout.t = workout.discipline === 'swim' ? 'swim_endurance'
    : workout.discipline === 'bike' ? 'bike_endurance'
    : 'easy';
  workout.n = `Easy ${capitalize(workout.discipline ?? 'session')}`;
  // Cut planned duration by 25% so the easy version is meaningfully lighter.
  if (workout.estimatedDurationMin) {
    workout.estimatedDurationMin = Math.round(workout.estimatedDurationMin * 0.75);
  }
}

function applyDowngrade(workout: Workout, mod: TriSuggestionMod): void {
  workout.status = 'reduced';
  workout.modReason = mod.source === 'readiness' ? 'Readiness downgrade' : 'Manage load';
  workout.originalName = workout.originalName ?? workout.n;
  // One tier down on intensity.
  const t = (workout.t ?? '').toLowerCase();
  if (t.includes('vo2')) {
    workout.t = workout.discipline === 'bike' ? 'bike_threshold' : 'threshold';
    workout.n = `${capitalize(workout.discipline ?? 'session')} threshold (downgrade)`;
  } else if (t.includes('threshold')) {
    workout.t = workout.discipline === 'bike' ? 'bike_tempo' : 'tempo';
    workout.n = `${capitalize(workout.discipline ?? 'session')} tempo (downgrade)`;
  } else if (t.includes('tempo') || t.includes('sweet')) {
    workout.t = workout.discipline === 'bike' ? 'bike_endurance' : 'easy';
    workout.n = `Easy ${capitalize(workout.discipline ?? 'session')} (downgrade)`;
  }
}

function applyTrim(workout: Workout, _mod: TriSuggestionMod): void {
  workout.status = 'reduced';
  workout.modReason = 'Volume ramp trim';
  workout.originalName = workout.originalName ?? workout.n;
  if (workout.estimatedDurationMin) {
    workout.estimatedDurationMin = Math.round(workout.estimatedDurationMin * 0.85);
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
