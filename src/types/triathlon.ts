/**
 * Triathlon mode types.
 *
 * Scope: types used throughout plan generation, state, UI, and load model when
 * `SimulatorState.eventType === 'triathlon'`. All triathlon-specific runtime
 * behaviour is gated behind this flag; running mode users see none of it.
 *
 * See `docs/TRIATHLON.md` §18 for the canonical decisions backing this file.
 */

/** Three primary triathlon disciplines. Matches Strava/Garmin activity types. */
export type Discipline = 'swim' | 'bike' | 'run';

/** Triathlon race distance. Sprint/Olympic are predicted as side-effects (§18.10) but are not first-class race targets in v1. */
export type TriathlonDistance = '70.3' | 'ironman';

/** Event type at the top level. Undefined/absent = running (back-compat). */
export type EventType = 'running' | 'triathlon' | 'hyrox';

// ─── HYROX types ────────────────────────────────────────────────────────────

/** HYROX ability band — derived from previous finish time or experience level. */
export type AbilityBand =
  | 'total_beginner'
  | 'beginner'
  | 'novice'
  | 'intermediate'
  | 'advanced'
  | 'competitive';

/** The 8 functional stations in HYROX race order. */
export type HyroxStation =
  | 'ski_erg'
  | 'sled_push'
  | 'sled_pull'
  | 'burpee_broad_jumps'
  | 'row_erg'
  | 'farmer_carry'
  | 'sandbag_lunges'
  | 'wall_balls';

/** HYROX session kinds for plan engine intent resolution. */
export type HyroxSessionKind =
  | 'run_easy'
  | 'run_tempo'
  | 'run_intervals'
  | 'station_technique'
  | 'station_density'
  | 'brick'
  | 'mini_brick';

/** Athlete bias detected from accumulated performance data. */
export type HyroxAthleteBias = 'quick_but_weak' | 'strong_but_slow' | 'balanced';

/**
 * HYROX configuration stored on SimulatorState.
 * All fields optional where not required at initialisation.
 */
