/**
 * tri-taper.ts unit tests: the race-week composer on synthetic reference
 * weeks, the race-pace builders and the taper intensity gate
 * (tri-intensity-profile). SCIENCE_LOG "Triathlon and cycling taper rebuild".
 */
import { describe, it, expect } from 'vitest';
import type { Workout } from '@/types/state';
import {
  composeTriRaceWeek,
  triRacePaceSession,
  triTaperThresholdRunDesc,
  triTaperVo2MicrosRide,
  triDayBeforeRun,
  bikeKindForIntensity,
  TRI_DAY_BEFORE_RIDE_MAX_MIN,
  TRI_TAPER_SESSION_FLOOR_MIN,
  type TriRaceWeekInput,
  type TriTaperSessionCtx,
} from './tri-taper';
import { selectBikeQualityKind, selectRunQualityKind, selectSwimQualityKind } from './tri-intensity-profile';

const ctx: TriTaperSessionCtx = {
  shortCourse: false, bikeIF: 0.78, ftp: 250, hasPowerMeter: true, cssSecPer100m: 100, swimSkill: 3, easyLabel: '5:45/km',
};

const aerobic = (d: 'swim' | 'bike' | 'run', minutes: number): Workout => ({
  n: `${d} aerobic`, t: d === 'swim' ? 'swim_endurance' : d === 'bike' ? 'bike_endurance' : 'easy',
  d: '', r: 4, discipline: d, estimatedDurationMin: minutes,
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
    dayBeforeRide: m => ({ n: 'Pre-race spin', t: 'bike_endurance', d: '', r: 3, discipline: 'bike', estimatedDurationMin: m, taperRole: 'day_before' }),
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

describe('composeTriRaceWeek', () => {
  it('70.3, Sunday race: openers hold as many 90 s repeats as days to go; Byrn brick 3 days out; Friday empty; capped Saturday', () => {
    const out = composeTriRaceWeek(input70(SUNDAY));
    const day = (dow: number) => out.filter(w => w.dayOfWeek === dow);
    expect(day(4)).toEqual([]); // two days out: rest
    expect(day(5).every(w => w.taperRole === 'day_before')).toBe(true);
    expect(day(5).find(w => w.discipline === 'bike')!.estimatedDurationMin).toBeLessThanOrEqual(TRI_DAY_BEFORE_RIDE_MAX_MIN);
    expect(day(5).find(w => w.discipline === 'run')!.estimatedDurationMin).toBe(10);
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
  });

  it('Wednesday race: no day-before or rest day in race week, openers 5 to 3 days out, aerobic sessions first', () => {
    const out = composeTriRaceWeek(input70(WEDNESDAY));
    expect(out.some(w => w.taperRole === 'day_before')).toBe(false);
    const openers = out.filter(w => w.taperRole === 'opener');
    expect(openers.every(w => WEDNESDAY[w.dayOfWeek!]! >= 3 && WEDNESDAY[w.dayOfWeek!]! <= 5)).toBe(true);
    const firstAerobic = Math.min(...out.filter(w => !w.taperRole).map(w => w.dayOfWeek!));
    expect(firstAerobic).toBe(0);
  });

  it('Thursday race: Monday is the only training day; every discipline still has a session', () => {
    const out = composeTriRaceWeek(input70(THURSDAY));
    for (const w of out) expect([0, 2]).toContain(w.dayOfWeek);
    for (const d of ['swim', 'bike', 'run']) {
      expect(out.some(w => w.discipline === d || (d === 'run' && w.t === 'brick'))).toBe(true);
    }
  });

  it('short course: no brick; openers run, bike, swim; one-week fraction 0.55', () => {
    const out = composeTriRaceWeek(input70(SUNDAY, {
      longCourse: false, fraction: 0.55, ctx: { ...ctx, shortCourse: true, bikeIF: 0.88 },
      ref: { minutes: { swim: 59, bike: 160, run: 144 }, counts: { swim: 1, bike: 2, run: 2 }, total: 5 },
    }));
    expect(out.some(w => w.t === 'brick')).toBe(false);
    const order = out.filter(w => w.taperRole === 'opener').sort((a, b) => a.dayOfWeek! - b.dayOfWeek!).map(w => w.discipline);
    expect(order).toEqual(['run', 'bike', 'swim']);
    expect(out.find(w => w.taperRole === 'opener' && w.discipline === 'bike')!.t).toBe('bike_sweet_spot');
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

describe('race-pace and taper-sized sessions', () => {
  it('a shorter taper session holds fewer repeats', () => {
    const a = triRacePaceSession({ discipline: 'bike', minutes: 60, role: 'race_pace', ctx });
    const b = triRacePaceSession({ discipline: 'bike', minutes: 30, role: 'race_pace', ctx });
    const reps = (w: Workout) => Number(/(\d+)×90s/.exec(w.d)![1]);
    expect(reps(a)).toBeGreaterThan(reps(b));
    expect(triTaperThresholdRunDesc(55, '4:40/km', '5:45/km')).toContain('3×8min');
    expect(triTaperThresholdRunDesc(35, '4:40/km', '5:45/km')).toContain('1×8min');
    const micros = (m: number) => Number(/Main: (\d+)×\(30s/.exec(triTaperVo2MicrosRide({ minutes: m, weekIndex: 1, totalWeeks: 12, skill: 3, slotIndex: 0 }).d)![1]);
    expect(micros(50)).toBeGreaterThan(micros(35));
  });

  it('a race-pace ride targets the race intensity factor; its type follows the zone', () => {
    expect(bikeKindForIntensity(0.70)).toBe('endurance');
    expect(bikeKindForIntensity(0.78)).toBe('tempo');
    expect(bikeKindForIntensity(0.88)).toBe('sweet_spot');
    const w = triRacePaceSession({ discipline: 'bike', minutes: 40, role: 'race_pace', ctx });
    expect(w.t).toBe('bike_tempo');
    expect(w.d).toContain('(race intensity)');
    expect(w.taperRole).toBe('race_pace');
  });

  it('the day-before run keeps its sourced length (no 20-min floor)', () => {
    expect(triDayBeforeRun(10, '5:45/km').estimatedDurationMin).toBe(10);
  });

  it('copy has no em dashes', () => {
    const texts = [
      triRacePaceSession({ discipline: 'run', minutes: 40, role: 'opener', reps: 5, ctx }).d,
      triRacePaceSession({ discipline: 'swim', minutes: 30, role: 'opener', reps: 3, ctx }).d,
      triDayBeforeRun(10, '5:45/km').d,
      ...composeTriRaceWeek(input70(SUNDAY)).map(w => `${w.n} ${w.d}`),
    ];
    for (const t of texts) expect(t.includes('—')).toBe(false);
  });
});

describe('taper intensity gate (tri-intensity-profile)', () => {
  it('long course and cycling cap taper quality at race pace', () => {
    for (const d of ['t100', '70.3', 'ironman'] as const) {
      expect(selectRunQualityKind(d, 'taper', 0, 15)).toBe('race_pace');
      expect(selectSwimQualityKind(d, 'taper', 0, 15)).toBe('race_pace');
      expect(selectBikeQualityKind(d, 'taper', 0, 15)).toBe('race_pace');
    }
    expect(selectBikeQualityKind('70.3', 'taper', 0, 15, true)).toBe('race_pace');
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
