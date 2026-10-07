// @vitest-environment jsdom
/**
 * Mark as Done with no watch counts as load in triathlon, cycling and
 * Just-Track generated sessions (decision 2026-10-06).
 *
 * Before: the triathlon / cycling / Just-Track detail modal's Mark as Done
 * wrote wk.rated only. Every load reader reads wk.garminActuals, so a no-watch
 * athlete who ticked sessions saw 0 TSS on the Home strain ring and the week
 * debrief, and the holiday return read the weeks before a holiday as
 * sedentary. Running and HYROX runs already stored a record.
 *
 * Now the tick stores the session's planned duration at the rated RPE, valued
 * like running Mark as Done (durationMin x TL_PER_MIN[rated]), with a bike or
 * swim tagged with its sport so Signal A weights it at that sport's runSpec. A
 * synced copy of the same session supersedes it in place (Strava wins).
 *
 * Real tri plan (initializeTriathlonSimulator), real modal (jsdom), real load
 * readers and real matchAndAutoComplete.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/ui/main-view', () => ({ renderMainView: vi.fn() }));
vi.stubGlobal('alert', vi.fn());

import { resetState, getMutableState, getDefaultState, setState } from '@/state/store';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { openTriWorkoutDetail } from './workout-detail-modal';
import { estimateTriWorkoutMin } from './week-resolve.triathlon';
import { buildWeekSummary } from './tri-week-debrief';
import {
  computeWeekRawTSS, computeWeekTSS, computeWeekActualTSS, computeTodayStrainTSS, estimateWorkoutDurMin,
} from '@/calculations/fitness-model';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';
import { isManualInAppActual } from '@/calculations/in-app-activity';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { reconcileTriCompletions } from '@/calculations/activity-matcher.triathlon';
import { manualDoneTriActivities, inAppGpsRunActivities } from '@/calculations/tri-benchmarks-from-history';
import { computeTriPlanAdherence } from '@/calculations/plan-adherence.triathlon';
import { localDateKey } from '@/utils/local-date';
import type { GarminActual, SimulatorState, Week, Workout } from '@/types';

const PLAN_START = '2026-09-28'; // a Monday

function triState(): SimulatorState {
  initializeTriathlonSimulator({ trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate' } as any);
  const s = getMutableState();
  expect(s.eventType).toBe('triathlon');
  expect(s.planStartDate).toBe(PLAN_START);
  return s;
}

/**
 * Tap the card's Mark as Done, as the user does. The clock moves a second per
 * tap: record ids are `guided-manual-<ms>`, and two taps in one frozen
 * millisecond would share an id (a user cannot tap twice in one).
 */
function markDone(w: Workout, weekIdx = 0): void {
  vi.setSystemTime(Date.now() + 1000);
  openTriWorkoutDetail(w, weekIdx);
  (document.getElementById('tri-detail-mark-done') as HTMLButtonElement).click();
}

function skipFromCard(w: Workout, weekIdx = 0): void {
  openTriWorkoutDetail(w, weekIdx);
  (document.getElementById('tri-detail-skip') as HTMLButtonElement).click();
}

const plannedRpe = (w: Workout): number => Math.round(w.rpe ?? w.r ?? 5);
const find = (wk: Week, pred: (w: Workout) => boolean): Workout => {
  const w = (wk.triWorkouts ?? []).find(pred);
  expect(w).toBeTruthy();
  return w!;
};
const isPlainBike = (w: Workout) => w.discipline === 'bike' && !w.brickSegments;

