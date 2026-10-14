/**
 * HYROX week scheduler.
 *
 * Assigns dayOfWeek (0=Mon … 6=Sun) to each generated session using
 * a constraint-based day-picker rather than a rigid template.
 *
 * Hard rules (never dropped to place a session; parameter sheet 2026-10-12,
 * schedule.hard_day_spacing and eccentric.min_gap):
 *   1. One prescribed session a day.
 *   2. No two hard sessions (isHighIntensity: quality runs, bricks except the
 *      advanced secondary brick, race-pace station sessions) on the same or
 *      consecutive days, Sunday and the next Monday included.
 *   3. At least 48 h between two sessions holding sandbag lunges, burpee broad
 *      jumps or wall balls (isEccentricSession): never on consecutive days,
 *      Sunday and the next Monday included.
 * A week with no placement that keeps both rules returns null from
 * findHyroxWeekSchedule; the plan engine then turns a hard session into its
 * easy sibling or drops the lowest-priority session and tries again.
 *
 * Preferences (soft): brick Saturday, long run Sunday, quality and race-pace
 * sessions Tuesday/Thursday, technique circuits Wednesday/Friday, easy runs
 * bookend the week, easy erg work (neither hard nor eccentric) takes a day
 * left free, placed last. Commute runs (appended on top of the plan, SCIENCE_LOG §AK)
 * are easy and are placed after the prescribed sessions, each commute day's
 * legs on one day.
 *
 * Before 2026-10-12 the spacing compared days inside one week only and its
 * fallback dropped the spacing when no day fitted; the 48 h rule was written
 * down but not enforced (a Friday circuit and a Saturday brick could both hold
 * sandbag lunges).
 */

import type { Workout } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';
import { ECCENTRIC_HEAVY_STATIONS } from '@/constants/hyrox-constants';
import { isHyroxEasyErg } from './hyrox-generators';

export const HYROX_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = HYROX_DAY_NAMES;

/** Returns true for sessions that count as "high intensity" (hard sessions):
 *  quality runs, bricks (except a `hyroxLight` brick, the advanced secondary
 *  brick) and race-pace station sessions. Also read by the race-window rule
 *  (race-day-rules clearStoredPlanRaceWindow), so a moved brick keeps this
 *  spacing. */
export function isHighIntensity(w: Workout): boolean {
  if (w.hyroxLight === true) return false;
  return w.t === 'hyrox_brick' ||
    w.t === 'hyrox_mini_brick' ||
    w.t === 'hyrox_run_intervals' ||
    w.t === 'hyrox_run_tempo' ||
    w.t === 'hyrox_station_density';
}

/** Hard runs: quality runs and hard bricks (at most HYROX_MAX_HARD_RUNS a week). */
export function isHardRun(w: Workout): boolean {
  if (!isHighIntensity(w)) return false;
  return w.t === 'hyrox_brick' || w.t === 'hyrox_mini_brick' ||
    w.t === 'hyrox_run_intervals' || w.t === 'hyrox_run_tempo';
}

/** True for a session holding an eccentric-heavy station (sandbag lunges,
 *  burpee broad jumps, wall balls; ECCENTRIC_HEAVY_STATIONS). Two such
 *  sessions need 48 h between them. */
export function isEccentricSession(w: Workout): boolean {
  return (w.hyroxComponents ?? []).some(c => (ECCENTRIC_HEAVY_STATIONS as string[]).includes(c.type as string));
}

/** The HYROX long run (plan_engine.hyrox): the week's one long easy run. */
export function isHyroxLongRun(w: Pick<Workout, 't' | 'longRun'>): boolean {
  return w.t === 'hyrox_run_easy' && w.longRun === true;
}

const TEMPO_DAYS = [1, 3, 4, 2];   // Tue/Thu

/** The tempo run's first day: race week's primer home day (race-day-rules
 *  raceWeekPrimerDow). */
export const HYROX_TEMPO_HOME_DOW = TEMPO_DAYS[0];

/**
 * Preferred day ordering per session type, from most-preferred to least.
 * The first free day in the list that satisfies spacing constraints is used.
 */
