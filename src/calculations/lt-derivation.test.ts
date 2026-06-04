import { describe, it, expect } from 'vitest';
import {
  deriveLTFromVdot,
  deriveLTFromCriticalSpeed,
  deriveLTFromSustainedEfforts,
  deriveLTHRFromMaxHR,
  deriveLT,
  resolveLT,
  type SustainedEffortInput,
  type BestEffortInput,
} from './lt-derivation';

const NOW = new Date('2026-04-24T12:00:00Z');

describe('deriveLTFromVdot (Daniels T-pace)', () => {
  it('returns null for below-minimum VDOT', () => {
    expect(deriveLTFromVdot(20)).toBeNull();
    expect(deriveLTFromVdot(null)).toBeNull();
    expect(deriveLTFromVdot(0)).toBeNull();
  });

  it('gives plausible T-pace for VDOT 55 (in half-marathon pace range)', () => {
    // VDOT 55: half-marathon pace ≈ 3:58/km ≈ 238s/km (Daniels table).
    // Our MLSS-anchored derivation lands slightly slower than Daniels' rounded
    // table T-pace (which historically maps closer to 10K than true LT2).
    const t = deriveLTFromVdot(55)!;
    expect(t).toBeGreaterThan(220);
    expect(t).toBeLessThan(260);
  });

  it('faster VDOT → faster T-pace (fewer sec/km)', () => {
    const t50 = deriveLTFromVdot(50)!;
    const t60 = deriveLTFromVdot(60)!;
    expect(t60).toBeLessThan(t50);
  });
});

describe('deriveLTFromCriticalSpeed', () => {
  it('returns null with <2 efforts', () => {
    expect(deriveLTFromCriticalSpeed([], NOW)).toBeNull();
    expect(deriveLTFromCriticalSpeed([{ distanceM: 5000, elapsedSec: 1200 }], NOW)).toBeNull();
  });

  it('fits plausible CS from 5K + 10K efforts', () => {
    // Typical 5K 20:00 + 10K 42:00 runner.
    const res = deriveLTFromCriticalSpeed(
      [
        { distanceM: 5000, elapsedSec: 1200 },
        { distanceM: 10000, elapsedSec: 2520 },
      ],
      NOW,
    );
    expect(res).not.toBeNull();
    // CS should sit near 10K pace or slightly slower.
    expect(res!.csMetersPerSec).toBeGreaterThan(3.5);
    expect(res!.csMetersPerSec).toBeLessThan(5.0);
    // LT pace = 0.93 × CS.
    expect(res!.ltPaceSecKm).toBeGreaterThan(200);
    expect(res!.ltPaceSecKm).toBeLessThan(300);
  });

  it('rejects fits where D′ is physiologically implausible', () => {
    // Two efforts that would yield D′ way outside 50–500m range.
    // Using near-identical pace for both. D′ collapses to ~0.
    const res = deriveLTFromCriticalSpeed(
      [
        { distanceM: 5000, elapsedSec: 1250 },
        { distanceM: 5100, elapsedSec: 1275 }, // same pace ≈ 4 m/s
      ],
      NOW,
    );
    // Span < 600s → rejected.
    expect(res).toBeNull();
  });

  it('ignores efforts older than 365 days', () => {
    const old = new Date(NOW);
    old.setDate(old.getDate() - 400);
    const res = deriveLTFromCriticalSpeed(
      [
        { distanceM: 5000, elapsedSec: 1200, date: old.toISOString() },
        { distanceM: 10000, elapsedSec: 2520, date: old.toISOString() },
      ],
      NOW,
    );
    expect(res).toBeNull();
  });
});

