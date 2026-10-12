import type { OnboardingState } from '@/types/onboarding';
import type { RunnerType, RaceDistance } from '@/types/training';
import { STATE_SCHEMA_VERSION, type GarminActual } from '@/types/state';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import { getMutableState } from '@/state/store';
import { clearStaleGatesForMode } from '@/injury/engine';
import { saveState } from '@/state/persistence';
import {
  cv, rd, rdKm, calculateFatigueExponent, getRunnerType,
  gp
} from '@/calculations';
import { blendPredictionsPreFloor, demonstratedPBFloorThrough, predictFromRecent } from '@/calculations/predictions';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { pbCapacity, modelPbAgeWeightsIfMeasured, pbEngineFloorVdot, hasRealRunningFitnessSignal } from '@/calculations/physiological-vdot';
import { computeHRCalibratedVdot } from '@/calculations/effort-calibrated-vdot';
import { applyLongRunCap, getLongestRunSec, getQualifyingLongRunCount, DURABILITY_WINDOW_WEEKS } from '@/calculations/run-durability';
import { getPlanPrescribedMeanWeeklyKm } from '@/calculations/training-horizon';
import { computePredictionInputs, measuredWeeklyKm } from '@/calculations/prediction-inputs';
import { raceEffortHrFloorForState } from '@/calculations/heart-rate';
import { refreshForecastCourseFactors } from '@/calculations/course-factors-running';
import { seedStartingPbs, cappedBeginnerStartWeeklyKm } from '@/calculations/beginner-fitness';
import { recomputeLT } from '@/data/ltSync';
import { initializeWeeks } from '@/workouts';
import { isSharpeningBlock } from '@/workouts/phases';
import { buildSharpenBlockState } from '@/workouts/sharpening-block';
import { raceWeekLayout } from '@/workouts/race-week-layout';
import { localMondayKey, localDateKey } from '@/utils/local-date';
import { initializeTriathlonSimulator } from './initialization.triathlon';
import { initializeCyclingSimulator } from './initialization.cycling';
import { initializeHyroxSimulator } from './initialization.hyrox';

export interface CalculationResult {
  success: boolean;
  error?: string;
  runnerType?: RunnerType;
  calculatedRunnerType?: RunnerType;
}

/**
 * Maximum number of archived prior plans kept in `s.previousPlanWks`. Covers
 * ~3 years of plan history at 4 plans/year. Each archive entry has heavy
 * fields (polyline / kmSplits / hrZones) stripped before storage so the cap
 * doesn't blow localStorage quota.
 */
export const MAX_ARCHIVED_PLANS = 12;

/**
 * Strip storage-heavy display-only fields from a wks array before archival,
 * so a long-term user with 10+ plans doesn't run into localStorage quota
 * limits. Only `polyline` (multi-KB encoded GPS string) is dropped. That's
 * 90%+ of the per-activity payload. kmSplits (one int per km) and hrZones
 * (5 ints) stay so the activity-detail popup still renders pace/zone charts
 * for archived activities. Map view loses the route trace; everything else
 * survives.
 */
function _stripHeavyFieldsForArchive(weeks: any[]): any[] {
  return weeks.map(wk => ({
    ...wk,
    garminActuals: Object.fromEntries(
      Object.entries(wk.garminActuals ?? {}).map(([id, a]: [string, any]) => [id, {
        ...a,
        polyline: undefined,
      }]),
    ),
    adhocWorkouts: (wk.adhocWorkouts ?? []).map((w: any) => ({
      ...w,
      polyline: undefined,
    })),
  }));
}

/**
 * Archive the current `s.wks` array into `s.previousPlanWks` before any code
 * path replaces it with fresh plan scaffolding. Without this, every plan reset
 * (running plan generation, triathlon plan generation, downgrade-to-track-only,
 * legacy recalc paths) destroys 10+ weeks of garminActuals / adhocWorkouts /
 * RPE ratings. The data that drives the rolling-load chart, ACWR, freshness
 * TSB history, sleep debt, and coach signals.
 *
 * Idempotent: skips when there's nothing worth archiving (no planStartDate, no
 * activities). Capped at MAX_ARCHIVED_PLANS to bound state size; heavy
 * display-only fields are stripped per `_stripHeavyFieldsForArchive`.
 *
 * MUST be called from every site that assigns to `s.wks` with a fresh array,
 * paired with `redistributeArchivedActivitiesToNewPlan()` AFTER `s.wks` and
 * `s.planStartDate` are set so activities dated within the new plan window
 * land in the new wks instead of getting stranded in the archive.
 */
export function archiveCurrentWksIfPopulated(): void {
  const s = getMutableState() as any;
  if (!s.wks?.length || !s.planStartDate) return;
  const hasData = s.wks.some((w: any) =>
    Object.keys(w?.garminActuals ?? {}).length > 0
    || (w?.adhocWorkouts ?? []).length > 0
  );
  if (!hasData) return;
  // Replace any pre-existing archive entry with the same planStartDate so a
  // re-run of plan generation overwrites instead of duplicating.
  const existing = ((s.previousPlanWks ?? []) as any[]).filter(
    a => a.planStartDate !== s.planStartDate,
  );
  existing.push({
    planStartDate: s.planStartDate,
    weeks: _stripHeavyFieldsForArchive(s.wks),
    archivedAt: new Date().toISOString(),
  });
  s.previousPlanWks = existing.slice(-MAX_ARCHIVED_PLANS);
}

