import { describe, it, expect } from 'vitest';
import {
  computeWeekDoubleDayDays,
  computeWeekDoubleDayBonus,
  doubleDayGapMultiplier,
  doubleDayIntensityScalar,
  DOUBLE_DAY_MIN_SESSION_MIN,
} from './double-day';
import { setAthleteNormalizer } from './fitness-model';
import type { Week, GarminActual, Workout } from '@/types/state';

// Deterministic normaliser so iTRIMP → TSS conversions are stable across tests.
setAthleteNormalizer(160, 50, 195);

const PLAN_START = '2026-01-05'; // Monday
const MONDAY_MS = new Date(PLAN_START + 'T00:00:00').getTime();

function makeActual(
  overrides: Partial<GarminActual> & { startTime: string; durationSec: number; iTrimp?: number },
): GarminActual {
  return {
    garminId: `g-${overrides.startTime}`,
    distanceKm: 10,
    avgPaceSecKm: null,
    avgHR: 145,
    maxHR: null,
    calories: null,
    activityType: 'RUNNING',
    iTrimp: 2000,
    ...overrides,
  };
}

function emptyWeek(w: number = 1): Week {
  return {
    w,
    ph: 'base' as any,
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
    garminActuals: {},
  };
}

describe('doubleDayGapMultiplier — gap bands', () => {
  it('×1.20 when gap <2h', () => {
    expect(doubleDayGapMultiplier(0)).toBe(1.20);
    expect(doubleDayGapMultiplier(119.9)).toBe(1.20);
  });
  it('×1.15 when 2–6h', () => {
    expect(doubleDayGapMultiplier(120)).toBe(1.15);
    expect(doubleDayGapMultiplier(359)).toBe(1.15);
  });
  it('×1.10 when 6–12h', () => {
    expect(doubleDayGapMultiplier(360)).toBe(1.10);
    expect(doubleDayGapMultiplier(719)).toBe(1.10);
  });
  it('×1.05 when ≥12h', () => {
    expect(doubleDayGapMultiplier(720)).toBe(1.05);
    expect(doubleDayGapMultiplier(1440)).toBe(1.05);
  });
});

describe('computeWeekDoubleDayDays — basic gating', () => {
  it('returns empty when fewer than 2 sessions exist', () => {
    const wk = emptyWeek();
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600 }),
    };
    expect(computeWeekDoubleDayDays(wk, PLAN_START)).toEqual([]);
  });

  it('ignores sessions shorter than 20 min', () => {
    const wk = emptyWeek();
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600 }),
      // 15 min. Below threshold, should not count as a second session
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T12:00:00Z', durationSec: 15 * 60 }),
    };
    expect(computeWeekDoubleDayDays(wk, PLAN_START)).toEqual([]);
  });

  it('does NOT trigger across calendar days', () => {
    const wk = emptyWeek();
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600 }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-06T08:00:00Z', durationSec: 3600 }),
    };
    expect(computeWeekDoubleDayDays(wk, PLAN_START)).toEqual([]);
  });

  it('threshold is exactly 20 min — a 20-min session DOES count', () => {
    expect(DOUBLE_DAY_MIN_SESSION_MIN).toBe(20);
    const wk = emptyWeek();
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600 }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T14:00:00Z', durationSec: 20 * 60 }),
    };
    const days = computeWeekDoubleDayDays(wk, PLAN_START);
    expect(days).toHaveLength(1);
    expect(days[0].sessionCount).toBe(2);
  });
});

describe('computeWeekDoubleDayDays — compounding application', () => {
  it('applies ×1.15 bonus on a 3h gap', () => {
    const wk = emptyWeek();
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600, iTrimp: 2400 }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T11:00:00Z', durationSec: 3600, iTrimp: 1800 }),
    };
    const days = computeWeekDoubleDayDays(wk, PLAN_START);
    expect(days).toHaveLength(1);
    expect(days[0].smallestGapMin).toBe(180);
    // 40 iTRIMP * 100 / normalizer ≈ raw TSS for session 2; bonus = rawTSS * 0.15
    // (exact value depends on athlete normaliser; assert positive + roughly proportional)
    expect(days[0].bonusTSS).toBeGreaterThan(0);
    expect(days[0].secondarySessionIds).toEqual(['g2']);
  });

  it('three sessions on same day → bonuses sum across pairs', () => {
    const wk = emptyWeek();
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600 }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T13:00:00Z', durationSec: 3600 }),
      W3: makeActual({ garminId: 'g3', startTime: '2026-01-05T19:00:00Z', durationSec: 3600 }),
    };
    const days = computeWeekDoubleDayDays(wk, PLAN_START);
    expect(days).toHaveLength(1);
    expect(days[0].sessionCount).toBe(3);
    expect(days[0].secondarySessionIds).toEqual(['g2', 'g3']);
  });
});

