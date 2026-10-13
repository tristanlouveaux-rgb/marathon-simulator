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
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { HYROX_PRO_STATION_MULTIPLIER } from '@/constants/hyrox-constants';

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
    // Singles terms via the data ratio (doublesTotalInSinglesTermsSec):
    // 3600 → about 4053 (67:33) → advanced (sub-80 min singles).
    // Pre-fix: 3600 × 0.92 = 3312 → competitive (sub-60). Confirms direction.
    expect(getState().hyroxConfig!.athleteBand).toBe('advanced');
  });

  it('70-min doubles previous + singles target → advanced, the same band as a doubles target', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_singles',
      hyroxPreviousTimeFormat: 'open_doubles',
      previousHyroxTimeSec: 4200,            // 1:10:00 doubles, about P22 of the doubles field
      hyroxPreviousStationSplits: undefined,
    }));
    // Singles terms via the data ratio: about 4724 (78:44) → advanced
    // (sub-80 min singles). The old × 1.22 rule read 85:24 → intermediate,
    // while a doubles target banded the same time on the data ratio.
    expect(getState().hyroxConfig!.athleteBand).toBe('advanced');
    resetState();
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_doubles',
      hyroxPreviousTimeFormat: 'open_doubles',
      previousHyroxTimeSec: 4200,
      hyroxPreviousStationSplits: undefined,
    }));
    expect(getState().hyroxConfig!.athleteBand).toBe('advanced');
  });

  it('60-min singles previous + doubles target → the singles band (advanced)', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'open_doubles',
      hyroxPreviousTimeFormat: 'open_singles',
      previousHyroxTimeSec: 3600,            // 1:00:00 singles
      hyroxPreviousStationSplits: undefined,
    }));
    // Bands on singles terms: 3600 is not under 3600 → advanced. The old rule
    // (× 0.85 = 3060 → competitive) banded on doubles terms, and the doubles
    // forecast then scaled that band's seeds by the doubles ratio again.
    expect(getState().hyroxConfig!.athleteBand).toBe('advanced');
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

describe('initializeHyroxSimulator: Pro-weight splits and division', () => {
  beforeEach(() => resetState());

  it('splits from a Pro race are recorded as Pro-weight race entries (no second Pro multiplier)', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'pro_singles',
      hyroxPreviousTimeFormat: 'pro_singles',
    }));
    const hx = getState().hyroxConfig!;
    const entry = hx.stationBenchmarkHistory?.sled_push?.[0];
    expect(entry).toMatchObject({ sec: SAMPLE_SPLITS.sled_push, source: 'race', format: 'pro_singles', proWeights: true });
    // The config-wide flag describes station tests and stays unset.
    expect(hx.benchmarksAtProWeights).toBeUndefined();
    const line = predictHyroxRace(getState())!.stations.find(l => l.station === 'sled_push')!;
    expect(line.baseSec).toBeCloseTo(SAMPLE_SPLITS.sled_push, 6);
  });

  it('splits from an Open race are Open-weight race entries; a Pro target applies the multiplier once', () => {
    initializeHyroxSimulator(buildOnboarding({
      hyroxFormat: 'pro_singles',
      hyroxPreviousTimeFormat: 'open_singles',
    }));
    const hx = getState().hyroxConfig!;
    expect(hx.stationBenchmarkHistory?.sled_push?.[0]).toMatchObject({ source: 'race', format: 'open_singles', proWeights: false });
    expect(hx.benchmarksAtProWeights).toBeUndefined();
    const line = predictHyroxRace(getState())!.stations.find(l => l.station === 'sled_push')!;
    expect(line.baseSec).toBeCloseTo(SAMPLE_SPLITS.sled_push * HYROX_PRO_STATION_MULTIPLIER.sled_push!, 6);
  });

  it('copies the division pick to hyroxConfig.division', () => {
    initializeHyroxSimulator(buildOnboarding({ hyroxFormat: 'open_doubles', hyroxDivision: 'mixed' }));
    expect(getState().hyroxConfig!.division).toBe('mixed');
  });
});
