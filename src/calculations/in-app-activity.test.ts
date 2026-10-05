/**
 * Audit B9: in-app GPS runs and Mark as Done count as load, once, and a watch
 * copy of the same session supersedes the in-app record instead of adding to it.
 *
 * The load assertions run the real fitness-model functions on the exact week
 * shapes the app writes. The dedup assertions run the real matchAndAutoComplete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { matchAndAutoComplete, reconcileCrossSourceDuplicates, type GarminActivityRow } from '@/calculations/activity-matcher';
import {
  computeWeekTSS, computeWeekRawTSS, computeTodaySignalBTSS, estimateWorkoutDurMin,
} from '@/calculations/fitness-model';
import { TL_PER_MIN } from '@/constants';
import { computePlanAdherence } from '@/calculations/plan-adherence';
import type { GarminActual, GpsRecording, Week, Workout } from '@/types';
import { collectWeekActivities } from '@/calculations/week-activity-log';
import {
  buildGpsRunActual, buildPlannedRunActual, manualCompletionStartIso, writeInAppActual,
  findInAppRunToSupersede, isSameRecordedSession, isSameCompletedSession, isInAppRunActual,
  gpsRecordingStartIso, dropInAppActual, recordPlannedRunDone, isPlanCardRunType,
} from './in-app-activity';

const PLAN_START = '2026-09-28'; // a Monday
const EASY_SLOT = { workoutName: 'Easy Run', plannedType: 'easy' };

function emptyWeek(w: number): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  } as unknown as Week;
}

function gpsRecording(over: Partial<GpsRecording> = {}): GpsRecording {
  const startMs = Date.parse('2026-09-30T07:00:00Z');
  return {
    id: `gps_${startMs}`,
    workoutName: 'Just Run',
    week: 1,
    date: new Date(startMs + 2700 * 1000).toISOString(),
    route: [{ lat: 51.5, lng: -0.1, altitude: null, accuracy: 5, speed: null, timestamp: startMs }],
    splits: [],
    totalDistance: 8000,
    totalElapsed: 2700,
    averagePace: 337.5,
    ...over,
  };
}

/** A synced no-HR copy of a session: the reference "the same run from a watch without HR". */
function syncedNoHr(startTime: string, durationSec: number, distanceKm: number): GarminActual {
  return {
    garminId: 'apple-REF', startTime, distanceKm, durationSec,
    avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null,
    activityType: 'RUNNING', workoutName: 'Reference',
  };
}

function runRow(over: Partial<GarminActivityRow> = {}): GarminActivityRow {
  return {
    garmin_id: 'apple-RUN1',
    activity_type: 'RUNNING',
    start_time: '2026-09-30T07:02:00Z',
    duration_sec: 2760,
    distance_m: 8100,
    avg_pace_sec_km: 341,
    avg_hr: null,
    max_hr: null,
    calories: null,
    aerobic_effect: null,
    anaerobic_effect: null,
    iTrimp: null,
    hrZones: null,
    ...over,
  };
}

function baseState(weeks: number, currentWeek: number) {
  const s = getDefaultState();
  s.trackOnly = true; // no generated plan: every row reaches the supersede / adhoc / pending paths
  s.planStartDate = PLAN_START;
  s.w = currentWeek;
  s.wks = Array.from({ length: weeks }, (_, i) => emptyWeek(i + 1));
  return s;
}

