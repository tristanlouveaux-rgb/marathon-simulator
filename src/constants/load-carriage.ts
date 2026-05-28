/**
 * Load-carriage constants and helpers for backpack-weighted running.
 *
 * Scientific anchor
 * -----------------
 * Knapik et al. (Mil Med 2004; meta-review of military load-carriage studies)
 * and follow-on biomechanics work consistently report that:
 *
 *   • Metabolic cost rises roughly linearly with load mass for packs up to
 *     ~30% bodyweight, on the order of +1% VO2 per 1% bodyweight carried.
 *     HR-based iTRIMP captures this naturally (cardiac output rises with the
 *     extra demand), so we do NOT apply a separate metabolic-cost multiplier.
 *
 *   • Ground reaction force scales linearly with total mass (runner + pack).
 *     A 70 kg runner with a 7 kg pack lands with ~10% more peak vertical force
 *     each step than the same runner without a pack. This is the structural-
 *     stress (impact-load) signal that HR cannot see. Signal C, in Mosaic's
 *     three-signal load model.
 *
 *   • The relationship saturates well above the loads typical commuters carry
 *     (5–15 kg). Within that range linear scaling is the defensible model.
 *
 * What this means in code
 * -----------------------
 * For any run tagged as a commute with a backpack mass, the impact-load
 * contribution is multiplied by `loadCarriageImpactCoef(backpackKg, bodyKg)`.
 * Aerobic load (iTRIMP, TSS) is unchanged. HR has already done that job.
 *
 * Limitations (call out honestly)
 * -------------------------------
 *   • Linear scaling oversimplifies pack position (high vs low load), centre
 *     of mass, and pack hardness. We don't model these. They would require
 *     pack-style data the user doesn't have to enter.
 *   • Load carriage gait differences (slower cadence, longer ground contact)
 *     shift force distribution toward the calf/Achilles. We capture the
 *     magnitude bump, not the redistribution.
 *   • Above ~30% bodyweight the linear model breaks down (real military
 *     studies show metabolic and structural cost grow faster). We clamp the
 *     coefficient to 1.5 (50% bodyweight). Anything heavier is outside the
 *     run-to-work use case.
 *
 * References
 * ----------
 *   Knapik JJ, Reynolds KL, Harman E. Soldier load carriage: historical,
 *   physiological, biomechanical, and medical aspects. Mil Med. 2004;169(1):
 *   45-56. doi:10.7205/MILMED.169.1.45
 *
 *   Quesada PM, Mengelkoch LJ, Hale RC, Simon SR. Biomechanical and metabolic
 *   effects of varying backpack loading on simulated marching. Ergonomics.
 *   2000;43(3):293-309. doi:10.1080/001401300184413
 */

/** Sex-specific bodyweight defaults (kg), mirroring `cycling-vo2.ts`. Used
 *  when the user has not entered a weight at onboarding. */
const DEFAULT_BODYWEIGHT_MALE_KG = 75;
const DEFAULT_BODYWEIGHT_FEMALE_KG = 62;

/** Maximum coefficient applied. 1.5 corresponds to a 50%-bodyweight pack,
 *  far above the run-to-work range. Clamp prevents extreme inputs (a wrong-
 *  units entry, a user storing kg in a `g` field) from blowing up impact
 *  load. */
const MAX_LOAD_COEF = 1.5;

/**
 * Resolve the user's bodyweight in kg. Falls back to sex-specific defaults
 * when the user has not entered weight (commute capture doesn't require it).
 */
export function resolveBodyweightKg(
  bodyWeightKg: number | null | undefined,
  biologicalSex: 'male' | 'female' | 'prefer_not_to_say' | null | undefined,
): number {
  if (bodyWeightKg && bodyWeightKg > 0) return bodyWeightKg;
  return biologicalSex === 'female' ? DEFAULT_BODYWEIGHT_FEMALE_KG : DEFAULT_BODYWEIGHT_MALE_KG;
}

/**
 * Coefficient applied to impact load when a run is carried with a backpack.
 *
 * `coef = (bodyweightKg + backpackKg) / bodyweightKg`
 *
 * Equivalent to `1 + (backpackKg / bodyweightKg)`. A 7 kg pack on a 70 kg
 * runner returns 1.10 (10% extra structural stress per kilometre). Clamped
 * to `[1.0, 1.5]`. See file header for rationale.
 *
 * @param backpackKg     Pack mass in kg. 0 or negative returns 1.0 (no-op).
 * @param bodyweightKg   Runner mass in kg. Must be > 0.
 */
export function loadCarriageImpactCoef(backpackKg: number, bodyweightKg: number): number {
  if (!Number.isFinite(backpackKg) || backpackKg <= 0) return 1.0;
  if (!Number.isFinite(bodyweightKg) || bodyweightKg <= 0) return 1.0;
  const raw = 1 + backpackKg / bodyweightKg;
  if (raw < 1.0) return 1.0;
  if (raw > MAX_LOAD_COEF) return MAX_LOAD_COEF;
  return raw;
}
