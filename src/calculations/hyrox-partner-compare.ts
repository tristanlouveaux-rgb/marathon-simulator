/**
 * HYROX Doubles partner comparison and pair forecast.
 *
 * Side: tracking. Describes how two linked athletes' current numbers compare
 * and what the pair would race; it does not change either plan.
 *
 * Pair setup. The pair races one format, one division and one load tier: both
 * partners' snapshots must name the same doubles format, the same division
 * and the same race tier (hyroxLoadTier; Mixed = Men Open loads for both
 * partners, 26/27 Doubles rulebook s4.1). When they disagree (one partner set
 * up as Women, the other as Mixed; one as Men, the other as Mixed, which
 * share M-Open loads but not the doubles results table; or one still in
 * singles), there is no pair tier.
 *
 * Every number a snapshot carries is at the athlete's solo loads in the race
 * (hyroxSoloStationTier): lane H3b converts each stored benchmark there per
 * entry with the per-sex Open/Pro conversions from the results data
 * (hyroxOpenToProSec / hyroxProToOpenSec, a difference in differences). In a
 * Mixed pair a woman's Women Open tests therefore arrive as Men Open times
 * (the Women Pro tier is M-Open, and she throws to the same 2.70 m target as
 * in Women Pro; hyrox-division.ts, rulebook s4.1, s8.8), and in a Pro pair
 * Open-weight tests arrive as Pro times. This module converts nothing itself.
 *
 * Station leads. Per station, each partner's benchmark (snapshot stationSec,
 * their own Stats ledger number):
 *   - SkiErg, Row Erg and Burpee Broad Jumps have one race standard in every
 *     tier (1000 m at damper 6, 80 m; derived from hyroxStationRaceStandard),
 *     so they compare as they are;
 *   - a loaded station compares when both partners' values are at the pair's
 *     tier (snapshot stationTier), which every value at a matching setup is.
 *     It reads not comparable as 'setup' when the race setups differ,
 *     'tier_unknown' when a value's tier cannot be stated (no sex on file in
 *     Mixed: the app then reads the pooled tables, which mix both sexes'
 *     loads), and 'tier' for a value at another known tier (only a row
 *     written outside this builder can hold one);
 *   - a benchmark that is a doubles race split is a pair time, not one
 *     athlete's capacity, so it cannot say who is faster: not comparable.
 * The lead is the whole-second difference. No "optimal split" saving is
 * claimed: the per-station lead list is the guidance.
 *
 * Pair forecast (equal split). Each partner's snapshot carries their own
 * doubles forecast lines (predictHyroxRace, before venue factors): per
 * station the pair's time at that partner's percentile in their own singles
 * field, read from the pair's division table (H3b, doublesStationTeamSec: a
 * pair at percentile p is two athletes near p in their own fields; a Mixed
 * woman's M-Open time is placed in the women's field through
 * hyroxSoloToFieldSec first). Both lines are therefore in the same terms, the
 * pair's division table, whatever each partner's sex. So:
 *   stations = Σ (A's line + B's line) / 2: each partner covers half of every
 *              station, the pair landing between the pair times at their two
 *              percentiles, the turn-taking benefit carried by each line's
 *              doubles mapping;
 *   run      = 8 × the slower partner's singles pace (partners run every leg
 *              together, 26/27 Doubles rulebook s4.3, s7.3);
 *   roxzone  = the slower of the two partners' Roxzone lines (partners pass
 *              all 8 transitions together, s7.3), compared in the pair's terms.
 * Two identical partners reproduce the athlete's own doubles forecast
 * stations and Roxzone. The run differs by design: the athlete's own doubles
 * forecast applies the cohort's doubles run ratio, while the pair runs at the
 * slower partner's singles pace. Venue factors are not applied.
 *
 * The pair forecast is withheld (forecastWithheld, with withheldFor naming
 * whose times):
 *   - 'setup' when there is no pair tier (the two race setups differ);
 *   - 'loads_unknown' when a partner's loaded-station numbers have no stated
 *     tier, benchmark or seed: no biological sex on file in a Mixed pair. The
 *     pooled tables their numbers come from mix the women's and men's loads,
 *     so no conversion to the pair's loads exists for them;
 *   - 'loads' when a loaded station carries a known tier other than the
 *     pair's (only a row written outside this builder can).
 *   The station rows still show either way.
 */

