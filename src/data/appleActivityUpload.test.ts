import { describe, it, expect } from 'vitest';
import { filterCanonicalDuplicates } from './appleActivityUpload';
import type { GarminActivityRow } from '@/calculations/activity-matcher';

/** Minimal Apple row factory — only the fields the dedup reads. */
function appleRow(startISO: string): GarminActivityRow {
  return {
    garmin_id: `apple-watch-${startISO}`,
    activity_type: 'RUNNING',
    start_time: startISO,
    duration_sec: 1800,
    distance_m: 5000,
    avg_pace_sec_km: 360,
    avg_hr: null,
    max_hr: null,
    calories: null,
    aerobic_effect: null,
    anaerobic_effect: null,
  };
}

const ms = (iso: string) => Date.parse(iso);

describe('filterCanonicalDuplicates', () => {
  it('keeps all rows when there are no canonical rows', () => {
    const rows = [appleRow('2026-06-01T08:00:00.000Z'), appleRow('2026-06-02T08:00:00.000Z')];
    expect(filterCanonicalDuplicates(rows, [])).toHaveLength(2);
  });

  it('drops an Apple row within ±10 min of a canonical row (Strava wins)', () => {
    const rows = [appleRow('2026-06-01T08:05:00.000Z')];
    const canonical = [ms('2026-06-01T08:00:00.000Z')]; // 5 min earlier
    expect(filterCanonicalDuplicates(rows, canonical)).toHaveLength(0);
  });

  it('keeps an Apple row just outside the ±10 min window', () => {
    const rows = [appleRow('2026-06-01T08:11:00.000Z')];
    const canonical = [ms('2026-06-01T08:00:00.000Z')]; // 11 min earlier
    expect(filterCanonicalDuplicates(rows, canonical)).toHaveLength(1);
  });

  it('treats the window as inclusive at exactly 10 min', () => {
    const rows = [appleRow('2026-06-01T08:10:00.000Z')];
    const canonical = [ms('2026-06-01T08:00:00.000Z')]; // exactly 10 min
    expect(filterCanonicalDuplicates(rows, canonical)).toHaveLength(0);
  });

  it('checks both the before and after neighbour in the sorted array', () => {
    // Apple row sits between two canonical rows; the nearer (after) is within window.
    const rows = [appleRow('2026-06-01T08:00:00.000Z')];
    const canonical = [
      ms('2026-06-01T07:40:00.000Z'), // 20 min before — out
      ms('2026-06-01T08:08:00.000Z'), //  8 min after  — in
    ].sort((a, b) => a - b);
    expect(filterCanonicalDuplicates(rows, canonical)).toHaveLength(0);
  });

  it('mixes kept and dropped rows correctly against multiple canonical rows', () => {
    const rows = [
      appleRow('2026-06-01T08:03:00.000Z'), // dup of canonical #1 → drop
      appleRow('2026-06-03T08:00:00.000Z'), // no canonical nearby → keep
      appleRow('2026-06-05T18:02:00.000Z'), // dup of canonical #2 → drop
    ];
    const canonical = [
      ms('2026-06-01T08:00:00.000Z'),
      ms('2026-06-05T18:00:00.000Z'),
    ].sort((a, b) => a - b);
    const kept = filterCanonicalDuplicates(rows, canonical);
    expect(kept.map(r => r.start_time)).toEqual(['2026-06-03T08:00:00.000Z']);
  });

  it('drops rows with an unparseable start_time (cannot dedup safely)', () => {
    const rows = [appleRow('not-a-date')];
    const canonical = [ms('2026-06-01T08:00:00.000Z')];
    expect(filterCanonicalDuplicates(rows, canonical)).toHaveLength(0);
  });
});
