import type { RaceDistance, RunnerType, TrainingPhase } from '@/types';

/** Workout slot type */
export type SlotType =
  | 'long' | 'marathon_pace' | 'threshold' | 'easy' | 'vo2'
  | 'hill_repeats' | 'progressive' | 'race_pace' | 'mixed' | 'intervals';

/** Context for slot generation */
export interface SlotContext {
  runsPerWeek: number;
  raceDistance: RaceDistance;
  runnerType: RunnerType;
  phase: TrainingPhase;
  fitnessLevel: string; // experience level
}

/** Slot allocation result */
export interface SlotAllocation {
  slots: SlotType[];
  warnings: string[];
}

/** Fitness level limits */
interface FitnessLimits {
  maxQuality: number;
  maxVo2: number;
  maxHills: number;
}

const QUALITY_TYPES: SlotType[] = [
  'threshold', 'vo2', 'race_pace', 'marathon_pace',
  'intervals', 'mixed', 'hill_repeats', 'progressive',
];

function isQualitySession(wt: SlotType): boolean {
  return QUALITY_TYPES.includes(wt);
}

/** Minimum runs required per distance */
export function minRunsRequired(target: RaceDistance): number {
  switch (target) {
    case '5k': return 2;
    case '10k': return 3;
    case 'half': return 3;
    case 'marathon': return 4;
  }
}

/** Base priority ordering by target distance */
function basePriorityOrder(target: RaceDistance): SlotType[] {
  switch (target) {
    case 'marathon':
      return ['long', 'marathon_pace', 'threshold', 'easy', 'vo2', 'hill_repeats', 'progressive', 'race_pace', 'mixed', 'intervals'];
    case 'half':
      return ['long', 'threshold', 'race_pace', 'easy', 'vo2', 'hill_repeats', 'progressive', 'mixed', 'intervals', 'marathon_pace'];
    case '10k':
      return ['threshold', 'vo2', 'long', 'race_pace', 'easy', 'hill_repeats', 'progressive', 'mixed', 'intervals', 'marathon_pace'];
    case '5k':
      return ['vo2', 'threshold', 'race_pace', 'long', 'easy', 'hill_repeats', 'progressive', 'mixed', 'intervals', 'marathon_pace'];
  }
}

/** Runner type bias multipliers */
function runnerTypeBias(target: RaceDistance, runnerType: RunnerType): Record<SlotType, number> {
  const order = basePriorityOrder(target);
  const bias: Record<string, number> = {};
  for (const k of order) bias[k] = 1.0;

  if (runnerType === 'Speed') {
    // Speedsters need more endurance work to balance
    bias['threshold'] = (bias['threshold'] || 1) * 1.10;
    bias['long'] = (bias['long'] || 1) * 1.15;
    bias['marathon_pace'] = (bias['marathon_pace'] || 1) * 1.10;
    bias['vo2'] = (bias['vo2'] || 1) * 0.90;
    bias['intervals'] = (bias['intervals'] || 1) * 0.90;
  } else if (runnerType === 'Endurance') {
    // Endurance runners need more speed stimulus
    bias['vo2'] = (bias['vo2'] || 1) * 1.10;
    bias['intervals'] = (bias['intervals'] || 1) * 1.10;
    bias['hill_repeats'] = (bias['hill_repeats'] || 1) * 1.05;
    bias['threshold'] = (bias['threshold'] || 1) * 0.95;
    if (target === 'half' || target === 'marathon') {
      bias['long'] = (bias['long'] || 1) * 1.05;
    }
  }
  // Balanced: no bias adjustments

  return bias as Record<SlotType, number>;
}

/** Fitness level limits on quality sessions */
function fitnessLevelLimits(level: string): FitnessLimits {
  switch (level) {
    case 'total_beginner':
    case 'beginner':
      return { maxQuality: 1, maxVo2: 0, maxHills: 0 };
    case 'novice':
      return { maxQuality: 1, maxVo2: 1, maxHills: 1 };
    case 'intermediate':
    case 'returning':
    case 'hybrid':
      return { maxQuality: 2, maxVo2: 1, maxHills: 1 };
    case 'advanced':
      return { maxQuality: 2, maxVo2: 2, maxHills: 1 };
    case 'competitive':
      return { maxQuality: 3, maxVo2: 2, maxHills: 2 };
    default:
      return { maxQuality: 2, maxVo2: 1, maxHills: 1 };
  }
}

/** Phase adjustments: boost/demote certain types per phase */
function phaseMultipliers(phase: TrainingPhase): Record<string, number> {
  switch (phase) {
    case 'base':
      return { threshold: 1.2, easy: 1.3, long: 1.1, vo2: 0.7, race_pace: 0.5, marathon_pace: 0.6 };
    case 'build':
      return { threshold: 1.1, race_pace: 1.2, marathon_pace: 1.1, vo2: 1.0, progressive: 1.1 };
    case 'peak':
      return { race_pace: 1.3, mixed: 1.2, progressive: 1.2, vo2: 1.1, threshold: 0.9 };
    case 'taper':
      return { easy: 1.5, race_pace: 1.1, threshold: 0.7, vo2: 0.5, long: 0.8, marathon_pace: 0.7 };
  }
}