export interface HyroxConfig {
  format: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
  athleteBand: AbilityBand;
  hyroxPhase: 'base' | 'build' | 'peak' | 'taper';
  stationAccess: {
    sled: 'always' | 'sometimes' | 'never';
    skiErg: boolean;
    rowErg: boolean;
  };
  /** Previous HYROX finish time in seconds — used to derive band + MTL cap. */
  previousHyroxTimeSec?: number;
  /** Planned MTL for the current week (from plan workouts). Used for cap enforcement display. */
  weeklyMTL: number;
  /** Actual MTL accumulated this week from completed station/brick activities. Computed at activity-match time. */
  weeklyActualMTL?: number;
  /** Per-band weekly MTL cap (derived at init; refinable via benchmark tests). */
  mtlCap: number;
  /** Trailing weekly MTL values (most-recent last). Used for MTL CTL/ATL. */
  mtlHistory: number[];
  /** MTL chronic training load (42-day EMA of weekly MTL). Daily-equivalent (÷7). */
  mtlCTL?: number;
  /** MTL acute training load (7-day EMA of weekly MTL). Daily-equivalent (÷7). */
  mtlATL?: number;
  /** Discipline-split CTL: separate chronic load for run / station / brick.
   *  Mirrors triathlon's per-discipline fitness tracking. Daily-equivalent. */
  runMtlCTL?: number;
  stationMtlCTL?: number;
  brickMtlCTL?: number;
  /** Discipline-split ATL counterparts. */
  runMtlATL?: number;
  stationMtlATL?: number;
  brickMtlATL?: number;
  athleteBias?: HyroxAthleteBias;
  runsPerWeek: number;
  stationSessionsPerWeek: number;
  bricksPerWeek: number;
  raceDate?: string;
  targetFinishTimeSec?: number;
  /** Last-notified marker values — drives the bump notification so toasts
   *  fire once per delta-crossing, not every launch. */
  notifiedMarkers?: { mtlCap?: number; hyroxRunPaceSecKm?: number };
  /** Total available training hours per week (from onboarding slider). Drives session duration scaling. */
  weeklyHoursAvailable: number;
  /** Station benchmarks for Singles format (seconds per station). Treated as Open-weight
   *  baseline unless `benchmarksAtProWeights` is true. */
  stationBenchmarksSingles?: Partial<Record<HyroxStation, number>>;
  /** Station benchmarks for Doubles format (seconds per station). Treated as Open-weight
   *  baseline unless `benchmarksAtProWeights` is true. */
  stationBenchmarksDoubles?: Partial<Record<HyroxStation, number>>;
  /** When true, calibrated benchmarks were set at Pro-division weights, so the
   *  predictor must NOT apply HYROX_PRO_STATION_MULTIPLIER on top when predicting Pro.
   *  Default false: assume Open-weight baseline. */
  benchmarksAtProWeights?: boolean;
  /** Legacy pooled benchmarks — migrated to Singles/Doubles slots on first launch with new code. */
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
  /** Append-only history of station test results, keyed by station. Mirrors
   *  the `ftpHistory` / `cssHistory` pattern in triathlon mode. Each entry
   *  records a single test or measurement; the latest entry per station is
   *  the canonical "current" benchmark (also held in `stationBenchmarksSingles`
   *  / `stationBenchmarksDoubles` for backward-compatible reads).
   *
   *  Sources:
   *   - `'half_test'`: standard half-distance protocol (system doubled the time).
   *   - `'full_test'`: athlete completed the full race-distance station fresh.
   *   - `'race'`: extracted from a race result split.
   *   - `'manual'`: direct entry of a known time.
   *
   *  Ordered chronologically; consumers should sort by `dateISO` if mutating. */
  stationBenchmarkHistory?: Partial<Record<HyroxStation, Array<{
    dateISO: string;
    sec: number;
    source: 'half_test' | 'full_test' | 'race' | 'manual';
    format: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
    /** True if recorded at Pro weights. Mirrors `benchmarksAtProWeights`. */
    proWeights?: boolean;
  }>>>;
  /** Which format the user's previous HYROX time was set in. */
  hyroxPreviousTimeFormat?: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
  /** Which past race the previous time was set at (id from HYROX_WORLD_SERIES). */
  hyroxPreviousTimeRaceId?: string;
  /** ISO date (YYYY-MM-DD) of the previous HYROX time. Either picked directly
   *  during onboarding or derived from `hyroxPreviousTimeRaceId`'s event date.
   *  Used by the race-age staleness model — without it, the model can't decay
   *  trust on year-old benchmarks vs current physiology. */
  hyroxPreviousRaceDate?: string;
  /** User-updated run pace for forecast (sec/km). Overrides population default for band. */
  hyroxRunPaceSecKm?: number;
  /** Provenance of `hyroxRunPaceSecKm`. 'user' = manually entered, 'derived' =
   *  auto-derived from VDOT (mirrors CLAUDE.md "manually-set yields to
   *  improvements" rule), 'seed' = no calibration available, used band default. */
  hyroxRunPaceSource?: 'user' | 'derived' | 'seed';
  /** Bayesian personalisation: observed-vs-population-model run-pace residual
   *  from logged races. Positive = model predicts faster than the athlete
   *  actually runs HYROX (rare); negative = athlete runs faster than the
   *  population model. Magnitude clamped to ±60 s/km. Decays linearly to 0
   *  over 12 months without new race observations. See `hyrox-personal-pace.ts`. */
  personalRunPaceOffsetSec?: number;
  /** ISO timestamp of the most recent race observation that updated the offset. */
  personalRunPaceOffsetUpdatedAtISO?: string;
  /** Confidence weight [0..1] for `personalRunPaceOffsetSec`. Climbs toward
   *  1.0 with each fresh race observation; reset when offset is decayed out. */
  personalRunPaceOffsetConfidence?: number;
  /** Selected race venue id (from `HYROX_VENUES`). Drives course-factor adjustments
   *  on the predicted finish time. Derived from `raceEventId` when an event is picked;
   *  set directly only on the manual-date path. */
  venueId?: string;
  /** Selected race event id (from `HYROX_WORLD_SERIES`). When set, the venue is
   *  derived from the event — no separate venue picker is shown. */
  raceEventId?: string;
  /**
   * Version of the HYROX plan generator that produced `triWorkouts` on each
   * Week. Compared against `HYROX_GENERATOR_VERSION` on launch; if lower, the
   * plan is regenerated automatically so users see updated scheduling and
   * phase compression without resetting their onboarding. Mirrors
   * `TriConfig.generatorVersion`.
   */
  generatorVersion?: number;
  /**
   * Race outcome log — actual race-day finish times against the target.
   * Idempotent on `dateISO`. Mirrors `triConfig.raceLog` for parity across
   * modes. Optional so existing state objects stay valid.
   */
  raceLog?: HyroxRaceLogEntry[];
}

/**
 * Single HYROX race outcome — actual finish time logged after a target race.
 * HYROX has no continuously cached prediction the way triathlon does, so the
 * "predicted" slot stores the user's target if set, otherwise undefined.
 */
export interface HyroxRaceLogEntry {
  /** ISO date the race ran (YYYY-MM-DD). */
  dateISO: string;
  /** Format raced. */
  format: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
  /** User-set target finish time at the moment of detection (seconds). */
  targetTotalSec?: number;
  /** Actual race-day finish — sum of activity duration in the race window. */
  actualTotalSec: number;
  /** Race id from `HYROX_WORLD_SERIES`, if the user picked one. */
  raceEventId?: string;
}

