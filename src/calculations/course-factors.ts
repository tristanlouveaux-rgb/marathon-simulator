/**
 * Course-factor adjustments — applied to leg times after fitness projection.
 *
 * Inputs come from the canonical `CourseProfile` data file
 * (`src/data/triathlon-course-profiles.ts`) attached to the `Triathlon` object
 * via `getTriathlonById`. Multipliers and the science behind them live in
 * `src/constants/triathlon-course-factors.ts` (with `SCIENCE_LOG.md` §G as the
 * narrative record).
 *
 * Every factor returns a multiplicative adjustment >= 1.0 (slower) or <= 1.0
 * (faster) on the leg time, plus a `CourseFactor` row for the UI panel.
 *
 * **Side of the line**: tracking. Pure functions, no state mutation.
 */

import type { CourseProfile } from '@/types/onboarding';
import {
  CLIMATE_RUN_MULTIPLIER,
  CLIMATE_BIKE_MULTIPLIER,
  CLIMATE_ANCHOR_TEMP_C,
  WIND_EXPOSURE_BIKE_MULTIPLIER,
  SWIM_TYPE_MULTIPLIER,
  altitudeRunMultiplier,
  altitudeBikeMultiplier,
  runElevationMultiplier,
  MAX_REASONABLE_LEG_PENALTY,
} from '@/constants/triathlon-course-factors';

export type CourseFactorKind =
  | 'climate'
  | 'altitude'
  | 'run-elevation'
  | 'bike-elevation'
  | 'wind'
  | 'swim-type';

export interface CourseFactor {
  kind: CourseFactorKind;
  /** Discipline this factor applies to. */
  leg: 'swim' | 'bike' | 'run';
  /** Human-readable factor name (e.g. "Climate", "Altitude"). */
  label: string;
  /** Specific value (e.g. "Hot-humid (30°C+, RH > 70%)", "1500m"). */
  value: string;
  /** Time delta in seconds (positive = slower). */
  deltaSec: number;
  /** Multiplier applied to leg time (1.05 = +5% slower). */
  multiplier: number;
}

export interface CourseFactorOutput {
  swimMultiplier: number;
  bikeMultiplier: number;
  runMultiplier: number;
  factors: CourseFactor[];
}

/**
 * Apply all course factors to base leg times.
 *
 * @param profile      Race course profile (may be undefined → returns identity)
 * @param baseSec      Raw leg times before adjustment
 * @param runDistKm    Run leg distance in km (used by Minetti elevation)
 */
