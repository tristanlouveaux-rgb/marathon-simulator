import { describe, it, expect } from 'vitest';
import {
  summariseHyroxSession,
  summariseHyroxRuns,
  buildHyroxSessionRecap,
  applyHyroxSessionBenchmarks,
  isRacePaceHyroxSession,
} from './hyrox-session-benchmarks';
import type { SimulatorState } from '@/types/state';
import type { Workout } from '@/types/state';
import type { HyroxComponent } from '@/types/triathlon';
import type { SetRecord } from '@/guided/strength-controller';

// Competitive (elite) seed times used as the sanity floor: wall_balls 265, row_erg 238.
const WB: HyroxComponent = { type: 'wall_balls', reps: 100, mtl: 0 };
const ROW: HyroxComponent = { type: 'row_erg', distanceM: 1000, mtl: 0 };

function state(over: Partial<NonNullable<SimulatorState['hyroxConfig']>> = {}): SimulatorState {
  return {
    hyroxConfig: { format: 'open_singles', stationBenchmarksSingles: {}, ...over },
  } as any as SimulatorState;
}

function workout(t: string, components: HyroxComponent[], rounds = 2): Workout {
  return { t, n: 'X', d: '', hyroxComponents: components, hyroxRounds: rounds } as any as Workout;
}

const rec = (exerciseIndex: number, durationSec: number, setIndex = 0): SetRecord =>
  ({ exerciseName: 'x', exerciseIndex, setIndex, setCount: 2, reps: '', durationSec });

/** 2 rounds of [wall_balls, row_erg]: r0 then r1, matching the parser's expansion order. */
function densityRecords(wb: [number, number], row: [number, number]): SetRecord[] {
  return [rec(0, wb[0], 0), rec(1, row[0], 0), rec(0, wb[1], 1), rec(1, row[1], 1)];
}

describe('isRacePaceHyroxSession', () => {
  it('is true for density and brick, false for technique / assessment / mini', () => {
    expect(isRacePaceHyroxSession('hyrox_station_density')).toBe(true);
    expect(isRacePaceHyroxSession('hyrox_brick')).toBe(true);
    expect(isRacePaceHyroxSession('hyrox_station_technique')).toBe(false);
    expect(isRacePaceHyroxSession('hyrox_mini_brick')).toBe(false);
    expect(isRacePaceHyroxSession('hyrox_assessment')).toBe(false);
  });
});

describe('summariseHyroxSession', () => {
  it('takes the best (fastest) round per station', () => {
    const w = workout('hyrox_station_density', [WB, ROW]);
    const r = summariseHyroxSession(w, densityRecords([300, 280], [250, 240]), state());
    const wb = r.find(x => x.station === 'wall_balls')!;
    const row = r.find(x => x.station === 'row_erg')!;
    expect(wb.bestSec).toBe(280);
    expect(row.bestSec).toBe(240);
  });

  it('flags an improvement when the best round beats the stored benchmark', () => {
    const w = workout('hyrox_station_density', [WB, ROW]);
    const s = state({ stationBenchmarksSingles: { wall_balls: 320, row_erg: 230 } });
    const r = summariseHyroxSession(w, densityRecords([300, 280], [250, 240]), s);
    const wb = r.find(x => x.station === 'wall_balls')!;
    const row = r.find(x => x.station === 'row_erg')!;
    expect(wb.isImprovement).toBe(true);    // 280 beats 320
    expect(wb.deltaSec).toBe(40);
    expect(row.isImprovement).toBe(false);  // 240 is slower than the 230 best (PB-only)
    expect(row.deltaSec).toBe(-10);
  });

  it('never improves from a technique session (submaximal by design)', () => {
    const w = workout('hyrox_station_technique', [WB, ROW]);
    const s = state({ stationBenchmarksSingles: { wall_balls: 320 } });
    const r = summariseHyroxSession(w, densityRecords([300, 280], [250, 240]), s);
    expect(r.every(x => x.isImprovement === false)).toBe(true);
    expect(r.every(x => x.percentile === null)).toBe(true);  // not comparable
  });

  it('rejects implausibly fast times below the elite seed (sanity floor)', () => {
    const w = workout('hyrox_station_density', [WB, ROW]);
    // wall_balls 100 in 120s is faster than the competitive seed (265s) — a timing slip.
    const r = summariseHyroxSession(w, densityRecords([120, 120], [240, 240]), state());
    const wb = r.find(x => x.station === 'wall_balls')!;
    expect(wb.eligible).toBe(false);
    expect(wb.isImprovement).toBe(false);
  });
});

