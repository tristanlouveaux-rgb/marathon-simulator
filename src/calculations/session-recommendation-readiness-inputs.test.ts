/**
 * The session-generator caption reads readiness with the same history depth and
 * ACWR ceiling as the Home readiness ring (home-view buildReadinessRing).
 *
 * It used to pass weeksOfHistory = min(wks.length, 4), always >= 3 on a real
 * plan, so the ACWR hard floor applied in the caption weeks before the ring,
 * and it left acwrSafeUpper at the 1.30 default whatever the athlete's tier.
 *
 * Time is pinned at LOCAL noon in June 2026 (no daylight-saving change inside).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

// Wrap (not replace) computeReadiness so the inputs can be read back.
vi.mock('./readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./readiness')>();
  return { ...actual, computeReadiness: vi.fn(actual.computeReadiness) };
});

import { computeReadiness } from './readiness';
import { computeFitnessModel, computeReadinessACWR } from './fitness-model';
import { buildSessionRecommendation } from './session-recommendation';
import { setState } from '@/state/store';
import type { SimulatorState, Week } from '@/types';

const PLAN_START = '2026-06-01'; // Monday
const localNoon = (planDay: number) => new Date(2026, 5, 1 + planDay, 12, 0, 0, 0);
const dateKey = (planDay: number) => localNoon(planDay).toISOString().split('T')[0];
afterEach(() => { vi.useRealTimers(); vi.mocked(computeReadiness).mockClear(); });

function buildWeeks(minutesForDay: (planDay: number) => number): Week[] {
  const wks = Array.from({ length: 16 }, (_, i) => ({
    w: i + 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {},
  })) as unknown as Week[];
  for (let day = 0; day <= 60; day++) {
    const min = minutesForDay(day);
    if (min <= 0) continue;
    wks[Math.floor(day / 7)].garminActuals![`run-${day}`] = {
      garminId: `g-${day}`, startTime: `${dateKey(day)}T07:00:00.000Z`, distanceKm: 10,
      durationSec: min * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
      iTrimp: null, activityType: 'RUNNING',
    } as any;
  }
  return wks;
}

function state(overrides: Partial<SimulatorState>): SimulatorState {
  return {
    w: 3, tw: 16, v: 45, iv: 45, rpeAdj: 0, expectedFinal: 48, rd: 'marathon' as any, epw: 5, rw: 4,
    wkm: 50, pbs: {} as any, rec: null, lt: null, vo2: null, initialLT: null, initialVO2: null,
    initialBaseline: null, currentFitness: null, forecastTime: null, typ: 'balanced' as any, b: 1.06,
    pac: { e: 330 } as any, skip: [], timp: 0, physiologyHistory: [], historicWeeklyTSS: [],
    planStartDate: PLAN_START,
    ...overrides,
  } as SimulatorState;
}

/** History depth exactly as the Home readiness ring computes it. */
function homeRingWeeksOfHistory(s: SimulatorState): number {
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  return computeFitnessModel(s.wks ?? [], Math.max(0, s.w - 1), s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, undefined, (s as any).previousPlanWks).length;
}

const runSessionRec = (s: SimulatorState, planDay: number) => {
  vi.useFakeTimers();
  vi.setSystemTime(localNoon(planDay));
  setState(s);
  const rec = buildSessionRecommendation(s);
  const calls = vi.mocked(computeReadiness).mock.calls;
  const input = calls[calls.length - 1][0];
  return { rec, input };
};

describe('session-generator readiness inputs match the Home ring', () => {
  it('no ACWR hard floor with fewer than 3 completed weeks, as on the Home ring', () => {
    // Seeded athlete with a genuine spike from week 2 to today (plan day 14).
    const base = 7 * Math.round(40 * 1.15);
    const s = state({ w: 3, signalBBaseline: base, ctlBaseline: base, wks: buildWeeks(d => (d < 7 ? 40 : 120)) });
    const { rec, input } = runSessionRec(s, 14);
    expect(computeReadinessACWR(s).status).toBe('high');
    expect(input.weeksOfHistory).toBe(2);
    expect(input.weeksOfHistory).toBe(homeRingWeeksOfHistory(s));
    expect(rec.drivingSignal).not.toBe('acwr');
    expect(rec.readinessScore!).toBeGreaterThan(34); // HEAD: capped at 34 by the ACWR floor
  });

  it('counts archived weeks the way the ring does', () => {
    const base = 7 * Math.round(40 * 1.15);
    const archive = { planStartDate: '2026-04-06', weeks: buildWeeks(() => 0).slice(0, 8) };
    const s = state({ w: 2, signalBBaseline: base, ctlBaseline: base, wks: buildWeeks(() => 40), previousPlanWks: [archive] as any });
    const { input } = runSessionRec(s, 9);
    expect(input.weeksOfHistory).toBe(9); // 8 archived + 1 completed live week
    expect(input.weeksOfHistory).toBe(homeRingWeeksOfHistory(s));
  });

  it('passes the tier ACWR ceiling, not the 1.30 default', () => {
    const base = 7 * Math.round(40 * 1.15);
    const s = state({ w: 5, athleteTier: 'performance' as any, signalBBaseline: base, ctlBaseline: base, wks: buildWeeks(() => 40) });
    const { input } = runSessionRec(s, 34);
    expect(input.acwrSafeUpper).toBe(1.45);
    expect(input.acwrSafeUpper).toBe(computeReadinessACWR(s).safeUpper);
  });
});
