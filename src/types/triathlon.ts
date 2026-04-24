/**
 * Triathlon mode types.
 *
 * Scope: types used throughout plan generation, state, UI, and load model when
 * `SimulatorState.eventType === 'triathlon'`. All triathlon-specific runtime
 * behaviour is gated behind this flag; running mode users see none of it.
 *
 * See `docs/TRIATHLON.md` §18 for the canonical decisions backing this file.
 */

/** Three primary disciplines. Matches what comes off Strava/Garmin activity types. */
export type Discipline = 'swim' | 'bike' | 'run';

/** Triathlon race distance. Sprint/Olympic are predicted as side-effects (§18.10) but are not first-class race targets in v1. */
export type TriathlonDistance = '70.3' | 'ironman';

/** Event type at the top level. Undefined/absent = running (back-compat). */
export type EventType = 'running' | 'triathlon';

/** 1 (weakest) to 5 (strongest). Used for the three self-rating sliders that replace runner-type for tri users (§18.7). */
export type TriSkillSlider = 1 | 2 | 3 | 4 | 5;

/** Triathlete self-rating — three sliders at onboarding. Translates into volume + session-complexity bias per discipline. */
export interface TriSkillRating {
  swim: TriSkillSlider;
  bike: TriSkillSlider;
  run: TriSkillSlider;
}

/** Volume split across disciplines. Must sum to 1.0 (±0.001 tolerance). */
export interface TriVolumeSplit {
  swim: number;   // fraction of total weekly hours
  bike: number;
  run: number;
}

/** Swim personal-best times. All in seconds; any/all may be absent. */
export interface SwimPBs {
  m100?: number;     // 100m time
  m200?: number;     // 200m time
  m400?: number;     // 400m time — primary CSS input
  m1500?: number;    // 1500m time
}

/** Bike benchmarks. FTP in watts, LTHR in bpm. Both optional. */
export interface BikeBenchmarks {
  ftp?: number;        // Functional Threshold Power in watts
  lthr?: number;       // Lactate threshold HR (bike) in bpm
  twentyMinW?: number; // Raw 20-min test watts (if user ran the test)
  hasPowerMeter?: boolean; // Collected at onboarding — gates power-based bTSS vs HR fallback (§18.1)
}

/** Swim benchmarks. CSS (Critical Swim Speed) is the canonical swim threshold — seconds per 100m. */
export interface SwimBenchmarks {
  cssSecPer100m?: number;    // Critical Swim Speed — lactate-threshold pace per 100m
  pbs?: SwimPBs;             // Raw test/PB times from which CSS can be derived
  poolLengthM?: 25 | 33 | 50; // For pace conversion; defaults to 25
}

/** Per-discipline fitness EMAs. Mirrors the running-side CTL/ATL but lives under triConfig so running mode is untouched. */
export interface PerDisciplineFitness {
  ctl: number;  // 42-day EMA of TSS for this discipline
  atl: number;  // 7-day EMA of TSS for this discipline
  tsb: number;  // ctl - atl (form/freshness for this discipline)
}

/** User-editable race predictions targets. Stored to override the model's output (§18.8, stats page). */
export interface TriUserTargets {
  swim?: { secPer100m?: number; totalSec?: number };
  bike?: { watts?: number; avgSpeedKph?: number; totalSec?: number };
  run?: { secPerKm?: number; totalSec?: number };
  t1Sec?: number;  // Transition 1 estimate
  t2Sec?: number;  // Transition 2 estimate
}

/** Predicted race time with confidence band. */
export interface TriRacePrediction {
  totalSec: number;                // Headline predicted finish
  swimSec: number;
  t1Sec: number;
  bikeSec: number;
  t2Sec: number;
  runSec: number;                  // Includes the §18.4 pace discount (tracking side only)
  totalRangeSec: [number, number]; // ±band on total (§18.8)
  sprintTotalSec?: number;         // Side-effect prediction (§18.10)
  olympicTotalSec?: number;        // Side-effect prediction
  computedAtISO: string;
}

/**
 * Triathlon configuration stored on the SimulatorState.
 * All fields optional; absence = not yet set / use defaults from constants.
 */
export interface TriConfig {
  distance: TriathlonDistance;

  // Onboarding inputs
  timeAvailableHoursPerWeek?: number;  // Total = weekday + weekend
  /** Hours available Mon–Fri combined. Scheduler uses this to cap weekday
   * sessions and push overflow + long sessions to Sat/Sun. When absent we
   * default to ~40% of total on weekdays. */
  weekdayHoursPerWeek?: number;
  volumeSplit?: TriVolumeSplit;        // Defaults to preset in triathlon-constants.ts
  skillRating?: TriSkillRating;        // Three 1–5 sliders (§18.7)
  bike?: BikeBenchmarks;
  swim?: SwimBenchmarks;

  // Race plan configuration
  raceDate?: string;   // ISO YYYY-MM-DD
  weeksToRace?: number;

  // Per-discipline fitness state (Phase 4)
  fitness?: {
    swim: PerDisciplineFitness;
    bike: PerDisciplineFitness;
    run: PerDisciplineFitness;
    combinedCtl: number;  // Weighted sum per §18.3 transfer matrix
  };

  // User overrides for race-time prediction
  userTargets?: TriUserTargets;

  // Latest computed race prediction cache
  prediction?: TriRacePrediction;

  /**
   * Per-week snapshots of per-discipline CTL + combined CTL, appended on each
   * week advance. Drives the fitness-over-time chart on the stats view (§7).
   * Running-mode has equivalents (historicWeeklyTSS etc); triathlon needs
   * per-discipline so we accumulate here. Capped at the last 52 entries.
   */
  fitnessHistory?: Array<{
    weekISO: string;
    swimCtl: number;
    bikeCtl: number;
    runCtl: number;
    combinedCtl: number;
  }>;

  /**
   * Version of the triathlon plan generator that produced `triWorkouts` on
   * each Week. Compared against TRI_GENERATOR_VERSION on app load; if lower,
   * the plan is regenerated automatically so users see updated scheduling,
   * descriptions, and volume calibration without resetting their onboarding.
   */
  generatorVersion?: number;
}

/** Triathlon-specific workout types. Joined into `Workout.t` (which is a free string). */
export type TriWorkoutType =
  // Swim
  | 'swim_technique'
  | 'swim_endurance'
  | 'swim_threshold'  // CSS intervals
  | 'swim_speed'
  | 'swim_openwater'
  // Bike
  | 'bike_endurance'
  | 'bike_tempo'
  | 'bike_sweet_spot'
  | 'bike_threshold'
  | 'bike_vo2'
  | 'bike_hills'
  // Combined
  | 'brick';

/** Target intensity representation that generalises across disciplines. */
export interface DisciplineTarget {
  discipline: Discipline;
  // Any combination of the following may be set depending on the discipline and
  // whether the user has a power meter / HR data / known threshold.
  targetPaceSecPer100m?: number;   // Swim
  targetPaceSecPerKm?: number;     // Run
  targetWatts?: number;            // Bike (requires FTP)
  targetPctFtp?: number;           // Bike (0–1.5)
  targetHrBpm?: number;
  targetHrZone?: 1 | 2 | 3 | 4 | 5 | 6;
  rpe?: number;                    // 1–10
  durationMin?: number;
  distanceM?: number;              // Swim metres or run/bike metres
}

/** A brick workout is two discipline segments back-to-back (almost always bike → run). */
export interface BrickSegments {
  segments: [DisciplineTarget, DisciplineTarget];
}