describe('summariseHyroxRuns', () => {
  const RUN: HyroxComponent = { type: 'run', distanceM: 1000, mtl: 0 };

  it('returns one leg per run record, in round order, with pace per km', () => {
    // Brick: 2 rounds of [run, wall_balls]. Run is exerciseIndex 0.
    const w = workout('hyrox_brick', [RUN, WB]);
    const records = [
      rec(0, 250, 0), rec(1, 400, 0),   // round 1: run 250s, station 400s
      rec(0, 270, 1), rec(1, 410, 1),   // round 2: run 270s (fade), station 410s
    ];
    const legs = summariseHyroxRuns(w, records);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ round: 1, durationSec: 250, distanceM: 1000, paceSecKm: 250 });
    expect(legs[1]).toMatchObject({ round: 2, durationSec: 270, paceSecKm: 270 });
  });

  it('computes pace from distance for sub-km legs (mini brick 500m)', () => {
    const run500: HyroxComponent = { type: 'run', distanceM: 500, mtl: 0 };
    const w = workout('hyrox_mini_brick', [run500, WB]);
    const legs = summariseHyroxRuns(w, [rec(0, 130, 0), rec(1, 300, 0)]);
    expect(legs[0]).toMatchObject({ distanceM: 500, durationSec: 130, paceSecKm: 260 }); // 130s / 0.5km
  });

  it('is empty for station-only sessions', () => {
    const w = workout('hyrox_station_density', [WB, ROW]);
    expect(summariseHyroxRuns(w, densityRecords([300, 280], [250, 240]))).toEqual([]);
  });
});

describe('buildHyroxSessionRecap', () => {
  const RUN: HyroxComponent = { type: 'run', distanceM: 1000, mtl: 0 };

  it('captures rounds, per-station best, and run legs for a brick', () => {
    const w = workout('hyrox_brick', [RUN, WB]);
    const recap = buildHyroxSessionRecap(w, [
      rec(0, 250, 0), rec(1, 410, 0),
      rec(0, 270, 1), rec(1, 400, 1),
    ])!;
    expect(recap.rounds).toBe(2);
    expect(recap.stations).toEqual([{ station: 'wall_balls', bestSec: 400 }]);
    expect(recap.runs.map(r => r.round)).toEqual([1, 2]);
    expect(recap.runs[0].paceSecKm).toBe(250);
  });

  it('returns null for a non-HYROX workout', () => {
    expect(buildHyroxSessionRecap({ t: 'gym', n: 'X', d: '' } as any, [rec(0, 100, 0)])).toBeNull();
  });
});

describe('applyHyroxSessionBenchmarks', () => {
  it('writes the improved scalar + a session-sourced history entry, PB-only', () => {
    const w = workout('hyrox_station_density', [WB, ROW]);
    const s = state({ stationBenchmarksSingles: { wall_balls: 320, row_erg: 230 } });
    const applied = applyHyroxSessionBenchmarks(w, densityRecords([300, 280], [250, 240]), s);

    expect(applied.map(a => a.station)).toEqual(['wall_balls']);   // only the improver
    expect(s.hyroxConfig!.stationBenchmarksSingles!.wall_balls).toBe(280);
    expect(s.hyroxConfig!.stationBenchmarksSingles!.row_erg).toBe(230); // unchanged
    const hist = s.hyroxConfig!.stationBenchmarkHistory!.wall_balls!;
    expect(hist[hist.length - 1]).toMatchObject({ sec: 280, source: 'session', format: 'open_singles' });
  });

  it('calibrates a station that has no benchmark yet', () => {
    const w = workout('hyrox_station_density', [WB, ROW]);
    const s = state({ stationBenchmarksSingles: {} });
    const applied = applyHyroxSessionBenchmarks(w, densityRecords([300, 280], [250, 240]), s);
    expect(applied.map(a => a.station).sort()).toEqual(['row_erg', 'wall_balls']);
    expect(s.hyroxConfig!.stationBenchmarksSingles!.wall_balls).toBe(280);
    expect(s.hyroxConfig!.stationBenchmarksSingles!.row_erg).toBe(240);
  });

  it('writes the doubles slot when the active format is doubles', () => {
    const w = workout('hyrox_station_density', [WB, ROW]);
    const s = state({ format: 'open_doubles', stationBenchmarksDoubles: { wall_balls: 320 } });
    applyHyroxSessionBenchmarks(w, densityRecords([300, 280], [250, 240]), s);
    expect(s.hyroxConfig!.stationBenchmarksDoubles!.wall_balls).toBe(280);
    expect(s.hyroxConfig!.stationBenchmarksSingles ?? {}).toEqual({});
  });

  it('writes nothing for a technique session', () => {
    const w = workout('hyrox_station_technique', [WB, ROW]);
    const s = state({ stationBenchmarksSingles: { wall_balls: 320 } });
    const applied = applyHyroxSessionBenchmarks(w, densityRecords([300, 280], [250, 240]), s);
    expect(applied).toEqual([]);
    expect(s.hyroxConfig!.stationBenchmarksSingles!.wall_balls).toBe(320);
  });
});
