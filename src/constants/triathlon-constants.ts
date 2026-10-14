/**
 * Triathlon blessed constants. Every value here is sourced from literature or
 * coaching consensus and was explicitly confirmed during the 2026-04-23 spec
 * review. Do not invent additions here. Add via the spec-review workflow
 * (docs/TRIATHLON.md §18) and cite.
 *
 * **Tracking vs planning**: this file holds constants from both sides. The
 * `RUN_FATIGUE_DISCOUNT_*` values are *tracking* (race-time prediction) only.
 * They must never be applied to training-load calculations (§18.4).
 */

import type { TriathlonDistance, TriVolumeSplit } from '../types/triathlon';
import { computePlanPhases, type PhaseConfig, type PlanPhaseWeek } from '@/workouts/phases';

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
// Race prediction (TRACKING side only. Never apply to training load)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run-leg pace discount applied to the open-distance run pace, by race format.
 * Reflects accumulated bike fatigue depleting run performance (TRACKING side only).
 *
 * 70.3 = 5% (Bentley 2007, midpoint 4–6%), IM = 11% (Landers 2008, midpoint 10–12%).
 * Sprint/Olympic/T100 extrapolated along the Bentley→Landers gradient — NO published
 * intermediate-distance data exists, so these are LOW confidence. They affect
 * prediction only, never training load. Refine against logged race outcomes.
 * See SCIENCE_LOG §T1. t100 ≈ 70.3 (near-identical bike+run load: 80km/18km vs 90km/21km).
 */
export const RUN_FATIGUE_DISCOUNT: Record<TriathlonDistance, number> = {
  sprint:  0.02,
  olympic: 0.04,
  t100:    0.05,
  '70.3':  0.05,
  ironman: 0.11,
};

/** @deprecated Use RUN_FATIGUE_DISCOUNT['70.3']. Kept for back-compat. */
export const RUN_FATIGUE_DISCOUNT_70_3 = RUN_FATIGUE_DISCOUNT['70.3'];

/** @deprecated Use RUN_FATIGUE_DISCOUNT['ironman']. Kept for back-compat. */
export const RUN_FATIGUE_DISCOUNT_IRONMAN = RUN_FATIGUE_DISCOUNT['ironman'];

/** Default transition estimates (seconds) by skill level. Beginners → experienced. Rough coaching ranges. */
export const T1_SEC_BY_SLIDER: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 540,   // 9 min. First-timer fumbling through
  2: 360,   // 6 min
  3: 240,   // 4 min
  4: 180,   // 3 min
  5: 120,   // 2 min. Experienced age-grouper
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
 * single one-time event. The athlete either does it at T1 (default), at
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
 * T1 / (T1+T2) ≈ 0.58. T1 is longer because of the wetsuit strip and
 * longer transition-zone walks at most venues.
 */
export const IM_T1_SHARE_OF_TOTAL = 0.58;

// ───────────────────────────────────────────────────────────────────────────
// Periodisation
// ───────────────────────────────────────────────────────────────────────────

// ── Race taper (planning side; SCIENCE_LOG "Triathlon and cycling taper rebuild") ──
// Replaces TAPER_DAYS (sprint 4-7 ... Ironman 14-21 days), which nothing read.

/**
 * Race-taper length in weeks, by race distance (Tristan, 2026-10-13). No study
 * keys taper length to race distance; distance is a practical proxy, and the
 * moderator with some support is pre-taper load (Thomas & Busso 2005; Mujika
 * in the Triathlete guide). The meta-analyses favour 8 to 14 days (Bosquet
 * 2007 ES 0.59; Wang 2023). Coaching: sprint 3 to 8 days (Dixon, Eriksson);
 * Olympic about 3 to 14 days, most often about 10, longer after an intense
 * block (the Triathlete guide, Eriksson, Ricci, Dixon); 70.3 about 2 weeks
 * (Barth, Eriksson; Allen effectively 3, a 20-25% cut before his two-week
 * plan); Ironman mostly 2 to 3 weeks (Fitzgerald and Goeringer 2; Barth 3;
 * Dave Scott 22 days). T100 has no source of its own: it takes 2, the value
 * of both neighbours (Olympic and 70.3). A plan too short for its taper keeps
 * the plan-length rule (computeTriPlanPhases). Athletes whose reference week
 * is under TRI_LOW_HOURS_THRESHOLD_H taper in race week only (Goeringer).
 */
