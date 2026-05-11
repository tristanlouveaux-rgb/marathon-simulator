/**
 * Course-factor adjustments for running races — applied to predicted finish
 * time after fitness projection. Mirrors the triathlon pipeline in
 * `course-factors.ts` but scoped to a single run leg.
 *
 * Inputs come from `MARATHON_COURSE_PROFILES` attached to the `Marathon`
 * object via `getMarathonById`. Multipliers and the science behind them live
 * in `src/constants/triathlon-course-factors.ts` (despite the file name, the
 * literature — Minetti, Ely, Bassett — is sport-generic). `SCIENCE_LOG.md` §G
 * is the narrative record.
 *
 * **Side of the line**: tracking. Pure function, no state mutation.
 */

import type { CourseProfile } from '@/types/onboarding';
import {
  CLIMATE_RUN_MULTIPLIER,
  CLIMATE_ANCHOR_TEMP_C,
  altitudeRunMultiplier,
  runElevationMultiplier,
  MAX_REASONABLE_LEG_PENALTY,
} from '@/constants/triathlon-course-factors';
import { MARATHON_COURSE_PROFILES } from '@/data/marathon-course-profiles';

export type RunningCourseFactorKind = 'climate' | 'altitude' | 'run-elevation';

export interface RunningCourseFactor {
  kind: RunningCourseFactorKind;
  /** Human-readable factor name. */
  label: string;
  /** Specific value (e.g. "Hot-humid (~30°C)", "+250 m gain", "1500 m"). */
  value: string;
  /** Time delta in seconds (positive = slower). */
  deltaSec: number;
  /** Multiplier applied to predicted time (1.05 = +5% slower). */
  multiplier: number;
}

export interface RunningCourseFactorOutput {
  /** Raw predicted time before any course adjustment, in seconds. */
  rawSec: number;
  /** Adjusted predicted time after all factors compounded, in seconds. */
  adjustedSec: number;
  /** Combined multiplier (= adjustedSec / rawSec). */
  multiplier: number;
  /** Itemised factor rows for UI display. */
  factors: RunningCourseFactor[];
}

/**
 * Apply climate, altitude, and elevation factors to a raw running prediction.
 *
 * @param rawSec      Raw predicted finish time (from VDOT/blendPredictions).
 * @param profile     Race course profile. Undefined → identity (no adjustment).
 * @param distanceKm  Race distance in km. Required for elevation grade calc.
 */
export function applyRunningCourseFactors(
  rawSec: number,
  profile: CourseProfile | undefined,
  distanceKm: number,
): RunningCourseFactorOutput {
  const factors: RunningCourseFactor[] = [];
  let mult = 1.0;

  if (!profile || rawSec <= 0 || distanceKm <= 0) {
    return { rawSec, adjustedSec: rawSec, multiplier: 1, factors: [] };
  }

  // ── Climate ─────────────────────────────────────────────────────────────
  if (profile.climate && profile.climate !== 'cool') {
    const factor = CLIMATE_RUN_MULTIPLIER[profile.climate];
    if (factor !== 1.0) {
      mult *= factor;
      factors.push({
        kind: 'climate',
        label: 'Climate',
        value: `${labelForClimate(profile.climate)} (~${CLIMATE_ANCHOR_TEMP_C[profile.climate]}°C)`,
        deltaSec: rawSec * (factor - 1),
        multiplier: factor,
      });
    }
  }

  // ── Altitude ────────────────────────────────────────────────────────────
  // `!== 1.0` (not `> 1.0`) so any future sub-1.0 cases surface as negative
  // deltas rather than being silently dropped. Today altitudeRunMultiplier
  // only returns >= 1.0 so behaviour is unchanged for current data.
  if (profile.altitudeM && profile.altitudeM >= 500) {
    const factor = altitudeRunMultiplier(profile.altitudeM);
    if (factor !== 1.0) {
      mult *= factor;
      factors.push({
        kind: 'altitude',
        label: 'Altitude',
        value: `${profile.altitudeM} m`,
        deltaSec: rawSec * (factor - 1),
        multiplier: factor,
      });
    }
  }

  // ── Elevation gain (Minetti) ────────────────────────────────────────────
  if (profile.runElevationM && profile.runElevationM > 0) {
    const factor = runElevationMultiplier(profile.runElevationM, distanceKm);
    if (factor !== 1.0) {
      mult *= factor;
      const sign = factor >= 1 ? '+' : '';
      factors.push({
        kind: 'run-elevation',
        label: 'Elevation gain',
        value: `${sign}${profile.runElevationM} m`,
        deltaSec: rawSec * (factor - 1),
        multiplier: factor,
      });
    }
  }

  if (mult > MAX_REASONABLE_LEG_PENALTY) {
    console.warn(
      `[course-factors-running] compounded penalty exceeds ${MAX_REASONABLE_LEG_PENALTY}: ${mult.toFixed(2)}`
    );
  }

  return {
    rawSec,
    adjustedSec: rawSec * mult,
    multiplier: mult,
    factors,
  };
}

/**
 * Apply course factors to `s.forecastTime` and write the adjusted finish +
 * itemised factors into state. Idempotent — safe to call after every forecast
 * recalculation. Clears the adjusted fields if the user has no selected race
 * with a profile (so stale values do not survive race deselection).
 */
export function refreshForecastCourseFactors(
  s: {
    forecastTime: number | null;
    rd?: 'half' | 'marathon' | '5k' | '10k' | null;
    selectedMarathon?: { id?: string; profile?: CourseProfile } | null;
    forecastTimeAdjusted?: number;
    forecastCourseFactors?: RunningCourseFactor[];
  },
): void {
  // Self-heal: state persisted before profiles were added carries no `profile`
  // — attach the latest from the static dataset by id.
  let profile = s.selectedMarathon?.profile;
  if (!profile && s.selectedMarathon?.id && MARATHON_COURSE_PROFILES[s.selectedMarathon.id]) {
    profile = MARATHON_COURSE_PROFILES[s.selectedMarathon.id];
    if (s.selectedMarathon) (s.selectedMarathon as { profile?: CourseProfile }).profile = profile;
  }
  const rawSec = s.forecastTime;
  if (!profile || !rawSec || rawSec <= 0 || !s.rd) {
    delete s.forecastTimeAdjusted;
    delete s.forecastCourseFactors;
    return;
  }
  const distKm =
    s.rd === '5k' ? 5 :
    s.rd === '10k' ? 10 :
    s.rd === 'half' ? 21.0975 :
    /* marathon */ 42.195;
  const adj = applyRunningCourseFactors(rawSec, profile, distKm);
  if (adj.factors.length === 0) {
    delete s.forecastTimeAdjusted;
    delete s.forecastCourseFactors;
    return;
  }
  s.forecastTimeAdjusted = adj.adjustedSec;
  s.forecastCourseFactors = adj.factors;
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
