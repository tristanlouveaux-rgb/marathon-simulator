import { describe, it, expect, afterEach, vi } from 'vitest';
import { raceWeekLayout, planTrainingWeeks, isClosingWeek, planRaceLayout, runningRaceDateISO } from './race-week-layout';
import { calendarDayNumber, addCalendarDays, localMondayKey } from '@/utils/local-date';

/**
 * Race week = the calendar week holding the day 3 days before race day, so the
 * race-week primer (3 to 5 days out) always falls in race week. A Monday to
 * Wednesday race gets a closing week holding only the race.
 */

const START = '2026-10-05'; // a Monday

describe('raceWeekLayout', () => {
  // Race days in plan week 6 (Mon 2026-11-09 .. Sun 2026-11-15).
  const cases: Array<[string, string, number, number, boolean, number]> = [
    // label, race date, calendar weeks, training weeks, closing, race weekday
    ['Monday', '2026-11-09', 6, 5, true, 0],
    ['Tuesday', '2026-11-10', 6, 5, true, 1],
    ['Wednesday', '2026-11-11', 6, 5, true, 2],
    ['Thursday', '2026-11-12', 6, 6, false, 3],
    ['Friday', '2026-11-13', 6, 6, false, 4],
    ['Saturday', '2026-11-14', 6, 6, false, 5],
    ['Sunday', '2026-11-15', 6, 6, false, 6],
  ];
  for (const [label, race, cal, train, closing, dow] of cases) {
    it(`${label} race: ${cal} calendar weeks, ${train} training weeks${closing ? ', closing week' : ''}`, () => {
      expect(raceWeekLayout(START, race)).toEqual({
        calendarWeeks: cal, trainingWeeks: train, closingWeek: closing, raceDayOfWeek: dow,
        raceDayIndex: calendarDayNumber(race) - calendarDayNumber(START),
      });
    });
  }

  it('the day 3 days out always falls in race week', () => {
    for (let d = 3; d < 60; d++) {
      const race = addCalendarDays(START, d);
      const l = raceWeekLayout(START, race)!;
      expect(Math.floor((l.raceDayIndex - 3) / 7) + 1, race).toBe(l.trainingWeeks);
    }
  });

  it('fallback: when the day 3 days out falls before the plan starts, the race week is the race\'s own week', () => {
    // Onboarding on the Monday of a Tuesday or Wednesday race (1 or 2 days out).
    expect(raceWeekLayout(START, '2026-10-06')).toMatchObject({ calendarWeeks: 1, trainingWeeks: 1, closingWeek: false });
    expect(raceWeekLayout(START, '2026-10-07')).toMatchObject({ calendarWeeks: 1, trainingWeeks: 1, closingWeek: false });
    // A Monday race 7 days out: day 3 out is the Friday of week 1.
    expect(raceWeekLayout(START, '2026-10-12')).toMatchObject({ calendarWeeks: 2, trainingWeeks: 1, closingWeek: true });
  });

  it('a race before plan start or a malformed date has no layout', () => {
    expect(raceWeekLayout(START, '2026-10-04')).toBeNull();
    expect(raceWeekLayout(START, '2026-10')).toBeNull();
  });

  it('counts calendar days exactly across a DST change (Europe and US clocks change in this span)', () => {
    // 2026-10-25 (EU) and 2026-11-01 (US) fall inside: day arithmetic must not drift.
    expect(raceWeekLayout('2026-10-19', '2026-11-08')).toMatchObject({ calendarWeeks: 3, raceDayOfWeek: 6, raceDayIndex: 20 });
  });
});

describe('plan helpers', () => {
  const wks = (n: number, closing: boolean) =>
    Array.from({ length: n }, (_, i) => ({ raceClosing: closing && i === n - 1 ? true : undefined }));

  it('planTrainingWeeks drops only a closing week', () => {
    expect(planTrainingWeeks({ tw: 7, wks: wks(7, true) })).toBe(6);
    expect(planTrainingWeeks({ tw: 7, wks: wks(7, false) })).toBe(7);
    expect(planTrainingWeeks({ wks: wks(5, true) })).toBe(4);
    expect(planTrainingWeeks({ tw: 3 })).toBe(3);
  });

  it('isClosingWeek reads the week flag', () => {
    expect(isClosingWeek({ wks: wks(7, true) }, 7)).toBe(true);
    expect(isClosingWeek({ wks: wks(7, true) }, 6)).toBe(false);
  });

  it('runningRaceDateISO: running race plans only, event date first', () => {
    expect(runningRaceDateISO({ selectedMarathon: { date: '2026-11-15' }, onboarding: { customRaceDate: '2026-11-10' } })).toBe('2026-11-15');
    expect(runningRaceDateISO({ onboarding: { customRaceDate: '2026-11-10' } })).toBe('2026-11-10');
    expect(runningRaceDateISO({ continuousMode: true, onboarding: { customRaceDate: '2026-11-10' } })).toBeNull();
    expect(runningRaceDateISO({ eventType: 'hyrox', onboarding: { customRaceDate: '2026-11-10' } })).toBeNull();
  });

  it('planRaceLayout: only when the plan\'s calendar matches the race date (old plans keep their weeks)', () => {
    const s = { tw: 6, planStartDate: START, wks: wks(6, true), onboarding: { customRaceDate: '2026-11-10' } };
    expect(planRaceLayout(s)).toMatchObject({ trainingWeeks: 5, closingWeek: true });
    expect(planRaceLayout({ ...s, tw: 5, wks: wks(5, false) })).toBeNull();
  });
});

describe('local calendar helpers', () => {
  afterEach(() => vi.useRealTimers());

  it('calendarDayNumber and addCalendarDays are exact day arithmetic', () => {
    expect(calendarDayNumber('1970-01-02')).toBe(1);
    expect(addCalendarDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addCalendarDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(Number.isNaN(calendarDayNumber('bad'))).toBe(true);
  });

  it('localMondayKey: the local Monday on or before a date', () => {
    expect(localMondayKey('2026-10-05')).toBe('2026-10-05');
    expect(localMondayKey('2026-10-11')).toBe('2026-10-05');
    expect(localMondayKey('2026-10-12')).toBe('2026-10-12');
    // A local Monday just after midnight is that Monday, whatever the UTC date.
    expect(localMondayKey(new Date(2026, 9, 12, 0, 30))).toBe('2026-10-12');
    expect(localMondayKey(new Date(2026, 9, 11, 23, 30))).toBe('2026-10-05');
  });
});
