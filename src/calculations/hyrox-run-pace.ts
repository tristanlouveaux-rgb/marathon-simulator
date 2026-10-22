/**
 * HYROX run-pace derivation, v2. Critical Pace (CP) anchored.
 *
 * **Scientific anchor**: Critical Pace, not Lactate Threshold.
 * - Hill (1923) original power-duration construct; Monod & Scherrer (1965)
 *   human application; Jones et al. (2010) modern review.
 * - For trained runners CP ≈ 95–97% of LT pace (Galbraith et al. 2014,
 *   MLSS vs CP comparison).
 * - HYROX runs are 8 × 1km efforts at ~3–7 min intervals. CP-zone
 *   physiology, NOT continuous threshold. Stations act as metabolic recovery
 *   for the running musculature even when they elevate HR.
 *
 * **Implication**: trained HYROXers can pace 1km legs AT or FASTER than
 * their threshold pace. The previous model assumed every HYROXer runs
 * slower than threshold (ratio ≥ 1.05). Wrong for the top ~20% of
 * athletes. The new ratios descend below 1.0 for trained tiers.
 *
 * **Formula**:
 *
 *   pace = gp(vdot, ltPace).t × cpRatio(vdot) × formatFactor(targetFormat)
 *        + personalOffsetSec
 *
 * - `cpRatio(vdot)`: continuous linear interp between band anchor points
 *   (no more discrete buckets).
 * - `formatFactor`: 1.0 for singles. Doubles: the percentile-matched
 *   doubles/singles run ratio from the ingested results (hyrox-doubles.ts),
 *   read at the athlete's singles run total. Partners run every leg together
 *   and the finish is the later chip (26/27 Doubles rulebook s4.3, s7.3), so
 *   the pair runs at about the slower partner's pace. At P50 the ratio is
 *   1.01 to 1.06 in the same-sex divisions (Open and Pro); a Mixed pair reads
 *   0.98 against women's singles and 1.09 against men's.
 * - `personalOffsetSec`: Bayesian update from logged-race observations.
 *   Decays to zero over 12 months without new evidence. See
 *   `hyrox-personal-pace.ts`.
 *
 * Mirrors the CLAUDE.md "Manually-set Benchmarks Yield to Improvements"
 * rule: a user-entered HYROX run pace is preserved unless the derived
 * value is faster by ≥ 5 s/km.
 *
 * Citation chain in `docs/SCIENCE_LOG.md §X`.
 */

import type { SimulatorState } from '@/types/state';
import type { AbilityBand, HyroxStation } from '@/types/triathlon';
import { gp } from './paces';
import { SEED_RUN_PACE_SEC_KM, HYROX_RUN_PACE_MIN_SEC_KM, HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { doublesRatioAt, seedRoxzoneSecForFormat, hyroxDoublesTables, hyroxDoublesTablesForState, type HyroxDoublesTables } from './hyrox-doubles';
import { hyroxSeedRunPaceSecKm } from './hyrox-results';
import { resolveHyroxAthleteSex } from './hyrox-division';
import { hasRealRunningFitnessSignal } from './physiological-vdot';
import {
  computePersonalRunPaceOffset,
  blendPersonalRunPaceOffset,
  backComputeRunPaceFromRace,
  estimateStationsAndRoxzoneFromBand,
  type HyroxRaceObservation,
} from './hyrox-personal-pace';

/**
 * Continuous CP-anchored fatigue ratio anchor points, keyed by VDOT.
 *
 * Each anchor pairs (band-implied VDOT, ratio of HYROX run pace to LT pace).
 * Ratios < 1.0 are scientifically legitimate for trained tiers: CP sits
 * between 5k pace and threshold pace, and HYROX's interval-with-recovery
 * structure lets trained athletes pace at or near CP rather than threshold.
 *
 * | Tier            | VDOT | Ratio | Interpretation                          |
 * |-----------------|------|-------|-----------------------------------------|
 * | total_beginner  |  28  | 1.32  | Aerobic ceiling caps everything         |
 * | beginner        |  32  | 1.22  | Notably slower than threshold           |
 * | novice          |  38  | 1.12  | Limited HYROX-specific conditioning     |
 * | intermediate    |  45  | 1.05  | Just slower than threshold              |
 * | advanced        |  53  | 1.00  | At threshold (≈ CP for this tier)       |
 * | competitive     |  60  | 0.96  | Faster than threshold (CP near 5k-10k)  |
 *
 * Cross-referenced against elite HYROX splits:
 *  - Top male singles (~57min): runs ~4:10/km vs probable threshold ~3:45 → 0.93
 *  - Advanced (~1:00 singles): runs ~4:30/km vs threshold ~4:15 → 1.06
 *  - Intermediate (~1:30 singles): runs ~5:30/km vs threshold ~5:00 → 1.10
 */
export const CP_RATIO_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [28, 1.32],
  [32, 1.22],
  [38, 1.12],
  [45, 1.05],
  [53, 1.00],
  [60, 0.96],
] as const;

