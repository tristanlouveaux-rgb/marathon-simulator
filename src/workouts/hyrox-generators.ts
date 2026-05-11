/**
 * HYROX session generators.
 *
 * Produces Workout objects for each HYROX session kind:
 *   - run_easy / run_tempo / run_intervals  — standalone run sessions
 *   - station_technique                     — 3 × circuit, technique focus, RPE 5
 *   - station_density                       — 2-station AMRAP, RPE 7
 *   - brick                                 — N rounds: 1km run + station
 *   - mini_brick                            — N rounds: 500m run + erg (beginners)
 *
 * All generators return a Workout with:
 *   - `estimatedDurationMin` set from targetMinutes
 *   - `musculoTendonLoad` computed via mtl.ts
 *   - `hyroxComponents` for the detail view / card breakdown
 *   - `discipline` set to 'run' | 'station' | 'brick'
 */

import type { Workout } from '@/types/state';
import type { AbilityBand, HyroxConfig, HyroxComponent, HyroxStation } from '@/types/triathlon';
import { computeComponentMTL } from '@/calculations/mtl';
import { STATION_DISPLAY, STATION_SEED_TIMES_SEC, SEED_RUN_PACE_SEC_KM, HYROX_STATION_ORDER, STATION_EXTERNAL_LOAD_KG } from '@/constants/hyrox-benchmarks';
import { ECCENTRIC_HEAVY_STATIONS } from '@/constants/hyrox-constants';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RunParams {
  kind: 'run_easy' | 'run_tempo' | 'run_intervals';
  targetMinutes: number;
  band: AbilityBand;
  phase: 'base' | 'build' | 'peak' | 'taper';
  slotIndex: number;
  bodyWeightKg?: number;
  runPaceSecKm?: number;
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
  count: number
): HyroxStation[] {
  let pool = availableStations(access);
  if (pool.length === 0) pool = ['row_erg', 'farmer_carry', 'wall_balls']; // safe fallback

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

/** Format pace (sec/km) as "m:ss". */
function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = String(Math.round(secPerKm % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

// ─── Run session generator ────────────────────────────────────────────────────

/**
 * Easy run pace from race pace (seed × 1.2).
 * Race pace is already fatigued race pace from HyroxDataLab — 20% slower is a
 * physiologically reasonable easy training pace (Maffetone; Seiler 2010).
 */
function easyTrainingPaceSecKm(band: AbilityBand): number {
  return Math.round(SEED_RUN_PACE_SEC_KM[band] * 1.2);
}

export function generateHyroxRun(params: RunParams): Workout {
  const { kind, targetMinutes, band, bodyWeightKg } = params;
  const dur = Math.round(targetMinutes);

  let name: string;
  let desc: string;
  let rpe: number;
  let mtlKind: 'run_easy' | 'run_tempo' | 'run_intervals';

  const racePace = params.runPaceSecKm ?? SEED_RUN_PACE_SEC_KM[band];
  const easyPace = Math.round(racePace * 1.2);
  const easyDistKm = Math.round((dur * 60) / easyPace * 10) / 10;

  switch (kind) {
    case 'run_easy': {
      name = 'Easy Run';
      desc = `${dur} min easy at ${fmtPace(easyPace)}/km (~${easyDistKm} km). Fully conversational — you should be able to speak in complete sentences.`;
      rpe = 4;
      mtlKind = 'run_easy';
      break;
    }
    case 'run_tempo': {
      const warmCool = 15;  // 10 warm-up + 5 cool-down
      const tempoMin = Math.max(10, dur - warmCool);
      name = 'Tempo Run';
      desc = `10 min easy warm-up. ${tempoMin} min at threshold pace (~${fmtPace(Math.round(racePace * 0.97))}/km) — comfortably hard, can say short phrases. 5 min easy cool-down.`;
      rpe = 7;
      mtlKind = 'run_tempo';
      break;
    }
    case 'run_intervals': {
      // e.g. 8 × 400m with 90s jog recovery
      const warmCool = 15;
      const workMin = Math.max(8, dur - warmCool);
      // Each rep ~90s hard + 90s recovery = 3 min/rep
      const reps = Math.max(4, Math.min(12, Math.round(workMin / 3)));
      name = 'Interval Run';
      desc = `10 min easy warm-up. ${reps} × 400m at ~${fmtPace(Math.round(racePace * 0.88))}/km, 90s jog recovery. 5 min cool-down.`;
      rpe = 8;
      mtlKind = 'run_intervals';
      break;
    }
  }

  const mtl = computeComponentMTL(dur, rpe, mtlKind, undefined, bodyWeightKg);
  const component: HyroxComponent = {
    type: 'run',
    distanceM: Math.round(easyDistKm * 1000),
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
  };
}

// ─── Station session generators ───────────────────────────────────────────────

export function generateHyroxStation(params: StationParams): Workout {
  const { kind, targetMinutes, band, stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks } = params;
  const dur = Math.round(targetMinutes);

  if (kind === 'station_technique') {
    return generateStationTechnique({ dur, band, stationAccess, phase, slotIndex, bodyWeightKg, stationBenchmarks });
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
}): Workout {
  // 3 stations × 3 rounds at 65% of seed time (technique pace), 1:1 work:rest.
  let stations = pickStations(p.stationAccess, p.phase, p.slotIndex, 3);
  // Beginners: remove eccentric-heavy stations entirely — quad DOMS from burpees/lunges
  // on Week 1 kills adherence. Introduce progressively from build phase.
  if ((p.band === 'total_beginner' || p.band === 'beginner') && p.phase === 'base') {
    const safe = stations.filter(s => !ECCENTRIC_HEAVY_STATIONS.includes(s));
    if (safe.length >= 2) stations = safe;
  }
  const rounds = 3;
  const components: HyroxComponent[] = [];
  let totalMTL = 0;

  const stationLines = stations.map(s => {
    const display = STATION_DISPLAY[s];
    const seedSec = stationSeedSec(s, p.band, p.stationBenchmarks);
    const techSec = Math.round(seedSec * 0.65);  // 65% of race pace → technique stimulus
    const workMinPerRound = techSec / 60;
    const workMinTotal = workMinPerRound * rounds;
    const externalKg = STATION_EXTERNAL_LOAD_KG[s];
    const stationMTL = computeComponentMTL(workMinTotal, 5, s, externalKg, p.bodyWeightKg);
    totalMTL += stationMTL;

    components.push({
      type: s,
      distanceM: s === 'wall_balls' ? undefined : parseInt(display.distance),
      reps: s === 'wall_balls' ? 50 : undefined,  // half reps for technique
      durationSec: techSec,
      mtl: stationMTL,
    });

    return `${display.name} (${s === 'wall_balls' ? '50 reps' : display.distance}, ~${fmtSec(techSec)})`;
  });

  // Session name: generic. The station list lives inside the modal body where
  // it has space; cramming three station names into the headline reads as noise.
  const sessionName = 'Station Circuit';

  // Add a 20-min easy run at the end — race-specific transition practice
  const runFinishMin = Math.min(20, Math.round(p.dur * 0.4));
  const easyPace = SEED_RUN_PACE_SEC_KM[p.band] * 1.2;
  const runKm = Math.round((runFinishMin * 60) / easyPace * 10) / 10;

  return {
    n: sessionName,
    d: `${rounds} rounds: ${stationLines.join(' + ')}. Technique focus, controlled pace. Rest 60s between stations, 3 min between rounds. Then ${runFinishMin} min easy run (~${runKm} km) — practice the station-to-run transition.`,
    t: 'hyrox_station_technique',
    discipline: 'station',
    r: 5,
    rpe: 5,
    estimatedDurationMin: p.dur + runFinishMin,
    musculoTendonLoad: totalMTL,
    hyroxComponents: components,
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
  // 2 stations in AMRAP-style density blocks. Pick 1 high-MTL + 1 erg (lower MTL).
  // Prioritise the race's primary discriminators (wall balls, sled pull) in build/peak.
  const avail = availableStations(p.stationAccess);
  const highMTL: HyroxStation[] = ['wall_balls', 'sled_pull', 'sandbag_lunges', 'burpee_broad_jumps']
    .filter(s => avail.includes(s as HyroxStation)) as HyroxStation[];
  const ergBased: HyroxStation[] = ['row_erg', 'ski_erg'].filter(s => avail.includes(s as HyroxStation)) as HyroxStation[];

  const rotation = p.slotIndex % Math.max(1, highMTL.length);
  const station1 = highMTL[rotation] ?? avail[p.slotIndex % avail.length];
  const station2 = ergBased[(p.slotIndex) % Math.max(1, ergBased.length)] ?? avail[(p.slotIndex + 1) % avail.length];

  const selectedStations = station1 === station2 ? [station1] : [station1, station2];
  const components: HyroxComponent[] = [];
  let totalMTL = 0;

  // Each density block: 2 rounds full race distance, race-pace effort
  const rounds = 2;
  const stationLines = selectedStations.map(s => {
    const display = STATION_DISPLAY[s];
    const seedSec = stationSeedSec(s, p.band, p.stationBenchmarks);
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
    });
    return `${display.name} (${display.distance}, target ${fmtSec(seedSec)})`;
  });

  return {
    n: 'Station Density',
    d: `${rounds} rounds: ${stationLines.join(' → ')}. Race-pace effort, 30s rest between stations, 2 min between rounds. No running — station-only focus.`,
    t: 'hyrox_station_density',
    discipline: 'station',
    r: 7,
    rpe: 7,
    estimatedDurationMin: p.dur,
    musculoTendonLoad: totalMTL,
    hyroxComponents: components,
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
    },
    {
      type: station,
      distanceM: station === 'wall_balls' ? undefined : parseInt(stationDisplay.distance),
      reps: station === 'wall_balls' ? 100 : undefined,
      durationSec: stationSeedSec_,
      mtl: stationMTL,
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
    { type: 'run', distanceM: 500, durationSec: runSeedSec, mtl: runMTL },
    { type: station, durationSec: stationSeedSec_, mtl: stationMTL },
  ];

  return {
    n: 'Mini Brick',
    d: `${rounds} rounds: 500m run + ${stationDisplay.name} (${stationDisplay.distance}). Build the run-to-station transition.`,
    t: 'hyrox_mini_brick',
    discipline: 'brick',
    r: 6,
    rpe: 6,
    estimatedDurationMin: p.dur,
    musculoTendonLoad: runMTL + stationMTL,
    hyroxComponents: components,
  };
}

// ─── Assessment session (Week 1 only) ────────────────────────────────────────

export interface AssessmentParams {
  band: AbilityBand;
  stationAccess: HyroxConfig['stationAccess'];
  bodyWeightKg?: number;
}

/**
 * Week 1 HYROX Assessment — one easy pass through all accessible stations.
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
  };
}
