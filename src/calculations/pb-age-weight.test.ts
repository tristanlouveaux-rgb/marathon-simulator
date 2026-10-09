/**
 * Stale PBs are aged internally and displayed unchanged (Tristan, 2026-10-09:
 * "externally we can display them their PBs but we can age them internally").
 *
 * A PB keeps its stored time. Its weight in the run fitness model falls with its
 * age on the existing §T5 bands (pbAgeWeight: up to 2 years 1.0, 2 to 4 years
 * 0.6, over 4 years 0.3), and only when current running data exists (a measured
 * weekly volume): with no data an old PB still holds (§BV). TRACKING side.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
});
vi.stubGlobal('alert', vi.fn());
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { pbAgeWeight, pbAgeWeightsFor, pbCapacity, pbMedianVdot, pbDerivedVdot, modelPbAgeWeightsIfMeasured, pbEngineFloorVdot } from './physiological-vdot';
import { measuredWeeklyKm } from './prediction-inputs';
import { blendPredictions, demonstratedPBFloor } from './predictions';
import { deriveLT } from './lt-derivation';
import { cv } from './vdot';
import { initializeSimulator } from '@/state/initialization';
import { getMutableState, getState, resetState } from '@/state/store';
import { refreshBlendedFitness } from './blended-fitness';
import { localMondayKey } from '@/utils/local-date';
import { applyPBsFromRows } from '@/data/appleHealthSync';

const DAY_MS = 86400000;
const NOW = new Date('2026-10-09T08:00:00Z');
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY_MS).toISOString().slice(0, 10);

describe('pbAgeWeight reuses the §T5 recency bands', () => {
  it('up to 2 years 1.0, 2 to 4 years 0.6, over 4 years 0.3', () => {
    expect(pbAgeWeight(ago(30), NOW)).toBe(1);
    // ago() truncates to the date, so ago(n) is n days plus 8 hours old at NOW.
    expect(pbAgeWeight(ago(2 * 365 - 1), NOW)).toBe(1);
    expect(pbAgeWeight(ago(2 * 365 + 2), NOW)).toBe(0.6);
    expect(pbAgeWeight(ago(4 * 365 - 1), NOW)).toBe(0.6);
    expect(pbAgeWeight(ago(4 * 365 + 2), NOW)).toBe(0.3);
    expect(pbAgeWeight(ago(15 * 365), NOW)).toBe(0.3);
  });

  it('no date, an unparseable one or a future one weigh 1 (§T5 default)', () => {
    expect(pbAgeWeight(undefined, NOW)).toBe(1);
    expect(pbAgeWeight('not a date', NOW)).toBe(1);
    expect(pbAgeWeight('2027-01-01', NOW)).toBe(1);
    // Onboarding month format.
    expect(pbAgeWeight('2021-03', NOW)).toBe(0.3);
  });

  it('a date belongs to a PB only while its time is the onboarding time stored with it', () => {
    const s = { onboarding: { pbs: { k10: 2400, h: 5400 }, pbDates: { k10: ago(5 * 365), h: ago(3 * 365) } } };
    expect(pbAgeWeightsFor({ k10: 2400, h: 5400 }, s, NOW)).toEqual({ k10: 0.3, h: 0.6 });
    // A faster 10K from elsewhere (s.pbs) has no known date.
    expect(pbAgeWeightsFor({ k10: 2350, h: 5400 }, s, NOW)).toEqual({ k10: 1, h: 0.6 });
    // No dates at all: every PB weighs 1.
    expect(pbAgeWeightsFor({ k5: 1200 }, {}, NOW)).toEqual({ k5: 1 });
  });
});

describe('pbCapacity: age-weighted median', () => {
  /** The pre-ageing median, verbatim. */
  function plainMedian(pbs: { k5?: number; k10?: number; h?: number; m?: number }): number {
    const c: number[] = [];
    if (pbs.k5) c.push(cv(5000, pbs.k5));
    if (pbs.k10) c.push(cv(10000, pbs.k10));
    if (pbs.h) c.push(cv(21097.5, pbs.h));
    if (pbs.m) c.push(cv(42195, pbs.m));
    c.sort((a, b) => a - b);
    const mid = Math.floor(c.length / 2);
    return c.length % 2 === 0 ? (c[mid - 1] + c[mid]) / 2 : c[mid];
  }

  const SETS = [
    { k10: 2400 },
    { k5: 1200, k10: 2500 },
    { k5: 1200, k10: 2500, h: 5600 },
    { k5: 1155, k10: 2400, h: 5250, m: 11000 },
  ];

  it('equal weights give the plain median exactly, with that weight', () => {
    for (const pbs of SETS) {
      expect(pbMedianVdot(pbs)).toBe(plainMedian(pbs));
      const all = Object.fromEntries(Object.keys(pbs).map(k => [k, 0.3]));
      expect(pbCapacity(pbs, all)).toEqual({ vdot: plainMedian(pbs), weight: 0.3 });
    }
  });

  it('a fresh slower 5K outweighs two old faster times', () => {
    const pbs = { k5: 1500, k10: 2400, h: 5250 };  // 5K 25:00, 10K 40:00, half 1:27:30
    const plain = plainMedian(pbs);
    const aged = pbCapacity(pbs, { k5: 1, k10: 0.3, h: 0.3 })!;
    expect(aged.vdot).toBeCloseTo(cv(5000, 1500), 9);
    expect(aged.weight).toBe(1);
    expect(aged.vdot).toBeLessThan(plain);
  });
});

