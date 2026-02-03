/**
 * Heart Rate Zone Engine
 *
 * Hierarchical zone calculation:
 *   Priority 1: Lactate Threshold HR (LTHR) — most accurate
 *   Priority 2: Heart Rate Reserve / Karvonen (Max + Resting HR)
 *   Priority 3: Max HR only
 *   Priority 4: Age-based estimates
 *
 * Returns undefined if insufficient data for any method.
 */

/** Heart rate profile input */
export interface HRProfile {
  lthr?: number;       // Lactate threshold heart rate
  maxHR?: number;      // Max heart rate
  restingHR?: number;  // Resting heart rate
  age?: number;        // Age in years
}

/** Heart rate zones (BPM ranges) */
export interface HRZones {
  method: 'lthr' | 'karvonen' | 'maxhr' | 'age';
  z1: { min: number; max: number };  // Recovery / Active Recovery
  z2: { min: number; max: number };  // Aerobic / Easy
  z3: { min: number; max: number };  // Tempo
  z4: { min: number; max: number };  // Threshold
  z5: { min: number; max: number };  // VO2max+
}

/** Workout HR target */
export interface HRTarget {
  zone: string;       // e.g. "Z2", "Z4"
  min: number;        // Min BPM
  max: number;        // Max BPM
  label: string;      // e.g. "135-145 bpm (Zone 2)"
}

/**
 * Calculate HR zones from profile, using best available method.
 * Returns undefined if no usable data.
 */
export function calculateZones(profile: HRProfile): HRZones | undefined {
  // Priority 1: LTHR-based zones
  if (profile.lthr && profile.lthr > 100) {
    return lthrZones(profile.lthr);
  }

  // Priority 2: Karvonen (Max + Resting)
  if (profile.maxHR && profile.restingHR && profile.maxHR > profile.restingHR) {
    return karvonenZones(profile.maxHR, profile.restingHR);
  }

  // Priority 3: Max HR only
  if (profile.maxHR && profile.maxHR > 100) {
    return maxHRZones(profile.maxHR);
  }

  // Priority 4: Age-based
  if (profile.age && profile.age > 10 && profile.age < 100) {
    const estimatedMax = 220 - profile.age;
    return maxHRZones(estimatedMax);
  }

  return undefined;
}

/** LTHR-based zones — gold standard */
function lthrZones(lthr: number): HRZones {
  return {
    method: 'lthr',
    z1: { min: Math.round(lthr * 0.65), max: Math.round(lthr * 0.80) },
    z2: { min: Math.round(lthr * 0.80), max: Math.round(lthr * 0.89) },
    z3: { min: Math.round(lthr * 0.89), max: Math.round(lthr * 0.95) },
    z4: { min: Math.round(lthr * 0.95), max: Math.round(lthr * 1.00) },
    z5: { min: Math.round(lthr * 1.00), max: Math.round(lthr * 1.10) },
  };
}

/** Karvonen / Heart Rate Reserve zones */
function karvonenZones(maxHR: number, restingHR: number): HRZones {
  const hrr = maxHR - restingHR;
  const bpm = (pct: number) => Math.round(restingHR + hrr * pct);
  return {
    method: 'karvonen',
    z1: { min: bpm(0.50), max: bpm(0.60) },
    z2: { min: bpm(0.60), max: bpm(0.70) },
    z3: { min: bpm(0.70), max: bpm(0.80) },
    z4: { min: bpm(0.80), max: bpm(0.90) },
    z5: { min: bpm(0.90), max: bpm(1.00) },
  };
}

/** Max HR percentage zones */
function maxHRZones(maxHR: number): HRZones {
  const bpm = (pct: number) => Math.round(maxHR * pct);
  return {
    method: 'maxhr',
    z1: { min: bpm(0.50), max: bpm(0.60) },
    z2: { min: bpm(0.60), max: bpm(0.70) },
    z3: { min: bpm(0.70), max: bpm(0.80) },
    z4: { min: bpm(0.80), max: bpm(0.90) },
    z5: { min: bpm(0.90), max: bpm(1.00) },
  };
}

/**
 * Get HR target for a workout type.
 * Returns undefined if zones are not available.
 */
export function getWorkoutHRTarget(workoutType: string, zones: HRZones | undefined): HRTarget | undefined {
  if (!zones) return undefined;

  switch (workoutType) {
    case 'easy':
      return makeTarget('Z2', zones.z2, 'Easy');
    case 'long':
      // Upper Z2 for long runs
      return makeTarget('Z2', {
        min: zones.z2.min,
        max: Math.min(zones.z2.max, zones.z3.min),
      }, 'Long Run');
    case 'threshold':
    case 'marathon_pace':
      return makeTarget('Z4', zones.z4, 'Threshold');
    case 'vo2':
    case 'intervals':
      return makeTarget('Z5', zones.z5, 'VO2max');
    case 'race_pace':
      // Between Z3 and Z4
      return makeTarget('Z3-4', {
        min: zones.z3.min,
        max: zones.z4.max,
      }, 'Race Pace');
    case 'mixed':
    case 'progressive':
      return makeTarget('Z3-4', {
        min: zones.z3.min,
        max: zones.z4.max,
      }, 'Mixed');
    case 'hill_repeats':
      return makeTarget('Z4-5', {
        min: zones.z4.min,
        max: zones.z5.max,
      }, 'Hills');
    default:
      return undefined;
  }
}

function makeTarget(zone: string, range: { min: number; max: number }, name: string): HRTarget {
  return {
    zone,
    min: range.min,
    max: range.max,
    label: `${range.min}-${range.max} bpm (${zone})`,
  };
}
