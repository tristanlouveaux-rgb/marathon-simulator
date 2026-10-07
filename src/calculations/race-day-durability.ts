/**
 * Race-day long-run durability for the running forecast.
 *
 * **Side of the line**: tracking. It describes what the plan as written
 * delivers by race day and never changes the plan.
 *
 * The race-day forecast is end-of-plan fitness on the assumption that the plan
 * is followed. Before 2026-10-07 it dropped the durability cap entirely, on the
 * stated assumption that "the plan delivers the required long runs before race
 * day". That was false whenever the plan's longest run stays under the
 * durability threshold: the 10% long-run rule from a low start, an hours target
 * or archetype budget, and every half and 10K plan (their ramp peaks below
 * LONG_RUN_THRESHOLD_SEC). This module evaluates the same durability model
 * (run-durability `applyLongRunCap`, same thresholds, window and consistency
 * credit) on the runs of the 12 weeks that end with race week: the plan's own
 * prescription for plan weeks (plan_engine `plannedRunMinutesByWeek`, read from
 * state exactly as the committed plan is generated) and the runs actually
 * logged for any pre-plan weeks still inside that window.
 *
 * Single source for every race-day running forecast (refreshBlendedFitness,
 * initializeSimulator, the onboarding plan preview, the legacy renderer and
 * simulator init, the strength-benefit estimate) and for the Durability
 * drill-down, which shows the stored result (`s.raceDayDurability`).
 */

import type { SimulatorState } from '@/types/state';
import { plannedRunMinutesByWeek, runningPlanShapeInputs, type RunningPlanState } from '@/workouts/plan_engine';
import { planTrainingWeeks } from '@/workouts/race-week-layout';
import {
  plannedRaceDayDurability, getRunDurationsBetweenSec, DURABILITY_WINDOW_WEEKS,
  LONG_RUN_QUALIFYING_FRACTION, LONG_RUN_THRESHOLD_SEC,
  type RunDurabilityResult,
} from './run-durability';

/** State the race-day planned durability reads. */
export type RaceDayPlanState = RunningPlanState
  & Pick<SimulatorState, 'eventType' | 'trackOnly' | 'planStartDate' | 'onboardingRunHistory'>;

const WEEK_MS = 7 * 24 * 3600 * 1000;

/**
 * Race-day durability from the plan's prescription. Null when there is no
 * running race plan (continuous, just-track, triathlon, cycling, HYROX, or no
 * race distance, weeks or runs per week): no penalty.
 *
 * `nowMs` stands in for the plan start when `s.planStartDate` is not set yet
 * (the onboarding preview, before the plan exists).
 */
export function raceDayPlanDurability(s: RaceDayPlanState, nowMs: number = Date.now()): RunDurabilityResult | null {
  if (s.trackOnly || s.continuousMode) return null;
  if (s.eventType === 'triathlon' || s.eventType === 'hyrox') return null;
  // Training weeks: the window ends with race week; a closing week (a Monday to
  // Wednesday race's own week) holds only the race (planTrainingWeeks).
  const trainingWeeks = planTrainingWeeks(s);
  if (!s.rd || !(trainingWeeks > 0) || !(s.rw > 0)) return null;

  const plannedWeeks = plannedRunMinutesByWeek(runningPlanShapeInputs(s));
  let preplanRunSec: number[] = [];
  if (trainingWeeks < DURABILITY_WINDOW_WEEKS) {
    const parsed = s.planStartDate ? Date.parse(s.planStartDate) : NaN;
    const planStartMs = Number.isFinite(parsed) ? parsed : nowMs;
    preplanRunSec = getRunDurationsBetweenSec(
      s, planStartMs - (DURABILITY_WINDOW_WEEKS - trainingWeeks) * WEEK_MS, planStartMs,
    );
  }
  return plannedRaceDayDurability(plannedWeeks, s.rd, preplanRunSec);
}

/** The forecast multiplier (>= 1) from `raceDayPlanDurability`; undefined = no penalty. */
export function raceDayDurabilityMultiplier(s: RaceDayPlanState, nowMs?: number): number | undefined {
  return raceDayPlanDurability(s, nowMs)?.multiplier;
}

/**
 * True when a marathon's race-day durability rests on a longest run below the
 * model's long-run bar (LONG_RUN_QUALIFYING_FRACTION x LONG_RUN_THRESHOLD_SEC,
 * 0.70 x 2:45 = 1:55). The marathon penalty cap (LONG_RUN_MAX_PENALTY 5%) is
 * calibrated on volume-shortened marathoners who still did long runs (SCIENCE_LOG
 * §AL.4); a plan whose longest run stays far below that is outside the
 * calibration, so surfaces must not present its penalty as a small precise
 * number (M4 design v4 review, major 4). Tracking side.
 */
export function raceDayEnduranceBeyondModel(
  r: RunDurabilityResult | null | undefined, rd: string | null | undefined,
): boolean {
  if (rd !== 'marathon' || !r) return false;
  return r.longestRunSec < LONG_RUN_QUALIFYING_FRACTION * LONG_RUN_THRESHOLD_SEC.marathon;
}

/** h:mm */
function fmtHm(sec: number): string {
  const m = Math.round(sec / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The plain statement every forecast surface shows instead of a precise
 * penalty when raceDayEnduranceBeyondModel holds (owner decision 2026-10-06:
 * say plainly that the plan cannot build marathon endurance in time and that
 * the forecast is optimistic). Null otherwise.
 */
export function raceDayEnduranceGapText(
  r: RunDurabilityResult | null | undefined, rd: string | null | undefined,
): string | null {
  if (!raceDayEnduranceBeyondModel(r, rd)) return null;
  return `The plan's longest run before race day is about ${fmtHm(r!.longestRunSec)}, short of the ${fmtHm(LONG_RUN_THRESHOLD_SEC.marathon)} marathon-readiness long run. The forecast assumes long-run endurance the plan does not build, so the finish time is optimistic.`;
}
