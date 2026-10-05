// @vitest-environment jsdom
/**
 * Timing suggestions are built from the plan as the Plan tab shows it, and an
 * accepted suggestion is a real, lasting change (audit A3, A14, A15).
 *
 * Before: mergeTimingMods regenerated the raw week (no mods, a shorter generator
 * argument list) and appended suggestions last; Apply wrote the raw-plan distance
 * and type over an earlier cut, wrote no RPE, keyed the accepted mod by the moved
 * day (so a drag-moved session ignored it), and the suggestion came back on the
 * next sync. applyDistReduction cut the first "Nkm" token (a structured session's
 * warm-up, raised to the 3 km floor) and wrote "N km", which the planned-TSS
 * parser cannot read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));

import { applyDistReduction, mergeTimingMods, acceptTimingSuggestion, isTimingMod } from './timing-check';
import { resolveWeekWorkouts } from '@/ui/week-resolve';
import { estimateWorkoutDurMin } from '@/calculations/fitness-model';
import { parseDistanceKm } from '@/workouts/workout-scaling';
import { TSS_RPE_BY_TYPE } from '@/constants/sports';
import { isLongRun } from '@/workouts/long-run';
import { setState, resetState, getDefaultState, getMutableState } from '@/state/store';
import type { SimulatorState, Week, WorkoutMod } from '@/types';

const PLAN_START = '2026-03-02'; // a Monday

function runningState(): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'running',
    planStartDate: PLAN_START,
    w: 1,
    tw: 18,
    rw: 4,
    rd: 'half',
    typ: 'balanced',
    v: 45,
    gs: 0,
    pac: { e: 330 },
    wks: [{ w: 1, ph: 'build', rated: {}, skip: [], workoutMods: [], garminActuals: {}, adhocWorkouts: [] }],
  } as unknown as SimulatorState;
}

/** A synced session on `day` (0 = Mon) worth `tss` Signal-B TSS (no iTRIMP: 0.92/min). */
function hardSessionOn(wk: Week, day: number, tss: number): void {
  const d = new Date(PLAN_START + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + day);
  const id = `strava-hard-${day}`;
  (wk.garminActuals as any)[`garmin-${id}`] = {
    garminId: id, startTime: `${d.toISOString().slice(0, 10)}T08:00:00Z`,
    durationSec: Math.round((tss / 0.92) * 60), iTrimp: null, distanceKm: 0,
  };
}

function longRun(s: SimulatorState): any {
  const lr = resolveWeekWorkouts(s, 1).find((w: any) => isLongRun(w));
  expect(lr).toBeDefined();
  expect(lr.dayOfWeek).toBeGreaterThan(0);
  return lr;
}

/** Pending timing suggestions on a session (by stable id, or by name for a mod without one). */
const timingModsFor = (wk: Week, w: { id: string; n: string }) =>
  (wk.workoutMods ?? []).filter(m => isTimingMod(m.modReason) && (m.workoutId ? m.workoutId === w.id : m.name === w.n));

describe('applyDistReduction cuts the main set and writes a parsable distance', () => {
  it('a structured session keeps its warm-up and cool-down; only the work block shortens', () => {
    const desc = '1km warm up (5:30/km+)\n3×8min @ 4:09/km (~1.9km), 2 min recovery between sets\n1km cool down (5:30/km+)';
    const out = applyDistReduction(desc, 0.25).split('\n');
    expect(out[0]).toBe('1km warm up (5:30/km+)');
    expect(out[2]).toBe('1km cool down (5:30/km+)');
    expect(out[1]).toMatch(/^3×6min @ 4:09\/km/);
  });

  it('a plain run loses distance from its total, never below the floor, never lengthened', () => {
    expect(applyDistReduction('16km @ 4:50/km', 0.10)).toBe('14.4km @ 4:50/km');
    expect(applyDistReduction('3.5km', 0.25)).toBe('3km');
    expect(applyDistReduction('2km', 0.25)).toBe('2km');
  });

  it('the reduced distance is read by the planned-TSS duration parser', () => {
    const base = { t: 'long', n: 'Long Run', r: 3, rpe: 3 } as any;
    const full = estimateWorkoutDurMin({ ...base, d: '16km @ 4:50/km' }, 5.5);
    const cut = estimateWorkoutDurMin({ ...base, d: applyDistReduction('16km @ 4:50/km', 0.10) }, 5.5);
    expect(cut / full).toBeCloseTo(0.9, 2);
  });
});

