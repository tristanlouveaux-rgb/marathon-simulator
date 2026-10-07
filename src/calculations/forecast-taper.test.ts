import { describe, it, expect } from 'vitest';
import { planTaperWeeks } from '@/workouts/race-week-layout';
import { initializeWeeks } from '@/workouts/generator';
import { applyTrainingHorizonAdjustment } from './training-horizon';
import { calculateLiveForecast } from './predictions';
import { TAPER_NOMINAL, TRAINING_HORIZON_PARAMS } from '@/constants/training-params';
import type { Week } from '@/types';

/**
 * The forecast's taper is the plan's taper (M4 design v4, 7.1; Q11 default):
 * one helper (planTaperWeeks) feeds every forecast taper input, and a 2-week
 * marathon taper, what every marathon plan of 8+ weeks and every marathon
 * block of 2+ weeks now builds, earns the full taper bonus.
 */

const closing = (wks: Week[]): Week[] => [
  ...wks,
  { w: wks.length + 1, ph: 'taper', raceClosing: true, rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0 } as Week,
];

describe('planTaperWeeks', () => {
  it('reads the trailing taper weeks of the plan', () => {
    expect(planTaperWeeks({ tw: 16, rd: 'marathon', wks: initializeWeeks(16, { raceDistance: 'marathon' }) })).toBe(2);
    expect(planTaperWeeks({ tw: 8, rd: 'marathon', wks: initializeWeeks(8, { raceDistance: 'marathon' }) })).toBe(2);
    expect(planTaperWeeks({ tw: 6, rd: 'marathon', wks: initializeWeeks(6, { raceDistance: 'marathon' }) })).toBe(2);
    expect(planTaperWeeks({ tw: 6, rd: 'half', wks: initializeWeeks(6, { raceDistance: 'half' }) })).toBe(1);
    expect(planTaperWeeks({ tw: 20, rd: 'half', wks: initializeWeeks(20, { raceDistance: 'half' }) })).toBe(3);
  });

  it('a closing week does not lengthen the taper', () => {
    const wks = closing(initializeWeeks(6, { raceDistance: 'marathon' }));
    expect(planTaperWeeks({ tw: 7, rd: 'marathon', wks })).toBe(2);
  });

  it('before the weeks exist: the split initializeWeeks will build', () => {
    expect(planTaperWeeks({ tw: 1, rd: 'marathon' })).toBe(1);
    expect(planTaperWeeks({ tw: 12, rd: 'marathon' })).toBe(2);
    expect(planTaperWeeks({ tw: 4, rd: 'half' })).toBe(1);
  });

  it('no race taper: continuous, triathlon, HYROX, no distance', () => {
    expect(planTaperWeeks({ tw: 16, rd: 'half', continuousMode: true })).toBeUndefined();
    expect(planTaperWeeks({ tw: 16, rd: 'marathon', eventType: 'triathlon' })).toBeUndefined();
    expect(planTaperWeeks({ tw: 16, rd: 'marathon', eventType: 'hyrox' })).toBeUndefined();
    expect(planTaperWeeks({ tw: 16 })).toBeUndefined();
  });
});

describe('a 2-week marathon taper counts as a full taper (Bosquet et al. 2007, 8 to 14 days)', () => {
  it('TAPER_NOMINAL marathon is 2 (was 3)', () => {
    expect(TAPER_NOMINAL.marathon).toBe(2);
  });

  it('the horizon model gives a 2-week marathon taper the full taper bonus', () => {
    const h = applyTrainingHorizonAdjustment({
      baseline_vdot: 45, target_distance: 'marathon', weeks_remaining: 12, sessions_per_week: 4,
      runner_type: 'Balanced', ability_band: 'intermediate', taper_weeks: 2, experience_level: 'intermediate',
    });
    expect(h.components.taper_bonus).toBeCloseTo(TRAINING_HORIZON_PARAMS.taper_bonus_pct.marathon, 9);
  });

  it('calculateLiveForecast reads the plan taper it is given', () => {
    const base = {
      currentVdot: 45, targetDistance: 'half' as const, weeksRemaining: 6, sessionsPerWeek: 4,
      runnerType: 'Balanced' as const, experienceLevel: 'intermediate',
    };
    // A 6-week half tapers 1 week: half the nominal 2-week bonus, one more build week.
    const planTaper = calculateLiveForecast({ ...base, taperWeeks: 1 }).forecastVdot;
    const nominal = calculateLiveForecast(base).forecastVdot;
    expect(planTaper).not.toBe(nominal);
  });
});
