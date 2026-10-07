import { describe, it, expect } from 'vitest';
import { generateTriathlonPlan, triWeekEmphasis, triLongRunTargetMin } from './plan_engine.triathlon';
import type { Week } from '@/types/state';
import { phasesForLen } from '@/constants/triathlon-constants';
import type { SimulatorState } from '@/types/state';

function makeTriState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    schemaVersion: 3,
    eventType: 'triathlon',
    w: 1,
    tw: 20,
    v: 0,
    iv: 0,
    rpeAdj: 0,
    expectedFinal: 0,
    rd: 'marathon',
    epw: 9,
    rw: 3,
    gs: 0,
    wkm: 0,
    pbs: {},
    rec: null,
    lt: null,
    vo2: null,
    initialLT: null,
    initialVO2: null,
    initialBaseline: null,
    currentFitness: null,
    forecastTime: null,
    typ: 'Balanced',
    b: 1.1,
    wks: [],
    pac: { e: 300, t: 240, i: 220, m: 270, r: 180 },
    skip: [],
    timp: 0,
    triConfig: {
      distance: '70.3',
      timeAvailableHoursPerWeek: 10,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: false },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 20,
    },
    ...overrides,
  } as SimulatorState;
}

describe('Triathlon plan engine — generation shape', () => {
  it('produces the right number of weeks for 70.3', () => {
    const weeks = generateTriathlonPlan(makeTriState({ tw: 20 }));
    expect(weeks).toHaveLength(20);
  });

  it('produces the right number of weeks for Ironman', () => {
    const weeks = generateTriathlonPlan(makeTriState({
      tw: 24,
      triConfig: {
        distance: 'ironman',
        timeAvailableHoursPerWeek: 14,
        volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
        skillRating: { swim: 3, bike: 3, run: 3 },
      },
    }));
    expect(weeks).toHaveLength(24);
  });

  it('every week has at least one workout in a typical 10h/week plan', () => {
    const weeks = generateTriathlonPlan(makeTriState());
    for (const wk of weeks) {
      expect(wk.triWorkouts).toBeDefined();
      expect((wk.triWorkouts ?? []).length).toBeGreaterThan(0);
    }
  });

  it('returns [] when triConfig is missing', () => {
    const s = makeTriState();
    delete s.triConfig;
    expect(generateTriathlonPlan(s)).toEqual([]);
  });

  it('weeks have phase assignments following base → build → peak → taper', () => {
    const weeks = generateTriathlonPlan(makeTriState({ tw: 20 }));
    const phases = weeks.map((w) => w.ph);
    // Base weeks at the start
    expect(phases[0]).toBe('base');
    // Taper weeks at the end
    expect(phases[phases.length - 1]).toBe('taper');
    // Expect a reasonable mix of all four
    const unique = new Set(phases);
    expect(unique.size).toBeGreaterThanOrEqual(3);
  });

  it('workouts have dayOfWeek 0-6 set by the scheduler', () => {
    const weeks = generateTriathlonPlan(makeTriState());
    for (const wk of weeks) {
      for (const w of wk.triWorkouts ?? []) {
        expect(w.dayOfWeek).toBeGreaterThanOrEqual(0);
        expect(w.dayOfWeek).toBeLessThanOrEqual(6);
      }
    }
  });

  it('brick workouts appear only in build and peak phases', () => {
    const weeks = generateTriathlonPlan(makeTriState());
    for (const wk of weeks) {
      const hasBrick = (wk.triWorkouts ?? []).some((w) => w.t === 'brick');
      if (hasBrick) {
        expect(['build', 'peak']).toContain(wk.ph);
      }
    }
  });

  it('30-week Ironman plan engages double periodization with a checkpoint week', () => {
    const weeks = generateTriathlonPlan(makeTriState({
      tw: 30,
      triConfig: {
        distance: 'ironman',
        timeAvailableHoursPerWeek: 14,
        volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
        skillRating: { swim: 3, bike: 3, run: 3 },
      },
    }));
    expect(weeks).toHaveLength(30);

    // Exactly one checkpoint week, sitting on a peak phase, in the first half
    const checkpointWeeks = weeks.filter((w) => (w as any).checkpoint);
    expect(checkpointWeeks).toHaveLength(1);
    expect(checkpointWeeks[0].ph).toBe('peak');
    const checkpointIdx = weeks.findIndex((w) => (w as any).checkpoint);
    expect(checkpointIdx).toBeLessThan(weeks.length / 2);

    // Two taper segments. Inter-cycle (after checkpoint) and race taper (end)
    const seq: string[] = [];
    for (const w of weeks) {
      if (seq[seq.length - 1] !== w.ph) seq.push(w.ph);
    }
    expect(seq).toEqual(['base', 'build', 'peak', 'taper', 'base', 'build', 'peak', 'taper']);

    // Race-end taper still ends the plan
    expect(weeks[weeks.length - 1].ph).toBe('taper');

    // Every week still has workouts (the inter-cycle taper doesn't go empty)
    for (const wk of weeks) {
      expect((wk.triWorkouts ?? []).length).toBeGreaterThan(0);
    }
  });

  it('20-week 70.3 plan stays single arc — no checkpoint flag', () => {
    const weeks = generateTriathlonPlan(makeTriState({ tw: 20 }));
    expect(weeks.some((w) => (w as any).checkpoint)).toBe(false);
  });

  it('disciplines span swim, bike, and run when weekly hours are sufficient', () => {
    const weeks = generateTriathlonPlan(makeTriState({
      tw: 20,
      triConfig: {
        distance: '70.3',
        timeAvailableHoursPerWeek: 12,
        volumeSplit: { swim: 0.2, bike: 0.45, run: 0.35 },
        skillRating: { swim: 3, bike: 3, run: 3 },
      },
    }));
    const disciplines = new Set<string>();
    for (const wk of weeks) {
      for (const w of wk.triWorkouts ?? []) disciplines.add(w.discipline ?? 'run');
    }
    expect(disciplines.has('swim')).toBe(true);
    expect(disciplines.has('bike')).toBe(true);
    expect(disciplines.has('run')).toBe(true);
  });
});

