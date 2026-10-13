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
 *     (else the seed: the real band median of the field the band was read in,
 *     at the target's weights, hyroxStationSeedsAtTarget).
 *   - Per-km run pace from `hyroxConfig.hyroxRunPaceSecKm` (else seed pace).
 *   - Venue id from `hyroxConfig.venueId`. When absent, the prediction is
 *     venue-neutral and `courseFactors` is empty.
 *
 * Confidence: medium-low. Seeds, doubles ratios and the Open/Pro conversion
 * read the real results (HYROX results, seasons 8 and 9, hyrox-results.ts);
 * venue multipliers are coarse heuristics. See `src/data/hyrox-venues.ts`
 * header for the rationale.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxStation, AbilityBand } from '@/types/triathlon';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { deriveHyroxRunPace } from './hyrox-run-pace';
import { computeHyroxStaleness, bandFromVdot } from './hyrox-staleness';
import { PER_STATION_FATIGUE_RATE_BY_BAND } from '@/constants/hyrox-constants';
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
import { stationInjuryBuildWeeks } from './hyrox-injury';
import { raceForecastHorizonISO } from '@/workouts/race-week-layout';
import {
  doublesRatioAt,
  doublesBenchmarkIsTeamTime,
  doublesStationSoloSec,
  doublesStationTeamSec,
  hyroxDoublesTables,
  hyroxDoublesTablesForState,
  type HyroxDoublesTables,
} from './hyrox-doubles';
import {
  hyroxOpenToProSec,
  hyroxProToOpenSec,
  hyroxSinglesCohortForState,
  hyroxSoloFrameForState,
  hyroxSoloLoadsArePro,
  hyroxSoloToFieldSec,
  hyroxStationSeedsAtTarget,
  hyroxSeedRoxzoneSec,
  type HyroxResultsCohort,
} from './hyrox-results';
import {
  benchmarkEntryForSlotValue,
  getStationHistory,
  isRaceSplitSource,
  type StationTestEntry,
  hyroxCalibrationCoverage,
  type BenchmarkSlot,
  type HyroxCalibrationCoverage,
} from './hyrox-station-history';
import { availableStations } from '@/workouts/hyrox-generators';
import { isHyroxProFormat } from './hyrox-division';

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
  /** Pre-venue station time at the target format. Doubles: the pair's time. */
  baseSec: number;
  adjustedSec: number;
  source: 'calibrated' | 'seed';
  /** Doubles only: this station's pair ÷ solo ratio, baseSec over the line's
   *  solo equivalent (each station maps at its own percentile in the
   *  station's results, hyrox-doubles.ts). Absent for singles. Anything that
   *  compares a line with one athlete's references (band seeds, solo history)
   *  divides by it first (stationSinglesEquivalentSec). Station percentiles
   *  place the line itself on the pair's division table. */
  teamRatio?: number;
  /** True when baseSec comes from a doubles race split (the pair's time).
   *  Doubles target: used as is, not mapped. Singles target: the pair's time
   *  converted to the solo time at the same percentile of that station's
   *  results. */
  teamTimeSplit?: boolean;
  /** True when baseSec reaches the target format through the doubles
   *  quantile mapping: for a doubles target every calibrated value that is
   *  not one of the target family's own doubles race splits (H1 decision,
   *  option A: solo values, and splits from the other weight family, which
   *  go solo, Open/Pro, then back to the pair); for a singles target a
   *  doubles race split. A cross-format estimate: it caps confidence at
   *  medium. */
  crossFormat?: boolean;
}

/** A station line's time in singles terms: the pair's time ÷ the doubles
 *  ratio for doubles, baseSec unchanged for singles. For comparisons against
 *  singles-anchored references (band seeds, station percentiles). */
export function stationSinglesEquivalentSec(line: Pick<HyroxStationLine, 'baseSec' | 'teamRatio'>): number {
  return line.baseSec / (line.teamRatio ?? 1);
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
 * `currentSec` IS the same `baseSec` shown in `stations[].baseSec`. The
 * value the user already sees on the benchmark card and forecast view.
 * Anchoring both surfaces to the same number is deliberate (mirrors the
 * triathlon LT-pace lesson where two views showed different "current"
 * numbers for the same metric).
 *
 * `projectedSec` is the race-day estimate from the per-class horizon model
 * (`applyHyroxStationHorizon` in `training-horizon.hyrox.ts`). NO venue
 * factors are applied. This is "test pace today → test pace race day".
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
  /** Set when at least one station is converted from the other format's
   *  benchmark through the doubles quantile mapping (the lines with
   *  crossFormat):
   *   - 'doubles_to_singles': a singles prediction reading a doubles race
   *     split (the pair's time) in singles terms, team time ÷
   *     crossFormatStationRatio (those lines also carry teamTimeSplit);
   *   - 'singles_to_doubles': a doubles prediction reading a singles time ×
   *     the station ratio.
   *  Either direction caps confidence at medium. */
  crossFormatConversion?: 'doubles_to_singles' | 'singles_to_doubles';
  /** With crossFormatConversion: the aggregate pair ÷ solo ratio over the
   *  converted stations (each station converts at its own ratio). */
  crossFormatStationRatio?: number;
  /** True only when the cross-format cap is what holds confidence at medium:
   *  without the converted stations the forecast would read high (6+
   *  calibrated stations and a venue). Absent when the forecast would be
   *  medium or low anyway (for example 3 calibrated stations, or no venue),
   *  or a staleness cap takes it to low. The copy names the cap only then
   *  (review 2026-10-13: it used to on any medium forecast holding converted
   *  stations). */
  crossFormatCapped?: boolean;
  /** Doubles only: the percentile-matched ratios applied (hyrox-doubles.ts). */
  doubles?: {
    /** Pair's 8-station time ÷ the solo 8-station time (aggregate of the
     *  per-station mapping). */
    stationRatio: number;
    /** Pair's Roxzone ÷ singles Roxzone. */
    roxzoneRatio: number;
    /** The solo 8-station total's cumulative percentile in the athlete's
     *  singles work-total table. */
    stationsSinglesPercentile: number;
  };
  /** Provenance of the run pace used in this prediction. */
  runPaceSource: 'user' | 'derived' | 'seed';
  /** Race-time staleness summary, surfaced in the UI for transparency. */
  staleness?: {
    ageMonths: number;
    category: 'fresh' | 'aging' | 'stale' | 'very_stale' | 'unknown';
    physiologyMitigation: number;
  };
  /**
   * Per-station + roxzone "current → projected" markers. Research-grounded
   * trajectory at current training dose. Independent of `buildHyroxProjection`
   * (which projects the AGGREGATE finish from MTL/adherence/taper signals).
   * This field projects each STATION'S test pace on race day.
   */
  projection?: HyroxProjectionMarkers;
}

