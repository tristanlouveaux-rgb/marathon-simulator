import { describe, it, expect } from 'vitest';
import { planWeekSessions, type PlanContext } from './plan_engine';

/**
 * Tests for the two-tier hours-budget enforcement in `applyHoursBudget`.
 *
 * The budget logic now uses standard floors (easy ≥ 20m, long ≥ 40m) first,
 * and falls back to soft floors (easy ≥ 15m, long ≥ 30m) when the standard
 * floors cannot fit the user's stated weekly hours. Past the soft floors we
 * accept overflow rather than compress sessions into ineffective doses.
 */
describe('applyHoursBudget — soft-floor fallback', () => {
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
    // 10h = 600 min; a 4-run intermediate half plan is well under that.
    expect(totalMin(intents)).toBeLessThanOrEqual(600);
    const easy = intents.find(i => i.slot === 'easy');
    if (easy) expect(easy.totalMinutes).toBeGreaterThanOrEqual(20);
  });

  it('uses the standard easy floor (20m) when budget is moderately tight', () => {
    // Tight enough to scale easy down, but not below the 20m standard floor.
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 4 });
    const easyIntents = intents.filter(i => i.slot === 'easy');
    for (const e of easyIntents) {
      expect(e.totalMinutes).toBeGreaterThanOrEqual(20);
    }
  });

  it('drops to the soft easy floor (15m) when standard floor would still overflow', () => {
    // 1.5 hr = 90 min budget for a half-marathon plan with 4 runs and a long
    // run > 60 min — guaranteed to overflow standard floors.
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 1.5 });
    const easyIntents = intents.filter(i => i.slot === 'easy');
    if (easyIntents.length > 0) {
      // At least one easy run should have dropped to the soft floor.
      const minEasy = Math.min(...easyIntents.map(e => e.totalMinutes));
      expect(minEasy).toBeLessThanOrEqual(15);
      expect(minEasy).toBeGreaterThanOrEqual(15);
    }
  });

  it('drops to the soft long floor (30m) when budget is very tight', () => {
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 1.5 });
    const longIntent = intents.find(i => i.slot === 'long');
    if (longIntent) {
      expect(longIntent.totalMinutes).toBeGreaterThanOrEqual(30);
      expect(longIntent.totalMinutes).toBeLessThanOrEqual(40);
    }
  });

  it('never scales easy below 15m or long below 30m even at impossibly low budgets', () => {
    // 30 min budget — physically impossible for a 4-run half-marathon plan.
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 0.5 });
    for (const i of intents) {
      if (i.slot === 'easy') expect(i.totalMinutes).toBeGreaterThanOrEqual(15);
      if (i.slot === 'long') expect(i.totalMinutes).toBeGreaterThanOrEqual(30);
    }
    // Total should still overflow at this point — that's fine, the UI banner
    // surfaces it. We just don't compress further.
    expect(totalMin(intents)).toBeGreaterThan(30);
  });

  it('does not trim quality (threshold / vo2) work intervals', () => {
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 1.5 });
    const threshold = intents.find(i => i.slot === 'threshold');
    const vo2 = intents.find(i => i.slot === 'vo2');
    if (threshold) expect(threshold.workMinutes).toBeGreaterThan(0);
    if (vo2) expect(vo2.workMinutes).toBeGreaterThan(0);
  });

  it('respects the budget when it is achievable at the standard floor', () => {
    // 5 hr = 300 min budget — achievable with mild trimming.
    const intents = planWeekSessions({ ...baseCtx, weeklyHoursTarget: 5 });
    expect(totalMin(intents)).toBeLessThanOrEqual(300);
    // Standard floor preserved.
    const easyIntents = intents.filter(i => i.slot === 'easy');
    for (const e of easyIntents) {
      expect(e.totalMinutes).toBeGreaterThanOrEqual(20);
    }
  });
});
