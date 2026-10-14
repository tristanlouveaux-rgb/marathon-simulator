/**
 * tri-taper.ts unit tests: the race-week composer on synthetic reference
 * weeks, the taper quality builders and the taper intensity gate
 * (tri-intensity-profile). SCIENCE_LOG "Triathlon and cycling taper rebuild".
 */
import { describe, it, expect } from 'vitest';
import type { Workout } from '@/types/state';
import {
  composeTriRaceWeek,
  triQualityWorkMinutes,
  triRacePaceSession,
  triRacePaceTargetReps,
  triRaceWeekBrick,
  triTaperQualitySwim,
  triTaperSwimPlan,
  triTaperThresholdRunDesc,
  triTaperThresholdRunNeedMin,
  triTaperVo2MicrosRide,
  triTaperMicrosNeedMin,
  triDayBeforeRun,
  bikeKindForIntensity,
  TRI_DAY_BEFORE_RIDE_MAX_MIN,
  TRI_DAY_BEFORE_RUN_MAX_MIN,
  TRI_RACE_PACE_MAX_REPS,
  TRI_RACE_PACE_MIN_REPS,
  TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY,
  TRI_RACE_WEEK_SESSION_CAP_MIN,
  TRI_TAPER_MICROS_REPS,
  TRI_TAPER_SESSION_FLOOR_MIN,
  TRI_TAPER_THRESHOLD_REPS,
  type TriRaceWeekInput,
  type TriTaperSessionCtx,
} from './tri-taper';
import { selectBikeQualityKind, selectRunQualityKind, selectSwimQualityKind } from './tri-intensity-profile';
import { loadForBike } from './bike';
import { loadForSwim } from './swim';
import { loadForTriRun } from './rung-load';

const ctx: TriTaperSessionCtx = {
  shortCourse: false, bikeIF: 0.78, ftp: 250, hasPowerMeter: true, cssSecPer100m: 100, swimSkill: 3, easyLabel: '5:45/km',
};

/** Aerobic builders priced like the library (endurance ride, easy run,
 *  endurance swim). */
const aerobic = (d: 'swim' | 'bike' | 'run', minutes: number): Workout => ({
  n: `${d} aerobic`, t: d === 'swim' ? 'swim_endurance' : d === 'bike' ? 'bike_endurance' : 'easy',
  d: '', r: 4, discipline: d, estimatedDurationMin: minutes,
  ...(d === 'swim' ? loadForSwim('endurance', minutes) : d === 'bike' ? loadForBike('endurance', minutes) : loadForTriRun('easy', minutes)!),
});
const dayBeforeRide = (m: number): Workout => ({
  n: 'Pre-race spin', t: 'bike_endurance', d: '', r: 3, discipline: 'bike', estimatedDurationMin: m, taperRole: 'day_before',
  ...loadForBike('endurance', m),
});

/** A 70.3 reference week like the probe's (10 h): swim 96, bike 262, run 243. */
function input70(daysOut: Array<number | null>, over: Partial<TriRaceWeekInput> = {}): TriRaceWeekInput {
  return {
    present: { swim: true, bike: true, run: true },
    longCourse: true,
    singleSport: false,
    fraction: 0.30,
    ref: { minutes: { swim: 96, bike: 262, run: 243 }, counts: { swim: 2, bike: 3, run: 3 }, total: 8 },
    daysOut,
    ctx,
    aerobic,
    dayBeforeRide,
    ...over,
  };
}

const SUNDAY = [6, 5, 4, 3, 2, 1, null];
const WEDNESDAY = [9, 8, 7, 6, 5, 4, 3];
const THURSDAY = [3, 2, 1, null, null, null, null];

function perDisc(ws: Workout[]) {
  const m = { swim: 0, bike: 0, run: 0 } as Record<string, number>;
  for (const w of ws) {
    if (w.t === 'brick' && w.brickSegments) for (const sg of w.brickSegments) m[sg.discipline] += sg.durationMin ?? 0;
    else m[w.discipline ?? 'run'] += w.estimatedDurationMin ?? 0;
  }
  return m;
}

const load = (ws: Workout[]) => ws.reduce((a, w) => a + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);
const mins = (ws: Workout[]) => ws.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);