// ────────────────────────────────────────────────────────────────────────────
// Station benchmark basis: one computation for the forecast, planning and the
// session-best check
// ────────────────────────────────────────────────────────────────────────────

type HyroxConfigOf = NonNullable<SimulatorState['hyroxConfig']>;

/** Per station, the athlete's resolved benchmark as the forecast reads it.
 *  Internal: built by stationInputs. */
interface StationInput {
  station: HyroxStation;
  /** The resolved benchmark as stored in its slot (resolveHyroxBenchmarks);
   *  absent when the station uses the population seed. */
  calibrated?: number;
  slot?: BenchmarkSlot;
  /** One athlete's time at the TARGET's solo loads: a solo value after the
   *  Open/Pro conversion, or a doubles race split converted to the solo time
   *  at the same percentile (in the split's own weight family) and then to the
   *  target's loads. A woman in Mixed Doubles: M-Open, the Women Pro tier. */
  soloAtTarget?: number;
  /** Doubles race split only: the pair's time at the target's weights (the
   *  split as is when its weight family matches the target, else the solo
   *  equivalent mapped back to a pair's time in the target family). */
  teamAtTarget?: number;
  /** The value is a doubles race split (the pair's time). */
  isTeamTime: boolean;
  /** The value reaches the target format through a doubles conversion, so it
   *  caps confidence at medium (H1 decision, option A):
   *   - doubles target: every calibrated value that is not a doubles race
   *     split (singles tests, and the doubles slot's solo tests and session
   *     bests), since the forecast scales each by the station ratio, and a
   *     doubles race split from the other weight family (Open Doubles split
   *     for a Pro Doubles target, or the reverse), which passes through the
   *     solo mapping, the Open/Pro conversion and back;
   *   - singles target: a doubles race split (÷ the ratio). A solo test in
   *     the doubles slot is one athlete's time, used as is, not converted. */
  crossFormat: boolean;
}

interface StationInputs {
  coverage: HyroxCalibrationCoverage;
  isDoubles: boolean;
  isPro: boolean;
  perStation: StationInput[];
  hasTeamTimes: boolean;
  /** The doubles mapping in the target's weight family (pair's division vs
   *  the athlete's own singles field). */
  tables: HyroxDoublesTables;
  /** The athlete's own singles cohort in the target's weight family: seeds,
   *  and the sex the Open/Pro conversion reads. */
  singles: HyroxResultsCohort;
}

/** What converting one stored time to the target needs: the target's
 *  format family, its doubles mapping, the athlete's sex and division, and
 *  the load family of the athlete's solo work at the target's loads. */
interface TargetFrame {
  isDoubles: boolean;
  /** The target is a Pro format (the pair's weight family for doubles). */
  isPro: boolean;
  /** One athlete's solo work at the target's loads is the Pro tier of their
   *  sex (hyroxSoloLoadsArePro): every Pro format, and a woman in Mixed
   *  Doubles (M-Open, the Women Pro tier). The frame stored solo times
   *  convert to. */
  soloPro: boolean;
  tables: HyroxDoublesTables;
  singles: HyroxResultsCohort;
  biologicalSex: SimulatorState['biologicalSex'];
  division: HyroxConfigOf['division'];
}

function targetFrameOf(state: SimulatorState, hx: HyroxConfigOf): TargetFrame {
  return {
    isDoubles: hx.format === 'open_doubles' || hx.format === 'pro_doubles',
    isPro: hx.format === 'pro_singles' || hx.format === 'pro_doubles',
    soloPro: hyroxSoloLoadsArePro(hx.format, state.biologicalSex, hx.division),
    tables: hyroxDoublesTablesForState(state),
    singles: hyroxSinglesCohortForState(state),
    biologicalSex: state.biologicalSex,
    division: hx.division,
  };
}

/** One stored time in the target frame. */
interface ConvertedTime {
  /** One athlete's time at the target's solo loads. */
  soloAtTarget: number;
  /** A doubles race split: the pair's time at the target's weights. */
  teamAtTarget?: number;
  /** A doubles race split from the other weight family (an Open Doubles split
   *  for a Pro Doubles target, or the reverse): it reaches the target's pair
   *  time through the doubles mapping (solo, Open/Pro, back to the pair). */
  teamCrossFamily?: boolean;
}

