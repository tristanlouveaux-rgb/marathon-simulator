/**
 * planSuggester.ts
 * ================
 * Universal Cross-Sport Plan Adjustment Suggester.
 *
 * When a user logs an unplanned sport session, produces ONE popup suggestion with:
 * A) Keep plan unchanged
 * B) Apply recommended changes (replace + reduce/downgrade chain)
 * C) Apply conservative changes (reduce/downgrade only; no replacements)
 *
 * Rules:
 * - Never force. Only suggest; apply only after user confirms.
 * - Never replace another sport; only adjust planned runs.
 * - Preserve at least 2 runs/week.
 * - Long run protection: last to go, never fully replace unless injuryMode.
 * - Prefer downgrade/reduce before replace.
 */

import type { Workout, RaceDistance, RunnerType, WorkoutType, Paces } from '@/types';
import type {
  ActivityInput,
  UniversalLoadResult,
  SuggestionPayload,
  PlanEdit,
  PlannedRun,
  AthleteContext,
  Severity,
  ChoiceOutcome,
} from './universal-load-types';
import { computeUniversalLoad, isExtremeSession } from './universalLoad';
import { calculateWorkoutLoad, parseWorkoutDescription } from '@/workouts';
import {
  ANAEROBIC_WEIGHT,
  REPLACE_THRESHOLD,
  CONF_REPLACE_MIN,
  EASY_MIN_KM,
  LONG_MIN_KM,
  LONG_MIN_FRAC,
  MIN_PRESERVED_RUNS,
  MAX_MODS_NORMAL,
  MAX_MODS_EXTREME,
  EXTREME_WEEK_PCT,
  LOAD_SMOOTHING,
  RATIO_WEIGHT,
  LOAD_WEIGHT,
  SAME_DAY_BONUS,
  LONG_PENALTY,
} from './universal-load-constants';
import { SPORTS_DB } from '@/constants';
import { normalizeSport } from './activities';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function weightedLoad(aerobic: number, anaerobic: number): number {
  return aerobic + ANAEROBIC_WEIGHT * anaerobic;
}

function anaerobicRatio(aerobic: number, anaerobic: number): number {
  const total = aerobic + anaerobic;
  return total <= 1e-9 ? 0.0 : anaerobic / total;
}

function isQualityWorkout(wt: string): boolean {
  return [
    'vo2',
    'intervals',
    'hill_repeats',
    'threshold',
    'race_pace',
    'marathon_pace',
    'mixed',
    'progressive',
  ].includes(wt);
}

function isLongRunType(wt: string): boolean {
  return wt === 'long';
}

/** Downgrade a workout type to an easier version */
function downgradeType(wt: string): WorkoutType {
  const downgrades: Record<string, WorkoutType> = {
    vo2: 'threshold',
    intervals: 'threshold',
    hill_repeats: 'threshold',
    threshold: 'marathon_pace',
    race_pace: 'marathon_pace',
    marathon_pace: 'easy',
    mixed: 'marathon_pace',
    progressive: 'marathon_pace',
  };
  return (downgrades[wt] || wt) as WorkoutType;
}

/** Default paces for distance estimation when paces not available */
const DEFAULT_PACES: Paces = { e: 360, t: 300, i: 270, m: 315, r: 255 };

/**
 * Parse km distance from workout description using the canonical parser.
 * Falls back to simple regex if parser returns 0.
 * Always returns distance rounded to 1 decimal place.
 */
function parseDistanceKm(desc: string, paces?: Paces, aerobicLoad?: number): number {
  const effectivePaces = paces || DEFAULT_PACES;

  // Use canonical parser for robust handling of intervals and time-based workouts
  const parsed = parseWorkoutDescription(desc, effectivePaces);
  let km = parsed.totalDistance / 1000; // Convert meters to km

  // Fallback: simple regex for backward compatibility
  if (km <= 0) {
    const match = desc.match(/(\d+\.?\d*)km/);
    km = match ? parseFloat(match[1]) : 0;
  }

  // If still 0 and we have aerobic load, estimate distance
  // Rough estimate: 1km easy ≈ 35 aerobic load
  if (km <= 0 && aerobicLoad && aerobicLoad > 0) {
    km = aerobicLoad / 35;
  }

  // Round to 1 decimal place
  return Math.round(km * 10) / 10;
}

// ---------------------------------------------------------------------------
// Vibe Similarity (matches activity to planned runs)
// ---------------------------------------------------------------------------