describe('in-app GPS run counts as load (audit B9)', () => {
  it('an impromptu GPS run counts once in Signal A and weekly Signal B at its measured duration, not the flat 30-minute default', () => {
    const rec = gpsRecording();
    const wk = emptyWeek(1);
    // The shape recording-handler writes for an impromptu run: adhoc + rating + record.
    wk.adhocWorkouts = [{ n: 'Just Run', d: '8.0km', r: 5, t: 'easy', id: rec.id } as Workout];
    wk.rated[rec.id] = 7;
    writeInAppActual(wk, rec.id, buildGpsRunActual(rec, { rpe: 7, name: 'Just Run' }));

    const expected = Math.round(45 * TL_PER_MIN[7]); // 45 min measured at the rated RPE 7
    expect(computeWeekTSS(wk, wk.rated)).toBe(expected);
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(expected);
    expect(expected).not.toBe(Math.round(30 * TL_PER_MIN[5])); // the old flat 35
  });

  it('an in-app GPS run counts in the daily strain exactly like a synced no-HR run of the same session', () => {
    const rec = gpsRecording();
    const wk = emptyWeek(1);
    wk.rated[rec.id] = 7;
    writeInAppActual(wk, rec.id, buildGpsRunActual(rec, { rpe: 7, name: 'Just Run' }));

    const ref = emptyWeek(1);
    ref.rated.REF = 7;
    ref.garminActuals = { REF: syncedNoHr(gpsRecordingStartIso(rec), 2700, 8) };

    const day = '2026-09-30';
    expect(computeTodaySignalBTSS(wk, day)).toBeGreaterThan(0);
    expect(computeTodaySignalBTSS(wk, day)).toBe(computeTodaySignalBTSS(ref, day));
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(computeWeekRawTSS(ref, ref.rated));
  });

  it('a longer GPS run carries more load than a shorter one (load scales with the recording)', () => {
    const short = emptyWeek(1);
    const long = emptyWeek(1);
    const recS = gpsRecording({ totalElapsed: 1500, totalDistance: 5000 });
    const recL = gpsRecording({ totalElapsed: 7200, totalDistance: 21100 });
    short.rated[recS.id] = 6; long.rated[recL.id] = 6;
    writeInAppActual(short, recS.id, buildGpsRunActual(recS, { rpe: 6, name: 'Just Run' }));
    writeInAppActual(long, recL.id, buildGpsRunActual(recL, { rpe: 6, name: 'Just Run' }));
    expect(computeWeekRawTSS(long, long.rated)).toBeGreaterThan(computeWeekRawTSS(short, short.rated) * 4);
  });

  it('the GPS start is the first fix, else stop time minus elapsed time', () => {
    expect(gpsRecordingStartIso(gpsRecording())).toBe('2026-09-30T07:00:00.000Z');
    expect(gpsRecordingStartIso(gpsRecording({ route: [] }))).toBe('2026-09-30T07:00:00.000Z');
  });

  it('an in-app record leaves activityType null so forecast readers that filter on RUN skip it, while the load model reads it as a run', () => {
    const a = buildGpsRunActual(gpsRecording(), { rpe: 5, name: 'Just Run' });
    expect(a.activityType).toBeNull();
    expect(a.garminId.startsWith('guided-gps_')).toBe(true);
    expect(isInAppRunActual(a)).toBe(true);
  });
});

describe('Mark as Done records planned load at the rated RPE (audit B9)', () => {
  const easy: Workout = { n: 'Easy Run', t: 'easy', d: '8km', r: 3, rpe: 3, dayOfWeek: 2, id: 'W1-easy-0' } as Workout;

  it('a run marked done counts its planned duration at its rated RPE in Signal A and weekly Signal B', () => {
    const wk = emptyWeek(1);
    wk.rated[easy.id!] = 3;
    const durationMin = estimateWorkoutDurMin(easy, 6); // the plan card's planned dose
    writeInAppActual(wk, easy.id!, buildPlannedRunActual(easy, {
      rpe: 3, startTime: manualCompletionStartIso(PLAN_START, 1, 2, Date.parse('2026-10-04T20:00:00Z')), durationMin,
    }));
    const expected = Math.round(durationMin * TL_PER_MIN[3]);
    expect(expected).toBeGreaterThan(0);
    expect(computeWeekTSS(wk, wk.rated)).toBe(expected);
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(expected);
  });

  it('a run marked done lands in the daily strain on its planned day', () => {
    const wk = emptyWeek(1);
    wk.rated[easy.id!] = 3;
    writeInAppActual(wk, easy.id!, buildPlannedRunActual(easy, {
      rpe: 3, startTime: manualCompletionStartIso(PLAN_START, 1, 2, Date.parse('2026-10-04T20:00:00Z')), durationMin: 48,
    }));
    expect(computeTodaySignalBTSS(wk, '2026-09-30')).toBeGreaterThan(0); // Wednesday, the planned day
    expect(computeTodaySignalBTSS(wk, '2026-10-04')).toBe(0);            // not the day it was ticked
  });

  it('the completion stamp is the planned day at local noon, never later than now', () => {
    const thu = manualCompletionStartIso(PLAN_START, 1, 3, Date.parse('2026-10-10T12:00:00Z'));
    const d = new Date(thu);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([2026, 10, 1, 12]);
    const now = Date.parse('2026-09-29T08:00:00Z'); // Tuesday, before the Thursday session
    expect(manualCompletionStartIso(PLAN_START, 1, 3, now)).toBe(new Date(now).toISOString());
    expect(manualCompletionStartIso(undefined, 1, 3, now)).toBe(new Date(now).toISOString());
  });

  it('a synced actual already on the slot is kept (Strava canonical); dropInAppActual never removes it', () => {
    const wk = emptyWeek(1);
    const synced = { ...syncedNoHr('2026-09-30T07:00:00Z', 2700, 8), garminId: 'strava-9' };
    wk.garminActuals = { [easy.id!]: synced };
    const kept = writeInAppActual(wk, easy.id!, buildPlannedRunActual(easy, { rpe: 3, startTime: '2026-09-30T10:00:00Z', durationMin: 48 }));
    expect(kept.garminId).toBe('strava-9');
    expect(dropInAppActual(wk, easy.id!)).toBe(false);
    expect(wk.garminActuals[easy.id!].garminId).toBe('strava-9');
  });
});

