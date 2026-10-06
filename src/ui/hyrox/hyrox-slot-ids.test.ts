// @vitest-environment jsdom
/**
 * HYROX sessions carry their own slot ids (cross-mode audit f1).
 *
 * Before the fix generateHyroxPlan / regenerateHyroxWeek emitted sessions with
 * no `id`, and every HYROX writer keys by `id ?? n`. A week's two 'Easy Run'
 * (or two 'Station Circuit') sessions shared one slot key: Mark as Done on one
 * showed both done, and the second synced run of the week found no free slot
 * and went to review. Older tests hid it with hand-written ids.
 *
 * Real generator, real detail modal and add-session modal (jsdom), real
 * matchAndAutoComplete, real version-bump regen. saveState and the plan-view
 * re-render are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/ui/hyrox/plan-view', () => ({ renderHyroxPlanView: vi.fn() }));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { openHyroxWorkoutDetail } from './workout-detail-modal';
import { openHyroxAddSessionModal } from './add-session-modal';
import { deriveWorkoutStatus, type WeekStatusContext } from '@/ui/workout-status';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { parseDistanceKm } from '@/calculations/matching';
import { applyHyroxGeneratorRegen } from '@/state/hyrox-plan-regen';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';

const PLAN_START = '2026-09-28'; // a Monday

/** A HYROX state built from the band defaults the onboarding initializer uses. */
function hyroxState(tw: number, band: AbilityBand = 'intermediate'): SimulatorState {
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = PLAN_START;
  s.w = 1;
  s.tw = tw;
  s.hyroxConfig = {
    format: 'open_singles',
    athleteBand: band,
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    generatorVersion: HYROX_GENERATOR_VERSION,
  };
  s.wks = generateHyroxPlan(s);
  return s;
}

/** The status chip's done labels: 'Logged' when the session has an activity record, 'Done' otherwise. */
const DONE_LABELS = ['Done', 'Logged'];

const ctx = (actualToday: number): WeekStatusContext => ({
  viewWeek: 1, currentWeek: 1, actualToday, weekEnded: false, firstTrackedDow: 0,
});

/** Week 1's two 'Easy Run' sessions, in day order. */
function easyRuns(wk: Week): Workout[] {
  return (wk.triWorkouts ?? []).filter(w => w.n === 'Easy Run').sort((a, b) => a.dayOfWeek! - b.dayOfWeek!);
}

function runRow(over: Partial<GarminActivityRow>): GarminActivityRow {
  return {
    garmin_id: 'strava-1', activity_type: 'RUNNING', start_time: new Date(2026, 9, 2, 12, 0, 0).toISOString(),
    duration_sec: 2100, distance_m: 0, avg_pace_sec_km: null, avg_hr: null, max_hr: null, calories: null,
    aerobic_effect: null, anaerobic_effect: null, iTrimp: null, hrZones: null, ...over,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '';
});

describe('generated HYROX sessions carry a slot id unique within their week', () => {
  for (const tw of [10, 16, 30]) {
    it(`${tw}-week intermediate plan`, () => {
      const s = hyroxState(tw);
      expect(s.wks.length).toBe(tw);
      for (const wk of s.wks) {
        const ids = (wk.triWorkouts ?? []).map(w => w.id);
        expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
      }
      // The plan still has same-named sessions in a week: the ids are what keep them apart.
      expect(s.wks.some(wk => easyRuns(wk).length === 2)).toBe(true);
    });
  }

  it('ids follow the triathlon engine format W{week}-{type}-{idx}', () => {
    const s = hyroxState(16);
    const [fri, sun] = easyRuns(s.wks[0]);
    expect(fri.id).toBe('W1-hyrox_run_easy-0');
    expect(sun.id).toBe('W1-hyrox_run_easy-1');
  });
});

describe('Mark as Done on one of two same-named sessions', () => {
  it('Friday Easy Run done leaves the Sunday Easy Run not done', () => {
    const s = hyroxState(16);
    setState(s);
    const wk = getMutableState().wks[0];
    const [fri, sun] = easyRuns(wk);
    expect([fri.dayOfWeek, sun.dayOfWeek]).toEqual([4, 6]);

    openHyroxWorkoutDetail(fri, 0);
    (document.querySelector('#hx-detail-mark-done') as HTMLButtonElement).click();

    expect(DONE_LABELS).toContain(deriveWorkoutStatus(fri, wk, ctx(5)).label);
    expect(DONE_LABELS).not.toContain(deriveWorkoutStatus(sun, wk, ctx(5)).label);
    expect(Object.keys(wk.rated)).toEqual([fri.id]);
    expect(Object.keys(wk.garminActuals ?? {})).toEqual([fri.id]);
  });
});

