/**
 * Course-factor adjustments for running races. Applied to predicted finish
 * time after fitness projection. Mirrors the triathlon pipeline in
 * `course-factors.ts` but scoped to a single run leg.
 *
 * Inputs come from `MARATHON_COURSE_PROFILES` attached to the `Marathon`
 * object via `getMarathonById`. Multipliers and the science behind them live
 * in `src/constants/triathlon-course-factors.ts` (despite the file name, the
 * literature. Minetti, Ely, Bonetti and Hopkins. Is sport-generic).
 * `SCIENCE_LOG.md` §G is the narrative record.
 *
 * **Side of the line**: tracking. Pure function, no state mutation.
 */

import type { CourseProfile } from '@/types/onboarding';
import {
  CLIMATE_RUN_MULTIPLIER,
  CLIMATE_ANCHOR_TEMP_C,
  WIND_EXPOSURE_RUN_MULTIPLIER,
  RUN_HEAT_ACCLIM_MAX_DISCOUNT,
  RUN_HEAT_ACCLIM_RAMP_GAP_C,
  altitudeRunMultiplier,
  runElevationMultiplier,
  MAX_REASONABLE_LEG_PENALTY,
} from '@/constants/triathlon-course-factors';
import { MARATHON_COURSE_PROFILES } from '@/data/marathon-course-profiles';

export type RunningCourseFactorKind = 'climate' | 'altitude' | 'run-elevation' | 'wind' | 'heat-acclim';

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

/** Optional context for course-factor calculation. Both fields are required for
 *  the heat-acclimatisation discount to fire (training temp without race
 *  climate has nothing to compare against, and vice versa). */
export interface RunningCourseFactorOpts {
  /** Average outdoor training temperature over the last 4 weeks (°C). Computed
   *  from `ambientTempC` on synced activities. Null/undefined → no acclim. */
  trainingTempC?: number | null;
}

/**
 * Apply climate, altitude, elevation, wind, and heat-acclimatisation factors
 * to a raw running prediction.
 *
 * @param rawSec      Raw predicted finish time (from VDOT/blendPredictions).
 * @param profile     Race course profile. Undefined → identity (no adjustment).
 * @param distanceKm  Race distance in km. Required for elevation grade calc.
 * @param opts        Optional context (training temp for heat acclim).
 */
export function applyRunningCourseFactors(
  rawSec: number,
  profile: CourseProfile | undefined,
  distanceKm: number,
  opts?: RunningCourseFactorOpts,
): RunningCourseFactorOutput {
  const factors: RunningCourseFactor[] = [];
  let mult = 1.0;

  if (!profile || rawSec <= 0 || distanceKm <= 0) {
    return { rawSec, adjustedSec: rawSec, multiplier: 1, factors: [] };
  }

  // ── Climate ─────────────────────────────────────────────────────────────
  // Captured here so the heat-acclim factor below can compute its discount
  // against the climate penalty without re-deriving it.
  let climatePenaltyFraction = 0; // > 0 means race climate is hotter than cool
  if (profile.climate && profile.climate !== 'cool') {
    const factor = CLIMATE_RUN_MULTIPLIER[profile.climate];
    if (factor !== 1.0) {
      climatePenaltyFraction = factor - 1;
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

  // ── Wind exposure ───────────────────────────────────────────────────────
  // Headwind/tailwind asymmetry. Exposed courses average to a small net
  // slow-down for running (~1-2%, much smaller than cycling's 2-5%).
  if (profile.windExposure && profile.windExposure !== 'sheltered') {
    const factor = WIND_EXPOSURE_RUN_MULTIPLIER[profile.windExposure];
    if (factor !== 1.0) {
      mult *= factor;
      factors.push({
        kind: 'wind',
        label: 'Wind',
        value: profile.windExposure.charAt(0).toUpperCase() + profile.windExposure.slice(1),
        deltaSec: rawSec * (factor - 1),
        multiplier: factor,
      });
    }
  }

  // ── Heat acclimatisation discount ───────────────────────────────────────
  // Only fires when the climate penalty is positive AND we have a recent
  // training temperature. Discounts up to RUN_HEAT_ACCLIM_MAX_DISCOUNT (50%)
  // of the climate penalty when training temp is within RAMP_GAP_C (15°C)
  // of the race climate anchor.
  if (climatePenaltyFraction > 0 && opts?.trainingTempC != null && profile.climate) {
    const raceAnchorTemp = CLIMATE_ANCHOR_TEMP_C[profile.climate];
    const tempGap = raceAnchorTemp - opts.trainingTempC; // positive = training cooler
    if (tempGap < RUN_HEAT_ACCLIM_RAMP_GAP_C) {
      const discountFraction = Math.max(
        0,
        RUN_HEAT_ACCLIM_MAX_DISCOUNT * (1 - Math.max(0, tempGap) / RUN_HEAT_ACCLIM_RAMP_GAP_C),
      );
      if (discountFraction > 0) {
        // The discount is applied as a sub-1.0 factor against the already-
        // applied climate penalty. Effective net climate penalty becomes:
        //   (1 + climatePenaltyFraction) * acclimFactor
        // where acclimFactor < 1 reduces but does not erase the climate hit.
        const acclimFactor = 1 - climatePenaltyFraction * discountFraction;
        mult *= acclimFactor;
        factors.push({
          kind: 'heat-acclim',
          label: 'Heat acclimatisation',
          value: `Training ${Math.round(opts.trainingTempC)}°C vs race ${Math.round(raceAnchorTemp)}°C (−${(discountFraction * 100).toFixed(0)}% of climate)`,
          deltaSec: rawSec * (acclimFactor - 1),
          multiplier: acclimFactor,
        });
      }
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
 * Average outdoor training temperature over the last 4 weeks (°C). Reads
 * `ambientTempC` from synced run activities (populated by Open-Meteo for
 * outdoor runs with a GPS start location). Returns null when fewer than 4
 * activities in the window have temperature data. Below that the mean is
 * too noisy to feed an acclimatisation discount.
 *
 * Mirrors `computeTrainingTempC` in race-prediction.triathlon (run-specific
 * here: filters to RUNNING activity types only).
 */
interface AmbientAware {
  startTime?: string | null;
  activityType?: string | null;
  ambientTempC?: number | null;
}

export function computeRunTrainingTempC(
  state: { wks?: ReadonlyArray<{ garminActuals?: Record<string, AmbientAware> }> | null },
): number | null {
  const nowMs = Date.now();
  const lookbackMs = 4 * 7 * 24 * 3600 * 1000;
  const temps: number[] = [];

  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const a of Object.values(wk.garminActuals)) {
      if (a?.ambientTempC == null || !a.startTime || !a.activityType) continue;
      const t = a.activityType.toUpperCase();
      if (t !== 'RUNNING' && !t.includes('RUN')) continue;
      if (nowMs - Date.parse(a.startTime) > lookbackMs) continue;
      temps.push(a.ambientTempC);
    }
  }

  if (temps.length < 4) return null;
  return temps.reduce((a, b) => a + b, 0) / temps.length;
}

/**
 * Apply course factors to `s.forecastTime` and write the adjusted finish +
 * itemised factors into state. Idempotent. Safe to call after every forecast
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
    wks?: ReadonlyArray<{ garminActuals?: Record<string, AmbientAware> }> | null;
  },
): void {
  // Self-heal: state persisted before profiles were added carries no `profile`
  //. Attach the latest from the static dataset by id.
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
  const trainingTempC = computeRunTrainingTempC(s);
  const adj = applyRunningCourseFactors(rawSec, profile, distKm, { trainingTempC });
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
