/**
 * matchAndAutoComplete reports enrichment-only changes as `changed` on every
 * return path (ITEM S2 follow-up, 2026-10-06).
 *
 * The Strava (`if (result.changed) render()`), Garmin (recomputeLT, then render)
 * and Apple (`if (result.changed || isFirstBackfill) render()`) syncs all read
 * `changed`. Before this fix it carried enrichChanged only when the batch held no
 * new rows. A batch whose new rows all fall outside the plan (dated before
 * planStartDate) returned `changed:false` even after the re-enrich loop or the
 * stale-pending resolution had moved week load. Rows before planStartDate are
 * never processed, so they stay new on every sync: with a 28-day window that is
 * every sync in a plan's first four weeks.
 *
 * Track-only state keeps the plan generator out of the way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SimulatorState, Workout, GarminPendingItem } from '@/types';
import { getDefaultState } from '@/state/store';

let mockState: SimulatorState;
const saved = vi.hoisted(() => ({ saveState: vi.fn() }));

vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return {
    ...actual,
    getMutableState: () => mockState,
    getState: () => mockState,
    saveState: saved.saveState,
  };
});
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { matchAndAutoComplete, type GarminActivityRow } from './activity-matcher';

const MONDAY = '2026-09-28';
const RIDE_START = '2026-09-30T07:00:00.000Z';
const RIDE_ID = `apple-com.apple.health.watch-${RIDE_START}`;
const RIDE_ADHOC = `garmin-${RIDE_ID}`;
const PRE_PLAN_SWIM = '2026-09-20T07:00:00.000Z'; // before planStartDate: weekIndexForDate → null
const PRE_PLAN_SWIM_ID = `apple-com.apple.health.watch-${PRE_PLAN_SWIM}`;
const ZONES = { z1: 600, z2: 2400, z3: 1200, z4: 300, z5: 0 };

function row(garmin_id: string, start_time: string, duration_sec: number, activity_type: string, extra: Partial<GarminActivityRow> = {}): GarminActivityRow {
  return {
    garmin_id, start_time, duration_sec, activity_type,
    distance_m: null, avg_pace_sec_km: null, avg_hr: null, max_hr: null, calories: null,
    aerobic_effect: null, anaerobic_effect: null,
    ...extra,
  };
}

function emptyWeek(w: number): SimulatorState['wks'][number] {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, adhocWorkouts: [], garminPending: [], garminMatched: {}, garminActuals: {},
  } as unknown as SimulatorState['wks'][number];
}

/** A ride matched on an earlier sync that had no heart rate: adhoc + actual, no iTRIMP or zones. */
function seedRideMatchedWithoutHr(): void {
  const wk = mockState.wks[0];
  wk.garminMatched![RIDE_ID] = RIDE_ADHOC;
  wk.adhocWorkouts!.push({ id: RIDE_ADHOC, t: 'cross', n: 'Ride', d: '75min', r: 5, rpe: 5 } as Workout);
  wk.garminActuals![RIDE_ADHOC] = {
    garminId: RIDE_ID, startTime: RIDE_START, durationSec: 4500, distanceKm: 30, avgPaceSecKm: null,
    avgHR: null, maxHR: null, calories: 700, iTrimp: null, hrZones: null, activityType: 'CYCLING',
  };
}

// The same ride read again, now with HR: iTRIMP and zones present on the row.
const rideWithHr = () => row(RIDE_ID, RIDE_START, 4500, 'CYCLING', { iTrimp: 9000, hrZones: ZONES, avg_hr: 145, max_hr: 165 });
const prePlanSwim = () => row(PRE_PLAN_SWIM_ID, PRE_PLAN_SWIM, 2400, 'SWIMMING');

beforeEach(() => {
  const s = getDefaultState() as SimulatorState;
  s.trackOnly = true;
  s.planStartDate = MONDAY;
  s.w = 1;
  s.restingHR = 52;
  s.maxHR = 188;
  s.wks = [emptyWeek(1)];
  mockState = s;
  saved.saveState.mockClear();
});

describe('matchAndAutoComplete reports re-enrichment as changed whatever else the batch holds', () => {
  it.each([
    ['the only new row predates the plan', true],
    ['the batch holds no new row', false],
  ])('a matched ride re-enriched with heart rate returns changed and saves state (%s)', (_label, withPrePlanSwim) => {
    seedRideMatchedWithoutHr();
    const rows = withPrePlanSwim ? [rideWithHr(), prePlanSwim()] : [rideWithHr()];

    const res = matchAndAutoComplete(rows);

    const actual = mockState.wks[0].garminActuals![RIDE_ADHOC];
    expect(actual.iTrimp).toBe(9000);
    expect(actual.hrZones).toEqual(ZONES);
    expect(res).toEqual({ changed: true, pending: [] });
    expect(saved.saveState).toHaveBeenCalled();
    // The pre-plan swim is still not ingested.
    expect(Object.keys(mockState.wks[0].garminMatched!)).toEqual([RIDE_ID]);
  });

  it('a stale pending item resolved into a past week returns changed when the only new row predates the plan', () => {
    mockState.wks = [emptyWeek(1), emptyWeek(2)];
    mockState.w = 2;
    const yogaId = 'apple-com.apple.health.watch-2026-09-29T06:00:00.000Z';
    const item: GarminPendingItem = {
      garminId: yogaId, activityType: 'YOGA', appType: 'other', startTime: '2026-09-29T06:00:00.000Z',
      durationSec: 1800, distanceM: null, avgHR: null, maxHR: null, aerobicEffect: null, anaerobicEffect: null,
      garminRpe: null, calories: null,
    };
    mockState.wks[0].garminPending!.push(item);
    mockState.wks[0].garminMatched![yogaId] = '__pending__';

    const res = matchAndAutoComplete([prePlanSwim()]);

    // Week 1 is past, so the matcher logs the yoga there as an adhoc with load.
    expect(mockState.wks[0].garminMatched![yogaId]).toBe(`garmin-${yogaId}`);
    expect(mockState.wks[0].actualTSS ?? 0).toBeGreaterThan(0);
    expect(res).toEqual({ changed: true, pending: [] });
    expect(saved.saveState).toHaveBeenCalled();
  });

  it('a batch whose only new row predates the plan and changes nothing else returns unchanged and does not save', () => {
    const res = matchAndAutoComplete([prePlanSwim()]);
    expect(res).toEqual({ changed: false, pending: [] });
    expect(saved.saveState).not.toHaveBeenCalled();
  });
});
