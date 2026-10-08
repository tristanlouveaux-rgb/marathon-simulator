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
 *
 * Race week (review, 2026-10-08): no discipline twice on one day; a session
 * with no free day for its discipline is left out. The sweep covers T100.
 *
 * Second review (2026-10-08): closing the long-run and brick days to runs
 * moved the double to a weekday. Step 4 (preferred day with capacity,
 * collisions allowed) ran before any day without a run was tried, so an easy
 * run that fit no run-free weekday within its cap joined the weekday threshold
 * or VO2 run (Ironman 10 h peak week: Monday held both). Base 23bbbfc: 0 such
 * weeks; after the first fix: 33 in this file's sweep (T100 included) and 9
 * with the default weekday split. Step 3b now gives such a run the day without
 * a run it overshoots least. Commutes are not covered (open question).
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

/** Weekdays holding two or more runs other than commutes, as "w3 Mon: ...". */
function weekdayRunDoubles(weeks: Week[]): string[] {
  const out: string[] = [];
  for (const wk of weeks) {
    const ws = wk.triWorkouts ?? [];
    for (let d = 0; d < 5; d++) {
      const runs = ws.filter(w => w.dayOfWeek === d && isRun(w) && !w.commute);
      if (runs.length > 1) out.push(`w${wk.w} ${DOW[d]}: ${runs.map(w => w.n).join(' + ')}`);
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

  it('a run that fits no day within its cap takes a day without a run, not the weekday threshold run\'s day', () => {
    // Ironman 10 h peak week, default weekday split: weekday cap 72 min (87
    // with the 15-min tolerance). The threshold run takes Monday; the easy run
    // fits no run-free weekday within its cap (Tuesday's swim plus the run is
    // 88 min). Before: step 4 put it on Monday beside the threshold run.
    const caps = { 0: 72, 1: 72, 2: 72, 3: 72, 4: 72, 5: 210, 6: 210 };
    const out = scheduleTriathlonWeek(
      [mk('Swim technique', 'swim_technique', 'swim', 48), mk('CSS intervals', 'swim_threshold', 'swim', 48)],
      [mk('Sweet spot', 'bike_sweet_spot', 'bike', 71), mk('Endurance ride', 'bike_endurance', 'bike', 71)],
      [mk('Threshold run', 'threshold', 'run', 40), mk('Easy run', 'easy', 'run', 40), mk('Long run', 'long', 'run', 115)],
      mk('Brick', 'brick', 'bike', 173),
      'peak', [], caps,
    );
    const day = (n: string) => out.find(w => w.n === n)!.dayOfWeek;
    expect(day('Threshold run')).toBe(0);
    expect(day('Easy run')).not.toBe(0);
    expect([5, 6]).not.toContain(day('Easy run'));
    for (let d = 0; d < 7; d++) {
      expect(out.filter(w => w.dayOfWeek === d && isRun(w)).length, DOW[d]).toBeLessThanOrEqual(1);
    }
    // Every session is still in the week.
    expect(out).toHaveLength(8);
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

describe('scheduleTriathlonWeek in race week: no discipline twice on one day', () => {
  const rides = () => [1, 2, 3, 4, 5].map(i => mk(`Ride ${i}`, 'bike_endurance', 'bike', 30));
  const show = (ws: Workout[]) => ws.map(w => `${DOW[w.dayOfWeek!]}:${w.n}`);

  it('five rides take Tuesday, Thursday, Friday and Saturday; the fifth is left out (Sunday is the race\'s slot)', () => {
    // Before: the capacity fallback stacked the fifth ride on Saturday, the day before a Sunday race.
    const out = scheduleTriathlonWeek([], rides(), [], null, 'taper', [], undefined, true);
    expect(show(out)).toEqual(['Tue:Ride 1', 'Thu:Ride 2', 'Fri:Ride 3', 'Sat:Ride 5']);
  });

  it('a weekend cap of 0 (race week\'s hours under the weekday hours): no second ride on Tuesday', () => {
    // Before: two 30-min rides on one Tuesday (a Monday race in the review sweep).
    const caps = { 0: 90, 1: 90, 2: 90, 3: 90, 4: 90, 5: 0, 6: 0 };
    const out = scheduleTriathlonWeek([], rides(), [], null, 'taper', [], caps, true);
    const days = out.map(w => w.dayOfWeek);
    expect(new Set(days).size).toBe(days.length);
    expect(days).not.toContain(6);
  });

  it('outside race week the capacity fallback is unchanged', () => {
    const out = scheduleTriathlonWeek([], rides(), [], null, 'build', [], { 0: 0, 1: 30, 2: 0, 3: 30, 4: 30, 5: 30, 6: 0 });
    expect(out).toHaveLength(5);
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
    const weekdayDoubles: string[] = [];
    let weeks = 0;
    for (const dist of ['sprint', 'olympic', 't100', '70.3', 'ironman'] as const) {
      for (const lvl of ['beginner', 'intermediate', 'advanced']) {
        for (const hrs of [4, 6, 8, 10, 12, 15]) {
          // null: the default weekday split (plan_engine: 40% of the hours).
          for (const weekdayFrac of [0, 0.2, 0.4, 0.6, null]) {
            for (const commute of ['none', 'one-way', 'both'] as const) {
              // Sundays, plus a Wednesday race.
              for (const race of ['2027-01-24', '2027-03-14', '2027-03-10']) {
                resetState();
                initializeTriathlonSimulator({
                  ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
                  trainingMode: 'triathlon', triDistance: dist, experienceLevel: lvl, customRaceDate: race,
                  triTimeAvailableHoursPerWeek: hrs,
                  ...(weekdayFrac == null ? {} : { triWeekdayHoursPerWeek: Math.round(hrs * weekdayFrac * 2) / 2 }),
                } as unknown as OnboardingState);
                const s = getMutableState();
                if (commute !== 'none') {
                  s.commuteConfig = { enabled: true, distanceKm: 6, isBidirectional: commute === 'both', commuteDaysPerWeek: 2 };
                  s.wks = generateTriathlonPlan(s);
                }
                weeks += s.wks.length;
                const tag = `${dist} ${lvl} ${hrs}h weekday ${weekdayFrac ?? 'default'} ${commute} ${race}`;
                for (const hit of runDoublesOnAnchorDays(s.wks)) found.push(`${tag} ${hit}`);
                for (const hit of weekdayRunDoubles(s.wks)) weekdayDoubles.push(`${tag} ${hit}`);
              }
            }
          }
        }
      }
    }
    expect(weeks).toBeGreaterThan(80000);
    expect(found.slice(0, 5)).toEqual([]);
    // No weekday holds two runs other than commutes (33 + 9 weeks of the
    // narrower first sweep before step 3b).
    expect(weekdayDoubles.slice(0, 5)).toEqual([]);
  });

  it('Ironman 10 h, default weekday split, every ability: no weekday holds two runs', () => {
    at('2026-10-04T12:00:00');
    for (const lvl of ['beginner', 'intermediate', 'advanced']) {
      resetState();
      initializeTriathlonSimulator({
        ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
        trainingMode: 'triathlon', triDistance: 'ironman', experienceLevel: lvl, customRaceDate: '2027-03-14',
        triTimeAvailableHoursPerWeek: 10,
      } as unknown as OnboardingState);
      const s = getState();
      expect(weekdayRunDoubles(s.wks), lvl).toEqual([]);
      expect(runDoublesOnAnchorDays(s.wks), lvl).toEqual([]);
    }
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
