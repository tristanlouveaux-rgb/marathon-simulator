/**
 * HYROX results, seasons 7 to 9. Real outcome data. GENERATED FILE: do not edit by hand.
 *
 * Source: Kaggle "HYROX Race Results, Seasons 7-9 (Anonymised)" (Tanvi Jivani),
 * built from public HYROX results via the open pyrox project (pyrox-client, MIT).
 * Kaggle licence "Other"; results are not licensed by HYROX. Only aggregate
 * tables are shipped, never rows.
 *
 * Regenerate (data files live outside the repo):
 *   <python with pyarrow> -I scripts/ingest-hyrox-results-s79.py \
 *     --results <hyrox_results_anonymised.parquet> --repeat <repeat_athletes.csv> \
 *     --out src/data/hyrox-results-s79.ts --refresh-date 2026-10-13
 *
 * Side of the line: tracking (descriptive population tables). Read through
 * src/calculations/hyrox-results.ts, the one lookup every surface uses.
 * The band seeds (HYROX_S89_BAND_SEEDS) also feed planning inputs through
 * src/constants/hyrox-benchmarks.ts (station targets for untested stations).
 *
 * Conventions
 * - All times are whole seconds.
 * - Percentile tables are `[seconds, cumulativePercentile]`, ascending in both.
 *   cumulativePercentile = % of finishers whose time is <= seconds (the
 *   empirical CDF): `[3600, 10]` means 10% of finishers were at or under 1:00:00.
 *   This matches the numbers in hyrox-population-distributions.ts, whose doc
 *   comment words it as "slower than or equal"; the numbers there are the CDF
 *   too (p1 is the fastest time), and consumers compute "faster than X%" as
 *   `100 - cumulativePercentile`.
 * - Quantiles use linear interpolation between order statistics (Hyndman-Fan
 *   type 7), rounded to the nearest second.
 * - Breakpoint grids vary by cell size (see HYROX_S79_GRID_LADDER): each table
 *   uses the finest grid whose smallest percentile gap is at least twice the
 *   DKW 95% simultaneous band half-width for its n. Cells below the coarsest
 *   grid (n < HYROX_S79_MIN_CELL_N) are suppressed and listed.
 *
 * Row hygiene (counts in HYROX_S79_INGEST_REPORT)
 * 1. Divisions relay, adaptive, elite, elite_doubles excluded (different events).
 * 2. Total missing or <= 0 dropped: 2284 zero and 0 null totals.
 *    2282 are the whole open_singles division at vienna 2026 (S8), published with zero
 *    times (0 timed rows in that division there, 3732 timed rows in the event's
 *    other divisions). The other 2 are scattered zeros (droppedTotalMissingByEvent).
 * 3. Exact duplicate rows dropped (identical labels and all 18 timing fields).
 * 3b. One result filed under two labels (same event, all 18 timing fields identical,
 *    different division, sex or age label). Age-only differences keep one copy for
 *    the format x sex tables and leave it out of the age tables (54 copies dropped).
 *    Division or sex differences: copies at an event are pooled per label pair and
 *    each votes for the label whose work/run time ratio it fits (robust z against
 *    each label cell); a set resolves only when a two-sided sign test rejects 50/50
 *    at alpha 0.05 (HYROX_S79_CROSS_LABEL_RESOLUTIONS; 520 copies dropped). Isolated
 *    copies cannot pass, so both twins go (136 rows). Rules 3 and 3b need the
 *    expected number of chance matches at the event (C(n,2) x product of per-field
 *    collision probabilities) below alpha; the largest bound met was 10^-27.1.
 * 4. Total below the log-scale Tukey far-out lower fence (Q1 - 3 IQR) per format x
 *    sex dropped (impossible times). Above the upper fence (Q3 + 3 IQR) the slow tail
 *    is continuous and most rows add up, so the fence alone drops nothing: such a
 *    total is kept only when its own timing corroborates it, i.e. all 16 splits
 *    timed, consistent with the total (rule 5), and no single segment holding more
 *    than the far-out largest-segment share (maxSegmentShare in
 *    HYROX_S79_TOTAL_FENCES_SEC). A late or missed mat puts hours into one segment;
 *    genuine slow finishers are slow throughout. Kept 571 of 757 above-fence rows;
 *    dropped 86 with a missed mat, 12 inconsistent (counted in rule 5),
 *    88 with one dominant segment (totals 2:48 h to 29:51 h).
 *    The longest corroborated total kept is 6:02 h.
 * 5. Rows with all 17 segments timed: |total - sum| <= 17 s required (17
 *    segments + total, each rounded to the second, can only drift < 18 s).
 *    Rows with untimed roxzone: implied roxzone (total - 16 segments) must sit
 *    inside the roxzone far-out fences. Failing rows are dropped entirely.
 * 6. Rows with a missed split mat, or any split/roxzone below its far-out lower
 *    fence (time credited to a neighbour), feed the total table only.
 * Split metrics (run_total, work_total, stations) share one row set; roxzone
 * additionally needs a timed roxzone.
 *
 * Seasons are pooled (S7 to S9) in HYROX_S79_PERCENTILES. At the same venue and
 * the same half of the season one year apart, the largest shift in the median
 * total is:
 *   open_singles: +120 s (female, S7-2025 to S8-2026, 27 venues); smallest total IQR in the format 1418 s
 *   pro_singles: -244 s (male, S8-2025 to S9-2026, 9 venues); smallest total IQR in the format 1271 s
 *   open_doubles: +149 s (female, S7-2025 to S8-2026, 28 venues); smallest total IQR in the format 1017 s
 *   pro_doubles: -314 s (female, S8-2025 to S9-2026, 3 venues); smallest total IQR in the format 885 s
 * Open formats have many shared venues; pro shifts rest on few venues. S9 is a
 * partial season whose larger raw shift is mostly venue mix. Wall balls and
 * sled push step up at the S7 to S8 boundary at the same venues (attributed to
 * the S8 judging change), so pooled tables for those two stations, and for
 * work_total and total that contain them, read faster than the field as judged
 * now. HYROX_S89_PERCENTILES holds the same tables from S8 and S9 only; use them
 * where the current judging standard matters (station targets, placements).
 *
 * Limitation: venues differ. Run legs are not exactly 1 km everywhere (course
 * layouts differ), roxzone depends on the transition layout, and station times
 * vary with venue set-up (sled surface and lane length for the sleds). Event
 * medians as a ratio of the pooled median, p10 to p90 of events, open_singles male:
 *   run_total 0.94-1.15, ski_erg 0.96-1.06, sled_push 0.84-1.23, sled_pull 0.88-1.20
 *   burpee_broad_jumps 0.92-1.11, row_erg 0.97-1.06, farmer_carry 0.92-1.17, sandbag_lunges 0.93-1.10
 *   wall_balls 0.87-1.16, roxzone 0.77-1.31
 * Among stations the widest p10-p90 spread (mean over cells) is sled_push, then
 * sled_pull. Widest event-median range in any cell: sled_push 0.70-1.88, sled_pull 0.75-1.69, roxzone 0.54-2.04.
 * HYROX_S79_VENUE_SPREAD has every metric and cell. Event medians mix venue
 * effects with field strength; the data cannot separate the two. Station targets
 * derived from these tables inherit this venue variation.
 */

import type { AbilityBand, HyroxStation } from '@/types/triathlon';

export type HyroxResultsFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
export type HyroxResultsSex = 'female' | 'male' | 'mixed';
export type HyroxResultsMetric = 'total' | 'run_total' | 'work_total' | 'roxzone' | HyroxStation;
/** `[seconds, cumulativePercentile]`; see the file header for the convention. */
export type HyroxPercentilePoint = readonly [number, number];
export type HyroxPercentileTable = readonly HyroxPercentilePoint[];
export type HyroxGridName = 'fine' | 'five_point' | 'deciles' | 'quartiles_10_90' | 'quartiles';

export const HYROX_S79_LAST_REFRESH_DATE = '2026-10-13';
export const HYROX_S79_SEASONS = [7, 8, 9] as const;
/** Seasons behind the HYROX_S89_* current-judging tables. */
export const HYROX_S89_SEASONS = [8, 9] as const;
export const HYROX_S79_SOURCE = 'Kaggle: HYROX Race Results, Seasons 7-9 (Anonymised), Tanvi Jivani; built with pyrox-client (MIT) from public HYROX results';
export const HYROX_S79_ATTRIBUTION = 'HYROX results, seasons 7 to 9 (2024 to 2026), via the open pyrox project';
/** Season and calendar-year spans of the kept rows, read from the data. */
export const HYROX_S79_SEASONS_LABEL = 'seasons 7 to 9 (2024 to 2026)';
export const HYROX_S89_SEASONS_LABEL = 'seasons 8 and 9 (2025 to 2026)';
export const HYROX_S89_ATTRIBUTION = 'HYROX results, seasons 8 and 9 (2025 to 2026), via the open pyrox project';
export const HYROX_RESULTS_VIA = 'via the open pyrox project';

/** DKW cell-size rule. A grid is used only when n >= minN, where minN makes the
 *  95% simultaneous band half-width eps = sqrt(ln(2/0.05) / (2n)) at most half the
 *  grid's smallest percentile gap. Finest grid first. */
export const HYROX_S79_GRID_LADDER: ReadonlyArray<{ name: HyroxGridName; percentiles: readonly number[]; minN: number }> = [
  { name: 'fine', percentiles: [1, 2, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 98, 99], minN: 73778 },
  { name: 'five_point', percentiles: [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 99], minN: 4612 },
  { name: 'deciles', percentiles: [10, 20, 30, 40, 50, 60, 70, 80, 90], minN: 738 },
  { name: 'quartiles_10_90', percentiles: [10, 25, 50, 75, 90], minN: 328 },
  { name: 'quartiles', percentiles: [25, 50, 75], minN: 119 },
];
/** Significance level for every test in the ingest (DKW band, chance-match bound, sign test). */
export const HYROX_S79_DKW_ALPHA = 0.05;
/** Smallest publishable cell (coarsest grid's minN). */
export const HYROX_S79_MIN_CELL_N = 119;
/** Timing-consistency tolerance (seconds); see header rule 5. */
export const HYROX_S79_CONSISTENCY_TOLERANCE_SEC = 17;

/** Ingest report: rows dropped or routed by each hygiene rule, in order.
 *  aboveFenceInconsistent is the subset of the rule 5 drops that sat above the
 *  upper total fence; keptAboveFenceCorroborated is a subset of rowsKeptForTotal. */
export const HYROX_S79_INGEST_REPORT = {
  inputRows: 1159421,
  monthNonNull: 0,
  excludedDivisions: { relay: 7111, adaptive: 232, elite: 229, elite_doubles: 232 },
  droppedTotalMissing: 2284,
  droppedTotalMissingNull: 0,
  droppedTotalMissingZero: 2284,
  droppedTotalMissingByEvent: [{ season: 8, year: 2026, location: 'vienna', format: 'open_singles', rows: 2282, timedRowsSameEventAndFormat: 0, timedRowsSameEventOtherFormats: 3732 }, { season: 7, year: 2025, location: 'guadalajara', format: 'open_doubles', rows: 2, timedRowsSameEventAndFormat: 673, timedRowsSameEventOtherFormats: 946 }],
  droppedExactDuplicates: 1044,
  crossLabelGroups: 642,
  droppedCrossLabelAgeOnly: 54,
  droppedCrossLabelResolved: 520,
  droppedCrossLabelAmbiguous: 136,
  identicalTimingsKeptAsDistinct: 0,
  maxLog10ChanceMatchBound: -27.1,
  droppedTotalBelowFence: 33,
  aboveFenceRows: 757,
  droppedAboveFenceUncorroborated: 86,
  droppedAboveFenceOneSegment: 88,
  keptAboveFenceCorroborated: 571,
  aboveFenceInconsistent: 12,
  droppedInconsistent: 3068,
  droppedInconsistentUntimedRoxzone: 1358,
  totalOnlyMissingSplit: 14743,
  totalOnlySplitBelowFence: 7633,
  splitEligibleRoxzoneTimed: 1055444,
  splitEligibleRoxzoneUntimed: 65126,
  keptAboveFenceMaxTotalSec: 21735,
  droppedAboveFenceOneSegmentTotalRangeSec: [10109, 107488],
  rowsKeptForTotal: 1142946,
  rowsKeptForSplits: 1120570,
  rowsKeptForRoxzone: 1055444,
} as const;

/** Rule 3b sets resolved by the sign test: one label kept, its twin copies dropped. */
export const HYROX_S79_CROSS_LABEL_RESOLUTIONS: ReadonlyArray<{ season: number; year: number; location: string; keptFormat: HyroxResultsFormat; keptSex: HyroxResultsSex; droppedFormat: HyroxResultsFormat; droppedSex: HyroxResultsSex; copies: number; votesKept: number; votesDropped: number; abstained: number; signTestP: number }> = [
  { season: 8, year: 2026, location: 'mechelen', keptFormat: 'pro_singles', keptSex: 'female', droppedFormat: 'pro_doubles', droppedSex: 'female', copies: 253, votesKept: 225, votesDropped: 15, abstained: 13, signTestP: 2.99e-49 },
  { season: 8, year: 2026, location: 'mechelen', keptFormat: 'pro_singles', keptSex: 'male', droppedFormat: 'pro_doubles', droppedSex: 'male', copies: 267, votesKept: 249, votesDropped: 18, abstained: 0, signTestP: 3.76e-53 },
];

/** Total-time fences (seconds) per format x sex from rule 4: rows tested, dropped
 *  below, above the upper fence, and kept above it after corroboration, plus the
 *  largest-segment share fence used to corroborate. */
export const HYROX_S79_TOTAL_FENCES_SEC: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, { lo: number; hi: number; rowsTested: number; droppedBelow: number; aboveFence: number; keptAboveCorroborated: number; maxSegmentShare: number }>>> = {
  open_singles: { female: { lo: 2429, hi: 13964, rowsTested: 163113, droppedBelow: 6, aboveFence: 114, keptAboveCorroborated: 70, maxSegmentShare: 0.203 }, male: { lo: 2109, hi: 13488, rowsTested: 296162, droppedBelow: 9, aboveFence: 168, keptAboveCorroborated: 102, maxSegmentShare: 0.234 } },
  pro_singles: { female: { lo: 2227, hi: 12442, rowsTested: 25219, droppedBelow: 1, aboveFence: 35, keptAboveCorroborated: 19, maxSegmentShare: 0.203 }, male: { lo: 1996, hi: 12130, rowsTested: 55281, droppedBelow: 1, aboveFence: 42, keptAboveCorroborated: 27, maxSegmentShare: 0.23 } },
  open_doubles: { female: { lo: 2626, hi: 10786, rowsTested: 183175, droppedBelow: 5, aboveFence: 97, keptAboveCorroborated: 89, maxSegmentShare: 0.21 }, male: { lo: 2136, hi: 9981, rowsTested: 176149, droppedBelow: 3, aboveFence: 103, keptAboveCorroborated: 90, maxSegmentShare: 0.226 }, mixed: { lo: 2300, hi: 10916, rowsTested: 192055, droppedBelow: 8, aboveFence: 126, keptAboveCorroborated: 107, maxSegmentShare: 0.213 } },
  pro_doubles: { female: { lo: 2332, hi: 10007, rowsTested: 20816, droppedBelow: 0, aboveFence: 29, keptAboveCorroborated: 27, maxSegmentShare: 0.204 }, male: { lo: 2039, hi: 8788, rowsTested: 35570, droppedBelow: 0, aboveFence: 43, keptAboveCorroborated: 40, maxSegmentShare: 0.197 }, mixed: { lo: 2372, hi: 8655, rowsTested: 39, droppedBelow: 0, aboveFence: 0, keptAboveCorroborated: 0, maxSegmentShare: 0.228 } },
};

/** Station split lower fences (seconds) per published format x sex cell: the
 *  log-scale Tukey far-out lower fence of rule 6, below which a split is a timing
 *  slip (time credited to a neighbour). The floor a guided-session round must clear
 *  before it may write a benchmark. Suppressed cells are left out. */
export const HYROX_S79_STATION_LOWER_FENCES_SEC: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxStation, number>>>> = {
  open_singles: { female: { ski_erg: 209, sled_push: 54, sled_pull: 104, burpee_broad_jumps: 95, row_erg: 214, farmer_carry: 49, sandbag_lunges: 88, wall_balls: 87 }, male: { ski_erg: 187, sled_push: 54, sled_pull: 86, burpee_broad_jumps: 79, row_erg: 190, farmer_carry: 40, sandbag_lunges: 87, wall_balls: 86 } },
  pro_singles: { female: { ski_erg: 208, sled_push: 66, sled_pull: 97, burpee_broad_jumps: 83, row_erg: 212, farmer_carry: 39, sandbag_lunges: 90, wall_balls: 88 }, male: { ski_erg: 189, sled_push: 63, sled_pull: 78, burpee_broad_jumps: 65, row_erg: 189, farmer_carry: 31, sandbag_lunges: 84, wall_balls: 89 } },
  open_doubles: { female: { ski_erg: 199, sled_push: 46, sled_pull: 97, burpee_broad_jumps: 77, row_erg: 215, farmer_carry: 55, sandbag_lunges: 82, wall_balls: 114 }, male: { ski_erg: 172, sled_push: 43, sled_pull: 69, burpee_broad_jumps: 59, row_erg: 184, farmer_carry: 45, sandbag_lunges: 76, wall_balls: 116 }, mixed: { ski_erg: 180, sled_push: 46, sled_pull: 81, burpee_broad_jumps: 62, row_erg: 186, farmer_carry: 50, sandbag_lunges: 78, wall_balls: 97 } },
  pro_doubles: { female: { ski_erg: 193, sled_push: 54, sled_pull: 98, burpee_broad_jumps: 71, row_erg: 203, farmer_carry: 59, sandbag_lunges: 84, wall_balls: 107 }, male: { ski_erg: 169, sled_push: 47, sled_pull: 84, burpee_broad_jumps: 54, row_erg: 180, farmer_carry: 52, sandbag_lunges: 77, wall_balls: 113 } },
};

/** Finishers behind each pooled S7-S9 table (format x sex x metric). */
export const HYROX_S79_FINISHER_COUNTS: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, number>>>> = {
  open_singles: {
    female: { total: 162792, run_total: 159886, work_total: 159886, roxzone: 148048, ski_erg: 159886, sled_push: 159886, sled_pull: 159886, burpee_broad_jumps: 159886, row_erg: 159886, farmer_carry: 159886, sandbag_lunges: 159886, wall_balls: 159886 },
    male: { total: 295627, run_total: 290389, work_total: 290389, roxzone: 274934, ski_erg: 290389, sled_push: 290389, sled_pull: 290389, burpee_broad_jumps: 290389, row_erg: 290389, farmer_carry: 290389, sandbag_lunges: 290389, wall_balls: 290389 },
  },
  pro_singles: {
    female: { total: 25178, run_total: 24645, work_total: 24645, roxzone: 23201, ski_erg: 24645, sled_push: 24645, sled_pull: 24645, burpee_broad_jumps: 24645, row_erg: 24645, farmer_carry: 24645, sandbag_lunges: 24645, wall_balls: 24645 },
    male: { total: 55200, run_total: 54358, work_total: 54358, roxzone: 51246, ski_erg: 54358, sled_push: 54358, sled_pull: 54358, burpee_broad_jumps: 54358, row_erg: 54358, farmer_carry: 54358, sandbag_lunges: 54358, wall_balls: 54358 },
  },
  open_doubles: {
    female: { total: 182049, run_total: 177975, work_total: 177975, roxzone: 166963, ski_erg: 177975, sled_push: 177975, sled_pull: 177975, burpee_broad_jumps: 177975, row_erg: 177975, farmer_carry: 177975, sandbag_lunges: 177975, wall_balls: 177975 },
    male: { total: 175038, run_total: 171838, work_total: 171838, roxzone: 160226, ski_erg: 171838, sled_push: 171838, sled_pull: 171838, burpee_broad_jumps: 171838, row_erg: 171838, farmer_carry: 171838, sandbag_lunges: 171838, wall_balls: 171838 },
    mixed: { total: 190881, run_total: 186323, work_total: 186323, roxzone: 177826, ski_erg: 186323, sled_push: 186323, sled_pull: 186323, burpee_broad_jumps: 186323, row_erg: 186323, farmer_carry: 186323, sandbag_lunges: 186323, wall_balls: 186323 },
  },
  pro_doubles: {
    female: { total: 20748, run_total: 20299, work_total: 20299, roxzone: 19456, ski_erg: 20299, sled_push: 20299, sled_pull: 20299, burpee_broad_jumps: 20299, row_erg: 20299, farmer_carry: 20299, sandbag_lunges: 20299, wall_balls: 20299 },
    male: { total: 35394, run_total: 34819, work_total: 34819, roxzone: 33508, ski_erg: 34819, sled_push: 34819, sled_pull: 34819, burpee_broad_jumps: 34819, row_erg: 34819, farmer_carry: 34819, sandbag_lunges: 34819, wall_balls: 34819 },
  },
};

/** Pooled S7-S9 format x sex cells withheld because a metric falls below
 *  HYROX_S79_MIN_CELL_N. pro_doubles mixed is also not a rulebook category. */
export const HYROX_S79_SUPPRESSED_CELLS: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; n: number; nSplits: number; nRoxzone: number }> = [
  { format: 'pro_doubles', sex: 'mixed', n: 39, nSplits: 38, nRoxzone: 36 },
];

