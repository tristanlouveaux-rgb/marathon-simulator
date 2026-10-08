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
import { fmtDurationMin } from '@/utils/format';

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
 * The low-base marathon check (owner decision 2026-10-06), one helper for the
 * race page (race-target-plan-note lowBaseMarathon) and every forecast surface
 * (raceDayEnduranceGapText). A marathon plan that cannot build marathon
 * endurance in time is allowed, said plainly, and its forecast called
 * optimistic. Categories:
 *   - beginner: experience level total_beginner or beginner, in a sharpening block;
 *   - noRecentRun: a sharpening block whose runner has logged runs but none in
 *     the 30 days before build (start source 'history-no-recent-run');
 *   - shortLongRuns: the longest run before race day under the durability
 *     model's long-run bar (LONG_RUN_QUALIFYING_FRACTION x LONG_RUN_THRESHOLD_SEC,
 *     0.70 x 2:45 = 1:55), any marathon plan. The marathon penalty cap
 *     (LONG_RUN_MAX_PENALTY 5%) is calibrated on volume-shortened marathoners who
 *     still did long runs (SCIENCE_LOG §AL.4); a plan whose longest run stays far
 *     below that is outside the calibration (M4 design v4 review, major 4).
 * `longestRunMin`: the plan's own longest run before race day on the forecast
 * (s.raceDayDurability), the block's projected peak long run on the race page
 * (no plan exists yet). Null when no category applies, and null whenever that
 * longest run reaches the marathon-readiness long run (LONG_RUN_THRESHOLD_SEC,
 * 2:45): the plan then builds marathon endurance, whatever the category, so
 * neither surface may say it falls short. Tracking side.
 */
export interface MarathonEnduranceGapInput {
  rd: string | null | undefined;
  /** The plan is (or, on the race page, will be) a sharpening block. */
  sharpeningBlock: boolean;
  experienceLevel?: string | null;
  /** The block's start source (s.sharpenBlock.startSource). */
  startSource?: string | null;
  longestRunMin: number | null | undefined;
}
export interface MarathonEnduranceGap { beginner: boolean; noRecentRun: boolean; shortLongRuns: boolean }

export function marathonEnduranceGap(i: MarathonEnduranceGapInput): MarathonEnduranceGap | null {
  if (i.rd !== 'marathon') return null;
  // The longest run reaches the threshold: no gap (review 2026-10-07: a beginner
  // whose block reached 2:45 read "short of the 2:45 marathon-readiness long run"
  // on the race page while the forecast said nothing).
  if (i.longestRunMin != null && i.longestRunMin * 60 >= LONG_RUN_THRESHOLD_SEC.marathon) return null;
  const shortLongRuns = i.longestRunMin != null
    && i.longestRunMin * 60 < LONG_RUN_QUALIFYING_FRACTION * LONG_RUN_THRESHOLD_SEC.marathon;
  const beginner = i.sharpeningBlock && (i.experienceLevel === 'total_beginner' || i.experienceLevel === 'beginner');
  const noRecentRun = i.sharpeningBlock && i.startSource === 'history-no-recent-run';
  return beginner || noRecentRun || shortLongRuns ? { beginner, noRecentRun, shortLongRuns } : null;
}

/** The low-base inputs a built plan carries (sharpening block, experience level, start source). */
export type EnduranceGapPlanContext = Pick<MarathonEnduranceGapInput, 'sharpeningBlock' | 'experienceLevel' | 'startSource'>;

export function enduranceGapPlanContext(
  s: Pick<SimulatorState, 'sharpenBlock' | 'onboarding' | 'continuousMode'>,
): EnduranceGapPlanContext {
  return {
    sharpeningBlock: !!s.sharpenBlock && !s.continuousMode,
    experienceLevel: s.onboarding?.experienceLevel ?? null,
    startSource: s.sharpenBlock ? s.sharpenBlock.startSource : null,
  };
}

/**
 * True when the race-day penalty is outside the durability model's calibration
 * (marathonEnduranceGap shortLongRuns): surfaces must not present it as a small
 * precise number. Tracking side.
 */
export function raceDayEnduranceBeyondModel(
  r: RunDurabilityResult | null | undefined, rd: string | null | undefined,
): boolean {
  if (!r) return false;
  return !!marathonEnduranceGap({ rd, sharpeningBlock: false, longestRunMin: r.longestRunSec / 60 })?.shortLongRuns;
}

/**
 * The plain statement every forecast surface shows when marathonEnduranceGap
 * holds for the plan (owner decision 2026-10-06: say plainly that the plan
 * cannot build marathon endurance in time and that the forecast is optimistic).
 * Without `plan` only the shortLongRuns category is checked. Null otherwise
 * (marathonEnduranceGap is null when the longest run reaches the threshold).
 */
export function raceDayEnduranceGapText(
  r: RunDurabilityResult | null | undefined, rd: string | null | undefined,
  plan?: EnduranceGapPlanContext,
): string | null {
  if (!r) return null;
  const gap = marathonEnduranceGap({
    rd, sharpeningBlock: plan?.sharpeningBlock ?? false, experienceLevel: plan?.experienceLevel,
    startSource: plan?.startSource, longestRunMin: r.longestRunSec / 60,
  });
  if (!gap) return null;
  return `The longest run before race day is about ${fmtDurationMin(r.longestRunSec / 60)}, short of the ${fmtDurationMin(LONG_RUN_THRESHOLD_SEC.marathon / 60)} marathon-readiness long run. The forecast assumes long-run endurance the plan does not build, so the finish time is optimistic.`;
}
