/**
 * HYROX Doubles forecast ratios. Side: tracking (race-time prediction).
 *
 * Rules (HYROX 26/27 Doubles rulebook): both partners run all 8 x 1 km
 * together and the finish is the later chip (s4.3, s7.3), they enter and leave
 * every station together through all 8 transitions (s7.3), and they take turns
 * inside every station with no minimum share (s7.2). Nobody skips a station.
 *
 * Model: quantile mapping on the app's own ingested results
 * (src/data/hyrox-population-distributions.ts, Kaggle jgug05/hyrox-results,
 * seasons S4 to S6). For a metric (stations total, Roxzone, run total), find
 * the athlete's cumulative percentile p of their singles time in the
 * open_singles table, then
 *
 *     ratio(p) = open_doubles(p) / open_singles(p)
 *
 * with both tables linearly interpolated in p. The team's time for that
 * metric = singles time x ratio(p). Outside the table (faster than P1 or slower
 * than P99) the end ratio holds. Every ratio is computed from the tables here;
 * none is hard-coded. At P50: stations 1577 / 2208 = 0.71, Roxzone 380 / 405 =
 * 0.94, run 2762 / 2695 = 1.02 (the pair runs at the slower partner's pace).
 *
 * Limitations:
 *  - Cohort comparison, not the same athletes racing both formats.
 *  - open_doubles pools Women, Men and Mixed pairs (three load tiers) and is
 *    compared against pooled Women and Men open singles.
 *  - The stations table is the 8-station total, so one station ratio applies
 *    to every station; per-station doubles ratios are not in the data.
 *  - No pro_doubles rows exist; Pro Doubles uses the Open ratios.
 *  - S4 to S6 predates the 100-rep Women Open wall-ball standard (75 then).
 */

import type { AbilityBand, HyroxConfig, HyroxStation } from '@/types/triathlon';
import {
  HYROX_STATIONS_PERCENTILE_TABLES,
  HYROX_ROXZONE_PERCENTILE_TABLES,
  HYROX_RUN_PERCENTILE_TABLES,
  HYROX_TOTAL_PERCENTILE_TABLES,
} from '@/data/hyrox-population-distributions';
import { SEED_ROXZONE_SEC } from '@/constants/hyrox-benchmarks';
import { SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES } from '@/constants/hyrox-constants';
import { isHyroxDoublesFormat } from './hyrox-division';
import { benchmarkEntryForSlotValue, isRaceSplitSource } from './hyrox-station-history';

type HyroxFormat = HyroxConfig['format'];
type Breakpoints = Array<[number, number]>;

export type DoublesMetric = 'stations' | 'roxzone' | 'run' | 'total';

const TABLES: Record<DoublesMetric, Record<'open_singles' | 'open_doubles', Breakpoints>> = {
  stations: HYROX_STATIONS_PERCENTILE_TABLES,
  roxzone:  HYROX_ROXZONE_PERCENTILE_TABLES,
  run:      HYROX_RUN_PERCENTILE_TABLES,
  total:    HYROX_TOTAL_PERCENTILE_TABLES,
};

/** Unrounded cumulative percentile of `sec` in a breakpoint table, clamped to
 *  the table's end percentiles. */
