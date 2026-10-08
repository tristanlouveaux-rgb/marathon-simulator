/**
 * Triathlon scheduler: no second run on the long-run day or the brick day
 * (visual QA, 2026-10-08).
 *
 * Scenario tri-wednesday (70.3, Wednesday race 6 weeks out, onboarding
 * Thursday 8 October 2026): week 3 Sunday held "Long run ~16 km (1h 20min)"
 * and "Easy run 50 min". Weekday capacity ran out, and the capacity fallbacks
 * (placeByPreference steps 3 and 5) stacked the easy run on the long-run day.
 * Pre-existing: the scheduler before the branch (c0d0fb5, long run = last run
 * in the array) produced the same week; 152f60f / d2df750 (long run found by
 * type) did not introduce it. Across a sweep of 26,568 plan weeks the old
 * scheduler put a second run beside the long run in 2,766 weeks and a run
 * beside the brick in 1,104.
 *
 * The scheduler header allows a same-discipline double only as an explicit
 * two-a-day; no rule allows a second run beside the long run or the brick's
 * transition run. A run that fits nowhere else takes another day.
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

import { scheduleTriathlonWeek } from './scheduler.triathlon';
import { generateTriathlonPlan } from './plan_engine.triathlon';
import { isLongRun } from './long-run';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { initializeCyclingSimulator } from '@/state/initialization.cycling';
import { getMutableState, getState, resetState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { Workout, Week } from '@/types/state';

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

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const isRun = (w: Workout) => (w.discipline ?? 'run') === 'run';

/** Days holding the long run or the brick plus another run, as "w3 Sun: ...". */
function runDoublesOnAnchorDays(weeks: Week[]): string[] {
  const out: string[] = [];
  for (const wk of weeks) {
    const ws = wk.triWorkouts ?? [];
    for (let d = 0; d < 7; d++) {
      const day = ws.filter(w => w.dayOfWeek === d);
      const runs = day.filter(isRun);
      const longRuns = runs.filter(w => isLongRun(w)).length;
      const brick = day.some(w => w.t === 'brick');
      if ((longRuns > 0 && runs.length > 1) || (brick && runs.length > 0)) {
        out.push(`w${wk.w} ${DOW[d]}: ${day.map(w => w.n).join(' + ')}`);
      }
    }
  }
  return out;
}

const mk = (n: string, t: string, discipline: Workout['discipline'], min: number, extra: Partial<Workout> = {}): Workout =>
  ({ n, t, d: '', r: 5, rpe: 5, discipline, estimatedDurationMin: min, ...extra } as Workout);

describe('scheduleTriathlonWeek keeps the long-run and brick days free of other runs', () => {
  it('a run that fits on no weekday takes a weekday over its cap, not the long-run or brick day', () => {
    // Weekday cap 60 min; every weekday already holds a session, so the easy
    // run fits nowhere within the caps.
    const caps = { 0: 60, 1: 60, 2: 60, 3: 60, 4: 60, 5: 240, 6: 240 };
    const out = scheduleTriathlonWeek(
      [mk('Swim technique', 'swim_technique', 'swim', 44), mk('Swim speed', 'swim_speed', 'swim', 44)],
      [mk('VO2 intervals', 'bike_vo2', 'bike', 60), mk('Threshold intervals', 'bike_threshold', 'bike', 60)],
      [mk('Threshold run', 'threshold', 'run', 50), mk('Easy run', 'easy', 'run', 50), mk('Long run', 'long', 'run', 80)],
      mk('Brick', 'brick', 'bike', 150),
      'build', [], caps,
    );
    const day = (n: string) => out.find(w => w.n === n)!.dayOfWeek;
    expect(day('Long run')).toBe(6);
    expect(day('Brick')).toBe(5);
    expect([5, 6]).not.toContain(day('Easy run'));
    expect([5, 6]).not.toContain(day('Threshold run'));
    // Never two runs on one day here: a cross-discipline two-a-day instead.
    expect(day('Easy run')).not.toBe(day('Threshold run'));
  });

  it('commute runs never land beside the long run', () => {
    // No weekday capacity and a full Saturday: the capacity fallback used to
    // put the commutes on Sunday with the long run.
    const caps = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 100, 6: 300 };
    const out = scheduleTriathlonWeek(
      [mk('Swim', 'swim_endurance', 'swim', 40)],
      [mk('Long ride', 'bike_endurance', 'bike', 120)],
      [mk('Long run', 'long', 'run', 70), mk('Commute 1', 'easy', 'run', 30, { commute: true }), mk('Commute 2', 'easy', 'run', 30, { commute: true })],
      null, 'base', [], caps,
    );
    for (const w of out.filter(x => x.commute)) expect(w.dayOfWeek, w.n).not.toBe(6);
  });
});

