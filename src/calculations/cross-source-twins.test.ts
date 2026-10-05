/**
 * Apple/Strava twin collapse (ITEM S1, 2026-10-05).
 *
 * With Strava connected, Apple Health workouts are no longer ingested. Installs
 * that ran both before that hold an Apple copy next to the Strava copy of the
 * same session, and the session counts twice. `collapseAppleStravaTwins`
 * removes the Apple copy (Strava is canonical) and keeps Apple-only sessions.
 *
 * Fixtures model what the matcher writes: an adhoc card `garmin-<id>` plus an
 * actual under the same key, pending records, excess (unspent) records, and the
 * garminMatched pointers. Apple ids follow the plugin format
 * `apple-<source>-<ISO start with fractional seconds>`.
 */

import { describe, it, expect } from 'vitest';
import {
  collapseAppleStravaTwins,
  dropAppleRowsWithStravaTwin,
  isSameSession,
  appleIdStartMs,
  TWIN_START_WINDOW_MS,
} from './cross-source-twins';
import { computeWeekRawTSS } from './fitness-model';
import type { GarminActivityRow } from './activity-matcher';

type Wk = any;

function week(): Wk {
  return {
    w: 1, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, unspentLoadItems: [], extraRunLoad: 0,
    adhocWorkouts: [], garminActuals: {}, garminPending: [], garminMatched: {}, garminReviewChoices: {},
    actualTSS: 321,
  };
}

function state(...wks: Wk[]): any {
  return { wks, w: wks.length };
}

const appleId = (iso: string, src = 'A1B2C3D4-0000-4000-8000-ABCDEF012345') => `apple-${src}-${iso}`;
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

interface Rec { start: string; durationSec: number; type: string; iTrimp?: number; t?: string }

/** Adhoc card + actual + pointer, the shape of a logged / overflow session. */
function addAdhoc(wk: Wk, gid: string, r: Rec): void {
  const key = `garmin-${gid}`;
  wk.adhocWorkouts.push({
    id: key, t: r.t ?? 'cross', n: r.type, d: `${Math.round(r.durationSec / 60)}min`, r: 5, rpe: 5,
    garminTimestamp: r.start, garminDurationMin: Math.round(r.durationSec / 60), iTrimp: r.iTrimp ?? null,
  });
  wk.garminActuals[key] = {
    garminId: gid, startTime: r.start, durationSec: r.durationSec, distanceKm: 0, avgPaceSecKm: null,
    avgHR: null, maxHR: null, calories: null, iTrimp: r.iTrimp ?? null, activityType: r.type, displayName: r.type,
  };
  wk.garminMatched[gid] = key;
}

function addPending(wk: Wk, gid: string, r: Rec, pointer = '__pending__'): void {
  wk.garminPending.push({
    garminId: gid, activityType: r.type, appType: 'gym', startTime: r.start, durationSec: r.durationSec,
    distanceM: null, avgHR: null, maxHR: null, aerobicEffect: null, anaerobicEffect: null, garminRpe: null,
    calories: null, iTrimp: r.iTrimp ?? null,
  });
  wk.garminMatched[gid] = pointer;
}

function addExcess(wk: Wk, gid: string, r: Rec): void {
  wk.unspentLoadItems.push({
    garminId: gid, displayName: r.type, sport: 'cycling', durationMin: Math.round(r.durationSec / 60),
    aerobic: 1.5, anaerobic: 0.5, date: r.start.slice(0, 10), reason: 'overflow',
  });
}

/** Every Apple id anywhere in a week. */
function appleIdsIn(wk: Wk): string[] {
  const ids = new Set<string>();
  for (const a of Object.values(wk.garminActuals) as any[]) if (a.garminId.startsWith('apple-')) ids.add(a.garminId);
  for (const k of Object.keys(wk.garminActuals)) if (k.startsWith('garmin-apple-') && wk.garminActuals[k].garminId.startsWith('apple-')) ids.add(k);
  for (const w of wk.adhocWorkouts) if (w.id.startsWith('garmin-apple-') && !wk.garminActuals[w.id]?.garminId?.startsWith('strava-')) ids.add(w.id);
  for (const p of wk.garminPending) if (p.garminId.startsWith('apple-')) ids.add(p.garminId);
  for (const u of wk.unspentLoadItems) if (u.garminId.startsWith('apple-')) ids.add(u.garminId);
  for (const k of Object.keys(wk.garminMatched)) if (k.startsWith('apple-')) ids.add(k);
  return [...ids];
}

const RIDE_START = '2026-09-29T14:05:00.000Z';

