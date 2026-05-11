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

/**
 * Time cost of putting socks on once during a triathlon. Modelled as a
 * single one-time event — the athlete either does it at T1 (default), at
 * T2, or never. The 20s figure is the practised-athlete steady state from
 * coaching consensus (Joe Friel, Tower 26, TrainingPeaks: 15–30s once
 * rehearsed). See SCIENCE_LOG §W for references and rationale.
 *
 * Population baseline T1/T2 (empirical data) already reflects T1 sock-on —
 * the default. `triConfig.transitionSocks` shifts or removes that cost:
 *   't1':   no adjustment (matches baseline)
 *   't2':   −SOCK_ON_COST_SEC on T1, +SOCK_ON_COST_SEC on T2 (shift)
 *   'none': −SOCK_ON_COST_SEC on T1 only (removed)
 */
export const SOCK_ON_COST_SEC = 20;

/**
 * T1 share of combined transition time, used when only a combined T1+T2 mean
 * is available (Ironman dataset has no per-side split). Derived from the
 * 70.3 dataset where typical-finisher bins (4–6 h moving time) show
 * T1 / (T1+T2) ≈ 0.58 — T1 is longer because of the wetsuit strip and
 * longer transition-zone walks at most venues.
 */
export const IM_T1_SHARE_OF_TOTAL = 0.58;

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

/**
 * Resolve the four-phase split (base/build/peak/taper) for a plan of a given
 * length. Returns canonical PHASE_WEEKS when the plan is long enough; for
 * shorter plans, weeks are compressed proportionally with priority order
 * taper > peak > build > base. Base is sacrificed first because an athlete
 * signing up for a race typically already has aerobic foundation — what
 * they're short of is race-specific work and a taper.
 *
 * Taper: clamped to [1, 2] weeks. Floor at 1 because race week itself is
 * taper; cap at 2 because detraining begins to bite beyond two weeks of
 * reduced volume (Mujika & Padilla 2003).
 *
 * Peak: floored at 1 whenever there's at least 1 non-taper week to spend —
 * the race-specific phase is the last to drop.
 */
export function phasesForLen(
  distance: TriathlonDistance,
  totalWeeks: number,
): { base: number; build: number; peak: number; taper: number } {
  const def = PHASE_WEEKS[distance];
  const total = Math.max(1, Math.round(totalWeeks));

  const taper = Math.max(1, Math.min(2, Math.ceil(total * 0.10)));
  const remaining = total - taper;
  if (remaining <= 0) {
    return { base: 0, build: 0, peak: 0, taper: total };
  }

  const sum = def.base + def.build + def.peak;
  let peak  = Math.max(1, Math.round((remaining * def.peak)  / sum));
  let build = Math.max(0, Math.round((remaining * def.build) / sum));
  let base  = remaining - peak - build;

  // Defensive: if rounding pushed peak+build above remaining, take it back
  // out of build first, then peak, so total weeks always equals totalWeeks.
  if (base < 0) {
    const overshoot = -base;
    const fromBuild = Math.min(build, overshoot);
    build -= fromBuild;
    const leftover = overshoot - fromBuild;
    if (leftover > 0) peak = Math.max(1, peak - leftover);
    base = 0;
  }

  return { base, build, peak, taper };
}

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
  '70.3':    { min: 4, max: 20 },
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
// Adaptation engine — auto-progression
// ───────────────────────────────────────────────────────────────────────────

/**
 * Trailing window for per-discipline effort score. Mirrors running's
 * `getTrailingEffortScore` (`src/calculations/fitness-model.ts:234`).
 */
export const TRI_EFFORT_LOOKBACK_WEEKS = 2;

/**
 * Bounds for the per-discipline effort multiplier applied to upcoming session
 * durations. Mirrors running's `effortMultiplier` (`src/workouts/plan_engine.ts:113`):
 * formula `1 - score * 0.05`, clamped [0.85, 1.15].
 *   - Score < 0 (rated easier than planned) → multiplier > 1.0 → longer next week
 *   - Score > 0 (rated harder than planned) → multiplier < 1.0 → shorter next week
 */
export const TRI_EFFORT_MULT_BOUNDS: readonly [number, number] = [0.85, 1.15] as const;

