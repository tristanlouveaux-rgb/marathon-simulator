/**
 * Guard rail for race-distance-aware triathlon intensity distribution.
 *
 * Two layers:
 *  1. Unit checks on the pure profile (count shift, flavour, base-gate, bricks).
 *  2. INTEGRATION checks that generate a real plan per distance and inspect the
 *     actual build-week composition — this is the layer that catches the
 *     over-intensification class of bug (e.g. two hard runs and no easy run),
 *     which a constants-only test misses. See SCIENCE_LOG §BV.
 */

import { describe, it, expect } from 'vitest';
import { ALL_TRI_DISTANCES } from '@/types/triathlon';
import { generateTriathlonPlan } from './plan_engine.triathlon';
import type { SimulatorState } from '@/types/state';
import {
  triQualitySlotIndices,
  selectBikeQualityKind,
  selectSwimQualityKind,
  selectRunQualityKind,
  TRI_BRICK_POLICY,
  TRI_QUALITY_SLOTS,
} from './tri-intensity-profile';

const HIGH_INTENSITY_BIKE = ['vo2', 'vo2_micros', 'vlamax'] as const;
// Hard session types across disciplines (Workout.t values the generators emit).
const HARD_TYPES = new Set([
  'threshold', 'vo2', 'sweet_spot', 'over_under', 'vo2_micros', 'vlamax', 'speed', 'race_pace',
  'swim_threshold', 'swim_speed', 'bike_threshold', 'bike_vo2', 'bike_sweet_spot',
  'bike_over_under', 'bike_vo2_micros', 'bike_vlamax',
]);

// ─── Unit: count shift ───────────────────────────────────────────────────────

