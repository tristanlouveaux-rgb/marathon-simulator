/**
 * HYROX session generators.
 *
 * Produces Workout objects for each HYROX session kind:
 *   - run_easy / run_tempo / run_intervals. Standalone run sessions
 *   - station_technique. 3 × circuit, technique focus, RPE 5
 *   - station_density. 2-station AMRAP, RPE 7
 *   - brick. N rounds: 1km run + station
 *   - mini_brick. N rounds: 500m run + erg (beginners)
 *
 * All generators return a Workout with:
 *   - `estimatedDurationMin` set from targetMinutes
 *   - `musculoTendonLoad` computed via mtl.ts
 *   - `hyroxComponents` for the detail view / card breakdown
 *   - `discipline` set to 'run' | 'station' | 'brick'
 */

import type { Workout } from '@/types/state';
import { fmtModelPaceKm } from '@/utils/format';
import type { AbilityBand, HyroxConfig, HyroxComponent, HyroxLoadTier, HyroxSessionSpec, HyroxStation, HyroxStrengthBlock } from '@/types/triathlon';
import { computeComponentMTL } from '@/calculations/mtl';
import { HYROX_EASY_ERG_TYPE } from './hyrox-easy-erg';
import { STATION_DISPLAY, HYROX_STATION_ORDER, stationExternalLoadKg, SLED_EXTERNAL_LOAD_FRACTION, WALL_BALL_TARGET_M } from '@/constants/hyrox-benchmarks';
import { hyroxStationSeedsAtTarget, hyroxSeedRunPaceSecKm, type HyroxSeedStateInput } from '@/calculations/hyrox-results';
import { HYROX_DEFAULT_LOAD_TIER, hyroxWallBallTargetM, isHyroxDoublesFormat } from '@/calculations/hyrox-division';
import {
  hyroxComponentAmount, hyroxComponentRounds, hyroxComponentSets, hyroxSessionDurationSec, hyroxSessionWorkSec, fmtAmount,
} from './hyrox-session-shape';
import {
  HYROX_STATION_SET_FRACTION, HYROX_STATION_FORMATS, HYROX_STATIONS_PER_SESSION, HYROX_BEGINNER_SLED_SETS,
  HYROX_ERG_DAMPER, HYROX_BRICK_FORMATS, hyroxStationSetAmount, hyroxStationRaceAmount, hyroxRaceLoadKg, hyroxDoublesSets,
  hyroxTechniqueSets, hyroxRacePaceSets, hyroxBrickStationRounds, isHyroxSled, HYROX_DOUBLES_STATION_SHARE, type HyroxBrickFormat,
} from './hyrox-station-dose';
import {
  ECCENTRIC_HEAVY_STATIONS, RACE_WEEK_EXCLUDED_STATIONS, hyroxTier,
  HYROX_INTERVAL_HR_FRACTION, HYROX_QUALITY_WARMUP_MIN, HYROX_QUALITY_COOLDOWN_MIN,
  HYROX_TEMPO_MIN_WORK_MIN, HYROX_EASY_RPE, HYROX_SESSION_WARMUP_MIN,
  type HyroxQualityFormat,
} from '@/constants/hyrox-constants';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RunParams {
  kind: 'run_easy' | 'run_tempo' | 'run_intervals';
  /** Easy runs and the taper tempo: the session length. A quality run with a
   *  `format` takes the format's own length. */
  targetMinutes: number;
  band: AbilityBand;
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  /** HYROX race pace (sec/km); the band seed pace when unset. */
  runPaceSecKm?: number;
  /** Quality-run format of a training week (HYROX_QUALITY_FORMATS). Unset for
   *  a taper or race-week tempo, which is sized by targetMinutes. */
  format?: HyroxQualityFormat;
  /** Threshold pace (sec/km) from the fitness model (s.pac.t, which follows
   *  s.lt) when the athlete has a real running-fitness signal. Unset: a tempo
   *  runs at HYROX race pace with no multiplier and is labelled race pace. */
  thresholdPaceSecKm?: number;
  /** The week's long run (an easy run named Long Run, `longRun: true`). */
  longRun?: boolean;
  /** Max HR (bpm) when known, to state the interval heart-rate target in bpm. */
  maxHR?: number;
  /** The athlete whose band seeds stand in for an untested station or an
   *  unset race pace: the planning field (Open Singles at their sex) at the
   *  target's loads (hyroxStationSeedsAtTarget, hyroxSeedRunPaceSecKm).
   *  Absent: the pooled Open Singles field. */
  seed?: HyroxSeedStateInput;
}

/** What a station session or brick prescribes beyond its structure (lane
 *  H2b). Every field is optional: absent, it follows the athlete in `seed`. */
interface HyroxPrescriptionParams {
  /** Prescribed load per loaded station, kg (the beginner load schedule,
   *  plan_engine.hyrox). Absent for a station: its race weight at `loadTier`
   *  (intermediate and advanced athletes train at race weight, sheet). */
  stationLoads?: Partial<Record<HyroxStation, number>>;
  /** Wall-ball target height (m); null names both. Absent: from `seed`
   *  (hyroxWallBallTargetM: biological sex, then the division pick). */
  wallBallTargetM?: number | null;
  /** Doubles: each partner trains half of every station (sheet). Absent: from
   *  `seed`'s format. */
  doubles?: boolean;
}

export interface StationParams extends HyroxPrescriptionParams {
  /** station_technique: the technique format; station_density: the
   *  race-pace format (the type name predates lane H2b). */
  kind: 'station_technique' | 'station_density';
  /** The longest the session may run (minutes): the week's share of its
   *  budget (plan_engine.hyrox). The dose is the sheet's; a smaller target
   *  takes whole rounds off it, never under MIN_CIRCUIT_ROUNDS (doubles: the
   *  technique dose). */
  targetMinutes: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
  /** Race week (technique circuits only): leave out RACE_WEEK_EXCLUDED_STATIONS. */
  raceWeek?: boolean;
  /** Station load tier (hyroxLoadTierForState) for the loads and the MTL
   *  external loads. Absent: HYROX_DEFAULT_LOAD_TIER. */
  loadTier?: HyroxLoadTier;
  /** The athlete whose band seeds stand in for an untested station or an
   *  unset race pace: the planning field (Open Singles at their sex) at the
   *  target's loads (hyroxStationSeedsAtTarget, hyroxSeedRunPaceSecKm).
   *  Absent: the pooled Open Singles field. */
  seed?: HyroxSeedStateInput;
  /** Race-pace sessions: the week's nominal size relative to the plan's peak
   *  week (its phase multiplier x the deload factor x the effort lever, ÷
   *  HYROX_PEAK_MULT), the volume progression (hyroxRacePaceSets). Absent: 1,
   *  the full race-pace dose. */
  doseFraction?: number;
  /** Race-pace sessions: the minutes the week's size gives the session (its
   *  share of the budget at the size the week is built at, under the
   *  ceilings' scale, without the target's 35-min floor). The race-pace sets
   *  step down until the session fits it, never under the technique dose, so
   *  the dose rides the acute:chronic guard and the ceilings that size the
   *  week. Absent: no limit. */
  doseMinutes?: number;
  /** Race-pace sessions: the forecast's weakest station
   *  (hyrox-weakest-link), held first when the athlete can train it. */
  weakest?: HyroxStation;
}

export interface BrickParams extends HyroxPrescriptionParams {
  /** brick: the tier brick (intermediate 4 x 800 m, advanced key brick 6 x
   *  800 m); mini_brick: the beginner brick (3 x 400 m), also the taper's
   *  downgraded brick, on ergs in a taper week. */
  kind: 'brick' | 'mini_brick';
  /** The longest the brick may run (minutes); whole rounds come off a longer
   *  brick, never under MIN_CIRCUIT_ROUNDS. */
  targetMinutes: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
  /** Station load tier (hyroxLoadTierForState) for the loads and the MTL
   *  external loads. Absent: HYROX_DEFAULT_LOAD_TIER. */
  loadTier?: HyroxLoadTier;
  /** The athlete whose band seeds stand in for an untested station or an
   *  unset race pace: the planning field (Open Singles at their sex) at the
   *  target's loads (hyroxStationSeedsAtTarget, hyroxSeedRunPaceSecKm).
   *  Absent: the pooled Open Singles field. */
  seed?: HyroxSeedStateInput;
  /** HYROX race pace (sec/km) for the brick's runs, as generateHyroxRun reads
   *  it; the band seed pace when unset. */
  runPaceSecKm?: number;
  /** The advanced peak secondary brick: 4 x 800 m easy into ergs, sleds or
   *  the farmers carry at technique effort, not a hard session
   *  (`hyroxLight`). */
  secondary?: boolean;
}

// ─── Station availability helpers ────────────────────────────────────────────

/** Stations available given gym equipment. Returns them in rotation order. */
export function availableStations(access: HyroxConfig['stationAccess']): HyroxStation[] {
  // Use race order as the canonical rotation base, filtering to available equipment.
  return HYROX_STATION_ORDER.filter(s => {
    if (s === 'ski_erg') return access.skiErg;
    if (s === 'row_erg') return access.rowErg;
    if (s === 'sled_push' || s === 'sled_pull') return access.sled !== 'never';
    return true; // burpee_broad_jumps, farmer_carry, sandbag_lunges, wall_balls always available
  });
}

/**
 * Pick N stations from the available set, rotating by slotIndex so each
 * session covers different stations across the week/phase.
 * In base phase, deprioritises eccentric-heavy stations (move them to later).
 */
function pickStations(
  access: HyroxConfig['stationAccess'],
  phase: 'base' | 'build' | 'peak' | 'taper',
  slotIndex: number,
  count: number,
  exclude: readonly HyroxStation[] = [],
): HyroxStation[] {
  let pool = availableStations(access);
  if (pool.length === 0) pool = ['row_erg', 'farmer_carry', 'wall_balls']; // safe fallback
  if (exclude.length > 0) pool = pool.filter(s => !exclude.includes(s));

  // In base phase, push eccentric-heavy stations to back so early sessions
  // build habit without the soreness risk.
  if (phase === 'base') {
    const light = pool.filter(s => !ECCENTRIC_HEAVY_STATIONS.includes(s));
    const heavy = pool.filter(s => ECCENTRIC_HEAVY_STATIONS.includes(s));
    pool = [...light, ...heavy];
  }

  const result: HyroxStation[] = [];
  const n = pool.length;
  for (let i = 0; i < count && i < n; i++) {
    result.push(pool[(slotIndex * count + i) % n]);
  }
  return result;
}

