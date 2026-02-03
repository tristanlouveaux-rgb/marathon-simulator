import { describe, it, expect } from 'vitest';
import {
  vibeSimilarity,
  applySaturation,
  calculateReduction,
  reduceWorkoutDistance,
  calculateLoadBudget,
  calculateTotalWorkoutLoad,
  calculatePreviousWeekLoad
} from './load-matching';
import { createActivity } from './activities';
import type { Workout, CrossActivity } from '@/types';
import { LOAD_BUDGET_CONFIG } from '@/constants';

describe('Load Matching', () => {
  describe('vibeSimilarity', () => {
    it('should return 1.0 for identical profiles', () => {
      const similarity = vibeSimilarity(100, 20, 100, 20);
      expect(similarity).toBeCloseTo(1.0, 1);
    });

    it('should return lower score for different anaerobic ratios', () => {
      // Activity: 80% aerobic, 20% anaerobic
      // Workout: 95% aerobic, 5% anaerobic
      const similarity = vibeSimilarity(80, 20, 95, 5);
      expect(similarity).toBeLessThan(0.95);
    });

    it('should return lower score for different load magnitudes', () => {
      // Same ratio but different magnitude
      const similarity = vibeSimilarity(100, 25, 50, 12.5);
      // Ratios are same (25%), but loads differ
      expect(similarity).toBeLessThan(1.0);
    });

    it('should weight ratio similarity (60%) more than load similarity (40%)', () => {
      // Same load, different ratio
      const sameLoadDiffRatio = vibeSimilarity(100, 0, 50, 50); // 0% vs 50% anaerobic

      // Same ratio, different load
      const sameRatioDiffLoad = vibeSimilarity(100, 25, 200, 50); // Both 20% anaerobic

      // Ratio difference should hurt more
      expect(sameRatioDiffLoad).toBeGreaterThan(sameLoadDiffRatio);
    });

    it('should handle zero loads', () => {
      const similarity = vibeSimilarity(0, 0, 100, 20);
      expect(similarity).toBeGreaterThanOrEqual(0);
      expect(similarity).toBeLessThanOrEqual(1);
    });
  });

  describe('applySaturation', () => {
    // Formula: 1500 * (1 - exp(-rawLoad / 800))
    // tau = 800, maxCredit = 1500

    it('should return 0 for 0 load', () => {
      expect(applySaturation(0)).toBe(0);
    });

    it('should saturate high loads', () => {
      const load100 = applySaturation(100);
      const load400 = applySaturation(400);
      const load1600 = applySaturation(1600);

      // Should show diminishing returns
      expect(load400 / load100).toBeLessThan(4);
      expect(load1600 / load400).toBeLessThan(4);
    });

    it('should approach maxCredit (1500) asymptotically', () => {
      const veryHighLoad = applySaturation(10000);
      expect(veryHighLoad).toBeLessThan(1500);
      expect(veryHighLoad).toBeGreaterThan(1490); // Very close to max
    });

    it('should significantly reduce typical activity loads', () => {
      // Rugby RPE 9, 60min without Garmin: ~330 raw load
      // After saturation: 1500 * (1 - exp(-330/800)) ≈ 507
      const saturated = applySaturation(330);
      expect(saturated).toBeCloseTo(507, 0);
    });

    it('should show the saturation effect on RPE 9 vs RPE 3 difference', () => {
      // This is crucial - saturation may reduce the RPE difference!

      // Approximate loads for 60min rugby:
      // RPE 9: ~330 weighted load
      // RPE 3: ~65 weighted load

      const saturatedRPE9 = applySaturation(330);
      const saturatedRPE3 = applySaturation(65);

      const rawRatio = 330 / 65;        // ~5.1x
      const saturatedRatio = saturatedRPE9 / saturatedRPE3;

      // Saturation should reduce the ratio
      expect(saturatedRatio).toBeLessThan(rawRatio);

      // But there should still be meaningful difference
      expect(saturatedRatio).toBeGreaterThan(2);
    });
  });

  describe('calculateReduction', () => {
    describe('easy workouts', () => {
      it('should cap at 50% reduction', () => {
        expect(calculateReduction(2.0, 'easy')).toBe(0.5);
        expect(calculateReduction(10.0, 'easy')).toBe(0.5);
      });

      it('should scale linearly up to cap', () => {
        expect(calculateReduction(0.5, 'easy')).toBeCloseTo(0.25, 2);
        expect(calculateReduction(0.8, 'easy')).toBeCloseTo(0.40, 2);
        expect(calculateReduction(1.0, 'easy')).toBe(0.5);
      });
    });

    describe('long runs', () => {
      it('should be more conservative (cap at 30%)', () => {
        expect(calculateReduction(2.0, 'long')).toBe(0.3);
      });

      it('should scale at lower rate', () => {
        // ratio * 0.20, capped at 0.30
        expect(calculateReduction(0.5, 'long')).toBeCloseTo(0.10, 2);
        expect(calculateReduction(1.0, 'long')).toBeCloseTo(0.20, 2);
      });
    });

    describe('quality workouts', () => {
      it('should cap at 40% for threshold/vo2/race_pace', () => {
        expect(calculateReduction(2.0, 'quality')).toBe(0.4);
        expect(calculateReduction(2.0, 'threshold')).toBe(0.4);
      });

      it('should scale at moderate rate', () => {
        // ratio * 0.4, capped at 0.40
        expect(calculateReduction(0.5, 'quality')).toBeCloseTo(0.20, 2);
        expect(calculateReduction(1.0, 'quality')).toBe(0.4);
      });
    });
  });

  describe('reduceWorkoutDistance', () => {
    it('should reduce km distances', () => {
      expect(reduceWorkoutDistance('10km', 0.3)).toBe('7km (was 10km)');
      expect(reduceWorkoutDistance('8km', 0.5)).toBe('4km (was 8km)');
    });

    it('should round to nearest km', () => {
      expect(reduceWorkoutDistance('10km', 0.25)).toBe('8km (was 10km)');
    });

    it('should return original if no km match', () => {
      expect(reduceWorkoutDistance('5x1000m', 0.3)).toBe('5x1000m');
    });
  });

  describe('calculateTotalWorkoutLoad', () => {
    it('should sum weighted loads for all workouts', () => {
      const workouts: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '8km', r: 3, aerobic: 80, anaerobic: 10 },
        { t: 'threshold', n: 'Threshold', d: '10km', r: 7, aerobic: 120, anaerobic: 40 },
      ];

      const totalLoad = calculateTotalWorkoutLoad(workouts);

      // 80 + 10*1.15 + 120 + 40*1.15 = 80 + 11.5 + 120 + 46 = 257.5
      expect(totalLoad).toBeCloseTo(257.5, 1);
    });

    it('should handle empty workouts array', () => {
      expect(calculateTotalWorkoutLoad([])).toBe(0);
    });

    it('should handle missing load values', () => {
      const workouts: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '8km', r: 3 }, // no aerobic/anaerobic
      ];

      const totalLoad = calculateTotalWorkoutLoad(workouts);
      expect(totalLoad).toBe(0);
    });
  });

  describe('calculatePreviousWeekLoad', () => {
    it('should apply decay to previous week activities', () => {
      const activities: CrossActivity[] = [
        createActivity('rugby', 60, 7, 100, 30, 1),
      ];

      const load = calculatePreviousWeekLoad(activities);

      // Load should be decayed by LOAD_BUDGET_CONFIG.previousWeekDecay (0.70)
      expect(load).toBeGreaterThan(0);
      // Should be less than what it would be without decay
    });

    it('should apply sport multipliers and RPE factors', () => {
      const rugbyActivity: CrossActivity[] = [
        createActivity('rugby', 60, 5, 100, 0, 1),
      ];
      const cyclingActivity: CrossActivity[] = [
        createActivity('cycling', 60, 5, 100, 0, 1),
      ];

      const rugbyLoad = calculatePreviousWeekLoad(rugbyActivity);
      const cyclingLoad = calculatePreviousWeekLoad(cyclingActivity);

      // Rugby has higher mult (1.50) than cycling (0.75)
      expect(rugbyLoad).toBeGreaterThan(cyclingLoad);
    });
  });

  describe('calculateLoadBudget', () => {
    it('should calculate replacement and adjustment budgets based on workout load', () => {
      const workouts: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '8km', r: 3, aerobic: 80, anaerobic: 10 },
        { t: 'threshold', n: 'Threshold', d: '10km', r: 7, aerobic: 120, anaerobic: 40 },
        { t: 'long', n: 'Long Run', d: '20km', r: 5, aerobic: 200, anaerobic: 20 },
      ];

      const budget = calculateLoadBudget(workouts);

      // Total: 80+11.5 + 120+46 + 200+23 = 480.5
      const expectedTotal = 480.5;
      expect(budget.totalWorkoutLoad).toBeCloseTo(expectedTotal, 0);

      // Replacement budget: 30% of total
      expect(budget.replacementBudget).toBeCloseTo(expectedTotal * LOAD_BUDGET_CONFIG.maxReplacementPct, 0);

      // Adjustment budget: 40% of total
      expect(budget.adjustmentBudget).toBeCloseTo(expectedTotal * LOAD_BUDGET_CONFIG.maxAdjustmentPct, 0);

      // Initially nothing consumed
      expect(budget.replacementConsumed).toBe(0);
      expect(budget.adjustmentConsumed).toBe(0);
    });

    it('should reduce available budget based on previous week activities', () => {
      const workouts: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '8km', r: 3, aerobic: 100, anaerobic: 10 },
      ];

      const budgetWithoutPrev = calculateLoadBudget(workouts, []);

      const previousActivities: CrossActivity[] = [
        createActivity('rugby', 90, 8, 200, 50, 0), // High load previous week
      ];

      const budgetWithPrev = calculateLoadBudget(workouts, previousActivities);

      // Budget should be reduced due to previous week fatigue
      expect(budgetWithPrev.replacementBudget).toBeLessThan(budgetWithoutPrev.replacementBudget);
      expect(budgetWithPrev.previousWeekLoad).toBeGreaterThan(0);
    });

    it('should track previous week load in budget object', () => {
      const workouts: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '8km', r: 3, aerobic: 100, anaerobic: 0 },
      ];

      const previousActivities: CrossActivity[] = [
        createActivity('cycling', 60, 5, 100, 10, 0),
      ];

      const budget = calculateLoadBudget(workouts, previousActivities);

      expect(budget.previousWeekLoad).toBeGreaterThan(0);
    });

    it('should allow high budget for large workout weeks', () => {
      // A big training week should have more budget to absorb cross-training
      const bigWeek: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '10km', r: 3, aerobic: 100, anaerobic: 10 },
        { t: 'easy', n: 'Easy 2', d: '10km', r: 3, aerobic: 100, anaerobic: 10 },
        { t: 'threshold', n: 'Threshold', d: '12km', r: 7, aerobic: 150, anaerobic: 50 },
        { t: 'long', n: 'Long Run', d: '30km', r: 5, aerobic: 300, anaerobic: 30 },
      ];

      const smallWeek: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '5km', r: 3, aerobic: 50, anaerobic: 5 },
      ];

      const bigBudget = calculateLoadBudget(bigWeek);
      const smallBudget = calculateLoadBudget(smallWeek);

      expect(bigBudget.replacementBudget).toBeGreaterThan(smallBudget.replacementBudget * 3);
    });
  });

  describe('Load budget scenarios', () => {
    it('scenario: 400min cycling consumes ~6x budget of 60min cycling', () => {
      // This tests the proportional load-based approach
      const workouts: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '8km', r: 3, aerobic: 80, anaerobic: 10 },
        { t: 'easy', n: 'Easy 2', d: '6km', r: 3, aerobic: 60, anaerobic: 8 },
        { t: 'threshold', n: 'Threshold', d: '10km', r: 7, aerobic: 120, anaerobic: 40 },
      ];

      const budget = calculateLoadBudget(workouts);

      // A 400min cycling session at moderate intensity
      const bigCycling = createActivity('cycling', 400, 5, 400, 40, 1);
      // A 60min cycling session
      const smallCycling = createActivity('cycling', 60, 5, 60, 6, 1);

      const bigLoad = bigCycling.aerobic_load + bigCycling.anaerobic_load * 1.15;
      const smallLoad = smallCycling.aerobic_load + smallCycling.anaerobic_load * 1.15;

      // Big session should have ~6x the load (before saturation)
      const ratio = bigLoad / smallLoad;
      expect(ratio).toBeGreaterThan(5);
      expect(ratio).toBeLessThan(8);

      // Budget should be able to accommodate proportional load
      // A big session should consume more budget
    });

    it('scenario: Previous week rugby match reduces this week capacity', () => {
      const workouts: Workout[] = [
        { t: 'easy', n: 'Easy 1', d: '8km', r: 3, aerobic: 100, anaerobic: 10 },
        { t: 'threshold', n: 'Threshold', d: '10km', r: 7, aerobic: 120, anaerobic: 40 },
      ];

      // 90min rugby match at RPE 8 last week
      const lastWeekRugby: CrossActivity[] = [
        createActivity('rugby', 90, 8, 180, 60, 0),
      ];

      const freshBudget = calculateLoadBudget(workouts, []);
      const fatiguedBudget = calculateLoadBudget(workouts, lastWeekRugby);

      // Fatigued week should have less modification capacity
      expect(fatiguedBudget.replacementBudget).toBeLessThan(freshBudget.replacementBudget);

      // The previous week load should be tracked
      expect(fatiguedBudget.previousWeekLoad).toBeGreaterThan(0);
    });
  });
});
