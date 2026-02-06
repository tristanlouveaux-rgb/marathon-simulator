/**
 * physiology-tracker.test.ts
 * ==========================
 * Unit tests for the Physiology Improvement Tracking module.
 *
 * Tests cover:
 * - Expected trajectory calculation
 * - Adaptation ratio computation
 * - Assessment generation
 * - Edge cases and golden tests
 */

import { describe, it, expect } from 'vitest';
import {
  calculateExpectedPhysiology,
  generateExpectedTrajectory,
  computeAdaptationRatio,
  assessAdaptation,
  recordMeasurement,
  initializePhysiologyTracking,
  comparePhysiology,
  projectPhysiology,
  type PhysiologyMeasurement,
  type PhysiologyTrackingState,
} from './physiology-tracker';
import { ADAPTATION_THRESHOLDS } from '@/constants/physiology';

describe('calculateExpectedPhysiology', () => {
  it('should return correct expected LT at week 1 (no improvement yet)', () => {
    const result = calculateExpectedPhysiology(300, 50, 1, 45);

    expect(result.expectedLT).toBe(300);  // Week 1 = initial
    expect(result.expectedVO2).toBe(50);
    expect(result.week).toBe(1);
  });

  it('should show LT improvement (faster pace) after weeks of training', () => {
    const initialLT = 300;  // 5:00/km
    const result = calculateExpectedPhysiology(initialLT, 50, 8, 45);

    // LT should decrease (get faster) over time
    expect(result.expectedLT).toBeLessThan(initialLT);
    expect(result.expectedLT).toBeGreaterThan(250);  // Sanity check
  });

  it('should show VO2 improvement (higher value) after weeks of training', () => {
    const initialVO2 = 50;
    const result = calculateExpectedPhysiology(300, initialVO2, 8, 45);

    // VO2 should increase over time
    expect(result.expectedVO2).toBeGreaterThan(initialVO2);
    expect(result.expectedVO2).toBeLessThan(60);  // Sanity check
  });

  it('should return null values when initial values are null', () => {
    const result = calculateExpectedPhysiology(null, null, 5, 45);

    expect(result.expectedLT).toBeNull();
    expect(result.expectedVO2).toBeNull();
    expect(result.ltLowerBound).toBeNull();
    expect(result.ltUpperBound).toBeNull();
  });

  it('should provide confidence bounds', () => {
    const result = calculateExpectedPhysiology(300, 50, 5, 45);

    // LT bounds: lower = faster (better), upper = slower (worse)
    expect(result.ltLowerBound).toBeLessThan(result.expectedLT!);
    expect(result.ltUpperBound).toBeGreaterThan(result.expectedLT!);

    // VO2 bounds: lower = worse, upper = better
    expect(result.vo2LowerBound).toBeLessThan(result.expectedVO2!);
    expect(result.vo2UpperBound).toBeGreaterThan(result.expectedVO2!);
  });

  it('should show higher gains for beginners vs advanced', () => {
    const initialLT = 300;
    const initialVO2 = 50;

    const beginnerResult = calculateExpectedPhysiology(initialLT, initialVO2, 12, 28);  // Low VDOT = beginner
    const advancedResult = calculateExpectedPhysiology(initialLT, initialVO2, 12, 55);  // High VDOT = advanced

    // Beginners should have bigger LT improvement (lower pace)
    expect(beginnerResult.expectedLT).toBeLessThan(advancedResult.expectedLT!);
    // Beginners should have bigger VO2 improvement (higher value)
    expect(beginnerResult.expectedVO2).toBeGreaterThan(advancedResult.expectedVO2!);
  });
});

describe('generateExpectedTrajectory', () => {
  it('should generate trajectory for all weeks', () => {
    const trajectory = generateExpectedTrajectory(300, 50, 16, 45);

    expect(trajectory).toHaveLength(16);
    expect(trajectory[0].week).toBe(1);
    expect(trajectory[15].week).toBe(16);
  });

  it('should show monotonic improvement over time', () => {
    const trajectory = generateExpectedTrajectory(300, 50, 12, 45);

    for (let i = 1; i < trajectory.length; i++) {
      // LT should get lower (faster) each week
      expect(trajectory[i].expectedLT).toBeLessThanOrEqual(trajectory[i - 1].expectedLT!);
      // VO2 should get higher each week
      expect(trajectory[i].expectedVO2).toBeGreaterThanOrEqual(trajectory[i - 1].expectedVO2!);
    }
  });
});

