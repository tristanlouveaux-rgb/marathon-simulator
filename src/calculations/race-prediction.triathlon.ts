/**
 * Triathlon race-time prediction — live, volume-aware, course-aware.
 *
 * **Side of the line**: tracking. Produces `TriRacePrediction` consumed by the
 * stats and home views. Not consumed by the plan engine.
 *
 * Architecture (mirrors marathon's `calculateLiveForecast` per discipline):
 *
 *   currentFitness (CSS, FTP, VDOT)
 *        │
 *        ▼
 *   applyTriHorizon{Swim|Bike|Run}    ← projected race-day fitness
 *        │
 *        ▼
 *   per-leg pace (CSS+5, FTP→speed via physics, VDOT→pace)
 *        │
 *        ▼
 *   applyCourseFactors                 ← climate, altitude, elevation, wind, swim type
 *        │
 *        ▼
 *   applyDurabilityCap (run only)      ← long-ride / long-run thresholds
 *        │
 *        ▼
 *   final race time + range + limitingFactor
 *
 * The headline number (`totalSec`) is the *projected* race-day finish. The
 * `currentTotalSec` field gives the "if you raced today" alternate. The gap
 * between them is what the plan delivers — see CLAUDE.md "current vs
 * projected" notes.
 *
 * The science behind every constant lives in `docs/SCIENCE_LOG.md` §F (per-
 * discipline horizon model), §G (course factors), §H (durability cap).
 *
 * Per-leg predictions:
 *   - Swim: distance / (CSS + 5 s/100m) — Dekerle 2002 lactate-steady-state.
 *   - Bike: physics-based via `solveSpeed` (`bike-physics.ts`) when FTP + aero
 *     profile + body/bike masses are present; otherwise a skill-slider fallback.
 *   - Run: VDOT → race pace, with §18.4 fatigue discount (11% IM, 5% 70.3),
 *     then capped by recent durability if long sessions are missing.
 *   - T1 / T2: skill-slider defaults.
 */

import type { SimulatorState } from '@/types/state';
import type {
  CourseFactorEntry,
  LimitingFactor,
  TriProjectionMarkers,
  TriRacePrediction,
  TriSkillSlider,
} from '@/types/triathlon';
import {
  RACE_LEG_DISTANCES,
  RUN_FATIGUE_DISCOUNT_70_3,
  RUN_FATIGUE_DISCOUNT_IRONMAN,
  BRICK_MAX_DISCOUNT_REDUCTION,
  BASE_OW_PENALTY_NON_WETSUIT,
  BASE_OW_PENALTY_WETSUIT,
  OW_ADAPT_HALF_SESSIONS,
  T1_SEC_BY_SLIDER,
  T2_SEC_BY_SLIDER,
} from '@/constants/triathlon-constants';
import { detectBricks, computeBrickAdaptation, type DetectionActivity } from './brick-detector';
import {
  solveSpeed,
  paramsFromProfile,
  msToKph,
  RACE_INTENSITY_BY_DISTANCE,
  type BikeCourseProfileExtended,
} from './bike-physics';
import { getTriathlonById } from '@/data/triathlons';
import { getAbilityBand } from './fatigue';
import { cv } from './vdot';
import { blendPredictions } from './predictions';
import { computePredictionInputs, type RunActivityInput } from './prediction-inputs';
import { computeHRCalibratedVdot } from './effort-calibrated-vdot';
import {
  applyTriHorizonSwim,
  applyTriHorizonBike,
  applyTriHorizonRun,
  defaultTaperWeeks,
} from './training-horizon.triathlon';
import {
  yearsOfTrainingToExperienceLevel,
  SWIM_HORIZON_PARAMS,
  BIKE_HORIZON_PARAMS,
  RUN_HORIZON_PARAMS_703,
  RUN_HORIZON_PARAMS_IM,
} from '@/constants/triathlon-horizon-params';
import {
  recentHoursByDiscipline,
  plannedSessionsPerWeekByDiscipline,
  plannedHoursPerWeekByDiscipline,
  longestSessionByDiscipline,
} from './tri-volume-by-discipline';
import { computeTriAdherence } from './tri-adherence';
import { applyCourseFactors } from './course-factors';
import { lookupEmpiricalCourseFactors, pickCourseFactors } from './empirical-course-factors';
import {
  lookupEmpiricalTransitions,
  splitCombinedTransition,
  applySockSavings,
} from './empirical-transitions';
import { applyDurabilityCap, DURABILITY_THRESHOLDS } from './durability-cap';
import { computeTriAdaptationRatios, type TriAdaptationRatios } from './tri-adaptation-ratio';
import { computeTriDisciplineConfidence, type TriDisciplineConfidence } from './tri-discipline-confidence';
import { computeTriRaceReadiness, computeProjectionPenaltyShare } from './race-readiness';
import { RACE_READINESS_TARGETS } from '@/constants/race-readiness-targets';
import { TRI_TAPER_WEEKS } from '@/constants/triathlon-horizon-params';
import { CSS_DETRAINING_PER_4WK } from '@/constants/triathlon-constants';
import {
  CLIMATE_ANCHOR_TEMP_C,
  CLIMATE_RUN_MULTIPLIER,
  CLIMATE_BIKE_MULTIPLIER,
  type ClimateCategory,
} from '@/constants/triathlon-course-factors';

// ───────────────────────────────────────────────────────────────────────────
// Top-level entry point
// ───────────────────────────────────────────────────────────────────────────

