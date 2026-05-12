/** Personal best times in seconds */
export interface PBs {
  k5?: number;   // 5K time in seconds
  k10?: number;  // 10K time in seconds
  h?: number;    // Half marathon time in seconds
  m?: number;    // Marathon time in seconds
}

/** Recent race/time trial result */
export interface RecentRun {
  d: number;        // Distance in km
  t: number;        // Time in seconds
  weeksAgo: number; // How many weeks ago
}

/** Pace zones in seconds per km */
export interface Paces {
  e: number;  // Easy pace
  t: number;  // Threshold pace
  i: number;  // Interval pace (VO2max)
  m: number;  // Marathon pace
  r: number;  // Repetition pace
}

/** Race distance identifiers */
export type RaceDistance = '5k' | '10k' | 'half' | 'marathon';

/** Runner type based on fatigue exponent */
export type RunnerType = 'Speed' | 'Balanced' | 'Endurance';

/** Ability band based on VDOT */
export type AbilityBand = 'beginner' | 'novice' | 'intermediate' | 'advanced' | 'elite';

/** Workout type identifiers */
export type WorkoutType =
  | 'easy'
  | 'recovery'
  | 'long'
  | 'threshold'
  | 'vo2'
  | 'race_pace'
  | 'marathon_pace'
  | 'intervals'
  | 'mixed'
  | 'progressive'
  | 'hill_repeats'
  | 'float'
  | 'vibes';

/** Training phase */
export type TrainingPhase = 'base' | 'build' | 'peak' | 'taper';

/** Training horizon parameters by distance and ability.
 *
 * 2026-05-12 audit #12: `tau_weeks` deprecated in favour of dual-tau model
 * (`tau_fast_weeks` + `tau_slow_weeks` + `slow_weight`). The two-phase model
 * captures the documented separation of VO2max (fast tau ≈ 6w, plateaus
 * by week 16-20) from LT/economy adaptations (slow tau ≈ 22-28w, continues
 * to ~52 weeks). See SCIENCE_LOG.md audit #12 for the physiological basis
 * (Joyner & Coyle 2008, Seiler 2010, Bouchard 1999, Moore 2016) and per-
 * distance/ability-band calibration table.
 *
 * `tau_weeks` is retained for transitional compatibility; if both are
 * present, the dual-tau path wins. Callers reading the legacy field should
 * be migrated to the dual-tau path.
 */
export interface TrainingHorizonParams {
  max_gain_pct: Record<RaceDistance, Record<AbilityBand, number>>;
  /** Legacy single-tau saturation constant. Kept for migration window;
   *  prefer `tau_fast_weeks` + `tau_slow_weeks`. */
  tau_weeks: Record<RaceDistance, Record<AbilityBand, number>>;
  /** Fast-component tau (VO2max + neuromuscular). Typically 4-7 weeks. */
  tau_fast_weeks?: Record<RaceDistance, Record<AbilityBand, number>>;
  /** Slow-component tau (LT + fractional utilization + economy). Typically
   *  20-30 weeks for distance running. */
  tau_slow_weeks?: Record<RaceDistance, Record<AbilityBand, number>>;
  /** Weight on the slow component (1 - this is the fast weight). Marathon
   *  is slow-heavy (~0.6), 5K is fast-heavy (~0.25). Per-distance only,
   *  not per-ability-band — the *shape* of the adaptation curve doesn't
   *  meaningfully change with ability, only the magnitude (which `max_gain`
   *  controls). */
  slow_weight?: Record<RaceDistance, number>;
  ref_sessions: Record<RaceDistance, Record<AbilityBand, number>>;
  type_modifier: Record<RaceDistance, Record<RunnerType, number>>;
  k_sessions: number;
  min_sessions: Record<RaceDistance, number>;
  undertrain_penalty_pct: Record<RaceDistance, number>;
  taper_bonus_pct: Record<RaceDistance, number>;
  max_gain_cap_pct: number;
  max_slowdown_pct: number;
}

/** Expected weekly gains by athlete level */
export interface ExpectedGains {
  vo2: number;
  lt: number;
}

/** Workout importance by race distance and type */
export type WorkoutImportance = Record<RaceDistance, Partial<Record<WorkoutType, number>>>;

/** Time impact penalties by race distance and type */
export type TimeImpact = Record<RaceDistance, Partial<Record<WorkoutType, number>>>;

/** Training horizon adjustment result */
export interface TrainingHorizonResult {
  vdot_gain: number;
  improvement_pct: number;
  components: {
    week_factor: number;
    session_factor: number;
    type_modifier: number;
    undertrain_penalty: number;
    taper_bonus: number;
  };
}

/** Training horizon calculation parameters */
export interface TrainingHorizonInput {
  baseline_vdot: number;
  target_distance: RaceDistance;
  weeks_remaining: number;
  sessions_per_week: number;
  runner_type: RunnerType;
  ability_band: AbilityBand;
  taper_weeks?: number;
  experience_level?: string;
  /** History-derived weekly running km (s.wkm). Primary dose signal. */
  weekly_volume_km?: number;
  /** User-stated weekly training hours (onboarding). Fallback when km unavailable. */
  weekly_volume_hours?: number;
  long_run_max_km?: number;
  hm_pb_seconds?: number;
  lt_pace_sec_per_km?: number;
}
