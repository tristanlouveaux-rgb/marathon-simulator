/**
 * Just-Track computes fitness at onboarding the way the first launch does
 * (review round 5, 2026-10-12; mirror of one-forecast-mirror.test.ts).
 *
 * The wizard lands Just-Track on Home without launchApp. Before, its init
 * never ran refreshBlendedFitness (nor recomputeLT), so s.v stayed at the
 * store default 50 and s.lt null until the next app open. Measured (modes
 * review), 10K PB 45:00: the Stats race estimates read marathon 3:52:33 at
 * onboarding and 3:49:58 after the first relaunch.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';

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

import { initializeSimulator } from './initialization';
import { getMutableState, getState, resetState } from './store';
import { refreshBlendedFitness, predictStandardDistances } from '@/calculations/blended-fitness';

const FROZEN_NOW = new Date();
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(FROZEN_NOW);
afterAll(() => { vi.useRealTimers(); });

const DAY_MS = 86400000;

function initJustTrack(ob: Partial<OnboardingState>, seed: Record<string, unknown> = {}): void {
  resetState();
  Object.assign(getMutableState(), seed);
  expect(initializeSimulator({
    trainingMode: 'running', trackOnly: true, runsPerWeek: 4, experienceLevel: 'intermediate', ...ob,
  } as unknown as OnboardingState).success).toBe(true);
}

describe('Just-Track: the onboarding fitness is the first launch\'s', () => {
  const CASES: Array<{ label: string; ob: Partial<OnboardingState>; seed?: Record<string, unknown> }> = [
    { label: '10K PB 45:00', ob: { pbs: { k10: 2700 } } },
    {
      label: 'half PB 1:30 dated 3 years, typed 35 km',
      ob: { pbs: { h: 5400 }, pbDates: { h: new Date(Date.now() - 3 * 365 * DAY_MS).toISOString() } },
      seed: { detectedWeeklyKm: 35, weeklyVolumeConfirmed: true },
    },
  ];
  for (const c of CASES) {
    it(c.label, () => {
      initJustTrack(c.ob, c.seed);
      const atInit = { v: getState().v, lt: getState().lt, std: predictStandardDistances(getMutableState()) };
      expect(atInit.lt).not.toBeNull();
      refreshBlendedFitness(getMutableState());
      expect(getState().v).toBeCloseTo(atInit.v, 9);
      expect(getState().lt).toBe(atInit.lt);
      expect(predictStandardDistances(getMutableState())).toEqual(atInit.std);
    });
  }

  it('10K PB 45:00 reads the PB engine at onboarding, not the store default', () => {
    initJustTrack({ pbs: { k10: 2700 } });
    expect(getState().v).toBeLessThan(47); // about 45.3; the store default is 50
  });

  it('no PBs: init and launch agree, and no PB is invented', () => {
    initJustTrack({});
    const atInit = { v: getState().v, lt: getState().lt, pbs: JSON.stringify(getState().pbs ?? {}) };
    refreshBlendedFitness(getMutableState());
    expect(getState().v).toBe(atInit.v);
    expect(getState().lt).toBe(atInit.lt);
    expect(JSON.stringify(getState().pbs ?? {})).toBe(atInit.pbs);
  });
});
