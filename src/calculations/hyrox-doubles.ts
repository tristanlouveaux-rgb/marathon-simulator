/**
 * HYROX Doubles forecast ratios. Side: tracking (race-time prediction).
 *
 * Rules (HYROX 26/27 Doubles rulebook): both partners run all 8 x 1 km
 * together and the finish is the later chip (s4.3, s7.3), they enter and leave
 * every station together through all 8 transitions (s7.3), and they take turns
 * inside every station with no minimum share (s7.2). Nobody skips a station.
 *
 * Model: quantile mapping on the real results (src/data/hyrox-results-s79.ts,
 * seasons 8 and 9, read through hyrox-results.ts). For a metric (one station,
 * the 8-station work total, Roxzone, run total, finish total), find the
 * athlete's cumulative percentile p of their singles time in the singles
 * table, then
 *
 *     ratio(p) = doubles(p) / singles(p)
 *
 * with both tables linearly interpolated in p. The pair's time for that metric
 * = singles time x ratio(p). Outside the table the end ratio holds. Every
 * ratio is read from the tables; none is hard-coded.
 *
 * Which tables (HyroxDoublesTables, hyroxDoublesTables):
 *  - doubles side: the pair's division (women, men, mixed) in the target's
 *    weight family (Open Doubles or Pro Doubles, which now has data);
 *  - singles side: the athlete's own sex in the matching singles format
 *    (Open or Pro Singles). A pair at percentile p is taken to be two
 *    athletes near p in their own fields (assortative pairing).
 *  - unknown sex or division: the format's pooled tables. No cohort passed:
 *    Open Doubles against Open Singles, both pooled (HYROX_DEFAULT_DOUBLES_TABLES).
 *
 * Station times are mapped per station (H1 used one aggregate station ratio
 * from the 8-station total of the S4 to S6 tables, which had no splits). At
 * the median the ratios run from about 0.92 (SkiErg, row: one machine, the
 * pair alternates) to about 0.6 (sleds, burpee broad jumps, wall balls).
 *
 * Mixed Doubles woman: the pair races M-Open loads, the Women Pro tier, while
 * her singles field is Open Singles women (W-Open loads). Her solo station
 * times are at M-Open, so the station mappings convert them Pro to Open
 * (hyroxSoloToFieldSec) before reading the women's singles table and back
 * after (HyroxDoublesTables.soloProLoadsInOpenField, set by hyroxDoublesTables
 * from hyroxSoloFrame). Before this (review 2026-10-13) her M-Open tests were
 * placed on the W-Open table, so a test at her prescribed load made the
 * forecast slower.
 *
 * Limitations:
 *  - Cohort comparison, not the same athletes racing both formats.
 *  - The Mixed woman's Pro-to-Open step uses the Open-to-Pro conversion (a
 *    difference in differences, hyrox-results.ts), itself a cohort comparison.
 *  - Venue variation and the S8 judging step are inherited from the tables.
 */

import type { AbilityBand, HyroxConfig, HyroxDivision, HyroxStation } from '@/types/triathlon';
import type { HyroxResultsMetric } from '@/data/hyrox-results-s79';
import { seedRoxzoneSecFor } from '@/constants/hyrox-benchmarks';
import { isHyroxDoublesFormat } from './hyrox-division';
import { benchmarkEntryForSlotValue, isRaceSplitSource } from './hyrox-station-history';
import {
  cumulativePercentileIn,
  secondsAtPercentileIn,
  hyroxResultsTable,
  hyroxResultsCohort,
  hyroxSoloFrame,
  hyroxSoloToFieldSec,
  hyroxFieldToSoloSec,
  hyroxDoublesFormatOf,
  type HyroxResultsCohort,
} from './hyrox-results';

type HyroxFormat = HyroxConfig['format'];
type Breakpoints = ReadonlyArray<readonly [number, number]>;
type BiologicalSex = 'male' | 'female' | 'prefer_not_to_say' | null | undefined;

/** 'stations' is the 8-station work total, 'run' the run total. A station key
 *  maps that station alone. */
export type DoublesMetric = 'stations' | 'roxzone' | 'run' | 'total' | HyroxStation;

function resultsMetric(metric: DoublesMetric): HyroxResultsMetric {
  if (metric === 'stations') return 'work_total';
  if (metric === 'run') return 'run_total';
  return metric;
}

/** The singles and doubles cohorts a doubles mapping reads. */
export interface HyroxDoublesTables {
  singles: HyroxResultsCohort;
  doubles: HyroxResultsCohort;
  /** The athlete's solo times are at the Pro tier of their sex while
   *  `singles` is the Open field (a woman in Mixed Doubles: M-Open loads, the
   *  Women Pro tier). The station mappings (doublesStationTeamSec,
   *  doublesStationSoloSec) take and return solo times at those loads and
   *  convert to the field's terms internally (hyroxSoloToFieldSec). Absent:
   *  solo times are already in the singles field's terms. */
  soloProLoadsInOpenField?: boolean;
}

