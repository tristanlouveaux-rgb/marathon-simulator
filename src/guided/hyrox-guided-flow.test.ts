/**
 * End-to-end integration of the HYROX guided-session pipeline, nothing mocked:
 *   generator → parseHyroxSession → StrengthGuideController → benchmark learning.
 * Guards the wiring the unit tests cover in isolation (rounds expansion, timed
 * rest, best-round learning) actually composes across the real modules.
 * Since lane H2b (generator v19) a race-pace session prescribes quarter-station
 * sets (HyroxComponent.raceFraction 0.25): a set time is not a station time,
 * so those sets teach no benchmark. A full-station session (the race
 * simulations of part 2; here the same circuit with its components at the
 * full station, fullStation) still teaches it.
 */
import { describe, it, expect } from 'vitest';
import { generateHyroxStation } from '@/workouts/hyrox-generators';
import { parseHyroxSession } from '@/guided/strength-model';
import { StrengthGuideController } from '@/guided/strength-controller';
import type { SetRecord } from '@/guided/strength-controller';
import type { StrengthSession } from '@/guided/strength-model';
import { applyHyroxSessionBenchmarks, summariseHyroxSession } from '@/calculations/hyrox-session-benchmarks';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import type { HyroxStation } from '@/types/triathlon';

const ACCESS = { sled: 'always' as const, skiErg: true, rowErg: true };

/** The same circuit with every station component covering the full station
 *  (no raceFraction), as a full-station session would. */
function fullStation<T extends { hyroxComponents?: Array<{ raceFraction?: number }> }>(w: T): T {
  return { ...w, hyroxComponents: (w.hyroxComponents ?? []).map(({ raceFraction: _f, ...c }) => c) };
}

/** Walk a parsed session to completion exactly as the overlay does: tick work
 *  time, tap Complete set, skip the timed rest, repeat. Returns the records. */
function walkSession(session: StrengthSession, workSecFor: (set: SetRecord['setIndex'], exIdx: number) => number): SetRecord[] {
  const c = new StrengthGuideController(session, { ticker: () => () => {} });
  c.start();
  let guard = 0;
  while (c.phase !== 'done' && guard++ < 2000) {
    if (c.phase === 'active') {
      const set = c.currentSet()!;
      c.tick(workSecFor(set.setIndex, set.exerciseIndex));
      c.completeSet();
    } else if (c.phase === 'resting') {
      c.skipRest();
    } else if (c.phase === 'paused') {
      c.startNextSet(0);
    } else {
      c.tick(1);
    }
  }
  return c.setRecords;
}

describe('HYROX guided flow — density end to end', () => {
  const density = generateHyroxStation({
    kind: 'station_density', targetMinutes: 55, band: 'intermediate',
    stationAccess: ACCESS, phase: 'build', slotIndex: 0,
  });

  it('generates a multi-round circuit with rest encoded on every station', () => {
    expect(density.hyroxRounds!).toBeGreaterThanOrEqual(2);
    // Race pace (lane H2b): 90 s after every set, between rounds too.
    expect(density.hyroxRoundRestSec).toBe(90);
    const stations = density.hyroxComponents!.filter(c => c.type !== 'run');
    expect(stations.every(c => c.restAfterSec === 90)).toBe(true);
    expect(stations.every(c => c.raceFraction === 0.25)).toBe(true);
  });

  it('parser expands rounds and uses timed rest (not athlete-paced)', () => {
    const session = parseHyroxSession(density)!;
    expect(session.manualAdvance).toBe(false);
    expect(session.sets.length).toBe(density.hyroxRounds! * density.hyroxComponents!.length);
  });

  it('the controller walks every round and records a time per set', () => {
    const session = parseHyroxSession(density)!;
    const records = walkSession(session, () => 350);
    expect(records.length).toBe(session.sets.length);
    expect(records.every(r => r.durationSec > 0)).toBe(true);
  });

  it('quarter-station sets record a best set but teach no benchmark', () => {
    const session = parseHyroxSession(density)!;
    const station0 = density.hyroxComponents![0].type as HyroxStation;
    const records = walkSession(session, (round, exIdx) => (exIdx === 0 ? [100, 90, 80, 80][round] ?? 80 : 120));
    const state = {
      hyroxConfig: { format: 'open_singles', stationBenchmarksSingles: { [station0]: 9999 }, stationAccess: ACCESS },
    } as any;
    const s0 = summariseHyroxSession(density, records, state).find(r => r.station === station0)!;
    expect(s0.bestSec).toBe(80);
    expect(s0.partial).toBe(true);
    expect(s0.percentile).toBeNull();
    expect(s0.eligible).toBe(false);
    expect(applyHyroxSessionBenchmarks(density, records, state)).toEqual([]);
    expect(state.hyroxConfig.stationBenchmarksSingles[station0]).toBe(9999);
  });

  it('learning picks the best round of a full-station session and updates the benchmark it beats', () => {
    const full = fullStation(density);
    const session = parseHyroxSession(full)!;
    const station0 = full.hyroxComponents![0].type as HyroxStation;

    // Station 0 gets a fast final round (300s); everything else steady at 350s.
    const records = walkSession(session, (round, exIdx) =>
      exIdx === 0 ? [400, 380, 300, 300, 300][round] ?? 300 : 350);

    // Best round for station 0 should be the fastest we fed it.
    const summary = summariseHyroxSession(full, records, {
      hyroxConfig: { format: 'open_singles', stationBenchmarksSingles: {}, stationAccess: ACCESS },
    } as any);
    const s0 = summary.find(r => r.station === station0)!;
    expect(s0.bestSec).toBe(300);
    expect(s0.percentile).not.toBeNull(); // race-pace → comparable

    // With a deliberately slow stored benchmark, the best round beats it and writes.
    const state = {
      hyroxConfig: { format: 'open_singles', stationBenchmarksSingles: { [station0]: 9999 }, stationAccess: ACCESS },
    } as any;
    const applied = applyHyroxSessionBenchmarks(full, records, state);
    expect(applied.find(a => a.station === station0)?.toSec).toBe(300);
    expect(state.hyroxConfig.stationBenchmarksSingles[station0]).toBe(300);
    const hist = state.hyroxConfig.stationBenchmarkHistory[station0];
    expect(hist[hist.length - 1]).toMatchObject({ sec: 300, source: 'session' });
  });
});

