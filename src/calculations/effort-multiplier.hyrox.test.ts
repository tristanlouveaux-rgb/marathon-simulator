import { describe, it, expect } from 'vitest';
import { hyroxTrailingEffortScore, hyroxEffortMultiplier } from './effort-multiplier.hyrox';
import type { SimulatorState, Workout } from '@/types/state';

function workout(id: string, plannedRpe: number, durMin = 45): Workout {
  return { id, t: 'hyrox_station_sled', n: 'Sled', d: '45min', r: plannedRpe, estimatedDurationMin: durMin } as Workout;
}

function state(weeks: Array<{ workouts: Workout[]; rated: Record<string, number | 'skip'> }>, currentWeek: number): SimulatorState {
  return {
    eventType: 'hyrox',
    w: currentWeek,
    wks: weeks.map(wk => ({ triWorkouts: wk.workouts, rated: wk.rated })),
    hyroxConfig: {},
  } as unknown as SimulatorState;
}

describe('hyroxTrailingEffortScore', () => {
  it('no rated workouts → returns 0 (neutral)', () => {
    expect(hyroxTrailingEffortScore(state([{ workouts: [workout('s1', 7)], rated: {} }], 1))).toBe(0);
  });

  it('rated harder than planned → positive score', () => {
    // 9 - 6 = +3
    expect(hyroxTrailingEffortScore(state([{ workouts: [workout('s1', 6)], rated: { s1: 9 } }], 1))).toBe(3);
  });

  it('rated easier than planned → negative score', () => {
    // 4 - 7 = -3
    expect(hyroxTrailingEffortScore(state([{ workouts: [workout('s1', 7)], rated: { s1: 4 } }], 1))).toBe(-3);
  });

  it('aggregates ALL HYROX sessions regardless of station/brick/run type', () => {
    const w: any[] = [
      { id: 'st', t: 'hyrox_station_sled', n: 'Sled', r: 6, estimatedDurationMin: 40 },
      { id: 'br', t: 'hyrox_brick', n: 'Brick', r: 7, estimatedDurationMin: 50 },
      { id: 'rn', t: 'hyrox_run', n: 'Run', r: 5, estimatedDurationMin: 30 },
    ];
    // devs: st 8-6=+2, br 9-7=+2, rn 7-5=+2 → mean +2
    const s = state([{ workouts: w as Workout[], rated: { st: 8, br: 9, rn: 7 } }], 1);
    expect(hyroxTrailingEffortScore(s)).toBe(2);
  });

  it("'skip' entries are ignored, not counted as 0", () => {
    const s = state([{ workouts: [workout('s1', 7), workout('s2', 7)], rated: { s1: 'skip', s2: 5 } }], 1);
    expect(hyroxTrailingEffortScore(s)).toBe(-2); // only s2: 5-7
  });

  it('only looks at the last 2 completed weeks', () => {
    const s = state([
      { workouts: [workout('s0', 7)], rated: { s0: 9 } },  // 3 weeks ago, EXCLUDED
      { workouts: [workout('s1', 7)], rated: { s1: 5 } },  // included
      { workouts: [workout('s2', 7)], rated: { s2: 5 } },  // included
    ], 3);
    expect(hyroxTrailingEffortScore(s)).toBeCloseTo(-2, 1);
  });

  it('under-duration guard: a session cut short cannot inflate next week', () => {
    // Rated easy (3 vs 7 = -4) but only 20 of 45 min done (< 80%). Guard clamps the
    // negative deviation to 0 so a cut-short session does not lengthen next week.
    const w: any = { id: 's1', t: 'hyrox_station_sled', n: 'Sled', r: 7, estimatedDurationMin: 45, matchedActivityId: 'a1' };
    const s = {
      eventType: 'hyrox', w: 1,
      wks: [{ triWorkouts: [w], rated: { s1: 3 }, garminActuals: { a1: { durationSec: 20 * 60 } } }],
      hyroxConfig: {},
    } as unknown as SimulatorState;
    expect(hyroxTrailingEffortScore(s)).toBe(0);
  });
});

describe('hyroxEffortMultiplier', () => {
  it('formula matches running: 1 - score * 0.05, clamped [0.85, 1.15]', () => {
    // easier (score -2) → 1 - (-2*0.05) = 1.10 → heavier next week
    expect(hyroxEffortMultiplier(state([{ workouts: [workout('s1', 7)], rated: { s1: 5 } }], 1))).toBeCloseTo(1.10, 2);
  });

  it('clamps at upper bound 1.15', () => {
    expect(hyroxEffortMultiplier(state([{ workouts: [workout('s1', 9)], rated: { s1: 1 } }], 1))).toBe(1.15);
  });

  it('clamps at lower bound 0.85', () => {
    expect(hyroxEffortMultiplier(state([{ workouts: [workout('s1', 1)], rated: { s1: 9 } }], 1))).toBe(0.85);
  });

  it('no data → 1.0 (neutral)', () => {
    expect(hyroxEffortMultiplier(state([], 0))).toBe(1.0);
  });
});
