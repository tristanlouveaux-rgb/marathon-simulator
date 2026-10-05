import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { localDateKey } from './local-date';

/**
 * localDateKey must give the DEVICE-LOCAL calendar date for a GMT ISO string,
 * the format HealthKit timestamps arrive in. `iso.split('T')[0]` gives the UTC
 * date instead, which is a day off for evening samples west of UTC and for
 * morning samples east of UTC.
 *
 * Fixed-offset zones with no DST, so the offsets hold all year:
 * America/Phoenix = UTC-7, Australia/Brisbane = UTC+10.
 */

const ORIGINAL_TZ = process.env.TZ;
function restoreTz(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

describe('localDateKey in UTC-7 (America/Phoenix)', () => {
  beforeAll(() => { process.env.TZ = 'America/Phoenix'; });
  afterAll(restoreTz);

  it('the zone is applied (guards against a runtime that ignores TZ)', () => {
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(420);
  });

  it('keys a 19:00 local sample to its local date, not the next UTC date', () => {
    // 19:00 on 1 Oct in Phoenix = 02:00Z on 2 Oct.
    const iso = '2026-10-02T02:00:00.000Z';
    expect(iso.split('T')[0]).toBe('2026-10-02');
    expect(localDateKey(iso)).toBe('2026-10-01');
  });

  it('accepts a Date', () => {
    expect(localDateKey(new Date('2026-10-02T06:59:59.000Z'))).toBe('2026-10-01');
    expect(localDateKey(new Date('2026-10-02T07:00:00.000Z'))).toBe('2026-10-02');
  });

  it('returns a bare date string unchanged (no UTC-midnight shift back a day)', () => {
    expect(localDateKey('2026-10-01')).toBe('2026-10-01');
  });

  it('returns an empty key for an unparseable input', () => {
    expect(localDateKey('not a date')).toBe('');
    expect(localDateKey(new Date(NaN))).toBe('');
  });
});

describe('localDateKey in UTC+10 (Australia/Brisbane)', () => {
  beforeAll(() => { process.env.TZ = 'Australia/Brisbane'; });
  afterAll(restoreTz);

  it('the zone is applied (guards against a runtime that ignores TZ)', () => {
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(-600);
  });

  it('keys an 08:00 local sample to its local date, not the previous UTC date', () => {
    // 08:00 on 1 Oct in Brisbane = 22:00Z on 30 Sep.
    const iso = '2026-09-30T22:00:00.000Z';
    expect(iso.split('T')[0]).toBe('2026-09-30');
    expect(localDateKey(iso)).toBe('2026-10-01');
  });

  it('local midnight is the day boundary', () => {
    // 23:59:59 on 30 Sep local = 13:59:59Z; 00:00 on 1 Oct local = 14:00Z.
    expect(localDateKey('2026-09-30T13:59:59.000Z')).toBe('2026-09-30');
    expect(localDateKey('2026-09-30T14:00:00.000Z')).toBe('2026-10-01');
  });

  it('returns a bare date string unchanged', () => {
    expect(localDateKey('2026-10-01')).toBe('2026-10-01');
  });
});