describe('deriveLTFromSustainedEfforts', () => {
  const maxHR = 185;

  const goodEffort: SustainedEffortInput = {
    startTime: '2026-04-20T08:00:00Z',
    durationSec: 1800, // 30 min
    avgPaceSecKm: 240, // 4:00/km
    avgHR: 165, // ~89% HRmax → in band
    kmSplits: [240, 238, 241, 242, 239, 241, 240], // CV small
  };

  it('accepts a clean 30-min tempo in the HR band', () => {
    const res = deriveLTFromSustainedEfforts([goodEffort], maxHR, NOW);
    expect(res).not.toBeNull();
    expect(res!.ltPaceSecKm).toBeCloseTo(240, 0);
    expect(res!.ltHR).toBeCloseTo(165, 0);
    expect(res!.nQualifying).toBe(1);
  });

  it('rejects efforts under 20 min', () => {
    const short = { ...goodEffort, durationSec: 1000 };
    expect(deriveLTFromSustainedEfforts([short], maxHR, NOW)).toBeNull();
  });

  it('rejects efforts with HR below 85% HRmax', () => {
    const easy = { ...goodEffort, avgHR: 140 }; // 75% of 185
    expect(deriveLTFromSustainedEfforts([easy], maxHR, NOW)).toBeNull();
  });

  it('rejects efforts with HR above 92% HRmax', () => {
    const hard = { ...goodEffort, avgHR: 178 }; // 96% of 185
    expect(deriveLTFromSustainedEfforts([hard], maxHR, NOW)).toBeNull();
  });

  it('rejects treadmill runs', () => {
    const tread = { ...goodEffort, sportType: 'TREADMILL' };
    expect(deriveLTFromSustainedEfforts([tread], maxHR, NOW)).toBeNull();
  });

  it('rejects hot-weather efforts (>28°C)', () => {
    const hot = { ...goodEffort, ambientTempC: 32 };
    expect(deriveLTFromSustainedEfforts([hot], maxHR, NOW)).toBeNull();
  });

  it('rejects hilly efforts (>15 m/km gain)', () => {
    // 7.5km run with 200m gain = 26.7 m/km → rejected
    const hilly = { ...goodEffort, elevationGainM: 200 };
    expect(deriveLTFromSustainedEfforts([hilly], maxHR, NOW)).toBeNull();
  });

  it('rejects unsteady pace (CV > 8%)', () => {
    // Large swings.
    const surgy = { ...goodEffort, kmSplits: [200, 280, 210, 290, 205, 285, 240] };
    expect(deriveLTFromSustainedEfforts([surgy], maxHR, NOW)).toBeNull();
  });

  it('accepts short tempos with high decoupling when pace is steady', () => {
    // Real-world case: 41-min tempo at threshold pace where the runner held
    // steady 4:05/km but HR drifted because they were near the limit. Pace
    // CV is low (steady), pace decoupling is high (HR/effort drift). Under
    // the joint gate rule, steady pace alone is sufficient evidence for a
    // short tempo. That's the LT signal, not the drift.
    const tempoWithDrift = {
      ...goodEffort,
      // Pace splits steady to ~3% CV but with a slight build (proxy for HR drift fallback).
      kmSplits: [243, 245, 244, 246, 244, 248],
      hrDrift: 8.5, // direct HR-stream drift, would fail the strict test alone
    };
    const result = deriveLTFromSustainedEfforts([tempoWithDrift], maxHR, NOW);
    expect(result).not.toBeNull();
    expect(result?.nQualifying).toBe(1);
  });

  it('rejects short efforts when both signals fail', () => {
    // Both pace CV and HR drift exceed thresholds → no steady-state evidence.
    const noisy = {
      ...goodEffort,
      kmSplits: [200, 280, 210, 290, 205, 285], // CV ~17%
      hrDrift: 12, // and HR drifted hard
    };
    expect(deriveLTFromSustainedEfforts([noisy], maxHR, NOW)).toBeNull();
  });

  it('rejects long runs (>60min) unless both pace and HR are steady', () => {
    // 90-min run with low HR drift but unsteady pace. One signal isn't
    // enough at this duration. Drift confounds grow with time on feet.
    const longUnsteady = {
      ...goodEffort,
      durationSec: 90 * 60,
      kmSplits: Array(15).fill(0).map((_, i) => 240 + (i % 2 === 0 ? -25 : 25)), // CV ~10%
      hrDrift: 1.0,
    };
    expect(deriveLTFromSustainedEfforts([longUnsteady], maxHR, NOW)).toBeNull();
  });

  it('weights recent efforts more than old ones', () => {
    const old = {
      ...goodEffort,
      startTime: '2026-03-01T08:00:00Z',
      avgPaceSecKm: 260,
      avgHR: 170,
    };
    const recent = { ...goodEffort, startTime: '2026-04-22T08:00:00Z' };
    const res = deriveLTFromSustainedEfforts([old, recent], maxHR, NOW)!;
    // Recent weight ≫ old. Result should be closer to 240 than midpoint 250.
    expect(res.ltPaceSecKm).toBeLessThan(248);
    expect(res.ltPaceSecKm).toBeGreaterThan(239);
  });

  it('rejects efforts older than 120 days', () => {
    const ancient = { ...goodEffort, startTime: '2025-12-01T08:00:00Z' };
    expect(deriveLTFromSustainedEfforts([ancient], maxHR, NOW)).toBeNull();
  });

  it('returns null if no maxHR', () => {
    expect(deriveLTFromSustainedEfforts([goodEffort], null, NOW)).toBeNull();
  });
});

