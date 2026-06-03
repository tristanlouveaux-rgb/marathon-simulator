import { describe, it, expect } from 'vitest';
import { computeTriReadiness } from './tri-readiness';
import type { SimulatorState } from '@/types/state';

// Minimal tri state with identical fitness across all three disciplines, so the
// ONLY thing that can make one discipline's readiness differ is the leg-load
// floor. Fresh + safe values → no floor fires on its own.
function triState(recentLegLoads: SimulatorState['recentLegLoads'] = []): SimulatorState {
  const disc = { ctl: 70, atl: 56, tsb: 14, directCount: 5 }; // fresh, ACWR 0.8
  return {
    w: 0,
    wks: [],
    physiologyHistory: [],
    recentLegLoads,
    triConfig: {
      fitness: {
        swim: { ...disc },
        bike: { ...disc },
        run: { ...disc },
      },
      // ≥3 entries so computeReadiness doesn't take its insufficient-history
      // early-return (which bypasses all floors) — value content is irrelevant.
      fitnessHistory: [{}, {}, {}, {}],
    },
  } as unknown as SimulatorState;
}

const FLOORED = new Set(['Ease Back', 'Overreaching']);

describe('computeTriReadiness — leg-load floor is run-only', () => {
  it('with no leg load, all three disciplines read identically', () => {
    const r = computeTriReadiness(triState([]))!;
    expect(r).not.toBeNull();
    expect(r.run.label).toBe(r.swim.label);
    expect(r.bike.label).toBe(r.swim.label);
    expect(FLOORED.has(r.run.label)).toBe(false); // baseline is fresh, not floored
  });

  it('heavy leg load floors RUN but leaves swim and bike untouched', () => {
    const heavy = [{
      load: 80, // ≥ LEG_LOAD_HEAVY (60) → Ease Back floor
      sport: 'strength',
      sportLabel: 'Strength',
      timestampMs: Date.now(),
      recoveryMultOverride: 1.2,
    }];
    const r = computeTriReadiness(triState(heavy))!;
    // Run is gated by the leg-load floor...
    expect(FLOORED.has(r.run.label)).toBe(true);
    expect(r.run.hardFloor).toBe('legLoad');
    // ...swim and bike are not (non-impact / leg-tolerant disciplines).
    expect(FLOORED.has(r.swim.label)).toBe(false);
    expect(FLOORED.has(r.bike.label)).toBe(false);
    expect(r.swim.hardFloor).not.toBe('legLoad');
    expect(r.bike.hardFloor).not.toBe('legLoad');
  });
});
