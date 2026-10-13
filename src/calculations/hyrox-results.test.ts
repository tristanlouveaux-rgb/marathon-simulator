/**
 * HYROX results lookups (lane H3b): cohort resolution, real percentiles,
 * captions, age-group placement, field-relative bands, the Open-to-Pro
 * difference in differences, the improvement ceiling and the seed field.
 * Every expected value is read from the data module, never typed in.
 */
import { describe, it, expect } from 'vitest';
import {
  hyroxResultsCohort,
  hyroxSinglesCohort,
  hyroxResultsTable,
  hyroxFasterThanPct,
  hyroxStationPercentile,
  hyroxResultsCaption,
  hyroxCohortLabel,
  hyroxAgeGroupFor,
  hyroxAgeGroupPhrase,
  hyroxCohortPlacement,
  hyroxPlacementHeadline,
  hyroxPlacementCaption,
  hyroxBandThresholds,
  hyroxBandFor,
  hyroxBandForPreviousTime,
  hyroxProConversionAt,
  hyroxProStationMultiplier,
  hyroxOpenToProSec,
  hyroxProToOpenSec,
  hyroxImprovementCeiling,
  hyroxImprovementGapFor,
  hyroxStationLowerFenceSec,
  hyroxSeedField,
  hyroxStationSeedsAtTarget,
  HYROX_LOADED_STATIONS,
} from './hyrox-results';
import {
  HYROX_S89_PERCENTILES,
  HYROX_S89_POOLED_PERCENTILES,
  HYROX_S89_FINISHER_COUNTS,
  HYROX_S89_BAND_THRESHOLDS_SEC,
  HYROX_S89_SEASONS_LABEL,
  HYROX_S79_SEASONS_LABEL,
  HYROX_S79_AGE_TOTAL_PERCENTILES,
  HYROX_S79_AGE_TOTAL_COUNTS,
  HYROX_S79_IMPROVEMENT,
  HYROX_S79_STATION_LOWER_FENCES_SEC,
  type HyroxPercentileTable,
} from '@/data/hyrox-results-s79';
import { HYROX_TIME_TO_BAND_THRESHOLDS } from '@/constants/hyrox-constants';
import { stationSeedTimesFor } from '@/constants/hyrox-benchmarks';

const at = (t: HyroxPercentileTable, p: number) => t.find(([, q]) => q === p)![0];

describe('cohort resolution', () => {
  it('singles: biological sex wins, then a single-sex division pick, else pooled', () => {
    expect(hyroxResultsCohort('open_singles', 'female', undefined)).toEqual({ format: 'open_singles', sex: 'female' });
    expect(hyroxResultsCohort('pro_singles', 'prefer_not_to_say', 'men')).toEqual({ format: 'pro_singles', sex: 'male' });
    expect(hyroxResultsCohort('open_singles', undefined, undefined)).toEqual({ format: 'open_singles', sex: 'pooled' });
  });
  it('doubles: the division selects the table, sex only fills the gap', () => {
    expect(hyroxResultsCohort('open_doubles', 'female', 'mixed')).toEqual({ format: 'open_doubles', sex: 'mixed' });
    expect(hyroxResultsCohort('open_doubles', 'female', 'men')).toEqual({ format: 'open_doubles', sex: 'male' });
    expect(hyroxResultsCohort('open_doubles', 'male', undefined)).toEqual({ format: 'open_doubles', sex: 'male' });
    expect(hyroxResultsCohort('open_doubles', undefined, undefined)).toEqual({ format: 'open_doubles', sex: 'pooled' });
  });
  it('pro doubles mixed is not a rulebook category: never selected (the suppressed data-error rows)', () => {
    expect(HYROX_S89_PERCENTILES.pro_doubles.mixed).toBeUndefined();
    expect(hyroxResultsCohort('pro_doubles', 'female', 'mixed')).toEqual({ format: 'pro_doubles', sex: 'female' });
    expect(hyroxResultsCohort('pro_doubles', undefined, 'mixed')).toEqual({ format: 'pro_doubles', sex: 'pooled' });
  });
  it('the singles cohort of a doubles athlete is their own sex in the weight family', () => {
    expect(hyroxSinglesCohort('pro_doubles', 'female', 'mixed')).toEqual({ format: 'pro_singles', sex: 'female' });
    expect(hyroxSinglesCohort('open_doubles', undefined, 'mixed')).toEqual({ format: 'open_singles', sex: 'pooled' });
  });
});

