import { describe, it, expect } from 'vitest';
import { generateTriathlonPlan } from './plan_engine.triathlon';
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
