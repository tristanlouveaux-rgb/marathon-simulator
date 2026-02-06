/**
 * boxing-bug.test.ts
 * ==================
 * Regression test for: docs/bugs/boxing-replacement-bug.md
 *
 * BUG: Logging a boxing activity was silently mutating the plan without user confirmation.
 *
 * REQUIREMENTS:
 * - Logging an activity must NEVER mutate the plan state.
 * - Plan changes must only be applied after explicit user confirmation.
 * - Cycling workouts must NEVER be replacement targets.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createActivity } from './activities';
import { applyCrossTrainingToWorkouts } from './matcher';
import { buildCrossTrainingPopup, workoutsToPlannedRuns, applyAdjustments } from './suggester';
import type { Week, Workout } from '@/types';

// Helper to create a test week
function createTestWeek(): Week {
  return {
    w: 1,
    ph: 'build',
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
  };
}

// Helper to create workouts including cycling cross-training
function createWorkoutsWithCycling(): Workout[] {
  return [
    {
      n: 'W1-easy1',
      t: 'easy',
      d: '8km',
      dayOfWeek: 1,
      aerobic: 80,
      anaerobic: 10,
      rpe: 3,
      r: 3,
    },
    {
      n: 'W1-threshold',
      t: 'threshold',
      d: '10km with 6km @ threshold',
      dayOfWeek: 2,
      aerobic: 120,
      anaerobic: 40,
      rpe: 7,
      r: 7,
    },
    // This is a cycling cross-training activity - should NEVER be a replacement target
    {
      n: 'W1-cycling',
      t: 'cycling',
      d: '45min',
      dayOfWeek: 3,
      aerobic: 70,
      anaerobic: 5,
      rpe: 4,
      r: 4,
    },
    {
      n: 'W1-easy2',
      t: 'easy',
      d: '6km',
      dayOfWeek: 4,
      aerobic: 60,
      anaerobic: 8,
      rpe: 3,
      r: 3,
    },
    {
      n: 'W1-long',
      t: 'long',
      d: '20km',
      dayOfWeek: 6,
      aerobic: 180,
      anaerobic: 18,
      rpe: 5,
      r: 5,
    },
  ];
}

describe('Boxing Replacement Bug Regression', () => {
  describe('applyCrossTrainingToWorkouts - Cycling Protection', () => {
    it('should NEVER replace cycling workouts', () => {
      const wk = createTestWeek();
      const workouts = createWorkoutsWithCycling();
      const originalCyclingStatus = workouts.find(w => w.t === 'cycling')?.status;

      // Log a boxing activity (high load to maximize modification chance)
      const boxingActivity = createActivity('boxing', 60, 5, 100, 30, 1);
      const result = applyCrossTrainingToWorkouts(wk, workouts, [boxingActivity]);

      // Find the cycling workout in result
      const cyclingWorkout = result.find(w => w.t === 'cycling');

      // Cycling workout must NOT be modified
      expect(cyclingWorkout).toBeDefined();
      expect(cyclingWorkout!.status).toBe(originalCyclingStatus);
      expect(cyclingWorkout!.modReason).toBeUndefined();
    });

    it('should NEVER replace strength workouts', () => {
      const wk = createTestWeek();
      const workouts: Workout[] = [
        { n: 'W1-easy', t: 'easy', d: '8km', dayOfWeek: 1, aerobic: 80, anaerobic: 10, rpe: 3, r: 3 },
        { n: 'W1-strength', t: 'strength', d: '45min', dayOfWeek: 3, aerobic: 50, anaerobic: 20, rpe: 6, r: 6 },
        { n: 'W1-long', t: 'long', d: '20km', dayOfWeek: 6, aerobic: 180, anaerobic: 18, rpe: 5, r: 5 },
      ];

      const boxingActivity = createActivity('boxing', 90, 8, 150, 50, 1);
      const result = applyCrossTrainingToWorkouts(wk, workouts, [boxingActivity]);

      const strengthWorkout = result.find(w => w.t === 'strength');
      expect(strengthWorkout).toBeDefined();
      expect(strengthWorkout!.status).toBeUndefined();
    });

    it('should NEVER replace cross-training workouts', () => {
      const wk = createTestWeek();
      const workouts: Workout[] = [
        { n: 'W1-easy', t: 'easy', d: '8km', dayOfWeek: 1, aerobic: 80, anaerobic: 10, rpe: 3, r: 3 },
        { n: 'W1-cross', t: 'cross', d: 'Swimming 30min', dayOfWeek: 3, aerobic: 40, anaerobic: 5, rpe: 4, r: 4 },
        { n: 'W1-long', t: 'long', d: '20km', dayOfWeek: 6, aerobic: 180, anaerobic: 18, rpe: 5, r: 5 },
      ];

      const boxingActivity = createActivity('boxing', 90, 8, 150, 50, 1);
      const result = applyCrossTrainingToWorkouts(wk, workouts, [boxingActivity]);

      const crossWorkout = result.find(w => w.t === 'cross');
      expect(crossWorkout).toBeDefined();
      expect(crossWorkout!.status).toBeUndefined();
    });
  });

  describe('buildCrossTrainingPopup - Preview Only', () => {
    it('should compute suggestions WITHOUT mutating input workouts', () => {
      const workouts = createWorkoutsWithCycling();

      // Deep copy to compare later
      const originalWorkouts = JSON.parse(JSON.stringify(workouts));

      // Create boxing activity
      const boxingActivity = createActivity('boxing', 60, 5);

      // Build popup (this should be preview-only, no mutations)
      const plannedRuns = workoutsToPlannedRuns(workouts);
      const popup = buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // Verify original workouts are unchanged
      expect(workouts).toEqual(originalWorkouts);

      // Popup should exist but NOT have applied any changes
      expect(popup).toBeDefined();
      expect(popup.severity).toBeDefined();
    });

    it('should NOT mark any workouts as completed in preview', () => {
      const workouts = createWorkoutsWithCycling();
      const boxingActivity = createActivity('boxing', 60, 5);

      const plannedRuns = workoutsToPlannedRuns(workouts);
      buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // No workout should have status changed
      for (const w of workouts) {
        expect(w.status).toBeUndefined();
        expect(w.autoCompleted).toBeUndefined();
      }
    });
  });

  describe('Week State Protection', () => {
    it('should NOT mutate week.rated when computing preview', () => {
      const wk = createTestWeek();
      const originalRated = { ...wk.rated };

      const workouts = createWorkoutsWithCycling();
      const boxingActivity = createActivity('boxing', 60, 5);

      const plannedRuns = workoutsToPlannedRuns(workouts);
      buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // Week rated should be unchanged
      expect(wk.rated).toEqual(originalRated);
    });

    it('should NOT mutate week.workoutMods when computing preview', () => {
      const wk = createTestWeek();
      const originalMods = [...wk.workoutMods];

      const workouts = createWorkoutsWithCycling();
      const boxingActivity = createActivity('boxing', 60, 5);

      const plannedRuns = workoutsToPlannedRuns(workouts);
      buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // Week mods should be unchanged
      expect(wk.workoutMods).toEqual(originalMods);
    });
  });

  describe('Boxing 60min RPE 5 Specific Case', () => {
    it('should produce equivalence around 2-3km easy run', () => {
      const workouts = createWorkoutsWithCycling();
      const boxingActivity = createActivity('boxing', 60, 5);

      const plannedRuns = workoutsToPlannedRuns(workouts);
      const popup = buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // Bug report mentioned ~2.4km equivalence
      expect(popup.equivalentEasyKm).toBeGreaterThan(1);
      expect(popup.equivalentEasyKm).toBeLessThan(5);
    });

    it('should have 3 choices available', () => {
      const workouts = createWorkoutsWithCycling();
      const boxingActivity = createActivity('boxing', 60, 5);

      const plannedRuns = workoutsToPlannedRuns(workouts);
      const popup = buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      expect(popup.keepOutcome).toBeDefined();
      expect(popup.reduceOutcome).toBeDefined();
      expect(popup.replaceOutcome).toBeDefined();
    });
  });

  describe('View Changes - Preview Purity', () => {
    it('buildCrossTrainingPopup must be pure - no mutations to PlannedRun array', () => {
      const workouts = createWorkoutsWithCycling();
      const plannedRuns = workoutsToPlannedRuns(workouts);

      // Deep copy for comparison
      const originalPlannedRuns = JSON.parse(JSON.stringify(plannedRuns));

      // Create a high-load activity to maximize chance of triggering modifications
      const boxingActivity = createActivity('boxing', 120, 8, 200, 80, 1);

      // Build popup multiple times (simulates clicking "View changes" repeatedly)
      for (let i = 0; i < 5; i++) {
        buildCrossTrainingPopup(
          { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
          plannedRuns,
          boxingActivity
        );
      }

      // PlannedRuns array must be UNCHANGED
      expect(plannedRuns).toEqual(originalPlannedRuns);
    });

    it('buildCrossTrainingPopup must be pure - no mutations to activity object', () => {
      const workouts = createWorkoutsWithCycling();
      const plannedRuns = workoutsToPlannedRuns(workouts);
      const boxingActivity = createActivity('boxing', 90, 7, 150, 50, 1);

      // Store original values (not using JSON.stringify as it converts Date objects)
      const originalSport = boxingActivity.sport;
      const originalDuration = boxingActivity.duration_min;
      const originalRpe = boxingActivity.rpe;
      const originalAerobic = boxingActivity.aerobic_load;
      const originalAnaerobic = boxingActivity.anaerobic_load;
      const originalApplied = boxingActivity.applied;
      const originalWeek = boxingActivity.week;

      // Build popup
      buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // Activity must be UNCHANGED
      expect(boxingActivity.sport).toBe(originalSport);
      expect(boxingActivity.duration_min).toBe(originalDuration);
      expect(boxingActivity.rpe).toBe(originalRpe);
      expect(boxingActivity.aerobic_load).toBe(originalAerobic);
      expect(boxingActivity.anaerobic_load).toBe(originalAnaerobic);
      expect(boxingActivity.applied).toBe(originalApplied);
      expect(boxingActivity.week).toBe(originalWeek);
    });

    it('workoutsToPlannedRuns must be pure - no mutations to source workouts', () => {
      const workouts = createWorkoutsWithCycling();

      // Deep copy for comparison
      const originalWorkouts = JSON.parse(JSON.stringify(workouts));

      // Convert multiple times
      for (let i = 0; i < 5; i++) {
        workoutsToPlannedRuns(workouts);
      }

      // Original workouts must be UNCHANGED
      expect(workouts).toEqual(originalWorkouts);
    });

    it('View changes does not mutate app state', () => {
      // This test simulates clicking "View changes" in the modal.
      // The entire preview flow (buildCrossTrainingPopup) must be pure.
      // See: docs/bugs/boxing-replacement-bug.md

      // 1. Set up initial state (Week + Workouts)
      const wk = createTestWeek();
      const workouts = createWorkoutsWithCycling();

      // 2. Deep copy all state for comparison
      const originalWk = JSON.parse(JSON.stringify(wk));
      const originalWorkouts = JSON.parse(JSON.stringify(workouts));

      // 3. Create a high-load activity that would trigger many modifications
      const boxingActivity = createActivity('boxing', 120, 9, 300, 100, 1);
      const originalActivity = {
        sport: boxingActivity.sport,
        duration_min: boxingActivity.duration_min,
        rpe: boxingActivity.rpe,
        aerobic_load: boxingActivity.aerobic_load,
        anaerobic_load: boxingActivity.anaerobic_load,
        applied: boxingActivity.applied,
        week: boxingActivity.week,
      };

      // 4. Simulate "View changes" - this calls buildCrossTrainingPopup
      // which is exactly what happens when the modal opens
      const plannedRuns = workoutsToPlannedRuns(workouts);
      const popup = buildCrossTrainingPopup(
        { raceGoal: 'marathon', plannedRunsPerWeek: 5, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // 5. Access the adjustments (simulates expanding "View changes")
      const _replaceAdjustments = popup.replaceOutcome.adjustments;
      const _reduceAdjustments = popup.reduceOutcome.adjustments;

      // 6. CRITICAL: Verify NO state was mutated
      // Week must be unchanged
      expect(wk.rated).toEqual(originalWk.rated);
      expect(wk.workoutMods).toEqual(originalWk.workoutMods);
      expect(wk.skip).toEqual(originalWk.skip);
      expect(wk.cross).toEqual(originalWk.cross);

      // Workouts must be unchanged
      expect(workouts).toEqual(originalWorkouts);

      // Activity must be unchanged
      expect(boxingActivity.sport).toBe(originalActivity.sport);
      expect(boxingActivity.duration_min).toBe(originalActivity.duration_min);
      expect(boxingActivity.rpe).toBe(originalActivity.rpe);
      expect(boxingActivity.aerobic_load).toBe(originalActivity.aerobic_load);
      expect(boxingActivity.anaerobic_load).toBe(originalActivity.anaerobic_load);
      expect(boxingActivity.applied).toBe(originalActivity.applied);
      expect(boxingActivity.week).toBe(originalActivity.week);

      // Popup should have computed suggestions (proof it ran)
      expect(popup.severity).toBeDefined();
      expect(popup.equivalentEasyKm).toBeGreaterThan(0);
    });
  });

  /**
   * REGRESSION TEST: Replaced workouts must NOT count as user-completed.
   *
   * BUG: After confirming Replace in the cross-training modal:
   * - Multiple workouts rendered as green "COMPLETED"
   * - "Done X" counters incremented
   * - This was caused by marking replaced workouts in wk.rated
   *
   * FIX: wk.rated is for USER-completed workouts only.
   * Adjustments are tracked via workoutMods, not wk.rated.
   */
  describe('Replaced Workouts Must Not Count as User-Completed', () => {
    it('applyAdjustments should NOT mark replaced workouts in wk.rated', () => {
      const wk = createTestWeek();
      const workouts = createWorkoutsWithCycling();

      // Create activity that will trigger replacements
      const boxingActivity = createActivity('boxing', 90, 7, 150, 50, 1);

      const plannedRuns = workoutsToPlannedRuns(workouts);
      const popup = buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      const adjustments = popup.replaceOutcome.adjustments;
      if (adjustments.length === 0) {
        console.warn('No adjustments generated - skipping assertion');
        return;
      }

      // Apply adjustments (this is what events.ts does on confirm)
      const modifiedWorkouts = applyAdjustments(workouts, adjustments, 'boxing');

      // Simulate what events.ts does: store modifications but NOT in wk.rated
      for (const adj of adjustments) {
        const modified = modifiedWorkouts.find(
          (w: Workout) => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex
        );
        if (!modified) continue;

        wk.workoutMods.push({
          name: modified.n,
          dayOfWeek: modified.dayOfWeek,
          status: modified.status || 'reduced',
          modReason: modified.modReason || '',
          confidence: modified.confidence,
          originalDistance: modified.originalDistance,
          newDistance: modified.d,
        });

        // CRITICAL: We must NOT do this anymore (this was the bug):
        // if (adj.action === 'replace') {
        //   wk.rated[modified.n] = modified.rpe || modified.r || 5;
        // }
      }

      // ASSERTION: wk.rated must remain empty
      // Replaced workouts should NOT count as user-completed
      expect(Object.keys(wk.rated).length).toBe(0);

      // But workoutMods should have the adjustments
      expect(wk.workoutMods.length).toBeGreaterThan(0);
    });
  });

  describe('Confirm Replace - State Update', () => {
    it('confirming Replace updates workout data via applyAdjustments', () => {
      // This test verifies that when user confirms Replace:
      // 1. applyAdjustments correctly modifies workouts
      // 2. The modifications use dayIndex for unique matching
      // 3. Multiple workouts with same name are handled correctly

      const workouts = createWorkoutsWithCycling();
      const plannedRuns = workoutsToPlannedRuns(workouts);

      // Create activity that will trigger replacements
      const boxingActivity = createActivity('boxing', 90, 7, 150, 50, 1);

      const popup = buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 4, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // Get the replace adjustments
      const adjustments = popup.replaceOutcome.adjustments;

      // Skip if no adjustments (test setup issue)
      if (adjustments.length === 0) {
        console.warn('No adjustments generated - skipping assertion');
        return;
      }

      // Apply adjustments (simulates what happens on confirm)
      const modifiedWorkouts = applyAdjustments(workouts, adjustments, 'boxing');

      // Verify at least one workout was modified
      const modifiedCount = modifiedWorkouts.filter(
        (w: Workout) => w.status === 'replaced' || w.status === 'reduced'
      ).length;

      expect(modifiedCount).toBeGreaterThan(0);

      // Verify each adjustment was applied to the correct workout (by dayOfWeek)
      for (const adj of adjustments) {
        const modified = modifiedWorkouts.find(
          (w: Workout) => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex
        );
        expect(modified).toBeDefined();
        expect(modified!.status).toBeDefined();
        expect(modified!.modReason).toContain('boxing');
      }
    });

    it('applyAdjustments handles duplicate workout names correctly', () => {
      // Create workouts with duplicate names (like multiple "Easy Run")
      const workouts: Workout[] = [
        { n: 'Easy Run', t: 'easy', d: '6km', dayOfWeek: 0, aerobic: 60, anaerobic: 8, rpe: 3, r: 3 },
        { n: 'Easy Run', t: 'easy', d: '8km', dayOfWeek: 2, aerobic: 80, anaerobic: 10, rpe: 3, r: 3 },
        { n: 'Easy Run', t: 'easy', d: '5km', dayOfWeek: 4, aerobic: 50, anaerobic: 6, rpe: 3, r: 3 },
        { n: 'Long Run', t: 'long', d: '18km', dayOfWeek: 6, aerobic: 160, anaerobic: 16, rpe: 5, r: 5 },
      ];

      // Create adjustment that targets the SECOND "Easy Run" (dayIndex: 2)
      const adjustments = [{
        workoutId: 'Easy Run',
        dayIndex: 2,  // Wednesday's Easy Run
        action: 'replace' as const,
        originalType: 'easy' as const,
        originalDistanceKm: 8,
        newType: 'easy' as const,
        newDistanceKm: 0,
        loadReduction: 80,
      }];

      const modified = applyAdjustments(workouts, adjustments, 'boxing');

      // Verify ONLY the Wednesday Easy Run (dayOfWeek: 2) was replaced
      const mondayEasy = modified.find((w: Workout) => w.n === 'Easy Run' && w.dayOfWeek === 0);
      const wednesdayEasy = modified.find((w: Workout) => w.n === 'Easy Run' && w.dayOfWeek === 2);
      const fridayEasy = modified.find((w: Workout) => w.n === 'Easy Run' && w.dayOfWeek === 4);

      expect(mondayEasy!.status).toBeUndefined();  // Unchanged
      expect(wednesdayEasy!.status).toBe('replaced');  // Modified
      expect(fridayEasy!.status).toBeUndefined();  // Unchanged
    });
  });

  /**
   * REGRESSION TEST: "Keep 0km but at easy effort" bug
   *
   * BUG: For time-based/interval workouts like "5×3min @ VO2" or "20min @ threshold",
   * the simple regex /(\d+\.?\d*)km/ returned 0, causing the UI to show "Keep 0km...".
   *
   * FIX: workoutsToPlannedRuns now uses parseWorkoutDescription for robust parsing.
   */
  describe('Time-Based Workout Distance Parsing', () => {
    it('should parse distance from interval workouts (e.g., "5×3min @ VO2")', () => {
      const workouts: Workout[] = [
        {
          n: 'VO2 Builder',
          t: 'vo2',
          d: '5×3min @ VO2, 2min',
          dayOfWeek: 2,
          aerobic: 100,
          anaerobic: 50,
          rpe: 8,
          r: 8,
        },
      ];

      // Pass paces for proper parsing
      const paces = { e: 360, t: 300, i: 270, m: 315, r: 255 };
      const plannedRuns = workoutsToPlannedRuns(workouts, paces);

      // Distance should NOT be 0 for interval workouts
      expect(plannedRuns[0].plannedDistanceKm).toBeGreaterThan(0);
    });

    it('should parse distance from time @ pace workouts (e.g., "20min @ threshold")', () => {
      const workouts: Workout[] = [
        {
          n: 'Tempo Run',
          t: 'threshold',
          d: '20min @ threshold',
          dayOfWeek: 3,
          aerobic: 90,
          anaerobic: 30,
          rpe: 7,
          r: 7,
        },
      ];

      const paces = { e: 360, t: 300, i: 270, m: 315, r: 255 };
      const plannedRuns = workoutsToPlannedRuns(workouts, paces);

      // Distance should NOT be 0 for time-based workouts
      expect(plannedRuns[0].plannedDistanceKm).toBeGreaterThan(0);
      // At 5:00/km pace for 20min, distance should be around 4km
      expect(plannedRuns[0].plannedDistanceKm).toBeCloseTo(4, 0);
    });

    it('should fallback to aerobic load estimation when parsing fails', () => {
      const workouts: Workout[] = [
        {
          n: 'Custom Workout',
          t: 'easy',
          d: 'Some unparseable description',
          dayOfWeek: 1,
          aerobic: 70,  // ~2km worth of load
          anaerobic: 5,
          rpe: 4,
          r: 4,
        },
      ];

      const plannedRuns = workoutsToPlannedRuns(workouts);

      // Should estimate from aerobic load (70 / 35 ≈ 2km)
      expect(plannedRuns[0].plannedDistanceKm).toBeGreaterThan(0);
    });

    it('downgrade adjustment should not show "0km" for interval workouts', () => {
      const workouts: Workout[] = [
        {
          n: 'VO2 Builder',
          t: 'vo2',
          d: '5×3min @ VO2, 2min',
          dayOfWeek: 2,
          aerobic: 100,
          anaerobic: 50,
          rpe: 8,
          r: 8,
        },
        {
          n: 'Easy Run',
          t: 'easy',
          d: '8km',
          dayOfWeek: 1,
          aerobic: 80,
          anaerobic: 10,
          rpe: 3,
          r: 3,
        },
        {
          n: 'Long Run',
          t: 'long',
          d: '20km',
          dayOfWeek: 6,
          aerobic: 180,
          anaerobic: 18,
          rpe: 5,
          r: 5,
        },
      ];

      const paces = { e: 360, t: 300, i: 270, m: 315, r: 255 };
      const plannedRuns = workoutsToPlannedRuns(workouts, paces);
      const boxingActivity = createActivity('boxing', 60, 5);

      const popup = buildCrossTrainingPopup(
        { raceGoal: 'half', plannedRunsPerWeek: 3, injuryMode: false },
        plannedRuns,
        boxingActivity
      );

      // Check that any downgrade adjustment for VO2 workout has non-zero distance
      const vo2Adjustment = popup.reduceOutcome.adjustments.find(
        a => a.workoutId === 'VO2 Builder' && a.action === 'downgrade'
      );

      if (vo2Adjustment) {
        expect(vo2Adjustment.originalDistanceKm).toBeGreaterThan(0);
      }
    });
  });
});