describe('HYROX guided flow — a faster session produces a faster forecast', () => {
  it('a full-station session that beats a station benchmark lowers the predicted finish time', () => {
    const density = fullStation(generateHyroxStation({
      kind: 'station_density', targetMinutes: 55, band: 'intermediate',
      stationAccess: ACCESS, phase: 'build', slotIndex: 0, weakest: 'wall_balls',
    }));
    const station0 = density.hyroxComponents![0].type as HyroxStation; // wall_balls (the weakest leads)
    expect(station0).toBe('wall_balls');

    // State with a deliberately SLOW wall_balls benchmark (600s). The circuit's
    // other stations hold fast benchmarks (200 s), so their 350 s rounds write
    // nothing and only wall balls moves the forecast; the rest are on seeds.
    const others = Object.fromEntries(density.hyroxComponents!.filter(c => c.type !== station0).map(c => [c.type, 200]));
    const state = {
      hyroxConfig: {
        athleteBand: 'intermediate', format: 'open_singles',
        stationAccess: ACCESS, stationBenchmarksSingles: { ...others, [station0]: 600 },
      },
    } as any;

    const before = predictHyroxRace(state);
    expect(before).not.toBeNull();

    // Run a real session whose best wall_balls round is 300s (beats the 600s benchmark).
    const session = parseHyroxSession(density)!;
    const records = walkSession(session, (round, exIdx) =>
      exIdx === 0 ? [400, 380, 300, 300, 300][round] ?? 300 : 350);
    const applied = applyHyroxSessionBenchmarks(density, records, state);
    expect(applied.find(a => a.station === station0)?.toSec).toBe(300);

    // The prediction must now be faster — the learning fed through to the forecast.
    const after = predictHyroxRace(state);
    expect(after!.totalSec).toBeLessThan(before!.totalSec);
    // wall_balls dropped 600 → 300, so the whole-race delta is on that order.
    expect(before!.totalSec - after!.totalSec).toBeGreaterThan(120);
  });
});

describe('HYROX guided flow — technique is shown but never learned from', () => {
  it('technique session writes no benchmark even when faster', () => {
    const technique = generateHyroxStation({
      kind: 'station_technique', targetMinutes: 55, band: 'intermediate',
      stationAccess: ACCESS, phase: 'build', slotIndex: 0,
    });
    const session = parseHyroxSession(technique)!;
    const records = walkSession(session, () => 100); // implausibly fast on purpose
    const station0 = technique.hyroxComponents![0].type as HyroxStation;
    const state = {
      hyroxConfig: { format: 'open_singles', stationBenchmarksSingles: { [station0]: 9999 }, stationAccess: ACCESS },
    } as any;
    const applied = applyHyroxSessionBenchmarks(technique, records, state);
    expect(applied).toEqual([]);
    expect(state.hyroxConfig.stationBenchmarksSingles[station0]).toBe(9999);
  });
});
