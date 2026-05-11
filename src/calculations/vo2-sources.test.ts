import { describe, it, expect } from 'vitest';
import { getVo2Conflict, VO2_CONFLICT_DELTA_THRESHOLD, VO2_DEVICE_STALENESS_DAYS } from './vo2-sources';
import type { SimulatorState } from '@/types/state';

// Typed partial for clarity
type StatePartial = {
  vo2?: number | null;
  vo2UpdatedAt?: string;
  hrCalibratedVdot?: { vdot: number; confidence: 'high' | 'medium' | 'low'; n: number };
  pbs?: { k5?: number; k10?: number; h?: number; m?: number };
};

function makeS(p: StatePartial = {}): SimulatorState {
  return p as unknown as SimulatorState;
}

// ─── No conflict cases ─────────────────────────────────────────────────────

describe('getVo2Conflict — no conflict', () => {
  it('returns no conflict when fewer than 2 sources available', () => {
    const result = getVo2Conflict(makeS({ vo2: 52 }));
    expect(result.hasConflict).toBe(false);
    // sources still populated (for inspection), just < 2 → no conflict possible
    expect(result.sources.length).toBeGreaterThanOrEqual(1);
  });

  it('returns no conflict when sources agree within threshold', () => {
    // Device = 52, HR-calibrated = 53 → delta 1 < threshold 3
    const result = getVo2Conflict(makeS({
      vo2: 52,
      vo2UpdatedAt: new Date().toISOString().slice(0, 10),
      hrCalibratedVdot: { vdot: 53, confidence: 'medium', n: 4 },
    }));
    expect(result.maxDelta).toBeLessThan(VO2_CONFLICT_DELTA_THRESHOLD);
    expect(result.hasConflict).toBe(false);
  });

  it('returns no conflict for low-confidence HR-calibrated source', () => {
    const result = getVo2Conflict(makeS({
      vo2: 52,
      vo2UpdatedAt: new Date().toISOString().slice(0, 10),
      hrCalibratedVdot: { vdot: 48, confidence: 'low', n: 1 },
    }));
    // Low confidence hr-calibrated excluded → only device → < 2 sources
    expect(result.hasConflict).toBe(false);
  });
});

// ─── Conflict: value disagreement ─────────────────────────────────────────

describe('getVo2Conflict — value conflict', () => {
  it('flags conflict when device vs pb-derived differ by ≥ 3 points', () => {
    // 5K PB of 1200s (20:00) → VDOT ~50; device = 56 → delta = 6
    const result = getVo2Conflict(makeS({
      vo2: 56,
      vo2UpdatedAt: new Date().toISOString().slice(0, 10),
      pbs: { k5: 1200 },
    }));
    expect(result.hasConflict).toBe(true);
    expect(result.maxDelta).toBeGreaterThanOrEqual(VO2_CONFLICT_DELTA_THRESHOLD);
  });

  it('flags conflict when device vs hr-calibrated differ by ≥ 3 points', () => {
    const result = getVo2Conflict(makeS({
      vo2: 56,
      vo2UpdatedAt: new Date().toISOString().slice(0, 10),
      hrCalibratedVdot: { vdot: 48, confidence: 'medium', n: 4 },
    }));
    expect(result.hasConflict).toBe(true);
    expect(result.maxDelta).toBeCloseTo(8);
  });

  it('does NOT flag when delta < 3 points', () => {
    const result = getVo2Conflict(makeS({
      vo2: 52,
      vo2UpdatedAt: new Date().toISOString().slice(0, 10),
      hrCalibratedVdot: { vdot: 53, confidence: 'medium', n: 4 },
    }));
    expect(result.maxDelta).toBeLessThan(VO2_CONFLICT_DELTA_THRESHOLD);
    expect(result.hasConflict).toBe(false);
  });
});

// ─── Conflict: stale device ────────────────────────────────────────────────

describe('getVo2Conflict — stale device', () => {
  it('flags conflict when device reading is > 90 days old', () => {
    const staleDate = new Date(Date.now() - (VO2_DEVICE_STALENESS_DAYS + 10) * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    const result = getVo2Conflict(makeS({
      vo2: 52,
      vo2UpdatedAt: staleDate,
      hrCalibratedVdot: { vdot: 53, confidence: 'medium', n: 4 },
    }));
    expect(result.hasStaleDevice).toBe(true);
    expect(result.hasConflict).toBe(true);
  });

  it('does NOT flag stale when within 90 days', () => {
    const freshDate = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    const result = getVo2Conflict(makeS({
      vo2: 52,
      vo2UpdatedAt: freshDate,
      hrCalibratedVdot: { vdot: 53, confidence: 'medium', n: 4 },
    }));
    expect(result.hasStaleDevice).toBe(false);
  });

  it('does NOT flag stale when no vo2UpdatedAt (legacy state — treat as fresh)', () => {
    const result = getVo2Conflict(makeS({
      vo2: 52,
      hrCalibratedVdot: { vdot: 53, confidence: 'medium', n: 4 },
    }));
    expect(result.hasStaleDevice).toBe(false);
  });
});

// ─── Source collection ─────────────────────────────────────────────────────

describe('getVo2Conflict — source collection', () => {
  it('includes device when s.vo2 > 0', () => {
    const result = getVo2Conflict(makeS({ vo2: 52 }));
    const dev = result.sources.find(s => s.source === 'device');
    expect(dev).toBeDefined();
    expect(dev!.value).toBe(52);
  });

  it('excludes device when s.vo2 is null or 0', () => {
    const result = getVo2Conflict(makeS({ vo2: null }));
    expect(result.sources.find(s => s.source === 'device')).toBeUndefined();
  });

  it('includes pb-derived when PBs present', () => {
    const result = getVo2Conflict(makeS({
      vo2: 52,
      pbs: { k5: 1200 },  // 20:00 5K
    }));
    expect(result.sources.find(s => s.source === 'pb-derived')).toBeDefined();
  });
});
