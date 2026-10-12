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
import { computePlanPhases, type PhaseConfig, type PlanPhaseWeek } from '@/workouts/phases';

/** Same-athlete cross-format TOTAL time multiplier — DOUBLES → SINGLES.
 *  In singles, the athlete completes all 8 stations continuously without the
 *  partner-rest pattern doubles offers. Population-data lower bound: 1.125
 *  (P50 cohort comparison, S4–S6, 89,868 finishers. See
 *  src/data/hyrox-population-distributions.ts where open_singles P50 total =
 *  5338 s vs open_doubles P50 total = 4747 s; ratio is cohort-comparison so
 *  it understates the same-athlete gap). Coaching consensus (Hyrox Hub,
 *  Roxzone pacing analyses) puts same-athlete doubles → singles total
 *  expansion at 1.20–1.25. We use the midpoint 1.22.
 *
 *  Used ONLY for band derivation (initialization.hyrox.ts). Per-station
 *  cross-format inference is not defensible from current data and is not
 *  attempted. Predictions of a different-format target fall back to seed
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
 * registering for HYROX typically already has aerobic foundation. What they
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
 *
 * @deprecated Use `computeHyroxPlanPhases(totalWeeks)` instead. It returns
 * per-week phases (including the checkpoint flag for double-periodization plans
 * ≥28 weeks) and shares its strategy with running and triathlon mode. Kept
 * temporarily for any callers that depend on the count-based shape.
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

// ───────────────────────────────────────────────────────────────────────────
// Phase config + per-week phase computation (shared strategy with running / tri)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Race taper length for every HYROX tier: the week before race week plus race
 * week (8 to 14 days before race day, depending on the race weekday). Bosquet,
 * Montpetit, Arvisais & Mujika 2007 found the largest taper effect with tapers
 * of 8 to 14 days (the same source and value as running's
 * MARATHON_MIN_TAPER_WEEKS). Coach ranges agree (Rox Lyfe 7 to 14 days, RMR 10
 * to 14, Roncevic 2 weeks). Before 2026-10-12 a HYROX plan of 10 weeks or fewer
 * tapered 1 week (ceil(N x 0.10)). A 1-week plan is race week alone.
 * Planning side.
 */
export const HYROX_TAPER_WEEKS_MIN = 2;

/**
 * Tuned to reproduce the canonical HYROX_PHASE_WEEKS split (6/6/3) at the
 * default plan length (18 weeks → 7/6/3/2). Peak capped at 3 because HYROX peak
 * = race-specific compromised-running and station-density work. Beyond 3w the
 * stimulus plateaus and accumulated fatigue compromises race day.
 *
 * Double-periodization threshold is 28 weeks (matching triathlon). HYROX lead
 * times are typically 12–20 weeks, so the double-cycle path is rarely engaged.
 */
const HYROX_PHASE_CONFIG: PhaseConfig = {
  taperCap: 2,
  taperMin: HYROX_TAPER_WEEKS_MIN,
  peakCap: 3,
  buildCap: 8,
  taperRatio: 0.10,
  peakRatio: 0.20,             // 3 / ~18 (raised to cap at 18w canonical)
  buildRatio: 0.333,           // 6 / 18
  doublePeriodizationThreshold: 28,
  cycle2Fraction: 0.55,
  transitionWeeks: 2,
  cycle1PeakCap: 3,
  cycle1BuildCap: 6,
  cycle1PeakRatio: 0.18,
  cycle1BuildRatio: 0.35,
  cycle1Min: 8,
  cycle2Min: 12,
};

/**
 * Compute per-week phases for a HYROX plan. Returned array length equals
 * `totalWeeks`; index i corresponds to plan week i+1. Plans ≥28 weeks switch
 * to double periodization with a Checkpoint (TT) week at the end of cycle 1.
 */
export function computeHyroxPlanPhases(totalWeeks: number): PlanPhaseWeek[] {
  return computePlanPhases(totalWeeks, HYROX_PHASE_CONFIG);
}

/** Taper length (days) by ability band: 14 for every band, the 2-week race
 *  taper (HYROX_TAPER_WEEKS_MIN; Bosquet et al. 2007, 8 to 14 days). Read by the
 *  race projection's readiness window. Before 2026-10-12 it was 10 / 10 / 7 /
 *  7 / 5 / 5, a split from CrossFit taper habits (Pritchard 2020 via
 *  docs/research/hyrox.md §3.7) that ran the wrong way (beginners longest). */