describe('tri intensity — quality-slot counts', () => {
  it('run stays at a single quality session at every distance (injury safety; intensity via flavour)', () => {
    for (const d of ALL_TRI_DISTANCES) {
      for (const phase of ['build', 'peak'] as const) {
        expect(TRI_QUALITY_SLOTS[d][phase].run, `${d} ${phase} run`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('bike quality is 2 for every format except Ironman (1, aerobic-led)', () => {
    for (const phase of ['build', 'peak'] as const) {
      expect(TRI_QUALITY_SLOTS.sprint[phase].bike).toBe(2);
      expect(TRI_QUALITY_SLOTS['70.3'][phase].bike).toBe(2);
      expect(TRI_QUALITY_SLOTS.ironman[phase].bike).toBe(1);
    }
  });

  it('short course adds a second quality swim; long course keeps one', () => {
    expect(TRI_QUALITY_SLOTS.sprint.build.swim).toBe(2);
    expect(TRI_QUALITY_SLOTS.olympic.build.swim).toBe(2);
    expect(TRI_QUALITY_SLOTS['70.3'].build.swim).toBe(1);
    expect(TRI_QUALITY_SLOTS.ironman.build.swim).toBe(1);
  });

  it('triQualitySlotIndices reserves the last slot when asked (bike long ride / run long run)', () => {
    const q = triQualitySlotIndices('ironman', 'build', 'bike', 3, /* reserveLast */ true);
    expect(q.size).toBe(1);
    expect(q.has(2)).toBe(false);
  });
});

// ─── Unit: flavour + base gate ───────────────────────────────────────────────

describe('tri intensity — flavour', () => {
  it('sprint bike quality is high-intensity; ironman bike quality is sub-threshold', () => {
    for (let week = 0; week < 6; week++) {
      expect(['vo2', 'vo2_micros', 'vlamax', 'over_under']).toContain(selectBikeQualityKind('sprint', 'build', 0, week));
      expect(HIGH_INTENSITY_BIKE).not.toContain(selectBikeQualityKind('ironman', 'build', 0, week));
    }
  });

  it('run quality: sprint/olympic = vo2, long course = threshold', () => {
    expect(selectRunQualityKind('sprint', 'build', 0, 0)).toBe('vo2');
    expect(selectRunQualityKind('70.3', 'build', 0, 0)).toBe('threshold');
    expect(selectRunQualityKind('ironman', 'peak', 0, 0)).toBe('threshold');
  });

  it('base-first: no top-end intensity in base even for sprint', () => {
    expect(HIGH_INTENSITY_BIKE).not.toContain(selectBikeQualityKind('sprint', 'base', 0, 0));
    expect(selectRunQualityKind('sprint', 'base', 0, 0)).toBe('threshold');
    expect(selectSwimQualityKind('sprint', 'base', 0, 0)).toBe('threshold');
  });
});

describe('tri intensity — bricks scale by distance', () => {
  it('sprint brick is peak-only; ironman build+peak with the largest run share', () => {
    expect(TRI_BRICK_POLICY.sprint.phases).toEqual(['peak']);
    expect(TRI_BRICK_POLICY.ironman.phases).toContain('build');
    expect(TRI_BRICK_POLICY.ironman.runShare).toBeGreaterThan(TRI_BRICK_POLICY.sprint.runShare);
  });
});

// ─── Integration: generate real plans and inspect composition ────────────────

function makeTriState(distance: string, hours: number, weeks: number): SimulatorState {
  return {
    schemaVersion: 3, eventType: 'triathlon', w: 1, tw: weeks,
    v: 50, iv: 0, rpeAdj: 0, expectedFinal: 0, rd: 'marathon', epw: 9, rw: 3, gs: 0, wkm: 0,
    pbs: {}, rec: null, lt: null, vo2: null, initialLT: null, initialVO2: null, initialBaseline: null,
    currentFitness: null, forecastTime: null, typ: 'Balanced', b: 1.1, wks: [],
    pac: { e: 300, t: 240, i: 220, m: 270, r: 180 }, skip: [], timp: 0, bodyWeightKg: 75,
    triConfig: {
      distance, timeAvailableHoursPerWeek: hours,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: false, ftp: 220, bikeWeightKg: 9 },
      swim: { cssSecPer100m: 100 }, weeksToRace: weeks,
    },
  } as unknown as SimulatorState;
}

const PLAN_CFG: Record<string, [number, number]> = {
  sprint: [8, 12], olympic: [9, 16], t100: [11, 20], '70.3': [11, 20], ironman: [13, 24],
};

describe('tri intensity — generated build week composition', () => {
  it.each(ALL_TRI_DISTANCES)('%s build week is polarised, has an easy run, and no NaN loads', (distance) => {
    const [hours, weeks] = PLAN_CFG[distance];
    const plan = generateTriathlonPlan(makeTriState(distance, hours, weeks));
    const build = plan.find((w) => w.ph === 'build');
    expect(build?.triWorkouts?.length, `${distance} build week exists`).toBeGreaterThan(0);
    const sessions = build!.triWorkouts!;

    // No NaN / negative loads anywhere.
    for (const w of sessions) {
      expect(Number.isFinite(w.aerobic ?? 0)).toBe(true);
      expect(Number.isFinite(w.anaerobic ?? 0)).toBe(true);
      expect((w.aerobic ?? 0)).toBeGreaterThanOrEqual(0);
      expect((w.estimatedDurationMin ?? 0)).toBeGreaterThan(0);
    }

    // The run never carries more than one hard session (the regression this guards).
    const hardRuns = sessions.filter((w) => w.discipline === 'run' && HARD_TYPES.has(w.t));
    expect(hardRuns.length, `${distance}: hard runs`).toBeLessThanOrEqual(1);

    // Whenever there are ≥3 run slots, at least one is an easy/aerobic run.
    const runs = sessions.filter((w) => w.discipline === 'run');
    if (runs.length >= 3) {
      const aerobicRuns = runs.filter((w) => w.t === 'easy' || w.t === 'long');
      expect(aerobicRuns.length, `${distance}: aerobic runs present`).toBeGreaterThanOrEqual(1);
    }

    // 80/20-by-time sanity: aerobic time is the majority at every distance (crude
    // session-type metric overstates "hard" since intervals include rest/warmup).
    let totMin = 0, hardMin = 0;
    for (const w of sessions) {
      const dur = w.estimatedDurationMin ?? 0;
      totMin += dur;
      if (HARD_TYPES.has(w.t)) hardMin += dur;
    }
    const easyFrac = totMin ? 1 - hardMin / totMin : 0;
    expect(easyFrac, `${distance}: easy-time fraction`).toBeGreaterThanOrEqual(0.40);
  });

  it('ironman build is aerobic-led (≥70% easy-time) with no top-end bike intensity', () => {
    const plan = generateTriathlonPlan(makeTriState('ironman', 13, 24));
    const build = plan.find((w) => w.ph === 'build')!;
    const sessions = build.triWorkouts!;
    let totMin = 0, hardMin = 0;
    for (const w of sessions) {
      const dur = w.estimatedDurationMin ?? 0;
      totMin += dur;
      if (HARD_TYPES.has(w.t)) hardMin += dur;
    }
    expect(1 - hardMin / totMin).toBeGreaterThanOrEqual(0.70);
    const topEnd = sessions.filter((w) => ['bike_vo2', 'bike_vlamax', 'bike_vo2_micros'].includes(w.t));
    expect(topEnd.length, 'ironman has no top-end bike intervals').toBe(0);
  });
});
