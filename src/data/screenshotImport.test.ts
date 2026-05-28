/**
 * Screenshot import — OCR/AI text parsing + row conversion.
 *
 * Fixture mirrors the real Strava run screenshots Tristan shared (Splits table
 * with per-km pace/elev/HR, plus avg pace, moving time, avg/max HR, distance).
 */

import { describe, it, expect } from 'vitest';
import {
  parseScreenshotText,
  parseClockToSec,
  parsedFromAIJson,
  parsedHrSeriesFromAIJson,
  screenshotActivityToRow,
  type ParsedScreenshotActivity,
  type ScreenshotEnrichmentContext,
} from './screenshotImport';

// Recognised-text shape an OCR pass would yield from the shared screenshots.
const STRAVA_OCR = `Run
Workout Analysis
Splits
Km Pace Elev HR
1 5:30 7 131
2 5:29 -1 133
3 5:29 5 133
4 5:52 -1 129
5 6:10 -2 128
6 5:30 1 135
7 5:50 1 136
0.5 5:24 -1 137
Pace
Avg Pace 5:41 /km
Moving Time 42:34
Heart Rate
Avg Heart Rate 132 bpm
Max Heart Rate 146 bpm
Distance 7.5`;

describe('parseClockToSec', () => {
  it('parses mm:ss', () => expect(parseClockToSec('42:34')).toBe(2554));
  it('parses h:mm:ss', () => expect(parseClockToSec('1:23:45')).toBe(5025));
  it('returns null on garbage', () => expect(parseClockToSec('abc')).toBeNull());
});

describe('parseScreenshotText — Strava run', () => {
  const p = parseScreenshotText(STRAVA_OCR);

  it('reads moving time', () => expect(p.durationSec).toBe(2554));
  it('reads avg pace', () => expect(p.avgPaceSecKm).toBe(341)); // 5:41
  it('reads avg + max HR', () => {
    expect(p.avgHR).toBe(132);
    expect(p.maxHR).toBe(146);
  });
  it('reads distance', () => expect(p.distanceM).toBe(7500));
  it('reads all 8 splits with pace + HR', () => {
    expect(p.splits).toHaveLength(8);
    expect(p.splits[0]).toEqual({ km: 1, paceSecKm: 330, hr: 131 });
    expect(p.splits[4]).toEqual({ km: 5, paceSecKm: 370, hr: 128 }); // line had a "-2" elev
    expect(p.splits[7]).toEqual({ km: 0.5, paceSecKm: 324, hr: 137 });
  });
  it('is high confidence with nothing missing', () => {
    expect(p.confidence).toBe('high');
    expect(p.missing).toEqual([]);
  });
});

describe('parseScreenshotText — degraded input', () => {
  it('flags missing fields and low confidence when sparse', () => {
    const p = parseScreenshotText('Run\nsome blurry text\nAvg Heart Rate 140 bpm');
    expect(p.missing).toContain('distance');
    expect(p.missing).toContain('duration');
    expect(p.confidence).toBe('low');
  });

  it('derives distance from splits when the header distance is unreadable', () => {
    const p = parseScreenshotText('1 5:00 120\n2 5:00 120\n3 5:00 120\nMoving Time 15:00');
    expect(p.distanceM).toBe(3000);
  });
});

describe('parsedFromAIJson', () => {
  it('coerces clean AI JSON', () => {
    const p = parsedFromAIJson({
      distanceM: 7500, durationSec: 2554, avgPaceSecKm: 341, avgHR: 132, maxHR: 146,
      splits: [{ km: 1, paceSecKm: 330, hr: 131 }],
    });
    expect(p.distanceM).toBe(7500);
    expect(p.confidence).toBe('high');
  });
  it('drops junk and flags missing', () => {
    const p = parsedFromAIJson({ distanceM: 'lots', splits: 'nope', avgHR: 999 });
    expect(p.distanceM).toBeNull();
    expect(p.avgHR).toBeNull(); // 999 out of HR range
    expect(p.splits).toEqual([]);
    expect(p.confidence).toBe('low');
  });
});

describe('screenshotActivityToRow', () => {
  it('builds a row with whole-km pace splits and no polyline', () => {
    const p = parseScreenshotText(STRAVA_OCR);
    const row = screenshotActivityToRow(p, '2026-05-26T22:19:00Z');
    expect(row.garmin_id).toBe('screenshot-20260526T221900');
    expect(row.distance_m).toBe(7500);
    expect(row.duration_sec).toBe(2554);
    expect(row.avg_hr).toBe(132);
    expect(row.polyline).toBeNull();
    expect(row.iTrimp).toBeNull(); // no hrSeries + no ctx → heal pass fills later
    expect(row.kmSplits).toEqual([330, 329, 329, 352, 370, 330, 350]); // 7 whole-km, 0.5 partial excluded
  });
});

