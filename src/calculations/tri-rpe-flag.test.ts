/**
 * detectRpeBlownSession reads the week the user is in. s.w is 1-based
 * (store.ts default w: 1), so the current week is wks[s.w - 1] and the
 * previous week is wks[s.w - 2]. Regression: the detector read wks[s.w] (next
 * week) as today's week, and on Monday it read this week's (future) Sunday as
 * "yesterday" before falling back to the previous week.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectRpeBlownSession } from './tri-rpe-flag';
import { RPE_BLOWN_DELTA } from '@/constants/triathlon-adaptation-params';
import type { SimulatorState } from '@/types/state';

const WEDNESDAY = new Date(2026, 9, 7, 12, 0, 0); // local Wed (dow 2)
const MONDAY = new Date(2026, 9, 5, 12, 0, 0);    // local Mon (dow 0)

function state(w: number, wks: any[]): SimulatorState {
  return { eventType: 'triathlon', w, wks } as unknown as SimulatorState;
}

const run = (id: string, t: string, dow: number, rpe: number) =>
  ({ id, t, n: id, d: '60min', r: rpe, rpe, discipline: 'run', dayOfWeek: dow, estimatedDurationMin: 60 });
const ride = (id: string, t: string, dow: number, rpe: number) =>
  ({ id, t, n: id, d: '90min', r: rpe, rpe, discipline: 'bike', dayOfWeek: dow, estimatedDurationMin: 90 });

describe('detectRpeBlownSession — week index', () => {
  afterEach(() => { vi.useRealTimers(); });

  describe('mid-week', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(WEDNESDAY); });

    it('reads today and yesterday from the current week (wks[0] at w: 1)', () => {
      const s = state(1, [
        {
          triWorkouts: [ride('b-tue', 'bike_endurance', 1, 4), run('r-wed', 'threshold', 2, 8)],
          rated: { 'b-tue': 4 + RPE_BLOWN_DELTA },
        },
        // Next week: same weekdays, nothing rated.
        { triWorkouts: [ride('b-tue-next', 'bike_endurance', 1, 4), run('r-wed-next', 'threshold', 2, 8)] },
      ]);
      const flag = detectRpeBlownSession(s);
      expect(flag).not.toBeNull();
      expect(flag!.todayWorkout.id).toBe('r-wed');
      expect(flag!.yesterdayWorkout.id).toBe('b-tue');
      expect(flag!.yesterdayActualRpe).toBe(4 + RPE_BLOWN_DELTA);
    });

    it('no flag when yesterday was rated within the expected band', () => {
      const s = state(1, [{
        triWorkouts: [ride('b-tue', 'bike_endurance', 1, 4), run('r-wed', 'threshold', 2, 8)],
        rated: { 'b-tue': 4 + RPE_BLOWN_DELTA - 1 },
      }]);
      expect(detectRpeBlownSession(s)).toBeNull();
    });
  });

  describe('Monday', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(MONDAY); });

    it("reads yesterday from the previous week's Sunday, not this week's", () => {
      const s = state(2, [
        // Previous week: Sunday long ride rated hot.
        { triWorkouts: [ride('b-sun-prev', 'bike_endurance', 6, 4)], rated: { 'b-sun-prev': 4 + RPE_BLOWN_DELTA } },
        // Current week: today's quality run, and this week's Sunday still ahead.
        { triWorkouts: [run('r-mon', 'threshold', 0, 8), ride('b-sun-cur', 'bike_endurance', 6, 4)] },
      ]);
      const flag = detectRpeBlownSession(s);
      expect(flag).not.toBeNull();
      expect(flag!.todayWorkout.id).toBe('r-mon');
      expect(flag!.yesterdayWorkout.id).toBe('b-sun-prev');
    });

    it('week 1 Monday has no yesterday in the plan', () => {
      const s = state(1, [{
        triWorkouts: [run('r-mon', 'threshold', 0, 8), ride('b-sun', 'bike_endurance', 6, 4)],
        // Even a rating on this week's Sunday is not yesterday.
        rated: { 'b-sun': 4 + RPE_BLOWN_DELTA },
      }]);
      expect(detectRpeBlownSession(s)).toBeNull();
    });
  });
});