export const HYROX_TAPER_DAYS: Record<AbilityBand, number> = {
  total_beginner: HYROX_TAPER_WEEKS_MIN * 7,
  beginner:       HYROX_TAPER_WEEKS_MIN * 7,
  novice:         HYROX_TAPER_WEEKS_MIN * 7,
  intermediate:   HYROX_TAPER_WEEKS_MIN * 7,
  advanced:       HYROX_TAPER_WEEKS_MIN * 7,
  competitive:    HYROX_TAPER_WEEKS_MIN * 7,
};

// ─── MTL caps ───────────────────────────────────────────────────────────────

/**
 * Weekly MTL cap per ability band.
 *
 * Initial estimates. Pending real-training validation. Derived from the
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
 * Run vs station MTL share is approximately 30 / 70 in our model. Stations
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

// ─── Training tiers ──────────────────────────────────────────────────────────

/** The three HYROX training tiers the plan generator doses by (parameter sheet
 *  2026-10-12, levels.mapping; findyouredge's level definitions). */
export type HyroxTier = 'beginner' | 'intermediate' | 'advanced';

/**
 * Tier of an ability band: Beginner = total_beginner (no previous race) and
 * beginner (2:00:00+); Intermediate = novice (1:40 to 2:00) and intermediate
 * (1:20 to 1:40); Advanced = advanced (1:00 to 1:20) and competitive (sub-1:00).
 * The bands come from HYROX_TIME_TO_BAND_THRESHOLDS. Single source for the
 * grouping the generators already used (the station dose ceiling,
 * hyrox-generators bandMaxRounds) and the weekly structure below.
 */
export function hyroxTier(band: AbilityBand): HyroxTier {
  switch (band) {
    case 'competitive':
    case 'advanced':
      return 'advanced';
    case 'intermediate':
    case 'novice':
      return 'intermediate';
    default: // beginner, total_beginner
      return 'beginner';
  }
}

// ─── Weekly session structure by tier and phase ─────────────────────────────

export interface HyroxSessionCounts { runs: number; stations: number; bricks: number }

/**
 * Sessions a week by tier and phase (parameter sheet 2026-10-12,
 * sessions.weekly; findyouredge 3 to 4 / 4 to 5 / 5 to 6 sessions; Centr,
 * Couch to HYROX, TrainingPeaks and Genesis fit the same bands). Runs include
 * the long run and the quality run. Stations are station sessions: beginner
 * technique; intermediate technique in base, race pace from build; advanced a
 * race-pace and a technique session in base and build, the race-pace session
 * alone in peak. Advanced peak bricks are the key brick and a secondary
 * (lighter) brick that is not a hard session.
 *
 * The sheet's strength sessions (beginner and intermediate base) are left out:
 * HYROX has no strength content yet (lane H2b), so the slot would be empty.
 * Taper weeks keep the peak structure (Bosquet et al. 2007: no benefit from
 * cutting frequency); race week has no brick (the race is the week's brick).
 * No brick before plan week HYROX_FIRST_BRICK_WEEK or in base (bricks.timing).
 */
export const HYROX_WEEKLY_STRUCTURE: Record<HyroxTier, Record<'base' | 'build' | 'peak', HyroxSessionCounts>> = {
  beginner: {
    base:  { runs: 2, stations: 1, bricks: 0 },
    build: { runs: 2, stations: 1, bricks: 1 },
    peak:  { runs: 2, stations: 1, bricks: 1 },
  },
  intermediate: {
    base:  { runs: 3, stations: 1, bricks: 0 },
    build: { runs: 3, stations: 1, bricks: 1 },
    peak:  { runs: 3, stations: 1, bricks: 1 },
  },
  advanced: {
    base:  { runs: 3, stations: 2, bricks: 0 },
    build: { runs: 3, stations: 2, bricks: 1 },
    peak:  { runs: 3, stations: 1, bricks: 2 },
  },
};

/** First plan week that may hold a brick (bricks.timing: Rundida from week 4,
 *  the earliest source; week 4 is a deload here, so week 5). */
export const HYROX_FIRST_BRICK_WEEK = 5;

/** Most runs a week the session slider adds (sessions.weekly: extra sessions go
 *  to easy runs up to 5, then easy erg work, never extra bricks or stations). */
export const HYROX_MAX_RUNS_PER_WEEK = 5;

/**
 * Apply the athlete's session-count choice to a structure row. `delta` is the
 * chosen weekly total minus the tier's build-week total (HYROX_WEEKLY_SESSIONS).
 *   - Adding: easy runs up to HYROX_MAX_RUNS_PER_WEEK. Easy erg work comes next
 *     in the sheet, but HYROX has no erg session type yet; the session slider
 *     (2 to 7) never reaches it (a 7-session beginner or intermediate week is
 *     5 runs + 1 station + 1 brick, an advanced one 4 runs + 2 + 1).
 *   - Reducing: bricks first, then station sessions (never below 1), then runs
 *     (never below 1). Unchanged order from the previous distributeSessionCount.
 */
