/**
 * HYROX population percentile estimates.
 *
 * Based on HyroxDataLab 700k+ race database percentile distributions
 * and band thresholds from hyrox-benchmarks.ts. Open division, gender-mixed.
 * Values are approximate midpoints — real distributions vary by age/gender/location.
 *
 * Science log: docs/SCIENCE_LOG.md §HYROX Population Percentiles.
 */

import { STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import type { HyroxStation } from '@/types/triathlon';
import {
  POPULATION_DATA_AVAILABLE,
  HYROX_TOTAL_PERCENTILE_TABLES,
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
 * Pro division is faster — the field is self-selected to faster athletes.
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
  // cumulativePercentile = % of finishers slower-than-or-equal-to this time
  // "faster than X%" = 100 - cumulativePercentile
  const pctSlowerThanYou = interpolatePercentile(table, timeSec);
  return Math.round(100 - pctSlowerThanYou);
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
 *  At extremes, "faster than X%" reads weirdly — switch to descriptive text. */
export function percentileHeadline(fasterThanPct: number): string {
  if (fasterThanPct >= 5) return `Faster than ${fasterThanPct}% of finishers`;
  return 'Below typical finishing range';
}

/**
 * Returns "faster than X%" for a single station, relative to the Open population.
 * Uses the band seed times as percentile anchors:
 *   competitive = P5, advanced = P15, intermediate = P35, novice = P60, beginner = P80
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
