import { describe, it, expect, afterEach, vi } from 'vitest';
import { collectTriSuggestions, TRI_VOLUME_RAMP_SUGGESTIONS_LIVE } from './tri-suggestion-aggregator';
import { applyTriSuggestions } from './tri-suggestion-apply';
import { markTriSuggestionsHandled } from './tri-suggestion-handled';
import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { getDefaultState } from '@/state/store';
import type { SimulatorState, Workout } from '@/types/state';

// s.w is 1-based (store.ts default w: 1): w: 1 means the current week is
// wks[0] and next week is wks[1].
function state(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 1,
    wks: [],
    triConfig: { distance: 'ironman', fitness: { swim: { ctl: 0, atl: 0, tsb: 0 }, bike: { ctl: 0, atl: 0, tsb: 0 }, run: { ctl: 0, atl: 0, tsb: 0 }, combinedCtl: 0 } },
    ...overrides,
  } as unknown as SimulatorState;
}

describe('collectTriSuggestions', () => {
  it('empty state → no mods', () => {
    const r = collectTriSuggestions(state());
    expect(r.mods).toEqual([]);
    expect(r.diagnostics.rampViolations).toBe(0);
    expect(r.diagnostics.rpeBlown).toBe(false);
  });

  it('volume-ramp violation → emits a trim_volume mod (detector switched on)', () => {
    const s = state({
      w: 1,
      wks: [
        { garminActuals: { a1: { garminId: 'a1', durationSec: 5 * 3600, activityType: 'CYCLING' } } as any },
        {
          triWorkouts: [
            { id: 'b1', t: 'bike_endurance', n: 'B', d: '7h', r: 5, discipline: 'bike', estimatedDurationMin: 7 * 60 },
          ],
        },
      ] as any,
    });
    const r = collectTriSuggestions(s, { volumeRamp: true });
    expect(r.mods.length).toBeGreaterThanOrEqual(1);
    const ramp = r.mods.find(m => m.source === 'volume_ramp');
    expect(ramp).toBeDefined();
    expect(ramp!.discipline).toBe('bike');
    expect(ramp!.action).toBe('trim_volume');
    expect(ramp!.targetWorkoutId).toBe('b1');
  });

  it('all detectors off → no mods, no errors', () => {
    const s = state();
    const r = collectTriSuggestions(s);
    expect(r.mods).toEqual([]);
  });

  it('cross-training overload pushes a cross_training_overload mod with overloadOptions (run-anchored)', () => {
    // Planned 400 TSS tri week, +120 TSS tennis logged as adhoc → 30%
    // overshoot → extreme severity (mapped to 'warning' on the mod).
    // v2 anchors recommendation on RUN by default for tennis (run-affinity)
    // and surfaces the full per-discipline option set via `overloadOptions`.
    // All workouts dated dow=6 so they're upcoming regardless of "today".
    const s = state({
      w: 1,
      wks: [{
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'Long bike', d: '4h', r: 5, discipline: 'bike', aerobic: 200, anaerobic: 20, dayOfWeek: 6 },
          { id: 'r1', t: 'threshold', n: 'Run threshold', d: '60min', r: 8, discipline: 'run', aerobic: 80, anaerobic: 30, dayOfWeek: 6 },
          { id: 's1', t: 'swim_endurance', n: 'Swim', d: '45min', r: 4, discipline: 'swim', aerobic: 60, anaerobic: 10, dayOfWeek: 6 },
        ],
        adhocWorkouts: [
          { id: 'tennis', t: 'cross', n: 'tennis', d: '120min', r: 7, iTrimp: 18000 } as any,
        ],
      }] as any,
    });
    const r = collectTriSuggestions(s);
    const xt = r.mods.find(m => m.source === 'cross_training_overload');
    expect(xt).toBeDefined();
    expect(xt!.severity).toBe('warning'); // detector 'extreme' → mod 'warning'
    expect(xt!.discipline).toBe('run'); // tennis = run-affinity → run-anchored
    expect(xt!.overloadOptions).toBeDefined();
    expect(xt!.overloadOptions!.recommendedDiscipline).toBe('run');
    expect(xt!.overloadOptions!.options.run.reduceMods.length).toBeGreaterThan(0);
    expect(r.diagnostics.crossTrainingOverload).toBe(true);
  });

  it('headline + body strings are populated for every mod', () => {
    const s = state({
      w: 1,
      wks: [
        { garminActuals: { a1: { garminId: 'a1', durationSec: 5 * 3600, activityType: 'CYCLING' } } as any },
        {
          triWorkouts: [
            { id: 'b1', t: 'bike_endurance', n: 'B', d: '7h', r: 5, discipline: 'bike', estimatedDurationMin: 7 * 60 },
          ],
        },
      ] as any,
    });
    const r = collectTriSuggestions(s, { volumeRamp: true });
    expect(r.mods.length).toBeGreaterThan(0);
    for (const m of r.mods) {
      expect(m.headline.length).toBeGreaterThan(5);
      expect(m.body.length).toBeGreaterThan(10);
      expect(['caution', 'warning']).toContain(m.severity);
    }
  });

  describe('readiness gate targets today in the current week', () => {
    afterEach(() => { vi.useRealTimers(); });

    it("the readiness mod targets today's session in wks[0], not next week's", () => {
      // Regression: the gate read wks[s.w] (next week under the store
      // convention), so the swap/downgrade landed on next week's session that
      // shares today's weekday.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0)); // local Wednesday (dow 2)
      const disc = { ctl: 70, atl: 56, tsb: 14, directCount: 5 };
      const s = state({
        w: 1,
        physiologyHistory: [],
        // Heavy leg load floors run readiness (Ease Back or worse), which
        // fires the readiness gate. Same fixture as tri-readiness.test.ts.
        recentLegLoads: [{ load: 80, sport: 'strength', sportLabel: 'Strength', timestampMs: Date.now(), recoveryMultOverride: 1.2 }],
        triConfig: {
          distance: 'ironman',
          fitness: { swim: { ...disc }, bike: { ...disc }, run: { ...disc } },
          fitnessHistory: [{}, {}, {}, {}],
        },
        wks: [
          { triWorkouts: [{ id: 'cur-wed', t: 'threshold', n: 'Threshold run', d: '60min', r: 8, rpe: 8, discipline: 'run', dayOfWeek: 2, estimatedDurationMin: 60 }] },
          { triWorkouts: [{ id: 'next-wed', t: 'threshold', n: 'Threshold run', d: '60min', r: 8, rpe: 8, discipline: 'run', dayOfWeek: 2, estimatedDurationMin: 60 }] },
        ],
      } as any);
      const r = collectTriSuggestions(s);
      const mod = r.mods.find(m => m.source === 'readiness');
      expect(mod).toBeDefined();
      expect(mod!.targetWorkoutId).toBe('cur-wed');

      // Dismissed (or left unticked) in the modal: not proposed again this week.
      markTriSuggestionsHandled(s, { modIds: [mod!.id] });
      expect(collectTriSuggestions(s).mods.find(m => m.source === 'readiness')).toBeUndefined();
    });

    it('an accepted downgrade is not downgraded again on the next launch', () => {
      // Regression (review of a1): the finder excluded only 'skipped', and the
      // downgraded rungs (sweet spot, tempo) still read as quality, so each
      // launch stepped today's bike session down another rung.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0)); // local Wednesday (dow 2)
      const disc = { ctl: 70, atl: 56, tsb: 14, directCount: 5 };
      const s = state({
        w: 1,
        physiologyHistory: [],
        recentLegLoads: [{ load: 80, sport: 'strength', sportLabel: 'Strength', timestampMs: Date.now(), recoveryMultOverride: 1.2 }],
        triConfig: {
          distance: 'ironman',
          fitness: { swim: { ...disc }, bike: { ...disc }, run: { ...disc } },
          fitnessHistory: [{}, {}, {}, {}],
          bike: { ftp: 220, hasPowerMeter: true },
        },
        wks: [
          { ph: 'build', triWorkouts: [{ id: 'cur-wed-bike', t: 'bike_threshold', n: 'Threshold ride', d: '2×20min @ 213–227W', r: 8, rpe: 8, discipline: 'bike', dayOfWeek: 2, estimatedDurationMin: 75 }] },
        ],
      } as any);
      const bike = (s.wks as any)[0].triWorkouts[0];
      const first = collectTriSuggestions(s).mods.find(m => m.source === 'readiness');
      expect(first?.action).toBe('downgrade_today'); // Ease Back / Manage Load
      for (let launch = 0; launch < 3; launch++) {
        const mod = collectTriSuggestions(s).mods.find(m => m.source === 'readiness');
        if (mod) applyTriSuggestions(s, [mod]);
      }
      // One rung (threshold -> sweet spot), not three (-> tempo -> endurance).
      expect(bike.t).toBe('bike_sweet_spot');
      expect(bike.status).toBe('reduced');
      expect(collectTriSuggestions(s).mods.find(m => m.source === 'readiness')).toBeUndefined();
    });
  });
});

