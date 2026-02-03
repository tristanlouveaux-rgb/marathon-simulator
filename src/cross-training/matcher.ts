import type { Week, Workout, CrossActivity, SportKey, LoadBudget, CrossTrainingSummary } from '@/types';
import { SPORTS_DB, LOAD_BUDGET_CONFIG } from '@/constants';
import {
  normalizeSport,
  rpeFactor,
  weightedLoad,
  isHardDay,
  canTouchWorkout,
  aggregateActivitiesWithDecay
} from './activities';
import {
  vibeSimilarity,
  applySaturation,
  calculateReduction,
  reduceWorkoutDistance,
  calculateLoadBudget
} from './load-matching';
import { calculateWorkoutLoad } from '@/workouts';

/**
 * Apply cross-training modifications to this week's workouts
 * Uses load-based budgets instead of count-based limits
 * @param wk - Week data object
 * @param workouts - Array of workouts
 * @param activities - Cross-training activities to apply
 * @param previousWeekActivities - Previous week's activities (for 2-week aggregation)
 * @returns Modified workouts array
 */
export function applyCrossTrainingToWorkouts(
  wk: Week,
  workouts: Workout[],
  activities: CrossActivity[],
  previousWeekActivities: CrossActivity[] = []
): Workout[] {
  if (!activities || activities.length === 0) return workouts;

  // Clone workouts to avoid mutation
  const modifiedWorkouts = workouts.map(w => ({ ...w }));

  // Calculate load budget based on workouts and previous week
  const budget = calculateLoadBudget(modifiedWorkouts, previousWeekActivities);

  // Track summary statistics
  let totalLoadApplied = 0;
  let totalLoadOverflow = 0;
  let workoutsReplaced = 0;
  let workoutsReduced = 0;

  // Process each activity
  for (const act of activities) {
    const sport = normalizeSport(act.sport) as SportKey;
    const sp = SPORTS_DB[sport];
    if (!sp) continue;

    const hasGarminData = act.fromGarmin === true;

    // Calculate effective activity load
    const recMult = sp.mult || 1.0;
    const runSpec = sp.runSpec || 0.6;
    const rpeF = rpeFactor(act.rpe);

    let aEff = act.aerobic_load * rpeF * recMult;
    let anEff = act.anaerobic_load * rpeF * recMult;

    // Apply running specificity
    const specMult = 0.6 + 0.4 * runSpec;
    aEff *= specMult;
    anEff *= specMult;

    // Apply saturation curve
    const rawLoad = weightedLoad(aEff, anEff);
    const saturatedLoad = applySaturation(rawLoad);
    let remainingLoad = saturatedLoad;

    // For extra_run, try direct match first
    if (sport === 'extra_run') {
      const directMatch = findDirectMatch(
        modifiedWorkouts,
        wk,
        act.duration_min,
        act.rpe,
        hasGarminData,
        sport
      );
      if (directMatch.matched) {
        workoutsReplaced++;
        totalLoadApplied += directMatch.loadConsumed;
        budget.replacementConsumed += directMatch.loadConsumed;
        remainingLoad = 0;
      }
    }

    // Apply remaining load to workouts using budget-based limits
    const loadThreshold = LOAD_BUDGET_CONFIG.minLoadToTrigger;
    let iterations = 0;
    const maxIterations = 10; // Allow more iterations since budget controls limits

    while (remainingLoad > loadThreshold && iterations < maxIterations) {
      iterations++;

      // Check if budget is exhausted
      const replacementBudgetRemaining = budget.replacementBudget - budget.replacementConsumed;
      const adjustmentBudgetRemaining = budget.adjustmentBudget - budget.adjustmentConsumed;

      if (replacementBudgetRemaining <= 0 && adjustmentBudgetRemaining <= 0) {
        break;
      }

      // Find best workout to match
      const canReplace = replacementBudgetRemaining > loadThreshold;
      const bestMatch = findBestWorkoutMatch(
        modifiedWorkouts,
        wk,
        sport,
        aEff,
        anEff,
        hasGarminData,
        !canReplace
      );

      if (bestMatch.idx === -1) break;

      const w = modifiedWorkouts[bestMatch.idx];
      const wt = w.t.toLowerCase();
      const wLoad = weightedLoad(w.aerobic || 0, w.anaerobic || 0);

      if (wLoad <= 0) {
        w.status = 'skipped';
        break;
      }

      const ratio = remainingLoad / wLoad;

      // Apply modification based on workout type and available budget
      const result = applyWorkoutModification(
        w,
        wt,
        ratio,
        sport,
        hasGarminData,
        aEff,
        anEff,
        wLoad,
        canReplace && wLoad <= replacementBudgetRemaining,
        adjustmentBudgetRemaining > 0
      );

      if (result.wasReplaced) {
        const expectedRPE = w.rpe || w.r || 5;
        wk.rated[w.n] = expectedRPE;
        w.autoCompleted = true;
        w.completedBySport = sport;
        budget.replacementConsumed += result.loadConsumed;
        workoutsReplaced++;
      } else if (result.wasAdjusted) {
        budget.adjustmentConsumed += result.loadConsumed;
        workoutsReduced++;
      }

      totalLoadApplied += result.loadConsumed;
      remainingLoad -= result.loadConsumed;
      if (result.loadConsumed <= 0) break;
    }

    // Track overflow load
    if (remainingLoad > loadThreshold) {
      totalLoadOverflow += remainingLoad;
      if (sport === 'extra_run') {
        wk.extraRunLoad = (wk.extraRunLoad || 0) + remainingLoad;
      } else {
        const sportData = SPORTS_DB[sport] || { runSpec: 0.5 };
        const creditedLoad = remainingLoad * sportData.runSpec;
        wk.unspentLoad = (wk.unspentLoad || 0) + creditedLoad;
      }
    }
  }

  // Store cross-training summary
  wk.crossTrainingSummary = {
    totalLoadApplied,
    totalLoadOverflow,
    workoutsReplaced,
    workoutsReduced,
    budgetUtilization: {
      replacement: budget.replacementBudget > 0
        ? budget.replacementConsumed / budget.replacementBudget
        : 0,
      adjustment: budget.adjustmentBudget > 0
        ? budget.adjustmentConsumed / budget.adjustmentBudget
        : 0,
    },
  };

  // Calculate VDOT bonus from accumulated overflow loads
  calculateCrossTrainingBonus(wk);

  return modifiedWorkouts;
}

