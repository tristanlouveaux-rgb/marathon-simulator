/**
 * universalLoad.test.ts
 * =====================
 * Tests for the Universal Load Currency + Cross-Sport Plan Adjustment system.
 *
 * Required test scenarios:
 * 1) 90 min padel, RPE 6, Tier C => should NOT recommend replacing >1 run in normal mode
 * 2) 3 hours soccer, RPE 8, Tier C => extremeMode true, but preserves 2 runs and protects long run
 * 3) Garmin-tier activity with high anaerobic load => max 1 replace + 1 reduce unless extreme
 * 4) If week only has 2 planned runs => no replacements; only reduce/downgrade
 */

import { describe, it, expect } from 'vitest';
import {
  computeUniversalLoad,
  isExtremeSession,
  classifyByITrimp,
  classifyByZones,
  classifyWorkoutType,
} from './universalLoad';
import type { HRZoneData } from './universal-load-types';
import {
  suggestAdjustments,
  workoutsToPlannedRuns,
  applyPlanEdits,
} from './planSuggester';
import type {
  ActivityInput,
  AthleteContext,
} from './universal-load-types';
import type { Workout, RaceDistance } from '@/types';
import {
  EXTREME_WEEK_PCT,
  MAX_MODS_NORMAL,
  MAX_MODS_EXTREME,
  LONG_MIN_KM,
  LONG_MIN_FRAC,
  EASY_MIN_KM,
} from './universal-load-constants';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function createTestContext(
  runs: number = 4,
  goal: RaceDistance = 'half'
): AthleteContext {
  return {
    raceGoal: goal,
    plannedRunsPerWeek: runs,
    injuryMode: false,
    easyPaceSecPerKm: 330, // 5:30/km
  };
}

function createStandardWeekWorkouts(): Workout[] {
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
      d: '24km',
      dayOfWeek: 6,
      aerobic: 200,
      anaerobic: 20,
      rpe: 5,
      r: 5,
    },
  ];
}

