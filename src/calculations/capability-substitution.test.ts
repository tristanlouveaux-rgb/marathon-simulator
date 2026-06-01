import { describe, expect, it } from 'vitest';
import { createDefaultInjuryState } from '@/types/injury';
import type { InjuryState } from '@/types/injury';
import { pickAerobicSubstitute, buildCapabilityOffers } from './capability-substitution';
import { generateRehabPhaseWorkouts } from '@/injury/engine';
import type { SimulatorState } from '@/types/state';

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

  it('returns null for no injury', () => {
    expect(pickAerobicSubstitute(undefined)).toBeNull();
  });
});

describe('generateRehabPhaseWorkouts uses the capacity-aware pick (running mirror)', () => {
  const crossLabel = (inj: InjuryState | undefined): string => {
    const cross = generateRehabPhaseWorkouts(inj).find(w => w.t === 'cross');
    return (cross?.n ?? '').replace('Rehab Cross-Training: ', '');
  };

  it('a knee (bike still usable) gets a Bike rehab session, not the generic label', () => {
    expect(crossLabel(injury({ runCapacity: 0, bikeCapacity: 50, swimCapacity: 100 }))).toBe('Bike');
  });

  it('an arm injury that blocks bike gets a Swim rehab session', () => {
    expect(crossLabel(injury({ bikeCapacity: 0, upperLoadCapacity: 0, swimCapacity: 100 }))).toBe('Swim');
  });

  it('falls back to the generic low-impact label when nothing aerobic is safe', () => {
    expect(crossLabel(injury({ bikeCapacity: 0, upperLoadCapacity: 0, swimCapacity: 0 }))).toBe('pool, cycling');
  });

  it('honours the saved cross-training preference', () => {
    expect(crossLabel(injury({ bikeCapacity: 50, swimCapacity: 100, preferredCrossTraining: 'swimming' }))).toBe('Swim');
  });
});

describe('buildCapabilityOffers routing guards', () => {
  const state = (over: Partial<SimulatorState>): SimulatorState =>
    ({ w: 1, wks: [], ...over } as unknown as SimulatorState);

  it('returns [] when there is no active injury', async () => {
    expect(await buildCapabilityOffers(state({ eventType: 'hyrox' } as any))).toEqual([]);
  });

  it('returns [] for a resolved injury', async () => {
    const inj = injury({ injuryPhase: 'resolved', runCapacity: 0 });
    expect(await buildCapabilityOffers(state({ eventType: 'triathlon', injuryState: inj } as any))).toEqual([]);
  });

  it('returns [] for an unsupported mode (running routes via its phase path, not here)', async () => {
    const inj = injury({ runCapacity: 0 });
    expect(await buildCapabilityOffers(state({ eventType: 'running', injuryState: inj } as any))).toEqual([]);
  });
});
