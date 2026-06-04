/**
 * Tests for recomputeLT — the LT resolution applied to state.
 * Policy under test (Tristan, 2026-06-04): watch readings auto-apply
 * (no suggestion card), trusted until superseded; manual override still wins.
 */

import { describe, it, expect } from 'vitest';
import { recomputeLT } from './ltSync';
import { getDefaultState } from '@/state/store';
import type { SimulatorState } from '@/types';

function baseState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    ...getDefaultState(),
    maxHR: 201,
    restingHR: 43,
    ...overrides,
  } as SimulatorState;
}

describe('recomputeLT — watch readings auto-apply', () => {
  it('applies a Garmin reading directly, no suggestion parked', () => {
    const s = baseState();
    const action = recomputeLT(s, {
      garmin: { ltPaceSecKm: 252, ltHR: 168, asOf: '2026-01-15' },
      now: '2026-06-04T08:00:00Z',
    });
    expect(action).toBe('garmin');
    expect(s.lt).toBe(252);
    expect(s.ltHR).toBe(168);
    expect(s.ltSource).toBe('garmin');
    expect(s.ltSuggestion).toBeUndefined();
  });

  it('applies an old Garmin reading too — no 60-day expiry', () => {
    const s = baseState();
    const action = recomputeLT(s, {
      garmin: { ltPaceSecKm: 252, ltHR: 168, asOf: '2025-09-01' },
      now: '2026-06-04T08:00:00Z',
    });
    expect(action).toBe('garmin');
    expect(s.lt).toBe(252);
  });

  it('clears a stale suggestion left by the old conflict flow', () => {
    const s = baseState();
    (s as any).ltSuggestion = {
      garmin: { ltPaceSecKm: 252, ltHR: 168, asOf: '2026-01-15' },
      derived: { ltPaceSecKm: 239, ltHR: 177, provenance: 'Derived from VDOT 56.0' },
      detectedAt: '2026-05-01T08:00:00Z',
    };
    recomputeLT(s, {
      garmin: { ltPaceSecKm: 252, ltHR: 168, asOf: '2026-01-15' },
      now: '2026-06-04T08:00:00Z',
    });
    expect(s.ltSuggestion).toBeUndefined();
  });

  it('manual override still beats the watch', () => {
    const s = baseState();
    (s as any).ltOverride = { ltPaceSecKm: 260, ltHR: 165, setAt: '2026-06-01T08:00:00Z' };
    const action = recomputeLT(s, {
      garmin: { ltPaceSecKm: 240, ltHR: 168, asOf: '2026-06-02' },
      now: '2026-06-04T08:00:00Z',
    });
    expect(action).toBe('override');
    expect(s.lt).toBe(260);
  });

  it('persists the Garmin reading on state for future recomputes', () => {
    const s = baseState();
    recomputeLT(s, {
      garmin: { ltPaceSecKm: 252, ltHR: 168, asOf: '2026-01-15' },
      now: '2026-06-04T08:00:00Z',
    });
    expect(s.garminLT?.ltPaceSecKm).toBe(252);
    // A later recompute with no fresh Garmin input keeps using the stored reading.
    const action = recomputeLT(s, { now: '2026-06-05T08:00:00Z' });
    expect(action).toBe('garmin');
    expect(s.lt).toBe(252);
  });
});
