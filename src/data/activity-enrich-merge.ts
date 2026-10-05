/**
 * In-place activity enrichment.
 *
 * A Garmin watch syncing into Apple Health only delivers average HR + duration:
 * HR zones, per-km splits, route polyline and iTRIMP are dropped at the
 * Garmin→HealthKit boundary. This module lets the user upload that activity's
 * original file (e.g. Strava "Export Original" .fit) from the activity detail
 * page and merge the rich fields into the EXISTING record, rather than creating
 * a duplicate.
 *
 * The merge mirrors the Strava-over-Garmin upgrade in `activity-matcher.ts`
 * (±10 min start, ±15% duration) but fills only the fields the actual is
 * missing and PRESERVES `garminId` — so the activity keeps its `apple-`/Garmin
 * provenance and a later live Strava row for the same session still wins via the
 * existing upgrade path.
 *
 * Load is intentionally NOT recomputed here: the canonical week load
 * (`computeWeekRawTSS`) and the detail TSS read `iTrimp` live, so filling
 * `iTrimp` self-corrects every surface. The stored `wk.actualTSS` running total
 * is left untouched on purpose (recomputing a precise delta would have to mirror
 * `computeWeekRawTSS` and risk a "two numbers, one source" divergence).
 */

import type { GarminActual } from '@/types';
import type { GarminActivityRow } from '@/calculations/activity-matcher';
import { isInAppActual } from '@/calculations/in-app-activity';

// The user is enriching a SPECIFIC activity they're looking at, so the file's
// start time should align with the activity's start to within a minute (same
// device clock, both UTC). We require BOTH a tight start-time match AND (when
// available) a duration match — stricter than the matcher's cross-source ±4h
// window, which exists to reconcile the same session arriving from different
// providers. Requiring start-time agreement also makes a timezone-less GPX
// timestamp (parsed as local time, hours off a UTC-stored actual) REJECT and
// fall through to the "enrich anyway?" confirm, rather than silently matching
// a different same-duration session.
const MATCH_TIME_MS = 10 * 60 * 1000; // ±10 min start
const MATCH_DUR_RATIO = 0.15; // ±15% duration

/**
 * A "thin" activity is one that synced through Apple Health with only average
 * HR + duration: no HR zones, no route polyline, no per-km splits. These are
 * the rows that benefit from a Strava file enrich (per-activity) or a bulk
 * Strava archive import (history). Strava-sourced rows are already rich, and a
 * row already enriched from a file is done.
 *
 * Canonical definition used by BOTH the per-activity "Add detail from Strava"
 * affordance (activity-detail.ts) and the Home enrich-prompt banner
 * (home-view.ts) so the two surfaces never disagree about what counts as thin.
 *
 * An in-app record (GPS run, Mark as Done, guided or quick-done session: a
 * `guided-` id) never synced through anything, so it is not thin. Counting it
 * made the Home banner say Mark as Done runs "came through Apple Health", and
 * let ingestActivityFile attach a dropped file to it on start time and
 * duration alone, whatever the file's sport. A file of that session goes
 * through importActivityFile instead, where the matcher supersedes the in-app
 * record by sport (audit B9).
 */
export function isThinActivity(actual: GarminActual): boolean {
  return (
    !actual.garminId?.startsWith('strava-')
    && !isInAppActual(actual)
    && !actual.enrichedFromFile
    && !actual.hrZones
    && !actual.polyline
    && (!actual.kmSplits || actual.kmSplits.length === 0)
  );
}

export type EnrichRejectReason = 'time-mismatch' | 'duration-mismatch' | 'no-new-data';

export interface EnrichResult {
  accepted: boolean;
  reason?: EnrichRejectReason;
  /** Partial GarminActual to Object.assign onto the existing actual when accepted. */
  patch?: Partial<GarminActual>;
  /** Plain-language list of what the file added, for the confirmation toast/caption. */
  added?: string[];
}

/**
 * Does the parsed file plausibly describe the same session as `actual`?
 * Returns `ok:false` with a reason the UI can surface before forcing a merge.
 */
