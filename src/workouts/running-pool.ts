/**
 * World-class, rotating "Running strength" pool.
 *
 * Running strength is multi-modal — heavy compounds (3-5 reps @80%), high-rep
 * eccentric calf work (15-20), timed isometric holds, low-rep explosive plyo,
 * tibialis/foot drills — so a single goal rep-scheme (the Upper/Lower/Full
 * model) does NOT fit. Each exercise therefore carries its OWN prescription.
 *
 * A session is BALANCED (one per category, in priority order), the variant
 * within each category ROTATES by week (`slotIndex`, mirroring the HYROX
 * pickStations rotation), the number of categories scales with the time the
 * user has, and base-phase de-prioritises high-soreness movements. Everything
 * is grounded in docs/SCIENCE_LOG.md §BA. All [PROP] doses endorsed by Tristan.
 *
 * Only used by the on-demand generator's "Running strength" focus. The plan
 * engine's auto-gym (no focus) keeps its phase templates (Phase 2).
 */

import type { Workout, TrainingPhase } from '@/types';
import type { GymGoalScheme } from '@/constants/strength-constants';
import { GYM_INTENSITY_PCT_STEP } from '@/constants/strength-constants';
import { composeExerciseLine, type PoolExercise, type GymRestStyle, type GymIntensity } from './gym-pool';

export type RunningStrengthCategory =
  | 'max-strength' | 'single-leg' | 'posterior' | 'calf-foot'
  | 'hip-stability' | 'plyo' | 'core';

export interface RunningPoolExercise {
  name: string;
  sets: number;
  reps: string;             // "5" | "12 each leg" | "30s" | "20m each side"
  loadPct?: number;         // present => emits "@X% 1RM" => weight-tracks
  cue: string;
  restSec: number;
  /** Eccentric / plyometric / high-CNS — pushed to the back of its category in
   *  the base phase, mirroring HYROX's ECCENTRIC_HEAVY_STATIONS reorder. */
  highSoreness?: boolean;
}

// ── The library (docs/SCIENCE_LOG.md §BB). 4-8 variants per category. ─────────

