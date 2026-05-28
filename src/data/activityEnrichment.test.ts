/**
 * Tests for shared activity-enrichment helpers.
 *
 * Focus: computeSplitsFromSpeed. The speed-stream split fallback for sources
 * that write a speed series to HealthKit but no GPS route (Garmin Connect via
 * the Apple Health bridge).
 */

import { describe, it, expect } from 'vitest';
import { computeSplitsFromSpeed, type SpeedSample } from './activityEnrichment';

/** Build constant-speed samples: `value` m/s, one sample every `stepSec`, for `durationSec`. */
function constantSpeed(value: number, durationSec: number, stepSec = 10): SpeedSample[] {
  const base = new Date('2026-05-26T07:00:00.000Z').getTime();
  const out: SpeedSample[] = [];
  for (let t = 0; t <= durationSec; t += stepSec) {
    out.push({ value, startDate: new Date(base + t * 1000).toISOString() });
  }
  return out;
}

describe('computeSplitsFromSpeed', () => {
  it('returns [] for fewer than 2 samples', () => {
    expect(computeSplitsFromSpeed([])).toEqual([]);
    expect(computeSplitsFromSpeed([{ value: 5, startDate: '2026-05-26T07:00:00Z' }])).toEqual([]);
  });

  it('returns [] when total distance is under 1 km', () => {
    // 4 m/s for 100s = 400m → no full km.
    expect(computeSplitsFromSpeed(constantSpeed(4, 100))).toEqual([]);
  });

  it('produces even ~200s splits for a steady 5 m/s (3:20/km) run', () => {
    // 5 m/s for 600s = 3000m → 3 splits, each 1000m / 5 m/s = 200s.
    const splits = computeSplitsFromSpeed(constantSpeed(5, 600));
    expect(splits).toHaveLength(3);
    for (const s of splits) expect(Math.abs(s - 200)).toBeLessThanOrEqual(1);
  });

  it('a faster segment yields a shorter split than a slower one', () => {
    const base = new Date('2026-05-26T07:00:00.000Z').getTime();
    const samples: SpeedSample[] = [];
    // First 1 km fast (5 m/s → 200s over 0-1000m), then slow (2.5 m/s) for the rest.
    for (let t = 0; t <= 200; t += 10) samples.push({ value: 5, startDate: new Date(base + t * 1000).toISOString() });
    for (let t = 210; t <= 1000; t += 10) samples.push({ value: 2.5, startDate: new Date(base + t * 1000).toISOString() });
    const splits = computeSplitsFromSpeed(samples);
    expect(splits.length).toBeGreaterThanOrEqual(2);
    expect(splits[0]).toBeLessThan(splits[1]); // km 1 (fast) quicker than km 2 (slow)
  });

  it('scales integrated distance to a known total so km markers land correctly', () => {
    // 5 m/s for 580s = 2900m → 2 full km on its own.
    expect(computeSplitsFromSpeed(constantSpeed(5, 580))).toHaveLength(2);
    // With a known total of 3000m, the integrated distance is scaled up → 3 km.
    expect(computeSplitsFromSpeed(constantSpeed(5, 580), 3000)).toHaveLength(3);
  });

  it('does not invent phantom distance across a pause gap over 5 minutes', () => {
    const base = new Date('2026-05-26T07:00:00.000Z').getTime();
    // 1000m at 5 m/s (0-200s), then a 10-min gap, then another 1000m.
    const samples: SpeedSample[] = [];
    for (let t = 0; t <= 200; t += 10) samples.push({ value: 5, startDate: new Date(base + t * 1000).toISOString() });
    for (let t = 800; t <= 1000; t += 10) samples.push({ value: 5, startDate: new Date(base + t * 1000).toISOString() });
    const splits = computeSplitsFromSpeed(samples);
    // Without the >300s guard, trapezoidal integration across the 600s gap would
    // invent ~3 km of phantom distance. The guard keeps it to the 2 real km.
    expect(splits).toHaveLength(2);
    expect(Math.abs(splits[0] - 200)).toBeLessThanOrEqual(1); // clean first km
    // The second km spans the pause, so it legitimately reads long (elapsed
    // time, matching the GPS extractKmSplits behaviour). Not asserted here.
  });
});
