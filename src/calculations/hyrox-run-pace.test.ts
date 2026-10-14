/**
 * deriveHyroxRunPace tests. V2 (CP-anchored continuous model).
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
  doublesRunPaceFactor,
  HYROX_FATIGUE_TO_THRESHOLD_RATIO,
  CP_RATIO_ANCHORS,
} from './hyrox-run-pace';
import { SEED_RUN_PACE_SEC_KM } from '@/constants/hyrox-benchmarks';
import { HYROX_S89_POOLED_PERCENTILES, type HyroxPercentileTable } from '@/data/hyrox-results-s79';
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

describe('doublesRunPaceFactor — percentile-matched run ratio from the results tables', () => {
  // Real results, seasons 8 and 9, Open Doubles against Open Singles pooled
  // (the default mapping when no cohort is passed).
  const singlesRun = HYROX_S89_POOLED_PERCENTILES.open_singles!.run_total;
  const doublesRun = HYROX_S89_POOLED_PERCENTILES.open_doubles!.run_total;
  const atPct = (t: HyroxPercentileTable, p: number) => t.find(([, q]) => q === p)![0];

  it('at the singles median run the factor is doubles P50 ÷ singles P50', () => {
    const singlesPace = atPct(singlesRun, 50) / 8;
    expect(doublesRunPaceFactor(singlesPace)).toBeCloseTo(atPct(doublesRun, 50) / atPct(singlesRun, 50), 6);
  });

  it('a median pair runs slower than a median singles athlete (slower partner sets the pace)', () => {
    expect(doublesRunPaceFactor(atPct(singlesRun, 50) / 8)).toBeGreaterThan(1);
  });

  it('holds the end ratio outside the table', () => {
    const p1 = atPct(doublesRun, 1) / atPct(singlesRun, 1);
    const p99 = atPct(doublesRun, 99) / atPct(singlesRun, 99);
    expect(doublesRunPaceFactor(150)).toBeCloseTo(p1, 6);
    expect(doublesRunPaceFactor(900)).toBeCloseTo(p99, 6);
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

  it('doubles pace is the singles critical pace × the results-table run ratio', () => {
    const state = buildState({ vdot: 50, ltPace: 240, band: 'advanced' });
    const singles = derivePopulationRunPace(state, 'singles')!;
    const doubles = derivePopulationRunPace(state, 'doubles')!;
    const cp = singles.components.criticalPaceSecKm;
    expect(doubles.components.formatFactor).toBeCloseTo(doublesRunPaceFactor(cp), 6);
    expect(doubles.paceSecKm).toBe(Math.max(190, Math.round(cp * doublesRunPaceFactor(cp))));
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
    // → pace ≈ 276. v1 produced ~300 (threshold × 1.15). V2 is faster.
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
    // Derived at VDOT 46 ≈ 276; pick user 278 (2 s/km slower). Should keep user.
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

  it('a mid-field doubles target runs slower than the singles equivalent', () => {
    // VDOT 38 puts the singles run near the open_singles median, where the
    // results tables show pairs running slower than solo athletes.
    const singles = deriveHyroxRunPace(buildState({
      vdot: 38, band: 'novice', format: 'open_singles',
    })).paceSecKm;
    const doubles = deriveHyroxRunPace(buildState({
      vdot: 38, band: 'novice', format: 'open_doubles',
    })).paceSecKm;
    expect(doubles).toBeGreaterThan(singles);
  });

  it('doubles seed fallback applies the same run ratio as the derived path', () => {
    const r = deriveHyroxRunPace(buildState({ vdot: null, band: 'novice', format: 'open_doubles' }));
    expect(r.source).toBe('seed');
    const seed = SEED_RUN_PACE_SEC_KM.novice;
    expect(r.paceSecKm).toBe(Math.round(seed * doublesRunPaceFactor(seed)));
  });
});
