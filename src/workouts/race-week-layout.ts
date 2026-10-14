import { addCalendarDays, calendarDayNumber, localDateKey, localMondayKey } from '@/utils/local-date';
import { computeRunningPlanPhases } from './phases';
import type { RaceDistance } from '@/types';
import type { TriathlonDistance } from '@/types/triathlon';
import { computeTriPlanPhases, triRaceTaperWeeks } from '@/constants/triathlon-constants';

/**
 * Where race day falls in a plan's calendar weeks (Monday to Sunday, week 1 =
 * the week starting `planStartISO`).
 *
 * Planning side. Race week is the calendar week holding the day 3 days before
 * race day, so the race-week primer (SCIENCE_LOG §CE, 3 to 5 days out) always
 * falls in race week:
 *   - Thursday to Sunday race: race week is the race's own week.
 *   - Monday to Wednesday race: race week is the week before, and the race's
 *     own week is a closing week that holds only the race.
 *   - Fallback: when the day 3 days out falls before the plan starts
 *     (onboarding on the Monday of a Tuesday or Wednesday race, or a race that
 *     close in the plan's first days), the race's own week is race week and
 *     there is no closing week.
 *
 * `calendarWeeks` = weeks from plan start through race day (s.tw for a race
 * plan, the closing week included). `trainingWeeks` = weeks through race week
 * (the closing week excluded): the plan's training horizon, what the plan
 * engine, the phases and every weeks-to-race forecast input read.
 */
export interface RaceWeekLayout {
  calendarWeeks: number;
  trainingWeeks: number;
  closingWeek: boolean;
  /** Race day of week, 0 = Monday ... 6 = Sunday. */
  raceDayOfWeek: number;
  /** Calendar days from plan start (day 0 = week 1 Monday) to race day. */
  raceDayIndex: number;
}

/** Days before race day that must fall in race week (the primer's earliest day). */
export const RACE_WEEK_ANCHOR_DAYS = 3;

export function raceWeekLayout(planStartISO: string, raceDateISO: string): RaceWeekLayout | null {
  const start = calendarDayNumber(planStartISO);
  const race = calendarDayNumber(raceDateISO);
  if (!Number.isFinite(start) || !Number.isFinite(race)) return null;
  const days = race - start;
  if (days < 0) return null;
  const weekOf = (d: number) => Math.floor(d / 7) + 1;
  const calendarWeeks = weekOf(days);
  const anchor = days - RACE_WEEK_ANCHOR_DAYS;
  const trainingWeeks = anchor >= 0 ? weekOf(anchor) : calendarWeeks;
  return {
    calendarWeeks,
    trainingWeeks,
    closingWeek: trainingWeeks < calendarWeeks,
    raceDayOfWeek: ((days % 7) + 7) % 7,
    raceDayIndex: days,
  };
}

/**
 * Plan length in calendar weeks for a race plan built on `now`: weeks from the
 * local Monday of `now` (the plan's planStartDate) through the week holding
 * race day (raceWeekLayout calendarWeeks). The length (s.tw) of every
 * stored-plan mode with a race date (triathlon, cycling, HYROX), the closing
 * week included, as for running (initializeSimulator). The generators read
 * the race week and the closing week from the same layout
 * (storedPlanRaceLayout). A weeks-until count from today (calculateWeeksUntil)
 * ends a week early whenever the race weekday is on or before today's
 * weekday. Null without a race date on or after that Monday.
 */
export function racePlanCalendarWeeks(raceDateISO: string | null | undefined, now: Date = new Date()): number | null {
  if (!raceDateISO) return null;
  return raceWeekLayout(localMondayKey(now), raceDateISO.slice(0, 10))?.calendarWeeks ?? null;
}

/**
 * Race-week layout of a stored-plan race (triathlon, cycling on the tri
 * engine, HYROX): the running layout (raceWeekLayout) from the plan start and
 * the race date, so these modes place race week and the closing week exactly
 * as running does. Race week is the week holding the day 3 days before race
 * day; a Monday to Wednesday race's own week is a closing week that holds only
 * the race. The generators phase and size the plan over `trainingWeeks` and
 * emit the closing week empty (raceClosing). Null without a plan start or race
 * date, or when the layout does not match the plan's calendar length `tw` (a
 * plan whose length came from a weeks-until count): the generators then keep
 * the final week as race week.
 */
export function storedPlanRaceLayout(
  tw: number | null | undefined, planStartISO: string | null | undefined, raceISO: string | null | undefined,
): RaceWeekLayout | null {
  if (!tw || !planStartISO || !raceISO) return null;
  const layout = raceWeekLayout(planStartISO.slice(0, 10), raceISO.slice(0, 10));
  if (!layout || layout.calendarWeeks !== tw) return null;
  return layout;
}

