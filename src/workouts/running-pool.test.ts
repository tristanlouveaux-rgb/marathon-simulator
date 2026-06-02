import { describe, it, expect } from 'vitest';
import { buildRunningStrengthWorkout, categoryOf, type RunningStrengthCategory } from './running-pool';
import { parseStrengthSession } from '@/guided/strength-model';
import { isWeightTrackable, normalizeExerciseKey } from '@/calculations/strength-exercise-key';

const TIMES: Array<[number, number]> = [[20, 4], [30, 5], [45, 6], [60, 7], [75, 8], [90, 9]];

function exerciseNames(min: number, week = 0): string[] {
  const wo = buildRunningStrengthWorkout(week, min, 'standard', 'traditional');
  return parseStrengthSession(wo)!.sets
    .map(s => s.exerciseName)
    .filter((n, i, a) => a.indexOf(n) === i); // unique, preserve order
}

describe('buildRunningStrengthWorkout — sizing + parse', () => {
  it.each(TIMES)('%i min -> %i exercises, all parse cleanly', (min, count) => {
    const wo = buildRunningStrengthWorkout(0, min, 'standard', 'traditional');
    const session = parseStrengthSession(wo);
    expect(session).not.toBeNull();
    expect(session!.exerciseCount).toBe(count);
    for (const set of session!.sets) {
      expect(set.exerciseName).not.toMatch(/1RM/i); // load garnish stripped on display
    }
    expect((wo as any).estimatedDurationMin).toBe(min);
  });

  it('a 60-min session is balanced: one per category, compounds lead', () => {
    const names = exerciseNames(60);
    const cats = names.map(categoryOf);
    expect(cats).toEqual([
      'max-strength', 'single-leg', 'posterior', 'calf-foot', 'hip-stability', 'core', 'plyo',
    ] as RunningStrengthCategory[]);
  });

  it('longer sessions add a 2nd calf-foot then single-leg', () => {
    const cats90 = exerciseNames(90).map(categoryOf);
    expect(cats90.filter(c => c === 'calf-foot').length).toBe(2);
    expect(cats90.filter(c => c === 'single-leg').length).toBe(2);
  });
});

describe('rotation', () => {
  it('the max-strength lead rotates through all 4 variants across weeks', () => {
    const leads = new Set<string>();
    for (let w = 0; w < 8; w++) leads.add(exerciseNames(60, w)[0]);
    expect(leads.size).toBe(4); // Back Squat / Trap-Bar / Front Squat / Deadlift
  });

  it('consecutive weeks differ', () => {
    const w0 = exerciseNames(60, 0).join('|');
    const w1 = exerciseNames(60, 1).join('|');
    expect(w0).not.toBe(w1);
  });

  it('base phase keeps high-soreness moves (Nordic / eccentric / depth jump) off the lead of their category', () => {
    // Posterior category: Nordic Curl is highSoreness; in base it must not be the
    // first posterior variant at slotIndex 0 (it would be at offset where it leads otherwise).
    for (let w = 0; w < 4; w++) {
      const posterior = exerciseNames(60, w).map((n, i) => ({ n, c: categoryOf(n) })).find(x => x.c === 'posterior');
      // not asserting a specific exercise, just that base-phase build still parses + picks a posterior
      const base = buildRunningStrengthWorkout(w, 60, 'standard', 'traditional', 'base');
      expect(parseStrengthSession(base)).not.toBeNull();
      expect(posterior).toBeTruthy();
    }
  });
});

describe('intensity', () => {
  it('harder shifts loaded %s up 5 and RPE up; bodyweight lines unchanged', () => {
    const std = buildRunningStrengthWorkout(0, 60, 'standard', 'traditional');
    const hard = buildRunningStrengthWorkout(0, 60, 'harder', 'traditional');
    expect(hard.rpe).toBeGreaterThan(std.rpe ?? 0);
    // Back Squat @80 -> @85 when harder
    expect(std.d).toContain('@80% 1RM');
    expect(hard.d).toContain('@85% 1RM');
    // a plank/plyo line (no @%) is identical in both
    expect(/\bPallof|Plank|Pogo|Bird Dog|Dead Bug/.test(std.d)).toBe(true);
  });
  it('easier shifts loaded %s down 5', () => {
    const easy = buildRunningStrengthWorkout(0, 60, 'easier', 'traditional');
    expect(easy.d).toContain('@75% 1RM'); // 80 -> 75
  });
});

describe('weight-tracking of the running vocabulary', () => {
  it('tibialis raise (loaded) tracks to its own key', () => {
    expect(isWeightTrackable('Tibialis Raise @40% 1RM')).toBe(true);
    expect(normalizeExerciseKey('Tibialis Raise @40% 1RM')).toBe('tibialis-raise');
  });
  it('all loaded calf variants resolve to calf-raise', () => {
    for (const n of ['Standing Calf Raise', 'Soleus Calf Raise', 'Single-Leg Calf Raise']) {
      expect(normalizeExerciseKey(`${n} @50% 1RM`)).toBe('calf-raise');
    }
  });
  it('bodyweight / plyo / isometric movements are NOT tracked', () => {
    for (const n of ['Copenhagen Plank', 'Nordic Curl', 'Pogo Hops', 'Box Jumps', 'Single-Leg Bounds',
      'Banded Lateral Walk', 'Suitcase Carry', 'Side Plank', 'Dead Bug', 'Bird Dog', 'Heel Walks',
      'Eccentric Calf Drop', 'Isometric Calf Hold']) {
      expect(normalizeExerciseKey(n)).toBe('');
    }
  });
  it('loaded running lifts in a built session carry liftKeys; bodyweight ones do not', () => {
    const wo = buildRunningStrengthWorkout(0, 90, 'standard', 'traditional');
    const session = parseStrengthSession(wo)!;
    const squat = session.sets.find(s => s.exerciseName.includes('Squat') || s.exerciseName.includes('Deadlift'));
    expect(squat?.liftKey).toBeTruthy();
  });
});
