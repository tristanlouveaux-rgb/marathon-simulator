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
 * finishers in each band of that field, interpolated by finish time and
 * scaled to sum to the finish (hyrox-results.ts). Each segment's time lost is
 * the athlete's split minus the peers'. When all 17 segments are known, time
 * lost and time gained balance to zero; the ranking shows where the time went.
 *
 * Segments: the 8 stations; the 8 run legs (peer legs split by the field's
 * median leg shape) when all 8 were pasted, else the run total; the Roxzone,
 * pasted or implied (finish minus the 16 timed segments, the ingest's own rule
 * for an untimed Roxzone). With the 8 stations and no run data the rest of the
 * race is one segment, "Running and Roxzone".
 *
 * Limits: the peers are cohort medians, not the same athletes; venues differ
 * (sled surface and lane, run course length, Roxzone layout), so a segment
 * can read slow at a slow venue; the run-leg shape is one shape for every
 * finish time.
 */

import type { SimulatorState } from '@/types/state';
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';
import { HYROX_STATION_ORDER, STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { hyroxPeerSplitsAt, hyroxResultsCohort, type HyroxResultsCohort, type HyroxFormat } from './hyrox-results';
import { isHyroxDoublesFormat } from './hyrox-division';

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

export type HyroxLoseTimeKey =
  | HyroxStation | 'run_total' | 'roxzone' | 'run_roxzone'
  | 'run_1' | 'run_2' | 'run_3' | 'run_4' | 'run_5' | 'run_6' | 'run_7' | 'run_8';

export interface HyroxLoseTimeSegment {
  key: HyroxLoseTimeKey;
  /** "Wall Balls", "Run 8", "Roxzone", "Running and Roxzone". */
  label: string;
  athleteSec: number;
  peerSec: number;
  /** athleteSec - peerSec: positive = slower than the peers. */
  lostSec: number;
  /** The athlete's time is the finish minus the timed segments. */
  implied: boolean;
}

export interface HyroxLoseTime {
  /** 'no_result': no previous finish (or its format) on file; 'no_splits':
   *  a finish but no segment to compare; 'ok'. */
  status: 'no_result' | 'no_splits' | 'ok';
  totalSec?: number;
  format?: HyroxFormat;
  cohort?: HyroxResultsCohort;
  /** Every compared segment, most time lost first. */
  segments: HyroxLoseTimeSegment[];
  /** Segments at least 1 s slower than the peers, most lost first. */
  losses: HyroxLoseTimeSegment[];
  /** Segments at least 1 s faster, most gained first. */
  gains: HyroxLoseTimeSegment[];
  /** "Most time lost on Wall Balls: 1:12 slower than athletes finishing in 1:24". */
  headline: string | null;
}

/** "1:12" from a minute, "40 sec" under it. */
export function fmtLostTime(sec: number): string {
  const t = Math.round(Math.abs(sec));
  if (t < 60) return `${t} sec`;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** A finish as runners say it: "1:24" (hours and whole minutes), "58 min". */
export function fmtFinishShort(sec: number): string {
  const totalMin = Math.floor(Math.round(sec) / 60);
  if (totalMin < 60) return `${totalMin} min`;
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}

/** Who finished in the same time: athletes (singles) or pairs (doubles). */
export function hyroxPeerNoun(format: HyroxFormat): string {
  return isHyroxDoublesFormat(format) ? 'pairs' : 'athletes';
}

/** The one-line headline for a ranked comparison. */
export function hyroxLoseTimeHeadline(
  losses: HyroxLoseTimeSegment[],
  format: HyroxFormat,
  totalSec: number,
): string {
  const who = `${hyroxPeerNoun(format)} finishing in ${fmtFinishShort(totalSec)}`;
  const top = losses[0];
  if (!top) return `No segment slower than ${who}`;
  return `Most time lost on ${top.label}: ${fmtLostTime(top.lostSec)} slower than ${who}`;
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
  const add = (key: HyroxLoseTimeKey, label: string, athleteSec: number, peerSec: number, implied = false) => {
    if (!(athleteSec > 0) || !(peerSec > 0)) return;
    out.push({ key, label, athleteSec, peerSec, lostSec: athleteSec - peerSec, implied });
  };

  const known = HYROX_STATION_ORDER.filter(st => (splits.stations[st] ?? 0) > 0);
  for (const st of known) add(st, STATION_DISPLAY[st].name, splits.stations[st]!, peers.segments[st]);
  const allStations = known.length === 8;
  const stationSum = known.reduce((a, st) => a + splits.stations[st]!, 0);

  const legs = splits.runLegsSec ?? [];
  const legsKnown = legs.filter((v): v is number => typeof v === 'number' && v > 0);
  const allLegs = legs.length === 8 && legsKnown.length === 8;
  let runTotal: number | undefined;
  if (allLegs) {
    legs.forEach((v, i) => add(`run_${i + 1}` as HyroxLoseTimeKey, `Run ${i + 1}`, v as number, peers.runLegsSec[i]));
    runTotal = legsKnown.reduce((a, b) => a + b, 0);
  } else if (splits.runTotalSec) {
    runTotal = splits.runTotalSec;
    add('run_total', 'Running', runTotal, peers.segments.run_total);
  } else {
    legs.forEach((v, i) => {
      if (typeof v === 'number' && v > 0) add(`run_${i + 1}` as HyroxLoseTimeKey, `Run ${i + 1}`, v, peers.runLegsSec[i]);
    });
  }

  if (splits.roxzoneSec) {
    add('roxzone', 'Roxzone', splits.roxzoneSec, peers.segments.roxzone);
    if (allStations && runTotal == null && legsKnown.length === 0) {
      add('run_total', 'Running', totalSec - stationSum - splits.roxzoneSec, peers.segments.run_total, true);
    }
  } else if (allStations && runTotal != null) {
    add('roxzone', 'Roxzone', totalSec - stationSum - runTotal, peers.segments.roxzone, true);
  } else if (allStations && legsKnown.length === 0) {
    add('run_roxzone', 'Running and Roxzone', totalSec - stationSum, peers.segments.run_total + peers.segments.roxzone, true);
  }

  return out.sort((a, b) => b.lostSec - a.lostSec);
}

/** "Where you lost time" for the athlete's previous result. */
export function analyzeHyroxLoseTime(state: Pick<SimulatorState, 'hyroxConfig' | 'biologicalSex'>): HyroxLoseTime {
  const hx = state.hyroxConfig;
  const empty = { segments: [], losses: [], gains: [], headline: null };
  const totalSec = hx?.previousHyroxTimeSec;
  const format = hx?.hyroxPreviousTimeFormat;
  if (!hx || !totalSec || totalSec <= 0 || !format || !FORMATS.includes(format)) {
    return { status: 'no_result', ...empty };
  }
  const cohort = hyroxResultsCohort(format, state.biologicalSex, hx.division);
  const segments = compareWithPeers(cohort, totalSec, hyroxPastRaceSplits(hx));
  if (segments.length === 0) return { status: 'no_splits', totalSec, format, cohort, ...empty };
  const losses = segments.filter(s => Math.round(s.lostSec) >= 1);
  const gains = segments.filter(s => Math.round(s.lostSec) <= -1).sort((a, b) => a.lostSec - b.lostSec);
  return {
    status: 'ok',
    totalSec,
    format,
    cohort,
    segments,
    losses,
    gains,
    headline: hyroxLoseTimeHeadline(losses, format, totalSec),
  };
}
