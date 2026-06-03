import { describe, it, expect } from 'vitest';
import { reconcileCrossSourceDuplicates } from './activity-matcher';

// Reproduces the real dogfooding state (2026-06-03): the dev account receives
// each session from BOTH the Garmin webhook (raw numeric id) AND Strava
// (`strava-…`). The two copies carry different garminIds and identical-but-
// differently-formatted timestamps (`…Z` vs `…+00:00`), so the same-id dedup in
// Recent never collapses them and every session shows / counts twice.

function mkActual(over: Record<string, unknown>): any {
  return {
    garminId: 'x', startTime: '2026-06-01T19:09:22Z', distanceKm: 0,
    durationSec: 3540, avgPaceSecKm: null, avgHR: null, activityType: 'HIIT',
    ...over,
  };
}

function mkState(week: Record<string, unknown>): any {
  return { wks: [{ ph: 'build', garminActuals: {}, adhocWorkouts: [], garminPending: [], garminMatched: {}, ...week }] };
}

describe('reconcileCrossSourceDuplicates', () => {
  it('drops the Garmin-webhook copy when a Strava copy of the same session exists', () => {
    const s = mkState({
      garminActuals: {
        'garmin-strava-18746882968': mkActual({ garminId: 'strava-18746882968', startTime: '2026-06-01T19:09:22Z', durationSec: 3541 }),
        // Same instant, different format + raw Garmin id, ~identical duration.
        'garmin-23095778875': mkActual({ garminId: '23095778875', startTime: '2026-06-01T19:09:22+00:00', durationSec: 3540 }),
      },
      adhocWorkouts: [
        { id: 'garmin-strava-18746882968', n: 'HIIT', t: 'gym' },
        { id: 'garmin-23095778875', n: 'HIIT', t: 'gym' },
      ],
      garminPending: [
        { garminId: 'strava-18746882968', activityType: 'HIIT', startTime: '2026-06-01T19:09:22Z', durationSec: 3541 },
        { garminId: '23095778875', activityType: 'HIIT', startTime: '2026-06-01T19:09:22+00:00', durationSec: 3540 },
      ],
      garminMatched: { 'strava-18746882968': 'garmin-strava-18746882968', '23095778875': 'garmin-23095778875' },
    });

    const changed = reconcileCrossSourceDuplicates(s);
    const wk = s.wks[0];

    expect(changed).toBe(true);
    // Strava copy survives; Garmin copy removed across all three buckets.
    expect(Object.keys(wk.garminActuals)).toEqual(['garmin-strava-18746882968']);
    expect(wk.adhocWorkouts.map((w: any) => w.id)).toEqual(['garmin-strava-18746882968']);
    expect(wk.garminPending.map((p: any) => p.garminId)).toEqual(['strava-18746882968']);
    expect(wk.garminMatched['23095778875']).toBeUndefined();
  });

  it('keeps a Garmin actual with no Strava counterpart', () => {
    const s = mkState({
      garminActuals: { 'garmin-99': mkActual({ garminId: '99', activityType: 'RUNNING' }) },
    });
    expect(reconcileCrossSourceDuplicates(s)).toBe(false);
    expect(Object.keys(s.wks[0].garminActuals)).toEqual(['garmin-99']);
  });

  it('prefers Apple Health over a Garmin summary but never over Strava', () => {
    const s = mkState({
      garminActuals: {
        'garmin-apple-1': mkActual({ garminId: 'apple-1', durationSec: 3600 }),
        'garmin-77': mkActual({ garminId: '77', startTime: '2026-06-01T19:09:30Z', durationSec: 3600 }),
      },
    });
    expect(reconcileCrossSourceDuplicates(s)).toBe(true);
    expect(Object.keys(s.wks[0].garminActuals)).toEqual(['garmin-apple-1']);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const s = mkState({
      garminActuals: {
        'garmin-strava-1': mkActual({ garminId: 'strava-1' }),
        'garmin-2': mkActual({ garminId: '2', startTime: '2026-06-01T19:09:22+00:00' }),
      },
    });
    expect(reconcileCrossSourceDuplicates(s)).toBe(true);
    expect(reconcileCrossSourceDuplicates(s)).toBe(false);
    expect(Object.keys(s.wks[0].garminActuals)).toEqual(['garmin-strava-1']);
  });
});
