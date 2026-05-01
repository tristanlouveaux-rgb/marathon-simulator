/**
 * Tests for the live, volume-aware, course-aware triathlon race predictor.
 *
 * Each test is anchored in a behaviour the plan calls out as required:
 *   - per-discipline volume sensitivity
 *   - course factor sensitivity (flat vs mountainous, cool vs hot-humid)
 *   - durability cap surfaces a `limitingFactor`
 *   - live projection (projected ≤ current when undertrained, ≈ current at race week)
 *   - confidence range narrows with proximity and years of training
 */

import { describe, it, expect } from 'vitest';
import { predictTriathlonRace } from './race-prediction.triathlon';
import { applyDurabilityCap, DURABILITY_THRESHOLDS } from './durability-cap';
import {
  applyTriHorizonSwim,
  applyTriHorizonBike,
  applyTriHorizonRun,
} from './training-horizon.triathlon';
import {
  altitudeRunMultiplier,
  altitudeBikeMultiplier,
  runElevationMultiplier,
} from '@/constants/triathlon-course-factors';
import { applyCourseFactors } from './course-factors';
import type { SimulatorState } from '@/types/state';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

function baseState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  // Minimum viable state for the predictor — VDOT, FTP, CSS, race date,
  // selected race id (for course-profile lookup).
  return {
    eventType: 'triathlon',
    v: 50,
    bodyWeightKg: 70,
    w: 0,
    wks: [],
    triConfig: {
      distance: 'ironman',
      raceDate: futureISO(20),
      skillRating: { swim: 3, bike: 3, run: 3 },
      swim: { cssSecPer100m: 95 },
      bike: { ftp: 250, hasPowerMeter: true, bikeWeightKg: 9 },
    },
    onboarding: { selectedTriathlonId: 'im-roth' as any },
    firstStravaActivityISO: yearsAgoISO(3),
    ...overrides,
  } as SimulatorState;
}

function futureISO(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().split('T')[0];
}
function yearsAgoISO(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
}

// ───────────────────────────────────────────────────────────────────────────
// Horizon adjusters
// ───────────────────────────────────────────────────────────────────────────