/** Pooled S7-S9 percentile tables per format x sex x metric. */
export const HYROX_S79_PERCENTILES: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, HyroxPercentileTable>>>> = {
  open_singles: {
    female: {
      total: [[4119, 1], [4250, 2], [4478, 5], [4700, 10], [4866, 15], [5010, 20], [5139, 25], [5261, 30], [5378, 35], [5504, 40], [5629, 45], [5757, 50], [5892, 55], [6041, 60], [6206, 65], [6387, 70], [6596, 75], [6848, 80], [7168, 85], [7631, 90], [8422, 95], [9458, 98], [10265, 99]],
      run_total: [[1958, 1], [2037, 2], [2164, 5], [2281, 10], [2367, 15], [2440, 20], [2506, 25], [2568, 30], [2628, 35], [2685, 40], [2744, 45], [2804, 50], [2868, 55], [2936, 60], [3010, 65], [3096, 70], [3193, 75], [3308, 80], [3462, 85], [3690, 90], [4094, 95], [4610, 98], [4998, 99]],
      work_total: [[1713, 1], [1771, 2], [1872, 5], [1972, 10], [2046, 15], [2109, 20], [2168, 25], [2224, 30], [2279, 35], [2335, 40], [2393, 45], [2454, 50], [2518, 55], [2585, 60], [2664, 65], [2748, 70], [2846, 75], [2967, 80], [3120, 85], [3339, 90], [3721, 95], [4264, 98], [4696, 99]],
      roxzone: [[247, 1], [266, 2], [297, 5], [329, 10], [353, 15], [373, 20], [392, 25], [410, 30], [427, 35], [445, 40], [463, 45], [482, 50], [502, 55], [524, 60], [548, 65], [574, 70], [604, 75], [642, 80], [689, 85], [755, 90], [866, 95], [1009, 98], [1111, 99]],
      ski_erg: [[269, 1], [273, 2], [280, 5], [287, 10], [292, 15], [296, 20], [299, 25], [303, 30], [306, 35], [309, 40], [313, 45], [316, 50], [319, 55], [323, 60], [327, 65], [332, 70], [337, 75], [342, 80], [350, 85], [360, 90], [376, 95], [398, 98], [415, 99]],
      sled_push: [[102, 1], [108, 2], [118, 5], [128, 10], [136, 15], [142, 20], [147, 25], [152, 30], [157, 35], [162, 40], [167, 45], [172, 50], [178, 55], [184, 60], [190, 65], [197, 70], [205, 75], [215, 80], [227, 85], [245, 90], [276, 95], [325, 98], [372, 99]],
      sled_pull: [[213, 1], [224, 2], [242, 5], [260, 10], [273, 15], [285, 20], [295, 25], [305, 30], [316, 35], [326, 40], [336, 45], [347, 50], [358, 55], [371, 60], [384, 65], [399, 70], [417, 75], [438, 80], [466, 85], [504, 90], [571, 95], [661, 98], [737, 99]],
      burpee_broad_jumps: [[216, 1], [232, 2], [258, 5], [283, 10], [302, 15], [318, 20], [333, 25], [347, 30], [361, 35], [375, 40], [390, 45], [405, 50], [421, 55], [438, 60], [457, 65], [479, 70], [505, 75], [536, 80], [575, 85], [631, 90], [733, 95], [881, 98], [1004, 99]],
      row_erg: [[280, 1], [285, 2], [292, 5], [299, 10], [304, 15], [308, 20], [312, 25], [316, 30], [320, 35], [323, 40], [327, 45], [331, 50], [335, 55], [339, 60], [343, 65], [348, 70], [354, 75], [361, 80], [370, 85], [382, 90], [402, 95], [431, 98], [454, 99]],
      farmer_carry: [[91, 1], [96, 2], [103, 5], [110, 10], [114, 15], [118, 20], [121, 25], [125, 30], [128, 35], [131, 40], [134, 45], [138, 50], [142, 55], [147, 60], [152, 65], [158, 70], [164, 75], [172, 80], [183, 85], [197, 90], [223, 95], [256, 98], [285, 99]],
      sandbag_lunges: [[180, 1], [193, 2], [212, 5], [230, 10], [243, 15], [254, 20], [264, 25], [274, 30], [283, 35], [293, 40], [302, 45], [312, 50], [323, 55], [335, 60], [349, 65], [363, 70], [381, 75], [402, 80], [430, 85], [470, 90], [545, 95], [662, 98], [769, 99]],
      wall_balls: [[217, 1], [232, 2], [257, 5], [281, 10], [299, 15], [314, 20], [329, 25], [343, 30], [357, 35], [371, 40], [386, 45], [402, 50], [419, 55], [438, 60], [459, 65], [484, 70], [513, 75], [548, 80], [595, 85], [663, 90], [792, 95], [984, 98], [1144, 99]],
    },
    male: {
      total: [[3694, 1], [3815, 2], [4026, 5], [4238, 10], [4403, 15], [4541, 20], [4670, 25], [4788, 30], [4911, 35], [5031, 40], [5152, 45], [5277, 50], [5403, 55], [5550, 60], [5705, 65], [5885, 70], [6088, 75], [6334, 80], [6648, 85], [7078, 90], [7847, 95], [8877, 98], [9686, 99]],
      run_total: [[1744, 1], [1813, 2], [1918, 5], [2024, 10], [2103, 15], [2170, 20], [2231, 25], [2289, 30], [2344, 35], [2399, 40], [2454, 45], [2512, 50], [2573, 55], [2637, 60], [2708, 65], [2787, 70], [2879, 75], [2991, 80], [3140, 85], [3353, 90], [3745, 95], [4283, 98], [4687, 99]],
      work_total: [[1560, 1], [1617, 2], [1714, 5], [1813, 10], [1886, 15], [1951, 20], [2009, 25], [2065, 30], [2120, 35], [2175, 40], [2232, 45], [2291, 50], [2353, 55], [2419, 60], [2492, 65], [2575, 70], [2671, 75], [2786, 80], [2933, 85], [3136, 90], [3492, 95], [3990, 98], [4395, 99]],
      roxzone: [[221, 1], [238, 2], [267, 5], [297, 10], [320, 15], [339, 20], [358, 25], [375, 30], [393, 35], [410, 40], [429, 45], [448, 50], [469, 55], [492, 60], [517, 65], [545, 70], [578, 75], [617, 80], [666, 85], [735, 90], [847, 95], [996, 98], [1105, 99]],
      ski_erg: [[235, 1], [239, 2], [244, 5], [250, 10], [254, 15], [257, 20], [260, 25], [263, 30], [265, 35], [268, 40], [271, 45], [273, 50], [276, 55], [279, 60], [282, 65], [286, 70], [290, 75], [295, 80], [301, 85], [309, 90], [322, 95], [339, 98], [352, 99]],
      sled_push: [[105, 1], [112, 2], [124, 5], [134, 10], [142, 15], [149, 20], [155, 25], [160, 30], [166, 35], [171, 40], [177, 45], [182, 50], [188, 55], [195, 60], [202, 65], [210, 70], [220, 75], [232, 80], [247, 85], [269, 90], [310, 95], [377, 98], [439, 99]],
      sled_pull: [[178, 1], [188, 2], [204, 5], [221, 10], [232, 15], [243, 20], [252, 25], [261, 30], [270, 35], [279, 40], [289, 45], [298, 50], [309, 55], [320, 60], [332, 65], [345, 70], [361, 75], [380, 80], [405, 85], [439, 90], [499, 95], [576, 98], [638, 99]],
      burpee_broad_jumps: [[174, 1], [188, 2], [210, 5], [232, 10], [248, 15], [263, 20], [276, 25], [288, 30], [300, 35], [312, 40], [325, 45], [337, 50], [351, 55], [365, 60], [381, 65], [399, 70], [419, 75], [444, 80], [475, 85], [519, 90], [597, 95], [703, 98], [795, 99]],
      row_erg: [[249, 1], [253, 2], [260, 5], [265, 10], [270, 15], [274, 20], [277, 25], [280, 30], [283, 35], [287, 40], [290, 45], [293, 50], [297, 55], [300, 60], [304, 65], [309, 70], [314, 75], [321, 80], [328, 85], [339, 90], [357, 95], [382, 98], [404, 99]],
      farmer_carry: [[81, 1], [86, 2], [92, 5], [99, 10], [104, 15], [108, 20], [112, 25], [116, 30], [120, 35], [123, 40], [127, 45], [131, 50], [135, 55], [140, 60], [145, 65], [151, 70], [158, 75], [167, 80], [177, 85], [192, 90], [218, 95], [251, 98], [282, 99]],
      sandbag_lunges: [[180, 1], [194, 2], [213, 5], [232, 10], [246, 15], [258, 20], [269, 25], [279, 30], [289, 35], [299, 40], [309, 45], [320, 50], [331, 55], [343, 60], [357, 65], [372, 70], [390, 75], [412, 80], [441, 85], [483, 90], [561, 95], [682, 98], [792, 99]],
      wall_balls: [[226, 1], [240, 2], [265, 5], [290, 10], [309, 15], [326, 20], [342, 25], [357, 30], [372, 35], [388, 40], [405, 45], [422, 50], [441, 55], [462, 60], [485, 65], [511, 70], [542, 75], [580, 80], [630, 85], [704, 90], [836, 95], [1028, 98], [1192, 99]],
    },
  },
  pro_singles: {
    female: {
      total: [[3773, 1], [4067, 5], [4252, 10], [4401, 15], [4529, 20], [4654, 25], [4775, 30], [4886, 35], [4996, 40], [5107, 45], [5224, 50], [5342, 55], [5473, 60], [5614, 65], [5772, 70], [5950, 75], [6172, 80], [6476, 85], [6876, 90], [7600, 95], [9450, 99]],
      run_total: [[1743, 1], [1904, 5], [1995, 10], [2062, 15], [2123, 20], [2177, 25], [2227, 30], [2275, 35], [2327, 40], [2377, 45], [2429, 50], [2483, 55], [2539, 60], [2598, 65], [2669, 70], [2747, 75], [2842, 80], [2966, 85], [3139, 90], [3455, 95], [4344, 99]],
      work_total: [[1651, 1], [1795, 5], [1889, 10], [1965, 15], [2030, 20], [2089, 25], [2147, 30], [2203, 35], [2260, 40], [2315, 45], [2372, 50], [2434, 55], [2501, 60], [2576, 65], [2655, 70], [2744, 75], [2861, 80], [3009, 85], [3215, 90], [3587, 95], [4615, 99]],
      roxzone: [[214, 1], [255, 5], [278, 10], [296, 15], [311, 20], [326, 25], [340, 30], [355, 35], [370, 40], [385, 45], [400, 50], [417, 55], [435, 60], [456, 65], [480, 70], [507, 75], [542, 80], [587, 85], [652, 90], [757, 95], [990, 99]],
      ski_erg: [[255, 1], [264, 5], [270, 10], [274, 15], [277, 20], [280, 25], [283, 30], [285, 35], [288, 40], [291, 45], [293, 50], [296, 55], [299, 60], [302, 65], [305, 70], [309, 75], [314, 80], [319, 85], [327, 90], [340, 95], [369, 99]],
      sled_push: [[139, 1], [159, 5], [173, 10], [182, 15], [191, 20], [198, 25], [205, 30], [212, 35], [219, 40], [226, 45], [234, 50], [242, 55], [251, 60], [261, 65], [272, 70], [285, 75], [302, 80], [321, 85], [350, 90], [405, 95], [547, 99]],
      sled_pull: [[215, 1], [241, 5], [259, 10], [272, 15], [284, 20], [296, 25], [307, 30], [317, 35], [328, 40], [339, 45], [351, 50], [364, 55], [377, 60], [391, 65], [408, 70], [429, 75], [453, 80], [485, 85], [527, 90], [602, 95], [802, 99]],
      burpee_broad_jumps: [[180, 1], [208, 5], [225, 10], [238, 15], [249, 20], [260, 25], [271, 30], [281, 35], [291, 40], [301, 45], [312, 50], [323, 55], [335, 60], [349, 65], [364, 70], [381, 75], [401, 80], [427, 85], [466, 90], [536, 95], [715, 99]],
      row_erg: [[265, 1], [275, 5], [281, 10], [285, 15], [289, 20], [292, 25], [295, 30], [298, 35], [301, 40], [304, 45], [307, 50], [310, 55], [313, 60], [317, 65], [321, 70], [325, 75], [331, 80], [338, 85], [348, 90], [365, 95], [410, 99]],
      farmer_carry: [[94, 1], [105, 5], [112, 10], [118, 15], [124, 20], [129, 25], [134, 30], [140, 35], [145, 40], [151, 45], [156, 50], [162, 55], [169, 60], [176, 65], [184, 70], [193, 75], [204, 80], [218, 85], [237, 90], [271, 95], [362, 99]],
      sandbag_lunges: [[182, 1], [210, 5], [227, 10], [240, 15], [252, 20], [261, 25], [271, 30], [281, 35], [291, 40], [300, 45], [310, 50], [320, 55], [331, 60], [343, 65], [356, 70], [372, 75], [391, 80], [416, 85], [454, 90], [523, 95], [741, 99]],
      wall_balls: [[214, 1], [247, 5], [268, 10], [285, 15], [298, 20], [312, 25], [325, 30], [337, 35], [350, 40], [364, 45], [378, 50], [394, 55], [410, 60], [429, 65], [450, 70], [475, 75], [505, 80], [547, 85], [610, 90], [726, 95], [1087, 99]],
    },
    male: {
      total: [[3475, 1], [3752, 5], [3942, 10], [4082, 15], [4201, 20], [4324, 25], [4436, 30], [4546, 35], [4656, 40], [4764, 45], [4876, 50], [4993, 55], [5119, 60], [5259, 65], [5413, 70], [5595, 75], [5811, 80], [6087, 85], [6489, 90], [7146, 95], [8961, 99]],
      run_total: [[1607, 1], [1761, 5], [1839, 10], [1897, 15], [1948, 20], [1996, 25], [2042, 30], [2088, 35], [2133, 40], [2178, 45], [2226, 50], [2276, 55], [2328, 60], [2386, 65], [2451, 70], [2521, 75], [2609, 80], [2721, 85], [2889, 90], [3207, 95], [3999, 99]],
      work_total: [[1509, 1], [1660, 5], [1760, 10], [1835, 15], [1900, 20], [1963, 25], [2022, 30], [2077, 35], [2133, 40], [2191, 45], [2251, 50], [2313, 55], [2377, 60], [2451, 65], [2533, 70], [2629, 75], [2741, 80], [2886, 85], [3086, 90], [3454, 95], [4397, 99]],
      roxzone: [[200, 1], [237, 5], [260, 10], [278, 15], [293, 20], [307, 25], [321, 30], [335, 35], [349, 40], [363, 45], [379, 50], [396, 55], [414, 60], [435, 65], [458, 70], [485, 75], [518, 80], [561, 85], [621, 90], [724, 95], [954, 99]],
      ski_erg: [[226, 1], [234, 5], [238, 10], [241, 15], [244, 20], [247, 25], [249, 30], [251, 35], [253, 40], [255, 45], [257, 50], [259, 55], [261, 60], [264, 65], [267, 70], [270, 75], [273, 80], [278, 85], [284, 90], [294, 95], [319, 99]],
      sled_push: [[133, 1], [153, 5], [165, 10], [174, 15], [182, 20], [189, 25], [196, 30], [202, 35], [209, 40], [216, 45], [224, 50], [232, 55], [240, 60], [249, 65], [260, 70], [273, 75], [288, 80], [308, 85], [338, 90], [395, 95], [557, 99]],
      sled_pull: [[199, 1], [226, 5], [245, 10], [259, 15], [272, 20], [284, 25], [296, 30], [308, 35], [320, 40], [333, 45], [346, 50], [361, 55], [376, 60], [393, 65], [413, 70], [436, 75], [465, 80], [501, 85], [554, 90], [647, 95], [899, 99]],
      burpee_broad_jumps: [[147, 1], [170, 5], [186, 10], [198, 15], [209, 20], [219, 25], [228, 30], [237, 35], [246, 40], [256, 45], [265, 50], [275, 55], [286, 60], [298, 65], [312, 70], [326, 75], [344, 80], [367, 85], [398, 90], [452, 95], [595, 99]],
      row_erg: [[237, 1], [246, 5], [252, 10], [256, 15], [259, 20], [262, 25], [264, 30], [267, 35], [270, 40], [272, 45], [275, 50], [278, 55], [281, 60], [284, 65], [287, 70], [292, 75], [296, 80], [303, 85], [311, 90], [327, 95], [365, 99]],
      farmer_carry: [[81, 1], [90, 5], [96, 10], [100, 15], [104, 20], [108, 25], [112, 30], [117, 35], [121, 40], [126, 45], [131, 50], [137, 55], [142, 60], [149, 65], [156, 70], [164, 75], [173, 80], [185, 85], [203, 90], [233, 95], [305, 99]],
      sandbag_lunges: [[171, 1], [200, 5], [219, 10], [233, 15], [244, 20], [254, 25], [264, 30], [274, 35], [283, 40], [293, 45], [303, 50], [314, 55], [325, 60], [337, 65], [350, 70], [367, 75], [386, 80], [411, 85], [450, 90], [522, 95], [728, 99]],
      wall_balls: [[222, 1], [258, 5], [283, 10], [301, 15], [318, 20], [334, 25], [348, 30], [362, 35], [377, 40], [392, 45], [408, 50], [425, 55], [444, 60], [465, 65], [489, 70], [517, 75], [553, 80], [597, 85], [665, 90], [788, 95], [1140, 99]],
    },
  },
  open_doubles: {
    female: {
      total: [[3956, 1], [4072, 2], [4263, 5], [4454, 10], [4592, 15], [4708, 20], [4811, 25], [4906, 30], [5000, 35], [5092, 40], [5185, 45], [5281, 50], [5378, 55], [5487, 60], [5604, 65], [5735, 70], [5885, 75], [6060, 80], [6287, 85], [6595, 90], [7109, 95], [7799, 98], [8337, 99]],
      run_total: [[2070, 1], [2159, 2], [2297, 5], [2429, 10], [2522, 15], [2597, 20], [2664, 25], [2726, 30], [2785, 35], [2842, 40], [2899, 45], [2957, 50], [3016, 55], [3080, 60], [3150, 65], [3228, 70], [3319, 75], [3428, 80], [3569, 85], [3766, 90], [4115, 95], [4573, 98], [4919, 99]],
      work_total: [[1422, 1], [1458, 2], [1517, 5], [1573, 10], [1615, 15], [1651, 20], [1683, 25], [1714, 30], [1744, 35], [1774, 40], [1804, 45], [1835, 50], [1868, 55], [1903, 60], [1941, 65], [1983, 70], [2031, 75], [2088, 80], [2160, 85], [2260, 90], [2437, 95], [2680, 98], [2869, 99]],
      roxzone: [[246, 1], [264, 2], [296, 5], [328, 10], [351, 15], [370, 20], [388, 25], [405, 30], [421, 35], [438, 40], [455, 45], [473, 50], [492, 55], [512, 60], [534, 65], [559, 70], [588, 75], [623, 80], [668, 85], [729, 90], [831, 95], [964, 98], [1065, 99]],
      ski_erg: [[247, 1], [251, 2], [257, 5], [263, 10], [267, 15], [271, 20], [274, 25], [277, 30], [280, 35], [283, 40], [286, 45], [288, 50], [291, 55], [294, 60], [297, 65], [301, 70], [305, 75], [310, 80], [315, 85], [323, 90], [335, 95], [351, 98], [362, 99]],
      sled_push: [[75, 1], [78, 2], [83, 5], [88, 10], [92, 15], [95, 20], [98, 25], [101, 30], [103, 35], [106, 40], [108, 45], [111, 50], [113, 55], [116, 60], [119, 65], [123, 70], [127, 75], [131, 80], [137, 85], [145, 90], [159, 95], [179, 98], [198, 99]],
      sled_pull: [[166, 1], [174, 2], [187, 5], [199, 10], [208, 15], [215, 20], [221, 25], [228, 30], [234, 35], [240, 40], [246, 45], [252, 50], [259, 55], [266, 60], [273, 65], [282, 70], [291, 75], [303, 80], [317, 85], [337, 90], [371, 95], [419, 98], [459, 99]],
      burpee_broad_jumps: [[152, 1], [162, 2], [177, 5], [191, 10], [202, 15], [210, 20], [219, 25], [227, 30], [234, 35], [242, 40], [249, 45], [257, 50], [266, 55], [275, 60], [284, 65], [295, 70], [308, 75], [323, 80], [343, 85], [370, 90], [418, 95], [486, 98], [540, 99]],
      row_erg: [[266, 1], [270, 2], [278, 5], [284, 10], [289, 15], [293, 20], [297, 25], [300, 30], [303, 35], [306, 40], [309, 45], [312, 50], [316, 55], [319, 60], [323, 65], [327, 70], [331, 75], [337, 80], [343, 85], [352, 90], [366, 95], [386, 98], [401, 99]],
      farmer_carry: [[80, 1], [83, 2], [88, 5], [93, 10], [96, 15], [99, 20], [101, 25], [104, 30], [106, 35], [108, 40], [110, 45], [112, 50], [114, 55], [117, 60], [119, 65], [122, 70], [124, 75], [127, 80], [131, 85], [136, 90], [144, 95], [157, 98], [170, 99]],
      sandbag_lunges: [[145, 1], [153, 2], [165, 5], [176, 10], [184, 15], [191, 20], [197, 25], [203, 30], [209, 35], [215, 40], [221, 45], [227, 50], [233, 55], [239, 60], [247, 65], [255, 70], [264, 75], [275, 80], [289, 85], [309, 90], [344, 95], [393, 98], [433, 99]],
      wall_balls: [[191, 1], [200, 2], [210, 5], [219, 10], [225, 15], [231, 20], [236, 25], [241, 30], [246, 35], [251, 40], [256, 45], [262, 50], [268, 55], [274, 60], [282, 65], [291, 70], [301, 75], [315, 80], [332, 85], [359, 90], [411, 95], [490, 98], [559, 99]],
    },
    male: {
      total: [[3384, 1], [3480, 2], [3636, 5], [3806, 10], [3934, 15], [4040, 20], [4136, 25], [4225, 30], [4313, 35], [4401, 40], [4489, 45], [4582, 50], [4676, 55], [4777, 60], [4887, 65], [5012, 70], [5153, 75], [5319, 80], [5535, 85], [5836, 90], [6356, 95], [7030, 98], [7595, 99]],
      run_total: [[1752, 1], [1824, 2], [1936, 5], [2047, 10], [2131, 15], [2201, 20], [2264, 25], [2322, 30], [2378, 35], [2434, 40], [2489, 45], [2545, 50], [2603, 55], [2667, 60], [2733, 65], [2807, 70], [2890, 75], [2994, 80], [3124, 85], [3315, 90], [3661, 95], [4141, 98], [4516, 99]],
      work_total: [[1252, 1], [1282, 2], [1334, 5], [1384, 10], [1420, 15], [1451, 20], [1480, 25], [1506, 30], [1532, 35], [1558, 40], [1584, 45], [1612, 50], [1641, 55], [1671, 60], [1705, 65], [1742, 70], [1785, 75], [1837, 80], [1903, 85], [1994, 90], [2151, 95], [2365, 98], [2539, 99]],
      roxzone: [[206, 1], [223, 2], [251, 5], [279, 10], [299, 15], [316, 20], [332, 25], [347, 30], [362, 35], [377, 40], [393, 45], [409, 50], [427, 55], [447, 60], [469, 65], [494, 70], [523, 75], [559, 80], [604, 85], [665, 90], [762, 95], [879, 98], [971, 99]],
      ski_erg: [[211, 1], [215, 2], [220, 5], [224, 10], [228, 15], [231, 20], [233, 25], [235, 30], [238, 35], [240, 40], [242, 45], [244, 50], [247, 55], [249, 60], [252, 65], [254, 70], [258, 75], [262, 80], [266, 85], [272, 90], [282, 95], [296, 98], [306, 99]],
      sled_push: [[73, 1], [76, 2], [82, 5], [87, 10], [91, 15], [94, 20], [97, 25], [100, 30], [102, 35], [105, 40], [107, 45], [110, 50], [113, 55], [116, 60], [119, 65], [123, 70], [127, 75], [132, 80], [139, 85], [148, 90], [166, 95], [192, 98], [221, 99]],
      sled_pull: [[125, 1], [131, 2], [143, 5], [153, 10], [161, 15], [167, 20], [173, 25], [179, 30], [184, 35], [190, 40], [195, 45], [200, 50], [206, 55], [212, 60], [219, 65], [226, 70], [235, 75], [244, 80], [257, 85], [274, 90], [303, 95], [343, 98], [379, 99]],
      burpee_broad_jumps: [[113, 1], [120, 2], [131, 5], [143, 10], [151, 15], [158, 20], [164, 25], [170, 30], [175, 35], [181, 40], [187, 45], [193, 50], [199, 55], [206, 60], [213, 65], [221, 70], [230, 75], [241, 80], [255, 85], [273, 90], [306, 95], [352, 98], [390, 99]],
      row_erg: [[232, 1], [236, 2], [241, 5], [247, 10], [251, 15], [255, 20], [258, 25], [261, 30], [263, 35], [266, 40], [269, 45], [272, 50], [275, 55], [278, 60], [281, 65], [285, 70], [289, 75], [294, 80], [301, 85], [309, 90], [323, 95], [342, 98], [357, 99]],
      farmer_carry: [[70, 1], [73, 2], [78, 5], [82, 10], [85, 15], [87, 20], [90, 25], [92, 30], [94, 35], [96, 40], [98, 45], [100, 50], [102, 55], [104, 60], [107, 65], [110, 70], [113, 75], [116, 80], [120, 85], [126, 90], [134, 95], [147, 98], [163, 99]],
      sandbag_lunges: [[136, 1], [144, 2], [156, 5], [167, 10], [174, 15], [181, 20], [187, 25], [193, 30], [198, 35], [204, 40], [210, 45], [215, 50], [221, 55], [228, 60], [235, 65], [243, 70], [252, 75], [263, 80], [277, 85], [297, 90], [332, 95], [382, 98], [423, 99]],
      wall_balls: [[202, 1], [207, 2], [214, 5], [222, 10], [228, 15], [233, 20], [238, 25], [243, 30], [247, 35], [252, 40], [258, 45], [263, 50], [269, 55], [276, 60], [283, 65], [292, 70], [303, 75], [316, 80], [334, 85], [361, 90], [412, 95], [488, 98], [553, 99]],
    },
    mixed: {
      total: [[3546, 1], [3664, 2], [3886, 5], [4098, 10], [4246, 15], [4372, 20], [4482, 25], [4584, 30], [4683, 35], [4777, 40], [4876, 45], [4975, 50], [5079, 55], [5187, 60], [5308, 65], [5440, 70], [5599, 75], [5788, 80], [6023, 85], [6359, 90], [6920, 95], [7671, 98], [8274, 99]],
      run_total: [[1851, 1], [1930, 2], [2063, 5], [2197, 10], [2290, 15], [2368, 20], [2439, 25], [2503, 30], [2563, 35], [2623, 40], [2681, 45], [2740, 50], [2802, 55], [2867, 60], [2937, 65], [3013, 70], [3101, 75], [3210, 80], [3349, 85], [3549, 90], [3904, 95], [4381, 98], [4745, 99]],
      work_total: [[1324, 1], [1362, 2], [1425, 5], [1489, 10], [1537, 15], [1576, 20], [1611, 25], [1645, 30], [1677, 35], [1709, 40], [1743, 45], [1777, 50], [1813, 55], [1852, 60], [1894, 65], [1941, 70], [1995, 75], [2061, 80], [2144, 85], [2265, 90], [2474, 95], [2768, 98], [3011, 99]],
      roxzone: [[219, 1], [237, 2], [266, 5], [297, 10], [319, 15], [338, 20], [355, 25], [371, 30], [387, 35], [403, 40], [420, 45], [437, 50], [456, 55], [476, 60], [498, 65], [522, 70], [551, 75], [586, 80], [632, 85], [697, 90], [801, 95], [930, 98], [1020, 99]],
      ski_erg: [[223, 1], [227, 2], [233, 5], [238, 10], [242, 15], [245, 20], [248, 25], [250, 30], [253, 35], [256, 40], [258, 45], [260, 50], [263, 55], [266, 60], [269, 65], [272, 70], [276, 75], [280, 80], [285, 85], [292, 90], [304, 95], [320, 98], [331, 99]],
      sled_push: [[84, 1], [88, 2], [95, 5], [101, 10], [106, 15], [110, 20], [114, 25], [117, 30], [121, 35], [124, 40], [127, 45], [131, 50], [135, 55], [139, 60], [143, 65], [148, 70], [154, 75], [162, 80], [171, 85], [185, 90], [210, 95], [249, 98], [284, 99]],
      sled_pull: [[148, 1], [156, 2], [169, 5], [182, 10], [191, 15], [199, 20], [206, 25], [213, 30], [219, 35], [225, 40], [232, 45], [239, 50], [246, 55], [253, 60], [261, 65], [270, 70], [281, 75], [293, 80], [309, 85], [331, 90], [369, 95], [420, 98], [464, 99]],
      burpee_broad_jumps: [[123, 1], [131, 2], [144, 5], [156, 10], [166, 15], [174, 20], [181, 25], [188, 30], [195, 35], [201, 40], [208, 45], [215, 50], [222, 55], [230, 60], [239, 65], [248, 70], [259, 75], [272, 80], [288, 85], [311, 90], [350, 95], [407, 98], [453, 99]],
      row_erg: [[240, 1], [245, 2], [252, 5], [259, 10], [264, 15], [268, 20], [271, 25], [275, 30], [278, 35], [281, 40], [284, 45], [287, 50], [291, 55], [294, 60], [298, 65], [302, 70], [307, 75], [312, 80], [318, 85], [327, 90], [342, 95], [362, 98], [378, 99]],
      farmer_carry: [[76, 1], [79, 2], [85, 5], [89, 10], [93, 15], [96, 20], [98, 25], [101, 30], [103, 35], [105, 40], [107, 45], [110, 50], [112, 55], [114, 60], [117, 65], [120, 70], [123, 75], [126, 80], [131, 85], [137, 90], [146, 95], [161, 98], [178, 99]],
      sandbag_lunges: [[145, 1], [154, 2], [169, 5], [182, 10], [192, 15], [200, 20], [208, 25], [215, 30], [222, 35], [229, 40], [236, 45], [243, 50], [250, 55], [258, 60], [266, 65], [276, 70], [287, 75], [301, 80], [318, 85], [343, 90], [388, 95], [451, 98], [506, 99]],
      wall_balls: [[202, 1], [207, 2], [215, 5], [223, 10], [230, 15], [236, 20], [242, 25], [248, 30], [254, 35], [260, 40], [267, 45], [274, 50], [282, 55], [291, 60], [301, 65], [313, 70], [328, 75], [347, 80], [373, 85], [411, 90], [484, 95], [597, 98], [693, 99]],
    },
  },
  pro_doubles: {
    female: {
      total: [[3561, 1], [3839, 5], [4014, 10], [4146, 15], [4251, 20], [4353, 25], [4444, 30], [4531, 35], [4619, 40], [4706, 45], [4797, 50], [4890, 55], [4992, 60], [5101, 65], [5225, 70], [5359, 75], [5526, 80], [5737, 85], [6062, 90], [6621, 95], [7970, 99]],
      run_total: [[1788, 1], [1978, 5], [2091, 10], [2169, 15], [2238, 20], [2299, 25], [2357, 30], [2410, 35], [2464, 40], [2521, 45], [2576, 50], [2631, 55], [2690, 60], [2749, 65], [2816, 70], [2893, 75], [2986, 80], [3109, 85], [3291, 90], [3625, 95], [4494, 99]],
      work_total: [[1412, 1], [1496, 5], [1549, 10], [1590, 15], [1626, 20], [1658, 25], [1689, 30], [1718, 35], [1749, 40], [1779, 45], [1810, 50], [1843, 55], [1879, 60], [1917, 65], [1962, 70], [2011, 75], [2072, 80], [2150, 85], [2269, 90], [2478, 95], [2992, 99]],
      roxzone: [[206, 1], [247, 5], [273, 10], [292, 15], [308, 20], [322, 25], [336, 30], [351, 35], [365, 40], [381, 45], [397, 50], [414, 55], [433, 60], [452, 65], [475, 70], [502, 75], [534, 80], [578, 85], [638, 90], [733, 95], [947, 99]],
      ski_erg: [[235, 1], [244, 5], [249, 10], [252, 15], [255, 20], [258, 25], [261, 30], [263, 35], [265, 40], [268, 45], [270, 50], [272, 55], [275, 60], [278, 65], [281, 70], [284, 75], [288, 80], [293, 85], [299, 90], [310, 95], [334, 99]],
      sled_push: [[97, 1], [108, 5], [115, 10], [120, 15], [125, 20], [129, 25], [133, 30], [136, 35], [140, 40], [143, 45], [147, 50], [151, 55], [155, 60], [160, 65], [165, 70], [172, 75], [180, 80], [190, 85], [205, 90], [234, 95], [317, 99]],
      sled_pull: [[179, 1], [197, 5], [209, 10], [218, 15], [225, 20], [233, 25], [240, 30], [246, 35], [253, 40], [259, 45], [266, 50], [273, 55], [281, 60], [290, 65], [300, 70], [311, 75], [324, 80], [343, 85], [368, 90], [411, 95], [518, 99]],
      burpee_broad_jumps: [[135, 1], [151, 5], [162, 10], [170, 15], [176, 20], [182, 25], [187, 30], [193, 35], [199, 40], [205, 45], [211, 50], [217, 55], [223, 60], [231, 65], [239, 70], [249, 75], [261, 80], [276, 85], [298, 90], [337, 95], [436, 99]],
      row_erg: [[252, 1], [262, 5], [268, 10], [272, 15], [276, 20], [279, 25], [282, 30], [284, 35], [287, 40], [290, 45], [293, 50], [295, 55], [298, 60], [301, 65], [305, 70], [310, 75], [314, 80], [320, 85], [328, 90], [342, 95], [375, 99]],
      farmer_carry: [[86, 1], [93, 5], [97, 10], [100, 15], [102, 20], [105, 25], [107, 30], [109, 35], [111, 40], [113, 45], [115, 50], [117, 55], [119, 60], [122, 65], [124, 70], [127, 75], [131, 80], [135, 85], [141, 90], [151, 95], [184, 99]],
      sandbag_lunges: [[153, 1], [173, 5], [185, 10], [194, 15], [201, 20], [208, 25], [214, 30], [221, 35], [227, 40], [234, 45], [240, 50], [247, 55], [254, 60], [262, 65], [270, 70], [281, 75], [293, 80], [310, 85], [332, 90], [372, 95], [482, 99]],
      wall_balls: [[196, 1], [207, 5], [213, 10], [218, 15], [223, 20], [228, 25], [232, 30], [237, 35], [242, 40], [247, 45], [252, 50], [258, 55], [265, 60], [273, 65], [282, 70], [293, 75], [308, 80], [329, 85], [362, 90], [430, 95], [622, 99]],
    },
    male: {
      total: [[3157, 1], [3388, 5], [3525, 10], [3625, 15], [3723, 20], [3814, 25], [3895, 30], [3972, 35], [4050, 40], [4126, 45], [4201, 50], [4285, 55], [4377, 60], [4475, 65], [4580, 70], [4699, 75], [4833, 80], [5019, 85], [5287, 90], [5745, 95], [6919, 99]],
      run_total: [[1600, 1], [1743, 5], [1829, 10], [1889, 15], [1944, 20], [1995, 25], [2043, 30], [2092, 35], [2139, 40], [2187, 45], [2234, 50], [2283, 55], [2336, 60], [2393, 65], [2453, 70], [2521, 75], [2601, 80], [2705, 85], [2852, 90], [3115, 95], [3850, 99]],
      work_total: [[1247, 1], [1331, 5], [1380, 10], [1418, 15], [1449, 20], [1479, 25], [1507, 30], [1532, 35], [1559, 40], [1586, 45], [1613, 50], [1642, 55], [1673, 60], [1705, 65], [1744, 70], [1787, 75], [1840, 80], [1906, 85], [2002, 90], [2168, 95], [2624, 99]],
      roxzone: [[180, 1], [217, 5], [238, 10], [254, 15], [267, 20], [279, 25], [291, 30], [303, 35], [315, 40], [327, 45], [340, 50], [354, 55], [370, 60], [386, 65], [405, 70], [428, 75], [456, 80], [495, 85], [553, 90], [644, 95], [831, 99]],
      ski_erg: [[204, 1], [211, 5], [215, 10], [218, 15], [220, 20], [222, 25], [224, 30], [226, 35], [228, 40], [230, 45], [232, 50], [234, 55], [236, 60], [238, 65], [240, 70], [243, 75], [246, 80], [249, 85], [254, 90], [263, 95], [282, 99]],
      sled_push: [[87, 1], [97, 5], [103, 10], [108, 15], [112, 20], [115, 25], [119, 30], [122, 35], [125, 40], [128, 45], [132, 50], [135, 55], [139, 60], [144, 65], [149, 70], [155, 75], [162, 80], [171, 85], [185, 90], [210, 95], [290, 99]],
      sled_pull: [[158, 1], [178, 5], [190, 10], [198, 15], [206, 20], [213, 25], [219, 30], [226, 35], [232, 40], [239, 45], [246, 50], [253, 55], [261, 60], [269, 65], [279, 70], [290, 75], [303, 80], [320, 85], [345, 90], [389, 95], [510, 99]],
      burpee_broad_jumps: [[101, 1], [115, 5], [123, 10], [129, 15], [135, 20], [140, 25], [144, 30], [149, 35], [153, 40], [158, 45], [162, 50], [167, 55], [172, 60], [178, 65], [184, 70], [191, 75], [199, 80], [210, 85], [224, 90], [248, 95], [312, 99]],
      row_erg: [[220, 1], [229, 5], [235, 10], [238, 15], [241, 20], [244, 25], [246, 30], [249, 35], [251, 40], [253, 45], [256, 50], [258, 55], [261, 60], [264, 65], [267, 70], [270, 75], [274, 80], [279, 85], [287, 90], [299, 95], [330, 99]],
      farmer_carry: [[74, 1], [81, 5], [84, 10], [87, 15], [89, 20], [91, 25], [93, 30], [95, 35], [96, 40], [98, 45], [100, 50], [102, 55], [103, 60], [106, 65], [108, 70], [111, 75], [114, 80], [118, 85], [123, 90], [132, 95], [160, 99]],
      sandbag_lunges: [[135, 1], [154, 5], [165, 10], [174, 15], [181, 20], [187, 25], [193, 30], [199, 35], [204, 40], [210, 45], [216, 50], [222, 55], [228, 60], [235, 65], [243, 70], [251, 75], [261, 80], [275, 85], [294, 90], [327, 95], [417, 99]],
      wall_balls: [[200, 1], [209, 5], [215, 10], [220, 15], [225, 20], [229, 25], [233, 30], [237, 35], [242, 40], [246, 45], [252, 50], [257, 55], [263, 60], [271, 65], [280, 70], [290, 75], [305, 80], [324, 85], [355, 90], [416, 95], [595, 99]],
    },
  },
};

/** Grid used by each pooled S7-S9 table (see HYROX_S79_GRID_LADDER). */
export const HYROX_S79_GRIDS: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, HyroxGridName>>>> = {
  open_singles: {
    female: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
    male: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
  },
  pro_singles: {
    female: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
    male: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
  },
  open_doubles: {
    female: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
    male: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
    mixed: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
  },
  pro_doubles: {
    female: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
    male: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
  },
};

// Current-judging tables: same rules and rows as above, seasons 8 and 9 only
// (HYROX_S89_SEASONS). See the file header on the S8 judging change.
/** Finishers behind each current-judging S8-S9 table (format x sex x metric). */
export const HYROX_S89_FINISHER_COUNTS: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, number>>>> = {
  open_singles: {
    female: { total: 119468, run_total: 118063, work_total: 118063, roxzone: 110943, ski_erg: 118063, sled_push: 118063, sled_pull: 118063, burpee_broad_jumps: 118063, row_erg: 118063, farmer_carry: 118063, sandbag_lunges: 118063, wall_balls: 118063 },
    male: { total: 210236, run_total: 207816, work_total: 207816, roxzone: 200682, ski_erg: 207816, sled_push: 207816, sled_pull: 207816, burpee_broad_jumps: 207816, row_erg: 207816, farmer_carry: 207816, sandbag_lunges: 207816, wall_balls: 207816 },
  },
  pro_singles: {
    female: { total: 18932, run_total: 18694, work_total: 18694, roxzone: 17906, ski_erg: 18694, sled_push: 18694, sled_pull: 18694, burpee_broad_jumps: 18694, row_erg: 18694, farmer_carry: 18694, sandbag_lunges: 18694, wall_balls: 18694 },
    male: { total: 40403, run_total: 39976, work_total: 39976, roxzone: 38273, ski_erg: 39976, sled_push: 39976, sled_pull: 39976, burpee_broad_jumps: 39976, row_erg: 39976, farmer_carry: 39976, sandbag_lunges: 39976, wall_balls: 39976 },
  },
  open_doubles: {
    female: { total: 137988, run_total: 136174, work_total: 136174, roxzone: 129369, ski_erg: 136174, sled_push: 136174, sled_pull: 136174, burpee_broad_jumps: 136174, row_erg: 136174, farmer_carry: 136174, sandbag_lunges: 136174, wall_balls: 136174 },
    male: { total: 130717, run_total: 129138, work_total: 129138, roxzone: 122349, ski_erg: 129138, sled_push: 129138, sled_pull: 129138, burpee_broad_jumps: 129138, row_erg: 129138, farmer_carry: 129138, sandbag_lunges: 129138, wall_balls: 129138 },
    mixed: { total: 146936, run_total: 144532, work_total: 144532, roxzone: 139898, ski_erg: 144532, sled_push: 144532, sled_pull: 144532, burpee_broad_jumps: 144532, row_erg: 144532, farmer_carry: 144532, sandbag_lunges: 144532, wall_balls: 144532 },
  },
  pro_doubles: {
    female: { total: 16614, run_total: 16401, work_total: 16401, roxzone: 16016, ski_erg: 16401, sled_push: 16401, sled_pull: 16401, burpee_broad_jumps: 16401, row_erg: 16401, farmer_carry: 16401, sandbag_lunges: 16401, wall_balls: 16401 },
    male: { total: 28149, run_total: 27821, work_total: 27821, roxzone: 27221, ski_erg: 27821, sled_push: 27821, sled_pull: 27821, burpee_broad_jumps: 27821, row_erg: 27821, farmer_carry: 27821, sandbag_lunges: 27821, wall_balls: 27821 },
  },
};

/** Current-judging S8-S9 format x sex cells withheld because a metric falls below
 *  HYROX_S79_MIN_CELL_N. pro_doubles mixed is also not a rulebook category. */
