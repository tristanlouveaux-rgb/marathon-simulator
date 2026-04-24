import { describe, it, expect } from 'vitest';
import {
  classifyActivity,
  estimateCSSFromSwimActivities,
  estimateFTPFromBikeActivities,
  estimatePerDisciplineCTLFromActivities,
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
  it('returns undefined FTP when no bike activities', () => {
    const est = estimateFTPFromBikeActivities([]);
    expect(est.ftpWatts).toBeUndefined();
    expect(est.bikeActivityCount).toBe(0);
    expect(est.derivedFromPower).toBe(false);
  });

  it('returns undefined FTP when bikes have no power data', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 3600 } as PoweredActivity,
    ]);
    expect(est.ftpWatts).toBeUndefined();
    expect(est.bikeActivityCount).toBe(1);
    expect(est.derivedFromPower).toBe(false);
  });

  it('estimates FTP from normalised power × 0.95 (Coggan)', () => {
    // NP 250W → FTP = 238W.
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 250 } as PoweredActivity,
    ]);
    expect(est.ftpWatts).toBe(238);
    expect(est.derivedFromPower).toBe(true);
  });

  it('falls back to average_watts when NP not present', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 45 * 60, averageWatts: 220 } as PoweredActivity,
    ]);
    expect(est.ftpWatts).toBe(209);
    expect(est.derivedFromPower).toBe(true);
  });

  it('skips rides under 20 min', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 15 * 60, normalizedPowerW: 300 } as PoweredActivity,
    ]);
    expect(est.ftpWatts).toBeUndefined();
  });

  it('picks highest power across eligible rides', () => {
    const est = estimateFTPFromBikeActivities([
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 200 } as PoweredActivity,
      { activityType: 'Ride', durationSec: 30 * 60, normalizedPowerW: 270 } as PoweredActivity,
      { activityType: 'Ride', durationSec: 90 * 60, normalizedPowerW: 240 } as PoweredActivity,
    ]);
    // Max is 270, × 0.95 = 256.5 → rounds to 257
    expect(est.ftpWatts).toBe(257);
  });

  it('lights up when power flows through GarminActual-shaped rows from sync', () => {
    // Simulates what stravaSync patches onto `wk.garminActuals[id]` — the
    // derivation should read the same fields and produce an FTP estimate.
    const actuals = [
      { activityType: 'Ride', durationSec: 60 * 60, normalizedPowerW: 235, averageWatts: 210, deviceWatts: true } as PoweredActivity,
    ];
    const est = estimateFTPFromBikeActivities(actuals);
    expect(est.derivedFromPower).toBe(true);
    expect(est.ftpWatts).toBe(223);  // 235 × 0.95
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
