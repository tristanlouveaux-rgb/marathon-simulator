/**
 * Race-day placement rules for running race plans (planning side).
 *
 * The scheduler places a week the same way whatever weekday the race is on
 * (long run Sunday, quality Tuesday/Thursday). These rules make the last 13
 * days fit the actual race day (M4 design v4, 4.7; approved default Q8: every
 * running race plan, not only sharpening blocks):
 *   1. Nothing on or after race day: every session of any kind dated on or
 *      after race day is dropped (runs, commutes, gym, cross-training).
 *   2. The race-week primer (SCIENCE_LOG §CE: 3 to 5 days out) stays on its day
 *      when that is 3 to 5 days out; otherwise it moves to the latest race-week
 *      day at least 3 days out (swapping with the session there); with no such
 *      day on or after the first schedulable day, it is dropped.
 *   3. No long run in the 6 days before race day: it moves to the latest day of
 *      its week at least 7 days out; the session on that day takes its old day.
 *      With no such day it is dropped (it would be a long run inside race week).
 *   4. No quality session other than the primer in the last 6 days, and no two
 *      hard sessions (long run or quality) on consecutive days in the last 13
 *      days (checked within the week). A quality session that breaks either
 *      moves to the nearest earlier free day that satisfies both; with none it
 *      steps down the pace ladder (stepDownRunType, Tristan 2026-10-05) until it
 *      is no longer a hard session, keeping its duration. Every hard type sits
 *      above the easy rung, so the result is an easy run.
 *   5. Makeups never put a long run or a quality session in a taper week
 *      (events.ts skip push and rollover carry; the generator filters stale
 *      ones, filterTaperMakeups).
 *
 * Pure: the generator (generateWeekWorkouts) and the week-debrief preview call
 * the same function, so the preview lists exactly the sessions the week gets.
 */

import type { Workout } from '@/types';
import { DAY_NAMES } from '@/utils';
import { isLongRun } from './long-run';
import { stepDownRunType } from '@/constants/intensity-ladder';
import type { RaceWeekLayout } from './race-week-layout';

/** Quality run types (the scheduler's quality pool plus float). */
const QUALITY_TYPES = new Set(['threshold', 'vo2', 'race_pace', 'marathon_pace', 'intervals', 'mixed', 'progressive', 'float']);
const NON_RUN_TYPES = new Set(['cross', 'cross_training', 'strength', 'rest', 'gym', 'capacity_test', 'test_run']);

/** Days before race day with no long run and no quality session except the primer. */
export const RACE_DAY_CLEAR_DAYS = 6;
/** Window before race day in which two hard days may not be back to back. */
export const RACE_DAY_HARD_SPACING_DAYS = 13;
/** Earliest and latest primer day, days before race day (SCIENCE_LOG §CE). */
export const PRIMER_MIN_DAYS_OUT = 3;
export const PRIMER_MAX_DAYS_OUT = 5;

export function isQualityRun(w: Pick<Workout, 't' | 'longRun'>): boolean {
  return !isLongRun(w) && QUALITY_TYPES.has(w.t);
}
function isRun(w: Pick<Workout, 't'>): boolean {
  return !NON_RUN_TYPES.has(w.t);
}
function isHard(w: Pick<Workout, 't' | 'longRun'>): boolean {
  return isLongRun(w) || isQualityRun(w);
}

export interface RaceDayRulesInput {
  /** Plan week being generated (1-based). */
  weekIndex: number;
  layout: RaceWeekLayout;
  /** First schedulable weekday of this week (0 = Monday): the onboarding day in
   *  the week that holds it, 0 otherwise (workout-status firstTrackedDow). */
  firstScheduleDow?: number;
  /** Converts a stepped-down session to an easy run of the same duration. */
  toEasy?: (w: Workout) => Workout;
}

/** The weeks the rules can touch: the race week, the week before and a closing week. */
export function raceDayRulesApply(weekIndex: number, layout: RaceWeekLayout): boolean {
  const weekStart = (weekIndex - 1) * 7;
  return weekStart + 6 >= layout.raceDayIndex - RACE_DAY_HARD_SPACING_DAYS && weekStart <= layout.raceDayIndex;
}

function setDay(w: Workout, dow: number): void {
  w.dayOfWeek = dow;
  w.dayName = DAY_NAMES[dow];
}

/**
 * Apply rules 1 to 4 to one scheduled week (`dayOfWeek` set, 0 = Monday).
 * Returns a new array; the input is not mutated. Weeks outside the last 13
 * days before race day come back unchanged.
 */