function createMinimalWeekWorkouts(): Workout[] {
  // Only 2 runs - should trigger preservation mode
  return [
    {
      n: 'W1-easy',
      t: 'easy',
      d: '8km',
      dayOfWeek: 2,
      aerobic: 80,
      anaerobic: 10,
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

// ---------------------------------------------------------------------------
// Test 1: 90 min padel, RPE 6, Tier C
// Should NOT recommend replacing >1 run in normal mode
// ---------------------------------------------------------------------------

describe('Universal Load: Padel 90min RPE 6 (Tier C)', () => {
  const padelActivity: ActivityInput = {
    sport: 'padel',
    durationMin: 90,
    rpe: 6,
    dayOfWeek: 3,
  };

  it('should compute load as Tier C (RPE-only)', () => {
    const load = computeUniversalLoad(padelActivity, 'half');

    expect(load.tier).toBe('rpe');
    expect(load.confidence).toBeLessThanOrEqual(0.70); // Tier C has lower confidence
  });

  it('should apply active fraction discount for padel', () => {
    const load = computeUniversalLoad(padelActivity, 'half');

    // Padel has 0.60 active fraction (lots of rest between points)
    // Plus RPE uncertainty penalty (0.80)
    // So raw load should be discounted significantly
    expect(load.explanations.some((e) => e.includes('intermittent'))).toBe(true);
  });

  it('should NOT recommend replacing more than 1 run in normal mode', () => {
    const workouts = createStandardWeekWorkouts();
    const ctx = createTestContext(4, 'half');

    const suggestion = suggestAdjustments(workouts, padelActivity, ctx);

    // Should be light or heavy, not extreme
    expect(['light', 'heavy']).toContain(suggestion.severity);
    expect(suggestion.isExtremeSession).toBe(false);

    // Recommended edits should have at most MAX_MODS_NORMAL (2) modifications
    expect(suggestion.recommendedOutcome.edits.length).toBeLessThanOrEqual(
      MAX_MODS_NORMAL
    );

    // Count replacements specifically (spec says max 1 replace for non-extreme)
    const replacements = suggestion.recommendedOutcome.edits.filter(
      (e) => e.action === 'replace'
    );
    expect(replacements.length).toBeLessThanOrEqual(1);

    console.log('Padel 90min RPE 6 suggestion:', {
      severity: suggestion.severity,
      isExtreme: suggestion.isExtremeSession,
      edits: suggestion.recommendedOutcome.edits.map((e) => ({
        action: e.action,
        workoutId: e.workoutId,
      })),
    });
  });

  it('should generate meaningful equivalence message', () => {
    const workouts = createStandardWeekWorkouts();
    const ctx = createTestContext(4, 'half');

    const suggestion = suggestAdjustments(workouts, padelActivity, ctx);

    // Summary should mention equivalent km
    expect(suggestion.summary).toContain('km easy-run equivalent');
    expect(suggestion.equivalentEasyKm).toBeGreaterThan(0);
    expect(suggestion.equivalentEasyKm).toBeLessThan(20); // Reasonable cap
  });
});

// ---------------------------------------------------------------------------
// Test 2: 3 hours soccer, RPE 8, Tier C
// extremeMode true, but still preserves 2 runs and protects long run
// ---------------------------------------------------------------------------

describe('Universal Load: Soccer 3h RPE 8 (Tier C - Extreme)', () => {
  const soccerActivity: ActivityInput = {
    sport: 'soccer',
    durationMin: 180, // 3 hours
    rpe: 8,
    dayOfWeek: 6,
  };

  it('should detect as extreme session', () => {
    const workouts = createStandardWeekWorkouts();
    const ctx = createTestContext(4, 'half');
    const runs = workoutsToPlannedRuns(workouts);
    const weeklyLoad = runs.reduce(
      (sum, r) => sum + r.plannedAerobic + r.plannedAnaerobic * 1.5,
      0
    );

    const load = computeUniversalLoad(soccerActivity, 'half');
    const isExtreme = isExtremeSession(load, soccerActivity, weeklyLoad);

    // 3h at RPE 8 with no HR data should trigger extreme mode
    // (durationMin >= 120 AND rpe >= 7)
    expect(isExtreme).toBe(true);
    expect(load.tier).toBe('rpe');

    console.log('Soccer 3h RPE 8 load:', {
      fatigueCost: load.fatigueCostLoad,
      weeklyLoad,
      ratio: load.fatigueCostLoad / weeklyLoad,
      isExtreme,
    });
  });

  it('should allow up to MAX_MODS_EXTREME (3) modifications', () => {
    const workouts = createStandardWeekWorkouts();
    const ctx = createTestContext(4, 'half');

    const suggestion = suggestAdjustments(workouts, soccerActivity, ctx);

    expect(suggestion.isExtremeSession).toBe(true);
    expect(suggestion.severity).toBe('extreme');

    // Should allow up to 3 modifications
    expect(suggestion.recommendedOutcome.edits.length).toBeLessThanOrEqual(
      MAX_MODS_EXTREME
    );
  });

  it('should preserve at least 2 runs', () => {
    const workouts = createStandardWeekWorkouts();
    const ctx = createTestContext(4, 'half');

    const suggestion = suggestAdjustments(workouts, soccerActivity, ctx);

    // Count full replacements (newDistanceKm = 0)
    const fullReplacements = suggestion.recommendedOutcome.edits.filter(
      (e) => e.action === 'replace' && e.newDistanceKm === 0
    ).length;

    // Should not replace more than (4 - 2) = 2 runs fully
    expect(fullReplacements).toBeLessThanOrEqual(2);

    console.log('Soccer 3h extreme - edits:', suggestion.recommendedOutcome.edits);
  });

  it('should NOT fully replace long run (unless injury mode)', () => {
    const workouts = createStandardWeekWorkouts();
    const ctx = createTestContext(4, 'half');
    ctx.injuryMode = false;

    const suggestion = suggestAdjustments(workouts, soccerActivity, ctx);

    // Find long run edit
    const longRunEdit = suggestion.recommendedOutcome.edits.find(
      (e) => e.workoutId === 'W1-long'
    );

    if (longRunEdit) {
      // Should not be a full replacement
      expect(longRunEdit.action).not.toBe('replace');

      // If reduced, should respect minimums
      if (longRunEdit.action === 'reduce') {
        expect(longRunEdit.newDistanceKm).toBeGreaterThanOrEqual(LONG_MIN_KM);
        expect(longRunEdit.newDistanceKm).toBeGreaterThanOrEqual(
          longRunEdit.originalDistanceKm * LONG_MIN_FRAC
        );
      }
    }

    console.log(
      'Long run protection:',
      longRunEdit || 'Long run not modified'
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3: Garmin-tier activity with high anaerobic load
// Can match quality run but still max 1 replace + 1 reduce unless extreme
// ---------------------------------------------------------------------------

describe('Universal Load: Garmin activity with high anaerobic', () => {
  const garminActivity: ActivityInput = {
    sport: 'cycling',
    durationMin: 90,
    rpe: 8,
    garminAerobicLoad: 120,
    garminAnaerobicLoad: 80, // High anaerobic
    fromGarmin: true,
    dayOfWeek: 2,
  };

  it('should use Tier A (Garmin) with high confidence', () => {
    const load = computeUniversalLoad(garminActivity, 'half');

    expect(load.tier).toBe('garmin');
    expect(load.confidence).toBe(0.9);
    expect(load.aerobicLoad).toBe(120);
    expect(load.anaerobicLoad).toBe(80);
  });

  it('should have better vibe similarity with quality workouts (high anaerobic ratio)', () => {
    const load = computeUniversalLoad(garminActivity, 'half');

    // Anaerobic ratio: 80 / 200 = 0.40
    // This should match well with threshold/VO2 workouts
    const anaerobicRatio = load.anaerobicLoad / load.baseLoad;
    expect(anaerobicRatio).toBeGreaterThan(0.3);
  });

  it('should default to max 2 modifications (1 replace + 1 reduce)', () => {
    const workouts = createStandardWeekWorkouts();
    const ctx = createTestContext(4, 'half');

    const suggestion = suggestAdjustments(workouts, garminActivity, ctx);

    // Unless extreme, should have at most MAX_MODS_NORMAL
    if (!suggestion.isExtremeSession) {
      expect(suggestion.recommendedOutcome.edits.length).toBeLessThanOrEqual(
        MAX_MODS_NORMAL
      );

      // Typically: 1 replace + 1 downgrade/reduce
      const replacements = suggestion.recommendedOutcome.edits.filter(
        (e) => e.action === 'replace'
      );
      expect(replacements.length).toBeLessThanOrEqual(1);
    }

    console.log('Garmin high-anaerobic suggestion:', {
      severity: suggestion.severity,
      confidence: suggestion.confidence,
      edits: suggestion.recommendedOutcome.edits.map((e) => ({
        action: e.action,
        target: e.originalType,
      })),
    });
  });

  it('should allow replacement due to high confidence when targeting easy runs', () => {
    // Create workouts with multiple easy runs (easier replacement targets)
    const workouts: Workout[] = [
      {
        n: 'W1-easy1',
        t: 'easy',
        d: '6km',
        dayOfWeek: 1,
        aerobic: 60,
        anaerobic: 8,
        rpe: 3,
        r: 3,
      },
      {
        n: 'W1-easy2',
        t: 'easy',
        d: '6km',
        dayOfWeek: 3,
        aerobic: 60,
        anaerobic: 8,
        rpe: 3,
        r: 3,
      },
      {
        n: 'W1-easy3',
        t: 'easy',
        d: '6km',
        dayOfWeek: 5,
        aerobic: 60,
        anaerobic: 8,
        rpe: 3,
        r: 3,
      },
      {
        n: 'W1-long',
        t: 'long',
        d: '18km',
        dayOfWeek: 6,
        aerobic: 160,
        anaerobic: 16,
        rpe: 5,
        r: 5,
      },
    ];
    const ctx = createTestContext(4, 'half');

    // High-load Garmin activity with good confidence
    const highLoadActivity: ActivityInput = {
      sport: 'cycling',
      durationMin: 120,
      rpe: 7,
      garminAerobicLoad: 180,
      garminAnaerobicLoad: 30,
      fromGarmin: true,
      dayOfWeek: 2,
    };

    const suggestion = suggestAdjustments(workouts, highLoadActivity, ctx);

    // Garmin has confidence >= 0.75, so replacements should be allowed
    expect(suggestion.confidence).toBeGreaterThanOrEqual(0.75);

    // When targeting easy runs (not quality), replacement is preferred over downgrade
    // Check that the system CAN replace when appropriate
    const hasReplacementOrReduce = suggestion.recommendedOutcome.edits.some(
      (e) => e.action === 'replace' || e.action === 'reduce'
    );

    // With high credit and easy run targets, should have some modifications
    expect(hasReplacementOrReduce).toBe(true);

    console.log('Garmin high-load easy-target:', {
      credit: suggestion.runReplacementCredit,
      edits: suggestion.recommendedOutcome.edits.map((e) => ({
        action: e.action,
        target: e.workoutId,
      })),
    });
  });
});

// ---------------------------------------------------------------------------
// Test 4: Only 2 planned runs
// No replacements; only reduce/downgrade
// ---------------------------------------------------------------------------

describe('Universal Load: Only 2 runs planned (preservation mode)', () => {
  const activity: ActivityInput = {
    sport: 'rugby',
    durationMin: 90,
    rpe: 8,
    garminAerobicLoad: 150,
    garminAnaerobicLoad: 50,
    fromGarmin: true,
    dayOfWeek: 4,
  };

  it('should detect minimal runs situation', () => {
    const workouts = createMinimalWeekWorkouts();
    const ctx = createTestContext(2, 'marathon');

    const suggestion = suggestAdjustments(workouts, activity, ctx);

    // Should warn about preserving runs
    expect(
      suggestion.warnings.some(
        (w) => w.includes('2 runs') || w.includes('minimum')
      )
    ).toBe(true);
  });

  it('should NOT recommend any replacements', () => {
    const workouts = createMinimalWeekWorkouts();
    const ctx = createTestContext(2, 'marathon');

    const suggestion = suggestAdjustments(workouts, activity, ctx);

    // No full replacements allowed
    const replacements = suggestion.recommendedOutcome.edits.filter(
      (e) => e.action === 'replace' && e.newDistanceKm === 0
    );

    expect(replacements.length).toBe(0);

    console.log('2-run preservation:', {
      recommendedEdits: suggestion.recommendedOutcome.edits,
      conservativeEdits: suggestion.conservativeOutcome.edits,
    });
  });

  it('should only suggest reduce/downgrade options', () => {
    const workouts = createMinimalWeekWorkouts();
    const ctx = createTestContext(2, 'marathon');

    const suggestion = suggestAdjustments(workouts, activity, ctx);

    // All edits should be reduce or downgrade
    for (const edit of suggestion.recommendedOutcome.edits) {
      expect(['reduce', 'downgrade']).toContain(edit.action);
    }
  });

  it('should match conservative and recommended for 2-run weeks', () => {
    const workouts = createMinimalWeekWorkouts();
    const ctx = createTestContext(2, 'marathon');

    const suggestion = suggestAdjustments(workouts, activity, ctx);

    // When only 2 runs, recommended should equal conservative
    expect(suggestion.recommendedOutcome.edits.length).toBe(
      suggestion.conservativeOutcome.edits.length
    );
  });
});

// ---------------------------------------------------------------------------
// Additional Tests: Distance Clamps
// ---------------------------------------------------------------------------

describe('Universal Load: Distance Clamps', () => {
  it('should not reduce easy run below EASY_MIN_KM', () => {
    const workouts: Workout[] = [
      {
        n: 'Short-easy',
        t: 'easy',
        d: '5km',
        dayOfWeek: 1,
        aerobic: 50,
        anaerobic: 5,
        rpe: 3,
        r: 3,
      },
    ];

    const activity: ActivityInput = {
      sport: 'swimming',
      durationMin: 60,
      rpe: 5,
    };

    const ctx = createTestContext(1, 'half');
    ctx.plannedRunsPerWeek = 1;

    const suggestion = suggestAdjustments(workouts, activity, ctx);

    // Any reduction should respect EASY_MIN_KM
    for (const edit of suggestion.conservativeOutcome.edits) {
      if (edit.action === 'reduce' && edit.originalType === 'easy') {
        expect(edit.newDistanceKm).toBeGreaterThanOrEqual(EASY_MIN_KM);
      }
    }
  });

  it('should respect long run minimum fraction', () => {
    const workouts: Workout[] = [
      {
        n: 'Long',
        t: 'long',
        d: '30km',
        dayOfWeek: 6,
        aerobic: 250,
        anaerobic: 25,
        rpe: 5,
        r: 5,
      },
    ];

    const activity: ActivityInput = {
      sport: 'cycling',
      durationMin: 240, // 4 hours
      rpe: 7,
    };

    const ctx = createTestContext(1, 'marathon');
    ctx.plannedRunsPerWeek = 1;

    const suggestion = suggestAdjustments(workouts, activity, ctx);

    const longRunEdit = suggestion.conservativeOutcome.edits.find(
      (e) => e.workoutId === 'Long'
    );

    if (longRunEdit && longRunEdit.action === 'reduce') {
      // Min = max(LONG_MIN_KM=10, 30*0.65=19.5) = 19.5
      const minAllowed = Math.max(LONG_MIN_KM, 30 * LONG_MIN_FRAC);
      expect(longRunEdit.newDistanceKm).toBeGreaterThanOrEqual(minAllowed);
    }
  });
});

// ---------------------------------------------------------------------------
// Additional Tests: Tier Detection
// ---------------------------------------------------------------------------

describe('Universal Load: Tier Detection', () => {
  it('should prefer Garmin data over RPE', () => {
    const activity: ActivityInput = {
      sport: 'cycling',
      durationMin: 60,
      rpe: 7,
      garminAerobicLoad: 100,
      garminAnaerobicLoad: 20,
      fromGarmin: true,
    };

    const load = computeUniversalLoad(activity, 'half');
    expect(load.tier).toBe('garmin');
  });

  it('should use HR zones when available (no Garmin)', () => {
    const activity: ActivityInput = {
      sport: 'cycling',
      durationMin: 60,
      rpe: 7,
      hrZones: {
        zone1Minutes: 5,
        zone2Minutes: 20,
        zone3Minutes: 25,
        zone4Minutes: 8,
        zone5Minutes: 2,
      },
    };

    const load = computeUniversalLoad(activity, 'half');
    expect(load.tier).toBe('hr');
    expect(load.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('should fall back to RPE when no other data', () => {
    const activity: ActivityInput = {
      sport: 'cycling',
      durationMin: 60,
      rpe: 7,
    };

    const load = computeUniversalLoad(activity, 'half');
    expect(load.tier).toBe('rpe');
    expect(load.confidence).toBeLessThan(0.75);
  });
});

// ---------------------------------------------------------------------------
// Additional Tests: Goal Adjustment
// ---------------------------------------------------------------------------

describe('Universal Load: Goal Distance Adjustment', () => {
  it('should give higher credit for anaerobic sessions in 5k/10k goals', () => {
    const anaerobicActivity: ActivityInput = {
      sport: 'crossfit',
      durationMin: 45,
      rpe: 9, // High anaerobic ratio
      garminAerobicLoad: 50,
      garminAnaerobicLoad: 60, // More anaerobic than aerobic
      fromGarmin: true,
    };

    const load5k = computeUniversalLoad(anaerobicActivity, '5k');
    const loadMarathon = computeUniversalLoad(anaerobicActivity, 'marathon');

    // 5k should get more credit for high-anaerobic session
    expect(load5k.runReplacementCredit).toBeGreaterThan(
      loadMarathon.runReplacementCredit
    );
  });

  it('should give higher credit for aerobic sessions in marathon/half goals', () => {
    const aerobicActivity: ActivityInput = {
      sport: 'cycling',
      durationMin: 120,
      rpe: 5, // Low intensity
      garminAerobicLoad: 150,
      garminAnaerobicLoad: 10, // Mostly aerobic
      fromGarmin: true,
    };

    const loadMarathon = computeUniversalLoad(aerobicActivity, 'marathon');
    const load5k = computeUniversalLoad(aerobicActivity, '5k');

    // Marathon should value aerobic sessions more
    expect(loadMarathon.runReplacementCredit).toBeGreaterThanOrEqual(
      load5k.runReplacementCredit * 0.9 // Within 10% - goal factor range is ~20%
    );
  });
});

// ---------------------------------------------------------------------------
// Additional Tests: Apply Edits
// ---------------------------------------------------------------------------

describe('Universal Load: Apply Plan Edits', () => {
  it('should apply replacement edits correctly', () => {
    const workouts = createStandardWeekWorkouts();
    const edits = [
      {
        workoutId: 'W1-easy1',
        dayOfWeek: 1,
        action: 'replace' as const,
        originalType: 'easy' as const,
        originalDistanceKm: 8,
        newType: 'easy' as const,
        newDistanceKm: 0,
        loadReduction: 90,
        rationale: 'Test replacement',
      },
    ];

    const modified = applyPlanEdits(workouts, edits, 'rugby');
    const easy1 = modified.find((w) => w.n === 'W1-easy1')!;

    expect(easy1.status).toBe('replaced');
    expect(easy1.d).toContain('Replaced');
    expect(easy1.autoCompleted).toBe(true);
    expect(easy1.completedBySport).toBe('rugby');
  });

  it('should apply reduction edits correctly', () => {
    const workouts = createStandardWeekWorkouts();
    const edits = [
      {
        workoutId: 'W1-easy2',
        dayOfWeek: 4,
        action: 'reduce' as const,
        originalType: 'easy' as const,
        originalDistanceKm: 6,
        newType: 'easy' as const,
        newDistanceKm: 4,
        loadReduction: 30,
        rationale: 'Test reduction',
      },
    ];

    const modified = applyPlanEdits(workouts, edits, 'cycling');
    const easy2 = modified.find((w) => w.n === 'W1-easy2')!;

    expect(easy2.status).toBe('reduced');
    expect(easy2.d).toContain('4km');
    expect(easy2.d).toContain('was 6km');
  });

  it('should apply downgrade edits correctly', () => {
    const workouts = createStandardWeekWorkouts();
    const edits = [
      {
        workoutId: 'W1-threshold',
        dayOfWeek: 2,
        action: 'downgrade' as const,
        originalType: 'threshold' as const,
        originalDistanceKm: 10,
        newType: 'easy' as const,
        newDistanceKm: 10,
        loadReduction: 60,
        rationale: 'Test downgrade',
      },
    ];

    const modified = applyPlanEdits(workouts, edits, 'soccer');
    const threshold = modified.find((w) => w.n === 'W1-threshold')!;

    expect(threshold.status).toBe('reduced');
    expect(threshold.t).toBe('easy');
    expect(threshold.modReason).toContain('Downgraded');
  });
});

// ---------------------------------------------------------------------------
// Regression: extendedModel addition must not change any numerical output
// ---------------------------------------------------------------------------

describe('Universal Load: extendedModel backward compatibility', () => {
  const tennisInput: ActivityInput = {
    sport: 'tennis',
    durationMin: 60,
    rpe: 6,
    fromGarmin: false,
  };

  it('produces identical outputs for tennis 60min RPE 6 (Tier C)', () => {
    const r = computeUniversalLoad(tennisInput, 'half');

    expect(r.tier).toBe('rpe');
    expect(r.sportMult).toBe(1.2);
    expect(r.runSpec).toBe(0.5);
    expect(r.recoveryMult).toBe(1.1);

    // FCL = baseLoad * recoveryMult — must hold exactly
    const expectedFCL = Math.round(r.baseLoad * 1.1 * 10) / 10;
    expect(r.fatigueCostLoad).toBe(expectedFCL);

    // RRC must be positive and capped by saturation
    expect(r.runReplacementCredit).toBeGreaterThan(0);
    expect(r.equivalentEasyKm).toBeGreaterThan(0);
  });

  it('is fully deterministic across repeated calls', () => {
    const a = computeUniversalLoad(tennisInput, 'half');
    const b = computeUniversalLoad(tennisInput, 'half');

    expect(b.fatigueCostLoad).toBe(a.fatigueCostLoad);
    expect(b.runReplacementCredit).toBe(a.runReplacementCredit);
    expect(b.baseLoad).toBe(a.baseLoad);
    expect(b.aerobicLoad).toBe(a.aerobicLoad);
    expect(b.anaerobicLoad).toBe(a.anaerobicLoad);
  });
});

// ---------------------------------------------------------------------------
// Regression: iTRIMP scale invariant (Tier A+ must not silently drift)
// ---------------------------------------------------------------------------
// Original incident: `computeTierAPlus` skipped the `iTrimp × 100 / 15000`
// normalisation that every other consumer applies, treating raw seconds-weighted
// iTRIMP (~150 per TSS) as if it were already TSS-equivalent load. Result for
// an 89 min tennis session at ~39 TSS:
//   - baseLoad ≈ 7000 (should be ~47)
//   - equivalentEasyKm slammed into the 25 km cap
//   - severity always classified as "extreme"
// These tests pin the scale so that drift gets caught at unit-test time rather
// than weeks later in the suggestion modal.

describe('Universal Load: iTRIMP scale invariant', () => {
  // Plausible 1-hour HR-tracked tennis session.
  // iTRIMP = 6000 corresponds to TSS = 6000 × 100 / 15000 = 40 (matches the
  // user-reported 39 TSS in the incident screenshot).
  const REALISTIC_HOUR_TENNIS_ITRIMP = 6000;
  const tennisITrimpInput: ActivityInput = {
    sport: 'tennis',
    durationMin: 60,
    iTrimp: REALISTIC_HOUR_TENNIS_ITRIMP,
    rpe: 6,
    fromGarmin: false,
  };

  it('Tier A+ baseLoad is on the same scale as the displayed TSS', () => {
    const r = computeUniversalLoad(tennisITrimpInput, 'half');
    expect(r.tier).toBe('itrimp');

    // Expected: tssEquivalent (40) × tennis sportMult (1.20) = 48.
    // If the /15000 normalisation is missing, baseLoad would be ~7200.
    expect(r.baseLoad).toBeGreaterThan(30);
    expect(r.baseLoad).toBeLessThan(80);
  });

  it('Tier A+ equivalentEasyKm does not slam into the 25 km cap', () => {
    const r = computeUniversalLoad(tennisITrimpInput, 'half');
    // Sane band: 1 hour of tennis should replace at most a short easy run,
    // not a full long run.
    expect(r.equivalentEasyKm).toBeLessThan(10);
    expect(r.equivalentEasyKm).toBeGreaterThan(0);
  });

  it('Tier A+ and Tier C agree to within a factor of 2 for the same session', () => {
    // Same 1-hour tennis session, evaluated with iTrimp vs without (RPE only).
    const withITrimp = computeUniversalLoad(tennisITrimpInput, 'half');
    const withoutITrimp = computeUniversalLoad(
      { ...tennisITrimpInput, iTrimp: undefined },
      'half'
    );

    expect(withITrimp.tier).toBe('itrimp');
    expect(withoutITrimp.tier).toBe('rpe');

    // Different methodologies WILL differ (RPE applies active-fraction +
    // uncertainty penalty; iTRIMP doesn't). The test exists to catch the
    // ORDER-OF-MAGNITUDE failure: pre-fix the ratio was ~70× because Tier A+
    // skipped the iTRIMP→TSS normalisation. Anything inside 0.3–3× is fine.
    const ratio = withITrimp.baseLoad / withoutITrimp.baseLoad;
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(3.0);
  });

  it('synthetic excess-load round-trip stays consistent', () => {
    // excess-load-card.ts builds a synthetic activity with iTrimp = excessTSS × 150.
    // After Tier A+ normalisation that should yield baseLoad ≈ excessTSS × sportMult.
    const excessTSS = 30;
    const synthetic: ActivityInput = {
      sport: 'cross_training',
      durationMin: 60,
      iTrimp: excessTSS * 150,
      rpe: 5,
      fromGarmin: false,
    };
    const r = computeUniversalLoad(synthetic, 'half');
    // cross_training has mult ≈ 1.0; baseLoad should be in the ballpark of excessTSS.
    expect(r.baseLoad).toBeGreaterThan(excessTSS * 0.5);
    expect(r.baseLoad).toBeLessThan(excessTSS * 2.0);
  });
});

// ---------------------------------------------------------------------------
// Phase B v3 — Workout Type Classifier
// ---------------------------------------------------------------------------

function zones(z1: number, z2: number, z3: number, z4: number, z5: number): HRZoneData {
  return { zone1Minutes: z1, zone2Minutes: z2, zone3Minutes: z3, zone4Minutes: z4, zone5Minutes: z5 };
}

// iTRIMP value that produces a given TSS (reverse of the normalisation formula)
function itrimp(tss: number): number {
  return (tss * 15000) / 100;
}

describe('classifyByITrimp', () => {
  it('easy: 55 TSS in 60min → TSS/hr 55 → easy', () => {
    const r = classifyByITrimp(itrimp(55), 60);
    expect(r.type).toBe('easy');
    expect(r.tss).toBeCloseTo(55, 0);
    expect(r.tssPerHour).toBeCloseTo(55, 0);
  });

  it('threshold: 80 TSS/hr → threshold', () => {
    const r = classifyByITrimp(itrimp(80), 60);
    expect(r.type).toBe('threshold');
  });

  it('vo2: 120 TSS/hr → vo2', () => {
    const r = classifyByITrimp(itrimp(120), 60);
    expect(r.type).toBe('vo2');
  });

  it('same iTRIMP but 30min session → double the TSS/hr → upgrades type', () => {
    // 55 TSS in 30min = 110 TSS/hr → vo2
    const r = classifyByITrimp(itrimp(55), 30);
    expect(r.type).toBe('vo2');
    expect(r.tssPerHour).toBeCloseTo(110, 0);
  });

  it('boundary: exactly 70 TSS/hr is NOT easy (not < 70)', () => {
    const r = classifyByITrimp(itrimp(70), 60);
    expect(r.type).toBe('threshold');
  });

  it('boundary: exactly 95 TSS/hr is NOT threshold', () => {
    const r = classifyByITrimp(itrimp(95), 60);
    expect(r.type).toBe('vo2');
  });

  it('custom thresholds: easy < 85 → 80 TSS/hr classified as easy', () => {
    const r = classifyByITrimp(itrimp(80), 60, { easy: 85, tempo: 110 });
    expect(r.type).toBe('easy');
  });
});

describe('classifyByZones', () => {
  it('base-dominant (83% Z1+Z2) → easy', () => {
    // 50min Z1+Z2 out of 60min total
    const r = classifyByZones(zones(30, 20, 5, 3, 2));
    expect(r.type).toBe('easy');
    expect(r.baseRatio).toBeCloseTo(50 / 60, 2);
  });

  it('threshold-dominant (50% Z3) → threshold', () => {
    const r = classifyByZones(zones(5, 5, 25, 5, 10));
    expect(r.type).toBe('threshold');
    expect(r.threshRatio).toBeCloseTo(0.5, 2);
  });

  it('intensity-dominant (40% Z4+Z5) → vo2', () => {
    const r = classifyByZones(zones(10, 10, 10, 10, 10));
    expect(r.type).toBe('vo2');
    expect(r.intensityRatio).toBeCloseTo(0.4, 2);
  });

  it('zero zone data → defaults to easy', () => {
    const r = classifyByZones(zones(0, 0, 0, 0, 0));
    expect(r.type).toBe('easy');
    expect(r.baseRatio).toBe(1);
  });

  it('27% Z4+Z5 does NOT reach vo2 threshold (need > 30%)', () => {
    // Z4+Z5 = 15/55 ≈ 27%
    const r = classifyByZones(zones(30, 0, 10, 6, 9));
    expect(r.intensityRatio).toBeLessThan(0.3);
    expect(r.type).not.toBe('vo2');
  });
});

describe('classifyWorkoutType', () => {
  it('intermittent sport (soccer) uses iTRIMP even when zone data looks easy', () => {
    // Zones look easy (83% base) but soccer is intermittent + iTRIMP says threshold
    const r = classifyWorkoutType({
      sport: 'soccer',
      durationMin: 60,
      iTrimp: itrimp(80), // 80 TSS/hr → threshold
      hrZones: zones(30, 20, 5, 3, 2),
    });
    expect(r.method).toBe('itrimp');
    expect(r.type).toBe('threshold');
  });

  it('cycling (non-intermittent) with high Z4+Z5 (20%) uses iTRIMP', () => {
    const r = classifyWorkoutType({
      sport: 'cycling',
      durationMin: 60,
      iTrimp: itrimp(100),
      hrZones: zones(15, 15, 18, 8, 4), // Z4+Z5 = 12/60 = 20% > 15%
    });
    expect(r.method).toBe('itrimp');
  });

  it('cycling with < 20min zone data uses iTRIMP', () => {
    const r = classifyWorkoutType({
      sport: 'cycling',
      durationMin: 20,
      iTrimp: itrimp(55),
      hrZones: zones(5, 5, 3, 1, 1), // 15min total < 20
    });
    expect(r.method).toBe('itrimp');
  });

  it('steady-state cycling with sufficient zone data and no iTRIMP uses zones', () => {
    const r = classifyWorkoutType({
      sport: 'cycling',
      durationMin: 60,
      hrZones: zones(30, 20, 8, 1, 1), // Z4+Z5 = 2/60 = 3% — steady-state
    });
    expect(r.method).toBe('zones');
    expect(r.type).toBe('easy');
  });

  it('no HR data → profile fallback, type = easy', () => {
    const r = classifyWorkoutType({ sport: 'cycling', durationMin: 45 });
    expect(r.method).toBe('profile');
    expect(r.type).toBe('easy');
  });

  it('runningEquivTSS = tss × sport.runSpec (cycling runSpec=0.55)', () => {
    const r = classifyWorkoutType({
      sport: 'cycling',
      durationMin: 60,
      iTrimp: itrimp(55),
    });
    expect(r.tss).toBeCloseTo(55, 0);
    expect(r.runningEquivTSS).toBeCloseTo(55 * 0.55, 0);
  });

  it('personal thresholds: easy < 90 → 80 TSS/hr is easy', () => {
    const r = classifyWorkoutType({
      sport: 'soccer',
      durationMin: 60,
      iTrimp: itrimp(80),
      thresholds: { easy: 90, tempo: 120 },
    });
    expect(r.type).toBe('easy');
  });

  it('rugby (intermittent, runSpec=0.35) — runningEquivTSS substantially less than raw tss', () => {
    const r = classifyWorkoutType({
      sport: 'rugby',
      durationMin: 80,
      iTrimp: itrimp(100),
    });
    expect(r.runningEquivTSS).toBeCloseTo(r.tss * 0.35, 0);
    expect(r.runningEquivTSS).toBeLessThan(r.tss);
  });
});