function rideRow(over: Partial<GarminActivityRow>): GarminActivityRow {
  return {
    garmin_id: 'strava-R1', activity_type: 'CYCLING', start_time: '', duration_sec: 3600,
    distance_m: 30000, avg_pace_sec_km: null, avg_hr: null, max_hr: null, calories: null,
    aerobic_effect: null, anaerobic_effect: null, iTrimp: null, hrZones: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 28, 9, 0, 0)); // onboard on the plan's Monday
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.body.innerHTML = '';
  resetState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('triathlon Mark as Done stores the planned load as a record', () => {
  it('a bike counts in weekly Signal B, the week debrief and the holiday-return reader at durationMin x TL_PER_MIN[rated], and in Signal A at the cycling runSpec', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0)); // Sunday evening: every week-1 day is past
    const wk = s.wks[0];
    const bike = find(wk, isPlainBike);
    const rpe = plannedRpe(bike);
    const durMin = estimateTriWorkoutMin(bike);
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(0);

    markDone(bike);

    const rec = wk.garminActuals![bike.id!];
    expect(isManualInAppActual(rec)).toBe(true); // was undefined: rating only
    expect(rec.manualSport).toBe('cycling');
    expect(rec.activityType).toBeNull(); // FTP readers never see planned numbers as a ride
    expect(rec.durationSec).toBe(Math.round(durMin * 60));
    expect(rec.distanceKm).toBe(0);
    expect(new Date(rec.startTime!).getHours()).toBe(12); // planned-day noon
    expect((new Date(rec.startTime!).getDay() + 6) % 7).toBe(bike.dayOfWeek);

    const signalB = Math.round(durMin * TL_PER_MIN[rpe]);
    expect(signalB).toBeGreaterThan(0);
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(signalB);
    expect(computeWeekActualTSS(wk, s.planStartDate)).toBe(signalB); // holiday-modal classifyHolidayActivity reads this
    expect(buildWeekSummary(s, 1).metrics.actualTSS).toBe(signalB);
    expect(computeWeekTSS(wk, wk.rated)).toBe(Math.round(durMin * TL_PER_MIN[rpe] * SPORTS_DB.cycling.runSpec));
  });

  it('the ticked bike reaches the Home strain ring on its planned day and the debrief bike row', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const bike = find(wk, isPlainBike);
    const day = localDateKey(new Date(2026, 8, 28 + bike.dayOfWeek!, 12));
    expect(computeTodayStrainTSS(wk, day, null)).toBe(0);

    markDone(bike);

    expect(computeTodayStrainTSS(wk, day, null)).toBeGreaterThan(0);
    const row = buildWeekSummary(s, 1).disciplines.find(d => d.discipline === 'bike')!;
    expect(row.totalHours).toBe(Math.round((estimateTriWorkoutMin(bike) / 60) * 10) / 10);
    expect(row.completedSessions).toBeGreaterThanOrEqual(1);
  });

  it('a swim is tagged swimming and weighted at the swimming runSpec; a run carries no tag and full run weight', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const swim = find(wk, w => w.discipline === 'swim');
    markDone(swim);
    const swimMin = estimateTriWorkoutMin(swim);
    expect(wk.garminActuals![swim.id!].manualSport).toBe('swimming');
    expect(computeWeekTSS(wk, wk.rated)).toBe(Math.round(swimMin * TL_PER_MIN[plannedRpe(swim)] * SPORTS_DB.swimming.runSpec));

    const s2 = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk2 = s2.wks[0];
    const run = find(wk2, w => w.discipline === 'run');
    markDone(run);
    const runRec = wk2.garminActuals![run.id!];
    expect(isManualInAppActual(runRec)).toBe(true);
    expect(runRec.manualSport).toBeUndefined();
    const runMin = estimateTriWorkoutMin(run);
    expect(computeWeekTSS(wk2, wk2.rated)).toBe(Math.round(runMin * TL_PER_MIN[plannedRpe(run)]));
    // The debrief run row counts it (no activityType on an in-app run record).
    const row = buildWeekSummary(s2, 1).disciplines.find(d => d.discipline === 'run')!;
    expect(row.totalHours).toBe(Math.round((runMin / 60) * 10) / 10);
  });

  it('Skip drops the record; a future-week tick keeps the rating only', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const bike = find(wk, isPlainBike);
    markDone(bike);
    expect(wk.garminActuals![bike.id!]).toBeTruthy();
    skipFromCard(bike);
    expect(wk.rated[bike.id!]).toBe('skip');
    expect(wk.garminActuals![bike.id!]).toBeUndefined();
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(0);

    const wk2 = s.wks[1];
    const future = find(wk2, isPlainBike);
    markDone(future, 1);
    expect(wk2.rated[future.id!]).toBe(plannedRpe(future));
    expect(wk2.garminActuals?.[future.id!]).toBeUndefined();
  });

  it('tri per-discipline fitness still counts the ticked session once after the matcher direct-binds the record', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const bike = find(wk, isPlainBike);
    markDone(bike);
    reconcileTriCompletions(wk); // what runTriActivityMatching does on the next launch
    expect(bike.status).toBe('completed');
    expect(bike.matchedActivityId).toBe(bike.id);

    const manual = manualDoneTriActivities(s.wks, s.planStartDate);
    expect(manual).toHaveLength(1); // was 0 once the record was bound: the tick left tri fitness
    expect(manual[0].activityType).toBe('CYCLING');
    expect(inAppGpsRunActivities(s.wks)).toHaveLength(0); // not counted a second time
  });

  it('plan adherence counts ticked sessions, runs included', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const scorable = (wk.triWorkouts ?? []).filter(w => w.discipline === 'swim' || w.discipline === 'bike' || w.discipline === 'run');
    expect(scorable.some(w => w.discipline === 'run')).toBe(true);
    for (const w of scorable) markDone(w);
    s.w = 2;
    expect(computeTriPlanAdherence(s).pct).toBe(100);
  });
});

