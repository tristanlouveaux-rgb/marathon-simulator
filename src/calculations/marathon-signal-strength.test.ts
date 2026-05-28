import { describe, it, expect } from 'vitest';
import { getMarathonSignalStrengths, activeSignalCount } from './marathon-signal-strength';
import type { SimulatorState } from '@/types/state';

function makeState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  // Minimal state. Only the fields the strength fns touch matter.
  return {
    pbs: {},
    rec: null,
    lt: 0,
    vo2: null,
    historicWeeklyKm: [],
    hrCalibratedVdot: undefined,
    onboarding: undefined,
    ...overrides,
  } as unknown as SimulatorState;
}

describe('getMarathonSignalStrengths', () => {
  it('returns six entries in canonical order even for a fully empty state', () => {
    const sigs = getMarathonSignalStrengths(makeState());
    expect(sigs).toHaveLength(6);
    expect(sigs.map(s => s.key)).toEqual(['pbs', 'recent', 'lt', 'hrCal', 'vo2', 'volume']);
    for (const s of sigs) expect(s.strength).toBe(0);
  });

  it('scores PBs by count of filled slots', () => {
    expect(getMarathonSignalStrengths(makeState({ pbs: { k5: 1200 } })).find(s => s.key === 'pbs')!.strength).toBe(0.25);
    expect(getMarathonSignalStrengths(makeState({ pbs: { k5: 1200, k10: 2500 } })).find(s => s.key === 'pbs')!.strength).toBe(0.5);
    expect(getMarathonSignalStrengths(makeState({ pbs: { k5: 1200, k10: 2500, h: 5400, m: 11700 } })).find(s => s.key === 'pbs')!.strength).toBe(1.0);
  });

  it('adds a recency bonus when any PB has a date within 365d', () => {
    const recent = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const s = makeState({
      pbs: { k5: 1200, k10: 2500 },
      onboarding: { pbDates: { k5: recent } } as never,
    });
    const pbsSig = getMarathonSignalStrengths(s).find(x => x.key === 'pbs')!;
    expect(pbsSig.strength).toBeCloseTo(0.6, 5);
  });

  it('does not apply recency bonus when PB date is older than 365d', () => {
    const old = new Date(Date.now() - 800 * 24 * 60 * 60 * 1000).toISOString();
    const s = makeState({
      pbs: { k5: 1200, k10: 2500 },
      onboarding: { pbDates: { k5: old } } as never,
    });
    expect(getMarathonSignalStrengths(s).find(x => x.key === 'pbs')!.strength).toBe(0.5);
  });

  it('caps PB strength at 1.0 with all slots + recency', () => {
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const s = makeState({
      pbs: { k5: 1200, k10: 2500, h: 5400, m: 11700 },
      onboarding: { pbDates: { m: recent } } as never,
    });
    expect(getMarathonSignalStrengths(s).find(x => x.key === 'pbs')!.strength).toBe(1.0);
  });

  it('grades recent races by weeksAgo', () => {
    const sigOf = (weeksAgo: number) =>
      getMarathonSignalStrengths(makeState({ rec: { d: 21, t: 5400, weeksAgo } as never }))
        .find(s => s.key === 'recent')!.strength;
    expect(sigOf(2)).toBe(1.0);
    expect(sigOf(8)).toBe(0.7);
    expect(sigOf(20)).toBe(0.4);
    expect(sigOf(40)).toBe(0.2);
  });

  it('treats LT presence as binary', () => {
    expect(getMarathonSignalStrengths(makeState({ lt: 0 })).find(s => s.key === 'lt')!.strength).toBe(0);
    expect(getMarathonSignalStrengths(makeState({ lt: 240 })).find(s => s.key === 'lt')!.strength).toBe(1);
  });

  it('maps HR-calibrated VDOT confidence to a graded score', () => {
    const check = (c: 'high' | 'medium' | 'low' | 'none') =>
      getMarathonSignalStrengths(makeState({ hrCalibratedVdot: { confidence: c } as never }))
        .find(s => s.key === 'hrCal')!.strength;
    expect(check('high')).toBe(1.0);
    expect(check('medium')).toBeCloseTo(0.66);
    expect(check('low')).toBeCloseTo(0.33);
    expect(check('none')).toBe(0);
  });

  it('treats VO2 presence as binary', () => {
    expect(getMarathonSignalStrengths(makeState({ vo2: 0 })).find(s => s.key === 'vo2')!.strength).toBe(0);
    expect(getMarathonSignalStrengths(makeState({ vo2: 50 })).find(s => s.key === 'vo2')!.strength).toBe(1);
  });

  it('grades training volume by weeks of non-zero data', () => {
    const check = (weeks: number[]) =>
      getMarathonSignalStrengths(makeState({ historicWeeklyKm: weeks }))
        .find(s => s.key === 'volume')!.strength;
    expect(check([])).toBe(0);
    expect(check([10, 0, 0])).toBeCloseTo(0.33);
    expect(check([10, 12, 8, 11, 0])).toBeCloseTo(0.66);
    expect(check([10, 12, 8, 11, 14, 9, 10, 13])).toBe(1.0);
  });
});

describe('activeSignalCount', () => {
  it('counts signals at or above 0.5 strength', () => {
    expect(activeSignalCount([
      { key: 'pbs', label: 'Race PBs', strength: 1.0 },
      { key: 'recent', label: 'Recent', strength: 0.7 },
      { key: 'lt', label: 'LT', strength: 0 },
      { key: 'hrCal', label: 'HR', strength: 0.33 },
      { key: 'vo2', label: 'VO2', strength: 0.5 },
      { key: 'volume', label: 'Vol', strength: 0.66 },
    ])).toBe(4);
  });

  it('returns 0 when no signal hits the threshold', () => {
    expect(activeSignalCount([
      { key: 'pbs', label: 'Race PBs', strength: 0.25 },
      { key: 'recent', label: 'Recent', strength: 0 },
    ])).toBe(0);
  });
});
