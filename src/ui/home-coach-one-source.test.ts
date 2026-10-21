// @vitest-environment jsdom
/**
 * Home's coach line comes from the coach page's source (D8, 2026-10-21).
 *
 * Home built its own StrainContext: no today's planned workout, so its line
 * said "Consider converting the session to easy effort." where the coach page
 * named the Tempo Run, and its session TSS included passive step load, so a
 * walking morning on a planned day could read "Solid session today (N TSS)."
 * before the session. Home now passes deriveStrainContext(s), the context
 * computeDailyCoach derives for the coach and Readiness pages.
 *
 * Real generators and resolver, real Home render (jsdom). HYROX and running
 * reach this line; Just-Track gets the same coach call. Triathlon and cycling
 * show the triathlon readiness sentence on Home instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getDefaultState, setState, resetState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { renderHomeView } from './home-view';
import { computeDailyCoach, deriveStrainContext } from '@/calculations/daily-coach';
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

function runningState(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    trackOnly: false,
    planStartDate: '2026-09-28',
    w: 1,
    tw: 18,
    rw: 4,
    rd: 'marathon',
    typ: 'balanced',
    v: 45,
    gs: 0,
    pac: { e: 330 },
    wks: [{ ph: 'base', rated: {}, skip: [] }],
  } as unknown as SimulatorState;
}

const text = () => (document.getElementById('app-root')!.textContent ?? '').replace(/\s+/g, ' ');

/** Fake today to the first day of week 1 whose planned session is hard. */
function onFirstHardDay(s: SimulatorState): string {
  const ctx = getPlannedDayTSSContext(s, 1);
  const dow = [0, 1, 2, 3, 4, 5, 6].find(d => ctx.workoutsForDay(d).some(w => w.isHard));
  expect(dow, 'week 1 holds a hard session').toBeDefined();
  vi.setSystemTime(new Date(PLAN_MONDAY.getTime() + dow! * 86400000));
  return ctx.workoutsForDay(dow!).find(w => w.isHard)!.name;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
  resetState();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

for (const [mode, build] of [['HYROX', hyroxState], ['running', runningState]] as const) {
  describe(`${mode}: Home's coach line is the coach page's`, () => {
    it('poor sleep on a hard day names the planned session, the same sentence on both', () => {
      const s = build();
      setState(s);
      const name = onFirstHardDay(s);
      s.physiologyHistory = [{ date: localDateKey(new Date()), sleepScore: 40 } as any];
      const coachPage = computeDailyCoach(s).primaryMessage;
      expect(coachPage).toBe(`Sleep 40/100 last night. Consider converting ${name} to easy effort.`);
      renderHomeView();
      expect(text()).toContain(coachPage);
      expect(text()).not.toContain('converting the session');
    });

    it('a walking morning before the session is not a session done', () => {
      const s = build();
      setState(s);
      onFirstHardDay(s);
      s.physiologyHistory = [{ date: localDateKey(new Date()), sleepScore: 80, steps: 22000, activeMinutes: 200 } as any];
      const ctx = deriveStrainContext(s);
      expect(ctx.trainedToday).toBe(false);
      expect(ctx.actualTSS).toBe(0);
      expect(ctx.strainTSS!).toBeGreaterThan(0); // the steps still gate the readiness strain input
      renderHomeView();
      expect(text()).not.toMatch(/(Solid|Big) session today/);
      expect(text()).toContain(computeDailyCoach(s).primaryMessage);
    });
  });
}

describe('Just-Track: Home and the coach read one context', () => {
  it('the Home sentence is the coach page sentence', () => {
    const s = { ...hyroxState(), trackOnly: true } as SimulatorState;
    setState(s);
    vi.setSystemTime(PLAN_MONDAY);
    s.physiologyHistory = [{ date: localDateKey(new Date()), sleepScore: 40 } as any];
    renderHomeView();
    expect(text()).toContain(computeDailyCoach(s).primaryMessage);
  });
});

describe('HYROX long run is a hard day on the coach line (D13)', () => {
  it('poor sleep on the long-run day: the hard-day sentence names it', () => {
    const s = hyroxState();
    setState(s);
    const lr = (s.wks[0].triWorkouts ?? []).find(w => w.t === 'hyrox_run_easy' && (w as any).longRun);
    expect(lr, 'week 1 holds a long run').toBeDefined();
    vi.setSystemTime(new Date(PLAN_MONDAY.getTime() + (lr!.dayOfWeek ?? 0) * 86400000));
    s.physiologyHistory = [{ date: localDateKey(new Date()), sleepScore: 40 } as any];
    const ctx = deriveStrainContext(s);
    expect(ctx.todayIsHard).toBe(true);
    expect(computeDailyCoach(s).primaryMessage).toBe(`Sleep 40/100 last night. Consider converting ${lr!.n} to easy effort.`);
  });

  it('the day before the long run: the look-ahead carries its plan name', () => {
    const s = hyroxState();
    setState(s);
    const lr = (s.wks[0].triWorkouts ?? []).find(w => w.t === 'hyrox_run_easy' && (w as any).longRun);
    expect(lr?.dayOfWeek, 'the long run is not on Monday').toBeGreaterThan(0);
    vi.setSystemTime(new Date(PLAN_MONDAY.getTime() + (lr!.dayOfWeek! - 1) * 86400000));
    const hardTomorrow = getPlannedDayTSSContext(s, 1).workoutsForDay(lr!.dayOfWeek!).filter(w => w.isHard);
    const ctx = deriveStrainContext(s);
    expect(ctx.upcomingHard?.whenLabel).toBe('tomorrow');
    expect(ctx.upcomingHard?.name).toBe(hardTomorrow[0].name);
    if (hardTomorrow.length === 1) expect(ctx.upcomingHard?.name).toBe(lr!.n);
  });
});
