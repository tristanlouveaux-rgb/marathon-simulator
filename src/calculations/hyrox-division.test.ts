/**
 * HYROX division → load tier (26/27 Singles rulebook s4.1, s8.8; Doubles
 * rulebook s4.1, s8.8). Every division the rulebooks define, plus the
 * fallbacks for unknown sex and the invalid Pro Mixed combination.
 */
import { describe, it, expect } from 'vitest';
import {
  hyroxLoadTier,
  hyroxDivisionOptions,
  resolveHyroxDivision,
  resolveHyroxAthleteSex,
  hyroxWallBallTargetM,
  hyroxLoadTierForState,
  hyroxDivisionLabel,
  hyroxLoadsSentence,
  HYROX_DEFAULT_LOAD_TIER,
} from './hyrox-division';
import { HYROX_LOAD_TIER_KG, stationExternalLoadKg, STATION_DISPLAY, WALL_BALL_TARGET_M } from '@/constants/hyrox-benchmarks';

describe('hyroxLoadTier: singles', () => {
  it('Women Open races W-Open', () => {
    expect(hyroxLoadTier('open_singles', 'female')).toBe('W-Open');
  });
  it('Men Open races M-Open', () => {
    expect(hyroxLoadTier('open_singles', 'male')).toBe('M-Open');
  });
  it('Women Pro races the Men Open tier', () => {
    expect(hyroxLoadTier('pro_singles', 'female')).toBe('M-Open');
  });
  it('Men Pro races M-Pro', () => {
    expect(hyroxLoadTier('pro_singles', 'male')).toBe('M-Pro');
  });
  it('biological sex wins over a singles division pick (rankings use sex at birth)', () => {
    expect(hyroxLoadTier('open_singles', 'female', 'men')).toBe('W-Open');
  });
  it('the singles pick fills the gap when sex is prefer_not_to_say or unset', () => {
    expect(hyroxLoadTier('open_singles', 'prefer_not_to_say', 'women')).toBe('W-Open');
    expect(hyroxLoadTier('pro_singles', undefined, 'men')).toBe('M-Pro');
    expect(hyroxLoadTier('pro_singles', undefined, 'women')).toBe('M-Open');
  });
  it('unknown sex and no pick falls back to the default tier', () => {
    expect(hyroxLoadTier('open_singles', undefined)).toBe(HYROX_DEFAULT_LOAD_TIER);
    expect(hyroxLoadTier('pro_singles', 'prefer_not_to_say')).toBe(HYROX_DEFAULT_LOAD_TIER);
  });
});

describe('hyroxLoadTier: doubles', () => {
  it('Doubles Women races W-Open', () => {
    expect(hyroxLoadTier('open_doubles', 'female', 'women')).toBe('W-Open');
  });
  it('Doubles Men races M-Open', () => {
    expect(hyroxLoadTier('open_doubles', 'male', 'men')).toBe('M-Open');
  });
  it('Doubles Mixed races M-Open for both partners, the woman included', () => {
    expect(hyroxLoadTier('open_doubles', 'female', 'mixed')).toBe('M-Open');
    expect(hyroxLoadTier('open_doubles', 'male', 'mixed')).toBe('M-Open');
    expect(hyroxLoadTier('open_doubles', undefined, 'mixed')).toBe('M-Open');
  });
  it('Doubles Women Pro races M-Open; Doubles Men Pro races M-Pro', () => {
    expect(hyroxLoadTier('pro_doubles', 'female', 'women')).toBe('M-Open');
    expect(hyroxLoadTier('pro_doubles', 'male', 'men')).toBe('M-Pro');
  });
  it('a doubles pick wins over biological sex (the division is the pair category)', () => {
    expect(hyroxLoadTier('open_doubles', 'female', 'men')).toBe('M-Open');
  });
  it('no pick: doubles division defaults from biological sex', () => {
    expect(hyroxLoadTier('open_doubles', 'female')).toBe('W-Open');
    expect(hyroxLoadTier('pro_doubles', 'male')).toBe('M-Pro');
  });
  it('Mixed under Pro doubles is invalid (no Pro Mixed) and resolves from sex', () => {
    expect(resolveHyroxDivision('pro_doubles', 'female', 'mixed')).toBe('women');
    expect(hyroxLoadTier('pro_doubles', 'female', 'mixed')).toBe('M-Open');
    expect(hyroxLoadTier('pro_doubles', 'male', 'mixed')).toBe('M-Pro');
    expect(hyroxLoadTier('pro_doubles', undefined, 'mixed')).toBe(HYROX_DEFAULT_LOAD_TIER);
  });
});

describe('hyroxDivisionOptions (what the setup screen asks)', () => {
  it('Open doubles offers Women / Men / Mixed', () => {
    expect(hyroxDivisionOptions('open_doubles', 'male')).toEqual(['women', 'men', 'mixed']);
  });
  it('Pro doubles hides Mixed', () => {
    expect(hyroxDivisionOptions('pro_doubles', 'female')).toEqual(['women', 'men']);
  });
  it('singles asks only when biological sex is unknown', () => {
    expect(hyroxDivisionOptions('open_singles', 'female')).toBeNull();
    expect(hyroxDivisionOptions('pro_singles', 'male')).toBeNull();
    expect(hyroxDivisionOptions('open_singles', 'prefer_not_to_say')).toEqual(['women', 'men']);
    expect(hyroxDivisionOptions('pro_singles', undefined)).toEqual(['women', 'men']);
  });
});

