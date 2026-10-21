/**
 * Tests for the canonical mode-aware planned-day TSS context.
 * This is the single source for the daily strain target across Home / Strain /
 * Readiness / daily-coach. Regression guard for the 2026-06-03 bug where every
 * surface regenerated a phantom RUNNING week in tri/cycling/HYROX mode.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getPlannedDayTSSContext } from './planned-day-tss';
import { isHighIntensity as isHyroxHardSession } from '@/workouts/scheduler.hyrox';
import { reconcileTriCompletions } from '@/calculations/activity-matcher.triathlon';
import { resolveWeekWorkouts } from './week-resolve';
import { computePlannedDaySignalBTSS } from '@/calculations/fitness-model';
import { TL_PER_MIN } from '@/constants';
import { setState, resetState, getDefaultState } from '@/state/store';
import { createDefaultInjuryState } from '@/types/injury';
import type { SimulatorState } from '@/types/state';

function triState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    ...getDefaultState(),
    eventType: 'triathlon',
    w: 1,
    tw: 12,
    wks: [{
      ph: 'base',
      triWorkouts: [
        { id: 'W1-bike-0', n: 'Endurance ride', t: 'bike_endurance', d: '60min Z2', r: 4, discipline: 'bike', dayOfWeek: 3, aerobic: 40, anaerobic: 10, estimatedDurationMin: 60 },
        { id: 'W1-swim-0', n: 'Technique swim', t: 'swim_technique', d: '45min drills', r: 3, discipline: 'swim', dayOfWeek: 1, aerobic: 25, anaerobic: 0, estimatedDurationMin: 45 },
      ],
      adhocWorkouts: [],
      rated: {},
    }],
    ...overrides,
  } as unknown as SimulatorState;
}

describe('getPlannedDayTSSContext — triathlon/cycling', () => {
  it('sums aerobic + anaerobic by dayOfWeek (matches the plan card badge)', () => {
    const ctx = getPlannedDayTSSContext(triState(), 1);
    expect(ctx.plannedTSSForDay(3)).toBe(50);  // 40 + 10
    expect(ctx.plannedTSSForDay(1)).toBe(25);
    expect(ctx.plannedTSSForDay(2)).toBe(0);   // rest day → no phantom run target
    expect(ctx.plannedWeekTSS).toBe(75);
    expect(ctx.trainingDayCount).toBe(2);
    expect(ctx.perSessionAvg).toBeCloseTo(37.5);
  });

  it('adhoc session without aerobic/anaerobic uses duration × TL_PER_MIN[rpe]', () => {
    const s = triState();
    (s.wks![0] as any).adhocWorkouts = [
      { id: 'adhoc-1', n: 'Strength', t: 'strength', d: '40min', r: 5, discipline: 'strength', dayOfWeek: 4, estimatedDurationMin: 40 },
    ];
    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedTSSForDay(4)).toBe(Math.round(40 * TL_PER_MIN[5]));
  });

  it('synced actuals (garmin-/strava-/garminTimestamp) are history, not plan', () => {
    const s = triState();
    (s.wks![0] as any).adhocWorkouts = [
      { id: 'garmin-99', n: 'Indoor Cycling', t: 'cross', d: '56min', r: 6, dayOfWeek: 2, garminTimestamp: '2026-06-03T18:52:00Z', estimatedDurationMin: 56 },
    ];
    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedTSSForDay(2)).toBe(0);
  });

  it('illness-rested sessions do not count toward the target', () => {
    const s = triState({ illnessState: { active: true, severity: 'resting', startDate: '2026-06-01' } } as any);
    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedTSSForDay(3)).toBe(0);
    expect(ctx.plannedWeekTSS).toBe(0);
  });

  it('hardness uses the shared kind vocabulary across discipline prefixes', () => {
    const s = triState();
    (s.wks![0].triWorkouts as any[])[0].t = 'bike_threshold';
    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.workoutsForDay(3)[0].isHard).toBe(true);    // bike_threshold
    expect(ctx.workoutsForDay(1)[0].isHard).toBe(false);   // swim_technique
  });

  it('a day-shifted matched workout moves its expected strain to the actual day', () => {
    // Thursday's 50-TSS ride is recorded on Wednesday and matched to the slot.
    // reconcileTriCompletions slides the workout to Wednesday; the day target
    // must follow: Wed expects the ride's planned TSS, Thu drops to rest.
    const s = triState();
    const wk = s.wks![0] as any;
    wk.garminActuals = {
      'W1-bike-0': { garminId: 'strava-42', startTime: '2026-06-03T18:52:00Z', durationSec: 3360, distanceKm: 20 }, // a Wednesday
    };
    reconcileTriCompletions(wk);

    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedTSSForDay(2)).toBe(50); // Wed: the matched ride's planned TSS
    expect(ctx.plannedTSSForDay(3)).toBe(0);  // Thu: nothing left planned
  });
});

describe('getPlannedDayTSSContext — HYROX', () => {
  it('MTL-only workouts fall back to duration × TL_PER_MIN[rpe]', () => {
    const s = triState({
      eventType: 'hyrox',
      wks: [{
        ph: 'base',
        triWorkouts: [
          { id: 'W1-station-0', n: 'Station circuit', t: 'station', d: '45min circuit', r: 7, discipline: 'station', dayOfWeek: 2, musculoTendonLoad: 120, estimatedDurationMin: 45 },
        ],
        adhocWorkouts: [],
        rated: {},
      }],
    } as any);
    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedTSSForDay(2)).toBe(Math.round(45 * TL_PER_MIN[7])); // 80
    expect(ctx.plannedTSSForDay(3)).toBe(0);
  });
});

describe('getPlannedDayTSSContext — hardness in the stored-plan modes (ISSUE-406 (b))', () => {
  // Each mode's own classifier: HYROX isHighIntensity (scheduler.hyrox.ts),
  // triathlon / cycling isTriQualitySession (tri-suggestion-apply.ts). The
  // running token check alone called a HYROX Tempo Run, a station density
  // session and a brick easy.
  function weekOf(eventType: 'hyrox' | 'triathlon', sessions: Array<Record<string, unknown>>): SimulatorState {
    return triState({
      eventType,
      wks: [{
        ph: 'build',
        triWorkouts: sessions.map((w, i) => ({ id: `W1-${i}`, n: String(w.t), d: '50min', r: 6, estimatedDurationMin: 50, dayOfWeek: i, ...w })),
        adhocWorkouts: [],
        rated: {},
      }],
    } as any);
  }
  const hardByType = (s: SimulatorState) => {
    const ctx = getPlannedDayTSSContext(s, 1);
    const out: Record<string, boolean> = {};
    for (let d = 0; d < 7; d++) for (const w of ctx.workoutsForDay(d)) out[`${w.type}${w.name.includes('light') ? ' (light)' : ''}`] = w.isHard;
    return out;
  };

  it('HYROX: tempo and interval runs, station density, bricks and the long run are hard; easy work is not', () => {
    const s = weekOf('hyrox', [
      { t: 'hyrox_run_tempo', discipline: 'run' },
      { t: 'hyrox_run_intervals', discipline: 'run' },
      { t: 'hyrox_station_density', discipline: 'station' },
      { t: 'hyrox_brick', discipline: 'brick' },
      { t: 'hyrox_mini_brick', discipline: 'brick' },
      { t: 'hyrox_run_easy', discipline: 'run', longRun: true },
      { t: 'hyrox_station_technique', discipline: 'station' },
    ]);
    expect(hardByType(s)).toEqual({
      hyrox_run_tempo: true,
      hyrox_run_intervals: true,
      hyrox_station_density: true,
      hyrox_brick: true,
      hyrox_mini_brick: true,
      // The long run, as running's and triathlon's 'long' (D13).
      hyrox_run_easy: true,
      hyrox_station_technique: false,
    });
  });

  it('HYROX: only the long-run stamp makes an easy run hard; the scheduler\'s spacing set is unchanged', () => {
    const s = weekOf('hyrox', [
      { t: 'hyrox_run_easy', discipline: 'run', longRun: true },
      { t: 'hyrox_run_easy', discipline: 'run' },
    ]);
    const ctx = getPlannedDayTSSContext(s, 1);
    expect([0, 1].map(d => ctx.workoutsForDay(d)[0].isHard)).toEqual([true, false]);
    expect(isHyroxHardSession({ t: 'hyrox_run_easy', longRun: true } as any)).toBe(false);
  });

  it('HYROX: the light secondary brick and easy erg work are not hard (the scheduler\'s own set)', () => {
    const s = weekOf('hyrox', [
      { t: 'hyrox_mini_brick', n: 'Mini brick light', discipline: 'brick', hyroxLight: true },
      { t: 'hyrox_erg_easy', discipline: 'erg' },
      { t: 'hyrox_run_easy', discipline: 'run' },
    ]);
    const ctx = getPlannedDayTSSContext(s, 1);
    expect([0, 1, 2].map(d => ctx.workoutsForDay(d)[0].isHard)).toEqual([false, false, false]);
  });

  it('triathlon / cycling: brick, sweet spot, over-under, tempo and hills are hard; endurance is not', () => {
    const s = weekOf('triathlon', [
      { t: 'brick', discipline: 'bike' },
      { t: 'bike_sweet_spot', discipline: 'bike' },
      { t: 'bike_over_under', discipline: 'bike' },
      { t: 'tempo', discipline: 'run' },
      { t: 'bike_hills', discipline: 'bike' },
      { t: 'bike_endurance', discipline: 'bike' },
      { t: 'swim_technique', discipline: 'swim' },
    ]);
    expect(hardByType(s)).toEqual({
      brick: true,
      bike_sweet_spot: true,
      bike_over_under: true,
      tempo: true,
      bike_hills: true,
      bike_endurance: false,
      swim_technique: false,
    });
  });

  it('the running token check still applies on top (a threshold run stays hard)', () => {
    const s = weekOf('hyrox', [{ t: 'threshold', discipline: 'run' }]);
    expect(getPlannedDayTSSContext(s, 1).workoutsForDay(0)[0].isHard).toBe(true);
  });
});

describe('getPlannedDayTSSContext — just-track / empty', () => {
  it('trackOnly returns zeros (no plan, no phantom targets)', () => {
    const s = triState({ trackOnly: true } as any);
    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedWeekTSS).toBe(0);
    expect(ctx.plannedTSSForDay(3)).toBe(0);
    expect(ctx.perSessionAvg).toBe(0);
    expect(ctx.trainingDayCount).toBe(4); // historical || 4 floor
  });

  it('missing week returns zeros', () => {
    const ctx = getPlannedDayTSSContext(triState(), 9);
    expect(ctx.plannedWeekTSS).toBe(0);
  });
});

describe('getPlannedDayTSSContext — running', () => {
  beforeEach(() => resetState());

  function runningState(): SimulatorState {
    const s = {
      ...getDefaultState(),
      eventType: 'running',
      w: 1,
      tw: 18,
      rw: 3,
      rd: 'marathon',
      typ: 'balanced',
      v: 40,
      gs: 0,
      pac: { e: 330 },
      wks: [{ ph: 'base', rated: {}, skip: [] }],
    } as unknown as SimulatorState;
    return s;
  }

  it('delegates to the canonical Plan-tab resolver (resolveWeekWorkouts)', () => {
    const s = runningState();
    setState(s);
    const ctx = getPlannedDayTSSContext(s, 1);
    const resolved = resolveWeekWorkouts(s, 1).filter((w: any) => w.t !== 'cross');
    const baseMinPerKm = 330 / 60;
    for (let day = 0; day < 7; day++) {
      const expected = resolved
        .filter((w: any) => w.dayOfWeek === day)
        .reduce((sum: number, w: any) => sum + computePlannedDaySignalBTSS([w], day, baseMinPerKm), 0);
      expect(ctx.plannedTSSForDay(day)).toBe(expected);
    }
    expect(ctx.plannedWeekTSS).toBeGreaterThan(0);
  });

  it('an active acute injury collapses the rendered week and zeroes the strain target (ISSUE-261)', () => {
    const s = runningState();
    (s as any).injuryState = {
      ...createDefaultInjuryState(),
      active: true,
      injuryPhase: 'acute',
      startDate: new Date().toISOString(),
      acutePhaseStartDate: new Date().toISOString(),
      currentPain: 6,
    };
    setState(s);
    // The canonical resolver now renders the injury-adapted week (relative-rest
    // model: rest the injured area + region-safe strength), not the healthy plan.
    const resolved = resolveWeekWorkouts(s, 1);
    expect(resolved.some((w: any) => (w.n || '').toLowerCase().includes('rest'))).toBe(true);
    expect(resolved.some((w: any) => (w.t || '') === 'long' || (w.t || '') === 'intervals')).toBe(false);
    // … and the strain target follows: far below the healthy week's load.
    const healthy = { ...runningState() };
    setState(healthy);
    const healthyWeekTSS = getPlannedDayTSSContext(healthy, 1).plannedWeekTSS;
    setState(s);
    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedWeekTSS).toBeLessThan(healthyWeekTSS / 2);
  });

  it('reflects workoutMoves (drag-and-drop day changes)', () => {
    const s = runningState();
    setState(s);
    const baseline = getPlannedDayTSSContext(s, 1);
    // Find a day with planned TSS and an empty day to move everything to.
    const sourceDay = [0, 1, 2, 3, 4, 5, 6].find(d => baseline.plannedTSSForDay(d) > 0)!;
    const targetDay = [0, 1, 2, 3, 4, 5, 6].find(d => baseline.plannedTSSForDay(d) === 0)!;
    const moved = resolveWeekWorkouts(s, 1).find((w: any) => w.dayOfWeek === sourceDay)!;
    (s.wks![0] as any).workoutMoves = { [(moved as any).id || (moved as any).n]: targetDay };
    setState(s);
    const ctx = getPlannedDayTSSContext(s, 1);
    expect(ctx.plannedTSSForDay(targetDay)).toBeGreaterThan(0);
  });
});
