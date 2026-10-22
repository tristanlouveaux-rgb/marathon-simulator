// @vitest-environment jsdom
/**
 * "High load on a rest day" counts logged sessions only (D4, 2026-10-21).
 *
 * Home set its rest-day overreach flag from the strain ring's TSS, which
 * includes passive step and active-minute load, so a walking-heavy rest day
 * read "High load on a rest day" on Home while the Readiness and coach pages,
 * which read sessions only, said nothing of it. Every surface now calls
 * isRestDayOverreached (fitness-model.ts): sessions only, against the plan's
 * per-session average. A logged walk is a session and still counts.
 *
 * Real HYROX generator, real Home and Readiness renders (jsdom).
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
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { REST_DAY_OVERREACH_SENTENCE } from '@/calculations/capacity-strain';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { renderHomeView } from './home-view';
import { renderReadinessView } from './readiness-view';
import { getStrainForDate } from './strain-view';
import { computeDayStrainTSS, isRestDayOverreached, REST_DAY_OVERREACH_RATIO } from '@/calculations/fitness-model';
import { computeDailyCoach } from '@/calculations/daily-coach';
import { getPlannedDayTSSContext } from './planned-day-tss';
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

const text = () => (document.getElementById('app-root')!.textContent ?? '').replace(/\s+/g, ' ');

let state: SimulatorState;
let today: string;
let perSessionAvg: number;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
  state = hyroxState();
  const ctx = getPlannedDayTSSContext(state, 1);
  const restDow = [0, 1, 2, 3, 4, 5, 6].find(d => ctx.plannedTSSForDay(d) === 0);
  expect(restDow, 'week 1 holds a rest day').toBeDefined();
  perSessionAvg = ctx.perSessionAvg;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(PLAN_MONDAY.getTime() + restDow! * 86400000));
  today = localDateKey(new Date());
  // A long walking day: 22,000 steps and 200 active minutes, no session logged.
  state.physiologyHistory = [{ date: today, sleepScore: 80, steps: 22000, activeMinutes: 200 } as any];
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('rest day with heavy passive load and no session', () => {
  it('the passive load alone is over the old threshold, but no surface flags it', () => {
    const strain = computeDayStrainTSS(state.wks[0], today, state.physiologyHistory, state.tssPerActiveMinute);
    expect(strain).toBeGreaterThan(perSessionAvg * REST_DAY_OVERREACH_RATIO); // the old Home flag fired here
    expect(isRestDayOverreached(state.wks[0], today, true, perSessionAvg)).toBe(false);
    setState(state);
    expect(computeDailyCoach(state).primaryMessage).not.toContain('High load on a rest day');
    expect(getStrainForDate(today, state).isOverreaching).toBe(false);
    renderHomeView();
    expect(text()).not.toContain('High load on a rest day');
    document.body.innerHTML = '<div id="app-root"></div>';
    renderReadinessView();
    expect(text()).not.toContain('High load on a rest day');
  });
});

describe('rest day with a logged session over the threshold', () => {
  it('a logged 90-minute walk counts as a session: Home, the coach and the strain page flag it', () => {
    // A synced walk filed as an adhoc entry only (a Garmin import with no
    // activity record): history, not plan, so the day stays a rest day.
    state.wks[0].adhocWorkouts = [{ id: 'garmin-walk-1', t: 'cross', n: 'Walk', d: '90min', r: 5, rpe: 5, garminTimestamp: new Date().toISOString() } as any];
    expect(isRestDayOverreached(state.wks[0], today, true, perSessionAvg)).toBe(true);
    setState(state);
    expect(computeDailyCoach(state).primaryMessage).toBe('High load on a rest day. Recovery for upcoming sessions is impaired.');
    expect(getStrainForDate(today, state).isOverreaching).toBe(true);
    renderHomeView();
    expect(text()).toContain('High load on a rest day.');
  });

  it('no plan (per-session average 0) never flags', () => {
    expect(isRestDayOverreached(state.wks[0], today, true, 0)).toBe(false);
  });
});

// Triathlon Home kept the triathlon readiness sentence on a rest day with a
// logged session over the threshold ("153 TSS logged today. Keep training
// consistently...") while Readiness said "Overreaching. High load on a rest
// day." Home and the Readiness hero now lead with the coach's rest-day line
// (2026-10-22, E2). Ironman and the bike-only (cycling) plan.
function triState(distance: 'ironman' | '70.3', bikeOnly: boolean, hours: number): SimulatorState {
  const s = {
    ...getDefaultState(),
    eventType: 'triathlon',
    trackOnly: false,
    planStartDate: '2026-09-28',
    w: 1,
    tw: 24,
    v: 50,
    pac: { e: 300, t: 250, i: 230, m: 275, r: 200 },
    wks: [],
    triConfig: {
      distance,
      ...(bikeOnly ? { disciplines: ['bike'] } : {}),
      timeAvailableHoursPerWeek: hours,
      volumeSplit: bikeOnly ? { swim: 0, bike: 1, run: 0 } : { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: true, ftp: 220 },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 24,
    },
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  return s;
}

describe('triathlon: rest day with a logged session over the threshold', () => {
  for (const [label, distance, bikeOnly, hours] of [['Ironman', 'ironman', false, 8], ['cycling (bike only)', '70.3', true, 6]] as const) {
    it(`${label}: Home and the Readiness hero lead with the rest-day overreach line`, () => {
      const s = triState(distance, bikeOnly, hours);
      const ctx = getPlannedDayTSSContext(s, 1);
      const restDow = [0, 1, 2, 3, 4, 5, 6].find(d => ctx.plannedTSSForDay(d) === 0);
      expect(restDow, 'week 1 holds a rest day').toBeDefined();
      vi.setSystemTime(new Date(PLAN_MONDAY.getTime() + restDow! * 86400000));
      const day = localDateKey(new Date());
      s.physiologyHistory = [{ date: day, sleepScore: 80 } as any];
      s.wks[0].adhocWorkouts = [...(s.wks[0].adhocWorkouts ?? []), { id: 'garmin-walk-1', t: 'cross', n: 'Walk', d: '90min', r: 5, rpe: 5, garminTimestamp: new Date().toISOString() } as any];
      expect(isRestDayOverreached(s.wks[0], day, true, ctx.perSessionAvg)).toBe(true);
      setState(s);
      expect(computeDailyCoach(s).primaryMessage).toBe(REST_DAY_OVERREACH_SENTENCE);
      document.body.innerHTML = '<div id="app-root"></div>';
      renderHomeView();
      expect(text()).toContain(REST_DAY_OVERREACH_SENTENCE);
      document.body.innerHTML = '<div id="app-root"></div>';
      renderReadinessView();
      expect(text()).toContain(REST_DAY_OVERREACH_SENTENCE);
      expect(text()).toContain('High load on a rest day. This level of activity impairs recovery');
    });
  }
});
