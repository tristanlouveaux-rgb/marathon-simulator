import { describe, it, expect } from 'vitest';
import {
  computePlanAdherence,
  ADHERENCE_THRESHOLD,
  detectChronicLowAdherence,
  suggestedRunsPerWeek,
  CHRONIC_ADHERENCE_WINDOW_WEEKS,
  CHRONIC_ADHERENCE_THRESHOLD_PCT,
} from './plan-adherence';
import type { PlanAdherenceResult } from './plan-adherence';
import type { SimulatorState, Week, GarminActual } from '@/types';

/** Minimal state factory — only fields needed for adherence calc */
function makeState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    w: 3,
    tw: 12,
    v: 45,
    iv: 45,
    rpeAdj: 0,
    expectedFinal: 48,
    rd: 'marathon' as any,
    epw: 5,
    rw: 4,
    wkm: 50,
    pbs: {} as any,
    rec: null,
    lt: null,
    vo2: null,
    initialLT: null,
    initialVO2: null,
    initialBaseline: null,
    currentFitness: null,
    forecastTime: null,
    typ: 'balanced' as any,
    b: 1.06,
    wks: [],
    pac: { e: 330 } as any,
    skip: [],
    timp: 0,
    ...overrides,
  } as SimulatorState;
}

function makeWeek(w: number, overrides: Partial<Week> = {}): Week {
  return {
    w,
    ph: 'build' as any,
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
    ...overrides,
  } as Week;
}

function makeRunActual(distanceKm: number, plannedKm?: number): GarminActual {
  return {
    garminId: `strava-${Math.random().toString(36).slice(2)}`,
    distanceKm,
    durationSec: distanceKm * 330,
    avgPaceSecKm: 330,
    avgHR: 145,
    maxHR: 170,
    calories: distanceKm * 70,
    activityType: 'RUNNING',
    plannedDistanceKm: plannedKm ?? distanceKm,
  };
}

