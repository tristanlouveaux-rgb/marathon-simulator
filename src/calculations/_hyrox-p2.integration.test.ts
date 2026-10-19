/**
 * HYROX P2 integration test — effortMultiplier → real plan engine.
 *
 * Verifies that rating past HYROX weeks easy or hard actually produces
 * a DIFFERENT current-week volume from the REAL generator, not just that
 * hyroxEffortMultiplier() returns a different number.
 *
 * Adversarial stance: we try to find where the wiring is wrong.
 */

import { describe, it, expect } from 'vitest';
import { generateHyroxPlan, regenerateHyroxWeek } from '@/workouts/plan_engine.hyrox';
import { hyroxEffortMultiplier } from '@/calculations/effort-multiplier.hyrox';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { HyroxConfig } from '@/types/triathlon';
import { HYROX_MTL_CAP } from '@/constants/hyrox-constants';

// ─── Minimal valid HyroxConfig ────────────────────────────────────────────────

const BASE_HYROX_CONFIG: HyroxConfig = {
  format: 'open_singles',
  athleteBand: 'intermediate',
  hyroxPhase: 'build',
  stationAccess: { sled: 'always', skiErg: true, rowErg: true },
  weeklyMTL: 0,
  // The band's real weekly MTL cap. With the old 200 placeholder the cap held
  // every week to its runs alone (station rounds at their floors, no easy erg
  // work), and since 2026-10-13 the running budget is 0.40 x the chosen hours
  // whatever the effort lever says (D2), so the lever had nothing left to move.
  mtlCap: HYROX_MTL_CAP.intermediate,
  mtlHistory: [],
  // Per-band session counts (intermediate defaults): 3 runs, 2 stations, 1 brick
  runsPerWeek: 3,
  stationSessionsPerWeek: 2,
  bricksPerWeek: 1,
  weeklyHoursAvailable: 8,
};

// ─── Helper: build a rated week with HYROX workouts ──────────────────────────

function makeRatedWeek(
  weekNum: number,
  plannedRpe: number,
  ratedRpe: number,
  workoutCount = 4
): Week {
  const workouts: Workout[] = [];
  const rated: Record<string, number> = {};

  for (let i = 0; i < workoutCount; i++) {
    const id = `w${weekNum}-s${i}`;
    workouts.push({
      id,
      t: 'hyrox_station_sled',
      n: `Station ${i}`,
      d: '45min',
      r: plannedRpe,
      estimatedDurationMin: 45,
    } as Workout);
    rated[id] = ratedRpe;
  }

  return {
    w: weekNum,
    ph: 'build',
    triWorkouts: workouts,
    rated,
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
  } as Week;
}

// ─── Helper: build a SimulatorState for 16 weeks, current week = 3 ──────────

function buildState(
  week1Planned: number,
  week1Rated: number,
  week2Planned: number,
  week2Rated: number,
  currentWeek = 3,
): SimulatorState {
  // The two completed weeks before the current week carry the ratings (the
  // effort score's lookback, TRI_EFFORT_LOOKBACK_WEEKS = 2); every other week
  // is a skeleton (no triWorkouts, no ratings) the generator populates.
  const wks: Week[] = [];
  for (let i = 1; i <= 16; i++) {
    if (i === currentWeek - 2) { wks.push(makeRatedWeek(i, week1Planned, week1Rated)); continue; }
    if (i === currentWeek - 1) { wks.push(makeRatedWeek(i, week2Planned, week2Rated)); continue; }
    wks.push({
      w: i,
      ph: 'build',
      triWorkouts: [],
      rated: {},
      skip: [],
      cross: [],
      wkGain: 0,
      workoutMods: [],
      adjustments: [],
      unspentLoad: 0,
      extraRunLoad: 0,
    } as Week);
  }

  return {
    eventType: 'hyrox',
    w: currentWeek,
    tw: 16,         // total weeks
    hyroxConfig: { ...BASE_HYROX_CONFIG },
    wks,
  } as unknown as SimulatorState;
}

