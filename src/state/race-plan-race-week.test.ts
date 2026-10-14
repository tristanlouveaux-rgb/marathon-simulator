/**
 * Triathlon (sprint, olympic, 70.3, Ironman), cycling and HYROX plans place
 * race week relative to race day for every race weekday, on the running layout
 * (raceWeekLayout, storedPlanRaceLayout):
 *   - race week (taper, race-week content) is the week holding race day minus 3;
 *   - a Monday to Wednesday race's own week is a closing week. It holds only
 *     the race, except a Tuesday or Wednesday triathlon or cycling race's
 *     day-before activation (decision 3, 2026-10-14: a spin of at most 30
 *     min and a jog of at most 10, the day before race day); HYROX's stays
 *     empty;
 *   - the 6 days before race day hold race-week sessions only: no long run,
 *     brick or long ride, nothing from a peak (or any non-race) week; the
 *     60-min race-week brick of a long-course plan (Byrn, tri-taper.ts) is
 *     race-week content;
 *   - nothing on or after race day, and the plan's final week holds race day.
 *
 * "The 7 days before race day" is read as the 7-day week ending on race day:
 * the 6 days R-6 to R-1 (RACE_DAY_CLEAR_DAYS) carry no peak-phase or long
 * session. R-7 may still hold the last long session, as running rule 3 puts
 * it (latest long-run day 7 days out, race-day-rules.ts): every Sunday race
 * keeps its last long run on the Sunday before, and a Thursday to Saturday
 * race gets its long run moved to R-7 and its brick to R-8. The literal
 * R-7 to R-1 reading would move every Sunday race's last long run and needs
 * running rule 3 to change with it (open for Tristan, 2026-10-08).
 *
 * Before (13ae3b2): the final calendar week was race week whatever the race
 * weekday, so a Monday race got the full peak week (a 166-min brick on the
 * Saturday, an 85-min long run on the Sunday) in the 2 days before race day and
 * an empty race week; a Wednesday HYROX race got the peak HYROX brick 4 days
 * out. A Thursday to Saturday race kept the week before race week's weekend
 * (brick, long run) 4 to 6 days out.
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
import { initializeHyroxSimulator } from './initialization.hyrox';
import { getState, resetState } from './store';
import { raceWeekLayout } from '@/workouts/race-week-layout';
import { RACE_DAY_CLEAR_DAYS } from '@/workouts/race-day-rules';
import { regenerateTriathlonWeek } from '@/workouts/plan_engine.triathlon';
import { regenerateHyroxWeek } from '@/workouts/plan_engine.hyrox';
import { isLongRun } from '@/workouts/long-run';
import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Workout } from '@/types';

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

type Mode = 'sprint' | 'olympic' | '70.3' | 'ironman' | 'cycling' | 'hyrox';
const MODES: Mode[] = ['sprint', 'olympic', '70.3', 'ironman', 'cycling', 'hyrox'];

function build(mode: Mode, race: string): SimulatorState {
  resetState();
  if (mode === 'cycling') {
    initializeCyclingSimulator({
      trainingMode: 'cycling', cyclingDistance: '160km', experienceLevel: 'intermediate', customRaceDate: race,
    } as OnboardingState);
  } else if (mode === 'hyrox') {
    initializeHyroxSimulator({
      trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
      triTimeAvailableHoursPerWeek: 8, customRaceDate: race,
    } as OnboardingState);
  } else {
    initializeTriathlonSimulator({
      trainingMode: 'triathlon', triDistance: mode, experienceLevel: 'intermediate', customRaceDate: race,
    } as OnboardingState);
  }
  return getState();
}

/** Long run, triathlon brick, solo long ride, full HYROX brick. The 60-min
 *  race-week brick of a long-course plan (Byrn; tri-taper.ts, taperRole
 *  'opener') is race-week content, not a long session. */
function isLongSession(w: Workout): boolean {
  if (w.t === 'brick' && w.taperRole === 'opener') return false;
  return isLongRun(w) || w.t === 'brick' || w.t === 'hyrox_brick' || w.longRide === true;
}

// Race weekdays Monday 16 to Sunday 22 November 2026.
const RACES = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Onboarding on a Sunday (plan starts Monday 5 Oct) and on a Wednesday (Monday 12 Oct).
const ONBOARDING: Array<[string, string]> = [['Sunday', '2026-10-11T12:00:00'], ['Wednesday', '2026-10-14T12:00:00']];

