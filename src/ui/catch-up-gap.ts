/**
 * Bulk catch-up gap detection.
 *
 * Kept as a dependency-free leaf module so it can be unit tested. `catch-up.ts`
 * pulls in state, the workout generator and the DOM, none of which load in the
 * node test environment.
 */

/**
 * Minimum number of weeks behind the calendar before the bulk pass replaces the
 * per-week debrief cascade. At 1 week behind the normal single debrief is not
 * repetitive, so it is left alone.
 */
export const CATCH_UP_MIN_WEEKS = 2;

/** A gap the bulk catch-up will close. */
export interface CatchUpGap {
  /** Plan pointer before the catch-up. */
  fromWeek: number;
  /** Week the athlete lands on (today's calendar week, capped at plan length). */
  toWeek: number;
  /** Weeks to advance. Always >= CATCH_UP_MIN_WEEKS. */
  weeks: number;
}

/** Inputs for {@link computeCatchUpGap}, read from state by `detectCatchUpGap`. */
export interface CatchUpGapInput {
  /** Plan pointer (s.w). */
  currentWeek: number;
  /** Training week today's date falls in, relative to planStartDate. */
  calendarWeek: number;
  /** Planned total weeks (s.tw). 0 when unset. */
  totalWeeks: number;
  /** Length of the generated week array (s.wks.length). */
  generatedWeeks: number;
  onboarded: boolean;
  /** Rehab weeks need a per-week check-in, so they cannot be batched. */
  injuryActive: boolean;
}

/**
 * Decide whether a bulk catch-up applies, and how far it should advance.
 * Returns null when the interactive one-week flow should run instead.
 */
export function computeCatchUpGap(input: CatchUpGapInput): CatchUpGap | null {
  const { currentWeek, calendarWeek, totalWeeks, generatedWeeks, onboarded, injuryActive } = input;
  if (!onboarded || injuryActive) return null;
  if (currentWeek < 1 || generatedWeeks < 1) return null;

  const maxWeek = Math.min(totalWeeks > 0 ? totalWeeks : generatedWeeks, generatedWeeks);
  const toWeek = Math.min(calendarWeek, maxWeek);
  const weeks = toWeek - currentWeek;
  if (weeks < CATCH_UP_MIN_WEEKS) return null;

  return { fromWeek: currentWeek, toWeek, weeks };
}
