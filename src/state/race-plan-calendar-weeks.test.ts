/**
 * Stored-plan modes (triathlon, cycling, HYROX) run on race day's calendar:
 * the plan's final week is the calendar week holding race day (approved
 * default Q10, local calendar dates in every mode; running got this in
 * 6c29020 via raceWeekLayout).
 *
 * Before: plan length was calculateWeeksUntil(raceDate) = ceil(days from today
 * / 7), stored as s.tw while planStartDate is the local Monday. Whenever the
 * race weekday is on or before the onboarding weekday the race fell in the
 * week after the plan ended: onboarding Sunday 11 Oct 2026 for a Sunday race on
 * 15 Nov 2026 gave tw=5, so week 5 (2 to 8 Nov) acted as race week (no long
 * run, empty Sunday) and the race's own week (9 to 15 Nov) was not in the plan.
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
import { raceWeekLayout, racePlanCalendarWeeks } from '@/workouts/race-week-layout';
import { isLongRun } from '@/workouts/long-run';
import type { OnboardingState } from '@/types/onboarding';

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

// [label, onboarding local time, race date, weeks the old weeks-until count gave]
const CASES: Array<[string, string, string, number]> = [
  ['Sunday onboarding, Sunday race', '2026-10-11T12:00:00', '2026-11-15', 5],
  ['Saturday onboarding, Saturday race', '2026-10-10T12:00:00', '2026-11-14', 5],
  ['Sunday onboarding, Saturday race', '2026-10-11T12:00:00', '2026-11-14', 5],
];

describe('racePlanCalendarWeeks', () => {
  it('counts the calendar weeks from the local Monday through the week holding race day', () => {
    for (const [label, now, race] of CASES) {
      at(now);
      expect(racePlanCalendarWeeks(race), label).toBe(6);
      vi.useRealTimers();
    }
  });

  it('agrees with the weeks-until count when onboarding on the Monday', () => {
    at('2026-10-05T12:00:00');
    expect(racePlanCalendarWeeks('2026-11-15')).toBe(6);
  });

  it('is null without a race date or for a race before the plan starts', () => {
    at('2026-10-11T12:00:00');
    expect(racePlanCalendarWeeks(null)).toBeNull();
    expect(racePlanCalendarWeeks('2026-10-04')).toBeNull();
  });
});

const MODES: Array<[string, (race: string, staleWeeks: number) => unknown]> = [
  ['triathlon 70.3', (race, weeks) => initializeTriathlonSimulator({
    trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
    customRaceDate: race, planDurationWeeks: weeks,
  } as OnboardingState)],
  ['triathlon ironman', (race, weeks) => initializeTriathlonSimulator({
    trainingMode: 'triathlon', triDistance: 'ironman', experienceLevel: 'intermediate',
    customRaceDate: race, planDurationWeeks: weeks,
  } as OnboardingState)],
  ['cycling', (race, weeks) => initializeCyclingSimulator({
    trainingMode: 'cycling', cyclingDistance: '160km', experienceLevel: 'intermediate',
    customRaceDate: race, planDurationWeeks: weeks,
  } as OnboardingState)],
  ['hyrox', (race, weeks) => initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, customRaceDate: race, planDurationWeeks: weeks,
  } as OnboardingState)],
];

describe('triathlon, cycling and HYROX plans end in the week holding race day', () => {
  for (const [mode, init] of MODES) {
    for (const [label, now, race, staleWeeks] of CASES) {
      it(`${mode}, ${label}: the final plan week holds race day, even with a weeks-until count from the wizard`, () => {
        at(now);
        resetState();
        init(race, staleWeeks);
        const s = getState();
        const layout = raceWeekLayout(s.planStartDate!, race)!;
        expect(s.tw).toBe(6);
        expect(s.tw).toBe(layout.calendarWeeks);
        expect(s.wks.length).toBe(s.tw);
        if (s.triConfig) expect(s.triConfig.weeksToRace).toBe(s.tw);
        // Race week (the final week) has nothing on or after race day.
        const finalWeek = s.wks[s.tw - 1].triWorkouts ?? [];
        for (const w of finalWeek) {
          if (w.dayOfWeek != null) expect(w.dayOfWeek, w.n).toBeLessThan(layout.raceDayOfWeek);
        }
        // The week before race week is a training week: running modes keep its long run.
        if (mode.startsWith('triathlon')) {
          expect(finalWeek.some(w => isLongRun(w))).toBe(false);
          expect((s.wks[s.tw - 2].triWorkouts ?? []).some(w => isLongRun(w))).toBe(true);
        }
      });
    }
  }
});
