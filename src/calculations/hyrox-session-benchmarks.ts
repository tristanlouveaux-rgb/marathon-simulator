/**
 * HYROX guided-session → station-benchmark learning.
 *
 * When the athlete completes a guided station session we capture a per-round
 * time for every station. This module turns those measured times into benchmark
 * improvements, following the "Manually-set Benchmarks Yield to Improvements"
 * rule (CLAUDE.md) and the science in SCIENCE_LOG §AP:
 *
 *  - Only **race-pace** sessions teach the benchmark (density, brick), and only
 *    over a full station: since lane H2b (generator v19) station sessions and
 *    bricks prescribe quarter-station sets (HyroxComponent.raceFraction 0.25),
 *    and a set time is not a station time, so those sets teach nothing until a
 *    full-station session (the race simulations of part 2) exists. Technique
 *    times are submaximal by design and never feed the benchmark. They are
 *    still surfaced in the session summary.
 *  - The candidate is the athlete's **best (fastest) round** for each station.
 *    It is measured under in-circuit fatigue, so it is a *conservative* proxy
 *    for a fresh single-station benchmark: beating the stored benchmark even
 *    while fatigued is strong, hard-to-fake evidence the benchmark is stale.
 *  - **PB-only**: a benchmark only ever improves (lower time) from a session; a
 *    slow day never degrades it. A station with no user benchmark yet is
 *    calibrated from the best round (better than the population estimate).
 *  - The stored benchmark is the one the forecast reads
 *    (resolveHyroxStationBenchmarks `sec`): per station from either format's
 *    slot, so a converted race split from the other format counts as the
 *    benchmark. A best round is one athlete's effort at the target's load
 *    tier, and `sec` is in those terms for every format: a doubles race split
 *    (the pair's time) ÷ the forecast's station ratio, and a value stored at
 *    the other weight regime (a Pro race split for an Open target) converted
 *    to the target's weights. The round is compared with that value to the
 *    whole second (hyroxCalibratedStationBenchmarks), the number the Stats
 *    ledger shows and the plan prescribes, so an improvement moves both
 *    faster, never slower, and a sub-second tie with a fractional converted
 *    value is not an improvement.
 *    Before (review 2026-10-13) only the target format's slot was read: for
 *    a singles athlete whose station times came from doubles race splits it
 *    held nothing, so any round passed as an improvement and a slower
 *    session time replaced the converted split in the forecast.
 *  - A best round is stored with the weights it was done at: proWeights is
 *    true when the target's solo loads are the Pro tier of the athlete's sex
 *    (hyroxSoloLoadsArePro: a Pro target, or a woman in Mixed Doubles, who
 *    trains at the pair's M-Open loads; the generators load stations at the
 *    target's tier), and the forecast reads a session entry's proWeights the
 *    way it reads a race split's.
 *  - A **sanity floor** (the station split's timing-slip fence in the
 *    results, hyroxStationLowerFenceSec) rejects implausibly fast times that
 *    are almost certainly a timing slip.
 *  - The percentile and the floor place the round in the athlete's singles
 *    field (hyroxSoloFrame). A round at Pro-tier loads in an Open field (a
 *    woman in Mixed Doubles: M-Open loads, Open Singles women field) converts
 *    to the field's loads first (hyroxSoloToFieldSec).
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
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { getStationPercentile } from '@/calculations/hyrox-population';
import {
  hyroxSoloFrameForState,
  hyroxSoloLoadsArePro,
  hyroxSoloToFieldSec,
  hyroxCohortLabel,
  hyroxStationLowerFenceSec,
  type HyroxResultsCohort,
} from '@/calculations/hyrox-results';
import { appendStationTest, type HyroxFormat } from '@/calculations/hyrox-station-history';
import { hyroxCalibratedStationBenchmarks } from '@/calculations/race-prediction.hyrox';

/** Race-pace HYROX sessions whose best-round times may improve a benchmark:
 *  race-pace station sessions, bricks and race simulations (lane H2b part
 *  2, whose full stations are the first station times a planned session
 *  holds). Technique and the assessment (RPE 4 walkthrough) are excluded. */
export function isRacePaceHyroxSession(t: string | undefined): boolean {
  return t === 'hyrox_station_density' || t === 'hyrox_brick' || t === 'hyrox_sim';
}

/** Per-station outcome of a guided session, for the end-of-session summary. */
export interface StationSessionResult {
  station: HyroxStation;
  displayName: string;
  /** Fastest round recorded for this station this session (sec). */
  bestSec: number;
  /** Current user benchmark, one athlete's time at the target's weights, to
   *  the whole second (hyroxCalibratedStationBenchmarks), or null when the
   *  station still uses the population seed. */
  benchmarkSec: number | null;
  /** benchmarkSec − bestSec (positive = faster than the benchmark). Null when no benchmark. */
  deltaSec: number | null;
  /** "Faster than X%" of the field's race splits at this station
   *  (getStationPercentile on the athlete's singles field, hyroxSoloFrame:
   *  own sex, the target's weight family; a best round is one athlete's time
   *  at the target's loads, converted to the field's loads when they differ).
   *  Null for non-race-pace sessions (not comparable). */
  percentile: number | null;
  /** Who the percentile compares against, e.g. "Open Singles women"; null
   *  with no percentile. */
  percentileCohort: string | null;
  /** Race-pace session AND time passes the sanity floor — may write the benchmark. */
  eligible: boolean;
  /** eligible AND (no benchmark yet, or best round beats the stored benchmark). */
  isImprovement: boolean;
  /** Every set of the station covered part of it (a quarter-station set):
   *  the times are set times, not station times. */
  partial: boolean;
}

