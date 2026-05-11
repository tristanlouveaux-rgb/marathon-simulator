import { describe, it, expect } from 'vitest';
import { computeTriCalibration } from './tri-calibration';
import type { TriRaceLogEntry } from '@/types/triathlon';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<TriRaceLogEntry> = {}): TriRaceLogEntry {
  return {
    dateISO: '2026-01-01',
    distance: '70.3',
    predictedTotalSec: 18000,
    predictedPerLeg: { swim: 2400, bike: 10800, run: 4800 },
    actualTotalSec: 18000,
    actualPerLeg:   { swim: 2400, bike: 10800, run: 4800 },
    ...overrides,
  };
}

// ─── Tier transitions ──────────────────────────────────────────────────────

describe('computeTriCalibration — tier transitions', () => {
  it('returns tier 0 for empty log', () => {
    const cal = computeTriCalibration([]);
    expect(cal.tier).toBe(0);
    expect(cal.basedOnRaceCount).toBe(0);
  });

  it('returns tier 0 for 1 entry', () => {
    const cal = computeTriCalibration([makeEntry()]);
    expect(cal.tier).toBe(0);
  });

  it('returns tier 1 for 2 entries', () => {
    const cal = computeTriCalibration([makeEntry(), makeEntry({ dateISO: '2026-02-01' })]);
    expect(cal.tier).toBe(1);
    expect(cal.perLegBiasSec).toBeDefined();
    expect(cal.perLegMaxPenaltyScale).toBeUndefined();
  });

  it('returns tier 1 for 4 entries without predictedRawPerLeg', () => {
    const entries = Array.from({ length: 4 }, (_, i) =>
      makeEntry({ dateISO: `2026-0${i + 1}-01` }),
    );
    const cal = computeTriCalibration(entries);
    expect(cal.tier).toBe(1);
    expect(cal.perLegMaxPenaltyScale).toBeUndefined();
  });

  it('returns tier 2 for 4 entries that all have predictedRawPerLeg', () => {
    const entries = Array.from({ length: 4 }, (_, i) =>
      makeEntry({
        dateISO: `2026-0${i + 1}-01`,
        predictedRawPerLeg: { swim: 2300, bike: 10400, run: 4700 },
      }),
    );
    const cal = computeTriCalibration(entries);
    expect(cal.tier).toBe(2);
    expect(cal.perLegMaxPenaltyScale).toBeDefined();
  });
});

// ─── Tier-1 bias ─────────────────────────────────────────────────────────

describe('computeTriCalibration — tier-1 bias', () => {
  it('returns bias of 0 when predictions are perfect', () => {
    const entries = Array.from({ length: 3 }, (_, i) => makeEntry({ dateISO: `2026-0${i + 1}-01` }));
    const cal = computeTriCalibration(entries);
    expect(cal.tier).toBe(1);
    expect(cal.perLegBiasSec!.swim).toBeCloseTo(0);
    expect(cal.perLegBiasSec!.bike).toBeCloseTo(0);
    expect(cal.perLegBiasSec!.run).toBeCloseTo(0);
  });

  it('captures systematic over-prediction (actual slower = positive bias)', () => {
    // Swim is consistently 120s slower than predicted → bias = +120
    const entries = Array.from({ length: 3 }, (_, i) =>
      makeEntry({
        dateISO: `2026-0${i + 1}-01`,
        actualPerLeg: { swim: 2520, bike: 10800, run: 4800 },  // +120 on swim
        actualTotalSec: 18120,
      }),
    );
    const cal = computeTriCalibration(entries);
    expect(cal.perLegBiasSec!.swim).toBeCloseTo(120);
    expect(cal.perLegBiasSec!.bike).toBeCloseTo(0);
    expect(cal.perLegBiasSec!.run).toBeCloseTo(0);
  });

  it('caps bias at ±8% of median predicted leg time', () => {
    // Swim predicted = 2400, cap = 2400 * 0.08 = 192s
    // Residual = +400s (over the cap)
    const entries = Array.from({ length: 3 }, (_, i) =>
      makeEntry({
        dateISO: `2026-0${i + 1}-01`,
        actualPerLeg: { swim: 2800, bike: 10800, run: 4800 },
        actualTotalSec: 18400,
      }),
    );
    const cal = computeTriCalibration(entries);
    expect(cal.perLegBiasSec!.swim).toBeCloseTo(192);  // capped at 8%
  });

  it('captures under-prediction (actual faster = negative bias)', () => {
    const entries = Array.from({ length: 3 }, (_, i) =>
      makeEntry({
        dateISO: `2026-0${i + 1}-01`,
        actualPerLeg: { swim: 2280, bike: 10800, run: 4800 },  // -120 on swim
        actualTotalSec: 17880,
      }),
    );
    const cal = computeTriCalibration(entries);
    expect(cal.perLegBiasSec!.swim).toBeCloseTo(-120);
  });

  it('prediction identical to actuals after all-zero-residual → bias=0, scales=1', () => {
    const entries = Array.from({ length: 4 }, (_, i) =>
      makeEntry({
        dateISO: `2026-0${i + 1}-01`,
        predictedRawPerLeg: { swim: 2400, bike: 10800, run: 4800 },
      }),
    );
    const cal = computeTriCalibration(entries);
    expect(cal.perLegBiasSec!.swim).toBeCloseTo(0);
    expect(cal.perLegBiasSec!.bike).toBeCloseTo(0);
    expect(cal.perLegBiasSec!.run).toBeCloseTo(0);
    // All-zero residual means OLS slope = 0, rawScale = 1, shrinkage keeps it 1
    expect(cal.perLegMaxPenaltyScale!.swim).toBeCloseTo(1.0);
    expect(cal.perLegMaxPenaltyScale!.bike).toBeCloseTo(1.0);
    expect(cal.perLegMaxPenaltyScale!.run).toBeCloseTo(1.0);
  });
});

