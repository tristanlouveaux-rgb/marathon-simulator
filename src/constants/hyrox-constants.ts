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
import { triTaperFraction } from './triathlon-constants';

// Doubles ↔ singles total-time conversion lives in
// src/calculations/hyrox-doubles.ts (doublesTotalInSinglesTermsSec), a
// percentile match on the ingested results. SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES
// (1.22, coaching consensus) was removed 2026-10-13 so banding and the doubles
// forecast share one conversion.

/**
 * Station-time multiplier for Pro division vs Open. FALLBACK ONLY since lane
 * H3b (2026-10-13).
 *
 * The Open-to-Pro station conversion is now derived from the results per
 * station and sex (hyroxProConversionAt in src/calculations/hyrox-results.ts:
 * a difference in differences on the S8-S9 Pro and Open singles tables, the
 * loaded station's Pro/Open ratio at a matched percentile divided by the
 * Pro/Open ratio of the unloaded segments). This table stands in only for a
 * station where that method fails its sanity check (adjusted ratio below 1);
 * on the current tables none does.
 *
 * The values were set by hand from the men's Open-to-Pro jump (sled push 152
 * to 202 kg, sandbag 20 to 30 kg, wall ball 6 to 9 kg), one set for both
 * sexes, unsourced. Sled stations: ~15% slower. Other loaded stations: ~8%.
 * Erg and bodyweight stations (ski_erg, row_erg, burpee_broad_jumps):
 * unaffected by weight change.
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
 * but share the work inside each station with their partner: each does half of
 * each station (26/27 Doubles rulebook s7.2 sets no minimum share; the plan
 * trains a 50/50 split). So the cap should reflect: full run-load + half
 * station-load.
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

/** The original global finish-time scale for the ability bands (seconds;
 *  evaluated in order, the first matching maxSec wins). KEPT FOR REFERENCE
 *  AND CALIBRATION ONLY: no app code bands with it. Every format bands
 *  through the planning band (hyroxPlanningBandFor, hyrox-planning-band.ts:
 *  the finish in Open Singles terms on the athlete's own sex's field; pooled
 *  thresholds 3774, 4869, 6318 and 7853 s, S8-S9). It stays as the anchor the
 *  band-field percentiles were read at (hyrox-population.ts,
 *  HYROX_S89_BAND_FIELD_PERCENTILES) and in the results data tests. */
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
 * beginner; Intermediate = novice and intermediate; Advanced = advanced and
 * competitive. The bands come from the planning band (hyroxPlanningBandFor:
 * the athlete's finish in Open Singles terms on their own sex's field; on the
 * pooled field the thresholds are 3774, 4869, 6318 and 7853 s, S8-S9), not
 * the old global 1:00 / 1:20 / 1:40 / 2:00 scale
 * (HYROX_TIME_TO_BAND_THRESHOLDS, kept for reference). Single source for the
 * grouping the station doses (hyrox-station-dose.ts) and the weekly structure
 * below read.
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