export function predictTriathlonRace(state: SimulatorState): TriRacePrediction | null {
  const tri = state.triConfig;
  if (!tri) return null;

  const distance = tri.distance;
  const legs = RACE_LEG_DISTANCES[distance];
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };

  // ── Course profile lookup (race data file is canonical; do not mutate state) ──
  const raceId = state.onboarding?.selectedTriathlonId;
  const raceEntry = raceId ? getTriathlonById(raceId) : undefined;
  const raceProfile = raceEntry?.profile;
  // Race name flows through to empirical course-factor lookup (calibrated
  // against ~1.7M historical finishes per race location). Predictor uses
  // empirical when high/medium confidence; falls back to physical otherwise.
  const raceName = raceEntry?.name;

  // ── Live projection inputs ───────────────────────────────────────────────
  const weeksRemaining = computeWeeksRemaining(state);
  // Use PLANNED upcoming sessions, not historical actuals — the projection
  // answers "if you stick with the plan, here's race day". For week 1 of a
  // fresh plan with no logged sessions yet, historical would read 0/wk and
  // hit the undertraining penalty, making the projection slower than current.
  const sessions = plannedSessionsPerWeekByDiscipline(state, 4);
  const plannedHours = plannedHoursPerWeekByDiscipline(state, 4);
  const adherence = computeTriAdherence(state, 4);
  const longestSession = longestSessionByDiscipline(state, 12);
  const yearsTraining = computeYearsOfTraining(state);
  const experienceLevel = yearsOfTrainingToExperienceLevel(yearsTraining);
  const adaptation = computeTriAdaptationRatios(state);
  const disciplineConfidence = computeTriDisciplineConfidence(state, 12);

  // ── Current fitness markers ──────────────────────────────────────────────
  const currentCss = tri.swim?.cssSecPer100m ?? estimateCSSFromSkill(rating.swim as TriSkillSlider);
  const currentFtp = tri.bike?.ftp;
  // VDOT: take the MAX of `state.v` (Tanda-blended, volume-discounted) and the
  // best PB-derived VDOT. Reason: the Tanda blend tracks current trainability
  // and discounts when run volume is low, but a runner's PB proves their
  // actual capacity. For a triathlete who hasn't run much recently, the PB is
  // the more honest baseline. Daniels' VDOT formula (cv) inverts a known
  // distance/time pair to a VDOT score.
  const currentVdot = state.v;

  // ── Projected race-day fitness markers (the key new piece) ───────────────
  const projectionResult = buildProjection({
    currentCss,
    currentFtp,
    currentVdot,
    cssSource: tri.swim?.cssSource,
    weeksRemaining,
    sessions,
    adherence,
    experienceLevel,
    distance,
    adaptation,
    disciplineConfidence,
  });
  const projection = projectionResult.markers;
  const baselines = projectionResult.baselines;

  // ── Race-readiness penalty (per-discipline) ──────────────────────────────
  // Per-discipline endurance penalty that lowers predictions for athletes
  // whose recent volume / longest sessions don't match the race distance's
  // endurance demands. Generalises the marathon-specificity pattern across
  // triathlon's three disciplines and four distances.
  //
  // **Per-discipline time-to-close scaling.** The penalty represents an
  // endurance-prep gap that *the plan closes over weeks of training at the
  // reference dose*. Closure rate scales per-discipline by both:
  //   1. weeksRemaining (more time = more closure)
  //   2. planned sessions/wk for that discipline vs reference (higher
  //      commitment closes faster; lower commitment leaves more penalty
  //      on race day)
  //
  // So a 12-week plan at 7 sessions/wk closes the gap differently than
  // 12 weeks at 3 sessions/wk — and the per-discipline split means a user
  // committing to bike volume but neglecting run gets bike penalty closed
  // faster than run.
  //
  // `current` (today) always gets the full penalty — the gap exists today
  // regardless of future plans. `projected` (race day) gets the residual
  // penalty after the plan's closing share is credited.
  //
  // Without this scaling, a "race tomorrow" prediction showed today=15:05,
  // projected=13:02 — falsely promising 2 hours of improvement from 1 day
  // of training. The user can't close a multi-week endurance gap overnight.
  //
  // See `src/calculations/race-readiness.ts:computeProjectionPenaltyShare`
  // and SCIENCE_LOG entry "Specific endurance penalty + race-readiness surface".
  const raceReadiness = computeTriRaceReadiness(state, distance);

  // Reference sessions/wk per discipline at intermediate band — anchored to
  // the existing horizon-model parameters so the closure-rate calibration
  // stays in lockstep with the gain-rate calibration. Per-distance
  // `closureWeeks` from `RACE_READINESS_TARGETS` recognises that shorter
  // races have smaller volume gaps to close (sprint = 4w, IM = 12w).
  const swimRef = SWIM_HORIZON_PARAMS.ref_sessions['intermediate'];
  const bikeRef = BIKE_HORIZON_PARAMS.ref_sessions['intermediate'];
  const runRefParams = distance === 'ironman' ? RUN_HORIZON_PARAMS_IM : RUN_HORIZON_PARAMS_703;
  const runRef = runRefParams.ref_sessions['intermediate'];
  const closureWeeks = RACE_READINESS_TARGETS[distance].closureWeeks;

  // Per-discipline taper weeks — subtracted from useful build time so a race
  // in taper window doesn't get "training closure" credit (it's freshness,
  // not endurance build). Per Mujika 2002 + Friel 2018: swim taper is longest
  // (technique consolidation), bike shortest. From `TRI_TAPER_WEEKS`.
  const swimTaper = TRI_TAPER_WEEKS.swim[distance];
  const bikeTaper = TRI_TAPER_WEEKS.bike[distance];
  const runTaper  = TRI_TAPER_WEEKS.run[distance];

  // Per-discipline reference WEEKLY VOLUME (hours for swim/bike, km for run).
  // Combined with planned hours, this lets the dose factor see "5 short bike
  // sessions" as a smaller commitment than "5 long bike sessions" — pure
  // session-count would treat them identically. Run target is in km not hours,
  // so for the run discipline we omit hours and fall back to session-count
  // alone (the run-side `weeklyVolumeKm` signal lives in the readiness
  // `current` calculation, not the projection closure).
  const targets = RACE_READINESS_TARGETS[distance];

  // Per-discipline reference hours (intermediate band) for the dose factor's
  // hours-ratio dimension. Pulled from the per-band targets table — uses
  // intermediate as the reference (athletes above/below intermediate get
  // their per-band target via the band lookup in `computeDisciplineReadiness`,
  // but the hours signal here is a closure-pace reference for the projection,
  // not a readiness threshold). Run target is km/wk not hours; passed as
  // undefined so dose falls back to session-count-only.
  const swimRefHours = targets.swim.byBand.intermediate.weeklyVolume;
  const bikeRefHours = targets.bike.byBand.intermediate.weeklyVolume;

  const swimPenaltyShare = computeProjectionPenaltyShare({
    weeksRemaining, plannedSessions: sessions.swim, refSessions: swimRef,
    closureWeeks, taperWeeks: swimTaper,
    plannedHours: plannedHours.swim, refHours: swimRefHours,
    currentScore: raceReadiness.swim.score,
  });
  const bikePenaltyShare = computeProjectionPenaltyShare({
    weeksRemaining, plannedSessions: sessions.bike, refSessions: bikeRef,
    closureWeeks, taperWeeks: bikeTaper,
    plannedHours: plannedHours.bike, refHours: bikeRefHours,
    currentScore: raceReadiness.bike.score,
  });
  const runPenaltyShare = computeProjectionPenaltyShare({
    weeksRemaining, plannedSessions: sessions.run, refSessions: runRef,
    closureWeeks, taperWeeks: runTaper,
    currentScore: raceReadiness.run.score,
    // Run target is km/wk not hours; pass undefined to fall back to
    // session-count-only dose factor (sessionRatio).
  });
  const projPenalty = (mult: number, share: number) => 1 + (mult - 1) * share;

  // ── Compute both predictions: projected (headline) and current ───────────
  // **Invariant**: when `weeksRemaining ≤ taperWeeks` (race is in the taper
  // window), `projected` must equal `current`. Taper consolidates fitness; it
  // doesn't build it (Mujika 2002), and the user can't acquire new long-session
  // durability or marker gains in 1-3 weeks. Every divergence between the two
  // race-time calls is therefore scaled by the discipline's `executionFactor`
  // = (1 - penaltyShare) — the same closure math the readiness penalty uses.
  //
  // Two divergence shapes:
  //   1. **Stale-measurement adjustments** (e.g. swim engagement penalty) —
  //      represent a TODAY truth (the literal CSS measurement is fiction;
  //      the user's real today CSS is worse). Applied symmetrically: BOTH
  //      `current` and `projected` use the engagement-adjusted baseline. Not
  //      scaled by weeksRemaining.
  //   2. **Plan-execution credits** (e.g. durability cap relaxation —
  //      "the plan's long sessions will materialise before race day"). Scaled
  //      by `executionFactor`. With 1-week IM in full taper → factor = 0 →
  //      projected uses the current longest session → no fake speedup.
  //
  // The discipline's effective baseline (post stale-measurement adjustment)
  // feeds both `computeRaceTime` calls. The projected longest session lerps
  // between the actual and the threshold by `executionFactor`.
  // Swim has no durability cap (durability-cap.ts models bike + run only), so
  // the swim execution factor is unused here. Bike and run lerp between actual
  // and threshold by their respective factors.
  const bikeExecutionFactor = 1 - bikePenaltyShare;
  const runExecutionFactor  = 1 - runPenaltyShare;

  const projectedLongestSession = {
    // Swim has no durability cap; pass through actual longest swim.
    swim: longestSession.swim,
    bike: lerpDurability(
      longestSession.bike,
      DURABILITY_THRESHOLDS[distance].longRideSec,
      bikeExecutionFactor,
    ),
    run: lerpDurability(
      longestSession.run,
      DURABILITY_THRESHOLDS[distance].longRunSec,
      runExecutionFactor,
    ),
  };

  // ── Athlete-history signals for model improvements ───────────────────────
  const allActuals = gatherDetectionActivities(state);
  const detectedBricks = detectBricks(allActuals);
  const brickAdaptation = computeBrickAdaptation(detectedBricks, allActuals);
  const owAdaptation = computeOwAdaptation(state);
  const isWetsuitSwim = isWetsuitSwimCourse(raceProfile);
  const trainingTempC = computeTrainingTempC(state);

  const projected = computeRaceTime({
    state,
    distance,
    legs,
    rating,
    css:  projection.swimCss.projected ?? baselines.css ?? currentCss,
    ftp:  projection.bikeFtp.projected ?? baselines.ftp ?? currentFtp,
    vdot: projection.runVdot.projected ?? baselines.vdot ?? currentVdot,
    raceProfile,
    raceName,
    longestSession: projectedLongestSession,
    applyDurability: true,
    brickAdaptation,
    owAdaptation,
    isWetsuitSwim,
    trainingTempC,
  });

  const current = computeRaceTime({
    state,
    distance,
    legs,
    rating,
    // Use the engagement-adjusted baselines so today and projected sit on the
    // same yardstick. Display values in `projection.{swimCss,bikeFtp,runVdot}.current`
    // remain the literal last measurements for transparency.
    css:  baselines.css  ?? currentCss,
    ftp:  baselines.ftp  ?? currentFtp,
    vdot: baselines.vdot ?? currentVdot,
    raceProfile,
    raceName,
    longestSession,
    applyDurability: true,
    brickAdaptation,
    owAdaptation,
    isWetsuitSwim,
    trainingTempC,
  });

  let adjustedCurrentSwim = current.swimSec * raceReadiness.swim.penaltyMultiplier;
  let adjustedCurrentBike = current.bikeSec * raceReadiness.bike.penaltyMultiplier;
  let adjustedCurrentRun  = current.runSec  * raceReadiness.run.penaltyMultiplier;

  // Apply per-discipline scaled penalty to the projected race-day legs.
  let adjustedProjectedSwim = projected.swimSec * projPenalty(raceReadiness.swim.penaltyMultiplier, swimPenaltyShare);
  let adjustedProjectedBike = projected.bikeSec * projPenalty(raceReadiness.bike.penaltyMultiplier, bikePenaltyShare);
  let adjustedProjectedRun  = projected.runSec  * projPenalty(raceReadiness.run.penaltyMultiplier,  runPenaltyShare);

  // ── Tier-1 calibration bias ──────────────────────────────────────────────
  // Per-user systematic bias (median actual − predicted across past races),
  // capped at ±8% of median predicted leg time at compute time. Applied
  // post-readiness to both projected and current predictions so both
  // surfaces reflect the same systematic correction. Floored at 60s per
  // leg so no discipline gets a nonsensical near-zero value.
  const calBias = (tri.calibration?.tier ?? 0) >= 1 ? tri.calibration!.perLegBiasSec : null;
  if (calBias) {
    adjustedProjectedSwim = Math.max(60, adjustedProjectedSwim + calBias.swim);
    adjustedProjectedBike = Math.max(60, adjustedProjectedBike + calBias.bike);
    adjustedProjectedRun  = Math.max(60, adjustedProjectedRun  + calBias.run);
    adjustedCurrentSwim   = Math.max(60, adjustedCurrentSwim   + calBias.swim);
    adjustedCurrentBike   = Math.max(60, adjustedCurrentBike   + calBias.bike);
    adjustedCurrentRun    = Math.max(60, adjustedCurrentRun    + calBias.run);
  }

  const adjustedCurrentTotal = Math.round(
    adjustedCurrentSwim + current.t1Sec + adjustedCurrentBike + current.t2Sec + adjustedCurrentRun,
  );

  const adjustedProjectedTotal = Math.round(
    adjustedProjectedSwim + projected.t1Sec + adjustedProjectedBike + projected.t2Sec + adjustedProjectedRun,
  );

  // ── Confidence range ─────────────────────────────────────────────────────
  // Anchor to the adjusted projected total — the headline race-day number.
  const totalRangeSec = computeRangeSec(adjustedProjectedTotal, distance, weeksRemaining, yearsTraining);

  // ── Sprint/Olympic side-effects (use projected fitness) ──────────────────
  const sideCss = projection.swimCss.projected ?? currentCss;
  const sideBikeKph = projected.bikeAvgKph;
  const sideRunPace = projected.baseRunPaceSecPerKm;
  const sprintTotalSec = estimateSideDistance('sprint', sideCss, sideBikeKph, sideRunPace);
  const olympicTotalSec = estimateSideDistance('olympic', sideCss, sideBikeKph, sideRunPace);

  return {
    totalSec: adjustedProjectedTotal,
    swimSec: Math.round(adjustedProjectedSwim),
    t1Sec: projected.t1Sec,
    bikeSec: Math.round(adjustedProjectedBike),
    t2Sec: projected.t2Sec,
    runSec: Math.round(adjustedProjectedRun),
    totalRangeSec,
    currentTotalSec: adjustedCurrentTotal,
    currentSwimSec: Math.round(adjustedCurrentSwim),
    currentBikeSec: Math.round(adjustedCurrentBike),
    currentRunSec: Math.round(adjustedCurrentRun),
    courseFactors: projected.courseFactors,
    // Surface the CURRENT-state limiting factor — "you're missing long
    // sessions today" is what the user needs to see. The projected leg
    // already credits the plan with delivering long sessions, so its
    // limitingFactor would always be null and hide the warning.
    limitingFactor: current.limitingFactor,
    projection,
    adaptation,
    sprintTotalSec,
    olympicTotalSec,
    raceReadiness,
    rawProjectedPerLeg: {
      swim: projected.swimSec,
      bike: projected.bikeSec,
      run:  projected.runSec,
    },
    computedAtISO: new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Build projected race-day fitness markers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Effective baselines — the user's *real* today capability, after applying any
 * stale-measurement adjustments (currently swim engagement penalty). These are
 * the inputs both the "today" and "projected" race-time calls should use, so
 * the two predictions sit on the same yardstick. The displayed `current`
 * markers remain the literal last measurement (transparency for the user).
 */
interface EffectiveBaselines {
  css?: number;
  ftp?: number;
  vdot?: number;
}

/**
 * Lerp the projected longest-session duration between the athlete's actual
 * longest and the threshold-met value, by `executionFactor` (0–1).
 *
 * - `executionFactor = 0` (race in taper window): projected = actual. No fake
 *   plan-execution credit when there's no time left to execute.
 * - `executionFactor = 1` (full closure window with reference dose): projected
 *   = threshold. The plan is credited with delivering the long sessions.
 *
 * Crucially never *reduces* the actual — an athlete who already exceeds the
 * threshold keeps the credit; the lerp only adds upward closure.
 */
function lerpDurability(actualSec: number, thresholdSec: number, executionFactor: number): number {
  const t = Math.max(0, Math.min(1, executionFactor));
  const gap = Math.max(0, thresholdSec - actualSec);
  return actualSec + gap * t;
}

function buildProjection(args: {
  currentCss: number | undefined;
  currentFtp: number | undefined;
  currentVdot: number | undefined;
  /** Provenance of the current CSS — `'user'` means the athlete just set it
   * manually and we should treat it as a fresh ground-truth snapshot, even if
   * recent swim activity is sparse. Skips the detraining inflation below. */
  cssSource: 'user' | 'derived' | undefined;
  weeksRemaining: number;
  sessions: { swim: number; bike: number; run: number };
  adherence: ReturnType<typeof computeTriAdherence>;
  experienceLevel: string;
  distance: '70.3' | 'ironman';
  adaptation: TriAdaptationRatios;
  disciplineConfidence: TriDisciplineConfidence;
}): { markers: TriProjectionMarkers; baselines: EffectiveBaselines } {
  const out: TriProjectionMarkers = {
    swimCss: {},
    bikeFtp: {},
    runVdot: {},
    weeksRemaining: args.weeksRemaining,
  };
  const baselines: EffectiveBaselines = {
    css: args.currentCss,
    ftp: args.currentFtp,
    vdot: args.currentVdot,
  };

  // Swim — CSS goes down as ability goes up. Ability-band approximated from CSS:
  // <90 = elite, <100 = advanced, <115 = intermediate, <140 = novice, else beginner.
  // Volume demotion: if recent training is thin we drop the band so the horizon
  // sees more headroom — a strong CSS from a year ago doesn't make you Advanced
  // for the purposes of how fast you can rebuild fitness.
  //
  // Engagement penalty (ISSUE-179): band demotion limits the improvement ceiling
  // but leaves the CSS baseline untouched. When weeksActive is very low the
  // baseline itself is stale — technique decays without water time (Toussaint &
  // Hollander 1994) at a rate consistent with CSS_DETRAINING_PER_4WK (Mujika
  // 2010, 3–5%/4wk → 4% midpoint). We proxy elapsed weeks-off from weeksActive:
  //   0 weeks active → ~12 weeks off → 3 detraining periods → +12% on CSS time
  //   1–2 weeks active → ~8 weeks off → 2 detraining periods → +8%
  //   3–5 weeks active → band demotion already fires; no baseline inflation
  //   ≥6 weeks active → no penalty
  // The penalty is applied only to the horizon baseline, not the displayed CSS
  // value, so the UI still shows the user's actual last measurement.
  if (args.currentCss != null) {
    const swimWeeksActive = args.disciplineConfidence.swim.weeksActive;
    // A user-set CSS is a fresh ground-truth snapshot — skip the detraining
    // inflation even if recent swim activity is sparse. The user has just told
    // the system what their CSS is; we should not project it backwards on the
    // strength of "no swims logged this month".
    const userSetCss = args.cssSource === 'user';
    const swimDetrain4wkPeriods = userSetCss ? 0
      : swimWeeksActive === 0 ? 3
      : swimWeeksActive <= 2 ? 2
      : 0;
    const swimEngagementMultiplier = Math.pow(1 + CSS_DETRAINING_PER_4WK, swimDetrain4wkPeriods);
    const effectiveCssBaseline = args.currentCss * swimEngagementMultiplier;
    // The engagement penalty represents inferred detraining that has already
    // happened — the literal stale measurement no longer reflects today's real
    // CSS. Both the "today" and "projected" race-time predictions should use
    // this same effective baseline so they sit on the same yardstick. The
    // displayed `swimCss.current` keeps the literal value for transparency.
    baselines.css = effectiveCssBaseline;
    if (swimDetrain4wkPeriods > 0) {
      console.log(`[swimEngagement] weeksActive=${swimWeeksActive}, detrain periods=${swimDetrain4wkPeriods}, penalty=${((swimEngagementMultiplier - 1) * 100).toFixed(1)}% → effectiveCss=${effectiveCssBaseline.toFixed(1)} (measured=${args.currentCss})`);
    }
    const rawSwimBand = cssToAbilityBand(args.currentCss);
    const swimBand = demoteBandByVolume(rawSwimBand, swimWeeksActive);
    const result = applyTriHorizonSwim({
      baseline: effectiveCssBaseline,
      weeks_remaining: args.weeksRemaining,
      sessions_per_week: args.sessions.swim,
      ability_band: swimBand,
      taper_weeks: defaultTaperWeeks('swim', args.distance),
      experience_level: args.experienceLevel,
      adherence_penalty_pct: args.adherence.swim.penaltyPct,
      adaptation_ratio: args.adaptation.swim,
    });
    out.swimCss = { current: args.currentCss, projected: result.projected };
  }

  // Bike — FTP. Ability-band from W/kg uses a coarse threshold; we bucket FTP
  // (without weight) into bands based on absolute watts.
  if (args.currentFtp != null) {
    const rawBikeBand = ftpToAbilityBand(args.currentFtp);
    const bikeBand = demoteBandByVolume(rawBikeBand, args.disciplineConfidence.bike.weeksActive);
    const result = applyTriHorizonBike({
      baseline: args.currentFtp,
      weeks_remaining: args.weeksRemaining,
      sessions_per_week: args.sessions.bike,
      ability_band: bikeBand,
      taper_weeks: defaultTaperWeeks('bike', args.distance),
      experience_level: args.experienceLevel,
      adherence_penalty_pct: args.adherence.bike.penaltyPct,
      adaptation_ratio: args.adaptation.bike,
    });
    out.bikeFtp = { current: args.currentFtp, projected: result.projected };
  }

  // Run — VDOT. Reuse marathon's existing ability-band function.
  if (args.currentVdot != null) {
    const rawRunBand = getAbilityBand(args.currentVdot);
    const runBand = demoteBandByVolume(rawRunBand, args.disciplineConfidence.run.weeksActive);
    const result = applyTriHorizonRun({
      baseline: args.currentVdot,
      weeks_remaining: args.weeksRemaining,
      sessions_per_week: args.sessions.run,
      ability_band: runBand,
      taper_weeks: defaultTaperWeeks('run', args.distance),
      experience_level: args.experienceLevel,
      triathlon_distance: args.distance,
      adherence_penalty_pct: args.adherence.run.penaltyPct,
      adaptation_ratio: args.adaptation.run,
    });
    out.runVdot = { current: args.currentVdot, projected: result.projected };
  }

  return { markers: out, baselines };
}

// ───────────────────────────────────────────────────────────────────────────
// Compute one race time given a set of fitness markers
// ───────────────────────────────────────────────────────────────────────────

interface ComputeRaceTimeArgs {
  state: SimulatorState;
  distance: '70.3' | 'ironman';
  legs: { swimM: number; bikeKm: number; runKm: number };
  rating: { swim: number; bike: number; run: number };
  css: number;
  ftp: number | undefined;
  vdot: number | undefined;
  raceProfile: ReturnType<typeof getTriathlonById> extends infer T ? (T extends { profile?: infer P } ? P : undefined) : undefined;
  /** Race name (e.g., "IRONMAN Lanzarote") — drives empirical course-factor lookup. */
  raceName: string | undefined;
  longestSession: { swim: number; bike: number; run: number };
  applyDurability: boolean;
  /** 0–1 score from computeBrickAdaptation. Reduces the run-leg fatigue discount
   *  proportionally to how many recent brick sessions the athlete has logged.
   *  0 = no bricks (full discount), 1 = fully adapted (max 40% discount reduction). */
  brickAdaptation: number;
  /** Open-water adaptation score (0–1). Reduces the pool→OW swim penalty.
   *  0 = never swum OW (full penalty), 1 = experienced OW racer (near-zero penalty). */
  owAdaptation: number;
  /** Whether the race's swim course uses wetsuit — drives which OW base penalty applies. */
  isWetsuitSwim: boolean;
  /** Training heat index in °C derived from recent activity ambientTempC. Null if unavailable. */
  trainingTempC: number | null;
}

interface ComputeRaceTimeResult {
  totalSec: number;
  swimSec: number;
  t1Sec: number;
  bikeSec: number;
  t2Sec: number;
  runSec: number;
  bikeAvgKph: number;
  baseRunPaceSecPerKm: number;
  courseFactors: CourseFactorEntry[];
  limitingFactor: LimitingFactor;
}

function computeRaceTime(args: ComputeRaceTimeArgs): ComputeRaceTimeResult {
  // Swim base: race pace = CSS + 5 s/100m (Dekerle 2002).
  const swimPaceSecPer100m = args.css + 5;
  const baseSwimSec = (args.legs.swimM / 100) * swimPaceSecPer100m;

  // ISSUE-186: Open-water swim deficit scaled by athlete OW experience.
  // Penalty = base penalty × (1 − owAdaptation). Wetsuit races have a smaller
  // base penalty because buoyancy partially offsets OW inefficiencies (Veiga 2013;
  // Toussaint 2002). Applied to baseSwimSec before course factors since it is
  // an athlete-skill offset on pace, not a venue-condition amplification.
  const owBasePenalty = args.isWetsuitSwim ? BASE_OW_PENALTY_WETSUIT : BASE_OW_PENALTY_NON_WETSUIT;
  const owPenaltyFraction = args.owAdaptation < 1 ? owBasePenalty * (1 - args.owAdaptation) : 0;
  const owAdjustedSwimSec = baseSwimSec * (1 + owPenaltyFraction);

  // Bike base: physics-based when possible, else legacy fallback.
  const bikeAvgKph = estimateBikeSpeed(
    args.state,
    args.ftp,
    args.state.triConfig?.bike?.hasPowerMeter,
    args.rating.bike as TriSkillSlider,
    args.distance,
    args.raceProfile?.bikeProfile,
  );
  const baseBikeSec = (args.legs.bikeKm / bikeAvgKph) * 3600;

  // Run base: blend ALL signals (PB + recent run + LT + VO2 + HR-calibrated
  // VDOT + Tanda volume) at the run-leg's actual distance — half-marathon
  // for 70.3, marathon for IM. This is the same `blendPredictions` engine
  // the running side uses for race-time prediction (see predictions.ts).
  // The previous code path read `state.v` which is blended against
  // `s.rd = 'marathon'` (a tri-mode placeholder), pulling Tanda's volume
  // signal at the wrong distance and over-discounting for low recent run
  // volume even when PBs prove higher capacity.
  //
  // Falls back to skill-slider pace if no PB / VDOT / LT data exists.
  const blendedOpenSec = blendOpenRunRaceTime(args.state, args.distance);
  let baseRunPaceSecPerKm: number;
  if (blendedOpenSec != null && blendedOpenSec > 0) {
    baseRunPaceSecPerKm = blendedOpenSec / args.legs.runKm;
  } else if (args.vdot != null) {
    baseRunPaceSecPerKm = vdotToRacePaceSecPerKm(args.vdot, args.distance);
  } else {
    baseRunPaceSecPerKm = estimateRunPaceFromSkill(args.rating.run as TriSkillSlider, args.distance);
  }

  // Apply horizon-driven scale: if the projected leg's VDOT is higher than
  // current, scale the open-race pace by the gain ratio.
  //
  // ISSUE-188: Use run-derived current VDOT as the denominator. `state.v` is
  // the overall blended VDOT which bike training can inflate. Using
  // `runDerivedCurrentVdot` (back-converted from the run-specific blend)
  // makes the denominator explicitly run-anchored. Since `applyTriHorizonRun`
  // applies a percentage improvement, the ratio is numerically equivalent —
  // but the code intent is now explicit and guards against future changes that
  // might decouple the numerator from the run-specific baseline.
  //
  // Skip when blendedOpenSec wasn't used (then the vdot path already
  // applied via vdotToRacePaceSecPerKm).
  if (blendedOpenSec != null && args.vdot != null && args.state.v != null && args.state.v > 0) {
    const runDistM = args.legs.runKm * 1000;
    const runDerivedCurrentVdot = cv(runDistM, blendedOpenSec);
    const denominator = runDerivedCurrentVdot > 0 ? runDerivedCurrentVdot : args.state.v;
    const horizonRatio = args.vdot / denominator;
    if (horizonRatio > 1.0 && horizonRatio < 1.30) {
      // VDOT is higher = faster = pace is shorter. Speed scales roughly
      // linearly with VDOT for a small range; pace = distance / speed.
      baseRunPaceSecPerKm = baseRunPaceSecPerKm / horizonRatio;
    }
  }

  // ISSUE-200: Brick-adapted fatigue discount. Base discount reduced proportionally
  // to recent brick history. Max 40% reduction — even a veteran still fades
  // (Bentley 2007; Landers 2008). Millet & Vleck 2000: brick-specific running
  // economy adapts over 10–15 sessions.
  const baseDiscount = args.distance === 'ironman' ? RUN_FATIGUE_DISCOUNT_IRONMAN : RUN_FATIGUE_DISCOUNT_70_3;
  const fatigueDiscount = baseDiscount * (1 - args.brickAdaptation * BRICK_MAX_DISCOUNT_REDUCTION);

  // ISSUE-191: Marathon PB depth credit on IM run leg only.
  // A sub-3:30 marathoner running the IM marathon (85% intensity) has headroom
  // to maintain form and even pace; a 3:50 marathoner is near their ceiling.
  // Laursen & Rhodes 2001 (triathlon physiology review). Smooth function, not
  // stepped tiers. Recency-gated: recent PBs carry full credit; older ones decay.
  const marathonDepthMultiplier = args.distance === 'ironman'
    ? computeMarathonDepthMultiplier(args.state)
    : 1.0;

  const baseRunSec = args.legs.runKm * baseRunPaceSecPerKm * (1 + fatigueDiscount) * marathonDepthMultiplier;

  // ── Apply course factors ────────────────────────────────────────────────
  // Two sources, picked by confidence:
  //   1. Empirical (calibrated against ~1.7M historical race finishes per
  //      location, athlete-fixed-effects on IM and age/gender-stratified on
  //      70.3). Captures gradient + wind + heat + altitude + course-specific
  //      surface in a single number — implicitly comprehensive.
  //   2. Physical (climate / altitude / elevation / wind / swim type from
  //      the CourseProfile data file). Hand-calibrated science model.
  // When the empirical entry exists with high or medium confidence, use it
  // (more comprehensive). Otherwise fall back to physical.
  // Pass owAdjustedSwimSec as the swim base so course factors multiply on top
  // of the athlete-specific OW skill adjustment (ISSUE-186).
  const baseSec = { swimSec: owAdjustedSwimSec, bikeSec: baseBikeSec, runSec: baseRunSec };
  const empirical = lookupEmpiricalCourseFactors(args.raceName, args.distance, baseSec);
  const physical  = applyCourseFactors(args.raceProfile, baseSec, args.legs.runKm);
  const picked    = pickCourseFactors(empirical, physical);
  const cf        = picked.output;

  let swimSec = owAdjustedSwimSec * cf.swimMultiplier;
  let bikeSec = baseBikeSec * cf.bikeMultiplier;
  let runSec = baseRunSec * cf.runMultiplier;

  // ISSUE-190: Heat acclimatisation discount on run and bike.
  // Athletes training in heat comparable to the race environment perform
  // better than the average field used to calibrate the climate penalty.
  // Lorenzo & Cheuvront 2010: 10–14 days of heat acclimatisation preserves
  // ~3–5% performance. We discount the physical climate penalty by up to 50%.
  // Swim is less heat-sensitive (water cooling) — no discount applied.
  if (args.trainingTempC != null && args.raceProfile?.climate) {
    const { runDiscount, bikeDiscount } = computeHeatAcclimatisationDiscounts(
      args.trainingTempC,
      args.raceProfile.climate,
      baseBikeSec,
      baseRunSec,
    );
    bikeSec -= bikeDiscount;
    runSec  -= runDiscount;
  }

  // ── Apply run-leg durability cap ────────────────────────────────────────
  let limitingFactor: LimitingFactor = null;
  if (args.applyDurability) {
    const dc = applyDurabilityCap(
      { longestRideSec: args.longestSession.bike, longestRunSec: args.longestSession.run },
      args.distance,
    );
    runSec = runSec * dc.multiplier;
    limitingFactor = dc.limitingFactor;
  }

  // ── Resolve transitions ─────────────────────────────────────────────────
  // Priority: user override → empirical (race × level bin) → empirical
  // (global level bin) → skill-slider default. Empirical lookups bin on the
  // user's predicted swim+bike+run (excluding transitions) so the bin is
  // independent of transition skill — see transition-distributions.ts.
  //
  // For 70.3, T1 and T2 come back separately. For IM, the dataset only
  // exposes T1+T2 combined (no per-transition columns), so we split it
  // asymmetrically using the empirical T1 share (~58%) derived from 70.3
  // bins — T1 runs longer than T2 in practice (wetsuit strip, longer
  // transition-zone walks).
  const sliderT1 = T1_SEC_BY_SLIDER[args.rating.bike as TriSkillSlider];
  const sliderT2 = T2_SEC_BY_SLIDER[args.rating.bike as TriSkillSlider];
  const override = args.state.triConfig?.transitionOverride;
  const movingSec = swimSec + bikeSec + runSec;
  const empTrans = args.raceName != null
    ? lookupEmpiricalTransitions(args.raceName, args.distance, movingSec)
    : null;

  let t1Sec: number;
  let t2Sec: number;
  if (override?.t1Sec != null && override?.t2Sec != null) {
    t1Sec = override.t1Sec;
    t2Sec = override.t2Sec;
  } else if (empTrans && empTrans.source !== 'none') {
    if (empTrans.t1Sec != null && empTrans.t2Sec != null) {
      t1Sec = override?.t1Sec ?? Math.round(empTrans.t1Sec);
      t2Sec = override?.t2Sec ?? Math.round(empTrans.t2Sec);
    } else {
      const split = splitCombinedTransition(empTrans.transitionSec ?? sliderT1 + sliderT2);
      t1Sec = override?.t1Sec ?? split.t1;
      t2Sec = override?.t2Sec ?? split.t2;
    }
  } else {
    t1Sec = override?.t1Sec ?? sliderT1;
    t2Sec = override?.t2Sec ?? sliderT2;
  }

  // Sockless modifier: subtract savings only for legs the user has chosen
  // to skip socks on. Applied on top of whichever resolution path won —
  // override, empirical, or slider. The override is treated as the raw
  // transition time with full socks; the selector adjusts from there.
  const sockChoice = args.state.triConfig?.transitionSocks;
  if (sockChoice && sockChoice !== 't1') {
    const adj = applySockSavings(t1Sec, t2Sec, sockChoice);
    t1Sec = adj.t1;
    t2Sec = adj.t2;
  }

  const totalSec = Math.round(swimSec + t1Sec + bikeSec + t2Sec + runSec);

  return {
    totalSec,
    swimSec: Math.round(swimSec),
    t1Sec,
    bikeSec: Math.round(bikeSec),
    t2Sec,
    runSec: Math.round(runSec),
    bikeAvgKph,
    baseRunPaceSecPerKm,
    courseFactors: cf.factors,
    limitingFactor,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Confidence range — narrows as race-day approaches and as data improves
// ───────────────────────────────────────────────────────────────────────────

function computeRangeSec(
  totalSec: number,
  distance: '70.3' | 'ironman',
  weeksRemaining: number,
  yearsTraining: number | undefined,
): [number, number] {
  // Base range: 8% (70.3) / 10% (IM).
  const baseRange = distance === 'ironman' ? 0.10 : 0.08;
  let range = baseRange;

  // Far-out predictions are less certain (more horizon to unfold).
  // Saturating: at 24w out the additional uncertainty is ~+3% (IM).
  const horizonPenalty = Math.min(0.04, weeksRemaining / 24 * 0.04);
  range += horizonPenalty;

  // Years of training adjusts confidence in either direction.
  if (yearsTraining != null) {
    if (yearsTraining < 2) range += 0.02;        // Novice → wider
    else if (yearsTraining >= 5) range -= 0.02;  // Veteran → tighter
  }

  // Clamp.
  const minRange = distance === 'ironman' ? 0.06 : 0.05;
  const maxRange = distance === 'ironman' ? 0.16 : 0.14;
  range = Math.max(minRange, Math.min(maxRange, range));

  return [
    Math.round(totalSec * (1 - range)),
    Math.round(totalSec * (1 + range)),
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers (preserved from the prior implementation, unchanged)
// ───────────────────────────────────────────────────────────────────────────

function estimateCSSFromSkill(slider: TriSkillSlider): number {
  // Linear from 2:50 (slider 1) to 1:25 (slider 5).
  const map: Record<TriSkillSlider, number> = { 1: 170, 2: 150, 3: 120, 4: 100, 5: 85 };
  return map[slider];
}

function estimateBikeSpeed(
  state: SimulatorState,
  ftp: number | undefined,
  hasPower: boolean | undefined,
  skill: TriSkillSlider,
  distance: '70.3' | 'ironman',
  raceBikeProfile: BikeCourseProfileExtended | undefined,
): number {
  const tri = state.triConfig;
  const aero = tri?.bike?.aeroProfiles?.[0];

  // Inheritance order: explicit user-set `tri.bike.courseProfile` wins; else
  // race profile's `bikeProfile`; else 'flat'. The race profile may be
  // 'mountainous' which the bike-physics constants now support.
  const course: BikeCourseProfileExtended =
    tri?.bike?.courseProfile ?? raceBikeProfile ?? 'flat';

  if (hasPower && ftp && aero && state.bodyWeightKg && tri?.bike?.bikeWeightKg) {
    const params = paramsFromProfile(aero, state.bodyWeightKg, tri.bike.bikeWeightKg, course);
    const racePct = RACE_INTENSITY_BY_DISTANCE[distance];
    const raceWatts = ftp * racePct;
    const v = solveSpeed(raceWatts, params);
    if (v > 0) return msToKph(v);
  }

  if (hasPower && ftp) {
    const racePct = distance === 'ironman' ? 0.70 : 0.78;
    const raceWatts = ftp * racePct;
    const kph = Math.min(48, Math.max(18, 20 + (raceWatts - 100) * 0.067));
    return kph;
  }

  const byLevel: Record<TriSkillSlider, number> = { 1: 24, 2: 28, 3: 32, 4: 36, 5: 40 };
  let base = byLevel[skill];
  if (distance === 'ironman') base -= 3;
  return base;
}

function estimateRunPaceFromSkill(skill: TriSkillSlider, distance: '70.3' | 'ironman'): number {
  const byLevel: Record<TriSkillSlider, number> = { 1: 420, 2: 360, 3: 300, 4: 260, 5: 225 };
  let base = byLevel[skill];
  if (distance === '70.3') base -= 15;
  return base;
}

/**
 * Open-race time prediction at the run leg's distance, blending all available
 * signals: PB extrapolation, recent race / TT, LT-derived, VDOT (Daniels),
 * HR-calibrated VDOT (Swain regression on recent HR-tagged runs), and Tanda
 * volume model (marathon-only). Returns predicted seconds at the leg's
 * actual distance, or null if there's not enough data.
 *
 * **Why this matters**: `state.v` is computed by `refreshBlendedFitness`
 * against `state.rd` which in triathlon mode is a placeholder ('marathon').
 * That blend pulls Tanda volume at marathon distance, which can over-
 * discount for low recent run volume even when PBs prove higher capacity.
 * Calling `blendPredictions` directly at the leg's distance avoids that
 * mismatch — for a 70.3 user with a 1:30 half PB, the half-distance blend
 * weights the PB at full strength because Tanda doesn't apply at 21 km.
 */
function blendOpenRunRaceTime(
  state: SimulatorState,
  distance: '70.3' | 'ironman',
): number | null {
  if (!state.pbs || !state.b) return null;

  const targetDistM = distance === 'ironman' ? 42195 : 21097;

  // Collect runs from this plan's actuals + onboarding history.
  const runs: RunActivityInput[] = [];
  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const a of Object.values(wk.garminActuals)) {
      if (!a?.activityType || !/run/i.test(a.activityType)) continue;
      if (!a.startTime || !a.distanceKm || !a.durationSec) continue;
      runs.push({
        startTime: a.startTime,
        distKm: a.distanceKm,
        durSec: a.durationSec,
        activityName: a.displayName,
        activityType: a.activityType,
        avgHR: a.avgHR ?? null,
        hrDrift: a.hrDrift ?? null,
      });
    }
  }
  for (const r of state.onboardingRunHistory ?? []) runs.push(r);

  const inputs = computePredictionInputs(runs);
  const hrVdot = computeHRCalibratedVdot(runs, state.restingHR ?? null, state.maxHR ?? null);

  return blendPredictions(
    targetDistM,
    state.pbs,
    state.lt ?? null,
    state.vo2 ?? null,
    state.b,
    (state.typ ?? 'Balanced').toLowerCase(),
    inputs.recentRun ?? state.rec ?? null,
    state.athleteTier ?? undefined,
    inputs.weeklyKm || undefined,
    inputs.avgPaceSecPerKm ?? undefined,
    { weeksCovered: inputs.weeksCovered, paceConfidence: inputs.paceConfidence, isStale: inputs.isStale },
    hrVdot,
  );
}

function vdotToRacePaceSecPerKm(vdot: number, distance: '70.3' | 'ironman'): number {
  const halfPace = 318 - (vdot - 40) * 3.0;
  const marathonPace = halfPace + 20;
  return distance === 'ironman' ? marathonPace : halfPace;
}

function estimateSideDistance(
  which: 'sprint' | 'olympic',
  cssSec: number,
  bikeKph: number,
  runPaceSecPerKm: number,
): number {
  const dist = which === 'sprint'
    ? { swimM: 750, bikeKm: 20, runKm: 5 }
    : { swimM: 1500, bikeKm: 40, runKm: 10 };
  const swimSec = (dist.swimM / 100) * (cssSec + 5);
  const bikeSec = (dist.bikeKm / bikeKph) * 3600;
  const runSec = dist.runKm * runPaceSecPerKm;
  const transitionBuffer = which === 'sprint' ? 180 : 300;
  return Math.round(swimSec + bikeSec + runSec + transitionBuffer);
}

// ───────────────────────────────────────────────────────────────────────────
// Discipline-specific ability-band approximations
// ───────────────────────────────────────────────────────────────────────────

import type { AbilityBand } from '@/types';

/**
 * Coarse CSS sec/100m → AbilityBand bucket. Anchors:
 *   <90  s/100m = elite   (sub-1:30)
 *   <100 s/100m = advanced
 *   <115 s/100m = intermediate
 *   <140 s/100m = novice
 *   else        = beginner
 */
export function cssToAbilityBand(cssSec: number): AbilityBand {
  if (cssSec < 90)  return 'elite';
  if (cssSec < 100) return 'advanced';
  if (cssSec < 115) return 'intermediate';
  if (cssSec < 140) return 'novice';
  return 'beginner';
}

/**
 * Demote ability band when recent training history is thin. The marker
 * (CSS / FTP / VDOT) reflects peak capacity; the ability band must also
 * reflect *current trainability*. An athlete with a high marker who hasn't
 * trained in months has more headroom (faster early gains as detraining
 * reverses), so the model should treat them as a less-trained band.
 *
 * Rule: each step below the "consistent" threshold (≥6 active weeks in last
 * 12) drops the band by one tier. ≥6 weeks = no demotion. 3–5 weeks = -1.
 * 1–2 weeks = -2. 0 weeks = -2 (capped at beginner).
 */
const BAND_RANK: AbilityBand[] = ['beginner', 'novice', 'intermediate', 'advanced', 'elite'];
function demoteBandByVolume(band: AbilityBand, weeksActive: number): AbilityBand {
  let drop: number;
  if (weeksActive >= 6) drop = 0;
  else if (weeksActive >= 3) drop = 1;
  else                       drop = 2;
  const newRank = Math.max(0, BAND_RANK.indexOf(band) - drop);
  return BAND_RANK[newRank];
}

/**
 * Coarse FTP watts → AbilityBand bucket (sex-neutral, rough age-grouper).
 * Anchored to typical Coggan FTP/kg tiers at ~70 kg rider (i.e. assuming W/kg
 * with 70 kg). Without bodyWeightKg we cannot compute true W/kg here, so this
 * is a fallback approximation. Refine when bodyWeight is reliably available.
 *   < 175W  beginner
 *   < 220W  novice
 *   < 270W  intermediate
 *   < 320W  advanced
 *   else    elite
 */
export function ftpToAbilityBand(ftpW: number): AbilityBand {
  if (ftpW < 175) return 'beginner';
  if (ftpW < 220) return 'novice';
  if (ftpW < 270) return 'intermediate';
  if (ftpW < 320) return 'advanced';
  return 'elite';
}

// ───────────────────────────────────────────────────────────────────────────
// Weeks remaining + years of training
// ───────────────────────────────────────────────────────────────────────────

function computeWeeksRemaining(state: SimulatorState): number {
  const raceDate = state.triConfig?.raceDate;
  if (!raceDate) {
    // No race date set → fall back to the cached weeksToRace, else 12 weeks
    // as a neutral default. The horizon adjuster's `weekFactor` saturates so
    // a wrong default doesn't create a dramatic over-projection.
    return state.triConfig?.weeksToRace ?? 12;
  }
  const today = new Date();
  const race = new Date(raceDate);
  const diffMs = race.getTime() - today.getTime();
  const diffWeeks = diffMs / (1000 * 60 * 60 * 24 * 7);
  return Math.max(0, Math.round(diffWeeks * 10) / 10);
}

function computeYearsOfTraining(state: SimulatorState): number | undefined {
  const iso = state.firstStravaActivityISO;
  if (!iso) return undefined;
  const first = new Date(iso);
  const now = new Date();
  const yrs = (now.getTime() - first.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  return yrs > 0 ? yrs : undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Athlete-history signal helpers (ISSUE-186, 190, 191, 200)
// ───────────────────────────────────────────────────────────────────────────

/** Convert state.wks actuals to DetectionActivity[] for brick detection. */
function gatherDetectionActivities(state: SimulatorState): DetectionActivity[] {
  const activities: DetectionActivity[] = [];
  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (!actual?.startTime || !actual.durationSec) continue;
      const startTs = Date.parse(actual.startTime) / 1000;
      if (isNaN(startTs)) continue;
      activities.push({
        id: actual.garminId,
        sport: actual.activityType ?? '',
        startTs,
        durationSec: actual.durationSec,
      });
    }
  }
  return activities;
}

/**
 * ISSUE-186: Open-water swim adaptation score (0–1).
 * Counts Strava OPEN_WATER_SWIMMING activities in the last 26 weeks with
 * recency weighting (sessions older than 12 weeks count at 50%).
 * Asymptotic curve: `1 − exp(−count / OW_ADAPT_HALF_SESSIONS)`.
 */
function computeOwAdaptation(state: SimulatorState): number {
  const nowMs = Date.now();
  const lookbackMs = 26 * 7 * 24 * 3600 * 1000;
  const halfLifeMs = 12 * 7 * 24 * 3600 * 1000;
  let effectiveCount = 0;

  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      const type = (actual?.activityType ?? '').toUpperCase();
      if (!type.includes('OPEN_WATER')) continue;
      if (!actual.startTime) continue;
      const ageMs = nowMs - Date.parse(actual.startTime);
      if (ageMs < 0 || ageMs > lookbackMs) continue;
      effectiveCount += ageMs > halfLifeMs ? 0.5 : 1.0;
    }
  }

  return 1 - Math.exp(-effectiveCount / OW_ADAPT_HALF_SESSIONS);
}

/** ISSUE-186: Whether the race swim course uses a wetsuit. */
function isWetsuitSwimCourse(
  raceProfile: ComputeRaceTimeArgs['raceProfile'],
): boolean {
  const swimType = raceProfile?.swimType ?? '';
  return swimType.includes('wetsuit') || swimType === 'wetsuit-lake';
}

/**
 * ISSUE-190: Average training temperature from recent outdoor activities.
 * Uses ambientTempC stored on GarminActual (populated by Open-Meteo for
 * outdoor runs/rides with a GPS start location). Returns null when fewer
 * than 4 activities in the last 4 weeks have temperature data.
 */
function computeTrainingTempC(state: SimulatorState): number | null {
  const nowMs = Date.now();
  const lookbackMs = 4 * 7 * 24 * 3600 * 1000;
  const temps: number[] = [];

  for (const wk of state.wks ?? []) {
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (actual?.ambientTempC == null) continue;
      if (!actual.startTime) continue;
      if (nowMs - Date.parse(actual.startTime) > lookbackMs) continue;
      temps.push(actual.ambientTempC);
    }
  }

  if (temps.length < 4) return null;
  return temps.reduce((a, b) => a + b, 0) / temps.length;
}

