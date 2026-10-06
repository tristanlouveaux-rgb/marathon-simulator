/**
 * Walks, hikes and rows never take a planned run slot, and the walk class is
 * costed as each session's own sport (ITEM S3; audit D3, C7).
 *
 * D3. findMatchingWorkout treated the matcher's 'walk' bucket as a run, so any
 * walk, hike, row, kayak, paddleboard, wheelchair or golf session took an
 * unrated same-day run slot (Long and Threshold included), or a run on any day
 * whose distance was within 15%. The walk class now fills a cross slot by sport
 * name only, like every other sport, and one compatibility rule
 * (isActivityCompatibleWithSlot) governs auto-matches, pre-assignments and
 * manual taps.
 *
 * C7. resolveSportForActivity let the walk bucket's sport ('walking') win before
 * the raw activity type was read, so rowing, kayaking, canoe, paddleboarding and
 * hiking were sized as walking (wrong runSpec, leg load and recovery multiplier
 * in the review modal and the excess-load items). The raw type now refines the
 * walk class to its own SPORTS_DB entry.
 */

import { describe, it, expect } from 'vitest';
import { findMatchingWorkout, isActivityCompatibleWithSlot, type ExternalActivity } from './matching';
import { mapGarminType, mapAppTypeToSport } from './activity-matcher';
import { resolveSportForActivity } from '@/ui/sport-picker-modal';
import type { Workout } from '@/types';

const WALK_CLASS_TYPES = [
  'WALKING', 'HIKING', 'WHEELCHAIR_PUSH_WALK', 'WHEELCHAIR_PUSH_RUN',
  'PADDLEBOARDING', 'ROWING', 'KAYAKING', 'CANOE_KAYAK', 'GOLF',
];

// Mon=0 … Sun=6. A running week with a free cross slot on Wednesday.
const PLAN: Workout[] = [
  { id: 'W1-easy-0', n: 'Easy Run', t: 'easy', d: '8km easy', r: 4, dayOfWeek: 1 },
  { id: 'W1-cross-0', n: 'Tennis', t: 'cross', d: '60min', r: 6, dayOfWeek: 2 },
  { id: 'W1-threshold-0', n: 'Threshold', t: 'threshold', d: '10km with 3 x 2km @ threshold', r: 7, dayOfWeek: 3 },
  { id: 'W1-mp-0', n: 'Marathon Pace', t: 'marathon_pace', d: '12km @ MP', r: 6, dayOfWeek: 4 },
  { id: 'W1-long-0', n: 'Long Run', t: 'long', d: '16km', r: 4, dayOfWeek: 6 },
] as Workout[];

function activity(type: string, dayOfWeek: number, distanceKm: number, name?: string): ExternalActivity {
  return {
    type: mapGarminType(type),
    distanceKm,
    durationMin: 120,
    dayOfWeek,
    name: name ?? type,
  };
}

describe('the walk class never takes a run slot (audit D3)', () => {
  it('every walk-class type lands in the walk bucket', () => {
    for (const t of WALK_CLASS_TYPES) expect(mapGarminType(t)).toBe('walk');
  });

  it('a walk, hike or row on the Long Run day does not complete the Long Run', () => {
    for (const t of WALK_CLASS_TYPES) {
      expect(findMatchingWorkout(activity(t, 6, 16), PLAN)).toBeNull();
    }
  });

  it('a row on the Threshold day does not take the Threshold, even with a free cross slot that week', () => {
    expect(findMatchingWorkout(activity('ROWING', 3, 8), PLAN)).toBeNull();
  });

  it('a 16 km hike the day before the 16 km Long Run does not take it on distance', () => {
    expect(findMatchingWorkout(activity('HIKING', 5, 16), PLAN)).toBeNull();
  });

  it('a hike still fills a recurring Hiking cross slot by sport name', () => {
    const plan = [...PLAN, { id: 'W1-cross-1', n: 'Hiking', t: 'cross', d: '120min', r: 4, dayOfWeek: 5 } as Workout];
    const m = findMatchingWorkout(activity('HIKING', 5, 12, 'Hiking'), plan);
    expect(m?.workoutId).toBe('W1-cross-1');
  });

  it('a run still takes the same-day run slot', () => {
    const m = findMatchingWorkout({ type: 'run', distanceKm: 16, durationMin: 95, dayOfWeek: 6 }, PLAN);
    expect(m?.workoutId).toBe('W1-long-0');
    expect(m?.confidence).toBe('high');
  });
});