/** Linear interpolation between anchor points; clamps outside range. */
export function cpRatioForVdot(vdot: number): number {
  if (!Number.isFinite(vdot)) return 1.15; // safe fallback at intermediate
  if (vdot <= CP_RATIO_ANCHORS[0][0]) return CP_RATIO_ANCHORS[0][1];
  if (vdot >= CP_RATIO_ANCHORS[CP_RATIO_ANCHORS.length - 1][0])
    return CP_RATIO_ANCHORS[CP_RATIO_ANCHORS.length - 1][1];
  for (let i = 0; i < CP_RATIO_ANCHORS.length - 1; i++) {
    const [v0, r0] = CP_RATIO_ANCHORS[i];
    const [v1, r1] = CP_RATIO_ANCHORS[i + 1];
    if (vdot >= v0 && vdot <= v1) {
      const t = (vdot - v0) / (v1 - v0);
      return r0 + t * (r1 - r0);
    }
  }
  return 1.0; // unreachable
}

/**
 * Doubles run-pace factor: the percentile-matched doubles/singles run ratio
 * (hyrox-doubles.ts) at the athlete's singles run total (8 × singles pace),
 * on the athlete's doubles tables when given (the pair's division against
 * the athlete's own singles field; default Open, pooled). Replaces the
 * gut-anchored DOUBLES_TO_SINGLES_PACE_FACTOR (1.05 to 1.10, i.e. doubles 5
 * to 9% faster), which assumed partner rest from alternate whole stations.
 * The results show the opposite: the pair runs at about the slower
 * partner's pace. Median run ratio (S8-S9): 1.01 to 1.06 in the same-sex
 * divisions, Open and Pro; a Mixed pair 0.98 against women's singles and
 * 1.09 against men's.
 */
export function doublesRunPaceFactor(singlesPaceSecKm: number, tables?: HyroxDoublesTables): number {
  return doublesRatioAt('run', singlesPaceSecKm * 8, tables).ratio;
}

export type HyroxRunPaceSource = 'user' | 'derived' | 'seed';

/** Where the returned pace came from (captions). 'race': the band seed
 *  adjusted by the personal offset from the athlete's last HYROX race, for a
 *  runner with no real running-fitness signal (E5, 2026-10-22). */
export type HyroxRunPaceProvenance = HyroxRunPaceSource | 'race';

/**
 * The run-pace base a personal race offset was fitted against: 'vdot', the
 * CP model at the athlete's VDOT (derivePopulationRunPace), for a measured
 * runner; 'seed', the band seed pace, for a runner with no real
 * running-fitness signal (D5). The offset is a residual on its base, so it
 * applies only on that base, and refreshHyroxPersonalRunPaceOffset refits it
 * when the base in use changes (the first real running signal arrives, or it
 * lapses). Stored on hyroxConfig as `personalRunPaceOffsetBase`; undefined on
 * offsets written before 2026-10-22 (initialization.hyrox.ts still writes
 * none), read as 'vdot' and refitted at the next launch.
 */
export type HyroxRunPaceOffsetBase = 'vdot' | 'seed';

type HyroxConfigWithOffsetBase = NonNullable<SimulatorState['hyroxConfig']> & { personalRunPaceOffsetBase?: HyroxRunPaceOffsetBase };

/** The base the stored personal offset was fitted against (undefined: 'vdot'). */
export function hyroxRunPaceOffsetBase(hx: SimulatorState['hyroxConfig']): HyroxRunPaceOffsetBase {
  return (hx as HyroxConfigWithOffsetBase | undefined)?.personalRunPaceOffsetBase ?? 'vdot';
}

/** The run base in use: the CP model at the VDOT when the runner is measured
 *  (hasRealRunningFitnessSignal), else the band seed (D5). */
function hyroxRunVdotIsMeasured(state: SimulatorState): boolean {
  try { return hasRealRunningFitnessSignal(state); } catch { return false; }
}