const RUNNING_POOL: Record<RunningStrengthCategory, RunningPoolExercise[]> = {
  'max-strength': [
    { name: 'Back Squat', sets: 4, reps: '5', loadPct: 80, restSec: 180, cue: 'Brace, sit between the hips, drive up' },
    { name: 'Trap-Bar Deadlift', sets: 3, reps: '5', loadPct: 80, restSec: 180, cue: 'Flat back, push the floor away' },
    { name: 'Front Squat', sets: 3, reps: '5', loadPct: 80, restSec: 180, cue: 'Tall chest, elbows up' },
    { name: 'Deadlift', sets: 3, reps: '5', loadPct: 80, restSec: 180, cue: 'Heavy, 2 reps in reserve' },
  ],
  'single-leg': [
    { name: 'Bulgarian Split Squat', sets: 3, reps: '8 each leg', loadPct: 60, restSec: 90, cue: 'Tall torso, drive through the front heel' },
    { name: 'Step-Up', sets: 3, reps: '10 each leg', loadPct: 50, restSec: 75, cue: 'Drive through the heel, control the way down' },
    { name: 'Weighted Lunge', sets: 3, reps: '8 each leg', loadPct: 50, restSec: 75, cue: 'Controlled descent, knee tracks the toe' },
    { name: 'Single-Leg Squat to box', sets: 3, reps: '6 each leg', cue: 'Sit to the box, stand without rocking', restSec: 90 },
  ],
  'posterior': [
    { name: 'Romanian Deadlift', sets: 3, reps: '8', loadPct: 60, restSec: 90, cue: 'Hinge from the hips, feel the hamstring stretch' },
    { name: 'Single-Leg RDL', sets: 3, reps: '10 each leg', loadPct: 40, restSec: 75, cue: 'Balance first, then load' },
    { name: 'Nordic Curl', sets: 3, reps: '6', cue: 'Slow eccentric, push back up to reset', restSec: 90, highSoreness: true },
    { name: 'Hip Thrust', sets: 3, reps: '10', loadPct: 60, restSec: 75, cue: 'Squeeze the glutes 1s at the top' },
  ],
  'calf-foot': [
    { name: 'Standing Calf Raise', sets: 4, reps: '12', loadPct: 50, restSec: 60, cue: 'Full range, pause at the top' },
    { name: 'Soleus Calf Raise', sets: 4, reps: '15', loadPct: 50, restSec: 60, cue: 'Knee bent 90 degrees, slow up and down' },
    { name: 'Single-Leg Calf Raise', sets: 3, reps: '12 each leg', cue: 'Full height, no hop, control the drop', restSec: 60 },
    { name: 'Eccentric Calf Drop', sets: 3, reps: '15 each leg', cue: 'Lower for 3s below the step, reset with both feet', restSec: 60, highSoreness: true },
    { name: 'Isometric Calf Hold', sets: 4, reps: '30s', cue: 'Hold mid-range, drive the ball of the foot down', restSec: 60 },
    { name: 'Tibialis Raise', sets: 3, reps: '18', loadPct: 40, restSec: 45, cue: 'Back to the wall, pull the toes up slowly' },
    { name: 'Heel Walks', sets: 3, reps: '20m', cue: 'Toes up, walk on the heels', restSec: 45 },
  ],
  'hip-stability': [
    { name: 'Copenhagen Plank', sets: 3, reps: '20s each side', cue: 'Top foot on the bench, lift the hips, hold level', restSec: 45 },
    { name: 'Banded Lateral Walk', sets: 3, reps: '15 each way', cue: 'Band above the knees, stay low, no torso lean', restSec: 45 },
    { name: 'Banded Clamshell', sets: 3, reps: '15 each side', cue: 'Slow and controlled, hips stacked', restSec: 30 },
    { name: 'Single-Leg Glute Bridge', sets: 3, reps: '10 each leg', cue: 'Squeeze at the top, keep the hips level', restSec: 45 },
    { name: 'Side-Lying Hip Abduction', sets: 3, reps: '15 each side', cue: 'Lead with the heel, no hip roll', restSec: 30 },
  ],
  'plyo': [
    { name: 'Pogo Hops', sets: 4, reps: '20', cue: 'Stiff legs, tiny fast ground contacts', restSec: 60 },
    { name: 'Box Jumps', sets: 3, reps: '5', cue: 'Land softly, step down to reset', restSec: 90 },
    { name: 'Single-Leg Bounds', sets: 3, reps: '5 each leg', cue: 'Powerful push through the ankle', restSec: 90, highSoreness: true },
    { name: 'Jump Squat', sets: 4, reps: '3', cue: 'Explosive, maximum height, land soft', restSec: 90 },
    { name: 'Depth Jump', sets: 3, reps: '5', cue: 'Drop from a low box, rebound instantly', restSec: 120, highSoreness: true },
  ],
  'core': [
    { name: 'Pallof Press', sets: 3, reps: '10 each side', cue: 'Resist the rotation, brace the core', restSec: 45 },
    { name: 'Suitcase Carry', sets: 3, reps: '20m each side', cue: 'Tall, level shoulders, do not lean', restSec: 60 },
    { name: 'Side Plank', sets: 3, reps: '30s each side', cue: 'Stack the hips, brace hard', restSec: 30 },
    { name: 'Dead Bug', sets: 3, reps: '10', cue: 'Slow, keep the lower back flat', restSec: 30 },
    { name: 'Bird Dog', sets: 3, reps: '10 each side', cue: 'Opposite arm and leg, no hip rock', restSec: 30 },
  ],
};

/** Session build order: the essentials lead, plyo/core fill as time grows. */
const CATEGORY_ORDER: RunningStrengthCategory[] = [
  'max-strength', 'single-leg', 'posterior', 'calf-foot', 'hip-stability', 'core', 'plyo',
];

/** How many exercises (categories) to include for a target session length.
 *  Running strength scales BREADTH with time, not just sets. */
function exerciseCountForTime(targetMin: number): number {
  if (targetMin <= 20) return 4;
  if (targetMin <= 30) return 5;
  if (targetMin <= 45) return 6;
  if (targetMin <= 60) return 7;
  if (targetMin <= 75) return 8;
  return 9;
}

/** Categories to draw a SECOND exercise from, in order, once the count exceeds
 *  the 7 base categories (75 -> +1 from calf-foot, 90 -> + single-leg too). */
