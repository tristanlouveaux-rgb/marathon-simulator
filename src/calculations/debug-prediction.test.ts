import { describe, it, expect } from 'vitest';
import { cv, rd, tv } from './vdot';
import { calculateFatigueExponent, getAbilityBand, gt } from './fatigue';
import { blendPredictions, calculateForecast } from './predictions';
import { applyTrainingHorizonAdjustment } from './training-horizon';

function fmt(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${m.toString().padStart(2,'0')}:${sec.toString().padStart(2,'0')}` : `${m}:${sec.toString().padStart(2,'0')}`;
}

describe('Prediction bug trace — 19:00 5k, HM, intermediate', () => {
  const pbs = { k5: 1140 };
  const b = calculateFatigueExponent(pbs);

  const blendedTime = blendPredictions(21097, pbs, null, null, b, gt(b), null)!;
  const baselineVdot = cv(21097, blendedTime);
  const state30 = { planDurationWeeks: 30, raceDistance: 'half' as const, experienceLevel: 'intermediate', pbs, runsPerWeek: 4 } as any;

  it('4 vs 5 runs at 30 weeks should produce different forecasts', () => {
    const f4 = calculateForecast(baselineVdot, 4, state30, 'Balanced');
    const f5 = calculateForecast(baselineVdot, 5, state30, 'Balanced');
    console.log('30wk 4runs:', f4.forecastVdot.toFixed(2), fmt(f4.forecastTime));
    console.log('30wk 5runs:', f5.forecastVdot.toFixed(2), fmt(f5.forecastTime));
    expect(f5.forecastTime).toBeLessThan(f4.forecastTime);
  });

  it('30 weeks should be faster than 8 weeks (same runs)', () => {
    const f30 = calculateForecast(baselineVdot, 4, state30, 'Balanced');
    const state8 = { ...state30, planDurationWeeks: 8 };
    const f8 = calculateForecast(baselineVdot, 4, state8, 'Balanced');
    console.log('30wk:', f30.forecastVdot.toFixed(2), fmt(f30.forecastTime));
    console.log(' 8wk:', f8.forecastVdot.toFixed(2), fmt(f8.forecastTime));
    expect(f30.forecastTime).toBeLessThan(f8.forecastTime);
  });

  it('cross-training should improve the forecast', () => {
    const f4 = calculateForecast(baselineVdot, 4, state30, 'Balanced');
    // 4 runs + ~1.4 effective cross-training sessions (e.g. 2x rugby)
    const f5_4 = calculateForecast(baselineVdot, 5.4, state30, 'Balanced');
    console.log('4 sessions:', f4.forecastVdot.toFixed(2), fmt(f4.forecastTime));
    console.log('5.4 sessions:', f5_4.forecastVdot.toFixed(2), fmt(f5_4.forecastTime));
    expect(f5_4.forecastTime).toBeLessThan(f4.forecastTime);
  });

  it('guardrails still cap unrealistic jumps for low-VDOT runners', () => {
    // A novice runner with VDOT 38 should still be capped for sub-1:30 (VDOT 53.5)
    const noviceState = { ...state30, experienceLevel: 'novice' };
    const f = calculateForecast(38, 5, noviceState, 'Balanced');
    // Should not reach VDOT 53.5+ (sub-1:30 territory)
    expect(f.forecastVdot).toBeLessThan(53.5);
  });
});
