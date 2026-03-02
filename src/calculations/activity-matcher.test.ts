import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveRPE, type GarminActivityRow } from './activity-matcher';
import { findMatchingWorkout, type ExternalActivity } from './matching';
import type { Workout } from '@/types';

// ──────────────── deriveRPE ────────────────

describe('deriveRPE', () => {
  const baseRow: GarminActivityRow = {
    garmin_id: 'g1',
    activity_type: 'RUNNING',
    start_time: '2026-02-10T08:00:00Z',
    duration_sec: 3600,
    distance_m: 10000,
    avg_pace_sec_km: 360,
    avg_hr: 150,
    max_hr: 170,
    calories: 500,
    aerobic_effect: 3.5,
    anaerobic_effect: 1.2,
  };

  it('uses Garmin RPE when available', () => {
    const row = { ...baseRow, garmin_rpe: 7 };
    expect(deriveRPE(row, 5, 190, 60)).toBe(7);
  });

  it('clamps Garmin RPE to valid range', () => {
    const row = { ...baseRow, garmin_rpe: 0 };
    // RPE 0 is out of range, should fall through to HR zone
    const rpe = deriveRPE(row, 5, 190, 60);
    expect(rpe).toBeGreaterThanOrEqual(1);
    expect(rpe).toBeLessThanOrEqual(10);
  });

  it('falls back to HR zone mapping when no Garmin RPE', () => {
    // avg_hr=150, maxHR=190, restingHR=60 → intensity = (150-60)/(190-60) = 0.692
    // Falls in 0.65–0.75 bucket → Zone 2-3 boundary → RPE 5
    const rpe = deriveRPE(baseRow, 5, 190, 60);
    expect(rpe).toBe(5); // Zone 2-3 boundary
  });

  it('maps high HR to high RPE', () => {
    const row = { ...baseRow, avg_hr: 180 };
    // intensity = (180-60)/(190-60) = 0.923 → Zone 5 → RPE 9
    const rpe = deriveRPE(row, 5, 190, 60);
    expect(rpe).toBe(9);
  });

  it('maps low HR to low RPE', () => {
    const row = { ...baseRow, avg_hr: 100 };
    // intensity = (100-60)/(190-60) = 0.308 → Zone 1 → RPE 3
    const rpe = deriveRPE(row, 5, 190, 60);
    expect(rpe).toBe(3);
  });

  it('uses planned RPE when no HR data or max/resting HR', () => {
    const row = { ...baseRow, avg_hr: null };
    expect(deriveRPE(row, 6)).toBe(6);
  });

  it('defaults to 5 when nothing available', () => {
    // Must also null aerobic_effect so training-effect fallback doesn't trigger
    const row = { ...baseRow, avg_hr: null, avg_pace_sec_km: null, aerobic_effect: null };
    expect(deriveRPE(row, 0)).toBe(5);
  });
});

// ──────────────── findMatchingWorkout ────────────────

describe('findMatchingWorkout', () => {
  const easyRun: Workout = {
    t: 'easy', n: 'Easy Run', d: '8km (5:30/km+)', r: 4,
    dayOfWeek: 0, // Monday
  };

  const longRun: Workout = {
    t: 'long', n: 'Long Run', d: '18km (5:30/km+)', r: 5,
    dayOfWeek: 6, // Sunday
  };

  const thresholdRun: Workout = {
    t: 'threshold', n: 'Threshold Run', d: '1km warm up\n4×5min @ 4:00/km\n1km cool down', r: 7,
    dayOfWeek: 2, // Wednesday
  };

  const gymWorkout: Workout = {
    t: 'gym', n: 'Strength Session', d: '45min full body', r: 5,
    dayOfWeek: 1, // Tuesday
  };

  const weeklyPlan = [easyRun, longRun, thresholdRun, gymWorkout];

  it('matches run activity to same-day run workout with high confidence', () => {
    const activity: ExternalActivity = {
      type: 'run', distanceKm: 8.2, durationMin: 45, dayOfWeek: 0,
    };
    const result = findMatchingWorkout(activity, weeklyPlan);
    expect(result).not.toBeNull();
    expect(result!.workoutName).toBe('Easy Run');
    expect(result!.confidence).toBe('high');
    expect(result!.workoutId).toBe('Easy Run');
  });

  it('matches gym activity to gym workout', () => {
    const activity: ExternalActivity = {
      type: 'gym', distanceKm: 0, durationMin: 50, dayOfWeek: 1,
    };
    const result = findMatchingWorkout(activity, weeklyPlan);
    expect(result).not.toBeNull();
    expect(result!.workoutName).toBe('Strength Session');
    expect(result!.confidence).toBe('high');
  });

  it('returns medium confidence for different-day match', () => {
    // Run on Thursday (3) but planned easy run is Monday (0)
    const activity: ExternalActivity = {
      type: 'run', distanceKm: 7.8, durationMin: 43, dayOfWeek: 3,
    };
    const result = findMatchingWorkout(activity, weeklyPlan);
    // Should match based on distance similarity, but different day → medium
    if (result) {
      expect(result.confidence).toBe('medium');
    }
  });

  it('returns null for unmatched activity type', () => {
    const activity: ExternalActivity = {
      type: 'swim', distanceKm: 1.5, durationMin: 40, dayOfWeek: 0,
    };
    const result = findMatchingWorkout(activity, weeklyPlan);
    expect(result).toBeNull();
  });

  it('does not match replaced workouts', () => {
    const replacedPlan = [{ ...easyRun, status: 'replaced' as const }, longRun];
    const activity: ExternalActivity = {
      type: 'run', distanceKm: 8.0, durationMin: 44, dayOfWeek: 0,
    };
    const result = findMatchingWorkout(activity, replacedPlan);
    // Should not match the replaced easy run, may match long run or null
    if (result) {
      expect(result.workoutName).not.toBe('Easy Run');
    }
  });

  it('includes workoutId and matchedWorkout in result', () => {
    const runWithId: Workout = { ...easyRun, id: 'W1-easy-0' };
    const activity: ExternalActivity = {
      type: 'run', distanceKm: 8.0, durationMin: 44, dayOfWeek: 0,
    };
    const result = findMatchingWorkout(activity, [runWithId, longRun]);
    expect(result).not.toBeNull();
    expect(result!.workoutId).toBe('W1-easy-0');
    expect(result!.matchedWorkout).toBe(runWithId);
  });

  it('gym matches even without day match (score from type alone)', () => {
    const activity: ExternalActivity = {
      type: 'gym', distanceKm: 0, durationMin: 45, dayOfWeek: 5, // Saturday, gym is Tuesday
    };
    const result = findMatchingWorkout(activity, weeklyPlan);
    expect(result).not.toBeNull();
    expect(result!.workoutName).toBe('Strength Session');
    expect(result!.confidence).toBe('medium'); // different day → medium
  });
});
