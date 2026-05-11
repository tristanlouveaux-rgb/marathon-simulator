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
import { saveState, getMondayOf } from '@/state/persistence';
import {
  HYROX_TIME_TO_BAND_THRESHOLDS,
  HYROX_MTL_CAP,
  HYROX_DEFAULT_PLAN_WEEKS,
  HYROX_WEEKLY_SESSIONS,
  HYROX_HOURS_RANGE,
  SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES,
  SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES,
  computeDoublesCap,
} from '@/constants/hyrox-constants';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { getVenueIdForEvent, getHyroxEventById } from '@/data/hyrox-events';
import { computeHyroxStaleness, bandFromVdot } from '@/calculations/hyrox-staleness';

// ─── Band derivation ─────────────────────────────────────────────────────────

/** Derive ability band from a previous HYROX finish time (seconds). */
function bandFromTime(sec: number): AbilityBand {
  for (const { maxSec, band } of HYROX_TIME_TO_BAND_THRESHOLDS) {
    if (sec < maxSec) return band;
  }
  return 'beginner';
}

/** Derive ability band from onboarding experience level when no finish time is given. */
function bandFromExperience(exp: string | undefined): AbilityBand {
  switch (exp) {
    case 'total_beginner': return 'total_beginner';
    case 'beginner':       return 'beginner';
    case 'novice':         return 'novice';
    case 'intermediate':   return 'intermediate';
    case 'advanced':       return 'advanced';
    case 'competitive':    return 'competitive';
    default:               return 'novice';
  }
}

// ─── Session count distribution ──────────────────────────────────────────────

/**
 * Distribute a user-chosen total session count across runs/stations/bricks.
 * Adjusts the band defaults by adding/removing sessions in priority order:
 * - Reducing: remove bricks first, then stations (never below 1), then runs (never below 2).
 * - Adding:   add runs first (up to 5), then bricks (up to 3), then stations.
 */
