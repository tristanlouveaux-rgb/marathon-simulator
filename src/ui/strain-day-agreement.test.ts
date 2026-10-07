// @vitest-environment jsdom
/**
 * The Home strain ring and the strain page it opens show one number for the
 * same day, anywhere off UTC.
 *
 * Before: Home, Readiness and capacity strain looked up today's physiology
 * entry (steps, active minutes: the passive strain) by the UTC day, while the
 * strain page looked it up by the local day. Physiology entries are keyed by
 * local day (Apple via localDateKey, Garmin calendarDate), so west of UTC every
 * evening Home found no entry (0) while the strain page counted the day's
 * steps, and east of UTC every morning Home read yesterday's full step count.
 *
 * Now every strain surface calls computeDayStrainTSS, which reads the
 * activities and the physiology entry for the same local day.
 *
 * Fixed-offset zones with no DST: America/Phoenix = UTC-7,
 * Australia/Brisbane = UTC+10 (the local-date.test.ts convention).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// strain-view pulls in the Supabase client at import time; no network here.
vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { computeCapacityStrain } from '@/calculations/capacity-strain';
import { computeDayStrainTSS } from '@/calculations/fitness-model';
import { getStrainForDate } from './strain-view';
import { localDateKey } from '@/utils/local-date';
import type { PhysiologyDayEntry, SimulatorState, Week } from '@/types';

const PLAN_START = '2026-09-28'; // a Monday
const ORIGINAL_TZ = process.env.TZ;
function restoreTz(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

function emptyWeek(w: number): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0, garminActuals: {},
  } as unknown as Week;
}

function stateWith(currentWeek: number, history: PhysiologyDayEntry[]): SimulatorState {
  const s = getDefaultState();
  s.trackOnly = true;
  s.planStartDate = PLAN_START;
  s.w = currentWeek;
  s.wks = [emptyWeek(1), emptyWeek(2)];
  s.physiologyHistory = history;
  setState(s);
  return getMutableState();
}

const day = (date: string, steps: number, activeMinutes: number): PhysiologyDayEntry =>
  ({ date, steps, activeMinutes } as PhysiologyDayEntry);

afterEach(() => { vi.useRealTimers(); });

describe('west of UTC (America/Phoenix, UTC-7), Sunday evening', () => {
  beforeAll(() => { process.env.TZ = 'America/Phoenix'; });
  afterAll(restoreTz);

  it('capacity strain (Home ring, Readiness) equals the strain page for the same day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T03:00:00.000Z')); // Sunday 4 Oct 20:00 local, Monday UTC
    const today = localDateKey(new Date());
    expect(today).toBe('2026-10-04');
    const s = stateWith(1, [day('2026-10-04', 25000, 150)]);

    const page = getStrainForDate(today, s).actualTSS;
    expect(page).toBeGreaterThan(0); // the day's steps count as passive strain
    expect(computeCapacityStrain(s).todayTSS).toBe(page); // was 0: Home looked up Monday (UTC)
    expect(computeDayStrainTSS(s.wks[0], today, s.physiologyHistory, s.tssPerActiveMinute)).toBe(page);
  });
});

describe('east of UTC (Australia/Brisbane, UTC+10), Monday morning', () => {
  beforeAll(() => { process.env.TZ = 'Australia/Brisbane'; });
  afterAll(restoreTz);

  it('capacity strain reads today\'s steps, not yesterday\'s full count, and equals the strain page', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T21:00:00.000Z')); // Monday 5 Oct 07:00 local, Sunday UTC
    const today = localDateKey(new Date());
    expect(today).toBe('2026-10-05');
    const s = stateWith(2, [day('2026-10-04', 25000, 150), day('2026-10-05', 2000, 10)]);

    const page = getStrainForDate(today, s).actualTSS;
    const cs = computeCapacityStrain(s);
    expect(cs.todayTSS).toBe(page);
    // Yesterday's full count (what the UTC key read) is a different, larger number.
    const yesterday = computeDayStrainTSS(s.wks[1], '2026-10-04', s.physiologyHistory, s.tssPerActiveMinute);
    expect(yesterday).toBeGreaterThan(cs.todayTSS);
  });
});

describe('one strain computation', () => {
  it('Home, Readiness, capacity strain and the strain page call computeDayStrainTSS, never computeTodayStrainTSS directly', () => {
    const root = path.join(__dirname, '..');
    for (const rel of ['ui/home-view.ts', 'ui/readiness-view.ts', 'calculations/capacity-strain.ts', 'ui/strain-view.ts']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      expect(src, rel).toContain('computeDayStrainTSS(');
      expect(src, rel).not.toContain('computeTodayStrainTSS(');
    }
  });
});
