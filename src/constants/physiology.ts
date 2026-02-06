/**
 * Physiology Improvement Constants
 *
 * Expected weekly gains by experience level for LT pace and VO2max.
 * These values are conservative estimates based on research for:
 * - Properly structured training programs
 * - Typical recreational to competitive runners
 * - 12-20 week training cycles
 */

import type { AbilityBand } from '@/types';

/** Expected weekly gains by ability level */
export interface PhysiologyGains {
  /** Weekly VO2max improvement rate (fractional, e.g., 0.005 = 0.5%) */
  vo2WeeklyGain: number;
  /** Weekly LT pace improvement rate (fractional, e.g., 0.007 = 0.7%) */
  ltWeeklyGain: number;
  /** Minimum weeks before detectable change */
  minWeeksForChange: number;
  /** Confidence interval (±%) for gains */
  confidenceInterval: number;
}

/**
 * Expected physiological gains by ability band.
 *
 * Research basis:
 * - Novice: Highest gains due to "newbie gains" and large training stimulus
 * - Intermediate: Moderate gains with structured training
 * - Advanced: Smaller marginal gains as approaching genetic ceiling
 * - Elite: Minimal gains, optimization and consistency key
 *
 * LT gains are typically 1.5-2x VO2 gains because LT is more trainable.
 */
export const PHYSIOLOGY_GAINS: Record<AbilityBand | 'beginner', PhysiologyGains> = {
  beginner: {
    vo2WeeklyGain: 0.006,      // 0.6%/week VO2 gain
    ltWeeklyGain: 0.008,       // 0.8%/week LT improvement (pace gets faster)
    minWeeksForChange: 2,      // Beginners see changes quickly
    confidenceInterval: 40,    // High variability
  },
  novice: {
    vo2WeeklyGain: 0.0055,     // 0.55%/week VO2 gain
    ltWeeklyGain: 0.007,       // 0.7%/week LT improvement
    minWeeksForChange: 3,
    confidenceInterval: 35,
  },
  intermediate: {
    vo2WeeklyGain: 0.00175,    // 0.175%/week VO2 gain
    ltWeeklyGain: 0.00275,     // 0.275%/week LT improvement
    minWeeksForChange: 4,
    confidenceInterval: 25,
  },
  advanced: {
    vo2WeeklyGain: 0.001,      // 0.1%/week VO2 gain
    ltWeeklyGain: 0.00165,     // 0.165%/week LT improvement
    minWeeksForChange: 5,
    confidenceInterval: 20,
  },
  elite: {
    vo2WeeklyGain: 0.0005,     // 0.05%/week VO2 gain
    ltWeeklyGain: 0.00075,     // 0.075%/week LT improvement
    minWeeksForChange: 6,
    confidenceInterval: 15,
  },
};

/**
 * Adaptation ratio bounds and thresholds.
 *
 * adaptationRatio = actualImprovement / expectedImprovement
 * - 1.0 = exactly on track
 * - >1.0 = improving faster than expected (super responder)
 * - <1.0 = improving slower than expected (slow responder)
 */
export const ADAPTATION_THRESHOLDS = {
  /** Minimum adaptation ratio to clamp to (prevents predictions from going too pessimistic) */
  minRatio: 0.3,
  /** Maximum adaptation ratio to clamp to (prevents unrealistic optimism) */
  maxRatio: 2.0,
  /** Default ratio when no data available */
  defaultRatio: 1.0,
  /** Threshold for "fast responder" message */
  fastResponderThreshold: 1.3,
  /** Threshold for "slow responder" warning */
  slowResponderThreshold: 0.7,
  /** Threshold for "significantly ahead" */
  significantlyAheadThreshold: 1.5,
  /** Threshold for "significantly behind" */
  significantlyBehindThreshold: 0.5,
  /** Minimum percentage deviation to consider meaningful */
  meaningfulDeviationPct: 1.5,
};

/**
 * User-facing message templates based on adaptation status.
 */
export const ADAPTATION_MESSAGES = {
  onTrack: 'Your fitness is tracking as expected. Keep up the consistency!',
  slightlyAhead: 'You\'re improving slightly faster than average. Great work!',
  significantlyAhead: 'Excellent progress! You\'re responding very well to training.',
  slightlyBehind: 'Progress is slightly slower than expected. This is normal - stay consistent.',
  significantlyBehind: 'Progress is slower than expected. Consider: more recovery, nutrition check, or deload.',
  needsMoreData: 'Complete more weeks to see meaningful physiology trends.',
  noBaseline: 'Update your current LT/VO2 values to enable physiology tracking.',
};

/**
 * Smoothing factor for rolling adaptation ratio calculation.
 * Higher = more weight on recent measurements.
 * Range: 0.1 (heavy smoothing) to 0.9 (reactive to changes)
 */
export const ADAPTATION_SMOOTHING_FACTOR = 0.4;
