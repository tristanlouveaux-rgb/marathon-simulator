import type { SimulatorState, Workout } from '@/types/state';
import { applyIllnessMods } from '@/calculations/illness-rules';
import {
  applyHolidayModsAllDisciplines,
  applyBridgeModsAllDisciplines,
  isWeekInHoliday,
  getHolidayDaysForWeek,
} from '../holiday-modal';
import { dropPreOnboardSessions } from '../workout-status';

/**
 * Canonical resolver for a triathlon / cycling / HYROX week's workout list.
 *
 * Mirrors the running-mode `resolveWeekWorkouts` (week-resolve.ts): produces the
 * fully-resolved set of workouts for `viewWeek` with every render-time modifier
 * applied, in the same order both plan views apply them:
 *   1. stored plan (wk.triWorkouts) + adhoc / injury-substitute sessions
 *   2. illness suppression (current week only, discipline-aware v2 engine)
 *   3. holiday suppression (weeks inside the holiday window)
 *   4. comeback-bridge scaling
 *
 * All three scheduled modes (triathlon, cycling, HYROX) store their plan in
 * `wk.triWorkouts`, so this one resolver serves them all. Injury needs no
 * handling here: logging a tri/cycling/HYROX injury regenerates the stored
 * current + future weeks (injury/modal.ts), so `triWorkouts` is already
 * injury-correct by the time this runs.
 *
 * `opts.clone` (default true) deep-clones every workout before mutation so the
 * resolver is idempotent and never touches stored state — required for any
 * read-only consumer (the planned-day TSS helper) that may run several times
 * per render.
 *
 * DO NOT pass `clone: false` from any view that can trigger `saveState()`
 * (rating, drag, adjust). The mod appliers mutate in place; with `clone:false`
 * they mutate the stored `wk.triWorkouts`, and a later save then PERSISTS the
 * render-only mods (e.g. "Rest — illness") so workouts stay modified after the
 * illness/holiday ends. This was ISSUE-288 — the plan views now always clone.
 * Handlers look up stored objects by id, so clean stored objects are correct.
 */
export function resolveTriWeekWorkouts(
  s: SimulatorState,
  viewWeek: number,
  opts?: { clone?: boolean },
): Workout[] {
  const wk = s.wks?.[viewWeek - 1];
  const raw: Workout[] = [...(wk?.triWorkouts ?? []), ...(wk?.adhocWorkouts ?? [])];
  const workouts = (opts?.clone ?? true) ? raw.map(w => structuredClone(w)) : raw;

  const isCurrentWeek = viewWeek === s.w;
  const illness = (s as any).illnessState;
  if (illness?.active && isCurrentWeek) {
    // v2 engine: schedule + classification aware, rests strength for below-neck.
    applyIllnessMods(workouts, illness);
  }

  const holiday = s.holidayState;
  const todayIso = new Date().toISOString().split('T')[0];
  if (holiday?.active && todayIso >= holiday.startDate && todayIso <= holiday.endDate
      && s.planStartDate && isWeekInHoliday(viewWeek, s.planStartDate, holiday)) {
    const holidayDays = getHolidayDaysForWeek(viewWeek, s.planStartDate, holiday);
    applyHolidayModsAllDisciplines(workouts, holiday.canRun, holidayDays, holiday.canSwim);
  }

  // Post-holiday comeback ramp. No-ops unless buildBridgeWeekMods set a scale on this week.
  if (wk) applyBridgeModsAllDisciplines(workouts, wk);

  // Reduced partial first week (mid-week onboard): drop pre-onboard-day sessions
  // so week 1 starts today. No-op for established plans and Sat/Sun onboards.
  // Mirrors running's resolveWeekWorkouts (week-resolve.ts).
  return dropPreOnboardSessions(workouts, s.planStartDate, viewWeek, s.w, s.planCreatedAt);
}

/**
 * Estimate a tri / cycling / HYROX workout's duration in minutes.
 * Single shared copy of the helper both plan views previously duplicated.
 * Order: explicit estimatedDurationMin → brick segment sum → "Xh Ymin" in the
 * description → max "Nmin" in the description → 60 fallback.
 */
export function estimateTriWorkoutMin(w: any): number {
  if (typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0) {
    return w.estimatedDurationMin;
  }
  if (w.brickSegments) {
    return (w.brickSegments[0]?.durationMin ?? 0) + (w.brickSegments[1]?.durationMin ?? 0);
  }
  const hm = String(w.d || '').match(/(\d+)\s*h\s*(\d+)\s*min/i);
  if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  const matches = Array.from(String(w.d || '').matchAll(/(\d+)\s*min/g)) as RegExpMatchArray[];
  if (!matches.length) return 60;
  return matches.reduce((acc: number, m: RegExpMatchArray) => Math.max(acc, parseInt(m[1], 10)), 0);
}