describe('race week sits relative to race day for every race weekday', () => {
  for (const [onboardDay, now] of ONBOARDING) {
    for (const mode of MODES) {
      for (const race of RACES) {
        const label = `${mode}, ${DOW[RACES.indexOf(race)]} race, ${onboardDay} onboarding`;
        it(label, () => {
          at(now);
          const s = build(mode, race);
          const layout = raceWeekLayout(s.planStartDate!, race)!;
          const R = layout.raceDayIndex;
          const raceWeek = layout.trainingWeeks;

          // The plan runs through the calendar week holding race day.
          expect(s.tw).toBe(layout.calendarWeeks);
          expect(s.wks.length).toBe(s.tw);
          expect(Math.floor(R / 7) + 1).toBe(s.tw);
          // Monday to Wednesday races (and only those) close with a race-day
          // week holding only the race and, for a Tuesday or Wednesday
          // triathlon or cycling race, the day-before activation.
          expect(layout.closingWeek).toBe(RACES.indexOf(race) <= 2);
          if (layout.closingWeek) {
            expect(s.wks[s.tw - 1].raceClosing).toBe(true);
            expect(s.wks[s.tw - 1].ph).toBe('taper');
            const closing = s.wks[s.tw - 1].triWorkouts ?? [];
            if (mode === 'hyrox' || layout.raceDayOfWeek === 0) expect(closing).toEqual([]);
            else {
              expect(closing.length, 'day-before activation').toBeGreaterThan(0);
              for (const w of closing) {
                expect(w.taperRole, w.n).toBe('day_before');
                expect(w.dayOfWeek, w.n).toBe(layout.raceDayOfWeek - 1);
                expect(w.estimatedDurationMin ?? 0, w.n).toBeLessThanOrEqual(w.discipline === 'bike' ? 30 : 10);
              }
              expect(new Set(closing.map(w => w.id)).size).toBe(closing.length);
            }
          }
          expect(s.wks.filter(w => w.raceClosing).length).toBe(layout.closingWeek ? 1 : 0);

          // Race week: taper, and the race is its long effort.
          expect(s.wks[raceWeek - 1].ph).toBe('taper');
          for (const w of s.wks[raceWeek - 1].triWorkouts ?? []) expect(isLongSession(w), w.n).toBe(false);

          for (const wk of s.wks) {
            for (const w of wk.triWorkouts ?? []) {
              if (w.dayOfWeek == null) continue;
              const daysOut = R - ((wk.w - 1) * 7 + w.dayOfWeek);
              // Nothing on or after race day.
              expect(daysOut, `w${wk.w} ${w.n} on or after race day`).toBeGreaterThan(0);
              if (daysOut > RACE_DAY_CLEAR_DAYS) continue;
              // The 6 days before race day: race-week sessions only, and the
              // closing week's day-before activation.
              if (wk.raceClosing) {
                expect(w.taperRole, `w${wk.w} ${w.n}`).toBe('day_before');
                expect(daysOut, `w${wk.w} ${w.n}`).toBe(1);
                continue;
              }
              expect(wk.w, `w${wk.w} ${DOW[w.dayOfWeek]} ${w.n}, ${daysOut} days out`).toBe(raceWeek);
              expect(wk.ph, `w${wk.w} ${w.n}`).toBe('taper');
              expect(isLongSession(w), `w${wk.w} ${w.n}, ${daysOut} days out`).toBe(false);
            }
          }

          // The week before race week keeps its long sessions, 7 or more days out.
          const before = s.wks[raceWeek - 2].triWorkouts ?? [];
          if (mode === 'cycling') expect(before.some(w => w.longRide), 'long ride').toBe(true);
          else if (mode === 'hyrox') expect(before.some(w => w.t === 'hyrox_brick'), 'HYROX brick').toBe(true);
          else {
            expect(before.some(w => isLongRun(w)), 'long run').toBe(true);
            expect(before.some(w => w.t === 'brick' || w.longRide), 'brick or long ride').toBe(true);
          }
        });
      }
    }
  }
});

