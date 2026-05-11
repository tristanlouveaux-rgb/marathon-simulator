import { describe, it, expect } from 'vitest';
import { trimRouteEnds, encodePolyline, decodePolylineToLatLng } from './anonymize-route';
import { haversineDistance } from './geo-math';

// Build a straight-line route of N points spaced ~stepMeters apart (walking north).
function makeLine(n: number, stepMeters: number, startLat = 51.5, startLng = -0.1) {
  const degPerMeter = 1 / 111_320;
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ lat: startLat + i * stepMeters * degPerMeter, lng: startLng });
  }
  return points;
}

describe('trimRouteEnds', () => {
  it('removes ~300m from each end of a long route', () => {
    // 101 points spaced 100m apart = 10km total
    const pts = makeLine(101, 100);
    const result = trimRouteEnds(pts, 300);
    expect(result).not.toBeNull();

    // Start should be at least 300m from original start
    const startDist = haversineDistance(pts[0].lat, pts[0].lng, result!.trimmed[0].lat, result!.trimmed[0].lng);
    expect(startDist).toBeGreaterThanOrEqual(299);

    // End should be at least 300m from original end
    const last = pts[pts.length - 1];
    const trimLast = result!.trimmed[result!.trimmed.length - 1];
    const endDist = haversineDistance(last.lat, last.lng, trimLast.lat, trimLast.lng);
    expect(endDist).toBeGreaterThanOrEqual(299);
  });

  it('returns null when route is too short to trim both ends', () => {
    // 5 points spaced 100m apart = 400m total — not enough to trim 300m from both ends
    const pts = makeLine(5, 100);
    const result = trimRouteEnds(pts, 300);
    expect(result).toBeNull();
  });

  it('returns null for a single point', () => {
    const result = trimRouteEnds([{ lat: 51.5, lng: -0.1 }]);
    expect(result).toBeNull();
  });

  it('returns null for empty array', () => {
    const result = trimRouteEnds([]);
    expect(result).toBeNull();
  });

  it('computes valid bounds and center', () => {
    const pts = makeLine(51, 100); // 5km route
    const result = trimRouteEnds(pts, 300);
    expect(result).not.toBeNull();
    expect(result!.boundsNorth).toBeGreaterThan(result!.boundsSouth);
    expect(result!.centerLat).toBeGreaterThan(result!.boundsSouth);
    expect(result!.centerLat).toBeLessThan(result!.boundsNorth);
  });

  it('distanceKm is positive and less than original route distance', () => {
    const pts = makeLine(101, 100); // 10km
    const result = trimRouteEnds(pts, 300);
    expect(result!.distanceKm).toBeGreaterThan(0);
    expect(result!.distanceKm).toBeLessThan(10.1);
    expect(result!.distanceKm).toBeGreaterThan(9); // about 9.4km after trim
  });

  it('encodes a non-empty polyline', () => {
    const pts = makeLine(101, 100);
    const result = trimRouteEnds(pts, 300);
    expect(result!.encodedPolyline.length).toBeGreaterThan(0);
  });
});

describe('encodePolyline / decodePolylineToLatLng roundtrip', () => {
  it('roundtrips a simple set of points', () => {
    const pts = [
      { lat: 51.5074, lng: -0.1278 },
      { lat: 51.5080, lng: -0.1260 },
      { lat: 51.5090, lng: -0.1250 },
    ];
    const encoded = encodePolyline(pts);
    const decoded = decodePolylineToLatLng(encoded);
    expect(decoded).toHaveLength(pts.length);
    for (let i = 0; i < pts.length; i++) {
      expect(decoded[i].lat).toBeCloseTo(pts[i].lat, 4);
      expect(decoded[i].lng).toBeCloseTo(pts[i].lng, 4);
    }
  });

  it('handles negative coordinates', () => {
    const pts = [
      { lat: -33.8688, lng: 151.2093 }, // Sydney
      { lat: -33.8700, lng: 151.2100 },
    ];
    const decoded = decodePolylineToLatLng(encodePolyline(pts));
    expect(decoded[0].lat).toBeCloseTo(pts[0].lat, 4);
    expect(decoded[0].lng).toBeCloseTo(pts[0].lng, 4);
  });
});
