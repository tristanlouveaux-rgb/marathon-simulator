/**
 * Apple workout types reach the bucket and sport the Garmin/Strava pipeline uses
 * for the same session (ITEM S3, audit D2).
 *
 * The HealthExtras plugin's workoutActivityTypeName emitted 19 strings. HIIT,
 * pilates, core training, dance, boxing and every other unlisted type fell to
 * "other", then CARDIO, generic_sport, label "Cardio": never gym-matched, never
 * a HYROX station, unlike Garmin and Strava HIIT. The Swift switch now names
 * them and mapWorkoutType maps each to the Garmin vocabulary string for the
 * same sport.
 *
 * The contract test reads the Swift source, so a string added there without a
 * TS case (the old waterSports/waterPolo/waterFitness situation in reverse)
 * fails here.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { mapWorkoutType } from './appleHealthSync';
import { mapGarminType, mapAppTypeToSport } from '@/calculations/activity-matcher';
import { deriveSportFromActivityType } from '@/cross-training/activities';
import { resolveSportForActivity } from '@/ui/sport-picker-modal';
import { SPORTS_DB } from '@/constants';

const SWIFT = resolve(__dirname, '../../ios-plugins/health-extras/ios/Sources/HealthExtrasPlugin/HealthExtrasPlugin.swift');

/** Every string literal workoutActivityTypeName can return. */
function swiftEmittedTypes(): string[] {
  const src = readFileSync(SWIFT, 'utf8');
  const start = src.indexOf('func workoutActivityTypeName');
  const end = src.indexOf('default:', start);
  expect(start).toBeGreaterThan(0);
  const body = src.slice(start, end);
  return [...body.matchAll(/return\s+"([A-Za-z]+)"/g)].map(m => m[1]);
}

/** Sport the review modal and excess items cost an Apple row as. */
const reviewSport = (appleType: string) => {
  const at = mapWorkoutType(appleType);
  return resolveSportForActivity(at, mapAppTypeToSport(mapGarminType(at)), at);
};

describe('every type the native plugin emits has a TS mapping', () => {
  it('no emitted string falls through to the CARDIO catch-all unless mapped there on purpose', () => {
    const emitted = swiftEmittedTypes();
    expect(emitted.length).toBeGreaterThan(19);
    const intentionallyCardio = new Set(['waterPolo']);
    for (const t of emitted) {
      if (intentionallyCardio.has(t)) continue;
      expect([t, mapWorkoutType(t)]).not.toEqual([t, 'CARDIO']);
    }
  });

  it('unknown types still default to CARDIO (cross-training, never a walk)', () => {
    expect(mapWorkoutType('other')).toBe('CARDIO');
    expect(mapWorkoutType('fitnessGaming')).toBe('CARDIO');
  });
});

describe('Apple HIIT lands in the bucket Garmin HIIT uses', () => {
  it('HIIT maps to the HIIT activity type and the gym bucket', () => {
    expect(swiftEmittedTypes()).toContain('highIntensityIntervalTraining');
    expect(mapWorkoutType('highIntensityIntervalTraining')).toBe('HIIT');
    expect(mapGarminType(mapWorkoutType('highIntensityIntervalTraining'))).toBe(mapGarminType('HIIT'));
    expect(mapGarminType('HIIT')).toBe('gym');
  });

  it('core training is filed with strength (no SPORTS_DB entry of its own), like functional strength', () => {
    expect(mapWorkoutType('coreTraining')).toBe(mapWorkoutType('strengthTraining'));
    expect(mapGarminType(mapWorkoutType('coreTraining'))).toBe('gym');
    expect(deriveSportFromActivityType(mapWorkoutType('coreTraining'))).toBe('strength');
  });
});

describe('other Apple types map to their SPORTS_DB key', () => {
  const expected: Record<string, string> = {
    pilates: 'pilates',
    socialDance: 'dancing',
    cardioDance: 'dancing',
    jumpRope: 'jump_rope',
    boxing: 'boxing',
    kickboxing: 'boxing',
    martialArts: 'martial_arts',
    rugby: 'rugby',
    climbing: 'climbing',
    downhillSkiing: 'skiing',
    crossCountrySkiing: 'skiing',
    snowboarding: 'snowboarding',
    skatingSports: 'skating',
    surfingSports: 'surfing',
    sailing: 'sailing',
    pickleball: 'tennis',
    paddleSports: 'paddleboard',
    waterSports: 'paddleboard',
    rowing: 'rowing',
    hiking: 'hiking',
  };

  it('each resolves to the expected sport in the review costing', () => {
    for (const [appleType, sport] of Object.entries(expected)) {
      expect(sport in SPORTS_DB).toBe(true);
      expect([appleType, reviewSport(appleType)]).toEqual([appleType, sport]);
    }
  });

  it('the non-walk ones are cross-training (other bucket), never gym or walk', () => {
    for (const appleType of ['pilates', 'socialDance', 'boxing', 'martialArts', 'rugby', 'climbing',
      'downhillSkiing', 'snowboarding', 'skatingSports', 'jumpRope', 'surfingSports', 'sailing', 'pickleball']) {
      expect([appleType, mapGarminType(mapWorkoutType(appleType))]).toEqual([appleType, 'other']);
    }
  });

  it('Garmin DANCE resolves to dancing through the same alias', () => {
    expect(deriveSportFromActivityType('DANCE')).toBe('dancing');
  });

  it('golf joins the walk class Garmin golf uses and keeps the walking cost (no SPORTS_DB golf entry)', () => {
    expect('golf' in SPORTS_DB).toBe(false);
    expect(mapGarminType(mapWorkoutType('golf'))).toBe('walk');
    expect(reviewSport('golf')).toBe('walking');
  });

  it('sports with no SPORTS_DB entry keep the generic cost but carry their own type', () => {
    for (const appleType of ['volleyball', 'squash', 'badminton', 'racquetball', 'tableTennis', 'cricket']) {
      const at = mapWorkoutType(appleType);
      expect(at).not.toBe('CARDIO');
      expect([appleType, reviewSport(appleType)]).toEqual([appleType, 'generic_sport']);
    }
  });
});