function vibeSimilarity(
  actAerobic: number,
  actAnaerobic: number,
  runAerobic: number,
  runAnaerobic: number
): number {
  const r1 = anaerobicRatio(actAerobic, actAnaerobic);
  const r2 = anaerobicRatio(runAerobic, runAnaerobic);
  const w1 = weightedLoad(actAerobic, actAnaerobic);
  const w2 = weightedLoad(runAerobic, runAnaerobic);

  const ratioScore = 1.0 - Math.abs(r1 - r2);
  const loadScore = 1.0 / (1.0 + Math.abs(w1 - w2) / LOAD_SMOOTHING);
  return RATIO_WEIGHT * ratioScore + LOAD_WEIGHT * loadScore;
}

// ---------------------------------------------------------------------------
// Convert Workouts to PlannedRuns
// ---------------------------------------------------------------------------

export function workoutsToPlannedRuns(workouts: Workout[], paces?: Paces): PlannedRun[] {
  return workouts
    .filter(
      (w) =>
        w.t !== 'cross' &&
        w.t !== 'strength' &&
        w.t !== 'rest' &&
        w.t !== 'test_run'
    )
    .map((w, idx) => ({
      workoutId: w.n,
      dayIndex: w.dayOfWeek ?? idx,
      workoutType: w.t as WorkoutType,
      plannedDistanceKm: parseDistanceKm(w.d, paces, w.aerobic),
      plannedAerobic: w.aerobic || 0,
      plannedAnaerobic: w.anaerobic || 0,
      status: (w.status || 'planned') as PlannedRun['status'],
      isLongRun: w.t === 'long',
      isQuality: isQualityWorkout(w.t),
    }));
}

// ---------------------------------------------------------------------------
// Compute Weekly Load
// ---------------------------------------------------------------------------

function computeWeeklyRunLoad(runs: PlannedRun[]): number {
  return runs
    .filter((r) => r.status === 'planned')
    .reduce(
      (sum, r) => sum + weightedLoad(r.plannedAerobic, r.plannedAnaerobic),
      0
    );
}

// ---------------------------------------------------------------------------
// Severity Computation
// ---------------------------------------------------------------------------

function computeSeverity(
  fatigueCostLoad: number,
  weeklyRunLoad: number,
  durationMin: number,
  rpe: number,
  hasHR: boolean
): Severity {
  const relativeLoad = weeklyRunLoad > 0 ? fatigueCostLoad / weeklyRunLoad : 0;

  // EXTREME conditions
  if (relativeLoad >= EXTREME_WEEK_PCT) return 'extreme';
  if (!hasHR && durationMin >= 120 && rpe >= 7) return 'extreme';

  // HEAVY conditions
  if (relativeLoad >= 0.25) return 'heavy';
  if (!hasHR && durationMin >= 90 && rpe >= 6) return 'heavy';

  return 'light';
}

// ---------------------------------------------------------------------------
// Candidate Scoring
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  run: PlannedRun;
  similarity: number;
  runLoad: number;
  canReplace: boolean;
}

function buildCandidates(
  weekRuns: PlannedRun[],
  activityLoad: UniversalLoadResult,
  activityDayIndex: number,
  ctx: AthleteContext
): ScoredCandidate[] {
  const sportConfig = SPORTS_DB[activityLoad.sportKey];
  const noReplace = sportConfig?.noReplace || [];

  const candidates: ScoredCandidate[] = [];

  for (const run of weekRuns) {
    if (run.status !== 'planned') continue;

    let sim = vibeSimilarity(
      activityLoad.aerobicLoad,
      activityLoad.anaerobicLoad,
      run.plannedAerobic,
      run.plannedAnaerobic
    );

    // Same day bonus
    if (run.dayIndex === activityDayIndex) sim += SAME_DAY_BONUS;

    // Long run penalty
    if (run.isLongRun) sim -= LONG_PENALTY;

    // Race-goal protection (lower priority = harder to touch)
    const protectionPenalty = getWorkoutProtection(ctx.raceGoal, run.workoutType);
    sim -= 0.02 * protectionPenalty;

    // Determine if this run can be replaced
    let canReplace = true;
    if (run.isLongRun && !ctx.injuryMode) canReplace = false;
    if (noReplace.includes(run.workoutType)) canReplace = false;

    candidates.push({
      run,
      similarity: sim,
      runLoad: weightedLoad(run.plannedAerobic, run.plannedAnaerobic),
      canReplace,
    });
  }

  // Sort by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates;
}

