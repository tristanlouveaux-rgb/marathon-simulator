// @vitest-environment jsdom
/**
 * "Stations calibrated" is one number, over one denominator, on every surface.
 *
 * The forecast (predictHyroxRace().calibratedCount), the plan-view benchmark
 * card, the Stats Benchmarks card, the Account HYROX card and the forecast
 * chip detail all count through hyroxCalibrationCoverage (the per-station
 * resolver, resolveHyroxBenchmarks), out of all 8 raced stations.
 *
 * Review 2026-10-13: an Open Singles target whose previous race was doubles
 * with 8 splits showed '8/8 stations calibrated' on the Forecast and hid the
 * benchmark card, while Stats read '0 / 8' with every row 'Population est.'
 * and Account read 0/8, because Stats and Account still read only the target
 * format's slot. Then the Forecast counted raced stations while the other
 * surfaces counted testable ones: with no sled access and a sled race split
 * on file, the Forecast read 8/8 and Stats 6/6. Equipment access now only
 * decides which stations a test prompt lists.
 *
 * Stats rows are one athlete's time over the full station, the terms of the
 * seeds beside them and of the plan's targets: a doubles race split (the
 * pair's time) shows ÷ the forecast's station ratio for every target, never
 * raw next to singles seeds. Each row says where its value comes from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getDefaultState, setState } from '@/state/store';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { hyroxCalibrationCoverage } from '@/calculations/hyrox-station-history';
import { shouldShowBenchmarkCard, renderHyroxBenchmarkCard } from './benchmark-card';
import { hyroxBenchmarkLedger, renderHyroxStatsView } from './stats-view';
import { renderHyroxChipDetail } from './forecast-chip-detail-view';
import { renderAccountView } from '../account-view';
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

/** The rendered Stats count line, e.g. '8 / 8'. */
function statsCount(s: SimulatorState): string | null {
  setState(s);
  renderHyroxStatsView();
  const m = document.getElementById('app-root')!.innerHTML.match(/(\d+) \/ (\d+) stations calibrated/);
  return m ? `${m[1]} / ${m[2]}` : null;
}

/** The Account HYROX card's 'Stations' value, e.g. '8/8'. The account page
 *  renders its HTML synchronously before its async connection checks. */
function accountStations(s: SimulatorState): string | null {
  setState(s);
  void renderAccountView().catch(() => {});
  const m = document.getElementById('app-root')!.innerHTML.match(/>Stations<\/div>\s*<div[^>]*>([^<]+)<\/div>/);
  return m ? m[1].trim() : null;
}

