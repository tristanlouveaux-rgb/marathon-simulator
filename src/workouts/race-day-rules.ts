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
 *      ones, filterTaperMakeups). An easy makeup is carried at the taper
 *      week's easy length while the week stays under its taper ceiling
 *      (fitTaperEasyMakeups).
 *
 * Pure: the generator (generateWeekWorkouts) and the week-debrief preview call
 * the same function, so the preview lists exactly the sessions the week gets.
 */

import type { Workout } from '@/types';
import { DAY_NAMES } from '@/utils';
import { isLongRun } from './long-run';
import { stepDownRunType } from '@/constants/intensity-ladder';
import { raceWeekLayout, type RaceWeekLayout } from './race-week-layout';

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
 * Rule 5 at skip time (review major 1): a skipped long run or quality session
 * is not carried into a taper week (race week and a closing week included) of
 * a running race plan. Carried, a skipped peak-week long run landed at full
 * length in the first taper week beside that week's own long run (example A:
 * 181 + 122 = 303 min against a 263-min peak week). The caller drops it with
 * the existing base penalty, the path sessions past the carry limit take
 * (events.ts). Easy runs are still carried.
 */
export function isTaperCarryBlocked(
  s: {
    continuousMode?: boolean; trackOnly?: boolean; eventType?: string;
    wks?: ReadonlyArray<{ ph?: string; raceClosing?: boolean } | null | undefined>;
  },
  nextWeekIndex: number,
  w: Pick<Workout, 't' | 'longRun'>,
): boolean {
  if (s.continuousMode || s.trackOnly || s.eventType === 'triathlon' || s.eventType === 'hyrox') return false;
  const next = s.wks?.[nextWeekIndex - 1];
  if (!next) return false;
  return (next.ph === 'taper' || !!next.raceClosing) && isHard(w);
}

/**
 * Rule 5 backstop in the generator, for skips pushed before the skip-time rule
 * existed: a taper week carries no makeup long run or quality session, and
 * race week carries no makeup at all (its ceiling holds the primer and short
 * easy runs; nothing more fits before race day).
 */
export function filterTaperMakeups<T extends { workout: Pick<Workout, 't' | 'longRun'> }>(
  skips: T[], opts: { raceWeek?: boolean } = {},
): T[] {
  if (opts.raceWeek) return [];
  return skips.filter(sk => !isHard(sk.workout));
}

/**
 * Rule 5 for easy makeups (M4 design v4 review, major 1): in a taper week of a
 * running race plan an easy makeup is carried only at the week's taper easy
 * length (never longer than the run that was skipped), and only while the
 * week's running minutes, makeups included, stay at or under the taper ceiling
 * (f x the reference total, plan_engine taperMakeupRoom). Skipped peak-week
 * easy runs carried at full length could otherwise lift the first taper week
 * above the peak week. A run makeup that does not fit is not carried. Non-run
 * makeups (gym, cross-training) are not runs and pass unchanged. Pure.
 *   `weekRunMin`: the week's prescribed running minutes before makeups.
 *   `resize`: rebuilds an easy run at a new length (minutes).
 */
export function fitTaperEasyMakeups<T extends { workout: Workout }>(
  skips: T[],
  weekRunMin: number,
  room: { easyMin: number; ceilingMin: number },
  resize: (w: Workout, minutes: number) => Workout,
): T[] {
  let total = weekRunMin;
  const out: T[] = [];
  for (const sk of skips) {
    if (!isRun(sk.workout)) { out.push(sk); continue; }
    if (isHard(sk.workout)) continue;
    const own = sk.workout.estimatedDurationMin;
    const len = own != null && own > 0 ? Math.min(own, room.easyMin) : room.easyMin;
    if (!(len > 0) || total + len > room.ceilingMin) continue;
    total += len;
    out.push(len === own ? sk : { ...sk, workout: resize(sk.workout, len) });
  }
  return out;
}

/**
 * Rule 1 for the stored-plan modes (triathlon, cycling on the tri engine, and
 * HYROX): drop every session dated on or after race day. Their generators lay
 * race week out their own way (triathlon keeps Sunday free, scheduler
 * .triathlon) on the running layout (storedPlanRaceLayout); this only removes
 * sessions that would fall on or after the race, e.g. a Saturday race's
 * Saturday session. Weeks entirely before race day are returned unchanged.
 * Pure; `dayOfWeek` 0 = Monday.
 */
export function dropSessionsOnOrAfterRaceDay<T extends { dayOfWeek?: number }>(
  workouts: T[], weekIndex: number, planStartISO: string | undefined | null, raceISO: string | undefined | null,
): T[] {
  if (!planStartISO || !raceISO) return workouts;
  const layout = raceWeekLayout(planStartISO.slice(0, 10), raceISO.slice(0, 10));
  if (!layout) return workouts;
  const weekStart = (weekIndex - 1) * 7;
  if (weekStart + 6 < layout.raceDayIndex) return workouts;
  return workouts.filter(w => w.dayOfWeek == null || weekStart + w.dayOfWeek < layout.raceDayIndex);
}

