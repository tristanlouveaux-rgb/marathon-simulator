// @vitest-environment jsdom
/**
 * Planned-TSS pricing of replaced and skipped sessions (audit B11) and the
 * Plan-tab per-workout planned TSS (audit B2 remainder).
 *
 * B11: a fully replaced run keeps the description '0km (replaced)'.
 * estimateWorkoutDurMin floors that to 1 minute, so the day priced at 1 TSS,
 * counted as a training day with a 1-TSS target, and pulled perSessionAvg down.
 * Home then read 100x today's load against the target and said "Big session
 * today" from passive steps alone.
 *
 * B2: the Plan-tab card priced runs at TL_PER_MIN[w.rpe] (0.65/min for an RPE-3
 * easy run) while the day target uses plannedTssPerMin(type) (0.92/min), so an
 * on-plan easy run read about 140% in red on the card and in activity detail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { getPlannedDayTSSContext } from './planned-day-tss';
import { resolveWeekWorkouts } from './week-resolve';
import { planCardPlannedTSS } from './plan-view';
import {
  computePlannedDaySignalBTSS, computePlannedWorkoutSignalBTSS, estimateWorkoutDurMin, computeDayTargetTSS,
} from '@/calculations/fitness-model';
import { TL_PER_MIN } from '@/constants';
import { setState, resetState, getDefaultState } from '@/state/store';
import type { SimulatorState, Workout } from '@/types/state';

const EASY_SEC_PER_KM = 330;
const BASE_MIN_PER_KM = EASY_SEC_PER_KM / 60;

function runningState(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    w: 1,
    tw: 18,
    rw: 4,
    rd: 'half',
    typ: 'balanced',
    v: 45,
    gs: 0,
    pac: { e: EASY_SEC_PER_KM },
    wks: [{ ph: 'build', rated: {}, skip: [], workoutMods: [] }],
  } as unknown as SimulatorState;
}

/** The workoutMod the excess-load / activity-review Replace path writes. */
function replaceMod(w: any) {
  return {
    name: w.n, dayOfWeek: w.dayOfWeek, status: 'replaced', modReason: 'Garmin: Cycling',
    confidence: 'high', originalDistance: w.d, newDistance: '0km (replaced)', newType: w.t, newRpe: w.rpe ?? w.r,
  };
}

/** An easy run that is the only planned session on its day. */
function soleEasyRun(s: SimulatorState): any {
  const resolved = resolveWeekWorkouts(s, 1).filter((w: any) => w.t !== 'cross');
  const easy = resolved.find((w: any) => w.t === 'easy'
    && resolved.filter((o: any) => o.dayOfWeek === w.dayOfWeek).length === 1);
  expect(easy).toBeDefined();
  return easy;
}

describe('Replaced and skipped sessions price at 0 in the planned-day target (B11)', () => {
  beforeEach(() => resetState());

  it('a replaced or skipped workout prices at 0; a reduced one keeps its price', () => {
    const base: Workout = { n: 'Easy Run', t: 'easy', d: '8km', r: 3, rpe: 3, dayOfWeek: 0 } as Workout;
    expect(computePlannedWorkoutSignalBTSS(base, BASE_MIN_PER_KM)).toBeGreaterThan(0);
    expect(computePlannedWorkoutSignalBTSS({ ...base, d: '0km (replaced)', status: 'replaced' }, BASE_MIN_PER_KM)).toBe(0);
    expect(computePlannedWorkoutSignalBTSS({ ...base, status: 'skipped' }, BASE_MIN_PER_KM)).toBe(0);
    expect(computePlannedWorkoutSignalBTSS({ ...base, d: '5km', status: 'reduced' }, BASE_MIN_PER_KM)).toBeGreaterThan(0);
    expect(computePlannedDaySignalBTSS([{ ...base, d: '0km (replaced)', status: 'replaced' }], 0, BASE_MIN_PER_KM)).toBe(0);
  });

  it('a day whose only run was replaced is a 0-TSS rest day and leaves the training-day average alone', () => {
    const s = runningState();
    setState(s);
    const before = getPlannedDayTSSContext(s, 1);
    const easy = soleEasyRun(s);
    const day = easy.dayOfWeek;
    const easyTSS = before.plannedTSSForDay(day);
    expect(easyTSS).toBeGreaterThan(0);

    (s.wks![0] as any).workoutMods = [replaceMod(easy)];
    setState(s);
    const after = getPlannedDayTSSContext(s, 1);

    expect(after.plannedTSSForDay(day)).toBe(0);
    expect(after.plannedWeekTSS).toBe(before.plannedWeekTSS - easyTSS);
    expect(after.trainingDayCount).toBe(Math.max(before.trainingDayCount - 1, 1));
    expect(after.perSessionAvg).toBeCloseTo(after.plannedWeekTSS / after.trainingDayCount, 6);
    // Still listed so callers can show it, flagged and unpriced.
    const listed = after.workoutsForDay(day);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('replaced');
    expect(listed[0].plannedTSS).toBe(0);
    expect(listed[0].plannedDurationMin).toBe(0);
  });

  it('the replaced day gets the rest-day target, not a 1-TSS training target', () => {
    const s = runningState();
    setState(s);
    const easy = soleEasyRun(s);
    (s.wks![0] as any).workoutMods = [replaceMod(easy)];
    setState(s);
    const ctx = getPlannedDayTSSContext(s, 1);
    const planned = ctx.plannedTSSForDay(easy.dayOfWeek);
    const target = computeDayTargetTSS(planned, null, ctx.perSessionAvg, planned === 0, false);
    expect(target.lo).toBe(0);
    expect(target.mid).toBeGreaterThan(1);
  });

  it('a run skipped by rating stays priced (CTL adherence must see it as planned)', () => {
    const s = runningState();
    setState(s);
    const before = getPlannedDayTSSContext(s, 1);
    const easy = soleEasyRun(s);
    (s.wks![0] as any).rated = { [easy.id || easy.n]: 'skip' };
    setState(s);
    const after = getPlannedDayTSSContext(s, 1);
    expect(after.plannedTSSForDay(easy.dayOfWeek)).toBe(before.plannedTSSForDay(easy.dayOfWeek));
  });
});

