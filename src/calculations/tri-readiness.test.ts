import { describe, it, expect, afterEach, vi } from 'vitest';
import { computeTriReadiness, findUpcomingHardSession } from './tri-readiness';
import type { SimulatorState } from '@/types/state';

// Minimal tri state with identical fitness across all three disciplines, so the
// ONLY thing that can make one discipline's readiness differ is the leg-load
// floor. Fresh + safe values → no floor fires on its own.
function triState(recentLegLoads: SimulatorState['recentLegLoads'] = []): SimulatorState {
  const disc = { ctl: 70, atl: 56, tsb: 14, directCount: 5 }; // fresh, ACWR 0.8
  return {
    w: 1,
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

describe('findUpcomingHardSession — week index (s.w is 1-based)', () => {
  // Regression: the lookahead indexed wks[s.w] as the current week, which is
  // next week under the store convention (store.ts default w: 1).
  afterEach(() => { vi.useRealTimers(); });

  const q = (id: string, dow: number) =>
    ({ id, t: 'bike_threshold', n: id, d: '60min', r: 8, rpe: 8, discipline: 'bike', dayOfWeek: dow });
  const s = (wks: any[]) => ({ w: 1, wks } as unknown as SimulatorState);

  it('looks at the current week (wks[0]) first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0)); // local Wednesday (dow 2)
    const hit = findUpcomingHardSession(s([
      { triWorkouts: [q('cur-thu', 3)] },
      { triWorkouts: [q('next-thu', 3)] },
    ]), 2);
    expect(hit?.workout.id).toBe('cur-thu');
    expect(hit?.dayLabel).toBe('Thursday');
  });

  it('wraps into next week (wks[1]) past Sunday', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 10, 12, 0, 0)); // local Saturday (dow 5)
    const hit = findUpcomingHardSession(s([
      { triWorkouts: [] },
      { triWorkouts: [q('next-mon', 0)] },
      { triWorkouts: [q('after-mon', 0)] },
    ]), 2);
    expect(hit?.workout.id).toBe('next-mon');
    expect(hit?.dayLabel).toBe('Monday');
  });
});
