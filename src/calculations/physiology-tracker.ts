/**
 * Physiology Improvement Tracker
 *
 * This module forecasts expected LT pace and VO2max trends across a training cycle,
 * compares expected vs observed weekly watch updates, and computes a conservative
 * adaptationRatio to adjust predictions.
 *
 * Key concepts:
 * - Expected trajectory: Predicted LT/VO2 at each week based on ability level
 * - Observed values: Actual measurements from watch/user input
 * - Adaptation ratio: How fast the athlete is adapting vs prediction (1.0 = on track)
 */

import { inferLevel } from './fatigue';
import {
  PHYSIOLOGY_GAINS,
  ADAPTATION_THRESHOLDS,
  ADAPTATION_MESSAGES,
  ADAPTATION_SMOOTHING_FACTOR,
} from '@/constants/physiology';
import type { AbilityBand } from '@/types';

/**
 * Physiology measurement point (from watch or manual input)
 */
export interface PhysiologyMeasurement {
  week: number;
  ltPaceSecKm: number | null;  // LT pace in seconds per km
  vo2max: number | null;        // VO2max in ml/kg/min
  source: 'watch' | 'manual' | 'test';  // How the measurement was obtained
  timestamp?: string;           // ISO timestamp of measurement
}

/**
 * Expected physiology values at a given week
 */
export interface ExpectedPhysiology {
  week: number;
  expectedLT: number | null;    // Expected LT pace (sec/km)
  expectedVO2: number | null;   // Expected VO2max
  ltLowerBound: number | null;  // Lower confidence bound for LT
  ltUpperBound: number | null;  // Upper confidence bound for LT
  vo2LowerBound: number | null; // Lower confidence bound for VO2
  vo2UpperBound: number | null; // Upper confidence bound for VO2
}

/**
 * Adaptation assessment result
 */
export interface AdaptationAssessment {
  /** Current adaptation ratio (1.0 = on track) */
  adaptationRatio: number;
  /** LT-specific adaptation ratio */
  ltAdaptationRatio: number | null;
  /** VO2-specific adaptation ratio */
  vo2AdaptationRatio: number | null;
  /** User-facing status message */
  message: string;
  /** Status category for UI styling */
  status: 'excellent' | 'good' | 'onTrack' | 'slow' | 'concerning' | 'needsData';
  /** Percentage deviation from expected (positive = ahead, negative = behind) */
  deviationPct: number;
  /** Is there enough data for meaningful assessment? */
  hasSufficientData: boolean;
}

/**
 * Physiology tracking state for a training cycle
 */
export interface PhysiologyTrackingState {
  /** Initial LT pace at week 1 (sec/km) */
  initialLT: number | null;
  /** Initial VO2max at week 1 */
  initialVO2: number | null;
  /** Baseline VDOT for ability level determination */
  baselineVdot: number;
  /** History of measurements */
  measurements: PhysiologyMeasurement[];
  /** Current smoothed adaptation ratio */
  currentAdaptationRatio: number;
  /** Last assessment result */
  lastAssessment: AdaptationAssessment | null;
}

/**
 * Get the ability level from VDOT for physiology gain lookup.
 * Maps inferLevel output to our PHYSIOLOGY_GAINS keys.
 */
function getPhysiologyLevel(vdot: number): AbilityBand | 'beginner' {
  const level = inferLevel(vdot);
  // inferLevel returns: 'novice' | 'intermediate' | 'advanced' | 'elite'
  // We also have 'beginner' for very low VDOT
  if (vdot < 30) return 'beginner';
  return level as AbilityBand;
}

/**
 * Calculate expected physiology values at a given week.
 *
 * Uses saturating exponential model: actual gains diminish over time.
 * Formula: expected = initial * (1 ± rate * (1 - e^(-week/tau)))
 * Simplified for typical 16-week plans: approximate as linear over that range.
 *
 * @param initialLT - LT pace at week 1 (sec/km)
 * @param initialVO2 - VO2max at week 1
 * @param targetWeek - Week to calculate expected values for
 * @param baselineVdot - Baseline VDOT for ability level
 * @returns Expected LT and VO2 with confidence bounds
 */
