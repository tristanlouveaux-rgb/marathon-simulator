/**
 * The benchmark calibration card counts the stations the forecast calibrates.
 *
 * The card and predictHyroxRace read benchmarks through one resolver
 * (resolveHyroxBenchmarks, via hyroxCalibrationCoverage), per station: the
 * target's slot, else the other format's slot, else (both slots empty) the
 * legacy field. Before 2026-10-13 the card read only the target's slot, so a
 * doubles target with singles splits showed "Using population benchmarks for
 * all stations" next to a forecast built on 8 of the athlete's own times
 * (review 2026-10-12), and a singles target reading converted doubles splits
 * would have done the same.
 */
import { describe, it, expect } from 'vitest';
import { shouldShowBenchmarkCard, renderHyroxBenchmarkCard, stationTestLoadNote } from './benchmark-card';
import { HYROX_LOAD_TIER_KG } from '@/constants/hyrox-benchmarks';
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

  it('per station: a target-slot value replaces only its own station (as the forecast)', () => {
    // Per slot, the one doubles value hid the 7 other singles values and the
    // card asked for 7 tests the forecast did not need (review 2026-10-13).
    expect(shouldShowBenchmarkCard(state({ format: 'open_doubles', stationBenchmarksSingles: all(260), stationBenchmarksDoubles: { ski_erg: 300 } }), 1)).toBe(false);
    const partial = state({ format: 'open_singles', stationBenchmarksSingles: { ski_erg: 260 }, stationBenchmarksDoubles: { row_erg: 210, wall_balls: 300 } });
    expect(renderHyroxBenchmarkCard(partial)).toContain('5 stations still using population estimates.');
  });

  it('no benchmarks anywhere: every station uses population estimates', () => {
    expect(renderHyroxBenchmarkCard(state({}))).toContain('All stations use population estimates.');
  });

  it('names the seed\'s provenance, never "population averages" (lane H3c)', () => {
    const html = renderHyroxBenchmarkCard(state({}));
    expect(html).toContain('the median split of your ability band in the HYROX results');
    expect(html).not.toMatch(/population averages?/i);
  });
});

describe('station test modal: a doubles athlete is told which loads to use (lane H3c)', () => {
  const withSex = (hx: Partial<NonNullable<SimulatorState['hyroxConfig']>>, biologicalSex: 'female' | 'male' | undefined) =>
    ({ ...state(hx), biologicalSex }) as SimulatorState;
  it('a woman in Mixed Doubles tests at Men Open, the pair\'s loads', () => {
    const note = stationTestLoadNote(withSex({ format: 'open_doubles', division: 'mixed' }, 'female'), 'sled_push');
    expect(note).toBe(`Test at Men Open loads, the weights your pair races: ${HYROX_LOAD_TIER_KG['M-Open'].sledPush} kg incl. sled.`);
    expect(stationTestLoadNote(withSex({ format: 'open_doubles', division: 'mixed' }, 'female'), 'wall_balls'))
      .toBe(`Test at Men Open loads, the weights your pair races: ${HYROX_LOAD_TIER_KG['M-Open'].wallBall} kg ball to 2.70 m.`);
  });
  it('a man in Mixed Doubles and a women\'s pair test at their own Open loads', () => {
    expect(stationTestLoadNote(withSex({ format: 'open_doubles', division: 'mixed' }, 'male'), 'sandbag_lunges'))
      .toBe(`Test at Men Open loads: ${HYROX_LOAD_TIER_KG['M-Open'].sandbag} kg sandbag.`);
    expect(stationTestLoadNote(withSex({ format: 'open_doubles', division: 'women' }, 'female'), 'farmer_carry'))
      .toBe(`Test at Women Open loads: 2 × ${HYROX_LOAD_TIER_KG['W-Open'].farmerPerHand} kg.`);
  });
  it('Pro Doubles reads tests at Open loads until "Calibrated at Pro weights" is on', () => {
    expect(stationTestLoadNote(withSex({ format: 'pro_doubles', division: 'men' }, 'male'), 'sled_pull'))
      .toBe(`Test at Men Open loads: ${HYROX_LOAD_TIER_KG['M-Open'].sledPull} kg incl. sled. Testing at Pro loads? Turn on Calibrated at Pro weights in Stats first.`);
    expect(stationTestLoadNote(withSex({ format: 'pro_doubles', division: 'men', benchmarksAtProWeights: true }, 'male'), 'sled_pull'))
      .toBe(`Test at Men Pro loads: ${HYROX_LOAD_TIER_KG['M-Pro'].sledPull} kg incl. sled.`);
  });
  it('no line for singles, an unloaded station or an unknown sex', () => {
    expect(stationTestLoadNote(withSex({ format: 'open_singles' }, 'female'), 'sled_push')).toBeNull();
    expect(stationTestLoadNote(withSex({ format: 'open_doubles', division: 'mixed' }, 'female'), 'ski_erg')).toBeNull();
    expect(stationTestLoadNote(withSex({ format: 'open_doubles', division: 'mixed' }, undefined), 'sled_push')).toBeNull();
  });
  it('no copy breaks the style rules', () => {
    for (const [hx, sex] of [[{ format: 'open_doubles', division: 'mixed' }, 'female'], [{ format: 'pro_doubles', division: 'women' }, 'female']] as const) {
      for (const st of HYROX_STATION_ORDER) {
        const note = stationTestLoadNote(withSex(hx as Partial<NonNullable<SimulatorState['hyroxConfig']>>, sex), st) ?? '';
        expect(note).not.toContain('—');
      }
    }
  });
});
