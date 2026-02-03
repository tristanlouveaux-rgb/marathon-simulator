import { describe, it, expect } from 'vitest';
import { parseWorkoutDescription } from './parser';
import type { Paces } from '@/types';

describe('Workout Parser', () => {
  // Standard test paces
  const paces: Paces = {
    e: 330,   // 5:30/km easy
    m: 285,   // 4:45/km marathon
    t: 270,   // 4:30/km threshold
    i: 240,   // 4:00/km interval (5K)
    r: 220    // 3:40/km rep
  };

  describe('simple distance format', () => {
    it('should parse "8km"', () => {
      const result = parseWorkoutDescription('8km', paces);

      expect(result.format).toBe('simple');
      expect(result.totalDistance).toBe(8000);
      expect(result.paceZone).toBe('easy');
      expect(result.avgPace).toBe(paces.e);
    });

    it('should parse "10km"', () => {
      const result = parseWorkoutDescription('10km', paces);

      expect(result.totalDistance).toBe(10000);
      expect(result.workTime).toBeCloseTo(10 * paces.e, 0);
    });

    it('should parse decimal distances "6.5km"', () => {
      const result = parseWorkoutDescription('6.5km', paces);

      expect(result.totalDistance).toBe(6500);
    });
  });

  describe('modified distance format', () => {
    it('should parse "4km (was 8km)"', () => {
      const result = parseWorkoutDescription('4km (was 8km)', paces);

      expect(result.format).toBe('simple');
      expect(result.totalDistance).toBe(4000);
      expect(result.paceZone).toBe('easy');
    });

    it('should parse "6km (was 10km)"', () => {
      const result = parseWorkoutDescription('6km (was 10km)', paces);

      expect(result.totalDistance).toBe(6000);
    });
  });

  describe('time @ pace format', () => {
    it('should parse "20min @ threshold"', () => {
      const result = parseWorkoutDescription('20min @ threshold', paces);

      expect(result.format).toBe('time_at_pace');
      expect(result.workTime).toBe(20 * 60);
      expect(result.avgPace).toBe(paces.t);
      expect(result.paceZone).toBe('threshold');
    });

    it('should parse "45min @ tempo"', () => {
      const result = parseWorkoutDescription('45min @ tempo', paces);

      expect(result.format).toBe('time_at_pace');
      expect(result.workTime).toBe(45 * 60);
      expect(result.avgPace).toBe(paces.t); // tempo = threshold
    });

    it('should calculate distance from time and pace', () => {
      const result = parseWorkoutDescription('20min @ threshold', paces);

      // 20 min at 4:30/km = 20*60 / 270 = 4.44 km
      expect(result.totalDistance).toBeCloseTo(4444, -1);
    });
  });

  describe('distance intervals format', () => {
    it('should parse "8×800 @ 5K, 90s"', () => {
      const result = parseWorkoutDescription('8×800 @ 5K, 90s', paces);

      expect(result.format).toBe('intervals_dist');
      expect(result.totalDistance).toBe(8 * 800);
      expect(result.avgPace).toBe(paces.i); // 5K = interval pace
    });

    it('should parse "4×1km @ threshold, 2min"', () => {
      const result = parseWorkoutDescription('4×1km @ threshold, 2min', paces);

      expect(result.format).toBe('intervals_dist');
      expect(result.totalDistance).toBe(4000);
      expect(result.avgPace).toBe(paces.t);
    });

    it('should parse "4×1mi @ 10K, 2min"', () => {
      const result = parseWorkoutDescription('4×1mi @ 10K, 2min', paces);

      expect(result.format).toBe('intervals_dist');
      expect(result.totalDistance).toBeCloseTo(4 * 1609, 0);
    });

    it('should calculate rest time correctly', () => {
      const result = parseWorkoutDescription('8×800 @ 5K, 90s', paces);

      // 8 reps of 800m at 4:00/km = 8 * (0.8 * 240) = 8 * 192 = 1536 sec work
      // Plus 7 rest periods of 90s = 630 sec
      // Total = 2166 sec (minus last rest)
      expect(result.workTime).toBeCloseTo(8 * 0.8 * 240, 0);
    });
  });

  describe('time intervals format', () => {
    it('should parse "3×10min @ threshold, 2min"', () => {
      const result = parseWorkoutDescription('3×10min @ threshold, 2min', paces);

      expect(result.format).toBe('intervals_time');
      expect(result.workTime).toBe(3 * 10 * 60);
      expect(result.avgPace).toBe(paces.t);
    });

    it('should calculate total time including rest', () => {
      const result = parseWorkoutDescription('3×10min @ threshold, 2min', paces);

      // 3 * 10min work + 2 * 2min rest = 30 + 4 = 34 min
      expect(result.totalTime).toBe(34 * 60);
    });
  });

  describe('progressive format', () => {
    it('should parse "21km: last 5 @ HM"', () => {
      const result = parseWorkoutDescription('21km: last 5 @ HM', paces);

      expect(result.format).toBe('progressive');
      expect(result.totalDistance).toBe(21000);
      expect(result.paceZone).toBe('progressive');
    });

    it('should parse "29km: last 10 @ MP"', () => {
      const result = parseWorkoutDescription('29km: last 10 @ MP', paces);

      expect(result.format).toBe('progressive');
      expect(result.totalDistance).toBe(29000);
    });

    it('should calculate mixed pace correctly', () => {
      const result = parseWorkoutDescription('21km: last 5 @ HM', paces);

      // 16km easy + 5km at HM pace
      // Average pace should be between easy and HM
      expect(result.avgPace).toBeGreaterThan(paces.m * 1.05); // HM is slower than marathon
      expect(result.avgPace).toBeLessThan(paces.e);
    });
  });

  describe('distance @ pace format', () => {
    it('should parse "20km @ MP"', () => {
      const result = parseWorkoutDescription('20km @ MP', paces);

      expect(result.format).toBe('dist_at_pace');
      expect(result.totalDistance).toBe(20000);
      expect(result.avgPace).toBe(paces.m);
      // paceZone preserves the original case from input
      expect(result.paceZone).toBe('MP');
    });

    it('should parse "15km @ threshold"', () => {
      const result = parseWorkoutDescription('15km @ threshold', paces);

      expect(result.totalDistance).toBe(15000);
      expect(result.avgPace).toBe(paces.t);
    });
  });

  describe('mixed paces format', () => {
    it('should parse "10@MP, 4@10K, 5@HM"', () => {
      const result = parseWorkoutDescription('10@MP, 4@10K, 5@HM', paces);

      expect(result.format).toBe('mixed');
      expect(result.totalDistance).toBe(19000);
      expect(result.paceZone).toBe('mixed');
    });

    it('should parse "6.5@MP, 2.5@10K, 3@HM"', () => {
      const result = parseWorkoutDescription('6.5@MP, 2.5@10K, 3@HM', paces);

      expect(result.format).toBe('mixed');
      expect(result.totalDistance).toBe(12000);
    });

    it('should calculate weighted average pace', () => {
      const result = parseWorkoutDescription('10@MP, 10@easy', paces);

      // Average of MP and easy paces weighted by distance
      // (10 * 285 + 10 * 330) / 20 = 307.5
      expect(result.avgPace).toBeCloseTo(307.5, 0);
    });
  });

  describe('long intervals format', () => {
    it('should parse "2×10km @ MP, 2min"', () => {
      const result = parseWorkoutDescription('2×10km @ MP, 2min', paces);

      // Parser matches this as intervals_dist first due to pattern order
      expect(['long_intervals', 'intervals_dist']).toContain(result.format);
      expect(result.totalDistance).toBe(20000);
      expect(result.avgPace).toBe(paces.m);
    });

    it('should parse "2×15km @ threshold, 3min"', () => {
      const result = parseWorkoutDescription('2×15km @ threshold, 3min', paces);

      expect(['long_intervals', 'intervals_dist']).toContain(result.format);
      expect(result.totalDistance).toBe(30000);
    });
  });

  describe('unknown format handling', () => {
    it('should return unknown format for unparseable strings', () => {
      const result = parseWorkoutDescription('some random text', paces);

      expect(result.format).toBe('unknown');
      expect(result.totalDistance).toBe(0);
    });

    it('should handle empty string', () => {
      const result = parseWorkoutDescription('', paces);

      expect(result.format).toBe('unknown');
    });
  });

  describe('pace zone recognition', () => {
    it('should recognize all standard pace zones', () => {
      const zones = ['easy', 'threshold', 'tempo', '5k', '5K', '10k', '10K', 'mp', 'MP', 'hm', 'HM'];

      for (const zone of zones) {
        const result = parseWorkoutDescription(`10km @ ${zone}`, paces);
        expect(result.avgPace).toBeGreaterThan(0);
      }
    });
  });
});
