/**
 * HYROX "where you lost time": a past result, segment by segment, against
 * real athletes who finished in the same time.
 *
 * Side of the line: tracking. It describes a race already run; the training
 * side ("where to gain", hyrox-weakest-link.ts) is the forward-looking half
 * of the same story.
 *
 * Method: the result is placed in the field it was raced in (the previous
 * race's format; singles by the athlete's sex, doubles by the pair's
 * division, hyroxResultsCohort). The peers are hyroxPeerSplitsAt at the
 * result's finish time: the real median split of every segment among
 * finishers in each band of that field, interpolated by finish time, with the
 * medians' additivity gap spread by each segment's skew so they sum to the
 * finish (hyrox-results.ts). Each segment's time lost is
 * the athlete's split minus the peers'. When all 17 segments are known, time
 * lost and time gained balance to zero; the ranking shows where the time went.
 *
 * Segments: the 8 stations; Running, one segment (the 8 legs together
 * against the peers' run total, or the pasted run total, or the legs that
 * were pasted against the same peer legs); the Roxzone, pasted or implied
 * (finish minus the 16 timed segments, the ingest's own rule for an untimed
 * Roxzone). Running is ranked whole: eight 1 km legs ranked one by one against
 * whole stations split one loss into eight small ones and named the wrong
 * segment for the common profile (strong stations, slower runs). The legs stay
 * on the Running segment as data, in race order (peer legs split by the
 * field's median leg shape), but no leg is named on screen: the field's legs
 * run Run 1 about 11% under the mean leg and Run 8 11 to 13% over, while the
 * race plan prescribes the forecast's near-even legs, so naming a leg would
 * contradict the app's own pacing until that leg shape is decided. With the 8
 * stations and no run data the rest of the race is one segment, "Running and
 * Roxzone".
 *
 * Materiality: a segment within HYROX_LOSE_TIME_MATERIAL_SEC of its peers is
 * level, neither lost nor gained.
 *
 * Limits: the peers are cohort medians, not the same athletes; venues differ
 * (sled surface and lane, run course length, Roxzone layout), so a segment
 * can read slow at a slow venue; the run-leg shape is one shape for every
 * finish time; the medians' additivity gap (up to 67 s at a band's median
 * finish) is spread by the whole field's skew per segment, an estimate of
 * where finishers at one time spend it (SCIENCE_LOG §DO).
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';
import { HYROX_STATION_ORDER, STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { hyroxPeerSplitsAt, hyroxResultsCohort, type HyroxResultsCohort, type HyroxFormat } from './hyrox-results';
import { isHyroxDoublesFormat } from './hyrox-division';
import { ftRounded } from '@/utils/format';

/**
 * Seconds inside which a segment is level with its peers. The method's own
 * measured uncertainty: linear interpolation of the band medians and a
 * quantile-plus-residual hybrid place the same peer split 0 to 15 s apart
 * (SCIENCE_LOG §DO, lane rp probe over the 14 published cells). A smaller
 * difference is below what the comparison can resolve; venues vary more.
 */
export const HYROX_LOSE_TIME_MATERIAL_SEC = 15;

/** The splits of the athlete's previous result, as far as they are known. */
export interface HyroxPastRaceSplits {
  stations: Partial<Record<HyroxStation, number>>;
  /** Run 1 to run 8; null where a leg was not captured. */
  runLegsSec?: Array<number | null>;
  /** The 8 runs together (Run Total on the results page). */
  runTotalSec?: number;
  roxzoneSec?: number;
}

const FORMATS: ReadonlyArray<HyroxFormat> = ['open_singles', 'pro_singles', 'open_doubles', 'pro_doubles'];

/**
 * The previous result's splits: the ones logged with it
 * (hyroxPreviousStationSplits, run legs, run total, Roxzone), else the race
 * splits in the station history filed under the previous race's format and
 * date (onboarding stores them there). With no race date on file the history
 * splits count only when every one shares a single date, so splits from two
 * races are never mixed.
 */