describe('triathlon horizon adjusters', () => {
  it('swim CSS improves (lower sec/100m) when projecting forward', () => {
    const r = applyTriHorizonSwim({
      baseline: 100,
      weeks_remaining: 16,
      sessions_per_week: 4,
      ability_band: 'intermediate',
      taper_weeks: 2,
      experience_level: 'intermediate',
    });
    expect(r.improvement_pct).toBeGreaterThan(0);
    expect(r.projected).toBeLessThan(100);
  });

  it('bike FTP improves (higher watts) when projecting forward', () => {
    const r = applyTriHorizonBike({
      baseline: 250,
      weeks_remaining: 16,
      sessions_per_week: 4,
      ability_band: 'intermediate',
      taper_weeks: 2,
      experience_level: 'intermediate',
    });
    expect(r.improvement_pct).toBeGreaterThan(0);
    expect(r.projected).toBeGreaterThan(250);
  });

  it('horizon collapses to zero gain at race week', () => {
    const r = applyTriHorizonBike({
      baseline: 250,
      weeks_remaining: 0,
      sessions_per_week: 4,
      ability_band: 'intermediate',
      taper_weeks: 0,
    });
    expect(r.improvement_pct).toBe(0);
    expect(r.projected).toBe(250);
  });

  it('undertraining shrinks projected gain', () => {
    const trained = applyTriHorizonBike({
      baseline: 250,
      weeks_remaining: 16,
      sessions_per_week: 4,
      ability_band: 'intermediate',
      taper_weeks: 2,
    });
    const undertrained = applyTriHorizonBike({
      baseline: 250,
      weeks_remaining: 16,
      sessions_per_week: 1,
      ability_band: 'intermediate',
      taper_weeks: 2,
    });
    expect(undertrained.improvement_pct).toBeLessThan(trained.improvement_pct);
  });

  it('adherence penalty reduces projected gain', () => {
    const clean = applyTriHorizonBike({
      baseline: 250,
      weeks_remaining: 16,
      sessions_per_week: 4,
      ability_band: 'intermediate',
      taper_weeks: 2,
    });
    const penalised = applyTriHorizonBike({
      baseline: 250,
      weeks_remaining: 16,
      sessions_per_week: 4,
      ability_band: 'intermediate',
      taper_weeks: 2,
      adherence_penalty_pct: 3.0,
    });
    expect(penalised.improvement_pct).toBeLessThan(clean.improvement_pct);
  });

  it('run delegates to marathon function and respects IM vs 70.3', () => {
    const im = applyTriHorizonRun({
      baseline: 50,
      weeks_remaining: 16,
      sessions_per_week: 4,
      ability_band: 'intermediate',
      taper_weeks: 3,
      triathlon_distance: 'ironman',
    });
    const half = applyTriHorizonRun({
      baseline: 50,
      weeks_remaining: 16,
      sessions_per_week: 4,
      ability_band: 'intermediate',
      taper_weeks: 2,
      triathlon_distance: '70.3',
    });
    // Both should improve VDOT; exact values come from the marathon function.
    expect(im.projected).toBeGreaterThan(50);
    expect(half.projected).toBeGreaterThan(50);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Course factors
// ───────────────────────────────────────────────────────────────────────────

describe('course factors', () => {
  it('altitude penalty kicks in only above 500m', () => {
    expect(altitudeRunMultiplier(0)).toBe(1.0);
    expect(altitudeRunMultiplier(400)).toBe(1.0);
    expect(altitudeRunMultiplier(1000)).toBeGreaterThan(1.0);
    expect(altitudeRunMultiplier(2000)).toBeGreaterThan(altitudeRunMultiplier(1000));
  });

  it('altitude bike penalty < run penalty', () => {
    const bike = altitudeBikeMultiplier(2000);
    const run = altitudeRunMultiplier(2000);
    expect(bike).toBeLessThan(run);
  });

  it('run elevation: flat = identity, climbing = slower', () => {
    expect(runElevationMultiplier(0, 42.2)).toBe(1.0);
    expect(runElevationMultiplier(undefined, 42.2)).toBe(1.0);
    expect(runElevationMultiplier(500, 42.2)).toBeGreaterThan(1.0);
  });

  it('Lanzarote-style profile slows the prediction more than Roth-style', () => {
    const baseSec = { swimSec: 3500, bikeSec: 18000, runSec: 14400 };
    const roth = applyCourseFactors(
      { climate: 'temperate', altitudeM: 100, windExposure: 'sheltered', swimType: 'wetsuit-lake', bikeProfile: 'rolling', runProfile: 'flat' },
      baseSec,
      42.2,
    );
    const lanzarote = applyCourseFactors(
      { climate: 'warm', altitudeM: 20, windExposure: 'exposed', swimType: 'ocean', bikeProfile: 'mountainous', runProfile: 'rolling', runElevationM: 250, bikeElevationM: 2500 },
      baseSec,
      42.2,
    );
    const rothTotal = baseSec.swimSec * roth.swimMultiplier
      + baseSec.bikeSec * roth.bikeMultiplier
      + baseSec.runSec * roth.runMultiplier;
    const lanzaroteTotal = baseSec.swimSec * lanzarote.swimMultiplier
      + baseSec.bikeSec * lanzarote.bikeMultiplier
      + baseSec.runSec * lanzarote.runMultiplier;
    expect(lanzaroteTotal).toBeGreaterThan(rothTotal);
  });

  it('hot-humid climate produces a measurable run penalty', () => {
    const baseSec = { swimSec: 3500, bikeSec: 18000, runSec: 14400 };
    const cool = applyCourseFactors({ climate: 'cool' }, baseSec, 42.2);
    const hothumid = applyCourseFactors({ climate: 'hot-humid' }, baseSec, 42.2);
    expect(hothumid.runMultiplier).toBeGreaterThan(cool.runMultiplier);
    expect(hothumid.bikeMultiplier).toBeGreaterThan(cool.bikeMultiplier);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Durability cap
// ───────────────────────────────────────────────────────────────────────────

describe('durability cap', () => {
  it('no penalty when both thresholds met', () => {
    const r = applyDurabilityCap(
      { longestRideSec: DURABILITY_THRESHOLDS.ironman.longRideSec, longestRunSec: DURABILITY_THRESHOLDS.ironman.longRunSec },
      'ironman',
    );
    expect(r.multiplier).toBe(1.0);
    expect(r.limitingFactor).toBeNull();
  });

  it('long_ride_volume limiting factor when ride is short, run is fine', () => {
    const r = applyDurabilityCap(
      { longestRideSec: 0, longestRunSec: DURABILITY_THRESHOLDS.ironman.longRunSec },
      'ironman',
    );
    expect(r.multiplier).toBeGreaterThan(1.0);
    expect(r.limitingFactor).toBe('long_ride_volume');
  });

  it('volume_durability when both shortfalls present', () => {
    const r = applyDurabilityCap({ longestRideSec: 0, longestRunSec: 0 }, 'ironman');
    expect(r.multiplier).toBeGreaterThan(1.04);
    expect(r.limitingFactor).toBe('volume_durability');
  });

  it('cap is bounded at +5%', () => {
    const r = applyDurabilityCap({ longestRideSec: 0, longestRunSec: 0 }, 'ironman');
    expect(r.multiplier).toBeLessThanOrEqual(1.05);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End-to-end predictTriathlonRace
// ───────────────────────────────────────────────────────────────────────────

describe('predictTriathlonRace — end to end', () => {
  it('returns a finite total with both projected and current numbers', () => {
    const p = predictTriathlonRace(baseState());
    expect(p).not.toBeNull();
    expect(p!.totalSec).toBeGreaterThan(0);
    expect(p!.currentTotalSec).toBeGreaterThan(0);
    expect(p!.totalRangeSec[0]).toBeLessThan(p!.totalRangeSec[1]);
  });

  it('projected is faster than current when the plan prescribes a realistic training pattern', () => {
    // The horizon adjuster reads planned sessions/week from triWorkouts (not
    // historical garminActuals), so the projection is "if you stick with this
    // plan, here's race day". We populate both:
    //   - 12 weeks of historical garminActuals (so durability cap is satisfied)
    //   - 4 weeks of upcoming planned triWorkouts (so the projection sees
    //     a realistic session cadence for the horizon adjuster)
    const state = baseState();
    state.w = 12;
    state.wks = [];
    for (let w = 0; w < 12; w++) {
      const wk: any = { garminActuals: {} };
      // Long ride / long run / swim plus two short sessions per discipline.
      wk.garminActuals[`r${w}`] = { garminId: `r${w}`, distanceKm: 80, durationSec: 4.6 * 3600, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'CYCLING' };
      wk.garminActuals[`u${w}`] = { garminId: `u${w}`, distanceKm: 28, durationSec: 2.1 * 3600, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'RUNNING' };
      wk.garminActuals[`r${w}b`] = { garminId: `r${w}b`, distanceKm: 30, durationSec: 60 * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'CYCLING' };
      wk.garminActuals[`u${w}b`] = { garminId: `u${w}b`, distanceKm: 8, durationSec: 40 * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'RUNNING' };
      wk.garminActuals[`s${w}`] = { garminId: `s${w}`, distanceKm: 2, durationSec: 50 * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'SWIMMING' };
      wk.garminActuals[`s${w}b`] = { garminId: `s${w}b`, distanceKm: 2.5, durationSec: 60 * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'SWIMMING' };
      wk.garminActuals[`r${w}c`] = { garminId: `r${w}c`, distanceKm: 35, durationSec: 75 * 60, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, activityType: 'CYCLING' };
      state.wks!.push(wk);
    }
    // Upcoming 4 planned weeks — 3 swims / 3 bikes / 3 runs per week.
    for (let w = 0; w < 4; w++) {
      state.wks!.push({
        triWorkouts: [
          { id: `ps${w}a`, n: 'Swim', d: '60min', r: 5, t: 'swim_endurance', discipline: 'swim', dayOfWeek: 0 },
          { id: `ps${w}b`, n: 'Swim', d: '45min', r: 5, t: 'swim_threshold', discipline: 'swim', dayOfWeek: 2 },
          { id: `ps${w}c`, n: 'Swim', d: '60min', r: 5, t: 'swim_endurance', discipline: 'swim', dayOfWeek: 4 },
          { id: `pb${w}a`, n: 'Bike', d: '90min', r: 5, t: 'bike_endurance', discipline: 'bike', dayOfWeek: 1 },
          { id: `pb${w}b`, n: 'Bike', d: '60min', r: 6, t: 'bike_threshold', discipline: 'bike', dayOfWeek: 3 },
          { id: `pb${w}c`, n: 'Bike', d: '4h', r: 5, t: 'bike_endurance', discipline: 'bike', dayOfWeek: 5 },
          { id: `pr${w}a`, n: 'Run',  d: '60min', r: 5, t: 'easy', discipline: 'run', dayOfWeek: 1 },
          { id: `pr${w}b`, n: 'Run',  d: '45min', r: 7, t: 'threshold', discipline: 'run', dayOfWeek: 3 },
          { id: `pr${w}c`, n: 'Run',  d: '2h', r: 5, t: 'long', discipline: 'run', dayOfWeek: 6 },
        ],
      } as any);
    }
    const p = predictTriathlonRace(state);
    expect(p).not.toBeNull();
    expect(p!.totalSec).toBeLessThan(p!.currentTotalSec!);
  });

  it('limitingFactor surfaces when long sessions are missing', () => {
    // No actuals → both shortfalls maxed.
    const state = baseState();
    const p = predictTriathlonRace(state);
    expect(p?.limitingFactor).toBe('volume_durability');
  });

  it('confidence range widens for novice (years < 2) and narrows for veteran (>= 5)', () => {
    const novice = predictTriathlonRace(baseState({ firstStravaActivityISO: yearsAgoISO(1) }));
    const veteran = predictTriathlonRace(baseState({ firstStravaActivityISO: yearsAgoISO(7) }));
    expect(novice).not.toBeNull();
    expect(veteran).not.toBeNull();
    const noviceWidth = novice!.totalRangeSec[1] - novice!.totalRangeSec[0];
    const veteranWidth = veteran!.totalRangeSec[1] - veteran!.totalRangeSec[0];
    expect(noviceWidth).toBeGreaterThan(veteranWidth);
  });
});
