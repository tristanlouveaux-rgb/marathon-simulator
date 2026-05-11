import { describe, it, expect } from 'vitest';
import { computeCyclingVO2 } from './cycling-vo2';

describe('cycling VO2max — ACSM', () => {
  it('returns null when FTP is missing', () => {
    const r = computeCyclingVO2({ ftpW: null });
    expect(r.vo2).toBeNull();
    expect(r.reason).toBe('no-ftp');
  });

  it('computes 10.8 × W/kg + 7', () => {
    // 250W / 70kg = 3.57 W/kg → 10.8 × 3.57 + 7 ≈ 45.6
    const r = computeCyclingVO2({ ftpW: 250, bodyWeightKg: 70 });
    expect(r.vo2).toBeCloseTo(10.8 * (250 / 70) + 7, 1);
    expect(r.weightKgUsed).toBe(70);
    expect(r.usedDefaultWeight).toBe(false);
  });

  it('uses sex default when weight is missing — male', () => {
    const r = computeCyclingVO2({ ftpW: 250, biologicalSex: 'male' });
    expect(r.weightKgUsed).toBe(75);
    expect(r.usedDefaultWeight).toBe(true);
  });

  it('uses sex default when weight is missing — female', () => {
    const r = computeCyclingVO2({ ftpW: 250, biologicalSex: 'female' });
    expect(r.weightKgUsed).toBe(62);
    expect(r.usedDefaultWeight).toBe(true);
  });

  it('inherits FTP confidence', () => {
    const r = computeCyclingVO2({ ftpW: 250, bodyWeightKg: 70, ftpConfidence: 'high' });
    expect(r.confidence).toBe('high');
  });

  it('downgrades confidence when default weight is used', () => {
    const high = computeCyclingVO2({ ftpW: 250, ftpConfidence: 'high' });
    expect(high.confidence).toBe('medium');
    const med = computeCyclingVO2({ ftpW: 250, ftpConfidence: 'medium' });
    expect(med.confidence).toBe('low');
  });

  it('higher W/kg yields higher VO2max', () => {
    const lo = computeCyclingVO2({ ftpW: 200, bodyWeightKg: 70 });
    const hi = computeCyclingVO2({ ftpW: 320, bodyWeightKg: 70 });
    expect(hi.vo2!).toBeGreaterThan(lo.vo2!);
  });
});
