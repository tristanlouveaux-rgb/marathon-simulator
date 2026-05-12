import { describe, it, expect } from 'vitest';
import { generateTriathlonPlan } from './plan_engine.triathlon';
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

    // Two taper segments — inter-cycle (after checkpoint) and race taper (end)
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
