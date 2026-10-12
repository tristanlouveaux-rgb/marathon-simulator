import { describe, it, expect } from 'vitest';
import { cv, vt, tv, rd, rdKm } from './vdot';

describe('VDOT Calculations', () => {
  describe('cv - Calculate VDOT from distance and time', () => {
    it('should calculate VDOT for a 20:00 5K', () => {
      const vdot = cv(5000, 20 * 60);
      // Implementation gives ~50 for 20:00 5K
      expect(vdot).toBeCloseTo(50, 0);
    });

    it('should calculate VDOT for an 18:00 5K', () => {
      const vdot = cv(5000, 18 * 60);
      // Implementation gives ~56 for 18:00 5K
      expect(vdot).toBeCloseTo(56, 0);
    });

    it('should calculate VDOT for a 3:00 marathon', () => {
      const vdot = cv(42195, 3 * 60 * 60);
      // Implementation gives ~53.5 for 3:00 marathon
      expect(vdot).toBeCloseTo(53.5, 0);
    });

    it('should calculate VDOT for a 4:00 marathon', () => {
      const vdot = cv(42195, 4 * 60 * 60);
      // Implementation gives ~38 for 4:00 marathon
      expect(vdot).toBeCloseTo(38, 0);
    });

    it('should calculate VDOT for a 1:30 half marathon', () => {
      const vdot = cv(21097, 90 * 60);
      // Implementation gives ~51 for 1:30 half
      expect(vdot).toBeCloseTo(51, 0);
    });

    it('should return minimum VDOT of 15 for very slow times', () => {
      const vdot = cv(5000, 60 * 60); // 1 hour 5K
      expect(vdot).toBeGreaterThanOrEqual(15);
    });

    it('should give higher VDOT for faster times at same distance', () => {
      const vdotFast = cv(5000, 18 * 60);
      const vdotSlow = cv(5000, 25 * 60);
      expect(vdotFast).toBeGreaterThan(vdotSlow);
    });
  });

  describe('vt - Calculate time from VDOT and distance', () => {
    it('should predict faster 5K for higher VDOT', () => {
      const timeLowVdot = vt(5, 40);
      const timeHighVdot = vt(5, 60);
      expect(timeHighVdot).toBeLessThan(timeLowVdot);
    });

    it('should predict reasonable 5K times', () => {
      const time = vt(5, 50);
      // Should be in a reasonable range (15-25 min)
      expect(time).toBeGreaterThan(15 * 60);
      expect(time).toBeLessThan(25 * 60);
    });

    it('should predict reasonable marathon times', () => {
      const time = vt(42.195, 50);
      // Should be in a reasonable range (2:30-4:30)
      expect(time).toBeGreaterThan(2.5 * 60 * 60);
      expect(time).toBeLessThan(4.5 * 60 * 60);
    });

    it('should predict longer times for longer distances', () => {
      const time5k = vt(5, 50);
      const time10k = vt(10, 50);
      const timeMarathon = vt(42.195, 50);
      expect(time10k).toBeGreaterThan(time5k);
      expect(timeMarathon).toBeGreaterThan(time10k);
    });

    it('should be approximately inverse of cv (round-trip)', () => {
      const originalTime = 25 * 60; // 25:00 5K
      const vdot = cv(5000, originalTime);
      const predictedTime = vt(5, vdot);
      // Allow 5% tolerance for Newton's method convergence
      expect(predictedTime).toBeGreaterThan(originalTime * 0.95);
      expect(predictedTime).toBeLessThan(originalTime * 1.05);
    });
  });

  describe('vt converges in time: no steps in VDOT (2026-10-12)', () => {
    // vt used to stop its bisection once the VDOT error was under 0.05, so it
    // was a step function: 11644.83 s for every marathon VDOT from 49.000 to
    // 49.004, then 11629.38 s from 49.005. A VDOT drifting a little day to day
    // (PB ageing) then jumped the forecast's horizon delta by up to 15 s.
    it('inverts cv to well under a millisecond at every race distance', () => {
      for (const km of [5, 10, 21.0975, 42.195]) {
        for (const v of [30, 38.7, 45, 49.004, 49.005, 55.2, 70, 82]) {
          const t = vt(km, v);
          expect(cv(km * 1000, t)).toBeCloseTo(v, 9);
        }
      }
    });

    it('a 0.001 VDOT step moves the marathon by a fraction of a second, every time', () => {
      let prev = vt(42.195, 49);
      for (let i = 1; i <= 40; i++) {
        const t = vt(42.195, 49 + i * 0.001);
        // Strictly faster for a higher VDOT, and about 0.2 s per 0.001.
        expect(t).toBeLessThan(prev);
        expect(prev - t).toBeLessThan(0.5);
        prev = t;
      }
      // The old 15 s step between 49.004 and 49.005 is gone.
      expect(vt(42.195, 49.004) - vt(42.195, 49.005)).toBeLessThan(0.5);
    });
  });

  describe('tv - Alias for vt with swapped args', () => {
    it('should return same result as vt', () => {
      const fromVt = vt(10, 50);
      const fromTv = tv(50, 10);
      expect(fromTv).toBe(fromVt);
    });
  });

  describe('rd - Race distance in meters', () => {
    it('should return 5000 for 5k', () => {
      expect(rd('5k')).toBe(5000);
    });

    it('should return 10000 for 10k', () => {
      expect(rd('10k')).toBe(10000);
    });

    it('should return 21097 for half', () => {
      expect(rd('half')).toBe(21097);
    });

    it('should return 42195 for marathon', () => {
      expect(rd('marathon')).toBe(42195);
    });

    it('should default to marathon distance for unknown input', () => {
      expect(rd('unknown')).toBe(42195);
    });
  });

  describe('rdKm - Race distance in kilometers', () => {
    it('should return 5 for 5k', () => {
      expect(rdKm('5k')).toBe(5);
    });

    it('should return 10 for 10k', () => {
      expect(rdKm('10k')).toBe(10);
    });

    it('should return 21.097 for half', () => {
      expect(rdKm('half')).toBe(21.097);
    });

    it('should return 42.195 for marathon', () => {
      expect(rdKm('marathon')).toBe(42.195);
    });

    it('should default to marathon distance for unknown input', () => {
      expect(rdKm('unknown')).toBe(42.195);
    });
  });

  describe('Edge cases', () => {
    it('should handle very fast times (elite)', () => {
      // Kipchoge's marathon WR pace
      const vdot = cv(42195, 2 * 60 * 60 + 35); // ~2:00:35
      expect(vdot).toBeGreaterThan(80);
    });

    it('should handle different distances consistently', () => {
      // Same VDOT should give proportionally longer times for longer distances
      const vdot = 50;
      const time5k = vt(5, vdot);
      const time10k = vt(10, vdot);
      const timeHalf = vt(21.1, vdot);
      const timeMarathon = vt(42.2, vdot);

      expect(time10k).toBeGreaterThan(time5k);
      expect(timeHalf).toBeGreaterThan(time10k);
      expect(timeMarathon).toBeGreaterThan(timeHalf);

      // 10K should be roughly 2x 5K time (slightly more due to fatigue)
      expect(time10k / time5k).toBeGreaterThan(2);
      expect(time10k / time5k).toBeLessThan(2.2);
    });
  });

  describe('High VDOT convergence (bisection method)', () => {
    // Tests for the fixed vt() function that now uses bisection method
    // for reliable convergence at VDOT 70+

    it('should converge for VDOT 70', () => {
      const time5k = vt(5, 70);
      // VDOT 70 5K should be around 14:00-15:00
      expect(time5k).toBeGreaterThan(13 * 60);
      expect(time5k).toBeLessThan(16 * 60);

      // Verify round-trip consistency
      const calculatedVdot = cv(5000, time5k);
      expect(calculatedVdot).toBeCloseTo(70, 0);
    });

    it('should converge for VDOT 75', () => {
      const time5k = vt(5, 75);
      // VDOT 75 5K should be around 13:00-14:00
      expect(time5k).toBeGreaterThan(12 * 60);
      expect(time5k).toBeLessThan(15 * 60);

      const calculatedVdot = cv(5000, time5k);
      expect(calculatedVdot).toBeCloseTo(75, 0);
    });

    it('should converge for VDOT 80', () => {
      const time5k = vt(5, 80);
      // VDOT 80 5K should be around 12:30-13:30
      expect(time5k).toBeGreaterThan(11.5 * 60);
      expect(time5k).toBeLessThan(14 * 60);

      const calculatedVdot = cv(5000, time5k);
      expect(calculatedVdot).toBeCloseTo(80, 0);
    });

    it('should converge for VDOT 85', () => {
      const time5k = vt(5, 85);
      // VDOT 85 5K should be around 12:00-13:00
      expect(time5k).toBeGreaterThan(11 * 60);
      expect(time5k).toBeLessThan(13.5 * 60);

      const calculatedVdot = cv(5000, time5k);
      expect(calculatedVdot).toBeCloseTo(85, 0);
    });

    it('should maintain consistency across all distances at high VDOT', () => {
      const vdot = 75;
      const time5k = vt(5, vdot);
      const time10k = vt(10, vdot);
      const timeHalf = vt(21.1, vdot);
      const timeMarathon = vt(42.2, vdot);

      // All should round-trip correctly
      expect(cv(5000, time5k)).toBeCloseTo(vdot, 0);
      expect(cv(10000, time10k)).toBeCloseTo(vdot, 0);
      expect(cv(21097, timeHalf)).toBeCloseTo(vdot, 0);
      expect(cv(42195, timeMarathon)).toBeCloseTo(vdot, 0);
    });

    it('should handle extreme VDOT values gracefully', () => {
      // Very high VDOT (world record territory)
      const timeWR = vt(5, 90);
      expect(timeWR).toBeGreaterThan(10 * 60);
      expect(timeWR).toBeLessThan(13 * 60);

      // Very low VDOT
      const timeSlow = vt(5, 25);
      expect(timeSlow).toBeGreaterThan(30 * 60);
      expect(timeSlow).toBeLessThan(60 * 60);
    });
  });
});
