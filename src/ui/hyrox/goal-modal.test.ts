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
    floorSource: 'cohort',
  };

  it('no run or station rows (the race plan lists every leg one tap later)', () => {
    const html = renderResultBody(base);
    expect(html).not.toContain('SkiErg');
    expect(html).not.toContain('Run pace');
    expect(html).not.toMatch(/\d:\d\d/);
    expect(html).toContain('Achievable on your current headroom.');
  });

  it('stretch and unrealistic carry the back-calculation\'s caveat; on pace says so', () => {
    expect(renderResultBody({ ...base, feasibility: 'stretch', caveat: 'Most athletes would need 6+ months of focused training to hit a goal this aggressive.' }))
      .toContain('Stretch target.');
    const unrealistic = renderResultBody({ ...base, feasibility: 'unrealistic', shortfallSec: 90, caveat: 'No realistic combination.' });
    expect(unrealistic).toContain('About 1 min 30 sec faster than realistic.');
    expect(unrealistic).toContain('No realistic combination.');
    expect(renderResultBody({ ...base, feasibility: 'already_on_pace' })).toContain('Your forecast already beats this target.');
  });

  it('visual constraints: sentence case, no tinted callout, no olive figures, no em dash', () => {
    for (const feasibility of ['achievable', 'stretch', 'unrealistic', 'already_on_pace'] as const) {
      const html = renderResultBody({ ...base, feasibility, shortfallSec: 60, caveat: 'Caveat.' });
      expect(html).not.toMatch(/text-transform:\s*uppercase/i);
      expect(html).not.toMatch(/background:\s*rgba\(/);
      expect(html).not.toContain('#4f5a3b');
      expect(html).not.toContain('\u2014');
    }
  });
});
