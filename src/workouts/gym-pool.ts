/**
 * Exercise pool + scheme composer for the on-demand gym generator's NEW focuses
 * (Upper, Full body). Running-strength and Lower keep their existing hardcoded
 * templates in gym.ts — this module is only reached for upper/full.
 *
 * The rep scheme lives in data (`GYM_GOAL_SCHEMES`), not baked into strings, so
 * a Goal (Strength / Muscle / General) is applied by one composer call. Every
 * composed line starts "{sets}x{reps} {Name}…" to satisfy the strength parser
 * (`parseStrengthSession` / `parseRepsAndName` in strength-model.ts), and every
 * loaded line carries the "@X% 1RM" garnish so it weight-tracks (the classifier
 * requires the marker — see strength-exercise-key.ts).
 *
 * Science: docs/SCIENCE_LOG.md §AY. v1 ships one ability tier (full-gym); per-
 * exercise equipment substitution and beginner/novice tiers are deferred.
 */

import type { Workout } from '@/types';
import { GYM_GOAL_SCHEMES, GYM_INTENSITY_PCT_STEP, type GymGoal, type GymGoalScheme } from '@/constants/strength-constants';

export type GymPoolFocus = 'upper' | 'lower' | 'full';
export type GymRestStyle = 'traditional' | 'circuit';
export type GymIntensity = 'easier' | 'standard' | 'harder';

/** Time presets (minutes) offered in the generator. */
export const GYM_TIME_PRESETS = [20, 30, 45, 60, 75, 90] as const;

export interface PoolExercise {
  name: string;
  region: 'upper' | 'lower' | 'core';
  /** Loaded movement (emits "@X% 1RM" + uses the goal rep scheme). */
  loadable: boolean;
  cue: string;
  /** Non-loaded accessory overrides (e.g. a plank): fixed prescription. */
  fixedSets?: number;
  fixedReps?: string;
  fixedRestSec?: number;
}

// ORDER MATTERS in all three pools: compounds lead, accessories/core trail.
// `tuneSessionDescription` trims from the front (`slice(0, count)`) for shorter
// sessions, so the leading entries must be the ones worth keeping.

/** Upper body: 2 press + 2 pull + 1 arm, all loaded. */
const UPPER_POOL: PoolExercise[] = [
  { name: 'Barbell Bench Press', region: 'upper', loadable: true, cue: 'Control the descent, drive through the chest' },
  { name: 'Overhead Press', region: 'upper', loadable: true, cue: 'Brace the core, press tall, ribs down' },
  { name: 'Dumbbell Row', region: 'upper', loadable: true, cue: 'Squeeze the shoulder blade, no torso swing' },
  { name: 'Lat Pulldown', region: 'upper', loadable: true, cue: 'Lead with the elbows, full stretch at the top' },
  { name: 'Biceps Curl', region: 'upper', loadable: true, cue: 'Controlled, no swing' },
];

/** Lower body: squat + hinge + single-leg + calf + core. Goal-driven (distinct
 *  from the running-supportive "Running strength" templates). */
const LOWER_POOL: PoolExercise[] = [
  { name: 'Back Squat', region: 'lower', loadable: true, cue: 'Brace, sit between the hips, drive up' },
  { name: 'Romanian Deadlift', region: 'lower', loadable: true, cue: 'Hinge from the hips, feel the hamstring stretch' },
  { name: 'Bulgarian Split Squat', region: 'lower', loadable: true, cue: 'Tall torso, drive through the front heel' },
  { name: 'Calf Raise', region: 'lower', loadable: true, cue: 'Full range, pause at the top' },
  { name: 'Front Plank', region: 'core', loadable: false, cue: 'Flat back, brace hard', fixedSets: 3, fixedReps: '45s', fixedRestSec: 30 },
];

