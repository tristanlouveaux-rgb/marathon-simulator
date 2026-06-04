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

// ── Pace targets on descriptions (2026-06-04 "all workouts have pacings") ────

import {
  stripPaceTokens, retargetDescriptionPace, scaleWattRanges, setSwimPaceTokens, modDisplayDescription, displayDescWithPace,
} from './workout-scaling';
import { paceSecPerKmForRunType, RUN_PACE_FACTOR_VS_EASY } from './intent_to_workout';

const EASY = 370; // 6:10/km

describe('stripPaceTokens / pace-aware isSimpleDistanceDesc', () => {
  it('strips a bare pace target', () => {
    expect(stripPaceTokens('7km @ 6:10/km')).toBe('7km');
  });
  it('strips the MP wrapper and suggester annotations', () => {
    expect(stripPaceTokens('20km @ MP (4:55/km)')).toBe('20km');
    expect(stripPaceTokens('6.1km @ 5:33/km (steady)')).toBe('6.1km');
  });
  it('keeps a paced easy run classified as a simple distance run (km chip)', () => {
    expect(isSimpleDistanceDesc('7km @ 6:10/km')).toBe(true);
    expect(isSimpleDistanceDesc('6.1km @ 5:33/km (steady)')).toBe(true);
  });
  it('still classifies structured sessions as structured', () => {
    expect(isSimpleDistanceDesc('5×6min @ 4:30/km (~1.3km), 1 min recovery between sets')).toBe(false);
    expect(isSimpleDistanceDesc('13min @ 4:05/km (~3.2km)')).toBe(false);
  });
});

describe('paceSecPerKmForRunType', () => {
  it('derives the canonical per-type paces from easy pace', () => {
    expect(paceSecPerKmForRunType('easy', EASY)).toBe(EASY);
    expect(paceSecPerKmForRunType('vo2', EASY)).toBeCloseTo(EASY * 0.809);
    expect(paceSecPerKmForRunType('threshold', EASY)).toBeCloseTo(EASY / 1.2);
    expect(paceSecPerKmForRunType('marathon', EASY)).toBeCloseTo(EASY * 0.913);
    expect(paceSecPerKmForRunType('marathon_pace', EASY)).toBe(paceSecPerKmForRunType('marathon', EASY));
  });
  it('returns null without easy pace or for unmapped types', () => {
    expect(paceSecPerKmForRunType('vo2', undefined)).toBeNull();
    expect(paceSecPerKmForRunType('rest', EASY)).toBeNull();
  });
  it('ladder type names and plan-engine slot names share factors', () => {
    expect(RUN_PACE_FACTOR_VS_EASY['marathon']).toBe(RUN_PACE_FACTOR_VS_EASY['marathon_pace']);
  });
});

describe('retargetDescriptionPace', () => {
  it('replaces a bare pace on a simple run (easy → vo2)', () => {
    // 370 * 0.809 = 299.3 → 4:59/km
    expect(retargetDescriptionPace('7km @ 6:10/km', 'vo2', EASY)).toBe('7km @ 4:59/km');
  });
  it('appends a pace to a legacy pace-less distance run', () => {
    expect(retargetDescriptionPace('6km', 'vo2', EASY)).toBe('6km @ 4:59/km');
  });
  it('uses the MP wrapper when retargeting to marathon', () => {
    // 370 * 0.913 = 337.8 → 5:37/km
    expect(retargetDescriptionPace('7km @ 6:10/km', 'marathon', EASY)).toBe('7km @ MP (5:37/km)');
  });
  it('unwraps MP when stepping away from marathon pace', () => {
    expect(retargetDescriptionPace('22min @ MP (5:37/km)', 'threshold', EASY)).toBe('22min @ 5:08/km');
  });
  it('drops a stale suggester annotation', () => {
    expect(retargetDescriptionPace('6.1km @ 5:33/km (steady)', 'easy', EASY)).toBe('6.1km @ 6:10/km');
  });
  it('recomputes interval distance hints at the new pace', () => {
    // threshold 370/1.2 = 308.3 → 5:08/km; 6min at 5:08 = 1.2km
    const out = retargetDescriptionPace('5×6min @ 4:30/km (~1.3km), 1 min recovery between sets', 'threshold', EASY);
    expect(out).toContain('5×6min @ 5:08/km (~1.2km)');
  });
  it('leaves warm-up/cool-down easy anchors untouched', () => {
    const desc = '2km warm up (6:10/km+)\n13min @ 5:08/km (~2.5km)\n2km cool down (6:10/km+)';
    const out = retargetDescriptionPace(desc, 'vo2', EASY);
    expect(out).toContain('(6:10/km+)');
    expect(out).toContain('@ 4:59/km');
  });
  it('no-ops without easy pace or for unmapped types', () => {
    expect(retargetDescriptionPace('7km @ 6:10/km', 'vo2', undefined)).toBe('7km @ 6:10/km');
    expect(retargetDescriptionPace('7km @ 6:10/km', 'rest', EASY)).toBe('7km @ 6:10/km');
  });
});

