// @vitest-environment jsdom
/**
 * The Strain view lists each logged activity once. Its activity list, day
 * duration and passive-TSS caption all read activitiesForDate, so a double
 * listing doubles the minutes subtracted from active minutes.
 *
 * Fixture: the Strava upgrade loop (activity-matcher.ts, "Strava upgrade")
 * rewrites a twin's garminId to strava-<id> but keeps its key garmin-<id> and
 * the adhoc entry garmin-<id>, so the garminId suffix no longer pairs them.
 */
import { describe, it, expect, vi } from 'vitest';

// strain-view pulls in the Supabase client at import time; no network here.
vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { activitiesForDate } from './strain-view';
import type { Week, GarminActual, Workout } from '@/types';

function week(parts: Partial<Week>): Week {
  return {
    w: 1, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {}, adhocWorkouts: [], unspentLoadItems: [],
    ...parts,
  } as unknown as Week;
}

const START = '2026-09-09T07:00:00Z';
const DATE = START.slice(0, 10);

// Adhoc entry written when the Apple activity was logged (addAdhocWorkoutFromPending).
const adhoc = {
  id: 'garmin-apple-777', t: 'cross', n: 'Cycling', d: '60min · 9 Sep 07:00', r: 5, rpe: 5,
  garminTimestamp: START, garminDurationMin: 60, iTrimp: 9000, activityType: 'CYCLING',
} as unknown as Workout;

const twin = {
  garminId: 'apple-777', startTime: START, distanceKm: 25, durationSec: 3600,
  avgPaceSecKm: null, avgHR: 135, maxHR: 160, calories: null, iTrimp: 9000, hrZones: null,
  displayName: 'Cycling', activityType: 'CYCLING',
} as GarminActual;

describe('Strain view lists each activity once', () => {
  it('a twin and its adhoc entry list once before the Strava upgrade', () => {
    const wk = week({ garminActuals: { 'garmin-apple-777': twin }, adhocWorkouts: [adhoc] });
    expect(activitiesForDate(DATE, [wk])).toHaveLength(1);
  });

  it('they still list once after the upgrade, with the Strava duration', () => {
    const upgraded = { ...twin, garminId: 'strava-999', durationSec: 3900 } as GarminActual;
    const wk = week({ garminActuals: { 'garmin-apple-777': upgraded }, adhocWorkouts: [adhoc] });
    const acts = activitiesForDate(DATE, [wk]);
    expect(acts).toHaveLength(1);
    expect(acts[0].garminId).toBe('strava-999');
    expect(acts[0].durationSec).toBe(3900);
  });

  it('an adhoc activity with no twin is still listed', () => {
    const wk = week({ adhocWorkouts: [adhoc] });
    const acts = activitiesForDate(DATE, [wk]);
    expect(acts).toHaveLength(1);
    expect(acts[0].durationSec).toBe(3600);
  });
});