describe('same-session rule (shared with cleanupDbDuplicates)', () => {
  const base = { startMs: Date.parse(RIDE_START), durationSec: 3600, activityType: 'CYCLING' };

  it('same type within the window is one session at any duration (paused recordings)', () => {
    expect(isSameSession(base, { ...base, startMs: base.startMs + TWIN_START_WINDOW_MS, durationSec: 900 })).toBe(true);
  });

  it('a start more than 10 minutes apart is a different session', () => {
    expect(isSameSession(base, { ...base, startMs: base.startMs + TWIN_START_WINDOW_MS + 1 })).toBe(false);
  });

  it('different types are one session only when durations are within 15%', () => {
    expect(isSameSession(base, { ...base, activityType: 'HIIT', durationSec: 3600 * 0.86 })).toBe(true);
    expect(isSameSession(base, { ...base, activityType: 'HIIT', durationSec: 3600 * 0.85 })).toBe(false);
  });

  it('recovers the start time from an Apple id', () => {
    expect(appleIdStartMs(appleId('2026-09-29T14:05:00.512Z'))).toBe(Date.parse('2026-09-29T14:05:00.512Z'));
    expect(appleIdStartMs('apple-nodate')).toBeNaN();
  });
});

describe('collapseAppleStravaTwins', () => {
  it('a ride recorded by both sources keeps the Strava copy and counts once', () => {
    const apple = appleId(plus(RIDE_START, 400));
    const wk = week();
    addAdhoc(wk, 'strava-101', { start: RIDE_START, durationSec: 3600, type: 'CYCLING', iTrimp: 6000 });
    addAdhoc(wk, apple, { start: plus(RIDE_START, 400), durationSec: 3550, type: 'CYCLING', iTrimp: 8000 });
    addPending(wk, apple, { start: plus(RIDE_START, 400), durationSec: 3550, type: 'CYCLING' }, `garmin-${apple}`);
    addExcess(wk, apple, { start: RIDE_START, durationSec: 3550, type: 'Cycling' });
    const s = state(wk);

    const control = week();
    addAdhoc(control, 'strava-101', { start: RIDE_START, durationSec: 3600, type: 'CYCLING', iTrimp: 6000 });
    expect(computeWeekRawTSS(wk, wk.rated)).toBeGreaterThan(computeWeekRawTSS(control, control.rated));

    const res = collapseAppleStravaTwins(s);

    expect(res.removed).toEqual([apple]);
    expect(appleIdsIn(wk)).toEqual([]);
    expect(wk.garminActuals['garmin-strava-101'].garminId).toBe('strava-101');
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(computeWeekRawTSS(control, control.rated));
    expect(s.supersededGarminIds).toEqual([apple]);
  });

  it('a slot-bound Apple run hands its slot to the Strava copy instead of un-rating it', () => {
    const start = '2026-09-30T06:30:00.000Z';
    const apple = appleId(plus(start, 400));
    const wk = week();
    wk.rated['W1-easy-0'] = 4;
    wk.garminActuals['W1-easy-0'] = {
      garminId: apple, startTime: plus(start, 400), durationSec: 2700, distanceKm: 8, avgPaceSecKm: 337,
      avgHR: 160, maxHR: 175, calories: 600, iTrimp: 9000, activityType: 'RUNNING', workoutName: 'Easy Run', plannedType: 'easy',
    };
    wk.garminMatched[apple] = 'W1-easy-0';
    addPending(wk, apple, { start: plus(start, 400), durationSec: 2700, type: 'RUNNING' }, 'W1-easy-0');
    addAdhoc(wk, 'strava-202', { start, durationSec: 2760, type: 'RUNNING', iTrimp: 7000, t: 'easy' });
    addPending(wk, 'strava-202', { start, durationSec: 2760, type: 'RUNNING', iTrimp: 7000 }, 'garmin-strava-202');
    addExcess(wk, 'strava-202', { start, durationSec: 2760, type: 'Run' });
    const s = state(wk);

    const res = collapseAppleStravaTwins(s);

    expect(res).toEqual({ removed: [apple], rebound: 1 });
    const slot = wk.garminActuals['W1-easy-0'];
    expect(slot.garminId).toBe('strava-202');
    expect(slot.iTrimp).toBe(7000);
    expect(slot.durationSec).toBe(2760);
    expect(slot.workoutName).toBe('Easy Run');
    expect(slot.plannedType).toBe('easy');
    expect(wk.rated['W1-easy-0']).toBe(4);
    expect(wk.garminMatched['strava-202']).toBe('W1-easy-0');
    expect(wk.garminActuals['garmin-strava-202']).toBeUndefined();
    expect(wk.adhocWorkouts.map((w: any) => w.id)).toEqual([]);
    expect(wk.unspentLoadItems).toEqual([]);
    expect(appleIdsIn(wk)).toEqual([]);
    // Counts once, at the Strava value.
    const control = week();
    control.garminActuals['W1-easy-0'] = { ...slot };
    control.rated['W1-easy-0'] = 4;
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(computeWeekRawTSS(control, control.rated));
  });

  it('a strength session queued from Apple collapses into the logged Strava copy', () => {
    const start = '2026-10-01T17:30:00.000Z';
    const apple = appleId(plus(start, 400));
    const wk = week();
    addAdhoc(wk, 'strava-303', { start, durationSec: 2700, type: 'STRENGTH_TRAINING', t: 'gym' });
    addPending(wk, apple, { start: plus(start, 400), durationSec: 2400, type: 'STRENGTH_TRAINING' });
    wk.garminReviewChoices[apple] = 'integrate';
    const s = state(wk);

    collapseAppleStravaTwins(s);

    expect(appleIdsIn(wk)).toEqual([]);
    expect(wk.garminReviewChoices[apple]).toBeUndefined();
    expect(wk.garminPending).toEqual([]);
    expect(wk.garminActuals['garmin-strava-303']).toBeDefined();
  });

  it('Strava HIIT and Apple CARDIO for one class are one session (durations within 15%)', () => {
    const start = '2026-10-02T07:00:00.000Z';
    const apple = appleId(plus(start, 400));
    const wk = week();
    addAdhoc(wk, 'strava-404', { start, durationSec: 2700, type: 'HIIT', iTrimp: 5000, t: 'gym' });
    addAdhoc(wk, apple, { start: plus(start, 400), durationSec: 2600, type: 'CARDIO', iTrimp: 5200 });
    addExcess(wk, apple, { start, durationSec: 2600, type: 'Cardio' });
    const s = state(wk);

    collapseAppleStravaTwins(s);

    expect(appleIdsIn(wk)).toEqual([]);
    expect(Object.keys(wk.garminActuals)).toEqual(['garmin-strava-404']);
  });

  it('a paused ride (Apple excludes the pause, Strava counts elapsed time) is still one ride', () => {
    const apple = appleId(plus(RIDE_START, 400));
    const wk = week();
    addAdhoc(wk, 'strava-505', { start: RIDE_START, durationSec: 5400, type: 'CYCLING', iTrimp: 9000 });
    addAdhoc(wk, apple, { start: plus(RIDE_START, 400), durationSec: 4000, type: 'CYCLING', iTrimp: 8000 });
    const s = state(wk);

    collapseAppleStravaTwins(s);

    expect(appleIdsIn(wk)).toEqual([]);
    expect(Object.keys(wk.garminActuals)).toEqual(['garmin-strava-505']);
  });

  it('an Apple-only session with no Strava twin stays as history', () => {
    const wk = week();
    addAdhoc(wk, 'strava-606', { start: RIDE_START, durationSec: 3600, type: 'CYCLING' });
    const swim = appleId('2026-09-29T06:00:00.000Z');
    addAdhoc(wk, swim, { start: '2026-09-29T06:00:00.000Z', durationSec: 2400, type: 'SWIMMING', iTrimp: 4000 });
    const s = state(wk);

    const res = collapseAppleStravaTwins(s);

    expect(res.removed).toEqual([]);
    expect(wk.garminActuals[`garmin-${swim}`].garminId).toBe(swim);
    expect(s.supersededGarminIds).toBeUndefined();
  });

  it('a short Apple walk just before a Strava run, and a strength session hours after a ride, stay separate', () => {
    const runStart = '2026-10-03T08:00:00.000Z';
    const walk = appleId(plus(runStart, -30_000));
    const strength = appleId('2026-09-29T17:30:00.000Z');
    const wk = week();
    addAdhoc(wk, 'strava-707', { start: runStart, durationSec: 2700, type: 'RUNNING', t: 'easy' });
    addAdhoc(wk, walk, { start: plus(runStart, -30_000), durationSec: 480, type: 'WALKING' });
    addAdhoc(wk, 'strava-708', { start: RIDE_START, durationSec: 3600, type: 'CYCLING' });
    addAdhoc(wk, strength, { start: '2026-09-29T17:30:00.000Z', durationSec: 3500, type: 'STRENGTH_TRAINING', t: 'gym' });
    const s = state(wk);

    expect(collapseAppleStravaTwins(s).removed).toEqual([]);
    expect(appleIdsIn(wk).sort()).toEqual([`garmin-${strength}`, `garmin-${walk}`, strength, walk].sort());
  });

  it('a past-week Apple run logged as a bare adhoc card (no actual) is matched as a run', () => {
    const start = '2026-09-21T07:00:00.000Z';
    const apple = appleId(plus(start, 400));
    const wk = week();
    addAdhoc(wk, 'strava-808', { start, durationSec: 3600, type: 'RUNNING', t: 'easy' });
    // Paused: 30% shorter, so only the type branch can match it.
    wk.adhocWorkouts.push({ id: `garmin-${apple}`, t: 'easy', n: 'Run', d: '42min', r: 5, rpe: 5, garminTimestamp: plus(start, 400), garminDurationMin: 42 });
    wk.garminMatched[apple] = `garmin-${apple}`;
    const s = state(wk);

    collapseAppleStravaTwins(s);

    expect(wk.adhocWorkouts.map((w: any) => w.id)).toEqual(['garmin-strava-808']);
    expect(appleIdsIn(wk)).toEqual([]);
  });

  it('an Apple adhoc the Strava upgrade rewrote in place is kept, and its excess record follows the Strava id', () => {
    const apple = appleId(plus(RIDE_START, 400));
    const key = `garmin-${apple}`;
    const wk = week();
    wk.adhocWorkouts.push({ id: key, t: 'cross', n: 'Ride', d: '60min', garminTimestamp: plus(RIDE_START, 400), garminDurationMin: 60 });
    wk.garminActuals[key] = {
      garminId: 'strava-909', startTime: RIDE_START, durationSec: 3600, distanceKm: 25, avgPaceSecKm: null,
      avgHR: 140, maxHR: 160, calories: 700, iTrimp: 6000, activityType: 'CYCLING', displayName: 'Ride',
    };
    wk.garminMatched[apple] = key;
    wk.garminMatched['strava-909'] = key;
    addExcess(wk, apple, { start: RIDE_START, durationSec: 3600, type: 'Cycling' });
    const s = state(wk);

    const res = collapseAppleStravaTwins(s);

    expect(res.removed).toEqual([apple]);
    expect(wk.adhocWorkouts.map((w: any) => w.id)).toEqual([key]);
    expect(wk.garminActuals[key].garminId).toBe('strava-909');
    expect(wk.garminMatched[apple]).toBeUndefined();
    expect(wk.garminMatched['strava-909']).toBe(key);
    expect(wk.unspentLoadItems.map((u: any) => u.garminId)).toEqual(['strava-909']);
  });

  it('when both copies completed plan slots, the Apple completion is cleared as a phantom', () => {
    const start = '2026-10-01T17:30:00.000Z';
    const apple = appleId(plus(start, 400));
    const wk = week();
    wk.rated['W1-gym-0'] = 6;
    wk.rated['W1-gym-1'] = 6;
    wk.garminActuals['W1-gym-0'] = { garminId: 'strava-111', startTime: start, durationSec: 2700, distanceKm: 0, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'STRENGTH_TRAINING' };
    wk.garminActuals['W1-gym-1'] = { garminId: apple, startTime: plus(start, 400), durationSec: 2400, distanceKm: 0, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'STRENGTH_TRAINING' };
    wk.garminMatched['strava-111'] = 'W1-gym-0';
    wk.garminMatched[apple] = 'W1-gym-1';
    wk.workoutMods.push({ name: 'W1-gym-1', modReason: 'Garmin: Strength' });
    const s = state(wk);

    const res = collapseAppleStravaTwins(s);

    expect(res).toEqual({ removed: [apple], rebound: 0 });
    expect(wk.garminActuals['W1-gym-1']).toBeUndefined();
    expect(wk.rated['W1-gym-1']).toBeUndefined();
    expect(wk.workoutMods).toEqual([]);
    expect(wk.rated['W1-gym-0']).toBe(6);
  });

  it('a session straddling Sunday/Monday midnight collapses across weeks', () => {
    const sun = '2026-09-27T23:58:00.000Z';
    const mon = '2026-09-28T00:02:00.000Z';
    const apple = appleId(mon);
    const w1 = week();
    const w2 = week();
    addAdhoc(w1, 'strava-121', { start: sun, durationSec: 3600, type: 'CYCLING' });
    addAdhoc(w2, apple, { start: mon, durationSec: 3300, type: 'CYCLING' });
    const s = state(w1, w2);

    collapseAppleStravaTwins(s);

    expect(appleIdsIn(w2)).toEqual([]);
    expect(Object.keys(w1.garminActuals)).toEqual(['garmin-strava-121']);
  });

  it('a triathlon match link on the Apple copy follows the Strava copy', () => {
    const apple = appleId(plus(RIDE_START, 400));
    const wk = week();
    addAdhoc(wk, 'strava-131', { start: RIDE_START, durationSec: 3600, type: 'CYCLING' });
    addAdhoc(wk, apple, { start: plus(RIDE_START, 400), durationSec: 3500, type: 'CYCLING' });
    wk.triWorkouts = [{ id: 'W1-bike-0', t: 'bike', n: 'Endurance ride', discipline: 'bike', status: 'completed', matchedActivityId: `garmin-${apple}` }];
    const s = state(wk);

    collapseAppleStravaTwins(s);

    expect(wk.triWorkouts[0].matchedActivityId).toBe('garmin-strava-131');
  });

  it('drops the Apple copy from the leg-load ledger and the recovery impact log', () => {
    const apple = appleId(plus(RIDE_START, 400));
    const wk = week();
    addAdhoc(wk, 'strava-141', { start: RIDE_START, durationSec: 3600, type: 'CYCLING' });
    addAdhoc(wk, apple, { start: plus(RIDE_START, 400), durationSec: 3500, type: 'CYCLING' });
    const s = state(wk);
    s.recentLegLoads = [
      { load: 10, sport: 'cycling', sportLabel: 'Ride', timestampMs: Date.parse(RIDE_START), garminId: 'strava-141' },
      { load: 12, sport: 'cycling', sportLabel: 'Ride', timestampMs: Date.parse(RIDE_START), garminId: apple },
    ];
    s.sessionImpactLog = [{ garminId: apple, date: RIDE_START.slice(0, 10) }];

    collapseAppleStravaTwins(s);

    expect(s.recentLegLoads.map((e: any) => e.garminId)).toEqual(['strava-141']);
    expect(s.sessionImpactLog).toEqual([]);
  });

  it('is idempotent and never touches wk.actualTSS', () => {
    const apple = appleId(plus(RIDE_START, 400));
    const wk = week();
    addAdhoc(wk, 'strava-151', { start: RIDE_START, durationSec: 3600, type: 'CYCLING' });
    addAdhoc(wk, apple, { start: plus(RIDE_START, 400), durationSec: 3500, type: 'CYCLING' });
    const s = state(wk);

    expect(collapseAppleStravaTwins(s).removed).toHaveLength(1);
    const snapshot = JSON.stringify(s);
    expect(collapseAppleStravaTwins(s).removed).toHaveLength(0);
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(wk.actualTSS).toBe(321);
  });
});

