// @vitest-environment jsdom
/**
 * Each activity's excess records exist once, and go when the activity's slot
 * assignment goes (audit B19).
 *
 * Before: the re-review undo dropped only overflow items keyed by the raw id, so a
 * matched run's `${id}_surplus` slice survived and reprocessing appended another
 * copy on every review ("159 TSS from 4 extra activities"). Unmarking a matched run
 * left its surplus slice behind, and neither path knew the pre-upgrade id a
 * Strava-upgraded activity's records keep.
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
// The review UI itself is not under test; only the undo it runs before opening.
vi.mock('./matching-screen', () => ({ showMatchingScreen: vi.fn() }));

import { openActivityReReview } from './activity-review';
import { unratePlanSlot } from './events';
import { addUnspentItemOnce, collectActivityAliases, scrubExcessRecords } from '@/calculations/excess-records';
import { setState, resetState, getDefaultState, getState } from '@/state/store';
import type { SimulatorState, Week, UnspentLoadItem } from '@/types';

function weekWith(parts: Partial<Week>, w: number): Week {
  return {
    w, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {}, adhocWorkouts: [], unspentLoadItems: [],
    garminMatched: {}, garminPending: [], ...parts,
  } as unknown as Week;
}

const surplus = (garminId: string): UnspentLoadItem => ({
  garminId, displayName: 'Running', sport: 'extra_run', durationMin: 20,
  aerobic: 20, anaerobic: 2, date: '2026-03-03T07:00:00Z', reason: 'surplus_run',
});
const overflow = (garminId: string): UnspentLoadItem => ({
  garminId, displayName: 'Cycling', sport: 'cycling', durationMin: 60,
  aerobic: 1.5, anaerobic: 0.5, date: '2026-03-04', reason: 'overflow',
});

/** A run matched to slot W1-easy-0, upgraded from an Apple twin to Strava, with a
 *  surplus slice under each id, plus another activity's overflow item. */
function stateWithUpgradedSurplusRun(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    planStartDate: '2026-03-02',
    w: 1,
    tw: 18, rw: 4, rd: 'half', typ: 'balanced', v: 45, gs: 0, pac: { e: 330 },
    wks: [weekWith({
      garminMatched: { 'apple-500': 'W1-easy-0', 'strava-500': 'W1-easy-0', 'strava-600': 'garmin-strava-600' },
      rated: { 'W1-easy-0': 4 },
      garminActuals: {
        'W1-easy-0': { garminId: 'strava-500', startTime: '2026-03-03T07:00:00Z', distanceKm: 12, durationSec: 3960, workoutName: 'Easy Run', activityType: 'RUNNING' } as any,
      },
      unspentLoadItems: [surplus('apple-500_surplus'), surplus('strava-500_surplus'), overflow('strava-600')],
    }, 1)],
  } as unknown as SimulatorState;
}

describe('excess records exist once per activity', () => {
  beforeEach(() => { resetState(); document.body.innerHTML = ''; });

  it("re-review drops a run's surplus record under every id it has carried, so reprocessing writes it once", () => {
    setState(stateWithUpgradedSurplusRun());
    openActivityReReview(() => {});
    const ids = getState().wks[0].unspentLoadItems!.map(u => u.garminId);
    expect(ids).not.toContain('strava-500_surplus');
    expect(ids).not.toContain('apple-500_surplus');
  });

  it("unmarking a matched run drops its surplus record, including under its pre-upgrade id, and nothing else", () => {
    setState(stateWithUpgradedSurplusRun());
    expect(unratePlanSlot(1, 'W1-easy-0')).toBe(true);
    const wk = getState().wks[0];
    expect(wk.unspentLoadItems!.map(u => u.garminId)).toEqual(['strava-600']);
    expect(wk.garminMatched!['strava-500']).toBe('__pending__');
    expect(wk.rated['W1-easy-0']).toBeUndefined();
  });

  it('a second surplus record for the same run is not appended', () => {
    const wk = weekWith({ unspentLoadItems: [surplus('strava-500_surplus')] }, 1);
    expect(addUnspentItemOnce(wk, surplus('strava-500_surplus'))).toBe(false);
    expect(addUnspentItemOnce(wk, surplus('strava-501_surplus'))).toBe(true);
    expect(wk.unspentLoadItems!.map(u => u.garminId)).toEqual(['strava-500_surplus', 'strava-501_surplus']);
  });

  it('a pending activity names only itself (every unassigned activity shares __pending__)', () => {
    const wk = weekWith({ garminMatched: { 'strava-800': '__pending__', 'strava-801': '__pending__' } }, 1);
    expect([...collectActivityAliases(wk, 'strava-800')]).toEqual(['strava-800']);
    const weeks = [weekWith({ unspentLoadItems: [overflow('strava-801')] }, 1)];
    expect(scrubExcessRecords(weeks, collectActivityAliases(wk, 'strava-800'))).toBe(false);
  });
});
