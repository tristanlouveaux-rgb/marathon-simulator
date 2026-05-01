import { describe, it, expect } from 'vitest';
import {
  classifyActivity,
  estimateCSSFromSwimActivities,
  estimateFTPFromBikeActivities,
  estimatePerDisciplineCTLFromActivities,
  computeCSSFromPair,
  deriveTriBenchmarksFromHistory,
  type PoweredActivity,
} from './tri-benchmarks-from-history';
import type { GarminActual } from '@/types/state';

// ─── classifyActivity ───────────────────────────────────────────────────────

describe('classifyActivity', () => {
  it('maps swim variants', () => {
    expect(classifyActivity('Swim')).toBe('swim');
    expect(classifyActivity('OpenWaterSwim')).toBe('swim');
    expect(classifyActivity('LAP_SWIMMING')).toBe('swim');
  });
  it('maps bike variants', () => {
    expect(classifyActivity('Ride')).toBe('bike');
    expect(classifyActivity('VirtualRide')).toBe('bike');
    expect(classifyActivity('cycling')).toBe('bike');
    expect(classifyActivity('MOUNTAIN_BIKING')).toBe('bike');
  });
  it('maps run variants', () => {
    expect(classifyActivity('Run')).toBe('run');
    expect(classifyActivity('running')).toBe('run');
    expect(classifyActivity('TRAIL_RUNNING')).toBe('run');
  });
  it('returns other for unknown', () => {
    expect(classifyActivity('Yoga')).toBe('other');
    expect(classifyActivity('Weight Training')).toBe('other');
    expect(classifyActivity(null)).toBe('other');
    expect(classifyActivity(undefined)).toBe('other');
    expect(classifyActivity('')).toBe('other');
  });
});

// ─── CSS estimate ───────────────────────────────────────────────────────────

function mkSwim(opts: { distKm: number; durSec: number; iso?: string }): Partial<GarminActual> {
  return {
    activityType: 'Swim',
    distanceKm: opts.distKm,
    durationSec: opts.durSec,
    startTime: opts.iso ?? '2026-04-20T08:00:00Z',
  };
}

