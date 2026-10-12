import { describe, it, expect } from 'vitest';
import { applyTimingDowngradesFromWorkouts } from './timing-check';
import { createActivity } from './activities';
import { buildCrossTrainingPopup, workoutsToPlannedRuns, applyAdjustments, type Adjustment } from './suggester';
import { intentToWorkout, type SessionIntent } from '@/workouts/intent_to_workout';
import { calculateWorkoutLoad } from '@/workouts';
import { isLongRun } from '@/workouts/long-run';
import { TSS_RPE_BY_TYPE } from '@/constants/sports';
import { RUN_GENERATOR_RPE } from '@/constants/intensity-ladder';
import type { Week, Workout } from '@/types';

/**
 * A downgrade is one pace category down the running ladder per step, never up
 * (Tristan, 2026-10-05; audit A4, A8, X13). Ladder: vo2 → threshold → marathon
 * pace → easy → recovery (constants/intensity-ladder.ts).
 *
 * Before: the day-after timing check covered only threshold, vo2 and the long
 * run, so marathon pace, float and progressive sessions were never protected; a
 * long run one step down became marathon pace (harder). The cross-training
 * suggester retyped a cut long run 'easy' (so a later light session cut it again
 * under easy-run rules), sent a progressive run to marathon pace (the card read
 * "N km @ MP"), jumped an already-downgraded session straight to easy, and wrote
 * no RPE for any downgrade.
 */

const EASY = 330; // s/km. MP 5:01, threshold 4:35, vo2 4:27, recovery 6:10 (369.6, nearest whole second: displayPaceSec).

/** A session exactly as the plan generator writes it, priced the way it prices it. */
function gen(slot: SessionIntent['slot'], extra: Partial<SessionIntent> = {}, dayOfWeek = 6): Workout {
  const w = intentToWorkout(
    { dayIndex: 0, slot, totalMinutes: 60, workMinutes: 20, variantId: 'x', notes: '', ...extra },
    'marathon', 'Balanced', EASY,
  );
  const loads = calculateWorkoutLoad(w.t, w.d, (w.rpe ?? w.r ?? 5) * 10, EASY);
  return { ...w, dayOfWeek, aerobic: loads.aerobic, anaerobic: loads.anaerobic, status: 'planned' };
}

const SESSIONS: Record<string, Workout> = {
  vo2: gen('vo2'),
  threshold: gen('threshold'),
  float: gen('float', { reps: 6, repMinutes: 3, recoveryMinutes: 2 }),
  marathonPace: gen('marathon_pace'),
  progressive: gen('progressive', { workMinutes: 15 }),
  fastFinishLong: gen('long', { totalMinutes: 120, variantId: 'long_fast_finish' }),
  steadyLong: gen('long', { totalMinutes: 120 }),
};

// Monday 2026-10-05; a synced Saturday session with no iTRIMP is priced at
// 0.92 TSS/min, so its duration sets the prior-day TSS tier for Sunday.
const WEEK_START = '2026-10-05';
const weekWithSaturday = (tss: number): Week => ({
  w: 1, rated: {},
  garminActuals: {
    'strava-sat': { startTime: '2026-10-10T08:00:00Z', durationSec: Math.round((tss / 0.92) * 60), iTrimp: null },
  },
} as unknown as Week);

const timing = (tss: number, w: Workout, easyPace?: number) =>
  applyTimingDowngradesFromWorkouts(weekWithSaturday(tss), [w], WEEK_START, undefined, undefined, easyPace);

