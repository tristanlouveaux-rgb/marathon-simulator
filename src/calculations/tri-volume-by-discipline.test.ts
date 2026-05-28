import { describe, it, expect } from 'vitest';
import { plannedSessionsPerWeekByDiscipline } from './tri-volume-by-discipline';
import type { SimulatorState } from '@/types/state';

/**
 * The `startOffset` argument lets the injury-aware predictor sample the
 * *recovered* dose — the plan weeks after every restricted discipline has
 * returned — instead of the injured transition weeks that would understate the
 * steady-state plan.
 */
function stateWith(weeks: Array<{ swim: number; bike: number; run: number }>): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
    wks: weeks.map(c => ({
      triWorkouts: [
        ...Array.from({ length: c.swim }, (_, i) => ({ id: `s${i}`, discipline: 'swim' })),
        ...Array.from({ length: c.bike }, (_, i) => ({ id: `b${i}`, discipline: 'bike' })),
        ...Array.from({ length: c.run }, (_, i) => ({ id: `r${i}`, discipline: 'run' })),
      ],
    })),
  } as any;
}

describe('plannedSessionsPerWeekByDiscipline — startOffset', () => {
  // Weeks 0-1: injured (swim/run zeroed, bike only). Weeks 2-5: recovered.
  const injuredThenRecovered = stateWith([
    { swim: 0, bike: 3, run: 0 },
    { swim: 0, bike: 3, run: 0 },
    { swim: 3, bike: 3, run: 3 },
    { swim: 3, bike: 3, run: 3 },
    { swim: 3, bike: 3, run: 3 },
    { swim: 3, bike: 3, run: 3 },
  ]);

  it('offset 0 sees the injured transition weeks (swim/run suppressed)', () => {
    const v = plannedSessionsPerWeekByDiscipline(injuredThenRecovered, 4, 0);
    // 4-week window weeks 0-3: swim = (0+0+3+3)/4 = 1.5.
    expect(v.swim).toBeCloseTo(1.5, 5);
    expect(v.bike).toBeCloseTo(3, 5);
  });

  it('offset past the recovery window sees the full recovered dose', () => {
    const v = plannedSessionsPerWeekByDiscipline(injuredThenRecovered, 4, 2);
    // Weeks 2-5 all recovered → swim/run = 3.
    expect(v.swim).toBeCloseTo(3, 5);
    expect(v.run).toBeCloseTo(3, 5);
  });

  it('negative offset is clamped to 0', () => {
    const a = plannedSessionsPerWeekByDiscipline(injuredThenRecovered, 4, -5);
    const b = plannedSessionsPerWeekByDiscipline(injuredThenRecovered, 4, 0);
    expect(a.swim).toBe(b.swim);
  });
});
