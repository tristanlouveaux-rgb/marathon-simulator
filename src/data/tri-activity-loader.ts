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
 *
 * Auth pattern: REST + JWT bearer token, same path the onboarding wizard's
 * `fetchRecentActivities` uses. The Supabase JS client's session is sometimes
 * out of sync with `getAccessToken()` (the canonical auth source for this
 * app), and using the JS client's `.eq('user_id', userId)` filter against
 * a session-derived id silently returned 0 rows when the user was actually
 * authenticated and had hundreds of activities. RLS handles the user-row
 * filter server-side via `auth.uid()`; we don't need to filter client-side.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, getAccessToken } from './supabaseClient';
import type { GarminActual } from '@/types/state';

/** Row shape returned by the REST query — snake_case, distance in metres. */
interface GarminActivityRow {
  garmin_id: string;
  activity_type: string | null;
  start_time: string | null;
  duration_sec: number | null;
  distance_m: number | null;
  avg_pace_sec_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  calories: number | null;
  itrimp: number | null;
  hr_zones: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
  km_splits: number[] | null;
  polyline: string | null;
  activity_name: string | null;
  elevation_gain_m: number | null;
  hr_drift: number | null;
  ambient_temp_c: number | null;
  average_watts: number | null;
  normalized_power: number | null;
  max_watts: number | null;
  device_watts: boolean | null;
  kilojoules: number | null;
  power_curve: GarminActual['powerCurve'];
}

/**
 * Fetch up to `limit` activities from `garmin_activities` for the current
 * authenticated user. Default 500 — enough for a 16-week + buffer history
 * without risking request-size limits.
 */
