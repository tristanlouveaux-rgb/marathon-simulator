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
import { scoreRepAdherence, repAdherenceToEffortDev } from './rep-adherence';

/**
 * Per-discipline trailing effortScore over the last
 * `TRI_EFFORT_LOOKBACK_WEEKS` completed weeks. Skipped workouts excluded.
 *
 * For bike: blends objective power adherence (60%) with subjective RPE (40%)
 * when power data is available; falls back to HR (60%) + RPE (40%) when only
 * HR is available; pure RPE otherwise. Mirrors running's HR+RPE blend in
 * `events.ts` but uses power as the primary objective signal for cycling
 * (Coggan & Allen 2019: power is more reliable than HR for intensity control).
 *
 * For swim/run: pure RPE (swim has no reliable pace-adherence signal yet;
 * run re-uses the running-side HR+RPE blend in events.ts).
 *
 * effortScore scale: positive = harder than planned → shorter next week.
 *                    negative = easier than planned → longer next week.
 * Returns 0 when there's no data (= neutral, multiplier 1.0).
 */
export function triTrailingEffortScore(state: SimulatorState, discipline: Discipline): number {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const samples: number[] = [];
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
      if (typeof rated !== 'number') continue;
      const rpeDev = rated - expected;
      const actual = wk.garminActuals?.[workout.matchedActivityId ?? ''];

      // Under-duration guard: if actual was < 80% of planned, don't let low RPE
      // inflate next week — the session was cut short, not genuinely easy.
      const plannedMin = workout.estimatedDurationMin;
      const actualMin = actual ? actual.durationSec / 60 : null;
      const underDuration = plannedMin != null && actualMin != null && actualMin < plannedMin * 0.8;

      let dev: number;
      if (discipline === 'bike') {
        // Signal priority for bike effort:
        //   1. Per-rep power adherence (rep-level scoring) — sharpest signal
        //      because it scores each interval against its own target rather
        //      than averaging the whole ride.
        //   2. Whole-session powerAdherence — fallback when no clean rep
        //      structure was detected.
        //   3. HR effort score — fallback when no power meter.
        //   4. Pure RPE — final fallback.
        // Per-rep wins because a 5×5min @ FTP ride averaged with warmup +
        // cooldown reads as IF ~0.7 even when every rep was on target;
        // scoring at the rep level avoids that dilution.
        let bikeObjectiveDev: number | null = null;
        if (actual?.repData && actual.repData.reps.length > 0) {
          const ftp = state.onboarding?.triBike?.ftp;
          const scored = scoreRepAdherence({
            workout: workout as Workout,
            actual,
            discipline: 'bike',
            ftp,
          });
          if (scored) bikeObjectiveDev = repAdherenceToEffortDev(scored);
        }
        if (bikeObjectiveDev == null && actual?.powerAdherence != null) {
          bikeObjectiveDev = (actual.powerAdherence - 1.0) * 10;
        }
        if (bikeObjectiveDev == null && actual?.hrEffortScore != null) {
          bikeObjectiveDev = (actual.hrEffortScore - 1.0) * 10;
        }
        dev = bikeObjectiveDev != null
          ? rpeDev * 0.4 + bikeObjectiveDev * 0.6
          : rpeDev;
      } else {
        dev = rpeDev;
      }

      // Negative dev → easier than planned → would inflate next week. Only allow
      // inflation when the session was completed at/above planned duration.
      weekDeviations.push(underDuration ? Math.max(0, dev) : dev);
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
