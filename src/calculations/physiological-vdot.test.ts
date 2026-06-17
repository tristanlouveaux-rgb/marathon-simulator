import { describe, it, expect } from 'vitest';
import { getPhysiologicalVdot, pbDerivedVdot, resolveRunningVdot, hasRunningFitnessSignal, effectivePhysiologyPbs, isPbTombstoned, recordPbDeletion, clearPbTombstone, effectiveVo2max } from './physiological-vdot';
import { cv } from './vdot';
import type { SimulatorState } from '@/types';

const NOW = new Date('2026-04-29T12:00:00Z');

/** Minimal SimulatorState builder — only fields read by getPhysiologicalVdot. */
function mkState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    v: 50,
    pbs: {},
    physiologyHistory: [],
    ...overrides,
  } as SimulatorState;
}

describe('getPhysiologicalVdot — priority chain', () => {
  it('1. device fresh → returns device source with high confidence', () => {
    const s = mkState({
      vo2: 56,
      physiologyHistory: [{ date: '2026-04-15', vo2max: 56 }] as SimulatorState['physiologyHistory'],
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('device');
    expect(r.vdot).toBe(56);
    expect(r.confidence).toBe('high');
    expect(r.isDeviceFresh).toBe(true);
    expect(r.deviceAgeDays).toBeLessThan(20);
    expect(r.detail).toMatch(/watch/i);
  });

  it('2. device set but >90 days old → falls through to derived sources', () => {
    const s = mkState({
      vo2: 56,
      physiologyHistory: [{ date: '2026-01-01', vo2max: 56 }] as SimulatorState['physiologyHistory'],
      pbs: { k5: 1058, k10: 2360 },
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).not.toBe('device');
    expect(r.isDeviceFresh).toBe(false);
    // Should land on PB-median (no HR-calibrated, no observation-based LT).
    expect(r.source).toBe('pb-median');
  });

  it('3. device set with no physiologyHistory → treated as fresh (legacy state)', () => {
    const s = mkState({ vo2: 56, physiologyHistory: undefined });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('device');
    expect(r.vdot).toBe(56);
    expect(r.deviceAgeDays).toBeNull();
  });

  it('4. no device, HR-calibrated high confidence → hr-calibrated', () => {
    const s = mkState({
      vo2: undefined,
      hrCalibratedVdot: { vdot: 54, confidence: 'high', n: 8, r2: 0.85 } as SimulatorState['hrCalibratedVdot'],
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('hr-calibrated');
    expect(r.vdot).toBe(54);
    expect(r.confidence).toBe('high');
    expect(r.detail).toMatch(/8 steady runs/);
  });

  it('5. no device, HR-calibrated low confidence → skipped, falls through', () => {
    const s = mkState({
      vo2: undefined,
      hrCalibratedVdot: { vdot: 54, confidence: 'low', n: 2, r2: 0.3 } as SimulatorState['hrCalibratedVdot'],
      pbs: { k5: 1058, k10: 2360 },
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('pb-median');
  });

  it('6a. LT-derived fires when ltSource is empirical', () => {
    const s = mkState({
      vo2: undefined,
      lt: 240,
      ltSource: 'empirical',
      ltConfidence: 'medium',
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('lt-derived');
    expect(r.vdot).not.toBeNull();
    expect(r.confidence).toBe('medium');
  });

  it('6b. LT-derived fires when ltSource is critical-speed / garmin / override', () => {
    for (const src of ['critical-speed', 'garmin', 'override'] as const) {
      const s = mkState({ vo2: undefined, lt: 240, ltSource: src, ltConfidence: 'high' });
      const r = getPhysiologicalVdot(s, { now: NOW });
      expect(r.source).toBe('lt-derived');
    }
  });

  it('6c. LT-derived skipped when ltSource is daniels (would be circular)', () => {
    const s = mkState({
      vo2: undefined,
      lt: 240,
      ltSource: 'daniels',
      ltConfidence: 'low',
      pbs: { k5: 1058, k10: 2360 },
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('pb-median');
  });

  it('6d. LT-derived skipped when ltSource is blended (mixed Daniels)', () => {
    const s = mkState({
      vo2: undefined,
      lt: 240,
      ltSource: 'blended',
      ltConfidence: 'high',
      pbs: { k5: 1058, k10: 2360 },
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('pb-median');
  });

  it('7a. PB-median: 4 PBs, returns mean of two middle values', () => {
    const pbs = { k5: 1058, k10: 2360, h: 5501, m: 11382 };
    const vals = [cv(5000, 1058), cv(10000, 2360), cv(21097.5, 5501), cv(42195, 11382)].sort((a, b) => a - b);
    const expected = (vals[1] + vals[2]) / 2;
    expect(pbDerivedVdot(mkState({ pbs }))).toBeCloseTo(expected, 6);
  });

  it('7b. PB-median: 3 PBs, returns middle value', () => {
    const pbs = { k5: 1058, k10: 2360, h: 5501 };
    const vals = [cv(5000, 1058), cv(10000, 2360), cv(21097.5, 5501)].sort((a, b) => a - b);
    expect(pbDerivedVdot(mkState({ pbs }))).toBeCloseTo(vals[1], 6);
  });

  it('7c. PB-median: 2 PBs, returns mean of the two', () => {
    const pbs = { k5: 1058, k10: 2360 };
    const vals = [cv(5000, 1058), cv(10000, 2360)];
    expect(pbDerivedVdot(mkState({ pbs }))).toBeCloseTo((vals[0] + vals[1]) / 2, 6);
  });

  it('7d. PB-median: 1 PB, returns it directly', () => {
    expect(pbDerivedVdot(mkState({ pbs: { k5: 1058 } }))).toBeCloseTo(cv(5000, 1058), 6);
  });

  it('7e. PB-median: no PBs, returns null', () => {
    expect(pbDerivedVdot(mkState({ pbs: {} }))).toBeNull();
  });

  it('8. Tanda fallback when nothing else fires', () => {
    const s = mkState({
      vo2: undefined,
      hrCalibratedVdot: undefined,
      lt: undefined,
      pbs: {},
      v: 48.5,
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('tanda-fallback');
    expect(r.vdot).toBe(48.5);
    expect(r.confidence).toBe('low');
  });

  it('9. nothing usable → returns null with source none', () => {
    const s = mkState({ vo2: undefined, v: 0 });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.vdot).toBeNull();
    expect(r.source).toBe('none');
  });

  it('10. rpeAdj/physioAdj do NOT leak into the displayed VDOT', () => {
    // When the chain falls through to Tanda, the returned vdot must equal s.v
    // exactly. Adjustments are race-prediction concerns and must not affect
    // the physiological number.
    const s = mkState({
      vo2: undefined,
      v: 48.5,
      rpeAdj: 2,
      physioAdj: -3,
    } as Partial<SimulatorState>);
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.vdot).toBe(48.5);
  });
});

describe('getPhysiologicalVdot — race-validated anchor (recent race run leg)', () => {
  it('recent race anchor outranks a fresh watch VO2max', () => {
    // The triathlete bug: watch reads 56 (inflated by cycling/swimming), but a
    // recent 70.3 run leg implies ~43. The race must win.
    const s = mkState({
      vo2: 56,
      physiologyHistory: [{ date: '2026-04-15', vo2max: 56 }] as SimulatorState['physiologyHistory'],
      raceRunVdot: { vdot: 43, dateISO: '2026-03', distance: '70.3', source: 'onboarding-past-race' },
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('race-validated');
    expect(r.vdot).toBe(43);
    expect(r.confidence).toBe('high');
  });

  it('race anchor older than 365 days stands down → fresh watch wins', () => {
    const s = mkState({
      vo2: 56,
      physiologyHistory: [{ date: '2026-04-15', vo2max: 56 }] as SimulatorState['physiologyHistory'],
      raceRunVdot: { vdot: 43, dateISO: '2024-01-01', distance: '70.3', source: 'onboarding-past-race' },
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('device');
    expect(r.vdot).toBe(56);
  });

  it('a better standalone signal (mosaic-running, high conf) still beats the race', () => {
    const s = mkState({
      vo2: 56,
      vo2Source: 'mosaic',
      vo2Estimates: { running: { value: 49, confidence: 'high', n: 6 } } as SimulatorState['vo2Estimates'],
      raceRunVdot: { vdot: 43, dateISO: '2026-03', distance: '70.3', source: 'onboarding-past-race' },
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('mosaic-running');
    expect(r.vdot).toBe(49);
  });
});

describe('effectiveVo2max — race-validated cap on the blend VO2 predictor', () => {
  it('caps a watch VO2max that overstates a recent race run leg (no PBs)', () => {
    const s = mkState({ vo2: 56, raceRunVdot: { vdot: 43, dateISO: '2026-03', distance: '70.3', source: 'onboarding-past-race' } });
    expect(effectiveVo2max(s, NOW)).toBe(43);
  });

  it('does NOT cap when standalone running PBs corroborate the higher value', () => {
    // PBs imply VDOT well above 43, so the watch lift is corroborated → keep it.
    const s = mkState({ vo2: 56, pbs: { k5: 1058, k10: 2200 }, raceRunVdot: { vdot: 43, dateISO: '2026-03', distance: '70.3', source: 'onboarding-past-race' } });
    expect(effectiveVo2max(s, NOW)).toBe(56);
  });

  it('does NOT cap when the race is stale (>365 days)', () => {
    const s = mkState({ vo2: 56, raceRunVdot: { vdot: 43, dateISO: '2024-01-01', distance: '70.3', source: 'onboarding-past-race' } });
    expect(effectiveVo2max(s, NOW)).toBe(56);
  });

  it('manual override is never capped', () => {
    const s = mkState({ vo2: 56, vo2Override: { value: 60 } as SimulatorState['vo2Override'], raceRunVdot: { vdot: 43, dateISO: '2026-03', distance: '70.3', source: 'onboarding-past-race' } });
    expect(effectiveVo2max(s, NOW)).toBe(60);
  });
});

describe('getPhysiologicalVdot — staleness edge cases', () => {
  it('within freshness window (89 days) → treated as fresh', () => {
    const date = new Date(NOW.getTime() - 89 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const s = mkState({
      vo2: 56,
      physiologyHistory: [{ date, vo2max: 56 }] as SimulatorState['physiologyHistory'],
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('device');
    expect(r.isDeviceFresh).toBe(true);
    expect(r.deviceAgeDays).toBeGreaterThan(88);
    expect(r.deviceAgeDays).toBeLessThan(90);
  });

  it('beyond freshness window (95 days) → falls through to derived', () => {
    const date = new Date(NOW.getTime() - 95 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const s = mkState({
      vo2: 56,
      physiologyHistory: [{ date, vo2max: 56 }] as SimulatorState['physiologyHistory'],
      pbs: { k5: 1058, k10: 2360 },
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).not.toBe('device');
    expect(r.isDeviceFresh).toBe(false);
    expect(r.deviceAgeDays).toBeGreaterThan(94);
  });

  it('history present but no vo2max-bearing entries → treated as fresh (no signal to age against)', () => {
    const s = mkState({
      vo2: 56,
      physiologyHistory: [
        { date: '2026-04-25', restingHR: 50 },
        { date: '2026-04-26', restingHR: 51 },
      ] as SimulatorState['physiologyHistory'],
    });
    const r = getPhysiologicalVdot(s, { now: NOW });
    expect(r.source).toBe('device');
    expect(r.deviceAgeDays).toBeNull();
  });
});

describe('resolveRunningVdot / hasRunningFitnessSignal — canonical fitness gate', () => {
  it('resolves the physiological chain when a real tier is present', () => {
    const s = mkState({ pbs: { k5: 1058, k10: 2360 } });
    const physio = getPhysiologicalVdot(s).vdot;
    expect(resolveRunningVdot(s)).toBe(physio);
    expect(hasRunningFitnessSignal(s)).toBe(true);
  });

  it('falls back to the effective VDOT (s.v) when the chain is bare', () => {
    const s = mkState({ v: 45, pbs: {} });
    expect(resolveRunningVdot(s)).toBeCloseTo(45, 5);
    expect(hasRunningFitnessSignal(s)).toBe(true);
  });

  it('returns null / false when there is no usable running fitness at all', () => {
    const s = mkState({ v: 0, pbs: {} });
    expect(resolveRunningVdot(s)).toBeNull();
    expect(hasRunningFitnessSignal(s)).toBe(false);
  });
});

describe('effectivePhysiologyPbs — wizard PBs visible to the physiology chain', () => {
  it('mid-wizard typed PBs are seen before finalize commits s.pbs', () => {
    const s = mkState({
      pbs: {}, // previous broken pass finalized empty
      onboarding: { pbs: { k5: 1058, m: 11382 } } as any,
    });
    expect(effectivePhysiologyPbs(s)).toEqual({ k5: 1058, m: 11382 });
    // And the PB-median VDOT tier resolves from them.
    expect(pbDerivedVdot(s)).not.toBeNull();
  });

  it('fastest wins per key — a stale wizard snapshot cannot regress a fresher plan PB', () => {
    const s = mkState({
      pbs: { k5: 1020, h: 5600 },                   // post-plan Strava refresh improved the 5K
      onboarding: { pbs: { k5: 1058, h: 5490 } } as any, // wizard snapshot
    });
    expect(effectivePhysiologyPbs(s)).toEqual({ k5: 1020, h: 5490 });
  });

  it('no wizard state → identical to s.pbs', () => {
    const s = mkState({ pbs: { k10: 2360 } });
    expect(effectivePhysiologyPbs(s)).toEqual({ k10: 2360 });
  });
});

describe('PB deletion tombstones (ISSUE-297 RC3)', () => {
  it('isPbTombstoned suppresses equal/slower candidates, allows genuinely faster', () => {
    const tomb = { k5: 1200 }; // deleted a 20:00 5K
    expect(isPbTombstoned(tomb, 'k5', 1200)).toBe(true);  // re-detecting the same time
    expect(isPbTombstoned(tomb, 'k5', 1260)).toBe(true);  // a slower time
    expect(isPbTombstoned(tomb, 'k5', 1170)).toBe(false); // a genuine improvement (19:30)
    expect(isPbTombstoned(tomb, 'k10', 2400)).toBe(false);// different distance untouched
    expect(isPbTombstoned(undefined, 'k5', 1200)).toBe(false);
  });

  it('effectivePhysiologyPbs drops a tombstoned value resurrecting from the other store', () => {
    // The reported bug: enter a 2:00:00 marathon, it lands in onboarding.pbs,
    // delete it from s.pbs — without the tombstone the fastest-wins merge
    // resurrects it from onboarding.pbs.
    const s = mkState({
      pbs: {},
      onboarding: { pbs: { m: 7200 } } as SimulatorState['onboarding'],
      deletedPbs: { m: 7200 },
    });
    expect(effectivePhysiologyPbs(s).m).toBeUndefined();
    expect(pbDerivedVdot(s)).toBeNull(); // no PBs survive → no PB-median capacity
  });

  it('recordPbDeletion sets the tombstone and clears BOTH stores', () => {
    const s = mkState({
      pbs: { k5: 1200, k10: 2500 },
      onboarding: { pbs: { k5: 1200 } } as SimulatorState['onboarding'],
    });
    recordPbDeletion(s, 'k5');
    expect(s.deletedPbs?.k5).toBe(1200);
    expect(s.pbs.k5).toBeUndefined();
    expect(s.onboarding!.pbs!.k5).toBeUndefined();
    expect(s.pbs.k10).toBe(2500); // other distance untouched
    expect(effectivePhysiologyPbs(s).k5).toBeUndefined();
  });

  it('clearPbTombstone lets an explicit re-entry of a deleted time stand', () => {
    const s = mkState({ pbs: { k5: 1200 }, deletedPbs: { k5: 1200 } });
    // While tombstoned, the value is suppressed.
    expect(effectivePhysiologyPbs(s).k5).toBeUndefined();
    // Explicit re-entry clears the tombstone, so it is honoured again.
    clearPbTombstone(s, 'k5');
    expect(s.deletedPbs?.k5).toBeUndefined();
    expect(effectivePhysiologyPbs(s).k5).toBe(1200);
  });
});