export const TRI_TAPER_WEEKS_BY_DISTANCE: Record<TriathlonDistance, number> = {
  sprint:    1,
  olympic:   2,
  t100:      2,
  '70.3':    2,
  'ironman': 2,
};

/** Cycling mode's race taper (Tristan, 2026-10-13: cycling stays 2 weeks). */
export const CYCLING_TAPER_WEEKS = 2;

/**
 * Low-hours threshold in hours of training in the reference week: swim, bike
 * and run, the brick run and commute runs; gym left out (Goeringer,
 * TrainingPeaks 2021: athletes under 8 h a week need "two to three light days
 * rather than two to three weeks", read as total weekly training). Below it
 * the taper is race week only, whose last two days are the lightest (the
 * lower end of his 2 to 3). One of them is a full rest day, which comes from
 * Friel and Allen; Goeringer himself avoids full rest days. Triathlon only:
 * cycling keeps its 2 weeks (Tristan's cycling scope, 2026-10-13, leaves the
 * low-hours rule out).
 */
export const TRI_LOW_HOURS_THRESHOLD_H = 8;

/**
 * Taper volume fractions of the reference week, per discipline (Tristan,
 * 2026-10-13). A two-week taper is 0.55 then 0.30: a 57.5% mean cut, inside
 * the 41-60% band with the largest effect in Bosquet 2007 (ES 0.72) and Wang
 * 2023 (SMD -0.77). A one-week taper's race week is 0.55, a 45% cut, inside
 * the band (running's one-week taperFraction, phases.ts). Race excluded, as
 * the studies end the taper at the test.
 */
export const TRI_TAPER_FIRST_WEEK_FRACTION = 0.55;
export const TRI_RACE_WEEK_FRACTION = 0.30;
export const TRI_ONE_WEEK_TAPER_RACE_WEEK_FRACTION = 0.55;

/** Taper weeks keep at least this share of the reference week's sessions
 *  (Mujika 2011, a review for triathletes built on single-sport evidence:
 *  frequency above 80% avoids detraining; Pyne 2009: cut frequency about 20%
 *  at most). */
export const TRI_TAPER_MIN_SESSION_SHARE = 0.8;

/**
 * Race taper weeks for a plan (planning side): race week only for a low-hours
 * triathlete, else the distance's length (cycling: CYCLING_TAPER_WEEKS).
 */
export function triRaceTaperWeeks(
  distance: TriathlonDistance, opts: { cyclingOnly?: boolean; lowHours?: boolean } = {},
): number {
  if (opts.cyclingOnly) return CYCLING_TAPER_WEEKS;
  if (opts.lowHours) return 1;
  return TRI_TAPER_WEEKS_BY_DISTANCE[distance];
}

/** Default plan durations in weeks. Lower bound = aggressive, upper = typical.
 *  Friel Triathlete's Training Bible per-distance base/build norms. */
export const PLAN_WEEKS_DEFAULT: Record<TriathlonDistance, number> = {
  sprint:    12,
  olympic:   16,
  t100:      20,
  '70.3':    20,
  'ironman': 24,
};

/** Phase length defaults (weeks). Sum should roughly equal plan length minus taper.
 *  Ratios mirror 70.3 (base 0.40 / build 0.30 / peak 0.20 / taper 0.10). */
export const PHASE_WEEKS: Record<TriathlonDistance, { base: number; build: number; peak: number }> = {
  sprint:    { base: 5, build: 4, peak: 2 },
  olympic:   { base: 7, build: 5, peak: 3 },
  t100:      { base: 8, build: 6, peak: 4 },
  '70.3':    { base: 8, build: 6, peak: 4 },
  'ironman': { base: 10, build: 7, peak: 5 },
};

