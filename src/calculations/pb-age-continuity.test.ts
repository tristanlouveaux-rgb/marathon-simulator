/**
 * No forecast number steps on a PB's anniversary (Tristan, 2026-10-11): the PB
 * age weight, the PB floor and the low-volume PB-recency factor are all
 * continuous in the PB's age.
 *
 * The PB age weight is a smooth 3-year half-life (pbAgeWeight), and the
 * same-distance PB floor keeps w of its strength for a PB of weight w
 * (demonstratedPBFloor, demonstratedPBFloorThrough). Review 3 (2026-10-09)
 * measured the binary floor at the 2-year mark, marathon PB 3:15, typed 40 km a
 * week: blendedRaceTimeSec 3:15:00 to 3:31:55 and forecastTime 3:09:36 to
 * 3:16:25 overnight. Real initializers, day by day across 1, 2, 3 and 4 years.
 * TRACKING side (race-time prediction).
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
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

import { initializeSimulator } from '@/state/initialization';
import { getMutableState, getState, resetState } from '@/state/store';
import { refreshBlendedFitness, predictStandardDistances, runningForecastForSessions } from './blended-fitness';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { predictTriathlonRace } from './race-prediction.triathlon';
import { computeTriRaceReadiness } from './race-readiness';
import { localMondayKey } from '@/utils/local-date';

// One clock for the whole file (follow-up review 1, 2026-10-11). pbAgeWeight is
// continuous in time, so two computations a few milliseconds apart differ in
// the last bits. Date is frozen at the real current time; timers stay real.
const FROZEN_NOW = new Date();
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(FROZEN_NOW);
afterAll(() => { vi.useRealTimers(); });

const DAY_MS = 86400000;

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

type RunRow = NonNullable<SimulatorState['onboardingRunHistory']>[number];
/** Eight weeks at 56 km a week, 5:30/km, no HR (a 20 km long run each Sunday). */
function syncedWeeks(): RunRow[] {
  const week: Array<[number, number]> = [[0, 20], [2, 12], [4, 10], [5, 14]];
  const rows: RunRow[] = [];
  for (let k = 0; k < 8; k++) {
    for (const [off, km] of week) {
      const d = new Date(Date.now() - (1 + k * 7 + off) * DAY_MS);
      d.setHours(8, 0, 0, 0);
      rows.push({ startTime: d.toISOString(), distKm: km, durSec: Math.round(km * 330), activityType: 'RUNNING' });
    }
  }
  return rows;
}

interface Snapshot {
  onboard: { brt: number; ft: number; v: number; lt: number | null; preview: number };
  refresh: { brt: number; ft: number; v: number; lt: number | null; std: Record<string, number | null> };
}

type PbKey = 'k5' | 'k10' | 'h' | 'm';
type Case = {
  label: string;
  rd: 'marathon' | 'half';
  pbs: Partial<Record<PbKey, number>>;
  /** The one dated PB (the others undated), or `dated` for several. */
  key?: PbKey;
  dated?: PbKey[];
  seed: Partial<SimulatorState>;
};

const TYPED_40 = { detectedWeeklyKm: 40, weeklyVolumeConfirmed: true };
const TYPED_20 = { detectedWeeklyKm: 20, weeklyVolumeConfirmed: true };
const CASES: Case[] = [
  { label: 'marathon PB 3:15, typed 40 km a week', rd: 'marathon', pbs: { m: 11700 }, key: 'm', seed: TYPED_40 },
  { label: 'marathon PB 3:15, 56 km a week of synced runs', rd: 'marathon', pbs: { m: 11700 }, key: 'm', seed: { onboardingRunHistory: syncedWeeks() } },
  { label: 'half PB 1:30, typed 40 km a week', rd: 'half', pbs: { h: 5400 }, key: 'h', seed: TYPED_40 },
];

