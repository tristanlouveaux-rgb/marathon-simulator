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
import type { AbilityBand, HyroxConfig, HyroxComponent, HyroxStation } from '@/types/triathlon';
import { computeComponentMTL } from '@/calculations/mtl';
import { HYROX_EASY_ERG_TYPE } from './hyrox-easy-erg';
import { STATION_DISPLAY, STATION_SEED_TIMES_SEC, SEED_RUN_PACE_SEC_KM, HYROX_STATION_ORDER, STATION_EXTERNAL_LOAD_KG } from '@/constants/hyrox-benchmarks';
import {
  ECCENTRIC_HEAVY_STATIONS, RACE_WEEK_EXCLUDED_STATIONS, hyroxTier,
  HYROX_INTERVAL_HR_FRACTION, HYROX_QUALITY_WARMUP_MIN, HYROX_QUALITY_COOLDOWN_MIN,
  HYROX_TEMPO_MIN_WORK_MIN, HYROX_EASY_RPE,
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
}

export interface StationParams {
  kind: 'station_technique' | 'station_density';
  targetMinutes: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
  /** Race week (technique circuits only): leave out RACE_WEEK_EXCLUDED_STATIONS. */
  raceWeek?: boolean;
}

export interface BrickParams {
  kind: 'brick' | 'mini_brick';
  targetMinutes: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
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

/** Get seed time (sec) for a station and band, using user benchmark if available. */
function stationSeedSec(
  station: HyroxStation,
  band: AbilityBand,
  benchmarks?: Partial<Record<HyroxStation, number>>
): number {
  return benchmarks?.[station] ?? STATION_SEED_TIMES_SEC[band][station];
}

/** Format seconds as "m:ss". */
function fmtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Format pace (sec/km) as "m:ss": the whole second with the minute carried
 *  (fmtModelPaceKm), so 299.6 reads 5:00, never 4:60. */
function fmtPace(secPerKm: number): string {
  return fmtModelPaceKm(secPerKm);
}

/**
 * Coach dose ceiling (max rounds) per ability band. Sourced from the HYROX
 * research doc §3.5 brick dosing (docs/research/hyrox.md lines 169-171):
 *   beginner tier ≤4, novice/intermediate ≤6, advanced/competitive ≤8.
 * Used as the upper clamp so race-pace station volume never exceeds the band's
 * prescribed dose, regardless of how large a slot the scheduler hands us.
 * The tiers come from hyroxTier, the single band-to-tier mapping.
 * See SCIENCE_LOG §AO.
 */
function bandMaxRounds(band: AbilityBand): number {
  switch (hyroxTier(band)) {
    case 'advanced':     return 8;
    case 'intermediate': return 6;
    default:             return 4;
  }
}

/** A circuit or brick session is at least this many rounds (below this it is a
 *  single pass, i.e. the calibration assessment, not a training circuit). The
 *  weekly MTL cap (plan_engine.hyrox enforceMTLCap) cuts rounds down to it. */
export const MIN_CIRCUIT_ROUNDS = 2;

/**
 * Rounds that best fill a time budget given one round's duration: nearest whole
 * number of rounds to the slot (so the session fills the time the scheduler
 * allocated rather than always under- or over-shooting), floored at 2 rounds
 * and capped at the band's coach dose ceiling. The budget does the filling; the
 * band cap prevents over-dosing race-pace volume on a large slot.
 */
function fillRounds(budgetSec: number, roundDurSec: number, bandMax: number): number {
  if (roundDurSec <= 0) return MIN_CIRCUIT_ROUNDS;
  const raw = Math.round(budgetSec / roundDurSec);
  return Math.max(MIN_CIRCUIT_ROUNDS, Math.min(bandMax, raw));
}

// ─── Run session generator ────────────────────────────────────────────────────

/**
 * HYROX easy run pace (sec/km): race pace × 1.2, where race pace is the
 * athlete's HYROX run pace (`hyroxConfig.hyroxRunPaceSecKm`) or, without one,
 * the band seed pace. Race pace is already fatigued race pace from
 * HyroxDataLab. 20% slower is a physiologically reasonable easy training pace
 * (Maffetone; Seiler 2010). Prices easy runs and commute runs alike.
 */
export function hyroxEasyRunPaceSecKm(band: AbilityBand, runPaceSecKm?: number): number {
  return Math.round((runPaceSecKm ?? SEED_RUN_PACE_SEC_KM[band]) * 1.2);
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

  const racePace = params.runPaceSecKm ?? SEED_RUN_PACE_SEC_KM[band];
  const easyPace = hyroxEasyRunPaceSecKm(band, params.runPaceSecKm);
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
  return Math.max(...ergs.map(s => computeComponentMTL(1, HYROX_EASY_RPE, s, STATION_EXTERNAL_LOAD_KG[s], bodyWeightKg)));
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
  const mtl = computeComponentMTL(dur, HYROX_EASY_RPE, station, STATION_EXTERNAL_LOAD_KG[station], p.bodyWeightKg);
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

export function generateHyroxStation(params: StationParams): Workout {
  const { kind, targetMinutes, band, stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks } = params;
  const dur = Math.round(targetMinutes);

  if (kind === 'station_technique') {
    return generateStationTechnique({ dur, band, stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks, raceWeek: params.raceWeek });
  }
  return generateStationDensity({ dur, band, stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks });
}

function generateStationTechnique(p: {
  dur: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
  raceWeek?: boolean;
}): Workout {
  // Up to 4 stations at 65% of seed time (technique pace), 60s between stations
  // and 3 min between rounds. Round count fills the station-work budget (slot
  // minus the run finish), clamped to the band's coach range — controlled pace
  // sustains more volume than race-pace density. Duration follows the work.
  // Race week: no eccentric-heavy or sled station (RACE_WEEK_EXCLUDED_STATIONS).
  let stations = pickStations(p.stationAccess, p.phase, p.slotIndex, 4, p.raceWeek ? RACE_WEEK_EXCLUDED_STATIONS : []);
  // Beginners: remove eccentric-heavy stations entirely. Quad DOMS from burpees/lunges
  // on Week 1 kills adherence. Introduce progressively from build phase.
  if ((p.band === 'total_beginner' || p.band === 'beginner') && p.phase === 'base') {
    const safe = stations.filter(s => !ECCENTRIC_HEAVY_STATIONS.includes(s));
    if (safe.length >= MIN_CIRCUIT_STATIONS) stations = safe;
  }

  const INTER_STATION_REST = 60;
  const INTER_ROUND_REST = 180;

  // Per-station technique work (one round) and the run finish that closes the session.
  const perStationSec = stations.map(s => Math.round(stationSeedSec(s, p.band, p.stationBenchmarks) * 0.65));
  const runFinishMin = Math.min(20, Math.round(p.dur * 0.4));
  const easyPace = SEED_RUN_PACE_SEC_KM[p.band] * 1.2;
  const runKm = Math.round((runFinishMin * 60) / easyPace * 10) / 10;

  // Round duration = station work + within-round rests + one inter-round rest.
  const workPerRoundSec = perStationSec.reduce((sum, s) => sum + s, 0);
  const roundDurSec = workPerRoundSec + Math.max(0, stations.length - 1) * INTER_STATION_REST + INTER_ROUND_REST;
  const stationBudgetSec = Math.max(0, (p.dur - runFinishMin) * 60);
  const rounds = fillRounds(stationBudgetSec, roundDurSec, bandMaxRounds(p.band));

  const components: HyroxComponent[] = [];
  let totalMTL = 0;
  const stationLines = stations.map((s, i) => {
    const display = STATION_DISPLAY[s];
    const techSec = perStationSec[i];
    const workMinTotal = (techSec / 60) * rounds;
    const externalKg = STATION_EXTERNAL_LOAD_KG[s];
    const stationMTL = computeComponentMTL(workMinTotal, 5, s, externalKg, p.bodyWeightKg);
    totalMTL += stationMTL;

    components.push({
      type: s,
      distanceM: s === 'wall_balls' ? undefined : parseInt(display.distance),
      reps: s === 'wall_balls' ? 50 : undefined,  // half reps for technique
      durationSec: techSec,
      mtl: stationMTL,
      restAfterSec: INTER_STATION_REST,
    });

    return `${display.name} (${s === 'wall_balls' ? '50 reps' : display.distance}, ~${fmtSec(techSec)})`;
  });

  // Total prescribed time = station work + all rests across rounds + run finish.
  const stationTotalSec =
    workPerRoundSec * rounds +
    rounds * Math.max(0, stations.length - 1) * INTER_STATION_REST +
    Math.max(0, rounds - 1) * INTER_ROUND_REST;
  const estimatedDurationMin = Math.round(stationTotalSec / 60) + runFinishMin;

  // Session name: generic. The station list lives inside the modal body where
  // it has space; cramming station names into the headline reads as noise.
  const sessionName = 'Station Circuit';

  return {
    n: sessionName,
    d: `${rounds} rounds: ${stationLines.join(' + ')}. Technique focus, controlled pace. Rest 60s between stations, 3 min between rounds. Then ${runFinishMin} min easy run (~${runKm} km) — practice the station-to-run transition.`,
    t: 'hyrox_station_technique',
    discipline: 'station',
    r: 5,
    rpe: 5,
    estimatedDurationMin,
    musculoTendonLoad: totalMTL,
    hyroxComponents: components,
    hyroxRounds: rounds,
    hyroxRoundRestSec: INTER_ROUND_REST,
  };
}

function generateStationDensity(p: {
  dur: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
}): Workout {
  // Time-capped station circuit (research §7.2: "station work for time / AMRAP").
  // Pick the race's primary discriminators (2 high-MTL) + 1 erg, then run the
  // circuit at race pace for as many rounds as fill the slot, clamped to the
  // band's coach range. 30s between stations, 2 min between rounds. Duration
  // follows the actual work, not the raw slot budget.
  const avail = availableStations(p.stationAccess);
  const highMTL: HyroxStation[] = ['wall_balls', 'sled_pull', 'sandbag_lunges', 'burpee_broad_jumps']
    .filter(s => avail.includes(s as HyroxStation)) as HyroxStation[];
  const ergBased: HyroxStation[] = ['row_erg', 'ski_erg'].filter(s => avail.includes(s as HyroxStation)) as HyroxStation[];

  // Rotate the two high-MTL picks + an erg by slotIndex for week-to-week variety.
  const h1 = highMTL[p.slotIndex % Math.max(1, highMTL.length)];
  const h2 = highMTL[(p.slotIndex + 1) % Math.max(1, highMTL.length)];
  const erg = ergBased[p.slotIndex % Math.max(1, ergBased.length)];
  const selectedStations: HyroxStation[] = [];
  for (const s of [h1, h2, erg]) {
    if (s && !selectedStations.includes(s)) selectedStations.push(s);
  }
  // Fallback: ensure at least two stations even on sparse equipment.
  if (selectedStations.length < 2) {
    for (const s of avail) {
      if (!selectedStations.includes(s)) { selectedStations.push(s); if (selectedStations.length >= 2) break; }
    }
  }
  if (selectedStations.length === 0) selectedStations.push('row_erg');

  const INTER_STATION_REST = 30;
  const INTER_ROUND_REST = 120;

  const perStationSec = selectedStations.map(s => stationSeedSec(s, p.band, p.stationBenchmarks));
  const workPerRoundSec = perStationSec.reduce((sum, s) => sum + s, 0);
  const roundDurSec = workPerRoundSec + Math.max(0, selectedStations.length - 1) * INTER_STATION_REST + INTER_ROUND_REST;
  const rounds = fillRounds(p.dur * 60, roundDurSec, bandMaxRounds(p.band));

  const components: HyroxComponent[] = [];
  let totalMTL = 0;
  const stationLines = selectedStations.map((s, i) => {
    const display = STATION_DISPLAY[s];
    const seedSec = perStationSec[i];
    const workMinTotal = (seedSec / 60) * rounds;
    const externalKg = STATION_EXTERNAL_LOAD_KG[s];
    const stationMTL = computeComponentMTL(workMinTotal, 7, s, externalKg, p.bodyWeightKg);
    totalMTL += stationMTL;

    components.push({
      type: s,
      distanceM: s === 'wall_balls' ? undefined : parseInt(display.distance),
      reps: s === 'wall_balls' ? 100 : undefined,
      durationSec: seedSec,
      mtl: stationMTL,
      restAfterSec: INTER_STATION_REST,
    });
    return `${display.name} (${display.distance}, target ${fmtSec(seedSec)})`;
  });

  const totalSec =
    workPerRoundSec * rounds +
    rounds * Math.max(0, selectedStations.length - 1) * INTER_STATION_REST +
    Math.max(0, rounds - 1) * INTER_ROUND_REST;
  const estimatedDurationMin = Math.round(totalSec / 60);

  return {
    n: 'Station Density',
    d: `${rounds} rounds: ${stationLines.join(' → ')}. Race-pace effort, 30s rest between stations, 2 min between rounds. No running — station-only focus.`,
    t: 'hyrox_station_density',
    discipline: 'station',
    r: 7,
    rpe: 7,
    estimatedDurationMin,
    musculoTendonLoad: totalMTL,
    hyroxComponents: components,
    hyroxRounds: rounds,
    hyroxRoundRestSec: INTER_ROUND_REST,
  };
}

// ─── Brick session generators ─────────────────────────────────────────────────

export function generateHyroxBrick(params: BrickParams): Workout {
  const { kind, targetMinutes, band, stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks } = params;
  const dur = Math.round(targetMinutes);

  if (kind === 'mini_brick') {
    return generateMiniBrick({ dur, band, stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks });
  }
  return generateFullBrick({ dur, band, stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks });
}

function generateFullBrick(p: {
  dur: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
}): Workout {
  // N rounds of (1km run + 1 station). Pick a key station based on phase.
  // Phase progression: base → erg-based stations, build/peak → high-MTL stations.
  const avail = availableStations(p.stationAccess);
  let stationPool: HyroxStation[];
  if (p.phase === 'base') {
    stationPool = avail.filter(s => !ECCENTRIC_HEAVY_STATIONS.includes(s));
    if (stationPool.length === 0) stationPool = avail;
  } else {
    // Build/peak: cycle through high-impact discriminators (research doc §4.5)
    const priority: HyroxStation[] = ['wall_balls', 'sled_pull', 'sandbag_lunges', 'burpee_broad_jumps', 'farmer_carry', 'row_erg', 'ski_erg', 'sled_push'];
    stationPool = priority.filter(s => avail.includes(s));
    if (stationPool.length === 0) stationPool = avail;
  }
  const station = stationPool[p.slotIndex % stationPool.length];
  const stationDisplay = STATION_DISPLAY[station];
  const stationSeedSec_ = stationSeedSec(station, p.band, p.stationBenchmarks);

  // Run: 1km at seed race pace
  const runSeedSec = SEED_RUN_PACE_SEC_KM[p.band];  // seconds for 1km at seed pace
  const transitionSec = 30;  // jog between run and station
  const roundDurSec = runSeedSec + stationSeedSec_ + transitionSec;

  // How many full rounds fit in targetMinutes (minus 5min setup/cool-down)?
  const usableMin = Math.max(p.dur - 5, p.dur * 0.9);
  const rawRounds = Math.floor((usableMin * 60) / roundDurSec);
  const rounds = Math.max(2, Math.min(6, rawRounds));

  // MTL for all run components
  const runDurMinTotal = (runSeedSec / 60) * rounds;
  const runMTL = computeComponentMTL(runDurMinTotal, 7, 'run_tempo', undefined, p.bodyWeightKg);

  // MTL for station component
  const stationDurMinTotal = (stationSeedSec_ / 60) * rounds;
  const externalKg = STATION_EXTERNAL_LOAD_KG[station];
  const stationMTL = computeComponentMTL(stationDurMinTotal, 7, station, externalKg, p.bodyWeightKg);

  const components: HyroxComponent[] = [
    {
      type: 'run',
      distanceM: 1000,
      durationSec: runSeedSec,
      mtl: runMTL,
      restAfterSec: 0,  // straight into the station, race-like
    },
    {
      type: station,
      distanceM: station === 'wall_balls' ? undefined : parseInt(stationDisplay.distance),
      reps: station === 'wall_balls' ? 100 : undefined,
      durationSec: stationSeedSec_,
      mtl: stationMTL,
      restAfterSec: 0,  // last of round → inter-round rest applies (hyroxRoundRestSec)
    },
  ];

  return {
    n: 'HYROX Brick',
    d: `${rounds} rounds: 1km run, then straight into ${stationDisplay.name} (${stationDisplay.distance}) — just like race day. 2 min rest between rounds.`,
    t: 'hyrox_brick',
    discipline: 'brick',
    r: 7,
    rpe: 7,
    estimatedDurationMin: p.dur,
    musculoTendonLoad: runMTL + stationMTL,
    hyroxComponents: components,
    hyroxRounds: rounds,
    hyroxRoundRestSec: 120,  // "2 min rest between rounds" (description)
  };
}

function generateMiniBrick(p: {
  dur: number;
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
}): Workout {
  // Beginner-friendly: 500m run + 1 erg station. Builds the run-to-station
  // transition pattern without the full eccentric load of race-distance bricks.
  const avail = availableStations(p.stationAccess);
  const ergs: HyroxStation[] = ['row_erg', 'ski_erg'].filter(s => avail.includes(s as HyroxStation)) as HyroxStation[];
  const station: HyroxStation = ergs[p.slotIndex % Math.max(1, ergs.length)] ?? 'farmer_carry';
  const stationDisplay = STATION_DISPLAY[station];
  const stationSeedSec_ = stationSeedSec(station, p.band, p.stationBenchmarks);

  // 500m run at seed pace
  const runSeedSec = Math.round(SEED_RUN_PACE_SEC_KM[p.band] * 0.5);
  const transitionSec = 30;
  const roundDurSec = runSeedSec + stationSeedSec_ + transitionSec;

  const usableMin = Math.max(p.dur - 5, p.dur * 0.9);
  const rawRounds = Math.floor((usableMin * 60) / roundDurSec);
  const rounds = Math.max(2, Math.min(4, rawRounds));

  const runDurMinTotal = (runSeedSec / 60) * rounds;
  const runMTL = computeComponentMTL(runDurMinTotal, 6, 'run_easy', undefined, p.bodyWeightKg);
  const stationDurMinTotal = (stationSeedSec_ / 60) * rounds;
  const stationMTL = computeComponentMTL(stationDurMinTotal, 6, station, undefined, p.bodyWeightKg);

  const components: HyroxComponent[] = [
    { type: 'run', distanceM: 500, durationSec: runSeedSec, mtl: runMTL, restAfterSec: 0 },
    { type: station, durationSec: stationSeedSec_, mtl: stationMTL, restAfterSec: 0 },
  ];

  return {
    n: 'Mini Brick',
    d: `${rounds} rounds: 500m run + ${stationDisplay.name} (${stationDisplay.distance}). Build the run-to-station transition. 2 min rest between rounds.`,
    t: 'hyrox_mini_brick',
    discipline: 'brick',
    r: 6,
    rpe: 6,
    estimatedDurationMin: p.dur,
    musculoTendonLoad: runMTL + stationMTL,
    hyroxComponents: components,
    hyroxRounds: rounds,
    hyroxRoundRestSec: 120,
  };
}

// ─── Assessment session (Week 1 only) ────────────────────────────────────────

export interface AssessmentParams {
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  bodyWeightKg?: number;
}

/**
 * Week 1 HYROX Assessment. One easy pass through all accessible stations.
 * RPE 4 throughout. Purpose is to record split times, not to train hard.
 * Low MTL by design.
 */
export function generateHyroxAssessment(params: AssessmentParams): Workout {
  const { band, stationAccess, bodyWeightKg } = params;
  const stations = availableStations(stationAccess);

  const components: HyroxComponent[] = stations.map(station => {
    const display = STATION_DISPLAY[station];
    const seedSec = STATION_SEED_TIMES_SEC[band][station];
    const easyDurSec = Math.round(seedSec * 1.2);
    const easyDurMin = easyDurSec / 60;
    const stationMTL = computeComponentMTL(
      easyDurMin, 4, station,
      STATION_EXTERNAL_LOAD_KG[station] ?? 0,
      bodyWeightKg
    );
    void display;
    return { type: station, durationSec: easyDurSec, mtl: stationMTL };
  });

  const totalMTL = components.reduce((sum, c) => sum + c.mtl, 0);
  const totalDurMin = Math.round(
    components.reduce((sum, c) => sum + (c.durationSec ?? 0) / 60, 0) + stations.length * 2
  );

  const stationList = stations.map(st => STATION_DISPLAY[st].name).join(', ');

  return {
    n: 'HYROX Assessment',
    d: `Easy walkthrough of all ${stations.length} stations: ${stationList}. One round each at comfortable effort. Note your time per station and enter them in the app — this calibrates your training plan.`,
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
