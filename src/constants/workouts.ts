import type { WorkoutDefinition, RaceDistance, RunnerType } from '@/types';

/** Workout type categories */
export type WorkoutCategory = 'vo2' | 'threshold' | 'race_pace' | 'mixed' | 'progressive' | 'marathon_pace' | 'float';

/** Workout library structure */
export type WorkoutLibrary = Record<
  RaceDistance,
  Record<string, Partial<Record<WorkoutCategory, WorkoutDefinition[]>>>
>;

/** Workout definitions by distance/type/runner */
export const WO: WorkoutLibrary = {
  '5k': {
    Speed: {
      vo2: [{ n: '800m', d: '8×800 @ 5K, 90s', r: 9 }],
      threshold: [{ n: 'Tempo', d: '20min @ threshold', r: 7 }]
    },
    Balanced: {
      vo2: [{ n: '1K', d: '6×1K @ 5K, 2-3min', r: 9 }],
      threshold: [{ n: 'Tempo', d: '22min @ threshold', r: 7 }]
    },
    Endurance: {
      vo2: [{ n: '1200m', d: '5×1200 @ 5K, 3min', r: 9 }],
      threshold: [{ n: 'Long Tempo', d: '25min @ threshold', r: 7 }]
    }
  },
  '10k': {
    Speed: {
      vo2: [{ n: '800m', d: '8×800 @ 5K, 90s', r: 9 }],
      threshold: [{ n: 'Tempo', d: '22min @ tempo', r: 7 }],
      race_pace: [{ n: 'Mile', d: '4×1mi @ 10K, 2min', r: 8 }]
    },
    Balanced: {
      vo2: [{ n: '1K', d: '6×1K @ 5K, 2-3min', r: 9 }],
      threshold: [{ n: 'Tempo', d: '25min @ tempo', r: 7 }],
      race_pace: [{ n: 'Mile', d: '4×1mi @ 10K, 2min', r: 8 }]
    },
    Endurance: {
      vo2: [{ n: '1200m', d: '5×1200 @ 5K, 3min', r: 8 }],
      threshold: [{ n: 'Long Tempo', d: '30min @ tempo', r: 7 }],
      race_pace: [{ n: '2K', d: '3×2K @ 10K, 3min', r: 8 }]
    }
  },
  'half': {
    Speed: {
      vo2: [{ n: '1200m', d: '4×1200 @ 5K, 3min', r: 9 }],
      threshold: [{ n: 'Tempo', d: '35min @ threshold', r: 7 }],
      race_pace: [
        { n: '800m@HM', d: '8×800 @ HM, 90s', r: 8 },
        { n: 'Jack Fultz', d: '20×400 @ HM, 200m', r: 8 }
      ],
      float: [{ n: 'Float Fartlek', d: '6×3min @ 10K, 2min float @ MP', r: 7 }],
      progressive: [{ n: 'Fast Finish', d: '21km: last 5 @ HM', r: 7 }]
    },
    Balanced: {
      vo2: [{ n: '1200m', d: '4×1200 @ 5K, 3min', r: 9 }],
      threshold: [{ n: 'Long Tempo', d: '40min @ threshold', r: 7 }],
      race_pace: [{ n: 'Jack Fultz', d: '20×400 @ HM, 200m', r: 8 }],
      float: [{ n: 'Float Fartlek', d: '5×4min @ 10K, 2min float @ MP', r: 7 }],
      mixed: [{ n: 'Nell Rojas', d: '6.5@MP, 2.5@10K, 3@HM', r: 8 }],
      progressive: [{ n: 'Fast Finish', d: '21km: last 5 @ HM', r: 7 }]
    },
    Endurance: {
      vo2: [{ n: '1K', d: '5×1K @ 5K, 3min', r: 8 }],
      threshold: [{ n: 'Long Tempo', d: '45min @ threshold', r: 7 }],
      race_pace: [{ n: 'Jack Fultz', d: '20×400 @ HM, 200m', r: 8 }],
      float: [{ n: 'Float Fartlek', d: '5×4min @ 10K, 3min float @ MP', r: 7 }],
      progressive: [{ n: 'Fast Finish', d: '23km: last 8 @ HM', r: 8 }]
    }
  },
  'marathon': {
    Speed: {
      threshold: [{ n: 'Tempo Int', d: '3×10min @ threshold, 2min', r: 7 }],
      marathon_pace: [
        { n: 'MP Intro', d: '3×10min @ MP, 3min', r: 5 },
        { n: 'MP', d: '2×10km @ MP, 2min', r: 6 },
      ],
      float: [{ n: 'Float Fartlek', d: '6×3min @ 10K, 2min float @ MP', r: 7 }],
      progressive: [{ n: 'Progressive', d: '26km: last 8 @ MP', r: 7 }]
    },
    Balanced: {
      threshold: [{ n: 'Long Tempo', d: '2×12km @ threshold, 3min', r: 7 }],
      marathon_pace: [
        { n: 'MP Intro', d: '3×12min @ MP, 3min', r: 5 },
        { n: 'MP', d: '2×12km @ MP, 2min', r: 6 },
      ],
      float: [
        { n: 'Float Fartlek', d: '5×4min @ 10K, 2min float @ MP', r: 7 },
        { n: 'Float Long', d: '24km: alternating 3km @ MP / 2km float', r: 7 },
      ],
      mixed: [{ n: 'Nell Rojas', d: '10@MP, 4@10K, 5@HM', r: 8 }],
      progressive: [{ n: 'Progressive', d: '29km: last 10 @ MP', r: 7 }]
    },
    Endurance: {
      threshold: [{ n: 'Long Tempo', d: '2×15km @ threshold, 3min', r: 7 }],
      marathon_pace: [
        { n: 'MP Intro', d: '3×15min @ MP, 3min', r: 5 },
        { n: 'Long MP', d: '20km @ MP', r: 6 },
      ],
      float: [
        { n: 'Float Fartlek', d: '4×5min @ 10K, 3min float @ MP', r: 7 },
        { n: 'Float Long', d: '28km: alternating 3km @ MP / 2km float', r: 7 },
      ],
      progressive: [{ n: 'Race Sim', d: '32km: last 12 @ MP', r: 8 }]
    }
  }
};

