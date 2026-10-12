// @vitest-environment jsdom
/**
 * The training paces (s.pac) follow s.lt through the real initializers and the
 * launch order (close review 1 of lane v, 2026-10-12).
 *
 * s.pac is a cache of gp(engine VDOT, s.lt): the threshold pace IS the LT. It
 * used to be set only by the running initializer and refreshVO2Estimates, so:
 *   - triathlon, HYROX and Just-Track onboarding left the store default
 *     (Threshold 5:00/km, Easy 6:00/km). Measured: Just-Track 10K 45:00, LT
 *     headline 4:43/km beside a 5:00/km Threshold card; 70.3 with watch 62 at
 *     run skill 2, 5:45 vs 5:00; 70.3 with a 1:30 half, 4:16 vs 5:00; HYROX
 *     with a 38:00 10K, 4:01 vs 5:00.
 *   - the launch ran refreshVO2Estimates (s.pac from the saved s.lt) before
 *     refreshBlendedFitness moved s.lt. Half PB 1:30 dated 754 days, typed
 *     40 km: the next day s.lt went 256.4996 to 256.5002, the headline read
 *     4:17/km and the card 4:16/km, and stayed that way.
 * Now syncTrainingPaces (paces.ts) runs at the end of refreshBlendedFitness,
 * in recomputeLT and in refreshVO2Estimates. These tests go through the real
 * initializers and the launch order; none seeds s.pac by hand.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';

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
import { initializeTriathlonSimulator } from './initialization.triathlon';
import { initializeHyroxSimulator } from './initialization.hyrox';
import { getMutableState, getState, resetState } from './store';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { refreshVO2Estimates } from '@/data/vo2Sync';
import { recomputeLT } from '@/data/ltSync';
import { gp } from '@/calculations/paces';
import { getEffectiveVdot } from '@/calculations/effective-vdot';
import { buildLTMetricPage } from '@/ui/stats-view';
import { displayPaceSec } from '@/utils/format';
import { localMondayKey } from '@/utils/local-date';

const T0 = new Date();
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(T0);
afterAll(() => { vi.useRealTimers(); });

const DAY_MS = 86400000;

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** The LT page's hero headline and its Training Paces Threshold card. */
function ltPagePaces(): { headline: string | undefined; thresholdCard: string | undefined } {
  const html = buildLTMetricPage(getState());
  return {
    headline: html.match(/Lactate Threshold<\/div>[\s\S]*?tabular-nums">([^<]+)<\/span>/)?.[1],
    thresholdCard: html.match(/Threshold<\/div>\s*<div[^>]*>([^<]+)<\/div>/)?.[1],
  };
}

function expectPacesFollowLt(): void {
  const s = getState();
  expect(s.lt).not.toBeNull();
  const { headline, thresholdCard } = ltPagePaces();
  expect(headline).toBeDefined();
  expect(headline).not.toBe('—');
  expect(thresholdCard).toBe(headline);
  // The cache is exactly the one computation, every pace (the session
  // generator and the plan cards read easy, marathon and interval from it).
  expect(s.pac).toEqual(gp(getEffectiveVdot(s), s.lt));
}

describe('s.pac follows s.lt after each initializer (no launch in between)', () => {
  it('Just-Track, 10K PB 45:00', () => {
    resetState();
    expect(initializeSimulator({
      trainingMode: 'running', trackOnly: true, runsPerWeek: 4, experienceLevel: 'intermediate', pbs: { k10: 2700 },
    } as unknown as OnboardingState).success).toBe(true);
    expectPacesFollowLt();
    expect(ltPagePaces().thresholdCard).not.toBe('5:00/km'); // the store default
  });

  it('triathlon 70.3 cold start, watch 62 at run skill 2', () => {
    resetState();
    Object.assign(getMutableState(), { vo2: 62 });
    expect(initializeTriathlonSimulator({
      trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
      customRaceDate: planDay(16, 6), triSkillRating: { swim: 3, bike: 3, run: 2 },
    } as OnboardingState).success).toBe(true);
    expectPacesFollowLt();
  });

  it('triathlon 70.3 with a 1:30 half PB', () => {
    resetState();
    expect(initializeTriathlonSimulator({
      trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
      customRaceDate: planDay(16, 6), triSkillRating: { swim: 3, bike: 3, run: 3 }, pbs: { h: 5400 },
    } as OnboardingState).success).toBe(true);
    expectPacesFollowLt();
  });

  it('HYROX open singles, 10K PB 38:00', () => {
    resetState();
    expect(initializeHyroxSimulator({
      trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
      triTimeAvailableHoursPerWeek: 8, pbs: { k10: 2280 },
    } as unknown as OnboardingState).success).toBe(true);
    expectPacesFollowLt();
  });

  it('running, half PB 1:30', () => {
    resetState();
    const ob = {
      ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
      raceDistance: 'half', selectedRace: null, hasSmartwatch: true, customRaceDate: planDay(16, 6), planDurationWeeks: 16,
      runsPerWeek: 4, experienceLevel: 'intermediate', pbs: { h: 5400 },
    } as OnboardingState;
    getMutableState().onboarding = ob;
    expect(initializeSimulator(ob).success).toBe(true);
    expectPacesFollowLt();
  });
});

describe('s.pac follows s.lt across the launch order', () => {
  it('running: half PB 1:30 dated 754 days, typed 40 km; launch a day later', () => {
    vi.setSystemTime(T0);
    resetState();
    Object.assign(getMutableState(), { unitPref: 'km', detectedWeeklyKm: 40, weeklyVolumeConfirmed: true });
    const ob = {
      ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
      raceDistance: 'half', selectedRace: null, hasSmartwatch: true, customRaceDate: planDay(16, 6), planDurationWeeks: 16,
      runsPerWeek: 4, experienceLevel: 'intermediate', pbs: { h: 5400 },
      pbDates: { h: new Date(Date.now() - 754 * DAY_MS).toISOString() },
    } as OnboardingState;
    getMutableState().onboarding = ob;
    expect(initializeSimulator(ob).success).toBe(true);
    expectPacesFollowLt();
    const ltAtInit = getState().lt!;

    for (const later of [1, 30, 180]) {
      vi.setSystemTime(new Date(T0.getTime() + later * DAY_MS));
      // main.ts launch order: refreshVO2Estimates (s.pac from the saved s.lt),
      // then refreshBlendedFitness (moves s.lt as the PB ages).
      refreshVO2Estimates();
      refreshBlendedFitness(getMutableState());
      expectPacesFollowLt();
      if (later === 1) {
        // The case this walk exists for: the daily drift carries s.lt across
        // a half second, so a stale s.pac would display a different second.
        expect(displayPaceSec(getState().lt!)).not.toBe(displayPaceSec(ltAtInit));
      }
    }
    vi.setSystemTime(T0);
  });

  it('a watch LT through recomputeLT moves the paces with it (physiology sync path)', () => {
    resetState();
    expect(initializeSimulator({
      trainingMode: 'running', trackOnly: true, runsPerWeek: 4, experienceLevel: 'intermediate', pbs: { k10: 2700 },
    } as unknown as OnboardingState).success).toBe(true);
    const before = getState().lt!;
    recomputeLT(getMutableState(), { garmin: { ltPaceSecKm: before - 12, ltHR: 170, asOf: new Date().toISOString().slice(0, 10) } });
    expect(getState().lt).not.toBe(before);
    expectPacesFollowLt();
  });
});
