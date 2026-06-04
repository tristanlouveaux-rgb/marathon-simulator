/**
 * Tests for the canonical mode-aware planned-day TSS context.
 * This is the single source for the daily strain target across Home / Strain /
 * Readiness / daily-coach. Regression guard for the 2026-06-03 bug where every
 * surface regenerated a phantom RUNNING week in tri/cycling/HYROX mode.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getPlannedDayTSSContext } from './planned-day-tss';
import { reconcileTriCompletions } from '@/calculations/activity-matcher.triathlon';
import { resolveWeekWorkouts } from './week-resolve';
import { computePlannedDaySignalBTSS } from '@/calculations/fitness-model';
import { TL_PER_MIN } from '@/constants';
import { setState, resetState, getDefaultState } from '@/state/store';
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
