import { haversineDistance } from './geo-math';

export interface LatLng { lat: number; lng: number; }

export interface TrimResult {
  trimmed: LatLng[];
  encodedPolyline: string;
  pointCount: number;
  distanceKm: number;
  centerLat: number;
  centerLng: number;
  boundsNorth: number;
  boundsSouth: number;
  boundsEast: number;
  boundsWest: number;
}

const DEFAULT_TRIM_METERS = 300;

/**
 * Strips ~300m from the start and end of a route to protect home/work locations,
 * then returns the trimmed points plus derived metadata.
 * Returns null if the route is too short to trim meaningfully.
 */
export function trimRouteEnds(points: LatLng[], trimMeters = DEFAULT_TRIM_METERS): TrimResult | null {
  if (points.length < 2) return null;

  // Walk forward from start until cumulative distance >= trimMeters
  let startIdx = 0;
  let cum = 0;
  for (let i = 1; i < points.length; i++) {
    cum += haversineDistance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    if (cum >= trimMeters) { startIdx = i; break; }
  }

  // Walk backward from end until cumulative distance >= trimMeters
  let endIdx = points.length - 1;
  cum = 0;
  for (let i = points.length - 2; i >= 0; i--) {
    cum += haversineDistance(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng);
    if (cum >= trimMeters) { endIdx = i; break; }
  }

  if (startIdx >= endIdx) return null;

  const trimmed = points.slice(startIdx, endIdx + 1);

  let distMeters = 0;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (let i = 0; i < trimmed.length; i++) {
    const p = trimmed[i];
    if (i > 0) distMeters += haversineDistance(trimmed[i - 1].lat, trimmed[i - 1].lng, p.lat, p.lng);
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }

  return {
    trimmed,
    encodedPolyline: encodePolyline(trimmed),
    pointCount: trimmed.length,
    distanceKm: distMeters / 1000,
    centerLat: (minLat + maxLat) / 2,
    centerLng: (minLng + maxLng) / 2,
    boundsNorth: maxLat,
    boundsSouth: minLat,
    boundsEast: maxLng,
    boundsWest: minLng,
  };
}

/** Google Polyline encoder (precision 5). */
export function encodePolyline(points: LatLng[]): string {
  let out = '';
  let prevLat = 0, prevLng = 0;
  for (const { lat, lng } of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeVal(iLat - prevLat);
    out += encodeVal(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

function encodeVal(v: number): string {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let s = '';
  while (n >= 0x20) {
    s += String.fromCharCode(((0x20 | (n & 0x1f)) + 63));
    n >>>= 5;
  }
  s += String.fromCharCode(n + 63);
  return s;
}

/** Decode a Google Polyline string to LatLng array. */
export function decodePolylineToLatLng(encoded: string): LatLng[] {
  const result: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b: number, shift = 0, res = 0;
    do { b = encoded.charCodeAt(index++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (res & 1) ? ~(res >> 1) : res >> 1;
    shift = 0; res = 0;
    do { b = encoded.charCodeAt(index++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (res & 1) ? ~(res >> 1) : res >> 1;
    result.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return result;
}