import type { HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import { HYROX_LOAD_TIER_KG, HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { hyroxStationRaceStandard, isHyroxDoublesFormat } from './hyrox-division';
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
  /** A loaded station with a value at a known tier other than the pair's
   *  (a row written outside this builder). */
  | 'tier'
  /** A loaded station with a value whose tier cannot be stated (no sex on
   *  file in Mixed). */
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
  /** Σ over the 8 stations of the two partners' mean station line. */
  stationsSec: number;
  runSec: number;
  /** The slower partner's Roxzone line. */
  roxzoneSec: number;
}

export interface HyroxPartnerComparison {
  /** The doubles format both partners race; null when they differ or either
   *  is not a doubles format. */
  pairFormat: HyroxPartnerFormat | null;
  /** The tier both partners race; null without a pair format, or when their
   *  divisions or race tiers differ or either is unknown. */
  pairTier: HyroxLoadTier | null;
  stations: PartnerStationComparison[];
  run: {
    /** The pair's pace: the slower partner's singles pace. */
    paceSecKm: number;
    setBy: 'you' | 'partner' | 'both';
  };
  /** Null when withheld (see forecastWithheld). */
  forecast: PartnerPairForecast | null;
  /** Why the forecast is null: 'setup' = the race setups differ;
   *  'loads_unknown' = a partner's loaded-station numbers have no stated tier;
   *  'loads' = a loaded station is at another known tier. Null when shown. */
  forecastWithheld: PairForecastWithheld | null;
  /** 'loads' / 'loads_unknown': whose station times the forecast waits on. */
  withheldFor: PartnerSide | null;
}

/** The pair's format and tier, or nulls when the two setups disagree. The
 *  division must match as well as the tier: Men and Mixed Open Doubles both
 *  race M-Open loads but are different races with different results tables,
 *  and each partner's forecast lines are mapped in their own division's. */
export function hyroxPairSetup(
  you: Pick<HyroxPartnerSnapshot, 'format' | 'division' | 'raceTier'>,
  partner: Pick<HyroxPartnerSnapshot, 'format' | 'division' | 'raceTier'>,
): { pairFormat: HyroxPartnerFormat | null; pairTier: HyroxLoadTier | null } {
  const pairFormat = you.format === partner.format && isHyroxDoublesFormat(you.format) ? you.format : null;
  const pairTier = pairFormat && you.raceTier != null && you.raceTier === partner.raceTier
    && you.division != null && you.division === partner.division
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

/** Loaded stations that keep the pair forecast from one load tier, over every
 *  loaded station (a seeded station's forecast line is at the athlete's
 *  stated tier too): whose are at a known tier other than the pair's
 *  (offTier), and whose have no stated tier (unknown). */
export function pairForecastLoadGaps(
  you: HyroxPartnerSnapshot,
  partner: HyroxPartnerSnapshot,
  pairTier: HyroxLoadTier,
): { offTier: PartnerSide | null; unknown: PartnerSide | null } {
  const scan = (snap: HyroxPartnerSnapshot) => {
    let off = false;
    let unknown = false;
    for (const st of HYROX_STATION_ORDER) {
      if (isTierIndependentStation(st)) continue;
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

/** The pair forecast from two snapshots at one pair setup (see header):
 *  equal split of every station, the slower partner's run pace and Roxzone. */
export function hyroxPairForecast(
  you: Pick<HyroxPartnerSnapshot, 'forecastStationSec' | 'roxzoneSec'>,
  partner: Pick<HyroxPartnerSnapshot, 'forecastStationSec' | 'roxzoneSec'>,
  runPaceSecKm: number,
): PartnerPairForecast {
  let stationsSec = 0;
  for (const st of HYROX_STATION_ORDER) {
    stationsSec += (you.forecastStationSec[st] + partner.forecastStationSec[st]) / 2;
  }
  const runSec = 8 * runPaceSecKm;
  const roxzoneSec = Math.max(you.roxzoneSec, partner.roxzoneSec);
  return {
    totalSec: Math.round(stationsSec + runSec + roxzoneSec),
    stationsSec: Math.round(stationsSec),
    runSec: Math.round(runSec),
    roxzoneSec,
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
    forecast: forecastWithheld == null ? hyroxPairForecast(you, partner, paceSecKm) : null,
    forecastWithheld,
    withheldFor,
  };
}
