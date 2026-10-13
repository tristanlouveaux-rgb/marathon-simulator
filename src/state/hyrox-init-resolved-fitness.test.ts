/**
 * HYROX init resolves fitness before the band (review round 5, 2026-10-12).
 *
 * initializeHyroxSimulator's staleness re-band and its personal run-pace
 * offset read s.v and s.lt. They used to read the store defaults (s.v 50, no
 * wizard step writes it), and the launch refresh then moved them. Measured
 * (modes review): 10K 38:00 with a 58:00 open-singles HYROX 800 days ago was
 * re-banded competitive to intermediate "at VDOT 50", where the refreshed
 * engine is 55.2 (advanced). The offset was frozen against the placeholder
 * (+15 s/km in the review's case, where the refreshed engine gives +5).
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types/state';

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

import { initializeHyroxSimulator } from './initialization.hyrox';
import { getMutableState, resetState } from './store';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { bandFromVdot, computeHyroxStaleness } from '@/calculations/hyrox-staleness';
import { refreshHyroxPersonalRunPaceOffset, deriveHyroxRunPace } from '@/calculations/hyrox-run-pace';

const FROZEN_NOW = new Date();
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(FROZEN_NOW);
afterAll(() => { vi.useRealTimers(); });

const DAY = 86400000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);

function init(extra: Partial<OnboardingState>): SimulatorState {
  resetState();
  const ok = initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, ...extra,
  } as unknown as OnboardingState).success;
  expect(ok).toBe(true);
  return getMutableState();
}

const BAND_ORDER = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'] as const;

describe('HYROX init re-band reads the resolved engine, not the store default', () => {
  it('10K 38:00, 58:00 open singles 800 days ago: no re-band to intermediate', () => {
    const s = init({ pbs: { k10: 2280 }, previousHyroxTimeSec: 3480, hyroxPreviousTimeFormat: 'open_singles', hyroxPreviousRaceDate: ago(800) });
    expect(s.v).toBeGreaterThan(53); // the refreshed engine (advanced or better), not 50
    expect(s.hyroxConfig!.athleteBand).not.toBe('intermediate');
    // The init band is what the re-band rule gives on the launch state.
    const timeBand = s.hyroxConfig!.athleteBand;
    const st = computeHyroxStaleness(s);
    const vdotBand = bandFromVdot(s.v);
    const expected = st.bandWeight < 0.7 && vdotBand && vdotBand !== timeBand
      ? (BAND_ORDER.indexOf(timeBand) < BAND_ORDER.indexOf(vdotBand) ? timeBand : vdotBand)
      : timeBand;
    expect(timeBand).toBe(expected);
  });

  it('5K 24:00, 62:00 open singles 900 days ago: the slower engine band wins', () => {
    const s = init({ pbs: { k5: 1440 }, previousHyroxTimeSec: 3720, hyroxPreviousTimeFormat: 'open_singles', hyroxPreviousRaceDate: ago(900) });
    // Refreshed engine about 40 (novice); at the placeholder 50 the re-band
    // read intermediate.
    expect(bandFromVdot(s.v)).toBe('novice');
    expect(s.hyroxConfig!.athleteBand).toBe('novice');
  });

  it('the first launch refresh does not move the engine the band was read from', () => {
    const s = init({ pbs: { k10: 2280 }, previousHyroxTimeSec: 3480, hyroxPreviousTimeFormat: 'open_singles', hyroxPreviousRaceDate: ago(800) });
    const v = s.v;
    const lt = s.lt;
    refreshBlendedFitness(s);
    expect(s.v).toBe(v);
    expect(s.lt).toBe(lt);
  });
});

describe('HYROX init personal run-pace offset reads the resolved engine', () => {
  it('equals the offset refreshHyroxPersonalRunPaceOffset computes on the launch state', () => {
    const s = init({
      pbs: { k5: 1260, h: 5700 }, pbDates: { k5: ago(3 * 365), h: ago(3 * 365) },
      // With the lane H3b seeds a 4500 s finish back-computes to the model's
      // own pace (residual rounds to 0, so no offset is written); 4600 s keeps
      // a non-zero residual for the comparison below.
      previousHyroxTimeSec: 4600, hyroxPreviousTimeFormat: 'open_singles', hyroxPreviousRaceDate: ago(120),
    } as Partial<OnboardingState>);
    const initOffset = s.hyroxConfig!.personalRunPaceOffsetSec;
    expect(initOffset).toBeDefined();
    const initPace = deriveHyroxRunPace(s).paceSecKm;

    // Launch state, offset cleared and recomputed by the launch-time helper.
    refreshBlendedFitness(s);
    const launch = JSON.parse(JSON.stringify(s)) as SimulatorState;
    delete launch.hyroxConfig!.personalRunPaceOffsetSec;
    refreshHyroxPersonalRunPaceOffset(launch);
    expect(launch.hyroxConfig!.personalRunPaceOffsetSec).toBe(initOffset);
    expect(deriveHyroxRunPace(launch).paceSecKm).toBe(initPace);
  });
});