describe('Mark as Done adds no record when an activity already completes the session', () => {
  function synced(garminId: string, activityType: string, start: Date, durationSec: number): GarminActual {
    return {
      garminId, startTime: start.toISOString(), distanceKm: activityType === 'RUNNING' ? 10 : 40,
      durationSec, avgPaceSecKm: null, avgHR: 140, maxHR: 165, calories: null, iTrimp: 9000,
      hrZones: null, activityType, displayName: activityType,
    } as GarminActual;
  }

  // What runTriActivityMatching (main.ts) leaves after a fuzzy match: the
  // recording stays under its own key, the slot is completed and linked to it.
  // A synced run in triathlon mode sits under a running-engine slot key; a
  // ride with no placement decided under its garmin- key.
  for (const [label, pred, type, otherKey] of [
    ['bike', isPlainBike, 'CYCLING', 'garmin-strava-B1'],
    ['run', (w: Workout) => w.discipline === 'run', 'RUNNING', 'Easy Run'],
  ] as const) {
    it(`a ${label} the fuzzy matcher linked to a synced recording under another key keeps the week TSS unchanged`, () => {
      const s = triState();
      vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
      const wk = s.wks[0];
      const w = find(wk, pred);
      const start = new Date(2026, 8, 28 + w.dayOfWeek!, 7, 0, 0);
      wk.garminActuals = { ...(wk.garminActuals ?? {}), [otherKey]: synced(`strava-${label}`, type, start, Math.round(estimateTriWorkoutMin(w) * 60)) };
      w.status = 'completed';
      w.matchedActivityId = otherKey;
      reconcileTriCompletions(wk);
      expect(w.matchedActivityId).toBe(otherKey); // the link survives reconcile
      const before = computeWeekRawTSS(wk, wk.rated, s.planStartDate);
      const holidayBefore = computeWeekActualTSS(wk, s.planStartDate);
      expect(before).toBeGreaterThan(0);

      markDone(w);

      expect(wk.rated[w.id!]).toBe(plannedRpe(w)); // the tap still records the rating
      expect(wk.garminActuals![w.id!]).toBeUndefined(); // was a second, planned-load record
      expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(before);
      expect(computeWeekActualTSS(wk, s.planStartDate)).toBe(holidayBefore);
    });
  }

  it('a brick completed by brick detection (status only, no link, no record) keeps the week TSS unchanged', () => {
    const s = triState();
    const wi = s.wks.findIndex(wk => (wk.triWorkouts ?? []).some(w => !!w.brickSegments));
    expect(wi).toBeGreaterThanOrEqual(0);
    s.w = wi + 1;
    vi.setSystemTime(new Date(2026, 8, 28 + wi * 7 + 6, 20, 0, 0)); // that week's Sunday evening
    const wk = s.wks[wi];
    const brick = find(wk, w => !!w.brickSegments);
    const [bikeSeg, runSeg] = brick.brickSegments!;
    const start = new Date(2026, 8, 28 + wi * 7 + brick.dayOfWeek!, 8, 0, 0);
    const runStart = new Date(start.getTime() + ((bikeSeg.durationMin ?? 60) + 5) * 60000);
    wk.garminActuals = {
      ...(wk.garminActuals ?? {}),
      'garmin-strava-BR1': synced('strava-BR1', 'CYCLING', start, (bikeSeg.durationMin ?? 60) * 60),
      'garmin-strava-BR2': synced('strava-BR2', 'RUNNING', runStart, (runSeg.durationMin ?? 20) * 60),
    };
    brick.status = 'completed'; // main.ts brick detection: both legs matched
    reconcileTriCompletions(wk);
    expect(brick.status).toBe('completed');
    expect(brick.matchedActivityId).toBeUndefined();
    const before = computeWeekRawTSS(wk, wk.rated, s.planStartDate);
    expect(before).toBeGreaterThan(0);

    markDone(brick, wi);

    expect(wk.rated[brick.id!]).toBe(plannedRpe(brick));
    expect(wk.garminActuals![brick.id!]).toBeUndefined(); // was a 2.5 h bike-tagged record on top of both legs
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(before);
  });

  it('the slot\'s own record still re-ticks after reconcile direct-binds it, and Skip then Mark as Done restores it', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const bike = find(wk, isPlainBike);
    markDone(bike);
    reconcileTriCompletions(wk);
    expect(bike.status).toBe('completed');
    expect(bike.matchedActivityId).toBe(bike.id);
    const tss = computeWeekRawTSS(wk, wk.rated, s.planStartDate);
    expect(tss).toBeGreaterThan(0);

    markDone(bike); // re-tick: the session's own record is the completion
    expect(isManualInAppActual(wk.garminActuals![bike.id!])).toBe(true);
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(tss);

    skipFromCard(bike);
    expect(wk.garminActuals![bike.id!]).toBeUndefined();
    expect(bike.status).toBe('completed'); // the dead link clears on the next reconcile
    markDone(bike);
    expect(isManualInAppActual(wk.garminActuals![bike.id!])).toBe(true);
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(tss);
  });
});

