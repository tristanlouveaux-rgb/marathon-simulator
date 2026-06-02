import { describe, it, expect } from 'vitest';
import { persistStrengthLifts, summariseLoggedLifts } from './strength-log-persist';
import type { SetRecord } from './strength-controller';
import type { SimulatorState } from '@/types/state';

function rec(over: Partial<SetRecord>): SetRecord {
  return {
    exerciseName: 'Back Squat', exerciseIndex: 0, setIndex: 0, setCount: 3,
    reps: '5', durationSec: 40, liftKey: 'back-squat', ...over,
  };
}

describe('persistStrengthLifts', () => {
  it('writes a lift entry with est1RM + history from a weighted record', () => {
    const s = {} as SimulatorState;
    const wrote = persistStrengthLifts([
      rec({ setIndex: 0, weightKg: 100 }),
      rec({ setIndex: 1, weightKg: 100 }),
      rec({ setIndex: 2, weightKg: 100, rirBucket: 'reps-left' }),
    ], s);
    expect(wrote).toBe(true);
    const e = s.strengthLog!.lifts['back-squat'];
    expect(e.lastWeightKg).toBe(100);
    expect(e.lastReps).toBe('5');
    expect(e.lastRir).toBe('reps-left');
    expect(e.est1rmKg).toBeCloseTo(116.7, 1); // 100*(1+5/30)
    expect(e.est1rmHistory).toHaveLength(1);
  });

  it('skips records with no liftKey (bodyweight/plyo/isometric)', () => {
    const s = {} as SimulatorState;
    const wrote = persistStrengthLifts([
      rec({ exerciseName: 'Front Plank', liftKey: undefined, weightKg: undefined, reps: '45s' }),
    ], s);
    expect(wrote).toBe(false);
    expect(s.strengthLog).toBeUndefined();
  });

  it('skips a trackable lift when the user entered no weight', () => {
    const s = {} as SimulatorState;
    const wrote = persistStrengthLifts([rec({ weightKg: undefined })], s);
    expect(wrote).toBe(false);
  });

  it('handles "8 each leg" reps for est1RM', () => {
    const s = {} as SimulatorState;
    persistStrengthLifts([
      rec({ exerciseName: 'Bulgarian Split Squat', liftKey: 'split-squat', reps: '8 each leg', weightKg: 40 }),
    ], s);
    const e = s.strengthLog!.lifts['split-squat'];
    expect(e.est1rmKg).toBeCloseTo(40 * (1 + 8 / 30), 1);
  });

  it('summariseLoggedLifts returns one entry per weighted trackable lift', () => {
    const lifts = summariseLoggedLifts([
      rec({ exerciseIndex: 0, exerciseName: 'Back Squat', liftKey: 'back-squat', weightKg: 100, reps: '5' }),
      rec({ exerciseIndex: 0, setIndex: 1, liftKey: 'back-squat', weightKg: 100 }),
      rec({ exerciseIndex: 1, exerciseName: 'Front Plank', liftKey: undefined, weightKg: undefined, reps: '45s' }),
      rec({ exerciseIndex: 2, exerciseName: 'Hip Thrust', liftKey: 'hip-thrust', weightKg: 80, reps: '8' }),
    ]);
    expect(lifts).toHaveLength(2); // squat + hip thrust; plank omitted
    expect(lifts![0]).toMatchObject({ exerciseName: 'Back Squat', weightKg: 100, reps: '5' });
    expect(lifts![0].estimatedOneRmKg).toBeCloseTo(116.7, 1);
    expect(lifts![1].exerciseName).toBe('Hip Thrust');
  });

  it('summariseLoggedLifts returns undefined when nothing weighted', () => {
    expect(summariseLoggedLifts([rec({ weightKg: undefined })])).toBeUndefined();
    expect(summariseLoggedLifts(undefined)).toBeUndefined();
  });

  it('updates an existing entry in place', () => {
    const s = { strengthLog: { lifts: { 'back-squat': {
      key: 'back-squat', displayName: 'Back Squat', lastWeightKg: 100, lastReps: '5', lastDate: '2026-01-01',
    } } } } as unknown as SimulatorState;
    persistStrengthLifts([rec({ weightKg: 102.5 })], s);
    expect(s.strengthLog!.lifts['back-squat'].lastWeightKg).toBe(102.5);
  });
});
