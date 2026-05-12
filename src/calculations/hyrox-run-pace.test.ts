/**
 * deriveHyroxRunPace tests — v2 (CP-anchored continuous model).
 *
 * Confirms the VDOT → CP → format → personalised HYROX-pace derivation,
 * the manual-yields-to-improvements rule, the personal offset blend with
 * decay, and the seed-fallback path.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveHyroxRunPace,
  derivePopulationRunPace,
  cpRatioForVdot,
  convertHyroxRunPaceFormat,
  HYROX_FATIGUE_TO_THRESHOLD_RATIO,
  CP_RATIO_ANCHORS,
  DOUBLES_TO_SINGLES_PACE_FACTOR,
} from './hyrox-run-pace';
import { SEED_RUN_PACE_SEC_KM } from '@/constants/hyrox-benchmarks';
import type { SimulatorState } from '@/types/state';
import type { AbilityBand, HyroxConfig } from '@/types/triathlon';

function buildState(opts: {
  band?: AbilityBand;
  vdot?: number | null | undefined;
  ltPace?: number | null;
  userPace?: number | undefined;
  format?: HyroxConfig['format'];
  personalOffsetSec?: number;
  personalOffsetUpdatedAt?: string;
} = {}): SimulatorState {
  return {
    v: opts.vdot ?? null,
    lt: opts.ltPace ?? null,
    hyroxConfig: {
      format: opts.format ?? 'open_singles',
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
      personalRunPaceOffsetSec: opts.personalOffsetSec,
      personalRunPaceOffsetUpdatedAtISO: opts.personalOffsetUpdatedAt,
    },
  } as unknown as SimulatorState;
}

describe('cpRatioForVdot — continuous interpolation', () => {
  it('returns anchor value at each anchor point', () => {
    for (const [vdot, ratio] of CP_RATIO_ANCHORS) {
      expect(cpRatioForVdot(vdot)).toBeCloseTo(ratio, 6);
    }
  });

  it('clamps below the lowest anchor and above the highest', () => {
    expect(cpRatioForVdot(20)).toBeCloseTo(CP_RATIO_ANCHORS[0][1], 6);
    const last = CP_RATIO_ANCHORS[CP_RATIO_ANCHORS.length - 1];
    expect(cpRatioForVdot(70)).toBeCloseTo(last[1], 6);
  });

  it('interpolates linearly between intermediate (45,1.05) and advanced (53,1.00)', () => {
    expect(cpRatioForVdot(49)).toBeCloseTo(1.025, 2); // halfway
  });

  it('descends below 1.0 for trained tiers (the v2 break from threshold-anchoring)', () => {
    expect(cpRatioForVdot(53)).toBeLessThanOrEqual(1.00);
    expect(cpRatioForVdot(60)).toBeLessThan(1.00);
  });

  it('is monotonic non-increasing (faster fitness → smaller or equal ratio)', () => {
    let prev = cpRatioForVdot(20);
    for (let v = 25; v <= 70; v += 1) {
      const cur = cpRatioForVdot(v);
      expect(cur).toBeLessThanOrEqual(prev + 1e-9);
      prev = cur;
    }
  });
});

describe('convertHyroxRunPaceFormat', () => {
  it('returns identity when from === to', () => {
    expect(convertHyroxRunPaceFormat(240, 'singles', 'singles', 'advanced')).toBe(240);
    expect(convertHyroxRunPaceFormat(240, 'doubles', 'doubles', 'advanced')).toBe(240);
  });

  it('doubles → singles makes pace slower (multiply by factor)', () => {
    const factor = DOUBLES_TO_SINGLES_PACE_FACTOR.advanced;
    expect(convertHyroxRunPaceFormat(240, 'doubles', 'singles', 'advanced'))
      .toBeCloseTo(240 * factor, 4);
  });

  it('singles → doubles makes pace faster (divide by factor)', () => {
    const factor = DOUBLES_TO_SINGLES_PACE_FACTOR.advanced;
    expect(convertHyroxRunPaceFormat(254, 'singles', 'doubles', 'advanced'))
      .toBeCloseTo(254 / factor, 4);
  });

  it('round-trip is identity', () => {
    const original = 240;
    const singles = convertHyroxRunPaceFormat(original, 'doubles', 'singles', 'intermediate');
    const back = convertHyroxRunPaceFormat(singles, 'singles', 'doubles', 'intermediate');
    expect(back).toBeCloseTo(original, 4);
  });

  it('format factor is larger for less-trained tiers', () => {
    expect(DOUBLES_TO_SINGLES_PACE_FACTOR.beginner)
      .toBeGreaterThan(DOUBLES_TO_SINGLES_PACE_FACTOR.competitive);
  });
});

describe('derivePopulationRunPace — base model without personal offset', () => {
  it('returns null when no hyroxConfig', () => {
    expect(derivePopulationRunPace({} as SimulatorState, 'singles')).toBeNull();
  });

  it('returns null when VDOT is out of range', () => {
    expect(derivePopulationRunPace(buildState({ vdot: 15 }), 'singles')).toBeNull();
  });

  it('singles pace from VDOT + LT', () => {
    // VDOT 50 with lt 240: cpRatio ≈ 1.019 (interp 45..53), pace ≈ 245.
    const r = derivePopulationRunPace(buildState({ vdot: 50, ltPace: 240, band: 'advanced' }), 'singles');
    expect(r).not.toBeNull();
    expect(r!.paceSecKm).toBeGreaterThan(235);
    expect(r!.paceSecKm).toBeLessThan(255);
  });

  it('doubles pace is faster than singles for the same athlete', () => {
    const state = buildState({ vdot: 50, ltPace: 240, band: 'advanced' });
    const singles = derivePopulationRunPace(state, 'singles');
    const doubles = derivePopulationRunPace(state, 'doubles');
    expect(doubles!.paceSecKm).toBeLessThan(singles!.paceSecKm);
  });

  it('exposes derivation components for the Stats CP card', () => {
    const r = derivePopulationRunPace(buildState({ vdot: 50, ltPace: 240, band: 'advanced' }), 'singles');
    expect(r!.components.thresholdSecKm).toBe(240);
    expect(r!.components.cpRatio).toBeGreaterThan(1.0);
    expect(r!.components.cpRatio).toBeLessThan(1.05);
    expect(r!.components.criticalPaceSecKm).toBeCloseTo(240 * r!.components.cpRatio, 4);
    expect(r!.components.formatFactor).toBe(1.0);
    expect(r!.components.personalOffsetSec).toBe(0);
  });
});

describe('deriveHyroxRunPace — full pipeline', () => {
  it('VDOT 46 + intermediate band → derived (v2: faster than the old seed)', () => {
    // v2: cpRatio at VDOT 46 ≈ 1.045 (interp 45..38). With threshold ≈ 264
    // → pace ≈ 276. v1 produced ~300 (threshold × 1.15) — v2 is faster.
    const result = deriveHyroxRunPace(buildState({ band: 'intermediate', vdot: 46 }));
    expect(result.source).toBe('derived');
    expect(result.paceSecKm).toBeGreaterThan(255);
    expect(result.paceSecKm).toBeLessThan(290);
    expect(result.derivedSecKm).toBe(result.paceSecKm);
  });

  it('user pace 350, derived ~275 → returns derived (improvement margin met)', () => {
    const result = deriveHyroxRunPace(buildState({
      band: 'intermediate', vdot: 46, userPace: 350,
    }));
    expect(result.source).toBe('derived');
    expect(result.paceSecKm).toBeLessThan(350 - 5);
  });

  it('user pace within 5 s/km of derived → user wins', () => {
    // Derived at VDOT 46 ≈ 276; pick user 278 (2 s/km slower) — should keep user.
    const result = deriveHyroxRunPace(buildState({
      band: 'intermediate', vdot: 46, userPace: 278,
    }));
    expect(result.source).toBe('user');
    expect(result.paceSecKm).toBe(278);
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
  });

  it('user pace set + VDOT missing → user wins', () => {
    const result = deriveHyroxRunPace(buildState({ vdot: null, userPace: 320 }));
    expect(result.source).toBe('user');
    expect(result.paceSecKm).toBe(320);
  });

  it('clamps to the physiological floor (HYROX_RUN_PACE_MIN_SEC_KM)', () => {
    // Elite VDOT 80 with ratio 0.96 → ~163; floor at 190.
    const result = deriveHyroxRunPace(buildState({ band: 'competitive', vdot: 80 }));
    expect(result.paceSecKm).toBeGreaterThanOrEqual(190);
  });

  it('CP-anchored ratio table is ordered (faster tier → smaller ratio)', () => {
    expect(HYROX_FATIGUE_TO_THRESHOLD_RATIO.competitive)
      .toBeLessThan(HYROX_FATIGUE_TO_THRESHOLD_RATIO.advanced);
    expect(HYROX_FATIGUE_TO_THRESHOLD_RATIO.advanced)
      .toBeLessThanOrEqual(HYROX_FATIGUE_TO_THRESHOLD_RATIO.intermediate);
    expect(HYROX_FATIGUE_TO_THRESHOLD_RATIO.intermediate)
      .toBeLessThan(HYROX_FATIGUE_TO_THRESHOLD_RATIO.beginner);
  });

  it('competitive ratio < 1.0 (the v2 break — can predict faster than threshold)', () => {
    // The whole reason for the rewrite: trained athletes pace HYROX at or
    // faster than threshold. v1 had a hard floor of 1.05.
    expect(HYROX_FATIGUE_TO_THRESHOLD_RATIO.competitive).toBeLessThan(1.0);
    expect(HYROX_FATIGUE_TO_THRESHOLD_RATIO.advanced).toBeLessThanOrEqual(1.0);
  });

  it('applies a fresh personal offset', () => {
    const today = new Date().toISOString();
    const base = deriveHyroxRunPace(buildState({ vdot: 50, ltPace: 240, band: 'advanced' })).paceSecKm;
    const personalised = deriveHyroxRunPace(buildState({
      vdot: 50, ltPace: 240, band: 'advanced',
      personalOffsetSec: -15,
      personalOffsetUpdatedAt: today,
    })).paceSecKm;
    expect(personalised).toBeLessThan(base);
    expect(base - personalised).toBeGreaterThanOrEqual(13);
  });

  it('decays the personal offset to zero after 12 months', () => {
    const twelveMonthsAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365);
    const result = deriveHyroxRunPace(buildState({
      vdot: 50, ltPace: 240, band: 'advanced',
      personalOffsetSec: -15,
      personalOffsetUpdatedAt: twelveMonthsAgo.toISOString(),
    }));
    expect(result.components!.personalOffsetSec).toBe(0);
  });

  it('partial-decay scales the offset proportionally', () => {
    const sixMonthsAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 182.5);
    const result = deriveHyroxRunPace(buildState({
      vdot: 50, ltPace: 240, band: 'advanced',
      personalOffsetSec: -20,
      personalOffsetUpdatedAt: sixMonthsAgo.toISOString(),
    }));
    // 6mo of 12mo decay → ~50% remaining → ~-10
    expect(result.components!.personalOffsetSec).toBeLessThan(0);
    expect(result.components!.personalOffsetSec).toBeGreaterThan(-15);
    expect(result.components!.personalOffsetSec).toBeLessThan(-5);
  });

  it('doubles target reaches a faster pace than the singles equivalent', () => {
    const singles = deriveHyroxRunPace(buildState({
      vdot: 50, ltPace: 240, band: 'advanced', format: 'open_singles',
    })).paceSecKm;
    const doubles = deriveHyroxRunPace(buildState({
      vdot: 50, ltPace: 240, band: 'advanced', format: 'open_doubles',
    })).paceSecKm;
    expect(doubles).toBeLessThan(singles);
  });
});