/**
 * Resolve the four-phase split (base/build/peak/taper) for a plan of a given
 * length. Returns canonical PHASE_WEEKS when the plan is long enough; for
 * shorter plans, weeks are compressed proportionally with priority order
 * taper > peak > build > base. Base is sacrificed first because an athlete
 * signing up for a race typically already has aerobic foundation. What
 * they're short of is race-specific work and a taper.
 *
 * Taper: clamped to [1, 2] weeks. Floor at 1 because race week itself is
 * taper; cap at 2 because detraining begins to bite beyond two weeks of
 * reduced volume (Mujika & Padilla 2003).
 *
 * Peak: floored at 1 whenever there's at least 1 non-taper week to spend —
 * the race-specific phase is the last to drop.
 *
 * @deprecated Use `computeTriPlanPhases(distance, totalWeeks)` instead. It
 * returns per-week phases (including the checkpoint flag for double-periodization
 * plans ≥28 weeks) and shares its strategy with running mode. Kept temporarily
 * for the test suite. Will be removed once all callers migrate.
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
// Phase config + per-week phase computation (shared strategy with running)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-distance phase configs feeding the shared `computePlanPhases` strategy.
 *
 * Ratios are tuned to reproduce the canonical PHASE_WEEKS split exactly at the
 * default plan length (70.3 / 20 weeks → 8/6/4/2; ironman / 24 weeks → 10/7/5/2),
 * so any user already running a default-length plan sees the same numbers.
 *
 * Taper capped at 2 (Mujika & Padilla 2003). Tri detraining bites sooner than
 * running because of the cross-training fatigue load. These ratios now set
 * the race taper only for plans too short to hold the distance's taper;
 * computeTriPlanPhases otherwise fixes it at triRaceTaperWeeks (2026-10-13).
 *
 * Double-periodization threshold is **28 weeks** for tri. Sooner than running's
 * 33. Because tri's monotony pain shows earlier when training across three
 * disciplines (multi-discipline volume + brick fatigue compresses the productive
 * single-arc window).
 */
const TRI_PHASE_CONFIGS: Record<TriathlonDistance, PhaseConfig> = {
  sprint: {
    taperCap: 2,
    peakCap: 5,
    buildCap: 8,
    taperRatio: 0.083,         // 1 / 12 default
    peakRatio: 0.167,          // 2 / 12 default
    buildRatio: 0.333,         // 4 / 12 default
    doublePeriodizationThreshold: 28,
    cycle2Fraction: 0.55,
    transitionWeeks: 2,
    cycle1PeakCap: 3,
    cycle1BuildCap: 6,
    cycle1PeakRatio: 0.18,
    cycle1BuildRatio: 0.35,
    cycle1Min: 8,
    cycle2Min: 12,
  },
  olympic: {
    taperCap: 2,
    peakCap: 5,
    buildCap: 8,
    taperRatio: 0.0625,        // 1 / 16 default
    peakRatio: 0.1875,         // 3 / 16 default
    buildRatio: 0.3125,        // 5 / 16 default
    doublePeriodizationThreshold: 28,
    cycle2Fraction: 0.55,
    transitionWeeks: 2,
    cycle1PeakCap: 3,
    cycle1BuildCap: 6,
    cycle1PeakRatio: 0.18,
    cycle1BuildRatio: 0.35,
    cycle1Min: 8,
    cycle2Min: 12,
  },
  t100: {
    // Identical to 70.3 (same default length and phase split).
    taperCap: 2,
    peakCap: 5,
    buildCap: 8,
    taperRatio: 0.10,
    peakRatio: 0.20,           // 4 / 20 default
    buildRatio: 0.30,          // 6 / 20 default
    doublePeriodizationThreshold: 28,
    cycle2Fraction: 0.55,
    transitionWeeks: 2,
    cycle1PeakCap: 3,
    cycle1BuildCap: 6,
    cycle1PeakRatio: 0.18,
    cycle1BuildRatio: 0.35,
    cycle1Min: 8,
    cycle2Min: 12,
  },
  '70.3': {
    taperCap: 2,
    peakCap: 5,
    buildCap: 8,
    taperRatio: 0.10,
    peakRatio: 0.20,           // 4 / 20 default
    buildRatio: 0.30,          // 6 / 20 default
    doublePeriodizationThreshold: 28,
    cycle2Fraction: 0.55,
    transitionWeeks: 2,
    cycle1PeakCap: 3,
    cycle1BuildCap: 6,
    cycle1PeakRatio: 0.18,
    cycle1BuildRatio: 0.35,
    cycle1Min: 8,
    cycle2Min: 12,
  },
  'ironman': {
    taperCap: 2,
    peakCap: 5,
    buildCap: 8,
    taperRatio: 0.10,
    peakRatio: 0.208,          // 5 / 24 default
    buildRatio: 0.292,         // 7 / 24 default
    doublePeriodizationThreshold: 28,
    cycle2Fraction: 0.55,
    transitionWeeks: 2,
    cycle1PeakCap: 3,
    cycle1BuildCap: 6,
    cycle1PeakRatio: 0.18,
    cycle1BuildRatio: 0.35,
    cycle1Min: 8,
    cycle2Min: 12,
  },
};

