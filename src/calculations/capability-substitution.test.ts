import { describe, expect, it } from 'vitest';
import { createDefaultInjuryState } from '@/types/injury';
import type { InjuryState } from '@/types/injury';
import { pickAerobicSubstitute } from './capability-substitution';

function injury(overrides: Partial<InjuryState>): InjuryState {
  return {
    ...createDefaultInjuryState(),
    active: true,
    injuryPhase: 'rehab',
    location: 'other', // neutral defaults (all capacities 100) unless overridden
    ...overrides,
  };
}

describe('pickAerobicSubstitute', () => {
  it('prefers bike when legs can still pedal (the "you can still pedal" case)', () => {
    const inj = injury({ runCapacity: 0, bikeCapacity: 50, lowerLoadCapacity: 0, upperLoadCapacity: 100 });
    expect(pickAerobicSubstitute(inj)?.sport).toBe('bike');
  });

  it('falls back to row erg when bike is out but arms are free', () => {
    const inj = injury({ runCapacity: 0, bikeCapacity: 0, upperLoadCapacity: 100, swimCapacity: 100 });
    expect(pickAerobicSubstitute(inj)?.sport).toBe('row_erg');
  });

  it('falls back to swim when bike and arms are out', () => {
    const inj = injury({ runCapacity: 0, bikeCapacity: 0, upperLoadCapacity: 0, swimCapacity: 100 });
    expect(pickAerobicSubstitute(inj)?.sport).toBe('swim');
  });

  it('returns null when nothing aerobic is safe', () => {
    const inj = injury({ runCapacity: 0, bikeCapacity: 0, upperLoadCapacity: 0, swimCapacity: 0 });
    expect(pickAerobicSubstitute(inj)).toBeNull();
  });

  it('honours a usable saved preference over the default order', () => {
    const inj = injury({ bikeCapacity: 50, swimCapacity: 100, preferredCrossTraining: 'swimming' });
    expect(pickAerobicSubstitute(inj)?.sport).toBe('swim');
  });

  it('ignores a preference whose discipline is blocked, using the next available', () => {
    const inj = injury({ bikeCapacity: 50, swimCapacity: 0, preferredCrossTraining: 'swimming' });
    expect(pickAerobicSubstitute(inj)?.sport).toBe('bike');
  });
});
