import { describe, it, expect } from 'vitest';
import { computePlanAdherence, ADHERENCE_THRESHOLD } from './plan-adherence';
import type { SimulatorState, Week, GarminActual } from '@/types';

/** Minimal state factory — only fields needed for adherence calc */
function makeState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    w: 3,
    tw: 12,
    v: 45,
    iv: 45,
    rpeAdj: 0,
    expectedFinal: 48,
    rd: 'marathon' as any,
    epw: 5,
    rw: 4,
    wkm: 50,
    pbs: {} as any,
    rec: null,
    lt: null,
    vo2: null,
    initialLT: null,
    initialVO2: null,
    initialBaseline: null,
    currentFitness: null,
    forecastTime: null,
    typ: 'balanced' as any,
    b: 1.06,
    wks: [],
    pac: { e: 330 } as any,
    skip: [],
    timp: 0,
    ...overrides,
  } as SimulatorState;
}

function makeWeek(w: number, overrides: Partial<Week> = {}): Week {
  return {
    w,
    ph: 'build' as any,
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
    ...overrides,
  } as Week;
}

function makeRunActual(distanceKm: number, plannedKm?: number): GarminActual {
  return {
    garminId: `strava-${Math.random().toString(36).slice(2)}`,
    distanceKm,
    durationSec: distanceKm * 330,
    avgPaceSecKm: 330,
    avgHR: 145,
    maxHR: 170,
    calories: distanceKm * 70,
    activityType: 'RUNNING',
    plannedDistanceKm: plannedKm ?? distanceKm,
  };
}

describe('computePlanAdherence', () => {

  it('returns null when current week < 2', () => {
    const s = makeState({ w: 1, wks: [makeWeek(1)] });
    expect(computePlanAdherence(s).pct).toBeNull();
  });

  it('returns 0% when no runs were completed in past weeks', () => {
    // rw=4, week 1 has no garminActuals → 0 completed / 4 planned = 0%
    const s = makeState({ w: 2, wks: [makeWeek(1), makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.pct).toBe(0);
    expect(result.totalPlanned).toBe(4);
    expect(result.totalCompleted).toBe(0);
  });

  it('counts runs that meet 95% distance threshold', () => {
    const wk1 = makeWeek(1, {
      garminActuals: {
        'slot-a': makeRunActual(10, 10),   // 100% → completed
        'slot-b': makeRunActual(9.6, 10),  // 96% → completed
        'slot-c': makeRunActual(9.4, 10),  // 94% → NOT completed
      },
    });
    const s = makeState({ rw: 4, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(2);
    expect(result.totalPlanned).toBe(4);
    expect(result.pct).toBe(50);
  });

  it('caps completed at planned per week', () => {
    // More garminActuals than rw — should not exceed rw
    const wk1 = makeWeek(1, {
      garminActuals: {
        'a': makeRunActual(10, 10),
        'b': makeRunActual(10, 10),
        'c': makeRunActual(10, 10),
        'd': makeRunActual(10, 10),
        'e': makeRunActual(10, 10),
      },
    });
    const s = makeState({ rw: 3, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(3); // capped at rw
    expect(result.totalPlanned).toBe(3);
    expect(result.pct).toBe(100);
  });

  it('excludes current in-progress week from scoring', () => {
    const wk1 = makeWeek(1, {
      garminActuals: { 'a': makeRunActual(10, 10) },
    });
    const wk2 = makeWeek(2, {
      garminActuals: { 'a': makeRunActual(10, 10), 'b': makeRunActual(10, 10) },
    });
    // current = week 2, so only week 1 is scored
    const s = makeState({ rw: 4, w: 2, wks: [wk1, wk2] });
    const result = computePlanAdherence(s);
    expect(result.weeksIncluded).toBe(1);
    expect(result.totalCompleted).toBe(1);
    expect(result.totalPlanned).toBe(4);
  });

  it('subtracts pushed workouts from denominator', () => {
    // Week 1: 4 planned runs, 1 pushed to week 2 → denom = 3
    const wk1 = makeWeek(1, {
      garminActuals: {
        'a': makeRunActual(10, 10),
        'b': makeRunActual(10, 10),
        'c': makeRunActual(10, 10),
      },
    });
    const wk2 = makeWeek(2, {
      skip: [{
        n: 'Easy', t: 'easy',
        workout: { id: 'W1-easy-0', n: 'Easy', t: 'easy', d: '6km', r: 3 } as any,
        skipCount: 1,
      }],
    });
    const s = makeState({ rw: 4, w: 3, wks: [wk1, wk2, makeWeek(3)] });
    const result = computePlanAdherence(s);
    // Week 1: 3 completed / 3 planned (4 - 1 push) = 100%
    // Week 2: 0 completed / 4 planned = 0%
    expect(result.totalPlanned).toBe(7); // 3 + 4
    expect(result.totalCompleted).toBe(3);
  });

  it('ignores non-run activities in garminActuals', () => {
    const wk1 = makeWeek(1, {
      garminActuals: {
        'run-slot': makeRunActual(10, 10),
        'gym-slot': {
          ...makeRunActual(0, 0),
          activityType: 'STRENGTH_TRAINING',
          plannedDistanceKm: null,
        } as any,
      },
    });
    const s = makeState({ rw: 4, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(1);
  });

  it('ignores ad-hoc runs (plannedDistanceKm is null)', () => {
    const wk1 = makeWeek(1, {
      garminActuals: {
        'planned': makeRunActual(10, 10),
        'adhoc': {
          ...makeRunActual(5),
          plannedDistanceKm: null,
        } as any,
      },
    });
    const s = makeState({ rw: 4, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(1); // only the planned one
  });

  it('uses plannedDistanceKm from garminActuals (already post-reduction)', () => {
    // Run was reduced from 12km to 8km. Actual = 7.8km.
    // plannedDistanceKm = 8 (set at match time from post-reduction desc)
    // 7.8 >= 0.95 * 8 = 7.6 → completed
    const wk1 = makeWeek(1, {
      garminActuals: {
        'long-slot': {
          ...makeRunActual(7.8),
          plannedDistanceKm: 8,
        },
      },
    });
    const s = makeState({ rw: 4, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(1);
  });

  it('ADHERENCE_THRESHOLD is 0.95', () => {
    expect(ADHERENCE_THRESHOLD).toBe(0.95);
  });
});
