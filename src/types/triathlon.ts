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

/** Swim personal-best times. All in seconds; any/all may be absent.
 * The 200m + 400m pair is the canonical CSS test (Smith & Norris 2019):
 * `CSS = 200 / (t400 - t200)` m/s. Both must be present for the formula
 * to apply; otherwise we fall back to fastest sustained pace from
 * activity history. */
export interface SwimPBs {
  m100?: number;     // 100m time
  m200?: number;     // 200m time — pairs with m400 for Smith-Norris CSS
  m400?: number;     // 400m time — primary CSS input
  m1500?: number;    // 1500m time
}

/** Riding position presets. Each maps to a typical CdA (frontal area × drag coefficient).
 *  Values are mid-range from published wind-tunnel data; user can override. */
export type BikePosition = 'hoods' | 'drops' | 'clip-ons' | 'tt-bike';

/** Tire / surface preset. Each maps to a typical Crr (rolling resistance coefficient).
 *  Values from Bicycle Rolling Resistance lab data. */
export type BikeTire = 'race-tubeless' | 'race-clincher' | 'training' | 'gravel';

/** Course profile preset. Drives an effective average gradient + a small wind/headwind
 *  loss factor used by the bike-physics solver. */
export type BikeCourseProfile = 'flat' | 'rolling' | 'hilly';

/** A saved aero/equipment profile. Users may have several (road bike with hoods,
 *  TT bike with clip-ons, etc.) and switch between them on the bike-setup screen. */
export interface BikeAeroProfile {
  id: string;                 // stable id (e.g. 'tt-bike-default', or generated uuid)
  label: string;              // user-facing — "TT bike", "Road bike (hoods)"
  position: BikePosition;
  cda: number;                // m² — effective drag area
  cdaSource: 'preset' | 'calibrated' | 'user';
  crr: number;                // dimensionless rolling resistance
  tire: BikeTire;
  drivetrainEff: number;      // 0.95–0.98 typical (chain + bearings)
  airDensityKgM3: number;     // 1.225 sea-level/15°C; lower at altitude/heat
  /** ISO timestamp of the calibration ride if cdaSource = 'calibrated'. */
  calibratedAtISO?: string;
  /** When cdaSource = 'calibrated', metadata about the ride the value was
   *  inverted from. Lets the modal restore its result panel on reopen so the
   *  user remembers what the number is based on. */
  calibratedRide?: {
    name: string;
    dateISO: string;
    distanceKm: number;
    avgPowerW: number;
    gradientPct: number;
    confidence: 'low' | 'medium' | 'high';
  };
}

/** Bike benchmarks. FTP in watts, LTHR in bpm. Both optional. */
export interface BikeBenchmarks {
  ftp?: number;        // Functional Threshold Power in watts
  /** Where the FTP value came from. 'user' = entered in onboarding; 'derived'
   * = auto-filled from Strava history. The launch-time refresh is allowed to
   * overwrite 'derived' values when fresh data lands; 'user' values are
   * preserved unconditionally. Undefined = pre-provenance value (treat as
   * 'user' to avoid accidentally clobbering manual entries). */
  ftpSource?: 'user' | 'derived';
  /** Confidence in the FTP value at the time it was written. Drives the
   * "estimate — run a test for confidence" caption and the test-card prompt.
   * Mirrors `FtpEstimate.confidence`. Always 'high' when source is 'user' and
   * twentyMinW is present (they ran an actual test). Undefined = pre-confidence
   * value; UI treats as 'medium' so we don't aggressively prompt for tests on
   * existing users until the next launch refresh writes a real tier. */
  ftpConfidence?: 'high' | 'medium' | 'low' | 'none';
  lthr?: number;       // Lactate threshold HR (bike) in bpm
  twentyMinW?: number; // Raw 20-min test watts (if user ran the test)
  hasPowerMeter?: boolean; // Collected at onboarding — gates power-based bTSS vs HR fallback (§18.1)
  bikeWeightKg?: number;   // Mass of the bike (frame + wheels + bottle cages, etc.). Used in
                           // climb-time prediction alongside rider bodyweight; not part of the
                           // FTP→W/kg tier classification (Coggan uses rider weight only).

