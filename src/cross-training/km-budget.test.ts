/**
 * km-budget.test.ts
 * =================
 * Regression test for: Cross-training equivalent km double-counting bug
 *
 * BUG: Replace outcome was spending more km than equivalentEasyKm allowed.
 * Example: 60min skiing => equivalentEasyKm ≈ 2.7km, but Replace outcome both:
 *   - Skipped an Easy Run ("covered") AND
 *   - Reduced Long Run by ~2.4km
 * This exceeded the 2.7km total budget.
 *
 * FIX: buildReplaceAdjustments now enforces km-based budgeting.
 */

import { describe, it, expect } from 'vitest';
import { createActivity } from './activities';
import { buildCrossTrainingPopup, workoutsToPlannedRuns } from './suggester';
import type { Workout } from '@/types';

/**
 * Calculate total km impact from adjustments
 * - replace: originalDistanceKm - newDistanceKm (full skip = originalDistanceKm)
 * - reduce: originalDistanceKm - newDistanceKm
 * - downgrade: 0 (no km change, just intensity)
 */
function totalKmImpact(adjustments: Array<{
  action: string;
  originalDistanceKm: number;
  newDistanceKm: number;
}>): number {
  return adjustments.reduce((sum, adj) => {
    if (adj.action === 'downgrade') {
      return sum; // Downgrade doesn't reduce km
    }
    return sum + (adj.originalDistanceKm - adj.newDistanceKm);
  }, 0);
}

// Test workouts with typical weekly plan
function createTypicalWeek(): Workout[] {
  return [
    { n: 'Easy Run', t: 'easy', d: '6km', dayOfWeek: 0, aerobic: 60, anaerobic: 8, rpe: 3, r: 3 },
    { n: 'Threshold Tempo', t: 'threshold', d: '8km', dayOfWeek: 1, aerobic: 100, anaerobic: 30, rpe: 7, r: 7 },
    { n: 'Easy Run', t: 'easy', d: '8km', dayOfWeek: 2, aerobic: 80, anaerobic: 10, rpe: 3, r: 3 },
    { n: 'Easy Run', t: 'easy', d: '5km', dayOfWeek: 4, aerobic: 50, anaerobic: 6, rpe: 3, r: 3 },
    { n: 'Long Run', t: 'long', d: '18km', dayOfWeek: 6, aerobic: 160, anaerobic: 16, rpe: 5, r: 5 },
  ];
}

