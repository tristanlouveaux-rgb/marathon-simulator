/**
 * Onboarding anchor durability-cap parity.
 *
 * `refreshBlendedFitness` (the canonical blended-fitness refresher) applies
 * the long-run durability cap to `blendedRaceTimeSec` before deriving the
 * effective VDOT. Pre-fix, `initializeSimulator` seeded the same cache
 * WITHOUT the cap, so a thin-data athlete (single typed 5K PB, empty run
 * history) got a raw Riegel extrapolation as their "current race estimate"
 * (real case, 2026-06-04: 17:39 5K + 0 scraped runs → 1:26:00 half, with
 * every endurance brake switched off). The first backfill refresh would
 * then silently slow the anchor by up to 4-5%, making the number the user
 * anchored on at onboarding quietly worse a day later.
 *
 * These tests pin the parity: the onboarding anchor must equal
 * (raw blend × durability multiplier), the durability result must be stored
 * for the Forecast chip, and the derived VDOT must come from the capped time.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('alert', vi.fn());

import { initializeSimulator } from './initialization';
import { getMutableState, getState } from './store';
import { cv, rd } from '@/calculations';
import { predictFromPB } from '@/calculations/predictions';
import { LONG_RUN_MAX_PENALTY, LONG_RUN_THRESHOLD_SEC } from '@/calculations/run-durability';
import { raceDayPlanDurability } from '@/calculations/race-day-durability';

/** Thin-data athlete: one typed 5K PB, nothing else. The 2026-06-04 case. */
function buildThinHalfOnboarding(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    trainingMode: 'running',
    trainingForEvent: true,
    raceDistance: 'half',
    planDurationWeeks: 16,
    runsPerWeek: 4,
    pbs: { k5: 1059 }, // 17:39
    ...overrides,
  } as OnboardingState;
}

function resetState() {
  const s = getMutableState();
  s.eventType = undefined as any;
  s.triConfig = undefined;
  s.hyroxConfig = undefined;
  s.wks = undefined as any;
  s.wkm = undefined as any;
  s.detectedWeeklyKm = undefined;
  s.weeklyVolumeConfirmed = undefined;
  s.stravaHistoryAccepted = undefined;
  s.onboardingRunHistory = undefined;
  s.runDurability = undefined;
  s.raceDayDurability = undefined;
  s.runRaceLog = undefined;
  s.trackOnly = false;
  localStorageMock.clear();
}

describe('initializeSimulator — durability cap on the onboarding anchor', () => {
  beforeEach(() => resetState());

  it('thin-data half athlete gets the max durability penalty on the anchor (no run history)', () => {
    const result = initializeSimulator(buildThinHalfOnboarding());
    expect(result.success).toBe(true);

    const s = getState();
    // Raw blend for a single-5K-PB athlete is predictFromPB alone (b=1.06
    // default, internal ≥1.10 short-anchor floor). ~5160s = 1:26:00.
    const rawBlend = predictFromPB(rd('half'), { k5: 1059 }, 1.06)!;
    const maxMult = 1 + LONG_RUN_MAX_PENALTY.half; // 1.04

    expect(s.runDurability).toBeDefined();
    expect(s.runDurability!.multiplier).toBeCloseTo(maxMult, 5);
    expect(s.runDurability!.limitingFactor).toBe('long_run_shortfall');
    // Anchor = raw blend × cap (~1:29:26, not the raw 1:26:00)
    expect(s.blendedRaceTimeSec).toBeCloseTo(rawBlend * maxMult, 0);
    expect(s.initialBaseline).toBeCloseTo(rawBlend * maxMult, 0);
    expect(s.currentFitness).toBeCloseTo(rawBlend * maxMult, 0);
  });

  it('engine holds at PB capacity while the race anchor keeps the durability penalty (ISSUE-297 separation)', () => {
    const result = initializeSimulator(buildThinHalfOnboarding());
    expect(result.success).toBe(true);

    const s = getState();
    // The RACE anchor keeps the durability/readiness penalty (a single 5K
    // Riegel-projected to a half with no endurance base is correctly slow):
    const cappedVdot = cv(rd('half'), s.blendedRaceTimeSec!);
    // ...but the global ENGINE is floored at demonstrated PB capacity (the 17:39
    // 5K, VDOT ~57.6), not buried by that readiness penalty. Engine ≠ readiness:
    // low volume / thin endurance slows the prediction, never the capacity number.
    // (Pre-ISSUE-297 both s.v and blendedEffectiveVdot were the penalised
    // capped-time VDOT — that conflation is exactly what this fix removes.)
    const capacityVdot = cv(5000, 1059);
    expect(s.v).toBeCloseTo(capacityVdot, 1);
    expect(s.blendedEffectiveVdot).toBeCloseTo(capacityVdot, 1);
    expect(s.v!).toBeGreaterThan(cappedVdot + 1);
  });

  it('athlete with a threshold-meeting long run gets no penalty (multiplier 1)', () => {
    const s = getMutableState();
    // Long run 9 days ago, comfortably over the 105-min half threshold.
    const startTime = new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString();
    s.onboardingRunHistory = [
      { startTime, distKm: 20, durSec: LONG_RUN_THRESHOLD_SEC.half + 300, activityType: 'RUNNING' } as any,
    ];

    const result = initializeSimulator(buildThinHalfOnboarding());
    expect(result.success).toBe(true);

    const after = getState();
    expect(after.runDurability!.multiplier).toBe(1);
    expect(after.runDurability!.limitingFactor).toBeNull();
  });

  it('partial long-run history scales the penalty linearly with the shortfall', () => {
    const s = getMutableState();
    // Longest run = half the threshold → penalty = half of max.
    const startTime = new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString();
    const halfThreshold = LONG_RUN_THRESHOLD_SEC.half / 2;
    s.onboardingRunHistory = [
      { startTime, distKm: 10, durSec: halfThreshold, activityType: 'RUNNING' } as any,
    ];

    const result = initializeSimulator(buildThinHalfOnboarding());
    expect(result.success).toBe(true);

    const after = getState();
    const expectedMult = 1 + LONG_RUN_MAX_PENALTY.half * 0.5; // 1.02
    expect(after.runDurability!.multiplier).toBeCloseTo(expectedMult, 5);
  });
});

describe('initializeSimulator: the first race-day forecast reads the plan\'s long runs (2026-10-07)', () => {
  beforeEach(() => resetState());

  it('stores the race-day plan durability, computed from the plan being built', () => {
    // A 16-week half plan's long run peaks under the 105-min half threshold, so the
    // race-day forecast carries a durability penalty instead of assuming it met.
    const result = initializeSimulator(buildThinHalfOnboarding());
    expect(result.success).toBe(true);
    const s = getState();
    expect(s.raceDayDurability).toBeDefined();
    expect(s.raceDayDurability!.longestRunSec).toBeLessThan(LONG_RUN_THRESHOLD_SEC.half);
    expect(s.raceDayDurability!.multiplier).toBeGreaterThan(1);
    // Computed mid-initialisation with the inputs the plan is built from: equal to
    // the result from the finished state (onboarding, continuous flag, plan start).
    expect(s.raceDayDurability).toEqual(raceDayPlanDurability(s));
  });

  it('no-event (continuous) plan: no race-day durability term', () => {
    const result = initializeSimulator(buildThinHalfOnboarding({ trainingForEvent: false }));
    expect(result.success).toBe(true);
    expect(getState().raceDayDurability).toBeUndefined();
  });
});
