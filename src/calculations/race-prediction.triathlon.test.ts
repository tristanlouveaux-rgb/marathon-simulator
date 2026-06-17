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
import { predictTriathlonRace, computeHeatAcclimatisationDiscounts } from './race-prediction.triathlon';
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
import { createDefaultInjuryState } from '@/types/injury';

// ───────────────────────────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────────────────────────

function baseState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  // Minimum viable state for the predictor. VDOT, FTP, CSS, race date,
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

describe('heat acclimatisation adjustment (symmetric)', () => {
  // Race anchors: warm = 24°C, cool = 12°C (CLIMATE_ANCHOR_TEMP_C).
  // Returned value is SUBTRACTED from leg time: positive = credit (faster),
  // negative = penalty (slower).
  it('penalises training cooler than the race (14°C train, warm race)', () => {
    const d = computeHeatAcclimatisationDiscounts(14, 'warm', 9000, 6000);
    expect(d.runDiscount).toBeLessThan(0);   // negative = time added = penalty
    expect(d.bikeDiscount).toBeLessThan(0);
  });

  it('credits training hotter than the race (28°C train, warm race)', () => {
    const d = computeHeatAcclimatisationDiscounts(28, 'warm', 9000, 6000);
    expect(d.runDiscount).toBeGreaterThan(0); // positive = time removed = credit
    expect(d.bikeDiscount).toBeGreaterThan(0);
  });

  it('is neutral when training at race temp (24°C train, warm race)', () => {
    const d = computeHeatAcclimatisationDiscounts(24, 'warm', 9000, 6000);
    expect(d.runDiscount).toBeCloseTo(0, 6);
    expect(d.bikeDiscount).toBeCloseTo(0, 6);
  });

  it('no adjustment for a cool race (no climate penalty to scale)', () => {
    const d = computeHeatAcclimatisationDiscounts(30, 'cool', 9000, 6000);
    expect(d.runDiscount).toBe(0);
    expect(d.bikeDiscount).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Forecast-factor DIRECTION audit (2026-06-01). These factors apply silently on
// top of the markers; before this block none had a directional guard, which is
// exactly how the heat sign/double-count bug survived. Each test perturbs ONE
// factor (volume/co-location held constant where possible) and asserts the leg
// moves the correct way.
// ───────────────────────────────────────────────────────────────────────────

function daysAgoISO(days: number, hour = 6): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  return d.toISOString();
}
function mkActual(id: string, type: string, startISO: string, durationSec: number, extra: Record<string, unknown> = {}) {
  return { garminId: id, activityType: type, startTime: startISO, durationSec, distanceKm: 10, avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, ...extra } as any;
}

describe('forecast factor direction — athlete-side adjustments', () => {
  it('calibration bias: a positive per-leg bias slows that leg, negative speeds it', () => {
    const neutral = predictTriathlonRace(baseState())!;
    const slow = baseState();
    slow.triConfig!.calibration = { tier: 1, basedOnRaceCount: 2, perLegBiasSec: { swim: 240, bike: 0, run: 0 } } as any;
    const fast = baseState();
    fast.triConfig!.calibration = { tier: 1, basedOnRaceCount: 2, perLegBiasSec: { swim: -120, bike: 0, run: 0 } } as any;
    expect(predictTriathlonRace(slow)!.swimSec).toBeGreaterThan(neutral.swimSec);
    expect(predictTriathlonRace(fast)!.swimSec).toBeLessThan(neutral.swimSec);
  });

  it('open-water adaptation: OW swims speed the swim leg vs the same count of pool swims', () => {
    const swims = (type: string) => ({ garminActuals: {
      s1: mkActual('s1', type, daysAgoISO(7), 2400),
      s2: mkActual('s2', type, daysAgoISO(14), 2400),
      s3: mkActual('s3', type, daysAgoISO(21), 2400),
      s4: mkActual('s4', type, daysAgoISO(28), 2400),
    } });
    const pool = baseState(); pool.wks = [swims('LAP_SWIMMING')] as any;
    const ow = baseState();   ow.wks   = [swims('OPEN_WATER_SWIMMING')] as any;
    expect(predictTriathlonRace(ow)!.swimSec).toBeLessThan(predictTriathlonRace(pool)!.swimSec);
  });

  it('brick adaptation: bike→run bricks speed the run leg vs the same sessions on separate days', () => {
    // Same volume both ways; only co-location (and therefore brick detection) differs.
    const week = (brick: boolean, i: number) => ({ garminActuals: {
      [`b${i}`]: mkActual(`b${i}`, 'CYCLING', daysAgoISO(i * 7 + 7, 6), 7200),         // 2h bike, ends 08:00
      [`r${i}`]: mkActual(`r${i}`, 'RUNNING', brick ? daysAgoISO(i * 7 + 7, 8) : daysAgoISO(i * 7 + 5, 6), 2400),
    } });
    const bricked = baseState();  bricked.wks  = [0,1,2,3,4].map(i => week(true, i)) as any;
    const separate = baseState(); separate.wks = [0,1,2,3,4].map(i => week(false, i)) as any;
    expect(predictTriathlonRace(bricked)!.runSec).toBeLessThan(predictTriathlonRace(separate)!.runSec);
  });

  it('marathon depth (IM run): a recent fast PB credits the run more than the same PB years old', () => {
    // Same 2:42 marathon PB; only recency differs, isolating the depth-credit recency factor.
    const mk = (yearsAgo: number) => {
      const s = baseState(); // ironman distance
      s.pbs = { m: 2.7 * 3600 } as any;
      s.onboarding = { ...(s.onboarding as any), pbDates: { m: yearsAgoISO(yearsAgo) } };
      return s;
    };
    const recent = predictTriathlonRace(mk(0.3))!; // ~4 months → full credit
    const old = predictTriathlonRace(mk(5))!;       // 5 years → decayed credit
    expect(recent.runSec).toBeLessThan(old.runSec);
  });

  it('empirical course factor: a slower-swim venue predicts a slower swim than a faster-swim venue', () => {
    // IRONMAN 70.3 Ohio (empirical swim factor 1.163) vs IRONMAN 70.3 Augusta
    // (current-assisted river swim, well under 1.0). Same athlete, 70.3.
    const venue = (id: string) => {
      const s = baseState();
      s.triConfig!.distance = '70.3';
      s.onboarding = { selectedTriathlonId: id } as any;
      return s;
    };
    const ohio = predictTriathlonRace(venue('703-ohio'))!;
    const augusta = predictTriathlonRace(venue('703-augusta'))!;
    expect(ohio.swimSec).toBeGreaterThan(augusta.swimSec);
  });
});

describe('predictTriathlonRace — end to end', () => {
  it('returns a finite total with both projected and current numbers', () => {
    const p = predictTriathlonRace(baseState());
    expect(p).not.toBeNull();
    expect(p!.totalSec).toBeGreaterThan(0);
    expect(p!.currentTotalSec).toBeGreaterThan(0);
    expect(p!.totalRangeSec[0]).toBeLessThan(p!.totalRangeSec[1]);
  });

  it('leg waterfall reconciles to the displayed leg time (last step == leg sec)', () => {
    const p = predictTriathlonRace(baseState());
    expect(p!.legWaterfall).toBeDefined();
    const wf = p!.legWaterfall!;
    const finalByLeg = { swim: p!.swimSec, bike: p!.bikeSec, run: p!.runSec };
    for (const leg of ['swim', 'bike', 'run'] as const) {
      const steps = wf[leg];
      expect(steps.length).toBeGreaterThan(0);
      // First step is always the base marker.
      expect(steps[0].kind).toBe('base');
      // Steps are monotonic in the sense that each toSec is a positive time.
      for (const s of steps) expect(s.toSec).toBeGreaterThan(0);
      // The last row must land on the number the card shows (within rounding +
      // the MIN_STEP_SEC threshold that hides sub-3s final adjustments).
      const last = steps[steps.length - 1].toSec;
      expect(Math.abs(last - finalByLeg[leg])).toBeLessThan(3);
    }
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
    // Upcoming 4 planned weeks. 3 swims / 3 bikes / 3 runs per week.
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

  // ─────────────────────────────────────────────────────────────────────────
  // Taper invariant: when the race is inside the discipline's taper window,
  // `projected` ≈ `current`. Taper consolidates fitness; it doesn't build it
  // (Mujika 2002), and the user can't acquire new long-session durability or
  // marker gains in 1–3 weeks. This test locks the invariant to prevent
  // regressions like the swim engagement penalty leaking only into projected
  // (causing a phantom +13:32 swim slowdown vs today) or the durability cap
  // relaxing unconditionally (causing a phantom −14:02 run speedup vs today).
  // ─────────────────────────────────────────────────────────────────────────
  it('race inside taper window: projected per-leg matches current within 30s', () => {
    // 1 week to race, IM. Run taper = 3w, swim taper = 2.5w, bike taper = 2w —
    // every discipline is inside its taper window, so executionFactor = 0 and
    // both predictions must use the same baselines + same longest sessions.
    const state = baseState({
      triConfig: {
        distance: 'ironman',
        raceDate: futureISO(1),
        skillRating: { swim: 3, bike: 3, run: 3 },
        swim: { cssSecPer100m: 95 },
        bike: { ftp: 250, hasPowerMeter: true, bikeWeightKg: 9 },
      } as any,
    });
    const p = predictTriathlonRace(state);
    expect(p).not.toBeNull();
    // Per-leg parity within ±30s (tight tolerance. Penalty share = 1.0 in
    // taper, baselines aligned, durability cap input identical).
    expect(Math.abs(p!.swimSec - p!.currentSwimSec!)).toBeLessThan(30);
    expect(Math.abs(p!.bikeSec - p!.currentBikeSec!)).toBeLessThan(30);
    expect(Math.abs(p!.runSec  - p!.currentRunSec!)).toBeLessThan(30);
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

  // ─────────────────────────────────────────────────────────────────────────
  // Injury-aware projection (ISSUE: injured 70.3 showed only −6 min because
  // swim/run were treated as zeroed for the entire horizon). The fix debits
  // each discipline only its own recovery weeks, then credits post-recovery
  // build. This locks the behaviour: shorter recovery → faster projection, and
  // a recovering injury projects far closer to healthy than a never-recovers
  // (frozen) injury.
  // ─────────────────────────────────────────────────────────────────────────
  function injuryPlanState(
    resume?: { swim?: number; bike?: number; run?: number },
    caps?: { swim?: number; bike?: number; run?: number },
  ): SimulatorState {
    const state = baseState();
    state.w = 0;
    state.wks = [];
    // 18 planned weeks of full swim/bike/run so the recovered-dose sampling
    // window always lands on weeks with sessions, isolating the weeks-debit.
    for (let w = 0; w < 18; w++) {
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
    if (resume) {
      // Restricted disciplines default to blocked (capacity 0); pass `caps` to
      // model a reduced-but-trainable discipline (e.g. bike at 50%).
      // Unrestricted disciplines are explicitly 100 so the legacy-enum fallback
      // in getDisciplineCapacity (createDefaultInjuryState sets canRun='no')
      // doesn't accidentally block them.
      (state as any).injuryState = {
        ...createDefaultInjuryState(),
        active: true,
        resumeWeeksByDiscipline: resume,
        swimCapacity: resume.swim != null ? (caps?.swim ?? 0) : 100,
        bikeCapacity: resume.bike != null ? (caps?.bike ?? 0) : 100,
        runCapacity:  resume.run  != null ? (caps?.run  ?? 0) : 100,
      };
    }
    return state;
  }

  it('injury-aware projection: shorter recovery → faster race day, recovery is credited', () => {
    const healthy = predictTriathlonRace(injuryPlanState())!;
    const short   = predictTriathlonRace(injuryPlanState({ swim: 2,  run: 2  }))!;
    const long    = predictTriathlonRace(injuryPlanState({ swim: 8,  run: 8  }))!;
    const frozen  = predictTriathlonRace(injuryPlanState({ swim: 20, run: 20 }))!;

    // Healthy carries no injury debit; injured states surface the window.
    expect(healthy.injuryRecovery).toBeUndefined();
    expect(short.injuryRecovery).toBeDefined();
    expect(short.injuryRecovery!.swim.resumeWeeks).toBe(2);
    expect(short.injuryRecovery!.bike.resumeWeeks).toBe(0);  // bike never restricted

    // Monotonic: more weeks lost → slower race-day projection.
    expect(short.totalSec).toBeGreaterThanOrEqual(healthy.totalSec);
    expect(long.totalSec).toBeGreaterThan(short.totalSec);
    expect(frozen.totalSec).toBeGreaterThan(long.totalSec);

    // The fix's point: a 2-week injury projects far closer to healthy than a
    // never-recovers injury (the old freeze-for-the-whole-horizon behaviour).
    expect(short.totalSec - healthy.totalSec).toBeLessThan(frozen.totalSec - healthy.totalSec);
  });

  it('partial capacity earns partial build credit: reduced bike beats blocked bike', () => {
    const blocked = predictTriathlonRace(injuryPlanState({ bike: 6 }, { bike: 0 }))!;
    const reduced = predictTriathlonRace(injuryPlanState({ bike: 6 }, { bike: 50 }))!;
    // Capacity is surfaced for the caption's blocked-vs-reduced wording.
    expect(blocked.injuryRecovery!.bike.capacity).toBe(0);
    expect(reduced.injuryRecovery!.bike.capacity).toBe(50);
    // A bike still ridden at half volume banks more build than a fully-blocked
    // bike (debit 3wk vs 6wk), so its race-day projection is faster.
    expect(reduced.totalSec).toBeLessThan(blocked.totalSec);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Race-validated bike + swim anchors (2026-06-17). A real race split anchors the
// bike-leg speed and stops a recent race-derived CSS being treated as detrained.
// ───────────────────────────────────────────────────────────────────────────
describe('race-validated bike + swim anchors', () => {
  const recentMonth = new Date().toISOString().slice(0, 7);
  const bikeAnchor = { kph: 36.2, raceDistance: '70.3' as const, dateISO: recentMonth, source: 'onboarding-past-race' as const };

  it('bike leg: a demonstrated race speed projects faster than the generic FTP model', () => {
    const noAnchor = predictTriathlonRace(baseState())!;
    const withAnchor = predictTriathlonRace(baseState({ raceBikeKph: bikeAnchor }))!;
    expect(withAnchor.bikeSec).toBeLessThan(noAnchor.bikeSec);
  });

  it('bike anchor stands down when stale (>365 days)', () => {
    const stale = { ...bikeAnchor, dateISO: '2020-01' };
    const withStale = predictTriathlonRace(baseState({ raceBikeKph: stale }))!;
    const noAnchor = predictTriathlonRace(baseState())!;
    expect(withStale.bikeSec).toBeCloseTo(noAnchor.bikeSec, -1);
  });

  it('swim leg: a recent race makes a derived CSS not detrained (faster than without)', () => {
    const derivedCss = { distance: 'ironman' as const, raceDate: futureISO(60), skillRating: { swim: 3, bike: 3, run: 3 }, swim: { cssSecPer100m: 113.7, cssSource: 'derived' as const }, bike: { ftp: 300, hasPowerMeter: true, bikeWeightKg: 9 } };
    const noRace = predictTriathlonRace(baseState({ triConfig: derivedCss as any }))!;
    const recentRace = predictTriathlonRace(baseState({ triConfig: derivedCss as any, raceBikeKph: bikeAnchor }))!;
    expect(recentRace.swimSec).toBeLessThan(noRace.swimSec);
  });
});
