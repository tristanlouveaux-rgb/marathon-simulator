/**
 * Apple Health route helpers — converts the CLLocation arrays returned by
 * `readWorkoutRouteLocations` (HealthExtras plugin) into the polyline /
 * km-splits / best-efforts shapes the rest of Mosaic already understands.
 *
 * Three outputs from one location array:
 *   1. encodePolyline — Google encoded polyline string (matches Strava's
 *      `summary_polyline` field) so the existing decoder + map renderer in
 *      `src/ui/strava-detail.ts` works unchanged on Apple workouts.
 *   2. extractKmSplits — array of seconds-per-km, one entry per completed km
 *      (mirrors Strava's `splits_metric`).
 *   3. extractBestEfforts — fastest 5K/10K/HM/marathon segments as the same
 *      object shape Strava returns from `GET /activities/{id}` so
 *      `pbs-from-history.ts` can read them without modification.
 */

import type { RouteLocation } from './healthExtras';

// ---------------------------------------------------------------------------
// Google encoded-polyline encoder (no dependency, mirrors the decoder in
// src/ui/strava-detail.ts so encode→decode round-trips cleanly)
// ---------------------------------------------------------------------------

/**
 * Encode an array of [lat, lng] pairs into a Google polyline string.
 * Lossy at the 1e5 quantisation step (~1.1m at the equator) — same precision
 * Strava's `summary_polyline` uses, so visually identical for run/ride GPS.
 */
export function encodePolyline(coords: Array<[number, number]>): string {
  let result = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of coords) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    result += encodeSignedNumber(latE5 - prevLat);
    result += encodeSignedNumber(lngE5 - prevLng);
    prevLat = latE5;
    prevLng = lngE5;
  }
  return result;
}

function encodeSignedNumber(num: number): string {
  // Apply the canonical sign-shift transform: shift left, invert if negative.
  let sgn = num << 1;
  if (num < 0) sgn = ~sgn;
  return encodeUnsignedNumber(sgn);
}

function encodeUnsignedNumber(numIn: number): string {
  let num = numIn;
  let result = '';
  while (num >= 0x20) {
    result += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
    num >>= 5;
  }
  result += String.fromCharCode(num + 63);
  return result;
}

// ---------------------------------------------------------------------------
// Distance + cumulative-distance helpers
// ---------------------------------------------------------------------------

/** Haversine distance in metres between two points. */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Build a parallel array of cumulative metres travelled at each location index. */
function cumulativeDistances(locations: RouteLocation[]): number[] {
  const result = new Array<number>(locations.length);
  result[0] = 0;
  for (let i = 1; i < locations.length; i++) {
    const prev = locations[i - 1];
    const cur = locations[i];
    const segM = haversineM(prev.lat, prev.lng, cur.lat, cur.lng);
    result[i] = result[i - 1] + segM;
  }
  return result;
}

