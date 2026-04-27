/**
 * Effective VDOT — single source of truth for the VDOT used to derive paces,
 * forecasts, and pace-matched activity detection.
 *
 * Prior to 2026-04-16, effective VDOT was computed as
 *   s.v + sum(wk.wkGain up to current week) + s.rpeAdj + s.physioAdj
 * where s.v was the onboarding baseline and wkGain simulated a linear projected
 * climb toward s.expectedFinal. This was a pre-drawn trajectory, not reality.
 *
 * Now s.v itself is refreshed weekly to the blended race-prediction-derived VDOT
 * (see refreshBlendedFitness). The wkGain accumulator is dropped — s.v already
 * reflects actual current fitness as supported by the last 8 weeks of running.
 * wkGain remains on week state for cosmetic display only.
 *
 * RPE and physio adjustments still layer on top as fine-tuning deltas.
 */

import type { SimulatorState } from '@/types';

export function getEffectiveVdot(s: SimulatorState): number {
  return s.v + (s.rpeAdj ?? 0) + (s.physioAdj ?? 0);
}
