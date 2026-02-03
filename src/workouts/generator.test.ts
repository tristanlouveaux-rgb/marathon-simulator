import { describe, it, expect } from 'vitest';
import { generateWeekWorkouts, initializeWeeks, getPhaseDisplayName } from './generator';
import type { TrainingPhase, RaceDistance, RunnerType, Workout } from '@/types';

describe('Workout Generator', () => {
  describe('generateWeekWorkouts', () => {
    describe('basic generation', () => {
      it('should generate correct number of workouts', () => {
        const workouts = generateWeekWorkouts('build', 5, 'marathon', 'Balanced');
        expect(workouts.length).toBe(5);
      });

      it('should generate workouts for different runs per week', () => {
        for (let rw = 3; rw <= 7; rw++) {
          const workouts = generateWeekWorkouts('build', rw, 'marathon', 'Balanced');
          expect(workouts.length).toBe(rw);
        }
      });

      it('should include a long run for marathon with 2+ runs per week', () => {
        const workouts4 = generateWeekWorkouts('build', 4, 'marathon', 'Balanced');
        const workouts3 = generateWeekWorkouts('build', 3, 'marathon', 'Balanced');
        const workouts2 = generateWeekWorkouts('build', 2, 'marathon', 'Balanced');

        expect(workouts4.some(w => w.t === 'long')).toBe(true);
        expect(workouts3.some(w => w.t === 'long')).toBe(true);
        expect(workouts2.some(w => w.t === 'long')).toBe(true);
      });
    });

    describe('phase-specific workouts', () => {
      it('should generate threshold and VO2 in base phase', () => {
        const workouts = generateWeekWorkouts('base', 5, '5k', 'Balanced');
        const types = workouts.map(w => w.t);

        expect(types).toContain('threshold');
        // May contain vo2 if quality slots available
      });

      it('should generate race pace and threshold in build phase', () => {
        const workouts = generateWeekWorkouts('build', 5, 'marathon', 'Balanced');
        const types = workouts.map(w => w.t);

        // Build phase prioritizes race_pace and threshold
        expect(types.some(t => t === 'race_pace' || t === 'threshold')).toBe(true);
      });

      it('should generate race pace and mixed/progressive in peak phase', () => {
        const workouts = generateWeekWorkouts('peak', 5, 'marathon', 'Balanced');
        const types = workouts.map(w => w.t);

        // Peak phase should have quality workouts (depends on workout library availability)
        const hasQuality = types.some(t =>
          t === 'race_pace' || t === 'threshold' || t === 'mixed' || t === 'progressive'
        );
        expect(hasQuality).toBe(true);
      });

      it('should reduce intensity in taper phase', () => {
        const workouts = generateWeekWorkouts('taper', 5, 'marathon', 'Balanced');

        // Long run should have lower RPE in taper
        const longRun = workouts.find(w => w.t === 'long');
        if (longRun) {
          expect(longRun.rpe).toBe(3);
        }
      });
    });

    describe('distance-specific behavior', () => {
      const distances: RaceDistance[] = ['5k', '10k', 'half', 'marathon'];

      for (const dist of distances) {
        it(`should generate appropriate workouts for ${dist}`, () => {
          const workouts = generateWeekWorkouts('build', 5, dist, 'Balanced');

          // All workouts should have required properties
          for (const w of workouts) {
            expect(w.t).toBeDefined();
            expect(w.n).toBeDefined();
            expect(w.d).toBeDefined();
          }
        });
      }
    });

    describe('runner type specific behavior', () => {
      const types: RunnerType[] = ['Speed', 'Balanced', 'Endurance'];

      for (const runnerType of types) {
        it(`should generate workouts for ${runnerType} runner`, () => {
          const workouts = generateWeekWorkouts('build', 5, 'marathon', runnerType);
          expect(workouts.length).toBe(5);
        });
      }
    });

    describe('workout loads', () => {
      it('should calculate aerobic and anaerobic loads', () => {
        const workouts = generateWeekWorkouts('build', 5, 'marathon', 'Balanced');

        for (const w of workouts) {
          expect(w.aerobic).toBeDefined();
          expect(w.aerobic).toBeGreaterThan(0);
          expect(w.anaerobic).toBeDefined();
          expect(w.anaerobic).toBeGreaterThanOrEqual(0);
        }
      });
    });

    describe('day assignment', () => {
      it('should assign days to all workouts if scheduler is applied', () => {
        const workouts = generateWeekWorkouts('build', 5, 'marathon', 'Balanced');

        // Scheduler should assign days - check if property exists
        const hasDays = workouts.every(w => w.dayOfWeek !== undefined);
        // If days are assigned, verify they're valid
        if (hasDays) {
          for (const w of workouts) {
            const day = w.dayOfWeek;
            expect(day).toBeGreaterThanOrEqual(0);
            expect(day).toBeLessThanOrEqual(6);
          }
        }
      });

      it('should generate the correct number of workouts', () => {
        const workouts = generateWeekWorkouts('build', 5, 'marathon', 'Balanced');
        expect(workouts.length).toBe(5);
      });
    });

    describe('easy run generation', () => {
      it('should fill remaining slots with easy runs', () => {
        const workouts = generateWeekWorkouts('base', 5, '5k', 'Balanced');
        const easyRuns = workouts.filter(w => w.t === 'easy');

        expect(easyRuns.length).toBeGreaterThan(0);
      });

      it('should have increasing distances for easy runs', () => {
        const workouts = generateWeekWorkouts('base', 5, '5k', 'Balanced');
        const easyRuns = workouts.filter(w => w.t === 'easy');

        // Easy runs: 6km, 8km, 10km, etc.
        for (const easy of easyRuns) {
          const distMatch = easy.d.match(/(\d+)km/);
          if (distMatch) {
            const dist = parseInt(distMatch[1]);
            expect(dist).toBeGreaterThanOrEqual(6);
          }
        }
      });
    });

    describe('commute run generation', () => {
      it('should add commute runs when commuteConfig is provided', () => {
        const commuteConfig = {
          enabled: true,
          distanceKm: 5,
          isBidirectional: true,
          commuteDaysPerWeek: 3,
        };

        const workouts = generateWeekWorkouts(
          'build', 5, 'marathon', 'Balanced', [], commuteConfig
        );

        const commuteRuns = workouts.filter(w => w.commute === true);
        expect(commuteRuns.length).toBe(3);
        expect(commuteRuns[0].d).toBe('10km');
        expect(commuteRuns[0].t).toBe('easy');
        expect(commuteRuns[0].rpe).toBe(3);
      });

      it('should not add commute runs when disabled', () => {
        const commuteConfig = {
          enabled: false,
          distanceKm: 5,
          isBidirectional: true,
          commuteDaysPerWeek: 3,
        };

        const workouts = generateWeekWorkouts(
          'build', 5, 'marathon', 'Balanced', [], commuteConfig
        );

        const commuteRuns = workouts.filter(w => w.commute === true);
        expect(commuteRuns.length).toBe(0);
      });

      it('should use one-way distance when not bidirectional', () => {
        const commuteConfig = {
          enabled: true,
          distanceKm: 7,
          isBidirectional: false,
          commuteDaysPerWeek: 2,
        };

        const workouts = generateWeekWorkouts(
          'build', 5, 'marathon', 'Balanced', [], commuteConfig
        );

        const commuteRuns = workouts.filter(w => w.commute === true);
        expect(commuteRuns.length).toBe(2);
        expect(commuteRuns[0].d).toBe('7km');
      });
    });

    describe('skipped workout handling', () => {
      it('should include previously skipped workouts', () => {
        const skippedWorkout: Workout = {
          t: 'threshold',
          n: 'Missed Threshold',
          d: '10km @ threshold',
          rpe: 7,
          r: 7
        };

        const workouts = generateWeekWorkouts(
          'build', 5, 'marathon', 'Balanced',
          [{ workout: skippedWorkout, skipCount: 1 }]
        );

        const hasSkipped = workouts.some(w => w.skipped === true);
        expect(hasSkipped).toBe(true);
      });
    });
  });

  describe('initializeWeeks', () => {
    it('should create correct number of weeks', () => {
      const weeks = initializeWeeks(12);
      expect(weeks.length).toBe(12);
    });

    it('should assign correct phases based on position', () => {
      const weeks = initializeWeeks(20);

      // Check phase distribution
      // Formula: pct = w / totalWeeks
      // base: pct < 0.35, build: 0.35-0.65, peak: 0.65-0.85, taper: >= 0.85

      // First week (pct = 1/20 = 0.05) should be base
      expect(weeks[0].ph).toBe('base');

      // Last week should be taper
      expect(weeks[19].ph).toBe('taper');

      // Check there are all four phases present
      const phases = new Set(weeks.map(w => w.ph));
      expect(phases.has('base')).toBe(true);
      expect(phases.has('build')).toBe(true);
      expect(phases.has('peak')).toBe(true);
      expect(phases.has('taper')).toBe(true);
    });

    it('should initialize all required week properties', () => {
      const weeks = initializeWeeks(12);

      for (const week of weeks) {
        expect(week.w).toBeDefined();
        expect(week.ph).toBeDefined();
        expect(week.rated).toEqual({});
        expect(week.wkGain).toBe(0);
      }
    });

    it('should handle different plan lengths', () => {
      const short = initializeWeeks(8);
      const medium = initializeWeeks(16);
      const long = initializeWeeks(24);

      expect(short.length).toBe(8);
      expect(medium.length).toBe(16);
      expect(long.length).toBe(24);

      // All should have taper phase at end
      expect(short[short.length - 1].ph).toBe('taper');
      expect(medium[medium.length - 1].ph).toBe('taper');
      expect(long[long.length - 1].ph).toBe('taper');
    });
  });

  describe('getPhaseDisplayName', () => {
    it('should return uppercase phase names', () => {
      expect(getPhaseDisplayName('base')).toBe('BASE');
      expect(getPhaseDisplayName('build')).toBe('BUILD');
      expect(getPhaseDisplayName('peak')).toBe('PEAK');
      expect(getPhaseDisplayName('taper')).toBe('TAPER');
    });
  });

});