/** Full body: squat + hinge + press + pull + core. */
const FULL_POOL: PoolExercise[] = [
  { name: 'Back Squat', region: 'lower', loadable: true, cue: 'Brace, sit between the hips, drive up' },
  { name: 'Romanian Deadlift', region: 'lower', loadable: true, cue: 'Hinge from the hips, feel the hamstring stretch' },
  { name: 'Overhead Press', region: 'upper', loadable: true, cue: 'Brace the core, press tall' },
  { name: 'Dumbbell Row', region: 'upper', loadable: true, cue: 'Squeeze the shoulder blade, no swing' },
  { name: 'Front Plank', region: 'core', loadable: false, cue: 'Flat back, brace hard', fixedSets: 3, fixedReps: '45s', fixedRestSec: 30 },
];

/** "(3 min rest)" / "(90s rest)" — matches the gym.ts rest-token format. */
function restLabel(sec: number): string {
  return sec >= 120 ? `${Math.round(sec / 60)} min rest` : `${sec}s rest`;
}

/** Compose one "{sets}x{reps} {Name} [@X% 1RM] (cue) (rest)" line. */
export function composeExerciseLine(ex: PoolExercise, scheme: GymGoalScheme, restStyle: GymRestStyle): string {
  if (!ex.loadable) {
    const sets = ex.fixedSets ?? scheme.sets;
    const reps = ex.fixedReps ?? scheme.reps;
    const rest = ex.fixedRestSec ?? (restStyle === 'circuit' ? scheme.restCircuitSec : scheme.restSec);
    return `${sets}x${reps} ${ex.name} (${ex.cue}) (${restLabel(rest)})`;
  }
  const rest = restStyle === 'circuit' ? scheme.restCircuitSec : scheme.restSec;
  return `${scheme.sets}x${scheme.reps} ${ex.name} @${scheme.loadPct}% 1RM (${ex.cue}) (${restLabel(rest)})`;
}

/** RPE label by goal (difficulty marker, not a model constant). */
const GOAL_RPE: Record<GymGoal, number> = { strength: 7, muscle: 7, general: 6 };

const POOL_BY_FOCUS: Record<GymPoolFocus, PoolExercise[]> = {
  upper: UPPER_POOL,
  lower: LOWER_POOL,
  full: FULL_POOL,
};
const NAME_BY_FOCUS: Record<GymPoolFocus, string> = {
  upper: 'Upper Body',
  lower: 'Lower Body',
  full: 'Full Body',
};

/** Rough session-duration estimate (min): per working set ~40s under tension plus
 *  the prescribed rest, summed, plus an 8-min warm-up/transition allowance. A UI
 *  estimate, not a model constant — but better than the generic 60-min fallback. */
const EST_WORK_SEC_PER_SET = 40;
const EST_WARMUP_MIN = 8;
function estimatePoolDurationMin(pool: PoolExercise[], scheme: GymGoalScheme, restStyle: GymRestStyle): number {
  const totalSec = pool.reduce((sum, ex) => {
    const sets = ex.loadable ? scheme.sets : (ex.fixedSets ?? scheme.sets);
    const rest = ex.loadable
      ? (restStyle === 'circuit' ? scheme.restCircuitSec : scheme.restSec)
      : (ex.fixedRestSec ?? 0);
    return sum + sets * (EST_WORK_SEC_PER_SET + rest);
  }, 0);
  return Math.round(totalSec / 60) + EST_WARMUP_MIN;
}

/**
 * Build a single Upper / Lower / Full body gym Workout for the chosen goal + rest
 * style. Same shape as the gym.ts templates ({ t:'gym', n, d, r, rpe }).
 */
export function buildPoolWorkout(focus: GymPoolFocus, goal: GymGoal, restStyle: GymRestStyle): Workout {
  const scheme = GYM_GOAL_SCHEMES[goal];
  const pool = POOL_BY_FOCUS[focus];
  const lines = pool.map(ex => composeExerciseLine(ex, scheme, restStyle));
  lines.push('Stretch to finish: 3-5 min full body');

  const name = restStyle === 'circuit' ? `${NAME_BY_FOCUS[focus]} (circuit)` : NAME_BY_FOCUS[focus];
  return {
    t: 'gym',
    n: name,
    d: lines.join('\n'),
    r: GOAL_RPE[goal],
    rpe: GOAL_RPE[goal],
    estimatedDurationMin: estimatePoolDurationMin(pool, scheme, restStyle),
  } as Workout;
}

