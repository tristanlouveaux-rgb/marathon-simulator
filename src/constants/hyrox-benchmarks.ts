/**
 * HYROX benchmark data: band seed times derived from real results.
 *
 * Station seed times, run pace and Roxzone per ability band come from the
 * HYROX results tables (src/data/hyrox-results-s79.ts, HYROX_S89_BAND_SEEDS,
 * seasons 8 and 9, the field as judged now). For each band of a format x sex
 * field (the band's percentile range in that field, HYROX_S89_BAND_THRESHOLDS_SEC),
 * the seed is the median split among the finishers whose total falls in the
 * band. Run pace = the band's median run total / 8. total_beginner has no
 * finish-time range (it is the pick for a first HYROX) and takes the beginner
 * cell.
 *
 * The exported tables (STATION_SEED_TIMES_SEC, SEED_RUN_PACE_SEC_KM,
 * SEED_ROXZONE_SEC) are Open Singles with women and men pooled, for callers
 * that pass no cohort. Callers that know the athlete read the seeds through
 * hyrox-results.ts: hyroxSeedField picks the field the athlete's band was
 * read in (the planning field, Open Singles at the athlete's own sex, for
 * every format; lane H3c, hyrox-planning-band.ts), stationSeedTimesFor /
 * seedRunPaceSecKmFor / seedRoxzoneSecFor read that field's band medians, and
 * hyroxStationSeedsAtTarget converts the station seeds to the target's solo
 * loads per station (hyroxOpenToProSec, the difference in differences on the
 * Pro and Open results) when those are the Pro tier. A Pro target therefore
 * seeds from the Open field's medians converted to Pro loads, never from the
 * fitter Pro field's band. The Pro band cells stay in the data module for
 * reference; no seed reads them.
 * Seeds are one athlete's times; the doubles forecast scales them into the
 * pair's time with the doubles ratios (hyrox-doubles.ts).
 *
 * History: until lane H3b (2026-10-13) these were hand-set from HyroxDataLab,
 * roxlyfe.com and Hyroxy.com aggregates (SCIENCE_LOG §L), Open division,
 * sexes averaged, with a Pro target's seeds scaled by the unsourced
 * HYROX_PRO_STATION_MULTIPLIER.
 *
 * Limitations: venue variation (sled stations vary most, HYROX_S79_VENUE_SPREAD);
 * run legs are not exactly 1 km at every venue; a band's median split is a
 * race split (in-race fatigue), not a fresh test.
 */

