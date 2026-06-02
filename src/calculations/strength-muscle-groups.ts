/**
 * Muscle-group attribution for strength/gym sessions.
 *
 * Maps each exercise in a parsed strength session to the muscle groups it
 * trains, weighted by how many sets the user performed. This is a factual
 * anatomy lookup over the FINITE exercise vocabulary the app prescribes
 * (src/workouts/gym.ts + src/workouts/injury-strength.ts) — not an invented
 * model. Primary movers carry full weight; secondary/stabiliser involvement
 * carries half. Exercises the vocabulary doesn't cover fall through to a
 * keyword match, and anything still unrecognised is skipped (never guessed
 * into a wrong group).
 *
 * The running-strength vocabulary is lower-body and core dominant by design,
 * so the canonical group set is deliberately small.
 */

import type { StrengthSession } from '@/guided/strength-model';

/** Canonical muscle groups for the app's running-strength vocabulary. */
export type MuscleGroup =
  | 'quads'
  | 'glutes'
  | 'hamstrings'
  | 'calves'
  | 'core'
  | 'back';

export const MUSCLE_GROUP_LABEL: Record<MuscleGroup, string> = {
  quads: 'Quads',
  glutes: 'Glutes',
  hamstrings: 'Hamstrings',
  calves: 'Calves',
  core: 'Core',
  back: 'Back',
};

/** One worked group with its share of total session volume (0–1). */
export interface WorkedMuscleGroup {
  group: MuscleGroup;
  label: string;
  /** Set-weighted contribution, normalised so the most-worked group = 1. */
  intensity: number;
  /** Raw set-weighted score (primary=1×sets, secondary=0.5×sets). */
  score: number;
}

const PRIMARY = 1;
const SECONDARY = 0.5;

interface ExerciseRule {
  test: RegExp;
  groups: Array<{ g: MuscleGroup; w: number }>;
}

/**
 * Ordered rules — first match wins, so more specific patterns precede generic
 * ones (e.g. "nordic" before any curl, "rdl"/"romanian" before "deadlift",
 * "jump squat" / "split squat" / "goblet squat" before bare "squat").
 *
 * Attribution rationale (running-strength biomechanics, standard movement
 * analysis): squats and lunges are knee-dominant (quads primary, glutes
 * assist); hinges (deadlift, RDL, hip thrust, bridge) are hip-dominant
 * (glutes/hamstrings primary, erectors assist); plyometrics add calf drive;
 * isometric core holds and anti-rotation drills are core primary.
 */
const RULES: ExerciseRule[] = [
  // Posterior-chain isolation
  { test: /nordic/i, groups: [{ g: 'hamstrings', w: PRIMARY }, { g: 'glutes', w: SECONDARY }] },
  { test: /\brdl\b|romanian\s*deadlift|single-?leg\s*rdl/i, groups: [{ g: 'hamstrings', w: PRIMARY }, { g: 'glutes', w: SECONDARY }, { g: 'back', w: SECONDARY }] },
  { test: /deadlift/i, groups: [{ g: 'hamstrings', w: PRIMARY }, { g: 'glutes', w: PRIMARY }, { g: 'back', w: SECONDARY }] },
  { test: /hip\s*thrust|glute\s*bridge|\bbridge\b/i, groups: [{ g: 'glutes', w: PRIMARY }, { g: 'hamstrings', w: SECONDARY }] },
  { test: /clamshell/i, groups: [{ g: 'glutes', w: PRIMARY }] },

  // Anti-rotation / isometric core
  { test: /bird\s*dog/i, groups: [{ g: 'core', w: PRIMARY }, { g: 'glutes', w: SECONDARY }] },
  { test: /pallof|dead\s*bug|side\s*plank|front\s*plank|\bplank\b|core\s*circuit/i, groups: [{ g: 'core', w: PRIMARY }] },
  { test: /wall\s*sit/i, groups: [{ g: 'quads', w: PRIMARY }, { g: 'core', w: SECONDARY }] },

  // Plyometrics / power (before bare "squat")
  { test: /bound/i, groups: [{ g: 'calves', w: PRIMARY }, { g: 'glutes', w: SECONDARY }, { g: 'quads', w: SECONDARY }] },
  { test: /box\s*jump|jump\s*squat|squat\s*jump/i, groups: [{ g: 'quads', w: PRIMARY }, { g: 'glutes', w: SECONDARY }, { g: 'calves', w: SECONDARY }] },

  // Unilateral knee-dominant (before bare "squat"/"lunge")
  { test: /bulgarian|split\s*squat/i, groups: [{ g: 'quads', w: PRIMARY }, { g: 'glutes', w: PRIMARY }] },
  { test: /step-?up/i, groups: [{ g: 'quads', w: PRIMARY }, { g: 'glutes', w: SECONDARY }] },
  { test: /lunge/i, groups: [{ g: 'quads', w: PRIMARY }, { g: 'glutes', w: PRIMARY }] },

  // Bilateral knee-dominant
  { test: /squat/i, groups: [{ g: 'quads', w: PRIMARY }, { g: 'glutes', w: SECONDARY }] },

  // Lower-leg isolation
  { test: /calf/i, groups: [{ g: 'calves', w: PRIMARY }] },
];

/** Muscle groups for one exercise name; empty when nothing recognised. */
export function muscleGroupsForExercise(name: string): Array<{ g: MuscleGroup; w: number }> {
  for (const rule of RULES) {
    if (rule.test.test(name)) return rule.groups;
  }
  return [];
}

/**
 * Aggregate the worked muscle groups across a parsed strength session.
 * Each exercise contributes its set count to every group it trains (primary
 * full, secondary half). Returns groups ordered most-worked first with a
 * normalised `intensity` for chip ordering.
 */
export function deriveWorkedMuscleGroups(session: StrengthSession): WorkedMuscleGroup[] {
  // Sets are flattened (one entry per working set), so count sets per exercise
  // by walking the flat list once and tallying per exerciseIndex.
  const setsPerExercise = new Map<number, { name: string; sets: number }>();
  for (const set of session.sets) {
    const cur = setsPerExercise.get(set.exerciseIndex);
    if (cur) cur.sets += 1;
    else setsPerExercise.set(set.exerciseIndex, { name: set.exerciseName, sets: 1 });
  }

  const scores = new Map<MuscleGroup, number>();
  for (const { name, sets } of setsPerExercise.values()) {
    for (const { g, w } of muscleGroupsForExercise(name)) {
      scores.set(g, (scores.get(g) ?? 0) + w * sets);
    }
  }

  if (scores.size === 0) return [];

  const max = Math.max(...scores.values());
  return [...scores.entries()]
    .map(([group, score]) => ({
      group,
      label: MUSCLE_GROUP_LABEL[group],
      score,
      intensity: max > 0 ? score / max : 0,
    }))
    .sort((a, b) => b.score - a.score);
}

/** Convenience: just the ordered group keys (most-worked first). */
export function workedMuscleGroupKeys(session: StrengthSession): MuscleGroup[] {
  return deriveWorkedMuscleGroups(session).map(g => g.group);
}
