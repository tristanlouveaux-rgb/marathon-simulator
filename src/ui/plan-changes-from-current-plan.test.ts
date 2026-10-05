// @vitest-environment jsdom
/**
 * Plan changes are built from the current plan and replace, not stack
 * (audit A2, X12).
 *
 * Before: the cross-training review, the silent Tier-1 trim and the ACWR Reduce
 * button each regenerated the raw week (no mods applied, generator arguments
 * drifted from the Plan's) and APPENDED a new mod. The resolver applies mods in
 * order, so a later small ride brought back a replaced run, and the ACWR button
 * offered cuts on a run that was already replaced. The activity matcher
 * regenerated without ACWR status or the user's excluded session types, so its
 * workout ids differed from the Plan's and runs were credited to sessions the
 * Plan does not show.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('./renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./renderer')>()),
  render: vi.fn(),
  log: vi.fn(),
}));
vi.mock('./toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./toast')>()),
  showAssignmentToast: vi.fn(),
  showSimpleToast: vi.fn(),
}));

// The week's excess over baseline decides whether the silent Tier-1 trim fires
// (≤ 15 TSS). Pinned so the test exercises the trim itself.
const weeklyExcess = vi.hoisted(() => ({ value: 10 }));
vi.mock('@/calculations/fitness-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/calculations/fitness-model')>()),
  getWeeklyExcess: () => weeklyExcess.value,
}));

// The ACWR button's "would a cut do anything?" gate, pinned open.
vi.mock('@/calculations/acwr-reduction-projection', () => ({
  computeAcwrReductionProjection: () => ({ projected: 600, target: 300, over: true }),
}));

// Capture what the suggester is handed and what the modal shows.
const suggesterRuns = vi.hoisted(() => ({ calls: [] as any[][] }));
vi.mock('@/cross-training', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/cross-training')>();
  return {
    ...actual,
    buildCrossTrainingPopup: (ctx: any, runs: any[], ...rest: any[]) => {
      suggesterRuns.calls.push(runs);
      return (actual.buildCrossTrainingPopup as any)(ctx, runs, ...rest);
    },
  };
});
const modal = vi.hoisted(() => ({ decide: null as null | ((popup: any) => any) }));
vi.mock('./suggestion-modal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./suggestion-modal')>()),
  showSuggestionModal: (popup: any, _label: string, onComplete: (d: any) => void) => {
    onComplete(modal.decide ? modal.decide(popup) : null);
  },
}));

import { autoProcessActivities } from './activity-review';
import { triggerACWRReduction, undoACWRReduction } from './main-view';
import { applyRecoveryAdjustment } from './events';
import { resolveWeekWorkouts } from './week-resolve';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { writeAdjustmentMods } from '@/workouts/workout-mods';
import { parseDistanceKm } from '@/workouts/workout-scaling';
import { TL_PER_MIN } from '@/constants';
import { setState, resetState, getDefaultState, getMutableState } from '@/state/store';
import type { SimulatorState, GarminPendingItem, WorkoutMod } from '@/types';

const PLAN_START = '2026-03-02'; // a Monday

function runningState(parts: Partial<SimulatorState> = {}, wkParts: Record<string, unknown> = {}): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    planStartDate: PLAN_START,
    w: 1,
    tw: 18,
    rw: 5,
    rd: 'half',
    typ: 'balanced',
    v: 48,
    gs: 0,
    pac: { e: 330, t: 275, i: 250, m: 300, r: 235 },
    signalBBaseline: 300,
    ctlBaseline: 300,
    wks: [{
      w: 1, ph: 'build', rated: {}, skip: [], workoutMods: [], garminActuals: {}, adhocWorkouts: [],
      garminMatched: {}, garminPending: [], unspentLoadItems: [], ...wkParts,
    }],
    ...parts,
  } as unknown as SimulatorState;
}

const dateOn = (day: number, hh = '12') => {
  const d = new Date(PLAN_START + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + day);
  return `${d.toISOString().slice(0, 10)}T${hh}:00:00Z`;
};

function ride(id: string, day: number, durationMin: number): GarminPendingItem {
  return {
    garminId: id, activityType: 'CYCLING', appType: 'other', startTime: dateOn(day),
    durationSec: durationMin * 60, distanceM: null, avgPaceSecKm: null, avgHR: null, maxHR: null,
    aerobicEffect: null, anaerobicEffect: null, garminRpe: null, calories: null, iTrimp: null,
  } as unknown as GarminPendingItem;
}

const easyRuns = (s: SimulatorState) => resolveWeekWorkouts(s, 1).filter((w: any) => w.t === 'easy');

function replaceMod(w: any): WorkoutMod {
  return {
    name: w.n, dayOfWeek: w.dayOfWeek, workoutId: w.id, status: 'replaced', modReason: 'Garmin: Cycling',
    originalDistance: w.d, newDistance: '0km (replaced)', newType: w.t,
  };
}

const modsOn = (id: string) => (getMutableState().wks[0].workoutMods ?? []).filter(m => m.workoutId === id);

beforeEach(() => {
  resetState();
  document.body.innerHTML = '';
  weeklyExcess.value = 10;
  suggesterRuns.calls = [];
  modal.decide = null;
});

describe('silent Tier-1 trim', () => {
  it('a later small ride does not resurrect a replaced run', () => {
    setState(runningState());
    const [first] = easyRuns(getMutableState());
    getMutableState().wks[0].workoutMods = [replaceMod(first)];

    autoProcessActivities([ride('strava-spin-1', 0, 20)], () => {});

    const after = resolveWeekWorkouts(getMutableState(), 1).find((w: any) => w.id === first.id);
    expect(after.status).toBe('replaced');
    expect(modsOn(first.id)).toHaveLength(1);
    // The trim landed on another easy run, stamped with its slot id.
    const auto = getMutableState().wks[0].workoutMods!.filter(m => m.modReason.startsWith('Auto:'));
    expect(auto).toHaveLength(1);
    expect(auto[0].workoutId).toBeDefined();
    expect(auto[0].workoutId).not.toBe(first.id);
  });

  it('a second trim replaces the first on the same run, sized from the plan distance', () => {
    setState(runningState());
    autoProcessActivities([ride('strava-spin-1', 0, 20)], () => {});
    weeklyExcess.value = 14;
    document.body.innerHTML = ''; // close the first RPE prompt
    autoProcessActivities([ride('strava-spin-2', 1, 25)], () => {});

    const auto = getMutableState().wks[0].workoutMods!.filter(m => m.modReason.startsWith('Auto:'));
    expect(auto).toHaveLength(1);
    const planKm = parseDistanceKm(auto[0].originalDistance)!;
    const expectedCut = Math.round((14 / (TL_PER_MIN[4] * 6)) * 10) / 10;
    expect(parseDistanceKm(auto[0].newDistance)).toBeCloseTo(planKm - expectedCut, 1);
  });
});

describe('ACWR Reduce button', () => {
  it('prices the week with existing changes applied: a replaced run is not offered as planned', () => {
    setState(runningState({}, {
      unspentLoadItems: [{
        garminId: 'strava-ride-9', displayName: 'Cycling', sport: 'cycling', durationMin: 150,
        aerobic: 2.5, anaerobic: 0.5, date: dateOn(0), reason: 'overflow',
      }],
    }));
    const [first] = easyRuns(getMutableState());
    getMutableState().wks[0].workoutMods = [replaceMod(first)];
    modal.decide = (popup) => ({ choice: 'reduce', adjustments: popup.reduceOutcome.adjustments });

    triggerACWRReduction();

    expect(suggesterRuns.calls.length).toBeGreaterThan(0);
    const runs = suggesterRuns.calls[suggesterRuns.calls.length - 1];
    const offered = runs.filter((r: any) => r.workoutId === first.n && r.dayIndex === first.dayOfWeek);
    expect(offered.every((r: any) => r.status === 'replaced')).toBe(true);

    // After the user accepts, the replaced run is still replaced and no session
    // carries two plan changes.
    const after = resolveWeekWorkouts(getMutableState(), 1).find((w: any) => w.id === first.id);
    expect(after.status).toBe('replaced');
    const counts = new Map<string, number>();
    for (const m of getMutableState().wks[0].workoutMods ?? []) {
      if (!m.workoutId) continue;
      counts.set(m.workoutId, (counts.get(m.workoutId) ?? 0) + 1);
    }
    expect([...counts.values()].every(n => n === 1)).toBe(true);
  });

  it('undoing an ACWR cut written over an earlier cut restores the earlier cut', () => {
    setState(runningState());
    const s = getMutableState();
    const wk = s.wks[0];
    const [run] = easyRuns(s);
    const planKm = parseDistanceKm(run.d)!;
    wk.workoutMods = [{
      name: run.n, dayOfWeek: run.dayOfWeek, workoutId: run.id, status: 'reduced', modReason: 'Garmin: Cycling',
      originalDistance: run.d, newDistance: `${planKm - 2}km (was ${planKm}km)`, newType: 'easy',
    }];
    // What the Reduce path writes (writeAdjustmentMods with appliedAt) and its undo snapshot.
    writeAdjustmentMods(wk, [{ ...run, d: `${planKm - 4}km (was ${planKm - 2}km)`, status: 'reduced' }],
      [{ workoutId: run.n, dayIndex: run.dayOfWeek }], 'ACWR: Training load', { appliedAt: '2026-03-02' });
    wk.acwrReductionUndo = { date: '2026-03-02', sportLabel: 'Training load' };
    expect(wk.workoutMods).toHaveLength(1);

    expect(undoACWRReduction()).toBe(true);
    const after = resolveWeekWorkouts(getMutableState(), 1).find((w: any) => w.id === run.id);
    expect(after.modReason).toBe('Garmin: Cycling');
    expect(parseDistanceKm(after.d)).toBe(planKm - 2);
  });
});

describe('readiness recovery adjustment', () => {
  it('is applied to the session as the Plan shows it and replaces its current change', () => {
    setState(runningState());
    const s = getMutableState();
    const [run] = easyRuns(s);
    const planKm = parseDistanceKm(run.d)!;
    const cutKm = Math.round(planKm * 0.6 * 10) / 10;
    s.wks[0].workoutMods = [{
      name: run.n, dayOfWeek: run.dayOfWeek, workoutId: run.id, status: 'reduced', modReason: 'Garmin: Cycling',
      originalDistance: run.d, newDistance: `${cutKm}km (was ${planKm}km)`, newType: 'easy',
    }];

    applyRecoveryAdjustment('reduce', run.dayOfWeek, run.n);

    const mods = getMutableState().wks[0].workoutMods!.filter(m => m.workoutId === run.id || m.name === run.n && m.dayOfWeek === run.dayOfWeek);
    expect(mods).toHaveLength(1);
    expect(mods[0].modReason).toBe('Recovery: distance reduced');
    // 20% off the CUT distance (floor 3 km), not off the plan distance.
    expect(parseDistanceKm(mods[0].newDistance)).toBe(Math.max(3, Math.round(cutKm * 0.8 * 10) / 10));
    expect(mods[0].originalDistance).toBe(run.d);
  });
});

describe('activity matcher', () => {
  it('credits a run to the session the Plan shows when the user opted out of a session type and ACWR is cautious', () => {
    // Which quality types the plain plan carries, so one can be excluded.
    setState(runningState());
    const plain = resolveWeekWorkouts(getMutableState(), 1);
    const quality = plain.find((w: any) => ['threshold', 'vo2', 'float', 'marathon_pace', 'progressive'].includes(w.t) && !w.longRun);
    expect(quality).toBeDefined();
    const plainIds = new Set(plain.map((w: any) => w.id));

    setState(runningState({
      onboarding: { ...getDefaultState().onboarding, runningExcludedWorkouts: [quality.t] } as any,
    }, { scheduledAcwrStatus: 'caution' }));
    const planWeek = resolveWeekWorkouts(getMutableState(), 1);
    // A Plan session whose id the plain generation does not have, alone on its day.
    const target = planWeek.find((w: any) => !plainIds.has(w.id) && w.t === 'easy'
      && planWeek.filter((o: any) => o.dayOfWeek === w.dayOfWeek && o.t !== 'gym' && o.t !== 'cross').length === 1);
    expect(target).toBeDefined();
    const km = parseDistanceKm(target.d)!;

    const row: GarminActivityRow = {
      garmin_id: 'strava-run-1', activity_type: 'RUNNING', start_time: dateOn(target.dayOfWeek),
      duration_sec: Math.round(km * 330), distance_m: km * 1000, avg_pace_sec_km: 330,
      avg_hr: null, max_hr: null, calories: null, aerobic_effect: null, anaerobic_effect: null,
    };
    matchAndAutoComplete([row]);

    expect(getMutableState().wks[0].garminMatched!['strava-run-1']).toBe(target.id);
  });
});
