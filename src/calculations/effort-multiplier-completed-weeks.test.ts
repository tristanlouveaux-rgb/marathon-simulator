/**
 * Triathlon and HYROX effort scores read completed weeks only (mirror of
 * running's getTrailingEffortScore). s.w is 1-based: wks[s.w - 1] is the week
 * in progress, and its partial ratings must not move the score, or a mid-week
 * regeneration (injury save) and the HYROX plan note rescale the current week
 * by its own ratings.
 */
import { describe, it, expect } from 'vitest';
import type { SimulatorState } from '@/types/state';
import { hyroxTrailingEffortScore } from './effort-multiplier.hyrox';
import { triTrailingEffortScore } from './effort-multiplier.triathlon';

function week(n: number, rated: Record<string, number>, discipline: 'run' | 'station' = 'run') {
  return {
    w: n, ph: 'build', rated, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, adhocWorkouts: [], garminPending: [], garminMatched: {}, garminActuals: {},
    triWorkouts: [
      { id: `W${n}-a`, n: 'Session A', t: 'easy', discipline, d: '40 min', r: 5, rpe: 5, estimatedDurationMin: 40 },
      { id: `W${n}-b`, n: 'Session B', t: 'easy', discipline, d: '40 min', r: 5, rpe: 5, estimatedDurationMin: 40 },
    ],
  } as any;
}

function state(currentWeek: number, wks: any[], eventType: 'hyrox' | 'triathlon'): SimulatorState {
  return { w: currentWeek, wks, eventType } as unknown as SimulatorState;
}

describe('effort scores ignore the week in progress', () => {
  it('HYROX: easy ratings in the current week leave the score neutral', () => {
    const s = state(3, [week(1, {}), week(2, {}), week(3, { 'W3-a': 2, 'W3-b': 2 })], 'hyrox');
    expect(hyroxTrailingEffortScore(s)).toBe(0);
  });

  it('HYROX: the same ratings in the last completed week do count', () => {
    const s = state(3, [week(1, {}), week(2, { 'W2-a': 2, 'W2-b': 2 }), week(3, {})], 'hyrox');
    expect(hyroxTrailingEffortScore(s)).toBeLessThan(0);
  });

  it('triathlon: easy run ratings in the current week leave the run score neutral', () => {
    const s = state(3, [week(1, {}), week(2, {}), week(3, { 'W3-a': 2, 'W3-b': 2 })], 'triathlon');
    expect(triTrailingEffortScore(s, 'run')).toBe(0);
  });

  it('triathlon: the same ratings in the last completed week do count', () => {
    const s = state(3, [week(1, {}), week(2, { 'W2-a': 2, 'W2-b': 2 }), week(3, {})], 'triathlon');
    expect(triTrailingEffortScore(s, 'run')).toBeLessThan(0);
  });
});
