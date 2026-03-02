/**
 * trimp.ts
 * ========
 * Individual TRIMP (iTRIMP) — Banister/Morton model using Heart Rate Reserve fraction.
 *
 * Formula per sample i:
 *   HRR_i = (HR_i - HR_rest) / (HR_max - HR_rest)
 *   TRIMP += Δt_sec × HRR_i × e^(β × HRR_i)
 *
 * β = 1.92 (male or unknown — conservative default)
 * β = 1.67 (female)
 *
 * Three calculation tiers (highest accuracy first):
 *   1. calculateITrimp         — 1-second HR stream (primary)
 *   2. calculateITrimpFromLaps — per-lap avgHR + duration (fallback)
 *   3. calculateITrimpFromSummary — single avgHR + total duration (last resort)
 */

/** Sex for β coefficient selection */
type BiologicalSex = 'male' | 'female';

function getBeta(sex?: BiologicalSex): number {
  return sex === 'female' ? 1.67 : 1.92;
}

/**
 * Primary: compute iTRIMP from parallel HR and time arrays.
 *
 * @param hrSamples   Heart rate values (bpm), same length as timeSamples
 * @param timeSamples Elapsed seconds from activity start, same length as hrSamples
 * @param restingHR   Resting heart rate (bpm)
 * @param maxHR       Maximum heart rate (bpm)
 * @param sex         Biological sex — determines β coefficient
 * @returns iTRIMP value (dimensionless training impulse)
 */
export function calculateITrimp(
  hrSamples: number[],
  timeSamples: number[],
  restingHR: number,
  maxHR: number,
  sex?: BiologicalSex,
): number {
  const beta = getBeta(sex);
  const hrRange = maxHR - restingHR;
  if (hrRange <= 0) return 0;
  if (hrSamples.length !== timeSamples.length || hrSamples.length < 2) return 0;

  let trimp = 0;
  for (let i = 1; i < hrSamples.length; i++) {
    const hr = hrSamples[i];
    if (hr <= restingHR) continue; // HRR ≤ 0 contributes nothing meaningful
    const dt = timeSamples[i] - timeSamples[i - 1];
    if (dt <= 0) continue;
    const hrr = (hr - restingHR) / hrRange;
    trimp += dt * hrr * Math.exp(beta * hrr);
  }
  return trimp;
}

/**
 * Fallback: compute iTRIMP from lap segments.
 * Each lap provides an average HR and a duration in seconds.
 *
 * @param laps        Array of lap data with avgHR (bpm) and durationSec
 * @param restingHR   Resting heart rate (bpm)
 * @param maxHR       Maximum heart rate (bpm)
 * @param sex         Biological sex — determines β coefficient
 * @returns iTRIMP value
 */
export function calculateITrimpFromLaps(
  laps: { avgHR: number; durationSec: number }[],
  restingHR: number,
  maxHR: number,
  sex?: BiologicalSex,
): number {
  const beta = getBeta(sex);
  const hrRange = maxHR - restingHR;
  if (hrRange <= 0) return 0;

  let trimp = 0;
  for (const lap of laps) {
    if (lap.avgHR <= restingHR || lap.durationSec <= 0) continue;
    const hrr = (lap.avgHR - restingHR) / hrRange;
    trimp += lap.durationSec * hrr * Math.exp(beta * hrr);
  }
  return trimp;
}

/**
 * Last resort: compute iTRIMP from a single average HR and total duration.
 *
 * @param avgHR       Average heart rate for the session (bpm)
 * @param durationSec Total session duration in seconds
 * @param restingHR   Resting heart rate (bpm)
 * @param maxHR       Maximum heart rate (bpm)
 * @param sex         Biological sex — determines β coefficient
 * @returns iTRIMP value
 */
export function calculateITrimpFromSummary(
  avgHR: number,
  durationSec: number,
  restingHR: number,
  maxHR: number,
  sex?: BiologicalSex,
): number {
  const beta = getBeta(sex);
  const hrRange = maxHR - restingHR;
  if (hrRange <= 0 || avgHR <= restingHR || durationSec <= 0) return 0;
  const hrr = (avgHR - restingHR) / hrRange;
  return durationSec * hrr * Math.exp(beta * hrr);
}