describe('a Monday to Wednesday race trains like the Sunday before it', () => {
  // Running parity (raceWeekLayout): a Tuesday race does not get an extra week
  // of training over the Sunday before. The training weeks match the Sunday
  // 15 November plan; the closing week holds only the race.
  for (const mode of MODES) {
    it(mode, () => {
      at('2026-10-11T12:00:00');
      const sunday = build(mode, '2026-11-15');
      const sundayWeeks = sunday.wks.map(w => ({ ph: w.ph, ws: w.triWorkouts }));
      expect(sunday.tw).toBe(6);
      for (const race of ['2026-11-16', '2026-11-17', '2026-11-18']) {
        const s = build(mode, race);
        expect(s.tw).toBe(7);
        expect(s.wks.slice(0, 6).map(w => w.ph)).toEqual(sundayWeeks.map(w => w.ph));
        // Weeks before race week are identical.
        expect(s.wks.slice(0, 5).map(w => w.triWorkouts)).toEqual(sundayWeeks.slice(0, 5).map(w => w.ws));
        // Race week: the same volume per discipline (the same reference week
        // and fraction). Its sessions sit relative to their own race day, so
        // they differ for triathlon and cycling (tri-taper.ts: the day-before
        // activation and the rest day 2 days out exist only when those days
        // fall in race week); within one floor-length session per discipline.
        if (mode === 'hyrox') {
          const content = (ws: Workout[] | undefined) => (ws ?? []).map(w => `${w.t}|${w.n}|${w.estimatedDurationMin}`).sort();
          expect(content(s.wks[5].triWorkouts), `${mode} ${race}`).toEqual(content(sundayWeeks[5].ws));
        } else {
          const perDisc = (ws: Workout[] | undefined) => {
            const m: Record<string, number> = { swim: 0, bike: 0, run: 0 };
            for (const w of ws ?? []) {
              if (w.t === 'gym' || w.commute) continue;
              if (w.t === 'brick' && w.brickSegments) for (const sg of w.brickSegments) m[sg.discipline] += sg.durationMin ?? 0;
              else m[w.discipline ?? 'run'] += w.estimatedDurationMin ?? 0;
            }
            return m;
          };
          // A Tuesday or Wednesday race's day-before activation sits in the closing week.
          const a = perDisc([...(s.wks[5].triWorkouts ?? []), ...(s.wks[6].triWorkouts ?? [])]);
          const b = perDisc(sundayWeeks[5].ws);
          for (const d of ['swim', 'bike', 'run']) expect(Math.abs(a[d] - b[d]), `${mode} ${race} ${d}: ${a[d]} vs ${b[d]}`).toBeLessThanOrEqual(20);
        }
      }
    });
  }
});

describe('regenerating a single week keeps the layout', () => {
  it('triathlon: the closing week stays empty (Monday race) or keeps its day-before activation (Wednesday race), and race week matches the plan', () => {
    at('2026-10-11T12:00:00');
    const s = build('70.3', '2026-11-16');
    expect(regenerateTriathlonWeek(s, 7)).toMatchObject({ ph: 'taper', raceClosing: true, triWorkouts: [] });
    expect(regenerateTriathlonWeek(s, 6)?.triWorkouts).toEqual(s.wks[5].triWorkouts);
    expect(regenerateTriathlonWeek(s, 5)?.triWorkouts).toEqual(s.wks[4].triWorkouts);
    const wed = build('70.3', '2026-11-18');
    expect((wed.wks[6].triWorkouts ?? []).length).toBeGreaterThan(0);
    expect(regenerateTriathlonWeek(wed, 7)).toMatchObject({ ph: 'taper', raceClosing: true, triWorkouts: wed.wks[6].triWorkouts });
    expect(regenerateTriathlonWeek(wed, 6)?.triWorkouts).toEqual(wed.wks[5].triWorkouts);
  });

  it('HYROX: the closing week stays empty and the week before race week matches the plan', () => {
    at('2026-10-11T12:00:00');
    const s = build('hyrox', '2026-11-18');
    expect(regenerateHyroxWeek(s, 7)).toMatchObject({ ph: 'taper', raceClosing: true, triWorkouts: [] });
    expect(regenerateHyroxWeek(s, 6)?.triWorkouts).toEqual(s.wks[5].triWorkouts);
    const thursday = build('hyrox', '2026-11-19');
    expect(regenerateHyroxWeek(thursday, 6)?.triWorkouts).toEqual(thursday.wks[5].triWorkouts);
  });
});

describe('a race 8 days after a midweek onboarding', () => {
  it('moves the week-1 long sessions no earlier than the onboarding day', () => {
    // Onboarding Wednesday 14 Oct, Thursday race 22 Oct: race week is week 2,
    // week 1's Friday to Sunday are 6 to 4 days out.
    at('2026-10-14T12:00:00');
    for (const mode of MODES) {
      const s = build(mode, '2026-10-22');
      const layout = raceWeekLayout(s.planStartDate!, '2026-10-22')!;
      expect(layout.trainingWeeks).toBe(2);
      for (const w of s.wks[0].triWorkouts ?? []) {
        const daysOut = layout.raceDayIndex - (w.dayOfWeek ?? 0);
        expect(daysOut, `${mode} ${w.n}`).toBeGreaterThan(RACE_DAY_CLEAR_DAYS);
        if (isLongSession(w)) expect(w.dayOfWeek!, `${mode} ${w.n}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