export const HYROX_S89_SUPPRESSED_CELLS: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; n: number; nSplits: number; nRoxzone: number }> = [
  { format: 'pro_doubles', sex: 'mixed', n: 25, nSplits: 25, nRoxzone: 25 },
];

/** Current-judging S8-S9 percentile tables per format x sex x metric. */
export const HYROX_S89_PERCENTILES: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, HyroxPercentileTable>>>> = {
  open_singles: {
    female: {
      total: [[4135, 1], [4273, 2], [4500, 5], [4730, 10], [4901, 15], [5047, 20], [5180, 25], [5304, 30], [5428, 35], [5556, 40], [5685, 45], [5816, 50], [5956, 55], [6113, 60], [6282, 65], [6470, 70], [6685, 75], [6946, 80], [7288, 85], [7774, 90], [8597, 95], [9634, 98], [10459, 99]],
      run_total: [[1940, 1], [2024, 2], [2156, 5], [2277, 10], [2366, 15], [2441, 20], [2509, 25], [2573, 30], [2634, 35], [2695, 40], [2755, 45], [2817, 50], [2883, 55], [2953, 60], [3031, 65], [3118, 70], [3219, 75], [3339, 80], [3500, 85], [3738, 90], [4155, 95], [4675, 98], [5071, 99]],
      work_total: [[1729, 1], [1790, 2], [1894, 5], [1993, 10], [2069, 15], [2135, 20], [2194, 25], [2252, 30], [2309, 35], [2366, 40], [2426, 45], [2488, 50], [2555, 55], [2627, 60], [2707, 65], [2795, 70], [2898, 75], [3022, 80], [3182, 85], [3410, 90], [3818, 95], [4367, 98], [4812, 99]],
      roxzone: [[247, 1], [267, 2], [302, 5], [335, 10], [359, 15], [380, 20], [399, 25], [418, 30], [437, 35], [455, 40], [475, 45], [494, 50], [516, 55], [539, 60], [564, 65], [592, 70], [625, 75], [665, 80], [716, 85], [785, 90], [902, 95], [1044, 98], [1150, 99]],
      ski_erg: [[271, 1], [275, 2], [282, 5], [289, 10], [294, 15], [298, 20], [302, 25], [306, 30], [309, 35], [312, 40], [316, 45], [319, 50], [322, 55], [326, 60], [330, 65], [335, 70], [340, 75], [346, 80], [354, 85], [364, 90], [381, 95], [402, 98], [419, 99]],
      sled_push: [[106, 1], [112, 2], [122, 5], [132, 10], [139, 15], [145, 20], [151, 25], [156, 30], [161, 35], [167, 40], [172, 45], [177, 50], [183, 55], [189, 60], [195, 65], [202, 70], [211, 75], [221, 80], [234, 85], [253, 90], [286, 95], [337, 98], [384, 99]],
      sled_pull: [[216, 1], [226, 2], [244, 5], [262, 10], [275, 15], [286, 20], [297, 25], [308, 30], [318, 35], [328, 40], [339, 45], [349, 50], [361, 55], [374, 60], [387, 65], [403, 70], [420, 75], [442, 80], [470, 85], [509, 90], [577, 95], [668, 98], [743, 99]],
      burpee_broad_jumps: [[218, 1], [235, 2], [261, 5], [286, 10], [305, 15], [321, 20], [336, 25], [350, 30], [364, 35], [379, 40], [394, 45], [409, 50], [426, 55], [443, 60], [463, 65], [485, 70], [511, 75], [542, 80], [583, 85], [640, 90], [744, 95], [895, 98], [1020, 99]],
      row_erg: [[282, 1], [286, 2], [293, 5], [300, 10], [306, 15], [310, 20], [314, 25], [318, 30], [322, 35], [325, 40], [329, 45], [333, 50], [337, 55], [341, 60], [345, 65], [351, 70], [357, 75], [364, 80], [373, 85], [385, 90], [406, 95], [435, 98], [458, 99]],
      farmer_carry: [[92, 1], [97, 2], [104, 5], [111, 10], [115, 15], [119, 20], [123, 25], [126, 30], [129, 35], [133, 40], [136, 45], [140, 50], [144, 55], [149, 60], [154, 65], [160, 70], [167, 75], [176, 80], [186, 85], [201, 90], [229, 95], [262, 98], [292, 99]],
      sandbag_lunges: [[180, 1], [194, 2], [214, 5], [232, 10], [245, 15], [257, 20], [267, 25], [277, 30], [286, 35], [296, 40], [306, 45], [317, 50], [328, 55], [340, 60], [354, 65], [369, 70], [387, 75], [410, 80], [438, 85], [480, 90], [557, 95], [680, 98], [793, 99]],
      wall_balls: [[229, 1], [243, 2], [266, 5], [290, 10], [308, 15], [324, 20], [338, 25], [353, 30], [367, 35], [382, 40], [398, 45], [414, 50], [432, 55], [452, 60], [475, 65], [500, 70], [530, 75], [567, 80], [617, 85], [690, 90], [826, 95], [1030, 98], [1204, 99]],
    },
    male: {
      total: [[3701, 1], [3825, 2], [4039, 5], [4257, 10], [4424, 15], [4569, 20], [4699, 25], [4824, 30], [4952, 35], [5074, 40], [5201, 45], [5328, 50], [5465, 55], [5617, 60], [5782, 65], [5968, 70], [6184, 75], [6440, 80], [6770, 85], [7224, 90], [8024, 95], [9100, 98], [9929, 99]],
      run_total: [[1724, 1], [1797, 2], [1906, 5], [2014, 10], [2095, 15], [2163, 20], [2226, 25], [2285, 30], [2342, 35], [2398, 40], [2456, 45], [2516, 50], [2580, 55], [2647, 60], [2720, 65], [2804, 70], [2900, 75], [3019, 80], [3172, 85], [3398, 90], [3801, 95], [4354, 98], [4752, 99]],
      work_total: [[1571, 1], [1629, 2], [1730, 5], [1831, 10], [1907, 15], [1974, 20], [2035, 25], [2093, 30], [2150, 35], [2207, 40], [2266, 45], [2327, 50], [2393, 55], [2463, 60], [2541, 65], [2626, 70], [2725, 75], [2845, 80], [2999, 85], [3213, 90], [3587, 95], [4109, 98], [4541, 99]],
      roxzone: [[221, 1], [239, 2], [270, 5], [301, 10], [324, 15], [344, 20], [363, 25], [382, 30], [400, 35], [419, 40], [438, 45], [459, 50], [481, 55], [505, 60], [533, 65], [563, 70], [599, 75], [640, 80], [693, 85], [764, 90], [879, 95], [1026, 98], [1140, 99]],
      ski_erg: [[237, 1], [241, 2], [246, 5], [252, 10], [256, 15], [259, 20], [262, 25], [265, 30], [268, 35], [270, 40], [273, 45], [276, 50], [279, 55], [282, 60], [285, 65], [289, 70], [293, 75], [298, 80], [304, 85], [312, 90], [325, 95], [343, 98], [356, 99]],
      sled_push: [[110, 1], [117, 2], [128, 5], [139, 10], [147, 15], [154, 20], [160, 25], [166, 30], [171, 35], [177, 40], [183, 45], [189, 50], [195, 55], [202, 60], [210, 65], [219, 70], [229, 75], [242, 80], [258, 85], [282, 90], [326, 95], [397, 98], [459, 99]],
      sled_pull: [[180, 1], [190, 2], [206, 5], [222, 10], [234, 15], [245, 20], [254, 25], [263, 30], [273, 35], [282, 40], [291, 45], [301, 50], [312, 55], [323, 60], [335, 65], [349, 70], [365, 75], [384, 80], [410, 85], [445, 90], [505, 95], [584, 98], [649, 99]],
      burpee_broad_jumps: [[174, 1], [188, 2], [211, 5], [233, 10], [249, 15], [263, 20], [277, 25], [289, 30], [302, 35], [314, 40], [326, 45], [339, 50], [353, 55], [367, 60], [383, 65], [402, 70], [423, 75], [447, 80], [479, 85], [525, 90], [603, 95], [712, 98], [806, 99]],
      row_erg: [[250, 1], [254, 2], [261, 5], [267, 10], [271, 15], [275, 20], [278, 25], [282, 30], [285, 35], [288, 40], [292, 45], [295, 50], [299, 55], [302, 60], [307, 65], [311, 70], [317, 75], [323, 80], [331, 85], [342, 90], [361, 95], [387, 98], [408, 99]],
      farmer_carry: [[82, 1], [86, 2], [93, 5], [100, 10], [105, 15], [109, 20], [113, 25], [117, 30], [121, 35], [125, 40], [128, 45], [133, 50], [137, 55], [142, 60], [148, 65], [154, 70], [161, 75], [170, 80], [180, 85], [196, 90], [223, 95], [257, 98], [289, 99]],
      sandbag_lunges: [[179, 1], [193, 2], [214, 5], [234, 10], [248, 15], [260, 20], [271, 25], [282, 30], [292, 35], [302, 40], [313, 45], [324, 50], [336, 55], [348, 60], [362, 65], [378, 70], [397, 75], [419, 80], [449, 85], [493, 90], [574, 95], [701, 98], [815, 99]],
      wall_balls: [[228, 1], [244, 2], [270, 5], [297, 10], [317, 15], [335, 20], [351, 25], [368, 30], [384, 35], [401, 40], [418, 45], [437, 50], [457, 55], [479, 60], [504, 65], [531, 70], [564, 75], [605, 80], [658, 85], [736, 90], [876, 95], [1082, 98], [1252, 99]],
    },
  },
  pro_singles: {
    female: {
      total: [[3747, 1], [4047, 5], [4235, 10], [4383, 15], [4513, 20], [4643, 25], [4767, 30], [4886, 35], [4995, 40], [5106, 45], [5224, 50], [5348, 55], [5483, 60], [5636, 65], [5797, 70], [5976, 75], [6216, 80], [6534, 85], [6955, 90], [7726, 95], [9635, 99]],
      run_total: [[1724, 1], [1891, 5], [1981, 10], [2049, 15], [2109, 20], [2163, 25], [2213, 30], [2263, 35], [2314, 40], [2366, 45], [2417, 50], [2472, 55], [2532, 60], [2594, 65], [2667, 70], [2746, 75], [2844, 80], [2973, 85], [3153, 90], [3493, 95], [4382, 99]],
      work_total: [[1638, 1], [1789, 5], [1883, 10], [1961, 15], [2030, 20], [2090, 25], [2148, 30], [2208, 35], [2266, 40], [2323, 45], [2380, 50], [2447, 55], [2515, 60], [2593, 65], [2674, 70], [2768, 75], [2888, 80], [3036, 85], [3268, 90], [3650, 95], [4705, 99]],
      roxzone: [[212, 1], [253, 5], [278, 10], [296, 15], [311, 20], [327, 25], [341, 30], [356, 35], [371, 40], [387, 45], [403, 50], [420, 55], [440, 60], [462, 65], [488, 70], [518, 75], [557, 80], [602, 85], [670, 90], [779, 95], [1010, 99]],
      ski_erg: [[255, 1], [265, 5], [271, 10], [275, 15], [278, 20], [281, 25], [284, 30], [287, 35], [289, 40], [292, 45], [295, 50], [297, 55], [300, 60], [304, 65], [307, 70], [311, 75], [315, 80], [321, 85], [329, 90], [342, 95], [372, 99]],
      sled_push: [[142, 1], [163, 5], [177, 10], [187, 15], [196, 20], [204, 25], [210, 30], [217, 35], [225, 40], [232, 45], [241, 50], [249, 55], [259, 60], [269, 65], [281, 70], [295, 75], [312, 80], [333, 85], [363, 90], [421, 95], [571, 99]],
      sled_pull: [[214, 1], [239, 5], [256, 10], [269, 15], [281, 20], [292, 25], [303, 30], [314, 35], [324, 40], [335, 45], [347, 50], [359, 55], [373, 60], [386, 65], [403, 70], [423, 75], [447, 80], [480, 85], [522, 90], [595, 95], [789, 99]],
      burpee_broad_jumps: [[179, 1], [207, 5], [223, 10], [237, 15], [249, 20], [260, 25], [270, 30], [280, 35], [290, 40], [301, 45], [313, 50], [323, 55], [336, 60], [349, 65], [365, 70], [382, 75], [402, 80], [429, 85], [468, 90], [537, 95], [723, 99]],
      row_erg: [[265, 1], [275, 5], [281, 10], [286, 15], [289, 20], [293, 25], [296, 30], [299, 35], [302, 40], [305, 45], [308, 50], [311, 55], [314, 60], [318, 65], [322, 70], [327, 75], [332, 80], [339, 85], [350, 90], [367, 95], [413, 99]],
      farmer_carry: [[94, 1], [104, 5], [112, 10], [118, 15], [124, 20], [129, 25], [135, 30], [140, 35], [146, 40], [151, 45], [157, 50], [163, 55], [170, 60], [177, 65], [185, 70], [195, 75], [206, 80], [221, 85], [241, 90], [276, 95], [369, 99]],
      sandbag_lunges: [[180, 1], [208, 5], [226, 10], [239, 15], [250, 20], [260, 25], [271, 30], [281, 35], [290, 40], [300, 45], [311, 50], [321, 55], [332, 60], [344, 65], [358, 70], [374, 75], [393, 80], [419, 85], [458, 90], [534, 95], [749, 99]],
      wall_balls: [[212, 1], [246, 5], [268, 10], [285, 15], [299, 20], [312, 25], [326, 30], [339, 35], [353, 40], [367, 45], [382, 50], [399, 55], [415, 60], [435, 65], [457, 70], [482, 75], [514, 80], [559, 85], [622, 90], [749, 95], [1122, 99]],
    },
    male: {
      total: [[3462, 1], [3742, 5], [3930, 10], [4071, 15], [4192, 20], [4315, 25], [4428, 30], [4536, 35], [4647, 40], [4761, 45], [4876, 50], [4996, 55], [5125, 60], [5272, 65], [5430, 70], [5619, 75], [5839, 80], [6125, 85], [6541, 90], [7253, 95], [9159, 99]],
      run_total: [[1583, 1], [1744, 5], [1825, 10], [1881, 15], [1933, 20], [1980, 25], [2027, 30], [2072, 35], [2116, 40], [2160, 45], [2208, 50], [2258, 55], [2312, 60], [2370, 65], [2436, 70], [2508, 75], [2595, 80], [2711, 85], [2885, 90], [3212, 95], [4036, 99]],
      work_total: [[1501, 1], [1658, 5], [1760, 10], [1836, 15], [1903, 20], [1967, 25], [2028, 30], [2084, 35], [2142, 40], [2202, 45], [2263, 50], [2327, 55], [2395, 60], [2469, 65], [2557, 70], [2653, 75], [2769, 80], [2920, 85], [3136, 90], [3518, 95], [4523, 99]],
      roxzone: [[198, 1], [236, 5], [260, 10], [277, 15], [292, 20], [306, 25], [321, 30], [335, 35], [349, 40], [364, 45], [381, 50], [399, 55], [419, 60], [441, 65], [466, 70], [495, 75], [532, 80], [578, 85], [641, 90], [747, 95], [984, 99]],
      ski_erg: [[227, 1], [235, 5], [239, 10], [243, 15], [245, 20], [248, 25], [250, 30], [252, 35], [254, 40], [256, 45], [258, 50], [260, 55], [263, 60], [265, 65], [268, 70], [271, 75], [275, 80], [279, 85], [286, 90], [296, 95], [322, 99]],
      sled_push: [[139, 1], [158, 5], [171, 10], [180, 15], [188, 20], [196, 25], [203, 30], [210, 35], [218, 40], [225, 45], [233, 50], [241, 55], [250, 60], [260, 65], [272, 70], [285, 75], [300, 80], [322, 85], [354, 90], [417, 95], [595, 99]],
      sled_pull: [[198, 1], [225, 5], [243, 10], [258, 15], [270, 20], [282, 25], [294, 30], [306, 35], [318, 40], [330, 45], [343, 50], [358, 55], [373, 60], [390, 65], [409, 70], [432, 75], [460, 80], [497, 85], [550, 90], [644, 95], [894, 99]],
      burpee_broad_jumps: [[146, 1], [169, 5], [184, 10], [196, 15], [207, 20], [216, 25], [226, 30], [235, 35], [244, 40], [254, 45], [263, 50], [273, 55], [285, 60], [296, 65], [310, 70], [325, 75], [343, 80], [366, 85], [398, 90], [454, 95], [603, 99]],
      row_erg: [[237, 1], [247, 5], [252, 10], [256, 15], [259, 20], [262, 25], [265, 30], [267, 35], [270, 40], [273, 45], [275, 50], [278, 55], [281, 60], [284, 65], [288, 70], [292, 75], [297, 80], [303, 85], [312, 90], [329, 95], [368, 99]],
      farmer_carry: [[82, 1], [90, 5], [96, 10], [101, 15], [105, 20], [109, 25], [113, 30], [117, 35], [122, 40], [127, 45], [132, 50], [137, 55], [143, 60], [150, 65], [157, 70], [166, 75], [175, 80], [188, 85], [205, 90], [236, 95], [309, 99]],
      sandbag_lunges: [[167, 1], [197, 5], [216, 10], [230, 15], [242, 20], [253, 25], [263, 30], [272, 35], [282, 40], [292, 45], [303, 50], [313, 55], [325, 60], [337, 65], [351, 70], [367, 75], [387, 80], [413, 85], [454, 90], [531, 95], [747, 99]],
      wall_balls: [[222, 1], [259, 5], [284, 10], [304, 15], [321, 20], [337, 25], [352, 30], [367, 35], [383, 40], [398, 45], [415, 50], [433, 55], [452, 60], [474, 65], [499, 70], [529, 75], [565, 80], [613, 85], [686, 90], [815, 95], [1199, 99]],
    },
  },
  open_doubles: {
    female: {
      total: [[3967, 1], [4085, 2], [4279, 5], [4475, 10], [4616, 15], [4735, 20], [4841, 25], [4938, 30], [5035, 35], [5130, 40], [5225, 45], [5322, 50], [5424, 55], [5535, 60], [5655, 65], [5791, 70], [5940, 75], [6123, 80], [6353, 85], [6670, 90], [7201, 95], [7909, 98], [8461, 99]],
      run_total: [[2053, 1], [2142, 2], [2285, 5], [2421, 10], [2517, 15], [2596, 20], [2665, 25], [2729, 30], [2790, 35], [2849, 40], [2908, 45], [2968, 50], [3028, 55], [3094, 60], [3166, 65], [3246, 70], [3339, 75], [3450, 80], [3594, 85], [3796, 90], [4153, 95], [4621, 98], [4974, 99]],
      work_total: [[1442, 1], [1477, 2], [1535, 5], [1592, 10], [1635, 15], [1671, 20], [1704, 25], [1735, 30], [1765, 35], [1796, 40], [1826, 45], [1858, 50], [1891, 55], [1927, 60], [1966, 65], [2009, 70], [2058, 75], [2116, 80], [2191, 85], [2294, 90], [2479, 95], [2726, 98], [2922, 99]],
      roxzone: [[245, 1], [264, 2], [297, 5], [330, 10], [354, 15], [374, 20], [392, 25], [410, 30], [427, 35], [444, 40], [462, 45], [481, 50], [501, 55], [522, 60], [546, 65], [572, 70], [604, 75], [641, 80], [689, 85], [755, 90], [860, 95], [995, 98], [1097, 99]],
      ski_erg: [[249, 1], [253, 2], [259, 5], [265, 10], [270, 15], [273, 20], [276, 25], [279, 30], [282, 35], [285, 40], [288, 45], [291, 50], [294, 55], [297, 60], [300, 65], [304, 70], [308, 75], [313, 80], [318, 85], [326, 90], [339, 95], [354, 98], [366, 99]],
      sled_push: [[76, 1], [79, 2], [85, 5], [90, 10], [94, 15], [97, 20], [100, 25], [102, 30], [105, 35], [108, 40], [110, 45], [113, 50], [116, 55], [118, 60], [122, 65], [125, 70], [129, 75], [134, 80], [140, 85], [148, 90], [162, 95], [183, 98], [203, 99]],
      sled_pull: [[170, 1], [178, 2], [190, 5], [202, 10], [211, 15], [218, 20], [225, 25], [231, 30], [237, 35], [243, 40], [249, 45], [256, 50], [262, 55], [269, 60], [276, 65], [285, 70], [295, 75], [306, 80], [321, 85], [341, 90], [374, 95], [422, 98], [462, 99]],
      burpee_broad_jumps: [[155, 1], [164, 2], [179, 5], [194, 10], [204, 15], [213, 20], [221, 25], [229, 30], [237, 35], [245, 40], [253, 45], [261, 50], [269, 55], [278, 60], [288, 65], [299, 70], [312, 75], [328, 80], [348, 85], [375, 90], [425, 95], [494, 98], [549, 99]],
      row_erg: [[267, 1], [272, 2], [279, 5], [286, 10], [291, 15], [295, 20], [298, 25], [301, 30], [305, 35], [308, 40], [311, 45], [314, 50], [317, 55], [321, 60], [325, 65], [329, 70], [333, 75], [339, 80], [345, 85], [354, 90], [369, 95], [389, 98], [405, 99]],
      farmer_carry: [[81, 1], [84, 2], [89, 5], [93, 10], [97, 15], [100, 20], [102, 25], [104, 30], [107, 35], [109, 40], [111, 45], [113, 50], [115, 55], [118, 60], [120, 65], [123, 70], [125, 75], [129, 80], [132, 85], [138, 90], [146, 95], [160, 98], [174, 99]],
      sandbag_lunges: [[147, 1], [155, 2], [168, 5], [179, 10], [187, 15], [194, 20], [200, 25], [206, 30], [212, 35], [218, 40], [224, 45], [230, 50], [236, 55], [243, 60], [250, 65], [258, 70], [268, 75], [279, 80], [293, 85], [313, 90], [349, 95], [400, 98], [439, 99]],
      wall_balls: [[202, 1], [207, 2], [215, 5], [223, 10], [229, 15], [235, 20], [240, 25], [245, 30], [250, 35], [256, 40], [261, 45], [267, 50], [273, 55], [280, 60], [288, 65], [297, 70], [309, 75], [323, 80], [341, 85], [369, 90], [424, 95], [507, 98], [582, 99]],
    },
    male: {
      total: [[3396, 1], [3493, 2], [3650, 5], [3822, 10], [3954, 15], [4063, 20], [4160, 25], [4254, 30], [4345, 35], [4435, 40], [4527, 45], [4621, 50], [4721, 55], [4825, 60], [4939, 65], [5065, 70], [5213, 75], [5386, 80], [5611, 85], [5923, 90], [6455, 95], [7142, 98], [7719, 99]],
      run_total: [[1736, 1], [1811, 2], [1925, 5], [2038, 10], [2124, 15], [2197, 20], [2262, 25], [2323, 30], [2382, 35], [2440, 40], [2496, 45], [2554, 50], [2615, 55], [2680, 60], [2747, 65], [2823, 70], [2910, 75], [3018, 80], [3153, 85], [3350, 90], [3700, 95], [4192, 98], [4573, 99]],
      work_total: [[1266, 1], [1299, 2], [1351, 5], [1401, 10], [1438, 15], [1470, 20], [1499, 25], [1526, 30], [1553, 35], [1579, 40], [1606, 45], [1635, 50], [1664, 55], [1696, 60], [1730, 65], [1768, 70], [1813, 75], [1866, 80], [1934, 85], [2029, 90], [2191, 95], [2413, 98], [2589, 99]],
      roxzone: [[207, 1], [225, 2], [254, 5], [283, 10], [303, 15], [321, 20], [337, 25], [352, 30], [368, 35], [384, 40], [400, 45], [417, 50], [437, 55], [458, 60], [483, 65], [511, 70], [542, 75], [581, 80], [627, 85], [691, 90], [788, 95], [907, 98], [998, 99]],
      ski_erg: [[213, 1], [216, 2], [221, 5], [226, 10], [229, 15], [232, 20], [235, 25], [237, 30], [239, 35], [242, 40], [244, 45], [246, 50], [249, 55], [251, 60], [254, 65], [257, 70], [260, 75], [264, 80], [268, 85], [275, 90], [285, 95], [298, 98], [308, 99]],
      sled_push: [[75, 1], [78, 2], [84, 5], [89, 10], [93, 15], [96, 20], [99, 25], [102, 30], [105, 35], [108, 40], [110, 45], [113, 50], [116, 55], [119, 60], [123, 65], [126, 70], [131, 75], [136, 80], [143, 85], [153, 90], [171, 95], [199, 98], [229, 99]],
      sled_pull: [[128, 1], [135, 2], [146, 5], [157, 10], [165, 15], [171, 20], [177, 25], [182, 30], [188, 35], [193, 40], [199, 45], [204, 50], [210, 55], [216, 60], [223, 65], [230, 70], [239, 75], [249, 80], [261, 85], [279, 90], [307, 95], [347, 98], [385, 99]],
      burpee_broad_jumps: [[114, 1], [121, 2], [133, 5], [144, 10], [152, 15], [159, 20], [165, 25], [171, 30], [177, 35], [183, 40], [189, 45], [195, 50], [201, 55], [208, 60], [215, 65], [223, 70], [232, 75], [244, 80], [257, 85], [277, 90], [310, 95], [358, 98], [396, 99]],
      row_erg: [[233, 1], [237, 2], [243, 5], [248, 10], [253, 15], [256, 20], [259, 25], [262, 30], [265, 35], [268, 40], [271, 45], [274, 50], [277, 55], [280, 60], [283, 65], [287, 70], [291, 75], [297, 80], [303, 85], [312, 90], [326, 95], [345, 98], [360, 99]],
      farmer_carry: [[71, 1], [74, 2], [79, 5], [83, 10], [86, 15], [88, 20], [91, 25], [93, 30], [95, 35], [97, 40], [99, 45], [101, 50], [103, 55], [105, 60], [108, 65], [111, 70], [114, 75], [117, 80], [122, 85], [127, 90], [136, 95], [149, 98], [166, 99]],
      sandbag_lunges: [[136, 1], [145, 2], [157, 5], [168, 10], [177, 15], [183, 20], [190, 25], [195, 30], [201, 35], [207, 40], [212, 45], [218, 50], [224, 55], [231, 60], [238, 65], [247, 70], [256, 75], [268, 80], [282, 85], [302, 90], [338, 95], [390, 98], [432, 99]],
      wall_balls: [[204, 1], [209, 2], [217, 5], [225, 10], [231, 15], [237, 20], [242, 25], [247, 30], [252, 35], [257, 40], [263, 45], [269, 50], [275, 55], [282, 60], [290, 65], [300, 70], [311, 75], [325, 80], [345, 85], [373, 90], [427, 95], [505, 98], [572, 99]],
    },
    mixed: {
      total: [[3544, 1], [3666, 2], [3897, 5], [4113, 10], [4266, 15], [4396, 20], [4509, 25], [4615, 30], [4716, 35], [4814, 40], [4915, 45], [5018, 50], [5125, 55], [5238, 60], [5360, 65], [5497, 70], [5663, 75], [5858, 80], [6105, 85], [6450, 90], [7023, 95], [7795, 98], [8405, 99]],
      run_total: [[1838, 1], [1916, 2], [2052, 5], [2189, 10], [2285, 15], [2365, 20], [2438, 25], [2504, 30], [2567, 35], [2628, 40], [2690, 45], [2751, 50], [2814, 55], [2881, 60], [2953, 65], [3031, 70], [3122, 75], [3235, 80], [3379, 85], [3587, 90], [3947, 95], [4436, 98], [4807, 99]],
      work_total: [[1334, 1], [1373, 2], [1439, 5], [1505, 10], [1553, 15], [1592, 20], [1629, 25], [1663, 30], [1697, 35], [1730, 40], [1764, 45], [1799, 50], [1836, 55], [1875, 60], [1919, 65], [1967, 70], [2024, 75], [2091, 80], [2179, 85], [2303, 90], [2521, 95], [2825, 98], [3075, 99]],
      roxzone: [[217, 1], [236, 2], [268, 5], [299, 10], [322, 15], [341, 20], [359, 25], [376, 30], [393, 35], [409, 40], [427, 45], [445, 50], [464, 55], [486, 60], [509, 65], [535, 70], [566, 75], [604, 80], [653, 85], [721, 90], [828, 95], [955, 98], [1047, 99]],
      ski_erg: [[225, 1], [228, 2], [234, 5], [239, 10], [243, 15], [247, 20], [249, 25], [252, 30], [255, 35], [257, 40], [260, 45], [262, 50], [265, 55], [268, 60], [271, 65], [274, 70], [278, 75], [282, 80], [288, 85], [295, 90], [307, 95], [322, 98], [334, 99]],
      sled_push: [[87, 1], [91, 2], [97, 5], [104, 10], [109, 15], [113, 20], [117, 25], [120, 30], [124, 35], [127, 40], [131, 45], [135, 50], [139, 55], [143, 60], [147, 65], [153, 70], [159, 75], [166, 80], [176, 85], [191, 90], [217, 95], [257, 98], [294, 99]],
      sled_pull: [[150, 1], [158, 2], [171, 5], [184, 10], [193, 15], [201, 20], [208, 25], [215, 30], [222, 35], [228, 40], [235, 45], [242, 50], [249, 55], [256, 60], [264, 65], [274, 70], [284, 75], [297, 80], [313, 85], [335, 90], [373, 95], [425, 98], [468, 99]],
      burpee_broad_jumps: [[125, 1], [133, 2], [145, 5], [158, 10], [168, 15], [176, 20], [183, 25], [190, 30], [197, 35], [203, 40], [210, 45], [217, 50], [225, 55], [232, 60], [241, 65], [251, 70], [262, 75], [275, 80], [292, 85], [315, 90], [355, 95], [413, 98], [460, 99]],
      row_erg: [[241, 1], [246, 2], [253, 5], [260, 10], [265, 15], [269, 20], [273, 25], [276, 30], [279, 35], [282, 40], [286, 45], [289, 50], [292, 55], [296, 60], [300, 65], [304, 70], [309, 75], [314, 80], [321, 85], [330, 90], [345, 95], [365, 98], [381, 99]],
      farmer_carry: [[76, 1], [80, 2], [85, 5], [90, 10], [94, 15], [97, 20], [99, 25], [102, 30], [104, 35], [106, 40], [108, 45], [111, 50], [113, 55], [115, 60], [118, 65], [121, 70], [124, 75], [128, 80], [132, 85], [138, 90], [148, 95], [164, 98], [183, 99]],
      sandbag_lunges: [[145, 1], [155, 2], [170, 5], [184, 10], [194, 15], [202, 20], [210, 25], [217, 30], [224, 35], [231, 40], [238, 45], [245, 50], [253, 55], [261, 60], [270, 65], [279, 70], [291, 75], [305, 80], [323, 85], [348, 90], [393, 95], [458, 98], [515, 99]],
      wall_balls: [[203, 1], [208, 2], [217, 5], [226, 10], [233, 15], [240, 20], [246, 25], [252, 30], [259, 35], [265, 40], [272, 45], [280, 50], [288, 55], [298, 60], [309, 65], [322, 70], [337, 75], [358, 80], [385, 85], [425, 90], [503, 95], [619, 98], [721, 99]],
    },
  },
  pro_doubles: {
    female: {
      total: [[3555, 1], [3824, 5], [3996, 10], [4129, 15], [4237, 20], [4337, 25], [4432, 30], [4523, 35], [4609, 40], [4700, 45], [4792, 50], [4887, 55], [4995, 60], [5105, 65], [5232, 70], [5369, 75], [5539, 80], [5753, 85], [6088, 90], [6662, 95], [8000, 99]],
      run_total: [[1775, 1], [1965, 5], [2075, 10], [2155, 15], [2222, 20], [2285, 25], [2343, 30], [2400, 35], [2454, 40], [2508, 45], [2566, 50], [2624, 55], [2681, 60], [2744, 65], [2811, 70], [2891, 75], [2985, 80], [3116, 85], [3303, 90], [3632, 95], [4504, 99]],
      work_total: [[1413, 1], [1496, 5], [1550, 10], [1591, 15], [1627, 20], [1660, 25], [1691, 30], [1722, 35], [1753, 40], [1785, 45], [1815, 50], [1849, 55], [1885, 60], [1922, 65], [1968, 70], [2020, 75], [2083, 80], [2164, 85], [2288, 90], [2504, 95], [3019, 99]],
      roxzone: [[205, 1], [246, 5], [273, 10], [291, 15], [307, 20], [322, 25], [336, 30], [351, 35], [366, 40], [382, 45], [399, 50], [416, 55], [435, 60], [456, 65], [480, 70], [509, 75], [543, 80], [591, 85], [654, 90], [749, 95], [963, 99]],
      ski_erg: [[236, 1], [244, 5], [249, 10], [253, 15], [256, 20], [259, 25], [261, 30], [264, 35], [266, 40], [269, 45], [271, 50], [273, 55], [276, 60], [279, 65], [282, 70], [285, 75], [289, 80], [294, 85], [301, 90], [312, 95], [336, 99]],
      sled_push: [[99, 1], [111, 5], [118, 10], [123, 15], [128, 20], [132, 25], [136, 30], [139, 35], [143, 40], [146, 45], [151, 50], [155, 55], [159, 60], [164, 65], [169, 70], [176, 75], [184, 80], [195, 85], [211, 90], [241, 95], [328, 99]],
      sled_pull: [[179, 1], [197, 5], [208, 10], [217, 15], [225, 20], [232, 25], [239, 30], [245, 35], [252, 40], [258, 45], [265, 50], [272, 55], [280, 60], [288, 65], [298, 70], [309, 75], [323, 80], [341, 85], [366, 90], [406, 95], [515, 99]],
      burpee_broad_jumps: [[136, 1], [151, 5], [162, 10], [170, 15], [176, 20], [182, 25], [188, 30], [193, 35], [199, 40], [205, 45], [211, 50], [217, 55], [224, 60], [231, 65], [240, 70], [250, 75], [261, 80], [277, 85], [299, 90], [339, 95], [439, 99]],
      row_erg: [[253, 1], [263, 5], [269, 10], [273, 15], [276, 20], [279, 25], [282, 30], [285, 35], [288, 40], [290, 45], [293, 50], [296, 55], [299, 60], [302, 65], [306, 70], [310, 75], [315, 80], [321, 85], [329, 90], [344, 95], [376, 99]],
      farmer_carry: [[86, 1], [93, 5], [97, 10], [100, 15], [103, 20], [105, 25], [107, 30], [109, 35], [111, 40], [113, 45], [116, 50], [118, 55], [120, 60], [122, 65], [125, 70], [128, 75], [131, 80], [136, 85], [142, 90], [152, 95], [185, 99]],
      sandbag_lunges: [[152, 1], [172, 5], [184, 10], [193, 15], [201, 20], [208, 25], [214, 30], [220, 35], [227, 40], [233, 45], [240, 50], [247, 55], [254, 60], [262, 65], [271, 70], [281, 75], [294, 80], [311, 85], [333, 90], [373, 95], [482, 99]],
      wall_balls: [[196, 1], [207, 5], [213, 10], [218, 15], [223, 20], [228, 25], [232, 30], [237, 35], [242, 40], [247, 45], [253, 50], [259, 55], [266, 60], [274, 65], [284, 70], [295, 75], [310, 80], [333, 85], [366, 90], [437, 95], [641, 99]],
    },
    male: {
      total: [[3154, 1], [3384, 5], [3516, 10], [3614, 15], [3711, 20], [3805, 25], [3886, 30], [3967, 35], [4045, 40], [4124, 45], [4200, 50], [4286, 55], [4379, 60], [4480, 65], [4588, 70], [4708, 75], [4850, 80], [5048, 85], [5313, 90], [5784, 95], [6990, 99]],
      run_total: [[1587, 1], [1734, 5], [1817, 10], [1876, 15], [1930, 20], [1979, 25], [2028, 30], [2077, 35], [2125, 40], [2174, 45], [2221, 50], [2271, 55], [2327, 60], [2383, 65], [2446, 70], [2514, 75], [2596, 80], [2701, 85], [2850, 90], [3117, 95], [3866, 99]],
      work_total: [[1249, 1], [1336, 5], [1386, 10], [1424, 15], [1457, 20], [1486, 25], [1514, 30], [1540, 35], [1567, 40], [1594, 45], [1622, 50], [1652, 55], [1683, 60], [1716, 65], [1756, 70], [1801, 75], [1854, 80], [1924, 85], [2020, 90], [2196, 95], [2661, 99]],
      roxzone: [[178, 1], [215, 5], [238, 10], [253, 15], [266, 20], [279, 25], [290, 30], [302, 35], [314, 40], [327, 45], [340, 50], [355, 55], [371, 60], [389, 65], [409, 70], [434, 75], [464, 80], [507, 85], [570, 90], [659, 95], [847, 99]],
      ski_erg: [[204, 1], [211, 5], [215, 10], [218, 15], [221, 20], [223, 25], [225, 30], [227, 35], [229, 40], [231, 45], [232, 50], [234, 55], [236, 60], [238, 65], [241, 70], [243, 75], [246, 80], [250, 85], [255, 90], [264, 95], [283, 99]],
      sled_push: [[89, 1], [100, 5], [106, 10], [111, 15], [115, 20], [119, 25], [122, 30], [125, 35], [129, 40], [132, 45], [135, 50], [139, 55], [144, 60], [148, 65], [153, 70], [160, 75], [167, 80], [176, 85], [191, 90], [217, 95], [300, 99]],
      sled_pull: [[159, 1], [179, 5], [191, 10], [199, 15], [207, 20], [214, 25], [220, 30], [227, 35], [233, 40], [240, 45], [247, 50], [254, 55], [262, 60], [271, 65], [280, 70], [291, 75], [304, 80], [321, 85], [345, 90], [388, 95], [511, 99]],
      burpee_broad_jumps: [[101, 1], [115, 5], [123, 10], [130, 15], [135, 20], [140, 25], [144, 30], [149, 35], [153, 40], [158, 45], [163, 50], [168, 55], [173, 60], [178, 65], [184, 70], [191, 75], [200, 80], [211, 85], [225, 90], [249, 95], [313, 99]],
      row_erg: [[220, 1], [230, 5], [235, 10], [239, 15], [242, 20], [244, 25], [247, 30], [249, 35], [252, 40], [254, 45], [256, 50], [259, 55], [261, 60], [264, 65], [267, 70], [271, 75], [275, 80], [280, 85], [288, 90], [300, 95], [332, 99]],
      farmer_carry: [[75, 1], [81, 5], [85, 10], [88, 15], [90, 20], [92, 25], [93, 30], [95, 35], [97, 40], [98, 45], [100, 50], [102, 55], [104, 60], [106, 65], [108, 70], [111, 75], [114, 80], [118, 85], [124, 90], [133, 95], [160, 99]],
      sandbag_lunges: [[135, 1], [154, 5], [165, 10], [174, 15], [181, 20], [187, 25], [193, 30], [199, 35], [205, 40], [210, 45], [216, 50], [222, 55], [228, 60], [235, 65], [242, 70], [251, 75], [262, 80], [275, 85], [294, 90], [328, 95], [420, 99]],
      wall_balls: [[201, 1], [210, 5], [217, 10], [222, 15], [226, 20], [231, 25], [235, 30], [239, 35], [244, 40], [248, 45], [254, 50], [260, 55], [266, 60], [274, 65], [284, 70], [296, 75], [310, 80], [331, 85], [362, 90], [427, 95], [613, 99]],
    },
  },
};