  /** Saved aero profiles (road bike, TT bike, etc.). The first profile in the
   *  array is the active one used for race-time prediction. Empty/undefined =
   *  fall back to the legacy linear watts→kph fit in race-prediction.triathlon. */
  aeroProfiles?: BikeAeroProfile[];
  /** Course profile assumption for the target race. Affects average gradient
   *  used by the physics solver. Per-race override; default 'flat' for IM/70.3
   *  branded courses unless user picks otherwise. */
  courseProfile?: BikeCourseProfile;

  /** Append-only history of FTP samples. One entry per day (latest wins on a
   *  given day). Populated whenever main.ts auto-derives FTP or the user
   *  manually saves a new value. Powers the FTP trend chart on the tri
   *  Progress detail page; not used for any calculation. */
  ftpHistory?: Array<{
    date: string;             // YYYY-MM-DD
    value: number;            // watts
    source: 'user' | 'derived';
    confidence?: 'high' | 'medium' | 'low' | 'none';
  }>;
}

/** Swim benchmarks. CSS (Critical Swim Speed) is the canonical swim threshold — seconds per 100m. */
export interface SwimBenchmarks {
  cssSecPer100m?: number;    // Critical Swim Speed — lactate-threshold pace per 100m
  /** Provenance for cssSecPer100m — same semantics as BikeBenchmarks.ftpSource. */
  cssSource?: 'user' | 'derived';
  /** Confidence in the CSS value at the time it was written. Drives the
   * "estimate — run a test for confidence" caption and the test-card prompt.
   * Mirrors `CssEstimate.confidence`. Always 'high' when source is 'user' and
   * paired m400+m200 PBs are present. Undefined = pre-confidence value; UI
   * treats as 'medium' so existing users aren't aggressively prompted until
   * the next launch refresh writes a real tier. */
  cssConfidence?: 'high' | 'medium' | 'low' | 'none';
  pbs?: SwimPBs;             // Raw test/PB times from which CSS can be derived
  poolLengthM?: 25 | 33 | 50; // For pace conversion; defaults to 25

  /** Append-only history of CSS samples. One entry per day (latest wins on a
   *  given day). Populated whenever main.ts auto-derives CSS or the user
   *  manually saves a new value. Powers the CSS trend chart on the tri
   *  Progress detail page; not used for any calculation. */
  cssHistory?: Array<{
    date: string;             // YYYY-MM-DD
    value: number;            // sec/100m (lower = faster)
    source: 'user' | 'derived';
    confidence?: 'high' | 'medium' | 'low' | 'none';
  }>;
}

/** Per-discipline fitness EMAs. Mirrors the running-side CTL/ATL but lives under triConfig so running mode is untouched. */
export interface PerDisciplineFitness {
  ctl: number;  // 42-day EMA of TSS for this discipline
  atl: number;  // 7-day EMA of TSS for this discipline
  tsb: number;  // ctl - atl (form/freshness for this discipline)
}

/**
 * Single race outcome — predicted vs actual logged after a target race.
 * Used retrospectively (display only when athlete beat their prediction; v1
 * does not auto-calibrate). v2 may use a rolling average of past gaps as a
 * personal calibration multiplier.
 */
export interface TriRaceLogEntry {
  /** Race id from the race data file (`triathlon-course-profiles.ts`). */
  raceId?: string;
  /** ISO date the race ran. */
  dateISO: string;
  distance: TriathlonDistance;
  /** What we predicted at the time. */
  predictedTotalSec: number;
  predictedPerLeg: { swim: number; bike: number; run: number };
  /** What actually happened. Combined duration of swim+bike+run within the
   *  race window — pulled from synced activities. */
  actualTotalSec: number;
  actualPerLeg: { swim: number; bike: number; run: number };
  /** ISO timestamp when the prediction was last recomputed before the race. */
  predictedAtISO?: string;
}

/** User-editable race predictions targets. Stored to override the model's output (§18.8, stats page). */
export interface TriUserTargets {
  swim?: { secPer100m?: number; totalSec?: number };
  bike?: { watts?: number; avgSpeedKph?: number; totalSec?: number };
  run?: { secPerKm?: number; totalSec?: number };
  t1Sec?: number;  // Transition 1 estimate
  t2Sec?: number;  // Transition 2 estimate
}

