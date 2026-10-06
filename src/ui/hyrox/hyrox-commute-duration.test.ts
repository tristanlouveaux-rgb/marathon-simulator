// @vitest-environment jsdom
/**
 * HYROX commute runs carry a duration (cross-mode audit f3).
 *
 * Commute runs were generated as `${oneWayKm}km` with no estimatedDurationMin.
 * recordHxRunDone returns early without one, so Mark as Done on a commute added
 * nothing to weekly load, strain or ACWR (unlike a running-plan Mark as Done),
 * and the planned-day pricer fell back to 60 minutes (estimateTriWorkoutMin).
 *
 * Real generator, real detail modal (jsdom), real getPlannedDayTSSContext.
 * saveState and the plan-view re-render are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/ui/hyrox/plan-view', () => ({ renderHyroxPlanView: vi.fn() }));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { hyroxEasyRunPaceSecKm } from '@/workouts/hyrox-generators';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { openHyroxWorkoutDetail } from './workout-detail-modal';
import { getPlannedDayTSSContext } from '@/ui/planned-day-tss';
import type { SimulatorState, Workout } from '@/types/state';

const PLAN_START = '2026-09-28'; // a Monday
const ONE_WAY_KM = 6;

function hyroxCommuteState(runPaceSecKm?: number): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = PLAN_START;
  s.w = 1;
  s.tw = 16;
  s.commuteConfig = { enabled: true, distanceKm: ONE_WAY_KM, isBidirectional: true, commuteDaysPerWeek: 2 };
  s.hyroxConfig = {
    format: 'open_singles',
    athleteBand: band,
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    hyroxRunPaceSecKm: runPaceSecKm,
    generatorVersion: HYROX_GENERATOR_VERSION,
  };
  s.wks = generateHyroxPlan(s);
  return s;
}

const commutes = (s: SimulatorState, week = 1): Workout[] =>
  (s.wks[week - 1].triWorkouts ?? []).filter(w => (w as { commute?: boolean }).commute === true);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '';
});

describe('HYROX commute runs carry a duration at the generator easy pace', () => {
  it('every generated commute run has estimatedDurationMin = one-way km × easy pace', () => {
    const s = hyroxCommuteState();
    const expected = Math.round((ONE_WAY_KM * hyroxEasyRunPaceSecKm('intermediate')) / 60);
    expect(expected).toBeGreaterThan(0);
    for (const wk of s.wks) {
      const list = (wk.triWorkouts ?? []).filter(w => (w as { commute?: boolean }).commute === true);
      expect(list.length).toBe(4); // 2 days × morning + evening
      for (const w of list) expect(w.estimatedDurationMin).toBe(expected); // was undefined
    }
  });

  it('uses the athlete\'s HYROX run pace when set, as generateHyroxRun does', () => {
    const s = hyroxCommuteState(300);
    expect(commutes(s)[0].estimatedDurationMin).toBe(Math.round((ONE_WAY_KM * hyroxEasyRunPaceSecKm('intermediate', 300)) / 60));
    expect(hyroxEasyRunPaceSecKm('intermediate', 300)).toBe(360);
  });
});

describe('Mark as Done on a current-week commute', () => {
  it('writes an in-app record at the commute duration', () => {
    setState(hyroxCommuteState());
    const wk = getMutableState().wks[0];
    const commute = commutes(getMutableState())[0];

    openHyroxWorkoutDetail(commute, 0);
    (document.querySelector('#hx-detail-mark-done') as HTMLButtonElement).click();

    const rec = wk.garminActuals?.[commute.id!];
    expect(rec).toBeDefined(); // was none
    expect(rec!.durationSec).toBe(commute.estimatedDurationMin! * 60);
  });
});

describe('planned-day pricing of a commute', () => {
  it('prices the commute at its duration, not the 60-minute fallback', () => {
    const s = hyroxCommuteState();
    const commute = commutes(s)[0];
    const day = getPlannedDayTSSContext(s, 1).workoutsForDay(commute.dayOfWeek!);
    const priced = day.find(w => w.name === commute.n)!;
    expect(priced).toBeDefined();
    expect(priced.plannedDurationMin).toBe(commute.estimatedDurationMin); // was 60
    expect(priced.plannedDurationMin).not.toBe(60);
  });
});