describe('plan adherence counts planned completions only', () => {
  it('a run marked done counts as a planned completion; an impromptu GPS run outside the plan does not', () => {
    const s = baseState(2, 2);
    s.trackOnly = false;
    s.rw = 3;
    const rec = gpsRecording();
    const easy = { n: 'Easy Run', t: 'easy', d: '8km', r: 3, rpe: 3, dayOfWeek: 2 } as Workout;
    s.wks[0].adhocWorkouts = [{ n: 'Quick Run', d: '8.0km', r: 5, t: 'easy', id: rec.id } as Workout];
    s.wks[0].rated[rec.id] = 6;
    writeInAppActual(s.wks[0], rec.id, buildGpsRunActual(rec, { rpe: 6, name: 'Quick Run' }));
    expect(computePlanAdherence(s).totalCompleted).toBe(0);

    s.wks[0].rated['W1-easy-0'] = 3;
    writeInAppActual(s.wks[0], 'W1-easy-0', buildPlannedRunActual(easy, { rpe: 3, startTime: '2026-09-30T10:00:00Z', durationMin: 48 }));
    expect(computePlanAdherence(s).totalCompleted).toBe(1);
  });
});

describe('same-session windows come from existing code', () => {
  it('recorded window: start within 4h and duration within 15%, or 10 min with no duration', () => {
    const a = { startTime: '2026-09-30T07:00:00Z', durationSec: 2700 };
    expect(isSameRecordedSession(a, { startTime: '2026-09-30T10:59:00Z', durationSec: 3000 })).toBe(true);
    expect(isSameRecordedSession(a, { startTime: '2026-09-30T11:01:00Z', durationSec: 2700 })).toBe(false);
    expect(isSameRecordedSession(a, { startTime: '2026-09-30T07:00:00Z', durationSec: 3300 })).toBe(false);
    expect(isSameRecordedSession({ startTime: a.startTime, durationSec: 0 }, { startTime: '2026-09-30T07:09:00Z', durationSec: 0 })).toBe(true);
  });

  it('completion window: start within 36h and duration 0.5 to 2.0 times the entry', () => {
    const e = { startTime: '2026-09-30T12:00:00Z', durationSec: 2880 };
    expect(isSameCompletedSession(e, { startTime: '2026-10-01T23:00:00Z', durationSec: 2700 })).toBe(true);
    expect(isSameCompletedSession(e, { startTime: '2026-10-02T01:00:00Z', durationSec: 2700 })).toBe(false);
    expect(isSameCompletedSession(e, { startTime: '2026-09-30T07:00:00Z', durationSec: 1200 })).toBe(false);
    // The strength path's 30-minute assumption for an entry with no duration.
    expect(isSameCompletedSession({ startTime: e.startTime, durationSec: 0 }, { startTime: e.startTime, durationSec: 1800 }, 30)).toBe(true);
  });

  it('the completion window never matches a GPS record (its start is a real recorded start)', () => {
    const wk = emptyWeek(1);
    const rec = gpsRecording();
    writeInAppActual(wk, rec.id, buildGpsRunActual(rec, { rpe: 6, name: 'Just Run' }));
    const nextDay = { startTime: '2026-10-01T07:00:00Z', durationSec: 2700 };
    expect(findInAppRunToSupersede(wk, nextDay, 'completion')).toBeNull();
    expect(findInAppRunToSupersede(wk, nextDay, 'recorded')).toBeNull();
  });
});

