import type { TrainingHorizonParams, WorkoutImportance, TimeImpact, ExpectedGains } from '@/types';

/** Training horizon parameters - Non-linear improvement model */
export const TRAINING_HORIZON_PARAMS: TrainingHorizonParams = {
  // Maximum improvement ceiling by distance and ability (conservative defaults)
  max_gain_pct: {
    '5k': { beginner: 10.0, novice: 8.0, intermediate: 6.0, advanced: 4.0, elite: 2.5 },
    '10k': { beginner: 11.0, novice: 9.0, intermediate: 7.0, advanced: 5.0, elite: 3.0 },
    'half': { beginner: 12.0, novice: 10.0, intermediate: 8.0, advanced: 6.0, elite: 3.5 },
    'marathon': { beginner: 8.0, novice: 7.0, intermediate: 6.0, advanced: 6.5, elite: 4.0 }
  },

  // Time constant (tau) for adaptation - smaller = faster gains
  tau_weeks: {
    '5k': { beginner: 4.0, novice: 5.0, intermediate: 6.0, advanced: 7.0, elite: 8.0 },
    '10k': { beginner: 5.0, novice: 6.0, intermediate: 7.0, advanced: 8.0, elite: 9.0 },
    'half': { beginner: 6.0, novice: 7.0, intermediate: 8.0, advanced: 9.0, elite: 10.0 },
    'marathon': { beginner: 7.0, novice: 8.0, intermediate: 9.0, advanced: 10.0, elite: 11.0 }
  },

  // Reference sessions/week (center of logistic curve)
  ref_sessions: {
    '5k': { beginner: 3.0, novice: 3.5, intermediate: 4.0, advanced: 5.0, elite: 6.0 },
    '10k': { beginner: 3.0, novice: 4.0, intermediate: 4.5, advanced: 5.5, elite: 6.5 },
    'half': { beginner: 3.5, novice: 4.0, intermediate: 5.0, advanced: 6.0, elite: 7.0 },
    'marathon': { beginner: 4.0, novice: 4.5, intermediate: 5.5, advanced: 6.5, elite: 7.5 }
  },

  // Runner type modifiers - trains weakness principle
  type_modifier: {
    '5k': { Speed: 0.90, Balanced: 1.00, Endurance: 1.15 },
    '10k': { Speed: 0.95, Balanced: 1.00, Endurance: 1.10 },
    'half': { Speed: 1.10, Balanced: 1.00, Endurance: 0.95 },
    'marathon': { Speed: 1.15, Balanced: 1.00, Endurance: 0.90 }
  },

  k_sessions: 1.0,  // Logistic steepness
  min_sessions: { '5k': 2.0, '10k': 2.5, 'half': 3.0, 'marathon': 3.5 },
  undertrain_penalty_pct: { '5k': 2.0, '10k': 2.5, 'half': 3.0, 'marathon': 4.0 },
  taper_bonus_pct: { '5k': 0.8, '10k': 1.0, 'half': 1.2, 'marathon': 1.5 },
  max_gain_cap_pct: 15.0,
  max_slowdown_pct: 3.0
};

/** Workout importance by race distance and type */
export const IMP: WorkoutImportance = {
  '5k': { easy: 0.4, vo2: 0.95, threshold: 0.8, intervals: 0.95, long: 0.5 },
  '10k': { easy: 0.5, vo2: 0.9, threshold: 0.9, intervals: 0.9, race_pace: 0.85, long: 0.7 },
  'half': { easy: 0.6, vo2: 0.7, threshold: 0.95, race_pace: 0.9, mixed: 0.85, long: 0.95, progressive: 0.9 },
  'marathon': { easy: 0.8, vo2: 0.7, intervals: 0.7, threshold: 0.9, race_pace: 0.85, marathon_pace: 0.95, mixed: 0.9, long: 1.0, progressive: 0.95 }
};

/** Time impact penalties (seconds) when skipping workouts */
export const TIM: TimeImpact = {
  '5k': { easy: 5, vo2: 20, threshold: 15, intervals: 20, long: 10 },
  '10k': { easy: 8, vo2: 18, threshold: 15, intervals: 18, race_pace: 15, long: 15 },
  'half': { easy: 10, vo2: 15, threshold: 25, race_pace: 20, mixed: 18, long: 30, progressive: 25 },
  'marathon': { easy: 15, threshold: 30, marathon_pace: 35, mixed: 25, long: 60, progressive: 35 }
};

/** Taper nominal weeks by race distance */
export const TAPER_NOMINAL: Record<string, number> = {
  '5k': 1,
  '10k': 2,
  'half': 2,
  'marathon': 3,
};

/** Expected weekly improvement by athlete level */
export const EXPECTED_GAINS: Record<string, ExpectedGains> = {
  novice: { vo2: 0.0055, lt: 0.007 },           // 0.55%/week VO2, 0.7%/week LT
  intermediate: { vo2: 0.00175, lt: 0.00275 },  // 0.175%/week VO2, 0.275%/week LT
  advanced: { vo2: 0.001, lt: 0.00165 },        // 0.1%/week VO2, 0.165%/week LT
  elite: { vo2: 0.0005, lt: 0.00075 }           // 0.05%/week VO2, 0.075%/week LT
};
