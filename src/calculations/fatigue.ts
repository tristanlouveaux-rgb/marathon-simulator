import type { PBs, RunnerType, AbilityBand } from '@/types';

/**
 * Calculate fatigue exponent (b) from personal bests
 * Uses linear regression on log-transformed data
 * @param pbs - Personal bests object
 * @returns Fatigue exponent (b)
 */
export function calculateFatigueExponent(pbs: PBs): number {
  const lnD: number[] = [];
  const lnT: number[] = [];

  if (pbs.k5) { lnD.push(Math.log(5000)); lnT.push(Math.log(pbs.k5)); }
  if (pbs.k10) { lnD.push(Math.log(10000)); lnT.push(Math.log(pbs.k10)); }
  if (pbs.h) { lnD.push(Math.log(21097)); lnT.push(Math.log(pbs.h)); }
  if (pbs.m) { lnD.push(Math.log(42195)); lnT.push(Math.log(pbs.m)); }

  if (lnD.length < 2) return 1.06;

  const meanLnD = lnD.reduce((a, b) => a + b, 0) / lnD.length;
  const meanLnT = lnT.reduce((a, b) => a + b, 0) / lnT.length;

  let num = 0, den = 0;
  for (let i = 0; i < lnD.length; i++) {
    num += (lnD[i] - meanLnD) * (lnT[i] - meanLnT);
    den += Math.pow(lnD[i] - meanLnD, 2);
  }

  if (den === 0) return 1.06; // Identical distances — can't compute slope
  return num / den;
}

/**
 * Legacy alias for calculateFatigueExponent — now delegates to the canonical version
 * @param p - Personal bests object
 * @returns Fatigue exponent (b)
 */
export function cb(p: PBs): number {
  return calculateFatigueExponent(p);
}

/**
 * Get runner type from fatigue exponent
 * @param b - Fatigue exponent
 * @returns Runner type string
 */
export function getRunnerType(b: number): RunnerType {
  if (!b || isNaN(b)) return 'Balanced';
  if (b < 1.06) return 'Speed';
  if (b > 1.12) return 'Endurance';
  return 'Balanced';
}

/**
 * Legacy version - get runner type as lowercase string
 * Delegates to getRunnerType for consistent thresholds.
 * @param b - Fatigue exponent
 * @returns Runner type string (lowercase)
 */
export function gt(b: number): string {
  return getRunnerType(b).toLowerCase();
}

/**
 * Get ability band from VDOT
 * @param vdot - VDOT value
 * @returns Ability band
 */
export function getAbilityBand(vdot: number): AbilityBand {
  if (vdot >= 60) return 'elite';
  if (vdot >= 52) return 'advanced';
  if (vdot >= 45) return 'intermediate';
  if (vdot >= 38) return 'novice';
  return 'beginner';
}

/**
 * Infer athlete level from VDOT (for expected gains)
 * Uses the same VDOT thresholds as getAbilityBand for consistency.
 * @param vdot - VDOT value
 * @returns Level string
 */
export function inferLevel(vdot: number): string {
  if (vdot >= 60) return 'elite';
  if (vdot >= 52) return 'advanced';
  if (vdot >= 45) return 'intermediate';
  return 'novice';
}