/** One component within a HYROX brick or station session (run leg or station). */
export interface HyroxComponent {
  type: 'run' | HyroxStation;
  /** Distance in metres (run = 1000m, station = race standard distance). */
  distanceM?: number;
  /** Repetition count (wall_balls, burpee_broad_jumps by distance). */
  reps?: number;
  /** Planned duration in seconds for this component (one round). */
  durationSec?: number;
  /** MTL contribution for all rounds of this component. */
  mtl: number;
}

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

  /** Default open-water environment tag for this athlete — applied to
   *  OPEN_WATER_SWIMMING activities at ingest when the activity has no
   *  explicit `swimEnvironment` set. Asked once during onboarding (or first
   *  time an OW swim is ingested). User can change it later from settings.
   *  `pool` is excluded (pool swims are auto-tagged from activityType, not
   *  from this default). See `SWIM_TYPE_MULTIPLIER` for the multipliers. */
  defaultOwSwimEnvironment?: 'wetsuit-lake' | 'non-wetsuit-lake' | 'ocean' | 'river';

  /** What the user actually picked in the reveal modal — display source-of-
   *  truth for the "Swim environment" settings row and chip pre-selection
   *  when re-editing. Includes `pool` (which the OW default cannot hold).
   *  When the user picks `pool`, `defaultOwSwimEnvironment` is cleared so
   *  rare OW swims fall through to the wetsuit-lake baseline (factor 1.0).
   *  When the user picks anything else, both fields stay in sync. */
  primarySwimEnvironment?: 'pool' | 'wetsuit-lake' | 'non-wetsuit-lake' | 'ocean' | 'river';

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
  directCount?: number;  // count of actual activities in this discipline (excludes transfer contributions)
}

/**
 * Single race outcome — predicted vs actual logged after a target race.
 * Used retrospectively (display only when athlete beat their prediction; v1
 * does not auto-calibrate). v2 uses this log for per-user prediction calibration.
 */
export interface TriRaceLogEntry {
  /** Race id from the race data file (`triathlon-course-profiles.ts`). */
  raceId?: string;
  /** ISO date the race ran. */
  dateISO: string;
  distance: TriathlonDistance;
  /** What we predicted at the time (post-readiness-penalty projected values). */
  predictedTotalSec: number;
  predictedPerLeg: { swim: number; bike: number; run: number };
  /**
   * Pre-readiness-penalty projected leg times — raw output of `computeRaceTime`
   * before penaltyMultiplier is applied. Absent in entries logged before WS-1
   * calibration was added. Required for tier-2 maxPenalty scale calibration.
   */
  predictedRawPerLeg?: { swim: number; bike: number; run: number };
  /**
   * `state.v` (Tanda-blended VDOT) at the time the prediction was cached.
   * Used by tier-3 calibration to weight more-recent predictions (computed
   * with a fitness snapshot closer to race-day) more heavily than old ones.
   */
  predictionVdotSnapshot?: number;
  /** What actually happened. Combined duration of swim+bike+run within the
   *  race window — pulled from synced activities. */
  actualTotalSec: number;
  actualPerLeg: { swim: number; bike: number; run: number };
  /** ISO timestamp when the prediction was last recomputed before the race. */
  predictedAtISO?: string;
}

/**
 * Per-user prediction calibration derived from the race log.
 * Tier ladder gates each level on race count so calibration is proportional
 * to the data we have. All fields are optional; consumers default to identity
 * (bias=0, scale=1.0) when absent or when tier=0.
 */
export interface TriCalibration {
  /** Which calibration tier is active. 0 = no calibration (< 2 races). */
  tier: 0 | 1 | 2 | 3;
  /**
   * Tier 1 (n ≥ 2): per-leg additive bias in seconds.
   * bias = median(actual_leg - predicted_leg), capped at ±8% of median
   * predicted leg time. Applied post-readiness to both projected and current
   * predictions.
   */
  perLegBiasSec?: { swim: number; bike: number; run: number };
  /**
   * Tier 2 (n ≥ 4 with predictedRawPerLeg): learned scale factor on the
   * readiness maxPenalty per leg. Bayesian-shrunk toward 1.0 (shrinkage
   * weight = n / (n + 4)), clamped [0.6, 1.4].
   */
  perLegMaxPenaltyScale?: { swim: number; bike: number; run: number };
  /** Tier 3: fitted Riegel fatigue exponent. Dormant until 6+ races span 3+ distances. */
  riegelB?: number;
  doseScale?: number;
  marathonSpecScale?: number;
  /** Number of raceLog entries used to compute this calibration. */
  basedOnRaceCount: number;
  computedAtISO: string;
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