/**
 * One stored station time at the target: one athlete's time at the target's
 * solo loads (soloAtTarget) and, for a doubles race split, the pair's time at
 * the target's weights (teamAtTarget). A doubles race split converts to the
 * solo time at the same percentile in its own weight family first
 * (doublesStationSoloSec: the athlete's solo loads in that pair, so a Mixed
 * woman's split comes back at M-Open), then to the target's solo loads; the
 * Open/Pro step runs on singles tables (hyroxOpenToProSec /
 * hyroxProToOpenSec, per station and sex, a difference in differences on the
 * Pro and Open results). Erg and bodyweight stations convert at 1. The one
 * conversion the forecast, the planning benchmarks and the history views read.
 *
 * `sourceIsPro` is the stored time's load family (entryIsPro): for a doubles
 * race split, the race's weight family (Pro Doubles or Open Doubles).
 */
function convertToTarget(
  frame: TargetFrame,
  station: HyroxStation,
  sec: number,
  isTeamTime: boolean,
  sourceIsPro: boolean,
): ConvertedTime {
  const sex = frame.singles.sex;
  const toTargetLoads = (solo: number, soloIsPro: boolean): number => {
    if (frame.soloPro && !soloIsPro) return hyroxOpenToProSec(station, solo, sex);   // Open → Pro: slower
    if (!frame.soloPro && soloIsPro) return hyroxProToOpenSec(station, solo, sex);   // Pro → Open: faster
    return solo;                                                                    // identity
  };
  if (!isTeamTime) return { soloAtTarget: toTargetLoads(sec, sourceIsPro) };
  const sameFamily = sourceIsPro === frame.isPro;
  const sourceFormat = sourceIsPro ? 'pro_doubles' : 'open_doubles';
  const sourceTables = sameFamily
    ? frame.tables
    : hyroxDoublesTables(sourceFormat, frame.biologicalSex, frame.division);
  const sourceSoloPro = sameFamily ? frame.soloPro : hyroxSoloLoadsArePro(sourceFormat, frame.biologicalSex, frame.division);
  const soloAtTarget = toTargetLoads(doublesStationSoloSec(station, sec, sourceTables), sourceSoloPro);
  if (sameFamily) return { soloAtTarget, teamAtTarget: sec };
  return { soloAtTarget, teamAtTarget: doublesStationTeamSec(station, soloAtTarget, frame.tables), teamCrossFamily: true };
}

/** The weight family of a stored time, the `sourceIsPro` convertToTarget
 *  reads (for a doubles race split, the pair's family; for a solo time, the
 *  Pro tier of the athlete's sex):
 *   - a race split carries its race's weights and a guided-session best the
 *     weights it was prescribed at (proWeights);
 *   - the athlete's toggle (benchmarksAtProWeights) marks everything else as
 *     Pro when on (kept when the target later changes);
 *   - a race split with no weight record (the boot migration's 'manual'
 *     seed), or a slot value with no entry, is Open (the toggle's own
 *     convention, unchanged from before lane H3b);
 *   - a station test logged under a Pro format was at Open weights (the
 *     toggle's convention), and one logged under an Open format at that
 *     format's solo loads (hyroxSoloLoadsArePro on the entry's format): the
 *     Open tier, except a woman in Mixed Doubles, whose tests are at the
 *     pair's M-Open loads, the Women Pro tier (the test protocol shows the
 *     target's tier, and the toggle is not offered there). A test she logged
 *     earlier under Open Singles stays at W-Open. */
function entryIsPro(
  hx: HyroxConfigOf,
  frame: Pick<TargetFrame, 'biologicalSex' | 'division'>,
  entry: Pick<StationTestEntry, 'source' | 'proWeights' | 'format'> | null | undefined,
): boolean {
  if ((entry?.source === 'race' || entry?.source === 'session') && entry.proWeights != null) return entry.proWeights;
  if (hx.benchmarksAtProWeights) return true;
  if (!entry || isRaceSplitSource(entry.source)) return false;
  return !isHyroxProFormat(entry.format) && hyroxSoloLoadsArePro(entry.format, frame.biologicalSex, frame.division);
}

/**
 * Per station, the resolved benchmark at target weights and how it reaches the
 * target format. Reads hyroxCalibrationCoverage (the per-station resolver every
 * calibrated-count surface reads).
 *
 * Weight regime per station, from the history entry that describes the slot
 * value (benchmarkEntryForSlotValue): a race split carries its race's weights
 * (proWeights); a guided-session best carries the weights the session was
 * prescribed at (proWeights: the target's solo loads were the Pro tier of the
 * athlete's sex, since the generators load stations at the target's tier,
 * hyroxLoadTierForState); a station test, or a value with no entry, follows
 * entryIsPro (the athlete's toggle, else the target's solo loads).
 * Conversion: convertToTarget. The Open/Pro step replaced
 * HYROX_PRO_STATION_MULTIPLIER (unsourced, one set for both sexes) in lane H3b.
 * Erg and bodyweight stations convert at 1. A doubles race split converts to
 * one athlete's time in its own weight family first (doublesStationSoloSec,
 * per station), then to the target's loads, so the Pro/Open conversion always
 * runs on singles tables.
 */
