/**
 * Today's strain and the weekly total value each activity with one rule (D9,
 * 2026-10-21).
 *
 * computeTodaySignalBTSS priced an activity record with no iTRIMP that is not
 * a rated strength session at RPE 5 whatever its rating, while the weekly total
 * (computeWeekRawTSS, signalBActualTSS) used the rating. A 60-minute HR-less
 * session rated 8 read 69 TSS on the day and 133 in the week. Both now call
 * signalBActualTSS / signalBAdhocTSS.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeTodaySignalBTSS, computeWeekRawTSS, normalizeiTrimp, getDailyLoadHistory } from './fitness-model';
import { computeTodayDoubleDayBonus } from './double-day';
import { buildDailySignalBTSS } from './sleep-insights';
import { TL_PER_MIN } from '@/constants';
import { localDateKey } from '@/utils/local-date';
import type { Week } from '@/types/state';

// Monday 28 Sep 2026 to Sunday 4 Oct 2026, local noon starts.
const day = (i: number) => new Date(2026, 8, 28 + i, 12, 0, 0);
const key = (i: number) => localDateKey(day(i));

function record(id: string, i: number, min: number, extra: Record<string, unknown> = {}) {
  return {
    garminId: id, startTime: day(i).toISOString(), durationSec: min * 60, distanceKm: 0,
    avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null, ...extra,
  };
}

function week(): Week {
  return {
    w: 1, ph: 'base', skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    rated: { 'hx-density': 8, 'gym-1': 7, 'ride-1': 'skip' },
    garminActuals: {
      // HYROX station session completed in-app: no heart rate, rated 8.
      'hx-density': record('guided-manual-hx-density', 0, 60, { activityType: 'OTHER' }) as any,
      // Gym session with heart rate, rated 7: Signal B's strength override.
      'gym-1': record('gym-1', 1, 60, { activityType: 'STRENGTH_TRAINING', avgHR: 120, iTrimp: 3000 }) as any,
      // HR-less ride rated 'skip': no rating, RPE 5.
      'ride-1': record('ride-1', 2, 90, { activityType: 'CYCLING' }) as any,
      // Run with iTRIMP, unrated.
      'run-1': record('run-1', 3, 45, { activityType: 'RUNNING', avgHR: 150, iTrimp: 9000 }) as any,
    },
    adhocWorkouts: [
      { id: 'manual-padel-1', t: 'cross', n: 'Padel', d: '60min', r: 6, rpe: 6, dayOfWeek: 4 } as any,
    ],
  } as unknown as Week;
}

describe('day and week price an activity the same way', () => {
  it('a rated HR-less session reads its rating on the day, as in the week', () => {
    const wk = week();
    expect(computeTodaySignalBTSS(wk, key(0))).toBe(Math.round(60 * TL_PER_MIN[8])); // 133, was 69
  });

  it('each rule on its own day', () => {
    const wk = week();
    expect(computeTodaySignalBTSS(wk, key(1))).toBe(Math.round(60 * TL_PER_MIN[7])); // strength override
    expect(computeTodaySignalBTSS(wk, key(2))).toBe(Math.round(90 * TL_PER_MIN[5])); // 'skip' is no rating
    expect(computeTodaySignalBTSS(wk, key(3))).toBe(Math.round(normalizeiTrimp(9000)));
    expect(computeTodaySignalBTSS(wk, key(4))).toBe(Math.round(60 * TL_PER_MIN[6])); // manual adhoc entry
  });

  it('the seven days sum to the weekly total (one activity a day, no double-day bonus)', () => {
    const wk = week();
    const days = [0, 1, 2, 3, 4, 5, 6].map(i => computeTodaySignalBTSS(wk, key(i)));
    const sum = days.reduce((a, b) => a + b, 0);
    // Each day rounds on its own; the week rounds once.
    expect(Math.abs(sum - computeWeekRawTSS(wk, wk.rated))).toBeLessThanOrEqual(3);
  });
});

/**
 * The Load drill-down (rolling-load view) draws each day's bar from the day's
 * tss and its zone segments from the activity rows. The rows kept the old rule
 * (iTRIMP, else RPE 5, no rating, no strength override) after the day moved to
 * signalBActualTSS, so a rated HR-less session drew a 69 TSS segment under a
 * 133 label. The rows now use the day's helpers: rows plus the double-day bonus
 * equal the day's tss.
 */
