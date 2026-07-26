/**
 * Regression: injured running weeks must render on day-keyed surfaces.
 *
 * The injury engine's phase generators (acute/rehab/test_capacity/
 * return_to_run) replace the scheduled week with workouts that carried no
 * dayOfWeek. Every day-keyed surface then dropped them: the Plan tab showed
 * all-Rest rows, the strain target read 0, and the Home Today card showed
 * "Rest Day" while the rehab sessions rendered nowhere. (Found investigating
 * the 2026-07-26 "3 runs today while injured" report.)
 *
 * The generator now assigns spaced training days (Tue/Thu/Sat then
 * Mon/Wed/Fri/Sun) to any injury-emitted workout without a day.
 */
import { describe, it, expect } from 'vitest';
import { resolveWeekWorkouts } from './week-resolve';
import { getDefaultState, setState, resetState } from '@/state/store';
import { createDefaultInjuryState } from '@/types/injury';
import type { SimulatorState } from '@/types/state';

function runState(injuryPhase: string, daysAgo: number): SimulatorState {
  const start = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const inj = {
    ...createDefaultInjuryState(),
    active: true,
    type: 'shin_splints',
    location: 'shin',
    injuryPhase,
    currentPain: 2,
    canRun: 'no',
    startDate: start,
    acutePhaseStartDate: start,
    phaseTransitions: [],
    capacityTestsPassed: [],
    returnToRunLevel: 1,
    zeroPainWeeks: 0,
    graduatedReturnWeeksLeft: 2,
  };
  return {
    ...getDefaultState(),
    eventType: 'standard',
    w: 5, tw: 14, rw: 3, rd: 'half', typ: 'balanced', v: 45,
    planStartDate: '2026-06-29',
    injuryState: inj,
    wks: Array.from({ length: 14 }, (_, i) => ({ ph: i < 4 ? 'base' : 'build', rated: {}, skip: [], garminActuals: {} })),
  } as unknown as SimulatorState;
}

describe('injured running week renders on day-keyed surfaces', () => {
  for (const phase of ['acute', 'rehab', 'test_capacity', 'return_to_run', 'graduated_return']) {
    it(`every workout in phase=${phase} carries a valid dayOfWeek`, () => {
      resetState();
      const s = runState(phase, 10);
      setState(s);
      const workouts = resolveWeekWorkouts(s, 5);
      expect(workouts.length).toBeGreaterThan(0);
      for (const w of workouts as any[]) {
        expect(w.dayOfWeek, `${w.n} (${w.t}) has no dayOfWeek`).toBeGreaterThanOrEqual(0);
        expect(w.dayOfWeek, `${w.n} (${w.t}) dayOfWeek out of range`).toBeLessThanOrEqual(6);
      }
    });
  }

  it('phase workouts land on distinct spaced days (Tue/Thu/Sat first)', () => {
    resetState();
    const s = runState('return_to_run', 10);
    setState(s);
    const workouts = resolveWeekWorkouts(s, 5) as any[];
    const days = workouts.map(w => w.dayOfWeek);
    // No day should host more workouts than necessary while free days exist:
    // with ≤7 sessions, all days distinct.
    if (workouts.length <= 7) {
      expect(new Set(days).size).toBe(days.length);
    }
    // Spacing convention: first replacement lands on Tuesday.
    expect(days).toContain(1);
  });
});
