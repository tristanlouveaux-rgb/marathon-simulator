import { describe, it, expect } from 'vitest';
import { parseStrengthSession, parseRestSeconds, isStrengthWorkout, parseHyroxSession, parseGuidedSession, strengthCardSummary } from './strength-model';
import type { Workout } from '@/types';
import type { HyroxComponent } from '@/types/triathlon';

const wk = (d: string, over: Partial<Workout> = {}): Workout =>
  ({ t: 'gym', n: 'Lower-body & core strength', d, ...over } as Workout);

describe('parseRestSeconds', () => {
  it('parses seconds and minutes, taking the lower bound of a range', () => {
    expect(parseRestSeconds('45s rest')).toBe(45);
    expect(parseRestSeconds('30s rest')).toBe(30);
    expect(parseRestSeconds('60-90s rest')).toBe(60);
    expect(parseRestSeconds('2-3 min rest')).toBe(120);
    expect(parseRestSeconds('90s rest')).toBe(90);
    expect(parseRestSeconds('no rest noted')).toBe(0);
    expect(parseRestSeconds('')).toBe(0);
  });
});

describe('parseStrengthSession', () => {
  const desc = [
    '3x12 Bodyweight Squat (Pain-free depth, controlled) (45s rest)',
    '3x10 each leg Reverse Lunge (bodyweight) (Steady, touch the back knee down lightly) (60s rest)',
    '3x10 Dead Bug (Slow, lower back flat) (30s rest)',
    'Stretch to finish: gentle range, nothing that aggravates the shoulder.',
  ].join('\n');

  it('expands each exercise into its set count', () => {
    const s = parseStrengthSession(wk(desc))!;
    expect(s).not.toBeNull();
    expect(s.exerciseCount).toBe(3);
    expect(s.sets).toHaveLength(9); // 3 exercises x 3 sets
  });

  it('parses reps, name, cue and rest per set', () => {
    const s = parseStrengthSession(wk(desc))!;
    const lunge = s.sets.find(x => x.exerciseName === 'Reverse Lunge')!;
    expect(lunge.reps).toBe('10 each leg');
    expect(lunge.restSec).toBe(60);
    expect(lunge.cue).toContain('Steady');
    expect(lunge.setCount).toBe(3);
  });

  it('labels sets within an exercise 0..n-1', () => {
    const s = parseStrengthSession(wk(desc))!;
    const squatSets = s.sets.filter(x => x.exerciseName === 'Bodyweight Squat');
    expect(squatSets.map(x => x.setIndex)).toEqual([0, 1, 2]);
  });

  it('captures the stretch line separately, not as a set', () => {
    const s = parseStrengthSession(wk(desc))!;
    expect(s.stretch).toMatch(/^Stretch/);
    expect(s.sets.some(x => /stretch/i.test(x.exerciseName))).toBe(false);
  });

  it('handles normal gym templates with loads and minute rests', () => {
    const s = parseStrengthSession(wk('3x5 Back Squat @80% 1RM (2 reps in reserve) (2-3 min rest)'))!;
    expect(s.sets).toHaveLength(3);
    // Display name strips the "@80% 1RM" garnish; the load marker survives only
    // as the weight-tracking liftKey.
    expect(s.sets[0].exerciseName).toBe('Back Squat');
    expect(s.sets[0].liftKey).toBe('back-squat');
    expect(s.sets[0].restSec).toBe(120);
  });

  it('leaves bodyweight / non-loaded movements without a liftKey', () => {
    const s = parseStrengthSession(wk('3x30s Front Plank (Flat back) (30s rest)'))!;
    expect(s.sets[0].liftKey).toBeUndefined();
    expect(s.sets[0].exerciseName).toBe('Front Plank');
  });

  it('treats a line with no Nx prefix as a single set', () => {
    const s = parseStrengthSession(wk('Core circuit: 30s plank + 20s side plank (No rest between)'))!;
    expect(s.sets).toHaveLength(1);
    expect(s.sets[0].exerciseName).toContain('Core circuit');
  });

  it('returns null for an empty description', () => {
    expect(parseStrengthSession(wk(''))).toBeNull();
  });
});