/**
 * The band seed run pace in a target format: the singles seed (the band's
 * median run total / 8 in the athlete's seed field, hyroxSeedRunPaceSecKm),
 * and for doubles x the percentile-matched doubles run ratio on `tables`
 * (default: the athlete's own doubles tables). The one seed the forecast's run
 * pace and the personal offset fit read.
 */
export function hyroxSeedRunPaceForFormat(
  state: SimulatorState,
  band: AbilityBand,
  targetFormat: 'singles' | 'doubles',
  tables?: HyroxDoublesTables,
): number {
  const singlesSeed = hyroxSeedRunPaceSecKm(state, band);
  return targetFormat === 'doubles'
    ? Math.round(singlesSeed * doublesRunPaceFactor(singlesSeed, tables ?? hyroxDoublesTablesForState(state)))
    : singlesSeed;
}

export interface HyroxRunPaceComponents {
  /** Daniels threshold pace at user's VDOT (with LT refinement). */
  thresholdSecKm: number;
  /** CP-anchored ratio for user's VDOT (continuous interp). */
  cpRatio: number;
  /** Format adjustment applied: 1.0 for singles; for doubles the
   *  percentile-matched run ratio (doublesRunPaceFactor; 0.98 to 1.09 at
   *  P50 across divisions). */
  formatFactor: number;
  /** Personalisation offset from logged-race observations (sec/km). */
  personalOffsetSec: number;
  /** Critical Pace estimate in sec/km — the user's sustainable pace for
   *  HYROX-format intervals. Equal to `thresholdSecKm × cpRatio` before
   *  the format factor is applied. Surfaced on Stats view. */
  criticalPaceSecKm: number;
}

export interface HyroxRunPaceResult {
  paceSecKm: number;
  /** The branch that won: 'user' whenever the stored value is returned, even
   *  one written by applyHyroxRunPaceDerivation. The marker-bump gate reads
   *  this (main.ts runs detect before apply for that reason). Not a caption. */
  source: HyroxRunPaceSource;
  /** Where the returned pace came from, the one source for every provenance
   *  caption (Forecast chip, confidence note, Run pace page, Stats row). The
   *  stored value keeps its own provenance (hyroxRunPaceSource 'derived'
   *  stays derived); otherwise equal to `source`. The Forecast chip read
   *  `source` and said "Set manually" for a stored derived pace that Stats
   *  captioned "Updated from your runs" (ISSUE-406 (d)). */
  provenance: HyroxRunPaceProvenance;
  /** The model-derived value if available, regardless of which won. */
  derivedSecKm: number | null;
  /** Component breakdown for UI surfacing (Stats view CP card). */
  components?: HyroxRunPaceComponents;
}

/**
 * Population-model run pace (no user override, no personal offset).
 * Exposed for use by the personalisation update loop, which compares
 * observed pace against the population model to compute the residual.
 */
export function derivePopulationRunPace(
  state: SimulatorState,
  targetFormat: 'singles' | 'doubles',
): { paceSecKm: number; components: HyroxRunPaceComponents } | null {
  const hx = state.hyroxConfig;
  if (!hx) return null;
  const vdot = state.v;
  const ltPace = state.lt ?? state.ltPace ?? null;
  if (typeof vdot !== 'number' || vdot < 25 || vdot > 85) return null;

  const thresholdSecKm = gp(vdot, ltPace).t;
  const cpRatio = cpRatioForVdot(vdot);
  const criticalPaceSecKm = thresholdSecKm * cpRatio;
  const formatFactor = targetFormat === 'doubles'
    ? doublesRunPaceFactor(criticalPaceSecKm, hyroxDoublesTablesForState(state))
    : 1.0;
  const paceSecKm = Math.max(
    HYROX_RUN_PACE_MIN_SEC_KM,
    Math.round(criticalPaceSecKm * formatFactor),
  );
  return {
    paceSecKm,
    components: {
      thresholdSecKm,
      cpRatio,
      formatFactor,
      personalOffsetSec: 0,
      criticalPaceSecKm,
    },
  };
}

/** Derive a HYROX run pace using the CP-anchored model + personalisation,
 *  honouring a user-entered value unless the derived is meaningfully faster.
 */
