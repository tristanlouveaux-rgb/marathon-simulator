import { describe, it, expect } from 'vitest';
import { persistStrengthLifts, summariseLoggedLifts, seedManualLift } from './strength-log-persist';
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

// ---------------------------------------------------------------------------
// Rep-aware est1RM benchmark — 1RM estimates inflate with reps and are not
// comparable across rep schemes, so a lighter high-rep day must not mint a PR.
// ---------------------------------------------------------------------------

describe('persistStrengthLifts — rep-aware est1RM benchmark', () => {
  it('a lighter high-rep day does NOT advance the benchmark (no false PR)', () => {
    const s = {} as SimulatorState;
    persistStrengthLifts([rec({ weightKg: 80, reps: '5' })], s);   // est 93.3 @ 5 reps
    const e1 = s.strengthLog!.lifts['back-squat'];
    expect(e1.est1rmKg).toBeCloseTo(93.3, 1);
    expect(e1.est1rmReps).toBe(5);

    // 70kg x12 → Epley est 98 (HIGHER) but 12 > 5 reps, so not comparable.
    persistStrengthLifts([rec({ weightKg: 70, reps: '12' })], s);
    const e2 = s.strengthLog!.lifts['back-squat'];
    expect(e2.est1rmKg).toBeCloseTo(93.3, 1); // benchmark holds — no inflation
    expect(e2.est1rmReps).toBe(5);
    expect(e2.lastWeightKg).toBe(70);          // working-weight memory still updates
    expect(e2.lastReps).toBe('12');
  });

  it('a comparable heavier day advances the benchmark', () => {
    const s = {} as SimulatorState;
    persistStrengthLifts([rec({ weightKg: 80, reps: '5' })], s);
    persistStrengthLifts([rec({ weightKg: 90, reps: '5' })], s);
    const e = s.strengthLog!.lifts['back-squat'];
    expect(e.est1rmKg).toBeCloseTo(105, 1);    // 90*(1+5/30), advanced
    expect(e.est1rmReps).toBe(5);
  });

  it('fewer reps but a lower estimate does not advance (not a PR)', () => {
    const s = {} as SimulatorState;
    persistStrengthLifts([rec({ weightKg: 80, reps: '5' })], s);   // est 93.3
    persistStrengthLifts([rec({ weightKg: 80, reps: '3' })], s);   // est 88, fewer reps, lower
    const e = s.strengthLog!.lifts['back-squat'];
    expect(e.est1rmKg).toBeCloseTo(93.3, 1);   // holds
    expect(e.est1rmReps).toBe(5);
  });

  it('first observation sets the baseline at whatever reps', () => {
    const s = {} as SimulatorState;
    persistStrengthLifts([rec({ weightKg: 60, reps: '12' })], s);
    const e = s.strengthLog!.lifts['back-squat'];
    expect(e.est1rmKg).toBeCloseTo(84, 1);     // 60*(1+12/30)
    expect(e.est1rmReps).toBe(12);
  });

  it('backward-compat: an OLD entry with est1rmKg but no est1rmReps still advances', () => {
    // Pre-upgrade state has no est1rmReps. prevReps == null → treated as
    // comparable, so a heavier comparable log advances (no stuck benchmark).
    const s = { strengthLog: { lifts: { 'back-squat': {
      key: 'back-squat', displayName: 'Back Squat', lastWeightKg: 80, lastReps: '5',
      lastDate: '2026-01-01', est1rmKg: 93.3,  // no est1rmReps (old shape)
    } } } } as unknown as SimulatorState;
    persistStrengthLifts([rec({ weightKg: 90, reps: '5' })], s);
    const e = s.strengthLog!.lifts['back-squat'];
    expect(e.est1rmKg).toBeCloseTo(105, 1);    // advanced from the old baseline
    expect(e.est1rmReps).toBe(5);
  });
});

