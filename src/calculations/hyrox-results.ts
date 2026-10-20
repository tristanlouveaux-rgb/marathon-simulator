/**
 * HYROX results lookups. The one reader of the real results tables
 * (src/data/hyrox-results-s79.ts, seasons 7 to 9) for every surface that
 * places a time against the field: finish and station percentiles, the
 * distributions card, the radar, the station detail page, the guided-session
 * summary, the Stats rank line, band thresholds, the Open-to-Pro station
 * conversion and the improvement ceiling. Two numbers that mean the same thing
 * come from the same call here.
 *
 * Side of the line: tracking (descriptive population tables). The band
 * thresholds and seeds also feed planning inputs (the band sets MTL caps and
 * sessions), always in the planning field (hyroxPlanningField, Open Singles at
 * the athlete's sex; the planning band itself is hyrox-planning-band.ts); the
 * seed tables live in src/constants/hyrox-benchmarks.ts.
 *
 * Which table set (orchestrator decision, lane H3b):
 *  - Seasons 8 and 9 (HYROX_S89_*) for station percentiles, placements,
 *    station targets, seeds, band thresholds and conversions: the field as
 *    judged now (wall balls and sled push step up at the S7 to S8 boundary).
 *  - Pooled seasons 7 to 9 for age-group tables, where sample size matters.
 *  - pro_doubles 'mixed' rows are data errors (the rulebook has no Pro Mixed
 *    doubles); that cell is suppressed in the data and never selected here.
 *
 * Cohort (whose results a time is placed against):
 *  - Singles: the athlete's own sex (biologicalSex), else a single-sex
 *    division pick, else the format's pooled table (women and men together).
 *  - Doubles: the doubles division (HyroxConfig.division: women, men, mixed;
 *    resolveHyroxDivision falls back to biological sex), else the pooled
 *    doubles table. Mixed under a Pro format resolves away (no Pro Mixed).
 *
 * Conventions: tables are `[seconds, cumulativePercentile]`, the share of
 * finishers at or under the time (empirical CDF). "Faster than X%" is
 * 100 minus the cumulative percentile. Lookups interpolate linearly between
 * breakpoints and clamp to the table's end percentiles.
 *
 * Science log: docs/SCIENCE_LOG.md, HYROX results wiring (lane H3b).
 */

import type { AbilityBand, HyroxConfig, HyroxDivision, HyroxStation } from '@/types/triathlon';
import {
  HYROX_S89_PERCENTILES,
  HYROX_S89_FINISHER_COUNTS,
  HYROX_S89_POOLED_PERCENTILES,
  HYROX_S89_POOLED_FINISHER_COUNTS,
  HYROX_S89_BAND_THRESHOLDS_SEC,
  HYROX_S89_SEASONS_LABEL,
  HYROX_S79_SEASONS_LABEL,
  HYROX_RESULTS_VIA,
  HYROX_S79_AGE_GROUPS,
  HYROX_S79_AGE_TOTAL_PERCENTILES,
  HYROX_S79_AGE_TOTAL_COUNTS,
  HYROX_S79_IMPROVEMENT,
  HYROX_S79_IMPROVEMENT_BAND_THRESHOLDS,
  HYROX_S79_STATION_LOWER_FENCES_SEC,
  HYROX_S89_BAND_SEEDS,
  HYROX_S79_RUN_LEG_MEDIANS_SEC,
  type HyroxImprovementCell,
  type HyroxPercentileTable,
  type HyroxResultsMetric,
  type HyroxResultsSex,
  type HyroxBandCellSex,
} from '@/data/hyrox-results-s79';
import { HYROX_PRO_STATION_MULTIPLIER } from '@/constants/hyrox-constants';
import {
  stationSeedTimesFor,
  seedRunPaceSecKmFor,
  seedRoxzoneSecFor,
  HYROX_STATION_ORDER,
  type HyroxSeedFormat,
} from '@/constants/hyrox-benchmarks';
import {
  isHyroxDoublesFormat,
  isHyroxProFormat,
  hyroxLoadTier,
  resolveHyroxAthleteSex,
  resolveHyroxDivision,
} from './hyrox-division';

export type HyroxFormat = HyroxConfig['format'];
export type HyroxCohortSex = HyroxResultsSex | 'pooled';
type BiologicalSex = 'male' | 'female' | 'prefer_not_to_say' | null | undefined;

/** Whose results a time is placed against: a format and a sex cell
 *  ('pooled' = the format's published sex cells together). */
export interface HyroxResultsCohort {
  format: HyroxFormat;
  sex: HyroxCohortSex;
}

// ─── Cohort resolution ──────────────────────────────────────────────────────

export function hyroxSinglesFormatOf(format: HyroxFormat): 'open_singles' | 'pro_singles' {
  return format === 'pro_singles' || format === 'pro_doubles' ? 'pro_singles' : 'open_singles';
}

export function hyroxDoublesFormatOf(format: HyroxFormat): 'open_doubles' | 'pro_doubles' {
  return format === 'pro_singles' || format === 'pro_doubles' ? 'pro_doubles' : 'open_doubles';
}

function publishedOrPooled(format: HyroxFormat, sex: HyroxCohortSex): HyroxResultsCohort {
  if (sex !== 'pooled' && !HYROX_S89_PERCENTILES[format][sex]) return { format, sex: 'pooled' };
  return { format, sex };
}

/**
 * The results cohort for a format: singles by the athlete's own sex, doubles
 * by the doubles division; pooled when unknown (see the module header).
 */
export function hyroxResultsCohort(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): HyroxResultsCohort {
  if (isHyroxDoublesFormat(format)) {
    const d = resolveHyroxDivision(format, biologicalSex, division);
    const sex: HyroxCohortSex = d === 'women' ? 'female' : d === 'men' ? 'male' : d === 'mixed' ? 'mixed' : 'pooled';
    return publishedOrPooled(format, sex);
  }
  return publishedOrPooled(format, resolveHyroxAthleteSex(biologicalSex, division) ?? 'pooled');
}

