import { describe, it, expect } from 'vitest';
import { manualDoneTriActivities } from './tri-benchmarks-from-history';
import type { Week, Workout } from '@/types/state';

const PLAN_START = '2026-06-01'; // Monday

function wk(workouts: Partial<Workout>[], rated: Record<string, number | 'skip'>): Week {
  return { triWorkouts: workouts as Workout[], rated } as unknown as Week;
}

describe('manualDoneTriActivities', () => {
  it('returns [] without weeks or planStartDate', () => {
    expect(manualDoneTriActivities(undefined, PLAN_START)).toEqual([]);
    expect(manualDoneTriActivities([wk([], {})], undefined)).toEqual([]);
  });

  it('emits a synthetic activity for a manually-done bike session, load encoded as iTrimp×150', () => {
    const week = wk(
      [{ id: 'b1', n: 'Bike', discipline: 'bike', aerobic: 40, anaerobic: 10, estimatedDurationMin: 60, dayOfWeek: 1 }],
      { b1: 6 },
    );
    const out = manualDoneTriActivities([week], PLAN_START);
    expect(out).toHaveLength(1);
    const a = out[0]!;
    expect(a.activityType).toBe('CYCLING');
    expect(a.iTrimp).toBe((40 + 10) * 150); // 7500 → estimateTss recovers 50
    expect(a.durationSec).toBe(3600);
    expect(a.startTime!.slice(0, 10)).toBe('2026-06-02'); // week 0, Tue
  });

  it('maps disciplines to the right activityType', () => {
    const week = wk(
      [
        { id: 's', n: 'Swim', discipline: 'swim', aerobic: 30, anaerobic: 5 },
        { id: 'r', n: 'Run', discipline: 'run', aerobic: 50, anaerobic: 10 },
      ],
      { s: 5, r: 5 },
    );
    const types = manualDoneTriActivities([week], PLAN_START).map(a => a.activityType).sort();
    expect(types).toEqual(['RUNNING', 'SWIMMING']);
  });

  it('skips sessions covered by a real matched activity (override, no double-count)', () => {
    const week = wk(
      [{ id: 'b1', n: 'Bike', discipline: 'bike', aerobic: 40, anaerobic: 10, matchedActivityId: 'strava-123' }],
      { b1: 6 },
    );
    expect(manualDoneTriActivities([week], PLAN_START)).toEqual([]);
  });

  it("skips completed sessions and skipped/un-rated ones", () => {
    const week = wk(
      [
        { id: 'done', n: 'Bike', discipline: 'bike', aerobic: 40, anaerobic: 10, status: 'completed' },
        { id: 'skip', n: 'Bike2', discipline: 'bike', aerobic: 40, anaerobic: 10 },
        { id: 'none', n: 'Bike3', discipline: 'bike', aerobic: 40, anaerobic: 10 },
      ],
      { done: 6, skip: 'skip' },
    );
    expect(manualDoneTriActivities([week], PLAN_START)).toEqual([]);
  });

  it('skips sessions with no planned load or non-discipline kinds', () => {
    const week = wk(
      [
        { id: 'zero', n: 'Bike', discipline: 'bike', aerobic: 0, anaerobic: 0 },
        { id: 'station', n: 'Station', discipline: 'station', aerobic: 30, anaerobic: 20 },
      ],
      { zero: 6, station: 6 },
    );
    expect(manualDoneTriActivities([week], PLAN_START)).toEqual([]);
  });
});
