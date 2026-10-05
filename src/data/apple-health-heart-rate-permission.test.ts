/**
 * Apple workouts need the HealthKit `heartRate` read permission (audit D4).
 *
 * The workout sync reads each workout's HR stream to compute avg HR, iTRIMP and
 * zones. Nothing requested `heartRate` after capgo's requestAuthorization was
 * removed (ae0545e), so on a fresh install every HR read returned [] and each
 * Apple workout was costed on duration alone.
 *
 * The HealthExtras emulator below models iOS: HR samples come back only once
 * `heartRate` has been included in a permission request.
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
  requested: new Set<string>(),
  log: [] as string[],
  workoutStart: '',
  workoutEnd: '',
}));

vi.mock('@/data/healthExtras', () => ({
  isHealthExtrasAvailable: () => true,
  requestHealthExtrasPermissions: vi.fn(async (read: string[]) => {
    hk.log.push(`perms:${read.join(',')}`);
    for (const r of read) hk.requested.add(r);
    return { granted: read, denied: [] };
  }),
  readQuantitySamples: vi.fn(async (opts: { dataType: string; startDate: string; endDate: string }) => {
    hk.log.push(`read:${opts.dataType}`);
    if (opts.dataType !== 'heartRate' || !hk.requested.has('heartRate')) return [];
    // 148 bpm every 5 s across the workout window.
    const s = Date.parse(opts.startDate);
    const e = Date.parse(opts.endDate);
    const out = [];
    for (let t = s; t < e; t += 5000) {
      const iso = new Date(t).toISOString();
      out.push({ value: 148, unit: 'bpm', startDate: iso, endDate: iso, sourceName: 'Apple Watch' });
    }
    return out;
  }),
  readSleepSamples: vi.fn(async () => []),
  readLatestQuantity: vi.fn(async () => ({ value: null, asOf: null })),
  readCharacteristics: vi.fn(async () => ({ dateOfBirth: null, biologicalSex: null })),
  queryWorkouts: vi.fn(async () => [{
    workoutType: 'running',
    startDate: hk.workoutStart,
    endDate: hk.workoutEnd,
    duration: 3600,
    totalDistance: 10000,
    totalEnergyBurned: 650,
    sourceName: 'Apple Watch',
    sourceId: 'com.apple.health.watch',
  }]),
  readWorkoutRouteLocations: vi.fn(async () => []),
  startWorkoutObserver: vi.fn(async () => ({ started: false, alreadyRunning: false })),
  addWorkoutObserverListener: vi.fn(async () => ({ remove: async () => undefined })),
}));

const matchSpy = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('@/calculations/activity-matcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/calculations/activity-matcher')>();
  return {
    ...actual,
    matchAndAutoComplete: vi.fn((rows: Array<Record<string, unknown>>) => { matchSpy.rows = rows; return false; }),
  };
});

vi.mock('@/data/appleActivityUpload', () => ({
  uploadAppleActivitiesToDB: vi.fn(async () => 0),
}));

import { syncAppleHealth, syncAppleHealthPhysiology } from './appleHealthSync';

beforeEach(() => {
  mockState = getDefaultState() as SimulatorState;
  // An Apple user connected before the fix: backfills done, never asked for heartRate.
  mockState.appleHealthConnected = true;
  mockState.connectedSources = { physiology: 'apple', activity: 'apple' };
  mockState.appleHistoryResyncDone = true;
  mockState.appleHistoryFetched = true;
  mockState.appleDeepHistoryFetched = true;
  mockState.restingHR = 52;
  mockState.maxHR = 188;
  mockState.biologicalSex = 'male';
  hk.requested = new Set();
  hk.log = [];
  const end = new Date();
  const start = new Date(end.getTime() - 3600_000);
  hk.workoutStart = start.toISOString();
  hk.workoutEnd = end.toISOString();
  matchSpy.rows = [];
  vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios' } });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Apple workout sync asks for heart rate', () => {
  it('an existing connected user is asked for heartRate once, before the first HR read', async () => {
    await syncAppleHealth();
    const permIdx = hk.log.findIndex(l => l.startsWith('perms:') && l.split(':')[1].split(',').includes('heartRate'));
    const firstHrRead = hk.log.indexOf('read:heartRate');
    expect(permIdx).toBeGreaterThanOrEqual(0);
    expect(firstHrRead).toBeGreaterThan(permIdx);
    expect(mockState.appleHeartRatePermissionRequested).toBe(true);
  });

  it('the workout row then carries its HR stream (avg HR and iTRIMP), not a duration-only cost', async () => {
    await syncAppleHealth();
    expect(matchSpy.rows).toHaveLength(1);
    const row = matchSpy.rows[0];
    expect(row.avg_hr).toBe(148);
    expect(row.iTrimp).toBeGreaterThan(0);
    expect(row.hrZones).not.toBeNull();
  });

  it('does not ask again once heartRate has been requested on this install', async () => {
    mockState.appleHeartRatePermissionRequested = true;
    hk.requested.add('heartRate');
    await syncAppleHealth();
    expect(hk.log.some(l => l.startsWith('perms:'))).toBe(false);
    expect(hk.log).toContain('read:heartRate');
  });

  it('the physiology sync (connect flow) includes heartRate and satisfies the one-time guard', async () => {
    await syncAppleHealthPhysiology(7);
    expect(hk.log.find(l => l.startsWith('perms:'))?.split(':')[1].split(',')).toContain('heartRate');
    expect(mockState.appleHeartRatePermissionRequested).toBe(true);

    hk.log = [];
    await syncAppleHealth();
    expect(hk.log.some(l => l.startsWith('perms:'))).toBe(false);
  });
});
