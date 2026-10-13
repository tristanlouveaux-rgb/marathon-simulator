/**
 * The HYROX planning band: the ability band every planning input reads (plan
 * tier, MTL cap, weekly sessions, plan length, the hours range, and the band
 * seeds behind untested-station targets).
 *
 * Side of the line: planning. The band prescribes; display ranks describe.
 * Display ranks (percentile lines, "top N%", the distributions card) stay
 * cohort-specific (format x sex x age, hyrox-results.ts). The planning band
 * is read in ONE field for everyone, so choosing heavier weights or a partner
 * never changes the plan (orchestrator decision, lane H3c): under H3b's
 * field-relative bands the fitter Pro fields pushed 34% of Pro Singles men
 * and 49% of Pro Doubles men down a band, which meant more conservative plans
 * for picking heavier weights.
 *
 * Rule: the planning field is Open Singles at the athlete's own sex
 * (hyroxPlanningField: biological sex, then the division pick, then the
 * pooled Open Singles table). A finish from any format converts to Open
 * Singles terms first (hyroxOpenSinglesTermsSec), then takes that field's
 * band thresholds (hyroxBandFor, the field-relative thresholds of
 * HYROX_S89_BAND_THRESHOLDS_SEC). An Open Singles finish is banded as is.
 *
 * Conversion (hyroxOpenSinglesTermsSec), one race-field decomposition then
 * the canonical per-component conversions:
 *  1. Composition. The finish's cumulative percentile p in its race field's
 *     total table (hyroxResultsCohort: singles by the athlete's sex, doubles
 *     by the pair's division). The race field's 8 station splits, run total
 *     and Roxzone at p, scaled so they sum to the finish. A finish carries no
 *     splits, so the athlete is given the field's own composition at their
 *     place in it.
 *  2. Doubles: each component maps to one athlete's time in the singles field
 *     of their own sex in the same weight family, per station
 *     (doublesStationSoloSec) and for the run and Roxzone
 *     (doublesRatioAtTeamTime), the forecast's own mapping. A woman in Mixed
 *     Doubles maps into Open Singles women's terms (W-Open loads: the field's
 *     own terms, so no Pro tier step).
 *  3. Pro (Pro Singles, or Pro Doubles after step 2): each loaded station
 *     converts Pro to Open (hyroxProToOpenSec, the difference in differences
 *     on the Pro and Open results, by sex). Ergs, burpee broad jumps, the run
 *     and Roxzone carry no load and stay.
 *  4. Sum.
 *
 * Limits: the composition is the field's at the athlete's percentile, not the
 * athlete's own (logged splits are not used, so the band stays a function of
 * the finish time, the one input setup, initialisation, log-a-race and the
 * format fix all share); each conversion is a cohort comparison (pairs as two
 * athletes near the same place in their own fields; the Pro and Open fields
 * differing on loaded work by the load alone).
 *
 * Science log: docs/SCIENCE_LOG.md, HYROX planning band (lane H3c).
 */

import type { AbilityBand, HyroxConfig, HyroxDivision, HyroxStation } from '@/types/triathlon';
import type { HyroxResultsMetric } from '@/data/hyrox-results-s79';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { isHyroxDoublesFormat } from './hyrox-division';
import { doublesRatioAtTeamTime, doublesStationSoloSec, type HyroxDoublesTables } from './hyrox-doubles';
import {
  cumulativePercentileIn,
  secondsAtPercentileIn,
  hyroxResultsTable,
  hyroxResultsCohort,
  hyroxSinglesCohort,
  hyroxPlanningField,
  hyroxBandFor,
  hyroxProToOpenSec,
  HYROX_LOADED_STATIONS,
  type HyroxResultsCohort,
} from './hyrox-results';

type HyroxFormat = HyroxConfig['format'];
type BiologicalSex = 'male' | 'female' | 'prefer_not_to_say' | null | undefined;

/** The components a finish decomposes into: the 8 stations, the run total
 *  and Roxzone (they sum to the finish in the results' own accounting). */
const COMPONENTS: HyroxResultsMetric[] = [...HYROX_STATION_ORDER, 'run_total', 'roxzone'];

/** The race field's composition at a finish: each component's time at the
 *  finish's percentile, scaled to sum to the finish. Null when a table is
 *  missing. */
function composition(totalSec: number, race: HyroxResultsCohort): number[] | null {
  const totalTable = hyroxResultsTable('total', race);
  if (!totalTable) return null;
  const p = cumulativePercentileIn(totalTable, totalSec);
  const parts: number[] = [];
  for (const m of COMPONENTS) {
    const t = hyroxResultsTable(m, race);
    if (!t) return null;
    parts.push(secondsAtPercentileIn(t, p));
  }
  const sum = parts.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  return parts.map(x => (x * totalSec) / sum);
}

/**
 * A finish time from any format in Open Singles terms of the athlete's own
 * sex: what the same athlete would run at Open Singles loads, alone (see the
 * module header). Open Singles finishes return as is. Falls back to the
 * finish as is when a results table is missing (never for published cells).
 */
export function hyroxOpenSinglesTermsSec(
  totalSec: number,
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): number {
  if (!Number.isFinite(totalSec) || totalSec <= 0 || format === 'open_singles') return totalSec;
  const race = hyroxResultsCohort(format, biologicalSex, division);
  const parts = composition(totalSec, race);
  if (!parts) return totalSec;
  let singles = hyroxSinglesCohort(format, biologicalSex, division);
  let solo = parts;
  if (isHyroxDoublesFormat(format)) {
    // The field's own terms on the singles side (no Mixed-woman Pro tier
    // flag): the result is placed in that singles field.
    const tables: HyroxDoublesTables = { singles, doubles: race };
    solo = COMPONENTS.map((m, i) => {
      const team = parts[i];
      if (m === 'run_total') return team / doublesRatioAtTeamTime('run', team, tables).ratio;
      if (m === 'roxzone') return team / doublesRatioAtTeamTime('roxzone', team, tables).ratio;
      return doublesStationSoloSec(m as HyroxStation, team, tables);
    });
  } else {
    singles = race;
  }
  if (singles.format === 'pro_singles') {
    solo = COMPONENTS.map((m, i) => HYROX_LOADED_STATIONS.includes(m as HyroxStation)
      ? hyroxProToOpenSec(m as HyroxStation, solo[i], singles.sex)
      : solo[i]);
  }
  return solo.reduce((a, b) => a + b, 0);
}

/**
 * The planning band for a finish time: the finish in Open Singles terms
 * (hyroxOpenSinglesTermsSec) banded on the Open Singles field of the
 * athlete's own sex (hyroxPlanningField; the division pick, then the pooled
 * Open Singles table, when sex is unknown). The one helper every planning
 * band reads: setup, initialisation, log-a-race and the previous-format fix.
 */
export function hyroxPlanningBandFor(
  totalSec: number,
  format: HyroxFormat,
  biologicalSex: BiologicalSex,
  division?: HyroxDivision,
): AbilityBand {
  const field = hyroxPlanningField(biologicalSex, division);
  return hyroxBandFor(hyroxOpenSinglesTermsSec(totalSec, format, biologicalSex, division), field.format, field.sex);
}