describe('a watch copy supersedes the in-app record instead of double counting (audit B9)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('a GPS run on a plan slot is replaced in place when the Apple Health copy of the same session syncs', () => {
    const s = baseState(1, 1);
    const rec = gpsRecording();
    s.wks[0].rated['W1-easy-0'] = 6;
    writeInAppActual(s.wks[0], 'W1-easy-0', buildGpsRunActual(rec, { rpe: 6, name: 'Easy Run', slot: EASY_SLOT }));
    setState(s);

    matchAndAutoComplete([runRow()]);

    const wk = getMutableState().wks[0];
    expect(Object.keys(wk.garminActuals ?? {})).toEqual(['W1-easy-0']);
    expect(wk.garminActuals!['W1-easy-0'].garminId).toBe('apple-RUN1');
    expect(wk.garminActuals!['W1-easy-0'].workoutName).toBe('Easy Run'); // slot metadata kept
    expect(wk.garminMatched!['apple-RUN1']).toBe('W1-easy-0');          // not '__pending__'
    expect(wk.adhocWorkouts ?? []).toHaveLength(0);
    expect(wk.rated['W1-easy-0']).toBe(6);                              // the user's rating kept
    // Counted once, at the watch's duration.
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(46 * TL_PER_MIN[6]));
  });

  it('a Strava copy arriving after the Apple copy still wins (Strava canonical)', () => {
    const s = baseState(1, 1);
    s.wks[0].rated['W1-easy-0'] = 6;
    writeInAppActual(s.wks[0], 'W1-easy-0', buildGpsRunActual(gpsRecording(), { rpe: 6, name: 'Easy Run', slot: EASY_SLOT }));
    setState(s);

    matchAndAutoComplete([runRow()]);
    matchAndAutoComplete([runRow({ garmin_id: 'strava-77', start_time: '2026-09-30T07:01:00Z', duration_sec: 2750 })]);

    const wk = getMutableState().wks[0];
    expect(Object.keys(wk.garminActuals ?? {})).toEqual(['W1-easy-0']);
    expect(wk.garminActuals!['W1-easy-0'].garminId).toBe('strava-77');
    expect(wk.adhocWorkouts ?? []).toHaveLength(0);
  });

  it('a Strava copy supersedes an in-app GPS record directly', () => {
    const s = baseState(1, 1);
    s.wks[0].rated['W1-easy-0'] = 6;
    writeInAppActual(s.wks[0], 'W1-easy-0', buildGpsRunActual(gpsRecording(), { rpe: 6, name: 'Easy Run', slot: EASY_SLOT }));
    setState(s);

    matchAndAutoComplete([runRow({ garmin_id: 'strava-5' })]);

    const wk = getMutableState().wks[0];
    expect(Object.keys(wk.garminActuals ?? {})).toEqual(['W1-easy-0']);
    expect(wk.garminActuals!['W1-easy-0'].garminId).toBe('strava-5');
    expect(wk.garminPending?.some(p => p.garminId === 'strava-5' && wk.garminMatched?.[p.garminId] === '__pending__')).toBeFalsy();
  });

  it('an impromptu GPS run is superseded under its own adhoc id, so Signal B still counts one run', () => {
    const s = baseState(1, 1);
    const rec = gpsRecording();
    s.wks[0].adhocWorkouts = [{ n: 'Just Run', d: '8.0km', r: 5, t: 'easy', id: rec.id } as Workout];
    s.wks[0].rated[rec.id] = 7;
    writeInAppActual(s.wks[0], rec.id, buildGpsRunActual(rec, { rpe: 7, name: 'Just Run' }));
    setState(s);

    matchAndAutoComplete([runRow({ garmin_id: '123456789' })]); // raw Garmin webhook copy

    const wk = getMutableState().wks[0];
    expect(wk.garminActuals![rec.id].garminId).toBe('123456789');
    expect(Object.keys(wk.garminActuals ?? {})).toHaveLength(1);
    expect(wk.adhocWorkouts!.map(w => w.id)).toEqual([rec.id]);
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(46 * TL_PER_MIN[7]));
  });

  it('a run marked done is superseded by the watch copy recorded hours before the planned-day stamp (completion window)', () => {
    const s = baseState(2, 2); // week 1 is a past week: unmatched runs would become a second adhoc activity
    const easy = { n: 'Easy Run', t: 'easy', d: '8km', r: 3, rpe: 3, dayOfWeek: 2 } as Workout;
    s.wks[0].rated['W1-easy-0'] = 3;
    writeInAppActual(s.wks[0], 'W1-easy-0', buildPlannedRunActual(easy, {
      rpe: 3, startTime: manualCompletionStartIso(PLAN_START, 1, 2, Date.parse('2026-10-06T08:00:00Z')), durationMin: 48,
    }));
    setState(s);

    matchAndAutoComplete([runRow({ start_time: '2026-09-30T05:30:00Z' })]); // > 4h before the noon stamp

    const wk = getMutableState().wks[0];
    expect(Object.keys(wk.garminActuals ?? {})).toEqual(['W1-easy-0']);
    expect(wk.garminActuals!['W1-easy-0'].garminId).toBe('apple-RUN1');
    expect(wk.adhocWorkouts ?? []).toHaveLength(0);
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(46 * TL_PER_MIN[3]));
  });

  it('a different run days later does not supersede a GPS record (it is a separate session)', () => {
    const s = baseState(1, 1);
    s.wks[0].rated['W1-easy-0'] = 6;
    writeInAppActual(s.wks[0], 'W1-easy-0', buildGpsRunActual(gpsRecording(), { rpe: 6, name: 'Easy Run', slot: EASY_SLOT }));
    setState(s);

    matchAndAutoComplete([runRow({ start_time: '2026-10-03T07:00:00Z' })]);

    const wk = getMutableState().wks[0];
    expect(wk.garminActuals!['W1-easy-0'].garminId.startsWith('guided-gps_')).toBe(true);
    expect(wk.garminMatched!['apple-RUN1']).toBe('__pending__'); // queued for review as its own activity
  });

  it('a re-fed in-app run (plan reset) is re-attached without review and stays out of the forecast inputs', () => {
    const s = baseState(1, 1);
    setState(s);
    const rec = gpsRecording();
    const a = buildGpsRunActual(rec, { rpe: 6, name: 'Just Run' });
    // The row redistributeArchivedActivitiesToNewPlan builds from an archived in-app actual.
    matchAndAutoComplete([runRow({
      garmin_id: a.garminId, start_time: a.startTime!, duration_sec: a.durationSec, distance_m: 8000,
    })]);

    const wk = getMutableState().wks[0];
    expect(wk.garminMatched![a.garminId]).toBe(`garmin-${a.garminId}`); // logged, not '__pending__'
    expect(computeWeekRawTSS(wk, wk.rated)).toBeGreaterThan(0);
  });

  it('cross-source reconcile still drops a Garmin twin colliding with a Strava actual (shared window unchanged)', () => {
    const s = baseState(1, 1);
    s.wks[0].garminActuals = {
      'garmin-1': { ...syncedNoHr('2026-09-30T07:00:00Z', 2700, 8), garminId: '1' },
      'garmin-strava-2': { ...syncedNoHr('2026-09-30T07:05:00Z', 2750, 8), garminId: 'strava-2' },
    };
    expect(reconcileCrossSourceDuplicates(s)).toBe(true);
    expect(Object.keys(s.wks[0].garminActuals!)).toEqual(['garmin-strava-2']);
  });
});