export function applyHyroxSessionDelta(row: HyroxSessionCounts, delta: number): HyroxSessionCounts {
  let { runs, stations, bricks } = row;
  let d = Math.round(delta);
  while (d > 0 && runs < HYROX_MAX_RUNS_PER_WEEK) { runs++; d--; }
  while (d < 0) {
    if (bricks > 0) bricks--;
    else if (stations > 1) stations--;
    else if (runs > 1) runs--;
    else break;
    d++;
  }
  return { runs, stations, bricks };
}

/** Default weekly session counts by ability band: the tier's build week
 *  (HYROX_WEEKLY_STRUCTURE). The wizard's session slider and the race
 *  projection's weekly-volume factor read this total; the plan engine applies
 *  the athlete's difference from it to every phase (applyHyroxSessionDelta). */
export const HYROX_WEEKLY_SESSIONS: Record<AbilityBand, HyroxSessionCounts> = {
  total_beginner: { ...HYROX_WEEKLY_STRUCTURE.beginner.build },
  beginner:       { ...HYROX_WEEKLY_STRUCTURE.beginner.build },
  novice:         { ...HYROX_WEEKLY_STRUCTURE.intermediate.build },
  intermediate:   { ...HYROX_WEEKLY_STRUCTURE.intermediate.build },
  advanced:       { ...HYROX_WEEKLY_STRUCTURE.advanced.build },
  competitive:    { ...HYROX_WEEKLY_STRUCTURE.advanced.build },
};

/** Total of a session-count row. */
export function hyroxSessionTotal(c: HyroxSessionCounts): number {
  return c.runs + c.stations + c.bricks;
}

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
 * the eccentric load. But still accumulate metabolic cost from waiting partner).
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
 *  Same structure as aerobic ACWR. Safe / caution / high-risk. */
export const MTL_ACWR_CAUTION = 1.2;
export const MTL_ACWR_HIGH    = 1.35;

// ─── Eccentric-heavy stations (need 48h spacing) ─────────────────────────────

/** Stations that require at least 48h between exposures due to DOMS-inducing
 *  eccentric load (Clarkson & Hubal 2002; Morgan & Allen 1999). A hard
 *  scheduler rule since 2026-10-12 (scheduler.hyrox isEccentricSession): two
 *  sessions holding any of them never sit on consecutive days, Sunday and the
 *  next Monday included (Ketzer 2026; Chittenden 2026; Magnusson 2010; the
 *  sheet's eccentric.min_gap row). Heavy lower-body strength and plyometrics
 *  fall under the same rule; HYROX plans hold neither yet. */
export const ECCENTRIC_HEAVY_STATIONS: HyroxStation[] = [
  'burpee_broad_jumps',
  'sandbag_lunges',
  'wall_balls',
];

/**
 * Eccentric sessions a week the weekly structure produces (parameter sheet
 * eccentric.sessions_per_week). No source gives a weekly count of eccentric or
 * lower-body sessions (Ketzer 2026 says its findings do not support specific
 * prescriptions; Chittenden 2026 reports hours). This is a GENERATOR CHECK, not
 * a sourced cap: the plan engine warns when a week exceeds it, which would
 * mean the structure itself changed. The sheet's counts include strength
 * sessions HYROX does not prescribe yet, so generated weeks sit at or below.
 */
export const HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK: Record<HyroxTier, Record<'base' | 'build' | 'peak', number>> = {
  beginner:     { base: 2, build: 2, peak: 2 },
  intermediate: { base: 2, build: 2, peak: 2 },
  advanced:     { base: 2, build: 3, peak: 2 },
};

/** Hard sessions a week (quality runs, bricks except the advanced secondary
 *  brick, race-pace station sessions): at most 3, the most 7 days hold with no
 *  two on consecutive days, and at most 2 of them hard runs (quality runs and
 *  bricks). Sources: the5krunner (elite schedules never put hard running and
 *  hard HYROX work on consecutive days; most concentrate load into two or
 *  three key days); HYROX Data Lab (two high-intensity running sessions a week
 *  is the limit for most athletes; site offline since 2026-10-12). */
export const HYROX_MAX_HARD_SESSIONS = 3;
export const HYROX_MAX_HARD_RUNS = 2;

