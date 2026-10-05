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

  // Activity detail Discard passes actual.garminId. After a Strava upgrade that is
  // strava-<id>, while the twin key, the adhoc id, the old garminMatched entry and
  // the overflow item all keep the pre-upgrade Apple id.
  it('Discard of a Strava-upgraded Apple twin drops the overflow item kept under the pre-upgrade id', () => {
    const overflow = {
      garminId: 'apple-777', displayName: 'Cycling', sport: 'cycling', durationMin: 60,
      aerobic: 1.5, anaerobic: 0.5, date: '2026-03-04', reason: 'overflow' as const,
    };
    setState({
      ...getDefaultState(),
      w: 2,
      wks: [
        weekWith({
          garminMatched: { 'apple-777': 'garmin-apple-777', 'strava-999': 'garmin-apple-777', 'apple-778': 'garmin-apple-778' },
          garminActuals: {
            'garmin-apple-777': { garminId: 'strava-999', startTime: '2026-03-04T08:00:00Z', distanceKm: 25, durationSec: 3600, iTrimp: 9000, displayName: 'Ride', activityType: 'CYCLING' } as any,
            'garmin-apple-778': { garminId: 'apple-778', startTime: '2026-03-05T08:00:00Z', distanceKm: 20, durationSec: 3000, displayName: 'Cycling', activityType: 'CYCLING' } as any,
          },
          adhocWorkouts: [
            { id: 'garmin-apple-777', t: 'cross', n: 'Ride', d: '60min' } as any,
            { id: 'garmin-apple-778', t: 'cross', n: 'Cycling', d: '50min' } as any,
          ],
          unspentLoadItems: [overflow, { ...overflow, garminId: 'apple-778' }],
        }, 1),
        weekWith({ unspentLoadItems: [overflow] }, 2),
      ],
    } as unknown as SimulatorState);

    removeGarminActivity('strava-999', { permanent: true, skipConfirm: true });

    const s = getState();
    expect(s.wks[0].garminActuals?.['garmin-apple-777']).toBeUndefined();
    expect(s.wks[0].adhocWorkouts?.map(w => w.id)).toEqual(['garmin-apple-778']);
    expect(s.wks[0].unspentLoadItems?.map(u => u.garminId)).toEqual(['apple-778']);
    expect(s.wks[1].unspentLoadItems).toEqual([]);
  });

  it('Discard of a plain activity with one id drops its records and leaves its neighbour alone', () => {
    const overflow = {
      garminId: '123456', displayName: 'Swimming', sport: 'swimming', durationMin: 45,
      aerobic: 1.2, anaerobic: 0.2, date: '2026-03-04', reason: 'overflow' as const,
    };
    setState({
      ...getDefaultState(),
      w: 1,
      wks: [weekWith({
        garminMatched: { '123456': 'garmin-123456', '123457': 'garmin-123457' },
        garminActuals: {
          'garmin-123456': { garminId: '123456', startTime: '2026-03-04T08:00:00Z', distanceKm: 2, durationSec: 2700, displayName: 'Swimming', activityType: 'LAP_SWIMMING' } as any,
          'garmin-123457': { garminId: '123457', startTime: '2026-03-05T08:00:00Z', distanceKm: 2, durationSec: 2700, displayName: 'Swimming', activityType: 'LAP_SWIMMING' } as any,
        },
        adhocWorkouts: [
          { id: 'garmin-123456', t: 'cross', n: 'Swimming', d: '45min' } as any,
          { id: 'garmin-123457', t: 'cross', n: 'Swimming', d: '45min' } as any,
        ],
        unspentLoadItems: [overflow, { ...overflow, garminId: '123457' }],
      }, 1)],
    } as unknown as SimulatorState);

    removeGarminActivity('123456', { permanent: true, skipConfirm: true });

    const wk = getState().wks[0];
    expect(Object.keys(wk.garminActuals ?? {})).toEqual(['garmin-123457']);
    expect(wk.garminMatched).toEqual({ '123457': 'garmin-123457' });
    expect(wk.unspentLoadItems?.map(u => u.garminId)).toEqual(['123457']);
  });

  // Every unassigned activity maps to '__pending__', so that value names none of them.
  it('Discard of a pending activity keeps another pending activity\'s carried excess item', () => {
    const carried = {
      garminId: 'strava-801', displayName: 'Cycling', sport: 'cycling', durationMin: 60,
      aerobic: 1.5, anaerobic: 0.5, date: '2026-03-04', reason: 'overflow' as const,
    };
    setState({
      ...getDefaultState(),
      w: 2,
      wks: [
        weekWith({
          garminMatched: { 'strava-800': '__pending__', 'strava-801': '__pending__' },
          garminPending: [
            { garminId: 'strava-800', activityType: 'CYCLING', startTime: '2026-03-03T08:00:00Z', durationSec: 3600 } as any,
            { garminId: 'strava-801', activityType: 'CYCLING', startTime: '2026-03-04T08:00:00Z', durationSec: 3600 } as any,
          ],
        }, 1),
        weekWith({ unspentLoadItems: [carried] }, 2),
      ],
    } as unknown as SimulatorState);

    removeGarminActivity('strava-800', { permanent: true, skipConfirm: true });

    const s = getState();
    expect(s.wks[0].garminPending?.map(p => p.garminId)).toEqual(['strava-801']);
    expect(s.wks[1].unspentLoadItems?.map(u => u.garminId)).toEqual(['strava-801']);
  });
});