function stationInputs(state: SimulatorState, hx: HyroxConfigOf): StationInputs {
  const frame = targetFrameOf(state, hx);
  const { isDoubles, isPro, tables, singles } = frame;
  const coverage = hyroxCalibrationCoverage(hx);
  const perStation = HYROX_STATION_ORDER.map((station): StationInput => {
    const calibrated = coverage.benchmarks[station];
    const slot = coverage.slotOf[station];
    const entry = calibrated != null && slot
      ? benchmarkEntryForSlotValue(hx, station, slot, calibrated)
      : null;
    const isTeamTime = slot === 'doubles' && calibrated != null
      && doublesBenchmarkIsTeamTime(hx, station, calibrated);
    const converted = calibrated != null
      ? convertToTarget(frame, station, calibrated, isTeamTime, entryIsPro(hx, frame, entry))
      : null;
    // Option A: a value that reaches the target's terms through the doubles
    // mapping caps confidence at medium. Doubles target: every solo value,
    // and a doubles race split from the other weight family (Open Doubles
    // split for a Pro Doubles target, or the reverse). Singles target: every
    // doubles race split.
    const crossFormat = calibrated != null && (isDoubles ? (!isTeamTime || !!converted?.teamCrossFamily) : isTeamTime);
    return {
      station, calibrated, slot,
      soloAtTarget: converted?.soloAtTarget,
      teamAtTarget: converted?.teamAtTarget,
      isTeamTime, crossFormat,
    };
  });
  return { coverage, isDoubles, isPro, perStation, hasTeamTimes: perStation.some(p => p.isTeamTime), tables, singles };
}

/** One history entry in the target frame (hyroxStationHistoryInTargetFrame). */
export interface HyroxStationHistoryPoint extends StationTestEntry {
  /** One athlete's time at the target's solo loads: convertToTarget, the
   *  conversion the forecast applies to the same stored time. The solo frame
   *  (station detail history, sparkline, Best and Latest). */
  displaySec: number;
  /** displaySec differs from the stored time (a doubles race split, or a
   *  time at the other weight regime). */
  converted: boolean;
  /** The same time in the forecast line's own terms: the pair's time for a
   *  doubles target (a doubles race split at the target's weights as is, any
   *  other time mapped per station with the forecast's own ratio,
   *  doublesStationTeamSec), displaySec for a singles target. The frame of a
   *  view whose rows are forecast lines (chip detail "Per-station
   *  breakdown"), so a PR never reads slower than its own row. */
  targetSec: number;
  /** targetSec differs from the stored time. */
  targetConverted: boolean;
}

/**
 * A station's whole history (every format) in one frame, with the forecast's
 * own conversion:
 *  - displaySec, one athlete's time at the target's loads. Doubles race
 *    splits convert to their solo equivalent and times at the other weight
 *    regime to the target's. The solo frame of decision 10 (lane H3b).
 *  - targetSec, the forecast line's own terms (the pair's time for a doubles
 *    target), for views whose rows show the forecast's lines.
 * Either way a view never mixes the pair's times with solo times or Pro
 * weights with Open (H1 review, 2026-10-13). Oldest first.
 */
export function hyroxStationHistoryInTargetFrame(state: SimulatorState, station: HyroxStation): HyroxStationHistoryPoint[] {
  const hx = state.hyroxConfig;
  if (!hx) return [];
  const frame = targetFrameOf(state, hx);
  return getStationHistory(state, station).map(e => {
    const isTeamTime = (e.format === 'open_doubles' || e.format === 'pro_doubles') && isRaceSplitSource(e.source);
    const { soloAtTarget, teamAtTarget } = convertToTarget(frame, station, e.sec, isTeamTime, entryIsPro(hx, frame, e));
    const targetSec = !frame.isDoubles
      ? soloAtTarget
      : teamAtTarget ?? doublesStationTeamSec(station, soloAtTarget, frame.tables);
    return {
      ...e,
      displaySec: soloAtTarget,
      converted: Math.abs(soloAtTarget - e.sec) >= 0.5,
      targetSec,
      targetConverted: Math.abs(targetSec - e.sec) >= 0.5,
    };
  });
}

/**
 * The once-per-view label for hyroxStationHistoryInTargetFrame.
 *  - 'solo' (default): displaySec, one athlete at the target's loads.
 *  - 'line': targetSec, the forecast line's terms (the pair's time for a
 *    doubles target; the same as 'solo' for singles).
 * "Your race's weights" rather than a division name: a woman in Mixed Doubles
 * trains at the pair's M-Open loads, the Women Pro tier, so "Open weights"
 * would mislead her.
 */
export function hyroxTargetFrameCaption(state: SimulatorState, frame: 'solo' | 'line' = 'solo'): string {
  const doubles = state.hyroxConfig?.format === 'open_doubles' || state.hyroxConfig?.format === 'pro_doubles';
  if (frame === 'line' && doubles) {
    return "Times show the pair at your race's weights. Solo tests and times at other weights are converted with the forecast's ratios.";
  }
  return "Times show one athlete at your race's weights. Doubles race splits and times at other weights are converted with the forecast's ratios.";
}

interface SeedBasis {
  stale: ReturnType<typeof computeHyroxStaleness>;
  /** Band seeds per station, blended toward the VDOT band when the race is
   *  stale. One athlete's times at the TARGET weights (hyroxStationSeedsAtTarget). */
  effectiveSeeds: Record<HyroxStation, number>;
  effectiveSeedRoxzone: number;
}