describe('scaleWattRanges', () => {
  it('scales every watt range by the rung ratio', () => {
    // endurance 0.65 → tempo 0.82: ratio ≈ 1.2615
    const ratio = 0.82 / 0.65;
    expect(scaleWattRanges('60min steady @ 146–179W. Conversational throughout.', ratio))
      .toBe('60min steady @ 184–226W. Conversational throughout.');
  });
  it('scales multi-segment sessions per token (over-unders keep their shape)', () => {
    const out = scaleWattRanges('3×(3min @ 250–270W → 3min @ 230–250W)', 0.5);
    expect(out).toBe('3×(3min @ 125–135W → 3min @ 115–125W)');
  });
  it('no-ops on ratio 1, bad ratios, and watt-less descriptions', () => {
    expect(scaleWattRanges('60min @ 146–179W', 1)).toBe('60min @ 146–179W');
    expect(scaleWattRanges('60min @ 146–179W', 0)).toBe('60min @ 146–179W');
    expect(scaleWattRanges('Z2 endurance (HR Z2)', 1.2)).toBe('Z2 endurance (HR Z2)');
  });
});

describe('setSwimPaceTokens', () => {
  it('replaces absolute swim paces with the rung target', () => {
    // CSS 98s, rung speed offset −6 → 92s = 1:32/100m
    expect(setSwimPaceTokens('Main: 10×100m @ 1:38/100m (CSS), 15s rest.', 92))
      .toBe('Main: 10×100m @ 1:32/100m, 15s rest.');
  });
  it('drops the stale (CSS) annotation but leaves structure intact', () => {
    const out = setSwimPaceTokens('2000m total. Main: 8×200m @ 1:38/100m (CSS), 25s rest.', 104);
    expect(out).toBe('2000m total. Main: 8×200m @ 1:44/100m, 25s rest.');
  });
  it('no-ops on invalid pace', () => {
    expect(setSwimPaceTokens('Main: 8×200m @ 1:38/100m', 0)).toBe('Main: 8×200m @ 1:38/100m');
  });
});

describe('modDisplayDescription', () => {
  it('retargets user-scale mods with an intensity change (heals stale pace-less mods)', () => {
    const mod = { newDistance: '6km', newType: 'vo2', userScaledAt: '2026-06-01T00:00:00Z' };
    expect(modDisplayDescription(mod, EASY)).toBe('6km @ 4:59/km');
  });
  it('passes duration-only user mods through untouched', () => {
    const mod = { newDistance: '5.6km @ 6:10/km', userScaledAt: '2026-06-01T00:00:00Z' };
    expect(modDisplayDescription(mod, EASY)).toBe('5.6km @ 6:10/km');
  });
  it('passes non-user mods (timing / coach / auto) through untouched', () => {
    const mod = { newDistance: '6.1km @ 5:33/km (steady)', newType: 'marathon_pace' };
    expect(modDisplayDescription(mod, EASY)).toBe('6.1km @ 5:33/km (steady)');
  });
});

describe('displayDescWithPace', () => {
  it('appends the type pace to a persisted bare-distance adhoc', () => {
    expect(displayDescWithPace('7km', 'easy', EASY)).toBe('7km @ 6:10/km');
  });
  it('handles coach/auto reductions, keeping the (was …) suffix', () => {
    expect(displayDescWithPace('4km (was 6.1km)', 'easy', EASY)).toBe('4km @ 6:10/km (was 6.1km)');
  });
  it('replaces the redundant easy/steady word with the actual pace', () => {
    expect(displayDescWithPace('4km easy', 'easy', EASY)).toBe('4km @ 6:10/km');
  });
  it('leaves descriptions that already carry a target untouched', () => {
    expect(displayDescWithPace('7km @ 6:10/km', 'easy', EASY)).toBe('7km @ 6:10/km');
    expect(displayDescWithPace('6.1km @ 5:33/km (steady)', 'marathon_pace', EASY)).toBe('6.1km @ 5:33/km (steady)');
  });
  it('no-ops for structured shapes, unmapped types, and unknown easy pace', () => {
    expect(displayDescWithPace('5×6min @ threshold, 1min rest', 'threshold', EASY)).toBe('5×6min @ threshold, 1min rest');
    expect(displayDescWithPace('7km', 'gym', EASY)).toBe('7km');
    expect(displayDescWithPace('7km', 'easy', undefined)).toBe('7km');
  });
});