export function deriveHyroxRunPace(state: SimulatorState): HyroxRunPaceResult {
  const hx = state.hyroxConfig;
  if (!hx) return { paceSecKm: SEED_RUN_PACE_SEC_KM.intermediate, source: 'seed', provenance: 'seed', derivedSecKm: null };

  const band = hx.athleteBand;
  const targetFormat: 'singles' | 'doubles' =
    (hx.format === 'open_doubles' || hx.format === 'pro_doubles') ? 'doubles' : 'singles';
  // The band seed is a singles pace: the band's median run total / 8 in the
  // field the band was read in (hyroxSeedRunPaceSecKm). Doubles applies the
  // same run ratio as the derived path so both sources mean the same thing.
  const seed = hyroxSeedRunPaceForFormat(state, band, targetFormat);

  // Population model (no offset), only for a measured runner. The model reads
  // state.v, and without a real running-fitness signal that is the bare
  // baseline (the default VDOT 50, or a stale carried value): a pace from it
  // would be captioned "Updated from your runs" for a runner with no runs. The
  // canonical rule is no claims off the bare-baseline VDOT
  // (hasRealRunningFitnessSignal, physiological-vdot.ts), so such a runner gets
  // the band seed, captioned "Population est." (Tristan, 2026-10-21, D5). The
  // personal offset is a residual against this model, so it goes with it.
  const measured = hyroxRunVdotIsMeasured(state);
  const pop = measured ? derivePopulationRunPace(state, targetFormat) : null;

  // Personal offset from the last HYROX race, decayed by age. It is a residual
  // on the base it was fitted against (hyroxRunPaceOffsetBase), so it applies
  // only on that base: the CP model for a measured runner, the band seed for
  // an unmeasured one. A mismatched offset (the base changed since the fit)
  // applies nowhere until refreshHyroxPersonalRunPaceOffset refits it.
  const offsetBase = hyroxRunPaceOffsetBase(hx);
  const personalOffset = pop && offsetBase === 'vdot' ? computePersonalRunPaceOffset(state) : 0;
  const seedOffset = !measured && offsetBase === 'seed' ? computePersonalRunPaceOffset(state) : 0;

  let derived: number | null = null;
  let components: HyroxRunPaceComponents | undefined;
  if (pop) {
    derived = Math.max(
      HYROX_RUN_PACE_MIN_SEC_KM,
      Math.round(pop.paceSecKm + personalOffset),
    );
    components = { ...pop.components, personalOffsetSec: personalOffset };
  }

  const userVal = hx.hyroxRunPaceSecKm;
  if (typeof userVal === 'number' && userVal > 0) {
    // Manually-set yields to improvements: derived overrides user when
    // faster by ≥ 5 s/km. Below that margin, user wins.
    if (derived != null && derived <= userVal - 5) {
      return { paceSecKm: derived, source: 'derived', provenance: 'derived', derivedSecKm: derived, components };
    }
    // The stored value wins. A value applyHyroxRunPaceDerivation wrote keeps
    // 'derived' provenance; one the athlete entered or pasted is 'user'.
    const provenance: HyroxRunPaceSource = hx.hyroxRunPaceSource === 'derived' ? 'derived' : 'user';
    return { paceSecKm: userVal, source: 'user', provenance, derivedSecKm: derived, components };
  }
  if (derived != null) return { paceSecKm: derived, source: 'derived', provenance: 'derived', derivedSecKm: derived, components };
  // An unmeasured runner with a previous HYROX race: the band seed moved by
  // the offset fitted against that seed, so the race's run time still anchors
  // the forecast (E5, 2026-10-22). D5 dropped the offset with the VDOT model,
  // and a beginner who had raced lost the race's anchor. Still the seed branch
  // (source 'seed', no model value): nothing is written to the athlete's pace
  // slot, and the plan keeps the seed.
  if (seedOffset !== 0) {
    return {
      paceSecKm: Math.max(HYROX_RUN_PACE_MIN_SEC_KM, Math.round(seed + seedOffset)),
      source: 'seed', provenance: 'race', derivedSecKm: null,
    };
  }
  return { paceSecKm: seed, source: 'seed', provenance: 'seed', derivedSecKm: null };
}

/**
 * The VDOT the run horizon projects from: the base the forecast's run pace
 * uses. A measured runner (hasRealRunningFitnessSignal): state.v. Otherwise
 * the band seed (D5), expressed as the VDOT at which the forecast's own CP
 * model (gp(v).t x cpRatioForVdot(v), the singles pace derivePopulationRunPace
 * gives without LT) equals the band's singles seed pace, found by bisection
 * over the model's VDOT range [25, 85]. No new constant: the model and the
 * seed are the forecast's own. Null without a HYROX config. Tracking side.
 */