export function hyroxPastRaceSplits(hx: Partial<HyroxConfig> | null | undefined): HyroxPastRaceSplits {
  if (!hx) return { stations: {} };
  const logged = hx.hyroxPreviousStationSplits;
  let stations: Partial<Record<HyroxStation, number>> = {};
  if (logged && Object.keys(logged).length > 0) {
    for (const st of HYROX_STATION_ORDER) {
      const v = logged[st];
      if (typeof v === 'number' && v > 0) stations[st] = v;
    }
  } else if (hx.hyroxPreviousTimeFormat && hx.stationBenchmarkHistory) {
    const fmt = hx.hyroxPreviousTimeFormat;
    const date = hx.hyroxPreviousRaceDate;
    const found: Array<{ st: HyroxStation; sec: number; dateISO: string }> = [];
    for (const st of HYROX_STATION_ORDER) {
      const entries = (hx.stationBenchmarkHistory[st] ?? [])
        .filter(e => e.source === 'race' && e.format === fmt && (date == null || e.dateISO === date));
      const latest = entries[entries.length - 1];
      if (latest && latest.sec > 0) found.push({ st, sec: latest.sec, dateISO: latest.dateISO });
    }
    const oneRace = date != null || new Set(found.map(f => f.dateISO)).size <= 1;
    if (oneRace) stations = Object.fromEntries(found.map(f => [f.st, f.sec]));
  }
  const legs = hx.hyroxPreviousRunSplitsSec;
  return {
    stations,
    ...(legs && legs.some(v => v != null) ? { runLegsSec: [...legs] } : {}),
    ...(hx.hyroxPreviousRunTotalSec ? { runTotalSec: hx.hyroxPreviousRunTotalSec } : {}),
    ...(hx.hyroxPreviousRoxzoneSec ? { roxzoneSec: hx.hyroxPreviousRoxzoneSec } : {}),
  };
}

export type HyroxLoseTimeKey = HyroxStation | 'run_total' | 'roxzone' | 'run_roxzone';

/** One run leg behind the Running segment. */
export interface HyroxLoseTimeLeg {
  /** 1 to 8. */
  leg: number;
  athleteSec: number;
  peerSec: number;
  lostSec: number;
}

export interface HyroxLoseTimeSegment {
  key: HyroxLoseTimeKey;
  /** "Wall Balls", "Running", "Roxzone", "Running and Roxzone". */
  label: string;
  athleteSec: number;
  peerSec: number;
  /** athleteSec - peerSec: positive = slower than the peers. */
  lostSec: number;
  /** The athlete's time is the finish minus the timed segments. */
  implied: boolean;
  /** Running: the pasted legs against the peer legs, in race order. */
  legs?: HyroxLoseTimeLeg[];
  /** Running compared over some of the 8 legs only: how many. */
  partialLegs?: number;
}

export interface HyroxLoseTime {
  /** 'no_result': no previous finish (or its format) on file; 'no_splits':
   *  a finish but no segment to compare; 'ok'. */
  status: 'no_result' | 'no_splits' | 'ok';
  totalSec?: number;
  format?: HyroxFormat;
  cohort?: HyroxResultsCohort;
  /** The comparison field is the athlete's current division, not one
   *  recorded with the result (a doubles result logged before the past
   *  race's division was stored). */
  divisionAssumed?: boolean;
  /** Every compared segment, most time lost first. */
  segments: HyroxLoseTimeSegment[];
  /** Segments at least HYROX_LOSE_TIME_MATERIAL_SEC slower than the peers,
   *  most lost first. */
  losses: HyroxLoseTimeSegment[];
  /** Segments at least HYROX_LOSE_TIME_MATERIAL_SEC faster, most gained first. */
  gains: HyroxLoseTimeSegment[];
  /** Inside the band either way: level with the peers, in race order
   *  (Running, the stations, the Roxzone). */
  level: HyroxLoseTimeSegment[];
  /** "Most time lost on Wall Balls: 1:12 slower than athletes finishing in 1:24:31". */
  headline: string | null;
}

