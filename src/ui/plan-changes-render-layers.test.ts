// @vitest-environment jsdom
/**
 * A plan change is never sized from, or written with, the illness, holiday or
 * post-holiday bridge layers (review of audit A2 fix).
 *
 * Those layers are re-applied on top of every mod each time the week renders. The
 * write flows had moved to the fully resolved week, so a 2 km cut in a light-illness
 * week was sized from the illness-scaled run, scaled again by the illness at render,
 * and kept the illness-scaled distance after the illness ended (the plan distance
 * was lost). In a bridge week the bridge scaled the cut a second time, and its km
 * parser also summed the "(was Xkm)" note, so the cut run came out longer than
 * before the cut.
 *
 * Expected: the change is sized from the plan's session; the layer then applies
 * once to (plan minus cut); once the layer ends the session reads the cut of the
 * plan distance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
// The ACWR button's "would a cut do anything?" gate, pinned open.
vi.mock('@/calculations/acwr-reduction-projection', () => ({
  computeAcwrReductionProjection: () => ({ projected: 600, target: 300, over: true }),
}));
// Capture the candidate runs the suggester is handed.
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

import { triggerACWRReduction } from './main-view';
import { applyRecoveryAdjustment } from './events';
import { resolveWeekWorkouts } from './week-resolve';
import { applyBridgeMods_renderTime } from './holiday-modal';
import { applyIllnessMods } from '@/calculations/illness-rules';
import { mergeTimingMods, isTimingMod } from '@/cross-training/timing-check';
import { isLongRun } from '@/workouts/long-run';
import { parseDistanceKm } from '@/workouts/workout-scaling';
import { setState, resetState, getDefaultState, getMutableState } from '@/state/store';
import type { SimulatorState } from '@/types';

const PLAN_START = '2026-03-02'; // a Monday
const LIGHT_ILLNESS = { active: true, severity: 'light' as const, startDate: PLAN_START };
const BRIDGE_SCALE = 0.7; // a scale the comeback bridge writes (holiday-modal.ts applyBridgeMods)

function runningState(parts: Partial<SimulatorState> = {}, wkParts: Record<string, unknown> = {}): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    planStartDate: PLAN_START,
    w: 1, tw: 18, rw: 5, rd: 'half', typ: 'balanced', v: 48, gs: 0,
    pac: { e: 330, t: 275, i: 250, m: 300, r: 235 },
    signalBBaseline: 300,
    ctlBaseline: 300,
    wks: [{
      w: 1, ph: 'build', rated: {}, skip: [], workoutMods: [], garminActuals: {}, adhocWorkouts: [],
      garminMatched: {}, garminPending: [],
      unspentLoadItems: [{
        garminId: 'strava-ride-9', displayName: 'Cycling', sport: 'cycling', durationMin: 150,
        aerobic: 2.5, anaerobic: 0.5, date: `${PLAN_START}T12:00:00Z`, reason: 'overflow',
      }],
      ...wkParts,
    }],
    ...parts,
  } as unknown as SimulatorState;
}

/** The first easy run as the plan prescribes it (no illness, holiday or bridge set yet). */
function planEasyRun(): { id: string; n: string; dayOfWeek: number; km: number; w: any } {
  const w = resolveWeekWorkouts(getMutableState(), 1).find((x: any) => x.t === 'easy' && !x.longRun);
  expect(w).toBeDefined();
  return { id: w.id, n: w.n, dayOfWeek: w.dayOfWeek, km: parseDistanceKm(w.d)!, w: { ...w } };
}

/** The Reduce decision a user accepts: 2 km off `target`, from the distance the suggester was shown. */
function cutTwoKmFrom(target: { n: string; dayOfWeek: number }) {
  return () => {
    const runs = suggesterRuns.calls[suggesterRuns.calls.length - 1];
    const shown = runs.find((r: any) => r.workoutId === target.n && r.dayIndex === target.dayOfWeek);
    expect(shown).toBeDefined();
    return {
      choice: 'reduce',
      adjustments: [{
        workoutId: target.n, dayIndex: target.dayOfWeek, action: 'reduce',
        originalType: 'easy', newType: 'easy',
        originalDistanceKm: shown.plannedDistanceKm, newDistanceKm: shown.plannedDistanceKm - 2,
        loadReduction: 0,
      }],
    };
  };
}

const rendered = (id: string) => resolveWeekWorkouts(getMutableState(), 1).find((w: any) => w.id === id);

beforeEach(() => {
  resetState();
  document.body.innerHTML = '';
  suggesterRuns.calls = [];
  modal.decide = null;
});
afterEach(() => { vi.useRealTimers(); });

