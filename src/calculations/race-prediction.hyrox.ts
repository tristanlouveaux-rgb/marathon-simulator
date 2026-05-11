/**
 * HYROX race-time prediction.
 *
 * **Side of the line**: tracking. Predicts a finish time from current
 * benchmarks + venue factors. Not a planning prescription.
 *
 * Model
 *   total = (8 × 1km run legs) + Σ(8 stations) + RoxZone transitions
 *   each component multiplied by venue-derived factors:
 *     - run loop:    floor surface × lap difficulty × temperature × altitude
 *     - sled stations: + per-station seconds delta from floor surface
 *     - endurance stations: × temperature (ski_erg, row_erg, wall_balls,
 *       burpee_broad_jumps, sandbag_lunges) and × altitude
 *
 * Inputs (in priority order):
 *   - Per-station calibrated benchmark from `hyroxConfig.stationBenchmarks`
 *     (else seed time for the user's ability band).
 *   - Per-km run pace from `hyroxConfig.hyroxRunPaceSecKm` (else seed pace).
 *   - Venue id from `hyroxConfig.venueId`. When absent, the prediction is
 *     venue-neutral and `courseFactors` is empty.
 *
 * Confidence: medium-low. Station seed times are well-anchored (HyroxDataLab,
 * roxlyfe.com); venue multipliers are coarse heuristics — see
 * `src/data/hyrox-venues.ts` header for the rationale.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxStation, AbilityBand } from '@/types/triathlon';
import {
  HYROX_STATION_ORDER,
  STATION_SEED_TIMES_SEC,
  SEED_ROXZONE_SEC,
} from '@/constants/hyrox-benchmarks';
import { deriveHyroxRunPace } from './hyrox-run-pace';
import { computeHyroxStaleness, bandFromVdot } from './hyrox-staleness';
import { PER_STATION_FATIGUE_RATE_BY_BAND, HYROX_PRO_STATION_MULTIPLIER } from '@/constants/hyrox-constants';
import {
  getHyroxVenueById,
  HYROX_FLOOR_RUN_MULTIPLIER,
  HYROX_FLOOR_SLED_DELTA_SEC,
  HYROX_LAP_RUN_MULTIPLIER,
  HYROX_TEMP_RUN_MULTIPLIER,
  HYROX_TEMP_STATION_MULTIPLIER,
} from '@/data/hyrox-venues';
import { altitudeRunMultiplier } from '@/constants/triathlon-course-factors';
import { yearsOfTrainingToExperienceLevel } from '@/constants/triathlon-horizon-params';
import { applyHyroxStationHorizon, applyHyroxRoxzoneHorizon } from './training-horizon.hyrox';
import { plannedHyroxSessionsPerWeek } from './hyrox-volume';

/** Stations whose performance is metabolically taxed by heat / altitude. */
const ENDURANCE_STATIONS: HyroxStation[] = [
  'ski_erg', 'row_erg', 'wall_balls', 'burpee_broad_jumps', 'sandbag_lunges',
];

const SLED_STATIONS: HyroxStation[] = ['sled_push', 'sled_pull'];

export interface HyroxCourseFactor {
  kind: 'floor' | 'lap' | 'temp' | 'altitude';
  label: string;
  value: string;
  deltaSec: number;
}

export interface HyroxStationLine {
  station: HyroxStation;
  baseSec: number;
  adjustedSec: number;
  source: 'calibrated' | 'seed';
}

/** Per-run-leg prediction with fatigue multiplier applied. */
export interface HyroxRunLeg {
  legNumber: number;   // 1–8
  paceSecKm: number;   // adjusted for accumulated fatigue
  durationSec: number; // 1km at that pace
  fatigueMultiplier: number;
}