/**
 * Stations a race-week technique circuit can use: the athlete's stations minus
 * RACE_WEEK_EXCLUDED_STATIONS, in rotation order. A circuit needs at least
 * MIN_CIRCUIT_STATIONS of them; with fewer (no erg access) the race week has
 * no station circuit and the slot becomes an easy run (plan_engine.hyrox).
 */
export function raceWeekCircuitStations(access: HyroxConfig['stationAccess']): HyroxStation[] {
  return availableStations(access).filter(s => !RACE_WEEK_EXCLUDED_STATIONS.includes(s));
}

/** A station circuit has at least two stations; the beginner base-phase filter
 *  (generateStationTechnique) uses the same floor. */
export const MIN_CIRCUIT_STATIONS = 2;

/** Get seed time (sec) for a station and band, using user benchmark if
 *  available, else the band seed in the athlete's planning field at the
 *  target's loads (hyroxStationSeedsAtTarget). */
function stationSeedSec(
  station: HyroxStation,
  band: AbilityBand,
  benchmarks?: Partial<Record<HyroxStation, number>>,
  seed?: HyroxSeedStateInput,
): number {
  return benchmarks?.[station] ?? hyroxStationSeedsAtTarget(seed ?? {}, band)[station];
}

/** Format a station time as "m:ss", rounded to the whole second before the
 *  minute split, so 299.6 reads 5:00, never 4:60. */
