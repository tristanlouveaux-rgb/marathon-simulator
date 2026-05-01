import { describe, it, expect } from 'vitest';
import { skipTriWorkout } from './tri-skip-handler';
import type { SimulatorState, Workout } from '@/types/state';

function workout(id: string, dow: number, type = 'bike_endurance', discipline: 'swim' | 'bike' | 'run' = 'bike'): Workout {
  return {
    id, t: type, discipline,
    n: 'Test', d: '60min', r: 5,
    dayOfWeek: dow,
  };
}

function state(currentWeek: number, weeks: Workout[][]): SimulatorState {
  return {
    eventType: 'triathlon',
    w: currentWeek,
    wks: weeks.map(triWorkouts => ({ triWorkouts })),
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('skipTriWorkout', () => {
  it('first skip clones to next week, marks current as skipped', () => {
    const s = state(0, [[workout('w1', 2)], []]);
    const r = skipTriWorkout(s, 'w1');
    expect(r.outcome).toBe('pushed');
    expect(r.pushedToWeek).toBe(1);
    expect(s.wks![0].triWorkouts![0].status).toBe('skipped');
    expect(s.wks![0].triWorkouts![0].skipCount).toBe(1);
    expect(s.wks![1].triWorkouts).toHaveLength(1);
    expect(s.wks![1].triWorkouts![0].status).toBe('planned');
  });

  it('cloned workout in next week starts fresh — first skip there pushes again', () => {
    const s = state(1, [
      [],
      [{ ...workout('w1__push1', 2), skipCount: 0 }],
      [],
    ]);
    const r = skipTriWorkout(s, 'w1__push1');
    expect(r.outcome).toBe('pushed');  // skipCount was 0 → first skip → push to week 2
    expect(s.wks![1].triWorkouts![0].status).toBe('skipped');
    expect(s.wks![2].triWorkouts).toHaveLength(1);
  });

  it('two skips in a row on the same workout (skipCount=1 already) → drops, no clone', () => {
    const initial = workout('w1', 2);
    initial.skipCount = 1;
    const s = state(0, [[initial], []]);
    const r = skipTriWorkout(s, 'w1');
    expect(r.outcome).toBe('dropped');
    expect(s.wks![0].triWorkouts![0].skipCount).toBe(2);
    expect(s.wks![1].triWorkouts).toEqual([]);  // no clone added
  });

  it('cloning preserves day-of-week if free', () => {
    const s = state(0, [[workout('w1', 3)], [workout('w2', 5)]]);
    skipTriWorkout(s, 'w1');
    const cloned = s.wks![1].triWorkouts!.find(w => w.id === 'w1__push1');
    expect(cloned?.dayOfWeek).toBe(3);
  });

  it('cloning falls back to a free day if preferred is taken', () => {
    const s = state(0, [[workout('w1', 3)], [workout('w2', 3)]]);
    skipTriWorkout(s, 'w1');
    const cloned = s.wks![1].triWorkouts!.find(w => w.id === 'w1__push1');
    expect(cloned?.dayOfWeek).not.toBe(3);
  });

  it('no-next-week → dropped', () => {
    const s = state(0, [[workout('w1', 2)]]);  // single week
    const r = skipTriWorkout(s, 'w1');
    expect(r.outcome).toBe('dropped');
    expect(s.wks![0].triWorkouts![0].status).toBe('skipped');
  });

  it('unknown workout id → not-found', () => {
    const s = state(0, [[workout('w1', 2)], []]);
    const r = skipTriWorkout(s, 'no-such-id');
    expect(r.outcome).toBe('not-found');
  });
});