/** Get workout protection priority (lower = more protected) */
function getWorkoutProtection(goal: RaceDistance, wt: WorkoutType): number {
  const priorities: Record<RaceDistance, Record<string, number>> = {
    marathon: {
      long: 0,
      marathon_pace: 1,
      threshold: 2,
      race_pace: 3,
      progressive: 3,
      hill_repeats: 4,
      mixed: 4,
      intervals: 5,
      vo2: 6,
      easy: 7,
    },
    half: {
      threshold: 0,
      long: 1,
      race_pace: 2,
      vo2: 3,
      intervals: 3,
      progressive: 3,
      mixed: 4,
      hill_repeats: 4,
      marathon_pace: 5,
      easy: 6,
    },
    '10k': {
      threshold: 0,
      vo2: 1,
      intervals: 2,
      race_pace: 2,
      long: 3,
      hill_repeats: 3,
      progressive: 4,
      mixed: 4,
      easy: 6,
      marathon_pace: 7,
    },
    '5k': {
      vo2: 0,
      intervals: 0,
      race_pace: 1,
      hill_repeats: 2,
      threshold: 3,
      long: 4,
      progressive: 4,
      mixed: 4,
      easy: 6,
      marathon_pace: 7,
    },
  };
  return priorities[goal]?.[wt] ?? 5;
}

// ---------------------------------------------------------------------------
// Build Conservative Edits (Option C: reduce/downgrade only)
// ---------------------------------------------------------------------------

