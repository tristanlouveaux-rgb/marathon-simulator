import { describe, it, expect } from 'vitest';
import { planWeekSessions, type PlanContext } from './plan_engine';

/**
 * Tests for the easy-run floor + consolidation in `applyHoursBudget`
 * (2026-06-02 rework).
 *
 * Contract:
 *   - A single easy-run floor, EASY_MIN = 25 min. An easy run is never shorter
 *     than 25 min. Below that, the run-day is dropped, not shrunk.
 *   - When the budget is tight, easy runs CONSOLIDATE into fewer, longer runs
 *     rather than many fragments. At extreme tightness, all easy days drop and
 *     the long run carries the week's easy volume.
 *   - Quality work (threshold / vo2 / mp / float) is never trimmed.
 *   - The long run keeps its two-tier floor (40 m standard, 30 m soft).
 */
describe('applyHoursBudget — easy floor + consolidation', () => {
  const baseCtx: PlanContext = {
    runsPerWeek: 4,
    raceDistance: 'half',
    runnerType: 'Balanced',
    phase: 'build',
    fitnessLevel: 'intermediate',
    weekIndex: 4,
    totalWeeks: 12,
    vdot: 45,
  };

  const totalMin = (intents: ReturnType<typeof planWeekSessions>) =>
    intents.reduce((s, i) => s + i.totalMinutes, 0);

  it('does not scale anything when budget is generous', () => {
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 10 });
    expect(totalMin(intents)).toBeLessThanOrEqual(600);
    const easy = intents.filter(i => i.slot === 'easy');
    for (const e of easy) expect(e.totalMinutes).toBeGreaterThanOrEqual(25);
  });

  it('never produces an easy run below the 25-min floor at any budget', () => {
    for (const hrs of [10, 5, 4, 3, 2, 1.5, 1, 0.5]) {
      const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: hrs });
      for (const e of intents.filter(i => i.slot === 'easy')) {
        expect(e.totalMinutes).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it('consolidates into fewer easy runs as the budget tightens', () => {
    const loose = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 10 });
    const tight = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 2 });
    const looseEasy = loose.filter(i => i.slot === 'easy').length;
    const tightEasy = tight.filter(i => i.slot === 'easy').length;
    expect(tightEasy).toBeLessThanOrEqual(looseEasy);
  });

  it('keeps exactly one easy run at the floor even when the budget cannot fit it', () => {
    // 0.5 h = 30 min. A half-marathon plan exceeds that with the long run
    // alone, but we never consolidate easy running to zero — one survives at
    // the 25-min floor (accepted overflow, surfaced by the budget banner).
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 0.5 });
    const easy = intents.filter(i => i.slot === 'easy');
    expect(easy.length).toBe(1);
    expect(easy[0].totalMinutes).toBe(25);
    expect(intents.find(i => i.slot === 'long')).toBeTruthy();
  });

  it('caps quality sessions on a low-volume week and lifts them as volume grows', () => {
    // Low ramp budget (14 km/wk) → at most one quality session, despite the
    // intermediate ability cap of 2.
    const low = planWeekSessions({
      ...baseCtx, raceDistance: 'marathon', phase: 'build', weekIndex: 1,
      totalWeeks: 40, baselineKm: 14, archetype: 'consistent-runner', easyPaceSecPerKm: 310,
    });
    const lowQuality = low.filter(i => ['threshold', 'vo2', 'marathon_pace', 'float'].includes(i.slot)).length;
    expect(lowQuality).toBeLessThanOrEqual(1);
    // A generous hours target with no ramp restores the ability cap.
    const high = planWeekSessions({ ...baseCtx, raceDistance: 'marathon', phase: 'build', weeklyHoursTarget: 10 });
    const highQuality = high.filter(i => ['threshold', 'vo2', 'marathon_pace', 'float'].includes(i.slot)).length;
    expect(highQuality).toBeGreaterThanOrEqual(lowQuality);
  });

  it('does not prescribe VO2 intervals in the base phase', () => {
    const intents = planWeekSessions({
      ...baseCtx, raceDistance: 'marathon', phase: 'base', runnerType: 'Endurance',
      weekIndex: 2, totalWeeks: 40, weeklyHoursTarget: 8,
    });
    expect(intents.find(i => i.slot === 'vo2')).toBeFalsy();
  });

  it('keeps the long run within its two-tier floor (30–40 min) when tight', () => {
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 1.5 });
    const longIntent = intents.find(i => i.slot === 'long');
    if (longIntent) {
      expect(longIntent.totalMinutes).toBeGreaterThanOrEqual(30);
      expect(longIntent.totalMinutes).toBeLessThanOrEqual(40);
    }
  });

  it('does not trim quality (threshold / vo2) work intervals', () => {
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 1.5 });
    const threshold = intents.find(i => i.slot === 'threshold');
    const vo2 = intents.find(i => i.slot === 'vo2');
    if (threshold) expect(threshold.workMinutes).toBeGreaterThan(0);
    if (vo2) expect(vo2.workMinutes).toBeGreaterThan(0);
  });

  it('respects the budget when it is achievable at the floor', () => {
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 5 });
    expect(totalMin(intents)).toBeLessThanOrEqual(300);
    for (const e of intents.filter(i => i.slot === 'easy')) {
      expect(e.totalMinutes).toBeGreaterThanOrEqual(25);
    }
  });

  it('low-volume ramp week: produces fewer, longer easy runs, none a fragment', () => {
    // 14 km/wk baseline, week 1, consistent-runner archetype, intermediate
    // marathoner. This is the reported case: previously two 15-min easy runs.
    const intents = planWeekSessions({
      ...baseCtx,
      raceDistance: 'marathon',
      phase: 'base',
      weekIndex: 1,
      totalWeeks: 40,
      baselineKm: 14,
      archetype: 'consistent-runner',
      easyPaceSecPerKm: 310,
    });
    const easy = intents.filter(i => i.slot === 'easy');
    for (const e of easy) expect(e.totalMinutes).toBeGreaterThanOrEqual(25);
    // No 15-min fragments survive.
    expect(easy.every(e => e.totalMinutes >= 25)).toBe(true);
  });
});
