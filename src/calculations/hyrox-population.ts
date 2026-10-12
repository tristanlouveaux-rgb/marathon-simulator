/**
 * HYROX population percentiles.
 *
 * Two kinds, kept apart in copy:
 *  - Finish-time percentiles (getFinishTimePercentile) read the real results
 *    tables (hyrox-population-distributions.ts, S4 to S6, men and women
 *    pooled) and fall back to the synthetic tables below only for formats with
 *    no ingested rows (pro_doubles).
 *  - Station percentiles (getStationPercentile) are SYNTHETIC: the results
 *    data has no per-station splits, so each station is placed on the
 *    ability-band seed times mapped to hand-picked percentiles. Never caption
 *    them as results data (STATION_PERCENTILE_CAVEAT).
 *
 * Science log: docs/SCIENCE_LOG.md §HYROX Population Percentiles.
 */

import { STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import type { HyroxStation } from '@/types/triathlon';
import { doublesRatioAtTeamTime } from './hyrox-doubles';
import {
  POPULATION_DATA_AVAILABLE,
  HYROX_TOTAL_PERCENTILE_TABLES,
  HYROX_FORMAT_FINISHER_COUNTS,
  HYROX_POPULATION_SEASONS_LABEL,
  HYROX_POPULATION_ERA_NOTE,
  HYROX_DOUBLES_POOLING_NOTE,
  lookupRealPercentile,
} from '@/data/hyrox-population-distributions';

export type HyroxFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

/**
 * Percentile breakpoints for Open division (gender-mixed).
 * Each entry: [finishTimeSec, cumulativePercentile].
 * Percentile = "slower than X% of finishers" (cumulative from fastest).
 */
const OPEN_PERCENTILE_TABLE: Array<[number, number]> = [
  [45 * 60,   0],   // WR territory
  [60 * 60,   5],   // sub-1h threshold (competitive band)
  [80 * 60,  15],   // advanced band
  [100 * 60, 35],   // intermediate band
  [120 * 60, 60],   // novice band
  [150 * 60, 80],
  [180 * 60, 90],
  [240 * 60, 98],
  [360 * 60, 100],
];

/**
 * Pro division is faster. The field is self-selected to faster athletes.
 * Scale roughly: Pro men ~15% faster than Open; women ~12% faster.
 */
const PRO_PERCENTILE_TABLE: Array<[number, number]> = [
  [40 * 60,   0],
  [52 * 60,   5],
  [65 * 60,  15],
  [78 * 60,  35],
  [95 * 60,  60],
  [120 * 60, 80],
  [150 * 60, 90],
  [210 * 60, 98],
  [300 * 60, 100],
];

/** Linear interpolation between known percentile points. */
function interpolatePercentile(table: Array<[number, number]>, timeSec: number): number {
  if (timeSec <= table[0][0]) return 0;
  if (timeSec >= table[table.length - 1][0]) return 100;

  for (let i = 1; i < table.length; i++) {
    const [t0, p0] = table[i - 1];
    const [t1, p1] = table[i];
    if (timeSec <= t1) {
      const frac = (timeSec - t0) / (t1 - t0);
      return Math.round(p0 + frac * (p1 - p0));
    }
  }
  return 100;
}

/**
 * Returns "faster than X%" for a given finish time and format.
 * Result: 0–100 (higher = faster relative to population).
 */
export function getFinishTimePercentile(timeSec: number, format: HyroxFormat): number {
  // Prefer real Kaggle-derived distribution when available for the given format.
  // Falls back to the older 7-point synthetic table for any format whose real
  // distribution is empty (e.g. pro_doubles, which has no rows in the source dataset).
  if (POPULATION_DATA_AVAILABLE) {
    const realCum = lookupRealPercentile(HYROX_TOTAL_PERCENTILE_TABLES, format, timeSec);
    if (realCum != null) return Math.max(0, Math.min(100, 100 - realCum));
  }
  const table = (format === 'pro_singles' || format === 'pro_doubles') ? PRO_PERCENTILE_TABLE : OPEN_PERCENTILE_TABLE;
  // The synthetic tables are singles finish times. A doubles total is the
  // pair's time (faster), so convert it to singles terms with the
  // percentile-matched total ratio from the Open results before the lookup;
  // otherwise a Pro Doubles pair reads as far up the Pro singles field.
  const isDoubles = format === 'open_doubles' || format === 'pro_doubles';
  const lookupSec = isDoubles ? timeSec / doublesRatioAtTeamTime('total', timeSec).ratio : timeSec;
  // cumulativePercentile = % of finishers at or faster than this time
  // "faster than X%" = 100 - cumulativePercentile
  const pctAtOrFaster = interpolatePercentile(table, lookupSec);
  return Math.round(100 - pctAtOrFaster);
}

/** Format name for captions. */
export function hyroxFormatLabel(format: HyroxFormat): string {
  switch (format) {
    case 'open_singles': return 'Open Singles';
    case 'pro_singles':  return 'Pro Singles';
    case 'open_doubles': return 'Open Doubles';
    case 'pro_doubles':  return 'Pro Doubles';
  }
}

/**
 * Canonical provenance caption for any surface that places a finish (or a
 * split total) against the HYROX results data: the format's finisher count,
 * the seasons with years, that women and men are pooled, the 75-rep Women
 * Open era caveat, and for doubles the pooling caveat. Formats with no
 * ingested rows (Pro Doubles) get a synthetic-scale caption instead.
 */
export function hyroxPopulationCaption(format: HyroxFormat): string {
  const n = HYROX_FORMAT_FINISHER_COUNTS[format] ?? 0;
  if (!POPULATION_DATA_AVAILABLE || n === 0) {
    return `The results data has no ${hyroxFormatLabel(format)} rows. This placement uses a synthetic scale, after converting the pair's time to singles terms. Approximate.`;
  }
  const pooling = format === 'open_doubles' ? ` ${HYROX_DOUBLES_POOLING_NOTE}` : '';
  return `HYROX results: ${n.toLocaleString('en-US')} ${hyroxFormatLabel(format)} finishers, women and men together, ${HYROX_POPULATION_SEASONS_LABEL}. ${HYROX_POPULATION_ERA_NOTE}${pooling}`;
}

/** Total finisher rows across every ingested format, for captions that
 *  describe the whole dataset (sum of HYROX_FORMAT_FINISHER_COUNTS). */
export function hyroxPopulationTotalFinishers(): number {
  return Object.values(HYROX_FORMAT_FINISHER_COUNTS).reduce((a, n) => a + n, 0);
}

/**
 * Provenance for a HYROX forecast: which parts come from the results data and
 * which do not. Station times come from the athlete's benchmarks or the
 * ability-band seed times, and run legs from running fitness; the results data
 * supplies the finish percentiles and, for doubles, the doubles ratios
 * (hyrox-doubles.ts). Count, seasons and era come from hyroxPopulationCaption.
 */
export function hyroxForecastProvenanceCaption(format: HyroxFormat): string {
  const base = 'Station times use your benchmarks, or the ability-band seed times where a station is untested. Run legs follow your running fitness.';
  if (format === 'pro_doubles') {
    return `${base} The doubles station, Roxzone and run ratios come from the Open Doubles results. ${hyroxPopulationCaption('open_doubles')} ${hyroxPopulationCaption('pro_doubles')}`;
  }
  const fromData = format === 'open_doubles'
    ? 'The doubles station, Roxzone and run ratios and the finish percentiles come from the results data.'
    : 'Finish percentiles are placed on the results data.';
  return `${base} ${fromData} ${hyroxPopulationCaption(format)}`;
}

/** Methodology-page summary of the HYROX forecast's sources, across formats. */
export function hyroxMethodologyCaption(): string {
  const n = hyroxPopulationTotalFinishers().toLocaleString('en-US');
  return `Station times come from your station tests and race splits, or the ability-band seed times where a station is untested, and update from recent strength-station sessions. The HYROX results data (${n} finishers, ${HYROX_POPULATION_SEASONS_LABEL}) sets the finish percentiles and the doubles-to-singles ratios. It has no per-station splits, so station percentiles are estimates. ${HYROX_POPULATION_ERA_NOTE}`;
}

/** Human-readable label from a "faster than" percentile (0-100).
 *  Mirrors the headline precisely: "Faster than 99%" → "Top 1% globally".
 *  Falls back to descriptive text below the top-of-field range. */
export function percentileLabel(fasterThanPct: number): string {
  if (fasterThanPct >= 40) return `Top ${Math.max(1, 100 - fasterThanPct)}% globally`;
  if (fasterThanPct >= 20) return 'Mid-pack';
  if (fasterThanPct >= 5)  return 'Back of the field';
  return 'Below typical finish range';
}

/** Headline phrasing for the "your time vs population" hero line.
 *  At extremes, "faster than X%" reads weirdly. Switch to descriptive text. */
export function percentileHeadline(fasterThanPct: number): string {
  if (fasterThanPct >= 5) return `Faster than ${fasterThanPct}% of finishers`;
  return 'Below typical finishing range';
}

/**
 * Caption for any surface that shows a station percentile. Station
 * percentiles are estimates, not results data.
 */
export const STATION_PERCENTILE_CAVEAT =
  'Station percentiles are estimates placed on the ability-band seed times. The results data has no per-station splits.';

/**
 * Returns an ESTIMATED "faster than X%" for a single station. Synthetic: the
 * results data has no per-station splits, so the band seed times are the
 * anchors, at hand-picked percentiles (not derived from data):
 *   competitive = P5, advanced = P15, intermediate = P35, novice = P60,
 *   beginner = P80, total_beginner = P95
 * Output is clamped to 3..97. Seeds are singles times: pass a doubles line in
 * singles terms (stationSinglesEquivalentSec).
 *
 * Lower station time = faster = higher percentile (inverse of finish time).
 */
export function getStationPercentile(
  station: HyroxStation,
  userTimeSec: number,
): number {
  // Percentile breakpoints: [timeSec, cumulativePercentile]
  // cumulativePercentile = % of finishers at or below this time (i.e. faster than this)
  const anchors: Array<[number, number]> = [
    [STATION_SEED_TIMES_SEC.competitive[station],    5],
    [STATION_SEED_TIMES_SEC.advanced[station],      15],
    [STATION_SEED_TIMES_SEC.intermediate[station],  35],
    [STATION_SEED_TIMES_SEC.novice[station],        60],
    [STATION_SEED_TIMES_SEC.beginner[station],      80],
    [STATION_SEED_TIMES_SEC.total_beginner[station], 95],
  ];

  // Faster than X% = 100 - cumulativePercentile
  if (userTimeSec <= anchors[0][0]) return 97;
  if (userTimeSec >= anchors[anchors.length - 1][0]) return 3;

  for (let i = 1; i < anchors.length; i++) {
    const [t0, p0] = anchors[i - 1];
    const [t1, p1] = anchors[i];
    if (userTimeSec <= t1) {
      const frac = (userTimeSec - t0) / (t1 - t0);
      const pct = p0 + frac * (p1 - p0);
      return Math.round(100 - pct);
    }
  }
  return 3;
}

/** Returns 'strength' | 'average' | 'limiter' based on percentile vs Open population. */
export function stationStatus(fasterThanPct: number): 'strength' | 'average' | 'limiter' {
  if (fasterThanPct >= 55) return 'strength';
  if (fasterThanPct >= 35) return 'average';
  return 'limiter';
}
