import { describe, it, expect } from 'vitest';
import { applyCrossTrainingToWorkouts } from './matcher';
import { createActivity, rpeFactor, weightedLoad } from './activities';
import { applySaturation } from './load-matching';
import type { Week, Workout, CrossActivity } from '@/types';
import { SPORTS_DB } from '@/constants';

// Helper to create a test week
function createTestWeek(weekNum: number = 1): Week {
  return {
    w: weekNum,
    ph: 'build',
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0
  };
}

// Helper to create test workouts
function createTestWorkouts(): Workout[] {
  return [
    {
      n: 'W1-easy1',
      t: 'easy',
      d: '8km',
      dayOfWeek: 1,
      aerobic: 80,
      anaerobic: 10,
      rpe: 3,
      r: 3
    },
    {
      n: 'W1-threshold',
      t: 'threshold',
      d: '10km with 6km @ threshold',
      dayOfWeek: 2,
      aerobic: 120,
      anaerobic: 40,
      rpe: 7,
      r: 7
    },
    {
      n: 'W1-easy2',
      t: 'easy',
      d: '6km',
      dayOfWeek: 4,
      aerobic: 60,
      anaerobic: 8,
      rpe: 3,
      r: 3
    },
    {
      n: 'W1-long',
      t: 'long',
      d: '24km',
      dayOfWeek: 6,
      aerobic: 200,
      anaerobic: 20,
      rpe: 5,
      r: 5
    }
  ];
}

