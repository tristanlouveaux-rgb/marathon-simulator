/**
 * Per-discipline volume-ramp check (Gabbett 2016, 5–10% rule).
 *
 * Triggers when next week's planned hours exceed this week's actual hours by
 * more than `WEEKLY_VOLUME_RAMP_CAP` (10%). Each discipline checks
 * independently so a swim ramp does not trigger a bike warning.
 *
 * **Side of the line**: planning. Pure function — caller surfaces the result
 * as a suggestion (modal) and applies the proposed trim if the user accepts.
 *
 * Source: Gabbett TJ (2016) "The training-injury prevention paradox" Br J
 * Sports Med 50:273–280.
 */

import type { SimulatorState, Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { classifyActivity } from './tri-benchmarks-from-history';
import { VOLUME_RAMP_PCT } from '@/constants/triathlon-adaptation-params';

export interface VolumeRampViolation {
  discipline: Discipline;
  thisWeekActualHours: number;
  nextWeekPlannedHours: number;
  rampPct: number;        // (next - this) / this. Positive = ramp up.
  capPct: number;         // = VOLUME_RAMP_PCT (e.g. 0.10 for 10%)
  /** Hours by which next week exceeds the cap. */
  excessHours: number;
}

export function checkVolumeRamp(state: SimulatorState): VolumeRampViolation[] {
  const violations: VolumeRampViolation[] = [];
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const thisWk = wks[currentWeek];
  const nextWk = wks[currentWeek + 1];
  if (!thisWk || !nextWk) return violations;

  const disciplines: Discipline[] = ['swim', 'bike', 'run'];
  for (const d of disciplines) {
    const thisActualHours = sumActualHours(thisWk.garminActuals, d);
    const nextPlannedHours = sumPlannedHours(nextWk.triWorkouts ?? [], d);

    // Skip if either is zero — ramp logic doesn't apply when there's no anchor.
    if (thisActualHours <= 0 || nextPlannedHours <= 0) continue;

    const rampPct = (nextPlannedHours - thisActualHours) / thisActualHours;
    if (rampPct > VOLUME_RAMP_PCT) {
      const cappedHours = thisActualHours * (1 + VOLUME_RAMP_PCT);
      violations.push({
        discipline: d,
        thisWeekActualHours: round1(thisActualHours),
        nextWeekPlannedHours: round1(nextPlannedHours),
        rampPct,
        capPct: VOLUME_RAMP_PCT,
        excessHours: round1(nextPlannedHours - cappedHours),
      });
    }
  }
  return violations;
}

function sumActualHours(
  actuals: Record<string, { activityType?: string | null; durationSec?: number }> | undefined,
  discipline: Discipline,
): number {
  if (!actuals) return 0;
  let sec = 0;
  for (const a of Object.values(actuals)) {
    if (classifyActivity(a.activityType) !== discipline) continue;
    sec += a.durationSec ?? 0;
  }
  return sec / 3600;
}

function sumPlannedHours(workouts: Workout[], discipline: Discipline): number {
  let min = 0;
  for (const w of workouts) {
    if ((w.discipline ?? 'run') !== discipline) continue;
    min += w.estimatedDurationMin ?? 0;
  }
  return min / 60;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