/** A single course-factor row surfaced to the UI. */
export interface CourseFactorEntry {
  kind: 'climate' | 'altitude' | 'run-elevation' | 'bike-elevation' | 'wind' | 'swim-type';
  leg: 'swim' | 'bike' | 'run';
  label: string;
  value: string;
  deltaSec: number;
  multiplier: number;
}

/** Which dimension is currently capping the prediction's run-leg pace. */
export type LimitingFactor =
  | 'long_ride_volume'
  | 'long_run_volume'
  | 'volume_durability'
  | null;

/** Per-discipline projected vs current fitness markers used by the live forecast. */
export interface TriProjectionMarkers {
  /** Current and projected sec/100m. Lower = faster. */
  swimCss: { current?: number; projected?: number };
  /** Current and projected watts. Higher = faster. */
  bikeFtp: { current?: number; projected?: number };
  /** Current and projected VDOT. Higher = faster. */
  runVdot: { current?: number; projected?: number };
  /** Weeks remaining until race day. */
  weeksRemaining: number;
}

/** Predicted race time with confidence band. */
export interface TriRacePrediction {
  /**
   * Headline predicted finish — assumes the user sticks with the plan and the
   * horizon model's projected race-day fitness materialises. THIS IS THE
   * PRIMARY NUMBER; the UI shows it as the headline.
   */
  totalSec: number;                // = projectedTotalSec
  /** Per-leg breakdown of the projected (headline) prediction. */
  swimSec: number;
  t1Sec: number;
  bikeSec: number;
  t2Sec: number;
  runSec: number;                  // Includes the §18.4 pace discount (tracking side only)
  totalRangeSec: [number, number]; // ±band on total (§18.8). Narrows as race day approaches.

  /**
   * Secondary number — what the athlete would do if they raced today, with no
   * further training. Renders as a sub-line under the headline; the gap
   * `currentTotalSec - totalSec` is "what the plan delivers".
   */
  currentTotalSec?: number;

  /** Per-leg breakdown for the "if you raced today" number. */
  currentSwimSec?: number;
  currentBikeSec?: number;
  currentRunSec?: number;

  /** Course factors that contributed to the leg adjustments. UI panel rows. */
  courseFactors?: CourseFactorEntry[];

  /**
   * If non-null, the run leg is being capped by recent durability (long-ride
   * or long-run shortfall). UI surfaces this as a banner above the forecast.
   */
  limitingFactor?: LimitingFactor;

  /**
   * Live projection inputs — projected vs current fitness markers per
   * discipline. Useful for debug + future "how am I tracking" panel.
   */
  projection?: TriProjectionMarkers;

  /**
   * Per-discipline adaptation ratios (Phase 2A). Each in [0.70, 1.30]; 1.0 =
   * adapting at population-average rate, > 1.0 = faster, < 1.0 = slower.
   * Computed from up to five signals (HRV, RPE-vs-expected, HR-at-power,
   * Pa:Hr decoupling, CSS pace SD). See `tri-adaptation-ratio.ts`.
   */
  adaptation?: {
    swim: number;
    bike: number;
    run: number;
    signals: {
      hrv: number | null;
      rpeSwim: number | null;
      rpeBike: number | null;
      rpeRun: number | null;
      hrAtPower: number | null;
      pahrBike: number | null;
      pahrRun: number | null;
      cssSd: number | null;
    };
  };

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

  /**
   * History of completed target races — predicted vs actual time per leg.
   * Append-only; used retrospectively for display ("you beat your prediction
   * by X min") and forward-looking calibration in v2.
   */
  raceLog?: TriRaceLogEntry[];

  /**
   * Last-notified marker values. Drives the small "your FTP just improved"
   * toast (CLAUDE.md → Adaptation transparency). At each post-sync trigger we
   * compare current CSS / FTP / VDOT vs this snapshot; if the delta crosses
   * the threshold, surface a toast and update this field so we don't re-pop
   * on every launch.
   */
  notifiedMarkers?: {
    ftp?: number;
    cssSecPer100m?: number;
    vdot?: number;
  };
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
