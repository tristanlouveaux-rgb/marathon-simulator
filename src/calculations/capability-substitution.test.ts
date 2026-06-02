import { describe, expect, it } from 'vitest';
import { createDefaultInjuryState } from '@/types/injury';
import type { InjuryState } from '@/types/injury';
import { pickAerobicSubstitute, buildCapabilityOffers, buildAerobicOffer } from './capability-substitution';
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

  it('treats a set preference as a hard allow-list: blocked preferred sport offers nothing, not a fall-through', () => {
    // Swimming is the only sport they have access to; the injury blocks it. We
    // do NOT substitute a bike they may not own.
    const inj = injury({ bikeCapacity: 50, swimCapacity: 0, preferredCrossTraining: 'swimming' });
    expect(pickAerobicSubstitute(inj)).toBeNull();
  });

  it('ignores an unknown preference string and falls through to the capacity ladder', () => {
    const inj = injury({ bikeCapacity: 50, swimCapacity: 0, preferredCrossTraining: 'pilates' });
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

describe('buildAerobicOffer (positive path: intensity scaling, duration, allow-list)', () => {
  it('returns null when no minutes were freed', () => {
    expect(buildAerobicOffer(injury({ runCapacity: 0, bikeCapacity: 100 }), 0, 2)).toBeNull();
  });

  it('returns null when nothing aerobic is safe even with freed time', () => {
    const inj = injury({ bikeCapacity: 0, upperLoadCapacity: 0, swimCapacity: 0 });
    expect(buildAerobicOffer(inj, 45, 2)).toBeNull();
  });

  it('keeps the FULL freed duration regardless of capacity (intensity absorbs the limit, not duration)', () => {
    const full = buildAerobicOffer(injury({ runCapacity: 0, bikeCapacity: 100 }), 45, 2);
    const limited = buildAerobicOffer(injury({ runCapacity: 0, bikeCapacity: 50 }), 45, 2);
    expect(full?.workout.estimatedDurationMin).toBe(45);
    expect(limited?.workout.estimatedDurationMin).toBe(45); // duration unchanged
  });

  it('scales RPE down in proportion to a limited capacity', () => {
    // rehab base RPE = 4. Full bike (100%) → 4. Half-capacity bike (50%) → 2.
    const full = buildAerobicOffer(injury({ injuryPhase: 'rehab', bikeCapacity: 100 }), 45, 2);
    const limited = buildAerobicOffer(injury({ injuryPhase: 'rehab', bikeCapacity: 50 }), 45, 2);
    expect(full?.workout.rpe).toBe(4);
    expect(limited?.workout.rpe).toBe(2);
  });

  it('never drops RPE below 1, even at very low capacity', () => {
    const offer = buildAerobicOffer(injury({ injuryPhase: 'rehab', bikeCapacity: 5 }), 30, 1);
    expect(offer?.workout.rpe).toBe(1);
  });

  it('uses the "kept light" copy when capacity is limited and the standard copy at full', () => {
    const full = buildAerobicOffer(injury({ bikeCapacity: 100 }), 40, 2);
    const limited = buildAerobicOffer(injury({ bikeCapacity: 50 }), 40, 2);
    expect(full?.workout.d).toContain('conversational effort');
    expect(limited?.workout.d).toContain('very easy');
  });

  it('tags bike and swim with a discipline; row erg keeps the generic cross badge', () => {
    const bike = buildAerobicOffer(injury({ bikeCapacity: 100 }), 40, 2);
    const swim = buildAerobicOffer(injury({ bikeCapacity: 0, upperLoadCapacity: 0, swimCapacity: 100 }), 40, 2);
    const erg = buildAerobicOffer(injury({ bikeCapacity: 0, upperLoadCapacity: 100, swimCapacity: 0 }), 40, 2);
    expect((bike?.workout as { discipline?: string }).discipline).toBe('bike');
    expect((swim?.workout as { discipline?: string }).discipline).toBe('swim');
    expect((erg?.workout as { discipline?: string }).discipline).toBeUndefined();
  });

  it('respects the preferred-sport allow-list: a blocked preference yields no aerobic offer', () => {
    const inj = injury({ bikeCapacity: 50, swimCapacity: 0, preferredCrossTraining: 'swimming' });
    expect(buildAerobicOffer(inj, 45, 2)).toBeNull();
  });

  it('omits dayOfWeek when no day is supplied', () => {
    const offer = buildAerobicOffer(injury({ bikeCapacity: 100 }), 40, null);
    expect((offer?.workout as { dayOfWeek?: number }).dayOfWeek).toBeUndefined();
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
