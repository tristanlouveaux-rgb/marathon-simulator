/**
 * Sharpening block at plan build: a marathon under 8 weeks or a half under 4
 * builds the block layout and freezes the block's start inputs on
 * s.sharpenBlock; a full plan clears them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