function fmtSec(sec: number): string {
  const whole = Math.round(sec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format pace (sec/km) as "m:ss": the whole second with the minute carried
 *  (fmtModelPaceKm), so 299.6 reads 5:00, never 4:60. */
function fmtPace(secPerKm: number): string {
  return fmtModelPaceKm(secPerKm);
}

/**
 * The floor a cut takes a circuit or brick down to (rounds). The weekly MTL
 * cap (plan_engine.hyrox enforceMTLCap), the deload and taper caps and a small
 * week target cut rounds down to it, never below. In a station session a
 * round is one quarter-station set of each station, so 2 rounds is the
 * technique dose (0.5 x race volume, HYROX_STATION_FORMATS). A doubles
 * technique session is 1 round (half of every station, hyroxDoublesSets): it
 * starts under the floor and no cut takes a round from it.
 */
export const MIN_CIRCUIT_ROUNDS = 2;

/** The floor a cut takes this session to (rounds): MIN_CIRCUIT_ROUNDS, or a
 *  doubles station session's technique dose (1 round, half of every station).
 *  A brick's rounds are runs both partners run in full, so its floor stays. */
export function hyroxMinRounds(w: Pick<Workout, 't' | 'hyroxSpec'>): number {
  const station = w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density';
  return station && w.hyroxSpec?.doubles ? hyroxTechniqueSets(true) : MIN_CIRCUIT_ROUNDS;
}

// ─── Run session generator ────────────────────────────────────────────────────

/**
 * HYROX easy run pace (sec/km): race pace × 1.2, where race pace is the
 * athlete's HYROX run pace (`hyroxConfig.hyroxRunPaceSecKm`) or, without one,
 * the band seed pace. Race pace is already fatigued race pace from
 * HyroxDataLab. 20% slower is a physiologically reasonable easy training pace
 * (Maffetone; Seiler 2010). Prices easy runs and commute runs alike.
 */
export function hyroxEasyRunPaceSecKm(band: AbilityBand, runPaceSecKm?: number, seed?: HyroxSeedStateInput): number {
  return Math.round((runPaceSecKm ?? hyroxSeedRunPaceSecKm(seed ?? {}, band)) * 1.2);
}

/** Length of a standalone HYROX run (km): the sum of its run components.
 *  The single-run rule (Frandsen 2025, measured in distance) and the rule that
 *  no run is longer than the long run read this. */
export function hyroxRunLengthKm(w: Pick<Workout, 'hyroxComponents'>): number {
  return (w.hyroxComponents ?? []).filter(c => c.type === 'run')
    .reduce((sum, c) => sum + (c.distanceM ?? 0), 0) / 1000;
}

export function generateHyroxRun(params: RunParams): Workout {
  const { kind, targetMinutes, band, bodyWeightKg } = params;
  let dur = Math.round(targetMinutes);

  let name: string;
  let desc: string;
  let rpe: number;
  let mtlKind: 'run_easy' | 'run_tempo' | 'run_intervals';
  let distanceKm: number;
  // MTL per segment (mtl.ts computeComponentMTL is linear in minutes): warm-up,
  // cool-down and jog recoveries at the easy-run RPE, the work at the session
  // RPE, standing rest none. Before 2026-10-12 the whole session (warm-up and
  // cool-down included) carried the session RPE.
  let mtlSegments: Array<{ min: number; rpe: number; kind: 'run_easy' | 'run_tempo' | 'run_intervals' }> | null = null;

  const racePace = params.runPaceSecKm ?? hyroxSeedRunPaceSecKm(params.seed ?? {}, band);
  const easyPace = hyroxEasyRunPaceSecKm(band, params.runPaceSecKm, params.seed);
  const kmAt = (min: number, paceSecKm: number) => (min * 60) / paceSecKm;
  const round1 = (km: number) => Math.round(km * 10) / 10;
  const warm = HYROX_QUALITY_WARMUP_MIN;
  const cool = HYROX_QUALITY_COOLDOWN_MIN;
  // Tempo pace: the fitness model's threshold pace when the athlete has a real
  // running-fitness signal, otherwise HYROX race pace with no multiplier
  // (parameter sheet intervals.pace_source). The old race pace x 0.97
  // "threshold" had no source.
  const tempoPace = params.thresholdPaceSecKm ?? racePace;
  const tempoLabel = params.thresholdPaceSecKm != null ? 'threshold pace' : 'HYROX race pace';

  switch (kind) {
    case 'run_easy': {
      distanceKm = kmAt(dur, easyPace);
      if (params.longRun) {
        name = 'Long Run';
        desc = `${dur} min easy at ${fmtPace(easyPace)}/km (~${round1(distanceKm)} km). Zone 2, fully conversational. The week's longest run.`;
      } else {
        name = 'Easy Run';
        desc = `${dur} min easy at ${fmtPace(easyPace)}/km (~${round1(distanceKm)} km). Fully conversational: complete sentences are easy.`;
      }
      rpe = HYROX_EASY_RPE;
      mtlKind = 'run_easy';
      break;
    }
    case 'run_tempo': {
      const fmt = params.format?.kind === 'run_tempo' ? params.format : null;
      const tempoMin = fmt ? fmt.workMin : Math.max(HYROX_TEMPO_MIN_WORK_MIN, dur - (warm + cool));
      // The duration is what the description prescribes: warm-up, tempo work
      // and cool-down (a taper tempo sized under 25 min used to keep the
      // smaller number beside a 25-min prescription).
      dur = warm + tempoMin + cool;
      distanceKm = kmAt(warm + cool, easyPace) + kmAt(tempoMin, tempoPace);
      mtlSegments = [{ min: warm + cool, rpe: 4, kind: 'run_easy' }, { min: tempoMin, rpe: 7, kind: 'run_tempo' }];
      name = 'Tempo Run';
      desc = `${warm} min easy warm-up. ${tempoMin} min at ${tempoLabel} (~${fmtPace(Math.round(tempoPace))}/km), comfortably hard, short phrases only. ${cool} min easy cool-down.`;
      rpe = 7;
      mtlKind = 'run_tempo';
      break;
    }
    case 'run_intervals': {
      const fmt = params.format?.kind === 'run_intervals' ? params.format : null;
      if (fmt && fmt.target === 'race_pace') {
        // 1 km reps at HYROX race pace with standing rest (intermediate peak).
        // The sheet names goal race pace; the pace here is the athlete's
        // current HYROX run pace (hyroxRunPaceSecKm, the band seed without
        // one), so it is labelled HYROX race pace, as the no-signal tempo is
        // (review 2026-10-13). A goal pace from the target finish time is
        // an open question for the forecast lane.
        const repSec = fmt.repKm * racePace;
        dur = Math.round(warm + (fmt.reps * repSec) / 60 + (fmt.reps - 1) * fmt.recoveryMin + cool);
        distanceKm = kmAt(warm + cool, easyPace) + fmt.reps * fmt.repKm;
        mtlSegments = [{ min: warm + cool, rpe: 4, kind: 'run_easy' }, { min: (fmt.reps * repSec) / 60, rpe: 8, kind: 'run_intervals' }];
        desc = `${warm} min easy warm-up. ${fmt.reps} × ${fmt.repKm} km at HYROX race pace (~${fmtPace(Math.round(racePace))}/km), ${fmt.recoveryMin} min rest between reps. ${cool} min easy cool-down.`;
      } else {
        // Heart-rate reps with an easy jog between them (beginner and advanced
        // peak). Without a format (not reached by the plan engine) the
        // beginner peak format applies.
        const f = fmt && fmt.target === 'hr' ? fmt : { reps: 4, repMin: 3, recoveryMin: 3 };
        dur = warm + f.reps * f.repMin + (f.reps - 1) * f.recoveryMin + cool;
        // Distance estimate for the run rules: reps at tempo pace, jogs easy.
        distanceKm = kmAt(warm + cool + (f.reps - 1) * f.recoveryMin, easyPace) + kmAt(f.reps * f.repMin, tempoPace);
        mtlSegments = [
          { min: warm + cool + (f.reps - 1) * f.recoveryMin, rpe: 4, kind: 'run_easy' },
          { min: f.reps * f.repMin, rpe: 8, kind: 'run_intervals' },
        ];
        const bpm = params.maxHR && params.maxHR > 0 ? ` (~${Math.round(params.maxHR * HYROX_INTERVAL_HR_FRACTION)} bpm)` : '';
        desc = `${warm} min easy warm-up. ${f.reps} × ${f.repMin} min at about ${Math.round(HYROX_INTERVAL_HR_FRACTION * 100)}% of max HR${bpm}, ${f.recoveryMin} min easy jog between reps. ${cool} min easy cool-down.`;
      }
      name = 'Interval Run';
      rpe = 8;
      mtlKind = 'run_intervals';
      break;
    }
  }

  const mtl = mtlSegments
    ? mtlSegments.reduce((sum, seg) => sum + computeComponentMTL(seg.min, seg.rpe, seg.kind, undefined, bodyWeightKg), 0)
    : computeComponentMTL(dur, rpe, mtlKind, undefined, bodyWeightKg);
  const component: HyroxComponent = {
    type: 'run',
    distanceM: Math.round(distanceKm * 1000),
    durationSec: dur * 60,
    mtl,
  };

  return {
    n: name,
    d: desc,
    t: `hyrox_${kind}`,
    discipline: 'run',
    r: rpe,
    rpe,
    estimatedDurationMin: dur,
    musculoTendonLoad: mtl,
    hyroxComponents: [component],
    ...(params.longRun && kind === 'run_easy' ? { longRun: true } : {}),
  };
}

/**
 * The same station or brick session with fewer rounds (the weekly MTL cap,
 * plan_engine.hyrox enforceMTLCap). Cuts real volume: the component MTLs
 * scale with the rounds (MTL is linear in work minutes, mtl.ts
 * computeComponentMTL), the duration drops by the removed rounds' work and
 * rest, and the description's round count follows. Before 2026-10-12 the cap
 * scaled only the reported MTL numbers and left the session as prescribed.
 */
export function withHyroxRounds(w: Workout, rounds: number): Workout {
  const old = w.hyroxRounds ?? 0;
  if (!(old > 0) || !(rounds >= 1) || rounds >= old) return w;
  if (w.hyroxSpec) {
    // Lane H2b sessions: each component keeps the sets it holds in the first
    // `rounds` rounds (hyroxComponentSets), its MTL in proportion; a
    // component left with no set leaves. The duration and the description
    // come from the session again.
    const comps = (w.hyroxComponents ?? [])
      .map(c => {
        const before = hyroxComponentSets(c, old);
        const after = hyroxComponentSets(c, rounds);
        return {
          ...c,
          mtl: before > 0 ? (c.mtl * after) / before : 0,
          ...(c.inRounds ? { inRounds: c.inRounds.filter(r => r <= rounds) } : {}),
        };
      })
      .filter(c => hyroxComponentSets(c, rounds) > 0);
    return finishHyroxSession({ ...w, hyroxComponents: comps, hyroxRounds: rounds });
  }
  const f = rounds / old;
  const comps = (w.hyroxComponents ?? []).map(c => ({ ...c, mtl: c.mtl * f }));
  const mtl = comps.reduce((sum, c) => sum + c.mtl, 0);
  const n = comps.length;
  const perRoundSec = comps.reduce((sum, c) => sum + (c.durationSec ?? 0), 0)
    + Math.max(0, n - 1) * (comps[0]?.restAfterSec ?? 0)
    + (w.hyroxRoundRestSec ?? 0);
  const est = Math.max(1, Math.round((w.estimatedDurationMin ?? 0) - ((old - rounds) * perRoundSec) / 60));
  return {
    ...w,
    hyroxComponents: comps,
    musculoTendonLoad: mtl,
    hyroxRounds: rounds,
    estimatedDurationMin: est,
    d: (w.d ?? '').replace(/^\d+ rounds/, `${rounds} rounds`),
  };
}

/**
 * The same station circuit without one of its stations (the weekly MTL cap,
 * plan_engine.hyrox enforceMTLCap, once every session is at
 * MIN_CIRCUIT_ROUNDS). Cuts real volume: the station's component leaves, the
 * duration drops by its work and the rest after it in every round, the MTL is
 * the sum of what is left, and the station leaves the description's list. A
 * circuit keeps at least MIN_CIRCUIT_STATIONS stations; a brick or a session
 * without the station is returned unchanged.
 */
export function withoutHyroxStation(w: Workout, station: HyroxStation): Workout {
  if (w.t !== 'hyrox_station_technique' && w.t !== 'hyrox_station_density') return w;
  const comps = w.hyroxComponents ?? [];
  const idx = comps.findIndex(c => c.type === station);
  const stationCount = comps.filter(c => c.type !== 'run').length;
  if (idx < 0 || stationCount <= MIN_CIRCUIT_STATIONS) return w;
  const removed = comps[idx];
  const rest = comps.filter((_, i) => i !== idx);
  if (w.hyroxSpec) {
    // Lane H2b sessions: the rounds shrink to the last round a station left
    // still holds (a beginner's sleds taking 4 rounds against 2 for the
    // others); the duration and the description come from the session again.
    const old = w.hyroxRounds ?? 1;
    const rounds = Math.max(1, ...rest.map(c => {
      const rs = hyroxComponentRounds(c, old);
      return rs.length > 0 ? rs[rs.length - 1] : 0;
    }));
    const { weakest: _weakest, ...unled } = w.hyroxSpec;
    const spec = w.hyroxSpec.weakest === station ? unled : w.hyroxSpec;
    return finishHyroxSession({ ...w, hyroxComponents: rest, hyroxRounds: rounds, hyroxSpec: spec });
  }
  const rounds = Math.max(1, w.hyroxRounds ?? 1);
  const cutSec = rounds * ((removed.durationSec ?? 0) + (removed.restAfterSec ?? 0));
  const mtl = rest.reduce((sum, c) => sum + c.mtl, 0);
  const name = STATION_DISPLAY[station].name;
  // The station list sits between "N rounds: " and the first ". "; its entries
  // are "Name (...)" joined by " + " (technique) or " → " (density).
  const m = /^(\d+ rounds: )(.*?)(\. .*)$/.exec(w.d ?? '');
  let d = w.d ?? '';
  if (m) {
    const sep = m[2].includes(' → ') ? ' → ' : ' + ';
    const kept = m[2].split(sep).filter(line => !line.startsWith(`${name} (`));
    d = `${m[1]}${kept.join(sep)}${m[3]}`;
  }
  return {
    ...w,
    hyroxComponents: rest,
    musculoTendonLoad: mtl,
    estimatedDurationMin: Math.max(1, Math.round((w.estimatedDurationMin ?? 0) - cutSec / 60)),
    d,
  };
}

/**
 * The same station session with every set of each station cut to
 * `fractionOf(station)` of its amount (null or 1 or more: kept whole; 0 or
 * less: none), rounded down to a whole metre or rep (a set with no amount:
 * its time, to the whole second). Each set's time, the station's MTL (its
 * component total) and each set's share of the race volume follow in
 * proportion, so a set never runs above its share (the injury gates,
 * applyHyroxInjuryGates: every set at its side's capacity share, as a run
 * keeps the run capacity's share of its duration). A station left with no
 * whole metre or rep leaves the session, its rounds shrinking to the last
 * round a station left still holds (withoutHyroxStation's rule). Its MTL,
 * duration and text again; the session itself when nothing is cut.
 */
export function withHyroxPartialSets(w: Workout, fractionOf: (st: HyroxStation) => number | null): Workout {
  if (!w.hyroxSpec) return w;
  const old = Math.max(1, w.hyroxRounds ?? 1);
  let cut = false;
  const comps: HyroxComponent[] = [];
  for (const c of w.hyroxComponents ?? []) {
    const fraction = c.type === 'run' ? null : fractionOf(c.type as HyroxStation);
    if (fraction == null || fraction >= 1 || hyroxComponentSets(c, old) < 1) { comps.push(c); continue; }
    cut = true;
    const reps = typeof c.reps === 'number';
    const was = reps ? (c.reps as number) : (c.distanceM ?? 0);
    const sec = c.durationSec ?? 0;
    const amount = was > 0 ? Math.floor(was * Math.max(0, fraction) + 1e-9) : 0;
    const ratio = was > 0 ? amount / was : sec > 0 ? Math.floor(sec * Math.max(0, fraction) + 1e-9) / sec : 0;
    if (!(ratio > 0)) continue;
    comps.push({
      ...c,
      ...(was > 0 ? (reps ? { reps: amount } : { distanceM: amount }) : {}),
      durationSec: Math.floor(sec * ratio + 1e-9),
      mtl: c.mtl * ratio,
      ...(c.raceFraction != null ? { raceFraction: c.raceFraction * ratio } : {}),
    } as HyroxComponent);
  }
  if (!cut) return w;
  const left = new Set(comps.map(c => c.type));
  const rounds = Math.max(1, ...comps.map(c => {
    const rs = hyroxComponentRounds(c, old);
    return rs.length > 0 ? rs[rs.length - 1] : 0;
  }));
  const { weakest: _weakest, ...unled } = w.hyroxSpec;
  const spec = w.hyroxSpec.weakest && !left.has(w.hyroxSpec.weakest) ? unled : w.hyroxSpec;
  return finishHyroxSession({ ...w, hyroxComponents: comps, hyroxRounds: Math.min(old, rounds), hyroxSpec: spec });
}

/** The erg an easy erg session runs on (generateHyroxEasyErg's text), or
 *  null for any other session. */
export function hyroxEasyErgStation(w: Workout): HyroxStation | null {
  if (w.t !== HYROX_EASY_ERG_TYPE) return null;
  return (['ski_erg', 'row_erg'] as HyroxStation[]).find(st => (w.d ?? '').includes(`easy on the ${STATION_DISPLAY[st].name}.`)) ?? null;
}

/**
 * The same station session or brick with no station loaded above `loads`
 * (kg per station): a deload or taper week that repeats the reference week's
 * session takes its own week's beginner loads, never the heavier loads the
 * reference week held (Tristan 2026-10-20). Each lowered component's MTL is
 * recomputed at its new external load (stationComponent's rule); a session
 * without lane H2b components, or with nothing to lower, is returned
 * unchanged.
 */
export function withHyroxStationLoads(
  w: Workout, loads: Partial<Record<HyroxStation, number>> | undefined, loadTier: HyroxLoadTier, bodyWeightKg?: number,
): Workout {
  if (!loads || !w.hyroxSpec) return w;
  const rounds = Math.max(1, w.hyroxRounds ?? 1);
  let changed = false;
  const comps = (w.hyroxComponents ?? []).map(c => {
    if (c.type === 'run' || c.loadKg == null) return c;
    const st = c.type as HyroxStation;
    const cap = loads[st];
    if (cap == null || cap >= c.loadKg - 1e-9) return c;
    changed = true;
    const race = hyroxRaceLoadKg(st, loadTier);
    const externalKg = isHyroxSled(st) ? cap * SLED_EXTERNAL_LOAD_FRACTION : cap;
    const minutes = ((c.durationSec ?? 0) / 60) * hyroxComponentSets(c, rounds);
    const { loadPct: _pct, ...rest } = c;
    return {
      ...rest,
      loadKg: cap,
      ...(race != null && cap < race - 1e-9 ? { loadPct: cap / race } : {}),
      mtl: computeComponentMTL(minutes, w.rpe ?? w.r ?? 5, st, externalKg, bodyWeightKg),
    };
  });
  return changed ? finishHyroxSession({ ...w, hyroxComponents: comps }) : w;
}

// ─── Easy erg session ─────────────────────────────────────────────────────────

export { HYROX_EASY_ERG_TYPE, isHyroxEasyErg } from './hyrox-easy-erg';

/** The ergs an athlete can use for easy erg work, in alternation order. */
function easyErgStations(access: HyroxConfig['stationAccess']): HyroxStation[] {
  const avail = availableStations(access);
  return (['ski_erg', 'row_erg'] as HyroxStation[]).filter(s => avail.includes(s));
}

/** MTL per minute of the athlete's heaviest easy erg (the weekly MTL cap sizes
 *  easy erg work with it), or null without erg access. */
export function hyroxEasyErgMtlPerMin(access: HyroxConfig['stationAccess'], bodyWeightKg?: number): number | null {
  const ergs = easyErgStations(access);
  if (ergs.length === 0) return null;
  // Ergs carry no external load at any load tier (stationExternalLoadKg).
  return Math.max(...ergs.map(s => computeComponentMTL(1, HYROX_EASY_RPE, s, undefined, bodyWeightKg)));
}

/** Parameters of an easy erg session. */
export interface EasyErgParams {
  targetMinutes: number;
  stationAccess: HyroxConfig['stationAccess'];
  /** Alternates the SkiErg and the row erg across a plan's sessions. */
  slotIndex: number;
  bodyWeightKg?: number;
}

/**
 * Easy erg session: continuous easy work on the SkiErg or the row erg (the
 * athlete's ergs only, alternating by slot), at the easy RPE
 * (HYROX_EASY_RPE). The parameter sheet's split.running_share row sends the
 * hours the running share and the station sessions leave unprescribed to easy
 * erg work, not to more running (Brandt 2025, n=11, suggests swapping some
 * running for rowing or SkiErg; untested). Aerobic volume with no running
 * impact: no eccentric station, not a hard session. MTL from mtl.ts at the
 * erg's own factors. Returns null without erg access. Planning side.
 */
export function generateHyroxEasyErg(p: EasyErgParams): Workout | null {
  const ergs = easyErgStations(p.stationAccess);
  if (ergs.length === 0) return null;
  const station = ergs[Math.abs(p.slotIndex) % ergs.length];
  const dur = Math.max(1, Math.round(p.targetMinutes));
  // Ergs carry no external load at any load tier (stationExternalLoadKg).
  const mtl = computeComponentMTL(dur, HYROX_EASY_RPE, station, undefined, p.bodyWeightKg);
  return {
    n: 'Easy Erg',
    d: `${dur} min easy on the ${STATION_DISPLAY[station].name}. Conversational effort (RPE ${HYROX_EASY_RPE}). Aerobic volume without running impact.`,
    t: HYROX_EASY_ERG_TYPE,
    // Its own discipline (decision D, Tristan 2026-10-13): every surface that
    // counts station sessions by discipline leaves it out.
    discipline: 'erg',
    r: HYROX_EASY_RPE,
    rpe: HYROX_EASY_RPE,
    estimatedDurationMin: dur,
    musculoTendonLoad: mtl,
    // No hyroxComponents: it is one continuous time-defined block, not a
    // station set. Components would route it to the guided station player
    // (one 1000 m SkiErg set) and the session recap would file its full
    // length as a station time.
  };
}

// ─── Station session generators ───────────────────────────────────────────────

/** An easy pass over a station takes 1.2 x its race split: the week-1
 *  assessment's existing estimate (RPE 4). A technique set (RPE 5, controlled
 *  pace, no time target) reuses it as its duration estimate: a technique set
 *  is slower than race pace, never faster (the old circuit's 0.65 x the seed
 *  time sat faster than race pace at RPE 5). */
export const HYROX_EASY_PASS_TIME_FACTOR = 1.2;

const DOUBLES_LINE = 'Doubles: half of every station, each partner\'s share of the race.';

/** Rest as copy: "2 min", "90 s", "30 s". */
function fmtRestPhrase(sec: number): string {
  return sec >= 60 && sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`;
}

/** "rounds 1 and 3", "rounds 1, 3 and 5", "round 2". */
function roundsPhrase(rs: readonly number[]): string {
  if (rs.length === 1) return `round ${rs[0]}`;
  return `rounds ${rs.slice(0, -1).join(', ')} and ${rs[rs.length - 1]}`;
}

/**
 * Which rounds of a station session hold which stations, when not every
 * station runs every round (a beginner technique session's sleds take 4
 * single-lane sets while the other stations take 2, HyroxComponent.inRounds):
 * "Rounds 1 and 2: every station. Rounds 3 and 4: Sled Push and Sled Pull
 * only." Null when every station runs every round (lane H2b review).
 */
export function hyroxRoundsBreakdown(w: Pick<Workout, 'hyroxComponents' | 'hyroxRounds'>): string | null {
  const rounds = Math.max(1, w.hyroxRounds ?? 1);
  const stations = (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
  if (stations.every(c => hyroxComponentRounds(c, rounds).length === rounds)) return null;
  const inRound = (r: number) => stations.filter(c => hyroxComponentRounds(c, rounds).includes(r));
  const groups: Array<{ rs: number[]; held: HyroxComponent[] }> = [];
  for (let r = 1; r <= rounds; r++) {
    const held = inRound(r);
    const last = groups[groups.length - 1];
    if (last && last.held.length === held.length && last.held.every((c, i) => c === held[i])) last.rs.push(r);
    else groups.push({ rs: [r], held });
  }
  const names = (cs: HyroxComponent[]) => {
    const ns = cs.map(c => STATION_DISPLAY[c.type as HyroxStation].name);
    return ns.length === 1 ? ns[0] : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
  };
  return groups.map(g => {
    const which = roundsPhrase(g.rs);
    const what = g.held.length === stations.length ? 'every station' : g.held.length === 0 ? 'no station' : `${names(g.held)} only`;
    return `${which.charAt(0).toUpperCase()}${which.slice(1)}: ${what}.`;
  }).join(' ');
}

/** The wall-ball target as copy: "to 2.70 m", or both heights when unknown. */
function wallBallTargetPhrase(m: number | null): string {
  return m != null
    ? `to ${m.toFixed(2)} m`
    : `to ${WALL_BALL_TARGET_M.female.toFixed(2)} m (women) or ${WALL_BALL_TARGET_M.male.toFixed(2)} m (men)`;
}

/** A station component's load as copy: "152 kg incl. sled", "sled unloaded",
 *  "2 × 8 kg (50% of race weight)", "6 kg ball to 2.70 m". A fixed implement
 *  below race weight is a standard size (HYROX_IMPLEMENT_SIZES_KG), so the
 *  share named is the implement's own. Empty for a station with no load. */
function loadPhrase(c: HyroxComponent, wallBallTargetM: number | null): string {
  if (c.loadKg == null) return '';
  const st = c.type as HyroxStation;
  const kg = fmtAmount(c.loadKg);
  let core: string;
  if (st === 'sled_push' || st === 'sled_pull') core = c.loadKg <= 0 ? 'sled unloaded' : `${kg} kg incl. sled`;
  else if (st === 'farmer_carry') core = `2 × ${kg} kg`;
  else if (st === 'sandbag_lunges') core = `${kg} kg sandbag`;
  else core = `${kg} kg ball ${wallBallTargetPhrase(wallBallTargetM)}`;
  if (c.loadPct == null || c.loadKg <= 0) return core;
  return `${core} (${Math.round(c.loadPct * 100)}% of race weight)`;
}

/** A station component's prescription as copy, without the set count:
 *  "250 m, damper 6", "1 lane (12.5 m), 50 kg incl. sled (50% of race
 *  weight)", "25 reps, 6 kg ball to 3.00 m". */
function stationPrescription(c: HyroxComponent, spec: HyroxSessionSpec, withTarget: boolean): string {
  const st = c.type as HyroxStation;
  const parts = [hyroxComponentAmount(c)];
  if (st === 'ski_erg' || st === 'row_erg') parts.push(`damper ${HYROX_ERG_DAMPER}`);
  const load = loadPhrase(c, spec.wallBallTargetM);
  if (load) parts.push(load);
  else if (st === 'wall_balls') parts.push(`ball ${wallBallTargetPhrase(spec.wallBallTargetM)}`);
  if (withTarget && c.durationSec) parts.push(`about ${fmtSec(c.durationSec)} a set`);
  return parts.join(', ');
}

/**
 * The description of a lane H2b station session or brick, written from its
 * spec and components (one source: a cut of rounds or a station rewrites it
 * through finishHyroxSession).
 */
export function hyroxSessionText(w: Workout): string {
  const spec = w.hyroxSpec;
  if (!spec) return w.d ?? '';
  const comps = w.hyroxComponents ?? [];
  const rounds = Math.max(1, w.hyroxRounds ?? 1);
  const stations = comps.filter(c => c.type !== 'run');
  if (spec.format === 'technique' || spec.format === 'race_pace') {
    const tech = spec.format === 'technique';
    const head = tech
      ? `Technique at RPE ${w.rpe}: smooth, repeatable movement, no time target.`
      : `Race pace at RPE ${w.rpe}: every set at or just above race pace.`;
    // Not every station in every round (a beginner session's sleds): the
    // rounds say which stations they hold, so the header matches the lines.
    const breakdown = hyroxRoundsBreakdown(w);
    const shape = rounds === 1
      ? `1 round, one set of each station, ${fmtRestPhrase(spec.restSec)} rest after every set.`
      : breakdown
        ? `${rounds} rounds, ${fmtRestPhrase(spec.restSec)} rest after every set. ${breakdown}`
        : `${rounds} rounds, one set of each station a round, ${fmtRestPhrase(spec.restSec)} rest after every set.`;
    const lines = stations.map(c => `${STATION_DISPLAY[c.type as HyroxStation].name}: ${hyroxComponentSets(c, rounds)} × ${stationPrescription(c, spec, !tech)}.`);
    const weakest = spec.weakest && stations.some(c => c.type === spec.weakest)
      ? [`${STATION_DISPLAY[spec.weakest].name} is the forecast's weakest station.`]
      : [];
    // Part 2: the warm-up and the strength block first, the finisher last.
    // With no warm-up left (the injury gates), round 1 at easy effort is it.
    const opening = [
      ...(spec.warmup ? [warmupPhrase(spec.warmup)] : spec.warmupRound ? [`Warm-up: round 1 at easy effort (RPE ${HYROX_EASY_RPE}).`] : []),
      ...(spec.strength ? [`Strength first (${spec.strength.min} min, RPE ${spec.strength.rpe}${spec.strength.light ? ', light' : ''}): ${strengthBlockPhrase(spec.strength)}.`] : []),
      ...(spec.warmup || spec.strength ? ['Then the stations.'] : []),
    ];
    const closing = spec.finisher
      ? [`Finisher: ${spec.finisher.min} min easy on the ${STATION_DISPLAY[spec.finisher.station].name} (RPE ${HYROX_EASY_RPE}).`]
      : [];
    return [...opening, head, shape, ...lines, ...weakest, ...(spec.doubles ? [DOUBLES_LINE] : []), ...closing].join(' ');
  }
  if (spec.format === 'race_sim') {
    const pace = spec.runPaceSecKm != null ? ` (~${fmtPace(Math.round(spec.runPaceSecKm))}/km)` : '';
    const full = spec.simKind === 'full';
    const effort = spec.runEffort === 'race_no_faster'
      ? 'Controlled effort, no faster than race pace.'
      : 'Race effort: treat it as data on pacing, not as a race.';
    const list = stations.map(c => `${STATION_DISPLAY[c.type as HyroxStation].name} ${stationPrescription(c, spec, false)}`).join('; ');
    return [
      ...(spec.warmup ? [warmupPhrase(spec.warmup)] : []),
      `${full ? 'Full' : 'Half'} race simulation: ${rounds} rounds of 1 km at HYROX race pace${pace}, each into the next station at ${spec.doubles ? 'your half of its race volume' : 'its full race volume'}: ${list}.`,
      `A ${spec.transitionSec ?? 0} s jog into each station, no other rest.`,
      effort,
      ...(spec.doubles ? [DOUBLES_LINE] : []),
    ].join(' ');
  }
  // Bricks.
  const pace = spec.runPaceSecKm != null ? `~${fmtPace(Math.round(spec.runPaceSecKm))}/km` : '';
  const run = `${fmtAmount(spec.runM ?? 0)} m`;
  const runPhrase = spec.runEffort === 'easy' ? `${run} easy${pace ? ` (${pace})` : ''}`
    : spec.runEffort === 'race_no_faster' ? `${run} at HYROX race pace${pace ? ` (${pace})` : ''}, no faster`
      : spec.runEffort === 'race_or_faster' ? `${run} at HYROX race pace${pace ? ` (${pace})` : ''} or faster, the last rounds fastest (negative split)`
        : `${run} at HYROX race pace${pace ? ` (${pace})` : ''}`;
  const jog = spec.transitionSec ? `, a ${spec.transitionSec} s jog to the station` : '';
  const secondary = spec.format === 'secondary_brick';
  const effort = secondary ? ` at technique effort (RPE ${w.rpe})` : '';
  const stationText = (c: HyroxComponent) => `${STATION_DISPLAY[c.type as HyroxStation].name} ${stationPrescription(c, spec, false)}`;
  const own = (c: HyroxComponent) => hyroxComponentRounds(c, rounds);
  const everyRound = (c: HyroxComponent) => own(c).length === rounds;
  const stationPart = stations.length === 1 && everyRound(stations[0])
    ? `then ${stationText(stations[0])}${effort}.`
    : stations.length === 1
      ? `then ${stationText(stations[0])}${effort} in ${roundsPhrase(own(stations[0]))}.`
      : `then the station${effort}, alternating: ${stations.map(c => `${stationText(c)} (${roundsPhrase(own(c))})`).join('; ')}.`;
  const covered = new Set(stations.flatMap(own));
  const partnerTurn = covered.size < rounds;
  const rest = (w.hyroxRoundRestSec ?? 0) > 0
    ? `${fmtRestPhrase(w.hyroxRoundRestSec ?? 0)} rest between rounds.`
    : 'No rest beyond the jog.';
  return [
    ...(spec.warmup ? [warmupPhrase(spec.warmup)] : []),
    `${rounds} rounds: ${runPhrase}${jog}, ${stationPart}`,
    rest,
    ...(secondary ? ['A lighter flow, not a hard session.'] : []),
    ...(spec.doubles ? [partnerTurn ? `${DOUBLES_LINE} Rounds without a station are the partner's turn.` : DOUBLES_LINE] : []),
  ].join(' ');
}

/** One station's line for a session view (detail modal, card): "2 × 250 m,
 *  damper 6", "4 × 1 lane (12.5 m), sled unloaded"; race pace adds the set
 *  target unless the view shows it apart (`withTarget` false). A component
 *  generated before generator v19 shows its amount. */
export function hyroxStationRowText(c: HyroxComponent, w: Workout, withTarget = true): string {
  const sets = hyroxComponentSets(c, Math.max(1, w.hyroxRounds ?? 1));
  if (!w.hyroxSpec) return hyroxComponentAmount(c);
  return `${sets} × ${stationPrescription(c, w.hyroxSpec, withTarget && w.hyroxSpec.format === 'race_pace')}`;
}

/** What a lane H2b station session adds below its stations: the weakest
 *  station, the doubles split (the description's closing sentences) and a
 *  load the athlete's rating raised (hyroxLoadStepNote). */
export function hyroxSessionNotes(w: Workout): string[] {
  const spec = w.hyroxSpec;
  if (!spec) return [];
  const out: string[] = [];
  if (spec.weakest && (w.hyroxComponents ?? []).some(c => c.type === spec.weakest)) out.push(`${STATION_DISPLAY[spec.weakest].name} is the forecast's weakest station.`);
  if (spec.doubles) out.push(DOUBLES_LINE);
  const step = hyroxLoadStepNote(w);
  if (step) out.push(step);
  return out;
}

/** One short note for a load the athlete's rating raised on this session
 *  (lane H2b part 2; adaptation transparency: a small change, a small note):
 *  "Load up after an easy rating: Sled Push 50 to 52.5 kg." Null without one. */
export function hyroxLoadStepNote(w: Workout): string | null {
  const steps = w.hyroxSpec?.loadSteps ?? [];
  if (steps.length === 0) return null;
  const parts = steps.map(s => `${STATION_DISPLAY[s.station].name} ${fmtAmount(s.fromKg)} to ${fmtAmount(s.toKg)} kg`);
  return `Load up after an easy rating: ${parts.join(', ')}.`;
}

/** A lane H2b session's MTL, duration and description from its components
 *  and the parts around them (part 2: the warm-up and the finisher carry
 *  easy-erg or easy-run MTL; the strength block carries none, mtl.ts has no
 *  strength factor). */
function finishHyroxSession(w: Workout): Workout {
  const comps = w.hyroxComponents ?? [];
  // Round 1 at the easy RPE as the warm-up (hyroxSpec.warmupRound): its
  // sets' MTL at that RPE (mtl.ts is linear in the RPE).
  const rounds = Math.max(1, w.hyroxRounds ?? 1);
  const rpe = w.rpe ?? w.r ?? 0;
  const easyCut = w.hyroxSpec?.warmupRound && rpe > HYROX_EASY_RPE
    ? comps.reduce((sum, c) => {
      const rs = hyroxComponentRounds(c, rounds);
      return sum + (rs.includes(1) ? (c.mtl / rs.length) * (1 - HYROX_EASY_RPE / rpe) : 0);
    }, 0)
    : 0;
  const out: Workout = {
    ...w,
    musculoTendonLoad: comps.reduce((sum, c) => sum + c.mtl, 0) - easyCut + (w.hyroxSpec?.warmup?.mtl ?? 0) + (w.hyroxSpec?.finisher?.mtl ?? 0),
    estimatedDurationMin: Math.max(1, Math.round(hyroxSessionDurationSec(w) / 60)),
  };
  out.d = hyroxSessionText(out);
  return out;
}

// ─── Session parts (lane H2b part 2) ─────────────────────────────────────────

/** Minutes of a session's station work (no warm-up, strength block or
 *  finisher): what the week's share and the race-pace dose fit. */
export function hyroxSessionWorkMin(w: Workout): number {
  return w.hyroxSpec ? hyroxSessionWorkSec(w) / 60 : (w.estimatedDurationMin ?? 0);
}

/**
 * The warm-up opening a station session or brick (HYROX_SESSION_WARMUP_MIN,
 * the existing run warm-up length): easy on one of the athlete's ergs (the
 * other one from the finisher's when both exist), or an easy jog without
 * one; a brick opens with a jog (`run`), its first leg a run. MTL from mtl.ts
 * at the easy RPE.
 */
export function hyroxSessionWarmup(
  access: HyroxConfig['stationAccess'], slotIndex: number, bodyWeightKg?: number, run = false,
): NonNullable<HyroxSessionSpec['warmup']> {
  const ergs = easyErgStations(access);
  const min = HYROX_SESSION_WARMUP_MIN;
  if (run || ergs.length === 0) return hyroxWarmupOn('run', min, bodyWeightKg);
  return hyroxWarmupOn(ergs[(Math.abs(slotIndex) + 1) % ergs.length], min, bodyWeightKg);
}

/** A warm-up of `min` minutes easy on `mode` (an erg, or a jog: `run`), MTL
 *  from mtl.ts at the easy RPE: the warm-up hyroxSessionWarmup opens a
 *  session with, and the one the injury gates move it to off a restricted
 *  side (applyHyroxInjuryGates). */
export function hyroxWarmupOn(
  mode: HyroxStation | 'run', min: number, bodyWeightKg?: number,
): NonNullable<HyroxSessionSpec['warmup']> {
  return { min, mode, mtl: computeComponentMTL(min, HYROX_EASY_RPE, mode === 'run' ? 'run_easy' : mode, undefined, bodyWeightKg) };
}

/** The same session with its warm-up, strength block and finisher set (null
 *  clears one; undefined keeps it) and round 1 as the warm-up or not
 *  (`warmupRound`: true sets it, false clears it), its MTL, duration and text
 *  again. */
export function withHyroxSessionParts(
  w: Workout, parts: {
    warmup?: HyroxSessionSpec['warmup'] | null; strength?: HyroxStrengthBlock | null; warmupRound?: boolean;
    finisher?: HyroxSessionSpec['finisher'] | null;
  },
): Workout {
  if (!w.hyroxSpec) return w;
  const spec: HyroxSessionSpec = { ...w.hyroxSpec };
  if (parts.warmup === null) delete spec.warmup; else if (parts.warmup) spec.warmup = parts.warmup;
  if (parts.warmupRound === true) spec.warmupRound = true; else if (parts.warmupRound === false) delete spec.warmupRound;
  if (parts.strength === null) delete spec.strength; else if (parts.strength) spec.strength = parts.strength;
  if (parts.finisher === null) delete spec.finisher; else if (parts.finisher) spec.finisher = parts.finisher;
  return finishHyroxSession({ ...w, hyroxSpec: spec });
}

/**
 * The same station session with an easy erg finisher of `minutes` (0 or
 * less clears it): continuous easy work on one of the athlete's ergs at the
 * easy RPE, the session's lever for the week's spare minutes (plan_engine
 * .hyrox). Without erg access, or for a session with no lane H2b spec, the
 * session is returned without one.
 */
export function withHyroxFinisher(
  w: Workout, minutes: number, access: HyroxConfig['stationAccess'], slotIndex: number, bodyWeightKg?: number,
): Workout {
  if (!w.hyroxSpec) return w;
  const ergs = easyErgStations(access);
  const min = Math.floor(minutes);
  if (min <= 0 || ergs.length === 0) {
    if (!w.hyroxSpec.finisher) return w;
    const { finisher: _f, ...spec } = w.hyroxSpec;
    return finishHyroxSession({ ...w, hyroxSpec: spec });
  }
  const station = ergs[Math.abs(slotIndex) % ergs.length];
  if (w.hyroxSpec.finisher?.min === min && w.hyroxSpec.finisher.station === station) return w;
  const mtl = computeComponentMTL(min, HYROX_EASY_RPE, station, undefined, bodyWeightKg);
  return finishHyroxSession({ ...w, hyroxSpec: { ...w.hyroxSpec, finisher: { min, station, mtl } } });
}

/** A strength block's exercises as copy: each line without its cue and rest
 *  notes ("4x5 Back Squat @80% 1RM"). */
function strengthBlockPhrase(b: HyroxStrengthBlock): string {
  return b.lines.map(l => l.replace(/\s*\([^)]*\)/g, '').trim()).filter(Boolean).join(', ');
}

