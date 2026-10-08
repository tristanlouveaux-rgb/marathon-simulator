/**
 * Where a new running plan's weekly load target comes from (investigation,
 * 2026-10-08, QA harness scenarios fewer-runs and sharpen6).
 *
 * PLANNING side. computePlannedWeekTarget is a history baseline x phase
 * multiplier (SCIENCE_LOG §CH). The baseline chain is: median of
 * historicWeeklyTSS (3 or more non-zero weeks) -> ctlBaseline -> runs/week x 50
 * (fitness-model.ts computePlannedWeekTSS, "last resort").
 *
 * Finding: the harness seeds per-run history (onboardingRunHistory) but not
 * the weekly aggregation a real Strava or Apple Health sync writes in the same
 * pass (historicWeeklyTSS, ctlBaseline, athleteTier: stravaSync.ts
 * fetchStravaHistory, appleHealthSync.ts). Both scenarios therefore land on the
 * last resort, 4 runs x 50 x 1.08 (recreational build row) = 216, whatever
 * their weekly km. With the aggregation a sync writes, the same athlete's
 * target follows the athlete's own weekly median.
 *
 * In the app, an athlete with no synced history (weekly km typed on the
 * review step) always takes the last resort: the plan is sized from the typed
 * km while the target is sized from runs/week. Whether to add a stated-volume
 * step to the chain is an open question for Tristan; this file pins today's
 * documented behaviour so a change to it is deliberate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OnboardingState } from '@/types/onboarding';
import { defaultOnboardingState } from '@/types/onboarding';

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
import { getMutableState, getState, resetState } from './store';
import { computePlannedWeekTarget } from '@/calculations/planned-week-target';
import { localMondayKey } from '@/utils/local-date';
import type { SimulatorState } from '@/types/state';

const DAY_MS = 86400000;

function planDay(week: number, dow: number): string {
  const [y, m, d] = localMondayKey(new Date()).split('-').map(Number);
  const t = new Date(y, m - 1, d + (week - 1) * 7 + dow);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

type RunRow = NonNullable<SimulatorState['onboardingRunHistory']>[number];

function history(weeks: number, week: Array<[number, number, number]>, startDaysAgo: number): RunRow[] {
  const rows: RunRow[] = [];
  for (let k = 0; k < weeks; k++) {
    for (const [off, km, min] of week) {
      const d = new Date(Date.now() - (startDaysAgo + k * 7 + off) * DAY_MS);
      d.setHours(8, 0, 0, 0);
      rows.push({ startTime: d.toISOString(), distKm: km, durSec: Math.round(min * 60), activityType: 'RUNNING' });
    }
  }
  return rows;
}

function onboarding(over: Partial<OnboardingState>): OnboardingState {
  return {
    ...defaultOnboardingState,
    name: 'QA', currentStep: 'initializing', trainingMode: 'running', trainingForEvent: true,
    raceDistance: 'marathon', selectedRace: null, hasSmartwatch: true,
    runsPerWeek: 4, experienceLevel: 'intermediate', pbs: { k10: 2700 },
    ...over,
  } as OnboardingState;
}

function seed(over: Partial<SimulatorState>): void {
  resetState();
  localStorageMock.clear();
  Object.assign(getMutableState(), {
    unitPref: 'km', stravaHistoryAccepted: true,
    athleteArchetype: { archetype: 'consistent-runner' } as SimulatorState['athleteArchetype'],
    ...over,
  });
}

/** Harness fewer-runs: 15 km a week (10 km + 5 km at 5:48/km), 2 h target, marathon 5 weeks out. */
function buildFewerRuns(over: Partial<SimulatorState> = {}): void {
  seed({ detectedWeeklyKm: 15, onboardingRunHistory: history(4, [[0, 10, 58], [3, 5, 29]], 2), ...over });
  expect(initializeSimulator(onboarding({
    customRaceDate: planDay(5, 6), planDurationWeeks: 5, weeklyTrainingHours: 2,
  })).success).toBe(true);
}

/** Harness sharpen6: 30 km a week (16 + 6 + 8 km), marathon 6 weeks out. */
function buildSharpen6(): void {
  seed({ detectedWeeklyKm: 30, onboardingRunHistory: history(5, [[0, 16, 92], [2, 6, 34], [4, 8, 45]], 3) });
  expect(initializeSimulator(onboarding({ customRaceDate: planDay(6, 6), planDurationWeeks: 6 })).success).toBe(true);
}

describe('new running plan: weekly load target baseline', () => {
  beforeEach(() => { resetState(); localStorageMock.clear(); });

  it('per-run history alone leaves no load baseline, so the target is the runs/week x 50 last resort', () => {
    buildFewerRuns();
    const s = getState();
    expect(s.historicWeeklyTSS).toBeUndefined();
    expect(s.ctlBaseline).toBeUndefined();
    expect(s.wks[0].ph).toBe('build');
    // 4 runs x 50 = 200, x 1.08 (recreational build row, the default tier).
    expect(computePlannedWeekTarget(s, 1)).toBe(216);
  });

  it('the 15 km and 30 km harness athletes get the same target: it reads runs/week, not km', () => {
    buildFewerRuns();
    const fewer = computePlannedWeekTarget(getState(), 1);
    buildSharpen6();
    expect(getState().wks[0].ph).toBe('build');
    expect(computePlannedWeekTarget(getState(), 1)).toBe(fewer);
  });

  it('with the weekly aggregation a sync writes, the target follows the athlete\'s own median', () => {
    // 87 min of easy running a week at the canonical easy rate (0.92 TSS/min,
    // TL_PER_MIN[4]) is 80 TSS; a sync zero-fills the 8-week window.
    buildFewerRuns({ historicWeeklyTSS: [0, 0, 0, 0, 80, 80, 80, 80], ctlBaseline: 39, athleteTier: 'beginner' });
    // 80 x 1.05 (beginner build row).
    expect(computePlannedWeekTarget(getState(), 1)).toBe(84);
  });
});