/**
 * Race-outcome retrospective threshold. Show the "you beat your prediction"
 * card on stats only when the athlete came in at least this many seconds
 * faster than predicted. Below this we still log but don't surface — the user
 * shouldn't see a noisy "you came in 30s under!" celebration.
 */
export const TRI_RACE_OUTCOME_POSITIVE_THRESHOLD_SEC = 60;

/**
 * Per-session-type power tolerance band (half-width, as a fraction of target watts).
 * Within the band, powerAdherence is soft-gradient (attenuated signal, not zero).
 * Outside the band, the raw deviation drives the effort multiplier at full weight.
 *
 * Tighter for quality sessions (threshold, over-unders) where hitting the zone
 * matters. Looser for endurance, VO2 repeats, and terrain-dependent sessions.
 * Values from Coggan & Allen 2019 acceptable power variance per zone.
 */
export const BIKE_ADHERENCE_BAND: Record<string, number> = {
  bike_endurance:  0.10,
  bike_tempo:      0.08,
  bike_sweet_spot: 0.06,
  bike_threshold:  0.05,
  bike_over_under: 0.05,
  bike_vo2:        0.08,
  bike_vo2_micros: 0.08,
  bike_hills:      0.08,
  bike_vlamax:     0.10,
};

// ───────────────────────────────────────────────────────────────────────────
// Adaptation transparency — marker auto-bump notification thresholds
// ───────────────────────────────────────────────────────────────────────────
// These drive the small "your FTP just improved" toast (CLAUDE.md →
// Adaptation transparency rule). Confirmed values 2026-04-30.

/** Minimum FTP delta (W) before we surface a "your FTP improved" toast. */
export const MARKER_BUMP_THRESHOLD_FTP_W = 5;

/** Minimum CSS delta (sec/100m) before we surface a "your CSS improved" toast. */
export const MARKER_BUMP_THRESHOLD_CSS_SEC = 5;

/** Minimum VDOT delta (points) before we surface a "your VDOT improved" toast. */
export const MARKER_BUMP_THRESHOLD_VDOT = 1;

// ───────────────────────────────────────────────────────────────────────────
// Distance constants
// ───────────────────────────────────────────────────────────────────────────

export const RACE_LEG_DISTANCES: Record<TriathlonDistance, { swimM: number; bikeKm: number; runKm: number }> = {
  '70.3':    { swimM: 1900, bikeKm: 90,    runKm: 21.1 },
  'ironman': { swimM: 3800, bikeKm: 180.2, runKm: 42.2 },
};

// ───────────────────────────────────────────────────────────────────────────
// Cycling event prediction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Intensity factor (IF = watts / FTP) for single-discipline cycling events by
 * target distance. Derived from Allen & Coggan (2010) "Training and Racing with
 * a Power Meter" power-duration zones — the same source as `RACE_INTENSITY_BY_DISTANCE`
 * for triathlon. Cycling events are single-discipline so IF is higher than an
 * equivalent-duration tri bike leg (no pre-swim fatigue). Confirmed 2026-05-04.
 *
 *   50 km  ≈ 1.5–2h → Sweet spot zone, 0.88
 *  100 km  ≈ 3–4h   → Tempo midpoint,  0.80
 *  160 km  ≈ 4.5–6h → Endurance-tempo, 0.74
 *  200 km  ≈ 6–8h   → Long endurance,  0.68
 *  300 km  ≈ 9–12h  → Ultra-endurance, 0.62
 */
export const CYCLING_EVENT_INTENSITY_FACTOR: Record<string, number> = {
  '50km':  0.88,
  '100km': 0.80,
  '160km': 0.74,
  '200km': 0.68,
  '300km': 0.62,
};

/**
 * Confidence range half-width for cycling event predictions (fraction of total
 * time). Gran Fondo pacing is less predictable than tri bike legs because
 * group dynamics, parcours sections, and nutrition strategy vary more.
 * Tighter as event day approaches — modelled as a flat ±10% until <4 weeks,
 * then narrows to ±6%. Values are conservative given the single-discipline,
 * single-day nature of the event.
 */
export const CYCLING_PREDICTION_RANGE_FAR = 0.10;   // > 4 weeks out
export const CYCLING_PREDICTION_RANGE_NEAR = 0.06;  // ≤ 4 weeks out