/** Open Doubles against Open Singles, both pooled: the mapping for callers
 *  that pass no cohort. */
export const HYROX_DEFAULT_DOUBLES_TABLES: HyroxDoublesTables = {
  singles: { format: 'open_singles', sex: 'pooled' },
  doubles: { format: 'open_doubles', sex: 'pooled' },
};

/** The doubles mapping for an athlete: the pair's division in the target's
 *  weight family against the athlete's own sex in the matching singles format
 *  (hyroxSoloFrame), flagged when the athlete's solo loads are the Pro tier of
 *  that Open field (a woman in Mixed Doubles). */
export function hyroxDoublesTables(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): HyroxDoublesTables {
  const frame = hyroxSoloFrame(format, biologicalSex, division);
  return {
    singles: frame.field,
    doubles: hyroxResultsCohort(hyroxDoublesFormatOf(format), biologicalSex, division),
    ...(frame.proLoadsInOpenField ? { soloProLoadsInOpenField: true } : {}),
  };
}

/** The solo frame part of a tables object, for hyroxSoloToFieldSec. */
function soloFrameOf(tables: HyroxDoublesTables) {
  return { field: tables.singles, proLoadsInOpenField: !!tables.soloProLoadsInOpenField };
}

/** hyroxDoublesTables for the current state. */
export function hyroxDoublesTablesForState(state: {
  biologicalSex?: BiologicalSex;
  hyroxConfig?: Pick<HyroxConfig, 'format' | 'division'> | null;
}): HyroxDoublesTables {
  return hyroxDoublesTables(state.hyroxConfig?.format ?? 'open_doubles', state.biologicalSex, state.hyroxConfig?.division);
}

function tablesFor(metric: DoublesMetric, tables: HyroxDoublesTables): { singles: Breakpoints; doubles: Breakpoints } {
  const m = resultsMetric(metric);
  const singles = hyroxResultsTable(m, tables.singles) ?? hyroxResultsTable(m, HYROX_DEFAULT_DOUBLES_TABLES.singles)!;
  const doubles = hyroxResultsTable(m, tables.doubles) ?? hyroxResultsTable(m, HYROX_DEFAULT_DOUBLES_TABLES.doubles)!;
  return { singles, doubles };
}

/** Unrounded cumulative percentile of `sec` in a breakpoint table, clamped to
 *  the table's end percentiles. */
export function cumulativePercentileAt(table: Breakpoints, sec: number): number {
  return cumulativePercentileIn(table, sec);
}

/** Seconds at cumulative percentile `pct` in a breakpoint table, clamped to the
 *  table's end points. */
export function secondsAtCumulativePercentile(table: Breakpoints, pct: number): number {
  return secondsAtPercentileIn(table, pct);
}

export interface DoublesRatio {
  /** Team time ÷ singles time at the athlete's percentile. */
  ratio: number;
  /** The cumulative percentile the ratio was read at (1 = fastest): in the
   *  singles table for doublesRatioAt, in the doubles table for
   *  doublesRatioAtTeamTime. */
  singlesPercentile: number;
}

/** Percentile-matched doubles/singles ratio for a metric, read at the
 *  athlete's singles time. */
export function doublesRatioAt(
  metric: DoublesMetric,
  singlesSec: number,
  tables: HyroxDoublesTables = HYROX_DEFAULT_DOUBLES_TABLES,
): DoublesRatio {
  const t = tablesFor(metric, tables);
  const p = cumulativePercentileIn(t.singles, singlesSec);
  const ratio = secondsAtPercentileIn(t.doubles, p) / secondsAtPercentileIn(t.singles, p);
  return { ratio, singlesPercentile: p };
}

/** The same ratio read from the doubles side: the pair's time's percentile in
 *  the doubles table. For converting a pair's time to singles terms
 *  (singles = team ÷ ratio). */
export function doublesRatioAtTeamTime(
  metric: DoublesMetric,
  teamSec: number,
  tables: HyroxDoublesTables = HYROX_DEFAULT_DOUBLES_TABLES,
): DoublesRatio {
  const t = tablesFor(metric, tables);
  const p = cumulativePercentileIn(t.doubles, teamSec);
  const ratio = secondsAtPercentileIn(t.doubles, p) / secondsAtPercentileIn(t.singles, p);
  return { ratio, singlesPercentile: p };
}

/** One athlete's station time (at their solo loads in this pair) as the
 *  pair's time at that station: the solo time in the singles field's terms
 *  (hyroxSoloToFieldSec, identity unless soloProLoadsInOpenField), mapped at
 *  its percentile. */
export function doublesStationTeamSec(station: HyroxStation, singlesSec: number, tables: HyroxDoublesTables = HYROX_DEFAULT_DOUBLES_TABLES): number {
  const fieldSec = hyroxSoloToFieldSec(station, singlesSec, soloFrameOf(tables));
  return fieldSec * doublesRatioAt(station, fieldSec, tables).ratio;
}

