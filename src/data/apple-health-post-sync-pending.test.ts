/**
 * Apple-only users: the post-sync pending step and the 28-day lookback
 * (ITEM S2, audit D1, D5 and the D4 remainder).
 *
 * D1. The matcher sends this week's non-runs and unmatched runs to
 * wk.garminPending as '__pending__'. No load function reads garminPending, so an
 * item counts zero until processPendingCrossTraining routes it (silent auto-match
 * for a single same-day item, Activity Review for a batch). The Strava and Garmin
 * syncs run that step after matching, including on zero new rows. The Apple sync
 * never did, on any caller (launch, observer, foreground resume, Account Sync,
 * onboarding), so an Apple user's ride stayed at zero load until they tapped
 * Review.
 *
 * D5. Strava and Garmin look back 28 days. Apple looked back 14, so after a 15 to
 * 28 day gap the older sessions never reached the matcher.
 *
 * D4 remainder. matchAndAutoComplete returns {changed, pending}; the Apple sync
 * tested the object for truthiness, so it re-rendered on every sync.
 *
 * Real matcher and real processPendingCrossTraining; the review UI is spied.
 * Track-only state keeps the plan generator out of the way (a ride always queues).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SimulatorState, GarminPendingItem } from '@/types';
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

type HkWorkout = {
  workoutType: string; startDate: string; endDate: string; duration: number;
  totalDistance: number; totalEnergyBurned: number; sourceName: string; sourceId: string;
};

const hk = vi.hoisted(() => ({
  workouts: [] as HkWorkout[],
  queries: [] as Array<{ startDate?: string; endDate?: string }>,
  observer: null as null | ((e: { count: number }) => void),
}));

vi.mock('@/data/healthExtras', () => ({
  isHealthExtrasAvailable: () => true,
  requestHealthExtrasPermissions: vi.fn(async (read: string[]) => ({ granted: read, denied: [] })),
  readQuantitySamples: vi.fn(async () => []),
  readSleepSamples: vi.fn(async () => []),
  readLatestQuantity: vi.fn(async () => ({ value: null, asOf: null })),
  readCharacteristics: vi.fn(async () => ({ dateOfBirth: null, biologicalSex: null })),
  // HealthKit's predicate: only workouts that start inside the queried window.
  queryWorkouts: vi.fn(async (opts: { startDate?: string; endDate?: string }) => {
    hk.queries.push(opts);
    const from = opts.startDate ? Date.parse(opts.startDate) : -Infinity;
    const to = opts.endDate ? Date.parse(opts.endDate) : Infinity;
    return hk.workouts.filter(w => Date.parse(w.startDate) >= from && Date.parse(w.startDate) <= to);
  }),
  readWorkoutRouteLocations: vi.fn(async () => []),
  startWorkoutObserver: vi.fn(async () => ({ started: true, primed: true })),
  addWorkoutObserverListener: vi.fn(async (cb: (e: { count: number }) => void) => {
    hk.observer = cb;
    return { remove: async () => undefined };
  }),
}));

const matchSpy = vi.hoisted(() => ({
  calls: [] as Array<Array<{ garmin_id: string; start_time: string }>>,
  results: [] as Array<{ changed: boolean; pending: unknown[] }>,
}));
vi.mock('@/calculations/activity-matcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/calculations/activity-matcher')>();
  return {
    ...actual,
    matchAndAutoComplete: vi.fn((rows: Parameters<typeof actual.matchAndAutoComplete>[0]) => {
      matchSpy.calls.push(rows.map(r => ({ garmin_id: r.garmin_id, start_time: r.start_time })));
      const res = actual.matchAndAutoComplete(rows);
      matchSpy.results.push(res);
      return res;
    }),
  };
});

vi.mock('@/data/appleActivityUpload', () => ({
  uploadAppleActivitiesToDB: vi.fn(async (rows: unknown[]) => rows.length),
}));

const ui = vi.hoisted(() => ({
  render: vi.fn(),
  autoProcess: vi.fn(),
  review: vi.fn(),
}));
vi.mock('@/ui/renderer', () => ({ render: ui.render, log: () => {} }));
vi.mock('@/ui/activity-review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/activity-review')>();
  return {
    ...actual,
    // Neither spy calls its completion callback: the user has not finished the
    // screen yet, so the review guard stays set.
    autoProcessActivities: ui.autoProcess,
    openActivityReReview: ui.review,
  };
});

import {
  syncAppleHealth,
  subscribeToWorkoutObserver,
  subscribeToForegroundResume,
} from './appleHealthSync';
import { resetPendingModalGuard } from './activitySync';
import { ACTIVITY_SYNC_LOOKBACK_DAYS } from './activity-sync-window';

const MONDAY = '2026-09-28';
const NOW = new Date('2026-09-30T18:00:00.000Z'); // Wednesday of plan week 1
const RIDE_START = '2026-09-30T07:00:00.000Z';
const SOURCE = 'com.apple.health.watch';
const appleId = (iso: string) => `apple-${SOURCE}-${iso}`;
const RIDE_ID = appleId(RIDE_START);

function hkWorkout(type: string, startIso: string, durationSec: number, distanceM: number): HkWorkout {
  return {
    workoutType: type,
    startDate: startIso,
    endDate: new Date(Date.parse(startIso) + durationSec * 1000).toISOString(),
    duration: durationSec,
    totalDistance: distanceM,
    totalEnergyBurned: 700,
    sourceName: 'Apple Watch',
    sourceId: SOURCE,
  };
}

function appleOnlyTrackUser(): SimulatorState {
  const s = getDefaultState() as SimulatorState;
  s.appleHealthConnected = true;
  s.stravaConnected = false;
  s.connectedSources = { physiology: 'apple', activity: 'apple' };
  // Backfills done: every sync below is an incremental one.
  s.appleHistoryResyncDone = true;
  s.appleHistoryFetched = true;
  s.appleDeepHistoryFetched = true;
  s.appleHeartRatePermissionRequested = true;
  s.restingHR = 52;
  s.maxHR = 188;
  s.hasCompletedOnboarding = true;
  if (s.onboarding) s.onboarding.currentStep = 'main-view';
  s.trackOnly = true;
  s.planStartDate = MONDAY;
  s.w = 1;
  s.wks = [{
    w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, adhocWorkouts: [], garminPending: [], garminMatched: {}, garminActuals: {},
  } as unknown as SimulatorState['wks'][number]];
  return s;
}

function pendingItem(garminId: string, appType: string, activityType: string, startTime: string, durationSec: number): GarminPendingItem {
  return {
    garminId, activityType, appType, startTime, durationSec, distanceM: null,
    avgHR: null, maxHR: null, aerobicEffect: null, anaerobicEffect: null, garminRpe: null, calories: null,
  };
}

function seedPending(item: GarminPendingItem): void {
  const wk = mockState.wks[0];
  wk.garminPending!.push(item);
  wk.garminMatched![item.garminId] = '__pending__';
}

// Element ids currently on screen (modals, the wizard "Return to plan" button).
const openModals = new Set<string>();
let doc: EventTarget & { visibilityState: string; getElementById: (id: string) => object | null };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  mockState = appleOnlyTrackUser();
  hk.workouts = [hkWorkout('cycling', RIDE_START, 4500, 30000)];
  hk.queries = [];
  matchSpy.calls = [];
  matchSpy.results = [];
  ui.render.mockClear();
  ui.autoProcess.mockClear();
  ui.review.mockClear();
  openModals.clear();
  resetPendingModalGuard();
  doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    getElementById: (id: string) => (openModals.has(id) ? {} : null),
  });
  vi.stubGlobal('window', { Capacitor: { getPlatform: () => 'ios' } });
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const autoProcessedIds = (call = 0): string[] =>
  (ui.autoProcess.mock.calls[call][0] as GarminPendingItem[]).map(i => i.garminId);

describe('Apple-only workout sync runs the post-sync pending step (audit D1)', () => {
  it('a same-day ride the matcher queues is routed on the same sync instead of sitting pending at zero load', async () => {
    await syncAppleHealth();

    // The matcher queued it (this is the zero-load state D1 describes) ...
    const wk = mockState.wks[0];
    expect(wk.garminMatched![RIDE_ID]).toBe('__pending__');
    expect(wk.garminPending!.map(p => p.garminId)).toEqual([RIDE_ID]);
    // ... and the post-sync step routed it: a single same-day non-run is matched silently.
    expect(ui.autoProcess).toHaveBeenCalledTimes(1);
    expect(autoProcessedIds()).toEqual([RIDE_ID]);
    expect(ui.review).not.toHaveBeenCalled();
  });

  it('a sync that returns no workouts still processes items queued by an earlier sync', async () => {
    hk.workouts = [];
    const yoga = appleId('2026-09-30T06:00:00.000Z');
    seedPending(pendingItem(yoga, 'other', 'YOGA', '2026-09-30T06:00:00.000Z', 1800));

    await syncAppleHealth();

    expect(matchSpy.calls).toEqual([]); // zero-row path: nothing to match
    expect(ui.autoProcess).toHaveBeenCalledTimes(1);
    expect(autoProcessedIds()).toEqual([yoga]);
  });

  it('a queued run opens Activity Review, and only once per day across repeated syncs', async () => {
    hk.workouts = [];
    const run = appleId('2026-09-29T07:00:00.000Z');
    seedPending(pendingItem(run, 'run', 'RUNNING', '2026-09-29T07:00:00.000Z', 2400));

    await syncAppleHealth();
    expect(ui.review).toHaveBeenCalledTimes(1);

    // A later sync the same day (observer, resume) does not open it again.
    await syncAppleHealth();
    await syncAppleHealth();
    expect(ui.review).toHaveBeenCalledTimes(1);
    expect(ui.autoProcess).not.toHaveBeenCalled();
  });

  it('a review guard left set by an unfinished review is cleared when no review or suggestion modal is open', async () => {
    await syncAppleHealth();
    expect(ui.autoProcess).toHaveBeenCalledTimes(1);

    // The user never completed that screen; the next sync still processes the ride.
    await syncAppleHealth();
    expect(ui.autoProcess).toHaveBeenCalledTimes(2);
    expect(autoProcessedIds(1)).toEqual([RIDE_ID]);
  });

  it.each(['suggestion-modal', 'activity-review-overlay'])('the guard is kept while %s is on screen', async (modalId) => {
    await syncAppleHealth();
    expect(ui.autoProcess).toHaveBeenCalledTimes(1);

    openModals.add(modalId);
    await syncAppleHealth();
    expect(ui.autoProcess).toHaveBeenCalledTimes(1);
  });

  it('nothing opens while onboarding is not complete (editSettings wizard over the old plan); the item stays queued', async () => {
    mockState.hasCompletedOnboarding = false;
    if (mockState.onboarding) mockState.onboarding.currentStep = 'goals';

    await syncAppleHealth();

    expect(ui.autoProcess).not.toHaveBeenCalled();
    expect(ui.review).not.toHaveBeenCalled();
    expect(mockState.wks[0].garminMatched![RIDE_ID]).toBe('__pending__');
  });

  it('nothing opens from the wizard review step of Account > Edit Profile (onboarding still complete, wizard on screen)', async () => {
    if (mockState.onboarding) mockState.onboarding.currentStep = 'review';
    openModals.add('wizard-return-btn');

    await syncAppleHealth();

    expect(ui.autoProcess).not.toHaveBeenCalled();
    expect(ui.review).not.toHaveBeenCalled();
    expect(mockState.wks[0].garminMatched![RIDE_ID]).toBe('__pending__');
  });

  it('a wizard step left in onboarding state after "Return to plan" does not block processing on the main view', async () => {
    if (mockState.onboarding) mockState.onboarding.currentStep = 'review';

    await syncAppleHealth();

    expect(ui.autoProcess).toHaveBeenCalledTimes(1);
    expect(autoProcessedIds()).toEqual([RIDE_ID]);
  });

  it('the HealthKit observer sync runs the step', async () => {
    await subscribeToWorkoutObserver();
    expect(hk.observer).not.toBeNull();
    hk.observer!({ count: 1 });
    await vi.runAllTimersAsync();
    expect(ui.autoProcess).toHaveBeenCalledTimes(1);
    expect(autoProcessedIds()).toEqual([RIDE_ID]);
  });

  it('the foreground-resume sync runs the step', async () => {
    subscribeToForegroundResume();
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTimersAsync();
    await vi.waitFor(() => expect(ui.autoProcess).toHaveBeenCalledTimes(1));
    expect(autoProcessedIds()).toEqual([RIDE_ID]);
  });

  it('the Account full-history sync runs the step', async () => {
    await syncAppleHealth({ forceFullHistory: true });
    expect(ui.autoProcess).toHaveBeenCalledTimes(1);
    expect(autoProcessedIds()).toEqual([RIDE_ID]);
  });

  it('with Strava connected the Apple sync leaves pending processing to the Strava sync', async () => {
    mockState.stravaConnected = true;
    seedPending(pendingItem('strava-1', 'ride', 'CYCLING', RIDE_START, 4500));

    await syncAppleHealth();

    expect(ui.autoProcess).not.toHaveBeenCalled();
    expect(ui.review).not.toHaveBeenCalled();
  });
});

describe('Apple incremental lookback matches Strava and Garmin (audit D5)', () => {
  it('an incremental sync queries the same 28-day window Strava and Garmin use', async () => {
    await syncAppleHealth();
    expect(ACTIVITY_SYNC_LOOKBACK_DAYS).toBe(28);
    expect(hk.queries).toHaveLength(1);
    const q = hk.queries[0];
    const days = (Date.parse(q.endDate!) - Date.parse(q.startDate!)) / 86_400_000;
    expect(Math.round(days)).toBe(ACTIVITY_SYNC_LOOKBACK_DAYS);
  });

  it('a workout 20 days old reaches the matcher on an incremental sync', async () => {
    const old = new Date(NOW.getTime() - 20 * 86_400_000).toISOString();
    hk.workouts.push(hkWorkout('swimming', old, 2400, 2000));

    await syncAppleHealth();

    expect(matchSpy.calls).toHaveLength(1);
    expect(matchSpy.calls[0].map(r => r.start_time).sort()).toEqual([old, RIDE_START].sort());
  });
});

describe('the Apple sync reads matchAndAutoComplete as {changed, pending} (audit D4 remainder)', () => {
  it('an incremental sync that changes nothing does not re-render', async () => {
    await syncAppleHealth();
    expect(matchSpy.results[0].changed).toBe(true);
    expect(ui.render).toHaveBeenCalled();

    ui.render.mockClear();
    await syncAppleHealth(); // same ride again: already queued, nothing new
    expect(matchSpy.results[1].changed).toBe(false);
    expect(ui.render).not.toHaveBeenCalled();
  });
});
