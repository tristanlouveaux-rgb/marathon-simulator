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
 * Typed weekly km (Tristan, 2026-10-09: typed weekly km shapes the plan and
 * the weekly target). An athlete with no synced history who typed a weekly km
 * (manual entry or the review-step slider) used to take the last resort for
 * the target, and the race-target volume for the plan, because the volume ramp
 * from current km needs an athlete archetype (plan_engine.ts
 * effectiveWeeklyBudget) and only a sync wrote one. A typed 50 km on 3 runs
 * priced at 214 to 235 TSS a week against a 146 target. Now the typed km feeds
 * both paths a sync feeds: the archetype comes from the same classifier
 * (typedVolumeArchetype, planRampArchetype) and the target baseline is the
 * typed km priced as easy running (typedVolumeWeeklyTSS), after history and
 * the EMA. Synced history still wins.
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
import { computePlannedWorkoutSignalBTSS, planCardBaseMinPerKm } from '@/calculations/fitness-model';
import { resolveWeekWorkouts } from '@/ui/week-resolve';
import { planEngineStateInputs, plannedRunMinutesByWeek, runningPlanShapeInputs } from '@/workouts/plan_engine';
import { detectArchetype, startingWeeklyKm } from '@/calculations/athlete-archetype';
import { planForecastWeeklyKm } from '@/calculations/blended-fitness';
import { lowBaseMarathon } from '@/ui/wizard/steps/race-target-plan-note';
import { TL_PER_MIN } from '@/constants';
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

/**
 * Manual weekly km on the review step, no sync: detectedWeeklyKm and
 * weeklyVolumeConfirmed are set (review.ts volume slider), nothing else is.
 * 16-week marathon, 10K 45:00. Week-1 volume is read from the plan's own
 * full-week replay (plannedRunMinutesByWeek), so a mid-week start, which makes
 * the calendar week 1 partial, does not enter.
 */
function buildManual(km: number, runsPerWeek: number, over: Partial<SimulatorState> = {}, weeks = 16): void {
  resetState();
  localStorageMock.clear();
  Object.assign(getMutableState(), { unitPref: 'km', detectedWeeklyKm: km, weeklyVolumeConfirmed: true, ...over });
  expect(initializeSimulator(onboarding({
    customRaceDate: planDay(weeks, 6), planDurationWeeks: weeks, runsPerWeek, hasSmartwatch: false,
  })).success).toBe(true);
}

/** The same athlete with 8 synced weeks at `km` (the fields a Strava sync writes for the ramp). */
function buildSynced(km: number, runsPerWeek: number): void {
  resetState();
  localStorageMock.clear();
  const s = getMutableState();
  Object.assign(s, {
    unitPref: 'km', stravaHistoryFetched: true, stravaHistoryAccepted: true,
    detectedWeeklyKm: km, historicWeeklyKm: Array(8).fill(km),
  });
  s.athleteArchetype = detectArchetype(s);
  expect(initializeSimulator(onboarding({
    customRaceDate: planDay(16, 6), planDurationWeeks: 16, runsPerWeek, hasSmartwatch: false,
  })).success).toBe(true);
}

/** A week's running sessions priced the way the Plan card prices them (planCardPlannedTSS). */
function weekPlannedTSS(week: number): number {
  const s = getMutableState();
  const base = planCardBaseMinPerKm(s);
  return resolveWeekWorkouts(s, week)
    .reduce((sum: number, w: any) => sum + Math.round(computePlannedWorkoutSignalBTSS(w, base)), 0);
}

/** Running minutes of every plan week, from the plan's full-week replay. */
function weekMinutes(): number[] {
  return plannedRunMinutesByWeek(runningPlanShapeInputs(getState())).map(w => w.reduce((a, b) => a + b, 0));
}

/** The typed km's weekly TSS: km at easy pace x 0.92 TSS/min (TL_PER_MIN[4], the easy-run row). */
function typedTSS(km: number): number {
  return km * (getState().pac.e / 60) * TL_PER_MIN[4];
}

