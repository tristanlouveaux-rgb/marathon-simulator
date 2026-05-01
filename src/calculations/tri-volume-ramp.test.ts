import { describe, it, expect } from 'vitest';
import { checkVolumeRamp } from './tri-volume-ramp';
import type { SimulatorState } from '@/types/state';

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
    const s = state(0, [
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
    const s = state(0, [
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
    const s = state(0, [
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
    const s = state(0, [
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
    const s = state(0, [
      { garminActuals: { a1: { garminId: 'a1', durationSec: 3600, activityType: 'CYCLING' } } },
    ]);
    expect(checkVolumeRamp(s)).toEqual([]);
  });
});