/** The warm-up as copy: "Warm-up: 10 min easy on the Row." */
function warmupPhrase(wu: NonNullable<HyroxSessionSpec['warmup']>): string {
  return wu.mode === 'run'
    ? `Warm-up: ${wu.min} min easy jog.`
    : `Warm-up: ${wu.min} min easy on the ${STATION_DISPLAY[wu.mode].name}.`;
}

/** The athlete's prescription inputs: explicit params first, else the
 *  athlete in `seed`. */
function prescriptionOf(p: HyroxPrescriptionParams & { seed?: HyroxSeedStateInput }): { wallBallTargetM: number | null; doubles: boolean } {
  return {
    wallBallTargetM: p.wallBallTargetM !== undefined
      ? p.wallBallTargetM
      : hyroxWallBallTargetM(p.seed?.biologicalSex, p.seed?.hyroxConfig?.division),
    doubles: p.doubles ?? isHyroxDoublesFormat(p.seed?.hyroxConfig?.format),
  };
}

/**
 * One station component of a lane H2b session: `sets` quarter-station sets
 * (in `inRounds` when not every round), each `setSec` long, at the station's
 * prescribed load (`loadKg`; absent, race weight at the tier). MTL from
 * mtl.ts over every set's minutes at the session RPE, the external load the
 * prescribed one (sleds: SLED_EXTERNAL_LOAD_FRACTION of the sled total, the
 * rule stationExternalLoadKg applies to race weight; an unloaded sled carries
 * none here, its own mass unknown).
 */
