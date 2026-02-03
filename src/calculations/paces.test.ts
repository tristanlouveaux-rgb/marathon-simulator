import { describe, it, expect } from 'vitest';
import { gp, getPaceForZone } from './paces';
import type { Paces } from '@/types';

describe('Pace Calculations', () => {
  describe('gp - Get paces from VDOT or LT', () => {
    describe('from LT pace', () => {
      it('should calculate all zones from LT pace', () => {
        const ltPace = 240; // 4:00/km
        const paces = gp(50, ltPace);

        expect(paces.t).toBe(240);           // Threshold = LT
        expect(paces.e).toBeCloseTo(276, 0); // Easy: 15% slower
        expect(paces.m).toBeCloseTo(252, 0); // Marathon: 5% slower
        expect(paces.i).toBeCloseTo(223, 0); // Interval: 7% faster
        expect(paces.r).toBeCloseTo(211, 0); // Rep: 12% faster
      });

      it('should maintain correct zone relationships', () => {
        const ltPace = 240;
        const paces = gp(50, ltPace);

        // Fastest to slowest: r < i < t < m < e
        expect(paces.r).toBeLessThan(paces.i);
        expect(paces.i).toBeLessThan(paces.t);
        expect(paces.t).toBeLessThan(paces.m);
        expect(paces.m).toBeLessThan(paces.e);
      });
    });

    describe('from VDOT', () => {
      it('should calculate paces from VDOT when no LT provided', () => {
        const paces = gp(50, null);

        // All paces should be positive
        expect(paces.e).toBeGreaterThan(0);
        expect(paces.m).toBeGreaterThan(0);
        expect(paces.t).toBeGreaterThan(0);
        expect(paces.i).toBeGreaterThan(0);
        expect(paces.r).toBeGreaterThan(0);
      });

      it('should give faster paces for higher VDOT', () => {
        const paces40 = gp(40);
        const paces60 = gp(60);

        // Higher VDOT = faster paces (lower seconds)
        expect(paces60.e).toBeLessThan(paces40.e);
        expect(paces60.m).toBeLessThan(paces40.m);
        expect(paces60.t).toBeLessThan(paces40.t);
        expect(paces60.i).toBeLessThan(paces40.i);
        expect(paces60.r).toBeLessThan(paces40.r);
      });

      it('should produce reasonable paces for VDOT 50', () => {
        const paces = gp(50);

        // VDOT 50 is roughly 19-20 min 5K pace
        // Easy should be around 5:00-6:00/km
        expect(paces.e).toBeGreaterThan(280); // > 4:40
        expect(paces.e).toBeLessThan(400);    // < 6:40

        // Marathon should be around 4:30-5:00/km
        expect(paces.m).toBeGreaterThan(250); // > 4:10
        expect(paces.m).toBeLessThan(320);    // < 5:20
      });
    });
  });

  describe('getPaceForZone', () => {
    const paces: Paces = {
      e: 300,  // 5:00/km easy
      m: 270,  // 4:30/km marathon
      t: 250,  // 4:10/km threshold
      i: 230,  // 3:50/km interval
      r: 210   // 3:30/km rep
    };

    it('should return correct pace for standard zone names', () => {
      expect(getPaceForZone('easy', paces)).toBe(300);
      expect(getPaceForZone('threshold', paces)).toBe(250);
      expect(getPaceForZone('tempo', paces)).toBe(250);
    });

    it('should handle single-letter zone codes', () => {
      expect(getPaceForZone('e', paces)).toBe(300);
      expect(getPaceForZone('t', paces)).toBe(250);
      expect(getPaceForZone('i', paces)).toBe(230);
      expect(getPaceForZone('r', paces)).toBe(210);
      expect(getPaceForZone('m', paces)).toBe(270);
    });

    it('should handle race distance zones', () => {
      expect(getPaceForZone('5k', paces)).toBe(230);      // interval pace
      expect(getPaceForZone('5K', paces)).toBe(230);
      expect(getPaceForZone('10k', paces)).toBeCloseTo(270 * 0.95, 0); // slightly faster than marathon
      expect(getPaceForZone('mp', paces)).toBe(270);
      expect(getPaceForZone('MP', paces)).toBe(270);
      expect(getPaceForZone('hm', paces)).toBeCloseTo(270 * 1.05, 0); // slightly slower than marathon
    });

    it('should handle case insensitivity', () => {
      expect(getPaceForZone('EASY', paces)).toBe(300);
      expect(getPaceForZone('Easy', paces)).toBe(300);
      expect(getPaceForZone('THRESHOLD', paces)).toBe(250);
    });

    it('should default to easy pace for unknown zones', () => {
      expect(getPaceForZone('unknown', paces)).toBe(300);
      expect(getPaceForZone('xyz', paces)).toBe(300);
    });
  });

  describe('real-world pace calculations', () => {
    it('should give reasonable paces for beginner (VDOT 35)', () => {
      const paces = gp(35);

      // Easy pace should be ~6:30-7:30/km (390-450 sec)
      expect(paces.e).toBeGreaterThan(350);
      expect(paces.e).toBeLessThan(500);
    });

    it('should give reasonable paces for elite (VDOT 70)', () => {
      const paces = gp(70);

      // All paces positive
      expect(paces.e).toBeGreaterThan(0);
      expect(paces.m).toBeGreaterThan(0);
      expect(paces.t).toBeGreaterThan(0);
      expect(paces.i).toBeGreaterThan(0);
      expect(paces.r).toBeGreaterThan(0);

      // Correct ordering: rep < interval < threshold < marathon < easy
      expect(paces.r).toBeLessThan(paces.i);
      expect(paces.i).toBeLessThan(paces.t);
      expect(paces.t).toBeLessThan(paces.m);
      expect(paces.m).toBeLessThan(paces.e);
    });
  });
});
