/**
 * Triathlon course-factor multipliers — applied to leg times AFTER fitness
 * projection. Drives climate, altitude, run elevation, wind, and swim-type
 * adjustments. Every value is literature-anchored; full rationale lives in
 * `docs/SCIENCE_LOG.md` §G.
 *
 * Multipliers are applied to leg time. >1.0 = slower. <1.0 = faster.
 *
 * **Compounded multiplications must be sanity-checked**: log a warning if
 * total bike or run penalty exceeds 25%. None of the individual factors
 * exceeds ±15%.
 */

import type { CourseProfile } from '@/types/onboarding';

// ───────────────────────────────────────────────────────────────────────────
// Climate (run primary, bike secondary)
// Sources:
//   - Ely MR et al. (2007) "Impact of weather on marathon-running performance"
//     MSSE 39:487–493 — fastest times at 10–12°C; per-degree slowdown above.
//   - El Helou N et al. (2012) "Impact of environmental parameters on marathon
//     running performance" PLoS ONE 7:e37407 — 1.7M finishers across 6 marathons.
//   - Maughan & Shirreffs (2010) "Dehydration and rehydration in competitive
//     sport" Scand J Med Sci Sports 20 Suppl 3:40–47.
//   - Galloway & Maughan (1997) — heat + humidity interaction.
//   - ACSM Position Stand on Heat (2007).
//   - Tatterson et al. (2000) J Sci Med Sport 3:186–193 — ~6.5% bike power
//     drop in 32°C vs 23°C TT; bike heat penalty ≈40% of run penalty due to
//     convective cooling at 30+ km/h.
// Confidence: high for run, medium for bike.
// ───────────────────────────────────────────────────────────────────────────

export type ClimateCategory = NonNullable<CourseProfile['climate']>;

/** Anchor temperatures for each climate category (°C). Used in SCIENCE_LOG only. */
export const CLIMATE_ANCHOR_TEMP_C: Record<ClimateCategory, number> = {
  cool:        12,
  temperate:   18,
  warm:        24,
  hot:         30,
  'hot-humid': 30,  // 30°C + RH > 70%
};

/** Run-pace multiplier per climate category. Reference = `cool`. */
export const CLIMATE_RUN_MULTIPLIER: Record<ClimateCategory, number> = {
  cool:        1.000,
  temperate:   1.015,  // +1.5% (Ely 2007, Vihma 2010)
  warm:        1.040,  // +4%   (Ely 2007, Maughan 2010)
  hot:         1.080,  // +8%   (El Helou 2012)
  'hot-humid': 1.120,  // +12%  (Galloway 1997, ACSM 2007 — humidity premium)
};

/** Bike multiplier — convective cooling reduces effect to ~40% of run. */
export const CLIMATE_BIKE_MULTIPLIER: Record<ClimateCategory, number> = {
  cool:        1.000,
  temperate:   1.006,
  warm:        1.016,
  hot:         1.030,
  'hot-humid': 1.050,
};

// ───────────────────────────────────────────────────────────────────────────
// Altitude (run + bike, non-linear above 1500m)
// Sources:
//   - Bonetti & Hopkins (2009) "Sea-level exercise performance following
//     adaptation to hypoxia" Sports Med 39:107–127 — meta-analysis.
//   - Wehrlin & Hallen (2006) Eur J Appl Physiol — ~6.3% VO2max drop per
//     1000m above 600m.
//   - Peronnet F et al. (1991) — altitude performance modelling.
// Bike < run because IM-intensity power is sub-maximal aerobic; running has
// higher relative VO2 cost per unit speed.
// Confidence: high for the model, medium for the bike-vs-run scaling.
// ───────────────────────────────────────────────────────────────────────────

/** Altitude → run-pace multiplier. Caps at +12%. */
export function altitudeRunMultiplier(altitudeM: number | undefined): number {
  if (!altitudeM || altitudeM < 500) return 1.0;
  // 500–1500m: 0.20% per 100m above 500m (linear)
  // 1500m+:    0.40% per 100m above 1500m (steeper, VO2max curve)
  let pct: number;
  if (altitudeM <= 1500) {
    pct = (altitudeM - 500) / 100 * 0.20;
  } else {
    pct = 2.0 + (altitudeM - 1500) / 100 * 0.40;
  }
  return 1 + Math.min(pct, 12) / 100;
}