/** True when every component of `station` in the session covers part of the
 *  station (raceFraction under 1). A component with no raceFraction (the
 *  assessment, a session generated before generator v19) is the full station. */
function isPartialStation(components: readonly HyroxComponent[], station: HyroxStation): boolean {
  const own = components.filter(c => c.type === station);
  return own.length > 0 && own.every(c => c.raceFraction != null && c.raceFraction < 1);
}

/** True when the station ran below race weight in the session (a beginner's
 *  load schedule, HyroxComponent.loadPct; lane H2b part 2: a beginner's half
 *  sim before the race-weight start): its time is no race time either. */
function isReducedLoadStation(components: readonly HyroxComponent[], station: HyroxStation): boolean {
  return components.some(c => c.type === station && c.loadPct != null);
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

/** Per station, the benchmark a best round is compared with: the forecast's
 *  resolved benchmark as one athlete's time at the target's weights, to the
 *  whole second the Stats ledger shows and the plan prescribes
 *  (hyroxCalibratedStationBenchmarks). Rounds are timed to the whole second, so
 *  a round of 307 against a converted 307.4 is a tie, not a 0 s improvement
 *  (review 2026-10-13). Stations on the population seed are absent. */
function soloBenchmarks(s: SimulatorState): Map<HyroxStation, number> {
  const out = new Map<HyroxStation, number>();
  for (const [station, sec] of Object.entries(hyroxCalibratedStationBenchmarks(s))) {
    if (sec != null) out.set(station as HyroxStation, sec);
  }
  return out;
}

/** A round below the station's timing-slip fence in the results is almost
 *  certainly a timing slip (e.g. h:mm:ss read as mm:ss), not a real result:
 *  reject it as a benchmark candidate. Sourced bound (no invented number):
 *  the station split's far-out lower fence in the athlete's singles cohort,
 *  the rule the results ingest uses to drop slipped splits
 *  (hyroxStationLowerFenceSec). Until lane H3b the floor was the
 *  competitive band's seed, which became the real median of the top 1% and
 *  would have rejected half of that 1%. */
function passesSanityFloor(station: HyroxStation, sec: number, cohort: HyroxResultsCohort): boolean {
  const floor = hyroxStationLowerFenceSec(station, cohort);
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

/** Compact recap of a completed guided session, stored on the logged activity
 *  (`GarminActual.hyroxSession`) so the activity-detail page can replay the same
 *  per-station best rounds + run legs. Pure. Null when there is nothing to show. */
export function buildHyroxSessionRecap(
  workout: Workout,
  records: SetRecord[],
): { rounds: number; stations: Array<{ station: HyroxStation; bestSec: number }>; runs: RunLegResult[] } | null {
  const components = ((workout as any).hyroxComponents ?? []) as HyroxComponent[];
  if (!components.length || !records.length) return null;
  const rounds = Math.max(1, Math.round((workout as any).hyroxRounds ?? 1));
  const stations = Array.from(bestRoundPerStation(components, records), ([station, bestSec]) => ({ station, bestSec }));
  const runs = summariseHyroxRuns(workout, records);
  if (!stations.length && !runs.length) return null;
  return { rounds, stations, runs };
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
  const benchmarks = soloBenchmarks(state);
  const frame = hyroxSoloFrameForState(state);
  const cohort = frame.field;

  const results: StationSessionResult[] = [];
  for (const [station, bestSec] of best) {
    const benchmarkSec = benchmarks.get(station) ?? null;
    // The round in the field's own terms (a Mixed woman's M-Open round at
    // W-Open loads), for the floor and the percentile.
    const fieldSec = hyroxSoloToFieldSec(station, bestSec, frame);
    // A set covering part of the station (lane H2b: quarter-station sets,
    // HyroxComponent.raceFraction) is no station time: a quarter of the
    // distance is not paced like the whole, so it neither teaches the
    // benchmark nor takes a percentile against race splits.
    const partial = isPartialStation(components, station);
    const comparable = racePace && !partial && !isReducedLoadStation(components, station);
    const eligible = comparable && passesSanityFloor(station, fieldSec, cohort);
    const isImprovement = eligible && (benchmarkSec == null || bestSec < benchmarkSec);
    results.push({
      station,
      displayName: STATION_DISPLAY[station].name,
      bestSec,
      benchmarkSec,
      deltaSec: benchmarkSec == null ? null : benchmarkSec - bestSec,
      percentile: comparable ? getStationPercentile(station, fieldSec, cohort) : null,
      percentileCohort: comparable ? hyroxCohortLabel(cohort) : null,
      eligible,
      isImprovement,
      partial,
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
      // The weights the round was done at: the generators load stations at
      // the target's tier (hyroxLoadTierForState), the Pro tier of the
      // athlete's sex for a Pro target and for a woman in Mixed Doubles.
      proWeights: hyroxSoloLoadsArePro(format, state.biologicalSex, hx.division),
    });
    applied.push({ station: r.station, displayName: r.displayName, fromSec: r.benchmarkSec, toSec: r.bestSec });
  }
  return applied;
}