/**
 * Compute per-week phases for a triathlon plan. Returned array length equals
 * `totalWeeks`; index i corresponds to plan week i+1. Plans ≥28 weeks switch
 * to double periodization with a Checkpoint (TT) week at the end of cycle 1.
 *
 * The race taper is `triRaceTaperWeeks` long (race distance, cycling, low
 * hours; Tristan 2026-10-13), not a share of the plan. A plan too short to
 * hold that taper plus one build and one peak week (the single arc's minimum)
 * keeps the plan-length rule (taperRatio, at most taperCap), which gives
 * these plans a one-week taper.
 */
export function computeTriPlanPhases(
  distance: TriathlonDistance,
  totalWeeks: number,
  opts: { cyclingOnly?: boolean; lowHours?: boolean } = {},
): PlanPhaseWeek[] {
  const cfg = TRI_PHASE_CONFIGS[distance];
  const taper = triRaceTaperWeeks(distance, opts);
  if (totalWeeks < taper + 2) return computePlanPhases(totalWeeks, cfg);
  return computePlanPhases(totalWeeks, { ...cfg, taperMin: taper, taperCap: taper });
}

// ───────────────────────────────────────────────────────────────────────────
// Volume
// ───────────────────────────────────────────────────────────────────────────

/**
 * Default recommended discipline split (swim/bike/run share of weekly hours),
 * by race format. The user can override in the onboarding split picker — the
 * distance default only seeds the picker.
 *
 * Scales by distance: short course is swim/intensity-weighted (swim is a larger
 * fraction of race time, ~18% vs ~10%, and technique/economy gains dominate);
 * long course is bike-volume-and-durability bound. Run is capped ~0.35 at all
 * distances — run has the highest injury risk per hour (Vleck & Garbutt 1998),
 * and cycling crossover lets run volume stay below standalone (Millet 2002).
 * Pattern: swim ↓ with distance (0.20→0.175→0.15), bike ↑ (0.45→0.475→0.50).
 * Sources: race-time proportional analysis + Bentley 2007 (bike as primary
 * volume driver), Toussaint & Beek 1992 (swim economy trainability), Rüst 2012
 * (long-ride correlation). See SCIENCE_LOG. Confidence: medium.
 */
export const DEFAULT_VOLUME_SPLIT_BY_DISTANCE: Record<TriathlonDistance, TriVolumeSplit> = {
  sprint:    { swim: 0.20,  bike: 0.45,  run: 0.35 },
  olympic:   { swim: 0.20,  bike: 0.45,  run: 0.35 },
  t100:      { swim: 0.175, bike: 0.475, run: 0.35 },
  '70.3':    { swim: 0.175, bike: 0.475, run: 0.35 },
  'ironman': { swim: 0.15,  bike: 0.50,  run: 0.35 },
};

