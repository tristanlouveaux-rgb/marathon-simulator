// @vitest-environment jsdom
/**
 * restoreHistoryFromServer files the recovered activities by the athlete's
 * LOCAL calendar day (decision 2026-10-06), like weekIndexForDate.
 *
 * Before: the archive anchor came from the first row's UTC day
 * (`start_time.split('T')[0]`) and each row's week from its ms offset to a
 * local-noon Monday. West of UTC a first activity on Sunday evening anchored
 * the archive on the next Monday and was dropped at index -1, as was every
 * Monday-morning row before noon. East of UTC an early-Monday first activity
 * anchored the archive a week early.
 *
 * Fixed-offset zones with no DST: America/Phoenix = UTC-7,
 * Australia/Brisbane = UTC+10 (the local-date.test.ts convention).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { SimulatorState } from '@/types';
import { getDefaultState } from '@/state/store';

let mockState: SimulatorState;
let rows: Array<Record<string, unknown>> = [];

vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return {
    ...actual,
    getMutableState: () => mockState,
    getState: () => mockState,
    saveState: vi.fn(),
  };
});

vi.mock('./supabaseClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./supabaseClient')>();
  const query = {
    select: () => query,
    eq: () => query,
    gte: () => query,
    order: async () => ({ data: rows, error: null }),
  };
  return {
    ...actual,
    supabase: {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
      from: () => query,
    },
  };
});

vi.mock('./activitySync', () => ({
  processPendingCrossTraining: vi.fn(),
  resetPendingModalGuard: vi.fn(),
}));

import { restoreHistoryFromServer } from './stravaSync';

const ORIGINAL_TZ = process.env.TZ;
function restoreTz(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

const row = (garmin_id: string, start_time: string) => ({
  garmin_id, start_time, activity_type: 'RUNNING', duration_sec: 2700, distance_m: 8000,
});

type Archive = { planStartDate: string; weeks: Array<{ w: number; garminActuals: Record<string, unknown> }> };
function archive(): Archive {
  const archives = (mockState as unknown as { previousPlanWks?: Archive[] }).previousPlanWks ?? [];
  expect(archives).toHaveLength(1);
  return archives[0];
}
const weekOf = (a: Archive, id: string): number =>
  a.weeks.findIndex(wk => Object.prototype.hasOwnProperty.call(wk.garminActuals, id)) + 1;

describe('west of UTC (America/Phoenix, UTC-7)', () => {
  beforeAll(() => { process.env.TZ = 'America/Phoenix'; });
  afterAll(restoreTz);

  it('a Sunday-evening first activity anchors its own week and a Monday-morning run files in the next', async () => {
    mockState = getDefaultState();
    rows = [
      row('strava-sun', '2026-10-05T03:00:00.000Z'), // Sunday 4 Oct 20:00 local (Monday UTC)
      row('strava-mon', '2026-10-05T15:00:00.000Z'), // Monday 5 Oct 08:00 local
    ];
    const res = await restoreHistoryFromServer(90);
    expect(res.activitiesRecovered).toBe(2);
    const a = archive();
    expect(a.planStartDate).toBe('2026-09-28'); // was 2026-10-05 (the UTC Monday)
    expect(weekOf(a, 'strava-sun')).toBe(1);    // was dropped (index -1)
    expect(weekOf(a, 'strava-mon')).toBe(2);    // was dropped (before noon on the anchor Monday)
  });
});

describe('east of UTC (Australia/Brisbane, UTC+10)', () => {
  beforeAll(() => { process.env.TZ = 'Australia/Brisbane'; });
  afterAll(restoreTz);

  it('an early-Monday first activity anchors its own Monday, not the week before', async () => {
    mockState = getDefaultState();
    rows = [row('strava-mon', '2026-10-04T21:00:00.000Z')]; // Monday 5 Oct 07:00 local (Sunday UTC)
    await restoreHistoryFromServer(90);
    const a = archive();
    expect(a.planStartDate).toBe('2026-10-05'); // was 2026-09-28
    expect(weekOf(a, 'strava-mon')).toBe(1);    // was week 2 of an archive a week early
    expect(a.weeks).toHaveLength(1);
  });
});
