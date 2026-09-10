/**
 * Apple Health → Supabase activity upload.
 *
 * Why this exists: Apple Health workouts are read from the on-device HealthKit
 * store and matched into local `s.wks[].garminActuals`. That is enough for
 * RUNNING mode (the running CTL/baseline math reads the local
 * `historicWeeklyTSS` aggregate the Apple backfill writes). But the TRIATHLON
 * fitness pipeline derives per-discipline CTL, `fitnessHistory`, detected
 * volumes, CSS/FTP, and PBs EXCLUSIVELY from the Supabase `garmin_activities`
 * table (`loadActivitiesFromDB` → `deriveTriBenchmarksFromHistory`). Strava and
 * Garmin both land in that table (Strava via its edge function, Garmin via the
 * webhook), so their history flows into the tri pipeline automatically. Apple
 * Health was the only source that never wrote there, so an Apple-Watch-only
 * triathlete saw swim/bike/run = 0 sessions, a flat per-discipline CTL chart,
 * and 0 across "Recent weeks" even though the on-device sync ran fine.
 *
 * Fix: when the Apple sync converts workouts to `GarminActivityRow[]`, upsert
 * them into `garmin_activities` so Apple becomes a first-class DB source the tri
 * pipeline reads — identical to how Strava's rows reach it.
 *
 * Bulletproofing:
 *  - IDEMPOTENT. Apple rows carry a deterministic `apple-<sourceId>-<start>`
 *    `garmin_id` (the table's unique key), upserted with `onConflict:garmin_id`.
 *    Re-running any sync re-writes the same row; later enrichment (HR, power,
 *    route) upgrades it in place.
 *  - CANONICAL-SOURCE SAFE. An `apple-` id can never collide with a `strava-`/
 *    Garmin id, so this can never overwrite a canonical row. But two rows for the
 *    SAME physical activity (a Strava copy AND an Apple copy) would double-count
 *    in the tri pipeline, which sums every DB row. So we skip uploading any Apple
 *    row whose start is within ±10 min of an existing non-Apple row — Strava
 *    always wins (matches `sync-activities`' suppression window and the
 *    "Strava is the Canonical Activity Source" rule in CLAUDE.md).
 *  - USER-SCOPED. Every row stamps `user_id = auth.uid()`; the
 *    `garmin_activities_own` RLS policy enforces it. Works for anonymous
 *    sessions too (they hold the `authenticated` role).
 *  - NON-FATAL. No auth / table missing / network error → warn and no-op. The
 *    sync that called us continues.
 */

import { supabase } from './supabaseClient';
import type { GarminActivityRow } from '@/calculations/activity-matcher';

/** Same ±10 min window `sync-activities` uses to suppress a Garmin row that
 *  duplicates a Strava row. A physical activity recorded by two sources lands
 *  at near-identical start times; this collapses them to one DB row. */
const NEAR_DUP_WINDOW_MS = 10 * 60 * 1000;

/** Chunk size for the upsert. Polylines + power curves make rows fat, so keep
 *  each request bounded rather than POSTing a whole 52-week backfill at once. */
const UPLOAD_CHUNK = 50;

/** Map a (camelCase, km-less) GarminActivityRow to the snake_case
 *  `garmin_activities` column shape. Array splits are stored as int4[] (same as
 *  Strava), jsonb fields pass through. */
function toDbRow(row: GarminActivityRow, userId: string): Record<string, unknown> {
  return {
    garmin_id: row.garmin_id,
    user_id: userId,
    source: 'apple',
    activity_type: row.activity_type,
    start_time: row.start_time,
    duration_sec: row.duration_sec,
    distance_m: row.distance_m ?? null,
    avg_pace_sec_km: row.avg_pace_sec_km ?? null,
    avg_hr: row.avg_hr ?? null,
    max_hr: row.max_hr ?? null,
    calories: row.calories ?? null,
    aerobic_effect: row.aerobic_effect ?? null,
    anaerobic_effect: row.anaerobic_effect ?? null,
    garmin_rpe: row.garmin_rpe ?? null,
    garmin_feeling: row.garmin_feeling ?? null,
    itrimp: row.iTrimp ?? null,
    hr_zones: row.hrZones ?? null,
    hr_drift: row.hrDrift ?? null,
    ambient_temp_c: row.ambientTempC ?? null,
    polyline: row.polyline ?? null,
    km_splits: row.kmSplits ? row.kmSplits.map(v => Math.round(v)) : null,
    km_hr_splits: row.kmHRSplits ? row.kmHRSplits.map(v => Math.round(v)) : null,
    elevation_gain_m: row.elevationGainM ?? null,
    average_watts: row.averageWatts ?? null,
    normalized_power: row.normalizedPowerW ?? null,
    max_watts: row.maxWatts ?? null,
    device_watts: row.deviceWatts ?? null,
    kilojoules: row.kilojoules ?? null,
    power_curve: row.powerCurve ?? null,
    rep_data: row.repData ?? null,
    best_efforts: (row as { best_efforts?: unknown }).best_efforts ?? null,
    activity_name: row.activity_name ?? null,
  };
}

