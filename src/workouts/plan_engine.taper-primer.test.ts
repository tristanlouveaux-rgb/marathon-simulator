import { describe, it, expect } from 'vitest';
import { generateWeekWorkouts } from '@/workouts';
import type { RaceDistance } from '@/types';
import { planWeekSessions, type PlanContext } from './plan_engine';
import { computeRunningPlanPhases } from './phases';
import type { SessionIntent } from './intent_to_workout';

/**
 * Race-week primer guard.
 *
 * Before the fix, the final taper week carried a full build-phase quality block
 * (e.g. "Threshold 3×8" = 24 min of threshold) 3 days before the race, because
 * `pickPhaseVariant` rotated taper like build and the variant structure ignored
 * the taper work-minute reduction. The taper preserves fitness and sheds fatigue;
 * the last quality session should be a short primer, not training (Mujika & Padilla
 * 2003; Bosquet et al. 2007). The race week now seats a fixed sharpener instead.
 * See plan_engine.ts `TAPER_PRIMER_THRESHOLD` / `TAPER_PRIMER_VO2`.
 */

function raceWeekWorkout(rd: RaceDistance, slot: string, tw = 14) {
  const ws = generateWeekWorkouts(
    'taper', 4, rd, 'Balanced', [], undefined, null, undefined, undefined, undefined,
    360, tw, tw, 45, 0,
    undefined, undefined, undefined, undefined, undefined,
  );
  return ws.find(w => w.t === slot);
}

describe('Race-week primer (final taper week)', () => {
  it('half-marathon race week threshold is a short primer, not a 3×8 block', () => {
    const thr = raceWeekWorkout('half', 'threshold');
    expect(thr, 'expected a threshold session in race week').toBeDefined();
    expect(thr!.n).toBe('Threshold 3×2');
    expect(thr!.d).toMatch(/3×2min/);
  });

  it('marathon race week threshold is the primer', () => {
    const thr = raceWeekWorkout('marathon', 'threshold');
    expect(thr, 'expected a threshold session in race week').toBeDefined();
    expect(thr!.n).toBe('Threshold 3×2');
  });

  it('5K race week vo2 is a short sharp primer, not a full interval block', () => {
    const v = raceWeekWorkout('5k', 'vo2');
    expect(v, 'expected a vo2 session in race week').toBeDefined();
    expect(v!.n).toBe('VO2 Builder 4×1');
  });

  it('contrast: a build-phase threshold is still a full block, not the primer', () => {
    const ws = generateWeekWorkouts(
      'build', 4, 'half', 'Balanced', [], undefined, null, undefined, undefined, undefined,
      360, 6, 14, 45, 0,
      undefined, undefined, undefined, undefined, undefined,
    );
    const thr = ws.find(w => w.t === 'threshold');
    expect(thr, 'expected a threshold session in a build week').toBeDefined();
    expect(thr!.n).not.toBe('Threshold 3×2');
  });
});

/**
 * ACWR caution does not remove the primer (2026-10-08). Race week was already
 * exempt from the high-ACWR ease-back (generator.ts) because the primer is a
 * minimal session in a week whose volume is already cut; the caution swap (one
 * quality session to easy) removed it anyway, in full plans and sharpening blocks.
 * Build weeks keep the caution swap (contrast).
 */
describe('race-week primer under ACWR caution', () => {
  const base = {
    runsPerWeek: 4, raceDistance: 'marathon' as RaceDistance, runnerType: 'Balanced' as const,
    fitnessLevel: 'intermediate', vdot: 45, easyPaceSecPerKm: 330,
    baselineKm: 40, archetype: 'consistent-runner' as const,
  };
  const primerCount = (xs: SessionIntent[]) => xs.filter(i => i.notes === 'Race-week primer').length;

  it('full 16-week plan: race week keeps the primer under caution', () => {
    const planPhases = computeRunningPlanPhases(16, 'marathon').map(p => p.ph);
    const ctx: PlanContext = { ...base, totalWeeks: 16, planPhases, weekIndex: 16, phase: 'taper', acwrStatus: 'caution' };
    expect(primerCount(planWeekSessions(ctx))).toBe(1);
  });

  it('7-week sharpening block: race week keeps the primer under caution', () => {
    const planPhases = computeRunningPlanPhases(7, 'marathon').map(p => p.ph);
    const ctx: PlanContext = {
      ...base, totalWeeks: 7, planPhases, weekIndex: 7, phase: 'taper', acwrStatus: 'caution',
      sharpening: { startLongMin: 100, startSource: 'history-30d' },
    };
    expect(primerCount(planWeekSessions(ctx))).toBe(1);
  });

  it('contrast: a build week under caution still carries one quality session fewer', () => {
    const planPhases = computeRunningPlanPhases(16, 'marathon').map(p => p.ph);
    const k = planPhases.indexOf('build') + 2;
    const q = (acwrStatus?: 'caution') => planWeekSessions({ ...base, totalWeeks: 16, planPhases, weekIndex: k, phase: planPhases[k - 1], acwrStatus })
      .filter(i => ['threshold', 'vo2', 'marathon_pace', 'float'].includes(i.slot)).length;
    expect(q('caution')).toBe(q() - 1);
  });
});