export function hyroxRunBaseVdot(state: SimulatorState): number | null {
  const hx = state.hyroxConfig;
  if (!hx) return null;
  if (hyroxRunVdotIsMeasured(state)) {
    return typeof state.v === 'number' && state.v > 0 ? state.v : null;
  }
  const seed = hyroxSeedRunPaceSecKm(state, hx.athleteBand);
  if (!Number.isFinite(seed) || seed <= 0) return null;
  const modelPace = (v: number) => gp(v, null).t * cpRatioForVdot(v);
  let lo = 25, hi = 85; // modelPace falls as VDOT rises
  if (seed >= modelPace(lo)) return lo;
  if (seed <= modelPace(hi)) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (modelPace(mid) > seed) lo = mid; else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10) / 10;
}

/**
 * Legacy export. Kept for tests and callers that read the discrete ratio
 * directly. The continuous interpolation via `cpRatioForVdot()` is the
 * canonical lookup; this table just exposes the anchor values for
 * back-compat. Numbers updated from the v1 (threshold-anchored) values to
 * the v2 (CP-anchored) values; consumers see the new, lower ratios.
 */
export const HYROX_FATIGUE_TO_THRESHOLD_RATIO: Record<AbilityBand, number> = {
  total_beginner: 1.32,
  beginner:       1.22,
  novice:         1.12,
  intermediate:   1.05,
  advanced:       1.00,
  competitive:    0.96,
};

/**
 * Idempotent refresh: fit the personal offset from the athlete's stored
 * previous race against the run-pace base in use, and refit it when that base
 * changes. Mutates `state.hyroxConfig` in place.
 *
 * The base (HyroxRunPaceOffsetBase): the CP model at the athlete's VDOT for a
 * measured runner (hasRealRunningFitnessSignal), the band seed pace for an
 * unmeasured one (D5, the base deriveHyroxRunPace uses). The offset is the
 * observed race pace minus the base at the race's format, blended
 * (blendPersonalRunPaceOffset). Fitting an unmeasured runner against the seed
 * keeps the race anchoring the forecast; fitting against the bare-baseline
 * VDOT (the default 50) gave an offset that was either dropped (D5) or, once a
 * real signal arrived, applied to a different VDOT than it was fitted at
 * (E5, 2026-10-22). The offset is a pure function of the stored race and the
 * base (the date stamp is the race date, so a refit leaves its decay alone).
 *
 * Returns true if state was modified (caller should call `saveState`).
 *
 * Called from:
 * - `main.ts` at launch, before the run-pace marker pass
 * - `hyrox-prev-time-update.ts` after a new previous race is entered
 * (`initialization.hyrox.ts` inlines an older copy fitted against the VDOT
 * model with no base stamp; this refresh refits it at the next launch.)
 *
 * Skipped paths (no-op):
 * - No `previousHyroxTimeSec` stored
 * - Format unknown (`hyroxPreviousTimeFormat` missing)
 * - Measured runner with VDOT out of range
 * - Offset already fitted against the base in use
 */
