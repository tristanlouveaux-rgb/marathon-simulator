// @vitest-environment jsdom
/**
 * "Stations calibrated" is one number on every surface.
 *
 * The forecast (predictHyroxRace().calibratedCount), the plan-view benchmark
 * card, the Stats Benchmarks card and the Account HYROX card all count through
 * one per-station resolver (resolveHyroxBenchmarks via
 * hyroxCalibrationCoverage). Review 2026-10-13: an Open Singles target whose
 * previous race was doubles with 8 splits showed '8/8 stations calibrated' on
 * the Forecast and hid the benchmark card, while Stats read '0 / 8' with every
 * row 'Population est.' and Account read 0/8, because Stats and Account still
 * read only the target format's slot. The doubles target with singles
 * benchmarks only had the same split.
 *
 * Stats rows that come from the other format's slot keep the forecast's
 * reading: a doubles race split (the pair's time) shows in singles terms for a
 * singles target, never raw next to singles seeds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { getDefaultState, setState } from '@/state/store';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { hyroxCalibrationCoverage } from '@/calculations/hyrox-station-history';
import { shouldShowBenchmarkCard } from './benchmark-card';
import { hyroxBenchmarkLedger, renderHyroxStatsView } from './stats-view';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { ftRounded } from '@/utils/format';
import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';

const DAY_MS = 1000 * 60 * 60 * 24;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);

const DOUBLES_SPLITS: Record<HyroxStation, number> = {
  ski_erg: 200, sled_push: 140, sled_pull: 190, burpee_broad_jumps: 210,
  row_erg: 220, farmer_carry: 80, sandbag_lunges: 200, wall_balls: 320,
};
const SINGLES_TIMES: Record<HyroxStation, number> = {
  ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300,
  row_erg: 290, farmer_carry: 110, sandbag_lunges: 280, wall_balls: 430,
};
const raceHistory = (splits: Record<HyroxStation, number>, format: 'open_doubles' | 'open_singles') =>
  Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, [
    { dateISO: daysAgo(30), sec: splits[st], source: 'race' as const, format, proWeights: false },
  ]]));

function hyroxState(hx: Partial<NonNullable<SimulatorState['hyroxConfig']>>): SimulatorState {
  const s = getDefaultState();
  s.eventType = 'hyrox' as SimulatorState['eventType'];
  s.w = 1;
  s.wks = [];
  s.hyroxConfig = {
    format: 'open_singles',
    athleteBand: 'intermediate',
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: 1000,
    mtlHistory: [],
    runsPerWeek: 3,
    stationSessionsPerWeek: 1,
    bricksPerWeek: 1,
    weeklyHoursAvailable: 8,
    ...hx,
  } as NonNullable<SimulatorState['hyroxConfig']>;
  return s;
}

const CASES: Array<{ name: string; hx: Partial<NonNullable<SimulatorState['hyroxConfig']>> }> = [
  {
    name: 'singles target, doubles race splits only',
    hx: { format: 'open_singles', stationBenchmarksDoubles: { ...DOUBLES_SPLITS }, stationBenchmarkHistory: raceHistory(DOUBLES_SPLITS, 'open_doubles') },
  },
  {
    name: 'doubles target, singles benchmarks only',
    hx: { format: 'open_doubles', stationBenchmarksSingles: { ...SINGLES_TIMES }, stationBenchmarkHistory: raceHistory(SINGLES_TIMES, 'open_singles') },
  },
  {
    name: 'singles target, one singles test plus doubles race splits',
    hx: { format: 'open_singles', stationBenchmarksSingles: { ski_erg: 280 }, stationBenchmarksDoubles: { ...DOUBLES_SPLITS }, stationBenchmarkHistory: raceHistory(DOUBLES_SPLITS, 'open_doubles') },
  },
];

beforeEach(() => {
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('stations calibrated: forecast, benchmark card, Stats and Account agree', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const s = hyroxState(c.hx);
      const prediction = predictHyroxRace(s)!;
      const coverage = hyroxCalibrationCoverage(s.hyroxConfig!);
      const ledger = hyroxBenchmarkLedger(s.hyroxConfig!, prediction);

      expect(prediction.calibratedCount).toBe(8);
      expect(coverage.calibrated.length).toBe(prediction.calibratedCount);
      expect(ledger.calibratedCount).toBe(prediction.calibratedCount);
      expect(ledger.rows.every(r => r.sec != null)).toBe(true);
      // Nothing left to calibrate, so the benchmark card stays hidden.
      expect(shouldShowBenchmarkCard(s, 1)).toBe(false);

      // Stats renders the same count.
      setState(s);
      renderHyroxStatsView();
      const html = document.getElementById('app-root')!.innerHTML;
      expect(html).toContain('8 / 8 stations calibrated');
      // No station row on the seed; the one 'Population est.' left is the
      // run-pace row (no run pace on file in this state).
      expect((html.match(/Population est\./g) ?? []).length).toBe(1);
    });
  }

  it('Account counts through hyroxCalibrationCoverage, not the target slot alone', () => {
    const src = readFileSync(join(__dirname, '..', 'account-view.ts'), 'utf8');
    expect(src).toContain('hyroxCalibrationCoverage(hx)');
    expect(src).not.toMatch(/stationBenchmarksSingles|stationBenchmarksDoubles/);
  });

  it('Stats and the forecast chip detail read no benchmark slot directly', () => {
    for (const f of ['stats-view.ts', 'forecast-chip-detail-view.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src, f).toContain('hyroxCalibrationCoverage');
      expect(src, f).not.toMatch(/stationBenchmarksSingles|stationBenchmarksDoubles/);
    }
  });
});

describe('Stats ledger rows from the other format\'s slot', () => {
  it('singles target: a doubles race split shows in singles terms (÷ the forecast\'s ratio), captioned as converted', () => {
    const s = hyroxState(CASES[0].hx);
    const prediction = predictHyroxRace(s)!;
    const ratio = prediction.crossFormatStationRatio!;
    expect(ratio).toBeGreaterThan(0);
    const ledger = hyroxBenchmarkLedger(s.hyroxConfig!, prediction);
    for (const row of ledger.rows) {
      expect(row.convertedFromDoubles).toBe(true);
      expect(row.sec!).toBeCloseTo(DOUBLES_SPLITS[row.station] / ratio, 9);
      // Fresh open race: the forecast line carries the same singles-terms value.
      expect(row.sec!).toBeCloseTo(prediction.stations.find(l => l.station === row.station)!.baseSec, 6);
    }
    setState(s);
    renderHyroxStatsView();
    const html = document.getElementById('app-root')!.innerHTML;
    expect(html).toContain('Converted from doubles race');
    expect(html).toContain(ftRounded(DOUBLES_SPLITS.ski_erg / ratio));
    // The raw pair's time never shows.
    expect(html).not.toContain(`>${ftRounded(DOUBLES_SPLITS.wall_balls)}<`);
  });

  it('singles target: the singles test shows as stored, the other 7 stay converted', () => {
    const s = hyroxState(CASES[2].hx);
    const prediction = predictHyroxRace(s)!;
    const ledger = hyroxBenchmarkLedger(s.hyroxConfig!, prediction);
    const ski = ledger.rows.find(r => r.station === 'ski_erg')!;
    expect(ski).toEqual({ station: 'ski_erg', sec: 280, convertedFromDoubles: false });
    expect(ledger.rows.filter(r => r.convertedFromDoubles)).toHaveLength(7);
  });

  it('singles target: a solo test in the doubles slot is one athlete\'s time and shows as stored', () => {
    const s = hyroxState({
      format: 'open_singles',
      stationBenchmarksDoubles: { ski_erg: 270 },
      stationBenchmarkHistory: { ski_erg: [{ dateISO: daysAgo(5), sec: 270, source: 'half_test', format: 'open_doubles' }] },
    });
    const ledger = hyroxBenchmarkLedger(s.hyroxConfig!, predictHyroxRace(s));
    expect(ledger.rows.find(r => r.station === 'ski_erg')).toEqual({ station: 'ski_erg', sec: 270, convertedFromDoubles: false });
    expect(ledger.calibratedCount).toBe(1);
  });

  it('doubles target: singles times show as stored (the ledger\'s solo terms)', () => {
    const s = hyroxState(CASES[1].hx);
    const ledger = hyroxBenchmarkLedger(s.hyroxConfig!, predictHyroxRace(s));
    for (const row of ledger.rows) {
      expect(row).toEqual({ station: row.station, sec: SINGLES_TIMES[row.station], convertedFromDoubles: false });
    }
  });

  it('only testable stations are listed (no sled access: 6 rows)', () => {
    const s = hyroxState({ ...CASES[0].hx, stationAccess: { sled: 'never', skiErg: true, rowErg: true } });
    const ledger = hyroxBenchmarkLedger(s.hyroxConfig!, predictHyroxRace(s));
    expect(ledger.rows.map(r => r.station)).not.toContain('sled_push');
    expect(ledger.rows).toHaveLength(6);
    expect(ledger.calibratedCount).toBe(6);
  });
});
