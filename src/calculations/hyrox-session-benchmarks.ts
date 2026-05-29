/**
 * HYROX guided-session → station-benchmark learning.
 *
 * When the athlete completes a guided station session we capture a per-round
 * time for every station. This module turns those measured times into benchmark
 * improvements, following the "Manually-set Benchmarks Yield to Improvements"
 * rule (CLAUDE.md) and the science in SCIENCE_LOG §AP:
 *
 *  - Only **race-pace** sessions teach the benchmark (density, brick). Technique
 *    runs at 65% of seed pace by design — its times are submaximal and must
 *    never feed the benchmark. They are still surfaced in the session summary.
 *  - The candidate is the athlete's **best (fastest) round** for each station.
 *    It is measured under in-circuit fatigue, so it is a *conservative* proxy
 *    for a fresh single-station benchmark: beating the stored benchmark even
 *    while fatigued is strong, hard-to-fake evidence the benchmark is stale.
 *  - **PB-only**: a benchmark only ever improves (lower time) from a session; a
 *    slow day never degrades it. A station with no user benchmark yet is
 *    calibrated from the best round (better than the population estimate).
 *  - A **sanity floor** (the elite / competitive seed time) rejects implausibly
 *    fast times that are almost certainly a timing slip.
 *
 * Mirrors the canonical benchmark write in `benchmark-card.ts`: scalar slot
 * (`hyroxConfig.stationBenchmarksSingles` / `…Doubles`) is authoritative for
 * fast prediction reads; `stationBenchmarkHistory` carries the audit trail with
 * a `'session'` source.
 */