export async function loadActivitiesFromDB(limit = 500): Promise<GarminActual[]> {
  try {
    const token = await getAccessToken().catch(() => null);
    if (!token) {
      console.warn('[tri-activity-loader] No access token — falling back to empty activity list');
      return [];
    }

    const select = [
      'garmin_id', 'activity_type', 'start_time', 'duration_sec', 'distance_m',
      'avg_pace_sec_km', 'avg_hr', 'max_hr', 'calories', 'itrimp', 'hr_zones',
      'km_splits', 'polyline', 'activity_name', 'elevation_gain_m', 'hr_drift',
      'ambient_temp_c', 'average_watts', 'normalized_power', 'max_watts',
      'device_watts', 'kilojoules', 'power_curve',
    ].join(',');

    const url = `${SUPABASE_URL}/rest/v1/garmin_activities`
      + `?select=${select}`
      + `&order=start_time.desc`
      + `&limit=${limit}`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[tri-activity-loader] garmin_activities select failed: ${res.status} ${body}`);
      return [];
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return [];

    // Map DB rows (snake_case, distance in metres) to GarminActual shape
    // (camelCase, distance in km).
    const activities: GarminActual[] = (rows as GarminActivityRow[]).map((r): GarminActual => ({
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
      displayName: r.activity_name ?? undefined,
      elevationGainM: r.elevation_gain_m ?? null,
      hrDrift: r.hr_drift ?? null,
      ambientTempC: r.ambient_temp_c ?? null,
      averageWatts: r.average_watts ?? null,
      normalizedPowerW: r.normalized_power ?? null,
      maxWatts: r.max_watts ?? null,
      deviceWatts: r.device_watts ?? null,
      kilojoules: r.kilojoules ?? null,
      powerCurve: r.power_curve ?? null,
    }));

    return dedupeActivities(activities);
  } catch (err) {
    console.warn('[tri-activity-loader] Unexpected error', err);
    return [];
  }
}

/**
 * Defensive client-side dedup. The server-side `sync-activities` edge function
 * suppresses Garmin rows within ±10 min of a Strava row at sync time, but
 * historical activities synced before that suppression logic existed (or under
 * different windows) can land in the DB twice — same ride logged via Strava
 * AND via the Garmin webhook. Volume calcs and best-effort pickers downstream
 * end up double-counting.
 *
 * Two activities are treated as duplicates when they share a sport class and
 * start within ±10 minutes of each other. Of a duplicate set, the row we
 * keep is the most informative one — Strava-sourced first (richer fields:
 * HR zones, kmSplits, polyline, best_efforts), then the longer activity
 * (more complete recording wins ties), then the earlier startTime.
 *
 * Logged when any duplicates fire so the source of any "double-count" report
 * is visible in the same console session.
 */
function dedupeActivities(activities: GarminActual[]): GarminActual[] {
  const TEN_MIN_MS = 10 * 60 * 1000;

  // Group by sport class. Different sports at the same time aren't duplicates
  // (a brick run starting right after a ride is two distinct activities).
  const sportClass = (t: string | null | undefined): 'run' | 'bike' | 'swim' | 'other' => {
    const u = (t ?? '').toUpperCase();
    if (u === 'RUNNING' || u.includes('RUN')) return 'run';
    if (u === 'CYCLING' || u.includes('BIKE') || u.includes('RIDE')) return 'bike';
    if (u === 'SWIMMING' || u.includes('SWIM')) return 'swim';
    return 'other';
  };

  // Score: higher = keep. Power data dominates — for triathletes, FTP
  // estimation depends on it and the ratio of rows with real power data is
  // tiny (a handful of `power_curve`-bearing rides across 3 years for the
  // typical user). A row with power outranks anything else; we'd rather
  // keep a Garmin-sourced row with a power_curve than a Strava-sourced
  // row without one. Field-merge below still backfills HR zones / splits
  // / polyline from the loser, so we don't lose the Strava-side richness.
  const score = (a: GarminActual): number => {
    let s = 0;
    // Power data — heavily boosted so it always wins. The FTP estimator
    // can't do anything without these fields and they're rare in practice.
    if (a.powerCurve != null && Object.keys(a.powerCurve as object).length > 0) s += 5000;
    if (a.deviceWatts === true) s += 2000;
    if (a.averageWatts != null && a.averageWatts > 0) s += 500;
    // Strava-source preference is a tiebreaker among rows with similar
    // power profiles, not the dominant axis.
    if (a.garminId?.startsWith('strava-')) s += 1000;
    if (a.hrZones != null) s += 100;
    if (a.kmSplits && a.kmSplits.length > 0) s += 50;
    if (a.polyline) s += 25;
    s += (a.distanceKm ?? 0);
    return s;
  };

  // Merge: keep the higher-scoring row's identity, but backfill any
  // missing fields from the lower-scoring row. Critical for power data —
  // Strava (+1000) almost always wins on score, but if Strava failed to
  // process the watts stream and Garmin has it, we'd lose power without
  // this. Same for HR zones, splits, drift etc. — whichever source
  // captured a field wins for that field, regardless of which row "owns"
  // the merged result.
  //
  // A field is "missing" when it's null, 0, empty string, empty array,
  // or empty object. Empty containers matter because the edge function
  // sometimes computes `power_curve = {}` when the watts stream has no
  // usable values — that's structurally non-null but functionally empty,
  // and the FTP estimator can't do anything with it. Treating it as
  // missing lets us pull a populated power_curve from the dedup partner.
  const isMissing = (v: unknown): boolean => {
    if (v == null) return true;
    if (v === 0 || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v as object).length === 0;
    return false;
  };
  const mergeKeepingFields = (winner: GarminActual, loser: GarminActual): GarminActual => {
    const merged = { ...winner } as Record<string, unknown>;
    const loserRec = loser as unknown as Record<string, unknown>;
    for (const key of Object.keys(loserRec)) {
      if (isMissing(merged[key]) && !isMissing(loserRec[key])) {
        merged[key] = loserRec[key];
      }
    }
    return merged as unknown as GarminActual;
  };

  // O(n) scan with a short look-back; activities are already sorted desc by
  // start_time from the SQL `order=start_time.desc`. For each activity, walk
  // back through recently-kept ones with the same sport class — if any sits
  // within the ±10 min window, this is a duplicate of the one we'd keep.
  const kept: GarminActual[] = [];
  let dupCount = 0;
  for (const a of activities) {
    if (!a.startTime) { kept.push(a); continue; }
    const aMs = new Date(a.startTime).getTime();
    if (!isFinite(aMs)) { kept.push(a); continue; }
    const cls = sportClass(a.activityType);
    if (cls === 'other') { kept.push(a); continue; }

    // Walk back at most ~30 entries — duplicates always cluster within minutes
    // so we'll find the partner quickly. Bounded look-back keeps this O(n).
    let dupOf = -1;
    for (let i = kept.length - 1; i >= Math.max(0, kept.length - 30); i--) {
      const k = kept[i];
      if (!k.startTime) continue;
      if (sportClass(k.activityType) !== cls) continue;
      const kMs = new Date(k.startTime).getTime();
      if (Math.abs(kMs - aMs) <= TEN_MIN_MS) { dupOf = i; break; }
    }

    if (dupOf === -1) {
      kept.push(a);
    } else {
      dupCount++;
      const existing = kept[dupOf];
      const aIsBetter = score(a) > score(existing);
      const winner = aIsBetter ? a : existing;
      const loser = aIsBetter ? existing : a;
      // Merge so power / HR / splits fields from the loser survive onto
      // the winner. Triples with three sources collapse correctly because
      // each successive duplicate merges into the running winner.
      kept[dupOf] = mergeKeepingFields(winner, loser);
    }
  }

  if (dupCount > 0) {
    console.log(`[tri-activity-loader] Deduped ${dupCount} same-sport activities within ±10min (merged fields from each duplicate, kept the higher-quality copy)`);
  }

  // Bike-power inventory log so missing FTP can be diagnosed in one glance.
  // Either the dedup stripped power (fields blank on every row, but the
  // estimator already saw 295 W on a previous pass), or the user genuinely
  // doesn't have power-meter data on file.
  const bikes = kept.filter(a => sportClass(a.activityType) === 'bike');
  if (bikes.length > 0) {
    const withCurve = bikes.filter(b => b.powerCurve != null && Object.keys(b.powerCurve as object).length > 0).length;
    const withAvgW = bikes.filter(b => b.averageWatts != null && b.averageWatts > 0).length;
    const withDevice = bikes.filter(b => b.deviceWatts === true).length;
    console.log(`[tri-activity-loader] kept ${bikes.length} bike rides post-dedup — power_curve:${withCurve} averageWatts:${withAvgW} device_watts(true):${withDevice}`);
  }

  return kept;
}
