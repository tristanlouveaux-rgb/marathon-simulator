/**
 * Timing-suggestion mod reasons (leaf module, no imports).
 *
 * Two kinds of timing mod live in wk.workoutMods:
 *   - a pending suggestion ('Timing: ...'): labels the card with a suggestion and an
 *     Apply button, but leaves the session unchanged (the resolver copies only its
 *     modReason);
 *   - an accepted suggestion ('Timing accepted: ...'): a real plan change that the
 *     resolver applies like any other mod.
 *
 * Kept separate from timing-check.ts so the week resolver (week-resolve.ts) can read
 * these predicates while timing-check.ts reads the resolver, with no import cycle.
 */

export const TIMING_MOD_PREFIX = 'Timing:';
export const TIMING_ACCEPTED_PREFIX = 'Timing accepted:';

/** A pending timing suggestion. Every render and write path treats it as a label only. */
export function isTimingMod(modReason: string | undefined): boolean {
  return (modReason ?? '').startsWith(TIMING_MOD_PREFIX);
}

/** An accepted timing suggestion. mergeTimingMods never suggests again on a session
 *  carrying one, so an accepted suggestion does not come back on the next sync. */
export function isTimingAcceptedMod(modReason: string | undefined): boolean {
  return (modReason ?? '').startsWith(TIMING_ACCEPTED_PREFIX);
}
