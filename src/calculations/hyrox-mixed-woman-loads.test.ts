/**
 * A woman in Mixed Doubles races M-Open loads with a 2.70 m wall-ball target,
 * exactly the Women Pro standard (hyrox-division.ts), while her singles field
 * is Open Singles women (W-Open loads). Review of lane H3b, 2026-10-13: her
 * seeds were Women Open medians at W-Open loads and her M-Open tests were
 * placed on the W-Open table, so the plan prescribed W-Open times at M-Open
 * loads and a test at her prescribed load made the forecast slower.
 *
 * Every expected value is read from the code under test or the data module.
 */
import { describe, it, expect } from 'vitest';
import type { SimulatorState } from '@/types/state';
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';
import type { Workout } from '@/types/state';
import type { SetRecord } from '@/guided/strength-controller';
import { HYROX_STATION_ORDER, stationSeedTimesFor } from '@/constants/hyrox-benchmarks';
import {
  predictHyroxRace,
  hyroxPlanningStationBenchmarks,
  hyroxStationSeedsForState,
  resolveHyroxStationBenchmarks,
} from './race-prediction.hyrox';
import {
  hyroxSoloLoadsArePro,
  hyroxSoloFrame,
  hyroxOpenToProSec,
  hyroxProToOpenSec,
  hyroxStationPercentile,
  hyroxResultsTable,
  secondsAtPercentileIn,
  HYROX_LOADED_STATIONS,
} from './hyrox-results';
import { hyroxDoublesTables, doublesStationTeamSec, doublesStationSoloSec } from './hyrox-doubles';
import { summariseHyroxSession, applyHyroxSessionBenchmarks } from './hyrox-session-benchmarks';
import { hyroxLoadTier } from './hyrox-division';

function buildState(over: Partial<NonNullable<SimulatorState['hyroxConfig']>>, sex: SimulatorState['biologicalSex']): SimulatorState {
  return {
    biologicalSex: sex,
    hyroxConfig: {
      format: 'open_doubles', division: 'mixed', athleteBand: 'intermediate', hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3,
      stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
      ...over,
    },
  } as unknown as SimulatorState;
}

const mixedWoman = (over: Partial<NonNullable<SimulatorState['hyroxConfig']>> = {}) => buildState(over, 'female');
const TODAY = new Date().toISOString().slice(0, 10);
/** Solo full tests at the target's (M-Open) loads, in the doubles or singles
 *  slot, with the history entries that mark them as tests. */
function soloTests(slot: 'doubles' | 'singles', times: Partial<Record<HyroxStation, number>>): Partial<NonNullable<SimulatorState['hyroxConfig']>> {
  const history = Object.fromEntries(Object.entries(times).map(([st, sec]) => [st, [
    { dateISO: TODAY, sec, source: 'full_test' as const, format: slot === 'doubles' ? 'open_doubles' as const : 'open_singles' as const },
  ]]));
  return slot === 'doubles'
    ? { stationBenchmarksDoubles: { ...times }, stationBenchmarkHistory: history }
    : { stationBenchmarksSingles: { ...times }, stationBenchmarkHistory: history };
}
const womenPro = () => buildState({ format: 'pro_singles', division: undefined }, 'female');
const line = (s: SimulatorState, st: HyroxStation) => predictHyroxRace(s)!.stations.find(l => l.station === st)!;