function stationComponent(p: {
  station: HyroxStation;
  sets: number;
  inRounds?: number[];
  setSec: number;
  rpe: number;
  restAfterSec: number;
  loadTier: HyroxLoadTier;
  loadKg?: number;
  bodyWeightKg?: number;
}): HyroxComponent {
  const st = p.station;
  const amount = hyroxStationSetAmount(st);
  const race = hyroxRaceLoadKg(st, p.loadTier);
  const kg = race == null ? undefined : Math.min(race, p.loadKg ?? race);
  const externalKg = kg == null ? undefined : isHyroxSled(st) ? kg * SLED_EXTERNAL_LOAD_FRACTION : kg;
  const mtl = computeComponentMTL((p.setSec / 60) * p.sets, p.rpe, st, externalKg, p.bodyWeightKg);
  return {
    type: st,
    ...(st === 'wall_balls' ? { reps: amount } : { distanceM: amount }),
    durationSec: Math.round(p.setSec),
    mtl,
    restAfterSec: p.restAfterSec,
    raceFraction: HYROX_STATION_SET_FRACTION,
    ...(p.inRounds ? { inRounds: p.inRounds } : {}),
    ...(kg != null ? { loadKg: kg } : {}),
    ...(kg != null && race != null && kg < race - 1e-9 ? { loadPct: kg / race } : {}),
  };
}

