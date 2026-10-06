/**
 * RPE-flagged blown session detector.
 *
 * If yesterday's completed tri workout had `actualRpe >= expectedRpe + RPE_BLOWN_DELTA`,
 * AND today's planned tri workout is `quality`, surface a suggestion to swap
 * today's session for an easy one.
 *
 * **Side of the line**: planning. Pure function. Caller surfaces the result
 * via the suggestion modal.
 *
 * Source: Foster C et al. (2001) "A new approach to monitoring exercise
 * training" J Strength Cond Res 15:109–115. Session RPE methodology. A
 * 2-point overshoot is a meaningful effort signal worth surfacing.
 */

import type { SimulatorState, Workout } from '@/types/state';
import { RPE_BLOWN_DELTA } from '@/constants/triathlon-adaptation-params';
import { isOpenForTriSuggestion } from './tri-suggestion-handled';

export interface RpeFlag {
  yesterdayWorkout: Workout;
  yesterdayActualRpe: number;
  yesterdayExpectedRpe: number;
  todayWorkout: Workout;
}

const QUALITY_TYPE_KEYWORDS = [
  'threshold', 'vo2', 'tempo', 'sweet_spot', 'sweetspot',
  'speed', 'race_pace', 'intervals', 'hills', 'long', 'brick',
];

function isQuality(workout: Workout): boolean {
  const t = (workout.t ?? '').toLowerCase();
  return QUALITY_TYPE_KEYWORDS.some(k => t.includes(k));
}

export function detectRpeBlownSession(state: SimulatorState): RpeFlag | null {
  const wks = state.wks ?? [];
  // s.w is 1-based (store.ts default w: 1): the current week is wks[s.w - 1].
  const curIdx = (state.w ?? 1) - 1;
  const wk = wks[curIdx];
  if (!wk?.triWorkouts) return null;

  // Today + yesterday in `dayOfWeek` (0=Mon..6=Sun).
  const todayDow = (new Date().getDay() + 6) % 7;
  const yesterdayDow = (todayDow + 6) % 7;  // = (todayDow - 1 + 7) % 7

  // Skip a session already changed (accepted swap/downgrade, Adjust), done or
  // dropped: it has already been eased, so proposing a swap again repeats it.
  const todayWorkout = wk.triWorkouts.find(w => w.dayOfWeek === todayDow && isOpenForTriSuggestion(w));
  if (!todayWorkout || !isQuality(todayWorkout)) return null;

  // Yesterday's workout. On Monday it is the previous week's Sunday; this
  // week's Sunday is still ahead and must not be read as yesterday.
  const yesterdayWk = todayDow === 0
    ? (curIdx > 0 ? wks[curIdx - 1] : undefined)
    : wk;
  const yesterdayWorkout = yesterdayWk?.triWorkouts?.find(w => w.dayOfWeek === yesterdayDow);
  if (!yesterdayWorkout || !yesterdayWorkout.id) return null;

  // Look up yesterday's actual RPE from rated.
  const ratedValue = yesterdayWk?.rated?.[yesterdayWorkout.id];
  if (typeof ratedValue !== 'number') return null;

  const expected = (yesterdayWorkout as { rpe?: number }).rpe ?? yesterdayWorkout.r;
  if (expected == null) return null;

  if (ratedValue < expected + RPE_BLOWN_DELTA) return null;

  return {
    yesterdayWorkout,
    yesterdayActualRpe: ratedValue,
    yesterdayExpectedRpe: expected,
    todayWorkout,
  };
}