describe('seedManualLift', () => {
  it('seeds a direct 1RM (reps=1) with user provenance and a baseline history point', () => {
    const s = {} as SimulatorState;
    const ok = seedManualLift(s, { key: 'deadlift', displayName: 'Deadlift', weightKg: 140, reps: 1 });
    expect(ok).toBe(true);
    const e = s.strengthLog!.lifts['deadlift'];
    expect(e.est1rmKg).toBeCloseTo(140, 1); // a 1-rep max is the 1RM, not Epley'd
    expect(e.est1rmReps).toBe(1);
    expect(e.est1rmSource).toBe('user');
    expect(e.est1rmHistory).toHaveLength(1);
  });

  it('a direct 1RM does NOT seed working-weight memory (a 1RM is not a working set)', () => {
    const s = {} as SimulatorState;
    seedManualLift(s, { key: 'deadlift', displayName: 'Deadlift', weightKg: 140, reps: 1 });
    const e = s.strengthLog!.lifts['deadlift'];
    expect(e.lastWeightKg).toBeUndefined(); // no "Last: 140 x 1" / bump-from-a-max
    expect(e.lastReps).toBeUndefined();
  });

  it('a direct 1RM preserves existing working-weight memory', () => {
    const s = {} as SimulatorState;
    seedManualLift(s, { key: 'back-squat', displayName: 'Back Squat', weightKg: 100, reps: 5 }); // working set
    seedManualLift(s, { key: 'back-squat', displayName: 'Back Squat', weightKg: 130, reps: 1 }); // 1RM correction
    const e = s.strengthLog!.lifts['back-squat'];
    expect(e.lastWeightKg).toBe(100); // working memory kept
    expect(e.lastReps).toBe('5');
    expect(e.est1rmKg).toBeCloseTo(130, 1); // benchmark updated to the 1RM
  });

  it('a weight x reps entry DOES seed working-weight memory', () => {
    const s = {} as SimulatorState;
    seedManualLift(s, { key: 'bench-press', displayName: 'Bench Press', weightKg: 80, reps: 5 });
    const e = s.strengthLog!.lifts['bench-press'];
    expect(e.lastWeightKg).toBe(80);
    expect(e.lastReps).toBe('5');
  });

  it('derives the 1RM from a working weight x reps', () => {
    const s = {} as SimulatorState;
    seedManualLift(s, { key: 'back-squat', displayName: 'Back Squat', weightKg: 100, reps: 5 });
    const e = s.strengthLog!.lifts['back-squat'];
    expect(e.est1rmKg).toBeCloseTo(116.7, 1); // 100*(1+5/30)
    expect(e.est1rmReps).toBe(5);
    expect(e.est1rmSource).toBe('user');
  });

  it('is authoritative — overwrites an existing entry in either direction', () => {
    const s = {} as SimulatorState;
    seedManualLift(s, { key: 'bench-press', displayName: 'Bench Press', weightKg: 100, reps: 1 });
    seedManualLift(s, { key: 'bench-press', displayName: 'Bench Press', weightKg: 90, reps: 1 });
    const e = s.strengthLog!.lifts['bench-press'];
    expect(e.est1rmKg).toBeCloseTo(90, 1); // manual correction down is honoured
    expect(e.est1rmSource).toBe('user');
  });

  it('a later comparable logged set overrides the user value and flips provenance to derived', () => {
    const s = {} as SimulatorState;
    // User seeds from a 90kg x 5 working set (est1RM 105, reps gate = 5).
    seedManualLift(s, { key: 'back-squat', displayName: 'Back Squat', weightKg: 90, reps: 5 });
    expect(s.strengthLog!.lifts['back-squat'].est1rmSource).toBe('user');
    // A heavier comparable set (100kg x 5, est1RM 116.7) supersedes it.
    persistStrengthLifts([rec({ weightKg: 100, reps: '5' })], s);
    const e = s.strengthLog!.lifts['back-squat'];
    expect(e.est1rmKg).toBeCloseTo(116.7, 1);
    expect(e.est1rmSource).toBe('derived');
  });

  it('rejects non-positive input', () => {
    const s = {} as SimulatorState;
    expect(seedManualLift(s, { key: 'squat', displayName: 'Squat', weightKg: 0, reps: 5 })).toBe(false);
    expect(seedManualLift(s, { key: 'squat', displayName: 'Squat', weightKg: 100, reps: 0 })).toBe(false);
    expect(s.strengthLog).toBeUndefined();
  });
});
