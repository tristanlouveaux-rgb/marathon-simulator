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
   * Single 5K PB, marathon target. Pins that typed manual-entry volume reaches
   * blendPredictions at finalize, AND that "no data" is no longer treated as
   * "zero training".
   *
   * 2026-06-15 fix: an empty scrape with no typed volume now passes `undefined`
   * (no signal) rather than an explicit 0. So the marathon-specificity penalty
   * stays DORMANT for a brand-new user — the anchor is the demonstrated fitness
   * ceiling, not a max-detraining estimate. A typed 25 km/week, by contrast, is
   * real information showing sub-marathon-prep volume, so it correctly triggers
   * the ×1.05 (<30 km/wk) band. The typed-volume anchor is therefore SLOWER than
   * the no-data anchor by exactly that band: absence of data is optimistic,
   * stated low volume is penalised. The ratio isolates that one term (durability
   * cap and all other inputs identical). Real case, 2026-06-04: typed
   * "10 km/week" + 0 scraped activities meant the blend saw an explicit zero
   * instead of the stated volume — that path now resolves to 25 here.
   */
  it('typed weekly volume reaches the blend; no-data stays penalty-free', () => {
    const onboarding = buildRunningOnboarding({
      raceDistance: 'marathon',
      pbs: { k5: 1059 },
    });

    // Run 1: empty scrape, no typed volume → no signal → specificity penalty
    // dormant. Anchor is the fitness ceiling.
    let result = initializeSimulator(onboarding);
    expect(result.success).toBe(true);
    const anchorNoData = getState().blendedRaceTimeSec!;

    // Run 2: same athlete, typed 25 km/week in manual entry → real low-volume
    // signal → ×1.05 specificity band.
    resetState();
    const s = getMutableState();
    s.detectedWeeklyKm = 25;
    s.weeklyVolumeConfirmed = true;
    result = initializeSimulator(onboarding);
    expect(result.success).toBe(true);
    const anchorTyped = getState().blendedRaceTimeSec!;

    // Stated low volume is penalised; absence of data is not. The typed anchor
    // is slower by exactly the ×1.05 band.
    expect(anchorTyped / anchorNoData).toBeCloseTo(1.05, 3);
  });
});
