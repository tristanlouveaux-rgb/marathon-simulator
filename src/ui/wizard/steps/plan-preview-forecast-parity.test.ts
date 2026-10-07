// @vitest-environment jsdom
/**
 * The onboarding preview hero equals the forecast the built plan carries
 * (design v4 Q18, approved default; review 2026-10-07).
 *
 * Before: forecastForSessions read getPlanPrescribedMeanWeeklyKm(sessions, rd)
 * with no ramp context, the flat full-plan peak (52.8 km for a 4-run
 * marathon), while the plan's forecast integrates the ramp from the runner's
 * current volume over the training weeks and taper. A 6-week marathon block at
 * 15 km a week previewed 255 s faster than the plan's forecast; a 3-week half
 * at 20 km 79 s; a 16-week marathon at 25 km 93 s. Both now read
 * planForecastWeeklyKm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { initializeSimulator } from '@/state/initialization';
import { getMutableState, getState, resetState } from '@/state/store';
import { forecastForSessions } from './plan-preview-v2';
import { planForecastWeeklyKm } from '@/calculations/blended-fitness';
import { getPlanPrescribedMeanWeeklyKm } from '@/calculations/training-horizon';
import type { OnboardingState } from '@/types/onboarding';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 7, 10, 0)); // Wednesday 7 October 2026
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Build a plan the way the wizard does, from a runner at `km` a week whose longest recent run is `longKm`. */
function build(rd: 'marathon' | 'half', raceISO: string, weeks: number, km: number, longKm: number) {
  resetState();
  const m = getMutableState() as any;
  m.detectedWeeklyKm = km;
  m.weeklyVolumeConfirmed = true;
  m.athleteArchetype = { archetype: 'consistent-runner' };
  m.onboardingRunHistory = [{ startTime: new Date(Date.now() - 5 * 86400000).toISOString(), distKm: longKm, durSec: longKm * 330, activityType: 'RUNNING' }];
  const r = initializeSimulator({
    trainingMode: 'running', trainingForEvent: true, raceDistance: rd, runsPerWeek: 4, pbs: { k10: 2700 },
    experienceLevel: 'intermediate', customRaceDate: raceISO, planDurationWeeks: weeks,
  } as OnboardingState);
  expect(r.success).toBe(true);
  return getState();
}

const CASES = [
  { label: '6-week marathon block, 15 km a week', rd: 'marathon' as const, race: '2026-11-15', weeks: 6, km: 15, longKm: 10, block: true },
  { label: '3-week half block, 20 km a week', rd: 'half' as const, race: '2026-10-25', weeks: 3, km: 20, longKm: 12, block: true },
  { label: '16-week marathon, 25 km a week', rd: 'marathon' as const, race: '2027-01-24', weeks: 16, km: 25, longKm: 15, block: false },
];

describe('the preview hero equals the built plan\'s forecast (s.forecastTime)', () => {
  for (const c of CASES) {
    it(c.label, () => {
      const s = build(c.rd, c.race, c.weeks, c.km, c.longKm);
      expect(!!s.sharpenBlock).toBe(c.block);
      const sessions = (s.epw || s.rw || 4) + (s.commuteConfig?.enabled ? (s.commuteConfig.commuteDaysPerWeek ?? 0) : 0);
      // The ramp context is in play: the forecast volume sits below the flat full-plan peak.
      expect(planForecastWeeklyKm(s, sessions)!).toBeLessThan(getPlanPrescribedMeanWeeklyKm(sessions, s.rd)!);
      expect(forecastForSessions(s, sessions)).toBeCloseTo(s.forecastTime!, 6);
    });
  }
});
