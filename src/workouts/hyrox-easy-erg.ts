/**
 * Easy erg work in a HYROX plan: the session type and its predicate, with no
 * other imports, so tracking and UI modules can tell an easy erg slot apart
 * without pulling in the generators (hyrox-generators.ts builds the session).
 */
import type { Workout } from '@/types/state';

/** Session type of easy erg work (generateHyroxEasyErg). */
export const HYROX_EASY_ERG_TYPE = 'hyrox_erg_easy';

/**
 * True for an easy erg session. It carries its own discipline, 'erg'
 * (decision D, Tristan 2026-10-13; before, 'station'), so no surface that
 * counts station sessions by discipline counts it: not HYROX-specific work
 * for the plan's rules, not a hard session, no eccentric load, its own bucket
 * in the MTL split (mtl.ts), and a gym or HIIT activity never fills its slot;
 * a synced erg row does (isErgActivityType, matching.ts). The SkiErg and the
 * row erg are HYROX stations, so the injury gates scale it with the station
 * capacity and a holiday pauses it with the stations (illness-rules
 * classifyWorkoutKind). The HYROX cards show it as a time-defined
 * cross-training session (Mark as Done, Adjust, Skip); Mark as Done records
 * it as rowing (plannedSessionRecordSport), or claims an unmatched erg row of
 * its day. The type check (not the discipline) keeps plans stored with the
 * old 'station' value correct.
 */
export function isHyroxEasyErg(w: { t?: string | null }): boolean {
  return w.t === HYROX_EASY_ERG_TYPE;
}
