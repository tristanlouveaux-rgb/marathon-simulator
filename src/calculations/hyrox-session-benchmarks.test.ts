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
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';
import { predictHyroxRace, resolveHyroxStationBenchmarks } from './race-prediction.hyrox';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { SetRecord } from '@/guided/strength-controller';

// Competitive (elite) seed times used as the sanity floor: wall_balls 265, row_erg 238.
const WB: HyroxComponent = { type: 'wall_balls', reps: 100, mtl: 0 };
const ROW: HyroxComponent = { type: 'row_erg', distanceM: 1000, mtl: 0 };

function state(over: Partial<NonNullable<SimulatorState['hyroxConfig']>> = {}): SimulatorState {
  return {
    hyroxConfig: { format: 'open_singles', athleteBand: 'intermediate', stationBenchmarksSingles: {}, ...over },
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

describe('session bests compare with the benchmark the forecast reads (review 2026-10-13)', () => {
  // An Open Singles athlete whose station times come from a doubles race:
  // the singles slot is empty, every station resolves from the doubles slot
  // and reads in singles terms (the pair's time ÷ the forecast's ratio).
  // Before, the session check read only the singles slot, found nothing, and
  // took any round as an improvement: a 348 s row replaced a 307.6 s
  // converted split and the forecast got 50 s slower.
  const DOUBLES_SPLITS: Record<HyroxStation, number> = {
    ski_erg: 200, sled_push: 140, sled_pull: 190, burpee_broad_jumps: 210,
    row_erg: 220, farmer_carry: 80, sandbag_lunges: 200, wall_balls: 320,
  };
  const SINGLES_TIMES: Record<HyroxStation, number> = {
    ski_erg: 270, sled_push: 200, sled_pull: 260, burpee_broad_jumps: 300,
    row_erg: 290, farmer_carry: 110, sandbag_lunges: 280, wall_balls: 430,
  };
  const today = new Date().toISOString().slice(0, 10);
  const raceHistory = (splits: Record<HyroxStation, number>, format: 'open_doubles' | 'open_singles') =>
    Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, [
      { dateISO: today, sec: splits[st], source: 'race' as const, format, proWeights: false },
    ]]));
  const fullState = (over: Partial<NonNullable<SimulatorState['hyroxConfig']>>): SimulatorState => ({
    hyroxConfig: {
      format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3,
      stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
      ...over,
    },
  } as any as SimulatorState);
  const rowSession = workout('hyrox_station_density', [ROW], 2);
  const rowRounds = (sec: number) => [rec(0, sec + 6, 0), rec(0, sec, 1)];
  const singlesFromDoubles = () => fullState({
    format: 'open_singles',
    stationBenchmarksDoubles: { ...DOUBLES_SPLITS },
    stationBenchmarkHistory: raceHistory(DOUBLES_SPLITS, 'open_doubles'),
  });
  const resolvedRow = (s: SimulatorState) => resolveHyroxStationBenchmarks(s)!.stations.find(b => b.station === 'row_erg')!;

  it('singles target from doubles splits: a slower round is no improvement and the forecast does not move', () => {
    const s = singlesFromDoubles();
    const before = predictHyroxRace(s)!;
    const converted = resolvedRow(s).sec!;
    // The converted value is the forecast's own row line.
    expect(converted).toBeCloseTo(before.stations.find(l => l.station === 'row_erg')!.baseSec, 6);
    expect(converted).toBeCloseTo(DOUBLES_SPLITS.row_erg / before.crossFormatStationRatio!, 9);

    const slow = Math.round(converted) + 40;
    const r = summariseHyroxSession(rowSession, rowRounds(slow), s)[0];
    // Compared to the whole second Stats shows and the plan prescribes.
    expect(r.benchmarkSec).toBe(Math.round(converted));
    expect(r.isImprovement).toBe(false);
    expect(applyHyroxSessionBenchmarks(rowSession, rowRounds(slow), s)).toEqual([]);
    expect(s.hyroxConfig!.stationBenchmarksSingles?.row_erg).toBeUndefined();
    expect(predictHyroxRace(s)!.totalSec).toBe(before.totalSec);
  });

  it('singles target from doubles splits: a faster round improves from the converted value, its own station only', () => {
    const s = singlesFromDoubles();
    const converted = resolvedRow(s).sec!;
    const fast = Math.floor(converted) - 20;
    const applied = applyHyroxSessionBenchmarks(rowSession, rowRounds(fast), s);
    expect(applied).toHaveLength(1);
    expect(applied[0].fromSec).toBe(Math.round(converted));
    expect(applied[0].toSec).toBe(fast);
    expect(s.hyroxConfig!.stationBenchmarksSingles!.row_erg).toBe(fast);
    const after = predictHyroxRace(s)!;
    expect(after.stations.find(l => l.station === 'row_erg')!.baseSec).toBe(fast);
    expect(after.stations.filter(l => l.teamTimeSplit)).toHaveLength(7);
    expect(after.calibratedCount).toBe(8);
  });

  it('doubles target reading singles benchmarks: compares with the singles time as stored', () => {
    const s = fullState({ format: 'open_doubles', stationBenchmarksSingles: { ...SINGLES_TIMES } });
    const slow = summariseHyroxSession(rowSession, rowRounds(SINGLES_TIMES.row_erg + 10), s)[0];
    expect(slow.benchmarkSec).toBe(SINGLES_TIMES.row_erg);
    expect(slow.isImprovement).toBe(false);
    const fast = summariseHyroxSession(rowSession, rowRounds(SINGLES_TIMES.row_erg - 10), s)[0];
    expect(fast.isImprovement).toBe(true);
    expect(fast.deltaSec).toBe(10);
  });

  it('doubles target, own doubles race split: a solo round is compared with the split\'s solo equivalent (the pair\'s time ÷ the station ratio)', () => {
    const s = fullState({
      format: 'open_doubles',
      stationBenchmarksDoubles: { ...DOUBLES_SPLITS },
      stationBenchmarkHistory: raceHistory(DOUBLES_SPLITS, 'open_doubles'),
    });
    const prediction = predictHyroxRace(s)!;
    const row = resolvedRow(s);
    expect(row.teamTimeSplit).toBe(true);
    // One number per station for Stats, the generators and this check: the
    // pair's time ÷ the forecast's own ratio.
    expect(row.sec!).toBeCloseTo(DOUBLES_SPLITS.row_erg / prediction.doubles!.stationRatio, 9);
    expect(row.sec!).toBeGreaterThan(DOUBLES_SPLITS.row_erg);

    // Slower than the pair's time but faster than its solo equivalent: one
    // athlete beat the split's solo equivalent.
    const solo = Math.floor(row.sec!) - 20;
    expect(solo).toBeGreaterThan(DOUBLES_SPLITS.row_erg);
    const r = summariseHyroxSession(rowSession, rowRounds(solo), s)[0];
    expect(r.benchmarkSec).toBe(Math.round(row.sec!));
    expect(r.isImprovement).toBe(true);
    // Slower than the solo equivalent: no improvement.
    const slow = summariseHyroxSession(rowSession, rowRounds(Math.ceil(row.sec!) + 10), s)[0];
    expect(slow.isImprovement).toBe(false);
  });

  it('doubles target, own doubles race split: an improvement moves the benchmark and the forecast row faster, never slower', () => {
    // Review 2026-10-13 probe: Open Doubles, 8 doubles race splits plus a
    // venue, a guided row round of 300 s. The summary read 'Benchmark
    // updated' while the Stats row and the next plan's target went from the
    // pair's time (3:40) to 5:00.
    const s = fullState({
      format: 'open_doubles',
      venueId: 'london-excel',
      stationBenchmarksDoubles: { ...DOUBLES_SPLITS },
      stationBenchmarkHistory: raceHistory(DOUBLES_SPLITS, 'open_doubles'),
    });
    const before = resolvedRow(s).sec!;
    const forecastBefore = predictHyroxRace(s)!.stations.find(l => l.station === 'row_erg')!.baseSec;
    expect(before).toBeGreaterThan(300);
    const applied = applyHyroxSessionBenchmarks(rowSession, rowRounds(300), s);
    expect(applied).toHaveLength(1);
    expect(applied[0].fromSec).toBe(Math.round(before));
    expect(applied[0].toSec).toBe(300);
    const after = resolvedRow(s);
    expect(after.teamTimeSplit).toBe(false);
    expect(after.sec).toBe(300);
    expect(after.sec!).toBeLessThan(before);
    expect(predictHyroxRace(s)!.stations.find(l => l.station === 'row_erg')!.baseSec).toBeLessThan(forecastBefore);
  });
});

