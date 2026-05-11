/**
 * Cycling event finish-time prediction.
 *
 * **Side of the line**: tracking. Produces a single-discipline finish time
 * for Gran Fondo / sportive / audax targets in cycling-only mode. Not used
 * by the triathlon predictor — that path goes through race-prediction.triathlon.ts.
 *
 * Model: same physics engine as the triathlon bike leg (Martin et al. 1998,
 * `bike-physics.ts`). Intensity factor is duration-dependent per Allen &
 * Coggan (2010) power-duration zones. Solved iteratively because IF depends
 * on expected duration which depends on IF.
 *
 * Science log entry: docs/SCIENCE_LOG.md §K.
 */

import type { SimulatorState } from '@/types/state';
import {
  solveSpeed,
  paramsFromProfile,
  msToKph,
  type BikeCourseProfileExtended,
} from './bike-physics';
import {
  CYCLING_EVENT_INTENSITY_FACTOR,
  CYCLING_PREDICTION_RANGE_FAR,
  CYCLING_PREDICTION_RANGE_NEAR,
} from '@/constants/triathlon-constants';
import {
  CLIMATE_BIKE_MULTIPLIER,
  CLIMATE_ANCHOR_TEMP_C,
  altitudeBikeMultiplier,
} from '@/constants/triathlon-course-factors';
import { getCyclingEventById } from '@/data/cycling-events';

export interface CyclingCourseFactor {
  kind: 'climate' | 'altitude';
  label: string;
  value: string;
  deltaSec: number;
  multiplier: number;
}

export interface CyclingPrediction {
  totalSec: number;
  /** Raw physics-only finish (before climate / altitude). */
  rawSec: number;
  totalRangeSec: [number, number];
  avgKph: number;
  intensityFactor: number;
  avgWatts: number;
  computedAtISO: string;
  /** Itemised climate / altitude factors layered on top of physics. */
  courseFactors: CyclingCourseFactor[];
  /** Resolved event id (when set) — for race-name display. */
  eventId?: string;
}

/**
 * Predict finish time for a cycling event.
 *
 * Returns null when FTP is unknown and no skill-slider fallback exists (i.e.
 * not enough data to produce a useful number).
 */