/** The largest round count from `rounds` down to `floor` whose station work
 *  fits `targetMinutes`; `floor` when none does. */
function fitToTarget(w: Workout, targetMinutes: number, floor: number): Workout {
  let out = w;
  while ((out.hyroxRounds ?? 1) > floor && hyroxSessionWorkMin(out) > targetMinutes + 1e-9) {
    out = withHyroxRounds(out, (out.hyroxRounds ?? 1) - 1);
  }
  return out;
}

export function generateHyroxStation(params: StationParams): Workout {
  return params.kind === 'station_technique' ? generateStationTechnique(params) : generateStationRacePace(params);
}

/**
 * Technique station session (sheet technique.station_session): 0.5 x race
 * volume per station in quarter-station sets (2 sets; doubles 1), RPE 5, 2 min
 * rest after every set, one set of each station a round. Beginners: 4
 * stations rotated so each recurs every 2 weeks, none of the eccentric-heavy
 * stations in base (existing rule), sleds as 4 sets of one lane (doubles 2),
 * loads on the beginner schedule (`stationLoads`). Intermediate and advanced:
 * 3 stations at race weight. Race week leaves out the eccentric-heavy and sled
 * stations (RACE_WEEK_EXCLUDED_STATIONS). Replaces the old circuit: 2 to 4
 * rounds of the full race distance per station at 65% of the seed time,
 * faster than race pace, at RPE 5, plus an easy-run finish.
 */
function generateStationTechnique(p: StationParams): Workout {
  const tier = hyroxTier(p.band);
  const { wallBallTargetM, doubles } = prescriptionOf(p);
  const fmt = HYROX_STATION_FORMATS.technique;
  const loadTier = p.loadTier ?? HYROX_DEFAULT_LOAD_TIER;
  const raceExclude = p.raceWeek ? RACE_WEEK_EXCLUDED_STATIONS : [];
  const count = HYROX_STATIONS_PER_SESSION[tier];
  let stations = pickStations(p.stationAccess, p.phase, p.slotIndex, count, raceExclude);
  if (tier === 'beginner' && p.phase === 'base') {
    // No lunges, burpee broad jumps or wall balls in a beginner's base
    // (existing rule), kept whenever MIN_CIRCUIT_STATIONS others remain.
    const safe = pickStations(p.stationAccess, p.phase, p.slotIndex, count, [...raceExclude, ...ECCENTRIC_HEAVY_STATIONS]);
    if (safe.length >= MIN_CIRCUIT_STATIONS) stations = safe;
  }
  const baseSets = hyroxTechniqueSets(doubles);
  const sledSets = doubles ? hyroxDoublesSets(HYROX_BEGINNER_SLED_SETS) : HYROX_BEGINNER_SLED_SETS;
  const setsOf = (st: HyroxStation) => (tier === 'beginner' && isHyroxSled(st) ? sledSets : baseSets);
  const rounds = Math.max(...stations.map(setsOf));
  const components = stations.map(st => {
    const sets = setsOf(st);
    return stationComponent({
      station: st,
      sets,
      ...(sets < rounds ? { inRounds: Array.from({ length: sets }, (_, i) => i + 1) } : {}),
      setSec: stationSeedSec(st, p.band, p.stationBenchmarks, p.seed) * HYROX_STATION_SET_FRACTION * HYROX_EASY_PASS_TIME_FACTOR,
      rpe: fmt.rpe,
      restAfterSec: fmt.restSec,
      loadTier,
      loadKg: p.stationLoads?.[st],
      bodyWeightKg: p.bodyWeightKg,
    });
  });
  const w = finishHyroxSession({
    n: 'Station Circuit',
    d: '',
    t: 'hyrox_station_technique',
    discipline: 'station',
    r: fmt.rpe,
    rpe: fmt.rpe,
    hyroxComponents: components,
    hyroxRounds: rounds,
    hyroxRoundRestSec: fmt.restSec,
    hyroxSpec: { format: 'technique', restSec: fmt.restSec, wallBallTargetM, ...(doubles ? { doubles: true } : {}) },
  });
  return fitToTarget(w, p.targetMinutes, Math.min(rounds, hyroxMinRounds(w)));
}

/**
 * Race-pace station session (sheet technique.station_session): 3 stations,
 * the forecast's weakest first when the athlete can train it, at race weight,
 * RPE 7, 90 s rest after every set, each set at or just above race pace (the
 * race split pro rata, the set's target). Volume: the race-pace dose of the
 * week (hyroxRacePaceSets: 2 to 4 quarter-station sets as the week grows
 * toward peak, the full 1.0 x race volume at peak; doubles half). Replaces the
 * density circuit: 2 to 4 rounds of the full race volume at race pace (300
 * wall balls for an intermediate at 8 h a week).
 */
