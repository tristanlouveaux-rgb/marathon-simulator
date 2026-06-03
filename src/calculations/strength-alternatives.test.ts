import { describe, it, expect } from 'vitest';
import type { Workout } from '@/types';
import {
  swapKeyForName,
  categoryForExerciseName,
  alternativesFor,
  hasAlternatives,
  applyStrengthSwaps,
} from './strength-alternatives';

describe('swapKeyForName', () => {
  it('slugifies the cleaned display name', () => {
    expect(swapKeyForName('Trap-Bar Deadlift')).toBe('trap-bar-deadlift');
    expect(swapKeyForName('Single-Leg Glute Bridge')).toBe('single-leg-glute-bridge');
  });
  it('strips the @X% 1RM load garnish before keying', () => {
    expect(swapKeyForName('Trap-Bar Deadlift @80% 1RM')).toBe('trap-bar-deadlift');
  });
});

describe('categoryForExerciseName', () => {
  it('resolves pool movements by exact membership', () => {
    expect(categoryForExerciseName('Trap-Bar Deadlift')).toBe('max-strength');
    expect(categoryForExerciseName('Bulgarian Split Squat')).toBe('single-leg');
    expect(categoryForExerciseName('Standing Calf Raise')).toBe('calf-foot');
  });
  it('resolves gym-template movements not in the pool via pattern rules', () => {
    expect(categoryForExerciseName('Goblet Squat')).toBe('max-strength');
    expect(categoryForExerciseName('Reverse Lunge')).toBe('single-leg');
    expect(categoryForExerciseName('Kettlebell Deadlift')).toBe('max-strength');
    expect(categoryForExerciseName('Single-Leg Glute Bridge')).toBe('hip-stability');
    expect(categoryForExerciseName('Romanian Deadlift')).toBe('posterior');
  });
  it('returns null for movements with no functional peer', () => {
    expect(categoryForExerciseName('Wall Sit')).toBeNull();
  });
});

describe('alternativesFor', () => {
  it('offers the same-pattern movements, excluding the exercise itself', () => {
    const names = alternativesFor('Trap-Bar Deadlift').map(e => e.name);
    expect(names).toContain('Deadlift');
    expect(names).toContain('Front Squat');
    expect(names).toContain('Back Squat');
    expect(names).not.toContain('Trap-Bar Deadlift');
  });
  it('orders by muscle-group overlap (closest match first)', () => {
    // Trap-Bar Deadlift is a hinge; bare Deadlift overlaps fully, squats less so.
    expect(alternativesFor('Trap-Bar Deadlift')[0].name).toBe('Deadlift');
  });
  it('returns empty for an unresolvable movement', () => {
    expect(alternativesFor('Wall Sit')).toEqual([]);
    expect(hasAlternatives('Wall Sit')).toBe(false);
    expect(hasAlternatives('Trap-Bar Deadlift')).toBe(true);
  });
});

describe('applyStrengthSwaps', () => {
  const gym = (d: string): Workout => ({ t: 'gym', n: 'Running Strength', d } as Workout);

  const swap = (from: string, to: string) => ({ [swapKeyForName(from)]: { from, to } });

  it('replaces a remembered line with the substitute canonical prescription', () => {
    const wo = gym(
      '3x5 Trap-Bar Deadlift @80% 1RM (Flat back, push the floor away) (3 min rest)\n' +
      '3x8 each leg Weighted Lunge @50% 1RM (Controlled descent) (75s rest)\n' +
      'Stretch to finish: 3-5 min full body',
    );
    const out = applyStrengthSwaps(wo, swap('Trap-Bar Deadlift', 'Deadlift'));
    const lines = String((out as any).d).split('\n');
    expect(lines[0]).toContain('Deadlift');
    expect(lines[0]).not.toContain('Trap-Bar');
    expect(lines[0]).toContain('@80% 1RM');             // still weight-trackable
    expect(lines[1]).toContain('Weighted Lunge');        // untouched
    expect(lines[2]).toBe('Stretch to finish: 3-5 min full body'); // preserved
  });

  it('is idempotent (applying again is a no-op once swapped)', () => {
    const wo = gym('3x5 Trap-Bar Deadlift @80% 1RM (Flat back) (3 min rest)');
    const once = applyStrengthSwaps(wo, swap('Trap-Bar Deadlift', 'Deadlift'));
    const twice = applyStrengthSwaps(once, swap('Trap-Bar Deadlift', 'Deadlift'));
    expect((twice as any).d).toBe((once as any).d);
  });

  it('returns the workout unchanged for an empty map', () => {
    const wo = gym('3x5 Trap-Bar Deadlift @80% 1RM (Flat back) (3 min rest)');
    expect(applyStrengthSwaps(wo, {})).toBe(wo);
    expect(applyStrengthSwaps(wo, undefined)).toBe(wo);
  });

  it('leaves a HYROX session (parsed from components) untouched', () => {
    const hyrox = { t: 'hyrox', n: 'HYROX', hyroxComponents: [{ type: 'run', distanceM: 1000 }] } as any;
    expect(applyStrengthSwaps(hyrox, swap('Trap-Bar Deadlift', 'Deadlift'))).toBe(hyrox);
  });

  it('leaves the line alone when the substitute is not a known pool exercise', () => {
    const wo = gym('3x5 Trap-Bar Deadlift @80% 1RM (Flat back) (3 min rest)');
    const out = applyStrengthSwaps(wo, swap('Trap-Bar Deadlift', 'Nonexistent Lift'));
    expect((out as any).d).toContain('Trap-Bar Deadlift');
  });
});