/**
 * After a fresh `s.wks` has been set up (and `s.planStartDate` written), pull
 * any activities from `s.previousPlanWks` whose start_time falls inside the new
 * plan window and re-feed them through `matchAndAutoComplete` so they land in
 * the correct new wk. Without this, regenerating a plan mid-week strands the
 * current week's activities in the archive. They never re-attach to the new
 * plan unless the user manually triggers a Strava sync that re-fetches them.
 *
 * - Runs are matched to planned workouts (auto-complete on high-confidence).
 * - Cross-training is queued into `wk.garminPending` (current week) or logged
 *   as adhoc (past week). Exactly the same path as a live sync.
 * - Dedup: garminId set tracks across all archives so an activity that exists
 *   in two archive entries is only re-fed once.
 *
 * MUST be called AFTER `s.wks = ...` and `s.planStartDate = ...`.
 */
export function redistributeArchivedActivitiesToNewPlan(): void {
  const s = getMutableState() as any;
  if (!s.wks?.length || !s.planStartDate) return;
  const archives = s.previousPlanWks ?? [];
  if (archives.length === 0) return;

  const planStartMs = new Date(s.planStartDate + 'T00:00:00').getTime();
  const planEndMs = planStartMs + s.wks.length * 7 * 86400 * 1000;

  const seen = new Set<string>();
  const rows: GarminActivityRow[] = [];
  for (const archive of archives) {
    for (const wk of archive.weeks ?? []) {
      const actuals = Object.values(wk.garminActuals ?? {}) as GarminActual[];
      for (const a of actuals) {
        if (!a.startTime || !a.garminId) continue;
        if (seen.has(a.garminId)) continue;
        const t = new Date(a.startTime).getTime();
        if (t < planStartMs || t >= planEndMs) continue;
        seen.add(a.garminId);
        rows.push({
          garmin_id: a.garminId,
          activity_type: a.activityType ?? 'RUNNING',
          start_time: a.startTime,
          duration_sec: a.durationSec ?? 0,
          distance_m: a.distanceKm != null ? Math.round(a.distanceKm * 1000) : null,
          avg_pace_sec_km: a.avgPaceSecKm ?? null,
          avg_hr: a.avgHR ?? null,
          max_hr: a.maxHR ?? null,
          calories: a.calories ?? null,
          aerobic_effect: a.aerobicEffect ?? null,
          anaerobic_effect: a.anaerobicEffect ?? null,
          iTrimp: a.iTrimp ?? null,
          hrZones: a.hrZones ?? null,
          hrDrift: a.hrDrift ?? null,
          ambientTempC: a.ambientTempC ?? null,
          polyline: a.polyline ?? null,
          kmSplits: a.kmSplits ?? null,
          elevationGainM: a.elevationGainM ?? null,
          averageWatts: a.averageWatts ?? null,
          normalizedPowerW: a.normalizedPowerW ?? null,
          maxWatts: a.maxWatts ?? null,
          deviceWatts: a.deviceWatts ?? null,
          kilojoules: a.kilojoules ?? null,
        });
      }
    }
  }

  if (rows.length === 0) {
    // Even if no rows to redistribute, still truncate archives at the new plan
    // boundary so a previous continuousMode tail doesn't keep showing up as
    // "Missed" weeks in the past-plan view (the planned-workout templates
    // would survive without their matched actuals otherwise).
    _truncateArchivesAtPlanBoundary(archives, planStartMs);
    return;
  }
  matchAndAutoComplete(rows);

  // Remove the redistributed activities from the archive so they don't appear
  // twice. Once in the live plan (where matchAndAutoComplete just put them)
  // and again in the past-plan view rendered off `previousPlanWks`.
  const redistributedIds = new Set(rows.map(r => r.garmin_id));
  for (const archive of archives) {
    for (const wk of archive.weeks ?? []) {
      if (!wk.garminActuals) continue;
      for (const id of Object.keys(wk.garminActuals)) {
        const a = wk.garminActuals[id];
        if (a?.garminId && redistributedIds.has(a.garminId)) {
          delete wk.garminActuals[id];
        }
      }
    }
  }

  // Truncate every archive's weeks at the new plan's start date. Without this,
  // a past plan whose continuousMode tail extended into today's week shows up
  // as "Past plan · Week 14 · 27 Apr – 3 May" with all-missed planned workouts
  // sitting on top of the new plan's same-week actuals.
  _truncateArchivesAtPlanBoundary(archives, planStartMs);

  console.log(`[plan-reset] Redistributed ${rows.length} archived activities into new plan window (removed from archive + truncated overlapping weeks to dedupe)`);
}

/**
 * Drop any archive weeks whose start date is on or after the new plan's start.
 * Keeps the archive a clean retrospective of the period before the new plan.
 * Idempotent: archives whose weeks array is already shorter are left alone.
 */
function _truncateArchivesAtPlanBoundary(archives: any[], newPlanStartMs: number): void {
  for (const archive of archives) {
    if (!archive?.weeks?.length || !archive.planStartDate) continue;
    const archStartMs = new Date(archive.planStartDate + 'T00:00:00').getTime();
    let firstOverlapIdx = -1;
    for (let i = 0; i < archive.weeks.length; i++) {
      const wkStartMs = archStartMs + i * 7 * 86400 * 1000;
      if (wkStartMs >= newPlanStartMs) {
        firstOverlapIdx = i;
        break;
      }
    }
    if (firstOverlapIdx >= 0) {
      const dropped = archive.weeks.length - firstOverlapIdx;
      archive.weeks.length = firstOverlapIdx;
      console.log(`[plan-reset] Truncated ${dropped} overlapping week(s) from archive starting ${archive.planStartDate}`);
    }
  }
}

