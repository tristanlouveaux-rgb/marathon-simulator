/**
 * Population-sourced HYROX benchmark data.
 *
 * Station seed times (seconds) and run pace by ability band.
 * Open division, gender-averaged midpoints.
 *
 * Sources (all accessed 2026-05):
 *   HyroxDataLab. 700k+ race database, target split tables by finish goal
 *   RoxLyfe. Elite vs average Pro division analysis (roxlyfe.com)
 *   Hyroxy.com. Open/Pro aggregate station averages
 *
 * Key structural findings:
 *   - Biggest skill gaps: Sled Pull (3:17 elite-vs-avg), Wall Balls (3:13),
 *     Burpee Broad Jumps (2:54). These are the primary discriminators.
 *   - Smallest gaps: SkiErg (0:30), Row Erg (0:37). Cardio machines compress the field.
 *   - Running degradation is tier-defining: beginners fade from ~3:44/km (leg 1)
 *     to ~6:19/km (leg 8). Competitive athletes hold 3:24-4:15 with minimal fade.
 *
 * Science log entry: docs/SCIENCE_LOG.md §L.
 */

import type { AbilityBand, HyroxLoadTier, HyroxStation } from '@/types/triathlon';

/**
 * Population-average station times (seconds) by ability band.
 * Open division, gender-averaged midpoints from HyroxDataLab target-split table
 * and roxlyfe.com elite/average cohort analysis.
 */
export const STATION_SEED_TIMES_SEC: Record<AbilityBand, Record<HyroxStation, number>> = {
  // sub-65 min total, ~3:52/km avg. Based on elite/sub-1:05 cohort (roxlyfe.com).
  competitive: {
    ski_erg:            227,  // 3:47  (roxlyfe elite)
    sled_push:          165,  // 2:45
    sled_pull:          194,  // 3:14
    burpee_broad_jumps: 141,  // 2:21
    row_erg:            238,  // 3:58
    farmer_carry:        97,  // 1:37
    sandbag_lunges:     183,  // 3:03
    wall_balls:         265,  // 4:25
  },
  // 65-80 min total, ~4:30/km. Top-10% to top-25% cohort from HyroxDataLab.
  advanced: {
    ski_erg:            260,  // 4:20
    sled_push:          190,  // 3:10  (HyroxDataLab sub-1:20 target)
    sled_pull:          250,  // 4:10
    burpee_broad_jumps: 255,  // 4:15
    row_erg:            260,  // 4:20
    farmer_carry:       110,  // 1:50
    sandbag_lunges:     220,  // 3:40
    wall_balls:         315,  // 5:15
  },
  // 80-100 min total, ~5:05/km. HyroxDataLab intermediate cohort (4:27-5:19 range per station).
  intermediate: {
    ski_erg:            267,  // 4:27  (HyroxDataLab measured)
    sled_push:          221,  // 3:41  (HyroxDataLab measured)
    sled_pull:          306,  // 5:06  (HyroxDataLab measured)
    burpee_broad_jumps: 319,  // 5:19  (HyroxDataLab measured)
    row_erg:            284,  // 4:44  (HyroxDataLab measured)
    farmer_carry:       130,  // 2:10  (HyroxDataLab measured)
    sandbag_lunges:     296,  // 4:56  (HyroxDataLab measured)
    wall_balls:         421,  // 7:01  (HyroxDataLab measured)
  },
  // 100-120 min total, ~5:55/km. Interpolated from HyroxDataLab 1:30-1:45 target rows.
  novice: {
    ski_erg:            300,  // 5:00
    sled_push:          250,  // 4:10
    sled_pull:          350,  // 5:50
    burpee_broad_jumps: 360,  // 6:00
    row_erg:            306,  // 5:06
    farmer_carry:       150,  // 2:30
    sandbag_lunges:     330,  // 5:30
    wall_balls:         435,  // 7:15  (Hyroxy.com Open average)
  },
  // 120-150 min total, ~6:40/km. Extrapolated from target-split table + roxlyfe beginner cohort.
  beginner: {
    ski_erg:            345,  // 5:45
    sled_push:          290,  // 4:50
    sled_pull:          410,  // 6:50  (roxlyfe avg men 6:31, women 6:36. Average)
    burpee_broad_jumps: 420,  // 7:00
    row_erg:            345,  // 5:45
    farmer_carry:       180,  // 3:00
    sandbag_lunges:     370,  // 6:10
    wall_balls:         470,  // 7:50  (roxlyfe avg men 7:38, women 7:18)
  },
  // 150+ min total, ~7:15/km. Extrapolated conservatively above beginner range.
  total_beginner: {
    ski_erg:            400,  // 6:40
    sled_push:          340,  // 5:40
    sled_pull:          480,  // 8:00
    burpee_broad_jumps: 510,  // 8:30
    row_erg:            400,  // 6:40
    farmer_carry:       220,  // 3:40
    sandbag_lunges:     430,  // 7:10
    wall_balls:         540,  // 9:00
  },
};

/**
 * Average fatigued 1km run pace (seconds/km). Mean across all 8 legs.
 * Leg 1 is faster; leg 8 is slower. These represent the average.
 * Source: HyroxDataLab target-split run totals divided by 8km.
 */
export const SEED_RUN_PACE_SEC_KM: Record<AbilityBand, number> = {
  competitive:    232,  // 3:52/km (roxlyfe elite avg: legs 3:24-4:15, mean ~3:58; rounded)
  advanced:       270,  // 4:30/km
  intermediate:   305,  // 5:05/km
  novice:         355,  // 5:55/km
  beginner:       400,  // 6:40/km
  total_beginner: 435,  // 7:15/km
};

/**
 * RoxZone transition time total (seconds). Time moving between start/finish zones.
 * Elite athletes use 2:54; beginners lose 10-12 minutes in transitions.
 * Source: roxlyfe.com (elite 2:54, average 6:58); HyroxDataLab target table.
 */
export const SEED_ROXZONE_SEC: Record<AbilityBand, number> = {
  competitive:    174,  // 2:54  (roxlyfe elite)
  advanced:       270,  // 4:30  (interpolated)
  intermediate:   390,  // 6:30  (HyroxDataLab target table)
  novice:         480,  // 8:00
  beginner:       600,  // 10:00
  total_beginner: 720,  // 12:00
};

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
