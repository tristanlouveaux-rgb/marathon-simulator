/**
 * Triathlon and cycling race-taper rules (Tristan, 2026-10-13; tri-taper.ts;
 * SCIENCE_LOG "Triathlon and cycling taper rebuild"), checked on plans built
 * through the onboarding initializers across distances (T100 included) and
 * cycling x plan lengths 8 to 24 weeks x low, typical and high hours, Sunday
 * races:
 *   - taper length by race distance (sprint 1, others 2, cycling 2), race week
 *     only under 8 h of reference-week training (Goeringer);
 *   - delivered minutes per discipline land on the fraction of the reference
 *     week (0.55 then 0.30; 0.55 for a one-week taper), within one
 *     floor-length session;
 *   - no taper deeper than the 41-60% band on average (Bosquet 2007);
 *   - at least 80% of the reference week's sessions in every taper week, the
 *     race counted in race week (Mujika 2011), and no discipline at zero;
 *   - quality kept: taper week 1 keeps the reference week's quality count per
 *     discipline; race week holds race-pace openers; long course and cycling
 *     never above race intensity, short course within the taper gate;
 *   - the day before holds only a capped activation (ride 30 min, run 10 min;
 *     Allen, Byrn), never the week's longest session; two days out is empty;
 *   - TRI_GENERATOR_VERSION bumped so stored plans regenerate.
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
import { planTrainingWeeks, raceWeekLayout } from '@/workouts/race-week-layout';
import { TRI_GENERATOR_VERSION, triTaperOpts } from '@/workouts/plan_engine.triathlon';
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
  bikeKindForIntensity,
  triRaceBikeIntensity,
} from '@/workouts/tri-taper';
import { isFourWeekCycleDeloadWeek } from '@/workouts/plan_engine';
import { isLongRun } from '@/workouts/long-run';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week, Workout } from '@/types';
import type { TriathlonDistance } from '@/types/triathlon';

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
const LENGTHS = [8, 10, 12, 16, 20, 24];
// Plans start Monday 12 October 2026 (onboarding that Monday).
const NOW = '2026-10-12T10:00:00';

function hoursFor(mode: Mode): number[] {
  if (mode === 'cycling') return [6, 10, 14];
  const h = DEFAULT_WEEKLY_PEAK_HOURS[mode];
  return [h[1], h[3], h[5]];
}

function raceSunday(weeks: number): string {
  const d = new Date(2026, 9, 12 + (weeks - 1) * 7 + 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function build(mode: Mode, race: string, hours: number): SimulatorState {
  resetState();
  const ob = {
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', experienceLevel: 'intermediate',
    customRaceDate: race, triTimeAvailableHoursPerWeek: hours,
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

/** Minutes per discipline, brick legs in their discipline. */
function minutes(wk: Week): Record<Disc, number> {
  const m: Record<Disc, number> = { swim: 0, bike: 0, run: 0 };
  for (const w of sessions(wk)) {
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
  tw: number;
  taperStart: number;
  ref: Week;
  present: Disc[];
}

function plan(mode: Mode, weeks: number, hours: number): Plan {
  const s = build(mode, raceSunday(weeks), hours);
  const tw = planTrainingWeeks(s);
  let taperStart = tw;
  while (taperStart > 1 && s.wks[taperStart - 2].ph === 'taper') taperStart--;
  const ref = [...s.wks].slice(0, taperStart - 1).reverse()
    .find(w => w.ph !== 'taper' && !isFourWeekCycleDeloadWeek(w.w, w.ph))!;
  const present = (s.triConfig?.disciplines ?? ['swim', 'bike', 'run']) as Disc[];
  return { s, mode, tw, taperStart, ref, present };
}

const MODES: Mode[] = ['sprint', 'olympic', 't100', '70.3', 'ironman', 'cycling'];

function violations(p: Plan): string[] {
  const out: string[] = [];
  const { s, mode, tw, taperStart, ref, present } = p;
  const taperWeeks = tw - taperStart + 1;
  const distance = s.triConfig!.distance;
  const cyclingOnly = mode === 'cycling';
  const { lowHours } = triTaperOpts(s, tw);

  // Taper length by race distance; race week only under 8 h.
  const expected = cyclingOnly ? CYCLING_TAPER_WEEKS : lowHours ? 1 : TRI_TAPER_WEEKS_BY_DISTANCE[distance];
  if (taperWeeks !== expected) out.push(`taper ${taperWeeks} weeks, expected ${expected}`);

  const refMin = minutes(ref);
  const refSessions = sessions(ref).length;
  const fractions = taperWeeks >= 2
    ? [TRI_TAPER_FIRST_WEEK_FRACTION, TRI_RACE_WEEK_FRACTION]
    : [TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION];
  const delivered: number[] = [];
  fractions.forEach((f, i) => {
    const wkNum = tw - fractions.length + 1 + i;
    const wk = s.wks[wkNum - 1];
    const race = wkNum === tw;
    const m = minutes(wk);
    // Fractions per discipline, within one floor-length session.
    for (const d of present) {
      const target = f * refMin[d];
      if (Math.abs(m[d] - target) > TRI_TAPER_SESSION_FLOOR_MIN) {
        out.push(`week ${wkNum} ${d} ${m[d]} min vs ${target.toFixed(0)} (${f} of ${refMin[d]})`);
      }
    }
    const sbr = DISCS.reduce((a, d) => a + m[d], 0);
    const refSbr = DISCS.reduce((a, d) => a + refMin[d], 0);
    delivered.push(sbr / refSbr);
    // Frequency: at least 80% of the reference week's sessions (the race
    // counted in race week), and no discipline at zero.
    const n = sessions(wk).length + (race ? 1 : 0);
    if (n < Math.ceil(0.8 * refSessions)) out.push(`week ${wkNum} ${n} sessions < 80% of ${refSessions}`);
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
    // Quality kept.
    if (!race) {
      const q = qualityCounts(wk);
      const qRef = qualityCounts(ref);
      for (const d of present) if (q[d] !== qRef[d]) out.push(`week ${wkNum} ${d} quality ${q[d]} vs reference ${qRef[d]}`);
    } else if (!sessions(wk).some(w => w.taperRole === 'opener')) {
      out.push('race week has no race-pace opener');
    }
  });

  // No taper deeper than the band on average (41-60% cut: mean fraction >= 0.40).
  const mean = delivered.reduce((a, x) => a + x, 0) / delivered.length;
  if (mean < 0.40) out.push(`mean taper fraction ${mean.toFixed(3)} deeper than the band`);

  // The day before and two days out (Sunday race: Saturday and Friday).
  const layout = raceWeekLayout(s.planStartDate!, s.triConfig!.raceDate!)!;
  const rw = s.wks[tw - 1];
  const dOut = (w: Workout) => layout.raceDayIndex - ((tw - 1) * 7 + (w.dayOfWeek ?? 0));
  const longestOther = Math.max(0, ...sessions(rw).filter(w => dOut(w) !== 1).map(w => w.estimatedDurationMin ?? 0));
  for (const w of rw.triWorkouts ?? []) {
    const d = dOut(w);
    if (d === 2) out.push(`two days out: ${DOW[w.dayOfWeek ?? 0]} ${w.n}`);
    if (d !== 1) continue;
    if (w.taperRole !== 'day_before') out.push(`day before holds ${w.n}`);
    const cap = w.discipline === 'bike' ? TRI_DAY_BEFORE_RIDE_MAX_MIN : TRI_DAY_BEFORE_RUN_MAX_MIN;
    if ((w.estimatedDurationMin ?? 0) > cap) out.push(`day before ${w.n} ${w.estimatedDurationMin} > ${cap} min`);
    if ((w.estimatedDurationMin ?? 0) > longestOther) out.push(`day before ${w.n} is the week's longest`);
  }
  // The race-week brick: long course only, Byrn's 60 min with a 15-min run.
  for (const w of rw.triWorkouts ?? []) {
    if (w.t !== 'brick') continue;
    const longCourse = distance !== 'sprint' && distance !== 'olympic';
    if (!longCourse || w.estimatedDurationMin !== 60 || w.brickSegments?.[1]?.durationMin !== 15) out.push(`race-week brick ${w.estimatedDurationMin} min`);
  }
  return out;
}

describe('race taper rules: distances x plan lengths 8-24 x hours', () => {
  for (const mode of MODES) {
    it(`${mode}`, () => {
      at(NOW);
      const found: string[] = [];
      for (const weeks of LENGTHS) {
        for (const hours of hoursFor(mode)) {
          const p = plan(mode, weeks, hours);
          for (const v of violations(p)) found.push(`${weeks}w ${hours}h: ${v}`);
        }
      }
      expect(found).toEqual([]);
    });
  }
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

  it('low hours: judged on the reference week, under 8 h (Goeringer)', () => {
    at(NOW);
    expect(triTaperOpts(build('70.3', raceSunday(16), 10), 16).lowHours).toBe(false);
    expect(triTaperOpts(build('70.3', raceSunday(16), 6), 16).lowHours).toBe(true);
    expect(triTaperOpts(build('ironman', raceSunday(16), 16), 16).lowHours).toBe(false);
    expect(triTaperOpts(build('olympic', raceSunday(16), 5), 16).lowHours).toBe(true);
    // Cycling keeps its 2 weeks whatever the hours.
    expect(triTaperOpts(build('cycling', raceSunday(16), 4), 16).lowHours).toBe(false);
  });
});

describe('generator version', () => {
  it('TRI_GENERATOR_VERSION is bumped for the taper rebuild (stored plans regenerate)', () => {
    expect(TRI_GENERATOR_VERSION).toBeGreaterThanOrEqual(24);
  });
});
