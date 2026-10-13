/**
 * HYROX doubles through the real onboarding and logging paths (review round 1,
 * 2026-10-12).
 *
 * 1. Banding. The band thresholds and seed times are singles times, and the
 *    doubles forecast scales the band's singles seeds by the doubles ratios.
 *    A doubles target used to be banded on doubles terms (a doubles previous
 *    time as is, a singles one × 0.85), so the conversion ran twice: a
 *    doubles-median athlete was banded advanced, stations forecast 13% and
 *    Roxzone 35% faster than the doubles median, and the personal run-pace
 *    offset absorbed the gap (+13 to +31 s/km against the singles case).
 * 2. Provenance. A doubles race split is the pair's time. Logged after a half
 *    test, it was read as a solo time and scaled by the station ratio again.
 * 3. Weight regime. A logged race used to flip the config-wide
 *    benchmarksAtProWeights flag, re-applying the Pro multiplier to Pro-weight
 *    tests in the other slot.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';

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
import { applyHyroxPrevFormatChange } from './hyrox-prev-format-fix';
import { getMutableState, resetState } from './store';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { appendStationTest } from '@/calculations/hyrox-station-history';
import { hyroxOpenToProSec } from '@/calculations/hyrox-results';
import { HYROX_S89_POOLED_PERCENTILES, type HyroxPercentileTable } from '@/data/hyrox-results-s79';

const FROZEN_NOW = new Date();
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(FROZEN_NOW);
afterAll(() => { vi.useRealTimers(); });

const DAY = 86400000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
const p50 = (t: HyroxPercentileTable) => t.find(([, p]) => p === 50)![0];
// Real results, seasons 8 and 9, sexes pooled (no biological sex in these
// onboarding states).
const OD = HYROX_S89_POOLED_PERCENTILES.open_doubles!;
const OS = HYROX_S89_POOLED_PERCENTILES.open_singles!;

function init(extra: Partial<OnboardingState>): SimulatorState {
  resetState();
  const ok = initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_doubles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, pbs: { k10: 2700 }, ...extra,
  } as unknown as OnboardingState).success;
  expect(ok).toBe(true);
  return getMutableState();
}

/** Mirror of the benchmark card's half-test write (benchmark-card.ts). */
function logHalfTest(s: SimulatorState, station: HyroxStation, fullSec: number, dateISO: string): void {
  const hx = s.hyroxConfig!;
  const doubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  if (doubles) hx.stationBenchmarksDoubles = { ...(hx.stationBenchmarksDoubles ?? {}), [station]: fullSec };
  else hx.stationBenchmarksSingles = { ...(hx.stationBenchmarksSingles ?? {}), [station]: fullSec };
  hx.stationBenchmarkHistory = hx.stationBenchmarkHistory ?? {};
  hx.stationBenchmarkHistory[station] = appendStationTest(hx.stationBenchmarkHistory[station], {
    dateISO, sec: fullSec, source: 'half_test', format: hx.format, proWeights: !!hx.benchmarksAtProWeights,
  });
}

describe('doubles onboarding bands on singles terms', () => {
  const doublesMedian = p50(OD.total);
  const singlesMedian = p50(OS.total);

  it('a doubles-median previous time, no splits: stations and Roxzone near the doubles P50', () => {
    const s = init({ previousHyroxTimeSec: doublesMedian, hyroxPreviousTimeFormat: 'open_doubles' });
    const pred = predictHyroxRace(s)!;
    const stationsP50 = p50(OD.work_total);
    const roxzoneP50 = p50(OD.roxzone);
    const rawStations = pred.stations.reduce((a, l) => a + l.baseSec, 0);
    expect(Math.abs(rawStations - stationsP50) / stationsP50).toBeLessThan(0.05);
    expect(Math.abs(pred.roxzoneSec - roxzoneP50) / roxzoneP50).toBeLessThan(0.05);
  });

  it('the doubles-median athlete gets the same band and about the same run-pace offset as the singles-median athlete', () => {
    const singles = init({ hyroxFormat: 'open_singles', previousHyroxTimeSec: singlesMedian, hyroxPreviousTimeFormat: 'open_singles' });
    const singlesBand = singles.hyroxConfig!.athleteBand;
    const singlesOffset = singles.hyroxConfig!.personalRunPaceOffsetSec ?? 0;
    const doubles = init({ previousHyroxTimeSec: doublesMedian, hyroxPreviousTimeFormat: 'open_doubles' });
    expect(doubles.hyroxConfig!.athleteBand).toBe(singlesBand);
    expect(Math.abs((doubles.hyroxConfig!.personalRunPaceOffsetSec ?? 0) - singlesOffset)).toBeLessThanOrEqual(4);
  });

  it('a singles-median athlete aiming at doubles keeps the singles band and offset', () => {
    const singles = init({ hyroxFormat: 'open_singles', previousHyroxTimeSec: singlesMedian, hyroxPreviousTimeFormat: 'open_singles' });
    const toDoubles = init({ previousHyroxTimeSec: singlesMedian, hyroxPreviousTimeFormat: 'open_singles' });
    expect(toDoubles.hyroxConfig!.athleteBand).toBe(singles.hyroxConfig!.athleteBand);
    expect(toDoubles.hyroxConfig!.personalRunPaceOffsetSec).toBe(singles.hyroxConfig!.personalRunPaceOffsetSec);
  });

  it('"Log a previous HYROX time" bands a doubles race the same way', () => {
    const s = init({});
    applyHyroxPrevTimeUpdate({ timeSec: doublesMedian, format: 'open_doubles', raceDateISO: ago(30) });
    const singles = init({ hyroxFormat: 'open_singles', previousHyroxTimeSec: singlesMedian, hyroxPreviousTimeFormat: 'open_singles' });
    expect(s.hyroxConfig!.athleteBand).toBe(singles.hyroxConfig!.athleteBand);
  });
});

