import { describe, it, expect } from 'vitest';
import {
  computeBumpedVolume,
  baseTriSessions,
  maxAddTriSessions,
  applyTriSessionDelta,
  forecastTriWithDelta,
  goalChanceTriWithDelta,
  triDeltaKey,
  ZERO_TRI_DELTA,
} from './tri-session-lever';
import { generateTriathlonPlan, TRI_AVG_SESSION_HOURS, TRI_MAX_SESSIONS_PER_DISCIPLINE } from '@/workouts/plan_engine.triathlon';
import type { SimulatorState } from '@/types/state';
import type { TriConfig } from '@/types/triathlon';

function makeTriConfig(overrides: Partial<TriConfig> = {}): TriConfig {
  return {
    distance: '70.3',
    timeAvailableHoursPerWeek: 10,
    volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
    skillRating: { swim: 3, bike: 3, run: 3 },
    bike: { hasPowerMeter: true, ftp: 220 },
    swim: { cssSecPer100m: 100 },
    weeksToRace: 20,
    ...overrides,
  } as TriConfig;
}

/** A full tri state with a generated plan so the predictor has planned volume. */
function makeTriState(triOverrides: Partial<TriConfig> = {}): SimulatorState {
  const s = {
    schemaVersion: 3,
    eventType: 'triathlon',
    w: 1,
    tw: 20,
    v: 50,
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
    triConfig: makeTriConfig(triOverrides),
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  return s;
}

describe('triDeltaKey', () => {
  it('is stable and distinct per delta', () => {
    expect(triDeltaKey({ swim: 0, bike: 1, run: 0 })).toBe('0-1-0');
    expect(triDeltaKey(ZERO_TRI_DELTA)).toBe('0-0-0');
  });
});

describe('baseTriSessions', () => {
  it('matches countSessions on the default 10h / 70.3 split', () => {
    const tri = makeTriConfig();
    const base = baseTriSessions(tri);
    // 10h * 0.175 = 1.75h swim / 0.75 ≈ 2; 4.75h bike / 1.3 ≈ 4 -> capped at 3;
    // 3.5h run / 0.9 ≈ 4 -> capped at 3.
    expect(base.swim).toBe(2);
    expect(base.bike).toBe(TRI_MAX_SESSIONS_PER_DISCIPLINE);
    expect(base.run).toBe(TRI_MAX_SESSIONS_PER_DISCIPLINE);
  });
});

describe('maxAddTriSessions', () => {
  it('is cap minus base, never negative', () => {
    const tri = makeTriConfig();
    const max = maxAddTriSessions(tri);
    expect(max.swim).toBe(TRI_MAX_SESSIONS_PER_DISCIPLINE - 2); // 1
    expect(max.bike).toBe(0); // already at cap
    expect(max.run).toBe(0);
  });
});

describe('computeBumpedVolume', () => {
  it('adds ~one swim session worth of time and tilts the split toward swim', () => {
    const tri = makeTriConfig();
    const before = computeBumpedVolume(tri, ZERO_TRI_DELTA);
    const after = computeBumpedVolume(tri, { swim: 1, bike: 0, run: 0 });
    // Total grows by one swim session (target 3 * 0.75 = 2.25h vs base ~1.75h).
    expect(after.timeAvailableHoursPerWeek).toBeGreaterThan(before.timeAvailableHoursPerWeek);
    expect(after.volumeSplit.swim).toBeGreaterThan(before.volumeSplit.swim);
    // Split fractions still sum to 1.
    const sum = after.volumeSplit.swim + after.volumeSplit.bike + after.volumeSplit.run;
    expect(sum).toBeCloseTo(1, 6);
  });

  it('keeps other disciplines absolute hours unchanged', () => {
    const tri = makeTriConfig();
    const H0 = tri.timeAvailableHoursPerWeek!;
    const split0 = tri.volumeSplit!;
    const after = computeBumpedVolume(tri, { swim: 1, bike: 0, run: 0 });
    const bikeHoursAfter = after.timeAvailableHoursPerWeek * after.volumeSplit.bike;
    const runHoursAfter = after.timeAvailableHoursPerWeek * after.volumeSplit.run;
    expect(bikeHoursAfter).toBeCloseTo(H0 * split0.bike, 5);
    expect(runHoursAfter).toBeCloseTo(H0 * split0.run, 5);
  });

  it('respects the per-discipline cap (no growth past cap)', () => {
    const tri = makeTriConfig();
    // Bike is already at cap (3); asking for +5 must not change bike hours.
    const after = computeBumpedVolume(tri, { swim: 0, bike: 5, run: 0 });
    const base = computeBumpedVolume(tri, ZERO_TRI_DELTA);
    const bikeHoursAfter = after.timeAvailableHoursPerWeek * after.volumeSplit.bike;
    const bikeHoursBase = base.timeAvailableHoursPerWeek * base.volumeSplit.bike;
    expect(bikeHoursAfter).toBeCloseTo(bikeHoursBase, 5);
  });

  it('a swim bump targets exactly cap sessions worth of hours', () => {
    const tri = makeTriConfig();
    const after = computeBumpedVolume(tri, { swim: 1, bike: 0, run: 0 });
    const swimHoursAfter = after.timeAvailableHoursPerWeek * after.volumeSplit.swim;
    // base swim sessions = 2, +1 -> 3 (cap); 3 * 0.75 = 2.25h.
    expect(swimHoursAfter).toBeCloseTo(TRI_MAX_SESSIONS_PER_DISCIPLINE * TRI_AVG_SESSION_HOURS.swim, 5);
  });
});

describe('applyTriSessionDelta', () => {
  it('does not mutate the input state', () => {
    const s = makeTriState();
    const origSplit = { ...s.triConfig!.volumeSplit! };
    const origHours = s.triConfig!.timeAvailableHoursPerWeek;
    const origWks = s.wks;
    applyTriSessionDelta(s, { swim: 1, bike: 0, run: 0 });
    expect(s.triConfig!.volumeSplit).toEqual(origSplit);
    expect(s.triConfig!.timeAvailableHoursPerWeek).toBe(origHours);
    expect(s.wks).toBe(origWks); // same reference, untouched
  });

  it('preserves historical activity by week index', () => {
    const s = makeTriState();
    const actuals = { 'strava-1': { garminId: 'strava-1' } } as any;
    s.wks![0].garminActuals = actuals;
    const clone = applyTriSessionDelta(s, { swim: 1, bike: 0, run: 0 });
    expect(clone.wks![0].garminActuals).toBe(actuals);
  });
});

describe('forecastTriWithDelta', () => {
  it('returns a positive finish time for the base plan', () => {
    const s = makeTriState();
    const base = forecastTriWithDelta(s, ZERO_TRI_DELTA);
    expect(base).not.toBeNull();
    expect(base!).toBeGreaterThan(0);
  });

  it('adding a swim session does not slow the forecast (faster or equal)', () => {
    // Swim has headroom (base 2, cap 3); bike/run are saturated, so swim is the
    // discipline with room to move the projection.
    const s = makeTriState();
    const base = forecastTriWithDelta(s, ZERO_TRI_DELTA)!;
    const more = forecastTriWithDelta(s, { swim: 1, bike: 0, run: 0 })!;
    expect(more).toBeLessThanOrEqual(base + 1); // never slower (allow 1s rounding)
  });
});

describe('goalChanceTriWithDelta', () => {
  it('returns a percentage in [0,100]', () => {
    const s = makeTriState();
    const base = forecastTriWithDelta(s, ZERO_TRI_DELTA)!;
    const pct = goalChanceTriWithDelta(s, ZERO_TRI_DELTA, base);
    expect(pct).not.toBeNull();
    expect(pct!).toBeGreaterThanOrEqual(0);
    expect(pct!).toBeLessThanOrEqual(100);
  });

  it('adding a swim session does not lower the chance of a fixed goal', () => {
    const s = makeTriState();
    const goal = forecastTriWithDelta(s, ZERO_TRI_DELTA)!; // ~50% target
    const baseChance = goalChanceTriWithDelta(s, ZERO_TRI_DELTA, goal)!;
    const moreChance = goalChanceTriWithDelta(s, { swim: 1, bike: 0, run: 0 }, goal)!;
    expect(moreChance).toBeGreaterThanOrEqual(baseChance - 1); // monotonic up (allow 1pt noise)
  });
});
