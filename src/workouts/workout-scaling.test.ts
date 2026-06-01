import { describe, it, expect } from 'vitest';
import {
  parseDistanceKm, hasScalableToken, supportsDurationScale, isSimpleDistanceDesc,
  scaleDescriptionProportional, scaleDurationMin, stepIntensity, canStepIntensity,
  findWorkoutForMod,
  DURATION_SCALE_MIN, DURATION_SCALE_MAX, LESS_TIME_FACTOR,
} from './workout-scaling';

describe('parseDistanceKm', () => {
  it('reads the leading km distance', () => {
    expect(parseDistanceKm('8km')).toBe(8);
    expect(parseDistanceKm('8 km easy')).toBe(8);
    expect(parseDistanceKm('10.5km')).toBe(10.5);
  });
  it('returns null when there is no km token', () => {
    expect(parseDistanceKm('6x800m')).toBeNull();
    expect(parseDistanceKm('')).toBeNull();
    expect(parseDistanceKm(undefined)).toBeNull();
  });
});

describe('isSimpleDistanceDesc', () => {
  it('is true for distance-primary runs', () => {
    expect(isSimpleDistanceDesc('8km')).toBe(true);
    expect(isSimpleDistanceDesc('8km easy')).toBe(true);
    expect(isSimpleDistanceDesc('21km long run')).toBe(true);
  });
  it('is false for structured / interval / minutes sessions', () => {
    expect(isSimpleDistanceDesc('5x1km @ threshold')).toBe(false);
    expect(isSimpleDistanceDesc('2km warm up 13min @ 3:52/km 2km cool down')).toBe(false);
    expect(isSimpleDistanceDesc('6x800m')).toBe(false);
    expect(isSimpleDistanceDesc('30min easy')).toBe(false);
  });
});

describe('hasScalableToken / supportsDurationScale', () => {
  it('detects km, min, and bare metres', () => {
    expect(hasScalableToken('8km')).toBe(true);
    expect(hasScalableToken('30min easy')).toBe(true);
    expect(hasScalableToken('6x800m')).toBe(true);
    expect(supportsDurationScale('2km warm up 13min @ 3:52/km 2km cool down')).toBe(true);
  });
  it('is false for an empty / pace-only string', () => {
    expect(hasScalableToken('')).toBe(false);
    expect(hasScalableToken(undefined)).toBe(false);
  });
});

describe('scaleDescriptionProportional', () => {
  it('scales km and min tokens, leaves paces untouched', () => {
    const out = scaleDescriptionProportional('2km warm up (4:39/km+) 13min @ 3:52/km (~3.3km) 2km cool down (4:39/km+)', 0.5);
    // distances and durations halve; paces unchanged
    expect(out).toContain('1km warm up');
    expect(out).toContain('7min @ 3:52/km'); // 13 * 0.5 = 6.5 -> 7
    expect(out).toContain('(~1.7km)');       // 3.3 * 0.5 = 1.65 -> 1.7
    expect(out).toContain('1km cool down');
    expect(out).toContain('4:39/km');        // pace preserved
    expect(out).toContain('3:52/km');        // pace preserved
  });
  it('scales a simple distance run', () => {
    expect(scaleDescriptionProportional('8km easy', LESS_TIME_FACTOR)).toBe('6km easy');
  });
  it('scales bare-metre rep distances', () => {
    expect(scaleDescriptionProportional('6x800m', 0.5)).toBe('6x400m');
  });
  it('clamps the factor to the bounds', () => {
    expect(scaleDescriptionProportional('10km', 0.1)).toBe('5km');   // factor clamps to 0.50
    expect(scaleDescriptionProportional('10km', 5)).toBe('11.5km');  // factor clamps to 1.15
  });
});

describe('scaleDurationMin', () => {
  it('scales minutes by clamped factor', () => {
    expect(scaleDurationMin(40, LESS_TIME_FACTOR)).toBe(30);
    expect(scaleDurationMin(40, 0.1)).toBe(Math.round(40 * DURATION_SCALE_MIN));
    expect(scaleDurationMin(40, 2)).toBe(Math.round(40 * DURATION_SCALE_MAX));
  });
});

describe('stepIntensity / canStepIntensity', () => {
  it('steps one notch along the ladder', () => {
    expect(stepIntensity('threshold', 'easier')).toBe('marathon');
    expect(stepIntensity('threshold', 'harder')).toBe('vo2');
    expect(stepIntensity('easy', 'harder')).toBe('marathon');
  });
  it('does not step past the ladder ends', () => {
    expect(stepIntensity('easy', 'easier')).toBe('easy');
    expect(stepIntensity('vo2', 'harder')).toBe('vo2');
    expect(canStepIntensity('easy', 'easier')).toBe(false);
    expect(canStepIntensity('vo2', 'harder')).toBe(false);
    expect(canStepIntensity('threshold', 'easier')).toBe(true);
  });
  it('handles long runs and off-ladder types', () => {
    expect(stepIntensity('long', 'easier')).toBe('easy');
    expect(stepIntensity('long', 'harder')).toBe('long');
    expect(stepIntensity('recovery', 'harder')).toBe('recovery');
  });
});

describe('findWorkoutForMod (mod re-attachment on render)', () => {
  const week = () => ([
    { id: 'W3-easy-0', n: 'Easy Run', dayOfWeek: 0 },
    { id: 'W3-easy-1', n: 'Easy Run', dayOfWeek: 2 },
    { id: 'W3-threshold-0', n: 'Threshold 2×12', dayOfWeek: 1 },
  ]);

  it('matches by stable id even after dayOfWeek reshuffles (the revert bug)', () => {
    // User adjusted the Monday easy run; on a later session the scheduler moved it
    // to Wednesday (day 0 -> 4). name+day alone would miss; the id still finds it.
    const mod = { workoutId: 'W3-easy-0', name: 'Easy Run', dayOfWeek: 0 };
    const reshuffled = week();
    reshuffled[0].dayOfWeek = 4;
    expect(findWorkoutForMod(reshuffled, mod)?.id).toBe('W3-easy-0');
  });

  it('disambiguates same-named runs by id, not by colliding name', () => {
    const mod = { workoutId: 'W3-easy-1', name: 'Easy Run', dayOfWeek: 2 };
    expect(findWorkoutForMod(week(), mod)?.id).toBe('W3-easy-1');
  });

  it('falls back to name+day for legacy mods with no workoutId', () => {
    const mod = { name: 'Easy Run', dayOfWeek: 2 };
    expect(findWorkoutForMod(week(), mod)?.id).toBe('W3-easy-1');
  });

  it('falls back to name+day when the id no longer exists (run count shifted)', () => {
    const mod = { workoutId: 'W3-easy-9', name: 'Threshold 2×12', dayOfWeek: 1 };
    expect(findWorkoutForMod(week(), mod)?.id).toBe('W3-threshold-0');
  });

  it('returns undefined when nothing matches', () => {
    const mod = { workoutId: 'W3-vo2-0', name: 'VO2', dayOfWeek: 5 };
    expect(findWorkoutForMod(week(), mod)).toBeUndefined();
  });
});