describe('session bests compare and store at the target\'s weights (review 2026-10-13, Pro race splits)', () => {
  // An Open Singles athlete whose sled push comes from a Pro race (260 s at
  // Pro loads). The forecast reads it at Open weights, 260 ÷ the Pro sled
  // multiplier (226.1 s). The session check compared Open rounds with the
  // stored Pro time: a 243 s round read 'Benchmark updated' from 260 and moved
  // the forecast row 226.1 to 243, the total 17 s slower.
  const today = new Date().toISOString().slice(0, 10);
  const SLED: HyroxComponent = { type: 'sled_push', distanceM: 50, mtl: 0 };
  const sledSession = workout('hyrox_station_density', [SLED], 2);
  const sledRounds = (sec: number) => [rec(0, sec + 5, 0), rec(0, sec, 1)];
  const base = (over: Partial<NonNullable<SimulatorState['hyroxConfig']>>): SimulatorState => ({
    hyroxConfig: {
      format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3,
      stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
      ...over,
    },
  } as any as SimulatorState);
  const proSinglesSplit = () => base({
    format: 'open_singles',
    stationBenchmarksSingles: { sled_push: 260 },
    stationBenchmarkHistory: { sled_push: [{ dateISO: today, sec: 260, source: 'race', format: 'pro_singles', proWeights: true }] },
  });
  const proDoublesSplit = () => base({
    format: 'open_singles',
    stationBenchmarksDoubles: { sled_push: 190 },
    stationBenchmarkHistory: { sled_push: [{ dateISO: today, sec: 190, source: 'race', format: 'pro_doubles', proWeights: true }] },
  });
  const sledLine = (s: SimulatorState) => predictHyroxRace(s)!.stations.find(l => l.station === 'sled_push')!;
  const sledResolved = (s: SimulatorState) => resolveHyroxStationBenchmarks(s)!.stations.find(b => b.station === 'sled_push')!;

  for (const [name, make] of [['Pro singles split', proSinglesSplit], ['Pro doubles split', proDoublesSplit]] as const) {
    it(`Open target, ${name}: the benchmark is the forecast's Open equivalent, and a slower round changes nothing`, () => {
      const s = make();
      const before = predictHyroxRace(s)!;
      const openEquivalent = sledLine(s).baseSec;
      // The resolver reads the forecast's own number at Open weights.
      expect(sledResolved(s).sec!).toBeCloseTo(openEquivalent, 9);
      expect(openEquivalent).toBeLessThan(name === 'Pro singles split' ? 260 : 190 / before.crossFormatStationRatio!);

      // Faster than the stored Pro time, slower than its Open equivalent.
      const slow = Math.round(openEquivalent) + 17;
      const r = summariseHyroxSession(sledSession, sledRounds(slow), s)[0];
      expect(r.benchmarkSec).toBe(Math.round(openEquivalent));
      expect(r.isImprovement).toBe(false);
      expect(applyHyroxSessionBenchmarks(sledSession, sledRounds(slow), s)).toEqual([]);
      expect(predictHyroxRace(s)!.totalSec).toBe(before.totalSec);
      expect(sledLine(s).baseSec).toBeCloseTo(openEquivalent, 9);
    });
  }

  it('Open target, Pro singles split: the reviewer\'s probe numbers', () => {
    const s = proSinglesSplit();
    expect(sledResolved(s).sec!).toBeCloseTo(260 / 1.15, 9);
    const r = summariseHyroxSession(sledSession, sledRounds(243), s)[0];
    expect(r.benchmarkSec).toBe(226);
    expect(r.isImprovement).toBe(false);
    expect(r.deltaSec).toBe(-17);
  });

  it('Open target: a faster round is stored at Open weights and the forecast reads it as is', () => {
    const s = proSinglesSplit();
    const applied = applyHyroxSessionBenchmarks(sledSession, sledRounds(215), s);
    expect(applied).toEqual([expect.objectContaining({ station: 'sled_push', fromSec: 226, toSec: 215 })]);
    const hist = s.hyroxConfig!.stationBenchmarkHistory!.sled_push!;
    expect(hist[hist.length - 1]).toMatchObject({ sec: 215, source: 'session', format: 'open_singles', proWeights: false });
    expect(sledLine(s).baseSec).toBe(215);
  });

  it('Pro target with Open-weight tests: a round done at Pro loads is stored at Pro weights, not scaled again', () => {
    // The athlete's toggle says benchmarks are at Open weights, so a station
    // test is scaled × the Pro multiplier. A guided round is done at the Pro
    // target's own loads (loadTier), so the forecast reads it as is.
    const s = base({ format: 'pro_singles', benchmarksAtProWeights: false, stationBenchmarksSingles: { sled_push: 230 } });
    const target = Math.round(230 * 1.15);
    expect(summariseHyroxSession(sledSession, sledRounds(target), s)[0].benchmarkSec).toBe(target);
    const best = target - 10;
    applyHyroxSessionBenchmarks(sledSession, sledRounds(best), s);
    const hist = s.hyroxConfig!.stationBenchmarkHistory!.sled_push!;
    expect(hist[hist.length - 1]).toMatchObject({ sec: best, source: 'session', format: 'pro_singles', proWeights: true });
    expect(sledLine(s).baseSec).toBe(best);
    expect(sledResolved(s).sec).toBe(best);
  });
});

