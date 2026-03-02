import { describe, it, expect } from 'vitest';
import { calculateITrimp, calculateITrimpFromLaps, calculateITrimpFromSummary } from './trimp';

// Reference parameters used across tests
const HR_REST = 55;
const HR_MAX = 190;
const HR_RANGE = HR_MAX - HR_REST; // 135

// Manual iTRIMP for a single 60s sample at avgHR=130:
// HRR = (130-55)/135 = 75/135 ≈ 0.5556
// male β = 1.92
// iTRIMP = 60 * 0.5556 * exp(1.92 * 0.5556) ≈ 60 * 0.5556 * 2.918 ≈ 97.3
const HRR_130 = (130 - HR_REST) / HR_RANGE; // ≈ 0.5556
const EXPECTED_60S_130HR_MALE = 60 * HRR_130 * Math.exp(1.92 * HRR_130);

describe('calculateITrimpFromSummary', () => {
  it('computes correct iTRIMP for male at 130bpm for 60s', () => {
    const result = calculateITrimpFromSummary(130, 60, HR_REST, HR_MAX, 'male');
    expect(result).toBeCloseTo(EXPECTED_60S_130HR_MALE, 2);
  });

  it('uses female β (1.67) giving lower iTRIMP than male β (1.92)', () => {
    const male = calculateITrimpFromSummary(130, 60, HR_REST, HR_MAX, 'male');
    const female = calculateITrimpFromSummary(130, 60, HR_REST, HR_MAX, 'female');
    expect(female).toBeLessThan(male);
  });

  it('defaults to male β (conservative) when sex is undefined', () => {
    const result = calculateITrimpFromSummary(130, 60, HR_REST, HR_MAX);
    expect(result).toBeCloseTo(EXPECTED_60S_130HR_MALE, 2);
  });

  it('returns 0 when avgHR equals restingHR', () => {
    expect(calculateITrimpFromSummary(HR_REST, 300, HR_REST, HR_MAX)).toBe(0);
  });

  it('returns 0 when avgHR is below restingHR', () => {
    expect(calculateITrimpFromSummary(40, 300, HR_REST, HR_MAX)).toBe(0);
  });

  it('returns 0 when duration is 0', () => {
    expect(calculateITrimpFromSummary(130, 0, HR_REST, HR_MAX)).toBe(0);
  });

  it('returns 0 when hrRange is invalid (maxHR <= restingHR)', () => {
    expect(calculateITrimpFromSummary(130, 60, 190, 180)).toBe(0);
  });

  it('scales linearly with duration', () => {
    const a = calculateITrimpFromSummary(150, 600, HR_REST, HR_MAX);
    const b = calculateITrimpFromSummary(150, 1200, HR_REST, HR_MAX);
    expect(b).toBeCloseTo(a * 2, 5);
  });

  it('is higher at higher HR (non-linear due to exponential)', () => {
    const low = calculateITrimpFromSummary(120, 3600, HR_REST, HR_MAX);
    const high = calculateITrimpFromSummary(165, 3600, HR_REST, HR_MAX);
    expect(high).toBeGreaterThan(low);
  });
});

describe('calculateITrimpFromLaps', () => {
  it('sums iTRIMP across multiple laps', () => {
    const laps = [
      { avgHR: 130, durationSec: 60 },
      { avgHR: 130, durationSec: 60 },
    ];
    const result = calculateITrimpFromLaps(laps, HR_REST, HR_MAX, 'male');
    expect(result).toBeCloseTo(EXPECTED_60S_130HR_MALE * 2, 2);
  });

  it('matches calculateITrimpFromSummary for a single lap', () => {
    const fromLaps = calculateITrimpFromLaps([{ avgHR: 145, durationSec: 1800 }], HR_REST, HR_MAX, 'male');
    const fromSummary = calculateITrimpFromSummary(145, 1800, HR_REST, HR_MAX, 'male');
    expect(fromLaps).toBeCloseTo(fromSummary, 5);
  });

  it('skips laps where avgHR is at or below restingHR', () => {
    const laps = [
      { avgHR: HR_REST, durationSec: 300 }, // should be ignored
      { avgHR: 130, durationSec: 60 },
    ];
    const result = calculateITrimpFromLaps(laps, HR_REST, HR_MAX, 'male');
    expect(result).toBeCloseTo(EXPECTED_60S_130HR_MALE, 2);
  });

  it('skips laps with zero duration', () => {
    const laps = [
      { avgHR: 160, durationSec: 0 },
      { avgHR: 130, durationSec: 60 },
    ];
    expect(calculateITrimpFromLaps(laps, HR_REST, HR_MAX, 'male')).toBeCloseTo(EXPECTED_60S_130HR_MALE, 2);
  });

  it('returns 0 for empty laps array', () => {
    expect(calculateITrimpFromLaps([], HR_REST, HR_MAX)).toBe(0);
  });
});

describe('calculateITrimp (HR stream)', () => {
  it('returns 0 for mismatched array lengths', () => {
    expect(calculateITrimp([130, 135], [0], HR_REST, HR_MAX)).toBe(0);
  });

  it('returns 0 for single-sample arrays (< 2 samples)', () => {
    expect(calculateITrimp([130], [0], HR_REST, HR_MAX)).toBe(0);
  });

  it('computes consistent iTRIMP for uniform 1s stream at 130bpm for 60s', () => {
    // 61 samples: t=0..60, hr=130 throughout
    const hr = Array(61).fill(130);
    const t = Array.from({ length: 61 }, (_, i) => i);
    const result = calculateITrimp(hr, t, HR_REST, HR_MAX, 'male');
    // Should be very close to the summary equivalent (60 * HRR * e^(β*HRR))
    expect(result).toBeCloseTo(EXPECTED_60S_130HR_MALE, 1);
  });

  it('skips samples at or below restingHR', () => {
    const hr = [HR_REST, HR_REST, 130]; // first two samples contribute nothing
    const t = [0, 1, 2];
    const fromStream = calculateITrimp(hr, t, HR_REST, HR_MAX, 'male');
    // Only 1 second at 130bpm should be counted
    const expected = calculateITrimpFromSummary(130, 1, HR_REST, HR_MAX, 'male');
    expect(fromStream).toBeCloseTo(expected, 5);
  });

  it('handles variable HR with non-linear accumulation', () => {
    // Alternating easy / hard — hard portion should dominate due to exponential weight
    const easy = 110;
    const hard = 170;
    const hrEasy = Array(60).fill(easy);
    const hrHard = Array(60).fill(hard);
    const hr = [...hrEasy, ...hrHard];
    const t = Array.from({ length: 120 }, (_, i) => i);

    const totalStream = calculateITrimp(hr, t, HR_REST, HR_MAX, 'male');
    const easyPart = calculateITrimpFromSummary(easy, 59, HR_REST, HR_MAX, 'male');
    const hardPart = calculateITrimpFromSummary(hard, 60, HR_REST, HR_MAX, 'male');

    // Stream total should be approximately easyPart + hardPart
    expect(totalStream).toBeCloseTo(easyPart + hardPart, 0);
    // Hard 60s should contribute more than easy 60s due to exponential weight
    expect(hardPart).toBeGreaterThan(easyPart);
  });

  it('male > female for same HR stream (higher β = more steep weighting)', () => {
    const hr = Array(61).fill(155);
    const t = Array.from({ length: 61 }, (_, i) => i);
    const male = calculateITrimp(hr, t, HR_REST, HR_MAX, 'male');
    const female = calculateITrimp(hr, t, HR_REST, HR_MAX, 'female');
    expect(male).toBeGreaterThan(female);
  });
});
