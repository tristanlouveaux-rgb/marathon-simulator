/**
 * Per-discipline effort multiplier. Mirrors running's `effortMultiplier`
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
import { ctlGapMultiplier } from '@/workouts/plan_engine';

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
 * For swim: blends objective pace-vs-CSS adherence (60%) with RPE (40%),
 * mirroring bike (D6, 2026-06-01); falls back to pure RPE when no pace signal.
 * For run: pure RPE here (the run leg re-uses the running-side HR+RPE blend in events.ts).
 *
 * effortScore scale: positive = harder than planned → shorter next week.
 *                    negative = easier than planned → longer next week.
 * Returns 0 when there's no data (= neutral, multiplier 1.0).
 */
export function triTrailingEffortScore(state: SimulatorState, discipline: Discipline): number {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const samples: number[] = [];
  // s.w is 1-based, so wks[currentWeek - 1] is the week in progress. Start at
  // the last COMPLETED week (wks[currentWeek - 2]), as running's
  // getTrailingEffortScore does: a mid-week regeneration or the live plan note
  // must not rescale the current week by its own partial ratings. At rollover
  // the new week is empty, so the result there is unchanged.
  for (let w = currentWeek - 2; w >= 0 && samples.length < TRI_EFFORT_LOOKBACK_WEEKS; w--) {
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
      // inflate next week. The session was cut short, not genuinely easy.
      const plannedMin = workout.estimatedDurationMin;
      const actualMin = actual ? actual.durationSec / 60 : null;
      const underDuration = plannedMin != null && actualMin != null && actualMin < plannedMin * 0.8;

      let dev: number;
      if (discipline === 'bike') {
        // Signal priority for bike effort:
        //   1. Per-rep power adherence (rep-level scoring). Sharpest signal
        //      because it scores each interval against its own target rather
        //      than averaging the whole ride.
        //   2. Whole-session powerAdherence. Fallback when no clean rep
        //      structure was detected.
        //   3. HR effort score. Fallback when no power meter.
        //   4. Pure RPE. Final fallback.
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
      } else if (discipline === 'swim') {
        // Swim mirrors bike's objective + RPE blend (D6, 2026-06-01), but the
        // objective signal is pace-vs-CSS adherence (scoreSwimEffort, persisted as
        // actual.paceAdherence). Sign is INVERTED vs power: lower sec/100m = faster =
        // harder, so faster-than-target (paceAdherence < 1.0) is a positive (harder)
        // deviation. Falls back to pure RPE when no pace signal (e.g. a drill set with
        // no usable distance/duration). Blend 60% objective / 40% RPE, matching bike.
        let swimObjectiveDev: number | null = null;
        if (actual?.paceAdherence != null) {
          swimObjectiveDev = (1.0 - actual.paceAdherence) * 10;
        }
        dev = swimObjectiveDev != null
          ? rpeDev * 0.4 + swimObjectiveDev * 0.6
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
  ctlRatioByDiscipline?: { swim?: number; bike?: number; run?: number },
): void {
  const disciplines: Discipline[] = ['swim', 'bike', 'run'];
  // Per discipline, combine the trailing-effort multiplier with the CTL-gap re-anchor under ONE
  // clamp so the two volume levers can't overstack (mirror of running's plan_engine combined clamp).
  // Floor = the tri effort band's lower bound; CTL-gap is reduce-only so it only pulls down.
  const multipliers: Record<Discipline, number> = { swim: 1, bike: 1, run: 1 };
  for (const d of disciplines) {
    const eff = triEffortMultiplier(state, d);
    const cMult = ctlGapMultiplier(ctlRatioByDiscipline?.[d] ?? 1);
    multipliers[d] = cMult === 1.0
      ? eff
      : Math.max(TRI_EFFORT_MULT_BOUNDS[0], Math.min(TRI_EFFORT_MULT_BOUNDS[1], eff * cMult));
  }
  for (const workout of workouts) {
    const d = workout.discipline;
    if (d !== 'swim' && d !== 'bike' && d !== 'run') continue;
    if (!workout.estimatedDurationMin || workout.estimatedDurationMin <= 0) continue;
    const mult = multipliers[d];
    if (mult === 1.0) continue;
    workout.estimatedDurationMin = Math.round(workout.estimatedDurationMin * mult);
  }
}