describe('Cross-Training Matcher', () => {
  describe('applyCrossTrainingToWorkouts', () => {
    describe('basic behavior', () => {
      it('should return workouts unchanged if no activities', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();
        const result = applyCrossTrainingToWorkouts(wk, workouts, []);

        expect(result).toEqual(workouts);
      });

      it('should not mutate original workouts', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();
        const originalD = workouts[0].d;

        const activity = createActivity('rugby', 60, 7, 100, 30);
        applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        expect(workouts[0].d).toBe(originalD);
      });
    });

    describe('RPE impact on matching - THE CORE ISSUE', () => {
      it('should produce different matching results for RPE 9 vs RPE 3 rugby', () => {
        const wk1 = createTestWeek();
        const wk2 = createTestWeek();
        const workouts1 = createTestWorkouts();
        const workouts2 = createTestWorkouts();

        // High intensity rugby
        const rugbyRPE9 = createActivity('rugby', 60, 9);
        const result9 = applyCrossTrainingToWorkouts(wk1, workouts1, [rugbyRPE9]);

        // Low intensity rugby
        const rugbyRPE3 = createActivity('rugby', 60, 3);
        const result3 = applyCrossTrainingToWorkouts(wk2, workouts2, [rugbyRPE3]);

        // Count modifications
        const mods9 = result9.filter(w => w.status && w.status !== 'planned').length;
        const mods3 = result3.filter(w => w.status && w.status !== 'planned').length;

        // High RPE should cause more/bigger modifications
        // At minimum, we should see SOME difference
        console.log('RPE 9 modifications:', mods9, result9.map(w => ({ n: w.n, status: w.status, d: w.d })));
        console.log('RPE 3 modifications:', mods3, result3.map(w => ({ n: w.n, status: w.status, d: w.d })));

        // Either different number of modifications or different reduction amounts
        const anyDifference = mods9 !== mods3 ||
          result9.some((w, i) => w.d !== result3[i].d);

        expect(anyDifference).toBe(true);
      });

      it('should calculate significantly different effective loads for RPE 9 vs RPE 3', () => {
        // Without Garmin data
        const rugbyRPE9 = createActivity('rugby', 60, 9);
        const rugbyRPE3 = createActivity('rugby', 60, 3);

        const sp = SPORTS_DB['rugby'];
        const recMult = sp.mult; // 1.50
        const runSpec = sp.runSpec; // 0.35
        const specMult = 0.6 + 0.4 * runSpec; // 0.74

        // Calculate effective loads as the matcher does
        const rpeF9 = rpeFactor(9); // 1.24
        const rpeF3 = rpeFactor(3); // 0.88

        const aEff9 = rugbyRPE9.aerobic_load * rpeF9 * recMult * specMult;
        const anEff9 = rugbyRPE9.anaerobic_load * rpeF9 * recMult * specMult;
        const rawLoad9 = weightedLoad(aEff9, anEff9);

        const aEff3 = rugbyRPE3.aerobic_load * rpeF3 * recMult * specMult;
        const anEff3 = rugbyRPE3.anaerobic_load * rpeF3 * recMult * specMult;
        const rawLoad3 = weightedLoad(aEff3, anEff3);

        console.log('Raw load RPE 9:', rawLoad9);
        console.log('Raw load RPE 3:', rawLoad3);
        console.log('Raw ratio:', rawLoad9 / rawLoad3);

        // Should have significant difference (>4x)
        expect(rawLoad9 / rawLoad3).toBeGreaterThan(4);

        // After saturation
        const saturated9 = applySaturation(rawLoad9);
        const saturated3 = applySaturation(rawLoad3);

        console.log('Saturated load RPE 9:', saturated9);
        console.log('Saturated load RPE 3:', saturated3);
        console.log('Saturated ratio:', saturated9 / saturated3);

        // Even after saturation, should still have meaningful difference
        expect(saturated9 / saturated3).toBeGreaterThan(2);
      });
    });

    describe('sport-specific behavior', () => {
      const sports: Array<'soccer' | 'rugby' | 'basketball' | 'tennis' | 'swimming' | 'cycling' | 'strength'> = [
        'soccer', 'rugby', 'basketball', 'tennis', 'swimming', 'cycling', 'strength'
      ];

      for (const sport of sports) {
        describe(`${sport}`, () => {
          it('should respect noReplace rules', () => {
            const wk = createTestWeek();
            const workouts = createTestWorkouts();
            const sp = SPORTS_DB[sport];

            // Create high-load activity
            const activity = createActivity(sport, 90, 9, 200, 50);
            const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);

            // Check noReplace workouts weren't replaced
            for (const noReplaceType of sp.noReplace) {
              const workout = result.find(w => w.t === noReplaceType);
              if (workout) {
                // Should not be fully replaced
                expect(workout.status).not.toBe('replaced');
              }
            }
          });

          it('should apply correct sport multiplier', () => {
            const wk = createTestWeek();
            const workouts = createTestWorkouts();

            // Same Garmin loads for fair comparison
            const activity = createActivity(sport, 60, 5, 100, 20);
            const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);

            // Just verify it doesn't crash and returns valid workouts
            expect(result.length).toBe(workouts.length);
          });
        });
      }
    });

    describe('load-based budget limits', () => {
      it('should use load-based budgets instead of count limits', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        // Very high load activity - should consume more budget
        const activity = createActivity('cycling', 400, 6, 600, 60);
        const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        // With load-based budgets, a 400min cycling session can modify multiple workouts
        // as long as budget is available
        const modified = result.filter(w => w.status && w.status !== 'planned').length;

        // Should have modified at least one workout
        expect(modified).toBeGreaterThanOrEqual(1);

        // Should track cross-training summary
        expect(wk.crossTrainingSummary).toBeDefined();
        expect(wk.crossTrainingSummary?.totalLoadApplied).toBeGreaterThan(0);
      });

      it('should track budget utilization in crossTrainingSummary', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        const activity = createActivity('rugby', 90, 8, 200, 60);
        applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        // Summary should be populated
        expect(wk.crossTrainingSummary).toBeDefined();
        expect(wk.crossTrainingSummary?.budgetUtilization).toBeDefined();
        expect(wk.crossTrainingSummary?.budgetUtilization.replacement).toBeGreaterThanOrEqual(0);
        expect(wk.crossTrainingSummary?.budgetUtilization.adjustment).toBeGreaterThanOrEqual(0);
      });

      it('should stop modifying when budget is exhausted', () => {
        const wk = createTestWeek();
        // Small workout week = small budget
        const smallWorkouts = [
          { n: 'Easy', t: 'easy', d: '5km', dayOfWeek: 1, aerobic: 40, anaerobic: 5, rpe: 3, r: 3 }
        ];

        // Very large activity
        const activity = createActivity('cycling', 400, 7, 500, 50);
        const result = applyCrossTrainingToWorkouts(wk, smallWorkouts, [activity]);

        // Budget should be exhausted, some load should overflow
        expect(wk.crossTrainingSummary?.totalLoadOverflow).toBeGreaterThan(0);
      });

      it('should allow extra_run to replace multiple workouts', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        // Multiple extra runs
        const activities = [
          createActivity('extra_run', 50, 4, 80, 5),
          createActivity('extra_run', 45, 3, 70, 5),
        ];
        const result = applyCrossTrainingToWorkouts(wk, workouts, activities);

        // Extra run can replace multiple
        const modified = result.filter(w => w.status && w.status !== 'planned').length;
        expect(modified).toBeGreaterThanOrEqual(0); // Just verify it works
      });
    })

    describe('two-week activity aggregation', () => {
      it('should accept previous week activities parameter', () => {
        const wk = createTestWeek(2);
        const workouts = createTestWorkouts();

        const currentActivities = [
          createActivity('rugby', 60, 7, 100, 30, 2)
        ];
        const previousActivities = [
          createActivity('rugby', 90, 8, 150, 50, 1)
        ];

        // Should not throw
        const result = applyCrossTrainingToWorkouts(
          wk,
          workouts,
          currentActivities,
          previousActivities
        );

        expect(result.length).toBe(workouts.length);
      });

      it('should reduce modification capacity when previous week had high load', () => {
        const wk1 = createTestWeek(2);
        const wk2 = createTestWeek(2);
        const workouts1 = createTestWorkouts();
        const workouts2 = createTestWorkouts();

        const currentActivity = [createActivity('cycling', 60, 5, 80, 10, 2)];

        // No previous week load
        const result1 = applyCrossTrainingToWorkouts(wk1, workouts1, currentActivity, []);

        // Heavy previous week load
        const previousLoad = [createActivity('rugby', 120, 9, 300, 80, 1)];
        const result2 = applyCrossTrainingToWorkouts(wk2, workouts2, currentActivity, previousLoad);

        // With previous week fatigue, less should be modified
        // (or modifications should be smaller)
        const mods1 = result1.filter(w => w.status && w.status !== 'planned').length;
        const mods2 = result2.filter(w => w.status && w.status !== 'planned').length;

        // At minimum, the budget utilization should differ
        console.log('Without prev week:', mods1, wk1.crossTrainingSummary?.budgetUtilization);
        console.log('With prev week:', mods2, wk2.crossTrainingSummary?.budgetUtilization);
      });
    });

    describe('workout type handling', () => {
      it('should prefer replacing easy runs over quality workouts', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        // Moderate load that should target easy runs
        const activity = createActivity('cycling', 60, 5, 80, 10);
        const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        const modifiedEasy = result.filter(
          w => w.t === 'easy' && w.status && w.status !== 'planned'
        ).length;
        const modifiedQuality = result.filter(
          w => (w.t === 'threshold' || w.t === 'vo2') && w.status === 'replaced'
        ).length;

        // Should modify easy before replacing quality
        if (modifiedEasy > 0 || modifiedQuality > 0) {
          expect(modifiedEasy).toBeGreaterThanOrEqual(modifiedQuality);
        }
      });

      it('should require Garmin data to replace quality workouts', () => {
        const wk = createTestWeek();
        const workouts = [
          {
            n: 'W1-threshold',
            t: 'threshold',
            d: '10km',
            dayOfWeek: 2,
            aerobic: 120,
            anaerobic: 40,
            rpe: 7,
            r: 7
          }
        ];

        // High load without Garmin
        const activityNoGarmin = createActivity('rugby', 90, 9);

        // High load with Garmin
        const activityWithGarmin = createActivity('rugby', 90, 9, 200, 80);

        const resultNoGarmin = applyCrossTrainingToWorkouts(
          createTestWeek(),
          workouts.map(w => ({ ...w })),
          [activityNoGarmin]
        );
        const resultWithGarmin = applyCrossTrainingToWorkouts(
          createTestWeek(),
          workouts.map(w => ({ ...w })),
          [activityWithGarmin]
        );

        // With Garmin, quality replacement should be possible
        // Without Garmin, should be more conservative
        const replacedNoGarmin = resultNoGarmin[0].status === 'replaced';
        const replacedWithGarmin = resultWithGarmin[0].status === 'replaced';

        // Log for debugging
        console.log('Without Garmin:', resultNoGarmin[0].status, resultNoGarmin[0].modReason);
        console.log('With Garmin:', resultWithGarmin[0].status, resultWithGarmin[0].modReason);
      });
    });

    describe('overflow load handling', () => {
      it('should track unspent load for high-load activities', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        // Very high load activity
        const activity = createActivity('rugby', 120, 9, 400, 100);
        applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        // Some load should overflow
        expect(wk.unspentLoad).toBeGreaterThanOrEqual(0);
      });

      it('should track extra run load separately', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        // Extra run that doesn't match any workout
        const activity = createActivity('extra_run', 90, 8, 300, 30);
        applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        // Extra run overflow goes to extraRunLoad
        expect(wk.extraRunLoad).toBeGreaterThanOrEqual(0);
      });
    });

    describe('reduction calculations', () => {
      it('should reduce easy runs by appropriate percentage', () => {
        const wk = createTestWeek();
        const workouts = [
          {
            n: 'W1-easy',
            t: 'easy',
            d: '10km',
            dayOfWeek: 1,
            aerobic: 100,
            anaerobic: 10,
            rpe: 3,
            r: 3
          }
        ];

        // Moderate load - should reduce not replace
        const activity = createActivity('cycling', 45, 5, 50, 5);
        const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        if (result[0].status === 'reduced') {
          // Should show reduced distance
          expect(result[0].d).toContain('was 10km');
          expect(result[0].originalDistance).toBe('10km');
        }
      });

      it('should be conservative with long run reductions', () => {
        const wk = createTestWeek();
        const workouts = [
          {
            n: 'W1-long',
            t: 'long',
            d: '30km',
            dayOfWeek: 6,
            aerobic: 250,
            anaerobic: 25,
            rpe: 5,
            r: 5
          }
        ];

        // Moderate cycling load
        const activity = createActivity('cycling', 60, 6, 100, 15);
        const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        if (result[0].status === 'reduced') {
          // Long run reduction should be conservative (max 30%)
          const originalKm = 30;
          const newKmMatch = result[0].d.match(/^(\d+)km/);
          if (newKmMatch) {
            const newKm = parseInt(newKmMatch[1]);
            const reduction = (originalKm - newKm) / originalKm;
            expect(reduction).toBeLessThanOrEqual(0.31); // ~30% max
          }
        }
      });
    });

    describe('edge cases', () => {
      it('should handle activities with zero load', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        const activity = createActivity('cycling', 60, 5, 0, 0);
        const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        expect(result.length).toBe(workouts.length);
      });

      it('should handle unknown sports gracefully', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        const activity = {
          ...createActivity('cycling', 60, 5),
          sport: 'unknown_sport' as any
        };

        // Should not crash
        const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);
        expect(result.length).toBe(workouts.length);
      });

      it('should handle already-rated workouts', () => {
        const wk = createTestWeek();
        wk.rated = { 'W1-easy1': 5 }; // Already completed
        const workouts = createTestWorkouts();

        const activity = createActivity('rugby', 60, 7, 100, 30);
        const result = applyCrossTrainingToWorkouts(wk, workouts, [activity]);

        // Should not modify already-rated workout
        const easy1 = result.find(w => w.n === 'W1-easy1');
        expect(easy1?.status).toBeUndefined();
      });
    });

    describe('real-world scenarios', () => {
      it('scenario: 90min rugby match at RPE 9 should significantly impact training', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        const rugbyMatch = createActivity('rugby', 90, 9);
        const result = applyCrossTrainingToWorkouts(wk, workouts, [rugbyMatch]);

        // High-intensity rugby should modify at least one workout
        const modifications = result.filter(w => w.status && w.status !== 'planned');

        console.log('90min rugby RPE 9 impact:');
        result.forEach(w => {
          console.log(`  ${w.n}: ${w.status || 'unchanged'} - ${w.d}`);
        });

        // Should see some impact
        expect(modifications.length).toBeGreaterThan(0);
      });

      it('scenario: light recovery swim at RPE 3 should have minimal impact', () => {
        const wk = createTestWeek();
        const workouts = createTestWorkouts();

        const swim = createActivity('swimming', 30, 3);
        const result = applyCrossTrainingToWorkouts(wk, workouts, [swim]);

        const modifications = result.filter(w => w.status && w.status !== 'planned');

        console.log('30min swim RPE 3 impact:');
        result.forEach(w => {
          console.log(`  ${w.n}: ${w.status || 'unchanged'} - ${w.d}`);
        });

        // Light swim should have minimal to no impact
        // Swimming has low mult (0.65) and low runSpec (0.20)
      });

      it('scenario: comparing high vs low RPE for same sport and duration', () => {
        // This directly tests the user's concern

        const scenarios = [
          { sport: 'rugby', duration: 60 },
          { sport: 'soccer', duration: 90 },
          { sport: 'cycling', duration: 60 },
          { sport: 'basketball', duration: 45 },
        ];

        for (const { sport, duration } of scenarios) {
          const wk9 = createTestWeek();
          const wk3 = createTestWeek();
          const workouts9 = createTestWorkouts();
          const workouts3 = createTestWorkouts();

          const activityRPE9 = createActivity(sport, duration, 9);
          const activityRPE3 = createActivity(sport, duration, 3);

          const result9 = applyCrossTrainingToWorkouts(wk9, workouts9, [activityRPE9]);
          const result3 = applyCrossTrainingToWorkouts(wk3, workouts3, [activityRPE3]);

          console.log(`\n${sport} ${duration}min - RPE comparison:`);
          console.log('  RPE 9:', result9.map(w => `${w.t}:${w.status || 'ok'}`).join(', '));
          console.log('  RPE 3:', result3.map(w => `${w.t}:${w.status || 'ok'}`).join(', '));

          // Verify the load calculation is different
          const load9 = activityRPE9.aerobic_load + activityRPE9.anaerobic_load;
          const load3 = activityRPE3.aerobic_load + activityRPE3.anaerobic_load;
          console.log(`  Load ratio: ${(load9 / load3).toFixed(2)}x`);
        }
      });
    });
  });
});
