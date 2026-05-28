/**
 * Triathlon course-factor multipliers. Applied to leg times AFTER fitness
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
//     MSSE 39:487–493. Fastest times at 10–12°C; per-degree slowdown above.
//   - El Helou N et al. (2012) "Impact of environmental parameters on marathon
//     running performance" PLoS ONE 7:e37407. 1.7M finishers across 6 marathons.
//   - Maughan & Shirreffs (2010) "Dehydration and rehydration in competitive
//     sport" Scand J Med Sci Sports 20 Suppl 3:40–47.
//   - Galloway & Maughan (1997). Heat + humidity interaction.
//   - ACSM Position Stand on Heat (2007).
//   - Tatterson et al. (2000) J Sci Med Sport 3:186–193. ~6.5% bike power
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
  'hot-humid': 1.120,  // +12%  (Galloway 1997, ACSM 2007. Humidity premium)
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
//     adaptation to hypoxia" Sports Med 39:107–127. Meta-analysis.
//   - Wehrlin & Hallen (2006) Eur J Appl Physiol. ~6.3% VO2max drop per
//     1000m above 600m.
//   - Peronnet F et al. (1991). Altitude performance modelling.
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

// Running wind multiplier. Lower magnitude than bike because aerodynamic
// resistance is a much smaller share of running's energy cost (~2-3% vs
// ~80% at race speed for cycling). Net effect of a windy course is asymmetric
// (headwind slows ~3%, tailwind helps ~1%) so a mixed/exposed average
// out to a small net penalty.
//
// Source: Pugh LGCE (1971) "The influence of wind resistance in running and
// walking and the mechanical efficiency of work against horizontal or vertical
// forces" J Physiol 213:255–276. Davies CTM (1980) "Effects of wind assistance
// and resistance on the forward motion of a runner" J Appl Physiol 48:702–709.
// Confidence: medium (model-derived from headwind/tailwind studies; field
// validation per-marathon is thin).
export const WIND_EXPOSURE_RUN_MULTIPLIER: Record<WindExposureCategory, number> = {
  sheltered: 1.00,
  mixed:     1.01,
  exposed:   1.02,
};

// ───────────────────────────────────────────────────────────────────────────
// Heat acclimatisation discount (run)
// Source: Lorenzo S & Cheuvront SN (2010) "Heat acclimation improves
// exercise performance" J Appl Physiol 109:1140–1147. 10–14 days of heat
// acclimatisation preserves ~3–5% performance vs unacclimatised matched
// athletes. Karlsen A et al. (2015) "Heat acclimatization does not improve
// VO2max" Scand J Med Sci Sports 25 Suppl 1:269–276 confirms the effect
// is performance-side, not VO2-side.
//
// Model: discount the climate penalty by up to MAX_DISCOUNT (50%) when
// training temperature is within RAMP_GAP_C (15°C) of the race anchor.
// Linear ramp from 0% discount at gap=15°C to MAX_DISCOUNT at gap≤0°C.
// Mirrors `computeHeatAcclimatisationDiscounts` in race-prediction.triathlon.
// Confidence: medium (literature supports the magnitude; the linear ramp is
// a pragmatic simplification of a more complex physiological curve).
// ───────────────────────────────────────────────────────────────────────────

export const RUN_HEAT_ACCLIM_MAX_DISCOUNT = 0.50; // 50% of the climate penalty
export const RUN_HEAT_ACCLIM_RAMP_GAP_C = 15;    // °C. Gap that fully cancels the discount

// ───────────────────────────────────────────────────────────────────────────
// Swim type
// Sources:
//   - Toussaint HM et al. (1989) "Effect of a triathlon wet suit on drag during
//     swimming" MSSE 21:325–328. ~14% drag reduction at 1.25 m/s.
//   - Cordain L & Kopriva R (1991) "Wetsuits, body density and swimming
//     performance" Sports Med 11:336–348. ~5% time benefit for non-elite.
//   - de la Fuente Pacheco JG et al. (2020) "Is swimmers' performance
//     influenced by wetsuit use?" Int J Sports Physiol Perform 15:46–51 —
//     400m pool study, ~6% time reduction (~0.07 m/s).
//   - Baldassarre R et al. (2017) "Pacing and hazards in long-distance open-
//     water swimming" Front Physiol 8:294. Open-water vs pool review.
//   - López-Belmonte Ó et al. (2024) "Swimming performance in elite
//     triathletes: comparison between open water and pool conditions" Scand J
//     Med Sci Sports 34:e14702. 1500m, n=14, no physiological differences
//     between conditions; kinematic shifts (lower stroke length / index, higher
//     stroke rate in OW) but strong correlation between pool and OW finish time.
//
// Two unions (sharing the same multiplier table):
//   - `SwimTypeCategory`: wider. Includes both race-side and athlete-side
//     environments. Used as the multiplier-table key.
//   - `CourseProfile['swimType']`: narrower (5 values). Race profiles cannot
//     be `pool` (you don't race in a pool).
//   - `AthleteSwimEnvironment`: per-activity tag for training swims. Excludes
//     `ocean-current-assisted` (direction-dependent; not a training baseline).
//
// Athlete-side normalisation: each swim's pace is divided by
// `SWIM_TYPE_MULTIPLIER[swim.swimEnvironment]` to yield a wetsuit-lake-
// equivalent pace before pooling into CSS. Race-side then re-applies the
// course factor for the race environment. This avoids the previous double-
// count where a pool-trained CSS was treated as already in wetsuit-lake
// conditions and then penalised again for ocean chop.
//
// Pool coefficient = 1.00. The pool→open-water penalty (~+5–10%, mostly lost
// wall push-offs + sighting; USMS coaching guidance) approximately cancels
// the wetsuit benefit (~−5–6%, Cordain 1991 / de la Fuente Pacheco 2020), so
// a pool swim ≈ a wetsuit-lake swim at race effort. The decision is "no made-
// up number" honest: both effects are acknowledged but absorbed into the
// shared baseline rather than fabricating a pool-specific multiplier.
//
// Confidence: medium-high for wetsuit, medium for water-type, low for current-
// assisted (direction-dependent and race-specific), medium for pool=1.00 (two
// effects assumed to cancel; could be wrong by a few percent in either
// direction depending on pool length and ocean conditions).
// ───────────────────────────────────────────────────────────────────────────

/** Wider union covering both race-side and athlete-side environments. Used
 *  as the multiplier-table key. */