export function applyRaceDayRules(workouts: Workout[], inp: RaceDayRulesInput): Workout[] {
  const { weekIndex, layout } = inp;
  if (!raceDayRulesApply(weekIndex, layout)) return workouts;
  const weekStart = (weekIndex - 1) * 7;
  const R = layout.raceDayIndex;
  // 7 = no schedulable day this week (a week before the plan existed).
  const firstDow = Math.max(0, Math.min(7, inp.firstScheduleDow ?? 0));
  const daysOut = (dow: number) => R - (weekStart + dow);
  const raceWeek = weekIndex === layout.trainingWeeks;

  // Rule 1: nothing on or after race day.
  let out = workouts
    .map(w => ({ ...w }))
    .filter(w => w.dayOfWeek == null || daysOut(w.dayOfWeek) > 0);

  const runsOn = (dow: number, except?: Workout) =>
    out.filter(w => w !== except && isRun(w) && w.dayOfWeek === dow);
  const hardOn = (dow: number, except?: Workout) => runsOn(dow, except).some(isHard);

  // Rule 2: the primer (the race week's one quality session; makeups are kept
  // out of taper weeks by rule 5, so nothing else in race week is quality).
  if (raceWeek) {
    const primer = out.find(w => isQualityRun(w) && !w.skipped);
    if (primer && primer.dayOfWeek != null) {
      const d = daysOut(primer.dayOfWeek);
      if (d < PRIMER_MIN_DAYS_OUT || d > PRIMER_MAX_DAYS_OUT) {
        let target: number | null = null;
        for (let dow = 6; dow >= firstDow; dow--) {
          if (daysOut(dow) >= PRIMER_MIN_DAYS_OUT && !hardOn(dow, primer)) { target = dow; break; }
        }
        if (target == null) {
          out = out.filter(w => w !== primer);
        } else {
          const from = primer.dayOfWeek;
          for (const other of runsOn(target, primer)) {
            if (daysOut(from) > 0) setDay(other, from); else out = out.filter(w => w !== other);
          }
          setDay(primer, target);
        }
      }
    }
  }

  // Rule 3: no long run in the last 6 days.
  for (const long of out.filter(w => isLongRun(w) && w.dayOfWeek != null)) {
    if (daysOut(long.dayOfWeek!) > RACE_DAY_CLEAR_DAYS) continue;
    let target: number | null = null;
    for (let dow = 6; dow >= firstDow; dow--) {
      if (daysOut(dow) > RACE_DAY_CLEAR_DAYS) { target = dow; break; }
    }
    if (target == null) { out = out.filter(w => w !== long); continue; }
    const from = long.dayOfWeek!;
    for (const other of runsOn(target, long)) setDay(other, from);
    setDay(long, target);
  }

  // Rule 4: quality sessions (not the race-week primer) out of the last 6 days;
  // no back-to-back hard days in the last 13.
  const primerRef = raceWeek ? out.find(w => isQualityRun(w) && !w.skipped) : undefined;
  const breaks = (w: Workout, dow: number): boolean => {
    const d = daysOut(dow);
    if (d > RACE_DAY_HARD_SPACING_DAYS) return false;
    if (w !== primerRef && d <= RACE_DAY_CLEAR_DAYS) return true;
    return hardOn(dow - 1, w) || hardOn(dow + 1, w);
  };
  for (const q of out.filter(w => isQualityRun(w) && w.dayOfWeek != null)) {
    if (!breaks(q, q.dayOfWeek!)) continue;
    let target: number | null = null;
    for (let dow = q.dayOfWeek! - 1; dow >= firstDow; dow--) {
      if (runsOn(dow, q).length === 0 && !breaks(q, dow)) { target = dow; break; }
    }
    if (target != null) { setDay(q, target); continue; }
    // No day: step down the pace ladder until it is not a hard session.
    let t = q.t;
    for (let i = 0; i < 4 && QUALITY_TYPES.has(t); i++) t = stepDownRunType(t, 1);
    if (t !== q.t) {
      const eased = inp.toEasy ? inp.toEasy(q) : { ...q, t: 'easy' };
      out = out.map(w => (w === q ? { ...eased, id: q.id, dayOfWeek: q.dayOfWeek, dayName: q.dayName } : w));
    }
  }
  return out;
}

/**
 * Rule 5 backstop: makeups (skipped sessions carried from the week before)
 * never put a long run or a quality session into a taper week. events.ts drops
 * them at skip time with the base penalty; this filters any pushed before that
 * rule existed. A makeup easy run is kept.
 */
export function filterTaperMakeups<T extends { workout: Pick<Workout, 't' | 'longRun'> }>(skips: T[]): T[] {
  return skips.filter(sk => !isHard(sk.workout));
}
