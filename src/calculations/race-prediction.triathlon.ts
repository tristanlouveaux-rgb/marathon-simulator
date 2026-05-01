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
  T1_SEC_BY_SLIDER,
  T2_SEC_BY_SLIDER,
} from '@/constants/triathlon-constants';
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
import { yearsOfTrainingToExperienceLevel } from '@/constants/triathlon-horizon-params';
import {
  recentHoursByDiscipline,
  plannedSessionsPerWeekByDiscipline,
  longestSessionByDiscipline,
} from './tri-volume-by-discipline';
import { computeTriAdherence } from './tri-adherence';
import { applyCourseFactors } from './course-factors';
import { applyDurabilityCap, DURABILITY_THRESHOLDS } from './durability-cap';
import { computeTriAdaptationRatios, type TriAdaptationRatios } from './tri-adaptation-ratio';
import { computeTriDisciplineConfidence, type TriDisciplineConfidence } from './tri-discipline-confidence';

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
  const raceProfile = raceId ? getTriathlonById(raceId)?.profile : undefined;

  // ── Live projection inputs ───────────────────────────────────────────────
  const weeksRemaining = computeWeeksRemaining(state);
  // Use PLANNED upcoming sessions, not historical actuals — the projection
  // answers "if you stick with the plan, here's race day". For week 1 of a
  // fresh plan with no logged sessions yet, historical would read 0/wk and
  // hit the undertraining penalty, making the projection slower than current.
  const sessions = plannedSessionsPerWeekByDiscipline(state, 4);
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
  const projection = buildProjection({
    currentCss,
    currentFtp,
    currentVdot,
    weeksRemaining,
    sessions,
    adherence,
    experienceLevel,
    distance,
    adaptation,
    disciplineConfidence,
  });

  // ── Compute both predictions: projected (headline) and current ───────────
  // Asymmetric durability: the projection assumes plan execution, including
  // the long-ride / long-run sessions that the plan prescribes. So we credit
  // the projected run leg with threshold-met long sessions (cap relaxed).
  // The current leg keeps the actual long-session shortfall — that's "if you
  // raced today" with no plan execution.
  const projectedLongestSession = {
    swim: longestSession.swim,
    bike: DURABILITY_THRESHOLDS[distance].longRideSec,
    run:  DURABILITY_THRESHOLDS[distance].longRunSec,
  };
  const projected = computeRaceTime({
    state,
    distance,
    legs,
    rating,
    css: projection.swimCss.projected ?? currentCss,
    ftp: projection.bikeFtp.projected ?? currentFtp,
    vdot: projection.runVdot.projected ?? currentVdot,
    raceProfile,
    longestSession: projectedLongestSession,
    applyDurability: true,
  });

  const current = computeRaceTime({
    state,
    distance,
    legs,
    rating,
    css: currentCss,
    ftp: currentFtp,
    vdot: currentVdot,
    raceProfile,
    longestSession,
    applyDurability: true,
  });

  // ── Confidence range ─────────────────────────────────────────────────────
  const totalRangeSec = computeRangeSec(projected.totalSec, distance, weeksRemaining, yearsTraining);

  // ── Sprint/Olympic side-effects (use projected fitness) ──────────────────
  const sideCss = projection.swimCss.projected ?? currentCss;
  const sideBikeKph = projected.bikeAvgKph;
  const sideRunPace = projected.baseRunPaceSecPerKm;
  const sprintTotalSec = estimateSideDistance('sprint', sideCss, sideBikeKph, sideRunPace);
  const olympicTotalSec = estimateSideDistance('olympic', sideCss, sideBikeKph, sideRunPace);

  return {
    totalSec: projected.totalSec,
    swimSec: projected.swimSec,
    t1Sec: projected.t1Sec,
    bikeSec: projected.bikeSec,
    t2Sec: projected.t2Sec,
    runSec: projected.runSec,
    totalRangeSec,
    currentTotalSec: current.totalSec,
    currentSwimSec: current.swimSec,
    currentBikeSec: current.bikeSec,
    currentRunSec: current.runSec,
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
    computedAtISO: new Date().toISOString(),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Build projected race-day fitness markers
// ───────────────────────────────────────────────────────────────────────────

function buildProjection(args: {
  currentCss: number | undefined;
  currentFtp: number | undefined;
  currentVdot: number | undefined;
  weeksRemaining: number;
  sessions: { swim: number; bike: number; run: number };
  adherence: ReturnType<typeof computeTriAdherence>;
  experienceLevel: string;
  distance: '70.3' | 'ironman';
  adaptation: TriAdaptationRatios;
  disciplineConfidence: TriDisciplineConfidence;
}): TriProjectionMarkers {
  const out: TriProjectionMarkers = {
    swimCss: {},
    bikeFtp: {},
    runVdot: {},
    weeksRemaining: args.weeksRemaining,
  };

  // Swim — CSS goes down as ability goes up. Ability-band approximated from CSS:
  // <90 = elite, <100 = advanced, <115 = intermediate, <140 = novice, else beginner.
  // Volume demotion: if recent training is thin we drop the band so the horizon
  // sees more headroom — a strong CSS from a year ago doesn't make you Advanced
  // for the purposes of how fast you can rebuild fitness.
  if (args.currentCss != null) {
    const rawSwimBand = cssToAbilityBand(args.currentCss);
    const swimBand = demoteBandByVolume(rawSwimBand, args.disciplineConfidence.swim.weeksActive);
    const result = applyTriHorizonSwim({
      baseline: args.currentCss,
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

  return out;
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
  longestSession: { swim: number; bike: number; run: number };
  applyDurability: boolean;
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

  // Apply horizon-driven scale: if the projected leg's vdot is higher than
  // current vdot, scale the open-race pace by the gain ratio. Same
  // interpretation as the running side's `calculateLiveForecast` — the
  // training block delivers a fitness improvement that propagates to race
  // time. Skip when blendedOpenSec wasn't used (then the vdot path already
  // applied via vdotToRacePaceSecPerKm).
  if (blendedOpenSec != null && args.vdot != null && args.state.v != null && args.state.v > 0) {
    const horizonRatio = args.vdot / args.state.v;
    if (horizonRatio > 1.0 && horizonRatio < 1.30) {
      // VDOT is higher = faster = pace is shorter. Speed scales roughly
      // linearly with VDOT for a small range; pace = distance / speed.
      baseRunPaceSecPerKm = baseRunPaceSecPerKm / horizonRatio;
    }
  }

  const fatigueDiscount = args.distance === 'ironman' ? RUN_FATIGUE_DISCOUNT_IRONMAN : RUN_FATIGUE_DISCOUNT_70_3;
  const baseRunSec = args.legs.runKm * baseRunPaceSecPerKm * (1 + fatigueDiscount);

  // ── Apply course factors ────────────────────────────────────────────────
  const cf = applyCourseFactors(
    args.raceProfile,
    { swimSec: baseSwimSec, bikeSec: baseBikeSec, runSec: baseRunSec },
    args.legs.runKm,
  );

  let swimSec = baseSwimSec * cf.swimMultiplier;
  let bikeSec = baseBikeSec * cf.bikeMultiplier;
  let runSec = baseRunSec * cf.runMultiplier;

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

  const t1Sec = T1_SEC_BY_SLIDER[args.rating.bike as TriSkillSlider];
  const t2Sec = T2_SEC_BY_SLIDER[args.rating.bike as TriSkillSlider];

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
function cssToAbilityBand(cssSec: number): AbilityBand {
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
function ftpToAbilityBand(ftpW: number): AbilityBand {
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

// Re-export for ergonomics
export { recentHoursByDiscipline };
