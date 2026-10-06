/**
 * parseDistanceKm never reads a minutes token as miles.
 *
 * Before: the miles pattern /(\d+(?:\.\d+)?)\s*mi(?:le)?s?/i matched the "mi" in
 * "10 min", so a description with a minutes token and no km token parsed to
 * 16.09 km. Every synced HYROX Tempo and Interval run (descriptions start "10 min
 * easy warm-up.") then failed the HYROX run branch's distance-ratio test against
 * a 16 km "plan" and queued for review instead of matching on duration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
vi.stubGlobal('localStorage', localStorageMock);
vi.stubGlobal('alert', vi.fn());
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { parseDistanceKm } from './matching';
import { matchAndAutoComplete, type GarminActivityRow } from './activity-matcher';
import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { resetState, getMutableState } from '@/state/store';
import type { Workout } from '@/types';

describe('parseDistanceKm: minutes are not miles', () => {
  it('a minutes-only description has no distance', () => {
    expect(parseDistanceKm('10 min easy warm-up. 20 min at threshold pace')).toBe(0); // was 16.09
    expect(parseDistanceKm('35 mins steady')).toBe(0);
    expect(parseDistanceKm('20 minutes at tempo')).toBe(0);
  });

  it('a HYROX interval description falls through to the interval estimate', () => {
    // 8 × 400 m: the existing reps × distance × 2 + 3 km approximation.
    expect(parseDistanceKm('10 min easy warm-up. 8 x 400m at ~4:30/km')).toBeCloseTo(8 * 400 * 2 / 1000 + 3, 6); // was 16.09
  });

  it('miles still parse (the parser\'s 1.609 km per mile)', () => {
    expect(parseDistanceKm('8 miles')).toBeCloseTo(8 * 1.609, 6);
    expect(parseDistanceKm('5 mi easy')).toBeCloseTo(5 * 1.609, 6);
    expect(parseDistanceKm('1 mile')).toBeCloseTo(1.609, 6);
    expect(parseDistanceKm('5mi')).toBeCloseTo(5 * 1.609, 6);
    expect(parseDistanceKm('6 Miles, last 2 at MP')).toBeCloseTo(6 * 1.609, 6);
  });

  it('km still wins over everything', () => {
    expect(parseDistanceKm('10 min warm-up, 6km tempo')).toBe(6);
  });
});

describe('HYROX Tempo Run auto-matches its synced run', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 28, 9, 0, 0)); // onboard on the plan's Monday
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorageMock.clear();
    resetState();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a 36-minute / 6.5 km run on the Tempo Run day completes the Tempo Run slot', () => {
    initializeHyroxSimulator({
      trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
      triTimeAvailableHoursPerWeek: 8,
    } as any);
    const s = getMutableState();
    expect(s.eventType).toBe('hyrox');
    const tempo = (s.wks[0].triWorkouts ?? []).find(w => w.n === 'Tempo Run') as Workout;
    expect(tempo?.d).toMatch(/^10 min easy warm-up/);
    expect(parseDistanceKm(tempo.d)).toBe(0); // was 16.09
    const key = tempo.id ?? tempo.n;

    vi.setSystemTime(new Date(2026, 8, 30, 9, 0, 0));
    const day = tempo.dayOfWeek!;
    const row: GarminActivityRow = {
      garmin_id: 'strava-tempo-1', activity_type: 'RUNNING',
      start_time: new Date(2026, 8, 28 + day, 12, 0, 0).toISOString(),
      duration_sec: 36 * 60, distance_m: 6500, avg_pace_sec_km: Math.round(36 * 60 / 6.5),
      avg_hr: null, max_hr: null, calories: null, aerobic_effect: null, anaerobic_effect: null,
    };
    matchAndAutoComplete([row]);

    const wk = getMutableState().wks[0];
    expect(wk.garminMatched!['strava-tempo-1']).toBe(key); // was '__pending__'
    expect(typeof wk.rated[key]).toBe('number');
  });
});
