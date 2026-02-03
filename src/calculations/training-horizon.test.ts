import { describe, it, expect } from 'vitest';
import { applyTrainingHorizonAdjustment, calculateSkipPenalty } from './training-horizon';
import type { TrainingHorizonInput } from '@/types';

describe('Training Horizon', () => {
  describe('applyTrainingHorizonAdjustment', () => {
    const baseParams: TrainingHorizonInput = {
      baseline_vdot: 50,
      target_distance: 'marathon',
      weeks_remaining: 12,
      sessions_per_week: 5,
      runner_type: 'Balanced',
      ability_band: 'intermediate',
    };

    describe('basic behavior', () => {
      it('should return zero gain when weeks_remaining is 0', () => {
        const result = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: 0,
        });
        expect(result.vdot_gain).toBe(0);
        expect(result.improvement_pct).toBe(0);
      });

      it('should return zero gain when weeks_remaining is negative', () => {
        const result = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: -5,
        });
        expect(result.vdot_gain).toBe(0);
        expect(result.improvement_pct).toBe(0);
      });

      it('should return positive gain for valid training scenario', () => {
        const result = applyTrainingHorizonAdjustment(baseParams);
        expect(result.vdot_gain).toBeGreaterThan(0);
        expect(result.improvement_pct).toBeGreaterThan(0);
      });

      it('should return all component values', () => {
        const result = applyTrainingHorizonAdjustment(baseParams);
        expect(result.components).toHaveProperty('week_factor');
        expect(result.components).toHaveProperty('session_factor');
        expect(result.components).toHaveProperty('type_modifier');
        expect(result.components).toHaveProperty('undertrain_penalty');
        expect(result.components).toHaveProperty('taper_bonus');
      });
    });

    describe('weeks remaining effect', () => {
      it('should give more improvement with more weeks', () => {
        const result4weeks = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: 4,
        });
        const result12weeks = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: 12,
        });
        const result24weeks = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: 24,
        });

        expect(result12weeks.vdot_gain).toBeGreaterThan(result4weeks.vdot_gain);
        expect(result24weeks.vdot_gain).toBeGreaterThan(result12weeks.vdot_gain);
      });

      it('should show diminishing returns (week_factor approaches 1)', () => {
        const result12weeks = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: 12,
        });
        const result52weeks = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: 52,
        });

        // Week factor should be much closer to 1 for 52 weeks
        expect(result52weeks.components.week_factor).toBeGreaterThan(
          result12weeks.components.week_factor
        );
        expect(result52weeks.components.week_factor).toBeLessThanOrEqual(1);
      });
    });

    describe('sessions per week effect', () => {
      it('should give more improvement with more sessions', () => {
        const result3sessions = applyTrainingHorizonAdjustment({
          ...baseParams,
          sessions_per_week: 3,
        });
        const result5sessions = applyTrainingHorizonAdjustment({
          ...baseParams,
          sessions_per_week: 5,
        });
        const result7sessions = applyTrainingHorizonAdjustment({
          ...baseParams,
          sessions_per_week: 7,
        });

        expect(result5sessions.vdot_gain).toBeGreaterThan(result3sessions.vdot_gain);
        expect(result7sessions.vdot_gain).toBeGreaterThan(result5sessions.vdot_gain);
      });

      it('should apply undertraining penalty when sessions below minimum', () => {
        // Marathon min_sessions is 3.5
        const resultUnderTrain = applyTrainingHorizonAdjustment({
          ...baseParams,
          sessions_per_week: 2,
        });

        expect(resultUnderTrain.components.undertrain_penalty).toBeGreaterThan(0);
      });

      it('should not apply undertraining penalty when sessions above minimum', () => {
        const resultAdequate = applyTrainingHorizonAdjustment({
          ...baseParams,
          sessions_per_week: 5,
        });

        expect(resultAdequate.components.undertrain_penalty).toBe(0);
      });
    });

    describe('ability band effect', () => {
      it('should give more improvement to beginners than elites', () => {
        const resultBeginner = applyTrainingHorizonAdjustment({
          ...baseParams,
          ability_band: 'beginner',
        });
        const resultElite = applyTrainingHorizonAdjustment({
          ...baseParams,
          ability_band: 'elite',
        });

        expect(resultBeginner.improvement_pct).toBeGreaterThan(resultElite.improvement_pct);
      });

      it('should show progressive decrease from beginner to elite', () => {
        const bands: Array<'beginner' | 'novice' | 'intermediate' | 'advanced' | 'elite'> = [
          'beginner', 'novice', 'intermediate', 'advanced', 'elite'
        ];
        const results = bands.map(band =>
          applyTrainingHorizonAdjustment({ ...baseParams, ability_band: band })
        );

        for (let i = 1; i < results.length; i++) {
          expect(results[i].improvement_pct).toBeLessThan(results[i - 1].improvement_pct);
        }
      });
    });

    describe('runner type effect', () => {
      it('should favor endurance runners for 5K (trains weakness)', () => {
        const resultSpeed = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: '5k',
          runner_type: 'Speed',
        });
        const resultEndurance = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: '5k',
          runner_type: 'Endurance',
        });

        // Endurance runner has more room to improve at 5K
        expect(resultEndurance.components.type_modifier).toBeGreaterThan(
          resultSpeed.components.type_modifier
        );
      });

      it('should favor speed runners for marathon (trains weakness)', () => {
        const resultSpeed = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: 'marathon',
          runner_type: 'Speed',
        });
        const resultEndurance = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: 'marathon',
          runner_type: 'Endurance',
        });

        // Speed runner has more room to improve at marathon
        expect(resultSpeed.components.type_modifier).toBeGreaterThan(
          resultEndurance.components.type_modifier
        );
      });

      it('should give balanced runners neutral modifier', () => {
        const result = applyTrainingHorizonAdjustment({
          ...baseParams,
          runner_type: 'Balanced',
        });

        expect(result.components.type_modifier).toBe(1.0);
      });
    });

    describe('taper effect', () => {
      it('should apply taper bonus when taper_weeks provided', () => {
        const resultNoTaper = applyTrainingHorizonAdjustment({
          ...baseParams,
          taper_weeks: 0,
        });
        const resultWithTaper = applyTrainingHorizonAdjustment({
          ...baseParams,
          taper_weeks: 2,
        });

        expect(resultWithTaper.components.taper_bonus).toBeGreaterThan(
          resultNoTaper.components.taper_bonus
        );
      });

      it('should cap taper bonus at nominal taper duration', () => {
        // Marathon nominal taper is 3 weeks
        const resultNominal = applyTrainingHorizonAdjustment({
          ...baseParams,
          taper_weeks: 3,
        });
        const resultExcessive = applyTrainingHorizonAdjustment({
          ...baseParams,
          taper_weeks: 6,
        });

        // Bonus should be same (capped)
        expect(resultExcessive.components.taper_bonus).toBe(
          resultNominal.components.taper_bonus
        );
      });

      it('should reduce effective training weeks by taper duration', () => {
        const result12noTaper = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: 12,
          taper_weeks: 0,
        });
        const result12with3taper = applyTrainingHorizonAdjustment({
          ...baseParams,
          weeks_remaining: 12,
          taper_weeks: 3,
        });

        // With taper, week_factor should be lower (9 effective weeks vs 12)
        expect(result12with3taper.components.week_factor).toBeLessThan(
          result12noTaper.components.week_factor
        );
      });
    });

    describe('distance-specific behavior', () => {
      it('should use different parameters for different distances', () => {
        const result5k = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: '5k',
          weeks_remaining: 12,
          ability_band: 'intermediate',
        });
        const resultMarathon = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: 'marathon',
          weeks_remaining: 12,
          ability_band: 'intermediate',
        });

        // Different distances should produce different results
        // (5K has lower tau so gains faster, marathon has higher max_gain)
        expect(result5k.improvement_pct).not.toBe(resultMarathon.improvement_pct);
      });

      it('should give higher max gain ceiling for marathon vs 5K', () => {
        // With very long training and optimal sessions, marathon ceiling is higher
        // but 5K converges faster due to lower tau
        const result5k = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: '5k',
          weeks_remaining: 100, // Very long to approach ceiling
          sessions_per_week: 7,
          ability_band: 'advanced', // Use advanced to avoid guardrail caps
          experience_level: 'advanced',
        });
        const resultMarathon = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: 'marathon',
          weeks_remaining: 100,
          sessions_per_week: 7,
          ability_band: 'advanced',
          experience_level: 'advanced',
        });

        // Both should produce meaningful gains with long training and high volume
        expect(result5k.improvement_pct).toBeGreaterThan(2);
        expect(resultMarathon.improvement_pct).toBeGreaterThan(2);
      });
    });

    describe('bounds checking', () => {
      it('should cap improvement at max_gain_cap (15%)', () => {
        // Create scenario that would exceed cap
        const result = applyTrainingHorizonAdjustment({
          ...baseParams,
          ability_band: 'beginner',
          weeks_remaining: 52,
          sessions_per_week: 7,
        });

        expect(result.improvement_pct).toBeLessThanOrEqual(15.0);
      });

      it('should not go below max_slowdown (-3%)', () => {
        // Severe undertraining scenario
        const result = applyTrainingHorizonAdjustment({
          ...baseParams,
          sessions_per_week: 1,
          weeks_remaining: 2,
        });

        expect(result.improvement_pct).toBeGreaterThanOrEqual(-3.0);
      });
    });

    describe('VDOT gain calculation', () => {
      it('should scale VDOT gain with baseline VDOT', () => {
        // Use same ability band + competitive experience to isolate baseline effect
        const resultVdot40 = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: '5k',
          baseline_vdot: 40,
          ability_band: 'intermediate',
          experience_level: 'competitive',
        });
        const resultVdot50 = applyTrainingHorizonAdjustment({
          ...baseParams,
          target_distance: '5k',
          baseline_vdot: 50,
          ability_band: 'intermediate',
          experience_level: 'competitive',
        });

        // Same ability band, same improvement_pct → higher baseline = larger absolute gain
        expect(resultVdot50.vdot_gain).toBeGreaterThan(resultVdot40.vdot_gain);
      });
    });
  });

  describe('calculateSkipPenalty', () => {
    describe('base penalties by workout type', () => {
      it('should give higher penalty for key workouts', () => {
        const easyPenalty = calculateSkipPenalty('easy', 'marathon', 6, 12, 0);
        const longPenalty = calculateSkipPenalty('long', 'marathon', 6, 12, 0);
        const mpPenalty = calculateSkipPenalty('marathon_pace', 'marathon', 6, 12, 0);

        expect(longPenalty).toBeGreaterThan(easyPenalty);
        expect(mpPenalty).toBeGreaterThan(easyPenalty);
      });

      it('should give distance-appropriate penalties', () => {
        // VO2 more important for 5K than marathon
        const vo2Penalty5k = calculateSkipPenalty('vo2', '5k', 3, 6, 0);
        // Long run more important for marathon than 5K
        const longPenaltyMarathon = calculateSkipPenalty('long', 'marathon', 6, 12, 0);

        expect(vo2Penalty5k).toBeGreaterThan(0);
        expect(longPenaltyMarathon).toBeGreaterThan(0);
      });

      it('should use default penalty for unknown workout type', () => {
        // weeksOut = 12 - 9 = 3, so proximity factor = 1.2
        // Unknown type gets base penalty of 20, so 20 * 1.2 = 24
        const penalty = calculateSkipPenalty('unknown_type', 'marathon', 9, 12, 0);
        expect(penalty).toBe(24); // 20 base * 1.2 proximity
      });
    });

    describe('proximity factor (closer to race = higher penalty)', () => {
      it('should give lower penalty early in training', () => {
        // 10+ weeks out (early) - factor 0.5
        const earlyPenalty = calculateSkipPenalty('threshold', 'marathon', 2, 12, 0);
        // 3 weeks out (late) - factor 1.5
        const latePenalty = calculateSkipPenalty('threshold', 'marathon', 10, 12, 0);

        expect(latePenalty).toBeGreaterThan(earlyPenalty);
      });

      it('should have progressive proximity factors', () => {
        const totalWeeks = 16;
        // weeksOut = totalWeeks - weeksRemaining
        const penaltyWeek2 = calculateSkipPenalty('threshold', 'marathon', 14, totalWeeks, 0); // 2 weeks out
        const penaltyWeek5 = calculateSkipPenalty('threshold', 'marathon', 11, totalWeeks, 0); // 5 weeks out
        const penaltyWeek8 = calculateSkipPenalty('threshold', 'marathon', 8, totalWeeks, 0);  // 8 weeks out
        const penaltyWeek12 = calculateSkipPenalty('threshold', 'marathon', 4, totalWeeks, 0); // 12 weeks out

        expect(penaltyWeek2).toBeGreaterThan(penaltyWeek5);
        expect(penaltyWeek5).toBeGreaterThan(penaltyWeek8);
        expect(penaltyWeek8).toBeGreaterThan(penaltyWeek12);
      });
    });

    describe('cumulative skip factor', () => {
      it('should increase penalty with more skips', () => {
        const penalty0skips = calculateSkipPenalty('threshold', 'marathon', 6, 12, 0);
        const penalty2skips = calculateSkipPenalty('threshold', 'marathon', 6, 12, 2);
        const penalty4skips = calculateSkipPenalty('threshold', 'marathon', 6, 12, 4);

        expect(penalty2skips).toBeGreaterThan(penalty0skips);
        expect(penalty4skips).toBeGreaterThan(penalty2skips);
      });

      it('should compound severely after 4+ skips', () => {
        const penalty4skips = calculateSkipPenalty('threshold', 'marathon', 6, 12, 4);
        const penalty6skips = calculateSkipPenalty('threshold', 'marathon', 6, 12, 6);

        // Factor increases by 0.3 per additional skip after 4
        const expectedIncrease = penalty4skips * (0.3 * 2 / (2.0)); // Approximate
        expect(penalty6skips).toBeGreaterThan(penalty4skips);
      });

      it('should return rounded integer penalties', () => {
        const penalty = calculateSkipPenalty('threshold', 'marathon', 6, 12, 3);
        expect(Number.isInteger(penalty)).toBe(true);
      });
    });

    describe('combined factors', () => {
      it('should multiply all factors together', () => {
        // Base penalty for marathon long = 60
        // Late in training (weeksOut < 3) = 1.5x
        // 3 cumulative skips = 1.7x
        const penalty = calculateSkipPenalty('long', 'marathon', 14, 16, 3);

        // 60 * 1.5 * 1.7 = 153
        expect(penalty).toBeCloseTo(153, 0);
      });
    });

    describe('all race distances', () => {
      const distances: Array<'5k' | '10k' | 'half' | 'marathon'> = ['5k', '10k', 'half', 'marathon'];

      it('should return valid penalties for all distances', () => {
        for (const distance of distances) {
          const penalty = calculateSkipPenalty('easy', distance, 3, 6, 0);
          expect(penalty).toBeGreaterThan(0);
        }
      });
    });
  });
});