export function cumulativePercentileAt(table: Breakpoints, sec: number): number {
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

/** Seconds at cumulative percentile `pct` in a breakpoint table, clamped to the
 *  table's end points. */
export function secondsAtCumulativePercentile(table: Breakpoints, pct: number): number {
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

export interface DoublesRatio {
  /** Team time ÷ singles time at the athlete's percentile. */
  ratio: number;
  /** The athlete's cumulative percentile in the open_singles table (1 = fastest). */
  singlesPercentile: number;
}

/** Percentile-matched doubles/singles ratio for a metric, read at the
 *  athlete's singles time. */
export function doublesRatioAt(metric: DoublesMetric, singlesSec: number): DoublesRatio {
  const singles = TABLES[metric].open_singles;
  const doubles = TABLES[metric].open_doubles;
  const p = cumulativePercentileAt(singles, singlesSec);
  const ratio = secondsAtCumulativePercentile(doubles, p) / secondsAtCumulativePercentile(singles, p);
  return { ratio, singlesPercentile: p };
}

/** The same ratio read from the doubles side: the pair's time's percentile in
 *  the open_doubles table. For converting a pair's time to singles terms
 *  (singles = team ÷ ratio), e.g. to place a Pro Doubles total, which has no
 *  ingested table, on the Pro singles scale. */
export function doublesRatioAtTeamTime(metric: DoublesMetric, teamSec: number): DoublesRatio {
  const singles = TABLES[metric].open_singles;
  const doubles = TABLES[metric].open_doubles;
  const p = cumulativePercentileAt(doubles, teamSec);
  const ratio = secondsAtCumulativePercentile(doubles, p) / secondsAtCumulativePercentile(singles, p);
  return { ratio, singlesPercentile: p };
}

/** Team station ratio, refined once for stations whose time is already a team
 *  time (a doubles race split). `soloSec` holds singles-capacity times (tests,
 *  singles splits, seeds); `teamSec` holds team times. The first pass reads the
 *  ratio with team stations at their seed singles time; the second converts
 *  team times back to singles with that ratio and reads it again. */
export function doublesStationRatio(
  soloSec: number[],
  teamSec: number[],
  teamSeedSoloSec: number[],
): DoublesRatio {
  const soloSum = soloSec.reduce((a, b) => a + b, 0);
  const first = doublesRatioAt('stations', soloSum + teamSeedSoloSec.reduce((a, b) => a + b, 0));
  if (teamSec.length === 0) return first;
  return doublesRatioAt('stations', soloSum + teamSec.reduce((a, b) => a + b / first.ratio, 0));
}

/** Seed Roxzone (seconds) for a band in a format: the band seed for singles;
 *  for doubles, the seed x the percentile-matched Roxzone ratio (partners pass
 *  through all 8 transitions together, so Roxzone is not halved). */
export function seedRoxzoneSecForFormat(band: AbilityBand, format: HyroxFormat): number {
  const seed = SEED_ROXZONE_SEC[band] ?? 0;
  if (!isHyroxDoublesFormat(format) || seed <= 0) return seed;
  return Math.round(seed * doublesRatioAt('roxzone', seed).ratio);
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
 * A previous HYROX finish time in the terms the band thresholds use, for
 * banding. Side: planning input (the band sets the MTL cap, sessions and
 * hours) and tracking (the band's seed times feed the forecast).
 *
 * The band thresholds (HYROX_TIME_TO_BAND_THRESHOLDS) and the band seed times
 * are singles times. The doubles forecast multiplies the band's singles seeds
 * by the doubles ratios, so a doubles target is banded on a singles-terms time:
 *  - a doubles previous time ÷ the percentile-matched total ratio, read on the
 *    doubles side (doublesRatioAtTeamTime), the inverse of the forecast's own
 *    mapping;
 *  - a singles previous time as is.
 * Banding a doubles target on the doubles time itself (a singles time × 0.85,
 * a doubles time unconverted) applied the doubles conversion twice: review
 * 2026-10-12 measured a doubles-median athlete banded advanced, stations 13%
 * and Roxzone 35% faster than the doubles median.
 *
 * A singles target is unchanged: a doubles previous time ×
 * SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES, a singles previous time as is.
 */
export function hyroxBandingTimeSec(
  prevTimeSec: number,
  prevFormat: HyroxFormat,
  targetFormat: HyroxFormat,
): number {
  if (!isHyroxDoublesFormat(prevFormat)) return prevTimeSec;
  if (isHyroxDoublesFormat(targetFormat)) {
    return Math.round(prevTimeSec / doublesRatioAtTeamTime('total', prevTimeSec).ratio);
  }
  return Math.round(prevTimeSec * SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES);
}
