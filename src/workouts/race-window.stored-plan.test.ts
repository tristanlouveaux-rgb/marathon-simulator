import { describe, it, expect } from 'vitest';
import { clearStoredPlanRaceWindow, RACE_DAY_CLEAR_DAYS } from './race-day-rules';
import { raceWeekLayout, storedPlanRaceLayout } from './race-week-layout';

/**
 * Race-window rule for the stored-plan modes (triathlon, cycling, HYROX): in
 * the week before race week, the last 6 days before race day hold nothing;
 * long sessions move to 7 or more days out, keeping their order (running race
 * rules 3 and 4 for these engines). Plan week 1 starts Monday 5 October 2026.
 */

const START = '2026-10-05';
const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface S { n: string; t: string; dayOfWeek?: number; dayName?: string }
const s = (n: string, t: string, dayOfWeek: number): S => ({ n, t, dayOfWeek, dayName: NAMES[dayOfWeek] });
const isLong = (w: S) => w.t === 'long' || w.t === 'brick';

// A peak triathlon week as the scheduler lays it out.
const PEAK_WEEK: S[] = [
  s('Threshold run', 'threshold', 0),
  s('Swim', 'swim_technique', 1),
  s('Swim speed', 'swim_speed', 2),
  s('Bike over-under', 'bike_over_under', 3),
  s('Bike sweet spot', 'bike_sweet_spot', 4),
  s('Brick', 'brick', 5),
  s('Long run', 'long', 6),
  s('Easy run', 'easy', 6),
];

function apply(race: string, week: number, workouts: S[], extra: { firstScheduleDow?: number; isHard?: (w: S) => boolean } = {}) {
  const layout = raceWeekLayout(START, race)!;
  return clearStoredPlanRaceWindow(workouts, { weekIndex: week, layout, isLongSession: isLong, dayNames: NAMES, ...extra });
}
const days = (ws: S[]) => ws.map(w => `${NAMES[w.dayOfWeek!]}:${w.t}`);

