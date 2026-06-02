/**
 * Triathlon onboarding session lever.
 *
 * The triathlon equivalent of running's `forecastForSessions` /
 * `bumpSessionsAndRegen` (plan-preview-v2.ts). It lets the onboarding
 * forecast step add training PER DISCIPLINE (swim / bike / run) and see the
 * predicted finish move, then commit the chosen volume into the real plan.
 *
 * Why per-discipline and not a single "+1 session" like running:
 * the triathlon plan is driven by a TOTAL HOURS budget
 * (`triConfig.timeAvailableHoursPerWeek`) split across disciplines
 * (`triConfig.volumeSplit`), not by an integer session count. There is no
 * single "session" to bump — a swim and a long ride are very different doses.
 * The per-discipline horizon model already discounts each discipline's
 * fitness gain independently, so adding to a weak discipline moves the
 * forecast more than adding to a saturated one. No invented multiplier
 * required — the projection responds to the regenerated planned volume.
 *
 * **Honesty about the unit**: "+1 session" in a discipline is translated into
 * that discipline's representative session length (`TRI_AVG_SESSION_HOURS`,
 * the same constant the generator divides by), so the time cost is real and
 * displayable. The generator caps each discipline at
 * `TRI_MAX_SESSIONS_PER_DISCIPLINE`; the lever respects that cap.
 *
 * **Scope**: onboarding only. The preview clones state and regenerates the
 * plan in memory, preserving the historical activity log by index so current
 * fitness is unchanged and only the projection moves with the added volume.
 * At onboarding the activity log is typically empty, so the preview is exact;
 * for a running→tri switch with history it stays coherent because the log is
 * carried over.
 *
 * This module is pure (no store / controller imports) so it is unit-testable.
 * The side-effecting commit lives in the wizard step (`tri-plan-forecast.ts`),
 * which reuses `computeBumpedVolume` here and then writes onboarding state.
 */

import type { SimulatorState } from '@/types/state';
import type { TriConfig, TriVolumeSplit, Discipline } from '@/types/triathlon';
import { DEFAULT_VOLUME_SPLIT } from '@/constants/triathlon-constants';
import {
  generateTriathlonPlan,
  countSessions,
  TRI_AVG_SESSION_HOURS,
  TRI_MAX_SESSIONS_PER_DISCIPLINE,
} from '@/workouts/plan_engine.triathlon';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { runTriForecastSim } from '@/calculations/race-forecast-simulation.triathlon';

/** Added sessions per discipline (non-negative integers). */
export type TriSessionDelta = { swim: number; bike: number; run: number };

const DISCIPLINES: Discipline[] = ['swim', 'bike', 'run'];

export const ZERO_TRI_DELTA: TriSessionDelta = { swim: 0, bike: 0, run: 0 };

/** Stable key for memoising forecasts by delta. */
export function triDeltaKey(d: TriSessionDelta): string {
  return `${d.swim}-${d.bike}-${d.run}`;
}

function baseHoursByDiscipline(tri: TriConfig): Record<Discipline, number> {
  const H = tri.timeAvailableHoursPerWeek ?? 10;
  const split = tri.volumeSplit ?? { ...DEFAULT_VOLUME_SPLIT };
  return { swim: H * split.swim, bike: H * split.bike, run: H * split.run };
}

/**
 * Steady-state session count per discipline the generator would emit at peak
 * hours. Uses the same `countSessions` math the engine uses, so the numbers
 * the stepper shows match the plan. Returns clean integers.
 */
export function baseTriSessions(tri: TriConfig): TriSessionDelta {
  const hours = baseHoursByDiscipline(tri);
  return {
    swim: countSessions(hours.swim, TRI_AVG_SESSION_HOURS.swim, TRI_MAX_SESSIONS_PER_DISCIPLINE),
    bike: countSessions(hours.bike, TRI_AVG_SESSION_HOURS.bike, TRI_MAX_SESSIONS_PER_DISCIPLINE),
    run:  countSessions(hours.run,  TRI_AVG_SESSION_HOURS.run,  TRI_MAX_SESSIONS_PER_DISCIPLINE),
  };
}

/**
 * How many sessions each discipline can still add before hitting the cap.
 * Drives the +/- stepper bounds.
 */
