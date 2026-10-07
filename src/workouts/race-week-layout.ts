import { calendarDayNumber } from '@/utils/local-date';

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
 * Training weeks of a plan: s.tw without a closing week. The closing week (a
 * Monday to Wednesday race's own week) holds only the race, so every input
 * that reads "weeks of training" or "weeks to race" (plan engine, phases,
 * forecast horizon and taper, race-day durability window) reads this, and a
 * Tuesday race forecasts exactly like the Sunday before it. Calendar consumers
 * (week navigation, "Week N of M", Plan complete, week advance) keep s.tw.
 */
export function planTrainingWeeks(s: { tw?: number; wks?: ReadonlyArray<{ raceClosing?: boolean } | null | undefined> }): number {
  const tw = s.tw ?? s.wks?.length ?? 0;
  return tw > 0 && s.wks?.[tw - 1]?.raceClosing ? tw - 1 : tw;
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
