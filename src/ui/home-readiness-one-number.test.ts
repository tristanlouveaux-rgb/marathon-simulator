// @vitest-environment jsdom
/**
 * The Home readiness card shows one TSS number for today (2026-10-22).
 *
 * After D8, Home's coach context counts logged sessions only, so running and
 * HYROX quoted session TSS in the post-session sentence ("Solid session today
 * (44 TSS).") beside a Strain ring that adds step and active-minute load (71).
 * Triathlon quoted the ring's number. The sentence now quotes the ring's number
 * in every mode (postSessionSentence: "Solid session today. 71 TSS logged.")
 * while the running and HYROX tiers stay gated on sessions.
 *
 * Real generators and resolver, real Home render (jsdom). A planned day with a
 * synced session at 1.1x the plan plus 14,000 steps.
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
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { TL_PER_MIN } from '@/constants';
import { renderHomeView } from './home-view';
import { getPlannedDayTSSContext } from './planned-day-tss';
import { computeTodaySignalBTSS } from '@/calculations/fitness-model';
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

function triState(): SimulatorState {
  const s = {
    ...getDefaultState(),
    eventType: 'triathlon',
    trackOnly: false,
    planStartDate: '2026-09-28',
    w: 1,
    tw: 20,
    v: 50,
    pac: { e: 300, t: 250, i: 230, m: 275, r: 200 },
    wks: [],
    triConfig: {
      distance: '70.3',
      timeAvailableHoursPerWeek: 12,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: true, ftp: 220 },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 20,
    },
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  return s;
}

/** Today = the first planned day of week 1; log a synced session at 1.1x its
 *  planned TSS (HR-less, unrated: minutes x TL_PER_MIN[5]) and 14,000 steps. */
function sessionDayWithSteps(s: SimulatorState): { sessionTSS: number } {
  const ctx = getPlannedDayTSSContext(s, 1);
  const dow = [0, 1, 2, 3, 4, 5, 6].find(d => ctx.plannedTSSForDay(d) > 0);
  expect(dow, 'week 1 holds a planned day').toBeDefined();
  vi.setSystemTime(new Date(PLAN_MONDAY.getTime() + dow! * 86400000 + 6 * 3600000)); // 18:00
  const planned = ctx.plannedTSSForDay(dow!);
  const minutes = Math.round((1.1 * planned) / TL_PER_MIN[5]);
  const start = new Date(PLAN_MONDAY.getTime() + dow! * 86400000 - 4 * 3600000); // 08:00
  const wk = s.wks[0];
  wk.garminActuals = {
    ...(wk.garminActuals ?? {}),
    'garmin-sync-1': {
      garminId: 'sync-1', startTime: start.toISOString(), durationSec: minutes * 60, distanceKm: 0,
      avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, activityType: 'OTHER',
    } as any,
  };
  s.physiologyHistory = [{ date: localDateKey(new Date()), sleepScore: 80, steps: 14000 } as any];
  return { sessionTSS: computeTodaySignalBTSS(wk, localDateKey(new Date())) };
}

const ringTSS = (): number => {
  const m = (document.getElementById('home-strain-ring')!.textContent ?? '').match(/(\d+)\s*TSS/);
  expect(m, 'the Strain ring shows a TSS number').not.toBeNull();
  return Number(m![1]);
};
const postSessionLine = (): string | undefined =>
  Array.from(document.querySelectorAll('p'))
    .map(p => (p.textContent ?? '').replace(/\s+/g, ' ').trim())
    .find(t => /(Big|Solid) session today|Good training today|TSS logged/.test(t));

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app-root"></div>';
  resetState();
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

for (const [mode, build] of [['running', runningState], ['HYROX', hyroxState], ['triathlon', triState]] as const) {
  describe(`${mode}: one TSS number for today on the Home card`, () => {
    it('the post-session sentence quotes the Strain ring\'s number', () => {
      const s = build();
      setState(s);
      const { sessionTSS } = sessionDayWithSteps(s);
      renderHomeView();
      const ring = ringTSS();
      expect(ring, 'the steps add load beyond the session').toBeGreaterThan(sessionTSS);
      const line = postSessionLine();
      expect(line, 'the session at 1.1x plan prints the post-session line').toBeDefined();
      const quoted = [...line!.matchAll(/(\d+) TSS/g)].map(m => Number(m[1]));
      expect(quoted.length).toBeGreaterThan(0);
      for (const n of quoted) expect(n).toBe(ring);
    });
  });
}
