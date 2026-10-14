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
 *     brick for long course (Byrn), a short activation the day before.
 *
 * This module holds the sourced taper constants, the session builders for
 * taper quality work, openers and the day before, and the race-week composer.
 * The engine (plan_engine.triathlon.ts) supplies the reference week and the
 * aerobic session builders.
 */

import type { Workout } from '@/types/state';
import type { TriSkillSlider, TriathlonDistance } from '@/types/triathlon';
import { CYCLING_EVENT_INTENSITY_FACTOR, TRI_TAPER_MIN_SESSION_SHARE } from '@/constants/triathlon-constants';
import { RACE_INTENSITY_BY_DISTANCE } from '@/calculations/bike-physics';
import { bikeTargetLabel, generateBikeSession, loadForBike, rpeForBike, type BikeSessionKind } from './bike';
import { estimateDistanceMetres, generateSwimSession, loadForSwim, rpeForSwim } from './swim';
import { PRIMER_MAX_DAYS_OUT, PRIMER_MIN_DAYS_OUT } from './race-day-rules';
import { loadForTriRun, TRI_RUN_LOAD_SHARES } from './rung-load';
import { plannedTssPerMin } from '@/constants';
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

/** Day before the race, ride: sized from its lower bound (the Triathlete
 *  guide's 20-30 min spin before an Ironman) and grown toward its cap (Allen
 *  30 min; Byrn under 30 min) only with race-week budget left over, while the
 *  day stays the lightest of the week. */
export const TRI_DAY_BEFORE_RIDE_MAX_MIN = 30;
export const TRI_DAY_BEFORE_RIDE_MIN_MIN = 20;
/** Day before the race, run: lower bound Byrn's 5 min (his 5-15 min), cap
 *  Allen's 10 min (also the Triathlete guide's 10-min jog before a sprint or
 *  Olympic). */
export const TRI_DAY_BEFORE_RUN_MAX_MIN = 10;
export const TRI_DAY_BEFORE_RUN_MIN_MIN = 5;
/** Day-before pickups: Allen's 5 x 10 s at race effort. */
export const TRI_DAY_BEFORE_PICKUP_REPS = 5;
export const TRI_DAY_BEFORE_PICKUP_SEC = 10;

/** Two days before the race is a rest day (Friel; Allen: Friday off for a
 *  Sunday race). Byrn makes it the lightest day; Goeringer avoids full rest
 *  days ("very short sessions, as little as 10-20 minutes"). */
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
 *  repeats as it has days to go. 90 s is also the short end of Dave Scott's
 *  taper repeats (90 s to 3.5 min, 22 to 10 days out). */
export const TRI_RACE_PACE_REP_SEC = 90;
export const TRI_RACE_PACE_RECOVERY_MIN = 3;

/** Taper week 1 keeps this share of a short-course reference quality
 *  session's reps (Goeringer: 8 x 800 m becomes 6 x 800 m two weeks out and
 *  4 x 800 m in race week; 6 / 8 = 0.75). */
export const TRI_TAPER_QUALITY_WORK_SHARE = 0.75;

/** Dave Scott's taper sets 9 to 3 days out: 4 to 12 min of work, in segments
 *  of 30 to 90 s. The lower bound floors every taper main set (a session too
 *  short for it grows to hold it); the upper bound caps the race-pace work of
 *  a long-course taper session. */
export const TRI_TAPER_MAIN_SET_MIN_MIN = 4;
export const TRI_TAPER_RACE_PACE_SET_MAX_MIN = 12;

/**
 * Race-week session length caps by discipline (minutes). Coaching race weeks
 * for a Sunday race:
 *   - run 45: Byrn's Tuesday run, 30 to 45 min with 5 x 90 s builds (his race
 *     week's longest run; Allen's longest race-week run is 40 min);
 *   - bike 90: Allen's longest race-week rides (Ironman, Monday 90 min Z2 and
 *     Thursday 90 min high Z2);
 *   - swim 45: Byrn's Monday swim at its conservative tier (45 / 60 / 75 min
 *     for novice / competitive / top amateur).
 * Openers and aerobic sessions alike stay under them.
 */
export const TRI_RACE_WEEK_SESSION_CAP_MIN: Record<'swim' | 'bike' | 'run', number> = { swim: 45, bike: 90, run: 45 };

/** At most two training sessions on a race-week day: every day of Allen's race
 *  week but his swim, bike and run three days out, whose slot the plan gives
 *  Byrn's brick in long course. The day-before activations are not counted
 *  (Allen's day before is a short swim, ride and run). */
export const TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY = 2;

/** The scheduler's day-cap tolerance (scheduleTriathlonWeek hasCapacity). */
const DAY_CAP_TOLERANCE_MIN = 15;

/** Steady bike target between repeats: the endurance target of the bike
 *  library (describeBikeSession endurance variant 0, BIKE_INTENSITY_LADDER). */
const BIKE_STEADY_PCT_FTP = 0.65;

// Warm-up and cool-down of taper quality work. The cut falls on them first:
// the library's own lengths when the session has room, else the cool-down,
// then the warm-up, down to the library's shortest.
//   - bike: VO2 micro-intervals 20 + 10 min; shortest, tempo and sweet spot
//     variant 0, 15 + 5 min.
//   - run: the tri run library's 15-min warm-up and 10-min cool-down; the
//     shortest cool-down is the library's 5 min (bike tempo and sweet spot;
//     the HYROX run sessions).
//   - swim: 200 m + 200 m, every swim in the library.
const BIKE_WU = { lib: 20, min: 15 };
const BIKE_CD = { lib: 10, min: 5 };
const RUN_WU = { lib: 15, min: 15 };
const RUN_CD = { lib: 10, min: 5 };
const SWIM_WU_CD_M = 400;

/** Library reference structures for short-course taper quality, sized at 75%:
 *  VO2 micro-intervals variant 1 holds 15 x 30:30 at every length
 *  (describeBikeSession); the tri threshold run variant 1 is 4 x 6 min with
 *  90 s jog (THRESHOLD_RUN_VARIANTS). */
const MICROS_REF_REPS = 15;
const THRESHOLD_REF_REPS = 4;
const THRESHOLD_REP_MIN = 6;
const THRESHOLD_REC_MIN = 1.5;

// ───────────────────────────────────────────────────────────────────────────
// Race intensity
// ───────────────────────────────────────────────────────────────────────────