describe('session bests compare with the whole second Stats shows (review 2026-10-13, sub-second ties)', () => {
  // Converted benchmarks are fractional; rounds are timed to the whole second.
  // A round 0.09 s under a converted 226.09 read 'Benchmark updated. 0s faster
  // than your best.' while Stats showed the same 3:46.
  const today = new Date().toISOString().slice(0, 10);
  const SLED: HyroxComponent = { type: 'sled_push', distanceM: 50, mtl: 0 };
  const sledSession = workout('hyrox_station_density', [SLED], 2);
  const s = () => ({
    hyroxConfig: {
      format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3,
      stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
      stationBenchmarksSingles: { sled_push: 260 },
      stationBenchmarkHistory: { sled_push: [{ dateISO: today, sec: 260, source: 'race', format: 'pro_singles', proWeights: true }] },
    },
  } as any as SimulatorState);

  it('a round equal to the rounded benchmark is a tie, not an improvement', () => {
    const st = s();
    const converted = resolveHyroxStationBenchmarks(st)!.stations.find(b => b.station === 'sled_push')!.sec!;
    expect(converted % 1).toBeGreaterThan(0);
    expect(converted % 1).toBeLessThan(0.5);
    const tie = Math.round(converted);
    expect(tie).toBeLessThan(converted);
    const r = summariseHyroxSession(sledSession, [rec(0, tie + 4, 0), rec(0, tie, 1)], st)[0];
    expect(r.deltaSec).toBe(0);
    expect(r.isImprovement).toBe(false);
    expect(applyHyroxSessionBenchmarks(sledSession, [rec(0, tie + 4, 0), rec(0, tie, 1)], st)).toEqual([]);
  });

  it('a round one second under the rounded benchmark improves by a whole second', () => {
    const st = s();
    const shown = Math.round(resolveHyroxStationBenchmarks(st)!.stations.find(b => b.station === 'sled_push')!.sec!);
    const r = summariseHyroxSession(sledSession, [rec(0, shown + 3, 0), rec(0, shown - 1, 1)], st)[0];
    expect(r.isImprovement).toBe(true);
    expect(r.deltaSec).toBe(1);
  });
});