describe('parsedHrSeriesFromAIJson', () => {
  it('coerces a clean per-minute series', () => {
    const out = parsedHrSeriesFromAIJson({
      hrSeries: [
        { tSec: 0, hr: 120 },
        { tSec: 60, hr: 132 },
        { tSec: 120, hr: 145 },
      ],
    });
    expect(out).toEqual([
      { tSec: 0, hr: 120 },
      { tSec: 60, hr: 132 },
      { tSec: 120, hr: 145 },
    ]);
  });

  it('drops out-of-range HR and negative times, sorts ascending', () => {
    const out = parsedHrSeriesFromAIJson({
      hrSeries: [
        { tSec: 120, hr: 145 },
        { tSec: -5, hr: 130 },     // negative time — dropped
        { tSec: 60, hr: 350 },     // HR out of range — dropped
        { tSec: 0, hr: 50 },       // HR out of range — dropped
        { tSec: 30, hr: 128 },
      ],
    });
    expect(out).toEqual([
      { tSec: 30, hr: 128 },
      { tSec: 120, hr: 145 },
    ]);
  });

  it('accepts a bare array (no hrSeries wrapper)', () => {
    const out = parsedHrSeriesFromAIJson([{ tSec: 0, hr: 110 }, { tSec: 60, hr: 122 }]);
    expect(out).toHaveLength(2);
  });

  it('returns an empty array on garbage input', () => {
    expect(parsedHrSeriesFromAIJson(null)).toEqual([]);
    expect(parsedHrSeriesFromAIJson({ hrSeries: 'nope' })).toEqual([]);
    expect(parsedHrSeriesFromAIJson({})).toEqual([]);
  });
});

describe('screenshotActivityToRow — hrSeries enrichment', () => {
  // 40 sample @ 60s = a 40-min run, mean ~150 bpm (steady aerobic).
  const fortyMinSeries = Array.from({ length: 40 }, (_, i) => ({ tSec: i * 60, hr: 150 }));

  const ctx: ScreenshotEnrichmentContext = {
    restingHR: 50,
    userMaxHR: 190,
    sex: 'male',
    zones: {
      method: 'maxhr',
      z1: { min: 100, max: 120 },
      z2: { min: 121, max: 140 },
      z3: { min: 141, max: 160 },
      z4: { min: 161, max: 175 },
      z5: { min: 176, max: 190 },
    },
  };

  const baseParsed: ParsedScreenshotActivity = {
    sport: 'RUNNING',
    distanceM: 8000,
    durationSec: 2400,
    avgPaceSecKm: 300,
    avgHR: null,    // deliberately null so we can confirm enrichment fills it
    maxHR: null,
    splits: [],
    confidence: 'medium',
    missing: [],
    hrSeries: fortyMinSeries,
  };

  it('runs computeHREnrichment when hrSeries + ctx are supplied', () => {
    const row = screenshotActivityToRow(baseParsed, '2026-05-28T07:00:00Z', ctx);
    // Steady 150 bpm → avg/max both 150
    expect(row.avg_hr).toBe(150);
    expect(row.max_hr).toBe(150);
    // Real iTRIMP (not null) — value depends on Banister formula but must be > 0
    expect(row.iTrimp).not.toBeNull();
    expect(row.iTrimp ?? 0).toBeGreaterThan(0);
    // Zone breakdown populated (150 bpm sits in z3 per the ctx zones)
    expect(row.hrZones).not.toBeNull();
    expect((row.hrZones?.z3 ?? 0)).toBeGreaterThan(0);
  });

  it('falls back to the heal-pass path when ctx is omitted', () => {
    const row = screenshotActivityToRow(baseParsed, '2026-05-28T07:00:00Z');
    expect(row.iTrimp).toBeNull();
    expect(row.hrZones).toBeNull();
  });

  it('falls back when hrSeries is too short to integrate', () => {
    const row = screenshotActivityToRow(
      { ...baseParsed, hrSeries: [{ tSec: 0, hr: 150 }] },
      '2026-05-28T07:00:00Z',
      ctx,
    );
    expect(row.iTrimp).toBeNull();
  });
});
