/**
 * Easy synced runs must not lower the engine VDOT.
 *
 * TRACKING side: the engine VDOT (s.v) describes demonstrated running fitness.
 * Pre-fix, `computePredictionInputs` handed the newest run of ANY effort to
 * every consumer as the "recent race" (`recentRun`). The blend projected it to
 * the target distance as a race performance, and the engine floor
 * (initialization.ts, refreshBlendedFitness) read the slower projection as
 * "demonstrated recent slowness" (SCIENCE_LOG §BZ) and stood down. A 10K 45:00
 * runner (VDOT 45.3) seeded with easy runs at about 5:50/km came out at VDOT
 * 37.3 after onboarding and 39.3 after the first refresh, the same with a
 * zone-2 heart rate as without one, which put the plan on the novice 3-week
 * deload cycle (plan_engine isDeloadWeek).
 *
 * Post-fix the recent run is the newest race effort (more than 15% faster
 * than the window's median pace, RACE_FILTER_RATIO in prediction-inputs.ts,
 * the hard-effort definition in SCIENCE_LOG "Effort-Calibrated VDOT from HR").
 * Seeds mirror the developer QA harness scenarios (fewer-runs, marathon16).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';

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
import { getMutableState, getState, resetState } from './store';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { abilityBandFromVdot, isDeloadWeek } from '@/workouts/plan_engine';
import { localMondayKey } from '@/utils/local-date';
import type { SimulatorState } from '@/types/state';

const DAY_MS = 86400000;

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

type RunRow = NonNullable<SimulatorState['onboardingRunHistory']>[number];

/** `weeks` weeks of runs; each entry of `week` is [dayOffsetInWeek, km, min]. */
function history(weeks: number, week: Array<[number, number, number]>, avgHR?: number, startDaysAgo = 2): RunRow[] {
  const rows: RunRow[] = [];
  for (let k = 0; k < weeks; k++) {
    for (const [off, km, min] of week) {
      const d = new Date(Date.now() - (startDaysAgo + k * 7 + off) * DAY_MS);
      d.setHours(8, 0, 0, 0);
      rows.push({
        startTime: d.toISOString(), distKm: km, durSec: Math.round(min * 60), activityType: 'RUNNING',
        ...(avgHR != null ? { avgHR } : {}),
      });
    }
  }
  return rows;
}

function onboarding(over: Partial<OnboardingState> = {}): OnboardingState {
  return {
    ...defaultOnboardingState,
    name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
    raceDistance: 'marathon', selectedRace: null, hasSmartwatch: true,
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
    experienceLevel: 'intermediate', pbs: { k10: 2700 },
    ...over,
  } as OnboardingState;
}

function seed(over: Partial<SimulatorState>): void {
  resetState();
  localStorageMock.clear();
  Object.assign(getMutableState(), {
    unitPref: 'km', detectedWeeklyKm: 35, weeklyVolumeConfirmed: true,
    athleteArchetype: { archetype: 'consistent-runner' } as SimulatorState['athleteArchetype'],
    ...over,
  });
}

/** 6 weeks of easy running for a 10K 45:00 runner: about 5:50/km, 35 km a week. */
const EASY_WEEK: Array<[number, number, number]> = [[0, 16, 94], [2, 8, 46], [4, 6, 35], [5, 5, 29]];
/** maxHR 190, resting 50: avg HR 140 is 64% of heart-rate reserve, zone 2. */
const HR = { maxHR: 190, restingHR: 50 };
const ZONE2_AVG_HR = 140;

/** Engine VDOT of the same athlete with no synced runs: the 10K PB's capacity. */
function noHistoryVdot(): number {
  seed({});
  expect(initializeSimulator(onboarding()).success).toBe(true);
  return getState().v;
}

describe('easy synced runs do not lower the engine VDOT', () => {
  let capacity = 0;
  beforeEach(() => { capacity = noHistoryVdot(); });

  it('baseline: a 10K 45:00 runner with no history sits in the intermediate band', () => {
    expect(capacity).toBeCloseTo(45.3, 1);
    expect(abilityBandFromVdot(capacity, 'intermediate')).toBe('intermediate');
  });

  it('easy runs with a zone-2 heart rate keep the PB capacity, at onboarding and after a refresh', () => {
    seed({ ...HR, onboardingRunHistory: history(6, EASY_WEEK, ZONE2_AVG_HR) });
    expect(initializeSimulator(onboarding()).success).toBe(true);
    expect(getState().v).toBeCloseTo(capacity, 6);
    refreshBlendedFitness(getMutableState());
    expect(getState().v).toBeCloseTo(capacity, 6);
    // The 4-week intermediate cycle, not the novice 3-week cycle.
    const band = abilityBandFromVdot(getState().v, 'intermediate');
    expect(band).toBe('intermediate');
    expect(isDeloadWeek(3, band)).toBe(false);
    expect(isDeloadWeek(4, band)).toBe(true);
  });

  it('the same easy runs with no heart rate keep the PB capacity', () => {
    seed({ onboardingRunHistory: history(6, EASY_WEEK) });
    expect(initializeSimulator(onboarding()).success).toBe(true);
    expect(getState().v).toBeCloseTo(capacity, 6);
    refreshBlendedFitness(getMutableState());
    expect(getState().v).toBeCloseTo(capacity, 6);
  });

  it('QA harness fewer-runs seed (15 km a week, 2 easy runs a week) keeps the PB capacity', () => {
    seed({
      detectedWeeklyKm: 15, weeklyVolumeConfirmed: undefined, stravaHistoryAccepted: true,
      onboardingRunHistory: history(4, [[0, 10, 58], [3, 5, 29]]),
    });
    expect(initializeSimulator(onboarding({
      customRaceDate: planDay(5, 6), planDurationWeeks: 5, weeklyTrainingHours: 2,
    })).success).toBe(true);
    expect(getState().v).toBeCloseTo(capacity, 6);
  });

  it('a recent race effort slower than the PB still lowers the engine', () => {
    // A 10K in 48:20 (4:50/km) five days ago, among the easy runs: more than
    // 15% faster than the median pace, so it is a race, and it projects below
    // the 45:00 capacity. Demonstrated slowness (§BZ) still moves the engine.
    const race: RunRow = (() => {
      const d = new Date(Date.now() - 5 * DAY_MS);
      d.setHours(9, 0, 0, 0);
      return { startTime: d.toISOString(), distKm: 10, durSec: 2900, activityType: 'RUNNING' };
    })();
    seed({ onboardingRunHistory: [race, ...history(6, EASY_WEEK)] });
    expect(initializeSimulator(onboarding()).success).toBe(true);
    expect(getState().v).toBeLessThan(capacity - 1);
    refreshBlendedFitness(getMutableState());
    expect(getState().v).toBeLessThan(capacity - 1);
  });
});