describe('two synced Easy Runs on their own days', () => {
  it('each binds to its own slot; the second is not left pending review', () => {
    const s = hyroxState(16);
    setState(s);
    const wk = getMutableState().wks[0];
    const [fri, sun] = easyRuns(wk);
    const km = parseDistanceKm(fri.d ?? '');
    const sec = fri.estimatedDurationMin! * 60;

    matchAndAutoComplete([
      runRow({ garmin_id: 'strava-FRI', start_time: new Date(2026, 9, 2, 12, 0, 0).toISOString(), duration_sec: sec, distance_m: km * 1000 }),
      runRow({ garmin_id: 'strava-SUN', start_time: new Date(2026, 9, 4, 12, 0, 0).toISOString(), duration_sec: sec, distance_m: km * 1000 }),
    ]);

    expect(wk.garminMatched!['strava-FRI']).toBe(fri.id);
    expect(wk.garminMatched!['strava-SUN']).toBe(sun.id);
    expect(wk.garminActuals![fri.id!].garminId).toBe('strava-FRI');
    expect(wk.garminActuals![sun.id!].garminId).toBe('strava-SUN');
  });
});

describe('v13 → v14 regen re-keys name-keyed slot entries', () => {
  /** The same plan as generator v13 stored it: no session ids. */
  function v13State(): SimulatorState {
    const s = hyroxState(16);
    for (const wk of s.wks) for (const w of wk.triWorkouts ?? []) delete w.id;
    s.hyroxConfig!.generatorVersion = 13;
    return s;
  }

  it('a rating on the week\'s only Easy Run moves to that session\'s new id', () => {
    const s = v13State();
    const idx = s.wks.findIndex(wk => (wk.triWorkouts ?? []).filter(w => w.n === 'Easy Run').length === 1);
    expect(idx).toBeGreaterThanOrEqual(0);
    s.wks[idx].rated = { 'Easy Run': 5 };

    expect(applyHyroxGeneratorRegen(s)).toBe(true);

    const easy = s.wks[idx].triWorkouts!.find(w => w.n === 'Easy Run')!;
    expect(easy.id).toMatch(/^W\d+-hyrox_run_easy-0$/);
    expect(s.wks[idx].rated).toEqual({ [easy.id!]: 5 });
    expect(s.hyroxConfig!.generatorVersion).toBe(HYROX_GENERATOR_VERSION);
  });

  it('with two Easy Runs, a synced run follows the session on its own day; a bare rating is left for review', () => {
    const s = v13State();
    const wk = s.wks[0];
    const sundayStart = new Date(2026, 9, 4, 12, 0, 0).toISOString();
    wk.garminActuals = {
      'Easy Run': { garminId: 'strava-SUN', startTime: sundayStart, distanceKm: 5, durationSec: 2100, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null },
    };
    wk.garminMatched = { 'strava-SUN': 'Easy Run' };
    wk.rated = { 'Easy Run': 4 };
    const w2 = s.wks[1];
    w2.rated = { 'Easy Run': 3 }; // week 2 also has two Easy Runs, no activity to place it

    applyHyroxGeneratorRegen(s);

    const [, sun] = easyRuns(wk);
    expect(Object.keys(wk.garminActuals)).toEqual([sun.id]);
    expect(wk.garminMatched).toEqual({ 'strava-SUN': sun.id });
    expect(wk.rated).toEqual({ [sun.id!]: 4 });
    expect(easyRuns(w2).length).toBe(2);
    expect(w2.rated).toEqual({ 'Easy Run': 3 });
  });

  it('a session added in the app keeps its adhoc- id through the regen', () => {
    const s = hyroxState(16);
    setState(s);
    openHyroxAddSessionModal(() => {});
    (document.querySelector('#hx-add-confirm') as HTMLButtonElement).click();

    const ms = getMutableState();
    const generated = new Set(generateHyroxPlan(ms)[0].triWorkouts!.map(w => w.id));
    const added = ms.wks[0].triWorkouts!.find(w => !generated.has(w.id))!;
    expect(added).toBeDefined();
    expect(added.id).toMatch(/^adhoc-/);

    ms.hyroxConfig!.generatorVersion = 13;
    expect(applyHyroxGeneratorRegen(ms)).toBe(true);
    expect(ms.wks[0].triWorkouts!.some(w => w.id === added.id)).toBe(true);
  });

  it('a legacy added session (no id) is carried with an adhoc- id instead of deleted', () => {
    const s = v13State();
    const legacy = { ...s.wks[0].triWorkouts!.find(w => w.n === 'Tempo Run')!, n: 'Extra Tempo', addedManually: true } as Workout;
    s.wks[0].triWorkouts!.push(legacy);
    s.wks[0].rated = { 'Extra Tempo': 6 };

    applyHyroxGeneratorRegen(s);

    const carried = s.wks[0].triWorkouts!.find(w => w.n === 'Extra Tempo')!;
    expect(carried.id).toMatch(/^adhoc-/);
    expect(s.wks[0].rated).toEqual({ [carried.id!]: 6 });
  });
});