describe('estimateCSSFromSwimActivities', () => {
  // Reference date for recency-aware tests. mkSwim defaults its ISO to
  // 2026-04-20, so REF on 2026-04-24 places that swim ~4 days old.
  const REF = '2026-04-24T08:00:00Z';
  const daysAgo = (n: number): string => {
    const d = new Date(REF);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString();
  };

  it('returns confidence=none with no swim activities', () => {
    const est = estimateCSSFromSwimActivities([], REF);
    expect(est.cssSecPer100m).toBeUndefined();
    expect(est.swimActivityCount).toBe(0);
    expect(est.confidence).toBe('none');
  });

  it('ignores runs / rides mixed in', () => {
    const acts = [
      { activityType: 'Run', distanceKm: 10, durationSec: 3000, startTime: REF },
      { activityType: 'Ride', distanceKm: 30, durationSec: 3600, startTime: REF },
    ] as Partial<GarminActual>[];
    const est = estimateCSSFromSwimActivities(acts as GarminActual[], REF);
    expect(est.swimActivityCount).toBe(0);
    expect(est.confidence).toBe('none');
  });

  it('returns confidence=none when only sub-800m swims exist', () => {
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 0.5, durSec: 600 }),
      mkSwim({ distKm: 0.4, durSec: 500 }),
    ] as GarminActual[], REF);
    expect(est.cssSecPer100m).toBeUndefined();
    expect(est.swimActivityCount).toBe(2);
    expect(est.confidence).toBe('none');
  });

  it('picks fastest sustained swim + adds 5s buffer', () => {
    // 1500m in 28 min = 112s/100m. 1000m in 23 min = 138s/100m.
    // Fastest anchor: 112. Expected CSS: 117. Hard-effort delta vs median
    // (138) is large, distance is test-grade, recency 4d → high confidence.
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.5, durSec: 28 * 60, iso: daysAgo(4) }),
      mkSwim({ distKm: 1.0, durSec: 23 * 60, iso: daysAgo(7) }),
    ] as GarminActual[], REF);
    expect(est.cssSecPer100m).toBe(117);
    expect(est.sourceDistanceM).toBe(1500);
    expect(est.sourceActivityISO).toBe(daysAgo(4));
    expect(est.confidence).toBe('high');
  });

  it('rejects implausible paces as sanity check', () => {
    // 1000m in 5 min = 30s/100m — too fast to be real, should be rejected.
    // 1000m in 90 min = 540s/100m — way too slow, rejected.
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.0, durSec: 5 * 60 }),
      mkSwim({ distKm: 1.0, durSec: 90 * 60 }),
    ] as GarminActual[], REF);
    expect(est.cssSecPer100m).toBeUndefined();
    expect(est.confidence).toBe('none');
  });

  it('counts valid + invalid swims in swimActivityCount', () => {
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 0.3, durSec: 200, iso: daysAgo(1) }),      // too short
      mkSwim({ distKm: 1.0, durSec: 20 * 60, iso: daysAgo(2) }),  // 120s/100m — valid
    ] as GarminActual[], REF);
    expect(est.swimActivityCount).toBe(2);
    expect(est.cssSecPer100m).toBe(125);  // 120 + 5
  });

  // ── Confidence tiers ──────────────────────────────────────────────────────

  it('confidence=high: recent ≥1500m swim significantly faster than median', () => {
    // Fastest = 110 s/100m, median = 130 s/100m → delta 20s ≫ 3s threshold.
    // Distance 1500m, recency 3d. All three signals fire.
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.5, durSec: Math.round((110 * 1500) / 100), iso: daysAgo(3) }),
      mkSwim({ distKm: 1.0, durSec: Math.round((130 * 1000) / 100), iso: daysAgo(6) }),
      mkSwim({ distKm: 1.0, durSec: Math.round((132 * 1000) / 100), iso: daysAgo(10) }),
    ] as GarminActual[], REF);
    expect(est.confidence).toBe('high');
  });

  it("confidence=medium: recent best swim, but no clear hard-effort spread", () => {
    // All three swims at ~130 s/100m → median = best, no hard-effort signal.
    // Recency is in the high tier (3d) but spread is missing → medium.
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.5, durSec: Math.round((130 * 1500) / 100), iso: daysAgo(3) }),
      mkSwim({ distKm: 1.5, durSec: Math.round((131 * 1500) / 100), iso: daysAgo(6) }),
      mkSwim({ distKm: 1.5, durSec: Math.round((132 * 1500) / 100), iso: daysAgo(10) }),
    ] as GarminActual[], REF);
    expect(est.confidence).toBe('medium');
  });

  it('confidence=medium: recent best swim is short (<1500m) even with spread', () => {
    // 800m best, recency 3d. Distance not test-grade → medium not high.
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 0.8, durSec: Math.round((105 * 800) / 100),  iso: daysAgo(3) }),
      mkSwim({ distKm: 0.9, durSec: Math.round((130 * 900) / 100),  iso: daysAgo(8) }),
    ] as GarminActual[], REF);
    expect(est.confidence).toBe('medium');
  });

  it('confidence=medium: test-grade swim within 8 weeks (older but still informative)', () => {
    // 1500m, 6 weeks old, with spread → medium (passes test-grade + 8-week tier).
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.5, durSec: Math.round((110 * 1500) / 100), iso: daysAgo(42) }),
      mkSwim({ distKm: 1.0, durSec: Math.round((130 * 1000) / 100), iso: daysAgo(50) }),
    ] as GarminActual[], REF);
    expect(est.confidence).toBe('medium');
  });

  it('confidence=low: stale (8–12 weeks) but within hard cutoff', () => {
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.5, durSec: Math.round((110 * 1500) / 100), iso: daysAgo(70) }),
    ] as GarminActual[], REF);
    expect(est.confidence).toBe('low');
    expect(est.cssSecPer100m).toBe(115);
  });

  it('confidence=none: only swims older than 12 weeks', () => {
    // Single ancient swim — number is still returned (best-effort), but
    // confidence is 'none' so the UI surfaces the test card.
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.5, durSec: Math.round((110 * 1500) / 100), iso: daysAgo(100) }),
    ] as GarminActual[], REF);
    expect(est.cssSecPer100m).toBe(115);
    expect(est.confidence).toBe('none');
  });

  it('returns sourceWeeksOld for the best swim', () => {
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.5, durSec: 28 * 60, iso: daysAgo(14) }),
    ] as GarminActual[], REF);
    expect(est.sourceWeeksOld).toBe(2.0);
  });
});

