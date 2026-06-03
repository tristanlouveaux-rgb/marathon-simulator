import { describe, it, expect } from 'vitest';
import {
  applyBodyweightOutcome,
  bodyweightFamilyKey,
  persistBodyweightProgress,
  applyBodyweightProgress,
  BODYWEIGHT_LADDER,
} from './bodyweight-progression';
import type { BodyweightProgressEntry } from '@/types/strength-log';
import type { Workout } from '@/types';

describe('bodyweightFamilyKey', () => {
  it('maps laddered bodyweight movements to their family', () => {
    expect(bodyweightFamilyKey('Bodyweight Squat')).toBe('squat');
    expect(bodyweightFamilyKey('Goblet Squat @50% 1RM')).toBe('squat');
    expect(bodyweightFamilyKey('Reverse Lunge')).toBe('lunge');
    expect(bodyweightFamilyKey('Glute Bridge')).toBe('hinge');
    expect(bodyweightFamilyKey('Single-Leg RDL')).toBe('hinge');
    expect(bodyweightFamilyKey('Calf Raises')).toBe('calf');
    expect(bodyweightFamilyKey('Plank')).toBe('plank');
    expect(bodyweightFamilyKey('Side Plank')).toBe('plank');
    expect(bodyweightFamilyKey('Step-Ups')).toBe('step-up');
  });
  it('excludes plyo, already-tracked compounds, split squats and static core', () => {
    for (const n of ['Jump Squat', 'Box Jumps', 'Bulgarian Split Squat', 'Split Squat',
      'Hip Thrust @50% 1RM', 'Kettlebell Deadlift', 'Dead Bug', 'Bird Dog', 'Wall Sit', 'Banded Clamshells']) {
      expect(bodyweightFamilyKey(n)).toBe('');
    }
  });
});

describe('applyBodyweightOutcome', () => {
  const D = '2026-06-03';
  it('advances one rung after 2 consecutive reps-left in base/build', () => {
    let e = applyBodyweightOutcome(undefined, 'squat', 'reps-left', 'base', D);
    expect(e.level).toBe(0);          // first easy: streak builds, no advance yet
    expect(e.easyStreak).toBe(1);
    e = applyBodyweightOutcome(e, 'squat', 'reps-left', 'base', D);
    expect(e.level).toBe(1);          // second easy: advance, streak resets
    expect(e.easyStreak).toBe(0);
  });
  it('does not advance outside base/build', () => {
    let e = applyBodyweightOutcome(undefined, 'squat', 'reps-left', 'peak', D);
    e = applyBodyweightOutcome(e, 'squat', 'reps-left', 'taper', D);
    expect(e.level).toBe(0);
  });
  it('barely steps DOWN a rung (then can climb back up)', () => {
    let e: BodyweightProgressEntry = { family: 'squat', level: 2, easyStreak: 0, lastDate: D };
    e = applyBodyweightOutcome(e, 'squat', 'barely', 'build', D);
    expect(e.level).toBe(1);
    // climb back: two easy sessions return to 2
    e = applyBodyweightOutcome(e, 'squat', 'reps-left', 'build', D);
    e = applyBodyweightOutcome(e, 'squat', 'reps-left', 'build', D);
    expect(e.level).toBe(2);
  });
  it('about-right holds and resets the streak', () => {
    let e = applyBodyweightOutcome(undefined, 'squat', 'reps-left', 'base', D);
    expect(e.easyStreak).toBe(1);
    e = applyBodyweightOutcome(e, 'squat', 'about-right', 'base', D);
    expect(e.level).toBe(0);
    expect(e.easyStreak).toBe(0);
  });
  it('never exceeds the ladder top or drops below 0', () => {
    const top = BODYWEIGHT_LADDER.squat.length - 1;
    let e: BodyweightProgressEntry = { family: 'squat', level: top, easyStreak: 1, lastDate: D };
    e = applyBodyweightOutcome(e, 'squat', 'reps-left', 'base', D);
    expect(e.level).toBe(top);
    let f: BodyweightProgressEntry = { family: 'squat', level: 0, easyStreak: 0, lastDate: D };
    f = applyBodyweightOutcome(f, 'squat', 'barely', 'base', D);
    expect(f.level).toBe(0);
  });
});

describe('persistBodyweightProgress', () => {
  it('updates each family once from the records', () => {
    const progress: Record<string, BodyweightProgressEntry> = {};
    const records = [
      { exerciseName: 'Bodyweight Squat', exerciseIndex: 0, rirBucket: 'reps-left' as const },
      { exerciseName: 'Bodyweight Squat', exerciseIndex: 0, rirBucket: 'reps-left' as const },
      { exerciseName: 'Plank', exerciseIndex: 1, rirBucket: 'about-right' as const },
    ];
    const changed = persistBodyweightProgress(records, progress, 'base', '2026-06-03');
    expect(changed).toBe(true);
    expect(progress.squat.easyStreak).toBe(1);
    expect(progress.plank.easyStreak).toBe(0);
  });
});

describe('applyBodyweightProgress (read-back)', () => {
  const wo = (): Workout => ({ t: 'gym', n: 'Bodyweight Foundation', r: 5, rpe: 5,
    d: ['3x10 Bodyweight Squat (Controlled depth) (60s rest)',
        '3x10 Glute Bridge (Squeeze) (45s rest)',
        '3x30s Plank (Flat back) (30s rest)',
        'Stretch between sets: hips, hamstrings, calves'].join('\n') } as Workout);

  it('leaves a fresh athlete unchanged', () => {
    const out = applyBodyweightProgress(wo(), {});
    expect(out.d).toBe(wo().d);
  });
  it('rewrites a progressed movement to its earned rung', () => {
    const progress: Record<string, BodyweightProgressEntry> = {
      squat: { family: 'squat', level: 2, easyStreak: 0, lastDate: '2026-06-03' },
    };
    const out = applyBodyweightProgress(wo(), progress);
    expect(out.d).toContain('3x20 Bodyweight Squat');   // squat advanced to rung 2
    expect(out.d).toContain('3x10 Glute Bridge');       // hinge untouched (level 0)
    expect(out.d).toContain('Stretch between sets');    // stretch line preserved
  });
});
