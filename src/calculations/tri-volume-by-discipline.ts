/**
 * Per-discipline volume helpers — feed the live race-day projection.
 *
 * **Side of the line**: tracking. These functions look at completed swim/bike/
 * run activities and produce numbers consumed by `calculateTriLiveForecast`
 * and `applyDurabilityCap`. Pure functions; no state mutation.
 *
 * Three primary outputs:
 *   - `recentHoursByDiscipline(state, weeks)` — weekly avg hours per discipline.
 *     Drives the horizon adjuster's `sessions_per_week` scaling.
 *   - `sessionsPerWeekByDiscipline(state, weeks)` — average session count.
 *   - `longestSessionByDiscipline(state, weeks)` — max single-session duration
 *     per discipline. Drives the run-leg durability cap.
 *
 * The default window is 12 weeks. Tristan confirmed (2026-04-28 plan): long
 * enough to catch consistent training, short enough to track current state.
 */

import type { SimulatorState } from '@/types/state';
import { classifyActivity } from './tri-benchmarks-from-history';

export interface VolumePerDiscipline {
  swim: number;
  bike: number;
  run: number;
}

/** Iterate the last `weeks` of `state.wks[w].garminActuals` newest-first. */
function* iterateRecentActuals(state: SimulatorState, weeks: number) {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const startWeek = Math.max(0, currentWeek - weeks);
  for (let w = currentWeek; w >= startWeek; w--) {
    const wk = wks[w];
    if (!wk) continue;
    const actuals = wk.garminActuals;
    if (!actuals) continue;
    for (const actual of Object.values(actuals)) {
      if (!actual?.activityType) continue;
      yield actual;
    }
  }
}

/**
 * Average weekly hours per discipline over the last `weeks` weeks.
 * Returns 0 for any discipline without activity in the window.
 */
export function recentHoursByDiscipline(
  state: SimulatorState,
  weeks: number = 12,
): VolumePerDiscipline {
  const totals: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  for (const actual of iterateRecentActuals(state, weeks)) {
    const sport = classifyActivity(actual.activityType);
    if (sport === 'other') continue;
    const hours = (actual.durationSec ?? 0) / 3600;
    totals[sport] += hours;
  }
  const divisor = Math.max(1, weeks);
  return {
    swim: totals.swim / divisor,
    bike: totals.bike / divisor,
    run:  totals.run / divisor,
  };
}

/**
 * Average sessions/week per discipline over the last `weeks` weeks.
 * Used as the `sessions_per_week` input to `applyTriHorizon{Swim|Bike|Run}`.
 */
export function sessionsPerWeekByDiscipline(
  state: SimulatorState,
  weeks: number = 12,
): VolumePerDiscipline {
  const counts: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  for (const actual of iterateRecentActuals(state, weeks)) {
    const sport = classifyActivity(actual.activityType);
    if (sport === 'other') continue;
    counts[sport] += 1;
  }
  const divisor = Math.max(1, weeks);
  return {
    swim: counts.swim / divisor,
    bike: counts.bike / divisor,
    run:  counts.run / divisor,
  };
}

/**
 * Average sessions/week per discipline from the **planned** upcoming weeks
 * (`triWorkouts`), not historical activity. Used by the projection's horizon
 * adjuster: "if you stick with the plan, here's how many sessions you'll be
 * doing per week" — which is the right input for projecting race-day fitness.
 *
 * Defaults to a 4-week look-ahead window. Past weeks (`w < state.w`) are
 * skipped; if fewer than 4 future weeks remain (race week, taper) we average
 * over what's available.
 */
export function plannedSessionsPerWeekByDiscipline(
  state: SimulatorState,
  weeks: number = 4,
): VolumePerDiscipline {
  const counts: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  let weeksCovered = 0;
  for (let w = currentWeek; w < wks.length && weeksCovered < weeks; w++) {
    const wk = wks[w];
    if (!wk?.triWorkouts) continue;
    weeksCovered += 1;
    for (const workout of wk.triWorkouts) {
      const d = workout.discipline;
      if (d === 'swim' || d === 'bike' || d === 'run') counts[d] += 1;
    }
  }
  const divisor = Math.max(1, weeksCovered);
  return {
    swim: counts.swim / divisor,
    bike: counts.bike / divisor,
    run:  counts.run / divisor,
  };
}

/**
 * Longest single-session duration (seconds) per discipline in the last
 * `weeks` weeks. Drives the run-leg durability cap.
 */
export function longestSessionByDiscipline(
  state: SimulatorState,
  weeks: number = 12,
): VolumePerDiscipline {
  const maxSec: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  for (const actual of iterateRecentActuals(state, weeks)) {
    const sport = classifyActivity(actual.activityType);
    if (sport === 'other') continue;
    const sec = actual.durationSec ?? 0;
    if (sec > maxSec[sport]) maxSec[sport] = sec;
  }
  return maxSec;
}
