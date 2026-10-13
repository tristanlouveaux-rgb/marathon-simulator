/**
 * HYROX population percentiles and their captions.
 *
 * Every percentile here reads the real results tables through
 * hyrox-results.ts (src/data/hyrox-results-s79.ts, seasons 8 and 9, split by
 * format and sex, with per-station splits):
 *  - Finish-time percentiles (getFinishTimePercentile) place a total in the
 *    athlete's format x sex field; a doubles total is placed on the doubles
 *    table of the pair's division directly (Pro Doubles has data now).
 *  - Station percentiles (getStationPercentile) place a station time against
 *    the field's race splits at that station, in the same cohort. They are
 *    real-data percentiles; the 'est.' label and the synthetic seed anchors
 *    of lanes before H3b are gone.
 *
 * No app code reads the S4 to S6 tables (hyrox-population-distributions.ts)
 * any more. The file stays as the calibration source of the band field
 * percentiles: HYROX_TIME_TO_BAND_THRESHOLDS was most likely set against its
 * pooled open singles total table, and a data test pins
 * HYROX_S89_BAND_FIELD_PERCENTILES to it.
 *
 * Science log: docs/SCIENCE_LOG.md §HYROX Population Percentiles and the
 * lane H3b entry.
 */

import type { HyroxStation } from '@/types/triathlon';
import {
  HYROX_S89_POOLED_FINISHER_COUNTS,
  HYROX_S89_SEASONS_LABEL,
  HYROX_RESULTS_VIA,
} from '@/data/hyrox-results-s79';
import {
  hyroxFasterThanPct,
  hyroxStationPercentile,
  hyroxResultsCaption,
  hyroxFormatName,
  type HyroxResultsCohort,
} from './hyrox-results';

export type HyroxFormat = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

function pooledCohort(format: HyroxFormat): HyroxResultsCohort {
  return { format, sex: 'pooled' };
}

/**
 * Returns "faster than X%" for a finish time (the format's own terms: the
 * pair's time for doubles) in a cohort's field, 0 to 100, higher = faster.
 * No cohort: the format's pooled table (women and men together).
 */
export function getFinishTimePercentile(
  timeSec: number,
  format: HyroxFormat,
  cohort?: HyroxResultsCohort,
): number {
  const c = cohort && cohort.format === format ? cohort : pooledCohort(format);
  return hyroxFasterThanPct('total', timeSec, c)
    ?? hyroxFasterThanPct('total', timeSec, pooledCohort(format))
    ?? 0;
}

/** Format name for captions. */
export function hyroxFormatLabel(format: HyroxFormat): string {
  return hyroxFormatName(format);
}

/**
 * Canonical provenance caption for any surface that places a finish (or a
 * split) against the HYROX results data: seasons with years, the cohort's
 * finisher count and the source (hyroxResultsCaption). No cohort: the
 * format's pooled table.
 */
export function hyroxPopulationCaption(format: HyroxFormat, cohort?: HyroxResultsCohort): string {
  return hyroxResultsCaption(cohort && cohort.format === format ? cohort : pooledCohort(format));
}

/** Total finishers behind the current-judging tables, every format (sum of
 *  the pooled S8-S9 total counts). */
export function hyroxPopulationTotalFinishers(): number {
  return Object.values(HYROX_S89_POOLED_FINISHER_COUNTS).reduce((a, c) => a + (c?.total ?? 0), 0);
}

/**
 * Provenance for a HYROX forecast: which parts come from the results data and
 * which from the athlete. Station times come from the athlete's benchmarks or
 * the band seed times (real band medians); run legs follow running fitness.
 */
export function hyroxForecastProvenanceCaption(format: HyroxFormat, cohort?: HyroxResultsCohort): string {
  const base = 'Station times use your benchmarks, or the median split of your ability band in the results where a station is untested. Run legs follow your running fitness.';
  const parts: string[] = [base];
  if (format === 'open_doubles' || format === 'pro_doubles') {
    parts.push("Each station, Roxzone and the run convert to the pair's time with ratios from the doubles results.");
  }
  if (format === 'pro_singles' || format === 'pro_doubles') {
    parts.push('Times set at Open weights convert to Pro weights per station, from the Pro and Open results.');
  }
  parts.push(hyroxPopulationCaption(format, cohort));
  return parts.join(' ');
}

/** Methodology-page summary of the HYROX forecast's sources, across formats. */
export function hyroxMethodologyCaption(): string {
  const n = hyroxPopulationTotalFinishers().toLocaleString('en-US');
  return `Station times come from your station tests and race splits, or the median split of your ability band where a station is untested, and update from recent strength-station sessions. The HYROX results, ${HYROX_S89_SEASONS_LABEL}, ${n} finishers ${HYROX_RESULTS_VIA}, set the band seed times, the finish and station percentiles by format and sex, and the doubles and Pro conversions.`;
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
 * Caption for a surface that shows station percentiles: what they compare.
 * Kept under its old name; the percentiles are real race splits now.
 */
export const STATION_PERCENTILE_CAVEAT =
  "Station percentiles compare your station time with the field's race splits at that station.";

/**
 * "Faster than X%" for one station time against the field's race splits at
 * that station (hyroxStationPercentile), 0 to 100. Pass the time in the
 * cohort's own terms: the pair's time for a doubles cohort, one athlete's
 * time at the cohort's weights for singles. No cohort: Open Singles, women
 * and men pooled.
 *
 * Lower station time = faster = higher percentile.
 */
export function getStationPercentile(
  station: HyroxStation,
  userTimeSec: number,
  cohort: HyroxResultsCohort = pooledCohort('open_singles'),
): number {
  return hyroxStationPercentile(station, userTimeSec, cohort)
    ?? hyroxStationPercentile(station, userTimeSec, pooledCohort(cohort.format))
    ?? 0;
}

/** Returns 'strength' | 'average' | 'limiter' from a station percentile. */
export function stationStatus(fasterThanPct: number): 'strength' | 'average' | 'limiter' {
  if (fasterThanPct >= 55) return 'strength';
  if (fasterThanPct >= 35) return 'average';
  return 'limiter';
}