/**
 * Find a direct match for an extra run activity
 * Returns matched status and load consumed for budget tracking
 */
function findDirectMatch(
  workouts: Workout[],
  wk: Week,
  activityDuration: number,
  activityRPE: number,
  hasGarminData: boolean,
  sport: string
): { matched: boolean; loadConsumed: number } {
  for (let i = 0; i < workouts.length; i++) {
    const w = workouts[i];
    if (w.status && w.status !== 'planned') continue;
    if (wk.rated && wk.rated[w.n]) continue;
    if (w.t !== 'easy' && w.t !== 'long') continue;

    const distMatch = w.d.match(/^(\d+)km$/);
    if (!distMatch) continue;

    const workoutDistKm = parseFloat(distMatch[1]);
    const workoutRPE = w.rpe || w.r || 3;
    const estimatedMinutes = workoutDistKm * 5;

    const durationRatio = activityDuration / estimatedMinutes;
    const rpeMatches = Math.abs(activityRPE - workoutRPE) <= 1;

    if (durationRatio >= 0.8 && durationRatio <= 1.2 && rpeMatches) {
      const wLoad = weightedLoad(w.aerobic || 0, w.anaerobic || 0);
      w.status = 'replaced';
      w.modReason = `Replaced by extra_run (${activityDuration}min @ RPE${activityRPE})`;
      w.confidence = hasGarminData ? 'high' : 'medium';
      w.originalDistance = w.d;
      w.d = '0km (replaced)';
      wk.rated[w.n] = workoutRPE;
      w.autoCompleted = true;
      w.completedBySport = sport;
      return { matched: true, loadConsumed: wLoad };
    }
  }
  return { matched: false, loadConsumed: 0 };
}

/**
 * Find the best workout to match with remaining load
 */