describe('Km Budget Enforcement', () => {
  it('replaceOutcome total km impact must not exceed equivalentEasyKm + 0.1', () => {
    // Test with various activities of different intensities
    const testCases = [
      { sport: 'skiing', duration: 60, rpe: 5 },
      { sport: 'boxing', duration: 90, rpe: 7 },
      { sport: 'swimming', duration: 45, rpe: 4 },
      { sport: 'cycling', duration: 120, rpe: 6 },
      { sport: 'hiking', duration: 180, rpe: 3 },
      { sport: 'tennis', duration: 60, rpe: 6 },
    ];

    for (const { sport, duration, rpe } of testCases) {
      const workouts = createTypicalWeek();
      const plannedRuns = workoutsToPlannedRuns(workouts);
      const activity = createActivity(sport, duration, rpe, undefined, undefined, 1);

      const popup = buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 5, injuryMode: false },
        plannedRuns,
        activity
      );

      const kmImpact = totalKmImpact(popup.replaceOutcome.adjustments);
      const budget = popup.equivalentEasyKm;

      // Core assertion: total km impact must not exceed budget (with tiny tolerance)
      expect(kmImpact).toBeLessThanOrEqual(budget + 0.1);

      // Log for debugging
      console.log(
        `${sport} ${duration}min RPE${rpe}: ` +
        `budget=${budget.toFixed(1)}km, impact=${kmImpact.toFixed(1)}km, ` +
        `adjustments=${popup.replaceOutcome.adjustments.length}`
      );
    }
  });

  it('should skip easy run only if budget covers full distance', () => {
    const workouts = createTypicalWeek();
    const plannedRuns = workoutsToPlannedRuns(workouts);

    // Create low-intensity activity with small equivalence (~2-3km)
    const activity = createActivity('yoga', 60, 3, undefined, undefined, 1);

    const popup = buildCrossTrainingPopup(
      { raceGoal: 'half', plannedRunsPerWeek: 5, injuryMode: false },
      plannedRuns,
      activity
    );

    // With small budget, shouldn't fully replace any run
    const replaceActions = popup.replaceOutcome.adjustments.filter(a => a.action === 'replace');

    for (const adj of replaceActions) {
      // If it's a full skip (newDistanceKm = 0), the budget must have covered it
      if (adj.newDistanceKm === 0) {
        expect(adj.originalDistanceKm).toBeLessThanOrEqual(popup.equivalentEasyKm + 0.1);
      }
    }
  });

  it('should prefer reduction over replacement when budget is tight', () => {
    const workouts: Workout[] = [
      { n: 'Easy Run', t: 'easy', d: '8km', dayOfWeek: 0, aerobic: 80, anaerobic: 10, rpe: 3, r: 3 },
      { n: 'Long Run', t: 'long', d: '20km', dayOfWeek: 6, aerobic: 180, anaerobic: 18, rpe: 5, r: 5 },
    ];
    const plannedRuns = workoutsToPlannedRuns(workouts);

    // Create activity with ~4km equivalence (not enough to skip 8km run)
    const activity = createActivity('swimming', 60, 5, undefined, undefined, 1);

    const popup = buildCrossTrainingPopup(
      { raceGoal: 'half', plannedRunsPerWeek: 2, injuryMode: false },
      plannedRuns,
      activity
    );

    // Should reduce rather than try to skip
    const kmImpact = totalKmImpact(popup.replaceOutcome.adjustments);
    expect(kmImpact).toBeLessThanOrEqual(popup.equivalentEasyKm + 0.1);
  });

  /**
   * REGRESSION TEST: reduceOutcome km budget consistency
   *
   * BUG: reduceOutcome used load-based budgeting but display showed km-based equivalence.
   * Example: "120min hiking ≈ 1.7km easy" but reductions totaled 5.1km (3km + 2.1km).
   *
   * FIX: buildReduceAdjustments now uses km-based budgeting like buildReplaceAdjustments.
   */
  it('reduceOutcome total km impact must not exceed equivalentEasyKm + 0.1', () => {
    const testCases = [
      { sport: 'hiking', duration: 120, rpe: 3 },
      { sport: 'yoga', duration: 60, rpe: 2 },
      { sport: 'walking', duration: 90, rpe: 2 },
      { sport: 'swimming', duration: 45, rpe: 4 },
    ];

    for (const { sport, duration, rpe } of testCases) {
      const workouts = createTypicalWeek();
      const plannedRuns = workoutsToPlannedRuns(workouts);
      const activity = createActivity(sport, duration, rpe, undefined, undefined, 1);

      const popup = buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 5, injuryMode: false },
        plannedRuns,
        activity
      );

      const kmImpact = totalKmImpact(popup.reduceOutcome.adjustments);
      const budget = popup.equivalentEasyKm;

      // Core assertion: total km impact must not exceed budget (with tiny tolerance)
      expect(kmImpact).toBeLessThanOrEqual(budget + 0.1);

      // Log for debugging
      console.log(
        `REDUCE ${sport} ${duration}min RPE${rpe}: ` +
        `budget=${budget.toFixed(1)}km, impact=${kmImpact.toFixed(1)}km, ` +
        `adjustments=${popup.reduceOutcome.adjustments.length}`
      );
    }
  });

  it('downgrade should not consume km budget', () => {
    const workouts: Workout[] = [
      { n: 'Threshold Tempo', t: 'threshold', d: '10km', dayOfWeek: 1, aerobic: 120, anaerobic: 40, rpe: 7, r: 7 },
      { n: 'Long Run', t: 'long', d: '18km', dayOfWeek: 6, aerobic: 160, anaerobic: 16, rpe: 5, r: 5 },
    ];
    const plannedRuns = workoutsToPlannedRuns(workouts);

    // Moderate activity
    const activity = createActivity('cycling', 90, 6, undefined, undefined, 1);

    const popup = buildCrossTrainingPopup(
      { raceGoal: 'half', plannedRunsPerWeek: 2, injuryMode: false },
      plannedRuns,
      activity
    );

    // Downgrade adjustments should have originalDistanceKm === newDistanceKm
    const downgrades = popup.replaceOutcome.adjustments.filter(a => a.action === 'downgrade');
    for (const adj of downgrades) {
      expect(adj.originalDistanceKm).toBe(adj.newDistanceKm);
    }

    // Total km impact should only come from non-downgrade adjustments
    const kmImpact = totalKmImpact(popup.replaceOutcome.adjustments);
    expect(kmImpact).toBeLessThanOrEqual(popup.equivalentEasyKm + 0.1);
  });
});
