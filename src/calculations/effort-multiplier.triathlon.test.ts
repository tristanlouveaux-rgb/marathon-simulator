import { describe, it, expect } from 'vitest';
import {
  triTrailingEffortScore,
  triEffortMultiplier,
  applyTriEffortMultipliers,
} from './effort-multiplier.triathlon';
import type { SimulatorState, Workout } from '@/types/state';

function workout(id: string, discipline: 'swim' | 'bike' | 'run', plannedRpe: number, durMin = 60): Workout {
  return { id, t: 'easy', n: 'Test', d: '60min', r: plannedRpe, discipline, estimatedDurationMin: durMin };
}

function state(weeks: Array<{ workouts: Workout[]; rated: Record<string, number | 'skip'> }>, currentWeek: number): SimulatorState {
  return {
    eventType: 'triathlon',
    w: currentWeek,
    wks: weeks.map(wk => ({ triWorkouts: wk.workouts, rated: wk.rated })),
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('triTrailingEffortScore', () => {
  it('no rated workouts → returns 0', () => {
    const s = state([
      { workouts: [workout('r1', 'run', 7)], rated: {} },
    ], 1);
    expect(triTrailingEffortScore(s, 'run')).toBe(0);
  });

  it('rated easier than planned → negative score', () => {
    const s = state([
      { workouts: [workout('r1', 'run', 7), workout('r2', 'run', 7)], rated: { r1: 5, r2: 5 } },
      { workouts: [workout('r3', 'run', 7)], rated: { r3: 5 } },
    ], 2);
    // Each workout: actual 5 - planned 7 = -2. Weekly mean = -2. Trailing avg = -2.
    expect(triTrailingEffortScore(s, 'run')).toBe(-2);
  });

  it('rated harder than planned → positive score', () => {
    const s = state([
      { workouts: [workout('b1', 'bike', 5)], rated: { b1: 8 } },
    ], 1);
    expect(triTrailingEffortScore(s, 'bike')).toBe(3);
  });

  it('per-discipline independence', () => {
    const s = state([
      {
        workouts: [
          workout('r1', 'run', 7),
          workout('b1', 'bike', 5),
        ],
        rated: { r1: 5, b1: 5 },
      },
    ], 1);
    expect(triTrailingEffortScore(s, 'run')).toBe(-2);  // run rated easy
    expect(triTrailingEffortScore(s, 'bike')).toBe(0);  // bike rated on target
    expect(triTrailingEffortScore(s, 'swim')).toBe(0);  // no swim data
  });

  it("'skip' rated entries are ignored, not counted as 0", () => {
    const s = state([
      { workouts: [workout('r1', 'run', 7), workout('r2', 'run', 7)], rated: { r1: 'skip', r2: 5 } },
    ], 1);
    // r1 skipped → not counted. r2: 5 - 7 = -2. Weekly mean = -2.
    expect(triTrailingEffortScore(s, 'run')).toBe(-2);
  });

  it('only looks at last 2 completed weeks (lookback window)', () => {
    const s = state([
      // Oldest week (3 weeks ago) — should be EXCLUDED
      { workouts: [workout('r0', 'run', 7)], rated: { r0: 9 } },  // very hard
      // Last week — INCLUDED
      { workouts: [workout('r1', 'run', 7)], rated: { r1: 5 } },  // easy
      // Two weeks ago — INCLUDED
      { workouts: [workout('r2', 'run', 7)], rated: { r2: 5 } },  // easy
    ], 3);
    // Lookback = 2 weeks back from currentWeek=3 → samples weeks 1 and 2 (indexes 1 and 2).
    // Both contributed easy ratings → mean -2. Week 0's hard rating is ignored.
    expect(triTrailingEffortScore(s, 'run')).toBeCloseTo(-2, 1);
  });
});

describe('triEffortMultiplier', () => {
  it('formula matches running: 1 - score * 0.05, clamped [0.85, 1.15]', () => {
    // score = -2 → 1 - (-2 * 0.05) = 1.10 → 10% longer next week
    const s = state([
      { workouts: [workout('r1', 'run', 7)], rated: { r1: 5 } },
    ], 1);
    expect(triEffortMultiplier(s, 'run')).toBeCloseTo(1.10, 2);
  });

  it('clamps at upper bound 1.15', () => {
    const s = state([
      { workouts: [workout('r1', 'run', 9)], rated: { r1: 1 } },  // 8 points easier
    ], 1);
    expect(triEffortMultiplier(s, 'run')).toBe(1.15);
  });

  it('clamps at lower bound 0.85', () => {
    const s = state([
      { workouts: [workout('r1', 'run', 1)], rated: { r1: 9 } },  // 8 points harder
    ], 1);
    expect(triEffortMultiplier(s, 'run')).toBe(0.85);
  });

  it('no data → multiplier = 1.0 (neutral)', () => {
    const s = state([], 0);
    expect(triEffortMultiplier(s, 'run')).toBe(1.0);
  });
});

describe('applyTriEffortMultipliers', () => {
  it('scales per-discipline durations independently', () => {
    const s = state([
      {
        workouts: [workout('r1', 'run', 7), workout('b1', 'bike', 5)],
        rated: { r1: 5, b1: 8 },  // run easy, bike hard
      },
    ], 1);
    const future: Workout[] = [
      workout('r2', 'run', 7, 60),    // expect 60 × 1.10 = 66
      workout('b2', 'bike', 5, 100),  // expect 100 × 0.85 = 85
      workout('s1', 'swim', 5, 30),   // no swim data → ×1.0 = 30
    ];
    applyTriEffortMultipliers(s, future);
    expect(future[0].estimatedDurationMin).toBe(66);
    expect(future[1].estimatedDurationMin).toBe(85);
    expect(future[2].estimatedDurationMin).toBe(30);
  });

  it('skips workouts without estimatedDurationMin', () => {
    const s = state([
      { workouts: [workout('r1', 'run', 7)], rated: { r1: 5 } },
    ], 1);
    const future: Workout[] = [
      { id: 'r2', t: 'easy', n: 'Test', d: '60min', r: 7, discipline: 'run' } as Workout,
    ];
    applyTriEffortMultipliers(s, future);
    expect(future[0].estimatedDurationMin).toBeUndefined();
  });
});