export function hyroxPreferredDays(w: Pick<Workout, 't'> & { longRun?: boolean; hyroxLight?: boolean }): number[] {
  if (w.t === 'hyrox_assessment') return [0, 1, 2];      // Assessment: Mon first (needs to be early in week)
  if (w.t === 'hyrox_brick') return [5, 3, 6, 4];       // Sat primary, Thu secondary
  if (w.t === 'hyrox_mini_brick' && w.hyroxLight) return [3, 4, 2, 1]; // secondary brick: midweek
  if (w.t === 'hyrox_mini_brick') return [4, 5, 2, 3];  // Fri primary
  if (w.t === 'hyrox_station_density') return [1, 3, 2, 4];   // Tue/Thu
  if (w.t === 'hyrox_station_technique') return [2, 4, 1, 3]; // Wed/Fri
  if (w.t === 'hyrox_run_tempo') return [...TEMPO_DAYS];
  if (w.t === 'hyrox_run_intervals') return [3, 1, 4, 2]; // Thu/Tue
  if (w.t === 'hyrox_run_easy' && w.longRun) return [6, 0, 5, 2, 4]; // long run: Sunday first
  if (isHyroxEasyErg(w)) return [2, 4, 0, 6, 5, 3, 1];  // easy erg: whatever day is left, midweek first
  // easy run: bookend
  return [0, 6, 2, 4, 5];
}

/** The previous week's Sunday, for the Sunday-to-Monday spacing. */
export interface HyroxPrevSunday { hard: boolean; eccentric: boolean }

/** Flags of the session on Sunday of a scheduled week (null: Sunday empty). */
export function hyroxSundayFlags(week: readonly Workout[]): HyroxPrevSunday | null {
  const sun = week.filter(w => w.dayOfWeek === 6 && w.commute !== true);
  if (sun.length === 0) return null;
  return { hard: sun.some(isHighIntensity), eccentric: sun.some(isEccentricSession) };
}

function priority(w: Workout): number {
  if (w.t === 'hyrox_assessment') return -1; // always scheduled first → gets Monday
  if (w.t === 'hyrox_brick') return 0;
  if (w.t === 'hyrox_mini_brick' && !w.hyroxLight) return 1;
  if (w.t === 'hyrox_run_intervals') return 2;
  if (w.t === 'hyrox_station_density') return 3;
  if (w.t === 'hyrox_run_tempo') return 4;
  if (w.t === 'hyrox_station_technique') return 5;
  if (w.t === 'hyrox_mini_brick') return 5.5; // secondary (light) brick
  if (isHyroxLongRun(w)) return 5.8;
  if (isHyroxEasyErg(w)) return 6.5; // easy erg work: placed last, on a day left free
  return 6; // easy run
}

interface Placed { w: Workout; day: number }

function conflicts(session: Workout, day: number, placed: readonly Placed[], prevSunday: HyroxPrevSunday | null | undefined): boolean {
  const hard = isHighIntensity(session);
  const ecc = isEccentricSession(session);
  if (!hard && !ecc) return false;
  if (day === 0 && prevSunday) {
    if (hard && prevSunday.hard) return true;
    if (ecc && prevSunday.eccentric) return true;
  }
  for (const p of placed) {
    if (Math.abs(p.day - day) > 1) continue;
    if (hard && isHighIntensity(p.w)) return true;
    if (ecc && isEccentricSession(p.w)) return true;
  }
  return false;
}

function candidateDays(session: Workout): number[] {
  const pref = hyroxPreferredDays(session);
  const rest = [0, 1, 2, 3, 4, 5, 6].filter(d => !pref.includes(d));
  return [...pref, ...rest];
}

function withDay(w: Workout, day: number): Workout {
  return { ...w, dayOfWeek: day, dayName: DAY_NAMES[day] };
}