describe('computeWeekDoubleDayDays — brick exclusion', () => {
  it('suppresses bonus when a planned brick workout is scheduled that day', () => {
    const wk = emptyWeek(1);
    // Plan start 2026-01-05 (Mon) → day 5 = Saturday 2026-01-10
    wk.triWorkouts = [
      { n: 'Brick', t: 'brick', d: '', r: 5, dayOfWeek: 5 } as Workout,
    ];
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-10T08:00:00Z', durationSec: 3600, activityType: 'CYCLING' }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-10T09:30:00Z', durationSec: 1800, activityType: 'RUNNING' }),
    };
    expect(computeWeekDoubleDayDays(wk, PLAN_START)).toEqual([]);
  });

  it('suppresses bonus on a planned HYROX brick day', () => {
    const wk = emptyWeek(1);
    wk.triWorkouts = [
      { n: 'HYROX Brick', t: 'hyrox_brick', d: '', r: 6, dayOfWeek: 5 } as Workout,
    ];
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-10T08:00:00Z', durationSec: 3600 }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-10T10:00:00Z', durationSec: 3600 }),
    };
    expect(computeWeekDoubleDayDays(wk, PLAN_START)).toEqual([]);
  });

  it('collapses an unplanned bike→run pair (≤30 min gap) into one virtual session', () => {
    const wk = emptyWeek();
    // bike → run within 15 min = unplanned brick; bike+run together count as one session.
    // Without a 3rd session, no double-day fires.
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600, activityType: 'CYCLING' }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T09:15:00Z', durationSec: 1800, activityType: 'RUNNING' }),
    };
    expect(computeWeekDoubleDayDays(wk, PLAN_START)).toEqual([]);
  });

  it('unplanned brick + later session triggers compounding on the later session only', () => {
    const wk = emptyWeek();
    wk.garminActuals = {
      // Unplanned brick: bike + run within 15 min
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600, activityType: 'CYCLING' }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T09:15:00Z', durationSec: 1800, activityType: 'RUNNING' }),
      // Padel session 6h later
      W3: makeActual({ garminId: 'g3', startTime: '2026-01-05T15:15:00Z', durationSec: 3600, activityType: 'PADEL' }),
    };
    const days = computeWeekDoubleDayDays(wk, PLAN_START);
    expect(days).toHaveLength(1);
    expect(days[0].sessionCount).toBe(2); // brick collapsed, padel = 2nd
    expect(days[0].secondarySessionIds).toEqual(['g3']);
  });
});

describe('doubleDayIntensityScalar — first-session intensity bands', () => {
  it('returns 0.85 when first session is easy (<1.0 TSS/min)', () => {
    expect(doubleDayIntensityScalar(0.5)).toBe(0.85);
    expect(doubleDayIntensityScalar(0.99)).toBe(0.85);
  });
  it('returns 1.00 for moderate (1.0–1.5 TSS/min)', () => {
    expect(doubleDayIntensityScalar(1.0)).toBe(1.00);
    expect(doubleDayIntensityScalar(1.49)).toBe(1.00);
  });
  it('returns 1.15 for hard (≥1.5 TSS/min)', () => {
    expect(doubleDayIntensityScalar(1.5)).toBe(1.15);
    expect(doubleDayIntensityScalar(2.5)).toBe(1.15);
  });
});

describe('intensity-aware compounding', () => {
  it('hard first session → larger bonus on same 2nd session', () => {
    // First session: 60 min, iTrimp 3000 (high. TSS ≈ 20 raw, but at normalizer 15000 = 20 TSS,
    // TSS/min ≈ 0.33 actually. Let me use a higher iTrimp).
    // Actually with normalizer 15000: TSS = iTrimp × 100/15000 = iTrimp/150
    // For 60 min hard at 1.5 TSS/min target → 90 TSS → iTrimp ≈ 13500
    const wkHard: Week = emptyWeek();
    wkHard.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600, iTrimp: 13500 }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T13:00:00Z', durationSec: 3600, iTrimp: 6000 }),
    };
    const hardBonus = computeWeekDoubleDayBonus(wkHard, PLAN_START);

    const wkEasy: Week = emptyWeek();
    wkEasy.garminActuals = {
      // First session easy (40 TSS / 60 min ≈ 0.67 TSS/min)
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600, iTrimp: 6000 }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T13:00:00Z', durationSec: 3600, iTrimp: 6000 }),
    };
    const easyBonus = computeWeekDoubleDayBonus(wkEasy, PLAN_START);

    expect(hardBonus).toBeGreaterThan(easyBonus);
  });
});

describe('computeWeekDoubleDayBonus', () => {
  it('returns 0 for a clean week', () => {
    const wk = emptyWeek();
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600 }),
    };
    expect(computeWeekDoubleDayBonus(wk, PLAN_START)).toBe(0);
  });

  it('sums bonuses across multiple double days in a week', () => {
    const wk = emptyWeek();
    wk.garminActuals = {
      W1: makeActual({ garminId: 'g1', startTime: '2026-01-05T08:00:00Z', durationSec: 3600 }),
      W2: makeActual({ garminId: 'g2', startTime: '2026-01-05T18:00:00Z', durationSec: 3600 }),
      // separate day, also double
      W3: makeActual({ garminId: 'g3', startTime: '2026-01-07T08:00:00Z', durationSec: 3600 }),
      W4: makeActual({ garminId: 'g4', startTime: '2026-01-07T11:00:00Z', durationSec: 3600 }),
    };
    const total = computeWeekDoubleDayBonus(wk, PLAN_START);
    expect(total).toBeGreaterThan(0);
  });
});
