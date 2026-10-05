/**
 * trimp.ts
 * ========
 * Individual TRIMP (iTRIMP). Banister/Morton model using Heart Rate Reserve fraction.
 *
 * Formula per sample i:
 *   HRR_i = (HR_i - HR_rest) / (HR_max - HR_rest)
 *   TRIMP += Δt_sec × HRR_i × e^(β × HRR_i)
 *
 * β = 1.92 (male or unknown. Conservative default)
 * β = 1.67 (female)
 *
 * Three calculation tiers (highest accuracy first):
 *   1. calculateITrimp. 1-second HR stream (primary)
 *   2. calculateITrimpFromLaps. Per-lap avgHR + duration (fallback)
 *   3. calculateITrimpFromSummary. Single avgHR + total duration (last resort)
 */

/** Sex for β coefficient selection */
export type BiologicalSex = 'male' | 'female';

/**
 * Banister β for the athlete's sex: 1.67 female, 1.92 for male, unknown or
 * 'prefer_not_to_say'. The single source for β. Every iTRIMP producer uses it,
 * and so does the iTRIMP→TSS normaliser (fitness-model.ts
 * computeAthleteNormalizer). With a personal normaliser, and sex resolved the
 * same way on both sides (resolveBiologicalSex below), 1 hour at LTHR decodes
 * to 100 TSS for either sex. Two exceptions: the 15000 population fallback is
 * sex-neutral, and server rows cached before the athlete's sex was known keep
 * the β 1.92 they were stamped with.
 */
export function getBeta(sex?: BiologicalSex | 'prefer_not_to_say' | null): number {
  return sex === 'female' ? 1.67 : 1.92;
}

/** The state fields the sex resolver reads. A SimulatorState satisfies it. */
export interface BiologicalSexSource {
  biologicalSex?: BiologicalSex | 'prefer_not_to_say' | null;
  hasCompletedOnboarding?: boolean;
  onboarding?: { biologicalSex?: BiologicalSex | 'prefer_not_to_say' | null } | null;
}

/**
 * The athlete's sex for β, resolved ONE way for both sides of the iTRIMP→TSS
 * conversion: every iTRIMP producer (the Strava edge-function payload, Apple
 * Health, FIT and screenshot import, the activity matcher) and the normaliser
 * (fitness-model.ts getNormalizerFromState) call this. If they resolve sex
 * differently, an iTRIMP stamped with one β is decoded with the other and
 * reads e^(±0.25·hrr), about 0.81× or 1.23×.
 *
 * During the onboarding wizard the user's answer lives only on
 * s.onboarding.biologicalSex (about-you and the Strava prefill write it there).
 * Plan initialisation copies it to s.biologicalSex, and it wins there whenever
 * it is set (initialization*.ts). So while the wizard is in progress the
 * wizard answer is the value s.biologicalSex is about to take, and it is used
 * first. That keeps onboarding-stamped iTRIMP (the review-step Strava backfill,
 * the post-connect sync) on the same β the normaliser uses after the plan is
 * built. Once onboarding is complete s.biologicalSex is canonical, with the
 * wizard answer as a fallback when it is unset.
 */
export function resolveBiologicalSex(s: BiologicalSexSource): BiologicalSex | 'prefer_not_to_say' | undefined {
  const wizardAnswer = s.onboarding?.biologicalSex ?? undefined;
  if (s.hasCompletedOnboarding !== true && wizardAnswer) return wizardAnswer;
  return s.biologicalSex ?? wizardAnswer;
}

/** resolveBiologicalSex narrowed to the producers' β argument ('prefer_not_to_say' → undefined → 1.92). */
export function resolveTrimpSex(s: BiologicalSexSource): BiologicalSex | undefined {
  const sex = resolveBiologicalSex(s);
  return sex === 'male' || sex === 'female' ? sex : undefined;
}

/**
 * Primary: compute iTRIMP from parallel HR and time arrays.
 *
 * @param hrSamples   Heart rate values (bpm), same length as timeSamples
 * @param timeSamples Elapsed seconds from activity start, same length as hrSamples
 * @param restingHR   Resting heart rate (bpm)
 * @param maxHR       Maximum heart rate (bpm)
 * @param sex         Biological sex. Determines β coefficient
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
 * @param sex         Biological sex. Determines β coefficient
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
 * @param sex         Biological sex. Determines β coefficient
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
