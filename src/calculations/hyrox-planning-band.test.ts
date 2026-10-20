/**
 * The HYROX planning band (lane H3c): one field for every format, Open
 * Singles at the athlete's own sex, after converting the finish to Open
 * Singles terms. Expected values come from the data module or from the
 * canonical helpers, never typed in.
 */
import { describe, it, expect } from 'vitest';
import { hyroxOpenSinglesTermsSec, hyroxPlanningBandFor } from './hyrox-planning-band';
import { hyroxBandFor, hyroxBandForPreviousTime, hyroxPlanningField, hyroxOpenToProSec } from './hyrox-results';
import { estimateStationsAndRoxzoneFromBand } from './hyrox-personal-pace';
import { hyroxDoublesTables } from './hyrox-doubles';
import { HYROX_STATION_ORDER, stationSeedTimesFor } from '@/constants/hyrox-benchmarks';
import { HYROX_S89_PERCENTILES, HYROX_S89_POOLED_PERCENTILES, type HyroxPercentileTable } from '@/data/hyrox-results-s79';
import type { AbilityBand, HyroxDivision } from '@/types/triathlon';

type Format = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
type Sex = 'female' | 'male' | null;

const BAND_ORDER: AbilityBand[] = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'];
const rank = (b: AbilityBand) => BAND_ORDER.indexOf(b);
const at = (t: HyroxPercentileTable, p: number) => t.find(([, q]) => q === p)![0];
const TIMES: number[] = [];
for (let t = 2700; t <= 12600; t += 45) TIMES.push(t);

const CASES: Array<{ format: Format; sex: Sex; division?: HyroxDivision }> = [
  { format: 'open_singles', sex: 'female' },
  { format: 'open_singles', sex: 'male' },
  { format: 'open_singles', sex: null },
  { format: 'pro_singles', sex: 'female' },
  { format: 'pro_singles', sex: 'male' },
  { format: 'pro_singles', sex: null },
  { format: 'open_doubles', sex: 'female', division: 'women' },
  { format: 'open_doubles', sex: 'male', division: 'men' },
  { format: 'open_doubles', sex: 'female', division: 'mixed' },
  { format: 'open_doubles', sex: 'male', division: 'mixed' },
  { format: 'open_doubles', sex: null, division: 'mixed' },
  { format: 'pro_doubles', sex: 'female', division: 'women' },
  { format: 'pro_doubles', sex: 'male', division: 'men' },
  { format: 'pro_doubles', sex: null },
];

describe('planning field', () => {
  it('Open Singles at the athlete\'s own sex: biological sex, then a single-sex division pick, then pooled', () => {
    expect(hyroxPlanningField('female')).toEqual({ format: 'open_singles', sex: 'female' });
    expect(hyroxPlanningField('male', 'mixed')).toEqual({ format: 'open_singles', sex: 'male' });
    expect(hyroxPlanningField(null, 'women')).toEqual({ format: 'open_singles', sex: 'female' });
    expect(hyroxPlanningField('prefer_not_to_say', 'mixed')).toEqual({ format: 'open_singles', sex: 'pooled' });
    expect(hyroxPlanningField(undefined)).toEqual({ format: 'open_singles', sex: 'pooled' });
  });
});

