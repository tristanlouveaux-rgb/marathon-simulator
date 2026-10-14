/**
 * Triathlon and cycling race-taper rules (Tristan, 2026-10-13; tri-taper.ts;
 * SCIENCE_LOG "Triathlon and cycling taper rebuild"), checked on plans built
 * through the onboarding initializers across distances (T100 included) and
 * cycling x plan lengths 2 to 24 weeks x low, typical and high hours x race
 * weekday x weekday hours (the default 40% split, and 0, 0.5 and 1 h).
 *
 * Every race weekday (Sunday, Monday, Thursday, Friday, Saturday):
 *   - the day before holds only a short activation (ride 20-30 min, run 5-10
 *     min; Allen, Byrn, the Triathlete guide), never the week's longest
 *     session and never heavier (minutes or load) than any earlier training
 *     day of race week; two days out is empty;
 *   - race-week sessions stay under their race-week caps (run 45 min, Byrn;
 *     bike 90 min, Allen; swim 45 min, Byrn), at most two training sessions a
 *     day, nothing on or after race day;
 *   - no discipline at zero in any taper week (the race window's cut of taper
 *     week 1 included), and no discipline twice on one day;
 *   - race-week gym only on a day holding fewer than two sessions.
 * Sunday and Monday races (no race-window cut, ISSUE-364), in addition:
 *   - taper length by race distance (sprint 1, others 2, cycling 2), race week
 *     only under 8 h of reference-week training (Goeringer);
 *   - delivered minutes per discipline land on the fraction of the reference
 *     week (0.55 then 0.30; 0.55 for a one-week taper), within one
 *     floor-length session, unless the discipline's race-week sessions all
 *     sit at their cap, every training day is full, or a one-week taper's
 *     race week sits at the week before's minutes;
 *   - no taper deeper than the 41-60% band on average (mean fraction at least
 *     0.40), with the same exceptions;
 *   - at least 80% of the reference week's sessions in every taper week (the
 *     race and the day-before activations counted in race week; Mujika 2011),
 *     and no discipline at zero;
 *   - quality kept: taper week 1 keeps the reference week's quality count per
 *     discipline, short course at 75% of the reference reps (Goeringer) unless
 *     the discipline has no steady minutes left, long course 3 to 8 x 90 s of
 *     race-pace work (Dave Scott's 4 to 12 min sets); race week holds an
 *     opener; long course and cycling never above race intensity;
 *   - TRI_GENERATOR_VERSION bumped so stored plans regenerate.
 * Thursday to Saturday races keep the structural rules and the no-zero rule.
 * Their volume and frequency gaps (the race window cuts taper week 1, race
 * week has one to three training days) are pinned below with one case per
 * weekday, as is a race week above a thin week before.
 */
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('alert', vi.fn());

import { initializeTriathlonSimulator } from './initialization.triathlon';
import { initializeCyclingSimulator } from './initialization.cycling';
import { getState, resetState } from './store';
import { planTrainingWeeks, raceWeekLayout, triPlanTaperWeeks } from '@/workouts/race-week-layout';
import { TRI_GENERATOR_VERSION, triTaperOpts, triTaperReference } from '@/workouts/plan_engine.triathlon';
import {
  computeTriPlanPhases,
  DEFAULT_WEEKLY_PEAK_HOURS,
  TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION,
  TRI_RACE_WEEK_FRACTION,
  TRI_TAPER_FIRST_WEEK_FRACTION,
  TRI_TAPER_WEEKS_BY_DISTANCE,
  CYCLING_TAPER_WEEKS,
} from '@/constants/triathlon-constants';
import {
  TRI_TAPER_SESSION_FLOOR_MIN,
  TRI_DAY_BEFORE_RIDE_MAX_MIN,
  TRI_DAY_BEFORE_RUN_MAX_MIN,
  TRI_RACE_PACE_MAX_REPS,
  TRI_RACE_PACE_MIN_REPS,
  TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY,
  TRI_RACE_WEEK_SESSION_CAP_MIN,
  TRI_TAPER_MICROS_REPS,
  TRI_TAPER_THRESHOLD_REPS,
  bikeKindForIntensity,
  triRaceBikeIntensity,
  triTaperMicrosNeedMin,
  triTaperSwimPlan,
  triTaperThresholdRunNeedMin,
} from '@/workouts/tri-taper';
import { isLongRun } from '@/workouts/long-run';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week, Workout } from '@/types';
import type { TriathlonDistance, TriSkillSlider } from '@/types/triathlon';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorageMock.clear(); });
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

