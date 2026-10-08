import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { raceDayPlanDurability, raceDayDurabilityMultiplier, type RaceDayPlanState } from './race-day-durability';
import {
  plannedRaceDayDurability, applyLongRunCap, countQualifyingLongRuns, getRunDurationsBetweenSec,
  getRunDurationsSec, DURABILITY_WINDOW_WEEKS, LONG_RUN_THRESHOLD_SEC,
} from './run-durability';
import { calculateLiveForecast } from './predictions';
import {
  planWeekSessions, plannedRunMinutesByWeek, runningPlanShapeInputs, type PlanContext,
} from '@/workouts/plan_engine';
import { computePlanPhases } from '@/workouts/phases';
import type { TrainingPhase } from '@/types';

/**
 * The race-day forecast judges long-run durability on the runs the PLAN
 * prescribes in the 12 weeks that end with race week (race-day-durability.ts).
 * Before 2026-10-07 the forecast dropped the durability cap on the assumption
 * that "the plan delivers the required long runs before race day", which the
 * 10% long-run rule, the weekly budget and the half/10K ramp all make false.
 */

const DAY_MS = 24 * 3600 * 1000;

function planState(over: Partial<RaceDayPlanState> = {}): RaceDayPlanState {
  return {
    rw: 4, rd: 'marathon', typ: 'Balanced', tw: 14, v: 38,
    pac: { e: 330 } as RaceDayPlanState['pac'],
    wks: [],
    onboarding: { experienceLevel: 'novice', weeklyTrainingHours: 4 } as RaceDayPlanState['onboarding'],
    continuousMode: false,
    detectedWeeklyKm: 15,
    wkm: 15,
    athleteArchetype: { archetype: 'detrained-with-history' } as RaceDayPlanState['athleteArchetype'],
    eventType: 'running',
    trackOnly: false,
    planStartDate: '2026-09-07',
    onboardingRunHistory: [],
    ...over,
  };
}

/** What the plan prescribes week by week, straight from planWeekSessions. */
function engineRunMinutes(s: RaceDayPlanState): number[][] {
  const inputs = runningPlanShapeInputs(s);
  const phases = computePlanPhases(s.tw).map(p => p.ph as TrainingPhase);
  const out: number[][] = [];
  for (let k = 1; k <= s.tw; k++) {
    const ctx: PlanContext = { ...inputs, weekIndex: k, phase: phases[k - 1] };
    out.push(planWeekSessions(ctx).map(i => i.totalMinutes));
  }
  return out;
}

beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { vi.restoreAllMocks(); });

describe('plannedRunMinutesByWeek reads exactly what the plan prescribes', () => {
  for (const [label, over] of [
    ['budget-bound marathon (detrained 15 km, novice, 4 h)', {}],
    ['established marathon (consistent 40 km, intermediate, no target)', {
      detectedWeeklyKm: 40, athleteArchetype: { archetype: 'consistent-runner' },
      onboarding: { experienceLevel: 'intermediate' }, v: 45, tw: 16,
    }],
    ['half, 8 weeks, no archetype', { rd: 'half', tw: 8, detectedWeeklyKm: undefined, athleteArchetype: undefined }],
  ] as Array<[string, Partial<RaceDayPlanState>]>) {
    it(label, () => {
      const s = planState(over);
      expect(plannedRunMinutesByWeek(runningPlanShapeInputs(s))).toEqual(engineRunMinutes(s));
    });
  }
});

describe('plannedRaceDayDurability (pure)', () => {
  it('reads only the final DURABILITY_WINDOW_WEEKS weeks of the plan', () => {
    const weeks = Array.from({ length: 16 }, (_, i) => (i === 0 ? [200, 40] : [100, 40]));
    const r = plannedRaceDayDurability(weeks, 'marathon');
    expect(r.longestRunSec).toBe(100 * 60);
    expect(DURABILITY_WINDOW_WEEKS).toBe(12);
  });

  it('is applyLongRunCap over the window: same longest run, same qualifying count', () => {
    const weeks = [[60, 30], [120, 40], [125, 40], [130, 45], [90, 40]];
    const secs = weeks.flat().map(m => m * 60);
    const expected = applyLongRunCap(Math.max(...secs), 'marathon', countQualifyingLongRuns(secs, 'marathon'));
    expect(plannedRaceDayDurability(weeks, 'marathon')).toEqual(expected);
    expect(expected.multiplier).toBeGreaterThan(1);
  });

  it('adds pre-plan logged runs only when the plan is shorter than the window', () => {
    const short = Array.from({ length: 8 }, () => [100, 40]);
    expect(plannedRaceDayDurability(short, 'marathon', [170 * 60]).multiplier).toBe(1);
    const long = Array.from({ length: 12 }, () => [100, 40]);
    expect(plannedRaceDayDurability(long, 'marathon', [170 * 60]).multiplier).toBeGreaterThan(1);
  });
});

