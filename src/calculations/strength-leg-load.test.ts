import { describe, it, expect } from 'vitest';
import {
  deriveStrengthLegLoad,
  strengthRecoveryMult,
  buildGymLegLoadNudge,
  dropSupersededStrengthEntries,
  legFeelRawLoad,
  legFeelRecoveryMult,
  K_STRENGTH,
  STRENGTH_LEG_LOAD_HEAVY_RAW,
  STRENGTH_LEG_LOAD_MODERATE_RAW,
} from './strength-leg-load';

// The canonical hard leg day used to anchor K_STRENGTH:
// 5×5 back squat (quads 5, glutes 2.5) + 3×8 RDL (hams 3, glutes 1.5, back 1.5)
// + 3×12 split squat (quads 3, glutes 3). Leg-group scores: quads 8, glutes 7,
// hamstrings 3, calves 0 → legScore 18.
const ANCHOR_GROUPS = [
  { group: 'quads', score: 8 },
  { group: 'glutes', score: 7 },
  { group: 'hamstrings', score: 3 },
  { group: 'back', score: 1.5 }, // excluded from legScore
];

describe('deriveStrengthLegLoad', () => {
  it('lands the canonical hard leg day at ~16 raw units (anchor)', () => {
    // intensity 1.0 (80% 1RM), effort 1.0 (RPE 7)
    const lifts = [{ weightKg: 80, estimatedOneRmKg: 100 }];
    const r = deriveStrengthLegLoad(ANCHOR_GROUPS, lifts, 7);
    expect(r.legScore).toBe(18);
    expect(r.intensityMult).toBeCloseTo(1.0, 5);
    expect(r.effortMult).toBeCloseTo(1.0, 5);
    expect(r.raw).toBeCloseTo(16.2, 1);
    expect(r.raw).toBe(K_STRENGTH * 18);
  });

  it('returns zero for an upper/core day (no leg groups)', () => {
    const upper = [
      { group: 'core', score: 6 },
      { group: 'back', score: 4 },
    ];
    const r = deriveStrengthLegLoad(upper, [{ weightKg: 60, estimatedOneRmKg: 80 }], 8);
    expect(r.raw).toBe(0);
    expect(r.legScore).toBe(0);
  });

  it('scales up with relative intensity (%1RM)', () => {
    const light = deriveStrengthLegLoad(ANCHOR_GROUPS, [{ weightKg: 60, estimatedOneRmKg: 100 }], 7);
    const heavy = deriveStrengthLegLoad(ANCHOR_GROUPS, [{ weightKg: 95, estimatedOneRmKg: 100 }], 7);
    expect(heavy.raw).toBeGreaterThan(light.raw);
    expect(light.intensityMult).toBeCloseTo(0.75, 5); // 0.60 / 0.80
    expect(heavy.intensityMult).toBeCloseTo(1.1875, 4); // 0.95 / 0.80
  });

  it('scales up with session RPE (proximity to failure)', () => {
    const easy = deriveStrengthLegLoad(ANCHOR_GROUPS, null, 5);
    const hard = deriveStrengthLegLoad(ANCHOR_GROUPS, null, 8);
    expect(hard.raw).toBeGreaterThan(easy.raw);
    expect(easy.effortMult).toBeCloseTo(5 / 7, 5);
    expect(hard.effortMult).toBeCloseTo(8 / 7, 5); // under the 1.25 cap
  });

  it('defaults intensity to 1.0 for bodyweight/plyometric work (no logged weights)', () => {
    const plyo = [
      { group: 'quads', score: 5.5 },
      { group: 'calves', score: 5 },
      { group: 'glutes', score: 3.5 },
    ];
    const r = deriveStrengthLegLoad(plyo, [], 7);
    expect(r.intensityMult).toBe(1.0);
    expect(r.raw).toBeCloseTo(K_STRENGTH * 14, 5);
  });

  it('clamps extreme intensity and effort', () => {
    const supramax = deriveStrengthLegLoad(ANCHOR_GROUPS, [{ weightKg: 150, estimatedOneRmKg: 100 }], 10);
    expect(supramax.intensityMult).toBe(1.25); // clamped from 1.5
    expect(supramax.effortMult).toBe(1.25); // clamped from 10/7≈1.43
  });

  it('ignores lifts without a usable %1RM sample', () => {
    const r = deriveStrengthLegLoad(ANCHOR_GROUPS, [{ weightKg: 0 }, { estimatedOneRmKg: 100 }], 7);
    expect(r.intensityMult).toBe(1.0); // no valid sample → default
  });
});

