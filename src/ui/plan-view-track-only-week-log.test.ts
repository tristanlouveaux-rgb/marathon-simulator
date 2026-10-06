// @vitest-environment jsdom
/**
 * Just-Track Plan tab: the This week card and the History rows list each
 * activity once.
 *
 * An in-app GPS run recorded outside a plan is stored twice on purpose: an
 * adhoc card under the recording's id (recording-handler.ts saveAsAdhoc) and
 * its activity record under that same id (writeInAppActual, audit M3). A synced
 * activity accepted from review is stored the same way under `garmin-<id>`
 * (addAdhocWorkoutFromPending). Load already counts each once
 * (computeWeekRawTSS). The card did not: its detail only dropped an actual
 * whose key started with `garmin-`, so the GPS run showed twice (once undated),
 * and the History row added km and sessions from both stores, so every
 * accepted synced activity counted twice.
 *
 * Both now read the canonical week list (collectWeekActivities, de-duplicated
 * by key), plus planned sessions marked done with no activity record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('@/state/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { renderPlanView } from './plan-view';
import { getDefaultState, setState } from '@/state/store';
import { buildGpsRunActual, writeInAppActual } from '@/calculations/in-app-activity';
import type { GpsRecording } from '@/types';
import type { Week, Workout } from '@/types';

const WEEK1 = '2026-09-21';
const WEEK2 = '2026-09-28';

function bucketWeek(w: number): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, adhocWorkouts: [], garminActuals: {}, garminMatched: {}, garminPending: [],
  } as unknown as Week;
}

/** An 8 km, 45 min in-app GPS run starting at `startIso`. */
function gpsRun(startIso: string): GpsRecording {
  const startMs = Date.parse(startIso);
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
  } as GpsRecording;
}

/** The impromptu GPS run as recording-handler.ts saveAsAdhoc stores it. */
function storeGpsRun(wk: Week, rec: GpsRecording): void {
  wk.adhocWorkouts!.push({ n: 'Just Run', d: '8.0km', r: 5, t: 'easy', id: rec.id } as Workout);
  wk.rated[rec.id] = 5;
  writeInAppActual(wk, rec.id, buildGpsRunActual(rec, { rpe: 5, name: 'Just Run' }));
}

/** A synced 10 km Strava run accepted from review: the adhoc card plus its
 *  actual under the same key, as addAdhocWorkoutFromPending writes them. */
function storeStravaRun(wk: Week, startIso: string): void {
  const id = 'garmin-strava-555';
  wk.adhocWorkouts!.push({
    id, t: 'easy', n: 'Run', d: '10.0km in 50min', r: 5, rpe: 5,
    garminTimestamp: startIso, garminDistKm: 10, garminDurationMin: 50,
  } as unknown as Workout);
  wk.garminActuals![id] = {
    garminId: 'strava-555', startTime: startIso, distanceKm: 10, durationSec: 3000,
    avgPaceSecKm: 300, avgHR: null, maxHR: null, calories: null, activityType: 'RUNNING',
    displayName: 'Run',
  } as any;
  wk.garminMatched![`strava-555`] = id;
}

/** A generated on-demand session (session-generator.ts), not yet done. */
function storeGeneratedSession(wk: Week, id: string): void {
  wk.adhocWorkouts!.push({ id, t: 'threshold', n: 'Threshold Run', d: '6km @ 5:00/km', r: 7, rpe: 7, distanceKm: 6 } as unknown as Workout);
}

function justTrack(week1: Week, week2: Week): void {
  const s = getDefaultState();
  s.trackOnly = true;
  s.continuousMode = true;
  s.hasCompletedOnboarding = true;
  s.planStartDate = WEEK1;
  s.w = 2;
  s.tw = 2;
  s.unitPref = 'km';
  s.wks = [week1, week2];
  setState(s);
}

const detailRows = () => [...document.querySelectorAll('.tp-log-row')].map(r => r.textContent?.replace(/\s+/g, ' ').trim());
const detailTotal = () => document.querySelector('.tp-detail-total')?.textContent?.trim();
const historyTotal = () => document.querySelector('.tp-week-row .tp-week-total')?.textContent?.trim();
const historySub = () => document.querySelector('.tp-week-row .tp-week-sub')?.textContent?.trim();

beforeEach(() => {
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('Just-Track This week card and History rows list each activity once', () => {
  it('an in-app GPS run (adhoc card plus its record under the same id) is one row, 8.0 km, 1 session', () => {
    const w1 = bucketWeek(1);
    const w2 = bucketWeek(2);
    storeGpsRun(w1, gpsRun(`${WEEK1}T07:00:00.000Z`));
    storeGpsRun(w2, gpsRun(`${WEEK2}T07:00:00.000Z`));
    justTrack(w1, w2);

    renderPlanView();

    expect(detailRows()).toHaveLength(1);
    expect(detailRows()[0]).toContain('Just Run');
    expect(detailRows()[0]).toContain('8.0 km');
    expect(detailTotal()).toBe('8.0 km');
    expect(historyTotal()).toBe('8.0 km');
    expect(historySub()).toMatch(/^1 session · \d+ TSS$/);
  });

  it('an accepted Strava run (garmin-<id> adhoc plus its actual) is one row, 10.0 km, 1 session', () => {
    const w1 = bucketWeek(1);
    const w2 = bucketWeek(2);
    storeStravaRun(w1, `${WEEK1}T07:00:00.000Z`);
    storeStravaRun(w2, `${WEEK2}T07:00:00.000Z`);
    justTrack(w1, w2);

    renderPlanView();

    expect(detailRows()).toHaveLength(1);
    expect(detailTotal()).toBe('10.0 km');
    expect(historyTotal()).toBe('10.0 km');
    expect(historySub()).toMatch(/^1 session · \d+ TSS$/);
  });

  it('a generated session stays out until it is done; once rated it is listed. A Quick Run placeholder stays out', () => {
    const w1 = bucketWeek(1);
    const w2 = bucketWeek(2);
    storeGpsRun(w2, gpsRun(`${WEEK2}T07:00:00.000Z`));
    storeGeneratedSession(w2, 'adhoc-1000');           // upcoming: under Planned only
    // A Quick Run placeholder (events.ts justRun) left by a discarded recording.
    w2.adhocWorkouts!.push({ n: 'Quick Run', d: 'Easy pace', r: 5, t: 'easy' } as Workout);
    storeGeneratedSession(w1, 'adhoc-900');
    storeGeneratedSession(w1, 'adhoc-901');
    w1.rated['adhoc-901'] = 7;                         // marked done, no recording
    justTrack(w1, w2);

    renderPlanView();

    expect(detailRows()).toHaveLength(1);
    expect(detailRows()[0]).toContain('Just Run');
    expect(detailTotal()).toBe('8.0 km');
    // The Planned card for the upcoming session still renders.
    expect(document.querySelectorAll('.tp-upcoming-row')).toHaveLength(1);
    // Week 1: the done session counts, the never-done one does not.
    expect(historyTotal()).toBe('6.0 km');
    expect(historySub()).toMatch(/^1 session · \d+ TSS$/);
  });
});
