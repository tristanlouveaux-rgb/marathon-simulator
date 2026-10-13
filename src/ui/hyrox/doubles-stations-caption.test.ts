// @vitest-environment jsdom
/**
 * The doubles "Your stations" caption states the ratio only for the stations
 * it applies to. Stations from tests or seed times are singles × the station
 * ratio; splits from a doubles race are already the pair's time and are used
 * unscaled (review round 1, 2026-10-12).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { doublesStationsCaption, crossFormatConversionNote, crossFormatBannerBody } from './forecast-view';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { HyroxStationLine } from '@/calculations/race-prediction.hyrox';

const doubles = { stationRatio: 0.71, roxzoneRatio: 0.94, stationsSinglesPercentile: 50 };
const lines = (splits: number): HyroxStationLine[] =>
  HYROX_STATION_ORDER.map((station, i) => ({
    station, baseSec: 200, adjustedSec: 200, source: 'calibrated', teamRatio: 0.71,
    ...(i < splits ? { teamTimeSplit: true } : {}),
  }));

describe('doublesStationsCaption', () => {
  it('no race splits: the ratio covers every station', () => {
    const c = doublesStationsCaption({ doubles, stations: lines(0) });
    expect(c).toMatch(/Stations from tests or seed times are your singles time × 0\.71/);
    expect(c).not.toMatch(/doubles race/);
  });
  it('some race splits: the ratio clause excludes them', () => {
    const c = doublesStationsCaption({ doubles, stations: lines(3) });
    expect(c).toMatch(/Stations from tests or seed times/);
    expect(c).toMatch(/Splits from your doubles race are already the pair's time/);
  });
  it('all race splits: no ratio claim', () => {
    const c = doublesStationsCaption({ doubles, stations: lines(8) });
    expect(c).not.toMatch(/× 0\.71/);
    expect(c).toMatch(/split from your doubles race/);
  });
  it('copy rules: no em dash', () => {
    for (const n of [0, 3, 8]) expect(doublesStationsCaption({ doubles, stations: lines(n) })).not.toContain('—');
  });
});

describe('crossFormatConversionNote: a singles forecast from doubles race splits', () => {
  it('names the conversion and the ratio', () => {
    const note = crossFormatConversionNote({ crossFormatConversion: 'doubles_to_singles', crossFormatStationRatio: 0.7134 });
    expect(note).toContain('converted to singles terms');
    expect(note).toContain("the pair's time ÷ 0.71");
    expect(note).toContain('results data');
    expect(note).not.toContain('—');
  });

  it('is empty when nothing was converted', () => {
    expect(crossFormatConversionNote({})).toBe('');
  });

  it('says a singles time replaces only its own station (benchmarks resolve per station)', () => {
    const note = crossFormatConversionNote({ crossFormatConversion: 'doubles_to_singles', crossFormatStationRatio: 0.7134 });
    expect(note).toContain('replaces the converted time for its own station');
    expect(note).not.toMatch(/replace them\./);
  });
});

describe('crossFormatBannerBody: what is still converted, what is still a seed', () => {
  const protocol = 'each station at half distance, race effort';
  const singlesLines = (converted: number, calibrated: number): HyroxStationLine[] =>
    HYROX_STATION_ORDER.map((station, i) => ({
      station, baseSec: 200, adjustedSec: 200,
      source: i < calibrated ? 'calibrated' : 'seed',
      ...(i < converted ? { teamTimeSplit: true } : {}),
    }));

  it('all 8 converted', () => {
    const b = crossFormatBannerBody({ stations: singlesLines(8, 8), calibratedCount: 8 }, protocol);
    expect(b).toMatch(/^Station times are converted from your doubles race splits\./);
    expect(b).not.toContain('Population averages');
    expect(b).toContain('station by station');
  });

  it('7 converted after one singles test: the count follows the stations', () => {
    const b = crossFormatBannerBody({ stations: singlesLines(7, 8), calibratedCount: 8 }, protocol);
    expect(b).toMatch(/^7 of 8 station times are converted/);
    expect(b).not.toContain('Population averages');
  });

  it('3 converted, 5 on seeds: names both', () => {
    const b = crossFormatBannerBody({ stations: singlesLines(3, 3), calibratedCount: 3 }, protocol);
    expect(b).toMatch(/^3 of 8 station times are converted/);
    expect(b).toContain('Population averages still stand in for 5 stations.');
    const one = crossFormatBannerBody({ stations: singlesLines(3, 7), calibratedCount: 7 }, protocol);
    expect(one).toContain('Population averages still stand in for 1 station.');
  });

  it('copy rules: no em dash', () => {
    for (const [c, k] of [[8, 8], [7, 8], [3, 3]]) {
      expect(crossFormatBannerBody({ stations: singlesLines(c, k), calibratedCount: k }, protocol)).not.toContain('—');
    }
  });
});
