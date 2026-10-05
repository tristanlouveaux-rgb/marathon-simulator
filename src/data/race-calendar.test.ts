import { describe, it, expect } from 'vitest';
import { sameWeekdaySlotInYear, nextEditionDate, withNextEdition } from './race-calendar';
import { WORLD_MARATHONS } from './marathons';
import { WORLD_TRIATHLONS } from './triathlons';

describe('sameWeekdaySlotInYear', () => {
  it('keeps "last Sunday of the month" races on the last Sunday (Berlin, London)', () => {
    expect(sameWeekdaySlotInYear('2026-09-27', 2027)).toBe('2027-09-26');
    expect(sameWeekdaySlotInYear('2026-04-26', 2027)).toBe('2027-04-25');
  });

  it('keeps nth-weekday races on the same nth weekday (Chicago, NYC, Boston)', () => {
    expect(sameWeekdaySlotInYear('2026-10-11', 2027)).toBe('2027-10-10'); // 2nd Sunday
    expect(sameWeekdaySlotInYear('2026-11-01', 2027)).toBe('2027-11-07'); // 1st Sunday
    expect(sameWeekdaySlotInYear('2026-04-20', 2027)).toBe('2027-04-19'); // 3rd Monday
  });

  it('preserves the weekday for every curated race', () => {
    for (const r of [...WORLD_MARATHONS, ...WORLD_TRIATHLONS]) {
      const src = new Date(`${r.date}T00:00:00Z`).getUTCDay();
      const out = new Date(`${sameWeekdaySlotInYear(r.date, 2027)}T00:00:00Z`).getUTCDay();
      expect(out, r.id).toBe(src);
    }
  });
});

describe('nextEditionDate', () => {
  it('returns an upcoming curated date untouched', () => {
    expect(nextEditionDate('2026-10-11', '2026-09-28')).toEqual({ date: '2026-10-11', estimated: false });
  });

  it('treats race day itself as upcoming', () => {
    expect(nextEditionDate('2026-09-28', '2026-09-28')).toEqual({ date: '2026-09-28', estimated: false });
  });

  it('projects a passed race to next year and flags it', () => {
    expect(nextEditionDate('2026-09-27', '2026-09-28')).toEqual({ date: '2027-09-26', estimated: true });
  });

  it('skips multiple stale years to the next edition on or after today', () => {
    expect(nextEditionDate('2024-04-21', '2026-02-01')).toEqual({ date: '2026-04-19', estimated: true });
    expect(nextEditionDate('2024-04-21', '2026-05-01')).toEqual({ date: '2027-04-18', estimated: true });
  });
});

describe('withNextEdition', () => {
  it('never leaves a curated race in the past', () => {
    const today = '2026-09-28';
    for (const r of [...WORLD_MARATHONS, ...WORLD_TRIATHLONS]) {
      expect(withNextEdition(r, today).date >= today, r.id).toBe(true);
    }
  });

  it('keeps id and other fields so stored selections and course profiles still resolve', () => {
    const berlin = WORLD_MARATHONS.find(m => m.id === 'berlin')!;
    const rolled = withNextEdition(berlin, '2026-09-28');
    expect(rolled.id).toBe('berlin');
    expect(rolled.city).toBe(berlin.city);
    expect(rolled.estimated).toBe(true);
  });
});