/**
 * Per-station "current → projected" marker for the live forecast.
 *
 * `currentSec` IS the same `baseSec` shown in `stations[].baseSec` — the
 * value the user already sees on the benchmark card and forecast view.
 * Anchoring both surfaces to the same number is deliberate (mirrors the
 * triathlon LT-pace lesson where two views showed different "current"
 * numbers for the same metric).
 *
 * `projectedSec` is the race-day estimate from the per-class horizon model
 * (`applyHyroxStationHorizon` in `training-horizon.hyrox.ts`). NO venue
 * factors are applied — this is "test pace today → test pace race day".
 * Venue adjustments live in the existing course-factors panel.
 */
export interface HyroxStationProjection {
  station: HyroxStation;
  currentSec: number;
  projectedSec: number;
  source: 'calibrated' | 'seed';
  /** Realised improvement % the horizon model returned (≥ 0). */
  improvementPct: number;
}

/** Aggregate projection markers attached to HyroxPrediction. */
export interface HyroxProjectionMarkers {
  stations: HyroxStationProjection[];
  roxzone: { currentSec: number; projectedSec: number; improvementPct: number };
  /** Weeks until race (0 if no race date / past). */
  weeksRemaining: number;
  /** Hyrox-style sessions/wk fed to the horizon model (look-ahead avg). */
  plannedSessionsPerWeek: number;
}

export interface HyroxPrediction {
  totalSec: number;
  /** Pre-venue baseline (ability-band benchmarks + roxzone). */
  rawSec: number;
  /** Eight 1km run legs total, post-venue. */
  runSec: number;
  /** All 8 stations summed, post-venue. */
  stationsSec: number;
  /** Transitions between zones. */
  roxzoneSec: number;
  /** Per-station breakdown for UI. */
  stations: HyroxStationLine[];
  /** Per-run-leg breakdown showing fatigue progression. */
  runLegs: HyroxRunLeg[];
  /** Course factors layered on top of raw fitness. */
  courseFactors: HyroxCourseFactor[];
  venueId?: string;
  computedAtISO: string;
  /** Prediction confidence based on calibration coverage. */
  confidence: 'high' | 'medium' | 'low';
  /** Number of calibrated stations (vs seed). */
  calibratedCount: number;
  /** Whether cross-format conversion was applied (doubles→singles or vice-versa). */
  crossFormatConversion?: 'doubles_to_singles' | 'singles_to_doubles';
  /** Provenance of the run pace used in this prediction. */
  runPaceSource: 'user' | 'derived' | 'seed';
  /** Race-time staleness summary, surfaced in the UI for transparency. */
  staleness?: {
    ageMonths: number;
    category: 'fresh' | 'aging' | 'stale' | 'very_stale' | 'unknown';
    physiologyMitigation: number;
  };
  /**
   * Per-station + roxzone "current → projected" markers — research-grounded
   * trajectory at current training dose. Independent of `buildHyroxProjection`
   * (which projects the AGGREGATE finish from MTL/adherence/taper signals).
   * This field projects each STATION'S test pace on race day.
   */
  projection?: HyroxProjectionMarkers;
}

