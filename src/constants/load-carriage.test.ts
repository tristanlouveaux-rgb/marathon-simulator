import { describe, it, expect } from 'vitest';
import { loadCarriageImpactCoef, resolveBodyweightKg } from './load-carriage';

describe('loadCarriageImpactCoef', () => {
  it('returns 1.0 when no pack is carried', () => {
    expect(loadCarriageImpactCoef(0, 70)).toBe(1.0);
    expect(loadCarriageImpactCoef(-1, 70)).toBe(1.0);
  });

  it('scales linearly with backpack mass (Knapik load-carriage model)', () => {
    // 7 kg pack on a 70 kg runner = +10% impact load
    expect(loadCarriageImpactCoef(7, 70)).toBeCloseTo(1.10, 5);
    // 5 kg pack on a 50 kg runner = +10% impact load (same ratio)
    expect(loadCarriageImpactCoef(5, 50)).toBeCloseTo(1.10, 5);
    // 14 kg pack on a 70 kg runner = +20% impact load
    expect(loadCarriageImpactCoef(14, 70)).toBeCloseTo(1.20, 5);
  });

  it('clamps to a 50% bodyweight ceiling for sanity', () => {
    // Real run-to-work commuters don't carry 40 kg packs, but the clamp
    // protects against unit-confused inputs.
    expect(loadCarriageImpactCoef(40, 70)).toBe(1.5);
    expect(loadCarriageImpactCoef(100, 70)).toBe(1.5);
  });

  it('returns 1.0 for invalid inputs (missing bodyweight)', () => {
    expect(loadCarriageImpactCoef(7, 0)).toBe(1.0);
    expect(loadCarriageImpactCoef(7, -10)).toBe(1.0);
    expect(loadCarriageImpactCoef(7, NaN)).toBe(1.0);
  });
});

describe('resolveBodyweightKg', () => {
  it('returns the user value when set', () => {
    expect(resolveBodyweightKg(68, 'male')).toBe(68);
    expect(resolveBodyweightKg(55, 'female')).toBe(55);
  });

  it('falls back to male default (75kg) when unset and male', () => {
    expect(resolveBodyweightKg(null, 'male')).toBe(75);
    expect(resolveBodyweightKg(undefined, 'male')).toBe(75);
  });

  it('falls back to female default (62kg) when unset and female', () => {
    expect(resolveBodyweightKg(null, 'female')).toBe(62);
  });

  it('falls back to male default (75kg) when sex unknown', () => {
    expect(resolveBodyweightKg(null, null)).toBe(75);
    expect(resolveBodyweightKg(null, 'prefer_not_to_say')).toBe(75);
  });

  it('rejects zero and negative weights, using default', () => {
    expect(resolveBodyweightKg(0, 'male')).toBe(75);
    expect(resolveBodyweightKg(-1, 'female')).toBe(62);
  });
});
