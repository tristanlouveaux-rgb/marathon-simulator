/**
 * HYROX Doubles partner comparison and pair forecast.
 *
 * Side: tracking. Describes how two linked athletes' current numbers compare
 * and what the pair would race; it does not change either plan.
 *
 * Pair setup. The pair races one format at one load tier: both partners'
 * snapshots must name the same doubles format and the same race tier
 * (hyroxLoadTier; Mixed = Men Open loads for both partners, 26/27 Doubles
 * rulebook s4.1). When they disagree (one partner set up as Women, the other
 * as Mixed, or one still in singles), there is no pair tier.
 *
 * Station leads. Per station, each partner's benchmark (snapshot stationSec,
 * their own Stats ledger number). The comparison itself converts nothing:
 *   - SkiErg, Row Erg and Burpee Broad Jumps have one race standard in every
 *     tier (1000 m at damper 6, 80 m; derived from hyroxStationRaceStandard),
 *     so they compare as they are;
 *   - a loaded station compares only when both partners' values are at the
 *     pair's tier (snapshot stationTier). A value the app converted between
 *     Open and Pro weights counts at the tier the conversion lands on, as in
 *     each partner's own forecast and Stats ledger (the Open/Pro convention,
 *     HYROX_PRO_STATION_MULTIPLIER). No other cross-tier conversion exists, so
 *     a Mixed woman's Women Open time is never turned into a Men Open time:
 *     the station reads not comparable ('tier'), or 'tier_unknown' when a
 *     value's tier cannot be stated, or 'setup' when the two race setups
 *     differ;
 *   - a benchmark that is a doubles race split is a pair time, not one
 *     athlete's capacity, so it cannot say who is faster: not comparable.
 * The lead is the whole-second difference. No "optimal split" saving is
 * claimed: the per-station lead list is the guidance.
 *
 * Pair forecast. Mirrors predictHyroxRace's doubles path on the pair's own
 * numbers (each partner's forecast inputs in singles terms):
 *   stations = Σ mean(partner A, partner B singles station time) × r_st
 *     r_st = doublesRatioAt('stations', Σ means) (percentile-matched on the
 *     ingested results, hyrox-doubles.ts; read at Open-weight times for a Pro
 *     pair, as stationRatioFor does);
 *   run      = 8 × the slower partner's singles pace (partners run every leg
 *              together, 26/27 Doubles rulebook s4.3, s7.3);
 *   roxzone  = the slower partner's singles Roxzone × doublesRatioAt('roxzone')
 *              (partners pass all 8 transitions together, s7.3).
 * The equal-split mean assumes each partner covers half of every station at
 * their singles pace; the doubles station ratio then carries the cohort's
 * turn-taking benefit. Venue factors are not applied.
 *
 * The pair forecast is withheld (forecastWithheld, with withheldFor naming
 * whose times):
 *   - 'setup' when there is no pair tier (the two race setups differ);
 *   - 'loads' when a partner has a loaded-station benchmark at a known tier
 *     other than the pair's. Each partner's forecast station time is built
 *     from that benchmark, so the pair number would mix loads (a Mixed
 *     woman's Women Open times read as Men Open). A value converted between
 *     Open and Pro by the app's convention is at the pair's tier, as in the
 *     solo forecast, so a Pro pair whose tests were at Open weights keeps its
 *     forecast;
 *   - 'loads_unknown' when no value is at another known tier but one's tier
 *     cannot be stated (a Mixed athlete with no biological sex on file, the
 *     legacy pooled benchmark field).
 *   The station rows still show either way.
 *   TODO(H3b): once lane H3b's per-sex Open->Pro station conversions land,
 *   convert instead of withholding. A woman's Women Open -> Women Pro
 *   conversion is the Women Open -> Men Open conversion a Mixed pair needs:
 *   the Women Pro tier is M-Open, and a Mixed woman throws wall balls to the
 *   same 2.70 m target as in Women Pro (hyrox-division.ts, 26/27 rulebook
 *   s4.1, s8.8).
 */

