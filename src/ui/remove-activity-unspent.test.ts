// @vitest-environment jsdom
/**
 * Removing a synced activity also removes its excess-load records (audit B3
 * related defect). Load totals never read unspentLoadItems, but the excess card
 * and the "Adjust week" button do, so an orphan kept offering to cut the plan for
 * a session that no longer exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('./renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./renderer')>()),
  render: vi.fn(),
}));

import { removeGarminActivity } from './events';
import { setState, resetState, getDefaultState, getState } from '@/state/store';
import type { SimulatorState, Week } from '@/types';

function weekWith(parts: Partial<Week>, w: number): Week {
  return {
    w, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {}, adhocWorkouts: [], unspentLoadItems: [],
    garminMatched: {}, ...parts,
  } as unknown as Week;
}

function stateWithOverflowRide(): SimulatorState {
  const id = 'strava-700';
  const key = `garmin-${id}`;
  const unspent = {
    garminId: id, displayName: 'Cycling', sport: 'cycling', durationMin: 60,
    aerobic: 1.5, anaerobic: 0.5, date: '2026-03-04', reason: 'overflow' as const,
  };
  return {
    ...getDefaultState(),
    w: 2,
    wks: [
      weekWith({
        garminMatched: { [id]: key },
        garminActuals: { [key]: { garminId: id, startTime: '2026-03-04T08:00:00Z', distanceKm: 25, durationSec: 3600, iTrimp: 9000, displayName: 'Cycling', activityType: 'CYCLING' } as any },
        adhocWorkouts: [{ id: key, t: 'cross', n: 'Cycling', d: '60min' } as any],
        unspentLoadItems: [unspent, { ...unspent, garminId: 'strava-701' }],
      }, 1),
      // A copy carried into the next week at rollover (persistence carry).
      weekWith({ unspentLoadItems: [unspent] }, 2),
    ],
  } as unknown as SimulatorState;
}

describe('Removing an activity removes its excess-load records', () => {
  beforeEach(() => resetState());

  it('drops the overflow item in its own week and in the week it was carried to, and nothing else', () => {
    setState(stateWithOverflowRide());
    removeGarminActivity('strava-700', { skipConfirm: true });
    const s = getState();
    expect(s.wks[0].garminActuals?.['garmin-strava-700']).toBeUndefined();
    expect(s.wks[0].unspentLoadItems?.map(u => u.garminId)).toEqual(['strava-701']);
    expect(s.wks[1].unspentLoadItems).toEqual([]);
  });

  it('drops a matched run\'s surplus slice when the run is unassigned from its slot', () => {
    const s0 = getDefaultState() as unknown as SimulatorState;
    setState({
      ...s0,
      w: 1,
      wks: [weekWith({
        garminMatched: { 'strava-710': 'W1-easy-0' },
        rated: { 'W1-easy-0': 4 },
        garminActuals: { 'W1-easy-0': { garminId: 'strava-710', startTime: '2026-03-03T07:00:00Z', distanceKm: 9.6, durationSec: 3168, workoutName: 'Easy Run', activityType: 'RUNNING' } as any },
        unspentLoadItems: [{
          garminId: 'strava-710_surplus', displayName: 'Running', sport: 'extra_run', durationMin: 19.8,
          aerobic: 20, anaerobic: 2, date: '2026-03-03T07:00:00Z', reason: 'surplus_run',
        }],
      }, 1)],
    } as unknown as SimulatorState);
    removeGarminActivity('strava-710', { skipConfirm: true });
    expect(getState().wks[0].unspentLoadItems).toEqual([]);
  });
});
