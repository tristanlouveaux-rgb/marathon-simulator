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
import type { SimulatorState } from '@/types/state';
import { rate } from '@/ui/events';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { applyHyroxSessionBenchmarks, buildHyroxSessionRecap } from '@/calculations/hyrox-session-benchmarks';
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

  // HYROX: learn from the session + log it as an activity.
  if (opts.records && opts.records.length) {
    const state = getMutableState();
    let dirty = false;

    // (1) Learn: only race-pace sessions (density, brick) improve a station
    // benchmark, PB-only, best round per station, with a sanity floor. Technique
    // (65% pace) is excluded. See SCIENCE_LOG §AP.
    const applied = applyHyroxSessionBenchmarks(workout, opts.records, state);
    if (applied.length) {
      dirty = true;
      for (const u of applied) {
        // eslint-disable-next-line no-console
        console.log(`[hyrox session-bench] ${u.displayName}: ${u.fromSec ?? '—'}s → ${u.toSec}s (best round beat the benchmark)`);
      }
    }

    // (2) Log: record the session as a completed activity so it appears in
    // history and a later watch/Strava sync of the same session upgrades it
    // (mirrors the Strava-beats-Garmin rule) instead of double-counting.
    if (logGuidedHyroxActivity(workout, opts.records, opts.durationSec ?? 0, opts.targetWeek, state)) dirty = true;

    if (dirty) saveState();
  }
}

/**
 * Write a guided HYROX session to `wk.garminActuals` as a completed activity.
 * `garminId` is `'guided-…'` so the matcher can tell it apart from a synced
 * activity and upgrade it later. Does not clobber an existing richer (synced)
 * actual. Returns true if it wrote.
 */
function logGuidedHyroxActivity(
  workout: Workout,
  records: SetRecord[],
  durationSec: number,
  targetWeek: number | undefined,
  state: SimulatorState,
): boolean {
  const recap = buildHyroxSessionRecap(workout, records);
  if (!recap) return false; // non-HYROX or nothing measured

  const weekIdx = (targetWeek ?? state.w) - 1;
  const wk = state.wks?.[weekIdx];
  if (!wk) return false;

  const workoutId = (workout as any).id ?? workout.n;
  if (!wk.garminActuals) wk.garminActuals = {};
  const existing = wk.garminActuals[workoutId];
  // A synced activity (non-guided garminId) already present wins — don't overwrite.
  if (existing && !String(existing.garminId).startsWith('guided-')) return false;

  const distanceKm = recap.runs.reduce((sum, r) => sum + r.distanceM / 1000, 0);
  wk.garminActuals[workoutId] = {
    garminId: `guided-${Date.now()}`,
    startTime: new Date().toISOString(),
    distanceKm,
    durationSec: Math.max(0, Math.round(durationSec)),
    avgPaceSecKm: null,
    avgHR: null,
    maxHR: null,
    calories: null,
    activityType: 'hyrox',
    plannedType: workout.t ?? null,
    workoutName: workout.n,
    displayName: workout.n,
    hyroxSession: recap,
  };
  return true;
}
