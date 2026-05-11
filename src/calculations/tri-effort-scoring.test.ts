import { describe, it, expect } from 'vitest';
import { scoreBikeEffort } from './tri-effort-scoring';
import type { GarminActual, Workout } from '@/types/state';

// Minimal GarminActual for bike scoring tests.
function actual(normalizedPowerW: number | null, avgHR?: number): GarminActual {
  return {
    garminId: 'test',
    durationSec: 3600,
    distanceKm: 40,
    normalizedPowerW,
    avgHR: avgHR ?? null,
  } as unknown as GarminActual;
}

function workout(t: string): Workout {
  return { n: 'Test', d: '', r: 6, t, id: 'w1' } as Workout;
}

// FTP used throughout: 200W
const FTP = 200;

describe('scoreBikeEffort — power adherence', () => {
  it('on target → powerAdherence 1.0, intensityFactor = target IF', () => {
    // threshold target IF = 0.95; NP = 200 × 0.95 = 190W
    const r = scoreBikeEffort(actual(190), workout('bike_threshold'), FTP);
    expect(r.powerAdherence).toBeCloseTo(1.0, 5);
    expect(r.intensityFactor).toBeCloseTo(0.95, 5);
  });

  it('within band — signal is attenuated (|adherence - 1| < |raw - 1|)', () => {
    // threshold band = ±5%; NP = 183W → rawAdherence ≈ 0.963 (-3.7% miss, inside band)
    const r = scoreBikeEffort(actual(183), workout('bike_threshold'), FTP);
    const rawAdherence = (183 / FTP) / 0.95;
    const rawDeviation = Math.abs(rawAdherence - 1);
    const actualDeviation = Math.abs(r.powerAdherence! - 1);
    expect(actualDeviation).toBeLessThan(rawDeviation);
  });

  it('at band edge — powerAdherence equals rawAdherence (continuous, no jump)', () => {
    // threshold band = ±5%; rawAdherence exactly 0.95 → absDeviation = bandHalf
    // NP = FTP × targetIF × rawAdherence = 200 × 0.95 × 0.95 = 180.5W
    const np = FTP * 0.95 * 0.95;
    const r = scoreBikeEffort(actual(np), workout('bike_threshold'), FTP);
    const rawAdherence = np / (FTP * 0.95);
    expect(r.powerAdherence).toBeCloseTo(rawAdherence, 5);
  });

  it('outside band — full raw deviation passes through unchanged', () => {
    // threshold band = ±5%; NP = 176W → rawAdherence ≈ 0.926 (-7.4% miss, outside)
    const np = 176;
    const r = scoreBikeEffort(actual(np), workout('bike_threshold'), FTP);
    const rawAdherence = (np / FTP) / 0.95;
    expect(r.powerAdherence).toBeCloseTo(rawAdherence, 5);
  });

  it('just-inside and just-outside band edge are continuous', () => {
    // No signal jump: 1W either side of the band edge should differ by ~1W worth of signal.
    const npEdge = FTP * 0.95 * 0.95;       // exactly at edge
    const npInside  = npEdge + 0.5;
    const npOutside = npEdge - 0.5;
    const rEdge    = scoreBikeEffort(actual(npEdge),    workout('bike_threshold'), FTP);
    const rInside  = scoreBikeEffort(actual(npInside),  workout('bike_threshold'), FTP);
    const rOutside = scoreBikeEffort(actual(npOutside), workout('bike_threshold'), FTP);
    // All three should be very close — no 2–3× jump.
    expect(Math.abs(rInside.powerAdherence!  - rEdge.powerAdherence!)).toBeLessThan(0.005);
    expect(Math.abs(rOutside.powerAdherence! - rEdge.powerAdherence!)).toBeLessThan(0.005);
  });

  it('larger band (endurance ±10%) attenuates more than tighter band (threshold ±5%) for same miss', () => {
    // Both 4% below their respective targets — endurance is inside its band (attenuated more),
    // threshold is also inside its band but the band is tighter so less attenuation.
    const npEndurance  = FTP * 0.65 * 0.96;  // 4% below endurance target IF 0.65
    const npThreshold  = FTP * 0.95 * 0.96;  // 4% below threshold target IF 0.95
    const rEnd = scoreBikeEffort(actual(npEndurance),  workout('bike_endurance'),  FTP);
    const rThr = scoreBikeEffort(actual(npThreshold),  workout('bike_threshold'),  FTP);
    // Both raw adherences are 0.96. Endurance band is wider → more attenuation → adherence closer to 1.
    expect(rEnd.powerAdherence!).toBeGreaterThan(rThr.powerAdherence!);
  });

  it('above target — positive deviation is also attenuated within band', () => {
    // threshold, 3% above target (IF = 0.978) — within ±5% band
    const np = FTP * 0.95 * 1.03;
    const r = scoreBikeEffort(actual(np), workout('bike_threshold'), FTP);
    const rawAdherence = np / (FTP * 0.95);
    expect(r.powerAdherence!).toBeLessThan(rawAdherence);   // attenuated toward 1.0
    expect(r.powerAdherence!).toBeGreaterThan(1.0);          // still above 1.0
  });
});

describe('scoreBikeEffort — null paths', () => {
  it('no power meter (normalizedPowerW null) → powerAdherence null, intensityFactor null', () => {
    const r = scoreBikeEffort(actual(null), workout('bike_threshold'), FTP);
    expect(r.powerAdherence).toBeNull();
    expect(r.intensityFactor).toBeNull();
  });

  it('no FTP → powerAdherence null', () => {
    const r = scoreBikeEffort(actual(190), workout('bike_threshold'), undefined);
    expect(r.powerAdherence).toBeNull();
  });

  it('no workout → powerAdherence null (no targetIF to compute against)', () => {
    const r = scoreBikeEffort(actual(190), undefined, FTP);
    expect(r.powerAdherence).toBeNull();
    // intensityFactor still computed (NP/FTP)
    expect(r.intensityFactor).toBeCloseTo(0.95, 3);
  });

  it('unknown workout type → powerAdherence null', () => {
    const r = scoreBikeEffort(actual(190), workout('bike_unknown_future_type'), FTP);
    expect(r.powerAdherence).toBeNull();
  });
});

describe('scoreBikeEffort — HR fallback', () => {
  const hrProfile = { ltHR: 162, restingHR: 50, maxHR: 190 };

  it('power present + HR present → hrEffortScore computed as cross-check', () => {
    const r = scoreBikeEffort(actual(190, 155), workout('bike_threshold'), FTP, hrProfile);
    expect(r.hrEffortScore).not.toBeNull();
    expect(r.powerAdherence).not.toBeNull();
  });

  it('no power meter + HR present → hrEffortScore computed as primary', () => {
    const r = scoreBikeEffort(actual(null, 155), workout('bike_threshold'), FTP, hrProfile);
    expect(r.hrEffortScore).not.toBeNull();
    expect(r.powerAdherence).toBeNull();
  });

  it('no power meter + no HR → all null', () => {
    const r = scoreBikeEffort(actual(null), workout('bike_threshold'), FTP);
    expect(r.powerAdherence).toBeNull();
    expect(r.hrEffortScore).toBeNull();
  });
});