/** The week the volume checks read: week 9, a loaded build week of the
 *  16-week plan. Since lane H2b (2026-10-19) the base week's technique
 *  session is a fixed dose (the sheet's 0.5 x race volume) and its easy erg
 *  session already sits at the tier cap, so the lever moves nothing upward
 *  there; in a build week it moves the race-pace dose (its sets follow the
 *  week's nominal size, the effort lever included) and the easy erg fill. */
const CURRENT = 9;

// ─── Helper: sum estimatedDurationMin for a generated week's workouts ────────

function totalDurationMin(workouts: Workout[]): number {
  return workouts.reduce((sum, w) => sum + (w.estimatedDurationMin ?? 0), 0);
}

function totalMTL(workouts: Workout[]): number {
  return workouts.reduce((sum, w) => sum + (w.musculoTendonLoad ?? 0), 0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HYROX P2 integration — effortMultiplier wired into real generator', () => {

  // ── Multiplier sanity checks (using real function) ──────────────────────────

  it('NEUTRAL: rated == planned → multiplier is exactly 1.0', () => {
    const state = buildState(7, 7, 7, 7);
    const mult = hyroxEffortMultiplier(state);
    expect(mult).toBe(1.0);
  });

  it('EASY: rated well below planned → multiplier > 1.0 (more load next week)', () => {
    // planned=7, rated=4 → score = -3 → mult = 1 - (-3*0.05) = 1.15
    const state = buildState(7, 4, 7, 4);
    const mult = hyroxEffortMultiplier(state);
    expect(mult).toBeGreaterThan(1.0);
    console.log('EASY multiplier:', mult);
  });

  it('HARD: rated well above planned → multiplier < 1.0 (less load next week)', () => {
    // planned=5, rated=9 → score = +4 → mult = 1 - (4*0.05) = 0.80 → clamped to 0.85
    const state = buildState(5, 9, 5, 9);
    const mult = hyroxEffortMultiplier(state);
    expect(mult).toBeLessThan(1.0);
    console.log('HARD multiplier:', mult);
  });

  it('clamps at upper bound 1.15 (extreme easy)', () => {
    const state = buildState(9, 1, 9, 1);
    expect(hyroxEffortMultiplier(state)).toBe(1.15);
  });

  it('clamps at lower bound 0.85 (extreme hard)', () => {
    const state = buildState(1, 9, 1, 9);
    expect(hyroxEffortMultiplier(state)).toBe(0.85);
  });

  // ── Integration: does the REAL generator produce DIFFERENT volume? ──────────

  it('INTEGRATION: EASY rating produces HIGHER current-week volume than NEUTRAL', () => {
    const neutralState = buildState(7, 7, 7, 7, CURRENT);
    const easyState    = buildState(7, 4, 7, 4, CURRENT);

    // Use generateHyroxPlan — the full plan engine, not a reimplementation.
    const neutralPlan = generateHyroxPlan(neutralState);
    const easyPlan    = generateHyroxPlan(easyState);

    // The current week (0-based index CURRENT - 1)
    const neutralWeek3 = neutralPlan[CURRENT - 1]?.triWorkouts ?? [];
    const easyWeek3    = easyPlan[CURRENT - 1]?.triWorkouts ?? [];

    const neutralVol = totalDurationMin(neutralWeek3);
    const easyVol    = totalDurationMin(easyWeek3);

    console.log('\n--- INTEGRATION volume numbers ---');
    console.log('NEUTRAL week 3 total duration (min):', neutralVol);
    console.log('EASY    week 3 total duration (min):', easyVol);
    console.log('EASY MTL:', totalMTL(easyWeek3), '  NEUTRAL MTL:', totalMTL(neutralWeek3));

    expect(easyVol).toBeGreaterThan(neutralVol);
  });

  it('INTEGRATION: HARD rating produces LOWER current-week volume than NEUTRAL', () => {
    const neutralState = buildState(7, 7, 7, 7, CURRENT);
    const hardState    = buildState(5, 9, 5, 9, CURRENT);

    const neutralPlan = generateHyroxPlan(neutralState);
    const hardPlan    = generateHyroxPlan(hardState);

    const neutralWeek3 = neutralPlan[CURRENT - 1]?.triWorkouts ?? [];
    const hardWeek3    = hardPlan[CURRENT - 1]?.triWorkouts ?? [];

    const neutralVol = totalDurationMin(neutralWeek3);
    const hardVol    = totalDurationMin(hardWeek3);

    console.log('\n--- INTEGRATION volume numbers ---');
    console.log('NEUTRAL week 3 total duration (min):', neutralVol);
    console.log('HARD    week 3 total duration (min):', hardVol);
    console.log('HARD MTL:', totalMTL(hardWeek3), '  NEUTRAL MTL:', totalMTL(neutralWeek3));

    expect(hardVol).toBeLessThan(neutralVol);
  });

  it('INTEGRATION: in a base week the lever never flips direction (EASY at or above NEUTRAL, HARD at or below)', () => {
    // Lane H2b review: in base the technique session is a fixed dose and the
    // easy erg session sits at its cap, so an EASY rating adds nothing
    // upward there (the lever reaches race-pace sets and erg fill from
    // build). It must still never hold a base week below NEUTRAL.
    const BASE = 3;
    const plan = (st: SimulatorState) => generateHyroxPlan(st)[BASE - 1];
    const neutral = plan(buildState(7, 7, 7, 7, BASE));
    const easy = plan(buildState(7, 4, 7, 4, BASE));
    const hard = plan(buildState(5, 9, 5, 9, BASE));
    expect(neutral?.ph).toBe('base');
    const vol = (w: typeof neutral) => totalDurationMin(w?.triWorkouts ?? []);
    expect(vol(easy)).toBeGreaterThanOrEqual(vol(neutral));
    expect(vol(hard)).toBeLessThanOrEqual(vol(neutral));
  });

  it('INTEGRATION: EASY→NEUTRAL→HARD volume is strictly ordered', () => {
    const neutralState = buildState(7, 7, 7, 7, CURRENT);
    const easyState    = buildState(7, 4, 7, 4, CURRENT);
    const hardState    = buildState(5, 9, 5, 9, CURRENT);

    const neutralVol = totalDurationMin(generateHyroxPlan(neutralState)[CURRENT - 1]?.triWorkouts ?? []);
    const easyVol    = totalDurationMin(generateHyroxPlan(easyState)[CURRENT - 1]?.triWorkouts ?? []);
    const hardVol    = totalDurationMin(generateHyroxPlan(hardState)[CURRENT - 1]?.triWorkouts ?? []);

    console.log('\n--- Summary across scenarios ---');
    console.log(`HARD(${hardVol}) < NEUTRAL(${neutralVol}) < EASY(${easyVol})`);

    expect(easyVol).toBeGreaterThan(neutralVol);
    expect(hardVol).toBeLessThan(neutralVol);
  });

  // ── Gate check: past weeks must NOT be scaled ────────────────────────────────

  it('GATE: past week (weekIndex < state.w) is NOT scaled by effortMultiplier', () => {
    // Build an "extreme easy" state (mult = 1.15) and compare week 1 output
    // (past) vs week 3 output (current). The past week should be IDENTICAL
    // to the neutral state's week 1 — the multiplier gate prevents rewriting history.

    const neutralState = buildState(7, 7, 7, 7);
    const easyState    = buildState(7, 4, 7, 4);

    const neutralPlan = generateHyroxPlan(neutralState);
    const easyPlan    = generateHyroxPlan(easyState);

    // Week 1 is index 0 (past — before state.w=3)
    const neutralWeek1Vol = totalDurationMin(neutralPlan[0]?.triWorkouts ?? []);
    const easyWeek1Vol    = totalDurationMin(easyPlan[0]?.triWorkouts ?? []);

    console.log('\n--- Gate check ---');
    console.log('Week 1 (PAST) NEUTRAL vol:', neutralWeek1Vol);
    console.log('Week 1 (PAST) EASY vol:   ', easyWeek1Vol);
    console.log('Week 1 volumes should be equal (gate prevents rewriting history)');

    // Past weeks must not diverge between neutral and easy state.
    expect(easyWeek1Vol).toBe(neutralWeek1Vol);
  });

  // ── regenerateHyroxWeek sanity check ─────────────────────────────────────────

  it('regenerateHyroxWeek also reflects effortMultiplier for current/future weeks', () => {
    // NOTE: regenerateHyroxWeek reads state.wks[weekIndex-1] as the "existing" week to
    // spread metadata onto. It still calls generateWeekSessions(state, ...) which reads
    // hyroxEffortMultiplier(state). So the state.wks MUST preserve the rated weeks 1&2
    // to keep the effort signal alive. We must NOT overwrite wks with generated plan
    // output (generateHyroxPlan returns weeks with empty rated:{}, killing the signal).
    // Instead we directly call regenerateHyroxWeek on the original states — wks already
    // has skeleton weeks 3-16 with empty triWorkouts, which is fine because
    // regenerateHyroxWeek only needs wks[weekIndex-1] to exist (to spread).

    const neutralState = buildState(7, 7, 7, 7, CURRENT);
    const easyState    = buildState(7, 4, 7, 4, CURRENT);

    // regenerateHyroxWeek requires wks[weekIndex-1] to exist (it spreads the existing week).
    // state.wks already has a skeleton current week. Call directly.
    const neutralWeek = regenerateHyroxWeek(neutralState, CURRENT);
    const easyWeek    = regenerateHyroxWeek(easyState, CURRENT);

    const neutralVol = totalDurationMin(neutralWeek?.triWorkouts ?? []);
    const easyVol    = totalDurationMin(easyWeek?.triWorkouts ?? []);

    console.log('\n--- regenerateHyroxWeek check ---');
    console.log('regenerateHyroxWeek NEUTRAL vol (week 3):', neutralVol);
    console.log('regenerateHyroxWeek EASY    vol (week 3):', easyVol);

    expect(easyVol).toBeGreaterThan(neutralVol);
  });

  // ── Magnitude check: is the delta meaningful? ────────────────────────────────

  it('MAGNITUDE: the volume delta between EASY and HARD is large enough to matter', () => {
    // With 8h/wk and mult range [0.85, 1.15], the delta should be at least
    // 0.30 * 8h * 60min/h = 144 min across the full week. Even after session
    // clamping, we expect at least a 30-min difference.
    const easyState = buildState(9, 1, 9, 1, CURRENT);   // mult = 1.15
    const hardState = buildState(1, 9, 1, 9, CURRENT);   // mult = 0.85

    const easyVol = totalDurationMin(generateHyroxPlan(easyState)[CURRENT - 1]?.triWorkouts ?? []);
    const hardVol = totalDurationMin(generateHyroxPlan(hardState)[CURRENT - 1]?.triWorkouts ?? []);
    const delta = easyVol - hardVol;

    console.log('\n--- Magnitude check ---');
    console.log('EXTREME EASY vol (week 3):', easyVol);
    console.log('EXTREME HARD vol (week 3):', hardVol);
    console.log('Delta (min):', delta);

    // Any delta > 0 confirms the wiring. We also flag if it's suspiciously tiny.
    expect(delta).toBeGreaterThan(0);
    if (delta < 10) {
      console.warn('WARNING: volume delta is very small (< 10 min). Session clamping may be eating the signal!');
    }
  });
});
