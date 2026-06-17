import { describe, it, expect } from 'vitest';
import { parseHhMmSs } from './goal-modal';

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
