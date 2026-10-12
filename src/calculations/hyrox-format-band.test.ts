/**
 * Tests for HYROX format-aware band derivation.
 *
 * Onboarding, "Log a previous HYROX time" and the previous-format fix all band
 * on hyroxBandingTimeSec (hyrox-doubles.ts): the previous time in singles terms,
 * because the band thresholds and the band seed times are singles times.
 *   - doubles target: a doubles previous time ÷ the data ratio (the inverse of
 *     the doubles forecast's quantile mapping), a singles previous time as is.
 *   - singles target: a doubles previous time × SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES
 *     (1.22), a singles previous time as is.
 * The old doubles-target rule (a singles time × 0.85, a doubles time as is)
 * banded on doubles terms and the forecast then applied the doubles ratios to
 * that band's seeds a second time (review 2026-10-12).
 */
import { describe, expect, it } from 'vitest';
import { HYROX_TIME_TO_BAND_THRESHOLDS } from '@/constants/hyrox-constants';
import { HYROX_TOTAL_PERCENTILE_TABLES } from '@/data/hyrox-population-distributions';
import { hyroxBandingTimeSec } from './hyrox-doubles';
import type { AbilityBand } from '@/types/triathlon';

type Format = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

function bandFromTime(sec: number): AbilityBand {
  for (const { maxSec, band } of HYROX_TIME_TO_BAND_THRESHOLDS) {
    if (sec < maxSec) return band;
  }
  return 'beginner';
}

function deriveBand(prevTimeSec: number, prevFmt: Format, targetFmt: Format): AbilityBand {
  return bandFromTime(hyroxBandingTimeSec(prevTimeSec, prevFmt, targetFmt));
}

const median = (f: 'open_singles' | 'open_doubles') =>
  HYROX_TOTAL_PERCENTILE_TABLES[f].find(([, p]) => p === 50)![0];

describe('same-athlete cross-format band derivation', () => {
  it('singles → singles: no factor applied', () => {
    expect(deriveBand(75 * 60, 'open_singles', 'open_singles')).toBe('advanced');
    expect(deriveBand(95 * 60, 'open_singles', 'open_singles')).toBe('intermediate');
  });

  it('singles → doubles: no factor applied (the band is in singles terms)', () => {
    expect(deriveBand(60 * 60, 'open_singles', 'open_doubles')).toBe('advanced');
    expect(deriveBand(80 * 60, 'open_singles', 'open_doubles')).toBe('intermediate');
    expect(deriveBand(median('open_singles'), 'open_singles', 'open_doubles'))
      .toBe(deriveBand(median('open_singles'), 'open_singles', 'open_singles'));
  });

  it('doubles → doubles: the doubles median bands like the singles median', () => {
    expect(deriveBand(median('open_doubles'), 'open_doubles', 'open_doubles'))
      .toBe(deriveBand(median('open_singles'), 'open_singles', 'open_singles'));
  });

  it('60-min doubles → singles: × 1.22 = 73:12 → advanced (NOT competitive — pre-fix bug)', () => {
    expect(deriveBand(60 * 60, 'open_doubles', 'open_singles')).toBe('advanced');
  });

  it('70-min doubles → singles: × 1.22 = 85:24 → intermediate', () => {
    expect(deriveBand(70 * 60, 'open_doubles', 'open_singles')).toBe('intermediate');
  });

  it('pro_doubles → pro_singles applies factor', () => {
    // 65 min pro doubles → 79.3 min pro singles → advanced (sub-80).
    expect(deriveBand(65 * 60, 'pro_doubles', 'pro_singles')).toBe('advanced');
  });

  it('a singles previous time bands the same for either target', () => {
    for (const t of [55 * 60, 75 * 60, 95 * 60, 115 * 60]) {
      expect(deriveBand(t, 'open_singles', 'open_doubles')).toBe(deriveBand(t, 'open_singles', 'open_singles'));
    }
  });
});
