import type { RaceDistance, RunnerType, TrainingPhase, AbilityBand } from '@/types';
import type { SessionIntent, SlotType } from './intent_to_workout';

export interface PlanContext {
  runsPerWeek: number;
  raceDistance: RaceDistance;
  runnerType: RunnerType;
  phase: TrainingPhase;
  fitnessLevel: string;
  weekIndex: number;   // 1-based
  totalWeeks: number;
  vdot: number;
}

// ---------------------------------------------------------------------------
// Variant rotation arrays (ported from Python)
// ---------------------------------------------------------------------------

export const VO2_VARIANTS = [
  { id: 'vo2_5x3', reps: 5, repMin: 3, recMin: 2 },
  { id: 'vo2_6x2', reps: 6, repMin: 2, recMin: 2 },
  { id: 'vo2_5x4', reps: 5, repMin: 4, recMin: 2.5 },
  { id: 'vo2_12x1', reps: 12, repMin: 1, recMin: 1 },
];

export const THRESH_VARIANTS = [
  { id: 'thr_20cont', workMin: 20 },                                    // continuous
  { id: 'thr_3x8', reps: 3, repMin: 8, recMin: 2 },
  { id: 'thr_2x12', reps: 2, repMin: 12, recMin: 3 },
  { id: 'thr_cruise_5x5', reps: 5, repMin: 5, recMin: 1 },
];

export const LONG_VARIANTS = [
  { id: 'long_steady' },
  { id: 'long_fast_finish' },
  { id: 'long_with_blocks' },
];

// ---------------------------------------------------------------------------
// Ability band
// ---------------------------------------------------------------------------

export function abilityBandFromVdot(vdot: number, experience: string): AbilityBand {
  // VDOT-based band
  let vdotBand: AbilityBand;
  if (vdot < 30) vdotBand = 'beginner';
  else if (vdot < 40) vdotBand = 'novice';
  else if (vdot < 50) vdotBand = 'intermediate';
  else if (vdot < 60) vdotBand = 'advanced';
  else vdotBand = 'elite';

  // Experience can cap upward
  const expCap: Record<string, AbilityBand> = {
    total_beginner: 'beginner',
    beginner: 'novice',
    novice: 'novice',
    intermediate: 'intermediate',
    returning: 'intermediate',
    hybrid: 'intermediate',
    advanced: 'advanced',
    competitive: 'elite',
  };

  const cap = expCap[experience] || 'intermediate';
  const order: AbilityBand[] = ['beginner', 'novice', 'intermediate', 'advanced', 'elite'];
  const vIdx = order.indexOf(vdotBand);
  const cIdx = order.indexOf(cap);
  return order[Math.min(vIdx, cIdx)];
}

// ---------------------------------------------------------------------------
// Deload
// ---------------------------------------------------------------------------

export function isDeloadWeek(weekIndex: number, ability: AbilityBand): boolean {
  // No deload on week 1
  if (weekIndex <= 1) return false;
  const cycle =
    ability === 'beginner' || ability === 'novice' ? 3 :
    ability === 'intermediate' ? 4 :
    ability === 'advanced' ? 5 : 6;
  return weekIndex % cycle === 0;
}

export function deloadMultiplier(ability: AbilityBand): number {
  switch (ability) {
    case 'beginner': return 0.80;
    case 'novice': return 0.80;
    case 'intermediate': return 0.85;
    case 'advanced': return 0.87;
    case 'elite': return 0.90;
  }
}

// ---------------------------------------------------------------------------
// Quality cap
// ---------------------------------------------------------------------------

export function qualityCap(ability: AbilityBand, experience: string, runsPerWeek: number): number {
  let base: number;
  switch (ability) {
    case 'beginner': base = 1; break;
    case 'novice': base = 1; break;
    case 'intermediate': base = 2; break;
    case 'advanced': base = 2; break;
    case 'elite': base = 3; break;
  }
  // Can't have more quality than runs - 1 (need at least one easy)
  return Math.min(base, Math.max(0, runsPerWeek - 1));
}

// ---------------------------------------------------------------------------
// Time-based session budgets
// ---------------------------------------------------------------------------

export function longRunMinutes(
  weekIndex: number, totalWeeks: number, ability: AbilityBand,
  race: RaceDistance, phase: TrainingPhase
): number {
  // Base long run by race
  const baseLong: Record<RaceDistance, number> = {
    '5k': 50, '10k': 60, half: 80, marathon: 90,
  };
  let base = baseLong[race];

  // Progressive: ramp from 80% to 100% over plan
  const progress = Math.min(1, weekIndex / (totalWeeks * 0.75));
  base = base * (0.80 + 0.20 * progress);

  // Phase caps
  if (phase === 'taper') base *= 0.65;
  else if (phase === 'peak') base *= 1.05;

  // Ability caps
  const cap: Record<AbilityBand, number> = {
    beginner: 90, novice: 100, intermediate: 120, advanced: 150, elite: 180,
  };
  return Math.round(Math.min(base, cap[ability]));
}