describe('computeAdaptationRatio', () => {
  it('should return default ratio with no measurements', () => {
    const ratio = computeAdaptationRatio([], 300, 50, 45);

    expect(ratio).toBe(ADAPTATION_THRESHOLDS.defaultRatio);
  });

  it('should return ~1.0 when athlete is on track', () => {
    const initialLT = 300;
    const initialVO2 = 50;

    // Calculate expected at week 8
    const expected = calculateExpectedPhysiology(initialLT, initialVO2, 8, 45);

    // Athlete is exactly on track
    const measurement: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: expected.expectedLT,
      vo2max: expected.expectedVO2,
      source: 'watch',
    };

    const ratio = computeAdaptationRatio([measurement], initialLT, initialVO2, 45);

    expect(ratio).toBeCloseTo(1.0, 1);
  });

  it('should return >1.0 when athlete improves faster than expected', () => {
    const initialLT = 300;
    const initialVO2 = 50;

    // Calculate expected at week 8
    const expected = calculateExpectedPhysiology(initialLT, initialVO2, 8, 45);

    // Athlete improved more than expected (faster LT, higher VO2)
    const measurement: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: expected.expectedLT! - 5,  // 5 sec/km faster
      vo2max: expected.expectedVO2! + 2,       // 2 higher VO2
      source: 'watch',
    };

    const ratio = computeAdaptationRatio([measurement], initialLT, initialVO2, 45);

    expect(ratio).toBeGreaterThan(1.0);
  });

  it('should return <1.0 when athlete improves slower than expected', () => {
    const initialLT = 300;
    const initialVO2 = 50;

    // Calculate expected at week 8
    const expected = calculateExpectedPhysiology(initialLT, initialVO2, 8, 45);

    // Athlete improved less than expected (slower LT, lower VO2)
    const measurement: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: expected.expectedLT! + 5,  // 5 sec/km slower
      vo2max: expected.expectedVO2! - 1,       // 1 lower VO2
      source: 'watch',
    };

    const ratio = computeAdaptationRatio([measurement], initialLT, initialVO2, 45);

    expect(ratio).toBeLessThan(1.0);
  });

  it('should clamp ratio to valid bounds', () => {
    const initialLT = 300;

    // Extreme slow progress - should clamp to min
    const slowMeasurement: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: 320,  // Got slower, not faster
      vo2max: null,
      source: 'watch',
    };

    const slowRatio = computeAdaptationRatio([slowMeasurement], initialLT, null, 45);
    expect(slowRatio).toBeGreaterThanOrEqual(ADAPTATION_THRESHOLDS.minRatio);

    // Extreme fast progress - should clamp to max
    const fastMeasurement: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: 250,  // Way faster than possible
      vo2max: null,
      source: 'watch',
    };

    const fastRatio = computeAdaptationRatio([fastMeasurement], initialLT, null, 45);
    expect(fastRatio).toBeLessThanOrEqual(ADAPTATION_THRESHOLDS.maxRatio);
  });

  it('should apply smoothing with multiple measurements', () => {
    const initialLT = 300;

    const measurements: PhysiologyMeasurement[] = [
      { week: 4, ltPaceSecKm: 297, vo2max: null, source: 'watch' },  // Slightly ahead
      { week: 8, ltPaceSecKm: 294, vo2max: null, source: 'watch' },  // Still ahead
    ];

    const ratio = computeAdaptationRatio(measurements, initialLT, null, 45);

    // Should be smoothed, not just the latest
    expect(ratio).toBeGreaterThan(1.0);
    expect(ratio).toBeLessThan(2.0);
  });
});