/** Onboard with the dated PBs `ageDays` before now, then run the launch refresh. */
function run(c: Case, ageDays: number): Snapshot {
  const at = new Date(Date.now() - ageDays * DAY_MS).toISOString();
  const pbDates = Object.fromEntries((c.dated ?? (c.key ? [c.key] : [])).map(k => [k, at]));
  resetState();
  Object.assign(getMutableState(), { unitPref: 'km', ...c.seed });
  const ob = {
    ...defaultOnboardingState,
    name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
    raceDistance: c.rd, selectedRace: null, hasSmartwatch: true,
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
    experienceLevel: 'intermediate', pbs: c.pbs, pbDates,
  } as OnboardingState;
  getMutableState().onboarding = ob;
  expect(initializeSimulator(ob).success).toBe(true);
  const s0 = getState();
  // The plan preview hero (forecastForSessions reads runningForecastForSessions
  // at the plan's sessions).
  const sessions = (s0.epw || s0.rw || 4) + (s0.commuteConfig?.enabled ? (s0.commuteConfig.commuteDaysPerWeek ?? 0) : 0);
  const preview = runningForecastForSessions(getMutableState(), sessions)!.forecastTime;
  const onboard = { brt: s0.blendedRaceTimeSec!, ft: s0.forecastTime!, v: s0.v, lt: s0.lt ?? null, preview };
  refreshBlendedFitness(getMutableState());
  const s1 = getState();
  return {
    onboard,
    refresh: { brt: s1.blendedRaceTimeSec!, ft: s1.forecastTime!, v: s1.v, lt: s1.lt ?? null, std: predictStandardDistances(getMutableState()) },
  };
}

describe('real initializers: PB-age forecasts move by small steps day to day across 1, 2, 3 and 4 years', () => {
  for (const c of CASES) {
    it(c.label, () => {
      for (const years of [1, 2, 3, 4]) {
        const anniversary = Math.round(years * 365.25);
        const days = [-3, -2, -1, 0, 1, 2, 3].map(d => anniversary + d);
        const snaps = days.map(d => run(c, d));
        for (let i = 1; i < snaps.length; i++) {
          const a = snaps[i - 1];
          const b = snaps[i];
          // One day older: the weight falls by at most ln 2 / 3 per year, so
          // each time moves by well under a second (the binary floor moved the
          // marathon by 7 to 17 min on one night).
          for (const k of ['brt', 'ft'] as const) {
            expect(Math.abs(b.refresh[k] - a.refresh[k])).toBeLessThan(2);
            expect(Math.abs(b.onboard[k] - a.onboard[k])).toBeLessThan(2);
            // Older PB: never faster.
            expect(b.refresh[k]).toBeGreaterThanOrEqual(a.refresh[k] - 1e-6);
          }
          expect(Math.abs(b.refresh.v - a.refresh.v)).toBeLessThan(0.01);
          for (const d of ['5k', '10k', 'half', 'marathon']) {
            expect(Math.abs((b.refresh.std[d] ?? 0) - (a.refresh.std[d] ?? 0))).toBeLessThan(2);
          }
        }
      }
    });
  }

  it('a dated PB keeps part of its floor at every age: never the unfloored time, never the PB once aged', () => {
    // Marathon PB 3:15, typed 40 km: the unfloored race-readiness time sits
    // above the PB. The floored time rises toward it with age but stays below.
    const c = CASES[0];
    const fresh = run(c, 0).refresh.brt;
    const ages = [1, 2, 3, 4, 8].map(y => run(c, Math.round(y * 365.25)).refresh.brt);
    expect(fresh).toBeCloseTo(11700, 3);
    for (let i = 0; i < ages.length; i++) {
      expect(ages[i]).toBeGreaterThan(i === 0 ? fresh : ages[i - 1]);
    }
    // Undated (no age known): the PB floors at full strength, as before.
    resetState();
    Object.assign(getMutableState(), { unitPref: 'km', ...c.seed });
    const ob = {
      ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'running',
      trainingForEvent: true, raceDistance: 'marathon', selectedRace: null, hasSmartwatch: true,
      customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
      experienceLevel: 'intermediate', pbs: { m: 11700 },
    } as OnboardingState;
    getMutableState().onboarding = ob;
    expect(initializeSimulator(ob).success).toBe(true);
    refreshBlendedFitness(getMutableState());
    expect(getState().blendedRaceTimeSec).toBe(11700);
  });
});