describe('real percentiles', () => {
  it('read the S8-S9 tables exactly at breakpoints, for sex and pooled cells', () => {
    const w = HYROX_S89_PERCENTILES.open_singles.female!;
    expect(hyroxFasterThanPct('total', at(w.total, 50), { format: 'open_singles', sex: 'female' })).toBe(50);
    expect(hyroxFasterThanPct('total', at(w.total, 10), { format: 'open_singles', sex: 'female' })).toBe(90);
    const pooled = HYROX_S89_POOLED_PERCENTILES.open_doubles!;
    expect(hyroxFasterThanPct('roxzone', at(pooled.roxzone, 25), { format: 'open_doubles', sex: 'pooled' })).toBe(75);
  });
  it('station percentiles place a time on that station\'s race splits', () => {
    const m = HYROX_S89_PERCENTILES.pro_singles.male!;
    expect(hyroxStationPercentile('sled_push', at(m.sled_push, 75), { format: 'pro_singles', sex: 'male' })).toBe(25);
  });
  it('the same time ranks lower among men than among women', () => {
    const t = at(HYROX_S89_PERCENTILES.open_singles.female!.total, 50);
    expect(hyroxFasterThanPct('total', t, { format: 'open_singles', sex: 'male' })!)
      .toBeLessThan(hyroxFasterThanPct('total', t, { format: 'open_singles', sex: 'female' })!);
  });
  it('unusable times read null', () => {
    expect(hyroxFasterThanPct('total', 0, { format: 'open_singles', sex: 'pooled' })).toBeNull();
    expect(hyroxResultsTable('total', { format: 'pro_doubles', sex: 'mixed' })).toBeNull();
  });
});

describe('captions lead with provenance', () => {
  it('seasons with years, the cohort count, the source', () => {
    const c = hyroxResultsCaption({ format: 'open_singles', sex: 'female' });
    expect(c).toBe(`HYROX results, ${HYROX_S89_SEASONS_LABEL}, ${HYROX_S89_FINISHER_COUNTS.open_singles.female!.total.toLocaleString('en-US')} Open Singles women finishers, via the open pyrox project.`);
    expect(c).not.toContain('—');
  });
  it('cohort labels', () => {
    expect(hyroxCohortLabel({ format: 'pro_doubles', sex: 'male' })).toBe('Pro Doubles men');
    expect(hyroxCohortLabel({ format: 'open_doubles', sex: 'mixed' })).toBe('Open Doubles mixed');
    expect(hyroxCohortLabel({ format: 'pro_singles', sex: 'pooled' })).toBe('Pro Singles');
  });
});

describe('age and sex rankings', () => {
  it('maps ages onto the results\' age groups (5-year singles, 10-year doubles)', () => {
    expect(hyroxAgeGroupFor('open_singles', 32)).toBe('30-34');
    expect(hyroxAgeGroupFor('open_doubles', 32)).toBe('30-39');
    expect(hyroxAgeGroupFor('open_doubles', 75)).toBe('70+');
    expect(hyroxAgeGroupFor('open_singles', 12)).toBeNull();
    expect(hyroxAgeGroupPhrase('30-34')).toBe('aged 30 to 34');
    expect(hyroxAgeGroupPhrase('70+')).toBe('aged 70 and over');
  });
  it('"Faster than 62% of women aged 30 to 34": the age table (pooled S7-S9) when the age is known', () => {
    const cohort = { format: 'open_singles' as const, sex: 'female' as const };
    const table = HYROX_S79_AGE_TOTAL_PERCENTILES.open_singles.female!['30-34'];
    const p = hyroxCohortPlacement(at(table, 40), cohort, 32)!;
    expect(p.ageGroup).toBe('30-34');
    expect(p.fasterThanPct).toBe(60);
    expect(p.n).toBe(HYROX_S79_AGE_TOTAL_COUNTS.open_singles.female!['30-34']);
    expect(hyroxPlacementHeadline(p)).toBe('Faster than 60% of women aged 30 to 34');
    expect(hyroxPlacementCaption(p)).toContain(HYROX_S79_SEASONS_LABEL);
    expect(hyroxPlacementCaption(p)).toContain('aged 30 to 34');
  });
  it('no age: the S8-S9 sex cell; pooled never takes an age group', () => {
    const t = at(HYROX_S89_PERCENTILES.open_singles.male!.total, 25);
    const p = hyroxCohortPlacement(t, { format: 'open_singles', sex: 'male' }, undefined)!;
    expect(p.ageGroup).toBeNull();
    expect(hyroxPlacementHeadline(p)).toBe('Faster than 75% of Open Singles men');
    const pooled = hyroxCohortPlacement(t, { format: 'open_singles', sex: 'pooled' }, 32)!;
    expect(pooled.ageGroup).toBeNull();
    expect(hyroxPlacementHeadline(pooled)).toMatch(/of Open Singles finishers$/);
  });
  it('doubles pairs read as pairs', () => {
    const t = at(HYROX_S89_PERCENTILES.open_doubles.mixed!.total, 50);
    expect(hyroxPlacementHeadline(hyroxCohortPlacement(t, { format: 'open_doubles', sex: 'mixed' })!)).toBe('Faster than 50% of Open Doubles mixed pairs');
  });
  it('past the slow end it states the share ahead, never a false "faster than"', () => {
    const table = HYROX_S89_PERCENTILES.open_singles.female!.total;
    const p = hyroxCohortPlacement(table[table.length - 1][0] + 600, { format: 'open_singles', sex: 'female' })!;
    expect(p.beyond).toBe('slow');
    expect(hyroxPlacementHeadline(p)).toBe('Slower than 99% of Open Singles women');
  });
});

