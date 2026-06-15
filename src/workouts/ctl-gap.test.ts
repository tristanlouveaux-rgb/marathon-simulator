import { describe, it, expect } from 'vitest';
import { planWeekSessions, ctlGapMultiplier, type PlanContext } from './plan_engine';
import { ctlAdherenceRatio, CTL_DECAY } from '@/calculations/fitness-model';

/**
 * CTL-gap re-anchor (2026-06-09). When the athlete falls behind the plan's chronic load, next
 * week's prescribed volume scales DOWN in proportion to the load actually carried. The signal is a
 * one-step expected-vs-actual CTL ratio; the multiplier is reduce-only; the combined effort + CTL
 * effect is clamped to the effort band. See SCIENCE_LOG §"CTL-gap re-anchor".
 */

describe('ctlAdherenceRatio — one-step expected vs actual CTL', () => {
  it('is 1.0 on full adherence (actual == planned)', () => {
    expect(ctlAdherenceRatio(300, 300, 300)).toBeCloseTo(1, 10);
    expect(ctlAdherenceRatio(120, 300, 300)).toBeCloseTo(1, 10);
  });

  it('is neutral (1.0) when there is no prescribed load to fall behind on', () => {
    expect(ctlAdherenceRatio(300, 0, 0)).toBe(1);
    expect(ctlAdherenceRatio(300, -5, 0)).toBe(1);
    expect(ctlAdherenceRatio(300, NaN, 0)).toBe(1);
  });

  it('a single fully-missed week, steady state, lands at ~CTL_DECAY (the seed weight)', () => {
    // prior == planned == 300, actual == 0 → expected stays 300, actual decays one step.
    const r = ctlAdherenceRatio(300, 300, 0);
    expect(r).toBeCloseTo(CTL_DECAY, 4); // ≈ 0.847 — one missed week barely moves it
  });

  it('compounds: a second consecutive zero week (lower seed) reduces further but self-limits', () => {
    // Week 1: seed 300 → actual CTL 254.1. Week 2 seeds from that lower CTL.
    const seedAfterWeek1 = 300 * CTL_DECAY + 0 * (1 - CTL_DECAY); // 254.1
    const r2 = ctlAdherenceRatio(seedAfterWeek1, 300, 0);
    expect(r2).toBeLessThan(CTL_DECAY);        // deeper than week 1
    expect(r2).toBeGreaterThan(0.78);          // but self-limited, not a collapse
  });

  it('exceeds 1.0 when the athlete did MORE than planned (reduce-only lever ignores this)', () => {
    expect(ctlAdherenceRatio(300, 200, 400)).toBeGreaterThan(1);
  });

  it('build phase (planned > current CTL) penalises a miss harder than maintenance', () => {
    const maintenanceMiss = ctlAdherenceRatio(300, 300, 0); // planned == seed
    const buildMiss = ctlAdherenceRatio(300, 450, 0);       // planned ramps above seed
    expect(buildMiss).toBeLessThan(maintenanceMiss);
  });
});

describe('ctlGapMultiplier — reduce-only', () => {
  it('passes the ratio through when behind', () => {
    expect(ctlGapMultiplier(0.85)).toBeCloseTo(0.85, 10);
  });
  it('is a no-op when on or above plan', () => {
    expect(ctlGapMultiplier(1)).toBe(1);
    expect(ctlGapMultiplier(1.2)).toBe(1);
  });
  it('is neutral for degenerate input', () => {
    expect(ctlGapMultiplier(NaN)).toBe(1);
    expect(ctlGapMultiplier(-0.5)).toBe(0); // clamped to 0, never negative
  });
});

describe('planWeekSessions — CTL-gap application', () => {
  const baseCtx: PlanContext = {
    runsPerWeek: 5,
    raceDistance: 'marathon',
    runnerType: 'Balanced',
    phase: 'build',
    fitnessLevel: 'intermediate',
    weekIndex: 6,
    totalWeeks: 16,
    vdot: 45,
  };
  const totalMin = (intents: ReturnType<typeof planWeekSessions>) =>
    intents.reduce((s, i) => s + i.totalMinutes, 0);

  it('is byte-identical to the effort-only path when ctlRatio is absent', () => {
    const withUndefined = planWeekSessions({ ...baseCtx, ctlRatio: undefined });
    const without = planWeekSessions({ ...baseCtx });
    expect(totalMin(withUndefined)).toBe(totalMin(without));
  });

  it('reduces total prescribed volume when behind plan', () => {
    const onPlan = planWeekSessions({ ...baseCtx });
    const behind = planWeekSessions({ ...baseCtx, ctlRatio: 0.8 });
    expect(totalMin(behind)).toBeLessThan(totalMin(onPlan));
  });

  it('a deeper gap reduces more', () => {
    const mild = planWeekSessions({ ...baseCtx, ctlRatio: 0.92 });
    const deep = planWeekSessions({ ...baseCtx, ctlRatio: 0.82 });
    expect(totalMin(deep)).toBeLessThanOrEqual(totalMin(mild));
  });

  it('does not apply on a deload week (already a planned reduction)', () => {
    const deloadOnly = planWeekSessions({ ...baseCtx, forceDeload: true });
    const deloadPlusGap = planWeekSessions({ ...baseCtx, forceDeload: true, ctlRatio: 0.8 });
    expect(totalMin(deloadPlusGap)).toBe(totalMin(deloadOnly));
  });

  it('deload × effort IS allowed to compound (intentional autoregulation, not the clamped case)', () => {
    // A deload week where recent effort was rated hard (effortScore 3 → eMult 0.85) should produce
    // a DEEPER recovery week than a deload alone: deloadMult × eMult, not floored. This is the
    // opposite of the effort+CTL clamp — documented decision (Helms 2018 RPE autoregulation), so a
    // future refactor that "fixes" it into a clamp trips this test.
    const deloadOnly = planWeekSessions({ ...baseCtx, forceDeload: true });
    const deloadHardEffort = planWeekSessions({ ...baseCtx, forceDeload: true, effortScore: 3 });
    expect(totalMin(deloadHardEffort)).toBeLessThan(totalMin(deloadOnly));
  });

  it('combined effort + CTL-gap cannot stack below the ability deload floor', () => {
    // effortScore 3 → eMult 0.85; ctlRatio 0.85 → product 0.7225, but the combined adaptive
    // multiplier is floored at deloadMultiplier('intermediate') = 0.85. So adding the gap on top of
    // a maxed-out effort reduction must not shrink the week any further.
    const effortFloored = planWeekSessions({ ...baseCtx, effortScore: 3 });
    const effortPlusGap = planWeekSessions({ ...baseCtx, effortScore: 3, ctlRatio: 0.85 });
    expect(totalMin(effortPlusGap)).toBe(totalMin(effortFloored));
  });
});