export function refreshHyroxPersonalRunPaceOffset(state: SimulatorState): boolean {
  const hx = state.hyroxConfig as HyroxConfigWithOffsetBase | undefined;
  if (!hx) return false;
  const measured = hyroxRunVdotIsMeasured(state);
  const wantBase: HyroxRunPaceOffsetBase = measured ? 'vdot' : 'seed';
  if (hx.personalRunPaceOffsetSec != null && hx.personalRunPaceOffsetBase === wantBase) return false;
  const prevTimeSec = hx.previousHyroxTimeSec;
  const prevFmt = hx.hyroxPreviousTimeFormat;
  const prevFormatKnown =
    prevFmt === 'open_singles' || prevFmt === 'pro_singles' ||
    prevFmt === 'open_doubles' || prevFmt === 'pro_doubles';
  if (prevTimeSec == null || !prevFormatKnown) return false;
  const vdot = state.v;
  if (measured && (typeof vdot !== 'number' || vdot < 25 || vdot > 85)) return false;
  // An offset fitted against another base no longer applies (deriveHyroxRunPace
  // reads it only on its own base): clear it before the refit, so a refit that
  // finds no offset leaves none behind.
  const hadStale = hx.personalRunPaceOffsetSec != null;
  if (hadStale) {
    hx.personalRunPaceOffsetSec = undefined;
    hx.personalRunPaceOffsetUpdatedAtISO = undefined;
    hx.personalRunPaceOffsetConfidence = undefined;
    hx.personalRunPaceOffsetBase = undefined;
  }

  const splits = (hx as { hyroxPreviousStationSplits?: Record<string, number> }).hyroxPreviousStationSplits;
  const splitCount = splits ? Object.keys(splits).length : 0;
  const hasSplits = splitCount >= 6;
  const band = hx.athleteBand;
  // The previous race's own field: its weight family, the division the pair
  // raced in (hyroxPreviousTimeDivision, else the current division, else
  // sex) for doubles, the athlete's sex for singles. The same field "where
  // you lost time" compares the result in.
  const raceDivision = hx.hyroxPreviousTimeDivision ?? hx.division;
  // The athlete's own sex (their singles field), hyroxPlanningBandFor's rule:
  // biological sex, then the current division pick, then the race's (a
  // women's or men's pair says it). The race division alone would read a
  // sex-unset Women pick who raced Mixed in the pooled singles field here
  // while her planning band reads the women's.
  const athleteSex = resolveHyroxAthleteSex(state.biologicalSex, hx.division)
    ?? resolveHyroxAthleteSex(undefined, hx.hyroxPreviousTimeDivision)
    ?? state.biologicalSex;
  const prevTables = hyroxDoublesTables(prevFmt, athleteSex, raceDivision);

  let stationsTotalSec: number;
  let roxzoneSec: number;
  let stationsFromSplits = false;
  if (hasSplits) {
    stationsTotalSec = HYROX_STATION_ORDER.reduce(
      (sum, st) => sum + ((splits as Record<string, number>)[st as HyroxStation] ?? 0),
      0,
    );
    // Splits give the stations; Roxzone is the band seed in the race's
    // format (doubles: × the percentile-matched Roxzone ratio).
    roxzoneSec = seedRoxzoneSecForFormat(band, prevFmt as HyroxRaceObservation['format'], prevTables);
    stationsFromSplits = true;
  } else {
    const est = estimateStationsAndRoxzoneFromBand(band, prevFmt as HyroxRaceObservation['format'], prevTables);
    stationsTotalSec = est.stationsTotalSec;
    roxzoneSec = est.roxzoneSec;
  }
  const observation: HyroxRaceObservation = {
    finishSec: prevTimeSec,
    stationsTotalSec,
    roxzoneSec,
    format: prevFmt as HyroxRaceObservation['format'],
    dateISO: hx.hyroxPreviousRaceDate ?? new Date().toISOString().slice(0, 10),
    stationsFromSplits,
  };
  const observedPaceSecKm = backComputeRunPaceFromRace(observation);
  if (observedPaceSecKm == null) return hadStale;

  const prevTargetFormat: 'singles' | 'doubles' =
    (prevFmt === 'open_doubles' || prevFmt === 'pro_doubles') ? 'doubles' : 'singles';
  // The base at the previous race: the athlete's own sex, the race's format
  // and division (the same tables as the observation above). The CP model at
  // the VDOT for a measured runner, the band seed for an unmeasured one.
  const fakeState = {
    ...state,
    biologicalSex: athleteSex,
    hyroxConfig: { ...hx, format: prevFmt, athleteBand: band, division: raceDivision },
  } as SimulatorState;
  const basePaceSecKm = measured
    ? derivePopulationRunPace(fakeState, prevTargetFormat)?.paceSecKm ?? null
    : hyroxSeedRunPaceForFormat(fakeState, band, prevTargetFormat, prevTables);
  if (basePaceSecKm == null) return hadStale;

  const blended = blendPersonalRunPaceOffset({
    observedPaceSecKm,
    modelPaceSecKm: basePaceSecKm,
    stationsFromSplits,
  });
  if (blended.offsetSec === 0) return hadStale;

  hx.personalRunPaceOffsetSec = blended.offsetSec;
  hx.personalRunPaceOffsetUpdatedAtISO = observation.dateISO;
  hx.personalRunPaceOffsetConfidence = blended.confidence;
  hx.personalRunPaceOffsetBase = wantBase;
  console.log(
    `[hyrox] personalised run-pace offset = ${blended.offsetSec >= 0 ? '+' : ''}${blended.offsetSec} s/km` +
    ` (observed ${observedPaceSecKm}, ${wantBase} base ${basePaceSecKm}, splits=${stationsFromSplits}, conf=${blended.confidence.toFixed(2)})`,
  );
  return true;
}
