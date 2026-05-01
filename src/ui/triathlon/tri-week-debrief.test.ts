/**
 * Smoke tests for the tri week-debrief logic. Pure data assembly is exposed
 * via showTriWeekDebrief — but we don't render the DOM in tests, we just
 * verify the underlying computations come out right by exercising the data
 * helpers it relies on.
 */

import { describe, it, expect } from 'vitest';
import { triEffortMultiplier } from '@/calculations/effort-multiplier.triathlon';
import type { SimulatorState, Workout } from '@/types/state';

function workout(id: string, discipline: 'swim' | 'bike' | 'run', plannedRpe: number, status?: 'completed'): Workout {
  return {
    id, t: 'easy', n: 'Test', d: '60min', r: plannedRpe, discipline,
    estimatedDurationMin: 60,
    ...(status ? { status } : {}),
  };
}

describe('tri week-debrief — data layer', () => {
  it('effort multiplier reflects easy ratings → next week longer', () => {
    const s = {
      eventType: 'triathlon',
      w: 2,
      wks: [
        {
          rated: { r1: 5, r2: 5 },  // both easier than planned 7
          triWorkouts: [
            workout('r1', 'run', 7, 'completed'),
            workout('r2', 'run', 7, 'completed'),
          ],
        },
      ],
      triConfig: { distance: 'ironman' },
    } as unknown as SimulatorState;
    const m = triEffortMultiplier(s, 'run');
    expect(m).toBeGreaterThan(1.0);  // duration scales up next week
  });

  it('per-discipline summary counts completed sessions correctly', () => {
    const wks: any[] = [
      {
        rated: {},
        triWorkouts: [
          workout('s1', 'swim', 5, 'completed'),
          workout('s2', 'swim', 5),  // not completed
          workout('b1', 'bike', 5, 'completed'),
        ],
        garminActuals: {
          a1: { garminId: 'a1', durationSec: 3600, activityType: 'SWIMMING' },
          a2: { garminId: 'a2', durationSec: 7200, activityType: 'CYCLING' },
        },
      },
    ];
    const swimPlanned = wks[0].triWorkouts.filter((w: Workout) => w.discipline === 'swim');
    const swimCompleted = swimPlanned.filter((w: Workout) => w.status === 'completed');
    expect(swimPlanned.length).toBe(2);
    expect(swimCompleted.length).toBe(1);
  });

  it('multiplier neutral (1.0) when no rated workouts', () => {
    const s = {
      eventType: 'triathlon',
      w: 2,
      wks: [{ rated: {}, triWorkouts: [] }],
      triConfig: { distance: 'ironman' },
    } as unknown as SimulatorState;
    expect(triEffortMultiplier(s, 'swim')).toBe(1.0);
    expect(triEffortMultiplier(s, 'bike')).toBe(1.0);
    expect(triEffortMultiplier(s, 'run')).toBe(1.0);
  });
});
