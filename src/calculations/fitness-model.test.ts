import { describe, it, expect } from 'vitest';
import { computeSameSignalTSB, CTL_DECAY, ATL_DECAY, computePlannedWeekTSS, computePlannedSignalB, computeStrengthRpeTSS, typedVolumeWeeklyTSS } from './fitness-model';
import { TL_PER_MIN } from '@/constants';
import type { Week } from '@/types';

// Minimal Week factory. Only fields needed for computeWeekRawTSS
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
    // args: hist, ctl, phase, tier, runsPerWeek, weekInPhase (1-indexed), totalPhaseWeeks
    const early = computePlannedWeekTSS(hist, 195, 'taper', 'trained', undefined, 1, 3);
    const late = computePlannedWeekTSS(hist, 195, 'taper', 'trained', undefined, 3, 3);
    expect(early).toBeGreaterThan(late);
  });

  it('taper position is 1-indexed: the last taper week reaches the 0.55 endpoint', () => {
    const hist = [200, 200, 200, 200, 200]; // median 200
    const at = (week: number, of: number) => computePlannedWeekTSS(hist, 195, 'taper', 'trained', undefined, week, of);
    expect([1, 2, 3].map(w => at(w, 3))).toEqual([150, 130, 110]); // 0.75 / 0.65 / 0.55
    expect([1, 2].map(w => at(w, 2))).toEqual([140, 110]);         // 0.70 / 0.55
    expect(at(1, 1)).toBe(110);                                     // 1-week taper = race week: 0.55
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

  it('typed weekly km TSS sits between the EMA and rw × 50 in the baseline chain', () => {
    // No history, no EMA: the typed km's TSS (230) replaces 4 × 50.
    expect(computePlannedWeekTSS(undefined, undefined, 'base', undefined, 4, undefined, undefined, 230)).toBe(223); // 230 × 0.97
    // Synced history and the EMA still win over the typed km.
    expect(computePlannedWeekTSS([100, 100, 100], undefined, 'base', undefined, 4, undefined, undefined, 230)).toBe(97);
    expect(computePlannedWeekTSS([100], 120, 'base', undefined, 4, undefined, undefined, 230)).toBe(116);
    // Signal B carries it through unchanged (typed km is running only).
    expect(computePlannedSignalB(undefined, undefined, 'base', undefined, 4, undefined, undefined, undefined, 230)).toBe(223);
  });

  it('higher tier athletes get bigger build ramps', () => {
    const hist = [200, 200, 200, 200, 200];
    const beginner = computePlannedWeekTSS(hist, 195, 'build', 'beginner');
    const highVol = computePlannedWeekTSS(hist, 195, 'build', 'high_volume');
    expect(highVol).toBeGreaterThan(beginner);
  });

});