export function predictHyroxRace(state: SimulatorState): HyroxPrediction | null {
  const hx = state.hyroxConfig;
  if (!hx) return null;

  const band = hx.athleteBand;
  const seeds = STATION_SEED_TIMES_SEC[band];
  const seedRoxzone = SEED_ROXZONE_SEC[band];

  // Run pace: VDOT-derived when physiology is available, then user-set
  // override (yields to a meaningfully-faster derived value), then seed fallback.
  const { paceSecKm: runPaceSecKm, source: runPaceSource } = deriveHyroxRunPace(state);

  // ── Format flags ──────────────────────────────────────────────────────────
  const isDoubles = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const isPro     = hx.format === 'pro_singles'  || hx.format === 'pro_doubles';

  // ── Format-aware benchmark resolution ────────────────────────────────────
  // Use only same-format benchmarks. Cross-format per-station inference is not
  // defensible from current data (4 vs 8 stations, asymmetric rest pattern,
  // cohort selection bias), so when the only available benchmarks are in the
  // OTHER format we fall back to seed times for the target format and surface
  // the gap as a confidence drop in the UI. Same-athlete cross-format
  // adjustment happens at band derivation only (see initialization.hyrox.ts).
  // Legacy stationBenchmarks (pre-slot-migration) are treated as same-format
  // for backwards compatibility.
  let userBenchmarks: Partial<Record<HyroxStation, number>>;
  let crossFormatConversion: HyroxPrediction['crossFormatConversion'];

  const hasSingles = hx.stationBenchmarksSingles != null && Object.keys(hx.stationBenchmarksSingles).length > 0;
  const hasDoubles = hx.stationBenchmarksDoubles != null && Object.keys(hx.stationBenchmarksDoubles).length > 0;
  const hasLegacy  = hx.stationBenchmarks != null && Object.keys(hx.stationBenchmarks).length > 0;

  if (!isDoubles) {
    // Predicting singles
    if (hasSingles) {
      userBenchmarks = hx.stationBenchmarksSingles!;
    } else if (hasDoubles) {
      // Doubles per-station times include partner-rest and only cover 4 of 8
      // stations — neither maps reliably to fresh singles capacity. Fall back
      // to seeds for the target format; UI drops confidence to 'low'.
      userBenchmarks = {};
      crossFormatConversion = 'doubles_to_singles';
    } else {
      userBenchmarks = hx.stationBenchmarks ?? {};
    }
  } else {
    // Predicting doubles
    if (hasDoubles) {
      userBenchmarks = hx.stationBenchmarksDoubles!;
    } else if (hasSingles) {
      // Singles per-station times are a fresh-rep ceiling but real doubles
      // pacing benefits from rest patterns we don't model. Fall back to seeds.
      userBenchmarks = {};
      crossFormatConversion = 'singles_to_doubles';
    } else {
      userBenchmarks = hx.stationBenchmarks ?? {};
    }
  }

  // In doubles format each athlete runs all 8 legs but only completes 4 stations.
  // Convention: athlete covers odd-indexed stations (0,2,4,6 in HYROX_STATION_ORDER).
  const activeStations = isDoubles
    ? HYROX_STATION_ORDER.filter((_, i) => i % 2 === 0)
    : HYROX_STATION_ORDER;
  const stationCount = activeStations.length; // 4 for doubles, 8 for singles

  // ── Run-leg fatigue model ─────────────────────────────────────────────────
  // Each completed station adds eccentric + metabolic fatigue that slows
  // subsequent run legs. From HyroxDataLab finishing-time distributions:
  // - Run 1 (no stations yet): ~2–5% faster than average pace
  // - Runs 2–6: gradual progression from fast → average
  // - Runs 7–8: heaviest fatigue; magnitude scales with ability band
  // Rate is band-scaled (PER_STATION_FATIGUE_RATE_BY_BAND in hyrox-constants.ts):
  // elite/competitive: ~0.4%/station (hold pace); beginner: ~1.1%/station.
  // For doubles: halve the rate (athlete completes every other station;
  // waiting partner still accumulates metabolic cost, so not zero).
  const baseRate = PER_STATION_FATIGUE_RATE_BY_BAND[band] ?? 0.007;
  const PER_STATION_FATIGUE_RATE = isDoubles ? baseRate * 0.5 : baseRate;

  function runLegFatigueMultiplier(legIndex: number): number {
    // legIndex 0 = first run (before any stations), 7 = last run (after 7 stations)
    return 1 + legIndex * PER_STATION_FATIGUE_RATE;
  }

  // Compute raw legs then normalise so the total equals 8 × base pace (energy conservation).
  const rawLegMultipliers = Array.from({ length: 8 }, (_, i) => runLegFatigueMultiplier(i));
  const avgMult = rawLegMultipliers.reduce((s, m) => s + m, 0) / 8;
  const normLegMultipliers = rawLegMultipliers.map(m => m / avgMult);

  // ── Race-time staleness ──────────────────────────────────────────────────
  // When the user's last Hyrox race is old, we don't fully trust the band that
  // race implied or the per-station splits derived from it. `bandWeight` and
  // `splitsWeight` (computed in hyrox-staleness.ts) are physiology-mitigated
  // decay factors in [0,1]. Strong current VDOT/MTL/Strava CTL pulls them back
  // toward 1.0 — an athlete who clearly held fitness escapes the penalty.
  // Splits weight decays slower than band weight because skill components
  // (sled push, sandbag carry, wall ball cadence) persist longer than VO2max.
  const stale = computeHyroxStaleness(state);

  // Effective seeds: when band is stale AND current VDOT implies a different
  // band, blend the stored-band seeds toward the VDOT-implied band's seeds
  // using bandWeight. A 24-month-old race that put the athlete in 'novice'
  // but a current VDOT of 53 should weight toward 'advanced' seeds.
  const vdotBand = bandFromVdot(state.v);
  const useBandBlend = stale.bandWeight < 1 && vdotBand != null && vdotBand !== band;
  const effectiveSeeds = useBandBlend
    ? (Object.fromEntries(
        HYROX_STATION_ORDER.map(st => [
          st,
          stale.bandWeight * seeds[st] +
          (1 - stale.bandWeight) * STATION_SEED_TIMES_SEC[vdotBand!][st],
        ]),
      ) as Record<HyroxStation, number>)
    : seeds;
  const effectiveSeedRoxzone = useBandBlend
    ? stale.bandWeight * seedRoxzone +
      (1 - stale.bandWeight) * SEED_ROXZONE_SEC[vdotBand!]
    : seedRoxzone;

  // ── Raw baseline (pre-venue) ──────────────────────────────────────────────
  // Format conversion is applied PER-CONTRIBUTOR (calibrated and seed
  // separately) BEFORE the staleness blend. This matters because seeds are
  // always at Open weights, but calibrated benchmarks may be at Pro weights
  // when `benchmarksAtProWeights` is true. Mixing the two contributors at
  // mismatched weight regimes and then applying a single post-blend mult
  // would over- or under-correct the seed portion.
  //
  // Conversion rules per station:
  //   - Open source → Pro target: multiply by HYROX_PRO_STATION_MULTIPLIER
  //   - Pro source  → Open target: divide by HYROX_PRO_STATION_MULTIPLIER
  //   - Same regime: identity
  // Erg / bodyweight stations have a multiplier of 1.0 (weight regime doesn't
  // change rep time), so the conversion is a no-op there.
  const benchmarksArePro = !!hx.benchmarksAtProWeights;
  const rawRunSec = runPaceSecKm * 8;
  const stationLines: HyroxStationLine[] = activeStations.map(station => {
    const calibrated = userBenchmarks[station];
    const seedTime = effectiveSeeds[station]; // always Open weights
    const fMult = HYROX_PRO_STATION_MULTIPLIER[station] ?? 1.0;

    // Convert calibrated benchmark to TARGET format.
    let calibratedAtTarget: number | undefined;
    if (calibrated != null) {
      if (isPro && !benchmarksArePro) {
        calibratedAtTarget = calibrated * fMult;       // Open → Pro: slower
      } else if (!isPro && benchmarksArePro) {
        calibratedAtTarget = calibrated / fMult;       // Pro → Open: faster
      } else {
        calibratedAtTarget = calibrated;               // identity
      }
    }
    // Seeds are at Open weights; only multiply when target is Pro.
    const seedAtTarget = isPro ? seedTime * fMult : seedTime;

    // splitsWeight blend at TARGET format. fresh race → splitsWeight=1 →
    // calibrated wins. very_stale + weak physio → ≈0.6 → 60/40 blend.
    const baseSec = calibratedAtTarget != null
      ? stale.splitsWeight * calibratedAtTarget + (1 - stale.splitsWeight) * seedAtTarget
      : seedAtTarget;
    return {
      station,
      baseSec,
      adjustedSec: baseSec, // mutated below for venue factors
      source: calibrated != null ? ('calibrated' as const) : ('seed' as const),
    };
  });
  const rawStationsSec = stationLines.reduce((sum, l) => sum + l.baseSec, 0);
  const roxzoneSeed = isDoubles
    ? Math.round(effectiveSeedRoxzone * stationCount / 8)
    : effectiveSeedRoxzone;
  const rawSec = Math.round(rawRunSec + rawStationsSec + roxzoneSeed);

  // ── Venue resolution ──────────────────────────────────────────────────────
  const venue = hx.venueId ? getHyroxVenueById(hx.venueId) : undefined;
  const courseFactors: HyroxCourseFactor[] = [];

  // Default identity multipliers (no venue → venue-neutral).
  let runFloorMult = 1.0;
  let runLapMult = 1.0;
  let runTempMult = 1.0;
  let runAltMult = 1.0;
  let stationTempMult = 1.0;
  let stationAltMult = 1.0;
  let sledFloorDeltaSec = 0;

  if (venue) {
    runFloorMult = HYROX_FLOOR_RUN_MULTIPLIER[venue.floorSurface];
    runLapMult = HYROX_LAP_RUN_MULTIPLIER[venue.lapDifficulty];
    runTempMult = HYROX_TEMP_RUN_MULTIPLIER[venue.tempTendency];
    runAltMult = altitudeRunMultiplier(venue.altitudeM);
    stationTempMult = HYROX_TEMP_STATION_MULTIPLIER[venue.tempTendency];
    // Reuse run-altitude curve for endurance-station altitude effect — the
    // physiological mechanism (reduced O2 availability) is the same.
    stationAltMult = altitudeRunMultiplier(venue.altitudeM);
    sledFloorDeltaSec = HYROX_FLOOR_SLED_DELTA_SEC[venue.floorSurface];
  }

  // ── Apply per-component multipliers ──────────────────────────────────────
  const runVenueMult = runFloorMult * runLapMult * runTempMult * runAltMult;
  const runSecAdj = rawRunSec * runVenueMult;

  // Pro/Open weight regime is now baked into `baseSec` (see per-contributor
  // format conversion above), so this loop only handles venue effects.
  for (const line of stationLines) {
    let mult = 1.0;
    if (ENDURANCE_STATIONS.includes(line.station)) {
      mult *= stationTempMult * stationAltMult;
    }
    line.adjustedSec = line.baseSec * mult;
    if (SLED_STATIONS.includes(line.station)) {
      line.adjustedSec += sledFloorDeltaSec;
    }
  }
  const stationsSecAdj = stationLines.reduce((sum, l) => sum + l.adjustedSec, 0);

  // RoxZone transitions are not affected by venue at v1 (already small).
  const roxzoneSecAdj = roxzoneSeed;

  // ── Itemise course-factor rows for UI ─────────────────────────────────────
  // When a venue is set, always emit all four rows (even with zero delta) so
  // the UI shows what was actually modelled at this race — users can see "Lap:
  // standard, +0.0%" rather than the row silently disappearing.
  if (venue) {
    const floorDelta =
      rawRunSec * (runFloorMult - 1) +
      sledFloorDeltaSec * 2; // 2 sled stations
    courseFactors.push({
      kind: 'floor',
      label: 'Floor surface',
      value: surfaceLabel(venue.floorSurface),
      deltaSec: floorDelta,
    });

    courseFactors.push({
      kind: 'lap',
      label: 'Run loop',
      value: lapLabel(venue.lapDifficulty),
      deltaSec: rawRunSec * (runLapMult - 1),
    });

    const tempDelta =
      rawRunSec * (runTempMult - 1) +
      stationLines
        .filter(l => ENDURANCE_STATIONS.includes(l.station))
        .reduce((sum, l) => sum + l.baseSec * (stationTempMult - 1), 0);
    courseFactors.push({
      kind: 'temp',
      label: 'Venue temperature',
      value: tempLabel(venue.tempTendency),
      deltaSec: tempDelta,
    });

    const altDelta =
      rawRunSec * (runAltMult - 1) +
      stationLines
        .filter(l => ENDURANCE_STATIONS.includes(l.station))
        .reduce((sum, l) => sum + l.baseSec * (stationAltMult - 1), 0);
    courseFactors.push({
      kind: 'altitude',
      label: 'Altitude',
      value: `${venue.altitudeM} m`,
      deltaSec: altDelta,
    });
  }

  // Build per-leg run breakdown (apply venue multiplier to each leg individually)
  const adjPaceSecKm = runPaceSecKm * runVenueMult;
  const runLegs: HyroxRunLeg[] = normLegMultipliers.map((mult, i) => {
    const legPace = Math.round(adjPaceSecKm * mult);
    return {
      legNumber: i + 1,
      paceSecKm: legPace,
      durationSec: legPace, // 1km leg
      fatigueMultiplier: mult,
    };
  });

  const totalSec = Math.round(runSecAdj + stationsSecAdj + roxzoneSecAdj);

  // ── Confidence scoring ────────────────────────────────────────────────────
  // Cross-format predictions (only the OTHER format's benchmarks available)
  // run on seed times for the target format; confidence is forced to 'low'.
  // Race-age staleness can also cap confidence (medium/low) when the previous
  // race is older than 6 months and current physiology can't fully mitigate.
  const calibratedCount = stationLines.filter(l => l.source === 'calibrated').length;
  let confidence: HyroxPrediction['confidence'] =
    crossFormatConversion ? 'low' :
    calibratedCount >= 6 && hx.venueId ? 'high' :
    calibratedCount >= 3 ? 'medium' :
    'low';
  if (stale.confidenceCap === 'low') confidence = 'low';
  else if (stale.confidenceCap === 'medium' && confidence === 'high') confidence = 'medium';

  // ── Per-station "current → projected" trajectory ──────────────────────────
  // Independent from `buildHyroxProjection` — that one projects the AGGREGATE
  // finish from MTL / adherence / taper / readiness signals. This one
  // projects EACH station's test pace from the per-class horizon model
  // (research-grounded gain rates calibrated to weeks remaining + planned
  // Hyrox sessions/wk).
  // - Anchor `currentSec` to the same `baseSec` shown elsewhere (lesson from
  //   the triathlon LT-pace bug: two surfaces showing different "current"
  //   values for the same metric).
  // - No venue factors here — projection is "test pace today → test pace
  //   race day". Venue adjustments stay in the course-factors panel.
  const projection = buildStationProjection(state, stationLines, roxzoneSeed, band);

  return {
    totalSec,
    rawSec,
    runSec: Math.round(runSecAdj),
    stationsSec: Math.round(stationsSecAdj),
    roxzoneSec: roxzoneSecAdj,
    stations: stationLines.map(l => ({
      ...l,
      adjustedSec: Math.round(l.adjustedSec),
    })),
    runLegs,
    courseFactors,
    venueId: venue?.id,
    computedAtISO: new Date().toISOString(),
    confidence,
    calibratedCount,
    crossFormatConversion,
    runPaceSource,
    staleness: stale.ageMonths != null
      ? { ageMonths: stale.ageMonths, category: stale.category, physiologyMitigation: stale.physiologyMitigation }
      : undefined,
    projection,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Station projection helper
// ────────────────────────────────────────────────────────────────────────────

function buildStationProjection(
  state: SimulatorState,
  stationLines: HyroxStationLine[],
  roxzoneSec: number,
  band: AbilityBand,
): HyroxProjectionMarkers {
  const weeksRemaining = computeWeeksRemainingForHorizon(state);
  // PLANNED sessions/wk, not historical. Lesson from tri (race-prediction.
  // triathlon.ts:118): historical reads 0/wk on a fresh plan and trips the
  // undertrain penalty, making the projection slower than current.
  const sessionsPerWeek = plannedHyroxSessionsPerWeek(state, 4);
  const yearsTraining = computeYearsOfTrainingFromState(state);
  const experienceLevel = yearsOfTrainingToExperienceLevel(yearsTraining);

  const horizonInput = {
    weeks_remaining: weeksRemaining,
    sessions_per_week: sessionsPerWeek,
    ability_band: band,
    experience_level: experienceLevel,
    // adaptation_ratio defaults to 1.0; future signals (HR-at-power drift on
    // erg sessions, pace decay across sled reps) will plug in here.
    // adherence_penalty_pct defaults to 0; future per-class shortfall scoring
    // will plug in here.
  };

  const stationProjections: HyroxStationProjection[] = stationLines.map(line => {
    const result = applyHyroxStationHorizon(line.station, {
      ...horizonInput,
      baseline: line.baseSec,
    });
    return {
      station: line.station,
      currentSec: Math.round(line.baseSec),
      projectedSec: Math.round(result.projected),
      source: line.source,
      improvementPct: result.improvement_pct,
    };
  });

  const roxzoneResult = applyHyroxRoxzoneHorizon({
    ...horizonInput,
    baseline: roxzoneSec,
  });

  return {
    stations: stationProjections,
    roxzone: {
      currentSec: Math.round(roxzoneSec),
      projectedSec: Math.round(roxzoneResult.projected),
      improvementPct: roxzoneResult.improvement_pct,
    },
    weeksRemaining,
    plannedSessionsPerWeek: sessionsPerWeek,
  };
}

/** Weeks until the Hyrox race date. Returns 0 if no race or already past. */
function computeWeeksRemainingForHorizon(state: SimulatorState): number {
  const raceDate = state.hyroxConfig?.raceDate ?? state.onboarding?.customRaceDate;
  if (!raceDate) return 0;
  const today = new Date();
  const race = new Date(raceDate);
  if (Number.isNaN(race.getTime())) return 0;
  const diffMs = race.getTime() - today.getTime();
  if (diffMs <= 0) return 0;
  return diffMs / (1000 * 60 * 60 * 24 * 7);
}

/** Years of endurance training. Used for the EXP_FACTORS lookup. */
function computeYearsOfTrainingFromState(state: SimulatorState): number | undefined {
  const iso = state.firstStravaActivityISO;
  if (!iso) return undefined;
  const first = new Date(iso);
  const now = new Date();
  if (Number.isNaN(first.getTime())) return undefined;
  const yrs = (now.getTime() - first.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  return yrs > 0 ? yrs : undefined;
}

// ── Labels ──────────────────────────────────────────────────────────────────

function surfaceLabel(s: 'rubber' | 'mixed' | 'concrete'): string {
  switch (s) {
    case 'rubber':   return 'Rubber';
    case 'mixed':    return 'Mixed surfaces';
    case 'concrete': return 'Concrete';
  }
}

function lapLabel(l: 'easy' | 'standard' | 'hard'): string {
  switch (l) {
    case 'easy':     return 'Wide / fast';
    case 'standard': return 'Standard';
    case 'hard':     return 'Tight / technical';
  }
}

function tempLabel(t: 'cool' | 'standard' | 'warm' | 'hot'): string {
  switch (t) {
    case 'cool':     return 'Cool (15–19°C)';
    case 'standard': return 'Standard (20–24°C)';
    case 'warm':     return 'Warm (25–28°C)';
    case 'hot':      return 'Hot (29°C+)';
  }
}