/** Grid used by each current-judging S8-S9 table (see HYROX_S79_GRID_LADDER). */
export const HYROX_S89_GRIDS: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, HyroxGridName>>>> = {
  open_singles: {
    female: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
    male: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
  },
  pro_singles: {
    female: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
    male: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
  },
  open_doubles: {
    female: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
    male: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
    mixed: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
  },
  pro_doubles: {
    female: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
    male: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
  },
};

/** Current-judging S8-S9 tables per format with every published sex cell pooled
 *  (women and men, plus mixed pairs in open_doubles; pro_doubles mixed stays out).
 *  The fallback for an athlete whose sex and division are unknown. */
export const HYROX_S89_POOLED_FINISHER_COUNTS: Partial<Record<HyroxResultsFormat, Record<HyroxResultsMetric, number>>> = {
  open_singles: { total: 329704, run_total: 325879, work_total: 325879, roxzone: 311625, ski_erg: 325879, sled_push: 325879, sled_pull: 325879, burpee_broad_jumps: 325879, row_erg: 325879, farmer_carry: 325879, sandbag_lunges: 325879, wall_balls: 325879 },
  pro_singles: { total: 59335, run_total: 58670, work_total: 58670, roxzone: 56179, ski_erg: 58670, sled_push: 58670, sled_pull: 58670, burpee_broad_jumps: 58670, row_erg: 58670, farmer_carry: 58670, sandbag_lunges: 58670, wall_balls: 58670 },
  open_doubles: { total: 415641, run_total: 409844, work_total: 409844, roxzone: 391616, ski_erg: 409844, sled_push: 409844, sled_pull: 409844, burpee_broad_jumps: 409844, row_erg: 409844, farmer_carry: 409844, sandbag_lunges: 409844, wall_balls: 409844 },
  pro_doubles: { total: 44763, run_total: 44222, work_total: 44222, roxzone: 43237, ski_erg: 44222, sled_push: 44222, sled_pull: 44222, burpee_broad_jumps: 44222, row_erg: 44222, farmer_carry: 44222, sandbag_lunges: 44222, wall_balls: 44222 },
};
export const HYROX_S89_POOLED_PERCENTILES: Partial<Record<HyroxResultsFormat, Record<HyroxResultsMetric, HyroxPercentileTable>>> = {
  open_singles: {
    total: [[3774, 1], [3910, 2], [4146, 5], [4388, 10], [4568, 15], [4720, 20], [4860, 25], [4995, 30], [5122, 35], [5250, 40], [5375, 45], [5513, 50], [5657, 55], [5811, 60], [5978, 65], [6169, 70], [6386, 75], [6648, 80], [6977, 85], [7450, 90], [8261, 95], [9342, 98], [10148, 99]],
    run_total: [[1764, 1], [1838, 2], [1958, 5], [2079, 10], [2169, 15], [2244, 20], [2313, 25], [2377, 30], [2439, 35], [2502, 40], [2565, 45], [2629, 50], [2696, 55], [2767, 60], [2846, 65], [2932, 70], [3034, 75], [3157, 80], [3312, 85], [3544, 90], [3953, 95], [4498, 98], [4898, 99]],
    work_total: [[1605, 1], [1667, 2], [1773, 5], [1880, 10], [1960, 15], [2028, 20], [2090, 25], [2150, 30], [2208, 35], [2266, 40], [2325, 45], [2388, 50], [2454, 55], [2525, 60], [2603, 65], [2692, 70], [2792, 75], [2915, 80], [3070, 85], [3292, 90], [3675, 95], [4216, 98], [4653, 99]],
    roxzone: [[228, 1], [247, 2], [279, 5], [311, 10], [335, 15], [356, 20], [376, 25], [394, 30], [413, 35], [432, 40], [452, 45], [472, 50], [494, 55], [518, 60], [545, 65], [575, 70], [609, 75], [650, 80], [701, 85], [772, 90], [888, 95], [1033, 98], [1144, 99]],
    ski_erg: [[240, 1], [243, 2], [250, 5], [256, 10], [261, 15], [265, 20], [270, 25], [274, 30], [278, 35], [282, 40], [286, 45], [290, 50], [295, 55], [300, 60], [305, 65], [310, 70], [316, 75], [323, 80], [331, 85], [341, 90], [359, 95], [381, 98], [397, 99]],
    sled_push: [[108, 1], [115, 2], [126, 5], [136, 10], [144, 15], [150, 20], [156, 25], [162, 30], [168, 35], [173, 40], [179, 45], [184, 50], [191, 55], [197, 60], [204, 65], [213, 70], [222, 75], [234, 80], [249, 85], [271, 90], [312, 95], [378, 98], [439, 99]],
    sled_pull: [[186, 1], [196, 2], [215, 5], [232, 10], [245, 15], [257, 20], [268, 25], [278, 30], [288, 35], [298, 40], [308, 45], [319, 50], [330, 55], [342, 60], [355, 65], [370, 70], [387, 75], [408, 80], [435, 85], [472, 90], [534, 95], [621, 98], [691, 99]],
    burpee_broad_jumps: [[181, 1], [197, 2], [222, 5], [246, 10], [264, 15], [280, 20], [295, 25], [309, 30], [322, 35], [335, 40], [349, 45], [363, 50], [379, 55], [395, 60], [413, 65], [433, 70], [457, 75], [485, 80], [521, 85], [573, 90], [663, 95], [796, 98], [904, 99]],
    row_erg: [[253, 1], [257, 2], [264, 5], [272, 10], [277, 15], [282, 20], [287, 25], [291, 30], [296, 35], [300, 40], [305, 45], [309, 50], [314, 55], [319, 60], [324, 65], [329, 70], [336, 75], [343, 80], [352, 85], [364, 90], [385, 95], [413, 98], [437, 99]],
    farmer_carry: [[84, 1], [89, 2], [96, 5], [103, 10], [108, 15], [113, 20], [117, 25], [121, 30], [124, 35], [128, 40], [132, 45], [136, 50], [140, 55], [145, 60], [150, 65], [156, 70], [164, 75], [172, 80], [183, 85], [198, 90], [225, 95], [259, 98], [290, 99]],
    sandbag_lunges: [[179, 1], [194, 2], [214, 5], [233, 10], [247, 15], [259, 20], [269, 25], [280, 30], [290, 35], [300, 40], [310, 45], [321, 50], [333, 55], [345, 60], [359, 65], [375, 70], [393, 75], [416, 80], [445, 85], [488, 90], [568, 95], [692, 98], [808, 99]],
    wall_balls: [[228, 1], [244, 2], [268, 5], [294, 10], [313, 15], [331, 20], [346, 25], [362, 30], [378, 35], [394, 40], [411, 45], [428, 50], [448, 55], [469, 60], [493, 65], [520, 70], [552, 75], [592, 80], [644, 85], [720, 90], [859, 95], [1065, 98], [1238, 99]],
  },
  pro_singles: {
    total: [[3509, 1], [3811, 5], [4008, 10], [4155, 15], [4289, 20], [4410, 25], [4526, 30], [4640, 35], [4758, 40], [4874, 45], [4991, 50], [5114, 55], [5247, 60], [5392, 65], [5559, 70], [5747, 75], [5968, 80], [6261, 85], [6685, 90], [7426, 95], [9316, 99]],
    run_total: [[1611, 1], [1775, 5], [1859, 10], [1923, 15], [1979, 20], [2030, 25], [2079, 30], [2127, 35], [2174, 40], [2223, 45], [2274, 50], [2328, 55], [2385, 60], [2446, 65], [2514, 70], [2591, 75], [2686, 80], [2811, 85], [2988, 90], [3312, 95], [4167, 99]],
    work_total: [[1528, 1], [1690, 5], [1796, 10], [1872, 15], [1942, 20], [2006, 25], [2065, 30], [2123, 35], [2181, 40], [2243, 45], [2303, 50], [2365, 55], [2435, 60], [2511, 65], [2597, 70], [2693, 75], [2810, 80], [2959, 85], [3177, 90], [3563, 95], [4595, 99]],
    roxzone: [[202, 1], [241, 5], [265, 10], [282, 15], [298, 20], [313, 25], [327, 30], [341, 35], [356, 40], [372, 45], [388, 50], [406, 55], [426, 60], [448, 65], [473, 70], [503, 75], [540, 80], [586, 85], [651, 90], [759, 95], [995, 99]],
    ski_erg: [[229, 1], [237, 5], [242, 10], [246, 15], [250, 20], [253, 25], [256, 30], [258, 35], [261, 40], [265, 45], [268, 50], [271, 55], [275, 60], [279, 65], [284, 70], [289, 75], [294, 80], [301, 85], [309, 90], [323, 95], [353, 99]],
    sled_push: [[140, 1], [160, 5], [173, 10], [182, 15], [191, 20], [198, 25], [205, 30], [213, 35], [220, 40], [227, 45], [235, 50], [243, 55], [253, 60], [263, 65], [274, 70], [288, 75], [304, 80], [326, 85], [357, 90], [419, 95], [585, 99]],
    sled_pull: [[201, 1], [229, 5], [247, 10], [261, 15], [274, 20], [285, 25], [297, 30], [308, 35], [320, 40], [332, 45], [345, 50], [358, 55], [373, 60], [389, 65], [407, 70], [429, 75], [456, 80], [491, 85], [540, 90], [630, 95], [864, 99]],
    burpee_broad_jumps: [[150, 1], [175, 5], [193, 10], [206, 15], [218, 20], [228, 25], [238, 30], [248, 35], [258, 40], [268, 45], [278, 50], [290, 55], [301, 60], [314, 65], [328, 70], [345, 75], [365, 80], [389, 85], [424, 90], [485, 95], [653, 99]],
    row_erg: [[239, 1], [249, 5], [256, 10], [261, 15], [264, 20], [268, 25], [271, 30], [275, 35], [278, 40], [282, 45], [285, 50], [289, 55], [293, 60], [297, 65], [302, 70], [307, 75], [313, 80], [320, 85], [330, 90], [348, 95], [390, 99]],
    farmer_carry: [[83, 1], [93, 5], [99, 10], [104, 15], [109, 20], [114, 25], [119, 30], [124, 35], [129, 40], [134, 45], [140, 50], [146, 55], [152, 60], [159, 65], [167, 70], [176, 75], [186, 80], [200, 85], [219, 90], [250, 95], [334, 99]],
    sandbag_lunges: [[170, 1], [201, 5], [219, 10], [233, 15], [244, 20], [255, 25], [265, 30], [275, 35], [285, 40], [295, 45], [305, 50], [316, 55], [327, 60], [340, 65], [353, 70], [369, 75], [389, 80], [415, 85], [455, 90], [532, 95], [748, 99]],
    wall_balls: [[219, 1], [255, 5], [278, 10], [297, 15], [313, 20], [328, 25], [343, 30], [358, 35], [373, 40], [388, 45], [404, 50], [421, 55], [440, 60], [461, 65], [485, 70], [514, 75], [550, 80], [597, 85], [666, 90], [797, 95], [1176, 99]],
  },
  open_doubles: {
    total: [[3511, 1], [3625, 2], [3845, 5], [4066, 10], [4223, 15], [4357, 20], [4477, 25], [4589, 30], [4696, 35], [4799, 40], [4903, 45], [5009, 50], [5118, 55], [5233, 60], [5356, 65], [5494, 70], [5654, 75], [5845, 80], [6081, 85], [6411, 90], [6960, 95], [7694, 98], [8268, 99]],
    run_total: [[1819, 1], [1899, 2], [2035, 5], [2177, 10], [2277, 15], [2363, 20], [2438, 25], [2508, 30], [2574, 35], [2639, 40], [2703, 45], [2767, 50], [2833, 55], [2902, 60], [2977, 65], [3058, 70], [3152, 75], [3265, 80], [3409, 85], [3614, 90], [3969, 95], [4451, 98], [4814, 99]],
    work_total: [[1310, 1], [1349, 2], [1412, 5], [1477, 10], [1524, 15], [1565, 20], [1601, 25], [1636, 30], [1669, 35], [1702, 40], [1735, 45], [1769, 50], [1804, 55], [1842, 60], [1883, 65], [1929, 70], [1981, 75], [2043, 80], [2122, 85], [2232, 90], [2426, 95], [2692, 98], [2910, 99]],
    roxzone: [[219, 1], [238, 2], [270, 5], [301, 10], [324, 15], [343, 20], [361, 25], [379, 30], [395, 35], [413, 40], [430, 45], [449, 50], [469, 55], [491, 60], [515, 65], [542, 70], [573, 75], [610, 80], [659, 85], [724, 90], [828, 95], [957, 98], [1054, 99]],
    ski_erg: [[218, 1], [222, 2], [228, 5], [235, 10], [240, 15], [244, 20], [248, 25], [252, 30], [255, 35], [259, 40], [263, 45], [266, 50], [270, 55], [274, 60], [278, 65], [283, 70], [288, 75], [293, 80], [300, 85], [309, 90], [322, 95], [338, 98], [350, 99]],
    sled_push: [[77, 1], [81, 2], [87, 5], [93, 10], [97, 15], [101, 20], [104, 25], [107, 30], [110, 35], [113, 40], [116, 45], [120, 50], [123, 55], [127, 60], [131, 65], [135, 70], [141, 75], [147, 80], [155, 85], [167, 90], [189, 95], [224, 98], [257, 99]],
    sled_pull: [[138, 1], [147, 2], [161, 5], [175, 10], [185, 15], [193, 20], [201, 25], [208, 30], [215, 35], [221, 40], [228, 45], [235, 50], [242, 55], [249, 60], [258, 65], [266, 70], [277, 75], [289, 80], [304, 85], [324, 90], [360, 95], [409, 98], [451, 99]],
    burpee_broad_jumps: [[122, 1], [131, 2], [144, 5], [158, 10], [168, 15], [177, 20], [185, 25], [193, 30], [201, 35], [208, 40], [216, 45], [224, 50], [232, 55], [241, 60], [250, 65], [261, 70], [273, 75], [287, 80], [306, 85], [331, 90], [376, 95], [439, 98], [490, 99]],
    row_erg: [[238, 1], [243, 2], [250, 5], [258, 10], [263, 15], [268, 20], [273, 25], [277, 30], [281, 35], [285, 40], [289, 45], [293, 50], [297, 55], [301, 60], [306, 65], [311, 70], [316, 75], [322, 80], [329, 85], [338, 90], [354, 95], [374, 98], [389, 99]],
    farmer_carry: [[75, 1], [78, 2], [83, 5], [88, 10], [91, 15], [94, 20], [97, 25], [99, 30], [102, 35], [104, 40], [106, 45], [109, 50], [111, 55], [113, 60], [116, 65], [119, 70], [122, 75], [125, 80], [130, 85], [135, 90], [145, 95], [159, 98], [175, 99]],
    sandbag_lunges: [[142, 1], [151, 2], [164, 5], [176, 10], [185, 15], [193, 20], [199, 25], [206, 30], [212, 35], [218, 40], [224, 45], [231, 50], [238, 55], [245, 60], [253, 65], [262, 70], [273, 75], [285, 80], [301, 85], [323, 90], [364, 95], [421, 98], [470, 99]],
    wall_balls: [[203, 1], [208, 2], [216, 5], [225, 10], [231, 15], [237, 20], [243, 25], [248, 30], [253, 35], [259, 40], [265, 45], [272, 50], [279, 55], [286, 60], [295, 65], [306, 70], [319, 75], [335, 80], [357, 85], [391, 90], [454, 95], [551, 98], [637, 99]],
  },
  pro_doubles: {
    total: [[3211, 1], [3464, 5], [3614, 10], [3749, 15], [3858, 20], [3961, 25], [4056, 30], [4145, 35], [4233, 40], [4325, 45], [4421, 50], [4518, 55], [4621, 60], [4730, 65], [4849, 70], [4995, 75], [5165, 80], [5372, 85], [5668, 90], [6211, 95], [7510, 99]],
    run_total: [[1619, 1], [1777, 5], [1871, 10], [1943, 15], [2007, 20], [2068, 25], [2125, 30], [2180, 35], [2233, 40], [2289, 45], [2345, 50], [2403, 55], [2463, 60], [2527, 65], [2599, 70], [2678, 75], [2771, 80], [2890, 85], [3054, 90], [3369, 95], [4194, 99]],
    work_total: [[1271, 1], [1366, 5], [1425, 10], [1468, 15], [1505, 20], [1538, 25], [1570, 30], [1600, 35], [1631, 40], [1662, 45], [1693, 50], [1726, 55], [1763, 60], [1802, 65], [1844, 70], [1894, 75], [1953, 80], [2030, 85], [2136, 90], [2339, 95], [2847, 99]],
    roxzone: [[183, 1], [224, 5], [247, 10], [264, 15], [279, 20], [292, 25], [305, 30], [318, 35], [332, 40], [346, 45], [361, 50], [377, 55], [395, 60], [414, 65], [437, 70], [464, 75], [498, 80], [542, 85], [606, 90], [700, 95], [899, 99]],
    ski_erg: [[206, 1], [214, 5], [219, 10], [222, 15], [226, 20], [229, 25], [232, 30], [234, 35], [237, 40], [241, 45], [244, 50], [248, 55], [252, 60], [257, 65], [261, 70], [266, 75], [271, 80], [277, 85], [285, 90], [297, 95], [322, 99]],
    sled_push: [[91, 1], [103, 5], [110, 10], [115, 15], [119, 20], [123, 25], [126, 30], [130, 35], [134, 40], [137, 45], [141, 50], [145, 55], [150, 60], [155, 65], [160, 70], [166, 75], [174, 80], [184, 85], [199, 90], [227, 95], [312, 99]],
    sled_pull: [[164, 1], [184, 5], [196, 10], [205, 15], [213, 20], [220, 25], [227, 30], [234, 35], [240, 40], [247, 45], [254, 50], [261, 55], [269, 60], [278, 65], [287, 70], [298, 75], [311, 80], [329, 85], [353, 90], [396, 95], [513, 99]],
    burpee_broad_jumps: [[104, 1], [120, 5], [130, 10], [138, 15], [145, 20], [151, 25], [157, 30], [162, 35], [168, 40], [174, 45], [180, 50], [185, 55], [192, 60], [199, 65], [207, 70], [216, 75], [227, 80], [240, 85], [260, 90], [294, 95], [388, 99]],
    row_erg: [[223, 1], [233, 5], [239, 10], [244, 15], [248, 20], [251, 25], [255, 30], [258, 35], [262, 40], [266, 45], [269, 50], [273, 55], [277, 60], [282, 65], [286, 70], [291, 75], [297, 80], [303, 85], [313, 90], [327, 95], [360, 99]],
    farmer_carry: [[76, 1], [83, 5], [88, 10], [90, 15], [93, 20], [95, 25], [97, 30], [99, 35], [101, 40], [103, 45], [106, 50], [108, 55], [110, 60], [113, 65], [116, 70], [119, 75], [122, 80], [127, 85], [133, 90], [143, 95], [173, 99]],
    sandbag_lunges: [[138, 1], [159, 5], [171, 10], [179, 15], [187, 20], [194, 25], [200, 30], [206, 35], [212, 40], [218, 45], [225, 50], [231, 55], [238, 60], [245, 65], [253, 70], [263, 75], [275, 80], [290, 85], [311, 90], [348, 95], [451, 99]],
    wall_balls: [[199, 1], [209, 5], [215, 10], [220, 15], [225, 20], [230, 25], [234, 30], [239, 35], [243, 40], [248, 45], [254, 50], [260, 55], [266, 60], [274, 65], [284, 70], [295, 75], [310, 80], [332, 85], [363, 90], [431, 95], [624, 99]],
  },
};
export const HYROX_S89_POOLED_GRIDS: Partial<Record<HyroxResultsFormat, Record<HyroxResultsMetric, HyroxGridName>>> = {
  open_singles: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
  pro_singles: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
  open_doubles: { total: 'fine', run_total: 'fine', work_total: 'fine', roxzone: 'fine', ski_erg: 'fine', sled_push: 'fine', sled_pull: 'fine', burpee_broad_jumps: 'fine', row_erg: 'fine', farmer_carry: 'fine', sandbag_lunges: 'fine', wall_balls: 'fine' },
  pro_doubles: { total: 'five_point', run_total: 'five_point', work_total: 'five_point', roxzone: 'five_point', ski_erg: 'five_point', sled_push: 'five_point', sled_pull: 'five_point', burpee_broad_jumps: 'five_point', row_erg: 'five_point', farmer_carry: 'five_point', sandbag_lunges: 'five_point', wall_balls: 'five_point' },
};

/** Median split per run leg (run 1 to run 8), seconds. Same rows as run_total. */
export const HYROX_S79_RUN_LEG_MEDIANS_SEC: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, readonly number[]>>> = {
  open_singles: { female: [312, 330, 347, 349, 359, 352, 351, 388], male: [275, 290, 312, 312, 323, 315, 314, 352] },
  pro_singles: { female: [267, 284, 302, 303, 309, 305, 309, 335], male: [243, 256, 278, 280, 285, 279, 283, 311] },
  open_doubles: { female: [337, 349, 365, 368, 376, 373, 372, 398], male: [287, 296, 316, 318, 326, 321, 321, 341], mixed: [312, 323, 340, 341, 349, 345, 346, 368] },
  pro_doubles: { female: [288, 303, 321, 322, 326, 325, 328, 346], male: [248, 260, 281, 281, 285, 281, 285, 300] },
};

/**
 * Age-group bands per format. Singles keep the 5-year bands in the data.
 * Doubles pool onto 10-year bands: season 7 doubles used 10-year bands
 * (U29 coded MU29/WU29/XU29, 30-39 coded "30-34", 70+ coded M70+/W70+/X70+),
 * seasons 8 and 9 use 5-year bands, and only the 10-year grid is common to all.
 * The dataset carries one age label per team; how HYROX assigns it (the brief
 * says pair average) cannot be checked from the data.
 */
export const HYROX_S79_AGE_GROUPS: Record<HyroxResultsFormat, readonly string[]> = {
  open_singles: ['16-24', '25-29', '30-34', '35-39', '40-44', '45-49', '50-54', '55-59', '60-64', '65-69', '70-74', '75-79'],
  pro_singles: ['16-24', '25-29', '30-34', '35-39', '40-44', '45-49', '50-54', '55-59', '60-64', '65-69', '70-74', '75-79'],
  open_doubles: ['16-29', '30-39', '40-49', '50-59', '60-69', '70+'],
  pro_doubles: ['16-29', '30-39', '40-49', '50-59', '60-69', '70+'],
};