/** Race-week shape rules every composed week keeps. */
function shapeViolations(out: Workout[]): string[] {
  const v: string[] = [];
  const db = out.filter(w => w.taperRole === 'day_before');
  for (let d = 0; d < 7; d++) {
    const day = out.filter(w => w.dayOfWeek === d && w.taperRole !== 'day_before');
    if (day.length > TRI_RACE_WEEK_MAX_SESSIONS_PER_DAY) v.push(`${day.length} sessions on day ${d}`);
    if (day.length > 0 && db.length > 0) {
      if (mins(db) > mins(day)) v.push(`day before ${mins(db)} min > day ${d} ${mins(day)} min`);
      if (load(db) > load(day)) v.push(`day before load ${load(db)} > day ${d} ${load(day)}`);
    }
  }
  for (const w of out) {
    if (w.t === 'brick' || w.taperRole === 'day_before') continue;
    const cap = TRI_RACE_WEEK_SESSION_CAP_MIN[w.discipline as 'swim' | 'bike' | 'run'];
    if ((w.estimatedDurationMin ?? 0) > cap) v.push(`${w.discipline} ${w.estimatedDurationMin} > ${cap}`);
    if ((w.estimatedDurationMin ?? 0) < TRI_TAPER_SESSION_FLOOR_MIN) v.push(`${w.discipline} ${w.estimatedDurationMin} below the floor`);
  }
  for (const w of db) {
    const cap = w.discipline === 'bike' ? TRI_DAY_BEFORE_RIDE_MAX_MIN : TRI_DAY_BEFORE_RUN_MAX_MIN;
    if ((w.estimatedDurationMin ?? 0) > cap) v.push(`day before ${w.discipline} ${w.estimatedDurationMin} > ${cap}`);
  }
  return v;
}