/**
 * Race-time staleness and the effective band seeds.
 *
 * When the user's last Hyrox race is old, we don't fully trust the band that
 * race implied or the per-station splits derived from it. `bandWeight` and
 * `splitsWeight` (computed in hyrox-staleness.ts) are physiology-mitigated
 * decay factors in [0,1]. Strong current VDOT/MTL/Strava CTL pulls them back
 * toward 1.0. An athlete who clearly held fitness escapes the penalty.
 * Splits weight decays slower than band weight because skill components
 * (sled push, sandbag carry, wall ball cadence) persist longer than VO2max.
 *
 * Effective seeds: when band is stale AND current VDOT implies a different
 * band, blend the stored-band seeds toward the VDOT-implied band's seeds
 * using bandWeight. A 24-month-old race that put the athlete in 'novice'
 * but a current VDOT of 53 should weight toward 'advanced' seeds.
 *
 * Seeds are the real band medians of the field the band was read in
 * (hyroxSeedField), at the target's weights (hyroxStationSeedsAtTarget: a
 * Pro target with an Open-raced band gets the Open medians converted to Pro
 * weights per station from the Pro and Open results).
 */
function seedBasis(state: SimulatorState, hx: HyroxConfigOf): SeedBasis {
  const band = hx.athleteBand;
  const seeds = hyroxStationSeedsAtTarget(state, band);
  const seedRoxzone = hyroxSeedRoxzoneSec(state, band);
  const stale = computeHyroxStaleness(state);
  const vdotBand = bandFromVdot(state.v);
  const useBandBlend = stale.bandWeight < 1 && vdotBand != null && vdotBand !== band;
  const vdotSeeds = useBandBlend ? hyroxStationSeedsAtTarget(state, vdotBand!) : seeds;
  const effectiveSeeds = useBandBlend
    ? (Object.fromEntries(
        HYROX_STATION_ORDER.map(st => [
          st,
          stale.bandWeight * seeds[st] + (1 - stale.bandWeight) * vdotSeeds[st],
        ]),
      ) as Record<HyroxStation, number>)
    : seeds;
  const effectiveSeedRoxzone = useBandBlend
    ? stale.bandWeight * seedRoxzone +
      (1 - stale.bandWeight) * hyroxSeedRoxzoneSec(state, vdotBand!)
    : seedRoxzone;
  return { stale, effectiveSeeds, effectiveSeedRoxzone };
}

/** Seed time for a station at TARGET weights (seeds are read at them). */
function seedAtTarget(sb: SeedBasis, p: StationInput): number {
  return sb.effectiveSeeds[p.station];
}

/** One station of the forecast before venue factors. */
interface StationBase {
  /** In the target format's terms: the pair's time for doubles. */
  baseSec: number;
  /** One athlete's time at the target's weights (the solo equivalent of a
   *  doubles line). */
  singlesSec: number;
}

/**
 * One station's pre-venue time, with the staleness blend toward the seed.
 * Doubles target: a doubles race split as the pair's time, blended with the
 * seed mapped to a pair's time; a solo value or the seed mapped per station
 * (doublesStationTeamSec at its own percentile). Singles target: a doubles
 * race split's solo equivalent, blended with the seed.
 */
function stationBase(inputs: StationInputs, sb: SeedBasis, p: StationInput): StationBase {
  const seed = seedAtTarget(sb, p);
  const w = sb.stale.splitsWeight;
  const singlesSec = p.soloAtTarget != null ? w * p.soloAtTarget + (1 - w) * seed : seed;
  if (!inputs.isDoubles) return { baseSec: singlesSec, singlesSec };
  if (p.isTeamTime && p.teamAtTarget != null) {
    const baseSec = w * p.teamAtTarget + (1 - w) * doublesStationTeamSec(p.station, seed, inputs.tables);
    return { baseSec, singlesSec };
  }
  return { baseSec: doublesStationTeamSec(p.station, singlesSec, inputs.tables), singlesSec };
}

/** One station's benchmark as planning and the session-best check read it
 *  (resolveHyroxStationBenchmarks). */
export interface HyroxStationBenchmark {
  station: HyroxStation;
  /** The benchmark as one athlete's time over the full station distance, at
   *  the target's weights, for every target format. It is the forecast's own
   *  per-station value (StationInput.soloAtTarget, after the per-entry
   *  Open/Pro conversion): a doubles race split (the pair's time) converted
   *  to the solo time at the same percentile of the station's results
   *  (doublesStationSoloSec), anything else as is (singles times, and the
   *  doubles slot's solo tests and session bests). These are the terms of a
   *  station session at the target's load tier (one athlete covers the full
   *  distance) and of a guided session's best round, so the Stats Benchmarks
   *  ledger, the session generators' targets and the session-best check all
   *  read this one number. A doubles target's forecast maps it into the
   *  pair's time per station. Before the forecast's staleness blend and venue
   *  factors. Absent when the station uses the population seed.
   *
   *  History (review 2026-10-13):
   *   - a doubles target's race split was kept as the pair's time here while
   *     its solo tests, the seeds and session bests were one athlete's time.
   *     Plans prescribed the pair's time as a solo target (about 30% too
   *     fast), and a solo session best that beat the split's solo equivalent
   *     moved the Stats row and the next plan's target slower;
   *   - the value was read at the weights it was stored at. An Open target
   *     with a Pro race split prescribed the Pro time at Open loads (about
   *     15% slow on the sleds), and a slower Open round replaced the split's
   *     faster Open equivalent in the forecast. */
  sec?: number;
  /** The slot the value came from (absent for the legacy pooled field). */
  slot?: BenchmarkSlot;
  /** The stored value is a doubles race split (the pair's time); `sec` is its
   *  solo equivalent. */
  teamTimeSplit: boolean;
  /** The value is converted from the other format's benchmark (StationInput). */
  crossFormat: boolean;
}

