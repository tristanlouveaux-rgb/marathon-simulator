/**
 * Tests for the shared tri/cycling/HYROX week resolver.
 * Contract under test: stored-plan + adhoc assembly, render-time illness mods,
 * clone isolation (idempotent, never mutates stored state), and the shared
 * duration estimator.
 */

import { describe, it, expect } from 'vitest';
import { resolveTriWeekWorkouts, estimateTriWorkoutMin } from './week-resolve.triathlon';
import type { SimulatorState } from '@/types/state';

function triState(overrides: Partial<SimulatorState> = {}): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 1,
    wks: [{
      ph: 'base',
      triWorkouts: [
        { id: 'W1-bike-0', n: 'Endurance ride', t: 'bike_endurance', d: '60min Z2', r: 4, discipline: 'bike', dayOfWeek: 1, aerobic: 40, anaerobic: 5, estimatedDurationMin: 60 },
        { id: 'W1-swim-0', n: 'Technique swim', t: 'swim_technique', d: '45min drills', r: 3, discipline: 'swim', dayOfWeek: 2, aerobic: 25, anaerobic: 0, estimatedDurationMin: 45 },
      ],
      adhocWorkouts: [
        { id: 'adhoc-1', n: 'Strength', t: 'strength', d: '40min', r: 5, discipline: 'strength', dayOfWeek: 4, estimatedDurationMin: 40 },
      ],
      rated: {},
    }],
    ...overrides,
  } as unknown as SimulatorState;
}

describe('resolveTriWeekWorkouts', () => {
  it('assembles stored triWorkouts + adhocWorkouts', () => {
    const s = triState();
    const out = resolveTriWeekWorkouts(s, 1);
    expect(out.map((w: any) => w.id)).toEqual(['W1-bike-0', 'W1-swim-0', 'adhoc-1']);
  });

  it('returns empty for a missing week', () => {
    const s = triState();
    expect(resolveTriWeekWorkouts(s, 5)).toEqual([]);
  });

  it('clone (default): returned objects are not the stored references', () => {
    const s = triState();
    const out = resolveTriWeekWorkouts(s, 1);
    expect(out[0]).not.toBe(s.wks![0].triWorkouts![0]);
    (out[0] as any).d = 'MUTATED';
    expect((s.wks![0].triWorkouts![0] as any).d).toBe('60min Z2');
  });

  it('clone:false returns the stored references (plan-view legacy contract)', () => {
    const s = triState();
    const out = resolveTriWeekWorkouts(s, 1, { clone: false });
    expect(out[0]).toBe(s.wks![0].triWorkouts![0]);
  });

  it('illness mods apply to the clones, never the stored plan (idempotent)', () => {
    // Legacy illness shape (severity only, no schedule) rests every discipline.
    const s = triState({ illnessState: { active: true, severity: 'resting', startDate: '2026-06-01' } } as any);
    const out1 = resolveTriWeekWorkouts(s, 1);
    const out2 = resolveTriWeekWorkouts(s, 1);
    // Mods visible on output…
    expect((out1[0] as any).illnessMod).toBe(true);
    // …identical across calls (idempotent)…
    expect(out1).toEqual(out2);
    // …and the stored plan is untouched.
    expect((s.wks![0].triWorkouts![0] as any).illnessMod).toBeUndefined();
    expect((s.wks![0].triWorkouts![0] as any).r).toBe(4);
  });

  it('illness mods only fire for the current week', () => {
    const s = triState({ w: 2, wks: [triState().wks![0], triState().wks![0]] } as any);
    (s as any).illnessState = { active: true, severity: 'resting', startDate: '2026-06-01' };
    const past = resolveTriWeekWorkouts(s, 1);
    expect((past[0] as any).illnessMod).toBeUndefined();
  });
});

describe('estimateTriWorkoutMin', () => {
  it('prefers explicit estimatedDurationMin', () => {
    expect(estimateTriWorkoutMin({ estimatedDurationMin: 75, d: '30min' })).toBe(75);
  });
  it('sums brick segments', () => {
    expect(estimateTriWorkoutMin({ brickSegments: [{ durationMin: 40 }, { durationMin: 20 }] })).toBe(60);
  });
  it('parses "Xh Ymin"', () => {
    expect(estimateTriWorkoutMin({ d: '1h 30min steady' })).toBe(90);
  });
  it('takes the max "Nmin" in the description', () => {
    expect(estimateTriWorkoutMin({ d: '45min main set, 10min warmup' })).toBe(45);
  });
  it('falls back to 60 when nothing parses', () => {
    expect(estimateTriWorkoutMin({ d: 'easy spin' })).toBe(60);
  });
});
