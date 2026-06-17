/**
 * Per-discipline volume helpers. Feed the live race-day projection.
 *
 * **Side of the line**: tracking. These functions look at completed swim/bike/
 * run activities and produce numbers consumed by `calculateTriLiveForecast`
 * and `applyDurabilityCap`. Pure functions; no state mutation.
 *
 * Three primary outputs:
 *   - `recentHoursByDiscipline(state, weeks)`. Weekly avg hours per discipline.
 *     Drives the horizon adjuster's `sessions_per_week` scaling.
 *   - `sessionsPerWeekByDiscipline(state, weeks)`. Average session count.
 *   - `longestSessionByDiscipline(state, weeks)`. Max single-session duration
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

interface RecentActual {
  activityType?: string | null;
  startTime?: string | null;
  durationSec?: number | null;
  distanceKm?: number | null;
}

/**
 * Iterate the last `weeks` of `state.wks[w].garminActuals` newest-first, then
 * top up from `state.recentDisciplineActivity` — the slim DB-backed summary
 * persisted at launch. After a fresh sign-in `garminActuals` is empty until
 * activities re-match forward, so without this fallback every per-discipline
 * volume/longest signal reads 0 (the Endurance readiness card collapsed across
 * all disciplines). The fallback is date-windowed to the same `weeks` span and
 * deduped against the actuals already yielded (same sport, start within ±10
 * min) so an actively-syncing user — whose summary largely duplicates
 * garminActuals — sees no change.
 */