const SECOND_PICK_ORDER: RunningStrengthCategory[] = ['calf-foot', 'single-leg'];

/** Rotate a category's variant by week. Base phase pushes high-soreness moves
 *  to the back first so early-block sessions aren't the sorest. */
function pickVariant(category: RunningStrengthCategory, slotIndex: number, offset: number, phase?: TrainingPhase): RunningPoolExercise {
  let pool = RUNNING_POOL[category];
  if (phase === 'base') {
    pool = [...pool.filter(e => !e.highSoreness), ...pool.filter(e => e.highSoreness)];
  }
  return pool[(slotIndex + offset) % pool.length];
}

const INTENSITY_RPE: Record<GymIntensity, number> = { easier: 6, standard: 7, harder: 8 };

function intensityLoadStep(intensity: GymIntensity): number {
  return intensity === 'easier' ? -GYM_INTENSITY_PCT_STEP : intensity === 'harder' ? GYM_INTENSITY_PCT_STEP : 0;
}

/** Compose one prescription line via the shared composer (parser-safe + marker-
 *  correct), applying the intensity load shift to loaded exercises. */
function lineFor(ex: RunningPoolExercise, restStyle: GymRestStyle, loadStep: number): string {
  const loadPct = ex.loadPct != null ? Math.min(90, Math.max(40, ex.loadPct + loadStep)) : undefined;
  const scheme: GymGoalScheme = {
    sets: ex.sets,
    reps: ex.reps,
    loadPct: loadPct ?? 0,
    restSec: ex.restSec,
    restCircuitSec: Math.max(20, Math.round(ex.restSec * 0.6)),
  };
  const poolEx: PoolExercise = loadPct != null
    ? { name: ex.name, region: 'lower', loadable: true, cue: ex.cue }
    : { name: ex.name, region: 'core', loadable: false, cue: ex.cue, fixedSets: ex.sets, fixedReps: ex.reps, fixedRestSec: ex.restSec };
  return composeExerciseLine(poolEx, scheme, restStyle);
}

/**
 * Build a rotating, balanced running-strength session. `slotIndex` (the week)
 * drives variant rotation so sessions vary week to week; `targetMin` scales the
 * number of categories; `intensity` shifts loaded %s + RPE; `phase` reorders
 * high-soreness moves in base. Owns its own sizing (do NOT run tuneGymWorkout).
 */
export function buildRunningStrengthWorkout(
  slotIndex: number,
  targetMin: number,
  intensity: GymIntensity,
  restStyle: GymRestStyle,
  phase?: TrainingPhase,
): Workout {
  const count = exerciseCountForTime(targetMin);
  const loadStep = intensityLoadStep(intensity);

  const chosen: RunningPoolExercise[] = [];
  // First pass: one per category in priority order, up to count.
  CATEGORY_ORDER.forEach((cat, i) => {
    if (chosen.length < Math.min(count, CATEGORY_ORDER.length)) {
      chosen.push(pickVariant(cat, slotIndex, i, phase));
    }
  });
  // Second pass: extra variants for longer sessions (different from the first).
  let extra = 0;
  while (chosen.length < count) {
    const cat = SECOND_PICK_ORDER[extra % SECOND_PICK_ORDER.length];
    const offset = CATEGORY_ORDER.indexOf(cat) + 1 + Math.floor(extra / SECOND_PICK_ORDER.length);
    chosen.push(pickVariant(cat, slotIndex, offset, phase));
    extra++;
  }

  const lines = chosen.map(ex => lineFor(ex, restStyle, loadStep));
  lines.push('Stretch to finish: 3-5 min full body');

  const rpe = INTENSITY_RPE[intensity];
  const name = restStyle === 'circuit' ? 'Running Strength (circuit)' : 'Running Strength';
  return { t: 'gym', n: name, d: lines.join('\n'), r: rpe, rpe, estimatedDurationMin: targetMin } as Workout;
}

/** Exposed for tests: the category of a given exercise name (or null). */
export function categoryOf(name: string): RunningStrengthCategory | null {
  for (const cat of CATEGORY_ORDER) {
    if (RUNNING_POOL[cat].some(e => e.name === name)) return cat;
  }
  return null;
}