// ─── Volume ramp: off pending a comparison window; notify-once ─────────────
// Regression (review of a1): reading the current week made the ramp check live,
// and it compares the current week's actuals SO FAR with next week's full plan.
// An Ironman plan at week 3 with one 1 h ride logged proposed trimming next
// week's long ride on every launch, and each accepted trim compounded
// (87 -> 74 -> 63 -> 54 min) because the target finder still matched the
// already-trimmed session.

function realIronman(w: number): SimulatorState {
  const s = {
    ...getDefaultState(),
    eventType: 'triathlon',
    w,
    tw: 20,
    v: 50,
    pac: { e: 300, t: 250, i: 230, m: 275, r: 200 },
    wks: [],
    triConfig: {
      distance: 'ironman',
      timeAvailableHoursPerWeek: 12,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: true, ftp: 220 },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 20,
    },
  } as unknown as SimulatorState;
  s.wks = generateTriathlonPlan(s);
  // One 1 h ride logged so far this week (week 3).
  s.wks[w - 1].garminActuals = {
    ride: { garminId: 'ride', durationSec: 3600, activityType: 'CYCLING', startTime: '2026-10-06T07:00:00Z' } as any,
  };
  return s;
}

const findWorkout = (s: SimulatorState, id: string): Workout | undefined => {
  for (const wk of s.wks ?? []) {
    const w = wk.triWorkouts?.find(x => x.id === id);
    if (w) return w;
  }
  return undefined;
};

