/**
 * Triathlon and cycling race taper (planning side). SCIENCE_LOG "Triathlon and
 * cycling taper rebuild" (2026-10-13) holds the sources, the formula and the
 * limitations. Tristan's decisions of 2026-10-13 set the shape:
 *   - Length by race distance (triRaceTaperWeeks, triathlon-constants.ts).
 *   - Volume per discipline as a fraction of the reference week (the last
 *     full training week before the taper): 0.55 then 0.30 for a two-week
 *     taper, 0.55 for a one-week taper. The delivered week lands on it.
 *   - Quality kept: taper week 1 keeps the reference week's quality sessions
 *     with fewer reps; race week holds short race-pace openers.
 *   - Frequency: at least 80% of the reference week's sessions, and no
 *     discipline at zero in any taper week.
 *   - Race week: bigger sessions early, the last two days lightest, a short
 *     brick for long course (Byrn), a capped activation session the day before.
 *
 * This module holds the sourced race-week constants, the session builders for
 * race-pace work, openers and the day before, and the race-week composer. The
 * engine (plan_engine.triathlon.ts) supplies the reference week and the
 * aerobic session builders.
 */

import type { Workout } from '@/types/state';
import type { TriSkillSlider, TriathlonDistance } from '@/types/triathlon';
import { CYCLING_EVENT_INTENSITY_FACTOR, TRI_TAPER_MIN_SESSION_SHARE } from '@/constants/triathlon-constants';
import { RACE_INTENSITY_BY_DISTANCE } from '@/calculations/bike-physics';
import { bikeTargetLabel, generateBikeSession, loadForBike, rpeForBike, type BikeSessionKind } from './bike';
import { estimateDistanceMetres, loadForSwim, rpeForSwim } from './swim';
import { PRIMER_MAX_DAYS_OUT, PRIMER_MIN_DAYS_OUT } from './race-day-rules';
import { loadForTriRun } from './rung-load';
import { DAY_NAMES } from './scheduler.triathlon';

// ───────────────────────────────────────────────────────────────────────────
// Sourced constants (coaching practice; see SCIENCE_LOG)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The shortest taper session (minutes): the generators' own floor (swim, bike
 * and run sessions are floored at 20 min, generateSwimSession,
 * generateBikeSession, generateRunSessionForTri). Inside Goeringer's "very
 * short sessions (as little as 10-20 minutes)" and equal to Allen's 20-min
 * race-week run. Below the 30-min floor of training weeks so a 0.55 or 0.30
 * week keeps its sessions instead of losing them to the floor.
 */
export const TRI_TAPER_SESSION_FLOOR_MIN = 20;

/** Day before the race: ride cap (Allen 30 min; Byrn under 30 min;
 *  Triathlete guide 20-30 min before an Ironman) and its lower bound (the
 *  guide's 20 min). */
export const TRI_DAY_BEFORE_RIDE_MAX_MIN = 30;
export const TRI_DAY_BEFORE_RIDE_MIN_MIN = 20;
/** Day before the race: run cap (Allen 10 min; the Triathlete guide's 10-min
 *  jog before a sprint or Olympic; Byrn 5-15 min) and its lower bound (Byrn's
 *  5 min). */
export const TRI_DAY_BEFORE_RUN_MAX_MIN = 10;
export const TRI_DAY_BEFORE_RUN_MIN_MIN = 5;
/** Day-before pickups: Allen's 5 x 10 s at race effort. */
export const TRI_DAY_BEFORE_PICKUP_REPS = 5;
export const TRI_DAY_BEFORE_PICKUP_SEC = 10;

/** Two days before the race is a rest day (Friel; Allen: Friday off for a
 *  Sunday race). Byrn makes it the lightest day; Goeringer avoids full rest. */
export const TRI_RACE_WEEK_REST_DAYS_OUT = 2;

/** Byrn's race-week brick for 70.3 and Ironman (Thursday before a Sunday race,
 *  3 days out): 60 to 120 min, run capped at 30 min ("15 is fine"), 2 x 90 s
 *  builds in each leg. The conservative end: 60 min total, a 15-min run. */
export const TRI_RACE_WEEK_BRICK_TOTAL_MIN = 60;
export const TRI_RACE_WEEK_BRICK_RUN_MIN = 15;
export const TRI_RACE_WEEK_BRICK_BUILD_REPS = 2;

