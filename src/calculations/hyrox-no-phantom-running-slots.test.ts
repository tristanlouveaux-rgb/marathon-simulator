/**
 * matchAndAutoComplete in HYROX: runs match the HYROX plan in wk.triWorkouts and
 * never auto-complete a slot of the running engine's week (ITEM S3, audit D3).
 *
 * regenerateWeekWorkouts gated track-only users but not HYROX, so a run the
 * HYROX station/run branches missed fell through to findMatchingWorkout against
 * generateWeekWorkouts(s.rw ...), a running week HYROX mode shows nowhere, and
 * auto-completed one of its slots at high confidence. The run now queues for
 * review like a track-only run. The HYROX branches are untouched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Workout } from '@/types';

const RUN_WEEK: Workout[] = [
  { id: 'W1-easy-0', n: 'Easy Run', t: 'easy', d: '7km easy', r: 4, rpe: 4, dayOfWeek: 0 },
  { id: 'W1-threshold-0', n: 'Threshold', t: 'threshold', d: '10km with 3 x 2km @ threshold', r: 7, rpe: 7, dayOfWeek: 3 },
  { id: 'W1-long-0', n: 'Long Run', t: 'long', d: '16km', r: 4, rpe: 4, dayOfWeek: 6 },
] as Workout[];

vi.mock('@/workouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/workouts')>();
  return { ...actual, generateWeekWorkouts: vi.fn(() => RUN_WEEK.map(w => ({ ...w }))) };
});
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { matchAndAutoComplete, type GarminActivityRow } from './activity-matcher';

const at = (dayOffset: number) => new Date(2026, 8, 28 + dayOffset, 12, 0, 0).toISOString();

function run(id: string, dayOffset: number, km: number, min: number): GarminActivityRow {
  return {
    garmin_id: id, activity_type: 'RUNNING', start_time: at(dayOffset), duration_sec: min * 60,
    distance_m: km * 1000, avg_pace_sec_km: Math.round((min * 60) / km), avg_hr: null, max_hr: null,
    calories: null, aerobic_effect: null, anaerobic_effect: null,
  };
}

const HYROX_WEEK: Workout[] = [
  { id: 'H1-run-0', n: 'Easy Run', t: 'hyrox_run_easy', discipline: 'run', d: '40 min easy at 6:00/km (~6.7 km).', r: 4, rpe: 4, dayOfWeek: 0, estimatedDurationMin: 40 },
  { id: 'H1-station-0', n: 'Station Technique', t: 'hyrox_station_technique', discipline: 'station', d: '45 min', r: 6, rpe: 6, dayOfWeek: 1, estimatedDurationMin: 45 },
] as Workout[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 18, 0, 0));
  const s = getDefaultState();
  (s as any).eventType = 'hyrox';
  s.planStartDate = '2026-09-28';
  s.w = 1;
  s.tw = 12;
  s.rw = 3;
  s.wks = [{
    w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, adhocWorkouts: [], garminPending: [], garminMatched: {}, garminActuals: {},
    triWorkouts: HYROX_WEEK.map(w => ({ ...w })),
  } as any];
  setState(s);
});
afterEach(() => vi.useRealTimers());

describe('HYROX runs never complete a phantom running slot', () => {
  it('a run the HYROX run branch misses queues for review instead of completing the running engine\'s Threshold', () => {
    // Thursday 10 km: same day and distance as the phantom Threshold (high
    // confidence before the fix); no HYROX run session within a day of it.
    const res = matchAndAutoComplete([run('r-thu', 3, 10, 50)]);
    const wk = getMutableState().wks[0];
    expect(wk.rated['W1-threshold-0']).toBeUndefined();
    expect(wk.rated).toEqual({});
    expect(wk.garminMatched!['r-thu']).toBe('__pending__');
    expect(res.pending.map(p => p.garminId)).toEqual(['r-thu']);
  });

  it('a run next to the HYROX run session still matches it in wk.triWorkouts', () => {
    matchAndAutoComplete([run('r-mon', 0, 7, 40)]);
    const wk = getMutableState().wks[0];
    expect(wk.garminMatched!['r-mon']).toBe('H1-run-0');
    expect(Object.keys(wk.rated)).toEqual(['H1-run-0']);
  });

  it('a HIIT next to the HYROX station session still matches it', () => {
    matchAndAutoComplete([{ ...run('hiit-tue', 1, 1, 45), activity_type: 'HIIT', distance_m: null, avg_pace_sec_km: null }]);
    const wk = getMutableState().wks[0];
    expect(wk.garminMatched!['hiit-tue']).toBe('H1-station-0');
  });
});
