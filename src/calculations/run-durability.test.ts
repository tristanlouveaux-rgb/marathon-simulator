/**
 * Run durability — accumulated time-on-feet softening.
 *
 * The durability cap penalises a too-short longest run. Accumulated time-on-feet
 * (repeated long runs, ≥ 70% of threshold) SOFTENS that penalty without ever
 * increasing it. These tests pin the three guaranteed regimes plus the qualifying
 * count traversal.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applyLongRunCap,
  countQualifyingLongRuns,
  getQualifyingLongRunCount,
  getRunDurationsSec,
  LONG_RUN_THRESHOLD_SEC,
  LONG_RUN_MAX_PENALTY,
  LONG_RUN_QUALIFYING_FRACTION,
  LONG_RUN_CONSISTENCY_TARGET,
} from './run-durability';

const HALF = LONG_RUN_THRESHOLD_SEC.half;        // 105 min
const HALF_BAR = HALF * LONG_RUN_QUALIFYING_FRACTION; // 73.5 min qualifying bar
const MAX_HALF = LONG_RUN_MAX_PENALTY.half;      // 0.04

describe('applyLongRunCap — peak shortfall (unchanged baseline)', () => {
  it('peak run ≥ threshold → no penalty regardless of count', () => {
    const r = applyLongRunCap(HALF + 600, 'half', 0);
    expect(r.multiplier).toBe(1);
    expect(r.limitingFactor).toBeNull();
  });

  it('no runs → max penalty, zero consistency credit', () => {
    const r = applyLongRunCap(0, 'half', 0);
    expect(r.multiplier).toBeCloseTo(1 + MAX_HALF, 5);
    expect(r.limitingFactor).toBe('long_run_shortfall');
    expect(r.consistencyCredit).toBe(0);
    expect(r.qualifyingLongRunCount).toBe(0);
  });

  it('short peak with zero count keeps the full linear penalty', () => {
    // Peak at 80% of threshold → 20% shortfall → 20% of max penalty.
    const r = applyLongRunCap(HALF * 0.8, 'half', 0);
    expect(r.multiplier).toBeCloseTo(1 + MAX_HALF * 0.2, 5);
  });
});

describe('applyLongRunCap — accumulated time-on-feet softening', () => {
  it('regular long runs reduce the penalty proportionally to credit', () => {
    // Peak 80% (20% shortfall). 4 of 8 qualifying → credit 0.5 → penalty halved.
    const r = applyLongRunCap(HALF * 0.8, 'half', 4);
    expect(r.consistencyCredit).toBeCloseTo(0.5, 5);
    expect(r.multiplier).toBeCloseTo(1 + MAX_HALF * 0.2 * 0.5, 5);
    expect(r.limitingFactor).toBe('long_run_shortfall');
  });

  it('hitting the consistency target fully zeroes the penalty', () => {
    const r = applyLongRunCap(HALF * 0.8, 'half', LONG_RUN_CONSISTENCY_TARGET);
    expect(r.consistencyCredit).toBe(1);
    expect(r.multiplier).toBe(1);
    expect(r.limitingFactor).toBeNull();
  });

  it('credit is clamped at 1 above the target', () => {
    const r = applyLongRunCap(HALF * 0.8, 'half', LONG_RUN_CONSISTENCY_TARGET + 5);
    expect(r.consistencyCredit).toBe(1);
    expect(r.multiplier).toBe(1);
  });

  it('softening never makes the prediction worse than the un-softened penalty', () => {
    const base = applyLongRunCap(HALF * 0.8, 'half', 0).multiplier;
    const softened = applyLongRunCap(HALF * 0.8, 'half', 3).multiplier;
    expect(softened).toBeLessThanOrEqual(base);
    expect(softened).toBeGreaterThanOrEqual(1);
  });
});

describe('countQualifyingLongRuns — the 70% bar', () => {
  it('counts only runs at or above 70% of the distance threshold', () => {
    const durations = [HALF_BAR - 1, HALF_BAR, HALF_BAR + 600, HALF * 0.5];
    expect(countQualifyingLongRuns(durations, 'half')).toBe(2);
  });

  it('empty list → zero', () => {
    expect(countQualifyingLongRuns([], 'half')).toBe(0);
  });
});

describe('getRunDurationsSec / getQualifyingLongRunCount — traversal', () => {
  afterEach(() => vi.useRealTimers());

  it('reads runs in the window from both wks actuals and onboarding history, filters non-runs and stale', () => {
    const now = new Date('2026-06-17T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const recent = new Date(now.getTime() - 9 * 24 * 3600 * 1000).toISOString();
    const stale = new Date(now.getTime() - 20 * 7 * 24 * 3600 * 1000).toISOString();

    const state = {
      wks: [
        { garminActuals: {
          a: { startTime: recent, activityType: 'RUNNING', durationSec: HALF_BAR + 100 },
          b: { startTime: recent, activityType: 'CYCLING', durationSec: HALF_BAR + 100 }, // not a run
          c: { startTime: stale, activityType: 'RUNNING', durationSec: HALF_BAR + 100 },  // out of window
        } },
      ],
      onboardingRunHistory: [
        { startTime: recent, durSec: HALF_BAR + 200 },
        { startTime: recent, durSec: 600 }, // below the bar
      ],
    };

    const durations = getRunDurationsSec(state, 12);
    // recent run + 2 onboarding entries = 3 in-window durations (cycling + stale excluded)
    expect(durations.length).toBe(3);
    // Two of those clear the 70% half bar.
    expect(getQualifyingLongRunCount(state, 'half', 12)).toBe(2);
  });
});