describe('field-relative bands', () => {
  it('thresholds are the cohort cell\'s own, beginner above the last', () => {
    const th = hyroxBandThresholds({ format: 'open_singles', sex: 'female' });
    expect(th.map(t => t.band)).toEqual(HYROX_TIME_TO_BAND_THRESHOLDS.map(t => t.band));
    expect(th.slice(0, 4).map(t => t.maxSec)).toEqual([...HYROX_S89_BAND_THRESHOLDS_SEC.open_singles.female!]);
    expect(th[4].maxSec).toBe(Infinity);
  });
  it('the same field percentile gives the same band in every field', () => {
    for (const [format, sex] of [['open_singles', 'female'], ['open_singles', 'male'], ['pro_doubles', 'male'], ['open_doubles', 'mixed']] as const) {
      const median = at(HYROX_S89_PERCENTILES[format][sex]!.total, 50);
      expect(hyroxBandFor(median, format, sex), `${format}/${sex}`).toBe('intermediate');
    }
  });
  it('women are no longer banded on the men-heavy global scale', () => {
    // A women's open time just inside the women's advanced threshold.
    const t = HYROX_S89_BAND_THRESHOLDS_SEC.open_singles.female![1] - 1;
    expect(hyroxBandFor(t, 'open_singles', 'female')).toBe('advanced');
    expect(t).toBeGreaterThan(HYROX_TIME_TO_BAND_THRESHOLDS[1].maxSec); // old scale: intermediate
  });
  it('a previous doubles time is banded against the pair\'s division directly', () => {
    const t = at(HYROX_S89_PERCENTILES.open_doubles.female!.total, 50);
    expect(hyroxBandForPreviousTime(t, 'open_doubles', 'female', 'women')).toBe('intermediate');
    expect(hyroxBandForPreviousTime(t, 'open_doubles', undefined, undefined)).toBe(hyroxBandFor(t, 'open_doubles', 'pooled'));
  });
});

