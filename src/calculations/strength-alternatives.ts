/**
 * Same-pattern exercise alternatives for the pre-session swap feature.
 *
 * A user who lacks a piece of equipment (no trap bar, no leg-press) should be
 * able to swap a prescribed movement for one that trains the SAME pattern, so
 * the session's intended stimulus is preserved. Nothing here is invented: the
 * candidate set for any movement is the other variants in its RUNNING_POOL
 * category (the app's existing functional grouping — the generator already
 * treats same-category variants as interchangeable picks for that slot), and
 * the within-category ordering is by shared muscle-group involvement
 * (`muscleGroupsForExercise`), so the closest matches surface first.
 *
 * Substitution replaces a movement with the substitute's OWN canonical pool
 * prescription (`composeRunningPoolLine`), not a line spliced from the original.
 * Same-category prescriptions are designed as near-equivalent doses (every
 * max-strength variant is ~3-4x5 @80%, every single-leg variant ~3x8-10
 * @40-60%), so the vetted version is the right one to hand the user. Known
 * simplification: the substitute lands at standard intensity / traditional
 * rest, so a session built at easier/harder loses that ±10% load shift on a
 * swapped line. Acceptable for an equipment swap; logged separately here.
 *
 * Pure module: no state access. State read/write lives in
 * `src/state/strength-swaps.ts`; this is the testable core.
 */

import type { Workout } from '@/types';
import {
  RUNNING_POOL,
  categoryOf,
  findRunningPoolExercise,
  composeRunningPoolLine,
  type RunningPoolExercise,
  type RunningStrengthCategory,
} from '@/workouts/running-pool';
import { cleanExerciseName } from '@/calculations/strength-exercise-key';
import { muscleGroupsForExercise } from '@/calculations/strength-muscle-groups';
import { exerciseNameFromLine, isStretchLine } from '@/guided/strength-model';

/**
 * A stable, equipment-specific identity for an exercise (a slug of its cleaned
 * display name). "I don't have a trap bar" keys off `trap-bar-deadlift` ONLY —
 * a different max-strength variant (Back Squat) keeps its own prescription. This
 * is deliberately NOT the weight-tracking liftKey (which merges Trap-Bar and
 * bare Deadlift under different slugs anyway, and is empty for bodyweight moves
 * the user may still want to swap).
 */
