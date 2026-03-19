import type { SportConfig, SportKey } from '@/types';

/**
 * Training Load per minute by RPE (TSS-calibrated).
 * Verification:
 *   Easy 60min RPE 4: 60 × 0.92 = 55.2 TL ✓
 *   Threshold 45min RPE 7: 45 × 1.78 = 80.1 TL ✓
 *   VO2 45min RPE 8: 45 × 2.22 = 99.9 TL ✓
 *   Long 2h RPE 4 (× 1.2 long multiplier): 120 × 0.92 × 1.2 = 132 TL ✓
 */
export const TL_PER_MIN: Record<number, number> = {
  1: 0.30,
  2: 0.45,
  3: 0.65,
  4: 0.92,
  5: 1.15,
  6: 1.45,
  7: 1.78,
  8: 2.22,
  9: 2.75,
  10: 3.00,
};

/**
 * Musculoskeletal impact load per km by run intensity.
 * Running impact is km-based; cross-training uses impactPerMin from SPORTS_DB.
 */
export const IMPACT_PER_KM: Record<string, number> = {
  easy: 1.0,
  long: 1.0,
  marathon_pace: 1.15,
  threshold: 1.3,
  vo2: 1.5,
  intervals: 1.5,
  race_pace: 1.35,
};

/** Sports database - configuration for cross-training activities */
export const SPORTS_DB: Record<SportKey, SportConfig> = {
  soccer:        { mult: 1.35, noReplace: ['long'], runSpec: 0.40, recoveryMult: 1.20, impactPerMin: 0.12, volumeTransfer: 0.7, intermittent: true },
  rugby:         { mult: 1.50, noReplace: ['long'], runSpec: 0.35, recoveryMult: 1.30, impactPerMin: 0.12, volumeTransfer: 0.7, intermittent: true },
  basketball:    { mult: 1.25, noReplace: ['long'], runSpec: 0.45, recoveryMult: 1.15, impactPerMin: 0.12, volumeTransfer: 0,   intermittent: true },
  tennis:        { mult: 1.20, noReplace: [], runSpec: 0.50, recoveryMult: 1.10, impactPerMin: 0.05, volumeTransfer: 0 },
  swimming:      { mult: 0.65, noReplace: [], runSpec: 0.20, recoveryMult: 0.90, impactPerMin: 0.00, volumeTransfer: 0 },
  cycling:       { mult: 0.75, noReplace: [], runSpec: 0.55, recoveryMult: 0.95, impactPerMin: 0.00, volumeTransfer: 0 },
  strength:      { mult: 1.10, noReplace: [], runSpec: 0.35, recoveryMult: 1.00, impactPerMin: 0.08, volumeTransfer: 0 },
  extra_run:     { mult: 1.00, noReplace: [], runSpec: 1.00, recoveryMult: 1.00, impactPerMin: 0.00, volumeTransfer: 1.0 }, // km-based for runs
  hiking:        { mult: 0.80, noReplace: [], runSpec: 0.45, recoveryMult: 0.95, impactPerMin: 0.06, volumeTransfer: 0.4 },
  rowing:        { mult: 0.85, noReplace: [], runSpec: 0.35, recoveryMult: 0.95, impactPerMin: 0.00, volumeTransfer: 0 },
  yoga:          { mult: 0.40, noReplace: [], runSpec: 0.10, recoveryMult: 0.85, impactPerMin: 0.02, volumeTransfer: 0 },
  martial_arts:  { mult: 1.30, noReplace: ['long'], runSpec: 0.30, recoveryMult: 1.20, impactPerMin: 0.10, volumeTransfer: 0, intermittent: true },
  climbing:      { mult: 0.70, noReplace: [], runSpec: 0.15, recoveryMult: 1.00, impactPerMin: 0.05, volumeTransfer: 0 },
  boxing:        { mult: 1.40, noReplace: ['long'], runSpec: 0.25, recoveryMult: 1.20, impactPerMin: 0.10, volumeTransfer: 0, intermittent: true },
  crossfit:      { mult: 1.30, noReplace: [], runSpec: 0.40, recoveryMult: 1.20, impactPerMin: 0.10, volumeTransfer: 0 },
  pilates:       { mult: 0.45, noReplace: [], runSpec: 0.10, recoveryMult: 0.85, impactPerMin: 0.02, volumeTransfer: 0 },
  dancing:       { mult: 0.90, noReplace: [], runSpec: 0.35, recoveryMult: 1.00, impactPerMin: 0.04, volumeTransfer: 0 },
  skiing:        { mult: 0.90, noReplace: [], runSpec: 0.50, recoveryMult: 1.00, impactPerMin: 0.07, volumeTransfer: 0 },
  skating:       { mult: 0.75, noReplace: [], runSpec: 0.40, recoveryMult: 0.95, impactPerMin: 0.04, volumeTransfer: 0 },
  elliptical:    { mult: 0.80, noReplace: [], runSpec: 0.65, recoveryMult: 0.90, impactPerMin: 0.00, volumeTransfer: 0 },
  stair_climbing:{ mult: 0.85, noReplace: [], runSpec: 0.55, recoveryMult: 0.95, impactPerMin: 0.06, volumeTransfer: 0.3 },
  jump_rope:     { mult: 1.10, noReplace: [], runSpec: 0.50, recoveryMult: 1.05, impactPerMin: 0.08, volumeTransfer: 0.2 },
  walking:       { mult: 0.35, noReplace: [], runSpec: 0.30, recoveryMult: 0.80, impactPerMin: 0.03, volumeTransfer: 0.3 },
  padel:         { mult: 1.15, noReplace: [], runSpec: 0.45, recoveryMult: 1.05, impactPerMin: 0.05, volumeTransfer: 0 },
  generic_sport: { mult: 0.90, noReplace: [], runSpec: 0.40, recoveryMult: 1.00, impactPerMin: 0.04, volumeTransfer: 0.2 },
  hybrid_test_sport: {
    mult: 1.0,
    noReplace: [],
    runSpec: 0.5,
    recoveryMult: 1.0,
    impactPerMin: 0.05,
    volumeTransfer: 0.3,
    extendedModel: {
      aerobicTransfer: 0.8,
      anaerobicTransfer: 0.2,
      impactLoading: 0.5,
    },
  },
};

