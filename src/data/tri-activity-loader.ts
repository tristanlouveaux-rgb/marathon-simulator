/**
 * Load activity history for triathlon benchmark derivation.
 *
 * The canonical store for all synced activities is the Supabase
 * `garmin_activities` table. Running-mode state mirrors some of these into
 * `s.wks[*].garminActuals` / `garminPending`, but when a user onboards to
 * triathlon the week array gets replaced and those in-memory copies go
 * away. The derivation engine needs the full picture regardless, so we
 * query the DB directly for tri users.
 *
 * Returns a GarminActual-shaped list that the tri-benchmarks module can
 * feed directly into `deriveTriBenchmarksFromHistory`.
 */

import { supabase } from './supabaseClient';
import type { GarminActual } from '@/types/state';

/**
 * Fetch up to `limit` activities from `garmin_activities` for the current
 * authenticated user. Default 500 — enough for a 16-week + buffer history
 * without risking request-size limits.
 */
export async function loadActivitiesFromDB(limit = 500): Promise<GarminActual[]> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) {
      console.warn('[tri-activity-loader] No authenticated user — falling back to empty activity list');
      return [];
    }

    const { data, error } = await supabase
      .from('garmin_activities')
      .select(
        'garmin_id, activity_type, start_time, duration_sec, distance_m, avg_pace_sec_km, avg_hr, max_hr, calories, itrimp, hr_zones, km_splits, polyline, activity_name, elevation_gain_m, hr_drift, ambient_temp_c, average_watts, normalized_power, max_watts, device_watts, kilojoules',
      )
      .eq('user_id', userId)
      .order('start_time', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[tri-activity-loader] Query failed', error.message);
      return [];
    }
    if (!data || data.length === 0) return [];

    // Map DB rows (snake_case, distance in metres) to GarminActual shape
    // (camelCase, distance in km). Only the fields the derivation reads.
    return data.map((r: any): GarminActual => ({
      garminId: r.garmin_id,
      activityType: r.activity_type,
      startTime: r.start_time,
      durationSec: r.duration_sec ?? 0,
      distanceKm: r.distance_m != null ? r.distance_m / 1000 : 0,
      avgPaceSecKm: r.avg_pace_sec_km ?? null,
      avgHR: r.avg_hr ?? null,
      maxHR: r.max_hr ?? null,
      calories: r.calories ?? null,
      iTrimp: r.itrimp ?? null,
      hrZones: r.hr_zones ?? null,
      kmSplits: r.km_splits ?? null,
      polyline: r.polyline ?? null,
      elevationGainM: r.elevation_gain_m ?? null,
      hrDrift: r.hr_drift ?? null,
      ambientTempC: r.ambient_temp_c ?? null,
      averageWatts: r.average_watts ?? null,
      normalizedPowerW: r.normalized_power ?? null,
      maxWatts: r.max_watts ?? null,
      deviceWatts: r.device_watts ?? null,
      kilojoules: r.kilojoules ?? null,
    }));
  } catch (err) {
    console.warn('[tri-activity-loader] Unexpected error', err);
    return [];
  }
}
