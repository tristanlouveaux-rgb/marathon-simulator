/**
 * Synced activities are filed by the athlete's LOCAL calendar day, not the UTC
 * day (decision 2026-10-06), and the HYROX station and guided-strength upgrades
 * search every plan week with bounded windows, as the in-app run supersede does.
 *
 * Before: weekIndexForDate compared UTC days and the day readers compared
 * `startTime.startsWith(day)` (the UTC date), while plan weekdays are local. A
 * late-Sunday session west of UTC landed in the next week and on Monday's
 * strain; an early-Monday one east of UTC landed in the previous week. The
 * station and strength upgrades searched the row's own week only, so a record
 * in another week (its card's week, or s.w held back by the debrief gate) was
 * not upgraded and the session counted twice.
 *
 * Adaptive recovery dated sessions by the local day but measured their age
 * against the UTC "today": a same-morning session east of UTC was skipped, and
 * a Sunday-evening entry west of UTC closed on Wednesday evening as
 * right-censored at 96 h before the day-4 reading existed.
 *
 * Fixed-offset zones with no DST: America/Phoenix = UTC-7,
 * Australia/Brisbane = UTC+10 (the local-date.test.ts convention).
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { matchAndAutoComplete, weekIndexForDate, type GarminActivityRow } from '@/calculations/activity-matcher';
import { computeTodaySignalBTSS } from '@/calculations/fitness-model';
import { ingestNewActualsAsImpacts, closeOutObservedRecovery } from '@/calculations/adaptive-recovery';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { IN_APP_HYROX_ACTIVITY_TYPE } from '@/cross-training/activities';
import { reconcilePlanAnchorToEarliestActivity } from '@/ui/welcome-back';
import {
  isOnLocalDay, localMondayKey, calendarDaysBetween, localMidnightOfPlanWeek,
} from '@/utils/local-date';
import type { GarminActual, SimulatorState, Week } from '@/types';
import type { PhysiologyDayEntry, SessionImpactEntry } from '@/types/state';

const PLAN_START = '2026-09-28'; // a Monday
const ORIGINAL_TZ = process.env.TZ;
function restoreTz(): void {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

function emptyWeek(w: number): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  } as unknown as Week;
}

function trackOnlyState(weeks: number, currentWeek: number): SimulatorState {
  const s = getDefaultState();
  s.trackOnly = true; // no generated plan: rows reach the supersede / adhoc / pending paths
  s.planStartDate = PLAN_START;
  s.w = currentWeek;
  s.wks = Array.from({ length: weeks }, (_, i) => emptyWeek(i + 1));
  setState(s);
  return getMutableState();
}

function row(over: Partial<GarminActivityRow>): GarminActivityRow {
  return {
    garmin_id: 'strava-1', activity_type: 'RUNNING', start_time: '', duration_sec: 2700,
    distance_m: 8000, avg_pace_sec_km: 337, avg_hr: null, max_hr: null, calories: null,
    aerobic_effect: null, anaerobic_effect: null, iTrimp: null, hrZones: null,
    ...over,
  };
}

const weekHolding = (s: SimulatorState, garminId: string): number =>
  s.wks.findIndex(w => Object.prototype.hasOwnProperty.call(w.garminMatched ?? {}, garminId)) + 1;

describe('west of UTC (America/Phoenix, UTC-7)', () => {
  beforeAll(() => { process.env.TZ = 'America/Phoenix'; });
  afterAll(restoreTz);

  // Sunday 4 Oct 20:00 local = Monday 5 Oct 03:00Z.
  const SUNDAY_EVENING = '2026-10-05T03:00:00.000Z';

  it('the zone is applied', () => {
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(420);
  });

  it('weekIndexForDate files a late-Sunday session in its own week, not the next', () => {
    const s = trackOnlyState(3, 2);
    expect(weekIndexForDate(new Date(SUNDAY_EVENING), s)).toBe(1); // was 2 (UTC Monday)
    expect(weekIndexForDate(new Date('2026-10-05T08:00:00.000Z'), s)).toBe(2); // Monday 01:00 local
  });

  it('the matcher logs the synced Sunday-evening run in week 1', () => {
    const s = trackOnlyState(3, 2);
    matchAndAutoComplete([row({ garmin_id: 'strava-SUN', start_time: SUNDAY_EVENING })]);
    expect(weekHolding(s, 'strava-SUN')).toBe(1); // was 2
  });

  it('the run counts on Sunday\'s strain, not Monday\'s', () => {
    const wk = emptyWeek(1);
    wk.rated.slot = 5;
    wk.garminActuals = {
      slot: {
        garminId: 'strava-SUN', startTime: SUNDAY_EVENING, distanceKm: 8, durationSec: 2700,
        avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, activityType: 'RUNNING',
      } as GarminActual,
    };
    expect(isOnLocalDay(SUNDAY_EVENING, '2026-10-04')).toBe(true);
    expect(computeTodaySignalBTSS(wk, '2026-10-04')).toBeGreaterThan(0); // was 0
    expect(computeTodaySignalBTSS(wk, '2026-10-05')).toBe(0);           // was the run's load
  });

  it('local week helpers', () => {
    expect(localMondayKey(SUNDAY_EVENING)).toBe('2026-09-28');
    expect(calendarDaysBetween('2026-09-28', '2026-10-05')).toBe(7);
    expect(localMidnightOfPlanWeek(PLAN_START, 2).toISOString()).toBe('2026-10-05T07:00:00.000Z');
  });
});

describe('east of UTC (Australia/Brisbane, UTC+10)', () => {
  beforeAll(() => { process.env.TZ = 'Australia/Brisbane'; });
  afterAll(restoreTz);

  // Monday 5 Oct 06:00 local = Sunday 4 Oct 20:00Z.
  const MONDAY_MORNING = '2026-10-04T20:00:00.000Z';

  it('the zone is applied', () => {
    expect(new Date(2026, 9, 1).getTimezoneOffset()).toBe(-600);
  });

  it('weekIndexForDate files an early-Monday session in its own week, not the previous', () => {
    const s = trackOnlyState(3, 2);
    expect(weekIndexForDate(new Date(MONDAY_MORNING), s)).toBe(2); // was 1 (UTC Sunday)
  });

  it('the plan-anchor reconcile does not pull the anchor back for an early-Monday first activity', () => {
    const s = trackOnlyState(12, 1);
    s.hasCompletedOnboarding = true;
    s.planStartDate = '2026-10-05';
    s.wks[0].garminActuals = {
      'garmin-a': {
        garminId: 'a', startTime: MONDAY_MORNING, distanceKm: 5, durationSec: 1800,
        avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
      } as GarminActual,
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(reconcilePlanAnchorToEarliestActivity()).toBe(false); // was true: anchor pulled to 28 Sep
    expect(getMutableState().planStartDate).toBe('2026-10-05');
    expect(getMutableState().w).toBe(1);
  });
});

describe('the HYROX station and guided-strength upgrades search every plan week', () => {
  beforeAll(() => { process.env.TZ = 'Australia/Brisbane'; });
  afterAll(restoreTz);

  // s.w is held at 1 by the debrief gate while the calendar is in week 2: a
  // session completed in the app on Monday of week 2 is stored in wks[0], and
  // its watch copy is filed in week 2 by its own day.
  const COMPLETED_AT = new Date(2026, 9, 5, 9, 0, 0).toISOString(); // Mon wk 2, 09:00 local
  const ROW_START = new Date(2026, 9, 5, 8, 10, 0).toISOString();   // Mon wk 2, 08:10 local

  function hyroxState(): SimulatorState {
    const band = 'intermediate' as const;
    const s = getDefaultState();
    s.eventType = 'hyrox';
    s.trackOnly = false;
    s.planStartDate = PLAN_START;
    s.w = 1;
    s.tw = 16;
    s.hyroxConfig = {
      format: 'open_singles', athleteBand: band, hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0, mtlCap: HYROX_MTL_CAP[band], mtlHistory: [],
      runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
      stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
      bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
      weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
      generatorVersion: HYROX_GENERATOR_VERSION,
    };
    s.wks = generateHyroxPlan(s);
    setState(s);
    return getMutableState();
  }

  it('a watch HIIT copy upgrades the in-app station record in the week that holds it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = hyroxState();
    const station = (s.wks[0].triWorkouts ?? []).find(w => w.discipline === 'station')!;
    const durSec = (station.estimatedDurationMin ?? 0) * 60;
    expect(durSec).toBeGreaterThan(0);
    s.wks[0].rated[station.id!] = 6;
    s.wks[0].garminActuals = {
      [station.id!]: {
        garminId: 'guided-1', startTime: COMPLETED_AT, distanceKm: 0, durationSec: durSec,
        avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
        activityType: IN_APP_HYROX_ACTIVITY_TYPE, workoutName: station.n, displayName: station.n,
      } as GarminActual,
    };
    expect(weekIndexForDate(new Date(ROW_START), s)).toBe(2);

    matchAndAutoComplete([row({ garmin_id: 'strava-HIIT', activity_type: 'HIIT', start_time: ROW_START, duration_sec: durSec, distance_m: 0 })]);

    expect(s.wks[0].garminActuals![station.id!].garminId).toBe('strava-HIIT'); // was guided-1
    expect(s.wks[0].garminMatched!['strava-HIIT']).toBe(station.id);
    expect(weekHolding(s, 'strava-HIIT')).toBe(1);
    expect((s.wks[1].garminPending ?? []).some(p => p.garminId === 'strava-HIIT')).toBe(false); // was queued in week 2
  });

  it('a watch strength copy upgrades the guided strength record in the week that holds it', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = trackOnlyState(3, 1);
    s.wks[0].rated['W1-gym-0'] = 6;
    s.wks[0].garminActuals = {
      'W1-gym-0': {
        garminId: 'guided-2', startTime: COMPLETED_AT, distanceKm: 0, durationSec: 45 * 60,
        avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
        activityType: 'STRENGTH_TRAINING', workoutName: 'Strength', displayName: 'Strength',
      } as GarminActual,
    };

    matchAndAutoComplete([row({ garmin_id: 'strava-GYM', activity_type: 'STRENGTH_TRAINING', start_time: ROW_START, duration_sec: 45 * 60, distance_m: 0 })]);

    expect(s.wks[0].garminActuals!['W1-gym-0'].garminId).toBe('strava-GYM'); // was guided-2
    expect(weekHolding(s, 'strava-GYM')).toBe(1);
    expect((s.wks[1].garminPending ?? []).some(p => p.garminId === 'strava-GYM')).toBe(false);
  });

  it('a gym session on another day is not upgraded across weeks (bounded windows)', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = trackOnlyState(3, 1);
    s.wks[0].rated['W1-gym-0'] = 6;
    s.wks[0].garminActuals = {
      'W1-gym-0': {
        garminId: 'guided-3', startTime: new Date(2026, 9, 3, 9, 0, 0).toISOString(), // Saturday wk 1
        distanceKm: 0, durationSec: 45 * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null,
        activityType: 'STRENGTH_TRAINING', workoutName: 'Strength', displayName: 'Strength',
      } as GarminActual,
    };
    matchAndAutoComplete([row({ garmin_id: 'strava-GYM2', activity_type: 'STRENGTH_TRAINING', start_time: ROW_START, duration_sec: 45 * 60, distance_m: 0 })]);
    expect(s.wks[0].garminActuals!['W1-gym-0'].garminId).toBe('guided-3');
  });
});

describe('adaptive recovery measures session age against the local day', () => {
  // Session entries are dated by the local day and physiology entries are keyed
  // by the local day; "today" was the UTC day, so the two disagreed on evenings
  // west of UTC and mornings east of UTC.
  afterEach(() => { vi.useRealTimers(); restoreTz(); });

  function addDayKeys(key: string, n: number): string {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }

  function recoveryState(startTime: string) {
    return {
      sessionImpactLog: [] as SessionImpactEntry[],
      physiologyHistory: [] as PhysiologyDayEntry[],
      ctlBaseline: 350,
      wks: [{
        garminActuals: {
          slot: { garminId: 'strava-AR', startTime, durationSec: 3600, iTrimp: null, activityType: 'RUNNING' },
        },
      }],
    };
  }

  it('Brisbane: a session at 06:00 is ingested at 07:30 the same morning', () => {
    process.env.TZ = 'Australia/Brisbane';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T21:30:00.000Z')); // Mon 5 Oct 07:30 local
    const s = recoveryState('2026-10-04T20:00:00.000Z');    // Mon 5 Oct 06:00 local

    const { added } = ingestNewActualsAsImpacts(s);

    expect(added).toBe(1); // was 0: ageDays -1 against the UTC day (Sunday)
    expect(s.sessionImpactLog[0].date).toBe('2026-10-05');
  });

  it('Phoenix: a Sunday-evening entry is not closed on Wednesday evening, before the day-4 reading', () => {
    process.env.TZ = 'America/Phoenix';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T03:00:00.000Z')); // Sun 4 Oct 20:00 local
    const s = recoveryState('2026-10-05T01:00:00.000Z');    // Sun 4 Oct 18:00 local
    expect(ingestNewActualsAsImpacts(s).added).toBe(1);
    const entry = s.sessionImpactLog[0];
    expect(entry.date).toBe('2026-10-04');

    // 28-day baseline before the session, then depressed readings on T+1..T+3.
    for (let i = 28; i >= 1; i--) {
      s.physiologyHistory.push({ date: addDayKeys(entry.date, -i), hrvRmssd: 60 + (i % 5 - 2), restingHR: 50 + (i % 3 - 1) });
    }
    for (let i = 1; i <= 3; i++) {
      s.physiologyHistory.push({ date: addDayKeys(entry.date, i), hrvRmssd: 45, restingHR: 56 });
    }

    vi.setSystemTime(new Date('2026-10-08T03:00:00.000Z')); // Wed 7 Oct 20:00 local, Thursday in UTC
    expect(closeOutObservedRecovery(s)).toBe(0); // was 1: closed as right-censored at 96 h
    expect(entry.observedHours).toBeUndefined();

    // Thursday morning: the day-4 reading shows recovery and the entry closes uncensored.
    s.physiologyHistory.push({ date: addDayKeys(entry.date, 4), hrvRmssd: 62, restingHR: 49 });
    vi.setSystemTime(new Date('2026-10-08T14:00:00.000Z')); // Thu 8 Oct 07:00 local
    expect(closeOutObservedRecovery(s)).toBe(1);
    expect(entry.observedHours).toBe(96);
    expect(entry.rightCensored).toBe(false);
  });
});
