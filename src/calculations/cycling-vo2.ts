/**
 * Cycling VO2max — ACSM cycle-ergometry equation.
 *
 *     VO2max ≈ 10.8 × (W / mass_kg) + 7
 *
 * From the ACSM Guidelines for Exercise Testing and Prescription (11th ed.,
 * 2022) — derived from steady-state oxygen-cost data on cycle ergometers,
 * validated across recreational and trained populations. The 10.8 coefficient
 * captures the metabolic cost of leg cycling per W/kg, and the +7
 * constant is the resting+postural baseline.
 *
 * Input W: prefer the user's FTP (functional threshold power, ~95% of 1-h
 * max). FTP underestimates true peak power by ~15–20%, so the equation
 * naturally yields a *cycling-specific* VO2max that's slightly conservative
 * — exactly what we want for the per-discipline display. Hawley & Noakes
 * 1992 (*Eur J Appl Physiol* 65:79–83) validated this conversion path
 * (peak-power → VO2max) in trained cyclists with R² > 0.9.
 *
 * Body weight handling: when `bodyWeightKg` is missing on state we fall back
 * to the same defaults used by the FTP/load engine (75 kg male, 62 kg
 * female). Physiological VO2max scales per-kg, so getting weight wrong by
 * 5 kg shifts the estimate by ~1 ml/kg/min — within the formula's stated
 * precision (~±2 ml/kg/min).
 *
 * Pure — no state dependency.
 */

export type CyclingVO2Confidence = 'high' | 'medium' | 'low' | 'none';

export interface CyclingVO2Input {
  /** Functional Threshold Power in watts. Required. */
  ftpW: number | null | undefined;
  /** Body weight in kg. Falls back to sex default when missing. */
  bodyWeightKg?: number | null;
  /** Biological sex — used for default body weight only. */
  biologicalSex?: 'male' | 'female' | 'prefer_not_to_say' | null;
  /** Confidence tier of the FTP value itself (drives our output confidence). */
  ftpConfidence?: 'high' | 'medium' | 'low' | 'none' | null;
}

export interface CyclingVO2Result {
  /** Cycling VO2max in ml/kg/min, or null if FTP unknown. */
  vo2: number | null;
  confidence: CyclingVO2Confidence;
  /** Body weight (kg) used in the calculation. */
  weightKgUsed: number | null;
  /** True when the body weight was a fallback default rather than user-set. */
  usedDefaultWeight: boolean;
  reason?: 'no-ftp';
}

/** ACSM cycle-ergometry coefficient — VO2max delta per W/kg (ml·kg⁻¹·min⁻¹). */
const ACSM_K = 10.8;
/** ACSM resting + postural baseline (ml·kg⁻¹·min⁻¹). */
const ACSM_BASELINE = 7;
/** Sex-default body weights — same defaults as the FTP/load engine. */
const DEFAULT_WEIGHT_MALE_KG = 75;
const DEFAULT_WEIGHT_FEMALE_KG = 62;

export function computeCyclingVO2(input: CyclingVO2Input): CyclingVO2Result {
  const { ftpW, bodyWeightKg, biologicalSex, ftpConfidence } = input;

  if (!ftpW || ftpW <= 0) {
    return { vo2: null, confidence: 'none', weightKgUsed: null, usedDefaultWeight: false, reason: 'no-ftp' };
  }

  let weightKg: number;
  let usedDefaultWeight = false;
  if (bodyWeightKg && bodyWeightKg > 0) {
    weightKg = bodyWeightKg;
  } else {
    weightKg = biologicalSex === 'female' ? DEFAULT_WEIGHT_FEMALE_KG : DEFAULT_WEIGHT_MALE_KG;
    usedDefaultWeight = true;
  }

  const wPerKg = ftpW / weightKg;
  const vo2 = ACSM_K * wPerKg + ACSM_BASELINE;

  // Inherit confidence from FTP. A default-weight estimate downgrades by one
  // tier (kg error injects ±2 ml/kg/min noise we can't otherwise quantify).
  let confidence: CyclingVO2Confidence = ftpConfidence ?? 'low';
  if (usedDefaultWeight) {
    if (confidence === 'high') confidence = 'medium';
    else if (confidence === 'medium') confidence = 'low';
  }

  return { vo2, confidence, weightKgUsed: weightKg, usedDefaultWeight };
}