function at(localIso: string): void {
  process.env.TZ = 'Europe/London';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(localIso));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

type Mode = TriathlonDistance | 'cycling';
type Disc = 'swim' | 'bike' | 'run';
const DISCS: Disc[] = ['swim', 'bike', 'run'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LENGTHS = [2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 20, 24];
// Plans start Monday 12 October 2026 (onboarding that Monday).
const NOW = '2026-10-12T10:00:00';

function hoursFor(mode: Mode): number[] {
  if (mode === 'cycling') return [6, 10, 14];
  const h = DEFAULT_WEEKLY_PEAK_HOURS[mode];
  return [h[1], h[3], h[5]];
}

/** The race date: weekday `dow` (0 = Monday) of plan week `weeks`. */
function raceDay(weeks: number, dow = 6): string {
  const d = new Date(2026, 9, 12 + (weeks - 1) * 7 + dow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface BuildOpts { weekdayHours?: number; gym?: number }

function build(mode: Mode, race: string, hours: number, o: BuildOpts = {}): SimulatorState {
  resetState();
  const ob = {
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', experienceLevel: 'intermediate',
    customRaceDate: race, triTimeAvailableHoursPerWeek: hours,
    ...(o.weekdayHours != null ? { triWeekdayHoursPerWeek: o.weekdayHours } : {}),
    ...(o.gym != null ? { gymSessionsPerWeek: o.gym } : {}),
  };
  if (mode === 'cycling') {
    initializeCyclingSimulator({ ...ob, trainingMode: 'cycling', cyclingDistance: '160km' } as OnboardingState);
  } else {
    initializeTriathlonSimulator({ ...ob, trainingMode: 'triathlon', triDistance: mode } as OnboardingState);
  }
  return getState();
}

/** Swim, bike, run and brick sessions (no commute, no gym). */
const sessions = (wk: Week) => (wk.triWorkouts ?? []).filter(w => w.t !== 'gym' && !w.commute);
const training = (wk: Week) => sessions(wk).filter(w => w.taperRole !== 'day_before');
const loadOf = (ws: Workout[]) => ws.reduce((a, w) => a + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);
const minsOf = (ws: Workout[]) => ws.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);

/** Minutes per discipline, brick legs in their discipline. */
function minutes(ws: Workout[]): Record<Disc, number> {
  const m: Record<Disc, number> = { swim: 0, bike: 0, run: 0 };
  for (const w of ws) {
    if (w.t === 'brick' && w.brickSegments) for (const sg of w.brickSegments) m[sg.discipline as Disc] += sg.durationMin ?? 0;
    else m[(w.discipline ?? 'run') as Disc] += w.estimatedDurationMin ?? 0;
  }
  return m;
}

/** A quality session: a taper race-pace session or opener, a ride above
 *  endurance, a CSS or speed swim, a threshold or VO2 run. */
function isQuality(w: Workout): boolean {
  if (w.taperRole === 'race_pace' || w.taperRole === 'opener') return true;
  if (w.taperRole === 'day_before' || isLongRun(w) || w.t === 'brick') return false;
  if (w.discipline === 'bike') return w.t !== 'bike_endurance';
  if (w.discipline === 'swim') return w.t === 'swim_threshold' || w.t === 'swim_speed';
  return w.t === 'threshold' || w.t === 'vo2';
}

function qualityCounts(wk: Week): Record<Disc, number> {
  const q: Record<Disc, number> = { swim: 0, bike: 0, run: 0 };
  for (const w of sessions(wk)) if (isQuality(w) && w.t !== 'brick') q[(w.discipline ?? 'run') as Disc]++;
  return q;
}

interface Plan {
  s: SimulatorState;
  mode: Mode;
  dow: number;
  tw: number;
  taperStart: number;
  /** The stored reference week (Sunday and Monday races: as generated). */
  refWeek: Week;
  /** The engine's reference minutes and session total. */
  ref: { minutes: Record<Disc, number>; total: number };
  present: Disc[];
}

function plan(mode: Mode, weeks: number, hours: number, dow = 6, o: BuildOpts = {}): Plan {
  const s = build(mode, raceDay(weeks, dow), hours, o);
  const tw = planTrainingWeeks(s);
  let taperStart = tw;
  while (taperStart > 1 && s.wks[taperStart - 2].ph === 'taper') taperStart--;
  const r = triTaperReference(s, tw)!;
  const present = (s.triConfig?.disciplines ?? ['swim', 'bike', 'run']) as Disc[];
  return { s, mode, dow, tw, taperStart, refWeek: s.wks[r.refWeek - 1], ref: { minutes: r.ref.minutes, total: r.ref.total }, present };
}

const MODES: Mode[] = ['sprint', 'olympic', 't100', '70.3', 'ironman', 'cycling'];
/** Weekday hours: the default split (40% of the week), then 0, 0.5 and 1 h
 *  (the setup slider's low end, 0.5 h steps). */
const WEEKDAY_HOURS: Array<number | undefined> = [undefined, 0, 0.5, 1];
const wdTag = (wd: number | undefined) => (wd == null ? 'split' : `wd${wd}`);

/** No discipline at zero in any taper week (Tristan, decision 5). */
function zeroViolations(p: Plan): string[] {
  const out: string[] = [];
  for (let w = p.taperStart; w <= p.tw; w++) {
    for (const d of p.present) {
      const has = sessions(p.s.wks[w - 1]).some(x => (x.discipline ?? 'run') === d || (d === 'run' && x.t === 'brick'));
      if (!has) out.push(`week ${w} no ${d}`);
    }
  }
  return out;
}

/** No discipline twice on one day in any taper week (taper week 1:
 *  spreadTaperDoubles; race week: the composer's one per discipline a day). */
function doubleViolations(p: Plan): string[] {
  const out: string[] = [];
  for (let w = p.taperStart; w <= p.tw; w++) {
    const wk = p.s.wks[w - 1];
    for (let d = 0; d < 7; d++) {
      for (const disc of DISCS) {
        const n = training(wk).filter(x => x.dayOfWeek === d && x.t !== 'brick' && (x.discipline ?? 'run') === disc).length;
        if (n > 1) out.push(`week ${w} ${DOW[d]} ${n} ${disc} sessions`);
      }
    }
  }
  return out;
}

/** Race-week gym takes a day with a slot left (two sessions a day at most,
 *  commutes counted). */
function gymViolations(p: Plan): string[] {
  const rw = p.s.wks[p.tw - 1];
  const out: string[] = [];
  for (const g of (rw.triWorkouts ?? []).filter(w => w.t === 'gym')) {
    const day = (rw.triWorkouts ?? []).filter(w => w.dayOfWeek === g.dayOfWeek && w.taperRole !== 'day_before');
    if (day.length > TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY) out.push(`gym on ${DOW[g.dayOfWeek ?? 0]} with ${day.length - 1} other sessions`);
  }
  return out;
}

/** Rules every race weekday keeps: the day before, two days out, caps. */
function structuralViolations(p: Plan): string[] {
  const out: string[] = [];
  const { s, tw } = p;
  const layout = raceWeekLayout(s.planStartDate!, s.triConfig!.raceDate!)!;
  const rw = s.wks[tw - 1];
  const dOut = (w: Workout) => layout.raceDayIndex - ((tw - 1) * 7 + (w.dayOfWeek ?? 0));
  const train = training(rw);
  const db = sessions(rw).filter(w => w.taperRole === 'day_before');
  const longest = Math.max(0, ...train.map(w => w.estimatedDurationMin ?? 0));
  for (const w of rw.triWorkouts ?? []) {
    const d = dOut(w);
    if (d < 1) out.push(`on or after race day: ${DOW[w.dayOfWeek ?? 0]} ${w.n}`);
    if (d === 2) out.push(`two days out: ${DOW[w.dayOfWeek ?? 0]} ${w.n}`);
    if (d === 1 && w.taperRole !== 'day_before' && !w.commute) out.push(`day before holds ${w.n}`);
  }
  for (const w of db) {
    const cap = w.discipline === 'bike' ? TRI_DAY_BEFORE_RIDE_MAX_MIN : TRI_DAY_BEFORE_RUN_MAX_MIN;
    if ((w.estimatedDurationMin ?? 0) > cap) out.push(`day before ${w.n} ${w.estimatedDurationMin} > ${cap} min`);
    if (longest > 0 && (w.estimatedDurationMin ?? 0) > longest) out.push(`day before ${w.n} is the week's longest`);
  }
  if (db.length > 0) {
    for (let d = 0; d < 7; d++) {
      const day = train.filter(w => w.dayOfWeek === d);
      if (day.length === 0) continue;
      if (minsOf(db) > minsOf(day)) out.push(`day before ${minsOf(db)} min outweighs ${DOW[d]} ${minsOf(day)} min`);
      if (loadOf(db) > loadOf(day)) out.push(`day before load ${loadOf(db)} outweighs ${DOW[d]} ${loadOf(day)}`);
    }
  }
  for (const w of train) {
    if (w.t === 'brick') continue;
    const cap = TRI_RACE_WEEK_SESSION_CAP_MIN[(w.discipline ?? 'run') as Disc];
    if ((w.estimatedDurationMin ?? 0) > cap) out.push(`race-week ${w.n} ${w.estimatedDurationMin} > ${cap} min`);
  }
  for (let d = 0; d < 7; d++) {
    const n = train.filter(w => w.dayOfWeek === d).length;
    if (n > TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY) out.push(`${n} training sessions on ${DOW[d]}`);
  }
  // The race-week brick: long course only, Byrn's 60 min with a 15-min run.
  const longCourse = p.mode !== 'sprint' && p.mode !== 'olympic' && p.mode !== 'cycling';
  for (const w of train) {
    if (w.t !== 'brick') continue;
    if (!longCourse || w.estimatedDurationMin !== 60 || w.brickSegments?.[1]?.durationMin !== 15) out.push(`race-week brick ${w.estimatedDurationMin} min`);
  }
  return out;
}

/** The volume, frequency and quality rules (Sunday and Monday races). */
function taperViolations(p: Plan): string[] {
  const out: string[] = [];
  const { s, mode, tw, taperStart, refWeek, ref, present } = p;
  const taperWeeks = tw - taperStart + 1;
  const distance = s.triConfig!.distance;
  const cyclingOnly = mode === 'cycling';
  const { lowHours } = triTaperOpts(s, tw);

  // Taper length by race distance; race week only under 8 h; a plan too
  // short for its taper keeps one taper week.
  const byDistance = cyclingOnly ? CYCLING_TAPER_WEEKS : lowHours ? 1 : TRI_TAPER_WEEKS_BY_DISTANCE[distance];
  const expected = tw < byDistance + 2 ? 1 : byDistance;
  if (taperWeeks !== expected) out.push(`taper ${taperWeeks} weeks, expected ${expected}`);
  // The forecast reads the same taper.
  if (triPlanTaperWeeks(s) !== taperWeeks) out.push(`forecast taper ${triPlanTaperWeeks(s)} vs plan ${taperWeeks}`);

  const fractions = taperWeeks >= 2
    ? [TRI_TAPER_FIRST_WEEK_FRACTION, TRI_RACE_WEEK_FRACTION]
    : [TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION];
  const refSbr = DISCS.reduce((a, d) => a + ref.minutes[d], 0);
  const delivered: number[] = [];
  let excused = false;
  fractions.forEach((f, i) => {
    const wkNum = tw - fractions.length + 1 + i;
    const wk = s.wks[wkNum - 1];
    const race = wkNum === tw;
    const m = minutes(sessions(wk));
    // Explained shortfalls in race week.
    const train = training(wk);
    const trainDays = race ? [...new Set(train.map(w => w.dayOfWeek))] : [];
    const daysFull = race && trainDays.length > 0 && trainDays.every(d => train.filter(w => w.dayOfWeek === d).length >= TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY);
    const before = s.wks[wkNum - 2];
    const atWeekBefore = race && taperWeeks === 1 && before
      && DISCS.reduce((a, d) => a + m[d], 0) >= DISCS.reduce((a, d) => a + minutes(sessions(before))[d], 0) - 1;
    const capped = (d: Disc) => race && train.filter(w => (w.discipline ?? 'run') === d && w.t !== 'brick').length > 0
      && train.filter(w => (w.discipline ?? 'run') === d && w.t !== 'brick')
        .every(w => (w.estimatedDurationMin ?? 0) >= TRI_RACE_WEEK_SESSION_CAP_MIN[d] - 1);
    for (const d of present) {
      const target = f * ref.minutes[d];
      const short = target - m[d] > TRI_TAPER_SESSION_FLOOR_MIN;
      const over = m[d] - target > TRI_TAPER_SESSION_FLOOR_MIN;
      if (short && (capped(d) || daysFull || atWeekBefore)) { excused = true; continue; }
      if (short || over) out.push(`week ${wkNum} ${d} ${m[d]} min vs ${target.toFixed(0)} (${f} of ${ref.minutes[d]})`);
    }
    delivered.push(DISCS.reduce((a, d) => a + m[d], 0) / refSbr);
    // Frequency: at least 80% of the reference week's sessions (the race and
    // the activations counted in race week), and no discipline at zero.
    const n = sessions(wk).length + (race ? 1 : 0);
    if (n < Math.ceil(0.8 * ref.total) && !daysFull) out.push(`week ${wkNum} ${n} sessions < 80% of ${ref.total}`);
    for (const d of present) {
      const has = sessions(wk).some(w => (w.discipline ?? 'run') === d || (d === 'run' && w.t === 'brick'));
      if (!has) out.push(`week ${wkNum} no ${d}`);
    }
    // Intensity ceiling in every taper week.
    const longCourse = cyclingOnly || (distance !== 'sprint' && distance !== 'olympic');
    const raceKind = bikeKindForIntensity(triRaceBikeIntensity(distance, cyclingOnly, '160km'));
    const allowedBike = longCourse
      ? new Set(['bike_endurance', `bike_${raceKind}`, 'brick'])
      : new Set(['bike_endurance', 'bike_tempo', 'bike_sweet_spot', 'bike_vo2_micros', 'brick']);
    for (const w of sessions(wk)) {
      const disc = w.discipline ?? 'run';
      if (disc === 'bike' && !allowedBike.has(w.t)) out.push(`week ${wkNum} ride above the taper ceiling: ${w.t}`);
      if (longCourse && disc === 'run' && (w.t === 'threshold' || w.t === 'vo2')) out.push(`week ${wkNum} long-course ${w.t} run`);
      if (longCourse && disc === 'swim' && (w.t === 'swim_threshold' || w.t === 'swim_speed')) out.push(`week ${wkNum} long-course ${w.t}`);
      if (!longCourse && disc === 'run' && w.t === 'vo2') out.push(`week ${wkNum} VO2 run in the taper`);
    }
    if (race) {
      if (!sessions(wk).some(w => w.taperRole === 'opener')) out.push('race week has no race-pace opener');
      return;
    }
    // Quality kept: the count, and the work inside it.
    const q = qualityCounts(wk);
    const qRef = qualityCounts(refWeek);
    for (const d of present) if (q[d] !== qRef[d]) out.push(`week ${wkNum} ${d} quality ${q[d]} vs reference ${qRef[d]}`);
    const steadyAtFloor = (d: Disc) => sessions(wk)
      .filter(w => (w.discipline ?? 'run') === d && !isQuality(w))
      .every(w => (w.estimatedDurationMin ?? 0) <= TRI_TAPER_SESSION_FLOOR_MIN + 1);
    const refSwimMin = sessions(refWeek).find(w => w.discipline === 'swim')?.estimatedDurationMin ?? 0;
    const skill = (s.triConfig?.skillRating?.swim ?? 3) as TriSkillSlider;
    for (const w of sessions(wk).filter(isQuality)) {
      const dur = w.estimatedDurationMin ?? 0;
      const d = (w.discipline ?? 'run') as Disc;
      if (w.taperRole === 'race_pace') {
        const reps = Number(/(\d+)×90s/.exec(w.d)?.[1] ?? 0);
        if (reps < TRI_RACE_PACE_MIN_REPS || reps > TRI_RACE_PACE_MAX_REPS) out.push(`week ${wkNum} race-pace ${d} ${reps} x 90 s`);
      } else if (w.t === 'bike_vo2_micros') {
        const reps = Number(/Main: (\d+)×\(30s/.exec(w.d)?.[1] ?? 0);
        if (reps < 4 || (reps < TRI_TAPER_MICROS_REPS && dur < triTaperMicrosNeedMin() && !steadyAtFloor('bike'))) out.push(`week ${wkNum} micros ${reps} reps in ${dur} min`);
      } else if (w.t === 'threshold') {
        const reps = Number(/(\d+)×6min/.exec(w.d)?.[1] ?? 0);
        if (reps < 1 || (reps < TRI_TAPER_THRESHOLD_REPS && dur < triTaperThresholdRunNeedMin() && !steadyAtFloor('run'))) out.push(`week ${wkNum} threshold run ${reps} x 6 min in ${dur} min`);
        if (reps < TRI_TAPER_THRESHOLD_REPS && dur >= triTaperThresholdRunNeedMin()) out.push(`week ${wkNum} threshold run ${reps} x 6 min in ${dur} min`);
      } else if (w.t === 'swim_threshold' || w.t === 'swim_speed') {
        const plan = triTaperSwimPlan(w.t === 'swim_threshold' ? 'threshold' : 'speed', refSwimMin, skill, s.triConfig?.swim?.cssSecPer100m);
        const reps = Number(/Main: (\d+)×/.exec(w.d)?.[1] ?? 0);
        if (reps < plan.minReps || (reps < plan.targetReps && !steadyAtFloor('swim'))) out.push(`week ${wkNum} ${w.t} ${reps} reps (target ${plan.targetReps})`);
      }
    }
  });

  // No taper deeper than the band on average (41-60% cut: mean fraction >= 0.40).
  const mean = delivered.reduce((a, x) => a + x, 0) / delivered.length;
  if (mean < 0.40 && !excused) out.push(`mean taper fraction ${mean.toFixed(3)} deeper than the band`);
  return out;
}

describe('race taper rules: distances x plan lengths 2-24 x hours x weekday hours, Sunday and Monday races', () => {
  for (const mode of MODES) {
    it(`${mode}`, () => {
      at(NOW);
      const found: string[] = [];
      for (const wd of WEEKDAY_HOURS) {
        for (const weeks of LENGTHS) {
          for (const hours of hoursFor(mode)) {
            for (const dow of [6, 0]) {
              const p = plan(mode, weeks, hours, dow, { weekdayHours: wd });
              for (const v of [...structuralViolations(p), ...doubleViolations(p), ...taperViolations(p)]) {
                found.push(`${wdTag(wd)} ${weeks}w ${hours}h ${DOW[dow]}: ${v}`);
              }
            }
          }
        }
      }
      expect(found).toEqual([]);
    });
  }
});

describe('race taper rules: Thursday, Friday and Saturday races keep the race-week structure and every discipline', () => {
  for (const mode of MODES) {
    it(`${mode}`, () => {
      at(NOW);
      const found: string[] = [];
      for (const wd of WEEKDAY_HOURS) {
        for (const weeks of LENGTHS) {
          for (const hours of hoursFor(mode)) {
            for (const dow of [3, 4, 5]) {
              const p = plan(mode, weeks, hours, dow, { weekdayHours: wd });
              for (const v of [...structuralViolations(p), ...zeroViolations(p), ...doubleViolations(p)]) found.push(`${wdTag(wd)} ${weeks}w ${hours}h ${DOW[dow]}: ${v}`);
            }
          }
        }
      }
      expect(found).toEqual([]);
    });
  }
});

describe('race-week gym counts toward two sessions a day', () => {
  it('two gym sessions a week: no race-week day holds gym beside two other sessions', () => {
    at(NOW);
    const found: string[] = [];
    for (const mode of MODES) {
      for (const weeks of [4, 6, 12, 16]) {
        for (const hours of hoursFor(mode)) {
          for (const dow of [6, 0, 3, 4, 5]) {
            const p = plan(mode, weeks, hours, dow, { gym: 2 });
            for (const v of [...gymViolations(p), ...structuralViolations(p)]) found.push(`${mode} ${weeks}w ${hours}h ${DOW[dow]}: ${v}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe('known gaps (open questions for Tristan; SCIENCE_LOG limitations)', () => {
  it('Thursday race, 70.3 16 weeks 10 h: the race window (ISSUE-364) cuts taper week 1 and race week holds one training day', () => {
    at(NOW);
    const p = plan('70.3', 16, 10, 3);
    const refSbr = DISCS.reduce((a, d) => a + p.ref.minutes[d], 0);
    const t1 = DISCS.reduce((a, d) => a + minutes(sessions(p.s.wks[p.tw - 2]))[d], 0) / refSbr;
    const rw = DISCS.reduce((a, d) => a + minutes(sessions(p.s.wks[p.tw - 1]))[d], 0) / refSbr;
    // Deeper than the band and under 80% frequency in race week.
    expect((t1 + rw) / 2).toBeLessThan(0.40);
    expect(sessions(p.s.wks[p.tw - 1]).length + 1).toBeLessThan(Math.ceil(0.8 * p.ref.total));
    // Race week: Monday's training (at most two sessions) and the day before.
    expect(new Set(training(p.s.wks[p.tw - 1]).map(w => w.dayOfWeek))).toEqual(new Set([0]));
  });

  it('Friday race, 70.3 16 weeks 10 h: the race window cuts taper week 1 (below the band and under 80%)', () => {
    at(NOW);
    const p = plan('70.3', 16, 10, 4);
    const refSbr = DISCS.reduce((a, d) => a + p.ref.minutes[d], 0);
    const t1 = DISCS.reduce((a, d) => a + minutes(sessions(p.s.wks[p.tw - 2]))[d], 0) / refSbr;
    const rw = DISCS.reduce((a, d) => a + minutes(sessions(p.s.wks[p.tw - 1]))[d], 0) / refSbr;
    expect((t1 + rw) / 2).toBeLessThan(0.40);
    expect(sessions(p.s.wks[p.tw - 2]).length).toBeLessThan(Math.ceil(0.8 * p.ref.total));
    // Race week itself lands on 0.30 and keeps 80%: two training days and the day before.
    expect(Math.abs(rw - TRI_RACE_WEEK_FRACTION)).toBeLessThan(0.03);
    expect(sessions(p.s.wks[p.tw - 1]).length + 1).toBeGreaterThanOrEqual(Math.ceil(0.8 * p.ref.total));
    expect(zeroViolations(p)).toEqual([]);
  });

  it('Saturday race: the race window empties taper week 1\'s last day; cycling 16 weeks 10 h lands near 0.39, Ironman at 25 h below 0.35', () => {
    at(NOW);
    const mean = (p: Plan) => {
      const refSbr = DISCS.reduce((a, d) => a + p.ref.minutes[d], 0);
      const f = (w: number) => DISCS.reduce((a, d) => a + minutes(sessions(p.s.wks[w - 1]))[d], 0) / refSbr;
      return (f(p.tw - 1) + f(p.tw)) / 2;
    };
    const cyc = plan('cycling', 16, 10, 5);
    expect(mean(cyc)).toBeLessThan(0.40);
    expect(mean(cyc)).toBeGreaterThan(0.37);
    expect(mean(plan('ironman', 16, 25, 5))).toBeLessThan(0.35);
    // 70.3 at 10 h holds the band on a Saturday.
    expect(mean(plan('70.3', 16, 10, 5))).toBeGreaterThanOrEqual(0.40);
  });

  it('a one-week race week of openers sits above a thin week before (Olympic 6 weeks 5 h, Monday race: the week before is a deload)', () => {
    at(NOW);
    const p = plan('olympic', 6, 5, 0);
    expect(p.tw - p.taperStart + 1).toBe(1);
    const rw = minsOf(sessions(p.s.wks[p.tw - 1]));
    const before = minsOf(sessions(p.s.wks[p.tw - 2]));
    expect(rw).toBeGreaterThan(before);
    // Every race-week training session is an opener (none left to trim).
    expect(training(p.s.wks[p.tw - 1]).every(w => w.taperRole === 'opener')).toBe(true);
  });

  it('a one-week taper at high hours cannot hold 0.55 under the race-week caps (Ironman 3 weeks, 25 h)', () => {
    at(NOW);
    const p = plan('ironman', 3, 25, 6);
    const run = minutes(sessions(p.s.wks[p.tw - 1])).run;
    expect(run).toBeLessThan(TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION * p.ref.minutes.run - TRI_TAPER_SESSION_FLOOR_MIN);
    const runs = training(p.s.wks[p.tw - 1]).filter(w => w.discipline === 'run' && w.t !== 'brick');
    expect(runs.every(w => (w.estimatedDurationMin ?? 0) >= TRI_RACE_WEEK_SESSION_CAP_MIN.run - 1)).toBe(true);
  });
});

describe('taper length', () => {
  it('by race distance, not plan length (plans long enough to hold the taper)', () => {
    // Trailing taper (a 28+ week plan also labels its inter-cycle weeks taper).
    const trailing = (d: TriathlonDistance, n: number) => {
      const ph = computeTriPlanPhases(d, n).map(p => p.ph);
      let t = 0;
      for (let i = ph.length - 1; i >= 0 && ph[i] === 'taper'; i--) t++;
      return t;
    };
    for (const n of [4, 8, 12, 16, 20, 24, 30]) {
      expect(trailing('sprint', n), `sprint ${n}w`).toBe(1);
      for (const d of ['olympic', 't100', '70.3', 'ironman'] as TriathlonDistance[]) {
        expect(trailing(d, n), `${d} ${n}w`).toBe(2);
      }
      expect(computeTriPlanPhases('70.3', n, { cyclingOnly: true }).slice(-2).every(p => p.ph === 'taper')).toBe(true);
      expect(computeTriPlanPhases('ironman', n, { lowHours: true }).slice(-2).map(p => p.ph)).not.toEqual(['taper', 'taper']);
    }
  });

  it('a plan too short for its taper keeps the plan-length rule (one taper week)', () => {
    expect(computeTriPlanPhases('70.3', 3).map(p => p.ph)).toEqual(['build', 'peak', 'taper']);
    expect(computeTriPlanPhases('ironman', 2).map(p => p.ph)).toEqual(['peak', 'taper']);
    expect(computeTriPlanPhases('olympic', 1).map(p => p.ph)).toEqual(['taper']);
  });

  it('low hours: judged on the reference week\'s training, under 8 h (Goeringer)', () => {
    at(NOW);
    expect(triTaperOpts(build('70.3', raceDay(16), 10), 16).lowHours).toBe(false);
    expect(triTaperOpts(build('70.3', raceDay(16), 6), 16).lowHours).toBe(true);
    expect(triTaperOpts(build('ironman', raceDay(16), 16), 16).lowHours).toBe(false);
    expect(triTaperOpts(build('olympic', raceDay(16), 5), 16).lowHours).toBe(true);
    // Cycling keeps its 2 weeks whatever the hours.
    expect(triTaperOpts(build('cycling', raceDay(16), 4), 16).lowHours).toBe(false);
  });

  it('low hours counts commute runs (running load) but not gym: 10 h with three bidirectional 5 km commutes and two gym sessions is not low hours', () => {
    at(NOW);
    const s = build('70.3', raceDay(16), 10);
    s.commuteConfig = { enabled: true, distanceKm: 5, isBidirectional: true, commuteDaysPerWeek: 3 };
    s.gs = 2;
    expect(triTaperOpts(s, 16).lowHours).toBe(false);
  });

  it('the forecast tapers like the plan before the plan exists (a low-hours onboarding forecast takes race week only)', () => {
    at(NOW);
    const s = build('70.3', raceDay(16), 6);
    expect(triPlanTaperWeeks({ ...s, wks: [] }, () => triTaperOpts(s, 16).lowHours)).toBe(1);
    expect(triPlanTaperWeeks({ ...s, wks: [] })).toBe(2);
  });

  it('the forecast fallback keeps the short-plan rule (a 3-week Olympic plan tapers 1 week, as the plan does)', () => {
    at(NOW);
    const s = build('olympic', raceDay(3), 8);
    const tw = planTrainingWeeks(s);
    expect(computeTriPlanPhases('olympic', tw).map(p => p.ph)).toEqual(['build', 'peak', 'taper']);
    expect(triPlanTaperWeeks({ ...s, wks: [] })).toBe(1);
    expect(triPlanTaperWeeks(s)).toBe(1);
  });
});

describe('generator version', () => {
  it('TRI_GENERATOR_VERSION is bumped for the taper rebuild (stored plans regenerate)', () => {
    expect(TRI_GENERATOR_VERSION).toBeGreaterThanOrEqual(24);
  });
});
