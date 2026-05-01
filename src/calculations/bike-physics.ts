/**
 * Cycling power balance — solve speed from power (and the inverse: solve CdA
 * from a known ride). Pure functions, no state, fully testable.
 *
 * **Side of the line**: tracking. Feeds `predictTriathlonRace` only.
 *
 * Model (Martin et al., "Validation of a mathematical model for road cycling
 * power", J. Appl. Biomech. 1998):
 *
 *   P_net = ½·ρ·CdA·v³  +  Crr·m·g·v  +  m·g·sinθ·v
 *   P_pedalled = P_net / η         // η = drivetrain efficiency, 0.95–0.98
 *
 *   v   — ground speed (m/s)
 *   ρ   — air density (kg/m³); 1.225 at sea level, 15°C
 *   CdA — drag area (m²)
 *   Crr — rolling resistance coefficient
 *   m   — total moving mass (rider + bike + kit), kg
 *   g   — 9.80665 m/s²
 *   θ   — road gradient (rad). For "flat" course, sinθ ≈ 0; we still pass an
 *         effective average gradient + a wind-loss factor for rolling/hilly.
 *
 * The wind term (cubic in v) dominates above ~25 kph. At low speeds Crr leads.
 * On flat IM courses, aero contributes ~70–80% of total resistive power for
 * a typical age-grouper at race intensity.
 *
 * CdA presets (Position → CdA, m²) are mid-range values from published wind-
 * tunnel data (Cyclist magazine 2019 wind-tunnel tests, Cervélo white papers,
 * Specialized Win Tunnel reports). Real-world variation is large; the
 * `solveCdA` reverse-calibration is the path to a personal value.
 *
 * Crr presets are from `bicyclerollingresistance.com` lab data at 100 PSI on
 * a steel drum (overestimates road CRR by ~10% — values below already adjusted
 * down).
 */

import type {
  BikePosition,
  BikeTire,
  BikeCourseProfile,
  BikeAeroProfile,
} from '@/types/triathlon';

const G = 9.80665;          // m/s²
const RHO_SEA_LEVEL = 1.225; // kg/m³ at 15°C, 1 atm

/** CdA presets by riding position (m²). */
export const CDA_PRESET: Record<BikePosition, number> = {
  hoods:    0.36,  // upright on road bike, hands on hoods — typical recreational
  drops:    0.32,  // road bike in drops — race-fit roadie
  'clip-ons': 0.28, // road bike with clip-on aerobars — common 70.3 setup
  'tt-bike': 0.24,  // dedicated TT/tri bike with aero helmet, race wheels
};

/** Crr presets by tire/surface choice. */
export const CRR_PRESET: Record<BikeTire, number> = {
  'race-tubeless': 0.0035, // GP5000 S TR, Vittoria Corsa Pro etc. — fast race
  'race-clincher': 0.0040, // GP5000 with latex tubes
  training:        0.0050, // training tires, mid-pressure
  gravel:          0.0070, // gravel/all-road tires
};

/**
 * Extended course profile used by the prediction engine. The user-facing
 * `BikeCourseProfile` collapses to 3 buckets (flat/rolling/hilly) for storage,
 * but the canonical per-race data file (`triathlon-course-profiles.ts`) tags
 * `mountainous` as a fourth tier (Lanzarote, Nice, Wales, Lake Placid IM).
 * The prediction engine accepts the wider type so mountainous courses use a
 * steeper gradient + higher wind-loss factor instead of being collapsed to
 * `hilly`. The bike-setup UI continues to use the 3-bucket type.
 */
export type BikeCourseProfileExtended = BikeCourseProfile | 'mountainous';

/** Gradient assumption for course profile (mean tan θ). */
export const COURSE_GRADIENT: Record<BikeCourseProfileExtended, number> = {
  flat:        0.000, // Kona, Roth, Texas
  rolling:     0.005, // 0.5% net "always climbing" feel — Wales 70.3, Mont-Tremblant
  hilly:       0.012, // 1.2% effective from sustained climbs — Frankfurt, Lake Placid
  mountainous: 0.020, // 2.0% effective — Lanzarote, IM Nice, IM Wales (sustained alpine climbs)
};

/** Headwind/conditions loss multiplier — bumps CdA on rougher courses where
 *  wind exposure is unavoidable. Applied as effective CdA = CdA × factor. */
export const WIND_LOSS_FACTOR: Record<BikeCourseProfileExtended, number> = {
  flat:        1.00,
  rolling:     1.02,
  hilly:       1.05,
  mountainous: 1.07,
};

/** Default drivetrain efficiency. Modern clean chain + good bearings. */
export const DEFAULT_DRIVETRAIN_EFF = 0.97;

/** Typical race intensity factor (% of FTP) by distance. Standard
 *  TrainingPeaks/Allen-Coggan guidance: IM ~0.68–0.72, 70.3 ~0.78–0.82. */
