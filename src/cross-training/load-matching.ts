import type { Workout, CrossActivity, LoadBudget } from '@/types';
import { LOAD_BUDGET_CONFIG, SPORTS_DB, ANAEROBIC_WEIGHT } from '@/constants';
import { intensityProfile, rpeFactor, normalizeSport, getRPEMult } from './activities';

/**
 * Calculate vibe similarity between an activity and a workout
 * Higher score = better match
 * @param a1 - Activity aerobic load
 * @param an1 - Activity anaerobic load
 * @param a2 - Workout aerobic load
 * @param an2 - Workout anaerobic load
 * @returns Similarity score (0-1)
 */
export function vibeSimilarity(
  a1: number,
  an1: number,
  a2: number,
  an2: number
): number {
  const p1 = intensityProfile(a1, an1);
  const p2 = intensityProfile(a2, an2);

  // Score based on ratio similarity (60%) and load similarity (40%)
  const ratioScore = 1.0 - Math.abs(p1.anaerobicRatio - p2.anaerobicRatio);
  const loadScore = 1.0 / (1.0 + Math.abs(p1.weighted - p2.weighted) / 30.0);

  return 0.6 * ratioScore + 0.4 * loadScore;
}

/**
 * Apply saturation curve to prevent huge sessions from scaling linearly
 * @param rawLoad - Raw load value
 * @returns Saturated load value
 */
export function applySaturation(rawLoad: number): number {
  const tau = 800;       // Saturation constant
  const maxCredit = 1500; // Maximum credit from any single session
  return maxCredit * (1 - Math.exp(-rawLoad / tau));
}

/**
 * Calculate reduction percentage for a workout based on remaining load
 * @param ratio - Load ratio (activity / workout)
 * @param workoutType - Type of workout being modified
 * @returns Reduction percentage (0-1)
 */
export function calculateReduction(ratio: number, workoutType: string): number {
  // Different caps for different workout types
  if (workoutType === 'easy') {
    return Math.min(ratio * 0.5, 0.5); // Capped at 50% reduction
  } else if (workoutType === 'long') {
    return Math.min(ratio * 0.20, 0.30); // More conservative for long runs
  } else {
    // Quality workouts (threshold, vo2, race_pace)
    return Math.min(ratio * 0.4, 0.40); // More conservative than easy
  }
}

/**
 * Apply distance reduction to a workout description
 * @param description - Original description (e.g., "8km")
 * @param reductionPct - Reduction percentage (0-1)
 * @returns New description with reduction noted
 */
export function reduceWorkoutDistance(description: string, reductionPct: number): string {
  const kmMatch = description.match(/(\d+)km/);
  if (kmMatch) {
    const origKm = parseInt(kmMatch[1]);
    const newKm = Math.round(origKm * (1 - reductionPct));
    return `${newKm}km (was ${origKm}km)`;
  }
  return description;
}

/**
 * Calculate total weighted load for a set of workouts
 * @param workouts - Array of workouts
 * @returns Total weighted load
 */
export function calculateTotalWorkoutLoad(workouts: Workout[]): number {
  return workouts.reduce((sum, w) => {
    const aerobic = w.aerobic || 0;
    const anaerobic = w.anaerobic || 0;
    return sum + aerobic + anaerobic * ANAEROBIC_WEIGHT;
  }, 0);
}

/**
 * Calculate effective load from previous week activities (with decay)
 * @param activities - Previous week activities
 * @returns Decayed load total
 */
export function calculatePreviousWeekLoad(activities: CrossActivity[]): number {
  return activities.reduce((sum, act) => {
    const sportKey = normalizeSport(act.sport);
    const sportData = SPORTS_DB[sportKey] || { mult: 1.0, runSpec: 0.5 };
    const rpeF = rpeFactor(act.rpe);
    const rpeMult = getRPEMult(act.rpe);

    let load = (act.aerobic_load + act.anaerobic_load * ANAEROBIC_WEIGHT);
    load *= sportData.mult * rpeF * rpeMult;
    load *= (0.6 + 0.4 * sportData.runSpec);

    return sum + load * LOAD_BUDGET_CONFIG.previousWeekDecay;
  }, 0);
}

/**
 * Calculate load budget based on workouts and previous week activities
 * @param workouts - This week's workouts
 * @param previousWeekActivities - Previous week's cross-training activities
 * @returns LoadBudget object with budgets and tracking
 */
export function calculateLoadBudget(
  workouts: Workout[],
  previousWeekActivities: CrossActivity[] = []
): LoadBudget {
  const totalWorkoutLoad = calculateTotalWorkoutLoad(workouts);
  const previousWeekLoad = calculatePreviousWeekLoad(previousWeekActivities);

  // Previous week load pre-consumes budget (you're already fatigued)
  const availableLoad = Math.max(0, totalWorkoutLoad - previousWeekLoad * 0.5);

  return {
    replacementBudget: availableLoad * LOAD_BUDGET_CONFIG.maxReplacementPct,
    adjustmentBudget: availableLoad * LOAD_BUDGET_CONFIG.maxAdjustmentPct,
    replacementConsumed: 0,
    adjustmentConsumed: 0,
    totalWorkoutLoad,
    previousWeekLoad,
  };
}
