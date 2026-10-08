/**
 * The race page's plan note (M4 design v4, section 6; owner decision
 * 2026-10-06 for low-base marathon runners). Pure: the race page renders it,
 * tests read it.
 *
 * A race closer than a full build continues into a sharpening block with one
 * muted line saying what the plan is, picked from the calendar layout the plan
 * is built on (raceWeekLayout), not from days alone. A marathon block that
 * cannot build marathon endurance (no run in the last 30 days, a beginner, or
 * a block whose long runs stay under the durability model's long-run bar) says
 * so plainly, says the forecast is optimistic, and offers a half on the same
 * date or a race far enough away for a full build.
 */

import type { RaceDistance } from '@/types';
import { raceWeekLayout } from '@/workouts/race-week-layout';
import { computeRunningPlanPhases, isSharpeningBlock, FULL_BUILD_WEEKS } from '@/workouts/phases';
import { abilityBandFromVdot, projectedSharpeningPeakLongMin } from '@/workouts/plan_engine';
import { buildSharpenBlockState, type SharpenBuildState } from '@/workouts/sharpening-block';
import { LONG_RUN_THRESHOLD_SEC } from '@/calculations/run-durability';
import { marathonEnduranceGap } from '@/calculations/race-day-durability';
import { localMondayKey, localDateKey, calendarDayNumber } from '@/utils/local-date';
import type { Archetype } from '@/calculations/athlete-archetype';
import { fmtDurationMin } from '@/utils/format';

/** Training weeks of a plan built today for a race on `raceISO` (null: no plan possible). */
export function trainingWeeksForRace(raceISO: string, now: Date = new Date()): number | null {
  const layout = raceWeekLayout(localMondayKey(now), raceISO);
  return layout ? layout.trainingWeeks : null;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** The muted line under the race date: what the plan will be. Null for a past date or today. */
export function racePlanNote(rd: RaceDistance, raceISO: string, now: Date = new Date()): string | null {
  const days = calendarDayNumber(raceISO) - calendarDayNumber(localDateKey(now));
  if (!(days >= 1)) return null;
  const n = trainingWeeksForRace(raceISO, now);
  if (n == null) return null;
  if (!isSharpeningBlock(rd, n)) return `${n} weeks of training`;
  const phases = computeRunningPlanPhases(n, rd).map(p => p.ph);
  const taper = phases.filter(p => p === 'taper').length;
  const training = n - taper;
  if (n === 1) {
    if (days <= 2) return `Race in ${plural(days, 'day')}. Too close for a primer session. Any run before race day is easy.`;
    return `Race in ${days} days. The plan is race week only: easy runs and one short primer session.`;
  }
  if (training === 0) return `${n}-week plan. The whole plan is a taper: volume drops each week while intensity holds.`;
  if (rd === 'marathon') {
    return `${n}-week plan, short of the ${FULL_BUILD_WEEKS.marathon}-week marathon build. ${plural(training, 'week')} of race-specific training from current fitness, then a ${taper}-week taper.`;
  }
  return `${n}-week plan, short of the ${FULL_BUILD_WEEKS.half}-week half marathon build. ${plural(training, 'week')} of race-specific training, then race week.`;
}

export interface LowBaseMarathon {
  /** Plain statement for the race page and the forecast. */
  text: string;
  /** The block's projected longest long run, minutes. */
  peakLongMin: number;
}

/** State the low-base check reads (logged runs, paces, archetype, fitness). */
export type LowBaseState = SharpenBuildState & { athleteArchetype?: { archetype?: Archetype } | null };

/**
 * A marathon block that cannot build marathon endurance in time (owner
 * decision 2026-10-06: allowed, said plainly, forecast called optimistic, a
 * half or a later race offered). Fires for a marathon under FULL_BUILD_WEEKS
 * when marathonEnduranceGap (race-day-durability.ts, the same check every
 * forecast surface reads) holds: a beginner, logged runs but none in the last
 * 30 days, or the block's projected longest long run under the durability
 * model's long-run bar (0.70 x 2:45 = 1:55). No plan exists yet, so the
 * longest run is the block's projected peak. Null otherwise.
 */
export function lowBaseMarathon(
  rd: RaceDistance, raceISO: string, s: LowBaseState, experienceLevel: string | undefined,
  now: Date = new Date(),
): LowBaseMarathon | null {
  if (rd !== 'marathon') return null;
  const n = trainingWeeksForRace(raceISO, now);
  if (n == null || !isSharpeningBlock('marathon', n)) return null;
  const start = buildSharpenBlockState(
    { ...s, onboarding: { ...(s.onboarding ?? {}), experienceLevel } as SharpenBuildState['onboarding'] },
    { raceDistance: 'marathon', trainingWeeks: n, noSignal: false, nowMs: now.getTime() },
  );
  const ability = abilityBandFromVdot(s.v || 45, experienceLevel || 'intermediate');
  const phases = computeRunningPlanPhases(n, 'marathon').map(p => p.ph);
  const peakLongMin = projectedSharpeningPeakLongMin(start.startLongMin, phases, ability, s.athleteArchetype?.archetype, 'marathon');
  const thresholdMin = LONG_RUN_THRESHOLD_SEC.marathon / 60;
  const gap = marathonEnduranceGap({
    rd, sharpeningBlock: true, experienceLevel, startSource: start.startSource, longestRunMin: peakLongMin,
  });
  if (!gap) return null;
  const lead = gap.noRecentRun ? 'No runs in the last 30 days. ' : '';
  return {
    peakLongMin,
    text: `${lead}${plural(n, 'week')} cannot build marathon endurance. Long runs reach about ${fmtDurationMin(peakLongMin)}, short of the ${fmtDurationMin(thresholdMin)} marathon-readiness long run, so the forecast finish time is optimistic.`,
  };
}