describe('Open Singles terms', () => {
  it('an Open Singles finish is banded as is, on its own sex\'s field', () => {
    for (const sex of ['female', 'male', null] as const) {
      for (const t of TIMES) {
        expect(hyroxOpenSinglesTermsSec(t, 'open_singles', sex)).toBe(t);
        expect(hyroxPlanningBandFor(t, 'open_singles', sex)).toBe(hyroxBandForPreviousTime(t, 'open_singles', sex));
      }
    }
  });

  it('is monotonic in the finish for every format, sex and division', () => {
    for (const c of CASES) {
      let prev = -Infinity;
      for (const t of TIMES) {
        const v = hyroxOpenSinglesTermsSec(t, c.format, c.sex, c.division);
        expect(v, `${c.format}/${c.sex}/${c.division}/${t}`).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it('a Pro Singles finish is faster in Open terms: only the loaded stations change', () => {
    for (const sex of ['female', 'male', null] as const) {
      for (const t of TIMES) expect(hyroxOpenSinglesTermsSec(t, 'pro_singles', sex)).toBeLessThan(t);
    }
  });

  it('a same-sex doubles finish is slower in Open Singles terms (the pair shares the stations)', () => {
    for (const c of CASES.filter(x => x.format === 'open_doubles' && x.division !== 'mixed')) {
      for (const t of TIMES) expect(hyroxOpenSinglesTermsSec(t, c.format, c.sex, c.division)).toBeGreaterThan(t);
    }
  });

  it('a Pro Doubles pair converts faster than an Open Doubles pair on the same clock (heavier loads)', () => {
    for (const [sex, division] of [['female', 'women'], ['male', 'men']] as const) {
      for (const t of TIMES) {
        expect(hyroxOpenSinglesTermsSec(t, 'pro_doubles', sex, division))
          .toBeLessThan(hyroxOpenSinglesTermsSec(t, 'open_doubles', sex, division));
      }
    }
  });

  it('in a Mixed pair the man converts faster than the woman (each against their own singles field)', () => {
    const mixed = at(HYROX_S89_PERCENTILES.open_doubles.mixed!.total, 50);
    expect(hyroxOpenSinglesTermsSec(mixed, 'open_doubles', 'male', 'mixed'))
      .toBeLessThan(hyroxOpenSinglesTermsSec(mixed, 'open_doubles', 'female', 'mixed'));
  });

  it('unusable input returns as is', () => {
    expect(hyroxOpenSinglesTermsSec(0, 'pro_singles', 'male')).toBe(0);
    expect(hyroxOpenSinglesTermsSec(Number.NaN, 'open_doubles', 'female', 'women')).toBeNaN();
  });
});

describe('planning band', () => {
  it('is the Open Singles band of the converted finish, in the athlete\'s planning field', () => {
    for (const c of CASES) {
      const field = hyroxPlanningField(c.sex, c.division);
      for (const t of TIMES) {
        expect(hyroxPlanningBandFor(t, c.format, c.sex, c.division))
          .toBe(hyroxBandFor(hyroxOpenSinglesTermsSec(t, c.format, c.sex, c.division), field.format, field.sex));
      }
    }
  });

  it('a Pro finish never bands lower than in its own fitter field (H3b field-relative)', () => {
    for (const c of CASES.filter(x => x.format === 'pro_singles' || x.format === 'pro_doubles')) {
      for (const t of TIMES) {
        const plan = hyroxPlanningBandFor(t, c.format, c.sex, c.division);
        const fieldRelative = hyroxBandForPreviousTime(t, c.format, c.sex, c.division);
        expect(rank(plan), `${c.format}/${c.sex}/${t}`).toBeGreaterThanOrEqual(rank(fieldRelative));
      }
    }
  });

  it('the Open Doubles median bands like the Open Singles median (pooled)', () => {
    const od = at(HYROX_S89_POOLED_PERCENTILES.open_doubles!.total, 50);
    const os = at(HYROX_S89_POOLED_PERCENTILES.open_singles!.total, 50);
    expect(hyroxPlanningBandFor(od, 'open_doubles', null)).toBe(hyroxPlanningBandFor(os, 'open_singles', null));
  });
});

describe('a past doubles result raced in another division (raceDivision)', () => {
  it('omitted, the band is unchanged', () => {
    for (const c of CASES) {
      for (const t of TIMES.filter((_, i) => i % 9 === 0)) {
        expect(hyroxPlanningBandFor(t, c.format, c.sex, c.division, undefined)).toBe(hyroxPlanningBandFor(t, c.format, c.sex, c.division));
      }
    }
  });

  it('the finish decomposes in the past race\'s field: a woman now in Women\'s doubles whose race was Mixed', () => {
    for (const t of TIMES) {
      expect(hyroxPlanningBandFor(t, 'open_doubles', 'female', 'women', 'mixed')).toBe(hyroxPlanningBandFor(t, 'open_doubles', 'female', 'mixed'));
    }
    // The two fields band some finishes differently, so the division matters.
    expect(TIMES.some(t => hyroxPlanningBandFor(t, 'open_doubles', 'female', 'women') !== hyroxPlanningBandFor(t, 'open_doubles', 'female', 'mixed'))).toBe(true);
  });

  it('a sex-unset singles athlete (Women pick) whose past race was Mixed keeps the Open Singles women field', () => {
    for (const t of TIMES) {
      expect(hyroxPlanningBandFor(t, 'open_doubles', null, 'women', 'mixed'))
        .toBe(hyroxBandFor(hyroxOpenSinglesTermsSec(t, 'open_doubles', null, 'mixed', 'women'), 'open_singles', 'female'));
    }
    // The past division alone would have read the pooled field.
    expect(hyroxPlanningField(null, 'mixed').sex).toBe('pooled');
  });

  it('a sex-unset athlete whose past race was a women\'s pair: the race says her sex', () => {
    for (const t of TIMES.filter((_, i) => i % 5 === 0)) {
      expect(hyroxPlanningBandFor(t, 'open_doubles', null, undefined, 'women')).toBe(hyroxPlanningBandFor(t, 'open_doubles', null, 'women'));
    }
  });
});

describe('seeds behind a back-computed race read the planning field', () => {
  it('a Pro Singles race: the Open medians at Pro weights', () => {
    const tables = hyroxDoublesTables('pro_singles', 'male', undefined);
    const open = stationSeedTimesFor('intermediate', 'open_singles', 'male');
    const expected = Math.round(HYROX_STATION_ORDER.reduce((a, st) => a + hyroxOpenToProSec(st, open[st], 'male'), 0));
    expect(estimateStationsAndRoxzoneFromBand('intermediate', 'pro_singles', tables).stationsTotalSec).toBe(expected);
  });
  it('an Open Singles race: the Open medians as they are', () => {
    const tables = hyroxDoublesTables('open_singles', 'female', undefined);
    const open = stationSeedTimesFor('intermediate', 'open_singles', 'female');
    const expected = Math.round(HYROX_STATION_ORDER.reduce((a, st) => a + open[st], 0));
    expect(estimateStationsAndRoxzoneFromBand('intermediate', 'open_singles', tables).stationsTotalSec).toBe(expected);
  });
});
