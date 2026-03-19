import { describe, it, expect } from 'vitest';
import { computeSameSignalTSB, CTL_DECAY, ATL_DECAY, computePlannedWeekTSS } from './fitness-model';
import type { Week } from '@/types';

// Minimal Week factory — only fields needed for computeWeekRawTSS
function makeWeek(w: number, tss: number): Week {
  return {
    w,
    ph: 'base',
    rated: {},
    garminActuals: {},
    adhocWorkouts: [{
      n: 'Run',
      t: 'easy',
      d: `${Math.round(tss / 0.7)}min easy`,  // easy run: ~0.7 TSS/min
      tss,
    } as any],
  } as unknown as Week;
}

describe('computeSameSignalTSB', () => {

  it('returns null for 0 weeks', () => {
    expect(computeSameSignalTSB([], 0)).toBeNull();
    expect(computeSameSignalTSB([], 5)).toBeNull();
  });

  it('steady state: 10 identical weeks → TSB converges near 0', () => {
    // With Signal B for both CTL and ATL, a consistent load should produce TSB ≈ 0
    // at steady state (CTL ≈ ATL since both use same EMA on same input)
    const wks = Array.from({ length: 10 }, (_, i) => makeWeek(i + 1, 100));
    const result = computeSameSignalTSB(wks, 10, 100);
    expect(result).not.toBeNull();
    // After many weeks with identical load and same seed, TSB should be close to 0
    // (CTL and ATL decay at different rates so they won't be identical, but close)
    expect(Math.abs(result!.tsb)).toBeLessThan(30);
  });

  it('spike week: TSB goes negative after a hard week', () => {
    // 8 easy weeks then one very hard week
    const easyWks = Array.from({ length: 8 }, (_, i) => makeWeek(i + 1, 80));
    const spikeWk = makeWeek(9, 200);
    const wks = [...easyWks, spikeWk];
    const result = computeSameSignalTSB(wks, 9, 80);
    expect(result).not.toBeNull();
    // ATL jumps faster than CTL, so TSB should be negative
    expect(result!.tsb).toBeLessThan(0);
  });

  it('light week: TSB goes positive after a recovery week', () => {
    // 8 hard weeks then one very light week
    const hardWks = Array.from({ length: 8 }, (_, i) => makeWeek(i + 1, 150));
    const restWk = makeWeek(9, 20);
    const wks = [...hardWks, restWk];
    const result = computeSameSignalTSB(wks, 9, 80);
    expect(result).not.toBeNull();
    // ATL drops faster than CTL after rest, so TSB should be positive
    expect(result!.tsb).toBeGreaterThan(0);
  });

  it('exports CTL_DECAY and ATL_DECAY at expected values', () => {
    expect(CTL_DECAY).toBeCloseTo(Math.exp(-7 / 42), 6);
    expect(ATL_DECAY).toBeCloseTo(Math.exp(-7 / 7), 6);
  });

  it('respects ctlSeed — higher seed → different baseline', () => {
    const wks = Array.from({ length: 5 }, (_, i) => makeWeek(i + 1, 100));
    const lowSeed  = computeSameSignalTSB(wks, 5, 0);
    const highSeed = computeSameSignalTSB(wks, 5, 200);
    expect(lowSeed).not.toBeNull();
    expect(highSeed).not.toBeNull();
    // Higher seed means both CTL and ATL start higher; CTL stays higher longer (slower decay)
    expect(highSeed!.ctl).toBeGreaterThan(lowSeed!.ctl);
  });

});

// ---------------------------------------------------------------------------
// computePlannedWeekTSS
// ---------------------------------------------------------------------------

describe('computePlannedWeekTSS', () => {

  it('uses median of history as baseline', () => {
    // Median of [100, 200, 300, 250, 150] = 200 (sorted: 100,150,200,250,300)
    const hist = [100, 200, 300, 250, 150];
    const result = computePlannedWeekTSS(hist, 195, 'build', 'high_volume');
    // build multiplier for high_volume = 1.15, median = 200, so planned ≈ 230
    expect(result).toBe(230);
  });

  it('build phase ramps above baseline', () => {
    const hist = [200, 200, 200, 200, 200]; // median = 200
    const result = computePlannedWeekTSS(hist, 195, 'build', 'high_volume');
    // build multiplier for high_volume = 1.15, so planned ≈ 230
    expect(result).toBe(230);
  });

  it('deload phase reduces below baseline', () => {
    const hist = [200, 200, 200, 200, 200];
    const result = computePlannedWeekTSS(hist, 195, 'deload', 'high_volume');
    // deload multiplier for high_volume = 0.65, so planned ≈ 130
    expect(result).toBe(130);
  });

  it('peak phase is higher than build', () => {
    const hist = [200, 200, 200, 200, 200];
    const build = computePlannedWeekTSS(hist, 195, 'build', 'performance');
    const peak = computePlannedWeekTSS(hist, 195, 'peak', 'performance');
    expect(peak).toBeGreaterThan(build);
  });

  it('taper decreases over time', () => {
    const hist = [200, 200, 200, 200, 200];
    // args: hist, ctl, phase, tier, runsPerWeek, weekInPhase, totalPhaseWeeks
    const early = computePlannedWeekTSS(hist, 195, 'taper', 'trained', undefined, 0, 3);
    const late = computePlannedWeekTSS(hist, 195, 'taper', 'trained', undefined, 2, 3);
    expect(early).toBeGreaterThan(late);
  });

  it('falls back to ctlBaseline when history is thin', () => {
    const result = computePlannedWeekTSS([100], 195, 'base', 'high_volume');
    // Only 1 week of history (< 3), falls back to ctlBaseline 195
    expect(result).toBe(195); // base × 1.00
  });

  it('falls back to rw × 50 when no data at all', () => {
    const result = computePlannedWeekTSS(undefined, undefined, 'base', undefined, 4);
    // 4 × 50 = 200 baseline, recreational base multiplier 0.97 → 194
    expect(result).toBe(194);
  });

  it('higher tier athletes get bigger build ramps', () => {
    const hist = [200, 200, 200, 200, 200];
    const beginner = computePlannedWeekTSS(hist, 195, 'build', 'beginner');
    const highVol = computePlannedWeekTSS(hist, 195, 'build', 'high_volume');
    expect(highVol).toBeGreaterThan(beginner);
  });

});
