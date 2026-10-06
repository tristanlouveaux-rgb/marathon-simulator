import { describe, it, expect } from 'vitest';
import { checkVolumeRamp } from './tri-volume-ramp';
import type { SimulatorState } from '@/types/state';

// s.w is 1-based (store.ts default w: 1): w: 1 means this week = wks[0] and
// next week = wks[1].
function state(currentWeek: number, weeks: any[]): SimulatorState {
  return {
    eventType: 'triathlon',
    w: currentWeek,
    wks: weeks,
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('checkVolumeRamp', () => {
  it('no violation when next week is within 10% of this week', () => {
    const s = state(1, [
      {
        garminActuals: {
          a1: { garminId: 'a1', durationSec: 5 * 3600, activityType: 'CYCLING' },
        },
      },
      {
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '5h', r: 5, discipline: 'bike', estimatedDurationMin: 5.4 * 60 },
        ],
      },
    ]);
    expect(checkVolumeRamp(s)).toEqual([]);
  });

  it('violation when next-week bike planned is 30% above this-week bike actual', () => {
    const s = state(1, [
      {
        garminActuals: {
          a1: { garminId: 'a1', durationSec: 5 * 3600, activityType: 'CYCLING' },
        },
      },
      {
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '6.5h', r: 5, discipline: 'bike', estimatedDurationMin: 6.5 * 60 },
        ],
      },
    ]);
    const violations = checkVolumeRamp(s);
    expect(violations).toHaveLength(1);
    expect(violations[0].discipline).toBe('bike');
    expect(violations[0].rampPct).toBeGreaterThan(0.10);
  });

  it('per-discipline independence: bike violation does not trigger swim', () => {
    const s = state(1, [
      {
        garminActuals: {
          b1: { garminId: 'b1', durationSec: 5 * 3600, activityType: 'CYCLING' },
          s1: { garminId: 's1', durationSec: 1 * 3600, activityType: 'SWIMMING' },
        },
      },
      {
        triWorkouts: [
          { id: 'b2', t: 'bike_endurance', n: 'B', d: '6.5h', r: 5, discipline: 'bike', estimatedDurationMin: 6.5 * 60 },
          { id: 's2', t: 'swim_endurance', n: 'S', d: '1.05h', r: 5, discipline: 'swim', estimatedDurationMin: 63 },
        ],
      },
    ]);
    const violations = checkVolumeRamp(s);
    const disciplines = violations.map(v => v.discipline);
    expect(disciplines).toContain('bike');
    expect(disciplines).not.toContain('swim');
  });

  it('zero this-week actual hours → no violation', () => {
    const s = state(1, [
      { garminActuals: {} },
      {
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '5h', r: 5, discipline: 'bike', estimatedDurationMin: 300 },
        ],
      },
    ]);
    expect(checkVolumeRamp(s)).toEqual([]);
  });

  it('no next week available → no violation', () => {
    const s = state(1, [
      { garminActuals: { a1: { garminId: 'a1', durationSec: 3600, activityType: 'CYCLING' } } },
    ]);
    expect(checkVolumeRamp(s)).toEqual([]);
  });

  it('compares the current week actual (wks[s.w - 1]) with next week planned (wks[s.w])', () => {
    // Regression: the check read wks[s.w] as this week and wks[s.w + 1] as next
    // week, so it compared next week's (empty) actuals with the week after and
    // never fired. The reported hours pin which pair was compared.
    const s = state(1, [
      { garminActuals: { a1: { garminId: 'a1', durationSec: 4 * 3600, activityType: 'CYCLING' } } },
      {
        triWorkouts: [
          { id: 'b-next', t: 'bike_endurance', n: 'B', d: '6h', r: 5, discipline: 'bike', estimatedDurationMin: 6 * 60 },
        ],
      },
      {
        triWorkouts: [
          { id: 'b-after', t: 'bike_endurance', n: 'B', d: '9h', r: 5, discipline: 'bike', estimatedDurationMin: 9 * 60 },
        ],
      },
    ]);
    const v = checkVolumeRamp(s);
    expect(v).toHaveLength(1);
    expect(v[0].thisWeekActualHours).toBe(4);
    expect(v[0].nextWeekPlannedHours).toBe(6);
  });

  it('mid-plan: w: 3 compares wks[2] actual with wks[3] planned', () => {
    const s = state(3, [
      {}, {},
      { garminActuals: { a1: { garminId: 'a1', durationSec: 5 * 3600, activityType: 'CYCLING' } } },
      {
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '6.5h', r: 5, discipline: 'bike', estimatedDurationMin: 6.5 * 60 },
        ],
      },
    ]);
    const v = checkVolumeRamp(s);
    expect(v).toHaveLength(1);
    expect(v[0].thisWeekActualHours).toBe(5);
    expect(v[0].nextWeekPlannedHours).toBe(6.5);
  });
});