/** Source label -> published band, with rows mapped (total-table rows only). */
export const HYROX_S79_AGE_LABEL_MAPPING: ReadonlyArray<{ format: HyroxResultsFormat; label: string; band: string; rows: number }> = [
  { format: 'open_singles', label: '16-24', band: '16-24', rows: 48983 },
  { format: 'open_singles', label: '25-29', band: '25-29', rows: 90190 },
  { format: 'open_singles', label: '30-34', band: '30-34', rows: 104367 },
  { format: 'open_singles', label: '35-39', band: '35-39', rows: 87303 },
  { format: 'open_singles', label: '40-44', band: '40-44', rows: 60465 },
  { format: 'open_singles', label: '45-49', band: '45-49', rows: 34467 },
  { format: 'open_singles', label: '50-54', band: '50-54', rows: 18390 },
  { format: 'open_singles', label: '55-59', band: '55-59', rows: 8585 },
  { format: 'open_singles', label: '60-64', band: '60-64', rows: 4041 },
  { format: 'open_singles', label: '65-69', band: '65-69', rows: 1124 },
  { format: 'open_singles', label: '70-74', band: '70-74', rows: 269 },
  { format: 'open_singles', label: '75-79', band: '75-79', rows: 32 },
  { format: 'pro_singles', label: '16-24', band: '16-24', rows: 7653 },
  { format: 'pro_singles', label: '25-29', band: '25-29', rows: 16377 },
  { format: 'pro_singles', label: '30-34', band: '30-34', rows: 20851 },
  { format: 'pro_singles', label: '35-39', band: '35-39', rows: 16208 },
  { format: 'pro_singles', label: '40-44', band: '40-44', rows: 9769 },
  { format: 'pro_singles', label: '45-49', band: '45-49', rows: 5312 },
  { format: 'pro_singles', label: '50-54', band: '50-54', rows: 2815 },
  { format: 'pro_singles', label: '55-59', band: '55-59', rows: 1258 },
  { format: 'pro_singles', label: '60-64', band: '60-64', rows: 85 },
  { format: 'pro_singles', label: '65-69', band: '65-69', rows: 10 },
  { format: 'open_doubles', label: '16-24', band: '16-29', rows: 49633 },
  { format: 'open_doubles', label: '25-29', band: '16-29', rows: 96753 },
  { format: 'open_doubles', label: 'MU29', band: '16-29', rows: 13606 },
  { format: 'open_doubles', label: 'WU29', band: '16-29', rows: 16288 },
  { format: 'open_doubles', label: 'XU29', band: '16-29', rows: 14309 },
  { format: 'open_doubles', label: '30-34', band: '30-39', rows: 164376 },
  { format: 'open_doubles', label: '35-39', band: '30-39', rows: 79632 },
  { format: 'open_doubles', label: '40-44', band: '40-49', rows: 71209 },
  { format: 'open_doubles', label: '45-49', band: '40-49', rows: 22489 },
  { format: 'open_doubles', label: '50-54', band: '50-59', rows: 13077 },
  { format: 'open_doubles', label: '55-59', band: '50-59', rows: 2948 },
  { format: 'open_doubles', label: '60-64', band: '60-69', rows: 1317 },
  { format: 'open_doubles', label: '65-69', band: '60-69', rows: 184 },
  { format: 'open_doubles', label: '70-74', band: '70+', rows: 33 },
  { format: 'open_doubles', label: '75-79', band: '70+', rows: 33 },
  { format: 'open_doubles', label: 'M70+', band: '70+', rows: 6 },
  { format: 'open_doubles', label: 'W70+', band: '70+', rows: 4 },
  { format: 'open_doubles', label: 'X70+', band: '70+', rows: 17 },
  { format: 'pro_doubles', label: '16-24', band: '16-29', rows: 4218 },
  { format: 'pro_doubles', label: '16-29', band: '16-29', rows: 52 },
  { format: 'pro_doubles', label: '25-29', band: '16-29', rows: 9907 },
  { format: 'pro_doubles', label: 'MU29', band: '16-29', rows: 2000 },
  { format: 'pro_doubles', label: 'WU29', band: '16-29', rows: 1260 },
  { format: 'pro_doubles', label: '30-34', band: '30-39', rows: 18381 },
  { format: 'pro_doubles', label: '30-39', band: '30-39', rows: 104 },
  { format: 'pro_doubles', label: '35-39', band: '30-39', rows: 9140 },
  { format: 'pro_doubles', label: '40-44', band: '40-49', rows: 7016 },
  { format: 'pro_doubles', label: '40-49', band: '40-49', rows: 28 },
  { format: 'pro_doubles', label: '45-49', band: '40-49', rows: 2195 },
  { format: 'pro_doubles', label: '50-54', band: '50-59', rows: 1377 },
  { format: 'pro_doubles', label: '50-59', band: '50-59', rows: 5 },
  { format: 'pro_doubles', label: '55-59', band: '50-59', rows: 332 },
  { format: 'pro_doubles', label: '60-64', band: '60-69', rows: 18 },
  { format: 'pro_doubles', label: '65-69', band: '60-69', rows: 4 },
  { format: 'pro_doubles', label: '70-74', band: '70+', rows: 3 },
  { format: 'pro_doubles', label: '75-79', band: '70+', rows: 18 },
  { format: 'pro_doubles', label: 'W70+', band: '70+', rows: 1 },
];

/** Total-table rows left out of the age tables, by format and reason
 *  (ambiguous_age_label: rule 3b, one result carried two age labels). */
export const HYROX_S79_AGE_DROPS: ReadonlyArray<{ format: HyroxResultsFormat; reason: string; rows: number }> = [
  { format: 'open_singles', reason: 'ambiguous_age_label', rows: 47 },
  { format: 'open_singles', reason: 'empty_age_group', rows: 156 },
  { format: 'pro_singles', reason: 'ambiguous_age_label', rows: 4 },
  { format: 'pro_singles', reason: 'empty_age_group', rows: 36 },
  { format: 'open_doubles', reason: 'age_code_sex_conflict', rows: 88 },
  { format: 'open_doubles', reason: 'ambiguous_age_label', rows: 2 },
  { format: 'open_doubles', reason: 'empty_age_group', rows: 1964 },
  { format: 'pro_doubles', reason: 'ambiguous_age_label', rows: 1 },
  { format: 'pro_doubles', reason: 'empty_age_group', rows: 82 },
];

/** Total-time percentile tables per format x sex x age band. */
export const HYROX_S79_AGE_TOTAL_PERCENTILES: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<string, HyroxPercentileTable>>>> = {
  open_singles: {
    female: {
      '16-24': [[4094, 1], [4448, 5], [4675, 10], [4840, 15], [4988, 20], [5123, 25], [5245, 30], [5357, 35], [5482, 40], [5605, 45], [5731, 50], [5863, 55], [6004, 60], [6157, 65], [6332, 70], [6535, 75], [6780, 80], [7073, 85], [7499, 90], [8224, 95], [9950, 99]],
      '25-29': [[4075, 1], [4421, 5], [4641, 10], [4798, 15], [4939, 20], [5059, 25], [5181, 30], [5291, 35], [5403, 40], [5531, 45], [5655, 50], [5786, 55], [5924, 60], [6078, 65], [6255, 70], [6461, 75], [6700, 80], [7007, 85], [7445, 90], [8235, 95], [10096, 99]],
      '30-34': [[4098, 1], [4437, 5], [4650, 10], [4807, 15], [4951, 20], [5081, 25], [5197, 30], [5313, 35], [5427, 40], [5553, 45], [5679, 50], [5815, 55], [5958, 60], [6132, 65], [6320, 70], [6527, 75], [6771, 80], [7096, 85], [7562, 90], [8354, 95], [10265, 99]],
      '35-39': [[4117, 1], [4477, 5], [4703, 10], [4868, 15], [5013, 20], [5146, 25], [5269, 30], [5391, 35], [5516, 40], [5637, 45], [5763, 50], [5898, 55], [6050, 60], [6210, 65], [6385, 70], [6597, 75], [6849, 80], [7164, 85], [7622, 90], [8399, 95], [10261, 99]],
      '40-44': [[4158, 1], [4511, 5], [4743, 10], [4913, 15], [5056, 20], [5180, 25], [5300, 30], [5419, 35], [5543, 40], [5665, 45], [5796, 50], [5933, 55], [6084, 60], [6244, 65], [6435, 70], [6642, 75], [6898, 80], [7204, 85], [7681, 90], [8491, 95], [10255, 99]],
      '45-49': [[4255, 1], [4590, 5], [4813, 10], [4985, 15], [5128, 20], [5263, 25], [5389, 30], [5516, 35], [5644, 40], [5769, 45], [5907, 50], [6046, 55], [6197, 60], [6373, 65], [6554, 70], [6767, 75], [7034, 80], [7380, 85], [7893, 90], [8669, 95], [10427, 99]],
      '50-54': [[4450, 1], [4748, 5], [4971, 10], [5130, 15], [5269, 20], [5416, 25], [5540, 30], [5668, 35], [5790, 40], [5909, 45], [6046, 50], [6193, 55], [6326, 60], [6495, 65], [6675, 70], [6906, 75], [7198, 80], [7542, 85], [7997, 90], [8799, 95], [10561, 99]],
      '55-59': [[5148, 10], [5490, 20], [5753, 30], [6024, 40], [6303, 50], [6623, 60], [7026, 70], [7554, 80], [8485, 90]],
      '60-64': [[5060, 10], [5417, 20], [5738, 30], [6101, 40], [6378, 50], [6670, 60], [7068, 70], [7522, 80], [8411, 90]],
      '65-69': [[6174, 25], [7019, 50], [8113, 75]],
    },
    male: {
      '16-24': [[3614, 1], [3929, 5], [4134, 10], [4290, 15], [4430, 20], [4560, 25], [4680, 30], [4800, 35], [4925, 40], [5051, 45], [5177, 50], [5303, 55], [5442, 60], [5602, 65], [5777, 70], [5979, 75], [6243, 80], [6565, 85], [6994, 90], [7765, 95], [9682, 99]],
      '25-29': [[3636, 1], [3939, 5], [4134, 10], [4290, 15], [4424, 20], [4549, 25], [4666, 30], [4779, 35], [4896, 40], [5018, 45], [5137, 50], [5264, 55], [5396, 60], [5551, 65], [5721, 70], [5924, 75], [6164, 80], [6484, 85], [6932, 90], [7736, 95], [9669, 99]],
      '30-34': [[3646, 1], [3969, 5], [4170, 10], [4327, 15], [4455, 20], [4580, 25], [4696, 30], [4807, 35], [4922, 40], [5038, 45], [5158, 50], [5284, 55], [5417, 60], [5576, 65], [5748, 70], [5951, 75], [6200, 80], [6509, 85], [6945, 90], [7696, 95], [9468, 99]],
      '35-39': [[3719, 1], [4045, 5], [4250, 10], [4406, 15], [4540, 20], [4663, 25], [4776, 30], [4893, 35], [5010, 40], [5127, 45], [5251, 50], [5375, 55], [5513, 60], [5668, 65], [5839, 70], [6033, 75], [6268, 80], [6572, 85], [6995, 90], [7776, 95], [9631, 99]],
      '40-44': [[3793, 1], [4127, 5], [4344, 10], [4500, 15], [4638, 20], [4765, 25], [4887, 30], [5006, 35], [5131, 40], [5248, 45], [5363, 50], [5492, 55], [5632, 60], [5790, 65], [5965, 70], [6171, 75], [6405, 80], [6704, 85], [7111, 90], [7855, 95], [9575, 99]],
      '45-49': [[3890, 1], [4236, 5], [4453, 10], [4620, 15], [4754, 20], [4886, 25], [4998, 30], [5115, 35], [5232, 40], [5355, 45], [5479, 50], [5610, 55], [5749, 60], [5900, 65], [6069, 70], [6270, 75], [6504, 80], [6808, 85], [7233, 90], [7926, 95], [9658, 99]],
      '50-54': [[4025, 1], [4381, 5], [4598, 10], [4757, 15], [4900, 20], [5048, 25], [5169, 30], [5291, 35], [5403, 40], [5531, 45], [5660, 50], [5792, 55], [5940, 60], [6089, 65], [6269, 70], [6473, 75], [6708, 80], [7013, 85], [7457, 90], [8242, 95], [9979, 99]],
      '55-59': [[4097, 1], [4553, 5], [4806, 10], [4976, 15], [5127, 20], [5267, 25], [5381, 30], [5511, 35], [5637, 40], [5767, 45], [5905, 50], [6039, 55], [6188, 60], [6362, 65], [6550, 70], [6755, 75], [6992, 80], [7292, 85], [7728, 90], [8507, 95], [10276, 99]],
      '60-64': [[4887, 10], [5184, 20], [5473, 30], [5771, 40], [6032, 50], [6328, 60], [6704, 70], [7180, 80], [8050, 90]],
      '65-69': [[5203, 10], [5494, 20], [5836, 30], [6229, 40], [6560, 50], [6925, 60], [7358, 70], [7994, 80], [8791, 90]],
      '70-74': [[6326, 25], [7152, 50], [8177, 75]],
    },
  },
  pro_singles: {
    female: {
      '16-24': [[4255, 10], [4486, 20], [4734, 30], [4963, 40], [5192, 50], [5456, 60], [5790, 70], [6215, 80], [6994, 90]],
      '25-29': [[3667, 1], [3926, 5], [4095, 10], [4220, 15], [4355, 20], [4479, 25], [4607, 30], [4744, 35], [4854, 40], [4958, 45], [5085, 50], [5221, 55], [5343, 60], [5484, 65], [5632, 70], [5801, 75], [5993, 80], [6269, 85], [6663, 90], [7352, 95], [9228, 99]],
      '30-34': [[3755, 1], [4002, 5], [4189, 10], [4346, 15], [4470, 20], [4592, 25], [4710, 30], [4823, 35], [4933, 40], [5040, 45], [5155, 50], [5276, 55], [5408, 60], [5552, 65], [5712, 70], [5904, 75], [6128, 80], [6414, 85], [6815, 90], [7528, 95], [9393, 99]],
      '35-39': [[3806, 1], [4071, 5], [4233, 10], [4369, 15], [4486, 20], [4614, 25], [4728, 30], [4854, 35], [4961, 40], [5081, 45], [5208, 50], [5320, 55], [5453, 60], [5585, 65], [5742, 70], [5933, 75], [6150, 80], [6455, 85], [6863, 90], [7550, 95], [9336, 99]],
      '40-44': [[4386, 10], [4618, 20], [4851, 30], [5050, 40], [5279, 50], [5529, 60], [5840, 70], [6226, 80], [6920, 90]],
      '45-49': [[4533, 10], [4758, 20], [4935, 30], [5125, 40], [5336, 50], [5594, 60], [5913, 70], [6317, 80], [7083, 90]],
      '50-54': [[4788, 10], [5002, 20], [5149, 30], [5321, 40], [5499, 50], [5696, 60], [5938, 70], [6362, 80], [7036, 90]],
      '55-59': [[5103, 10], [5336, 25], [5838, 50], [6485, 75], [7304, 90]],
    },
    male: {
      '16-24': [[3488, 1], [3696, 5], [3851, 10], [3980, 15], [4092, 20], [4193, 25], [4319, 30], [4427, 35], [4528, 40], [4638, 45], [4753, 50], [4861, 55], [5006, 60], [5167, 65], [5322, 70], [5500, 75], [5748, 80], [6057, 85], [6500, 90], [7285, 95], [9318, 99]],
      '25-29': [[3426, 1], [3664, 5], [3849, 10], [3982, 15], [4103, 20], [4199, 25], [4311, 30], [4422, 35], [4531, 40], [4642, 45], [4758, 50], [4874, 55], [5000, 60], [5144, 65], [5299, 70], [5476, 75], [5691, 80], [5971, 85], [6382, 90], [7056, 95], [8924, 99]],
      '30-34': [[3433, 1], [3684, 5], [3867, 10], [4011, 15], [4127, 20], [4242, 25], [4351, 30], [4458, 35], [4562, 40], [4672, 45], [4780, 50], [4899, 55], [5029, 60], [5167, 65], [5317, 70], [5492, 75], [5701, 80], [5962, 85], [6361, 90], [7025, 95], [8758, 99]],
      '35-39': [[3556, 1], [3804, 5], [3982, 10], [4115, 15], [4248, 20], [4370, 25], [4478, 30], [4589, 35], [4706, 40], [4804, 45], [4910, 50], [5018, 55], [5140, 60], [5273, 65], [5423, 70], [5603, 75], [5804, 80], [6078, 85], [6461, 90], [7093, 95], [8831, 99]],
      '40-44': [[3607, 1], [3896, 5], [4077, 10], [4212, 15], [4330, 20], [4451, 25], [4569, 30], [4667, 35], [4776, 40], [4882, 45], [4986, 50], [5093, 55], [5221, 60], [5370, 65], [5526, 70], [5704, 75], [5903, 80], [6187, 85], [6588, 90], [7275, 95], [9087, 99]],
      '45-49': [[4242, 10], [4463, 20], [4664, 30], [4871, 40], [5090, 50], [5313, 60], [5595, 70], [5995, 80], [6660, 90]],
      '50-54': [[4420, 10], [4642, 20], [4834, 30], [5025, 40], [5237, 50], [5485, 60], [5741, 70], [6123, 80], [6716, 90]],
      '55-59': [[4588, 10], [4822, 20], [5068, 30], [5250, 40], [5472, 50], [5760, 60], [6152, 70], [6512, 80], [7053, 90]],
    },
  },
  open_doubles: {
    female: {
      '16-29': [[3924, 1], [4217, 5], [4403, 10], [4534, 15], [4647, 20], [4746, 25], [4839, 30], [4926, 35], [5012, 40], [5100, 45], [5189, 50], [5281, 55], [5379, 60], [5486, 65], [5607, 70], [5743, 75], [5904, 80], [6098, 85], [6380, 90], [6852, 95], [7929, 99]],
      '30-39': [[3944, 1], [4054, 2], [4258, 5], [4448, 10], [4586, 15], [4704, 20], [4807, 25], [4904, 30], [4999, 35], [5094, 40], [5186, 45], [5284, 50], [5381, 55], [5492, 60], [5610, 65], [5744, 70], [5894, 75], [6077, 80], [6305, 85], [6616, 90], [7137, 95], [7845, 98], [8426, 99]],
      '40-49': [[4054, 1], [4373, 5], [4570, 10], [4709, 15], [4826, 20], [4933, 25], [5030, 30], [5131, 35], [5229, 40], [5324, 45], [5426, 50], [5533, 55], [5648, 60], [5781, 65], [5918, 70], [6073, 75], [6271, 80], [6504, 85], [6825, 90], [7378, 95], [8625, 99]],
      '50-59': [[4265, 1], [4583, 5], [4781, 10], [4916, 15], [5040, 20], [5146, 25], [5255, 30], [5352, 35], [5449, 40], [5563, 45], [5670, 50], [5780, 55], [5903, 60], [6036, 65], [6201, 70], [6362, 75], [6559, 80], [6785, 85], [7125, 90], [7652, 95], [8960, 99]],
      '60-69': [[4990, 10], [5478, 25], [6146, 50], [6980, 75], [8162, 90]],
    },
    male: {
      '16-29': [[3350, 1], [3591, 5], [3754, 10], [3874, 15], [3976, 20], [4070, 25], [4156, 30], [4240, 35], [4324, 40], [4411, 45], [4499, 50], [4594, 55], [4694, 60], [4798, 65], [4917, 70], [5054, 75], [5221, 80], [5425, 85], [5732, 90], [6241, 95], [7483, 99]],
      '30-39': [[3378, 1], [3476, 2], [3626, 5], [3794, 10], [3917, 15], [4019, 20], [4113, 25], [4199, 30], [4286, 35], [4373, 40], [4458, 45], [4548, 50], [4641, 55], [4741, 60], [4850, 65], [4973, 70], [5114, 75], [5282, 80], [5497, 85], [5790, 90], [6318, 95], [6987, 98], [7549, 99]],
      '40-49': [[3474, 1], [3771, 5], [3961, 10], [4093, 15], [4205, 20], [4301, 25], [4390, 30], [4478, 35], [4570, 40], [4657, 45], [4747, 50], [4843, 55], [4944, 60], [5054, 65], [5173, 70], [5310, 75], [5477, 80], [5695, 85], [5994, 90], [6507, 95], [7717, 99]],
      '50-59': [[3668, 1], [3965, 5], [4141, 10], [4283, 15], [4402, 20], [4525, 25], [4625, 30], [4720, 35], [4815, 40], [4917, 45], [5021, 50], [5110, 55], [5228, 60], [5339, 65], [5460, 70], [5604, 75], [5776, 80], [5979, 85], [6282, 90], [6794, 95], [8013, 99]],
      '60-69': [[4317, 10], [4712, 25], [5338, 50], [6017, 75], [6770, 90]],
    },
    mixed: {
      '16-29': [[3518, 1], [3864, 5], [4077, 10], [4222, 15], [4344, 20], [4455, 25], [4556, 30], [4653, 35], [4746, 40], [4839, 45], [4935, 50], [5034, 55], [5140, 60], [5255, 65], [5380, 70], [5528, 75], [5708, 80], [5945, 85], [6265, 90], [6803, 95], [8116, 99]],
      '30-39': [[3532, 1], [3645, 2], [3859, 5], [4071, 10], [4216, 15], [4342, 20], [4450, 25], [4551, 30], [4650, 35], [4746, 40], [4841, 45], [4943, 50], [5046, 55], [5154, 60], [5275, 65], [5409, 70], [5570, 75], [5761, 80], [5990, 85], [6328, 90], [6908, 95], [7647, 98], [8265, 99]],
      '40-49': [[3633, 1], [3963, 5], [4191, 10], [4349, 15], [4472, 20], [4580, 25], [4682, 30], [4780, 35], [4882, 40], [4980, 45], [5083, 50], [5187, 55], [5302, 60], [5418, 65], [5559, 70], [5714, 75], [5903, 80], [6145, 85], [6491, 90], [7029, 95], [8415, 99]],
      '50-59': [[3835, 1], [4133, 5], [4358, 10], [4509, 15], [4652, 20], [4764, 25], [4880, 30], [4977, 35], [5094, 40], [5193, 45], [5313, 50], [5429, 55], [5560, 60], [5686, 65], [5845, 70], [6031, 75], [6240, 80], [6478, 85], [6830, 90], [7444, 95], [8750, 99]],
      '60-69': [[4755, 10], [5162, 25], [5726, 50], [6444, 75], [7406, 90]],
    },
  },
  pro_doubles: {
    female: {
      '16-29': [[3516, 1], [3782, 5], [3955, 10], [4079, 15], [4191, 20], [4289, 25], [4388, 30], [4479, 35], [4567, 40], [4665, 45], [4756, 50], [4857, 55], [4962, 60], [5062, 65], [5185, 70], [5308, 75], [5477, 80], [5679, 85], [5993, 90], [6579, 95], [7848, 99]],
      '30-39': [[3544, 1], [3813, 5], [3986, 10], [4123, 15], [4238, 20], [4343, 25], [4441, 30], [4530, 35], [4613, 40], [4700, 45], [4788, 50], [4878, 55], [4977, 60], [5088, 65], [5217, 70], [5353, 75], [5525, 80], [5743, 85], [6076, 90], [6616, 95], [7934, 99]],
      '40-49': [[4126, 10], [4318, 20], [4487, 30], [4661, 40], [4824, 50], [5032, 60], [5258, 70], [5565, 80], [6096, 90]],
      '50-59': [[4379, 10], [4636, 25], [5054, 50], [5523, 75], [6223, 90]],
    },
    male: {
      '16-29': [[3134, 1], [3338, 5], [3465, 10], [3557, 15], [3646, 20], [3738, 25], [3823, 30], [3903, 35], [3984, 40], [4062, 45], [4141, 50], [4229, 55], [4318, 60], [4422, 65], [4532, 70], [4659, 75], [4806, 80], [5009, 85], [5282, 90], [5790, 95], [7087, 99]],
      '30-39': [[3144, 1], [3379, 5], [3520, 10], [3626, 15], [3722, 20], [3810, 25], [3889, 30], [3965, 35], [4042, 40], [4117, 45], [4190, 50], [4274, 55], [4361, 60], [4455, 65], [4555, 70], [4673, 75], [4800, 80], [4974, 85], [5227, 90], [5667, 95], [6771, 99]],
      '40-49': [[3354, 1], [3532, 5], [3633, 10], [3734, 15], [3830, 20], [3919, 25], [3992, 30], [4071, 35], [4147, 40], [4218, 45], [4296, 50], [4385, 55], [4477, 60], [4578, 65], [4679, 70], [4786, 75], [4927, 80], [5114, 85], [5363, 90], [5795, 95], [7007, 99]],
      '50-59': [[3894, 10], [4057, 20], [4183, 30], [4303, 40], [4466, 50], [4607, 60], [4816, 70], [5136, 80], [5564, 90]],
    },
  },
};

/** Finishers behind each published age table. */
export const HYROX_S79_AGE_TOTAL_COUNTS: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<string, number>>>> = {
  open_singles: {
    female: { '16-24': 21334, '25-29': 35421, '30-34': 35457, '35-39': 28434, '40-44': 20093, '45-49': 11795, '50-54': 6024, '55-59': 2630, '60-64': 1170, '65-69': 289 },
    male: { '16-24': 27649, '25-29': 54769, '30-34': 68910, '35-39': 58869, '40-44': 40372, '45-49': 22672, '50-54': 12366, '55-59': 5955, '60-64': 2871, '65-69': 835, '70-74': 193 },
  },
  pro_singles: {
    female: { '16-24': 2647, '25-29': 5053, '30-34': 5817, '35-39': 4784, '40-44': 3371, '45-49': 2031, '50-54': 1013, '55-59': 441 },
    male: { '16-24': 5006, '25-29': 11324, '30-34': 15034, '35-39': 11424, '40-44': 6398, '45-49': 3281, '50-54': 1802, '55-59': 817 },
  },
  open_doubles: {
    female: { '16-29': 67491, '30-39': 76239, '40-49': 31710, '50-59': 5213, '60-69': 427 },
    male: { '16-29': 58626, '30-39': 80663, '40-49': 29714, '50-59': 4936, '60-69': 549 },
    mixed: { '16-29': 64472, '30-39': 87106, '40-49': 32274, '50-59': 5876, '60-69': 525 },
  },
  pro_doubles: {
    female: { '16-29': 6526, '30-39': 9493, '40-49': 3996, '50-59': 714 },
    male: { '16-29': 10911, '30-39': 18132, '40-49': 5243, '50-59': 1000 },
  },
};

/** Age cells withheld for n < HYROX_S79_MIN_CELL_N. */
export const HYROX_S79_AGE_SUPPRESSED_CELLS: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; ageGroup: string; n: number }> = [
  { format: 'open_singles', sex: 'female', ageGroup: '70-74', n: 76 },
  { format: 'open_singles', sex: 'female', ageGroup: '75-79', n: 10 },
  { format: 'open_singles', sex: 'male', ageGroup: '75-79', n: 22 },
  { format: 'pro_singles', sex: 'female', ageGroup: '60-64', n: 9 },
  { format: 'pro_singles', sex: 'female', ageGroup: '65-69', n: 2 },
  { format: 'pro_singles', sex: 'male', ageGroup: '60-64', n: 76 },
  { format: 'pro_singles', sex: 'male', ageGroup: '65-69', n: 8 },
  { format: 'open_doubles', sex: 'female', ageGroup: '70+', n: 14 },
  { format: 'open_doubles', sex: 'male', ageGroup: '70+', n: 44 },
  { format: 'open_doubles', sex: 'mixed', ageGroup: '70+', n: 35 },
  { format: 'pro_doubles', sex: 'female', ageGroup: '60-69', n: 4 },
  { format: 'pro_doubles', sex: 'female', ageGroup: '70+', n: 1 },
  { format: 'pro_doubles', sex: 'male', ageGroup: '60-69', n: 18 },
  { format: 'pro_doubles', sex: 'male', ageGroup: '70+', n: 21 },
];

/** Per-season medians (seconds) to show whether S7, S8 and S9 are comparable. */
export const HYROX_S79_SEASON_MEDIANS: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; season: number; nTotal: number; nSplits: number; medians: Record<HyroxResultsMetric, number> }> = [
  { format: 'open_singles', sex: 'female', season: 7, nTotal: 43324, nSplits: 41823, medians: { total: 5603, run_total: 2772, work_total: 2361, roxzone: 451, ski_erg: 308, sled_push: 161, sled_pull: 340, burpee_broad_jumps: 394, row_erg: 325, farmer_carry: 133, sandbag_lunges: 301, wall_balls: 370 } },
  { format: 'open_singles', sex: 'female', season: 8, nTotal: 100220, nSplits: 99078, medians: { total: 5777, run_total: 2803, work_total: 2471, roxzone: 484, ski_erg: 318, sled_push: 175, sled_pull: 348, burpee_broad_jumps: 405, row_erg: 332, farmer_carry: 139, sandbag_lunges: 314, wall_balls: 410 } },
  { format: 'open_singles', sex: 'female', season: 9, nTotal: 19248, nSplits: 18985, medians: { total: 6061, run_total: 2907, work_total: 2589, roxzone: 546, ski_erg: 325, sled_push: 187, sled_pull: 361, burpee_broad_jumps: 430, row_erg: 340, farmer_carry: 146, sandbag_lunges: 335, wall_balls: 438 } },
  { format: 'open_singles', sex: 'male', season: 7, nTotal: 85391, nSplits: 82573, medians: { total: 5162, run_total: 2503, work_total: 2208, roxzone: 424, ski_erg: 267, sled_push: 168, sled_pull: 291, burpee_broad_jumps: 334, row_erg: 289, farmer_carry: 127, sandbag_lunges: 310, wall_balls: 390 } },
  { format: 'open_singles', sex: 'male', season: 8, nTotal: 175723, nSplits: 173924, medians: { total: 5277, run_total: 2495, work_total: 2305, roxzone: 447, ski_erg: 275, sled_push: 187, sled_pull: 299, burpee_broad_jumps: 336, row_erg: 293, farmer_carry: 131, sandbag_lunges: 320, wall_balls: 431 } },
  { format: 'open_singles', sex: 'male', season: 9, nTotal: 34513, nSplits: 33892, medians: { total: 5659, run_total: 2649, work_total: 2455, roxzone: 522, ski_erg: 282, sled_push: 200, sled_pull: 315, burpee_broad_jumps: 357, row_erg: 304, farmer_carry: 141, sandbag_lunges: 346, wall_balls: 471 } },
  { format: 'pro_singles', sex: 'female', season: 7, nTotal: 6246, nSplits: 5951, medians: { total: 5223, run_total: 2462, work_total: 2346, roxzone: 392, ski_erg: 289, sled_push: 216, sled_pull: 364, burpee_broad_jumps: 310, row_erg: 303, farmer_carry: 153, sandbag_lunges: 309, wall_balls: 368 } },
  { format: 'pro_singles', sex: 'female', season: 8, nTotal: 16250, nSplits: 16076, medians: { total: 5213, run_total: 2411, work_total: 2377, roxzone: 397, ski_erg: 294, sled_push: 240, sled_pull: 348, burpee_broad_jumps: 312, row_erg: 307, farmer_carry: 156, sandbag_lunges: 309, wall_balls: 381 } },
  { format: 'pro_singles', sex: 'female', season: 9, nTotal: 2682, nSplits: 2618, medians: { total: 5295, run_total: 2449, work_total: 2401, roxzone: 437, ski_erg: 298, sled_push: 244, sled_pull: 339, burpee_broad_jumps: 314, row_erg: 312, farmer_carry: 163, sandbag_lunges: 320, wall_balls: 388 } },
  { format: 'pro_singles', sex: 'male', season: 7, nTotal: 14797, nSplits: 14382, medians: { total: 4877, run_total: 2273, work_total: 2221, roxzone: 374, ski_erg: 254, sled_push: 202, sled_pull: 354, burpee_broad_jumps: 271, row_erg: 274, farmer_carry: 129, sandbag_lunges: 305, wall_balls: 390 } },
  { format: 'pro_singles', sex: 'male', season: 8, nTotal: 34363, nSplits: 34034, medians: { total: 4857, run_total: 2198, work_total: 2259, roxzone: 375, ski_erg: 258, sled_push: 232, sled_pull: 345, burpee_broad_jumps: 263, row_erg: 275, farmer_carry: 131, sandbag_lunges: 302, wall_balls: 412 } },
  { format: 'pro_singles', sex: 'male', season: 9, nTotal: 6040, nSplits: 5942, medians: { total: 4990, run_total: 2272, work_total: 2296, roxzone: 418, ski_erg: 260, sled_push: 234, sled_pull: 336, burpee_broad_jumps: 267, row_erg: 279, farmer_carry: 138, sandbag_lunges: 310, wall_balls: 431 } },
  { format: 'open_doubles', sex: 'female', season: 7, nTotal: 44061, nSplits: 41801, medians: { total: 5159, run_total: 2925, work_total: 1765, roxzone: 449, ski_erg: 281, sled_push: 104, sled_pull: 242, burpee_broad_jumps: 247, row_erg: 307, farmer_carry: 110, sandbag_lunges: 217, wall_balls: 246 } },
  { format: 'open_doubles', sex: 'female', season: 8, nTotal: 114188, nSplits: 112679, medians: { total: 5290, run_total: 2951, work_total: 1847, roxzone: 469, ski_erg: 290, sled_push: 113, sled_pull: 254, burpee_broad_jumps: 258, row_erg: 313, farmer_carry: 113, sandbag_lunges: 227, wall_balls: 266 } },
  { format: 'open_doubles', sex: 'female', season: 9, nTotal: 23800, nSplits: 23495, medians: { total: 5509, run_total: 3057, work_total: 1911, roxzone: 542, ski_erg: 296, sled_push: 115, sled_pull: 265, burpee_broad_jumps: 273, row_erg: 320, farmer_carry: 114, sandbag_lunges: 241, wall_balls: 273 } },
  { format: 'open_doubles', sex: 'male', season: 7, nTotal: 44321, nSplits: 42700, medians: { total: 4473, run_total: 2521, work_total: 1548, roxzone: 387, ski_erg: 239, sled_push: 102, sled_pull: 189, burpee_broad_jumps: 187, row_erg: 267, farmer_carry: 97, sandbag_lunges: 207, wall_balls: 248 } },
  { format: 'open_doubles', sex: 'male', season: 8, nTotal: 108013, nSplits: 106701, medians: { total: 4570, run_total: 2526, work_total: 1620, roxzone: 405, ski_erg: 245, sled_push: 112, sled_pull: 201, burpee_broad_jumps: 193, row_erg: 272, farmer_carry: 100, sandbag_lunges: 215, wall_balls: 267 } },
  { format: 'open_doubles', sex: 'male', season: 9, nTotal: 22704, nSplits: 22437, medians: { total: 4919, run_total: 2706, work_total: 1716, roxzone: 484, ski_erg: 251, sled_push: 119, sled_pull: 219, burpee_broad_jumps: 207, row_erg: 283, farmer_carry: 104, sandbag_lunges: 233, wall_balls: 280 } },
  { format: 'open_doubles', sex: 'mixed', season: 7, nTotal: 43945, nSplits: 41791, medians: { total: 4847, run_total: 2710, work_total: 1706, roxzone: 413, ski_erg: 255, sled_push: 120, sled_pull: 229, burpee_broad_jumps: 208, row_erg: 282, farmer_carry: 106, sandbag_lunges: 234, wall_balls: 257 } },
  { format: 'open_doubles', sex: 'mixed', season: 8, nTotal: 121575, nSplits: 119764, medians: { total: 4983, run_total: 2735, work_total: 1788, roxzone: 433, ski_erg: 262, sled_push: 134, sled_pull: 240, burpee_broad_jumps: 216, row_erg: 288, farmer_carry: 110, sandbag_lunges: 243, wall_balls: 278 } },
  { format: 'open_doubles', sex: 'mixed', season: 9, nTotal: 25361, nSplits: 24768, medians: { total: 5230, run_total: 2844, work_total: 1859, roxzone: 504, ski_erg: 266, sled_push: 137, sled_pull: 250, burpee_broad_jumps: 226, row_erg: 296, farmer_carry: 113, sandbag_lunges: 259, wall_balls: 293 } },
  { format: 'pro_doubles', sex: 'female', season: 7, nTotal: 4134, nSplits: 3898, medians: { total: 4816, run_total: 2609, work_total: 1792, roxzone: 393, ski_erg: 266, sled_push: 135, sled_pull: 272, burpee_broad_jumps: 211, row_erg: 290, farmer_carry: 113, sandbag_lunges: 241, wall_balls: 250 } },
  { format: 'pro_doubles', sex: 'female', season: 8, nTotal: 14227, nSplits: 14048, medians: { total: 4789, run_total: 2565, work_total: 1816, roxzone: 394, ski_erg: 271, sled_push: 150, sled_pull: 266, burpee_broad_jumps: 211, row_erg: 293, farmer_carry: 115, sandbag_lunges: 239, wall_balls: 253 } },
  { format: 'pro_doubles', sex: 'female', season: 9, nTotal: 2387, nSplits: 2353, medians: { total: 4809, run_total: 2572, work_total: 1812, roxzone: 427, ski_erg: 272, sled_push: 152, sled_pull: 259, burpee_broad_jumps: 207, row_erg: 295, farmer_carry: 117, sandbag_lunges: 242, wall_balls: 252 } },
  { format: 'pro_doubles', sex: 'male', season: 7, nTotal: 7245, nSplits: 6998, medians: { total: 4205, run_total: 2275, work_total: 1577, roxzone: 341, ski_erg: 229, sled_push: 119, sled_pull: 242, burpee_broad_jumps: 161, row_erg: 253, farmer_carry: 98, sandbag_lunges: 215, wall_balls: 243 } },
  { format: 'pro_doubles', sex: 'male', season: 8, nTotal: 24058, nSplits: 23788, medians: { total: 4184, run_total: 2213, work_total: 1618, roxzone: 335, ski_erg: 232, sled_push: 135, sled_pull: 246, burpee_broad_jumps: 162, row_erg: 256, farmer_carry: 100, sandbag_lunges: 215, wall_balls: 253 } },
  { format: 'pro_doubles', sex: 'male', season: 9, nTotal: 4091, nSplits: 4033, medians: { total: 4314, run_total: 2278, work_total: 1655, roxzone: 374, ski_erg: 234, sled_push: 140, sled_pull: 248, burpee_broad_jumps: 165, row_erg: 261, farmer_carry: 103, sandbag_lunges: 223, wall_balls: 258 } },
];

