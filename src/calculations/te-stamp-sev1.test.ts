/**
 * SEV-1 regression (ISSUE-263): Garmin Training Effect (0–5) must never reach
 * Workout.aerobic/anaerobic, which are canonical TSS. Before the fix,
 * addAdhocWorkoutFromPending stamped aerobicEffect straight onto w.aerobic,
 * so a synced cross session contributed ~3 instead of ~50 to every consumer
 * summing workout loads as TSS (tri planned-day TSS, AI coach context, tri
 * cross-training overload).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { addAdhocWorkoutFromPending } from './activity-matcher';
import { setAthleteNormalizer } from './fitness-model';
import type { Week, GarminPendingItem } from '@/types';

function makePending(overrides: Partial<GarminPendingItem> = {}): GarminPendingItem {
  return {
    garminId: 'g-test-1',
    activityType: 'INDOOR_CARDIO',
    appType: 'cross',
    startTime: '2026-06-03T18:00:00Z',
    durationSec: 3600,
    distanceM: 0,
    avgHR: 150,
    maxHR: 175,
    calories: 600,
    aerobicEffect: 3.2,
    anaerobicEffect: 0.8,
    iTrimp: 8000,
    ...overrides,
  } as GarminPendingItem;
}

describe('SEV-1: Training Effect never reaches TSS load fields', () => {
  beforeEach(() => setAthleteNormalizer()); // population normalizer 15000

  it('iTRIMP path: stamps personal-normalized TSS with the 85/15 split, not TE', () => {
    const wk = {} as Week;
    addAdhocWorkoutFromPending(wk, makePending(), 'garmin-g-test-1', 6);
    const w = wk.adhocWorkouts![0];
    // iTrimp 8000 / 15000 × 100 = 53.3 TSS → 45 aerobic / 8 anaerobic
    expect(w.aerobic).toBe(Math.round(53.333 * 0.85));
    expect(w.anaerobic).toBe(Math.round(53.333 * 0.15));
    // The 0–5 TE values are nowhere near the stamped loads
    expect((w.aerobic ?? 0)).toBeGreaterThan(10);
  });

  it('no-iTRIMP path: falls back to duration × canonical TSS rate, not TE', () => {
    const wk = {} as Week;
    addAdhocWorkoutFromPending(wk, makePending({ iTrimp: null }), 'garmin-g-test-2', 6);
    const w = wk.adhocWorkouts![0];
    // 60 min cross at RPE 6 → TL_PER_MIN[6]=1.45 → 87 TSS total, split 80/20
    // by the LOAD_PROFILES fallback. The exact split matters less than scale:
    const total = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
    expect(total).toBeGreaterThan(40); // TSS scale, not 0–5
    expect(total).toBeLessThan(150);
  });

  it('a 0–5 magnitude can never appear as a synced session load', () => {
    const wk = {} as Week;
    addAdhocWorkoutFromPending(wk, makePending({ iTrimp: 8000 }), 'garmin-g-test-3', 5);
    const w = wk.adhocWorkouts![0];
    const total = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
    expect(total).toBeGreaterThan(5); // the old bug stamped ~4.0 here
  });
});