function findBestWorkoutMatch(
  workouts: Workout[],
  wk: Week,
  sport: SportKey,
  aEff: number,
  anEff: number,
  hasGarminData: boolean,
  skipReplacements: boolean
): { idx: number; score: number } {
  let bestIdx = -1;
  let bestScore = -1;

  for (let i = 0; i < workouts.length; i++) {
    const w = workouts[i];
    if (w.status && w.status !== 'planned') continue;
    if (wk.rated && wk.rated[w.n]) continue;

    const wt = w.t.toLowerCase();

    // Long runs must NEVER be fully replaced — only reduced (adjust-only)
    if (wt === 'long' && !skipReplacements) {
      continue;
    }



    // Skip workouts that this sport cannot modify
    if (!canTouchWorkout(sport, wt)) {
      continue;
    }

    if (!hasGarminData && (wt === 'threshold' || wt === 'vo2' || wt === 'race_pace')) {
      if (skipReplacements) continue;
    }

    const sim = vibeSimilarity(aEff, anEff, w.aerobic || 0, w.anaerobic || 0);
    let score = sim;

    if (wt === 'long') score -= 0.20;
    if (!hasGarminData && wt === 'easy') score += 0.15;

    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return { idx: bestIdx, score: bestScore };
}

/**
 * Apply modification to a workout based on type and available load
 */
function applyWorkoutModification(
  w: Workout,
  wt: string,
  ratio: number,
  sport: string,
  hasGarminData: boolean,
  aEff: number,
  anEff: number,
  wLoad: number,
  canReplace: boolean,
  canAdjust: boolean
): { loadConsumed: number; wasReplaced: boolean; wasAdjusted: boolean } {
  let loadConsumed = 0;
  let wasReplaced = false;
  let wasAdjusted = false;

  if (wt === 'easy') {
    if (ratio >= 0.9 && canReplace) {
      w.status = 'replaced';
      w.originalDistance = w.d;
      w.d = '0km (replaced)';
      w.modReason = `Replaced by ${sport}${!hasGarminData ? ' (RPE-only)' : ''}`;
      w.confidence = hasGarminData ? 'high' : 'medium';
      loadConsumed = wLoad;
      wasReplaced = true;
    } else if (ratio >= 0.3 && canAdjust) {
      const reducePct = calculateReduction(ratio, 'easy');
      w.status = 'reduced';
      w.originalDistance = w.d;
      w.d = reduceWorkoutDistance(w.d, reducePct);
      w.modReason = `Reduced ${(reducePct * 100).toFixed(0)}% due to ${sport}${!hasGarminData ? ' (RPE-only)' : ''}`;
      w.confidence = hasGarminData ? 'high' : 'medium';
      loadConsumed = wLoad * reducePct;
      wasAdjusted = true;
    }
  } else if (wt === 'threshold' || wt === 'vo2' || wt === 'race_pace') {
    if (hasGarminData && ratio >= 0.85 && isHardDay(aEff, anEff) && canReplace) {
      w.status = 'replaced';
      w.originalDistance = w.d;
      w.d = '4km shakeout + 4 strides';
      w.modReason = `Quality replaced by ${sport} (confirmed hard day)`;
      w.confidence = 'high';
      loadConsumed = wLoad;
      wasReplaced = true;
    } else if (ratio >= 0.3 && canAdjust) {
      const reducePct = calculateReduction(ratio, 'quality');
      w.status = 'reduced';
      w.originalDistance = w.d;
      w.modReason = `Quality reduced ${(reducePct * 100).toFixed(0)}% due to ${sport}${!hasGarminData ? ' (fatigue, RPE-only)' : ''}`;
      w.confidence = hasGarminData ? 'high' : 'low';
      loadConsumed = wLoad * reducePct;
      wasAdjusted = true;
    }
  } else if (wt === 'long') {
    if (ratio >= 0.15 && canAdjust) {
      const reducePct = calculateReduction(ratio, 'long');
      w.status = 'reduced';
      w.originalDistance = w.d;
      w.d = reduceWorkoutDistance(w.d, reducePct);
      w.modReason = `Long run shortened ${(reducePct * 100).toFixed(0)}% due to ${sport}. KEEP EASY!`;
      w.confidence = hasGarminData ? 'medium' : 'low';
      loadConsumed = wLoad * reducePct;
      wasAdjusted = true;
    }
  } else {
    // Other workout types
    if (ratio >= 0.9 && canReplace) {
      w.status = 'replaced';
      w.originalDistance = w.d;
      w.d = '0km (replaced)';
      w.modReason = `Replaced by ${sport}`;
      w.confidence = hasGarminData ? 'high' : 'medium';
      loadConsumed = wLoad;
      wasReplaced = true;
    } else if (ratio >= 0.3 && canAdjust) {
      const reducePct = Math.min(ratio * 0.4, 0.4);
      w.status = 'reduced';
      w.originalDistance = w.d;
      w.modReason = `Reduced ${(reducePct * 100).toFixed(0)}% due to ${sport}`;
      w.confidence = hasGarminData ? 'high' : 'medium';
      loadConsumed = wLoad * reducePct;
      wasAdjusted = true;
    }
  }

  // Recalculate loads if modified
  if (wasAdjusted && w.status === 'reduced') {
    const newLoads = calculateWorkoutLoad(w.t, w.d, (w.rpe || w.r || 5) * 10);
    w.aerobic = newLoads.aerobic;
    w.anaerobic = newLoads.anaerobic;
  }

  return { loadConsumed, wasReplaced, wasAdjusted };
}

/**
 * Calculate VDOT bonus from accumulated overflow loads
 */
function calculateCrossTrainingBonus(wk: Week): void {
  const extraRunLoad = wk.extraRunLoad || 0;
  const crossLoad = wk.unspentLoad || 0;

  if (extraRunLoad > 50 || crossLoad > 50) {
    const extraRunBonus = (extraRunLoad / 100) * 0.10;
    const crossBonus = (crossLoad / 100) * 0.03;
    const totalBonus = extraRunBonus + crossBonus;

    if (totalBonus > 0.01) {
      wk.crossTrainingBonus = totalBonus;
      wk.wkGain = (wk.wkGain || 0) + totalBonus;
    }
  }
}
