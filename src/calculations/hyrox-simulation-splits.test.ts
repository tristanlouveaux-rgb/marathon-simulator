import { describe, it, expect } from 'vitest';
import {
  parseMmSs,
  parseHmsOrMmSs,
  benchmarkFromSplit,
  runPaceFromTotal,
  applySplitsToConfig,
} from './hyrox-simulation-splits';
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';
import { STATION_MIN_SEC, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';

function mkConfig(overrides: Partial<HyroxConfig> = {}): HyroxConfig {
  return {
    format: 'open_singles',
    athleteBand: 'intermediate',
    hyroxPhase: 'build',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: 1000,
    mtlHistory: [],
    runsPerWeek: 3,
    stationSessionsPerWeek: 2,
    bricksPerWeek: 1,
    weeklyHoursAvailable: 6,
    ...overrides,
  };
}

describe('parseMmSs', () => {
  it('reads m:ss', () => expect(parseMmSs('4:27')).toBe(267));
  it('reads a bare second count', () => expect(parseMmSs('90')).toBe(90));
  it('rejects out-of-range seconds', () => expect(parseMmSs('4:71')).toBeNull());
  it('rejects empty input', () => expect(parseMmSs('   ')).toBeNull());
});

describe('parseHmsOrMmSs', () => {
  it('reads h:mm:ss for run totals past an hour', () => {
    expect(parseHmsOrMmSs('1:05:30')).toBe(3930);
  });
  it('falls back to m:ss', () => expect(parseHmsOrMmSs('42:10')).toBe(2530));
  it('rejects out-of-range minutes', () => expect(parseHmsOrMmSs('1:75:00')).toBeNull());
});

describe('benchmarkFromSplit', () => {
  it('stores a full-simulation split as entered', () => {
    expect(benchmarkFromSplit('wall_balls', 421, false)).toBe(421);
  });

  it('doubles a half-simulation split', () => {
    expect(benchmarkFromSplit('wall_balls', 210, true)).toBe(420);
  });

  it('rejects a time below the station physical floor', () => {
    expect(benchmarkFromSplit('row_erg', STATION_MIN_SEC.row_erg - 1, false)).toBeNull();
  });

  it('applies the floor after doubling, so a valid half-time passes', () => {
    // 70s of half-distance rowing doubles to 140s, above the 120s floor.
    expect(benchmarkFromSplit('row_erg', 70, true)).toBe(140);
  });

  it('rejects zero and negatives', () => {
    expect(benchmarkFromSplit('ski_erg', 0, false)).toBeNull();
    expect(benchmarkFromSplit('ski_erg', -10, false)).toBeNull();
  });
});

describe('runPaceFromTotal', () => {
  it('divides a full-distance total across 8 km', () => {
    expect(runPaceFromTotal(2440, 1000)).toBe(305);
  });

  it('divides a half-distance total across 4 km', () => {
    expect(runPaceFromTotal(1220, 500)).toBe(305);
  });

  it('rejects an implausibly fast pace', () => {
    expect(runPaceFromTotal((HYROX_RUN_PACE_MIN_SEC_KM - 20) * 8, 1000)).toBeNull();
  });
});

describe('applySplitsToConfig', () => {
  const stations: Partial<Record<HyroxStation, string>> = {
    ski_erg: '4:27',
    wall_balls: '7:01',
  };

  it('writes singles benchmarks and reports what changed', () => {
    const hx = mkConfig();
    const r = applySplitsToConfig(hx, stations, '', false, '2026-09-01');
    expect(r.stationsUpdated).toBe(2);
    expect(r.runPaceUpdated).toBe(false);
    expect(hx.stationBenchmarksSingles).toEqual({ ski_erg: 267, wall_balls: 421 });
  });

  it('writes to the doubles slot when the athlete races doubles', () => {
    const hx = mkConfig({ format: 'open_doubles' });
    applySplitsToConfig(hx, stations, '', false, '2026-09-01');
    expect(hx.stationBenchmarksDoubles).toEqual({ ski_erg: 267, wall_balls: 421 });
    expect(hx.stationBenchmarksSingles).toBeUndefined();
  });

  it('appends history tagged with the simulation source', () => {
    const hx = mkConfig();
    applySplitsToConfig(hx, stations, '', false, '2026-09-01');
    const entries = hx.stationBenchmarkHistory!.ski_erg!;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sec: 267, source: 'simulation', format: 'open_singles' });
  });

  it('tags a half simulation separately and doubles its times', () => {
    const hx = mkConfig();
    applySplitsToConfig(hx, { ski_erg: '2:14' }, '', true, '2026-09-01');
    const entries = hx.stationBenchmarkHistory!.ski_erg!;
    expect(entries[0]).toMatchObject({ sec: 268, source: 'half_simulation' });
  });

  it('records run pace as user-set so it survives derivation', () => {
    const hx = mkConfig();
    const r = applySplitsToConfig(hx, {}, '40:40', false, '2026-09-01');
    expect(r.runPaceUpdated).toBe(true);
    expect(hx.hyroxRunPaceSecKm).toBe(305);
    expect(hx.hyroxRunPaceSource).toBe('user');
  });

  it('skips blank fields rather than writing zeros', () => {
    const hx = mkConfig();
    const r = applySplitsToConfig(hx, { ski_erg: '', wall_balls: '   ' }, '', false, '2026-09-01');
    expect(r.stationsUpdated).toBe(0);
    expect(hx.stationBenchmarksSingles).toBeUndefined();
  });

  it('reports unreadable entries without discarding the readable ones', () => {
    const hx = mkConfig();
    const r = applySplitsToConfig(hx, { ski_erg: '4:27', wall_balls: 'nonsense' }, '', false, '2026-09-01');
    expect(r.stationsUpdated).toBe(1);
    expect(r.rejected).toEqual(['Wall Balls']);
    expect(hx.stationBenchmarksSingles).toEqual({ ski_erg: 267 });
  });

  it('preserves prior history entries when a later simulation is recorded', () => {
    const hx = mkConfig({
      stationBenchmarkHistory: {
        ski_erg: [{ dateISO: '2026-08-01', sec: 300, source: 'half_test', format: 'open_singles' }],
      },
    });
    applySplitsToConfig(hx, { ski_erg: '4:27' }, '', false, '2026-09-01');
    expect(hx.stationBenchmarkHistory!.ski_erg).toHaveLength(2);
  });

  it('records a slower time than the previous benchmark, since a simulation is a fresh measurement', () => {
    const hx = mkConfig({ stationBenchmarksSingles: { ski_erg: 240 } });
    applySplitsToConfig(hx, { ski_erg: '4:27' }, '', false, '2026-09-01');
    expect(hx.stationBenchmarksSingles!.ski_erg).toBe(267);
  });
});