describe('computePlanAdherence', () => {

  it('returns null when current week < 2', () => {
    const s = makeState({ w: 1, wks: [makeWeek(1)] });
    expect(computePlanAdherence(s).pct).toBeNull();
  });

  it('returns 0% when no runs were completed in past weeks', () => {
    // rw=4, week 1 has no garminActuals → 0 completed / 4 planned = 0%
    const s = makeState({ w: 2, wks: [makeWeek(1), makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.pct).toBe(0);
    expect(result.totalPlanned).toBe(4);
    expect(result.totalCompleted).toBe(0);
  });

  it('counts runs that meet 95% distance threshold', () => {
    const wk1 = makeWeek(1, {
      garminActuals: {
        'slot-a': makeRunActual(10, 10),   // 100% → completed
        'slot-b': makeRunActual(9.6, 10),  // 96% → completed
        'slot-c': makeRunActual(9.4, 10),  // 94% → NOT completed
      },
    });
    const s = makeState({ rw: 4, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(2);
    expect(result.totalPlanned).toBe(4);
    expect(result.pct).toBe(50);
  });

  it('caps completed at planned per week', () => {
    // More garminActuals than rw. Should not exceed rw
    const wk1 = makeWeek(1, {
      garminActuals: {
        'a': makeRunActual(10, 10),
        'b': makeRunActual(10, 10),
        'c': makeRunActual(10, 10),
        'd': makeRunActual(10, 10),
        'e': makeRunActual(10, 10),
      },
    });
    const s = makeState({ rw: 3, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(3); // capped at rw
    expect(result.totalPlanned).toBe(3);
    expect(result.pct).toBe(100);
  });

  it('does not penalize the onboarding week for pre-onboard days (mid-week start)', () => {
    // Onboard Wed (planStart Mon 06-01, created Wed 06-03 → firstTrackedDow 2).
    // rw=4, so round(4 × 2/7) = 1 run fell on dropped pre-onboard days. The
    // onboarding week's denominator must drop to 3, not stay at 4.
    const wk1 = makeWeek(1, {
      garminActuals: {
        'a': makeRunActual(10, 10),
        'b': makeRunActual(10, 10),
        'c': makeRunActual(10, 10),
      },
    });
    const s = makeState({
      rw: 4, w: 2, wks: [wk1, makeWeek(2)],
      planStartDate: '2026-06-01', planCreatedAt: '2026-06-03',
    });
    const result = computePlanAdherence(s);
    expect(result.totalPlanned).toBe(3); // 4 − 1 pre-onboard run
    expect(result.totalCompleted).toBe(3);
    expect(result.pct).toBe(100);
  });

  it('established plans (creation predates week start) keep the full denominator', () => {
    const wk1 = makeWeek(1, { garminActuals: { 'a': makeRunActual(10, 10) } });
    const s = makeState({
      rw: 4, w: 2, wks: [wk1, makeWeek(2)],
      planStartDate: '2026-06-01', planCreatedAt: '2026-05-20',
    });
    const result = computePlanAdherence(s);
    expect(result.totalPlanned).toBe(4); // no pre-onboard reduction
  });

  it('excludes current in-progress week from scoring', () => {
    const wk1 = makeWeek(1, {
      garminActuals: { 'a': makeRunActual(10, 10) },
    });
    const wk2 = makeWeek(2, {
      garminActuals: { 'a': makeRunActual(10, 10), 'b': makeRunActual(10, 10) },
    });
    // current = week 2, so only week 1 is scored
    const s = makeState({ rw: 4, w: 2, wks: [wk1, wk2] });
    const result = computePlanAdherence(s);
    expect(result.weeksIncluded).toBe(1);
    expect(result.totalCompleted).toBe(1);
    expect(result.totalPlanned).toBe(4);
  });

  it('subtracts pushed workouts from denominator', () => {
    // Week 1: 4 planned runs, 1 pushed to week 2 → denom = 3
    const wk1 = makeWeek(1, {
      garminActuals: {
        'a': makeRunActual(10, 10),
        'b': makeRunActual(10, 10),
        'c': makeRunActual(10, 10),
      },
    });
    const wk2 = makeWeek(2, {
      skip: [{
        n: 'Easy', t: 'easy',
        workout: { id: 'W1-easy-0', n: 'Easy', t: 'easy', d: '6km', r: 3 } as any,
        skipCount: 1,
      }],
    });
    const s = makeState({ rw: 4, w: 3, wks: [wk1, wk2, makeWeek(3)] });
    const result = computePlanAdherence(s);
    // Week 1: 3 completed / 3 planned (4 - 1 push) = 100%
    // Week 2: 0 completed / 4 planned = 0%
    expect(result.totalPlanned).toBe(7); // 3 + 4
    expect(result.totalCompleted).toBe(3);
  });

  it('subtracts illness-rested days from the denominator (rest is not a miss)', () => {
    // Week 1 had 4 planned runs but the user was ill and told to rest 2 days.
    // Without the fix: 2 completed / 4 = 50%. With it: 2 / (4-2) = 100%.
    const wk1 = makeWeek(1, {
      garminActuals: { 'a': makeRunActual(10, 10), 'b': makeRunActual(10, 10) },
    });
    const s = makeState({
      rw: 4, w: 2, planStartDate: '2026-01-05',
      wks: [wk1, makeWeek(2)],
      illnessState: {
        startDate: '2026-01-05', active: true, severity: 'resting',
        schedule: [
          { dateOffsetDays: 0, capacity: 'rest', volumeFactor: 0, intensityCeiling: 'rest' },
          { dateOffsetDays: 1, capacity: 'rest', volumeFactor: 0, intensityCeiling: 'rest' },
        ],
      } as any,
    });
    const result = computePlanAdherence(s);
    expect(result.totalPlanned).toBe(2);
    expect(result.totalCompleted).toBe(2);
    expect(result.pct).toBe(100);
  });

  it('a fully illness-rested week is excluded entirely', () => {
    const wk1 = makeWeek(1, {}); // nothing completed — fully rested
    const s = makeState({
      rw: 4, w: 2, planStartDate: '2026-01-05',
      wks: [wk1, makeWeek(2)],
      illnessState: {
        startDate: '2026-01-05', active: true, severity: 'resting',
        schedule: Array.from({ length: 7 }, (_, i) => ({
          dateOffsetDays: i, capacity: 'rest', volumeFactor: 0, intensityCeiling: 'rest',
        })),
      } as any,
    });
    const result = computePlanAdherence(s);
    // All 7 days rest → denominator 0 → week excluded, not 0%.
    expect(result.weeksIncluded).toBe(0);
    expect(result.pct).toBeNull();
  });

  it('ignores non-run activities in garminActuals', () => {
    const wk1 = makeWeek(1, {
      garminActuals: {
        'run-slot': makeRunActual(10, 10),
        'gym-slot': {
          ...makeRunActual(0, 0),
          activityType: 'STRENGTH_TRAINING',
          plannedDistanceKm: null,
        } as any,
      },
    });
    const s = makeState({ rw: 4, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(1);
  });

  it('ignores ad-hoc runs (plannedDistanceKm is null)', () => {
    const wk1 = makeWeek(1, {
      garminActuals: {
        'planned': makeRunActual(10, 10),
        'adhoc': {
          ...makeRunActual(5),
          plannedDistanceKm: null,
        } as any,
      },
    });
    const s = makeState({ rw: 4, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(1); // only the planned one
  });

  it('uses plannedDistanceKm from garminActuals (already post-reduction)', () => {
    // Run was reduced from 12km to 8km. Actual = 7.8km.
    // plannedDistanceKm = 8 (set at match time from post-reduction desc)
    // 7.8 >= 0.95 * 8 = 7.6 → completed
    const wk1 = makeWeek(1, {
      garminActuals: {
        'long-slot': {
          ...makeRunActual(7.8),
          plannedDistanceKm: 8,
        },
      },
    });
    const s = makeState({ rw: 4, w: 2, wks: [wk1, makeWeek(2)] });
    const result = computePlanAdherence(s);
    expect(result.totalCompleted).toBe(1);
  });

  it('ADHERENCE_THRESHOLD is 0.95', () => {
    expect(ADHERENCE_THRESHOLD).toBe(0.95);
  });
});

describe('computePlanAdherence — trailing window (nWeeks)', () => {
  // Build a 5-completed-week history: weeks 1-3 perfect (100%), weeks 4-5 missed
  // (0%). Current week 6, so weeks 1-5 are scoreable.
  function fiveWeekHistory(): SimulatorState {
    const good = (w: number) => makeWeek(w, {
      garminActuals: {
        a: makeRunActual(10, 10), b: makeRunActual(10, 10),
        c: makeRunActual(10, 10), d: makeRunActual(10, 10),
      },
    });
    const bad = (w: number) => makeWeek(w, {}); // 0 completed
    return makeState({
      rw: 4, w: 6,
      wks: [good(1), good(2), good(3), bad(4), bad(5), makeWeek(6)],
    });
  }

  it('without nWeeks, scores every completed week (cumulative)', () => {
    const s = fiveWeekHistory();
    const r = computePlanAdherence(s);
    expect(r.weeksIncluded).toBe(5);
    // 12 completed / 20 planned = 60%
    expect(r.totalCompleted).toBe(12);
    expect(r.totalPlanned).toBe(20);
    expect(r.pct).toBe(60);
  });

  it('with nWeeks=3, only the last 3 completed weeks contribute', () => {
    const s = fiveWeekHistory();
    const r = computePlanAdherence(s, 3);
    // Weeks 3 (good), 4 (bad), 5 (bad): 4 completed / 12 planned = 33%
    expect(r.weeksIncluded).toBe(3);
    expect(r.totalCompleted).toBe(4);
    expect(r.totalPlanned).toBe(12);
    expect(r.pct).toBe(33);
  });
});

describe('detectChronicLowAdherence', () => {
  it('constants reflect Tristan\'s decision (70% over 3 weeks)', () => {
    expect(CHRONIC_ADHERENCE_WINDOW_WEEKS).toBe(3);
    expect(CHRONIC_ADHERENCE_THRESHOLD_PCT).toBe(70);
  });

  it('returns null when pct is null (not enough data)', () => {
    expect(detectChronicLowAdherence({ pct: null, weeksIncluded: 0 })).toBeNull();
  });

  it('returns null with fewer than 3 weeks of data, even if pct is low', () => {
    expect(detectChronicLowAdherence({ pct: 40, weeksIncluded: 2 })).toBeNull();
  });

  it('returns null when adherence is at or above 70%', () => {
    expect(detectChronicLowAdherence({ pct: 70, weeksIncluded: 3 })).toBeNull();
    expect(detectChronicLowAdherence({ pct: 85, weeksIncluded: 4 })).toBeNull();
  });

  it('fires when adherence is below 70% across 3+ weeks', () => {
    expect(detectChronicLowAdherence({ pct: 69, weeksIncluded: 3 })).toEqual({ pct: 69, weeks: 3 });
    expect(detectChronicLowAdherence({ pct: 50, weeksIncluded: 4 })).toEqual({ pct: 50, weeks: 4 });
  });

  it('end-to-end: a sustained-miss history trips the detector', () => {
    const good = (w: number) => makeWeek(w, {
      garminActuals: {
        a: makeRunActual(10, 10), b: makeRunActual(10, 10),
        c: makeRunActual(10, 10), d: makeRunActual(10, 10),
      },
    });
    const oneOfFour = (w: number) => makeWeek(w, { garminActuals: { a: makeRunActual(10, 10) } });
    // Last 3 completed weeks (idx 2,3,4) each at 1/4 = 25% combined.
    const s = makeState({
      rw: 4, w: 6,
      wks: [good(1), good(2), oneOfFour(3), oneOfFour(4), oneOfFour(5), makeWeek(6)],
    });
    const signal = detectChronicLowAdherence(computePlanAdherence(s, CHRONIC_ADHERENCE_WINDOW_WEEKS));
    expect(signal).not.toBeNull();
    expect(signal!.weeks).toBe(3);
    expect(signal!.pct).toBe(25);
  });
});

describe('suggestedRunsPerWeek', () => {
  const result = (over: Partial<PlanAdherenceResult>): PlanAdherenceResult => ({
    pct: 50, totalPlanned: 12, totalCompleted: 6, weeksIncluded: 3, ...over,
  });

  it('returns the rounded demonstrated frequency when below current', () => {
    // 6 completed over 3 weeks = 2.0/week, current 4 → suggest 2.
    expect(suggestedRunsPerWeek(result({ totalCompleted: 6, weeksIncluded: 3 }), 4)).toBe(2);
  });

  it('rounds to nearest whole session', () => {
    // 8 completed over 3 weeks = 2.67 → rounds to 3.
    expect(suggestedRunsPerWeek(result({ totalCompleted: 8, weeksIncluded: 3 }), 5)).toBe(3);
  });

  it('floors at 1 run even when almost nothing was completed', () => {
    expect(suggestedRunsPerWeek(result({ totalCompleted: 1, weeksIncluded: 3 }), 4)).toBe(1);
  });

  it('returns null when demonstrated frequency is not below current (nothing to do)', () => {
    // 11 completed over 3 weeks ≈ 3.67 → rounds to 4, equal to current 4.
    expect(suggestedRunsPerWeek(result({ totalCompleted: 11, weeksIncluded: 3 }), 4)).toBeNull();
  });

  it('returns null without a full window of data', () => {
    expect(suggestedRunsPerWeek(result({ weeksIncluded: 2 }), 4)).toBeNull();
  });

  it('never suggests raising frequency', () => {
    // 9 completed over 3 weeks = 3/week, current 2 → 3 is not < 2 → null.
    expect(suggestedRunsPerWeek(result({ totalCompleted: 9, weeksIncluded: 3 }), 2)).toBeNull();
  });
});
