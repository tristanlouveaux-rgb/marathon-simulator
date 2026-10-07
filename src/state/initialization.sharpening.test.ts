/**
 * Sharpening block at plan build: a marathon under 8 weeks or a half under 4
 * builds the block layout and freezes the block's start inputs on
 * s.sharpenBlock; a full plan clears them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';

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

import { initializeSimulator } from './initialization';
import { getMutableState, getState } from './store';
import { generateWeekWorkouts } from '@/workouts/generator';
import { planTrainingWeeks } from '@/workouts/race-week-layout';
import { calendarDayNumber } from '@/utils/local-date';

function onboarding(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    trainingMode: 'running',
    trainingForEvent: true,
    raceDistance: 'marathon',
    planDurationWeeks: 6,
    runsPerWeek: 4,
    pbs: { k10: 2700 },
    experienceLevel: 'intermediate',
    ...overrides,
  } as OnboardingState;
}

function resetState() {
  const s = getMutableState();
  s.eventType = undefined as any;
  s.triConfig = undefined;
  s.hyroxConfig = undefined;
  s.wks = undefined as any;
  s.previousPlanWks = undefined;
  s.wkm = undefined as any;
  s.detectedWeeklyKm = undefined;
  s.onboardingRunHistory = undefined;
  s.sharpenBlock = undefined;
  s.trackOnly = false;
  localStorageMock.clear();
}

describe('initializeSimulator: sharpening block', () => {
  beforeEach(() => resetState());

  it('a 6-week marathon builds the block layout and stores the 30-day longest run as the start', () => {
    getMutableState().onboardingRunHistory = [
      { startTime: new Date(Date.now() - 5 * 86400000).toISOString(), distKm: 18, durSec: 6000, activityType: 'RUNNING' },
    ];
    const r = initializeSimulator(onboarding());
    expect(r.success).toBe(true);
    const s = getState();
    expect(s.wks.map(w => w.ph)).toEqual(['build', 'build', 'build', 'peak', 'taper', 'taper']);
    expect(s.sharpenBlock).toMatchObject({ v: 1, startSource: 'history-30d', trainingWeeks: 6, noSignal: false });
    expect(s.sharpenBlock!.startLongMin).toBe(Math.round(18 * s.pac.e / 60));
  });

  it('a 16-week marathon is a full plan: no block state, base weeks kept', () => {
    getMutableState().sharpenBlock = { v: 1, startLongMin: 90, startSource: 'no-data', recentLongestMin: null, noSignal: true, trainingWeeks: 6, builtISO: '2026-01-01' };
    initializeSimulator(onboarding({ planDurationWeeks: 16 }));
    const s = getState();
    expect(s.sharpenBlock).toBeUndefined();
    expect(s.wks[0].ph).toBe('base');
  });

  it('a 3-week half with no logged runs starts from the no-data anchor', () => {
    initializeSimulator(onboarding({ raceDistance: 'half', planDurationWeeks: 3 }));
    const s = getState();
    expect(s.wks.map(w => w.ph)).toEqual(['build', 'peak', 'taper']);
    expect(s.sharpenBlock).toMatchObject({ startSource: 'no-data', startLongMin: 64 });
  });
});

describe('initializeSimulator: the plan calendar runs to race day', () => {
  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 10, 0)); // Wednesday 7 October 2026, local
  });
  afterEach(() => vi.useRealTimers());

  it('a Monday race: race week is the week before, plus a closing week holding only the race', () => {
    // A week count from today (ceil(40 days / 7) = 6) would end the plan a week before race day.
    initializeSimulator(onboarding({ customRaceDate: '2026-11-16', planDurationWeeks: 7 }));
    const s = getState();
    expect(s.planStartDate).toBe('2026-10-05');
    expect(s.tw).toBe(7);
    expect(planTrainingWeeks(s)).toBe(6);
    expect(s.wks[6]).toMatchObject({ ph: 'taper', raceClosing: true });
    expect(s.wks.slice(0, 6).map(w => w.ph)).toEqual(['build', 'build', 'build', 'peak', 'taper', 'taper']);
    // Race day falls inside the closing week, so s.w > s.tw ("Plan complete")
    // can only happen after race day.
    const startDay = calendarDayNumber(s.planStartDate!);
    const raceDay = calendarDayNumber('2026-11-16');
    expect(raceDay - startDay).toBeGreaterThanOrEqual((s.tw - 1) * 7);
    expect(raceDay - startDay).toBeLessThan(s.tw * 7);
    // The closing week generates nothing.
    const ws = generateWeekWorkouts(s.wks[6].ph, s.rw, s.rd, s.typ, [], undefined, null, undefined, 'intermediate', undefined, s.pac.e, 7, s.tw, s.v, 0);
    expect(ws).toEqual([]);
  });

  it('a Sunday race: no closing week; s.tw is the calendar week holding race day', () => {
    initializeSimulator(onboarding({ customRaceDate: '2026-11-15', planDurationWeeks: 6 }));
    const s = getState();
    expect(s.tw).toBe(6);
    expect(s.wks.some(w => w.raceClosing)).toBe(false);
    const raceDay = calendarDayNumber('2026-11-15') - calendarDayNumber(s.planStartDate!);
    expect(Math.floor(raceDay / 7) + 1).toBe(s.tw);
  });

  it('a custom date replaces an earlier event pick as the race date', () => {
    getMutableState().selectedMarathon = { id: 'old', name: 'Old', city: '', country: '', date: '2027-04-25', distance: 'marathon' } as any;
    initializeSimulator(onboarding({ customRaceDate: '2026-11-15', selectedRace: null }));
    expect(getState().selectedMarathon).toBeUndefined();
  });
});

describe('initializeSimulator: a block anchors its forecast on the volume it delivers', () => {
  beforeEach(() => resetState());

  it('a low-volume runner: the block anchor (its own peak week) is slower than a full plan\'s (the ramp destination)', () => {
    const history = () => {
      const m = getMutableState();
      m.detectedWeeklyKm = 20;
      m.stravaHistoryAccepted = true;
      m.athleteArchetype = { archetype: 'consistent-runner' } as any;
      m.onboardingRunHistory = [
        { startTime: new Date(Date.now() - 4 * 86400000).toISOString(), distKm: 10, durSec: 3600, activityType: 'RUNNING' },
      ];
    };
    history();
    initializeSimulator(onboarding({ planDurationWeeks: 5 }));
    const block = getState().forecastBlendAnchorSec!;
    expect(getState().sharpenBlock).toBeDefined();
    resetState();
    history();
    initializeSimulator(onboarding({ planDurationWeeks: 16 }));
    const full = getState().forecastBlendAnchorSec!;
    expect(getState().sharpenBlock).toBeUndefined();
    expect(block).toBeGreaterThan(full);
  });
});
