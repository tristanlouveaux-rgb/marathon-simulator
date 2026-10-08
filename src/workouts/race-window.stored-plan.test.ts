import { describe, it, expect } from 'vitest';
import { clearStoredPlanRaceWindow, placeStoredPlanRaceWeekPrimer, raceWeekPrimerDow, RACE_DAY_CLEAR_DAYS } from './race-day-rules';
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

  it('reports every session it removes, once, and never a moved one (onDrop)', () => {
    const layoutFor = (race: string) => raceWeekLayout(START, race)!;
    const cases: Array<[string, number, { firstScheduleDow?: number }]> = [
      ['2026-11-19', 6, {}], ['2026-11-20', 6, {}], ['2026-11-21', 6, {}],
      ['2026-11-19', 6, { firstScheduleDow: 4 }], // the long sessions have no day: both dropped
      ['2026-11-22', 5, {}], // nothing in the window
    ];
    for (const [race, week, extra] of cases) {
      const dropped: S[] = [];
      const out = clearStoredPlanRaceWindow(PEAK_WEEK, {
        weekIndex: week, layout: layoutFor(race), isLongSession: isLong, dayNames: NAMES, ...extra,
        onDrop: w => dropped.push(w),
      });
      const label = `${race} w${week} ${JSON.stringify(extra)}`;
      // Kept + dropped = the input, each session exactly once.
      expect([...out, ...dropped].map(w => w.n).sort(), label).toEqual(PEAK_WEEK.map(w => w.n).sort());
    }
    // Thursday race: Friday to Sunday sessions leave, and Wednesday's and
    // Thursday's are displaced by the moved brick and long run.
    const dropped: string[] = [];
    clearStoredPlanRaceWindow(PEAK_WEEK, {
      weekIndex: 6, layout: layoutFor('2026-11-19'), isLongSession: isLong, dayNames: NAMES,
      onDrop: w => dropped.push(w.t),
    });
    expect(dropped.sort()).toEqual(['bike_over_under', 'bike_sweet_spot', 'easy', 'swim_speed']);
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

describe('placeStoredPlanRaceWeekPrimer (running rule 2 for the triathlon engine)', () => {
  interface P { n: string; t: string; disc: string; dayOfWeek?: number; dayName?: string }
  const p = (n: string, t: string, disc: string, dayOfWeek: number): P => ({ n, t, disc, dayOfWeek, dayName: NAMES[dayOfWeek] });
  const RACE_WEEK: P[] = [
    p('Swim', 'swim_endurance', 'swim', 1),
    p('Primer', 'bike_sweet_spot', 'bike', 1),
    p('Easy run', 'easy', 'run', 2),
    p('Ride', 'bike_endurance', 'bike', 3),
    p('Long ride', 'bike_endurance', 'bike', 5),
  ];
  function place(race: string, week: number, ws: P[] = RACE_WEEK, firstScheduleDow?: number) {
    const layout = raceWeekLayout(START, race)!;
    return placeStoredPlanRaceWeekPrimer(ws, {
      weekIndex: week, layout, homeDow: 1, isPrimer: w => w.t === 'bike_sweet_spot', discipline: w => w.disc, firstScheduleDow, dayNames: NAMES,
    });
  }
  const show = (ws: P[]) => ws.map(w => `${NAMES[w.dayOfWeek!]}:${w.n}`);

  it('Wednesday race (18 Nov, race week 6): the Tuesday primer (8 days out) moves to Sunday, 3 days out', () => {
    expect(show(place('2026-11-18', 6))).toEqual(['Tue:Swim', 'Wed:Easy run', 'Thu:Ride', 'Sat:Long ride', 'Sun:Primer']);
  });

  it('swaps with the rides on the target day; other disciplines stay', () => {
    // Tuesday race (17 Nov): window Thursday to Saturday; Saturday holds the long ride.
    expect(show(place('2026-11-17', 6))).toEqual(['Tue:Swim', 'Tue:Long ride', 'Wed:Easy run', 'Thu:Ride', 'Sat:Primer']);
  });

  it('stays on its home day when that is 3 to 5 days out (Sunday race 22 Nov: Tuesday is 5 days out)', () => {
    expect(place('2026-11-22', 6)).toBe(RACE_WEEK);
  });

  it('a primer off its home day takes the latest window day: the only ride, on Saturday, moves to Sunday for a Wednesday race', () => {
    // Low hours: the week's only ride is the primer, and the scheduler seats a
    // last ride on Saturday (4 days out). Running's primer for a Wednesday race
    // sits on Sunday, 3 days out, leaving only the closing week's 2 days empty.
    const ws = [p('Swim', 'swim_technique', 'swim', 1), p('Primer', 'bike_sweet_spot', 'bike', 5)];
    expect(show(place('2026-11-18', 6, ws))).toEqual(['Tue:Swim', 'Sun:Primer']);
    // Sunday race: Saturday is 1 day out; the latest window day is Thursday, 3 days out.
    expect(show(place('2026-11-22', 7, ws))).toEqual(['Tue:Swim', 'Thu:Primer']);
  });

  it('a primer on race day moves before it; the ride it swaps with leaves the week', () => {
    // Thursday race 19 Nov: race week 7, window Monday only (3 days out). The
    // Monday ride would take race day, so it leaves the week.
    const ws = [p('Ride', 'bike_endurance', 'bike', 0), p('Swim', 'swim_endurance', 'swim', 1), p('Primer', 'bike_sweet_spot', 'bike', 3)];
    expect(show(place('2026-11-19', 7, ws))).toEqual(['Mon:Primer', 'Tue:Swim']);
  });

  it('no window day on or after the first schedulable day: the primer is dropped', () => {
    // Thursday race 19 Nov, plan existing from Tuesday of race week only.
    const ws = [p('Primer', 'bike_sweet_spot', 'bike', 3), p('Swim', 'swim_endurance', 'swim', 1)];
    expect(show(place('2026-11-19', 7, ws, 1))).toEqual(['Tue:Swim']);
  });

  it('leaves weeks other than race week unchanged (same array)', () => {
    expect(place('2026-11-18', 5)).toBe(RACE_WEEK);
    expect(place('2026-11-18', 7)).toBe(RACE_WEEK);
  });
});

describe('raceWeekPrimerDow: the running primer day for every race weekday', () => {
  // The running engine (Tuesday quality day) puts the race-week primer on these
  // days (probe of initializeSimulator plans, 2026-10-08): Monday race Friday,
  // Tuesday race Saturday, Wednesday race Sunday, Thursday race Monday, Friday,
  // Saturday and Sunday races Tuesday.
  const CASES: Array<[string, number, string]> = [
    ['2026-11-16', 6, 'Fri'], ['2026-11-17', 6, 'Sat'], ['2026-11-18', 6, 'Sun'],
    ['2026-11-19', 7, 'Mon'], ['2026-11-20', 7, 'Tue'], ['2026-11-21', 7, 'Tue'], ['2026-11-22', 7, 'Tue'],
  ];
  for (const [race, week, day] of CASES) {
    it(`race ${race}: ${day}`, () => {
      const layout = raceWeekLayout(START, race)!;
      expect(layout.trainingWeeks).toBe(week);
      const dow = raceWeekPrimerDow(layout, week, 1);
      expect(dow == null ? null : NAMES[dow]).toBe(day);
      const daysOut = layout.raceDayIndex - ((week - 1) * 7 + dow!);
      expect(daysOut).toBeGreaterThanOrEqual(3);
      expect(daysOut).toBeLessThanOrEqual(5);
    });
  }

  it('off its home day: the latest window day, 3 days out', () => {
    expect(NAMES[raceWeekPrimerDow(raceWeekLayout(START, '2026-11-22')!, 7, null)!]).toBe('Thu');
    expect(NAMES[raceWeekPrimerDow(raceWeekLayout(START, '2026-11-18')!, 6, null)!]).toBe('Sun');
  });

  it('none on or after the first schedulable day: null (the primer is dropped)', () => {
    const layout = raceWeekLayout(START, '2026-11-19')!; // Thursday race, window Monday only
    expect(raceWeekPrimerDow(layout, 7, 1, 1)).toBeNull();
    // From Saturday a Sunday race's window (Tuesday to Thursday) is past.
    expect(raceWeekPrimerDow(raceWeekLayout(START, '2026-11-22')!, 7, 1, 5)).toBeNull();
  });
});