describe('blendPredictions and demonstratedPBFloor take PB age weights', () => {
  const pbs = { k10: 2400 };
  const args = (w?: { k10?: number }) => blendPredictions(
    10000, pbs, 300, null, 1.06, 'balanced', null, undefined, 40, undefined, undefined, null,
    undefined, false, 0, w,
  );

  it('no weights, or weight 1, change nothing', () => {
    expect(args(undefined)).toBe(args({ k10: 1 }));
  });

  it('an old PB moves the prediction toward the other predictors', () => {
    const fresh = args({ k10: 1 })!;
    const old = args({ k10: 0.3 })!;
    // LT 5:00/km predicts a slower 10K than the 40:00 PB; the floor no longer
    // holds the old PB, and its weight drops.
    expect(fresh).toBe(2400);
    expect(old).toBeGreaterThan(2400);
  });

  it('the same-distance floor stands down for a PB older than two years', () => {
    const ctx = { weeklyRunKm: 40, weeklyRunKmIsEstimate: false, recentRun: null, b: 1.06 };
    expect(demonstratedPBFloor(2600, 10000, pbs, ctx)).toBe(2400);
    expect(demonstratedPBFloor(2600, 10000, pbs, { ...ctx, pbAgeWeights: { k10: 1 } })).toBe(2400);
    expect(demonstratedPBFloor(2600, 10000, pbs, { ...ctx, pbAgeWeights: { k10: 0.6 } })).toBe(2600);
    // Idempotent either way.
    expect(demonstratedPBFloor(2600, 10000, pbs, { ...ctx, pbAgeWeights: { k10: 0.6 } })).toBe(2600);
  });
});

describe('LT: critical speed and the long-race bound weigh PB age', () => {
  const sustained = [] as never[];
  it('critical speed shares its weight with the Daniels method by the PB age weight', () => {
    const efforts = (w: number) => [
      { distanceM: 5000, elapsedSec: 1200, ageWeight: w },
      { distanceM: 10000, elapsedSec: 2500, ageWeight: w },
    ];
    const fresh = deriveLT({ vdot: 40, maxHR: null, bestEfforts: efforts(1), sustainedEfforts: sustained });
    const old = deriveLT({ vdot: 40, maxHR: null, bestEfforts: efforts(0.3), sustainedEfforts: sustained });
    const csW = (r: typeof fresh) => r.methods.find(m => m.method === 'critical-speed')!.weight;
    expect(csW(fresh)).toBeCloseTo(0.6, 9);
    expect(csW(old)).toBeCloseTo(0.18, 9);
    // Daniels from VDOT 40 is slower than the PB critical speed, so LT slows.
    expect(old.ltPaceSecKm!).toBeGreaterThan(fresh.ltPaceSecKm!);
    // Critical speed alone is unchanged by age (no other evidence).
    const csOnly = (w: number) => deriveLT({ vdot: null, maxHR: null, bestEfforts: efforts(w), sustainedEfforts: sustained }).ltPaceSecKm;
    expect(csOnly(0.3)).toBeCloseTo(csOnly(1)!, 9);
  });

  it('an old marathon PB pulls LT part of the way to its pace', () => {
    const m = (w: number) => deriveLT({
      vdot: 40, maxHR: null, sustainedEfforts: sustained,
      bestEfforts: [{ distanceM: 42195, elapsedSec: 3 * 3600, ageWeight: w }],
    });
    const pace = (3 * 3600) / 42.195;
    const free = deriveLT({ vdot: 40, maxHR: null, sustainedEfforts: sustained, bestEfforts: [] }).ltPaceSecKm!;
    expect(free).toBeGreaterThan(pace);
    expect(m(1).ltPaceSecKm).toBeCloseTo(pace, 9);
    expect(m(1).provenance).toContain('Capped at your race-PB pace');
    expect(m(0.3).ltPaceSecKm).toBeCloseTo(free - 0.3 * (free - pace), 9);
    expect(m(0.3).provenance).toContain('Moved toward an older race-PB pace');
  });
});

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

