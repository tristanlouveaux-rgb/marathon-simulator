/**
 * universal-load-constants.ts
 * ===========================
 * Tunables for the Universal Load Currency + Cross-Sport Plan Adjustment system.
 * All values are designed to be conservative under low-quality data.
 */

// ---------------------------------------------------------------------------
// Matching & Similarity
// ---------------------------------------------------------------------------

/** Weight applied to anaerobic load in similarity calculations */
export const ANAEROBIC_WEIGHT = 1.5;

/** Threshold: credit must be >= this fraction of workout load to replace */
export const REPLACE_THRESHOLD = 0.95;

/** Minimum confidence required to allow replacement */
export const CONF_REPLACE_MIN = 0.75;

/** Smoothing factor for load similarity scoring */
export const LOAD_SMOOTHING = 30.0;

/** Weight of ratio score in vibe similarity */
export const RATIO_WEIGHT = 0.60;

/** Weight of load score in vibe similarity */
export const LOAD_WEIGHT = 0.40;

/** Bonus added to similarity if activity is on same day as workout */
export const SAME_DAY_BONUS = 0.15;

/** Penalty applied to long run similarity (harder to replace) */
export const LONG_PENALTY = 0.20;

// ---------------------------------------------------------------------------
// Distance Clamps
// ---------------------------------------------------------------------------

/** Minimum distance for easy runs after reduction (km) */
export const EASY_MIN_KM = 4.0;

/** Minimum distance for long runs after reduction (km) */
export const LONG_MIN_KM = 10.0;

/** Long run cannot go below this fraction of originally planned distance */
export const LONG_MIN_FRAC = 0.65;

// ---------------------------------------------------------------------------
// Run Preservation
// ---------------------------------------------------------------------------

/** Minimum number of runs to preserve in any week */
export const MIN_PRESERVED_RUNS = 2;

/** Max modifications in normal mode */
export const MAX_MODS_NORMAL = 2;

/** Max modifications in extreme mode */
export const MAX_MODS_EXTREME = 3;

// ---------------------------------------------------------------------------
// Extreme Session Detection
// ---------------------------------------------------------------------------

/** If FCL >= this fraction of planned weekly load, trigger extreme mode */
export const EXTREME_WEEK_PCT = 0.55;

/** If HR-only and time in Z2+ >= this many minutes, trigger extreme mode */
export const EXTREME_HR_ZONE2_PLUS_MIN = 150;

/** If RPE-only and duration >= this AND RPE >= EXTREME_RPE_LEVEL, trigger extreme */
export const EXTREME_RPE_DURATION_MIN = 120;

/** RPE level threshold for extreme mode (with duration check) */
export const EXTREME_RPE_LEVEL = 7;

// ---------------------------------------------------------------------------
// Saturation Curve (for Replacement Credit only)
// ---------------------------------------------------------------------------

/** Time constant for saturation curve */
export const TAU = 800;

/** Maximum credit from any single session */
export const CREDIT_MAX = 1500;

// ---------------------------------------------------------------------------
// Tier C (RPE-only) Adjustments
// ---------------------------------------------------------------------------

/** Uncertainty penalty for RPE-only calculations */
export const RPE_UNCERTAINTY_PENALTY = 0.80;

/**
 * Active fraction by sport (0..1).
 * Accounts for intermittent nature of many sports.
 * e.g., padel has lots of rest between points → 0.60
 */
export const ACTIVE_FRACTION_BY_SPORT: Record<string, number> = {
  padel: 0.60,
  tennis: 0.65,
  soccer: 0.70,
  rugby: 0.75,
  basketball: 0.70,
  martial_arts: 0.75,
  boxing: 0.75,
  crossfit: 0.75,
  climbing: 0.55,
  strength: 0.70,
  dancing: 0.80,
  walking: 0.95,
  cycling: 0.95,
  swimming: 0.90,
  rowing: 0.95,
  elliptical: 0.95,
  hiking: 0.85,
  skiing: 0.85,
  skating: 0.85,
  stair_climbing: 0.85,
  jump_rope: 0.80,
  yoga: 0.50,
  pilates: 0.55,
  extra_run: 1.00,
  // Default for unknown sports
  default: 0.75,
};

