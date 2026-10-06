// @vitest-environment jsdom
/**
 * Review paths: a walk, hike or row never takes a planned run slot, and
 * just-track / HYROX never match against a phantom running week (ITEM S3,
 * audit D3).
 *
 * Before the fix:
 *  - autoProcessActivities (single same-day item) put a Sunday hike on the
 *    Long Run, silently consuming it.
 *  - the matching screen pre-assigned a walk proposed onto a run slot without
 *    the compatibility check a manual tap gets.
 *  - getWeekWorkoutsForReview had no trackOnly gate and no HYROX branch, so both
 *    modes matched against generateWeekWorkouts(s.rw ...): slots their plans
 *    never show.
 *
 * Real activity-review, matching screen, matcher helpers and store. The plan
 * generator is replaced by a fixed running week so the phantom-slot cases are
 * deterministic; renderer, toast and the suggestion modal are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GarminPendingItem, Workout } from '@/types';

const RUN_WEEK: Workout[] = [
  { id: 'W1-easy-0', n: 'Easy Run', t: 'easy', d: '8km easy', r: 4, rpe: 4, dayOfWeek: 0 },
  { id: 'W1-easy-1', n: 'Easy Run 2', t: 'easy', d: '8km easy', r: 4, rpe: 4, dayOfWeek: 1 },
  { id: 'W1-threshold-0', n: 'Threshold', t: 'threshold', d: '10km with 3 x 2km @ threshold', r: 7, rpe: 7, dayOfWeek: 3 },
  { id: 'W1-long-0', n: 'Long Run', t: 'long', d: '16km', r: 4, rpe: 4, dayOfWeek: 6 },
] as Workout[];

vi.mock('@/workouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/workouts')>();
  return { ...actual, generateWeekWorkouts: vi.fn(() => RUN_WEEK.map(w => ({ ...w }))) };
});
vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return { ...actual, saveState: vi.fn() };
});
vi.mock('@/ui/renderer', () => ({ render: vi.fn(), log: () => {} }));
vi.mock('@/ui/toast', () => ({ showAssignmentToast: vi.fn(), showSimpleToast: vi.fn(), showMarkerBumpToast: vi.fn() }));
vi.mock('@/ui/suggestion-modal', () => ({ showSuggestionModal: vi.fn() }));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { autoProcessActivities, showActivityReview } from './activity-review';
import { showMatchingScreen, type ProposedPairing } from './matching-screen';
import { mapGarminType } from '@/calculations/activity-matcher';

// Plan week 1 starts Monday 28 Sep 2026. Local-noon timestamps keep the day of
// week stable in every timezone.
const at = (dayOffset: number) => new Date(2026, 8, 28 + dayOffset, 12, 0, 0).toISOString();

function item(garminId: string, activityType: string, dayOffset: number, durationMin: number, distanceKm = 0): GarminPendingItem {
  return {
    garminId,
    activityType,
    appType: mapGarminType(activityType),
    startTime: at(dayOffset),
    durationSec: durationMin * 60,
    distanceM: distanceKm > 0 ? distanceKm * 1000 : null,
    avgPaceSecKm: null,
    avgHR: null,
    maxHR: null,
    aerobicEffect: null,
    anaerobicEffect: null,
    garminRpe: null,
    calories: null,
  } as GarminPendingItem;
}

function setup(opts: { trackOnly?: boolean; eventType?: 'hyrox'; triWorkouts?: Workout[] } = {}) {
  const s = getDefaultState();
  s.planStartDate = '2026-09-28';
  s.w = 1;
  s.tw = 12;
  s.rw = 4;
  if (opts.trackOnly) s.trackOnly = true;
  if (opts.eventType) (s as any).eventType = opts.eventType;
  s.wks = [{
    w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, adhocWorkouts: [], garminPending: [], garminMatched: {}, garminActuals: {},
    unspentLoadItems: [],
    ...(opts.triWorkouts ? { triWorkouts: opts.triWorkouts } : {}),
  } as any];
  setState(s);
}

const wk = () => getMutableState().wks[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 4, 18, 0, 0)); // Sunday evening of week 1
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('auto-processed pairings (autoProcessActivities)', () => {
  it('a Sunday hike does not complete the Sunday Long Run; it is logged as cross-training costed as hiking', () => {
    setup();
    autoProcessActivities([item('hike-1', 'HIKING', 6, 120, 12)], () => {});
    expect(wk().rated['W1-long-0']).toBeUndefined();
    expect(Object.keys(wk().rated)).toEqual([]);
    expect(wk().garminMatched!['hike-1']).toBe('garmin-hike-1');
    const excess = wk().unspentLoadItems!.find(u => u.garminId === 'hike-1');
    expect(excess?.sport).toBe('hiking');
  });

  it('a row on the Threshold day does not take the Threshold', () => {
    setup();
    autoProcessActivities([item('row-1', 'ROWING', 3, 40, 8)], () => {});
    expect(wk().rated['W1-threshold-0']).toBeUndefined();
    expect(wk().garminMatched!['row-1']).toBe('garmin-row-1');
    expect(wk().unspentLoadItems!.find(u => u.garminId === 'row-1')?.sport).toBe('rowing');
  });

  it('a run still completes the same-day run slot', () => {
    setup();
    autoProcessActivities([item('run-1', 'RUNNING', 6, 95, 16)], () => {});
    expect(wk().garminMatched!['run-1']).toBe('W1-long-0');
    expect(wk().rated['W1-long-0']).toBeDefined();
  });
});

describe('pre-assigned pairings (matching screen)', () => {
  it('a walk proposed onto a run slot starts in the tray and saves to Excess Load', () => {
    setup();
    const walk = item('walk-1', 'WALKING', 6, 60, 5);
    const run = item('run-2', 'RUNNING', 0, 50, 8);
    const pairings: ProposedPairing[] = [
      { item: walk, proposedWorkoutId: 'W1-long-0', proposedWorkoutName: 'Long Run', confidence: 'medium', matchType: 'sport' },
      { item: run, proposedWorkoutId: 'W1-easy-0', proposedWorkoutName: 'Easy Run', confidence: 'high', matchType: 'run' },
    ];
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    let confirmed: Map<string, string | null> | null = null;
    let reduction: GarminPendingItem[] = [];
    showMatchingScreen(
      overlay, [walk, run], { 'walk-1': 'integrate', 'run-2': 'integrate' }, pairings, RUN_WEEK,
      (c, r) => { confirmed = c; reduction = r; }, () => {},
    );
    (overlay.querySelector('#ms-confirm') as HTMLButtonElement).click();
    expect(confirmed!.get('walk-1')).toBeNull();
    expect(reduction.map(i => i.garminId)).toEqual(['walk-1']);
    expect(confirmed!.get('run-2')).toBe('W1-easy-0');
  });

  it('the batch review never fills a run slot with a hike', () => {
    setup();
    const hike = item('hike-2', 'HIKING', 6, 120, 16);
    wk().garminPending = [hike];
    wk().garminMatched!['hike-2'] = '__pending__';
    showActivityReview([hike], () => {});
    const confirm = document.querySelector('#ms-confirm') as HTMLButtonElement;
    expect(confirm).toBeTruthy();
    confirm.click();
    document.querySelector<HTMLButtonElement>('#excess-popup-continue')?.click();
    expect(wk().rated['W1-long-0']).toBeUndefined();
    const runSlotIds = RUN_WEEK.map(w => w.id);
    expect(Object.keys(wk().rated).filter(k => runSlotIds.includes(k))).toEqual([]);
  });
});

describe('no phantom running slots in just-track or HYROX', () => {
  it('just-track: a walk on a weekday binds to no slot', () => {
    setup({ trackOnly: true });
    autoProcessActivities([item('walk-2', 'WALKING', 0, 45, 4)], () => {});
    expect(wk().rated).toEqual({});
    expect(wk().garminMatched!['walk-2']).toBe('garmin-walk-2');
  });

  it('just-track: even a run binds to no phantom slot', () => {
    setup({ trackOnly: true });
    autoProcessActivities([item('run-3', 'RUNNING', 0, 50, 8)], () => {});
    expect(wk().rated).toEqual({});
    expect(wk().garminMatched!['run-3']).toBe('garmin-run-3');
  });

  const HYROX_WEEK: Workout[] = [
    { id: 'H1-run-0', n: 'Easy Run', t: 'hyrox_run_easy', discipline: 'run', d: '40 min easy at 6:00/km (~6.7 km).', r: 4, rpe: 4, dayOfWeek: 0, estimatedDurationMin: 40 },
    { id: 'H1-station-0', n: 'Station Technique', t: 'hyrox_station_technique', discipline: 'station', d: '45 min', r: 6, rpe: 6, dayOfWeek: 2, estimatedDurationMin: 45 },
  ] as Workout[];

  it('HYROX: a walk binds to no slot, neither a HYROX session nor a phantom run', () => {
    setup({ eventType: 'hyrox', triWorkouts: HYROX_WEEK.map(w => ({ ...w })) });
    autoProcessActivities([item('walk-3', 'WALKING', 0, 45, 4)], () => {});
    expect(wk().rated).toEqual({});
    expect(wk().garminMatched!['walk-3']).toBe('garmin-walk-3');
  });

  it('HYROX: a run binds to the HYROX run session in wk.triWorkouts, not a phantom running slot', () => {
    setup({ eventType: 'hyrox', triWorkouts: HYROX_WEEK.map(w => ({ ...w })) });
    autoProcessActivities([item('run-4', 'RUNNING', 0, 40, 7)], () => {});
    expect(wk().garminMatched!['run-4']).toBe('H1-run-0');
    expect(Object.keys(wk().rated)).toEqual(['H1-run-0']);
  });
});