describe('one forecast: the plan preview equals Home (Tristan, 2026-10-11)', () => {
  // Review 3: with an aged PB and a typed volume the onboarding forecast took
  // the wizard LT (state.ltPace, usually none) while the first refresh used the
  // derived s.lt. Marathon PB 3:15 at 2.02 years, typed 40 km: 3:09:36 at
  // onboarding vs 3:16:25 after the first refresh; half 1:27:20 vs 1:31:15.
  // An undated marathon PB with a typed 20 km read 3:34:59 vs 3:42:10 today.
  const ONE: Array<{ c: Case; ages: number[] }> = [
    { c: CASES[0], ages: [0, 365, 2 * 365 + 7, 5 * 365] },
    { c: CASES[1], ages: [0, 2 * 365 + 7] },
    { c: CASES[2], ages: [0, 2 * 365 + 7, 5 * 365] },
    { c: { label: 'marathon PB 3:15, typed 20 km a week', rd: 'marathon', pbs: { m: 11700 }, key: 'm', seed: TYPED_20 }, ages: [0, 2 * 365 + 7] },
  ];
  for (const { c, ages } of ONE) {
    it(c.label, () => {
      for (const days of ages) {
        const r = run(c, days);
        expect(r.onboard.preview).toBeCloseTo(r.refresh.ft, 6);
        expect(r.onboard.ft).toBeCloseTo(r.refresh.ft, 6);
        expect(r.onboard.brt).toBeCloseTo(r.refresh.brt, 6);
        expect(r.onboard.v).toBeCloseTo(r.refresh.v, 9);
        expect(r.onboard.lt).toBe(r.refresh.lt);
      }
    });
  }
});

/**
 * The low-volume PB-recency factor is continuous (2026-10-12). Under 30 km a
 * week the marathon-specificity penalty fires, and its PB-recency scaling used
 * step bands until 2026-10-11: the penalty's excess scaled by 0.5 under 365
 * days, 0.75 to 730 days, then 1.0 (inline in blendPredictions and
 * RUN_PB_RECENCY_BANDS for the triathlon legs). Measured with real
 * initializers before the fix: marathon PB 3:15 with a typed 20 km, today's
 * time 13022.65 to 13181.49 s at 1 year and 13189.73 to 13348.66 s at 2 years
 * (the standard marathon prediction moved the same; forecastTime did not).
 * Ironman run leg with a typed 30 km: 12306 to 12378 s and 12422 to 12495 s.
 * The factor is now continuous (pbRecencyPenaltyFactor, one function for
 * every site): 0.5 through the first year, as the first band was, then linear
 * to the full penalty at two years (orchestrator default 2026-10-12, the
 * lenient option over the straight line from 0.5 today). Each day across both
 * edges moves under 2 s, and never faster with age.
 */