describe('a same-day run marked done wins over a neighbouring slot claim (HYROX double count)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // HYROX easy runs as the generator writes them: no km token except the "~X km" estimate.
  const hxRun = (id: string, dayOfWeek: number): Workout => ({
    id, n: 'Easy Run', t: 'hyrox_run_easy', discipline: 'run', dayOfWeek,
    d: '40 min easy at 6:30/km (~6.2 km). Fully conversational.', r: 4, rpe: 4, estimatedDurationMin: 40,
  } as unknown as Workout);

  function hyroxState(neighbourDay: number) {
    const s = baseState(1, 1);
    s.trackOnly = false;
    s.eventType = 'hyrox';
    const monday = hxRun('hx-w1-run-0', 0);
    s.wks[0].triWorkouts = [monday, hxRun('hx-w1-run-1', neighbourDay)];
    // HYROX run Mark as Done on Monday (recordHxRunDone): planned 40 min, stamped Monday noon.
    s.wks[0].rated['hx-w1-run-0'] = 4;
    writeInAppActual(s.wks[0], 'hx-w1-run-0', buildPlannedRunActual(monday, {
      rpe: 4, startTime: manualCompletionStartIso(PLAN_START, 1, 0, Date.parse('2026-10-04T20:00:00Z')), durationMin: 40,
    }));
    return s;
  }

  // The watch recorded Monday's run at 18:00 local, 50 min: six hours from the
  // noon stamp and 25% over plan, so it misses the recorded window.
  const mondayEveningRow = () => runRow({
    start_time: new Date(2026, 8, 28, 18, 0, 0).toISOString(), duration_sec: 3000, distance_m: 6200,
  });

  it.each([
    ['Sunday (the Mon/Sun day-delta wrap)', 6],
    ['Tuesday', 1],
  ])('the watch copy replaces the Monday record instead of filling the unrated %s run slot', (_label, neighbourDay) => {
    setState(hyroxState(neighbourDay as number));

    matchAndAutoComplete([mondayEveningRow()]);

    const wk = getMutableState().wks[0];
    expect(Object.keys(wk.garminActuals ?? {})).toEqual(['hx-w1-run-0']);
    expect(wk.garminActuals!['hx-w1-run-0'].garminId).toBe('apple-RUN1');
    expect(wk.garminMatched!['apple-RUN1']).toBe('hx-w1-run-0');
    expect(wk.rated['hx-w1-run-1']).toBeUndefined();       // the neighbouring session is still to do
    expect(wk.rated['hx-w1-run-0']).toBe(4);               // the user's rating kept
    // Counted once, at the watch's 50 minutes.
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(50 * TL_PER_MIN[4]));
  });

  it('a run on a different day from the record still fills its own slot (two sessions, both counted)', () => {
    setState(hyroxState(1));

    // Tuesday 18:00 local: the record is Monday's, so this is Tuesday's session.
    matchAndAutoComplete([runRow({
      start_time: new Date(2026, 8, 29, 18, 0, 0).toISOString(), duration_sec: 3000, distance_m: 6200,
    })]);

    const wk = getMutableState().wks[0];
    expect(wk.garminActuals!['hx-w1-run-0'].garminId.startsWith('guided-manual-')).toBe(true);
    expect(wk.garminActuals!['hx-w1-run-1'].garminId).toBe('apple-RUN1');
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(40 * TL_PER_MIN[4]) + Math.round(50 * TL_PER_MIN[4]));
  });

  it('same-day-completion matches a run marked done on the synced run\'s calendar day only, never a GPS record', () => {
    const wk = emptyWeek(1);
    const easy = { n: 'Easy Run', t: 'easy', d: '8km', r: 3, rpe: 3, dayOfWeek: 2 } as Workout;
    writeInAppActual(wk, 'W1-easy-0', buildPlannedRunActual(easy, {
      rpe: 3, startTime: new Date(2026, 8, 30, 12, 0, 0).toISOString(), durationMin: 48,
    }));
    const sameEvening = { startTime: new Date(2026, 8, 30, 21, 0, 0).toISOString(), durationSec: 2880 };
    const nextMorning = { startTime: new Date(2026, 9, 1, 6, 0, 0).toISOString(), durationSec: 2880 };
    expect(findInAppRunToSupersede(wk, sameEvening, 'same-day-completion')).toBe('W1-easy-0');
    expect(findInAppRunToSupersede(wk, nextMorning, 'same-day-completion')).toBeNull();
    expect(findInAppRunToSupersede(wk, nextMorning, 'completion')).toBe('W1-easy-0'); // the cross-day check still sees it
    // Duration outside 0.5 to 2.0 times the record is a different session, same day or not.
    expect(findInAppRunToSupersede(wk, { ...sameEvening, durationSec: 7200 }, 'same-day-completion')).toBeNull();

    const gpsWk = emptyWeek(1);
    const rec = gpsRecording();
    writeInAppActual(gpsWk, rec.id, buildGpsRunActual(rec, { rpe: 6, name: 'Just Run' }));
    // Eight hours after the 07:00Z recording, same day, same length: a second run, not the GPS one.
    expect(findInAppRunToSupersede(gpsWk, { startTime: '2026-09-30T15:00:00Z', durationSec: 2700 }, 'same-day-completion')).toBeNull();
  });
});

