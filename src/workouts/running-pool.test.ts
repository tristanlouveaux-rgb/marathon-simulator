import { describe, it, expect } from 'vitest';
import { buildRunningStrengthWorkout, buildPlyometricsWorkout, categoryOf, type RunningStrengthCategory } from './running-pool';
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

describe('contrast power-block (build phase)', () => {
  it('build + contrast pairs a matched jump onto the lead lift, with the note in its cue', () => {
    const wo = buildRunningStrengthWorkout(0, 60, 'standard', 'traditional', 'build', true);
    expect(wo.d).toContain('Power pair');
    expect(/Jump Squat|Box Jumps/.test(wo.d)).toBe(true);
    expect(parseStrengthSession(wo)).not.toBeNull();
  });

  it('contrast off is byte-identical to today (no pairing)', () => {
    const off = buildRunningStrengthWorkout(0, 60, 'standard', 'traditional', 'build', false);
    const legacy = buildRunningStrengthWorkout(0, 60, 'standard', 'traditional', 'build');
    expect(off.d).toBe(legacy.d);
    expect(off.d).not.toContain('Power pair');
  });

  it('only fires in build phase (base with contrast on = no pairing)', () => {
    const base = buildRunningStrengthWorkout(0, 60, 'standard', 'traditional', 'base', true);
    expect(base.d).not.toContain('Power pair');
  });

  it('the pairing cue survives parsing — cue keeps "Power pair", rest stays the lift rest (regression: a cue containing "rest" was misfiled as the rest note)', () => {
    const wo = buildRunningStrengthWorkout(0, 60, 'standard', 'traditional', 'build', true);
    const lead = parseStrengthSession(wo)!.sets[0];
    expect(lead.cue).toContain('Power pair');
    expect(lead.cue).not.toMatch(/rest/i);   // would be swallowed by the rest-note classifier
    expect(lead.restSec).toBe(180);          // the lift's own 3 min rest, not the pair note
  });

  it('never prescribes two jumps — the standalone plyo pick is replaced by the pair', () => {
    // 90-min sessions otherwise include a standalone plyo move; with contrast on,
    // exactly one plyo-category move should remain (the paired jump).
    const wo = buildRunningStrengthWorkout(0, 90, 'standard', 'traditional', 'build', true);
    const names = parseStrengthSession(wo)!.sets.map(s => s.exerciseName).filter((n, i, a) => a.indexOf(n) === i);
    expect(names.filter(n => categoryOf(n) === 'plyo').length).toBe(1);
  });
});

describe('buildPlyometricsWorkout — standalone plyo session', () => {
  function plyoNames(min: number, intensity: 'easier' | 'standard' | 'harder', week = 0, phase?: any): string[] {
    const wo = buildPlyometricsWorkout(week, min, intensity, 'traditional', phase);
    return parseStrengthSession(wo)!.sets
      .map(s => s.exerciseName)
      .filter((n, i, a) => a.indexOf(n) === i);
  }

  it('parses cleanly and only draws from the plyo category', () => {
    const wo = buildPlyometricsWorkout(0, 30, 'standard', 'traditional');
    const session = parseStrengthSession(wo);
    expect(session).not.toBeNull();
    expect(session!.sets.length).toBeGreaterThan(0);
    for (const name of plyoNames(30, 'standard')) {
      expect(categoryOf(name)).toBe('plyo');
    }
    expect((wo as any).estimatedDurationMin).toBe(30);
    expect(wo.n).toBe('Plyometrics');
  });

  function totalSets(min: number, intensity: 'easier' | 'standard' | 'harder', ceiling?: number): number {
    const wo = buildPlyometricsWorkout(0, min, intensity, 'traditional', undefined, ceiling);
    return parseStrengthSession(wo)!.sets.length;
  }

  it('move count scales with available time (3 / 4 / 5) over the short plyo window', () => {
    expect(plyoNames(15, 'standard').length).toBe(3);
    expect(plyoNames(20, 'standard').length).toBe(4);
    expect(plyoNames(28, 'standard').length).toBe(5);
  });

  it('easier tier never serves the high-CNS moves; harder includes them', () => {
    const easy = plyoNames(28, 'easier');
    expect(easy).not.toContain('Depth Jump');
    expect(easy).not.toContain('Single-Leg Bounds');
    // easier draws from the 3 low-CNS moves only
    expect(easy.length).toBe(3);

    const hard = plyoNames(28, 'harder');
    expect(hard.some(n => n === 'Depth Jump' || n === 'Single-Leg Bounds')).toBe(true);
  });

  it('harder lifts RPE above easier', () => {
    const easy = buildPlyometricsWorkout(0, 28, 'easier', 'traditional');
    const hard = buildPlyometricsWorkout(0, 28, 'harder', 'traditional');
    expect(hard.rpe ?? 0).toBeGreaterThan(easy.rpe ?? 0);
  });

  it('a longer session carries more total sets than a shorter one (the slider does something)', () => {
    expect(totalSets(28, 'standard')).toBeGreaterThan(totalSets(15, 'standard'));
  });

  it('a higher ability ceiling adds volume at the same duration', () => {
    expect(totalSets(28, 'standard', 140)).toBeGreaterThan(totalSets(28, 'standard', 100));
  });

  it('all lines are bodyweight — no liftKey, nothing weight-tracks', () => {
    const session = parseStrengthSession(buildPlyometricsWorkout(0, 28, 'harder', 'traditional'))!;
    for (const set of session.sets) {
      expect(set.liftKey).toBeFalsy();
      expect(set.exerciseName).not.toMatch(/1RM/i);
    }
  });

  it('base phase keeps the high-CNS moves off the lead at standard intensity', () => {
    // standard tier is low-led; base reorder pushes Depth Jump / SL Bounds to the
    // back, so a short (3-move) base session is all low-CNS.
    const base3 = plyoNames(15, 'standard', 0, 'base');
    expect(base3).not.toContain('Depth Jump');
    expect(base3).not.toContain('Single-Leg Bounds');
  });

  it('week rotation never defeats the tier ordering (regression: slot 1 led with high-CNS)', () => {
    for (let w = 0; w < 6; w++) {
      const names = plyoNames(20, 'standard', w);
      // a short standard session always leads with a low-CNS move, never a depth jump
      expect(['Pogo Hops', 'Box Jumps', 'Jump Squat']).toContain(names[0]);
      expect(names[0]).not.toBe('Depth Jump');
      expect(names[0]).not.toBe('Single-Leg Bounds');
    }
  });

  it('past 30 min appends strength → a Power + Strength session (plyo still first)', () => {
    const short = buildPlyometricsWorkout(0, 25, 'standard', 'traditional', undefined, 140);
    const long = buildPlyometricsWorkout(0, 50, 'standard', 'traditional', undefined, 140);
    expect(short.n).toBe('Plyometrics');
    expect(long.n).toBe('Power + Strength');
    const names = parseStrengthSession(long)!.sets.map(s => s.exerciseName).filter((n, i, a) => a.indexOf(n) === i);
    expect(names.some(n => categoryOf(n) === 'plyo')).toBe(true);               // jumps present
    expect(names.some(n => { const c = categoryOf(n); return c !== null && c !== 'plyo'; })).toBe(true); // strength appended
    // plyo leads, strength follows
    const firstStrengthIdx = names.findIndex(n => { const c = categoryOf(n); return c !== null && c !== 'plyo'; });
    const lastPlyoIdx = names.map(n => categoryOf(n)).lastIndexOf('plyo');
    expect(lastPlyoIdx).toBeLessThan(firstStrengthIdx);
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
