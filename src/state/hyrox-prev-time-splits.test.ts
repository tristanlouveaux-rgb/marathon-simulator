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
import { hyroxPlanningBandFor } from '@/calculations/hyrox-planning-band';

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
    // 8 stations, Running (the 8 legs together) and the Roxzone.
    expect(lt.segments).toHaveLength(10);
  });

  it('benchmarkSplits limits what reaches the station benchmarks; a doubles result keeps its division', () => {
    const s = init();
    s.hyroxConfig!.stationBenchmarksDoubles = { ski_erg: 250 } as NonNullable<typeof s.hyroxConfig>['stationBenchmarksDoubles'];
    applyHyroxPrevTimeUpdate({
      timeSec: 4800, format: 'open_doubles', division: 'mixed', raceDateISO: '2026-03-14',
      stationSplits: { ski_erg: 260, wall_balls: 300 }, benchmarkSplits: { wall_balls: 300 },
    });
    const hx = s.hyroxConfig!;
    expect(hx.hyroxPreviousStationSplits).toEqual({ ski_erg: 260, wall_balls: 300 });
    expect(hx.stationBenchmarksDoubles?.ski_erg).toBe(250);
    expect(hx.stationBenchmarksDoubles?.wall_balls).toBe(300);
    expect(hx.hyroxPreviousTimeDivision).toBe('mixed');
    // A singles result carries no division.
    applyHyroxPrevTimeUpdate({ timeSec: 5400, format: 'open_singles', division: 'mixed' });
    expect(hx.hyroxPreviousTimeDivision).toBeUndefined();
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

  it('re-saving the same result untouched keeps its splits and leaves a newer test as the benchmark', () => {
    const s = init();
    applyHyroxPrevTimeUpdate({
      timeSec: 5400, format: 'open_singles', raceDateISO: '2026-03-14',
      stationSplits: { ...STATIONS }, runSplitsSec: LEGS, roxzoneSec: 372,
    });
    // A station test after the race is the current SkiErg benchmark.
    s.hyroxConfig!.stationBenchmarksSingles = { ...s.hyroxConfig!.stationBenchmarksSingles, ski_erg: 270 };
    applyHyroxPrevTimeUpdate({ timeSec: 5400, format: 'open_singles', raceDateISO: '2026-03-14', keepPreviousSplits: true });
    const hx = s.hyroxConfig!;
    expect(hx.hyroxPreviousStationSplits).toEqual(STATIONS);
    expect(hx.hyroxPreviousRunSplitsSec).toEqual(LEGS);
    expect(hx.hyroxPreviousRoxzoneSec).toBe(372);
    expect(hx.stationBenchmarksSingles?.ski_erg).toBe(270);
  });
});

describe('the past doubles result reads the division it was raced in everywhere', () => {
  function doublesAthlete(division: 'women' | 'mixed') {
    const s = init();
    s.hyroxConfig!.format = 'open_doubles';
    s.hyroxConfig!.division = division;
    s.hyroxConfig!.personalRunPaceOffsetSec = undefined;
    return s;
  }

  it('planning band and personal run pace use the Mixed race, not the athlete\'s current Women\'s division', () => {
    const now = doublesAthlete('women');
    applyHyroxPrevTimeUpdate({ timeSec: 4700, format: 'open_doubles', division: 'mixed', raceDateISO: '2026-03-14', stationSplits: { ...STATIONS } });
    expect(now.hyroxConfig!.athleteBand).toBe(hyroxPlanningBandFor(4700, 'open_doubles', 'female', 'women', 'mixed'));
    const offsetFromPast = now.hyroxConfig!.personalRunPaceOffsetSec;
    expect(typeof offsetFromPast).toBe('number');
    // The same result logged by an athlete whose current division is Mixed.
    const same = doublesAthlete('mixed');
    applyHyroxPrevTimeUpdate({ timeSec: 4700, format: 'open_doubles', division: 'mixed', raceDateISO: '2026-03-14', stationSplits: { ...STATIONS } });
    expect(offsetFromPast).toBe(same.hyroxConfig!.personalRunPaceOffsetSec);
    expect(analyzeHyroxLoseTime(now).cohort).toEqual({ format: 'open_doubles', sex: 'mixed' });
    // Without a recorded division the current Women's field is read, and the
    // run pace comes out differently.
    const unrecorded = doublesAthlete('women');
    applyHyroxPrevTimeUpdate({ timeSec: 4700, format: 'open_doubles', raceDateISO: '2026-03-14', stationSplits: { ...STATIONS } });
    expect(typeof unrecorded.hyroxConfig!.personalRunPaceOffsetSec).toBe('number');
    expect(unrecorded.hyroxConfig!.personalRunPaceOffsetSec).not.toBe(offsetFromPast);
  });

  it('no sex on file, a Women pick, a Mixed race: run pace reads her own women\'s field, as her planning band does', () => {
    // hyroxPlanningBandFor's rule: the athlete's sex from biological sex,
    // then the current division, then the race's; the race division names
    // the race field only.
    const noSex = doublesAthlete('women');
    noSex.hyroxConfig!.format = 'open_singles';
    noSex.biologicalSex = undefined;
    applyHyroxPrevTimeUpdate({ timeSec: 4700, format: 'open_doubles', division: 'mixed', raceDateISO: '2026-03-14', stationSplits: { ...STATIONS } });
    expect(noSex.hyroxConfig!.athleteBand).toBe(hyroxPlanningBandFor(4700, 'open_doubles', 'female', 'women', 'mixed'));
    const offsetNoSex = noSex.hyroxConfig!.personalRunPaceOffsetSec;
    expect(typeof offsetNoSex).toBe('number');
    // The same athlete with her sex on file: the same women's field.
    const withSex = doublesAthlete('women');
    withSex.hyroxConfig!.format = 'open_singles';
    applyHyroxPrevTimeUpdate({ timeSec: 4700, format: 'open_doubles', division: 'mixed', raceDateISO: '2026-03-14', stationSplits: { ...STATIONS } });
    expect(offsetNoSex).toBe(withSex.hyroxConfig!.personalRunPaceOffsetSec);
    // No pick either: the pooled field, a different pace.
    const pooled = doublesAthlete('women');
    pooled.hyroxConfig!.format = 'open_singles';
    pooled.hyroxConfig!.division = undefined;
    pooled.biologicalSex = undefined;
    applyHyroxPrevTimeUpdate({ timeSec: 4700, format: 'open_doubles', division: 'mixed', raceDateISO: '2026-03-14', stationSplits: { ...STATIONS } });
    expect(pooled.hyroxConfig!.personalRunPaceOffsetSec).not.toBe(offsetNoSex);
  });
});
