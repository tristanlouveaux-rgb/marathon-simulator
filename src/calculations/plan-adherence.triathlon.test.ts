import { describe, it, expect } from 'vitest';
import { computeTriPlanAdherence } from './plan-adherence.triathlon';
import type { SimulatorState, Week, Workout, GarminActual } from '@/types';

function makeState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return { w: 3, tw: 12, wks: [], ...overrides } as SimulatorState;
}

function makeWeek(w: number, overrides: Partial<Week> = {}): Week {
  return { w, ph: 'build' as any, rated: {}, skip: [], cross: [], ...overrides } as Week;
}

function sbr(discipline: 'swim' | 'bike' | 'run', n = discipline): Workout {
  return { n, d: '', t: discipline, discipline } as Workout;
}

function gym(): Workout {
  return { n: 'Strength', d: '45min', t: 'gym' } as Workout;
}

function actual(activityType: string): GarminActual {
  return {
    garminId: `strava-${Math.random().toString(36).slice(2)}`,
    distanceKm: 10, durationSec: 3000, avgPaceSecKm: 300,
    avgHR: 140, maxHR: 165, calories: 500, activityType,
  } as GarminActual;
}

describe('computeTriPlanAdherence — gym/cross-training excluded', () => {
  it('a planned gym session is not counted as a missed tri session', () => {
    // Week 1: swim + bike + run + gym planned. All three SBR done, gym not.
    // Without the fix: 3 done / 4 planned = 75%. With it: 3 / 3 = 100%.
    const wk1 = makeWeek(1, {
      triWorkouts: [sbr('swim'), sbr('bike'), sbr('run'), gym()],
      garminActuals: {
        a: actual('LAP_SWIMMING'),
        b: actual('CYCLING'),
        c: actual('RUNNING'),
      },
    });
    const s = makeState({ w: 2, wks: [wk1, makeWeek(2)] });
    const r = computeTriPlanAdherence(s);
    expect(r.totalPlanned).toBe(3);
    expect(r.totalCompleted).toBe(3);
    expect(r.pct).toBe(100);
  });

  it('a cross-training actual (rugby) does not affect the number', () => {
    // Two SBR planned, one done + a rugby session logged. Rugby is neither in
    // the denominator (not planned) nor credited (not swim/bike/run).
    const wk1 = makeWeek(1, {
      triWorkouts: [sbr('bike'), sbr('run')],
      garminActuals: {
        a: actual('CYCLING'),
        rugby: actual('RUGBY'),
      },
    });
    const s = makeState({ w: 2, wks: [wk1, makeWeek(2)] });
    const r = computeTriPlanAdherence(s);
    expect(r.totalPlanned).toBe(2);
    expect(r.totalCompleted).toBe(1); // only the bike, rugby ignored
    expect(r.pct).toBe(50);
  });

  it('a week of only gym sessions is excluded entirely (no SBR planned)', () => {
    const wk1 = makeWeek(1, { triWorkouts: [gym(), gym()] });
    const s = makeState({ w: 2, wks: [wk1, makeWeek(2)] });
    const r = computeTriPlanAdherence(s);
    expect(r.weeksIncluded).toBe(0);
    expect(r.pct).toBeNull();
  });
});