describe('assessAdaptation', () => {
  it('should return needsData status when no baseline', () => {
    const state: PhysiologyTrackingState = {
      initialLT: null,
      initialVO2: null,
      baselineVdot: 45,
      measurements: [],
      currentAdaptationRatio: 1.0,
      lastAssessment: null,
    };

    const assessment = assessAdaptation(state, 5);

    expect(assessment.status).toBe('needsData');
    expect(assessment.hasSufficientData).toBe(false);
  });

  it('should return needsData when too early in plan', () => {
    const state: PhysiologyTrackingState = {
      initialLT: 300,
      initialVO2: 50,
      baselineVdot: 45,
      measurements: [],
      currentAdaptationRatio: 1.0,
      lastAssessment: null,
    };

    const assessment = assessAdaptation(state, 1);

    expect(assessment.status).toBe('needsData');
    expect(assessment.hasSufficientData).toBe(false);
  });

  it('should return onTrack for ratio near 1.0', () => {
    const state: PhysiologyTrackingState = {
      initialLT: 300,
      initialVO2: 50,
      baselineVdot: 45,
      measurements: [{ week: 8, ltPaceSecKm: 295, vo2max: 51, source: 'watch' }],
      currentAdaptationRatio: 1.0,
      lastAssessment: null,
    };

    const assessment = assessAdaptation(state, 8);

    expect(assessment.status).toBe('onTrack');
  });

  it('should return excellent for very high adaptation ratio', () => {
    const state: PhysiologyTrackingState = {
      initialLT: 300,
      initialVO2: 50,
      baselineVdot: 45,
      measurements: [{ week: 8, ltPaceSecKm: 285, vo2max: 55, source: 'watch' }],
      currentAdaptationRatio: 1.6,
      lastAssessment: null,
    };

    const assessment = assessAdaptation(state, 8);

    expect(assessment.status).toBe('excellent');
  });

  it('should return concerning for very low adaptation ratio', () => {
    const state: PhysiologyTrackingState = {
      initialLT: 300,
      initialVO2: 50,
      baselineVdot: 45,
      measurements: [{ week: 8, ltPaceSecKm: 305, vo2max: 49, source: 'watch' }],
      currentAdaptationRatio: 0.4,
      lastAssessment: null,
    };

    const assessment = assessAdaptation(state, 8);

    expect(assessment.status).toBe('concerning');
  });
});

describe('recordMeasurement', () => {
  it('should add measurement to history', () => {
    const state = initializePhysiologyTracking(300, 50, 45);
    const measurement: PhysiologyMeasurement = {
      week: 5,
      ltPaceSecKm: 296,
      vo2max: 51,
      source: 'manual',
    };

    const newState = recordMeasurement(state, measurement);

    expect(newState.measurements).toHaveLength(1);
    expect(newState.measurements[0]).toEqual(measurement);
  });

  it('should update adaptation ratio', () => {
    const state = initializePhysiologyTracking(300, 50, 45);
    const measurement: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: 290,  // Better than expected
      vo2max: 53,
      source: 'watch',
    };

    const newState = recordMeasurement(state, measurement);

    expect(newState.currentAdaptationRatio).toBeGreaterThan(1.0);
  });

  it('should generate assessment', () => {
    const state = initializePhysiologyTracking(300, 50, 45);
    const measurement: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: 295,
      vo2max: 51,
      source: 'watch',
    };

    const newState = recordMeasurement(state, measurement);

    expect(newState.lastAssessment).not.toBeNull();
  });
});

describe('comparePhysiology', () => {
  it('should detect LT ahead of schedule', () => {
    const observed: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: 285,  // 5% faster than expected
      vo2max: null,
      source: 'watch',
    };

    const expected = calculateExpectedPhysiology(300, null, 8, 45);
    const comparison = comparePhysiology(observed, expected);

    expect(comparison.ltDeviation?.direction).toBe('ahead');
    expect(comparison.ltDeviation?.pct).toBeGreaterThan(0);
  });

  it('should detect VO2 behind schedule', () => {
    const observed: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: null,
      vo2max: 48,  // Lower than expected
      source: 'watch',
    };

    const expected = calculateExpectedPhysiology(null, 50, 8, 45);
    const comparison = comparePhysiology(observed, expected);

    expect(comparison.vo2Deviation?.direction).toBe('behind');
  });

  it('should detect on-track values', () => {
    const expected = calculateExpectedPhysiology(300, 50, 8, 45);
    const observed: PhysiologyMeasurement = {
      week: 8,
      ltPaceSecKm: expected.expectedLT!,
      vo2max: expected.expectedVO2!,
      source: 'watch',
    };

    const comparison = comparePhysiology(observed, expected);

    expect(comparison.ltDeviation?.direction).toBe('onTrack');
    expect(comparison.vo2Deviation?.direction).toBe('onTrack');
  });
});

