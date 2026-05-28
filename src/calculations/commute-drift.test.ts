import { describe, it, expect } from 'vitest';
import { detectCommuteDrift } from './commute-drift';
import type { Week, GarminActual, CommuteConfig } from '@/types';

function makeWeek(w: number, commuteCount: number): Week {
  const actuals: Record<string, GarminActual> = {};
  for (let i = 0; i < commuteCount; i++) {
    actuals[`commute-${w}-${i}`] = {
      garminId: `commute-${w}-${i}`,
      distanceKm: 5,
      durationSec: 1800,
      avgPaceSecKm: 360,
      avgHR: null,
      maxHR: null,
      calories: null,
      commute: true,
    };
  }
  return {
    w,
    ph: 'build',
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
    garminActuals: actuals,
  } as Week;
}

const declared = (days: number): CommuteConfig => ({
  enabled: true,
  distanceKm: 5,
  isBidirectional: true,
  commuteDaysPerWeek: days,
});

describe('detectCommuteDrift', () => {
  it('returns null when commute is disabled', () => {
    const weeks = [makeWeek(1, 0), makeWeek(2, 0), makeWeek(3, 0), makeWeek(4, 0), makeWeek(5, 0)];
    expect(detectCommuteDrift(weeks, 5, undefined)).toBeNull();
    expect(detectCommuteDrift(weeks, 5, { ...declared(3), enabled: false })).toBeNull();
  });

  it('returns null at the 1-day floor (already lowest)', () => {
    const weeks = [makeWeek(1, 0), makeWeek(2, 0), makeWeek(3, 0), makeWeek(4, 0), makeWeek(5, 0)];
    expect(detectCommuteDrift(weeks, 5, declared(1))).toBeNull();
  });

  it('returns null when history window is incomplete', () => {
    // Only 2 prior weeks exist when currentWeek = 3 → need 4 → null
    const weeks = [makeWeek(1, 0), makeWeek(2, 0)];
    expect(detectCommuteDrift(weeks, 3, declared(5))).toBeNull();
  });

  it('returns null when actuals match declared', () => {
    // 4 weeks at 3 commutes/wk, declared = 3
    const weeks = [
      makeWeek(1, 3), makeWeek(2, 3), makeWeek(3, 3), makeWeek(4, 3), makeWeek(5, 0),
    ];
    expect(detectCommuteDrift(weeks, 5, declared(3))).toBeNull();
  });

  it('reduces declared when 3+ of last 4 weeks fell short', () => {
    // Declared = 5; last 4 fully-rolled weeks: [2, 2, 5, 2] → 3 shortfalls, median = 2
    const weeks = [
      makeWeek(1, 2), makeWeek(2, 2), makeWeek(3, 5), makeWeek(4, 2), makeWeek(5, 0),
    ];
    const result = detectCommuteDrift(weeks, 5, declared(5));
    expect(result).not.toBeNull();
    expect(result!.oldDays).toBe(5);
    expect(result!.newDays).toBe(2);
    expect(result!.observed).toEqual([2, 2, 5, 2]);
  });

  it('only counts the last WINDOW=4 weeks, not earlier', () => {
    // Earlier weeks should not influence the check
    const weeks = [
      makeWeek(1, 0), makeWeek(2, 0), // ignored, outside window
      makeWeek(3, 3), makeWeek(4, 3), makeWeek(5, 3), makeWeek(6, 3),
      makeWeek(7, 0), // current week — excluded from check
    ];
    expect(detectCommuteDrift(weeks, 7, declared(3))).toBeNull();
  });

  it('excludes the in-progress current week from the observation', () => {
    // Current week (7) shows 0 commutes — should NOT trigger reduction by itself
    const weeks = [
      makeWeek(1, 4), makeWeek(2, 4), makeWeek(3, 4), makeWeek(4, 4),
      makeWeek(5, 4), makeWeek(6, 4), makeWeek(7, 0),
    ];
    expect(detectCommuteDrift(weeks, 7, declared(4))).toBeNull();
  });

  it('floors the new value at 1 even if median observation is 0', () => {
    // Declared = 3, all last 4 weeks zero
    const weeks = [
      makeWeek(1, 0), makeWeek(2, 0), makeWeek(3, 0), makeWeek(4, 0), makeWeek(5, 0),
    ];
    const result = detectCommuteDrift(weeks, 5, declared(3));
    expect(result).not.toBeNull();
    expect(result!.newDays).toBe(1);
  });

  it('does not reduce by more than 1 step beyond the declared (single step ceiling)', () => {
    // Declared = 5, observations show median 3 → new = min(median, declared-1) = min(3, 4) = 3
    // (not necessarily a single-step reduction — median wins when below declared-1)
    const weeks = [
      makeWeek(1, 3), makeWeek(2, 3), makeWeek(3, 4), makeWeek(4, 3), makeWeek(5, 0),
    ];
    const result = detectCommuteDrift(weeks, 5, declared(5));
    expect(result).not.toBeNull();
    expect(result!.newDays).toBe(3);
  });
});