describe('real plans: no second run on the long-run or brick day', () => {
  it('scenario tri-wednesday: week 3 Sunday holds only the long run', () => {
    at('2026-10-08T12:00:00');
    resetState();
    initializeTriathlonSimulator({
      ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
      trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate', customRaceDate: '2026-11-18',
    } as OnboardingState);
    const s = getState();
    const sunday = (s.wks[2].triWorkouts ?? []).filter(w => w.dayOfWeek === 6);
    expect(sunday.filter(isRun).map(w => w.t)).toEqual(['long']);
    // The easy run is still in the week.
    expect((s.wks[2].triWorkouts ?? []).some(w => w.t === 'easy')).toBe(true);
    expect(runDoublesOnAnchorDays(s.wks)).toEqual([]);
  });

  it('every distance, ability, hours budget, weekday split and commute set-up', () => {
    at('2026-10-04T12:00:00');
    const found: string[] = [];
    let weeks = 0;
    for (const dist of ['sprint', 'olympic', '70.3', 'ironman'] as const) {
      for (const lvl of ['beginner', 'intermediate', 'advanced']) {
        for (const hrs of [4, 6, 8, 10, 12, 15]) {
          for (const weekdayFrac of [0.2, 0.4, 0.6]) {
            for (const commute of ['none', 'one-way', 'both'] as const) {
              for (const race of ['2027-01-24', '2027-03-14']) {
                resetState();
                initializeTriathlonSimulator({
                  ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
                  trainingMode: 'triathlon', triDistance: dist, experienceLevel: lvl, customRaceDate: race,
                  triTimeAvailableHoursPerWeek: hrs, triWeekdayHoursPerWeek: Math.round(hrs * weekdayFrac * 2) / 2,
                } as unknown as OnboardingState);
                const s = getMutableState();
                if (commute !== 'none') {
                  s.commuteConfig = { enabled: true, distanceKm: 6, isBidirectional: commute === 'both', commuteDaysPerWeek: 2 };
                  s.wks = generateTriathlonPlan(s);
                }
                weeks += s.wks.length;
                for (const hit of runDoublesOnAnchorDays(s.wks)) {
                  found.push(`${dist} ${lvl} ${hrs}h weekday ${weekdayFrac} ${commute} ${race} ${hit}`);
                }
              }
            }
          }
        }
      }
    }
    expect(weeks).toBeGreaterThan(20000);
    expect(found.slice(0, 5)).toEqual([]);
  });

  it('cycling (tri engine, no runs) still schedules every ride', () => {
    at('2026-10-04T12:00:00');
    resetState();
    initializeCyclingSimulator({
      trainingMode: 'cycling', cyclingDistance: '160km', experienceLevel: 'intermediate', customRaceDate: '2027-01-24',
    } as OnboardingState);
    const s = getState();
    for (const wk of s.wks) {
      for (const w of wk.triWorkouts ?? []) {
        expect(w.discipline, `w${wk.w} ${w.n}`).not.toBe('run');
        expect(w.dayOfWeek, `w${wk.w} ${w.n}`).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
