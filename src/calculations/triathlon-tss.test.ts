import { describe, it, expect } from 'vitest';
import {
  computeSwimTss,
  computeBikeTssFromPower,
  computeBikeTssFromHr,
  estimateSwimIF,
} from './triathlon-tss';

describe('Swim TSS — cubed IF', () => {
  it('60 minutes at CSS pace ≈ 100 TSS', () => {
    const tss = computeSwimTss({
      durationSec: 3600,
      avgPaceSecPer100m: 90,
      cssSecPer100m: 90,
    });
    expect(tss).toBe(100);
  });

  it('30 minutes at CSS ≈ 50 TSS', () => {
    const tss = computeSwimTss({
      durationSec: 1800,
      avgPaceSecPer100m: 100,
      cssSecPer100m: 100,
    });
    expect(tss).toBe(50);
  });

  it('Faster than CSS: cubed scaling', () => {
    // IF = 1.1 → IF^3 = 1.331 → 60 min × 1.331 × 100 = 133.1
    const tss = computeSwimTss({
      durationSec: 3600,
      avgPaceSecPer100m: 90,
      cssSecPer100m: 99,
    });
    expect(tss).toBe(133);
  });

  it('Easier than CSS: cubed scaling goes the other way', () => {
    // IF = 0.8 → 0.512 → 60 × 0.512 × 100 = 51.2
    const tss = computeSwimTss({
      durationSec: 3600,
      avgPaceSecPer100m: 125,
      cssSecPer100m: 100,
    });
    expect(tss).toBe(51);
  });

  it('Zero-duration returns 0', () => {
    expect(computeSwimTss({ durationSec: 0, avgPaceSecPer100m: 90, cssSecPer100m: 90 })).toBe(0);
  });

  it('Invalid CSS returns 0 (guards division)', () => {
    expect(computeSwimTss({ durationSec: 3600, avgPaceSecPer100m: 90, cssSecPer100m: 0 })).toBe(0);
  });
});

describe('Bike TSS — squared IF (power)', () => {
  it('60 minutes at FTP = 100 TSS', () => {
    const tss = computeBikeTssFromPower({
      durationSec: 3600,
      normalisedPowerW: 250,
      ftpW: 250,
    });
    expect(tss).toBe(100);
  });

  it('IF = 0.8 → 64 TSS for an hour', () => {
    const tss = computeBikeTssFromPower({
      durationSec: 3600,
      normalisedPowerW: 200,
      ftpW: 250,
    });
    expect(tss).toBe(64);
  });

  it('IF = 1.05 → ~110 TSS for an hour', () => {
    const tss = computeBikeTssFromPower({
      durationSec: 3600,
      normalisedPowerW: 262,
      ftpW: 250,
    });
    // (262/250)^2 = 1.0985...
    expect(tss).toBeGreaterThan(108);
    expect(tss).toBeLessThan(112);
  });
});

describe('Bike TSS — HR fallback', () => {
  it('Steady at LTHR ≈ 100 TSS/hr', () => {
    const tss = computeBikeTssFromHr({
      durationSec: 3600,
      avgHrBpm: 163,
      restingHrBpm: 55,
      maxHrBpm: 185,
      bikeLthrBpm: 163,
    });
    // Should be around 100 for 1 hr at threshold
    expect(tss).toBeGreaterThan(85);
    expect(tss).toBeLessThan(115);
  });

  it('Easier ride registers lower TSS', () => {
    const steady = computeBikeTssFromHr({
      durationSec: 3600,
      avgHrBpm: 130,
      restingHrBpm: 55,
      maxHrBpm: 185,
      bikeLthrBpm: 163,
    });
    const harder = computeBikeTssFromHr({
      durationSec: 3600,
      avgHrBpm: 163,
      restingHrBpm: 55,
      maxHrBpm: 185,
      bikeLthrBpm: 163,
    });
    expect(steady).toBeLessThan(harder);
  });
});

describe('estimateSwimIF', () => {
  it('returns 1.0 at CSS', () => {
    expect(estimateSwimIF(90, 90)).toBe(1);
  });
  it('returns 0 for missing inputs', () => {
    expect(estimateSwimIF(0, 90)).toBe(0);
    expect(estimateSwimIF(90, 0)).toBe(0);
  });
});
