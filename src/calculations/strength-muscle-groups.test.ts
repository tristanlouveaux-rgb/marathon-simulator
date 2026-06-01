import { describe, it, expect } from 'vitest';
import { parseStrengthSession } from '@/guided/strength-model';
import { deriveWorkedMuscleGroups, muscleGroupsForExercise, workedMuscleGroupKeys } from './strength-muscle-groups';
import type { Workout } from '@/types';

function gym(d: string[]): Workout {
  // parseStrengthSession reads `d` as a newline-separated string (the template
  // arrays in src/workouts/*.ts are joined before they reach the parser).
  return { t: 'gym', n: 'Test Session', d: d.join('\n') } as any;
}

describe('muscleGroupsForExercise', () => {
  it('maps squats to quads (primary) + glutes (secondary)', () => {
    const g = muscleGroupsForExercise('Back Squat @80% 1RM');
    expect(g.find(x => x.g === 'quads')?.w).toBe(1);
    expect(g.find(x => x.g === 'glutes')?.w).toBe(0.5);
  });

  it('maps deadlift to hamstrings + glutes (both primary) + back', () => {
    const g = muscleGroupsForExercise('Trap-Bar Deadlift @85% 1RM').map(x => x.g);
    expect(g).toEqual(expect.arrayContaining(['hamstrings', 'glutes', 'back']));
  });

  it('disambiguates RDL from generic deadlift (no double-primary glutes)', () => {
    const g = muscleGroupsForExercise('Romanian Deadlift @60% 1RM');
    expect(g.find(x => x.g === 'hamstrings')?.w).toBe(1);
    expect(g.find(x => x.g === 'glutes')?.w).toBe(0.5); // secondary, not primary
  });

  it('maps Nordic curl to hamstrings, not via the generic "curl" word', () => {
    expect(muscleGroupsForExercise('Nordic Curl assisted').find(x => x.g === 'hamstrings')?.w).toBe(1);
  });

  it('maps planks / Pallof / dead bug to core', () => {
    expect(muscleGroupsForExercise('Front Plank').map(x => x.g)).toEqual(['core']);
    expect(muscleGroupsForExercise('Pallof Press').map(x => x.g)).toEqual(['core']);
    expect(muscleGroupsForExercise('Dead Bug').map(x => x.g)).toEqual(['core']);
  });

  it('maps calf raises to calves and bounds to calves-primary', () => {
    expect(muscleGroupsForExercise('Calf Raises').map(x => x.g)).toEqual(['calves']);
    expect(muscleGroupsForExercise('Single-Leg Bounds').find(x => x.g === 'calves')?.w).toBe(1);
  });

  it('returns empty for an unrecognised exercise (never guesses)', () => {
    expect(muscleGroupsForExercise('Interpretive Dance')).toEqual([]);
  });
});

describe('deriveWorkedMuscleGroups', () => {
  it('weights groups by set count and normalises intensity to 1 for the top group', () => {
    const w = gym([
      '3x10 Back Squat @80% 1RM (Drive through heels) (90s rest)', // quads×3, glutes×1.5
      '3x45s Front Plank (Brace) (30s rest)',                       // core×3
      '2x12 Calf Raises (Full range) (45s rest)',                   // calves×2
    ]);
    const session = parseStrengthSession(w)!;
    const groups = deriveWorkedMuscleGroups(session);
    // quads and core tie at score 3 → intensity 1.0; glutes lower; calves = 2.
    const byKey = Object.fromEntries(groups.map(g => [g.group, g]));
    expect(byKey.quads.score).toBe(3);
    expect(byKey.core.score).toBe(3);
    expect(byKey.glutes.score).toBe(1.5);
    expect(byKey.calves.score).toBe(2);
    expect(Math.max(...groups.map(g => g.intensity))).toBe(1);
    // Ordered most-worked first.
    expect(groups[0].score).toBeGreaterThanOrEqual(groups[groups.length - 1].score);
  });

  it('returns [] for an unparseable session', () => {
    const session = parseStrengthSession(gym([]));
    expect(session).toBeNull();
  });

  it('workedMuscleGroupKeys returns ordered keys', () => {
    const session = parseStrengthSession(gym([
      '4x6 Deadlift @75% 1RM (Flat back) (2 min rest)',
      '2x10 Glute Bridge (Squeeze) (45s rest)',
    ]))!;
    const keys = workedMuscleGroupKeys(session);
    expect(keys).toContain('hamstrings');
    expect(keys).toContain('glutes');
    // Deadlift (4 sets) drives glutes + hamstrings as primaries; the glute
    // bridge adds more glute volume, so glutes leads.
    expect(keys[0]).toBe('glutes');
  });
});
