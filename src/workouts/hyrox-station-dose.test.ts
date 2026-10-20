/**
 * HYROX station dosing (lane H2b part 1, hyrox-station-dose.ts): the
 * race-pace volume progression, the doubles split, the beginner load schedule
 * and its RPE autoregulation (strength-progression's suggestNextWeight), and
 * the brick station rounds. Pure functions; the parameter sheet of 2026-10-12
 * (revised) and Tristan's progressive-load decision of the same day.
 */
import { describe, it, expect } from 'vitest';
import {
  HYROX_STATION_SET_FRACTION, HYROX_STATION_FORMATS, HYROX_BEGINNER_LOADS, HYROX_BRICK_FORMATS,
  hyroxStationSetAmount, hyroxRacePaceSets, hyroxTechniqueSets, hyroxDoublesSets,
  hyroxBeginnerRaceWeightWeek, hyroxBeginnerLoadFraction, hyroxLoadKgAt, hyroxRaceLoadKg,
  hyroxRpeToRir, hyroxBeginnerStationLoadKg, hyroxBrickStationRounds,
} from './hyrox-station-dose';
import { STRENGTH_MIN_INCREMENT_KG } from '@/constants/strength-constants';

describe('station sets and formats', () => {
  it('a set is a quarter of the race volume: the sheet\'s 0.25 x column', () => {
    expect(HYROX_STATION_SET_FRACTION).toBe(0.25);
    expect(hyroxStationSetAmount('ski_erg')).toBe(250);
    expect(hyroxStationSetAmount('row_erg')).toBe(250);
    expect(hyroxStationSetAmount('sled_push')).toBe(12.5); // one race lane
    expect(hyroxStationSetAmount('sled_pull')).toBe(12.5);
    expect(hyroxStationSetAmount('burpee_broad_jumps')).toBe(20);
    expect(hyroxStationSetAmount('farmer_carry')).toBe(50);
    expect(hyroxStationSetAmount('sandbag_lunges')).toBe(25);
    expect(hyroxStationSetAmount('wall_balls')).toBe(25);
  });

  it('technique 0.5 x at RPE 5 with 2 min rest; race pace 1.0 x at RPE 7 with 90 s rest', () => {
    expect(HYROX_STATION_FORMATS.technique).toEqual({ volumeFraction: 0.5, rpe: 5, restSec: 120 });
    expect(HYROX_STATION_FORMATS.race_pace).toEqual({ volumeFraction: 1.0, rpe: 7, restSec: 90 });
    expect(hyroxTechniqueSets(false)).toBe(2);
  });

  it('race-pace sets step from the technique dose to the race dose as the week grows toward peak, to the nearest quarter (Tristan 2026-10-20)', () => {
    expect(hyroxRacePaceSets(0.55, false)).toBe(2); // base week 1
    expect(hyroxRacePaceSets(0.62, false)).toBe(2);
    expect(hyroxRacePaceSets(0.625, false)).toBe(3); // 2.5 sets round up
    expect(hyroxRacePaceSets(0.85, false)).toBe(3); // base at its top
    expect(hyroxRacePaceSets(0.87, false)).toBe(3);
    expect(hyroxRacePaceSets(0.875, false)).toBe(4); // 1.0 x from 0.875 of peak
    expect(hyroxRacePaceSets(0.92, false)).toBe(4); // build: the sheet's 1.0 x (floor() held it at 3)
    expect(hyroxRacePaceSets(0.92 * 0.75, false)).toBe(3); // a build deload
    expect(hyroxRacePaceSets(0.55 * 0.75, false)).toBe(2); // a base deload
    expect(hyroxRacePaceSets(1.0, false)).toBe(4); // peak: the full race volume
    expect(hyroxRacePaceSets(1.15, false)).toBe(4); // never above the race dose
    expect(hyroxRacePaceSets(0, false)).toBe(2); // never under the technique dose
    expect(hyroxRacePaceSets(Number.NaN, false)).toBe(4);
  });

  it('doubles train half of every station: half the sets, rounded up to a whole set', () => {
    expect(hyroxDoublesSets(4)).toBe(2);
    expect(hyroxDoublesSets(3)).toBe(2);
    expect(hyroxDoublesSets(2)).toBe(1);
    expect(hyroxDoublesSets(1)).toBe(1);
    expect(hyroxTechniqueSets(true)).toBe(1);
    expect(hyroxRacePaceSets(0.55, true)).toBe(1);
    expect(hyroxRacePaceSets(0.92, true)).toBe(2);
    expect(hyroxRacePaceSets(1.0, true)).toBe(2);
  });
});