describe('dropAppleRowsWithStravaTwin (ingest-time Strava-wins filter)', () => {
  const row = (garmin_id: string, start_time: string, duration_sec: number, activity_type: string): GarminActivityRow => ({
    garmin_id, start_time, duration_sec, activity_type,
    distance_m: null, avg_pace_sec_km: null, avg_hr: null, max_hr: null, calories: null, aerobic_effect: null, anaerobic_effect: null,
  });

  it('drops an Apple row whose session Strava holds in state, keeps an Apple-only row', () => {
    const wk = week();
    addAdhoc(wk, 'strava-161', { start: RIDE_START, durationSec: 5400, type: 'CYCLING' });
    const twin = row(appleId(plus(RIDE_START, 400)), plus(RIDE_START, 400), 4000, 'CYCLING');
    const only = row(appleId('2026-09-29T06:00:00.000Z'), '2026-09-29T06:00:00.000Z', 2400, 'SWIMMING');

    expect(dropAppleRowsWithStravaTwin([twin, only], [wk]).map(r => r.garmin_id)).toEqual([only.garmin_id]);
  });

  it('drops an Apple row whose Strava twin arrives in the same batch', () => {
    const strava = row('strava-171', RIDE_START, 2700, 'HIIT');
    const twin = row(appleId(plus(RIDE_START, 400)), plus(RIDE_START, 400), 2600, 'CARDIO');

    expect(dropAppleRowsWithStravaTwin([strava, twin], []).map(r => r.garmin_id)).toEqual(['strava-171']);
  });

  it('leaves an Apple-only user untouched', () => {
    const rows = [row(appleId(RIDE_START), RIDE_START, 3600, 'CYCLING')];
    expect(dropAppleRowsWithStravaTwin(rows, [week()])).toBe(rows);
  });
});
