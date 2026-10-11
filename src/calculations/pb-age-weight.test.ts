/**
 * Stale PBs are aged internally and displayed unchanged (Tristan, 2026-10-09:
 * "externally we can display them their PBs but we can age them internally").
 *
 * A PB keeps its stored time. Its weight in the run fitness model falls with its
 * age on a smooth 3-year half-life (pbAgeWeight = exp(-years x ln 2 / 3),
 * SCIENCE_LOG 2026-04-24, Tanaka & Seals 2008; Tristan 2026-10-11, replacing
 * the §T5 step bands), and only when current running data exists (a measured
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

import { pbAgeWeight, pbAgeWeightsFor, pbCapacity, pbMedianVdot, pbDerivedVdot, modelPbAgeWeightsIfMeasured, pbEngineFloorVdot, pbAgeingActive, pbAgeYears, PB_AGE_HALF_LIFE_YEARS } from './physiological-vdot';
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

/** A date `years` (365.25-day years) before NOW, to the millisecond. */
const yrs = (years: number, from = NOW) => new Date(from.getTime() - years * 365.25 * DAY_MS).toISOString();
/** The SCIENCE_LOG 2026-04-24 PB decay, written out. */
const halfLife = (years: number) => Math.exp(-years * Math.LN2 / 3);

describe('pbAgeWeight is a smooth 3-year half-life (Tanaka & Seals 2008)', () => {
  it('1 year 0.79, 2 years 0.63, 3 years 0.50, 4 years 0.40, 5 years 0.31', () => {
    expect(PB_AGE_HALF_LIFE_YEARS).toBe(3);
    expect(pbAgeWeight(yrs(1), NOW)).toBeCloseTo(0.794, 3);
    expect(pbAgeWeight(yrs(2), NOW)).toBeCloseTo(0.630, 3);
    expect(pbAgeWeight(yrs(3), NOW)).toBeCloseTo(0.5, 9);
    expect(pbAgeWeight(yrs(4), NOW)).toBeCloseTo(0.397, 3);
    expect(pbAgeWeight(yrs(5), NOW)).toBeCloseTo(0.315, 3);
    for (const y of [0.1, 0.5, 1.98, 2.02, 7, 15]) expect(pbAgeWeight(yrs(y), NOW)).toBeCloseTo(halfLife(y), 9);
    expect(pbAgeYears(yrs(2.5), NOW)).toBeCloseTo(2.5, 9);
  });

  it('no anniversary step: a day moves the weight by at most ln 2 / 3 per year, at every age', () => {
    // The step bands moved 1.0 to 0.6 overnight at 2 years and 0.6 to 0.3 at 4.
    const perDay = Math.LN2 / 3 / 365.25;
    let prev = pbAgeWeight(yrs(0), NOW);
    for (let day = 1; day <= 6 * 365; day++) {
      const w = pbAgeWeight(new Date(NOW.getTime() - day * DAY_MS).toISOString(), NOW);
      expect(w).toBeLessThan(prev);
      expect(prev - w).toBeLessThanOrEqual(perDay + 1e-12);
      prev = w;
    }
  });

  it('no date, an unparseable one or a future one weigh 1 (§T5 default)', () => {
    expect(pbAgeWeight(undefined, NOW)).toBe(1);
    expect(pbAgeWeight('not a date', NOW)).toBe(1);
    expect(pbAgeWeight('2027-01-01', NOW)).toBe(1);
    // Onboarding month format: the first of the month.
    expect(pbAgeWeight('2021-03', NOW)).toBeCloseTo(halfLife(pbAgeYears('2021-03-01', NOW)!), 9);
  });

  it('a date belongs to a PB only while its time is the onboarding time stored with it', () => {
    const s = { onboarding: { pbs: { k10: 2400, h: 5400 }, pbDates: { k10: yrs(5), h: yrs(3) } } };
    const w = pbAgeWeightsFor({ k10: 2400, h: 5400 }, s, NOW);
    expect(w.k10).toBeCloseTo(halfLife(5), 9);
    expect(w.h).toBeCloseTo(0.5, 9);
    // A faster 10K from elsewhere (s.pbs) has no known date.
    const faster = pbAgeWeightsFor({ k10: 2350, h: 5400 }, s, NOW);
    expect(faster.k10).toBe(1);
    expect(faster.h).toBeCloseTo(0.5, 9);
    // No dates at all: every PB weighs 1.
    expect(pbAgeWeightsFor({ k5: 1200 }, {}, NOW)).toEqual({ k5: 1 });
  });
});

