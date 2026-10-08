import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Pass-through spy, so a test can pin the race-day result and read the effect on
// the forecast. Unpinned calls run the real implementation.
vi.mock('./race-day-durability', async (importOriginal) => {
  const m = await importOriginal<typeof import('./race-day-durability')>();
  return { ...m, raceDayPlanDurability: vi.fn(m.raceDayPlanDurability) };
});

import { refreshBlendedFitness } from './blended-fitness';
import { raceDayPlanDurability } from './race-day-durability';
import { applyLongRunCap } from './run-durability';
import type { SimulatorState } from '@/types';

/**
 * refreshBlendedFitness (the canonical race-day forecast) applies the durability
 * the plan builds by race day, and stores the exact result it applied for the
 * Durability drill-down. Before 2026-10-07 the forecast carried no durability
 * term at all ("the plan delivers the required long runs").
 */

function lowBaselineMarathon(): SimulatorState {
  return {
    schemaVersion: 1,
    w: 1, tw: 14, v: 45, iv: 45, rpeAdj: 0,
    rd: 'marathon',
    epw: 4, rw: 4, wkm: 15, detectedWeeklyKm: 15,
    athleteArchetype: { archetype: 'detrained-with-history' },
    onboarding: { experienceLevel: 'novice', weeklyTrainingHours: 4 },
    pbs: { h: 105 * 60 }, rec: null, lt: null, vo2: null,
    initialLT: null, initialVO2: null, initialBaseline: null,
    currentFitness: null, forecastTime: null,
    typ: 'Balanced', calculatedRunnerType: 'Balanced',
    b: 1.06, wks: [],
    pac: { e: 330, t: 280, i: 255, m: 300, r: 240 },
    skip: [], timp: 0, expectedFinal: 45,
    restingHR: 50, maxHR: 190,
  } as unknown as SimulatorState;
}

describe('refreshBlendedFitness: race-day forecast reads the plan\'s long runs', () => {
  beforeEach(() => { (raceDayPlanDurability as Mock).mockClear(); });

  it('stores the race-day durability it applied, computed from the plan', () => {
    const s = lowBaselineMarathon();
    expect(refreshBlendedFitness(s)).toBe(true);
    expect(s.raceDayDurability).toBeDefined();
    expect(s.raceDayDurability!.multiplier).toBeGreaterThan(1);
    expect(s.raceDayDurability).toEqual(raceDayPlanDurability(s));
    expect(s.forecastTime).toBeGreaterThan(0);
  });

  it('the forecast time scales by exactly the race-day multiplier', () => {
    const met = applyLongRunCap(170 * 60, 'marathon', 8);      // multiplier 1
    const short = applyLongRunCap(60 * 60, 'marathon', 0);     // full shortfall penalty
    expect(met.multiplier).toBe(1);
    expect(short.multiplier).toBeGreaterThan(1);

    const a = lowBaselineMarathon();
    (raceDayPlanDurability as Mock).mockReturnValueOnce(met);
    refreshBlendedFitness(a);
    const b = lowBaselineMarathon();
    (raceDayPlanDurability as Mock).mockReturnValueOnce(short);
    refreshBlendedFitness(b);

    expect(b.forecastTime! / a.forecastTime!).toBeCloseTo(short.multiplier, 9);
    expect(b.raceDayDurability).toEqual(short);
  });

  it('no running race plan (continuous mode): no race-day term, nothing stored', () => {
    const s = { ...lowBaselineMarathon(), continuousMode: true } as SimulatorState;
    refreshBlendedFitness(s);
    expect(s.raceDayDurability).toBeUndefined();
  });
});
