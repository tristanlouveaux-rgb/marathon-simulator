/**
 * cross_training_suggester.ts
 * ===========================
 *
 * Conservative suggestion-based cross-training → running plan adjustments.
 *
 * Key design:
 * - ONE popup per activity with exactly 3 global choices: REPLACE / REDUCE / KEEP
 * - Conservative by default: 90min padel should usually affect ~1 easy run, not 3
 * - Downgrade intensity first, reduce volume second, replace last
 * - "Beautiful split": RecoveryCostLoad vs RunReplacementCredit
 * - Equivalence messaging: "Your 90 min padel is ~X km easy run"
 *
 * Load tiers:
 * - TIER 1 (Garmin): Use aerobic_load + anaerobic_load directly
 * - TIER 2 (HR): Compute TRIMP-like load from time-in-zone
 * - TIER 3 (RPE only): Estimate from duration * RPE-based rate
 */

import type { Workout, RaceDistance, WorkoutType, SportKey, CrossActivity, Paces } from '@/types';
import { SPORTS_DB, ANAEROBIC_WEIGHT } from '@/constants';
import { normalizeSport } from './activities';
import { computeUniversalLoad, classifyWorkoutType } from './universalLoad';
import type { DataTier, HRZoneData } from './universal-load-types';
import type { WorkoutClassification, IntensityThresholds } from './universalLoad';
import { calculateWorkoutLoad, parseWorkoutDescription } from '@/workouts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = 'light' | 'heavy' | 'extreme';
export type GlobalChoice = 'keep' | 'reduce' | 'replace';

export interface SportProfile {
  mult: number;
  runSpec: number;
  recoveryMult: number;
  cannotReplace: string[];
}

export interface PlannedRun {
  workoutId: string;
  dayIndex: number;
  workoutType: WorkoutType;
  plannedDistanceKm: number;
  plannedAerobic: number;
  plannedAnaerobic: number;
  status: string;
  alreadyDowngraded: boolean;
}

export interface AthleteContext {
  raceGoal: RaceDistance;
  plannedRunsPerWeek: number;
  injuryMode: boolean;
  easyPaceSecPerKm?: number;
  /**
   * Runner type from onboarding/diagnostics.
   * Controls volume-vs-intensity priority in load reduction:
   *   Speed     → volume cuts first (protect quality sessions)
   *   Endurance → intensity cuts first (protect easy mileage)
   *   Balanced  → intensity first (default)
   */
  runnerType?: 'Speed' | 'Endurance' | 'Balanced';
  /** Personal iTRIMP intensity thresholds (calibrated from Strava history — Phase C2) */
  intensityThresholds?: IntensityThresholds;
  /**
   * Weekly running km floor for this training phase.
   * When acwrStatus is 'safe' or 'low', reductions will not take total planned
   * running below this floor. When ACWR is 'caution' or 'high', floor is ignored
   * (injury prevention takes priority over aerobic volume).
   */
  floorKm?: number;
  /** Current ACWR status — determines whether the km floor constraint applies. */
  acwrStatus?: 'safe' | 'caution' | 'high' | 'low' | 'unknown';
}

/** Single adjustment to a run */
export interface Adjustment {
  workoutId: string;
  dayIndex: number;  // Day of week (0-6) for unique identification
  action: 'downgrade' | 'reduce' | 'replace';
  originalType: WorkoutType;
  originalDistanceKm: number;
  newType: WorkoutType;
  newDistanceKm: number;
  loadReduction: number;
}

/** What happens under each global choice */
export interface ChoiceOutcome {
  adjustments: Adjustment[];
  description: string;
}

/** The payload for the UI popup */
export interface SuggestionPayload {
  severity: Severity;
  headline: string;
  summary: string;
  equivalentEasyKm: number;
  recoveryCostLoad: number;
  runReplacementCredit: number;
  sportName: string;
  durationMin: number;

  // Load breakdown (from UniversalLoadResult)
  tier: DataTier;
  aerobicLoad: number;
  anaerobicLoad: number;
  impactLoad: number;

  // The 3 global choices and their outcomes
  keepOutcome: ChoiceOutcome;
  reduceOutcome: ChoiceOutcome;
  replaceOutcome: ChoiceOutcome;

  warnings: string[];

  // §6.5 edge cases
  /** Best candidate run was already completed earlier this week */
  alreadyCompletedMatch?: { runName: string; runType: string };
  /** No viable planned runs exist to match this activity */
  noMatchingRun?: boolean;
}

