// @vitest-environment jsdom
/**
 * A GPS run in triathlon or HYROX completes the tri/HYROX card it was started
 * from, and reaches tri fitness.
 *
 * Before: handleCompletedRecording name-matched the started card against the
 * running engine's week. Tri cards are 'Easy run' (lowercase r) and HYROX cards
 * live only in wk.triWorkouts, so the run either matched a phantom running slot
 * by name (HYROX 'Easy Run' → W1-easy-0, rated through events.ts rate(), which
 * moves running VDOT) or fell to the impromptu path and was offered a phantom
 * running session. In HYROX the matcher's in-app supersede then kept the watch
 * copy on that phantom key, so the HYROX card stayed undone. In tri the
 * per-discipline CTL read the DB log and manual completions only, so a phone-only
 * GPS run never reached tri fitness.
 *
 * Real plans (initializeTriathlonSimulator / initializeHyroxSimulator), real
 * rate() and matcher; the completion modal answers with RPE 7.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('@/ui/renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui/renderer')>()),
  render: vi.fn(),
  log: vi.fn(),
}));
vi.mock('@/ui/gps-completion-modal', () => ({
  openGpsCompletionModal: (_data: unknown, onComplete: (rpe: number) => void) => onComplete(7),
}));
const modal = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/ui/suggestion-modal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui/suggestion-modal')>()),
  showSuggestionModal: () => { modal.calls++; },
}));
// Tri suggestion modal: never opened by these tests' states, stubbed so a stray
// call cannot leave an overlay behind.
vi.mock('@/ui/triathlon/tri-suggestion-modal', () => ({ showTriSuggestionModal: vi.fn(async () => false) }));
vi.stubGlobal('alert', vi.fn());

import { resetState, getMutableState } from '@/state/store';
import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { initializeTriathlonSimulator } from '@/state/initialization.triathlon';
import { handleCompletedRecording } from './recording-handler';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { deriveWorkoutStatus, computeWeekStatusContext } from '@/ui/workout-status';
import { buildGpsRunActual } from '@/calculations/in-app-activity';
import {
  inAppGpsRunActivities, manualDoneTriActivities, estimateDirectPerDisciplineCTLFromActivities,
} from '@/calculations/tri-benchmarks-from-history';
import type { GpsRecording, SimulatorState, Week, Workout } from '@/types';

const PLAN_START = '2026-09-28'; // a Monday

/** Local time on plan day `day` (0 = Monday) of week 1. */
const on = (day: number, hh: number, mm = 0) => new Date(2026, 8, 28 + day, hh, mm, 0);

function recording(startMs: number, km: number, min: number): GpsRecording {
  return {
    id: `gps_${startMs}`, workoutName: 'run', week: 1, date: new Date(startMs + min * 60000).toISOString(),
    route: [{ lat: 51.5, lng: -0.1, altitude: null, accuracy: 5, speed: null, timestamp: startMs }],
    splits: [], totalDistance: km * 1000, totalElapsed: min * 60, averagePace: (min * 60) / km,
  };
}

function hyroxState(): SimulatorState {
  resetState();
  initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8,
  } as any);
  const s = getMutableState();
  expect(s.eventType).toBe('hyrox');
  expect(s.planStartDate).toBe(PLAN_START);
  return s;
}

function triState(): SimulatorState {
  resetState();
  initializeTriathlonSimulator({ trainingMode: 'triathlon', triDistance: '70.3', experienceLevel: 'intermediate' } as any);
  const s = getMutableState();
  expect(s.eventType).toBe('triathlon');
  return s;
}

