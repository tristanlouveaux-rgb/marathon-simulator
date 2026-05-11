/**
 * HYROX mode constants.
 *
 * Side: planning + tracking. Used by the HYROX plan engine, MTL calculator,
 * onboarding initializer, and UI views.
 *
 * Science log entry: docs/SCIENCE_LOG.md §L (MTL model).
 *
 * NOTE: MTL cap values are initial estimates pending real-training validation.
 * Tristan will tune these after dogfooding with actual HYROX training sessions.
 */

import type { AbilityBand, HyroxStation } from '@/types/triathlon';

/** Same-athlete cross-format TOTAL time multiplier — DOUBLES → SINGLES.
 *  In singles, the athlete completes all 8 stations continuously without the
 *  partner-rest pattern doubles offers. Population-data lower bound: 1.125
 *  (P50 cohort comparison, S4–S6, 89,868 finishers — see
 *  src/data/hyrox-population-distributions.ts where open_singles P50 total =
 *  5338 s vs open_doubles P50 total = 4747 s; ratio is cohort-comparison so
 *  it understates the same-athlete gap). Coaching consensus (Hyrox Hub,
 *  Roxzone pacing analyses) puts same-athlete doubles → singles total
 *  expansion at 1.20–1.25. We use the midpoint 1.22.
 *
 *  Used ONLY for band derivation (initialization.hyrox.ts). Per-station
 *  cross-format inference is not defensible from current data and is not
 *  attempted — predictions of a different-format target fall back to seed
 *  station times and surface a confidence drop in the UI.
 *
 *  Recalibrate when matched-athlete cross-format records become available
 *  (e.g. Strava ingest of users who race both formats). See SCIENCE_LOG §T. */
export const SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES = 1.22;
/** Inverse direction. The 4-station-only doubles structure means a singles
 *  athlete's per-rep capacity is a ceiling; their realistic doubles total is
 *  faster than 1/1.22 implies once partner rest is factored in. We use 0.85. */
export const SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES = 0.85;

/**
 * Station-time multiplier for Pro division vs Open.
 * Pro weights are heavier (sled push 202 kg vs 152 kg; sandbag 30 kg vs 20 kg;
 * wall balls 9 kg vs 6 kg), which slows rep completion.
 * Sled stations: ~15% slower. Other loaded stations: ~8% slower.
 * Erg and bodyweight stations (ski_erg, row_erg, burpee_broad_jumps): unaffected by weight change.
 */
export const HYROX_PRO_STATION_MULTIPLIER: Partial<Record<HyroxStation, number>> = {
  sled_push:      1.15,
  sled_pull:      1.15,
  sandbag_lunges: 1.08,
  farmer_carry:   1.08,
  wall_balls:     1.08,
};

// ─── Phase structure ────────────────────────────────────────────────────────

export const HYROX_PHASE_WEEKS = {
  base:  6,
  build: 6,
  peak:  3,
};

/**
 * Resolve the four-phase split (base/build/peak/taper) for a HYROX plan of a
 * given length. Returns canonical proportions when the plan is long enough;
 * for shorter plans, weeks are compressed proportionally with priority order
 * taper > peak > build > base. Base is sacrificed first because an athlete
 * registering for HYROX typically already has aerobic foundation — what they
 * need is race-specific station/brick work and a taper.
 *
 * Mirrors `phasesForLen` in `triathlon-constants.ts`.
 *
 * Taper: clamped to [1, 2] weeks. Floor at 1 because race week itself is
 * taper; cap at 2 because detraining begins to bite beyond two weeks of
 * reduced volume (Mujika & Padilla 2003).
 *
 * Peak: floored at 1 whenever there's at least 1 non-taper week to spend —
 * the race-specific phase is the last to drop.
 */