type RunRow = NonNullable<SimulatorState['onboardingRunHistory']>[number];
/** Six weeks of easy runs at 6:15 to 6:45/km (the stale-PB seed of §CY limitation 6). */
function jogs(withHR: boolean): RunRow[] {
  const week: Array<[number, number, number, number]> = [[0, 10, 65, 138], [2, 8, 50, 145], [4, 6, 40.5, 132]];
  const rows: RunRow[] = [];
  for (let k = 0; k < 6; k++) {
    for (const [off, km, min, avgHR] of week) {
      const d = new Date(Date.now() - (2 + k * 7 + off) * DAY_MS);
      d.setHours(8, 0, 0, 0);
      rows.push({ startTime: d.toISOString(), distKm: km, durSec: Math.round(min * 60), activityType: 'RUNNING', ...(withHR ? { avgHR } : {}) });
    }
  }
  return rows;
}

function yearsAgoISO(years: number): string {
  return new Date(Date.now() - years * 365.25 * DAY_MS).toISOString().slice(0, 10);
}

/** 10K 40:00 PB (VDOT 51.9), optionally dated; engine at onboarding and after a refresh. */
function engine(seed: Partial<SimulatorState>, pbDateYearsAgo?: number): { onboard: number; refresh: number } {
  resetState();
  Object.assign(getMutableState(), {
    unitPref: 'km', detectedWeeklyKm: 35, weeklyVolumeConfirmed: true,
    athleteArchetype: { archetype: 'consistent-runner' } as SimulatorState['athleteArchetype'],
    ...seed,
  });
  expect(initializeSimulator({
    ...defaultOnboardingState,
    name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
    raceDistance: 'marathon', selectedRace: null, hasSmartwatch: true,
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
    experienceLevel: 'intermediate', pbs: { k10: 2400 },
    ...(pbDateYearsAgo != null ? { pbDates: { k10: yearsAgoISO(pbDateYearsAgo) } } : {}),
  } as OnboardingState).success).toBe(true);
  const onboard = getState().v;
  refreshBlendedFitness(getMutableState());
  return { onboard, refresh: getState().v };
}

