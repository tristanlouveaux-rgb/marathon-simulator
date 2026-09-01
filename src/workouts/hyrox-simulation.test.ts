import { describe, it, expect } from 'vitest';
import { generateHyroxSimulation } from './hyrox-generators';
import { scheduleHyroxWeek } from './scheduler.hyrox';
import {
  HYROX_STATION_ORDER,
  STATION_SEED_TIMES_SEC,
  SEED_RUN_PACE_SEC_KM,
  SEED_ROXZONE_SEC,
  STATION_RACE_VOLUME,
  STATION_HALF_VOLUME,
} from '@/constants/hyrox-benchmarks';
import type { HyroxStation } from '@/types/triathlon';
import type { Workout } from '@/types/state';

describe('generateHyroxSimulation — full race', () => {
  const w = generateHyroxSimulation({ kind: 'simulation', band: 'intermediate', bodyWeightKg: 80 });

  it('emits 16 components, interleaved run then station', () => {
    const c = w.hyroxComponents!;
    expect(c).toHaveLength(16);
    for (let i = 0; i < 16; i += 2) {
      expect(c[i].type).toBe('run');
      expect(c[i + 1].type).not.toBe('run');
    }
  });

  it('places the eight stations in fixed race order', () => {
    const stations = w.hyroxComponents!.filter(c => c.type !== 'run').map(c => c.type);
    expect(stations).toEqual(HYROX_STATION_ORDER);
  });

  it('runs eight 1km legs', () => {
    const runs = w.hyroxComponents!.filter(c => c.type === 'run');
    expect(runs).toHaveLength(8);
    expect(runs.every(r => r.distanceM === 1000)).toBe(true);
  });

  it('prescribes race-standard station volumes', () => {
    for (const c of w.hyroxComponents!.filter(c => c.type !== 'run')) {
      const expected = STATION_RACE_VOLUME[c.type as HyroxStation];
      expect(c.distanceM).toBe(expected.distanceM);
      expect(c.reps).toBe(expected.reps);
    }
  });

  it('targets run legs + station seeds + roxzone, from band seeds', () => {
    const band = 'intermediate';
    const runSec = SEED_RUN_PACE_SEC_KM[band] * 8;
    const stationSec = HYROX_STATION_ORDER.reduce((s, st) => s + STATION_SEED_TIMES_SEC[band][st], 0);
    const expectedMin = Math.round((runSec + stationSec + SEED_ROXZONE_SEC[band]) / 60);
    expect(w.estimatedDurationMin).toBe(expectedMin);
  });

  it('is a brick-discipline session tagged hyrox_simulation', () => {
    expect(w.t).toBe('hyrox_simulation');
    expect(w.discipline).toBe('brick');
    expect(w.rpe).toBe(9);
  });

  it('sums component MTL into the session total', () => {
    const sum = w.hyroxComponents!.reduce((s, c) => s + c.mtl, 0);
    expect(w.musculoTendonLoad).toBeCloseTo(sum, 6);
    expect(w.musculoTendonLoad!).toBeGreaterThan(0);
  });
});

describe('generateHyroxSimulation — half', () => {
  const full = generateHyroxSimulation({ kind: 'simulation', band: 'intermediate', bodyWeightKg: 80 });
  const half = generateHyroxSimulation({ kind: 'half_simulation', band: 'intermediate', bodyWeightKg: 80 });

  it('keeps the complete station sequence, so wall balls still come last', () => {
    const stations = half.hyroxComponents!.filter(c => c.type !== 'run').map(c => c.type);
    expect(stations).toEqual(HYROX_STATION_ORDER);
    expect(stations[stations.length - 1]).toBe('wall_balls');
  });

  it('halves the run legs', () => {
    const runs = half.hyroxComponents!.filter(c => c.type === 'run');
    expect(runs).toHaveLength(8);
    expect(runs.every(r => r.distanceM === 500)).toBe(true);
  });

  it('prescribes the established half-test station volumes', () => {
    for (const c of half.hyroxComponents!.filter(c => c.type !== 'run')) {
      const expected = STATION_HALF_VOLUME[c.type as HyroxStation];
      expect(c.distanceM).toBe(expected.distanceM);
      expect(c.reps).toBe(expected.reps);
    }
  });

  it('carries about half the MTL of the full simulation', () => {
    // Same per-component sRPE, half the duration, so MTL halves. Per-component
    // second-rounding puts the result within a fraction of a percent, not exact.
    const ratio = half.musculoTendonLoad! / full.musculoTendonLoad!;
    expect(ratio).toBeGreaterThan(0.495);
    expect(ratio).toBeLessThan(0.505);
  });

  it('is rated one RPE point below the full simulation', () => {
    expect(half.rpe).toBe(8);
    expect(full.rpe).toBe(9);
  });
});

describe('generateHyroxSimulation — calibration inputs', () => {
  it('uses the athlete\'s own station benchmark over the band seed', () => {
    const fast: Partial<Record<HyroxStation, number>> = { wall_balls: 200 };
    const w = generateHyroxSimulation({
      kind: 'simulation', band: 'intermediate', bodyWeightKg: 80, stationBenchmarks: fast,
    });
    const wallBalls = w.hyroxComponents!.find(c => c.type === 'wall_balls')!;
    expect(wallBalls.durationSec).toBe(200);
  });

  it('uses the athlete\'s own run pace over the band seed', () => {
    const w = generateHyroxSimulation({
      kind: 'simulation', band: 'intermediate', bodyWeightKg: 80, runPaceSecKm: 280,
    });
    const run = w.hyroxComponents!.find(c => c.type === 'run')!;
    expect(run.durationSec).toBe(280);
  });

  it('a faster athlete gets a shorter target than a slower one', () => {
    const quick = generateHyroxSimulation({ kind: 'simulation', band: 'competitive' });
    const slow = generateHyroxSimulation({ kind: 'simulation', band: 'beginner' });
    expect(quick.estimatedDurationMin!).toBeLessThan(slow.estimatedDurationMin!);
  });
});

describe('scheduleHyroxWeek with a simulation', () => {
  const mk = (t: string, n: string): Workout => ({ n, t, d: '' } as Workout);

  it('gives the race simulation Saturday', () => {
    const out = scheduleHyroxWeek([
      mk('hyrox_run_easy', 'Easy'),
      mk('hyrox_simulation', 'Race Simulation'),
      mk('hyrox_run_tempo', 'Tempo'),
    ], 'intermediate');
    expect(out.find(w => w.t === 'hyrox_simulation')!.dayOfWeek).toBe(5);
  });

  it('keeps other hard sessions off the days either side of it', () => {
    const out = scheduleHyroxWeek([
      mk('hyrox_simulation', 'Race Simulation'),
      mk('hyrox_run_intervals', 'Intervals'),
      mk('hyrox_station_density', 'Density'),
      mk('hyrox_run_tempo', 'Tempo'),
    ], 'intermediate');
    const simDay = out.find(w => w.t === 'hyrox_simulation')!.dayOfWeek!;
    const others = out.filter(w => w.t !== 'hyrox_simulation').map(w => w.dayOfWeek!);
    for (const d of others) {
      expect(Math.abs(d - simDay)).toBeGreaterThan(1);
    }
  });

  it('does not double-book a day when a simulation and a brick are both present', () => {
    const out = scheduleHyroxWeek([
      mk('hyrox_simulation', 'Race Simulation'),
      mk('hyrox_brick', 'Brick'),
    ], 'intermediate');
    const days = out.map(w => w.dayOfWeek);
    expect(new Set(days).size).toBe(days.length);
  });
});