/** Same-venue season comparison: median across venues of the change in each
 *  metric's median (seconds, positive = slower) between the same half of
 *  consecutive seasons (autumn to autumn, spring to spring). Controls for venue
 *  mix and time of year, which the raw per-season medians do not. */
export const HYROX_S79_SAME_VENUE_SEASON_SHIFT: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxResultsSex; from: string; to: string; venuesTotal: number; venuesSplits: number; medianShiftSec: Record<HyroxResultsMetric, number | null> }> = [
  { format: 'open_singles', sex: 'female', from: 'S7-2024', to: 'S8-2025', venuesTotal: 17, venuesSplits: 17, medianShiftSec: { total: 110, run_total: 3, work_total: 64, roxzone: -5, ski_erg: 8, sled_push: 13, sled_pull: 4, burpee_broad_jumps: 12, row_erg: 3, farmer_carry: 5, sandbag_lunges: 7, wall_balls: 30 } },
  { format: 'open_singles', sex: 'female', from: 'S7-2025', to: 'S8-2026', venuesTotal: 27, venuesSplits: 27, medianShiftSec: { total: 120, run_total: 55, work_total: 107, roxzone: 10, ski_erg: 7, sled_push: 15, sled_pull: 0, burpee_broad_jumps: 13, row_erg: 6, farmer_carry: 5, sandbag_lunges: 16, wall_balls: 33 } },
  { format: 'open_singles', sex: 'female', from: 'S8-2025', to: 'S9-2026', venuesTotal: 11, venuesSplits: 11, medianShiftSec: { total: 65, run_total: 35, work_total: 15, roxzone: 7, ski_erg: 2, sled_push: 8, sled_pull: -22, burpee_broad_jumps: 18, row_erg: 1, farmer_carry: 8, sandbag_lunges: 12, wall_balls: 14 } },
  { format: 'open_singles', sex: 'male', from: 'S7-2024', to: 'S8-2025', venuesTotal: 18, venuesSplits: 18, medianShiftSec: { total: 12, run_total: -24, work_total: 92, roxzone: 3, ski_erg: 5, sled_push: 17, sled_pull: 5, burpee_broad_jumps: 1, row_erg: 2, farmer_carry: 2, sandbag_lunges: 6, wall_balls: 33 } },
  { format: 'open_singles', sex: 'male', from: 'S7-2025', to: 'S8-2026', venuesTotal: 28, venuesSplits: 28, medianShiftSec: { total: 76, run_total: -16, work_total: 61, roxzone: -3, ski_erg: 5, sled_push: 20, sled_pull: -1, burpee_broad_jumps: 3, row_erg: 2, farmer_carry: 2, sandbag_lunges: 7, wall_balls: 33 } },
  { format: 'open_singles', sex: 'male', from: 'S8-2025', to: 'S9-2026', venuesTotal: 11, venuesSplits: 11, medianShiftSec: { total: 24, run_total: 12, work_total: 9, roxzone: 8, ski_erg: 2, sled_push: 5, sled_pull: -20, burpee_broad_jumps: 11, row_erg: 4, farmer_carry: 9, sandbag_lunges: 9, wall_balls: 0 } },
  { format: 'pro_singles', sex: 'female', from: 'S7-2024', to: 'S8-2025', venuesTotal: 2, venuesSplits: 2, medianShiftSec: { total: -79, run_total: -96, work_total: -33, roxzone: 12, ski_erg: 6, sled_push: 35, sled_pull: -27, burpee_broad_jumps: -15, row_erg: -1, farmer_carry: 5, sandbag_lunges: 3, wall_balls: -16 } },
  { format: 'pro_singles', sex: 'female', from: 'S7-2025', to: 'S8-2026', venuesTotal: 11, venuesSplits: 9, medianShiftSec: { total: 100, run_total: -31, work_total: 36, roxzone: 9, ski_erg: 6, sled_push: 40, sled_pull: -7, burpee_broad_jumps: 11, row_erg: 8, farmer_carry: 9, sandbag_lunges: -1, wall_balls: 20 } },
  { format: 'pro_singles', sex: 'female', from: 'S8-2025', to: 'S9-2026', venuesTotal: 3, venuesSplits: 3, medianShiftSec: { total: -151, run_total: -19, work_total: -94, roxzone: -22, ski_erg: 7, sled_push: 11, sled_pull: -48, burpee_broad_jumps: -9, row_erg: -1, farmer_carry: 18, sandbag_lunges: -18, wall_balls: -14 } },
  { format: 'pro_singles', sex: 'male', from: 'S7-2024', to: 'S8-2025', venuesTotal: 15, venuesSplits: 15, medianShiftSec: { total: -89, run_total: -113, work_total: 19, roxzone: -26, ski_erg: 2, sled_push: 29, sled_pull: -4, burpee_broad_jumps: -10, row_erg: -2, farmer_carry: -2, sandbag_lunges: -9, wall_balls: 23 } },
  { format: 'pro_singles', sex: 'male', from: 'S7-2025', to: 'S8-2026', venuesTotal: 24, venuesSplits: 24, medianShiftSec: { total: -24, run_total: -67, work_total: 33, roxzone: -4, ski_erg: 2, sled_push: 37, sled_pull: -17, burpee_broad_jumps: 0, row_erg: 0, farmer_carry: -2, sandbag_lunges: -5, wall_balls: 28 } },
  { format: 'pro_singles', sex: 'male', from: 'S8-2025', to: 'S9-2026', venuesTotal: 9, venuesSplits: 9, medianShiftSec: { total: -244, run_total: -54, work_total: -134, roxzone: -13, ski_erg: 1, sled_push: -9, sled_pull: -53, burpee_broad_jumps: -3, row_erg: -1, farmer_carry: 4, sandbag_lunges: -15, wall_balls: -5 } },
  { format: 'open_doubles', sex: 'female', from: 'S7-2024', to: 'S8-2025', venuesTotal: 16, venuesSplits: 16, medianShiftSec: { total: 82, run_total: 2, work_total: 64, roxzone: -20, ski_erg: 6, sled_push: 6, sled_pull: 8, burpee_broad_jumps: 5, row_erg: 6, farmer_carry: 4, sandbag_lunges: 11, wall_balls: 17 } },
  { format: 'open_doubles', sex: 'female', from: 'S7-2025', to: 'S8-2026', venuesTotal: 28, venuesSplits: 27, medianShiftSec: { total: 149, run_total: 42, work_total: 84, roxzone: 17, ski_erg: 5, sled_push: 7, sled_pull: 7, burpee_broad_jumps: 13, row_erg: 3, farmer_carry: 2, sandbag_lunges: 10, wall_balls: 16 } },
  { format: 'open_doubles', sex: 'female', from: 'S8-2025', to: 'S9-2026', venuesTotal: 9, venuesSplits: 9, medianShiftSec: { total: 67, run_total: 46, work_total: 61, roxzone: 33, ski_erg: 2, sled_push: 5, sled_pull: 3, burpee_broad_jumps: 21, row_erg: 0, farmer_carry: 5, sandbag_lunges: 7, wall_balls: 6 } },
  { format: 'open_doubles', sex: 'male', from: 'S7-2024', to: 'S8-2025', venuesTotal: 16, venuesSplits: 16, medianShiftSec: { total: 36, run_total: -32, work_total: 59, roxzone: -16, ski_erg: 5, sled_push: 7, sled_pull: 8, burpee_broad_jumps: 6, row_erg: 3, farmer_carry: 4, sandbag_lunges: 6, wall_balls: 17 } },
  { format: 'open_doubles', sex: 'male', from: 'S7-2025', to: 'S8-2026', venuesTotal: 28, venuesSplits: 28, medianShiftSec: { total: 64, run_total: -22, work_total: 69, roxzone: 16, ski_erg: 4, sled_push: 11, sled_pull: 3, burpee_broad_jumps: 4, row_erg: 4, farmer_carry: 3, sandbag_lunges: 9, wall_balls: 17 } },
  { format: 'open_doubles', sex: 'male', from: 'S8-2025', to: 'S9-2026', venuesTotal: 11, venuesSplits: 11, medianShiftSec: { total: 100, run_total: 25, work_total: 42, roxzone: 6, ski_erg: 1, sled_push: 7, sled_pull: 4, burpee_broad_jumps: 6, row_erg: 1, farmer_carry: 3, sandbag_lunges: 5, wall_balls: 4 } },
  { format: 'open_doubles', sex: 'mixed', from: 'S7-2024', to: 'S8-2025', venuesTotal: 17, venuesSplits: 17, medianShiftSec: { total: 63, run_total: 37, work_total: 64, roxzone: -13, ski_erg: 6, sled_push: 11, sled_pull: 12, burpee_broad_jumps: 10, row_erg: 5, farmer_carry: 3, sandbag_lunges: 8, wall_balls: 20 } },
  { format: 'open_doubles', sex: 'mixed', from: 'S7-2025', to: 'S8-2026', venuesTotal: 29, venuesSplits: 28, medianShiftSec: { total: 110, run_total: 47, work_total: 67, roxzone: 8, ski_erg: 5, sled_push: 14, sled_pull: 4, burpee_broad_jumps: 9, row_erg: 3, farmer_carry: 2, sandbag_lunges: 7, wall_balls: 18 } },
  { format: 'open_doubles', sex: 'mixed', from: 'S8-2025', to: 'S9-2026', venuesTotal: 11, venuesSplits: 11, medianShiftSec: { total: 58, run_total: 57, work_total: 40, roxzone: 7, ski_erg: 2, sled_push: 6, sled_pull: -2, burpee_broad_jumps: 14, row_erg: 0, farmer_carry: 4, sandbag_lunges: 7, wall_balls: 5 } },
  { format: 'pro_doubles', sex: 'female', from: 'S7-2024', to: 'S8-2025', venuesTotal: 0, venuesSplits: 0, medianShiftSec: { total: null, run_total: null, work_total: null, roxzone: null, ski_erg: null, sled_push: null, sled_pull: null, burpee_broad_jumps: null, row_erg: null, farmer_carry: null, sandbag_lunges: null, wall_balls: null } },
  { format: 'pro_doubles', sex: 'female', from: 'S7-2025', to: 'S8-2026', venuesTotal: 5, venuesSplits: 3, medianShiftSec: { total: 81, run_total: -43, work_total: 22, roxzone: 138, ski_erg: 5, sled_push: 24, sled_pull: -10, burpee_broad_jumps: -4, row_erg: 6, farmer_carry: 5, sandbag_lunges: -2, wall_balls: 4 } },
  { format: 'pro_doubles', sex: 'female', from: 'S8-2025', to: 'S9-2026', venuesTotal: 3, venuesSplits: 3, medianShiftSec: { total: -314, run_total: -74, work_total: -102, roxzone: -50, ski_erg: 1, sled_push: 11, sled_pull: -40, burpee_broad_jumps: -11, row_erg: 0, farmer_carry: -2, sandbag_lunges: -18, wall_balls: -20 } },
  { format: 'pro_doubles', sex: 'male', from: 'S7-2024', to: 'S8-2025', venuesTotal: 6, venuesSplits: 6, medianShiftSec: { total: 82, run_total: -51, work_total: 101, roxzone: -13, ski_erg: 1, sled_push: 25, sled_pull: 20, burpee_broad_jumps: 12, row_erg: 5, farmer_carry: 3, sandbag_lunges: 1, wall_balls: 20 } },
  { format: 'pro_doubles', sex: 'male', from: 'S7-2025', to: 'S8-2026', venuesTotal: 12, venuesSplits: 11, medianShiftSec: { total: 33, run_total: -62, work_total: 60, roxzone: 15, ski_erg: 3, sled_push: 25, sled_pull: 5, burpee_broad_jumps: 4, row_erg: 2, farmer_carry: 0, sandbag_lunges: 4, wall_balls: 12 } },
  { format: 'pro_doubles', sex: 'male', from: 'S8-2025', to: 'S9-2026', venuesTotal: 5, venuesSplits: 5, medianShiftSec: { total: -185, run_total: -103, work_total: -31, roxzone: -17, ski_erg: -1, sled_push: 12, sled_pull: -31, burpee_broad_jumps: 4, row_erg: -2, farmer_carry: -1, sandbag_lunges: -5, wall_balls: -7 } },
];

/** Spread of event medians across events (events with n >= HYROX_S79_MIN_CELL_N for
 *  that metric): p10/p50/p90 of event medians in seconds, and the min, p10, p90 and
 *  max of event median / pooled cell median. Quantifies venue variation (course
 *  length, station set-up) mixed with field strength. */
export const HYROX_S79_VENUE_SPREAD: Record<HyroxResultsFormat, Partial<Record<HyroxResultsSex, Record<HyroxResultsMetric, { events: number; p10: number; p50: number; p90: number; ratioMin: number; ratioP10: number; ratioP90: number; ratioMax: number }>>>> = {
  open_singles: {
    female: {
      total: { events: 189, p10: 5437, p50: 5689, p90: 6414, ratioMin: 0.85, ratioP10: 0.94, ratioP90: 1.11, ratioMax: 1.39 },
      run_total: { events: 187, p10: 2640, p50: 2806, p90: 3130, ratioMin: 0.8, ratioP10: 0.94, ratioP90: 1.12, ratioMax: 1.35 },
      work_total: { events: 187, p10: 2291, p50: 2422, p90: 2715, ratioMin: 0.85, ratioP10: 0.93, ratioP90: 1.11, ratioMax: 1.43 },
      roxzone: { events: 176, p10: 374, p50: 459, p90: 618, ratioMin: 0.62, ratioP10: 0.78, ratioP90: 1.28, ratioMax: 1.98 },
      ski_erg: { events: 187, p10: 303, p50: 315, p90: 337, ratioMin: 0.93, ratioP10: 0.96, ratioP90: 1.07, ratioMax: 1.18 },
      sled_push: { events: 187, p10: 147, p50: 170, p90: 211, ratioMin: 0.73, ratioP10: 0.85, ratioP90: 1.22, ratioMax: 1.54 },
      sled_pull: { events: 187, p10: 310, p50: 352, p90: 416, ratioMin: 0.77, ratioP10: 0.89, ratioP90: 1.2, ratioMax: 1.61 },
      burpee_broad_jumps: { events: 187, p10: 370, p50: 396, p90: 445, ratioMin: 0.8, ratioP10: 0.91, ratioP90: 1.1, ratioMax: 1.48 },
      row_erg: { events: 187, p10: 318, p50: 328, p90: 351, ratioMin: 0.93, ratioP10: 0.96, ratioP90: 1.06, ratioMax: 1.2 },
      farmer_carry: { events: 187, p10: 126, p50: 136, p90: 157, ratioMin: 0.87, ratioP10: 0.91, ratioP90: 1.14, ratioMax: 1.41 },
      sandbag_lunges: { events: 187, p10: 291, p50: 307, p90: 345, ratioMin: 0.82, ratioP10: 0.93, ratioP90: 1.11, ratioMax: 1.52 },
      wall_balls: { events: 187, p10: 354, p50: 398, p90: 459, ratioMin: 0.62, ratioP10: 0.88, ratioP90: 1.14, ratioMax: 1.7 },
    },
    male: {
      total: { events: 196, p10: 4947, p50: 5219, p90: 5968, ratioMin: 0.82, ratioP10: 0.94, ratioP90: 1.13, ratioMax: 1.35 },
      run_total: { events: 195, p10: 2357, p50: 2549, p90: 2890, ratioMin: 0.8, ratioP10: 0.94, ratioP90: 1.15, ratioMax: 1.32 },
      work_total: { events: 195, p10: 2131, p50: 2257, p90: 2553, ratioMin: 0.83, ratioP10: 0.93, ratioP90: 1.11, ratioMax: 1.36 },
      roxzone: { events: 185, p10: 345, p50: 439, p90: 585, ratioMin: 0.61, ratioP10: 0.77, ratioP90: 1.31, ratioMax: 1.87 },
      ski_erg: { events: 195, p10: 262, p50: 272, p90: 290, ratioMin: 0.94, ratioP10: 0.96, ratioP90: 1.06, ratioMax: 1.15 },
      sled_push: { events: 195, p10: 153, p50: 181, p90: 224, ratioMin: 0.7, ratioP10: 0.84, ratioP90: 1.23, ratioMax: 1.66 },
      sled_pull: { events: 195, p10: 262, p50: 302, p90: 358, ratioMin: 0.76, ratioP10: 0.88, ratioP90: 1.2, ratioMax: 1.51 },
      burpee_broad_jumps: { events: 195, p10: 309, p50: 336, p90: 373, ratioMin: 0.77, ratioP10: 0.92, ratioP90: 1.11, ratioMax: 1.35 },
      row_erg: { events: 195, p10: 283, p50: 292, p90: 312, ratioMin: 0.93, ratioP10: 0.97, ratioP90: 1.06, ratioMax: 1.17 },
      farmer_carry: { events: 195, p10: 120, p50: 129, p90: 154, ratioMin: 0.85, ratioP10: 0.92, ratioP90: 1.17, ratioMax: 1.34 },
      sandbag_lunges: { events: 195, p10: 298, p50: 317, p90: 354, ratioMin: 0.79, ratioP10: 0.93, ratioP90: 1.1, ratioMax: 1.38 },
      wall_balls: { events: 195, p10: 369, p50: 415, p90: 491, ratioMin: 0.78, ratioP10: 0.87, ratioP90: 1.16, ratioMax: 1.47 },
    },
  },
  pro_singles: {
    female: {
      total: { events: 81, p10: 4883, p50: 5133, p90: 5521, ratioMin: 0.84, ratioP10: 0.93, ratioP90: 1.06, ratioMax: 1.19 },
      run_total: { events: 78, p10: 2273, p50: 2409, p90: 2547, ratioMin: 0.81, ratioP10: 0.94, ratioP90: 1.05, ratioMax: 1.2 },
      work_total: { events: 78, p10: 2173, p50: 2340, p90: 2549, ratioMin: 0.83, ratioP10: 0.92, ratioP90: 1.07, ratioMax: 1.19 },
      roxzone: { events: 73, p10: 314, p50: 382, p90: 491, ratioMin: 0.64, ratioP10: 0.79, ratioP90: 1.23, ratioMax: 1.99 },
      ski_erg: { events: 78, p10: 283, p50: 291, p90: 302, ratioMin: 0.94, ratioP10: 0.96, ratioP90: 1.03, ratioMax: 1.08 },
      sled_push: { events: 78, p10: 197, p50: 227, p90: 272, ratioMin: 0.75, ratioP10: 0.84, ratioP90: 1.16, ratioMax: 1.35 },
      sled_pull: { events: 78, p10: 304, p50: 340, p90: 394, ratioMin: 0.79, ratioP10: 0.87, ratioP90: 1.12, ratioMax: 1.23 },
      burpee_broad_jumps: { events: 78, p10: 286, p50: 309, p90: 342, ratioMin: 0.79, ratioP10: 0.92, ratioP90: 1.1, ratioMax: 1.21 },
      row_erg: { events: 78, p10: 296, p50: 304, p90: 313, ratioMin: 0.95, ratioP10: 0.96, ratioP90: 1.02, ratioMax: 1.08 },
      farmer_carry: { events: 78, p10: 138, p50: 153, p90: 171, ratioMin: 0.8, ratioP10: 0.88, ratioP90: 1.1, ratioMax: 1.31 },
      sandbag_lunges: { events: 78, p10: 286, p50: 306, p90: 333, ratioMin: 0.78, ratioP10: 0.92, ratioP90: 1.07, ratioMax: 1.17 },
      wall_balls: { events: 78, p10: 345, p50: 370, p90: 413, ratioMin: 0.81, ratioP10: 0.91, ratioP90: 1.09, ratioMax: 1.22 },
    },
    male: {
      total: { events: 177, p10: 4528, p50: 4863, p90: 5588, ratioMin: 0.84, ratioP10: 0.93, ratioP90: 1.15, ratioMax: 1.41 },
      run_total: { events: 176, p10: 2096, p50: 2250, p90: 2512, ratioMin: 0.79, ratioP10: 0.94, ratioP90: 1.13, ratioMax: 1.39 },
      work_total: { events: 176, p10: 2072, p50: 2246, p90: 2582, ratioMin: 0.82, ratioP10: 0.92, ratioP90: 1.15, ratioMax: 1.4 },
      roxzone: { events: 165, p10: 296, p50: 375, p90: 490, ratioMin: 0.59, ratioP10: 0.78, ratioP90: 1.29, ratioMax: 1.94 },
      ski_erg: { events: 176, p10: 249, p50: 256, p90: 271, ratioMin: 0.94, ratioP10: 0.97, ratioP90: 1.05, ratioMax: 1.15 },
      sled_push: { events: 176, p10: 188, p50: 221, p90: 280, ratioMin: 0.73, ratioP10: 0.84, ratioP90: 1.25, ratioMax: 1.88 },
      sled_pull: { events: 176, p10: 298, p50: 355, p90: 441, ratioMin: 0.75, ratioP10: 0.86, ratioP90: 1.27, ratioMax: 1.69 },
      burpee_broad_jumps: { events: 176, p10: 242, p50: 267, p90: 293, ratioMin: 0.78, ratioP10: 0.91, ratioP90: 1.1, ratioMax: 1.42 },
      row_erg: { events: 176, p10: 265, p50: 275, p90: 290, ratioMin: 0.95, ratioP10: 0.96, ratioP90: 1.05, ratioMax: 1.16 },
      farmer_carry: { events: 176, p10: 117, p50: 129, p90: 159, ratioMin: 0.79, ratioP10: 0.89, ratioP90: 1.21, ratioMax: 1.49 },
      sandbag_lunges: { events: 176, p10: 278, p50: 303, p90: 341, ratioMin: 0.76, ratioP10: 0.92, ratioP90: 1.12, ratioMax: 1.5 },
      wall_balls: { events: 176, p10: 370, p50: 400, p90: 481, ratioMin: 0.8, ratioP10: 0.91, ratioP90: 1.18, ratioMax: 1.55 },
    },
  },
  open_doubles: {
    female: {
      total: { events: 186, p10: 5000, p50: 5217, p90: 5714, ratioMin: 0.89, ratioP10: 0.95, ratioP90: 1.08, ratioMax: 1.31 },
      run_total: { events: 183, p10: 2786, p50: 2954, p90: 3253, ratioMin: 0.81, ratioP10: 0.94, ratioP90: 1.1, ratioMax: 1.29 },
      work_total: { events: 183, p10: 1717, p50: 1812, p90: 1961, ratioMin: 0.89, ratioP10: 0.94, ratioP90: 1.07, ratioMax: 1.34 },
      roxzone: { events: 173, p10: 362, p50: 454, p90: 604, ratioMin: 0.61, ratioP10: 0.76, ratioP90: 1.28, ratioMax: 2.04 },
      ski_erg: { events: 183, p10: 275, p50: 287, p90: 308, ratioMin: 0.92, ratioP10: 0.95, ratioP90: 1.07, ratioMax: 1.17 },
      sled_push: { events: 183, p10: 96, p50: 110, p90: 130, ratioMin: 0.77, ratioP10: 0.87, ratioP90: 1.17, ratioMax: 1.41 },
      sled_pull: { events: 183, p10: 226, p50: 253, p90: 299, ratioMin: 0.78, ratioP10: 0.9, ratioP90: 1.19, ratioMax: 1.45 },
      burpee_broad_jumps: { events: 183, p10: 232, p50: 253, p90: 280, ratioMin: 0.79, ratioP10: 0.9, ratioP90: 1.09, ratioMax: 1.4 },
      row_erg: { events: 183, p10: 300, p50: 310, p90: 332, ratioMin: 0.95, ratioP10: 0.96, ratioP90: 1.06, ratioMax: 1.18 },
      farmer_carry: { events: 183, p10: 106, p50: 111, p90: 120, ratioMin: 0.89, ratioP10: 0.95, ratioP90: 1.07, ratioMax: 1.27 },
      sandbag_lunges: { events: 183, p10: 209, p50: 223, p90: 244, ratioMin: 0.86, ratioP10: 0.92, ratioP90: 1.07, ratioMax: 1.38 },
      wall_balls: { events: 183, p10: 239, p50: 258, p90: 286, ratioMin: 0.71, ratioP10: 0.91, ratioP90: 1.09, ratioMax: 1.6 },
    },
    male: {
      total: { events: 191, p10: 4318, p50: 4547, p90: 5130, ratioMin: 0.83, ratioP10: 0.94, ratioP90: 1.12, ratioMax: 1.32 },
      run_total: { events: 190, p10: 2377, p50: 2572, p90: 2885, ratioMin: 0.78, ratioP10: 0.93, ratioP90: 1.13, ratioMax: 1.36 },
      work_total: { events: 190, p10: 1516, p50: 1589, p90: 1743, ratioMin: 0.88, ratioP10: 0.94, ratioP90: 1.08, ratioMax: 1.26 },
      roxzone: { events: 179, p10: 308, p50: 398, p90: 555, ratioMin: 0.58, ratioP10: 0.75, ratioP90: 1.36, ratioMax: 1.95 },
      ski_erg: { events: 190, p10: 234, p50: 242, p90: 259, ratioMin: 0.93, ratioP10: 0.96, ratioP90: 1.06, ratioMax: 1.14 },
      sled_push: { events: 190, p10: 95, p50: 109, p90: 130, ratioMin: 0.76, ratioP10: 0.86, ratioP90: 1.18, ratioMax: 1.48 },
      sled_pull: { events: 190, p10: 176, p50: 199, p90: 238, ratioMin: 0.78, ratioP10: 0.88, ratioP90: 1.19, ratioMax: 1.45 },
      burpee_broad_jumps: { events: 190, p10: 178, p50: 191, p90: 210, ratioMin: 0.78, ratioP10: 0.92, ratioP90: 1.09, ratioMax: 1.32 },
      row_erg: { events: 190, p10: 262, p50: 270, p90: 291, ratioMin: 0.93, ratioP10: 0.96, ratioP90: 1.07, ratioMax: 1.2 },
      farmer_carry: { events: 190, p10: 93, p50: 99, p90: 108, ratioMin: 0.87, ratioP10: 0.93, ratioP90: 1.08, ratioMax: 1.3 },
      sandbag_lunges: { events: 190, p10: 200, p50: 212, p90: 235, ratioMin: 0.86, ratioP10: 0.93, ratioP90: 1.09, ratioMax: 1.35 },
      wall_balls: { events: 190, p10: 240, p50: 260, p90: 287, ratioMin: 0.87, ratioP10: 0.91, ratioP90: 1.09, ratioMax: 1.28 },
    },
    mixed: {
      total: { events: 194, p10: 4705, p50: 4921, p90: 5476, ratioMin: 0.88, ratioP10: 0.95, ratioP90: 1.1, ratioMax: 1.35 },
      run_total: { events: 191, p10: 2577, p50: 2749, p90: 3040, ratioMin: 0.81, ratioP10: 0.94, ratioP90: 1.11, ratioMax: 1.36 },
      work_total: { events: 191, p10: 1662, p50: 1752, p90: 1943, ratioMin: 0.9, ratioP10: 0.94, ratioP90: 1.09, ratioMax: 1.34 },
      roxzone: { events: 181, p10: 327, p50: 417, p90: 567, ratioMin: 0.59, ratioP10: 0.75, ratioP90: 1.3, ratioMax: 1.98 },
      ski_erg: { events: 191, p10: 250, p50: 259, p90: 277, ratioMin: 0.93, ratioP10: 0.96, ratioP90: 1.07, ratioMax: 1.16 },
      sled_push: { events: 191, p10: 112, p50: 128, p90: 160, ratioMin: 0.71, ratioP10: 0.85, ratioP90: 1.22, ratioMax: 1.62 },
      sled_pull: { events: 191, p10: 208, p50: 240, p90: 283, ratioMin: 0.83, ratioP10: 0.87, ratioP90: 1.18, ratioMax: 1.51 },
      burpee_broad_jumps: { events: 191, p10: 195, p50: 211, p90: 235, ratioMin: 0.79, ratioP10: 0.91, ratioP90: 1.09, ratioMax: 1.39 },
      row_erg: { events: 191, p10: 277, p50: 286, p90: 305, ratioMin: 0.94, ratioP10: 0.96, ratioP90: 1.06, ratioMax: 1.19 },
      farmer_carry: { events: 191, p10: 102, p50: 109, p90: 119, ratioMin: 0.88, ratioP10: 0.93, ratioP90: 1.08, ratioMax: 1.25 },
      sandbag_lunges: { events: 191, p10: 224, p50: 239, p90: 262, ratioMin: 0.86, ratioP10: 0.92, ratioP90: 1.08, ratioMax: 1.39 },
      wall_balls: { events: 191, p10: 247, p50: 269, p90: 304, ratioMin: 0.85, ratioP10: 0.9, ratioP90: 1.11, ratioMax: 1.48 },
    },
  },
  pro_doubles: {
    female: {
      total: { events: 61, p10: 4544, p50: 4785, p90: 5129, ratioMin: 0.87, ratioP10: 0.95, ratioP90: 1.07, ratioMax: 1.17 },
      run_total: { events: 58, p10: 2402, p50: 2582, p90: 2814, ratioMin: 0.81, ratioP10: 0.93, ratioP90: 1.09, ratioMax: 1.15 },
      work_total: { events: 58, p10: 1698, p50: 1811, p90: 1920, ratioMin: 0.92, ratioP10: 0.94, ratioP90: 1.06, ratioMax: 1.15 },
      roxzone: { events: 56, p10: 310, p50: 393, p90: 510, ratioMin: 0.62, ratioP10: 0.78, ratioP90: 1.28, ratioMax: 2.04 },
      ski_erg: { events: 58, p10: 261, p50: 269, p90: 282, ratioMin: 0.94, ratioP10: 0.97, ratioP90: 1.05, ratioMax: 1.08 },
      sled_push: { events: 58, p10: 130, p50: 147, p90: 174, ratioMin: 0.77, ratioP10: 0.88, ratioP90: 1.19, ratioMax: 1.36 },
      sled_pull: { events: 58, p10: 235, p50: 261, p90: 301, ratioMin: 0.86, ratioP10: 0.88, ratioP90: 1.13, ratioMax: 1.25 },
      burpee_broad_jumps: { events: 58, p10: 198, p50: 211, p90: 236, ratioMin: 0.9, ratioP10: 0.94, ratioP90: 1.12, ratioMax: 1.16 },
      row_erg: { events: 58, p10: 285, p50: 292, p90: 302, ratioMin: 0.95, ratioP10: 0.97, ratioP90: 1.03, ratioMax: 1.08 },
      farmer_carry: { events: 58, p10: 109, p50: 115, p90: 122, ratioMin: 0.9, ratioP10: 0.95, ratioP90: 1.06, ratioMax: 1.24 },
      sandbag_lunges: { events: 58, p10: 222, p50: 242, p90: 261, ratioMin: 0.84, ratioP10: 0.93, ratioP90: 1.09, ratioMax: 1.18 },
      wall_balls: { events: 58, p10: 239, p50: 253, p90: 275, ratioMin: 0.92, ratioP10: 0.95, ratioP90: 1.09, ratioMax: 1.18 },
    },
    male: {
      total: { events: 119, p10: 3975, p50: 4221, p90: 4684, ratioMin: 0.85, ratioP10: 0.95, ratioP90: 1.11, ratioMax: 1.29 },
      run_total: { events: 117, p10: 2105, p50: 2246, p90: 2505, ratioMin: 0.8, ratioP10: 0.94, ratioP90: 1.12, ratioMax: 1.31 },
      work_total: { events: 117, p10: 1525, p50: 1606, p90: 1784, ratioMin: 0.89, ratioP10: 0.95, ratioP90: 1.11, ratioMax: 1.24 },
      roxzone: { events: 113, p10: 264, p50: 338, p90: 457, ratioMin: 0.54, ratioP10: 0.78, ratioP90: 1.34, ratioMax: 1.99 },
      ski_erg: { events: 117, p10: 225, p50: 231, p90: 245, ratioMin: 0.94, ratioP10: 0.97, ratioP90: 1.06, ratioMax: 1.11 },
      sled_push: { events: 117, p10: 113, p50: 133, p90: 171, ratioMin: 0.74, ratioP10: 0.85, ratioP90: 1.3, ratioMax: 1.59 },
      sled_pull: { events: 117, p10: 217, p50: 249, p90: 295, ratioMin: 0.77, ratioP10: 0.88, ratioP90: 1.2, ratioMax: 1.42 },
      burpee_broad_jumps: { events: 117, p10: 152, p50: 164, p90: 174, ratioMin: 0.86, ratioP10: 0.94, ratioP90: 1.07, ratioMax: 1.3 },
      row_erg: { events: 117, p10: 248, p50: 256, p90: 271, ratioMin: 0.95, ratioP10: 0.97, ratioP90: 1.06, ratioMax: 1.16 },
      farmer_carry: { events: 117, p10: 94, p50: 99, p90: 108, ratioMin: 0.89, ratioP10: 0.94, ratioP90: 1.08, ratioMax: 1.24 },
      sandbag_lunges: { events: 117, p10: 202, p50: 214, p90: 242, ratioMin: 0.82, ratioP10: 0.94, ratioP90: 1.12, ratioMax: 1.33 },
      wall_balls: { events: 117, p10: 239, p50: 253, p90: 281, ratioMin: 0.9, ratioP10: 0.95, ratioP90: 1.12, ratioMax: 1.23 },
    },
  },
};

