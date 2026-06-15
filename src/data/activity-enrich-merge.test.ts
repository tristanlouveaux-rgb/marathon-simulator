import { describe, it, expect } from 'vitest';
import { enrichActualFromParsedRow, fileMatchesActual, isThinActivity } from './activity-enrich-merge';
import type { GarminActual } from '@/types';
import type { GarminActivityRow } from '@/calculations/activity-matcher';

// A thin Apple-Health-sourced run: average HR + duration only. This is what a
// Garmin watch delivers through the Garmin→HealthKit boundary.
function thinActual(over: Partial<GarminActual> = {}): GarminActual {
  return {
    garminId: 'apple-2026-06-01T07:00:00Z',
    startTime: '2026-06-01T07:00:00Z',
    distanceKm: 10,
    durationSec: 3000, // 50 min
    avgPaceSecKm: 300,
    avgHR: 150,
    maxHR: null,
    calories: 500,
    iTrimp: null,
    hrZones: null,
    kmSplits: null,
    polyline: null,
    ...over,
  };
}

// A rich parsed file (Strava "Export Original" .fit) for the same session.
function richRow(over: Partial<GarminActivityRow> = {}): GarminActivityRow {
  return {
    garmin_id: 'import-20260601T0700',
    activity_type: 'RUNNING',
    start_time: '2026-06-01T07:00:30Z', // 30s off — same session
    duration_sec: 3010,
    distance_m: 10000,
    avg_pace_sec_km: 301,
    avg_hr: 151,
    max_hr: 178,
    calories: 505,
    aerobic_effect: null,
    anaerobic_effect: null,
    iTrimp: 9000,
    hrZones: { z1: 200, z2: 1800, z3: 800, z4: 180, z5: 30 },
    kmSplits: [300, 298, 302, 305, 299, 301, 300, 297, 303, 305],
    polyline: 'abc_encoded_polyline',
    elevationGainM: 88,
    ...over,
  };
}

describe('isThinActivity', () => {
  it('treats an Apple-Health avg-HR-only row as thin', () => {
    expect(isThinActivity(thinActual())).toBe(true);
  });

  it('is not thin once HR zones are present', () => {
    expect(isThinActivity(thinActual({ hrZones: { z1: 1, z2: 2, z3: 3, z4: 4, z5: 5 } }))).toBe(false);
  });

  it('is not thin once a route polyline is present', () => {
    expect(isThinActivity(thinActual({ polyline: 'abc' }))).toBe(false);
  });

  it('is not thin once per-km splits are present', () => {
    expect(isThinActivity(thinActual({ kmSplits: [300, 301] }))).toBe(false);
  });

  it('is not thin for a Strava-sourced row (already rich)', () => {
    expect(isThinActivity(thinActual({ garminId: 'strava-12345' }))).toBe(false);
  });

  it('is not thin once already enriched from a file', () => {
    expect(isThinActivity(thinActual({ enrichedFromFile: true }))).toBe(false);
  });
});

describe('fileMatchesActual', () => {
  it('accepts a file within ±10 min and ±15% duration', () => {
    expect(fileMatchesActual(thinActual(), richRow()).ok).toBe(true);
  });

  it('rejects a file more than 4h away', () => {
    const r = fileMatchesActual(thinActual(), richRow({ start_time: '2026-06-01T13:00:00Z' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('time-mismatch');
  });

  it('rejects a file whose duration differs by more than 15%', () => {
    const r = fileMatchesActual(thinActual(), richRow({ duration_sec: 6000 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('duration-mismatch');
  });

  it('rejects a same-duration file an hour apart (start time must agree, not just duration)', () => {
    // Hardening: the old logic accepted on duration alone within a 4h window,
    // which let a timezone-shifted or coincidentally-same-length session match.
    const r = fileMatchesActual(thinActual(), richRow({ start_time: '2026-06-01T08:05:00Z' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('time-mismatch');
  });

  it('rejects an unparseable timestamp rather than NaN-matching', () => {
    const r = fileMatchesActual(thinActual(), richRow({ start_time: 'not-a-date' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('time-mismatch');
  });
});

describe('enrichActualFromParsedRow', () => {
  it('fills the rich fields a thin activity is missing', () => {
    const actual = thinActual();
    const res = enrichActualFromParsedRow(actual, richRow());
    expect(res.accepted).toBe(true);
    expect(res.patch?.iTrimp).toBe(9000);
    expect(res.patch?.hrZones).toEqual({ z1: 200, z2: 1800, z3: 800, z4: 180, z5: 30 });
    expect(res.patch?.kmSplits).toHaveLength(10);
    expect(res.patch?.polyline).toBe('abc_encoded_polyline');
    expect(res.patch?.maxHR).toBe(178); // base field also backfilled (was null)
    expect(res.patch?.enrichedFromFile).toBe(true);
    expect(res.added).toEqual(expect.arrayContaining(['HR load', 'HR zones', 'km splits', 'route']));
  });

  it('does NOT mutate the original actual (pure)', () => {
    const actual = thinActual();
    enrichActualFromParsedRow(actual, richRow());
    expect(actual.iTrimp).toBeNull();
    expect(actual.hrZones).toBeNull();
  });

  it('preserves provenance: garminId is never in the patch', () => {
    const res = enrichActualFromParsedRow(thinActual(), richRow());
    expect(res.patch && 'garminId' in res.patch).toBe(false);
  });

  it('does not overwrite rich fields the actual already has', () => {
    const actual = thinActual({
      iTrimp: 8000,
      hrZones: { z1: 1, z2: 2, z3: 3, z4: 4, z5: 5 },
    });
    const res = enrichActualFromParsedRow(actual, richRow());
    expect(res.accepted).toBe(true); // splits + polyline are still new
    expect(res.patch?.iTrimp).toBeUndefined();
    expect(res.patch?.hrZones).toBeUndefined();
    expect(res.patch?.polyline).toBe('abc_encoded_polyline');
  });

  it('rejects a mismatched file unless forced', () => {
    const farRow = richRow({ start_time: '2026-06-01T15:00:00Z' });
    const res = enrichActualFromParsedRow(thinActual(), farRow);
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('time-mismatch');

    const forced = enrichActualFromParsedRow(thinActual(), farRow, { force: true });
    expect(forced.accepted).toBe(true);
    expect(forced.patch?.iTrimp).toBe(9000);
  });

  it('rejects when the file carries nothing the actual lacks', () => {
    const fullActual = thinActual({
      iTrimp: 8000,
      maxHR: 175,
      hrZones: { z1: 1, z2: 2, z3: 3, z4: 4, z5: 5 },
      kmSplits: [1, 2, 3],
      polyline: 'existing',
      elevationGainM: 50,
    });
    const res = enrichActualFromParsedRow(fullActual, richRow());
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe('no-new-data');
  });

  it('merges cycling power as a block when the actual has none', () => {
    const ride = thinActual({ activityType: 'CYCLING' });
    const powerRow = richRow({
      activity_type: 'CYCLING',
      averageWatts: 210,
      maxWatts: 480,
      normalizedPowerW: 225,
      powerCurve: { p600: 300, p1200: 280, p1800: 260, p3600: 240 },
      deviceWatts: true,
    });
    const res = enrichActualFromParsedRow(ride, powerRow);
    expect(res.accepted).toBe(true);
    expect(res.patch?.averageWatts).toBe(210);
    expect(res.patch?.normalizedPowerW).toBe(225);
    expect(res.patch?.powerCurve?.p600).toBe(300);
    expect(res.added).toContain('power');
  });
});