export function maxAddTriSessions(tri: TriConfig): TriSessionDelta {
  const base = baseTriSessions(tri);
  return {
    swim: Math.max(0, TRI_MAX_SESSIONS_PER_DISCIPLINE - base.swim),
    bike: Math.max(0, TRI_MAX_SESSIONS_PER_DISCIPLINE - base.bike),
    run:  Math.max(0, TRI_MAX_SESSIONS_PER_DISCIPLINE - base.run),
  };
}

/**
 * Translate a per-discipline session delta into a new hours budget + volume
 * split. Disciplines without a delta keep their absolute hours; the bumped
 * discipline's hours are set so the generator emits exactly the target session
 * count (target * avg-session-hours). The split is then re-derived from the
 * new absolute hours so the total grows by only the added time.
 *
 * Pure. Used by both the in-memory preview and the persisted commit so the
 * two never diverge.
 */
export function computeBumpedVolume(
  tri: TriConfig,
  delta: TriSessionDelta,
): { volumeSplit: TriVolumeSplit; timeAvailableHoursPerWeek: number } {
  const base = baseHoursByDiscipline(tri);
  const baseN = baseTriSessions(tri);
  const newHours: Record<Discipline, number> = { ...base };

  for (const d of DISCIPLINES) {
    const add = Math.max(0, Math.floor(delta[d] ?? 0));
    if (add <= 0) continue;
    const targetN = Math.min(TRI_MAX_SESSIONS_PER_DISCIPLINE, baseN[d] + add);
    // Never shrink: a discipline's base hours can already overshoot what the
    // session count needs (the split allocates more time than cap*avg). Only
    // grow toward the target. A discipline already at cap is a no-op.
    newHours[d] = Math.max(newHours[d], targetN * TRI_AVG_SESSION_HOURS[d]);
  }

  const Hnew = newHours.swim + newHours.bike + newHours.run;
  if (Hnew <= 0) {
    return {
      volumeSplit: tri.volumeSplit ?? { ...DEFAULT_VOLUME_SPLIT },
      timeAvailableHoursPerWeek: tri.timeAvailableHoursPerWeek ?? 10,
    };
  }
  return {
    volumeSplit: { swim: newHours.swim / Hnew, bike: newHours.bike / Hnew, run: newHours.run / Hnew },
    timeAvailableHoursPerWeek: Hnew,
  };
}

/**
 * Clone state with the bumped volume applied and the plan regenerated in
 * memory. Historical activity (garminActuals / garminPending) is carried over
 * by week index so current-fitness reads are unchanged — only the regenerated
 * `triWorkouts` (the planned dose) move the projection. Does NOT mutate the
 * input state.
 */
export function applyTriSessionDelta(state: SimulatorState, delta: TriSessionDelta): SimulatorState {
  const tri = state.triConfig;
  if (!tri) return state;
  const { volumeSplit, timeAvailableHoursPerWeek } = computeBumpedVolume(tri, delta);
  const clone: SimulatorState = {
    ...state,
    triConfig: { ...tri, volumeSplit, timeAvailableHoursPerWeek },
  };
  const fresh = generateTriathlonPlan(clone);
  for (let i = 0; i < fresh.length; i++) {
    const orig = state.wks?.[i];
    if (orig) {
      fresh[i].garminActuals = orig.garminActuals;
      fresh[i].garminPending = orig.garminPending;
    }
  }
  clone.wks = fresh;
  return clone;
}

/**
 * Predicted finish (seconds) for the plan with `delta` extra sessions applied.
 * Null if no triConfig / prediction unavailable.
 */
export function forecastTriWithDelta(state: SimulatorState, delta: TriSessionDelta): number | null {
  const clone = applyTriSessionDelta(state, delta);
  const pred = predictTriathlonRace(clone);
  return pred?.totalSec && pred.totalSec > 0 ? pred.totalSec : null;
}

/**
 * Live Monte Carlo chance (%) of beating `goalSec` for the plan with `delta`
 * extra sessions. The sim runs on the regenerated clone, so the chance and the
 * displayed forecast move together (no stale-anchor divergence). Null if
 * unavailable.
 */
export function goalChanceTriWithDelta(
  state: SimulatorState,
  delta: TriSessionDelta,
  goalSec: number,
): number | null {
  const clone = applyTriSessionDelta(state, delta);
  const sim = runTriForecastSim(clone, 2000, goalSec);
  if (!sim || sim.goalProbability == null) return null;
  return sim.goalProbability * 100;
}
