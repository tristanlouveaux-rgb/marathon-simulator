import { describe, it, expect } from 'vitest';
import { clearStaleGatesForMode, getRequiredCapacityTests, hasPassedRequiredCapacityTests, generateCapacityTestSession, evaluatePhaseTransition } from './engine';
import {
  getActivityGateLevel,
  isActivityAllowedForUser,
} from '@/constants/injury-protocols';
import type { InjuryState } from '@/types/injury';

function makeInjury(overrides: Partial<InjuryState> = {}): InjuryState {
  return {
    active: true,
    type: 'general',
    location: 'shoulder',
    locationDetail: 'R',
    currentPain: 5,
    history: [],
    startDate: new Date().toISOString(),
    context: 'training',
    recoveryPhase: 'phase_1',
    lastTestRunDate: null,
    testRunPainResult: null,
    emergencyShutdownUntil: null,
    rehabBlockStartDate: null,
    physioNotes: '',
    expectedDurationWeeks: 4,
    // Use a phase that does NOT trigger the new phase-replacement path in
    // the tri/HYROX engines (acute/rehab/test_capacity replace the whole
    // plan with phase workouts). 'graduated_return' lets the gates do the
    // work, which is what these tests exercise.
    injuryPhase: 'graduated_return',
    painLatency: false,
    acutePhaseStartDate: null,
    capacityTestsPassed: [],
    capacityTestHistory: [],
    phaseTransitions: [],
    lastActivityDate: null,
    morningPainYesterday: null,
    canRun: 'yes',
    returnToRunLevel: 1,
    severityClass: 'moderate',
    morningPainResponses: [],
    holdCount: 0,
    preferredCrossTraining: null,
    zeroPainWeeks: 0,
    graduatedReturnWeeksLeft: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// clearStaleGatesForMode. Preventing stale answers re-engaging on mode switch
// ---------------------------------------------------------------------------

describe('clearStaleGatesForMode', () => {
  const fullyGated = makeInjury({
    canRun: 'yes',
    canBike: 'no',
    canSwim: 'limited',
    canUpperLoad: 'no',
    canLowerLoad: 'limited',
  });

  it('running mode clears all non-run gates', () => {
    const out = clearStaleGatesForMode(fullyGated, 'running');
    expect(out.canRun).toBe('yes');
    expect(out.canBike).toBeUndefined();
    expect(out.canSwim).toBeUndefined();
    expect(out.canUpperLoad).toBeUndefined();
    expect(out.canLowerLoad).toBeUndefined();
  });

  it('triathlon mode keeps canBike + canSwim, clears HYROX gates', () => {
    const out = clearStaleGatesForMode(fullyGated, 'triathlon');
    expect(out.canRun).toBe('yes');
    expect(out.canBike).toBe('no');
    expect(out.canSwim).toBe('limited');
    expect(out.canUpperLoad).toBeUndefined();
    expect(out.canLowerLoad).toBeUndefined();
  });

  it('hyrox mode keeps load gates, clears canBike + canSwim', () => {
    const out = clearStaleGatesForMode(fullyGated, 'hyrox');
    expect(out.canRun).toBe('yes');
    expect(out.canBike).toBeUndefined();
    expect(out.canSwim).toBeUndefined();
    expect(out.canUpperLoad).toBe('no');
    expect(out.canLowerLoad).toBe('limited');
  });

  it('cycling-only triathlon keeps canBike only', () => {
    const out = clearStaleGatesForMode(fullyGated, 'triathlon', true);
    expect(out.canBike).toBe('no');
    expect(out.canSwim).toBeUndefined();
    expect(out.canUpperLoad).toBeUndefined();
    expect(out.canLowerLoad).toBeUndefined();
  });

  it('does not mutate the input state', () => {
    const input = makeInjury({ canSwim: 'no' });
    const before = JSON.stringify(input);
    clearStaleGatesForMode(input, 'running');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('clears ramp counters for disciplines no longer relevant to the new mode', () => {
    const input = makeInjury({
      returnRampWeeksLeft: { swim: 2, bike: 1, run: 2, stations: 2 },
    });
    const running = clearStaleGatesForMode(input, 'running');
    // Running mode keeps only run-ramp; bike/swim/stations cleared.
    expect(running.returnRampWeeksLeft).toEqual({ run: 2 });

    const tri = clearStaleGatesForMode(input, 'triathlon');
    expect(tri.returnRampWeeksLeft).toEqual({ swim: 2, bike: 1, run: 2 });

    const hyrox = clearStaleGatesForMode(input, 'hyrox');
    expect(hyrox.returnRampWeeksLeft).toEqual({ run: 2, stations: 2 });

    const cycling = clearStaleGatesForMode(input, 'triathlon', true);
    expect(cycling.returnRampWeeksLeft).toEqual({ bike: 1 });
  });

  it('returns undefined for returnRampWeeksLeft when every ramp got cleared', () => {
    const input = makeInjury({ returnRampWeeksLeft: { swim: 2 } });
    const running = clearStaleGatesForMode(input, 'running');
    expect(running.returnRampWeeksLeft).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getActivityGateLevel / isActivityAllowedForUser
// ---------------------------------------------------------------------------

describe('getActivityGateLevel', () => {
  it('returns "allow" for an activity with no protocol ban and no user gate', () => {
    const state = makeInjury({ type: 'general' });
    expect(getActivityGateLevel(state, 'rowing')).toBe('allow');
  });

  it('returns "block" when user gates the discipline as no', () => {
    const state = makeInjury({ type: 'general', canSwim: 'no' });
    expect(getActivityGateLevel(state, 'swimming')).toBe('block');
  });

  it('returns "limit" when user gates the discipline as limited', () => {
    const state = makeInjury({ type: 'general', canBike: 'limited' });
    expect(getActivityGateLevel(state, 'cycling')).toBe('limit');
  });

  it('protocol ban wins even when user gate would allow', () => {
    // IT band protocol bans cycling regardless of user opinion.
    const state = makeInjury({ type: 'it_band', canBike: 'yes' });
    expect(getActivityGateLevel(state, 'cycling')).toBe('block');
  });

  it('isActivityAllowedForUser is false only for block', () => {
    const state = makeInjury({ type: 'general', canSwim: 'limited' });
    expect(isActivityAllowedForUser(state, 'swimming')).toBe(true);
    const blocked = makeInjury({ type: 'general', canSwim: 'no' });
    expect(isActivityAllowedForUser(blocked, 'swimming')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Plan-engine integration. Verifies gates actually shape the generated plan.
// These call the public regenerateTriathlonWeek / regenerateHyroxWeek so the
// private apply*InjuryGates functions stay private without losing coverage.
// ---------------------------------------------------------------------------

import { regenerateTriathlonWeek } from '@/workouts/plan_engine.triathlon';
import { regenerateHyroxWeek } from '@/workouts/plan_engine.hyrox';
import type { SimulatorState, Week } from '@/types/state';

function makeBaseWeek(): Week {
  return {
    w: 1,
    ph: 'base',
    triWorkouts: [],
    rated: {},
    skip: [],
    cross: [],
    wkGain: 0,
    workoutMods: [],
    adjustments: [],
    unspentLoad: 0,
    extraRunLoad: 0,
  } as Week;
}

function makeTriStateWithInjury(injury: Partial<InjuryState>): SimulatorState {
  return {
    schemaVersion: 3,
    eventType: 'triathlon',
    w: 1,
    tw: 12,
    v: 0,
    iv: 0,
    rpeAdj: 0,
    expectedFinal: 0,
    rd: 'marathon',
    epw: 9,
    rw: 3,
    gs: 0,
    wkm: 0,
    pbs: {},
    rec: null,
    lt: null,
    vo2: null,
    initialLT: null,
    initialVO2: null,
    initialBaseline: null,
    currentFitness: null,
    forecastTime: null,
    typ: 'Balanced',
    b: 1.1,
    wks: Array.from({ length: 12 }, () => makeBaseWeek()),
    pac: { e: 300, t: 240, i: 220, m: 270, r: 180 },
    skip: [],
    timp: 0,
    triConfig: {
      distance: '70.3',
      timeAvailableHoursPerWeek: 10,
      volumeSplit: { swim: 0.175, bike: 0.475, run: 0.35 },
      skillRating: { swim: 3, bike: 3, run: 3 },
      bike: { hasPowerMeter: false },
      swim: { cssSecPer100m: 100 },
      weeksToRace: 12,
    },
    injuryState: makeInjury(injury),
  } as SimulatorState;
}

describe('applyTriInjuryGates via regenerateTriathlonWeek', () => {
  function disciplinesIn(week: Week): { swim: number; bike: number; run: number } {
    const wos = week.triWorkouts ?? [];
    return {
      swim: wos.filter(w => (w as any).discipline === 'swim').length,
      bike: wos.filter(w => (w as any).discipline === 'bike').length,
      run: wos.filter(w => (w as any).discipline === 'run').length,
    };
  }

  it('drops swim sessions when canSwim is "no"', () => {
    const s = makeTriStateWithInjury({ canSwim: 'no', canBike: 'yes', canRun: 'yes' });
    const week = regenerateTriathlonWeek(s, 1);
    expect(week).not.toBeNull();
    expect(disciplinesIn(week!).swim).toBe(0);
    // Bike + run still present
    expect(disciplinesIn(week!).bike).toBeGreaterThan(0);
    expect(disciplinesIn(week!).run).toBeGreaterThan(0);
  });

  it('scales bike duration when canBike="limited" via the legacy enum migration (50%)', () => {
    // Legacy enum → capacity migration: 'limited' maps to 50%, so each bike
    // session keeps its type and intensity but gets duration scaled to half.
    const s = makeTriStateWithInjury({ canSwim: 'yes', canBike: 'limited', canRun: 'yes' });
    const week = regenerateTriathlonWeek(s, 1);
    expect(week).not.toBeNull();
    const bikes = (week!.triWorkouts ?? []).filter(w => (w as any).discipline === 'bike');
    expect(bikes.length).toBeGreaterThan(0);
    // Each bike retains its original type (no longer collapsed to 'easy').
    for (const b of bikes) {
      expect(b.modReason).toMatch(/Capacity 50%/);
    }
  });

  it('drops brick when either leg is gated', () => {
    const s = makeTriStateWithInjury({ canBike: 'limited', canRun: 'yes', canSwim: 'yes' });
    const week = regenerateTriathlonWeek(s, 4);  // build phase. Brick eligible
    expect(week).not.toBeNull();
    const bricks = (week!.triWorkouts ?? []).filter(w => w.t === 'brick');
    expect(bricks).toHaveLength(0);
  });

  it('does not alter plan when injuryState is inactive', () => {
    const baseline = regenerateTriathlonWeek(makeTriStateWithInjury({ canSwim: 'yes', canBike: 'yes', canRun: 'yes' }), 1);
    const sInactive = makeTriStateWithInjury({ canSwim: 'no' });
    sInactive.injuryState!.active = false;
    const inactive = regenerateTriathlonWeek(sInactive, 1);
    expect(disciplinesIn(inactive!).swim).toBe(disciplinesIn(baseline!).swim);
  });

  it('restores a discipline once the week reaches its resume week', () => {
    // Swim blocked now (capacity 0), expected back in 2 weeks. State w=1.
    const s = makeTriStateWithInjury({
      swimCapacity: 0, bikeCapacity: 100, runCapacity: 100,
      resumeWeeksByDiscipline: { swim: 2 },
    });
    // Week 1 (weeksFromCurrent=0): still inside the window → no swim.
    expect(disciplinesIn(regenerateTriathlonWeek(s, 1)!).swim).toBe(0);
    // Week 2 (weeksFromCurrent=1): still inside the window → no swim.
    expect(disciplinesIn(regenerateTriathlonWeek(s, 2)!).swim).toBe(0);
    // Week 3 (weeksFromCurrent=2 ≥ 2): recovered → swim restored.
    expect(disciplinesIn(regenerateTriathlonWeek(s, 3)!).swim).toBeGreaterThan(0);
  });

  it('restores each discipline at its own resume week', () => {
    const s = makeTriStateWithInjury({
      swimCapacity: 0, runCapacity: 0, bikeCapacity: 100,
      resumeWeeksByDiscipline: { swim: 2, run: 5 },
    });
    // Week 3 (wfc=2): swim back, run still out.
    const wk3 = disciplinesIn(regenerateTriathlonWeek(s, 3)!);
    expect(wk3.swim).toBeGreaterThan(0);
    expect(wk3.run).toBe(0);
    // Week 6 (wfc=5): run back too.
    expect(disciplinesIn(regenerateTriathlonWeek(s, 6)!).run).toBeGreaterThan(0);
  });

  it('without a captured resume week, keeps the discipline frozen for all future weeks', () => {
    // Legacy / no-duration injury: conservative freeze (the pre-fix behaviour).
    const s = makeTriStateWithInjury({
      swimCapacity: 0, bikeCapacity: 100, runCapacity: 100,
      resumeWeeksByDiscipline: undefined,
    });
    expect(disciplinesIn(regenerateTriathlonWeek(s, 1)!).swim).toBe(0);
    expect(disciplinesIn(regenerateTriathlonWeek(s, 6)!).swim).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HYROX plan-engine integration
// ---------------------------------------------------------------------------

function makeHyroxStateWithInjury(injury: Partial<InjuryState>): SimulatorState {
  return {
    schemaVersion: 3,
    eventType: 'hyrox',
    w: 1,
    tw: 12,
    v: 0,
    iv: 0,
    rpeAdj: 0,
    expectedFinal: 0,
    rd: 'marathon',
    epw: 9,
    rw: 3,
    gs: 0,
    wkm: 0,
    pbs: {},
    rec: null,
    lt: null,
    vo2: null,
    initialLT: null,
    initialVO2: null,
    initialBaseline: null,
    currentFitness: null,
    forecastTime: null,
    typ: 'Balanced',
    b: 1.1,
    wks: Array.from({ length: 12 }, () => makeBaseWeek()),
    pac: { e: 300, t: 240, i: 220, m: 270, r: 180 },
    skip: [],
    timp: 0,
    hyroxConfig: {
      athleteBand: 'intermediate',
      weeklyHoursAvailable: 8,
      stationAccess: 'full_gym',
      raceDate: new Date(Date.now() + 12 * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      format: 'open',
      mtlCap: 60,
    } as any,
    injuryState: makeInjury(injury),
  } as SimulatorState;
}

describe('applyHyroxInjuryGates via regenerateHyroxWeek', () => {
  function countByPrefix(week: Week, prefix: string): number {
    return (week.triWorkouts ?? []).filter(w => (w.t || '').startsWith(prefix)).length;
  }

  it('drops all runs when canRun is "no"', () => {
    const s = makeHyroxStateWithInjury({ canRun: 'no', canUpperLoad: 'yes', canLowerLoad: 'yes' });
    const week = regenerateHyroxWeek(s, 1);
    expect(week).not.toBeNull();
    expect(countByPrefix(week!, 'hyrox_run_')).toBe(0);
  });

  it('drops stations when canUpperLoad is "no"', () => {
    const s = makeHyroxStateWithInjury({ canRun: 'yes', canUpperLoad: 'no', canLowerLoad: 'yes' });
    const week = regenerateHyroxWeek(s, 1);
    expect(week).not.toBeNull();
    const stationCount = countByPrefix(week!, 'hyrox_station_')
      + (week!.triWorkouts ?? []).filter(w => w.t === 'hyrox_assessment').length;
    expect(stationCount).toBe(0);
  });

  it('drops stations when canLowerLoad is "no"', () => {
    const s = makeHyroxStateWithInjury({ canRun: 'yes', canUpperLoad: 'yes', canLowerLoad: 'no' });
    const week = regenerateHyroxWeek(s, 1);
    expect(week).not.toBeNull();
    expect(countByPrefix(week!, 'hyrox_station_')).toBe(0);
  });

  it('drops bricks when any input leg is gated as "limited"', () => {
    const s = makeHyroxStateWithInjury({ canRun: 'limited', canUpperLoad: 'yes', canLowerLoad: 'yes' });
    const week = regenerateHyroxWeek(s, 6);
    expect(week).not.toBeNull();
    const brickCount = (week!.triWorkouts ?? []).filter(w => w.t === 'hyrox_brick' || w.t === 'hyrox_mini_brick').length;
    expect(brickCount).toBe(0);
  });

  it('does not alter plan when injuryState is inactive', () => {
    const baseline = regenerateHyroxWeek(makeHyroxStateWithInjury({ canRun: 'yes', canUpperLoad: 'yes', canLowerLoad: 'yes' }), 1);
    const sInactive = makeHyroxStateWithInjury({ canRun: 'no' });
    sInactive.injuryState!.active = false;
    const inactive = regenerateHyroxWeek(sInactive, 1);
    expect(countByPrefix(inactive!, 'hyrox_run_')).toBe(countByPrefix(baseline!, 'hyrox_run_'));
  });
});

// ---------------------------------------------------------------------------
// Capacity-slider scaling. Replaces the prior return-ramp tests (the ramp
// was removed; the slider IS the gradient now).
// ---------------------------------------------------------------------------

describe('Capacity-slider scaling in tri plan engine', () => {
  it('drops a discipline when its capacity is 0', () => {
    const s = makeTriStateWithInjury({ runCapacity: 100, bikeCapacity: 100, swimCapacity: 0 });
    s.w = 6;
    const week = regenerateTriathlonWeek(s, 6);
    expect(week).not.toBeNull();
    const swims = (week!.triWorkouts ?? []).filter(w => (w as any).discipline === 'swim');
    expect(swims).toHaveLength(0);
  });

  it('leaves a discipline untouched at capacity 100', () => {
    const s = makeTriStateWithInjury({ runCapacity: 100, bikeCapacity: 100, swimCapacity: 100 });
    s.w = 6;
    const week = regenerateTriathlonWeek(s, 6);
    expect(week).not.toBeNull();
    const bikes = (week!.triWorkouts ?? []).filter(w => (w as any).discipline === 'bike');
    // No modReason from capacity scaling on a 100% discipline.
    expect(bikes.every(b => !(b.modReason ?? '').includes('Capacity'))).toBe(true);
  });

  it('scales bike durations to roughly capacity/100 of baseline (no intensity change)', () => {
    // Baseline at 100%
    const sFull = makeTriStateWithInjury({ runCapacity: 100, bikeCapacity: 100, swimCapacity: 100 });
    sFull.w = 6;
    const baselineWeek = regenerateTriathlonWeek(sFull, 6);
    const baselineBikes = (baselineWeek!.triWorkouts ?? []).filter(w => (w as any).discipline === 'bike');

    // Scaled at 60%
    const sScaled = makeTriStateWithInjury({ runCapacity: 100, bikeCapacity: 60, swimCapacity: 100 });
    sScaled.w = 6;
    const scaledWeek = regenerateTriathlonWeek(sScaled, 6);
    const scaledBikes = (scaledWeek!.triWorkouts ?? []).filter(w => (w as any).discipline === 'bike');

    // Aggregate duration: scaled should be well below baseline. Don't require
    // identical session count. The downstream scheduler may drop a session
    // whose scaled duration no longer fits its per-day minute cap.
    const baselineTotalMin = baselineBikes.reduce((acc, b: any) => acc + (b.estimatedDurationMin ?? 0), 0);
    const scaledTotalMin = scaledBikes.reduce((acc, b: any) => acc + (b.estimatedDurationMin ?? 0), 0);
    expect(scaledTotalMin).toBeLessThan(baselineTotalMin);

    // Every scaled bike has the capacity modReason; type prefix preserved.
    for (const b of scaledBikes) {
      const a = b as any;
      expect((a.modReason ?? '')).toMatch(/Capacity 60%/);
      expect((a.t ?? '')).toMatch(/^bike_/);  // type prefix preserved
    }
  });

  it('scales TSS load fields proportionally with duration', () => {
    const sFull = makeTriStateWithInjury({ runCapacity: 100, bikeCapacity: 100, swimCapacity: 100 });
    sFull.w = 6;
    const baselineWeek = regenerateTriathlonWeek(sFull, 6);
    const baselineBikes = (baselineWeek!.triWorkouts ?? []).filter(w => (w as any).discipline === 'bike');

    const sScaled = makeTriStateWithInjury({ runCapacity: 100, bikeCapacity: 50, swimCapacity: 100 });
    sScaled.w = 6;
    const scaledWeek = regenerateTriathlonWeek(sScaled, 6);
    const scaledBikes = (scaledWeek!.triWorkouts ?? []).filter(w => (w as any).discipline === 'bike');

    const baseTotal = baselineBikes.reduce((acc, b: any) => acc + (b.aerobic ?? 0), 0);
    const scaledTotal = scaledBikes.reduce((acc, b: any) => acc + (b.aerobic ?? 0), 0);
    // Scaled aggregate aerobic must be lower. ACWR / weekly TSS / ATL all
    // depend on this; a hard-session staying hard-TSS would mask the cap.
    expect(scaledTotal).toBeLessThan(baseTotal);
  });

  it('drops the brick when either bike or run capacity is below 100', () => {
    const s = makeTriStateWithInjury({ runCapacity: 100, bikeCapacity: 80, swimCapacity: 100 });
    s.w = 6;
    const week = regenerateTriathlonWeek(s, 6);  // build phase. Brick eligible at 100%
    expect(week).not.toBeNull();
    const bricks = (week!.triWorkouts ?? []).filter(w => w.t === 'brick');
    expect(bricks).toHaveLength(0);
  });

  it('keeps the brick at full capacity across all legs', () => {
    const s = makeTriStateWithInjury({ runCapacity: 100, bikeCapacity: 100, swimCapacity: 100 });
    s.w = 6;
    const week = regenerateTriathlonWeek(s, 6);
    expect(week).not.toBeNull();
    // Brick may or may not be generated depending on phase mechanics. But if
    // an injury is active and all caps are 100, the injury filter must NOT
    // strip a brick that was otherwise generated. Look for an unmodified one.
    const bricks = (week!.triWorkouts ?? []).filter(w => w.t === 'brick');
    for (const b of bricks) {
      expect((b.modReason ?? '')).not.toMatch(/Capacity/);
    }
  });

  it('legacy enum value "limited" migrates to 50% capacity (duration scaled by half)', () => {
    const s = makeTriStateWithInjury({ canSwim: 'yes', canBike: 'limited', canRun: 'yes' });
    s.w = 6;
    const week = regenerateTriathlonWeek(s, 6);
    expect(week).not.toBeNull();
    const bikes = (week!.triWorkouts ?? []).filter(w => (w as any).discipline === 'bike');
    expect(bikes.length).toBeGreaterThan(0);
    for (const b of bikes) {
      expect(b.modReason).toMatch(/Capacity 50%/);
    }
  });
});

describe('Capacity-slider scaling in HYROX plan engine', () => {
  function countByPrefix(week: Week, prefix: string): number {
    return (week.triWorkouts ?? []).filter(w => (w.t || '').startsWith(prefix)).length;
  }

  it('scales run durations when runCapacity < 100', () => {
    const s = makeHyroxStateWithInjury({ runCapacity: 50, upperLoadCapacity: 100, lowerLoadCapacity: 100 });
    s.w = 6;
    const week = regenerateHyroxWeek(s, 6);
    expect(week).not.toBeNull();
    const runs = (week!.triWorkouts ?? []).filter(w => (w.t || '').startsWith('hyrox_run_'));
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      expect((r.modReason ?? '')).toMatch(/Capacity 50%/);
    }
  });

  it('takes the MIN of upperLoad and lowerLoad for station capacity', () => {
    // upper=80, lower=20 → stations should scale to 20% (the more restrictive).
    const s = makeHyroxStateWithInjury({ runCapacity: 100, upperLoadCapacity: 80, lowerLoadCapacity: 20 });
    s.w = 6;
    const week = regenerateHyroxWeek(s, 6);
    const stations = (week!.triWorkouts ?? []).filter(w => (w.t || '').startsWith('hyrox_station_'));
    for (const st of stations) {
      expect((st.modReason ?? '')).toMatch(/Lower-body capacity 20%/);
    }
  });

  it('drops stations when either load capacity is 0', () => {
    const s = makeHyroxStateWithInjury({ runCapacity: 100, upperLoadCapacity: 0, lowerLoadCapacity: 100 });
    s.w = 6;
    const week = regenerateHyroxWeek(s, 6);
    expect(countByPrefix(week!, 'hyrox_station_')).toBe(0);
  });

  it('drops bricks when ANY constituent is below 100', () => {
    const s = makeHyroxStateWithInjury({ runCapacity: 100, upperLoadCapacity: 100, lowerLoadCapacity: 80 });
    s.w = 6;
    const week = regenerateHyroxWeek(s, 6);
    const brickCount = (week!.triWorkouts ?? []).filter(w => w.t === 'hyrox_brick' || w.t === 'hyrox_mini_brick').length;
    expect(brickCount).toBe(0);
  });

  it('legacy enum "limited" migrates to 50% (via canRun)', () => {
    const s = makeHyroxStateWithInjury({ canRun: 'limited', canUpperLoad: 'yes', canLowerLoad: 'yes' });
    s.w = 6;
    const week = regenerateHyroxWeek(s, 6);
    const runs = (week!.triWorkouts ?? []).filter(w => (w.t || '').startsWith('hyrox_run_'));
    for (const r of runs) {
      expect((r.modReason ?? '')).toMatch(/Capacity 50%/);
    }
  });
});

// ---------------------------------------------------------------------------
// Past-week protection. A current injury must NEVER rewrite past weeks.
// Regression coverage for the 2026-05-26 bug where main.ts's version-bump
// regen rewrote every past triWorkouts entry to "Complete Rest" because the
// phase-replacement guard checked injury.active without checking weekIndex.
// ---------------------------------------------------------------------------

import { generateTriathlonPlan } from '@/workouts/plan_engine.triathlon';
import { generateHyroxPlan } from '@/workouts/plan_engine.hyrox';

describe('Past-week protection from current-injury rewrites (tri)', () => {
  it('past weeks ignore discipline gates entirely (canSwim no does not retroactively drop swims)', () => {
    const sNoInjury = makeTriStateWithInjury({ canRun: 'yes', canBike: 'yes', canSwim: 'yes' });
    sNoInjury.injuryState!.active = false;
    sNoInjury.w = 6;
    const baseline = generateTriathlonPlan(sNoInjury);

    const sInjured = makeTriStateWithInjury({ canRun: 'yes', canBike: 'yes', canSwim: 'no' });
    sInjured.w = 6;
    const injured = generateTriathlonPlan(sInjured);

    // Past week 1: swim counts should match the baseline (injury has no effect).
    const baselineSwim = (baseline[0].triWorkouts ?? []).filter(w => (w as any).discipline === 'swim').length;
    const injuredSwim = (injured[0].triWorkouts ?? []).filter(w => (w as any).discipline === 'swim').length;
    expect(injuredSwim).toBe(baselineSwim);

    // Future week 8: swim must be dropped (injury IS active for future).
    const futureInjuredSwim = (injured[7].triWorkouts ?? []).filter(w => (w as any).discipline === 'swim').length;
    expect(futureInjuredSwim).toBe(0);
  });

  it('current week respects gates without blanket-rest replacement (canBike=yes during acute keeps bike)', () => {
    // Critical regression: previously the acute injuryPhase wiped every
    // discipline with "Complete Rest" cards, ignoring the user's gate
    // answers. A shoulder injury at pain 8 should NOT stop the user from
    // biking when they answered canBike='yes'.
    const s = makeTriStateWithInjury({
      canRun: 'yes', canBike: 'yes', canSwim: 'no',
      injuryPhase: 'acute',  // would have triggered blanket rest under B1
    });
    s.w = 6;
    const weeks = generateTriathlonPlan(s);
    const ws = weeks[5].triWorkouts ?? [];

    // Bike sessions present, swim sessions absent. Gates drive the plan.
    const bikes = ws.filter(w => (w as any).discipline === 'bike').length;
    const swims = ws.filter(w => (w as any).discipline === 'swim').length;
    expect(bikes).toBeGreaterThan(0);
    expect(swims).toBe(0);

    // No phase-replacement rest cards spread across every day.
    const allRest = ws.length > 0 && ws.every(w => w.t === 'rest');
    expect(allRest).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Location-aware capacity tests. Session 3 work
// ---------------------------------------------------------------------------

describe('getRequiredCapacityTests', () => {
  it('lower-body locations get the legacy pain_free_walk + single_leg_hop pair', () => {
    for (const loc of ['foot', 'knee', 'calf', 'hamstring', 'hip'] as const) {
      expect(getRequiredCapacityTests(loc)).toEqual(['pain_free_walk', 'single_leg_hop']);
    }
  });

  it('upper-body shoulder / upper_arm get shoulder_rotation + isometric_hold', () => {
    expect(getRequiredCapacityTests('shoulder')).toEqual(['shoulder_rotation', 'isometric_hold']);
    expect(getRequiredCapacityTests('upper_arm')).toEqual(['shoulder_rotation', 'isometric_hold']);
  });

  it('elbow / forearm / wrist get grip_strength + isometric_hold', () => {
    for (const loc of ['elbow', 'forearm', 'wrist'] as const) {
      expect(getRequiredCapacityTests(loc)).toEqual(['grip_strength', 'isometric_hold']);
    }
  });

  it('neck gets pain_free_rotation + isometric_hold', () => {
    expect(getRequiredCapacityTests('neck')).toEqual(['pain_free_rotation', 'isometric_hold']);
  });

  it('chest_ribs gets deep_breath + pain_free_rotation', () => {
    expect(getRequiredCapacityTests('chest_ribs')).toEqual(['deep_breath', 'pain_free_rotation']);
  });

  it('back gets pain_free_walk + isometric_hold (no hop impact)', () => {
    expect(getRequiredCapacityTests('back')).toEqual(['pain_free_walk', 'isometric_hold']);
  });

  it('other falls back to pain_free_walk alone', () => {
    expect(getRequiredCapacityTests('other')).toEqual(['pain_free_walk']);
  });
});

describe('hasPassedRequiredCapacityTests uses location-aware tests', () => {
  it('shoulder injury cleared by shoulder_rotation + isometric_hold (not leg tests)', () => {
    const state = makeInjury({
      location: 'shoulder',
      capacityTestsPassed: ['shoulder_rotation', 'isometric_hold'],
    });
    expect(hasPassedRequiredCapacityTests(state)).toBe(true);
  });

  it('shoulder injury NOT cleared by leg tests', () => {
    const state = makeInjury({
      location: 'shoulder',
      capacityTestsPassed: ['pain_free_walk', 'single_leg_hop'],
    });
    expect(hasPassedRequiredCapacityTests(state)).toBe(false);
  });

  it('knee injury cleared by the original leg tests', () => {
    const state = makeInjury({
      location: 'knee',
      capacityTestsPassed: ['pain_free_walk', 'single_leg_hop'],
    });
    expect(hasPassedRequiredCapacityTests(state)).toBe(true);
  });
});

describe('generateCapacityTestSession emits location-appropriate tests', () => {
  it('shoulder injury surfaces shoulder ROM + isometric tests, not leg hops', () => {
    const state = makeInjury({
      location: 'shoulder',
      injuryPhase: 'test_capacity',
      capacityTestsPassed: [],
    });
    const sessions = generateCapacityTestSession(state);
    const names = sessions.map(s => s.n);
    expect(names).toContain('Shoulder ROM Test');
    expect(names).toContain('Isometric Hold Test');
    expect(names).not.toContain('Single Leg Hop Test');
    expect(names).not.toContain('30-Minute Walk Test');
  });

  it('wrist injury surfaces grip + isometric tests', () => {
    const state = makeInjury({
      location: 'wrist',
      injuryPhase: 'test_capacity',
      capacityTestsPassed: [],
    });
    const sessions = generateCapacityTestSession(state);
    const names = sessions.map(s => s.n);
    expect(names).toContain('Grip Strength Test');
    expect(names).toContain('Isometric Hold Test');
  });

  it('chest_ribs surfaces deep breath + rotation tests', () => {
    const state = makeInjury({
      location: 'chest_ribs',
      injuryPhase: 'test_capacity',
      capacityTestsPassed: [],
    });
    const sessions = generateCapacityTestSession(state);
    const names = sessions.map(s => s.n);
    expect(names).toContain('Deep Breath Test');
    expect(names).toContain('Rotation Test');
  });

  it('returns no test cards when all required tests already passed', () => {
    const state = makeInjury({
      location: 'shoulder',
      injuryPhase: 'test_capacity',
      capacityTestsPassed: ['shoulder_rotation', 'isometric_hold'],
    });
    expect(generateCapacityTestSession(state)).toHaveLength(0);
  });
});

describe('Phase progression fast-track is lower-body-only', () => {
  it('lower-body injury with canRun=yes + pain ≤ 1 fast-tracks past capacity tests', () => {
    const state = makeInjury({
      location: 'knee',
      injuryPhase: 'test_capacity',
      canRun: 'yes',
      currentPain: 1,
      capacityTestsPassed: [],
    });
    const next = evaluatePhaseTransition(state);
    // Should have progressed past test_capacity (to return_to_run).
    expect(next.injuryPhase).not.toBe('test_capacity');
  });

  it('upper-body injury cannot fast-track via canRun (running tells us nothing about a shoulder)', () => {
    const state = makeInjury({
      location: 'shoulder',
      injuryPhase: 'test_capacity',
      canRun: 'yes',
      currentPain: 1,
      capacityTestsPassed: [],
    });
    const next = evaluatePhaseTransition(state);
    // Must still be in test_capacity. Tests haven't been done.
    expect(next.injuryPhase).toBe('test_capacity');
  });

  it('upper-body injury progresses when shoulder-specific tests pass', () => {
    const state = makeInjury({
      location: 'shoulder',
      injuryPhase: 'test_capacity',
      capacityTestsPassed: ['shoulder_rotation', 'isometric_hold'],
    });
    const next = evaluatePhaseTransition(state);
    expect(next.injuryPhase).not.toBe('test_capacity');
  });
});

describe('Past-week protection from current-injury rewrites (HYROX)', () => {
  it('past weeks reflect original plan even with an active injury (no retroactive gate filtering)', () => {
    const sNoInjury = makeHyroxStateWithInjury({ canRun: 'yes', canUpperLoad: 'yes', canLowerLoad: 'yes' });
    sNoInjury.injuryState!.active = false;
    sNoInjury.w = 6;
    const baseline = generateHyroxPlan(sNoInjury);

    const sInjured = makeHyroxStateWithInjury({ canRun: 'no', canUpperLoad: 'yes', canLowerLoad: 'yes' });
    sInjured.w = 6;
    const injured = generateHyroxPlan(sInjured);

    // Past week 1: run counts must match baseline (current injury cannot
    // rewrite historic prescription).
    const baselineRuns = (baseline[0].triWorkouts ?? []).filter(w => (w.t || '').startsWith('hyrox_run_')).length;
    const injuredRuns = (injured[0].triWorkouts ?? []).filter(w => (w.t || '').startsWith('hyrox_run_')).length;
    expect(injuredRuns).toBe(baselineRuns);

    // Future week 8: runs dropped (canRun='no' takes effect for future).
    const futureRuns = (injured[7].triWorkouts ?? []).filter(w => (w.t || '').startsWith('hyrox_run_')).length;
    expect(futureRuns).toBe(0);
  });
});
