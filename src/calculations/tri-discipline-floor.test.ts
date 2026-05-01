/**
 * Tests for `computeTriDisciplineFloorTSS`.
 *
 * The floor mirrors running's `computeRunningFloorKm` intent: preserve a
 * fraction of weekly volume during base/build/peak, suspend in taper or
 * when injury risk (per-discipline ACWR > 1.3) is high.
 */

import { describe, it, expect } from 'vitest';
import { computeTriDisciplineFloorTSS } from './tri-discipline-floor';
import type { SimulatorState } from '@/types/state';

function state(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
    wks: [],
    triConfig: {
      distance: 'ironman',
      fitness: {
        swim: { ctl: 50, atl: 45, tsb: 5 },  // ACWR = 0.9 (safe)
        bike: { ctl: 80, atl: 70, tsb: 10 }, // ACWR = 0.875 (safe)
        run:  { ctl: 60, atl: 60, tsb: 0 },  // ACWR = 1.0 (safe)
        combinedCtl: 0,
      },
    },
    ...overrides,
  } as unknown as SimulatorState;
}

describe('computeTriDisciplineFloorTSS', () => {
  it('returns 0.65 × planned during base/build/peak', () => {
    const s = state({
      wks: [{
        ph: 'build',
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '3h', r: 5, discipline: 'bike', aerobic: 150, anaerobic: 10 },
          { id: 'b2', t: 'bike_threshold', n: 'BT', d: '60min', r: 8, discipline: 'bike', aerobic: 80, anaerobic: 30 },
        ],
      }] as any,
    });
    // Planned bike TSS = 270. Floor = 270 × 0.65 = 175.5.
    const floor = computeTriDisciplineFloorTSS(s, 'bike', 0);
    expect(floor).toBeCloseTo(175.5, 1);
  });

  it('returns 0 in taper phase', () => {
    const s = state({
      wks: [{
        ph: 'taper',
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '3h', r: 5, discipline: 'bike', aerobic: 150, anaerobic: 10 },
        ],
      }] as any,
    });
    expect(computeTriDisciplineFloorTSS(s, 'bike', 0)).toBe(0);
  });

  it('returns 0 when per-discipline ACWR > 1.3 (hot ramp)', () => {
    // Set bike ACWR to 1.4 (hot).
    const s = state({
      wks: [{
        ph: 'build',
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '3h', r: 5, discipline: 'bike', aerobic: 150, anaerobic: 10 },
        ],
      }] as any,
      triConfig: {
        distance: 'ironman',
        fitness: {
          swim: { ctl: 50, atl: 45, tsb: 5 },
          bike: { ctl: 50, atl: 70, tsb: -20 }, // ACWR = 70/50 = 1.4 (hot)
          run:  { ctl: 60, atl: 60, tsb: 0 },
          combinedCtl: 0,
        },
      },
    });
    expect(computeTriDisciplineFloorTSS(s, 'bike', 0)).toBe(0);
  });

  it("does NOT suspend the floor for OTHER disciplines when only one discipline's ramp is hot", () => {
    // Bike is hot, but run is fine. Run floor should still apply.
    const s = state({
      wks: [{
        ph: 'build',
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '3h', r: 5, discipline: 'bike', aerobic: 150, anaerobic: 10 },
          { id: 'r1', t: 'easy', n: 'R', d: '60min', r: 4, discipline: 'run', aerobic: 80, anaerobic: 10 },
        ],
      }] as any,
      triConfig: {
        distance: 'ironman',
        fitness: {
          swim: { ctl: 50, atl: 45, tsb: 5 },
          bike: { ctl: 50, atl: 70, tsb: -20 }, // ACWR = 1.4 (hot)
          run:  { ctl: 60, atl: 60, tsb: 0 },   // ACWR = 1.0 (safe)
          combinedCtl: 0,
        },
      },
    });
    expect(computeTriDisciplineFloorTSS(s, 'bike', 0)).toBe(0); // suspended
    expect(computeTriDisciplineFloorTSS(s, 'run', 0)).toBeCloseTo(58.5, 1); // 90 × 0.65
  });

  it('returns 0 when discipline has no plan in the week', () => {
    const s = state({
      wks: [{
        ph: 'build',
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '3h', r: 5, discipline: 'bike', aerobic: 150, anaerobic: 10 },
        ],
      }] as any,
    });
    // No swim workouts → floor = 0.
    expect(computeTriDisciplineFloorTSS(s, 'swim', 0)).toBe(0);
  });

  it('returns 0 when CTL is too small for ACWR to be meaningful', () => {
    // perDisciplineACWR returns undefined when ctl < 10. Detector should
    // fall through to the normal floor calc, not suspend.
    const s = state({
      wks: [{
        ph: 'build',
        triWorkouts: [
          { id: 'b1', t: 'bike_endurance', n: 'B', d: '3h', r: 5, discipline: 'bike', aerobic: 100, anaerobic: 10 },
        ],
      }] as any,
      triConfig: {
        distance: 'ironman',
        fitness: {
          swim: { ctl: 5, atl: 3, tsb: 2 },
          bike: { ctl: 5, atl: 5, tsb: 0 },  // ctl < 10 → ACWR undefined
          run:  { ctl: 5, atl: 5, tsb: 0 },
          combinedCtl: 0,
        },
      },
    });
    // Floor falls back to 0.65 × 110 = 71.5 (not 0).
    expect(computeTriDisciplineFloorTSS(s, 'bike', 0)).toBeCloseTo(71.5, 1);
  });

  it('handles missing triConfig.fitness gracefully (defaults to no ACWR check)', () => {
    const s = state({
      wks: [{
        ph: 'build',
        triWorkouts: [
          { id: 'r1', t: 'easy', n: 'R', d: '60min', r: 4, discipline: 'run', aerobic: 50, anaerobic: 10 },
        ],
      }] as any,
      triConfig: { distance: 'ironman' } as any, // no fitness field
    });
    expect(computeTriDisciplineFloorTSS(s, 'run', 0)).toBeCloseTo(39.0, 1); // 60 × 0.65
  });
});