describe('getRunDurationsBetweenSec', () => {
  it('keeps [from, to) and matches getRunDurationsSec for an open-ended window', () => {
    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString();
    const s = {
      wks: [{ garminActuals: {
        a: { startTime: at(3), activityType: 'RUNNING', durationSec: 3000 },
        b: { startTime: at(20), activityType: 'RUNNING', durationSec: 5000 },
        c: { startTime: at(20), activityType: 'CYCLING', durationSec: 9000 },
      } }],
      onboardingRunHistory: [{ startTime: at(100), durSec: 7000 }],
    };
    expect(getRunDurationsBetweenSec(s, now - 30 * DAY_MS, now - 10 * DAY_MS)).toEqual([5000]);
    expect(getRunDurationsBetweenSec(s, now - 12 * 7 * DAY_MS, Infinity).sort()).toEqual(getRunDurationsSec(s, 12).sort());
  });
});

describe('raceDayPlanDurability (from state)', () => {
  it('is null without a running race plan', () => {
    expect(raceDayPlanDurability(planState({ continuousMode: true }))).toBeNull();
    expect(raceDayPlanDurability(planState({ trackOnly: true }))).toBeNull();
    expect(raceDayPlanDurability(planState({ eventType: 'triathlon' }))).toBeNull();
    expect(raceDayPlanDurability(planState({ eventType: 'hyrox' }))).toBeNull();
    expect(raceDayPlanDurability(planState({ tw: 0 }))).toBeNull();
    expect(raceDayPlanDurability(planState({ rw: 0 }))).toBeNull();
    expect(raceDayDurabilityMultiplier(planState({ continuousMode: true }))).toBeUndefined();
  });

  it('budget-bound marathon: the plan stays under the 165-min threshold, so race day carries a penalty', () => {
    const s = planState();
    const r = raceDayPlanDurability(s)!;
    const planLongest = Math.max(...engineRunMinutes(s).slice(-DURABILITY_WINDOW_WEEKS).flat());
    expect(r.longestRunSec).toBe(planLongest * 60);
    expect(planLongest * 60).toBeLessThan(LONG_RUN_THRESHOLD_SEC.marathon);
    expect(r.multiplier).toBeGreaterThan(1);
    expect(r.limitingFactor).toBe('long_run_shortfall');
  });

  it('established marathon plan that builds to the threshold: no race-day penalty', () => {
    const s = planState({
      detectedWeeklyKm: 40, athleteArchetype: { archetype: 'consistent-runner' } as RaceDayPlanState['athleteArchetype'],
      onboarding: { experienceLevel: 'intermediate' } as RaceDayPlanState['onboarding'], v: 45, tw: 16,
    });
    const r = raceDayPlanDurability(s)!;
    expect(r.longestRunSec).toBeGreaterThanOrEqual(LONG_RUN_THRESHOLD_SEC.marathon);
    expect(r.multiplier).toBe(1);
  });

  it('plan shorter than the window: a long run logged in the pre-plan part of the window counts', () => {
    const planStart = Date.parse('2026-09-07');
    const run = (weeksBefore: number) => [{ startTime: new Date(planStart - weeksBefore * 7 * DAY_MS).toISOString(), durSec: 170 * 60, distKm: 30, activityType: 'RUNNING' }];
    const base = { tw: 8, rd: 'marathon' as const };
    // 8-week plan: the 4 weeks before plan start are inside race day's 12-week window.
    expect(raceDayPlanDurability(planState({ ...base, onboardingRunHistory: run(2) }))!.multiplier).toBe(1);
    expect(raceDayPlanDurability(planState({ ...base, onboardingRunHistory: run(5) }))!.multiplier).toBeGreaterThan(1);
  });
});

describe('calculateLiveForecast applies the race-day durability multiplier', () => {
  const params = {
    currentVdot: 45, targetDistance: 'marathon' as const, weeksRemaining: 14, sessionsPerWeek: 4,
    runnerType: 'Balanced' as const, experienceLevel: 'intermediate', blendedAnchorSec: 4 * 3600,
  };
  it('multiplies the forecast time; omitted or 1 leaves it unchanged', () => {
    const base = calculateLiveForecast(params).forecastTime;
    expect(calculateLiveForecast({ ...params, raceDayDurabilityMultiplier: 1 }).forecastTime).toBe(base);
    expect(calculateLiveForecast({ ...params, raceDayDurabilityMultiplier: 1.03 }).forecastTime).toBeCloseTo(base * 1.03, 6);
  });
});
