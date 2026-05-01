/**
 * Per-discipline effort scoring for triathlon activities.
 *
 * The running side has `computeHREffortScore` (HR-zone-based) and
 * `computePaceAdherence` (pace-vs-target ratio). For swim and bike we need
 * sport-specific equivalents:
 *
 *   - Swim: pace adherence vs CSS-derived target pace; HR effort uses zones.
 *   - Bike: power adherence vs FTP-derived target watts when power is present;
 *     HR-based fallback when no power.
 *
 * Run leg reuses the existing helpers — exported here for symmetry.
 *
 * **Side of the line**: tracking. Pure functions over a `GarminActual` and
 * the relevant benchmarks. Outputs are stored back onto `GarminActual` so the
 * adaptation ratio + plan reactivity can both consume them.
 */

import type { GarminActual, SimulatorState } from '@/types/state';
import type { Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { BIKE_LTHR_OFFSET_VS_RUN } from '@/constants/triathlon-constants';

export interface TriEffortScores {
  /** Pace ratio (1.0 = on target, 1.1 = 10% slower than target). Null if no target. */
  paceAdherence: number | null;
  /** HR effort score (0.5–1.5; 0.9–1.1 = on target). Mirrors running shape. */
  hrEffortScore: number | null;
  /** Bike-only — power adherence (1.0 = on target). Null for non-bike or no power. */
  powerAdherence?: number | null;
  /** Bike-only — Intensity Factor (NP/FTP). Null when NP or FTP missing. */
  intensityFactor?: number | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Workout-type → target (per discipline)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Bike target IF (Intensity Factor = NP / FTP) by workout type. Anchors from
 * Coggan & Allen 2019 Ch. 4 — typical IF ranges per session category.
 */
const BIKE_TARGET_IF: Record<string, number> = {
  bike_endurance:   0.65,  // Z2 endurance
  bike_tempo:       0.80,  // Z3 tempo
  bike_sweet_spot:  0.88,  // SST
  bike_threshold:   0.95,  // Z4 threshold (sub-FTP intervals)
  bike_vo2:         1.10,  // Z5 VO2max repeats — short bursts above FTP
  bike_hills:       0.90,  // Sustained climbs
};

/**
 * Swim target pace as fraction of CSS pace. Lower fraction = slower than CSS.
 * Most swim sessions sit just below CSS or right on it.
 *   - Endurance/technique: ~85% (slow aerobic)
 *   - Threshold (CSS sets): 100% (at CSS)
 *   - Speed: 105% (above CSS, very short)
 */
const SWIM_TARGET_CSS_FRACTION: Record<string, number> = {
  swim_technique:  0.85,
  swim_endurance:  0.90,
  swim_threshold:  1.00,
  swim_speed:      1.05,
  swim_openwater:  0.92,
};

// ───────────────────────────────────────────────────────────────────────────
// HR effort scoring — shared math (Karvonen-style HR reserve vs target zone)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Map a target IF to an HR-reserve fraction. At LTHR, HR reserve fraction
 * equals `lthrReserve = (LTHR - rest) / (max - rest)`. Workouts at IF 1.0
 * sit at LTHR; sub-threshold scales linearly.
 *
 * Score interpretation mirrors `computeHREffortScore` from `heart-rate.ts`:
 * 0.5–1.5 range, 0.9–1.1 = on target. >1.1 = overcooked, <0.9 = undercooked.
 */
function scoreHrEffort(
  avgHr: number,
  targetIf: number,
  ltHrBpm: number,
  restingHrBpm: number,
  maxHrBpm: number,
): number | null {
  if (!avgHr || avgHr <= 0 || !ltHrBpm || ltHrBpm <= 0) return null;
  if (!restingHrBpm || !maxHrBpm || maxHrBpm <= restingHrBpm) return null;
  const reserve = maxHrBpm - restingHrBpm;
  const lthrReserve = (ltHrBpm - restingHrBpm) / reserve;
  const hrReserve = (avgHr - restingHrBpm) / reserve;
  // Target HR-reserve = lthrReserve × targetIf (linear scaling — accurate at
  // sub-threshold and around threshold; deviates at supra-threshold but those
  // sessions are short so error doesn't compound).
  const targetReserve = Math.max(0.01, lthrReserve * targetIf);
  // Same shape as computeHREffortScore: 1.0 + (deviation from midpoint × 0.5)
  // bounded to [0.5, 1.5].
  const score = 1.0 + (hrReserve - targetReserve) / targetReserve * 0.5;
  return Math.max(0.5, Math.min(1.5, Math.round(score * 100) / 100));
}

// ───────────────────────────────────────────────────────────────────────────
// Bike effort scoring
// ───────────────────────────────────────────────────────────────────────────

export function scoreBikeEffort(
  actual: GarminActual,
  workout: Workout | undefined,
  ftp: number | undefined,
  hrProfile?: { ltHR?: number | null; restingHR?: number | null; maxHR?: number | null },
): TriEffortScores {
  let intensityFactor: number | null = null;
  let powerAdherence: number | null = null;
  let hrEffortScore: number | null = null;

  // Power-meter primary path (Coggan & Allen Ch. 4).
  if (actual.normalizedPowerW != null && ftp != null && ftp > 0) {
    intensityFactor = actual.normalizedPowerW / ftp;
    const targetIf = workout ? BIKE_TARGET_IF[workout.t] : undefined;
    if (targetIf != null) {
      powerAdherence = intensityFactor / targetIf;
    }
  }

  // HR cross-check (when power present) OR primary fallback (when no power).
  // Uses bike LTHR derived from running LTHR via Millet & Vleck 2000 fixed
  // -7 bpm offset (BIKE_LTHR_OFFSET_VS_RUN).
  if (
    actual.avgHR != null && actual.avgHR > 0 &&
    hrProfile?.ltHR && hrProfile.restingHR && hrProfile.maxHR &&
    workout
  ) {
    const targetIf = BIKE_TARGET_IF[workout.t];
    if (targetIf != null) {
      const bikeLthr = hrProfile.ltHR + BIKE_LTHR_OFFSET_VS_RUN;
      hrEffortScore = scoreHrEffort(
        actual.avgHR,
        targetIf,
        bikeLthr,
        hrProfile.restingHR,
        hrProfile.maxHR,
      );
    }
  }

  return {
    paceAdherence: null,
    hrEffortScore,
    powerAdherence,
    intensityFactor,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Swim effort scoring
// ───────────────────────────────────────────────────────────────────────────

export function scoreSwimEffort(
  actual: GarminActual,
  workout: Workout | undefined,
  cssSecPer100m: number | undefined,
): TriEffortScores {
  let paceAdherence: number | null = null;

  // Swim pace from distance + duration — sec/100m
  if (actual.distanceKm != null && actual.durationSec != null && actual.distanceKm > 0) {
    const actualPaceSecPer100m = actual.durationSec / (actual.distanceKm * 10);
    if (cssSecPer100m != null && cssSecPer100m > 0 && workout) {
      const cssFraction = SWIM_TARGET_CSS_FRACTION[workout.t];
      if (cssFraction != null) {
        // Target pace = CSS / cssFraction (faster fraction → slower target sec/100m).
        const targetPaceSecPer100m = cssSecPer100m / cssFraction;
        // Lower sec/100m = faster. Adherence > 1.0 = slower than target.
        paceAdherence = actualPaceSecPer100m / targetPaceSecPer100m;
      }
    }
  }

  return {
    paceAdherence,
    hrEffortScore: null,  // Could add via zones; deferred.
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level dispatch
// ───────────────────────────────────────────────────────────────────────────

export function scoreTriEffort(
  discipline: Discipline,
  actual: GarminActual,
  workout: Workout | undefined,
  benchmarks: { ftp?: number; cssSecPer100m?: number },
  hrProfile?: { ltHR?: number | null; restingHR?: number | null; maxHR?: number | null },
): TriEffortScores {
  switch (discipline) {
    case 'bike': return scoreBikeEffort(actual, workout, benchmarks.ftp, hrProfile);
    case 'swim': return scoreSwimEffort(actual, workout, benchmarks.cssSecPer100m);
    case 'run':
      // Run leg uses the existing running-side helpers via the matcher's
      // existing scoring path (`getHREffort`, `getPaceAdherence`). Return
      // pre-computed values from the actual.
      return {
        paceAdherence: actual.paceAdherence ?? null,
        hrEffortScore: actual.hrEffortScore ?? null,
      };
  }
}

/**
 * Convenience: pull HR profile from state for callers that have state but
 * not the unpacked values. Mirrors how the running-side matcher reads them.
 */
export function hrProfileFromState(state: SimulatorState): { ltHR?: number | null; restingHR?: number | null; maxHR?: number | null } {
  return {
    ltHR: state.ltHR ?? null,
    restingHR: state.restingHR ?? null,
    maxHR: state.maxHR ?? null,
  };
}
