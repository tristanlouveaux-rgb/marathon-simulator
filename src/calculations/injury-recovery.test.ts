import { describe, it, expect } from 'vitest';
import { createDefaultInjuryState } from '@/types/injury';
import type { InjuryState } from '@/types/injury';
import { disciplineRecovery, recoveryDebitWeeks, injuryAdjustedBuildWeeks } from './injury-recovery';

/** Active injury with per-discipline capacity + resume weeks set. */
function injury(overrides: Partial<InjuryState>): InjuryState {
  return { ...createDefaultInjuryState(), active: true, injuryPhase: 'rehab', ...overrides };
}

describe('injury-recovery', () => {
  describe('disciplineRecovery', () => {
    it('returns no-restriction for undefined / inactive injury', () => {
      expect(disciplineRecovery(undefined, 'run', 15)).toEqual({ resumeWeeks: 0, capacity: 100 });
      const inactive = { ...createDefaultInjuryState(), active: false };
      expect(disciplineRecovery(inactive, 'run', 15)).toEqual({ resumeWeeks: 0, capacity: 100 });
    });

    it('reads resume weeks + capacity for a blocked discipline', () => {
      const inj = injury({ runCapacity: 0, resumeWeeksByDiscipline: { run: 3 } });
      expect(disciplineRecovery(inj, 'run', 15)).toEqual({ resumeWeeks: 3, capacity: 0 });
    });

    it('clamps resume weeks to the race horizon', () => {
      const inj = injury({ runCapacity: 0, resumeWeeksByDiscipline: { run: 20 } });
      expect(disciplineRecovery(inj, 'run', 15).resumeWeeks).toBe(15);
    });

    it('legacy state without resumeWeeksByDiscipline yields no captured window', () => {
      const inj = injury({ runCapacity: 0 });
      expect(disciplineRecovery(inj, 'run', 15)).toEqual({ resumeWeeks: 0, capacity: 100 });
    });

    it('falls back to the canRun enum when runCapacity is unset', () => {
      const inj = injury({ canRun: 'no', resumeWeeksByDiscipline: { run: 3 } });
      // getDisciplineCapacity maps canRun 'no' -> 0
      expect(disciplineRecovery(inj, 'run', 15).capacity).toBe(0);
    });
  });

  describe('recoveryDebitWeeks', () => {
    it('debits the full window when blocked (capacity 0)', () => {
      expect(recoveryDebitWeeks({ resumeWeeks: 3, capacity: 0 })).toBe(3);
    });

    it('debits a fraction when still partly trainable', () => {
      expect(recoveryDebitWeeks({ resumeWeeks: 4, capacity: 50 })).toBe(2);
    });

    it('debits nothing at full capacity', () => {
      expect(recoveryDebitWeeks({ resumeWeeks: 4, capacity: 100 })).toBe(0);
    });
  });

  describe('injuryAdjustedBuildWeeks', () => {
    it('returns full horizon when there is no injury (no freeze, no shrink)', () => {
      expect(injuryAdjustedBuildWeeks(undefined, 'run', 15)).toBe(15);
    });

    it('builds from the return date: blocked 3 weeks on a 15-week plan -> 12 effective weeks', () => {
      const inj = injury({ runCapacity: 0, resumeWeeksByDiscipline: { run: 3 } });
      expect(injuryAdjustedBuildWeeks(inj, 'run', 15)).toBe(12);
    });

    it('reduced capacity banks partial build: 50% for 4 weeks on 15 -> 13 effective weeks', () => {
      const inj = injury({ runCapacity: 50, resumeWeeksByDiscipline: { run: 4 } });
      expect(injuryAdjustedBuildWeeks(inj, 'run', 15)).toBe(13);
    });

    it('blocked for the whole horizon -> 0 effective build weeks (no improvement)', () => {
      const inj = injury({ runCapacity: 0, resumeWeeksByDiscipline: { run: 20 } });
      expect(injuryAdjustedBuildWeeks(inj, 'run', 15)).toBe(0);
    });

    it('never negative', () => {
      const inj = injury({ runCapacity: 0, resumeWeeksByDiscipline: { run: 50 } });
      expect(injuryAdjustedBuildWeeks(inj, 'run', 8)).toBeGreaterThanOrEqual(0);
    });
  });
});
