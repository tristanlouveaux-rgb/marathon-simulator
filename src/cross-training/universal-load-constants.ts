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

/**
 * Smoothing factor for load similarity scoring (TSS units).
 * Was 30 in the old Garmin units; re-denominated 2026-06-04 via the
 * easy-anchor ratio (30 ÷ 1.63 ≈ 18.4) so load-delta sensitivity in
 * vibeSimilarity is unchanged now that both inputs are canonical TSS (B2).
 */
export const LOAD_SMOOTHING = 18.4;

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

/**
 * Saturation scale for a single session's replacement credit (TSS).
 *
 * Curve: credit = TAU × (1 − e^(−raw/TAU)). One parameter; slope exactly 1 at
 * the origin, asymptote TAU. A credit can therefore never EXCEED its raw load
 * — saturation is a cap, as the spec intended.
 *
 * HISTORY (ISSUE-263): the old two-parameter form CREDIT_MAX(1−e^(−raw/TAU))
 * with CREDIT_MAX=1500, TAU=800 had slope CREDIT_MAX/TAU = 1.875 at zero — it
 * AMPLIFIED every realistic session's credit ~1.6–1.9×. That amplification was
 * accidentally compensating for the budget-vs-cuts scale mismatch (B1): a
 * TSS-ish budget was inflated to roughly Garmin-cut currency. With every
 * pipeline canonical TSS, the amplification is a pure bug, so the slope-1 form
 * replaces it. TAU = 491 derives from the old time constant re-denominated to
 * TSS (800 ÷ 1.63 easy-anchor ratio) — compression starts gently around
 * ~100 TSS (0.9×) and a monster session saturates toward 491 TSS.
 */
export const TAU = 491;

/**
 * @deprecated ISSUE-263: the separate CREDIT_MAX asymptote is gone — the
 * slope-1 saturation curve uses TAU as its single parameter (see above).
 * Kept as an alias so legacy imports fail loudly in review, not silently.
 */
export const CREDIT_MAX = TAU;

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
// REMOVED 2026-06-04 (ISSUE-263): the old LOAD_PER_MIN_BY_RPE table here was a
// THIRD per-minute scale ("aligned with Garmin scale" but disagreeing with
// LOAD_PER_MIN_BY_INTENSITY at several RPEs). Tier C now reads the canonical
// TL_PER_MIN table from '@/constants' directly — one RPE→TSS curve everywhere.

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

/** Relative zone weights for TRIMP-like calculation (Z1..Z5 linear ramp) */
export const HR_ZONE_WEIGHTS: [number, number, number, number, number] = [1, 2, 3, 4, 5];

/**
 * Per-zone TSS per minute (canonical, ISSUE-263).
 * Derived, not invented: the existing 1:2:3:4:5 relative ramp anchored to the
 * TSS definition — Z4 is the threshold zone, and 1 h at threshold = 100 TSS,
 * so Z4 = 100/60 per minute and the rest scale linearly. Hourly values:
 * [25, 50, 75, 100, 125]. Sanity vs IF²×100: Z1 25/h → IF 0.50 (recovery),
 * Z2 50/h → IF 0.71 (easy), Z3 75/h → IF 0.87 (tempo), Z5 125/h → IF 1.12
 * (VO2) — the linear ramp lands on physiologically sensible intensity factors.
 */
export const HR_ZONE_TSS_PER_MIN: [number, number, number, number, number] =
  HR_ZONE_WEIGHTS.map(w => (w * 100) / (HR_ZONE_WEIGHTS[3] * 60)) as [number, number, number, number, number];

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

/**
 * Average TSS per km of easy running (for equivalence messaging).
 * Derived: default easy pace 6:00/km (the same 360 s/km default the suggester
 * uses for ctx.easyPaceSecPerKm) × TL_PER_MIN[4] (easy RPE4 = 0.92 TSS/min)
 * = 5.52 TSS/km. Replaces the old EASY_LOAD_PER_KM = 12 (Garmin units), which
 * disagreed with two other orphan easy-km constants (35 and "15 load/TSS") —
 * all three are now retired in favour of this single derived value.
 */
export const EASY_LOAD_PER_KM = 5.52;

/** Maximum equivalent km shown in UI (cap for sanity) */
export const MAX_EQUIVALENT_EASY_KM = 25;