/** Get active fraction for a sport (with default fallback) */
export function getActiveFraction(sportKey: string): number {
  return ACTIVE_FRACTION_BY_SPORT[sportKey] ?? ACTIVE_FRACTION_BY_SPORT.default;
}

// ---------------------------------------------------------------------------
// RPE → Load per Minute Mapping (Tier C)
// ---------------------------------------------------------------------------

/** Load per minute by RPE (aligned with Garmin scale) */
export const LOAD_PER_MIN_BY_RPE: Record<number, number> = {
  1: 0.5,   // Recovery
  2: 0.8,   // Easy
  3: 1.1,   // Easy-moderate
  4: 1.6,   // Moderate
  5: 2.0,   // Moderate-hard
  6: 2.7,   // Tempo
  7: 3.5,   // Threshold
  8: 4.5,   // VO2
  9: 5.3,   // Very hard
  10: 6.0,  // Max
};

// ---------------------------------------------------------------------------
// RPE → Aerobic/Anaerobic Split (Tier C)
// ---------------------------------------------------------------------------

/**
 * Aerobic fraction by RPE band.
 * Spec:
 *   RPE 1-4: 95/5
 *   RPE 5-6: 85/15
 *   RPE 7:   70/30
 *   RPE 8:   55/45
 *   RPE 9-10: 40/60
 */
export const RPE_AEROBIC_SPLIT: Record<number, number> = {
  1: 0.95,
  2: 0.95,
  3: 0.95,
  4: 0.95,
  5: 0.85,
  6: 0.85,
  7: 0.70,
  8: 0.55,
  9: 0.40,
  10: 0.40,
};

// ---------------------------------------------------------------------------
// Tier B (HR-only) Zone Weights
// ---------------------------------------------------------------------------

/** Zone weights for TRIMP-like calculation */
export const HR_ZONE_WEIGHTS: [number, number, number, number, number] = [1, 2, 3, 4, 5];

/** Confidence for Tier B based on data completeness */
export const TIER_B_CONFIDENCE_FULL = 0.85;
export const TIER_B_CONFIDENCE_PARTIAL = 0.75;

// ---------------------------------------------------------------------------
// Tier Confidence Values
// ---------------------------------------------------------------------------

/** Confidence for Tier A (Garmin) */
export const TIER_A_CONFIDENCE = 0.90;

/** Confidence range for Tier C (RPE-only) */
export const TIER_C_CONFIDENCE_HIGH_RPE = 0.55;  // RPE 1-4 or 8-10 (extreme = unreliable)
export const TIER_C_CONFIDENCE_MID_RPE = 0.70;   // RPE 5-7 (most reliable for estimation)

// ---------------------------------------------------------------------------
// Goal-Distance Adjustment for RRC
// ---------------------------------------------------------------------------

/**
 * Adjust RRC based on goal distance and session's anaerobic ratio.
 * Marathon/HM: favor aerobic sessions, penalize anaerobic
 * 5k/10k: allow more credit for anaerobic sessions
 */
export function computeGoalFactor(
  anaerobicRatio: number,
  goalDistance: string
): number {
  // anaerobicRatio = anaerobicLoad / baseLoad (0..1)
  if (goalDistance === 'marathon' || goalDistance === 'half') {
    // 1.05 for pure aerobic, down to 0.85 for pure anaerobic
    return 1.05 - 0.20 * anaerobicRatio;
  } else {
    // 5k/10k: 0.95 for pure aerobic, up to 1.15 for pure anaerobic
    return 0.95 + 0.20 * anaerobicRatio;
  }
}

// ---------------------------------------------------------------------------
// Equivalence Calculation
// ---------------------------------------------------------------------------

/** Average load per km for easy running (for equivalence messaging) */
export const EASY_LOAD_PER_KM = 12;

/** Maximum equivalent km shown in UI (cap for sanity) */
export const MAX_EQUIVALENT_EASY_KM = 25;