describe('clearStoredPlanRaceWindow', () => {
  it('Thursday race (19 Nov): week 6 loses Friday to Sunday; brick and long run move to Wednesday and Thursday', () => {
    expect(days(apply('2026-11-19', 6, PEAK_WEEK))).toEqual([
      'Mon:threshold', 'Tue:swim_technique', 'Wed:brick', 'Thu:long',
    ]);
  });

  it('Friday race (20 Nov): brick Thursday, long run Friday (7 days out)', () => {
    expect(days(apply('2026-11-20', 6, PEAK_WEEK))).toEqual([
      'Mon:threshold', 'Tue:swim_technique', 'Wed:swim_speed', 'Thu:brick', 'Fri:long',
    ]);
  });

  it('Saturday race (21 Nov): the long run takes Saturday and the brick shifts to Friday, keeping their order', () => {
    const out = apply('2026-11-21', 6, PEAK_WEEK);
    expect(days(out)).toEqual([
      'Mon:threshold', 'Tue:swim_technique', 'Wed:swim_speed', 'Thu:bike_over_under', 'Fri:brick', 'Sat:long',
    ]);
    expect(out.find(w => w.t === 'long')?.dayName).toBe('Sat');
    expect(out.find(w => w.t === 'brick')?.dayName).toBe('Fri');
  });

  it('every remaining session is 7 or more days out, for every race weekday', () => {
    for (const race of ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']) {
      const layout = raceWeekLayout(START, race)!;
      for (let wk = 1; wk < layout.trainingWeeks; wk++) {
        for (const w of apply(race, wk, PEAK_WEEK)) {
          expect(layout.raceDayIndex - ((wk - 1) * 7 + w.dayOfWeek!), `${race} w${wk} ${w.n}`).toBeGreaterThan(RACE_DAY_CLEAR_DAYS);
        }
      }
    }
  });

  it('leaves a week with nothing in the window, race week and the closing week unchanged (same array)', () => {
    // Sunday race: week 6 is race week, week 5 ends 7 days out.
    expect(apply('2026-11-22', 5, PEAK_WEEK)).toBe(PEAK_WEEK);
    expect(apply('2026-11-22', 6, PEAK_WEEK)).toBe(PEAK_WEEK);
    // Thursday race: week 7 is race week; week 5 ends 11 days out.
    expect(apply('2026-11-19', 7, PEAK_WEEK)).toBe(PEAK_WEEK);
    expect(apply('2026-11-19', 5, PEAK_WEEK)).toBe(PEAK_WEEK);
    // Monday race: race week is week 6, week 7 the closing week.
    expect(apply('2026-11-16', 6, PEAK_WEEK)).toBe(PEAK_WEEK);
    expect(apply('2026-11-16', 7, PEAK_WEEK)).toBe(PEAK_WEEK);
    expect(apply('2026-11-16', 5, PEAK_WEEK)).toBe(PEAK_WEEK);
  });

  it('never moves a long session before the first schedulable day; with no day it is dropped', () => {
    // Thursday race 19 Nov, week 6, plan existing from Thursday only.
    expect(days(apply('2026-11-19', 6, PEAK_WEEK, { firstScheduleDow: 3 }))).toEqual([
      'Mon:threshold', 'Tue:swim_technique', 'Wed:swim_speed', 'Thu:long',
    ]);
    expect(days(apply('2026-11-19', 6, PEAK_WEEK, { firstScheduleDow: 4 }))).toEqual([
      'Mon:threshold', 'Tue:swim_technique', 'Wed:swim_speed', 'Thu:bike_over_under',
    ]);
  });

  it('with hard-session spacing (HYROX) a moved brick never lands next to a hard session', () => {
    const hyrox: S[] = [
      s('Tempo', 'hyrox_run_tempo', 0),
      s('Density', 'hyrox_station_density', 1),
      s('Technique', 'hyrox_station_technique', 2),
      s('Intervals', 'hyrox_run_intervals', 3),
      s('Brick', 'brick', 5),
      s('Easy', 'hyrox_run_easy', 6),
    ];
    const isHard = (w: S) => w.t === 'brick' || w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals' || w.t === 'hyrox_station_density';
    // Friday race 20 Nov: Friday (7 days out) sits next to Thursday's intervals,
    // so the brick takes Thursday instead (its intervals leave the week).
    expect(days(apply('2026-11-20', 6, hyrox, { isHard }))).toEqual([
      'Mon:hyrox_run_tempo', 'Tue:hyrox_station_density', 'Wed:hyrox_station_technique', 'Thu:brick',
    ]);
    // Without the spacing rule it takes Friday.
    expect(days(apply('2026-11-20', 6, hyrox))).toEqual([
      'Mon:hyrox_run_tempo', 'Tue:hyrox_station_density', 'Wed:hyrox_station_technique', 'Thu:hyrox_run_intervals', 'Fri:brick',
    ]);
  });

  it('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(PEAK_WEEK));
    apply('2026-11-19', 6, PEAK_WEEK);
    expect(PEAK_WEEK).toEqual(copy);
  });
});

describe('storedPlanRaceLayout', () => {
  it('is the running layout when the plan length is the calendar length', () => {
    expect(storedPlanRaceLayout(7, START, '2026-11-16')).toMatchObject({ calendarWeeks: 7, trainingWeeks: 6, closingWeek: true });
    expect(storedPlanRaceLayout(7, START, '2026-11-19')).toMatchObject({ calendarWeeks: 7, trainingWeeks: 7, closingWeek: false });
  });

  it('is null for a plan whose length is not the calendar length, or without a date', () => {
    expect(storedPlanRaceLayout(6, START, '2026-11-16')).toBeNull();
    expect(storedPlanRaceLayout(7, START, undefined)).toBeNull();
    expect(storedPlanRaceLayout(7, undefined, '2026-11-16')).toBeNull();
    expect(storedPlanRaceLayout(undefined, START, '2026-11-16')).toBeNull();
  });
});
