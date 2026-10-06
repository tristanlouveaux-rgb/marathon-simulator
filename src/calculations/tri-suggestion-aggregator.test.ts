import { describe, it, expect, afterEach, vi } from 'vitest';
import { collectTriSuggestions } from './tri-suggestion-aggregator';
import type { SimulatorState } from '@/types/state';

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

  it('volume-ramp violation → emits a trim_volume mod', () => {
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
    const r = collectTriSuggestions(s);
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
    const r = collectTriSuggestions(s);
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
    });
  });
});