export interface HyroxResolvedStationBenchmarks {
  /** All 8 stations, in race order. */
  stations: HyroxStationBenchmark[];
  /** Aggregate pair ÷ solo ratio over the stations whose value is a doubles
   *  race split; 1 when none is. Kept for H1 callers: each split converts
   *  with its own station's ratio (stationRatios). */
  stationRatio: number;
  /** Per station holding a doubles race split: the pair's time ÷ its solo
   *  equivalent at the target's weights. */
  stationRatios: Partial<Record<HyroxStation, number>>;
  coverage: HyroxCalibrationCoverage;
}

/**
 * Per station, the athlete's benchmark from the forecast's own computation
 * (the per-station resolver, the per-entry Open/Pro conversion, then the
 * same per-station doubles mapping predictHyroxRace applies). One source for
 * the Stats Benchmarks ledger, the plan engine and add-session generator
 * targets, and the guided-session PB check, so a converted race split reads
 * the same everywhere, in one athlete's terms at the target's weights for
 * every format, and a slower training round never overwrites it.
 */
export function resolveHyroxStationBenchmarks(state: SimulatorState): HyroxResolvedStationBenchmarks | null {
  const hx = state.hyroxConfig;
  if (!hx) return null;
  const inputs = stationInputs(state, hx);
  let teamSum = 0;
  let soloSum = 0;
  const stationRatios: Partial<Record<HyroxStation, number>> = {};
  const stations = inputs.perStation.map((p): HyroxStationBenchmark => {
    if (p.calibrated == null || p.soloAtTarget == null) {
      return { station: p.station, teamTimeSplit: false, crossFormat: false };
    }
    if (p.isTeamTime && p.teamAtTarget != null) {
      stationRatios[p.station] = p.teamAtTarget / p.soloAtTarget;
      teamSum += p.teamAtTarget;
      soloSum += p.soloAtTarget;
    }
    return {
      station: p.station,
      sec: p.soloAtTarget,
      ...(p.slot ? { slot: p.slot } : {}),
      teamTimeSplit: p.isTeamTime,
      crossFormat: p.crossFormat,
    };
  });
  return { stations, stationRatio: soloSum > 0 ? teamSum / soloSum : 1, stationRatios, coverage: inputs.coverage };
}

/** The athlete's calibrated station benchmarks only: resolveHyroxStationBenchmarks'
 *  `sec` per calibrated station (one athlete over the full station distance,
 *  at the target's weights, in every format), to the whole second the Stats
 *  ledger shows (a converted split is fractional, a round is timed to the
 *  whole second). Stations on the seed are absent. The benchmark a guided
 *  session's best round must beat (hyrox-session-benchmarks.ts). */
export function hyroxCalibratedStationBenchmarks(state: SimulatorState): Partial<Record<HyroxStation, number>> {
  const out: Partial<Record<HyroxStation, number>> = {};
  for (const b of resolveHyroxStationBenchmarks(state)?.stations ?? []) {
    if (b.sec != null) out[b.station] = Math.round(b.sec);
  }
  return out;
}

/** Station target times for the session generators (plan engine, add-session
 *  modal): every station, the calibrated benchmark where there is one
 *  (hyroxCalibratedStationBenchmarks) and the band seed at the target's
 *  weights for the rest (hyroxStationSeedsAtTarget, to the whole second),
 *  the numbers the Stats ledger shows. Lane H3b: the seeds used to come from
 *  the generators' own Open, sexes-pooled STATION_SEED_TIMES_SEC fallback,
 *  so a Pro or a women's target was prescribed Open pooled times for an
 *  untested station while Stats and the forecast showed its own field's. */
export function hyroxPlanningStationBenchmarks(state: SimulatorState): Partial<Record<HyroxStation, number>> {
  const calibrated = hyroxCalibratedStationBenchmarks(state);
  if (!state.hyroxConfig) return calibrated;
  const seeds = hyroxStationSeedsAtTarget(state);
  const out: Partial<Record<HyroxStation, number>> = {};
  for (const st of HYROX_STATION_ORDER) out[st] = calibrated[st] ?? Math.round(seeds[st]);
  return out;
}

/**
 * The band seed per station at the target's weights (hyroxStationSeedsAtTarget:
 * the real band medians of the field the band was read in, converted to the
 * target's weights), before the forecast's staleness blend: the seed the
 * Stats ledger, the station detail page, the benchmark card and the forecast
 * read for an untested station. One athlete's time; a doubles forecast maps
 * it into the pair's time. `band` defaults to the athlete's band.
 */
export function hyroxStationSeedsForState(state: SimulatorState, band?: AbilityBand): Record<HyroxStation, number> {
  return hyroxStationSeedsAtTarget(state, band);
}