  /**
   * Pre-readiness-penalty projected leg times — raw `computeRaceTime` output
   * before `penaltyMultiplier` is applied. Stored here so `detectAndLogRaceOutcome`
   * can write them into the raceLog entry for tier-2 calibration.
   */
  rawProjectedPerLeg?: { swim: number; bike: number; run: number };

  /**
   * Per-discipline race-readiness scores (0-100) for the "today" prediction.
   * Reflects how well the athlete's recent volume + peak sessions match the
   * race distance's endurance demands. Drives the Race Readiness panel and
   * the per-leg endurance penalty applied to `currentSwimSec` / `currentBikeSec`
   * / `currentRunSec`. Race-day projection (`totalSec`) gets full readiness
   * by definition (plan-prescribed dose meets demand).
   *
   * See `src/calculations/race-readiness.ts` and SCIENCE_LOG entry
   * "Specific endurance penalty + race-readiness surface 2026-05-06".
   */
  raceReadiness?: import('@/calculations/race-readiness').RaceReadinessResult;
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

  /**
   * User-set hardcoded transition times in seconds. When present, these win
   * over both empirical lookups and the skill-slider defaults. Either field
   * may be set independently (e.g. user only knows their T1). For Ironman
   * predictions where empirical data is T1+T2 combined, both fields are
   * honoured separately if set, else summed if only one is set.
   */
  transitionOverride?: {
    t1Sec?: number;
    t2Sec?: number;
  };

  /**
   * Where the user puts their socks on (a single one-time event):
   *   't1'   — sock-on at T1, keep them for the run. Matches the population
   *            baseline that empirical T1/T2 already reflects. No adjustment.
   *   't2'   — sockless on the bike, sock-on at T2 only. Shifts the ~20s
   *            sock-on cost from T1 to T2. Net total unchanged.
   *   'none' — never wears socks. Skip the sock-on cost entirely. −20s on T1.
   *
   * Applied on top of whichever path resolves the base T1/T2 — override,
   * empirical, or slider. An override is treated as the raw transition with
   * full socks; this selector adjusts from there.
   */
  transitionSocks?: 't1' | 't2' | 'none';

  /**
   * Active disciplines for plan generation. Defaults to ['swim','bike','run']
   * when undefined (preserves triathlon behaviour). Single-discipline modes
   * (e.g. cycling-only V1) set this to ['bike'] so the plan engine skips
   * swim/run workout generation.
   */
  disciplines?: Discipline[];

  // Race plan configuration
  raceDate?: string;   // ISO YYYY-MM-DD
  weeksToRace?: number;

  // Per-discipline fitness state (Phase 4)
  fitness?: {
    swim: PerDisciplineFitness;
    bike: PerDisciplineFitness;
    run: PerDisciplineFitness;
    combinedCtl: number;  // Weighted sum per §18.3 transfer matrix
    crossTrainingAtl?: number;  // ATL from non-swim/bike/run activities
    crossTrainingCtl?: number;  // CTL from non-swim/bike/run activities
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
    /** Weekly distance in km per discipline. Populated from Strava history. */
    swimKm?: number;
    bikeKm?: number;
    runKm?: number;
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
   * Append-only; used for retrospective display and prediction calibration.
   */
  raceLog?: TriRaceLogEntry[];

  /**
   * Per-user prediction calibration derived from raceLog.
   * Recomputed after each race outcome is logged and on first launch when
   * raceLog has entries but calibration is absent. tier=0 until 2+ races.
   */
  calibration?: TriCalibration;

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
    /** Last week number when the "3+ weeks high RPE on bike" prompt was shown.
     *  Prevents re-prompting every render once the user has seen it. */
    highRpeBikeWeek?: number;
    /** Set true after the user has dismissed the one-time "we normalise pool /
     *  open-water swims into one CSS, and re-apply your race environment for
     *  the prediction" reveal modal. Prevents re-popping on every launch. */
    swimNormalisationSeen?: boolean;
    /** Last calibration tier shown in the week-debrief modal. Used to detect
     *  first-time tier advances and show a one-time note. */
    calibrationTier?: number;
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
  | 'bike_over_under'   // Alternating 105/95% FTP — lactate clearance at threshold
  | 'bike_vo2_micros'   // Billat 30/30s — accumulates time at VO2max
  | 'bike_vlamax'       // Neuromuscular short sprints — PCr/glycolytic ceiling
  // Combined
  | 'brick';

/** Target intensity representation that generalises across disciplines. */
export interface DisciplineTarget {
  discipline: Discipline;
  // Any combination of the following may be set depending on the discipline and
  // whether the user has a power meter / HR data / known threshold.
  targetPaceSecPer100m?: number;   // Swim
  targetPaceSecPerKm?: number;     // Run
  targetWatts?: number;            // Bike midpoint (requires FTP)
  targetWattsLow?: number;         // Bike lower band bound
  targetWattsHigh?: number;        // Bike upper band bound
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
