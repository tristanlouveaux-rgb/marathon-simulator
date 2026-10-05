// @vitest-environment jsdom
/**
 * The Load & Taper per-sport breakdown counts each activity once (audit B20).
 * A surplus_run unspent item is a slice of a run already counted in full, and an
 * orphan unspent item has no activity behind it: neither may add to a segment.
 */
import { describe, it, expect, vi } from 'vitest';

// home-view pulls in the Supabase client at import time; no network here.
vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { computeLoadBreakdown } from './home-view';
import { computeWeekRawTSS, normalizeiTrimp } from '@/calculations/fitness-model';
import type { Week, GarminActual, UnspentLoadItem } from '@/types';

const PLAN_START = '2026-09-07';

function week(parts: Partial<Week>): Week {
  return {
    w: 1, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {}, adhocWorkouts: [], unspentLoadItems: [],
    ...parts,
  } as unknown as Week;
}

// 9.6 km run matched to a 6 km easy slot: applyReview adds a surplus item for the
// 3.6 km over plan (activity-review.ts surplus branch).
const run: GarminActual = {
  garminId: 'strava-500', startTime: '2026-09-08T07:00:00Z', distanceKm: 9.6, durationSec: 3168,
  avgPaceSecKm: 330, avgHR: 145, maxHR: 165, calories: null, iTrimp: 9000, hrZones: null,
  workoutName: 'Easy Run', activityType: 'RUNNING',
} as GarminActual;
const surplus: UnspentLoadItem = {
  garminId: 'strava-500_surplus', displayName: 'Running', sport: 'extra_run', durationMin: 19.8,
  aerobic: 20, anaerobic: 2, date: '2026-09-08T07:00:00Z', reason: 'surplus_run',
};
const orphan: UnspentLoadItem = {
  garminId: 'strava-501', displayName: 'Cycling', sport: 'cycling', durationMin: 60,
  aerobic: 1.5, anaerobic: 0.5, date: '2026-09-10', reason: 'overflow',
};

const total = (wk: Week) => computeLoadBreakdown(wk, wk.rated ?? {}, PLAN_START).reduce((s, seg) => s + seg.tss, 0);

describe('Load breakdown counts each activity once', () => {
  it('a surplus run slice does not add to the matched run', () => {
    const wk = week({ garminActuals: { 'W1-easy-0': run }, unspentLoadItems: [surplus] });
    const segs = computeLoadBreakdown(wk, wk.rated ?? {}, PLAN_START);
    expect(segs).toHaveLength(1);
    expect(segs[0].label).toBe('Running');
    expect(segs[0].tss).toBeCloseTo(normalizeiTrimp(9000), 6);
    expect(segs[0].durationMin).toBeCloseTo(3168 / 60, 6);
  });

  it('an orphan unspent item adds no segment', () => {
    const wk = week({ unspentLoadItems: [orphan] });
    expect(computeLoadBreakdown(wk, wk.rated ?? {}, PLAN_START)).toEqual([]);
  });

  it('segments sum to the weekly Signal B total the headline shows', () => {
    const wk = week({ garminActuals: { 'W1-easy-0': run }, unspentLoadItems: [surplus, orphan] });
    expect(Math.round(total(wk))).toBe(computeWeekRawTSS(wk, wk.rated ?? {}, PLAN_START));
  });
});
