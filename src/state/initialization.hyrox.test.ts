/**
 * HYROX initialization slot-storage tests.
 *
 * Confirms that station benchmarks entered during onboarding land in the slot
 * matching the PREVIOUS-RACE format (where the splits came from), not the
 * target format. Pre-fix, the slot was keyed off target format, so a user
 * with a doubles previous race aiming at singles would get their doubles
 * splits stored as singles benchmarks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';

// Mock localStorage so saveState() inside the initializer doesn't throw.
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

import { initializeHyroxSimulator } from './initialization.hyrox';
import { getMutableState, getState } from './store';

const SAMPLE_SPLITS = {
  ski_erg: 250,
  sled_push: 130,
  sled_pull: 140,
  burpee_broad_jumps: 240,
};

function buildOnboarding(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    trainingMode: 'hyrox',
    hyroxFormat: 'open_singles',
    previousHyroxTimeSec: 4500,
    hyroxPreviousTimeFormat: 'open_singles',
    hyroxPreviousStationSplits: { ...SAMPLE_SPLITS },
    experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8,
    ...overrides,
  } as OnboardingState;
}

function resetState() {
  // Wipe relevant fields on the singleton state.
  const s = getMutableState();
  s.eventType = undefined as any;
  s.hyroxConfig = undefined as any;
  s.triConfig = undefined;
  localStorageMock.clear();
}

describe('initializeHyroxSimulator — benchmark slot routing', () => {
  beforeEach(() => resetState());

  it('singles target + singles previous → splits in Singles slot', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_singles',
      hyroxPreviousTimeFormat: 'open_singles',
    }));
    const hx = getState().hyroxConfig!;
    expect(hx.stationBenchmarksSingles).toEqual(SAMPLE_SPLITS);
    expect(hx.stationBenchmarksDoubles).toBeUndefined();
  });

  it('singles target + DOUBLES previous → splits in Doubles slot (Bug 3 fix)', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_singles',
      hyroxPreviousTimeFormat: 'open_doubles',
    }));
    const hx = getState().hyroxConfig!;
    expect(hx.stationBenchmarksDoubles).toEqual(SAMPLE_SPLITS);
    expect(hx.stationBenchmarksSingles).toBeUndefined();
  });

  it('doubles target + doubles previous → splits in Doubles slot', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_doubles',
      hyroxPreviousTimeFormat: 'open_doubles',
    }));
    const hx = getState().hyroxConfig!;
    expect(hx.stationBenchmarksDoubles).toEqual(SAMPLE_SPLITS);
    expect(hx.stationBenchmarksSingles).toBeUndefined();
  });

  it('singles target + missing prevTimeFormat → benchmark seeding skipped', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_singles',
      hyroxPreviousTimeFormat: undefined,
    }));
    const hx = getState().hyroxConfig!;
    expect(hx.stationBenchmarksSingles).toBeUndefined();
    expect(hx.stationBenchmarksDoubles).toBeUndefined();
  });

  it('pro_doubles previous → splits go to Doubles slot regardless of pro/open distinction', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'pro_singles',
      hyroxPreviousTimeFormat: 'pro_doubles',
    }));
    const hx = getState().hyroxConfig!;
    expect(hx.stationBenchmarksDoubles).toEqual(SAMPLE_SPLITS);
    expect(hx.stationBenchmarksSingles).toBeUndefined();
  });
});

describe('initializeHyroxSimulator — same-athlete cross-format band derivation (Bug 2)', () => {
  beforeEach(() => resetState());

  it('60-min doubles previous + singles target → advanced (NOT competitive — pre-fix bug)', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_singles',
      hyroxPreviousTimeFormat: 'open_doubles',
      previousHyroxTimeSec: 3600,            // 1:00:00 doubles
      hyroxPreviousStationSplits: undefined,
    }));
    // 3600 × 1.22 = 4392 (73:12) → advanced (sub-80 min singles).
    // Pre-fix: 3600 × 0.92 = 3312 → competitive (sub-60). Confirms direction flip.
    expect(getState().hyroxConfig!.athleteBand).toBe('advanced');
  });

  it('70-min doubles previous + singles target → intermediate', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_singles',
      hyroxPreviousTimeFormat: 'open_doubles',
      previousHyroxTimeSec: 4200,            // 1:10:00 doubles
      hyroxPreviousStationSplits: undefined,
    }));
    // 4200 × 1.22 = 5124 (85:24) → intermediate (sub-100 min singles).
    expect(getState().hyroxConfig!.athleteBand).toBe('intermediate');
  });

  it('60-min singles previous + doubles target → competitive doubles band', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_doubles',
      hyroxPreviousTimeFormat: 'open_singles',
      previousHyroxTimeSec: 3600,            // 1:00:00 singles
      hyroxPreviousStationSplits: undefined,
    }));
    // 3600 × 0.85 = 3060 → bandFromTime(<3600) → competitive.
    expect(getState().hyroxConfig!.athleteBand).toBe('competitive');
  });

  it('same-format previous and target → no factor applied', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_singles',
      hyroxPreviousTimeFormat: 'open_singles',
      previousHyroxTimeSec: 4500,            // 1:15:00 singles
      hyroxPreviousStationSplits: undefined,
    }));
    // 4500 → bandFromTime(<4800) → advanced (sub-1:20:00 singles).
    expect(getState().hyroxConfig!.athleteBand).toBe('advanced');
  });

  it('missing prevFmt → falls back to experience-level band', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_singles',
      hyroxPreviousTimeFormat: undefined,
      previousHyroxTimeSec: 4500,
      hyroxPreviousStationSplits: undefined,
    }));
    // prevFormatKnown=false → adjustedPrevTimeSec=null → bandFromExperience('intermediate')
    expect(getState().hyroxConfig!.athleteBand).toBe('intermediate');
  });
});