/**
 * Race-day bike intensity factor: RACE_INTENSITY_BY_DISTANCE for triathlon
 * (bike-physics.ts: Allen & Coggan guidance for 70.3 and Ironman, Coyle 1984
 * fractional utilisation for sprint and Olympic, T100 interpolated just below
 * 70.3), CYCLING_EVENT_INTENSITY_FACTOR for a cycling event. A planning use
 * of the race-intensity fact: "race pace" in a workout is the intensity the
 * athlete will race at.
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

function addLoads(a: { aerobic: number; anaerobic: number }, b: { aerobic: number; anaerobic: number }) {
  return { aerobic: a.aerobic + b.aerobic, anaerobic: a.anaerobic + b.anaerobic };
}

/** Swim pace in s/100 m: CSS when known, else estimateDistanceMetres' skill pace. */
function swimPace(css: number | undefined, skill: TriSkillSlider): number {
  return css ?? (165 - (skill - 1) * 20);
}

function swimMinutes(metres: number, css: number | undefined, skill: TriSkillSlider): number {
  return (metres / 100) * swimPace(css, skill) / 60;
}

/** Warm-up and cool-down minutes of a race-pace session or opener (the
 *  library's shortest; the cut falls on them first). */
function racePaceWuCdMin(discipline: 'swim' | 'bike' | 'run', ctx: Pick<TriTaperSessionCtx, 'cssSecPer100m' | 'swimSkill'>): number {
  if (discipline === 'bike') return BIKE_WU.min + BIKE_CD.min;
  if (discipline === 'run') return RUN_WU.min + RUN_CD.min;
  return swimMinutes(SWIM_WU_CD_M, ctx.cssSecPer100m, ctx.swimSkill);
}

/** Minutes of a race-pace main set of `reps` x 90 s with 3 min between. */
function racePaceMainMin(reps: number): number {
  return reps * (TRI_RACE_PACE_REP_SEC / 60) + Math.max(0, reps - 1) * TRI_RACE_PACE_RECOVERY_MIN;
}

/** Fewest race-pace repeats a session holds: Dave Scott's 4-min floor. */
export const TRI_RACE_PACE_MIN_REPS = Math.ceil(TRI_TAPER_MAIN_SET_MIN_MIN / (TRI_RACE_PACE_REP_SEC / 60));
/** Most race-pace repeats a taper session holds: Dave Scott's 12-min sets. */
export const TRI_RACE_PACE_MAX_REPS = Math.floor(TRI_TAPER_RACE_PACE_SET_MAX_MIN / (TRI_RACE_PACE_REP_SEC / 60));

/** Minutes a race-pace session or opener of `reps` repeats needs. */
export function triRacePaceNeedMin(
  discipline: 'swim' | 'bike' | 'run', reps: number, ctx: Pick<TriTaperSessionCtx, 'cssSecPer100m' | 'swimSkill'>,
): number {
  return racePaceWuCdMin(discipline, ctx) + racePaceMainMin(reps);
}

/** Repeats a race-pace session of `minutes` holds after its warm-up and
 *  cool-down (at least one). */
function racePaceFit(discipline: 'swim' | 'bike' | 'run', minutes: number, ctx: Pick<TriTaperSessionCtx, 'cssSecPer100m' | 'swimSkill'>): number {
  const rep = TRI_RACE_PACE_REP_SEC / 60;
  return Math.max(1, Math.floor((minutes - racePaceWuCdMin(discipline, ctx) + TRI_RACE_PACE_RECOVERY_MIN) / (rep + TRI_RACE_PACE_RECOVERY_MIN)));
}

/**
 * Race-pace repeats for a long-course taper-week-1 session from its reference
 * quality session's work (minutes): Goeringer's 75% of the work, held inside
 * Dave Scott's 4 to 12 min sets, as 90 s repeats. Unknown reference work takes
 * the 12-min ceiling.
 */
export function triRacePaceTargetReps(refWorkMin: number | null): number {
  const work = Math.min(TRI_TAPER_RACE_PACE_SET_MAX_MIN, TRI_TAPER_QUALITY_WORK_SHARE * (refWorkMin ?? Infinity));
  const reps = Math.round(work / (TRI_RACE_PACE_REP_SEC / 60));
  return Math.max(TRI_RACE_PACE_MIN_REPS, Math.min(TRI_RACE_PACE_MAX_REPS, reps));
}

/**
 * Work minutes in a library quality session's main set, read from its
 * description (planning side; the reference for a taper session's share).
 * Recognises repeat blocks (2×(10×30s ...), 3×(8×40s ...)), over-unders
 * (3×(3min ... → 3min ...)), timed repeats (5×3min, 15×(30s ...)), continuous
 * blocks (40min continuous) and swim repeats (10×200m, at CSS or the skill
 * pace). Null when the description holds none of these.
 */
