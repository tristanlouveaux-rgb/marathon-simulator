import { describe, it, expect } from 'vitest';
import {
  assignDefaultDays,
  checkConsecutiveHardDays,
  moveWorkoutToDay,
  isHardWorkout,
} from './scheduler';
import type { Workout } from '@/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkout(overrides: Partial<Workout> & { t: string; n: string }): Workout {
  return { r: 5, d: '5km', ...overrides } as Workout;
}

// ---------------------------------------------------------------------------
// isHardWorkout
// ---------------------------------------------------------------------------

describe('isHardWorkout', () => {
  it('returns true for quality workout types', () => {
    expect(isHardWorkout('threshold')).toBe(true);
    expect(isHardWorkout('vo2')).toBe(true);
    expect(isHardWorkout('intervals')).toBe(true);
    expect(isHardWorkout('long')).toBe(true);
    expect(isHardWorkout('progressive')).toBe(true);
  });

  it('returns false for easy and cross-training types', () => {
    expect(isHardWorkout('easy')).toBe(false);
    expect(isHardWorkout('gym')).toBe(false);
    expect(isHardWorkout('cross')).toBe(false);
    expect(isHardWorkout('rest')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assignDefaultDays — standard case
// ---------------------------------------------------------------------------

describe('assignDefaultDays — standard scheduling', () => {
  it('assigns long run to Sunday (6)', () => {
    const workouts = [
      makeWorkout({ t: 'long', n: 'Long Run' }),
      makeWorkout({ t: 'easy', n: 'Easy Run' }),
    ];
    assignDefaultDays(workouts);
    const long = workouts.find(w => w.t === 'long')!;
    expect(long.dayOfWeek).toBe(6);
    expect(long.dayName).toBe('Sunday');
  });

  it('assigns first quality session to Tuesday (1) and second to Thursday (3)', () => {
    const workouts = [
      makeWorkout({ t: 'long', n: 'Long Run' }),
      makeWorkout({ t: 'threshold', n: 'Threshold Run' }),
      makeWorkout({ t: 'vo2', n: 'VO2 Run' }),
      makeWorkout({ t: 'easy', n: 'Easy Run' }),
    ];
    assignDefaultDays(workouts);
    const threshold = workouts.find(w => w.t === 'threshold')!;
    const vo2 = workouts.find(w => w.t === 'vo2')!;
    expect(threshold.dayOfWeek).toBe(1); // Tuesday
    expect(vo2.dayOfWeek).toBe(3);       // Thursday
  });

  it('assigns easy runs to days not taken by hard workouts', () => {
    const workouts = [
      makeWorkout({ t: 'long', n: 'Long Run' }),
      makeWorkout({ t: 'threshold', n: 'Threshold Run' }),
      makeWorkout({ t: 'easy', n: 'Easy Run 1' }),
      makeWorkout({ t: 'easy', n: 'Easy Run 2' }),
    ];
    assignDefaultDays(workouts);
    const hardDays = new Set(
      workouts.filter(w => w.t === 'long' || w.t === 'threshold').map(w => w.dayOfWeek)
    );
    const easyRuns = workouts.filter(w => w.t === 'easy');
    for (const run of easyRuns) {
      expect(hardDays.has(run.dayOfWeek)).toBe(false);
    }
  });

  it('gives each workout a dayOfWeek (no workout left undefined)', () => {
    const workouts = [
      makeWorkout({ t: 'long', n: 'Long Run' }),
      makeWorkout({ t: 'threshold', n: 'Threshold' }),
      makeWorkout({ t: 'easy', n: 'Easy 1' }),
      makeWorkout({ t: 'easy', n: 'Easy 2' }),
      makeWorkout({ t: 'gym', n: 'Gym' }),
    ];
    assignDefaultDays(workouts);
    for (const w of workouts) {
      expect(w.dayOfWeek).toBeDefined();
    }
  });

  it('deconflicts: no two workouts on the same day when <= 7 workouts', () => {
    const workouts = [
      makeWorkout({ t: 'long', n: 'Long Run' }),
      makeWorkout({ t: 'threshold', n: 'Threshold' }),
      makeWorkout({ t: 'easy', n: 'Easy 1' }),
      makeWorkout({ t: 'easy', n: 'Easy 2' }),
      makeWorkout({ t: 'gym', n: 'Gym' }),
    ];
    assignDefaultDays(workouts);
    const days = workouts.map(w => w.dayOfWeek);
    const uniqueDays = new Set(days);
    expect(uniqueDays.size).toBe(workouts.length);
  });

  it('uses wider spread (Mon/Wed/Fri/Sun) for 4+ hard sessions', () => {
    const workouts = [
      makeWorkout({ t: 'long', n: 'Long Run' }),
      makeWorkout({ t: 'threshold', n: 'Threshold 1' }),
      makeWorkout({ t: 'vo2', n: 'VO2' }),
      makeWorkout({ t: 'intervals', n: 'Intervals' }),
    ];
    assignDefaultDays(workouts);
    // Long run must be Sunday
    const long = workouts.find(w => w.t === 'long')!;
    expect(long.dayOfWeek).toBe(6);
    // Quality sessions should be on Mon (0), Wed (2), Fri (4)
    const qualityDays = workouts
      .filter(w => w.t !== 'long')
      .map(w => w.dayOfWeek)
      .sort();
    expect(qualityDays).toEqual([0, 2, 4]);
  });

  it('places cross-training on free days after runs are assigned', () => {
    const workouts = [
      makeWorkout({ t: 'long', n: 'Long Run' }),
      makeWorkout({ t: 'easy', n: 'Easy Run' }),
      makeWorkout({ t: 'cross', n: 'Cycling' }),
    ];
    assignDefaultDays(workouts);
    const crossDay = workouts.find(w => w.t === 'cross')!.dayOfWeek;
    const runDays = workouts.filter(w => w.t !== 'cross').map(w => w.dayOfWeek);
    expect(runDays).not.toContain(crossDay);
  });
});

// ---------------------------------------------------------------------------
// checkConsecutiveHardDays
// ---------------------------------------------------------------------------

describe('checkConsecutiveHardDays', () => {
  it('returns a warning for back-to-back hard days', () => {
    const workouts = [
      makeWorkout({ t: 'threshold', n: 'Threshold', dayOfWeek: 1, dayName: 'Tuesday' }),
      makeWorkout({ t: 'vo2', n: 'VO2', dayOfWeek: 2, dayName: 'Wednesday' }),
    ];
    const warnings = checkConsecutiveHardDays(workouts);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].level).toBe('critical');
  });

  it('returns no warning when hard days are separated', () => {
    const workouts = [
      makeWorkout({ t: 'threshold', n: 'Threshold', dayOfWeek: 1, dayName: 'Tuesday' }),
      makeWorkout({ t: 'easy', n: 'Easy', dayOfWeek: 2, dayName: 'Wednesday' }),
      makeWorkout({ t: 'long', n: 'Long Run', dayOfWeek: 6, dayName: 'Sunday' }),
    ];
    const warnings = checkConsecutiveHardDays(workouts);
    expect(warnings).toHaveLength(0);
  });

  it('warns when two hard workouts are on the same day', () => {
    const workouts = [
      makeWorkout({ t: 'threshold', n: 'Threshold', dayOfWeek: 2, dayName: 'Wednesday' }),
      makeWorkout({ t: 'vo2', n: 'VO2', dayOfWeek: 2, dayName: 'Wednesday' }),
    ];
    const warnings = checkConsecutiveHardDays(workouts);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not wrap Sunday → Monday as consecutive', () => {
    const workouts = [
      makeWorkout({ t: 'long', n: 'Long Run', dayOfWeek: 6, dayName: 'Sunday' }),
      makeWorkout({ t: 'threshold', n: 'Threshold', dayOfWeek: 0, dayName: 'Monday' }),
    ];
    const warnings = checkConsecutiveHardDays(workouts);
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// moveWorkoutToDay
// ---------------------------------------------------------------------------

describe('moveWorkoutToDay', () => {
  it('updates dayOfWeek and dayName', () => {
    const w = makeWorkout({ t: 'easy', n: 'Easy Run', dayOfWeek: 0 });
    moveWorkoutToDay(w, 3);
    expect(w.dayOfWeek).toBe(3);
    expect(w.dayName).toBe('Thursday');
  });
});