// ─── FTP estimate ───────────────────────────────────────────────────────────

describe('estimateFTPFromBikeActivities', () => {
  // Reference date used across these tests so recency math is deterministic.
  const REF = '2026-04-27T00:00:00Z';
  /** Build an ISO timestamp `daysAgo` days before REF. */
  const daysAgo = (n: number): string => {
    const d = new Date(REF);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString();
  };
  const curve = (p600: number | null, p1200: number | null, p1800: number | null, p3600: number | null) =>
    ({ p600, p1200, p1800, p3600 });

  it('returns confidence=none when no bike activities', () => {
    const est = estimateFTPFromBikeActivities([]);
    expect(est.ftpWatts).toBeUndefined();
    expect(est.bikeActivityCount).toBe(0);
    expect(est.confidence).toBe('none');
  });

  it('returns confidence=none when bikes have no power data of any kind', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 3600 } as PoweredActivity,
    ]);
    expect(est.bikeActivityCount).toBe(1);
    expect(est.confidence).toBe('none');
  });

  // ── Power curve primary path ─────────────────────────────────────────────

  it('reads p1200 directly: 20-min interval at 310 W → FTP 295 W (Coggan ×0.95)', () => {
    // The exact case that motivated the rewrite — 110-min ride containing
    // two 20-min all-out efforts. Whole-ride NP=251 would give 263 (floor),
    // but p1200=310 reveals the real test.
    const est = estimateFTPFromBikeActivities([
      {
        activityType: 'Ride',
        durationSec: 110 * 60,
        normalizedPowerW: 251,
        averageWatts: 223,
        deviceWatts: true,
        startTime: daysAgo(1),
        powerCurve: curve(305, 310, 280, 245),
      } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(295);
    expect(est.confidence).toBe('high');
    expect(est.sourceWindow).toBe('20-min');
    expect(est.sourceWatts).toBe(310);
    expect(est.contributingRideCount).toBe(1);
  });

  it('picks the strongest window: takes max of (p600×0.92, p1200×0.95, p1800×0.97, p3600×1.00)', () => {
    // p3600 × 1.00 = 280 wins over p1200 × 0.95 = 285 (no, wait: 285 > 280, p1200 wins).
    // Construct a curve where p1800 gives the max: p1800=290 → 290×0.97=281.3.
    const est = estimateFTPFromBikeActivities([
      {
        activityType: 'Ride',
        durationSec: 70 * 60,
        deviceWatts: true,
        startTime: daysAgo(2),
        powerCurve: curve(280, 280, 290, 270),
      } as PoweredActivity,
    ], REF);
    // max(280×0.92=257.6, 280×0.95=266, 290×0.97=281.3, 270×1.00=270) → 281
    expect(est.ftpWatts).toBe(281);
    expect(est.sourceWindow).toBe('30-min');
  });

  it('top-1 wins across multiple rides (freshest with strongest curve)', () => {
    // Three powered rides with curves; top candidate by watts is 295.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 80 * 60, deviceWatts: true, startTime: daysAgo(1),  powerCurve: curve(280, 310, 285, 250) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: true, startTime: daysAgo(8),  powerCurve: curve(260, 270, 245, 220) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: true, startTime: daysAgo(20), powerCurve: curve(290, 280, 260, 230) } as PoweredActivity,
    ], REF);
    // Best candidate: ride 1, p1200=310 × 0.95 = 295.
    expect(est.ftpWatts).toBe(295);
    expect(est.confidence).toBe('high');
  });

  it('outlier guard: when p1200 > 1.4 × p3600 on the top ride, picks the second-best', () => {
    // Top ride has spiky 20-min: p1200=400 vs p3600=200 (ratio 2.0 → suspect).
    // Should fall to second-best.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 80 * 60, deviceWatts: true, startTime: daysAgo(1), powerCurve: curve(380, 400, 250, 200) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: true, startTime: daysAgo(2), powerCurve: curve(270, 280, 270, 260) } as PoweredActivity,
    ], REF);
    // Second-best by watts: max(270×0.92=248.4, 280×0.95=266, 270×0.97=261.9, 260×1.00=260) → 266
    expect(est.ftpWatts).toBe(266);
  });

  // ── Confidence tiers ─────────────────────────────────────────────────────

  it('confidence=high when top-1 ride is within 4 weeks', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: true, startTime: daysAgo(20), powerCurve: curve(280, 290, 270, 240) } as PoweredActivity,
    ], REF);
    expect(est.confidence).toBe('high');
  });

  it('confidence=medium when top-1 is 4–8 weeks old', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: true, startTime: daysAgo(45), powerCurve: curve(280, 290, 270, 240) } as PoweredActivity,
    ], REF);
    expect(est.confidence).toBe('medium');
  });

  it('confidence=low when top-1 is 8–12 weeks old', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: true, startTime: daysAgo(75), powerCurve: curve(280, 290, 270, 240) } as PoweredActivity,
    ], REF);
    expect(est.confidence).toBe('low');
  });

  it('confidence=none when no candidate within 12 weeks', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: true, startTime: daysAgo(100), powerCurve: curve(280, 290, 270, 240) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBeUndefined();
    expect(est.confidence).toBe('none');
  });

  // ── Real-meter requirement ───────────────────────────────────────────────

  it('curve from a non-real-meter ride (deviceWatts=false) is ignored', () => {
    // No real-meter rides → falls through to whole-ride fallback, which also
    // requires deviceWatts=true. Result: confidence none.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: false, startTime: daysAgo(1), powerCurve: curve(280, 290, 270, 240) } as PoweredActivity,
    ], REF);
    expect(est.confidence).toBe('none');
  });

  it('caps FTP at 500W even from a curve', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, deviceWatts: true, startTime: daysAgo(1), powerCurve: curve(550, 560, 540, 520) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(500);
  });

  // ── Fallback path (no curves available) ──────────────────────────────────

  it('fallback: freshest real-meter ride within 12 weeks → NP × 1.00, low confidence', () => {
    // No power curve on any ride. Use whole-ride NP of the freshest real-meter ride.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 110 * 60, normalizedPowerW: 251, deviceWatts: true, startTime: daysAgo(1) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60,  normalizedPowerW: 270, deviceWatts: true, startTime: daysAgo(40) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(251);
    expect(est.confidence).toBe('low');
    expect(est.sourceWindow).toBe('whole-ride');
  });

  it('fallback excludes Strava-estimated power even without curves', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 280, deviceWatts: false, startTime: daysAgo(1) } as PoweredActivity,
    ], REF);
    expect(est.confidence).toBe('none');
  });

  it('fallback skips rides shorter than 20 min', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 15 * 60, normalizedPowerW: 280, deviceWatts: true, startTime: daysAgo(1) } as PoweredActivity,
    ], REF);
    expect(est.confidence).toBe('none');
  });

  it("Tristan's actual ride: 110-min with two 20-min intervals at ~310 W", () => {
    // Power curve from yesterday's interval workout. p1200=310 dominates.
    const est = estimateFTPFromBikeActivities([
      {
        activityType: 'CYCLING',
        durationSec: 110 * 60,
        normalizedPowerW: 251,
        averageWatts: 223,
        maxWatts: 773,
        deviceWatts: true,
        startTime: daysAgo(1),
        powerCurve: curve(308, 310, 282, 248),
      } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(295);  // 310 × 0.95
    expect(est.confidence).toBe('high');
    expect(est.sourceWindow).toBe('20-min');
    expect(est.sourceWatts).toBe(310);
  });
});