describe('typed weekly km (no sync) shapes the plan and the weekly target', () => {
  beforeEach(() => { resetState(); localStorageMock.clear(); });

  it('typed 50 km: week 1 is capped by the typed km and otherwise set by the race-target week; the target follows the typed km', () => {
    buildManual(50, 4);
    const s = getState();
    expect(s.athleteArchetype).toBeUndefined();
    expect(planEngineStateInputs(s)).toEqual({ baselineKm: 50, archetype: 'consistent-runner', baselineKmIsEstimate: false });
    // The ramp can only lower a week: week 1 is capped at the consistent-runner
    // start (50 x 1.05 km at easy pace).
    const week1 = weekMinutes()[0];
    const typedEasyMin = Math.round(50 * s.pac.e / 60);
    expect(week1).toBeLessThanOrEqual(Math.round(startingWeeklyKm(50, 'consistent-runner') * s.pac.e / 60));
    // Base weeks: x 0.97 (recreational base row); week 4 is a deload (x 0.70).
    expect([1, 2, 3, 4].map(w => computePlannedWeekTarget(s, w))).toEqual([
      Math.round(typedTSS(50) * 0.97), Math.round(typedTSS(50) * 0.97), Math.round(typedTSS(50) * 0.97), Math.round(typedTSS(50) * 0.70),
    ]);
    // Under that cap the race-target week sets week 1, so week 1 does not rise to
    // the typed km: typed 60 km and no typed km at all build the same week 1.
    buildManual(60, 4);
    expect(weekMinutes()[0]).toBe(week1);
    buildManual(0, 4, { detectedWeeklyKm: undefined, weeklyVolumeConfirmed: undefined });
    expect(weekMinutes()[0]).toBe(week1);
    expect(week1).toBeLessThan(typedEasyMin);
  });

  it('typed 15 km starts lower than typed 50 km, in volume and in target', () => {
    buildManual(15, 4);
    const s15 = getState();
    expect(planEngineStateInputs(s15).archetype).toBe('consistent-runner');
    const min15 = weekMinutes();
    const target15 = [1, 2, 3, 5, 6].map(w => computePlannedWeekTarget(getState(), w));
    const planned15 = [2, 3, 5, 6].map(weekPlannedTSS);
    // Week 1 is held to the consistent-runner start, 15 x 1.05 km at easy pace.
    expect(min15[0]).toBeLessThanOrEqual(Math.round(startingWeeklyKm(15, 'consistent-runner') * s15.pac.e / 60));
    expect(target15[0]).toBe(Math.round(typedTSS(15) * 0.97));

    buildManual(50, 4);
    const min50 = weekMinutes();
    expect(min15[0]).toBeLessThan(min50[0]);
    [1, 2, 3, 5, 6].forEach((w, i) => expect(target15[i]).toBeLessThan(computePlannedWeekTarget(getState(), w)));
    [2, 3, 5, 6].forEach((w, i) => expect(planned15[i]).toBeLessThan(weekPlannedTSS(w)));
  });

  it('typed 50 km on 3 runs: the target follows the typed km, and the plan prices within it', () => {
    buildManual(50, 3);
    const target = Math.round(typedTSS(50) * 0.97);
    for (const w of [2, 3, 5, 6]) {
      expect(computePlannedWeekTarget(getState(), w)).toBe(target);
      expect(weekPlannedTSS(w)).toBeLessThanOrEqual(target);
      expect(weekPlannedTSS(w)).toBeGreaterThan(target * 0.8);
    }
  });

  it('a typed km builds the plan the same synced weekly km builds', () => {
    buildManual(30, 4);
    const typed = weekMinutes();
    expect(planEngineStateInputs(getState()).archetype).toBe('consistent-runner');
    buildSynced(30, 4);
    expect(getState().athleteArchetype?.archetype).toBe('consistent-runner');
    expect(weekMinutes()).toEqual(typed);
  });

  it('the forecast credits the ramp the plan builds from the typed km', () => {
    buildManual(15, 4);
    const s = getState();
    const typed = planForecastWeeklyKm(s, 4);
    // Same ramp a sync's classification would integrate...
    expect(typed).toBe(planForecastWeeklyKm({ ...s, weeklyVolumeConfirmed: undefined,
      athleteArchetype: { archetype: 'consistent-runner' } as SimulatorState['athleteArchetype'] }, 4));
    // ...below the flat full-plan peak credited when no ramp applies.
    expect(typed!).toBeLessThan(planForecastWeeklyKm({ ...s, weeklyVolumeConfirmed: undefined }, 4)!);
  });

  it('synced history overrides the typed km for the ramp and the target', () => {
    // Typed 15 km, then a sync wrote weekly history and its own classification.
    buildManual(15, 4, {
      historicWeeklyTSS: [180, 180, 180, 180, 180, 180, 180, 180], ctlBaseline: 170,
      athleteArchetype: { archetype: 'detrained-with-history' } as SimulatorState['athleteArchetype'],
    });
    expect(planEngineStateInputs(getState()).archetype).toBe('detrained-with-history');
    expect(computePlannedWeekTarget(getState(), 2)).toBe(Math.round(180 * 0.97));
    // With only the EMA (under 3 weeks of history), the EMA still wins.
    buildManual(15, 4, { historicWeeklyTSS: [120], ctlBaseline: 120 });
    expect(computePlannedWeekTarget(getState(), 2)).toBe(Math.round(120 * 0.97));
  });
});

/**
 * A typed km says nothing about how steady the athlete's weeks are, so typing
 * more km must never buy a slower ramp. Review finding (2026-10-09): reading the
 * missing week-to-week variability as 0 classified typed 50 km and more as
 * high-mileage (3% a week) while typed 45 km stayed consistent-runner (7%), so in
 * a 6-week marathon block (no logged runs, the 90 min no-data long-run start) the
 * long run peaked at 96 min for typed 50 and 60 km against 109 min for typed 45
 * km, and the forecast was slower.
 */
describe('typed weekly km in a marathon sharpening block: more km never shortens the build', () => {
  beforeEach(() => { resetState(); localStorageMock.clear(); });

  it('typed 45, 50 and 60 km: the long-run peak, the low-base note peak and the forecast never get worse as the km rise', () => {
    const read = (km: number) => {
      buildManual(km, 4, {}, 6);
      const s = getState();
      expect(s.sharpenBlock).toBeDefined();
      expect(s.forecastTime).toBeGreaterThan(0);
      const note = lowBaseMarathon('marathon', planDay(6, 6), s, 'intermediate');
      return {
        peakLongMin: Math.max(...plannedRunMinutesByWeek(runningPlanShapeInputs(s)).flat()),
        // No note: the block's long runs reach the marathon-readiness bar.
        notePeakMin: note ? note.peakLongMin : Number.POSITIVE_INFINITY,
        forecastSec: s.forecastTime as number,
      };
    };
    const rows = [45, 50, 60].map(read);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].peakLongMin).toBeGreaterThanOrEqual(rows[i - 1].peakLongMin);
      expect(rows[i].notePeakMin).toBeGreaterThanOrEqual(rows[i - 1].notePeakMin);
      expect(rows[i].forecastSec).toBeLessThanOrEqual(rows[i - 1].forecastSec);
    }
  });
});