export function applyCourseFactors(
  profile: CourseProfile | undefined,
  baseSec: { swimSec: number; bikeSec: number; runSec: number },
  runDistKm: number,
): CourseFactorOutput {
  const factors: CourseFactor[] = [];
  let swimMult = 1.0;
  let bikeMult = 1.0;
  let runMult = 1.0;

  if (!profile) {
    return { swimMultiplier: 1, bikeMultiplier: 1, runMultiplier: 1, factors: [] };
  }

  // ── Climate (run + bike) ────────────────────────────────────────────────
  if (profile.climate && profile.climate !== 'cool') {
    const runFactor = CLIMATE_RUN_MULTIPLIER[profile.climate];
    const bikeFactor = CLIMATE_BIKE_MULTIPLIER[profile.climate];
    if (runFactor !== 1.0) {
      runMult *= runFactor;
      factors.push({
        kind: 'climate',
        leg: 'run',
        label: 'Climate',
        value: `${labelForClimate(profile.climate)} (~${CLIMATE_ANCHOR_TEMP_C[profile.climate]}°C)`,
        deltaSec: baseSec.runSec * (runFactor - 1),
        multiplier: runFactor,
      });
    }
    if (bikeFactor !== 1.0) {
      bikeMult *= bikeFactor;
      factors.push({
        kind: 'climate',
        leg: 'bike',
        label: 'Climate',
        value: `${labelForClimate(profile.climate)} (~${CLIMATE_ANCHOR_TEMP_C[profile.climate]}°C)`,
        deltaSec: baseSec.bikeSec * (bikeFactor - 1),
        multiplier: bikeFactor,
      });
    }
  }

  // ── Altitude (run + bike) ───────────────────────────────────────────────
  if (profile.altitudeM && profile.altitudeM >= 500) {
    const runFactor = altitudeRunMultiplier(profile.altitudeM);
    const bikeFactor = altitudeBikeMultiplier(profile.altitudeM);
    if (runFactor > 1.0) {
      runMult *= runFactor;
      factors.push({
        kind: 'altitude',
        leg: 'run',
        label: 'Altitude',
        value: `${profile.altitudeM} m`,
        deltaSec: baseSec.runSec * (runFactor - 1),
        multiplier: runFactor,
      });
    }
    if (bikeFactor > 1.0) {
      bikeMult *= bikeFactor;
      factors.push({
        kind: 'altitude',
        leg: 'bike',
        label: 'Altitude',
        value: `${profile.altitudeM} m`,
        deltaSec: baseSec.bikeSec * (bikeFactor - 1),
        multiplier: bikeFactor,
      });
    }
  }

  // ── Run elevation (Minetti) ─────────────────────────────────────────────
  if (profile.runElevationM && profile.runElevationM > 0 && runDistKm > 0) {
    const factor = runElevationMultiplier(profile.runElevationM, runDistKm);
    if (factor !== 1.0) {
      runMult *= factor;
      factors.push({
        kind: 'run-elevation',
        leg: 'run',
        label: 'Run elevation',
        value: `+${profile.runElevationM} m gain`,
        deltaSec: baseSec.runSec * (factor - 1),
        multiplier: factor,
      });
    }
  }

  // ── Wind exposure (bike) ────────────────────────────────────────────────
  if (profile.windExposure && profile.windExposure !== 'sheltered') {
    const factor = WIND_EXPOSURE_BIKE_MULTIPLIER[profile.windExposure];
    if (factor > 1.0) {
      bikeMult *= factor;
      factors.push({
        kind: 'wind',
        leg: 'bike',
        label: 'Wind exposure',
        value: profile.windExposure[0].toUpperCase() + profile.windExposure.slice(1),
        deltaSec: baseSec.bikeSec * (factor - 1),
        multiplier: factor,
      });
    }
  }

  // ── Swim type ───────────────────────────────────────────────────────────
  if (profile.swimType && profile.swimType !== 'wetsuit-lake') {
    const factor = SWIM_TYPE_MULTIPLIER[profile.swimType];
    if (factor !== 1.0) {
      swimMult *= factor;
      factors.push({
        kind: 'swim-type',
        leg: 'swim',
        label: 'Swim conditions',
        value: labelForSwimType(profile.swimType),
        deltaSec: baseSec.swimSec * (factor - 1),
        multiplier: factor,
      });
    }
  }

  // Sanity-check: warn if compounded multipliers are unusually large.
  if (bikeMult > MAX_REASONABLE_LEG_PENALTY || runMult > MAX_REASONABLE_LEG_PENALTY) {
    console.warn(
      `[course-factors] compounded penalty exceeds ${MAX_REASONABLE_LEG_PENALTY}: bike=${bikeMult.toFixed(2)} run=${runMult.toFixed(2)}`
    );
  }

  return {
    swimMultiplier: swimMult,
    bikeMultiplier: bikeMult,
    runMultiplier: runMult,
    factors,
  };
}

function labelForClimate(c: NonNullable<CourseProfile['climate']>): string {
  switch (c) {
    case 'cool':       return 'Cool';
    case 'temperate':  return 'Temperate';
    case 'warm':       return 'Warm';
    case 'hot':        return 'Hot';
    case 'hot-humid':  return 'Hot and humid';
  }
}

function labelForSwimType(s: NonNullable<CourseProfile['swimType']>): string {
  switch (s) {
    case 'wetsuit-lake':           return 'Wetsuit lake';
    case 'non-wetsuit-lake':       return 'Non-wetsuit lake';
    case 'ocean':                  return 'Ocean';
    case 'ocean-current-assisted': return 'Ocean (current-assisted)';
    case 'river':                  return 'River';
  }
}