/** Stations HYROX race week leaves out (planning side, SCIENCE_LOG §CE / §CW):
 *  the eccentric-heavy stations above and the two sled stations, the heaviest
 *  external loads (STATION_EXTERNAL_LOAD_KG). They are exactly the stations
 *  whose per-minute MTL factor (modality × impact, STATION_MTL_FACTORS) is
 *  above the farmer carry's 1.0. A race-week station circuit keeps the ergs
 *  and the farmer carry: technique touch without the eccentric and sled load
 *  the taper is meant to clear. */
export const RACE_WEEK_EXCLUDED_STATIONS: HyroxStation[] = [
  ...ECCENTRIC_HEAVY_STATIONS,
  'sled_push',
  'sled_pull',
];

// ─── Volume progression ──────────────────────────────────────────────────────

/**
 * Phase volume multipliers applied to weekly-available hours (nominal values,
 * unchanged since the triathlon port; Bompa & Haff 2009; Issurin 2010):
 *   Base:  0.55 at week 1 rising 0.0375 a week to 0.85
 *   Build: 0.92
 *   Peak:  1.00
 * The nominal curve uses the absolute week index, so a short base ends well
 * below 0.85 and build opens with a jump (+19% to +57% before 2026-10-12). The
 * plan engine caps every week with the acute:chronic guard (planned load at
 * most ACWR_SAFE_HIGH x the mean of the previous 4 planned weeks, Tristan
 * 2026-10-12), which decides how fast short plans climb to these values.
 * Taper: taperFraction (phases.ts) of the reference week, 0.70 then 0.55.
 *
 * Deload: every 4th plan week in base, build and peak (isFourWeekCycleDeloadWeek)
 * at 0.75 of the week's volume. HWPO's HYROX programme deloads every 4th week;
 * Centr is the only source for the depth (25% less volume). Before 2026-10-12
 * the factor was 0.70, copied from the triathlon engine without a source.
 */
export const HYROX_DELOAD_FACTOR = 0.75;
/** Floor of the combined effort x MTL-gap lever (plan_engine.hyrox). The old
 *  deload factor's value, kept under its own name when the deload moved to
 *  0.75 (parameter sheet ramp.deload), so the lever behaves as before. */
export const HYROX_ADAPTIVE_FLOOR = 0.70;
export const HYROX_BUILD_MULT = 0.92;
export const HYROX_PEAK_MULT  = 1.00;

/** Base phase: linear ramp 0.55 + 0.30 × (weekInBase / 8), capped at 0.85. */
export function hyroxBaseMultiplier(weekIndex: number): number {
  return Math.min(0.85, 0.55 + 0.30 * ((weekIndex - 1) / 8));
}

/** A taper-labelled week that is not part of the race taper (the inter-cycle
 *  taper of a double-periodisation plan, 28+ weeks): 0.75 of the weekly hours.
 *  Existing value (the old phaseMultiplier's taper week 2+ weeks from the end);
 *  the parameter sheet keeps it (taper.volume). */
export const HYROX_TRANSITION_TAPER_MULT = 0.75;

/** Day before the race: rest or an easy jog of this many minutes or less
 *  (parameter sheet taper.content; Rox Lyfe: rest or a 20-min jog the day
 *  before; Dearden rests the 2 days before). */
export const HYROX_DAY_BEFORE_RACE_MAX_RUN_MIN = 20;

/** Weeks in the chronic window of the plan's acute:chronic guard: the rolling
 *  mean of the previous 4 planned weeks (Tristan 2026-10-12; Gabbett 2016's
 *  4-week chronic load). Weeks before plan week 1 count as week 1, the
 *  athlete's starting week. */
export const HYROX_CHRONIC_WINDOW_WEEKS = 4;

// ─── Time distribution across session types ──────────────────────────────────

/**
 * Running share of the week's planned hours, every tier: standalone runs plus
 * the run segments of bricks (parameter sheet split.running_share). The rest
 * holds station sessions and the bricks' station work. Hours a week are a
 * ceiling: what the sessions leave unprescribed stays unprescribed (the sheet
 * sends it to easy erg work, which has no session type yet), never to more
 * running. Lucy Procter's 40 to 50% of her own hours is the only figure; the
 * low end is used. Ketzer 2026 attributes 27.6% of single-element injuries to
 * running. Replaces HYROX_TIME_SPLIT (runs 0.40 / stations 0.35 / bricks
 * 0.25), which put about 50% of the week into running once brick runs counted.
 */
export const HYROX_RUN_SHARE = 0.40;

