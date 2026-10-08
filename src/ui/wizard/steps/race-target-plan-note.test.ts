import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { racePlanNote, lowBaseMarathon, trainingWeeksForRace } from './race-target-plan-note';
import { calculateDaysUntil, calculateWeeksUntil, formatRaceDate, getMarathonsByDistance } from '@/data/marathons';
import { addCalendarDays, localDateKey, localMondayKey } from '@/utils/local-date';

/**
 * Race page (Tristan 2026-10-05): a race closer than a full build continues
 * into a sharpening block with one muted note picked from the plan's calendar
 * layout; a marathon block that cannot build marathon endurance says so and
 * calls the forecast optimistic (owner decision 2026-10-06).
 */

const NOW = new Date(2026, 9, 7, 10, 0); // Wednesday 7 October 2026, local
const TODAY = localDateKey(NOW);
const inDays = (d: number) => addCalendarDays(TODAY, d);

describe('racePlanNote', () => {
  it('a race today or in the past has no note (the date is refused)', () => {
    expect(racePlanNote('marathon', TODAY, NOW)).toBeNull();
    expect(racePlanNote('marathon', inDays(-3), NOW)).toBeNull();
  });

  it('race week only: too close for a primer at 1 or 2 days; easy runs and a primer from 3 days', () => {
    expect(racePlanNote('marathon', inDays(1), NOW)).toBe('Race in 1 day. Too close for a primer session. Any run before race day is easy.');
    expect(racePlanNote('half', inDays(2), NOW)).toBe('Race in 2 days. Too close for a primer session. Any run before race day is easy.');
    expect(racePlanNote('marathon', inDays(4), NOW)).toBe('Race in 4 days. The plan is race week only: easy runs and one short primer session.');
  });

  it('a 2-week marathon is a taper; a 2-week half has one training week', () => {
    // Sunday 18 October: training weeks 2 (plan starts Monday 5 October).
    expect(trainingWeeksForRace(inDays(11), NOW)).toBe(2);
    expect(racePlanNote('marathon', inDays(11), NOW)).toBe('2-week plan. The whole plan is a taper: volume drops each week while intensity holds.');
    expect(racePlanNote('half', inDays(11), NOW)).toBe('2-week plan, short of the 4-week half marathon build. 1 week of race-specific training, then race week.');
  });

  it('a 5-week marathon and a 3-week half name the training weeks and the taper', () => {
    expect(racePlanNote('marathon', inDays(32), NOW)).toBe('5-week plan, short of the 8-week marathon build. 3 weeks of race-specific training from current fitness, then a 2-week taper.');
    expect(racePlanNote('half', inDays(18), NOW)).toBe('3-week plan, short of the 4-week half marathon build. 2 weeks of race-specific training, then race week.');
  });

  it('a full build keeps its note', () => {
    expect(racePlanNote('marathon', inDays(109), NOW)).toBe('16 weeks of training');
  });

  it('a Monday race counts the training weeks before its closing week', () => {
    // Monday 16 November: race week is the week before, so 6 training weeks.
    expect(trainingWeeksForRace('2026-11-16', NOW)).toBe(6);
    expect(racePlanNote('marathon', '2026-11-16', NOW)).toContain('6-week plan');
  });
});

