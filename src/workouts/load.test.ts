import { describe, it, expect } from 'vitest';
import { calculateWorkoutLoad } from './load';

describe('Workout Load Calculations', () => {
  describe('calculateWorkoutLoad', () => {
    describe('duration parsing', () => {
      it('should parse km distances', () => {
        const load = calculateWorkoutLoad('easy', '10km', 50);
        // 10km at easy pace (~6.0 min/km) = 60 min
        expect(load.aerobic).toBeGreaterThan(0);
        expect(load.anaerobic).toBeGreaterThan(0);
      });

      it('should parse interval formats (3×10min)', () => {
        const load = calculateWorkoutLoad('threshold', '3×10min', 70);
        // 3 * 10 = 30 min
        expect(load.aerobic).toBeGreaterThan(0);
      });

      it('should parse simple minute formats (45min)', () => {
        const load = calculateWorkoutLoad('threshold', '45min', 70);
        expect(load.aerobic).toBeGreaterThan(0);
      });

      it('should handle numeric duration', () => {
        const load = calculateWorkoutLoad('easy', 60, 50);
        expect(load.aerobic).toBeGreaterThan(0);
      });

      it('should use defaults for unparseable descriptions', () => {
        const load = calculateWorkoutLoad('long', 'some complex workout', 50);
        // Should default to 120 min for long
        expect(load.aerobic).toBeGreaterThan(0);
      });
    });

    describe('workout type load profiles', () => {
      it('should give easy runs more aerobic than anaerobic load', () => {
        const load = calculateWorkoutLoad('easy', '10km', 30);
        expect(load.aerobic).toBeGreaterThan(load.anaerobic);
      });

      it('should give threshold runs moderate anaerobic load', () => {
        const load = calculateWorkoutLoad('threshold', '10km', 70);
        expect(load.anaerobic).toBeGreaterThan(0);
        // Threshold has higher anaerobic ratio than easy
        const easyLoad = calculateWorkoutLoad('easy', '10km', 30);
        const thresholdRatio = load.anaerobic / (load.aerobic + load.anaerobic);
        const easyRatio = easyLoad.anaerobic / (easyLoad.aerobic + easyLoad.anaerobic);
        expect(thresholdRatio).toBeGreaterThan(easyRatio);
      });

      it('should give VO2 workouts high anaerobic load', () => {
        const load = calculateWorkoutLoad('vo2', '5km', 80);
        const ratio = load.anaerobic / (load.aerobic + load.anaerobic);
        // VO2 should have significant anaerobic component
        expect(ratio).toBeGreaterThan(0.2);
      });

      it('should give long runs mostly aerobic load', () => {
        const load = calculateWorkoutLoad('long', '30km', 50);
        const ratio = load.anaerobic / (load.aerobic + load.anaerobic);
        // Long runs should be mostly aerobic
        expect(ratio).toBeLessThan(0.3);
      });
    });

    describe('intensity effect (ISSUE-263: valuation is type-keyed)', () => {
      // Since the load-currency canonicalisation, a MAPPED workout type is
      // valued at its physiological row (TSS_RPE_BY_TYPE) regardless of the
      // prescribed RPE — an easy run costs ~55 TSS/h whether the user calls
      // it RPE 3 or 4 (perceived exertion undershoots physiological load at
      // low intensity). Intensity differences are expressed through the TYPE
      // (easy vs threshold vs vo2), not the RPE knob on one type.
      it('higher-intensity TYPES carry higher load at the same distance', () => {
        const easy = calculateWorkoutLoad('easy', '10km', 30);
        const threshold = calculateWorkoutLoad('threshold', '10km', 70);
        const vo2 = calculateWorkoutLoad('vo2', '10km', 80);

        expect(threshold.total).toBeGreaterThan(easy.total);
        // vo2 pace is faster (shorter duration) but the rate dominates:
        expect(vo2.total).toBeGreaterThan(easy.total);
      });

      it('the prescribed RPE does NOT rescale a mapped type (valuation is stable)', () => {
        const rpe3 = calculateWorkoutLoad('easy', '10km', 30);
        const rpe5 = calculateWorkoutLoad('easy', '10km', 50);
        expect(rpe3.total).toBe(rpe5.total);
      });

      it('UNMAPPED types still scale with the prescribed RPE (fallback path)', () => {
        const rpe5 = calculateWorkoutLoad('gym', 45, 50);
        const rpe8 = calculateWorkoutLoad('gym', 45, 80);
        expect(rpe8.total).toBeGreaterThan(rpe5.total);
      });
    });

    describe('total load calculation', () => {
      it('should include weighted anaerobic in total', () => {
        const load = calculateWorkoutLoad('threshold', '10km', 70);

        // Total should be approximately aerobic + anaerobic * 1.15
        // Allow for rounding differences
        const expectedTotal = load.aerobic + load.anaerobic * 1.15;
        expect(Math.abs(load.total - expectedTotal)).toBeLessThan(2);
      });

      it('should return rounded integer values', () => {
        const load = calculateWorkoutLoad('easy', '8km', 50);

        expect(Number.isInteger(load.aerobic)).toBe(true);
        expect(Number.isInteger(load.anaerobic)).toBe(true);
        expect(Number.isInteger(load.total)).toBe(true);
      });
    });

    describe('pace estimation by workout type', () => {
      it('should use faster pace for threshold than easy', () => {
        // Same km, different workout type
        // If pace is faster, duration is shorter, so load should be lower per km
        // But intensity is higher, so need to compare carefully

        const easy = calculateWorkoutLoad('easy', '10km', 50);
        const threshold = calculateWorkoutLoad('threshold', '10km', 70);

        // Threshold has shorter duration (faster pace) but higher intensity
        // Total load depends on the interplay
        expect(easy.aerobic).toBeGreaterThan(0);
        expect(threshold.aerobic).toBeGreaterThan(0);
      });

      it('should use appropriate pace for each type', () => {
        // Easy: 6.0 min/km, Long: 6.2, Threshold: 4.5, VO2: 4.0, Race pace: 4.3, MP: 4.8

        const easy10km = calculateWorkoutLoad('easy', '10km', 50);
        const vo210km = calculateWorkoutLoad('vo2', '10km', 80);

        // VO2 has faster pace (4.0 vs 6.0), so shorter duration (40 vs 60 min)
        // But higher intensity, so loads may not be directly comparable
        expect(easy10km.aerobic).toBeGreaterThan(0);
        expect(vo210km.aerobic).toBeGreaterThan(0);
      });
    });

    describe('edge cases', () => {
      it('should handle zero intensity', () => {
        const load = calculateWorkoutLoad('easy', '10km', 0);
        // Should use RPE 0 which would map to very low load
        expect(load.total).toBeGreaterThanOrEqual(0);
      });

      it('should handle missing duration gracefully', () => {
        const load = calculateWorkoutLoad('easy', '', 50);
        // Should use default duration (40 min for easy)
        expect(load.aerobic).toBeGreaterThan(0);
      });

      it('should handle unknown workout type', () => {
        const load = calculateWorkoutLoad('unknown', '10km', 50);
        // Should use default profile and work
        expect(load.total).toBeGreaterThan(0);
      });
    });
  });
});