/** @deprecated Distance-agnostic default. Prefer `DEFAULT_VOLUME_SPLIT_BY_DISTANCE[distance]`.
 *  Kept for call sites without a distance in hand; points at the 70.3 split. */
export const DEFAULT_VOLUME_SPLIT: TriVolumeSplit = DEFAULT_VOLUME_SPLIT_BY_DISTANCE['70.3'];

/** Typical weekly peak hours by distance × skill level. Used when no user time-available input is provided.
 *  Friel Triathlete's Training Bible typical-volume tables. */
export const DEFAULT_WEEKLY_PEAK_HOURS: Record<TriathlonDistance, Record<1 | 2 | 3 | 4 | 5, number>> = {
  sprint: {
    1: 4,   2: 5,   3: 6,   4: 8,   5: 10,
  },
  olympic: {
    1: 5,   2: 6,   3: 8,   4: 10,  5: 13,
  },
  t100: {
    1: 6,   2: 8,   3: 10,  4: 13,  5: 16,
  },
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
  sprint:    { min: 3, max: 12 },
  olympic:   { min: 3, max: 15 },
  t100:      { min: 4, max: 20 },
  '70.3':    { min: 4, max: 20 },
  'ironman': { min: 6, max: 30 },
};

// ───────────────────────────────────────────────────────────────────────────
// Detraining (planning side. VDOT unchanged, CSS and FTP added for tri)
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
export const BRICK_DETECTION_WINDOW_SEC = 30 * 60;  // 30 min. §18.1

/**
 * Brick adaptation. How many (recency-weighted) brick sessions equal "fully adapted".
 * Millet & Vleck 2000: 10–15 bricks saturate the running-economy adaptation.
 * Using 12 as midpoint.
 */
export const BRICK_FULL_ADAPT_COUNT = 12;

/**
 * Maximum fraction by which brick history can reduce the run-leg fatigue discount.
 * Capped at 40%. Even a brick-veteran still fades on the IM run; the discount
 * never reaches zero (Bentley 2007, Landers 2008 document residual fade even in
 * elite triathletes with high brick volume).
 */
export const BRICK_MAX_DISCOUNT_REDUCTION = 0.40;

/**
 * Base open-water swim penalty for a novice OW swimmer racing non-wetsuit.
 * Veiga et al. 2013: pool-trained athletes ~5% slower in open water due to
 * sighting loss, no turn walls, contact, and lack of buoyancy.
 */
export const BASE_OW_PENALTY_NON_WETSUIT = 0.05;

/**
 * Base open-water swim penalty for a novice OW swimmer racing in a wetsuit.
 * Wetsuit provides buoyancy that partially offsets OW inefficiencies. Deficit
 * narrows to ~2% (Veiga 2013; Toussaint et al. 2002 on wetsuit buoyancy benefit).
 */
export const BASE_OW_PENALTY_WETSUIT = 0.02;

/**
 * Number of OW swim sessions at which the athlete has recovered ~63% of their
 * adaptation (1 − 1/e of the asymptote). Asymptotic curve: most gains come in
 * the first 5–10 sessions as the athlete learns sighting and drafting.
 */
export const OW_ADAPT_HALF_SESSIONS = 5;

// ───────────────────────────────────────────────────────────────────────────
// Adaptation engine. Auto-progression
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
 * faster than predicted. Below this we still log but don't surface. The user
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

/**
 * Bike intensity ladder by ascending %FTP, for the per-session "Adjust" Harder/
 * Easier control. `pct` = canonical midpoint %FTP; `band` (from BIKE_ADHERENCE_BAND)
 * gives the watt range. Coggan & Allen 2019 power zones. Mirrors the `pct` values
 * in `BIKE_OPTIONS` (session-generator.ts) — keep the two in sync. Climbing /
 * neuromuscular variants are deliberately excluded so the ladder is monotonic.
 */
