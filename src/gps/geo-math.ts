import type { GpsPoint } from '@/types';

const EARTH_RADIUS = 6371000; // meters

/**
 * Haversine distance between two lat/lng points in meters.
 */
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Calculate pace in sec/km from distance (m) and elapsed (sec).
 * Returns Infinity if distance is 0.
 */
export function calculatePace(distanceMeters: number, elapsedSeconds: number): number {
  if (distanceMeters <= 0) return Infinity;
  return (elapsedSeconds / distanceMeters) * 1000;
}

/**
 * Compute a rolling pace from recent points within a time window.
 * @param points - GPS points (must be sorted by timestamp ascending)
 * @param windowSeconds - look-back window (default 30s)
 * @returns pace in sec/km, or null if not enough data
 */
export function rollingPace(points: GpsPoint[], windowSeconds: number = 30): number | null {
  if (points.length < 2) return null;

  const latest = points[points.length - 1];
  const cutoff = latest.timestamp - windowSeconds * 1000;

  // Find earliest point inside the window
  let startIdx = points.length - 1;
  for (let i = points.length - 2; i >= 0; i--) {
    if (points[i].timestamp < cutoff) break;
    startIdx = i;
  }

  if (startIdx === points.length - 1) return null;

  let dist = 0;
  for (let i = startIdx; i < points.length - 1; i++) {
    dist += haversineDistance(
      points[i].lat, points[i].lng,
      points[i + 1].lat, points[i + 1].lng
    );
  }

  const elapsed = (latest.timestamp - points[startIdx].timestamp) / 1000;
  if (elapsed <= 0 || dist <= 0) return null;

  return calculatePace(dist, elapsed);
}

/**
 * Total distance of a route of GpsPoints in meters.
 */
export function routeDistance(points: GpsPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(
      points[i - 1].lat, points[i - 1].lng,
      points[i].lat, points[i].lng
    );
  }
  return total;
}

/**
 * Reject a GPS point if it looks like jitter.
 * Returns true if the point should be rejected.
 *
 * Criteria:
 * - accuracy > 30 m
 * - implied speed > 12 m/s (~43 km/h, well above any runner)
 */
export function filterJitter(
  point: GpsPoint,
  previous: GpsPoint | null,
  maxAccuracy: number = 30,
  maxSpeed: number = 12
): boolean {
  if (point.accuracy > maxAccuracy) return true;

  if (previous) {
    const dist = haversineDistance(previous.lat, previous.lng, point.lat, point.lng);
    const dt = (point.timestamp - previous.timestamp) / 1000;
    if (dt > 0 && dist / dt > maxSpeed) return true;
  }

  return false;
}