/**
 * The date a stored-plan race forecast (triathlon, cycling, HYROX) measures
 * its weeks-to-race horizon to. Tracking side. With a closing week (a Monday
 * to Wednesday race's own week, which holds only the race), the horizon ends
 * with race week: the Sunday before race day. Otherwise race day itself.
 * Mirrors running, whose forecast horizon reads planTrainingWeeks, so a
 * Tuesday race forecasts exactly like the Sunday before it: the closing-week
 * days before the race are not credited as training. Any time part of
 * `raceISO` is kept, so the horizon parses as the predictors parse a race
 * date. The plan's own weeks decide (wks[tw - 1].raceClosing); before they
 * exist, the layout the generators use (storedPlanRaceLayout) does.
 */
export function raceForecastHorizonISO(
  s: { tw?: number; planStartDate?: string; wks?: ReadonlyArray<{ raceClosing?: boolean } | null | undefined> },
  raceISO: string,
): string {
  const day = raceISO.slice(0, 10);
  const n = calendarDayNumber(day);
  if (!Number.isFinite(n)) return raceISO;
  const tw = s.tw ?? s.wks?.length ?? 0;
  const closing = (s.wks?.length ?? 0) >= tw && tw > 0
    ? planTrainingWeeks(s) < tw
    : !!storedPlanRaceLayout(tw, s.planStartDate, day)?.closingWeek;
  const dow = (((n + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday: 0 = Monday
  // Only a Monday to Wednesday race has a closing week (raceWeekLayout); a
  // flag left on another weekday's plan by a stale date keeps race day.
  if (!closing || dow >= RACE_WEEK_ANCHOR_DAYS) return raceISO;
  return addCalendarDays(day, -(dow + 1)) + raceISO.slice(10);
}

/** The running race date (YYYY-MM-DD) of a running race plan, or null: the
 *  selected event, else the custom date (the pair every running race reader
 *  uses, run-race-outcome.ts). Null for continuous, Just-Track, triathlon
 *  (cycling included) and HYROX plans. */
export function runningRaceDateISO(s: {
  continuousMode?: boolean; trackOnly?: boolean; eventType?: string;
  selectedMarathon?: { date?: string } | null; onboarding?: { customRaceDate?: string | null } | null;
}): string | null {
  if (s.continuousMode || s.trackOnly) return null;
  if (s.eventType === 'triathlon' || s.eventType === 'hyrox') return null;
  const d = s.selectedMarathon?.date || s.onboarding?.customRaceDate;
  if (!d || !Number.isFinite(calendarDayNumber(d.slice(0, 10)))) return null;
  return d.slice(0, 10);
}

/**
 * Training weeks of a plan: s.tw without a closing week (running, triathlon,
 * cycling and HYROX race plans). The closing week (a
 * Monday to Wednesday race's own week) holds only the race, so every input
 * that reads "weeks of training" or "weeks to race" (plan engine, phases,
 * forecast horizon and taper, race-day durability window) reads this, and a
 * Tuesday race forecasts exactly like the Sunday before it. The triathlon,
 * cycling and HYROX forecasts measure their horizon in calendar time, to the
 * end of race week (raceForecastHorizonISO), for the same parity. Calendar consumers
 * (week navigation, "Week N of M", Plan complete, week advance) keep s.tw.
 */
export function planTrainingWeeks(s: { tw?: number; wks?: ReadonlyArray<{ raceClosing?: boolean } | null | undefined> }): number {
  const tw = s.tw ?? s.wks?.length ?? 0;
  return tw > 0 && s.wks?.[tw - 1]?.raceClosing ? tw - 1 : tw;
}

/**
 * Whether a plan's completion screen ("Plan complete", "View plan summary",
 * "Start a new plan") may show. A running race plan completes only once race
 * day is behind the local calendar (today after race day): the final week of
 * a race plan holds the race, so on race eve, or on race day itself, the final
 * week is reviewed, not closed. Plans without a running race date (continuous,
 * Just-Track, triathlon including cycling, HYROX, no date stored) are not tied
 * to a race day and keep the existing final-week rule.
 */
export function planCompletionDue(
  s: Parameters<typeof runningRaceDateISO>[0],
  todayKey: string = localDateKey(new Date()),
): boolean {
  const race = runningRaceDateISO(s);
  if (!race) return true;
  const today = calendarDayNumber(todayKey);
  if (!Number.isFinite(today)) return false;
  return today > calendarDayNumber(race);
}

/** True when plan week `weekIndex` is the closing week (it holds only the race). */
export function isClosingWeek(s: { wks?: ReadonlyArray<{ raceClosing?: boolean } | null | undefined> }, weekIndex: number): boolean {
  return !!s.wks?.[weekIndex - 1]?.raceClosing;
}

/**
 * The race-week layout of a built running race plan, from its plan start and
 * race date. Null when there is no race date, or when the layout does not
 * match the plan's calendar length (a plan built before the layout existed,
 * whose length came from a week count rather than calendar weeks): the
 * race-day placement rules then stay off rather than misplace race day.
 */
export function planRaceLayout(s: {
  tw?: number; planStartDate?: string; continuousMode?: boolean; trackOnly?: boolean; eventType?: string;
  selectedMarathon?: { date?: string } | null; onboarding?: { customRaceDate?: string | null } | null;
  wks?: ReadonlyArray<{ raceClosing?: boolean } | null | undefined>;
}): RaceWeekLayout | null {
  const race = runningRaceDateISO(s);
  if (!race || !s.planStartDate) return null;
  const layout = raceWeekLayout(s.planStartDate.slice(0, 10), race);
  if (!layout) return null;
  const tw = s.tw ?? s.wks?.length ?? 0;
  if (layout.calendarWeeks !== tw) return null;
  if (layout.trainingWeeks !== planTrainingWeeks(s)) return null;
  return layout;
}

/**
 * Race-taper weeks of a running race plan, for the forecast (M4 design v4,
 * 7.1): the trailing 'taper' weeks of the plan's training weeks (a closing
 * week excluded), or, before the plan's weeks exist, the split initializeWeeks
 * builds (computeRunningPlanPhases). Every forecast taper input reads this so
 * the forecast's taper is the plan's. Undefined for continuous, Just-Track,
 * triathlon and HYROX plans and without a race distance: callers keep the
 * TAPER_NOMINAL default.
 */
export function planTaperWeeks(s: {
  tw?: number; rd?: RaceDistance | null; continuousMode?: boolean; trackOnly?: boolean; eventType?: string;
  wks?: ReadonlyArray<{ ph?: string; raceClosing?: boolean } | null | undefined>;
}): number | undefined {
  if (s.continuousMode || s.trackOnly || s.eventType === 'triathlon' || s.eventType === 'hyrox' || !s.rd) return undefined;
  const training = planTrainingWeeks(s);
  if (!(training > 0)) return undefined;
  let taper = 0;
  const wks = s.wks ?? [];
  if (wks.length >= training) {
    for (let i = training - 1; i >= 0 && wks[i]?.ph === 'taper'; i--) taper++;
  }
  if (taper > 0) return taper;
  return computeRunningPlanPhases(training, s.rd).filter(p => p.ph === 'taper').length;
}

/**
 * Race-taper weeks of a triathlon or cycling plan, for the forecast (tracking
 * side; Tristan 2026-10-13: the forecast reads the plan's taper): the trailing
 * 'taper' weeks of the plan's training weeks (a closing week excluded), or,
 * before the plan's weeks exist, the trailing taper of the phases the plan
 * engine will build (computeTriPlanPhases: the race distance's taper, cycling
 * 2, race week only for a low-hours sprint or Olympic triathlete
 * (triRaceTaperWeeks), the short-plan rule for a
 * plan too short to hold it; `lowHours` is the plan engine's triTaperOpts for
 * the plan's training weeks, resolved only when needed). Without the weeks,
 * the training weeks come from the layout the generator uses
 * (storedPlanRaceLayout), so a Monday to Wednesday race's closing week is
 * left out as the plan leaves it out.
 * Every discipline shares it, as the plan tapers all three over the same
 * weeks. Undefined without a triathlon config.
 */
export function triPlanTaperWeeks(s: {
  tw?: number;
  planStartDate?: string;
  wks?: ReadonlyArray<{ ph?: string; raceClosing?: boolean } | null | undefined>;
  triConfig?: { distance: TriathlonDistance; disciplines?: ReadonlyArray<string>; raceDate?: string } | null;
}, lowHours?: (trainingWeeks: number) => boolean): number | undefined {
  if (!s.triConfig) return undefined;
  const wks = s.wks ?? [];
  const tw = s.tw ?? wks.length;
  const built = tw > 0 && wks.length >= tw;
  const training = built
    ? planTrainingWeeks(s)
    : (storedPlanRaceLayout(tw, s.planStartDate, s.triConfig.raceDate)?.trainingWeeks ?? planTrainingWeeks(s));
  let taper = 0;
  if (training > 0 && built) {
    for (let i = training - 1; i >= 0 && wks[i]?.ph === 'taper'; i--) taper++;
  }
  if (taper > 0) return taper;
  const d = s.triConfig.disciplines;
  const cyclingOnly = !!d && d.length === 1 && d[0] === 'bike';
  const opts = { cyclingOnly, lowHours: !cyclingOnly && !!lowHours?.(Math.max(1, training)) };
  // The plan's own phases when its length is known, so a plan too short for
  // the distance's taper keeps the short-plan taper here too.
  if (training > 0) {
    const ph = computeTriPlanPhases(s.triConfig.distance, training, opts);
    let t = 0;
    for (let i = ph.length - 1; i >= 0 && ph[i].ph === 'taper'; i--) t++;
    if (t > 0) return t;
  }
  return triRaceTaperWeeks(s.triConfig.distance, opts);
}