export function hyroxPhasesForLen(
  totalWeeks: number,
): { base: number; build: number; peak: number; taper: number } {
  const def = HYROX_PHASE_WEEKS;
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

  // Defensive: rounding may push peak+build above remaining. Take the overshoot
  // out of build first, then peak, so total weeks always equal totalWeeks.
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

/** Taper length (days) by ability band. Shorter taper for faster bands because
 *  their training specificity means less accumulated fatigue needs clearing. */
export const HYROX_TAPER_DAYS: Record<AbilityBand, number> = {
  total_beginner: 10,
  beginner:       10,
  novice:         7,
  intermediate:   7,
  advanced:       5,
  competitive:    5,
};

// ─── MTL caps ───────────────────────────────────────────────────────────────

/**
 * Weekly MTL cap per ability band.
 *
 * Initial estimates — pending real-training validation. Derived from the
 * training-load literature on eccentric/mechanical stress tolerance across
 * experience levels (Damas et al. 2016; Schoenfeld 2010). Units are arbitrary
 * MTL units (durationMin × sRPE × modalityFactor × impactFactor).
 */
export const HYROX_MTL_CAP: Record<AbilityBand, number> = {
  total_beginner: 500,
  beginner:       700,
  novice:         1000,
  intermediate:   1300,
  advanced:       1600,
  competitive:    2000,
};

/**
 * Doubles MTL cap.
 *
 * Doubles athletes still run all 8 × 1km legs (full eccentric load on tendons)
 * but share the 4 of 8 stations with their partner. So the cap should reflect:
 * full run-load + half station-load.
 *
 * Run vs station MTL share is approximately 30 / 70 in our model — stations
 * carry heavier per-minute eccentric weight than runs (see STATION_MTL_FACTORS
 * vs RUN_MTL_FACTORS modality coefficients).
 *
 * Result: doubles_cap ≈ 0.30 × singles_cap + 0.70 × singles_cap × 0.5
 *                     = 0.65 × singles_cap.
 *
 * Beginner: 700 → ~455. Previously the cap was halved naively (× 0.5 = 350),
 * which left no headroom in Week 1 plans and showed alarming "Over cap"
 * warnings on every Add-Session option.
 */
const DOUBLES_RUN_SHARE = 0.30;
const DOUBLES_STATION_SHARE = 0.70;
const DOUBLES_STATION_REDUCTION = 0.50;
export function computeDoublesCap(singlesCap: number): number {
  return Math.round(
    DOUBLES_RUN_SHARE * singlesCap +
    DOUBLES_STATION_SHARE * singlesCap * DOUBLES_STATION_REDUCTION,
  );
}

// ─── Ability band derivation from previous HYROX time ───────────────────────

/** Thresholds for mapping a previous HYROX finish time to an ability band.
 *  Times are in seconds. Evaluated in order; the first matching maxSec wins. */
export const HYROX_TIME_TO_BAND_THRESHOLDS: Array<{ maxSec: number; band: AbilityBand }> = [
  { maxSec: 60 * 60,        band: 'competitive' },   // sub-1:00:00
  { maxSec: 80 * 60,        band: 'advanced' },       // sub-1:20:00
  { maxSec: 100 * 60,       band: 'intermediate' },   // sub-1:40:00
  { maxSec: 120 * 60,       band: 'novice' },         // sub-2:00:00
  { maxSec: Infinity,       band: 'beginner' },        // 2:00:00+
];

// ─── MTL modality and impact factors by station ─────────────────────────────

/**
 * Per-station MTL multipliers.
 *
 * modalityFactor: eccentric + mechanical loading relative to baseline IL.
 *   Sled and plyometric movements are highest; ergs are lowest (pure aerobic,
 *   minimal eccentric). (Research doc §3.3, Verkhoshansky & Siff 2009).
 *
 * impactFactor: ground-impact amplification.
 *   Burpee broad jumps and lunges land under load; ergs have zero impact.
 */
export const STATION_MTL_FACTORS: Record<HyroxStation, { modality: number; impact: number }> = {
  ski_erg:            { modality: 0.5, impact: 0.7 },
  sled_push:          { modality: 1.2, impact: 1.0 },
  sled_pull:          { modality: 1.2, impact: 1.0 },
  burpee_broad_jumps: { modality: 1.3, impact: 1.3 },
  row_erg:            { modality: 0.5, impact: 0.7 },
  farmer_carry:       { modality: 1.0, impact: 1.0 },
  sandbag_lunges:     { modality: 1.1, impact: 1.0 },
  wall_balls:         { modality: 1.1, impact: 1.0 },
};

/** Per-run-intensity MTL multipliers. Runs carry lower eccentric load than
 *  station work, with intensity scaling the mechanical stress. */
export const RUN_MTL_FACTORS: Record<'run_easy' | 'run_tempo' | 'run_intervals', { modality: number; impact: number }> = {
  run_easy:      { modality: 0.6, impact: 1.0 },
  run_tempo:     { modality: 0.8, impact: 1.0 },
  run_intervals: { modality: 1.0, impact: 1.0 },
};

// ─── 3D load profile per station (0–10 scale) ───────────────────────────────

/** Aerobic / anaerobic / MTL demand per station. Used by the stats view
 *  3D load chart. Values from research doc §4.1 (0–10 ordinal scale). */
export const STATION_LOAD_PROFILE: Record<HyroxStation, { aerobic: number; anaerobic: number; mtl: number }> = {
  ski_erg:            { aerobic: 7, anaerobic: 5, mtl: 3 },
  sled_push:          { aerobic: 5, anaerobic: 7, mtl: 9 },
  sled_pull:          { aerobic: 5, anaerobic: 7, mtl: 8 },
  burpee_broad_jumps: { aerobic: 7, anaerobic: 7, mtl: 10 },
  row_erg:            { aerobic: 7, anaerobic: 6, mtl: 3 },
  farmer_carry:       { aerobic: 5, anaerobic: 4, mtl: 8 },
  sandbag_lunges:     { aerobic: 6, anaerobic: 6, mtl: 9 },
  wall_balls:         { aerobic: 7, anaerobic: 7, mtl: 9 },
};

// ─── Weekly session targets by band ─────────────────────────────────────────

/** Default weekly session counts by ability band.
 *  Bricks = run+station interleaved sessions (HYROX-specificity work).
 *  Stations = dedicated functional-skill sessions.
 *  Runs = standalone aerobic run sessions. */
export const HYROX_WEEKLY_SESSIONS: Record<AbilityBand, { runs: number; stations: number; bricks: number }> = {
  total_beginner: { runs: 2, stations: 2, bricks: 0 },
  beginner:       { runs: 2, stations: 2, bricks: 1 },
  novice:         { runs: 3, stations: 2, bricks: 1 },
  intermediate:   { runs: 3, stations: 2, bricks: 1 },
  advanced:       { runs: 3, stations: 2, bricks: 1 },
  competitive:    { runs: 3, stations: 2, bricks: 1 },
};

// ─── Plan duration ───────────────────────────────────────────────────────────

/** Default plan length in weeks per ability band.
 *  = base + build + peak + taper. */
export const HYROX_DEFAULT_PLAN_WEEKS: Record<AbilityBand, number> = {
  total_beginner: 16,
  beginner:       16,
  novice:         18,
  intermediate:   18,
  advanced:       20,
  competitive:    20,
};

/** Weekly peak hours range per ability band (for the hours slider). */
export const HYROX_HOURS_RANGE: Record<AbilityBand, { default: number; min: number; max: number }> = {
  total_beginner: { default: 4,  min: 2,  max: 8  },
  beginner:       { default: 5,  min: 2,  max: 10 },
  novice:         { default: 6,  min: 2,  max: 12 },
  intermediate:   { default: 8,  min: 2,  max: 14 },
  advanced:       { default: 10, min: 2,  max: 16 },
  competitive:    { default: 12, min: 2,  max: 20 },
};

// ─── Run-leg fatigue model ────────────────────────────────────────────────────

/**
 * Per-station fatigue rate for the run-leg pacing model (singles format).
 *
 * Each completed station adds eccentric + metabolic fatigue that slows
 * subsequent run legs. The rate scales by ability band: elite athletes hold pace
 * far better than beginners. Values derived from HYROX finishing-time distributions
 * (HyroxDataLab): top-pro run splits are within ~2–4% across all 8 legs, while
 * age-group beginners show 8–12% slip by run 7–8.
 *
 * Doubles format halves the effective rate (athletes alternate stations, sharing
 * the eccentric load — but still accumulate metabolic cost from waiting partner).
 */
export const PER_STATION_FATIGUE_RATE_BY_BAND: Record<AbilityBand, number> = {
  competitive:    0.004,
  advanced:       0.005,
  intermediate:   0.006,
  novice:         0.007,
  beginner:       0.009,
  total_beginner: 0.011,
};

// ─── ACWR thresholds for MTL ─────────────────────────────────────────────────

/** MTL ACWR thresholds for station-volume reduction and warning.
 *  Same structure as aerobic ACWR — safe / caution / high-risk. */
export const MTL_ACWR_CAUTION = 1.2;
export const MTL_ACWR_HIGH    = 1.35;

// ─── Eccentric-heavy stations (need 48h spacing) ─────────────────────────────

/** Stations that require at least 48h between exposures due to DOMS-inducing
 *  eccentric load (Clarkson & Hubal 2002; Morgan & Allen 1999). */
export const ECCENTRIC_HEAVY_STATIONS: HyroxStation[] = [
  'burpee_broad_jumps',
  'sandbag_lunges',
  'wall_balls',
];

// ─── Volume progression ──────────────────────────────────────────────────────

/**
 * Phase volume multipliers applied to weekly-available hours.
 * Mirrors the triathlon engine's ramp (Bompa & Haff 2009; Issurin 2010):
 *   Base:  0.55 at week 1 → 0.85 at end of base (linear ramp over 8 weeks)
 *   Build: 0.92 — near-peak effort as specificity increases
 *   Peak:  1.00 — highest training stimulus
 *   Taper: stepped reduction (0.75 → 0.55 → 0.30 at race week)
 *
 * Deload modifier: ×0.70 applied on every 4th week within base/build.
 * (Same as tri engine — empirically validated 3:1 load:recovery ratio.)
 */
export const HYROX_DELOAD_FACTOR = 0.70;
export const HYROX_BUILD_MULT = 0.92;
export const HYROX_PEAK_MULT  = 1.00;

/** Base phase: linear ramp 0.55 + 0.30 × (weekInBase / 8), capped at 0.85. */
export function hyroxBaseMultiplier(weekIndex: number): number {
  return Math.min(0.85, 0.55 + 0.30 * ((weekIndex - 1) / 8));
}

// ─── Time distribution across session types ──────────────────────────────────

/**
 * Fraction of weekly training time allocated to each session category.
 * Derived from HYROX coaching consensus: aerobic base is the performance
 * foundation (40%), functional skill work is the primary discriminator (35%),
 * brick (race-specific integration) is high-value but lower volume (25%).
 * (Source: research doc §9.1; Sparkes & Behm 2010 on compound conditioning.)
 */
export const HYROX_TIME_SPLIT: Record<'runs' | 'stations' | 'bricks', number> = {
  runs:     0.40,
  stations: 0.35,
  bricks:   0.25,
};

/** Maximum session duration caps (minutes) to prevent unrealistic single sessions. */
export const HYROX_SESSION_MAX_MIN: Record<string, number> = {
  run_easy:           75,
  run_tempo:          60,
  run_intervals:      50,
  station_technique:  70,
  station_density:    55,
  brick:              90,
  mini_brick:         60,
};