describe('lowBaseMarathon (owner decision 2026-10-06)', () => {
  const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();
  const runner = (km: number | null, daysAgo = 5, archetype = 'consistent-runner') => ({
    v: 45, pac: { e: 330 } as any, onboarding: {} as any,
    athleteArchetype: { archetype: archetype as any },
    onboardingRunHistory: km == null ? [] : [{ startTime: iso(daysAgo), distKm: km, durSec: km * 330, activityType: 'RUNNING' }],
  });
  const RACE_6WK = inDays(39); // Sunday 15 November: 6 training weeks

  it('example A (longest 1:40, block reaches 2:02): no warning', () => {
    expect(lowBaseMarathon('marathon', RACE_6WK, runner(18.2), 'intermediate', NOW)).toBeNull();
  });

  it('longest recent run 55 min: the block stays under the 1:55 long-run bar, so the warning names the gap', () => {
    const low = lowBaseMarathon('marathon', RACE_6WK, runner(10), 'intermediate', NOW)!;
    expect(low).not.toBeNull();
    expect(low.peakLongMin).toBeLessThan(115.5);
    expect(low.text).toBe(`6 weeks cannot build marathon endurance. Long runs reach about 1:${String(low.peakLongMin - 60).padStart(2, '0')}, short of the 2:45 marathon-readiness long run, so the forecast finish time is optimistic.`);
  });

  it('no run in the last 30 days: the warning leads with it', () => {
    const low = lowBaseMarathon('marathon', RACE_6WK, runner(25, 60), 'intermediate', NOW)!;
    expect(low.text.startsWith('No runs in the last 30 days. 6 weeks cannot build marathon endurance.')).toBe(true);
  });

  it('QA scenario lowbase-racepage: a projected long run under an hour reads in minutes, not 0:MM (2026-10-08)', () => {
    // Runs 40 to 75 days ago, none in the last 30: the block restarts the long run
    // at 30 min. Before: "Long runs reach about 0:36, short of the 2:45 ...".
    const s = {
      v: 45, pac: { e: 330, t: 280, i: 255, m: 300, r: 240 } as any, onboarding: {} as any,
      athleteArchetype: { archetype: 'detrained-with-history' as any },
      onboardingRunHistory: ([[40, 12, 66], [44, 6, 33], [47, 10, 55], [54, 8, 44], [61, 14, 78], [68, 7, 39], [75, 10, 56]] as const)
        .map(([daysAgo, km, min]) => ({ startTime: iso(daysAgo), distKm: km, durSec: min * 60, activityType: 'RUNNING' })),
    };
    const race = inDays(32); // Sunday 8 November: 5 training weeks
    const low = lowBaseMarathon('marathon', race, s, 'intermediate', NOW)!;
    expect(low).not.toBeNull();
    expect(low.peakLongMin).toBeLessThan(60);
    expect(low.text).toBe(`No runs in the last 30 days. 5 weeks cannot build marathon endurance. Long runs reach about ${low.peakLongMin} minutes, short of the 2:45 marathon-readiness long run, so the forecast finish time is optimistic.`);
    expect(low.text).not.toMatch(/about 0:/);
  });

  it('a beginner always gets the warning', () => {
    expect(lowBaseMarathon('marathon', RACE_6WK, runner(18.2), 'beginner', NOW)).not.toBeNull();
  });

  it('a half, or a marathon with a full build, never does', () => {
    expect(lowBaseMarathon('half', inDays(18), runner(5), 'beginner', NOW)).toBeNull();
    expect(lowBaseMarathon('marathon', inDays(109), runner(5), 'beginner', NOW)).toBeNull();
  });
});

describe('race dates are local calendar dates in every time zone', () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => vi.useRealTimers());
  afterAll(() => { if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ; });

  for (const [tz, when] of [
    ['Europe/London', new Date('2026-07-15T23:30:00Z')], // BST, 00:30 local on the 16th
    ['Europe/London', new Date('2026-01-14T23:30:00Z')], // GMT
    ['America/New_York', new Date('2026-10-07T02:30:00Z')], // 22:30 local on the 6th
    ['America/Los_Angeles', new Date('2026-10-07T05:30:00Z')], // 22:30 local on the 6th
    ['Australia/Sydney', new Date('2026-10-06T14:30:00Z')], // 01:30 local on the 7th
    ['UTC', new Date('2026-10-07T12:00:00Z')],
  ] as Array<[string, Date]>) {
    it(`${tz} ${when.toISOString()}: tomorrow is 1 day away and its weekday/plan week match the local calendar`, () => {
      process.env.TZ = tz;
      vi.useFakeTimers();
      vi.setSystemTime(when);
      const today = localDateKey(new Date());
      const tomorrow = addCalendarDays(today, 1);
      expect(calculateDaysUntil(tomorrow)).toBe(1);
      expect(calculateDaysUntil(today)).toBe(0);
      expect(calculateWeeksUntil(addCalendarDays(today, 15))).toBe(3);
      // The displayed date is the same calendar day.
      expect(formatRaceDate(tomorrow)).toContain(String(Number(tomorrow.slice(8, 10))));
      // Plan weeks start on the local Monday.
      expect(new Date(`${localMondayKey()}T12:00:00Z`).getUTCDay()).toBe(1);
    });
  }
});

describe('race list includes near races, never today or the past', () => {
  afterEach(() => vi.useRealTimers());
  it('every listed race is 1 day or more away; the race page list holds races under 8 weeks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 1, 9));
    const near = getMarathonsByDistance('marathon', 0, 52);
    expect(near.length).toBeGreaterThan(0);
    for (const r of near) expect(calculateDaysUntil(r.date)).toBeGreaterThanOrEqual(1);
    const full = getMarathonsByDistance('marathon');
    expect(near.length).toBeGreaterThan(full.length);
    expect(near.some(r => (r.weeksUntil ?? 99) < 8)).toBe(true);
  });
});