describe('the low-volume PB-recency factor moves no number in a step at 1 or 2 years', () => {
  /**
   * Walk day by day across 365 and 730 days. Every value: never faster with
   * age, and each day under 2 s (the old band edge moved the marathon about
   * 159 s and the Ironman run leg 72 s). `wholeSecond` keys are race times
   * the triathlon predictor rounds once, at its output (since review round 5:
   * computeRaceTime used to round each leg before the readiness penalty, and
   * predictTriathlonRace rounded again, so a smooth drift ticked by up to 3
   * whole seconds). A drift under 2 s a day then ticks by at most 2 whole
   * seconds; their unrounded counterparts carry the under-2-s check. A
   * whole-second key may carry its own bound (`wholeSecondMax`), stated
   * where it is used.
   */
  function walk(
    read: (ageDays: number) => Record<string, number>,
    wholeSecond: string[] = [],
    wholeSecondMax: Record<string, number> = {},
  ): void {
    for (const edge of [365, 730]) {
      const days = [-3, -2, -1, 0, 1, 2, 3].map(d => edge + d);
      const snaps = days.map(read);
      for (let i = 1; i < snaps.length; i++) {
        for (const k of Object.keys(snaps[i])) {
          const step = snaps[i][k] - snaps[i - 1][k];
          // Older PB: never faster.
          expect(step).toBeGreaterThanOrEqual(-1e-6);
          if (wholeSecond.includes(k)) expect(step).toBeLessThanOrEqual(wholeSecondMax[k] ?? 2);
          else expect(step).toBeLessThan(2);
        }
      }
    }
  }

  it('marathon PB 3:15, typed 20 km a week: today\'s time, the standard marathon and the forecast', () => {
    const c: Case = { label: 'marathon PB 3:15, typed 20 km a week', rd: 'marathon', pbs: { m: 11700 }, key: 'm', seed: TYPED_20 };
    walk(ageDays => {
      const r = run(c, ageDays);
      return { brt: r.refresh.brt, stdMarathon: r.refresh.std.marathon!, ft: r.refresh.ft, onboardBrt: r.onboard.brt };
    });
  });

  it('the penalty still eases with a recent PB: a PB a year old reads faster than one two years old', () => {
    // The factor keeps the rule's direction (0.5 through a year, full penalty
    // from two years), so the low-volume marathon time rises with the PB's
    // age; after two years only the PB age weight moves it.
    const c: Case = { label: 'marathon PB 3:15, typed 20 km a week', rd: 'marathon', pbs: { m: 11700 }, key: 'm', seed: TYPED_20 };
    const at = (d: number) => run(c, d).refresh.brt;
    const [d0, d1, d2, d3] = [30, 365, 730, 1100].map(at);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThanOrEqual(d2);
  });

  it('Ironman, marathon PB 3:15, typed 30 km a week: the run penalty, the run leg, today\'s run leg and the totals', () => {
    // Before 2026-10-12 the race-day run leg stepped 72 s at each edge and
    // today's run leg (the full readiness penalty) about 490 s.
    const readIm = (ageDays: number) => {
      resetState();
      Object.assign(getMutableState(), { detectedWeeklyKm: 30, weeklyVolumeConfirmed: true });
      expect(initializeTriathlonSimulator({
        trainingMode: 'triathlon', triDistance: 'ironman', experienceLevel: 'intermediate',
        customRaceDate: planDay(20, 6), triSkillRating: { swim: 3, bike: 3, run: 3 },
        pbs: { m: 11700 }, pbDates: { m: new Date(Date.now() - ageDays * DAY_MS).toISOString() },
      } as OnboardingState).success).toBe(true);
      refreshBlendedFitness(getMutableState());
      const p = predictTriathlonRace(getState())!;
      const runSteps = p.legWaterfall!.run;
      // The waterfall's last step is the race-day run leg before the single
      // output rounding (computeRaceTime no longer rounds the leg first).
      const runLegUnrounded = runSteps[runSteps.length - 1].toSec;
      expect(p.runSec).toBe(Math.round(runLegUnrounded));
      for (const leg of ['swim', 'bike'] as const) {
        const steps = p.legWaterfall![leg];
        expect(p[`${leg}Sec`]).toBe(Math.round(steps[steps.length - 1].toSec));
      }
      return {
        p,
        runPenalty: computeTriRaceReadiness(getState(), 'ironman').run.penaltyMultiplier,
        runLegUnrounded,
      };
    };
    walk(ageDays => {
      const r = readIm(ageDays);
      expect(r.p.currentRunSec).toBeGreaterThan(r.p.runSec);
      return {
        runLegUnrounded: r.runLegUnrounded,
        runSec: r.p.runSec,
        totalSec: r.p.totalSec,
        currentRunSec: r.p.currentRunSec!,
        currentTotalSec: r.p.currentTotalSec!,
      };
    }, ['runSec', 'totalSec', 'currentRunSec', 'currentTotalSec'], {
      // Today's run leg carries the full readiness penalty, whose PB-recency
      // factor rises at 0.5 / 365 a day in the second year (0.5 through the
      // first, orchestrator default 2026-10-12): about 0.147 x 0.5 / 365 of
      // this Ironman run leg, roughly 2.6 s a day, so it ticks by up to 3
      // whole seconds. Smooth: the old band edge moved it about 490 s.
      currentRunSec: 3,
      currentTotalSec: 3,
    });
    // The run readiness penalty: one day moves it by at most the factor's
    // daily slope (0.5 / 365 in the second year, 0 in the first) times the
    // largest excess it scales (Ironman 0.15, MAX_PENALTY_BY_DISTANCE),
    // across both old edges.
    for (const edge of [365, 730]) {
      const pens = [-3, -2, -1, 0, 1, 2, 3].map(d => readIm(edge + d).runPenalty);
      expect(pens[0]).toBeGreaterThan(1);
      for (let i = 1; i < pens.length; i++) {
        expect(pens[i] - pens[i - 1]).toBeGreaterThanOrEqual(0);
        expect(pens[i] - pens[i - 1]).toBeLessThanOrEqual(0.15 * 0.5 / 365 + 1e-12);
      }
    }
    // One rounding, at the output (review round 5): inside the second year the
    // race-day run leg before that rounding moves by a steady amount a day.
    // With computeRaceTime rounding the leg first, the readiness step scaled a
    // whole-second leg, so it moved by about a second on some days and not on
    // others (the reviewer saw 1.21 s against 0.19 s on the days around).
    const legs = Array.from({ length: 12 }, (_, i) => readIm(420 + i).runLegUnrounded);
    const daily = legs.slice(1).map((v, i) => v - legs[i]);
    for (let i = 1; i < daily.length; i++) {
      expect(Math.abs(daily[i] - daily[i - 1])).toBeLessThan(0.05);
    }
  });
});