/** Commute legs grouped by commute day ("Commute 2 (morning)" and "(evening)"). */
function commuteGroups(commutes: readonly Workout[]): Workout[][] {
  const groups = new Map<string, Workout[]>();
  for (const c of commutes) {
    const key = (c.n ?? '').replace(/ \((morning|evening)\)$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return [...groups.values()];
}

/** Place commute legs after the prescribed sessions: a free day first (easy-run
 *  preference order), else beside an easy run, else beside any session that is
 *  not hard. Each commute day's legs share a day. */
function placeCommutes(main: Workout[], commutes: readonly Workout[]): Workout[] {
  const used = new Set(main.map(w => w.dayOfWeek));
  const out = [...main];
  const order = [0, 6, 2, 4, 5, 1, 3];
  for (const group of commuteGroups(commutes)) {
    let day = order.find(d => !used.has(d));
    if (day == null) day = order.find(d => out.some(w => w.dayOfWeek === d && w.t === 'hyrox_run_easy' && !w.longRun));
    if (day == null) day = order.find(d => !out.some(w => w.dayOfWeek === d && isHighIntensity(w)));
    if (day == null) day = 0;
    used.add(day);
    for (const c of group) out.push(withDay(c, day));
  }
  return out;
}

/**
 * A placement of a training week that keeps every hard rule, or null when none
 * exists. Depth-first over the sessions in priority order, each trying its
 * preferred days first, so the result is the greedy placement whenever that
 * one is legal. Commute runs are placed afterwards (placeCommutes).
 */
export function findHyroxWeekSchedule(
  sessions: readonly Workout[],
  opts: { prevSunday?: HyroxPrevSunday | null } = {},
): Workout[] | null {
  const main = sessions.filter(w => w.commute !== true);
  const commutes = sessions.filter(w => w.commute === true);
  if (main.length > 7) return null;
  // Each session's priority, days and spacing flags, read once (the
  // depth-first search below reads them at every step). The sort is stable,
  // as before.
  const sorted = main
    .map(w => ({ w, p: priority(w) }))
    .sort((a, b) => a.p - b.p)
    .map(({ w }) => ({ w, days: candidateDays(w), hard: isHighIntensity(w), ecc: isEccentricSession(w) }));
  const placed: Placed[] = [];
  const placedFlags: Array<{ day: number; hard: boolean; ecc: boolean }> = [];
  const used = new Set<number>();
  const prevSunday = opts.prevSunday;
  // conflicts(), on the flags read once.
  const clashes = (s: { hard: boolean; ecc: boolean }, day: number): boolean => {
    if (!s.hard && !s.ecc) return false;
    if (day === 0 && prevSunday) {
      if (s.hard && prevSunday.hard) return true;
      if (s.ecc && prevSunday.eccentric) return true;
    }
    for (const p of placedFlags) {
      if (Math.abs(p.day - day) > 1) continue;
      if (s.hard && p.hard) return true;
      if (s.ecc && p.ecc) return true;
    }
    return false;
  };
  const dfs = (i: number): boolean => {
    if (i === sorted.length) return true;
    const session = sorted[i];
    for (const day of session.days) {
      if (used.has(day)) continue;
      if (clashes(session, day)) continue;
      used.add(day);
      placed.push({ w: session.w, day });
      placedFlags.push({ day, hard: session.hard, ecc: session.ecc });
      if (dfs(i + 1)) return true;
      placed.pop();
      placedFlags.pop();
      used.delete(day);
    }
    return false;
  };
  if (!dfs(0)) return null;
  const scheduled = placeCommutes(placed.map(p => withDay(p.w, p.day)), commutes);
  return scheduled.sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0));
}

/**
 * Schedule a HYROX week's sessions onto days.
 *
 * @param sessions - Sessions already generated (discipline + t set).
 * @param _band    - Ability band (reserved for future band-specific templates).
 * @param allowedDays - Race week only (plan_engine.hyrox raceWeekDays): the
 *   days each session may take, in order of preference (they replace its
 *   preferred days). A session with no free allowed day is left out of the
 *   week instead of being stacked on Monday. Unset = every day.
 * @param opts.prevSunday - The previous week's Sunday session, for the
 *   Sunday-to-Monday spacing.
 * @param opts.dropped - Receives each session left out for want of a legal
 *   day, so the plan engine can note it on the week.
 *
 * Without allowed days this is findHyroxWeekSchedule; when no legal placement
 * exists, sessions are placed greedily in priority order and a session with no
 * legal day is left out (the rules are never dropped). The plan engine resolves
 * those weeks before they reach here (generateWeekSessions).
 */
export function scheduleHyroxWeek(
  sessions: Workout[],
  _band: AbilityBand,
  allowedDays?: (w: Workout) => readonly number[],
  opts: { prevSunday?: HyroxPrevSunday | null; dropped?: Workout[] } = {},
): Workout[] {
  if (!allowedDays) {
    const found = findHyroxWeekSchedule(sessions, opts);
    if (found) return found;
  }
  const usedDays = new Set<number>();
  const placed: Placed[] = [];

  const sorted = [...sessions].sort((a, b) => priority(a) - priority(b));

  for (const session of sorted) {
    const allowedOrder = allowedDays ? [...allowedDays(session)] : null;
    const order = allowedOrder ?? candidateDays(session);
    let assigned = -1;
    for (const day of order) {
      if (usedDays.has(day)) continue;
      if (conflicts(session, day, placed, opts.prevSunday)) continue;
      assigned = day;
      break;
    }
    if (assigned === -1) { opts.dropped?.push(session); continue; } // no legal day left: not in this week
    usedDays.add(assigned);
    placed.push({ w: session, day: assigned });
  }

  // Return sorted by day so the plan-view renders chronologically.
  return placed.map(p => withDay(p.w, p.day)).sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0));
}