// ─── Time + intensity tuning (applied to any .d-based gym session) ───────────

interface TimeSize { count: number; setDelta: number; }
/** Map a target session length to a session size (exercise count + set delta).
 *  Strength rests are long, so time scales the number of exercises AND sets. */
function timeSize(targetMin: number): TimeSize {
  if (targetMin <= 20) return { count: 3, setDelta: -1 };
  if (targetMin <= 30) return { count: 4, setDelta: 0 };
  if (targetMin <= 45) return { count: 5, setDelta: 0 };
  if (targetMin <= 60) return { count: 5, setDelta: 1 };
  if (targetMin <= 75) return { count: 5, setDelta: 2 };
  return { count: 5, setDelta: 3 };
}

function intensityLoadStep(intensity: GymIntensity): number {
  return intensity === 'easier' ? -GYM_INTENSITY_PCT_STEP
    : intensity === 'harder' ? GYM_INTENSITY_PCT_STEP : 0;
}

/** HYROX band for an intensity notch (eases/raises the station target pace).
 *  Returns the literal subset valid for both AbilityBand unions. */
export function hyroxBandForIntensity(intensity: GymIntensity): 'novice' | 'intermediate' | 'advanced' {
  return intensity === 'easier' ? 'novice' : intensity === 'harder' ? 'advanced' : 'intermediate';
}

/**
 * Adjust a newline `.d` exercise list for time + intensity: keep the first
 * `count` exercises (compounds lead, accessories trail), shift each working-set
 * count by `setDelta` (min 2), and shift each `@P% 1RM` load by `loadStep`
 * (clamped 40-90). The closing "Stretch" line is always kept. Non-loaded lines
 * (planks) keep their prescription apart from the set delta.
 */
function tuneSessionDescription(d: string, count: number, setDelta: number, loadStep: number): string {
  const lines = d.split('\n').filter(l => l.trim());
  const stretch = lines.find(l => /^stretch/i.test(l.trim()));
  const exercises = lines.filter(l => !/^stretch/i.test(l.trim())).slice(0, count);

  const tuned = exercises.map(line => {
    let out = line;
    if (setDelta !== 0) {
      out = out.replace(/^(\s*)(\d+)(\s*[x×])/i, (_m, sp, n, x) => `${sp}${Math.max(2, parseInt(n, 10) + setDelta)}${x}`);
    }
    if (loadStep !== 0) {
      out = out.replace(/@\s*(\d+)\s*%\s*1rm/i, (_m, p) => `@${Math.min(90, Math.max(40, parseInt(p, 10) + loadStep))}% 1RM`);
    }
    return out;
  });
  if (stretch) tuned.push(stretch);
  return tuned.join('\n');
}

/**
 * Apply the generator's time + intensity controls to a .d-based gym session
 * (pool or running-supportive template). HYROX bricks are tuned at generation
 * time instead (targetMinutes + band), so don't pass them here. Sets
 * estimatedDurationMin to the chosen target. Returns a new Workout.
 */
export function tuneGymWorkout(wo: Workout, targetMin: number, intensity: GymIntensity): Workout {
  const { count, setDelta } = timeSize(targetMin);
  const d = tuneSessionDescription(String((wo as any).d ?? ''), count, setDelta, intensityLoadStep(intensity));
  const rpeShift = intensity === 'harder' ? 1 : intensity === 'easier' ? -1 : 0;
  const baseRpe = (wo.rpe ?? (wo as any).r ?? 6) as number;
  const rpe = Math.max(3, Math.min(9, baseRpe + rpeShift));
  return { ...wo, d, rpe, r: rpe, estimatedDurationMin: targetMin } as Workout;
}