describe('composeTriRaceWeek', () => {
  it('70.3, Sunday race: openers hold as many 90 s repeats as days to go; Byrn brick 3 days out; Friday empty; Saturday the lightest day', () => {
    const out = composeTriRaceWeek(input70(SUNDAY));
    const day = (dow: number) => out.filter(w => w.dayOfWeek === dow);
    expect(day(4)).toEqual([]); // two days out: rest
    expect(day(5).length).toBeGreaterThan(0);
    expect(day(5).every(w => w.taperRole === 'day_before')).toBe(true);
    const brick = out.find(w => w.t === 'brick')!;
    expect(brick.dayOfWeek).toBe(3);
    expect(brick.brickSegments!.map(s => s.durationMin)).toEqual([45, 15]);
    for (const o of out.filter(w => w.taperRole === 'opener' && w.t !== 'brick')) {
      expect(o.d).toContain(`${SUNDAY[o.dayOfWeek!]}×90s`);
    }
    // The run opener comes first (furthest from the race), then the swim.
    expect(out.find(w => w.taperRole === 'opener' && w.discipline === 'run')!.dayOfWeek).toBe(1);
    expect(out.find(w => w.taperRole === 'opener' && w.discipline === 'swim')!.dayOfWeek).toBe(2);
    // Lands on 0.30 per discipline within one floor-length session.
    const m = perDisc(out);
    expect(Math.abs(m.swim - 0.3 * 96)).toBeLessThanOrEqual(TRI_TAPER_SESSION_FLOOR_MIN);
    expect(Math.abs(m.bike - 0.3 * 262)).toBeLessThanOrEqual(TRI_TAPER_SESSION_FLOOR_MIN);
    expect(Math.abs(m.run - 0.3 * 243)).toBeLessThanOrEqual(TRI_TAPER_SESSION_FLOOR_MIN);
    // 80% of the reference week's 8 sessions, the race counted.
    expect(out.length + 1).toBeGreaterThanOrEqual(Math.ceil(0.8 * 8));
    expect(shapeViolations(out)).toEqual([]);
  });

  it('the day before starts at its lower bounds and never outweighs an earlier training day', () => {
    for (const fraction of [0.30, 0.55]) {
      for (const days of [SUNDAY, [5, 4, 3, 2, 1, null, null]]) {
        const out = composeTriRaceWeek(input70(days, { fraction }));
        expect(shapeViolations(out), `${fraction} ${days}`).toEqual([]);
        const ride = out.find(w => w.taperRole === 'day_before' && w.discipline === 'bike');
        expect(ride, `${fraction} ${days}`).toBeDefined();
        expect(ride!.estimatedDurationMin!).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it('Wednesday race: no day-before or rest day in race week, openers 5 to 3 days out, aerobic sessions nearest 6 days out', () => {
    const out = composeTriRaceWeek(input70(WEDNESDAY));
    expect(out.some(w => w.taperRole === 'day_before')).toBe(false);
    const openers = out.filter(w => w.taperRole === 'opener');
    expect(openers.every(w => WEDNESDAY[w.dayOfWeek!]! >= 3 && WEDNESDAY[w.dayOfWeek!]! <= 5)).toBe(true);
    const aerobicDays = new Set(out.filter(w => !w.taperRole).map(w => w.dayOfWeek));
    expect(aerobicDays.has(3)).toBe(true); // Thursday, 6 days out
    expect(aerobicDays.has(0)).toBe(false); // Monday, 9 days out, stays empty
    expect(shapeViolations(out)).toEqual([]);
  });

  it('Thursday race: Monday is the only training day; every discipline still has a session; two at most', () => {
    const out = composeTriRaceWeek(input70(THURSDAY));
    for (const w of out) expect([0, 2]).toContain(w.dayOfWeek);
    for (const d of ['swim', 'bike', 'run']) {
      expect(out.some(w => w.discipline === d || (d === 'run' && w.t === 'brick'))).toBe(true);
    }
    expect(shapeViolations(out)).toEqual([]);
  });

  it('short course: no brick; openers run, bike, swim, typed by their steady content; one-week fraction 0.55', () => {
    const out = composeTriRaceWeek(input70(SUNDAY, {
      longCourse: false, fraction: 0.55, ctx: { ...ctx, shortCourse: true, bikeIF: 0.88 },
      ref: { minutes: { swim: 59, bike: 160, run: 144 }, counts: { swim: 1, bike: 2, run: 2 }, total: 5 },
    }));
    expect(out.some(w => w.t === 'brick')).toBe(false);
    const order = out.filter(w => w.taperRole === 'opener').sort((a, b) => a.dayOfWeek! - b.dayOfWeek!).map(w => w.discipline);
    expect(order).toEqual(['run', 'bike', 'swim']);
    const bike = out.find(w => w.taperRole === 'opener' && w.discipline === 'bike')!;
    expect(bike.t).toBe('bike_endurance');
    expect(bike.d).toContain('(race intensity)');
    const run = out.find(w => w.taperRole === 'opener' && w.discipline === 'run')!;
    expect([run.t, run.rpe]).toEqual(['easy', 4]);
    expect(shapeViolations(out)).toEqual([]);
  });

  it('a thin budget keeps its opener 3 days out, so the last session stays within 3 days of the race', () => {
    const out = composeTriRaceWeek(input70(WEDNESDAY, {
      longCourse: false, fraction: 0.30, ctx: { ...ctx, shortCourse: true, bikeIF: 0.88 },
      ref: { minutes: { swim: 40, bike: 60, run: 70 }, counts: { swim: 1, bike: 2, run: 2 }, total: 5 },
    }));
    const openers = out.filter(w => w.taperRole === 'opener');
    expect(openers.length).toBeGreaterThan(0);
    expect(Math.min(...out.map(w => WEDNESDAY[w.dayOfWeek!]!))).toBe(3);
  });

  it('cycling: a ride opener on every window day (Friel), the day-before spin', () => {
    const out = composeTriRaceWeek(input70(SUNDAY, {
      present: { swim: false, bike: true, run: false }, longCourse: false, singleSport: true,
      ref: { minutes: { swim: 0, bike: 602, run: 0 }, counts: { swim: 0, bike: 5, run: 0 }, total: 5 },
      ctx: { ...ctx, bikeIF: 0.74 },
    }));
    expect(out.filter(w => w.taperRole === 'opener').map(w => w.dayOfWeek)).toEqual([1, 2, 3]);
    expect(out.filter(w => w.taperRole === 'day_before').map(w => w.dayOfWeek)).toEqual([5]);
    expect(out.every(w => w.discipline === 'bike')).toBe(true);
    expect(shapeViolations(out)).toEqual([]);
  });

  it('a large budget never builds multi-hour openers or stacked days (review: a 231-min opener, 487 min on one day)', () => {
    // Ironman 25 h reference week, one-week taper (0.55), Friday and Sunday races.
    const ref = { minutes: { swim: 236, bike: 644, run: 693 }, counts: { swim: 3, bike: 3, run: 3 }, total: 9 };
    for (const days of [[4, 3, 2, 1, null, null, null], SUNDAY]) {
      const out = composeTriRaceWeek(input70(days, {
        fraction: 0.55, ref, dayCapMin: { 0: 180, 1: 180, 2: 180, 3: 180, 4: 180, 5: 540, 6: 540 },
      }));
      expect(shapeViolations(out), `${days}`).toEqual([]);
    }
  });

  it('never holds more than the week before (a one-week taper after a deload)', () => {
    const out = composeTriRaceWeek(input70(SUNDAY, {
      longCourse: false, fraction: 0.55, ctx: { ...ctx, shortCourse: true, bikeIF: 0.88 },
      ref: { minutes: { swim: 59, bike: 160, run: 144 }, counts: { swim: 1, bike: 2, run: 2 }, total: 5 },
      maxTotalMin: 170,
    }));
    expect(mins(out)).toBeLessThanOrEqual(170);
  });

  it('day caps choose days and never drop a session: a 0 h weekday athlete keeps race week at its fraction (review: one 31-min opener)', () => {
    // triDayCaps at 0 weekday hours: weekday caps 0, weekend 1.2 x half the week.
    const dayCapMin = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 360, 6: 360 };
    const out = composeTriRaceWeek(input70(SUNDAY, { dayCapMin }));
    const m = perDisc(out);
    expect(Math.abs(m.swim - 0.3 * 96)).toBeLessThanOrEqual(TRI_TAPER_SESSION_FLOOR_MIN);
    expect(Math.abs(m.bike - 0.3 * 262)).toBeLessThanOrEqual(TRI_TAPER_SESSION_FLOOR_MIN);
    expect(Math.abs(m.run - 0.3 * 243)).toBeLessThanOrEqual(TRI_TAPER_SESSION_FLOOR_MIN);
    for (const d of ['swim', 'bike', 'run']) expect(out.some(w => w.discipline === d)).toBe(true);
    expect(out.length + 1).toBeGreaterThanOrEqual(Math.ceil(0.8 * 8));
    // Training sits on the weekdays (no weekend day is open before the race),
    // as the normal week spills a 0 h weekday athlete's sessions there.
    expect(out.filter(w => w.taperRole !== 'day_before').every(w => w.dayOfWeek! <= 3)).toBe(true);
    expect(shapeViolations(out)).toEqual([]);
  });

  it('Thursday race with a thin weekday cap keeps its swim (review: the 32-min swim found 15 min of room and was left out)', () => {
    for (const cap of [0, 9, 18]) {
      const out = composeTriRaceWeek(input70(THURSDAY, {
        longCourse: false, fraction: 0.55, ctx: { ...ctx, shortCourse: true, bikeIF: 0.88 },
        ref: { minutes: { swim: 59, bike: 160, run: 144 }, counts: { swim: 2, bike: 2, run: 2 }, total: 6 },
        dayCapMin: { 0: cap, 1: cap, 2: cap, 3: cap, 4: cap, 5: 300, 6: 300 },
      }));
      for (const d of ['swim', 'bike', 'run']) expect(out.some(w => w.discipline === d), `cap ${cap} ${d}`).toBe(true);
      expect(shapeViolations(out), `cap ${cap}`).toEqual([]);
    }
  });

  it('Thursday race with no budget for an opener: it goes to the swim, not to the run that has its day-before jog (review: the swim was dropped)', () => {
    // A thin reference week (sprint at 4 h with gym): 0.55 gives swim 16.5
    // and bike 16.5 (under the 20-min day-before ride), run 33 with the 5-min
    // jog. No budget holds an opener; Monday's two slots must carry the swim
    // and the ride.
    const out = composeTriRaceWeek(input70(THURSDAY, {
      longCourse: false, fraction: 0.55, ctx: { ...ctx, shortCourse: true, bikeIF: 0.88 },
      ref: { minutes: { swim: 30, bike: 30, run: 60 }, counts: { swim: 1, bike: 1, run: 2 }, total: 4 },
    }));
    for (const d of ['swim', 'bike', 'run']) expect(out.some(w => w.discipline === d), d).toBe(true);
    expect(out.filter(w => w.taperRole === 'opener').map(w => w.discipline)).toEqual(['swim']);
    expect(out.filter(w => w.taperRole === 'day_before').map(w => w.discipline)).toEqual(['run']);
    expect(shapeViolations(out)).toEqual([]);
  });

  it('sessions that cannot fit the slots come off the discipline that loses least (review: the run always absorbed the cut)', () => {
    // Olympic 13 h reference (review's synthetic case): 0.55 gives swim 69,
    // bike 190, run 171; nine sessions for eight slots.
    const out = composeTriRaceWeek(input70(SUNDAY, {
      longCourse: false, fraction: 0.55, ctx: { ...ctx, shortCourse: true, bikeIF: 0.83 },
      ref: { minutes: { swim: 126, bike: 345, run: 311 }, counts: { swim: 3, bike: 3, run: 3 }, total: 9 },
    }));
    const m = perDisc(out);
    const runs = out.filter(w => w.discipline === 'run' && w.taperRole !== 'day_before');
    // The swim gives up a session and keeps its minutes in two; the run keeps
    // three sessions, each at its 45-min race-week cap.
    expect(out.filter(w => w.discipline === 'swim').length).toBe(2);
    expect(runs.length).toBe(3);
    expect(runs.every(w => w.estimatedDurationMin === TRI_RACE_WEEK_SESSION_CAP_MIN.run)).toBe(true);
    expect(Math.abs(m.swim - 0.55 * 126)).toBeLessThanOrEqual(TRI_TAPER_SESSION_FLOOR_MIN);
    expect(Math.abs(m.bike - 0.55 * 345)).toBeLessThanOrEqual(TRI_TAPER_SESSION_FLOOR_MIN);
    expect(shapeViolations(out)).toEqual([]);
  });

  it('the day before drops the run first when ride plus run would outweigh the lightest day; every discipline keeps a session', () => {
    // A thin bike budget (21 min at 0.30 of 70) and a 20-min swim opener as
    // the lightest earlier day: ride 20 + run 5 would be heavier.
    const out = composeTriRaceWeek(input70(SUNDAY, {
      longCourse: false, ctx: { ...ctx, shortCourse: true, bikeIF: 0.88 },
      ref: { minutes: { swim: 70, bike: 70, run: 150 }, counts: { swim: 2, bike: 2, run: 3 }, total: 7 },
    }));
    expect(out.filter(w => w.taperRole === 'day_before').map(w => w.discipline)).toEqual(['bike']);
    expect(out.some(w => w.discipline === 'run' && w.taperRole !== 'day_before')).toBe(true);
    for (const d of ['swim', 'bike', 'run']) expect(out.some(w => w.discipline === d), d).toBe(true);
    expect(shapeViolations(out)).toEqual([]);
  });

  it('the day-before ride is never the week\'s longest session', () => {
    const out = composeTriRaceWeek(input70(SUNDAY, {
      fraction: 0.55,
      ref: { minutes: { swim: 39, bike: 48, run: 51 }, counts: { swim: 1, bike: 1, run: 1 }, total: 3 },
      longCourse: false, ctx: { ...ctx, shortCourse: true },
    }));
    const ride = out.find(w => w.taperRole === 'day_before' && w.discipline === 'bike');
    const longest = Math.max(...out.filter(w => w.taperRole !== 'day_before').map(w => w.estimatedDurationMin!));
    if (ride) expect(ride.estimatedDurationMin!).toBeLessThanOrEqual(longest);
  });
});

describe('taper week 1 quality sessions', () => {
  it('reference work is read from the library description', () => {
    expect(triQualityWorkMinutes({ d: '15min warm up @ 5:46/km. 4×6min @ 5:01/km, 90s jog recovery. 10min cool down.', discipline: 'run' })).toBe(24);
    expect(triQualityWorkMinutes({ d: '20min Warm up. Main: 15×(30s @ Z5 / 30s @ Z1). 10min Cool down.', discipline: 'bike' })).toBe(7.5);
    expect(triQualityWorkMinutes({ d: '20min Warm up. Main: 2×(10×30s @ X / 30s easy), 5min easy between blocks.', discipline: 'bike' })).toBe(10);
    expect(triQualityWorkMinutes({ d: '15min Warm up. Main: 3×(3min @ X → 3min @ Y) continuous.', discipline: 'bike' })).toBe(18);
    expect(triQualityWorkMinutes({ d: '15min Warm up. Main: 40min continuous tempo @ X. 10min Cool down.', discipline: 'bike' })).toBe(40);
    expect(triQualityWorkMinutes({ d: '2300m total. 200m Warm up. Main: 10×200m, 25s rest. 200m Cool down.', discipline: 'swim' }, 100)).toBeCloseTo(2000 / 100 * 100 / 60, 5);
    expect(triQualityWorkMinutes({ d: 'Easy run.', discipline: 'run' })).toBeNull();
  });

  it('long-course race-pace work: 75% of the reference, inside Dave Scott\'s 4 to 12 min (3 to 8 x 90 s)', () => {
    expect(triRacePaceTargetReps(null)).toBe(TRI_RACE_PACE_MAX_REPS);
    expect(triRacePaceTargetReps(24)).toBe(8);
    expect(triRacePaceTargetReps(10)).toBe(5);
    expect(triRacePaceTargetReps(4)).toBe(TRI_RACE_PACE_MIN_REPS);
    // Review: an Ironman 25 h race-pace run held 23 x 90 s in 2 h 10 min.
    const long = triRacePaceSession({ discipline: 'run', minutes: 130, targetReps: triRacePaceTargetReps(24), role: 'race_pace', ctx });
    expect(long.d).toContain('8×90s');
    const short = triRacePaceSession({ discipline: 'bike', minutes: 30, targetReps: 8, role: 'race_pace', ctx });
    expect(Number(/(\d+)×90s/.exec(short.d)![1])).toBeLessThan(8);
  });

  it('short-course rides keep 11 of the library\'s 15 x 30:30; the text adds up to the session', () => {
    expect(TRI_TAPER_MICROS_REPS).toBe(11);
    expect(triTaperMicrosNeedMin()).toBe(31);
    for (const m of [24, 31, 32, 45, 60]) {
      const w = triTaperVo2MicrosRide({ minutes: m, weekIndex: 1, totalWeeks: 12, skill: 3, slotIndex: 0 });
      const reps = Number(/Main: (\d+)×\(30s/.exec(w.d)![1]);
      const parts = [...w.d.matchAll(/(\d+)min (?:Warm up|steady|Cool down)/g)].reduce((a, x) => a + Number(x[1]), 0);
      expect(parts + reps, `${m}: ${w.d}`).toBe(m);
      if (m >= 31) expect(reps).toBe(11);
      expect(reps).toBeGreaterThanOrEqual(4); // Dave Scott's 4-min floor
    }
  });

  it('short-course threshold runs keep 3 of the library\'s 4 x 6 min; the text adds up to the session', () => {
    expect(TRI_TAPER_THRESHOLD_REPS).toBe(3);
    expect(triTaperThresholdRunNeedMin()).toBe(45);
    for (const m of [30, 35, 45, 55]) {
      const d = triTaperThresholdRunDesc(m, '4:40/km', '5:45/km');
      const reps = Number(/(\d+)×6min/.exec(d)![1]);
      const wu = Number(/^(\d+)min warm up/.exec(d)![1]);
      const cd = Number(/(\d+)min cool down/.exec(d)![1]);
      const steady = Number(/then (\d+)min/.exec(d)?.[1] ?? 0);
      // 90 s recoveries: within half a minute.
      expect(Math.abs(wu + reps * 6 + (reps - 1) * 1.5 + steady + cd - m), `${m}: ${d}`).toBeLessThanOrEqual(0.5);
      if (m >= 45) expect(reps).toBe(3);
    }
  });

  it('short-course swims keep 75% of the reference reps when the session holds them', () => {
    const css = triTaperSwimPlan('threshold', 39, 3);
    expect(css.targetReps).toBe(11); // 15 x 100 m in a 39-min reference swim
    const speed = triTaperSwimPlan('speed', 39, 3);
    expect(speed.targetReps).toBe(9); // 12 x 50 m
    const w = triTaperQualitySwim({ kind: 'threshold', minutes: Math.ceil(css.needMin), plan: css, skill: 3, weekIndex: 15, totalWeeks: 16, slotIndex: 0 });
    expect(w.d).toContain('11×100m');
  });
});

describe('race-pace sessions, openers and activations', () => {
  it('a race-pace ride targets the race intensity factor; its type follows the zone', () => {
    expect(bikeKindForIntensity(0.70)).toBe('endurance');
    expect(bikeKindForIntensity(0.78)).toBe('tempo');
    expect(bikeKindForIntensity(0.88)).toBe('sweet_spot');
    const w = triRacePaceSession({ discipline: 'bike', minutes: 40, role: 'race_pace', ctx });
    expect(w.t).toBe('bike_tempo');
    expect(w.d).toContain('(race intensity)');
    expect(w.taperRole).toBe('race_pace');
  });

  it('openers are typed by their steady content and priced at that rate', () => {
    const sc = { ...ctx, shortCourse: true, bikeIF: 0.88 };
    const run = triRacePaceSession({ discipline: 'run', minutes: 40, reps: 5, role: 'opener', ctx: sc });
    expect([run.t, run.rpe]).toEqual(['easy', 4]);
    expect({ aerobic: run.aerobic, anaerobic: run.anaerobic }).toEqual(loadForTriRun('easy', 40));
    const ride = triRacePaceSession({ discipline: 'bike', minutes: 35, reps: 4, role: 'opener', ctx: sc });
    expect(ride.t).toBe('bike_endurance');
    const swim = triRacePaceSession({ discipline: 'swim', minutes: 20, reps: 3, role: 'opener', ctx: sc });
    expect(swim.t).toBe('swim_endurance');
  });

  it('the race-week brick takes its RPE from its legs (endurance ride, easy run)', () => {
    expect(triRaceWeekBrick(ctx).rpe).toBe(4);
  });

  it('the day-before run keeps its sourced length (no 20-min floor)', () => {
    expect(triDayBeforeRun(10, '5:45/km').estimatedDurationMin).toBe(10);
    expect(triDayBeforeRun(5, '5:45/km').estimatedDurationMin).toBe(5);
  });

  it('copy has no em dashes', () => {
    const texts = [
      triRacePaceSession({ discipline: 'run', minutes: 40, role: 'opener', reps: 5, ctx }).d,
      triRacePaceSession({ discipline: 'swim', minutes: 30, role: 'opener', reps: 3, ctx }).d,
      triTaperThresholdRunDesc(50, '4:40/km', '5:45/km'),
      triTaperVo2MicrosRide({ minutes: 50, weekIndex: 1, totalWeeks: 12, skill: 3, slotIndex: 0 }).d,
      triDayBeforeRun(10, '5:45/km').d,
      ...composeTriRaceWeek(input70(SUNDAY)).map(w => `${w.n} ${w.d}`),
    ];
    for (const t of texts) expect(t.includes('—')).toBe(false);
  });
});

describe('taper intensity gate (tri-intensity-profile)', () => {
  it('long course caps taper quality at race pace', () => {
    for (const d of ['t100', '70.3', 'ironman'] as const) {
      expect(selectRunQualityKind(d, 'taper', 0, 15)).toBe('race_pace');
      expect(selectSwimQualityKind(d, 'taper', 0, 15)).toBe('race_pace');
      expect(selectBikeQualityKind(d, 'taper', 0, 15)).toBe('race_pace');
    }
  });

  it('cycling keeps sub-threshold taper quality (sweet spot or tempo, the fact-check ceiling)', () => {
    for (let w = 0; w < 6; w++) for (let slot = 0; slot < 3; slot++) {
      expect(['sweet_spot', 'tempo']).toContain(selectBikeQualityKind('70.3', 'taper', slot, w, true));
    }
  });

  it('sprint and Olympic allow short faster efforts: 30:30 rides, speed swims; runs stay at threshold', () => {
    for (const d of ['sprint', 'olympic'] as const) {
      expect(selectBikeQualityKind(d, 'taper', 0, 15)).toBe('vo2_micros');
      expect(selectRunQualityKind(d, 'taper', 0, 15)).toBe('threshold');
      const swims = new Set([0, 1, 2, 3].map(w => selectSwimQualityKind(d, 'taper', 0, w)));
      expect([...swims].every(k => k === 'speed' || k === 'threshold')).toBe(true);
    }
  });

  it('base keeps its sub-threshold gate', () => {
    expect(selectBikeQualityKind('sprint', 'base', 0, 3)).toBe('sweet_spot');
    expect(selectRunQualityKind('ironman', 'base', 0, 3)).toBe('threshold');
  });
});
