import { describe, it, expect } from 'vitest';
import {
  normalizeSport,
  getRPEMult,
  rpeFactor,
  weightedLoad,
  intensityProfile,
  isHardDay,
  canTouchWorkout,
  createActivity,
  getWeeklyLoad,
  aggregateActivitiesWithDecay
} from './activities';
import type { CrossActivity } from '@/types';

describe('Cross-Training Activities', () => {
  describe('normalizeSport', () => {
    it('should return sport key as-is for known sports', () => {
      expect(normalizeSport('soccer')).toBe('soccer');
      expect(normalizeSport('rugby')).toBe('rugby');
      expect(normalizeSport('cycling')).toBe('cycling');
    });

    it('should convert aliases to standard keys', () => {
      expect(normalizeSport('football')).toBe('soccer');
      expect(normalizeSport('touch_rugby')).toBe('rugby');
      expect(normalizeSport('gym')).toBe('strength');
      expect(normalizeSport('weights')).toBe('strength');
      expect(normalizeSport('pickleball')).toBe('tennis'); // pickleball is tennis alias
    });

    it('should handle case insensitivity', () => {
      expect(normalizeSport('SOCCER')).toBe('soccer');
      expect(normalizeSport('Football')).toBe('soccer');
      expect(normalizeSport('RUGBY')).toBe('rugby');
    });

    it('should handle spaces by converting to underscores', () => {
      expect(normalizeSport('touch rugby')).toBe('rugby');
      expect(normalizeSport('extra run')).toBe('extra_run');
    });
  });

  describe('getRPEMult', () => {
    it('should return correct multipliers for all RPE levels', () => {
      expect(getRPEMult(9)).toBe(1.20);
      expect(getRPEMult(8)).toBe(1.12);
      expect(getRPEMult(7)).toBe(1.06);
      expect(getRPEMult(6)).toBe(1.00);
      expect(getRPEMult(5)).toBe(0.95);
      expect(getRPEMult(4)).toBe(0.95);
      expect(getRPEMult(3)).toBe(0.95);
      expect(getRPEMult(2)).toBe(0.95);
      expect(getRPEMult(1)).toBe(0.95);
    });

    it('should handle RPE 10 (uses 9 threshold)', () => {
      expect(getRPEMult(10)).toBe(1.20);
    });

    it('should handle fractional RPE values', () => {
      expect(getRPEMult(8.5)).toBe(1.12); // >= 8
      expect(getRPEMult(7.9)).toBe(1.06); // >= 7
    });
  });

  describe('rpeFactor', () => {
    // CRITICAL: This is used in the main matching algorithm
    // Formula: 1.0 + (rpe - 5) * 0.06

    it('should return 1.0 for default RPE (5)', () => {
      expect(rpeFactor(5)).toBe(1.0);
    });

    it('should increase factor for higher RPE', () => {
      expect(rpeFactor(9)).toBeCloseTo(1.24, 2); // 1 + (9-5)*0.06 = 1.24
      expect(rpeFactor(8)).toBeCloseTo(1.18, 2);
      expect(rpeFactor(7)).toBeCloseTo(1.12, 2);
      expect(rpeFactor(6)).toBeCloseTo(1.06, 2);
    });

    it('should decrease factor for lower RPE', () => {
      expect(rpeFactor(4)).toBeCloseTo(0.94, 2); // 1 + (4-5)*0.06 = 0.94
      expect(rpeFactor(3)).toBeCloseTo(0.88, 2);
      expect(rpeFactor(2)).toBeCloseTo(0.82, 2);
      expect(rpeFactor(1)).toBeCloseTo(0.76, 2);
    });

    it('should handle null/undefined by using default RPE', () => {
      expect(rpeFactor(null)).toBe(1.0);
      expect(rpeFactor(undefined)).toBe(1.0);
    });

    it('should show significant difference between RPE 9 and RPE 3', () => {
      const rpe9Factor = rpeFactor(9);
      const rpe3Factor = rpeFactor(3);
      const ratio = rpe9Factor / rpe3Factor;

      // Ratio should be ~1.41 (1.24/0.88)
      expect(ratio).toBeCloseTo(1.41, 1);

      // This is the RPE factor difference - but is it enough?
      // Combined with LOAD_PER_MIN difference (5.5/1.2 = 4.58x),
      // total should be ~6.5x difference
    });
  });

  describe('weightedLoad', () => {
    // ANAEROBIC_WEIGHT = 1.15

    it('should weight anaerobic load higher', () => {
      const load = weightedLoad(100, 100);
      expect(load).toBe(100 + 100 * 1.15); // 215
    });

    it('should handle zero anaerobic', () => {
      expect(weightedLoad(100, 0)).toBe(100);
    });

    it('should handle zero aerobic', () => {
      expect(weightedLoad(0, 100)).toBeCloseTo(115, 0);
    });
  });

  describe('intensityProfile', () => {
    it('should calculate correct anaerobic ratio', () => {
      const profile = intensityProfile(80, 20);
      expect(profile.total).toBe(100);
      expect(profile.anaerobicRatio).toBe(0.2);
      expect(profile.weighted).toBe(80 + 20 * 1.15);
    });

    it('should handle all aerobic', () => {
      const profile = intensityProfile(100, 0);
      expect(profile.anaerobicRatio).toBe(0);
    });

    it('should handle zero total', () => {
      const profile = intensityProfile(0, 0);
      expect(profile.anaerobicRatio).toBe(0);
    });
  });

  describe('isHardDay', () => {
    it('should classify high anaerobic ratio as hard', () => {
      // anaerobicRatio >= 0.22 is hard
      // 22/(78+22) = 0.22
      expect(isHardDay(78, 22)).toBe(true);  // 22% anaerobic exactly
    });

    it('should classify high weighted load as hard', () => {
      // weighted >= 40 is hard
      expect(isHardDay(35, 5)).toBe(true);   // 35 + 5*1.15 = 40.75
    });

    it('should return false when neither condition met', () => {
      // Need low ratio (<0.22) AND low weighted load (<40)
      // 30 + 5*1.15 = 35.75, ratio = 5/35 = 0.14
      expect(isHardDay(30, 5)).toBe(false);
    });

    it('should return true when weighted load threshold met', () => {
      // Even with low ratio, high load = hard
      expect(isHardDay(100, 0)).toBe(true); // ratio=0, weighted=100 - weighted met
    });
  });

  describe('canTouchWorkout', () => {
    it('should prevent rugby/soccer from touching long runs', () => {
      expect(canTouchWorkout('rugby', 'long')).toBe(false);
      expect(canTouchWorkout('soccer', 'long')).toBe(false);
      expect(canTouchWorkout('basketball', 'long')).toBe(false);
    });

    it('should allow other sports to touch long runs', () => {
      expect(canTouchWorkout('cycling', 'long')).toBe(true);
      expect(canTouchWorkout('swimming', 'long')).toBe(true);
      expect(canTouchWorkout('tennis', 'long')).toBe(true);
    });

    it('should allow all sports to touch easy runs', () => {
      expect(canTouchWorkout('rugby', 'easy')).toBe(true);
      expect(canTouchWorkout('soccer', 'easy')).toBe(true);
      expect(canTouchWorkout('cycling', 'easy')).toBe(true);
    });
  });

  describe('createActivity', () => {
    describe('load estimation without Garmin data', () => {
      it('should estimate loads based on RPE and duration', () => {
        const activity = createActivity('rugby', 60, 9);

        // LOAD_PER_MIN_BY_INTENSITY[9] = 5.5
        // aerobic = 60 * 5.5 * 0.85 = 280.5
        // anaerobic = 60 * 5.5 * 0.15 = 49.5 (RPE > 7)
        expect(activity.aerobic_load).toBeCloseTo(280.5, 0);
        expect(activity.anaerobic_load).toBeCloseTo(49.5, 0);
        expect(activity.fromGarmin).toBe(false);
      });

      it('should estimate lower loads for low RPE', () => {
        const activity = createActivity('rugby', 60, 3);

        // LOAD_PER_MIN_BY_INTENSITY[3] = 1.2
        // aerobic = 60 * 1.2 * 0.85 = 61.2
        // anaerobic = 60 * 1.2 * 0.05 = 3.6 (RPE <= 7)
        expect(activity.aerobic_load).toBeCloseTo(61.2, 0);
        expect(activity.anaerobic_load).toBeCloseTo(3.6, 0);
      });

      it('should show ~4.5x load difference between RPE 9 and RPE 3', () => {
        const highRPE = createActivity('rugby', 60, 9);
        const lowRPE = createActivity('rugby', 60, 3);

        const highTotal = highRPE.aerobic_load + highRPE.anaerobic_load;
        const lowTotal = lowRPE.aerobic_load + lowRPE.anaerobic_load;

        // RPE 9 baseRate=5.5, RPE 3 baseRate=1.2
        // Ratio should be ~5.5/1.2 = 4.58
        // But anaerobic split differs (15% vs 5%), so actual ratio is slightly different
        const ratio = highTotal / lowTotal;
        expect(ratio).toBeGreaterThan(4);
        expect(ratio).toBeLessThan(6);
      });
    });

    describe('with Garmin data', () => {
      it('should use provided Garmin loads', () => {
        const activity = createActivity('rugby', 60, 9, 150, 50);

        expect(activity.aerobic_load).toBe(150);
        expect(activity.anaerobic_load).toBe(50);
        expect(activity.fromGarmin).toBe(true);
      });

      it('should default anaerobic to 0 if not provided', () => {
        const activity = createActivity('rugby', 60, 9, 150);

        expect(activity.aerobic_load).toBe(150);
        expect(activity.anaerobic_load).toBe(0);
      });
    });

    it('should normalize sport name', () => {
      const activity = createActivity('football', 60, 5);
      expect(activity.sport).toBe('soccer');
    });

    it('should generate unique IDs', () => {
      const a1 = createActivity('rugby', 60, 5);
      const a2 = createActivity('rugby', 60, 5);
      expect(a1.id).not.toBe(a2.id);
    });
  });

  describe('getWeeklyLoad', () => {
    it('should sum loads for activities in specified week', () => {
      const activities: CrossActivity[] = [
        createActivity('rugby', 60, 5, 100, 20, 1),
        createActivity('cycling', 60, 5, 80, 10, 1),
        createActivity('rugby', 60, 5, 100, 20, 2), // Different week
      ];

      const load = getWeeklyLoad(activities, 1);
      // Only week 1 activities should be counted
      expect(load).toBeGreaterThan(0);
    });

    it('should apply sport multipliers', () => {
      const rugbyActivity: CrossActivity[] = [
        createActivity('rugby', 60, 5, 100, 0, 1)
      ];
      const cyclingActivity: CrossActivity[] = [
        createActivity('cycling', 60, 5, 100, 0, 1)
      ];

      const rugbyLoad = getWeeklyLoad(rugbyActivity, 1);
      const cyclingLoad = getWeeklyLoad(cyclingActivity, 1);

      // Rugby mult=1.50, Cycling mult=0.75
      expect(rugbyLoad).toBeCloseTo(cyclingLoad * 2, 0);
    });

    it('should apply RPE multipliers from getRPEMult', () => {
      const highRPE: CrossActivity[] = [
        createActivity('rugby', 60, 9, 100, 0, 1)
      ];
      const lowRPE: CrossActivity[] = [
        createActivity('rugby', 60, 3, 100, 0, 1)
      ];

      const highLoad = getWeeklyLoad(highRPE, 1);
      const lowLoad = getWeeklyLoad(lowRPE, 1);

      // RPE 9 mult=1.20, RPE 3 mult=0.95
      // Note: getWeeklyLoad uses getRPEMult, NOT rpeFactor!
      const expectedRatio = 1.20 / 0.95;
      const actualRatio = highLoad / lowLoad;
      expect(actualRatio).toBeCloseTo(expectedRatio, 1);
    });
  });

  describe('RPE impact analysis for different sports', () => {
    // This tests the user's concern about RPE 9 vs RPE 3 for rugby

    const sports = ['soccer', 'rugby', 'basketball', 'tennis', 'swimming', 'cycling', 'strength', 'extra_run'];

    for (const sport of sports) {
      describe(`${sport}`, () => {
        it('should show significant load difference between RPE 9 and RPE 3', () => {
          const rpe9 = createActivity(sport, 60, 9);
          const rpe3 = createActivity(sport, 60, 3);

          const load9 = weightedLoad(rpe9.aerobic_load, rpe9.anaerobic_load);
          const load3 = weightedLoad(rpe3.aerobic_load, rpe3.anaerobic_load);

          const ratio = load9 / load3;

          // Should have at least 4x difference between RPE 9 and RPE 3
          expect(ratio).toBeGreaterThan(4);
        });

        it('should produce reasonable load values', () => {
          const activity = createActivity(sport, 60, 5);

          // 60 min at moderate intensity should produce meaningful load
          expect(activity.aerobic_load).toBeGreaterThan(50);
          expect(activity.aerobic_load).toBeLessThan(500);
        });
      });
    }
  });

  describe('aggregateActivitiesWithDecay', () => {
    it('should separate current and previous week activities', () => {
      const activities: CrossActivity[] = [
        createActivity('rugby', 60, 7, 100, 30, 2),
        createActivity('cycling', 45, 5, 80, 10, 2),
        createActivity('rugby', 90, 8, 150, 50, 1), // Previous week
        createActivity('swimming', 30, 4, 40, 5, 1), // Previous week
      ];

      const { current, previous } = aggregateActivitiesWithDecay(activities, 2);

      expect(current.length).toBe(2);
      expect(previous.length).toBe(2);

      // Current week activities should be week 2
      expect(current.every(a => a.week === 2)).toBe(true);

      // Previous week activities should be week 1
      expect(previous.every(a => a.week === 1)).toBe(true);
    });

    it('should return empty arrays when no activities match', () => {
      const activities: CrossActivity[] = [
        createActivity('rugby', 60, 7, 100, 30, 5),
        createActivity('cycling', 45, 5, 80, 10, 5),
      ];

      const { current, previous } = aggregateActivitiesWithDecay(activities, 2);

      expect(current.length).toBe(0);
      expect(previous.length).toBe(0);
    });

    it('should handle week 1 with no previous week', () => {
      const activities: CrossActivity[] = [
        createActivity('rugby', 60, 7, 100, 30, 1),
        createActivity('cycling', 45, 5, 80, 10, 1),
      ];

      const { current, previous } = aggregateActivitiesWithDecay(activities, 1);

      expect(current.length).toBe(2);
      expect(previous.length).toBe(0); // No week 0
    });

    it('should work with empty activities array', () => {
      const { current, previous } = aggregateActivitiesWithDecay([], 3);

      expect(current.length).toBe(0);
      expect(previous.length).toBe(0);
    });
  });
});
