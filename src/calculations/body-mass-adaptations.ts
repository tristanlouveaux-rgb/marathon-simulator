/**
 * Body-mass adaptations — pure functions of athlete anthropometrics.
 *
 * Two outputs:
 *   - `crossTrainingSwapFraction`: 0..CAP. Share of EASY running volume to
 *     substitute with low-impact cross-training for joint-load management.
 *     (PLANNING side.)
 *   - `heatStrainRatio`: 0.85..1.25. Body-size scalar on heat effects; 1.0 =
 *     the reference build, >1 = stores heat faster. (TRACKING side.)
 *
 * **Safety contract** (load-bearing — tested in body-mass-adaptations.test.ts):
 *   - Swap is exactly 0 with no/invalid weight, or weight ≤ reference mass.
 *   - Heat ratio is exactly 1.0 with no/invalid weight OR no/invalid height.
 *   - Both are clamped, so no input can produce an unbounded effect.
 * These defaults make every downstream call a no-op for users who haven't
 * entered the data, which is the entire safety story for the plan engine and
 * the heatAdjust refactor.
 *
 * Science + derivations: docs/SCIENCE_LOG.md §AL.
 */

import {
  SWAP_REF_BODY_MASS_KG,
  SWAP_ENGAGE_MIN_KG,
  REF_BODY_MASS_KG,
  REF_HEIGHT_CM,
  CROSS_TRAINING_SWAP_CAP,
  DU_BOIS,
  HEAT_STRAIN_RATIO_MIN,
  HEAT_STRAIN_RATIO_MAX,
  PLAUSIBLE_MASS_KG,
  PLAUSIBLE_HEIGHT_CM,
} from '@/constants/body-mass-constants';
import type { SimulatorState } from '@/types/state';

type Sex = 'male' | 'female' | 'prefer_not_to_say' | undefined;

/** Reference sex for defaults. Unset / prefer-not-to-say → male, matching the
 *  app-wide 75 kg default (cycling-vo2.ts, iTRIMP β coefficient). */
function refSex(sex: Sex): 'male' | 'female' {
  return sex === 'female' ? 'female' : 'male';
}

function isPlausibleMass(w: number | null | undefined): w is number {
  return typeof w === 'number' && Number.isFinite(w)
    && w >= PLAUSIBLE_MASS_KG.min && w <= PLAUSIBLE_MASS_KG.max;
}

function isPlausibleHeight(h: number | null | undefined): h is number {
  return typeof h === 'number' && Number.isFinite(h)
    && h >= PLAUSIBLE_HEIGHT_CM.min && h <= PLAUSIBLE_HEIGHT_CM.max;
}

/** Du Bois & Du Bois (1916) body surface area in m². */
export function bodySurfaceAreaM2(weightKg: number, heightCm: number): number {
  return DU_BOIS.k * Math.pow(weightKg, DU_BOIS.wExp) * Math.pow(heightCm, DU_BOIS.hExp);
}

/**
 * Fraction of EASY running volume to swap for low-impact cross-training.
 * Trim magnitude is measured from the population average (SWAP_REF), but the
 * feature only ENGAGES at/above SWAP_ENGAGE_MIN_KG (95 kg M / 80 kg W) so normal-
 * range weights are never flagged:
 *   swap = mass < engageFloor ? 0 : clamp(1 − swapRef/mass, 0, CAP)
 * Returns 0 (no swap, no popup) for missing/implausible weight or any weight
 * below the engagement floor.
 */
export function crossTrainingSwapFraction(weightKg: number | null | undefined, sex: Sex): number {
  if (!isPlausibleMass(weightKg)) return 0;
  const sx = refSex(sex);
  // Engagement floor: nothing happens for normal-range weights (an 88 kg man is
  // not "heavy"). Below the floor → 0, no swap, no popup.
  if (weightKg < SWAP_ENGAGE_MIN_KG[sx]) return 0;
  const raw = 1 - SWAP_REF_BODY_MASS_KG[sx] / weightKg;
  if (!(raw > 0)) return 0;
  return Math.min(CROSS_TRAINING_SWAP_CAP, raw);
}

/**
 * Body-size heat strain scalar. 1.0 = reference build. Returns exactly 1.0 when
 * weight OR height is missing / implausible, so heat-using call sites are
 * unchanged for anyone who hasn't entered both fields.
 */
export function heatStrainRatio(
  weightKg: number | null | undefined,
  heightCm: number | null | undefined,
  sex: Sex,
): number {
  if (!isPlausibleMass(weightKg) || !isPlausibleHeight(heightCm)) return 1.0;
  const s = refSex(sex);
  const bsa = bodySurfaceAreaM2(weightKg, heightCm);
  const refBsa = bodySurfaceAreaM2(REF_BODY_MASS_KG[s], REF_HEIGHT_CM[s]);
  const ratio = (weightKg / bsa) / (REF_BODY_MASS_KG[s] / refBsa);
  return Math.max(HEAT_STRAIN_RATIO_MIN, Math.min(HEAT_STRAIN_RATIO_MAX, ratio));
}

// ── State-reading convenience wrappers ──────────────────────────────────────

type AnthroState = Pick<SimulatorState, 'bodyWeightKg' | 'heightCm' | 'biologicalSex'>;

export function swapFractionForState(s: AnthroState): number {
  return crossTrainingSwapFraction(s.bodyWeightKg, s.biologicalSex);
}

export function heatStrainRatioForState(s: AnthroState): number {
  return heatStrainRatio(s.bodyWeightKg, s.heightCm, s.biologicalSex);
}

/** True when the athlete has entered a weight that puts them above their sex
 *  reference build (i.e. the cross-training swap is active). Drives the
 *  once-only "your plan is built for your size" reveal. */
export function isAboveReferenceMass(s: AnthroState): boolean {
  return swapFractionForState(s) > 0;
}