describe('a synced copy supersedes the Mark as Done record (Strava wins, counted once)', () => {
  it('a same-day Strava ride replaces the bike record in place and keeps the rating', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const bike = find(wk, isPlainBike);
    markDone(bike);
    const rated = wk.rated[bike.id!];
    const durMin = estimateTriWorkoutMin(bike);

    const start = new Date(2026, 8, 28 + bike.dayOfWeek!, 7, 0, 0).toISOString(); // morning ride, record stamped noon
    matchAndAutoComplete([rideRow({ start_time: start, duration_sec: Math.round(durMin * 60 * 1.1) })]);

    const now = wk.garminActuals![bike.id!];
    expect(now.garminId).toBe('strava-R1');
    expect(now.manualSport).toBeUndefined(); // the ride's own activityType names the sport now
    expect(now.activityType).toBe('CYCLING');
    expect(wk.garminMatched!['strava-R1']).toBe(bike.id);
    expect(wk.rated[bike.id!]).toBe(rated);
    const copies = Object.values(wk.garminActuals!).filter(a => a.garminId === 'strava-R1' || isManualInAppActual(a));
    expect(copies).toHaveLength(1);
    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(Math.round(durMin * 1.1 * TL_PER_MIN[rated as number]));
  });

  it('in a past week, a ride the next day replaces the bike record (cross-day completion window) instead of adding a second ride', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const bike = find(wk, w => isPlainBike(w) && (w.dayOfWeek ?? 6) < 6);
    markDone(bike);
    s.w = 2; // week 1 is now past: the row is not queued for review
    vi.setSystemTime(new Date(2026, 9, 6, 9, 0, 0));
    const durMin = estimateTriWorkoutMin(bike);
    const start = new Date(2026, 8, 28 + bike.dayOfWeek! + 1, 18, 0, 0).toISOString();
    matchAndAutoComplete([rideRow({ garmin_id: 'strava-R2', start_time: start, duration_sec: Math.round(durMin * 60) })]);

    expect(wk.garminActuals![bike.id!].garminId).toBe('strava-R2');
    expect(Object.keys(wk.garminActuals!).filter(k => wk.garminActuals![k].garminId === 'strava-R2')).toEqual([bike.id]);
    expect((wk.adhocWorkouts ?? []).some(w => w.id === 'garmin-strava-R2')).toBe(false);
  });

  it('a same-day run never supersedes a bike record', () => {
    const s = triState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const bike = find(wk, isPlainBike);
    markDone(bike);
    const durMin = estimateTriWorkoutMin(bike);
    const start = new Date(2026, 8, 28 + bike.dayOfWeek!, 12, 30, 0).toISOString();
    matchAndAutoComplete([rideRow({ garmin_id: 'strava-RUN', activity_type: 'RUNNING', start_time: start, duration_sec: Math.round(durMin * 60) })]);
    expect(isManualInAppActual(wk.garminActuals![bike.id!])).toBe(true);
    expect(wk.garminActuals![bike.id!].manualSport).toBe('cycling');
  });
});