export function easyRunMinutes(ability: AbilityBand, race: RaceDistance, phase: TrainingPhase): number {
  const base: Record<AbilityBand, number> = {
    beginner: 30, novice: 35, intermediate: 40, advanced: 45, elite: 50,
  };
  let mins = base[ability];
  // Race multiplier
  if (race === 'marathon') mins *= 1.15;
  else if (race === 'half') mins *= 1.05;
  // Phase
  if (phase === 'taper') mins *= 0.70;
  return Math.round(mins);
}

export function thresholdWorkMinutes(
  ability: AbilityBand, phase: TrainingPhase,
  weekIndex: number, totalWeeks: number
): number {
  const base: Record<AbilityBand, number> = {
    beginner: 12, novice: 15, intermediate: 20, advanced: 25, elite: 30,
  };
  let mins = base[ability];

  // Progressive
  const progress = Math.min(1, weekIndex / (totalWeeks * 0.8));
  mins = mins * (0.75 + 0.25 * progress);

  // Phase
  if (phase === 'base') mins *= 0.85;
  else if (phase === 'build') mins *= 1.0;
  else if (phase === 'peak') mins *= 1.05;
  else if (phase === 'taper') mins *= 0.60;

  return Math.round(mins);
}

export function vo2WorkMinutes(ability: AbilityBand, phase: TrainingPhase): number {
  const base: Record<AbilityBand, number> = {
    beginner: 8, novice: 10, intermediate: 14, advanced: 18, elite: 22,
  };
  let mins = base[ability];
  if (phase === 'base') mins *= 0.6;
  else if (phase === 'build') mins *= 0.9;
  else if (phase === 'peak') mins *= 1.1;
  else if (phase === 'taper') mins *= 0.5;
  return Math.round(mins);
}

export function mpWorkMinutes(
  race: RaceDistance, ability: AbilityBand, phase: TrainingPhase
): number {
  // Marathon pace only for marathon (and optionally half)
  if (race !== 'marathon' && race !== 'half') return 0;
  if (phase === 'base' || phase === 'taper') return 0;

  const base: Record<AbilityBand, number> = {
    beginner: 15, novice: 20, intermediate: 30, advanced: 40, elite: 50,
  };
  let mins = base[ability];
  if (race === 'half') mins *= 0.6;
  if (phase === 'build') mins *= 0.85;
  // peak: 1.0
  return Math.round(mins);
}

// ---------------------------------------------------------------------------
// Workout priority by race + phase (ported from Python)
// ---------------------------------------------------------------------------

function workoutPriority(race: RaceDistance, phase: TrainingPhase): SlotType[] {
  if (race === 'marathon') {
    if (phase === 'base') return ['threshold', 'vo2', 'marathon_pace'];
    if (phase === 'build') return ['marathon_pace', 'threshold', 'vo2'];
    if (phase === 'peak') return ['marathon_pace', 'vo2', 'threshold'];
    return ['threshold']; // taper
  }
  if (race === 'half') {
    if (phase === 'base') return ['threshold', 'vo2'];
    if (phase === 'build') return ['threshold', 'vo2', 'marathon_pace'];
    if (phase === 'peak') return ['vo2', 'threshold'];
    return ['threshold'];
  }
  if (race === '10k') {
    if (phase === 'base') return ['threshold', 'vo2'];
    if (phase === 'build') return ['vo2', 'threshold'];
    if (phase === 'peak') return ['vo2', 'threshold'];
    return ['threshold'];
  }
  // 5k
  if (phase === 'base') return ['threshold', 'vo2'];
  if (phase === 'build') return ['vo2', 'threshold'];
  if (phase === 'peak') return ['vo2', 'threshold'];
  return ['vo2'];
}

function applyRunnerTypeBias(priority: SlotType[], runnerType: RunnerType): SlotType[] {
  if (runnerType === 'Balanced') return priority;
  // Speed runners: promote endurance work (threshold up)
  // Endurance runners: promote speed work (vo2 up)
  const boost: SlotType = runnerType === 'Speed' ? 'threshold' : 'vo2';
  const idx = priority.indexOf(boost);
  if (idx > 0) {
    const arr = [...priority];
    arr.splice(idx, 1);
    arr.unshift(boost);
    return arr;
  }
  return priority;
}

// ---------------------------------------------------------------------------
// Main entry: planWeekSessions
// ---------------------------------------------------------------------------

