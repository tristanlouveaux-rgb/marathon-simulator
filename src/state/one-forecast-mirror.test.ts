/**
 * One forecast, mirror modes (Tristan, 2026-10-11). The running initializer
 * ends with the launch refresh so the plan preview equals Home
 * (pb-age-continuity.test.ts covers running). The triathlon and HYROX
 * initializers end with it too: their onboarding previews read the same state
 * the first launch refreshes (tri-plan-forecast reads predictTriathlonRace; the
 * HYROX run pace "From VDOT" reads s.v and s.lt).
 *
 * Before, a 70.3 cold start (run skill 3, watch VO2max 62) left s.v at the
 * wizard's default 50 until launch: the preview's run leg read 1:28:17 against
 * 1:39:37 on Home.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
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

import { initializeTriathlonSimulator } from './initialization.triathlon';
import { initializeHyroxSimulator } from './initialization.hyrox';
import { getMutableState, getState, resetState } from './store';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { deriveHyroxRunPace } from '@/calculations/hyrox-run-pace';
import { localMondayKey } from '@/utils/local-date';
import { deriveLTFromVdot } from '@/calculations/lt-derivation';
import { runSkillVdot } from '@/calculations/tri-run-skill';

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

function initTri(seed: Partial<SimulatorState>, ob: Partial<OnboardingState> = {}): void {
  resetState();
  Object.assign(getMutableState(), seed);
  expect(initializeTriathlonSimulator({
    trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
    customRaceDate: planDay(20, 6), triSkillRating: { swim: 3, bike: 3, run: 3 }, ...ob,
  } as OnboardingState).success).toBe(true);
}

describe('triathlon: the onboarding forecast is the first launch\'s', () => {
  const CASES: Array<{ label: string; seed: Partial<SimulatorState>; ob?: Partial<OnboardingState> }> = [
    { label: 'cold start, watch 62', seed: { vo2: 62 } },
    { label: 'half PB, typed 30 km', seed: { detectedWeeklyKm: 30, weeklyVolumeConfirmed: true }, ob: { pbs: { h: 5400 } } },
    {
      label: 'half PB dated 2 years, typed 30 km',
      seed: { detectedWeeklyKm: 30, weeklyVolumeConfirmed: true },
      ob: { pbs: { h: 5400 }, pbDates: { h: new Date(Date.now() - 738 * DAY_MS).toISOString() } },
    },
  ];
  for (const c of CASES) {
    it(c.label, () => {
      initTri(c.seed, c.ob);
      const atInit = { v: getState().v, lt: getState().lt, pred: predictTriathlonRace(getState())! };
      refreshBlendedFitness(getMutableState());
      const pred = predictTriathlonRace(getState())!;
      expect(getState().v).toBeCloseTo(atInit.v, 9);
      expect(getState().lt).toBe(atInit.lt);
      expect(pred.runSec).toBeCloseTo(atInit.pred.runSec, 6);
      expect(pred.totalSec).toBeCloseTo(atInit.pred.totalSec, 6);
    });
  }

  it('the cold-start case previews the capped engine, not the wizard default', () => {
    initTri({ vo2: 62 });
    expect(getState().v).toBeLessThan(45);
    // The skill-3 LT, 288.37 s/km (unrounded since 2026-10-12; shown 4:48/km).
    expect(getState().lt).toBeCloseTo(deriveLTFromVdot(runSkillVdot(3))!, 9);
  });
});

describe('HYROX: the onboarding run pace is the first launch\'s', () => {
  it('s.v, s.lt and the VDOT-derived run pace agree at onboarding and after the first refresh', () => {
    resetState();
    Object.assign(getMutableState(), { detectedWeeklyKm: 35, weeklyVolumeConfirmed: true });
    expect(initializeHyroxSimulator({
      trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
      triTimeAvailableHoursPerWeek: 8, pbs: { k5: 1260, h: 5700 },
      pbDates: { h: new Date(Date.now() - 3 * 365 * DAY_MS).toISOString() },
    } as unknown as OnboardingState).success).toBe(true);
    const atInit = { v: getState().v, lt: getState().lt, pace: deriveHyroxRunPace(getState()).paceSecKm };
    refreshBlendedFitness(getMutableState());
    expect(getState().v).toBeCloseTo(atInit.v, 9);
    expect(getState().lt).toBe(atInit.lt);
    expect(deriveHyroxRunPace(getState()).paceSecKm).toBe(atInit.pace);
  });
});