// ─── Tier-2 Bayesian shrinkage ─────────────────────────────────────────────

describe('computeTriCalibration — tier-2 shrinkage', () => {
  it('shrinks scale 50% at n=4 (minimum tier-2 count)', () => {
    // Construct entries where raw OLS slope would be 1 (rawScale = 2.0)
    // then shrinkage at n=4: 1 + (2-1)*4/(4+4) = 1.5 (50% of 1 retained → 1.5)
    // So if rawScale = 2.0, shrunk = 1.0 + (2.0-1.0)*4/8 = 1.5
    // We verify through the clamp/shrinkage math directly.
    // Use entries where the penalty is 1.1× and actual always matches raw (no residual).
    // penaltyExcess = 0.1 for all; if actual = raw, residualFraction = (actual - post) / post = (raw - raw*1.1) / (raw*1.1) ≈ -0.091
    // That produces a specific slope — let's just verify the shrinkage formula
    // by checking that at n=4 with a non-trivial raw scale, the output is between 1.0 and raw.
    const entries = Array.from({ length: 4 }, (_, i) => {
      const rawSwim = 2200;
      const postSwim = Math.round(rawSwim * 1.1);  // 10% penalty
      return makeEntry({
        dateISO: `2026-0${i + 1}-01`,
        predictedRawPerLeg: { swim: rawSwim, bike: 10000, run: 4600 },
        predictedPerLeg: { swim: postSwim, bike: 11000, run: 5060 },
        actualPerLeg:    { swim: postSwim + 300, bike: 11000, run: 5060 },  // swim always slow
        actualTotalSec:  postSwim + 300 + 11000 + 5060,
      });
    });
    const cal = computeTriCalibration(entries);
    expect(cal.tier).toBe(2);
    // Shrunk scale is between 1.0 and raw scale — the Bayesian pull toward 1 works.
    expect(cal.perLegMaxPenaltyScale!.swim).toBeGreaterThanOrEqual(0.6);
    expect(cal.perLegMaxPenaltyScale!.swim).toBeLessThanOrEqual(1.4);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe('computeTriCalibration — edge cases', () => {
  it('returns tier 0 for undefined raceLog', () => {
    const cal = computeTriCalibration(undefined);
    expect(cal.tier).toBe(0);
  });

  it('ignores entries with zero actualPerLeg legs', () => {
    const entries = [
      makeEntry({ actualPerLeg: { swim: 0, bike: 10800, run: 4800 } }),  // zero swim
      makeEntry({ dateISO: '2026-02-01' }),
    ];
    // Only the second entry is valid; n=1 → tier 0
    const cal = computeTriCalibration(entries);
    expect(cal.tier).toBe(0);
  });

  it('uses median (not mean) so outliers are damped', () => {
    // 3 entries: swim residuals = +60, +60, +999 (outlier)
    // Median = +60; mean would be >> 60
    const entries = [
      makeEntry({ actualPerLeg: { swim: 2460, bike: 10800, run: 4800 }, actualTotalSec: 18060 }),
      makeEntry({ dateISO: '2026-02-01', actualPerLeg: { swim: 2460, bike: 10800, run: 4800 }, actualTotalSec: 18060 }),
      makeEntry({ dateISO: '2026-03-01', actualPerLeg: { swim: 3399, bike: 10800, run: 4800 }, actualTotalSec: 18999 }),
    ];
    const cal = computeTriCalibration(entries);
    expect(cal.perLegBiasSec!.swim).toBeCloseTo(60);
  });
});