/** The singles cohort of the athlete's own sex in the target's weight family
 *  (Open or Pro). The reference for one athlete's solo times: seeds, station
 *  tests, session rounds, and the singles side of the doubles mapping. A
 *  Mixed Doubles athlete with no biological sex on file gets the pooled table. */
export function hyroxSinglesCohort(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): HyroxResultsCohort {
  return publishedOrPooled(hyroxSinglesFormatOf(format), resolveHyroxAthleteSex(biologicalSex, division) ?? 'pooled');
}

// ─── Solo load family ───────────────────────────────────────────────────────

/**
 * True when one athlete's solo work at the target's loads is the Pro tier of
 * their own sex (Women Pro races M-Open, Men Pro races M-Pro), read from the
 * canonical load tier (hyroxLoadTier, rulebook s4.1):
 *  - every Pro format;
 *  - a woman in Mixed Doubles: the pair races M-Open loads for both partners
 *    and the woman throws to 2.70 m, exactly the Women Pro standard.
 * A man in Mixed Doubles races M-Open, the Men Open tier. Unknown sex: the
 * format's own family (a Mixed pair with no sex on file stays Open).
 */
export function hyroxSoloLoadsArePro(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): boolean {
  const sex = resolveHyroxAthleteSex(biologicalSex, division);
  if (sex == null) return isHyroxProFormat(format);
  const tier = hyroxLoadTier(format, biologicalSex, division);
  return sex === 'female' ? tier !== 'W-Open' : tier === 'M-Pro';
}

/**
 * The athlete's solo frame: the singles field that places their ability
 * (hyroxSinglesCohort: own sex, the target's weight family) and the load
 * family of their solo work at the target's loads. The two differ only for a
 * woman in Mixed Doubles: her field is Open Singles women (W-Open loads) while
 * her solo work is at M-Open loads (the Women Pro tier). Station times then
 * convert Pro to Open (hyroxProToOpenSec, women) before they are placed in the
 * field, and back after (hyroxSoloToFieldSec / hyroxFieldToSoloSec). Every
 * surface that places a solo time in the field, or maps it to the pair's time,
 * reads this frame: the forecast and the planning benchmarks (through
 * hyroxDoublesTables), the seeds (hyroxStationSeedsAtTarget) and the
 * guided-session summary.
 */
export interface HyroxSoloFrame {
  /** The singles cohort that places the athlete. */
  field: HyroxResultsCohort;
  /** Solo work at the target's loads is the Pro tier of the athlete's sex. */
  loadsPro: boolean;
  /** loadsPro while the field is the Open singles field: station times
   *  convert between the two (a woman in Mixed Doubles). */
  proLoadsInOpenField: boolean;
}

export function hyroxSoloFrame(
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): HyroxSoloFrame {
  const field = hyroxSinglesCohort(format, biologicalSex, division);
  const loadsPro = hyroxSoloLoadsArePro(format, biologicalSex, division);
  return { field, loadsPro, proLoadsInOpenField: loadsPro && field.format === 'open_singles' };
}

/** One athlete's station time at their solo loads, in the field's own terms
 *  (the time the field's table places). Identity unless proLoadsInOpenField. */
export function hyroxSoloToFieldSec(station: HyroxStation, soloSec: number, frame: Pick<HyroxSoloFrame, 'field' | 'proLoadsInOpenField'>): number {
  return frame.proLoadsInOpenField ? hyroxProToOpenSec(station, soloSec, frame.field.sex) : soloSec;
}

/** The inverse of hyroxSoloToFieldSec: a time in the field's terms at the
 *  athlete's solo loads. */
export function hyroxFieldToSoloSec(station: HyroxStation, fieldSec: number, frame: Pick<HyroxSoloFrame, 'field' | 'proLoadsInOpenField'>): number {
  return frame.proLoadsInOpenField ? hyroxOpenToProSec(station, fieldSec, frame.field.sex) : fieldSec;
}

/** Minimal state the state-level helpers read. */
export interface HyroxCohortStateInput {
  biologicalSex?: BiologicalSex;
  hyroxConfig?: Pick<HyroxConfig, 'format' | 'division'> | null;
}

/** hyroxSoloFrame for the current state. */
export function hyroxSoloFrameForState(state: HyroxCohortStateInput): HyroxSoloFrame {
  const format = state.hyroxConfig?.format ?? 'open_singles';
  return hyroxSoloFrame(format, state.biologicalSex, state.hyroxConfig?.division);
}

/** The target format's own cohort for the current state. */
export function hyroxCohortForState(state: HyroxCohortStateInput): HyroxResultsCohort {
  const format = state.hyroxConfig?.format ?? 'open_singles';
  return hyroxResultsCohort(format, state.biologicalSex, state.hyroxConfig?.division);
}

/** The singles cohort (athlete's own sex, target's weight family) for the state. */
export function hyroxSinglesCohortForState(state: HyroxCohortStateInput): HyroxResultsCohort {
  const format = state.hyroxConfig?.format ?? 'open_singles';
  return hyroxSinglesCohort(format, state.biologicalSex, state.hyroxConfig?.division);
}

// ─── Table access ───────────────────────────────────────────────────────────

/** The S8-S9 table for a metric and cohort; null if the cell is not published. */
export function hyroxResultsTable(metric: HyroxResultsMetric, cohort: HyroxResultsCohort): HyroxPercentileTable | null {
  if (cohort.sex === 'pooled') return HYROX_S89_POOLED_PERCENTILES[cohort.format]?.[metric] ?? null;
  return HYROX_S89_PERCENTILES[cohort.format][cohort.sex]?.[metric] ?? null;
}

/** Finishers behind the S8-S9 table for a metric and cohort (0 if none). */
export function hyroxResultsCount(metric: HyroxResultsMetric, cohort: HyroxResultsCohort): number {
  if (cohort.sex === 'pooled') return HYROX_S89_POOLED_FINISHER_COUNTS[cohort.format]?.[metric] ?? 0;
  return HYROX_S89_FINISHER_COUNTS[cohort.format][cohort.sex]?.[metric] ?? 0;
}