// For backwards compatibility with existing code
export type Choice = GlobalChoice;
export interface Option {
  choice: Choice;
  newType: WorkoutType;
  newDistanceKm: number;
  rationale: string;
  tradeoffs: string;
}
export interface RunSuggestion {
  workoutId: string;
  dayIndex: number;
  currentType: WorkoutType;
  currentDistanceKm: number;
  similarity: number;
  recommended: Choice;
  options: Option[];
}
export interface GlobalSuggestion {
  title: string;
  message: string;
  reduceNonLongBy: number;
  downgradeNextQuality: boolean;
}
export interface SuggestionPopup extends SuggestionPayload {
  globalSuggestion: GlobalSuggestion | null;
  runSuggestions: RunSuggestion[];
  anaerobicRatio: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ANAEROBIC_WEIGHT_SUGGESTER = 1.50;

// Saturation curve
const TAU = 800.0;
const MAX_CREDIT = 1500.0;

// Distance clamps
const MIN_EASY_KM = 4.0;
const MIN_LONG_KM = 10.0;

// Similarity model
const LOAD_SMOOTHING = 30.0;
const RATIO_WEIGHT = 0.60;
const LOAD_WEIGHT = 0.40;
const SAME_DAY_BONUS = 0.15;
const LONG_PENALTY = 0.20;
const ZONE_MATCH_BONUS = 0.20;    // activity zone profile matches planned run type
const ZONE_MISMATCH_PENALTY = 0.10; // activity zone profile is two steps away (easy vs vo2)

// Preserve at least this fraction of runs
const PRESERVE_RUN_FRACTION = 0.55;
const MIN_PRESERVED_RUNS = 2;

// Max adjustments per severity level (conservative!)
const MAX_ADJUSTMENTS_LIGHT = 1;
const MAX_ADJUSTMENTS_HEAVY = 2;
const MAX_ADJUSTMENTS_EXTREME = 3;

// Cap equivalence messaging at this km
const MAX_EQUIVALENT_EASY_KM = 25;

// RPE → load-per-minute (Tier 3 fallback)
const LOAD_PER_MIN: Record<number, number> = {
  1: 0.5,
  2: 0.8,
  3: 1.1,
  4: 1.6,
  5: 2.0,
  6: 2.7,
  7: 3.5,
  8: 4.5,
  9: 5.3,
  10: 6.0,
};

// RPE → aerobic/anaerobic split
const RPE_AEROBIC_SPLIT: Record<number, number> = {
  1: 0.98, 2: 0.97, 3: 0.95, 4: 0.93,  // mostly aerobic
  5: 0.88, 6: 0.82,                     // moderate
  7: 0.72, 8: 0.65,                     // hard
  9: 0.58, 10: 0.55,                    // very hard
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function weightedLoad(aerobic: number, anaerobic: number): number {
  return aerobic + ANAEROBIC_WEIGHT_SUGGESTER * anaerobic;
}

function anaerobicRatio(aerobic: number, anaerobic: number): number {
  const total = aerobic + anaerobic;
  return total <= 1e-9 ? 0.0 : anaerobic / total;
}

function saturate(rawLoad: number): number {
  // Caps how much "credit" a single session can provide
  return MAX_CREDIT * (1.0 - Math.exp(-rawLoad / TAU));
}

function defaultRpe(rpe: number | undefined | null): number {
  return rpe == null ? 5 : clamp(Math.round(rpe), 1, 10);
}

/**
 * @deprecated Use computeUniversalLoad from ./universalLoad instead.
 * Kept for reference only — no longer called by buildCrossTrainingPopup.
 */
function resolveActivityLoad(
  act: CrossActivity,
  sport: SportProfile
): { aerobic: number; anaerobic: number; tier: 1 | 2 | 3 } {
  // TIER 1: Garmin/Firstbeat loads
  if (act.fromGarmin && act.aerobic_load != null && act.anaerobic_load != null) {
    return {
      aerobic: act.aerobic_load,
      anaerobic: act.anaerobic_load,
      tier: 1,
    };
  }

  // TIER 2: HR data (future enhancement - for now fall through to Tier 3)
  // TODO: If HR time-in-zone is available, compute TRIMP-like load

  // TIER 3: RPE + duration estimate
  const r = defaultRpe(act.rpe);
  const lpm = LOAD_PER_MIN[r] || 2.0;
  const rawLoad = act.duration_min * lpm * sport.mult;

  // Split into aerobic/anaerobic based on RPE
  const aerobicFrac = RPE_AEROBIC_SPLIT[r] || 0.85;
  const aerobic = rawLoad * aerobicFrac;
  const anaerobic = (rawLoad - aerobic) / ANAEROBIC_WEIGHT_SUGGESTER;

  return { aerobic, anaerobic, tier: 3 };
}

/**
 * Compute severity based on activity load relative to weekly plan
 */
function computeSeverity(
  recoveryCostLoad: number,
  weeklyRunLoad: number,
  durationMin: number,
  rpe: number,
  hasHR: boolean
): Severity {
  // Relative thresholds (spec says 0.55 = extreme, 0.25 = heavy)
  const relativeLoad = weeklyRunLoad > 0 ? recoveryCostLoad / weeklyRunLoad : 0;

  // EXTREME conditions (any of):
  // - RecoveryCostLoad >= 0.55 * PlannedWeekLoad
  // - (HR available) time_in_zone2_or_higher >= 150 min (not implemented yet)
  // - (no HR) duration >= 120 AND RPE >= 7
  if (relativeLoad >= 0.55) return 'extreme';
  if (!hasHR && durationMin >= 120 && rpe >= 7) return 'extreme';

  // HEAVY conditions:
  // - RecoveryCostLoad >= 0.25 * PlannedWeekLoad
  // - (no HR) duration >= 90 AND RPE >= 6
  if (relativeLoad >= 0.25) return 'heavy';
  if (!hasHR && durationMin >= 90 && rpe >= 6) return 'heavy';

  return 'light';
}

function vibeSimilarity(a1: number, an1: number, a2: number, an2: number): number {
  const r1 = anaerobicRatio(a1, an1);
  const r2 = anaerobicRatio(a2, an2);
  const w1 = weightedLoad(a1, an1);
  const w2 = weightedLoad(a2, an2);

  const ratioScore = 1.0 - Math.abs(r1 - r2);
  const loadScore = 1.0 / (1.0 + Math.abs(w1 - w2) / LOAD_SMOOTHING);
  return RATIO_WEIGHT * ratioScore + LOAD_WEIGHT * loadScore;
}

function canReplaceWorkout(sport: SportProfile, wt: WorkoutType, ctx: AthleteContext): boolean {
  if (wt === 'long' && !ctx.injuryMode) return false;
  if (sport.cannotReplace.includes(wt)) return false;
  return true;
}

function preserveRunCountMin(plannedRuns: number): number {
  return Math.max(MIN_PRESERVED_RUNS, Math.ceil(plannedRuns * PRESERVE_RUN_FRACTION));
}

function workoutPriorityForRace(ctx: AthleteContext, wt: WorkoutType): number {
  // Lower = more protected (last to touch)
  const priorities: Record<RaceDistance, Record<string, number>> = {
    marathon: { long: 0, marathon_pace: 1, threshold: 2, race_pace: 3, progressive: 3, hill_repeats: 4, mixed: 4, intervals: 5, vo2: 6, easy: 7 },
    half: { threshold: 0, long: 1, race_pace: 2, vo2: 3, intervals: 3, progressive: 3, mixed: 4, hill_repeats: 4, marathon_pace: 5, easy: 6 },
    '10k': { threshold: 0, vo2: 1, intervals: 2, race_pace: 2, long: 3, hill_repeats: 3, progressive: 4, mixed: 4, easy: 6, marathon_pace: 7 },
    '5k': { vo2: 0, intervals: 0, race_pace: 1, hill_repeats: 2, threshold: 3, long: 4, progressive: 4, mixed: 4, easy: 6, marathon_pace: 7 },
  };
  return priorities[ctx.raceGoal]?.[wt] ?? 5;
}

/**
 * Downgrade a workout type one step (not straight to easy).
 * Intensity ladder: vo2/intervals → threshold → marathon_pace → easy
 */
function downgradeType(wt: WorkoutType): WorkoutType {
  const downgrades: Partial<Record<WorkoutType, WorkoutType>> = {
    vo2: 'threshold',
    intervals: 'threshold',
    hill_repeats: 'threshold',
    threshold: 'marathon_pace',
    race_pace: 'marathon_pace',
    marathon_pace: 'easy',
    mixed: 'marathon_pace',
    progressive: 'marathon_pace',
    float: 'marathon_pace',
  };
  return downgrades[wt] || wt;
}

function isQualityWorkout(wt: WorkoutType): boolean {
  return ['vo2', 'intervals', 'hill_repeats', 'threshold', 'race_pace', 'marathon_pace', 'mixed', 'progressive', 'float'].includes(wt);
}

function computeWeeklyRunLoad(runs: PlannedRun[]): number {
  return runs
    .filter(r => r.status === 'planned')
    .reduce((sum, r) => sum + weightedLoad(r.plannedAerobic, r.plannedAnaerobic), 0);
}

/**
 * @deprecated Use computeUniversalLoad's equivalentEasyKm instead.
 */
function computeEquivalentEasyKm(runReplacementCredit: number, easyPaceSecPerKm?: number): number {
  // Estimate load per km for easy running
  // Use a conservative estimate: ~35 load per km at easy pace
  const easyLoadPerKm = 35;
  const equiv = runReplacementCredit / easyLoadPerKm;
  return Math.min(MAX_EQUIVALENT_EASY_KM, Math.round(equiv * 10) / 10);
}

function getSportProfile(sportKey: SportKey | string): SportProfile {
  const base = SPORTS_DB[sportKey as SportKey];
  if (!base) {
    return { mult: 1.0, runSpec: 0.35, recoveryMult: 1.0, cannotReplace: [] };
  }

  const recoveryMult = base.recoveryMult ?? 1.0;

  return {
    mult: base.mult,
    runSpec: base.runSpec,
    recoveryMult,
    cannotReplace: [...base.noReplace],
  };
}

// ---------------------------------------------------------------------------
// Adjustment Building
// ---------------------------------------------------------------------------

interface CandidateRun {
  run: PlannedRun;
  similarity: number;
  runLoad: number;
}

/** Map a planned workout type to its intensity zone profile for classification matching */
function workoutTypeToZone(wt: WorkoutType | string): 'easy' | 'threshold' | 'vo2' {
  if (wt === 'vo2' || wt === 'intervals' || wt === 'hill_repeats') return 'vo2';
  if (wt === 'threshold' || wt === 'marathon_pace') return 'threshold';
  return 'easy'; // easy, long, progressive, mixed, recovery
}

function buildCandidates(
  weekRuns: PlannedRun[],
  actAerobic: number,
  actAnaerobic: number,
  activityDayIndex: number,
  ctx: AthleteContext,
  actClassification?: WorkoutClassification
): CandidateRun[] {
  const candidates: CandidateRun[] = [];

  const zoneOrder: Record<'easy' | 'threshold' | 'vo2', number> = { easy: 0, threshold: 1, vo2: 2 };

  for (const run of weekRuns) {
    // Include both planned and already-reduced workouts (e.g. graduated return downgrades)
    if (run.status !== 'planned' && run.status !== 'reduced') continue;

    let sim = vibeSimilarity(actAerobic, actAnaerobic, run.plannedAerobic, run.plannedAnaerobic);

    // Same day bonus
    if (run.dayIndex === activityDayIndex) sim += SAME_DAY_BONUS;

    // Long run penalty (harder to touch)
    if (run.workoutType === 'long') sim -= LONG_PENALTY;

    // Race-goal protection penalty
    const protect = workoutPriorityForRace(ctx, run.workoutType);
    sim -= 0.02 * protect;

    // Already-downgraded penalty — push to bottom of candidate list
    if (run.alreadyDowngraded) sim -= 0.50;

    // Zone-profile matching: iTRIMP/zone classifier overrides raw load similarity for ranking
    if (actClassification) {
      const runZone = workoutTypeToZone(run.workoutType);
      const zoneDiff = Math.abs(zoneOrder[actClassification.type] - zoneOrder[runZone]);
      if (zoneDiff === 0) {
        sim += ZONE_MATCH_BONUS; // same intensity profile — strong match
      } else if (zoneDiff === 2) {
        sim -= ZONE_MISMATCH_PENALTY; // opposite ends (easy vs vo2) — penalise
      }
    }

    const runLoad = weightedLoad(run.plannedAerobic, run.plannedAnaerobic);
    candidates.push({ run, similarity: sim, runLoad });
  }

  // Sort by similarity descending (non-downgraded naturally sort first due to penalty)
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates;
}

/**
 * Compute the weighted load for a workout at a given type and distance.
 * Uses calculateWorkoutLoad for real load values instead of rough estimates.
 */
function computeWorkoutWeightedLoad(
  workoutType: string,
  distanceKm: number,
  rpe: number
): number {
  const loads = calculateWorkoutLoad(workoutType, `${Math.round(distanceKm)}km`, rpe * 10);
  return loads.aerobic + ANAEROBIC_WEIGHT_SUGGESTER * loads.anaerobic;
}

/**
 * Build adjustments for REDUCE choice (downgrades and reductions only, no replacements).
 * Uses load-based budgeting: total load reduction across all adjustments must not
 * exceed runReplacementCredit (the actual load the cross-training session covers).
 */
function buildReduceAdjustments(
  candidates: CandidateRun[],
  loadBudget: number,
  severity: Severity,
  ctx: AthleteContext,
  preserveMin: number,
  plannedCount: number,
  allPlannedKm?: number,
): Adjustment[] {
  const adjustments: Adjustment[] = [];
  let remainingLoad = loadBudget;

  const maxAdjustments = severity === 'extreme' ? MAX_ADJUSTMENTS_EXTREME :
                         severity === 'heavy' ? MAX_ADJUSTMENTS_HEAVY :
                         MAX_ADJUSTMENTS_LIGHT;

  // Minimum load worth adjusting (below this, not worth changing the plan)
  const minLoadThreshold = 5;

  // ── Km floor constraint ──────────────────────────────────────────────────
  // When ACWR is safe or low, don't reduce total planned running below the floor.
  // When ACWR is caution or high, injury prevention wins — floor is ignored.
  const floorActive = ctx.floorKm != null && ctx.floorKm > 0 &&
    (ctx.acwrStatus === 'safe' || ctx.acwrStatus === 'low' || ctx.acwrStatus == null);
  const totalPlannedKm = allPlannedKm ?? candidates.reduce((sum, c) => sum + c.run.plannedDistanceKm, 0);
  let totalReducedKm = 0; // running total of km removed by distance reductions

  // Process candidates in priority order:
  // 1. Non-downgraded workouts (quality downgrades + easy reductions)
  // 2. Already-downgraded easy runs (distance reduction only)
  // 3. Last resort: double-downgrade already-downgraded quality → easy
  //
  // Runner-type affects whether we cut volume (easy km) or intensity first:
  //   Speed runner     → volume cuts first (protect quality sessions)
  //   Endurance/other  → intensity cuts first (default: keep easy mileage)
  const volumeFirst = ctx.runnerType === 'Speed';
  const raw = candidates.filter(c => !c.run.alreadyDowngraded);
  // Sort: for Speed runners put easy runs first so volume is cut before quality
  const fresh = volumeFirst
    ? [...raw.filter(c => c.run.workoutType === 'easy'), ...raw.filter(c => c.run.workoutType !== 'easy')]
    : raw;
  const downgraded = candidates.filter(c => c.run.alreadyDowngraded);

  /** How many more km can be cut before hitting the floor (Infinity if floor is off). */
  const floorSlack = (): number => {
    if (!floorActive) return Infinity;
    return Math.max(0, (totalPlannedKm - totalReducedKm) - ctx.floorKm!);
  };

  const tryReduce = (pool: CandidateRun[], allowQualityDowngrade: boolean) => {
    for (const { run, runLoad } of pool) {
      if (adjustments.length >= maxAdjustments) break;
      if (remainingLoad <= minLoadThreshold) break;

      // Quality workout downgrade (keeps distance, reduces intensity)
      // Downgrades don't remove km — they're always allowed regardless of floor.
      if (isQualityWorkout(run.workoutType) && allowQualityDowngrade) {
        const newType = run.alreadyDowngraded ? ('easy' as WorkoutType) : downgradeType(run.workoutType);
        const rpe = run.workoutType === 'vo2' || run.workoutType === 'intervals' ? 8
                  : run.workoutType === 'threshold' || run.workoutType === 'race_pace' || run.workoutType === 'float' ? 7
                  : 6;
        const downgradedRpe = newType === 'easy' ? 4 : newType === 'marathon_pace' ? 6 : 7;
        const originalLoad = computeWorkoutWeightedLoad(run.workoutType, run.plannedDistanceKm, rpe);
        const downgradedLoad = computeWorkoutWeightedLoad(newType, run.plannedDistanceKm, downgradedRpe);
        const loadReduction = Math.max(0, originalLoad - downgradedLoad);

        if (loadReduction <= minLoadThreshold) continue;

        const actualReduction = Math.min(loadReduction, remainingLoad);

        adjustments.push({
          workoutId: run.workoutId,
          dayIndex: run.dayIndex,
          action: 'downgrade',
          originalType: run.workoutType,
          originalDistanceKm: run.plannedDistanceKm,
          newType,
          newDistanceKm: run.plannedDistanceKm,
          loadReduction: actualReduction,
        });

        remainingLoad -= actualReduction;
        continue;
      }

      // Easy run distance reduction
      if (run.workoutType === 'easy') {
        const runKm = run.plannedDistanceKm;
        const loadPerKm = runKm > 0 ? runLoad / runKm : 0;
        if (loadPerKm <= 0) continue;

        const budgetKm = remainingLoad / loadPerKm;
        let maxReductionKm = Math.min(budgetKm, runKm * 0.40);

        // Floor constraint: don't cut more km than the floor allows
        const slack = floorSlack();
        if (slack <= 0) continue; // already at or below floor
        maxReductionKm = Math.min(maxReductionKm, slack);

        if (maxReductionKm < 0.5) continue;

        let newKm = runKm - maxReductionKm;
        if (newKm < MIN_EASY_KM) newKm = MIN_EASY_KM;

        const actualReductionKm = runKm - newKm;
        if (actualReductionKm < 0.5) continue;

        newKm = Math.round(newKm * 10) / 10;
        const loadReduction = loadPerKm * actualReductionKm;

        adjustments.push({
          workoutId: run.workoutId,
          dayIndex: run.dayIndex,
          action: 'reduce',
          originalType: run.workoutType,
          originalDistanceKm: runKm,
          newType: 'easy',
          newDistanceKm: newKm,
          loadReduction,
        });

        remainingLoad -= loadReduction;
        totalReducedKm += actualReductionKm;
        continue;
      }

      // Long run reduction (only heavy/extreme)
      if (run.workoutType === 'long' && severity !== 'light') {
        const runKm = run.plannedDistanceKm;
        const loadPerKm = runKm > 0 ? runLoad / runKm : 0;
        if (loadPerKm <= 0) continue;

        const budgetKm = remainingLoad / loadPerKm;
        let maxReductionKm = Math.min(budgetKm, runKm * 0.25);

        // Floor constraint on long runs: protect at least 85% of the original distance
        // when floor is active — long runs are critical for structural adaptation.
        const longRunFloor = floorActive ? Math.max(MIN_LONG_KM, runKm * 0.85) : MIN_LONG_KM;
        // Also respect the weekly km floor
        const slack = floorSlack();
        if (slack <= 0) continue;
        maxReductionKm = Math.min(maxReductionKm, slack);

        if (maxReductionKm < 1.0) continue;

        let newKm = runKm - maxReductionKm;
        if (newKm < longRunFloor) newKm = longRunFloor;

        const actualReductionKm = runKm - newKm;
        if (actualReductionKm < 0.5) continue;

        newKm = Math.round(newKm * 10) / 10;
        const loadReduction = loadPerKm * actualReductionKm;

        adjustments.push({
          workoutId: run.workoutId,
          dayIndex: run.dayIndex,
          action: 'reduce',
          originalType: run.workoutType,
          originalDistanceKm: runKm,
          newType: 'easy',
          newDistanceKm: newKm,
          loadReduction,
        });

        remainingLoad -= loadReduction;
        totalReducedKm += actualReductionKm;
      }
    }
  };

  // Pass 1: Non-downgraded workouts (quality downgrades + distance reductions)
  tryReduce(fresh, true);
  // Pass 2: Already-downgraded easy runs (distance reduction only, no quality downgrade)
  if (remainingLoad > minLoadThreshold) tryReduce(downgraded, false);
  // Pass 3: Last resort — double-downgrade already-downgraded quality → easy
  if (remainingLoad > minLoadThreshold) tryReduce(downgraded, true);

  return adjustments;
}

/**
 * Build adjustments for REPLACE choice (includes replacements where appropriate).
 * Uses load-based budgeting: total load reduction must not exceed runReplacementCredit.
 */
function buildReplaceAdjustments(
  candidates: CandidateRun[],
  loadBudget: number,
  severity: Severity,
  ctx: AthleteContext,
  sport: SportProfile,
  preserveMin: number,
  plannedCount: number,
  allPlannedKm?: number,
): Adjustment[] {
  const adjustments: Adjustment[] = [];
  let remainingLoad = loadBudget;
  let runsLeft = plannedCount;

  const maxAdjustments = severity === 'extreme' ? MAX_ADJUSTMENTS_EXTREME :
                         severity === 'heavy' ? MAX_ADJUSTMENTS_HEAVY :
                         MAX_ADJUSTMENTS_LIGHT;

  const minLoadThreshold = 5;
  const usedIds = new Set<string>();
  const candidateKey = (r: PlannedRun) => `${r.workoutId}:${r.dayIndex}`;

  // ── Km floor constraint (same logic as buildReduceAdjustments) ───────────
  const floorActive = ctx.floorKm != null && ctx.floorKm > 0 &&
    (ctx.acwrStatus === 'safe' || ctx.acwrStatus === 'low' || ctx.acwrStatus == null);
  const totalPlannedKm = allPlannedKm ?? candidates.reduce((sum, c) => sum + c.run.plannedDistanceKm, 0);
  let totalReducedKm = 0;

  const floorSlack = (): number => {
    if (!floorActive) return Infinity;
    return Math.max(0, (totalPlannedKm - totalReducedKm) - ctx.floorKm!);
  };

  // Split candidates into fresh (non-downgraded) and already-downgraded
  const freshCandidates = candidates.filter(c => !c.run.alreadyDowngraded);
  const downgradedCandidates = candidates.filter(c => c.run.alreadyDowngraded);

  // Sort replaceable candidates by cost (cheapest first — easy runs before quality)
  // Fresh workouts first, then downgraded
  const freshReplacePool = freshCandidates
    .filter(c => canReplaceWorkout(sport, c.run.workoutType, ctx) && c.run.workoutType !== 'long')
    .sort((a, b) => a.runLoad - b.runLoad);
  const downgradedReplacePool = downgradedCandidates
    .filter(c => canReplaceWorkout(sport, c.run.workoutType, ctx) && c.run.workoutType !== 'long')
    .sort((a, b) => a.runLoad - b.runLoad);
  const replacePool = [...freshReplacePool, ...downgradedReplacePool];

  let replaceIdx = 0;

  // Helper: try to reduce/downgrade one workout from a pool
  const tryReduceOne = (pool: CandidateRun[], allowQualityDowngrade: boolean): boolean => {
    for (const { run, runLoad } of pool) {
      if (usedIds.has(candidateKey(run))) continue;
      if (adjustments.length >= maxAdjustments) break;
      if (remainingLoad <= minLoadThreshold) break;

      const runKm = run.plannedDistanceKm;

      // Quality downgrade (keeps km — no floor impact)
      if (isQualityWorkout(run.workoutType) && allowQualityDowngrade) {
        const newType = run.alreadyDowngraded ? ('easy' as WorkoutType) : downgradeType(run.workoutType);
        const rpe = run.workoutType === 'vo2' || run.workoutType === 'intervals' ? 8
                  : run.workoutType === 'threshold' || run.workoutType === 'race_pace' || run.workoutType === 'float' ? 7
                  : 6;
        const downgradedRpe = newType === 'easy' ? 4 : newType === 'marathon_pace' ? 6 : 7;
        const originalLoad = computeWorkoutWeightedLoad(run.workoutType, runKm, rpe);
        const downgradedLoad = computeWorkoutWeightedLoad(newType, runKm, downgradedRpe);
        const loadReduction = Math.min(Math.max(0, originalLoad - downgradedLoad), remainingLoad);
        if (loadReduction <= minLoadThreshold) continue;

        adjustments.push({
          workoutId: run.workoutId, dayIndex: run.dayIndex,
          action: 'downgrade', originalType: run.workoutType,
          originalDistanceKm: runKm, newType, newDistanceKm: runKm, loadReduction,
        });
        remainingLoad -= loadReduction;
        usedIds.add(candidateKey(run));
        return true;
      }

      // Easy run distance reduction (floor-aware)
      if (run.workoutType === 'easy') {
        const loadPerKm = runKm > 0 ? runLoad / runKm : 0;
        if (loadPerKm <= 0) continue;
        const budgetKm = remainingLoad / loadPerKm;
        let reduceKm = Math.min(budgetKm, runKm * 0.5);

        // Floor constraint
        const slack = floorSlack();
        if (slack <= 0) continue;
        reduceKm = Math.min(reduceKm, slack);

        const newKm = Math.max(MIN_EASY_KM, Math.round((runKm - reduceKm) * 10) / 10);
        const actualReductionKm = runKm - newKm;
        if (actualReductionKm < 0.5) continue;

        adjustments.push({
          workoutId: run.workoutId, dayIndex: run.dayIndex,
          action: 'reduce', originalType: run.workoutType,
          originalDistanceKm: runKm, newType: 'easy', newDistanceKm: newKm,
          loadReduction: loadPerKm * actualReductionKm,
        });
        remainingLoad -= loadPerKm * actualReductionKm;
        totalReducedKm += actualReductionKm;
        usedIds.add(candidateKey(run));
        return true;
      }

      // Long run reduction (floor-aware)
      if (run.workoutType === 'long' && severity !== 'light') {
        const loadPerKm = runKm > 0 ? runLoad / runKm : 0;
        if (loadPerKm <= 0) continue;
        const budgetKm = remainingLoad / loadPerKm;
        let maxReductionKm = Math.min(budgetKm, runKm * 0.3);

        const longRunFloor = floorActive ? Math.max(MIN_LONG_KM, runKm * 0.85) : MIN_LONG_KM;
        const slack = floorSlack();
        if (slack <= 0) continue;
        maxReductionKm = Math.min(maxReductionKm, slack);

        if (maxReductionKm < 1.0) continue;
        const newKm = Math.max(longRunFloor, Math.round((runKm - maxReductionKm) * 10) / 10);
        const actualReductionKm = runKm - newKm;
        if (actualReductionKm < 0.5) continue;

        adjustments.push({
          workoutId: run.workoutId, dayIndex: run.dayIndex,
          action: 'reduce', originalType: run.workoutType,
          originalDistanceKm: runKm, newType: 'easy', newDistanceKm: newKm,
          loadReduction: loadPerKm * actualReductionKm,
        });
        remainingLoad -= loadPerKm * actualReductionKm;
        totalReducedKm += actualReductionKm;
        usedIds.add(candidateKey(run));
        return true;
      }
    }
    return false;
  };

  // Interleave: replace 1 → reduce 1 → replace 1...
  while (adjustments.length < maxAdjustments && remainingLoad > minLoadThreshold) {
    let madeProgress = false;

    // Try to replace one workout (fresh first, then downgraded)
    // Replace removes all km — check floor before allowing it
    while (replaceIdx < replacePool.length) {
      const { run, runLoad } = replacePool[replaceIdx];
      replaceIdx++;
      if (usedIds.has(candidateKey(run))) continue;
      if (runsLeft <= preserveMin) break;
      if (remainingLoad < runLoad) continue;
      if (adjustments.length >= maxAdjustments) break;

      // Floor constraint: replacing removes all this run's km
      const slack = floorSlack();
      if (run.plannedDistanceKm > slack) continue; // would breach floor

      adjustments.push({
        workoutId: run.workoutId,
        dayIndex: run.dayIndex,
        action: 'replace',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType: run.workoutType,
        newDistanceKm: 0,
        loadReduction: runLoad,
      });
      remainingLoad -= runLoad;
      totalReducedKm += run.plannedDistanceKm;
      runsLeft--;
      usedIds.add(candidateKey(run));
      madeProgress = true;
      break;
    }

    if (adjustments.length >= maxAdjustments || remainingLoad <= minLoadThreshold) break;

    // Then reduce/downgrade one workout with priority:
    // 1. Fresh workouts (quality downgrade + easy reduction)
    // 2. Downgraded easy runs (distance reduction only, no quality downgrade)
    // 3. Last resort: double-downgrade quality → easy
    if (tryReduceOne(freshCandidates, true)) { madeProgress = true; }
    else if (tryReduceOne(downgradedCandidates, false)) { madeProgress = true; }
    else if (tryReduceOne(downgradedCandidates, true)) { madeProgress = true; }

    if (!madeProgress) break;
  }

  return adjustments;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Build a suggestion payload for cross-training impact on the week's runs
 */
export function buildCrossTrainingPopup(
  ctx: AthleteContext,
  weekRuns: PlannedRun[],
  activity: CrossActivity,
  prevWeekRunLoad?: number,
  /**
   * Recovery trend multiplier from computeRecoveryTrend() (1.0–1.50).
   * Inflates runReplacementCredit so poor recovery → larger reduction budget.
   * Capped at +20 TSS equivalent to prevent catastrophic over-reduction.
   */
  recoveryMultiplier = 1.0,
): SuggestionPopup {
  const warnings: string[] = [];

  const sportKey = normalizeSport(activity.sport);
  const sport = getSportProfile(sportKey);
  const sportDisplayName = sportKey.replace(/_/g, ' ');

  // Delegate load computation to the Universal Load Engine (single source of truth)
  const loadResult = computeUniversalLoad({
    sport: activity.sport,
    durationMin: activity.duration_min,
    rpe: activity.rpe,
    iTrimp: activity.iTrimp,
    fromGarmin: activity.fromGarmin,
    garminAerobicLoad: activity.aerobic_load,
    garminAnaerobicLoad: activity.anaerobic_load,
    hrZones: activity.hrZones ? {
      zone1Minutes: activity.hrZones.z1 / 60,
      zone2Minutes: activity.hrZones.z2 / 60,
      zone3Minutes: activity.hrZones.z3 / 60,
      zone4Minutes: activity.hrZones.z4 / 60,
      zone5Minutes: activity.hrZones.z5 / 60,
    } : undefined,
    dayOfWeek: activity.dayOfWeek,
  }, ctx.raceGoal);

  const aerobic = loadResult.aerobicLoad;
  const anaerobic = loadResult.anaerobicLoad;
  const recoveryCostLoad = loadResult.fatigueCostLoad;
  const runReplacementCredit = loadResult.runReplacementCredit;
  const equivalentEasyKm = loadResult.equivalentEasyKm;

  // Compute weekly load for severity detection
  const weeklyRunLoad = computeWeeklyRunLoad(weekRuns);
  const plannedCount = weekRuns.filter(r => r.status === 'planned').length;
  const preserveMin = preserveRunCountMin(plannedCount);

  // Compute severity relative to weekly load
  const severity = computeSeverity(
    recoveryCostLoad,
    weeklyRunLoad,
    activity.duration_min,
    defaultRpe(activity.rpe),
    loadResult.tier !== 'rpe'
  );

  // Classify activity intensity for zone-profile-aware candidate matching (Phase B v3)
  const hrZonesForClassifier: HRZoneData | undefined = activity.hrZones ? {
    zone1Minutes: activity.hrZones.z1 / 60,
    zone2Minutes: activity.hrZones.z2 / 60,
    zone3Minutes: activity.hrZones.z3 / 60,
    zone4Minutes: activity.hrZones.z4 / 60,
    zone5Minutes: activity.hrZones.z5 / 60,
  } : undefined;
  const actClassification = classifyWorkoutType({
    sport: activity.sport,
    durationMin: activity.duration_min,
    iTrimp: activity.iTrimp,
    hrZones: hrZonesForClassifier,
    thresholds: ctx.intensityThresholds,
  });
  console.log(`[CrossTraining] Zone classification: ${actClassification.type} (${actClassification.method}) — TSS ${actClassification.tss.toFixed(1)}, runEquiv ${actClassification.runningEquivTSS.toFixed(1)}`);

  // Build candidate list (zone-profile classification improves ranking)
  const candidates = buildCandidates(weekRuns, aerobic, anaerobic, activity.dayOfWeek, ctx, actClassification);

  // Build adjustments for each choice (load-based budgeting — total reduction ≤ RRC)
  // DEBUG: log load currency values
  console.log('[CrossTraining] === Load Currency Debug ===');
  console.log(`[CrossTraining] Activity: ${activity.duration_min}min ${sportKey} RPE ${defaultRpe(activity.rpe)}`);
  console.log(`[CrossTraining] Aerobic: ${aerobic.toFixed(1)}, Anaerobic: ${anaerobic.toFixed(1)}, BaseLoad: ${(aerobic + anaerobic).toFixed(1)}`);
  console.log(`[CrossTraining] FCL (fatigue): ${recoveryCostLoad.toFixed(1)}, RRC (replacement budget): ${runReplacementCredit.toFixed(1)}`);
  console.log(`[CrossTraining] Weekly run load: ${weeklyRunLoad.toFixed(1)}, FCL/Weekly: ${(weeklyRunLoad > 0 ? recoveryCostLoad / weeklyRunLoad : 0).toFixed(2)}`);
  console.log(`[CrossTraining] Severity: ${severity}, Max adjustments: ${severity === 'extreme' ? MAX_ADJUSTMENTS_EXTREME : severity === 'heavy' ? MAX_ADJUSTMENTS_HEAVY : MAX_ADJUSTMENTS_LIGHT}`);
  console.log(`[CrossTraining] Candidates (sorted by similarity):`);
  for (const c of candidates) {
    const storedWL = weightedLoad(c.run.plannedAerobic, c.run.plannedAnaerobic);
    const recalcRpe = c.run.workoutType === 'vo2' || c.run.workoutType === 'intervals' ? 8
                    : c.run.workoutType === 'threshold' || c.run.workoutType === 'race_pace' || c.run.workoutType === 'float' ? 7
                    : c.run.workoutType === 'easy' ? 3 : 5;
    const recalcWL = computeWorkoutWeightedLoad(c.run.workoutType, c.run.plannedDistanceKm, recalcRpe);
    console.log(`  ${c.run.workoutId} (${c.run.workoutType}) ${c.run.plannedDistanceKm}km — stored: A${c.run.plannedAerobic} An${c.run.plannedAnaerobic} wl=${storedWL.toFixed(1)} | recalc wl=${recalcWL.toFixed(1)} | sim=${c.similarity.toFixed(3)}`);
  }

  // §6.5 — detect edge cases before building adjustments
  // "Already completed": candidates empty but there ARE rated runs that would have matched
  const NON_RUN_TYPES = new Set(['gym', 'cross', 'strength', 'rest', 'swim', 'bike'] as const);
  const allRuns = weekRuns.filter(r => !NON_RUN_TYPES.has(r.workoutType as any));
  const completedRuns = allRuns.filter(r => r.status !== 'planned' && r.status !== 'reduced');
  const noViablePlanned = candidates.length === 0;
  let alreadyCompletedMatch: { runName: string; runType: string } | undefined;
  let noMatchingRun: boolean | undefined;
  if (noViablePlanned) {
    if (completedRuns.length > 0) {
      // Find the completed run most similar to this activity (by zone profile)
      const best = [...completedRuns].sort((a, b) => {
        const simA = vibeSimilarity(aerobic, anaerobic, a.plannedAerobic, a.plannedAnaerobic);
        const simB = vibeSimilarity(aerobic, anaerobic, b.plannedAerobic, b.plannedAnaerobic);
        return simB - simA;
      })[0];
      alreadyCompletedMatch = { runName: best.workoutId, runType: best.workoutType };
    } else {
      noMatchingRun = true;
    }
  }

  // Apply recovery multiplier to the reduction budget.
  // Cap the additional recovery contribution at 20 TSS equivalent (spec §6 guardrail).
  // Recovery modulates reduction aggressiveness — doesn't dominate it.
  const recoveryExtra = runReplacementCredit * (recoveryMultiplier - 1.0);
  const effectiveRRC = runReplacementCredit + Math.min(recoveryExtra, 20 * 15); // 20 TSS × 15 (load units per TSS approx)

  // Total planned running km from ALL runs (not just candidates) for accurate floor check
  const allPlannedKm = weekRuns.reduce((sum, r) => sum + r.plannedDistanceKm, 0);

  const reduceAdjustments = buildReduceAdjustments(
    candidates, effectiveRRC, severity, ctx, preserveMin, plannedCount, allPlannedKm
  );

  const replaceAdjustments = buildReplaceAdjustments(
    candidates, effectiveRRC, severity, ctx, sport, preserveMin, plannedCount, allPlannedKm
  );

  // Build outcome descriptions
  const keepDescription = 'Keep your running plan unchanged. Be mindful of accumulated fatigue.';

  // Helper: label for downgrade (threshold→marathon_pace shows "steady")
  const downgradePaceLabel = (a: Adjustment): string => {
    if (a.originalType === 'threshold' && a.newType === 'marathon_pace') return 'steady';
    return a.newType === 'marathon_pace' ? 'marathon pace' : a.newType === 'threshold' ? 'threshold' : 'easy';
  };

  let reduceDescription = 'No adjustments needed.';
  if (reduceAdjustments.length > 0) {
    const parts = reduceAdjustments.map(a => {
      if (a.action === 'downgrade') {
        return `${a.workoutId}: run at ${downgradePaceLabel(a)} instead`;
      }
      return `${a.workoutId}: reduce to ${a.newDistanceKm}km`;
    });
    reduceDescription = parts.join(', ');
  }

  let replaceDescription = reduceDescription;
  if (replaceAdjustments.some(a => a.action === 'replace')) {
    const parts = replaceAdjustments.map(a => {
      if (a.action === 'replace') {
        return a.newDistanceKm > 0
          ? `${a.workoutId}: replace with ${a.newDistanceKm}km shakeout`
          : `${a.workoutId}: replaced by ${sportDisplayName}`;
      }
      if (a.action === 'downgrade') {
        return `${a.workoutId}: run at ${downgradePaceLabel(a)} instead`;
      }
      return `${a.workoutId}: reduce to ${a.newDistanceKm}km`;
    });
    replaceDescription = parts.join(', ');
  }

  // Build headline and summary
  const headline = severity === 'extreme' ? 'Very heavy training load' :
                   severity === 'heavy' ? 'Heavy training load' :
                   'Sport session logged';

  // Describe actual impact from the reduce adjustments (the recommended option)
  const impactAdjs = reduceAdjustments.length > 0 ? reduceAdjustments : replaceAdjustments;
  const impactParts = impactAdjs.map(a => {
    if (a.action === 'downgrade') {
      const paceLabel = downgradePaceLabel(a);
      return `reduce the pace of your ${a.workoutId} to ${paceLabel} pace`;
    }
    if (a.action === 'replace') {
      return a.newDistanceKm > 0
        ? `convert your ${a.workoutId} to a ${a.newDistanceKm}km shakeout`
        : `replace your ${a.workoutId}`;
    }
    const reductionKm = Math.round((a.originalDistanceKm - a.newDistanceKm) * 10) / 10;
    return `reduce your ${a.workoutId} by ${reductionKm}km`;
  });
  const impactDescription = impactParts.length > 0
    ? impactParts.length === 1
      ? impactParts[0]
      : impactParts.slice(0, -1).join(', ') + ' and ' + impactParts[impactParts.length - 1]
    : '';

  const loadTierNote = loadResult.tier === 'rpe' ? ' (estimated from RPE)' : '';
  let summary: string;
  if (impactDescription) {
    summary = `Your ${activity.duration_min} min ${sportDisplayName} session${loadTierNote} carries enough load to ${impactDescription}.`;
  } else {
    summary = `Your ${activity.duration_min} min ${sportDisplayName} session${loadTierNote} has minimal impact on your running plan.`;
  }
  if (severity !== 'light') {
    summary += ' Consider adjusting your plan to avoid overtraining.';
  }

  // Warnings
  if (loadResult.tier === 'rpe') {
    warnings.push('Load estimated from RPE. For more accuracy, connect a fitness watch.');
  }
  if (preserveMin >= plannedCount) {
    warnings.push('Minimum runs preserved. We prioritize keeping running stimulus.');
  }

  // Build legacy format for backwards compatibility
  const ar = anaerobicRatio(aerobic, anaerobic);
  const globalSuggestion: GlobalSuggestion | null = severity !== 'light' ? {
    title: 'Heavy load detected',
    message: summary,
    reduceNonLongBy: severity === 'extreme' ? 0.25 : 0.15,
    downgradeNextQuality: true,
  } : null;

  // Convert adjustments to RunSuggestion format for compatibility
  const runSuggestions: RunSuggestion[] = reduceAdjustments.map(adj => {
    const run = weekRuns.find(r => r.workoutId === adj.workoutId)!;
    return {
      workoutId: adj.workoutId,
      dayIndex: run?.dayIndex ?? 0,
      currentType: adj.originalType,
      currentDistanceKm: adj.originalDistanceKm,
      similarity: candidates.find(c => c.run.workoutId === adj.workoutId)?.similarity ?? 0,
      recommended: adj.action === 'replace' ? 'replace' : 'reduce',
      options: [
        {
          choice: 'keep',
          newType: adj.originalType,
          newDistanceKm: adj.originalDistanceKm,
          rationale: 'Keep as planned.',
          tradeoffs: 'Risk: may accumulate fatigue.',
        },
        {
          choice: 'reduce',
          newType: adj.newType,
          newDistanceKm: adj.newDistanceKm,
          rationale: adj.action === 'downgrade' ? 'Downgrade intensity.' : 'Reduce distance.',
          tradeoffs: 'Safer recovery.',
        },
      ],
    };
  });

  return {
    severity,
    headline,
    summary,
    equivalentEasyKm,
    recoveryCostLoad: Math.round(recoveryCostLoad * 10) / 10,
    runReplacementCredit: Math.round(runReplacementCredit * 10) / 10,
    sportName: sportDisplayName,
    durationMin: activity.duration_min,
    tier: loadResult.tier,
    aerobicLoad: loadResult.aerobicLoad,
    anaerobicLoad: loadResult.anaerobicLoad,
    impactLoad: loadResult.impactLoad,
    keepOutcome: { adjustments: [], description: keepDescription },
    reduceOutcome: { adjustments: reduceAdjustments, description: reduceDescription },
    replaceOutcome: { adjustments: replaceAdjustments, description: replaceDescription },
    warnings,
    alreadyCompletedMatch,
    noMatchingRun,
    // Legacy compatibility
    globalSuggestion,
    runSuggestions,
    anaerobicRatio: Math.round(ar * 1000) / 1000,
  };
}

/**
 * Convert workouts to PlannedRun format for the suggester.
 * Uses parseWorkoutDescription for robust distance extraction from
 * time-based and interval workouts (e.g., "5×3min @ VO2", "20min @ threshold").
 */
export function workoutsToPlannedRuns(workouts: Workout[], paces?: Paces): PlannedRun[] {
  // Default paces if not provided (fallback for backward compatibility)
  const defaultPaces: Paces = paces || { e: 360, t: 300, i: 270, m: 315, r: 255 };

  return workouts
    .filter(w => w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' && w.t !== 'test_run' && w.t !== 'return_run' && w.t !== 'capacity_test' && w.t !== 'gym')
    .map((w, idx) => {
      // Use the canonical parser to handle all workout formats
      const parsed = parseWorkoutDescription(w.d, defaultPaces);
      let km = parsed.totalDistance / 1000; // Convert meters to km

      // Fallback: if parser returned 0, try simple regex (backward compat)
      if (km <= 0) {
        const kmMatch = w.d.match(/(\d+\.?\d*)km/);
        km = kmMatch ? parseFloat(kmMatch[1]) : 0;
      }

      // If still 0 and we have workout load, estimate distance from load
      // Rough estimate: 1km easy ≈ 35 aerobic load
      if (km <= 0 && w.aerobic && w.aerobic > 0) {
        km = w.aerobic / 35;
      }

      // Round to 1 decimal place
      km = Math.round(km * 10) / 10;

      return {
        workoutId: w.n,
        dayIndex: w.dayOfWeek ?? idx,
        workoutType: w.t as WorkoutType,
        plannedDistanceKm: km,
        plannedAerobic: w.aerobic || 0,
        plannedAnaerobic: w.anaerobic || 0,
        status: w.status || 'planned',
        alreadyDowngraded: w.status === 'reduced',
      };
    });
}

/**
 * Apply adjustments from a user's choice to workouts
 */
export function applyAdjustments(
  workouts: Workout[],
  adjustments: Adjustment[],
  sportName: string,
  paces?: Paces
): Workout[] {
  const modified = workouts.map(w => ({ ...w }));

  // Format sec/km to "X:XX"
  const fmtPace = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

  // Steady pace: halfway between easy and threshold (used for threshold downgrades)
  const steadyPaceSec = paces ? Math.round((paces.e + paces.t) / 2) : 0;

  // Get the actual pace string for a downgraded type
  const paceForType = (wt: WorkoutType, origType?: WorkoutType): string => {
    if (!paces) return wt === 'marathon_pace' ? 'MP' : wt === 'threshold' ? 'threshold' : 'easy';
    // Threshold → "steady" (halfway between easy and threshold)
    if (origType === 'threshold' && wt === 'marathon_pace') return `${fmtPace(steadyPaceSec)}/km`;
    if (wt === 'marathon_pace') return `${fmtPace(paces.m)}/km`;
    if (wt === 'threshold') return `${fmtPace(paces.t)}/km`;
    if (wt === 'easy') return `${fmtPace(paces.e)}/km`;
    return wt;
  };

  const paceLabelForType = (wt: WorkoutType, origType?: WorkoutType): string => {
    // Threshold → "steady" label
    if (origType === 'threshold' && wt === 'marathon_pace') return 'steady';
    return wt === 'marathon_pace' ? 'marathon pace' : wt === 'threshold' ? 'threshold' : 'easy';
  };

  for (const adj of adjustments) {
    // Match by both name and dayOfWeek for unique identification
    const workout = modified.find(w => w.n === adj.workoutId && w.dayOfWeek === adj.dayIndex);
    if (!workout) continue;

    if (adj.action === 'replace') {
      workout.originalDistance = workout.d;
      const newKm = Math.round(adj.newDistanceKm * 10) / 10;

      if (newKm > 0) {
        // Shakeout run: workout is converted but still needs to be done
        workout.status = 'reduced';  // Use 'reduced' so it remains active/ratable
        workout.d = `${newKm}km @ easy`;
        workout.modReason = `Converted to shakeout (was ${adj.originalType})`;
        workout.confidence = 'high';
        workout.t = 'easy';
        workout.rpe = 3;  // Shakeouts are easy effort
        workout.r = 3;
      } else {
        // Fully covered: no run needed
        workout.status = 'replaced';
        workout.d = '0km (replaced)';
        workout.modReason = `Replaced by ${sportName}`;
        workout.confidence = 'high';
        workout.t = adj.newType;
      }
    } else if (adj.action === 'downgrade') {
      workout.status = 'reduced';
      workout.originalDistance = workout.d;
      const origDesc = workout.d;
      const newPace = paceForType(adj.newType, adj.originalType);
      const label = paceLabelForType(adj.newType, adj.originalType);

      // Progressive/fast-finish (e.g. "13km: last 3 @ MP") → plain easy long run
      if (/last\s+\d/.test(origDesc)) {
        const totalMatch = origDesc.match(/^(\d+\.?\d*)km/);
        const totalKm = totalMatch ? parseFloat(totalMatch[1]) : Math.round(adj.originalDistanceKm);
        workout.d = `${totalKm}km`;
        workout.t = 'easy';
        workout.rpe = 3;
        workout.r = 3;
      }
      // Intervals with time (e.g. "3×8min @ 4:05/km ...") → same structure, new pace
      else if (/\d+×\d/.test(origDesc)) {
        // Extract reps, duration, and recovery from original description
        const intMatch = origDesc.match(/^(\d+)×(\d+\.?\d*)min\s*@\s*[^,\n]+(?:,\s*(.+))?/);
        if (intMatch) {
          const reps = intMatch[1];
          const dur = intMatch[2];
          const rest = intMatch[3] || '';
          workout.d = `${reps}×${dur}min @ ${newPace} (${label})${rest ? `, ${rest}` : ''}`;
        } else {
          workout.d = `${origDesc.replace(/@\s*[^,(\n]+/, `@ ${newPace} (${label})`)}`;
        }
      }
      // Continuous time-at-pace (e.g. "13min @ threshold") → same time, new pace
      else if (/^\d+min\s*@/.test(origDesc)) {
        const timeMatch = origDesc.match(/^(\d+)min/);
        const mins = timeMatch ? timeMatch[1] : '?';
        workout.d = `${mins}min @ ${newPace} (${label})`;
      }
      // Fallback: simple distance @ new pace
      else {
        const distKm = Math.round(adj.originalDistanceKm * 10) / 10;
        workout.d = distKm > 0 ? `${distKm}km @ ${newPace} (${label})` : `${origDesc} @ ${label} effort`;
      }

      workout.modReason = `Downgraded from ${adj.originalType} to ${label} due to ${sportName}`;
      workout.confidence = 'medium';
      if (workout.t !== 'easy') workout.t = adj.newType;
    } else if (adj.action === 'reduce') {
      workout.status = 'reduced';
      workout.originalDistance = workout.d;
      // Round to 1 decimal place
      const newKm = Math.round(adj.newDistanceKm * 10) / 10;
      const origKm = Math.round(adj.originalDistanceKm * 10) / 10;
      workout.d = `${newKm}km (was ${origKm}km)`;
      workout.modReason = `Reduced due to ${sportName}`;
      workout.confidence = 'medium';
      workout.t = adj.newType;
    }

    // Recalculate loads
    if (workout.status === 'reduced' || workout.status === 'replaced') {
      const newLoads = calculateWorkoutLoad(workout.t, workout.d, (workout.rpe || workout.r || 5) * 10);
      workout.aerobic = newLoads.aerobic;
      workout.anaerobic = newLoads.anaerobic;
    }
  }

  return modified;
}

// Legacy compatibility
export function applySuggestionChoice(
  workout: Workout,
  choice: Choice,
  option: Option,
  sportKey: string
): Workout {
  const modified = { ...workout };

  if (choice === 'keep') {
    return modified;
  }

  if (choice === 'replace') {
    modified.status = 'replaced';
    modified.originalDistance = modified.d;
    modified.d = option.newDistanceKm > 0 ? `${option.newDistanceKm}km` : '0km (replaced)';
    modified.modReason = `Replaced by ${sportKey}`;
    modified.confidence = 'high';
    modified.t = option.newType;
  } else {
    modified.status = 'reduced';
    modified.originalDistance = modified.d;
    modified.d = `${option.newDistanceKm}km (was ${modified.originalDistance})`;
    modified.modReason = `Reduced due to ${sportKey}`;
    modified.confidence = 'medium';
    modified.t = option.newType;
  }

  return modified;
}
