import { describe, it, expect } from 'vitest';
import {
  raceDayEnduranceBeyondModel, raceDayEnduranceGapText, raceDayPlanDurability, marathonEnduranceGap, enduranceGapPlanContext,
} from './race-day-durability';
import { lowBaseMarathon } from '@/ui/wizard/steps/race-target-plan-note';
import { applyLongRunCap } from './run-durability';
import {
  plannedPeakWeeklyKm, computePeakWeeklyKm, extraRunAddsQualitySession, planWeekSessions,
  type PlanShapeInputs,
} from '@/workouts/plan_engine';
import { computeRunningPlanPhases } from '@/workouts/phases';
import { initializeWeeks } from '@/workouts/generator';
import type { SimulatorState } from '@/types';

/**
 * Tracking side of the sharpening block (M4 design v4 review, major 4 and
 * minors): the forecast credits only the volume and long runs the block
 * delivers, says plainly when a marathon plan's long runs stay under the
 * durability model's long-run bar, and the "Add a quality session" buttons
 * never promise a session the plan will not seat.
 */

const A: PlanShapeInputs = {
  runsPerWeek: 4, raceDistance: 'marathon', runnerType: 'Balanced', fitnessLevel: 'intermediate',
  vdot: 45, easyPaceSecPerKm: 330, totalWeeks: 7, baselineKm: 40, archetype: 'consistent-runner',
  planPhases: computeRunningPlanPhases(7, 'marathon').map(p => p.ph),
  sharpening: { startLongMin: 100, startSource: 'history-30d' },
};

describe('plannedPeakWeeklyKm: the forecast volume anchor reads what the plan delivers', () => {
  it('a block anchors on its own highest pre-taper week, below the full-plan destination', () => {
    // Example A peak week: 262 min at 5:30/km = 47.6 km.
    const peakWeek = planWeekSessions({ ...A, weekIndex: 5, phase: 'peak' }).reduce((a, i) => a + i.totalMinutes, 0);
    expect(plannedPeakWeeklyKm(A)).toBeCloseTo(peakWeek * 60 / 330, 6);
    expect(plannedPeakWeeklyKm(A)).toBeLessThan(computePeakWeeklyKm(A));
  });

  it('a taper-only block anchors on current volume; a full plan on computePeakWeeklyKm', () => {
    const two: PlanShapeInputs = { ...A, totalWeeks: 2, planPhases: ['taper', 'taper'] };
    expect(plannedPeakWeeklyKm(two)).toBe(40);
    const full: PlanShapeInputs = { ...A, totalWeeks: 16, planPhases: undefined, sharpening: undefined };
    expect(plannedPeakWeeklyKm(full)).toBe(computePeakWeeklyKm(full));
  });
});

describe('raceDayEnduranceGapText: no precise penalty outside the model\'s calibration', () => {
  it('a marathon plan whose longest run is under 0.70 x 2:45 gets the plain statement', () => {
    const r = applyLongRunCap(66 * 60, 'marathon', 0);
    expect(raceDayEnduranceBeyondModel(r, 'marathon')).toBe(true);
    expect(raceDayEnduranceGapText(r, 'marathon')).toBe(
      "The longest run before race day is about 1:06, short of the 2:45 marathon-readiness long run. The forecast assumes long-run endurance the plan does not build, so the finish time is optimistic.",
    );
  });

  it('a longest run under an hour reads in minutes, not 0:MM (visual QA 2026-10-08)', () => {
    const r = applyLongRunCap(36 * 60, 'marathon', 0);
    expect(raceDayEnduranceGapText(r, 'marathon')).toBe(
      "The longest run before race day is about 36 minutes, short of the 2:45 marathon-readiness long run. The forecast assumes long-run endurance the plan does not build, so the finish time is optimistic.",
    );
  });

  it('example A (2:01 long run) and every half keep the precise penalty', () => {
    expect(raceDayEnduranceBeyondModel(applyLongRunCap(121 * 60, 'marathon', 1), 'marathon')).toBe(false);
    expect(raceDayEnduranceGapText(applyLongRunCap(40 * 60, 'half', 0), 'half')).toBeNull();
    expect(raceDayEnduranceGapText(undefined, 'marathon')).toBeNull();
  });

  it('a case-b marathon block (no run in 30 days) is flagged from the plan itself', () => {
    const wks = initializeWeeks(7, { raceDistance: 'marathon' });
    const s = {
      rw: 4, rd: 'marathon', typ: 'Balanced', tw: 7, v: 45, pac: { e: 330 }, wks,
      onboarding: { experienceLevel: 'intermediate' }, continuousMode: false, eventType: 'running',
      detectedWeeklyKm: 0, athleteArchetype: { archetype: 'detrained-with-history' }, wkm: 0,
      planStartDate: '2026-10-05',
      sharpenBlock: { v: 1, startLongMin: 30, startSource: 'history-no-recent-run', recentLongestMin: null, noSignal: false, trainingWeeks: 7, builtISO: '2026-10-05' },
    } as unknown as SimulatorState;
    const r = raceDayPlanDurability(s, Date.parse('2026-10-05'));
    expect(r).not.toBeNull();
    expect(Math.round(r!.longestRunSec / 60)).toBe(39);
    expect(raceDayEnduranceBeyondModel(r, 'marathon')).toBe(true);
  });
});

