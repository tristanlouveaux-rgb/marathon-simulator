import { describe, it, expect } from 'vitest';
import {
  solveSpeed,
  solveCdA,
  paramsFromProfile,
  defaultAeroProfile,
  wattsPerKgTier,
  msToKph,
  CDA_PRESET,
  CRR_PRESET,
  RACE_INTENSITY_BY_DISTANCE,
} from './bike-physics';

describe('bike-physics — solveSpeed', () => {
  // Reference: 75 kg rider on 9 kg bike, TT-bike CdA 0.24, race-clincher Crr 0.004,
  // η 0.97, sea-level air, flat course. Common physics-simulator outputs (e.g.
  // bikecalculator.com, gribble.org) put 220 W race watts at ~37–38 kph.
  const ttFlatParams = {
    totalMassKg: 75 + 9 + 2,  // rider + bike + kit
    cda: 0.24,
    crr: 0.004,
    drivetrainEff: 0.97,
    airDensityKgM3: 1.225,
    gradient: 0,
  };

  it('IM race-watts (220 W) on TT bike → ~37–38 kph (matches published simulators)', () => {
    const v = solveSpeed(220, ttFlatParams);
    const kph = msToKph(v);
    expect(kph).toBeGreaterThan(36);
    expect(kph).toBeLessThan(39);
  });

  it('70.3 race-watts (250 W) on TT bike → ~39–41 kph', () => {
    const v = solveSpeed(250, ttFlatParams);
    const kph = msToKph(v);
    expect(kph).toBeGreaterThan(38);
    expect(kph).toBeLessThan(42);
  });

  it('hoods position (CdA 0.36) at 220 W → ~32–34 kph (slower than TT)', () => {
    const v = solveSpeed(220, { ...ttFlatParams, cda: 0.36 });
    const kph = msToKph(v);
    expect(kph).toBeGreaterThan(31);
    expect(kph).toBeLessThan(35);
  });

  it('zero power → zero speed', () => {
    expect(solveSpeed(0, ttFlatParams)).toBe(0);
    expect(solveSpeed(-50, ttFlatParams)).toBe(0);
  });

  it('returns finite, monotonic-in-power output', () => {
    const v100 = solveSpeed(100, ttFlatParams);
    const v200 = solveSpeed(200, ttFlatParams);
    const v300 = solveSpeed(300, ttFlatParams);
    expect(v100).toBeGreaterThan(0);
    expect(v200).toBeGreaterThan(v100);
    expect(v300).toBeGreaterThan(v200);
    expect(isFinite(v300)).toBe(true);
  });

  it('IM-distance bike split for 315 W FTP rider on TT bike, flat (Tristan case)', () => {
    // 315 W × 0.70 IM intensity = 220.5 W race watts. The idealized solver
    // gives ~4:40–4:50 on perfect flat. Real-world IM bike splits at this
    // fitness are 4:50–5:15 once you add nutrition stops, real wind, and
    // slower turns — those losses live in the ±10% prediction range, not
    // in the idealized physics.
    const v = solveSpeed(220.5, ttFlatParams);
    const splitSec = (180.2 * 1000) / v;
    const splitHrs = splitSec / 3600;
    expect(splitHrs).toBeGreaterThan(4.4);
    expect(splitHrs).toBeLessThan(5.0);
  });
});

describe('bike-physics — solveCdA', () => {
  it('round-trip: solveSpeed → solveCdA recovers input CdA within 5%', () => {
    const params = {
      totalMassKg: 86,
      cda: 0.28,
      crr: 0.004,
      drivetrainEff: 0.97,
      airDensityKgM3: 1.225,
      gradient: 0,
    };
    const v = solveSpeed(220, params);
    const distKm = 40;
    const durSec = (distKm * 1000) / v;

    const result = solveCdA(
      { distanceKm: distKm, durationSec: durSec, avgPowerW: 220 },
      params,
    );

    expect(result.reason).toBeUndefined();
    expect(result.cda).toBeGreaterThan(0.27);
    expect(result.cda).toBeLessThan(0.29);
  });

  it('rejects nonsense input', () => {
    const baseParams = {
      totalMassKg: 86,
      crr: 0.004,
      drivetrainEff: 0.97,
      airDensityKgM3: 1.225,
      gradient: 0,
    };
    const r = solveCdA(
      { distanceKm: 0, durationSec: 3600, avgPowerW: 200 },
      baseParams,
    );
    expect(r.reason).toBe('invalid-input');
  });

  it('flags unphysical CdA (drafting / hilly mistaken as flat)', () => {
    // Speed too high for power → implies CdA < 0.15
    const baseParams = {
      totalMassKg: 80,
      crr: 0.004,
      drivetrainEff: 0.97,
      airDensityKgM3: 1.225,
      gradient: 0,
    };
    // 50 kph at 200 W is unrealistic without drafting → solver should reject
    const r = solveCdA(
      { distanceKm: 50, durationSec: 3600, avgPowerW: 200 },
      baseParams,
    );
    expect(r.reason).toBe('unphysical-cda');
  });
});

describe('bike-physics — wattsPerKgTier', () => {
  it('classifies common cyclist tiers correctly (Coggan)', () => {
    expect(wattsPerKgTier(200, 80).tier).toBe('untrained');     // 2.50 W/kg
    expect(wattsPerKgTier(220, 80).tier).toBe('fair');          // 2.75
    expect(wattsPerKgTier(250, 80).tier).toBe('moderate');      // 3.125
    expect(wattsPerKgTier(280, 80).tier).toBe('good');          // 3.50
    expect(wattsPerKgTier(315, 80).tier).toBe('very-good');     // 3.94
    expect(wattsPerKgTier(355, 80).tier).toBe('excellent');     // 4.44
    expect(wattsPerKgTier(480, 80).tier).toBe('world-class');   // 6.0
  });

  it('handles missing data gracefully', () => {
    expect(wattsPerKgTier(0, 80).tier).toBe('untrained');
    expect(wattsPerKgTier(300, 0).tier).toBe('untrained');
  });
});

describe('bike-physics — preset sanity', () => {
  it('CdA presets are ordered from worst to best aerodynamics', () => {
    expect(CDA_PRESET.hoods).toBeGreaterThan(CDA_PRESET.drops);
    expect(CDA_PRESET.drops).toBeGreaterThan(CDA_PRESET['clip-ons']);
    expect(CDA_PRESET['clip-ons']).toBeGreaterThan(CDA_PRESET['tt-bike']);
  });

  it('Crr presets are ordered fastest to slowest', () => {
    expect(CRR_PRESET['race-tubeless']).toBeLessThan(CRR_PRESET['race-clincher']);
    expect(CRR_PRESET['race-clincher']).toBeLessThan(CRR_PRESET.training);
    expect(CRR_PRESET.training).toBeLessThan(CRR_PRESET.gravel);
  });

  it('IM intensity factor is below 70.3 (standard guidance)', () => {
    expect(RACE_INTENSITY_BY_DISTANCE.ironman).toBeLessThan(RACE_INTENSITY_BY_DISTANCE['70.3']);
  });

  it('paramsFromProfile applies wind-loss factor by course', () => {
    const profile = defaultAeroProfile('p1', 'TT bike', 'tt-bike');
    const flat = paramsFromProfile(profile, 75, 9, 'flat');
    const hilly = paramsFromProfile(profile, 75, 9, 'hilly');
    expect(hilly.cda).toBeGreaterThan(flat.cda);          // wind-loss bumps effective CdA
    expect(hilly.gradient).toBeGreaterThan(flat.gradient); // hilly course has gradient
  });
});