/** Race-pace repeats (Friel's race week, adapted from Shepley 1992): 90 s at
 *  race intensity with at least 3 min recovery, 5 / 4 / 3 repeats on the days
 *  5 / 4 / 3 days before race day, so a race-week opener holds as many
 *  repeats as it has days to go. */
export const TRI_RACE_PACE_REP_SEC = 90;
export const TRI_RACE_PACE_RECOVERY_MIN = 3;

/** Steady bike target between repeats: the endurance target of the bike
 *  library (describeBikeSession endurance variant 0, BIKE_INTENSITY_LADDER). */
const BIKE_STEADY_PCT_FTP = 0.65;

// Warm-up and cool-down of the existing quality sessions, used to size the
// number of race-pace repeats a taper session holds: bike tempo/sweet spot
// variant 0 (15 + 5 min), the tri run variants (15 + 10 min), the swim
// variants (200 m + 200 m).
const BIKE_WU_CD_MIN = 20;
const RUN_WU_CD_MIN = 25;
const SWIM_WU_CD_M = 400;

// ───────────────────────────────────────────────────────────────────────────
// Race intensity
// ───────────────────────────────────────────────────────────────────────────

/**
 * Race-day bike intensity factor: RACE_INTENSITY_BY_DISTANCE for triathlon
 * (Allen & Coggan 2010), CYCLING_EVENT_INTENSITY_FACTOR for a cycling event.
 * A planning use of the race-intensity fact: "race pace" in a workout is the
 * intensity the athlete will race at.
 */
export function triRaceBikeIntensity(
  distance: TriathlonDistance, cyclingOnly: boolean, cyclingDistance?: string | null,
): number {
  if (cyclingOnly) return CYCLING_EVENT_INTENSITY_FACTOR[cyclingDistance ?? '160km'] ?? CYCLING_EVENT_INTENSITY_FACTOR['160km'];
  return RACE_INTENSITY_BY_DISTANCE[distance];
}

/** The bike session kind whose zone holds a given %FTP (bike.ts zone table:
 *  endurance 56-75%, tempo 76-90%, sweet spot 88-95%). */
export function bikeKindForIntensity(pct: number): BikeSessionKind {
  if (pct < 0.76) return 'endurance';
  if (pct < 0.88) return 'tempo';
  return 'sweet_spot';
}

export interface TriTaperSessionCtx {
  /** Sprint or Olympic: race intensity sits at or above threshold. */
  shortCourse: boolean;
  /** Race bike intensity factor (triRaceBikeIntensity). */
  bikeIF: number;
  ftp?: number;
  hasPowerMeter?: boolean;
  cssSecPer100m?: number;
  swimSkill: TriSkillSlider;
  /** Easy run pace label, e.g. "5:45/km" (the week's easy pace). */
  easyLabel: string;
}

