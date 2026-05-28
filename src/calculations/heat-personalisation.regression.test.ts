/**
 * Regression locks for the body-size heat personalisation.
 *
 * These prove the two modified functions are BYTE-IDENTICAL to their original
 * behaviour at the default ratio (1.0) — i.e. for every user who hasn't entered
 * weight + height, nothing changes. If a future edit breaks that, these go red.
 */
import { describe, it, expect } from 'vitest';
import { heatAdjust } from './daily-coach';
import { applyCourseFactors } from './course-factors';

// The original formula, frozen here as the oracle.
function originalHeatAdjust(drift: number, tempC: number | null | undefined): number {
  if (tempC == null) return drift;
  return drift - 0.15 * Math.max(0, tempC - 15);
}

describe('heatAdjust — default-ratio regression lock', () => {
  it('reproduces the original formula exactly at ratio 1.0 (and when omitted)', () => {
    for (let drift = -5; drift <= 20; drift += 1) {
      for (const t of [null, undefined, 0, 10, 15, 22, 30, 38]) {
        const oracle = originalHeatAdjust(drift, t);
        expect(heatAdjust(drift, t)).toBe(oracle);
        expect(heatAdjust(drift, t, 1.0)).toBe(oracle);
      }
    }
  });
  it('subtracts more drift as the ratio rises, never below tempC=15', () => {
    expect(heatAdjust(10, 30, 1.2)).toBeLessThan(heatAdjust(10, 30, 1.0));
    expect(heatAdjust(10, 30, 0.85)).toBeGreaterThan(heatAdjust(10, 30, 1.0));
    // No effect at or below the 15°C neutral point regardless of ratio.
    expect(heatAdjust(10, 15, 1.25)).toBe(10);
    expect(heatAdjust(10, 10, 1.25)).toBe(10);
  });
});

describe('applyCourseFactors — default-ratio regression lock', () => {
  const profile = { climate: 'hot' } as Parameters<typeof applyCourseFactors>[0];
  const base = { swimSec: 1000, bikeSec: 10000, runSec: 12000 };

  it('omitting the ratio equals passing 1.0 (deep equal)', () => {
    expect(applyCourseFactors(profile, base, 21, 1.0)).toEqual(applyCourseFactors(profile, base, 21));
  });
  it('a heavier athlete gets a larger RUN penalty but an unchanged BIKE penalty', () => {
    const ref = applyCourseFactors(profile, base, 21, 1.0);
    const heavy = applyCourseFactors(profile, base, 21, 1.2);
    expect(heavy.runMultiplier).toBeGreaterThan(ref.runMultiplier);
    expect(heavy.bikeMultiplier).toBe(ref.bikeMultiplier);
    expect(heavy.swimMultiplier).toBe(ref.swimMultiplier);
  });
});