/**
 * Change between a repeat athlete's FIRST and LATEST race (singles only; the
 * repeat file has no doubles). Negative = faster. Not a per-race rate: the races
 * are 1 to 4 half-season windows apart (roughly 6 to 24 months) with an unknown
 * number of races in between.
 * - relPct: change in time relative to the event median (event x format x sex),
 *   which removes course and venue effects. It also includes field drift: in the
 *   open formats the same-venue median total moves by +12 to +149 s a year
 *   (HYROX_S79_SAME_VENUE_SEASON_SHIFT); a slower field flatters relPct.
 * - absPct / absMedianSec: raw change in finish time (venue noise included).
 * - Quartiles are [p25, median, p75].
 * - band: HYROX_S79_IMPROVEMENT_BAND_THRESHOLDS (= HYROX_TIME_TO_BAND_THRESHOLDS)
 *   on the first race's total (groupBy first_race) or on the mean of both races
 *   (groupBy mean_of_races, Oldham's method). Grouping on the first race builds
 *   in regression to the mean (a slow first race tends to be followed by a faster
 *   one); compare the two.
 * - gapHalfSeasons: half-season windows between the races, from season and
 *   calendar year (the only populated date fields; month is empty). Gap g means
 *   roughly 6g months apart, anywhere from 6(g-1) to 6(g+1) months. The
 *   repeat file holds no pair inside a single window, so gaps start at 1.
 * - Selection: only athletes who raced again appear (survivorship). Totals
 *   outside either fence are dropped (relative splits cannot corroborate them).
 */
export interface HyroxImprovementCell {
  format: 'all_singles' | 'open_singles' | 'pro_singles';
  sex: 'all' | 'female' | 'male';
  groupBy: 'first_race' | 'mean_of_races';
  band: 'all' | Exclude<AbilityBand, 'total_beginner'>;
  gapHalfSeasons: 'all' | number;
  n: number;
  relPct: readonly [number, number, number];
  absPct: readonly [number, number, number];
  absMedianSec: number;
}
/** Band thresholds the improvement cells were cut with (seconds, first match wins). */
export const HYROX_S79_IMPROVEMENT_BAND_THRESHOLDS: ReadonlyArray<{ maxSec: number; band: Exclude<AbilityBand, 'total_beginner'> }> = [
  { maxSec: 3600, band: 'competitive' },
  { maxSec: 4800, band: 'advanced' },
  { maxSec: 6000, band: 'intermediate' },
  { maxSec: 7200, band: 'novice' },
  { maxSec: Infinity, band: 'beginner' },
];
export const HYROX_S79_IMPROVEMENT: readonly HyroxImprovementCell[] = [
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'all', gapHalfSeasons: 'all', n: 75332, relPct: [-9.7, -4.1, 1.7], absPct: [-9.3, -4.0, 1.6], absMedianSec: -204 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'all', gapHalfSeasons: 1, n: 39169, relPct: [-8.7, -3.6, 1.6], absPct: [-8.6, -3.8, 1.3], absMedianSec: -194 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'all', gapHalfSeasons: 2, n: 23573, relPct: [-10.4, -4.6, 1.5], absPct: [-9.6, -4.0, 1.9], absMedianSec: -204 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'all', gapHalfSeasons: 3, n: 10656, relPct: [-11.3, -4.6, 2.7], absPct: [-11.3, -4.9, 1.8], absMedianSec: -249 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'all', gapHalfSeasons: 4, n: 1934, relPct: [-13.7, -6.2, 2.2], absPct: [-11.9, -5.1, 2.9], absMedianSec: -253 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 'all', n: 229, relPct: [-3.5, 1.8, 6.8], absPct: [-2.9, -0.4, 3.5], absMedianSec: -14 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 'all', n: 20711, relPct: [-6.6, -2.1, 3.1], absPct: [-6.3, -2.3, 2.5], absMedianSec: -100 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 1, n: 10243, relPct: [-5.8, -1.9, 2.9], absPct: [-5.7, -2.1, 2.2], absMedianSec: -92 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 2, n: 6566, relPct: [-7.1, -2.5, 2.7], absPct: [-6.6, -2.2, 2.9], absMedianSec: -95 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 3, n: 3252, relPct: [-7.5, -1.9, 4.7], absPct: [-7.6, -3.1, 2.8], absMedianSec: -132 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 4, n: 650, relPct: [-9.0, -3.7, 4.8], absPct: [-7.7, -3.2, 4.6], absMedianSec: -140 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 'all', n: 34729, relPct: [-9.3, -4.0, 1.6], absPct: [-9.0, -3.9, 1.7], absMedianSec: -207 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 1, n: 18104, relPct: [-8.3, -3.5, 1.5], absPct: [-8.3, -3.7, 1.3], absMedianSec: -195 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 2, n: 10977, relPct: [-10.1, -4.6, 1.5], absPct: [-9.2, -3.9, 2.1], absMedianSec: -207 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 3, n: 4802, relPct: [-11.1, -5.0, 2.4], absPct: [-11.3, -5.0, 1.9], absMedianSec: -264 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 4, n: 846, relPct: [-13.4, -6.2, 2.2], absPct: [-11.8, -5.1, 3.7], absMedianSec: -273 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 'all', n: 14051, relPct: [-13.1, -6.6, 0.1], absPct: [-12.9, -6.4, 0.0], absMedianSec: -413 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 1, n: 7602, relPct: [-11.7, -5.8, 0.4], absPct: [-11.7, -5.9, 0.1], absMedianSec: -376 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 2, n: 4283, relPct: [-13.9, -7.2, -0.4], absPct: [-13.3, -6.6, 0.1], absMedianSec: -426 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 3, n: 1867, relPct: [-16.2, -8.6, -0.1], absPct: [-16.2, -8.1, -0.2], absMedianSec: -527 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 4, n: 299, relPct: [-20.4, -11.8, -3.9], absPct: [-18.4, -10.3, -2.0], absMedianSec: -665 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 'all', n: 5612, relPct: [-18.2, -9.9, -2.0], absPct: [-17.9, -9.5, -1.8], absMedianSec: -763 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 1, n: 3139, relPct: [-16.3, -8.7, -1.6], absPct: [-16.2, -8.7, -1.9], absMedianSec: -694 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 2, n: 1689, relPct: [-18.9, -10.8, -2.2], absPct: [-18.1, -10.0, -1.9], absMedianSec: -797 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 3, n: 669, relPct: [-23.6, -13.2, -2.0], absPct: [-22.3, -12.9, -1.5], absMedianSec: -1054 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 'all', n: 279, relPct: [-5.9, -2.2, 3.3], absPct: [-5.9, -3.0, -0.8], absMedianSec: -105 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 'all', n: 22928, relPct: [-8.5, -3.9, 0.9], absPct: [-8.3, -4.2, 0.0], absMedianSec: -183 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 1, n: 11333, relPct: [-7.4, -3.3, 1.0], absPct: [-7.4, -3.7, 0.1], absMedianSec: -162 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 2, n: 7277, relPct: [-9.3, -4.5, 0.4], absPct: [-8.8, -4.3, 0.1], absMedianSec: -189 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 3, n: 3622, relPct: [-9.9, -4.5, 1.4], absPct: [-10.4, -5.4, -0.5], absMedianSec: -240 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 4, n: 696, relPct: [-11.8, -6.3, 0.2], absPct: [-11.0, -5.8, -0.5], absMedianSec: -253 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 'all', n: 34945, relPct: [-9.9, -4.2, 1.6], absPct: [-9.5, -3.9, 1.8], absMedianSec: -213 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 1, n: 18305, relPct: [-8.8, -3.7, 1.4], absPct: [-8.8, -3.8, 1.3], absMedianSec: -204 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 2, n: 11013, relPct: [-10.6, -4.7, 1.6], absPct: [-9.7, -3.8, 2.3], absMedianSec: -207 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 3, n: 4776, relPct: [-12.1, -5.3, 2.4], absPct: [-11.9, -5.0, 2.1], absMedianSec: -272 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 4, n: 851, relPct: [-14.1, -6.1, 2.9], absPct: [-12.9, -4.9, 4.2], absMedianSec: -269 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 'all', n: 12647, relPct: [-11.1, -4.3, 3.1], absPct: [-10.5, -3.8, 3.8], absMedianSec: -247 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 1, n: 6841, relPct: [-10.3, -4.1, 2.5], absPct: [-10.0, -3.8, 2.9], absMedianSec: -252 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 2, n: 3869, relPct: [-11.9, -4.8, 3.2], absPct: [-10.9, -3.7, 4.2], absMedianSec: -247 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 3, n: 1656, relPct: [-12.9, -3.9, 6.4], absPct: [-11.9, -3.2, 6.9], absMedianSec: -205 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 4, n: 281, relPct: [-16.3, -6.0, 6.4], absPct: [-14.0, -4.3, 8.4], absMedianSec: -275 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 'all', n: 4533, relPct: [-13.0, -4.1, 4.8], absPct: [-11.9, -3.6, 5.4], absMedianSec: -288 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 1, n: 2596, relPct: [-12.3, -4.2, 4.3], absPct: [-11.4, -3.9, 4.3], absMedianSec: -309 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 2, n: 1336, relPct: [-13.6, -4.5, 4.5], absPct: [-12.4, -3.8, 6.1], absMedianSec: -304 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 3, n: 528, relPct: [-14.5, -2.4, 8.5], absPct: [-13.2, -1.6, 7.8], absMedianSec: -124 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 'all', n: 21353, relPct: [-9.4, -4.3, 0.9], absPct: [-8.1, -3.3, 1.7], absMedianSec: -178 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 1, n: 11949, relPct: [-8.3, -3.6, 1.1], absPct: [-7.4, -2.9, 1.6], absMedianSec: -161 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 2, n: 6477, relPct: [-10.3, -5.1, 0.5], absPct: [-8.7, -3.6, 1.8], absMedianSec: -196 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 3, n: 2522, relPct: [-12.0, -5.8, 1.1], absPct: [-10.4, -4.4, 2.2], absMedianSec: -241 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 4, n: 405, relPct: [-13.6, -7.8, -1.0], absPct: [-10.9, -4.3, 3.8], absMedianSec: -234 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 'all', n: 2934, relPct: [-6.0, -2.1, 2.2], absPct: [-4.6, -1.2, 3.0], absMedianSec: -54 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 1, n: 1640, relPct: [-5.3, -1.8, 2.2], absPct: [-4.2, -1.1, 2.6], absMedianSec: -48 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 2, n: 870, relPct: [-6.6, -2.6, 2.0], absPct: [-5.0, -1.3, 4.0], absMedianSec: -58 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 3, n: 364, relPct: [-6.9, -2.5, 2.9], absPct: [-6.1, -1.7, 3.3], absMedianSec: -77 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 'all', n: 10609, relPct: [-8.4, -3.8, 1.2], absPct: [-6.9, -2.6, 2.1], absMedianSec: -141 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 1, n: 5879, relPct: [-7.3, -3.1, 1.4], absPct: [-6.2, -2.4, 1.9], absMedianSec: -125 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 2, n: 3245, relPct: [-9.3, -4.5, 0.7], absPct: [-7.5, -3.0, 2.1], absMedianSec: -161 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 3, n: 1283, relPct: [-10.4, -5.3, 1.8], absPct: [-8.6, -3.5, 2.9], absMedianSec: -183 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 4, n: 202, relPct: [-12.4, -6.6, 0.0], absPct: [-9.3, -3.1, 4.2], absMedianSec: -163 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 'all', n: 5446, relPct: [-11.2, -5.8, 0.0], absPct: [-10.3, -5.0, 0.7], absMedianSec: -323 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 1, n: 3050, relPct: [-9.9, -4.9, 0.6], absPct: [-9.4, -4.6, 0.8], absMedianSec: -291 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 2, n: 1657, relPct: [-12.3, -6.6, -0.6], absPct: [-10.8, -5.1, 0.4], absMedianSec: -332 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 3, n: 633, relPct: [-14.3, -8.3, -0.8], absPct: [-13.5, -7.0, 0.4], absMedianSec: -446 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 'all', n: 2364, relPct: [-15.7, -8.4, -1.4], absPct: [-14.6, -7.7, -1.0], absMedianSec: -606 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 1, n: 1380, relPct: [-14.1, -7.5, -1.2], absPct: [-13.3, -7.0, -0.9], absMedianSec: -562 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 2, n: 705, relPct: [-16.7, -9.3, -1.8], absPct: [-15.2, -8.1, -1.2], absMedianSec: -635 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 3, n: 242, relPct: [-22.0, -12.7, -2.1], absPct: [-19.8, -11.5, -0.8], absMedianSec: -917 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 'all', n: 3275, relPct: [-8.0, -3.9, -0.1], absPct: [-6.8, -3.3, 0.1], absMedianSec: -149 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 1, n: 1809, relPct: [-6.8, -3.1, 0.3], absPct: [-6.0, -2.8, 0.4], absMedianSec: -129 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 2, n: 970, relPct: [-8.9, -4.9, -0.8], absPct: [-7.4, -3.7, -0.1], absMedianSec: -168 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 3, n: 419, relPct: [-9.9, -5.4, -0.2], absPct: [-8.6, -4.6, -0.4], absMedianSec: -198 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 'all', n: 10962, relPct: [-9.2, -4.3, 0.6], absPct: [-7.8, -3.2, 1.5], absMedianSec: -174 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 1, n: 6065, relPct: [-7.9, -3.6, 0.8], absPct: [-7.0, -2.8, 1.4], absMedianSec: -153 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 2, n: 3372, relPct: [-10.1, -5.0, 0.2], absPct: [-8.4, -3.5, 1.8], absMedianSec: -187 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 3, n: 1322, relPct: [-12.0, -6.4, 0.2], absPct: [-10.4, -4.8, 1.2], absMedianSec: -263 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 4, n: 203, relPct: [-13.5, -7.6, -0.6], absPct: [-11.9, -3.8, 3.9], absMedianSec: -209 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 'all', n: 5108, relPct: [-10.2, -4.5, 1.7], absPct: [-9.1, -3.5, 2.8], absMedianSec: -230 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 1, n: 2876, relPct: [-9.3, -3.9, 1.7], absPct: [-8.6, -3.4, 2.5], absMedianSec: -225 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 2, n: 1555, relPct: [-11.0, -5.4, 1.2], absPct: [-9.8, -3.8, 2.6], absMedianSec: -251 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 3, n: 579, relPct: [-12.6, -5.4, 2.9], absPct: [-10.6, -3.5, 5.7], absMedianSec: -226 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 'all', n: 2008, relPct: [-12.1, -4.2, 3.6], absPct: [-10.6, -3.1, 4.7], absMedianSec: -250 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 1, n: 1199, relPct: [-11.3, -4.1, 3.5], absPct: [-9.9, -3.2, 4.3], absMedianSec: -253 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 2, n: 580, relPct: [-13.1, -4.7, 3.4], absPct: [-11.1, -3.8, 4.6], absMedianSec: -294 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 3, n: 202, relPct: [-14.9, -2.7, 5.7], absPct: [-12.8, -1.7, 6.2], absMedianSec: -128 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 'all', n: 44865, relPct: [-10.4, -4.5, 1.5], absPct: [-10.2, -4.6, 1.3], absMedianSec: -231 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 1, n: 22560, relPct: [-9.4, -4.1, 1.3], absPct: [-9.5, -4.5, 0.7], absMedianSec: -227 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 2, n: 14316, relPct: [-11.1, -5.0, 1.4], absPct: [-10.4, -4.4, 1.9], absMedianSec: -221 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 3, n: 6759, relPct: [-11.9, -4.9, 2.7], absPct: [-12.0, -5.2, 1.9], absMedianSec: -261 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 4, n: 1230, relPct: [-14.7, -6.5, 2.9], absPct: [-12.6, -5.1, 3.9], absMedianSec: -258 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 'all', n: 143, relPct: [-2.5, 3.4, 9.4], absPct: [-2.6, -0.2, 4.2], absMedianSec: -6 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 'all', n: 13428, relPct: [-7.1, -2.6, 2.7], absPct: [-6.7, -2.7, 2.4], absMedianSec: -116 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 1, n: 6547, relPct: [-6.2, -2.4, 2.4], absPct: [-6.2, -2.7, 1.8], absMedianSec: -117 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 2, n: 4330, relPct: [-7.9, -3.0, 2.2], absPct: [-7.1, -2.5, 2.8], absMedianSec: -108 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 3, n: 2117, relPct: [-8.1, -2.4, 4.5], absPct: [-7.8, -3.1, 3.4], absMedianSec: -134 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 4, n: 434, relPct: [-9.9, -4.1, 5.6], absPct: [-7.5, -2.5, 6.8], absMedianSec: -102 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 'all', n: 20525, relPct: [-10.1, -4.6, 1.4], absPct: [-10.1, -4.7, 1.4], absMedianSec: -251 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 1, n: 10284, relPct: [-9.0, -4.1, 1.2], absPct: [-9.4, -4.6, 0.7], absMedianSec: -249 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 2, n: 6641, relPct: [-10.9, -5.1, 1.4], absPct: [-10.2, -4.5, 2.1], absMedianSec: -236 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 3, n: 3061, relPct: [-12.0, -5.3, 2.4], absPct: [-12.1, -5.4, 1.8], absMedianSec: -287 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 4, n: 539, relPct: [-14.1, -6.3, 2.9], absPct: [-12.2, -5.3, 4.6], absMedianSec: -276 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 'all', n: 7733, relPct: [-14.5, -7.5, -0.2], absPct: [-14.5, -7.7, -0.6], absMedianSec: -500 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 1, n: 4044, relPct: [-13.1, -6.8, -0.2], absPct: [-13.3, -7.2, -0.8], absMedianSec: -467 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 2, n: 2374, relPct: [-15.0, -7.8, -0.3], absPct: [-14.6, -8.0, -0.2], absMedianSec: -515 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 3, n: 1133, relPct: [-17.6, -9.0, 0.1], absPct: [-17.4, -9.0, -0.5], absMedianSec: -586 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 4, n: 182, relPct: [-21.7, -14.0, -4.5], absPct: [-21.0, -12.0, -4.0], absMedianSec: -792 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 'all', n: 3036, relPct: [-20.3, -11.4, -2.5], absPct: [-20.2, -11.3, -2.7], absMedianSec: -906 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 1, n: 1626, relPct: [-18.2, -10.1, -2.1], absPct: [-18.8, -10.4, -3.1], absMedianSec: -826 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 2, n: 931, relPct: [-21.0, -12.5, -2.6], absPct: [-20.8, -11.5, -2.3], absMedianSec: -919 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 3, n: 407, relPct: [-23.9, -13.9, -2.3], absPct: [-24.6, -13.8, -1.7], absMedianSec: -1152 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 'all', n: 171, relPct: [-4.9, -1.8, 4.7], absPct: [-5.8, -2.8, -0.8], absMedianSec: -101 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 'all', n: 14995, relPct: [-9.2, -4.5, 0.1], absPct: [-9.0, -4.7, -0.4], absMedianSec: -207 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 1, n: 7327, relPct: [-7.9, -3.8, 0.4], absPct: [-7.9, -4.3, -0.4], absMedianSec: -191 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 2, n: 4855, relPct: [-10.1, -5.3, -0.4], absPct: [-9.5, -4.8, -0.2], absMedianSec: -211 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 3, n: 2367, relPct: [-10.7, -5.4, 0.4], absPct: [-11.2, -5.9, -0.8], absMedianSec: -262 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 4, n: 446, relPct: [-12.3, -6.9, -0.2], absPct: [-11.0, -5.4, 0.4], absMedianSec: -243 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 'all', n: 20536, relPct: [-10.8, -4.6, 1.7], absPct: [-10.6, -4.6, 1.8], absMedianSec: -251 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 1, n: 10345, relPct: [-9.7, -4.2, 1.3], absPct: [-10.0, -4.7, 0.9], absMedianSec: -254 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 2, n: 6587, relPct: [-11.4, -4.9, 1.8], absPct: [-10.5, -4.2, 2.4], absMedianSec: -228 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 3, n: 3036, relPct: [-12.6, -5.1, 2.8], absPct: [-12.7, -5.1, 2.6], absMedianSec: -277 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 4, n: 568, relPct: [-15.1, -6.3, 3.7], absPct: [-13.4, -5.1, 5.0], absMedianSec: -283 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 'all', n: 6798, relPct: [-12.1, -4.4, 4.2], absPct: [-11.7, -4.1, 4.6], absMedianSec: -271 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 1, n: 3520, relPct: [-11.3, -4.5, 2.9], absPct: [-11.1, -4.6, 3.2], absMedianSec: -303 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 2, n: 2107, relPct: [-12.5, -4.6, 4.6], absPct: [-11.9, -3.7, 5.5], absMedianSec: -242 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 3, n: 1002, relPct: [-13.3, -2.9, 8.1], absPct: [-12.6, -3.0, 7.4], absMedianSec: -197 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 4, n: 169, relPct: [-18.8, -6.0, 9.1], absPct: [-16.4, -4.6, 10.0], absMedianSec: -300 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 'all', n: 2365, relPct: [-14.0, -4.4, 5.7], absPct: [-13.1, -4.1, 5.8], absMedianSec: -339 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 1, n: 1294, relPct: [-13.7, -4.7, 4.6], absPct: [-12.8, -4.8, 4.1], absMedianSec: -398 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 2, n: 718, relPct: [-14.2, -4.3, 5.3], absPct: [-13.2, -3.8, 7.1], absMedianSec: -313 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 3, n: 310, relPct: [-14.7, -2.8, 9.5], absPct: [-14.4, -1.7, 9.1], absMedianSec: -125 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 'all', n: 1619, relPct: [-6.5, -1.2, 4.4], absPct: [-6.7, -2.3, 2.2], absMedianSec: -110 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 1, n: 1059, relPct: [-6.1, -0.7, 5.1], absPct: [-6.0, -1.8, 2.6], absMedianSec: -90 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 2, n: 427, relPct: [-7.2, -2.5, 3.0], absPct: [-7.4, -3.1, 1.9], absMedianSec: -143 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 'all', n: 591, relPct: [-5.0, -0.6, 5.6], absPct: [-4.8, -1.3, 2.1], absMedianSec: -54 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 1, n: 353, relPct: [-4.2, 0.6, 7.2], absPct: [-3.8, -0.7, 3.1], absMedianSec: -30 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 2, n: 170, relPct: [-5.8, -2.0, 2.4], absPct: [-5.8, -1.6, 1.9], absMedianSec: -72 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 'all', n: 793, relPct: [-6.3, -1.2, 4.3], absPct: [-6.8, -2.4, 2.6], absMedianSec: -126 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 1, n: 529, relPct: [-5.9, -0.8, 4.5], absPct: [-6.4, -1.8, 2.6], absMedianSec: -100 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 2, n: 204, relPct: [-7.9, -2.4, 4.2], absPct: [-7.1, -3.3, 2.4], absMedianSec: -178 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 'all', n: 176, relPct: [-9.5, -4.6, 2.4], absPct: [-10.5, -5.1, 0.8], absMedianSec: -342 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 1, n: 136, relPct: [-9.5, -4.1, 2.9], absPct: [-10.3, -4.8, 1.0], absMedianSec: -316 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 'all', n: 626, relPct: [-6.1, -1.7, 4.1], absPct: [-6.4, -2.5, 0.7], absMedianSec: -112 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 1, n: 361, relPct: [-5.2, -0.6, 5.8], absPct: [-5.1, -1.7, 1.4], absMedianSec: -75 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 2, n: 190, relPct: [-6.9, -3.7, 1.1], absPct: [-7.7, -3.5, -0.2], absMedianSec: -148 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 'all', n: 790, relPct: [-6.2, -0.9, 4.7], absPct: [-6.6, -1.8, 3.3], absMedianSec: -97 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 1, n: 543, relPct: [-6.0, -0.8, 4.6], absPct: [-6.5, -1.8, 3.0], absMedianSec: -93 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 2, n: 195, relPct: [-6.7, -1.4, 4.7], absPct: [-6.5, -1.8, 3.6], absMedianSec: -89 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 'all', n: 161, relPct: [-9.5, -2.5, 4.1], absPct: [-10.0, -2.5, 3.3], absMedianSec: -160 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 1, n: 123, relPct: [-9.2, -0.6, 5.1], absPct: [-9.8, -2.0, 4.3], absMedianSec: -132 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 'all', n: 7495, relPct: [-7.0, -1.5, 4.1], absPct: [-8.4, -3.3, 2.1], absMedianSec: -151 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 1, n: 3601, relPct: [-6.7, -1.6, 3.8], absPct: [-7.6, -2.8, 2.3], absMedianSec: -132 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 2, n: 2353, relPct: [-7.0, -1.3, 4.6], absPct: [-8.3, -3.0, 2.5], absMedianSec: -141 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 3, n: 1265, relPct: [-7.5, -1.5, 4.7], absPct: [-9.8, -4.6, 1.2], absMedianSec: -207 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'all', gapHalfSeasons: 4, n: 276, relPct: [-9.5, -3.3, 2.8], absPct: [-11.1, -5.8, -1.1], absMedianSec: -244 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 'all', n: 3758, relPct: [-5.3, -0.5, 4.7], absPct: [-6.2, -2.2, 2.5], absMedianSec: -92 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 1, n: 1703, relPct: [-4.9, -0.5, 4.3], absPct: [-5.3, -1.6, 2.7], absMedianSec: -67 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 2, n: 1196, relPct: [-5.2, -0.3, 4.9], absPct: [-6.2, -2.1, 2.8], absMedianSec: -88 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 3, n: 715, relPct: [-6.2, -0.6, 5.8], absPct: [-7.6, -3.3, 1.5], absMedianSec: -144 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 4, n: 144, relPct: [-6.5, -2.3, 3.9], absPct: [-9.0, -4.6, 0.2], absMedianSec: -196 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 'all', n: 2802, relPct: [-7.9, -2.1, 3.9], absPct: [-10.1, -4.4, 1.8], absMedianSec: -226 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 1, n: 1412, relPct: [-7.5, -2.2, 3.1], absPct: [-9.0, -3.9, 1.8], absMedianSec: -201 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 2, n: 887, relPct: [-8.0, -1.4, 4.9], absPct: [-9.6, -3.9, 2.9], absMedianSec: -200 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 3, n: 409, relPct: [-8.9, -2.6, 3.9], absPct: [-12.9, -7.0, -0.6], absMedianSec: -372 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 'all', n: 696, relPct: [-12.3, -5.5, 1.9], absPct: [-14.6, -7.2, 0.5], absMedianSec: -457 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 1, n: 372, relPct: [-10.5, -4.5, 2.6], absPct: [-12.7, -5.3, 2.0], absMedianSec: -346 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 2, n: 214, relPct: [-15.5, -7.2, 0.5], absPct: [-17.9, -9.5, -0.9], absMedianSec: -612 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 'all', n: 154, relPct: [-19.7, -11.4, -1.7], absPct: [-22.2, -14.0, -4.6], absMedianSec: -1122 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 'all', n: 4032, relPct: [-6.3, -1.5, 3.6], absPct: [-7.5, -3.3, 1.2], absMedianSec: -143 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 1, n: 1836, relPct: [-5.9, -1.4, 3.4], absPct: [-6.5, -2.8, 1.4], absMedianSec: -118 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 2, n: 1262, relPct: [-6.2, -1.4, 3.5], absPct: [-7.4, -3.2, 1.2], absMedianSec: -141 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 3, n: 776, relPct: [-7.3, -1.6, 4.3], absPct: [-9.0, -4.6, 0.4], absMedianSec: -200 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 4, n: 158, relPct: [-8.7, -3.4, 2.6], absPct: [-11.0, -6.2, -1.6], absMedianSec: -258 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 'all', n: 2657, relPct: [-7.6, -1.5, 4.7], absPct: [-9.5, -3.2, 3.1], absMedianSec: -170 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 1, n: 1352, relPct: [-7.3, -1.8, 4.1], absPct: [-8.6, -3.1, 2.8], absMedianSec: -161 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 2, n: 859, relPct: [-7.6, -1.0, 5.6], absPct: [-9.6, -2.5, 4.2], absMedianSec: -131 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 3, n: 374, relPct: [-9.2, -1.5, 5.1], absPct: [-12.0, -5.5, 2.3], absMedianSec: -301 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 'all', n: 580, relPct: [-10.9, -1.7, 6.3], absPct: [-11.7, -3.1, 5.5], absMedianSec: -206 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 1, n: 322, relPct: [-10.1, -1.6, 5.3], absPct: [-10.1, -2.5, 4.8], absMedianSec: -172 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 2, n: 174, relPct: [-13.9, -3.2, 7.5], absPct: [-13.6, -3.3, 5.7], absMedianSec: -224 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 'all', n: 119, relPct: [-8.0, -0.2, 12.8], absPct: [-11.4, -1.5, 9.8], absMedianSec: -124 },
];

