// @vitest-environment jsdom
/**
 * Passive step load is strain, not a session (ISSUE-406 (c)).
 *
 * Home built the coach's StrainContext with trainedToday = (today's strain
 * TSS > 0), and today's strain TSS includes passive step and active-minute
 * load. A morning walk before the day's session therefore read as a session
 * done: on a poor-sleep Tempo Run day Home said "Light session was
 * appropriate." instead of telling the athlete to ease the Tempo Run.
 * trainedToday now comes from hasTrainedOnDay (sessions only), the rule
 * deriveStrainContext already used, in every mode.
 *
 * Real generator, real Home render (jsdom).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getDefaultState, setState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { renderHomeView } from './home-view';
import { computeDayStrainTSS } from '@/calculations/fitness-model';
import { hasTrainedOnDay } from '@/calculations/daily-coach';
import { localDateKey } from '@/utils/local-date';
import type { SimulatorState } from '@/types/state';

const PLAN_MONDAY = new Date(2026, 8, 28, 12, 0, 0); // Monday 28 Sep 2026, local noon

function hyroxState(): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = '2026-09-28';
  s.w = 1;
  s.tw = 16;
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
    generatorVersion: HYROX_GENERATOR_VERSION,
  } as SimulatorState['hyroxConfig'];
  s.wks = generateHyroxPlan(s);
  return s;
}

function sentenceText(): string {
  return (document.getElementById('app-root')!.textContent ?? '').replace(/\s+/g, ' ');
}

let state: SimulatorState;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
  state = hyroxState();
  const tempo = (state.wks[0].triWorkouts ?? []).find(w => w.t === 'hyrox_run_tempo');
  expect(tempo, 'week 1 holds a Tempo Run').toBeDefined();
  // Today is the Tempo Run's day, local noon.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(PLAN_MONDAY.getTime() + (tempo!.dayOfWeek ?? 0) * 86400000));
  const today = localDateKey(new Date());
  // Poor sleep and a morning of walking, no session logged yet.
  state.physiologyHistory = [{ date: today, sleepScore: 40, steps: 9000, activeMinutes: 45 } as any];
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Home coach line with passive step load before the session', () => {
  it('the steps are strain but not a session', () => {
    const today = localDateKey(new Date());
    expect(computeDayStrainTSS(state.wks[0], today, state.physiologyHistory, state.tssPerActiveMinute)).toBeGreaterThan(0);
    expect(hasTrainedOnDay(state.wks[0], today)).toBe(false);
  });

  it('Home tells the athlete to ease the Tempo Run, not that a light session was the right call', () => {
    setState(state);
    renderHomeView();
    const text = sentenceText();
    // Home's StrainContext carries no todayPlannedWorkout, so the coach names
    // "the session" there (deriveStrainContext names it; separate gap).
    expect(text).toMatch(/Sleep 40\/100 last night\. Consider converting (the session|Tempo Run) to easy effort\./);
    expect(text).not.toContain('Light session was appropriate');
    expect(text).not.toContain('Light session was the right call');
  });

  it('a logged session today still reads as trained', () => {
    const wk = state.wks[0];
    const today = localDateKey(new Date());
    wk.garminActuals = {
      'garmin-walk-1': {
        garminId: 'walk-1', startTime: new Date().toISOString(), durationSec: 1800, distanceKm: 2.5,
        avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, activityType: 'WALKING',
      } as any,
    };
    expect(hasTrainedOnDay(wk, today)).toBe(true);
    setState(state);
    renderHomeView();
    expect(sentenceText()).toContain('Sleep 40/100. Light session was appropriate.');
  });
});