export function calculateExpectedPhysiology(
  initialLT: number | null,
  initialVO2: number | null,
  targetWeek: number,
  baselineVdot: number
): ExpectedPhysiology {
  const level = getPhysiologyLevel(baselineVdot);
  const gains = PHYSIOLOGY_GAINS[level];
  const weeksElapsed = Math.max(0, targetWeek - 1);
  const ci = gains.confidenceInterval / 100;

  // LT pace decreases (gets faster) over time
  let expectedLT: number | null = null;
  let ltLower: number | null = null;
  let ltUpper: number | null = null;

  if (initialLT !== null) {
    // LT improves (pace decreases) by ltWeeklyGain per week
    const ltImprovement = 1 - gains.ltWeeklyGain * weeksElapsed;
    expectedLT = initialLT * ltImprovement;

    // Confidence bounds (lower = faster pace = better; upper = slower = worse)
    ltLower = expectedLT * (1 - ci);  // Best case: improving faster
    ltUpper = expectedLT * (1 + ci);  // Worst case: improving slower
  }

  // VO2max increases over time
  let expectedVO2: number | null = null;
  let vo2Lower: number | null = null;
  let vo2Upper: number | null = null;

  if (initialVO2 !== null) {
    // VO2 increases by vo2WeeklyGain per week
    const vo2Improvement = 1 + gains.vo2WeeklyGain * weeksElapsed;
    expectedVO2 = initialVO2 * vo2Improvement;

    // Confidence bounds (lower = worse; upper = better)
    vo2Lower = expectedVO2 * (1 - ci);
    vo2Upper = expectedVO2 * (1 + ci);
  }

  return {
    week: targetWeek,
    expectedLT,
    expectedVO2,
    ltLowerBound: ltLower,
    ltUpperBound: ltUpper,
    vo2LowerBound: vo2Lower,
    vo2UpperBound: vo2Upper,
  };
}

/**
 * Generate expected trajectory for entire training cycle.
 *
 * @param initialLT - LT pace at week 1
 * @param initialVO2 - VO2max at week 1
 * @param totalWeeks - Total weeks in training plan
 * @param baselineVdot - Baseline VDOT
 * @returns Array of expected values for each week
 */
export function generateExpectedTrajectory(
  initialLT: number | null,
  initialVO2: number | null,
  totalWeeks: number,
  baselineVdot: number
): ExpectedPhysiology[] {
  const trajectory: ExpectedPhysiology[] = [];

  for (let week = 1; week <= totalWeeks; week++) {
    trajectory.push(calculateExpectedPhysiology(initialLT, initialVO2, week, baselineVdot));
  }

  return trajectory;
}

/**
 * Calculate adaptation ratio from a single measurement vs expected.
 *
 * adaptationRatio = actualImprovement / expectedImprovement
 * - For LT: improvement is decrease in pace (faster)
 * - For VO2: improvement is increase in value
 *
 * @param measurement - Observed measurement
 * @param expected - Expected values at that week
 * @param initialLT - Initial LT pace
 * @param initialVO2 - Initial VO2max
 * @returns Adaptation ratio (1.0 = on track)
 */