describe('Triathlon plan engine — weekly hours cap is honoured', () => {
  // Mirrors scheduler.triathlon.ts:workoutMinutes (not exported). Every prescribed
  // session — solo S/B/R, brick, gym, commute — must sum to at most the cap.
  function workoutMinutes(w: any): number {
    if (w.estimatedDurationMin && w.estimatedDurationMin > 0) return w.estimatedDurationMin;
    if (w.brickSegments) {
      return (w.brickSegments[0]?.durationMin ?? 0) + (w.brickSegments[1]?.durationMin ?? 0);
    }
    const matches = Array.from(String(w.d || '').matchAll(/(\d+)\s*min/g));
    if (matches.length > 0) {
      return matches.reduce((acc, m) => Math.max(acc, parseInt((m as RegExpMatchArray)[1], 10)), 0);
    }
    return 60;
  }
  function weekMinutes(wk: any): number {
    return (wk.triWorkouts ?? []).reduce((sum: number, w: any) => sum + workoutMinutes(w), 0);
  }

  it('a 10h/week plan with commutes + gym never exceeds 10h in any week', () => {
    const weeks = generateTriathlonPlan(makeTriState({
      gs: 2,
      commuteConfig: { enabled: true, commuteDaysPerWeek: 3, distanceKm: 4, isBidirectional: true } as any,
    }));
    for (const wk of weeks) {
      // Allow a small per-session rounding tolerance (Math.round on each session).
      expect(weekMinutes(wk)).toBeLessThanOrEqual(600 + 30);
    }
  });

  it('the peak week fills close to the budget (cap is binding, not slack)', () => {
    const weeks = generateTriathlonPlan(makeTriState({ gs: 2 }));
    // The heaviest peak week (deload peak weeks run lighter) should use most of the
    // 10h budget — at least 8h of prescribed work — without exceeding it.
    const peakMinutes = weeks
      .filter((w) => w.ph === 'peak')
      .map((w) => weekMinutes(w));
    expect(peakMinutes.length).toBeGreaterThan(0);
    const heaviest = Math.max(...peakMinutes);
    expect(heaviest).toBeGreaterThanOrEqual(8 * 60);
    expect(heaviest).toBeLessThanOrEqual(600 + 30);
  });

  it('commute slots carry a real duration derived from distance, not a flat 60min', () => {
    const weeks = generateTriathlonPlan(makeTriState({
      commuteConfig: { enabled: true, commuteDaysPerWeek: 2, distanceKm: 4, isBidirectional: true } as any,
    }));
    const commute = weeks
      .flatMap((w) => w.triWorkouts ?? [])
      .find((w) => (w as any).commute);
    expect(commute).toBeDefined();
    // 4km easy ≈ 20–28min depending on pace fallback — never the 60min default.
    expect((commute as any).estimatedDurationMin).toBeGreaterThan(0);
    expect((commute as any).estimatedDurationMin).toBeLessThan(45);
  });
});

