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

import { doublesStationsCaption, crossFormatConversionNote } from './forecast-view';
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
});
