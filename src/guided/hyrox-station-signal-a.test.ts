/**
 * A HYROX station session recorded in the app weighs the same in Signal A as
 * the same session synced as a HIIT workout: the strength runSpec (decision
 * 2026-10-06, SPORTS_DB strength runSpec 0.35).
 *
 * Before: the in-app record's activityType 'hyrox' is no device type, so
 * resolveActualSport fell through to generic_sport (runSpec 0.40), while the
 * watch HIIT copy of the same session resolved to strength (0.35, the gym
 * bucket). Running-specific load then depended on which copy held the slot.
 *
 * Real completeStrengthSession (quick done) on a generated station session;
 * rate() and saveState are stubbed. Signal B carries no runSpec and is
 * unchanged.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/ui/events', async () => {
  const { getMutableState } = await import('@/state/store');
  return {
    rate: (id: string, _n: string, rpe: number, _e: number, _t: string, _skip: boolean, _hr?: number, targetWeek?: number) => {
      const s = getMutableState();
      s.wks[(targetWeek ?? s.w) - 1].rated[id] = rpe;
    },
  };
});
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));
vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { completeStrengthSession } from './strength-complete';
import { generateHyroxStation } from '@/workouts/hyrox-generators';
import { listWeekSignalAEntries, computeWeekTSS, computeWeekRawTSS } from '@/calculations/fitness-model';
import { resolveActualSport, IN_APP_HYROX_ACTIVITY_TYPE } from '@/cross-training/activities';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';
import type { Week, Workout } from '@/types';

const ACCESS = { sled: 'always' as const, skiErg: true, rowErg: true };
const SLOT = 'W1-hyrox_station_density-0';

function week(w = 1): Week {
  return {
    w, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  } as unknown as Week;
}

function stationWorkout(): Workout {
  const station = generateHyroxStation({
    kind: 'station_density', targetMinutes: 55, band: 'intermediate',
    stationAccess: ACCESS, phase: 'build', slotIndex: 0,
  }) as Workout;
  return { ...station, id: SLOT, dayOfWeek: 2 } as Workout;
}

describe('HYROX station recorded in the app: strength weight in Signal A', () => {
  it('a quick-done station resolves to strength and counts at the strength runSpec', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = getDefaultState();
    s.eventType = 'hyrox';
    s.planStartDate = '2026-09-28';
    s.w = 1;
    s.wks = [week()];
    setState(s);
    const workout = stationWorkout();

    completeStrengthSession(workout);

    const wk = getMutableState().wks[0];
    const rpe = wk.rated[SLOT] as number;
    const durMin = workout.estimatedDurationMin!;
    expect(wk.garminActuals![SLOT].activityType).toBe(IN_APP_HYROX_ACTIVITY_TYPE);

    const entry = listWeekSignalAEntries(wk, wk.rated).find(e => e.key === SLOT)!;
    expect(entry.sport).toBe('strength'); // was generic_sport
    const raw = durMin * TL_PER_MIN[Math.round(rpe)];
    expect(entry.tss).toBeCloseTo(raw * SPORTS_DB.strength.runSpec!, 6); // was × generic_sport 0.40
    expect(computeWeekTSS(wk, wk.rated)).toBe(Math.round(raw * SPORTS_DB.strength.runSpec!));
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(raw)); // Signal B: no runSpec, unchanged
  });

  it('weighs the same per minute as the same session synced as a HIIT workout', () => {
    const inApp = { activityType: IN_APP_HYROX_ACTIVITY_TYPE, workoutName: 'Station Density', displayName: 'Station Density' };
    const hiit = { activityType: 'HIIT', workoutName: 'Station Density', displayName: 'Station Density' };
    expect(resolveActualSport(SLOT, hiit)).toBe('strength');
    expect(resolveActualSport(SLOT, inApp)).toBe('strength');
    // An extra (not on a plan slot) logged in-app resolves the same way.
    expect(resolveActualSport('garmin-x', { activityType: IN_APP_HYROX_ACTIVITY_TYPE })).toBe('strength');

    const mk = (activityType: string, garminId: string): Week => {
      const w = week();
      w.rated[SLOT] = 7;
      w.garminActuals = {
        [SLOT]: {
          garminId, startTime: '2026-09-30T11:00:00.000Z', distanceKm: 0, durationSec: 55 * 60,
          avgPaceSecKm: null, avgHR: null, maxHR: null, calories: null, iTrimp: null,
          activityType, workoutName: 'Station Density', displayName: 'Station Density',
        },
      };
      return w;
    };
    expect(computeWeekTSS(mk(IN_APP_HYROX_ACTIVITY_TYPE, 'guided-1'), { [SLOT]: 7 }))
      .toBe(computeWeekTSS(mk('HIIT', 'strava-1'), { [SLOT]: 7 }));
  });
});