describe('one measured-volume gate and one engine floor', () => {
  const inputs = (weeksCovered: number, weeklyKm: number) => ({ weeksCovered, weeklyKm });

  it('measuredWeeklyKm: a synced window (an explicit 0 included) or a typed weekly km', () => {
    expect(measuredWeeklyKm(inputs(4, 30), 50)).toBe(30);
    expect(measuredWeeklyKm(inputs(4, 0), 50)).toBe(0);
    expect(measuredWeeklyKm(inputs(0, 0), 35)).toBe(35);
    expect(measuredWeeklyKm(inputs(0, 0), undefined)).toBeNull();
    expect(measuredWeeklyKm(inputs(0, 0), 0)).toBeNull();
  });

  it('modelPbAgeWeightsIfMeasured: weights with a measured volume, a typed km included; none without', () => {
    const s = { onboarding: { pbs: { k10: 2400 }, pbDates: { k10: ago(5 * 365) } } };
    expect(modelPbAgeWeightsIfMeasured({ k10: 2400 }, { ...s, detectedWeeklyKm: 35 }, inputs(0, 0), NOW)).toEqual({ k10: 0.3 });
    expect(modelPbAgeWeightsIfMeasured({ k10: 2400 }, s, inputs(3, 20), NOW)).toEqual({ k10: 0.3 });
    expect(modelPbAgeWeightsIfMeasured({ k10: 2400 }, s, inputs(0, 0), NOW)).toBeUndefined();
  });

  it('the age-weighted median is not volume-gated: a fresher PB is itself current evidence', () => {
    // 5K 22:00 one year old, 10K 40:00 and half 1:28 five years old, no runs.
    resetState();
    const st = getMutableState();
    st.pbs = { k5: 1320, k10: 2400, h: 5280 };
    st.onboarding = {
      ...defaultOnboardingState, pbs: { k5: 1320, k10: 2400, h: 5280 },
      pbDates: { k5: ago(365), k10: ago(5 * 365), h: ago(5 * 365) },
    } as OnboardingState;
    expect(pbDerivedVdot(getState(), NOW)).toBeCloseTo(cv(5000, 1320), 9);
    expect(pbMedianVdot({ k5: 1320, k10: 2400, h: 5280 })).toBeCloseTo(cv(10000, 2400), 9);
  });

  it('pbEngineFloorVdot: capacity unless the median PB is aged and a medium+ HR fit exists', () => {
    const hrFit = (vdot: number, confidence = 'high') => ({ vdot, confidence });
    const cap = (w: number) => ({ vdot: 52, weight: w });
    expect(pbEngineFloorVdot(cap(1), { ageWeightsApply: true, hrFit: hrFit(42) })).toBe(52);
    expect(pbEngineFloorVdot(cap(0.3), { ageWeightsApply: false, hrFit: hrFit(42) })).toBe(52);
    expect(pbEngineFloorVdot(cap(0.3), { ageWeightsApply: true, hrFit: null })).toBe(52);
    expect(pbEngineFloorVdot(cap(0.3), { ageWeightsApply: true, hrFit: hrFit(42, 'low') })).toBe(52);
    expect(pbEngineFloorVdot(cap(0.3), { ageWeightsApply: true, hrFit: hrFit(42) })).toBeCloseTo(0.3 * 52 + 0.7 * 42, 9);
    expect(pbEngineFloorVdot(cap(0.6), { ageWeightsApply: true, hrFit: hrFit(42, 'medium') })).toBeCloseTo(0.6 * 52 + 0.4 * 42, 9);
    // An HR fit above capacity never lifts the floor above it.
    expect(pbEngineFloorVdot(cap(0.3), { ageWeightsApply: true, hrFit: hrFit(58) })).toBe(52);
  });
});

