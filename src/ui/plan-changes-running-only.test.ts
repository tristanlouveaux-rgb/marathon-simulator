// @vitest-environment jsdom
/**
 * Running plan changes (wk.workoutMods) are a running-mode feature. Just-track
 * has no plan, and triathlon, cycling and HYROX keep their plan in
 * wk.triWorkouts, which resolveTriWeekWorkouts renders without ever applying a
 * running mod.
 *
 * Before: every flow that sizes or writes a running change read
 * resolveWeekForPlanChanges, which called the running generator in every mode,
 * so outside running mode it offered cuts to sessions the user does not have and
 * wrote mods no view applies:
 *  - an impromptu GPS run in just-track opened the reduce modal on a phantom
 *    "Easy Run" (regression from 5f5b4d4);
 *  - timing suggestions landed on the phantom "Threshold Tempo" after a heavy day;
 *  - the ACWR Reduce button cut the phantom week and cleared the unspent items;
 *  - HYROX cross-training overflow opened the running modal sized against HYROX
 *    sessions at 0 km; the silent Tier-1 trim wrote an 'Auto:' mod on a tri easy
 *    run or a HYROX commute run;
 *  - the Home readiness ring offered "Reduce session load" in just-track and
 *    HYROX, whose click could only reach those flows.
 *
 * Real plans (initializeHyroxSimulator / initializeTriathlonSimulator) and the
 * real running generator; only UI edges, the ACWR status and readiness score are
 * pinned.
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
// The completion modal answers with an RPE straight away.
vi.mock('@/ui/gps-completion-modal', () => ({
  openGpsCompletionModal: (_data: unknown, onComplete: (rpe: number) => void) => onComplete(7),
}));

// Pinned: ACWR status, the week's excess (Tier-1 gate), the readiness score.
const pin = vi.hoisted(() => ({
  acwr: null as null | 'safe' | 'high',
  excess: 10,
  readiness: null as null | { score: number; drivingSignal: string },
}));
vi.mock('@/calculations/fitness-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/calculations/fitness-model')>();
  const withStatus = (r: any) => (pin.acwr
    ? { ...r, status: pin.acwr, ratio: pin.acwr === 'high' ? 1.8 : 1.0, safeUpper: r.safeUpper || 1.3 }
    : r);
  return {
    ...actual,
    computeACWR: (...a: Parameters<typeof actual.computeACWR>) => withStatus(actual.computeACWR(...a)),
    computeReadinessACWR: (...a: Parameters<typeof actual.computeReadinessACWR>) => withStatus(actual.computeReadinessACWR(...a)),
    getWeeklyExcess: () => pin.excess,
  };
});
vi.mock('@/calculations/readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/calculations/readiness')>();
  return {
    ...actual,
    computeReadiness: (...a: Parameters<typeof actual.computeReadiness>) => {
      const r = actual.computeReadiness(...a);
      return pin.readiness ? { ...r, ...pin.readiness } : r;
    },
  };
});
// The ACWR button's "would a cut do anything?" gate, pinned open.
vi.mock('@/calculations/acwr-reduction-projection', () => ({
  computeAcwrReductionProjection: () => ({ projected: 600, target: 300, over: true }),
}));
// The running modal: records the call and accepts what the test decides.
const modal = vi.hoisted(() => ({ decide: null as null | ((popup: any) => any), calls: 0 }));
vi.mock('./suggestion-modal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./suggestion-modal')>()),
  showSuggestionModal: (popup: any, _label: string, onComplete: (d: any) => void) => {
    modal.calls++;
    onComplete(modal.decide ? modal.decide(popup) : null);
  },
}));
vi.stubGlobal('alert', vi.fn());

import { setState, resetState, getDefaultState, getMutableState } from '@/state/store';
import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { handleCompletedRecording } from '@/gps/recording-handler';
import { mergeTimingMods, isTimingMod, applyTimingDowngradesFromWorkouts } from '@/cross-training/timing-check';
import { triggerACWRReduction } from './main-view';
import { autoProcessActivities, getWeekWorkoutsForPlanChange } from './activity-review';
import { buildReadinessRing } from './home-view';
import { resolveWeekWorkouts, resolveWeekForPlanChanges } from './week-resolve';
import { mapGarminType } from '@/calculations/activity-matcher';
import type { GarminPendingItem, GpsRecording, SimulatorState, UnspentLoadItem, Week } from '@/types';

const PLAN_START = '2026-09-28'; // a Monday

/** Local noon on plan day `day` (0 = Monday): stable weekday in every timezone. */
const at = (day: number, hh = 12) => new Date(2026, 8, 28 + day, hh, 0, 0).toISOString();

