/**
 * Effort Feedback Engine — "Truth Checks"
 *
 * Compares actual RPE and HR against target zones to detect
 * mismatches and provide coaching feedback.
 */

import type { HRZones, HRTarget } from '@/calculations/heart-rate';

/** Feedback result */
export interface EffortFeedback {
  type: 'perfect' | 'warning' | 'mismatch';
  message: string;
}

/**
 * Determine which zone an actual HR falls into (1-5).
 */
function getActualZone(hr: number, zones: HRZones): number {
  if (hr <= zones.z1.max) return 1;
  if (hr <= zones.z2.max) return 2;
  if (hr <= zones.z3.max) return 3;
  if (hr <= zones.z4.max) return 4;
  return 5;
}

/**
 * Analyze effort: compare actual RPE + HR against target zone.
 *
 * @param actualRPE - Self-reported RPE (1-10)
 * @param actualHR - Average HR during workout (BPM)
 * @param target - Target HR zone for this workout
 * @param zones - Full HR zones for zone lookup
 * @returns Feedback, or undefined if insufficient data
 */
export function analyzeEffort(
  actualRPE: number,
  actualHR: number | undefined,
  target: HRTarget | undefined,
  zones: HRZones | undefined,
): EffortFeedback | undefined {
  // Can't analyze without HR data and zones
  if (!actualHR || !zones || !target) return undefined;

  const actualZone = getActualZone(actualHR, zones);
  const targetZoneNum = parseTargetZone(target.zone);

  // Mismatch: RPE low but HR high
  if (actualRPE <= 4 && actualZone >= 4) {
    return {
      type: 'mismatch',
      message: 'Mismatch: Pace felt easy, but HR was high. Check fatigue, heat, or hydration.',
    };
  }

  // Mismatch: RPE high but HR low
  if (actualRPE >= 8 && actualZone <= 2) {
    return {
      type: 'mismatch',
      message: 'Mismatch: Felt hard, but HR remained low. Leg fatigue might be limiting your cardio.',
    };
  }

  // Zone compliance checks
  if (actualHR >= target.min && actualHR <= target.max) {
    return {
      type: 'perfect',
      message: `Perfect execution—kept it strictly ${target.zone}!`,
    };
  }

  if (actualHR > target.max) {
    const overZone = actualZone;
    return {
      type: 'warning',
      message: `Careful, you crept into Zone ${overZone}. Target was ${target.zone} (${target.min}-${target.max} bpm).`,
    };
  }

  if (actualHR < target.min) {
    return {
      type: 'warning',
      message: `HR was below target ${target.zone}. You may be able to push a bit harder next time.`,
    };
  }

  return undefined;
}

/** Parse "Z2" or "Z3-4" into numeric zone (uses lower bound) */
function parseTargetZone(zone: string): number {
  const match = zone.match(/Z(\d)/);
  return match ? parseInt(match[1]) : 2;
}
