// @vitest-environment jsdom
/**
 * The doubles "Your stations" caption states the mapping only for the
 * stations it applies to. Stations from tests or seed times map from the solo
 * time station by station (lane H3b: per-station ratios on the real results,
 * the aggregate shown once); splits from a doubles race are already the
 * pair's time and are used unmapped (review round 1, 2026-10-12).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { doublesStationsCaption, crossFormatConversionNote, crossFormatBannerBody, hyroxConfidenceCaption } from './forecast-view';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { predictHyroxRace, type HyroxStationLine } from '@/calculations/race-prediction.hyrox';
import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';

const doubles = { stationRatio: 0.71, roxzoneRatio: 0.94, stationsSinglesPercentile: 50 };
const lines = (splits: number): HyroxStationLine[] =>
  HYROX_STATION_ORDER.map((station, i) => ({
    station, baseSec: 200, adjustedSec: 200, source: 'calibrated', teamRatio: 0.71,
    ...(i < splits ? { teamTimeSplit: true } : {}),
  }));

describe('doublesStationsCaption', () => {
  it('no race splits: the mapping covers every station, with the aggregate ratio and the cohort', () => {
    const c = doublesStationsCaption({ doubles, stations: lines(0) }, 'Open Doubles women');
    expect(c).toMatch(/Stations from tests or seed times map from your solo time station by station/);
    expect(c).toContain('Open Doubles women results');
    expect(c).toContain('×0.71 across all 8');
    expect(c).not.toMatch(/doubles race/);
  });
  it('some race splits: the ratio clause excludes them', () => {
    const c = doublesStationsCaption({ doubles, stations: lines(3) });
    expect(c).toMatch(/Stations from tests or seed times/);
    expect(c).toMatch(/Splits from your doubles race are already the pair's time/);
  });
  it('all race splits: no ratio claim', () => {
    const c = doublesStationsCaption({ doubles, stations: lines(8) });
    expect(c).not.toMatch(/×0\.71/);
    expect(c).toMatch(/split from your doubles race/);
  });
  it('copy rules: no em dash', () => {
    for (const n of [0, 3, 8]) expect(doublesStationsCaption({ doubles, stations: lines(n) })).not.toContain('—');
  });
});

describe('crossFormatConversionNote: a singles forecast from doubles race splits', () => {
  it('names the conversion and the ratio', () => {
    const note = crossFormatConversionNote({ crossFormatConversion: 'doubles_to_singles', crossFormatStationRatio: 0.7134 });
    expect(note).toContain('converted to singles terms station by station');
    expect(note).toContain("the pair's time ÷ 0.71 across those stations");
    expect(note).toContain('doubles and singles results');
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
      ...(i < converted ? { teamTimeSplit: true, crossFormat: true } : {}),
    }));
  const d2s = 'doubles_to_singles' as const;
  const body = (converted: number, calibrated: number, capped = true) =>
    crossFormatBannerBody({ stations: singlesLines(converted, calibrated), calibratedCount: calibrated, crossFormatConversion: d2s, ...(capped ? { crossFormatCapped: true } : {}) }, protocol);

  it('all 8 converted', () => {
    const b = body(8, 8);
    expect(b).toMatch(/^Station times are converted from your doubles race splits\./);
    expect(b).toContain('Converted times cap confidence at medium.');
    expect(b).not.toContain('untested station');
    expect(b).toContain('A singles station assessment');
    expect(b).toContain('station by station');
  });

  it('7 converted after one singles test: the count follows the stations', () => {
    const b = body(7, 8);
    expect(b).toMatch(/^7 of 8 station times are converted/);
    expect(b).not.toContain('untested station');
  });

  it('1 converted: singular verb', () => {
    const b = body(1, 8);
    expect(b).toMatch(/^1 of 8 station times is converted from your doubles race splits\./);
    expect(b).not.toContain('times are converted');
    // Plural stays plural.
    expect(body(2, 8)).toMatch(/^2 of 8 station times are converted/);
  });

  it('3 converted, 5 on seeds: names both', () => {
    const b = body(3, 3);
    expect(b).toMatch(/^3 of 8 station times are converted/);
    expect(b).toContain('5 untested stations use the median split of your ability band in the HYROX results.');
    expect(body(3, 7)).toContain('1 untested station uses the median split of your ability band in the HYROX results.');
  });

  it('solo times feeding a doubles forecast: names the solo source; only doubles race splits replace them (option A)', () => {
    const lines: HyroxStationLine[] = HYROX_STATION_ORDER.map((station, i) => ({
      station, baseSec: 200, adjustedSec: 200, source: 'calibrated', teamRatio: 0.71,
      ...(i < 1 ? { crossFormat: true } : {}),
    }));
    const b = crossFormatBannerBody({ stations: lines, calibratedCount: 8, crossFormatConversion: 'singles_to_doubles', crossFormatCapped: true }, protocol);
    expect(b).toMatch(/^1 of 8 station times is converted from your solo times\./);
    expect(b).toContain("Station splits from a doubles race replace them with the pair's own times");
    expect(b).not.toContain('station assessment');
    const all = crossFormatBannerBody({ stations: lines.map(l => ({ ...l, crossFormat: true })), calibratedCount: 8, crossFormatConversion: 'singles_to_doubles', crossFormatCapped: true }, protocol);
    expect(all).toMatch(/^Station times are converted from your solo times\./);
  });

  it('names the cap only when it binds (crossFormatCapped)', () => {
    // 2 calibrated stations: low whatever the conversion, so never capped.
    const low = body(1, 2, false);
    expect(low).toMatch(/^1 of 8 station times is converted/);
    expect(low).not.toContain('cap confidence');
    expect(low).toContain('6 untested stations use the median split of your ability band in the HYROX results.');
    expect(body(8, 8, true)).toContain('Converted times cap confidence at medium.');
    // 8 converted but held at medium by something else (no venue): no cap claim.
    expect(body(8, 8, false)).not.toContain('cap confidence');
  });

  it('real forecast: Open Singles, 1 doubles split, 7 stations on seeds and a venue reads low, and the banner drops the cap sentence', () => {
    const today = new Date().toISOString().slice(0, 10);
    const s = {
      v: 50,
      hyroxConfig: {
        format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
        stationAccess: { sled: 'always', skiErg: true, rowErg: true },
        weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3,
        stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
        venueId: 'london-excel',
        stationBenchmarksDoubles: { row_erg: 220 },
        stationBenchmarkHistory: { row_erg: [{ dateISO: today, sec: 220, source: 'race', format: 'open_doubles', proWeights: false }] },
      },
    } as any as SimulatorState;
    const prediction = predictHyroxRace(s)!;
    expect(prediction.crossFormatConversion).toBe('doubles_to_singles');
    expect(prediction.confidence).toBe('low');
    const b = crossFormatBannerBody(prediction, protocol);
    expect(b).toMatch(/^1 of 8 station times is converted from your doubles race splits\./);
    expect(b).not.toContain('cap confidence');
  });

  // Review 2026-10-13: an Open Singles athlete with 3 doubles race splits and
  // no venue read 'Converted times cap confidence at medium.', but 3
  // calibrated stations give medium without any cap.
  const singlesWithSplits = (splits: Partial<Record<HyroxStation, number>>, venueId?: string): SimulatorState => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      v: 50,
      hyroxConfig: {
        format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
        stationAccess: { sled: 'always', skiErg: true, rowErg: true },
        weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3,
        stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
        ...(venueId ? { venueId } : {}),
        stationBenchmarksDoubles: { ...splits },
        stationBenchmarkHistory: Object.fromEntries(Object.entries(splits).map(([st, sec]) => [st, [
          { dateISO: today, sec, source: 'race', format: 'open_doubles', proWeights: false },
        ]])),
      },
    } as any as SimulatorState;
  };
  const SPLITS: Record<HyroxStation, number> = {
    ski_erg: 200, sled_push: 140, sled_pull: 190, burpee_broad_jumps: 210,
    row_erg: 220, farmer_carry: 80, sandbag_lunges: 200, wall_balls: 320,
  };

  it('real forecast: 3 converted stations and no venue read medium without the cap, and neither the banner nor the caption blames the conversion', () => {
    const prediction = predictHyroxRace(singlesWithSplits({ ski_erg: SPLITS.ski_erg, row_erg: SPLITS.row_erg, wall_balls: SPLITS.wall_balls }))!;
    expect(prediction.crossFormatConversion).toBe('doubles_to_singles');
    expect(prediction.calibratedCount).toBe(3);
    expect(prediction.confidence).toBe('medium');
    expect(prediction.crossFormatCapped).toBeUndefined();
    const b = crossFormatBannerBody(prediction, protocol);
    expect(b).toMatch(/^3 of 8 station times are converted from your doubles race splits\./);
    expect(b).not.toContain('cap confidence');
    expect(b).toContain('5 untested stations use the median split of your ability band in the HYROX results.');
    const c = hyroxConfidenceCaption(prediction, false);
    expect(c).toBe('3/8 stations calibrated, 3 converted from your doubles race splits. Calibrate more to sharpen the prediction.');
  });

  it('real forecast: 8 converted stations and no venue are medium for the venue, not the cap', () => {
    const prediction = predictHyroxRace(singlesWithSplits(SPLITS))!;
    expect(prediction.confidence).toBe('medium');
    expect(prediction.crossFormatCapped).toBeUndefined();
    expect(crossFormatBannerBody(prediction, protocol)).not.toContain('cap confidence');
    expect(hyroxConfidenceCaption(prediction, false)).toBe('8/8 stations calibrated, 8 converted from your doubles race splits. No race venue is set, so confidence is medium.');
  });

  it('real forecast: 8 converted stations and a venue would read high, so the cap binds and both say so', () => {
    const prediction = predictHyroxRace(singlesWithSplits(SPLITS, 'london-excel'))!;
    expect(prediction.confidence).toBe('medium');
    expect(prediction.crossFormatCapped).toBe(true);
    expect(crossFormatBannerBody(prediction, protocol)).toContain('Converted times cap confidence at medium.');
    expect(hyroxConfidenceCaption(prediction, true)).toBe('8/8 stations calibrated, 8 converted from your doubles race splits. Converted times cap confidence at medium.');
  });

  it('copy rules: no em dash', () => {
    for (const [c, k] of [[8, 8], [7, 8], [3, 3], [1, 8]]) {
      expect(body(c, k)).not.toContain('—');
      expect(body(c, k, false)).not.toContain('—');
    }
  });
});

describe('hyroxConfidenceCaption: a cross-format cap says so', () => {
  const lines = (converted: number, calibrated: number): HyroxStationLine[] =>
    HYROX_STATION_ORDER.map((station, i) => ({
      station, baseSec: 200, adjustedSec: 200,
      source: i < calibrated ? 'calibrated' : 'seed',
      ...(i < converted ? { teamTimeSplit: true, crossFormat: true } : {}),
    }));

  it('medium held by the cap: names the conversion as the cap, never asks for more stations', () => {
    const c = hyroxConfidenceCaption({ stations: lines(8, 8), calibratedCount: 8, confidence: 'medium', crossFormatConversion: 'doubles_to_singles', crossFormatCapped: true }, true);
    expect(c).toBe('8/8 stations calibrated, 8 converted from your doubles race splits. Converted times cap confidence at medium.');
    expect(c).not.toContain('Calibrate more');
    expect(c).not.toContain('—');
  });

  it('medium with converted times but not held by the cap: names the conversion, no cap claim', () => {
    const partial = hyroxConfidenceCaption({ stations: lines(3, 3), calibratedCount: 3, confidence: 'medium', crossFormatConversion: 'doubles_to_singles' }, false);
    expect(partial).toBe('3/8 stations calibrated, 3 converted from your doubles race splits. Calibrate more to sharpen the prediction.');
    const full = hyroxConfidenceCaption({ stations: lines(8, 8), calibratedCount: 8, confidence: 'medium', crossFormatConversion: 'doubles_to_singles' }, false);
    expect(full).toBe('8/8 stations calibrated, 8 converted from your doubles race splits. No race venue is set, so confidence is medium.');
    for (const c of [partial, full]) {
      expect(c).not.toContain('cap confidence');
      expect(c).not.toContain('—');
    }
  });

  it('medium without converted times keeps the calibrate-more caption below 6 calibrated stations', () => {
    expect(hyroxConfidenceCaption({ stations: lines(0, 4), calibratedCount: 4, confidence: 'medium' }, false))
      .toBe('4/8 stations calibrated. Calibrate more to sharpen the prediction.');
  });

  it('medium at 6+ calibrated stations names what holds it there, never "Calibrate more" (review 2026-10-13)', () => {
    const stale = hyroxConfidenceCaption({ stations: lines(0, 8), calibratedCount: 8, confidence: 'medium', staleness: { ageMonths: 9.2, category: 'aging', physiologyMitigation: 0.3 } }, true);
    expect(stale).toBe('8/8 stations calibrated. The race is 9 months old, so confidence is medium.');
    const noVenue = hyroxConfidenceCaption({ stations: lines(0, 6), calibratedCount: 6, confidence: 'medium' }, false);
    expect(noVenue).toBe('6/8 stations calibrated. No race venue is set, so confidence is medium.');
    for (const c of [stale, noVenue]) {
      expect(c).not.toContain('Calibrate more');
      expect(c).not.toContain('—');
    }
  });

  it('high and low are unchanged', () => {
    expect(hyroxConfidenceCaption({ stations: lines(0, 8), calibratedCount: 8, confidence: 'high' }, true))
      .toBe('Based on 8/8 calibrated benchmarks and venue factors.');
    expect(hyroxConfidenceCaption({ stations: lines(2, 2), calibratedCount: 2, confidence: 'low', crossFormatConversion: 'doubles_to_singles' }, false))
      .toContain('Mostly seed data.');
  });

  it('low from a stale race says so, not "mostly seed data" (H1 review: 8/8 read "Only 8/8 stations calibrated")', () => {
    const c = hyroxConfidenceCaption({ stations: lines(0, 8), calibratedCount: 8, confidence: 'low', staleness: { ageMonths: 20.2, category: 'stale', physiologyMitigation: 0.6 } }, true);
    expect(c).toBe('8/8 stations calibrated. The race is 20 months old, so confidence is low.');
    expect(c).not.toContain('seed');
    expect(c).not.toContain('—');
  });

  it('real forecast: 8 calibrated splits and a 20-month-old race read the race age', () => {
    const SPLITS: Record<HyroxStation, number> = { ski_erg: 280, sled_push: 180, sled_pull: 300, burpee_broad_jumps: 330, row_erg: 300, farmer_carry: 130, sandbag_lunges: 300, wall_balls: 420 };
    const d = new Date(Date.now() - 20 * 30.44 * 86400000).toISOString().slice(0, 10);
    const p = predictHyroxRace({
      hyroxConfig: {
        format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
        stationAccess: { sled: 'always', skiErg: true, rowErg: true },
        weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3, stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
        venueId: 'london-excel', stationBenchmarksSingles: SPLITS, hyroxPreviousRaceDate: d,
      },
    } as unknown as SimulatorState)!;
    expect(p.confidence).toBe('low');
    expect(hyroxConfidenceCaption(p, true)).toMatch(/^8\/8 stations calibrated\. The race is (19|20) months old, so confidence is low\.$/);
  });

  it('real forecast: 8 calibrated stations, a venue and a 9-month-old race read medium and name the race age', () => {
    const SPLITS: Record<HyroxStation, number> = { ski_erg: 280, sled_push: 180, sled_pull: 300, burpee_broad_jumps: 330, row_erg: 300, farmer_carry: 130, sandbag_lunges: 300, wall_balls: 420 };
    const d = new Date(Date.now() - 9 * 30.44 * 86400000).toISOString().slice(0, 10);
    const p = predictHyroxRace({
      hyroxConfig: {
        format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
        stationAccess: { sled: 'always', skiErg: true, rowErg: true },
        weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3, stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
        venueId: 'london-excel', stationBenchmarksSingles: SPLITS, hyroxPreviousRaceDate: d,
      },
    } as unknown as SimulatorState)!;
    expect(p.calibratedCount).toBe(8);
    expect(p.confidence).toBe('medium');
    expect(hyroxConfidenceCaption(p, true)).toMatch(/^8\/8 stations calibrated\. The race is (8|9) months old, so confidence is medium\.$/);
  });
});