describe('Mark as Done writes a run record for run cards only (recordPlannedRunDone)', () => {
  const card = (t: string, n = 'Session'): Workout =>
    ({ id: `W1-${t}-0`, n, t, d: t === 'cross_training' ? '60 min' : '8km', r: 3, rpe: 3, dayOfWeek: 2 } as Workout);
  const opts = { rpe: 3, durationMin: 48, planStartDate: PLAN_START, weekNum: 1, currentWeek: 1, nowMs: Date.parse('2026-10-04T20:00:00Z') };

  it.each(['cross_training', 'strength', 'capacity_test', 'cross', 'gym', 'rest'])(
    'a %s card keeps the rating only: no run record, nothing in Signal A or weekly Signal B',
    (t) => {
      const wk = emptyWeek(1);
      const w = card(t, t === 'cross_training' ? 'Cross-Train: Cycling' : 'Rehab Strength');
      wk.rated[w.id!] = 3;
      expect(isPlanCardRunType(t)).toBe(false);
      expect(recordPlannedRunDone(wk, w.id!, w, opts)).toBeNull();
      expect(wk.garminActuals ?? {}).toEqual({});
      expect(computeWeekTSS(wk, wk.rated)).toBe(0);
    },
  );

  it.each(['easy', 'long', 'threshold', 'return_run', 'test_run'])('a %s card stores its planned load', (t) => {
    const wk = emptyWeek(1);
    const w = card(t, 'Run');
    wk.rated[w.id!] = 3;
    expect(isPlanCardRunType(t)).toBe(true);
    const a = recordPlannedRunDone(wk, w.id!, w, opts);
    expect(a?.garminId.startsWith('guided-manual-')).toBe(true);
    expect(wk.garminActuals![w.id!]).toBe(a);
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(48 * TL_PER_MIN[3]));
  });

  it('a future-week card keeps the rating only (its record would sit where the matcher never looks)', () => {
    const wk = emptyWeek(2);
    const w = card('easy', 'Easy Run');
    wk.rated[w.id!] = 3;
    expect(recordPlannedRunDone(wk, w.id!, w, { ...opts, weekNum: 2, currentWeek: 1 })).toBeNull();
    expect(wk.garminActuals ?? {}).toEqual({});
  });

  it('an unrated slot gets no record', () => {
    const wk = emptyWeek(1);
    const w = card('easy', 'Easy Run');
    expect(recordPlannedRunDone(wk, w.id!, w, opts)).toBeNull();
  });
});