function distributeSessionCount(
  target: number,
  band: AbilityBand,
): { runs: number; stations: number; bricks: number } {
  const base = HYROX_WEEKLY_SESSIONS[band];
  let { runs, stations, bricks } = base;
  let delta = target - (runs + stations + bricks);

  while (delta > 0) {
    if (runs < 5) { runs++; }
    else if (bricks < 3) { bricks++; }
    else { stations++; }
    delta--;
  }
  while (delta < 0) {
    if (bricks > 0) { bricks--; }
    else if (stations > 1) { stations--; }
    else if (runs > 1) { runs--; }
    else { break; }
    delta++;
  }

  return { runs, stations, bricks };
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

    // Derive ability band — when previous-race format differs from the target
    // format, expand or compress the previous total time using a same-athlete
    // cross-format factor before banding. A 60-min doubles is ~73-min singles
    // (× 1.22); a 60-min singles is ~51-min doubles (× 0.85). See
    // SCIENCE_LOG §T for the empirical lower bound (1.125 cohort) and the
    // coaching-consensus midpoint (1.22) we anchor on. Same-format previous
    // and target → no factor applied.
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
    const isPrevDoubles = prevFmt === 'open_doubles' || prevFmt === 'pro_doubles';
    const isTargetDoubles = format === 'open_doubles' || format === 'pro_doubles';
    const adjustedPrevTimeSec = (prevTimeSec != null && prevFormatKnown)
      ? Math.round(
           isPrevDoubles && !isTargetDoubles ? prevTimeSec * SAME_ATHLETE_TOTAL_DOUBLES_TO_SINGLES :
          !isPrevDoubles &&  isTargetDoubles ? prevTimeSec * SAME_ATHLETE_TOTAL_SINGLES_TO_DOUBLES :
          prevTimeSec
        )
      : null;
    const timeBasedBand: AbilityBand = adjustedPrevTimeSec != null
      ? bandFromTime(adjustedPrevTimeSec)
      : bandFromExperience(state.experienceLevel as string | undefined);

    // Staleness-aware band: when the previous race is old enough that we
    // partially distrust it AND the user's current VDOT implies a different
    // band, take the SLOWER of the two (conservative — never over-promise on
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
    const bandOrder: AbilityBand[] = ['total_beginner','beginner','novice','intermediate','advanced','competitive'];
    let band: AbilityBand = timeBasedBand;
    if (stalenessProbe.bandWeight < 0.7 && vdotBand && vdotBand !== timeBasedBand) {
      band = bandOrder.indexOf(timeBasedBand) < bandOrder.indexOf(vdotBand) ? timeBasedBand : vdotBand;
      if (band !== timeBasedBand) {
        console.log(`[hyrox init] re-banded ${timeBasedBand} → ${band} due to staleness (months ago: ${stalenessProbe.ageMonths?.toFixed(1)}, VDOT: ${s.v?.toFixed(1)}, mitigation: ${stalenessProbe.physiologyMitigation.toFixed(2)})`);
      }
    }

    const baseMtlCap = HYROX_MTL_CAP[band];
    // Doubles: all 8 runs (full eccentric load) + 4 stations (half). Run portion
    // of the cap stays full; station portion halves. See computeDoublesCap docs.
    const mtlCap = isTargetDoubles ? computeDoublesCap(baseMtlCap) : baseMtlCap;
    const sessions = state.hyroxWeeklySessionCount != null
      ? distributeSessionCount(state.hyroxWeeklySessionCount, band)
      : HYROX_WEEKLY_SESSIONS[band];
    const weeks = state.planDurationWeeks || HYROX_DEFAULT_PLAN_WEEKS[band];

    // Seed station benchmarks from historic race splits (entered during onboarding).
    // Store in the slot matching the PREVIOUS-RACE format. We only seed when the
    // user explicitly confirmed which format their splits came from — without
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
    // preferable to defaulting to the target format — the forecast view nudge
    // will detect missing-but-time-set state and ask the user to confirm.
    const prevTimeFormat = prevFormatKnown ? prevFmt : undefined;

    const hyroxConfig: HyroxConfig = {
      format,
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
      // Used by the staleness model — without it, we can't decay trust on
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
      weeklyHoursAvailable: state.triTimeAvailableHoursPerWeek ?? HYROX_HOURS_RANGE[band].default,
      stationBenchmarksSingles: benchmarkSingles,
      stationBenchmarksDoubles: benchmarkDoubles,
      raceEventId: state.hyroxRaceEventId,
      venueId: state.hyroxVenueId ?? (state.hyroxRaceEventId ? getVenueIdForEvent(state.hyroxRaceEventId) : undefined),
      generatorVersion: HYROX_GENERATOR_VERSION,
    };

    s.eventType = 'hyrox';
    s.hyroxConfig = hyroxConfig;
    s.triConfig = undefined;
    s.trackOnly = false;
    s.continuousMode = false;
    s.w = 1;
    s.tw = weeks;

    const planMonday = getMondayOf(new Date());
    s.planStartDate = planMonday.toISOString().slice(0, 10);

    (s as any).lastCompleteDebriefWeek = 0;
    (s as any)._debriefGateV3 = true;

    s.rd = 'marathon';  // Placeholder — HYROX views ignore this.
    s.rw = sessions.runs;
    s.epw = sessions.runs + sessions.stations + sessions.bricks;
    s.gs = 0;
    s.wkm = 0;
    s.pbs = state.pbs || {};
    s.rec = state.recentRace ?? null;
    s.schemaVersion = STATE_SCHEMA_VERSION;

    if (state.biologicalSex) s.biologicalSex = state.biologicalSex;
    if (state.bodyWeightKg)  s.bodyWeightKg = state.bodyWeightKg;
    s.onboarding = state;
    s.selectedMarathon = undefined;

    archiveCurrentWksIfPopulated();

    // Generate the full plan via plan engine.
    s.wks = generateHyroxPlan(s);

    s.initialBaseline = null;
    s.currentFitness = null;
    s.forecastTime = null;

    redistributeArchivedActivitiesToNewPlan();
    saveState();

    const seededStations = Object.keys(stationBenchmarks).length;
    console.log(`[hyrox init] band: ${band}, mtlCap: ${mtlCap}, weeks: ${weeks}, format: ${format}, seeded benchmarks: ${seededStations}`);
    return { success: true };
  } catch (err) {
    console.error('[hyrox init] failed', err);
    return { success: false, error: 'HYROX initialization failed' };
  }
}

