/**
 * Tests for HYROX format-aware band derivation.
 *
 * The bandFromTime helper lives inside initialization.hyrox.ts as a private
 * function — we replicate its logic here so the same-athlete cross-format
 * scaling rule has unit coverage independent of the init flow. Same-format
 * previous + target → no factor. Different-format → bidirectional factor:
 *   doubles → singles: × SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES (1.22)
 *   singles → doubles: × SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES (0.85)
 */
import { describe, expect, it } from 'vitest';
import {
  SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES,
  SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES,
  HYROX_TIME_TO_BAND_THRESHOLDS,
} from '@/constants/hyrox-constants';
import type { AbilityBand } from '@/types/triathlon';

type Format = 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';

function bandFromTime(sec: number): AbilityBand {
  for (const { maxSec, band } of HYROX_TIME_TO_BAND_THRESHOLDS) {
    if (sec < maxSec) return band;
  }
  return 'beginner';
}

function deriveBand(prevTimeSec: number, prevFmt: Format, targetFmt: Format): AbilityBand {
  const isPrevDoubles = prevFmt === 'open_doubles' || prevFmt === 'pro_doubles';
  const isTargetDoubles = targetFmt === 'open_doubles' || targetFmt === 'pro_doubles';
  const adjusted =
     isPrevDoubles && !isTargetDoubles ? Math.round(prevTimeSec * SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES) :
    !isPrevDoubles &&  isTargetDoubles ? Math.round(prevTimeSec * SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES) :
    prevTimeSec;
  return bandFromTime(adjusted);
}

describe('same-athlete cross-format band derivation', () => {
  it('singles → singles: no factor applied', () => {
    expect(deriveBand(75 * 60, 'open_singles', 'open_singles')).toBe('advanced');
    expect(deriveBand(95 * 60, 'open_singles', 'open_singles')).toBe('intermediate');
  });

  it('doubles → doubles: no factor applied', () => {
    expect(deriveBand(55 * 60, 'open_doubles', 'open_doubles')).toBe('competitive');
  });

  it('60-min doubles → singles: × 1.22 = 73:12 → advanced (NOT competitive — pre-fix bug)', () => {
    expect(deriveBand(60 * 60, 'open_doubles', 'open_singles')).toBe('advanced');
  });

  it('70-min doubles → singles: × 1.22 = 85:24 → intermediate', () => {
    expect(deriveBand(70 * 60, 'open_doubles', 'open_singles')).toBe('intermediate');
  });

  it('60-min singles → doubles: × 0.85 = 51:00 → competitive', () => {
    expect(deriveBand(60 * 60, 'open_singles', 'open_doubles')).toBe('competitive');
  });

  it('80-min singles → doubles: × 0.85 = 68:00 → advanced', () => {
    expect(deriveBand(80 * 60, 'open_singles', 'open_doubles')).toBe('advanced');
  });

  it('pro_doubles → pro_singles applies factor', () => {
    // 65 min pro doubles → 79.3 min pro singles → advanced (sub-80).
    expect(deriveBand(65 * 60, 'pro_doubles', 'pro_singles')).toBe('advanced');
  });

  it('directionality: same time gives faster band singles→doubles than doubles→singles', () => {
    const t = 75 * 60; // 1:15:00
    const slBandFromDbl = deriveBand(t, 'open_doubles', 'open_singles');  // ×1.22 → 91:30 → intermediate
    const dblBandFromSl = deriveBand(t, 'open_singles', 'open_doubles');  // ×0.85 → 63:45 → advanced
    // Advanced is faster than intermediate.
    const order: AbilityBand[] = ['total_beginner','beginner','novice','intermediate','advanced','competitive'];
    expect(order.indexOf(dblBandFromSl)).toBeGreaterThan(order.indexOf(slBandFromDbl));
  });
});