describe('computeCSSFromPair (Smith-Norris)', () => {
  it('400s + 180s pair → 110 s/100m', () => {
    expect(computeCSSFromPair(400, 180)).toBe(110);
  });

  it('elite pair (240s + 110s) → 65 s/100m', () => {
    expect(computeCSSFromPair(240, 110)).toBe(65);
  });

  it('returns null when either input missing', () => {
    expect(computeCSSFromPair(undefined, 180)).toBeNull();
    expect(computeCSSFromPair(400, undefined)).toBeNull();
    expect(computeCSSFromPair(null, 180)).toBeNull();
    expect(computeCSSFromPair(0, 180)).toBeNull();
  });

  it('returns null when 400m is faster than 200m (data error)', () => {
    expect(computeCSSFromPair(180, 200)).toBeNull();
  });

  it('returns null for absurd paces', () => {
    expect(computeCSSFromPair(1000, 100)).toBeNull();
  });
});

describe('deriveTriBenchmarksFromHistory — paired-TT CSS preferred', () => {
  it('uses Smith-Norris CSS when both 400m and 200m are provided', () => {
    const activities = [
      { activityType: 'Swim', distanceKm: 1.5, durationSec: 28 * 60, startTime: '2026-04-20T08:00:00Z' } as Partial<GarminActual>,
    ] as GarminActual[];
    const result = deriveTriBenchmarksFromHistory(activities, '2026-04-24T08:00:00Z', {
      swim400Sec: 400, swim200Sec: 180,
    });
    expect(result.css.cssSecPer100m).toBe(110);
    // Paired TT is gold-standard — always 'high' confidence.
    expect(result.css.confidence).toBe('high');
  });

  it('falls back to best-sustained-pace when only 400m is provided', () => {
    const activities = [
      { activityType: 'Swim', distanceKm: 1.5, durationSec: 28 * 60, startTime: '2026-04-20T08:00:00Z' } as Partial<GarminActual>,
    ] as GarminActual[];
    const result = deriveTriBenchmarksFromHistory(activities, '2026-04-24T08:00:00Z', {
      swim400Sec: 400,
    });
    expect(result.css.cssSecPer100m).toBe(117);
    // Single recent test-grade swim — but no spread to confirm hard effort.
    // Best=median so the hard-effort delta fails → medium not high.
    expect(result.css.confidence).toBe('medium');
  });
});