/** The forecast chip detail's Stations page headline, e.g. '8/8'. */
function chipStations(s: SimulatorState): string | null {
  setState(s);
  renderHyroxChipDetail('stations');
  const m = document.getElementById('app-root')!.innerHTML.match(/>(\d+\/\d+)<\/div>/);
  return m ? m[1] : null;
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

describe('stations calibrated: forecast, benchmark card, Stats, Account and chip detail agree', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const s = hyroxState(c.hx);
      const prediction = predictHyroxRace(s)!;
      const coverage = hyroxCalibrationCoverage(s.hyroxConfig!);
      const ledger = hyroxBenchmarkLedger(s);

      expect(prediction.calibratedCount).toBe(8);
      expect(coverage.calibrated.length).toBe(prediction.calibratedCount);
      expect(ledger.calibratedCount).toBe(prediction.calibratedCount);
      expect(ledger.total).toBe(prediction.stations.length);
      expect(ledger.rows.every(r => r.sec != null)).toBe(true);
      // Nothing left to calibrate, so the benchmark card stays hidden.
      expect(shouldShowBenchmarkCard(s, 1)).toBe(false);

      // Stats renders the same count.
      expect(statsCount(s)).toBe('8 / 8');
      const html = document.getElementById('app-root')!.innerHTML;
      // No station row on the seed; the one 'Population est.' left is the
      // run-pace row (no run pace on file in this state).
      expect((html.match(/Population est\./g) ?? []).length).toBe(1);
      expect(accountStations(s)).toBe('8/8');
      expect(chipStations(s)).toBe('8/8');
    });
  }

  it('no sled access, sled race splits on file: every surface reads 8 / 8, as the forecast does', () => {
    const s = hyroxState({ ...CASES[0].hx, stationAccess: { sled: 'never', skiErg: true, rowErg: true } });
    const prediction = predictHyroxRace(s)!;
    expect(prediction.calibratedCount).toBe(8);
    expect(hyroxCalibrationCoverage(s.hyroxConfig!).calibrated).toHaveLength(8);
    const ledger = hyroxBenchmarkLedger(s);
    expect(ledger.rows.map(r => r.station)).toEqual(HYROX_STATION_ORDER);
    expect(ledger.rows.find(r => r.station === 'sled_push')!.sec).toBeDefined();
    expect(ledger.calibratedCount).toBe(8);
    expect(shouldShowBenchmarkCard(s, 1)).toBe(false);
    expect(statsCount(s)).toBe('8 / 8');
    expect(accountStations(s)).toBe('8/8');
    expect(chipStations(s)).toBe('8/8');
  });

  it('no sled access, no sled times: every surface reads 6 / 8; the card has nothing it can prompt', () => {
    const six = Object.fromEntries(Object.entries(SINGLES_TIMES).filter(([st]) => st !== 'sled_push' && st !== 'sled_pull'));
    const s = hyroxState({ format: 'open_singles', stationAccess: { sled: 'never', skiErg: true, rowErg: true }, stationBenchmarksSingles: six });
    expect(predictHyroxRace(s)!.calibratedCount).toBe(6);
    const ledger = hyroxBenchmarkLedger(s);
    expect(ledger.calibratedCount).toBe(6);
    expect(ledger.total).toBe(8);
    expect(ledger.rows.filter(r => r.sec == null).map(r => r.station)).toEqual(['sled_push', 'sled_pull']);
    expect(statsCount(s)).toBe('6 / 8');
    expect(accountStations(s)).toBe('6/8');
    expect(chipStations(s)).toBe('6/8');
    // Both pending stations need a sled: no test prompt.
    expect(shouldShowBenchmarkCard(s, 1)).toBe(false);
  });

  it('no sled access, one testable station pending: the card counts all 3 pending, lists the testable one', () => {
    const five = Object.fromEntries(Object.entries(SINGLES_TIMES).filter(([st]) => !['sled_push', 'sled_pull', 'wall_balls'].includes(st)));
    const s = hyroxState({ format: 'open_singles', stationAccess: { sled: 'never', skiErg: true, rowErg: true }, stationBenchmarksSingles: five });
    expect(predictHyroxRace(s)!.calibratedCount).toBe(5);
    expect(statsCount(s)).toBe('5 / 8');
    expect(accountStations(s)).toBe('5/8');
    expect(shouldShowBenchmarkCard(s, 1)).toBe(true);
    const card = renderHyroxBenchmarkCard(s);
    expect(card).toContain('3 stations still using population estimates.');
    expect(card).toContain('data-hx-bench-station="wall_balls"');
    expect(card).not.toContain('data-hx-bench-station="sled_push"');
    expect(card).toContain('Sled Push and Sled Pull need equipment not in your setup.');
    expect(card).not.toContain('—');
  });

  it('Account and the chip detail count through hyroxCalibrationCoverage, never a slot or the testable list', () => {
    const account = readFileSync(join(__dirname, '..', 'account-view.ts'), 'utf8');
    expect(account).toContain('hyroxCalibrationCoverage(hx)');
    expect(account).not.toMatch(/stationBenchmarksSingles|stationBenchmarksDoubles/);
    expect(account).not.toMatch(/coverage\?\.testable/);
    for (const f of ['stats-view.ts', 'forecast-chip-detail-view.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
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
    const ledger = hyroxBenchmarkLedger(s);
    for (const row of ledger.rows) {
      expect(row.basis).toBe('converted_from_doubles_race');
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
    const ledger = hyroxBenchmarkLedger(s);
    const ski = ledger.rows.find(r => r.station === 'ski_erg')!;
    expect(ski).toEqual({ station: 'ski_erg', sec: 280, basis: 'calibrated' });
    expect(ledger.rows.filter(r => r.basis === 'converted_from_doubles_race')).toHaveLength(7);
  });

  it('singles target: a solo test in the doubles slot is one athlete\'s time and shows as stored', () => {
    const s = hyroxState({
      format: 'open_singles',
      stationBenchmarksDoubles: { ski_erg: 270 },
      stationBenchmarkHistory: { ski_erg: [{ dateISO: daysAgo(5), sec: 270, source: 'half_test', format: 'open_doubles' }] },
    });
    const ledger = hyroxBenchmarkLedger(s);
    expect(ledger.rows.find(r => r.station === 'ski_erg')).toEqual({ station: 'ski_erg', sec: 270, basis: 'calibrated' });
    expect(ledger.rows.filter(r => r.basis === 'seed')).toHaveLength(7);
    expect(ledger.calibratedCount).toBe(1);
  });

  it('doubles target: singles times show as stored (the ledger\'s solo terms), captioned as from the singles benchmark', () => {
    const s = hyroxState(CASES[1].hx);
    const prediction = predictHyroxRace(s)!;
    // The forecast flags these stations as converted and caps confidence.
    expect(prediction.crossFormatConversion).toBe('singles_to_doubles');
    const ledger = hyroxBenchmarkLedger(s);
    for (const row of ledger.rows) {
      expect(row).toEqual({ station: row.station, sec: SINGLES_TIMES[row.station], basis: 'from_singles' });
    }
    setState(s);
    renderHyroxStatsView();
    const html = document.getElementById('app-root')!.innerHTML;
    expect(html).toContain('From singles benchmark');
    expect(html).not.toContain('>Calibrated<');
  });

  it('doubles target, own doubles race splits: the solo equivalent (the pair\'s time ÷ the forecast\'s ratio), never the pair\'s time', () => {
    const s = hyroxState({ format: 'open_doubles', stationBenchmarksDoubles: { ...DOUBLES_SPLITS }, stationBenchmarkHistory: raceHistory(DOUBLES_SPLITS, 'open_doubles') });
    const prediction = predictHyroxRace(s)!;
    const ratio = prediction.doubles!.stationRatio;
    expect(ratio).toBeLessThan(1);
    // Own format: nothing is cross-format, confidence is not capped by it.
    expect(prediction.crossFormatConversion).toBeUndefined();
    const ledger = hyroxBenchmarkLedger(s);
    for (const row of ledger.rows) {
      expect(row.basis).toBe('solo_of_doubles_race');
      expect(row.sec!).toBeCloseTo(DOUBLES_SPLITS[row.station] / ratio, 9);
      // The forecast line is the pair's time: the ledger value × the ratio.
      expect(row.sec! * ratio).toBeCloseTo(prediction.stations.find(l => l.station === row.station)!.baseSec, 6);
    }
    setState(s);
    renderHyroxStatsView();
    const html = document.getElementById('app-root')!.innerHTML;
    expect(html).toContain('Solo equivalent of doubles race');
    expect(html).toContain(ftRounded(DOUBLES_SPLITS.wall_balls / ratio));
    expect(html).not.toContain(`>${ftRounded(DOUBLES_SPLITS.wall_balls)}<`);
  });
});