function generateStationRacePace(p: StationParams): Workout {
  const { wallBallTargetM, doubles } = prescriptionOf(p);
  const fmt = HYROX_STATION_FORMATS.race_pace;
  const loadTier = p.loadTier ?? HYROX_DEFAULT_LOAD_TIER;
  const count = HYROX_STATIONS_PER_SESSION[hyroxTier(p.band)];
  const avail = availableStations(p.stationAccess);
  const weakest = p.weakest && avail.includes(p.weakest) ? p.weakest : undefined;
  const stations = weakest
    ? [weakest, ...pickStations(p.stationAccess, p.phase, p.slotIndex, count - 1, [weakest])]
    : pickStations(p.stationAccess, p.phase, p.slotIndex, count);
  const sets = hyroxRacePaceSets(p.doseFraction ?? 1, doubles);
  const components = stations.map(st => stationComponent({
    station: st,
    sets,
    setSec: stationSeedSec(st, p.band, p.stationBenchmarks, p.seed) * HYROX_STATION_SET_FRACTION,
    rpe: fmt.rpe,
    restAfterSec: fmt.restSec,
    loadTier,
    loadKg: p.stationLoads?.[st],
    bodyWeightKg: p.bodyWeightKg,
  }));
  const w = finishHyroxSession({
    n: 'Race-Pace Stations',
    d: '',
    t: 'hyrox_station_density',
    discipline: 'station',
    r: fmt.rpe,
    rpe: fmt.rpe,
    hyroxComponents: components,
    hyroxRounds: sets,
    hyroxRoundRestSec: fmt.restSec,
    hyroxSpec: {
      format: 'race_pace', restSec: fmt.restSec, wallBallTargetM,
      ...(doubles ? { doubles: true } : {}),
      ...(weakest ? { weakest } : {}),
    },
  });
  // The week's size: race-pace sets step down to fit the minutes it gives
  // the session (doseMinutes), never under the technique dose.
  const techniqueSets = hyroxTechniqueSets(doubles);
  let sized = w;
  while ((sized.hyroxRounds ?? 1) > techniqueSets && p.doseMinutes != null && hyroxSessionWorkMin(sized) > p.doseMinutes + 1e-9) {
    sized = withHyroxRounds(sized, (sized.hyroxRounds ?? 1) - 1);
  }
  return fitToTarget(sized, p.targetMinutes, Math.min(sized.hyroxRounds ?? 1, hyroxMinRounds(sized)));
}

/** The station a cut takes out of a circuit (the MTL cap, the ceilings, the
 *  deload and taper caps): the heaviest by MTL, never a race-pace session's
 *  weakest station while another is left (the sheet's race-pace session
 *  includes the weakest). Null when the session holds no station. */