describe('buildGymLegLoadNudge', () => {
  it('fires for a leg day on already-loaded legs', () => {
    const msg = buildGymLegLoadNudge({
      plannedSessionRaw: 12,
      decayedLegLoadTotal: 25, // ≥ LEG_LOAD_MODERATE (20)
      sourceLabel: 'Running',
      timeframe: 'yesterday',
    });
    expect(msg).toContain('running yesterday');
    expect(msg).toContain('easing');
    expect(msg).not.toMatch(/[—–]/); // no em/en dash in prose
  });

  it('stays silent when legs are fresh', () => {
    expect(buildGymLegLoadNudge({ plannedSessionRaw: 12, decayedLegLoadTotal: 10 })).toBeNull();
  });

  it('stays silent for an upper/light day even on loaded legs', () => {
    expect(buildGymLegLoadNudge({ plannedSessionRaw: 3, decayedLegLoadTotal: 40 })).toBeNull();
  });

  it('falls back to generic source when none given', () => {
    const msg = buildGymLegLoadNudge({ plannedSessionRaw: 10, decayedLegLoadTotal: 30 });
    expect(msg).toContain('recent training');
  });
});

describe('dropSupersededStrengthEntries', () => {
  const T0 = 1_700_000_000_000;
  const base = [
    { garminId: 'guided-100', sport: 'strength', timestampMs: T0 },
    { garminId: 'strava-run', sport: 'running', timestampMs: T0 + 60_000 }, // 1 min later
    { garminId: 'guided-old', sport: 'strength', timestampMs: T0 - 3 * 24 * 3_600_000 }, // 3 days ago
  ];

  it('drops the same activity by garminId (re-completion reusing the id)', () => {
    const out = dropSupersededStrengthEntries(base, 'guided-100', T0);
    expect(out.find(e => e.garminId === 'guided-100')).toBeUndefined();
  });

  it('drops a near-time strength orphan even with a different id (fresh guided-{ts})', () => {
    // Re-completion 2 min later minted 'guided-200'; the old 'guided-100' must go.
    const out = dropSupersededStrengthEntries(base, 'guided-200', T0 + 2 * 60_000);
    expect(out.find(e => e.garminId === 'guided-100')).toBeUndefined();
  });

  it('keeps a run within the window (only strength is deduped by time)', () => {
    const out = dropSupersededStrengthEntries(base, 'guided-200', T0);
    expect(out.find(e => e.garminId === 'strava-run')).toBeDefined();
  });

  it('keeps an earlier strength session outside the ±10 min window (RBE still applies)', () => {
    const out = dropSupersededStrengthEntries(base, 'guided-200', T0);
    expect(out.find(e => e.garminId === 'guided-old')).toBeDefined();
  });
});

describe('legFeel manual tag (synced sessions with no exercise detail)', () => {
  it('converts duration to leg load at the documented per-minute rates', () => {
    expect(legFeelRawLoad('moderate', 60)).toBeCloseTo(9, 5);  // 60 × 0.15
    expect(legFeelRawLoad('heavy', 60)).toBeCloseTo(21, 5);    // 60 × 0.35
  });
  it('writes nothing for none/unset/zero duration', () => {
    expect(legFeelRawLoad('none', 60)).toBe(0);
    expect(legFeelRawLoad(undefined, 60)).toBe(0);
    expect(legFeelRawLoad('heavy', 0)).toBe(0);
  });
  it('heavy decays slower than moderate; none has no override', () => {
    expect(legFeelRecoveryMult('heavy')).toBe(1.20);
    expect(legFeelRecoveryMult('moderate')).toBe(1.05);
    expect(legFeelRecoveryMult('none')).toBeUndefined();
    expect(legFeelRecoveryMult(undefined)).toBeUndefined();
  });
});

describe('strengthRecoveryMult', () => {
  it('slows decay for a heavy leg day', () => {
    expect(strengthRecoveryMult(STRENGTH_LEG_LOAD_HEAVY_RAW)).toBe(1.20);
    expect(strengthRecoveryMult(20)).toBe(1.20);
  });
  it('slightly slows decay for a moderate leg day', () => {
    expect(strengthRecoveryMult(STRENGTH_LEG_LOAD_MODERATE_RAW)).toBe(1.05);
    expect(strengthRecoveryMult(10)).toBe(1.05);
  });
  it('keeps baseline decay for a light leg day', () => {
    expect(strengthRecoveryMult(5)).toBe(1.0);
    expect(strengthRecoveryMult(0)).toBe(1.0);
  });
});