describe('wall-ball target by the thrower\'s sex', () => {
  it('2.70 m for women (Women Pro and Mixed included), 3.00 m for men', () => {
    expect(hyroxWallBallTargetM('female')).toBe(2.70);
    expect(hyroxWallBallTargetM('male')).toBe(3.00);
    expect(hyroxWallBallTargetM('female', 'mixed')).toBe(2.70);
    expect(hyroxWallBallTargetM('male', 'mixed')).toBe(3.00);
  });
  it('a single-sex division pick supplies the sex when biological sex is unknown', () => {
    expect(hyroxWallBallTargetM('prefer_not_to_say', 'women')).toBe(2.70);
    expect(resolveHyroxAthleteSex(undefined, 'men')).toBe('male');
  });
  it('a Mixed pair with no biological sex has no known target', () => {
    expect(hyroxWallBallTargetM(undefined, 'mixed')).toBeNull();
  });
});

describe('HYROX_LOAD_TIER_KG matches the 26/27 rulebook', () => {
  it('W-Open / M-Open / M-Pro loads', () => {
    expect(HYROX_LOAD_TIER_KG['W-Open']).toEqual({ sledPush: 102, sledPull: 78, farmerPerHand: 16, sandbag: 10, wallBall: 4 });
    expect(HYROX_LOAD_TIER_KG['M-Open']).toEqual({ sledPush: 152, sledPull: 103, farmerPerHand: 24, sandbag: 20, wallBall: 6 });
    expect(HYROX_LOAD_TIER_KG['M-Pro']).toEqual({ sledPush: 202, sledPull: 153, farmerPerHand: 32, sandbag: 30, wallBall: 9 });
    expect(WALL_BALL_TARGET_M).toEqual({ female: 2.70, male: 3.00 });
  });
  it('wall balls are 100 reps in every division', () => {
    expect(STATION_DISPLAY.wall_balls.distance).toBe('100 reps');
  });
});

describe('stationExternalLoadKg derives from the tier (sleds = 0.5 × sled weight)', () => {
  it('W-Open', () => {
    expect(stationExternalLoadKg('W-Open')).toEqual({
      sled_push: 51, sled_pull: 39, farmer_carry: 16, sandbag_lunges: 10, wall_balls: 4,
    });
  });
  it('M-Open', () => {
    expect(stationExternalLoadKg('M-Open')).toEqual({
      sled_push: 76, sled_pull: 51.5, farmer_carry: 24, sandbag_lunges: 20, wall_balls: 6,
    });
  });
  it('M-Pro', () => {
    expect(stationExternalLoadKg('M-Pro')).toEqual({
      sled_push: 101, sled_pull: 76.5, farmer_carry: 32, sandbag_lunges: 30, wall_balls: 9,
    });
  });
  it('ergs and burpee broad jumps carry no external load', () => {
    const loads = stationExternalLoadKg('M-Pro');
    expect(loads.ski_erg).toBeUndefined();
    expect(loads.row_erg).toBeUndefined();
    expect(loads.burpee_broad_jumps).toBeUndefined();
  });
});

describe('state helpers and copy', () => {
  it('hyroxLoadTierForState reads format, division and biological sex', () => {
    expect(hyroxLoadTierForState({ biologicalSex: 'female', hyroxConfig: { format: 'pro_singles' } })).toBe('M-Open');
    expect(hyroxLoadTierForState({ biologicalSex: 'female', hyroxConfig: { format: 'open_doubles', division: 'mixed' } })).toBe('M-Open');
    expect(hyroxLoadTierForState({ biologicalSex: 'female' })).toBe('W-Open');
    expect(hyroxLoadTierForState({})).toBe(HYROX_DEFAULT_LOAD_TIER);
  });
  it('division labels', () => {
    expect(hyroxDivisionLabel('pro_singles', 'female')).toBe('Women Pro');
    expect(hyroxDivisionLabel('open_doubles', 'male', 'mixed')).toBe('Doubles Mixed');
    expect(hyroxDivisionLabel('pro_doubles', 'male')).toBe('Doubles Men Pro');
    expect(hyroxDivisionLabel('open_singles', undefined)).toBeNull();
  });
  it('the Women Pro load sentence gives the Women Pro loads, not the Men Pro ones', () => {
    const line = hyroxLoadsSentence(hyroxLoadTier('pro_singles', 'female'), hyroxWallBallTargetM('female'));
    expect(line).toBe('sled push 152 kg, sled pull 103 kg, farmers carry 2 × 24 kg, sandbag 20 kg, wall ball 6 kg to 2.70 m');
    expect(line).not.toContain('202');
  });
  it('the Men Pro load sentence', () => {
    const line = hyroxLoadsSentence(hyroxLoadTier('pro_singles', 'male'), hyroxWallBallTargetM('male'));
    expect(line).toBe('sled push 202 kg, sled pull 153 kg, farmers carry 2 × 32 kg, sandbag 30 kg, wall ball 9 kg to 3.00 m');
  });
});
