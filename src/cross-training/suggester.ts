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

import type { Workout, RaceDistance, WorkoutType, SportKey, CrossActivity } from '@/types';
import { SPORTS_DB, ANAEROBIC_WEIGHT } from '@/constants';
import { normalizeSport } from './activities';
import { calculateWorkoutLoad } from '@/workouts';

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
}

export interface AthleteContext {
  raceGoal: RaceDistance;
  plannedRunsPerWeek: number;
  injuryMode: boolean;
  easyPaceSecPerKm?: number;
}

/** Single adjustment to a run */
export interface Adjustment {
  workoutId: string;
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

  // The 3 global choices and their outcomes
  keepOutcome: ChoiceOutcome;
  reduceOutcome: ChoiceOutcome;
  replaceOutcome: ChoiceOutcome;

  warnings: string[];
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
 * Resolve activity load using 3-tier system:
 * TIER 1: Garmin loads available
 * TIER 2: HR data available (future: compute TRIMP-like)
 * TIER 3: RPE + duration only
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
 * Downgrade a workout type to an easier version
 */
function downgradeType(wt: WorkoutType): WorkoutType {
  const downgrades: Partial<Record<WorkoutType, WorkoutType>> = {
    vo2: 'easy',
    intervals: 'easy',
    hill_repeats: 'easy',
    threshold: 'easy',
    race_pace: 'easy',
    marathon_pace: 'easy',
    mixed: 'easy',
    progressive: 'easy',
  };
  return downgrades[wt] || wt;
}

function isQualityWorkout(wt: WorkoutType): boolean {
  return ['vo2', 'intervals', 'hill_repeats', 'threshold', 'race_pace', 'marathon_pace', 'mixed', 'progressive'].includes(wt);
}

function computeWeeklyRunLoad(runs: PlannedRun[]): number {
  return runs
    .filter(r => r.status === 'planned')
    .reduce((sum, r) => sum + weightedLoad(r.plannedAerobic, r.plannedAnaerobic), 0);
}

/**
 * Estimate equivalent easy km for messaging
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

function buildCandidates(
  weekRuns: PlannedRun[],
  actAerobic: number,
  actAnaerobic: number,
  activityDayIndex: number,
  ctx: AthleteContext
): CandidateRun[] {
  const candidates: CandidateRun[] = [];

  for (const run of weekRuns) {
    if (run.status !== 'planned') continue;

    let sim = vibeSimilarity(actAerobic, actAnaerobic, run.plannedAerobic, run.plannedAnaerobic);

    // Same day bonus
    if (run.dayIndex === activityDayIndex) sim += SAME_DAY_BONUS;

    // Long run penalty (harder to touch)
    if (run.workoutType === 'long') sim -= LONG_PENALTY;

    // Race-goal protection penalty
    const protect = workoutPriorityForRace(ctx, run.workoutType);
    sim -= 0.02 * protect;

    const runLoad = weightedLoad(run.plannedAerobic, run.plannedAnaerobic);
    candidates.push({ run, similarity: sim, runLoad });
  }

  // Sort by similarity descending
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates;
}

/**
 * Build adjustments for REDUCE choice (downgrades and reductions only, no replacements)
 */
function buildReduceAdjustments(
  candidates: CandidateRun[],
  runReplacementCredit: number,
  severity: Severity,
  ctx: AthleteContext,
  preserveMin: number,
  plannedCount: number
): Adjustment[] {
  const adjustments: Adjustment[] = [];
  let remainingCredit = runReplacementCredit;

  const maxAdjustments = severity === 'extreme' ? MAX_ADJUSTMENTS_EXTREME :
                         severity === 'heavy' ? MAX_ADJUSTMENTS_HEAVY :
                         MAX_ADJUSTMENTS_LIGHT;

  for (const { run, runLoad } of candidates) {
    if (adjustments.length >= maxAdjustments) break;
    if (remainingCredit <= 10) break; // Not enough credit to matter

    // For LIGHT severity, only suggest one downgrade if it's a quality session
    if (severity === 'light' && adjustments.length >= 1) break;

    // Prefer downgrades for quality workouts
    if (isQualityWorkout(run.workoutType)) {
      const newType = downgradeType(run.workoutType);
      // Estimate load reduction from downgrade (quality → easy keeps distance but loses intensity load)
      const loadReduction = runLoad * 0.4; // Rough estimate: 40% load reduction from downgrade

      adjustments.push({
        workoutId: run.workoutId,
        action: 'downgrade',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType,
        newDistanceKm: run.plannedDistanceKm, // Keep distance
        loadReduction,
      });

      remainingCredit -= loadReduction;
      continue;
    }

    // For easy runs, reduce distance
    if (run.workoutType === 'easy') {
      const ratio = remainingCredit / runLoad;
      const reducePct = clamp(ratio * 0.3, 0.15, 0.40); // Conservative: 15-40% reduction
      let newKm = run.plannedDistanceKm * (1 - reducePct);

      // Clamp to minimum
      if (newKm < MIN_EASY_KM) {
        // If reduction would go below min, just skip this run for REDUCE
        continue;
      }

      newKm = Math.round(newKm * 10) / 10;
      const loadReduction = runLoad * reducePct;

      adjustments.push({
        workoutId: run.workoutId,
        action: 'reduce',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType: 'easy',
        newDistanceKm: newKm,
        loadReduction,
      });

      remainingCredit -= loadReduction;
    }

    // For long runs, only reduce if heavy/extreme and reduce conservatively
    if (run.workoutType === 'long' && severity !== 'light') {
      const reducePct = clamp(0.10, 0.10, 0.25); // Very conservative for long runs
      let newKm = run.plannedDistanceKm * (1 - reducePct);

      if (newKm < MIN_LONG_KM) {
        newKm = MIN_LONG_KM;
      }

      newKm = Math.round(newKm * 10) / 10;
      const loadReduction = runLoad * reducePct;

      adjustments.push({
        workoutId: run.workoutId,
        action: 'reduce',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType: 'easy', // Keep it easy effort
        newDistanceKm: newKm,
        loadReduction,
      });

      remainingCredit -= loadReduction;
    }
  }

  return adjustments;
}

/**
 * Build adjustments for REPLACE choice (includes replacements where appropriate)
 */
function buildReplaceAdjustments(
  candidates: CandidateRun[],
  runReplacementCredit: number,
  severity: Severity,
  ctx: AthleteContext,
  sport: SportProfile,
  preserveMin: number,
  plannedCount: number
): Adjustment[] {
  const adjustments: Adjustment[] = [];
  let remainingCredit = runReplacementCredit;
  let runsLeft = plannedCount;

  const maxAdjustments = severity === 'extreme' ? MAX_ADJUSTMENTS_EXTREME :
                         severity === 'heavy' ? MAX_ADJUSTMENTS_HEAVY :
                         MAX_ADJUSTMENTS_LIGHT;

  for (const { run, runLoad } of candidates) {
    if (adjustments.length >= maxAdjustments) break;
    if (remainingCredit <= 10) break;
    if (runsLeft <= preserveMin) break; // Preserve minimum runs

    const canReplace = canReplaceWorkout(sport, run.workoutType, ctx);
    const ratio = remainingCredit / runLoad;

    // Easy runs: replace if ratio is high enough
    if (run.workoutType === 'easy' && canReplace && ratio >= 0.8) {
      adjustments.push({
        workoutId: run.workoutId,
        action: 'replace',
        originalType: run.workoutType,
        originalDistanceKm: run.plannedDistanceKm,
        newType: 'easy',
        newDistanceKm: 0,
        loadReduction: runLoad,
      });

      remainingCredit -= runLoad;
      runsLeft--;
      continue;
    }

    // Quality runs: downgrade first, only replace if extreme
    if (isQualityWorkout(run.workoutType)) {
      if (severity === 'extreme' && canReplace && ratio >= 1.0) {
        // Replace with short shakeout
        adjustments.push({
          workoutId: run.workoutId,
          action: 'replace',
          originalType: run.workoutType,
          originalDistanceKm: run.plannedDistanceKm,
          newType: 'easy',
          newDistanceKm: MIN_EASY_KM,
          loadReduction: runLoad * 0.8,
        });

        remainingCredit -= runLoad * 0.8;
        runsLeft--;
      } else {
        // Downgrade instead
        const newType = downgradeType(run.workoutType);
        const loadReduction = runLoad * 0.4;

        adjustments.push({
          workoutId: run.workoutId,
          action: 'downgrade',
          originalType: run.workoutType,
          originalDistanceKm: run.plannedDistanceKm,
          newType,
          newDistanceKm: run.plannedDistanceKm,
          loadReduction,
        });

        remainingCredit -= loadReduction;
      }
      continue;
    }

    // Long runs: never replace (unless injury mode), only reduce
    if (run.workoutType === 'long') {
      if (severity !== 'light') {
        const reducePct = clamp(0.15, 0.10, 0.30);
        let newKm = Math.max(MIN_LONG_KM, run.plannedDistanceKm * (1 - reducePct));
        newKm = Math.round(newKm * 10) / 10;

        adjustments.push({
          workoutId: run.workoutId,
          action: 'reduce',
          originalType: run.workoutType,
          originalDistanceKm: run.plannedDistanceKm,
          newType: 'easy',
          newDistanceKm: newKm,
          loadReduction: runLoad * reducePct,
        });

        remainingCredit -= runLoad * reducePct;
      }
    }
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
  prevWeekRunLoad?: number
): SuggestionPopup {
  const warnings: string[] = [];

  const sportKey = normalizeSport(activity.sport);
  const sport = getSportProfile(sportKey);
  const sportDisplayName = sportKey.replace(/_/g, ' ');

  // Compute activity load (3-tier system)
  const { aerobic, anaerobic, tier } = resolveActivityLoad(activity, sport);
  const rawWeighted = weightedLoad(aerobic, anaerobic);

  // Apply recovery multiplier and saturation
  const rawRecoveryCost = rawWeighted * sport.recoveryMult;
  const recoveryCostLoad = saturate(rawRecoveryCost);

  // Run replacement credit (how much running it can substitute)
  const runReplacementCredit = recoveryCostLoad * sport.runSpec;

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
    tier === 1 // hasHR approximation: tier 1 = Garmin
  );

  // Compute equivalent easy km for messaging
  const equivalentEasyKm = computeEquivalentEasyKm(runReplacementCredit, ctx.easyPaceSecPerKm);

  // Build candidate list
  const candidates = buildCandidates(weekRuns, aerobic, anaerobic, activity.dayOfWeek, ctx);

  // Build adjustments for each choice
  const reduceAdjustments = buildReduceAdjustments(
    candidates, runReplacementCredit, severity, ctx, preserveMin, plannedCount
  );

  const replaceAdjustments = buildReplaceAdjustments(
    candidates, runReplacementCredit, severity, ctx, sport, preserveMin, plannedCount
  );

  // Build outcome descriptions
  const keepDescription = 'Keep your running plan unchanged. Be mindful of accumulated fatigue.';

  let reduceDescription = 'No adjustments needed.';
  if (reduceAdjustments.length > 0) {
    const parts = reduceAdjustments.map(a => {
      if (a.action === 'downgrade') {
        return `${a.workoutId}: change to easy effort`;
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
          : `${a.workoutId}: skip (covered by ${sportDisplayName})`;
      }
      if (a.action === 'downgrade') {
        return `${a.workoutId}: change to easy effort`;
      }
      return `${a.workoutId}: reduce to ${a.newDistanceKm}km`;
    });
    replaceDescription = parts.join(', ');
  }

  // Build headline and summary
  const headline = severity === 'extreme' ? 'Very heavy training load' :
                   severity === 'heavy' ? 'Heavy training load' :
                   'Sport session logged';

  const loadTierNote = tier === 3 ? ' (estimated from RPE)' : '';
  const summary = `Your ${activity.duration_min} min ${sportDisplayName} session is equivalent to ~${equivalentEasyKm}km easy running${loadTierNote}. ` +
    (severity === 'light'
      ? 'Your weekly load looks balanced. You can keep your plan or make minor adjustments.'
      : 'Consider reducing your running load to avoid overtraining.');

  // Warnings
  if (tier === 3) {
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
    keepOutcome: { adjustments: [], description: keepDescription },
    reduceOutcome: { adjustments: reduceAdjustments, description: reduceDescription },
    replaceOutcome: { adjustments: replaceAdjustments, description: replaceDescription },
    warnings,
    // Legacy compatibility
    globalSuggestion,
    runSuggestions,
    anaerobicRatio: Math.round(ar * 1000) / 1000,
  };
}

/**
 * Convert workouts to PlannedRun format for the suggester
 */
export function workoutsToPlannedRuns(workouts: Workout[]): PlannedRun[] {
  return workouts
    .filter(w => w.t !== 'cross' && w.t !== 'strength' && w.t !== 'rest' && w.t !== 'test_run')
    .map((w, idx) => {
      const kmMatch = w.d.match(/(\d+\.?\d*)km/);
      const km = kmMatch ? parseFloat(kmMatch[1]) : 0;

      return {
        workoutId: w.n,
        dayIndex: w.dayOfWeek ?? idx,
        workoutType: w.t as WorkoutType,
        plannedDistanceKm: km,
        plannedAerobic: w.aerobic || 0,
        plannedAnaerobic: w.anaerobic || 0,
        status: w.status || 'planned',
      };
    });
}

/**
 * Apply adjustments from a user's choice to workouts
 */
export function applyAdjustments(
  workouts: Workout[],
  adjustments: Adjustment[],
  sportName: string
): Workout[] {
  const modified = workouts.map(w => ({ ...w }));

  for (const adj of adjustments) {
    const workout = modified.find(w => w.n === adj.workoutId);
    if (!workout) continue;

    if (adj.action === 'replace') {
      workout.status = 'replaced';
      workout.originalDistance = workout.d;
      workout.d = adj.newDistanceKm > 0 ? `${adj.newDistanceKm}km` : '0km (replaced)';
      workout.modReason = `Replaced by ${sportName}`;
      workout.confidence = 'high';
      workout.t = adj.newType;
    } else if (adj.action === 'downgrade') {
      workout.status = 'reduced';
      workout.originalDistance = workout.d;
      workout.modReason = `Downgraded to easy due to ${sportName}`;
      workout.confidence = 'medium';
      workout.t = adj.newType;
      // Keep distance, just change type
    } else if (adj.action === 'reduce') {
      workout.status = 'reduced';
      workout.originalDistance = workout.d;
      workout.d = `${adj.newDistanceKm}km (was ${adj.originalDistanceKm}km)`;
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
