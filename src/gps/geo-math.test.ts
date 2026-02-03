import { describe, it, expect } from 'vitest';
import {
  haversineDistance,
  calculatePace,
  rollingPace,
  routeDistance,
  filterJitter
} from './geo-math';
import type { GpsPoint } from '@/types';

function makePoint(
  lat: number,
  lng: number,
  timestamp: number,
  accuracy: number = 5
): GpsPoint {
  return { lat, lng, altitude: null, accuracy, speed: null, timestamp };
}

describe('haversineDistance', () => {
  it('returns 0 for same point', () => {
    expect(haversineDistance(48.8566, 2.3522, 48.8566, 2.3522)).toBe(0);
  });

  it('calculates known distance Paris to Lyon (~392 km)', () => {
    const d = haversineDistance(48.8566, 2.3522, 45.7640, 4.8357);
    expect(d).toBeGreaterThan(390000);
    expect(d).toBeLessThan(395000);
  });

  it('calculates short distance (~111 m for ~0.001 deg lat)', () => {
    const d = haversineDistance(0, 0, 0.001, 0);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });

  it('is symmetric', () => {
    const ab = haversineDistance(48.8566, 2.3522, 45.7640, 4.8357);
    const ba = haversineDistance(45.7640, 4.8357, 48.8566, 2.3522);
    expect(ab).toBeCloseTo(ba, 6);
  });
});

describe('calculatePace', () => {
  it('returns pace in sec/km', () => {
    // 1000m in 300s => 300 sec/km => 5:00/km
    expect(calculatePace(1000, 300)).toBe(300);
  });

  it('returns Infinity for zero distance', () => {
    expect(calculatePace(0, 300)).toBe(Infinity);
  });

  it('handles fractional distances', () => {
    // 500m in 150s => 300 sec/km
    expect(calculatePace(500, 150)).toBe(300);
  });
});

describe('rollingPace', () => {
  it('returns null for fewer than 2 points', () => {
    expect(rollingPace([])).toBeNull();
    expect(rollingPace([makePoint(0, 0, 1000)])).toBeNull();
  });

  it('calculates pace from recent points', () => {
    // ~111m apart (0.001 deg lat), 30s between points
    const points: GpsPoint[] = [
      makePoint(0, 0, 0),
      makePoint(0.001, 0, 30000),
    ];
    const pace = rollingPace(points, 60);
    expect(pace).not.toBeNull();
    // ~111m in 30s => pace ~ 270 sec/km
    expect(pace!).toBeGreaterThan(200);
    expect(pace!).toBeLessThan(350);
  });

  it('only uses points within the window', () => {
    const points: GpsPoint[] = [
      makePoint(0, 0, 0),           // old, outside 30s window
      makePoint(0.001, 0, 50000),   // inside window
      makePoint(0.002, 0, 60000),   // latest
    ];
    const pace = rollingPace(points, 30);
    expect(pace).not.toBeNull();
    // Should only use the last two points (50s to 60s, 10s window)
    // ~111m in 10s => ~90 sec/km
    expect(pace!).toBeGreaterThan(50);
    expect(pace!).toBeLessThan(150);
  });
});

describe('routeDistance', () => {
  it('returns 0 for empty or single point', () => {
    expect(routeDistance([])).toBe(0);
    expect(routeDistance([makePoint(0, 0, 0)])).toBe(0);
  });

  it('sums distances between consecutive points', () => {
    const points: GpsPoint[] = [
      makePoint(0, 0, 0),
      makePoint(0.001, 0, 1000),
      makePoint(0.002, 0, 2000),
    ];
    const total = routeDistance(points);
    const singleLeg = haversineDistance(0, 0, 0.001, 0);
    // Two legs of same length
    expect(total).toBeCloseTo(singleLeg * 2, 0);
  });
});

describe('filterJitter', () => {
  it('rejects points with accuracy > 30m', () => {
    const point = makePoint(0, 0, 1000, 50);
    expect(filterJitter(point, null)).toBe(true);
  });

  it('accepts points with good accuracy and no previous', () => {
    const point = makePoint(0, 0, 1000, 5);
    expect(filterJitter(point, null)).toBe(false);
  });

  it('rejects points implying speed > 12 m/s', () => {
    const prev = makePoint(0, 0, 0, 5);
    // ~1.11 km in 1 second => 1110 m/s, way too fast
    const point = makePoint(0.01, 0, 1000, 5);
    expect(filterJitter(point, prev)).toBe(true);
  });

  it('accepts realistic running speed', () => {
    const prev = makePoint(0, 0, 0, 5);
    // ~111m in 30s => ~3.7 m/s, reasonable jog
    const point = makePoint(0.001, 0, 30000, 5);
    expect(filterJitter(point, prev)).toBe(false);
  });

  it('uses custom thresholds', () => {
    const point = makePoint(0, 0, 1000, 25);
    // Default passes (25 < 30), but custom threshold of 20 rejects
    expect(filterJitter(point, null, 20)).toBe(true);
    expect(filterJitter(point, null, 30)).toBe(false);
  });
});