export function planWeekSessions(ctx: PlanContext): SessionIntent[] {
  const {
    runsPerWeek, raceDistance, runnerType, phase, fitnessLevel,
    weekIndex, totalWeeks, vdot,
  } = ctx;

  const ability = abilityBandFromVdot(vdot, fitnessLevel);
  const deload = isDeloadWeek(weekIndex, ability);
  const dMult = deload ? deloadMultiplier(ability) : 1.0;

  const intents: SessionIntent[] = [];
  const maxQuality = qualityCap(ability, fitnessLevel, runsPerWeek);

  // For 1 run/week: single combined session
  if (runsPerWeek <= 1) {
    const mins = Math.round(longRunMinutes(weekIndex, totalWeeks, ability, raceDistance, phase) * dMult);
    intents.push({
      dayIndex: 0,
      slot: 'long',
      totalMinutes: mins,
      workMinutes: mins,
      variantId: 'long_steady',
      notes: deload ? 'Deload week' : '',
    });
    return intents;
  }

  // Place long run (last slot) for half/marathon or >= 3 runs
  const needsLong = raceDistance === 'half' || raceDistance === 'marathon' || runsPerWeek >= 3;
  let slotsRemaining = runsPerWeek;

  if (needsLong) {
    const longMins = Math.round(longRunMinutes(weekIndex, totalWeeks, ability, raceDistance, phase) * dMult);
    const longVar = LONG_VARIANTS[Math.max(0, (weekIndex - 1)) % LONG_VARIANTS.length];
    intents.push({
      dayIndex: runsPerWeek - 1, // last day
      slot: 'long',
      totalMinutes: longMins,
      workMinutes: longMins,
      variantId: longVar.id,
      notes: deload ? 'Deload week' : '',
    });
    slotsRemaining--;
  }

  // Fill quality sessions
  let qualityFilled = 0;
  const priority = applyRunnerTypeBias(workoutPriority(raceDistance, phase), runnerType);
  let dayIdx = 0;

  for (const slot of priority) {
    if (qualityFilled >= maxQuality || slotsRemaining <= 0) break;
    // Reserve at least 1 slot for easy (unless we're the last slot)
    if (slotsRemaining <= 1 && qualityFilled > 0) break;

    if (slot === 'threshold') {
      const workMins = Math.round(thresholdWorkMinutes(ability, phase, weekIndex, totalWeeks) * dMult);
      const variant = THRESH_VARIANTS[Math.max(0, (weekIndex - 1)) % THRESH_VARIANTS.length];
      const totalMins = variant.reps
        ? Math.round(variant.reps * (variant.repMin! + variant.recMin!) + 15) // warmup/cooldown
        : workMins + 20; // continuous: warmup + cooldown
      intents.push({
        dayIndex: dayIdx++,
        slot: 'threshold',
        totalMinutes: Math.round(totalMins * dMult),
        workMinutes: workMins,
        reps: variant.reps,
        repMinutes: variant.repMin,
        recoveryMinutes: variant.recMin,
        variantId: variant.id,
        notes: deload ? 'Deload week' : '',
      });
    } else if (slot === 'vo2') {
      const workMins = Math.round(vo2WorkMinutes(ability, phase) * dMult);
      const variant = VO2_VARIANTS[Math.max(0, (weekIndex - 1)) % VO2_VARIANTS.length];
      const totalMins = Math.round(variant.reps * (variant.repMin + variant.recMin) + 15);
      intents.push({
        dayIndex: dayIdx++,
        slot: 'vo2',
        totalMinutes: Math.round(totalMins * dMult),
        workMinutes: workMins,
        reps: variant.reps,
        repMinutes: variant.repMin,
        recoveryMinutes: variant.recMin,
        variantId: variant.id,
        notes: deload ? 'Deload week' : '',
      });
    } else if (slot === 'marathon_pace') {
      const workMins = Math.round(mpWorkMinutes(raceDistance, ability, phase) * dMult);
      if (workMins <= 0) continue; // skip if not applicable
      intents.push({
        dayIndex: dayIdx++,
        slot: 'marathon_pace',
        totalMinutes: workMins + 20,
        workMinutes: workMins,
        variantId: 'mp_continuous',
        notes: deload ? 'Deload week' : '',
      });
    }

    qualityFilled++;
    slotsRemaining--;
  }

  // Fill remaining with easy
  while (slotsRemaining > 0) {
    const easyMins = Math.round(easyRunMinutes(ability, raceDistance, phase) * dMult);
    intents.push({
      dayIndex: dayIdx++,
      slot: 'easy',
      totalMinutes: easyMins,
      workMinutes: easyMins,
      variantId: 'easy_steady',
      notes: deload ? 'Deload week' : '',
    });
    slotsRemaining--;
  }

  return intents;
}
