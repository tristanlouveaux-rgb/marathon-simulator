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
import { collectWeekActivities } from '@/calculations/week-activity-log';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';

const PLAN_START = '2026-09-28'; // a Monday

/** A HYROX state built from the band defaults the onboarding initializer uses,
 *  with one extra session from the slider (4 runs) at the band's top hours, so
 *  week 1 holds two same-named Easy Runs (Wednesday and Friday) beside the
 *  Sunday Long Run (generator v18; before, the defaults gave Friday and Sunday
 *  Easy Runs). No erg access: with ergs, round 7 gives one of the two Easy
 *  Runs to a longer easy erg session. */
function hyroxState(tw: number, band: AbilityBand = 'intermediate', extraRuns = 1): SimulatorState {
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
    stationAccess: { sled: 'always', skiErg: false, rowErg: false },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs + extraRuns,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: extraRuns > 0 ? HYROX_HOURS_RANGE[band].max : HYROX_HOURS_RANGE[band].default,
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
    const [wed, fri] = easyRuns(s.wks[0]);
    expect(wed.id).toBe('W1-hyrox_run_easy-0');
    expect(fri.id).toBe('W1-hyrox_run_easy-1');
  });
});

describe('Mark as Done on one of two same-named sessions', () => {
  it('Wednesday Easy Run done leaves the Friday Easy Run not done', () => {
    const s = hyroxState(16);
    setState(s);
    const wk = getMutableState().wks[0];
    const [fri, sun] = easyRuns(wk); // Wednesday, Friday
    expect([fri.dayOfWeek, sun.dayOfWeek]).toEqual([2, 4]);

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
      runRow({ garmin_id: 'strava-FRI', start_time: new Date(2026, 8, 30, 12, 0, 0).toISOString(), duration_sec: sec, distance_m: km * 1000 }), // Wednesday
      runRow({ garmin_id: 'strava-SUN', start_time: new Date(2026, 9, 2, 12, 0, 0).toISOString(), duration_sec: sec, distance_m: km * 1000 }), // Friday
    ]);

    expect(wk.garminMatched!['strava-FRI']).toBe(fri.id);
    expect(wk.garminMatched!['strava-SUN']).toBe(sun.id);
    expect(wk.garminActuals![fri.id!].garminId).toBe('strava-FRI');
    expect(wk.garminActuals![sun.id!].garminId).toBe('strava-SUN');
  });
});

