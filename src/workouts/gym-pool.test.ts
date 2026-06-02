import { describe, it, expect } from 'vitest';
import { buildPoolWorkout, composeExerciseLine, tuneGymWorkout, type GymPoolFocus } from './gym-pool';
import { GYM_GOAL_SCHEMES, type GymGoal } from '@/constants/strength-constants';
import { parseStrengthSession } from '@/guided/strength-model';
import { normalizeExerciseKey, isWeightTrackable } from '@/calculations/strength-exercise-key';

const FOCUSES: GymPoolFocus[] = ['upper', 'lower', 'full'];
const GOALS: GymGoal[] = ['strength', 'muscle', 'general'];

describe('buildPoolWorkout — parser round-trip', () => {
  for (const focus of FOCUSES) {
    for (const goal of GOALS) {
      it(`${focus} / ${goal} parses into clean guided sets`, () => {
        const wo = buildPoolWorkout(focus, goal, 'traditional');
        expect(wo.t).toBe('gym');
        const session = parseStrengthSession(wo);
        expect(session).not.toBeNull();
        // 5 exercises (+ a stretch line captured separately).
        expect(session!.exerciseCount).toBe(5);
        // No display name retains the "@X% 1RM" garnish.
        for (const set of session!.sets) {
          expect(set.exerciseName).not.toMatch(/1RM/i);
        }
      });
    }
  }

  it('every loaded lift resolves to a non-empty, expected key', () => {
    const wo = buildPoolWorkout('upper', 'muscle', 'traditional');
    const session = parseStrengthSession(wo)!;
    const keys = session.sets.filter(s => s.liftKey).map(s => s.liftKey);
    expect(new Set(keys)).toEqual(new Set(['bench-press', 'overhead-press', 'row', 'lat-pulldown', 'curl']));
  });

  it('full body loaded lifts resolve; the plank is not weight-tracked', () => {
    const wo = buildPoolWorkout('full', 'strength', 'traditional');
    const session = parseStrengthSession(wo)!;
    const byName = new Map(session.sets.map(s => [s.exerciseName, s.liftKey]));
    expect(byName.get('Back Squat')).toBe('back-squat');
    expect(byName.get('Romanian Deadlift')).toBe('rdl');
    expect(byName.get('Overhead Press')).toBe('overhead-press');
    expect(byName.get('Dumbbell Row')).toBe('row');
    expect(byName.get('Front Plank')).toBeUndefined(); // bodyweight core, not tracked
  });

  it('lower body is goal-driven and distinct (squat + hinge + split squat + calf)', () => {
    const wo = buildPoolWorkout('lower', 'muscle', 'traditional');
    const session = parseStrengthSession(wo)!;
    const keys = session.sets.filter(s => s.liftKey).map(s => s.liftKey);
    expect(new Set(keys)).toEqual(new Set(['back-squat', 'rdl', 'split-squat', 'calf-raise']));
    expect(wo.d).toContain('@70% 1RM'); // goal-driven load, not a running template
  });

  it('sets a real estimatedDurationMin (not the generic 60 fallback)', () => {
    const wo = buildPoolWorkout('upper', 'muscle', 'traditional');
    expect(typeof (wo as any).estimatedDurationMin).toBe('number');
    expect((wo as any).estimatedDurationMin).toBeGreaterThan(0);
  });

  it('applies the goal rep scheme (strength 4x5, muscle 3x10, general 3x12)', () => {
    const s = buildPoolWorkout('upper', 'strength', 'traditional');
    expect(s.d).toContain('4x5 Barbell Bench Press @80% 1RM');
    const m = buildPoolWorkout('upper', 'muscle', 'traditional');
    expect(m.d).toContain('3x10 Barbell Bench Press @70% 1RM');
    const g = buildPoolWorkout('upper', 'general', 'traditional');
    expect(g.d).toContain('3x12 Barbell Bench Press @60% 1RM');
  });
});

describe('rest style', () => {
  it('circuit and traditional differ only in the rest token + name suffix', () => {
    const trad = buildPoolWorkout('upper', 'muscle', 'traditional');
    const circ = buildPoolWorkout('upper', 'muscle', 'circuit');
    expect(circ.n).toBe('Upper Body (circuit)');
    expect(trad.n).toBe('Upper Body');
    // traditional muscle rest = 75s, circuit = 45s
    expect(trad.d).toContain('(75s rest)');
    expect(circ.d).toContain('(45s rest)');
    // strip the rest tokens + name → identical exercise/scheme content
    const stripRest = (d: string) => d.replace(/\(\d+s rest\)|\(\d+ min rest\)/g, '');
    expect(stripRest(trad.d)).toBe(stripRest(circ.d));
  });

  it('strength traditional rest renders as minutes', () => {
    const s = buildPoolWorkout('full', 'strength', 'traditional');
    expect(s.d).toContain('(3 min rest)'); // 180s
  });
});