/** Human-readable display names for sport keys */
export const SPORT_LABELS: Record<SportKey, string> = {
  soccer: 'Soccer',
  rugby: 'Rugby',
  basketball: 'Basketball',
  tennis: 'Tennis',
  swimming: 'Swimming',
  cycling: 'Cycling',
  strength: 'Strength',
  extra_run: 'Extra Run',
  hiking: 'Hiking',
  rowing: 'Rowing',
  yoga: 'Yoga',
  martial_arts: 'Martial Arts',
  climbing: 'Climbing',
  boxing: 'Boxing',
  crossfit: 'CrossFit',
  pilates: 'Pilates',
  dancing: 'Dancing',
  skiing: 'Skiing',
  skating: 'Skating',
  elliptical: 'Elliptical',
  stair_climbing: 'Stair Climbing',
  jump_rope: 'Jump Rope',
  walking: 'Walking',
  padel: 'Padel',
  generic_sport: 'General Sport',
  hybrid_test_sport: 'Hybrid Test Sport',
};

/** Sport name aliases — maps common variants to canonical SportKey */
export const SPORT_ALIASES: Record<string, SportKey> = {
  'football': 'soccer',
  'touch_rugby': 'rugby',
  'rugby_union': 'rugby',
  'rugby_league': 'rugby',

  'pickleball': 'tennis',
  'weights': 'strength',
  'gym': 'strength',
  'lifting': 'strength',
  'hike': 'hiking',
  'rock_climbing': 'climbing',
  'bouldering': 'climbing',
  'karate': 'martial_arts',
  'judo': 'martial_arts',
  'bjj': 'martial_arts',
  'mma': 'martial_arts',
  'ice_skating': 'skating',
  'roller_skating': 'skating',
  'ballet': 'dancing',
  'zumba': 'dancing',
  'skipping': 'jump_rope',
  'cross_country_skiing': 'skiing',
  'stairmaster': 'stair_climbing',
  'general_sport': 'generic_sport',
};

/** RPE multipliers for load calculation (1–10 scale) */
export const RPE_MULT: Record<number, number> = {
  10: 1.20,
  9: 1.20,
  8: 1.12,
  7: 1.06,
  6: 1.00,
  5: 0.95,
  4: 0.95,
  3: 0.95,
  2: 0.95,
  1: 0.95,
};

/** Load calculation constants */
export const ANAEROBIC_WEIGHT = 1.15;
export const RPE_WEIGHT = 0.06;
export const DEFAULT_RPE = 5;

/** Garmin-calibrated load rates (load per minute at different intensities) */
export const LOAD_PER_MIN_BY_INTENSITY: Record<number, number> = {
  1: 0.5,   // Recovery
  2: 0.8,   // Easy
  3: 1.2,   // Easy-moderate
  4: 1.5,   // Moderate
  5: 2.0,   // Moderate-hard
  6: 2.5,   // Tempo
  7: 3.5,   // Threshold
  8: 4.5,   // VO2
  9: 5.5,   // Very hard
  10: 6.0,  // Max
};

/** Load budget configuration for cross-training modifications */
export const LOAD_BUDGET_CONFIG = {
  maxReplacementPct: 0.30,    // Max 30% of weekly workout load can be replaced
  maxAdjustmentPct: 0.40,     // Max 40% can be adjusted (reduced)
  minLoadToTrigger: 30,       // Minimum effective load to trigger modification
  previousWeekDecay: 0.70,    // Previous week activities count at 70%
};
