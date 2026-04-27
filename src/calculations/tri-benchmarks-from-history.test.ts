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
  it('returns empty estimate with no swim activities', () => {
    const est = estimateCSSFromSwimActivities([]);
    expect(est.cssSecPer100m).toBeUndefined();
    expect(est.swimActivityCount).toBe(0);
  });

  it('ignores runs / rides mixed in', () => {
    const acts = [
      { activityType: 'Run', distanceKm: 10, durationSec: 3000, startTime: '2026-04-20T08:00:00Z' },
      { activityType: 'Ride', distanceKm: 30, durationSec: 3600, startTime: '2026-04-20T08:00:00Z' },
    ] as Partial<GarminActual>[];
    const est = estimateCSSFromSwimActivities(acts as GarminActual[]);
    expect(est.swimActivityCount).toBe(0);
  });

  it('skips swims under 800m as too short for sustained pace', () => {
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 0.5, durSec: 600 }),
      mkSwim({ distKm: 0.4, durSec: 500 }),
    ] as GarminActual[]);
    expect(est.cssSecPer100m).toBeUndefined();
    expect(est.swimActivityCount).toBe(2);
  });

  it('picks fastest sustained swim as anchor + adds 5s conservative buffer', () => {
    // 1500m in 28 min = 112s/100m. 1000m in 23 min = 138s/100m.
    // Fastest anchor: 112s/100m. Expected CSS estimate: 112 + 5 = 117s/100m.
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.5, durSec: 28 * 60, iso: '2026-04-18T08:00:00Z' }),
      mkSwim({ distKm: 1.0, durSec: 23 * 60, iso: '2026-04-15T08:00:00Z' }),
    ] as GarminActual[]);
    expect(est.cssSecPer100m).toBe(117);
    expect(est.sourceDistanceM).toBe(1500);
    expect(est.sourceActivityISO).toBe('2026-04-18T08:00:00Z');
  });

  it('rejects implausible paces as sanity check', () => {
    // 1000m in 5 min = 30s/100m — too fast to be real, should be rejected.
    // 1000m in 90 min = 540s/100m — way too slow, rejected.
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 1.0, durSec: 5 * 60 }),
      mkSwim({ distKm: 1.0, durSec: 90 * 60 }),
    ] as GarminActual[]);
    expect(est.cssSecPer100m).toBeUndefined();
  });

  it('counts valid + invalid swims in swimActivityCount', () => {
    const est = estimateCSSFromSwimActivities([
      mkSwim({ distKm: 0.3, durSec: 200 }),      // too short
      mkSwim({ distKm: 1.0, durSec: 20 * 60 }),  // 120s/100m — valid
    ] as GarminActual[]);
    expect(est.swimActivityCount).toBe(2);
    expect(est.cssSecPer100m).toBe(125);  // 120 + 5
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

  it('returns confidence=none when no bike activities', () => {
    const est = estimateFTPFromBikeActivities([]);
    expect(est.ftpWatts).toBeUndefined();
    expect(est.bikeActivityCount).toBe(0);
    expect(est.derivedFromPower).toBe(false);
    expect(est.confidence).toBe('none');
  });

  it('returns confidence=none when bikes have no power data', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 3600 } as PoweredActivity,
    ]);
    expect(est.ftpWatts).toBeUndefined();
    expect(est.bikeActivityCount).toBe(1);
    expect(est.confidence).toBe('none');
  });

  it('estimates FTP from a near-max 60-min steady ride (high tier, factor 1.00)', () => {
    // 60-min ride, NP=250, avg=235 (vi=0.94 → high tier). 60-min near-max ≈ FTP.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 250, averageWatts: 235, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(250);
    expect(est.confidence).toBe('high');
    expect(est.derivedFromPower).toBe(true);
  });

  it('uses 20-min test factor (× 0.95) for short steady efforts', () => {
    // 25-min steady ride, NP=280 → 280 × 0.95 = 266
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 25 * 60, normalizedPowerW: 280, averageWatts: 263, deviceWatts: true, startTime: daysAgo(5) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(266);
  });

  it('treats long endurance rides as floor (NP × duration multiplier), not as FTP test', () => {
    // 4-hour steady ride (vi=0.94), NP=250 → floor candidate 250 × 1.10 = 275.
    // Old behavior would have given 250 × 0.95 = 238 (under-estimate).
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 247 * 60, normalizedPowerW: 250, averageWatts: 236, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(275);
  });

  it('drops surge-y rides where NP is misleading (vi < 0.80)', () => {
    // "Pootle then sprint to work" — vi=0.65 → dropped, even though NP looks high.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 90 * 60, normalizedPowerW: 230, averageWatts: 150, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBeUndefined();
    expect(est.confidence).toBe('none');
  });

  it('excludes rides older than the 52-week hard cutoff', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 280, averageWatts: 265, deviceWatts: true, startTime: daysAgo(400) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBeUndefined();
  });

  it('weights recent rides more than older ones (12-week half-life)', () => {
    // Two equally good high-signal rides — fresh one 1w ago, stale one 36w ago.
    // Fresh weight ≈ 0.92, stale weight ≈ 0.05 → weighted mean ≈ fresh.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 300, averageWatts: 285, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 200, averageWatts: 190, deviceWatts: true, startTime: daysAgo(36 * 7) } as PoweredActivity,
    ], REF);
    // Heavily biased toward the recent 300W ride.
    expect(est.ftpWatts).toBeGreaterThan(285);
  });

  it('confidence=high requires a high-signal ride within 12 weeks', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 280, averageWatts: 265, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.confidence).toBe('high');
  });

  it('confidence=medium when the only high-signal ride is 13–26 weeks old', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 280, averageWatts: 265, deviceWatts: true, startTime: daysAgo(20 * 7) } as PoweredActivity,
    ], REF);
    expect(est.confidence).toBe('medium');
  });

  it('confidence=low when only floor-tier rides contribute (no FTP test data)', () => {
    // A single long endurance ride 35 weeks ago — below the recent-floors threshold.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 247 * 60, normalizedPowerW: 250, averageWatts: 236, deviceWatts: true, startTime: daysAgo(35 * 7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(275);
    expect(est.confidence).toBe('low');
  });

  it('caps FTP at 500W', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 600, averageWatts: 570, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(500);
  });

  it('skips rides under 20 min', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 15 * 60, normalizedPowerW: 300, averageWatts: 290, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBeUndefined();
  });

  it('drops a >2× outlier when ≥ 3 candidates exist in the same pool', () => {
    // 600 NP "spike" dropped; remaining three high-signal NPs averaged.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 600, averageWatts: 570, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 250, averageWatts: 235, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 240, averageWatts: 225, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 230, averageWatts: 215, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    // Mean of (250, 240, 230) at factor 1.00 = 240
    expect(est.ftpWatts).toBe(240);
  });

  it('prefers real power-meter rides over Strava-estimated when both present', () => {
    // Real meter (deviceWatts true) drives the estimate; estimated NP=600 ignored.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 600, averageWatts: 570, deviceWatts: false, startTime: daysAgo(7) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 280, averageWatts: 265, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(280);
  });

  it('falls back to estimated-power rides when no real-meter rides exist', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 200, averageWatts: 190, deviceWatts: false, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(200);
    expect(est.derivedFromPower).toBe(true);
  });

  it('high-signal pool wins over floor pool when both are present', () => {
    // High: 60-min steady NP=260 → 260. Floor: 4h steady NP=250 → 275.
    // High pool wins → result = 260, NOT 275.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 260, averageWatts: 245, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
      { activityType: 'Ride', durationSec: 247 * 60, normalizedPowerW: 250, averageWatts: 236, deviceWatts: true, startTime: daysAgo(7) } as PoweredActivity,
    ], REF);
    expect(est.ftpWatts).toBe(260);
  });

  it("regression test: Tristan's 5-ride DB snapshot", () => {
    // Real powered rides as of 2026-04-27. Most are stale (>52w cutoff);
    // only the 35w + 39w endurance rides survive into the floor pool.
    // Expected: weighted mean of (275 wt 0.054) + (241 wt 0.039) ≈ 261W, low confidence.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'CYCLING', durationSec: 62 * 60,  normalizedPowerW: 288, averageWatts: 277, deviceWatts: true, startTime: '2024-06-04T08:00:00Z' } as PoweredActivity,
      { activityType: 'CYCLING', durationSec: 247 * 60, normalizedPowerW: 250, averageWatts: 236, deviceWatts: true, startTime: '2025-08-27T08:00:00Z' } as PoweredActivity,
      { activityType: 'CYCLING', durationSec: 243 * 60, normalizedPowerW: 235, averageWatts: 215, deviceWatts: true, startTime: '2024-08-06T08:00:00Z' } as PoweredActivity,
      { activityType: 'CYCLING', durationSec: 119 * 60, normalizedPowerW: 230, averageWatts: 194, deviceWatts: true, startTime: '2025-08-01T06:16:00Z' } as PoweredActivity,
      { activityType: 'CYCLING', durationSec: 150 * 60, normalizedPowerW: 230, averageWatts: 207, deviceWatts: true, startTime: '2024-08-25T08:00:00Z' } as PoweredActivity,
    ], REF);
    // Two surviving floor candidates → weighted mean lands in 250–280 band.
    expect(est.ftpWatts).toBeGreaterThanOrEqual(255);
    expect(est.ftpWatts).toBeLessThanOrEqual(280);
    expect(est.confidence).toBe('low');
    expect(est.contributingRideCount).toBe(2);
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
  });

  it('falls back to best-sustained-pace when only 400m is provided', () => {
    const activities = [
      { activityType: 'Swim', distanceKm: 1.5, durationSec: 28 * 60, startTime: '2026-04-20T08:00:00Z' } as Partial<GarminActual>,
    ] as GarminActual[];
    const result = deriveTriBenchmarksFromHistory(activities, '2026-04-24T08:00:00Z', {
      swim400Sec: 400,
    });
    expect(result.css.cssSecPer100m).toBe(117);
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
