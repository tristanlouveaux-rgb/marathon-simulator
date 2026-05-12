/**
 * HYROX marker-bump tests.
 *
 * Pins two things:
 * 1. apply / detect / snapshot semantics for run-pace derivation.
 * 2. The detect-BEFORE-apply wiring order required by main.ts. The detector
 *    re-derives from current state and gates on `result.source === 'derived'`.
 *    If apply runs first, it writes derived → hyroxRunPaceSecKm, so the next
 *    derive call sees userVal === derived and returns source='user' — bump
 *    never fires. The final test in this file pins that regression.
 */

import { describe, it, expect } from 'vitest';
import {
  detectHyroxMarkerBumps,
  applyHyroxRunPaceDerivation,
  snapshotHyroxNotifiedMarkers,
} from './hyrox-marker-bumps';
import type { SimulatorState } from '@/types/state';

function buildState(opts: {
  vdot?: number | null;
  hyroxRunPaceSecKm?: number;
  hyroxRunPaceSource?: 'user' | 'derived' | 'seed';
  notifiedRunPace?: number;
} = {}): SimulatorState {
  return {
    v: opts.vdot ?? null,
    lt: null,
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 1300,
      mtlHistory: [],
      runsPerWeek: 3,
      stationSessionsPerWeek: 1,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      hyroxRunPaceSecKm: opts.hyroxRunPaceSecKm,
      hyroxRunPaceSource: opts.hyroxRunPaceSource,
      notifiedMarkers: opts.notifiedRunPace != null
        ? { hyroxRunPaceSecKm: opts.notifiedRunPace }
        : undefined,
    },
  } as unknown as SimulatorState;
}

describe('applyHyroxRunPaceDerivation', () => {
  it('first launch (no userVal, VDOT present) writes derived and flips source', () => {
    const s = buildState({ vdot: 46 });
    const wrote = applyHyroxRunPaceDerivation(s);
    expect(wrote).toBe(true);
    expect(s.hyroxConfig!.hyroxRunPaceSource).toBe('derived');
    // v2 (CP-anchored): VDOT 46 → cpRatio ≈ 1.045 × threshold ≈ 264 → ~276
    expect(s.hyroxConfig!.hyroxRunPaceSecKm!).toBeGreaterThan(260);
    expect(s.hyroxConfig!.hyroxRunPaceSecKm!).toBeLessThan(290);
  });

  it('idempotent: second call on already-derived state returns false', () => {
    const s = buildState({ vdot: 46 });
    applyHyroxRunPaceDerivation(s);
    const wrote2 = applyHyroxRunPaceDerivation(s);
    expect(wrote2).toBe(false);
  });

  it('no VDOT, no userVal: source flipped to seed, no value written', () => {
    const s = buildState({ vdot: null });
    const wrote = applyHyroxRunPaceDerivation(s);
    expect(wrote).toBe(true);
    expect(s.hyroxConfig!.hyroxRunPaceSource).toBe('seed');
    expect(s.hyroxConfig!.hyroxRunPaceSecKm).toBeUndefined();
  });

  it('user pace within 5s margin of derived: source stays user, no write', () => {
    // v2 derived at VDOT 46 ≈ 276; user at 278 is within 5 s/km margin.
    const s = buildState({ vdot: 46, hyroxRunPaceSecKm: 278, hyroxRunPaceSource: 'user' });
    const wrote = applyHyroxRunPaceDerivation(s);
    expect(wrote).toBe(false);
    expect(s.hyroxConfig!.hyroxRunPaceSecKm).toBe(278);
    expect(s.hyroxConfig!.hyroxRunPaceSource).toBe('user');
  });

  it('user pace meaningfully slower than derived: overwrites and flips to derived', () => {
    const s = buildState({ vdot: 46, hyroxRunPaceSecKm: 350, hyroxRunPaceSource: 'user' });
    const wrote = applyHyroxRunPaceDerivation(s);
    expect(wrote).toBe(true);
    expect(s.hyroxConfig!.hyroxRunPaceSource).toBe('derived');
    expect(s.hyroxConfig!.hyroxRunPaceSecKm!).toBeLessThan(345);
  });
});