describe('one slot-compatibility rule for every path (isActivityCompatibleWithSlot)', () => {
  const runSlotTypes = ['easy', 'long', 'threshold', 'vo2', 'intervals', 'marathon_pace', 'race_pace',
    'mixed', 'progressive', 'test_run', 'steady', 'float', 'hyrox_run_easy', 'hyrox_run_tempo'];

  it('the walk class is compatible with a cross slot and with no run slot', () => {
    for (const t of runSlotTypes) expect(isActivityCompatibleWithSlot('walk', { t })).toBe(false);
    expect(isActivityCompatibleWithSlot('walk', { t: 'cross' })).toBe(true);
    expect(isActivityCompatibleWithSlot('walk', { t: 'gym' })).toBe(false);
  });

  it('a run is compatible with every run slot findMatchingWorkout can propose', () => {
    // The matching screen bounces a proposal its rule refuses, so the run rule
    // must cover every type the auto-match scores (mixed, progressive, test_run).
    for (const t of runSlotTypes) expect(isActivityCompatibleWithSlot('run', { t })).toBe(true);
    expect(isActivityCompatibleWithSlot('run', { t: 'cross' })).toBe(true);
    expect(isActivityCompatibleWithSlot('run', { t: 'gym' })).toBe(false);
  });

  it('gym fills a gym slot or a HYROX station / brick session; ride and swim keep their tri slots', () => {
    expect(isActivityCompatibleWithSlot('gym', { t: 'gym' })).toBe(true);
    expect(isActivityCompatibleWithSlot('gym', { t: 'hyrox_station_density', discipline: 'station' })).toBe(true);
    expect(isActivityCompatibleWithSlot('gym', { t: 'hyrox_brick', discipline: 'brick' })).toBe(true);
    expect(isActivityCompatibleWithSlot('gym', { t: 'easy' })).toBe(false);
    expect(isActivityCompatibleWithSlot('ride', { t: 'bike_endurance' })).toBe(true);
    expect(isActivityCompatibleWithSlot('ride', { t: 'easy' })).toBe(false);
    expect(isActivityCompatibleWithSlot('swim', { t: 'swim_technique' })).toBe(true);
    expect(isActivityCompatibleWithSlot('other', { t: 'long' })).toBe(false);
  });

  it('findMatchingWorkout only proposes slots the rule accepts', () => {
    const types = [...WALK_CLASS_TYPES, 'RUNNING', 'STRENGTH_TRAINING', 'HIIT', 'TENNIS', 'YOGA', 'CYCLING', 'SWIMMING'];
    for (const t of types) {
      for (let day = 0; day < 7; day++) {
        const m = findMatchingWorkout(activity(t, day, 16, t === 'TENNIS' ? 'Tennis' : undefined), PLAN);
        if (m) expect(isActivityCompatibleWithSlot(mapGarminType(t), m.matchedWorkout)).toBe(true);
      }
    }
  });
});

describe('the walk class is costed as its own sport (audit C7)', () => {
  const resolve = (activityType: string) =>
    resolveSportForActivity(activityType, mapAppTypeToSport(mapGarminType(activityType)), activityType);

  it('rowing, kayaking, canoe, paddleboarding and hiking resolve to their own SPORTS_DB entry', () => {
    expect(resolve('ROWING')).toBe('rowing');
    expect(resolve('KAYAKING')).toBe('kayaking');
    expect(resolve('CANOE_KAYAK')).toBe('kayaking');
    expect(resolve('PADDLEBOARDING')).toBe('paddleboard');
    expect(resolve('HIKING')).toBe('hiking');
  });

  it('walking stays walking; golf (no SPORTS_DB entry) and wheelchair keep the walking class cost', () => {
    expect(resolve('WALKING')).toBe('walking');
    expect(resolve('WHEELCHAIR_PUSH_WALK')).toBe('walking');
    expect(resolve('GOLF')).toBe('walking');
    // The derivation reads WHEELCHAIR_PUSH_RUN as a run ('RUN' substring); the
    // walk class never resolves to a running sport.
    expect(resolve('WHEELCHAIR_PUSH_RUN')).toBe('walking');
  });

  it('other buckets are unchanged', () => {
    expect(resolve('CYCLING')).toBe('cycling');
    expect(resolve('SWIMMING')).toBe('swimming');
    expect(resolve('TENNIS')).toBe('tennis');
  });
});