const wk1 = () => getMutableState().wks[0];
const stored = (pred: (w: Workout) => boolean) => (wk1().triWorkouts ?? []).find(pred) as Workout;
const keyOf = (w: Workout) => w.id ?? w.n;
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(on(0, 9)); // onboard on the plan's Monday so week 1 is whole
  vi.spyOn(console, 'log').mockImplementation(() => {});
  document.body.innerHTML = '';
  modal.calls = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('triathlon: GPS run started from a tri card', () => {
  it('completes that card with a completion flag, never a phantom running session or running VDOT', () => {
    const s = triState();
    const easy = stored(w => w.n === 'Easy run' && w.discipline === 'run');
    expect(easy?.id).toBeDefined();
    vi.setSystemTime(on(easy.dayOfWeek!, 8));
    const rpeAdjBefore = s.rpeAdj;

    const rec = recording(on(easy.dayOfWeek!, 7).getTime(), 7.5, 45);
    handleCompletedRecording(rec, 'Easy run');

    expect(document.querySelector('#btn-gps-assign-yes')).toBeNull();   // was: "Assign to Easy Run?"
    expect(wk1().rated[easy.id!]).toBe(7);
    expect(wk1().garminActuals?.[easy.id!]?.garminId).toBe(`guided-${rec.id}`);
    expect(getMutableState().rpeAdj).toBe(rpeAdjBefore);
    expect(wk1().ratedChanges ?? {}).toEqual({});
    expect(wk1().workoutMods ?? []).toEqual([]);
    expect(modal.calls).toBe(0);
    // Direct-bound now (reconcileTriCompletions), so the card reads done at once.
    expect(stored(w => w.id === easy.id).status).toBe('completed');
  });

  it('an impromptu run is offered the matching tri session, and assigning it completes that slot', async () => {
    triState();
    const long = stored(w => w.t === 'long' && w.discipline === 'run');
    vi.setSystemTime(on(5, 9));
    const rec = recording(on(5, 7).getTime(), 10, 55);

    handleCompletedRecording(rec, 'Just Run');

    const overlay = document.querySelector('#btn-gps-assign-yes') as HTMLButtonElement;
    expect(overlay?.textContent).toContain(long.n);                    // was the phantom 'Easy Run'
    overlay.click();
    await flush();
    expect(wk1().rated[long.id!]).toBe(7);
    expect(wk1().garminActuals?.[long.id!]?.garminId).toBe(`guided-${rec.id}`);
    expect(wk1().workoutMods ?? []).toEqual([]);
  });
});

describe('HYROX: GPS run started from a HYROX card', () => {
  it('records the run on that HYROX slot, and the synced watch copy keeps the HYROX card done', () => {
    hyroxState();
    const fri = stored(w => w.n === 'Easy Run' && w.dayOfWeek === 4);
    expect(fri).toBeDefined();
    const key = keyOf(fri);
    vi.setSystemTime(on(4, 8));
    const startMs = on(4, 7).getTime();
    const rec = recording(startMs, 5.7, 35);

    handleCompletedRecording(rec, 'Easy Run');

    expect(wk1().rated[key]).toBe(7);
    expect(wk1().garminActuals?.[key]?.garminId).toBe(`guided-${rec.id}`);
    expect(wk1().rated['W1-easy-0']).toBeUndefined();                  // was the phantom running slot

    const twin: GarminActivityRow = {
      garmin_id: 'strava-hx-1', activity_type: 'RUNNING', start_time: new Date(startMs + 60000).toISOString(),
      duration_sec: 35 * 60 + 20, distance_m: 5720, avg_pace_sec_km: 368, avg_hr: 150, max_hr: 165,
      calories: null, aerobic_effect: null, anaerobic_effect: null,
    };
    matchAndAutoComplete([twin]);

    expect(wk1().garminMatched!['strava-hx-1']).toBe(key);              // was 'W1-easy-0'
    expect(wk1().garminActuals?.[key]?.garminId).toBe('strava-hx-1');
    const ctx = computeWeekStatusContext(PLAN_START, 1, 1);
    const card = (wk1().triWorkouts ?? []).find(w => w === fri)!;
    expect(deriveWorkoutStatus(card, wk1(), ctx).label).toBe('Logged');
  });

  it("the 'Tempo Run' card completes its own slot: no extra-run adhoc and no running modal", () => {
    const s = hyroxState();
    const tempo = stored(w => w.n === 'Tempo Run');
    expect(tempo?.discipline).toBe('run');
    vi.setSystemTime(on(tempo.dayOfWeek!, 19));
    const rpeAdjBefore = s.rpeAdj;
    const rec = recording(on(tempo.dayOfWeek!, 18).getTime(), 6.5, 36);

    handleCompletedRecording(rec, 'Tempo Run');

    expect((wk1().adhocWorkouts ?? []).filter(w => String(w.id).startsWith('gps_'))).toEqual([]);
    expect(document.querySelector('#btn-gps-assign-yes')).toBeNull();
    expect(modal.calls).toBe(0);
    expect(wk1().rated[keyOf(tempo)]).toBe(7);
    expect(getMutableState().rpeAdj).toBe(rpeAdjBefore);
  });

  it('an impromptu run no HYROX session fits is logged, with no running modal and no running VDOT', () => {
    const s = hyroxState();
    vi.setSystemTime(on(3, 9));
    const rpeAdjBefore = s.rpeAdj;
    const rec = recording(on(3, 7).getTime(), 25, 150); // no HYROX run is near 25 km

    handleCompletedRecording(rec, 'Just Run');

    expect(document.querySelector('#btn-gps-assign-yes')).toBeNull();
    expect(modal.calls).toBe(0);
    expect(wk1().adhocWorkouts?.map(w => w.id)).toContain(rec.id);
    expect(wk1().rated[rec.id]).toBe(7);
    expect(wk1().garminActuals?.[rec.id]?.garminId).toBe(`guided-${rec.id}`);
    expect(getMutableState().rpeAdj).toBe(rpeAdjBefore);
    expect(wk1().workoutMods ?? []).toEqual([]);
  });
});

