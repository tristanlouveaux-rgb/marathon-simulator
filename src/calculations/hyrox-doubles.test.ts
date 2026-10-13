/**
 * HYROX Doubles forecast. Ratios come from the ingested results tables
 * (quantile mapping, hyrox-doubles.ts); the forecast covers all 8 stations as
 * the pair's time, Roxzone is not halved, and the run follows the slower
 * partner (doubles run ratio).
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
  seedRoxzoneSecForFormat,
  doublesBenchmarkIsTeamTime,
  hyroxBandingTimeSec,
  doublesTotalInSinglesTermsSec,
} from './hyrox-doubles';
import { predictHyroxRace } from './race-prediction.hyrox';
import { derivePopulationRunPace } from './hyrox-run-pace';
import { getFinishTimePercentile } from './hyrox-population';
import { estimateStationsAndRoxzoneFromBand } from './hyrox-personal-pace';
import {
  HYROX_STATIONS_PERCENTILE_TABLES,
  HYROX_ROXZONE_PERCENTILE_TABLES,
  HYROX_RUN_PERCENTILE_TABLES,
  HYROX_TOTAL_PERCENTILE_TABLES,
} from '@/data/hyrox-population-distributions';
import { HYROX_STATION_ORDER, SEED_ROXZONE_SEC, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import type { SimulatorState } from '@/types/state';
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';

type Table = Array<[number, number]>;
const at = (t: Table, p: number) => t.find(([, q]) => q === p)![0];

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
  const t = HYROX_STATIONS_PERCENTILE_TABLES.open_singles;
  it('read a breakpoint exactly and interpolate between breakpoints', () => {
    expect(cumulativePercentileAt(t, at(t, 50))).toBe(50);
    expect(secondsAtCumulativePercentile(t, 50)).toBe(at(t, 50));
    const mid = (at(t, 25) + at(t, 50)) / 2;
    expect(cumulativePercentileAt(t, mid)).toBeCloseTo(37.5, 6);
    expect(secondsAtCumulativePercentile(t, 37.5)).toBeCloseTo(mid, 6);
  });
  it('clamp at the table ends', () => {
    expect(cumulativePercentileAt(t, 1)).toBe(1);
    expect(cumulativePercentileAt(t, 99999)).toBe(99);
  });
});

describe('doublesRatioAt: ratios come from the tables, not constants', () => {
  const metrics = [
    ['stations', HYROX_STATIONS_PERCENTILE_TABLES],
    ['roxzone', HYROX_ROXZONE_PERCENTILE_TABLES],
    ['run', HYROX_RUN_PERCENTILE_TABLES],
    ['total', HYROX_TOTAL_PERCENTILE_TABLES],
  ] as const;
  for (const [metric, tables] of metrics) {
    it(`${metric}: at every breakpoint the ratio is open_doubles ÷ open_singles`, () => {
      for (const [sec, p] of tables.open_singles) {
        const r = doublesRatioAt(metric, sec);
        expect(r.singlesPercentile).toBeCloseTo(p, 6);
        expect(r.ratio).toBeCloseTo(at(tables.open_doubles, p) / sec, 6);
      }
    });
  }
  it('station ratio falls from the front of the field to the back (pairs gain more when slower)', () => {
    const s = HYROX_STATIONS_PERCENTILE_TABLES.open_singles;
    expect(doublesRatioAt('stations', at(s, 1)).ratio).toBeGreaterThan(doublesRatioAt('stations', at(s, 50)).ratio);
    expect(doublesRatioAt('stations', at(s, 50)).ratio).toBeGreaterThan(doublesRatioAt('stations', at(s, 99)).ratio);
  });
  it('outside the table the end ratio holds', () => {
    const s = HYROX_STATIONS_PERCENTILE_TABLES;
    expect(doublesRatioAt('stations', 500).ratio).toBeCloseTo(at(s.open_doubles, 1) / at(s.open_singles, 1), 6);
    expect(doublesRatioAt('stations', 9999).ratio).toBeCloseTo(at(s.open_doubles, 99) / at(s.open_singles, 99), 6);
  });
  it('read from the doubles side, the ratio converts a pair time back to the matching singles time', () => {
    const s = HYROX_TOTAL_PERCENTILE_TABLES;
    const r = doublesRatioAtTeamTime('total', at(s.open_doubles, 50));
    expect(at(s.open_doubles, 50) / r.ratio).toBeCloseTo(at(s.open_singles, 50), 6);
  });
  it('station ratio with team-time splits converts them back to singles before the lookup', () => {
    const s = HYROX_STATIONS_PERCENTILE_TABLES;
    // All stations as one team-time total equal to the doubles median: the
    // refined ratio lands on the median ratio.
    const r = doublesStationRatio([], [at(s.open_doubles, 50)], [at(s.open_singles, 50)]);
    expect(r.ratio).toBeCloseTo(at(s.open_doubles, 50) / at(s.open_singles, 50), 3);
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
  it('a doubles finish-time observation estimates the pair\'s station time', () => {
    const singlesSum = HYROX_STATION_ORDER.reduce((a, st) => a + STATION_SEED_TIMES_SEC.intermediate[st], 0);
    const est = estimateStationsAndRoxzoneFromBand('intermediate', 'open_doubles');
    expect(est.stationsTotalSec).toBe(Math.round(singlesSum * doublesRatioAt('stations', singlesSum).ratio));
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

describe('doublesTotalInSinglesTermsSec: the one doubles-to-singles total conversion', () => {
  const totals = HYROX_TOTAL_PERCENTILE_TABLES;
  it('maps a doubles total to the singles total at the same percentile', () => {
    for (const p of [5, 25, 50, 75, 95]) {
      expect(doublesTotalInSinglesTermsSec(at(totals.open_doubles, p))).toBeCloseTo(at(totals.open_singles, p), 6);
    }
  });
  it('is the exact inverse of the forecast mapping (singles × doublesRatioAt) inside the tables', () => {
    for (const singles of [4000, 4793, 5338, 6042, 7000]) {
      const team = singles * doublesRatioAt('total', singles).ratio;
      expect(doublesTotalInSinglesTermsSec(team)).toBeCloseTo(singles, 6);
    }
  });
});

describe('hyroxBandingTimeSec', () => {
  const totals = HYROX_TOTAL_PERCENTILE_TABLES;
  it('a doubles previous time is banded on singles terms (the data ratio)', () => {
    // The doubles median maps to the singles median: the inverse of the
    // forecast's quantile mapping, read from the tables.
    expect(hyroxBandingTimeSec(at(totals.open_doubles, 50), 'open_doubles'))
      .toBeCloseTo(at(totals.open_singles, 50), -1);
    expect(hyroxBandingTimeSec(at(totals.open_doubles, 25), 'pro_doubles'))
      .toBeCloseTo(at(totals.open_singles, 25), -1);
    expect(hyroxBandingTimeSec(at(totals.open_doubles, 75), 'open_doubles'))
      .toBeCloseTo(at(totals.open_singles, 75), -1);
  });
  it('a singles previous time stays as is', () => {
    expect(hyroxBandingTimeSec(5338, 'open_singles')).toBe(5338);
    expect(hyroxBandingTimeSec(5338, 'pro_singles')).toBe(5338);
  });
  it('uses the same conversion as the Pro Doubles finish percentile (one source)', () => {
    expect(hyroxBandingTimeSec(4747, 'open_doubles')).toBe(Math.round(doublesTotalInSinglesTermsSec(4747)));
  });
});

describe('predictHyroxRace: doubles', () => {
  it('covers all 8 stations as the pair\'s time, each at the same station ratio', () => {
    const singles = predictHyroxRace(buildState({ format: 'open_singles' }))!;
    const doubles = predictHyroxRace(buildState())!;
    expect(doubles.stations.length).toBe(8);
    const r = doubles.doubles!.stationRatio;
    for (const line of doubles.stations) {
      const s = singles.stations.find(l => l.station === line.station)!;
      expect(line.teamRatio).toBe(r);
      expect(line.baseSec).toBeCloseTo(s.baseSec * r, 6);
    }
    // Ratio read at the athlete's singles station total.
    expect(r).toBeCloseTo(doublesRatioAt('stations', singles.stations.reduce((a, l) => a + l.baseSec, 0)).ratio, 6);
    // The old model kept about half the singles station sum (4 of 8 stations).
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

  it('a doubles race split is used as the pair\'s time; a solo test is scaled by the ratio', () => {
    const team = predictHyroxRace(buildState({ stationBenchmarksDoubles: { ski_erg: 250 } }))!;
    expect(team.stations.find(l => l.station === 'ski_erg')!.baseSec).toBe(250);
    const solo = predictHyroxRace(buildState({
      stationBenchmarksDoubles: { ski_erg: 250 },
      stationBenchmarkHistory: { ski_erg: [{ dateISO: '2026-09-01', sec: 250, source: 'half_test', format: 'open_doubles' }] },
    }))!;
    expect(solo.stations.find(l => l.station === 'ski_erg')!.baseSec).toBeCloseTo(250 * solo.doubles!.stationRatio, 6);
  });

  it('a median singles athlete forecasts near the open_doubles median, with a mid-field label', () => {
    const s = HYROX_STATIONS_PERCENTILE_TABLES.open_singles;
    // Singles stations summing to the singles median, split by the
    // intermediate seed shape.
    const seedSum = HYROX_STATION_ORDER.reduce((a, st) => a + STATION_SEED_TIMES_SEC.intermediate[st], 0);
    const singlesMedianStations = Object.fromEntries(
      HYROX_STATION_ORDER.map(st => [st, STATION_SEED_TIMES_SEC.intermediate[st] * at(s, 50) / seedSum]),
    ) as Record<HyroxStation, number>;
    // VDOT whose singles HYROX run total sits at the singles median.
    const medianPace = at(HYROX_RUN_PERCENTILE_TABLES.open_singles, 50) / 8;
    let bestV = 40;
    let bestErr = Infinity;
    for (let v = 30; v <= 55; v += 0.1) {
      const pace = derivePopulationRunPace({ v, hyroxConfig: buildState().hyroxConfig } as unknown as SimulatorState, 'singles')!.paceSecKm;
      const err = Math.abs(pace - medianPace);
      if (err < bestErr) { bestErr = err; bestV = v; }
    }
    const p = predictHyroxRace(buildState({ stationBenchmarksSingles: singlesMedianStations }, { v: bestV } as Partial<SimulatorState>))!;
    const doublesMedian = at(HYROX_TOTAL_PERCENTILE_TABLES.open_doubles, 50);
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
    expect(fasterThan).toBeGreaterThan(40);
  });

  it('Pro Doubles (no ingested table) is placed on the Pro scale in singles terms', () => {
    const t = at(HYROX_TOTAL_PERCENTILE_TABLES.open_doubles, 50);
    // A pair's time read straight off the singles Pro scale would look far
    // up the field; converted to singles terms it reads mid-field.
    expect(getFinishTimePercentile(t, 'pro_doubles')).toBeLessThan(getFinishTimePercentile(t, 'pro_singles'));
  });
});