export const BIKE_INTENSITY_LADDER: Array<{ key: string; label: string; pct: number }> = [
  { key: 'bike_endurance',  label: 'Endurance',  pct: 0.65 },
  { key: 'bike_tempo',      label: 'Tempo',      pct: 0.82 },
  { key: 'bike_sweet_spot', label: 'Sweet spot', pct: 0.91 },
  { key: 'bike_threshold',  label: 'Threshold',  pct: 1.00 },
  { key: 'bike_vo2',        label: 'VO2',        pct: 1.15 },
];

/**
 * Swim intensity ladder by ascending speed (descending sec/100m offset from CSS).
 * `cssOffsetSec` = sec/100m above (+) or below (-) critical swim speed. Mirrors
 * the `cssOffsetSec` values in `SWIM_OPTIONS` (session-generator.ts) — keep in sync.
 * The CSS test rung is excluded (it's a benchmark, not a training intensity).
 */
export const SWIM_INTENSITY_LADDER: Array<{ key: string; label: string; cssOffsetSec: number }> = [
  { key: 'swim_technique', label: 'Technique',     cssOffsetSec: +18 },
  { key: 'swim_endurance', label: 'Endurance',     cssOffsetSec: +6 },
  { key: 'swim_threshold', label: 'CSS intervals', cssOffsetSec: 0 },
  { key: 'swim_speed',     label: 'Speed',         cssOffsetSec: -6 },
];

/**
 * The ladder rung an off-ladder bike / swim session steps to when a downgrade is
 * accepted (tri-suggestion-apply.ts). These kinds sit outside
 * BIKE_INTENSITY_LADDER / SWIM_INTENSITY_LADDER by design (no single %FTP or CSS
 * offset), so each is mapped to the rung one category below it. Tristan's rule,
 * 2026-10-06: a downgrade moves one category down, never up.
 *   over-unders, neuromuscular (vlamax) and hill rides -> sweet spot
 *   VO2 micro-intervals -> threshold
 *   open-water swim -> endurance swim
 * The apply step does not offer a mapped step that would raise the session's
 * planned load. At generator pricing that holds back vlamax (loadForBike 1.10
 * TSS/min) -> sweet spot (1.5 TSS/min); the others all price lower after the step.
 */
export const OFF_LADDER_DOWNGRADE_RUNG: Readonly<Record<string, string>> = {
  bike_over_under: 'bike_sweet_spot',
  bike_vlamax:     'bike_sweet_spot',
  bike_hills:      'bike_sweet_spot',
  bike_vo2_micros: 'bike_threshold',
  swim_openwater:  'swim_endurance',
};

// ───────────────────────────────────────────────────────────────────────────
// Adaptation transparency. Marker auto-bump notification thresholds
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
  sprint:    { swimM: 750,  bikeKm: 20,    runKm: 5    },
  olympic:   { swimM: 1500, bikeKm: 40,    runKm: 10   },
  t100:      { swimM: 2000, bikeKm: 80,    runKm: 18   },
  '70.3':    { swimM: 1900, bikeKm: 90,    runKm: 21.1 },
  'ironman': { swimM: 3800, bikeKm: 180.2, runKm: 42.2 },
};

/** Human-readable label for a triathlon distance. Single source of truth for UI. */
export function getTriDistanceLabel(distance: TriathlonDistance): string {
  switch (distance) {
    case 'sprint':  return 'Sprint';
    case 'olympic': return 'Olympic';
    case 't100':    return 'T100';
    case '70.3':    return '70.3';
    case 'ironman': return 'Ironman';
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Cycling event prediction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Intensity factor (IF = watts / FTP) for single-discipline cycling events by
 * target distance. Derived from Allen & Coggan (2010) "Training and Racing with
 * a Power Meter" power-duration zones. The same source as `RACE_INTENSITY_BY_DISTANCE`
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
 * Tighter as event day approaches. Modelled as a flat ±10% until <4 weeks,
 * then narrows to ±6%. Values are conservative given the single-discipline,
 * single-day nature of the event.
 */
export const CYCLING_PREDICTION_RANGE_FAR = 0.10;   // > 4 weeks out
export const CYCLING_PREDICTION_RANGE_NEAR = 0.06;  // ≤ 4 weeks out