describe('the beginner load schedule', () => {
  it('race weight from 4 weeks before race week, never inside the unloaded sled weeks', () => {
    expect(hyroxBeginnerRaceWeightWeek(16)).toBe(12);
    expect(hyroxBeginnerRaceWeightWeek(8)).toBe(4);
    expect(hyroxBeginnerRaceWeightWeek(6)).toBe(HYROX_BEGINNER_LOADS.sledUnloadedWeeks + 1);
    expect(hyroxBeginnerRaceWeightWeek(2)).toBe(3);
  });

  it('sleds unloaded in weeks 1 and 2, then 50%; the other loaded stations 60%; race weight from the race-weight week', () => {
    const rw = 12;
    expect(hyroxBeginnerLoadFraction('sled_push', 1, rw)).toBe(0);
    expect(hyroxBeginnerLoadFraction('sled_pull', 2, rw)).toBe(0);
    expect(hyroxBeginnerLoadFraction('sled_push', 3, rw)).toBe(0.5);
    expect(hyroxBeginnerLoadFraction('sled_pull', 11, rw)).toBe(0.5);
    expect(hyroxBeginnerLoadFraction('sled_push', 12, rw)).toBe(1);
    for (const st of ['farmer_carry', 'sandbag_lunges', 'wall_balls'] as const) {
      expect(hyroxBeginnerLoadFraction(st, 1, rw)).toBe(0.6);
      expect(hyroxBeginnerLoadFraction(st, 11, rw)).toBe(0.6);
      expect(hyroxBeginnerLoadFraction(st, 12, rw)).toBe(1);
    }
    for (const st of ['ski_erg', 'row_erg', 'burpee_broad_jumps'] as const) expect(hyroxBeginnerLoadFraction(st, 5, rw)).toBeNull();
  });

  it('a sled load rounds down to the 2.5 kg plate step; an implement keeps the exact figure', () => {
    expect(hyroxLoadKgAt('sled_push', 'W-Open', 0.5)).toBe(50); // 51 kg, at or below
    expect(hyroxLoadKgAt('sled_pull', 'M-Open', 0.5)).toBe(50); // 51.5 kg
    expect(hyroxLoadKgAt('sled_pull', 'M-Pro', 0.5)).toBe(75); // 76.5 kg
    expect(hyroxLoadKgAt('sled_push', 'W-Open', 0)).toBe(0); // unloaded
    expect(hyroxLoadKgAt('farmer_carry', 'W-Open', 0.6)).toBe(9.6);
    expect(hyroxLoadKgAt('sandbag_lunges', 'M-Open', 0.6)).toBe(12);
    expect(hyroxLoadKgAt('wall_balls', 'W-Open', 0.6)).toBe(2.4);
    expect(hyroxLoadKgAt('wall_balls', 'M-Pro', 1)).toBe(9);
    expect(hyroxLoadKgAt('ski_erg', 'M-Pro', 1)).toBeNull();
  });

  it('race loads follow the load tier (26/27 rulebook s4.1)', () => {
    expect(hyroxRaceLoadKg('sled_push', 'W-Open')).toBe(102);
    expect(hyroxRaceLoadKg('sled_pull', 'M-Open')).toBe(103);
    expect(hyroxRaceLoadKg('farmer_carry', 'M-Pro')).toBe(32);
    expect(hyroxRaceLoadKg('row_erg', 'M-Pro')).toBeNull();
  });
});

