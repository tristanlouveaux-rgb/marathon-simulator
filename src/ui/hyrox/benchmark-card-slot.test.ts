/**
 * The benchmark calibration card counts the stations the forecast calibrates.
 *
 * The card and predictHyroxRace read benchmarks through one resolver
 * (resolveHyroxBenchmarks): the target's slot, else the other format's slot,
 * else the legacy field. Before 2026-10-13 the card read only the target's
 * slot, so a doubles target with singles splits showed "Using population
 * benchmarks for all stations" next to a forecast built on 8 of the athlete's
 * own times (review 2026-10-12), and a singles target reading converted
 * doubles splits would have done the same.
 */
import { describe, it, expect } from 'vitest';
import { shouldShowBenchmarkCard, renderHyroxBenchmarkCard } from './benchmark-card';
import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';

const all = (sec: number) =>
  Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, sec])) as Partial<Record<HyroxStation, number>>;

function state(hx: Partial<NonNullable<SimulatorState['hyroxConfig']>>): SimulatorState {
  return {
    w: 1,
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: 'intermediate',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      ...hx,
    },
  } as unknown as SimulatorState;
}

describe('benchmark card uses the forecast\'s benchmark slot', () => {
  it('singles target with 8 doubles race splits: nothing left to calibrate', () => {
    expect(shouldShowBenchmarkCard(state({ stationBenchmarksDoubles: all(200) }), 1)).toBe(false);
  });

  it('doubles target with 8 singles splits: nothing left to calibrate', () => {
    expect(shouldShowBenchmarkCard(state({ format: 'open_doubles', stationBenchmarksSingles: all(260) }), 1)).toBe(false);
  });

  it('once the target slot has a value, only that slot counts (as the forecast)', () => {
    const s = state({ format: 'open_doubles', stationBenchmarksSingles: all(260), stationBenchmarksDoubles: { ski_erg: 300 } });
    expect(shouldShowBenchmarkCard(s, 1)).toBe(true);
    expect(renderHyroxBenchmarkCard(s)).toContain('7 stations still using population estimates.');
  });

  it('no benchmarks anywhere: every station uses population estimates', () => {
    expect(renderHyroxBenchmarkCard(state({}))).toContain('Using population benchmarks for all stations.');
  });
});