// ─── Per-discipline CTL ─────────────────────────────────────────────────────

function mkActivity(opts: {
  type: string; durSec: number; dayAgo: number; iTrimp?: number;
}): Partial<GarminActual> {
  const date = new Date('2026-04-24T08:00:00Z');
  date.setUTCDate(date.getUTCDate() - opts.dayAgo);
  return {
    activityType: opts.type,
    durationSec: opts.durSec,
    startTime: date.toISOString(),
    iTrimp: opts.iTrimp,
  };
}

describe('estimatePerDisciplineCTLFromActivities', () => {
  const REF = '2026-04-24T08:00:00Z';

  it('returns zero estimate with no activities', () => {
    const est = estimatePerDisciplineCTLFromActivities([], REF);
    expect(est.swim.ctl).toBe(0);
    expect(est.bike.ctl).toBe(0);
    expect(est.run.ctl).toBe(0);
    expect(est.combinedCtl).toBe(0);
  });

  it('run activity contributes to all three tracks via transfer matrix', () => {
    const est = estimatePerDisciplineCTLFromActivities([
      mkActivity({ type: 'Run', durSec: 60 * 60, dayAgo: 0, iTrimp: 300 }),
    ] as GarminActual[], REF);
    // Run → run 1.00, bike 0.70, swim 0.25
    expect(est.run.ctl).toBeGreaterThan(0);
    expect(est.bike.ctl).toBeGreaterThan(0);
    expect(est.swim.ctl).toBeGreaterThan(0);
    expect(est.run.ctl).toBeGreaterThan(est.bike.ctl);
    expect(est.bike.ctl).toBeGreaterThan(est.swim.ctl);
  });

  it('bike activity transfers at 0.75 to run CTL', () => {
    // Use 20 days of consistent iTRIMP so the EMA has enough signal to make
    // the transfer-matrix ratio observable after rounding to 0.1 precision.
    const days = Array.from({ length: 20 }, (_, i) => i);
    const bikeOnly = estimatePerDisciplineCTLFromActivities(
      days.map((d) => mkActivity({ type: 'Ride', durSec: 60 * 60, dayAgo: d, iTrimp: 300 })) as GarminActual[],
      REF,
    );
    expect(bikeOnly.run.ctl).toBeGreaterThan(0);
    expect(bikeOnly.run.ctl).toBeLessThan(bikeOnly.bike.ctl);
  });

  it('combined CTL includes non-discipline (other) activities at full weight', () => {
    // "Other" sports still contribute to combined (honest full fatigue)
    const est = estimatePerDisciplineCTLFromActivities([
      mkActivity({ type: 'Yoga', durSec: 60 * 60, dayAgo: 0, iTrimp: 50 }),
    ] as GarminActual[], REF);
    // Swim CTL is 0 (Yoga doesn't transfer to swim)
    expect(est.swim.ctl).toBe(0);
    // Combined CTL still moves because Yoga counts at 1.0 raw
    expect(est.combinedCtl).toBeGreaterThan(0);
  });

  it('older activities decay — 21 days ago < today', () => {
    const today = estimatePerDisciplineCTLFromActivities([
      mkActivity({ type: 'Run', durSec: 60 * 60, dayAgo: 0, iTrimp: 300 }),
    ] as GarminActual[], REF);
    const threeWeeksAgo = estimatePerDisciplineCTLFromActivities([
      mkActivity({ type: 'Run', durSec: 60 * 60, dayAgo: 21, iTrimp: 300 }),
    ] as GarminActual[], REF);
    expect(today.run.ctl).toBeGreaterThan(threeWeeksAgo.run.ctl);
  });

  it('falls back to duration-based TSS when iTrimp is missing', () => {
    const est = estimatePerDisciplineCTLFromActivities([
      mkActivity({ type: 'Run', durSec: 60 * 60, dayAgo: 0 }),
    ] as GarminActual[], REF);
    expect(est.run.ctl).toBeGreaterThan(0);
  });

  it('ignores activities beyond 120-day window', () => {
    const est = estimatePerDisciplineCTLFromActivities([
      mkActivity({ type: 'Run', durSec: 60 * 60, dayAgo: 200, iTrimp: 300 }),
    ] as GarminActual[], REF);
    expect(est.run.ctl).toBe(0);
  });

  it('ignores activities without a startTime', () => {
    const est = estimatePerDisciplineCTLFromActivities([
      { activityType: 'Run', durationSec: 60 * 60, iTrimp: 300, startTime: null } as Partial<GarminActual>,
    ] as GarminActual[], REF);
    expect(est.run.ctl).toBe(0);
  });

  it('iTRIMP is divided by 150 to produce TSS (matches activity-matcher convention)', () => {
    // An iTrimp of 150 is one unit of "1 hour at threshold" = 100 TSS in the
    // running convention. An all-tomorrow one-off of 150 iTRIMP should give a
    // bounded CTL — not the 2296+ we saw when iTRIMP was used raw.
    const est = estimatePerDisciplineCTLFromActivities([
      mkActivity({ type: 'Run', durSec: 60 * 60, dayAgo: 0, iTrimp: 150 }),
    ] as GarminActual[], REF);
    // CTL after 1 activity is small because the 42-day EMA is mostly empty.
    // The point is: it must not be in the thousands.
    expect(est.run.ctl).toBeLessThan(50);
    expect(est.run.ctl).toBeGreaterThan(0);
  });

  it('TSB = CTL - ATL for each discipline', () => {
    const est = estimatePerDisciplineCTLFromActivities([
      mkActivity({ type: 'Run', durSec: 60 * 60, dayAgo: 0, iTrimp: 300 }),
      mkActivity({ type: 'Run', durSec: 60 * 60, dayAgo: 14, iTrimp: 300 }),
    ] as GarminActual[], REF);
    expect(est.run.tsb).toBeCloseTo(est.run.ctl - est.run.atl, 1);
  });
});

// ─── Top-level derivation ───────────────────────────────────────────────────

describe('deriveTriBenchmarksFromHistory', () => {
  it('returns all three benchmark groups together', () => {
    const result = deriveTriBenchmarksFromHistory([
      mkSwim({ distKm: 1.5, durSec: 28 * 60 }),
      mkActivity({ type: 'Ride', durSec: 60 * 60, dayAgo: 1, iTrimp: 80 }),
      mkActivity({ type: 'Run', durSec: 45 * 60, dayAgo: 2, iTrimp: 55 }),
    ] as GarminActual[], '2026-04-24T08:00:00Z');
    expect(result.css.cssSecPer100m).toBeDefined();
    expect(result.ftp.ftpWatts).toBeUndefined();  // no power data
    expect(result.fitness.activityCount).toBeGreaterThan(0);
    expect(result.fitness.combinedCtl).toBeGreaterThan(0);
  });

  it('handles empty activity list without throwing', () => {
    const result = deriveTriBenchmarksFromHistory([]);
    expect(result.css.swimActivityCount).toBe(0);
    expect(result.ftp.bikeActivityCount).toBe(0);
    expect(result.fitness.activityCount).toBe(0);
    expect(result.fitness.combinedCtl).toBe(0);
  });
});
