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
      // Session average includes recovery jogs — target Z4 not Z5
      return makeTarget('Z4', zones.z4, 'VO2max (session avg)');
    case 'race_pace':
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
      // Short reps with walk-back recovery — session average is lower
      return makeTarget('Z3-4', {
        min: zones.z3.min,
        max: zones.z4.max,
      }, 'Hills (session avg)');
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

/**
 * Calculate where an actual HR value lands relative to a target range.
 * Returns a normalized intensity score (1.0 = middle of target range).
 */
export function calculateIntensityScore(actualBpm: number, target: HRTarget): number {
  if (actualBpm <= 0) return 0;
  const range = target.max - target.min;
  if (range <= 0) return 1.0;

  // Normalized score: 0.5 at min, 1.5 at max
  return ((actualBpm - target.min) / range) + 0.5;
}

/**
 * Detect efficiency shift based on the gap between RPE and HR intensity.
 * Returns a multiplier to adjust the standard RPE-based VDOT change.
 */
export function calculateEfficiencyShift(
  rpe: number,
  expectedRpe: number,
  hrIntensity: number,
  workoutType: string
): number {
  const rpeDelta = rpe - expectedRpe;
  const hrDelta = hrIntensity - 1.0; // gap from target center
  const isInterval = ['vo2', 'intervals', 'hill_repeats'].includes(workoutType);
  const HR_THRESHOLD = 0.2; // Symmetric threshold — HR must deviate this much to matter

  // Scale with RPE magnitude: bigger RPE gap = bigger HR influence
  const rpeMag = Math.min(Math.abs(rpeDelta) / 3, 1.0);

  let shift = 0;

  if (rpeDelta === 0) {
    // RPE matched expected — HR provides standalone signal
    if (hrDelta < -HR_THRESHOLD) {
      shift = 0.15;   // HR below target = fitter than plan assumes
    } else if (hrDelta > HR_THRESHOLD) {
      shift = -0.15;  // HR above target = more fatigued than plan assumes
    }
  } else if (rpeDelta < 0) {
    // Felt easier than expected
    if (hrDelta < -HR_THRESHOLD) {
      shift = 0.3 * rpeMag;    // Pure efficiency — both signals agree
    } else if (hrDelta > HR_THRESHOLD) {
      shift = -0.25 * rpeMag;  // Cardio strain — felt easy but HR was high
    }
  } else {
    // Felt harder than expected
    if (hrDelta > HR_THRESHOLD) {
      shift = -0.15 * rpeMag;  // Legitimate struggle — both signals agree
    } else if (hrDelta < -HR_THRESHOLD && isInterval) {
      shift = -0.35 * rpeMag;  // Central fatigue — effort high but HR suppressed
    }
  }

  return shift;
}