export function predictCyclingEvent(state: SimulatorState): CyclingPrediction | null {
  const tri = state.triConfig;
  const distanceKey = state.onboarding?.cyclingDistance;
  if (!distanceKey || !tri) return null;

  // Event selection: if cyclingEventId resolves, its profile overrides distance
  // and seeds climate / altitude. Manual overrides on onboarding still win.
  const event = state.onboarding?.cyclingEventId
    ? getCyclingEventById(state.onboarding.cyclingEventId)
    : undefined;

  const distanceKm = event?.distanceKm ?? parseDistanceKm(distanceKey);
  if (distanceKm <= 0) return null;

  const ftp = tri.bike?.ftp;
  if (!ftp) return null; // no FTP = can't produce a watts-based prediction

  const IF = CYCLING_EVENT_INTENSITY_FACTOR[distanceKey] ?? 0.74;

  const aero = tri.bike?.aeroProfiles?.[0];
  const course: BikeCourseProfileExtended =
    event?.courseProfile ?? tri.bike?.courseProfile ?? 'flat';
  const hasMasses = state.bodyWeightKg != null && tri.bike?.bikeWeightKg != null;

  // Iterative solver: seed duration → look up IF (already done above since IF
  // is distance-keyed, not duration-keyed) → compute watts → compute speed →
  // derive duration. One pass is enough because CYCLING_EVENT_INTENSITY_FACTOR
  // is keyed by distance (not duration), so there's no circularity.
  const raceWatts = ftp * IF;

  let avgKph: number;

  if (aero && hasMasses) {
    // Full physics path — same as tri bike leg.
    const params = paramsFromProfile(aero, state.bodyWeightKg!, tri.bike!.bikeWeightKg!, course);
    const v = solveSpeed(raceWatts, params);
    avgKph = v > 0 ? msToKph(v) : fallbackKph(ftp, course);
  } else {
    // No aero profile: simple watts-to-kph linear approximation.
    // 100W = 25 kph at the low end; 400W = 45 kph ceiling on flat. Clamp to
    // realistic range. This reuses the same linear fit as the no-aero path in
    // race-prediction.triathlon.ts:estimateBikeSpeed.
    avgKph = fallbackKph(raceWatts, course);
  }

  const rawSec = Math.round((distanceKm / avgKph) * 3600);

  // ── Course factors layered on top of physics ─────────────────────────────
  // Climate: explicit user override > event default.
  const climate = state.onboarding?.cyclingClimate ?? event?.climate;
  // Altitude: explicit override > event default.
  const altitudeM = state.onboarding?.cyclingAltitudeM ?? event?.altitudeM;

  const courseFactors: CyclingCourseFactor[] = [];
  let totalSec = rawSec;

  if (climate && climate !== 'cool') {
    const f = CLIMATE_BIKE_MULTIPLIER[climate];
    if (f !== 1.0) {
      const delta = rawSec * (f - 1);
      totalSec += delta;
      courseFactors.push({
        kind: 'climate',
        label: 'Climate',
        value: `${climateLabel(climate)} (~${CLIMATE_ANCHOR_TEMP_C[climate]}°C)`,
        deltaSec: delta,
        multiplier: f,
      });
    }
  }

  if (altitudeM && altitudeM >= 500) {
    const f = altitudeBikeMultiplier(altitudeM);
    if (f > 1.0) {
      // Altitude compounds on already-climate-adjusted time.
      const before = totalSec;
      totalSec = totalSec * f;
      courseFactors.push({
        kind: 'altitude',
        label: 'Altitude',
        value: `${altitudeM} m`,
        deltaSec: totalSec - before,
        multiplier: f,
      });
    }
  }

  totalSec = Math.round(totalSec);

  // Confidence range — narrows as race day approaches.
  const weeksToRace = computeWeeksToRace(state);
  const rangeFrac = weeksToRace > 4 ? CYCLING_PREDICTION_RANGE_FAR : CYCLING_PREDICTION_RANGE_NEAR;
  const totalRangeSec: [number, number] = [
    Math.round(totalSec * (1 - rangeFrac)),
    Math.round(totalSec * (1 + rangeFrac)),
  ];

  return {
    totalSec,
    rawSec,
    totalRangeSec,
    avgKph: Math.round(avgKph * 10) / 10,
    intensityFactor: IF,
    avgWatts: Math.round(raceWatts),
    computedAtISO: new Date().toISOString(),
    courseFactors,
    eventId: event?.id,
  };
}

function climateLabel(c: 'cool' | 'temperate' | 'warm' | 'hot' | 'hot-humid'): string {
  switch (c) {
    case 'cool':       return 'Cool';
    case 'temperate':  return 'Temperate';
    case 'warm':       return 'Warm';
    case 'hot':        return 'Hot';
    case 'hot-humid':  return 'Hot and humid';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function parseDistanceKm(key: string): number {
  const n = parseInt(key, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function fallbackKph(watts: number, course: BikeCourseProfileExtended): number {
  // Linear from 100W → 25 kph, 400W → 48 kph. Same coefficients used in
  // race-prediction.triathlon.ts (estimateBikeSpeed no-aero path).
  const base = Math.min(48, Math.max(18, 20 + (watts - 100) * 0.067));
  // Apply a coarse gradient penalty for non-flat courses.
  const penalty: Record<BikeCourseProfileExtended, number> = {
    flat: 0, rolling: 1.5, hilly: 3.5, mountainous: 6.0,
  };
  return Math.max(10, base - (penalty[course] ?? 0));
}

function computeWeeksToRace(state: SimulatorState): number {
  const dateStr = state.onboarding?.customRaceDate ?? state.triConfig?.raceDate;
  if (!dateStr) return 12;
  const diffMs = new Date(dateStr).getTime() - Date.now();
  return Math.max(0, diffMs / (7 * 86400 * 1000));
}