describe('solo load family', () => {
  it('reads the canonical load tier: Pro formats and a Mixed woman are the Pro tier of their sex', () => {
    expect(hyroxLoadTier('open_doubles', 'female', 'mixed')).toBe('M-Open');
    expect(hyroxSoloLoadsArePro('open_doubles', 'female', 'mixed')).toBe(true);
    expect(hyroxSoloLoadsArePro('pro_singles', 'female', undefined)).toBe(true);
    expect(hyroxSoloLoadsArePro('pro_doubles', 'male', 'men')).toBe(true);
    expect(hyroxSoloLoadsArePro('open_doubles', 'male', 'mixed')).toBe(false);
    expect(hyroxSoloLoadsArePro('open_doubles', 'female', 'women')).toBe(false);
    expect(hyroxSoloLoadsArePro('open_singles', 'female', undefined)).toBe(false);
    // A Mixed pair with no sex on file stays in the format's own family.
    expect(hyroxSoloLoadsArePro('open_doubles', undefined, 'mixed')).toBe(false);
  });

  it('only the Mixed woman converts between her solo loads and her field', () => {
    expect(hyroxSoloFrame('open_doubles', 'female', 'mixed')).toEqual({
      field: { format: 'open_singles', sex: 'female' }, loadsPro: true, proLoadsInOpenField: true,
    });
    expect(hyroxSoloFrame('pro_singles', 'female', undefined).proLoadsInOpenField).toBe(false);
    expect(hyroxSoloFrame('open_doubles', 'male', 'mixed').proLoadsInOpenField).toBe(false);
    expect(hyroxDoublesTables('open_doubles', 'female', 'mixed').soloProLoadsInOpenField).toBe(true);
    expect(hyroxDoublesTables('open_doubles', 'male', 'mixed').soloProLoadsInOpenField).toBeUndefined();
  });
});

describe('Mixed woman: seeds and planning targets at her M-Open loads', () => {
  it('her planning targets equal a Women Pro athlete\'s for the same seed field', () => {
    expect(hyroxPlanningStationBenchmarks(mixedWoman())).toEqual(hyroxPlanningStationBenchmarks(womenPro()));
  });

  it('her seeds are the Women Open band medians converted to the Women Pro tier', () => {
    const open = stationSeedTimesFor('intermediate', 'open_singles', 'female');
    const seeds = hyroxStationSeedsForState(mixedWoman());
    for (const st of HYROX_STATION_ORDER) {
      expect(seeds[st]).toBeCloseTo(hyroxOpenToProSec(st, open[st], 'female'), 9);
      if (HYROX_LOADED_STATIONS.includes(st)) expect(seeds[st]).toBeGreaterThan(open[st]);
      else expect(seeds[st]).toBe(open[st]);
    }
  });

  it('a Mixed man keeps the Men Open medians (M-Open is the Men Open tier)', () => {
    const s = buildState({}, 'male');
    expect(hyroxStationSeedsForState(s)).toEqual(stationSeedTimesFor('intermediate', 'open_singles', 'male'));
  });
});

