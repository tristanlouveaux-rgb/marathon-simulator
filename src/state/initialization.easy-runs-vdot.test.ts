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
import { initializeTriathlonSimulator } from './initialization.triathlon';
import { estimateRunPaceFromSkill } from '@/calculations/race-prediction.triathlon';
import { getMutableState, getState, resetState } from './store';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { abilityBandFromVdot, isDeloadWeek } from '@/workouts/plan_engine';
import { computePredictionInputs } from '@/calculations/prediction-inputs';
import { cv } from '@/calculations/vdot';
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

/** One run `daysAgo` days back: `km` in `sec` seconds. */
function oneRun(daysAgo: number, km: number, sec: number): RunRow {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setHours(9, 0, 0, 0);
  return { startTime: d.toISOString(), distKm: km, durSec: sec, activityType: 'RUNNING' };
}

/** Engine VDOT at onboarding and after the first refresh. */
function engineAfter(runs: RunRow[], over: Partial<OnboardingState> = {}): { onboard: number; refresh: number } {
  seed({ onboardingRunHistory: runs });
  expect(initializeSimulator(onboarding(over)).success).toBe(true);
  const onboard = getState().v;
  refreshBlendedFitness(getMutableState());
  return { onboard, refresh: getState().v };
}

/**
 * KNOWN LIMITATION, pinned 2026-10-08 (open question for Tristan). The race
 * test is pace-only: a run more than 15% faster than the window's median pace.
 * Among easy runs at about 5:50/km that line sits near 4:58/km, so a tempo or
 * threshold session, a cruise-interval session that averages under it, or a
 * parkrun run at tempo effort fills the recent-race slot. It projects to the
 * race distance as a slower race and stands the §BZ engine floor down, the
 * same mechanism the easy-run fix removed. Separating tempo from race needs a
 * new rule (an HR threshold, a race flag, the activity name or the Strava
 * workout type), which is Tristan's call. These tests record today's numbers
 * so a change to the rule is deliberate: when the rule changes, rewrite them.
 */
describe('KNOWN LIMITATION: a tempo-paced training run counts as a race effort', () => {
  let capacity = 0;
  beforeEach(() => { capacity = noHistoryVdot(); });

  it('a 5 km tempo at 4:45/km ten days ago lowers a 10K 45:00 runner from 45.3 to about 40', () => {
    const tempo = oneRun(10, 5, 1425);
    const runs = [tempo, ...history(6, EASY_WEEK)];
    // The tempo is the window's newest run faster than median x 0.85.
    expect(computePredictionInputs(runs).recentRun).toMatchObject({ d: 5, t: 1425 });
    const v = engineAfter(runs);
    expect(capacity).toBeCloseTo(45.3, 1);
    expect(v.onboard).toBeCloseTo(39.1, 0);
    expect(v.refresh).toBeCloseTo(40.3, 0);
  });

  it('a weekly parkrun in 23:20 (4:40/km) lowers a 10K 45:00 runner to about 40.5', () => {
    const runs = [...history(6, [[0, 5, 1400 / 60]], undefined, 1), ...history(6, EASY_WEEK)];
    expect(computePredictionInputs(runs).recentRun).toMatchObject({ d: 5, t: 1400 });
    const v = engineAfter(runs);
    expect(v.onboard).toBeLessThan(capacity - 4);
    expect(v.refresh).toBeCloseTo(40.5, 0);
  });

  it('a 10K 46:30 runner with one 6 km session at 4:50/km three weeks ago drops into the novice band', () => {
    const pb = engineAfter([], { pbs: { k10: 2790 } }).refresh;
    expect(pb).toBeCloseTo(43.6, 1);
    expect(abilityBandFromVdot(pb, 'intermediate')).toBe('intermediate');
    const v = engineAfter([oneRun(21, 6, 1740), ...history(6, EASY_WEEK)], { pbs: { k10: 2790 } });
    expect(v.refresh).toBeCloseTo(39.5, 0);
    // Novice band: the 3-week deload cycle the easy-run fix removed for easy runs.
    const band = abilityBandFromVdot(v.refresh, 'intermediate');
    expect(band).toBe('novice');
    expect(isDeloadWeek(3, band)).toBe(true);
  });
});

/**
 * KNOWN LIMITATION, pinned 2026-10-08 (SCIENCE_LOG §CY limitation 3). A window
 * of one run is its own median, and two runs need a gap of about 26% to show
 * a race, so a lone recent race is not recognised. Before the fix this athlete
 * read about 36 (the newest run of any effort counted); a 10K in 48:20 is
 * itself worth about 41.6.
 */
describe('KNOWN LIMITATION: a lone run is never a race effort, and two runs need a 26% pace gap', () => {
  it('a lone recent 10K in 48:20 leaves a 10K 45:00 runner at the PB capacity', () => {
    const capacity = noHistoryVdot();
    const race = oneRun(5, 10, 2900);
    expect(cv(10000, 2900)).toBeCloseTo(41.6, 0);
    expect(computePredictionInputs([race]).recentRun).toBeNull();
    const v = engineAfter([race]);
    expect(v.onboard).toBeCloseTo(capacity, 6);
    expect(v.refresh).toBeCloseTo(capacity, 6);
  });

  it('the same race beside one easy 10 km at 5:50/km is still not recognised', () => {
    const capacity = noHistoryVdot();
    const runs = [oneRun(5, 10, 2900), oneRun(8, 10, 3500)];
    expect(computePredictionInputs(runs).recentRun).toBeNull();
    const v = engineAfter(runs);
    expect(v.refresh).toBeCloseTo(capacity, 6);
  });
});

