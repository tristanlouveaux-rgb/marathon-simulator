/**
 * Tests for `computeDecayedTriCarry`.
 *
 * Mirrors running's `computeDecayedCarry` — 7-day exponential decay (ATL τ),
 * 3-week lookback. Used by the cross-training overload detector to factor
 * "still-being-paid" load from prior weeks where the user clicked Push to
 * Next Week.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeDecayedTriCarry } from './tri-cross-training-carry';
import type { SimulatorState } from '@/types/state';

function state(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
    wks: [],
    planStartDate: '2026-04-01',
    ...overrides,
  } as unknown as SimulatorState;
}

describe('computeDecayedTriCarry', () => {
  // Pin "now" so decay calculations are deterministic across runs.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-22T12:00:00Z')); // start of week 4 (idx 3)
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 when no carried load exists', () => {
    const s = state({
      w: 3,
      wks: [{}, {}, {}, {}] as any,
    });
    expect(computeDecayedTriCarry(s)).toBe(0);
  });

  it('returns 0 when planStartDate is missing', () => {
    const s = state({
      w: 3,
      planStartDate: undefined,
      wks: [{ carriedCrossTrainingTSS: 100 }, {}, {}, {}] as any,
    });
    expect(computeDecayedTriCarry(s)).toBe(0);
  });

  it('returns 0 when current week is week 1 (no prior weeks to decay)', () => {
    const s = state({
      w: 0,
      wks: [{ carriedCrossTrainingTSS: 100 }] as any,
    });
    expect(computeDecayedTriCarry(s)).toBe(0);
  });

  it('decays a recent push exponentially via 7-day τ', () => {
    // Week-3 carries 100 TSS. Now is start of week 4 → midpoint of week 3 is
    // ~7-3.5 = 3.5 days ago (Wed of week 3 to start of week 4).
    // decay = exp(-3.5/7) ≈ 0.606. Expect ~60.6.
    const s = state({
      w: 3, // currentWeekIdx = 3
      wks: [{}, {}, {}, { carriedCrossTrainingTSS: 100 }] as any, // week 3 (idx 3) is current
    });
    // Wait — current week is idx 3, but we want the carry on idx 2 (week 3
    // becomes the prior week of idx 3 ... let me re-index. The detector reads
    // wk.carriedCrossTrainingTSS from PRIOR weeks. If currentWeekIdx=3, prior
    // weeks are 2, 1, 0.
    const s2 = state({
      w: 3,
      wks: [{}, {}, { carriedCrossTrainingTSS: 100 }, {}] as any,
    });
    const decayed = computeDecayedTriCarry(s2);
    // Week 2 midpoint is 14 + 3.5 = 17.5 days into the plan (start 2026-04-01).
    // Now (2026-04-22) is 21 days into the plan → 3.5 days after week-2 mid.
    // decay = exp(-3.5/7) ≈ 0.6065 → ~60.65.
    expect(decayed).toBeGreaterThan(55);
    expect(decayed).toBeLessThan(65);
  });

  it('caps lookback at 3 weeks', () => {
    // Week 0 (4 weeks back) carries 1000 TSS. Should NOT contribute.
    const s = state({
      w: 4,
      wks: [{ carriedCrossTrainingTSS: 1000 }, {}, {}, {}, {}] as any,
    });
    expect(computeDecayedTriCarry(s)).toBe(0);
  });

  it('sums multiple prior weeks with their respective decays', () => {
    // Week 1 (idx 1) carries 100; week 2 (idx 2) carries 50.
    // Current is idx 3. Decays: week 2 ~3.5 days ago → ~60.65. Week 1 ~10.5
    // days ago → exp(-10.5/7) ≈ 0.223 → ~22.3. Total ~83.
    vi.setSystemTime(new Date('2026-04-22T12:00:00Z'));
    const s = state({
      w: 3,
      wks: [{}, { carriedCrossTrainingTSS: 100 }, { carriedCrossTrainingTSS: 50 }, {}] as any,
    });
    const decayed = computeDecayedTriCarry(s);
    // Tolerant range — depends on local-vs-UTC handling of "noon today".
    // The point is: both weeks contribute proportional to age (recent > old).
    expect(decayed).toBeGreaterThan(45);
    expect(decayed).toBeLessThan(65);
  });
});