/**
 * Compute effective runner type from physics (PBs → b → calculated) and user override.
 *
 * RULES:
 * - Always compute b from PBs (physics, never fake)
 * - Always compute calculatedRunnerType from b
 * - If confirmedRunnerType exists, use it as effectiveRunnerType (style override)
 * - Otherwise, use calculatedRunnerType
 *
 * @param b - Fatigue exponent from PBs
 * @param confirmedRunnerType - User's confirmed/overridden runner type (or null)
 * @returns { calculatedRunnerType, effectiveRunnerType }
 */
export function computeEffectiveRunnerType(
  b: number,
  confirmedRunnerType: RunnerType | null | undefined
): { calculatedRunnerType: RunnerType; effectiveRunnerType: RunnerType } {
  // Calculate from physics
  const calculatedRunnerType = getRunnerType(b);

  // Use confirmed override if present, otherwise use calculated
  const effectiveRunnerType = confirmedRunnerType ?? calculatedRunnerType;

  return { calculatedRunnerType, effectiveRunnerType };
}

/**
 * Shared initialization logic. Populates SimulatorState from OnboardingState.
 * Used by: wizard initializing step, demo button, dashboard re-calc.
 */
export function initializeSimulator(state: OnboardingState): CalculationResult {
  try {
    const s = getMutableState();

    // Triathlon fork (§18.1): route to the dedicated triathlon initializer so
    // running-mode setup is untouched.
    if (state.trainingMode === 'triathlon') {
      return initializeTriathlonSimulator(state);
    }

    // Cycling fork (V1): single-discipline mode that reuses the triathlon
    // plan engine with disciplines=['bike']. Plan engine + per-discipline
    // CTL/ATL all key off the disciplines array so swim/run paths stay dark.
    if (state.trainingMode === 'cycling') {
      return initializeCyclingSimulator(state);
    }

    // HYROX fork: run + functional stations. Dedicated plan engine (Phase 1)
    // fills weeks; Phase 0 creates skeleton weeks so the wizard completes.
    if (state.trainingMode === 'hyrox') {
      return initializeHyroxSimulator(state);
    }

    // Just-Track mode: no plan is generated, but the state scaffolding is the
    // same as any non-event continuous user. A rolling week bucket so that
    // activity sync, GPS recordings, readiness, CTL, and ACWR all work
    // unchanged. The only visible differences are: (1) no prescribed workouts
    // inside each week, (2) views hide prescription UI (today-workout,
    // race-forecast, plan-adherence), (3) `advanceWeekToToday` extends weeks
    // one at a time with no phase cycling.
    if (state.trackOnly) {
      archiveCurrentWksIfPopulated();
      s.trackOnly = true;
      s.continuousMode = true;         // reuse non-event calendar extension path
      s.w = 1;
      s.tw = 1;                        // rolling. AdvanceWeekToToday extends as calendar moves
      s.wks = [{
        w: 1,
        ph: 'base',                    // harmless label; views hide phase for trackOnly
        rated: {},
        skip: [],
        cross: [],
        wkGain: 0,
        workoutMods: [],
        adjustments: [],
        unspentLoad: 0,
        extraRunLoad: 0,
      }];
      s.skip = [];
      s.timp = 0;
      s.rpeAdj = 0;
      s.schemaVersion = STATE_SCHEMA_VERSION;
      // Local calendar dates (approved default Q10: every mode), as the race-plan path.
      s.planStartDate = localMondayKey(new Date());
      s.planCreatedAt = localDateKey(new Date()); // days before today aren't "Missed"
      s.onboarding = state;

      // Persist whatever the user provided. PBs aren't required for trackOnly —
      // VDOT stays null / unchanged if the user skipped PB entry. Readiness and
      // CTL are driven by synced data, not the wizard, so they bootstrap
      // independently on first sync.
      if (state.pbs && Object.keys(state.pbs).length) {
        s.pbs = state.pbs;
        try {
          const b = calculateFatigueExponent(state.pbs);
          const { calculatedRunnerType, effectiveRunnerType } = computeEffectiveRunnerType(
            b, state.confirmedRunnerType
          );
          s.b = b;
          s.calculatedRunnerType = calculatedRunnerType;
          s.typ = effectiveRunnerType;
        } catch { /* PBs invalid — leave defaults */ }
      }
      if (state.recentRace) s.rec = state.recentRace;
      if (state.ltPace != null) { s.lt = state.ltPace; s.ltPace = state.ltPace; }
      if (state.vo2max != null) { s.vo2 = state.vo2max; s.vo2UpdatedAt = undefined; }
      if (state.restingHR) s.restingHR = state.restingHR;
      if (state.maxHR) s.maxHR = state.maxHR;
      if (state.biologicalSex) s.biologicalSex = state.biologicalSex;
      if (state.bodyWeightKg) s.bodyWeightKg = state.bodyWeightKg;
      if (state.heightCm) s.heightCm = state.heightCm;
      if (state.recurringActivities?.length) s.recurringActivities = [...state.recurringActivities];

      // Commute config. Just-track has no plan to fold commute volume into, but
      // the per-activity tag + load-carriage adjustment are mode-agnostic and
      // still apply, so the captured config must survive. Transfer it the same
      // way the plan path does (initialization.ts:529).
      if (state.runsToWork && state.commuteConfig) {
        s.commuteConfig = state.commuteConfig;
      } else {
        s.commuteConfig = undefined;
      }

      // Seed volume from detected Strava history if available (same rule as
      // the full plan path). Used by stats / weekly summary, not by
      // plan-generation (there is none).
      if (s.detectedWeeklyKm != null && (s.stravaHistoryAccepted || s.weeklyVolumeConfirmed)) {
        s.wkm = Math.round(s.detectedWeeklyKm);
      }

      redistributeArchivedActivitiesToNewPlan();
      // One forecast (review round 5, 2026-10-12; mirror of the running,
      // triathlon and HYROX initializers). The wizard lands Just-Track on Home
      // without launchApp, so without this the store defaults (s.v 50, s.lt
      // null) stood until the next app open, and the Stats race estimates
      // (predictStandardDistances) changed after the first relaunch (10K 45:00:
      // marathon 3:52:33 at onboarding, 3:49:58 after). The launch refresh runs
      // recomputeLT and, with PBs, the blend; without PBs it returns before the
      // blend (the trackOnly guard), as at launch. One call converges.
      refreshBlendedFitness(s);
      saveState();
      return { success: true };
    }

    let pbs = state.pbs;

    // Validate PBs. A running plan needs a fitness anchor. Most experience
    // levels imply a known time, so they still require a real PB. But true
    // beginners (and cross-sport "hybrid" athletes) may genuinely have none —
    // rather than wall them out, seed a conservative, DERIVED starting estimate
    // (band-floor VDOT, see beginner-fitness.ts) and flag it so it yields to
    // real runs. The plan starts gentle and self-corrects within a week or two.
    if (!Object.keys(pbs).length) {
      const seeded = seedStartingPbs(state.experienceLevel);
      if (seeded) {
        pbs = seeded;
        s.startingFitnessEstimated = true;
        console.log(`[init] No PB for "${state.experienceLevel}" — seeded conservative starting fitness (5K ${Math.round((seeded.k5 ?? 0) / 60)}min). Will refine from real runs.`);
      } else {
        return { success: false, error: 'No personal bests provided' };
      }
    } else {
      s.startingFitnessEstimated = false;
    }

    // Calculate fatigue exponent (physics - always from PBs)
    const b = calculateFatigueExponent(pbs);

    // Compute effective runner type (respects user override if present)
    const { calculatedRunnerType, effectiveRunnerType } = computeEffectiveRunnerType(
      b,
      state.confirmedRunnerType
    );

    // For blendPredictions, we use the effective type (user preference or calculated)
    const runnerType = effectiveRunnerType;

    // Target distance for workout pacing. For event plans this is the user's
    // picked race. For no-event (continuous) plans the user never picked a
    // distance, so we derive a pacing reference from focus: endurance → half,
    // speed → 5K, balanced → 10K. This value drives MP / HMP zones internally;
    // UI hides it for continuous-mode users (home + plan-preview read
    // s.continuousMode to swap in a focus label instead of a race title).
    const targetDistStr: RaceDistance = state.trainingForEvent === false
      ? (state.trainingFocus === 'speed' ? '5k'
        : state.trainingFocus === 'both' ? '10k'
        : 'half')
      : (state.raceDistance || 'half');
    const targetDistMeters = rd(targetDistStr);

    // Plan calendar (race-week-layout.ts). Weeks run Monday to Sunday from this
    // local Monday. With a race date the plan runs through the week holding race
    // day: race week is the week holding the day 3 days out, and a Monday to
    // Wednesday race adds a closing week holding only the race. Training weeks
    // (through race week) are the plan's horizon: phases, engine, forecast.
    // Without a race date (5K/10K length slider, continuous) the wizard's week
    // count stands.
    const planStartISO = localMondayKey(new Date());
    const raceDateForPlan = state.trainingForEvent === false
      ? null
      : (state.selectedRace?.date ?? state.customRaceDate ?? null);
    const raceLayout = raceDateForPlan ? raceWeekLayout(planStartISO, raceDateForPlan) : null;
    const trainingWeeks = raceLayout ? raceLayout.trainingWeeks : state.planDurationWeeks;
    const calendarWeeks = raceLayout ? raceLayout.calendarWeeks : state.planDurationWeeks;

    // Recent race for blending
    const rec = state.recentRace;

    // LT and VO2 from fitness data step
    const ltPace = state.ltPace || null;
    const vo2max = state.vo2max || null;

    // Calculate blended prediction with all available data. Pass volume
    // signals derived from onboardingRunHistory (the runs the wizard pipeline
    // just seeded from Strava) so:
    //   1. Tanda can fire when there's enough recent training data
    //   2. The marathon-specificity penalty fires when Tanda gates out and
    //      recent volume is low (otherwise the baseline locks at PB time
    //      regardless of the user's actual current marathon-specific fitness)
    // computePredictionInputs returns weeklyKm=0 for users with no recent
    // qualifying runs, which is the explicit signal the penalty needs.
    const sCurrent = getMutableState();
    const runsForBlend = (sCurrent.onboardingRunHistory ?? []).map(r => ({
      startTime: r.startTime,
      distKm: r.distKm,
      durSec: r.durSec,
      activityType: r.activityType,
      avgHR: r.avgHR ?? null,
    }));
    // Race-effort HR test on the same HR effort profile the plan will hold
    // (state.maxHR / restingHR win over synced values, as committed below).
    const blendInputs = computePredictionInputs(runsForBlend, undefined, raceEffortHrFloorForState({
      maxHR: state.maxHR || sCurrent.maxHR,
      restingHR: state.restingHR || sCurrent.restingHR,
      onboarding: { age: state.age },
    }));

    // Marathon PB age (days) for the marathon-specificity penalty's PB-recency
    // scaling. A recent marathon PB demonstrates current capability and lightens
    // the penalty (which otherwise assumes PB is stale).
    const marathonPbDateISO = state.pbDates?.m;
    const marathonPbAgeDays = marathonPbDateISO
      ? Math.max(0, Math.floor((Date.now() - new Date(marathonPbDateISO).getTime()) / (24 * 60 * 60 * 1000)))
      : undefined;

    // Effective aerobic cross-training sessions/week (intensity-weighted).
    // Computed here (before the blend) so it can soften the short-distance
    // low-volume discount: a heavy cross-trainer's watch LT/VO2 are current, not
    // stale. Reused below for `effectiveSessions` so there is a single source.
    const runsPerWeek = state.runsPerWeek;
    const INTENSITY_FACTOR: Record<string, number> = { easy: 0.5, moderate: 0.7, hard: 0.9 };
    let effectiveCrossSessions = 0;
    if (state.recurringActivities && state.recurringActivities.length > 0) {
      for (const act of state.recurringActivities) {
        const iFactor = INTENSITY_FACTOR[act.intensity] || 0.7;
        effectiveCrossSessions += (act.durationMin / 60) * iFactor * act.frequency;
      }
    } else {
      effectiveCrossSessions = 0.5 * (state.sportsPerWeek || 0);
    }
    if (state.activeLifestyle) effectiveCrossSessions += 0.5;

    // Auto-prefill the cross-trained marker when the user didn't explicitly set
    // it in the experience step. Reuses the single canonical effectiveCrossSessions
    // signal (no parallel detector). The 1.0 bar excludes incidental activity
    // (activeLifestyle alone contributes only 0.5) and represents roughly one
    // moderate aerobic cross-session per week. Explicit user choice (true/false)
    // is always respected; this only fills an unset value. Tunable prefill bar.
    if (state.crossTrainedBackground == null && effectiveCrossSessions >= 1.0) {
      state.crossTrainedBackground = true;
    }

    // Best-available weekly-volume signal, with provenance. Ranked:
    //   MEASURED — synced history (weeksCovered>0) OR a user-typed weekly km
    //     (detectedWeeklyKm). A real number we can trust as detraining evidence.
    //   ESTIMATED — when there is no measured signal, derive km from runs/week
    //     (the SAME `freqVolumeEstimate` the plan uses for s.wkm below, so the
    //     prediction and the plan can never disagree about assumed volume). Good
    //     enough to size the marathon-specificity penalty, but it is an
    //     assumption, so it must NOT override a demonstrated same-distance PB
    //     (the demonstratedPBFloor ignores estimated volume — see below).
    // The old "explicit zero = max detraining" overload is gone: a brand-new
    // user is now sized from their stated frequency, not from a phantom zero.
    const measuredKm = measuredWeeklyKm(blendInputs, sCurrent.detectedWeeklyKm);
    const freqVolumeEstimate = state.runsPerWeek <= 3 ? state.runsPerWeek * 10
      : state.runsPerWeek === 4 ? 40 : state.runsPerWeek === 5 ? 50
      : state.runsPerWeek === 6 ? 60 : 70;
    const weeklyKmSignal = measuredKm != null ? measuredKm : freqVolumeEstimate;
    const weeklyKmIsEstimate = measuredKm == null;
    // PB age weights (pbAgeWeight, a smooth 3-year half-life) on the shared
    // measured-volume gate (modelPbAgeWeightsIfMeasured, as the refresh): with
    // no running data an old PB keeps full weight (§BV). Dates belong to the
    // onboarding PBs (state.pbDates with state.pbs); a seeded or typed PB has
    // none and weighs 1. Stored PBs never change.
    const pbAgeWeights = modelPbAgeWeightsIfMeasured(
      pbs, { onboarding: state, detectedWeeklyKm: sCurrent.detectedWeeklyKm }, blendInputs, new Date(),
    );

    // Note: blendPredictions uses runnerType.toLowerCase() internally. The
    // blend before the demonstrated-PB floor: the floor runs once below, after
    // the durability cap (demonstratedPBFloorThrough), at the PB's age weight.
    const blendedTime = blendPredictionsPreFloor(
      targetDistMeters, pbs, ltPace, vo2max, b,
      runnerType.toLowerCase(),
      blendInputs.recentRun ?? rec ?? null,
      undefined,                             // athleteTier (set later)
      weeklyKmSignal,
      blendInputs.avgPaceSecPerKm ?? undefined,
      {
        weeksCovered: blendInputs.weeksCovered,
        paceConfidence: blendInputs.paceConfidence,
        isStale: blendInputs.isStale,
      },
      undefined,                             // hrVdot (not derived at onboarding finalize)
      marathonPbAgeDays,
      weeklyKmIsEstimate,
      effectiveCrossSessions,
      pbAgeWeights,
    );

    if (!blendedTime || isNaN(blendedTime) || blendedTime <= 0) {
      return { success: false, error: 'Could not calculate race prediction' };
    }

    // Long-run durability cap — parity with refreshBlendedFitness (the
    // canonical refresher applies this cap before deriving VDOT; see
    // blended-fitness.ts). Without it, the onboarding anchor is a raw
    // capacity extrapolation (e.g. a single 5K PB Riegel-projected to a
    // half with zero run history behind it), and the first backfill
    // refresh would silently slow it by up to 4-5%. Longest run reads the
    // freshly-seeded onboardingRunHistory plus any prior-plan actuals
    // (s.wks is not yet archived here) over the same 12-week window the
    // refresher uses. Calibration bias (runRaceLog) is intentionally not
    // mirrored: onboarding users have no logged races against THIS plan
    // yet, and the first refresh applies it regardless.
    const longestRunSec = getLongestRunSec(sCurrent, DURABILITY_WINDOW_WEEKS);
    const durability = applyLongRunCap(longestRunSec, targetDistStr, getQualifyingLongRunCount(sCurrent, targetDistStr, DURABILITY_WINDOW_WEEKS));
    // The durability cap is a short-anchor-extrapolation penalty (e.g. a single
    // 5K Riegel-projected to a half with no endurance base). It must NOT push the
    // anchor slower than a time the athlete has actually run at the target
    // distance, absent detraining evidence — so floor at any same-distance PB
    // before and after the cap, once per pipeline at the PB's age weight
    // (demonstratedPBFloorThrough, as refreshBlendedFitness). See demonstratedPBFloor.
    const cappedBlendedTime = demonstratedPBFloorThrough(
      blendedTime,
      targetDistMeters,
      pbs,
      {
        weeklyRunKm: weeklyKmSignal,
        weeklyRunKmIsEstimate: weeklyKmIsEstimate,
        recentRun: blendInputs.recentRun ?? rec ?? null,
        b,
        pbAgeWeights,
      },
      (t) => t * durability.multiplier,
    );

    // ── Engine vs race-readiness separation (ISSUE-297, RC1) ────────────────
    // Mirror of refreshBlendedFitness. `cappedBlendedTime` is a race-readiness
    // time carrying the low-volume / marathon-specificity penalties; back-
    // deriving the GLOBAL engine VDOT from it buries demonstrated capacity (a
    // 20:00 5K → VDOT ~50 collapses to ~40 off 8 km/wk), then feeds paces, plan
    // generation and the forecast. The engine is floored at PB-median capacity
    // (`pbCapacity`, age-weighted) unless a recent race effort (`recentRun`, a
    // run more than 15% faster than the window's median pace and, with HR, at
    // race level) demonstrates real slowness. Low training volume is
    // deliberately NOT engine-decay evidence: it limits readiness (modelled on
    // the prediction + forecast), not aerobic capacity.
    const penalisedVdot = cv(targetDistMeters, cappedBlendedTime);
    // PB capacity: age-weighted median (pbCapacity) on the same gated weights
    // as the blend (pbAgeWeights), as pbCapacityForState in the refresh. The floor is
    // pbEngineFloorVdot, shared with refreshBlendedFitness: PB capacity for a
    // fresh or undated median PB; for an aged one, with a measured volume, the
    // age-weighted mean of capacity and a medium+ HR fit. The HR fit is the
    // one the first refresh computes (computeHRCalibratedVdot over the same
    // runs and HR profile), so onboarding and the refresh give an aged PB the
    // same engine. The onboarding blend has no HR-fit or PB-derived LT
    // predictor, so a pull toward the penalised blend could not agree.
    const capacity = pbCapacity(pbs, pbAgeWeights);
    const capacityVdot = capacity?.vdot ?? null;
    const onboardingHrFit = computeHRCalibratedVdot(
      sCurrent.onboardingRunHistory ?? [],
      state.restingHR || sCurrent.restingHR || null,
      state.maxHR || sCurrent.maxHR || null,
    );
    let engineVdot = penalisedVdot;
    if (capacity != null && capacityVdot != null && capacityVdot > penalisedVdot) {
      const recentForEngine = blendInputs.recentRun ?? rec ?? null;
      const tRecentAtTarget = recentForEngine && recentForEngine.t > 0
        ? predictFromRecent(targetDistMeters, recentForEngine, pbs, b)
        : null;
      const recentVdot = tRecentAtTarget != null && tRecentAtTarget > 0
        ? cv(targetDistMeters, tRecentAtTarget)
        : null;
      const recentDemonstratesSlowness = recentVdot != null && recentVdot < capacityVdot;
      if (!recentDemonstratesSlowness) {
        const floor = pbEngineFloorVdot(capacity, { ageWeightsApply: pbAgeWeights != null, hrFit: onboardingHrFit });
        engineVdot = Math.max(penalisedVdot, floor);
        console.log(`[init] engine floored at PB capacity: penalised VDOT ${penalisedVdot.toFixed(1)} buried below demonstrated capacity ${capacityVdot.toFixed(1)} with no recent-run evidence → engine held at ${engineVdot.toFixed(1)} (median PB age weight ${capacity.weight}; low volume is readiness, not engine; ISSUE-297)`);
      }
    }
    // `curr` is now the ENGINE (capacity), so paces, s.v and the anchor agree on
    // capacity rather than the penalised readiness number.
    const curr = engineVdot;
    const pac = gp(curr, ltPace);

    // `runsPerWeek` + `effectiveCrossSessions` were computed above (before the
    // blend, so cross-training could soften the short-distance discount).
    const effectiveSessions = runsPerWeek + effectiveCrossSessions;

    // Update state
    s.trackOnly = false;
    // Clear any stale triathlon fields from a prior triathlon init. Otherwise
    // home/plan-preview pull 'Ironman' titles via s.eventType === 'triathlon'
    // even though the wizard just generated a running plan.
    s.eventType = 'running';
    s.triConfig = undefined;
    // Mirror: also clear stale hyroxConfig so post-race mode switches from
    // hyrox → running don't leave hyroxConfig.raceDate driving home banners
    // and plan previews. Same incident class as the triConfig clear above.
    s.hyroxConfig = undefined;
    // Clear stale tri/hyrox injury gates so prior-mode "canSwim='no'" answers
    // don't silently re-engage on a later mode switch back to that mode.
    if (s.injuryState?.active) {
      s.injuryState = clearStaleGatesForMode(s.injuryState, 'running');
    }
    s.w = 1;
    s.tw = calendarWeeks;
    s.v = curr;
    s.iv = curr;
    s.rpeAdj = 0;
    // Capture the outgoing plan's race distance before we overwrite it, so the
    // goal-clear below can distinguish a genuine re-onboarding to a NEW distance
    // (clear) from an in-place rebuild at the SAME distance (keep the goal).
    const prevPlanDist = s.rd;
    s.rd = targetDistStr;
    s.epw = Math.round(effectiveSessions);
    s.rw = runsPerWeek;
    s.gs = state.gymSessionsPerWeek || 0;
    // Same runs/week→km estimate the prediction blend used above
    // (`freqVolumeEstimate`), so the plan's starting volume and the race
    // prediction can never assume a different weekly km for the same athlete.
    const defaultWkm = freqVolumeEstimate;
    // Beginner/hybrid safety: the runs-per-week × ~10km fallback assumes an
    // experienced runner (~10km/run). For a true beginner (or fit-but-not-running
    // hybrid) with no detected history, cap the STARTING per-run to ~30min at easy
    // pace (C25K graduation standard) so week 1 isn't 10km repeats. The plan ramps
    // up from here. Detected-history users skip this (real volume wins, below).
    const begWkm = cappedBeginnerStartWeeklyKm(state.experienceLevel, runsPerWeek, pac.e, defaultWkm);
    if (begWkm != null) {
      console.log(`[init] Beginner/hybrid starting volume capped ${defaultWkm}→${begWkm} km/wk (~30min/run at easy pace). Plan ramps up.`);
    }
    s.wkm = begWkm ?? defaultWkm;
    s.pbs = pbs;
    s.rec = rec;
    s.lt = ltPace;
    s.ltPace = ltPace;
    s.vo2 = vo2max;
    s.vo2UpdatedAt = undefined; // wizard source. Preserve "no timestamp = fresh" policy
    s.typ = effectiveRunnerType;           // Effective type used by engine
    s.calculatedRunnerType = calculatedRunnerType; // Physics-derived type
    s.b = b;
    s.schemaVersion = STATE_SCHEMA_VERSION;
    s.pac = pac;
    // No measured LT from the wizard → derive one from the just-committed
    // PBs so s.lt / s.ltSource / s.ltConfidence are consistent from day 1.
    // Previously s.lt was left null while a stale ltSource ('blended') and
    // ltConfidence ('high') from a pre-finalize recompute survived — the
    // review row then showed a contaminated value with false provenance.
    // recomputeLT reads PBs via effectivePhysiologyPbs (s.pbs now set) and
    // applies the race-PB-pace cap, so the derived value cannot be slower
    // than a demonstrated long-race pace. When the wizard DID supply a
    // measured ltPace (device sync), keep it untouched. Pace zones re-derive
    // from the fresh LT so s.pac and s.lt agree.
    if (!ltPace) {
      recomputeLT(s);
      s.pac = gp(curr, s.lt ?? null);
    }
    // Seed blended-fitness cache with wizard-only blend. The launch refresh at
    // the end of this function (refreshBlendedFitness, "one forecast")
    // overwrites it on the committed plan.
    s.blendedRaceTimeSec = cappedBlendedTime;
    s.blendedEffectiveVdot = curr;
    s.blendedLastRefreshedISO = new Date().toISOString();
    s.blendedFromEstimate = weeklyKmIsEstimate;
    // Durability result stored for the Forecast durability chip (same field
    // the refresher writes), so the drill-down can explain the cap from day 1.
    s.runDurability = durability;
    archiveCurrentWksIfPopulated();
    // A race plan takes the running race split (marathon 2-week taper floor;
    // a sharpening block when the race is closer than a full build, phases.ts).
    // A block built without a real running fitness signal gets no peak week.
    const noRunningSignal = !hasRealRunningFitnessSignal(s);
    s.wks = state.trainingForEvent === false
      ? initializeWeeks(s.tw)
      : initializeWeeks(trainingWeeks, { raceDistance: targetDistStr, noSignal: noRunningSignal });
    if (raceLayout?.closingWeek) {
      // The race's own week after race week: it holds only the race.
      s.wks.push({
        w: s.wks.length + 1, ph: 'taper', raceClosing: true,
        rated: {}, skip: [], cross: [], wkGain: 0, workoutMods: [], adjustments: [], unspentLoad: 0, extraRunLoad: 0,
      });
    }
    // Sharpening block: freeze the inputs that depend on today's 30-day run
    // window (the first long run) so every later week replays the same block.
    // Any other plan clears a stale block.
    s.sharpenBlock = state.trainingForEvent !== false && isSharpeningBlock(targetDistStr, trainingWeeks)
      ? buildSharpenBlockState({ ...s, onboarding: state }, { raceDistance: targetDistStr, trainingWeeks, noSignal: noRunningSignal })
      : undefined;
    // Continuous mode: override phases to repeating 4-week blocks
    // Base → Build → Intensify → Deload (evidence-backed mesocycle)
    if (state.trainingForEvent === false) {
      // Map to existing phase types:
      // base = Base week (aerobic foundation)
      // build = Build week (progressive load)
      // peak = Intensify week (peak load/quality)
      // taper = Deload week (recovery + optional test)
      const blockPhases: Array<'base' | 'build' | 'peak' | 'taper'> = ['base', 'build', 'peak', 'taper'];
      for (let i = 0; i < s.wks.length; i++) {
        s.wks[i].ph = blockPhases[i % 4];
      }
    }

    // Phase assignment is fully handled by initializeWeeks → computePlanPhases.
    // The legacy racePhaseStart split (event plans >16 weeks got a 4-week block-cycle
    // prefix) is removed: it produced a confusing "Base → Build → Base → Build" pattern
    // in the timeline. Single coach-style arcs scale up to 32w; double periodization
    // with a mid-plan checkpoint TT week takes over at ≥33w. See src/workouts/phases.ts.
    s.racePhaseStart = undefined;
    s.skip = [];
    s.timp = 0;
    // Race goals are per-plan, but only the DISTANCE makes a goal stale. A goal
    // set against a previous plan's distance must not survive re-onboarding to a
    // different distance (real case, 2026-06-04: a sub-3 MARATHON goal carried
    // onto a fresh HALF plan and rendered as "TARGET TIME 3:00:00 · >95% chance"
    // on the plan-ready hero). But `initializeSimulator` also runs for in-place
    // rebuilds that keep the same race (runner-type change, add-sessions regen,
    // mode toggle back) — there, wiping the goal silently drops it from the
    // forecast page ("goal didn't persist"). So clear only when the distance
    // actually changed. The plan-preview goal overlay re-sets it if the user
    // picks a new target.
    if (prevPlanDist !== targetDistStr) {
      s.raceGoalTimeSec = undefined;
    }

    // Store recurring activities
    if (state.recurringActivities && state.recurringActivities.length > 0) {
      s.recurringActivities = [...state.recurringActivities];
    }

    // Commute config. Transfer from onboarding to state. wkm stays as the
    // user's chosen target weekly mileage; commute mileage is folded into
    // that target by the commute-aware plan engine (Phase 4), not added on
    // top. Adding it on top silently inflates volume and produces ACWR risk.
    if (state.runsToWork && state.commuteConfig) {
      s.commuteConfig = state.commuteConfig;
    } else {
      s.commuteConfig = undefined;
    }

    // Phase C3: if the user accepted Strava history OR explicitly provided/accepted
    // their weekly volume (manual entry, import), and we have a detected weekly km,
    // use it as the plan starting volume (overrides the runs-per-week lookup above).
    if (s.detectedWeeklyKm != null && (s.stravaHistoryAccepted || s.weeklyVolumeConfirmed)) {
      s.wkm = Math.round(s.detectedWeeklyKm);
    }

    // Store initial physiology
    s.initialLT = s.lt ?? ltPace; // s.lt covers both the measured and freshly-derived cases
    s.initialVO2 = vo2max;
    s.initialBaseline = cappedBlendedTime;
    s.currentFitness = cappedBlendedTime;

    // Store heart rate data for HR zone calculations
    if (state.restingHR) s.restingHR = state.restingHR;
    if (state.maxHR) s.maxHR = state.maxHR;

    // Store biological sex for iTRIMP β coefficient + bodyweight for FTP/kg
    if (state.biologicalSex) s.biologicalSex = state.biologicalSex;
    if (state.bodyWeightKg) s.bodyWeightKg = state.bodyWeightKg;
    if (state.heightCm) s.heightCm = state.heightCm;

    // Store selected marathon (must be set BEFORE refreshing course factors,
    // since the helper reads s.selectedMarathon.profile)
    if (state.selectedRace) {
      s.selectedMarathon = state.selectedRace;
    } else if (state.trainingForEvent !== false && state.customRaceDate) {
      // A custom date replaces an earlier event pick: every running race-date
      // reader takes the event first (runningRaceDateISO), so a stale one would
      // move race day.
      s.selectedMarathon = undefined;
    }

    // Anchor week date ranges to this Monday. A mid-week onboard yields a reduced
    // partial week 1 (pre-onboard days dropped, starts today — dropPreOnboardSessions);
    // a Sat/Sun onboard naturally gets a chill 1–2 session week 1 (lead-in), with the
    // first full week landing the following Monday. We never anchor to a future Monday:
    // weekIndexForDate can't file pre-start activities and reconcilePlanAnchorToEarliestActivity
    // would pull the anchor back the moment a lead-in run is logged.
    // Local calendar dates: the UTC Monday was the previous week's Monday in the
    // first hours of a Monday east of UTC, which moved race day by a week.
    s.planStartDate = planStartISO;
    s.planCreatedAt = localDateKey(new Date()); // days before today aren't "Missed"

    // Store onboarding reference
    s.onboarding = state;
    // Clear any stale Just-Track flag. This branch builds a real plan.
    s.trackOnly = false;

    // Continuous mode for non-event users (trainingForEvent is the authoritative flag)
    if (state.trainingForEvent === false) {
      s.continuousMode = true;
      s.blockNumber = 1;
      s.benchmarkResults = [];
    } else {
      s.continuousMode = false;
    }

    redistributeArchivedActivitiesToNewPlan();

    // ── One forecast (Tristan, 2026-10-11) ─────────────────────────────────
    // The plan preview and Home read the same computation. The launch refresh
    // (refreshBlendedFitness) runs here on the committed plan, after the
    // archived activities move into it, so the race-readiness time, the engine,
    // s.lt, the peak-volume forecast anchor, s.forecastTime and s.expectedFinal
    // the preview shows are the ones the first launch computes. The wizard-only
    // blend above (onboarding LT, no HR fit) sizes the plan's starting volume
    // and engine seed only. Before, the preview's forecast came from that
    // blend, so with an aged PB and a typed volume it differed from Home
    // (review 3: marathon 3:09:36 vs 3:16:25). The initial values the progress
    // views compare against are then taken from the refreshed state.
    // The refresh also brings s.pac in line with the s.lt and s.v it leaves
    // (syncTrainingPaces), as it does for the other initializers (cycling's
    // aside) and the launch.
    refreshBlendedFitness(s);
    s.iv = s.v;
    s.initialLT = s.lt ?? ltPace;
    if (s.blendedRaceTimeSec != null) {
      s.initialBaseline = s.blendedRaceTimeSec;
      s.currentFitness = s.blendedRaceTimeSec;
    }
    // Course factors read s.forecastTime (and s.selectedMarathon, set above).
    refreshForecastCourseFactors(s);
    saveState();

    return { success: true, runnerType: effectiveRunnerType, calculatedRunnerType };
  } catch (error) {
    console.error('Initialization error:', error);
    return { success: false, error: 'An unexpected error occurred' };
  }
}