describe('day-after timing check: one pace category down for every session type', () => {
  it('flags every session above easy pace and the long run, never an easy run', () => {
    for (const [name, w] of Object.entries(SESSIONS)) {
      expect(timing(60, w), name).toHaveLength(1);
    }
    expect(timing(60, gen('easy'))).toHaveLength(0);
  });

  it('one step is one pace category down, never up, with the new type\'s generator RPE', () => {
    const expected: Record<string, string> = {
      vo2: 'threshold',
      threshold: 'marathon_pace',
      float: 'marathon_pace',
      marathonPace: 'easy',
      progressive: 'easy',
      fastFinishLong: 'long',
      steadyLong: 'recovery',
    };
    for (const [name, w] of Object.entries(SESSIONS)) {
      const [mod] = timing(60, w); // 50–74 TSS: one step, no cut
      expect(mod.newType, name).toBe(expected[name]);
      expect(mod.newRpe, name).toBe(RUN_GENERATOR_RPE[mod.newType!]);
      // Never harder: the new type's planned-load class sits below the original's,
      // or (fast-finish → easy long run) drops the marathon-pace finish.
      expect(TSS_RPE_BY_TYPE[mod.newType!], name).toBeLessThan(TSS_RPE_BY_TYPE[w.t]);
    }
  });

  it('the two-step tiers move two categories, floored at recovery', () => {
    const expected: Record<string, string> = {
      vo2: 'marathon_pace',
      threshold: 'easy',
      float: 'easy',
      marathonPace: 'recovery',
      progressive: 'recovery',
      fastFinishLong: 'recovery',
      steadyLong: 'recovery',
    };
    for (const [name, w] of Object.entries(SESSIONS)) {
      const [mod] = timing(110, w); // 100–124 TSS: two steps, 15% shorter
      expect(mod.newType, name).toBe(expected[name]);
    }
  });

  it('the fast-finish long run becomes an easy long run at the same distance', () => {
    expect(SESSIONS.fastFinishLong.d).toBe('22km: last 4 @ MP (5:01/km)');
    const [mod] = timing(60, SESSIONS.fastFinishLong, EASY);
    expect(mod.newType).toBe('long');
    expect(isLongRun({ t: mod.newType, longRun: true })).toBe(true);
    expect(mod.newDistance).toBe('22km @ 5:30/km');
    expect((mod as { suggestionLabel?: string }).suggestionLabel).toBe('easy pace');
  });

  it('the steady long run drops to recovery pace at the same distance', () => {
    expect(SESSIONS.steadyLong.d).toBe('22km @ 5:30/km');
    const [mod] = timing(60, SESSIONS.steadyLong, EASY);
    expect(mod.newType).toBe('recovery');
    expect(mod.newRpe).toBe(3);
    expect(mod.newDistance).toBe('22km @ 6:10/km');
    expect((mod as { suggestionLabel?: string }).suggestionLabel).toBe('recovery pace');
  });

  it('the new description carries the new category\'s pace, warm-up and cool-down untouched', () => {
    const [mod] = timing(60, SESSIONS.threshold, EASY);
    const [wu, main, cd] = mod.newDistance!.split('\n');
    const [origWu, , origCd] = SESSIONS.threshold.d.split('\n');
    expect(wu).toBe(origWu);
    expect(cd).toBe(origCd);
    expect(main).toBe('20min @ MP (5:01/km) (~4km)');
  });

  it('a 75–99 TSS day keeps the 10% cut on top of the one-step change', () => {
    const [mod] = timing(80, SESSIONS.steadyLong, EASY);
    expect(mod.newType).toBe('recovery');
    expect(mod.newDistance).toBe('19.8km @ 6:10/km');
  });
});

