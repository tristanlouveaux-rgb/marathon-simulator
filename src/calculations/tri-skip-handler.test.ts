import { describe, it, expect } from 'vitest';
import { pushTriWorkout, dropTriWorkout, skipTriWorkout } from './tri-skip-handler';
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

describe('pushTriWorkout', () => {
  it('first push clones to next week, marks current as skipped', () => {
    const s = state(0, [[workout('w1', 2)], []]);
    const r = pushTriWorkout(s, 'w1');
    expect(r.outcome).toBe('pushed');
    expect(r.pushedToWeek).toBe(1);
    expect(s.wks![0].triWorkouts![0].status).toBe('skipped');
    expect(s.wks![0].triWorkouts![0].pushCount).toBe(1);
    expect(s.wks![1].triWorkouts).toHaveLength(1);
    expect(s.wks![1].triWorkouts![0].status).toBe('planned');
    expect(s.wks![1].triWorkouts![0].pushCount).toBe(1);
  });

  it('cloned workout already carries pushCount=1 → second push refused', () => {
    const s = state(1, [
      [],
      [{ ...workout('w1__push1', 2), pushCount: 1 }],
      [],
    ]);
    const r = pushTriWorkout(s, 'w1__push1');
    expect(r.outcome).toBe('already-pushed');
    expect(s.wks![2].triWorkouts).toEqual([]);  // no further clone
  });

  it('no-next-week → falls back to dropped', () => {
    const s = state(0, [[workout('w1', 2)]]);  // single week
    const r = pushTriWorkout(s, 'w1');
    expect(r.outcome).toBe('dropped');
    expect(s.wks![0].triWorkouts![0].status).toBe('skipped');
  });

  it('cloning preserves day-of-week if free', () => {
    const s = state(0, [[workout('w1', 3)], [workout('w2', 5)]]);
    pushTriWorkout(s, 'w1');
    const cloned = s.wks![1].triWorkouts!.find(w => w.id === 'w1__push1');
    expect(cloned?.dayOfWeek).toBe(3);
  });

  it('cloning falls back to a free day if preferred is taken', () => {
    const s = state(0, [[workout('w1', 3)], [workout('w2', 3)]]);
    pushTriWorkout(s, 'w1');
    const cloned = s.wks![1].triWorkouts!.find(w => w.id === 'w1__push1');
    expect(cloned?.dayOfWeek).not.toBe(3);
  });

  it('unknown workout id → not-found', () => {
    const s = state(0, [[workout('w1', 2)], []]);
    const r = pushTriWorkout(s, 'no-such-id');
    expect(r.outcome).toBe('not-found');
  });
});

describe('dropTriWorkout', () => {
  it('marks workout skipped without cloning', () => {
    const s = state(0, [[workout('w1', 2)], []]);
    const r = dropTriWorkout(s, 'w1');
    expect(r.outcome).toBe('dropped');
    expect(s.wks![0].triWorkouts![0].status).toBe('skipped');
    expect(s.wks![1].triWorkouts).toEqual([]);
  });

  it('dropping an already-pushed clone is still allowed', () => {
    const s = state(1, [
      [],
      [{ ...workout('w1__push1', 2), pushCount: 1 }],
    ]);
    const r = dropTriWorkout(s, 'w1__push1');
    expect(r.outcome).toBe('dropped');
    expect(s.wks![1].triWorkouts![0].status).toBe('skipped');
  });
});

describe('skipTriWorkout (legacy wrapper)', () => {
  it('first call pushes, second call on lineage drops', () => {
    const s = state(0, [[workout('w1', 2)], []]);
    expect(skipTriWorkout(s, 'w1').outcome).toBe('pushed');
    const clonedId = s.wks![1].triWorkouts![0].id!;
    // Advance to next week and skip the clone — should drop, not push again.
    s.w = 1;
    s.wks!.push({ triWorkouts: [] } as any);
    expect(skipTriWorkout(s, clonedId).outcome).toBe('dropped');
    expect(s.wks![2].triWorkouts).toEqual([]);
  });
});
