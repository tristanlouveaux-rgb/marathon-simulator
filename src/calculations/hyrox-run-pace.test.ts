/**
 * deriveHyroxRunPace tests.
 *
 * Confirms the VDOT → fatigued-HYROX-pace derivation, the manual-yields-to-
 * improvements rule, and the seed-fallback path.
 */

import { describe, it, expect } from 'vitest';
import { deriveHyroxRunPace, HYROX_FATIGUE_TO_THRESHOLD_RATIO } from './hyrox-run-pace';
import { SEED_RUN_PACE_SEC_KM } from '@/constants/hyrox-benchmarks';
import type { SimulatorState } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';

function buildState(opts: {
  band?: AbilityBand;
  vdot?: number | null | undefined;
  ltPace?: number | null;
  userPace?: number | undefined;
} = {}): SimulatorState {
  return {
    v: opts.vdot ?? null,
    lt: opts.ltPace ?? null,
    hyroxConfig: {
      format: 'open_singles',
      athleteBand: opts.band ?? 'intermediate',
      hyroxPhase: 'base',
      stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      weeklyMTL: 0,
      mtlCap: 1000,
      mtlHistory: [],
      runsPerWeek: 3,
      stationSessionsPerWeek: 1,
      bricksPerWeek: 1,
      weeklyHoursAvailable: 8,
      hyroxRunPaceSecKm: opts.userPace,
    },
  } as unknown as SimulatorState;
}

describe('deriveHyroxRunPace', () => {
  it('VDOT 46 + intermediate band → derived ≈ seed', () => {
    const result = deriveHyroxRunPace(buildState({ band: 'intermediate', vdot: 46 }));
    expect(result.source).toBe('derived');
    // VDOT 46 threshold ≈ 264 s/km × 1.15 ≈ 304 s/km → close to seed 305.
    expect(result.paceSecKm).toBeGreaterThan(290);
    expect(result.paceSecKm).toBeLessThan(315);
    expect(result.derivedSecKm).toBe(result.paceSecKm);
  });

  it('user pace 350, derived 300 → returns derived (improvement margin met)', () => {
    const result = deriveHyroxRunPace(buildState({
      band: 'intermediate', vdot: 46, userPace: 350,
    }));
    expect(result.source).toBe('derived');
    expect(result.paceSecKm).toBeLessThan(350);
  });

  it('user pace 295 (within margin of derived ~300) → user wins', () => {
    const result = deriveHyroxRunPace(buildState({
      band: 'intermediate', vdot: 46, userPace: 295,
    }));
    expect(result.source).toBe('user');
    expect(result.paceSecKm).toBe(295);
    // derivedSecKm is still surfaced for "your runs suggest" UI.
    expect(result.derivedSecKm).not.toBeNull();
  });

  it('VDOT missing, no user pace → seed fallback', () => {
    const result = deriveHyroxRunPace(buildState({ band: 'intermediate', vdot: null }));
    expect(result.source).toBe('seed');
    expect(result.paceSecKm).toBe(SEED_RUN_PACE_SEC_KM.intermediate);
    expect(result.derivedSecKm).toBeNull();
  });

  it('VDOT out-of-range (15) → seed fallback', () => {
    const result = deriveHyroxRunPace(buildState({ band: 'intermediate', vdot: 15 }));
    expect(result.source).toBe('seed');
    expect(result.paceSecKm).toBe(SEED_RUN_PACE_SEC_KM.intermediate);
  });

  it('user pace set + VDOT missing → user wins', () => {
    const result = deriveHyroxRunPace(buildState({ vdot: null, userPace: 320 }));
    expect(result.source).toBe('user');
    expect(result.paceSecKm).toBe(320);
  });

  it('clamps to physiological floor (HYROX_RUN_PACE_MIN_SEC_KM)', () => {
    // VDOT 80 elite → threshold ~170s × 1.05 = 178 → below 190 floor.
    const result = deriveHyroxRunPace(buildState({ band: 'competitive', vdot: 80 }));
    expect(result.paceSecKm).toBeGreaterThanOrEqual(190);
  });

  it('all band ratios are in expected order (faster bands → smaller ratio)', () => {
    expect(HYROX_FATIGUE_TO_THRESHOLD_RATIO.competitive)
      .toBeLessThan(HYROX_FATIGUE_TO_THRESHOLD_RATIO.advanced);
    expect(HYROX_FATIGUE_TO_THRESHOLD_RATIO.advanced)
      .toBeLessThan(HYROX_FATIGUE_TO_THRESHOLD_RATIO.intermediate);
    expect(HYROX_FATIGUE_TO_THRESHOLD_RATIO.intermediate)
      .toBeLessThan(HYROX_FATIGUE_TO_THRESHOLD_RATIO.beginner);
  });
});