export const RACE_INTENSITY_BY_DISTANCE: Record<'70.3' | 'ironman', number> = {
  '70.3':    0.78,
  'ironman': 0.70,
};

// ───────────────────────────────────────────────────────────────────────────
// Forward solve: power → speed
// ───────────────────────────────────────────────────────────────────────────

export interface PowerBalanceParams {
  /** Total moving mass — rider + bike + kit + bottles. kg */
  totalMassKg: number;
  /** Drag area (m²). Already includes any wind-loss factor if applicable. */
  cda: number;
  /** Rolling resistance coefficient (dimensionless). */
  crr: number;
  /** Drivetrain efficiency, e.g. 0.97. */
  drivetrainEff: number;
  /** Air density (kg/m³). */
  airDensityKgM3: number;
  /** Mean road gradient as tan θ (e.g. 0.012 = 1.2%). */
  gradient: number;
}

/**
 * Solve ground speed (m/s) from sustained pedalled power, given physics params.
 * Uses Newton-Raphson on the cubic — converges in ~5 iterations.
 *
 * @param powerW Sustained pedalled power at the cranks (watts).
 * @returns Ground speed in m/s. Always >= 0.
 */
export function solveSpeed(powerW: number, p: PowerBalanceParams): number {
  if (!isFinite(powerW) || powerW <= 0) return 0;

  // P_net = P_pedalled × η
  const Pnet = powerW * p.drivetrainEff;

  // f(v)  = ½·ρ·CdA·v³ + (Crr·m·g + m·g·sinθ)·v − Pnet = 0
  // Approximation: for small θ, sinθ ≈ tanθ = gradient. For typical bike
  // course gradients (≤ 6%), error is < 0.2%.
  const aero = 0.5 * p.airDensityKgM3 * p.cda;
  const linear = p.crr * p.totalMassKg * G + p.totalMassKg * G * p.gradient;

  // Initial guess: ignore aero, solve linear → v0 = Pnet / linear.
  // Cap at 30 m/s (108 kph) to prevent runaway on small denominators.
  let v = Math.min(30, Math.max(1, linear > 0 ? Pnet / linear : 10));

  for (let i = 0; i < 12; i++) {
    const f = aero * v * v * v + linear * v - Pnet;
    const fPrime = 3 * aero * v * v + linear;
    if (fPrime <= 0) break;
    const dv = f / fPrime;
    v -= dv;
    if (Math.abs(dv) < 1e-4) break;
  }

  return Math.max(0, v);
}

/** Convert m/s → km/h. */
export function msToKph(ms: number): number {
  return ms * 3.6;
}

/** Convert km/h → m/s. */
export function kphToMs(kph: number): number {
  return kph / 3.6;
}

// ───────────────────────────────────────────────────────────────────────────
// Reverse solve: known ride → CdA
// ───────────────────────────────────────────────────────────────────────────

export interface CalibrationRide {
  /** Distance covered (km). */
  distanceKm: number;
  /** Total time (seconds). */
  durationSec: number;
  /** Average pedalled power (watts) — must be from a power meter. */
  avgPowerW: number;
}

export interface CdAResult {
  /** Estimated CdA (m²). */
  cda: number;
  /** Confidence: 'high' for solid power+flat course; 'medium' otherwise.
   *  We can't validate course flatness without GPS streams, so most user
   *  calibrations are 'medium' — better than a preset, not lab-grade. */
  confidence: 'high' | 'medium' | 'low';
  /** Average speed used in the inversion (kph) — surface to UI for sanity-check. */
  avgKph: number;
  /** Reason if calibration could not produce a sensible value. */
  reason?: 'invalid-input' | 'unphysical-cda';
}

/**
 * Solve CdA from a known ride. Inverts the power balance equation:
 *
 *   CdA = 2·(P·η − Crr·m·g·v − m·g·sinθ·v) / (ρ·v³)
 *
 * Should be called with a relatively flat, steady ride at known power.
 * Returns null-ish (with reason) if inputs are nonsensical or the math
 * produces an unphysical CdA (e.g. < 0.15 or > 0.50).
 */