/** The Forecast tab's one number rule for a time lost, gained or saved:
 *  "1:12" (m:ss) from a minute up, "40s" under a minute. Where you lost time,
 *  Where to gain and Biggest targets all use it. */
export function fmtLostTime(sec: number): string {
  const t = Math.round(Math.abs(sec));
  if (t < 60) return `${t}s`;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** Who finished in the same time: athletes (singles) or pairs (doubles). */
export function hyroxPeerNoun(format: HyroxFormat): string {
  return isHyroxDoublesFormat(format) ? 'pairs' : 'athletes';
}

/** "on Wall Balls", "on Running", "in the Roxzone". */
function onSegment(seg: Pick<HyroxLoseTimeSegment, 'key' | 'label'>): string {
  return seg.key === 'roxzone' ? 'in the Roxzone' : `on ${seg.label}`;
}

/**
 * The one-line headline: the segment with the most time lost, else the one
 * with the most gained, else level everywhere. The finish in full (h:mm:ss)
 * so it never reads like the m:ss of the time lost.
 */
export function hyroxLoseTimeHeadline(
  losses: HyroxLoseTimeSegment[],
  gains: HyroxLoseTimeSegment[],
  format: HyroxFormat,
  totalSec: number,
): string {
  const who = `${hyroxPeerNoun(format)} finishing in ${ftRounded(totalSec)}`;
  if (losses[0]) return `Most time lost ${onSegment(losses[0])}: ${fmtLostTime(losses[0].lostSec)} slower than ${who}`;
  if (gains[0]) return `Most time gained ${onSegment(gains[0])}: ${fmtLostTime(gains[0].lostSec)} faster than ${who}`;
  return `Within ${HYROX_LOSE_TIME_MATERIAL_SEC}s of ${who} on every segment`;
}

/**
 * Compare known splits of a result with the peers at its finish time. Pure:
 * the state wrapper is analyzeHyroxLoseTime.
 */
export function compareWithPeers(
  cohort: HyroxResultsCohort,
  totalSec: number,
  splits: HyroxPastRaceSplits,
): HyroxLoseTimeSegment[] {
  const peers = hyroxPeerSplitsAt(cohort, totalSec);
  if (!peers) return [];
  const out: HyroxLoseTimeSegment[] = [];
  const add = (key: HyroxLoseTimeKey, label: string, athleteSec: number, peerSec: number, implied = false, extra: Partial<HyroxLoseTimeSegment> = {}) => {
    if (!(athleteSec > 0) || !(peerSec > 0)) return;
    out.push({ key, label, athleteSec, peerSec, lostSec: athleteSec - peerSec, implied, ...extra });
  };

  const known = HYROX_STATION_ORDER.filter(st => (splits.stations[st] ?? 0) > 0);
  for (const st of known) add(st, STATION_DISPLAY[st].name, splits.stations[st]!, peers.segments[st]);
  const allStations = known.length === 8;
  const stationSum = known.reduce((a, st) => a + splits.stations[st]!, 0);

  // The pasted legs against the peer legs, in race order.
  const legs: HyroxLoseTimeLeg[] = [];
  (splits.runLegsSec ?? []).slice(0, 8).forEach((v, i) => {
    if (typeof v === 'number' && v > 0) legs.push({ leg: i + 1, athleteSec: v, peerSec: peers.runLegsSec[i], lostSec: v - peers.runLegsSec[i] });
  });
  const legDetail = legs.length > 0 ? { legs } : {};
  let runTotal: number | undefined;
  if (legs.length === 8) runTotal = legs.reduce((a, l) => a + l.athleteSec, 0);
  else if (splits.runTotalSec) runTotal = splits.runTotalSec;

  if (runTotal != null) {
    add('run_total', 'Running', runTotal, peers.segments.run_total, false, legDetail);
    if (splits.roxzoneSec) add('roxzone', 'Roxzone', splits.roxzoneSec, peers.segments.roxzone);
    else if (allStations) add('roxzone', 'Roxzone', totalSec - stationSum - runTotal, peers.segments.roxzone, true);
  } else if (splits.roxzoneSec) {
    add('roxzone', 'Roxzone', splits.roxzoneSec, peers.segments.roxzone);
    if (allStations) {
      // The rest of a complete result is the running; pasted legs stay as
      // detail.
      add('run_total', 'Running', totalSec - stationSum - splits.roxzoneSec, peers.segments.run_total, true, legDetail);
    }
  } else if (allStations && legs.length === 0) {
    add('run_roxzone', 'Running and Roxzone', totalSec - stationSum, peers.segments.run_total + peers.segments.roxzone, true);
  }

  // Some legs only, and no way to complete the running: those legs against
  // the same peer legs, still one Running segment.
  if (legs.length > 0 && !out.some(seg => seg.key === 'run_total')) {
    add('run_total', 'Running', legs.reduce((a, l) => a + l.athleteSec, 0), legs.reduce((a, l) => a + l.peerSec, 0), false,
      { legs, partialLegs: legs.length });
  }

  return out.sort((a, b) => b.lostSec - a.lostSec);
}

/** Where a segment falls in the results' own order: the running, the 8
 *  stations in race order, the Roxzone. */
const RACE_ORDER_KEYS: readonly HyroxLoseTimeKey[] = ['run_roxzone', 'run_total', ...HYROX_STATION_ORDER, 'roxzone'];
function raceOrderIndex(key: HyroxLoseTimeKey): number {
  return RACE_ORDER_KEYS.indexOf(key);
}

/** The segment with the most time lost (a material loss): a station,
 *  Running, the Roxzone, or Running and Roxzone; null without one. "Where to
 *  gain" names it too, with its own forecast line, so the past race and
 *  training read as one story. */
export function hyroxTopLostSegment(lt: Pick<HyroxLoseTime, 'losses'>): HyroxLoseTimeSegment | null {
  return lt.losses[0] ?? null;
}

/** "Where you lost time" for the athlete's previous result. */
export function analyzeHyroxLoseTime(state: Pick<SimulatorState, 'hyroxConfig' | 'biologicalSex'>): HyroxLoseTime {
  const hx = state.hyroxConfig;
  const empty = { segments: [], losses: [], gains: [], level: [], headline: null };
  const totalSec = hx?.previousHyroxTimeSec;
  const format = hx?.hyroxPreviousTimeFormat;
  if (!hx || !totalSec || totalSec <= 0 || !format || !FORMATS.includes(format)) {
    return { status: 'no_result', ...empty };
  }
  // The field the race was run in: a doubles result's own division when it
  // was recorded with it, else the athlete's current one (named in the
  // provenance caption).
  const isDoubles = isHyroxDoublesFormat(format);
  const pastDivision = isDoubles ? hx.hyroxPreviousTimeDivision : undefined;
  const divisionAssumed = isDoubles && pastDivision == null;
  const cohort = hyroxResultsCohort(format, state.biologicalSex, pastDivision ?? hx.division);
  const segments = compareWithPeers(cohort, totalSec, hyroxPastRaceSplits(hx));
  if (segments.length === 0) return { status: 'no_splits', totalSec, format, cohort, divisionAssumed, ...empty };
  const m = HYROX_LOSE_TIME_MATERIAL_SEC;
  const losses = segments.filter(s => Math.round(s.lostSec) >= m);
  const gains = segments.filter(s => Math.round(s.lostSec) <= -m).sort((a, b) => a.lostSec - b.lostSec);
  const level = segments.filter(s => !losses.includes(s) && !gains.includes(s))
    .sort((a, b) => raceOrderIndex(a.key) - raceOrderIndex(b.key));
  return {
    status: 'ok',
    totalSec,
    format,
    cohort,
    divisionAssumed,
    segments,
    losses,
    gains,
    level,
    headline: hyroxLoseTimeHeadline(losses, gains, format, totalSec),
  };
}
