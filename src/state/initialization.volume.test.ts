/**
 * D3: plan starting-volume gate.
 *
 * The plan's starting weekly volume (s.wkm) normally comes from a runs-per-week
 * lookup. A *detected* weekly km (from Strava history, manual entry, or an
 * import) should override that lookup. But only when the user has explicitly
 * provided or accepted it, never from a silent derive. Pre-fix the gate keyed
 * solely on `stravaHistoryAccepted`, so a manual-entry user's typed volume was
 * read by prediction/archetype but never seeded the plan. This generalises the
 * gate to a source-agnostic `weeklyVolumeConfirmed` while preserving the legacy
 * Strava flag.
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

/** Minimal valid running onboarding. runsPerWeek=5 → lookup default wkm = 50. */
function buildRunningOnboarding(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    trainingMode: 'running',
    trainingForEvent: true,
    raceDistance: '10k',
    planDurationWeeks: 12,
    runsPerWeek: 5,
    pbs: { k5: 1200, k10: 2500 },
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
  s.trackOnly = false;
  localStorageMock.clear();
}

describe('initializeSimulator — plan starting-volume gate (D3)', () => {
  beforeEach(() => resetState());

  it('confirmed volume (manual entry) overrides the runs-per-week lookup', () => {
    const s = getMutableState();
    s.detectedWeeklyKm = 55;
    s.weeklyVolumeConfirmed = true;
    const result = initializeSimulator(buildRunningOnboarding());
    expect(result.success).toBe(true);
    expect(getState().wkm).toBe(55);
  });

  it('unconfirmed detected volume is ignored — falls back to the lookup (50 for 5 runs)', () => {
    const s = getMutableState();
    s.detectedWeeklyKm = 55;
    s.weeklyVolumeConfirmed = false;
    s.stravaHistoryAccepted = false;
    const result = initializeSimulator(buildRunningOnboarding());
    expect(result.success).toBe(true);
    expect(getState().wkm).toBe(50);
  });

  it('legacy Strava "Use this" flag still seeds plan volume (back-compat)', () => {
    const s = getMutableState();
    s.detectedWeeklyKm = 62;
    s.stravaHistoryAccepted = true;
    s.weeklyVolumeConfirmed = undefined;
    const result = initializeSimulator(buildRunningOnboarding());
    expect(result.success).toBe(true);
    expect(getState().wkm).toBe(62);
  });
});

describe('initializeSimulator — typed volume reaches the prediction blend', () => {
  beforeEach(() => resetState());

  /**
   * Single 5K PB + empty scrape, marathon target. With weeklyKm=0 the
   * marathon-specificity penalty fires at max (×1.15); with the typed
   * volume falling back via resolveWeeklyKmSignal (25 km/wk) it softens to
   * ×1.05. The anchor ratio between the two runs isolates exactly that
   * term (durability cap and all other inputs are identical), pinning that
   * the typed manual-entry volume reaches blendPredictions at finalize.
   * Real case, 2026-06-04: typed "10 km/week" + 0 scraped activities meant
   * the blend saw an explicit zero instead of the stated volume.
   */
  it('typed weekly volume softens the marathon-specificity penalty vs an empty scrape', () => {
    const onboarding = buildRunningOnboarding({
      raceDistance: 'marathon',
      pbs: { k5: 1059 },
    });

    // Run 1: empty scrape, no typed volume → explicit zero → max penalty.
    let result = initializeSimulator(onboarding);
    expect(result.success).toBe(true);
    const anchorZero = getState().blendedRaceTimeSec!;

    // Run 2: same athlete, typed 25 km/week in manual entry.
    resetState();
    const s = getMutableState();
    s.detectedWeeklyKm = 25;
    s.weeklyVolumeConfirmed = true;
    result = initializeSimulator(onboarding);
    expect(result.success).toBe(true);
    const anchorTyped = getState().blendedRaceTimeSec!;

    // 1.15 / 1.05 ≈ 1.095 — the typed-volume anchor must be faster by
    // exactly the penalty-band difference.
    expect(anchorZero / anchorTyped).toBeCloseTo(1.15 / 1.05, 3);
  });
});
