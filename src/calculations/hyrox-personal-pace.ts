/**
 * HYROX run-pace personalisation. Bayesian update from logged races.
 *
 * **Principle**: the population model (`derivePopulationRunPace`) starts
 * with a conservative prior based on VDOT + band + format. As the athlete
 * logs HYROX races, the residual between *observed* and *predicted* run
 * pace updates a personalised offset that biases future predictions toward
 * what they actually do. This mirrors the Mosaic-wide "Manually-set
 * Benchmarks Yield to Improvements" rule, applied here in a Bayesian frame:
 *
 *   posterior_pace = population_prior + personal_offset × confidence_weight
 *
 * **Decay**: the offset decays linearly to zero over 12 months without new
 * race evidence. Without recent data we revert to the population prior.
 *
 * **Why offset rather than full replacement**: it stays informative when a
 * single race was unusual (heat, illness) and survives format changes
 * (singles ↔ doubles) gracefully. The offset is in sec/km of pace, which
 * is comparable across formats once the format factor is applied.
 *
 * **Back-computation caveat**: deriving observed run pace from a race finish
 * requires station time estimates. When the athlete pasted per-station
 * splits at onboarding (`hyroxPreviousStationSplits`), this is exact. When
 * only the finish time is known, we estimate stations from band seeds —
 * less accurate, so we apply a lower confidence weight in that case.
 *
 * Citations + rationale in `docs/SCIENCE_LOG.md §X`.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxStation, AbilityBand } from '@/types/triathlon';
import { HYROX_STATION_ORDER, stationSeedTimesFor } from '@/constants/hyrox-benchmarks';
import { doublesStationTeamSec, seedRoxzoneSecForFormat, type HyroxDoublesTables } from './hyrox-doubles';

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;
/** Months after which the personalised offset decays fully to 0. */
const PERSONAL_OFFSET_DECAY_MONTHS = 12;
/** Weight assigned to a fresh observation when blending with existing offset.
 *  0.6 means the new race contributes 60% of the new combined value.
 *  Lower for low-quality observations (no per-station splits). */
const NEW_OBSERVATION_WEIGHT_HIGH = 0.6;
const NEW_OBSERVATION_WEIGHT_LOW = 0.35;
/** Bounds — guard against pathological residuals corrupting future predictions. */
const MAX_OFFSET_MAGNITUDE_SEC = 60;

export interface HyroxRaceObservation {
  finishSec: number;
  /** Sum of all 8 stations' active seconds (team total, not per-athlete in
   *  doubles. Total station time elapsed on the clock). */
  stationsTotalSec: number;
  /** Roxzone transitions total. */
  roxzoneSec: number;
  format: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
  dateISO: string;
  /** True when the stations total came from per-station splits the athlete
   *  pasted (high confidence); false when estimated from band seeds. */
  stationsFromSplits: boolean;
}

/** Back-compute the athlete's average per-1km run pace from a race
 *  observation. Returns null when math is degenerate (negative run time). */
export function backComputeRunPaceFromRace(obs: HyroxRaceObservation): number | null {
  const runTotalSec = obs.finishSec - obs.stationsTotalSec - obs.roxzoneSec;
  if (runTotalSec < 60) return null; // implausibly small remainder → discard
  const paceSecKm = runTotalSec / 8;
  if (!Number.isFinite(paceSecKm) || paceSecKm < 150 || paceSecKm > 600) return null;
  return Math.round(paceSecKm);
}

/** Estimate `stationsTotalSec` and `roxzoneSec` from band seeds when actual
 *  per-station splits aren't available. Caller can use this to construct a
 *  HyroxRaceObservation from a finish time alone.
 *
 *  Seeds are the band's median splits in the race's singles field
 *  (stationSeedTimesFor; `tables.singles` when given, else Open Singles
 *  pooled). Doubles: the pair's clock time, each station's seed mapped to the
 *  pair's time at its own percentile (doublesStationTeamSec), the same model
 *  the forecast uses. Without it a doubles finish minus singles station time
 *  left too little run time, and the personal offset read the athlete as
 *  faster than they run. */
export function estimateStationsAndRoxzoneFromBand(
  band: AbilityBand,
  format: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles',
  tables?: HyroxDoublesTables,
): { stationsTotalSec: number; roxzoneSec: number } {
  const singles = tables?.singles;
  const seedFormat = singles?.format === 'pro_singles' ? 'pro_singles' : 'open_singles';
  const seedSex = singles && singles.sex !== 'mixed' ? singles.sex : 'pooled';
  const seeds = stationSeedTimesFor(band, seedFormat, seedSex);
  const isDoubles = format === 'open_doubles' || format === 'pro_doubles';
  const stationsTotalSec = Math.round(HYROX_STATION_ORDER.reduce(
    (sum, st) => sum + (isDoubles ? doublesStationTeamSec(st as HyroxStation, seeds[st as HyroxStation], tables) : seeds[st as HyroxStation]),
    0,
  ));
  const roxzoneSec = seedRoxzoneSecForFormat(band, format, tables);
  return { stationsTotalSec, roxzoneSec };
}

/** Compute the decayed effective personal offset at query time.
 *  Returns 0 when no offset stored or fully decayed. */
export function computePersonalRunPaceOffset(state: SimulatorState): number {
  const hx = state.hyroxConfig;
  if (!hx?.personalRunPaceOffsetSec) return 0;
  if (!hx.personalRunPaceOffsetUpdatedAtISO) return 0;
  const updated = new Date(hx.personalRunPaceOffsetUpdatedAtISO).getTime();
  if (!Number.isFinite(updated)) return 0;
  const ageMonths = (Date.now() - updated) / MS_PER_MONTH;
  if (ageMonths <= 0) return Math.round(hx.personalRunPaceOffsetSec);
  if (ageMonths >= PERSONAL_OFFSET_DECAY_MONTHS) return 0;
  const decayFactor = 1 - ageMonths / PERSONAL_OFFSET_DECAY_MONTHS;
  // `|| 0` collapses `-0` to `0` so callers don't see a signed zero.
  return Math.round(hx.personalRunPaceOffsetSec * decayFactor) || 0;
}

/** Compute the new personalised offset by blending an observation with the
 *  existing offset. Returns the value to store on `hyroxConfig`. */
export function blendPersonalRunPaceOffset(input: {
  observedPaceSecKm: number;
  modelPaceSecKm: number;
  stationsFromSplits: boolean;
  existingOffsetSec?: number;
  existingConfidence?: number;
}): { offsetSec: number; confidence: number } {
  const residual = input.observedPaceSecKm - input.modelPaceSecKm;
  const existing = input.existingOffsetSec ?? 0;
  const existingConf = input.existingConfidence ?? 0;
  const newWeight = input.stationsFromSplits
    ? NEW_OBSERVATION_WEIGHT_HIGH
    : NEW_OBSERVATION_WEIGHT_LOW;

  // Weighted blend; clamp magnitude to prevent runaway personalisation.
  const blended = existing * (1 - newWeight) + residual * newWeight;
  const offsetSec = Math.max(
    -MAX_OFFSET_MAGNITUDE_SEC,
    Math.min(MAX_OFFSET_MAGNITUDE_SEC, Math.round(blended)),
  );
  const confidence = Math.min(1.0, existingConf * (1 - newWeight) + 1.0 * newWeight);
  return { offsetSec, confidence };
}