describe('cross-training suggester: downgrades follow the same ladder', () => {
  const ctx = { raceGoal: 'marathon' as const, plannedRunsPerWeek: 4, injuryMode: false };
  const heavyRide = createActivity('cycling', 60, 7, undefined, undefined, 1);
  const lightSpin = createActivity('cycling', 30, 3, undefined, undefined, 1);

  const longCut = (long: Workout) => {
    const popup = buildCrossTrainingPopup(ctx, workoutsToPlannedRuns([long]), heavyRide);
    const adj = popup.reduceOutcome.adjustments.find(a => a.workoutId === long.n)!;
    expect(adj).toBeDefined();
    expect(adj.action).toBe('reduce');
    return { adj, applied: applyAdjustments([long], [adj], 'cycling', { e: EASY } as any)[0] };
  };

  it('a cut long run keeps its long-run identity', () => {
    const { adj, applied } = longCut(SESSIONS.steadyLong);
    expect(adj.newType).toBe('long');
    expect(applied.t).toBe('long');
    expect(isLongRun(applied)).toBe(true);
    expect(applied.rpe).toBe(3);
  });

  it('a light session does not cut the already-cut long run again under easy-run rules', () => {
    const { applied } = longCut(SESSIONS.steadyLong);
    const popup = buildCrossTrainingPopup(ctx, workoutsToPlannedRuns([applied]), lightSpin);
    const again = [...popup.reduceOutcome.adjustments, ...popup.replaceOutcome.adjustments]
      .filter(a => a.workoutId === applied.n);
    expect(again).toEqual([]);
  });

  it('a cut fast-finish long run becomes an easy long run with the long run\'s RPE', () => {
    const { adj, applied } = longCut(SESSIONS.fastFinishLong);
    expect(adj.newType).toBe('long');
    expect(applied.t).toBe('long');
    expect(isLongRun(applied)).toBe(true);
    expect(applied.rpe).toBe(RUN_GENERATOR_RPE.long);
    expect(applied.d).toMatch(/^\d+(\.\d)?km \(was 22km\)$/);
  });

  it('a progressive run downgrades to an easy run of the same distance, never marathon pace', () => {
    const prog = { ...SESSIONS.progressive, dayOfWeek: 3 };
    expect(prog.d).toMatch(/last \d+ @ MP/);
    const popup = buildCrossTrainingPopup(ctx, workoutsToPlannedRuns([prog]), lightSpin);
    const adj = popup.reduceOutcome.adjustments.find(a => a.workoutId === prog.n)!;
    expect(adj.action).toBe('downgrade');
    expect(adj.newType).toBe('easy');
    const [applied] = applyAdjustments([prog], [adj], 'cycling', { e: EASY } as any);
    expect(applied.t).toBe('easy');
    expect(applied.d).toBe(`${parseInt(prog.d, 10)}km`);
    expect(applied.rpe).toBe(RUN_GENERATOR_RPE.easy);
  });

  it('an already-downgraded session steps one more category, not straight to easy', () => {
    const reducedThreshold = { ...SESSIONS.threshold, dayOfWeek: 2, status: 'reduced' as const };
    const popup = buildCrossTrainingPopup(ctx, workoutsToPlannedRuns([reducedThreshold]), heavyRide);
    const adj = popup.reduceOutcome.adjustments.find(a => a.workoutId === reducedThreshold.n)!;
    expect(adj.action).toBe('downgrade');
    expect(adj.newType).toBe('marathon_pace');
  });

  it('every downgrade writes the new type\'s generator RPE', () => {
    const cases: Array<[Workout, Adjustment['newType']]> = [
      [SESSIONS.vo2, 'threshold'],
      [SESSIONS.threshold, 'marathon_pace'],
      [SESSIONS.float, 'marathon_pace'],
      [SESSIONS.marathonPace, 'easy'],
    ];
    for (const [w, newType] of cases) {
      const adj: Adjustment = {
        workoutId: w.n, dayIndex: w.dayOfWeek!, action: 'downgrade',
        originalType: w.t as Adjustment['originalType'], originalDistanceKm: 5,
        newType, newDistanceKm: 5, loadReduction: 10,
      };
      const [applied] = applyAdjustments([w], [adj], 'cycling', { e: EASY, t: 275, m: 301, i: 267, r: 250 } as any);
      expect(applied.t, w.n).toBe(newType);
      expect(applied.rpe, w.n).toBe(RUN_GENERATOR_RPE[newType]);
      expect(applied.r, w.n).toBe(RUN_GENERATOR_RPE[newType]);
    }
  });
});