function blankWeek(): Week {
  return {
    w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [],
    unspentLoad: 0, extraRunLoad: 0, adhocWorkouts: [], garminPending: [], garminMatched: {}, garminActuals: {},
    unspentLoadItems: [],
  } as unknown as Week;
}

function trackOnlyState(): SimulatorState {
  const s = getDefaultState();
  s.trackOnly = true;
  s.planStartDate = PLAN_START;
  s.w = 1;
  s.signalBBaseline = 300;
  s.ctlBaseline = 300;
  s.wks = [blankWeek()];
  setState(s);
  return getMutableState();
}

function runningState(): SimulatorState {
  setState({
    ...getDefaultState(),
    eventType: 'running',
    planStartDate: PLAN_START,
    w: 1, tw: 18, rw: 5, rd: 'half', typ: 'balanced', v: 48, gs: 0,
    pac: { e: 330, t: 275, i: 250, m: 300, r: 235 },
    signalBBaseline: 300,
    ctlBaseline: 300,
    wks: [blankWeek()],
  } as unknown as SimulatorState);
  return getMutableState();
}

/** A real HYROX plan, onboarded on the plan's Monday so week 1 is whole. */
function hyroxState(opts: { commute?: boolean } = {}): SimulatorState {
  resetState();
  if (opts.commute) {
    getMutableState().commuteConfig = { enabled: true, distanceKm: 5, isBidirectional: false, commuteDaysPerWeek: 1 };
  }
  initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8,
  } as any);
  const s = getMutableState();
  expect(s.eventType).toBe('hyrox');
  expect(s.planStartDate).toBe(PLAN_START);
  s.signalBBaseline = 300;
  s.ctlBaseline = 300;
  return s;
}

/** A real Ironman plan, onboarded on the plan's Monday. */
function ironmanState(): SimulatorState {
  resetState();
  initializeTriathlonSimulator({ trainingMode: 'triathlon', triDistance: 'ironman', experienceLevel: 'intermediate' } as any);
  const s = getMutableState();
  expect(s.eventType).toBe('triathlon');
  s.signalBBaseline = 300;
  s.ctlBaseline = 300;
  return s;
}

function pending(garminId: string, activityType: string, day: number, durationMin: number): GarminPendingItem {
  return {
    garminId, activityType, appType: mapGarminType(activityType), startTime: at(day),
    durationSec: durationMin * 60, distanceM: null, avgPaceSecKm: null, avgHR: null, maxHR: null,
    aerobicEffect: null, anaerobicEffect: null, garminRpe: null, calories: null, iTrimp: null,
  } as unknown as GarminPendingItem;
}

/** A synced session on plan day `day` worth `tss` Signal B TSS (no iTRIMP: 0.92/min). */
function hardSessionOn(wk: Week, day: number, tss: number): void {
  const id = `strava-hard-${day}`;
  if (!wk.garminActuals) wk.garminActuals = {};
  (wk.garminActuals as any)[`garmin-${id}`] = {
    garminId: id, startTime: at(day, 8), durationSec: Math.round((tss / 0.92) * 60), iTrimp: null, distanceKm: 0,
  };
}

/** The suggestions the old build wrote: built from the running engine's week in every mode. */
function mergeTimingModsAsBefore(): void {
  const s = getMutableState();
  const wk = wk1();
  const mods = applyTimingDowngradesFromWorkouts(wk, resolveWeekWorkouts(s, 1, { renderLayers: false }), PLAN_START, undefined, undefined, s.pac?.e);
  wk.workoutMods = [...(wk.workoutMods ?? []), ...mods];
}