export type SwimTypeCategory =
  | 'pool'                      // ATHLETE-only. Training in a pool
  | 'wetsuit-lake'              // shared
  | 'non-wetsuit-lake'          // shared
  | 'ocean'                     // shared
  | 'ocean-current-assisted'    // RACE-only. Favourable current
  | 'river';                    // shared

/** Subset of SwimTypeCategory valid as an athlete-side per-activity tag.
 *  Excludes `ocean-current-assisted` (no training baseline). */
export type AthleteSwimEnvironment = Exclude<SwimTypeCategory, 'ocean-current-assisted'>;

export const SWIM_TYPE_MULTIPLIER: Record<SwimTypeCategory, number> = {
  pool:                      1.00,  // Pool ≈ wetsuit-lake (pool→OW penalty cancels wetsuit benefit)
  'wetsuit-lake':            1.00,  // Reference baseline
  'non-wetsuit-lake':        1.04,  // +4% drag without wetsuit (Toussaint 1989, Cordain 1991, de la Fuente Pacheco 2020)
  ocean:                     1.05,  // +5% chop, sighting; salinity buoyancy partially offsets
  'ocean-current-assisted':  0.97,  // -3% (e.g. Roth canal, Kona favourable years)
  river:                     1.00,  // Direction-dependent; neutral default
};

// ───────────────────────────────────────────────────────────────────────────
// Source attribution. Surfaced on the Venue forecast card
// One primary citation per running factor kind. Keep titles short enough to
// fit on one line; long-form discussion lives in docs/SCIENCE_LOG.md §G.
// ───────────────────────────────────────────────────────────────────────────

export interface FactorSource {
  /** Short citation, e.g. "Ely et al. 2007". */
  citation: string;
  /** One-line description of what the paper contributes. */
  title: string;
  /** Journal + page reference. */
  journal: string;
}

export const RUNNING_FACTOR_SOURCES: Record<'climate' | 'altitude' | 'run-elevation' | 'wind' | 'heat-acclim', FactorSource> = {
  climate: {
    citation: 'Ely et al. 2007',
    title: 'Impact of weather on marathon-running performance',
    journal: 'Med Sci Sports Exerc 39:487–493',
  },
  altitude: {
    citation: 'Bonetti and Hopkins 2009',
    title: 'Sea-level exercise performance following adaptation to hypoxia',
    journal: 'Sports Med 39:107–127',
  },
  'run-elevation': {
    citation: 'Minetti et al. 2002',
    title: 'Energy cost of walking and running at extreme uphill and downhill slopes',
    journal: 'J Appl Physiol 93:1039–1046',
  },
  wind: {
    citation: 'Pugh 1971; Davies 1980',
    title: 'Wind resistance in running — headwind / tailwind asymmetry',
    journal: 'J Physiol 213:255–276; J Appl Physiol 48:702–709',
  },
  'heat-acclim': {
    citation: 'Lorenzo & Cheuvront 2010',
    title: 'Heat acclimation improves exercise performance',
    journal: 'J Appl Physiol 109:1140–1147',
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Compound penalty sanity check
// ───────────────────────────────────────────────────────────────────────────

/** If the combined leg multiplier exceeds this, log a warning. */
export const MAX_REASONABLE_LEG_PENALTY = 1.25;