import type { SimulatorState } from '@/types/state';
import type { Workout } from '@/types/state';
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';
import type { SetRecord } from '@/guided/strength-controller';
import { STATION_DISPLAY, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import { getStationPercentile } from '@/calculations/hyrox-population';
import { appendStationTest, type HyroxFormat } from '@/calculations/hyrox-station-history';

/** Race-pace HYROX sessions whose best-round times may improve a benchmark.
 *  Technique (65% pace) and the assessment (RPE 4 walkthrough) are excluded. */
export function isRacePaceHyroxSession(t: string | undefined): boolean {
  return t === 'hyrox_station_density' || t === 'hyrox_brick';
}

/** Per-station outcome of a guided session, for the end-of-session summary. */
export interface StationSessionResult {
  station: HyroxStation;
  displayName: string;
  /** Fastest round recorded for this station this session (sec). */
  bestSec: number;
  /** Current user benchmark for the active format (sec), or null if none yet. */
  benchmarkSec: number | null;
  /** benchmarkSec − bestSec (positive = faster than the benchmark). Null when no benchmark. */
  deltaSec: number | null;
  /** "Faster than X%" of the field; null for non-race-pace sessions (not comparable). */
  percentile: number | null;
  /** Race-pace session AND time passes the sanity floor — may write the benchmark. */
  eligible: boolean;
  /** eligible AND (no benchmark yet, or best round beats the stored benchmark). */
  isImprovement: boolean;
}

/** A benchmark write that actually happened, for logging / the summary banner. */
export interface AppliedBenchmarkUpdate {
  station: HyroxStation;
  displayName: string;
  fromSec: number | null;
  toSec: number;
}

function currentFormat(s: SimulatorState): HyroxFormat {
  return (s.hyroxConfig?.format as HyroxFormat) ?? 'open_singles';
}

function isDoublesFormat(f: HyroxFormat): boolean {
  return f === 'open_doubles' || f === 'pro_doubles';
}

/** Format-aware current scalar benchmark for a station (null if none). */
function readBenchmark(s: SimulatorState, station: HyroxStation): number | null {
  const hx = s.hyroxConfig;
  if (!hx) return null;
  const slot = isDoublesFormat(currentFormat(s)) ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles;
  return slot?.[station] ?? hx.stationBenchmarks?.[station] ?? null;
}

/** A time below the elite (competitive) seed for a station is almost certainly a
 *  timing slip, not a real result — reject it as a benchmark candidate. Sourced
 *  bound (no invented number): the fastest band's seed time. */
function passesSanityFloor(station: HyroxStation, sec: number): boolean {
  const floor = STATION_SEED_TIMES_SEC.competitive[station];
  return floor == null || sec >= floor;
}

/** Best (fastest) round per station across all rounds. Skips run components and
 *  zero/invalid times. Records carry the original component index, so a station
 *  that appears once per round collapses to its single fastest round. */
function bestRoundPerStation(components: HyroxComponent[], records: SetRecord[]): Map<HyroxStation, number> {
  const out = new Map<HyroxStation, number>();
  for (const r of records) {
    const c = components[r.exerciseIndex];
    if (!c || c.type === 'run') continue;
    const station = c.type as HyroxStation;
    if (!STATION_DISPLAY[station]) continue;
    const sec = Math.round(r.durationSec);
    if (sec <= 0) continue;
    const prev = out.get(station);
    if (prev == null || sec < prev) out.set(station, sec);
  }
  return out;
}

/** One run leg of a brick session, for the end-of-session summary. Runs carry no
 *  benchmark (run fitness lives in VDOT/pace, tracked elsewhere) — we surface
 *  time + pace per round so the athlete can see fade across the brick. */
export interface RunLegResult {
  round: number;        // 1-based round this leg belonged to
  durationSec: number;
  distanceM: number;
  paceSecKm: number;
}

/**
 * Per-leg summary of the run components in a session, in round order. Empty for
 * station-only sessions (density / technique). Pure.
 */
export function summariseHyroxRuns(workout: Workout, records: SetRecord[]): RunLegResult[] {
  const components = ((workout as any).hyroxComponents ?? []) as HyroxComponent[];
  if (!components.length || !records.length) return [];
  const legs: RunLegResult[] = [];
  for (const r of records) {
    const c = components[r.exerciseIndex];
    if (!c || c.type !== 'run') continue;
    const distanceM = c.distanceM ?? 1000;
    const sec = Math.round(r.durationSec);
    if (sec <= 0 || distanceM <= 0) continue;
    legs.push({ round: r.setIndex + 1, durationSec: sec, distanceM, paceSecKm: Math.round(sec / (distanceM / 1000)) });
  }
  return legs.sort((a, b) => a.round - b.round);
}

/**
 * Per-station summary for a completed guided HYROX session: best round, current
 * benchmark, delta, percentile, and whether it is an eligible improvement. Pure
 * — reads state, writes nothing. Used by the end-of-session summary and by
 * `applyHyroxSessionBenchmarks`.
 */
export function summariseHyroxSession(
  workout: Workout,
  records: SetRecord[],
  state: SimulatorState,
): StationSessionResult[] {
  const components = ((workout as any).hyroxComponents ?? []) as HyroxComponent[];
  if (!components.length || !records.length) return [];
  const racePace = isRacePaceHyroxSession(workout.t);
  const best = bestRoundPerStation(components, records);

  const results: StationSessionResult[] = [];
  for (const [station, bestSec] of best) {
    const benchmarkSec = readBenchmark(state, station);
    const eligible = racePace && passesSanityFloor(station, bestSec);
    const isImprovement = eligible && (benchmarkSec == null || bestSec < benchmarkSec);
    results.push({
      station,
      displayName: STATION_DISPLAY[station].name,
      bestSec,
      benchmarkSec,
      deltaSec: benchmarkSec == null ? null : benchmarkSec - bestSec,
      percentile: racePace ? getStationPercentile(station, bestSec) : null,
      eligible,
      isImprovement,
    });
  }
  return results;
}

/**
 * Apply eligible improvements to `state.hyroxConfig` (PB-only / calibrate),
 * mirroring the benchmark-card write: scalar slot + history entry (source
 * `'session'`). Mutates state; the caller is responsible for `saveState()`.
 * Returns the writes that happened (empty when nothing improved).
 */
export function applyHyroxSessionBenchmarks(
  workout: Workout,
  records: SetRecord[],
  state: SimulatorState,
): AppliedBenchmarkUpdate[] {
  const hx = state.hyroxConfig;
  if (!hx) return [];
  const improvements = summariseHyroxSession(workout, records, state).filter(r => r.isImprovement);
  if (!improvements.length) return [];

  const format = currentFormat(state);
  const doubles = isDoublesFormat(format);
  const dateISO = new Date().toISOString().slice(0, 10);
  const applied: AppliedBenchmarkUpdate[] = [];

  for (const r of improvements) {
    if (doubles) {
      hx.stationBenchmarksDoubles = hx.stationBenchmarksDoubles ?? {};
      hx.stationBenchmarksDoubles[r.station] = r.bestSec;
    } else {
      hx.stationBenchmarksSingles = hx.stationBenchmarksSingles ?? {};
      hx.stationBenchmarksSingles[r.station] = r.bestSec;
    }
    hx.stationBenchmarkHistory = hx.stationBenchmarkHistory ?? {};
    hx.stationBenchmarkHistory[r.station] = appendStationTest(hx.stationBenchmarkHistory[r.station], {
      dateISO,
      sec: r.bestSec,
      source: 'session',
      format,
      proWeights: !!hx.benchmarksAtProWeights,
    });
    applied.push({ station: r.station, displayName: r.displayName, fromSec: r.benchmarkSec, toSec: r.bestSec });
  }
  return applied;
}