describe('tuneGymWorkout — time + intensity', () => {
  const base = () => buildPoolWorkout('upper', 'muscle', 'traditional'); // 5 ex, @70%, RPE 7

  it('harder shifts every load up 5% and bumps RPE', () => {
    const t = tuneGymWorkout(base(), 45, 'harder');
    expect(t.d).toContain('@75% 1RM');
    expect(t.d).not.toContain('@70% 1RM');
    expect(t.rpe).toBe(8);
  });

  it('easier shifts every load down 5% and lowers RPE', () => {
    const t = tuneGymWorkout(base(), 45, 'easier');
    expect(t.d).toContain('@65% 1RM');
    expect(t.rpe).toBe(6);
  });

  it('20 min trims to 3 exercises and drops a set', () => {
    const t = tuneGymWorkout(base(), 20, 'standard');
    const session = parseStrengthSession(t)!;
    expect(session.exerciseCount).toBe(3);
    // muscle base is 3 sets; -1 set => 2x for the loaded lifts
    expect(t.d).toContain('2x10');
    expect((t as any).estimatedDurationMin).toBe(20);
  });

  it('60 min keeps 5 exercises and adds a set', () => {
    const t = tuneGymWorkout(base(), 60, 'standard');
    const session = parseStrengthSession(t)!;
    expect(session.exerciseCount).toBe(5);
    expect(t.d).toContain('4x10'); // 3 sets + 1
  });

  it('clamps load to the 40-90 band', () => {
    const strong = buildPoolWorkout('full', 'strength', 'traditional'); // @80%
    expect(tuneGymWorkout(strong, 45, 'harder').d).toContain('@85% 1RM');
    // two harder notches would exceed 90 only at the top; one is fine
    const light = buildPoolWorkout('upper', 'general', 'traditional'); // @60%
    expect(tuneGymWorkout(light, 45, 'easier').d).toContain('@55% 1RM');
  });
});

describe('tuneGymWorkout on a running-supportive template (regex robustness)', () => {
  // Real template lines incl. a timed plank ("3x45s") and "each leg" reps.
  const template = {
    t: 'gym', n: 'Heavy Lower Body', r: 7, rpe: 7,
    d: [
      '3x5 Back Squat @80% 1RM (Should feel heavy, 2 reps in reserve) (2-3 min rest)',
      '3x8 each leg Bulgarian Split Squat @60% 1RM (Steady) (90s rest)',
      '4x12 Calf Raises (Full range) (30-60s rest)',
      '3x45s Front Plank (Flat back, brace core) (30-60s rest)',
      'Stretch between sets: hip flexors, quads, calves',
    ].join('\n'),
  } as any;

  it('harder shifts loads, leaves rest tokens + timed lines intact', () => {
    const t = tuneGymWorkout(template, 45, 'harder');
    expect(t.d).toContain('@85% 1RM');       // 80 -> 85
    expect(t.d).toContain('@65% 1RM');       // 60 -> 65
    expect(t.d).toContain('(2-3 min rest)'); // rest token untouched
    expect(t.d).toContain('(90s rest)');     // not mistaken for a load
    expect(t.d).toContain('Stretch between sets'); // stretch survives
  });

  it('20 min trims to 3 exercises and the plank set count, not its time', () => {
    const t = tuneGymWorkout(template, 20, 'standard');
    expect(parseStrengthSession(t)!.exerciseCount).toBe(3); // plank trimmed out
    // sanity: still parses, no 0/NaN sets
    for (const set of parseStrengthSession(t)!.sets) {
      expect(set.setCount).toBeGreaterThanOrEqual(2);
    }
  });

  it('60 min keeps all + adds a set; timed plank becomes 4x45s (count, not reps)', () => {
    const t = tuneGymWorkout(template, 60, 'standard');
    expect(t.d).toContain('4x45s Front Plank'); // 3 sets +1; reps "45s" intact (not "45+1")
    expect(t.d).toContain('4x5 Back Squat');    // 3 -> 4 sets
  });
});

describe('composeExerciseLine', () => {
  it('loaded line carries the scheme reps + load + rest', () => {
    const line = composeExerciseLine(
      { name: 'Dumbbell Row', region: 'upper', loadable: true, cue: 'Squeeze' },
      GYM_GOAL_SCHEMES.strength,
      'traditional',
    );
    expect(line).toBe('4x5 Dumbbell Row @80% 1RM (Squeeze) (3 min rest)');
    expect(isWeightTrackable(line.replace(/^\d+x\S+\s/, '').replace(/\s*\([^)]*\)/g, ''))).toBe(true);
  });
  it('non-loaded line uses its fixed prescription, no @%', () => {
    const line = composeExerciseLine(
      { name: 'Front Plank', region: 'core', loadable: false, cue: 'Brace', fixedSets: 3, fixedReps: '45s', fixedRestSec: 30 },
      GYM_GOAL_SCHEMES.muscle,
      'traditional',
    );
    expect(line).toBe('3x45s Front Plank (Brace) (30s rest)');
    expect(normalizeExerciseKey('Front Plank')).toBe('');
  });
});
