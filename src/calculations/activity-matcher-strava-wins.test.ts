/**
 * matchAndAutoComplete: an Apple copy of a session Strava holds never enters
 * state, and a superseded Apple id never re-imports (ITEM S1, 2026-10-05).
 *
 * Every ingest path ends in matchAndAutoComplete: the HealthKit sync, Apple rows
 * read back from garmin_activities by syncActivities, the Apple sync after
 * Strava is disconnected, and plan-regen redistribution. Track-only state keeps
 * the plan generator out of the way so the test isolates ingestion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDefaultState, setState, getMutableState } from '@/state/store';
import { matchAndAutoComplete, type GarminActivityRow } from './activity-matcher';

vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

const MONDAY = '2026-09-28';
const RIDE = '2026-09-29T14:05:00.000Z';
const appleAt = (iso: string) => `apple-com.apple.health.watch-${iso}`;
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function row(garmin_id: string, start_time: string, duration_sec: number, activity_type: string): GarminActivityRow {
  return {
    garmin_id, start_time, duration_sec, activity_type,
    distance_m: null, avg_pace_sec_km: null, avg_hr: null, max_hr: null, calories: null,
    aerobic_effect: null, anaerobic_effect: null,
  };
}

beforeEach(() => {
  const s = getDefaultState();
  s.trackOnly = true;
  s.planStartDate = MONDAY;
  s.w = 1;
  s.wks = [{
    w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, adhocWorkouts: [], garminPending: [], garminMatched: {},
    garminActuals: {
      'garmin-strava-1': {
        garminId: 'strava-1', startTime: RIDE, durationSec: 5400, distanceKm: 40, avgPaceSecKm: null,
        avgHR: null, maxHR: null, calories: null, activityType: 'CYCLING',
      },
    },
  } as any];
  s.wks[0].garminMatched!['strava-1'] = 'garmin-strava-1';
  setState(s);
});

const appleIdsInState = () => {
  const wk = getMutableState().wks[0];
  return [
    ...Object.values(wk.garminActuals ?? {}).map(a => a.garminId),
    ...(wk.garminPending ?? []).map(p => p.garminId),
    ...Object.keys(wk.garminMatched ?? {}),
  ].filter(id => id.startsWith('apple-'));
};

describe('matchAndAutoComplete keeps Strava canonical', () => {
  it('an Apple copy of a ride Strava already holds (paused, 26% shorter) is not ingested', () => {
    const res = matchAndAutoComplete([row(appleAt(plus(RIDE, 400)), plus(RIDE, 400), 4000, 'CYCLING')]);
    expect(res.pending).toEqual([]);
    expect(appleIdsInState()).toEqual([]);
  });

  it('an Apple copy whose Strava twin is in the same batch is not ingested', () => {
    const t = '2026-09-30T07:00:00.000Z';
    matchAndAutoComplete([
      row('strava-2', t, 2700, 'HIIT'),
      row(appleAt(plus(t, 400)), plus(t, 400), 2600, 'CARDIO'),
    ]);
    expect(appleIdsInState()).toEqual([]);
    expect(getMutableState().wks[0].garminPending!.map(p => p.garminId)).toEqual(['strava-2']);
  });

  it('an Apple-only session is still ingested', () => {
    const swim = appleAt('2026-09-29T06:00:00.000Z');
    const res = matchAndAutoComplete([row(swim, '2026-09-29T06:00:00.000Z', 2400, 'SWIMMING')]);
    expect(res.pending.map(p => p.garminId)).toEqual([swim]);
  });

  it('a superseded Apple id never re-imports, even with no Strava twin left in state', () => {
    const swim = appleAt('2026-09-29T06:00:00.000Z');
    getMutableState().supersededGarminIds = [swim];
    const res = matchAndAutoComplete([row(swim, '2026-09-29T06:00:00.000Z', 2400, 'SWIMMING')]);
    expect(res.pending).toEqual([]);
    expect(appleIdsInState()).toEqual([]);
  });
});