function buildConservativeEdits(
  candidates: ScoredCandidate[],
  fatigueCostLoad: number,
  severity: Severity,
  preserveMin: number,
  plannedCount: number
): PlanEdit[] {
  const edits: PlanEdit[] = [];
  let remainingFatigue = fatigueCostLoad;

  const maxEdits =
    severity === 'extreme'
      ? MAX_MODS_EXTREME
      : severity === 'heavy'
        ? MAX_MODS_NORMAL
        : 1;

  for (const { run, runLoad } of candidates) {
    if (edits.length >= maxEdits) break;
    if (remainingFatigue <= 10) break;

    // For light severity, only one downgrade for quality sessions
    if (severity === 'light' && edits.length >= 1) break;

    // Quality workouts: downgrade one step (vo2→threshold→marathon_pace→easy)
    if (run.isQuality) {
      const newType = downgradeType(run.workoutType);

      // Calculate precise load reduction (load is truly load-based)
      // New RPE based on downgraded type
      const newRpe = newType === 'easy' ? 4 : newType === 'marathon_pace' ? 6 : 7;
      const newLoads = calculateWorkoutLoad(newType, `${run.plannedDistanceKm}km`, newRpe * 10);
      const newWeightedLoad = weightedLoad(newLoads.aerobic, newLoads.anaerobic);
      const loadReduction = Math.max(0, runLoad - newWeightedLoad);

      edits.push({
        workoutId: run.workoutId,
        dayOfWeek: run.dayIndex,
        action: 'downgrade',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType,
        newDistanceKm: run.plannedDistanceKm,
        loadReduction,
        rationale: `Downgrade ${run.workoutType} to ${newType} to manage fatigue.`,
      });

      remainingFatigue -= loadReduction;
      continue;
    }

    // Easy runs: reduce distance
    if (run.workoutType === 'easy') {
      const ratio = clamp(remainingFatigue / runLoad, 0.15, 0.40);
      let newKm = run.plannedDistanceKm * (1 - ratio);

      if (newKm < EASY_MIN_KM) continue; // Skip if too short

      newKm = Math.round(newKm * 10) / 10;
      const loadReduction = runLoad * ratio;

      edits.push({
        workoutId: run.workoutId,
        dayOfWeek: run.dayIndex,
        action: 'reduce',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType: 'easy',
        newDistanceKm: newKm,
        loadReduction,
        rationale: `Reduce easy run from ${run.plannedDistanceKm}km to ${newKm}km.`,
      });

      remainingFatigue -= loadReduction;
    }

    // Long runs: reduce conservatively
    if (run.isLongRun && severity !== 'light') {
      const maxReduction = 1 - LONG_MIN_FRAC;
      const ratio = clamp(0.10, 0.10, maxReduction);
      let newKm = run.plannedDistanceKm * (1 - ratio);

      // Apply both absolute and relative minimums
      const minKm = Math.max(LONG_MIN_KM, run.plannedDistanceKm * LONG_MIN_FRAC);
      if (newKm < minKm) newKm = minKm;

      newKm = Math.round(newKm * 10) / 10;
      const loadReduction = runLoad * ratio;

      edits.push({
        workoutId: run.workoutId,
        dayOfWeek: run.dayIndex,
        action: 'reduce',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType: 'easy', // Long stays easy effort
        newDistanceKm: newKm,
        loadReduction,
        rationale: `Reduce long run from ${run.plannedDistanceKm}km to ${newKm}km.`,
      });

      remainingFatigue -= loadReduction;
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------
// Build Recommended Edits (Option B: replace + reduce chain)
// ---------------------------------------------------------------------------

function buildRecommendedEdits(
  candidates: ScoredCandidate[],
  activityLoad: UniversalLoadResult,
  severity: Severity,
  preserveMin: number,
  plannedCount: number,
  ctx: AthleteContext
): PlanEdit[] {
  const edits: PlanEdit[] = [];
  let remainingCredit = activityLoad.runReplacementCredit;
  let remainingFatigue = activityLoad.fatigueCostLoad;
  let runsLeft = plannedCount;

  const maxEdits =
    severity === 'extreme'
      ? MAX_MODS_EXTREME
      : severity === 'heavy'
        ? MAX_MODS_NORMAL
        : 1;

  // First pass: try to replace one run if credit allows
  for (const { run, runLoad, canReplace } of candidates) {
    if (edits.length >= maxEdits) break;
    if (runsLeft <= preserveMin) break;
    if (remainingCredit <= 10) break;

    // Check if replacement is justified
    const canReplaceThis =
      canReplace &&
      remainingCredit >= REPLACE_THRESHOLD * runLoad &&
      activityLoad.confidence >= CONF_REPLACE_MIN;

    // Easy runs: replace if credit is sufficient
    if (run.workoutType === 'easy' && canReplaceThis) {
      edits.push({
        workoutId: run.workoutId,
        dayOfWeek: run.dayIndex,
        action: 'replace',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType: 'easy',
        newDistanceKm: 0,
        loadReduction: runLoad,
        rationale: `Replace ${run.plannedDistanceKm}km easy run (covered by cross-training).`,
      });

      remainingCredit -= runLoad;
      remainingFatigue -= runLoad;
      runsLeft--;
      continue;
    }

    // Quality runs: prefer downgrade unless extreme + high credit
    if (run.isQuality) {
      if (severity === 'extreme' && canReplaceThis && remainingCredit >= runLoad) {
        // Replace with minimal shakeout
        edits.push({
          workoutId: run.workoutId,
          dayOfWeek: run.dayIndex,
          action: 'replace',
          originalType: run.workoutType,
          originalDistanceKm: run.plannedDistanceKm,
          newType: 'easy',
          newDistanceKm: EASY_MIN_KM,
          loadReduction: runLoad * 0.8,
          rationale: `Replace ${run.workoutType} with ${EASY_MIN_KM}km shakeout.`,
        });

        remainingCredit -= runLoad * 0.8;
        remainingFatigue -= runLoad * 0.8;
        runsLeft--;
      } else {
        // Downgrade instead
        const newType = downgradeType(run.workoutType);

        // Calculate precise load reduction
        const newRpe = newType === 'easy' ? 4 : newType === 'marathon_pace' ? 6 : 7;
        const newLoads = calculateWorkoutLoad(newType, `${run.plannedDistanceKm}km`, newRpe * 10);
        const newWeightedLoad = weightedLoad(newLoads.aerobic, newLoads.anaerobic);
        const loadReduction = Math.max(0, runLoad - newWeightedLoad);

        edits.push({
          workoutId: run.workoutId,
          dayOfWeek: run.dayIndex,
          action: 'downgrade',
          originalType: run.workoutType,
          originalDistanceKm: run.plannedDistanceKm,
          newType,
          newDistanceKm: run.plannedDistanceKm,
          loadReduction,
          rationale: `Downgrade ${run.workoutType} to ${newType}.`,
        });

        remainingFatigue -= loadReduction;
      }
      continue;
    }

    // Long runs: never replace, only reduce conservatively
    if (run.isLongRun && severity !== 'light') {
      const maxReduction = 1 - LONG_MIN_FRAC;
      const ratio = clamp(0.15, 0.10, maxReduction);
      let newKm = run.plannedDistanceKm * (1 - ratio);

      const minKm = Math.max(LONG_MIN_KM, run.plannedDistanceKm * LONG_MIN_FRAC);
      if (newKm < minKm) newKm = minKm;

      newKm = Math.round(newKm * 10) / 10;
      const loadReduction = runLoad * ratio;

      edits.push({
        workoutId: run.workoutId,
        dayOfWeek: run.dayIndex,
        action: 'reduce',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType: 'easy',
        newDistanceKm: newKm,
        loadReduction,
        rationale: `Reduce long run to ${newKm}km.`,
      });

      remainingFatigue -= loadReduction;
    }
  }

  return edits;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Generate plan adjustment suggestions for a logged activity.
 *
 * @param weekRuns - Current week's planned workouts
 * @param activityInput - The logged cross-training activity
 * @param ctx - Athlete context (goal, runs per week, etc.)
 * @param nextWeekRuns - Optional: next week's workouts (for lookahead)
 * @returns SuggestionPayload with 3 choices
 */
export function suggestAdjustments(
  weekRuns: Workout[],
  activityInput: ActivityInput,
  ctx: AthleteContext,
  nextWeekRuns?: Workout[]
): SuggestionPayload {
  const warnings: string[] = [];

  // Convert workouts to PlannedRuns
  const plannedRuns = workoutsToPlannedRuns(weekRuns);
  const plannedCount = plannedRuns.filter((r) => r.status === 'planned').length;
  const preserveMin = Math.max(MIN_PRESERVED_RUNS, Math.ceil(plannedCount * 0.55));

  // Compute universal load
  const activityLoad = computeUniversalLoad(activityInput, ctx.raceGoal);

  // Compute weekly load
  const weeklyRunLoad = computeWeeklyRunLoad(plannedRuns);
  ctx.weeklyPlannedLoad = weeklyRunLoad;

  // Determine severity and extreme mode
  const rpe = activityInput.rpe ?? 5;
  const severity = computeSeverity(
    activityLoad.fatigueCostLoad,
    weeklyRunLoad,
    activityInput.durationMin,
    rpe,
    activityLoad.tier !== 'rpe'
  );

  const isExtreme = isExtremeSession(activityLoad, activityInput, weeklyRunLoad);

  // Build candidates
  const candidates = buildCandidates(
    plannedRuns,
    activityLoad,
    activityInput.dayOfWeek ?? new Date().getDay(),
    ctx
  );

  // Special case: only 2 runs planned
  const onlyTwoRuns = plannedCount <= 2;
  if (onlyTwoRuns) {
    warnings.push(
      'Only 2 runs planned this week. We recommend reduce/downgrade only.'
    );
  }

  // Build edits for each option
  const conservativeEdits = buildConservativeEdits(
    candidates,
    activityLoad.fatigueCostLoad,
    severity,
    preserveMin,
    plannedCount
  );

  let recommendedEdits: PlanEdit[];
  if (onlyTwoRuns) {
    // No replacements when only 2 runs
    recommendedEdits = conservativeEdits;
  } else {
    recommendedEdits = buildRecommendedEdits(
      candidates,
      activityLoad,
      severity,
      preserveMin,
      plannedCount,
      ctx
    );
  }

  // Build outcome descriptions
  const keepOutcome: ChoiceOutcome = {
    edits: [],
    summary: 'Keep your running plan unchanged. Be mindful of accumulated fatigue.',
    totalLoadReduction: 0,
  };

  const conservativeOutcome: ChoiceOutcome = {
    edits: conservativeEdits,
    summary:
      conservativeEdits.length > 0
        ? conservativeEdits.map((e) => e.rationale).join(' ')
        : 'No adjustments needed.',
    totalLoadReduction: conservativeEdits.reduce((s, e) => s + e.loadReduction, 0),
  };

  const recommendedOutcome: ChoiceOutcome = {
    edits: recommendedEdits,
    summary:
      recommendedEdits.length > 0
        ? recommendedEdits.map((e) => e.rationale).join(' ')
        : 'No adjustments needed.',
    totalLoadReduction: recommendedEdits.reduce((s, e) => s + e.loadReduction, 0),
  };

  // Build headline and summary
  const sportLabel = activityLoad.sportKey.replace(/_/g, ' ');
  const headline =
    severity === 'extreme'
      ? 'Very heavy training load'
      : severity === 'heavy'
        ? 'Heavy training load'
        : 'Sport session logged';

  const tierNote =
    activityLoad.tier === 'rpe'
      ? ' (estimated from RPE)'
      : activityLoad.tier === 'hr'
        ? ' (computed from HR)'
        : '';

  const summary =
    `Your ${activityInput.durationMin} min ${sportLabel} session${tierNote} is estimated ` +
    `to be ~${activityLoad.equivalentEasyKm}km easy-run equivalent. ` +
    (severity === 'light'
      ? 'Your weekly load looks balanced.'
      : 'Consider adjusting your running plan to avoid overtraining.');

  // Add tier-specific warnings
  if (activityLoad.tier === 'rpe') {
    warnings.push(
      "Load estimated from RPE only; we're being conservative. Connect a fitness watch for more accuracy."
    );
  }

  if (preserveMin >= plannedCount) {
    warnings.push('Minimum runs preserved to maintain training stimulus.');
  }

  if (activityLoad.confidence < CONF_REPLACE_MIN) {
    warnings.push(
      `Low confidence (${Math.round(activityLoad.confidence * 100)}%); replacements disabled.`
    );
  }

  return {
    sportName: sportLabel,
    durationMin: activityInput.durationMin,
    rpe,
    equivalentEasyKm: activityLoad.equivalentEasyKm,

    fatigueCostLoad: activityLoad.fatigueCostLoad,
    runReplacementCredit: activityLoad.runReplacementCredit,
    confidence: activityLoad.confidence,
    tier: activityLoad.tier,

    severity,
    headline,
    summary,
    warnings,

    keepOutcome,
    recommendedOutcome,
    conservativeOutcome,

    isExtremeSession: isExtreme,

    canRevert: true,
    reversionDeadline: getReversionDeadline(),
  };
}

/** Calculate reversion deadline (next workout completion OR week boundary) */
function getReversionDeadline(): Date {
  const now = new Date();
  // Default: end of current week (Sunday 23:59)
  const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
  const sunday = new Date(now);
  sunday.setDate(sunday.getDate() + daysUntilSunday);
  sunday.setHours(23, 59, 59, 999);
  return sunday;
}

// ---------------------------------------------------------------------------
// Apply Edits to Workouts
// ---------------------------------------------------------------------------

/**
 * Apply plan edits to workouts array.
 * Returns a new array with modifications applied.
 */
export function applyPlanEdits(
  workouts: Workout[],
  edits: PlanEdit[],
  sportName: string
): Workout[] {
  const modified = workouts.map((w) => ({ ...w }));

  for (const edit of edits) {
    const workout = modified.find((w) => w.n === edit.workoutId);
    if (!workout) continue;

    if (edit.action === 'replace') {
      workout.status = 'replaced';
      workout.originalDistance = workout.d;
      workout.d =
        edit.newDistanceKm > 0
          ? `${edit.newDistanceKm}km`
          : 'Activity Replaced';
      workout.modReason = `Replaced by ${sportName}`;
      workout.confidence = 'high';
      workout.t = edit.newType;
      workout.autoCompleted = true;
      workout.completedBySport = sportName;
    } else if (edit.action === 'downgrade') {
      workout.status = 'reduced';
      workout.originalDistance = workout.d;
      const paceLabel = edit.newType === 'marathon_pace' ? 'marathon pace'
                      : edit.newType === 'threshold' ? 'threshold'
                      : 'easy';
      workout.modReason = `Downgraded to ${paceLabel} due to ${sportName}`;
      workout.confidence = 'medium';
      workout.t = edit.newType;
    } else if (edit.action === 'reduce') {
      workout.status = 'reduced';
      workout.originalDistance = workout.d;
      workout.d = `${edit.newDistanceKm}km (was ${edit.originalDistanceKm}km)`;
      workout.modReason = `Reduced due to ${sportName}`;
      workout.confidence = 'medium';
      workout.t = edit.newType;
    }

    // Recalculate loads for modified workouts
    if (workout.status === 'reduced' || workout.status === 'replaced') {
      const newLoads = calculateWorkoutLoad(
        workout.t,
        workout.d,
        (workout.rpe || workout.r || 5) * 10
      );
      workout.aerobic = newLoads.aerobic;
      workout.anaerobic = newLoads.anaerobic;
    }
  }

  return modified;
}