describe('doubles race splits logged after a half test stay the pair\'s time', () => {
  it('a race dated before the test: the split is used unscaled', () => {
    const s = init({});
    logHalfTest(s, 'ski_erg', 300, ago(5));
    const before = predictHyroxRace(s)!.stations.find(l => l.station === 'ski_erg')!;
    // The half test is one athlete's time: scaled by the station ratio.
    expect(before.teamTimeSplit).toBeUndefined();
    expect(before.baseSec).toBeCloseTo(300 * before.teamRatio!, 6);

    applyHyroxPrevTimeUpdate({
      timeSec: 4800, format: 'open_doubles', raceDateISO: ago(30),
      stationSplits: { ski_erg: 280, row_erg: 290 },
    });
    expect(s.hyroxConfig!.stationBenchmarksDoubles?.ski_erg).toBe(280);
    expect(s.hyroxConfig!.stationBenchmarkHistory?.ski_erg?.map(e => e.source)).toEqual(['race', 'half_test']);
    const after = predictHyroxRace(s)!.stations.find(l => l.station === 'ski_erg')!;
    expect(after.teamTimeSplit).toBe(true);
    expect(after.baseSec).toBeCloseTo(280, 6);
  });

  it('a race with no date (logged today): the split is used unscaled', () => {
    const s = init({});
    logHalfTest(s, 'ski_erg', 300, ago(5));
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_doubles', stationSplits: { ski_erg: 280 } });
    const line = predictHyroxRace(s)!.stations.find(l => l.station === 'ski_erg')!;
    expect(line.baseSec).toBeCloseTo(280, 6);
  });

  it('a new half test after the race is a solo time again', () => {
    const s = init({});
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_doubles', raceDateISO: ago(30), stationSplits: { ski_erg: 280 } });
    logHalfTest(s, 'ski_erg', 290, ago(1));
    const line = predictHyroxRace(s)!.stations.find(l => l.station === 'ski_erg')!;
    expect(line.teamTimeSplit).toBeUndefined();
    expect(line.baseSec).toBeCloseTo(290 * line.teamRatio!, 6);
  });

  it('onboarding splits from a doubles race are recorded as race entries', () => {
    const s = init({
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles', hyroxPreviousRaceDate: ago(30),
      hyroxPreviousStationSplits: { ski_erg: 280 },
    });
    expect(s.hyroxConfig!.stationBenchmarkHistory?.ski_erg).toEqual([
      { dateISO: ago(30), sec: 280, source: 'race', format: 'open_doubles', proWeights: false },
    ]);
    logHalfTest(s, 'row_erg', 300, ago(1));
    const pred = predictHyroxRace(s)!;
    expect(pred.stations.find(l => l.station === 'ski_erg')!.baseSec).toBeCloseTo(280, 6);
  });
});

describe('a logged race does not change the weight regime of station tests', () => {
  it('Pro singles athlete with Pro-weight tests logs an Open doubles race: the tests keep one Pro multiplier', () => {
    const s = init({ hyroxFormat: 'pro_singles' });
    s.hyroxConfig!.benchmarksAtProWeights = true;
    logHalfTest(s, 'sled_push', 260, ago(10));
    const before = predictHyroxRace(s)!.stations.find(l => l.station === 'sled_push')!;
    expect(before.baseSec).toBeCloseTo(260, 6);

    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_doubles', raceDateISO: ago(30), stationSplits: { sled_push: 150 } });
    expect(s.hyroxConfig!.benchmarksAtProWeights).toBe(true);
    const after = predictHyroxRace(s)!.stations.find(l => l.station === 'sled_push')!;
    expect(after.baseSec).toBeCloseTo(260, 6);
  });

  it('a Pro race split logged by a Pro target is not multiplied again; an Open one is, once', () => {
    const pro = init({ hyroxFormat: 'pro_singles' });
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'pro_singles', raceDateISO: ago(30), stationSplits: { sled_push: 260 } });
    expect(pro.hyroxConfig!.benchmarksAtProWeights).toBeUndefined();
    expect(predictHyroxRace(pro)!.stations.find(l => l.station === 'sled_push')!.baseSec).toBeCloseTo(260, 6);

    const open = init({ hyroxFormat: 'pro_singles' });
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_singles', raceDateISO: ago(30), stationSplits: { sled_push: 200 } });
    expect(predictHyroxRace(open)!.stations.find(l => l.station === 'sled_push')!.baseSec)
      .toBeCloseTo(hyroxOpenToProSec('sled_push', 200, 'pooled'), 6);
  });
});

