/**
 * Cross-training → forecast/prediction effects.
 *
 * Two distinct, defensible mechanisms (see SCIENCE_LOG §BX):
 *   1. crossTrainingPredictionCredit — current-fitness penalty offset. Softens
 *      the low-running-volume discount for SUB-MARATHON races only. Reflects the
 *      real `lowVolumeDiscount` delta, so the recognition copy never lies.
 *   2. CROSS_TRAINED_FORECAST_PREMIUM — adaptation-rate premium on exp_factor.
 *      An existing aerobic engine converts to run performance faster. Reuses the
 *      legacy `hybrid` premium (1.10); never stacks on a 'hybrid' experience level.
 */
import { describe, it, expect } from 'vitest';
import { crossTrainingPredictionCredit } from './predictions';
import { applyTrainingHorizonAdjustment, CROSS_TRAINED_FORECAST_PREMIUM } from './training-horizon';
import type { TrainingHorizonInput } from '@/types/training';

const M_5K = 5000, M_10K = 10000, M_HALF = 21097, M_MARA = 42195;

describe('crossTrainingPredictionCredit (current-fitness penalty offset)', () => {
  it('returns 0 when there is no cross-training', () => {
    expect(crossTrainingPredictionCredit(M_10K, 12, 0)).toBe(0);
    expect(crossTrainingPredictionCredit(M_10K, 12, undefined)).toBe(0);
  });

  it('returns 0 when running volume is high enough that no discount fires', () => {
    // >= 30 km/wk → severity 0, nothing to offset.
    expect(crossTrainingPredictionCredit(M_10K, 35, 3)).toBe(0);
  });

  it('is always 0 for the marathon (long-run endurance does not transfer)', () => {
    expect(crossTrainingPredictionCredit(M_MARA, 8, 3)).toBe(0);
    expect(crossTrainingPredictionCredit(M_MARA, 8, 10)).toBe(0);
  });

  it('gives a positive credit to a low-mileage sub-marathon runner who cross-trains', () => {
    const credit = crossTrainingPredictionCredit(M_HALF, 8, 3);
    expect(credit).toBeGreaterThan(0);
  });

  it('benefit peaks at the half and is smallest at 5K (distSensitivity ordering)', () => {
    const c5 = crossTrainingPredictionCredit(M_5K, 8, 3);
    const c10 = crossTrainingPredictionCredit(M_10K, 8, 3);
    const cHalf = crossTrainingPredictionCredit(M_HALF, 8, 3);
    expect(c5).toBeGreaterThan(0);
    expect(c10).toBeGreaterThan(c5);
    expect(cHalf).toBeGreaterThan(c10);
  });

  it('more cross-training gives more credit, up to the 60% cap', () => {
    const one = crossTrainingPredictionCredit(M_HALF, 8, 1);
    const three = crossTrainingPredictionCredit(M_HALF, 8, 3);
    const ten = crossTrainingPredictionCredit(M_HALF, 8, 10);
    expect(three).toBeGreaterThan(one);
    // Saturates at 3 sessions (full maintenance) — 10 must not exceed 3.
    expect(ten).toBeCloseTo(three, 6);
  });
});

describe('CROSS_TRAINED_FORECAST_PREMIUM (adaptation-rate premium)', () => {
  const base: TrainingHorizonInput = {
    baseline_vdot: 45,
    target_distance: 'half',
    weeks_remaining: 16,
    sessions_per_week: 4,
    runner_type: 'Balanced',
    ability_band: 'intermediate',
    taper_weeks: 2,
    weekly_volume_km: 40,
  };

  it('reuses the legacy hybrid premium (1.10), not a new number', () => {
    expect(CROSS_TRAINED_FORECAST_PREMIUM).toBe(1.10);
  });

  it('a cross-trained athlete gains more than the same athlete without it', () => {
    const plain = applyTrainingHorizonAdjustment({ ...base, experience_level: 'beginner' });
    const cross = applyTrainingHorizonAdjustment({ ...base, experience_level: 'beginner', cross_trained: true });
    expect(cross.vdot_gain).toBeGreaterThan(plain.vdot_gain);
  });

  it('cross-trained lifts the gain but stays below the raw 1.10 (additive taper/strength terms dilute the multiplier)', () => {
    const plain = applyTrainingHorizonAdjustment({ ...base, experience_level: 'beginner' });
    const cross = applyTrainingHorizonAdjustment({ ...base, experience_level: 'beginner', cross_trained: true });
    const ratio = cross.vdot_gain / plain.vdot_gain;
    // exp_factor scales only the base gain term; taper_bonus and strength_gain
    // are added afterwards and are not premium-scaled, so the realised ratio
    // sits in (1.0, 1.10]. It must be a real lift but never exceed the premium.
    expect(ratio).toBeGreaterThan(1.0);
    expect(ratio).toBeLessThanOrEqual(1.10 + 1e-9);
  });

  it('does NOT stack on a legacy hybrid experience level (already encodes 1.10)', () => {
    const hybridOnly = applyTrainingHorizonAdjustment({ ...base, experience_level: 'hybrid' });
    const hybridPlusFlag = applyTrainingHorizonAdjustment({ ...base, experience_level: 'hybrid', cross_trained: true });
    expect(hybridPlusFlag.vdot_gain).toBeCloseTo(hybridOnly.vdot_gain, 6);
  });

  it('is inert when the flag is absent (no behaviour change for non-cross-trained)', () => {
    const a = applyTrainingHorizonAdjustment({ ...base, experience_level: 'intermediate' });
    const b = applyTrainingHorizonAdjustment({ ...base, experience_level: 'intermediate', cross_trained: false });
    expect(a.vdot_gain).toBe(b.vdot_gain);
  });
});
