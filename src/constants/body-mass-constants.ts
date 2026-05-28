/**
 * Body-mass adaptation constants — drive two athlete-size adjustments:
 *   1. Cross-training swap: heavier runners substitute a fraction of easy
 *      running volume with low-impact aerobic work to manage cumulative joint
 *      and connective-tissue load.
 *   2. Heat personalisation: larger athletes store heat faster (lower body
 *      surface-area-to-mass ratio), so their hot-day HR-drift analysis and
 *      race climate penalty are scaled by a body-size strain ratio.
 *
 * Full rationale + derivations in `docs/SCIENCE_LOG.md` §AL.
 *
 * **Side of the line**: the swap is PLANNING (prescribes less running). The
 * heat ratio is TRACKING (it re-attributes measured drift and adjusts a
 * race-time prediction). Both are pure functions of anthropometrics.
 *
 * Both adjustments are inert unless the user has entered the relevant field —
 * the swap needs body weight, the heat ratio needs weight AND height. No field
 * → no adjustment → current behaviour exactly.
 */

// ───────────────────────────────────────────────────────────────────────────
// Reference anthropometrics — TWO references, deliberately different.
//
// SWAP reference (when to flag a runner as "heavy"): the GENERAL-POPULATION
// adult average, NOT a runner average. Anchoring on lean-runner weight (75 kg)
// flagged perfectly normal people as heavy; the general public is meaningfully
// heavier, so this only surfaces the swap for people who are large by ordinary
// standards. ~85 kg (M) / ~72 kg (W) ≈ developed-world average (Walpole et al.
// 2012 "The weight of nations" BMC Public Health; Health Survey for England).
// Note this average sits in the overweight BMI band, which is intended: the
// adjustment is for the genuinely large, not the merely-not-a-marathoner.
//
// HEAT reference (the build at which the climate penalty is exactly right):
// stays at marathon-finisher weight (~75/62), because CLIMATE_RUN_MULTIPLIER
// was calibrated on marathon fields (leaner than the public — Ely 2007, El
// Helou 2012). Using the general-pop anchor here would systematically under-
// penalise typical runners for heat. Heights anchor the reference BSA only.
// Confidence: medium (population means; individual frames vary).
// ───────────────────────────────────────────────────────────────────────────

/** General-population average — anchors the cross-training swap (when to flag). */
export const SWAP_REF_BODY_MASS_KG = { male: 85, female: 72 } as const;

/** Marathon-finisher calibration anchor — used by the heat BSA ratio only. */
export const REF_BODY_MASS_KG = { male: 75, female: 62 } as const;
export const REF_HEIGHT_CM = { male: 178, female: 165 } as const;

// ───────────────────────────────────────────────────────────────────────────
// Cross-training swap
// Principle: peak vertical ground reaction force in running is a near-constant
// multiple of bodyweight (~2.5–2.8× BW), so cumulative joint / connective-
// tissue load per km scales ~linearly with body mass. To hold a heavier
// runner's cumulative impact load near the reference-mass level WITHOUT cutting
// aerobic stimulus, substitute a fraction of easy running with low-impact
// aerobic work (bike / swim / elliptical), which carries near-equivalent
// aerobic load at a fraction of the impact load.
//
// Swap fraction = 1 − swapRefMass/mass, capped. The general-population
// reference + a low cap keep it gentle by construction: it only fires above
// the population average and tops out modestly. Cap 0.15 → a 100 kg man tops
// out at 15% (vs 26% under the old runner-anchored 0.30 cap).
//
// It is OPT-IN: a one-time onboarding popup explains it and lets the user turn
// it off (state `bodyMassSwapEnabled`; default-on for heavy users until they
// decide). After that the app's normal live adaptation (HR/pace → effort,
// VDOT, ramp) evolves the plan — no weight logic fights it, no auto-retire.
//
// Sources:
//   - Nilsson J & Thorstensson A (1989) "Ground reaction forces at different
//     speeds of human walking and running" Acta Physiol Scand 136:217–227 —
//     peak vertical GRF ≈ 2.5–2.8× BW across running speeds.
//   - di Prampero PE (1986) "The energy cost of human locomotion on land and
//     in water" Int J Sports Med 7:55–72 — cost of running ≈ constant per kg.
//   - Foster C et al. (1995) / Mutton DL et al. (1993) — aerobic fitness is
//     largely maintained when ≤~30–50% of run volume is replaced by cycling.
// Confidence: medium. GRF→injury is confounded and non-linear; this is framed
// as cumulative joint-load management, not stress-fracture prevention.
// ───────────────────────────────────────────────────────────────────────────