function* iterateRecentActuals(state: SimulatorState, weeks: number): Generator<RecentActual> {
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const startWeek = Math.max(0, currentWeek - weeks);
  // Track yielded (sport, startMs) so the persisted fallback can skip overlaps.
  const yielded: Array<{ sport: string; ms: number }> = [];
  const TEN_MIN_MS = 10 * 60 * 1000;
  for (let w = currentWeek; w >= startWeek; w--) {
    const wk = wks[w];
    if (!wk) continue;
    const actuals = wk.garminActuals;
    if (!actuals) continue;
    for (const actual of Object.values(actuals)) {
      if (!actual?.activityType) continue;
      if (actual.startTime) {
        const ms = Date.parse(actual.startTime);
        if (isFinite(ms)) yielded.push({ sport: classifyActivity(actual.activityType), ms });
      }
      yield actual;
    }
  }
  // Sign-in-resilient fallback. Only entries within the `weeks` window that
  // aren't already covered by garminActuals.
  const persisted = state.recentDisciplineActivity ?? [];
  if (persisted.length > 0) {
    const cutoffMs = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
    for (const a of persisted) {
      if (!a.activityType || !a.startTime) continue;
      const ms = Date.parse(a.startTime);
      if (!isFinite(ms) || ms < cutoffMs) continue;
      const sport = classifyActivity(a.activityType);
      const isDup = yielded.some(y => y.sport === sport && Math.abs(y.ms - ms) <= TEN_MIN_MS);
      if (isDup) continue;
      yield a;
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
 * doing per week". Which is the right input for projecting race-day fitness.
 *
 * Defaults to a 4-week look-ahead window. Past weeks (`w < state.w`) are
 * skipped; if fewer than 4 future weeks remain (race week, taper) we average
 * over what's available.
 *
 * `startOffset` skips that many weeks ahead of the current week before
 * sampling. The injury-aware predictor uses it to sample the **recovered**
 * dose (past every restricted discipline's resume week) rather than the
 * injured transition weeks, which would understate the steady-state plan.
 */
export function plannedSessionsPerWeekByDiscipline(
  state: SimulatorState,
  weeks: number = 4,
  startOffset: number = 0,
): VolumePerDiscipline {
  const counts: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  const wks = state.wks ?? [];
  const currentWeek = (state.w ?? 0) + Math.max(0, Math.floor(startOffset));
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
 * Average weekly hours per discipline from the **planned** upcoming weeks
 * (`triWorkouts`), summing each workout's `durationMin` per discipline.
 * Drives the race-readiness "dose" signal. Captures that 5 short bike
 * sessions/wk ≠ 5 long bike sessions/wk (same session count, very different
 * volume). Falls back to 0 for weeks with no `triWorkouts` entries.
 *
 * Defaults to a 4-week look-ahead window (matches `plannedSessionsPerWeekByDiscipline`).
 * `startOffset` behaves identically. Skips ahead to sample the recovered dose.
 */
export function plannedHoursPerWeekByDiscipline(
  state: SimulatorState,
  weeks: number = 4,
  startOffset: number = 0,
): VolumePerDiscipline {
  const totals: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  const wks = state.wks ?? [];
  const currentWeek = (state.w ?? 0) + Math.max(0, Math.floor(startOffset));
  let weeksCovered = 0;
  for (let w = currentWeek; w < wks.length && weeksCovered < weeks; w++) {
    const wk = wks[w];
    if (!wk?.triWorkouts) continue;
    weeksCovered += 1;
    for (const workout of wk.triWorkouts) {
      const d = workout.discipline;
      const minutes = workout.estimatedDurationMin ?? 0;
      if (d === 'swim' || d === 'bike' || d === 'run') totals[d] += minutes / 60;
    }
  }
  const divisor = Math.max(1, weeksCovered);
  return {
    swim: totals.swim / divisor,
    bike: totals.bike / divisor,
    run:  totals.run / divisor,
  };
}

/**
 * Planned per-discipline dose (sessions/wk AND hours/wk) averaged across every
 * remaining BUILD week of the plan — each upcoming week whose phase is not
 * `'taper'`. This is the dose the race-day projection should gain fitness at:
 * the true mean training commitment the plan delivers between now and race day,
 * not just the next few (often base-phase) weeks.
 *
 * Why not the next-4-week window (`plannedSessions/HoursPerWeekByDiscipline`)?
 * The horizon adjuster gains fitness at a constant `sessions_per_week` over the
 * weeks remaining. Early in a plan the 4-week look-ahead sits entirely in the
 * low-volume base phase, so the horizon under-credits the build AND the
 * durability execution factor stays low — which drags the projected bike/run
 * via the durability cap (a demonstrated 36 km/h cyclist projected ~34). The
 * full plan ramp is already encoded in `state.wks[w].triWorkouts`; averaging the
 * remaining build captures the dose the plan actually prescribes.
 *
 * Taper weeks are excluded from the *dose average only*. They represent
 * freshness, not build dose (Mujika 2002), so a low-volume taper week must not
 * drag the build dose down. This does NOT shed projected fitness: the horizon
 * model consolidates taper separately (its own `taper_weeks` term) and the
 * predictor's `executionFactor → 0` inside the taper window already pins
 * projected == current. Intra-cycle recovery weeks are also labelled `'taper'`
 * (block-cycle deloads) and are likewise excluded — a deload isn't the build
 * commitment either. A week with no `ph` set is treated as build (counted).
 *
 * `startOffset` skips that many weeks ahead before sampling (injury-recovery
 * dose sampling), matching `plannedSessions/HoursPerWeekByDiscipline`.
 *
 * Falls back to the 4-week look-ahead when no build weeks remain (deep in the
 * final taper) so the dose is never zero. Near taper the `executionFactor → 0`
 * collapses projected onto current regardless, so the fallback value is inert.
 */
export function plannedBuildDoseByDiscipline(
  state: SimulatorState,
  startOffset: number = 0,
): { sessions: VolumePerDiscipline; hours: VolumePerDiscipline } {
  const counts: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  const hours: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  const wks = state.wks ?? [];
  const startWeek = (state.w ?? 0) + Math.max(0, Math.floor(startOffset));
  let buildWeeks = 0;
  for (let w = startWeek; w < wks.length; w++) {
    const wk = wks[w];
    if (!wk?.triWorkouts) continue;
    if (wk.ph === 'taper') continue; // freshness, not build dose (Mujika 2002)
    buildWeeks += 1;
    for (const workout of wk.triWorkouts) {
      const d = workout.discipline;
      if (d !== 'swim' && d !== 'bike' && d !== 'run') continue;
      counts[d] += 1;
      hours[d] += (workout.estimatedDurationMin ?? 0) / 60;
    }
  }
  if (buildWeeks === 0) {
    // Deep in the final taper — no build weeks left to sample. Fall back to the
    // immediate look-ahead so the dose is never zero.
    return {
      sessions: plannedSessionsPerWeekByDiscipline(state, 4, startOffset),
      hours: plannedHoursPerWeekByDiscipline(state, 4, startOffset),
    };
  }
  return {
    sessions: { swim: counts.swim / buildWeeks, bike: counts.bike / buildWeeks, run: counts.run / buildWeeks },
    hours:    { swim: hours.swim / buildWeeks,  bike: hours.bike / buildWeeks,  run: hours.run / buildWeeks },
  };
}

/**
 * Planned per-discipline PEAK dose (sessions/wk AND hours/wk) — the sustained
 * volume the plan holds the athlete at approaching the race. This is the dose
 * the specific-endurance / race-readiness penalty CLOSURE should see, distinct
 * from the build-phase mean that drives the fitness-gain horizon.
 *
 * Two-term decomposition (mirrors the running forecast fix, per discipline):
 *   - cumulative training dose → engine/fitness gain → `plannedBuildDoseByDiscipline`
 *     (the dose integral over the block — the mean).
 *   - race-approach sustained volume → specific-endurance readiness → THIS helper
 *     (the peak the plan holds). Race-distance readiness is a function of the
 *     highest sustained volume reached, not the block average.
 *
 * Peak is read directly from the planned weeks (no invented constant):
 *   1. The mean dose over `ph === 'peak'` weeks, when the plan labels a peak
 *      phase (robust to a single outlier week).
 *   2. Else the max single non-taper week (short plans with no labelled peak).
 *   3. Else the build-dose fallback (deep in the final taper — inert, since the
 *      predictor's executionFactor → 0 pins projected to current there anyway).
 *
 * `startOffset` matches the other planned-dose helpers (injury-recovery sampling).
 */
export function plannedPeakDoseByDiscipline(
  state: SimulatorState,
  startOffset: number = 0,
): { sessions: VolumePerDiscipline; hours: VolumePerDiscipline } {
  const wks = state.wks ?? [];
  const startWeek = (state.w ?? 0) + Math.max(0, Math.floor(startOffset));
  const disciplines = ['swim', 'bike', 'run'] as const;
  const peakSess: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  const peakHrs: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  let peakWeeks = 0;
  const maxSess: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  const maxHrs: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
  let sawBuildWeek = false;
  for (let w = startWeek; w < wks.length; w++) {
    const wk = wks[w];
    if (!wk?.triWorkouts) continue;
    if (wk.ph === 'taper') continue; // freshness, not build dose (Mujika 2002)
    sawBuildWeek = true;
    const sess: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
    const hrs: VolumePerDiscipline = { swim: 0, bike: 0, run: 0 };
    for (const workout of wk.triWorkouts) {
      const d = workout.discipline;
      if (d !== 'swim' && d !== 'bike' && d !== 'run') continue;
      sess[d] += 1;
      hrs[d] += (workout.estimatedDurationMin ?? 0) / 60;
    }
    for (const d of disciplines) {
      if (sess[d] > maxSess[d]) maxSess[d] = sess[d];
      if (hrs[d] > maxHrs[d]) maxHrs[d] = hrs[d];
    }
    if (wk.ph === 'peak') {
      peakWeeks += 1;
      for (const d of disciplines) { peakSess[d] += sess[d]; peakHrs[d] += hrs[d]; }
    }
  }
  if (!sawBuildWeek) return plannedBuildDoseByDiscipline(state, startOffset);
  if (peakWeeks > 0) {
    return {
      sessions: { swim: peakSess.swim / peakWeeks, bike: peakSess.bike / peakWeeks, run: peakSess.run / peakWeeks },
      hours:    { swim: peakHrs.swim / peakWeeks,  bike: peakHrs.bike / peakWeeks,  run: peakHrs.run / peakWeeks },
    };
  }
  return { sessions: maxSess, hours: maxHrs };
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
