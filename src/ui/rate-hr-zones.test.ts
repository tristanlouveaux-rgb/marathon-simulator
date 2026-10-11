/**
 * rate() scores a session's HR against zones built from the LT HEART RATE
 * (s.ltHR), never the LT pace (s.lt, s/km). Before 2026-10-11 the RPE + HR
 * flow, the threshold-run LT estimate and the Z2 efficiency points all passed
 * s.lt as lthr: a 300 s/km LT cleared calculateZones' 100 bpm gate and made a
 * Zone 2 of 240 to 267 bpm, so every HR read as far below target and nudged
 * rpeAdj up.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./renderer', () => ({ render: vi.fn(), log: vi.fn() }));
vi.mock('@/state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/state')>();
  return { ...actual, saveState: vi.fn() };
});

import { setState, getMutableState } from '@/state/store';
import { rate, ratingHrProfile } from './events';
import { calculateZones } from '@/calculations/heart-rate';
import type { SimulatorState } from '@/types';

function runner(over: Partial<SimulatorState> = {}): SimulatorState {
  return {
    w: 2, tw: 14, rd: 'marathon', rw: 4, epw: 4, v: 45, iv: 45, expectedFinal: 47, rpeAdj: 0,
    typ: 'Balanced', b: 1.06, timp: 0, continuousMode: false, eventType: 'running',
    onboarding: { experienceLevel: 'intermediate' },
    pac: { e: 330, t: 280, i: 255, m: 300, r: 240 }, lt: 300, maxHR: 190, restingHR: 50, pbs: {},
    blendedRaceTimeSec: 4 * 3600,
    planStartDate: '2026-09-28',
    wks: Array.from({ length: 14 }, (_, i) => ({ w: i + 1, ph: i < 6 ? 'base' : i < 11 ? 'build' : 'taper', rated: {}, skip: [] })),
    ...over,
  } as unknown as SimulatorState;
}

describe('ratingHrProfile: the LT heart rate, never the LT pace', () => {
  it('reads s.ltHR as lthr and ignores s.lt', () => {
    expect(ratingHrProfile(runner()).lthr).toBeUndefined();
    expect(ratingHrProfile(runner({ ltHR: 172 })).lthr).toBe(172);
    // No LTHR: Karvonen from max and resting HR (Z2 134 to 148), not a 300 bpm LTHR.
    const zones = calculateZones(ratingHrProfile(runner()))!;
    expect(zones.method).toBe('karvonen');
    expect(zones.z2).toEqual({ min: 134, max: 148 });
    // Synced max / resting HR win over onboarding values.
    const p = ratingHrProfile(runner({ maxHR: undefined, restingHR: undefined, onboarding: { maxHR: 185, restingHR: 55, age: 40 } as SimulatorState['onboarding'] }));
    expect(p).toEqual({ lthr: undefined, maxHR: 185, restingHR: 55, age: 40 });
  });
});

describe('rate(): an on-target HR leaves rpeAdj alone', () => {
  it('an easy run at RPE as expected and HR 140 (inside Karvonen Z2) moves nothing', () => {
    setState(runner());
    rate('W2-easy-0', 'Easy Run', 4, 4, 'easy', false, 140);
    // With s.lt as lthr, Z2 read 240 to 267 bpm: 140 scored as far below
    // target, a +0.15 efficiency shift, and rpeAdj rose.
    expect(getMutableState().rpeAdj).toBe(0);
  });

  it('a threshold run at HR 170 (inside Karvonen Z4, 162 to 176) moves nothing', () => {
    setState(runner());
    rate('W2-threshold-0', 'Threshold', 7, 7, 'threshold', false, 170);
    expect(getMutableState().rpeAdj).toBe(0);
  });

  it('an easy run with HR well below Z2 still reads as fitter (the HR signal works)', () => {
    setState(runner());
    rate('W2-easy-0', 'Easy Run', 4, 4, 'easy', false, 115);
    expect(getMutableState().rpeAdj).toBeGreaterThan(0);
  });
});