function fmtMin(mins: number): string {
  const r = mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
  const h = Math.floor(r / 60);
  const m = r % 60;
  if (h > 0 && m > 0) return `${h}h ${m}min`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

/** Repeats that fit a session of `minutes` after its warm-up and cool-down. */
function repeatsFor(minutes: number, wuCdMin: number): number {
  const repMin = TRI_RACE_PACE_REP_SEC / 60;
  return Math.max(1, Math.floor((minutes - wuCdMin + TRI_RACE_PACE_RECOVERY_MIN) / (repMin + TRI_RACE_PACE_RECOVERY_MIN)));
}

function swimWuCdMin(ctx: TriTaperSessionCtx): number {
  const pace = ctx.cssSecPer100m ?? (165 - (ctx.swimSkill - 1) * 20); // estimateDistanceMetres' pace
  return (SWIM_WU_CD_M / 100) * pace / 60;
}

function addLoads(a: { aerobic: number; anaerobic: number }, b: { aerobic: number; anaerobic: number }) {
  return { aerobic: a.aerobic + b.aerobic, anaerobic: a.anaerobic + b.anaerobic };
}

/**
 * A race-pace session: steady aerobic work with race-intensity repeats of
 * TRI_RACE_PACE_REP_SEC and TRI_RACE_PACE_RECOVERY_MIN easy between (Friel).
 *   - `reps` given (race-week opener): that many repeats.
 *   - otherwise (long-course taper week 1): as many as fit the session after
 *     the library's warm-up and cool-down, so a shorter taper session holds
 *     fewer reps.
 * Types follow the race intensity: a bike session takes the kind whose zone
 * holds the race intensity factor; a short-course run or swim is threshold
 * work, a long-course one an easy run or an endurance swim with race-pace
 * repeats inside (taperRole marks it either way). Load is the whole session
 * at its type's rate, the library's convention for a session with warm-up
 * and recoveries, and the rate the Adjust overlay and accepted suggestions
 * reprice with (loadForRung, loadForTriRun).
 */
export function triRacePaceSession(input: {
  discipline: 'swim' | 'bike' | 'run';
  minutes: number;
  reps?: number;
  role: 'race_pace' | 'opener';
  ctx: TriTaperSessionCtx;
}): Workout {
  const { discipline, role, ctx } = input;
  const minutes = Math.max(TRI_TAPER_SESSION_FLOOR_MIN, Math.round(input.minutes));
  const name = role === 'opener' ? 'Race-pace opener' : discipline === 'bike' ? 'Race-pace ride' : discipline === 'run' ? 'Race-pace run' : 'Race-pace swim';
  const between = `${TRI_RACE_PACE_RECOVERY_MIN}min easy between`;
  if (discipline === 'bike') {
    const reps = input.reps ?? repeatsFor(minutes, BIKE_WU_CD_MIN);
    const kind = bikeKindForIntensity(ctx.bikeIF);
    const t = kind === 'endurance' ? 'bike_endurance' : kind === 'tempo' ? 'bike_tempo' : 'bike_sweet_spot';
    const steady = bikeTargetLabel(ctx.ftp, ctx.hasPowerMeter, BIKE_STEADY_PCT_FTP, 'bike_endurance');
    const race = bikeTargetLabel(ctx.ftp, ctx.hasPowerMeter, ctx.bikeIF, t);
    const load = loadForBike(kind, minutes);
    const rpe = rpeForBike(kind, 'taper');
    return {
      n: name, t, discipline: 'bike', r: rpe, rpe, ...load,
      d: `${fmtMin(minutes)} ride @ ${steady}, with ${reps}×${TRI_RACE_PACE_REP_SEC}s @ ${race} (race intensity) in the middle, ${between}.`,
      estimatedDurationMin: minutes,
      taperRole: role,
    };
  }
  if (discipline === 'run') {
    const reps = input.reps ?? repeatsFor(minutes, RUN_WU_CD_MIN);
    const t = ctx.shortCourse ? 'threshold' : 'easy';
    const rpe = ctx.shortCourse ? 8 : 4;
    return {
      n: name, t, discipline: 'run', r: rpe, rpe, ...loadForTriRun(t, minutes)!,
      d: `${fmtMin(minutes)} @ ${ctx.easyLabel}, with ${reps}×${TRI_RACE_PACE_REP_SEC}s @ race pace in the middle, ${TRI_RACE_PACE_RECOVERY_MIN}min jog between.`,
      estimatedDurationMin: minutes,
      taperRole: role,
    };
  }
  const reps = input.reps ?? repeatsFor(minutes, swimWuCdMin(ctx));
  const kind = ctx.shortCourse ? 'threshold' : 'endurance';
  const metres = estimateDistanceMetres(minutes, ctx.swimSkill, ctx.cssSecPer100m);
  const rpe = rpeForSwim(kind, 'taper');
  return {
    n: name, t: ctx.shortCourse ? 'swim_threshold' : 'swim_endurance', discipline: 'swim', r: rpe, rpe,
    ...loadForSwim(kind, minutes),
    d: `${metres}m total, steady, with ${reps}×${TRI_RACE_PACE_REP_SEC}s @ race pace in the middle, ${TRI_RACE_PACE_RECOVERY_MIN}min easy swimming between.`,
    estimatedDurationMin: minutes,
    taperRole: role,
  };
}

/** VO2 micro-intervals sized to a taper session (fewer reps in a shorter
 *  session): describeBikeSession vo2_micros variant 1's 30 s @ 118% FTP /
 *  30 s easy, after its 20-min warm-up and before its 10-min cool-down. */
export function triTaperVo2MicrosRide(input: {
  minutes: number; ftp?: number; hasPowerMeter?: boolean; weekIndex: number; totalWeeks: number;
  skill: TriSkillSlider; slotIndex: number;
}): Workout {
  const minutes = Math.max(TRI_TAPER_SESSION_FLOOR_MIN, Math.round(input.minutes));
  const base = generateBikeSession({
    phase: 'taper', skill: input.skill, weekIndex: input.weekIndex, totalWeeks: input.totalWeeks,
    targetMinutes: minutes, kind: 'vo2_micros', ftp: input.ftp, hasPowerMeter: input.hasPowerMeter,
    slotIndex: input.slotIndex, variantIndex: 1,
  });
  const reps = Math.max(1, Math.floor(minutes - 30));
  const on = bikeTargetLabel(input.ftp, input.hasPowerMeter, 1.18, 'bike_vo2_micros');
  const off = bikeTargetLabel(input.ftp, input.hasPowerMeter, 0.50, 'bike_vo2_micros');
  return { ...base, d: `20min Warm up. Main: ${reps}×(30s @ ${on} / 30s @ ${off}). 10min Cool down.` };
}

/** A threshold run sized to a taper session: the tri run library's 8-min
 *  threshold reps with 2-min jog (THRESHOLD_RUN_VARIANTS[0]), as many as fit
 *  after its 15-min warm-up and 10-min cool-down (at least one). */
export function triTaperThresholdRunDesc(minutes: number, thresholdLabel: string, easyLabel: string): string {
  const reps = Math.max(1, Math.floor((minutes - RUN_WU_CD_MIN + 2) / 10));
  return `15min warm up @ ${easyLabel}. ${reps}×8min @ ${thresholdLabel}, 2min jog recovery. 10min cool down.`;
}

/** Day before the race, ride: an easy spin capped at TRI_DAY_BEFORE_RIDE_MAX_MIN
 *  with Allen's 5 x 10 s pickups. */
export function triDayBeforeRide(input: {
  minutes: number; ftp?: number; hasPowerMeter?: boolean; skill: TriSkillSlider; weekIndex: number; totalWeeks: number;
}): Workout {
  const minutes = Math.round(input.minutes);
  const base = generateBikeSession({
    phase: 'taper', skill: input.skill, weekIndex: input.weekIndex, totalWeeks: input.totalWeeks,
    targetMinutes: minutes, kind: 'endurance', ftp: input.ftp, hasPowerMeter: input.hasPowerMeter, variantIndex: 0,
  });
  const steady = bikeTargetLabel(input.ftp, input.hasPowerMeter, BIKE_STEADY_PCT_FTP, 'bike_endurance');
  return {
    ...base,
    n: 'Pre-race spin',
    d: `${minutes}min easy spin @ ${steady}, with ${TRI_DAY_BEFORE_PICKUP_REPS}×${TRI_DAY_BEFORE_PICKUP_SEC}s pickups to race effort. Activation only.`,
    estimatedDurationMin: minutes,
    taperRole: 'day_before',
  };
}

/** Day before the race, run: an easy jog capped at TRI_DAY_BEFORE_RUN_MAX_MIN
 *  with Allen's 5 x 10 s pickups. */
export function triDayBeforeRun(minutes: number, easyLabel: string): Workout {
  const m = Math.round(minutes);
  return {
    n: 'Pre-race jog',
    d: `${m}min easy jog @ ${easyLabel}, with ${TRI_DAY_BEFORE_PICKUP_REPS}×${TRI_DAY_BEFORE_PICKUP_SEC}s pickups to race pace. Activation only.`,
    t: 'easy', discipline: 'run', r: 4, rpe: 4,
    ...loadForTriRun('easy', m)!,
    estimatedDurationMin: m,
    taperRole: 'day_before',
  };
}

/** Byrn's race-week brick: steady bike then a short run, 2 x 90 s builds to
 *  race effort in each leg. */
export function triRaceWeekBrick(ctx: TriTaperSessionCtx): Workout {
  const runMin = TRI_RACE_WEEK_BRICK_RUN_MIN;
  const bikeMin = TRI_RACE_WEEK_BRICK_TOTAL_MIN - runMin;
  const reps = TRI_RACE_WEEK_BRICK_BUILD_REPS;
  const steady = bikeTargetLabel(ctx.ftp, ctx.hasPowerMeter, BIKE_STEADY_PCT_FTP, 'bike_endurance');
  const pm = ctx.hasPowerMeter && ctx.ftp;
  // Steady legs with short builds: the bike leg at the endurance rate, the
  // run leg at the easy rate (the builds are 3 of each leg's minutes).
  const load = addLoads(loadForBike('endurance', bikeMin), loadForTriRun('easy', runMin)!);
  return {
    n: 'Brick: bike + run',
    t: 'brick',
    discipline: 'bike',
    r: 6, rpe: 6,
    ...load,
    d: `BIKE ${bikeMin}min @ ${steady} with ${reps}×${TRI_RACE_PACE_REP_SEC}s builds to race effort, straight into RUN ${runMin}min steady with ${reps}×${TRI_RACE_PACE_REP_SEC}s builds to race pace. Race-week brick: short, rehearses the transition.`,
    brickSegments: [
      {
        discipline: 'bike', durationMin: bikeMin, targetPctFtp: BIKE_STEADY_PCT_FTP,
        targetWatts: pm ? Math.round(ctx.ftp! * BIKE_STEADY_PCT_FTP) : undefined,
      },
      { discipline: 'run', durationMin: runMin },
    ],
    estimatedDurationMin: bikeMin + runMin,
    taperRole: 'opener',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Race-week composer
// ───────────────────────────────────────────────────────────────────────────

export type TriDisc = 'swim' | 'bike' | 'run';
const DISCS: TriDisc[] = ['swim', 'bike', 'run'];

/** The reference week (the last full training week before the taper). */
export interface TriTaperRef {
  /** Swim, bike and run minutes; brick legs counted in their discipline;
   *  commutes and gym excluded. */
  minutes: Record<TriDisc, number>;
  /** Sessions per discipline; the brick counts as one bike session. */
  counts: Record<TriDisc, number>;
  /** All swim, bike, run and brick sessions. */
  total: number;
}

export interface TriRaceWeekInput {
  present: Record<TriDisc, boolean>;
  /** T100, 70.3, Ironman: Byrn's brick, a run and a swim opener. */
  longCourse: boolean;
  /** Cycling: Friel's openers on every opener day, all rides. */
  singleSport: boolean;
  /** Race week's share of the reference week (0.30 or 0.55). */
  fraction: number;
  ref: TriTaperRef;
  /** Days before race day for each weekday of race week (0 = Monday); null
   *  where no session may go (before the first schedulable day, on or after
   *  race day). */
  daysOut: Array<number | null>;
  /** Per-day minute caps (the user's weekday and weekend hours). */
  dayCapMin?: Record<number, number>;
  ctx: TriTaperSessionCtx;
  /** Aerobic session builders (the engine's own swim, bike and run). */
  aerobic: (d: TriDisc, minutes: number, slot: number) => Workout;
  dayBeforeRide: (minutes: number) => Workout;
}

/**
 * Compose race week from the reference week (planning side). Budget per
 * discipline = fraction x reference minutes. Steps:
 *   1. Long course: Byrn's brick on the opener-window day nearest the race
 *      (3 days out for a Sunday race), when the bike and run budgets hold it.
 *   2. The day before: an easy ride (TRI_DAY_BEFORE_RIDE_MAX_MIN) and an easy
 *      run (TRI_DAY_BEFORE_RUN_MAX_MIN) with pickups, each from what its
 *      budget has left (skipped below the sourced lower bound). Two days out
 *      stays empty (rest).
 *   3. Openers on the opener-window days (PRIMER_MIN_DAYS_OUT to
 *      PRIMER_MAX_DAYS_OUT), one per day, as many 90 s race-pace repeats as
 *      days to go (Friel). Order: run first (cut deepest, furthest from the
 *      race), then bike, then swim (coaching consensus: run tapered first, swim
 *      last). Long course with a brick: run, then swim (the brick carries the
 *      bike's). Cycling: a ride on every window day.
 *   4. The rest of each budget split into sessions: the reference count less
 *      the brick (the day-before activation takes no session's place), at
 *      least the discipline's openers, no session longer than the reference
 *      week's average session of that discipline, and the nearest whole
 *      number of TRI_TAPER_SESSION_FLOOR_MIN sessions at most. Then, while
 *      race week (the race counted as one session, as it takes the long
 *      session's slot) holds fewer than TRI_TAPER_MIN_SESSION_SHARE of the
 *      reference sessions, one more session in the discipline with the most
 *      minutes per session left; frequency wins over the floor, so a thin
 *      budget gets a floor-length session and the week sits a few minutes
 *      above its fraction. Every discipline the plan has keeps a session.
 *   5. Sessions without a fixed day go to the earliest days at least 3 days
 *      out, biggest first, one per discipline per day, within the day caps
 *      when a day has room; with no day free of its discipline a session is
 *      left out (the scheduler's race-week rule).
 *   6. The day-before ride is cut to the longest other session if it would
 *      be the week's longest.
 * Pure. Returns the sessions with dayOfWeek and dayName set.
 */
export function composeTriRaceWeek(inp: TriRaceWeekInput): Workout[] {
  const { present, ref, daysOut, ctx } = inp;
  const B: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
  for (const d of DISCS) B[d] = present[d] ? inp.fraction * ref.minutes[d] : 0;

  const dows = [0, 1, 2, 3, 4, 5, 6].filter(dow => daysOut[dow] != null && daysOut[dow]! >= 1);
  const dOut = (dow: number) => daysOut[dow] as number;
  const dbDow = dows.find(dow => dOut(dow) === 1);
  const train = dows.filter(dow => dOut(dow) > TRI_RACE_WEEK_REST_DAYS_OUT);
  // Opener window, furthest from the race first.
  const window = train
    .filter(dow => dOut(dow) >= PRIMER_MIN_DAYS_OUT && dOut(dow) <= PRIMER_MAX_DAYS_OUT)
    .sort((a, b) => dOut(b) - dOut(a));

  const used: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
  // Full sessions placed so far (the brick). The day-before activation takes
  // no reference session's place.
  const fixedCount: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
  const activation: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
  const byDay: Record<number, Workout[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  const occ: Record<number, Set<string>> = { 0: new Set(), 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set(), 6: new Set() };
  const dayMin: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const place = (dow: number, w: Workout, discs: TriDisc[]) => {
    byDay[dow].push({ ...w, dayOfWeek: dow, dayName: DAY_NAMES[dow] });
    for (const d of discs) occ[dow].add(d);
    dayMin[dow] += w.estimatedDurationMin ?? 0;
  };

  // 1. Brick (long course).
  const brickBike = TRI_RACE_WEEK_BRICK_TOTAL_MIN - TRI_RACE_WEEK_BRICK_RUN_MIN;
  const brickDow = inp.longCourse && present.bike && present.run
    && B.bike >= brickBike && B.run >= TRI_RACE_WEEK_BRICK_RUN_MIN && window.length > 0
    ? window[window.length - 1]
    : undefined;
  if (brickDow != null) {
    place(brickDow, triRaceWeekBrick(ctx), ['bike', 'run']);
    used.bike += brickBike;
    used.run += TRI_RACE_WEEK_BRICK_RUN_MIN;
    fixedCount.bike++;
  }

  // 2. The day before.
  if (dbDow != null) {
    if (present.bike) {
      const ride = Math.min(TRI_DAY_BEFORE_RIDE_MAX_MIN, Math.floor(B.bike - used.bike));
      if (ride >= TRI_DAY_BEFORE_RIDE_MIN_MIN) {
        place(dbDow, inp.dayBeforeRide(ride), ['bike']);
        used.bike += ride;
        activation.bike++;
      }
    }
    if (present.run && !inp.singleSport) {
      const run = Math.min(TRI_DAY_BEFORE_RUN_MAX_MIN, Math.floor(B.run - used.run));
      if (run >= TRI_DAY_BEFORE_RUN_MIN_MIN) {
        place(dbDow, triDayBeforeRun(run, ctx.easyLabel), ['run']);
        used.run += run;
        activation.run++;
      }
    }
  }

  // 3. Opener days and disciplines.
  const openerDays = window.filter(dow => dow !== brickDow);
  const order: TriDisc[] = inp.singleSport
    ? openerDays.map(() => 'bike' as TriDisc)
    : (brickDow != null ? (['run', 'swim'] as TriDisc[]) : (['run', 'bike', 'swim'] as TriDisc[]));
  const openerPlan: Array<{ d: TriDisc; dow: number }> = [];
  const discs = order.filter(d => present[d]);
  for (let i = 0; i < discs.length && i < openerDays.length; i++) openerPlan.push({ d: discs[i], dow: openerDays[i] });

  // 4. Session counts and sizes.
  const floorMin = TRI_TAPER_SESSION_FLOOR_MIN;
  const freeDays = (d: TriDisc) => train.filter(dow => !occ[dow].has(d)).length;
  const rem: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
  const n: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
  for (const d of DISCS) {
    if (!present[d]) continue;
    rem[d] = Math.max(0, B[d] - used[d]);
    const openers = openerPlan.filter(o => o.d === d).length;
    const avg = ref.counts[d] > 0 ? ref.minutes[d] / ref.counts[d] : Infinity;
    let k = Math.max(openers, ref.counts[d] - fixedCount[d]);
    k = Math.max(k, Math.ceil(rem[d] / avg));
    // The count that lands nearest the fraction: as many sessions as fit at
    // the floor, or for less than one floor's worth, one floor-length session
    // when that overshoots by less than leaving the minutes out undershoots.
    k = Math.min(k, rem[d] >= floorMin ? Math.floor(rem[d] / floorMin) : (rem[d] * 2 > floorMin ? 1 : 0));
    // One session per discipline per day.
    k = Math.min(k, freeDays(d));
    if (fixedCount[d] + activation[d] + k === 0) k = 1; // no discipline at zero
    n[d] = Math.max(0, k);
  }
  const need = Math.ceil(TRI_TAPER_MIN_SESSION_SHARE * ref.total) - 1; // the race is one session
  const fixedTotal = Object.values(byDay).reduce((a, l) => a + l.length, 0);
  const total = () => fixedTotal + n.swim + n.bike + n.run;
  while (total() < need) {
    let best: TriDisc | null = null;
    let bestSize = -1;
    for (const d of DISCS) {
      if (!present[d]) continue;
      // Frequency wins over the floor: the added session is floor length when
      // the budget is thinner, from the discipline it overshoots least.
      const size = rem[d] / (n[d] + 1);
      if (rem[d] > 0 && n[d] < freeDays(d) && size > bestSize) { best = d; bestSize = size; }
    }
    if (!best) break;
    n[best]++;
  }
  const size: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
  for (const d of DISCS) size[d] = n[d] > 0 ? Math.max(floorMin, Math.round(rem[d] / n[d])) : 0;

  // Openers beyond a discipline's session count are left out (latest first).
  const openersPlaced: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
  for (const o of openerPlan) {
    if (openersPlaced[o.d] >= n[o.d] || occ[o.dow].has(o.d)) continue;
    const w = triRacePaceSession({ discipline: o.d, minutes: size[o.d], reps: dOut(o.dow), role: 'opener', ctx });
    place(o.dow, w, [o.d]);
    openersPlaced[o.d]++;
  }

  // 5. Aerobic sessions: biggest first, earliest day first.
  const pending: Array<{ d: TriDisc; min: number; slot: number }> = [];
  for (const d of DISCS) {
    for (let i = openersPlaced[d]; i < n[d]; i++) pending.push({ d, min: size[d], slot: i });
  }
  const discOrder: Record<TriDisc, number> = { bike: 0, run: 1, swim: 2 };
  pending.sort((a, b) => (b.min - a.min) || (discOrder[a.d] - discOrder[b.d]));
  const cap = (dow: number) => inp.dayCapMin?.[dow];
  for (const p of pending) {
    const free = train.filter(dow => !occ[dow].has(p.d));
    if (free.length === 0) continue;
    const fits = free.find(dow => cap(dow) === undefined || dayMin[dow] + p.min <= cap(dow)! + 15);
    const dow = fits ?? free.reduce((best, d) => (dayMin[d] < dayMin[best] ? d : best), free[0]);
    place(dow, inp.aerobic(p.d, p.min, p.slot), [p.d]);
  }

  // The day before is never the week's longest session: its ride (the only
  // activation that can approach other sessions) comes down to the longest
  // other session when it would be longer. Every other session is at least
  // TRI_TAPER_SESSION_FLOOR_MIN, the ride's sourced lower bound.
  if (dbDow != null) {
    const others = Object.values(byDay).flat().filter(w => w.taperRole !== 'day_before');
    const longest = Math.max(0, ...others.map(w => w.estimatedDurationMin ?? 0));
    byDay[dbDow] = byDay[dbDow].map(w => {
      if (w.taperRole !== 'day_before' || w.discipline !== 'bike' || longest <= 0) return w;
      if ((w.estimatedDurationMin ?? 0) <= longest) return w;
      return { ...inp.dayBeforeRide(longest), dayOfWeek: dbDow, dayName: DAY_NAMES[dbDow] };
    });
  }

  const out: Workout[] = [];
  for (let dow = 0; dow < 7; dow++) out.push(...byDay[dow]);
  return out;
}