export interface HyroxSessionCounts {
  runs: number;
  stations: number;
  bricks: number;
  /** Standalone strength sessions (lane H2b part 2): the beginner and
   *  intermediate base week's one session beside the station session's
   *  block. Absent: none (the stored counts never hold it). */
  strength?: number;
}

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
 * Beginner and intermediate base weeks hold one standalone strength session
 * (lane H2b part 2, sheet sessions.weekly: 2 runs + 1 station session + 1
 * strength, 3 runs + 1 station session + 1 strength), in the slot the brick
 * takes from build; every station session opens with a strength block
 * (HYROX_STRENGTH_SESSIONS counts it). Taper weeks keep the peak structure (Bosquet et al. 2007: no benefit from
 * cutting frequency); race week has no brick (the race is the week's brick).
 * No brick before plan week HYROX_FIRST_BRICK_WEEK or in base (bricks.timing).
 */
export const HYROX_WEEKLY_STRUCTURE: Record<HyroxTier, Record<'base' | 'build' | 'peak', HyroxSessionCounts>> = {
  beginner: {
    base:  { runs: 2, stations: 1, bricks: 0, strength: 1 },
    build: { runs: 2, stations: 1, bricks: 1 },
    peak:  { runs: 2, stations: 1, bricks: 1 },
  },
  intermediate: {
    base:  { runs: 3, stations: 1, bricks: 0, strength: 1 },
    build: { runs: 3, stations: 1, bricks: 1 },
    peak:  { runs: 3, stations: 1, bricks: 1 },
  },
  advanced: {
    base:  { runs: 3, stations: 2, bricks: 0 },
    build: { runs: 3, stations: 2, bricks: 1 },
    peak:  { runs: 3, stations: 1, bricks: 2 },
  },
};

/**
 * Strength sessions a week by tier and phase (parameter sheet
 * strength.sessions; Blagrove 2018: 2 to 3 a week improve running economy 2
 * to 8%; Fast Talk 2 in base; Ronnestad 2010: after 12 weeks at 2 a week, 1 a
 * week kept the gains for 13 weeks, n=6 cyclists). A station session's
 * strength block counts toward it (Tristan's brief, 2026-10-20), so beginner
 * and intermediate base is the block plus one standalone session, advanced
 * base and build the blocks of its two station sessions, every peak the one
 * station session's block. The week before race week holds 1 light session
 * (the first station session's block, the activation template: heavy lifting
 * stops 7 days out) and race week none. Planning side.
 */
export const HYROX_STRENGTH_SESSIONS: Record<HyroxTier, Record<'base' | 'build' | 'peak', number>> = {
  beginner:     { base: 2, build: 1, peak: 1 },
  intermediate: { base: 2, build: 1, peak: 1 },
  advanced:     { base: 2, build: 2, peak: 1 },
};

/** Minutes of the strength block that opens a station session: the
 *  running-strength pool's shortest session (gym.ts RUNNING_STRENGTH_PHASE
 *  taper, 20 min; running-pool exerciseCountForTime: 4 exercises up to 20 min,
 *  one each of max strength, single-leg, posterior chain and calf-foot, the
 *  sheet's strength.content). A product choice reusing the app's value: the
 *  sheet gives no block length. */
export const HYROX_STRENGTH_BLOCK_MIN = 20;

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
 *     in the sheet; the session slider (2 to 7) never reaches it through the
 *     stored counts (a 7-session beginner or intermediate week is 5 runs + 1
 *     station + 1 brick, an advanced one 4 runs + 2 + 1). The plan engine
 *     fills a week's free session slots with easy erg work instead: run slots
 *     the running share cannot fund, and slots the phase structure leaves
 *     empty (a base week has no brick), never above the chosen total.
 *   - Reducing: bricks first, then station sessions (never below 1), then runs
 *     (never below 1). Unchanged order from the previous distributeSessionCount.
 */
export function applyHyroxSessionDelta(row: HyroxSessionCounts, delta: number): HyroxSessionCounts {
  let { runs, stations, bricks } = row;
  let strength = row.strength ?? 0;
  let d = Math.round(delta);
  while (d > 0 && runs < HYROX_MAX_RUNS_PER_WEEK) { runs++; d--; }
  while (d < 0) {
    // The standalone strength session holds the brick's slot in base, so it
    // goes first, as the brick does.
    if (strength > 0) strength--;
    else if (bricks > 0) bricks--;
    else if (stations > 1) stations--;
    else if (runs > 1) runs--;
    else break;
    d++;
  }
  return row.strength != null ? { runs, stations, bricks, strength } : { runs, stations, bricks };
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
  return c.runs + c.stations + c.bricks + (c.strength ?? 0);
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
 * Doubles uses the same rate. The old doubles halving assumed each partner
 * did 4 whole stations; partners actually split the work inside every station
 * and run together (26/27 Doubles rulebook s7.2, s7.3), and no per-leg doubles
 * data exists to set a different rate. The rate only shapes the per-leg split:
 * legs are normalised to the run total, which comes from the run pace
 * (doubles: hyrox-doubles.ts run ratio).
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
 *  external loads (stationExternalLoadKg, any tier). They are exactly the stations
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
 * Taper: hyroxTaperFraction of the reference week, 0.55 then 0.30.
 *
 * Deload: every 4th plan week in base, build and peak (isHyroxDeloadWeek: the
 * 4-week cycle, except the week right before the race taper, which never
 * deloads, as running's sharpening block skips it; Tristan 2026-10-13) at 0.75
 * of the week's volume. HWPO's HYROX programme deloads every 4th week;
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

/**
 * Share of the reference week (the last loaded week) for race-taper week
 * `weekInTaper` (1-indexed; `taperWeeks` = race week) of a HYROX plan
 * (planning side). Tristan's decision of 2026-10-19: HYROX matches triathlon
 * (triTaperFraction, TRI_TAPER_FIRST_WEEK_FRACTION / TRI_RACE_WEEK_FRACTION):
 * 0.55 in the week before race week, then 0.30 in race week, a 57.5% mean cut,
 * inside the 41 to 60% band with the largest effect (Bosquet et al. 2007,
 * ES 0.72; Wang et al. 2023, SMD -0.77); a race-week-only taper (a 1-week
 * plan) is 0.55. The one source for the generator's taper weeks and the
 * weekly load target (planned-week-target.ts). Before 2026-10-19 HYROX ran
 * running's 0.70 then 0.55 (taperFraction, phases.ts), the parameter sheet's
 * taper.volume reading. The race taper's smallest circuit or brick, race
 * week's primer and the closing-week rules sit outside the fraction
 * (plan_engine.hyrox).
 */
export function hyroxTaperFraction(weekInTaper: number, taperWeeks: number): number {
  return triTaperFraction(weekInTaper, taperWeeks);
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
 *  4-week chronic load). Weeks before plan week 1 count as the athlete's
 *  logged weekly load (signalBBaseline, canonical TSS) when it exists, which
 *  also guards week 1, otherwise as the nominal week 1: its structure with a
 *  station session in the assessment's slot (Tristan 2026-10-13). Before,
 *  they counted as week 1 itself, the light assessment week. */
export const HYROX_CHRONIC_WINDOW_WEEKS = 4;

// ─── Time distribution across session types ──────────────────────────────────

/**
 * Running share, every tier: standalone runs plus the run segments of bricks
 * (parameter sheet split.running_share). Measured against the athlete's
 * chosen weekly hours (Tristan 2026-10-13, D2): a training week's running
 * budget is 0.40 x the chosen weekly minutes, a deload's too (its ceiling,
 * 0.75 of the last loaded week, and its deloaded long run do the reducing),
 * never above it under the effort lever; a taper week's is 0.40 x the taper
 * week's own budget. Before 2026-10-13 the share was taken of the
 * phase-scaled week budget, so base weeks funded 0.22 to 0.34 of the hours
 * and the quality run often did not fit. The rest of the week holds station
 * sessions and the bricks' station work (0.60 of the week's budget). Minutes
 * the sessions leave unprescribed go to easy erg work (SkiErg or row, the
 * sheet's split.running_share row), never to more running; weekly hours stay
 * a ceiling. Lucy Procter's 40 to 50% of her own hours is the only figure; the
 * low end is used. Ketzer 2026 attributes 27.6% of single-element injuries to
 * running. Replaces HYROX_TIME_SPLIT (runs 0.40 / stations 0.35 / bricks
 * 0.25), which put about 50% of the week into running once brick runs counted.
 */
export const HYROX_RUN_SHARE = 0.40;

/** Prescribed RPE of easy HYROX aerobic work: easy runs and easy erg sessions
 *  (the generator's existing easy-run RPE, also the RPE of the week-1
 *  assessment's easy pass). Technique effort is RPE 5 (sheet stations row);
 *  the sheet sends unprescribed hours to easy erg work, so it takes the easy
 *  value. */
export const HYROX_EASY_RPE = 4;

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
 *  its easy floor, instead of being raised past the week's running share.
 *  Also the shortest easy erg session (plan_engine.hyrox: unprescribed minutes
 *  below it stay unprescribed): the same easy aerobic floor, reused. */
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
 *  HYROX race pace over 1 km (standing rest; the sheet's goal race pace,
 *  priced at the athlete's current HYROX run pace). */
export type HyroxQualityFormat =
  | { kind: 'run_tempo'; workMin: number }
  | { kind: 'run_intervals'; reps: number; repMin: number; recoveryMin: number; target: 'hr' }
  | { kind: 'run_intervals'; reps: number; repKm: number; recoveryMin: number; target: 'race_pace' };

/**
 * One quality run a week by tier and phase (parameter sheet intervals.formats;
 * HYROX Data Lab, Dearden, Gutierrez-Hellin 2026, Rox Lyfe). Beginner base is
 * easy running only. Peak: beginner 4 x 3 min and advanced 6 x 4 min at about
 * 90% of max HR with 3 min easy jog; intermediate 8 x 1 km at race pace with
 * 3 min rest (the sheet's goal race pace; the generator prices it at the
 * athlete's current HYROX run pace and labels it HYROX race pace). 10 min warm-up and 5 min cool-down (existing). Taper weeks
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

/** Warm-up opening every station session and brick (lane H2b part 2): the
 *  existing run warm-up length (HYROX_QUALITY_WARMUP_MIN), easy on the erg or
 *  an easy jog. */
export const HYROX_SESSION_WARMUP_MIN = HYROX_QUALITY_WARMUP_MIN;

/** Shortest easy erg finisher on a station session: the existing cool-down
 *  length (HYROX_QUALITY_COOLDOWN_MIN), the shortest easy block the
 *  generators prescribe. Spare minutes below it stay with the other
 *  sessions or unprescribed. */
export const HYROX_FINISHER_MIN_MIN = HYROX_QUALITY_COOLDOWN_MIN;

/** Shortest tempo block (minutes): the generator's existing floor on tempo
 *  work, unchanged since the triathlon port. A taper tempo holds at least this
 *  much work, and its duration is the warm-up, this work and the cool-down
 *  (before 2026-10-13 a tempo sized under 25 min kept its smaller duration
 *  while its description still prescribed 10 + 10 + 5 min). */
export const HYROX_TEMPO_MIN_WORK_MIN = 10;

/** Race-week primer (minutes): the minimum taper tempo, warm-up + 10 min of
 *  tempo + cool-down (SCIENCE_LOG §CE: race-week quality volume collapses to a
 *  short primer; the 24 min of threshold 3 days out it names was the bug). Fixed
 *  whatever the race-week budget. The base generator produced the same 10 min
 *  of work; the review of 2026-10-12 found the v18 draft sized it from the run
 *  share (median 15 to 17 min of work, up to 24, for advanced athletes). */
export const HYROX_RACE_WEEK_PRIMER_MIN = HYROX_QUALITY_WARMUP_MIN + HYROX_TEMPO_MIN_WORK_MIN + HYROX_QUALITY_COOLDOWN_MIN;