describe('computeStrengthRpeTSS', () => {
  // TL_PER_MIN[7] = 1.78 (verified in sports.ts).
  // runSpec for strength = 0.35 (Signal A).
  // 60 min × 1.78 × 0.35 = 37.38

  it('returns null when not a strength activity', () => {
    expect(computeStrengthRpeTSS(
      { activityType: 'RUNNING', durationSec: 3600, rpe: 7 },
      true,
    )).toBeNull();
  });

  it('returns null when neither rpe nor rpeFallback is set', () => {
    expect(computeStrengthRpeTSS(
      { activityType: 'STRENGTH_TRAINING', durationSec: 3600 },
      true,
    )).toBeNull();
  });

  it('applies the runSpec discount in Signal A (discount=true)', () => {
    const tss = computeStrengthRpeTSS(
      { activityType: 'STRENGTH_TRAINING', durationSec: 3600, rpe: 7 },
      true,
    );
    expect(tss).not.toBeNull();
    expect(tss!).toBeCloseTo(60 * 1.78 * 0.35, 2);
  });

  it('skips the runSpec discount in Signal B (discount=false)', () => {
    const tss = computeStrengthRpeTSS(
      { activityType: 'STRENGTH_TRAINING', durationSec: 3600, rpe: 7 },
      false,
    );
    expect(tss).not.toBeNull();
    expect(tss!).toBeCloseTo(60 * 1.78 * 1.0, 2);
  });

  it('detects strength via Strava WeightTraining activityType', () => {
    const tss = computeStrengthRpeTSS(
      { activityType: 'WeightTraining', durationSec: 3600, rpe: 6 },
      true,
    );
    expect(tss).not.toBeNull();
    // TL_PER_MIN[6] = 1.45 → 60 × 1.45 × 0.35 = 30.45
    expect(tss!).toBeCloseTo(30.45, 2);
  });

  it('falls back to the name when activityType is generic Workout', () => {
    const tss = computeStrengthRpeTSS(
      { activityType: 'Workout', workoutName: 'Strength', durationSec: 3600, rpe: 7 },
      true,
    );
    expect(tss).not.toBeNull();
    expect(tss!).toBeGreaterThan(0);
  });

  it('honours manualSport override', () => {
    const tss = computeStrengthRpeTSS(
      { manualSport: 'strength', activityType: 'CARDIO', durationSec: 3600, rpe: 7 },
      true,
    );
    expect(tss).not.toBeNull();
    expect(tss!).toBeGreaterThan(0);
  });

  it('uses rpeFallback when actual.rpe is missing (legacy wk.rated path)', () => {
    const tss = computeStrengthRpeTSS(
      { activityType: 'STRENGTH_TRAINING', durationSec: 3600 },
      true,
      7,
    );
    expect(tss).not.toBeNull();
    expect(tss!).toBeCloseTo(60 * 1.78 * 0.35, 2);
  });

  it('prefers actual.rpe over rpeFallback when both are set', () => {
    const tss = computeStrengthRpeTSS(
      { activityType: 'STRENGTH_TRAINING', durationSec: 3600, rpe: 8 },
      true,
      4,
    );
    expect(tss).not.toBeNull();
    // Should reflect RPE 8 (2.22), not RPE 4 (0.92)
    expect(tss!).toBeCloseTo(60 * 2.22 * 0.35, 2);
  });

  it('clamps RPE to [1, 10]', () => {
    const high = computeStrengthRpeTSS(
      { activityType: 'STRENGTH_TRAINING', durationSec: 3600, rpe: 15 },
      true,
    );
    const low = computeStrengthRpeTSS(
      { activityType: 'STRENGTH_TRAINING', durationSec: 3600, rpe: 0 },
      true,
    );
    expect(high).toBeCloseTo(60 * 3.00 * 0.35, 2);
    expect(low).toBeCloseTo(60 * 0.30 * 0.35, 2);
  });

  it('returns null for zero-duration activities', () => {
    expect(computeStrengthRpeTSS(
      { activityType: 'STRENGTH_TRAINING', durationSec: 0, rpe: 7 },
      true,
    )).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// typedVolumeWeeklyTSS
// ---------------------------------------------------------------------------

describe('typedVolumeWeeklyTSS', () => {
  it('prices the typed weekly km as easy running at the athlete\'s easy pace', () => {
    // 50 km at 5:00/km = 250 min x 0.92 TSS/min (TL_PER_MIN[4], the easy-run row).
    const tss = typedVolumeWeeklyTSS({ detectedWeeklyKm: 50, weeklyVolumeConfirmed: true, pac: { e: 300 } });
    expect(tss).toBeCloseTo(250 * TL_PER_MIN[4], 6);
    expect(tss).toBeCloseTo(230, 6);
  });

  it('uses the Plan card easy pace (5.5 min/km) when no paces are set', () => {
    expect(typedVolumeWeeklyTSS({ detectedWeeklyKm: 10, weeklyVolumeConfirmed: true })).toBeCloseTo(10 * 5.5 * TL_PER_MIN[4], 6);
  });

  it('is a running-plan baseline only: triathlon (cycling included) and HYROX weeks get none', () => {
    const typed = { detectedWeeklyKm: 20, weeklyVolumeConfirmed: true, pac: { e: 330 } };
    expect(typedVolumeWeeklyTSS({ ...typed, eventType: 'running' })).toBeCloseTo(20 * 5.5 * TL_PER_MIN[4], 6);
    expect(typedVolumeWeeklyTSS({ ...typed, eventType: 'triathlon' })).toBeUndefined();
    expect(typedVolumeWeeklyTSS({ ...typed, eventType: 'hyrox' })).toBeUndefined();
  });

  it('is undefined unless the weekly km was typed or confirmed', () => {
    expect(typedVolumeWeeklyTSS({ detectedWeeklyKm: 50, pac: { e: 300 } })).toBeUndefined();
    expect(typedVolumeWeeklyTSS({ detectedWeeklyKm: 0, weeklyVolumeConfirmed: true, pac: { e: 300 } })).toBeUndefined();
    expect(typedVolumeWeeklyTSS({ weeklyVolumeConfirmed: true, pac: { e: 300 } })).toBeUndefined();
  });
});
