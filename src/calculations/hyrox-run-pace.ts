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
  source: HyroxRunPaceSource;
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
  if (!hx) return { paceSecKm: SEED_RUN_PACE_SEC_KM.intermediate, source: 'seed', derivedSecKm: null };

  const band = hx.athleteBand;
  const targetFormat: 'singles' | 'doubles' =
    (hx.format === 'open_doubles' || hx.format === 'pro_doubles') ? 'doubles' : 'singles';
  // The band seed is a singles pace: the band's median run total / 8 in the
  // field the band was read in (hyroxSeedRunPaceSecKm). Doubles applies the
  // same run ratio as the derived path so both sources mean the same thing.
  const singlesSeed = hyroxSeedRunPaceSecKm(state, band);
  const seed = targetFormat === 'doubles'
    ? Math.round(singlesSeed * doublesRunPaceFactor(singlesSeed, hyroxDoublesTablesForState(state)))
    : singlesSeed;

  // Population model (no offset).
  const pop = derivePopulationRunPace(state, targetFormat);

  // Personal offset from logged-race observations, decayed by age.
  const personalOffset = pop ? computePersonalRunPaceOffset(state) : 0;

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
      return { paceSecKm: derived, source: 'derived', derivedSecKm: derived, components };
    }
    return { paceSecKm: userVal, source: 'user', derivedSecKm: derived, components };
  }
  if (derived != null) return { paceSecKm: derived, source: 'derived', derivedSecKm: derived, components };
  return { paceSecKm: seed, source: 'seed', derivedSecKm: null };
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
 * Idempotent refresh: compute the initial personal offset from a user's
 * stored previous-race data when the offset hasn't been computed yet.
 * Mutates `state.hyroxConfig` in place when a non-zero offset is produced.
 *
 * Returns true if state was modified (caller should call `saveState`).
 * Returns false when there's no data, when the offset already exists, or
 * when the math is degenerate.
 *
 * Called from:
 * - `initialization.hyrox.ts` (initial onboarding path; same logic inlined there for now)
 * - `main.ts` at launch (boot-time migration for existing users who pre-date v2)
 *
 * Skipped paths (no-op):
 * - No `previousHyroxTimeSec` stored
 * - Format unknown (`hyroxPreviousTimeFormat` missing)
 * - VDOT out of range
 * - Offset already populated (`personalRunPaceOffsetSec != null`)
 */
export function refreshHyroxPersonalRunPaceOffset(state: SimulatorState): boolean {
  const hx = state.hyroxConfig;
  if (!hx) return false;
  if (hx.personalRunPaceOffsetSec != null) return false;
  const prevTimeSec = hx.previousHyroxTimeSec;
  const prevFmt = hx.hyroxPreviousTimeFormat;
  const prevFormatKnown =
    prevFmt === 'open_singles' || prevFmt === 'pro_singles' ||
    prevFmt === 'open_doubles' || prevFmt === 'pro_doubles';
  if (prevTimeSec == null || !prevFormatKnown) return false;
  const vdot = state.v;
  if (typeof vdot !== 'number' || vdot < 25 || vdot > 85) return false;

  const splits = (hx as { hyroxPreviousStationSplits?: Record<string, number> }).hyroxPreviousStationSplits;
  const splitCount = splits ? Object.keys(splits).length : 0;
  const hasSplits = splitCount >= 6;
  const band = hx.athleteBand;
  // The previous race's own field: its weight family, the pair's division
  // (else sex) for doubles, the athlete's sex for singles.
  const prevTables = hyroxDoublesTables(prevFmt, state.biologicalSex, hx.division);

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
  if (observedPaceSecKm == null) return false;

  const prevTargetFormat: 'singles' | 'doubles' =
    (prevFmt === 'open_doubles' || prevFmt === 'pro_doubles') ? 'doubles' : 'singles';
  const fakeState = {
    ...state,
    hyroxConfig: { ...hx, format: prevFmt, athleteBand: band },
  } as SimulatorState;
  const modelAtPrev = derivePopulationRunPace(fakeState, prevTargetFormat);
  if (!modelAtPrev) return false;

  const blended = blendPersonalRunPaceOffset({
    observedPaceSecKm,
    modelPaceSecKm: modelAtPrev.paceSecKm,
    stationsFromSplits,
  });
  if (blended.offsetSec === 0) return false;

  hx.personalRunPaceOffsetSec = blended.offsetSec;
  hx.personalRunPaceOffsetUpdatedAtISO = observation.dateISO;
  hx.personalRunPaceOffsetConfidence = blended.confidence;
  console.log(
    `[hyrox] personalised run-pace offset = ${blended.offsetSec >= 0 ? '+' : ''}${blended.offsetSec} s/km` +
    ` (observed ${observedPaceSecKm}, model ${modelAtPrev.paceSecKm}, splits=${stationsFromSplits}, conf=${blended.confidence.toFixed(2)})`,
  );
  return true;
}