describe('pbAgeingActive drives the PB-age caption', () => {
  it('any dated PB with a measured volume, and never without one or for an undated PB', () => {
    const dated = (k10Years: number, k5Years?: number) => ({
      onboarding: {
        pbs: { k5: 1320, k10: 2400 },
        pbDates: { k10: yrs(k10Years), ...(k5Years != null ? { k5: yrs(k5Years) } : {}) },
      },
    });
    const measured = { weeksCovered: 4, weeklyKm: 30 };
    const none = { weeksCovered: 0, weeklyKm: 0 };
    // A dated 10K with a measured volume: the model weighs it by its age.
    expect(pbAgeingActive({ k10: 2400 }, dated(5), measured, NOW)).toBe(true);
    expect(pbAgeingActive({ k10: 2400 }, dated(1), measured, NOW)).toBe(true);
    // Same PB, no running data: no gated use.
    expect(pbAgeingActive({ k10: 2400 }, dated(5), none, NOW)).toBe(false);
    // A dated 5K beside a dated 10K: the weighted median is on the same gate.
    expect(pbAgeingActive({ k5: 1320, k10: 2400 }, dated(5, 1), none, NOW)).toBe(false);
    expect(pbAgeingActive({ k5: 1320, k10: 2400 }, dated(5, 1), measured, NOW)).toBe(true);
    // Undated PBs: never.
    expect(pbAgeingActive({ k10: 2400 }, {}, measured, NOW)).toBe(false);
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

  it('a fresh slower 5K pulls the median toward it in proportion to the weights', () => {
    const pbs = { k5: 1500, k10: 2400, h: 5250 };  // 5K 25:00, 10K 40:00, half 1:27:30
    const v5 = cv(5000, 1500);
    const vLow = Math.min(cv(10000, 2400), cv(21097.5, 5250));
    const plain = plainMedian(pbs);
    const aged = pbCapacity(pbs, { k5: 1, k10: 0.3, h: 0.3 })!;
    // Sorted 5K (w 1), then the slower of the 10K / half (w 0.3). Each PB sits
    // at the middle of its weight on the cumulative scale: 0.5 and 1.15. Half
    // the total weight (1.6) is 0.8, so the median lies (0.8 - 0.5) / 0.65 of
    // the way from the 5K to the next PB.
    const f = (0.8 - 0.5) / (1.15 - 0.5);
    expect(aged.vdot).toBeCloseTo(v5 + f * (vLow - v5), 9);
    expect(aged.weight).toBeCloseTo(1 + f * (0.3 - 1), 9);
    expect(aged.vdot).toBeLessThan(plain);
    expect(aged.vdot).toBeGreaterThan(v5);
  });

  it('two PBs give their weight-weighted mean', () => {
    const pbs = { k5: 1140, m: 12600 };  // 5K 19:00, marathon 3:30
    const v5 = cv(5000, 1140);
    const vm = cv(42195, 12600);
    expect(pbCapacity(pbs)!.vdot).toBeCloseTo((v5 + vm) / 2, 9);
    expect(pbCapacity(pbs, { k5: 1, m: 0.6 })!.vdot).toBeCloseTo((v5 + 0.6 * vm) / 1.6, 9);
    expect(pbCapacity(pbs, { k5: 0.6, m: 1 })!.vdot).toBeCloseTo((0.6 * v5 + vm) / 1.6, 9);
    expect(pbCapacity(pbs, { k5: 1, m: 0.3 })!.vdot).toBeCloseTo((v5 + 0.3 * vm) / 1.3, 9);
  });

  it('continuous and median, not max: every weight mix stays strictly inside the PB range', () => {
    // Review 2026-10-09: the selector form returned the fresher PB outright,
    // so a PB weighted 0.6 had no say, and a fresh 5K beside two old times
    // returned the MAX (52.88 against the plain median 50.47).
    const BANDS = [1, 0.6, 0.3];
    const keys = ['k5', 'k10', 'h', 'm'] as const;
    const times = { k5: 1140, k10: 2460, h: 5520, m: 12600 };
    for (let mask = 3; mask < 16; mask++) {
      const ks = keys.filter((_, i) => mask & (1 << i));
      if (ks.length < 2) continue;
      const pbs = Object.fromEntries(ks.map(k => [k, times[k]]));
      const vs = ks.map(k => cv(({ k5: 5000, k10: 10000, h: 21097.5, m: 42195 })[k], times[k]));
      const lo = Math.min(...vs);
      const hi = Math.max(...vs);
      const combos = ks.reduce<Array<Record<string, number>>>((acc, k) => acc.flatMap(c => BANDS.map(w => ({ ...c, [k]: w }))), [{}]);
      for (const w of combos) {
        const c = pbCapacity(pbs, w)!;
        expect(c.vdot).toBeLessThan(hi);
        expect(c.vdot).toBeGreaterThan(lo);
        expect(c.weight).toBeGreaterThanOrEqual(0.3);
        expect(c.weight).toBeLessThanOrEqual(1);
        // One PB stepping down a band (its anniversary) moves the median by
        // less than half the PB range; the selector form moved it by up to
        // the whole gap between two PBs.
        for (const k of ks) {
          const i = BANDS.indexOf(w[k]);
          if (i + 1 >= BANDS.length) continue;
          const next = pbCapacity(pbs, { ...w, [k]: BANDS[i + 1] })!;
          expect(Math.abs(next.vdot - c.vdot)).toBeLessThan((hi - lo) / 2);
        }
      }
    }
    // Weights approaching equal approach the plain median: no jump at equality.
    const three = { k5: 1140, k10: 2460, h: 5520 };
    const near = pbCapacity(three, { k5: 1, k10: 1 - 1e-9, h: 1 - 1e-9 })!.vdot;
    expect(near).toBeCloseTo(plainMedian(three), 6);
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
    const s = { onboarding: { pbs: { k10: 2400 }, pbDates: { k10: yrs(5) } } };
    expect(modelPbAgeWeightsIfMeasured({ k10: 2400 }, { ...s, detectedWeeklyKm: 35 }, inputs(0, 0), NOW)!.k10).toBeCloseTo(halfLife(5), 9);
    expect(modelPbAgeWeightsIfMeasured({ k10: 2400 }, s, inputs(3, 20), NOW)!.k10).toBeCloseTo(halfLife(5), 9);
    expect(modelPbAgeWeightsIfMeasured({ k10: 2400 }, s, inputs(0, 0), NOW)).toBeUndefined();
  });

  it('the age-weighted median is on the same measured-volume gate as every other PB-age use', () => {
    // 5K 22:00 one year old, 10K 40:00 and half 1:28 five years old, no runs.
    resetState();
    const st = getMutableState();
    st.pbs = { k5: 1320, k10: 2400, h: 5280 };
    st.onboarding = {
      ...defaultOnboardingState, pbs: { k5: 1320, k10: 2400, h: 5280 },
      pbDates: { k5: yrs(1), k10: yrs(5), h: yrs(5) },
    } as OnboardingState;
    const plain = pbMedianVdot({ k5: 1320, k10: 2400, h: 5280 })!;
    expect(plain).toBeCloseTo(cv(10000, 2400), 9);
    // No running data: the plain median (§BV), so an anniversary moves nothing.
    expect(pbDerivedVdot(getState(), NOW)).toBeCloseTo(plain, 9);
    // A typed weekly volume: the weighted median, between the fresher 5K and
    // the plain median (the selector form returned the 5K itself, 44.54).
    st.detectedWeeklyKm = 35;
    const weighted = pbCapacity({ k5: 1320, k10: 2400, h: 5280 }, { k5: halfLife(1), k10: halfLife(5), h: halfLife(5) })!.vdot;
    expect(pbDerivedVdot(getState(), NOW)).toBeCloseTo(weighted, 9);
    expect(weighted).toBeLessThan(plain);
    expect(weighted).toBeGreaterThan(cv(5000, 1320));
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

  /** The stored 10K PB's age weight, at the dates the initializer stored. */
  const w10 = () => pbAgeWeight(getState().onboarding?.pbDates?.k10, new Date());

  it('an undated PB holds the engine as before', () => {
    expect(PB).toBeCloseTo(51.9, 1);
    const e = engine({ ...HR, onboardingRunHistory: jogs(true) });
    expect(e.onboard).toBeCloseTo(PB, 6);
    expect(e.refresh).toBeCloseTo(PB, 6);
  });

  it('a dated PB with six weeks of easy runs and HR is weighed against the HR fit by its age weight', () => {
    for (const years of [1, 5]) {
      const e = engine({ ...HR, onboardingRunHistory: jogs(true) }, years);
      // The HR fit reads about 41.8 (high confidence).
      const hr = getState().hrCalibratedVdot!;
      expect(hr.confidence).toBe('high');
      expect(hr.vdot).toBeCloseTo(41.8, 1);
      // Floor: w x PB capacity + (1 - w) x HR fit (pbEngineFloorVdot), the
      // same at onboarding and after the refresh. 1 year: w 0.79; 5 years: 0.31.
      const w = w10();
      expect(w).toBeCloseTo(halfLife(years), 2);
      expect(e.onboard).toBeCloseTo(w * PB + (1 - w) * hr.vdot!, 6);
      expect(e.refresh).toBeCloseTo(e.onboard, 9);
      // Displayed PB unchanged: the stored time and date are as entered.
      expect(getState().pbs).toEqual({ k10: 2400 });
      expect(getState().onboarding?.pbs).toEqual({ k10: 2400 });
    }
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

  it('a 3-year-old PB moves less than a 5-year-old one, in proportion to the weights', () => {
    const three = engine({ ...HR, onboardingRunHistory: jogs(true) }, 3).refresh;
    const wThree = w10();
    const five = engine({ ...HR, onboardingRunHistory: jogs(true) }, 5).refresh;
    const wFive = w10();
    const hr = getState().hrCalibratedVdot!.vdot!;
    expect(three).toBeLessThan(PB - 3);
    expect(three - five).toBeCloseTo((wThree - wFive) * (PB - hr), 6);
    expect(three).toBeGreaterThan(five + 1.5);
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

/**
 * Two or three PBs of different ages, marathon target, real initializers, with
 * `s.onboarding` set before finalize as the wizard sets it (the onboarding LT
 * then reads the PB dates, as the refresh does).
 */
function engineMulti(
  pbs: { k5?: number; k10?: number; h?: number; m?: number },
  datesYearsAgo: Partial<Record<'k5' | 'k10' | 'h' | 'm', number>>,
  seed: Partial<SimulatorState> = {},
): { onboard: { v: number; lt: number | null }; refresh: { v: number; lt: number | null }; w: ReturnType<typeof pbAgeWeightsFor> } {
  resetState();
  Object.assign(getMutableState(), { unitPref: 'km', ...seed });
  const ob = {
    ...defaultOnboardingState,
    name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
    raceDistance: 'marathon', selectedRace: null, hasSmartwatch: true,
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
    experienceLevel: 'intermediate', pbs,
    pbDates: Object.fromEntries(Object.entries(datesYearsAgo).map(([k, y]) => [k, yearsAgoISO(y!)])),
  } as OnboardingState;
  getMutableState().onboarding = ob;
  expect(initializeSimulator(ob).success).toBe(true);
  const onboard = { v: getState().v, lt: getState().lt ?? null };
  refreshBlendedFitness(getMutableState());
  return { onboard, refresh: { v: getState().v, lt: getState().lt ?? null }, w: pbAgeWeightsFor(pbs, getState(), new Date()) };
}

describe('real initializers: two PBs across a 2-year anniversary move s.v and s.lt continuously', () => {
  // 5K 19:00 (VDOT 52.9) one year old, marathon 3:30 (44.6) either side of its
  // 2nd anniversary. Review 2026-10-09: the selector median returned the 5K
  // outright at 2.02 years, so s.v went 48.72 to 52.88 and s.lt 267 to 250
  // s/km overnight, with no running data at all. The §T5 bands then still
  // stepped the weighted median by 1.04 VDOT (0.125 of the PB gap).
  const PBS = { k5: 1140, m: 12600 };
  const V5 = cv(5000, 1140);
  const VM = cv(42195, 12600);
  const TYPED = { detectedWeeklyKm: 40, weeklyVolumeConfirmed: true };

  it('with no running data the anniversary moves nothing (§BV)', () => {
    const before = engineMulti(PBS, { k5: 1, m: 1.98 });
    const after = engineMulti(PBS, { k5: 1, m: 2.02 });
    expect(before.refresh.v).toBeCloseTo((V5 + VM) / 2, 6);
    expect(after.refresh.v).toBeCloseTo(before.refresh.v, 9);
    expect(after.refresh.lt).toBe(before.refresh.lt);
    // Either PB ageing: same.
    const reverse = engineMulti(PBS, { k5: 2.02, m: 1 });
    expect(reverse.refresh.v).toBeCloseTo(before.refresh.v, 9);
    expect(reverse.refresh.lt).toBe(before.refresh.lt);
  });

  it('with a measured volume each PB keeps a say in proportion to its age weight, with no step at 2 years', () => {
    const before = engineMulti(PBS, { k5: 1, m: 1.98 }, TYPED);
    const after = engineMulti(PBS, { k5: 1, m: 2.02 }, TYPED);
    for (const e of [before, after]) {
      expect(e.refresh.v).toBeCloseTo((e.w.k5! * V5 + e.w.m! * VM) / (e.w.k5! + e.w.m!), 6);
      // Onboarding and the first refresh agree on both.
      expect(e.onboard.v).toBeCloseTo(e.refresh.v, 9);
      expect(e.onboard.lt).toBe(e.refresh.lt);
    }
    // 0.04 years apart: a few hundredths of a VDOT, not the 1.04 band step.
    expect(after.refresh.v - before.refresh.v).toBeGreaterThan(0);
    expect(after.refresh.v - before.refresh.v).toBeLessThan(0.05);
    expect(Math.abs(after.refresh.lt! - before.refresh.lt!)).toBeLessThanOrEqual(1);
    expect(after.refresh.v).toBeLessThan(V5 - 2);
    // The other way round (the 5K ages): the mirror weighting.
    const rev = engineMulti(PBS, { k5: 2.02, m: 1 }, TYPED);
    expect(rev.refresh.v).toBeCloseTo((rev.w.k5! * V5 + rev.w.m! * VM) / (rev.w.k5! + rev.w.m!), 6);
  });

  it('a fresher 5K beside two old times stays below the max (median, not max)', () => {
    // 5K 19:00 one year old, 10K 41:00 and half 1:32 over four years old.
    const three = { k5: 1140, k10: 2460, h: 5520 };
    const plain = pbMedianVdot(three)!;
    const noData = engineMulti(three, { k5: 1, k10: 4.02, h: 4.02 });
    expect(noData.refresh.v).toBeCloseTo(plain, 6);
    const typed = engineMulti(three, { k5: 1, k10: 4.02, h: 4.02 }, TYPED);
    const weighted = pbCapacity(three, typed.w)!.vdot;
    expect(typed.refresh.v).toBeCloseTo(weighted, 6);
    expect(typed.refresh.v).toBeLessThan(V5 - 0.5);
    expect(typed.refresh.v).toBeGreaterThan(plain);
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