export function hyroxStationToCut(w: Workout): HyroxStation | null {
  const st = (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
  if (st.length === 0) return null;
  const pool = st.filter(c => c.type !== w.hyroxSpec?.weakest);
  return (pool.length > 0 ? pool : st).reduce((a, c) => (c.mtl > a.mtl ? c : a)).type as HyroxStation;
}

// ─── Brick session generators ─────────────────────────────────────────────────

/** Brick station priority (the existing build/peak order, research doc
 *  s4.5's high-impact discriminators first). */
const BRICK_STATION_PRIORITY: HyroxStation[] = ['wall_balls', 'sled_pull', 'sandbag_lunges', 'burpee_broad_jumps', 'farmer_carry', 'row_erg', 'ski_erg', 'sled_push'];

/** The secondary brick's stations: ergs, sleds or the farmers carry (sheet). */
const SECONDARY_BRICK_STATIONS: HyroxStation[] = ['row_erg', 'ski_erg', 'sled_push', 'sled_pull', 'farmer_carry'];

/** `n` stations from `pool` (the athlete's, in pool order), rotated by slot. */
function rotate(pool: readonly HyroxStation[], slotIndex: number, n: number): HyroxStation[] {
  const out: HyroxStation[] = [];
  for (let i = 0; i < n && i < pool.length; i++) out.push(pool[(Math.abs(slotIndex) * n + i) % pool.length]);
  return out;
}

/** A brick's stations in round order (the first takes round 1). */
function brickStations(p: BrickParams, format: HyroxBrickFormat): HyroxStation[] {
  const avail = availableStations(p.stationAccess);
  const has = (s: HyroxStation) => avail.includes(s);
  if (p.phase === 'taper' && (p.kind === 'mini_brick' || p.secondary)) {
    // A taper brick protects eccentric and heavy load: ergs, else the farmers
    // carry (the existing mini brick's stations).
    const ergs = (['row_erg', 'ski_erg'] as HyroxStation[]).filter(has);
    return ergs.length > 0 ? rotate(ergs, p.slotIndex, Math.min(format.stations, ergs.length)) : ['farmer_carry'];
  }
  if (p.secondary) {
    const pool = SECONDARY_BRICK_STATIONS.filter(has);
    return rotate(pool.length > 0 ? pool : avail, p.slotIndex, format.stations);
  }
  const pool = BRICK_STATION_PRIORITY.filter(has);
  if (format.eccentricStation) {
    const ecc = pool.filter(s => ECCENTRIC_HEAVY_STATIONS.includes(s));
    const other = pool.filter(s => !ECCENTRIC_HEAVY_STATIONS.includes(s));
    if (ecc.length > 0 && other.length > 0) return [rotate(ecc, p.slotIndex, 1)[0], rotate(other, p.slotIndex, 1)[0]];
  }
  return rotate(pool.length > 0 ? pool : avail, p.slotIndex, format.stations);
}

/**
 * Brick (sheet bricks.structure, HYROX_BRICK_FORMATS): rounds of a run then a
 * quarter-station dose (HYROX_STATION_SET_FRACTION) of one station, or of two
 * alternating rounds. Beginner (and the taper's downgraded brick, on ergs):
 * 3 x 400 m at goal race pace, no faster, loads on the beginner schedule.
 * Intermediate: 4 x 800 m at goal race pace, race weight. Advanced key brick:
 * 6 x 800 m at race pace or faster with a negative split, one eccentric
 * station, the 30 s jog only. Secondary brick (advanced peak): 4 x 800 m easy
 * into ergs, sleds or the farmers carry at technique effort, not a hard
 * session. Goal race pace is priced at the athlete's HYROX run pace (the band
 * seed without one), as the intermediate peak intervals are (a goal pace from
 * the target finish is an open question for the forecast lane). Doubles: each
 * station on every other one of its rounds (hyroxBrickStationRounds).
 * Replaces the full brick (2 to 6 rounds of 1 km plus the full station each
 * round: 6 x 100 wall balls at 8 h a week) and the mini brick (2 to 4 rounds
 * of 500 m plus a full 1,000 m erg).
 */
export function generateHyroxBrick(params: BrickParams): Workout {
  const p = params;
  const tier = hyroxTier(p.band);
  const format = p.secondary ? HYROX_BRICK_FORMATS.secondary
    : p.kind === 'mini_brick' ? HYROX_BRICK_FORMATS.beginner
      : HYROX_BRICK_FORMATS[tier];
  const { wallBallTargetM, doubles } = prescriptionOf(p);
  const loadTier = p.loadTier ?? HYROX_DEFAULT_LOAD_TIER;
  const stations = brickStations(p, format);
  const racePace = p.runPaceSecKm ?? hyroxSeedRunPaceSecKm(p.seed ?? {}, p.band);
  const easy = format.runEffort === 'easy';
  const runPace = easy ? hyroxEasyRunPaceSecKm(p.band, p.runPaceSecKm, p.seed) : racePace;
  const runSec = (format.runM / 1000) * runPace;
  const runRpe = easy ? HYROX_EASY_RPE : format.rpe;
  const run: HyroxComponent = {
    type: 'run',
    distanceM: format.runM,
    durationSec: Math.round(runSec),
    mtl: computeComponentMTL((runSec / 60) * format.rounds, runRpe, easy ? 'run_easy' : 'run_tempo', undefined, p.bodyWeightKg),
    restAfterSec: 0, // into the station after the transition jog, race-like
  };
  // A secondary brick runs at technique effort, so no station takes more
  // than the technique dose (0.5 x race volume, HYROX_STATION_FORMATS
  // .technique). With one usable station (no ergs and no sled: the farmers
  // carry alone) it keeps the first station's alternate rounds and the other
  // rounds run straight on; before, the one station took all 4 rounds, the
  // full race volume (lane H2b review).
  const lightSingle = !!p.secondary && stations.length === 1 && format.stations === 2;
  const alternation: 1 | 2 = stations.length > 1 || lightSingle ? 2 : 1;
  const stationComps = stations.map((st, i) => {
    const inRounds = hyroxBrickStationRounds(format.rounds, alternation, (i % 2) as 0 | 1, doubles);
    return stationComponent({
      station: st,
      sets: inRounds.length,
      ...(inRounds.length < format.rounds ? { inRounds } : {}),
      setSec: stationSeedSec(st, p.band, p.stationBenchmarks, p.seed) * HYROX_STATION_SET_FRACTION,
      rpe: format.rpe,
      restAfterSec: 0, // the last set of its round: the round rest follows
      loadTier,
      loadKg: p.stationLoads?.[st],
      bodyWeightKg: p.bodyWeightKg,
    });
  });
  const name = p.secondary ? 'Secondary Brick' : p.kind === 'mini_brick' ? 'Mini Brick' : 'HYROX Brick';
  const w = finishHyroxSession({
    n: name,
    d: '',
    t: p.kind === 'mini_brick' || p.secondary ? 'hyrox_mini_brick' : 'hyrox_brick',
    discipline: 'brick',
    r: format.rpe,
    rpe: format.rpe,
    hyroxComponents: [run, ...stationComps],
    hyroxRounds: format.rounds,
    hyroxRoundRestSec: format.roundRestSec,
    ...(p.secondary ? { hyroxLight: true } : {}),
    hyroxSpec: {
      format: p.secondary ? 'secondary_brick' : 'brick',
      restSec: format.roundRestSec,
      transitionSec: format.transitionSec,
      runM: format.runM,
      runPaceSecKm: runPace,
      runEffort: format.runEffort,
      wallBallTargetM,
      ...(doubles ? { doubles: true } : {}),
    },
  });
  return fitToTarget(w, p.targetMinutes, Math.min(format.rounds, MIN_CIRCUIT_ROUNDS));
}

// ─── Race simulations (lane H2b part 2) ──────────────────────────────────────

/** Parameters of a race simulation. */
export interface SimParams extends HyroxPrescriptionParams {
  /** The full race (8 x 1 km and the 8 stations) or a half (4 x 1 km and 4
   *  stations at 1.0 x). */
  kind: 'full' | 'half';
  /** Half sims alternate the race's first and second halves (0, 1, ...). */
  halfIndex?: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
  loadTier?: HyroxLoadTier;
  seed?: HyroxSeedStateInput;
  /** HYROX race pace (sec/km) for the 1 km runs; the band seed without one. */
  runPaceSecKm?: number;
}

/** Transition between a run and its station in a race simulation (s): the
 *  bricks' existing 30 s jog (HYROX_BRICK_FORMATS transitionSec). */
const SIM_TRANSITION_SEC = HYROX_BRICK_FORMATS.beginner.transitionSec;

/**
 * Race simulation (parameter sheet sims.schedule, revised): rounds of a 1 km
 * run at HYROX race pace into the next station of the race at its full race
 * volume, in race order; the full sim is the 8 runs and 8 stations, a half
 * sim 4 and 4 (the race's first half, then its second half the next time),
 * at 1.0 x race volume. Race weight, except a beginner's half sim before the
 * race-weight start, which takes the week's beginner loads (`stationLoads`;
 * sheet: technique-schedule loads until the race-weight start). The 30 s jog
 * into each station is counted (the bricks' transition), no other rest. The
 * effort: beginners steady race effort (a half sim controlled, no faster than
 * race pace), intermediate and advanced race effort; RPE the tier brick's
 * (HYROX_BRICK_FORMATS: 6 beginner, 7 intermediate and advanced, the
 * existing brick values; a product choice, the sheet gives no sim RPE). A
 * station the athlete cannot train is left out and its run continues. Doubles:
 * each partner trains half of every station, said once; the station's amount,
 * time and MTL are the partner's half (raceFraction 0.5), so a doubles sim
 * teaches no station benchmark. A singles sim's stations are full stations,
 * so a guided sim at race weight can teach the station benchmarks
 * (hyrox-session-benchmarks). Planning side.
 */
export function generateHyroxSim(p: SimParams): Workout {
  const tier = hyroxTier(p.band);
  const { wallBallTargetM, doubles } = prescriptionOf(p);
  const loadTier = p.loadTier ?? HYROX_DEFAULT_LOAD_TIER;
  const avail = availableStations(p.stationAccess);
  const order = p.kind === 'full'
    ? HYROX_STATION_ORDER
    : (Math.abs(p.halfIndex ?? 0) % 2 === 0 ? HYROX_STATION_ORDER.slice(0, 4) : HYROX_STATION_ORDER.slice(4));
  const stations = order.filter(st => avail.includes(st));
  const rounds = order.length;
  const rpe = HYROX_BRICK_FORMATS[tier].rpe;
  const racePace = p.runPaceSecKm ?? hyroxSeedRunPaceSecKm(p.seed ?? {}, p.band);
  const runSec = racePace;
  const run: HyroxComponent = {
    type: 'run',
    distanceM: 1000,
    durationSec: Math.round(runSec),
    mtl: computeComponentMTL((runSec / 60) * rounds, rpe, 'run_tempo', undefined, p.bodyWeightKg),
    restAfterSec: 0,
  };
  const stationComps: HyroxComponent[] = stations.map(st => {
    const round = order.indexOf(st) + 1;
    const race = hyroxRaceLoadKg(st, loadTier);
    const own = p.stationLoads?.[st];
    const kg = race == null ? undefined : Math.min(race, own ?? race);
    const externalKg = kg == null ? undefined : isHyroxSled(st) ? kg * SLED_EXTERNAL_LOAD_FRACTION : kg;
    // Doubles: the partner's half of the station (its amount, time and MTL),
    // a partial station (raceFraction 0.5), so its time neither teaches a
    // benchmark nor takes a percentile against full race splits
    // (hyrox-session-benchmarks isPartialStation; review 2026-10-20: a
    // doubles athlete's half-station time read as a full-station
    // improvement).
    const share = doubles ? HYROX_DOUBLES_STATION_SHARE : 1;
    const sec = stationSeedSec(st, p.band, p.stationBenchmarks, p.seed) * share;
    const amount = hyroxStationRaceAmount(st) * share;
    return {
      type: st,
      ...(st === 'wall_balls' ? { reps: Math.round(amount) } : { distanceM: amount }),
      durationSec: Math.round(sec),
      mtl: computeComponentMTL(sec / 60, rpe, st, externalKg, p.bodyWeightKg),
      restAfterSec: 0,
      raceFraction: share,
      inRounds: [round],
      ...(kg != null ? { loadKg: kg } : {}),
      ...(kg != null && race != null && kg < race - 1e-9 ? { loadPct: kg / race } : {}),
    };
  });
  const runEffort: NonNullable<HyroxSessionSpec['runEffort']> = tier === 'beginner' && p.kind === 'half' ? 'race_no_faster' : 'race';
  return finishHyroxSession({
    n: p.kind === 'full' ? 'Race Simulation' : 'Half Race Simulation',
    d: '',
    t: 'hyrox_sim',
    discipline: 'brick',
    r: rpe,
    rpe,
    hyroxComponents: [run, ...stationComps],
    hyroxRounds: rounds,
    hyroxRoundRestSec: 0,
    hyroxSpec: {
      format: 'race_sim',
      simKind: p.kind,
      restSec: 0,
      transitionSec: SIM_TRANSITION_SEC,
      runM: 1000,
      runPaceSecKm: racePace,
      runEffort,
      wallBallTargetM,
      warmup: hyroxSessionWarmup(p.stationAccess, p.slotIndex, p.bodyWeightKg, true),
      ...(doubles ? { doubles: true } : {}),
    },
  });
}

/** True for a race simulation (lane H2b part 2). */
export function isHyroxSim(w: Pick<Workout, 't'>): boolean {
  return w.t === 'hyrox_sim';
}

// ─── Assessment session (Week 1 only) ────────────────────────────────────────

export interface AssessmentParams {
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  bodyWeightKg?: number;
  /** Station load tier (hyroxLoadTierForState) for the MTL external loads.
   *  Absent: HYROX_DEFAULT_LOAD_TIER. */
  loadTier?: HyroxLoadTier;
  /** The athlete whose band seeds stand in for an untested station or an
   *  unset race pace: the planning field (Open Singles at their sex) at the
   *  target's loads (hyroxStationSeedsAtTarget, hyroxSeedRunPaceSecKm).
   *  Absent: the pooled Open Singles field. */
  seed?: HyroxSeedStateInput;
  /** The week's beginner loads (kg per loaded station; plan_engine.hyrox):
   *  a beginner's week-1 assessment runs the sleds unloaded and the carry,
   *  sandbag and ball at the schedule's implements (sheet
   *  technique.station_session: sleds unloaded in weeks 1 and 2; Tristan
   *  2026-10-20). Absent: race weight (intermediate and advanced athletes). */
  stationLoads?: Partial<Record<HyroxStation, number>>;
}

/**
 * Week 1 HYROX Assessment. One easy pass through all accessible stations.
 * RPE 4 throughout. Purpose is to record split times, not to train hard.
 * Low MTL by design. A beginner's pass takes the week's loads
 * (`stationLoads`: the sleds unloaded), and the description says those
 * stations' times are not race times.
 */
export function generateHyroxAssessment(params: AssessmentParams): Workout {
  const { band, stationAccess, bodyWeightKg } = params;
  const stations = availableStations(stationAccess);
  const loadTier = params.loadTier ?? HYROX_DEFAULT_LOAD_TIER;
  const externalLoads = stationExternalLoadKg(loadTier);
  const seeds = hyroxStationSeedsAtTarget(params.seed ?? {}, band);

  const components: HyroxComponent[] = stations.map(station => {
    const seedSec = seeds[station];
    const easyDurSec = Math.round(seedSec * HYROX_EASY_PASS_TIME_FACTOR);
    const easyDurMin = easyDurSec / 60;
    // A beginner's load below race weight (the sleds unloaded): its external
    // load in MTL, stationComponent's rule (a sled's share of the total).
    const race = hyroxRaceLoadKg(station, loadTier);
    const own = params.stationLoads?.[station];
    const kg = race != null && own != null ? Math.min(race, own) : undefined;
    const externalKg = kg != null ? (isHyroxSled(station) ? kg * SLED_EXTERNAL_LOAD_FRACTION : kg) : (externalLoads[station] ?? 0);
    const stationMTL = computeComponentMTL(easyDurMin, 4, station, externalKg, bodyWeightKg);
    return {
      type: station, durationSec: easyDurSec, mtl: stationMTL,
      ...(kg != null && race != null && kg < race - 1e-9 ? { loadKg: kg, loadPct: kg / race } : {}),
    };
  });
  const reduced = components.filter(c => c.loadKg != null).map(c => STATION_DISPLAY[c.type as HyroxStation].name);

  const totalMTL = components.reduce((sum, c) => sum + c.mtl, 0);
  const totalDurMin = Math.round(
    components.reduce((sum, c) => sum + (c.durationSec ?? 0) / 60, 0) + stations.length * 2
  );

  const stationList = stations.map(st => STATION_DISPLAY[st].name).join(', ');

  const reducedNote = reduced.length > 0
    ? ` This week the sleds run unloaded and the other loaded stations take beginner loads, so the ${reduced.join(', ')} times are not race times: leave them out of your benchmarks.`
    : '';
  return {
    n: 'HYROX Assessment',
    d: `Easy walkthrough of all ${stations.length} stations: ${stationList}. One round each at comfortable effort. Note your time per station and enter it in the app: it calibrates your training plan.${reducedNote}`,
    t: 'hyrox_assessment',
    discipline: 'station',
    r: 4,
    rpe: 4,
    estimatedDurationMin: totalDurMin,
    musculoTendonLoad: totalMTL,
    hyroxComponents: components,
    hyroxRounds: 1,  // one calibration pass; guided overlay stays athlete-paced
  };
}
