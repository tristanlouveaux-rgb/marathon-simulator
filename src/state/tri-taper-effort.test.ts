/**
 * The triathlon and cycling race taper under the effort multiplier (planning
 * side; orchestrator decision 2 and its reviews, 2026-10-14). The multiplier
 * is set the way the app sets it, through the state the generator reads:
 * every swim, bike and run session of weeks 1 and 2 is rated at its planned
 * RPE + 3 or - 3, week 3 is current, and the plan is rebuilt from the current
 * week on, as a rollover rebuilds it (events.ts rebakeFutureWeeksInPlace).
 * triTrailingEffortScore then reads a deviation of 3 in every discipline:
 * 1 - 0.05 x 3 = 0.85 and 1 + 0.05 x 3 = 1.15, the clamp's bounds.
 *
 * Matrix: sprint, Olympic, 70.3 and Ironman at the typical hour level and the
 * next one up, cycling at 10 and 14 h; 12 and 16 weeks; Sunday and Wednesday
 * races; multipliers 0.85 and 1.15.
 *   - The multiplier the generator reads is 0.85 or 1.15 in every discipline
 *     the plan trains, and the stored reference week scales by it.
 *   - Taper week 1, or a one-week race week, holds 0.55 of the reference week
 *     as the athlete trains it (the stored week), within 0.03.
 *   - A two-week race week holds 0.30 of it: 0.27 to 0.37. The upper
 *     allowance is race week's fixed floors (20-min sessions, the openers,
 *     the day-before activation), which weigh more as the reference week
 *     shrinks at 0.85 (Olympic 8 h: 0.37 at 0.85, 0.33 with no effort
 *     history).
 *   - The two-week mean sits inside 0.40 to 0.59.
 *
 * Rollover walk (review of 26183cf): a Tuesday or Wednesday race's closing
 * week holds the day-before activation, composed with race week. Walking the
 * plan week by week (rate the finished week, make the next one current,
 * rebuild from it on), the rollover into the closing week rebuilds race week
 * exactly as stored and leaves the activation as it was, no heavier than any
 * stored race-week training day.
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
import { planTrainingWeeks } from '@/workouts/race-week-layout';
import { generateTriathlonPlan, regenerateTriathlonWeek, triTaperReference } from '@/workouts/plan_engine.triathlon';
import { triEffortMultiplier } from '@/calculations/effort-multiplier.triathlon';
import {
  TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION,
  TRI_RACE_WEEK_FRACTION,
  TRI_TAPER_FIRST_WEEK_FRACTION,
} from '@/constants/triathlon-constants';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week, Workout } from '@/types';
import type { TriathlonDistance } from '@/types/triathlon';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorageMock.clear(); });
afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

// Plans start Monday 12 October 2026 (onboarding that Monday).
function at(): void {
  process.env.TZ = 'Europe/London';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

type Mode = TriathlonDistance | 'cycling';
type Disc = 'swim' | 'bike' | 'run';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SUN = 6;
const WED = 2;

/** The race date: weekday `dow` (0 = Monday) of plan week `weeks`. */
function raceDay(weeks: number, dow: number): string {
  const d = new Date(2026, 9, 12 + (weeks - 1) * 7 + dow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function build(mode: Mode, weeks: number, hours: number, dow: number, gym = 0): SimulatorState {
  resetState();
  const ob = {
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', experienceLevel: 'intermediate',
    customRaceDate: raceDay(weeks, dow), triTimeAvailableHoursPerWeek: hours,
    ...(gym > 0 ? { gymSessionsPerWeek: gym } : {}),
  };
  if (mode === 'cycling') {
    initializeCyclingSimulator({ ...ob, trainingMode: 'cycling', cyclingDistance: '160km' } as OnboardingState);
  } else {
    initializeTriathlonSimulator({ ...ob, trainingMode: 'triathlon', triDistance: mode } as OnboardingState);
  }
  return getState();
}

/** Rates every swim, bike and run session of `wk` at its planned RPE + `dev`. */
function rateWeek(wk: Week, dev: number): void {
  wk.rated = {};
  for (const w of wk.triWorkouts ?? []) {
    const expected = w.rpe ?? w.r;
    if (w.id && expected != null) wk.rated[w.id] = expected + dev;
  }
}

/** Rebuilds the current week and every later one in place, as a rollover
 *  does (events.ts rebakeFutureWeeksInPlace): past weeks and every week's
 *  ratings stay. */
function rebake(s: SimulatorState): void {
  const fresh = generateTriathlonPlan(s);
  for (let i = (s.w ?? 1) - 1; i < Math.min(s.wks.length, fresh.length); i++) {
    s.wks[i].triWorkouts = fresh[i].triWorkouts;
    s.wks[i].ph = fresh[i].ph;
    if (fresh[i].raceWindowCut) s.wks[i].raceWindowCut = fresh[i].raceWindowCut;
    else delete s.wks[i].raceWindowCut;
  }
}

/** Swim, bike, run and brick sessions (no commute, no gym). */
const sessions = (ws: Workout[] | undefined) => (ws ?? []).filter(w => w.t !== 'gym' && !w.commute);
const minsOf = (ws: Workout[]) => ws.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
const loadOf = (ws: Workout[]) => ws.reduce((a, w) => a + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);

function taperStartOf(s: SimulatorState, tw: number): number {
  let start = tw;
  while (start > 1 && s.wks[start - 2].ph === 'taper') start--;
  return start;
}

/** Hour settings: the typical level and the next one up (cycling 10, 14 h). */
const MATRIX: Array<[Mode, number[]]> = [
  ['sprint', [6, 8]], ['olympic', [8, 10]], ['70.3', [10, 13]], ['ironman', [16, 20]], ['cycling', [10, 14]],
];

describe('race taper at effort multipliers 0.85 and 1.15, set by rating weeks 1 and 2', () => {
  for (const [mode, hoursList] of MATRIX) {
    it(`${mode}: each taper week holds its fraction of the reference week as the athlete trains it, Sunday and Wednesday races`, () => {
      at();
      const discs: Disc[] = mode === 'cycling' ? ['bike'] : ['swim', 'bike', 'run'];
      for (const hours of hoursList) for (const weeks of [12, 16]) for (const dow of [SUN, WED]) {
        // No effort history: the stored reference week as generated.
        const base = build(mode, weeks, hours, dow);
        const tw = planTrainingWeeks(base);
        const taperStart = taperStartOf(base, tw);
        const refIdx = triTaperReference(base, tw)!.refWeek - 1;
        const baseRef = minsOf(sessions(base.wks[refIdx].triWorkouts));
        for (const dev of [3, -3]) {
          const m = dev > 0 ? 0.85 : 1.15;
          const tag = `${mode} ${weeks}w ${hours}h ${DOW[dow]} m ${m}`;
          const s = build(mode, weeks, hours, dow);
          s.w = 3;
          rateWeek(s.wks[0], dev);
          rateWeek(s.wks[1], dev);
          // The multiplier the generator reads, set by the ratings alone.
          for (const d of discs) expect(triEffortMultiplier(s, d), `${tag} ${d} multiplier`).toBeCloseTo(m, 10);
          rebake(s);
          expect(planTrainingWeeks(s), tag).toBe(tw);
          expect(taperStartOf(s, tw), tag).toBe(taperStart);
          // The reference week as the athlete trains it: the stored week,
          // which the multiplier scaled.
          const ref = minsOf(sessions(s.wks[refIdx].triWorkouts));
          expect(Math.abs(ref / baseRef - m), `${tag} reference ${ref} against ${baseRef}`).toBeLessThan(0.03);
          const frac = (w: number) => {
            // A Tuesday or Wednesday race's day-before activation sits in the
            // closing week and counts toward race week.
            const closing = w === tw && s.tw > tw ? sessions(s.wks[tw].triWorkouts) : [];
            return minsOf([...sessions(s.wks[w - 1].triWorkouts), ...closing]) / ref;
          };
          const fr: number[] = [];
          for (let w = taperStart; w <= tw; w++) fr.push(frac(w));
          const shown = fr.map(f => f.toFixed(3)).join(' then ');
          if (fr.length === 1) {
            expect(Math.abs(fr[0] - TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION), `${tag} one-week race week ${shown}`).toBeLessThanOrEqual(0.03);
            continue;
          }
          expect(fr.length, tag).toBe(2);
          expect(Math.abs(fr[0] - TRI_TAPER_FIRST_WEEK_FRACTION), `${tag} taper week 1 ${shown}`).toBeLessThanOrEqual(0.03);
          expect(fr[1], `${tag} race week ${shown}`).toBeGreaterThanOrEqual(TRI_RACE_WEEK_FRACTION - 0.03);
          expect(fr[1], `${tag} race week ${shown}`).toBeLessThanOrEqual(TRI_RACE_WEEK_FRACTION + 0.07);
          const mean = (fr[0] + fr[1]) / 2;
          expect(mean, `${tag} two-week mean ${mean.toFixed(3)} (${shown})`).toBeGreaterThanOrEqual(0.40);
          expect(mean, `${tag} two-week mean ${mean.toFixed(3)} (${shown})`).toBeLessThanOrEqual(0.59);
        }
      }
    });
  }
});

/** Walks the plan from week 1 to its closing week: at each rollover the
 *  finished week is rated at `preTaperDev` (weeks before the taper) or
 *  `taperDev` (taper weeks), the next week becomes current and the plan is
 *  rebuilt from it on. Returns the closing week as stored just before the
 *  rollover into it and the plan after it. */
function walkToClosingWeek(s: SimulatorState, preTaperDev: number, taperDev: number) {
  const tw = planTrainingWeeks(s);
  const taperStart = taperStartOf(s, tw);
  let closingBefore: Workout[] = [];
  for (let w = 2; w <= tw + 1; w++) {
    rateWeek(s.wks[w - 2], w - 1 < taperStart ? preTaperDev : taperDev);
    if (w === tw + 1) closingBefore = structuredClone(s.wks[tw].triWorkouts ?? []);
    s.w = w;
    rebake(s);
  }
  return { tw, closingBefore };
}

describe('rollover into the closing week: the day-before activation stays as stored (Tuesday and Wednesday races)', () => {
  const cases: Array<[Mode, number, number, number]> = [];
  for (const [mode, hours] of [['sprint', 5], ['olympic', 9], ['t100', 10], ['70.3', 10], ['ironman', 10], ['cycling', 9]] as Array<[Mode, number]>) {
    for (const weeks of [6, 12]) for (const dow of [1, WED]) cases.push([mode, weeks, hours, dow]);
  }
  // Pre-taper weeks at RPE +3 (0.85), taper weeks as planned; pre-taper weeks
  // at RPE -3 (1.15), taper weeks at +3. Without a fix, race week was rebuilt
  // at the rollover with no multiplier: the activation changed in 130 of 276
  // walks (sprint, Olympic, T100, 70.3 and Ironman), and 46 had a day before
  // heavier than a stored race-week day.
  for (const [preTaperDev, taperDev] of [[3, 0], [-3, 3]]) {
    it(`pre-taper weeks rated ${preTaperDev > 0 ? '+' : ''}${preTaperDev}, taper weeks ${taperDev > 0 ? '+' : ''}${taperDev}`, () => {
      at();
      for (const [mode, weeks, hours, dow] of cases) {
        for (const gym of [0, 2]) {
          const tag = `${mode} ${weeks}w ${hours}h ${DOW[dow]} gym ${gym}`;
          const s = build(mode, weeks, hours, dow, gym);
          const { tw, closingBefore } = walkToClosingWeek(s, preTaperDev, taperDev);
          expect(s.w, tag).toBe(tw + 1);
          expect(s.tw, tag).toBe(tw + 1);
          // Race week, now past, is rebuilt exactly as stored.
          expect(generateTriathlonPlan(s)[tw - 1].triWorkouts, `${tag} race week`).toEqual(s.wks[tw - 1].triWorkouts);
          // The activation the rollover rebuilt is the one stored before it.
          const closingAfter = s.wks[tw].triWorkouts ?? [];
          expect(closingAfter, `${tag} closing week`).toEqual(closingBefore);
          // It is never heavier, in minutes or load, than any stored race-week
          // training day.
          const acts = closingAfter.filter(w => w.taperRole === 'day_before');
          expect(acts.length, `${tag} activation`).toBeGreaterThan(0);
          const train = sessions(s.wks[tw - 1].triWorkouts).filter(w => w.taperRole !== 'day_before');
          for (const d of new Set(train.map(w => w.dayOfWeek))) {
            const day = train.filter(w => w.dayOfWeek === d);
            expect(minsOf(acts), `${tag} activation against ${DOW[d ?? 0]}`).toBeLessThanOrEqual(minsOf(day));
            expect(loadOf(acts), `${tag} activation load against ${DOW[d ?? 0]}`).toBeLessThanOrEqual(loadOf(day));
          }
          // An injury reported on race eve still reaches the activation: the
          // closing week is the current week, so a rebuild applies its gates
          // (run at 0% drops the jog, bike at 50% halves the spin).
          (s as unknown as { injuryState: unknown }).injuryState = {
            active: true, location: 'knee', runCapacity: 0, bikeCapacity: 50, swimCapacity: 100,
          };
          const gated = regenerateTriathlonWeek(s, tw + 1)!.triWorkouts ?? [];
          expect(gated.filter(w => w.discipline === 'run'), `${tag} injured run`).toEqual([]);
          const rides = acts.filter(w => w.discipline === 'bike');
          expect(gated.length, `${tag} injured activation`).toBe(rides.length);
          gated.forEach((w, i) => {
            expect(w.estimatedDurationMin, `${tag} injured spin`).toBe(Math.round((rides[i].estimatedDurationMin ?? 0) * 0.5));
            expect(w.modReason, `${tag} injured spin`).toBe('Capacity 50%. Bike duration scaled to match your reported ability');
          });
          delete (s as unknown as { injuryState?: unknown }).injuryState;
        }
      }
    });
  }
});