/**
 * Triathlon cold-start skill cap (refreshBlendedFitness). A triathlete with no
 * running PB, no race anchor and no medium+ HR-vs-pace calibration is held at
 * their run skill rating, so a watch VO2max inflated by cycling and swimming
 * cannot set their run paces. Easy runs never enter the blend's recent-run
 * slot (SCIENCE_LOG §CY), so they must not lift the cap either. In 57935d0 the
 * gate read the window's run count: two weeks of easy jogging at 6:30/km
 * switched the cap off and the engine fell back to the watch number, 44.3 to
 * 51.1 at watch VO2max 62. The gate now reads a race effort again.
 */
describe('triathlon cold-start skill cap: easy runs do not lift it', () => {
  /** Two easy runs a week at 6:30/km, no heart rate. */
  const JOG_WEEK: Array<[number, number, number]> = [[0, 10, 65], [3, 8, 52]];

  function triEngine(vo2: number, runs: RunRow[]): number {
    resetState();
    localStorageMock.clear();
    Object.assign(getMutableState(), { vo2, onboardingRunHistory: runs });
    expect(initializeTriathlonSimulator({
      trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
      customRaceDate: planDay(20, 6), triSkillRating: { swim: 3, bike: 3, run: 3 },
    } as OnboardingState).success).toBe(true);
    refreshBlendedFitness(getMutableState());
    return getState().v;
  }

  /** The cap: run skill 3's marathon pace, as refreshBlendedFitness computes it. */
  const skillCap = cv(42195, estimateRunPaceFromSkill(3, 'ironman') * 42.195);

  it('with no runs, a watch VO2max of 62 is held at the run skill cap', () => {
    expect(skillCap).toBeCloseTo(44.3, 1);
    expect(triEngine(62, [])).toBeCloseTo(skillCap, 6);
  });

  it('two weeks of easy runs without heart rate keep the no-run value', () => {
    const noRuns = triEngine(62, []);
    const runs = history(2, JOG_WEEK);
    expect(computePredictionInputs(runs).recentRun).toBeNull();
    expect(triEngine(62, runs)).toBeCloseTo(noRuns, 6);
  });

  it('six weeks of easy runs, and a watch VO2max of 56, keep it too', () => {
    expect(triEngine(62, history(6, JOG_WEEK))).toBeCloseTo(skillCap, 6);
    expect(triEngine(56, history(2, JOG_WEEK))).toBeCloseTo(skillCap, 6);
    expect(triEngine(56, history(6, JOG_WEEK))).toBeCloseTo(skillCap, 6);
  });

  it('a synced race effort still lifts the cap', () => {
    // A 10K in 48:20 five days ago is more than 15% faster than the 6:30/km
    // median, so it is the race effort and enters the blend.
    const runs = [oneRun(5, 10, 2900), ...history(2, JOG_WEEK)];
    expect(computePredictionInputs(runs).recentRun).toMatchObject({ d: 10, t: 2900 });
    expect(Math.abs(triEngine(62, runs) - skillCap)).toBeGreaterThan(1);
  });
});

/**
 * KNOWN LIMITATION, pinned 2026-10-08 (open question for Tristan, SCIENCE_LOG
 * §CY). A stale PB is not corrected by training data. The §BZ engine floor
 * holds the engine at PB capacity unless a race effort (or a typed recent race,
 * or a race anchor) projects below it. The floor never reads the HR-calibrated
 * VDOT, and nothing applies PB age to the engine. A 10K 40:00 PB (51.9) with
 * six weeks of easy running at about 6:30/km therefore keeps paces set by the
 * 40:00 10K, with no heart rate and with a high-confidence HR fit that reads
 * about 41.8. Before 57935d0 the newest easy run stood the floor down: this
 * seed read 34.0 at onboarding, then 39.3 (no HR) or 35.9 (with HR) after the
 * first refresh. The HR fit sits between the old answer and the new one.
 * When the rule changes, rewrite these tests.
 */
describe('KNOWN LIMITATION: training data does not correct a stale PB', () => {
  /** Paces 6:15, 6:30 and 6:45/km, with average HR rising linearly with speed. */
  const JOG_WEEK_HR: Array<[number, number, number, number]> = [[0, 10, 65, 138], [2, 8, 50, 145], [4, 6, 40.5, 132]];

  function withHR(weeks: number): RunRow[] {
    const rows: RunRow[] = [];
    for (let k = 0; k < weeks; k++) {
      for (const [off, km, min, avgHR] of JOG_WEEK_HR) {
        const d = new Date(Date.now() - (2 + k * 7 + off) * DAY_MS);
        d.setHours(8, 0, 0, 0);
        rows.push({ startTime: d.toISOString(), distKm: km, durSec: Math.round(min * 60), activityType: 'RUNNING', avgHR });
      }
    }
    return rows;
  }

  it('a 10K 40:00 PB with six weeks of easy runs at 6:15 to 6:45/km holds 51.9, with and without HR', () => {
    const pb = { pbs: { k10: 2400 } };
    expect(engineAfter([], pb).refresh).toBeCloseTo(51.9, 1);

    const noHR = engineAfter(withHR(6).map(({ avgHR: _hr, ...r }) => r), pb);
    expect(noHR.onboard).toBeCloseTo(51.9, 1);
    expect(noHR.refresh).toBeCloseTo(51.9, 1);

    seed({ ...HR, onboardingRunHistory: withHR(6) });
    expect(initializeSimulator(onboarding(pb)).success).toBe(true);
    expect(getState().v).toBeCloseTo(51.9, 1);
    refreshBlendedFitness(getMutableState());
    expect(getState().v).toBeCloseTo(51.9, 1);
    // The HR fit says the athlete is about 10 points slower; the engine ignores it.
    const hr = getState().hrCalibratedVdot;
    expect(hr?.confidence).toBe('high');
    expect(hr?.vdot).toBeCloseTo(41.8, 0);
  });
});
