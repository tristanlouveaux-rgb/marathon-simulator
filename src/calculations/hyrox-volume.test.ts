import { describe, it, expect } from 'vitest';
import { plannedHyroxSessionsPerWeek } from './hyrox-volume';
import type { SimulatorState } from '@/types/state';

function stateWith(weeks: Array<{ sessions: number; raceClosing?: boolean }>, w = 0): SimulatorState {
  return {
    eventType: 'hyrox',
    w,
    wks: weeks.map((c, i) => ({
      w: i + 1,
      ...(c.raceClosing ? { raceClosing: true } : {}),
      triWorkouts: Array.from({ length: c.sessions }, (_, j) => ({ id: `h${i}-${j}` })),
    })),
  } as unknown as SimulatorState;
}

describe('plannedHyroxSessionsPerWeek', () => {
  it('averages the next weeks of planned sessions', () => {
    expect(plannedHyroxSessionsPerWeek(stateWith([{ sessions: 4 }, { sessions: 6 }]), 4)).toBeCloseTo(5, 9);
  });

  // A Monday to Wednesday race's own week holds only the race: not a training
  // week, so it does not dilute the average (planTrainingWeeks parity). Before,
  // it counted as a 0-session week: (6 + 5 + 0) / 3.
  it('skips the closing week', () => {
    const s = stateWith([{ sessions: 6 }, { sessions: 5 }, { sessions: 0, raceClosing: true }]);
    expect(plannedHyroxSessionsPerWeek(s, 4)).toBeCloseTo(5.5, 9);
    expect(plannedHyroxSessionsPerWeek(stateWith([{ sessions: 0, raceClosing: true }]), 4)).toBe(0);
  });
});