/** Long run distances by race distance (in km) */
export const LONG_RUN_DISTANCES: Record<RaceDistance, number> = {
  '5k': 12,
  '10k': 16,
  'half': 20,
  'marathon': 26
};

/** Load profiles for different workout types */
export const LOAD_PROFILES: Record<string, {
  aerobic: number; anaerobic: number;
  // 3-zone breakdown: Base (Z1+Z2) / Threshold (Z3) / High Intensity (Z4+Z5)
  base?: number; threshold?: number; intensity?: number;
}> = {
  'easy':          { aerobic: 0.95, anaerobic: 0.05, base: 0.94, threshold: 0.05, intensity: 0.01 },
  'long':          { aerobic: 0.90, anaerobic: 0.10, base: 0.88, threshold: 0.10, intensity: 0.02 },
  'threshold':     { aerobic: 0.70, anaerobic: 0.30, base: 0.15, threshold: 0.65, intensity: 0.20 },
  'vo2':           { aerobic: 0.50, anaerobic: 0.50, base: 0.10, threshold: 0.35, intensity: 0.55 },
  'race_pace':     { aerobic: 0.65, anaerobic: 0.35, base: 0.20, threshold: 0.55, intensity: 0.25 },
  'marathon_pace': { aerobic: 0.75, anaerobic: 0.25, base: 0.40, threshold: 0.45, intensity: 0.15 },
  'intervals':     { aerobic: 0.45, anaerobic: 0.55, base: 0.05, threshold: 0.30, intensity: 0.65 },
  'hill_repeats':  { aerobic: 0.40, anaerobic: 0.60, base: 0.10, threshold: 0.30, intensity: 0.60 },
  'mixed':         { aerobic: 0.60, anaerobic: 0.40, base: 0.30, threshold: 0.40, intensity: 0.30 },
  'progressive':   { aerobic: 0.70, anaerobic: 0.30, base: 0.35, threshold: 0.45, intensity: 0.20 },
  'float':         { aerobic: 0.65, anaerobic: 0.35, base: 0.20, threshold: 0.50, intensity: 0.30 },
  'gym':           { aerobic: 0.20, anaerobic: 0.80, base: 0.05, threshold: 0.20, intensity: 0.75 },
};
