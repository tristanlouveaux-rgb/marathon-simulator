import { describe, it, expect } from 'vitest';
import { parseHhMmSs, renderResultBody } from './goal-modal';
import type { GoalBackCalcResult } from '@/calculations/hyrox-goal-back-calc';

// Competitive HYROX singles floor is ~50-55 min. Use 3000s (50 min) as the
// disambiguation threshold the modal passes in (derived from the population
// floor at runtime).
const FLOOR = 3000;

describe('parseHhMmSs — target finish parsing', () => {
  it('reads h:mm:ss literally', () => {
    expect(parseHhMmSs('1:15:00', FLOOR)).toBe(4500);
    expect(parseHhMmSs('1:00:30', FLOOR)).toBe(3630);
  });

  it('reads a plausible mm:ss as minutes:seconds', () => {
    expect(parseHhMmSs('75:00', FLOOR)).toBe(4500); // 75 min, above floor
    expect(parseHhMmSs('90:30', FLOOR)).toBe(5430);
    expect(parseHhMmSs('55:00', FLOOR)).toBe(3300); // fast, still above floor
  });

  it('reinterprets an implausibly-fast 2-part value as hours:minutes', () => {
    // "1:00" literally = 60s (impossible), so the user means 1 hour.
    expect(parseHhMmSs('1:00', FLOOR)).toBe(3600);
    expect(parseHhMmSs('1:30', FLOOR)).toBe(5400); // 1h30m
    expect(parseHhMmSs('2:15', FLOOR)).toBe(8100); // 2h15m
  });

  it('does not reinterpret when h:mm would be implausibly long', () => {
    // "45:00" as minutes is below the floor, but 45 hours is absurd, so we keep
    // the minutes reading (the modal then flags it unrealistic).
    expect(parseHhMmSs('45:00', FLOOR)).toBe(2700);
  });

  it('rejects malformed input', () => {
    expect(parseHhMmSs('', FLOOR)).toBeNull();
    expect(parseHhMmSs('abc', FLOOR)).toBeNull();
    expect(parseHhMmSs('1:75', FLOOR)).toBeNull(); // seconds >= 60
    expect(parseHhMmSs('1:90:00', FLOOR)).toBeNull(); // minutes >= 60
  });
});

describe('goal modal body: one feasibility line, the race plan carries the splits', () => {
  const base: GoalBackCalcResult = {
    feasibility: 'achievable',
    gainNeededSec: 120,
    totalHeadroomSec: 600,
    stationTargets: [
      { station: 'ski_erg', currentSec: 300.2, targetSec: 119.6, deltaSec: -180.6, source: 'seed' },
      { station: 'row_erg', currentSec: 299.7, targetSec: 279.5, deltaSec: -20.2, source: 'calibrated' },
    ],
    runPaceTarget: { currentSecKm: 359.6, targetSecKm: 299.6, deltaSecKm: -60 },
    roxzoneSec: 380,
    achievedSec: 4500,
    shortfallSec: 0,
    caveat: null,
    likelyRangeSec: [5008, 5762],
    floorSource: 'cohort',
  };
  const ctx = { goalSec: 4500, forecastSec: 5385, cohort: { format: 'open_singles' as const, sex: 'female' as const } };

  it('no run or station rows (the race plan lists every leg one tap later)', () => {
    const html = renderResultBody(base, { ...ctx, goalSec: 5200 });
    expect(html).not.toContain('SkiErg');
    expect(html).not.toContain('Run pace');
    expect(html).not.toMatch(/\d:\d\d/);
    expect(html).toContain('Inside your forecast\'s likely range.');
    expect(html).not.toContain('headroom');
  });

  it('one sentence per state: stretch names the likely range, unrealistic the field, no training-time advice', () => {
    expect(renderResultBody({ ...base, feasibility: 'stretch' }, ctx))
      .toContain('Faster than your forecast\'s likely range, 1:23:28 to 1:36:02.');
    const unrealistic = renderResultBody({ ...base, feasibility: 'unrealistic' }, { ...ctx, goalSec: 3600 });
    expect(unrealistic).toContain('1:00:00 is out of reach even with every leg at top-1% level for Open Singles women.');
    expect(unrealistic).not.toMatch(/training time|6\+ months|realistic combination/);
    expect(renderResultBody({ ...base, feasibility: 'already_on_pace' }, { ...ctx, goalSec: 5500 })).toContain('Your forecast already beats this goal.');
    expect(renderResultBody({ ...base, feasibility: 'already_on_pace' }, { ...ctx, goalSec: 5385 })).toContain('Matches your forecast.');
    for (const feasibility of ['achievable', 'stretch', 'unrealistic', 'already_on_pace'] as const) {
      const text = renderResultBody({ ...base, feasibility }, ctx).replace(/<[^>]+>/g, '').trim();
      expect(text.split('. ').length).toBe(1);
    }
  });

  it('visual constraints: sentence case, no tinted callout, no olive figures, no em dash', () => {
    for (const feasibility of ['achievable', 'stretch', 'unrealistic', 'already_on_pace'] as const) {
      const html = renderResultBody({ ...base, feasibility }, ctx);
      expect(html).not.toMatch(/text-transform:\s*uppercase/i);
      expect(html).not.toMatch(/background:\s*rgba\(/);
      expect(html).not.toContain('#4f5a3b');
      expect(html).not.toContain('\u2014');
    }
  });
});