describe('Triathlon / HYROX mirror: skipped sessions leave the day target, swapped ones stay', () => {
  function triState(status?: string): SimulatorState {
    return {
      ...getDefaultState(),
      eventType: 'triathlon',
      w: 1,
      tw: 12,
      wks: [{
        ph: 'base',
        triWorkouts: [
          { id: 'W1-bike-0', n: 'Endurance ride', t: 'bike_endurance', d: '60min Z2', r: 4, discipline: 'bike', dayOfWeek: 3, aerobic: 40, anaerobic: 10, estimatedDurationMin: 60, status },
        ],
        adhocWorkouts: [],
        rated: {},
      }],
    } as unknown as SimulatorState;
  }

  it('a pushed or dropped (skipped) session prices at 0', () => {
    expect(getPlannedDayTSSContext(triState(), 1).plannedTSSForDay(3)).toBe(50);
    const ctx = getPlannedDayTSSContext(triState('skipped'), 1);
    expect(ctx.plannedTSSForDay(3)).toBe(0);
    expect(ctx.plannedWeekTSS).toBe(0);
  });

  it("a 'replaced' session (swapped to an easier one, still to be done) keeps its price", () => {
    expect(getPlannedDayTSSContext(triState('replaced'), 1).plannedTSSForDay(3)).toBe(50);
  });
});

describe('Plan-tab card planned TSS reads the day-target pricer (B2)', () => {
  beforeEach(() => resetState());

  it('an RPE-3 easy run is valued at the RPE-4 row, the same number as its day target', () => {
    const s = runningState();
    setState(s);
    const easy = soleEasyRun(s);
    expect(easy.rpe ?? easy.r).toBe(3);
    const durMin = estimateWorkoutDurMin(easy, BASE_MIN_PER_KM);

    const card = planCardPlannedTSS(easy, s);
    expect(card).toBe(Math.round(durMin * TL_PER_MIN[4]));
    expect(card).not.toBe(Math.round(durMin * TL_PER_MIN[3]));
    expect(card).toBe(getPlannedDayTSSContext(s, 1).plannedTSSForDay(easy.dayOfWeek));
  });

  it('every run card matches its day-target price', () => {
    const s = runningState();
    setState(s);
    const ctx = getPlannedDayTSSContext(s, 1);
    const runs = resolveWeekWorkouts(s, 1).filter((w: any) => w.t !== 'cross' && w.t !== 'gym' && w.t !== 'rest');
    expect(runs.length).toBeGreaterThan(0);
    for (const w of runs) {
      const listed = ctx.workoutsForDay(w.dayOfWeek).find(p => p.name === w.n);
      expect(listed).toBeDefined();
      expect(planCardPlannedTSS(w, s)).toBe(listed!.plannedTSS);
    }
  });

  it('a replaced run card shows no planned load', () => {
    const s = runningState();
    setState(s);
    const easy = soleEasyRun(s);
    (s.wks![0] as any).workoutMods = [replaceMod(easy)];
    setState(s);
    const replaced = resolveWeekWorkouts(s, 1).find((w: any) => w.n === easy.n && w.dayOfWeek === easy.dayOfWeek);
    expect(replaced.status).toBe('replaced');
    expect(planCardPlannedTSS(replaced, s)).toBe(0);
  });
});
