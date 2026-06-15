import { describe, it, expect } from 'vitest';
import { computeSleepScore } from './appleHealthSync';
import type { PhysiologyDayEntry } from '@/types/state';

/**
 * "Works for all watches": Apple Health is an aggregation layer, so a Garmin,
 * Coros, Polar or basic tracker that writes only a generic 'asleep' state to
 * HealthKit (no deep/REM breakdown) must not be scored as if it slept badly.
 * Before the fix, zero deep + zero REM hard-capped any night at 55/100 because
 * the score weights deep 25% + REM 20%, which then dragged Readiness down for
 * every non-Apple-Watch user. The fix scores stage-less nights on duration
 * alone (renormalising the 55% duration weight to 100%).
 */
describe('computeSleepScore across watch sources', () => {
  const night = (over: Partial<PhysiologyDayEntry>): PhysiologyDayEntry => ({
    date: '2026-06-12',
    ...over,
  });

  it('stage-less 8h night (generic "asleep" only) scores on duration, not capped at 55', () => {
    // 8h all bucketed to light (how computeSleepStageDurations maps 'asleep'),
    // zero deep + zero REM = no architecture reported by the source.
    const score = computeSleepScore(night({
      sleepDurationSec: 8 * 3600,
      sleepLightSec: 8 * 3600,
      sleepDeepSec: 0,
      sleepRemSec: 0,
    }));
    // 8h / 7h target = 114% → duration score clamps to 100.
    expect(score).toBe(100);
    expect(score).toBeGreaterThan(55); // the old hard cap
  });

  it('stage-less short night still tracks duration (no architecture penalty floor)', () => {
    // 5h25m ≈ 0.774 of 7h target → ~77 from duration alone.
    const score = computeSleepScore(night({
      sleepDurationSec: 5.42 * 3600,
      sleepLightSec: 5.42 * 3600,
      sleepDeepSec: 0,
      sleepRemSec: 0,
    }));
    expect(score).toBeGreaterThan(70);
    expect(score).toBeLessThan(85);
  });

  it('staged night (Apple Watch / Garmin with stages) keeps the full architecture formula', () => {
    // 8h with healthy ~17.5% deep + ~22.5% REM → all three components near 100.
    const staged = computeSleepScore(night({
      sleepDurationSec: 8 * 3600,
      sleepDeepSec: Math.round(8 * 3600 * 0.175),
      sleepRemSec: Math.round(8 * 3600 * 0.225),
      sleepLightSec: Math.round(8 * 3600 * 0.6),
    }));
    expect(staged).toBeGreaterThanOrEqual(95);

    // A staged night with genuinely poor architecture (lots of light, little
    // deep/REM) is STILL penalised — the duration-only path must not swallow it.
    const poorArchitecture = computeSleepScore(night({
      sleepDurationSec: 8 * 3600,
      sleepDeepSec: Math.round(8 * 3600 * 0.02), // 2% deep, present so "staged"
      sleepRemSec: 0,
      sleepLightSec: Math.round(8 * 3600 * 0.98),
    }));
    expect(poorArchitecture).toBeLessThan(75);
  });

  it('sub-30-min "sleep" is not a real session', () => {
    expect(computeSleepScore(night({ sleepDurationSec: 1200, sleepLightSec: 1200 }))).toBe(0);
  });
});
