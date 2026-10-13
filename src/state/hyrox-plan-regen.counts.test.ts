/**
 * Generator v18 regen: stored session counts that equal the pre-v18 band
 * default move to the v18 default (review 2026-10-13). Before, an untouched
 * novice or intermediate state (3/2/1, 6 sessions) read one session above the
 * new default (3/1/1, 5) and gained an easy run every week, and the race
 * projection credited a weekly-volume bonus the athlete never chose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { getDefaultState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { applyHyroxGeneratorRegen, migratePreV18HyroxSessionCounts } from './hyrox-plan-regen';
import type { SimulatorState } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';

function storedState(band: AbilityBand, counts: { runs: number; stations: number; bricks: number }, version: number): SimulatorState {
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = '2026-09-28';
  s.w = 1;
  s.tw = 16;
  s.rw = counts.runs;
  s.epw = counts.runs + counts.stations + counts.bricks;
  s.hyroxConfig = {
    format: 'open_singles',
    athleteBand: band,
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: counts.runs,
    stationSessionsPerWeek: counts.stations,
    bricksPerWeek: counts.bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].max,
    generatorVersion: version,
  };
  s.wks = generateHyroxPlan(s);
  return s;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('v18 regen: pre-v18 default session counts', () => {
  it('an untouched novice or intermediate state (3/2/1) moves to the v18 default and gains no easy run', () => {
    for (const band of ['novice', 'intermediate'] as AbilityBand[]) {
      const s = storedState(band, { runs: 3, stations: 2, bricks: 1 }, 17);
      expect(applyHyroxGeneratorRegen(s)).toBe(true);
      const hx = s.hyroxConfig!;
      expect({ runs: hx.runsPerWeek, stations: hx.stationSessionsPerWeek, bricks: hx.bricksPerWeek }).toEqual(HYROX_WEEKLY_SESSIONS[band]);
      expect(s.epw).toBe(5);
      expect(s.rw).toBe(3);
      // Same plan as a fresh state at the v18 default.
      const fresh = storedState(band, HYROX_WEEKLY_SESSIONS[band], HYROX_GENERATOR_VERSION);
      expect(s.wks.map(wk => (wk.triWorkouts ?? []).length)).toEqual(fresh.wks.map(wk => (wk.triWorkouts ?? []).length));
    }
  });

  it('an untouched beginner state (2/2/1) moves to 2/1/1; total_beginner and the advanced tier keep their totals', () => {
    const b = storedState('beginner', { runs: 2, stations: 2, bricks: 1 }, 17);
    expect(migratePreV18HyroxSessionCounts(b)).toBe(true);
    expect(b.hyroxConfig!.stationSessionsPerWeek).toBe(1);
    expect(b.epw).toBe(4);
    const tb = storedState('total_beginner', { runs: 2, stations: 2, bricks: 0 }, 17);
    expect(migratePreV18HyroxSessionCounts(tb)).toBe(true);
    expect({ runs: tb.hyroxConfig!.runsPerWeek, stations: tb.hyroxConfig!.stationSessionsPerWeek, bricks: tb.hyroxConfig!.bricksPerWeek })
      .toEqual(HYROX_WEEKLY_SESSIONS.total_beginner);
    const adv = storedState('advanced', { runs: 3, stations: 2, bricks: 1 }, 17);
    expect(migratePreV18HyroxSessionCounts(adv)).toBe(false); // already the v18 default
  });

  it('counts the athlete chose on the slider are kept, and v18 states are never touched', () => {
    const chosen = storedState('intermediate', { runs: 4, stations: 2, bricks: 1 }, 17);
    expect(migratePreV18HyroxSessionCounts(chosen)).toBe(false);
    expect(chosen.hyroxConfig!.runsPerWeek).toBe(4);
    const current = storedState('intermediate', { runs: 3, stations: 2, bricks: 1 }, HYROX_GENERATOR_VERSION);
    expect(migratePreV18HyroxSessionCounts(current)).toBe(false);
    expect(current.hyroxConfig!.stationSessionsPerWeek).toBe(2);
  });
});
