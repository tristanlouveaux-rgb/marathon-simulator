/**
 * Onboarding finalize — LT consistency + per-plan goal reset.
 *
 * Real case, 2026-06-04 (the "LT 4:56/km" diagnosis): a wizard pass with
 * four typed PBs (17:38 / 39:20 / 1:31:30 / 3:09:42) finalized with
 * `s.lt: null` but stale `ltSource: 'blended'` / `ltConfidence: 'high'`
 * surviving from a pre-finalize recompute against the PREVIOUS plan's
 * state — and a sub-3 MARATHON goal (`raceGoalTimeSec: 10800`) carried
 * onto the fresh HALF plan, rendering "TARGET TIME 3:00:00 · >95%".
 *
 * Pins: (1) finalize derives a real LT from the committed PBs when the
 * wizard supplied no measured one, with consistent provenance; (2) the
 * derived LT respects the race-PB pace bound; (3) a stale race goal does
 * not survive plan initialization.
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

const TRISTAN_PBS = { k5: 1058, k10: 2360, h: 5490, m: 11382 };

function buildOnboarding(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    trainingMode: 'running',
    trainingForEvent: true,
    raceDistance: 'half',
    planDurationWeeks: 20,
    runsPerWeek: 4,
    pbs: TRISTAN_PBS,
    ...overrides,
  } as OnboardingState;
}

function resetState() {
  const s = getMutableState();
  s.eventType = undefined as any;
  s.triConfig = undefined;
  s.hyroxConfig = undefined;
  s.wks = undefined as any;
  s.pbs = {};
  s.lt = null as any;
  s.ltPace = null as any;
  s.ltSource = undefined;
  s.ltConfidence = undefined;
  s.ltOverride = undefined;
  s.garminLT = undefined;
  s.vo2 = null as any;
  s.raceGoalTimeSec = undefined;
  s.onboardingRunHistory = undefined;
  s.detectedWeeklyKm = undefined;
  s.trackOnly = false;
  localStorageMock.clear();
}

describe('initializeSimulator — LT consistency at finalize', () => {
  beforeEach(() => resetState());

  it('derives a real LT from the committed PBs when the wizard supplied none', () => {
    const result = initializeSimulator(buildOnboarding());
    expect(result.success).toBe(true);

    const s = getState();
    expect(s.lt).not.toBeNull();
    expect(s.lt!).toBeGreaterThan(0);
    // Provenance is consistent: a non-null LT carries a real source.
    expect(s.ltSource).toBeDefined();
    // Definitional bound: LT can never be slower than the tightest
    // long-race PB pace (half 1:31:30 → 260.2 s/km).
    expect(s.lt!).toBeLessThanOrEqual(5490 / 21.0975 + 0.5);
    // And it should be a plausible threshold for these PBs, not a
    // degraded-VDOT artefact (4:56/km = 296 was the bug).
    expect(s.lt!).toBeLessThan(280);
    // initialLT mirrors the derived value.
    expect(s.initialLT).toBe(s.lt);
  });

  it('keeps a measured wizard LT untouched', () => {
    const result = initializeSimulator(buildOnboarding({ ltPace: 238 } as Partial<OnboardingState>));
    expect(result.success).toBe(true);
    expect(getState().lt).toBe(238);
  });
});

describe('initializeSimulator — race goal is per-plan', () => {
  beforeEach(() => resetState());

  it('clears a stale race goal from a previous plan', () => {
    const s = getMutableState();
    s.raceGoalTimeSec = 10800; // sub-3 marathon goal from the previous plan
    const result = initializeSimulator(buildOnboarding());
    expect(result.success).toBe(true);
    expect(getState().raceGoalTimeSec).toBeUndefined();
  });
});
