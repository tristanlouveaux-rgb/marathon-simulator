/**
 * LTHR plausibility gate — general-population protection for the personal
 * iTRIMP normalizer (ISSUE-262 root cause).
 *
 * The personal normalizer (computeAthleteNormalizer, Coggan hrTSS) is only as
 * good as the stored ltHR. A stale/corrupt watch auto-detect outside the
 * physiological LTHR band (80–95% of maxHR; Faude et al. 2009) must fall back
 * to the population normalizer instead of silently rescaling every iTRIMP→TSS
 * conversion feeding CTL/ATL.
 *
 * The motivating case (2026-06-04 audit): an ltHR of 144 at maxHR 192 (75%)
 * would give a normalizer of ~9,033 vs population 15,000 → all TSS inflated
 * +66%. (Tristan's live profile turned out to be in-band — 177/201 = 88% —
 * but nothing prevented the corrupt case from shipping; this gate does.)
 */
import { describe, it, expect } from 'vitest';
import { computeAthleteNormalizer } from './fitness-model';
import {
  plausibleLtHR,
  resolveLT,
  LTHR_PLAUSIBLE_MIN_FRAC,
  LTHR_PLAUSIBLE_MAX_FRAC,
} from './lt-derivation';

describe('computeAthleteNormalizer plausibility gate', () => {
  it('the corrupt-profile case (ltHR 144 / rest 42 / max 192 = 75% max) falls back to population', () => {
    expect(computeAthleteNormalizer(144, 42, 192)).toBe(15000);
  });

  it('a plausible trained profile (ltHR 172 / rest 42 / max 192 = 90% max) uses the personal formula', () => {
    const norm = computeAthleteNormalizer(172, 42, 192);
    expect(norm).not.toBe(15000);
    // 3600 × hrr × e^(1.92·hrr), hrr = 130/150 = 0.8667
    const hrr = (172 - 42) / (192 - 42);
    expect(norm).toBeCloseTo(3600 * hrr * Math.exp(1.92 * hrr), 6);
    expect(norm).toBeGreaterThan(16000);
    expect(norm).toBeLessThan(17000);
  });

  it('band edges: exactly 80% and 95% of maxHR are accepted', () => {
    expect(computeAthleteNormalizer(160, 50, 200)).not.toBe(15000); // 80%
    expect(computeAthleteNormalizer(190, 50, 200)).not.toBe(15000); // 95%
  });

  it('just outside the band falls back: 79% and 96% of maxHR', () => {
    expect(computeAthleteNormalizer(158, 50, 200)).toBe(15000); // 79%
    expect(computeAthleteNormalizer(192, 50, 200)).toBe(15000); // 96%
  });

  it('structural fallbacks unchanged: missing fields, inverted ordering', () => {
    expect(computeAthleteNormalizer(undefined, 50, 200)).toBe(15000);
    expect(computeAthleteNormalizer(170, undefined, 200)).toBe(15000);
    expect(computeAthleteNormalizer(170, 50, undefined)).toBe(15000);
    expect(computeAthleteNormalizer(170, 200, 50)).toBe(15000); // max < resting
    expect(computeAthleteNormalizer(40, 50, 200)).toBe(15000); // lt < resting
  });

  it('the gated population fallback assumes ~84% HRR (sanity: 15000 sits inside the plausible band)', () => {
    // 3600·x·e^(1.92x) = 15000 → x ≈ 0.84 HRR — i.e. the fallback itself is a
    // mid-band trained profile, so gating never makes an out-of-band profile
    // produce MORE extreme TSS than the band would allow.
    const x = 0.84;
    expect(3600 * x * Math.exp(1.92 * x)).toBeGreaterThan(14500);
    expect(3600 * x * Math.exp(1.92 * x)).toBeLessThan(15800);
  });
});

describe('plausibleLtHR helper', () => {
  it('passes plausible values through, nulls implausible ones', () => {
    expect(plausibleLtHR(172, 192)).toBe(172);
    expect(plausibleLtHR(144, 192)).toBeNull();
    expect(plausibleLtHR(200, 192)).toBeNull(); // above max — frac > 0.95... (1.04)
  });

  it('passes through when maxHR is unknown (cannot judge, do not destroy data)', () => {
    expect(plausibleLtHR(144, null)).toBe(144);
    expect(plausibleLtHR(144, undefined)).toBe(144);
  });

  it('band constants are the documented 80–95%', () => {
    expect(LTHR_PLAUSIBLE_MIN_FRAC).toBe(0.80);
    expect(LTHR_PLAUSIBLE_MAX_FRAC).toBe(0.95);
  });
});

describe('resolveLT gates the watch LTHR at the source', () => {
  it('an implausible Garmin ltHR is replaced by the derived/fallback estimate, pace kept', () => {
    const res = resolveLT({
      vdot: null,
      maxHR: 192,
      bestEfforts: [],
      sustainedEfforts: [],
      garmin: { ltPaceSecKm: 252, ltHR: 144, asOf: '2026-06-01T00:00:00Z' },
      override: null,
      now: '2026-06-04T00:00:00Z',
    } as any);
    expect(res.ltPaceSecKm).toBe(252); // pace is trusted
    expect(res.ltHR).not.toBe(144); // corrupt HR is not
    // falls to deriveLTHRFromMaxHR = 0.88 × 192 ≈ 169
    expect(res.ltHR).toBe(Math.round(192 * 0.88));
  });

  it('a plausible Garmin ltHR passes through untouched', () => {
    const res = resolveLT({
      vdot: null,
      maxHR: 192,
      bestEfforts: [],
      sustainedEfforts: [],
      garmin: { ltPaceSecKm: 252, ltHR: 170, asOf: '2026-06-01T00:00:00Z' },
      override: null,
      now: '2026-06-04T00:00:00Z',
    } as any);
    expect(res.ltHR).toBe(170);
  });
});