const rideItem = (): UnspentLoadItem => ({
  garminId: 'strava-ride-9', displayName: 'Cycling', sport: 'cycling', durationMin: 150,
  aerobic: 2.5, anaerobic: 0.5, date: at(0), reason: 'overflow',
} as UnspentLoadItem);

const wk1 = () => getMutableState().wks[0];
const autoMods = () => (wk1().workoutMods ?? []).filter(m => m.modReason?.startsWith('Auto:'));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 28, 9, 0, 0)); // Monday 28 Sep, plan week 1
  vi.spyOn(console, 'log').mockImplementation(() => {});
  resetState();
  document.body.innerHTML = '';
  pin.acwr = null;
  pin.excess = 10;
  pin.readiness = null;
  modal.decide = null;
  modal.calls = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the plan-change week is the running plan only', () => {
  it('just-track, HYROX and triathlon get no week to size a change from; running keeps its week', () => {
    trackOnlyState();
    expect(resolveWeekWorkouts(getMutableState(), 1).length).toBeGreaterThan(0); // the phantom the flows used to read
    expect(resolveWeekForPlanChanges(getMutableState(), 1)).toEqual([]);

    hyroxState();
    expect(resolveWeekForPlanChanges(getMutableState(), 1)).toEqual([]);
    expect(getWeekWorkoutsForPlanChange()).toEqual([]);

    ironmanState();
    expect(resolveWeekForPlanChanges(getMutableState(), 1)).toEqual([]);
    expect(getWeekWorkoutsForPlanChange()).toEqual([]);

    runningState();
    expect(resolveWeekForPlanChanges(getMutableState(), 1).length).toBeGreaterThan(0);
  });
});

describe('impromptu GPS run in just-track', () => {
  it('logs the run and opens no reduce modal on a phantom running session', () => {
    trackOnlyState();
    modal.decide = (popup) => ({ choice: 'reduce', adjustments: popup.reduceOutcome.adjustments });
    vi.setSystemTime(new Date(2026, 8, 30, 8, 0, 0));
    const startMs = new Date(2026, 8, 30, 7, 25, 0).getTime();
    const rec: GpsRecording = {
      id: `gps_${startMs}`, workoutName: 'Just Run', week: 1, date: new Date(startMs + 1800 * 1000).toISOString(),
      route: [{ lat: 51.5, lng: -0.1, altitude: null, accuracy: 5, speed: null, timestamp: startMs }],
      splits: [], totalDistance: 5000, totalElapsed: 1800, averagePace: 360,
    };

    handleCompletedRecording(rec, 'Just Run');

    expect(modal.calls).toBe(0);                                  // was 1: reduce 'Easy Run'
    expect(wk1().workoutMods ?? []).toEqual([]);                  // was 'GPS: Just Run' on W1-easy-1
    expect(wk1().adhocWorkouts?.map(w => w.id)).toEqual([rec.id]); // still logged
    expect(wk1().garminActuals?.[rec.id]?.garminId).toBe(`guided-${rec.id}`);
  });
});

describe('timing suggestions after a heavy day', () => {
  it('just-track: no suggestion on the phantom Threshold Tempo', () => {
    const s = trackOnlyState();
    const tempo = resolveWeekWorkouts(s, 1).find((w: any) => w.t === 'threshold');
    expect(tempo?.dayOfWeek).toBe(1); // the phantom session the suggestion used to land on
    hardSessionOn(wk1(), 0, 110);
    expect(mergeTimingMods(getMutableState(), wk1())).toBe(false); // was true
    expect((wk1().workoutMods ?? []).filter(m => isTimingMod(m.modReason))).toEqual([]);
  });

  it('HYROX: no suggestion on a running session the HYROX plan does not have', () => {
    const s = hyroxState();
    expect(resolveWeekWorkouts(s, 1).some((w: any) => w.id === 'W1-threshold-0')).toBe(true);
    hardSessionOn(wk1(), 0, 110);
    expect(mergeTimingMods(getMutableState(), wk1())).toBe(false); // was true: W1-threshold-0
    expect((wk1().workoutMods ?? []).filter(m => isTimingMod(m.modReason))).toEqual([]);
  });

  it('a stale phantom timing mod is cleared on the next sync, heavy day still in the week', () => {
    hyroxState();
    hardSessionOn(wk1(), 0, 110);
    // What the old build wrote on this week: the phantom suggestion itself.
    mergeTimingModsAsBefore();
    expect(wk1().workoutMods!.some(m => m.workoutId === 'W1-threshold-0')).toBe(true);
    expect(mergeTimingMods(getMutableState(), wk1())).toBe(true);
    expect((wk1().workoutMods ?? []).filter(m => isTimingMod(m.modReason))).toEqual([]);
  });
});

