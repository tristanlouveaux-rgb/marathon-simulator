import { describe, it, expect } from 'vitest';
import {
  appendStationTest,
  bestStationTime,
  getStationHistory,
  latestImprovementSec,
  latestIsPR,
  latestStationTest,
  latestTestAgeMonths,
  upsertRaceSplitEntry,
  type StationTestEntry,
} from './hyrox-station-history';
import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';

const DAY_MS = 1000 * 60 * 60 * 24;

function dateNDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function buildState(history: Partial<Record<HyroxStation, StationTestEntry[]>> = {}): SimulatorState {
  return {
    hyroxConfig: {
      stationBenchmarkHistory: history,
    },
  } as unknown as SimulatorState;
}

describe('hyrox-station-history', () => {
  describe('getStationHistory', () => {
    it('returns empty when no history', () => {
      const s = buildState();
      expect(getStationHistory(s, 'wall_balls')).toEqual([]);
    });

    it('returns sorted chronologically (oldest first)', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-04-01', sec: 220, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-01-01', sec: 240, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-03-01', sec: 230, source: 'half_test', format: 'open_singles' },
        ],
      });
      const h = getStationHistory(s, 'wall_balls');
      expect(h.map(e => e.dateISO)).toEqual(['2026-01-01', '2026-03-01', '2026-04-01']);
    });
  });

  describe('appendStationTest', () => {
    it('appends to empty history', () => {
      const result = appendStationTest(undefined, {
        dateISO: '2026-05-01', sec: 220, source: 'half_test', format: 'open_singles',
      });
      expect(result.length).toBe(1);
    });

    it('keeps result sorted chronologically after append', () => {
      const existing: StationTestEntry[] = [
        { dateISO: '2026-04-01', sec: 220, source: 'half_test', format: 'open_singles' },
      ];
      const result = appendStationTest(existing, {
        dateISO: '2026-01-01', sec: 240, source: 'half_test', format: 'open_singles',
      });
      expect(result.map(e => e.dateISO)).toEqual(['2026-01-01', '2026-04-01']);
    });
  });

  describe('latestStationTest', () => {
    it('returns null when no history', () => {
      expect(latestStationTest(buildState(), 'wall_balls')).toBeNull();
    });

    it('returns most recent entry by date (not insertion order)', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-04-01', sec: 220, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-01-01', sec: 240, source: 'half_test', format: 'open_singles' },
        ],
      });
      expect(latestStationTest(s, 'wall_balls')?.dateISO).toBe('2026-04-01');
    });
  });

  describe('latestTestAgeMonths', () => {
    it('returns null when no history', () => {
      expect(latestTestAgeMonths(buildState(), 'wall_balls')).toBeNull();
    });

    it('returns months ago for a recent test', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: dateNDaysAgo(60), sec: 220, source: 'half_test', format: 'open_singles' },
        ],
      });
      const age = latestTestAgeMonths(s, 'wall_balls');
      expect(age).toBeCloseTo(2.0, 0); // ~60 days = ~2 months
    });
  });

  describe('bestStationTime + latestIsPR', () => {
    it('best is the lowest sec for the format', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-01-01', sec: 240, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-03-01', sec: 220, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-04-01', sec: 230, source: 'half_test', format: 'open_singles' },
        ],
      });
      expect(bestStationTime(s, 'wall_balls', 'open_singles')?.sec).toBe(220);
    });

    it('latestIsPR is true when latest beats all priors', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-01-01', sec: 240, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-03-01', sec: 230, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-04-01', sec: 215, source: 'half_test', format: 'open_singles' },
        ],
      });
      expect(latestIsPR(s, 'wall_balls', 'open_singles')).toBe(true);
    });

    it('latestIsPR is false when latest is slower than a prior', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-01-01', sec: 200, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-04-01', sec: 215, source: 'half_test', format: 'open_singles' },
        ],
      });
      expect(latestIsPR(s, 'wall_balls', 'open_singles')).toBe(false);
    });

    it('latestIsPR is false with only one entry (no PR comparison possible)', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-04-01', sec: 215, source: 'half_test', format: 'open_singles' },
        ],
      });
      expect(latestIsPR(s, 'wall_balls', 'open_singles')).toBe(false);
    });

    it('PR check filters by format (singles PR doesn\'t count vs doubles)', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-01-01', sec: 200, source: 'half_test', format: 'open_doubles' },
          { dateISO: '2026-04-01', sec: 215, source: 'half_test', format: 'open_singles' },
        ],
      });
      // Only one singles entry → no PR.
      expect(latestIsPR(s, 'wall_balls', 'open_singles')).toBe(false);
    });
  });

  describe('latestImprovementSec', () => {
    it('returns negative when faster than previous', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-03-01', sec: 230, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-04-01', sec: 215, source: 'half_test', format: 'open_singles' },
        ],
      });
      expect(latestImprovementSec(s, 'wall_balls', 'open_singles')).toBe(-15);
    });

    it('returns positive when slower (regression)', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-03-01', sec: 215, source: 'half_test', format: 'open_singles' },
          { dateISO: '2026-04-01', sec: 230, source: 'half_test', format: 'open_singles' },
        ],
      });
      expect(latestImprovementSec(s, 'wall_balls', 'open_singles')).toBe(15);
    });

    it('returns null when fewer than 2 same-format entries', () => {
      const s = buildState({
        wall_balls: [
          { dateISO: '2026-04-01', sec: 215, source: 'half_test', format: 'open_singles' },
        ],
      });
      expect(latestImprovementSec(s, 'wall_balls', 'open_singles')).toBeNull();
    });
  });
});

describe('upsertRaceSplitEntry: one entry per logged race and station (review 2026-10-12)', () => {
  const race = (dateISO: string, sec: number, format: StationTestEntry['format'] = 'open_doubles') =>
    ({ dateISO, sec, source: 'race' as const, format });

  it('re-logging the same race (date and format) replaces its entry', () => {
    let h = upsertRaceSplitEntry(undefined, race('2026-03-14', 300));
    h = upsertRaceSplitEntry(h, race('2026-03-14', 280));
    expect(h).toEqual([race('2026-03-14', 280)]);
  });

  it('a different date or format is a different race and is kept', () => {
    let h = upsertRaceSplitEntry(undefined, race('2026-03-14', 300));
    h = upsertRaceSplitEntry(h, race('2026-06-20', 290));
    h = upsertRaceSplitEntry(h, race('2026-06-20', 400, 'open_singles'));
    expect(h.map(e => `${e.dateISO} ${e.format} ${e.sec}`)).toEqual([
      '2026-03-14 open_doubles 300',
      '2026-06-20 open_doubles 290',
      '2026-06-20 open_singles 400',
    ]);
  });

  it('never removes tests, session bests or the manual backfill on the race date', () => {
    const existing: StationTestEntry[] = [
      { dateISO: '2026-03-14', sec: 310, source: 'half_test', format: 'open_doubles' },
      { dateISO: '2026-03-14', sec: 305, source: 'manual', format: 'open_doubles' },
      { dateISO: '2026-03-14', sec: 300, source: 'session', format: 'open_doubles' },
    ];
    const h = upsertRaceSplitEntry(existing, race('2026-03-14', 280));
    expect(h.map(e => e.source).sort()).toEqual(['half_test', 'manual', 'race', 'session']);
  });
});
