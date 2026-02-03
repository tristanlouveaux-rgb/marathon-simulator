import { describe, it, expect } from 'vitest';
import { buildSplitScheme } from './split-scheme';
import type { Paces } from '@/types';

const testPaces: Paces = {
  e: 330,  // 5:30/km easy
  t: 270,  // 4:30/km threshold
  i: 240,  // 4:00/km interval
  m: 285,  // 4:45/km marathon
  r: 210,  // 3:30/km repetition
};

describe('buildSplitScheme', () => {
  describe('interval workouts', () => {
    it('parses 8×400m intervals', () => {
      const scheme = buildSplitScheme('8×400m @ 5K, 90s', testPaces);

      // 8 reps + 7 recovery segments
      expect(scheme.segments.length).toBe(15);

      // Check work segments
      const workSegs = scheme.segments.filter(s => s.label.startsWith('Rep'));
      expect(workSegs.length).toBe(8);
      expect(workSegs[0].distance).toBe(400);
      expect(workSegs[0].targetPace).toBe(testPaces.i); // 5K = interval pace
      expect(workSegs[0].label).toBe('Rep 1 of 8');
      expect(workSegs[7].label).toBe('Rep 8 of 8');

      // Check recovery segments
      const recSegs = scheme.segments.filter(s => s.label.startsWith('Recovery'));
      expect(recSegs.length).toBe(7);
      expect(recSegs[0].targetPace).toBeNull();
      expect(recSegs[0].distance).toBeGreaterThan(0);
    });

    it('parses 4×1km intervals', () => {
      const scheme = buildSplitScheme('4×1km @ threshold, 2min', testPaces);

      const workSegs = scheme.segments.filter(s => s.label.startsWith('Rep'));
      expect(workSegs.length).toBe(4);
      expect(workSegs[0].distance).toBe(1000);
      expect(workSegs[0].targetPace).toBe(testPaces.t);
    });

    it('parses mile intervals', () => {
      const scheme = buildSplitScheme('4×1mi @ 10K, 2min', testPaces);

      const workSegs = scheme.segments.filter(s => s.label.startsWith('Rep'));
      expect(workSegs.length).toBe(4);
      expect(workSegs[0].distance).toBeCloseTo(1609, 0);
    });
  });

  describe('time intervals', () => {
    it('parses 3×10min @ threshold', () => {
      const scheme = buildSplitScheme('3×10min @ threshold, 2min', testPaces);

      const workSegs = scheme.segments.filter(s => s.label.startsWith('Rep'));
      expect(workSegs.length).toBe(3);
      expect(workSegs[0].targetPace).toBe(testPaces.t);
      // 10 min at threshold pace (270s/km) = 10*60/270 km = ~2222m
      expect(workSegs[0].distance).toBeGreaterThan(2000);
      expect(workSegs[0].distance).toBeLessThan(2500);

      const recSegs = scheme.segments.filter(s => s.label.startsWith('Recovery'));
      expect(recSegs.length).toBe(2);
    });
  });

  describe('progressive runs', () => {
    it('parses 21km: last 5 @ HM', () => {
      const scheme = buildSplitScheme('21km: last 5 @ HM', testPaces);

      expect(scheme.totalDistance).toBe(21000);

      // 16km easy + 5km fast = segments for each km
      const easySegs = scheme.segments.filter(s => s.targetPace === testPaces.e);
      const fastSegs = scheme.segments.filter(s =>
        s.targetPace !== null && s.targetPace !== testPaces.e
      );

      expect(easySegs.length).toBe(16);
      expect(fastSegs.length).toBe(5);
      expect(fastSegs[0].label).toBe('Fast km 1 of 5');
    });

    it('parses 29km: last 10 @ MP', () => {
      const scheme = buildSplitScheme('29km: last 10 @ MP', testPaces);

      expect(scheme.totalDistance).toBe(29000);

      const fastSegs = scheme.segments.filter(s =>
        s.label.startsWith('Fast')
      );
      expect(fastSegs.length).toBe(10);
      expect(fastSegs[0].targetPace).toBe(testPaces.m);
    });
  });

  describe('simple distance runs', () => {
    it('parses 8km into km splits', () => {
      const scheme = buildSplitScheme('8km', testPaces);

      expect(scheme.segments.length).toBe(8);
      expect(scheme.totalDistance).toBe(8000);
      expect(scheme.segments[0].label).toBe('km 1');
      expect(scheme.segments[7].label).toBe('km 8');
      expect(scheme.segments[0].targetPace).toBe(testPaces.e);
    });

    it('handles fractional distances', () => {
      const scheme = buildSplitScheme('10.5km', testPaces);

      expect(scheme.segments.length).toBe(11); // 10 full + 1 partial
      expect(scheme.totalDistance).toBe(10500);
      expect(scheme.segments[10].label).toContain('500m');
    });
  });

  describe('distance @ pace', () => {
    it('parses 20km @ MP', () => {
      const scheme = buildSplitScheme('20km @ MP', testPaces);

      expect(scheme.segments.length).toBe(20);
      expect(scheme.totalDistance).toBe(20000);
      expect(scheme.segments[0].targetPace).toBe(testPaces.m);
    });
  });

  describe('edge cases', () => {
    it('returns empty scheme for unparseable input', () => {
      const scheme = buildSplitScheme('random text', testPaces);

      expect(scheme.segments.length).toBe(0);
      expect(scheme.totalDistance).toBe(0);
    });

    it('handles workout with km mentioned in description', () => {
      const scheme = buildSplitScheme('5km warmup jog', testPaces);

      expect(scheme.segments.length).toBe(5);
      expect(scheme.totalDistance).toBe(5000);
    });
  });
});