describe('v13 → v14 regen re-keys name-keyed slot entries', () => {
  /** The same plan as generator v13 stored it: no session ids. */
  function v13State(extraRuns = 1): SimulatorState {
    const s = hyroxState(16, 'intermediate', extraRuns);
    for (const wk of s.wks) for (const w of wk.triWorkouts ?? []) delete w.id;
    s.hyroxConfig!.generatorVersion = 13;
    return s;
  }

  it('a rating on the week\'s only Easy Run moves to that session\'s new id', () => {
    const s = v13State(0); // the band defaults: weeks with one Easy Run
    const idx = s.wks.findIndex(wk => (wk.triWorkouts ?? []).filter(w => w.n === 'Easy Run').length === 1);
    expect(idx).toBeGreaterThanOrEqual(0);
    s.wks[idx].rated = { 'Easy Run': 5 };

    expect(applyHyroxGeneratorRegen(s)).toBe(true);

    const easy = s.wks[idx].triWorkouts!.find(w => w.n === 'Easy Run')!;
    expect(easy.id).toMatch(/^W\d+-hyrox_run_easy-0$/);
    expect(s.wks[idx].rated).toEqual({ [easy.id!]: 5 });
    expect(s.hyroxConfig!.generatorVersion).toBe(HYROX_GENERATOR_VERSION);
  });

  it('with two Easy Runs, a synced run follows the session on its own day; a bare rating stays under the name', () => {
    const s = v13State();
    const wk = s.wks[0];
    const sundayStart = new Date(2026, 9, 2, 12, 0, 0).toISOString(); // Friday, the second Easy Run's day
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

  /** Week 1 of a v13 plan holding a synced Tuesday run under the shared name 'Easy Run' (Easy Runs are Wed and Fri). */
  function v13WithTuesdayEasyRun(): { s: SimulatorState; tuesday: string } {
    const s = v13State();
    const wk = s.wks[0];
    const tuesday = new Date(2026, 8, 29, 12, 0, 0).toISOString();
    wk.garminActuals = {
      'Easy Run': { garminId: 'strava-TUE', startTime: tuesday, distanceKm: 5, durationSec: 2100, avgPaceSecKm: 420, avgHR: 140, maxHR: 160, calories: 300 },
    };
    wk.garminMatched = { 'strava-TUE': 'Easy Run' };
    wk.rated = { 'Easy Run': 4 };
    return { s, tuesday };
  }

  it('a synced run under a shared name on a day with neither session goes to Activity Review', () => {
    const { s, tuesday } = v13WithTuesdayEasyRun();
    applyHyroxGeneratorRegen(s);
    setState(s);
    const wk = getMutableState().wks[0];
    const [fri, sun] = easyRuns(wk);

    // Off the name key, onto the review queue, with its rating.
    expect(wk.garminActuals).toEqual({});
    expect(wk.rated).toEqual({});
    expect(wk.garminMatched).toEqual({ 'strava-TUE': '__pending__' });
    expect(wk.garminPending).toEqual([expect.objectContaining({
      garminId: 'strava-TUE', appType: 'run', startTime: tuesday, durationSec: 2100, distanceM: 5000, avgHR: 140,
    })]);
    expect(collectWeekActivities(wk)).toContainEqual(expect.objectContaining({ badge: 'pending', garminId: 'strava-TUE' }));
    expect(DONE_LABELS).not.toContain(deriveWorkoutStatus(fri, wk, ctx(6)).label);
    expect(DONE_LABELS).not.toContain(deriveWorkoutStatus(sun, wk, ctx(6)).label);

    // The next sync leaves the decision to review: no second queue entry, no slot bound.
    matchAndAutoComplete([runRow({ garmin_id: 'strava-TUE', start_time: tuesday, duration_sec: 2100, distance_m: 5000 })]);
    expect(wk.garminMatched!['strava-TUE']).toBe('__pending__');
    expect(wk.garminPending!.filter(p => p.garminId === 'strava-TUE')).toHaveLength(1);

    // Mark as Done on Friday's run adds one record; the Tuesday run is not counted beside it.
    openHyroxWorkoutDetail(fri, 0);
    (document.querySelector('#hx-detail-mark-done') as HTMLButtonElement).click();
    expect(Object.keys(wk.garminActuals!)).toEqual([fri.id]);
  });

  it('a legacy added Easy Run on the same day as the generated one: the synced run goes to review', () => {
    const s = v13State();
    const wk = s.wks[0];
    const [genFri] = easyRuns(wk);
    wk.triWorkouts!.push({ ...genFri, addedManually: true } as Workout); // same name, same day, no id
    const friday = new Date(2026, 8, 30, 12, 0, 0).toISOString(); // Wednesday, genFri's day
    wk.garminActuals = {
      'Easy Run': { garminId: 'strava-FRI', startTime: friday, distanceKm: 5, durationSec: 2100, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null },
    };
    wk.garminMatched = { 'strava-FRI': 'Easy Run' };

    applyHyroxGeneratorRegen(s);

    expect(wk.triWorkouts!.filter(w => w.n === 'Easy Run' && w.dayOfWeek === 2)).toHaveLength(2);
    expect(wk.garminActuals).toEqual({});
    expect(wk.garminMatched).toEqual({ 'strava-FRI': '__pending__' });
    expect(wk.garminPending!.map(p => p.garminId)).toEqual(['strava-FRI']);
  });

  it('in a past week the queued run is logged once as an activity of that week', () => {
    const { s } = v13WithTuesdayEasyRun();
    s.w = 3;
    applyHyroxGeneratorRegen(s);
    setState(s);
    matchAndAutoComplete([]);
    const wk = getMutableState().wks[0];
    expect(wk.garminMatched!['strava-TUE']).toBe('garmin-strava-TUE');
    expect(wk.adhocWorkouts!.map(w => w.id)).toContain('garmin-strava-TUE');
    expect(Object.keys(wk.garminActuals!)).toEqual(['garmin-strava-TUE']);
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