import type { AbilityBand, HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import {
  HYROX_S89_BAND_SEEDS,
  type HyroxBandCellSex,
  type HyroxBandSeedCell,
} from '@/data/hyrox-results-s79';

/** Singles formats a seed can be read from (one athlete's times). */
export type HyroxSeedFormat = 'open_singles' | 'pro_singles';

const SEED_STATIONS: HyroxStation[] = [
  'ski_erg', 'sled_push', 'sled_pull', 'burpee_broad_jumps',
  'row_erg', 'farmer_carry', 'sandbag_lunges', 'wall_balls',
];
const ALL_BANDS: AbilityBand[] = ['competitive', 'advanced', 'intermediate', 'novice', 'beginner', 'total_beginner'];

function bandSeedCell(band: AbilityBand, format: HyroxSeedFormat, sex: HyroxBandCellSex): HyroxBandSeedCell {
  const b = band === 'total_beginner' ? 'beginner' : band;
  const cells = HYROX_S89_BAND_SEEDS[format];
  return (sex !== 'pooled' ? cells[sex]?.[b] : undefined) ?? cells.pooled![b]!;
}

/** Station seed times (seconds, one athlete) for a band in a singles field. */
export function stationSeedTimesFor(
  band: AbilityBand,
  format: HyroxSeedFormat = 'open_singles',
  sex: HyroxBandCellSex = 'pooled',
): Record<HyroxStation, number> {
  const m = bandSeedCell(band, format, sex).medians;
  return Object.fromEntries(SEED_STATIONS.map(st => [st, m[st]])) as Record<HyroxStation, number>;
}

/** Seed fatigued run pace (seconds/km, mean of the 8 legs) for a band: the
 *  band's median run total / 8, to the whole second. */
export function seedRunPaceSecKmFor(
  band: AbilityBand,
  format: HyroxSeedFormat = 'open_singles',
  sex: HyroxBandCellSex = 'pooled',
): number {
  return Math.round(bandSeedCell(band, format, sex).medians.run_total / 8);
}

/** Seed Roxzone total (seconds) for a band: the band's median Roxzone. */
export function seedRoxzoneSecFor(
  band: AbilityBand,
  format: HyroxSeedFormat = 'open_singles',
  sex: HyroxBandCellSex = 'pooled',
): number {
  return bandSeedCell(band, format, sex).medians.roxzone;
}

/** Open Singles seed times by band, women and men pooled (stationSeedTimesFor
 *  with no cohort). */
export const STATION_SEED_TIMES_SEC: Record<AbilityBand, Record<HyroxStation, number>> =
  Object.fromEntries(ALL_BANDS.map(b => [b, stationSeedTimesFor(b)])) as Record<AbilityBand, Record<HyroxStation, number>>;

/** Open Singles seed run pace by band (seconds/km), women and men pooled. */
export const SEED_RUN_PACE_SEC_KM: Record<AbilityBand, number> =
  Object.fromEntries(ALL_BANDS.map(b => [b, seedRunPaceSecKmFor(b)])) as Record<AbilityBand, number>;

/** Open Singles seed Roxzone by band (seconds), women and men pooled. */
export const SEED_ROXZONE_SEC: Record<AbilityBand, number> =
  Object.fromEntries(ALL_BANDS.map(b => [b, seedRoxzoneSecFor(b)])) as Record<AbilityBand, number>;

/**
 * Minimum plausible station times (seconds). Physical lower bound for any human.
 * Used to reject clearly-corrupted input (e.g. h:mm:ss parsed as mm:ss → 2s instead of 2:56).
 * Set at roughly 65% of the competitive-band seed times to allow for WR-class athletes
 * while still catching obvious parsing errors.
 */
export const STATION_MIN_SEC: Record<HyroxStation, number> = {
  ski_erg:            90,   // 1:30. 1000m SkiErg
  sled_push:          40,   // 0:40. 50m push
  sled_pull:          50,   // 0:50. 50m pull
  burpee_broad_jumps: 55,   // 0:55. 80m of burpee broad jumps
  row_erg:           120,   // 2:00. 1000m row
  farmer_carry:       35,   // 0:35. 200m carry
  sandbag_lunges:     70,   // 1:10. 100m lunges
  wall_balls:         90,   // 1:30. 100 reps
};

/** Minimum plausible run km pace (seconds/km). Below 3:10/km is physiologically impossible under HYROX conditions. */
export const HYROX_RUN_PACE_MIN_SEC_KM = 190; // 3:10/km

/** Human-readable station name + distance for UI display. */
export const STATION_DISPLAY: Record<HyroxStation, { name: string; distance: string }> = {
  ski_erg:            { name: 'SkiErg',             distance: '1000m' },
  sled_push:          { name: 'Sled Push',           distance: '50m' },
  sled_pull:          { name: 'Sled Pull',           distance: '50m' },
  burpee_broad_jumps: { name: 'Burpee Broad Jumps',  distance: '80m' },
  row_erg:            { name: 'Row Erg',             distance: '1000m' },
  farmer_carry:       { name: 'Farmer Carry',        distance: '200m' },
  sandbag_lunges:     { name: 'Sandbag Lunges',      distance: '100m' },
  // 100 reps in every division, Women Open included, since 24/25 (26/27 Singles
  // rulebook s8.8, Doubles rulebook s4.1 and s8.8). 75 was the 23/24 Women Open count.
  wall_balls:         { name: 'Wall Balls',           distance: '100 reps' },
};

/** Race station order — always fixed in a HYROX event. */
export const HYROX_STATION_ORDER: HyroxStation[] = [
  'ski_erg', 'sled_push', 'sled_pull', 'burpee_broad_jumps',
  'row_erg', 'farmer_carry', 'sandbag_lunges', 'wall_balls',
];

/**
 * Station loads per load tier, kg (26/27 Singles rulebook s4.1, Doubles rulebook
 * s4.1; no load changed from 25/26). Sled weights include the sled. Farmers carry
 * is per hand. Women Pro races the Men Open tier. Which tier an athlete races
 * comes from `hyroxLoadTier` (src/calculations/hyrox-division.ts), never from
 * the format alone.
 */
export const HYROX_LOAD_TIER_KG: Record<HyroxLoadTier, {
  sledPush: number;
  sledPull: number;
  farmerPerHand: number;
  sandbag: number;
  wallBall: number;
}> = {
  'W-Open': { sledPush: 102, sledPull: 78,  farmerPerHand: 16, sandbag: 10, wallBall: 4 },
  'M-Open': { sledPush: 152, sledPull: 103, farmerPerHand: 24, sandbag: 20, wallBall: 6 },
  'M-Pro':  { sledPush: 202, sledPull: 153, farmerPerHand: 32, sandbag: 30, wallBall: 9 },
};

/** Wall-ball target height, metres, by the thrower's sex (26/27 Singles rulebook
 *  s8.8): 2.70 m for women, Women Pro included; 3.00 m for men. In Mixed Doubles
 *  each partner throws to their own target. */
export const WALL_BALL_TARGET_M = { female: 2.70, male: 3.00 } as const;

/** Fraction of the race sled weight (sled included) used as the sled stations'
 *  external-load proxy in MTL. Push and pull share force between the sled's
 *  rolling resistance and the athlete, so half the sled weight stands in for the
 *  load the legs carry. The rule the original STATION_EXTERNAL_LOAD_KG comment
 *  stated ("half race sled weight, force proxy"); one rule for every tier. */
export const SLED_EXTERNAL_LOAD_FRACTION = 0.5;

/**
 * External load per station for the MTL externalLoadFactor (computeComponentMTL),
 * kg, derived from the athlete's load tier:
 *   - sled push / pull: SLED_EXTERNAL_LOAD_FRACTION × the tier's sled weight
 *   - farmers carry: the tier's per-hand kettlebell
 *   - sandbag lunges: the tier's sandbag
 *   - wall balls: the tier's ball
 * Ergs and burpee broad jumps carry no external load (absent).
 *
 * Replaces the fixed STATION_EXTERNAL_LOAD_KG table, which mixed tiers under an
 * "Open weights" label (9 kg Men Pro ball, Men Open farmers and sandbag, sleds at
 * half the Women Open weights).
 */
export function stationExternalLoadKg(tier: HyroxLoadTier): Partial<Record<HyroxStation, number>> {
  const t = HYROX_LOAD_TIER_KG[tier];
  return {
    sled_push:      t.sledPush * SLED_EXTERNAL_LOAD_FRACTION,
    sled_pull:      t.sledPull * SLED_EXTERNAL_LOAD_FRACTION,
    farmer_carry:   t.farmerPerHand,
    sandbag_lunges: t.sandbag,
    wall_balls:     t.wallBall,
  };
}
