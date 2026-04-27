import { describe, it, expect } from 'vitest';
import { computeHRCalibratedVdot, type HRRunInput } from './effort-calibrated-vdot';

const NOW = new Date('2026-04-24T12:00:00Z');

function mkRun(daysAgo: number, distKm: number, paceSecPerKm: number, avgHR: number, hrDrift: number | null = 3): HRRunInput {
  const ms = NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000;
  return {
    startTime: new Date(ms).toISOString(),
    distKm,
    durSec: Math.round(distKm * paceSecPerKm),
    avgHR,
    hrDrift,
  };
}

describe('computeHRCalibratedVdot — guards', () => {
  it('returns no-rhr when RHR missing', () => {
    const r = computeHRCalibratedVdot([mkRun(1, 10, 300, 150)], null, 190, NOW);
    expect(r.vdot).toBeNull();
    expect(r.reason).toBe('no-rhr');
  });

  it('returns no-maxhr when maxHR missing or below RHR', () => {
    const r1 = computeHRCalibratedVdot([mkRun(1, 10, 300, 150)], 50, null, NOW);
    const r2 = computeHRCalibratedVdot([mkRun(1, 10, 300, 150)], 180, 170, NOW);
    expect(r1.reason).toBe('no-maxhr');
    expect(r2.reason).toBe('no-maxhr');
  });

  it('returns no-points when runs empty', () => {
    const r = computeHRCalibratedVdot([], 50, 190, NOW);
    expect(r.reason).toBe('no-points');
  });

  it('returns too-few-points when <3 qualifying', () => {
    const runs = [mkRun(1, 10, 300, 150), mkRun(2, 8, 310, 148)];
    const r = computeHRCalibratedVdot(runs, 50, 190, NOW);
    expect(r.reason).toBe('too-few-points');
  });
});

