import { describe, it, expect } from 'vitest';
import { applyTimingDowngradesFromWorkouts } from './timing-check';
import { createActivity } from './activities';
import { buildCrossTrainingPopup, workoutsToPlannedRuns, type SuggestionPopup } from './suggester';
import type { Week, Workout } from '@/types';

/**
 * Audit X5: the fast-finish long run is t:'progressive', so every long-run rule
 * keyed on t === 'long' skipped it. These tests pin that it now gets the same
 * treatment as the steady long run (shared isLongRun helper).
 */

// Same distance and planned load, so any difference in treatment comes from the
// session's long-run identity alone.
const FF: Workout = {
  t: 'progressive', n: 'Long Run (Fast Finish)', d: '24km: last 5 @ MP',
  r: 5, rpe: 5, dayOfWeek: 6, aerobic: 180, anaerobic: 20, longRun: true,
};
const STEADY: Workout = {
  t: 'long', n: 'Long Run', d: '24km', r: 3, rpe: 3, dayOfWeek: 6, aerobic: 180, anaerobic: 20, longRun: true,
};

describe('timing check: fast-finish long run uses the long-run sub-ladder', () => {
  // Monday 2026-10-05. A 2 h Saturday session (no iTRIMP → 0.92 TSS/min ≈ 110 TSS)
  // sits in the ≥100 TSS tier, so the Sunday session after it is flagged.
  const weekStart = '2026-10-05';
  const wk = {
    w: 1, rated: {},
    garminActuals: { 'strava-1': { startTime: '2026-10-10T08:00:00Z', durationSec: 7200, iTrimp: null } },
  } as unknown as Week;

  it('flags the fast-finish long run the day after a hard session, like the steady long run', () => {
    const ffMods = applyTimingDowngradesFromWorkouts(wk, [FF], weekStart);
    const steadyMods = applyTimingDowngradesFromWorkouts(wk, [STEADY], weekStart);
    expect(steadyMods).toHaveLength(1);
    expect(ffMods).toHaveLength(1);
    expect(ffMods[0].name).toBe('Long Run (Fast Finish)');
    expect(ffMods[0].newType).toBe(steadyMods[0].newType);
  });

  it('stepped down to easy, the fast-finish run drops its marathon-pace finish', () => {
    // ≈110 TSS the day before → 2 steps (long → easy) and 15% shorter.
    const [ff] = applyTimingDowngradesFromWorkouts(wk, [FF], weekStart);
    const [steady] = applyTimingDowngradesFromWorkouts(wk, [STEADY], weekStart);
    expect(ff.newType).toBe('easy');
    expect(ff.newDistance).toBe('20.4 km');
    expect(ff.newDistance).not.toMatch(/MP|last/);
    // Same accepted session as the steady long run of the same distance.
    expect(ff.newDistance).toBe(steady.newDistance);
  });

  it('still ignores an ordinary progressive run (no long-run stamp)', () => {
    const plain: Workout = { ...FF, n: 'Progressive Run', longRun: undefined };
    expect(applyTimingDowngradesFromWorkouts(wk, [plain], weekStart)).toHaveLength(0);
  });
});

describe('cross-training suggester: fast-finish long run keeps long-run protections', () => {
  const week = (long: Workout): Workout[] => [
    { t: 'easy', n: 'Easy Run', d: '8km', r: 3, rpe: 3, dayOfWeek: 0, aerobic: 60, anaerobic: 5 },
    { t: 'threshold', n: 'Threshold', d: '10km', r: 7, rpe: 7, dayOfWeek: 1, aerobic: 100, anaerobic: 30 },
    { t: 'easy', n: 'Easy Run 2', d: '8km', r: 3, rpe: 3, dayOfWeek: 3, aerobic: 60, anaerobic: 5 },
    long,
  ];
  const longAdjustments = (popup: SuggestionPopup, name: string) => [
    ...popup.reduceOutcome.adjustments,
    ...popup.replaceOutcome.adjustments,
  ].filter(a => a.workoutId === name);

  const sessions: Array<[string, number, number]> = [
    ['cycling', 240, 7],
    ['swimming', 120, 6],
    ['soccer', 90, 8],
  ];

  for (const [sport, dur, rpe] of sessions) {
    it(`${sport} ${dur}min: never replaced or intensity-downgraded, and treated like the steady long run`, () => {
      const ctx = { raceGoal: 'marathon' as const, plannedRunsPerWeek: 4, injuryMode: false };
      const act = createActivity(sport, dur, rpe, undefined, undefined, 1);

      const ffPopup = buildCrossTrainingPopup(ctx, workoutsToPlannedRuns(week(FF)), act);
      const ffAdj = longAdjustments(ffPopup, FF.n);
      for (const a of ffAdj) {
        expect(a.action, `${sport}: ${JSON.stringify(a)}`).not.toBe('replace');
        expect(a.action, `${sport}: ${JSON.stringify(a)}`).not.toBe('downgrade');
      }

      const steadyPopup = buildCrossTrainingPopup(ctx, workoutsToPlannedRuns(week(STEADY)), act);
      const steadyAdj = longAdjustments(steadyPopup, STEADY.n);
      expect(ffAdj.map(a => a.action)).toEqual(steadyAdj.map(a => a.action));
    });
  }

  it('carries the long-run stamp onto the planned run', () => {
    const runs = workoutsToPlannedRuns(week(FF));
    expect(runs.find(r => r.workoutId === FF.n)!.longRun).toBe(true);
    expect(runs.find(r => r.workoutId === 'Threshold')!.longRun).toBeUndefined();
  });
});
