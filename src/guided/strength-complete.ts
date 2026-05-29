/**
 * Mode-agnostic strength-session completion. Writes `wk.rated[workoutId] = rpe`
 * via the existing `rate()` function (events.ts). The field every mode's plan
 * view reads to render "done". Passing `expected === rpe` makes `rate()` skip
 * its running-specific VDOT adjustment, so a gym RPE never moves a runner's
 * VDOT. Mirrors what the running gym "Mark Done" button already does.
 *
 * Used by:
 * - the quick "Mark as done" action on any strength card / modal, and
 * - the guided-session finish (passes the user's 1-tap RPE + measured duration).
 *
 * Measured duration is logged to the console for now; persistence of the
 * measured value beyond the prescribed `estimatedDurationMin` is a follow-up.
 */

import type { Workout } from '@/types';
import { rate } from '@/ui/events';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { applyHyroxSessionBenchmarks } from '@/calculations/hyrox-session-benchmarks';
import type { SetRecord } from './strength-controller';

export interface CompleteStrengthOpts {
  /** RPE the user actually rated; defaults to the workout's prescribed RPE so
   *  the quick "Mark as done" path produces no VDOT shift (expected === rpe). */
  rpe?: number;
  /** Actually-measured session duration in seconds, when available (e.g. from
   *  the guided overlay's elapsed clock). Logged for now. */
  durationSec?: number;
  /** Target week (1-based). Defaults to the current week. */
  targetWeek?: number;
  /** Per-set / per-station time records captured by the guided overlay. For
   *  HYROX workouts these feed `stationBenchmarkHistory` so the prediction
   *  model picks up the measured times. */
  records?: SetRecord[];
}

export function completeStrengthSession(workout: Workout, opts: CompleteStrengthOpts = {}): void {
  const id = (workout as any).id ?? workout.n;
  const prescribed = (workout.rpe ?? workout.r ?? 5) as number;
  const chosen = typeof opts.rpe === 'number' ? opts.rpe : prescribed;
  const type = workout.t || 'gym';

  // `expected === chosen` => rpeDif=0 => no VDOT/efficiency change for gym.
  rate(id, workout.n, chosen, chosen, type, false, undefined, opts.targetWeek);

  if (typeof opts.durationSec === 'number' && opts.durationSec > 0) {
    const mins = Math.round(opts.durationSec / 60);
    // eslint-disable-next-line no-console
    console.log(`[strength] completed ${workout.n}: ${mins} min, RPE ${chosen}`);
  }

  // HYROX: learn from the session. Only race-pace sessions (density, brick)
  // improve a station benchmark, PB-only, using the best round per station and a
  // sanity floor. Technique (65% pace) is excluded. See SCIENCE_LOG §AP.
  if (opts.records && opts.records.length) {
    const state = getMutableState();
    const applied = applyHyroxSessionBenchmarks(workout, opts.records, state);
    if (applied.length) {
      saveState();
      for (const u of applied) {
        // eslint-disable-next-line no-console
        console.log(`[hyrox session-bench] ${u.displayName}: ${u.fromSec ?? '—'}s → ${u.toSec}s (best round beat the benchmark)`);
      }
    }
  }
}
