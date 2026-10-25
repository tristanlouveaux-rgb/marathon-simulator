/**
 * The readiness look-ahead names the upcoming hard session (2026-10-22).
 *
 * The load-spike sentences printed the workout type with underscores as
 * spaces. Once the HYROX long run counted as hard (D13), a spike day before it
 * read "Treat tomorrow's hyrox run easy as a chance to ease in." for a session
 * the plan calls "Long Run". StrainContext.upcomingHard now carries the plan
 * name and the copy prints it, falling back to the type only without one.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./fitness-model', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./fitness-model')>();
  return {
    ...orig,
    // A load spike: the branch whose copy names the upcoming hard session.
    computeReadinessACWR: () => ({ ratio: 1.7, status: 'high', safeUpper: 1.3 }),
  };
});

import { computeDailyCoach, type StrainContext } from './daily-coach';
import type { SimulatorState, Week } from '@/types';

function week(w: number): Week {
  return { w, ph: 'build', rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [], garminActuals: {} } as unknown as Week;
}

function state(): SimulatorState {
  return {
    w: 2, tw: 12, v: 45, iv: 45, rd: 'marathon', rw: 4, typ: 'balanced', b: 1.06,
    wks: [week(1), week(2)], pac: { e: 330 }, physiologyHistory: [], historicWeeklyTSS: [],
  } as unknown as SimulatorState;
}

const strain = (upcomingHard: StrainContext['upcomingHard'], isRestDay: boolean): StrainContext => ({
  strainPct: 0, isRestDay, isRestDayOverreaching: false, trainedToday: false, todayIsHard: false,
  upcomingHard, recentCrossTraining: null, actualTSS: 0,
});

describe('load-spike look-ahead names the session', () => {
  it('rest day before the HYROX long run: the plan name, not the type', () => {
    const msg = computeDailyCoach(state(), strain({ whenLabel: 'tomorrow', type: 'hyrox_run_easy', name: 'Long Run' }, true)).primaryMessage;
    expect(msg).toBe("Load spike (1.7x). Rest is well placed. Treat tomorrow's Long Run as a chance to ease in.");
    expect(msg).not.toContain('hyrox run');
  });

  it('easy day before it: the same name', () => {
    const msg = computeDailyCoach(state(), strain({ whenLabel: 'the day after', type: 'hyrox_run_easy', name: 'Long Run' }, false)).primaryMessage;
    expect(msg).toBe("Load spike (1.7x). Keep today easy. Treat the day after's Long Run as a chance to ease in.");
  });

  it('no name: falls back to the type', () => {
    const msg = computeDailyCoach(state(), strain({ whenLabel: 'tomorrow', type: 'bike_threshold', name: '' }, true)).primaryMessage;
    expect(msg).toContain("Treat tomorrow's bike threshold as a chance to ease in.");
  });
});