export function triQualityWorkMinutes(w: Pick<Workout, 'd' | 'discipline'>, css?: number, skill: TriSkillSlider = 3): number | null {
  const d = w.d ?? '';
  const main = d.includes('Main:') ? d.slice(d.indexOf('Main:')) : d;
  const unit = (v: string, u: string) => (u === 's' ? Number(v) / 60 : Number(v));
  let m = /(\d+)×\((\d+)×(\d+)(s|min)\b/.exec(main);
  if (m) return Number(m[1]) * Number(m[2]) * unit(m[3], m[4]);
  m = /(\d+)×\((\d+)min @[^→)]*→\s*(\d+)min/.exec(main);
  if (m) return Number(m[1]) * (Number(m[2]) + Number(m[3]));
  m = /(\d+)×\(?(\d+)(s|min)\b/.exec(main);
  if (m) return Number(m[1]) * unit(m[2], m[3]);
  m = /(\d+)min continuous/.exec(main);
  if (m) return Number(m[1]);
  if (w.discipline === 'swim') {
    m = /(\d+)×(\d+)m\b/.exec(main);
    if (m) return swimMinutes(Number(m[1]) * Number(m[2]), css, skill);
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Session builders
// ───────────────────────────────────────────────────────────────────────────

/**
 * A race-pace session: steady aerobic work with race-intensity repeats of
 * TRI_RACE_PACE_REP_SEC and TRI_RACE_PACE_RECOVERY_MIN easy between (Friel).
 *   - `reps` given (race-week opener): that many repeats.
 *   - otherwise (long-course taper week 1): `targetReps` (triRacePaceTargetReps,
 *     Dave Scott's 12-min ceiling when absent), as many as the session holds
 *     after the shortest warm-up and cool-down.
 * A taper-week-1 race-pace session is the week's quality session: a ride
 * takes the kind whose zone holds the race intensity factor; a short-course
 * run or swim is threshold work, a long-course one an easy run or an
 * endurance swim with race-pace repeats inside. An opener is typed by its
 * dominant content (an endurance ride, an easy run, an endurance swim: the
 * steady minutes outweigh the repeats), with that type's RPE. Load is the
 * whole session at its type's rate, the library convention and the rate the
 * Adjust overlay and accepted suggestions reprice with (loadForRung,
 * loadForTriRun). taperRole marks the session either way.
 */
export function triRacePaceSession(input: {
  discipline: 'swim' | 'bike' | 'run';
  minutes: number;
  reps?: number;
  targetReps?: number;
  role: 'race_pace' | 'opener';
  ctx: TriTaperSessionCtx;
}): Workout {
  const { discipline, role, ctx } = input;
  const minutes = Math.max(TRI_TAPER_SESSION_FLOOR_MIN, Math.round(input.minutes));
  const reps = input.reps ?? Math.min(input.targetReps ?? TRI_RACE_PACE_MAX_REPS, racePaceFit(discipline, minutes, ctx));
  const opener = role === 'opener';
  const name = opener ? 'Race-pace opener' : discipline === 'bike' ? 'Race-pace ride' : discipline === 'run' ? 'Race-pace run' : 'Race-pace swim';
  const between = `${TRI_RACE_PACE_RECOVERY_MIN}min easy between`;
  if (discipline === 'bike') {
    const kind = opener ? 'endurance' : bikeKindForIntensity(ctx.bikeIF);
    const t = kind === 'endurance' ? 'bike_endurance' : kind === 'tempo' ? 'bike_tempo' : 'bike_sweet_spot';
    const steady = bikeTargetLabel(ctx.ftp, ctx.hasPowerMeter, BIKE_STEADY_PCT_FTP, 'bike_endurance');
    const race = bikeTargetLabel(ctx.ftp, ctx.hasPowerMeter, ctx.bikeIF, opener ? `bike_${bikeKindForIntensity(ctx.bikeIF)}` : t);
    const rpe = rpeForBike(kind, 'taper');
    return {
      n: name, t, discipline: 'bike', r: rpe, rpe, ...loadForBike(kind, minutes),
      d: `${fmtMin(minutes)} ride @ ${steady}, with ${reps}×${TRI_RACE_PACE_REP_SEC}s @ ${race} (race intensity) in the middle, ${between}.`,
      estimatedDurationMin: minutes,
      taperRole: role,
    };
  }
  if (discipline === 'run') {
    const t = ctx.shortCourse && !opener ? 'threshold' : 'easy';
    const rpe = t === 'threshold' ? 8 : 4;
    return {
      n: name, t, discipline: 'run', r: rpe, rpe, ...loadForTriRun(t, minutes)!,
      d: `${fmtMin(minutes)} @ ${ctx.easyLabel}, with ${reps}×${TRI_RACE_PACE_REP_SEC}s @ race pace in the middle, ${TRI_RACE_PACE_RECOVERY_MIN}min jog between.`,
      estimatedDurationMin: minutes,
      taperRole: role,
    };
  }
  const kind = ctx.shortCourse && !opener ? 'threshold' : 'endurance';
  const metres = estimateDistanceMetres(minutes, ctx.swimSkill, ctx.cssSecPer100m);
  const rpe = rpeForSwim(kind, 'taper');
  return {
    n: name, t: kind === 'threshold' ? 'swim_threshold' : 'swim_endurance', discipline: 'swim', r: rpe, rpe,
    ...loadForSwim(kind, minutes),
    d: `${metres}m total, steady, with ${reps}×${TRI_RACE_PACE_REP_SEC}s @ race pace in the middle, ${TRI_RACE_PACE_RECOVERY_MIN}min easy swimming between.`,
    estimatedDurationMin: minutes,
    taperRole: role,
  };
}

/** Warm-up, cool-down and steady minutes around a main set in a session of
 *  `minutes`: the library's lengths when the session has room (any more
 *  becomes steady work), else the cool-down, then the warm-up, down to the
 *  library's shortest. */
function fitWuCd(minutes: number, mainMin: number, wu: { lib: number; min: number }, cd: { lib: number; min: number }) {
  const room = minutes - mainMin;
  if (room >= wu.lib + cd.lib) return { wu: wu.lib, cd: cd.lib, steady: Math.round(room - wu.lib - cd.lib) };
  if (room >= wu.lib + cd.min) return { wu: wu.lib, cd: Math.round(room - wu.lib), steady: 0 };
  const c = cd.min;
  return { wu: Math.max(wu.min, Math.round(room - c)), cd: c, steady: 0 };
}

/** VO2 micro-intervals in taper week 1: 75% of the library's 15 x 30:30
 *  (Goeringer), 30 s @ 118% FTP / 30 s @ 50% FTP (describeBikeSession
 *  vo2_micros variant 1). */
export const TRI_TAPER_MICROS_REPS = Math.round(TRI_TAPER_QUALITY_WORK_SHARE * MICROS_REF_REPS);
/** Minutes a taper micro-interval ride needs for `reps` (one minute each)
 *  inside the shortest warm-up and cool-down. */
export function triTaperMicrosNeedMin(reps = TRI_TAPER_MICROS_REPS): number {
  return BIKE_WU.min + BIKE_CD.min + reps;
}
/** Fewest micro-interval reps: Dave Scott's 4-min floor. */
export const TRI_TAPER_MICROS_MIN_REPS = TRI_TAPER_MAIN_SET_MIN_MIN;

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
  const reps = Math.max(1, Math.min(TRI_TAPER_MICROS_REPS, minutes - BIKE_WU.min - BIKE_CD.min));
  const { wu, cd, steady } = fitWuCd(minutes, reps, BIKE_WU, BIKE_CD);
  const on = bikeTargetLabel(input.ftp, input.hasPowerMeter, 1.18, 'bike_vo2_micros');
  const off = bikeTargetLabel(input.ftp, input.hasPowerMeter, 0.50, 'bike_vo2_micros');
  const steadyLabel = bikeTargetLabel(input.ftp, input.hasPowerMeter, BIKE_STEADY_PCT_FTP, 'bike_endurance');
  const then = steady > 0 ? `, then ${steady}min steady @ ${steadyLabel}` : '';
  return { ...base, d: `${wu}min Warm up. Main: ${reps}×(30s @ ${on} / 30s @ ${off})${then}. ${cd}min Cool down.` };
}

/** Threshold run in taper week 1: 75% of the tri library's 4 x 6 min (3 x 6
 *  min, 90 s jog; Goeringer), the reps the session holds after the shortest
 *  warm-up and cool-down, at least one (6 min, above Dave Scott's 4-min
 *  floor). */
export const TRI_TAPER_THRESHOLD_REPS = Math.round(TRI_TAPER_QUALITY_WORK_SHARE * THRESHOLD_REF_REPS);
function thresholdMainMin(reps: number): number {
  return reps * THRESHOLD_REP_MIN + Math.max(0, reps - 1) * THRESHOLD_REC_MIN;
}
/** Minutes a taper threshold run of `reps` needs, rounded up to the run
 *  library's 5-min step (tri runs of 30 min or more are written to the
 *  nearest 5 min). */
export function triTaperThresholdRunNeedMin(reps = TRI_TAPER_THRESHOLD_REPS): number {
  const m = RUN_WU.min + RUN_CD.min + thresholdMainMin(reps);
  return m >= 30 ? Math.ceil(m / 5) * 5 : Math.ceil(m);
}
export function triTaperThresholdRunDesc(minutes: number, thresholdLabel: string, easyLabel: string): string {
  const m = Math.round(minutes);
  let reps = TRI_TAPER_THRESHOLD_REPS;
  while (reps > 1 && triTaperThresholdRunNeedMin(reps) > m) reps--;
  const { wu, cd, steady } = fitWuCd(m, thresholdMainMin(reps), RUN_WU, RUN_CD);
  const then = steady > 0 ? `, then ${steady}min @ ${easyLabel}` : '';
  return `${wu}min warm up @ ${easyLabel}. ${reps}×${THRESHOLD_REP_MIN}min @ ${thresholdLabel}, 90s jog recovery${then}. ${cd}min cool down.`;
}

/** Swim quality in taper week 1: 75% of the reps the library's CSS (100 m
 *  repeats) or speed (50 m repeats) session holds at the reference length
 *  (describeSwimSession variant 0), as many as the session holds after its
 *  200 m warm-up and cool-down, at least Dave Scott's 4 min of work. */
export interface TriTaperSwimPlan { repM: number; targetReps: number; minReps: number; needMin: number }
export function triTaperSwimPlan(
  kind: 'threshold' | 'speed', refMinutes: number, skill: TriSkillSlider, css?: number,
): TriTaperSwimPlan {
  const refM = estimateDistanceMetres(refMinutes, skill, css);
  const repM = kind === 'threshold' ? 100 : 50;
  const refReps = kind === 'threshold'
    ? Math.min(16, Math.max(6, Math.round(Math.max(400, refM - SWIM_WU_CD_M) / 100)))
    : Math.min(12, Math.max(6, Math.round(Math.max(300, refM - SWIM_WU_CD_M) / 50)));
  const targetReps = Math.round(TRI_TAPER_QUALITY_WORK_SHARE * refReps);
  const minReps = Math.min(targetReps, Math.ceil(TRI_TAPER_MAIN_SET_MIN_MIN / swimMinutes(repM, css, skill)));
  return { repM, targetReps, minReps, needMin: swimMinutes(SWIM_WU_CD_M + targetReps * repM, css, skill) };
}
export function triTaperSwimMinMin(plan: TriTaperSwimPlan, skill: TriSkillSlider, css?: number): number {
  return swimMinutes(SWIM_WU_CD_M + plan.minReps * plan.repM, css, skill);
}
export function triTaperQualitySwim(input: {
  kind: 'threshold' | 'speed'; minutes: number; plan: TriTaperSwimPlan; skill: TriSkillSlider; css?: number;
  weekIndex: number; totalWeeks: number; slotIndex: number;
}): Workout {
  const { kind, plan, skill, css } = input;
  const minutes = Math.max(TRI_TAPER_SESSION_FLOOR_MIN, Math.round(input.minutes));
  const base = generateSwimSession({
    phase: 'taper', skill, weekIndex: input.weekIndex, totalWeeks: input.totalWeeks, targetMinutes: minutes,
    kind, cssSecPer100m: css, slotIndex: input.slotIndex, variantIndex: 0,
  });
  const totalM = Math.max(SWIM_WU_CD_M + plan.repM, estimateDistanceMetres(minutes, skill, css));
  const reps = Math.max(1, Math.min(plan.targetReps, Math.floor((totalM - SWIM_WU_CD_M) / plan.repM)));
  const steadyM = totalM - SWIM_WU_CD_M - reps * plan.repM;
  const hint = kind === 'threshold'
    ? (css ? ` @ ${fmtSwimPace(css)}/100m (CSS)` : '')
    : (css ? ` @ ${fmtSwimPace(css - 5)}/100m` : ' (CSS −5s/100m)');
  const main = kind === 'threshold' ? `${reps}×100m${hint}, 15s rest` : `${reps}×50m fast${hint}, 30s rest`;
  const steady = steadyM > 0 ? ` Then ${steadyM}m steady.` : '';
  return { ...base, d: `${totalM}m total. 200m Warm up. Main: ${main}.${steady} 200m Cool down.` };
}

function fmtSwimPace(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Day before the race, ride: an easy spin with Allen's 5 x 10 s pickups. */
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

/** Day before the race, run: an easy jog with Allen's 5 x 10 s pickups. Its
 *  load is the canonical easy rate (plannedTssPerMin, the tri run shares)
 *  to a tenth: whole-number rounding moves a 5 to 7 min jog off the easy rate
 *  (5 min: 4.6 TSS would read 5, 1.0 a minute; Load Currency Law anchor 1). */
export function triDayBeforeRun(minutes: number, easyLabel: string): Workout {
  const m = Math.round(minutes);
  const total = m * plannedTssPerMin('easy');
  const aerobic = Math.round(total * TRI_RUN_LOAD_SHARES.easy.aerobic * 10) / 10;
  return {
    n: 'Pre-race jog',
    d: `${m}min easy jog @ ${easyLabel}, with ${TRI_DAY_BEFORE_PICKUP_REPS}×${TRI_DAY_BEFORE_PICKUP_SEC}s pickups to race pace. Activation only.`,
    t: 'easy', discipline: 'run', r: 4, rpe: 4,
    aerobic, anaerobic: Math.round((total - aerobic) * 10) / 10,
    estimatedDurationMin: m,
    taperRole: 'day_before',
  };
}

/** Byrn's race-week brick: steady bike then a short run, 2 x 90 s builds to
 *  race effort in each leg. RPE: the higher of its legs' library RPEs (an
 *  endurance ride in the taper, rpeForBike; an easy run, 4). */
export function triRaceWeekBrick(ctx: TriTaperSessionCtx): Workout {
  const runMin = TRI_RACE_WEEK_BRICK_RUN_MIN;
  const bikeMin = TRI_RACE_WEEK_BRICK_TOTAL_MIN - runMin;
  const reps = TRI_RACE_WEEK_BRICK_BUILD_REPS;
  const steady = bikeTargetLabel(ctx.ftp, ctx.hasPowerMeter, BIKE_STEADY_PCT_FTP, 'bike_endurance');
  const pm = ctx.hasPowerMeter && ctx.ftp;
  // Steady legs with short builds: the bike leg at the endurance rate, the
  // run leg at the easy rate (the builds are 3 of each leg's minutes).
  const load = addLoads(loadForBike('endurance', bikeMin), loadForTriRun('easy', runMin)!);
  const rpe = Math.max(rpeForBike('endurance', 'taper'), 4);
  return {
    n: 'Brick: bike + run',
    t: 'brick',
    discipline: 'bike',
    r: rpe, rpe,
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
  /** The athlete's per-day minute caps (their normal week's weekday and
   *  weekend hours, triDayCaps). Hard caps, with the scheduler's 15-min
   *  tolerance. */
  dayCapMin?: Record<number, number>;
  ctx: TriTaperSessionCtx;
  /** Aerobic session builders (the engine's own swim, bike and run). */
  aerobic: (d: TriDisc, minutes: number, slot: number) => Workout;
  dayBeforeRide: (minutes: number) => Workout;
  /** The week before race week's swim, bike and run minutes (a one-week
   *  taper): race week never holds more. */
  maxTotalMin?: number;
}

const loadOf = (w: Workout) => (w.aerobic ?? 0) + (w.anaerobic ?? 0);

interface ComposedWeek {
  /** Training sessions by weekday (the day-before activations excluded). */
  byDay: Record<number, Workout[]>;
  /** Minutes placed per discipline (training sessions). */
  placed: Record<TriDisc, number>;
}

/**
 * Compose race week from the reference week (planning side). Budget per
 * discipline = fraction x reference minutes. Steps:
 *   1. Long course: Byrn's brick on the opener-window day nearest the race
 *      (3 days out for a Sunday race), when the bike and run budgets and that
 *      day's cap hold it.
 *   2. The day before: the activation's lower bounds (a 20-min ride, a 5-min
 *      run) come off the budgets first. Two days out stays empty (rest).
 *   3. Openers on the opener-window days (PRIMER_MIN_DAYS_OUT to
 *      PRIMER_MAX_DAYS_OUT), one per day, as many 90 s race-pace repeats as
 *      days to go (Friel), fewer when the discipline's budget is thin, never
 *      below Dave Scott's 4-min floor (3 repeats); a discipline whose budget
 *      cannot hold that much has no opener. Each holds its repeats inside the
 *      shortest warm-up and cool-down. Order (an app inference from the order
 *      coaches taper volume, run first and swim last): run, bike, swim; long
 *      course with a brick: run, swim (the brick carries the bike's builds);
 *      cycling: a ride on every window day.
 *   4. The rest of each budget split into aerobic sessions: the reference
 *      count less the brick and the openers, sized at most the reference
 *      week's average session of that discipline (an app inference: race
 *      week holds no session longer than a normal one) and the race-week cap
 *      (TRI_RACE_WEEK_SESSION_CAP_MIN), and the nearest whole number of
 *      TRI_TAPER_SESSION_FLOOR_MIN sessions at most. Then, while race week
 *      holds fewer than TRI_TAPER_MIN_SESSION_SHARE of the reference
 *      sessions (the race counted as one, as it takes the long session's
 *      slot, and each day-before activation as one), one more session in the
 *      discipline with the most minutes per session left; frequency wins over
 *      the floor. Every discipline the plan has keeps a session (an
 *      activation counts).
 *   5. Aerobic sessions, biggest first, go to the days nearest 6 days out
 *      (the Monday of a Sunday race), one per discipline per day, at most
 *      TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY training sessions a day, within the
 *      athlete's day caps. A session no free day has room for is cut to the
 *      largest room left (at least the floor) or left out.
 *   6. The day before is sized last: the ride and run at their lower bounds,
 *      the run dropped when the two would outweigh (minutes or load) the
 *      lightest earlier training day, then both grown toward their caps
 *      (30 and 10 min) only with budget left unplaced and while the day stays
 *      the lightest.
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
  // Aerobic days: nearest 6 days out first (the Monday of a Sunday race),
  // ties to the day further out, so a Monday to Wednesday race fills the days
  // next to its opener window before its earliest days.
  const anchor = PRIMER_MAX_DAYS_OUT + 1;
  const aerobicDays = [...train].sort((a, b) =>
    (Math.abs(dOut(a) - anchor) - Math.abs(dOut(b) - anchor)) || (dOut(b) - dOut(a)));
  const capOf = (dow: number) => inp.dayCapMin?.[dow];
  const room = (dow: number, dayMin: Record<number, number>) => {
    const c = capOf(dow);
    return c === undefined ? Infinity : c + DAY_CAP_TOLERANCE_MIN - dayMin[dow];
  };
  const floorMin = TRI_TAPER_SESSION_FLOOR_MIN;
  const avgOf = (d: TriDisc) => (ref.counts[d] > 0 ? ref.minutes[d] / ref.counts[d] : Infinity);
  const maxSize = (d: TriDisc) => Math.min(avgOf(d), TRI_RACE_WEEK_SESSION_CAP_MIN[d]);

  // 1. Brick (long course).
  const brickBike = TRI_RACE_WEEK_BRICK_TOTAL_MIN - TRI_RACE_WEEK_BRICK_RUN_MIN;
  const brickCandidate = window.length > 0 ? window[window.length - 1] : undefined;
  const brickDow = inp.longCourse && present.bike && present.run && brickCandidate != null
    && B.bike >= brickBike && B.run >= TRI_RACE_WEEK_BRICK_RUN_MIN
    && (capOf(brickCandidate) === undefined || capOf(brickCandidate)! + DAY_CAP_TOLERANCE_MIN >= TRI_RACE_WEEK_BRICK_TOTAL_MIN)
    ? brickCandidate
    : undefined;

  const build = (dbRide: number, dbRun: number): ComposedWeek => {
    const used: Record<TriDisc, number> = { swim: 0, bike: dbRide, run: dbRun };
    const fixedCount: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
    const byDay: Record<number, Workout[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    const occ: Record<number, Set<string>> = { 0: new Set(), 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set(), 6: new Set() };
    const dayMin: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const placed: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
    const place = (dow: number, w: Workout, discs: TriDisc[]) => {
      byDay[dow].push({ ...w, dayOfWeek: dow, dayName: DAY_NAMES[dow] });
      for (const d of discs) occ[dow].add(d);
      dayMin[dow] += w.estimatedDurationMin ?? 0;
    };
    const free = (dow: number, d: TriDisc) => !occ[dow].has(d) && byDay[dow].length < TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY;

    if (brickDow != null) {
      place(brickDow, triRaceWeekBrick(ctx), ['bike', 'run']);
      used.bike += brickBike;
      used.run += TRI_RACE_WEEK_BRICK_RUN_MIN;
      placed.bike += brickBike;
      placed.run += TRI_RACE_WEEK_BRICK_RUN_MIN;
      fixedCount.bike++;
    }

    // 3. Openers.
    const openerDays = window.filter(dow => dow !== brickDow);
    const order: TriDisc[] = inp.singleSport
      ? openerDays.map(() => 'bike' as TriDisc)
      : (brickDow != null ? (['run', 'swim'] as TriDisc[]) : (['run', 'bike', 'swim'] as TriDisc[]));
    const openers: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
    const openerPlan: Array<{ d: TriDisc; dow: number; reps: number; minutes: number }> = [];
    // The disciplines, in order, whose budget holds a minimal opener; they take
    // the window days nearest the race (a thin week's single opener sits 3
    // days out, so the last session before race day stays within 3 days).
    const chosen: TriDisc[] = [];
    {
      const trial: Record<TriDisc, number> = { ...used };
      for (const d of order) {
        if (!present[d] || chosen.length >= openerDays.length) continue;
        const min = Math.max(floorMin, triRacePaceNeedMin(d, TRI_RACE_PACE_MIN_REPS, ctx));
        if (B[d] - trial[d] >= min - 0.5) { chosen.push(d); trial[d] += min; }
      }
    }
    const days = openerDays.slice(openerDays.length - chosen.length);
    for (let i = 0; i < chosen.length; i++) {
      const d = chosen[i];
      const dow = days[i];
      if (room(dow, dayMin) < triRacePaceNeedMin(d, TRI_RACE_PACE_MIN_REPS, ctx)) continue;
      const avail = B[d] - used[d];
      let reps = Math.min(dOut(dow), TRI_RACE_PACE_MAX_REPS);
      while (reps > TRI_RACE_PACE_MIN_REPS && (triRacePaceNeedMin(d, reps, ctx) > avail + 0.5 || triRacePaceNeedMin(d, reps, ctx) > room(dow, dayMin))) reps--;
      const minutes = Math.min(TRI_RACE_WEEK_SESSION_CAP_MIN[d], Math.max(floorMin, Math.ceil(triRacePaceNeedMin(d, reps, ctx))));
      openerPlan.push({ d, dow, reps, minutes });
      used[d] += minutes;
      openers[d]++;
    }
    // Race week holds at least one opener: the run's (or the discipline the
    // order reaches first) on the window day nearest the race, at the 4-min
    // floor, when no budget held one.
    if (openerPlan.length === 0 && openerDays.length > 0) {
      const d = order.find(x => present[x]);
      if (d) {
        const minutes = Math.max(floorMin, Math.ceil(triRacePaceNeedMin(d, TRI_RACE_PACE_MIN_REPS, ctx)));
        openerPlan.push({ d, dow: openerDays[openerDays.length - 1], reps: TRI_RACE_PACE_MIN_REPS, minutes });
        used[d] += minutes;
        openers[d]++;
      }
    }
    for (const o of openerPlan) {
      place(o.dow, triRacePaceSession({ discipline: o.d, minutes: o.minutes, reps: o.reps, role: 'opener', ctx }), [o.d]);
      placed[o.d] += o.minutes;
    }

    // 4. Aerobic session counts and sizes.
    const freeDays = (d: TriDisc) => train.filter(dow => free(dow, d)).length;
    const slotsLeft = () => train.reduce((a, dow) => a + Math.max(0, TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY - byDay[dow].length), 0);
    const rem: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
    const n: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
    const activation: Record<TriDisc, number> = { swim: 0, bike: dbRide > 0 ? 1 : 0, run: dbRun > 0 ? 1 : 0 };
    for (const d of DISCS) {
      if (!present[d]) continue;
      rem[d] = Math.max(0, B[d] - used[d]);
      let k = Math.max(0, ref.counts[d] - fixedCount[d] - openers[d]);
      k = Math.max(k, Math.ceil(rem[d] / maxSize(d)));
      // The count that lands nearest the fraction: as many sessions as fit at
      // the floor, or for less than one floor's worth, one floor-length
      // session when that overshoots by less than leaving the minutes out
      // undershoots.
      k = Math.min(k, rem[d] >= floorMin ? Math.floor(rem[d] / floorMin) : (rem[d] * 2 > floorMin ? 1 : 0));
      k = Math.min(k, freeDays(d));
      const hasRun = d === 'run' && brickDow != null;
      if (fixedCount[d] + openers[d] + activation[d] + k === 0 && !hasRun) k = Math.min(1, freeDays(d)); // no discipline at zero
      n[d] = Math.max(0, k);
    }
    // Slots: at most two training sessions a day, one per discipline. The
    // pending sessions fit when a flow from disciplines to days carries them
    // all (each day at most its free slots, each discipline at most one per
    // day). Sessions that cannot fit come off the discipline with the least
    // per session, never its last.
    const placeable = (pend: Record<TriDisc, number>) => slotFlow(pend, d => train.filter(dow => free(dow, d)), dow => TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY - byDay[dow].length);
    const fits = (pend: Record<TriDisc, number>) => placeable(pend).total >= pend.swim + pend.bike + pend.run;
    const keeps = (d: TriDisc) => fixedCount[d] + openers[d] + activation[d] + n[d] - 1 > 0 || (d === 'run' && brickDow != null);
    while (!fits(n)) {
      const flow = placeable(n).byDisc;
      const d = DISCS.filter(x => n[x] > flow[x] && keeps(x)).sort((a, b) => (rem[a] / n[a]) - (rem[b] / n[b]))[0]
        ?? DISCS.filter(x => n[x] > 0 && keeps(x)).sort((a, b) => (rem[a] / n[a]) - (rem[b] / n[b]))[0];
      if (!d) break;
      n[d]--;
    }
    const need = Math.ceil(TRI_TAPER_MIN_SESSION_SHARE * ref.total) - 1; // the race is one session
    const fixedTotal = Object.values(byDay).reduce((a, l) => a + l.length, 0) + activation.bike + activation.run;
    const total = () => fixedTotal + n.swim + n.bike + n.run;
    while (total() < need && n.swim + n.bike + n.run < slotsLeft()) {
      let best: TriDisc | null = null;
      let bestOver = Infinity;
      let bestSize = -Infinity;
      for (const d of DISCS) {
        if (!present[d] || !fits({ ...n, [d]: n[d] + 1 })) continue;
        // Frequency wins over the floor: the added session is floor length when
        // the budget is thinner, from the discipline it overshoots least
        // (then the one with the most minutes per session left).
        const over = Math.max(0, (n[d] + 1) * floorMin - rem[d]);
        const size = rem[d] / (n[d] + 1);
        if (over < bestOver - 1e-9 || (Math.abs(over - bestOver) < 1e-9 && size > bestSize)) { best = d; bestOver = over; bestSize = size; }
      }
      if (!best) break;
      n[best]++;
    }
    // Openers share the discipline's budget with its aerobic sessions: an
    // opener takes the equal share when that is more than its repeats need
    // (the steady minutes around them grow, the repeats stay), within the
    // race-week cap and its day's room.
    for (const d of DISCS) {
      if (openers[d] === 0) continue;
      const pre = rem[d] + openerPlan.filter(o => o.d === d).reduce((a, o) => a + o.minutes, 0);
      const share = Math.min(maxSize(d), pre / (openers[d] + n[d]));
      for (const o of openerPlan) {
        if (o.d !== d) continue;
        const grown = Math.floor(Math.min(TRI_RACE_WEEK_SESSION_CAP_MIN[d], share, o.minutes + room(o.dow, dayMin)));
        if (grown <= o.minutes) continue;
        byDay[o.dow] = byDay[o.dow].map(w => (w.taperRole === 'opener' && w.discipline === d && w.t !== 'brick'
          ? { ...triRacePaceSession({ discipline: d, minutes: grown, reps: o.reps, role: 'opener', ctx }), dayOfWeek: o.dow, dayName: DAY_NAMES[o.dow] }
          : w));
        dayMin[o.dow] += grown - o.minutes;
        placed[d] += grown - o.minutes;
        rem[d] = Math.max(0, rem[d] - (grown - o.minutes));
        o.minutes = grown;
      }
    }
    const size: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
    for (const d of DISCS) {
      if (n[d] === 0) continue;
      size[d] = Math.max(floorMin, Math.round(Math.min(maxSize(d), rem[d] / n[d])));
    }

    // 5. Aerobic sessions on the days nearest 6 days out: each step places
    // the session whose discipline has the fewest free days left (so no
    // discipline is crowded out of the two-a-day slots), biggest first among
    // equals.
    const pending: Array<{ d: TriDisc; min: number; slot: number }> = [];
    for (const d of DISCS) for (let i = 0; i < n[d]; i++) pending.push({ d, min: size[d], slot: openers[d] + i });
    const discOrder: Record<TriDisc, number> = { bike: 0, run: 1, swim: 2 };
    const aerobicPlaced: Array<{ dow: number; d: TriDisc; slot: number }> = [];
    const pendingCount = () => {
      const c: Record<TriDisc, number> = { swim: 0, bike: 0, run: 0 };
      for (const q of pending) c[q.d]++;
      return c;
    };
    while (pending.length > 0) {
      pending.sort((a, b) => (freeDays(a.d) - freeDays(b.d)) || (b.min - a.min) || (discOrder[a.d] - discOrder[b.d]));
      const p = pending.shift()!;
      // Days that leave the other pending sessions a place (the slot flow).
      const rest = pendingCount();
      const keepsRest = (dow: number) => {
        occ[dow].add(p.d);
        byDay[dow].push({} as Workout);
        const ok = fits(rest);
        byDay[dow].pop();
        occ[dow].delete(p.d);
        return ok;
      };
      const open = aerobicDays.filter(dow => free(dow, p.d));
      const days = open.filter(keepsRest).length > 0 ? open.filter(keepsRest) : open;
      if (days.length === 0) continue;
      const roomy = days.find(dow => room(dow, dayMin) >= p.min);
      let dow = roomy;
      let minutes = p.min;
      if (dow === undefined) {
        // Cut to the largest room left, at least the floor; else left out.
        const best = days.reduce((b, x) => (room(x, dayMin) > room(b, dayMin) ? x : b), days[0]);
        if (room(best, dayMin) < floorMin) continue;
        dow = best;
        minutes = Math.floor(room(best, dayMin));
      }
      place(dow, inp.aerobic(p.d, minutes, p.slot), [p.d]);
      placed[p.d] += minutes;
      aerobicPlaced.push({ dow, d: p.d, slot: p.slot });
    }

    // Never heavier than the week before (race-week rule of 2026-10-08): a
    // one-week taper whose week before is a deload can sit near it, and the
    // floors can tip race week over. Aerobic sessions come down toward the
    // floor, longest first, then the shortest go, while frequency holds and
    // every discipline keeps a session.
    if (inp.maxTotalMin != null) {
      const totalMin = () => Object.values(byDay).flat().reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0) + dbRide + dbRun;
      const sessionsNow = () => Object.values(byDay).reduce((a, l) => a + l.length, 0) + activation.bike + activation.run;
      const find = (a: { dow: number; d: TriDisc; slot: number }) => byDay[a.dow].findIndex(w => !w.taperRole && w.t !== 'brick' && (w.discipline ?? 'run') === a.d);
      let over = totalMin() - inp.maxTotalMin;
      while (over > 0.5) {
        const cand = aerobicPlaced
          .map(a => ({ a, i: find(a) }))
          .filter(x => x.i >= 0 && (byDay[x.a.dow][x.i].estimatedDurationMin ?? 0) > floorMin)
          .sort((x, y) => (byDay[y.a.dow][y.i].estimatedDurationMin ?? 0) - (byDay[x.a.dow][x.i].estimatedDurationMin ?? 0))[0];
        if (!cand) break;
        const cur = byDay[cand.a.dow][cand.i].estimatedDurationMin ?? 0;
        const next = Math.max(floorMin, Math.ceil(cur - over));
        byDay[cand.a.dow][cand.i] = { ...inp.aerobic(cand.a.d, next, cand.a.slot), dayOfWeek: cand.a.dow, dayName: DAY_NAMES[cand.a.dow] };
        dayMin[cand.a.dow] -= cur - next;
        placed[cand.a.d] -= cur - next;
        over -= cur - next;
      }
      while (over > 0.5) {
        const cand = aerobicPlaced
          .map(a => ({ a, i: find(a) }))
          .filter(x => x.i >= 0)
          .filter(x => {
            const d = x.a.d;
            const left = Object.values(byDay).flat().filter(w => (w.discipline ?? 'run') === d || (d === 'run' && w.t === 'brick')).length - 1 + activation[d];
            return left > 0 && sessionsNow() - 1 >= need;
          })
          .sort((x, y) => (byDay[x.a.dow][x.i].estimatedDurationMin ?? 0) - (byDay[y.a.dow][y.i].estimatedDurationMin ?? 0))[0];
        if (!cand) break;
        const cur = byDay[cand.a.dow][cand.i].estimatedDurationMin ?? 0;
        byDay[cand.a.dow].splice(cand.i, 1);
        dayMin[cand.a.dow] -= cur;
        placed[cand.a.d] -= cur;
        over -= cur;
        aerobicPlaced.splice(aerobicPlaced.indexOf(cand.a), 1);
      }
    }
    return { byDay, placed };
  };

  // 6. The day before.
  if (dbDow == null) return flatten(build(0, 0).byDay, null, []);
  let dbRide = present.bike && B.bike - (brickDow != null ? brickBike : 0) >= TRI_DAY_BEFORE_RIDE_MIN_MIN ? TRI_DAY_BEFORE_RIDE_MIN_MIN : 0;
  let dbRun = present.run && !inp.singleSport ? TRI_DAY_BEFORE_RUN_MIN_MIN : 0;
  const dayBefore = (ride: number, run: number) => [
    ...(ride > 0 ? [inp.dayBeforeRide(ride)] : []),
    ...(run > 0 ? [triDayBeforeRun(run, ctx.easyLabel)] : []),
  ];
  const lightest = (wk: ComposedWeek) => {
    const days = Object.keys(wk.byDay).map(Number).filter(dow => dow !== dbDow && wk.byDay[dow].length > 0);
    const all = days.flatMap(dow => wk.byDay[dow]);
    return {
      min: Math.min(Infinity, ...days.map(dow => wk.byDay[dow].reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0))),
      load: Math.min(Infinity, ...days.map(dow => wk.byDay[dow].reduce((a, w) => a + loadOf(w), 0))),
      // The week's longest training session: no activation is longer.
      longest: Math.max(0, ...all.map(w => w.estimatedDurationMin ?? 0)),
    };
  };
  const fitsUnder = (ride: number, run: number, L: { min: number; load: number; longest: number }) => {
    const ws = dayBefore(ride, run);
    const longestOk = L.longest === 0 || (ride <= L.longest && run <= L.longest);
    return ride + run <= L.min && ws.reduce((a, w) => a + loadOf(w), 0) <= L.load && longestOk;
  };
  let wk = build(dbRide, dbRun);
  let L = lightest(wk);
  if (dbRun > 0 && !fitsUnder(dbRide, dbRun, L)) {
    dbRun = 0;
    wk = build(dbRide, dbRun);
    L = lightest(wk);
  }
  // The ride sits at its lower bound, inside every earlier training session
  // (each at least the floor, none lighter per minute than an endurance ride);
  // it comes down only for a week whose sessions were cut below it.
  while (dbRide > 0 && !fitsUnder(dbRide, dbRun, L)) {
    dbRide = dbRide > TRI_DAY_BEFORE_RIDE_MIN_MIN ? TRI_DAY_BEFORE_RIDE_MIN_MIN : 0;
  }
  // Grow toward the caps with budget left unplaced, while the day stays the
  // lightest.
  const left = (d: TriDisc) => Math.max(0, Math.floor(B[d] - wk.placed[d] - (d === 'bike' ? dbRide : d === 'run' ? dbRun : 0)));
  const trainingMin = Object.values(wk.byDay).flat().reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
  const underWeekBefore = (ride: number, run: number) => inp.maxTotalMin == null || trainingMin + ride + run <= inp.maxTotalMin;
  let spareBike = left('bike');
  while (dbRide > 0 && dbRide < TRI_DAY_BEFORE_RIDE_MAX_MIN && spareBike > 0 && fitsUnder(dbRide + 1, dbRun, L) && underWeekBefore(dbRide + 1, dbRun)) { dbRide++; spareBike--; }
  let spareRun = left('run');
  while (dbRun > 0 && dbRun < TRI_DAY_BEFORE_RUN_MAX_MIN && spareRun > 0 && fitsUnder(dbRide, dbRun + 1, L) && underWeekBefore(dbRide, dbRun + 1)) { dbRun++; spareRun--; }
  return flatten(wk.byDay, dbDow, dayBefore(dbRide, dbRun));
}

/**
 * Max flow from disciplines to race-week days: each discipline sends its
 * pending sessions, each may go to a day in `daysFor(d)` once, each day takes
 * at most `capOf(day)`. Returns the sessions carried in total and per
 * discipline.
 */
function slotFlow(
  pend: Record<TriDisc, number>,
  daysFor: (d: TriDisc) => number[],
  capOf: (dow: number) => number,
): { total: number; byDisc: Record<TriDisc, number> } {
  // Nodes: 0 source, 1-3 disciplines, 4-10 days, 11 sink.
  const N = 12;
  const cap: number[][] = Array.from({ length: N }, () => new Array(N).fill(0));
  DISCS.forEach((d, i) => {
    cap[0][1 + i] = Math.max(0, pend[d]);
    for (const dow of daysFor(d)) cap[1 + i][4 + dow] = 1;
  });
  for (let dow = 0; dow < 7; dow++) cap[4 + dow][11] = Math.max(0, capOf(dow));
  const flowFrom = new Array(3).fill(0);
  let total = 0;
  for (;;) {
    const prev = new Array(N).fill(-1);
    prev[0] = 0;
    const queue = [0];
    while (queue.length > 0 && prev[11] < 0) {
      const u = queue.shift()!;
      for (let v = 0; v < N; v++) if (prev[v] < 0 && cap[u][v] > 0) { prev[v] = u; queue.push(v); }
    }
    if (prev[11] < 0) break;
    for (let v = 11; v !== 0; v = prev[v]) { cap[prev[v]][v] -= 1; cap[v][prev[v]] += 1; }
    let v = 11;
    while (prev[v] !== 0) v = prev[v];
    flowFrom[v - 1] += 1;
    total += 1;
  }
  return { total, byDisc: { swim: flowFrom[0], bike: flowFrom[1], run: flowFrom[2] } };
}

function flatten(byDay: Record<number, Workout[]>, dbDow: number | null, dayBefore: Workout[]): Workout[] {
  const out: Workout[] = [];
  for (let dow = 0; dow < 7; dow++) {
    out.push(...byDay[dow]);
    if (dow === dbDow) for (const w of dayBefore) out.push({ ...w, dayOfWeek: dow, dayName: DAY_NAMES[dow] });
  }
  return out;
}
