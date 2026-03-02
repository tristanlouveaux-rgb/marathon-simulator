import { describe, it, expect } from 'vitest';
import { applyAdjustments, workoutsToPlannedRuns } from './suggester';
import type { Workout } from '@/types';
import type { Adjustment } from './suggester';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkout(overrides: Partial<Workout> & { t: string; n: string }): Workout {
  return {
    r: 5,
    d: '8km (5:30/km+)',
    dayOfWeek: 0,
    aerobic: 80,
    anaerobic: 5,
    status: 'planned',
    ...overrides,
  } as Workout;
}

function makeAdj(overrides: Partial<Adjustment> & Pick<Adjustment, 'action'>): Adjustment {
  return {
    workoutId: 'Easy Run',
    dayIndex: 0,
    originalType: 'easy',
    originalDistanceKm: 8,
    newType: 'easy',
    newDistanceKm: 5,
    loadReduction: 20,
    ...overrides,
  };
}

const paces = { e: 330, t: 270, i: 240, m: 285, r: 210 };

// ---------------------------------------------------------------------------
// workoutsToPlannedRuns
// ---------------------------------------------------------------------------

describe('workoutsToPlannedRuns', () => {
  it('maps running workouts to PlannedRun objects', () => {
    const workouts = [
      makeWorkout({ t: 'easy', n: 'Easy Run', dayOfWeek: 0 }),
      makeWorkout({ t: 'long', n: 'Long Run', dayOfWeek: 6 }),
    ];
    const runs = workoutsToPlannedRuns(workouts);
    expect(runs).toHaveLength(2);
    expect(runs[0].workoutId).toBe('Easy Run');
    expect(runs[0].dayIndex).toBe(0);
  });

  it('excludes gym workouts', () => {
    const workouts = [
      makeWorkout({ t: 'easy', n: 'Easy Run' }),
      makeWorkout({ t: 'gym', n: 'Strength Session' }),
    ];
    const runs = workoutsToPlannedRuns(workouts);
    expect(runs).toHaveLength(1);
    expect(runs[0].workoutId).toBe('Easy Run');
  });

  it('excludes return_run and capacity_test types', () => {
    const workouts = [
      makeWorkout({ t: 'easy', n: 'Easy Run' }),
      makeWorkout({ t: 'return_run', n: 'Return Run' }),
      makeWorkout({ t: 'capacity_test', n: 'Capacity Test' }),
    ];
    const runs = workoutsToPlannedRuns(workouts);
    expect(runs).toHaveLength(1);
  });

  it('marks already-downgraded workouts (status=reduced) with alreadyDowngraded=true', () => {
    const workouts = [
      makeWorkout({ t: 'easy', n: 'Easy Run', status: 'planned' }),
      makeWorkout({ t: 'threshold', n: 'Threshold', status: 'reduced' }),
    ];
    const runs = workoutsToPlannedRuns(workouts);
    const threshold = runs.find(r => r.workoutId === 'Threshold')!;
    expect(threshold.alreadyDowngraded).toBe(true);
    const easy = runs.find(r => r.workoutId === 'Easy Run')!;
    expect(easy.alreadyDowngraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyAdjustments — replace (full coverage, newDistanceKm = 0)
// ---------------------------------------------------------------------------

describe('applyAdjustments — replace', () => {
  it('sets status=replaced and description to "0km (replaced)" when fully covered', () => {
    const workouts = [makeWorkout({ t: 'easy', n: 'Easy Run', dayOfWeek: 0 })];
    const adj = makeAdj({ action: 'replace', newDistanceKm: 0 });
    const result = applyAdjustments(workouts, [adj], 'Rugby', paces);
    expect(result[0].status).toBe('replaced');
    expect(result[0].d).toBe('0km (replaced)');
  });

  it('stores the original description in originalDistance', () => {
    const workouts = [makeWorkout({ t: 'easy', n: 'Easy Run', dayOfWeek: 0, d: '8km (5:30/km+)' })];
    const adj = makeAdj({ action: 'replace', newDistanceKm: 0 });
    const result = applyAdjustments(workouts, [adj], 'Rugby', paces);
    expect(result[0].originalDistance).toBe('8km (5:30/km+)');
  });

  it('converts to shakeout run (status=reduced) when newDistanceKm > 0', () => {
    const workouts = [makeWorkout({ t: 'threshold', n: 'Easy Run', dayOfWeek: 0 })];
    const adj = makeAdj({ action: 'replace', newDistanceKm: 3, newType: 'easy' });
    const result = applyAdjustments(workouts, [adj], 'Rugby', paces);
    expect(result[0].status).toBe('reduced');
    expect(result[0].t).toBe('easy');
    expect(result[0].rpe).toBe(3);
  });

  it('does not modify workouts that do not match the adjustment', () => {
    const workouts = [
      makeWorkout({ t: 'easy', n: 'Easy Run', dayOfWeek: 0 }),
      makeWorkout({ t: 'long', n: 'Long Run', dayOfWeek: 6 }),
    ];
    const adj = makeAdj({ action: 'replace', workoutId: 'Easy Run', dayIndex: 0, newDistanceKm: 0 });
    const result = applyAdjustments(workouts, [adj], 'Rugby', paces);
    expect(result[1].status).toBe('planned'); // Long run untouched
  });

  it('does not mutate the original workouts array', () => {
    const workouts = [makeWorkout({ t: 'easy', n: 'Easy Run', dayOfWeek: 0 })];
    const originalStatus = workouts[0].status;
    applyAdjustments(workouts, [makeAdj({ action: 'replace', newDistanceKm: 0 })], 'Rugby', paces);
    expect(workouts[0].status).toBe(originalStatus);
  });
});

// ---------------------------------------------------------------------------
// applyAdjustments — downgrade
// ---------------------------------------------------------------------------

describe('applyAdjustments — downgrade', () => {
  it('sets status=reduced', () => {
    const workouts = [makeWorkout({ t: 'threshold', n: 'Threshold Run', dayOfWeek: 1 })];
    const adj = makeAdj({
      action: 'downgrade',
      workoutId: 'Threshold Run',
      dayIndex: 1,
      originalType: 'threshold',
      newType: 'marathon_pace',
    });
    const result = applyAdjustments(workouts, [adj], 'Padel', paces);
    expect(result[0].status).toBe('reduced');
  });

  it('saves the original description in originalDistance', () => {
    const workouts = [makeWorkout({ t: 'threshold', n: 'Threshold Run', dayOfWeek: 1, d: '1km warm up\n4×5min @ 4:00/km\n1km cool down' })];
    const adj = makeAdj({
      action: 'downgrade',
      workoutId: 'Threshold Run',
      dayIndex: 1,
      originalType: 'threshold',
      newType: 'marathon_pace',
    });
    const result = applyAdjustments(workouts, [adj], 'Padel', paces);
    expect(result[0].originalDistance).toBeDefined();
  });

  it('converts progressive long run (last X@MP) to plain easy run', () => {
    const workouts = [makeWorkout({
      t: 'progressive',
      n: 'Progressive Long Run',
      dayOfWeek: 6,
      d: '16km: last 4km @ 4:45/km',
    })];
    const adj = makeAdj({
      action: 'downgrade',
      workoutId: 'Progressive Long Run',
      dayIndex: 6,
      originalType: 'progressive',
      newType: 'easy',
    });
    const result = applyAdjustments(workouts, [adj], 'Cycling', paces);
    expect(result[0].t).toBe('easy');
    // Should no longer contain the fast-finish instruction
    expect(result[0].d).not.toMatch(/last\s+\d/);
  });
});

// ---------------------------------------------------------------------------
// applyAdjustments — threshold → steady pace
// ---------------------------------------------------------------------------

describe('applyAdjustments — threshold downgrade uses steady pace label', () => {
  it('labels threshold→marathon_pace downgrade as "steady" not "marathon pace"', () => {
    const workouts = [makeWorkout({ t: 'threshold', n: 'Threshold Run', dayOfWeek: 1, d: '10km @ threshold' })];
    const adj = makeAdj({
      action: 'downgrade',
      workoutId: 'Threshold Run',
      dayIndex: 1,
      originalType: 'threshold',
      newType: 'marathon_pace',
    });
    const result = applyAdjustments(workouts, [adj], 'Padel', paces);
    // The description should reference steady pace, not marathon pace
    expect(result[0].d).toContain('steady');
  });
});
