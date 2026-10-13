/**
 * Tests for HYROX format-aware band derivation.
 *
 * Onboarding, "Log a previous HYROX time", the previous-format fix and the
 * setup step all band on hyroxBandingTimeSec (hyrox-doubles.ts): the previous
 * time in singles terms, because the band thresholds and the band seed times
 * are singles times. A doubles previous time goes through
 * doublesTotalInSinglesTermsSec (the inverse of the doubles forecast's
 * quantile mapping) for EITHER target; a singles previous time stays as is.
 *
 * History: the doubles-target rule (a singles time × 0.85, a doubles time as
 * is) banded on doubles terms and the forecast then applied the doubles ratios
 * a second time (review 2026-10-12). The singles-target rule (a doubles time ×
 * 1.22, coaching consensus) used a different conversion from the doubles
 * target, so the doubles median banded on 1:36:30 in one path and 1:28:58 in
 * the other (unified 2026-10-13).
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

/** Target format kept in the signature to show it does not move the band. */
function deriveBand(prevTimeSec: number, prevFmt: Format, _targetFmt: Format): AbilityBand {
  return bandFromTime(hyroxBandingTimeSec(prevTimeSec, prevFmt));
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

  it('60-min doubles → singles: data ratio ≈ 67:33 singles → advanced (NOT competitive)', () => {
    expect(deriveBand(60 * 60, 'open_doubles', 'open_singles')).toBe('advanced');
  });

  it('70-min doubles (about P22 of the doubles field) → singles: ≈ 78:44 singles → advanced', () => {
    // Under the old × 1.22 rule this read 85:24 and banded intermediate.
    expect(deriveBand(70 * 60, 'open_doubles', 'open_singles')).toBe('advanced');
  });

  it('pro_doubles → pro_singles converts through the same data ratio', () => {
    // 65 min pro doubles → about 73:15 singles terms → advanced (sub-80).
    expect(deriveBand(65 * 60, 'pro_doubles', 'pro_singles')).toBe('advanced');
  });

  it('a doubles previous time bands the same for either target (one conversion)', () => {
    const doubles = HYROX_TOTAL_PERCENTILE_TABLES.open_doubles.map(([t]) => t);
    for (const t of [...doubles, 55 * 60, 70 * 60, 95 * 60, 115 * 60]) {
      expect(deriveBand(t, 'open_doubles', 'open_singles')).toBe(deriveBand(t, 'open_doubles', 'open_doubles'));
      expect(hyroxBandingTimeSec(t, 'open_doubles')).toBe(hyroxBandingTimeSec(t, 'pro_doubles'));
    }
  });

  it('a singles previous time bands the same for either target', () => {
    for (const t of [55 * 60, 75 * 60, 95 * 60, 115 * 60]) {
      expect(deriveBand(t, 'open_singles', 'open_doubles')).toBe(deriveBand(t, 'open_singles', 'open_singles'));
    }
  });
});
