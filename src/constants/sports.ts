import type { SportConfig, SportKey } from '@/types';

/** Sports database - configuration for cross-training activities */
export const SPORTS_DB: Record<SportKey, SportConfig> = {
  soccer: { mult: 1.35, noReplace: ['long'], runSpec: 0.40, recoveryMult: 1.20 },
  rugby: { mult: 1.50, noReplace: ['long'], runSpec: 0.35, recoveryMult: 1.30 },
  basketball: { mult: 1.25, noReplace: ['long'], runSpec: 0.45, recoveryMult: 1.15 },
  tennis: { mult: 1.20, noReplace: [], runSpec: 0.50, recoveryMult: 1.10 },
  swimming: { mult: 0.65, noReplace: [], runSpec: 0.20, recoveryMult: 0.90 },
  cycling: { mult: 0.75, noReplace: [], runSpec: 0.55, recoveryMult: 0.95 },
  strength: { mult: 1.10, noReplace: [], runSpec: 0.30, recoveryMult: 1.00 },
  extra_run: { mult: 1.00, noReplace: [], runSpec: 1.00, recoveryMult: 1.00 },
  hiking: { mult: 0.80, noReplace: [], runSpec: 0.45, recoveryMult: 0.95 },
  rowing: { mult: 0.85, noReplace: [], runSpec: 0.35, recoveryMult: 0.95 },
  yoga: { mult: 0.40, noReplace: [], runSpec: 0.10, recoveryMult: 0.85 },
  martial_arts: { mult: 1.30, noReplace: ['long'], runSpec: 0.30, recoveryMult: 1.20 },
  climbing: { mult: 0.70, noReplace: [], runSpec: 0.15, recoveryMult: 1.00 },
  boxing: { mult: 1.40, noReplace: ['long'], runSpec: 0.25, recoveryMult: 1.20 },
  crossfit: { mult: 1.30, noReplace: [], runSpec: 0.40, recoveryMult: 1.20 },
  pilates: { mult: 0.45, noReplace: [], runSpec: 0.10, recoveryMult: 0.85 },
  dancing: { mult: 0.90, noReplace: [], runSpec: 0.35, recoveryMult: 1.00 },
  skiing: { mult: 0.90, noReplace: [], runSpec: 0.50, recoveryMult: 1.00 },
  skating: { mult: 0.75, noReplace: [], runSpec: 0.40, recoveryMult: 0.95 },
  elliptical: { mult: 0.80, noReplace: [], runSpec: 0.65, recoveryMult: 0.90 },
  stair_climbing: { mult: 0.85, noReplace: [], runSpec: 0.55, recoveryMult: 0.95 },
  jump_rope: { mult: 1.10, noReplace: [], runSpec: 0.50, recoveryMult: 1.05 },
  walking: { mult: 0.35, noReplace: [], runSpec: 0.30, recoveryMult: 0.80 },
  padel: { mult: 1.15, noReplace: [], runSpec: 0.45, recoveryMult: 1.05 },
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