describe('a plan change is sized from the plan, not from a render layer', () => {
  it('light illness: a 2 km ACWR cut renders as the illness applied once to (plan − 2 km), and reads the plan cut after the illness ends', () => {
    setState(runningState());
    const run = planEasyRun();
    getMutableState().illnessState = { ...LIGHT_ILLNESS } as any;

    modal.decide = cutTwoKmFrom(run);
    triggerACWRReduction();

    // The suggester was shown the plan's run, not the illness-scaled one.
    const shown = suggesterRuns.calls[suggesterRuns.calls.length - 1]
      .find((r: any) => r.workoutId === run.n && r.dayIndex === run.dayOfWeek);
    expect(shown.plannedDistanceKm).toBe(run.km);

    const once = { ...run.w, d: `${run.km - 2}km` };
    applyIllnessMods([once], LIGHT_ILLNESS as any);
    expect(parseDistanceKm(rendered(run.id).d)).toBe(parseDistanceKm(once.d));

    getMutableState().illnessState = { ...LIGHT_ILLNESS, active: false } as any;
    const after = rendered(run.id);
    expect(parseDistanceKm(after.d)).toBe(run.km - 2);
    expect(after.d).toContain(`(was ${run.km}km)`);
  });

  it('bridge week: a 2 km ACWR cut renders as the bridge applied once to (plan − 2 km), never longer than before the cut', () => {
    setState(runningState());
    const run = planEasyRun();
    (getMutableState().wks[0] as any)._holidayBridgeScale = BRIDGE_SCALE;
    const shownBefore = parseDistanceKm(rendered(run.id).d)!;
    expect(shownBefore).toBeLessThan(run.km);

    modal.decide = cutTwoKmFrom(run);
    triggerACWRReduction();

    const once = { ...run.w, d: `${run.km - 2}km`, modReason: undefined };
    applyBridgeMods_renderTime([once], getMutableState().wks[0]);
    const after = parseDistanceKm(rendered(run.id).d)!;
    expect(after).toBe(parseDistanceKm(once.d));
    expect(after).toBeLessThan(shownBefore);

    // The stored change reads against the plan distance.
    const mod = getMutableState().wks[0].workoutMods!.find(m => m.workoutId === run.id)!;
    expect(parseDistanceKm(mod.newDistance)).toBe(run.km - 2);
    expect(mod.newDistance).toContain(`(was ${run.km}km)`);
  });

  it('light illness: the readiness "Reduce distance" change is sized from the plan run and scaled once by the illness', () => {
    setState(runningState());
    const run = planEasyRun();
    getMutableState().illnessState = { ...LIGHT_ILLNESS } as any;

    applyRecoveryAdjustment('reduce', run.dayOfWeek, run.n);

    const cutKm = Math.max(3, Math.round(run.km * 0.8 * 10) / 10); // the action's own 20% / 3 km rule
    const once = { ...run.w, d: `${cutKm}km` };
    applyIllnessMods([once], LIGHT_ILLNESS as any);
    expect(parseDistanceKm(rendered(run.id).d)).toBe(parseDistanceKm(once.d));

    getMutableState().illnessState = { ...LIGHT_ILLNESS, active: false } as any;
    expect(parseDistanceKm(rendered(run.id).d)).toBe(cutKm);
  });
});

describe('sessions a render layer owns', () => {
  it('a holiday day is never offered for a cut (the session is not being run)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-04T12:00:00Z')); // inside plan week 1
    setState(runningState({
      holidayState: {
        startDate: PLAN_START, endDate: '2026-03-08', canRun: 'no', holidayType: 'relaxation', active: true,
      } as any,
    }));
    modal.decide = () => null;

    triggerACWRReduction();

    const runs = suggesterRuns.calls[suggesterRuns.calls.length - 1] ?? [];
    expect(runs).toHaveLength(0);
  });

  it('a bridge-scaled session gets no timing suggestion', () => {
    setState(runningState({ rw: 4, v: 45, pac: { e: 330 } as any }, { _holidayBridgeScale: BRIDGE_SCALE }));
    const wk = getMutableState().wks[0];
    const lr = resolveWeekWorkouts(getMutableState(), 1).find((w: any) => isLongRun(w));
    expect(lr?.modReason).toBe('Post-holiday bridge');
    // A ~110 TSS session the day before the long run: the top timing tier.
    const d = new Date(PLAN_START + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + lr.dayOfWeek - 1);
    (wk.garminActuals as any)['garmin-strava-hard'] = {
      garminId: 'strava-hard', startTime: `${d.toISOString().slice(0, 10)}T08:00:00Z`,
      durationSec: Math.round((110 / 0.92) * 60), iTrimp: null, distanceKm: 0,
    };

    mergeTimingMods(getMutableState(), wk);

    const timing = (wk.workoutMods ?? []).filter(m => isTimingMod(m.modReason) && (m.workoutId === lr.id || m.name === lr.n));
    expect(timing).toHaveLength(0);
  });
});