import type { HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import { HYROX_LOAD_TIER_KG, HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { HYROX_PRO_STATION_MULTIPLIER } from '@/constants/hyrox-constants';
import { hyroxStationRaceStandard, isHyroxDoublesFormat, isHyroxProFormat } from './hyrox-division';
import { doublesRatioAt } from './hyrox-doubles';
import type { HyroxPartnerFormat, HyroxPartnerSnapshot } from './hyrox-partner-snapshot';

const TIERS = Object.keys(HYROX_LOAD_TIER_KG) as HyroxLoadTier[];

/** True when a station's race standard is the same in every load tier
 *  (derived from the rulebook encoding in hyroxStationRaceStandard, not a
 *  hand list): SkiErg, Row Erg and Burpee Broad Jumps. */
export function isTierIndependentStation(station: HyroxStation): boolean {
  const first = hyroxStationRaceStandard(station, TIERS[0], null);
  return TIERS.every(t => hyroxStationRaceStandard(station, t, null) === first);
}

export type PartnerNotComparableReason =
  | 'missing_both'
  | 'missing_you'
  | 'missing_partner'
  | 'team_time'
  /** A loaded station with a value at a known tier other than the pair's. */
  | 'tier'
  /** A loaded station with a value whose tier cannot be stated. */
  | 'tier_unknown'
  /** A loaded station when the two race setups differ (no pair tier). */
  | 'setup';

/** Whose station times a withheld forecast waits on. */
export type PartnerSide = 'you' | 'partner' | 'both';

export type PairForecastWithheld = 'setup' | 'loads' | 'loads_unknown';

export interface PartnerStationComparison {
  station: HyroxStation;
  /** 'you' / 'partner' = who is faster; 'level' = same whole second. */
  status: 'you' | 'partner' | 'level' | 'not_comparable';
  /** Seconds the faster partner leads by (status 'you' | 'partner'). */
  leadSec?: number;
  reason?: PartnerNotComparableReason;
}

export interface PartnerPairForecast {
  totalSec: number;
  stationsSec: number;
  runSec: number;
  roxzoneSec: number;
  /** Pair station time ÷ the summed equal-split singles station time. */
  stationRatio: number;
  roxzoneRatio: number;
}

export interface HyroxPartnerComparison {
  /** The doubles format both partners race; null when they differ or either
   *  is not a doubles format. */
  pairFormat: HyroxPartnerFormat | null;
  /** The tier both partners race; null without a pair format, or when their
   *  race tiers differ or either is unknown. */
  pairTier: HyroxLoadTier | null;
  stations: PartnerStationComparison[];
  run: {
    /** The pair's pace: the slower partner's singles pace. */
    paceSecKm: number;
    setBy: 'you' | 'partner' | 'both';
  };
  /** Null when withheld (see forecastWithheld). */
  forecast: PartnerPairForecast | null;
  /** Why the forecast is null: 'setup' = the race setups differ; 'loads' = a
   *  loaded-station benchmark is at another known tier; 'loads_unknown' = a
   *  loaded-station benchmark's tier is unknown. Null when shown. */
  forecastWithheld: PairForecastWithheld | null;
  /** 'loads' / 'loads_unknown': whose station times the forecast waits on. */
  withheldFor: PartnerSide | null;
}

/** The pair's format and tier, or nulls when the two setups disagree. */
export function hyroxPairSetup(
  you: Pick<HyroxPartnerSnapshot, 'format' | 'raceTier'>,
  partner: Pick<HyroxPartnerSnapshot, 'format' | 'raceTier'>,
): { pairFormat: HyroxPartnerFormat | null; pairTier: HyroxLoadTier | null } {
  const pairFormat = you.format === partner.format && isHyroxDoublesFormat(you.format) ? you.format : null;
  const pairTier = pairFormat && you.raceTier != null && you.raceTier === partner.raceTier
    ? you.raceTier
    : null;
  return { pairFormat, pairTier };
}

function compareStation(
  station: HyroxStation,
  you: HyroxPartnerSnapshot,
  partner: HyroxPartnerSnapshot,
  pairTier: HyroxLoadTier | null,
): PartnerStationComparison {
  const a = you.stationSec[station];
  const b = partner.stationSec[station];
  if (a == null && b == null) return { station, status: 'not_comparable', reason: 'missing_both' };
  if (a == null) return { station, status: 'not_comparable', reason: 'missing_you' };
  if (b == null) return { station, status: 'not_comparable', reason: 'missing_partner' };
  if (you.teamStations.includes(station) || partner.teamStations.includes(station)) {
    return { station, status: 'not_comparable', reason: 'team_time' };
  }
  if (!isTierIndependentStation(station)) {
    if (pairTier == null) return { station, status: 'not_comparable', reason: 'setup' };
    const ta = you.stationTier[station];
    const tb = partner.stationTier[station];
    if ((ta != null && ta !== pairTier) || (tb != null && tb !== pairTier)) {
      return { station, status: 'not_comparable', reason: 'tier' };
    }
    if (ta == null || tb == null) return { station, status: 'not_comparable', reason: 'tier_unknown' };
  }
  const diff = Math.round(b) - Math.round(a);
  if (diff > 0) return { station, status: 'you', leadSec: diff };
  if (diff < 0) return { station, status: 'partner', leadSec: -diff };
  return { station, status: 'level' };
}

function sideOf(you: boolean, partner: boolean): PartnerSide | null {
  if (you && partner) return 'both';
  if (you) return 'you';
  return partner ? 'partner' : null;
}

/** Loaded-station benchmarks that keep the pair forecast from one load tier:
 *  whose are at a known tier other than the pair's (offTier), and whose have
 *  no known tier (unknown). */
export function pairForecastLoadGaps(
  you: HyroxPartnerSnapshot,
  partner: HyroxPartnerSnapshot,
  pairTier: HyroxLoadTier,
): { offTier: PartnerSide | null; unknown: PartnerSide | null } {
  const scan = (snap: HyroxPartnerSnapshot) => {
    let off = false;
    let unknown = false;
    for (const st of HYROX_STATION_ORDER) {
      if (isTierIndependentStation(st) || snap.stationSec[st] == null) continue;
      const t = snap.stationTier[st];
      if (t == null) unknown = true;
      else if (t !== pairTier) off = true;
    }
    return { off, unknown };
  };
  const a = scan(you);
  const b = scan(partner);
  return { offTier: sideOf(a.off, b.off), unknown: sideOf(a.unknown, b.unknown) };
}

/** The pair forecast from two snapshots at one pair format (see header). */
export function hyroxPairForecast(
  you: HyroxPartnerSnapshot,
  partner: HyroxPartnerSnapshot,
  pairFormat: HyroxPartnerFormat,
  runPaceSecKm: number,
): PartnerPairForecast {
  const pro = isHyroxProFormat(pairFormat);
  let singlesSum = 0;
  let lookupSum = 0;
  for (const st of HYROX_STATION_ORDER) {
    const mean = (you.forecastStationSec[st] + partner.forecastStationSec[st]) / 2;
    singlesSum += mean;
    lookupSum += pro ? mean / (HYROX_PRO_STATION_MULTIPLIER[st] ?? 1) : mean;
  }
  const stationRatio = doublesRatioAt('stations', lookupSum).ratio;
  const stationsSec = singlesSum * stationRatio;
  const runSec = 8 * runPaceSecKm;
  const roxSingles = Math.max(you.roxzoneSec, partner.roxzoneSec);
  const roxzoneRatio = doublesRatioAt('roxzone', roxSingles).ratio;
  const roxzoneSec = Math.round(roxSingles * roxzoneRatio);
  return {
    totalSec: Math.round(stationsSec + runSec + roxzoneSec),
    stationsSec: Math.round(stationsSec),
    runSec: Math.round(runSec),
    roxzoneSec,
    stationRatio,
    roxzoneRatio,
  };
}

/** Compare the viewer ("you") with the linked partner. */
export function compareHyroxPartners(
  you: HyroxPartnerSnapshot,
  partner: HyroxPartnerSnapshot,
): HyroxPartnerComparison {
  const { pairFormat, pairTier } = hyroxPairSetup(you, partner);
  const stations = HYROX_STATION_ORDER.map(st => compareStation(st, you, partner, pairTier));
  const paceSecKm = Math.max(you.runPaceSecKm, partner.runPaceSecKm);
  const setBy = you.runPaceSecKm === partner.runPaceSecKm
    ? 'both'
    : you.runPaceSecKm > partner.runPaceSecKm ? 'you' : 'partner';
  let forecastWithheld: PairForecastWithheld | null = null;
  let withheldFor: PartnerSide | null = null;
  if (!pairFormat || !pairTier) {
    forecastWithheld = 'setup';
  } else {
    const gaps = pairForecastLoadGaps(you, partner, pairTier);
    if (gaps.offTier) { forecastWithheld = 'loads'; withheldFor = gaps.offTier; }
    else if (gaps.unknown) { forecastWithheld = 'loads_unknown'; withheldFor = gaps.unknown; }
  }
  return {
    pairFormat,
    pairTier,
    stations,
    run: { paceSecKm, setBy },
    forecast: pairFormat && forecastWithheld == null ? hyroxPairForecast(you, partner, pairFormat, paceSecKm) : null,
    forecastWithheld,
    withheldFor,
  };
}
