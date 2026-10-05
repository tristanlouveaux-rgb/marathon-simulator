/**
 * One-time Apple/Strava duplicate cleanup for Strava-connected users
 * (ITEM S1, 2026-10-05): the launch pass, the post-Strava-sync completion, the
 * flag, and the forced garmin_activities twin cleanup.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SimulatorState } from '@/types';

let mockState: SimulatorState;

vi.mock('@/state', () => ({
  getMutableState: () => mockState,
  getState: () => mockState,
  saveState: vi.fn(),
}));

const db = vi.hoisted(() => ({ calls: [] as number[] }));
vi.mock('@/data/stravaSync', () => ({
  cleanupDbDuplicates: vi.fn(async (days: number) => { db.calls.push(days); return { groups: 0, deleted: 0 }; }),
}));

import { collapseAppleStravaTwinsOnLaunch, finishAppleStravaTwinCleanup } from './apple-strava-twin-cleanup';

const RIDE = '2026-09-29T14:05:00.000Z';
const APPLE = 'apple-com.apple.health.watch-2026-09-29T14:05:00.400Z';

function actual(garminId: string, startTime: string, durationSec: number) {
  return { garminId, startTime, durationSec, distanceKm: 0, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'CYCLING' };
}

beforeEach(() => {
  db.calls = [];
  mockState = {
    stravaConnected: true,
    appleHealthConnected: true,
    dbDedupCompletedAt: '2026-10-01T00:00:00.000Z',
    wks: [{
      rated: {}, adhocWorkouts: [
        { id: 'garmin-strava-1', t: 'cross', n: 'Ride', d: '60min' },
        { id: `garmin-${APPLE}`, t: 'cross', n: 'Cycling', d: '58min' },
      ],
      garminActuals: {
        'garmin-strava-1': actual('strava-1', RIDE, 3600),
        [`garmin-${APPLE}`]: actual(APPLE, '2026-09-29T14:05:00.400Z', 3500),
      },
      garminMatched: { 'strava-1': 'garmin-strava-1', [APPLE]: `garmin-${APPLE}` },
      garminPending: [],
    }],
  } as unknown as SimulatorState;
});

describe('one-time Apple/Strava twin cleanup', () => {
  it('the launch pass removes the Apple twin but does not mark the cleanup done', () => {
    expect(collapseAppleStravaTwinsOnLaunch()).toBe(true);
    expect(Object.keys(mockState.wks[0].garminActuals!)).toEqual(['garmin-strava-1']);
    expect(mockState.supersededGarminIds).toEqual([APPLE]);
    expect(mockState.appleStravaTwinCleanupDone).toBeUndefined();
    expect(db.calls).toEqual([]);
  });

  it('after the Strava sync it completes once and forces the DB twin cleanup regardless of the 30-day cadence', async () => {
    expect(await finishAppleStravaTwinCleanup()).toBe(true);
    expect(mockState.appleStravaTwinCleanupDone).toBe(true);
    expect(db.calls).toEqual([90]);
    // Stamp cleared, so the launch gate retries if this DB pass did not stamp.
    expect(mockState.dbDedupCompletedAt).toBeUndefined();

    // Never again.
    expect(await finishAppleStravaTwinCleanup()).toBe(false);
    expect(collapseAppleStravaTwinsOnLaunch()).toBe(false);
    expect(db.calls).toEqual([90]);
  });

  it('does nothing for a user without Strava (Apple workouts still on)', async () => {
    mockState.stravaConnected = false;
    expect(collapseAppleStravaTwinsOnLaunch()).toBe(false);
    expect(await finishAppleStravaTwinCleanup()).toBe(false);
    expect(Object.keys(mockState.wks[0].garminActuals!)).toHaveLength(2);
    expect(db.calls).toEqual([]);
  });
});
