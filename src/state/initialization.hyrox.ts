/**
 * HYROX initialization path.
 *
 * Called from `initializeSimulator` when `state.trainingMode === 'hyrox'`.
 * Sets up `hyroxConfig`, derives ability band from previous finish time or
 * experience level, and scaffolds plan weeks. The HYROX plan engine (Phase 1)
 * fills weeks with actual workouts; Phase 0 ships skeleton weeks so the wizard
 * completes without crashing.
 */

import type { OnboardingState } from '@/types/onboarding';
import type { CalculationResult } from './initialization';
import { archiveCurrentWksIfPopulated, redistributeArchivedActivitiesToNewPlan } from './initialization';
import type { AbilityBand, HyroxConfig } from '@/types/triathlon';
import { STATE_SCHEMA_VERSION } from '@/types/state';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { localMondayKey, localDateKey } from '@/utils/local-date';
import { racePlanCalendarWeeks } from '@/workouts/race-week-layout';
import {
  HYROX_MTL_CAP,
  HYROX_DEFAULT_PLAN_WEEKS,
  HYROX_WEEKLY_SESSIONS,
  HYROX_HOURS_RANGE,
  applyHyroxSessionDelta,
  hyroxSessionTotal,
  hyroxTier,
  computeDoublesCap,
} from '@/constants/hyrox-constants';
import { generateHyroxPlan, hyroxChronicSeedSnapshot, refreshHyroxPlanWeakestStation, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { clearStaleGatesForMode } from '@/injury/engine';
import { getVenueIdForEvent, getHyroxEventById } from '@/data/hyrox-events';
import { computeHyroxStaleness, bandFromVdot } from '@/calculations/hyrox-staleness';
import { hasRealRunningFitnessSignal, resolveRunningVdot } from '@/calculations/physiological-vdot';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { seedRoxzoneSecForFormat, hyroxDoublesTables } from '@/calculations/hyrox-doubles';
import { hyroxPlanningBandFor } from '@/calculations/hyrox-planning-band';
import { appendStationTest } from '@/calculations/hyrox-station-history';
import { isHyroxProFormat } from '@/calculations/hyrox-division';
import { derivePopulationRunPace } from '@/calculations/hyrox-run-pace';
import {
  backComputeRunPaceFromRace,
  blendPersonalRunPaceOffset,
  estimateStationsAndRoxzoneFromBand,
  type HyroxRaceObservation,
} from '@/calculations/hyrox-personal-pace';
import type { SimulatorState } from '@/types/state';

// ─── Band derivation ─────────────────────────────────────────────────────────

const BAND_ORDER: AbilityBand[] = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'];

/** Highest band a first-timer is placed in: the top of the intermediate tier
 *  (hyroxTier; Tristan 2026-10-13, D7). */
const FIRST_TIMER_MAX_BAND: AbilityBand = 'intermediate';

/**
 * Band of a first-timer (no usable previous HYROX time). The parameter sheet's
 * level mapping (2026-10-12) puts a first race in the beginner tier
 * ('total_beginner', no previous race; findyouredge: first race, no specific
 * HYROX prep). Existing running-fitness evidence can place the athlete higher:
 * with a real running-fitness signal (hasRealRunningFitnessSignal, the
 * canonical gate) the band is the higher of 'total_beginner' and the VDOT band
 * (bandFromVdot, the thresholds the staleness re-band already uses).
 *
 * A first-timer is capped at the intermediate tier (the 'intermediate' band)
 * whatever their running fitness (Tristan 2026-10-13, D7): the advanced tier
 * doses two station sessions and race-pace stations from base, which needs
 * station history a first race does not have. Before, a 35:00 10K first-timer
 * (VDOT 60) went straight to 'competitive'.
 *
 * Before 2026-10-12 the band came from onboarding's experienceLevel, which the
 * HYROX flow never asks: every first-timer took the running default (or
 * 'novice'), whatever their fitness.
 */
function firstTimerBand(s: SimulatorState): AbilityBand {
  let realSignal = false;
  try { realSignal = hasRealRunningFitnessSignal(s); } catch { realSignal = false; }
  if (!realSignal) return 'total_beginner';
  const vdotBand = bandFromVdot(resolveRunningVdot(s));
  if (!vdotBand) return 'total_beginner';
  if (hyroxTier(vdotBand) === 'advanced') return FIRST_TIMER_MAX_BAND;
  return BAND_ORDER.indexOf(vdotBand) > 0 ? vdotBand : 'total_beginner';
}

// ─── Session count distribution ──────────────────────────────────────────────

/**
 * Distribute a user-chosen total session count across runs/stations/bricks for
 * the athlete's build week (HYROX_WEEKLY_SESSIONS, the tier's build row). The
 * plan engine applies the same choice to every phase (weekSessionCounts).
 * - Adding: easy runs up to 5. Never extra bricks or stations (parameter
 *   sheet sessions.weekly; before 2026-10-12 up to 3 bricks). Easy erg work
 *   comes next in the sheet; the plan engine adds it to a week's free slots,
 *   up to this total, so the stored counts never hold it.
 * - Reducing: bricks first, then stations (never below 1), then runs (never below 1).
 */
function distributeSessionCount(
  target: number,
  band: AbilityBand,
): { runs: number; stations: number; bricks: number } {
  const base = HYROX_WEEKLY_SESSIONS[band];
  return applyHyroxSessionDelta(base, target - hyroxSessionTotal(base));
}

// ─── Initializer ─────────────────────────────────────────────────────────────

export function initializeHyroxSimulator(state: OnboardingState): CalculationResult {
  try {
    const s = getMutableState();

    // Migrate legacy 3-value format to 4-value (open→open_singles, pro→pro_singles, doubles→open_doubles).
    const rawFormat = state.hyroxFormat as string | undefined;
    const format: 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles' =
      rawFormat === 'pro'     ? 'pro_singles'  :
      rawFormat === 'doubles' ? 'open_doubles' :
      rawFormat === 'open_singles' || rawFormat === 'pro_singles' ||
      rawFormat === 'open_doubles' || rawFormat === 'pro_doubles'
        ? (rawFormat as 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles')
        : 'open_singles';

    // Derive ability band from the previous time: the planning band
    // (hyroxPlanningBandFor), the finish in Open Singles terms banded on the
    // Open Singles field of the athlete's own sex, for every format. Setup,
    // log-a-race and the previous-format fix read the same helper.
    const prevTimeSec = state.previousHyroxTimeSec;
    const prevFmt = state.hyroxPreviousTimeFormat;
    // Format must be one of the four known values to be trusted. A missing or
    // unrecognised value means the user never confirmed the format, so we can't
    // safely apply a cross-format factor or seed benchmarks. Treating an unknown
    // prev format as the target format (the old fallback) silently mis-classified
    // doubles times as singles when the user changed target without re-confirming.
    const prevFormatKnown = prevFmt === 'open_singles' || prevFmt === 'pro_singles'
      || prevFmt === 'open_doubles' || prevFmt === 'pro_doubles';
    if (prevTimeSec != null && !prevFormatKnown) {
      console.warn('[hyrox init] previousHyroxTimeSec set but hyroxPreviousTimeFormat unknown — skipping band derivation and benchmark seeding');
    }
    const isTargetDoubles = format === 'open_doubles' || format === 'pro_doubles';
    const hasPrevTime = prevTimeSec != null && prevFormatKnown;
    // First-timers (no usable previous time) are banded after fitness is
    // resolved below (firstTimerBand); 'total_beginner' stands in until then.
    let timeBasedBand: AbilityBand = hasPrevTime
      ? hyroxPlanningBandFor(prevTimeSec, prevFmt, state.biologicalSex, state.hyroxDivision)
      : 'total_beginner';

    // Resolve fitness before the band (review round 5, 2026-10-12). The
    // staleness re-band and the personal run-pace offset below read s.v and
    // s.lt. No wizard step writes s.v, so for a fresh user they were the store
    // defaults (s.v 50, s.lt null), and the launch refresh then moved them
    // (10K 38:00: engine 55.2, re-banded competitive to intermediate "at VDOT
    // 50"). The band sets mtlCap, sessions and plan weeks, and the offset is
    // frozen once set (refreshHyroxPersonalRunPaceOffset skips a set offset),
    // so both stayed anchored on a placeholder. Commit the inputs the refresh
    // reads and run it here, the way initializeSimulator resolves the engine
    // before it builds a plan. Runs per week are provisional (the time band's
    // sessions; the band below rarely differs); the end-of-init refresh still
    // runs on the committed plan.
    s.eventType = 'hyrox';
    s.triConfig = undefined;
    s.trackOnly = false;
    s.continuousMode = false;
    s.w = 1;
    s.rd = 'marathon';  // Placeholder. HYROX views ignore this.
    s.pbs = state.pbs || {};
    s.rec = state.recentRace ?? null;
    if (state.biologicalSex) s.biologicalSex = state.biologicalSex;
    if (state.bodyWeightKg)  s.bodyWeightKg = state.bodyWeightKg;
    s.onboarding = state;
    const provisionalSessions = state.hyroxWeeklySessionCount != null
      ? distributeSessionCount(state.hyroxWeeklySessionCount, timeBasedBand)
      : HYROX_WEEKLY_SESSIONS[timeBasedBand];
    s.rw = provisionalSessions.runs;
    s.epw = provisionalSessions.runs + provisionalSessions.stations + provisionalSessions.bricks;
    refreshBlendedFitness(s);
    if (!hasPrevTime) timeBasedBand = firstTimerBand(s);

    // Staleness-aware band: when the previous race is old enough that we
    // partially distrust it AND the user's current VDOT implies a different
    // band, take the SLOWER of the two (conservative. Never over-promise on
    // a stale benchmark). The staleness model is gated by physiology
    // mitigation, so a still-fit athlete keeps their stale-but-credible band.
    const stalenessProbe = computeHyroxStaleness({
      ...(s as any),
      hyroxConfig: {
        ...(s.hyroxConfig as any),
        athleteBand: timeBasedBand,
        hyroxPreviousRaceDate:
          (state.hyroxPreviousTimeRaceId && getHyroxEventById(state.hyroxPreviousTimeRaceId)?.date)
          || state.hyroxPreviousRaceDate,
        hyroxPreviousTimeRaceId: state.hyroxPreviousTimeRaceId,
      },
    } as any);
    const vdotBand = bandFromVdot(s.v);
    let band: AbilityBand = timeBasedBand;
    if (stalenessProbe.bandWeight < 0.7 && vdotBand && vdotBand !== timeBasedBand) {
      band = BAND_ORDER.indexOf(timeBasedBand) < BAND_ORDER.indexOf(vdotBand) ? timeBasedBand : vdotBand;
      if (band !== timeBasedBand) {
        console.log(`[hyrox init] re-banded ${timeBasedBand} → ${band} due to staleness (months ago: ${stalenessProbe.ageMonths?.toFixed(1)}, VDOT: ${s.v?.toFixed(1)}, mitigation: ${stalenessProbe.physiologyMitigation.toFixed(2)})`);
      }
    }

    const baseMtlCap = HYROX_MTL_CAP[band];
    // Doubles: all 8 runs (full eccentric load) + half of each station (the
    // partner does the other half). Run portion of the cap stays full; station
    // portion halves. See computeDoublesCap docs.
    const mtlCap = isTargetDoubles ? computeDoublesCap(baseMtlCap) : baseMtlCap;
    const sessions = state.hyroxWeeklySessionCount != null
      ? distributeSessionCount(state.hyroxWeeklySessionCount, band)
      : HYROX_WEEKLY_SESSIONS[band];
    // Plan length: with a race date the plan runs through the calendar week
    // holding race day (racePlanCalendarWeeks), computed from today's local
    // Monday, the plan's anchor. Mirrors initializeSimulator and the triathlon
    // path. Without a race date the wizard's week count stands.
    const weeks = racePlanCalendarWeeks(state.customRaceDate)
      ?? (state.planDurationWeeks || HYROX_DEFAULT_PLAN_WEEKS[band]);

    // Seed station benchmarks from historic race splits (entered during onboarding).
    // Store in the slot matching the PREVIOUS-RACE format. We only seed when the
    // user explicitly confirmed which format their splits came from. Without
    // that signal we'd risk filing doubles times into the singles slot (or vice
    // versa). The user can still calibrate per station from the benchmark card.
    const stationBenchmarks: Partial<Record<string, number>> = {};
    if (state.hyroxPreviousStationSplits && prevFormatKnown) {
      Object.assign(stationBenchmarks, state.hyroxPreviousStationSplits);
    }
    const hasBenchmarks = Object.keys(stationBenchmarks).length > 0;
    const slotIsSingles = prevFmt === 'open_singles' || prevFmt === 'pro_singles';
    const benchmarkSingles = hasBenchmarks &&  slotIsSingles ? stationBenchmarks as any : undefined;
    const benchmarkDoubles = hasBenchmarks && !slotIsSingles ? stationBenchmarks as any : undefined;

    // Persist prev format only when it's a known value. Storing `undefined` is
    // preferable to defaulting to the target format. The forecast view nudge
    // will detect missing-but-time-set state and ask the user to confirm.
    const prevTimeFormat = prevFormatKnown ? prevFmt : undefined;

    const prevRaceDateISO =
      (state.hyroxPreviousTimeRaceId && getHyroxEventById(state.hyroxPreviousTimeRaceId)?.date)
      || state.hyroxPreviousRaceDate;

    // One history entry per seeded split, source 'race', with the race's format
    // and weights. The entry is the split's provenance: a doubles race split is
    // the pair's time (doublesBenchmarkIsTeamTime), and a Pro race split is a
    // Pro-weight time, so the predictor does not apply the Pro multiplier on top
    // (audit 2026-10-12: Pro sled push 260 s became 299 s). Per entry, not the
    // config-wide benchmarksAtProWeights flag, which describes station tests.
    let stationBenchmarkHistory: HyroxConfig['stationBenchmarkHistory'];
    if (hasBenchmarks && prevFormatKnown) {
      stationBenchmarkHistory = {};
      const raceDateISO = prevRaceDateISO ?? localDateKey(new Date());
      for (const st of HYROX_STATION_ORDER) {
        const sec = (stationBenchmarks as Record<string, number | undefined>)[st];
        if (sec == null) continue;
        stationBenchmarkHistory[st] = appendStationTest(undefined, {
          dateISO: raceDateISO,
          sec,
          source: 'race',
          format: prevFmt,
          proWeights: isHyroxProFormat(prevFmt),
        });
      }
    }

    // ── Personal run-pace offset from historic race ──────────────────────
    // Compute an initial Bayesian residual: observed run pace from the
    // pasted/derived historic race vs the population model's prediction at
    // that race's format. Stored in sec/km of pace, decays linearly to 0
    // over 12 months without fresh evidence. See SCIENCE_LOG §X.
    let personalRunPaceOffsetSec: number | undefined;
    let personalRunPaceOffsetUpdatedAtISO: string | undefined;
    let personalRunPaceOffsetConfidence: number | undefined;
    if (prevTimeSec != null && prevFormatKnown && typeof s.v === 'number' && s.v >= 25 && s.v <= 85) {
      const prevFormat = prevFmt as 'open_singles' | 'pro_singles' | 'open_doubles' | 'pro_doubles';
      const splits = state.hyroxPreviousStationSplits;
      const splitCount = splits ? Object.keys(splits).length : 0;
      const hasSplits = splitCount >= 6;  // need most stations for honest reconstruction
      let stationsTotalSec: number;
      let roxzoneSec: number;
      let stationsFromSplits = false;
      if (hasSplits) {
        stationsTotalSec = HYROX_STATION_ORDER.reduce(
          (sum, st) => sum + ((splits as Record<string, number>)[st] ?? 0),
          0,
        );
        // Splits give the stations; Roxzone is the band seed in the race's
        // format (doubles: × the percentile-matched Roxzone ratio).
        roxzoneSec = seedRoxzoneSecForFormat(band, prevFormat, hyroxDoublesTables(prevFormat, state.biologicalSex, state.hyroxDivision));
        stationsFromSplits = true;
      } else {
        const est = estimateStationsAndRoxzoneFromBand(band, prevFormat, hyroxDoublesTables(prevFormat, state.biologicalSex, state.hyroxDivision));
        stationsTotalSec = est.stationsTotalSec;
        roxzoneSec = est.roxzoneSec;
      }
      const observation: HyroxRaceObservation = {
        finishSec: prevTimeSec,
        stationsTotalSec,
        roxzoneSec,
        format: prevFormat,
        dateISO: prevRaceDateISO ?? new Date().toISOString().slice(0, 10),
        stationsFromSplits,
      };
      const observedPaceSecKm = backComputeRunPaceFromRace(observation);
      if (observedPaceSecKm != null) {
        const prevTargetFormat: 'singles' | 'doubles' =
          (prevFormat === 'open_doubles' || prevFormat === 'pro_doubles') ? 'doubles' : 'singles';
        const fakeState: SimulatorState = {
          ...s,
          hyroxConfig: {
            ...(s.hyroxConfig ?? ({} as HyroxConfig)),
            format: prevFormat,
            athleteBand: band,
          },
        };
        const modelAtPrev = derivePopulationRunPace(fakeState, prevTargetFormat);
        if (modelAtPrev) {
          const blended = blendPersonalRunPaceOffset({
            observedPaceSecKm,
            modelPaceSecKm: modelAtPrev.paceSecKm,
            stationsFromSplits,
          });
          if (blended.offsetSec !== 0) {
            personalRunPaceOffsetSec = blended.offsetSec;
            personalRunPaceOffsetUpdatedAtISO = observation.dateISO;
            personalRunPaceOffsetConfidence = blended.confidence;
            console.log(
              `[hyrox init] personalised run-pace offset = ${blended.offsetSec >= 0 ? '+' : ''}${blended.offsetSec} s/km` +
              ` (observed ${observedPaceSecKm}, model ${modelAtPrev.paceSecKm}, splits=${stationsFromSplits}, conf=${blended.confidence.toFixed(2)})`,
            );
          }
        }
      }
    }

    // Carry the user's target finish time across an in-place rebuild at the
    // SAME race format. Only a format change makes the goal stale. Mirrors
    // running's gated raceGoalTimeSec clear in initialization.ts.
    const carriedTargetFinishSec = s.hyroxConfig?.format === format
      ? s.hyroxConfig?.targetFinishTimeSec
      : undefined;

    const hyroxConfig: HyroxConfig = {
      format,
      // Division (load tier with format + biological sex; hyrox-division.ts).
      // Unset when the setup screen did not ask or the athlete kept the
      // sex-derived default, which resolves the same way.
      division: state.hyroxDivision,
      targetFinishTimeSec: carriedTargetFinishSec,
      athleteBand: band,
      hyroxPhase: 'base',
      stationAccess: {
        sled:   state.hyroxSledAccess ?? 'always',
        skiErg: state.hyroxHasSkiErg ?? true,
        rowErg: state.hyroxHasRowErg ?? true,
      },
      previousHyroxTimeSec: prevTimeSec,
      hyroxPreviousTimeFormat: prevTimeFormat,
      hyroxPreviousTimeRaceId: state.hyroxPreviousTimeRaceId,
      // Race date: prefer the picked event's date, then a manually-entered date.
      // Used by the staleness model. Without it, we can't decay trust on
      // a year-old benchmark vs current physiology.
      hyroxPreviousRaceDate:
        (state.hyroxPreviousTimeRaceId && getHyroxEventById(state.hyroxPreviousTimeRaceId)?.date)
        || state.hyroxPreviousRaceDate,
      weeklyMTL: 0,
      mtlCap,
      mtlHistory: [],
      runsPerWeek: sessions.runs,
      stationSessionsPerWeek: sessions.stations,
      bricksPerWeek: sessions.bricks,
      raceDate: state.customRaceDate ?? undefined,
      hyroxRunPaceSecKm: state.hyroxRunPaceSecKm,
      personalRunPaceOffsetSec,
      personalRunPaceOffsetUpdatedAtISO,
      personalRunPaceOffsetConfidence,
      weeklyHoursAvailable: state.triTimeAvailableHoursPerWeek ?? HYROX_HOURS_RANGE[band].default,
      stationBenchmarksSingles: benchmarkSingles,
      stationBenchmarksDoubles: benchmarkDoubles,
      stationBenchmarkHistory,
      raceEventId: state.hyroxRaceEventId,
      venueId: state.hyroxVenueId ?? (state.hyroxRaceEventId ? getVenueIdForEvent(state.hyroxRaceEventId) : undefined),
      generatorVersion: HYROX_GENERATOR_VERSION,
      // The guard's chronic seed (plan engine D4), fixed for this plan's
      // life: the logged weekly load as it stands now, before the plan.
      planChronicSeed: hyroxChronicSeedSnapshot(s.signalBBaseline),
    };

    s.hyroxConfig = hyroxConfig;
    // Clear stale tri injury gates so canSwim/canBike from a prior tri mode
    // don't linger as silent no-ops on the new HYROX plan.
    if (s.injuryState?.active) {
      s.injuryState = clearStaleGatesForMode(s.injuryState, 'hyrox');
    }
    s.tw = weeks;

    // Anchor to this Monday; a mid-week onboard yields a reduced partial week 1
    // (dropPreOnboardSessions), a Sat/Sun onboard a chill 1–2 session lead-in week.
    // Local calendar dates (approved default Q10: every mode): the UTC Monday is the
    // previous week's Monday in the first hours of a Monday east of UTC.
    s.planStartDate = localMondayKey(new Date());
    s.planCreatedAt = localDateKey(new Date()); // days before today aren't "Missed"

    (s as any).lastCompleteDebriefWeek = 0;
    (s as any)._debriefGateV3 = true;

    s.rw = sessions.runs;
    s.epw = sessions.runs + sessions.stations + sessions.bricks;
    s.gs = 0;
    s.wkm = 0;
    s.schemaVersion = STATE_SCHEMA_VERSION;
    s.selectedMarathon = undefined;

    archiveCurrentWksIfPopulated();

    // Generate the full plan via plan engine.
    s.wks = generateHyroxPlan(s);
    // The race-pace sessions' weakest station (lane H2b) read from the
    // forecast of the plan just built (the forecast counts the plan's
    // sessions), stored so later rebuilds read the same station; the plan is
    // built again when that station differs from the first build's.
    if (refreshHyroxPlanWeakestStation(s)) s.wks = generateHyroxPlan(s);

    s.initialBaseline = null;
    s.currentFitness = null;
    s.forecastTime = null;

    redistributeArchivedActivitiesToNewPlan();
    // One forecast (Tristan, 2026-10-11; mirror of initializeSimulator): run
    // the launch refresh on the committed plan, after the archived activities
    // move into it, so the VDOT-derived run pace the onboarding preview reads
    // is the one the first launch shows.
    refreshBlendedFitness(s);
    saveState();

    const seededStations = Object.keys(stationBenchmarks).length;
    console.log(`[hyrox init] band: ${band}, mtlCap: ${mtlCap}, weeks: ${weeks}, format: ${format}, seeded benchmarks: ${seededStations}`);
    return { success: true };
  } catch (err) {
    console.error('[hyrox init] failed', err);
    return { success: false, error: 'HYROX initialization failed' };
  }
}

