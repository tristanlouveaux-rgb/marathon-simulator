/**
 * computeTriAdherence reads the last `weeks` COMPLETED weeks.
 *
 * s.w is 1-based (store default w: 1; tri and cycling init set s.w = 1), so
 * the week in progress is wks[s.w - 1] and the last completed week is
 * wks[s.w - 2]. The loop started at wks[s.w - 1]: it counted the week in
 * progress (its sessions not yet done read as completed, any 'skipped' one as
 * missed) and dropped the oldest completed week of the window.
 */
import { describe, it, expect } from 'vitest';
import { computeTriAdherence } from './tri-adherence';
import type { SimulatorState, Workout } from '@/types/state';

function bike(id: string, opts: Partial<Workout> = {}): Workout {
  return { id, t: 'bike_endurance', n: 'Ride', d: '60min', r: 5, discipline: 'bike', estimatedDurationMin: 60, ...opts };
}

/** Each week: three 60-min bike sessions. */
function state(w: number, nWeeks: number): SimulatorState {
  return {
    eventType: 'triathlon',
    w,
    wks: Array.from({ length: nWeeks }, (_, i) => ({
      triWorkouts: [bike(`w${i}a`), bike(`w${i}b`), bike(`w${i}c`)],
    })),
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('computeTriAdherence window', () => {
  it('week 5: the 4-week window is wks[0..3], the week in progress excluded', () => {
    const s = state(5, 5);
    // A long ride missed in the oldest completed week of the window.
    s.wks[0].triWorkouts![0] = bike('w0a', { t: 'bike_long', estimatedDurationMin: 180, status: 'skipped' });
    const a = computeTriAdherence(s, 4);
    expect(a.bike.plannedSessions).toBe(12);
    expect(a.bike.completedSessions).toBe(11);
    expect(a.bike.missedLongSessions).toBe(1);
  });

  it('a session skipped in the week in progress does not count yet', () => {
    const s = state(5, 5);
    s.wks[4].triWorkouts![0] = bike('w4a', { t: 'bike_long', estimatedDurationMin: 180, status: 'skipped' });
    const a = computeTriAdherence(s, 4);
    expect(a.bike.missedLongSessions).toBe(0);
    expect(a.bike.ratio).toBe(1);
    expect(a.bike.penaltyPct).toBe(0);
  });

  it('mid-plan (week 3 of 10): only the two completed weeks count', () => {
    const s = state(3, 10);
    s.wks[2].triWorkouts![0] = bike('w2a', { status: 'skipped' }); // in progress
    s.wks[3].triWorkouts![0] = bike('w3a', { status: 'skipped' }); // next week
    s.wks[1].triWorkouts![1] = bike('w1b', { status: 'skipped' }); // completed
    const a = computeTriAdherence(s, 4);
    expect(a.bike.plannedSessions).toBe(6);
    expect(a.bike.completedSessions).toBe(5);
  });

  it('week 1: no week is complete, so nothing is counted', () => {
    const s = state(1, 3);
    const a = computeTriAdherence(s, 4);
    expect(a.bike.plannedSessions).toBe(0);
    expect(a.bike.ratio).toBe(1);
    expect(a.bike.penaltyPct).toBe(0);
  });
});
