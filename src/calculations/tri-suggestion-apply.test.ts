import { describe, it, expect } from 'vitest';
import { applyTriSuggestions } from './tri-suggestion-apply';
import type { TriSuggestionMod } from './tri-suggestion-aggregator';
import type { SimulatorState, Workout } from '@/types/state';

function workout(id: string, t: string, discipline: 'swim' | 'bike' | 'run', durMin = 60): Workout {
  return { id, t, discipline, n: 'Test', d: `${durMin}min`, r: 5, estimatedDurationMin: durMin };
}

function state(workouts: Workout[]): SimulatorState {
  return {
    eventType: 'triathlon',
    w: 0,
    wks: [{ triWorkouts: workouts }],
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('applyTriSuggestions', () => {
  it('swap_easy replaces a quality session with endurance + cuts duration', () => {
    const s = state([workout('w1', 'bike_threshold', 'bike', 60)]);
    const mod: TriSuggestionMod = {
      id: 'm1', source: 'rpe_blown', discipline: 'bike',
      headline: 'Test', body: 'Test',
      severity: 'caution',
      targetWorkoutId: 'w1',
      action: 'swap_easy',
    };
    const r = applyTriSuggestions(s, [mod]);
    expect(r.applied).toBe(1);
    const w = s.wks![0].triWorkouts![0];
    expect(w.status).toBe('replaced');
    expect(w.t).toBe('bike_endurance');
    expect(w.estimatedDurationMin).toBe(45);  // 60 × 0.75
    expect(w.originalName).toBeDefined();
  });

  it('downgrade_today drops one tier (vo2 → threshold)', () => {
    const s = state([workout('w1', 'bike_vo2', 'bike', 60)]);
    const mod: TriSuggestionMod = {
      id: 'm1', source: 'readiness', discipline: 'bike',
      headline: 'Test', body: 'Test',
      severity: 'caution',
      targetWorkoutId: 'w1',
      action: 'downgrade_today',
    };
    applyTriSuggestions(s, [mod]);
    const w = s.wks![0].triWorkouts![0];
    expect(w.status).toBe('reduced');
    expect(w.t).toBe('bike_threshold');
  });

  it('trim_volume reduces duration by 15%', () => {
    const s = state([workout('w1', 'bike_endurance', 'bike', 200)]);
    const mod: TriSuggestionMod = {
      id: 'm1', source: 'volume_ramp', discipline: 'bike',
      headline: 'Test', body: 'Test',
      severity: 'caution',
      targetWorkoutId: 'w1',
      action: 'trim_volume',
    };
    applyTriSuggestions(s, [mod]);
    const w = s.wks![0].triWorkouts![0];
    expect(w.status).toBe('reduced');
    expect(w.estimatedDurationMin).toBe(170);  // 200 × 0.85
  });

  it('skips mods without a targetWorkoutId', () => {
    const s = state([workout('w1', 'bike_endurance', 'bike')]);
    const mod: TriSuggestionMod = {
      id: 'm1', source: 'volume_ramp', discipline: 'bike',
      headline: 'Test', body: 'Test',
      severity: 'caution',
      action: 'trim_volume',  // no targetWorkoutId
    };
    const r = applyTriSuggestions(s, [mod]);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(1);
  });
});