describe('volume ramp is not live on a partial week', () => {
  it('is off by default', () => {
    expect(TRI_VOLUME_RAMP_SUGGESTIONS_LIVE).toBe(false);
  });

  it('an Ironman week with one 1 h ride logged proposes no trim', () => {
    const s = realIronman(3);
    const r = collectTriSuggestions(s);
    expect(r.mods.filter(m => m.source === 'volume_ramp')).toEqual([]);
    expect(r.diagnostics.rampViolations).toBe(0);
  });

  it('with the detector on, an accepted trim is not trimmed again on later launches', () => {
    const s = realIronman(3);
    const first = collectTriSuggestions(s, { volumeRamp: true }).mods.find(m => m.id === 'ramp_bike');
    expect(first?.targetWorkoutId).toBeDefined();
    const targetId = first!.targetWorkoutId!;
    const origMin = findWorkout(s, targetId)!.estimatedDurationMin!;

    // Three launches, the user accepts every proposal.
    for (let launch = 0; launch < 3; launch++) {
      const ramp = collectTriSuggestions(s, { volumeRamp: true }).mods.find(m => m.id === 'ramp_bike');
      if (ramp) applyTriSuggestions(s, [ramp]);
    }

    // Trimmed once (85%), not compounded.
    expect(findWorkout(s, targetId)!.estimatedDurationMin).toBe(Math.round(origMin * 0.85));
    const again = collectTriSuggestions(s, { volumeRamp: true }).mods.find(m => m.id === 'ramp_bike');
    expect(again?.targetWorkoutId).not.toBe(targetId);
  });

  it('an answered ramp proposal is not proposed again this week', () => {
    const s = realIronman(3);
    const ramp = collectTriSuggestions(s, { volumeRamp: true }).mods.find(m => m.id === 'ramp_bike');
    expect(ramp).toBeDefined();
    applyTriSuggestions(s, [ramp!]);
    markTriSuggestionsHandled(s, { modIds: [ramp!.id] });
    const next = collectTriSuggestions(s, { volumeRamp: true });
    expect(next.mods.find(m => m.id === 'ramp_bike')).toBeUndefined();
    // The stamp lives on the week the user answered in (week 3).
    expect(s.wks[2].triSuggestionsHandled?.modIds).toContain('ramp_bike');
  });
});