describe('projectPhysiology', () => {
  it('should project using adaptation ratio', () => {
    const state: PhysiologyTrackingState = {
      initialLT: 300,
      initialVO2: 50,
      baselineVdot: 45,
      measurements: [],
      currentAdaptationRatio: 1.5,  // Fast responder
      lastAssessment: null,
    };

    const projection = projectPhysiology(state, 12);
    const baseExpected = calculateExpectedPhysiology(300, 50, 12, 45);

    // Fast responder should project better than base expected
    expect(projection.projectedLT).toBeLessThan(baseExpected.expectedLT!);
    expect(projection.projectedVO2).toBeGreaterThan(baseExpected.expectedVO2!);
  });

  it('should project slower for slow responders', () => {
    const state: PhysiologyTrackingState = {
      initialLT: 300,
      initialVO2: 50,
      baselineVdot: 45,
      measurements: [],
      currentAdaptationRatio: 0.5,  // Slow responder
      lastAssessment: null,
    };

    const projection = projectPhysiology(state, 12);
    const baseExpected = calculateExpectedPhysiology(300, 50, 12, 45);

    // Slow responder should project worse than base expected
    expect(projection.projectedLT).toBeGreaterThan(baseExpected.expectedLT!);
    expect(projection.projectedVO2).toBeLessThan(baseExpected.expectedVO2!);
  });
});

/**
 * GOLDEN TESTS
 * These test specific numeric scenarios to catch regressions.
 */
describe('Golden Tests', () => {
  it('intermediate runner, 16-week plan, on-track progress', () => {
    const initialLT = 300;  // 5:00/km
    const initialVO2 = 50;
    const baselineVdot = 45;

    // Week 1: baseline
    const week1 = calculateExpectedPhysiology(initialLT, initialVO2, 1, baselineVdot);
    expect(week1.expectedLT).toBe(300);
    expect(week1.expectedVO2).toBe(50);

    // Week 8: midpoint
    const week8 = calculateExpectedPhysiology(initialLT, initialVO2, 8, baselineVdot);
    expect(week8.expectedLT).toBeCloseTo(294.2, 0);  // ~2% improvement
    expect(week8.expectedVO2).toBeCloseTo(50.6, 0);  // ~1.2% improvement

    // Week 16: end of plan
    const week16 = calculateExpectedPhysiology(initialLT, initialVO2, 16, baselineVdot);
    expect(week16.expectedLT).toBeCloseTo(287.6, 0);  // ~4.1% improvement
    expect(week16.expectedVO2).toBeCloseTo(51.3, 0);  // ~2.6% improvement
  });

  it('novice runner should show higher gains', () => {
    const initialLT = 360;  // 6:00/km (slower = novice)
    const initialVO2 = 40;
    const baselineVdot = 32;  // Low VDOT = novice

    const week16 = calculateExpectedPhysiology(initialLT, initialVO2, 16, baselineVdot);

    // Novice should see bigger improvements
    const ltImprovement = (initialLT - week16.expectedLT!) / initialLT * 100;
    const vo2Improvement = (week16.expectedVO2! - initialVO2) / initialVO2 * 100;

    expect(ltImprovement).toBeGreaterThan(8);  // >8% LT improvement
    expect(vo2Improvement).toBeGreaterThan(6);  // >6% VO2 improvement
  });

  it('adaptation ratio 1.5x should project 50% better gains', () => {
    const state: PhysiologyTrackingState = {
      initialLT: 300,
      initialVO2: 50,
      baselineVdot: 45,
      measurements: [],
      currentAdaptationRatio: 1.5,
      lastAssessment: null,
    };

    const baseExpected = calculateExpectedPhysiology(300, 50, 16, 45);
    const projected = projectPhysiology(state, 16);

    // Check that projected gains are ~50% better than expected
    const expectedLTGain = 300 - baseExpected.expectedLT!;
    const projectedLTGain = 300 - projected.projectedLT!;

    expect(projectedLTGain / expectedLTGain).toBeCloseTo(1.5, 1);
  });
});
