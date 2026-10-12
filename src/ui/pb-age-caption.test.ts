/**
 * PB age caption: one copy for every surface whose numbers PB ageing changes
 * (Stats race estimates, the running Forecast tab and its no-race variant, the
 * triathlon Forecast tab, the HYROX run pace). Shown only when ageing moves a
 * number the surface displays by at least a whole second against the unaged
 * computation (orchestrator default 2026-10-12, adaptation-transparency rule).
 * The cheap first gate is pbAgeingActive on the shared measured-volume gate
 * (SCIENCE_LOG §DC). The weight is a smooth 3-year half-life, so the copy
 * names no age cut-off.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { SimulatorState } from '@/types';
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

import { defaultOnboardingState } from '@/types/onboarding';
import { getMutableState, getState, resetState } from '@/state/store';
import { initializeSimulator } from '@/state/initialization';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { localMondayKey } from '@/utils/local-date';
import { pbAgeCaptionText, pbAgeChangesDisplayed, standardDistancesDisplayed } from './pb-age-caption';

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

/** 10K PB 40:00, half target, dated `pbAgeDays` ago (undated when omitted). */
function runner(pbAgeDays: number | undefined, typedKm: number | undefined): SimulatorState {
  resetState();
  Object.assign(getMutableState(), {
    unitPref: 'km',
    ...(typedKm != null ? { detectedWeeklyKm: typedKm, weeklyVolumeConfirmed: true } : {}),
  });
  const ob = {
    ...defaultOnboardingState,
    name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
    raceDistance: 'half', selectedRace: null, hasSmartwatch: true,
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek: 4,
    experienceLevel: 'intermediate', pbs: { k10: 2400 },
    pbDates: pbAgeDays != null ? { k10: new Date(Date.now() - pbAgeDays * DAY_MS).toISOString() } : {},
  } as OnboardingState;
  getMutableState().onboarding = ob;
  expect(initializeSimulator(ob).success).toBe(true);
  return getState();
}

describe('pbAgeCaptionText', () => {
  it('a 3-year-old PB with a measured weekly volume moves the predictions, so the caption shows', () => {
    const s = runner(3 * 365, 35);
    expect(pbAgeChangesDisplayed(s, standardDistancesDisplayed)).toBe(true);
    expect(pbAgeCaptionText(s, 'these estimates', standardDistancesDisplayed)).toBe('Older PBs carry less weight in these estimates.');
  });

  it('a PB from yesterday is weighed (0.9994) but moves no displayed number by a second: no caption', () => {
    const s = runner(1, 35);
    expect(pbAgeChangesDisplayed(s, standardDistancesDisplayed)).toBe(false);
    expect(pbAgeCaptionText(s, 'these estimates', standardDistancesDisplayed)).toBeNull();
  });

  it('a surface whose numbers ageing does not move gets no caption', () => {
    const s = runner(3 * 365, 35);
    expect(pbAgeCaptionText(s, 'this forecast', () => [3600])).toBeNull();
  });

  it('no caption without a measured volume (the PB keeps full weight, §BV), for an undated PB, or with no PBs', () => {
    expect(pbAgeCaptionText(runner(3 * 365, undefined), 'this forecast', standardDistancesDisplayed)).toBeNull();
    expect(pbAgeCaptionText(runner(undefined, 35), 'this forecast', standardDistancesDisplayed)).toBeNull();
    expect(pbAgeCaptionText({ ...runner(3 * 365, 35), pbs: {} } as SimulatorState, 'this forecast', standardDistancesDisplayed)).toBeNull();
  });

  it('a typed PB faster than the dated onboarding time has no date, so no caption', () => {
    const s = { ...runner(3 * 365, 35), pbs: { k10: 2350 } } as SimulatorState;
    expect(pbAgeCaptionText(s, 'this forecast', standardDistancesDisplayed)).toBeNull();
  });

  it('triathlon run forecast: a 3-year-old half PB moves the run leg, so the caption shows; one from yesterday does not', () => {
    const tri = (pbAgeDays: number): SimulatorState => {
      resetState();
      Object.assign(getMutableState(), { detectedWeeklyKm: 30, weeklyVolumeConfirmed: true });
      expect(initializeTriathlonSimulator({
        trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate',
        customRaceDate: planDay(20, 6), triSkillRating: { swim: 3, bike: 3, run: 3 },
        pbs: { h: 5400 }, pbDates: { h: new Date(Date.now() - pbAgeDays * DAY_MS).toISOString() },
      } as OnboardingState).success).toBe(true);
      return getState();
    };
    const runLeg = (st: SimulatorState) => [predictTriathlonRace(st)?.runSec];
    expect(pbAgeCaptionText(tri(3 * 365), 'the run forecast', runLeg)).toBe('Older PBs carry less weight in the run forecast.');
    expect(pbAgeCaptionText(tri(1), 'the run forecast', runLeg)).toBeNull();
  });

  it('computing the caption leaves the live state untouched', () => {
    const s = runner(3 * 365, 35);
    const before = JSON.stringify(s);
    pbAgeCaptionText(s, 'these estimates', standardDistancesDisplayed);
    expect(JSON.stringify(s)).toBe(before);
  });
});