describe('mergeTimingMods builds suggestions from the resolved plan', () => {
  beforeEach(() => resetState());

  it('a replaced session gets no timing suggestion', () => {
    const s = runningState();
    setState(s);
    const lr = longRun(s);
    const wk = getMutableState().wks[0];
    hardSessionOn(wk, lr.dayOfWeek - 1, 110);
    wk.workoutMods = [{
      name: lr.n, dayOfWeek: lr.dayOfWeek, workoutId: lr.id, status: 'replaced', modReason: 'Garmin: Cycling',
      originalDistance: lr.d, newDistance: '0km (replaced)', newType: lr.t,
    }];
    mergeTimingMods(getMutableState(), wk);
    expect(timingModsFor(wk, lr)).toHaveLength(0);
  });

  it('accepting a suggestion on an already-cut session keeps the cut and replaces, not stacks', () => {
    const s = runningState();
    setState(s);
    const lr = longRun(s);
    const planKm = parseDistanceKm(lr.d)!;
    const wk = getMutableState().wks[0];
    hardSessionOn(wk, lr.dayOfWeek - 1, 110); // ≥100 TSS tier: 2 steps, 15% shorter
    const cutKm = Math.round(planKm * 0.6 * 10) / 10;
    wk.workoutMods = [{
      name: lr.n, dayOfWeek: lr.dayOfWeek, workoutId: lr.id, status: 'reduced', modReason: 'Garmin: Cycling',
      originalDistance: lr.d, newDistance: `${cutKm}km (was ${planKm}km)`, newType: 'long',
    }];

    mergeTimingMods(getMutableState(), wk);
    const [suggestion] = timingModsFor(wk, lr);
    expect(suggestion).toBeDefined();
    expect(parseDistanceKm(suggestion.newDistance)).toBeLessThan(cutKm);

    expect(acceptTimingSuggestion(wk, { workoutId: lr.id, name: lr.n, dayOfWeek: lr.dayOfWeek })).toBe(true);
    const nonTiming = wk.workoutMods!.filter(m => !isTimingMod(m.modReason) && m.workoutId === lr.id);
    expect(nonTiming).toHaveLength(1);
    expect(nonTiming[0].previousMod?.modReason).toBe('Garmin: Cycling');
    expect(nonTiming[0].originalDistance).toBe(lr.d);

    const after = resolveWeekWorkouts(getMutableState(), 1).find((w: any) => w.id === lr.id);
    expect(after.status).toBe('reduced');
    expect(parseDistanceKm(after.d)).toBeLessThan(cutKm);
  });

  it('an accepted suggestion does not come back on the next merge', () => {
    const s = runningState();
    setState(s);
    const lr = longRun(s);
    const wk = getMutableState().wks[0];
    hardSessionOn(wk, lr.dayOfWeek - 1, 110);
    mergeTimingMods(getMutableState(), wk);
    expect(timingModsFor(wk, lr)).toHaveLength(1);
    acceptTimingSuggestion(wk, { workoutId: lr.id, name: lr.n, dayOfWeek: lr.dayOfWeek });

    mergeTimingMods(getMutableState(), wk);
    mergeTimingMods(getMutableState(), wk);
    expect(timingModsFor(wk, lr)).toHaveLength(0);
    expect(wk.workoutMods!.filter(m => m.workoutId === lr.id)).toHaveLength(1);
  });

  it('Apply writes the new RPE and a canonical workout type', () => {
    const s = runningState();
    setState(s);
    const lr = longRun(s);
    const wk = getMutableState().wks[0];
    hardSessionOn(wk, lr.dayOfWeek - 1, 60); // 50–74 TSS tier: 1 step (long → marathon pace), no cut
    mergeTimingMods(getMutableState(), wk);
    const [suggestion] = timingModsFor(wk, lr);
    expect(suggestion.newType).toBe('marathon_pace');
    acceptTimingSuggestion(wk, { workoutId: lr.id, name: lr.n, dayOfWeek: lr.dayOfWeek });

    const accepted = wk.workoutMods!.find(m => m.workoutId === lr.id) as WorkoutMod;
    expect(accepted.newRpe).toBe(suggestion.newRpe);
    const after = resolveWeekWorkouts(getMutableState(), 1).find((w: any) => w.id === lr.id);
    expect(after.rpe).toBe(suggestion.newRpe);
    expect(TSS_RPE_BY_TYPE[after.t]).toBeDefined();
  });

  it('Apply on a drag-moved session changes that session', () => {
    const s = runningState();
    setState(s);
    const lr = longRun(s);
    const wk = getMutableState().wks[0];
    // Move the long run one day earlier, with the hard session the day before its new day.
    const newDay = lr.dayOfWeek - 1;
    wk.workoutMoves = { [lr.id]: newDay };
    hardSessionOn(wk, newDay - 1, 110);

    mergeTimingMods(getMutableState(), wk);
    const [suggestion] = timingModsFor(wk, lr);
    expect(suggestion?.dayOfWeek).toBe(newDay);
    acceptTimingSuggestion(wk, { workoutId: suggestion.workoutId, name: suggestion.name, dayOfWeek: suggestion.dayOfWeek });

    const after = resolveWeekWorkouts(getMutableState(), 1).find((w: any) => w.id === lr.id);
    expect(after.dayOfWeek).toBe(newDay);
    expect(after.status).toBe('reduced');
    expect(after.modReason).toMatch(/^Timing accepted:/);
  });
});