describe('real initializers: a stale PB loses weight against current running data', () => {
  const HR = { maxHR: 190, restingHR: 50 };
  const PB = cv(10000, 2400);

  it('an undated PB, or one under two years old, holds the engine as before', () => {
    expect(PB).toBeCloseTo(51.9, 1);
    for (const yrs of [undefined, 1]) {
      const e = engine({ ...HR, onboardingRunHistory: jogs(true) }, yrs);
      expect(e.onboard).toBeCloseTo(PB, 6);
      expect(e.refresh).toBeCloseTo(PB, 6);
    }
  });

  it('a 5-year-old PB with six weeks of easy runs and HR is weighed against the HR fit', () => {
    const e = engine({ ...HR, onboardingRunHistory: jogs(true) }, 5);
    // Pre-ageing 51.9 at both. The HR fit reads about 41.8 (high confidence).
    const hr = getState().hrCalibratedVdot!;
    expect(hr.confidence).toBe('high');
    expect(hr.vdot).toBeCloseTo(41.8, 1);
    // Floor: 0.3 x PB capacity + 0.7 x HR fit (pbEngineFloorVdot), the same
    // at onboarding and after the refresh.
    expect(e.onboard).toBeCloseTo(0.3 * PB + 0.7 * hr.vdot!, 9);
    expect(e.refresh).toBeCloseTo(e.onboard, 9);
    expect(e.refresh).toBeCloseTo(44.8, 1);
    // Displayed PB unchanged: the stored time and date are as entered.
    expect(getState().pbs).toEqual({ k10: 2400 });
    expect(getState().onboarding?.pbs).toEqual({ k10: 2400 });
  });

  it('onboarding and the first refresh give an aged PB the same engine, with and without HR', () => {
    // Review 2026-10-09: the floor used to pull toward the penalised blend,
    // which differs between the two paths (2.02 years: 45.59 vs 48.15; 4.02
    // years: 40.29 vs 45.20; no HR, 5 years: 40.5 vs 45.3).
    for (const yrs of [2.02, 3, 4.02, 5]) {
      const withHr = engine({ ...HR, onboardingRunHistory: jogs(true) }, yrs);
      expect(withHr.refresh).toBeCloseTo(withHr.onboard, 9);
      const noHr = engine({ onboardingRunHistory: jogs(false) }, yrs);
      expect(noHr.refresh).toBeCloseTo(noHr.onboard, 9);
    }
  });

  it('a 3-year-old PB moves less than a 5-year-old one', () => {
    const three = engine({ ...HR, onboardingRunHistory: jogs(true) }, 3).refresh;
    const five = engine({ ...HR, onboardingRunHistory: jogs(true) }, 5).refresh;
    expect(three).toBeLessThan(PB - 3);
    expect(three).toBeGreaterThan(five + 2);
  });

  it('without HR there is no current capacity evidence: the engine holds at PB capacity, the readiness blend ages', () => {
    // Easy-run paces say nothing about capacity (§CY) and the readiness
    // penalties are not capacity (§BZ), so the PB stays the only capacity
    // figure. The race-readiness time still gives the old PB less weight.
    const old = engine({ onboardingRunHistory: jogs(false) }, 5);
    expect(old.onboard).toBeCloseTo(PB, 9);
    expect(old.refresh).toBeCloseTo(PB, 9);
    const oldReadiness = getState().blendedRaceTimeSec!;
    engine({ onboardingRunHistory: jogs(false) }, 1);
    expect(oldReadiness).toBeGreaterThan(getState().blendedRaceTimeSec!);
  });

  it('with no running data an old PB keeps full weight (§BV)', () => {
    const e = engine({ detectedWeeklyKm: undefined, weeklyVolumeConfirmed: undefined }, 5);
    expect(e.onboard).toBeCloseTo(PB, 6);
    expect(e.refresh).toBeCloseTo(PB, 6);
  });
});

describe('Apple and file-import PB auto-fill keep the PB date with its time', () => {
  it('a faster synced PB takes its effort date, so the old date cannot age it', () => {
    resetState();
    const s = getMutableState();
    s.pbs = { k10: 2500 };
    s.onboarding = { ...defaultOnboardingState, pbs: { k10: 2500 }, pbDates: { k10: '2019-05-01' } } as OnboardingState;
    applyPBsFromRows([{ start_time: '2026-09-20T07:00:00Z', best_efforts: [{ name: '10K', elapsed_time: 2400, moving_time: 2400, distance: 10000, start_date: '2026-09-20T07:10:00Z' }] } as never]);
    expect(getState().pbs?.k10).toBe(2400);
    expect(getState().onboarding?.pbs?.k10).toBe(2400);
    expect(getState().onboarding?.pbDates?.k10).toBe('2026-09-20T07:10:00Z');
  });

  it('a slower synced effort leaves the PB and its date alone', () => {
    resetState();
    const s = getMutableState();
    s.pbs = { k10: 2400 };
    s.onboarding = { ...defaultOnboardingState, pbs: { k10: 2400 }, pbDates: { k10: '2025-05-01' } } as OnboardingState;
    applyPBsFromRows([{ start_time: '2026-09-20T07:00:00Z', best_efforts: [{ name: '10K', elapsed_time: 2600, moving_time: 2600, distance: 10000, start_date: '2026-09-20T07:10:00Z' }] } as never]);
    expect(getState().onboarding?.pbs?.k10).toBe(2400);
    expect(getState().onboarding?.pbDates?.k10).toBe('2025-05-01');
  });
});