describe('Mixed woman: forecast', () => {
  it('a test at her seed-at-target value leaves every station line unchanged', () => {
    const seeds = hyroxStationSeedsForState(mixedWoman());
    const before = predictHyroxRace(mixedWoman())!;
    // Tests logged under her Mixed Doubles target (M-Open loads), and tests
    // she logged earlier under Open Singles at W-Open loads, at the Women
    // Open band medians: both are the same athlete as the seed.
    const cases: Array<[string, Partial<NonNullable<SimulatorState['hyroxConfig']>>]> = [
      ['M-Open tests', soloTests('doubles', seeds)],
      ['W-Open tests from Open Singles', soloTests('singles', stationSeedTimesFor('intermediate', 'open_singles', 'female'))],
    ];
    for (const [name, over] of cases) {
      const after = predictHyroxRace(mixedWoman(over))!;
      for (const st of HYROX_STATION_ORDER) {
        const a = after.stations.find(l => l.station === st)!;
        const b = before.stations.find(l => l.station === st)!;
        expect(a.baseSec, `${name} ${st}`).toBeCloseTo(b.baseSec, 4);
        expect(a.source).toBe('calibrated');
      }
    }
  });

  it('the pair line maps her M-Open time at its Women Open equivalent\'s percentile', () => {
    const p = predictHyroxRace(mixedWoman())!;
    const seeds = hyroxStationSeedsForState(mixedWoman());
    const fieldTables = { singles: { format: 'open_singles' as const, sex: 'female' as const }, doubles: { format: 'open_doubles' as const, sex: 'mixed' as const } };
    for (const st of HYROX_STATION_ORDER) {
      const fieldSeed = hyroxProToOpenSec(st, seeds[st], 'female');
      const expected = doublesStationTeamSec(st, fieldSeed, fieldTables);
      expect(p.stations.find(l => l.station === st)!.baseSec, st).toBeCloseTo(expected, 6);
    }
  });

  it('a slower M-Open test makes the line slower, never faster than the seed (the H3b regression)', () => {
    const seeds = hyroxStationSeedsForState(mixedWoman());
    const seedLine = line(mixedWoman(), 'sled_push').baseSec;
    const slower = line(mixedWoman(soloTests('doubles', { sled_push: seeds.sled_push + 20 })), 'sled_push').baseSec;
    const faster = line(mixedWoman(soloTests('doubles', { sled_push: seeds.sled_push - 20 })), 'sled_push').baseSec;
    expect(slower).toBeGreaterThan(seedLine);
    expect(faster).toBeLessThan(seedLine);
  });

  it('a Mixed doubles race split round-trips: the pair\'s time as is, the solo at M-Open', () => {
    const split = 150;
    const s = mixedWoman({
      stationBenchmarksDoubles: { sled_push: split },
      stationBenchmarkHistory: { sled_push: [{ dateISO: TODAY, sec: split, source: 'race', format: 'open_doubles', proWeights: false }] },
    });
    expect(line(s, 'sled_push').baseSec).toBeCloseTo(split, 6);
    const solo = resolveHyroxStationBenchmarks(s)!.stations.find(b => b.station === 'sled_push')!.sec!;
    expect(solo).toBeCloseTo(doublesStationSoloSec('sled_push', split, hyroxDoublesTables('open_doubles', 'female', 'mixed')), 6);
    // Solo at M-Open: slower than the W-Open equivalent the women's table holds.
    expect(solo).toBeGreaterThan(doublesStationSoloSec('sled_push', split, { singles: { format: 'open_singles', sex: 'female' }, doubles: { format: 'open_doubles', sex: 'mixed' } }));
  });
});

describe('Mixed woman: guided-session summary and best', () => {
  const SLED: HyroxComponent = { type: 'sled_push', distanceM: 50, mtl: 0 };
  const session = { t: 'hyrox_station_density', n: 'X', d: '', hyroxComponents: [SLED], hyroxRounds: 2 } as unknown as Workout;
  const rounds = (sec: number): SetRecord[] => [
    { exerciseName: 'x', exerciseIndex: 0, setIndex: 0, setCount: 2, reps: '', durationSec: sec + 5 },
    { exerciseName: 'x', exerciseIndex: 0, setIndex: 1, setCount: 2, reps: '', durationSec: sec },
  ];

  it('places an M-Open round in her field at its Women Open equivalent', () => {
    const womenOpenMedian = secondsAtPercentileIn(hyroxResultsTable('sled_push', { format: 'open_singles', sex: 'female' })!, 50);
    const round = Math.round(hyroxOpenToProSec('sled_push', womenOpenMedian, 'female'));
    const r = summariseHyroxSession(session, rounds(round), mixedWoman())[0];
    expect(r.percentile).toBe(hyroxStationPercentile('sled_push', hyroxProToOpenSec('sled_push', round, 'female'), { format: 'open_singles', sex: 'female' }));
    expect(Math.abs(r.percentile! - 50)).toBeLessThanOrEqual(1);
    expect(r.percentileCohort).toBe('Open Singles women');
  });

  it('a best is stored at Pro-tier weights and the forecast reads it as is', () => {
    const s = mixedWoman();
    const seed = hyroxStationSeedsForState(s).sled_push;
    const best = Math.round(seed) - 10;
    const applied = applyHyroxSessionBenchmarks(session, rounds(best), s);
    expect(applied).toHaveLength(1);
    const hist = s.hyroxConfig!.stationBenchmarkHistory!.sled_push!;
    expect(hist[hist.length - 1].proWeights).toBe(true);
    expect(resolveHyroxStationBenchmarks(s)!.stations.find(b => b.station === 'sled_push')!.sec).toBeCloseTo(best, 9);
  });
});