/**
 * ISSUE-190: Compute heat acclimatisation time savings on bike and run.
 * Returns seconds to subtract from post-course-factor leg times.
 *
 * Logic: if training temperature ≥ race anchor temperature, discount the
 * physical climate penalty by up to 50%. Discount scales linearly from 0
 * (training 15°C cooler than race) to 0.5 (training at or hotter than race).
 * Lorenzo & Cheuvront 2010: 10–14 days of heat acclimatisation → 3–5%
 * performance preservation.
 */
function computeHeatAcclimatisationDiscounts(
  trainingTempC: number,
  raceClimate: ClimateCategory,
  baseBikeSec: number,
  baseRunSec: number,
): { runDiscount: number; bikeDiscount: number } {
  const raceAnchorTemp = CLIMATE_ANCHOR_TEMP_C[raceClimate];
  const runClimatePenaltyFraction  = CLIMATE_RUN_MULTIPLIER[raceClimate]  - 1.0;
  const bikeClimatePenaltyFraction = CLIMATE_BIKE_MULTIPLIER[raceClimate] - 1.0;

  // No meaningful penalty for cool/temperate venues — nothing to discount.
  if (runClimatePenaltyFraction <= 0 && bikeClimatePenaltyFraction <= 0) {
    return { runDiscount: 0, bikeDiscount: 0 };
  }

  const tempGap = raceAnchorTemp - trainingTempC;  // positive = training is cooler
  if (tempGap >= 15) return { runDiscount: 0, bikeDiscount: 0 };

  // Discount fraction: 0.5 at tempGap ≤ 0, 0 at tempGap = 15, linear between.
  const discountFraction = Math.max(0, 0.5 * (1 - tempGap / 15));

  return {
    runDiscount:  baseRunSec  * runClimatePenaltyFraction  * discountFraction,
    bikeDiscount: baseBikeSec * bikeClimatePenaltyFraction * discountFraction,
  };
}