/**
 * Generate ordered run slots based on training context.
 * This is the core rules engine that determines which workout types
 * to assign for a given week.
 */
export function generateOrderedRunSlots(ctx: SlotContext): SlotAllocation {
  const { runsPerWeek, raceDistance, runnerType, phase, fitnessLevel } = ctx;
  const warnings: string[] = [];

  // 1. Check minimum runs
  const minRuns = minRunsRequired(raceDistance);
  if (runsPerWeek < minRuns) {
    warnings.push(
      `${runsPerWeek} runs/week is below recommended minimum of ${minRuns} for ${raceDistance}. Plan quality may be limited.`
    );
  }

  // 2. Score each workout type: base_position_score * runner_bias * phase_multiplier
  const order = basePriorityOrder(raceDistance);
  const bias = runnerTypeBias(raceDistance, runnerType);
  const phaseMult = phaseMultipliers(phase);
  const limits = fitnessLevelLimits(fitnessLevel);

  // Score = inverse of position (higher = better) * bias * phase
  const scores: { type: SlotType; score: number }[] = order.map((type, idx) => {
    const positionScore = (order.length - idx) / order.length; // 1.0 down to 0.1
    const b = bias[type] || 1.0;
    const pm = phaseMult[type] || 1.0;
    return { type, score: positionScore * b * pm };
  });

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  // 3. Fill slots greedily, respecting limits
  const slots: SlotType[] = [];
  let qualityCount = 0;
  let vo2Count = 0;
  let hillCount = 0;
  let hasLong = false;

  // Mandatory: Long run for half/marathon if >= 2 runs
  const needsLong = (raceDistance === 'half' || raceDistance === 'marathon') && runsPerWeek >= 2;
  // For 10k, long run if >= 3 runs
  const needsLong10k = raceDistance === '10k' && runsPerWeek >= 3;
  // For 5k, long run if >= 4 runs
  const needsLong5k = raceDistance === '5k' && runsPerWeek >= 4;

  if (needsLong || needsLong10k || needsLong5k) {
    slots.push('long');
    hasLong = true;
  }

  // Mandatory: marathon_pace for marathon if space allows (>= 4 runs, build/peak phase)
  const needsMP = raceDistance === 'marathon' &&
    runsPerWeek >= 4 &&
    (phase === 'build' || phase === 'peak');

  if (needsMP && slots.length < runsPerWeek) {
    slots.push('marathon_pace');
    qualityCount++;
  }

  // Fill remaining from scored list
  for (const { type } of scores) {
    if (slots.length >= runsPerWeek) break;
    if (slots.includes(type)) continue; // already added

    if (type === 'long') {
      if (!hasLong && slots.length < runsPerWeek) {
        slots.push('long');
        hasLong = true;
      }
      continue;
    }

    if (type === 'easy') {
      // Easy always allowed, skip quality checks
      slots.push('easy');
      continue;
    }

    // Quality session checks
    if (isQualitySession(type)) {
      if (qualityCount >= limits.maxQuality) continue;
      if (type === 'vo2' && vo2Count >= limits.maxVo2) continue;
      if (type === 'hill_repeats' && hillCount >= limits.maxHills) continue;

      slots.push(type);
      qualityCount++;
      if (type === 'vo2') vo2Count++;
      if (type === 'hill_repeats') hillCount++;
    }
  }

  // 5. Fill any remaining slots with easy
  while (slots.length < runsPerWeek) {
    slots.push('easy');
  }

  // 6. Post-process: order for weekly pattern
  // Pattern: Quality -> Buffer(easy) -> Quality -> Buffer(easy) -> Long (end of week)
  const orderedSlots = orderWeeklyPattern(slots);

  return { slots: orderedSlots, warnings };
}

/**
 * Order slots into a sensible weekly pattern:
 * Quality sessions separated by easy/buffer days, long run at end.
 */
function orderWeeklyPattern(slots: SlotType[]): SlotType[] {
  const long = slots.filter(s => s === 'long');
  const quality = slots.filter(s => isQualitySession(s));
  const easy = slots.filter(s => s === 'easy');

  const ordered: SlotType[] = [];

  // Interleave: quality, easy, quality, easy, ..., long
  let qi = 0;
  let ei = 0;

  while (qi < quality.length || ei < easy.length) {
    if (qi < quality.length) {
      ordered.push(quality[qi++]);
    }
    if (ei < easy.length) {
      ordered.push(easy[ei++]);
    }
  }

  // Remaining easy
  while (ei < easy.length) {
    ordered.push(easy[ei++]);
  }

  // Long run last
  for (const l of long) {
    ordered.push(l);
  }

  return ordered;
}
