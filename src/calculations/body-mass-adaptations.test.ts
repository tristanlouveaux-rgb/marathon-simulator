import { describe, it, expect } from 'vitest';
import {
  bodySurfaceAreaM2,
  crossTrainingSwapFraction,
  heatStrainRatio,
  isAboveReferenceMass,
} from './body-mass-adaptations';
import { CROSS_TRAINING_SWAP_CAP, HEAT_STRAIN_RATIO_MIN, HEAT_STRAIN_RATIO_MAX } from '@/constants/body-mass-constants';

describe('bodySurfaceAreaM2 (Du Bois)', () => {
  it('matches the textbook reference (70 kg, 170 cm ≈ 1.81 m²)', () => {
    expect(bodySurfaceAreaM2(70, 170)).toBeCloseTo(1.81, 2);
  });
  it('grows with both mass and height', () => {
    expect(bodySurfaceAreaM2(90, 185)).toBeGreaterThan(bodySurfaceAreaM2(70, 170));
  });
});

describe('crossTrainingSwapFraction — safety contract', () => {
  it('is exactly 0 for missing / invalid weight', () => {
    for (const w of [undefined, null, 0, -5, NaN, Infinity, 10 /*lb-ish typo*/, 400]) {
      expect(crossTrainingSwapFraction(w as number, 'male')).toBe(0);
    }
  });
  it('is exactly 0 below the engagement floor (normal range never flagged)', () => {
    expect(crossTrainingSwapFraction(85, 'male')).toBe(0);
    expect(crossTrainingSwapFraction(88, 'male')).toBe(0);   // the 88 kg test-user case
    expect(crossTrainingSwapFraction(94, 'male')).toBe(0);   // just below the 95 kg floor
    expect(crossTrainingSwapFraction(72, 'female')).toBe(0);
    expect(crossTrainingSwapFraction(79, 'female')).toBe(0); // just below the 80 kg floor
  });
});

describe('crossTrainingSwapFraction — engages at floor, gentle curve, cap 0.15', () => {
  it('engages at the floor with an already-meaningful trim (no tiny near-threshold values)', () => {
    expect(crossTrainingSwapFraction(95, 'male')).toBeCloseTo(0.1053, 3);  // floor; trim measured from 85 anchor
    expect(crossTrainingSwapFraction(96, 'male')).toBeCloseTo(0.1146, 3);
  });
  it('caps at 0.15 from 100 kg up', () => {
    expect(crossTrainingSwapFraction(100, 'male')).toBe(CROSS_TRAINING_SWAP_CAP);
    expect(crossTrainingSwapFraction(110, 'male')).toBe(CROSS_TRAINING_SWAP_CAP);
    expect(crossTrainingSwapFraction(150, 'male')).toBe(CROSS_TRAINING_SWAP_CAP);
  });
  it('never exceeds the cap or goes negative', () => {
    for (let w = 30; w <= 250; w += 1) {
      const f = crossTrainingSwapFraction(w, 'male');
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(CROSS_TRAINING_SWAP_CAP);
    }
  });
  it('uses the female floor (80) and reference (72)', () => {
    expect(crossTrainingSwapFraction(80, 'female')).toBeCloseTo(0.10, 3);  // floor
    expect(crossTrainingSwapFraction(79, 'female')).toBe(0);               // below floor
    expect(crossTrainingSwapFraction(90, 'female')).toBe(CROSS_TRAINING_SWAP_CAP);
  });
  it('treats prefer_not_to_say / undefined as male', () => {
    expect(crossTrainingSwapFraction(95, 'prefer_not_to_say')).toBeCloseTo(0.1053, 3);
    expect(crossTrainingSwapFraction(90, undefined)).toBe(0);  // 90 < 95 male floor
  });
});

describe('heatStrainRatio — safety contract', () => {
  it('is exactly 1.0 when weight or height is missing/invalid', () => {
    expect(heatStrainRatio(undefined, 178, 'male')).toBe(1.0);
    expect(heatStrainRatio(90, undefined, 'male')).toBe(1.0);
    expect(heatStrainRatio(undefined, undefined, 'male')).toBe(1.0);
    expect(heatStrainRatio(NaN, 178, 'male')).toBe(1.0);
    expect(heatStrainRatio(90, 50 /*metres typo*/, 'male')).toBe(1.0);
    expect(heatStrainRatio(400, 178, 'male')).toBe(1.0);
  });
  it('is ≈1.0 for the reference build', () => {
    expect(heatStrainRatio(75, 178, 'male')).toBeCloseTo(1.0, 5);
    expect(heatStrainRatio(62, 165, 'female')).toBeCloseTo(1.0, 5);
  });
});

describe('heatStrainRatio — direction and clamps', () => {
  it('is > 1 for a large athlete and < 1 for a small one', () => {
    expect(heatStrainRatio(100, 185, 'male')).toBeGreaterThan(1.0);
    expect(heatStrainRatio(58, 165, 'male')).toBeLessThan(1.0);
  });
  it('stays within the clamp band for extreme inputs', () => {
    expect(heatStrainRatio(150, 165, 'male')).toBe(HEAT_STRAIN_RATIO_MAX);
    expect(heatStrainRatio(40, 200, 'male')).toBe(HEAT_STRAIN_RATIO_MIN);
    for (let w = 30; w <= 250; w += 5) {
      for (let h = 120; h <= 230; h += 10) {
        const r = heatStrainRatio(w, h, 'male');
        expect(r).toBeGreaterThanOrEqual(HEAT_STRAIN_RATIO_MIN);
        expect(r).toBeLessThanOrEqual(HEAT_STRAIN_RATIO_MAX);
      }
    }
  });
});

describe('isAboveReferenceMass', () => {
  it('true only when an entered weight exceeds the sex reference', () => {
    expect(isAboveReferenceMass({ bodyWeightKg: 100, biologicalSex: 'male' })).toBe(true);
    expect(isAboveReferenceMass({ bodyWeightKg: 88, biologicalSex: 'male' })).toBe(false);  // 88 kg is NOT flagged
    expect(isAboveReferenceMass({ bodyWeightKg: 70, biologicalSex: 'male' })).toBe(false);
    expect(isAboveReferenceMass({ bodyWeightKg: undefined, biologicalSex: 'male' })).toBe(false);
  });
});