export function predictHyroxRace(state: SimulatorState): HyroxPrediction | null {
  const hx = state.hyroxConfig;
  if (!hx) return null;

  const band = hx.athleteBand;

  // Run pace: VDOT-derived when physiology is available, then user-set
  // override (yields to a meaningfully-faster derived value), then seed fallback.
  const { paceSecKm: runPaceSecKm, source: runPaceSource } = deriveHyroxRunPace(state);

  // ── Format-aware benchmark resolution ────────────────────────────────────
  // stationInputs reads hyroxCalibrationCoverage (resolveHyroxBenchmarks,
  // hyrox-station-history.ts), shared with every surface that counts
  // calibrated stations. It resolves PER STATION: the target's slot when it
  // holds that station, else the other format's slot, else (both slots empty)
  // the legacy pooled field.
  // - Doubles target, a station from the singles slot: singles station time ×
  //   the percentile-matched doubles ratio (hyrox-doubles.ts).
  // - Singles target, a station from the doubles slot: the inverse through the
  //   same mapping. A doubles race split is the pair's time and is divided by
  //   the station ratio; a solo test or session best in the doubles slot is
  //   already one athlete's time and is used as is.
  // Per station the doubles slot holds either the pair's time or a solo time
  // (doublesBenchmarkIsTeamTime).
  // Every format covers all 8 stations. Doubles partners enter every station
  // together and split the work inside it (26/27 Doubles rulebook s7.2); the
  // old model gave each partner 4 whole stations at singles time.
  const inputs = stationInputs(state, hx);
  const { isDoubles, perStation } = inputs;

  // ── Run-leg fatigue model ─────────────────────────────────────────────────
  // Each completed station adds eccentric + metabolic fatigue that slows
  // subsequent run legs. From HyroxDataLab finishing-time distributions:
  // - Run 1 (no stations yet): ~2–5% faster than average pace
  // - Runs 2–6: gradual progression from fast → average
  // - Runs 7–8: heaviest fatigue; magnitude scales with ability band
  // Rate is band-scaled (PER_STATION_FATIGUE_RATE_BY_BAND in hyrox-constants.ts):
  // elite/competitive: ~0.4%/station (hold pace); beginner: ~1.1%/station.
  // Doubles uses the same rate: the old 0.5 doubles factor had no source and
  // assumed alternate whole stations. The rate only shapes the per-leg split;
  // legs are normalised below so the run total comes from the run pace (for
  // doubles, the percentile-matched run ratio in deriveHyroxRunPace).
  const PER_STATION_FATIGUE_RATE = PER_STATION_FATIGUE_RATE_BY_BAND[band] ?? 0.007;

  function runLegFatigueMultiplier(legIndex: number): number {
    // legIndex 0 = first run (before any stations), 7 = last run (after 7 stations)
    return 1 + legIndex * PER_STATION_FATIGUE_RATE;
  }

  // Compute raw legs then normalise so the total equals 8 × base pace (energy conservation).
  const rawLegMultipliers = Array.from({ length: 8 }, (_, i) => runLegFatigueMultiplier(i));
  const avgMult = rawLegMultipliers.reduce((s, m) => s + m, 0) / 8;
  const normLegMultipliers = rawLegMultipliers.map(m => m / avgMult);

  // ── Race-time staleness and effective seeds (seedBasis) ──────────────────
  const sb = seedBasis(state, hx);
  const { stale, effectiveSeedRoxzone } = sb;

  // ── Raw baseline (pre-venue) ──────────────────────────────────────────────
  // Seeds and calibrated values are both one athlete's times at the TARGET
  // weights before the staleness blend (stationInputs converts each
  // calibrated value per entry; seeds are read at the target's weights), so
  // the blend never mixes weight regimes.
  const rawRunSec = runPaceSecKm * 8;

  // Per station (stationBase): singles target, one athlete's time; doubles
  // target, the pair's time, each station mapped at its own percentile in the
  // station's results (doublesStationTeamSec). The line keeps its solo
  // equivalent so teamRatio is that station's own pair ÷ solo ratio.
  let teamSum = 0;
  let soloSum = 0;
  // The solo total in the singles field's own terms, for its work-total
  // percentile (a Mixed woman's M-Open solo times convert to W-Open first).
  const soloFrame = hyroxSoloFrameForState(state);
  let fieldSoloSum = 0;
  const stationLines: HyroxStationLine[] = perStation.map(p => {
    const { baseSec, singlesSec } = stationBase(inputs, sb, p);
    if (isDoubles) {
      teamSum += baseSec;
      soloSum += singlesSec;
      fieldSoloSum += hyroxSoloToFieldSec(p.station, singlesSec, soloFrame);
    }
    return {
      station: p.station,
      baseSec,
      adjustedSec: baseSec, // mutated below for venue factors
      source: p.calibrated != null ? ('calibrated' as const) : ('seed' as const),
      ...(isDoubles ? { teamRatio: baseSec / singlesSec } : {}),
      ...(p.isTeamTime ? { teamTimeSplit: true } : {}),
      ...(p.crossFormat ? { crossFormat: true } : {}),
    };
  });
  // Aggregate pair ÷ solo station ratio (doubles), and its singles-side
  // percentile in the work-total table, for the summary and the Stats CP card.
  const stationRatio = isDoubles && soloSum > 0 ? teamSum / soloSum : 1;
  const stationsSinglesPercentile = isDoubles
    ? doublesRatioAt('stations', fieldSoloSum, inputs.tables).singlesPercentile
    : undefined;
  // Singles target reading doubles race splits: the pair ÷ solo ratio over
  // the converted stations (crossFormatStationRatio).
  const teamSplitInputs = perStation.filter(p => p.isTeamTime && p.teamAtTarget != null && p.soloAtTarget != null);
  const singlesTargetSplitRatio = !isDoubles && teamSplitInputs.length > 0
    ? teamSplitInputs.reduce((a, p) => a + p.teamAtTarget!, 0) / teamSplitInputs.reduce((a, p) => a + p.soloAtTarget!, 0)
    : 1;
  const rawStationsSec = stationLines.reduce((sum, l) => sum + l.baseSec, 0);
  // Doubles Roxzone: partners pass through all 8 transitions together, so it
  // is not halved; the percentile-matched Roxzone ratio applies.
  const roxzoneRatio = isDoubles ? doublesRatioAt('roxzone', effectiveSeedRoxzone, inputs.tables).ratio : 1;
  const roxzoneSeed = isDoubles
    ? Math.round(effectiveSeedRoxzone * roxzoneRatio)
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
    // Reuse run-altitude curve for endurance-station altitude effect. The
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
  // the UI shows what was actually modelled at this race. Users can see "Lap:
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

  // A forecast that converted the other format's benchmarks says so (UI note
  // and banner).
  const hasCrossFormat = perStation.some(p => p.crossFormat);
  const crossFormatConversion: HyroxPrediction['crossFormatConversion'] = !hasCrossFormat
    ? undefined
    : isDoubles ? 'singles_to_doubles' : 'doubles_to_singles';

  // ── Confidence scoring ────────────────────────────────────────────────────
  // The calibrated count is hyroxCalibrationCoverage's, the count Stats,
  // Account, the benchmark card and the chip detail show (stations with an
  // athlete time, of all 8 raced stations).
  // A station converted from the other format's benchmark counts as
  // calibrated (it is the athlete's own time) but caps confidence at medium
  // in either direction (H1 decision, option A): it passes through that
  // station's own percentile-matched doubles ratio (hyrox-doubles.ts), a
  // cross-format estimate rather than a time in this format. For a doubles
  // target that is every solo value and every doubles split from the other
  // weight family; only the target family's own doubles race splits reach
  // high. For a singles target it is every doubles race split.
  // Race-age staleness can also cap confidence (medium/low) when the previous
  // race is older than 6 months and current physiology can't fully mitigate.
  const calibratedCount = inputs.coverage.calibrated.length;
  let confidence: HyroxPrediction['confidence'] =
    calibratedCount >= 6 && hx.venueId ? 'high' :
    calibratedCount >= 3 ? 'medium' :
    'low';
  const crossFormatLowered = hasCrossFormat && confidence === 'high';
  if (crossFormatLowered) confidence = 'medium';
  if (stale.confidenceCap === 'low') confidence = 'low';
  else if (stale.confidenceCap === 'medium' && confidence === 'high') confidence = 'medium';
  // The copy names the cap only when it is what holds the forecast at medium
  // (a staleness cap to low overrides it).
  const crossFormatCapped = crossFormatLowered && confidence === 'medium';

  // ── Per-station "current → projected" trajectory ──────────────────────────
  // Independent from `buildHyroxProjection`. That one projects the AGGREGATE
  // finish from MTL / adherence / taper / readiness signals. This one
  // projects EACH station's test pace from the per-class horizon model
  // (research-grounded gain rates calibrated to weeks remaining + planned
  // Hyrox sessions/wk).
  // - Anchor `currentSec` to the same `baseSec` shown elsewhere (lesson from
  //   the triathlon LT-pace bug: two surfaces showing different "current"
  //   values for the same metric).
  // - No venue factors here. Projection is "test pace today → test pace
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
    crossFormatStationRatio: crossFormatConversion ? (isDoubles ? stationRatio : singlesTargetSplitRatio) : undefined,
    ...(crossFormatCapped ? { crossFormatCapped: true } : {}),
    doubles: isDoubles
      ? { stationRatio, roxzoneRatio, stationsSinglesPercentile: stationsSinglesPercentile ?? 0 }
      : undefined,
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

  // Stations the plan programmes: without the equipment (no sled track, no
  // SkiErg / RowErg) the generators never schedule the station, so it banks
  // no training gain (audit 2026-10-12: it used to project full gains).
  const access = state.hyroxConfig?.stationAccess;
  const programmed = access ? new Set(availableStations(access)) : null;
  const stationProjections: HyroxStationProjection[] = stationLines.map(line => {
    // Injury debit: a station only banks build time for the weeks its loaded
    // region(s) can train. Blocked region → 0 build weeks → no projected gain.
    // Unchanged when there is no active injury (returns full weeksRemaining).
    const stationWeeks = programmed && !programmed.has(line.station)
      ? 0
      : stationInjuryBuildWeeks(state.injuryState, line.station, weeksRemaining);
    const result = applyHyroxStationHorizon(line.station, {
      ...horizonInput,
      weeks_remaining: stationWeeks,
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

/**
 * Weeks of training until the Hyrox race: to the end of race week
 * (raceForecastHorizonISO; the Sunday before race day when a Monday to
 * Wednesday race has a closing week). Returns 0 if no race or already past.
 */
function computeWeeksRemainingForHorizon(state: SimulatorState): number {
  const raceDate = state.hyroxConfig?.raceDate ?? state.onboarding?.customRaceDate;
  if (!raceDate) return 0;
  const today = new Date();
  const race = new Date(raceForecastHorizonISO(state, raceDate));
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