describe('RPE autoregulation, as strength-progression\'s suggestNextWeight', () => {
  const base = {
    station: 'sled_push' as const, loadTier: 'W-Open' as const, weekIndex: 5, raceWeightWeek: 12,
    phase: 'build' as const, deload: false, injuryKind: 'normal' as const,
  };

  it('a session rated easier than its target RPE climbs one step (2.5%, at least one 2.5 kg plate)', () => {
    expect(hyroxRpeToRir(4, 5)).toBe('reps-left');
    expect(hyroxBeginnerStationLoadKg({ ...base, memory: { kg: 50, ratedRpe: 4, targetRpe: 5 } })).toBe(50 + STRENGTH_MIN_INCREMENT_KG);
    // Base climbs too.
    expect(hyroxBeginnerStationLoadKg({ ...base, phase: 'base', memory: { kg: 50, ratedRpe: 3, targetRpe: 5 } })).toBe(52.5);
    // An implement steps by at least one plate too.
    expect(hyroxBeginnerStationLoadKg({ ...base, station: 'farmer_carry', memory: { kg: 9.6, ratedRpe: 4, targetRpe: 5 } })).toBeCloseTo(12.1, 9);
  });

  it('on target or harder, or unrated: hold', () => {
    expect(hyroxRpeToRir(5, 5)).toBe('about-right');
    expect(hyroxRpeToRir(7, 5)).toBe('barely');
    expect(hyroxRpeToRir(undefined, 5)).toBeUndefined();
    expect(hyroxBeginnerStationLoadKg({ ...base, memory: { kg: 55, ratedRpe: 5, targetRpe: 5 } })).toBe(55);
    expect(hyroxBeginnerStationLoadKg({ ...base, memory: { kg: 55, ratedRpe: 8, targetRpe: 5 } })).toBe(55);
    expect(hyroxBeginnerStationLoadKg({ ...base, memory: { kg: 55, targetRpe: 5 } })).toBe(55);
  });

  it('peak, taper and deload weeks hold; an injury suppresses the climb', () => {
    const easy = { kg: 55, ratedRpe: 3, targetRpe: 5 };
    expect(hyroxBeginnerStationLoadKg({ ...base, phase: 'peak', memory: easy })).toBe(55);
    expect(hyroxBeginnerStationLoadKg({ ...base, phase: 'taper', memory: easy })).toBe(55);
    expect(hyroxBeginnerStationLoadKg({ ...base, deload: true, memory: easy })).toBe(55);
    expect(hyroxBeginnerStationLoadKg({ ...base, injuryKind: 'adapted', memory: easy })).toBe(55);
    expect(hyroxBeginnerStationLoadKg({ ...base, injuryKind: 'none', memory: easy })).toBe(55);
  });

  it('the schedule\'s anchor wins when it is heavier, and nothing passes race weight', () => {
    // Week 3: the unloaded week-2 sled rated easy holds at 0 kg; the anchor is 50%.
    expect(hyroxBeginnerStationLoadKg({ ...base, weekIndex: 3, memory: { kg: 0, ratedRpe: 3, targetRpe: 5 } })).toBe(50);
    // The race-weight week.
    expect(hyroxBeginnerStationLoadKg({ ...base, weekIndex: 12, memory: { kg: 60, targetRpe: 5 } })).toBe(102);
    // A climb never passes race weight.
    expect(hyroxBeginnerStationLoadKg({ ...base, memory: { kg: 101, ratedRpe: 3, targetRpe: 5 } })).toBe(102);
    expect(hyroxBeginnerStationLoadKg({ ...base, station: 'wall_balls', memory: { kg: 2.4, ratedRpe: 3, targetRpe: 5 } })).toBe(4);
    // No memory: the anchor.
    expect(hyroxBeginnerStationLoadKg({ ...base, weekIndex: 1 })).toBe(0);
    expect(hyroxBeginnerStationLoadKg({ ...base, station: 'sandbag_lunges' })).toBe(6);
    expect(hyroxBeginnerStationLoadKg({ ...base, station: 'row_erg' })).toBeNull();
  });
});

describe('bricks', () => {
  it('the tier structures (sheet bricks.structure)', () => {
    expect(HYROX_BRICK_FORMATS.beginner).toMatchObject({ rounds: 3, runM: 400, runEffort: 'race_no_faster', stations: 1, roundRestSec: 120, transitionSec: 30 });
    expect(HYROX_BRICK_FORMATS.intermediate).toMatchObject({ rounds: 4, runM: 800, runEffort: 'race', stations: 2, roundRestSec: 120, transitionSec: 30 });
    expect(HYROX_BRICK_FORMATS.advanced).toMatchObject({ rounds: 6, runM: 800, runEffort: 'race_or_faster', stations: 2, roundRestSec: 0, transitionSec: 30, eccentricStation: true });
    expect(HYROX_BRICK_FORMATS.secondary).toMatchObject({ rounds: 4, runM: 800, runEffort: 'easy', stations: 2, roundRestSec: 120, rpe: 5 });
  });

  it('station rounds: one station every round, two alternating, doubles every other one', () => {
    expect(hyroxBrickStationRounds(3, 1, 0, false)).toEqual([1, 2, 3]);
    expect(hyroxBrickStationRounds(4, 2, 0, false)).toEqual([1, 3]);
    expect(hyroxBrickStationRounds(4, 2, 1, false)).toEqual([2, 4]);
    expect(hyroxBrickStationRounds(6, 2, 0, false)).toEqual([1, 3, 5]);
    expect(hyroxBrickStationRounds(3, 1, 0, true)).toEqual([1, 3]);
    expect(hyroxBrickStationRounds(4, 2, 1, true)).toEqual([2]);
    expect(hyroxBrickStationRounds(6, 2, 0, true)).toEqual([1, 5]);
  });
});
