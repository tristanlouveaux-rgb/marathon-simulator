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
 * any more. The file stays as the calibration field of the band field
 * percentiles: HYROX_TIME_TO_BAND_THRESHOLDS (60, 80, 100, 120 min) is read
 * as positions in its pooled open singles total table (p1.0, p25.3, p73.5,
 * p92.9), and a data test pins HYROX_S89_BAND_FIELD_PERCENTILES to it. The
 * only recorded anchor for those thresholds is the HyroxDataLab list in
 * SCIENCE_LOG "HYROX Population Percentiles (2026-05-06)" (60, 80, 100,
 * 120 min at p5, p15, p35, p60, gender-mixed Open). It was rejected: those
 * anchors were hand-set and contradict the real results (60 min sits below
 * p1 of the S4 to S6 field, not p5), and reading the thresholds at them would
 * push most athletes down a band.
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
  hyroxCohortNoun,
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

/**
 * The friendly tier label for a "faster than" percentile (0 to 100), as
 * UX_PATTERNS "Tier label translation" sets it: "top 1%", "top 27%",
 * "median", "bottom 30%". The one label every HYROX percentile chip reads (the
 * distributions card rows, the forecast station rows, the biggest-targets
 * rows, the station detail hero), so a "pNN" never means "faster than NN%" on
 * one row and a cumulative time percentile on the next (review 2026-10-13:
 * the station chips read "p73" next to the distributions card's p25/p50/p75
 * time guides).
 *
 * Replaces percentileLabel ("Top X% globally") and percentileHeadline, which
 * nothing read after lane H3b.
 */
export function hyroxTierLabel(fasterThanPct: number): string {
  const f = Math.max(0, Math.min(100, Math.round(fasterThanPct)));
  if (f >= 99) return 'top 1%';
  if (f >= 95) return 'top 5%';
  if (f >= 90) return 'top 10%';
  if (f >= 55) return `top ${100 - f}%`;
  if (f >= 45) return 'median';
  if (f >= 10) return `bottom ${f}%`;
  if (f >= 5)  return 'bottom 10%';
  return 'bottom 5%';
}

/**
 * The tier label with its cohort named: "top 14% of women", "bottom 30% of
 * mixed pairs", "median among men's pairs" (hyroxCohortNoun). For a row whose
 * percentile can be read against another surface's: the forecast "Where you
 * sit" total row, next to the Stats rank line's age-group placement (lane
 * H3c: the same finish read "top 14%" there and "Faster than 83% of women
 * aged 30 to 34" on Stats, with no cohort on the row).
 */
export function hyroxTierLabelIn(fasterThanPct: number, cohort: HyroxResultsCohort): string {
  const tier = hyroxTierLabel(fasterThanPct);
  const noun = hyroxCohortNoun(cohort);
  return tier === 'median' ? `median among ${noun}` : `${tier} of ${noun}`;
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