describe('Just-Track generated sessions', () => {
  function trackOnlyState(): SimulatorState {
    const s = getDefaultState();
    s.trackOnly = true;
    s.planStartDate = PLAN_START;
    s.w = 1;
    s.pac = { ...(s.pac ?? {}), e: 300 } as SimulatorState['pac']; // 5:00/km easy pace
    s.wks = [{
      w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
      workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
      adhocWorkouts: [
        // session-generator saveTriAdhoc (non-tri) shapes: bike tagged with its discipline.
        { id: 'adhoc-1', t: 'bike_threshold', n: 'Threshold Ride', d: '2x15min threshold', rpe: 7, r: 7, discipline: 'bike', estimatedDurationMin: 70, dayOfWeek: 2 },
        // A generated run: distance and pace, no stored duration.
        { id: 'adhoc-2', t: 'easy', n: 'Easy Run', d: '8km @ 5:00/km', rpe: 3, r: 3, dayOfWeek: 3 },
      ] as Workout[],
    } as unknown as Week];
    setState(s);
    return getMutableState();
  }

  it('a generated bike and a generated run each store a record that counts as load', () => {
    const s = trackOnlyState();
    vi.setSystemTime(new Date(2026, 9, 4, 20, 0, 0));
    const wk = s.wks[0];
    const [bike, run] = wk.adhocWorkouts!;
    markDone(bike);
    markDone(run);

    const bikeRec = wk.garminActuals!['adhoc-1'];
    expect(bikeRec.manualSport).toBe('cycling');
    expect(bikeRec.durationSec).toBe(70 * 60);

    const runMin = estimateWorkoutDurMin(run, 5); // running card dose at the easy pace
    expect(runMin).toBe(40);
    const runRec = wk.garminActuals!['adhoc-2'];
    expect(runRec.durationSec).toBe(40 * 60);
    expect(runRec.distanceKm).toBe(8);
    expect(runRec.manualSport).toBeUndefined();

    expect(computeWeekRawTSS(wk, wk.rated, s.planStartDate)).toBe(Math.round(70 * TL_PER_MIN[7] + 40 * TL_PER_MIN[3]));
  });
});
