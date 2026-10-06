/**
 * Canonical "is this the long run?" check for running workouts.
 *
 * The plan engine's long-run slot renders in more than one format: the steady
 * long run is `t: 'long'`, but the fast-finish variant is `t: 'progressive'`
 * ("Long Run (Fast Finish)", intent_to_workout.ts) because it is parsed, priced
 * and paced as a progressive run. Keying long-run logic on `t === 'long'` alone
 * dropped the fast-finish run out of every long-run rule: the scheduler put it
 * on Tuesday with Sunday empty, and the timing check, cross-training suggester,
 * injury bans and skip warning all treated it as an ordinary quality session.
 *
 * The generator stamps `longRun: true` on whichever workout fills the long-run
 * slot (every variant). This helper is the single read side of that stamp.
 *
 * A workout counts as the long run while it is still in one of the long-run
 * slot's generated formats (`'long'` or `'progressive'`). Once a mod rewrites
 * the type to something else (a downgrade to 'recovery' pace), it stops being
 * the long run. That is exactly how a plain `t: 'long'` workout already behaves,
 * so the fast-finish run and the steady run follow one rule. A cut long run, and
 * a fast-finish run stepped down to an easy long run, are written as 'long'
 * (constants/intensity-ladder.ts), so they stay the long run.
 *
 * Planning side: this decides how sessions are placed and protected. It does
 * not change any load, pace or prediction number.
 */

/** Types the long-run slot is generated as (intentToWorkout's 'long' case). */
const LONG_RUN_SLOT_TYPES = new Set(['long', 'progressive']);

export interface LongRunCandidate {
  t?: string;
  longRun?: boolean;
}

export function isLongRun(w: LongRunCandidate | null | undefined): boolean {
  if (!w) return false;
  if (w.t === 'long') return true;
  return w.longRun === true && LONG_RUN_SLOT_TYPES.has(w.t ?? '');
}