describe('phasesForLen — short-plan compression', () => {
  it('returns canonical PHASE_WEEKS at default length (Ironman 24w)', () => {
    expect(phasesForLen('ironman', 24)).toEqual({ base: 10, build: 7, peak: 5, taper: 2 });
  });

  it('returns canonical PHASE_WEEKS at default length (70.3 20w)', () => {
    expect(phasesForLen('70.3', 20)).toEqual({ base: 8, build: 6, peak: 4, taper: 2 });
  });

  it('compresses Ironman plans proportionally with peak floored at 1', () => {
    expect(phasesForLen('ironman', 12)).toEqual({ base: 5, build: 3, peak: 2, taper: 2 });
    expect(phasesForLen('ironman', 8)).toEqual({ base: 3, build: 2, peak: 2, taper: 1 });
    expect(phasesForLen('ironman', 6)).toEqual({ base: 2, build: 2, peak: 1, taper: 1 });
    expect(phasesForLen('ironman', 4)).toEqual({ base: 1, build: 1, peak: 1, taper: 1 });
    expect(phasesForLen('ironman', 2)).toEqual({ base: 0, build: 0, peak: 1, taper: 1 });
  });

  it('drops everything but taper at 1 week', () => {
    expect(phasesForLen('ironman', 1)).toEqual({ base: 0, build: 0, peak: 0, taper: 1 });
    expect(phasesForLen('70.3', 1)).toEqual({ base: 0, build: 0, peak: 0, taper: 1 });
  });

  it('always preserves total weeks', () => {
    for (const dist of ['ironman', '70.3'] as const) {
      for (let n = 1; n <= 30; n++) {
        const p = phasesForLen(dist, n);
        expect(p.base + p.build + p.peak + p.taper).toBe(n);
      }
    }
  });

  it('never returns a peak of 0 when at least one non-taper week is available', () => {
    for (const dist of ['ironman', '70.3'] as const) {
      for (let n = 2; n <= 30; n++) {
        const p = phasesForLen(dist, n);
        expect(p.peak).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('caps taper at 2 weeks even on long plans', () => {
    expect(phasesForLen('ironman', 30).taper).toBe(2);
    expect(phasesForLen('70.3', 30).taper).toBe(2);
  });
});

describe('Ironman long-run build + key-session alternation (SCIENCE_LOG §CD)', () => {
  const imState = () => makeTriState({
    tw: 24,
    triConfig: {
      distance: 'ironman',
      timeAvailableHoursPerWeek: 14,
      volumeSplit: { swim: 0.15, bike: 0.50, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
    },
  });

  const longRunMin = (wk: Week): number => {
    const lr = (wk.triWorkouts ?? []).find((w) => w.discipline === 'run' && w.t === 'long');
    return lr?.estimatedDurationMin ?? 0;
  };
  // The long ride. On build/peak weeks it is the brick's bike segment (the brick
  // IS the long ride + transition run, §CD); off brick weeks it is the longest
  // standalone bike session. Take whichever is larger.
  const longRideMin = (wk: Week): number => {
    const wos = wk.triWorkouts ?? [];
    const brickBike = wos
      .filter((w) => w.t === 'brick')
      .map((w) => (w as any).brickSegments?.[0]?.durationMin ?? 0);
    const soloBike = wos
      .filter((w) => w.discipline === 'bike' && w.t !== 'brick')
      .map((w) => w.estimatedDurationMin ?? 0);
    return Math.max(0, ...brickBike, ...soloBike);
  };

  it('builds the IM long run toward the 2:30 ceiling on a peak run-emphasis week', () => {
    const weeks = generateTriathlonPlan(imState());
    const runWeeks = weeks
      .map((w, i) => ({ w, idx: i + 1 }))
      .filter(({ w, idx }) => (w.ph === 'build' || w.ph === 'peak') && idx % 2 === 1);
    const last = runWeeks[runWeeks.length - 1];
    // Approaches 150 min (2:30) — well past the old ~20 km (~113 min) share cap.
    expect(longRunMin(last.w)).toBeGreaterThanOrEqual(140);
    expect(longRunMin(last.w)).toBeLessThanOrEqual(155);
  });

  it('alternates: the peak long run lands on run weeks, the peak long ride on bike weeks', () => {
    const weeks = generateTriathlonPlan(imState());
    // Compare the MAX of each emphasis group so periodic deload weeks (×0.7)
    // fall out of the comparison — a deloaded "full" session would otherwise be
    // smaller than a non-deloaded maintenance one.
    const active = weeks
      .map((w, i) => ({ w, idx: i + 1 }))
      .filter(({ w }) => w.ph === 'build' || w.ph === 'peak');
    const runWeeks = active.filter(({ idx }) => idx % 2 === 1).map(({ w }) => w);
    const bikeWeeks = active.filter(({ idx }) => idx % 2 === 0).map(({ w }) => w);
    const max = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), 0);
    // Longest long run comes from a run-emphasis week; longest ride from a bike week.
    expect(max(runWeeks.map(longRunMin))).toBeGreaterThan(max(bikeWeeks.map(longRunMin)));
    expect(max(bikeWeeks.map(longRideMin))).toBeGreaterThan(max(runWeeks.map(longRideMin)));
  });

  it('non-Ironman distances keep the share model (no alternation, no target)', () => {
    expect(triWeekEmphasis('70.3', 'peak', 5)).toBeNull();
    expect(triLongRunTargetMin('70.3', 5, 20, 'peak')).toBeNull();
  });

  it('triWeekEmphasis alternates only across IM build/peak weeks', () => {
    expect(triWeekEmphasis('ironman', 'build', 5)).toBe('run');
    expect(triWeekEmphasis('ironman', 'build', 6)).toBe('bike');
    expect(triWeekEmphasis('ironman', 'base', 5)).toBeNull();
    expect(triWeekEmphasis('ironman', 'taper', 5)).toBeNull();
  });

  it('triLongRunTargetMin ramps to and caps at the 150-min ceiling', () => {
    expect(triLongRunTargetMin('ironman', 1, 24, 'base')).toBeLessThan(120);
    expect(triLongRunTargetMin('ironman', 18, 24, 'peak')).toBe(150);
    expect(triLongRunTargetMin('ironman', 24, 24, 'peak')).toBe(150);
  });

  it('the long-run build never pushes any IM week over its weekly hours cap', () => {
    // The funding reallocates minutes (bike long ride -> long run); it must never
    // add net time. Check every week of a 14h IM plan stays within the cap.
    const sumMin = (wk: Week): number =>
      (wk.triWorkouts ?? []).reduce((s, w) => {
        if (w.estimatedDurationMin && w.estimatedDurationMin > 0) return s + w.estimatedDurationMin;
        if ((w as any).brickSegments) {
          return s + ((w as any).brickSegments[0]?.durationMin ?? 0) + ((w as any).brickSegments[1]?.durationMin ?? 0);
        }
        return s + 60;
      }, 0);
    for (const hours of [10, 12, 14, 18]) {
      const weeks = generateTriathlonPlan(makeTriState({
        tw: 24,
        triConfig: {
          distance: 'ironman',
          timeAvailableHoursPerWeek: hours,
          volumeSplit: { swim: 0.15, bike: 0.50, run: 0.35 },
          skillRating: { swim: 3, bike: 3, run: 3 },
        },
      }));
      for (const wk of weeks) {
        // Per-session Math.round tolerance, matching the existing cap test.
        expect(sumMin(wk)).toBeLessThanOrEqual(hours * 60 + 30);
      }
    }
  });
});

describe('Triathlon race week (mirrors running isRaceWeek, 2026-10-06)', () => {
  // Before: every tri race week carried a "Long run" that the scheduler put on
  // Sunday, race day for a Sunday race. The race takes the long-run slot, and
  // nothing else is scheduled on Sunday in race week.
  const cases: Array<{ distance: '70.3' | 'ironman' | 'olympic' | 'sprint'; tw: number; hours: number }> = [
    { distance: 'sprint', tw: 12, hours: 6 },
    { distance: 'olympic', tw: 16, hours: 8 },
    { distance: '70.3', tw: 20, hours: 10 },
    { distance: '70.3', tw: 20, hours: 6 },
    { distance: 'ironman', tw: 24, hours: 14 },
  ];

  for (const c of cases) {
    it(`${c.distance} ${c.tw}wk ${c.hours}h: race week has no long run and leaves Sunday free`, () => {
      const weeks = generateTriathlonPlan(makeTriState({
        tw: c.tw,
        triConfig: {
          distance: c.distance,
          timeAvailableHoursPerWeek: c.hours,
          volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
          skillRating: { swim: 3, bike: 3, run: 3 },
          bike: { hasPowerMeter: false },
          swim: { cssSecPer100m: 100 },
          weeksToRace: c.tw,
        },
      }));
      const raceWeek = weeks[c.tw - 1].triWorkouts ?? [];
      expect(raceWeek.filter(w => w.t === 'long')).toHaveLength(0);
      expect(raceWeek.filter(w => w.dayOfWeek === 6).map(w => w.n)).toEqual([]);
      // The week before race week still has its long run on Sunday.
      const prior = weeks[c.tw - 2].triWorkouts ?? [];
      const priorLong = prior.filter(w => w.t === 'long');
      if (priorLong.length > 0) expect(priorLong[0].dayOfWeek).toBe(6);
    });
  }

  it('commute runs do not displace the long run from Sunday', () => {
    // Before: the scheduler took the LAST run in the array as the long run, and
    // commute runs are appended after the generated runs, so a commute landed on
    // Sunday and the long run on a weekday.
    const weeks = generateTriathlonPlan(makeTriState({
      tw: 20,
      commuteConfig: { enabled: true, commuteDaysPerWeek: 2, isBidirectional: false, distanceKm: 5 } as any,
    }));
    let longWeeks = 0;
    for (const wk of weeks.slice(0, 19)) {
      const long = (wk.triWorkouts ?? []).find(w => w.t === 'long');
      if (!long) continue;
      longWeeks++;
      expect(long.dayOfWeek, `wk${wk.w}`).toBe(6);
    }
    expect(longWeeks).toBeGreaterThan(10);
  });

  for (const tw of [1, 2]) {
    it(`a ${tw}-week plan (race date ${tw} week${tw > 1 ? 's' : ''} out): the final week has no long run and leaves Sunday free`, () => {
      // The tri wizard builds max(1, weeksUntil(raceDate)) weeks, so a race 1 or 2
      // weeks out is reachable. computeSingleArc used to label those plans [build]
      // and [build, peak] (no taper week, so a phase-gated race-week test missed
      // them); since the taper-first split they end in a taper week.
      const weeks = generateTriathlonPlan(makeTriState({
        tw,
        triConfig: {
          distance: '70.3',
          timeAvailableHoursPerWeek: 10,
          volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
          skillRating: { swim: 3, bike: 3, run: 3 },
          bike: { hasPowerMeter: false },
          swim: { cssSecPer100m: 100 },
          weeksToRace: tw,
        },
      }));
      expect(weeks).toHaveLength(tw);
      expect(weeks.map(w => w.ph)).toEqual(tw === 1 ? ['taper'] : ['peak', 'taper']);
      const raceWeek = weeks[tw - 1].triWorkouts ?? [];
      expect(raceWeek.filter(w => w.t === 'long')).toHaveLength(0);
      expect(raceWeek.filter(w => w.dayOfWeek === 6).map(w => w.n)).toEqual([]);
    });
  }
});