function calculateSingleAdaptationRatio(
  measurement: PhysiologyMeasurement,
  expected: ExpectedPhysiology,
  initialLT: number | null,
  initialVO2: number | null
): { ltRatio: number | null; vo2Ratio: number | null } {
  let ltRatio: number | null = null;
  let vo2Ratio: number | null = null;

  // LT adaptation ratio
  if (measurement.ltPaceSecKm !== null && expected.expectedLT !== null && initialLT !== null) {
    const expectedImprovement = initialLT - expected.expectedLT;
    const actualImprovement = initialLT - measurement.ltPaceSecKm;

    if (expectedImprovement > 0) {
      ltRatio = actualImprovement / expectedImprovement;
    } else if (actualImprovement > 0) {
      // Expected no improvement but got some
      ltRatio = 1.5;
    } else {
      ltRatio = 1.0;
    }
  }

  // VO2 adaptation ratio
  if (measurement.vo2max !== null && expected.expectedVO2 !== null && initialVO2 !== null) {
    const expectedImprovement = expected.expectedVO2 - initialVO2;
    const actualImprovement = measurement.vo2max - initialVO2;

    if (expectedImprovement > 0) {
      vo2Ratio = actualImprovement / expectedImprovement;
    } else if (actualImprovement > 0) {
      vo2Ratio = 1.5;
    } else {
      vo2Ratio = 1.0;
    }
  }

  return { ltRatio, vo2Ratio };
}

/**
 * Clamp adaptation ratio to valid bounds.
 */
function clampRatio(ratio: number): number {
  return Math.max(
    ADAPTATION_THRESHOLDS.minRatio,
    Math.min(ADAPTATION_THRESHOLDS.maxRatio, ratio)
  );
}

/**
 * Compute smoothed adaptation ratio from multiple measurements.
 * Uses exponential smoothing: new = α * latest + (1-α) * previous
 *
 * @param measurements - All measurements
 * @param initialLT - Initial LT pace
 * @param initialVO2 - Initial VO2max
 * @param baselineVdot - Baseline VDOT
 * @param previousRatio - Previous smoothed ratio (or null for first calculation)
 * @returns Updated smoothed adaptation ratio
 */
export function computeAdaptationRatio(
  measurements: PhysiologyMeasurement[],
  initialLT: number | null,
  initialVO2: number | null,
  baselineVdot: number,
  previousRatio: number | null = null
): number {
  if (measurements.length === 0) {
    return ADAPTATION_THRESHOLDS.defaultRatio;
  }

  // Sort by week to process in order
  const sorted = [...measurements].sort((a, b) => a.week - b.week);
  let smoothedRatio = previousRatio ?? ADAPTATION_THRESHOLDS.defaultRatio;

  for (const measurement of sorted) {
    const expected = calculateExpectedPhysiology(initialLT, initialVO2, measurement.week, baselineVdot);
    const { ltRatio, vo2Ratio } = calculateSingleAdaptationRatio(
      measurement, expected, initialLT, initialVO2
    );

    // Combine LT and VO2 ratios (prefer LT as it's more trainable/responsive)
    let latestRatio: number | null = null;
    if (ltRatio !== null && vo2Ratio !== null) {
      latestRatio = ltRatio * 0.6 + vo2Ratio * 0.4;  // LT weighted higher
    } else if (ltRatio !== null) {
      latestRatio = ltRatio;
    } else if (vo2Ratio !== null) {
      latestRatio = vo2Ratio;
    }

    if (latestRatio !== null) {
      // Exponential smoothing
      smoothedRatio = ADAPTATION_SMOOTHING_FACTOR * latestRatio +
                      (1 - ADAPTATION_SMOOTHING_FACTOR) * smoothedRatio;
    }
  }

  return clampRatio(smoothedRatio);
}

/**
 * Assess current adaptation status and generate user-facing message.
 *
 * @param state - Current physiology tracking state
 * @param currentWeek - Current training week
 * @param minWeeksForAssessment - Minimum weeks needed for meaningful assessment
 * @returns Assessment result with message and status
 */
