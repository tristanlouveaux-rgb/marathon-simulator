import { describe, it, expect } from 'vitest';
import { collectTriSuggestions } from './tri-suggestion-aggregator';
import type { SimulatorState } from '@/types/state';

function state(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
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
      w: 0,
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

  it('cross-training overload pushes a cross_training_overload mod with overloadOptions', () => {
    // Planned 400 TSS tri week, +120 TSS tennis logged as adhoc → 30%
    // overshoot → extreme severity (mapped to 'warning' on the mod).
    // v2 recommends bike (most remaining TSS) and surfaces the full per-
    // discipline option set via `overloadOptions`.
    const s = state({
      w: 0,
      wks: [{
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'Long bike', d: '4h', r: 5, discipline: 'bike', aerobic: 200, anaerobic: 20, dayOfWeek: 5 },
          { id: 'r1', t: 'threshold', n: 'Run threshold', d: '60min', r: 8, discipline: 'run', aerobic: 80, anaerobic: 30, dayOfWeek: 1 },
          { id: 's1', t: 'swim_endurance', n: 'Swim', d: '45min', r: 4, discipline: 'swim', aerobic: 60, anaerobic: 10, dayOfWeek: 2 },
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
    expect(xt!.discipline).toBe('bike'); // bike has most remaining TSS
    expect(xt!.overloadOptions).toBeDefined();
    expect(xt!.overloadOptions!.recommendedDiscipline).toBe('bike');
    expect(xt!.overloadOptions!.options.bike.reduceMods.length).toBeGreaterThan(0);
    expect(r.diagnostics.crossTrainingOverload).toBe(true);
  });

  it('headline + body strings are populated for every mod', () => {
    const s = state({
      w: 0,
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
});