/** Unrounded cumulative percentile of `sec` in a table, clamped to its ends. */
export function cumulativePercentileIn(table: HyroxPercentileTable, sec: number): number {
  if (sec <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (sec >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [t0, p0] = table[i - 1];
    const [t1, p1] = table[i];
    if (sec <= t1) return p0 + ((sec - t0) / (t1 - t0)) * (p1 - p0);
  }
  return last[1];
}

/** Seconds at cumulative percentile `pct` in a table, clamped to its ends. */
export function secondsAtPercentileIn(table: HyroxPercentileTable, pct: number): number {
  if (pct <= table[0][1]) return table[0][0];
  const last = table[table.length - 1];
  if (pct >= last[1]) return last[0];
  for (let i = 1; i < table.length; i++) {
    const [t0, p0] = table[i - 1];
    const [t1, p1] = table[i];
    if (pct <= p1) return t0 + ((pct - p0) / (p1 - p0)) * (t1 - t0);
  }
  return last[0];
}

/** "Faster than X%" (0-100, whole number) for a time in a cohort's table, or
 *  null when the cell is not published. Lower time = higher. */
export function hyroxFasterThanPct(
  metric: HyroxResultsMetric,
  sec: number,
  cohort: HyroxResultsCohort,
): number | null {
  if (!Number.isFinite(sec) || sec <= 0) return null;
  const table = hyroxResultsTable(metric, cohort);
  if (!table) return null;
  return Math.max(0, Math.min(100, Math.round(100 - cumulativePercentileIn(table, sec))));
}

/**
 * A station time placed against the field's race splits at that station:
 * "faster than X%" in the cohort's S8-S9 station table. Pass a time in the
 * cohort's own terms: a pair's time for a doubles cohort, one athlete's time
 * at the cohort's weights for singles. The one station-percentile lookup
 * (radar, forecast rows, station detail, guided-session summary).
 */
export function hyroxStationPercentile(
  station: HyroxStation,
  sec: number,
  cohort: HyroxResultsCohort,
): number | null {
  return hyroxFasterThanPct(station, sec, cohort);
}

/**
 * The timing-slip floor for a station time in a cohort: the station split's
 * far-out lower fence in the results (the ingest's rule 6, which sends such a
 * split to the total table only). A pooled cohort reads the lowest fence of
 * the format's published sex cells (the most permissive). Null if no cell.
 */
export function hyroxStationLowerFenceSec(station: HyroxStation, cohort: HyroxResultsCohort): number | null {
  const cells = HYROX_S79_STATION_LOWER_FENCES_SEC[cohort.format];
  if (cohort.sex !== 'pooled') {
    const f = cells[cohort.sex]?.[station];
    if (f != null) return f;
  }
  const all = Object.values(cells).map(c => c?.[station]).filter((v): v is number => v != null);
  return all.length ? Math.min(...all) : null;
}

// ─── Labels and captions ────────────────────────────────────────────────────

export function hyroxFormatName(format: HyroxFormat): string {
  switch (format) {
    case 'open_singles': return 'Open Singles';
    case 'pro_singles':  return 'Pro Singles';
    case 'open_doubles': return 'Open Doubles';
    case 'pro_doubles':  return 'Pro Doubles';
  }
}

/** "Open Singles women", "Pro Doubles men", "Open Doubles mixed", or the
 *  format alone for a pooled cohort. */
export function hyroxCohortLabel(cohort: HyroxResultsCohort): string {
  const name = hyroxFormatName(cohort.format);
  if (cohort.sex === 'female') return `${name} women`;
  if (cohort.sex === 'male') return `${name} men`;
  if (cohort.sex === 'mixed') return `${name} mixed`;
  return name;
}

/** Who the cohort is, as a plural noun for "faster than X% of ...":
 *  "women", "men", "mixed pairs", "women's pairs", "men's pairs", or
 *  "Open Singles finishers" for a pooled cohort. */
export function hyroxCohortNoun(cohort: HyroxResultsCohort): string {
  const doubles = isHyroxDoublesFormat(cohort.format);
  if (cohort.sex === 'female') return doubles ? "women's pairs" : 'women';
  if (cohort.sex === 'male') return doubles ? "men's pairs" : 'men';
  if (cohort.sex === 'mixed') return 'mixed pairs';
  return `${hyroxFormatName(cohort.format)} finishers`;
}

/**
 * Provenance caption for anything placed on the S8-S9 tables: seasons with
 * years, the cohort's finisher count, and the source. E.g. "HYROX results,
 * seasons 8 and 9 (2025 to 2026), 119,468 Open Singles women finishers, via
 * the open pyrox project."
 */
export function hyroxResultsCaption(cohort: HyroxResultsCohort, metric: HyroxResultsMetric = 'total'): string {
  const n = hyroxResultsCount(metric, cohort).toLocaleString('en-US');
  const who = cohort.sex === 'pooled'
    ? `${hyroxFormatName(cohort.format)} finishers (women and men${cohort.format === 'open_doubles' ? ', and mixed pairs' : ''})`
    : `${hyroxCohortLabel(cohort)} finishers`;
  return `HYROX results, ${HYROX_S89_SEASONS_LABEL}, ${n} ${who}, ${HYROX_RESULTS_VIA}.`;
}

// ─── Age groups (pooled seasons 7 to 9) ─────────────────────────────────────

function ageGroupBounds(label: string): [number, number] | null {
  const plus = /^(\d+)\+$/.exec(label);
  if (plus) return [Number(plus[1]), Infinity];
  const range = /^(\d+)-(\d+)$/.exec(label);
  if (range) return [Number(range[1]), Number(range[2])];
  return null;
}

/** The results age group label (e.g. '30-34', '70+') for an age in a format,
 *  or null when the age is outside every group. Singles use 5-year groups,
 *  doubles 10-year groups (the ingest's convention). */
export function hyroxAgeGroupFor(format: HyroxFormat, age: number | null | undefined): string | null {
  if (age == null || !Number.isFinite(age)) return null;
  const a = Math.floor(age);
  for (const label of HYROX_S79_AGE_GROUPS[format]) {
    const b = ageGroupBounds(label);
    if (b && a >= b[0] && a <= b[1]) return label;
  }
  return null;
}

/** "aged 30 to 34", "aged 70 and over". */
export function hyroxAgeGroupPhrase(label: string): string {
  const b = ageGroupBounds(label);
  if (!b) return `aged ${label}`;
  return b[1] === Infinity ? `aged ${b[0]} and over` : `aged ${b[0]} to ${b[1]}`;
}

/** A finish time placed in its cohort, with the age group when known. */
export interface HyroxCohortPlacement {
  /** "Faster than X%" (0-100, whole number). */
  fasterThanPct: number;
  cohort: HyroxResultsCohort;
  /** The age group the placement used, or null for the whole sex cell. */
  ageGroup: string | null;
  /** Finishers behind the table used. */
  n: number;
  /** The time sits outside the table's range: faster than its first
   *  breakpoint or slower than its last. Coarse age tables stop at p10/p90,
   *  so the headline states a bound there. */
  beyond: 'fast' | 'slow' | null;
  /** Lowest and highest cumulative percentile the table resolves. */
  tableRange: [number, number];
  /** Seasons label of the table set used. */
  seasonsLabel: string;
}

/**
 * Place a finish time (the target format's terms: a pair's time for doubles)
 * in the athlete's cohort. With a known sex and an age inside a published age
 * cell, the age group's table (pooled seasons 7 to 9, where the sample size
 * matters); otherwise the S8-S9 sex cell; a pooled cohort never takes an age
 * group. Null when no table applies.
 */
export function hyroxCohortPlacement(
  totalSec: number | null | undefined,
  cohort: HyroxResultsCohort,
  age?: number | null,
): HyroxCohortPlacement | null {
  if (totalSec == null || !Number.isFinite(totalSec) || totalSec <= 0) return null;
  let table: HyroxPercentileTable | null = null;
  let ageGroup: string | null = null;
  let n = 0;
  let seasonsLabel = HYROX_S89_SEASONS_LABEL;
  if (cohort.sex !== 'pooled') {
    const group = hyroxAgeGroupFor(cohort.format, age);
    const ageTable = group ? HYROX_S79_AGE_TOTAL_PERCENTILES[cohort.format][cohort.sex]?.[group] : undefined;
    if (group && ageTable) {
      table = ageTable;
      ageGroup = group;
      n = HYROX_S79_AGE_TOTAL_COUNTS[cohort.format][cohort.sex]?.[group] ?? 0;
      seasonsLabel = HYROX_S79_SEASONS_LABEL;
    }
  }
  if (!table) {
    table = hyroxResultsTable('total', cohort);
    n = hyroxResultsCount('total', cohort);
  }
  if (!table) return null;
  const beyond = totalSec < table[0][0] ? 'fast' : totalSec > table[table.length - 1][0] ? 'slow' : null;
  return {
    fasterThanPct: Math.max(0, Math.min(100, Math.round(100 - cumulativePercentileIn(table, totalSec)))),
    cohort,
    ageGroup,
    n,
    beyond,
    tableRange: [table[0][1], table[table.length - 1][1]],
    seasonsLabel,
  };
}

/** Who a placement compares against: "women aged 30 to 34", "Open Singles
 *  men", "mixed pairs aged 30 to 39", "Pro Singles finishers". */
export function hyroxPlacementWho(p: Pick<HyroxCohortPlacement, 'cohort' | 'ageGroup'>): string {
  const noun = hyroxCohortNoun(p.cohort);
  if (p.ageGroup) return `${noun} ${hyroxAgeGroupPhrase(p.ageGroup)}`;
  return p.cohort.sex === 'pooled' ? noun : `${hyroxFormatName(p.cohort.format)} ${noun}`;
}

/**
 * The rank line: "Faster than 62% of women aged 30 to 34". Past the slow end
 * (or below 5%) it states the share ahead instead, "Slower than 96% of ...";
 * past a coarse table's end it states the bound the table supports.
 */
export function hyroxPlacementHeadline(p: HyroxCohortPlacement): string {
  const who = hyroxPlacementWho(p);
  if (p.beyond === 'slow' || p.fasterThanPct < 5) {
    const ahead = Math.round(p.beyond === 'slow' ? p.tableRange[1] : 100 - p.fasterThanPct);
    return `Slower than ${ahead}% of ${who}`;
  }
  return `Faster than ${p.fasterThanPct}% of ${who}`;
}

/**
 * The placement as a short figure for a badge: "62%", or the bound the table
 * supports past its ends, "<10%" past the slow end (a coarse age table that
 * stops at p90: the true share behind is at most 10%) and ">90%" past the
 * fast end. The circle on the Stats rank card; it never overstates what the
 * headline states (review 2026-10-13: "Slower than 90%" sat next to "10%").
 */
export function hyroxPlacementFigure(p: Pick<HyroxCohortPlacement, 'fasterThanPct' | 'beyond' | 'tableRange'>): string {
  if (p.beyond === 'slow') return `<${Math.round(100 - p.tableRange[1])}%`;
  if (p.beyond === 'fast') return `>${Math.round(100 - p.tableRange[0])}%`;
  return `${p.fasterThanPct}%`;
}

/** Provenance caption for a cohort placement (the table set it used). */
export function hyroxPlacementCaption(p: HyroxCohortPlacement): string {
  if (!p.ageGroup) return hyroxResultsCaption(p.cohort, 'total');
  return `HYROX results, ${p.seasonsLabel}, ${p.n.toLocaleString('en-US')} ${hyroxCohortLabel(p.cohort)} finishers ${hyroxAgeGroupPhrase(p.ageGroup)}, ${HYROX_RESULTS_VIA}.`;
}

// ─── Field-relative ability bands ───────────────────────────────────────────

const TIME_BANDS: Exclude<AbilityBand, 'total_beginner'>[] = ['competitive', 'advanced', 'intermediate', 'novice', 'beginner'];

/**
 * Band thresholds for a cohort, in the shape of HYROX_TIME_TO_BAND_THRESHOLDS
 * (first match wins, `sec < maxSec`, beginner above the last). Each threshold
 * is the total time at the same field percentile the global scale's
 * threshold held in its calibration field (HYROX_S89_BAND_FIELD_PERCENTILES),
 * so a band means the same position in every format x sex field. Unknown sex
 * falls back to the format's pooled cell.
 */
export function hyroxBandThresholds(cohort: HyroxResultsCohort): Array<{ maxSec: number; band: AbilityBand }> {
  const cells = HYROX_S89_BAND_THRESHOLDS_SEC[cohort.format];
  const th = (cohort.sex !== 'pooled' ? cells[cohort.sex] : undefined) ?? cells.pooled!;
  return TIME_BANDS.map((band, i) => ({ maxSec: i < th.length ? th[i] : Infinity, band }));
}

/** The field-relative band for a total time in a format x sex field. */
export function hyroxBandFor(totalSec: number, format: HyroxFormat, sex: HyroxCohortSex): AbilityBand {
  for (const { maxSec, band } of hyroxBandThresholds(publishedOrPooled(format, sex))) {
    if (totalSec < maxSec) return band;
  }
  return 'beginner';
}

/**
 * The planning field: Open Singles at the athlete's own sex (biological sex,
 * then a single-sex division pick, then the pooled Open Singles table). The
 * one field the planning band is read in for every format (lane H3c,
 * hyrox-planning-band.ts: a Pro or Doubles finish converts to Open Singles
 * terms first), and the field whose band medians are the seeds
 * (hyroxSeedField). Display ranks stay cohort-specific.
 */
export function hyroxPlanningField(biologicalSex: BiologicalSex, division?: HyroxDivision): HyroxResultsCohort {
  return publishedOrPooled('open_singles', resolveHyroxAthleteSex(biologicalSex, division) ?? 'pooled');
}

/**
 * The field-relative band for a previous HYROX finish, read in the field it
 * was raced in: the previous race's format, with the athlete's sex for
 * singles and the doubles division (else sex) for doubles. A descriptive
 * position in that field. Planning does not read it: the plan's band is
 * hyroxPlanningBandFor (hyrox-planning-band.ts), one field for every format,
 * because the Pro fields are fitter and a field-relative band lowered the
 * plan for choosing heavier weights (lane H3c).
 */
export function hyroxBandForPreviousTime(
  prevTimeSec: number,
  prevFormat: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): AbilityBand {
  const cohort = hyroxResultsCohort(prevFormat, biologicalSex, division);
  return hyroxBandFor(prevTimeSec, cohort.format, cohort.sex);
}

// ─── Open-to-Pro station conversion (difference in differences) ─────────────

/** Stations whose load changes from Open to Pro (rulebook s4.1). Ergs and
 *  burpee broad jumps carry no load and convert at 1. */
export const HYROX_LOADED_STATIONS: HyroxStation[] = ['sled_push', 'sled_pull', 'farmer_carry', 'sandbag_lunges', 'wall_balls'];

/** Unloaded segments whose Pro/Open ratio measures the gap in field ability
 *  between the two cohorts (the reference in the difference in differences). */
export const HYROX_PRO_REFERENCE_SEGMENTS: HyroxResultsMetric[] = ['ski_erg', 'row_erg', 'burpee_broad_jumps', 'run_total'];

function proConversionSex(sex: HyroxCohortSex): 'female' | 'male' | 'pooled' {
  return sex === 'female' || sex === 'male' ? sex : 'pooled';
}

export interface HyroxProConversion {
  /** Pro-weight time / Open-weight time for the same athlete. */
  multiplier: number;
  /** 'data': the difference in differences; 'fallback': the method failed
   *  its sanity check (adjusted ratio below 1) and HYROX_PRO_STATION_MULTIPLIER
   *  stands in. */
  source: 'data' | 'fallback';
}

/**
 * Open-to-Pro conversion for one station at a matched percentile `pct`
 * (cumulative, 1 = fastest), by sex. Method: difference in differences on the
 * S8-S9 singles tables.
 *   r_station(p) = pro_singles(p) / open_singles(p) at the station
 *   r_ref(p)     = geometric mean of the same ratio over the unloaded
 *                  segments (SkiErg, row, burpee broad jumps, run total)
 *   multiplier   = r_station(p) / r_ref(p)
 * The Pro field is fitter (r_ref < 1: faster on unloaded work at the same
 * percentile); dividing by r_ref removes that cohort gap and leaves the effect
 * of the heavier load. Women convert from Women Open loads to Men Open loads
 * (Women Pro races the Men Open tier), men from Men Open to Men Pro; an
 * unknown sex reads the pooled tables. Limits: cohort comparison, not the same
 * athletes at both loads; assumes the ability gap on unloaded work carries to
 * the loaded stations.
 */
export function hyroxProConversionAt(station: HyroxStation, sex: HyroxCohortSex, pct: number): HyroxProConversion {
  if (!HYROX_LOADED_STATIONS.includes(station)) return { multiplier: 1, source: 'data' };
  const s = proConversionSex(sex);
  const open = { format: 'open_singles' as const, sex: s };
  const pro = { format: 'pro_singles' as const, sex: s };
  const ratio = (m: HyroxResultsMetric): number | null => {
    const o = hyroxResultsTable(m, open);
    const q = hyroxResultsTable(m, pro);
    if (!o || !q) return null;
    return secondsAtPercentileIn(q, pct) / secondsAtPercentileIn(o, pct);
  };
  const rStation = ratio(station);
  const refs = HYROX_PRO_REFERENCE_SEGMENTS.map(ratio);
  const fallback: HyroxProConversion = { multiplier: HYROX_PRO_STATION_MULTIPLIER[station] ?? 1, source: 'fallback' };
  if (rStation == null || refs.some(r => r == null)) return fallback;
  const rRef = Math.exp(refs.reduce<number>((a, r) => a + Math.log(r as number), 0) / refs.length);
  const multiplier = rStation / rRef;
  if (!Number.isFinite(multiplier) || multiplier < 1) return fallback;
  return { multiplier, source: 'data' };
}

/** The Open-to-Pro multiplier at the percentile an Open-weight station time
 *  holds in the athlete's Open singles field (the median when no time). */
export function hyroxProStationMultiplier(station: HyroxStation, sex: HyroxCohortSex, openSec?: number): number {
  if (!HYROX_LOADED_STATIONS.includes(station)) return 1;
  const table = hyroxResultsTable(station, { format: 'open_singles', sex: proConversionSex(sex) });
  const pct = openSec != null && table ? cumulativePercentileIn(table, openSec) : 50;
  return hyroxProConversionAt(station, sex, pct).multiplier;
}

/** One athlete's Open-weight station time at Pro weights. */
export function hyroxOpenToProSec(station: HyroxStation, openSec: number, sex: HyroxCohortSex): number {
  return openSec * hyroxProStationMultiplier(station, sex, openSec);
}

/** One athlete's Pro-weight station time at Open weights: the inverse of
 *  hyroxOpenToProSec (fixed point on the Open-side percentile; the
 *  multiplier moves slowly with percentile, so it settles in a few steps). */
export function hyroxProToOpenSec(station: HyroxStation, proSec: number, sex: HyroxCohortSex): number {
  if (!HYROX_LOADED_STATIONS.includes(station)) return proSec;
  let open = proSec / hyroxProStationMultiplier(station, sex);
  for (let i = 0; i < 6; i++) open = proSec / hyroxProStationMultiplier(station, sex, open);
  return open;
}

// ─── Improvement ceiling (tracking: race-day projection) ────────────────────

/** Half-season windows (about 6 months each) for a horizon in weeks: the
 *  improvement tables' gapHalfSeasons, 1 to 4. Gap g spans roughly 6(g-1) to
 *  6(g+1) months, so any horizon up to 9 months reads the 1-window cell. */
export function hyroxImprovementGapFor(weeksRemaining: number): number {
  const months = (Math.max(0, weeksRemaining) * 7) / (365.25 / 12);
  return Math.max(1, Math.min(4, Math.round(months / 6)));
}

/** Band of a singles-terms total on the thresholds the improvement cells were
 *  cut with (HYROX_S79_IMPROVEMENT_BAND_THRESHOLDS). */
function improvementBandFor(singlesTotalSec: number): HyroxImprovementCell['band'] {
  for (const { maxSec, band } of HYROX_S79_IMPROVEMENT_BAND_THRESHOLDS) {
    if (singlesTotalSec < maxSec) return band;
  }
  return 'beginner';
}

export interface HyroxImprovementCeiling {
  /** Largest venue-relative gain (percent of finish time, positive) the
   *  projection may show: the upper-quartile improvement of repeat athletes
   *  at this horizon (minus the cell's relPct p25). */
  pct: number;
  /** The improvement cell the ceiling came from. */
  cell: HyroxImprovementCell;
}

/**
 * The improvement ceiling for a race-day projection: the 75th percentile of
 * the first-to-latest race improvement among repeat singles athletes (the
 * relPct p25, venue-relative), for the athlete's singles format, sex, band and
 * horizon. Grouped by the mean of both races (Oldham), which removes the
 * regression to the mean that grouping by the first race builds in.
 *
 * Lookup order: format x sex x band x horizon; then all horizons; then all
 * singles x band x horizon; then all horizons; then the format x sex all-band
 * cell at the horizon (band 'all' cells need no regression correction); then
 * all singles. Doubles have no repeat data and read their singles family.
 *
 * Caveat: relPct includes field drift (the open field's median slowed 12 to
 * 149 s a year at the same venues), which flatters it; the repeat sample is
 * survivors. Both lean the ceiling optimistic, the end the projection aims at.
 */
export function hyroxImprovementCeiling(opts: {
  format: HyroxFormat;
  sex: 'female' | 'male' | null;
  singlesTotalSec: number;
  weeksRemaining: number;
}): HyroxImprovementCeiling | null {
  if (!(opts.weeksRemaining > 0) || !(opts.singlesTotalSec > 0)) return null;
  const fmt = hyroxSinglesFormatOf(opts.format);
  const sex = opts.sex ?? 'all';
  const band = improvementBandFor(opts.singlesTotalSec);
  const gap = hyroxImprovementGapFor(opts.weeksRemaining);
  const find = (f: HyroxImprovementCell['format'], s: HyroxImprovementCell['sex'], g: HyroxImprovementCell['groupBy'], b: HyroxImprovementCell['band'], gp: number | 'all') =>
    HYROX_S79_IMPROVEMENT.find(c => c.format === f && c.sex === s && c.groupBy === g && c.band === b && c.gapHalfSeasons === gp);
  const sexFmt = sex === 'all' ? 'all_singles' : fmt;
  const cell =
    find(sexFmt, sex, 'mean_of_races', band, gap) ??
    find(sexFmt, sex, 'mean_of_races', band, 'all') ??
    find('all_singles', 'all', 'mean_of_races', band, gap) ??
    find('all_singles', 'all', 'mean_of_races', band, 'all') ??
    find(sexFmt, sex, 'first_race', 'all', gap) ??
    find('all_singles', 'all', 'first_race', 'all', gap);
  if (!cell) return null;
  const pct = -cell.relPct[0];
  if (!(pct > 0)) return null;
  return { pct, cell };
}

// ─── Band seeds at the target's weights ─────────────────────────────────────

/** Minimal state the seed helpers read. */
export interface HyroxSeedStateInput {
  biologicalSex?: BiologicalSex;
  hyroxConfig?: Pick<HyroxConfig, 'format' | 'division' | 'athleteBand'> | null;
}

/**
 * The field the athlete's band is read in: the planning field
 * (hyroxPlanningField, Open Singles at the athlete's own sex) for every
 * format, with or without a race on file (lane H3c: a Pro or Doubles finish
 * converts to Open Singles terms before banding, hyroxPlanningBandFor). The
 * one source for the band thresholds a screen shows (chip detail "Band
 * thresholds") and the field the seeds are read in (hyroxSeedField), so the
 * two always describe one field.
 */
export function hyroxBandField(state: HyroxSeedStateInput): HyroxResultsCohort {
  return hyroxPlanningField(state.biologicalSex, state.hyroxConfig?.division);
}

/**
 * The singles field whose band medians are the seeds: the band field
 * (hyroxBandField, Open Singles at the athlete's own sex). A band is a
 * position in a field, so its seeds are that field's band medians; the
 * target's loads come after (hyroxStationSeedsAtTarget converts Open to Pro
 * per station). Before lane H3c a Pro-raced band read the Pro field's medians,
 * when the band itself was read in the Pro field.
 */
export function hyroxSeedField(state: HyroxSeedStateInput): { format: HyroxSeedFormat; sex: HyroxBandCellSex } {
  const field = hyroxBandField(state);
  const sex: HyroxBandCellSex = field.sex === 'female' || field.sex === 'male' ? field.sex : 'pooled';
  return { format: 'open_singles', sex };
}

/**
 * Band seed per station, one athlete's time at the TARGET's loads: the band
 * medians of the seed field (hyroxSeedField, Open Singles at the athlete's
 * sex), converted Open to Pro per station when the target's solo loads are
 * the Pro tier (hyroxSoloLoadsArePro; hyroxOpenToProSec, the difference in
 * differences on the Pro and Open results). A woman in Mixed Doubles races
 * M-Open loads, the Women Pro tier, so her Open Singles women medians convert
 * as a Women Pro athlete's would. The seed every surface reads for an
 * untested station: the forecast, the planning benchmarks, the Stats ledger,
 * the station detail page, the benchmark card.
 */
export function hyroxStationSeedsAtTarget(state: HyroxSeedStateInput, band?: AbilityBand): Record<HyroxStation, number> {
  const b = band ?? state.hyroxConfig?.athleteBand ?? 'intermediate';
  const field = hyroxSeedField(state);
  const seeds = stationSeedTimesFor(b, field.format, field.sex);
  const targetPro = hyroxSoloLoadsArePro(state.hyroxConfig?.format ?? 'open_singles', state.biologicalSex, state.hyroxConfig?.division);
  if (!targetPro) return seeds;
  const out = {} as Record<HyroxStation, number>;
  for (const st of Object.keys(seeds) as HyroxStation[]) out[st] = hyroxOpenToProSec(st, seeds[st], field.sex);
  return out;
}

/** Seed run pace (s/km, one athlete) for the band in the seed field. Running
 *  carries no load, so no weight conversion. */
export function hyroxSeedRunPaceSecKm(state: HyroxSeedStateInput, band?: AbilityBand): number {
  const field = hyroxSeedField(state);
  return seedRunPaceSecKmFor(band ?? state.hyroxConfig?.athleteBand ?? 'intermediate', field.format, field.sex);
}

/** Seed Roxzone (s, one athlete) for the band in the seed field. */
export function hyroxSeedRoxzoneSec(state: HyroxSeedStateInput, band?: AbilityBand): number {
  const field = hyroxSeedField(state);
  return seedRoxzoneSecFor(band ?? state.hyroxConfig?.athleteBand ?? 'intermediate', field.format, field.sex);
}

// ─── Peers: finishers at the same finish time (tracking) ────────────────────

/** The segments of a HYROX result a peer reference covers, in the order the
 *  results report them: the 8 km of running, the 8 stations, the Roxzone. */
export type HyroxPeerSegment = 'run_total' | HyroxStation | 'roxzone';

export const HYROX_PEER_SEGMENTS: readonly HyroxPeerSegment[] = ['run_total', ...HYROX_STATION_ORDER, 'roxzone'];

/** What finishers at one finish time typically do in each segment. */
export interface HyroxPeerSplits {
  cohort: HyroxResultsCohort;
  totalSec: number;
  /** Seconds per segment: the band medians at totalSec plus the medians'
   *  additivity gap spread by skew, so the 10 segments sum to totalSec. */
  segments: Record<HyroxPeerSegment, number>;
  /** segments.run_total over the 8 legs, by the cohort's median leg shape. */
  runLegsSec: number[];
  /** totalSec against the band anchors: between two (interpolated), or
   *  faster than the fastest band's median finish / slower than the slowest
   *  (the end band's split mix, scaled to totalSec). */
  position: 'within' | 'faster' | 'slower';
}

function bandSeedCellsFor(cohort: HyroxResultsCohort) {
  const cells = HYROX_S89_BAND_SEEDS[cohort.format];
  const bySex = cells[cohort.sex] ?? cells.pooled;
  if (!bySex) return null;
  const anchors = TIME_BANDS.map(b => bySex[b]).filter((c): c is NonNullable<typeof c> => c != null);
  return anchors.length >= 2 ? [...anchors].sort((a, b) => a.medians.total - b.medians.total) : null;
}

/** Share of the run total per leg (run 1 to run 8): the cohort's median leg
 *  splits (seasons 7 to 9, the only per-leg data in the results); a pooled
 *  cohort averages the shares of the format's published sex cells. */
export function hyroxRunLegShares(cohort: HyroxResultsCohort): number[] {
  const cells = HYROX_S79_RUN_LEG_MEDIANS_SEC[cohort.format];
  const share = (legs: readonly number[]): number[] => {
    const sum = legs.reduce((a, b) => a + b, 0);
    return legs.map(l => l / sum);
  };
  const own = cohort.sex !== 'pooled' ? cells[cohort.sex] : undefined;
  if (own && own.length === 8) return share(own);
  const all = Object.values(cells).filter((l): l is readonly number[] => l != null && l.length === 8).map(share);
  if (all.length === 0) return new Array(8).fill(1 / 8);
  return Array.from({ length: 8 }, (_, i) => all.reduce((a, s) => a + s[i], 0) / all.length);
}

/**
 * Each segment's weight in the medians' additivity gap (hyroxPeerSplitsAt):
 * its right skew in the cohort's own S8-S9 results table, the Bowley
 * numerator (p75 - p50) - (p50 - p25), as a share of the 10 segments' total.
 * A right-skewed split's mean sits above its median, and the means are what
 * add up to the finish, so the gap between the summed medians and the median
 * finish belongs mostly to the skewed segments (Open Singles women: run total
 * 94 s, wall balls 40 s, Roxzone 36 s, SkiErg 4 s). A segment with no right
 * skew gets none. Null without a published table for every segment.
 */
export function hyroxPeerResidualWeights(cohort: HyroxResultsCohort): Record<HyroxPeerSegment, number> | null {
  const skew = {} as Record<HyroxPeerSegment, number>;
  for (const seg of HYROX_PEER_SEGMENTS) {
    const table = hyroxResultsTable(seg, cohort);
    if (!table) return null;
    const q = (pct: number) => secondsAtPercentileIn(table, pct);
    skew[seg] = Math.max(0, (q(75) - q(50)) - (q(50) - q(25)));
  }
  const sum = HYROX_PEER_SEGMENTS.reduce((a, seg) => a + skew[seg], 0);
  if (!(sum > 0)) return null;
  return Object.fromEntries(HYROX_PEER_SEGMENTS.map(seg => [seg, skew[seg] / sum])) as Record<HyroxPeerSegment, number>;
}

/**
 * The peer reference for a finish time: what finishers in the cohort who
 * finished in `totalSec` typically spend on each segment.
 *
 * Method: the band seeds are the real median split of every segment among the
 * finishers in each ability band of the cohort's field (HYROX_S89_BAND_SEEDS,
 * five bands from the top 1% to the slowest 7%), each band anchored at its
 * own median finish. Between two anchors each segment is interpolated
 * linearly in finish time; past the fastest or slowest anchor the end band's
 * split mix is scaled to the finish time. Medians do not add up: the 10
 * segment medians of a band sum to within 1.3% of its median finish, nearly
 * always under it. That gap (finish minus the summed medians) is spread by
 * each segment's right skew in the cohort's results (hyroxPeerResidualWeights),
 * so the reference sums to `totalSec` and an athlete at their peers' typical
 * mix loses nothing anywhere. Spreading it by segment size instead put about
 * half of it on the run total (19 to 33 s at the band median finishes), so a
 * typical runner read 20 to 30 s gained on Running; by skew the run takes 4
 * to 25 s, its own share (lane rp review 3).
 *
 * Why not each segment's own quantile at the finish percentile: no finisher
 * sits at the same percentile in every segment, so per-segment quantiles run
 * fast of the real band medians at the fast end (up to about 95 s a segment
 * for the top band, the run total the most) and slow at the slow end (up to
 * about 180 s on the Roxzone for the slowest band). The conditional medians are the field's own
 * answer to "what do athletes who finish in this time do".
 *
 * Limits: cohort medians, not the same athletes; the skew weights are the
 * whole field's, not the skew among finishers at one time (the data has no
 * per-band quartiles); one leg shape for every finish time; venues differ
 * (sled surface, run course, Roxzone layout), and the band medians mix every
 * venue. Side of the line: tracking.
 */
export function hyroxPeerSplitsAt(cohort: HyroxResultsCohort, totalSec: number): HyroxPeerSplits | null {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return null;
  const anchors = bandSeedCellsFor(cohort);
  if (!anchors) return null;
  const first = anchors[0].medians;
  const last = anchors[anchors.length - 1].medians;
  let raw: Record<HyroxPeerSegment, number>;
  let position: HyroxPeerSplits['position'] = 'within';
  const scaled = (m: Record<HyroxResultsMetric, number>, k: number) =>
    Object.fromEntries(HYROX_PEER_SEGMENTS.map(seg => [seg, m[seg] * k])) as Record<HyroxPeerSegment, number>;
  if (totalSec <= first.total) {
    raw = scaled(first, totalSec / first.total);
    position = totalSec < first.total ? 'faster' : 'within';
  } else if (totalSec >= last.total) {
    raw = scaled(last, totalSec / last.total);
    position = totalSec > last.total ? 'slower' : 'within';
  } else {
    let i = 0;
    while (i < anchors.length - 2 && totalSec > anchors[i + 1].medians.total) i++;
    const a = anchors[i].medians;
    const b = anchors[i + 1].medians;
    const w = (totalSec - a.total) / (b.total - a.total);
    raw = Object.fromEntries(HYROX_PEER_SEGMENTS.map(seg => [seg, a[seg] + w * (b[seg] - a[seg])])) as Record<HyroxPeerSegment, number>;
  }
  const residual = totalSec - HYROX_PEER_SEGMENTS.reduce((acc, seg) => acc + raw[seg], 0);
  const weights = hyroxPeerResidualWeights(cohort);
  const rawSum = totalSec - residual;
  const segments = Object.fromEntries(HYROX_PEER_SEGMENTS.map(seg => [
    seg,
    raw[seg] + residual * (weights ? weights[seg] : raw[seg] / rawSum),
  ])) as Record<HyroxPeerSegment, number>;
  const runLegsSec = hyroxRunLegShares(cohort).map(sh => segments.run_total * sh);
  return { cohort, totalSec, segments, runLegsSec, position };
}

/** The competitive anchor of a cohort: the median split of every segment
 *  among the top 1% of its finishers (the competitive band seed). The goal
 *  back-calculation's floors (hyrox-race-plan.ts). Null without a cell. */
export interface HyroxCompetitiveFloors {
  stationSec: Record<HyroxStation, number>;
  runSec: number;
  roxzoneSec: number;
  /** The band's median finish. */
  totalSec: number;
}

export function hyroxCompetitiveFloors(cohort: HyroxResultsCohort): HyroxCompetitiveFloors | null {
  const anchors = bandSeedCellsFor(cohort);
  if (!anchors) return null;
  const m = anchors[0].medians;
  return {
    stationSec: Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, m[st]])) as Record<HyroxStation, number>,
    runSec: m.run_total,
    roxzoneSec: m.roxzone,
    totalSec: m.total,
  };
}
