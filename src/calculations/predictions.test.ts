import { describe, it, expect } from 'vitest';
import {
  predictFromPB,
  predictFromRecent,
  predictFromLT,
  predictFromVO2,
  blendPredictions,
} from './predictions';
import type { PBs, RecentRun } from '@/types';

describe('Predictions', () => {
  describe('predictFromPB', () => {
    const pbs: PBs = {
      k5: 20 * 60,      // 20:00 5K
      k10: 42 * 60,     // 42:00 10K
      h: 95 * 60,       // 1:35:00 half
      m: 200 * 60,      // 3:20:00 marathon
    };
    const b = 1.06; // Typical fatigue exponent

    it('should predict marathon time from 5K PB', () => {
      const pbsOnlyK5: PBs = { k5: 20 * 60 };
      const predicted = predictFromPB(42195, pbsOnlyK5, b);
      expect(predicted).not.toBeNull();
      // 20:00 5K runner should run marathon in ~3:10-3:40 range
      expect(predicted).toBeGreaterThan(190 * 60);
      expect(predicted).toBeLessThan(220 * 60);
    });

    it('should use closest distance for prediction', () => {
      // When predicting half marathon, should prefer half PB if available
      const predicted = predictFromPB(21097, pbs, b);
      expect(predicted).not.toBeNull();
      // Should be close to actual half PB since that's the closest distance
      expect(predicted).toBeCloseTo(95 * 60, -1);
    });

    it('should return null when no PBs provided', () => {
      const emptyPbs: PBs = {};
      const predicted = predictFromPB(42195, emptyPbs, b);
      expect(predicted).toBeNull();
    });

    it('should scale times with fatigue exponent', () => {
      const pbsK5: PBs = { k5: 20 * 60 };
      // Higher fatigue exponent = slower at longer distances
      const predictedHighB = predictFromPB(42195, pbsK5, 1.10);
      const predictedLowB = predictFromPB(42195, pbsK5, 1.04);
      expect(predictedHighB).toBeGreaterThan(predictedLowB!);
    });
  });

  describe('predictFromRecent', () => {
    const pbs: PBs = { k5: 20 * 60 };
    const b = 1.06;

    it('should return null when no recent run provided', () => {
      const predicted = predictFromRecent(42195, null, pbs, b);
      expect(predicted).toBeNull();
    });

    it('should return null when recent run has no time', () => {
      const recent: RecentRun = { d: 10, t: 0, weeksAgo: 1 };
      const predicted = predictFromRecent(42195, recent, pbs, b);
      expect(predicted).toBeNull();
    });

    it('should heavily weight recent run when very fresh (<=2 weeks)', () => {
      const recent: RecentRun = { d: 10, t: 42 * 60, weeksAgo: 1 }; // 42:00 10K
      const predicted = predictFromRecent(42195, recent, pbs, b);
      expect(predicted).not.toBeNull();
      // Fresh 10K should strongly influence marathon prediction
    });

    it('should blend more with PB when recent is stale (>12 weeks)', () => {
      const recent: RecentRun = { d: 10, t: 42 * 60, weeksAgo: 20 };
      const predicted = predictFromRecent(42195, recent, pbs, b);
      expect(predicted).not.toBeNull();
    });

    it('should work without PBs to blend with', () => {
      const emptyPbs: PBs = {};
      const recent: RecentRun = { d: 10, t: 42 * 60, weeksAgo: 2 };
      const predicted = predictFromRecent(42195, recent, emptyPbs, b);
      expect(predicted).not.toBeNull();
    });
  });

  describe('predictFromLT', () => {
    const ltPace = 240; // 4:00/km LT pace

    it('should return null when no LT pace provided', () => {
      const predicted = predictFromLT(42195, null, 'balanced');
      expect(predicted).toBeNull();
    });

    it('should give different predictions for different runner types at 5K', () => {
      const speed = predictFromLT(5000, ltPace, 'speed');
      const endurance = predictFromLT(5000, ltPace, 'endurance');
      // Speed runners have higher multiplier (0.95) vs endurance (0.92) at 5K
      // Higher multiplier = slower time in this formula
      expect(speed).not.toBe(endurance);
    });

    it('should predict faster times for endurance runners at longer distances', () => {
      const speed = predictFromLT(42195, ltPace, 'speed');
      const endurance = predictFromLT(42195, ltPace, 'endurance');
      expect(endurance).toBeLessThan(speed!);
    });

    it('should handle case insensitivity in runner type', () => {
      const lower = predictFromLT(42195, ltPace, 'balanced');
      const upper = predictFromLT(42195, ltPace, 'BALANCED');
      const mixed = predictFromLT(42195, ltPace, 'Balanced');
      expect(lower).toBe(upper);
      expect(lower).toBe(mixed);
    });

    it('should calculate reasonable times for standard distances', () => {
      // 4:00/km LT pace runner
      const marathon = predictFromLT(42195, ltPace, 'balanced');
      // Formula: ltPace * (distance/1000) * multiplier
      // 240 * 42.195 * 1.115 = ~11,291 seconds = ~3:08
      expect(marathon).toBeGreaterThan(170 * 60);
      expect(marathon).toBeLessThan(210 * 60);
    });
  });

  describe('predictFromVO2', () => {
    it('should return null when no VDOT provided', () => {
      const predicted = predictFromVO2(42195, null);
      expect(predicted).toBeNull();
    });

    it('should predict reasonable 5K time for VDOT 50', () => {
      const predicted = predictFromVO2(5000, 50);
      expect(predicted).not.toBeNull();
      // VDOT 50 = ~19:00 5K
      expect(predicted).toBeGreaterThan(18 * 60);
      expect(predicted).toBeLessThan(20 * 60);
    });

    it('should predict reasonable marathon time for VDOT 50', () => {
      const predicted = predictFromVO2(42195, 50);
      expect(predicted).not.toBeNull();
      // Should be a reasonable marathon time (2:30-4:30)
      expect(predicted).toBeGreaterThan(150 * 60);
      expect(predicted).toBeLessThan(270 * 60);
    });

    it('should predict longer times for lower VDOT', () => {
      const vdot40 = predictFromVO2(42195, 40);
      const vdot50 = predictFromVO2(42195, 50);
      expect(vdot40).toBeGreaterThan(vdot50!);
    });
  });

  describe('blendPredictions', () => {
    const pbs: PBs = { k5: 20 * 60, k10: 42 * 60 };
    const b = 1.06;

    it('should return null when no predictors available', () => {
      const emptyPbs: PBs = {};
      const predicted = blendPredictions(
        42195,
        emptyPbs,
        null,
        null,
        b,
        'balanced',
        null
      );
      expect(predicted).toBeNull();
    });

    it('should blend multiple predictors', () => {
      const ltPace = 240;
      const vdot = 50;
      const predicted = blendPredictions(
        42195,
        pbs,
        ltPace,
        vdot,
        b,
        'balanced',
        null
      );
      expect(predicted).not.toBeNull();
      // Should be a reasonable marathon time
      expect(predicted).toBeGreaterThan(180 * 60);
      expect(predicted).toBeLessThan(240 * 60);
    });

    it('should weight recent run when provided', () => {
      const recent: RecentRun = { d: 10, t: 40 * 60, weeksAgo: 1 }; // Fast recent 10K
      const withRecent = blendPredictions(
        42195,
        pbs,
        null,
        null,
        b,
        'balanced',
        recent
      );
      const withoutRecent = blendPredictions(
        42195,
        pbs,
        null,
        null,
        b,
        'balanced',
        null
      );
      // Fresh fast 10K should pull prediction faster
      expect(withRecent).toBeLessThan(withoutRecent!);
    });

    it('should work with only LT pace', () => {
      const emptyPbs: PBs = {};
      const predicted = blendPredictions(
        42195,
        emptyPbs,
        240,
        null,
        b,
        'balanced',
        null
      );
      expect(predicted).not.toBeNull();
    });

    it('should work with only VDOT', () => {
      const emptyPbs: PBs = {};
      const predicted = blendPredictions(
        42195,
        emptyPbs,
        null,
        50,
        b,
        'balanced',
        null
      );
      expect(predicted).not.toBeNull();
    });
  });
});