describe('Open-to-Pro station conversion (difference in differences)', () => {
  it('passes its sanity check for every loaded station and sex from p10 to p90 (source: data)', () => {
    for (const sex of ['female', 'male', 'pooled'] as const) {
      for (const st of HYROX_LOADED_STATIONS) {
        for (const p of [10, 25, 50, 75, 90]) {
          const c = hyroxProConversionAt(st, sex, p);
          expect(c.source, `${sex}/${st}/p${p}`).toBe('data');
          expect(c.multiplier).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
  it('unloaded stations convert at 1', () => {
    for (const st of ['ski_erg', 'row_erg', 'burpee_broad_jumps'] as const) {
      expect(hyroxProStationMultiplier(st, 'male', 300)).toBe(1);
    }
  });
  it('women convert over a bigger load jump on the sled push than men (Women Open to Men Open loads vs Men Open to Men Pro)', () => {
    expect(hyroxProConversionAt('sled_push', 'female', 50).multiplier)
      .toBeGreaterThan(hyroxProConversionAt('sled_push', 'male', 50).multiplier);
  });
  it('Pro to Open inverts Open to Pro', () => {
    for (const st of HYROX_LOADED_STATIONS) {
      const open = at(HYROX_S89_PERCENTILES.open_singles.male![st], 50);
      expect(hyroxProToOpenSec(st, hyroxOpenToProSec(st, open, 'male'), 'male')).toBeCloseTo(open, 3);
    }
  });
});

describe('improvement ceiling (tracking)', () => {
  it('horizon to half-season gap: up to 9 months reads the 1-window cell', () => {
    expect(hyroxImprovementGapFor(8)).toBe(1);
    expect(hyroxImprovementGapFor(39)).toBe(1);
    expect(hyroxImprovementGapFor(52)).toBe(2);
    expect(hyroxImprovementGapFor(500)).toBe(4);
  });
  it('the upper-quartile improvement of the mean-of-races cell for format, sex, band and horizon', () => {
    const c = hyroxImprovementCeiling({ format: 'open_singles', sex: 'female', singlesTotalSec: 5400, weeksRemaining: 16 })!;
    const cell = HYROX_S79_IMPROVEMENT.find(x => x.format === 'open_singles' && x.sex === 'female' && x.groupBy === 'mean_of_races' && x.band === 'intermediate' && x.gapHalfSeasons === 1)!;
    expect(c.cell).toBe(cell);
    expect(c.pct).toBe(-cell.relPct[0]);
  });
  it('doubles read their singles family; unknown sex reads all singles', () => {
    const c = hyroxImprovementCeiling({ format: 'pro_doubles', sex: 'male', singlesTotalSec: 4400, weeksRemaining: 12 })!;
    expect(c.cell.format).toBe('pro_singles');
    const u = hyroxImprovementCeiling({ format: 'open_singles', sex: null, singlesTotalSec: 5400, weeksRemaining: 12 })!;
    expect(u.cell.format).toBe('all_singles');
  });
  it('no horizon, no ceiling', () => {
    expect(hyroxImprovementCeiling({ format: 'open_singles', sex: 'male', singlesTotalSec: 5000, weeksRemaining: 0 })).toBeNull();
  });
});

describe('station timing-slip fence', () => {
  it('reads the cohort cell, pooled reads the most permissive cell', () => {
    expect(hyroxStationLowerFenceSec('wall_balls', { format: 'open_singles', sex: 'female' }))
      .toBe(HYROX_S79_STATION_LOWER_FENCES_SEC.open_singles.female!.wall_balls);
    const f = HYROX_S79_STATION_LOWER_FENCES_SEC.open_singles;
    expect(hyroxStationLowerFenceSec('row_erg', { format: 'open_singles', sex: 'pooled' }))
      .toBe(Math.min(f.female!.row_erg, f.male!.row_erg));
  });
});

describe('band seeds at the target\'s weights', () => {
  const st = (format: 'open_singles' | 'pro_singles', prev?: 'open_singles' | 'pro_singles' | 'open_doubles') => ({
    biologicalSex: 'female' as const,
    hyroxConfig: { format, athleteBand: 'intermediate' as const, hyroxPreviousTimeFormat: prev },
  });
  it('the seed field is the previous race\'s weight family at the athlete\'s sex, Open with no race', () => {
    expect(hyroxSeedField(st('pro_singles', 'pro_singles'))).toEqual({ format: 'pro_singles', sex: 'female' });
    expect(hyroxSeedField(st('pro_singles', 'open_doubles'))).toEqual({ format: 'open_singles', sex: 'female' });
    expect(hyroxSeedField(st('pro_singles'))).toEqual({ format: 'open_singles', sex: 'female' });
  });
  it('same family: the band medians as they are', () => {
    expect(hyroxStationSeedsAtTarget(st('pro_singles', 'pro_singles'))).toEqual(stationSeedTimesFor('intermediate', 'pro_singles', 'female'));
    expect(hyroxStationSeedsAtTarget(st('open_singles'))).toEqual(stationSeedTimesFor('intermediate', 'open_singles', 'female'));
  });
  it('an Open-raced band for a Pro target converts each loaded station to Pro weights (slower)', () => {
    const open = stationSeedTimesFor('intermediate', 'open_singles', 'female');
    const pro = hyroxStationSeedsAtTarget(st('pro_singles', 'open_singles'));
    for (const s of HYROX_LOADED_STATIONS) {
      expect(pro[s]).toBeCloseTo(hyroxOpenToProSec(s, open[s], 'female'), 6);
      expect(pro[s]).toBeGreaterThan(open[s]);
    }
    expect(pro.ski_erg).toBe(open.ski_erg);
  });
});