describe('deriveLTHRFromMaxHR', () => {
  it('returns 88% of maxHR rounded', () => {
    expect(deriveLTHRFromMaxHR(185)).toBe(163);
    expect(deriveLTHRFromMaxHR(200)).toBe(176);
  });
  it('null in → null out', () => {
    expect(deriveLTHRFromMaxHR(null)).toBeNull();
    expect(deriveLTHRFromMaxHR(0)).toBeNull();
  });
});

describe('deriveLT orchestrator', () => {
  const maxHR = 185;
  const vdot = 55;
  const bestEfforts: BestEffortInput[] = [
    { distanceM: 5000, elapsedSec: 1200 },
    { distanceM: 10000, elapsedSec: 2520 },
  ];
  const sustained: SustainedEffortInput[] = [
    {
      startTime: '2026-04-20T08:00:00Z',
      durationSec: 1800,
      avgPaceSecKm: 240,
      avgHR: 165,
      kmSplits: [240, 238, 241, 242, 239, 241, 240],
    },
  ];

  it('override wins outright', () => {
    const res = deriveLT({
      vdot,
      maxHR,
      bestEfforts,
      sustainedEfforts: sustained,
      override: { ltPaceSecKm: 250, ltHR: 170, setAt: '2026-04-20T00:00:00Z' },
      now: NOW.toISOString(),
    });
    expect(res.source).toBe('override');
    expect(res.ltPaceSecKm).toBe(250);
    expect(res.ltHR).toBe(170);
    expect(res.confidence).toBe('high');
  });

  it('blends all three when available and gives high confidence', () => {
    const res = deriveLT({
      vdot,
      maxHR,
      bestEfforts,
      sustainedEfforts: sustained,
      now: NOW.toISOString(),
    });
    expect(res.source).toBe('blended');
    expect(res.confidence).toBe('high');
    expect(res.methods).toHaveLength(3);
    expect(res.ltPaceSecKm).toBeGreaterThan(220);
    expect(res.ltPaceSecKm).toBeLessThan(260);
    expect(res.ltHR).toBe(165);
  });

  it('falls back to Daniels-only with low confidence', () => {
    const res = deriveLT({ vdot, maxHR, now: NOW.toISOString() });
    expect(res.source).toBe('daniels');
    expect(res.confidence).toBe('low');
    expect(res.methods).toHaveLength(1);
    // LTHR falls back to 0.88 × maxHR.
    expect(res.ltHR).toBe(163);
  });

  it('returns null pace when nothing is available', () => {
    const res = deriveLT({ vdot: null, maxHR: null, now: NOW.toISOString() });
    expect(res.ltPaceSecKm).toBeNull();
    expect(res.confidence).toBe('low');
    expect(res.methods).toHaveLength(0);
  });

  it('surfaces Garmin when no other method fires', () => {
    const res = deriveLT({
      vdot: null,
      maxHR: 185,
      garmin: { ltPaceSecKm: 245, ltHR: 166, asOf: '2026-04-20T00:00:00Z' },
      now: NOW.toISOString(),
    });
    expect(res.source).toBe('garmin');
    expect(res.ltPaceSecKm).toBe(245);
  });
});

