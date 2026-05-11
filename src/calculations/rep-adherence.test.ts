import { describe, it, expect } from 'vitest';
import {
  parseRepPrescription,
  resolveRunTargetPace,
  resolveBikeTargetWatts,
  scoreRepAdherence,
  repAdherenceToEffortDev,
  repCommentary,
} from './rep-adherence';
import type { ActivityRep, GarminActual, Workout } from '@/types/state';

// ─── Prescription parsing ───────────────────────────────────────────────────

describe('parseRepPrescription', () => {
  it('parses "8×400m @ 5k pace"', () => {
    const r = parseRepPrescription('8×400m @ 5k pace');
    expect(r).toEqual({ count: 8, distanceM: 400, parsedFrom: '8×400m' });
  });

  it('parses "8 x 400m" with ASCII x and spaces', () => {
    const r = parseRepPrescription('8 x 400m @ 5k');
    expect(r?.count).toBe(8);
    expect(r?.distanceM).toBe(400);
  });

  it('parses "5×5min @ FTP"', () => {
    const r = parseRepPrescription('5×5min @ FTP');
    expect(r).toEqual({ count: 5, durationSec: 300, parsedFrom: '5×5min' });
  });

  it('parses "10×1km threshold"', () => {
    const r = parseRepPrescription('10×1km threshold');
    expect(r?.count).toBe(10);
    expect(r?.distanceM).toBe(1000);
  });

  it('parses "6×800m @ 10k"', () => {
    const r = parseRepPrescription('6×800m @ 10k');
    expect(r?.count).toBe(6);
    expect(r?.distanceM).toBe(800);
  });

  it('returns null for non-rep workouts', () => {
    expect(parseRepPrescription('45 min easy')).toBeNull();
    expect(parseRepPrescription('long run 90 min')).toBeNull();
    expect(parseRepPrescription(undefined)).toBeNull();
  });

  it('rejects too-short reps (<50m, <15s)', () => {
    expect(parseRepPrescription('8×30m')).toBeNull();
    expect(parseRepPrescription('5×10s')).toBeNull();
  });
});

// ─── Target resolution ──────────────────────────────────────────────────────

describe('resolveRunTargetPace', () => {
  it('returns interval pace for vo2 type', () => {
    const pace = resolveRunTargetPace('vo2', 50, null);
    // Sanity range — actual depends on the gp() VDOT-derived 5K time.
    expect(pace).toBeGreaterThan(200);
    expect(pace).toBeLessThan(360);
  });

  it('returns null for non-interval types (easy, long)', () => {
    expect(resolveRunTargetPace('easy', 50, null)).toBeNull();
    expect(resolveRunTargetPace('long', 50, null)).toBeNull();
  });

  it('honours ltPace when supplied', () => {
    const pace = resolveRunTargetPace('threshold', 50, 220);
    expect(pace).toBe(220); // threshold = LT pace
  });
});

describe('resolveBikeTargetWatts', () => {
  it('returns 95% of FTP for bike_threshold', () => {
    expect(resolveBikeTargetWatts('bike_threshold', 250)).toBe(238);
  });
  it('returns null when FTP missing', () => {
    expect(resolveBikeTargetWatts('bike_threshold', undefined)).toBeNull();
  });
  it('returns null for unknown bike workout types', () => {
    expect(resolveBikeTargetWatts('bike_made_up', 250)).toBeNull();
  });
});

// ─── Per-rep scoring ─────────────────────────────────────────────────────────

function makeReps(specs: Array<{ paceSecKm?: number; avgWatts?: number; distanceM?: number; durationSec?: number }>): ActivityRep[] {
  return specs.map((s, i) => ({
    index: i + 1,
    distanceM: s.distanceM ?? 400,
    durationSec: s.durationSec ?? 75,
    paceSecKm: s.paceSecKm ?? null,
    avgHR: 175,
    avgWatts: s.avgWatts ?? null,
  }));
}

function makeActual(reps: ActivityRep[]): GarminActual {
  return {
    garminId: 'strava-test',
    distanceKm: 5,
    durationSec: 1800,
    avgPaceSecKm: null,
    avgHR: 170,
    maxHR: 190,
    calories: null,
    repData: { reps, source: 'strava-laps' },
    activityType: 'RUNNING',
  };
}

// Use threshold workouts with explicit ltPace so targets are deterministic.
// (vo2 target via VDOT depends on the curve shape — fragile for unit tests.)
const T_WORKOUT: Workout = { n: 'Threshold 8×400', d: '8×400m @ threshold', t: 'threshold', r: 8 };
const LT_PACE = 240; // sec/km — threshold target = 240