describe('Load drill-down: activity rows sum to the day', () => {
  afterEach(() => { vi.useRealTimers(); });

  // Friday 2 Oct 2026, evening: the 28-day window ends on day 4 of week().
  function history(wk: Week) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 2, 19, 0, 0));
    return getDailyLoadHistory([wk], key(0));
  }
  const rowsOf = (e: { activities: Array<{ tss: number }> }) => e.activities.reduce((a, r) => a + r.tss, 0);
  const zonesOf = (e: { zoneLoad: { lowAerobic: number; highAerobic: number; anaerobic: number } }) =>
    e.zoneLoad.lowAerobic + e.zoneLoad.highAerobic + e.zoneLoad.anaerobic;

  it('a rated HR-less session: row, zone segments and bar all read its rating', () => {
    const e = history(week()).find(x => x.date === key(0))!;
    const expected = Math.round(60 * TL_PER_MIN[8]); // 133, the row read 69
    expect(e.tss).toBe(expected);
    expect(rowsOf(e)).toBe(expected);
    expect(Math.round(zonesOf(e))).toBe(expected);
  });

  it('a rated strength session with heart rate: the row takes the strength override', () => {
    const e = history(week()).find(x => x.date === key(1))!;
    const expected = Math.round(60 * TL_PER_MIN[7]); // the row read normalizeiTrimp(3000)
    expect(e.tss).toBe(expected);
    expect(rowsOf(e)).toBe(expected);
    expect(Math.round(zonesOf(e))).toBe(expected);
  });

  it('every day of the week: rows equal the day (one activity a day, manual entry included)', () => {
    for (const e of history(week())) {
      expect(Math.abs(rowsOf(e) - e.tss)).toBeLessThanOrEqual(1);
    }
  });

  it('both sessions on one day: rows plus the double-day bonus equal the day', () => {
    const wk = week();
    // Move the gym session onto day 0, three hours after the HYROX session.
    (wk.garminActuals as any)['gym-1'].startTime = new Date(2026, 8, 28, 15, 0, 0).toISOString();
    const e = history(wk).find(x => x.date === key(0))!;
    const bonus = computeTodayDoubleDayBonus(wk, key(0));
    expect(e.activities).toHaveLength(2);
    expect(bonus).toBeGreaterThan(0);
    // Each row rounds on its own; the day rounds once.
    expect(Math.abs(rowsOf(e) + bonus - e.tss)).toBeLessThanOrEqual(2);
  });

  it('a legacy synced entry beside a record with the same name and length is listed (E4)', () => {
    // The rows dropped an adhoc entry whose name and duration matched a row
    // already listed; computeTodaySignalBTSS counts both, so the rows fell
    // short of the bar (94 under 235 in a 400-week probe).
    const wk = week();
    (wk.garminActuals as any)['strava-run-2'] = record('strava-777', 0, 80, { activityType: 'RUNNING', displayName: 'running', avgHR: 150, iTrimp: 12000 });
    wk.adhocWorkouts = [
      ...(wk.adhocWorkouts ?? []),
      { id: 'garmin-legacy-run', t: 'cross', n: 'running', d: '79min', r: 7, rpe: 7, garminTimestamp: new Date(2026, 8, 28, 18, 0, 0).toISOString() } as any,
    ];
    const e = history(wk).find(x => x.date === key(0))!;
    const bonus = computeTodayDoubleDayBonus(wk, key(0));
    expect(e.activities.filter(a => (a as any).name === 'running')).toHaveLength(2);
    expect(Math.abs(rowsOf(e) + bonus - e.tss)).toBeLessThanOrEqual(3);
  });
});

/**
 * The sleep-debt series (buildDailySignalBTSS: Home's sleep-debt outlook, the
 * Readiness and Sleep pages, the coach) had its own per-activity rule: an
 * activity record counted only its iTRIMP, so a rated in-app HYROX session
 * counted 0 there and 133 on the Strain ring. It now calls the same helpers.
 * It still leaves out manual adhoc entries with no timestamp (filed by weekday)
 * and the double-day bonus.
 */
describe('sleep-debt series prices an activity as today\'s strain does', () => {
  it('activity records: the rated HR-less session, strength override, skip and iTRIMP days agree', () => {
    const wk = week();
    const byDate = buildDailySignalBTSS([wk]);
    for (const i of [0, 1, 2, 3]) {
      expect(Math.round(byDate[key(i)] ?? 0)).toBe(computeTodaySignalBTSS(wk, key(i)));
    }
    expect(Math.round(byDate[key(0)])).toBe(Math.round(60 * TL_PER_MIN[8])); // was 0
  });

  it('a synced adhoc entry with no activity record agrees; its twin counts once', () => {
    const wk = week();
    const ts = day(5).toISOString();
    wk.adhocWorkouts = [
      { id: 'garmin-row-1', t: 'cross', n: 'Row', d: '40min', r: 7, rpe: 7, garminTimestamp: ts, garminDurationMin: 40 } as any,
      // Twin of 'hx-density' under its key: the record carries the load.
      { id: 'hx-density', t: 'cross', n: 'Station density', d: '60min', r: 8, rpe: 8, garminTimestamp: day(0).toISOString() } as any,
    ];
    const byDate = buildDailySignalBTSS([wk]);
    expect(Math.round(byDate[key(5)])).toBe(computeTodaySignalBTSS(wk, key(5)));
    expect(Math.round(byDate[key(0)])).toBe(computeTodaySignalBTSS(wk, key(0)));
  });
});