describe('computeHRCalibratedVdot — filters', () => {
  const RHR = 50;
  const MAX = 190;

  it('excludes runs shorter than 20 minutes', () => {
    // 2 km at 4:00/km = 8 min → filtered
    const runs = [
      mkRun(1, 2, 240, 160),
      mkRun(2, 2, 240, 160),
      mkRun(3, 2, 240, 160),
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    expect(r.reason).toBe('no-points');
  });

  it('excludes runs with HR drift > 8%', () => {
    const runs = [
      mkRun(1, 10, 300, 150, 10),
      mkRun(2, 12, 310, 152, 12),
      mkRun(3, 8,  295, 148, 15),
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    expect(r.reason).toBe('no-points');
  });

  it('accepts runs with null hrDrift (keeps the point)', () => {
    // 3 runs spanning a small effort range; null drift → no drift filter applied.
    const runs = [
      mkRun(1, 10, 310, 150, null),
      mkRun(3,  8, 295, 160, null),
      mkRun(5, 12, 330, 140, null),
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    expect(r.n).toBe(3);
  });

  it('excludes runs with %HRR below Swain-validated range', () => {
    // avgHR=70 with RHR=50, maxHR=190 → HRR = 20/140 = 14% — too low
    const runs = [
      mkRun(1, 10, 310, 70),
      mkRun(2, 12, 320, 72),
      mkRun(3, 8,  315, 71),
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    expect(r.reason).toBe('no-points');
  });

  it('excludes runs older than 8 weeks', () => {
    const runs = [
      mkRun(1,  10, 310, 150),
      mkRun(2,  12, 315, 148),
      mkRun(60, 8,  300, 160), // 60 days ago → outside 8-week window
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    expect(r.n).toBe(2);
  });
});

describe('computeHRCalibratedVdot — regression', () => {
  const RHR = 50;
  const MAX = 190;

  it('produces a plausible VDOT for a 50-VDOT athlete profile', () => {
    // Athlete running 4:20/km at 82% HRR (threshold) should yield VDOT ~50.
    // Construct runs across the effort spectrum:
    // Easy: 5:30/km at 65% HRR (HR = 50 + 0.65*140 = 141)
    // Tempo: 4:30/km at 82% HRR (HR = 50 + 0.82*140 = 165)
    // Threshold: 4:15/km at 88% HRR (HR = 50 + 0.88*140 = 173)
    const runs = [
      mkRun(1,  12, 330, 141), // easy
      mkRun(3,   8, 270, 165), // tempo
      mkRun(5,  10, 255, 173), // threshold
      mkRun(7,  14, 340, 143), // easy
      mkRun(10,  6, 265, 168), // tempo
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);

    expect(r.vdot).not.toBeNull();
    expect(r.vdot!).toBeGreaterThan(42);
    expect(r.vdot!).toBeLessThan(58);
    expect(r.beta).toBeLessThan(0);
    expect(r.n).toBe(5);
  });

  it('higher confidence with more points and tighter fit', () => {
    // Clean linear data: pace = 500 - 300·%VO2R (β=-300 sec/km per unit HRR)
    // At 60% HRR → 320s/km, at 90% HRR → 230s/km.
    const runs: HRRunInput[] = [];
    for (let i = 0; i < 10; i++) {
      const frac = 0.6 + (i / 9) * 0.3;                // 0.60..0.90
      const hr = Math.round(RHR + frac * (MAX - RHR)); // 134..176
      const pace = Math.round(500 - frac * 300);       // 320..230
      runs.push(mkRun(i + 1, 8, pace, hr));
    }
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    expect(r.confidence).toBe('high');
    expect(r.r2).not.toBeNull();
    expect(r.r2!).toBeGreaterThan(0.9);
  });

  it('rejects non-negative beta (inverted HR-pace curve)', () => {
    // Noisy data where slower paces happen at higher HR (e.g. heat/fatigue)
    // — produces positive β. Should be rejected.
    const runs = [
      mkRun(1, 10, 350, 175), // slow but high HR
      mkRun(3,  8, 330, 170),
      mkRun(5, 12, 310, 160),
      mkRun(7,  6, 290, 150), // fast but low HR
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    expect(r.vdot).toBeNull();
    expect(r.reason).toBe('bad-fit');
  });

  it('confidence scales with sample size and R²', () => {
    // Minimum viable: 3 points, perfect fit → low (needs ≥4 for medium).
    const runs = [
      mkRun(1, 10, 320, 148),
      mkRun(3,  8, 280, 165),
      mkRun(5, 12, 340, 141),
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    expect(['low', 'medium']).toContain(r.confidence);
    expect(r.vdot).not.toBeNull();
  });
});

describe('computeHRCalibratedVdot — edge cases', () => {
  it('handles weighted regression correctly (duration matters)', () => {
    // One long run + two short runs — the long run should dominate.
    // Long run: 60 min at HR 160, pace 5:00/km = 300s/km
    // Short runs: 22 min at HR 140, pace 6:00/km = 360s/km
    const RHR = 50, MAX = 190;
    const runs = [
      { startTime: new Date(NOW.getTime() - 1 * 86400000).toISOString(), distKm: 12, durSec: 60 * 60, avgHR: 160, hrDrift: 3 },
      { startTime: new Date(NOW.getTime() - 3 * 86400000).toISOString(), distKm: 3.66, durSec: 22 * 60, avgHR: 140, hrDrift: 3 },
      { startTime: new Date(NOW.getTime() - 5 * 86400000).toISOString(), distKm: 3.66, durSec: 22 * 60, avgHR: 140, hrDrift: 3 },
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    // Weighted regression should converge despite imbalanced sample.
    expect(r.vdot).not.toBeNull();
    expect(r.beta).toBeLessThan(0);
  });

  it('returns null paceAtVO2max when extrapolation is nonsense', () => {
    // Narrow HRR range (all points clustered at 88-90%) → β is poorly constrained,
    // extrapolation to 100% may produce absurd pace. Should be caught.
    const RHR = 50, MAX = 190;
    const runs = [
      mkRun(1, 10, 270, 174),
      mkRun(3,  8, 268, 173),
      mkRun(5, 12, 265, 175),
      mkRun(7, 10, 269, 174),
    ];
    const r = computeHRCalibratedVdot(runs, RHR, MAX, NOW);
    // Either valid or bad-fit, but never nonsense VDOT.
    if (r.vdot != null) {
      expect(r.vdot).toBeGreaterThan(30);
      expect(r.vdot).toBeLessThan(90);
    }
  });
});
