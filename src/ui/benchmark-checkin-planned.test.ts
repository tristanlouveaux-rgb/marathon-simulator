// @vitest-environment jsdom
/**
 * A post-deload benchmark check-in is a planned session, not done load (audit B8).
 *
 * Picking a check-in pushes a `benchmark-<type>-<ts>` workout into this week's
 * adhocWorkouts. The load readers skipped only `holiday-`/`adhoc-` ids, so the
 * pick counted as completed load at once (weekly Signal B, today's strain, the
 * daily history behind rolling ACWR) and again when the real run synced. The
 * overlay also reopened after every pick, so taps stacked phantom sessions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('./main-view', () => ({ renderMainView: vi.fn() }));
vi.mock('./renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./renderer')>()),
  render: vi.fn(),
}));

import { openBenchmarkOverlay, maybeTriggerBenchmarkOverlay } from './benchmark-overlay';
import { setState, resetState, getDefaultState, getState } from '@/state/store';
import {
  computeWeekRawTSS, computeWeekTSS, computeTodaySignalBTSS, computeTodayStrainTSS,
  getDailyLoadHistory, normalizeiTrimp,
} from '@/calculations/fitness-model';
import { resolveWeekWorkouts } from './week-resolve';
import { getPlannedDayTSSContext } from './planned-day-tss';
import { isPlannedAdhocId } from '@/workouts/planned-adhoc';
import type { SimulatorState, Week } from '@/types';
import { addCalendarDays, localDateKey } from '@/utils/local-date';

// The local calendar day, the day the app files activities and plan weekdays
// by. The UTC day read yesterday between 00:00 and 01:00 BST (E9, 2026-10-22).
const todayIso = localDateKey(new Date());
const todayDow = (new Date(todayIso + 'T12:00:00').getDay() + 6) % 7;
/** Local midnight today: on today's local day and never in the future. */
const todayStartIso = (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 0, 0, 0).toISOString(); })();

/** Monday of the current week, minus 4 weeks: week 5 of the plan is this week. */
function planStartForWeek5(): string {
  return addCalendarDays(todayIso, -todayDow - 28);
}

function week(w: number, ph: Week['ph']): Week {
  return {
    w, ph, rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, garminActuals: {}, adhocWorkouts: [], unspentLoadItems: [],
    garminMatched: {},
  } as unknown as Week;
}

function continuousWeek5State(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    continuousMode: true,
    w: 5,
    tw: 8,
    rw: 3,
    rd: 'half',
    typ: 'balanced',
    v: 45,
    gs: 0,
    pac: { e: 330 },
    planStartDate: planStartForWeek5(),
    onboarding: { experienceLevel: 'intermediate', trainingFocus: 'both' },
    benchmarkResults: [],
    wks: [week(1, 'base'), week(2, 'base'), week(3, 'build'), week(4, 'taper'), week(5, 'base'), week(6, 'base'), week(7, 'build'), week(8, 'taper')],
  } as unknown as SimulatorState;
}

const wk5 = () => getState().wks![4];

function pick(type: string): void {
  openBenchmarkOverlay();
  const btn = document.querySelector<HTMLElement>(`.bm-opt-btn[data-bm-type="${type}"]`);
  expect(btn).not.toBeNull();
  btn!.click();
}

function benchmarkEntries() {
  return (wk5().adhocWorkouts ?? []).filter(w => (w.id ?? '').startsWith('benchmark-'));
}

describe('Benchmark check-in: a planned session, never done load', () => {
  beforeEach(() => {
    resetState();
    document.body.innerHTML = '';
    setState(continuousWeek5State());
  });
  afterEach(() => vi.useRealTimers());

  it('the benchmark- prefix is a planned adhoc id, like adhoc- and holiday-', () => {
    expect(isPlannedAdhocId('benchmark-threshold_check-1')).toBe(true);
    expect(isPlannedAdhocId('adhoc-1')).toBe(true);
    expect(isPlannedAdhocId('holiday-1')).toBe(true);
    expect(isPlannedAdhocId('garmin-strava-9')).toBe(false);
    expect(isPlannedAdhocId(undefined)).toBe(false);
  });

  it('picking a check-in adds no load to the week, today, or the daily history', () => {
    pick('threshold_check');
    expect(benchmarkEntries()).toHaveLength(1);

    const wk = wk5();
    expect(computeWeekRawTSS(wk, wk.rated, getState().planStartDate)).toBe(0);
    expect(computeWeekTSS(wk, wk.rated, getState().planStartDate)).toBe(0);
    expect(computeTodaySignalBTSS(wk, todayIso)).toBe(0);
    expect(computeTodayStrainTSS(wk, todayIso, null)).toBe(0);
    const history = getDailyLoadHistory(getState().wks!, getState().planStartDate!);
    expect(history.find(e => e.date === todayIso)?.tss ?? 0).toBe(0);
  });

  it('the synced run carries the load: weekly and today totals equal the run alone', () => {
    const run = {
      garminId: 'strava-501', startTime: todayStartIso, durationSec: 35 * 60,
      distanceKm: 7, iTrimp: 6000, activityType: 'RUNNING', displayName: 'Morning Run',
    };
    (getState().wks![4] as any).garminActuals = { 'garmin-strava-501': run };
    const runOnly = computeWeekRawTSS(wk5(), wk5().rated, getState().planStartDate);
    expect(runOnly).toBe(Math.round(normalizeiTrimp(6000)));

    pick('threshold_check');
    expect(computeWeekRawTSS(wk5(), wk5().rated, getState().planStartDate)).toBe(runOnly);
    expect(computeTodaySignalBTSS(wk5(), todayIso)).toBe(runOnly);
  });

  it('the check-in renders as a plan card and prices into today\'s planned TSS', () => {
    const before = getPlannedDayTSSContext(getState(), 5).plannedTSSForDay(todayDow);
    pick('threshold_check');
    const id = benchmarkEntries()[0].id;
    const resolved = resolveWeekWorkouts(getState(), 5);
    expect(resolved.some((w: any) => w.id === id)).toBe(true);
    const after = getPlannedDayTSSContext(getState(), 5).plannedTSSForDay(todayDow);
    expect(after).toBeGreaterThan(before);
  });

  it('the overlay does not reopen once a check-in is chosen', () => {
    vi.useFakeTimers();
    maybeTriggerBenchmarkOverlay();
    vi.advanceTimersByTime(500);
    expect(document.getElementById('benchmark-overlay')).not.toBeNull();

    document.querySelector<HTMLElement>('.bm-opt-btn[data-bm-type="threshold_check"]')!.click();
    expect(document.getElementById('benchmark-overlay')).toBeNull();

    // The option click re-renders the Plan tab, which calls the trigger again.
    maybeTriggerBenchmarkOverlay();
    vi.advanceTimersByTime(500);
    expect(document.getElementById('benchmark-overlay')).toBeNull();
  });

  it('choosing again replaces the pick instead of stacking a second session', () => {
    pick('threshold_check');
    pick('easy_checkin');
    const entries = benchmarkEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toContain('easy_checkin');
  });

  it('a pick that already has a matched run is kept when choosing again', () => {
    pick('threshold_check');
    const firstId = benchmarkEntries()[0].id!;
    (getState().wks![4] as any).garminActuals = {
      [firstId]: { garminId: 'strava-77', startTime: todayStartIso, durationSec: 2100, distanceKm: 7 },
    };
    pick('easy_checkin');
    const ids = benchmarkEntries().map(w => w.id);
    expect(ids).toContain(firstId);
    expect(ids).toHaveLength(2);
  });
});
