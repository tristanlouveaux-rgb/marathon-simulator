/**
 * Strava connected: Apple Health workouts are off, Apple physiology stays
 * (ITEM S1, Tristan 2026-10-05).
 *
 * The 2026-09 duplicate stress test proved Apple + Strava double counts rides,
 * swims, HIIT and strength (docs/audits/2026-09-load-accounting/
 * duplicate-test-synthesis.json, verdict unsafe_today). With Strava connected no
 * Apple WORKOUT path may read HealthKit workouts, feed matchAndAutoComplete,
 * upload to garmin_activities or overwrite the Strava-derived baselines. Sleep,
 * HRV, resting HR and the device VO2max keep flowing. Disconnecting Strava turns
 * Apple workouts back on.
 *
 * The HealthExtras emulator below returns one ride from queryWorkouts and HRV /
 * resting HR / VO2max samples from readQuantitySamples.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimulatorState } from '@/types';
import { getDefaultState } from '@/state/store';

let mockState: SimulatorState;

vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return {
    ...actual,
    getMutableState: () => mockState,
    getState: () => mockState,
    saveState: vi.fn(),
  };
});

const hk = vi.hoisted(() => ({
  queryWorkoutsCalls: 0,
  workoutStart: '',
  workoutEnd: '',
  observer: null as null | ((e: { count: number }) => void),
}));

vi.mock('@/data/healthExtras', () => ({
  isHealthExtrasAvailable: () => true,
  requestHealthExtrasPermissions: vi.fn(async (read: string[]) => ({ granted: read, denied: [] })),
  readQuantitySamples: vi.fn(async (opts: { dataType: string; endDate: string }) => {
    const day = new Date(Date.parse(opts.endDate) - 3600_000).toISOString();
    if (opts.dataType === 'restingHeartRate') return [{ value: 48, unit: 'bpm', startDate: day, endDate: day, sourceName: 'Apple Watch' }];
    if (opts.dataType === 'heartRateVariabilitySDNN') return [{ value: 62, unit: 'ms', startDate: day, endDate: day, sourceName: 'Apple Watch' }];
    if (opts.dataType === 'vo2Max') return [{ value: 54.3, unit: 'mL/kg/min', startDate: day, endDate: day, sourceName: 'Apple Watch' }];
    return [];
  }),
  readSleepSamples: vi.fn(async () => []),
  readLatestQuantity: vi.fn(async () => ({ value: null, asOf: null })),
  readCharacteristics: vi.fn(async () => ({ dateOfBirth: null, biologicalSex: null })),
  queryWorkouts: vi.fn(async () => {
    hk.queryWorkoutsCalls++;
    return [{
      workoutType: 'cycling', startDate: hk.workoutStart, endDate: hk.workoutEnd,
      duration: 3600, totalDistance: 30000, totalEnergyBurned: 800,
      sourceName: 'Apple Watch', sourceId: 'com.apple.health.watch',
    }];
  }),
  readWorkoutRouteLocations: vi.fn(async () => []),
  startWorkoutObserver: vi.fn(async () => ({ started: true, primed: true })),
  addWorkoutObserverListener: vi.fn(async (cb: (e: { count: number }) => void) => {
    hk.observer = cb;
    return { remove: async () => undefined };
  }),
}));

const matchSpy = vi.hoisted(() => ({ calls: [] as Array<Array<{ garmin_id: string }>> }));
vi.mock('@/calculations/activity-matcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/calculations/activity-matcher')>();
  return {
    ...actual,
    matchAndAutoComplete: vi.fn((rows: Array<{ garmin_id: string }>) => { matchSpy.calls.push(rows); return { changed: false, pending: [] }; }),
  };
});

const uploadSpy = vi.hoisted(() => ({ calls: [] as Array<Array<{ garmin_id: string }>> }));
vi.mock('@/data/appleActivityUpload', () => ({
  uploadAppleActivitiesToDB: vi.fn(async (rows: Array<{ garmin_id: string }>) => { uploadSpy.calls.push(rows); return rows.length; }),
}));

vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import {
  syncAppleHealth,
  syncAppleHealthPhysiology,
  syncAppleHealthDeepHistory,
  subscribeToWorkoutObserver,
  subscribeToForegroundResume,
} from './appleHealthSync';
import { appleWorkoutsEnabled } from './sources';

const STRAVA_BASELINES = {
  ctlBaseline: 46,
  signalBBaseline: 378,
  historicWeeklyTSS: [300, 310, 320, 330, 340, 350, 360, 370],
  detectedWeeklyKm: 40,
};

function stravaAndAppleUser(): SimulatorState {
  const s = getDefaultState() as SimulatorState;
  s.stravaConnected = true;
  s.appleHealthConnected = true;
  s.connectedSources = { physiology: 'apple' };
  s.appleHeartRatePermissionRequested = true;
  s.restingHR = 52;
  s.maxHR = 188;
  Object.assign(s, STRAVA_BASELINES);
  return s;
}

let doc: EventTarget & { visibilityState: string };

beforeEach(() => {
  mockState = stravaAndAppleUser();
  hk.queryWorkoutsCalls = 0;
  const end = new Date();
  hk.workoutStart = new Date(end.getTime() - 3600_000).toISOString();
  hk.workoutEnd = end.toISOString();
  matchSpy.calls = [];
  uploadSpy.calls = [];
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios' } });
  vi.stubGlobal('document', doc);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function expectNoAppleWorkoutIngest(): void {
  expect(hk.queryWorkoutsCalls).toBe(0);
  expect(matchSpy.calls).toEqual([]);
  expect(uploadSpy.calls).toEqual([]);
  expect(mockState.ctlBaseline).toBe(STRAVA_BASELINES.ctlBaseline);
  expect(mockState.signalBBaseline).toBe(STRAVA_BASELINES.signalBBaseline);
  expect(mockState.historicWeeklyTSS).toEqual(STRAVA_BASELINES.historicWeeklyTSS);
  expect(mockState.detectedWeeklyKm).toBe(STRAVA_BASELINES.detectedWeeklyKm);
}

describe('appleWorkoutsEnabled', () => {
  it('is off while Strava is connected and on again once it is disconnected', () => {
    expect(appleWorkoutsEnabled(mockState)).toBe(false);
    mockState.stravaConnected = false;
    expect(appleWorkoutsEnabled(mockState)).toBe(true);
  });

  it('a legacy explicit Strava source with Strava disconnected does not lock Apple out', () => {
    mockState.stravaConnected = false;
    mockState.wearable = 'strava';
    expect(appleWorkoutsEnabled(mockState)).toBe(true);
  });

  it('an Apple-only user keeps Apple workouts', () => {
    mockState.stravaConnected = false;
    mockState.connectedSources = { physiology: 'apple', activity: 'apple' };
    expect(appleWorkoutsEnabled(mockState)).toBe(true);
  });
});

describe('Strava + Apple user: no Apple workouts on any path', () => {
  it('launch sync ingests no Apple workouts and leaves the Strava baselines alone', async () => {
    await syncAppleHealth();
    expectNoAppleWorkoutIngest();
    // The one-time first-connect re-backfill is not armed either.
    expect(mockState.appleHistoryResyncDone).toBeUndefined();
    expect(mockState.appleHistoryFetched).toBeUndefined();
  });

  it('the Account full-history Sync ingests no Apple workouts and leaves the baselines alone', async () => {
    mockState.appleHistoryFetched = true;
    await syncAppleHealth({ forceFullHistory: true });
    expectNoAppleWorkoutIngest();
    expect(mockState.appleHistoryFetched).toBe(true);
  });

  it('the HealthKit observer ingests no Apple workouts', async () => {
    await subscribeToWorkoutObserver();
    expect(hk.observer).not.toBeNull();
    hk.observer!({ count: 1 });
    await vi.runAllTimersAsync();
    expectNoAppleWorkoutIngest();
  });

  it('a foreground resume ingests no Apple workouts', async () => {
    subscribeToForegroundResume();
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expectNoAppleWorkoutIngest();
  });

  it('the deep-history pull is off too', async () => {
    await syncAppleHealthDeepHistory();
    expectNoAppleWorkoutIngest();
  });

  it('physiology still updates (resting HR, HRV)', async () => {
    const updated = await syncAppleHealthPhysiology(7);
    expect(updated).toBe(true);
    const hist = mockState.physiologyHistory!;
    const last = hist[hist.length - 1];
    expect(last.restingHR).toBe(48);
    expect(last.hrvRmssd).toBeGreaterThan(0); // SDNN converted to the stored RMSSD scale
    expect(mockState.restingHR).toBe(48);
  });

  it('the device VO2max reading still refreshes on the workout-sync call', async () => {
    await syncAppleHealth();
    expect(mockState.vo2).toBe(54.3);
    expect(mockState.vo2Source).toBe('device');
  });
});

describe('disconnecting Strava resumes Apple workouts', () => {
  it('the next Apple sync reads, matches and uploads the workout again', async () => {
    mockState.stravaConnected = false;
    mockState.appleHistoryResyncDone = true;
    mockState.appleHistoryFetched = true;
    mockState.appleDeepHistoryFetched = true;

    await syncAppleHealth();

    expect(hk.queryWorkoutsCalls).toBe(1);
    expect(matchSpy.calls).toHaveLength(1);
    expect(matchSpy.calls[0][0].garmin_id).toMatch(/^apple-/);
    expect(uploadSpy.calls).toHaveLength(1);
  });

  it('a superseded or discarded Apple copy is not uploaded back into garmin_activities', async () => {
    mockState.stravaConnected = false;
    mockState.appleHistoryResyncDone = true;
    mockState.appleHistoryFetched = true;
    mockState.appleDeepHistoryFetched = true;
    mockState.supersededGarminIds = [`apple-com.apple.health.watch-${hk.workoutStart}`];

    await syncAppleHealth();

    expect(uploadSpy.calls).toEqual([[]]);
  });
});