export function swapKeyForName(name: string): string {
  return cleanExerciseName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Ordered movement-pattern rules mapping an arbitrary exercise name to its
 * functional RUNNING_POOL category, for names the pool itself doesn't contain
 * (the gym.ts templates use a few movements not in the rotating pool, e.g.
 * Goblet Squat, Reverse Lunge, Kettlebell Deadlift). Mirrors the ordering in
 * `strength-exercise-key.ts` / `strength-muscle-groups.ts`: specific before
 * generic, hinge-accessory and unilateral patterns before the bilateral
 * squat/deadlift catch-alls. Movements with no clean functional peer (e.g. a
 * Wall Sit isometric) intentionally fall through to null so no swap is offered.
 */
const CATEGORY_RULES: Array<{ test: RegExp; cat: RunningStrengthCategory }> = [
  // Posterior-chain isolation (hinge accessories) — before the bilateral deadlift.
  { test: /nordic/i, cat: 'posterior' },
  { test: /\brdl\b|romanian/i, cat: 'posterior' },
  { test: /hip\s*thrust/i, cat: 'posterior' },
  // Hip-stability — before the generic glute-bridge -> posterior rule.
  { test: /single-?leg\s*glute\s*bridge/i, cat: 'hip-stability' },
  { test: /clamshell|lateral\s*walk|hip\s*abduction|abduction|banded/i, cat: 'hip-stability' },
  { test: /glute\s*bridge|\bbridge\b/i, cat: 'posterior' },
  // Plyometric / power.
  { test: /jump|bound|\bhop\b|pogo|depth/i, cat: 'plyo' },
  // Unilateral knee-dominant — before the bilateral squat catch-all.
  { test: /bulgarian|split\s*squat/i, cat: 'single-leg' },
  { test: /step-?up/i, cat: 'single-leg' },
  { test: /lunge/i, cat: 'single-leg' },
  { test: /single-?leg\s*squat/i, cat: 'single-leg' },
  // Bilateral heavy compounds.
  { test: /deadlift/i, cat: 'max-strength' },
  { test: /squat/i, cat: 'max-strength' },
  // Lower-leg.
  { test: /calf|soleus|heel\s*walk|tibialis/i, cat: 'calf-foot' },
  // Core / anti-rotation.
  { test: /pallof|dead\s*bug|bird\s*dog|plank|suitcase|carry/i, cat: 'core' },
];

/** The functional category for any exercise name: exact pool membership first
 *  (authoritative), then the movement-pattern rules. Null when nothing matches. */
export function categoryForExerciseName(name: string): RunningStrengthCategory | null {
  const exact = categoryOf(cleanExerciseName(name));
  if (exact) return exact;
  for (const rule of CATEGORY_RULES) {
    if (rule.test.test(name)) return rule.cat;
  }
  return null;
}

/** Shared muscle-group weight between two exercises (for ordering candidates so
 *  the closest functional match surfaces first). */
function muscleOverlap(a: string, b: string): number {
  const ga = muscleGroupsForExercise(a);
  const gb = muscleGroupsForExercise(b);
  let score = 0;
  for (const x of ga) {
    const y = gb.find(g => g.g === x.g);
    if (y) score += Math.min(x.w, y.w);
  }
  return score;
}

/**
 * Same-pattern alternatives for an exercise, ordered closest-match first. Empty
 * when the movement has no resolvable category (no swap offered). Excludes the
 * exercise itself (matched by equipment swap-key, so "Trap-Bar Deadlift" never
 * offers itself even when invoked from the pool).
 */
export function alternativesFor(name: string): RunningPoolExercise[] {
  const cat = categoryForExerciseName(name);
  if (!cat) return [];
  const selfKey = swapKeyForName(name);
  return RUNNING_POOL[cat]
    .filter(e => swapKeyForName(e.name) !== selfKey)
    .map(e => ({ e, overlap: muscleOverlap(name, e.name) }))
    .sort((a, b) => b.overlap - a.overlap)
    .map(x => x.e);
}

/** True when at least one same-pattern alternative exists (so the UI shows a
 *  swap control on the row). */
export function hasAlternatives(name: string): boolean {
  return alternativesFor(name).length > 0;
}

/** One remembered swap: the original movement (display name) and the substitute
 *  pool-exercise it now resolves to. */
export interface StrengthSwapEntry {
  /** Original movement's display name, e.g. "Trap-Bar Deadlift". */
  from: string;
  /** Substitute pool-exercise name, e.g. "Deadlift". */
  to: string;
}

/** The persisted swap map: swap-key -> { from, to }. */
export type StrengthSwapMap = Record<string, StrengthSwapEntry>;

/**
 * Apply a swap map to a strength workout, returning a new workout whose
 * description has each remembered line replaced by the substitute's canonical
 * prescription. Pure and idempotent: a HYROX session (parsed from
 * `hyroxComponents`, not `.d`), a non-strength workout, or one with no matching
 * lines is returned unchanged. A substitute that no longer resolves to a pool
 * exercise is left as the original line.
 */
export function applyStrengthSwaps(workout: Workout, swaps: StrengthSwapMap | undefined): Workout {
  if (!swaps || Object.keys(swaps).length === 0) return workout;
  if (Array.isArray((workout as any).hyroxComponents)) return workout;
  const desc = String((workout as any).d || '');
  if (!desc) return workout;

  let changed = false;
  const out = desc.split('\n').map(raw => {
    const line = raw.trim();
    if (!line || isStretchLine(line)) return raw;
    const name = exerciseNameFromLine(line);
    if (!name) return raw;
    const sub = swaps[swapKeyForName(name)];
    if (!sub) return raw;
    const subEx = findRunningPoolExercise(sub.to);
    if (!subEx) return raw;
    changed = true;
    return composeRunningPoolLine(subEx);
  });

  if (!changed) return workout;
  return { ...workout, d: out.join('\n') } as Workout;
}
