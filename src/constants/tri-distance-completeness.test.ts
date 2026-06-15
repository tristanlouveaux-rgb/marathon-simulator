/**
 * Guard rail for the 5-format triathlon distance set (sprint / olympic / t100 /
 * 70.3 / ironman). Every per-format constant table must have an entry for every
 * TriathlonDistance, or the predictor/plan engine will read `undefined` at runtime
 * for the new formats. When a new distance is added to the union, these loops fail
 * until the tables are filled — the same safety net `tsc` gives for typed Records,
 * extended to the few constants the compiler can't fully verify and to value sanity.
 */

import { describe, it, expect } from 'vitest';
import { ALL_TRI_DISTANCES } from '@/types/triathlon';
import {
  RACE_LEG_DISTANCES,
  TAPER_DAYS,
  PLAN_WEEKS_DEFAULT,
  PHASE_WEEKS,
  HOURS_RANGE,
  DEFAULT_WEEKLY_PEAK_HOURS,
  DEFAULT_VOLUME_SPLIT_BY_DISTANCE,
  RUN_FATIGUE_DISCOUNT,
} from '@/constants/triathlon-constants';
import { RACE_INTENSITY_BY_DISTANCE } from '@/calculations/bike-physics';
import { DURABILITY_THRESHOLDS } from '@/calculations/durability-cap';
import { RUN_HORIZON_PARAMS_BY_DISTANCE, TRI_TAPER_WEEKS } from '@/constants/triathlon-horizon-params';
import { RACE_READINESS_TARGETS } from '@/constants/race-readiness-targets';

describe('triathlon distance completeness', () => {
  it('every per-format constant table has an entry for every distance', () => {
    for (const d of ALL_TRI_DISTANCES) {
      expect(RACE_LEG_DISTANCES[d], `RACE_LEG_DISTANCES[${d}]`).toBeDefined();
      expect(TAPER_DAYS[d], `TAPER_DAYS[${d}]`).toBeDefined();
      expect(PLAN_WEEKS_DEFAULT[d], `PLAN_WEEKS_DEFAULT[${d}]`).toBeDefined();
      expect(PHASE_WEEKS[d], `PHASE_WEEKS[${d}]`).toBeDefined();
      expect(HOURS_RANGE[d], `HOURS_RANGE[${d}]`).toBeDefined();
      expect(DEFAULT_WEEKLY_PEAK_HOURS[d], `DEFAULT_WEEKLY_PEAK_HOURS[${d}]`).toBeDefined();
      expect(DEFAULT_VOLUME_SPLIT_BY_DISTANCE[d], `DEFAULT_VOLUME_SPLIT_BY_DISTANCE[${d}]`).toBeDefined();
      expect(RUN_FATIGUE_DISCOUNT[d], `RUN_FATIGUE_DISCOUNT[${d}]`).toBeDefined();
      expect(RACE_INTENSITY_BY_DISTANCE[d], `RACE_INTENSITY_BY_DISTANCE[${d}]`).toBeDefined();
      expect(DURABILITY_THRESHOLDS[d], `DURABILITY_THRESHOLDS[${d}]`).toBeDefined();
      expect(RUN_HORIZON_PARAMS_BY_DISTANCE[d], `RUN_HORIZON_PARAMS_BY_DISTANCE[${d}]`).toBeDefined();
      expect(RACE_READINESS_TARGETS[d], `RACE_READINESS_TARGETS[${d}]`).toBeDefined();
      for (const disc of ['swim', 'bike', 'run'] as const) {
        expect(TRI_TAPER_WEEKS[disc][d], `TRI_TAPER_WEEKS[${disc}][${d}]`).toBeDefined();
      }
    }
  });

  it('each discipline volume split sums to 1.0', () => {
    for (const d of ALL_TRI_DISTANCES) {
      const s = DEFAULT_VOLUME_SPLIT_BY_DISTANCE[d];
      expect(s.swim + s.bike + s.run, `split sum for ${d}`).toBeCloseTo(1.0, 6);
    }
  });

  it('race leg distances and intensities are monotonic where physically expected', () => {
    // Bike race IF decreases as the bike leg lengthens (fractional-utilization decay).
    expect(RACE_INTENSITY_BY_DISTANCE.sprint).toBeGreaterThan(RACE_INTENSITY_BY_DISTANCE.olympic);
    expect(RACE_INTENSITY_BY_DISTANCE.olympic).toBeGreaterThan(RACE_INTENSITY_BY_DISTANCE['70.3']);
    expect(RACE_INTENSITY_BY_DISTANCE['70.3']).toBeGreaterThan(RACE_INTENSITY_BY_DISTANCE.ironman);
    // Bike-to-run fatigue discount grows with race demand.
    expect(RUN_FATIGUE_DISCOUNT.sprint).toBeLessThan(RUN_FATIGUE_DISCOUNT.olympic);
    expect(RUN_FATIGUE_DISCOUNT.olympic).toBeLessThanOrEqual(RUN_FATIGUE_DISCOUNT['70.3']);
    expect(RUN_FATIGUE_DISCOUNT['70.3']).toBeLessThan(RUN_FATIGUE_DISCOUNT.ironman);
    // Swim share of training falls, bike share rises, as the race lengthens.
    expect(DEFAULT_VOLUME_SPLIT_BY_DISTANCE.sprint.swim).toBeGreaterThan(DEFAULT_VOLUME_SPLIT_BY_DISTANCE.ironman.swim);
    expect(DEFAULT_VOLUME_SPLIT_BY_DISTANCE.ironman.bike).toBeGreaterThan(DEFAULT_VOLUME_SPLIT_BY_DISTANCE.sprint.bike);
  });
});