/** Improvement cells withheld for n < HYROX_S79_MIN_CELL_N (empty cells omitted). */
export const HYROX_S79_IMPROVEMENT_SUPPRESSED: ReadonlyArray<Pick<HyroxImprovementCell, 'format' | 'sex' | 'groupBy' | 'band' | 'gapHalfSeasons' | 'n'>> = [
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 1, n: 81 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 2, n: 58 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 3, n: 66 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 4, n: 24 },
  { format: 'all_singles', sex: 'all', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 4, n: 115 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 1, n: 94 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 2, n: 78 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 3, n: 74 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 4, n: 33 },
  { format: 'all_singles', sex: 'all', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 4, n: 73 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 4, n: 60 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 4, n: 106 },
  { format: 'open_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 4, n: 37 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 4, n: 77 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 4, n: 98 },
  { format: 'open_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 4, n: 27 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 1, n: 59 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 2, n: 40 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 3, n: 41 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 4, n: 3 },
  { format: 'open_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 4, n: 72 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 1, n: 74 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 2, n: 49 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 3, n: 44 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 4, n: 4 },
  { format: 'open_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 4, n: 43 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 3, n: 110 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'all', gapHalfSeasons: 4, n: 23 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 'all', n: 1 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 1, n: 1 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 3, n: 56 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'advanced', gapHalfSeasons: 4, n: 12 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 3, n: 49 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 4, n: 11 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 2, n: 38 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 3, n: 2 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 'all', n: 58 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 1, n: 40 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 2, n: 15 },
  { format: 'pro_singles', sex: 'female', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 3, n: 3 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 'all', n: 1 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 2, n: 1 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 3, n: 60 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'advanced', gapHalfSeasons: 4, n: 15 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 3, n: 44 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 4, n: 8 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 2, n: 33 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 3, n: 5 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 'all', n: 41 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 1, n: 32 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 2, n: 8 },
  { format: 'pro_singles', sex: 'female', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 3, n: 1 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 'all', n: 85 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 1, n: 21 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 2, n: 18 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 3, n: 25 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'competitive', gapHalfSeasons: 4, n: 21 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'intermediate', gapHalfSeasons: 4, n: 94 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 3, n: 99 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'novice', gapHalfSeasons: 4, n: 11 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 1, n: 93 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 2, n: 38 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 3, n: 17 },
  { format: 'pro_singles', sex: 'male', groupBy: 'first_race', band: 'beginner', gapHalfSeasons: 4, n: 6 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 'all', n: 107 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 1, n: 20 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 2, n: 28 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 3, n: 30 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'competitive', gapHalfSeasons: 4, n: 29 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'intermediate', gapHalfSeasons: 4, n: 72 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 3, n: 70 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'novice', gapHalfSeasons: 4, n: 14 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 1, n: 71 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 2, n: 30 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 3, n: 15 },
  { format: 'pro_singles', sex: 'male', groupBy: 'mean_of_races', band: 'beginner', gapHalfSeasons: 4, n: 3 },
];

/**
 * Field-relative ability bands, seasons 8 and 9 (HYROX_S89_SEASONS).
 *
 * HYROX_TIME_TO_BAND_THRESHOLDS is one finish-time scale for every format and
 * sex, so women and doubles athletes were banded against a male-dominated
 * singles field. Each threshold is kept as a position in the field instead:
 * HYROX_S89_BAND_FIELD_PERCENTILES is each threshold's cumulative percentile in
 * the app's earlier pooled open singles total table (S4 to S6,
 * HYROX_TOTAL_PERCENTILE_TABLES.open_singles). The only recorded anchor for the
 * thresholds, the HyroxDataLab list in SCIENCE_LOG "HYROX Population Percentiles"
 * (60, 80, 100, 120 min at p5, p15, p35, p60), was rejected: it was hand-set and
 * contradicts the real results (60 min is below p1 of the S4 to S6 field), and
 * reading the thresholds there would push most athletes down a band. 3600 s sits
 * below that table's p1, which the clamped lookup reads as p1, the finest
 * percentile it resolves. HYROX_S89_BAND_THRESHOLDS_SEC is the total time at those
 * percentiles in each format x sex field (type 7 quantile), plus each format
 * with its sexes pooled (the fallback for an unknown sex). Thresholds apply as
 * bandFromTime does: sec < threshold, first match wins, beginner above the last.
 *
 * HYROX_S89_BAND_SEEDS: for each band, the median of every metric among the
 * finishers whose total falls in that band of their field. The median split of
 * the band's athletes, not each split's own quantile (split ranks are not
 * comonotonic with total rank). total_beginner has no finish-time threshold
 * (it is the experience pick for a first HYROX); consumers give it the
 * beginner cell. Doubles station seeds are the pair's time at the station.
 */
export const HYROX_S89_BAND_FIELD_PERCENTILES: readonly number[] = [1.0, 25.3211, 73.5085, 92.916];
export type HyroxBandCellSex = HyroxResultsSex | 'pooled';
export type HyroxTimeBand = Exclude<AbilityBand, 'total_beginner'>;
export const HYROX_S89_BAND_THRESHOLDS_SEC: Record<HyroxResultsFormat, Partial<Record<HyroxBandCellSex, readonly number[]>>> = {
  open_singles: { female: [4135, 5188, 6617, 8184], male: [3701, 4708, 6115, 7627], pooled: [3774, 4869, 6318, 7853] },
  pro_singles: { female: [3747, 4651, 5922, 7323], male: [3462, 4322, 5560, 6886], pooled: [3509, 4417, 5685, 7040] },
  open_doubles: { female: [3967, 4848, 5894, 6936], male: [3396, 4167, 5167, 6188], mixed: [3544, 4516, 5611, 6739], pooled: [3511, 4484, 5604, 6686] },
  pro_doubles: { female: [3555, 4344, 5324, 6395], male: [3154, 3811, 4673, 5548], pooled: [3211, 3967, 4950, 5932] },
};
export interface HyroxBandSeedCell { n: number; nSplits: number; nRoxzone: number; medians: Record<HyroxResultsMetric, number> }
export const HYROX_S89_BAND_SEEDS: Record<HyroxResultsFormat, Partial<Record<HyroxBandCellSex, Partial<Record<HyroxTimeBand, HyroxBandSeedCell>>>>> = {
  open_singles: {
    female: {
      competitive: { n: 1194, nSplits: 1185, nRoxzone: 1122, medians: { total: 4027, run_total: 1993, work_total: 1717, roxzone: 290, ski_erg: 281, sled_push: 126, sled_pull: 231, burpee_broad_jumps: 239, row_erg: 287, farmer_carry: 102, sandbag_lunges: 197, wall_balls: 243 } },
      advanced: { n: 29036, nSplits: 28741, nRoxzone: 26889, medians: { total: 4839, run_total: 2368, work_total: 2055, roxzone: 374, ski_erg: 299, sled_push: 149, sled_pull: 283, burpee_broad_jumps: 311, row_erg: 309, farmer_carry: 120, sandbag_lunges: 249, wall_balls: 313 } },
      intermediate: { n: 57583, nSplits: 56994, nRoxzone: 53501, medians: { total: 5800, run_total: 2817, work_total: 2484, roxzone: 485, ski_erg: 319, sled_push: 176, sled_pull: 349, burpee_broad_jumps: 409, row_erg: 332, farmer_carry: 140, sandbag_lunges: 316, wall_balls: 413 } },
      novice: { n: 23191, nSplits: 22846, nRoxzone: 21510, medians: { total: 7151, run_total: 3424, work_total: 3108, roxzone: 628, ski_erg: 343, sled_push: 213, sled_pull: 437, burpee_broad_jumps: 551, row_erg: 362, farmer_carry: 167, sandbag_lunges: 415, wall_balls: 570 } },
      beginner: { n: 8464, nSplits: 8297, nRoxzone: 7921, medians: { total: 8988, run_total: 4309, work_total: 3991, roxzone: 783, ski_erg: 371, sled_push: 254, sled_pull: 548, burpee_broad_jumps: 752, row_erg: 398, farmer_carry: 200, sandbag_lunges: 564, wall_balls: 820 } },
    },
    male: {
      competitive: { n: 2095, nSplits: 2078, nRoxzone: 2009, medians: { total: 3599, run_total: 1784, work_total: 1544, roxzone: 256, ski_erg: 246, sled_push: 134, sled_pull: 190, burpee_broad_jumps: 187, row_erg: 254, farmer_carry: 92, sandbag_lunges: 190, wall_balls: 240 } },
      advanced: { n: 51137, nSplits: 50808, nRoxzone: 49206, medians: { total: 4368, run_total: 2097, work_total: 1892, roxzone: 335, ski_erg: 259, sled_push: 159, sled_pull: 239, burpee_broad_jumps: 255, row_erg: 272, farmer_carry: 109, sandbag_lunges: 253, wall_balls: 323 } },
      intermediate: { n: 101268, nSplits: 100238, nRoxzone: 96785, medians: { total: 5313, run_total: 2517, work_total: 2325, roxzone: 450, ski_erg: 276, sled_push: 188, sled_pull: 301, burpee_broad_jumps: 340, row_erg: 295, farmer_carry: 133, sandbag_lunges: 325, wall_balls: 437 } },
      novice: { n: 40832, nSplits: 40158, nRoxzone: 38660, medians: { total: 6639, run_total: 3099, work_total: 2930, roxzone: 615, ski_erg: 295, sled_push: 233, sled_pull: 384, burpee_broad_jumps: 452, row_erg: 324, farmer_carry: 163, sandbag_lunges: 421, wall_balls: 601 } },
      beginner: { n: 14904, nSplits: 14534, nRoxzone: 14022, medians: { total: 8422, run_total: 3959, work_total: 3731, roxzone: 811, ski_erg: 318, sled_push: 295, sled_pull: 487, burpee_broad_jumps: 592, row_erg: 355, farmer_carry: 197, sandbag_lunges: 559, wall_balls: 843 } },
    },
    pooled: {
      competitive: { n: 3293, nSplits: 3274, nRoxzone: 3171, medians: { total: 3660, run_total: 1808, work_total: 1572, roxzone: 262, ski_erg: 248, sled_push: 135, sled_pull: 194, burpee_broad_jumps: 192, row_erg: 256, farmer_carry: 94, sandbag_lunges: 195, wall_balls: 245 } },
      advanced: { n: 80093, nSplits: 79502, nRoxzone: 76465, medians: { total: 4503, run_total: 2168, work_total: 1943, roxzone: 347, ski_erg: 266, sled_push: 157, sled_pull: 250, burpee_broad_jumps: 269, row_erg: 279, farmer_carry: 113, sandbag_lunges: 254, wall_balls: 324 } },
      intermediate: { n: 158968, nSplits: 157271, nRoxzone: 150094, medians: { total: 5496, run_total: 2630, work_total: 2385, roxzone: 464, ski_erg: 291, sled_push: 183, sled_pull: 319, burpee_broad_jumps: 365, row_erg: 309, farmer_carry: 136, sandbag_lunges: 321, wall_balls: 425 } },
      novice: { n: 63980, nSplits: 63010, nRoxzone: 60006, medians: { total: 6851, run_total: 3238, work_total: 2997, roxzone: 620, ski_erg: 316, sled_push: 222, sled_pull: 407, burpee_broad_jumps: 493, row_erg: 341, farmer_carry: 164, sandbag_lunges: 414, wall_balls: 580 } },
      beginner: { n: 23370, nSplits: 22822, nRoxzone: 21889, medians: { total: 8662, run_total: 4115, work_total: 3834, roxzone: 798, ski_erg: 342, sled_push: 273, sled_pull: 514, burpee_broad_jumps: 660, row_erg: 375, farmer_carry: 198, sandbag_lunges: 557, wall_balls: 825 } },
    },
  },
  pro_singles: {
    female: {
      competitive: { n: 188, nSplits: 187, nRoxzone: 181, medians: { total: 3665, run_total: 1784, work_total: 1610, roxzone: 256, ski_erg: 260, sled_push: 156, sled_pull: 217, burpee_broad_jumps: 193, row_erg: 268, farmer_carry: 100, sandbag_lunges: 185, wall_balls: 222 } },
      advanced: { n: 4601, nSplits: 4562, nRoxzone: 4370, medians: { total: 4329, run_total: 2052, work_total: 1940, roxzone: 306, ski_erg: 277, sled_push: 195, sled_pull: 272, burpee_broad_jumps: 239, row_erg: 287, farmer_carry: 122, sandbag_lunges: 239, wall_balls: 286 } },
      intermediate: { n: 9127, nSplits: 9022, nRoxzone: 8636, medians: { total: 5209, run_total: 2418, work_total: 2377, roxzone: 396, ski_erg: 295, sled_push: 241, sled_pull: 347, burpee_broad_jumps: 313, row_erg: 308, farmer_carry: 157, sandbag_lunges: 311, wall_balls: 381 } },
      novice: { n: 3674, nSplits: 3621, nRoxzone: 3468, medians: { total: 6418, run_total: 2909, work_total: 2976, roxzone: 523, ski_erg: 314, sled_push: 303, sled_pull: 444, burpee_broad_jumps: 408, row_erg: 332, farmer_carry: 202, sandbag_lunges: 400, wall_balls: 524 } },
      beginner: { n: 1342, nSplits: 1302, nRoxzone: 1251, medians: { total: 8119, run_total: 3623, work_total: 3853, roxzone: 700, ski_erg: 339, sled_push: 394, sled_pull: 581, burpee_broad_jumps: 544, row_erg: 365, farmer_carry: 255, sandbag_lunges: 541, wall_balls: 764 } },
    },
    male: {
      competitive: { n: 400, nSplits: 396, nRoxzone: 382, medians: { total: 3400, run_total: 1678, work_total: 1474, roxzone: 242, ski_erg: 232, sled_push: 152, sled_pull: 200, burpee_broad_jumps: 156, row_erg: 239, farmer_carry: 86, sandbag_lunges: 173, wall_balls: 229 } },
      advanced: { n: 9821, nSplits: 9738, nRoxzone: 9378, medians: { total: 4021, run_total: 1887, work_total: 1815, roxzone: 286, ski_erg: 245, sled_push: 188, sled_pull: 258, burpee_broad_jumps: 198, row_erg: 257, farmer_carry: 104, sandbag_lunges: 231, wall_balls: 307 } },
      intermediate: { n: 19477, nSplits: 19327, nRoxzone: 18465, medians: { total: 4861, run_total: 2210, work_total: 2260, roxzone: 372, ski_erg: 258, sled_push: 233, sled_pull: 343, burpee_broad_jumps: 265, row_erg: 275, farmer_carry: 132, sandbag_lunges: 304, wall_balls: 415 } },
      novice: { n: 7838, nSplits: 7733, nRoxzone: 7373, medians: { total: 6010, run_total: 2648, work_total: 2859, roxzone: 504, ski_erg: 273, sled_push: 294, sled_pull: 461, burpee_broad_jumps: 347, row_erg: 298, farmer_carry: 171, sandbag_lunges: 392, wall_balls: 565 } },
      beginner: { n: 2867, nSplits: 2782, nRoxzone: 2675, medians: { total: 7633, run_total: 3330, work_total: 3681, roxzone: 694, ski_erg: 293, sled_push: 388, sled_pull: 613, burpee_broad_jumps: 448, row_erg: 327, farmer_carry: 218, sandbag_lunges: 520, wall_balls: 800 } },
    },
    pooled: {
      competitive: { n: 592, nSplits: 588, nRoxzone: 569, medians: { total: 3431, run_total: 1690, work_total: 1491, roxzone: 242, ski_erg: 232, sled_push: 153, sled_pull: 203, burpee_broad_jumps: 158, row_erg: 239, farmer_carry: 87, sandbag_lunges: 176, wall_balls: 233 } },
      advanced: { n: 14407, nSplits: 14280, nRoxzone: 13730, medians: { total: 4105, run_total: 1928, work_total: 1850, roxzone: 293, ski_erg: 250, sled_push: 190, sled_pull: 262, burpee_broad_jumps: 209, row_erg: 262, farmer_carry: 108, sandbag_lunges: 234, wall_balls: 304 } },
      intermediate: { n: 28615, nSplits: 28373, nRoxzone: 27104, medians: { total: 4977, run_total: 2276, work_total: 2300, roxzone: 380, ski_erg: 268, sled_push: 236, sled_pull: 344, burpee_broad_jumps: 280, row_erg: 285, farmer_carry: 140, sandbag_lunges: 306, wall_balls: 402 } },
      novice: { n: 11517, nSplits: 11349, nRoxzone: 10861, medians: { total: 6150, run_total: 2749, work_total: 2894, roxzone: 510, ski_erg: 287, sled_push: 296, sled_pull: 452, burpee_broad_jumps: 369, row_erg: 311, farmer_carry: 183, sandbag_lunges: 393, wall_balls: 543 } },
      beginner: { n: 4204, nSplits: 4080, nRoxzone: 3915, medians: { total: 7818, run_total: 3440, work_total: 3737, roxzone: 697, ski_erg: 310, sled_push: 389, sled_pull: 597, burpee_broad_jumps: 482, row_erg: 343, farmer_carry: 233, sandbag_lunges: 527, wall_balls: 780 } },
    },
  },
  open_doubles: {
    female: {
      competitive: { n: 1371, nSplits: 1345, nRoxzone: 1260, medians: { total: 3865, run_total: 2075, work_total: 1464, roxzone: 296, ski_erg: 258, sled_push: 92, sled_pull: 190, burpee_broad_jumps: 173, row_erg: 277, farmer_carry: 89, sandbag_lunges: 162, wall_balls: 214 } },
      advanced: { n: 33550, nSplits: 33182, nRoxzone: 31335, medians: { total: 4567, run_total: 2516, work_total: 1642, roxzone: 371, ski_erg: 274, sled_push: 100, sled_pull: 219, burpee_broad_jumps: 212, row_erg: 295, farmer_carry: 101, sandbag_lunges: 193, wall_balls: 235 } },
      intermediate: { n: 66503, nSplits: 65681, nRoxzone: 62317, medians: { total: 5310, run_total: 2967, work_total: 1857, roxzone: 473, ski_erg: 291, sled_push: 112, sled_pull: 255, burpee_broad_jumps: 261, row_erg: 314, farmer_carry: 113, sandbag_lunges: 230, wall_balls: 266 } },
      novice: { n: 26778, nSplits: 26375, nRoxzone: 25210, medians: { total: 6265, run_total: 3528, work_total: 2134, roxzone: 602, ski_erg: 308, sled_push: 127, sled_pull: 298, burpee_broad_jumps: 325, row_erg: 336, farmer_carry: 125, sandbag_lunges: 276, wall_balls: 315 } },
      beginner: { n: 9786, nSplits: 9591, nRoxzone: 9247, medians: { total: 7466, run_total: 4308, work_total: 2496, roxzone: 734, ski_erg: 329, sled_push: 142, sled_pull: 345, burpee_broad_jumps: 411, row_erg: 360, farmer_carry: 136, sandbag_lunges: 335, wall_balls: 393 } },
    },
    male: {
      competitive: { n: 1295, nSplits: 1282, nRoxzone: 1219, medians: { total: 3311, run_total: 1777, work_total: 1269, roxzone: 245, ski_erg: 219, sled_push: 90, sled_pull: 147, burpee_broad_jumps: 129, row_erg: 238, farmer_carry: 80, sandbag_lunges: 147, wall_balls: 214 } },
      advanced: { n: 31804, nSplits: 31501, nRoxzone: 29808, medians: { total: 3909, run_total: 2116, work_total: 1444, roxzone: 315, ski_erg: 233, sled_push: 102, sled_pull: 174, burpee_broad_jumps: 161, row_erg: 255, farmer_carry: 90, sandbag_lunges: 182, wall_balls: 238 } },
      intermediate: { n: 62957, nSplits: 62212, nRoxzone: 59050, medians: { total: 4610, run_total: 2552, work_total: 1635, roxzone: 408, ski_erg: 246, sled_push: 112, sled_pull: 204, burpee_broad_jumps: 196, row_erg: 273, farmer_carry: 101, sandbag_lunges: 219, wall_balls: 269 } },
      novice: { n: 25399, nSplits: 25049, nRoxzone: 23619, medians: { total: 5523, run_total: 3093, work_total: 1883, roxzone: 554, ski_erg: 261, sled_push: 129, sled_pull: 242, burpee_broad_jumps: 238, row_erg: 296, farmer_carry: 113, sandbag_lunges: 264, wall_balls: 315 } },
      beginner: { n: 9262, nSplits: 9094, nRoxzone: 8653, medians: { total: 6718, run_total: 3865, work_total: 2191, roxzone: 722, ski_erg: 278, sled_push: 152, sled_pull: 287, burpee_broad_jumps: 286, row_erg: 320, farmer_carry: 125, sandbag_lunges: 320, wall_balls: 383 } },
    },
    mixed: {
      competitive: { n: 1456, nSplits: 1436, nRoxzone: 1383, medians: { total: 3452, run_total: 1848, work_total: 1329, roxzone: 255, ski_erg: 229, sled_push: 99, sled_pull: 162, burpee_broad_jumps: 139, row_erg: 246, farmer_carry: 85, sandbag_lunges: 155, wall_balls: 211 } },
      advanced: { n: 35693, nSplits: 35270, nRoxzone: 34115, medians: { total: 4211, run_total: 2278, work_total: 1556, roxzone: 335, ski_erg: 246, sled_push: 117, sled_pull: 202, burpee_broad_jumps: 175, row_erg: 268, farmer_carry: 98, sandbag_lunges: 199, wall_balls: 238 } },
      intermediate: { n: 70826, nSplits: 69746, nRoxzone: 67557, medians: { total: 5005, run_total: 2751, work_total: 1800, roxzone: 437, ski_erg: 262, sled_push: 134, sled_pull: 242, burpee_broad_jumps: 218, row_erg: 289, farmer_carry: 111, sandbag_lunges: 246, wall_balls: 280 } },
      novice: { n: 28551, nSplits: 27960, nRoxzone: 27065, medians: { total: 6005, run_total: 3315, work_total: 2121, roxzone: 574, ski_erg: 280, sled_push: 157, sled_pull: 290, burpee_broad_jumps: 272, row_erg: 313, farmer_carry: 124, sandbag_lunges: 303, wall_balls: 351 } },
      beginner: { n: 10410, nSplits: 10120, nRoxzone: 9778, medians: { total: 7313, run_total: 4106, work_total: 2552, roxzone: 734, ski_erg: 301, sled_push: 189, sled_pull: 348, burpee_broad_jumps: 339, row_erg: 339, farmer_carry: 138, sandbag_lunges: 379, wall_balls: 469 } },
    },
    pooled: {
      competitive: { n: 4156, nSplits: 4106, nRoxzone: 3922, medians: { total: 3417, run_total: 1830, work_total: 1310, roxzone: 257, ski_erg: 224, sled_push: 94, sled_pull: 155, burpee_broad_jumps: 135, row_erg: 242, farmer_carry: 83, sandbag_lunges: 154, wall_balls: 215 } },
      advanced: { n: 100904, nSplits: 99816, nRoxzone: 95155, medians: { total: 4168, run_total: 2266, work_total: 1525, roxzone: 337, ski_erg: 243, sled_push: 107, sled_pull: 192, burpee_broad_jumps: 175, row_erg: 266, farmer_carry: 95, sandbag_lunges: 192, wall_balls: 240 } },
      intermediate: { n: 200352, nSplits: 197724, nRoxzone: 188856, medians: { total: 4996, run_total: 2766, work_total: 1769, roxzone: 441, ski_erg: 267, sled_push: 119, sled_pull: 236, burpee_broad_jumps: 225, row_erg: 293, farmer_carry: 109, sandbag_lunges: 231, wall_balls: 270 } },
      novice: { n: 80765, nSplits: 79403, nRoxzone: 75960, medians: { total: 5987, run_total: 3347, work_total: 2067, roxzone: 579, ski_erg: 289, sled_push: 136, sled_pull: 283, burpee_broad_jumps: 285, row_erg: 320, farmer_carry: 122, sandbag_lunges: 279, wall_balls: 322 } },
      beginner: { n: 29464, nSplits: 28795, nRoxzone: 27723, medians: { total: 7226, run_total: 4131, work_total: 2444, roxzone: 729, ski_erg: 309, sled_push: 157, sled_pull: 334, burpee_broad_jumps: 358, row_erg: 345, farmer_carry: 134, sandbag_lunges: 343, wall_balls: 411 } },
    },
  },
  pro_doubles: {
    female: {
      competitive: { n: 166, nSplits: 166, nRoxzone: 163, medians: { total: 3475, run_total: 1804, work_total: 1420, roxzone: 246, ski_erg: 241, sled_push: 114, sled_pull: 188, burpee_broad_jumps: 147, row_erg: 257, farmer_carry: 91, sandbag_lunges: 161, wall_balls: 205 } },
      advanced: { n: 4039, nSplits: 3984, nRoxzone: 3885, medians: { total: 4084, run_total: 2154, work_total: 1593, roxzone: 305, ski_erg: 256, sled_push: 132, sled_pull: 222, burpee_broad_jumps: 175, row_erg: 276, farmer_carry: 103, sandbag_lunges: 196, wall_balls: 222 } },
      intermediate: { n: 8007, nSplits: 7919, nRoxzone: 7732, medians: { total: 4781, run_total: 2567, work_total: 1814, roxzone: 390, ski_erg: 271, sled_push: 150, sled_pull: 266, burpee_broad_jumps: 211, row_erg: 293, farmer_carry: 115, sandbag_lunges: 240, wall_balls: 252 } },
      novice: { n: 3224, nSplits: 3182, nRoxzone: 3121, medians: { total: 5675, run_total: 3058, work_total: 2111, roxzone: 510, ski_erg: 287, sled_push: 173, sled_pull: 316, burpee_broad_jumps: 260, row_erg: 314, farmer_carry: 129, sandbag_lunges: 296, wall_balls: 307 } },
      beginner: { n: 1178, nSplits: 1150, nRoxzone: 1115, medians: { total: 6926, run_total: 3779, work_total: 2561, roxzone: 661, ski_erg: 307, sled_push: 205, sled_pull: 387, burpee_broad_jumps: 337, row_erg: 340, farmer_carry: 145, sandbag_lunges: 365, wall_balls: 425 } },
    },
    male: {
      competitive: { n: 278, nSplits: 276, nRoxzone: 269, medians: { total: 3087, run_total: 1644, work_total: 1231, roxzone: 219, ski_erg: 206, sled_push: 101, sled_pull: 164, burpee_broad_jumps: 111, row_erg: 219, farmer_carry: 78, sandbag_lunges: 140, wall_balls: 208 } },
      advanced: { n: 6844, nSplits: 6774, nRoxzone: 6619, medians: { total: 3579, run_total: 1874, work_total: 1422, roxzone: 263, ski_erg: 220, sled_push: 119, sled_pull: 203, burpee_broad_jumps: 135, row_erg: 241, farmer_carry: 91, sandbag_lunges: 176, wall_balls: 226 } },
      intermediate: { n: 13560, nSplits: 13428, nRoxzone: 13166, medians: { total: 4190, run_total: 2221, work_total: 1623, roxzone: 333, ski_erg: 233, sled_push: 136, sled_pull: 247, burpee_broad_jumps: 164, row_erg: 256, farmer_carry: 100, sandbag_lunges: 217, wall_balls: 254 } },
      novice: { n: 5472, nSplits: 5404, nRoxzone: 5289, medians: { total: 4968, run_total: 2656, work_total: 1879, roxzone: 436, ski_erg: 245, sled_push: 158, sled_pull: 300, burpee_broad_jumps: 195, row_erg: 275, farmer_carry: 111, sandbag_lunges: 260, wall_balls: 303 } },
      beginner: { n: 1995, nSplits: 1939, nRoxzone: 1878, medians: { total: 6035, run_total: 3259, work_total: 2234, roxzone: 597, ski_erg: 259, sled_push: 193, sled_pull: 364, burpee_broad_jumps: 234, row_erg: 298, farmer_carry: 124, sandbag_lunges: 319, wall_balls: 399 } },
    },
    pooled: {
      competitive: { n: 448, nSplits: 443, nRoxzone: 431, medians: { total: 3132, run_total: 1657, work_total: 1249, roxzone: 221, ski_erg: 208, sled_push: 102, sled_pull: 166, burpee_broad_jumps: 114, row_erg: 222, farmer_carry: 79, sandbag_lunges: 141, wall_balls: 210 } },
      advanced: { n: 10880, nSplits: 10769, nRoxzone: 10535, medians: { total: 3701, run_total: 1936, work_total: 1463, roxzone: 274, ski_erg: 224, sled_push: 122, sled_pull: 210, burpee_broad_jumps: 143, row_erg: 245, farmer_carry: 93, sandbag_lunges: 182, wall_balls: 228 } },
      intermediate: { n: 21569, nSplits: 21352, nRoxzone: 20889, medians: { total: 4410, run_total: 2344, work_total: 1693, roxzone: 352, ski_erg: 244, sled_push: 141, sled_pull: 254, burpee_broad_jumps: 180, row_erg: 269, farmer_carry: 106, sandbag_lunges: 225, wall_balls: 252 } },
      novice: { n: 8694, nSplits: 8576, nRoxzone: 8389, medians: { total: 5289, run_total: 2841, work_total: 1983, roxzone: 469, ski_erg: 269, sled_push: 165, sled_pull: 304, burpee_broad_jumps: 226, row_erg: 296, farmer_carry: 120, sandbag_lunges: 275, wall_balls: 297 } },
      beginner: { n: 3172, nSplits: 3082, nRoxzone: 2993, medians: { total: 6481, run_total: 3516, work_total: 2391, roxzone: 626, ski_erg: 290, sled_push: 198, sled_pull: 372, burpee_broad_jumps: 289, row_erg: 324, farmer_carry: 136, sandbag_lunges: 343, wall_balls: 397 } },
    },
  },
};
/** Band seed cells withheld for fewer than HYROX_S79_MIN_CELL_N split rows. */
export const HYROX_S89_BAND_SEEDS_SUPPRESSED: ReadonlyArray<{ format: HyroxResultsFormat; sex: HyroxBandCellSex; band: HyroxTimeBand; n: number; nSplits: number; nRoxzone: number }> = [
];

/** Repeat-athlete ingest report. authorRelMedianPct is the median change using the
 *  dataset's own *_rel columns, for comparison only: their venue-typical time is
 *  constant per event but drifts against the recomputed event median from season
 *  to season, so it is not used. */
export const HYROX_S79_IMPROVEMENT_REPORT = {
  inputRows: 77913,
  monthsBetweenNonEmpty: 0,
  dropped: { eventCellBelowMinN: 2556, totalOutsideFence: 25 },
  used: 75332,
  authorRelMedianPct: -2.3,
  byGap: { '1': 39169, '2': 23573, '3': 10656, '4': 1934 },
} as const;
