import { describe, it, expect } from 'vitest';
import { upsertWorkoutMod, removeWorkoutMods, writeAdjustmentMods, adjustableWorkouts } from './workout-mods';
import type { Week, WorkoutMod, Workout } from '@/types';

/**
 * One plan-change mod per workout (audit A2, A3, A15). Flows used to append, and
 * the resolver applies mods in order, so the last mod written won: a later small
 * ride brought back a replaced run or undid a deeper cut.
 */

const week = (mods: WorkoutMod[] = []): Week =>
  ({ w: 3, ph: 'build', rated: {}, workoutMods: mods } as unknown as Week);

const replaced: WorkoutMod = {
  name: 'Easy Run', dayOfWeek: 2, workoutId: 'W3-easy-1', status: 'replaced',
  modReason: 'Garmin: Cycling', originalDistance: '8km @ 6:00/km', newDistance: '0km (replaced)', newType: 'easy',
};

describe('upsertWorkoutMod', () => {
  it('a later change on the same workout replaces the earlier one instead of stacking', () => {
    const wk = week([{
      name: 'Easy Run', dayOfWeek: 2, workoutId: 'W3-easy-1', status: 'reduced',
      modReason: 'Garmin: Cycling', originalDistance: '8km @ 6:00/km', newDistance: '4.8km (was 8km)', newType: 'easy',
    }]);
    upsertWorkoutMod(wk, {
      name: 'Easy Run', dayOfWeek: 2, workoutId: 'W3-easy-1', status: 'reduced',
      modReason: 'ACWR: Training load', originalDistance: '4.8km (was 8km)', newDistance: '4km (was 4.8km)', newType: 'easy',
    });
    expect(wk.workoutMods).toHaveLength(1);
    const m = wk.workoutMods![0];
    expect(m.modReason).toBe('ACWR: Training load');
    // The plan's original stays the reference, and the note reads against it.
    expect(m.originalDistance).toBe('8km @ 6:00/km');
    expect(m.newDistance).toBe('4km (was 8km)');
    expect(m.previousMod?.modReason).toBe('Garmin: Cycling');
  });

  it('matches by stable id, so a moved session with a different day is still the same workout', () => {
    const wk = week([replaced]);
    upsertWorkoutMod(wk, { ...replaced, dayOfWeek: 4, status: 'reduced', modReason: 'GPS: Run', newDistance: '5km' });
    expect(wk.workoutMods).toHaveLength(1);
    expect(wk.workoutMods![0].modReason).toBe('GPS: Run');
  });

  it('leaves other workouts and pending timing suggestions alone', () => {
    const timing: WorkoutMod = {
      name: 'Easy Run', dayOfWeek: 2, workoutId: 'W3-easy-1', status: 'planned',
      modReason: 'Timing: hard session day before', newDistance: '8km', newType: 'easy',
    };
    const other: WorkoutMod = { ...replaced, name: 'Long Run', dayOfWeek: 6, workoutId: 'W3-long-0' };
    const wk = week([timing, other]);
    upsertWorkoutMod(wk, { ...replaced });
    expect(wk.workoutMods!.map(m => m.modReason)).toEqual(['Timing: hard session day before', 'Garmin: Cycling', 'Garmin: Cycling']);
    expect(wk.workoutMods!.filter(m => m.workoutId === 'W3-easy-1' && m.status === 'replaced')).toHaveLength(1);
  });

  it("never replaces the user's own Adjust unless the change is user-initiated", () => {
    const userMod: WorkoutMod = {
      name: 'Easy Run', dayOfWeek: 2, workoutId: 'W3-easy-1', status: 'reduced',
      modReason: 'UserScaled: adjusted for this session', userScaledAt: '2026-10-01T08:00:00Z',
      originalDistance: '8km', newDistance: '6km',
    };
    const wk = week([userMod]);
    expect(upsertWorkoutMod(wk, { ...replaced, modReason: 'Auto: Cycling' })).toBe(false);
    expect(wk.workoutMods).toEqual([userMod]);

    expect(upsertWorkoutMod(wk, { ...replaced, modReason: 'Recovery: downgraded to easy' }, { replaceUserAdjust: true })).toBe(true);
    expect(wk.workoutMods!.map(m => m.modReason)).toEqual(['Recovery: downgraded to easy']);
  });
});

describe('removeWorkoutMods', () => {
  it('removing a change restores the change it replaced, not the unmodified session', () => {
    const wk = week([replaced]);
    upsertWorkoutMod(wk, { ...replaced, status: 'reduced', modReason: 'ACWR: Training load', newDistance: '3km', appliedAt: '2026-10-05' });
    removeWorkoutMods(wk, m => m.modReason.startsWith('ACWR') && m.appliedAt === '2026-10-05');
    expect(wk.workoutMods).toHaveLength(1);
    expect(wk.workoutMods![0].status).toBe('replaced');
    expect(wk.workoutMods![0].modReason).toBe('Garmin: Cycling');
  });

  it('a removed change buried under a later one is pruned from the chain', () => {
    const wk = week([replaced]);
    upsertWorkoutMod(wk, { ...replaced, status: 'reduced', modReason: 'ACWR: Training load', newDistance: '3km' });
    removeWorkoutMods(wk, m => m.modReason.startsWith('Garmin:'));
    expect(wk.workoutMods).toHaveLength(1);
    expect(wk.workoutMods![0].modReason).toBe('ACWR: Training load');
    expect(wk.workoutMods![0].previousMod).toBeUndefined();
  });
});

describe('writeAdjustmentMods', () => {
  it('stamps the stable slot id on every written mod', () => {
    const modified: Workout[] = [
      { id: 'W3-easy-1', n: 'Easy Run', t: 'easy', d: '5km (was 8km)', r: 3, dayOfWeek: 2, status: 'reduced', originalDistance: '8km' },
    ];
    const wk = week();
    writeAdjustmentMods(wk, modified, [{ workoutId: 'Easy Run', dayIndex: 2 }], 'Garmin: Cycling');
    expect(wk.workoutMods![0]).toMatchObject({ workoutId: 'W3-easy-1', name: 'Easy Run', newDistance: '5km (was 8km)' });
  });

  it('suggestion candidates exclude sessions the user scaled by hand', () => {
    const ws = [{ n: 'A' }, { n: 'B', userScaledAt: '2026-10-01' }] as any[];
    expect(adjustableWorkouts(ws).map(w => w.n)).toEqual(['A']);
  });
});
