import { describe, expect, it } from 'vitest';
import { computeDoublesCap, HYROX_MTL_CAP } from './hyrox-constants';

describe('computeDoublesCap', () => {
  it('halves only the station portion of the cap, not the run portion', () => {
    // Singles cap split: 30% run, 70% station.
    // doubles_cap = 0.30 × singles + 0.70 × singles × 0.50 = 0.65 × singles.
    const singles = 1000;
    const expected = Math.round(0.30 * singles + 0.70 * singles * 0.50);
    expect(computeDoublesCap(singles)).toBe(expected);
  });

  it('beginner doubles cap lands ≈ 455 (vs old halving-everything 350)', () => {
    const beginner = HYROX_MTL_CAP.beginner;  // 700
    const cap = computeDoublesCap(beginner);
    expect(cap).toBeGreaterThan(440);
    expect(cap).toBeLessThan(470);
    // Critically, well above the old naive 350.
    expect(cap).toBeGreaterThan(beginner * 0.5);
  });

  it('competitive doubles cap is meaningfully higher than beginner singles cap', () => {
    expect(computeDoublesCap(HYROX_MTL_CAP.competitive)).toBeGreaterThan(HYROX_MTL_CAP.beginner);
  });

  it('doubles cap is always strictly less than the corresponding singles cap', () => {
    for (const band of ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'] as const) {
      const singles = HYROX_MTL_CAP[band];
      expect(computeDoublesCap(singles)).toBeLessThan(singles);
    }
  });
});