export function solveCdA(
  ride: CalibrationRide,
  p: Omit<PowerBalanceParams, 'cda'>,
): CdAResult {
  if (
    !ride ||
    !isFinite(ride.distanceKm) || ride.distanceKm <= 0 ||
    !isFinite(ride.durationSec) || ride.durationSec <= 0 ||
    !isFinite(ride.avgPowerW) || ride.avgPowerW <= 0
  ) {
    return { cda: 0, confidence: 'low', avgKph: 0, reason: 'invalid-input' };
  }

  const v = (ride.distanceKm * 1000) / ride.durationSec; // m/s
  const Pnet = ride.avgPowerW * p.drivetrainEff;
  const rollingPower = p.crr * p.totalMassKg * G * v;
  const climbPower = p.totalMassKg * G * p.gradient * v;
  const aeroPower = Pnet - rollingPower - climbPower;

  if (aeroPower <= 0) {
    // All measured power went to climbing/rolling — implies negative CdA, which
    // means the rolling/climb assumptions are too aggressive for this ride.
    return { cda: 0, confidence: 'low', avgKph: msToKph(v), reason: 'unphysical-cda' };
  }

  const cda = (2 * aeroPower) / (p.airDensityKgM3 * v * v * v);

  // Sanity bounds — anything outside this is almost certainly bad input
  // (rolled drum, drafting, hilly course misclassified as flat, etc.).
  if (cda < 0.15 || cda > 0.50) {
    return { cda, confidence: 'low', avgKph: msToKph(v), reason: 'unphysical-cda' };
  }

  // Conservative confidence — without GPS-stream validation we treat all user
  // calibrations as 'medium'. A future iteration could parse Strava streams
  // and award 'high' for verified flat/no-stop rides.
  return { cda, confidence: 'medium', avgKph: msToKph(v) };
}

// ───────────────────────────────────────────────────────────────────────────
// W/kg tier — Coggan-style
// ───────────────────────────────────────────────────────────────────────────

export interface WattsPerKgTier {
  wkg: number;
  tier:
    | 'untrained'
    | 'recreational'
    | 'fair'
    | 'moderate'
    | 'good'
    | 'very-good'
    | 'excellent'
    | 'world-class';
  label: string;
}

/**
 * Map FTP/kg to a Coggan-style tier label. Coggan's 2003 tables differentiate
 * by sex; we use a sex-neutral mapping pinned to typical male age-grouper
 * cycling values, with the female table giving the same labels at lower
 * thresholds. For a triathlon UI, gendered tiers add complexity without
 * helping pacing decisions — the underlying watts is what predicts speed.
 */
export function wattsPerKgTier(ftpW: number, riderKg: number): WattsPerKgTier {
  if (!isFinite(ftpW) || ftpW <= 0 || !isFinite(riderKg) || riderKg <= 0) {
    return { wkg: 0, tier: 'untrained', label: 'Insufficient data' };
  }
  const wkg = ftpW / riderKg;
  // Thresholds from Coggan FTP/kg tables (male, 60-min power). Female tables
  // are ~10% lower at every tier; we use the male thresholds as the canonical
  // reference and accept that female athletes will appear one tier lower than
  // their relative-to-peers ranking. Tier label is informational only — the
  // physics solver uses watts directly.
  if (wkg < 2.62) return { wkg, tier: 'untrained',     label: 'Untrained' };
  if (wkg < 3.01) return { wkg, tier: 'fair',          label: 'Fair' };
  if (wkg < 3.40) return { wkg, tier: 'moderate',      label: 'Moderate' };
  if (wkg < 3.81) return { wkg, tier: 'good',          label: 'Good' };
  if (wkg < 4.20) return { wkg, tier: 'very-good',     label: 'Very good' };
  if (wkg < 4.81) return { wkg, tier: 'excellent',     label: 'Excellent' };
  if (wkg < 5.62) return { wkg, tier: 'world-class',   label: 'Exceptional' };
  return            { wkg, tier: 'world-class',     label: 'World-class' };
}

// ───────────────────────────────────────────────────────────────────────────
// Convenience builders
// ───────────────────────────────────────────────────────────────────────────

/**
 * Construct a default `BikeAeroProfile` for a given position. Crr defaults to
 * 'race-clincher'; consumers can override before saving.
 */
export function defaultAeroProfile(
  id: string,
  label: string,
  position: BikePosition,
  tire: BikeTire = 'race-clincher',
): BikeAeroProfile {
  return {
    id,
    label,
    position,
    cda: CDA_PRESET[position],
    cdaSource: 'preset',
    crr: CRR_PRESET[tire],
    tire,
    drivetrainEff: DEFAULT_DRIVETRAIN_EFF,
    airDensityKgM3: RHO_SEA_LEVEL,
  };
}

/**
 * Build a `PowerBalanceParams` from an aero profile + course + masses.
 * Applies the wind-loss factor so callers can pass the bare profile.
 */
export function paramsFromProfile(
  profile: BikeAeroProfile,
  riderKg: number,
  bikeKg: number,
  course: BikeCourseProfileExtended,
  kitKg: number = 2,
): PowerBalanceParams {
  return {
    totalMassKg: riderKg + bikeKg + kitKg,
    cda: profile.cda * WIND_LOSS_FACTOR[course],
    crr: profile.crr,
    drivetrainEff: profile.drivetrainEff,
    airDensityKgM3: profile.airDensityKgM3,
    gradient: COURSE_GRADIENT[course],
  };
}