describe('resolveLT', () => {
  it('prefers fresh Garmin reading over derived', () => {
    const res = resolveLT({
      vdot: 55,
      maxHR: 185,
      bestEfforts: [
        { distanceM: 5000, elapsedSec: 1200 },
        { distanceM: 10000, elapsedSec: 2520 },
      ],
      garmin: { ltPaceSecKm: 235, ltHR: 167, asOf: '2026-04-10T00:00:00Z' },
      now: NOW.toISOString(),
    });
    expect(res.source).toBe('garmin');
    expect(res.ltPaceSecKm).toBe(235);
  });

  it('trusts an old Garmin reading — change-event semantics, no expiry (2026-06-04)', () => {
    // Garmin only pushes userMetrics when LT CHANGES; no newer push means
    // "unchanged", not "stale". The old 60-day expiry silently reverted users
    // to the VDOT estimate.
    const res = resolveLT({
      vdot: 55,
      maxHR: 185,
      bestEfforts: [
        { distanceM: 5000, elapsedSec: 1200 },
        { distanceM: 10000, elapsedSec: 2520 },
      ],
      garmin: { ltPaceSecKm: 235, ltHR: 167, asOf: '2025-12-01T00:00:00Z' },
      now: NOW.toISOString(),
    });
    expect(res.source).toBe('garmin');
    expect(res.ltPaceSecKm).toBe(235);
  });

  it('a clearly-faster derived estimate supersedes the Garmin reading', () => {
    // Derived (CS + Daniels, medium confidence) lands at ~267s/km for these
    // inputs; a 4:40/km watch reading is clearly slower and yields per the
    // benchmarks-yield-to-improvements rule.
    const res = resolveLT({
      vdot: 55,
      maxHR: 185,
      bestEfforts: [
        { distanceM: 5000, elapsedSec: 1200 },
        { distanceM: 10000, elapsedSec: 2520 },
      ],
      garmin: { ltPaceSecKm: 280, ltHR: 167, asOf: '2026-04-10T00:00:00Z' },
      now: NOW.toISOString(),
    });
    expect(res.source).not.toBe('garmin');
    expect(res.ltPaceSecKm!).toBeLessThan(280 - 3);
  });

  it('a slower derived estimate never displaces the Garmin reading', () => {
    // Watch says 3:55/km; the derived blend is slower. Measured wins.
    const res = resolveLT({
      vdot: 50,
      maxHR: 185,
      garmin: { ltPaceSecKm: 235, ltHR: 167, asOf: '2026-01-10T00:00:00Z' },
      now: NOW.toISOString(),
    });
    expect(res.source).toBe('garmin');
    expect(res.ltPaceSecKm).toBe(235);
  });

  it('override beats Garmin', () => {
    const res = resolveLT({
      vdot: 55,
      maxHR: 185,
      garmin: { ltPaceSecKm: 235, ltHR: 167, asOf: '2026-04-20T00:00:00Z' },
      override: { ltPaceSecKm: 250, setAt: '2026-04-22T00:00:00Z' },
      now: NOW.toISOString(),
    });
    expect(res.source).toBe('override');
    expect(res.ltPaceSecKm).toBe(250);
  });
});

describe('deriveLT — race-PB pace cap (definitional bound)', () => {
  // Real case, 2026-06-04: 3:09 marathoner (pace 4:30/km) shown LT 4:56/km
  // "high confidence" — Daniels fed by a stale degraded VDOT plus easy runs
  // in the empirical method. LT is the best ~60-min pace, so it can never be
  // slower than the average pace of any race PB longer than 60 minutes.
  const maxHR = 177;
  const longRaceEfforts: BestEffortInput[] = [
    { distanceM: 5000, elapsedSec: 1058 },     // 17:38 — <60min, no bound
    { distanceM: 21097.5, elapsedSec: 5490 },  // 1:31:30 — pace 260.2 s/km (tightest)
    { distanceM: 42195, elapsedSec: 11382 },   // 3:09:42 — pace 269.7 s/km
  ];
  // Easy runs that sneak through the empirical filter at ~4:56/km.
  const easyRunsAsSustained: SustainedEffortInput[] = [
    {
      startTime: '2026-04-20T08:00:00Z',
      durationSec: 2400,
      avgPaceSecKm: 296,
      avgHR: 155, // 87.6% of 177 — inside the 85-92% band
      kmSplits: [296, 295, 297, 296, 295, 297, 296, 296],
    },
  ];

  it('caps a contaminated blend at the tightest long-race PB pace and downgrades confidence', () => {
    const res = deriveLT({
      vdot: 41.3, // stale degraded VDOT → Daniels ~4:58/km
      maxHR,
      bestEfforts: longRaceEfforts,
      sustainedEfforts: easyRunsAsSustained,
      now: NOW.toISOString(),
    });
    // Tightest bound = half PB pace 5490 / 21.0975 = 260.2 s/km.
    expect(res.ltPaceSecKm).toBeCloseTo(5490 / 21.0975, 1);
    expect(res.confidence).not.toBe('high');
    expect(res.provenance).toContain('Capped');
  });

  it('does not cap when the blend is already faster than every long-race pace', () => {
    const res = deriveLT({
      vdot: 55,
      maxHR,
      bestEfforts: longRaceEfforts,
      now: NOW.toISOString(),
    });
    expect(res.ltPaceSecKm).not.toBeNull();
    expect(res.ltPaceSecKm!).toBeLessThan(5490 / 21.0975);
    expect(res.provenance).not.toContain('Capped');
  });

  it('applies no bound when all PBs are shorter than 60 minutes', () => {
    const res = deriveLT({
      vdot: 41.3,
      maxHR,
      bestEfforts: [{ distanceM: 5000, elapsedSec: 1058 }],
      sustainedEfforts: easyRunsAsSustained,
      now: NOW.toISOString(),
    });
    // Slow blend survives — a 17:38 5K bound says nothing definitional
    // about a 60-min pace ceiling in this direction.
    expect(res.ltPaceSecKm).toBeGreaterThan(280);
    expect(res.provenance).not.toContain('Capped');
  });
});