/**
 * Pure dedup: drop any Apple row whose start time is within ±10 min of a
 * canonical (non-Apple) row. `existingNonAppleStartsMs` must be sorted ascending
 * for the binary search. Exported for unit testing.
 */
export function filterCanonicalDuplicates(
  rows: GarminActivityRow[],
  existingNonAppleStartsMs: number[],
): GarminActivityRow[] {
  if (existingNonAppleStartsMs.length === 0) return rows;
  return rows.filter(row => {
    const t = Date.parse(row.start_time);
    if (Number.isNaN(t)) return false; // unparseable start → can't dedup safely, drop
    // Binary search for the insertion point, then check the neighbours.
    let lo = 0, hi = existingNonAppleStartsMs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (existingNonAppleStartsMs[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const before = lo > 0 ? existingNonAppleStartsMs[lo - 1] : null;
    const after = lo < existingNonAppleStartsMs.length ? existingNonAppleStartsMs[lo] : null;
    const nearBefore = before != null && t - before <= NEAR_DUP_WINDOW_MS;
    const nearAfter = after != null && after - t <= NEAR_DUP_WINDOW_MS;
    return !nearBefore && !nearAfter; // keep only when NO canonical row is adjacent
  });
}

/**
 * Upsert Apple-sourced activity rows into `garmin_activities` so the triathlon
 * fitness pipeline (DB-only) sees Apple Watch history. Returns the number of
 * rows written. Never throws.
 */
export async function uploadAppleActivitiesToDB(rows: GarminActivityRow[]): Promise<number> {
  try {
    if (rows.length === 0) return 0;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 0; // not signed in — the tri pipeline can't read the DB anyway

    // Only consider existing rows that could plausibly collide: scope the lookup
    // to the time span we're about to write (minus the dup window). For a 52w
    // backfill this is wide; for a 14d incremental it's tiny.
    const starts = rows.map(r => Date.parse(r.start_time)).filter(t => !Number.isNaN(t));
    if (starts.length === 0) return 0;
    const minStartISO = new Date(Math.min(...starts) - NEAR_DUP_WINDOW_MS).toISOString();
    const maxStartISO = new Date(Math.max(...starts) + NEAR_DUP_WINDOW_MS).toISOString();

    const { data: existing, error: selErr } = await supabase
      .from('garmin_activities')
      .select('garmin_id, start_time')
      .eq('user_id', user.id)
      .gte('start_time', minStartISO)
      .lte('start_time', maxStartISO);
    if (selErr) {
      // Table missing / RLS / network. Don't block — but also don't upload
      // blind, because without the dedup read we can't guarantee no double-count.
      console.warn('[AppleActivityUpload] existing-row lookup failed, skipping upload:', selErr.message);
      return 0;
    }

    const existingNonAppleStartsMs = (existing ?? [])
      .filter(r => !String(r.garmin_id).startsWith('apple-'))
      .map(r => Date.parse(r.start_time as string))
      .filter(t => !Number.isNaN(t))
      .sort((a, b) => a - b);

    const deduped = filterCanonicalDuplicates(rows, existingNonAppleStartsMs);
    if (deduped.length === 0) return 0;

    const dbRows = deduped.map(r => toDbRow(r, user.id));

    let written = 0;
    for (let i = 0; i < dbRows.length; i += UPLOAD_CHUNK) {
      const chunk = dbRows.slice(i, i + UPLOAD_CHUNK);
      const { error } = await supabase
        .from('garmin_activities')
        .upsert(chunk, { onConflict: 'garmin_id' });
      if (error) {
        console.warn(`[AppleActivityUpload] upsert chunk failed (${i}-${i + chunk.length}):`, error.message);
        continue; // best-effort: a bad chunk doesn't sink the rest
      }
      written += chunk.length;
    }

    if (written > 0) {
      console.log(`[AppleActivityUpload] upserted ${written} Apple activity row(s) into garmin_activities (${rows.length - deduped.length} suppressed as canonical-dupes)`);
    }
    return written;
  } catch (e) {
    console.warn('[AppleActivityUpload] upload failed (non-fatal):', e);
    return 0;
  }
}
