/**
 * Easy erg work in a HYROX plan: the session type and its predicate, with no
 * other imports, so tracking and UI modules can tell an easy erg slot apart
 * without pulling in the generators (hyrox-generators.ts builds the session).
 */
import type { Workout } from '@/types/state';

/** Session type of easy erg work (generateHyroxEasyErg). */
export const HYROX_EASY_ERG_TYPE = 'hyrox_erg_easy';

/**
 * True for an easy erg session. It carries discipline 'station' (the SkiErg
 * and the row erg are HYROX stations: the injury gates scale it with the
 * station capacity, and the MTL split and the plan's load charts count it as
 * station load), but it is not a station session: not HYROX-specific work for
 * the plan's rules, not a hard session, no eccentric load, not counted as a
 * station session by the session counts, and a gym or HIIT activity never
 * fills its slot. The HYROX cards show it as a time-defined cross-training
 * session (Mark as Done, Adjust, Skip); Mark as Done records it as rowing
 * (plannedSessionRecordSport).
 */
export function isHyroxEasyErg(w: { t?: string | null }): boolean {
  return w.t === HYROX_EASY_ERG_TYPE;
}