describe('one low-base check for the race page and the forecast (marathonEnduranceGap)', () => {
  // Before: the race page flagged a beginner, no run in 30 days, or a projected peak
  // long run under 1:55; the forecast surfaces flagged only a longest run under 1:55.
  // A beginner whose block reaches 2:01 saw the race-page warning and a forecast with
  // no plain statement. Both now read marathonEnduranceGap.
  const NOW = new Date(2026, 9, 7, 10, 0);
  const RACE_6WK = '2026-11-15';
  const runner = (experienceLevel: string, daysAgo: number) => ({
    v: 45, pac: { e: 330 } as any, onboarding: {} as any, athleteArchetype: { archetype: 'consistent-runner' as const },
    onboardingRunHistory: [{ startTime: new Date(NOW.getTime() - daysAgo * 86400000).toISOString(), distKm: 18.2, durSec: 6000, activityType: 'RUNNING' }],
  });
  const blockState = (experienceLevel: string, startSource: string) => ({
    continuousMode: false, onboarding: { experienceLevel },
    sharpenBlock: { v: 1, startLongMin: 100, startSource, recentLongestMin: 100, noSignal: false, trainingWeeks: 6, builtISO: '2026-10-07' },
  }) as unknown as SimulatorState;
  // The plan's longest run before race day reaches 2:01: inside the model's calibration.
  const r = applyLongRunCap(121 * 60, 'marathon', 1);

  it('a beginner marathon block: the race page and the forecast both say it plainly; the penalty stays estimable', () => {
    expect(lowBaseMarathon('marathon', RACE_6WK, runner('beginner', 5), 'beginner', NOW)).not.toBeNull();
    const plan = enduranceGapPlanContext(blockState('beginner', 'history-30d'));
    expect(marathonEnduranceGap({ rd: 'marathon', ...plan, longestRunMin: 121 })).toEqual({ beginner: true, noRecentRun: false, shortLongRuns: false });
    expect(raceDayEnduranceGapText(r, 'marathon', plan)).toContain('so the finish time is optimistic');
    expect(raceDayEnduranceBeyondModel(r, 'marathon')).toBe(false);
  });

  it('no run in the 30 days before build: both surfaces flag it', () => {
    expect(lowBaseMarathon('marathon', RACE_6WK, runner('intermediate', 60), 'intermediate', NOW)).not.toBeNull();
    const plan = enduranceGapPlanContext(blockState('intermediate', 'history-no-recent-run'));
    expect(raceDayEnduranceGapText(r, 'marathon', plan)).not.toBeNull();
  });

  it('example A (intermediate, 1:40 recent longest, block reaches 2:01): neither surface flags it', () => {
    expect(lowBaseMarathon('marathon', RACE_6WK, runner('intermediate', 5), 'intermediate', NOW)).toBeNull();
    expect(raceDayEnduranceGapText(r, 'marathon', enduranceGapPlanContext(blockState('intermediate', 'history-30d')))).toBeNull();
  });

  it('a beginner whose block reaches the 2:45 marathon-readiness long run: neither surface flags it', () => {
    // Review 2026-10-07: a 30 km run in the last 30 days at 5:30/km (165 min, the novice
    // long-run cap) made the race page say "Long runs reach about 2:45, short of the 2:45
    // marathon-readiness long run" while the forecast said nothing. The threshold guard
    // now sits inside marathonEnduranceGap, the one check both surfaces read.
    const thirtyKm = { ...runner('beginner', 5), onboardingRunHistory: [{ startTime: new Date(NOW.getTime() - 5 * 86400000).toISOString(), distKm: 30, durSec: 30 * 330, activityType: 'RUNNING' }] };
    expect(lowBaseMarathon('marathon', RACE_6WK, thirtyKm, 'beginner', NOW)).toBeNull();
    const plan = enduranceGapPlanContext(blockState('beginner', 'history-30d'));
    expect(marathonEnduranceGap({ rd: 'marathon', ...plan, longestRunMin: 165 })).toBeNull();
    expect(marathonEnduranceGap({ rd: 'marathon', ...plan, longestRunMin: 164 })).toEqual({ beginner: true, noRecentRun: false, shortLongRuns: false });
    expect(raceDayEnduranceGapText(applyLongRunCap(165 * 60, 'marathon', 1), 'marathon', plan)).toBeNull();
  });

  it('a beginner on a full marathon build (no sharpening block) is outside the owner decision', () => {
    const full = { continuousMode: false, onboarding: { experienceLevel: 'beginner' }, sharpenBlock: undefined } as unknown as SimulatorState;
    expect(raceDayEnduranceGapText(r, 'marathon', enduranceGapPlanContext(full))).toBeNull();
    expect(lowBaseMarathon('marathon', '2027-01-24', runner('beginner', 5), 'beginner', NOW)).toBeNull();
  });
});

describe('extraRunAddsQualitySession: the add-a-session buttons tell the truth', () => {
  it('example A already seats its two quality sessions: a fifth run is an easy run', () => {
    expect(extraRunAddsQualitySession(A, 3)).toBe(false);
  });

  it('three runs a week hold one quality session (one slot stays easy); a fourth run makes room for a second', () => {
    const full: PlanShapeInputs = { ...A, runsPerWeek: 3, totalWeeks: 16, planPhases: undefined, sharpening: undefined };
    expect(extraRunAddsQualitySession(full, 8)).toBe(true);
  });

  it('out-of-range weeks never promise a session', () => {
    expect(extraRunAddsQualitySession(A, 0)).toBe(false);
    expect(extraRunAddsQualitySession(A, 8)).toBe(false);
  });
});