describe('ACWR Reduce', () => {
  for (const [mode, build] of [['just-track', trackOnlyState], ['HYROX', () => hyroxState()]] as const) {
    it(`${mode}: opens no modal and keeps the unspent items`, () => {
      build();
      wk1().unspentLoadItems = [rideItem()];
      pin.acwr = 'high';
      modal.decide = (popup) => ({ choice: 'reduce', adjustments: popup.reduceOutcome.adjustments });

      triggerACWRReduction();

      expect(modal.calls).toBe(0);                                         // was 1
      expect(wk1().unspentLoadItems?.map(u => u.garminId)).toEqual(['strava-ride-9']); // was cleared
      expect(wk1().workoutMods ?? []).toEqual([]);
    });
  }
});

describe('cross-training overflow in HYROX', () => {
  it('a 120-minute ride is logged once and opens no running modal', () => {
    hyroxState();
    pin.acwr = 'high'; // the blocking-modal path
    modal.decide = (popup) => popup.replaceOutcome.adjustments.length
      ? { choice: 'replace', adjustments: popup.replaceOutcome.adjustments }
      : { choice: 'reduce', adjustments: popup.reduceOutcome.adjustments };

    autoProcessActivities([pending('ride-1', 'CYCLING', 0, 120)], () => {});

    expect(modal.calls).toBe(0);                                                   // was 1: replace 'Tempo Run'
    expect((wk1().adhocWorkouts ?? []).filter(w => w.id === 'garmin-ride-1')).toHaveLength(1);
    expect(wk1().garminMatched!['ride-1']).toBe('garmin-ride-1');
    expect(wk1().workoutMods ?? []).toEqual([]);
  });
});

describe('silent Tier-1 trim', () => {
  it('triathlon: never writes an Auto mod on a tri easy run', () => {
    const s = ironmanState();
    const easy = (s.wks[0] as any).triWorkouts.find((w: any) => w.t === 'easy');
    expect(easy).toBeDefined(); // '45min @ …': parseFloat read it as 45 km
    pin.acwr = 'safe';
    autoProcessActivities([pending('row-1', 'ROWING', 0, 20)], () => {});
    expect(wk1().garminMatched!['row-1']).toBe('garmin-row-1'); // reached the overflow path
    expect(autoMods()).toEqual([]);                             // was 'Auto: Rowing' on W1-easy-0
  });

  it('HYROX: never writes an Auto mod on a commute run', () => {
    const s = hyroxState({ commute: true });
    expect((s.wks[0] as any).triWorkouts.some((w: any) => w.commute && w.t === 'easy')).toBe(true);
    pin.acwr = 'safe';
    autoProcessActivities([pending('row-2', 'ROWING', 0, 20)], () => {});
    expect(wk1().garminMatched!['row-2']).toBe('garmin-row-2');
    expect(autoMods()).toEqual([]);                             // was 'Auto: Rowing' on 'Commute 1'
  });
});

describe('Home readiness ring adjust button', () => {
  beforeEach(() => {
    pin.acwr = 'high';
    pin.readiness = { score: 40, drivingSignal: 'safety' };
  });

  it('running mode still offers it (harness check)', () => {
    runningState();
    expect(buildReadinessRing(getMutableState())).toContain('id="readiness-adjust-btn"');
  });

  it('just-track: not offered', () => {
    trackOnlyState();
    expect(buildReadinessRing(getMutableState())).not.toContain('readiness-adjust-btn'); // was offered
  });

  it('HYROX: not offered', () => {
    hyroxState();
    expect(buildReadinessRing(getMutableState())).not.toContain('readiness-adjust-btn'); // was offered
  });
});
