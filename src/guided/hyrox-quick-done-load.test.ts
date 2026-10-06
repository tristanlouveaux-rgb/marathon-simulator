/**
 * Audit B9: a HYROX station / brick quick "Mark as done" (no guided records)
 * logs the session at its prescribed duration, so it carries load. Runs the
 * real completeStrengthSession; rate() and saveState are stubbed.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/ui/events', async () => {
  const { getMutableState } = await import('@/state/store');
  return {
    rate: (id: string, _n: string, rpe: number, _e: number, _t: string, _skip: boolean, _hr?: number, targetWeek?: number) => {
      const s = getMutableState();
      s.wks[(targetWeek ?? s.w) - 1].rated[id] = rpe;
    },
  };
});
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { completeStrengthSession } from './strength-complete';
import { generateHyroxStation } from '@/workouts/hyrox-generators';
import { computeWeekRawTSS, computeTodaySignalBTSS } from '@/calculations/fitness-model';
import { matchAndAutoComplete, reconcileCrossSourceDuplicates, type GarminActivityRow } from '@/calculations/activity-matcher';
import { TL_PER_MIN } from '@/constants';
import type { GarminActual, Week, Workout } from '@/types';

const ACCESS = { sled: 'always' as const, skiErg: true, rowErg: true };

function week(): Week {
  return {
    w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  } as unknown as Week;
}

describe('HYROX quick Mark as done carries load (audit B9)', () => {
  it('a station session marked done without guided records logs its prescribed duration at its rated RPE', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = getDefaultState();
    s.planStartDate = '2026-09-28';
    s.w = 1;
    s.wks = [week()];
    setState(s);

    const station = generateHyroxStation({
      kind: 'station_density', targetMinutes: 55, band: 'intermediate',
      stationAccess: ACCESS, phase: 'build', slotIndex: 0,
    }) as Workout;
    const workout = { ...station, id: 'hx-w1-station-0', dayOfWeek: 2 } as Workout;
    expect(workout.estimatedDurationMin).toBeGreaterThan(0);

    completeStrengthSession(workout);

    const wk = getMutableState().wks[0];
    const actual = wk.garminActuals?.['hx-w1-station-0'];
    expect(actual?.garminId.startsWith('guided-')).toBe(true);
    expect(actual?.durationSec).toBe(workout.estimatedDurationMin! * 60);
    const rpe = wk.rated['hx-w1-station-0'] as number;
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(workout.estimatedDurationMin! * TL_PER_MIN[Math.round(rpe)])); // was 0
    expect(computeTodaySignalBTSS(wk, actual!.startTime!.slice(0, 10))).toBeGreaterThan(0);              // was 0
  });

  it('a station session in a future week keeps the rating only (no record stamped now in a week the matcher does not search)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = getDefaultState();
    s.planStartDate = '2026-09-28';
    s.w = 1;
    s.wks = [week(), { ...week(), w: 2 } as Week];
    setState(s);

    const station = generateHyroxStation({
      kind: 'station_density', targetMinutes: 55, band: 'intermediate',
      stationAccess: ACCESS, phase: 'build', slotIndex: 0,
    }) as Workout;
    const workout = { ...station, id: 'hx-w2-station-0', dayOfWeek: 2 } as Workout;

    completeStrengthSession(workout, { targetWeek: 2 });

    const wk2 = getMutableState().wks[1];
    expect(typeof wk2.rated['hx-w2-station-0']).toBe('number');
    expect(wk2.garminActuals?.['hx-w2-station-0']).toBeUndefined();
  });
});


describe('a HYROX quick done is superseded by sport, never by a same-day activity of another sport (audit B9)', () => {
  // Wednesday 30 Sep: a station session marked done (stamped local noon) and an
  // easy run slot on the same day.
  function stationAndRunWeek() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = getDefaultState();
    s.planStartDate = '2026-09-28';
    s.eventType = 'hyrox';
    s.w = 1;
    s.wks = [{ ...week(), garminMatched: {} } as Week]; // a week the matcher has visited
    const station = generateHyroxStation({
      kind: 'station_density', targetMinutes: 55, band: 'intermediate',
      stationAccess: ACCESS, phase: 'build', slotIndex: 0,
    }) as Workout;
    const workout = { ...station, id: 'hx-w1-station-0', dayOfWeek: 2 } as Workout;
    const run = {
      id: 'hx-w1-run-0', n: 'Easy Run', t: 'hyrox_run_easy', discipline: 'run', dayOfWeek: 2,
      d: '55 min easy at 6:30/km (~8.5 km). Fully conversational.', r: 4, rpe: 4, estimatedDurationMin: 55,
    } as unknown as Workout;
    s.wks[0].triWorkouts = [workout, run];
    setState(s);
    completeStrengthSession(workout);
    return workout;
  }

  function stravaRow(over: Partial<GarminActivityRow>): GarminActivityRow {
    return {
      garmin_id: 'strava-X', activity_type: 'RUNNING', start_time: new Date(2026, 8, 30, 14, 0, 0).toISOString(),
      duration_sec: 3000, distance_m: 0, avg_pace_sec_km: null, avg_hr: null, max_hr: null, calories: null,
      aerobic_effect: null, anaerobic_effect: null, iTrimp: null, hrZones: null, ...over,
    };
  }

  it('a same-day Strava run of similar length leaves the station record in place and fills the run slot', () => {
    const workout = stationAndRunWeek();
    const stationSec = workout.estimatedDurationMin! * 60;

    // Two hours after the noon stamp, 4 minutes shorter than the station
    // session: inside the Strava upgrade loop's timing window.
    matchAndAutoComplete([stravaRow({ garmin_id: 'strava-RUN', duration_sec: stationSec - 240, distance_m: 8600 })]);

    const wk = getMutableState().wks[0];
    expect(wk.garminActuals!['hx-w1-station-0'].garminId.startsWith('guided-')).toBe(true);
    expect(wk.garminActuals!['hx-w1-station-0'].activityType).toBe('hyrox');
    expect(wk.garminActuals!['hx-w1-run-0'].garminId).toBe('strava-RUN');
    expect(wk.garminMatched!['strava-RUN']).toBe('hx-w1-run-0');
    expect(typeof wk.rated['hx-w1-run-0']).toBe('number');
  });

  it('a same-day Strava strength copy of the session still replaces the quick-done record in place', () => {
    const workout = stationAndRunWeek();
    const stationSec = workout.estimatedDurationMin! * 60;

    // Recorded as strength training rather than HIIT, so the HYROX station path
    // does not see it: the same-sport upgrade is what keeps it one session.
    matchAndAutoComplete([stravaRow({
      garmin_id: 'strava-LIFT', activity_type: 'STRENGTH_TRAINING', duration_sec: stationSec - 240,
    })]);

    const wk = getMutableState().wks[0];
    expect(wk.garminActuals!['hx-w1-station-0'].garminId).toBe('strava-LIFT');
    expect(wk.garminActuals!['hx-w1-station-0'].workoutName).toBe(workout.n);
    expect(Object.keys(wk.garminActuals!)).toEqual(['hx-w1-station-0']);
  });
});

describe('reconcile never drops a HYROX quick done for an activity on another plan slot (audit B9)', () => {
  // Wednesday 30 Sep: a station session marked done (stamped local noon, at its
  // prescribed duration) and a gym slot the same day.
  function quickDoneStation() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = getDefaultState();
    s.planStartDate = '2026-09-28';
    s.eventType = 'hyrox';
    s.w = 1;
    s.wks = [week()];
    const station = generateHyroxStation({
      kind: 'station_density', targetMinutes: 55, band: 'intermediate',
      stationAccess: ACCESS, phase: 'build', slotIndex: 0,
    }) as Workout;
    const workout = { ...station, id: 'hx-w1-station-0', dayOfWeek: 2 } as Workout;
    setState(s);
    completeStrengthSession(workout);
    return workout;
  }

  /** A synced strength session two hours after the noon stamp, 4 minutes shorter: inside the recorded window. */
  function syncedLift(garminId: string, stationSec: number): GarminActual {
    return {
      garminId, startTime: new Date(2026, 8, 30, 14, 0, 0).toISOString(), durationSec: stationSec - 240,
      distanceKm: 0, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null,
      activityType: 'STRENGTH_TRAINING', displayName: 'Weight Training',
    };
  }

  it('the quick-done record carries a manual-completion id (planned numbers, noon stamp)', () => {
    quickDoneStation();
    expect(getMutableState().wks[0].garminActuals!['hx-w1-station-0'].garminId.startsWith('guided-manual-')).toBe(true);
  });

  it('a Strava strength session filling another plan slot leaves the station record and its tick in place', () => {
    const workout = quickDoneStation();
    const s = getMutableState();
    const wk = s.wks[0];
    wk.rated['hx-w1-strength-0'] = 6;
    wk.garminActuals!['hx-w1-strength-0'] = syncedLift('strava-GYM', workout.estimatedDurationMin! * 60);

    expect(reconcileCrossSourceDuplicates(s)).toBe(false);
    expect(wk.garminActuals!['hx-w1-station-0'].garminId.startsWith('guided-manual-')).toBe(true);
    expect(typeof wk.rated['hx-w1-station-0']).toBe('number');
    expect(wk.garminActuals!['hx-w1-strength-0'].garminId).toBe('strava-GYM');
  });

  it('the station record still collapses against the same session synced as a strength extra', () => {
    const workout = quickDoneStation();
    const s = getMutableState();
    const wk = s.wks[0];
    wk.garminActuals!['garmin-strava-LIFT'] = syncedLift('strava-LIFT', workout.estimatedDurationMin! * 60);

    expect(reconcileCrossSourceDuplicates(s)).toBe(true);
    expect(Object.keys(wk.garminActuals!)).toEqual(['garmin-strava-LIFT']);
  });
});