export interface StoredPlanRaceWindowInput<T> {
  /** Plan week being generated (1-based). */
  weekIndex: number;
  layout: RaceWeekLayout;
  /** The week's long sessions (triathlon: long run, brick, solo long ride;
   *  HYROX: full brick). These move instead of being dropped. */
  isLongSession: (w: T) => boolean;
  /** HYROX: the scheduler's hard sessions, which never sit on adjacent days
   *  (scheduler.hyrox.ts). A moved long session does not land next to one.
   *  Unset for triathlon, whose brick and long run sit back to back by design. */
  isHard?: (w: T) => boolean;
  /** First schedulable weekday of this week (workout-status firstTrackedDow). */
  firstScheduleDow?: number;
  /** Day names in the engine's own format, indexed 0 = Monday. */
  dayNames: readonly string[];
  /** Called with each session the window removes (dropped there, displaced by
   *  a moved long session, or a long session with no day to move to). The
   *  triathlon generator keeps their dose for the forecast (Week.raceWindowCut).
   *  Moved sessions are not reported: they stay in the week. */
  onDrop?: (w: T) => void;
}

/**
 * Rules 3 and 4 for the stored-plan modes (triathlon, cycling on the tri
 * engine, HYROX), applied to a training week before race week. The running
 * layout puts race week in the week holding the day 3 days before race day,
 * so for a Thursday to Saturday race the last 1 to 3 days of the week before
 * race week (its weekend, where these schedulers seat the brick, long ride
 * and long run) fall inside the last RACE_DAY_CLEAR_DAYS days before race
 * day. Those days carry race-week sessions only:
 *   - a long session dated there moves to the latest day of its week at least
 *     RACE_DAY_CLEAR_DAYS + 1 days out, on or after the first schedulable day
 *     (running rule 3). The sessions on that day would take its old day, which
 *     is inside the window, so they leave the week. A later long session that
 *     the move displaces shifts one day earlier in turn, so the week's long
 *     sessions keep their order (a brick stays the day before the long run).
 *     With no such day a long session is dropped;
 *   - every other session dated there is dropped.
 * Weeks with no session inside the window, race week and the closing week
 * come back unchanged. Pure; `dayOfWeek` 0 = Monday.
 */
export function clearStoredPlanRaceWindow<T extends { dayOfWeek?: number; dayName?: string }>(
  workouts: T[], inp: StoredPlanRaceWindowInput<T>,
): T[] {
  const { weekIndex, layout, isLongSession, isHard } = inp;
  if (weekIndex >= layout.trainingWeeks) return workouts;
  const weekStart = (weekIndex - 1) * 7;
  const daysOut = (dow: number) => layout.raceDayIndex - (weekStart + dow);
  const inWindow = (dow: number | undefined) =>
    dow != null && daysOut(dow) >= 1 && daysOut(dow) <= RACE_DAY_CLEAR_DAYS;
  if (!workouts.some(w => inWindow(w.dayOfWeek))) return workouts;
  const firstDow = Math.max(0, Math.min(7, inp.firstScheduleDow ?? 0));

  const order = new Map<T, number>();
  const isPlacedLong = (w: T) => w.dayOfWeek != null && isLongSession(w);
  let out: T[] = [];
  const drop = (w: T) => inp.onDrop?.(w);
  workouts.forEach((w, i) => {
    if (isPlacedLong(w)) return;
    if (inWindow(w.dayOfWeek)) { drop(w); return; }
    const copy = { ...w };
    order.set(copy, i);
    out.push(copy);
  });

  // Latest day at least RACE_DAY_CLEAR_DAYS + 1 days out; long sessions are
  // placed from the latest down, each strictly before the one placed after it.
  let limit = 6;
  while (limit >= 0 && daysOut(limit) <= RACE_DAY_CLEAR_DAYS) limit--;
  const hardNextTo = (dow: number) => !!isHard
    && out.some(w => (w.dayOfWeek === dow - 1 || w.dayOfWeek === dow + 1) && isHard(w));
  const longs = workouts
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => isPlacedLong(w))
    .sort((a, b) => (b.w.dayOfWeek! - a.w.dayOfWeek!) || (b.i - a.i));
  for (const { w: long, i } of longs) {
    const own = long.dayOfWeek!;
    if (own <= limit) {
      const copy = { ...long };
      order.set(copy, i);
      out.push(copy);
      limit = own - 1;
      continue;
    }
    let target: number | null = null;
    for (let dow = limit; dow >= firstDow; dow--) {
      if (hardNextTo(dow)) continue;
      target = dow;
      break;
    }
    if (target == null) { drop(long); continue; }
    out = out.filter(w => {
      if (w.dayOfWeek !== target) return true;
      drop(w);
      return false;
    });
    const moved = { ...long, dayOfWeek: target, dayName: inp.dayNames[target] };
    order.set(moved, -1); // first on its day, where the scheduler seats a long session
    out.push(moved);
    limit = target - 1;
  }
  return out.sort((a, b) =>
    ((a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0)) || ((order.get(a) ?? 0) - (order.get(b) ?? 0)));
}