describe('detectHyroxMarkerBumps', () => {
  it('first launch (no notified): no bump even when derived is available', () => {
    const s = buildState({ vdot: 46 });
    const bumps = detectHyroxMarkerBumps(s);
    expect(bumps).toHaveLength(0);
  });

  it('no change since last snapshot: no bump', () => {
    const s = buildState({ vdot: 46 });
    applyHyroxRunPaceDerivation(s);
    snapshotHyroxNotifiedMarkers(s);
    const bumps = detectHyroxMarkerBumps(s);
    expect(bumps).toHaveLength(0);
  });

  it('VDOT improvement crossing 5s threshold: bump fires when detect runs first', () => {
    // Run 1: VDOT 46, derive + snapshot.
    const s = buildState({ vdot: 46 });
    applyHyroxRunPaceDerivation(s);
    snapshotHyroxNotifiedMarkers(s);
    const oldPace = s.hyroxConfig!.hyroxRunPaceSecKm!;

    // Run 2: VDOT bumps to 52. detect runs BEFORE apply on the pre-apply state.
    s.v = 52;
    const bumps = detectHyroxMarkerBumps(s);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].marker).toBe('hyroxRunPace');
    expect(bumps[0].from).toBe(oldPace);
    expect(bumps[0].to).toBeLessThan(oldPace - 5);
    expect(bumps[0].toastText).toContain('beat your last test');
  });

  it('VDOT change under 5s threshold: no bump', () => {
    const s = buildState({ vdot: 46 });
    applyHyroxRunPaceDerivation(s);
    snapshotHyroxNotifiedMarkers(s);

    // Tiny VDOT bump — derived shifts well under 5 s/km.
    s.v = 46.3;
    const bumps = detectHyroxMarkerBumps(s);
    expect(bumps).toHaveLength(0);
  });

  it('manual pace 350 + VDOT-derived ≈ 305 + notified=350: bump fires', () => {
    const s = buildState({
      vdot: 46,
      hyroxRunPaceSecKm: 350,
      hyroxRunPaceSource: 'user',
      notifiedRunPace: 350,
    });
    const bumps = detectHyroxMarkerBumps(s);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].from).toBe(350);
    expect(bumps[0].to).toBeLessThan(345);
  });
});

describe('regression — wiring order matters (P1)', () => {
  it('apply BEFORE detect silently swallows the bump (the pre-fix order)', () => {
    // Run 1: derive + snapshot at VDOT 46.
    const s = buildState({ vdot: 46 });
    applyHyroxRunPaceDerivation(s);
    snapshotHyroxNotifiedMarkers(s);

    // Run 2: VDOT improves to 52. Buggy order: apply first.
    s.v = 52;
    applyHyroxRunPaceDerivation(s); // writes new derived → hyroxRunPaceSecKm
    const bumps = detectHyroxMarkerBumps(s);
    // After apply, userVal === derived, so deriveHyroxRunPace returns
    // source='user', the gate at hyrox-marker-bumps.ts:43 fails, no bump.
    expect(bumps).toHaveLength(0);
  });

  it('detect BEFORE apply (the fix in main.ts): bump fires on the same state', () => {
    // Run 1: derive + snapshot at VDOT 46.
    const s = buildState({ vdot: 46 });
    applyHyroxRunPaceDerivation(s);
    snapshotHyroxNotifiedMarkers(s);

    // Run 2: VDOT improves to 52. Correct order: detect first.
    s.v = 52;
    const bumps = detectHyroxMarkerBumps(s);
    applyHyroxRunPaceDerivation(s);
    expect(bumps).toHaveLength(1);
    expect(bumps[0].marker).toBe('hyroxRunPace');
  });
});

describe('snapshotHyroxNotifiedMarkers', () => {
  it('records current pace into notifiedMarkers', () => {
    const s = buildState({ vdot: 46 });
    applyHyroxRunPaceDerivation(s);
    snapshotHyroxNotifiedMarkers(s);
    expect(s.hyroxConfig!.notifiedMarkers?.hyroxRunPaceSecKm)
      .toBe(s.hyroxConfig!.hyroxRunPaceSecKm);
  });

  it('preserves other notifiedMarkers fields', () => {
    const s = buildState({ vdot: 46 });
    s.hyroxConfig!.notifiedMarkers = { mtlCap: 1300 };
    applyHyroxRunPaceDerivation(s);
    snapshotHyroxNotifiedMarkers(s);
    expect(s.hyroxConfig!.notifiedMarkers?.mtlCap).toBe(1300);
    expect(s.hyroxConfig!.notifiedMarkers?.hyroxRunPaceSecKm).toBeDefined();
  });
});
