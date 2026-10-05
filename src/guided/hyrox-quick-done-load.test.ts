/**
 * Audit B9: a HYROX station / brick quick "Mark as done" (no guided records)
 * logs the session at its prescribed duration, so it carries load. Runs the
 * real completeStrengthSession; rate() and saveState are stubbed.
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
vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));

import { getDefaultState, setState, getMutableState } from '@/state/store';
import { completeStrengthSession } from './strength-complete';
import { generateHyroxStation } from '@/workouts/hyrox-generators';
import { computeWeekRawTSS, computeTodaySignalBTSS } from '@/calculations/fitness-model';
import { TL_PER_MIN } from '@/constants';
import type { Week, Workout } from '@/types';

const ACCESS = { sled: 'always' as const, skiErg: true, rowErg: true };

function week(): Week {
  return {
    w: 1, ph: 'base', rated: {}, skip: [], cross: [], wkGain: 0,
    workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
  } as unknown as Week;
}

describe('HYROX quick Mark as done carries load (audit B9)', () => {
  it('a station session marked done without guided records logs its prescribed duration at its rated RPE', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = getDefaultState();
    s.planStartDate = '2026-09-28';
    s.w = 1;
    s.wks = [week()];
    setState(s);

    const station = generateHyroxStation({
      kind: 'station_density', targetMinutes: 55, band: 'intermediate',
      stationAccess: ACCESS, phase: 'build', slotIndex: 0,
    }) as Workout;
    const workout = { ...station, id: 'hx-w1-station-0', dayOfWeek: 2 } as Workout;
    expect(workout.estimatedDurationMin).toBeGreaterThan(0);

    completeStrengthSession(workout);

    const wk = getMutableState().wks[0];
    const actual = wk.garminActuals?.['hx-w1-station-0'];
    expect(actual?.garminId.startsWith('guided-')).toBe(true);
    expect(actual?.durationSec).toBe(workout.estimatedDurationMin! * 60);
    const rpe = wk.rated['hx-w1-station-0'] as number;
    expect(computeWeekRawTSS(wk, wk.rated)).toBe(Math.round(workout.estimatedDurationMin! * TL_PER_MIN[Math.round(rpe)])); // was 0
    expect(computeTodaySignalBTSS(wk, actual!.startTime!.slice(0, 10))).toBeGreaterThan(0);              // was 0
  });
});