/** Maximum session duration caps (minutes) for the sessions whose length
 *  follows the week's budget. The old all-band 75-min easy-run cap is replaced
 *  by the tier long-run cap (HYROX_LONG_RUN) and the rule that no other run is
 *  longer than the long run. The quality-run formats (HYROX_QUALITY_FORMATS)
 *  have fixed lengths; run_tempo still caps a taper or race-week tempo. */
export const HYROX_SESSION_MAX_MIN: Record<string, number> = {
  run_tempo:          60,
  run_intervals:      50,
  station_technique:  70,
  station_density:    55,
  brick:              90,
  mini_brick:         60,
};

/** Shortest run the generator prescribes (minutes): the generator's existing
 *  run floor. A share below it is merged into fewer runs, as running does with
 *  its easy floor, instead of being raised past the week's running share. */
export const HYROX_RUN_FLOOR_MIN = 20;

// ─── Long run ───────────────────────────────────────────────────────────────

/**
 * Long run by tier (parameter sheet long_run.cap): one easy run a week, Zone 2.
 * Start, +stepMin every stepEveryWeeks plan weeks, capped at capMin. Every step
 * also obeys the single-run rule (plan_engine LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST,
 * Frandsen 2025), and the start is never above 110% of the athlete's longest
 * logged run in the 30 days before the plan. Sources: LJMU, HYROX Hub and
 * HYROX Data Lab (beginner 40 to 60 min), hybridathletica (60 to 90 min),
 * Fast Talk and Dearden (90 min advanced). Planning side.
 */
export const HYROX_LONG_RUN: Record<HyroxTier, { startMin: number; stepMin: number; stepEveryWeeks: number; capMin: number }> = {
  beginner:     { startMin: 40, stepMin: 5, stepEveryWeeks: 3, capMin: 60 },
  intermediate: { startMin: 60, stepMin: 5, stepEveryWeeks: 3, capMin: 75 },
  advanced:     { startMin: 75, stepMin: 5, stepEveryWeeks: 3, capMin: 90 },
};

// ─── Run quality sessions ───────────────────────────────────────────────────

/** A quality-run format: a continuous tempo, or intervals by heart rate
 *  (about HYROX_INTERVAL_HR_FRACTION of max HR, easy jog between reps) or by
 *  goal race pace over 1 km (standing rest). */
export type HyroxQualityFormat =
  | { kind: 'run_tempo'; workMin: number }
  | { kind: 'run_intervals'; reps: number; repMin: number; recoveryMin: number; target: 'hr' }
  | { kind: 'run_intervals'; reps: number; repKm: number; recoveryMin: number; target: 'race_pace' };

/**
 * One quality run a week by tier and phase (parameter sheet intervals.formats;
 * HYROX Data Lab, Dearden, Gutierrez-Hellin 2026, Rox Lyfe). Beginner base is
 * easy running only. Peak: beginner 4 x 3 min and advanced 6 x 4 min at about
 * 90% of max HR with 3 min easy jog; intermediate 8 x 1 km at goal race pace
 * with 3 min rest. 10 min warm-up and 5 min cool-down (existing). Taper weeks
 * and race week keep the existing taper tempo (the race-week primer). Replaces
 * the race pace x 0.97 / x 0.88 factors and the 4 to 12 x 400 m format.
 */
export const HYROX_QUALITY_FORMATS: Record<HyroxTier, Record<'base' | 'build' | 'peak', HyroxQualityFormat | null>> = {
  beginner: {
    base:  null,
    build: { kind: 'run_tempo', workMin: 20 },
    peak:  { kind: 'run_intervals', reps: 4, repMin: 3, recoveryMin: 3, target: 'hr' },
  },
  intermediate: {
    base:  { kind: 'run_tempo', workMin: 25 },
    build: { kind: 'run_tempo', workMin: 25 },
    peak:  { kind: 'run_intervals', reps: 8, repKm: 1, recoveryMin: 3, target: 'race_pace' },
  },
  advanced: {
    base:  { kind: 'run_tempo', workMin: 30 },
    build: { kind: 'run_tempo', workMin: 30 },
    peak:  { kind: 'run_intervals', reps: 6, repMin: 4, recoveryMin: 3, target: 'hr' },
  },
};

/** Heart-rate target of the peak interval formats: about 90% of max HR
 *  (parameter sheet intervals.formats, HYROX Data Lab). */
export const HYROX_INTERVAL_HR_FRACTION = 0.90;

/** Warm-up and cool-down around a quality run (existing generator values). */
export const HYROX_QUALITY_WARMUP_MIN = 10;
export const HYROX_QUALITY_COOLDOWN_MIN = 5;