export function assessAdaptation(
  state: PhysiologyTrackingState,
  currentWeek: number,
  minWeeksForAssessment: number = 3
): AdaptationAssessment {
  const level = getPhysiologyLevel(state.baselineVdot);
  const gains = PHYSIOLOGY_GAINS[level];

  // Check if we have enough data
  if (state.initialLT === null && state.initialVO2 === null) {
    return {
      adaptationRatio: ADAPTATION_THRESHOLDS.defaultRatio,
      ltAdaptationRatio: null,
      vo2AdaptationRatio: null,
      message: ADAPTATION_MESSAGES.noBaseline,
      status: 'needsData',
      deviationPct: 0,
      hasSufficientData: false,
    };
  }

  // Check if enough weeks have passed for meaningful assessment
  if (currentWeek < gains.minWeeksForChange || state.measurements.length === 0) {
    return {
      adaptationRatio: state.currentAdaptationRatio,
      ltAdaptationRatio: null,
      vo2AdaptationRatio: null,
      message: ADAPTATION_MESSAGES.needsMoreData,
      status: 'needsData',
      deviationPct: 0,
      hasSufficientData: false,
    };
  }

  // Get latest measurement
  const latestMeasurement = state.measurements
    .sort((a, b) => b.week - a.week)[0];

  const expected = calculateExpectedPhysiology(
    state.initialLT, state.initialVO2, latestMeasurement.week, state.baselineVdot
  );

  const { ltRatio, vo2Ratio } = calculateSingleAdaptationRatio(
    latestMeasurement, expected, state.initialLT, state.initialVO2
  );

  // Calculate deviation percentage
  const ratio = state.currentAdaptationRatio;
  const deviationPct = (ratio - 1) * 100;

  // Determine status and message
  let status: AdaptationAssessment['status'];
  let message: string;

  if (Math.abs(deviationPct) < ADAPTATION_THRESHOLDS.meaningfulDeviationPct) {
    status = 'onTrack';
    message = ADAPTATION_MESSAGES.onTrack;
  } else if (ratio >= ADAPTATION_THRESHOLDS.significantlyAheadThreshold) {
    status = 'excellent';
    message = ADAPTATION_MESSAGES.significantlyAhead;
  } else if (ratio >= ADAPTATION_THRESHOLDS.fastResponderThreshold) {
    status = 'good';
    message = ADAPTATION_MESSAGES.slightlyAhead;
  } else if (ratio <= ADAPTATION_THRESHOLDS.significantlyBehindThreshold) {
    status = 'concerning';
    message = ADAPTATION_MESSAGES.significantlyBehind;
  } else if (ratio <= ADAPTATION_THRESHOLDS.slowResponderThreshold) {
    status = 'slow';
    message = ADAPTATION_MESSAGES.slightlyBehind;
  } else {
    status = 'onTrack';
    message = ADAPTATION_MESSAGES.onTrack;
  }

  return {
    adaptationRatio: ratio,
    ltAdaptationRatio: ltRatio,
    vo2AdaptationRatio: vo2Ratio,
    message,
    status,
    deviationPct,
    hasSufficientData: true,
  };
}

/**
 * Record a new physiology measurement and update tracking state.
 *
 * @param state - Current tracking state
 * @param measurement - New measurement to record
 * @returns Updated tracking state
 */
export function recordMeasurement(
  state: PhysiologyTrackingState,
  measurement: PhysiologyMeasurement
): PhysiologyTrackingState {
  // Add measurement to history
  const measurements = [...state.measurements, measurement];

  // Recompute adaptation ratio with new data
  const newRatio = computeAdaptationRatio(
    measurements,
    state.initialLT,
    state.initialVO2,
    state.baselineVdot,
    state.currentAdaptationRatio
  );

  // Generate new assessment
  const assessment = assessAdaptation(
    { ...state, measurements, currentAdaptationRatio: newRatio },
    measurement.week
  );

  return {
    ...state,
    measurements,
    currentAdaptationRatio: newRatio,
    lastAssessment: assessment,
  };
}

/**
 * Initialize a new physiology tracking state.
 *
 * @param initialLT - Initial LT pace (sec/km)
 * @param initialVO2 - Initial VO2max
 * @param baselineVdot - Baseline VDOT for ability level
 * @returns New tracking state
 */