/**
 * Every day from 300 to 800 days (review 2026-10-12). Two rounding steps made
 * forecasts jump overnight as a PB aged, between the anniversaries the tests
 * above sample:
 *  - s.lt was stored as a whole second. PB age weights feed the LT derivation
 *    (pbsToBestEfforts), so the derived LT drifts a little every day, and the
 *    blend's LT predictor (up to about 0.8 of the marathon weight) ticked by
 *    1 s/km on one night: half PB 1:30 dated, typed 40 km, s.lt 256 to 257 at
 *    755 days, blendedRaceTimeSec +7.8 s and the standard marathon +50.7 s;
 *    all four PBs dated, typed 25 km, +52.4 s and +53.5 s at 466 and 729 days.
 *    s.lt now keeps the resolved pace unrounded (applyResolved, ltSync.ts).
 *  - vt stopped its bisection at a 0.05 VDOT error, a step function of the
 *    VDOT. A dated 10K beside an undated marathon PB drifts s.v a little every
 *    day, and the forecast's horizon delta jumped 15.45 s on two days (once
 *    faster). vt now converges in time.
 * Each case checks every forecast number the app shows for it, every day.
 */
describe('every day from 300 to 800 days: no forecast number steps (review 2026-10-12)', () => {
  const TYPED_25 = { detectedWeeklyKm: 25, weeklyVolumeConfirmed: true };
  const WALK: Array<{ c: Case; note: string }> = [
    {
      c: { label: 'half PB 1:30 dated, typed 40 km, half target', rd: 'half', pbs: { h: 5400 }, key: 'h', seed: TYPED_40 },
      note: 's.lt ticked 256 to 257 at 755 days',
    },
    {
      c: {
        label: 'all four PBs dated, typed 25 km, marathon target', rd: 'marathon',
        pbs: { k5: 1200, k10: 2500, h: 5500, m: 11700 }, dated: ['k5', 'k10', 'h', 'm'], seed: TYPED_25,
      },
      note: 's.lt ticked at 466 and 729 days',
    },
    {
      c: {
        label: 'drifting engine: 10K dated, marathon PB undated, typed 40 km, marathon target', rd: 'marathon',
        pbs: { k10: 2500, m: 11700 }, key: 'k10', seed: TYPED_40,
      },
      note: 'vt stepped the forecast 15.45 s on two days',
    },
  ];

  const read = (r: Snapshot): Record<string, number> => ({
    blendedRaceTimeSec: r.refresh.brt,
    forecastTime: r.refresh.ft,
    preview: r.onboard.preview,
    std5k: r.refresh.std['5k']!,
    std10k: r.refresh.std['10k']!,
    stdHalf: r.refresh.std.half!,
    stdMarathon: r.refresh.std.marathon!,
  });

  for (const { c, note } of WALK) {
    it(`${c.label} (${note})`, () => {
      const drifting = c.key === 'k10';
      let prev = run(c, 300);
      for (let day = 301; day <= 800; day++) {
        const cur = run(c, day);
        // The derived LT drifts continuously: hundredths of a second per km a
        // day, never the whole-second tick.
        expect(Math.abs(cur.refresh.lt! - prev.refresh.lt!)).toBeLessThan(0.05);
        const a = read(prev);
        const b = read(cur);
        for (const k of Object.keys(b)) {
          const step = b[k] - a[k];
          // Smooth drift; the ticks were 7.4 to 53.5 s. The largest daily
          // move is 1.13 s, in the four-PB case's second year (365 to 730
          // days): its 25 km a week fires the marathon-specificity penalty,
          // and the PB-recency factor rises at 0.5 / 365 a day there (held
          // at 0.5 through the first year, orchestrator default 2026-10-12).
          // Every other day and case moves under 0.75 s.
          expect(Math.abs(step), `${k} at ${day} days`).toBeLessThan(1.5);
          // Older PB: never faster. One exception, the drifting-engine
          // forecast: today's time stays on the undated marathon PB while the
          // engine falls 0.00013 VDOT a day with the 10K's age, and the
          // horizon delta tv(v) - tv(v + gain) grows a little as v falls (a
          // lower baseline gains more seconds per VDOT). About 0.0007 s a
          // day, 1.5 s over 8 years.
          const floor = drifting && (k === 'forecastTime' || k === 'preview') ? -0.01 : -1e-6;
          expect(step, `${k} at ${day} days`).toBeGreaterThanOrEqual(floor);
        }
        prev = cur;
      }
    });
  }
});