/** A pair's station time (a doubles race split) as one athlete's time at
 *  their solo loads in this pair: the singles time at the same percentile,
 *  back at the solo loads (hyroxFieldToSoloSec). The inverse of
 *  doublesStationTeamSec inside the tables. */
export function doublesStationSoloSec(station: HyroxStation, teamSec: number, tables: HyroxDoublesTables = HYROX_DEFAULT_DOUBLES_TABLES): number {
  const fieldSec = teamSec / doublesRatioAtTeamTime(station, teamSec, tables).ratio;
  return hyroxFieldToSoloSec(station, fieldSec, soloFrameOf(tables));
}

/**
 * A doubles finish time (the pair's total) in singles terms: the singles total
 * at the same cumulative percentile. Inside the tables this is the exact
 * inverse of singles × doublesRatioAt('total').
 *
 * Kept for hyroxBandingTimeSec (the onboarding initializer's banding until
 * lane H2 moves it to hyroxPlanningBandFor, hyrox-planning-band.ts).
 * Placements no longer convert: a doubles total is placed on the doubles
 * table directly.
 */
export function doublesTotalInSinglesTermsSec(
  teamSec: number,
  tables: HyroxDoublesTables = HYROX_DEFAULT_DOUBLES_TABLES,
): number {
  return teamSec / doublesRatioAtTeamTime('total', teamSec, tables).ratio;
}

/**
 * Aggregate team station ratio over the 8-station work total, refined once
 * for stations whose time is already a team time. Kept for callers of the H1
 * API; the forecast maps each station on its own (doublesStationTeamSec,
 * doublesStationSoloSec).
 */
export function doublesStationRatio(
  soloSec: number[],
  teamSec: number[],
  teamSeedSoloSec: number[],
  tables: HyroxDoublesTables = HYROX_DEFAULT_DOUBLES_TABLES,
): DoublesRatio {
  const soloSum = soloSec.reduce((a, b) => a + b, 0);
  const first = doublesRatioAt('stations', soloSum + teamSeedSoloSec.reduce((a, b) => a + b, 0), tables);
  if (teamSec.length === 0) return first;
  return doublesRatioAt('stations', soloSum + teamSec.reduce((a, b) => a + b / first.ratio, 0), tables);
}

/** Seed Roxzone (seconds) for a band in a format: the band's median Roxzone
 *  in the planning field, Open Singles at the athlete's sex (`tables.singles`
 *  sex when given, else pooled), the field the planning band is read in
 *  (hyroxPlanningBandFor; Roxzone carries no load, so a Pro race needs no
 *  conversion); for doubles, the seed × the percentile-matched Roxzone ratio
 *  (partners pass through all 8 transitions together, so Roxzone is not
 *  halved). */
export function seedRoxzoneSecForFormat(
  band: AbilityBand,
  format: HyroxFormat,
  tables?: HyroxDoublesTables,
): number {
  const singles = tables?.singles;
  const seedSex = singles && singles.sex !== 'mixed' ? singles.sex : 'pooled';
  const seed = seedRoxzoneSecFor(band, 'open_singles', seedSex);
  if (!isHyroxDoublesFormat(format) || seed <= 0) return seed;
  return Math.round(seed * doublesRatioAt('roxzone', seed, tables ?? HYROX_DEFAULT_DOUBLES_TABLES).ratio);
}

/**
 * True when the doubles benchmark slot's value for a station is the pair's
 * time (a split from a doubles race), false when it is one athlete's solo time
 * (a half or full test, or a session best). Reads the history entry that
 * describes the slot value (benchmarkEntryForSlotValue): a race split ('race',
 * or 'manual', the boot migration's label for the onboarding seed) is a team
 * time, a test or session best is solo. No matching entry: the value came from
 * a race-split path that kept no history before 2026-10-12, so a team time.
 */
export function doublesBenchmarkIsTeamTime(
  hx: Pick<HyroxConfig, 'stationBenchmarkHistory'>,
  station: HyroxStation,
  slotSec: number,
): boolean {
  const entry = benchmarkEntryForSlotValue(hx, station, 'doubles', slotSec);
  return entry ? isRaceSplitSource(entry.source) : true;
}

/**
 * A previous HYROX finish time in singles terms, for the global band scale
 * (HYROX_TIME_TO_BAND_THRESHOLDS). A doubles time → doublesTotalInSinglesTermsSec;
 * a singles time as is.
 *
 * Superseded by hyroxPlanningBandFor (hyrox-planning-band.ts), which
 * converts the time to Open Singles terms of the athlete's sex (per station
 * for doubles, Open/Pro per loaded station) and bands it on that field.
 * Kept for the onboarding initializer (src/state/initialization.hyrox.ts,
 * lane H2), which still bands on the global scale until H2 switches it over.
 */
export function hyroxBandingTimeSec(prevTimeSec: number, prevFormat: HyroxFormat): number {
  if (!isHyroxDoublesFormat(prevFormat)) return prevTimeSec;
  return Math.round(doublesTotalInSinglesTermsSec(prevTimeSec));
}