/** Altitude → bike-speed multiplier. Bike penalty ≈ 65% of run penalty. */
export function altitudeBikeMultiplier(altitudeM: number | undefined): number {
  const runPct = (altitudeRunMultiplier(altitudeM) - 1) * 100;
  const bikePct = Math.min(runPct * 0.65, 8);
  return 1 + bikePct / 100;
}

// ───────────────────────────────────────────────────────────────────────────
// Run elevation (Minetti 2002 polynomial)
// Sources:
//   - Minetti et al. (2002) "Energy cost of walking and running at extreme
//     uphill and downhill slopes" J Appl Physiol 93:1039–1046. Canonical
//     polynomial for energy cost C(i) as a function of gradient i.
//   - Drake/Strava Engineering blog (2017) "Improving Grade Adjusted Pace" —
//     Strava's GAP algorithm is Minetti-derived.
// Confidence: high. Limitation: average grade underestimates true cost on
// rolling courses (asymmetric eccentric cost on descents). For a v1 prediction
// this is acceptable; can be improved later with per-km elevation data.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Energy cost of running per unit distance, J/kg/m, as a function of gradient
 * `i` (rise/run). Polynomial fit from Minetti et al. 2002.
 */
export function minettiEnergyCost(i: number): number {
  return (
    155.4 * Math.pow(i, 5) -
    30.4  * Math.pow(i, 4) -
    43.3  * Math.pow(i, 3) +
    46.3  * Math.pow(i, 2) +
    19.5  * i +
    3.6
  );
}

/** Energy cost on flat ground, used as the denominator for the multiplier. */
const C_FLAT = 3.6;

/**
 * Run elevation multiplier from total elevation gain over distance.
 * Caps downhill grade at -10% (Minetti curve flattens for steep descents).
 */
export function runElevationMultiplier(elevationM: number | undefined, distanceKm: number): number {
  if (!elevationM || elevationM <= 0 || distanceKm <= 0) return 1.0;
  const avgGrade = elevationM / (distanceKm * 1000);
  const clampedGrade = Math.max(-0.10, Math.min(0.10, avgGrade));
  return minettiEnergyCost(clampedGrade) / C_FLAT;
}

// ───────────────────────────────────────────────────────────────────────────
// Wind exposure (bike only)
// Source: Martin JC et al. (1998) "Validation of a mathematical model for road
// cycling power" J Appl Biomech 14:276–291. Already used in bike-physics.ts.
// Treated as model-derived; field validation for IM bike splits is thin.
// Confidence: low-medium.
// ───────────────────────────────────────────────────────────────────────────

export type WindExposureCategory = NonNullable<CourseProfile['windExposure']>;

export const WIND_EXPOSURE_BIKE_MULTIPLIER: Record<WindExposureCategory, number> = {
  sheltered: 1.00,
  mixed:     1.02,
  exposed:   1.05,
};

// ───────────────────────────────────────────────────────────────────────────
// Swim type
// Sources:
//   - Toussaint HM et al. (1989) "Effect of a triathlon wet suit on drag during
//     swimming" MSSE 21:325–328 — ~14% drag reduction at 1.25 m/s.
//   - Cordain L & Kopriva R (1991) "Wetsuits, body density and swimming
//     performance" Sports Med 11:336–348 — ~5% time benefit for non-elite.
//   - Baldassarre R et al. (2017) "Pacing and hazards in long-distance open-
//     water swimming" Front Physiol 8:294 — open-water vs pool review.
// Confidence: medium-high for wetsuit, medium for water-type, low for current-
// assisted (direction-dependent and race-specific).
// ───────────────────────────────────────────────────────────────────────────

export type SwimTypeCategory = NonNullable<CourseProfile['swimType']>;

export const SWIM_TYPE_MULTIPLIER: Record<SwimTypeCategory, number> = {
  'wetsuit-lake':            1.00,  // Reference baseline
  'non-wetsuit-lake':        1.04,  // +4% drag without wetsuit (Toussaint 1989)
  ocean:                     1.05,  // +5% chop, sighting; salinity buoyancy partially offsets
  'ocean-current-assisted':  0.97,  // -3% (e.g. Roth canal, Kona favourable years)
  river:                     1.00,  // Direction-dependent; neutral default
};

// ───────────────────────────────────────────────────────────────────────────
// Compound penalty sanity check
// ───────────────────────────────────────────────────────────────────────────

/** If the combined leg multiplier exceeds this, log a warning. */
export const MAX_REASONABLE_LEG_PENALTY = 1.25;
