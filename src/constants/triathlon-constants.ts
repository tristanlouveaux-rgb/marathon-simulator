/**
 * Triathlon blessed constants. Every value here is sourced from literature or
 * coaching consensus and was explicitly confirmed during the 2026-04-23 spec
 * review. Do not invent additions here — add via the spec-review workflow
 * (docs/TRIATHLON.md §18) and cite.
 *
 * **Tracking vs planning**: this file holds constants from both sides. The
 * `RUN_FATIGUE_DISCOUNT_*` values are *tracking* (race-time prediction) only.
 * They must never be applied to training-load calculations (§18.4).
 */

import type { TriathlonDistance, TriVolumeSplit } from '../types/triathlon';

// ───────────────────────────────────────────────────────────────────────────
// Load model
// ───────────────────────────────────────────────────────────────────────────

/** Swim TSS intensity exponent. Water drag scales with v³ (Toussaint & Beek 1992). */
export const SWIM_TSS_INTENSITY_EXPONENT = 3;

/** Bike TSS intensity exponent. Coggan 2003 — IF² for power-based TSS. */
export const BIKE_TSS_INTENSITY_EXPONENT = 2;

/** Run TSS intensity exponent. Matches the existing running-mode calculation. */
export const RUN_TSS_INTENSITY_EXPONENT = 2;

/** CTL time constant in days. Banister 1975. Same for all disciplines. */
export const CTL_TAU_DAYS = 42;

/** ATL time constant in days. Banister 1975. Same for all disciplines. */
export const ATL_TAU_DAYS = 7;

/** ACWR safe range. Matches running-mode default (Gabbett 2016). */
export const ACWR_SAFE_LOW = 0.8;
export const ACWR_SAFE_HIGH = 1.3;

/** Weekly per-discipline volume ramp cap — upper bound of Gabbett 2016 5–10% range. */
export const WEEKLY_VOLUME_RAMP_CAP = 0.10;

// ───────────────────────────────────────────────────────────────────────────
// Race prediction (TRACKING side only — never apply to training load)
// ───────────────────────────────────────────────────────────────────────────

/** 70.3 run-leg pace discount after 90 km bike. Bentley 2007; Landers 2008 (midpoint 4–6%). */
export const RUN_FATIGUE_DISCOUNT_70_3 = 0.05;

/** IM run-leg pace discount after 180 km bike. Bentley 2007; Landers 2008 (midpoint 10–12%). */
export const RUN_FATIGUE_DISCOUNT_IRONMAN = 0.11;

/** Default transition estimates (seconds) by skill level. Beginners → experienced. Rough coaching ranges. */
export const T1_SEC_BY_SLIDER: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 540,   // 9 min — first-timer fumbling through
  2: 360,   // 6 min
  3: 240,   // 4 min
  4: 180,   // 3 min
  5: 120,   // 2 min — experienced age-grouper
};

export const T2_SEC_BY_SLIDER: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 360,
  2: 240,
  3: 180,
  4: 150,
  5: 120,
};

// ───────────────────────────────────────────────────────────────────────────
// Periodisation
// ───────────────────────────────────────────────────────────────────────────

/** Taper duration ranges in days. Lower bound used for "tight" taper, upper for "conservative". */
export const TAPER_DAYS: Record<TriathlonDistance, [number, number]> = {
  '70.3':    [7, 10],
  'ironman': [14, 21],
};

/** Default plan durations in weeks. Lower bound = aggressive, upper = typical. */
export const PLAN_WEEKS_DEFAULT: Record<TriathlonDistance, number> = {
  '70.3':    20,
  'ironman': 24,
};

/** Phase length defaults (weeks). Sum should roughly equal plan length minus taper. */
export const PHASE_WEEKS: Record<TriathlonDistance, { base: number; build: number; peak: number }> = {
  '70.3':    { base: 8, build: 6, peak: 4 },
  'ironman': { base: 10, build: 7, peak: 5 },
};

// ───────────────────────────────────────────────────────────────────────────
// Volume
// ───────────────────────────────────────────────────────────────────────────

/** Default recommended split. User can override in the onboarding split picker. */
export const DEFAULT_VOLUME_SPLIT: TriVolumeSplit = {
  swim: 0.175,
  bike: 0.475,
  run:  0.350,
};

/** Typical weekly peak hours by distance × skill level. Used when no user time-available input is provided. */
export const DEFAULT_WEEKLY_PEAK_HOURS: Record<TriathlonDistance, Record<1 | 2 | 3 | 4 | 5, number>> = {
  '70.3': {
    1: 6,   2: 8,   3: 10,  4: 13,  5: 16,
  },
  'ironman': {
    1: 10,  2: 13,  3: 16,  4: 20,  5: 25,
  },
};

/**
 * Weekly hours slider bounds by distance. Min is the lowest a realistic plan
 * generator should accept; max accommodates elites (IM pros routinely peak
 * 25–30h/week). Raised from a flat 4–20 range after user review (§1
 * feedback, 2026-04-24).
 */
export const HOURS_RANGE: Record<TriathlonDistance, { min: number; max: number }> = {
  '70.3':    { min: 5, max: 20 },
  'ironman': { min: 6, max: 30 },
};

// ───────────────────────────────────────────────────────────────────────────
// Detraining (planning side — VDOT unchanged, CSS and FTP added for tri)
// ───────────────────────────────────────────────────────────────────────────

/** FTP loss per 4 weeks off. Coyle 1984 — cycling detraining studies. */
export const FTP_DETRAINING_PER_4WK = 0.06;  // Midpoint of 5–7%

/** CSS loss per 4 weeks off. Mujika 2010 — swim technique retention buffers the loss. */
export const CSS_DETRAINING_PER_4WK = 0.04;  // Midpoint of 3–5%

// ───────────────────────────────────────────────────────────────────────────
// Physiological offsets (used when only one threshold is known)
// ───────────────────────────────────────────────────────────────────────────

/** Cycling LTHR offset vs running LTHR (bpm). Cyclists run lower — Millet & Vleck 2000. */
export const BIKE_LTHR_OFFSET_VS_RUN = -7;  // Midpoint of −5 to −10

/** Brick detection window in seconds. Two sequential activities within this gap are treated as a brick. */
export const BRICK_DETECTION_WINDOW_SEC = 30 * 60;  // 30 min — §18.1

// ───────────────────────────────────────────────────────────────────────────
// Distance constants
// ───────────────────────────────────────────────────────────────────────────

export const RACE_LEG_DISTANCES: Record<TriathlonDistance, { swimM: number; bikeKm: number; runKm: number }> = {
  '70.3':    { swimM: 1900, bikeKm: 90,    runKm: 21.1 },
  'ironman': { swimM: 3800, bikeKm: 180.2, runKm: 42.2 },
};
