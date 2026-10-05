/**
 * Triathlon read path: garmin_activities rows for one session from both Apple
 * Health and Strava count once (ITEM S1, 2026-10-05).
 *
 * The tri pipeline sums every row loadActivitiesFromDB returns. Its class pass
 * already merged same-class swim / bike / run rows within 10 minutes, but class
 * 'other' (strength, HIIT vs Apple CARDIO) was never collapsed, so an Apple
 * upload that landed before the Strava row doubled crossTrainingAtl.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./supabaseClient', () => ({
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  getAccessToken: vi.fn(async () => 'token'),
  getUserId: vi.fn(async () => 'user-1'),
}));

import { loadActivitiesFromDB } from './tri-activity-loader';

function dbRow(garmin_id: string, start_time: string, duration_sec: number, activity_type: string, extra: Record<string, unknown> = {}) {
  return {
    garmin_id, start_time, duration_sec, activity_type,
    distance_m: null, avg_pace_sec_km: null, avg_hr: null, max_hr: null, calories: null, itrimp: null,
    hr_zones: null, km_splits: null, km_hr_splits: null, polyline: null, activity_name: null,
    elevation_gain_m: null, hr_drift: null, ambient_temp_c: null, average_watts: null,
    normalized_power: null, max_watts: null, device_watts: null, kilojoules: null, power_curve: null,
    ...extra,
  };
}

const apple = (iso: string) => `apple-com.apple.health.watch-${iso}`;

let rows: unknown[] = [];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => rows, text: async () => '' })));
});

afterEach(() => vi.unstubAllGlobals());

describe('loadActivitiesFromDB with Apple and Strava rows for the same sessions', () => {
  it('collapses strength and HIIT/CARDIO twins onto the Strava row and keeps Apple-only sessions', async () => {
    // Sorted desc by start_time, as the REST query orders them.
    rows = [
      dbRow('strava-3', '2026-10-01T17:30:00.000Z', 2700, 'STRENGTH_TRAINING'),
      dbRow(apple('2026-10-01T17:30:00.400Z'), '2026-10-01T17:30:00.400Z', 2400, 'STRENGTH_TRAINING', { hr_zones: { z1: 1, z2: 2, z3: 3, z4: 4, z5: 5 } }),
      dbRow(apple('2026-09-30T07:00:00.400Z'), '2026-09-30T07:00:00.400Z', 2600, 'CARDIO'),
      dbRow('strava-2', '2026-09-30T07:00:00.000Z', 2700, 'HIIT'),
      dbRow('strava-1', '2026-09-29T14:05:00.000Z', 3600, 'CYCLING'),
      dbRow(apple('2026-09-29T06:00:00.000Z'), '2026-09-29T06:00:00.000Z', 2400, 'SWIMMING'),
    ];

    const out = await loadActivitiesFromDB();

    expect(out.map(a => a.garminId)).toEqual(['strava-3', 'strava-2', 'strava-1', apple('2026-09-29T06:00:00.000Z')]);
    // Strava row keeps its identity; a field it lacked is backfilled from the Apple row.
    expect(out[0].hrZones).toEqual({ z1: 1, z2: 2, z3: 3, z4: 4, z5: 5 });
  });

  it('keeps an Apple strength session that starts hours after a Strava ride', async () => {
    rows = [
      dbRow(apple('2026-09-29T17:30:00.000Z'), '2026-09-29T17:30:00.000Z', 3500, 'STRENGTH_TRAINING'),
      dbRow('strava-1', '2026-09-29T14:05:00.000Z', 3600, 'CYCLING'),
    ];
    const out = await loadActivitiesFromDB();
    expect(out).toHaveLength(2);
  });
});
