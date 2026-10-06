/**
 * Notify-once guards for the tri / cycling suggestion modal
 * (CLAUDE.md "Adaptation transparency: notify-once architecture").
 *
 * The aggregator runs on every launch (main.ts), after every logged activity
 * (activity-review.ts, events.ts) and on Home / Plan renders. Without a memory of
 * what the user already answered, the same proposal pops on every launch, and an
 * accepted change can be proposed again on the session it already changed.
 * Two guards:
 *  - isOpenForTriSuggestion: a session already changed (by a suggestion or the
 *    Adjust overlay), done or dropped is not a target for a new proposal.
 *  - wk.triSuggestionsHandled: the proposals the user answered this week, read
 *    back by the aggregator so it does not propose them again until the week
 *    rolls over.
 *
 * **Side of the line**: planning. No constants.
 */

import type { SimulatorState, Workout, Week } from '@/types/state';

/**
 * True when a suggestion may still change this session. False when it is done
 * ('completed'), dropped ('skipped'), or already changed: 'reduced' is set by an
 * accepted downgrade, swap or trim (tri-suggestion-apply.ts) and by the Adjust
 * overlay; 'replaced' by the AI coach swap. Proposing a change on a session that
 * already took one steps it down again on every launch (bike threshold, then
 * sweet spot, then tempo, then endurance).
 */
export function isOpenForTriSuggestion(w: Pick<Workout, 'status'>): boolean {
  const status = w.status as string | undefined;
  return status !== 'completed' && status !== 'skipped' && status !== 'reduced' && status !== 'replaced';
}

/** The week the user is in. s.w is 1-based (store.ts default w: 1). */
function currentWeek(state: SimulatorState): Week | undefined {
  return (state.wks ?? [])[(state.w ?? 1) - 1];
}

/** Proposal ids the user already answered in the current week. */
export function handledTriSuggestionIds(state: SimulatorState): Set<string> {
  return new Set(currentWeek(state)?.triSuggestionsHandled?.modIds ?? []);
}

/**
 * Record that the user answered these proposals in the current week (accepted,
 * left unticked or dismissed). Mutates state; caller saves.
 */
export function markTriSuggestionsHandled(state: SimulatorState, answered: { modIds?: string[] }): void {
  const wk = currentWeek(state);
  if (!wk) return;
  const handled = wk.triSuggestionsHandled ?? (wk.triSuggestionsHandled = {});
  if (answered.modIds?.length) {
    const ids = new Set(handled.modIds ?? []);
    for (const id of answered.modIds) ids.add(id);
    handled.modIds = [...ids];
  }
}
