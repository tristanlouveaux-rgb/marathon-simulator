/**
 * No forecast number steps on a PB's anniversary (Tristan, 2026-10-11).
 *
 * The PB age weight is a smooth 3-year half-life (pbAgeWeight), and the
 * same-distance PB floor keeps w of its strength for a PB of weight w
 * (demonstratedPBFloor, demonstratedPBFloorThrough). Review 3 (2026-10-09)
 * measured the binary floor at the 2-year mark, marathon PB 3:15, typed 40 km a
 * week: blendedRaceTimeSec 3:15:00 to 3:31:55 and forecastTime 3:09:36 to
 * 3:16:25 overnight. Real initializers, day by day across 1, 2, 3 and 4 years.
 * TRACKING side (race-time prediction).
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

import { initializeSimulator } from '@/state/initialization';
import { getMutableState, getState, resetState } from '@/state/store';
import { refreshBlendedFitness, predictStandardDistances } from './blended-fitness';
import { localMondayKey } from '@/utils/local-date';

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
  onboard: { brt: number; ft: number; v: number };
  refresh: { brt: number; ft: number; v: number; std: Record<string, number | null> };
}

type Case = {
  label: string;
  rd: 'marathon' | 'half';
  pbs: { h?: number; m?: number };
  key: 'h' | 'm';
  seed: Partial<SimulatorState>;
};

const TYPED_40 = { detectedWeeklyKm: 40, weeklyVolumeConfirmed: true };
const CASES: Case[] = [
  { label: 'marathon PB 3:15, typed 40 km a week', rd: 'marathon', pbs: { m: 11700 }, key: 'm', seed: TYPED_40 },
  { label: 'marathon PB 3:15, 56 km a week of synced runs', rd: 'marathon', pbs: { m: 11700 }, key: 'm', seed: { onboardingRunHistory: syncedWeeks() } },
  { label: 'half PB 1:30, typed 40 km a week', rd: 'half', pbs: { h: 5400 }, key: 'h', seed: TYPED_40 },
];

/** Onboard with the PB dated `ageDays` before now, then run the launch refresh. */
function run(c: Case, ageDays: number): Snapshot {
  resetState();
  Object.assign(getMutableState(), { unitPref: 'km', ...c.seed });
  const ob = {
    ...defaultOnboardingState,
    name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
    raceDistance: c.rd, selectedRace: null, hasSmartwatch: true,
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
    experienceLevel: 'intermediate', pbs: c.pbs,
    pbDates: { [c.key]: new Date(Date.now() - ageDays * DAY_MS).toISOString() },
  } as OnboardingState;
  getMutableState().onboarding = ob;
  expect(initializeSimulator(ob).success).toBe(true);
  const s0 = getState();
  const onboard = { brt: s0.blendedRaceTimeSec!, ft: s0.forecastTime!, v: s0.v };
  refreshBlendedFitness(getMutableState());
  const s1 = getState();
  return {
    onboard,
    refresh: { brt: s1.blendedRaceTimeSec!, ft: s1.forecastTime!, v: s1.v, std: predictStandardDistances(getMutableState()) },
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