export function initializePhysiologyTracking(
  initialLT: number | null,
  initialVO2: number | null,
  baselineVdot: number
): PhysiologyTrackingState {
  return {
    initialLT,
    initialVO2,
    baselineVdot,
    measurements: [],
    currentAdaptationRatio: ADAPTATION_THRESHOLDS.defaultRatio,
    lastAssessment: null,
  };
}

/**
 * Compare observed vs expected physiology and return deviation details.
 * Used for detailed UI display.
 *
 * @param observed - Observed measurement
 * @param expected - Expected values
 * @returns Detailed comparison
 */
export function comparePhysiology(
  observed: PhysiologyMeasurement,
  expected: ExpectedPhysiology
): {
  ltDeviation: { value: number; pct: number; direction: 'ahead' | 'behind' | 'onTrack' } | null;
  vo2Deviation: { value: number; pct: number; direction: 'ahead' | 'behind' | 'onTrack' } | null;
} {
  let ltDeviation: { value: number; pct: number; direction: 'ahead' | 'behind' | 'onTrack' } | null = null;
  let vo2Deviation: { value: number; pct: number; direction: 'ahead' | 'behind' | 'onTrack' } | null = null;

  // LT comparison (lower = better)
  if (observed.ltPaceSecKm !== null && expected.expectedLT !== null) {
    const diff = observed.ltPaceSecKm - expected.expectedLT;  // negative = ahead
    const pct = (diff / expected.expectedLT) * 100;
    let direction: 'ahead' | 'behind' | 'onTrack';

    if (Math.abs(pct) < ADAPTATION_THRESHOLDS.meaningfulDeviationPct) {
      direction = 'onTrack';
    } else if (diff < 0) {
      direction = 'ahead';  // Faster than expected = ahead
    } else {
      direction = 'behind';  // Slower than expected = behind
    }

    ltDeviation = { value: Math.abs(diff), pct: Math.abs(pct), direction };
  }

  // VO2 comparison (higher = better)
  if (observed.vo2max !== null && expected.expectedVO2 !== null) {
    const diff = observed.vo2max - expected.expectedVO2;  // positive = ahead
    const pct = (diff / expected.expectedVO2) * 100;
    let direction: 'ahead' | 'behind' | 'onTrack';

    if (Math.abs(pct) < ADAPTATION_THRESHOLDS.meaningfulDeviationPct) {
      direction = 'onTrack';
    } else if (diff > 0) {
      direction = 'ahead';  // Higher than expected = ahead
    } else {
      direction = 'behind';  // Lower than expected = behind
    }

    vo2Deviation = { value: Math.abs(diff), pct: Math.abs(pct), direction };
  }

  return { ltDeviation, vo2Deviation };
}

/**
 * Project future physiology values using current adaptation ratio.
 *
 * @param state - Current tracking state
 * @param targetWeek - Week to project to
 * @returns Projected LT and VO2 values
 */
export function projectPhysiology(
  state: PhysiologyTrackingState,
  targetWeek: number
): { projectedLT: number | null; projectedVO2: number | null } {
  const level = getPhysiologyLevel(state.baselineVdot);
  const gains = PHYSIOLOGY_GAINS[level];
  const weeksElapsed = Math.max(0, targetWeek - 1);
  const ratio = state.currentAdaptationRatio;

  // Apply adaptation ratio to expected gains
  let projectedLT: number | null = null;
  if (state.initialLT !== null) {
    const adjustedGain = gains.ltWeeklyGain * ratio;
    projectedLT = state.initialLT * (1 - adjustedGain * weeksElapsed);
  }

  let projectedVO2: number | null = null;
  if (state.initialVO2 !== null) {
    const adjustedGain = gains.vo2WeeklyGain * ratio;
    projectedVO2 = state.initialVO2 * (1 + adjustedGain * weeksElapsed);
  }

  return { projectedLT, projectedVO2 };
}