/** Maximum share of easy running volume that may be swapped to cross-training.
 *  Gentle coaching ceiling, set by Tristan (2026-05-26). Reached at 100 kg (male). */
export const CROSS_TRAINING_SWAP_CAP = 0.15;

/**
 * Engagement floor — the swap and the opt-in popup do NOTHING below this weight,
 * even though the curve (anchored at the population average above) would compute
 * a small trim. This is deliberate: being a few kg above average is not "heavy",
 * and an 88 kg man should never be flagged. Set by Tristan (2026-05-26) after an
 * 88 kg test user (only 3 kg above the 85 kg average) saw the popup.
 *
 * Because the trim is measured from the 85/72 average but only ENGAGES at 95/80,
 * it engages already-meaningful (~10%), not at a trivial 1-2% — no tiny-trim-near-
 * threshold. At/above the floor: trim = clamp(1 − swapRef/mass, 0, 0.15).
 */
export const SWAP_ENGAGE_MIN_KG = { male: 95, female: 80 } as const;

// ───────────────────────────────────────────────────────────────────────────
// Heat personalisation
// Principle: metabolic heat production scales ~with mass; dry + evaporative
// heat dissipation scales with body surface area (BSA). Heat strain at a given
// ambient temperature scales with the mass-to-BSA ratio. Larger athlete →
// higher mass/BSA → more strain. A small athlete (<ref) → ratio < 1 → less.
//
// BSA via Du Bois & Du Bois (1916):
//   BSA(m²) = 0.007184 × weight(kg)^0.425 × height(cm)^0.725
//
// heatStrainRatio = (mass/BSA) / (refMass/refBSA), clamped to a sane band so a
// single outlier measurement can't produce an extreme correction. The ratio
// is a physical quantity (no invented exponent); the clamp is the only knob.
//
// Sources:
//   - Du Bois D & Du Bois EF (1916) Arch Intern Med 17:863–871 — BSA formula.
//   - Cramer MN et al. (2023) "Relation of body surface area-to-mass ratio to
//     risk of exertional heat stroke" J Appl Physiol 135:1265–1274 — larger
//     mass-to-BSA raises thermoregulatory strain.
//   - Marino FE et al. (2000) Pflugers Arch 441:359–367 — larger runners
//     accumulate ~0.5–1.0 °C more core-temp rise in warm conditions.
// Confidence: high for the direction and the BSA scaling; medium for the linear
// application to the existing categorical climate multipliers.
// ───────────────────────────────────────────────────────────────────────────

/** Du Bois BSA coefficients. */
export const DU_BOIS = { k: 0.007184, wExp: 0.425, hExp: 0.725 } as const;

/** Clamp band for heatStrainRatio. Keeps corrections within ±15–25%. */
export const HEAT_STRAIN_RATIO_MIN = 0.85;
export const HEAT_STRAIN_RATIO_MAX = 1.25;

// ───────────────────────────────────────────────────────────────────────────
// Plausibility bounds — inputs outside these are treated as "no data" so a
// typo (e.g. weight in lb, height in m) can never drive an adjustment.
// ───────────────────────────────────────────────────────────────────────────

export const PLAUSIBLE_MASS_KG = { min: 30, max: 250 } as const;
export const PLAUSIBLE_HEIGHT_CM = { min: 120, max: 230 } as const;
