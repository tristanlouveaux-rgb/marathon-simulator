/**
 * "Log a previous HYROX": the result's run legs, run total and Roxzone are
 * stored with its station splits, and all four are replaced together, so
 * "where you lost time" never reads splits from an older race beside a new
 * finish.
 */
import { describe, it, expect, vi } from 'vitest';
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

import { initializeHyroxSimulator } from './initialization.hyrox';
import { applyHyroxPrevTimeUpdate } from './hyrox-prev-time-update';
import { getMutableState, resetState } from './store';
import { analyzeHyroxLoseTime } from '@/calculations/hyrox-lose-time';

function init() {
  resetState();
  const ok = initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, pbs: { k10: 2700 },
  } as unknown as OnboardingState).success;
  expect(ok).toBe(true);
  const s = getMutableState();
  s.biologicalSex = 'female';
  return s;
}

const LEGS = [271, 292, 310, 302, 315, 308, 312, 344];
const STATIONS = {
  ski_erg: 287, sled_push: 185, sled_pull: 320, burpee_broad_jumps: 340,
  row_erg: 298, farmer_carry: 125, sandbag_lunges: 301, wall_balls: 390,
} as const;

describe('applyHyroxPrevTimeUpdate stores the whole result', () => {
  it('run legs, run total and Roxzone sit beside the station splits', () => {
    const s = init();
    applyHyroxPrevTimeUpdate({
      timeSec: 5400, format: 'open_singles', raceDateISO: '2026-03-14',
      stationSplits: { ...STATIONS }, runSplitsSec: LEGS, runTotalSec: 2454, roxzoneSec: 372,
    });
    const hx = s.hyroxConfig!;
    expect(hx.hyroxPreviousStationSplits).toEqual(STATIONS);
    expect(hx.hyroxPreviousRunSplitsSec).toEqual(LEGS);
    expect(hx.hyroxPreviousRunTotalSec).toBe(2454);
    expect(hx.hyroxPreviousRoxzoneSec).toBe(372);
    const lt = analyzeHyroxLoseTime(s);
    expect(lt.status).toBe('ok');
    expect(lt.segments).toHaveLength(17);
  });

  it('a new finish logged without splits clears the older race\'s', () => {
    const s = init();
    applyHyroxPrevTimeUpdate({
      timeSec: 5400, format: 'open_singles', raceDateISO: '2026-03-14',
      stationSplits: { ...STATIONS }, runSplitsSec: LEGS, roxzoneSec: 372,
    });
    applyHyroxPrevTimeUpdate({ timeSec: 5100, format: 'open_singles', raceDateISO: '2026-09-20' });
    const hx = s.hyroxConfig!;
    expect(hx.hyroxPreviousStationSplits).toBeUndefined();
    expect(hx.hyroxPreviousRunSplitsSec).toBeUndefined();
    expect(hx.hyroxPreviousRoxzoneSec).toBeUndefined();
    // The March race splits stay in the station history, dated, but the
    // September finish is not compared with them.
    expect(analyzeHyroxLoseTime(s).status).toBe('no_splits');
  });
});