describe('correcting the previous race format', () => {
  it('Open → Pro on the same axis: the race entries take Pro weights, so a Pro target applies no second multiplier', () => {
    const s = init({
      hyroxFormat: 'pro_singles', previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_singles',
      hyroxPreviousRaceDate: ago(30), hyroxPreviousStationSplits: { sled_push: 260 },
    });
    expect(predictHyroxRace(s)!.stations.find(l => l.station === 'sled_push')!.baseSec)
      .toBeCloseTo(hyroxOpenToProSec('sled_push', 260, 'pooled'), 6);
    applyHyroxPrevFormatChange('pro_singles');
    expect(s.hyroxConfig!.stationBenchmarkHistory?.sled_push?.[0]).toMatchObject({ source: 'race', format: 'pro_singles', proWeights: true });
    expect(predictHyroxRace(s)!.stations.find(l => l.station === 'sled_push')!.baseSec).toBeCloseTo(260, 6);
  });

  it('singles → doubles for a doubles target re-bands the time in the doubles field (field-relative, lane H3b)', () => {
    const doublesMedian = p50(OD.total);
    const s = init({ previousHyroxTimeSec: doublesMedian, hyroxPreviousTimeFormat: 'open_singles' });
    applyHyroxPrevFormatChange('open_doubles');
    // Read in the doubles field it holds the median: the same band as the
    // singles median in the singles field.
    expect(s.hyroxConfig!.athleteBand).toBe('intermediate');
    const singles = init({ hyroxFormat: 'open_singles', previousHyroxTimeSec: p50(OS.total), hyroxPreviousTimeFormat: 'open_singles' });
    expect(s.hyroxConfig!.athleteBand).toBe(singles.hyroxConfig!.athleteBand);
  });
});

describe('re-logging the same previous race does not duplicate its history entries', () => {
  it('same race date and format: the corrected splits replace the earlier entries', () => {
    const s = init({});
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_doubles', raceDateISO: ago(30), stationSplits: { ski_erg: 290, row_erg: 300 } });
    applyHyroxPrevTimeUpdate({ timeSec: 4790, format: 'open_doubles', raceDateISO: ago(30), stationSplits: { ski_erg: 280, row_erg: 300 } });
    const hist = s.hyroxConfig!.stationBenchmarkHistory!;
    expect(hist.ski_erg).toEqual([{ dateISO: ago(30), sec: 280, source: 'race', format: 'open_doubles', proWeights: false }]);
    expect(hist.row_erg).toHaveLength(1);
    expect(s.hyroxConfig!.stationBenchmarksDoubles?.ski_erg).toBe(280);
    expect(predictHyroxRace(s)!.stations.find(l => l.station === 'ski_erg')!.baseSec).toBeCloseTo(280, 6);
  });

  it('re-logging the onboarding race replaces the onboarding entries', () => {
    const s = init({
      previousHyroxTimeSec: 4800, hyroxPreviousTimeFormat: 'open_doubles', hyroxPreviousRaceDate: ago(30),
      hyroxPreviousStationSplits: { ski_erg: 290 },
    });
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_doubles', raceDateISO: ago(30), stationSplits: { ski_erg: 285 } });
    expect(s.hyroxConfig!.stationBenchmarkHistory!.ski_erg!.map(e => e.sec)).toEqual([285]);
  });

  it('an undated race re-logged the same day replaces its entries', () => {
    const s = init({});
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_doubles', stationSplits: { ski_erg: 290 } });
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_doubles', stationSplits: { ski_erg: 280 } });
    expect(s.hyroxConfig!.stationBenchmarkHistory!.ski_erg!.map(e => e.sec)).toEqual([280]);
  });

  it('a different race keeps both, and a test on the race date is untouched', () => {
    const s = init({});
    logHalfTest(s, 'ski_erg', 310, ago(30));
    applyHyroxPrevTimeUpdate({ timeSec: 4800, format: 'open_doubles', raceDateISO: ago(30), stationSplits: { ski_erg: 290 } });
    applyHyroxPrevTimeUpdate({ timeSec: 4700, format: 'open_doubles', raceDateISO: ago(10), stationSplits: { ski_erg: 280 } });
    expect(s.hyroxConfig!.stationBenchmarkHistory!.ski_erg!.map(e => `${e.source} ${e.sec}`).sort())
      .toEqual(['half_test 310', 'race 280', 'race 290']);
  });
});