export function fileMatchesActual(
  actual: GarminActual,
  row: GarminActivityRow,
): { ok: boolean; reason?: EnrichRejectReason } {
  if (!actual.startTime || !row.start_time) return { ok: false, reason: 'time-mismatch' };
  const aMs = new Date(actual.startTime).getTime();
  const rMs = new Date(row.start_time).getTime();
  if (Number.isNaN(aMs) || Number.isNaN(rMs)) return { ok: false, reason: 'time-mismatch' };
  if (Math.abs(aMs - rMs) > MATCH_TIME_MS) return { ok: false, reason: 'time-mismatch' };
  if (actual.durationSec > 0 && row.duration_sec > 0) {
    const durRatio = Math.abs(actual.durationSec - row.duration_sec) / Math.max(actual.durationSec, row.duration_sec);
    if (durRatio > MATCH_DUR_RATIO) return { ok: false, reason: 'duration-mismatch' };
  }
  return { ok: true };
}

/**
 * Compute the merge patch for enriching `actual` from a parsed file `row`.
 * Pure: returns the patch and never mutates `actual`. Pass `{ force: true }`
 * to bypass the match guard (user confirmed "enrich anyway").
 */
export function enrichActualFromParsedRow(
  actual: GarminActual,
  row: GarminActivityRow,
  opts: { force?: boolean } = {},
): EnrichResult {
  const match = fileMatchesActual(actual, row);
  if (!match.ok && !opts.force) return { accepted: false, reason: match.reason };

  const patch: Partial<GarminActual> = {};
  const added: string[] = [];
  const missing = (v: number | null | undefined) => v == null || v <= 0;

  // Rich signals — the point of enriching. Fill only when the actual lacks them.
  if (missing(actual.iTrimp) && row.iTrimp != null && row.iTrimp > 0) {
    patch.iTrimp = row.iTrimp;
    added.push('HR load');
  }
  if (!actual.hrZones && row.hrZones) {
    patch.hrZones = row.hrZones;
    added.push('HR zones');
  }
  if ((!actual.kmSplits || actual.kmSplits.length === 0) && row.kmSplits && row.kmSplits.length > 0) {
    patch.kmSplits = row.kmSplits;
    added.push('km splits');
  }
  if ((!actual.kmHRSplits || actual.kmHRSplits.length === 0) && row.kmHRSplits && row.kmHRSplits.length > 0) {
    patch.kmHRSplits = row.kmHRSplits;
  }
  if (!actual.polyline && row.polyline) {
    patch.polyline = row.polyline;
    added.push('route');
  }
  if (actual.elevationGainM == null && row.elevationGainM != null) {
    patch.elevationGainM = row.elevationGainM;
  }
  if (!actual.repData && row.repData) {
    patch.repData = row.repData;
  }
  if (actual.hrDrift == null && row.hrDrift != null) {
    patch.hrDrift = row.hrDrift;
  }

  // Power (cycling). Fill the whole block only when the actual has no power.
  if (missing(actual.averageWatts) && row.averageWatts != null && row.averageWatts > 0) {
    patch.averageWatts = row.averageWatts;
    if (row.maxWatts != null) patch.maxWatts = row.maxWatts;
    if (row.normalizedPowerW != null) patch.normalizedPowerW = row.normalizedPowerW;
    if (row.powerCurve) patch.powerCurve = row.powerCurve;
    if (row.deviceWatts != null) patch.deviceWatts = row.deviceWatts;
    if (row.kilojoules != null) patch.kilojoules = row.kilojoules;
    added.push('power');
  }

  // Base fields — only when the actual is genuinely missing them (a thin Apple
  // Health row usually has avg HR + duration but may lack pace/distance/max HR).
  if (missing(actual.avgHR) && row.avg_hr != null) patch.avgHR = row.avg_hr;
  if (missing(actual.maxHR) && row.max_hr != null) patch.maxHR = row.max_hr;
  if (missing(actual.avgPaceSecKm) && row.avg_pace_sec_km != null) patch.avgPaceSecKm = row.avg_pace_sec_km;
  if (missing(actual.distanceKm) && row.distance_m != null && row.distance_m > 0) {
    patch.distanceKm = row.distance_m / 1000;
  }

  if (Object.keys(patch).length === 0) return { accepted: false, reason: 'no-new-data' };

  patch.enrichedFromFile = true;
  return { accepted: true, patch, added };
}
