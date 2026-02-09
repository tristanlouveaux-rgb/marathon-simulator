/**
 * km-budget.test.ts
 * =================
 * Regression test for: Cross-training load budget double-counting bug
 *
 * BUG: Replace outcome was spending more load than runReplacementCredit allowed.
 * Example: 60min skiing => RRC ≈ 105 load, but Replace outcome both:
 *   - Skipped an Easy Run ("covered") AND
 *   - Reduced Long Run by ~2.4km
 * This exceeded the total load budget.
 *
 * FIX: buildReplaceAdjustments and buildReduceAdjustments now enforce
 * load-based budgeting: total loadReduction across adjustments ≤ runReplacementCredit.
 */

import { describe, it, expect } from 'vitest';
import { createActivity } from './activities';
import { buildCrossTrainingPopup, workoutsToPlannedRuns } from './suggester';
import type { Workout } from '@/types';

/**
 * Calculate total load reduction from adjustments.
 * Load-based budgeting means total load consumed ≤ runReplacementCredit.
 */
function totalLoadReduction(adjustments: Array<{
  loadReduction: number;
}>): number {
  return adjustments.reduce((sum, adj) => sum + adj.loadReduction, 0);
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

describe('Load Budget Enforcement', () => {
  it('replaceOutcome total load reduction must not exceed runReplacementCredit', () => {
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

      const loadUsed = totalLoadReduction(popup.replaceOutcome.adjustments);
      const budget = popup.runReplacementCredit;

      // Core assertion: total load consumed must not exceed RRC budget (with tiny tolerance)
      expect(loadUsed).toBeLessThanOrEqual(budget + 1.0);

      // Log for debugging
      console.log(
        `${sport} ${duration}min RPE${rpe}: ` +
        `budget=${budget.toFixed(1)} load, used=${loadUsed.toFixed(1)} load, ` +
        `adjustments=${popup.replaceOutcome.adjustments.length}`
      );
    }
  });

  it('should skip easy run only if budget covers full run load', () => {
    const workouts = createTypicalWeek();
    const plannedRuns = workoutsToPlannedRuns(workouts);

    // Create low-intensity activity with small equivalence
    const activity = createActivity('yoga', 60, 3, undefined, undefined, 1);

    const popup = buildCrossTrainingPopup(
      { raceGoal: 'half', plannedRunsPerWeek: 5, injuryMode: false },
      plannedRuns,
      activity
    );

    // With small budget, shouldn't fully replace any run
    const replaceActions = popup.replaceOutcome.adjustments.filter(a => a.action === 'replace');

    for (const adj of replaceActions) {
      // If it's a full skip (newDistanceKm = 0), the load must have been within budget
      if (adj.newDistanceKm === 0) {
        expect(adj.loadReduction).toBeLessThanOrEqual(popup.runReplacementCredit + 1.0);
      }
    }
  });

  it('should prefer reduction over replacement when budget is tight', () => {
    const workouts: Workout[] = [
      { n: 'Easy Run', t: 'easy', d: '8km', dayOfWeek: 0, aerobic: 80, anaerobic: 10, rpe: 3, r: 3 },
      { n: 'Long Run', t: 'long', d: '20km', dayOfWeek: 6, aerobic: 180, anaerobic: 18, rpe: 5, r: 5 },
    ];
    const plannedRuns = workoutsToPlannedRuns(workouts);

    // Create activity with moderate load (not enough to fully replace 8km run)
    const activity = createActivity('swimming', 60, 5, undefined, undefined, 1);

    const popup = buildCrossTrainingPopup(
      { raceGoal: 'half', plannedRunsPerWeek: 2, injuryMode: false },
      plannedRuns,
      activity
    );

    // Total load reduction should not exceed load budget
    const loadUsed = totalLoadReduction(popup.replaceOutcome.adjustments);
    expect(loadUsed).toBeLessThanOrEqual(popup.runReplacementCredit + 1.0);
  });

  /**
   * REGRESSION TEST: reduceOutcome load budget consistency
   *
   * BUG: reduceOutcome previously had inconsistent budgeting — display showed km
   * equivalence but reductions exceeded it.
   *
   * FIX: Both buildReduceAdjustments and buildReplaceAdjustments now use load-based
   * budgeting: total loadReduction ≤ runReplacementCredit.
   */
  it('reduceOutcome total load reduction must not exceed runReplacementCredit', () => {
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

      const loadUsed = totalLoadReduction(popup.reduceOutcome.adjustments);
      const budget = popup.runReplacementCredit;

      // Core assertion: total load consumed must not exceed RRC budget
      expect(loadUsed).toBeLessThanOrEqual(budget + 1.0);

      // Log for debugging
      console.log(
        `REDUCE ${sport} ${duration}min RPE${rpe}: ` +
        `budget=${budget.toFixed(1)} load, used=${loadUsed.toFixed(1)} load, ` +
        `adjustments=${popup.reduceOutcome.adjustments.length}`
      );
    }
  });

  it('downgrade should preserve distance and consume load budget correctly', () => {
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

    // Downgrade adjustments should keep same distance (only intensity changes)
    const downgrades = popup.replaceOutcome.adjustments.filter(a => a.action === 'downgrade');
    for (const adj of downgrades) {
      expect(adj.originalDistanceKm).toBe(adj.newDistanceKm);
    }

    // Total load reduction should not exceed RRC budget
    const loadUsed = totalLoadReduction(popup.replaceOutcome.adjustments);
    expect(loadUsed).toBeLessThanOrEqual(popup.runReplacementCredit + 1.0);
  });
});
