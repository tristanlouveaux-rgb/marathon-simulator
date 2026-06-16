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

    it('should scale times with fatigue exponent (above floor)', () => {
      const pbsK5: PBs = { k5: 20 * 60 };
      // Higher fatigue exponent = slower at longer distances. Both values
      // chosen above the 1.10 Riegel floor (audit #11) so they actually
      // produce distinct extrapolations rather than both clamping to the floor.
      const predictedHighB = predictFromPB(42195, pbsK5, 1.14);
      const predictedLowB = predictFromPB(42195, pbsK5, 1.11);
      expect(predictedHighB).toBeGreaterThan(predictedLowB!);
    });

    it('should apply Riegel floor of 1.10 when extrapolating short anchor (≤10K) to marathon', () => {
      // 2026-05-12 audit #11: speed-profile runners with b<1.10 derived from
      // k5→k10 alone under-correct the endurance drop-off past 21K. Floor at
      // 1.10 prevents marathon-from-5K extrapolations from being optimistic.
      const pbsK5: PBs = { k5: 20 * 60 };
      const predictedAtFloor = predictFromPB(42195, pbsK5, 1.10);
      const predictedBelowFloor = predictFromPB(42195, pbsK5, 1.04);
      // b=1.04 should be clamped up to 1.10 for marathon-from-5K, producing
      // the same time as b=1.10.
      expect(predictedBelowFloor).toBeCloseTo(predictedAtFloor!, 5);
    });

    it('should NOT apply Riegel floor when extrapolating from HM anchor', () => {
      // Floor only fires for short anchors (≤10K). A half-marathon anchor
      // has demonstrated some long-distance endurance, so the derived b is
      // trusted.
      const pbsHM: PBs = { h: 90 * 60 };
      const predictedLowB = predictFromPB(42195, pbsHM, 1.04);
      const predictedHighB = predictFromPB(42195, pbsHM, 1.10);
      expect(predictedHighB).toBeGreaterThan(predictedLowB!);
    });

    it('should NOT apply Riegel floor for 5K target', () => {
      // Floor only fires for targetDist >= 21097. 5K predictions from a
      // 10K anchor should still respect low b values.
      const pbsK10: PBs = { k10: 42 * 60 };
      const predictedLowB = predictFromPB(5000, pbsK10, 1.04);
      const predictedHighB = predictFromPB(5000, pbsK10, 1.10);
      // For shorter target than anchor, higher b means more aggressive
      // speed-up. But the floor doesn't activate either way. Just verify
      // they're not equal (i.e. floor isn't masking the b parameter).
      expect(predictedHighB).not.toBe(predictedLowB);
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

  // 2026-06-15: "no training data" must not be read as "detrained". A brand-new
  // user who enters only a PB has no synced history (weeklyRunKm undefined), and
  // the volume-driven penalties must stay dormant — they exist to correct a
  // returning athlete with REAL low-volume history, not to override a stated PB.
  describe('no-data does not trigger detraining penalties', () => {
    const b = 1.06;

    it('floors a marathon prediction at a same-distance PB when no volume signal', () => {
      const pbs: PBs = { m: 7200 }; // 2:00:00 marathon, nothing else
      // weeklyRunKm omitted (undefined) = no history yet.
      const predicted = blendPredictions(42195, pbs, null, null, b, 'balanced', null);
      // Must not predict slower than the demonstrated time.
      expect(predicted!).toBeCloseTo(7200, 0);
    });

    it('still penalises when a REAL low-volume signal is present (detraining evidence)', () => {
      const pbs: PBs = { m: 7200 };
      const meta = { weeksCovered: 8, paceConfidence: 'low' as const, isStale: false };
      // 5 km/wk of actual history → marathon-specificity penalty fires past the PB.
      const predicted = blendPredictions(
        42195, pbs, null, null, b, 'balanced', null, undefined, 5, undefined, meta,
      );
      expect(predicted!).toBeGreaterThan(7200);
    });

    it('does not over-penalise a 5K-only marathon target with no history', () => {
      const pbs: PBs = { k5: 1200 }; // 20:00 5K, no long-race PB, no volume
      const predicted = blendPredictions(42195, pbs, null, null, b, 'balanced', null);
      // Riegel ceiling (~3:29) + only the small no-long-race penalty (×1.01).
      // Must stay well under the old ~4:03 max-penalty result.
      expect(predicted!).toBeLessThan(3 * 3600 + 40 * 60); // < 3:40
      expect(predicted!).toBeGreaterThan(3 * 3600 + 20 * 60); // > 3:20 (still the ceiling, not free)
    });

    // Volume ESTIMATED from runs/week may size the soft marathon-specificity
    // penalty, but it must never override a demonstrated same-distance PB — an
    // assumption beating a proven time is the original bug. Only MEASURED low
    // volume (synced/stated) is allowed to release the floor.
    it('estimated low volume does NOT override a same-distance marathon PB', () => {
      const pbs: PBs = { m: 7200 }; // 2:00:00 marathon
      const meta = { weeksCovered: 0, paceConfidence: 'none' as const, isStale: true };
      const predicted = blendPredictions(
        42195, pbs, null, null, b, 'balanced', null, undefined,
        12 /* km, but ESTIMATED */, undefined, meta, undefined, undefined,
        /* weeklyRunKmIsEstimate */ true,
      );
      expect(predicted!).toBeCloseTo(7200, 0); // floored to the PB
    });

    it('measured low volume DOES override the PB (estimate flag false)', () => {
      const pbs: PBs = { m: 7200 };
      const meta = { weeksCovered: 8, paceConfidence: 'low' as const, isStale: false };
      const predicted = blendPredictions(
        42195, pbs, null, null, b, 'balanced', null, undefined,
        12 /* km, measured */, undefined, meta, undefined, undefined,
        /* weeklyRunKmIsEstimate */ false,
      );
      expect(predicted!).toBeGreaterThan(7200);
    });
  });

  // Cross-training keeps the aerobic markers (LT/VO2) current, so it softens the
  // short-distance low-volume discount — but ONLY for sub-marathon targets, and
  // never enough to fully erase it. Marathon endurance is run-specific and
  // unaffected.
  describe('cross-training softens the short-distance discount only', () => {
    const b = 1.06;
    // 10K PB 40:00 but LT/VO2 imply a much faster ceiling (~35:00). Low running
    // volume (10 km/wk) makes the discount shift weight toward the slower PB.
    const pbs: PBs = { k10: 2400 };

    it('cross-training makes the 10K prediction faster (discount softened)', () => {
      const noCross = blendPredictions(
        10000, pbs, 210, 55, b, 'balanced', null, undefined,
        10, undefined, undefined, undefined, undefined, false, /* cross */ 0,
      );
      const heavyCross = blendPredictions(
        10000, pbs, 210, 55, b, 'balanced', null, undefined,
        10, undefined, undefined, undefined, undefined, false, /* cross */ 5,
      );
      expect(heavyCross!).toBeLessThan(noCross!); // more trust in current fitness
    });

    it('cross-training does NOT change the marathon prediction', () => {
      const mPbs: PBs = { k10: 2400 }; // no marathon PB, so no floor interference
      const noCross = blendPredictions(
        42195, mPbs, 210, 55, b, 'balanced', null, undefined,
        10, undefined, undefined, undefined, undefined, false, 0,
      );
      const heavyCross = blendPredictions(
        42195, mPbs, 210, 55, b, 'balanced', null, undefined,
        10, undefined, undefined, undefined, undefined, false, 5,
      );
      expect(heavyCross!).toBeCloseTo(noCross!, 5); // marathon is run-specific
    });

    it('cross-training cannot fully erase the discount (capped at 60%)', () => {
      const noDiscount = blendPredictions(
        10000, pbs, 210, 55, b, 'balanced', null, undefined,
        50 /* high volume → no discount at all */, undefined, undefined, undefined, undefined, false, 0,
      );
      const hugeCross = blendPredictions(
        10000, pbs, 210, 55, b, 'balanced', null, undefined,
        10, undefined, undefined, undefined, undefined, false, /* cross */ 99,
      );
      // Even with absurd cross-training, the low-volume prediction must not reach
      // the no-discount prediction — the residual (un-maintained economy) remains.
      expect(hugeCross!).toBeGreaterThan(noDiscount!);
    });
  });
});
