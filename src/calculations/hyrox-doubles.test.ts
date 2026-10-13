/**
 * HYROX Doubles forecast. Ratios come from the real results tables (seasons
 * 8 and 9, quantile mapping per station and per division, hyrox-doubles.ts);
 * the forecast covers all 8 stations as the pair's time, Roxzone is not
 * halved, and the run follows the slower partner (doubles run ratio).
 *
 * Regression: the audit (2026-10-12) measured the old "4 whole stations each"
 * model at 58:04 "faster than 98%" for an intermediate doubles athlete at
 * VDOT 45, against a real open_doubles median of 1:19:07.
 */
import { describe, it, expect } from 'vitest';
import {
  cumulativePercentileAt,
  secondsAtCumulativePercentile,
  doublesRatioAt,
  doublesRatioAtTeamTime,
  doublesStationRatio,
  doublesStationTeamSec,
  doublesStationSoloSec,
  hyroxDoublesTables,
  HYROX_DEFAULT_DOUBLES_TABLES,
  seedRoxzoneSecForFormat,
  doublesBenchmarkIsTeamTime,
  hyroxBandingTimeSec,
  doublesTotalInSinglesTermsSec,
} from './hyrox-doubles';
import { predictHyroxRace } from './race-prediction.hyrox';
import { derivePopulationRunPace } from './hyrox-run-pace';
import { getFinishTimePercentile } from './hyrox-population';
import { estimateStationsAndRoxzoneFromBand } from './hyrox-personal-pace';
import { HYROX_S89_PERCENTILES, HYROX_S89_POOLED_PERCENTILES, type HyroxPercentileTable } from '@/data/hyrox-results-s79';
import { HYROX_STATION_ORDER, SEED_ROXZONE_SEC, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import type { SimulatorState } from '@/types/state';
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';

const at = (t: HyroxPercentileTable, p: number) => t.find(([, q]) => q === p)![0];
const OS = HYROX_S89_POOLED_PERCENTILES.open_singles!;
const OD = HYROX_S89_POOLED_PERCENTILES.open_doubles!;

function buildState(overrides: Partial<HyroxConfig> = {}, top: Partial<SimulatorState> = {}): SimulatorState {
  return {
    ...top,
    hyroxConfig: {
      format: 'open_doubles',
      athleteBand: 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 1000,
      mtlHistory: [],
      runsPerWeek: 3,
      stationSessionsPerWeek: 1,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      ...overrides,
    },
  } as unknown as SimulatorState;
}

describe('quantile helpers', () => {
  const t = OS.work_total;
  it('read a breakpoint exactly and interpolate between breakpoints', () => {
    expect(cumulativePercentileAt(t, at(t, 50))).toBe(50);
    expect(secondsAtCumulativePercentile(t, 50)).toBe(at(t, 50));
    const mid = (at(t, 45) + at(t, 50)) / 2;
    expect(cumulativePercentileAt(t, mid)).toBeCloseTo(47.5, 6);
    expect(secondsAtCumulativePercentile(t, 47.5)).toBeCloseTo(mid, 6);
  });
  it('clamp at the table ends', () => {
    expect(cumulativePercentileAt(t, 1)).toBe(1);
    expect(cumulativePercentileAt(t, 99999)).toBe(99);
  });
});

describe('doublesRatioAt: ratios come from the real tables, not constants', () => {
  const metrics = [
    ['stations', 'work_total'],
    ['roxzone', 'roxzone'],
    ['run', 'run_total'],
    ['total', 'total'],
    ['sled_push', 'sled_push'],
    ['ski_erg', 'ski_erg'],
  ] as const;
  for (const [metric, key] of metrics) {
    it(`${metric}: at every breakpoint the ratio is open_doubles ÷ open_singles (pooled, S8-S9)`, () => {
      for (const [sec, p] of OS[key]) {
        const r = doublesRatioAt(metric, sec);
        expect(r.singlesPercentile).toBeCloseTo(p, 6);
        expect(r.ratio).toBeCloseTo(at(OD[key], p) / sec, 6);
      }
    });
  }
  it('each station has its own ratio: one erg, alternated, gains little; the sleds and wall balls gain most', () => {
    const ski = doublesRatioAt('ski_erg', at(OS.ski_erg, 50)).ratio;
    const wb = doublesRatioAt('wall_balls', at(OS.wall_balls, 50)).ratio;
    expect(ski).toBeGreaterThan(0.85);
    expect(wb).toBeLessThan(0.7);
  });
  it('the division selects the doubles table and the athlete\'s sex the singles table', () => {
    const t = hyroxDoublesTables('open_doubles', 'female', 'mixed');
    expect(t.doubles).toEqual({ format: 'open_doubles', sex: 'mixed' });
    expect(t.singles).toEqual({ format: 'open_singles', sex: 'female' });
    const women = hyroxDoublesTables('open_doubles', 'female', 'women');
    const sec = at(HYROX_S89_PERCENTILES.open_singles.female!.sled_push, 50);
    expect(doublesRatioAt('sled_push', sec, women).ratio).toBeCloseTo(
      at(HYROX_S89_PERCENTILES.open_doubles.female!.sled_push, 50) / sec, 6);
    // Pro Doubles reads its own (real) tables.
    const pro = hyroxDoublesTables('pro_doubles', 'male', 'men');
    expect(pro.doubles).toEqual({ format: 'pro_doubles', sex: 'male' });
    expect(pro.singles).toEqual({ format: 'pro_singles', sex: 'male' });
    // Unknown sex and division: pooled.
    expect(hyroxDoublesTables('open_doubles', undefined, undefined)).toEqual(HYROX_DEFAULT_DOUBLES_TABLES);
  });
  it('outside the table the end ratio holds', () => {
    expect(doublesRatioAt('stations', 500).ratio).toBeCloseTo(at(OD.work_total, 1) / at(OS.work_total, 1), 6);
    expect(doublesRatioAt('stations', 99999).ratio).toBeCloseTo(at(OD.work_total, 99) / at(OS.work_total, 99), 6);
  });
  it('read from the doubles side, the ratio converts a pair time back to the matching singles time', () => {
    const r = doublesRatioAtTeamTime('total', at(OD.total, 50));
    expect(at(OD.total, 50) / r.ratio).toBeCloseTo(at(OS.total, 50), 6);
  });
  it('per station, team and solo conversions invert each other inside the tables', () => {
    for (const st of HYROX_STATION_ORDER) {
      const solo = at(OS[st], 50);
      const team = doublesStationTeamSec(st, solo);
      expect(team).toBeCloseTo(at(OD[st], 50), 6);
      expect(doublesStationSoloSec(st, team)).toBeCloseTo(solo, 6);
    }
  });
  it('aggregate station ratio (H1 API) with team-time splits converts them back first', () => {
    const r = doublesStationRatio([], [at(OD.work_total, 50)], [at(OS.work_total, 50)]);
    expect(r.ratio).toBeCloseTo(at(OD.work_total, 50) / at(OS.work_total, 50), 3);
  });
});

describe('seed Roxzone and the race back-computation in doubles', () => {
  it('doubles Roxzone is the seed × the percentile-matched ratio, not halved', () => {
    const seed = SEED_ROXZONE_SEC.intermediate;
    const doubles = seedRoxzoneSecForFormat('intermediate', 'open_doubles');
    expect(doubles).toBe(Math.round(seed * doublesRatioAt('roxzone', seed).ratio));
    expect(doubles).toBeGreaterThan(seed * 0.85);
    expect(seedRoxzoneSecForFormat('intermediate', 'open_singles')).toBe(seed);
  });
  it('a doubles finish-time observation estimates the pair\'s station time per station', () => {
    const seeds = STATION_SEED_TIMES_SEC.intermediate;
    const singlesSum = HYROX_STATION_ORDER.reduce((a, st) => a + seeds[st], 0);
    const pairSum = HYROX_STATION_ORDER.reduce((a, st) => a + doublesStationTeamSec(st, seeds[st]), 0);
    const est = estimateStationsAndRoxzoneFromBand('intermediate', 'open_doubles');
    expect(est.stationsTotalSec).toBe(Math.round(pairSum));
    expect(est.roxzoneSec).toBe(seedRoxzoneSecForFormat('intermediate', 'open_doubles'));
    expect(estimateStationsAndRoxzoneFromBand('intermediate', 'open_singles').stationsTotalSec).toBe(singlesSum);
  });
});

describe('doubles benchmark provenance', () => {
  const entry = (
    source: 'half_test' | 'race' | 'manual' | 'session' | 'full_test',
    format: HyroxConfig['format'] = 'open_doubles',
    sec = 250,
    dateISO = '2026-09-01',
  ) => ({ dateISO, sec, source, format });
  it('a race split (or a value no history entry describes) is the pair\'s time', () => {
    expect(doublesBenchmarkIsTeamTime({}, 'ski_erg', 250)).toBe(true);
    expect(doublesBenchmarkIsTeamTime({ stationBenchmarkHistory: { ski_erg: [entry('race')] } }, 'ski_erg', 250)).toBe(true);
    expect(doublesBenchmarkIsTeamTime({ stationBenchmarkHistory: { ski_erg: [entry('manual')] } }, 'ski_erg', 250)).toBe(true);
  });
  it('a test or session best is one athlete\'s solo time', () => {
    expect(doublesBenchmarkIsTeamTime({ stationBenchmarkHistory: { ski_erg: [entry('half_test')] } }, 'ski_erg', 250)).toBe(false);
    expect(doublesBenchmarkIsTeamTime({ stationBenchmarkHistory: { ski_erg: [entry('session')] } }, 'ski_erg', 250)).toBe(false);
  });
  it('only doubles-format entries count', () => {
    expect(doublesBenchmarkIsTeamTime({ stationBenchmarkHistory: { ski_erg: [entry('half_test', 'open_singles')] } }, 'ski_erg', 250)).toBe(true);
  });
  it('reads the entry that describes the slot value, not the newest entry', () => {
    // A race (dated race day) logged after a newer half test overwrote the slot.
    const hx = { stationBenchmarkHistory: { ski_erg: [
      entry('race', 'open_doubles', 280, '2026-06-01'),
      entry('half_test', 'open_doubles', 300, '2026-09-01'),
    ] } };
    expect(doublesBenchmarkIsTeamTime(hx, 'ski_erg', 280)).toBe(true);
    expect(doublesBenchmarkIsTeamTime(hx, 'ski_erg', 300)).toBe(false);
    // A race split written before race entries existed: no entry matches.
    expect(doublesBenchmarkIsTeamTime({ stationBenchmarkHistory: { ski_erg: [entry('half_test', 'open_doubles', 300)] } }, 'ski_erg', 280)).toBe(true);
  });
});

describe('doublesTotalInSinglesTermsSec: the doubles-to-singles total conversion', () => {
  it('maps a doubles total to the singles total at the same percentile', () => {
    for (const p of [5, 25, 50, 75, 95]) {
      expect(doublesTotalInSinglesTermsSec(at(OD.total, p))).toBeCloseTo(at(OS.total, p), 6);
    }
  });
  it('is the exact inverse of the forecast mapping (singles × doublesRatioAt) inside the tables', () => {
    for (const singles of [4200, 4860, 5513, 6386, 7400]) {
      const team = singles * doublesRatioAt('total', singles).ratio;
      expect(doublesTotalInSinglesTermsSec(team)).toBeCloseTo(singles, 6);
    }
  });
});

describe('hyroxBandingTimeSec (the onboarding initializer\'s global-scale banding)', () => {
  it('a doubles previous time is read in singles terms (the data ratio)', () => {
    expect(hyroxBandingTimeSec(at(OD.total, 50), 'open_doubles')).toBeCloseTo(at(OS.total, 50), -1);
    expect(hyroxBandingTimeSec(at(OD.total, 75), 'open_doubles')).toBeCloseTo(at(OS.total, 75), -1);
  });
  it('a singles previous time stays as is', () => {
    expect(hyroxBandingTimeSec(5338, 'open_singles')).toBe(5338);
    expect(hyroxBandingTimeSec(5338, 'pro_singles')).toBe(5338);
  });
  it('uses doublesTotalInSinglesTermsSec (one source)', () => {
    expect(hyroxBandingTimeSec(4747, 'open_doubles')).toBe(Math.round(doublesTotalInSinglesTermsSec(4747)));
  });
});

describe('predictHyroxRace: doubles', () => {
  it('covers all 8 stations as the pair\'s time, each mapped at its own station ratio', () => {
    const singles = predictHyroxRace(buildState({ format: 'open_singles' }))!;
    const doubles = predictHyroxRace(buildState())!;
    expect(doubles.stations.length).toBe(8);
    for (const line of doubles.stations) {
      const s = singles.stations.find(l => l.station === line.station)!;
      expect(line.baseSec).toBeCloseTo(doublesStationTeamSec(line.station, s.baseSec), 6);
      expect(line.teamRatio).toBeCloseTo(line.baseSec / s.baseSec, 9);
    }
    // Ratios differ by station (one aggregate ratio was H1's model).
    const ratios = new Set(doubles.stations.map(l => l.teamRatio!.toFixed(3)));
    expect(ratios.size).toBeGreaterThan(4);
    // Aggregate ratio = pair's station sum ÷ solo station sum.
    expect(doubles.doubles!.stationRatio).toBeCloseTo(doubles.stations.reduce((a, l) => a + l.baseSec, 0) / singles.stations.reduce((a, l) => a + l.baseSec, 0), 6);
    expect(doubles.stationsSec).toBeGreaterThan(0.6 * singles.stationsSec);
  });

  it('Roxzone is the singles seed × the Roxzone ratio, not halved', () => {
    const singles = predictHyroxRace(buildState({ format: 'open_singles' }))!;
    const doubles = predictHyroxRace(buildState())!;
    expect(doubles.roxzoneSec).toBe(Math.round(singles.roxzoneSec * doubles.doubles!.roxzoneRatio));
    expect(doubles.roxzoneSec).toBeGreaterThan(0.85 * singles.roxzoneSec);
  });

  it('per-leg fade uses the singles rate (no unsourced doubles halving)', () => {
    const singles = predictHyroxRace(buildState({ format: 'open_singles' }))!;
    const doubles = predictHyroxRace(buildState())!;
    doubles.runLegs.forEach((leg, i) => {
      expect(leg.fatigueMultiplier).toBeCloseTo(singles.runLegs[i].fatigueMultiplier, 9);
    });
  });

  it('a doubles race split is used as the pair\'s time; a solo test is mapped per station', () => {
    const team = predictHyroxRace(buildState({ stationBenchmarksDoubles: { ski_erg: 250 } }))!;
    expect(team.stations.find(l => l.station === 'ski_erg')!.baseSec).toBe(250);
    const solo = predictHyroxRace(buildState({
      stationBenchmarksDoubles: { ski_erg: 250 },
      stationBenchmarkHistory: { ski_erg: [{ dateISO: '2026-09-01', sec: 250, source: 'half_test', format: 'open_doubles' }] },
    }))!;
    expect(solo.stations.find(l => l.station === 'ski_erg')!.baseSec).toBeCloseTo(doublesStationTeamSec('ski_erg', 250), 6);
  });

  it('a median singles athlete forecasts near the open_doubles median, with a mid-field label', () => {
    const singlesMedianStations = Object.fromEntries(
      HYROX_STATION_ORDER.map(st => [st, at(OS[st], 50)]),
    ) as Record<HyroxStation, number>;
    // VDOT whose singles HYROX run total sits at the singles median.
    const medianPace = at(OS.run_total, 50) / 8;
    let bestV = 40;
    let bestErr = Infinity;
    for (let v = 30; v <= 55; v += 0.1) {
      const pace = derivePopulationRunPace({ v, hyroxConfig: buildState().hyroxConfig } as unknown as SimulatorState, 'singles')!.paceSecKm;
      const err = Math.abs(pace - medianPace);
      if (err < bestErr) { bestErr = err; bestV = v; }
    }
    const p = predictHyroxRace(buildState({ stationBenchmarksSingles: singlesMedianStations }, { v: bestV } as Partial<SimulatorState>))!;
    const doublesMedian = at(OD.total, 50);
    expect(Math.abs(p.totalSec - doublesMedian) / doublesMedian).toBeLessThan(0.03);
    const fasterThan = getFinishTimePercentile(p.totalSec, 'open_doubles');
    expect(fasterThan).toBeGreaterThanOrEqual(40);
    expect(fasterThan).toBeLessThanOrEqual(60);
  });

  it('audit regression: intermediate doubles at VDOT 45 is no longer "faster than 98%"', () => {
    const p = predictHyroxRace(buildState({}, { v: 45 } as Partial<SimulatorState>))!;
    expect(p.totalSec).toBeGreaterThan(70 * 60);
    const fasterThan = getFinishTimePercentile(p.totalSec, 'open_doubles');
    expect(fasterThan).toBeLessThan(80);
    expect(fasterThan).toBeGreaterThan(30);
  });

  it('Pro Doubles is placed on its own (real) table: a pair\'s time no longer reads off the singles scale', () => {
    const t = at(HYROX_S89_POOLED_PERCENTILES.pro_doubles!.total, 50);
    expect(getFinishTimePercentile(t, 'pro_doubles')).toBe(50);
    expect(getFinishTimePercentile(t, 'pro_doubles')).toBeLessThan(getFinishTimePercentile(t, 'pro_singles'));
  });
});