/** Convert location.timestamp ISO strings into seconds since first sample. */
function elapsedSeconds(locations: RouteLocation[]): number[] {
  if (locations.length === 0) return [];
  const t0 = new Date(locations[0].timestamp).getTime();
  return locations.map(l => (new Date(l.timestamp).getTime() - t0) / 1000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract per-km split times from a location array. One entry per completed km.
 * Result[i] = seconds taken to traverse from cumulative km i → km i+1.
 *
 * Linear interpolation across location-pair boundaries: a km mark rarely
 * lands exactly on a sample, so we interpolate the time at the exact 1000m,
 * 2000m, ... distances using the time gradient between flanking samples.
 */
export function extractKmSplits(locations: RouteLocation[]): number[] {
  if (locations.length < 2) return [];
  const cum = cumulativeDistances(locations);
  const elapsed = elapsedSeconds(locations);
  const totalM = cum[cum.length - 1];
  const totalKm = Math.floor(totalM / 1000);
  if (totalKm < 1) return [];

  const splits: number[] = [];
  let lastKmTime = 0;
  for (let kmTarget = 1; kmTarget <= totalKm; kmTarget++) {
    const targetM = kmTarget * 1000;
    // Find the first index where cumulative ≥ targetM.
    let idx = 1;
    while (idx < cum.length && cum[idx] < targetM) idx++;
    if (idx >= cum.length) break;
    const prevCum = cum[idx - 1];
    const segDist = cum[idx] - prevCum;
    const segTime = elapsed[idx] - elapsed[idx - 1];
    const frac = segDist > 0 ? (targetM - prevCum) / segDist : 0;
    const tAtKm = elapsed[idx - 1] + frac * segTime;
    splits.push(Math.round(tAtKm - lastKmTime));
    lastKmTime = tAtKm;
  }
  return splits;
}

/** Encoded polyline from a location array. Returns null when too few points. */
export function buildPolylineFromLocations(locations: RouteLocation[]): string | null {
  if (locations.length < 2) return null;
  const coords = locations.map(l => [l.lat, l.lng] as [number, number]);
  return encodePolyline(coords);
}

// ---------------------------------------------------------------------------
// Best-efforts extraction (Strava-shaped output)
// ---------------------------------------------------------------------------

/** Race distance → metres (canonical lengths). */
const BEST_EFFORT_DISTANCES_M: Array<{ name: string; meters: number }> = [
  { name: '5K',            meters: 5000 },
  { name: '10K',           meters: 10000 },
  { name: 'Half Marathon', meters: 21097.5 },
  { name: 'Marathon',      meters: 42195 },
];

/** Strava-shaped best-effort entry; matches what `pbs-from-history.ts` reads.
 *  `start_date` is the activity's start, not the sub-segment's, so the PB
 *  recency penalty in `blendPredictions` lines up with how Strava attributes
 *  its own best efforts. */
export interface SyntheticBestEffort {
  name: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  start_date: string;
}

/**
 * Given a location array and the activity's start ISO date, find the fastest
 * sub-segment of each canonical race distance using a sliding-window scan
 * over cumulative distance.
 *
 * Algorithm (per target distance D):
 *   - Iterate `start` index across all locations.
 *   - For each `start`, find the first `end` index whose cumulative distance
 *     from `start` ≥ D (binary search over cum[]).
 *   - Interpolate time at exactly D metres (linear inside the spanning segment).
 *   - Track minimum elapsed time across all `start` choices.
 *
 * Complexity: O(n log n) per distance, O(n log n × 4) total. Well under 1s
 * for typical 16-week backfills (~100 runs × ~1000 points each).
 *
 * Skipped entirely for activities shorter than 5K — no PBs to find.
 */
export function extractBestEfforts(
  locations: RouteLocation[],
  activityStartISO: string,
): SyntheticBestEffort[] {
  if (locations.length < 10) return [];
  const cum = cumulativeDistances(locations);
  const elapsed = elapsedSeconds(locations);
  const totalM = cum[cum.length - 1];
  if (totalM < 5000) return [];

  const out: SyntheticBestEffort[] = [];

  for (const target of BEST_EFFORT_DISTANCES_M) {
    if (totalM < target.meters) continue;

    let bestTime = Infinity;
    for (let start = 0; start < cum.length - 1; start++) {
      const startM = cum[start];
      const endTargetM = startM + target.meters;
      if (endTargetM > totalM) break;

      // Binary search the first index where cum[i] >= endTargetM.
      let lo = start + 1;
      let hi = cum.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cum[mid] < endTargetM) lo = mid + 1;
        else hi = mid;
      }
      const endIdx = lo;

      // Linear-interpolate the exact moment cumulative distance hit endTargetM.
      const prevCum = cum[endIdx - 1];
      const segDist = cum[endIdx] - prevCum;
      const segTime = elapsed[endIdx] - elapsed[endIdx - 1];
      const frac = segDist > 0 ? (endTargetM - prevCum) / segDist : 0;
      const endTime = elapsed[endIdx - 1] + frac * segTime;
      const elapsedForSegment = endTime - elapsed[start];

      if (elapsedForSegment < bestTime) bestTime = elapsedForSegment;
    }

    if (Number.isFinite(bestTime) && bestTime > 0) {
      out.push({
        name: target.name,
        elapsed_time: Math.round(bestTime),
        moving_time: Math.round(bestTime),
        distance: target.meters,
        start_date: activityStartISO,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Time-window matching — pair workout rows with HKWorkoutRoute samples
// ---------------------------------------------------------------------------

/**
 * Match a workout's start time to the closest HKWorkoutRoute by start. Returns
 * the route's location array (or null) so the caller can splice it onto the
 * activity row.
 *
 * Pairing tolerance is ±2 minutes — Apple Watch can record the route's start
 * slightly before/after the workout's start (workout timer vs. GPS lock), but
 * the gap is rarely larger than a few seconds in practice.
 */
export function findRouteForWorkout(
  routes: Array<{ startDate: string; endDate: string; locations: RouteLocation[] }>,
  workoutStartISO: string,
  toleranceSec = 120,
): RouteLocation[] | null {
  const workoutMs = new Date(workoutStartISO).getTime();
  let closest: { gap: number; locs: RouteLocation[] } | null = null;
  for (const r of routes) {
    if (r.locations.length < 2) continue;
    const routeMs = new Date(r.startDate).getTime();
    const gap = Math.abs(routeMs - workoutMs) / 1000;
    if (gap > toleranceSec) continue;
    if (!closest || gap < closest.gap) closest = { gap, locs: r.locations };
  }
  return closest?.locs ?? null;
}