describe('scoreRepAdherence — running', () => {
  it('scores all reps in band when paces hit target', () => {
    const reps = makeReps(Array.from({ length: 8 }).map(() => ({ paceSecKm: 240, distanceM: 400 })));
    const scored = scoreRepAdherence({
      workout: T_WORKOUT,
      actual: makeActual(reps),
      discipline: 'run',
      vdot: 50,
      ltPaceSecKm: LT_PACE,
    });
    expect(scored).not.toBeNull();
    expect(scored!.score.total).toBe(8);
    expect(scored!.score.inBand).toBeGreaterThanOrEqual(7);
    expect(Math.abs(scored!.score.fadePct)).toBeLessThan(2);
  });

  it('detects positive fade on a faded set', () => {
    // First 4 reps on target (240), last 4 slower (~10%)
    const reps = makeReps([
      { paceSecKm: 240 }, { paceSecKm: 240 }, { paceSecKm: 240 }, { paceSecKm: 240 },
      { paceSecKm: 264 }, { paceSecKm: 268 }, { paceSecKm: 270 }, { paceSecKm: 272 },
    ]);
    const scored = scoreRepAdherence({
      workout: T_WORKOUT,
      actual: makeActual(reps),
      discipline: 'run',
      vdot: 50,
      ltPaceSecKm: LT_PACE,
    });
    expect(scored!.score.fadePct).toBeGreaterThan(5);
  });

  it('returns null when no parseable target', () => {
    const reps = makeReps([{ paceSecKm: 240 }, { paceSecKm: 240 }, { paceSecKm: 240 }]);
    const scored = scoreRepAdherence({
      workout: { n: 'Easy run', d: '45 min easy', t: 'easy', r: 4 },
      actual: makeActual(reps),
      discipline: 'run',
      vdot: 50,
      ltPaceSecKm: LT_PACE,
    });
    expect(scored).toBeNull();
  });
});

describe('scoreRepAdherence — bike', () => {
  const FTP = 250;
  const FTP_WORKOUT: Workout = { n: '5×5min FTP', d: '5×5min @ FTP', t: 'bike_threshold', r: 8 };

  it('all reps in band when watts hit 95% FTP', () => {
    // bike_threshold target = 0.95 × FTP = 238W
    const reps = makeReps(Array.from({ length: 5 }).map(() => ({ avgWatts: 238, distanceM: 1800 })));
    const scored = scoreRepAdherence({
      workout: FTP_WORKOUT,
      actual: { ...makeActual(reps), activityType: 'CYCLING' },
      discipline: 'bike',
      ftp: FTP,
    });
    expect(scored).not.toBeNull();
    expect(scored!.score.inBand).toBeGreaterThanOrEqual(4);
  });

  it('detects fade as power drop (positive fadePct)', () => {
    const reps = makeReps([
      { avgWatts: 245 }, { avgWatts: 245 }, { avgWatts: 220 }, { avgWatts: 215 }, { avgWatts: 210 },
    ]);
    const scored = scoreRepAdherence({
      workout: FTP_WORKOUT,
      actual: { ...makeActual(reps), activityType: 'CYCLING' },
      discipline: 'bike',
      ftp: FTP,
    });
    // Power-fade: last reps weaker → fadePct sign-flipped to positive.
    expect(scored!.score.fadePct).toBeGreaterThan(5);
  });
});

describe('repAdherenceToEffortDev', () => {
  it('returns 0-ish for on-target set', () => {
    const reps = makeReps(Array.from({ length: 8 }).map(() => ({ paceSecKm: 240 })));
    const scored = scoreRepAdherence({
      workout: T_WORKOUT,
      actual: makeActual(reps),
      discipline: 'run',
      vdot: 50,
      ltPaceSecKm: LT_PACE,
    });
    const dev = repAdherenceToEffortDev(scored!);
    expect(Math.abs(dev!)).toBeLessThan(1);
  });

  it('positive deviation for slow set (under-cooked)', () => {
    // 10% slower than target (240) across the set → 264 sec/km
    const reps = makeReps(Array.from({ length: 8 }).map(() => ({ paceSecKm: 264 })));
    const scored = scoreRepAdherence({
      workout: T_WORKOUT,
      actual: makeActual(reps),
      discipline: 'run',
      vdot: 50,
      ltPaceSecKm: LT_PACE,
    });
    const dev = repAdherenceToEffortDev(scored!);
    expect(dev).toBeGreaterThan(0.5);
  });
});

describe('repCommentary', () => {
  it('praises a strong execution', () => {
    const reps = makeReps(Array.from({ length: 8 }).map(() => ({ paceSecKm: 240 })));
    const scored = scoreRepAdherence({
      workout: T_WORKOUT,
      actual: makeActual(reps),
      discipline: 'run',
      vdot: 50,
      ltPaceSecKm: LT_PACE,
    })!;
    const c = repCommentary(scored, 'run');
    expect(c.toLowerCase()).toContain('strong execution');
  });

  it('flags fade in commentary when reps drop off', () => {
    const reps = makeReps([
      { paceSecKm: 240 }, { paceSecKm: 240 }, { paceSecKm: 240 }, { paceSecKm: 240 },
      { paceSecKm: 270 }, { paceSecKm: 275 }, { paceSecKm: 278 }, { paceSecKm: 280 },
    ]);
    const scored = scoreRepAdherence({
      workout: T_WORKOUT,
      actual: makeActual(reps),
      discipline: 'run',
      vdot: 50,
      ltPaceSecKm: LT_PACE,
    })!;
    const c = repCommentary(scored, 'run');
    expect(c.toLowerCase()).toMatch(/fade|slow|first/);
  });
});
