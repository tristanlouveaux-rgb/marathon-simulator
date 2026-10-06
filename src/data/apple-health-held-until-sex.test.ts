/**
 * F8: Apple workouts are stamped with iTRIMP on the client (β from the
 * resolved sex) and upserted into garmin_activities, where after the first
 * backfill only the latest 14 days are re-read automatically. A sync that runs
 * mid-wizard before the sex is known (a relaunch between connect-data and
 * about-you / schedule) would store the male β for a female athlete's year of
 * history. The sync now holds until the sex resolves: the wizard answer, or
 * the HealthKit biological-sex characteristic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimulatorState } from '@/types';
import { getDefaultState } from '@/state/store';
import { defaultOnboardingState } from '@/types/onboarding';
import { getBeta } from '@/calculations/trimp';

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
  workoutStart: '',
  workoutEnd: '',
  queried: 0,
  characteristics: { dateOfBirth: null as string | null, biologicalSex: null as 'male' | 'female' | 'other' | null },
}));

const HR_BPM = 148;
const RESTING_HR = 52;
const MAX_HR = 188;

vi.mock('@/data/healthExtras', () => ({
  isHealthExtrasAvailable: () => true,
  requestHealthExtrasPermissions: vi.fn(async (read: string[]) => ({ granted: read, denied: [] })),
  // Constant HR every 5 s across the workout window.
  readQuantitySamples: vi.fn(async (opts: { dataType: string; startDate: string; endDate: string }) => {
    if (opts.dataType !== 'heartRate') return [];
    const out = [];
    for (let t = Date.parse(opts.startDate); t < Date.parse(opts.endDate); t += 5000) {
      const iso = new Date(t).toISOString();
      out.push({ value: 148, unit: 'bpm', startDate: iso, endDate: iso, sourceName: 'Apple Watch' });
    }
    return out;
  }),
  readSleepSamples: vi.fn(async () => []),
  readLatestQuantity: vi.fn(async () => ({ value: null, asOf: null })),
  readCharacteristics: vi.fn(async () => hk.characteristics),
  queryWorkouts: vi.fn(async () => {
    hk.queried++;
    return [{
      workoutType: 'running',
      startDate: hk.workoutStart,
      endDate: hk.workoutEnd,
      duration: 3600,
      totalDistance: 10000,
      totalEnergyBurned: 650,
      sourceName: 'Apple Watch',
      sourceId: 'com.apple.health.watch',
    }];
  }),
  readWorkoutRouteLocations: vi.fn(async () => []),
  startWorkoutObserver: vi.fn(async () => ({ started: false, alreadyRunning: false })),
  addWorkoutObserverListener: vi.fn(async () => ({ remove: async () => undefined })),
}));

const uploaded = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('@/calculations/activity-matcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/calculations/activity-matcher')>();
  return { ...actual, matchAndAutoComplete: vi.fn(() => false) };
});

vi.mock('@/data/appleActivityUpload', () => ({
  uploadAppleActivitiesToDB: vi.fn(async (rows: Array<Record<string, unknown>>) => { uploaded.rows.push(...rows); return rows.length; }),
}));

import { syncAppleHealth, syncAppleAthleteProfile } from './appleHealthSync';
import { releaseHeldTrimpSyncs, heldTrimpSyncKeys, _resetHeldTrimpSyncsForTest } from './trimp-sex-gate';

function appleUser(): SimulatorState {
  const s = getDefaultState() as SimulatorState;
  s.appleHealthConnected = true;
  s.connectedSources = { physiology: 'apple', activity: 'apple' };
  s.appleHistoryResyncDone = true;
  s.appleHistoryFetched = true;
  s.appleDeepHistoryFetched = true;
  s.appleHeartRatePermissionRequested = true;
  s.restingHR = RESTING_HR;
  s.maxHR = MAX_HR;
  return s;
}

function midWizardNoSex(): SimulatorState {
  const s = appleUser();
  s.hasCompletedOnboarding = false;
  s.biologicalSex = undefined;
  s.onboarding = { ...defaultOnboardingState, currentStep: 'connect-data', biologicalSex: undefined };
  return s;
}

beforeEach(() => {
  _resetHeldTrimpSyncsForTest();
  uploaded.rows = [];
  hk.queried = 0;
  hk.characteristics = { dateOfBirth: null, biologicalSex: null };
  const end = new Date();
  hk.workoutEnd = end.toISOString();
  hk.workoutStart = new Date(end.getTime() - 3600_000).toISOString();
  vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Apple workout sync holds until the athlete\'s sex is known (F8)', () => {
  it('mid-wizard with no sex, nothing is read from HealthKit or stamped into garmin_activities', async () => {
    mockState = midWizardNoSex();
    await syncAppleHealth();
    expect(hk.queried).toBe(0);
    expect(uploaded.rows).toHaveLength(0);
    expect(heldTrimpSyncKeys()).toEqual(['apple-workouts']);
  });

  it('the held sync runs once the wizard answer lands and stamps iTRIMP with the female β', async () => {
    // Reference: the same workout synced for a male athlete after onboarding.
    mockState = appleUser();
    mockState.hasCompletedOnboarding = true;
    mockState.biologicalSex = 'male';
    await syncAppleHealth();
    const maleITrimp = uploaded.rows[0].iTrimp as number;
    expect(maleITrimp).toBeGreaterThan(0);

    uploaded.rows = [];
    mockState = midWizardNoSex();
    await syncAppleHealth();
    expect(uploaded.rows).toHaveLength(0);

    mockState.onboarding = { ...mockState.onboarding!, biologicalSex: 'female', currentStep: 'race-target' };
    expect(await releaseHeldTrimpSyncs(mockState)).toBe(1);
    expect(uploaded.rows).toHaveLength(1);
    // Constant HR, so every sample shares one HRR x: female/male = e^((β_f − β_m)·x),
    // about 0.84 here. iTRIMP is stored as a whole number (activityEnrichment.ts),
    // so the ratio is compared to 3 decimals.
    const x = (HR_BPM - RESTING_HR) / (MAX_HR - RESTING_HR);
    const expectedRatio = Math.exp((getBeta('female') - getBeta('male')) * x);
    expect((uploaded.rows[0].iTrimp as number) / maleITrimp).toBeCloseTo(expectedRatio, 3);
  });

  it('a HealthKit biological-sex characteristic releases the held sync', async () => {
    mockState = midWizardNoSex();
    await syncAppleHealth();
    expect(hk.queried).toBe(0);

    hk.characteristics = { dateOfBirth: null, biologicalSex: 'female' };
    await syncAppleAthleteProfile();
    expect(mockState.onboarding!.biologicalSex).toBe('female');
    await vi.waitFor(() => expect(uploaded.rows).toHaveLength(1));
    expect(heldTrimpSyncKeys()).toEqual([]);
  });
});