describe('parseHyroxSession', () => {
  const hx = (components: HyroxComponent[], name = 'HYROX session') =>
    ({ t: 'gym', n: name, d: '', hyroxComponents: components } as any as Workout);

  it('returns null when there are no components', () => {
    expect(parseHyroxSession(hx([]))).toBeNull();
  });

  it('maps each component to one single-set step', () => {
    const session = parseHyroxSession(hx([
      { type: 'run', distanceM: 1000, mtl: 0 },
      { type: 'wall_balls', reps: 100, mtl: 0 },
      { type: 'sled_push', distanceM: 50, mtl: 0 },
    ]))!;
    expect(session.exerciseCount).toBe(3);
    expect(session.sets).toHaveLength(3);
    expect(session.sets.every(s => s.setCount === 1)).toBe(true);
    expect(session.sets.every(s => s.setIndex === 0)).toBe(true);
    expect(session.sets.every(s => s.restSec === 0)).toBe(true); // HYROX continuous between components
  });

  it('labels stations with their display names and run distances', () => {
    const session = parseHyroxSession(hx([
      { type: 'run', distanceM: 1000, mtl: 0 },
      { type: 'wall_balls', reps: 100, mtl: 0 },
      { type: 'sled_push', distanceM: 50, mtl: 0 },
    ]))!;
    expect(session.sets[0].exerciseName).toBe('Run');
    expect(session.sets[0].reps).toMatch(/km/);
    expect(session.sets[1].exerciseName).toBe('Wall Balls');
    expect(session.sets[1].reps).toBe('100 reps');
    expect(session.sets[2].exerciseName).toBe('Sled Push');
  });

  it('expands the component list by hyroxRounds, reusing the original component index', () => {
    const w = {
      t: 'hyrox_station_density', n: 'Density', d: '',
      hyroxRounds: 3, hyroxRoundRestSec: 120,
      hyroxComponents: [
        { type: 'wall_balls', reps: 100, mtl: 0, restAfterSec: 30 },
        { type: 'row_erg', distanceM: 1000, mtl: 0, restAfterSec: 30 },
      ],
    } as any as Workout;
    const s = parseHyroxSession(w)!;
    expect(s.exerciseCount).toBe(2);                 // rings still group by station
    expect(s.sets).toHaveLength(6);                  // 3 rounds x 2 stations
    expect(s.sets.every(set => set.setCount === 3)).toBe(true);
    // exerciseIndex cycles 0,1,0,1,0,1 so the GPS bridge / rings resolve
    expect(s.sets.map(set => set.exerciseIndex)).toEqual([0, 1, 0, 1, 0, 1]);
    // setIndex carries the round number
    expect(s.sets.map(set => set.setIndex)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('applies inter-station rest within a round, inter-round rest between rounds, none on the last set', () => {
    const w = {
      t: 'hyrox_station_density', n: 'Density', d: '',
      hyroxRounds: 2, hyroxRoundRestSec: 120,
      hyroxComponents: [
        { type: 'wall_balls', reps: 100, mtl: 0, restAfterSec: 30 },
        { type: 'row_erg', distanceM: 1000, mtl: 0, restAfterSec: 30 },
      ],
    } as any as Workout;
    const s = parseHyroxSession(w)!;
    //         r0 WB  r0 Row   r1 WB  r1 Row
    expect(s.sets.map(set => set.restSec)).toEqual([30, 120, 30, 0]);
  });

  it('prescribed sessions use timed rest (not manual advance)', () => {
    const w = {
      t: 'hyrox_station_density', n: 'D', d: '', hyroxRounds: 2, hyroxRoundRestSec: 120,
      hyroxComponents: [{ type: 'wall_balls', reps: 100, mtl: 0, restAfterSec: 30 }],
    } as any as Workout;
    expect(parseHyroxSession(w)!.manualAdvance).toBe(false);
  });

  it('only the calibration assessment stays athlete-paced (manual advance)', () => {
    const w = {
      t: 'hyrox_assessment', n: 'Assessment', d: '', hyroxRounds: 1,
      hyroxComponents: [{ type: 'wall_balls', reps: 100, mtl: 0 }],
    } as any as Workout;
    expect(parseHyroxSession(w)!.manualAdvance).toBe(true);
  });

  it('defaults to one round when hyroxRounds is absent (backward compatible)', () => {
    const s = parseHyroxSession(hx([
      { type: 'wall_balls', reps: 100, mtl: 0 },
      { type: 'row_erg', distanceM: 1000, mtl: 0 },
    ]))!;
    expect(s.sets).toHaveLength(2);
    expect(s.sets.every(set => set.setCount === 1)).toBe(true);
  });
});

describe('parseGuidedSession (adapter)', () => {
  it('routes to the HYROX parser when hyroxComponents are present', () => {
    const w = { t: 'gym', n: 'HX', d: '', hyroxComponents: [
      { type: 'wall_balls', reps: 100, mtl: 0 },
    ] } as any as Workout;
    const s = parseGuidedSession(w)!;
    expect(s.sets[0].exerciseName).toBe('Wall Balls');
  });

  it('routes to the strength parser when only .d is present', () => {
    const w = { t: 'gym', n: 'Strength', d: '3x10 Bodyweight Squat (cue) (45s rest)' } as Workout;
    const s = parseGuidedSession(w)!;
    expect(s.sets).toHaveLength(3);
    expect(s.sets[0].exerciseName).toBe('Bodyweight Squat');
  });
});

describe('isStrengthWorkout', () => {
  it('matches gym/strength type or name', () => {
    expect(isStrengthWorkout(wk('x', { t: 'gym' }))).toBe(true);
    expect(isStrengthWorkout(wk('x', { t: 'strength' as any }))).toBe(true);
    expect(isStrengthWorkout(wk('x', { t: 'easy' as any, n: 'Upper-body strength' }))).toBe(true);
    expect(isStrengthWorkout(wk('x', { t: 'easy' as any, n: 'Easy run' }))).toBe(false);
  });
});

describe('strengthCardSummary', () => {
  const desc = [
    '3x12 Bodyweight Squat (Pain-free depth, controlled) (45s rest)',
    '3x10 each leg Reverse Lunge (bodyweight) (Steady) (60s rest)',
    '3x10 Dead Bug (Slow, lower back flat) (30s rest)',
    'Stretch to finish: gentle range, nothing that aggravates the shoulder.',
  ].join('\n');

  it('summarises a strength session as a "N exercises · tap to view" line (stretch excluded)', () => {
    expect(strengthCardSummary(wk(desc))).toBe('3 exercises · tap to view');
  });

  it('singularises for a one-exercise session', () => {
    expect(strengthCardSummary(wk('3x10 Bodyweight Squat (cue) (45s rest)'))).toBe('1 exercise · tap to view');
  });

  it('returns null for a non-strength workout so the caller renders its own description', () => {
    // A bike / cross-training substitute: single-line prose, not a strength session.
    expect(strengthCardSummary(wk('45 min steady, zone 2', { t: 'cross_training' as any, n: 'Cross-training: Bike' }))).toBeNull();
    expect(strengthCardSummary(wk('8 km easy', { t: 'easy' as any, n: 'Easy run' }))).toBeNull();
  });

  it('returns null for a strength workout with an empty description', () => {
    expect(strengthCardSummary(wk('', { t: 'gym' }))).toBeNull();
  });
});