describe('triathlon: in-app GPS runs reach per-discipline CTL once', () => {
  const recAt = (daysAgo: number) => recording(Date.now() - daysAgo * 86400000, 8, 45);
  const week = (parts: Partial<Week>): Week => ({ w: 1, rated: {}, triWorkouts: [], garminActuals: {}, ...parts } as unknown as Week);

  it('a week with only an in-app GPS run gives run CTL above zero', () => {
    vi.setSystemTime(on(4, 12));
    const rec = recAt(1);
    const wks = [week({ garminActuals: { [rec.id]: buildGpsRunActual(rec, { rpe: 6, name: 'Just Run' }) } })];
    const acts = inAppGpsRunActivities(wks);
    expect(acts).toHaveLength(1);
    expect(acts[0].activityType).toBe('RUNNING');
    expect(estimateDirectPerDisciplineCTLFromActivities(acts).run.ctl).toBeGreaterThan(0);
  });

  it('a superseded record is not emitted (the synced row counts from the DB log)', () => {
    const rec = recAt(1);
    const superseded = { ...buildGpsRunActual(rec, { rpe: 6, name: 'Easy run' }), garminId: 'strava-9', activityType: 'RUNNING' };
    expect(inAppGpsRunActivities([week({ garminActuals: { 'W1-easy-0': superseded } })])).toEqual([]);
  });

  it('a tri slot completed by a GPS run counts the run once, not also its planned load', () => {
    const rec = recAt(1);
    const slot = { id: 'W1-easy-0', n: 'Easy run', t: 'easy', discipline: 'run', aerobic: 57, anaerobic: 3, estimatedDurationMin: 65, dayOfWeek: 2 } as Workout;
    const wks = [week({
      triWorkouts: [slot], rated: { 'W1-easy-0': 7 },
      garminActuals: { 'W1-easy-0': buildGpsRunActual(rec, { rpe: 7, name: 'Easy run', slot: { workoutName: 'Easy run', plannedType: 'easy' } }) },
    })];
    expect(manualDoneTriActivities(wks, PLAN_START)).toEqual([]);
    expect(inAppGpsRunActivities(wks)).toHaveLength(1);
  });
});