describe('activity log badge survives a watch supersede', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('an impromptu GPS run reads Logged before and after the watch copy supersedes it under its adhoc id', () => {
    const s = baseState(1, 1);
    const rec = gpsRecording();
    s.wks[0].adhocWorkouts = [{ n: 'Quick Run', d: '8.0km', r: 5, t: 'easy', id: rec.id } as Workout];
    s.wks[0].rated[rec.id] = 7;
    writeInAppActual(s.wks[0], rec.id, buildGpsRunActual(rec, { rpe: 7, name: 'Quick Run' }));
    setState(s);
    expect(collectWeekActivities(getMutableState().wks[0]).map(e => e.badge)).toEqual(['logged']);

    matchAndAutoComplete([runRow({ garmin_id: 'strava-31' })]);

    const wk = getMutableState().wks[0];
    expect(wk.garminActuals![rec.id].garminId).toBe('strava-31');
    const entries = collectWeekActivities(wk);
    expect(entries).toHaveLength(1);
    expect(entries[0].badge).toBe('logged');
    expect(entries[0].slotName).toBeNull();
  });

  it('a GPS run on a plan slot still reads Matched after the watch copy supersedes it', () => {
    const s = baseState(1, 1);
    s.wks[0].rated['W1-easy-0'] = 6;
    writeInAppActual(s.wks[0], 'W1-easy-0', buildGpsRunActual(gpsRecording(), { rpe: 6, name: 'Easy Run', slot: EASY_SLOT }));
    setState(s);

    matchAndAutoComplete([runRow()]);

    expect(collectWeekActivities(getMutableState().wks[0]).map(e => e.badge)).toEqual(['matched']);
  });
});