/**
 * ISSUE-191: Marathon PB depth credit for IM run leg.
 * A fast marathoner running the IM marathon (85% intensity) has substantial
 * headroom — they can maintain form and even pace through the back half.
 * Returns a multiplier < 1 (faster) for athletes with recent sub-3:30 PBs.
 *
 * Laursen & Rhodes 2001 (triathlon physiology): marathon-experienced athletes
 * manage IM marathon pacing materially better than matched-VDOT runners with
 * only shorter race experience.
 *
 * MAX_MARATHON_DEPTH_CREDIT = 0.04 (4% pace benefit at sub-2:45, ≈7 min on a
 * 2:45 IM marathon split). Confirmed by Tristan 2026-05-12.
 */
const MAX_MARATHON_DEPTH_CREDIT = 0.04;
const MARATHON_CREDIT_ONSET_SEC = 4.5 * 3600;  // 4:30 — credit starts here
const MARATHON_CREDIT_MAX_SEC   = 2.75 * 3600; // 2:45 — full credit

function computeMarathonDepthMultiplier(state: SimulatorState): number {
  const marathonPbSec = state.pbs?.m;
  if (!marathonPbSec) return 1.0;

  // No credit for slow PBs (≥ 4:30) or missing PBs.
  if (marathonPbSec >= MARATHON_CREDIT_ONSET_SEC) return 1.0;

  // Recency: PB < 2 years = 1.0, 2–4 years = 0.6, > 4 years = 0.3.
  let recencyFactor = 1.0;
  const pbDateISO = state.onboarding?.pbDates?.m;
  if (pbDateISO) {
    const ageDays = (Date.now() - Date.parse(pbDateISO)) / (1000 * 60 * 60 * 24);
    if      (ageDays > 4 * 365) recencyFactor = 0.3;
    else if (ageDays > 2 * 365) recencyFactor = 0.6;
  }

  // Smooth linear from 0 at onset (4:30) to 1 at max (2:45).
  const depthRaw = Math.min(1, (MARATHON_CREDIT_ONSET_SEC - marathonPbSec) /
                               (MARATHON_CREDIT_ONSET_SEC - MARATHON_CREDIT_MAX_SEC));
  const credit = depthRaw * MAX_MARATHON_DEPTH_CREDIT * recencyFactor;

  return 1.0 - credit;
}

// Re-export for ergonomics
export { recentHoursByDiscipline };
