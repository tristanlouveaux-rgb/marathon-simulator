/**
 * HYROX plan engine.
 *
 * Generates a full HYROX training plan as Week[] compatible with the rest
 * of the app (triWorkouts field, same Week schema as triathlon mode).
 *
 * Generation flow (planning side; parameter sheet 2026-10-12 and Tristan's
 * decisions since). Weeks are built in order, because each week's ceilings
 * read the weeks before it, by one constraint hierarchy (round 6, documented
 * at buildHyroxTrainingWeeks: hard safety, then the week's size, then the
 * allocation order inside it, then the MTL cap, monotonicity reported):
 *   1. Phase each week (base → build → peak → taper) from computeHyroxPlanPhases
 *      (2-week race taper, HYROX_TAPER_WEEKS_MIN).
 *   2. Week size: the chosen weekly hours, the phase budget (weekly hours ×
 *      the nominal phase multiplier × deload 0.75 every 4th week, never the
 *      week right before the race taper, isHyroxDeloadWeek, × the effort /
 *      MTL-gap lever), the deload ceiling and the acute:chronic guard (a
 *      training week's planned load at most ACWR_SAFE_HIGH × the mean of the
 *      previous 4 planned weeks, never under the nominal week 1; weeks
 *      before week 1 count as the larger of the logged weekly load, fixed
 *      when the plan is created, and the nominal week 1: round 7).
 *      A week the guard or the deload ceiling cannot hold at the chosen hours
 *      is built at the largest size they hold, the same week at every chosen
 *      hours above it.
 *      Taper weeks: hyroxTaperFraction (0.55 then 0.30) of the reference week's
 *      planned minutes, with the reference week's station and brick sessions,
 *      minutes and MTL as ceilings (never under the taper's smallest
 *      circuit, which the fractions exempt: round 7).
 *   3. Sessions from the tier's weekly structure (HYROX_WEEKLY_STRUCTURE) and
 *      the athlete's session-count choice; no brick in base, before week 5 or
 *      in race week; race week holds no more runs than the reference week.
 *      Inside them (lane H2b, hyrox-station-dose.ts): technique and race-pace
 *      station sessions at the sheet's doses in quarter-station sets, the
 *      race-pace dose following the week's size toward peak, the beginner
 *      load schedule stepped from logged RPE, the forecast's weakest station
 *      in the race-pace session, and the tier bricks. A session's week share
 *      caps it; it never fills it.
 *   4. Runs: the long run (tier start, step and cap, the 110% single-run rule)
 *      and the tier quality run first; easy runs after them, up to
 *      HYROX_RUN_SHARE of the chosen weekly hours in a training week, of the
 *      week's own budget in a taper week (standalone runs plus brick runs),
 *      none longer than the long run. Station sessions and bricks share the
 *      rest of the week's budget.
 *   5. Weekly MTL cap: easy runs shorten and leave first, then station and
 *      brick rounds and stations go (real volume); the long run, the quality
 *      run and the week's last station work stay.
 *   6. Schedule with the hard-day and 48 h eccentric rules, Sunday to Monday
 *      included (scheduler.hyrox). A week the rules cannot hold loses a hard
 *      session to its easy sibling, then its lowest-priority session. Race
 *      week takes the race-day rules' days (raceWeekDays); its circuit takes
 *      the primer's day when that is its only one (a Thursday race). The week
 *      before race week re-places station work its race window drops on a
 *      free day 7 or more days out (placeWorkOutsideRaceWindow).
 *   7. Easy erg work (discipline 'erg'): what the sessions leave of the
 *      week's size becomes easy SkiErg or row work, up to the athlete's
 *      chosen session total, in the MTL the week leaves under the cap, each
 *      session up to the tier long-run cap. An easy run's slot (or its MTL)
 *      goes to it when the week then holds more minutes (round 7) and its
 *      running stays at or above HYROX_RUN_SHARE of the chosen weekly
 *      minutes, never in a deload (2026-10-14).
 *      Neither hard nor eccentric. It never fills what the injury gates took,
 *      nor the slot of the week's last station session or brick, nor a
 *      missing quality run's slot, and no slot moves with an active injury.
 *   8. A week over its size gives way in the allocation order run backwards
 *      (easy erg work, the scale, easy runs, stations out of circuits, the
 *      technique session, the secondary brick, the brick, the long run's
 *      growth for the quality run, the quality run); the long run shortens to
 *      the run floor and leaves before the week's last station session or
 *      brick, which leaves only when the week is still over without it.
 *   9. A loaded week the chosen session count holds under the chosen hours
 *      (its phase budget at the hours, no ceiling sizing it, one more session
 *      holding 20 min or more of it, in the week and in the real plan built
 *      with one more session) is marked for the plan view's hours line
 *      (HyroxHoursFit).
 *  10. Wrap into Week[].
 */

import { dropSessionsOnOrAfterRaceDay, clearStoredPlanRaceWindow, raceWeekPrimerDow, PRIMER_MIN_DAYS_OUT, RACE_DAY_CLEAR_DAYS } from './race-day-rules';
import { storedPlanRaceLayout, type RaceWeekLayout } from './race-week-layout';
import { firstTrackedDow } from '@/ui/workout-status';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import type { HyroxConfig, HyroxLoadTier, HyroxStation } from '@/types/triathlon';
import type { InjuryState } from '@/types/injury';
import {
  HYROX_WEEKLY_SESSIONS,
  HYROX_WEEKLY_STRUCTURE,
  HYROX_SESSION_MAX_MIN,
  HYROX_BUILD_MULT,
  HYROX_PEAK_MULT,
  HYROX_DELOAD_FACTOR,
  HYROX_ADAPTIVE_FLOOR,
  HYROX_TRANSITION_TAPER_MULT,
  HYROX_CHRONIC_WINDOW_WEEKS,
  HYROX_RUN_SHARE,
  HYROX_RUN_FLOOR_MIN,
  HYROX_LONG_RUN,
  HYROX_QUALITY_FORMATS,
  HYROX_FIRST_BRICK_WEEK,
  HYROX_TAPER_WEEKS_MIN,
  HYROX_MAX_HARD_SESSIONS,
  HYROX_MAX_HARD_RUNS,
  HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK,
  HYROX_DAY_BEFORE_RACE_MAX_RUN_MIN,
  HYROX_RACE_WEEK_PRIMER_MIN,
  HYROX_EASY_RPE,
  HYROX_HOURS_RANGE,
  HYROX_STRENGTH_BLOCK_MIN,
  HYROX_FINISHER_MIN_MIN,
  applyHyroxSessionDelta,
  hyroxSessionTotal,
  hyroxTier,
  hyroxBaseMultiplier,
  hyroxTaperFraction,
  computeHyroxPlanPhases,
  type HyroxSessionCounts,
  type HyroxTier,
} from '@/constants/hyrox-constants';
import { ACWR_SAFE_HIGH } from '@/constants/triathlon-constants';
import { plannedTssPerMin } from '@/constants';
import {
  generateHyroxRun, generateHyroxStation, generateHyroxBrick, generateHyroxAssessment, hyroxEasyRunPaceSecKm, raceWeekCircuitStations, MIN_CIRCUIT_STATIONS, MIN_CIRCUIT_ROUNDS, hyroxRunLengthKm,
  withHyroxRounds, withoutHyroxStation, generateHyroxEasyErg, hyroxEasyErgMtlPerMin, isHyroxEasyErg, HYROX_EASY_ERG_TYPE,
  hyroxStationToCut, hyroxMinRounds, withHyroxStationLoads,
  hyroxSessionWarmup, withHyroxSessionParts, withHyroxFinisher, hyroxSessionWorkMin, generateHyroxSim, isHyroxSim,
} from './hyrox-generators';
import { hyroxStrengthContent, runningStrengthPhaseMinutes } from './gym';
import type { HyroxStrengthBlock } from '@/types/triathlon';
import {
  findHyroxWeekSchedule, scheduleHyroxWeek, isHighIntensity as isHyroxHardSession, isHardRun, isEccentricSession,
  isHyroxLongRun, hyroxSundayFlags, HYROX_DAY_NAMES, HYROX_TEMPO_HOME_DOW, hyroxPreferredDays, isHyroxStrengthSession,
  type HyroxPrevSunday,
} from './scheduler.hyrox';
import { hyroxLoadTierForState, isHyroxDoublesFormat } from '@/calculations/hyrox-division';
import { hyroxPlanningStationBenchmarks, predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { topWeakestLinks } from '@/calculations/hyrox-weakest-link';
import { injuryStrengthDecision } from './injury-strength';
import { getDisciplineCapacity } from '@/injury/engine';
import { hyroxEffortMultiplier } from '@/calculations/effort-multiplier.hyrox';
import { hasRealRunningFitnessSignal } from '@/calculations/physiological-vdot';
import {
  ctlGapMultiplier, isHyroxDeloadWeek, isRaceWeek,
  LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, LONG_RUN_LOOKBACK_WEEKS, TAPER_LONG_RUN_FRACTION, LONG_SOFT_FLOOR_MIN,
} from './plan_engine';
import { loggedRuns, longestRunMinBetween, RECENT_LONGEST_WINDOW_DAYS } from './sharpening-block';
import { stampTriWorkoutIds } from './plan_engine.triathlon';
import { STATION_DISPLAY, HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import { fmtAmount, hyroxSessionPlannedTss } from './hyrox-session-shape';
import { athleteRatedRpe } from '@/calculations/athlete-rating';
import {
  hyroxRacePaceSets, hyroxTechniqueSets, hyroxBeginnerStationLoadKg, hyroxBeginnerRaceWeightWeek, HYROX_LOADED_STATIONS,
  hyroxBeginnerLoadFraction, hyroxLoadKgAt, type HyroxStationLoadMemory,
} from './hyrox-station-dose';

/**
 * Bump when plan output changes in a way that should invalidate cached plans.
 * main.ts checks this on launch and regenerates if stored version is lower.
 * v14: per-slot session ids and commute run durations; the regen re-keys
 * name-keyed slot entries to the new ids (state/hyrox-plan-regen.ts).
 */
// v14: 1- and 2-week plans allocate the taper first (phases.ts computeSingleArc):
// a 1-week plan is [taper] (was [build]) and a 2-week plan [peak, taper] (was
// [build, peak]). Also in v14 (unreleased when added): nothing is generated on
// or after race day (race-day-rules dropSessionsOnOrAfterRaceDay).
// v15: race week sits where running puts it (storedPlanRaceLayout): the week
// holding the day 3 days before race day. A Monday to Wednesday race's own week
// is a closing week with no sessions (raceClosing), and the plan is phased and
// sized over the weeks before it, so the last days before a Wednesday race are
// race week, not peak week. For a Thursday to Saturday race the week before race
// week keeps nothing in the last 6 days before race day; its brick moves to 7 or
// more days out (clearStoredPlanRaceWindow).
// v16: merge of two independent bumps. fix/load-accounting's v14 (per-slot
// session ids and commute run durations, re-keyed by state/hyrox-plan-regen.ts)
// and fix/lane-s's v14/v15 above (taper-first short plans, nothing on or after
// race day, race-week calendar layout). Both changes are in this generator, so
// the version sits above both.
// v17: race week is a taper placed relative to race day (the running race-day
// rules, SCIENCE_LOG §CE and §CW): no brick or mini brick (the race is the
// week's brick), the tempo primer 3 to 5 days out, technique circuits without
// the eccentric-heavy or sled stations at least 3 days out, easy runs only in
// the last 2 days, and no assessment. Before, a Saturday race week held two
// 47-min full circuits 3 and 2 days out and a Mini Brick the day before.
// Still v17 (unreleased): the tempo primer takes running's primer day
// (raceWeekPrimerDow), easy runs the latest free days, and without ergs the
// circuit slots are left out instead of becoming easy runs.
// v18 (lane H2a, 2026-10-12): weekly structure by tier and phase, long run,
// tier quality-run formats, 40% running share, deload 0.75, 2-week taper at
// 0.70 / 0.55 of the reference week, the acute:chronic guard on planned load,
// hard-day and 48 h eccentric spacing as hard scheduler rules (Sunday to
// Monday included), and an MTL cap that cuts rounds.
// Still v18 (unreleased; review of 2026-10-12): a deload is a ceiling on the
// last loaded week (0.75 of its minutes and TSS, no longer or fuller session,
// no extra hard session or quality run); race week keeps the peak structure
// minus the brick and always holds the primer (fixed 10 min of tempo work),
// its circuit no more rounds than the week before's; the MTL cap and the
// ceilings take stations out of circuits before dropping a session; a long run
// trimmed for a quality run that then leaves the week keeps its length; the
// first regenerated week reads the stored week before for the Sunday-to-Monday
// rule; every change the rules force is noted on the week (hyroxPlanNotes).
// Still v18 (unreleased; review round 2, 2026-10-13): a ceiling never takes a
// training week's last station session or brick before the long run is at
// its floor (the MTL cap and the spacing drops neither); the race taper holds
// 0.70 / 0.55 of the reference week, with the reference week's per-session
// caps (length, rounds, stations) and its station and brick minutes and MTL
// as ceilings, shedding sessions when the floors leave it over; week 1 never
// stretches the long run past the start, and taper weeks never stretch it
// (the taper tempo is sized to the long run instead); intermediate peak reps
// are labelled HYROX race pace; no training week sits above the chosen
// weekly hours.
// Still v18 (unreleased; round 4, Tristan's decisions D1 to D8 of 2026-10-13):
// what the sessions leave of a week's budget becomes easy erg work (new
// hyrox_erg_easy session), up to the athlete's chosen session total and never
// past it; the running share is 0.40 of the chosen weekly hours; the quality
// run ranks ahead of the long run's growth; the guard's chronic window before
// week 1 is the logged weekly load, else the nominal week 1; no deload in the
// week right before the race taper; race week holds no more runs than the
// reference week and keeps its circuit over easy runs; first-timers are capped
// at the intermediate tier; with no logged run, weeks 2 to 4 count the
// long-run start as recent exposure for the 110% rule.
// Still v18 (unreleased; round 4 review fixes, 2026-10-13): the chronic seed
// is stored when the plan is created (hyroxConfig.planChronicSeed) and every
// regeneration reads it, never the live baseline; weeks 2 to 4 count a logged
// run as exposure too, and the start only when week 1 ran it; race-week easy
// runs are no longer than the week before's long run; no training-week long
// run or taper easy run under the run floor (the guard's last resort leaves
// the long run out); easy erg work never takes the slot of the week's last
// station session or brick, nor the minutes or slots the injury gates took.
// Still v18 (unreleased; round 4 review fixes, third pass, 2026-10-13): a
// ceiling trims the long run to the run floor and leaves it out before it
// takes the week's last station session or brick, which leaves only when the
// week is still over without the long run; week 1's assessment is exempt from
// week 1's guard; race week holds a run whenever it holds a run slot (one easy
// run at the run floor when the primer is above the 110% ceiling and the easy
// runs would sit under the floor).
// Still v18 (unreleased; round 5, Tristan's decisions A to E of 2026-10-13):
// the MTL cap cuts easy running, then the long run, before station work (A);
// the ceilings cut easy erg work, then easy running, before the station work,
// at the largest scale that fits; a full week frees an easy-run slot for a
// longer easy erg session, never a missing quality run's slot, and taper week
// 1's tempo is sized alone (B); a week under the chosen hours says so (C);
// easy erg work has its own discipline, 'erg' (D); the taper long run never
// sits under the run floor (E).
// Still v18 (unreleased; round 5 review fixes, 2026-10-13): one more chosen
// hour never holds less, by construction (the hours ladder: the plan at each
// whole hour from the band's lowest, each holding the one below; B); the MTL
// cap takes the long run's growth, never its previous length; only the
// weekly-hours ceiling cuts easy running before station work, the guard and
// the deload shrink both by one scale; an injury that gates the stations
// never trades an easy run for erg work the gates drop; the hours note names
// the limit that binds, and a held week says so.
// Still v18 (unreleased; round 6, 2026-10-13): one constraint hierarchy
// (buildHyroxTrainingWeeks) replaces the layered decisions. The hours ladder
// goes (one more hour is reported, not enforced); the phase budget is part
// of the week's size; the running share sizes only the easy runs, so the long
// run and the tier quality run come first and a loaded week's long run never
// shortens under the previous loaded week's unless the week's size cuts it;
// ceilings leave the brick before the quality run; the MTL cap never cuts the
// long run; the easy erg slot keeps every running minute and never moves
// with an active injury; deloads hold an easy run at the run floor and cut
// circuit stations first; the plan view states when the chosen session count
// holds a loaded week under its hours (Week.hyroxHoursFit).
// Still v18 (unreleased; round 6 review, pass 2, 2026-10-14): a week the
// guard or the deload ceiling cannot hold at the chosen hours is built at the
// largest size they hold, the same week at every chosen hours above it (under
// a binding guard total plan minutes fell by up to 240 min, and quality runs
// with them, when one hour was added); the race taper's station ceilings never
// sit under its smallest circuit, so race week keeps a circuit unless its days
// or the fractions exclude it; the hours line shows only where the phase
// budget is the chosen hours and one more session would hold 20 min more.
// Still v18 (unreleased; round 7, Tristan's decisions of 2026-10-14): the
// acute:chronic guard never holds a week under the plan's own nominal week 1,
// and the chronic seed is the larger of the logged load and that week (a
// logged load of about 25 TSS or less stalled the plan); the race taper's
// smallest circuit is exempt from the 0.70 / 0.55 fractions, so no taper or
// race week loses all its station work; an easy erg session takes an easy
// run's slot or MTL whenever the week then holds more minutes; deloads rank
// the easy run above the mini brick and hold no session longer or heavier
// than the last loaded week's; a quality run over the hard-session limits
// takes an easy slot before the runs are sized; the hours line is checked
// against the real plan with one more session; plans build in under 10 ms
// (desktop Node).
// Still v18 (unreleased; round 7 review minors and the merge, 2026-10-14): an
// easy erg session takes an easy run's slot only while the week's running
// stays at or above the D2 share, never in a deload; a Thursday race week's
// circuit takes its one day 3 or more days out from the primer (an easy run
// holds a lone primer's run slot), and the week before race week re-places
// station work the race window drops on a free day 7 or more days out; a
// deload session of a type the last loaded week did not hold takes the
// lightest of its class there; the running share counts brick run segments
// as the injury gates leave them; a limit easy erg work does not count
// toward never takes it.
// Still v18 (unreleased; merge of fix/load-accounting, 2026-10-14). One bump
// carries everything since main's v17:
// - H1: station MTL at the athlete's load tier (division, format and sex;
//   hyroxLoadTierForState through every station, brick and assessment);
// - H3a/H3b: the real S8-S9 results, so untested stations and an unset race
//   pace take the band seeds of the athlete's planning field at the target's
//   loads (hyroxPlanningStationBenchmarks, hyroxStationSeedsAtTarget,
//   hyroxSeedRunPaceSecKm), and the band thresholds come from that field;
// - H3c: one planning band for every format (hyroxPlanningBandFor, Open
//   Singles at the athlete's sex), read at onboarding too;
// - H2: the weekly structure, constraint hierarchy, scheduler, deloads and
//   taper above.
// Band, seeds, MTL cap and plan weeks all change for Pro, Doubles and
// sex-specific athletes, so every stored plan regenerates once.
// v19 (lane H2b part 1, 2026-10-19): what is inside station sessions and
// bricks (parameter sheet technique.station_session and bricks.structure,
// revised; Tristan's progressive loads of 2026-10-12). One bump carries:
// - technique sessions: 0.5 x race volume per station in quarter-station
//   sets, RPE 5, 2 min rest; beginners 4 stations rotated, sleds 4 sets of
//   one lane; race-pace sessions: 3 stations with the forecast's weakest,
//   race weight, RPE 7, 90 s rest. The old circuits (2 to 6 x race volume,
//   65% of the seed time at RPE 5, the easy-run finish) are gone;
// - the race-pace dose steps 0.5 x, 0.75 x, 1.0 x with the week's nominal
//   size toward peak, to the nearest quarter (1.0 x from 0.875 of peak, so
//   build holds the sheet's 1.0 x; 0.5 x in base deloads, 0.75 x in build
//   and peak deloads, never above the reference week's session) and down to
//   the session's share of the week's size;
// - beginner loads: sleds unloaded weeks 1-2, then 50%, other loaded
//   stations 60%, race weight 4 weeks out, stepped between those anchors from
//   the athlete's own rating on the last station session (suggestNextWeight;
//   an RPE derived from a synced recording holds the load, athleteRatedRpe);
// - bricks by tier (3 x 400 m, 4 x 800 m, the advanced key 6 x 800 m and the
//   peak secondary 4 x 800 m easy), 0.25 x of a station per round, no
//   secondary-brick station above the technique dose;
// - every prescription states damper 6, sled lanes, the wall-ball target by
//   sex, the tier's loads and, for doubles, half of every station (half the
//   sets);
// - the forecast's weakest station stored on the plan (planWeakestStation);
// - integration minors: the quality step runs again after the long run
//   leaves a week still over its hours; the race taper's brick is capped to
//   the reference week's brick of its type; a Thursday race's taper week 1
//   keeps its station work over the tempo; the version regeneration re-bands
//   a stored plan on the planning band (rebandStoredHyroxPlan) with the
//   initializer's staleness rule, as log-a-race and the format fix do
//   (hyroxStoredRaceBand).
export const HYROX_GENERATOR_VERSION = 19;

type HyroxPhase = 'base' | 'build' | 'peak' | 'taper';

// ─── Phase assignment ─────────────────────────────────────────────────────────
// Phase assignment is delegated to `computeHyroxPlanPhases(totalWeeks)` from
// hyrox-constants.ts, which shares the strategy with running and triathlon and
// adds the double-periodization arc for plans ≥28 weeks.

/** Nominal volume multiplier of a training (non-taper) week. */
function trainingPhaseMultiplier(phase: 'base' | 'build' | 'peak', weekIndex: number): number {
  switch (phase) {
    case 'base':  return hyroxBaseMultiplier(weekIndex);
    case 'build': return HYROX_BUILD_MULT;
    case 'peak':  return HYROX_PEAK_MULT;
  }
}

// ─── Planned load ─────────────────────────────────────────────────────────────

/** Sessions the week's own load and volume count: commute runs are the
 *  athlete's travel, appended on top of the plan (SCIENCE_LOG §AK), constant
 *  week to week, so the guard and the taper ignore them. */
function prescribed(ws: readonly Workout[]): readonly Workout[] {
  // The same list when it holds no commute run (callers only read it).
  for (const w of ws) if (w.commute === true) return ws.filter(x => x.commute !== true);
  return ws;
}

/** Planned minutes of a HYROX week (commute runs excluded). */
export function hyroxPlannedMinutes(ws: readonly Workout[]): number {
  let min = 0;
  for (const w of ws) if (w.commute !== true) min += w.estimatedDurationMin ?? 0;
  return min;
}

/** Planned load of a HYROX week in canonical TSS (commute runs excluded):
 *  each session's hyroxSessionPlannedTss (duration × plannedTssPerMin(type,
 *  RPE); a lane H2b part 2 station session or brick prices its warm-up,
 *  strength block and finisher at their own efforts), the valuation the
 *  planned-day pricer applies to HYROX sessions (ui/planned-day-tss.ts). */
export function hyroxPlannedTss(ws: readonly Workout[]): number {
  let tss = 0;
  for (const w of ws) if (w.commute !== true) tss += hyroxSessionPlannedTss(w);
  return tss;
}

// ─── Session kind selection ───────────────────────────────────────────────────

/**
 * Station session kinds for the week, race-pace (density) first. Beginner:
 * technique. Intermediate: technique in base, race pace in build and peak.
 * Advanced: race pace plus technique in base and build, race pace alone in
 * peak. Taper and race week: technique (the existing taper downgrade).
 */
function stationKinds(
  tier: HyroxTier,
  phase: HyroxPhase,
  count: number,
): Array<'station_technique' | 'station_density'> {
  const out: Array<'station_technique' | 'station_density'> = [];
  for (let i = 0; i < count; i++) {
    if (phase === 'taper' || tier === 'beginner') out.push('station_technique');
    else if (tier === 'intermediate') out.push(phase === 'base' ? 'station_technique' : 'station_density');
    else out.push(i === 0 ? 'station_density' : 'station_technique');
  }
  return out;
}

/**
 * Brick kinds for the week. Beginners' brick is the mini brick; the taper
 * downgrades a full brick to a mini brick to protect eccentric load. A second
 * brick (advanced peak) is the secondary brick: not a hard session
 * (`hyroxLight`), mini-brick format (ergs, no eccentric station).
 */
function brickKinds(tier: HyroxTier, phase: HyroxPhase, count: number): Array<{ kind: 'brick' | 'mini_brick'; light: boolean }> {
  const out: Array<{ kind: 'brick' | 'mini_brick'; light: boolean }> = [];
  for (let i = 0; i < count; i++) {
    if (i >= 1) { out.push({ kind: 'mini_brick', light: true }); continue; }
    out.push({ kind: tier === 'beginner' || phase === 'taper' ? 'mini_brick' : 'brick', light: false });
  }
  return out;
}

/**
 * The week's session counts: the tier's structure for the phase (taper and
 * race week keep the peak structure), fitted to the athlete's session-count
 * choice. The stored counts (runsPerWeek, stationSessionsPerWeek,
 * bricksPerWeek) describe the athlete's build week. A choice below a phase's
 * structure caps that phase; a choice above the build week adds easy runs to
 * every phase (applyHyroxSessionDelta). No brick in base, before
 * HYROX_FIRST_BRICK_WEEK or in race week.
 */
function weekSessionCounts(
  hx: NonNullable<SimulatorState['hyroxConfig']>,
  tier: HyroxTier,
  phase: HyroxPhase,
  weekIndex: number,
  raceWeek: boolean,
  chosenDelta = 0,
): HyroxSessionCounts {
  const def = HYROX_WEEKLY_SESSIONS[hx.athleteBand];
  const chosen = hyroxSessionTotal({
    runs: hx.runsPerWeek ?? def.runs,
    stations: hx.stationSessionsPerWeek ?? def.stations,
    bricks: hx.bricksPerWeek ?? def.bricks,
  }) + chosenDelta;
  const row = HYROX_WEEKLY_STRUCTURE[tier][phase === 'taper' || raceWeek ? 'peak' : phase];
  const rowTotal = hyroxSessionTotal(row);
  const extra = chosen - hyroxSessionTotal(def);
  const delta = chosen < rowTotal ? chosen - rowTotal : Math.max(0, extra);
  const counts = applyHyroxSessionDelta(row, delta);
  if (raceWeek || phase === 'base' || weekIndex < HYROX_FIRST_BRICK_WEEK) counts.bricks = 0;
  return counts;
}

// ─── MTL cap enforcement ──────────────────────────────────────────────────────

/** Station and brick sessions the weekly MTL cap may cut (not the week-1
 *  assessment, a single calibration pass, nor easy erg work, which is sized
 *  inside the MTL the week leaves under the cap). */
function mtlCuttable(s: Workout): boolean {
  // A race simulation is the race's length (lane H2b part 2): never cut.
  return (s.discipline === 'station' || s.discipline === 'brick') && s.t !== 'hyrox_assessment' && !isHyroxEasyErg(s) && !isHyroxSim(s);
}

/** How the MTL cap shortens the week's easy running (enforceMTLCap). */
interface HyroxMtlRunTrim {
  /** The run at a new length (minutes at easy pace), same kind. */
  remake: (w: Workout, minutes: number) => Workout;
  /** Shortest easy run (HYROX_RUN_FLOOR_MIN). */
  easyFloorMin: number;
  /** Taper weeks keep their run count: easy runs shorten, never leave. */
  keepRunCount: boolean;
}

/** A standalone easy run that is not the long run (commute runs excluded). */
function isPlainEasyRun(w: Workout): boolean {
  return w.t === 'hyrox_run_easy' && !isHyroxLongRun(w) && w.commute !== true;
}

/**
 * Weekly MTL cap (rules_to_code 16). The constraint hierarchy's step 4
 * (buildHyroxTrainingWeeks): while the week's MTL is above the cap,
 *   0. easy erg work gives way first: it is sized after the cap, inside the
 *      MTL the week leaves under it (generateWeekSessions easyErgFor), so it
 *      never costs a run minute or a station round;
 *   1. easy runs (not the long run, not the quality run) shorten toward the
 *      run floor, then leave the week, shortest first (taper weeks keep their
 *      run count: shortened only); the runs left take back what the cut
 *      freed, up to their length;
 *   2. one round off the highest-MTL station or brick session above
 *      MIN_CIRCUIT_ROUNDS (withHyroxRounds cuts the real volume: work, rest,
 *      duration and the description's round count);
 *   3. with every session at MIN_CIRCUIT_ROUNDS, the highest-MTL station out
 *      of the highest-MTL circuit holding more than MIN_CIRCUIT_STATIONS
 *      (withoutHyroxStation);
 *   4. then the technique station session leaves the week, when that brings
 *      the week under the cap, never as its last station session or brick.
 * The long run and the quality run are never cut (the hierarchy's first
 * allocation step: the long run is never cut to make room for anything below
 * it; the quality run is a fixed format). A week still over the cap after
 * that is left as it is and its note says so. Each step is noted on the
 * week. Round 5 (2026-10-13) also shortened the long run down to its
 * previous length; round 6 leaves it alone. Before 2026-10-13 the
 * cap cut station rounds while every run stayed, so at 10 to 12 h 19% of
 * training weeks were over 70% running and peak-week load fell as hours rose
 * in 57 band/length pairs (the larger running share took the cap). Before
 * 2026-10-12 the cap scaled only the reported MTL numbers. The cap values are
 * still initial estimates (HYROX_MTL_CAP). The order inside the station work
 * (highest MTL first, technique before race pace) is a product order: no
 * source ranks the cuts.
 */
function enforceMTLCap(sessions: Workout[], cap: number, adjustments: string[], weekIndex: number, runTrim?: HyroxMtlRunTrim): Workout[] {
  let out = [...sessions];
  const total = () => out.reduce((sum, s) => sum + (s.musculoTendonLoad ?? 0), 0);
  const mtlOf = (s: Workout) => s.musculoTendonLoad ?? 0;
  const minOf = (s: Workout) => s.estimatedDurationMin ?? 0;
  const perMin = (s: Workout) => (minOf(s) > 0 ? mtlOf(s) / minOf(s) : 0);
  if (runTrim && total() > cap) {
    const floor = runTrim.easyFloorMin;
    // 1. Easy runs: shorten together toward the floor.
    const before = new Map(out.filter(isPlainEasyRun).map(w => [w, minOf(w)] as const));
    const easyBefore = [...before.values()].reduce((a, m) => a + m, 0);
    for (let i = 0; i < 8 && total() > cap; i++) {
      const above = out.filter(w => isPlainEasyRun(w) && minOf(w) > floor);
      const rate = above.reduce((a, w) => a + perMin(w), 0);
      if (above.length === 0 || rate <= 0) break;
      const cutEach = Math.max(1, Math.ceil((total() - cap) / rate));
      out = out.map(w => (above.includes(w) ? runTrim.remake(w, Math.max(floor, minOf(w) - cutEach)) : w));
    }
    // Then they leave the week, shortest first; the ones left take back what
    // fits under the cap, up to the length they had.
    let left = 0;
    while (!runTrim.keepRunCount && total() > cap) {
      const easy = out.filter(isPlainEasyRun).sort((a, b) => minOf(a) - minOf(b));
      if (easy.length === 0) break;
      out = out.filter(w => w !== easy[0]);
      left++;
    }
    if (left > 0) {
      const room = cap - total();
      const rest = out.filter(isPlainEasyRun);
      const rate = rest.reduce((a, w) => a + perMin(w), 0);
      const want = Math.max(...[...before.values()], 0);
      if (rest.length > 0 && rate > 0 && room > 0) {
        const addEach = Math.floor(room / rate);
        if (addEach > 0) out = out.map(w => (rest.includes(w) ? runTrim.remake(w, Math.min(want, minOf(w) + addEach)) : w));
      }
      adjustments.push(`W${weekIndex}: ${left} easy run(s) left out (MTL cap ${cap})`);
    }
    const easyAfter = out.filter(isPlainEasyRun).reduce((a, w) => a + minOf(w), 0);
    if (easyAfter < easyBefore && out.some(isPlainEasyRun)) {
      adjustments.push(`W${weekIndex}: easy runs cut from ${easyBefore} to ${easyAfter} min (MTL cap ${cap})`);
    }
  }
  let roundCuts = 0;
  let stationCuts = 0;
  while (total() > cap) {
    let best = -1;
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (!mtlCuttable(s) || (s.hyroxRounds ?? 0) <= hyroxMinRounds(s)) continue;
      if (best < 0 || mtlOf(s) > mtlOf(out[best])) best = i;
    }
    if (best >= 0) {
      out[best] = withHyroxRounds(out[best], (out[best].hyroxRounds ?? 0) - 1);
      roundCuts++;
      continue;
    }
    let circuit = -1;
    for (let i = 0; i < out.length; i++) {
      const s = out[i];
      if (s.t !== 'hyrox_station_technique' && s.t !== 'hyrox_station_density') continue;
      if ((s.hyroxComponents ?? []).filter(c => c.type !== 'run').length <= MIN_CIRCUIT_STATIONS) continue;
      if (circuit < 0 || mtlOf(s) > mtlOf(out[circuit])) circuit = i;
    }
    if (circuit >= 0) {
      // The heaviest station, never a race-pace session's weakest station
      // while another is left (hyroxStationToCut).
      out[circuit] = withoutHyroxStation(out[circuit], hyroxStationToCut(out[circuit]) as HyroxStation);
      stationCuts++;
      continue;
    }
    // The whole technique session leaves only when that brings the week
    // under the cap: when the runs alone hold the week above it, dropping the
    // station session would take the week's HYROX-specific work for no
    // compliance. It never leaves as the week's last station session or
    // brick (review 2026-10-13: every training week keeps HYROX work).
    const tech = out.findIndex(s => s.t === 'hyrox_station_technique');
    if (tech >= 0 && total() - mtlOf(out[tech]) <= cap && hasHyroxWork(out.filter((_, i) => i !== tech))) {
      adjustments.push(`W${weekIndex}: technique station session left out (MTL cap ${cap})`);
      out = out.filter((_, i) => i !== tech);
      continue;
    }
    adjustments.push(`W${weekIndex}: MTL ${Math.round(total())} above the ${cap} cap with every station and brick session at its floor`);
    break;
  }
  if (roundCuts > 0) adjustments.push(`W${weekIndex}: ${roundCuts} station or brick round(s) cut (MTL cap ${cap})`);
  if (stationCuts > 0) adjustments.push(`W${weekIndex}: ${stationCuts} station(s) taken out of a circuit (MTL cap ${cap})`);
  return out;
}

// ─── Long run ─────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;

/** Local midnight of the plan's first day, or null. */
function planStartMs(state: SimulatorState): number | null {
  const iso = state.planStartDate?.slice(0, 10);
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}

/**
 * Week-1 long run (minutes at easy pace) and the longest logged run of the 30
 * days before the plan (km), the start of the single-run rule.
 *   - A run logged in those 30 days: the tier start, never above 110% of that
 *     run (Frandsen 2025; this rule wins over the 30-min floor, as in running).
 *   - Logged runs, none in those 30 days: running's 30-min restart
 *     (LONG_SOFT_FLOOR_MIN, sharpening-block 'history-no-recent-run').
 *   - No logged run: beginners 30 min (the existing floor and CoachRx's
 *     starting point), other tiers the tier start (as running uses its ramp
 *     start with no history).
 * The window ends at the plan's first day, so regenerating a plan later gives
 * the same start. Planning side.
 */
export function hyroxLongRunStart(state: SimulatorState, tier: HyroxTier, easyPaceSecKm: number): { startMin: number; recentLongestKm: number | null } {
  const lr = HYROX_LONG_RUN[tier];
  const anchor = planStartMs(state) ?? Date.now();
  // Runs before the plan only: the plan's own matched runs are not history.
  const runs = loggedRuns(state).filter(r => r.startMs < anchor);
  const recentMin = longestRunMinBetween(runs, anchor - RECENT_LONGEST_WINDOW_DAYS * DAY_MS, anchor, easyPaceSecKm);
  if (recentMin != null) {
    const ceiling = Math.floor(recentMin * (1 + LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST));
    return { startMin: Math.min(lr.startMin, ceiling), recentLongestKm: (recentMin * 60) / easyPaceSecKm };
  }
  if (runs.length > 0) return { startMin: Math.min(lr.startMin, LONG_SOFT_FLOOR_MIN), recentLongestKm: null };
  return { startMin: tier === 'beginner' ? LONG_SOFT_FLOOR_MIN : lr.startMin, recentLongestKm: null };
}

/** Real running-fitness signal, guarded so a partial state reads as none. */
function realRunningSignal(state: SimulatorState): boolean {
  try { return hasRealRunningFitnessSignal(state); } catch { return false; }
}

// ─── Per-week generation ──────────────────────────────────────────────────────

/** Race week: the plan's final training week (isRaceWeek). Its content rules
 *  apply with or without a race date; day placement needs the race-day
 *  layout (hyroxWeekForRace). */
interface HyroxRaceWeek {
  layout: RaceWeekLayout | null;
  /** First schedulable weekday of the week (workout-status firstTrackedDow). */
  firstDow: number;
}

/** A reference week's per-session caps (sessionCapsOf). */
type HyroxSessionCaps = Partial<Record<string, { min: number; rounds: number; stations: number; mtl: number }>>;

/** Cap class of a station or brick session type. */
function sessionCapClass(t: string): 'circuit' | 'brick' {
  return t === 'hyrox_brick' || t === 'hyrox_mini_brick' ? 'brick' : 'circuit';
}

/** The cap for a session type: its own entry, else its class's (a deload or
 *  taper week holding a type the reference week did not, e.g. the taper's
 *  technique circuit after a race-pace peak). */
function sessionCapFor(caps: HyroxSessionCaps | undefined, t: string): { min: number; rounds: number; stations: number; mtl: number } | undefined {
  if (!caps) return undefined;
  return caps[t] ?? caps[sessionCapClass(t)];
}

/** What one week's generation reads from the weeks before it. */
interface HyroxWeekInputs {
  /** The week's minute budget (hours are a ceiling). */
  budgetMin: number;
  /** The week's long run (minutes at easy pace), or null for none. */
  longRunMin: number | null;
  /** Longest run allowed this week (km): 110% of the longest run of the
   *  previous LONG_RUN_LOOKBACK_WEEKS weeks; null when none is known. */
  runCeilingKm: number | null;
  /** The previous week's Sunday, for the Sunday-to-Monday spacing. */
  prevSunday: HyroxPrevSunday | null;
  /** Scale on every budget-sized session (station sessions, bricks, the
   *  running share), applied after their caps: the acute:chronic guard and the
   *  taper ceiling lower it. 1 = the budget as is. */
  scale?: number;
  /** Sessions the acute:chronic guard leaves out of the week. */
  omit?: readonly HyroxGuardOmit[];
  /** Taper week 1 and deload weeks: the reference week's session counts (the
   *  last loaded week). A taper or a deload reduces; it never adds a session
   *  the reference week did not hold (running's rule, SCIENCE_LOG §CV.4). Race
   *  week is exempt: it keeps the peak structure minus the brick (§CE update
   *  4: race week holds the primer whenever it holds a run, unless the 110%
   *  single-run ceiling excludes it), its runs capped at the reference week's
   *  count (maxRuns, D6). */
  capCounts?: HyroxSessionCounts;
  /** Deload weeks: hard sessions and quality runs at most the last loaded
   *  week's (running's CV.4: deload quality count at most the last loaded
   *  week's). */
  maxHardSessions?: number;
  maxQualityRuns?: number;
  /** Taper weeks: the week before's running minutes. A taper week never runs
   *  more than the week before (the taper never rises; the existing race-week
   *  rule). */
  prevRunMin?: number;
  /** Deload and race-taper weeks: per session type (station circuits,
   *  bricks), the longest duration, the most rounds and the most stations
   *  the reference week (the last loaded week) held, with the circuit and
   *  brick classes as a fallback for a type it did not hold. A deload or a
   *  taper week holds no session longer or fuller than its counterpart there
   *  (review 2026-10-12: a deload brick of 90 min and 6 rounds against 75 min
   *  and 5 in the week before; review 2026-10-13: taper weeks rebuilt a full
   *  4-station circuit of 50 to 72 min where the reference week held 2
   *  stations, so taper week 1 sat up to 0.98 of the reference week). */
  sessionCaps?: HyroxSessionCaps;
  /** Deload weeks: no station or brick session longer or heavier (minutes
   *  and MTL) than its counterpart in the reference week (sessionCaps): one
   *  that is loses rounds down to MIN_CIRCUIT_ROUNDS, then its heaviest
   *  stations down to MIN_CIRCUIT_STATIONS (round 7, 2026-10-14: in 356
   *  deload weeks at the default sessions a circuit with the reference
   *  week's rounds held more, e.g. total_beginner 4 h 8 weeks W4 at 67 min
   *  and 215 MTL against W3's 63 min and 155, the rotation picking heavier
   *  stations). */
  capSessionLoad?: boolean;
  /** Race-taper weeks (H2 integration review, 2026-10-14): a brick no longer
   *  or heavier than the reference week's brick of its own type, as a deload
   *  holds every session (capSessionLoad): rounds come off down to its floor,
   *  then it repeats the reference week's brick of that type. So the taper's
   *  exempt brick is never heavier only because its erg differs, and the
   *  taper's station-work cap does not shed it. */
  capBrickLoad?: boolean;
  /** Deload weeks: the reference week's station and brick sessions. A
   *  session at its floors (MIN_CIRCUIT_ROUNDS rounds, MIN_CIRCUIT_STATIONS
   *  stations) still longer or heavier than its counterpart repeats it
   *  (capSessionLoad). */
  sessionRefs?: readonly Workout[];
  /** Name of the week's ceiling in the notes (default 'acute:chronic guard'). */
  ceilingName?: string;
  /** Race week: circuit rounds at most the week before's (the taper never
   *  rises). Before (review 2026-10-12) race week's one circuit took the whole
   *  non-running budget: 64 to 73 min and 4 to 5 rounds against 2 rounds the
   *  week before. */
  maxCircuitRounds?: number;
  /** Training weeks: the running budget (minutes), HYROX_RUN_SHARE x the
   *  chosen weekly minutes (D2, Tristan 2026-10-13). Unset (taper weeks):
   *  HYROX_RUN_SHARE x budgetMin. */
  runBudgetMin?: number;
  /** The week's volume target for easy erg work (minutes): what the sessions
   *  leave of it, at least HYROX_RUN_FLOOR_MIN, becomes easy erg work.
   *  Unset: budgetMin. */
  fillMin?: number;
  /** The most easy erg minutes the week may hold: the week's ceilings take
   *  easy erg work away first (buildHyroxTrainingWeeks fit). Unset: no limit. */
  ergCapMin?: number;
  /** Training weeks: the most standalone easy-run minutes (not the long run
   *  or the quality run) the week may hold: the ceilings' scale times what
   *  the week held at full size (buildHyroxTrainingWeeks fit), so easy runs
   *  the long run caps shrink with the station work. Unset: no limit. */
  easyRunCapMin?: number;
  /** Set while a ceiling shortens the long run: a quality run longer than
   *  the long run runs easy instead of stretching it back (generateWeekSessions). */
  longFixed?: boolean;
  /** Deload weeks: the easy runs' minutes never fall under this under the
   *  ceilings' scale (HYROX_RUN_FLOOR_MIN when the last loaded week held a run
   *  besides the long run): the scale takes the circuits and bricks down instead, and an
   *  easy run leaves only when the week is over its ceiling with the stations
   *  out of its circuits (buildHyroxTrainingWeeks). Unset: none. */
  easyHoldMin?: number;
  /** Deload weeks: the running budget at the chosen weekly hours. The easy
   *  run hold (easyHoldMin) applies when this, less the long run, the quality
   *  run and the brick runs, funds it, whatever size a ceiling builds the
   *  week at (buildHyroxTrainingWeeks fit). Unset: runBudgetMin. */
  easyHoldRunBudgetMin?: number;
  /** The week as it would be with one more chosen weekly session (the hours
   *  line's check: buildHyroxTrainingWeeks). */
  extraSession?: boolean;
  /** A deload week (the last loaded week its reference): easy erg work never
   *  takes an easy run's slot there (generateWeekSessions ergSlotOptions). */
  deload?: boolean;
  /** Set when a fixed ceiling (the acute:chronic guard, the deload ceiling)
   *  builds the week at a smaller size than the chosen hours: the notes name
   *  that ceiling for what the smaller size leaves out. */
  ceilingSized?: boolean;
  /** Taper weeks: the longest easy session, the taper's long run (the week's
   *  own; race week, which holds none, the week before's). It caps easy erg
   *  sessions, and race week's easy runs too (review 2026-10-13: a 2-week
   *  plan's race-week easy runs reached 60 min against week 1's 49-min taper
   *  long run). Unset: the tier long-run cap alone. */
  easyMaxMin?: number;
  /** The most prescribed sessions the week may hold: the athlete's chosen
   *  weekly total; deload and taper weeks also the reference week's total.
   *  Easy erg work fills free slots up to it, never past it (D1). */
  maxSessions?: number;
  /** How the notes name maxSessions (e.g. 'the chosen 6 sessions'). */
  maxSessionsName?: string;
  /** Race week: the most runs, the reference week's (D6: race week never holds
   *  more runs than the last loaded training week). */
  maxRuns?: number;
  /** Week 1 without the assessment (a station session in its slot): the
   *  nominal week-1 structure that seeds the guard's chronic window when no
   *  logged weekly load exists (D4). */
  noAssessment?: boolean;
  /** The shortest long run a training week prescribes: HYROX_RUN_FLOOR_MIN,
   *  or the athlete's long-run start when that is shorter (a start held under
   *  it by a short logged run). One sized under it is left out. Unset:
   *  HYROX_RUN_FLOOR_MIN. */
  runFloorMin?: number;
  /** The station and brick sessions built so far this week, by their inputs
   *  (buildHyroxTrainingWeeks, one map per week build). Unset: none kept. */
  sessionMemo?: Map<string, { w: Workout; notes: string[] }>;
  /** The week's first schedulable weekday (workout-status firstTrackedDow)
   *  and realRunningSignal(state), computed once per plan build
   *  (buildHyroxTrainingWeeks) rather than at every build of the week. Unset:
   *  computed here. */
  firstDow?: number;
  realRunning?: boolean;
  /** The station target times (hyroxPlanningStationBenchmarks) and the
   *  station load tier (hyroxLoadTierForState), read once per plan build:
   *  every build of every week reads them. Unset: computed here. */
  stationBenchmarks?: Partial<Record<HyroxStation, number>>;
  loadTier?: HyroxLoadTier;
  /** The week's prescribed load per loaded station (kg): the beginner load
   *  schedule with its RPE autoregulation (buildHyroxTrainingWeeks,
   *  hyroxBeginnerStationLoadKg). Unset: race weight (intermediate and
   *  advanced athletes train at race weight). */
  stationLoads?: Partial<Record<HyroxStation, number>>;
  /** Training weeks: the week's nominal size relative to the plan's peak
   *  week, its phase multiplier x the deload factor x the effort / MTL-gap
   *  lever ÷ HYROX_PEAK_MULT (the race-pace volume progression,
   *  hyroxRacePaceSets). It does not read the chosen hours, so a week a fixed
   *  ceiling holds is the same week at every chosen hours above its size; the
   *  ceilings reach the dose through the session's share of the week's size
   *  (doseMinutes). Unset: 1. */
  doseFraction?: number;
  /** The forecast's weakest station (hyrox-weakest-link on predictHyroxRace),
   *  read once per plan build: the race-pace session holds it first. Null or
   *  unset: none known (no race date, no projection). */
  weakestStation?: HyroxStation | null;
  /** The week's race simulation (lane H2b part 2, hyroxSimWeeks): it takes
   *  the brick's slot; a full sim also the long run's, and the quality run
   *  drops in both. Unset: none. */
  sim?: HyroxSimWeek;
}

/** What a training week over its size (the acute:chronic guard, the deload
 *  ceiling, the weekly hours, the phase budget) leaves out, in this order,
 *  when cutting easy erg work and scaling the station work and easy runs
 *  down to their floors still leave it above: easy runs, the standalone
 *  strength session (lane H2b part 2: the block in the station session
 *  stays), stations out of
 *  each circuit down to MIN_CIRCUIT_STATIONS (the circuit stays; a station
 *  session's floor is 2 rounds of every station, 50 to 65 min, so before
 *  2026-10-13 a deload at low hours lost the whole circuit), the technique
 *  station session, the secondary brick, the brick (the constraint
 *  hierarchy's allocation order run backwards, buildHyroxTrainingWeeks). A
 *  deload takes the stations out of its circuits first, and its easy run
 *  ranks above the mini brick (round 7): the secondary brick and the
 *  beginner tier's brick leave before it, the technique session and a full
 *  brick after it. Then
 *  the long run gives up its growth for the quality run (D3) and the quality
 *  run leaves ('quality'). A group whose omission would leave the week with
 *  no station session and no brick waits until the long run is trimmed to
 *  the run floor and left out (review 2026-10-13, round 2 and third pass); it
 *  leaves only when the week is still over without the long run, and the
 *  long run then takes back what fits. Within the station work, a product
 *  order: no source ranks sessions for this. */
const HYROX_GUARD_OMIT_ORDER = ['easy', 'strength', 'stations', 'technique', 'light', 'brick'] as const;

/** Upper end of the week-size search under a fixed ceiling
 *  (buildHyroxTrainingWeeks fit): the largest weekly hours any band can
 *  choose (HYROX_HOURS_RANGE), in minutes. */
const HYROX_SIZE_SEARCH_MAX_MIN = Math.max(...Object.values(HYROX_HOURS_RANGE).map(r => r.max)) * 60;
type HyroxGuardOmit = typeof HYROX_GUARD_OMIT_ORDER[number] | 'quality';

/**
 * Days a race-week session may take, in order of preference (the running
 * race-day rules applied to HYROX, SCIENCE_LOG §CE and §CW). Every session
 * sits before race day and on or after the first schedulable day.
 *   - The primer, the week's one hard session (the taper tempo run), takes
 *     running's primer day (raceWeekPrimerDow from the tempo's home day,
 *     Tuesday): Tuesday when that is 3 to 5 days out, otherwise the latest
 *     race-week day in that window. With none it is left out.
 *   - A station circuit sits at least PRIMER_MIN_DAYS_OUT days out, on its
 *     preferred days first, so the last two days before the race hold easy
 *     runs only, as in running, where nothing but easy running comes after
 *     the primer.
 *   - Easy runs take the latest free days first, so race week runs up to the
 *     race instead of bookending on Monday.
 * Before (review 2026-10-08), the tempo took the first of its preferred days
 * inside the window, 4 or 5 days out for every Monday to Wednesday race, and
 * easy runs took Monday: a Wednesday race at 5 h held Mon easy, Tue and Wed
 * circuits and a Friday tempo, then 4 empty days. Running's Wednesday race
 * holds a Sunday primer with only the closing week's Monday and Tuesday empty.
 */
function raceWeekDays(rw: HyroxRaceWeek & { layout: RaceWeekLayout }, weekIndex: number, w: Workout): number[] {
  const weekStart = (weekIndex - 1) * 7;
  const firstDow = Math.max(0, Math.min(7, rw.firstDow));
  if (isHyroxHardSession(w)) {
    const dow = raceWeekPrimerDow(rw.layout, weekIndex, HYROX_TEMPO_HOME_DOW, firstDow);
    return dow == null ? [] : [dow];
  }
  const open: number[] = [];
  for (let dow = firstDow; dow <= 6; dow++) {
    const daysOut = rw.layout.raceDayIndex - (weekStart + dow);
    if (daysOut >= 1) open.push(dow);
  }
  if (isHyroxEasyRun(w)) return open.reverse();
  const ok = open.filter(dow => rw.layout.raceDayIndex - (weekStart + dow) >= PRIMER_MIN_DAYS_OUT);
  const preferred = hyroxPreferredDays(w).filter(d => ok.includes(d));
  return [...preferred, ...ok.filter(d => !preferred.includes(d))];
}

function isHyroxEasyRun(w: Workout): boolean {
  return w.t === 'hyrox_run_easy' || (w.t === 'easy' && w.commute === true);
}

/** Shortest budget-sized station session and brick (minutes): a session's
 *  target never goes under these, whatever the week's size or scale. */
const STATION_SESSION_FLOOR_MIN = 35;
const BRICK_SESSION_FLOOR_MIN = 20;

/** A plan week's race simulation: the full race or a half (the race's
 *  first half for halfIndex 0, its second half for 1, alternating). */
export interface HyroxSimWeek { kind: 'full' | 'half'; halfIndex: number }

/** Weeks of racing without a race before an advanced athlete's full sim
 *  (parameter sheet sims.schedule: Lousa offers one after 12 to 16 weeks
 *  without competing; the sheet takes the far end). */
const HYROX_ADVANCED_SIM_WEEKS_WITHOUT_RACE = 16;
/** Weeks before race week of an advanced athlete's full sim (sheet: about 8
 *  weeks out; Lousa 6 to 8, the far end) and of a beginner's or
 *  intermediate's (sheet: about 4 weeks out; GoWOD 3 to 4). */
const HYROX_FULL_SIM_WEEKS_OUT: Record<HyroxTier, number> = { beginner: 4, intermediate: 4, advanced: 8 };
/** Half sims fall on every 4th loaded week of build and peak (sheet). */
const HYROX_HALF_SIM_EVERY_LOADED = 4;
/** An advanced athlete's half sims at least this many weeks apart (sheet). */
const HYROX_ADVANCED_HALF_SIM_GAP_WEEKS = 6;

/**
 * The plan's race simulations (lane H2b part 2; parameter sheet
 * sims.schedule and sims.week_volume, revised), planning side. A week may
 * hold one when it is a loaded build or peak week (not a deload), outside
 * the race taper (never in the final 14 days), from HYROX_FIRST_BRICK_WEEK,
 * and its structure holds a brick (a sim takes the brick's slot; the
 * athlete's session count can leave none).
 *   - Full sim: beginners and intermediates in the eligible week nearest 4
 *     weeks before race week, ties to the earlier week (GoWOD's 3 to 4 weeks
 *     out); advanced athletes none by default, one about 8 weeks out only
 *     when they have not raced in the 16 weeks before it (Lousa; the last race
 *     the stored previous race date or a logged race split).
 *   - Half sims: every 4th loaded week of build and peak, never the full
 *     sim's week (the full sim wins; the week before it is allowed, as Voom
 *     and Rundida place one), advanced ones at least 6 weeks apart.
 * Whether a week can hold its sim (the 110% single-run rule, the week's
 * size) is decided when the week is built: a full sim that cannot becomes a
 * half sim, and a half sim that cannot leaves the week its brick.
 */
export function hyroxSimWeeks(state: SimulatorState, trainingWeeks: number): Map<number, HyroxSimWeek> {
  const out = new Map<number, HyroxSimWeek>();
  const hx = state.hyroxConfig;
  if (!hx || state.continuousMode || trainingWeeks < HYROX_FIRST_BRICK_WEEK + HYROX_TAPER_WEEKS_MIN) return out;
  const tier = hyroxTier(hx.athleteBand);
  const planPhases = computeHyroxPlanPhases(trainingWeeks);
  const phaseList = planPhases.map(p => p.ph as TrainingPhase);
  const loaded = (w: number): boolean => {
    const ph = phaseList[w - 1];
    if (ph !== 'build' && ph !== 'peak') return false;
    const forceDeload = !!(state.wks?.[w - 1] as { forceDeload?: boolean } | undefined)?.forceDeload;
    return !forceDeload && !isHyroxDeloadWeek(w, phaseList, ph);
  };
  const eligible = (w: number): boolean => loaded(w) && w >= HYROX_FIRST_BRICK_WEEK && w <= trainingWeeks - HYROX_TAPER_WEEKS_MIN
    && weekSessionCounts(hx, tier, phaseList[w - 1] as HyroxPhase, w, false).bricks >= 1;
  const nearest = (target: number): number | null => {
    let best: number | null = null;
    for (let w = 1; w <= trainingWeeks; w++) {
      if (!eligible(w)) continue;
      if (best == null || Math.abs(w - target) < Math.abs(best - target)) best = w;
    }
    return best;
  };
  let full: number | null = null;
  if (tier !== 'advanced') {
    full = nearest(trainingWeeks - HYROX_FULL_SIM_WEEKS_OUT[tier]);
  } else {
    const candidate = nearest(trainingWeeks - HYROX_FULL_SIM_WEEKS_OUT.advanced);
    const start = state.planStartDate ? Date.parse(`${state.planStartDate}T12:00:00`) : NaN;
    const raceDates = [
      hx.hyroxPreviousRaceDate,
      ...Object.values(hx.stationBenchmarkHistory ?? {}).flatMap(list => (list ?? []).filter(e => e.source === 'race').map(e => e.dateISO)),
    ].filter((d): d is string => !!d).map(d => Date.parse(d.length <= 10 ? `${d}T12:00:00` : d)).filter(Number.isFinite);
    if (candidate != null && Number.isFinite(start) && raceDates.length > 0) {
      const simMs = start + (candidate - 1) * 7 * DAY_MS;
      const weeksSince = (simMs - Math.max(...raceDates)) / (7 * DAY_MS);
      if (weeksSince >= HYROX_ADVANCED_SIM_WEEKS_WITHOUT_RACE) full = candidate;
    }
  }
  if (full != null) out.set(full, { kind: 'full', halfIndex: 0 });
  let k = 0;
  let halfIndex = 0;
  let lastHalf = -Infinity;
  for (let w = 1; w <= trainingWeeks; w++) {
    if (!loaded(w)) continue;
    k++;
    if (k % HYROX_HALF_SIM_EVERY_LOADED !== 0 || w === full || !eligible(w)) continue;
    if (tier === 'advanced' && w - lastHalf < HYROX_ADVANCED_HALF_SIM_GAP_WEEKS) continue;
    out.set(w, { kind: 'half', halfIndex: halfIndex++ });
    lastHalf = w;
  }
  return out;
}

/**
 * The race taper's smallest station circuit: the week's first technique
 * circuit (race week: without the eccentric-heavy and sled stations) at the
 * shortest station-session target, MIN_CIRCUIT_ROUNDS rounds and
 * MIN_CIRCUIT_STATIONS stations, the heaviest stations out first (the
 * ceilings' station cut). The race taper's station and brick ceilings never
 * sit under it (buildHyroxTrainingWeeks), as race week's primer is exempt
 * from the fractions, so a reference week that held little station work still
 * leaves the taper one short circuit (round 6 review, pass 2: once the long
 * run and the quality run came first, a peak week holding a 26-min race-pace
 * block left both taper weeks with no circuit, 106 to 249 of 1,020 race weeks
 * per variant). Round 7 also exempts a circuit of that size from the taper
 * fractions (buildHyroxTrainingWeeks exemptCircuitOf). The injury gates
 * apply to it as to the week's own circuit (current and future weeks). Null
 * when the week cannot hold a circuit (race week without enough of the
 * remaining stations, or stations the injury gates drop).
 */
export function hyroxRaceTaperFloorCircuit(
  state: SimulatorState, weekIndex: number, raceWeek: boolean, stationLoads?: Partial<Record<HyroxStation, number>>,
): { min: number; mtl: number } | null {
  const hx = state.hyroxConfig!;
  if (raceWeek && raceWeekCircuitStations(hx.stationAccess).length < MIN_CIRCUIT_STATIONS) return null;
  let c = generateHyroxStation({
    kind: 'station_technique',
    targetMinutes: STATION_SESSION_FLOOR_MIN,
    band: hx.athleteBand,
    stationAccess: hx.stationAccess,
    phase: 'taper',
    slotIndex: weekIndex,
    bodyWeightKg: state.bodyWeightKg,
    // The week's own station targets and loads (generateWeekSessions).
    stationBenchmarks: hyroxPlanningStationBenchmarks(state),
    raceWeek,
    loadTier: hyroxLoadTierForState(state),
    seed: state,
    // The week's own loads (the beginner schedule; buildHyroxTrainingWeeks).
    stationLoads,
  });
  c = withHyroxRounds(c, hyroxMinRounds(c));
  for (;;) {
    const st = (c.hyroxComponents ?? []).filter(x => x.type !== 'run');
    if (st.length <= MIN_CIRCUIT_STATIONS) break;
    const next = withoutHyroxStation(c, hyroxStationToCut(c) as HyroxStation);
    if (next === c) break;
    c = next;
  }
  // With the parts the week's own circuit holds (lane H2b part 2): the
  // warm-up, and in the week before race week the light strength block
  // (race week holds none).
  const light = raceWeek ? null : hyroxStrengthContent(hx.athleteBand, 'taper', weekIndex, { minutes: HYROX_STRENGTH_BLOCK_MIN, light: true });
  c = withHyroxSessionParts(c, {
    warmup: hyroxSessionWarmup(hx.stationAccess, weekIndex, state.bodyWeightKg),
    strength: light ? { name: light.name, lines: light.lines, min: HYROX_STRENGTH_BLOCK_MIN, rpe: light.rpe, light: true, eccentric: light.eccentric } : null,
  });
  const injuryState = (state as any).injuryState as InjuryState | undefined;
  const [gated] = weekIndex < (state.w ?? 1) ? [c] : applyHyroxInjuryGates([c], injuryState);
  if (!gated) return null;
  return { min: gated.estimatedDurationMin ?? 0, mtl: gated.musculoTendonLoad ?? 0 };
}

function generateWeekSessions(
  state: SimulatorState,
  weekIndex: number,
  phase: HyroxPhase,
  inputs: HyroxWeekInputs,
  adjustments: string[],
  raceWeek?: HyroxRaceWeek,
): Workout[] {
  // Note (2026-05-26): clinical phase replacement removed for the same
  // reason as in plan_engine.triathlon.ts. The discipline gates are
  // the right mechanism for HYROX, not blanket "Complete Rest" cards
  // that ignore which components the user can still do.

  const hx = state.hyroxConfig!;
  const band = hx.athleteBand;
  const tier = hyroxTier(band);
  const bodyWeightKg = state.bodyWeightKg;
  // Race week is sharpening, not training (SCIENCE_LOG §CE): its sessions take
  // the taper kinds whatever the phase label (tempo primer, technique circuits).
  const kindPhase: HyroxPhase = raceWeek ? 'taper' : phase;
  const counts = weekSessionCounts(hx, tier, phase, weekIndex, !!raceWeek, inputs.extraSession ? 1 : 0);
  if (inputs.capCounts && !raceWeek) {
    counts.runs = Math.min(counts.runs, inputs.capCounts.runs);
    counts.stations = Math.min(counts.stations, inputs.capCounts.stations);
    counts.bricks = Math.min(counts.bricks, inputs.capCounts.bricks);
    if (counts.strength != null) counts.strength = Math.min(counts.strength, inputs.capCounts.strength ?? 0);
  }
  // A deload holds one strength session fewer (gym.ts generateGymWorkouts'
  // deload rule): the standalone session goes, the station session's block
  // stays (lane H2b part 2).
  if (inputs.deload && (counts.strength ?? 0) > 0) {
    counts.strength = (counts.strength ?? 0) - 1;
    adjustments.push(`W${weekIndex}: standalone strength session left out (deload: one strength session fewer)`);
  }
  // The week's race simulation (lane H2b part 2, hyroxSimWeeks; sheet
  // sims.week_volume). Its 1 km runs count as one run for the 110%
  // single-run rule: a full sim (8 km) above the week's ceiling becomes a
  // half sim (4 km), and a half sim above it leaves the week its brick.
  let sim: HyroxSimWeek | undefined = !raceWeek && phase !== 'taper' ? inputs.sim : undefined;
  // A sim the injury gates would drop (any restriction, as for a brick) is
  // not planned: the week keeps its structure for the gates and the
  // capability offers to work on (current and future weeks).
  if (sim && weekIndex >= (state.w ?? 1)) {
    const inj = (state as any).injuryState as InjuryState | undefined;
    if (inj?.active && applyHyroxInjuryGates([{ t: 'hyrox_sim', n: 'Race Simulation', discipline: 'brick' } as Workout], inj).length === 0) {
      adjustments.push(`W${weekIndex}: no race simulation (injury)`);
      sim = undefined;
    }
  }
  if (sim && inputs.runCeilingKm != null) {
    if (sim.kind === 'full' && HYROX_STATION_ORDER.length > inputs.runCeilingKm + 1e-9) {
      adjustments.push(`W${weekIndex}: full race simulation becomes a half (its 8 km of running above the 110% single-run ceiling, ${inputs.runCeilingKm.toFixed(1)} km)`);
      sim = { kind: 'half', halfIndex: 0 };
    }
    if (sim && sim.kind === 'half' && HYROX_STATION_ORDER.length / 2 > inputs.runCeilingKm + 1e-9) {
      adjustments.push(`W${weekIndex}: no race simulation (its 4 km of running above the 110% single-run ceiling, ${inputs.runCeilingKm.toFixed(1)} km): the week keeps its brick`);
      sim = undefined;
    }
  }
  // Race week holds no more runs than the last loaded training week (D6,
  // Tristan 2026-10-13; the primer takes one of them). Before, race week
  // rebuilt the peak structure's runs: 227 of 629 race weeks held more runs
  // than the reference week, up to 2 more (novice 6 h 11 w trained on 1 run a
  // week and raced off 3).
  const structureRuns = counts.runs;
  if (raceWeek && inputs.maxRuns != null && counts.runs > inputs.maxRuns) {
    adjustments.push(`W${weekIndex}: ${counts.runs - inputs.maxRuns} run(s) left out (race week holds no more runs than the reference week's ${inputs.maxRuns})`);
    counts.runs = Math.max(0, inputs.maxRuns);
  }
  // Station loads for MTL follow the athlete's division (hyrox-division.ts).
  const loadTier = inputs.loadTier ?? hyroxLoadTierForState(state);

  const scale = inputs.scale ?? 1;
  // Running: HYROX_RUN_SHARE of the chosen weekly minutes in a training week
  // (D2), of the week's own budget in a taper week. Station sessions and
  // bricks share the rest of the week's budget, as before.
  const runBudget = inputs.runBudgetMin ?? inputs.budgetMin * HYROX_RUN_SHARE;
  const nonRunBudget = inputs.budgetMin * (1 - HYROX_RUN_SHARE);
  const easyPace = hyroxEasyRunPaceSecKm(band, hx.hyroxRunPaceSecKm, state);
  const thresholdPaceSecKm = (inputs.realRunning ?? realRunningSignal(state)) && state.pac?.t != null && state.pac.t > 0 ? state.pac.t : undefined;

  // Commute runs are appended on top of the prescribed HYROX run sessions,
  // not substituted for them (revised 2026-05-20. See SCIENCE_LOG §AK).
  const commuteDays = state.commuteConfig?.enabled && state.commuteConfig.commuteDaysPerWeek > 0
    ? state.commuteConfig.commuteDaysPerWeek
    : 0;

  // Deload and race-taper weeks carry their reference week's session caps;
  // the ceiling that cut something is named in the note.
  const ceilingName = inputs.ceilingName ?? 'acute:chronic guard';
  // Clamp a budget-sized station or brick to its caps (minimum 35 min for
  // station sessions, 20 for a brick), then apply the week's scale.
  function clampDur(kind: string, raw: number): number {
    const minDur = kind.includes('station') ? STATION_SESSION_FLOOR_MIN : BRICK_SESSION_FLOOR_MIN;
    const capped = Math.min(HYROX_SESSION_MAX_MIN[kind] ?? 90, raw);
    const sized = Math.max(minDur, Math.round(capped * scale));
    const refCap = sessionCapFor(inputs.sessionCaps, `hyrox_${kind}`);
    return refCap ? Math.min(sized, Math.max(minDur, refCap.min)) : sized;
  }
  // Deload and race-taper weeks: no station or brick session with more
  // rounds, or a circuit with more stations, than its counterpart in the
  // reference week.
  const capToRef = (w: Workout): Workout => {
    const refCap = sessionCapFor(inputs.sessionCaps, w.t);
    if (!refCap) return w;
    let out = w;
    if ((out.hyroxRounds ?? 0) > refCap.rounds) {
      const rounds = Math.max(hyroxMinRounds(out), refCap.rounds);
      adjustments.push(`W${weekIndex}: ${out.n} cut to ${rounds} rounds (${ceilingName}: the reference week's)`);
      out = withHyroxRounds(out, rounds);
    }
    const maxStations = Math.max(MIN_CIRCUIT_STATIONS, refCap.stations);
    let cut = 0;
    for (;;) {
      const st = (out.hyroxComponents ?? []).filter(c => c.type !== 'run');
      if (st.length <= maxStations) break;
      const next = withoutHyroxStation(out, hyroxStationToCut(out) as HyroxStation);
      if (next === out) break;
      out = next;
      cut++;
    }
    if (cut > 0) adjustments.push(`W${weekIndex}: ${cut} station(s) taken out of the ${out.n} (${ceilingName}: the reference week's ${maxStations})`);
    if (inputs.capSessionLoad || (inputs.capBrickLoad && sessionCapClass(w.t) === 'brick')) {
      // No longer or heavier than the reference week's session, as the
      // injury gates leave both: rounds go first, then the heaviest stations
      // (the ceilings' station cut).
      const gates = weekIndex < (state.w ?? 1) ? undefined : (state as any).injuryState as InjuryState | undefined;
      const heavy = (x: Workout) => {
        const g = gates?.active ? applyHyroxInjuryGates([x], gates)[0] : x;
        return !!g && ((g.estimatedDurationMin ?? 0) > refCap.min + 1e-6 || (g.musculoTendonLoad ?? 0) > refCap.mtl + 1e-6);
      };
      let rounds = 0;
      let stations = 0;
      while (heavy(out)) {
        if ((out.hyroxRounds ?? 0) > hyroxMinRounds(out)) {
          out = withHyroxRounds(out, (out.hyroxRounds ?? 0) - 1);
          rounds++;
          continue;
        }
        const st = (out.hyroxComponents ?? []).filter(c => c.type !== 'run');
        if (st.length <= MIN_CIRCUIT_STATIONS) break;
        const next = withoutHyroxStation(out, hyroxStationToCut(out) as HyroxStation);
        if (next === out) break;
        out = next;
        stations++;
      }
      const parts = [...(rounds > 0 ? [`${rounds} round(s) cut`] : []), ...(stations > 0 ? [`${stations} station(s) taken out`] : [])];
      if (parts.length > 0) adjustments.push(`W${weekIndex}: ${parts.join(' and ')} of the ${out.n} (${ceilingName}: no longer or heavier than the reference week's)`);
      if (heavy(out)) {
        // At its floors and still longer or heavier (its stations differ
        // from the reference session's): the reference week's own session
        // of that type, at no more rounds than this one. With none of that
        // type, the lightest of its class (sessionCapClass: a circuit or a
        // brick), the counterpart the caps already read (sessionCapFor).
        // Before (round 7 review, 2026-10-14), a type the reference week did
        // not hold stayed as it was: novice 4 h 10 weeks, W4 held a Station
        // Density of 28 min and 142 MTL against W3's technique circuit of 37
        // min and 67 MTL.
        // The taper repeats a brick of the same type only (its downgraded
        // mini brick never becomes the reference week's full brick).
        const refs = inputs.sessionRefs ?? [];
        const sameType = refs.filter(r => r.t === out.t);
        const pool = sameType.length > 0 || !inputs.capSessionLoad ? sameType : refs.filter(r => sessionCapClass(r.t) === sessionCapClass(out.t));
        const pick = pool.reduce<Workout | undefined>((m, r) => (!m || (r.musculoTendonLoad ?? 0) < (m.musculoTendonLoad ?? 0) ? r : m), undefined);
        if (pick) {
          const was = out.n;
          const { id: _id, dayOfWeek: _dow, dayName: _day, ...copy } = pick;
          // At this week's own beginner loads, never the heavier loads the
          // reference week's session held (Tristan 2026-10-20: a deload
          // after a load step copied the stepped load).
          // Without the reference session's finisher: this week's spare
          // minutes size its own (lane H2b part 2).
          out = withHyroxFinisher(withHyroxStationLoads(
            withHyroxRounds(copy as Workout, Math.min(pick.hyroxRounds ?? 0, out.hyroxRounds ?? 0)),
            inputs.stationLoads, loadTier, bodyWeightKg,
          ), 0, hx.stationAccess, weekIndex, bodyWeightKg);
          adjustments.push(sameType.length > 0
            ? `W${weekIndex}: ${out.n} repeats the reference week's at ${out.hyroxRounds} rounds (${ceilingName}: no longer or heavier than the reference week's)`
            : `W${weekIndex}: ${was} becomes the reference week's ${out.n} at ${out.hyroxRounds} rounds (${ceilingName}: no longer or heavier than the reference week's)`);
        }
      }
    }
    return out;
  };

  // Station target times: the forecast's per-station benchmarks as one
  // athlete's time over the full station distance at the target's weights
  // (hyroxPlanningStationBenchmarks), the values the Stats Benchmarks ledger
  // shows. The sessions load stations at the target's tier (loadTier), so a
  // Pro race split is prescribed as its Open equivalent to an Open target,
  // the forecast's own Open/Pro conversion. A doubles race split
  // (the pair's time) is read through the same station ratio the forecast
  // applies, for every target: a singles athlete whose times came from
  // doubles race splits trains to those times, not to population seeds, and
  // a doubles athlete is never prescribed the pair's time as a solo target.
  const stationBenchmarks = inputs.stationBenchmarks ?? hyroxPlanningStationBenchmarks(state);

  // The strength block opening the week's station session `i` (lane H2b part
  // 2; sheet: every station session opens with a strength block; strength
  // .sessions counts it, HYROX_STRENGTH_SESSIONS). Content from gym.ts by
  // band and phase (hyroxStrengthContent), HYROX_STRENGTH_BLOCK_MIN long. The
  // week before race week holds one light block (the first station
  // session's; heavy lifting stops 7 days out, sheet taper.content), race
  // week none (sheet: 0).
  const blockFor = (i: number): HyroxStrengthBlock | null => {
    if (raceWeek) return null;
    const light = kindPhase === 'taper';
    if (light && i > 0) return null;
    const c = hyroxStrengthContent(band, kindPhase, weekIndex + i, { minutes: HYROX_STRENGTH_BLOCK_MIN, light, deload: !!inputs.deload });
    return { name: c.name, lines: c.lines, min: HYROX_STRENGTH_BLOCK_MIN, rpe: c.rpe, ...(light ? { light: true } : {}), eccentric: c.eccentric };
  };
  // A brick opens with an easy jog warm-up (lane H2b part 2; its first leg a
  // run).
  const withBrickWarmup = (w: Workout, i: number): Workout => withHyroxSessionParts(w, { warmup: hyroxSessionWarmup(hx.stationAccess, i + weekIndex, bodyWeightKg, true) });

  // ── Station sessions and bricks share the non-running budget ──────────────
  // Week 1, first station slot is the assessment for everyone. Users with
  // existing benchmarks can skip/replace it like any other workout; taking it
  // again refreshes their numbers. Race week has no assessment: it passes
  // through every station, sleds included.
  const needsAssessment = weekIndex === 1 && !raceWeek && !inputs.noAssessment;
  const omit = new Set(inputs.omit ?? []);
  const guardNote = (what: string) => adjustments.push(`W${weekIndex}: ${what} left out (${ceilingName})`);
  // A full-sim week's race-pace station session runs in the technique format
  // (sheet sims.week_volume).
  const allKinds = stationKinds(tier, kindPhase, counts.stations)
    .map(k => (sim?.kind === 'full' && k === 'station_density' ? 'station_technique' : k));
  const sKinds = allKinds
    .filter((k, i) => !(omit.has('technique') && k === 'station_technique' && !(needsAssessment && i === 0)));
  if (sKinds.length < allKinds.length) guardNote('technique station session');
  // Race week: technique circuits without the eccentric-heavy and sled stations
  // (RACE_WEEK_EXCLUDED_STATIONS). Without enough of the remaining stations (no
  // erg access) race week has no station circuit and the slot is left out
  // (review 2026-10-08: running's taper never adds a run).
  const raceWeekCircuitOk = !raceWeek || raceWeekCircuitStations(hx.stationAccess).length >= MIN_CIRCUIT_STATIONS;
  const allBricks = brickKinds(tier, kindPhase, counts.bricks);
  const bKinds = allBricks.filter(b => !(b.light ? omit.has('light') : omit.has('brick')));
  if (bKinds.length < allBricks.length) guardNote(bKinds.length === 0 && allBricks.length === 1 && !allBricks[0].light ? 'brick' : 'brick or secondary brick');
  // The sim takes the (key) brick's slot; with none left (the guard, the
  // session count), the week holds no sim.
  const simSlot = sim ? bKinds.findIndex(b => !b.light) : -1;
  if (sim && simSlot < 0) sim = undefined;
  const nonRunSlots = sKinds.length + bKinds.length;
  const share = nonRunSlots > 0 ? nonRunBudget / nonRunSlots : 0;

  // A station or brick session, built once per week for the same inputs
  // (sessionMemo; its notes replayed): the week's size search and
  // feasibility checks rebuild the week many times with the same sessions.
  const memoized = (key: string, build: () => Workout): Workout => {
    const memo = inputs.sessionMemo;
    if (!memo) return build();
    const hit = memo.get(key);
    if (hit) {
      adjustments.push(...hit.notes);
      return hit.w;
    }
    const mark = adjustments.length;
    const w = build();
    memo.set(key, { w, notes: adjustments.slice(mark) });
    return w;
  };
  // The race-pace volume progression (lane H2b, Tristan 2026-10-12): the
  // dose steps from the technique volume toward the race-pace volume as the
  // week grows toward peak (inputs.doseFraction, the nominal ramp:
  // hyroxRacePaceSets), and down to fit the minutes the week's size gives the
  // session (its share at the week's size and scale, without the target's
  // 35-min floor), so it rides the acute:chronic guard and the ceilings that
  // size the week. Both read the week's size, never the chosen hours: a week
  // a fixed ceiling holds stays the same week at every chosen hours above it.
  const doseFraction = inputs.doseFraction ?? 1;
  const doseMinutes = share * scale;
  // A station session at its target, before the week's size fits the
  // race-pace dose: built once per week build for the same inputs, with each
  // round count it can be cut to (the size search rebuilds the week at many
  // sizes, and the dose's fit only picks one of a few round counts).
  const stationAt = (kind: 'station_technique' | 'station_density', i: number, targetMinutes: number): Workout => memoized(
    `G|${kind}|${targetMinutes}|${i}|${kind === 'station_density' ? hyroxRacePaceSets(doseFraction, isHyroxDoublesFormat(hx.format)) : 0}`,
    () => generateHyroxStation({
      kind,
      targetMinutes,
      band,
      stationAccess: hx.stationAccess,
      phase,
      slotIndex: i + weekIndex,
      bodyWeightKg,
      stationBenchmarks,
      raceWeek: !!raceWeek,
      loadTier,
      seed: state,
      doseFraction,
      weakest: inputs.weakestStation ?? undefined,
      stationLoads: inputs.stationLoads,
    }),
  );
  const roundsAt = (base: Workout, key: string, rounds: number): Workout => memoized(`${key}|r${rounds}`, () => withHyroxRounds(base, rounds));
  const makeStation = (kind: 'station_technique' | 'station_density', i: number): Workout => {
    const targetMinutes = clampDur(kind, share);
    const base = stationAt(kind, i, targetMinutes);
    let rounds = base.hyroxRounds ?? 1;
    if (kind === 'station_density') {
      // The race-pace sets step down to the minutes the week's size gives the
      // session (doseMinutes), never under the technique dose: the generator's
      // doseMinutes fit, read off the cached round counts.
      const floor = hyroxTechniqueSets(isHyroxDoublesFormat(hx.format));
      const key = `G|${kind}|${targetMinutes}|${i}`;
      while (rounds > floor && (roundsAt(base, key, rounds).estimatedDurationMin ?? 0) > doseMinutes + 1e-9) rounds--;
    }
    return memoized(`S|${kind}|${targetMinutes}|${i}|${omit.has('stations')}|${ceilingName}|${rounds}`, () => makeStationOf(kind, i, targetMinutes, rounds));
  };
  const makeStationOf = (kind: 'station_technique' | 'station_density', i: number, targetMinutes: number, rounds: number): Workout => {
    const base = stationAt(kind, i, targetMinutes);
    const w = rounds < (base.hyroxRounds ?? 1) ? roundsAt(base, `G|${kind}|${targetMinutes}|${i}`, rounds) : base;
    const maxRounds = inputs.maxCircuitRounds;
    // Lane H2b part 2: the warm-up and the strength block open the session
    // (sheet: every station session opens with a strength block), before
    // the reference week's caps read its length.
    let out = withHyroxSessionParts(w, { warmup: hyroxSessionWarmup(hx.stationAccess, i + weekIndex, bodyWeightKg), strength: blockFor(i) });
    if (maxRounds != null && (out.hyroxRounds ?? 0) > maxRounds) {
      adjustments.push(`W${weekIndex}: ${out.n} cut to ${maxRounds} rounds (the week before's)`);
      out = withHyroxRounds(out, maxRounds);
    }
    out = capToRef(out);
    if (omit.has('stations')) {
      // The ceiling's station cut: the heaviest stations leave first.
      let cut = 0;
      for (;;) {
        const st = (out.hyroxComponents ?? []).filter(c => c.type !== 'run');
        if (st.length <= MIN_CIRCUIT_STATIONS) break;
        const next = withoutHyroxStation(out, hyroxStationToCut(out) as HyroxStation);
        if (next === out) break;
        out = next;
        cut++;
      }
      if (cut > 0) adjustments.push(`W${weekIndex}: ${cut} station(s) taken out of the ${out.n} (${ceilingName})`);
    }
    return out;
  };

  const nonRun: Workout[] = [];
  for (let i = 0; i < sKinds.length; i++) {
    if (needsAssessment && i === 0) {
      // A beginner's assessment takes the week's loads: the sleds unloaded
      // (sheet: weeks 1 and 2), the carry, sandbag and ball at the schedule.
      nonRun.push(generateHyroxAssessment({ band, stationAccess: hx.stationAccess, bodyWeightKg, loadTier, seed: state, stationLoads: inputs.stationLoads }));
      continue;
    }
    if (!raceWeekCircuitOk) continue;
    nonRun.push(makeStation(sKinds[i], i));
  }
  for (let i = 0; i < bKinds.length; i++) {
    const { kind, light } = bKinds[i];
    if (sim && i === simSlot) {
      // The race simulation in the brick's slot: fixed at the race's length
      // (exempt from the brick cap, sheet), never cut by rounds.
      const sk = sim;
      nonRun.push(memoized(`SIM|${sk.kind}|${sk.halfIndex}`, () => generateHyroxSim({
        kind: sk.kind,
        halfIndex: sk.halfIndex,
        band,
        stationAccess: hx.stationAccess,
        slotIndex: weekIndex,
        bodyWeightKg,
        stationBenchmarks,
        loadTier,
        seed: state,
        runPaceSecKm: hx.hyroxRunPaceSecKm,
        stationLoads: inputs.stationLoads,
      })));
      continue;
    }
    const targetMinutes = clampDur(kind, share);
    // The secondary brick (advanced peak) is its own format (lane H2b):
    // 4 x 800 m easy into ergs, sleds or the farmers carry at technique
    // effort, `hyroxLight` (not a hard session).
    nonRun.push(memoized(`B|${kind}|${light}|${targetMinutes}|${i}|${ceilingName}`, () => capToRef(withBrickWarmup(generateHyroxBrick({
      kind,
      targetMinutes,
      band,
      stationAccess: hx.stationAccess,
      phase,
      slotIndex: i + weekIndex,
      bodyWeightKg,
      stationBenchmarks,
      loadTier,
      seed: state,
      runPaceSecKm: hx.hyroxRunPaceSecKm,
      stationLoads: inputs.stationLoads,
      secondary: light,
    }), i))));
  }
  // The standalone strength session (lane H2b part 2): beginner and
  // intermediate base weeks hold one beside the station session's block
  // (sheet sessions.weekly and strength.sessions), drawn from gym.ts by band
  // and phase at its phase length (runningStrengthPhaseMinutes: 45 min in
  // base), shrinking with the week's scale like the other budget-sized
  // sessions, never under the block length (HYROX_STRENGTH_BLOCK_MIN; the
  // running pool's exercise count follows the length). One session a day
  // keeps it off a run day (the sheet: at least 6 h from a run on the same
  // day; the plan cannot model hours).
  const strengthSlots = counts.strength ?? 0;
  if (strengthSlots > 0 && omit.has('strength')) guardNote('standalone strength session');
  const strengthMin = Math.max(HYROX_STRENGTH_BLOCK_MIN, Math.min(runningStrengthPhaseMinutes(kindPhase), Math.round(runningStrengthPhaseMinutes(kindPhase) * scale)));
  for (let i = 0; i < strengthSlots && !omit.has('strength'); i++) {
    const c = hyroxStrengthContent(band, kindPhase, weekIndex + 3 + i, { minutes: strengthMin, standalone: true, deload: !!inputs.deload });
    nonRun.push({
      t: 'gym',
      n: 'Strength',
      d: c.lines.join('\n'),
      r: c.rpe,
      rpe: c.rpe,
      estimatedDurationMin: strengthMin,
      ...(c.eccentric ? { hyroxEccentric: true } : {}),
    });
  }
  // Running inside station and brick sessions counts toward the running
  // share: the run components of every station and brick session (today the
  // brick runs; the technique circuit's closing easy run is not a component
  // yet, it sits in the station content lane H2b owns, so the share does not
  // see it until H2b makes it one). The sessions count as the injury gates
  // leave them (current and future weeks): a brick the gates drop holds no
  // running. Before (2026-10-14 merge review), a gated brick's run segments
  // still took the easy runs' share, and the share then differed with the
  // brick's station (an erg, or the farmer-carry fallback without ergs).
  const shareNonRun = weekIndex < (state.w ?? 1)
    ? nonRun
    : applyHyroxInjuryGates(nonRun, (state as any).injuryState as InjuryState | undefined);
  const brickRunMin = shareNonRun
    .filter(w => w.discipline === 'brick' || w.discipline === 'station')
    .reduce((sum, w) => sum + (w.hyroxComponents ?? [])
      .filter(c => c.type === 'run')
      .reduce((a, c) => a + ((c.durationSec ?? 0) * (w.hyroxRounds ?? 1)) / 60, 0), 0);

  // ── Runs: the long run, the quality run, then easy runs ───────────────────
  const runParams = { band, phase, bodyWeightKg, runPaceSecKm: hx.hyroxRunPaceSecKm, thresholdPaceSecKm, maxHR: state.maxHR, seed: state };
  const runs: Workout[] = [];
  // The running share left after the bricks' run segments: what the easy
  // runs get after the long run and the quality run (the hierarchy's
  // allocation step "running up to 0.40 x the chosen weekly minutes"); the
  // ceilings' scale shrinks it. A taper week's long run follows the taper
  // rule and is not trimmed here.
  const fitRoom = Math.max(0, runBudget - brickRunMin);
  let slots = counts.runs;
  const ceilingMin = inputs.runCeilingKm != null ? Math.floor((inputs.runCeilingKm * easyPace) / 60) : Infinity;

  // A race simulation takes run slots (sheet sims.week_volume): a full sim
  // the long run's (and the quality run drops), a half sim the quality
  // run's. The slots it takes are not free slots for easy erg work either
  // (simSlotsTaken).
  const simSlotsTaken = sim ? Math.min(slots, sim.kind === 'full' ? 2 : (slots >= 2 ? 1 : 0)) : 0;
  if (sim) {
    adjustments.push(`W${weekIndex}: ${sim.kind === 'full' ? 'Race Simulation in the brick and long-run slots; quality run left out' : 'Half Race Simulation in the brick slot; quality run left out'} (race simulation week)`);
    slots -= simSlotsTaken;
  }
  let longMin = inputs.longRunMin != null && slots >= 1 && sim?.kind !== 'full' ? Math.min(inputs.longRunMin, ceilingMin) : null;
  const trainingWeek = !raceWeek && kindPhase !== 'taper';
  const fmt = trainingWeek && !sim ? HYROX_QUALITY_FORMATS[tier][kindPhase as 'base' | 'build' | 'peak'] : null;
  // Training weeks: the tier format, beside the long run (2 or more run
  // slots). Taper week 1: the existing taper tempo, sized like the other
  // runs, beside the long run. Race week: the primer whenever the week holds
  // a run, fixed at HYROX_RACE_WEEK_PRIMER_MIN (10 min of tempo work), taking
  // an easy run's place on a tight budget (SCIENCE_LOG §CE update 4). The
  // 110% single-run ceiling still applies to it: in a 2-week plan, whose week
  // 1 is a taper week with a long run of 0.65 x the start, the primer is above
  // the ceiling and race week holds easy runs only (an open question). Before
  // (review 2026-10-12) race week copied its run count from a reference week
  // the guard or the running share had thinned, and the primer needed a
  // second run: 95 of 918 no-race-date plans and 594 of 2,268 race-date plans
  // had none, and the primer was sized from the run share (up to 24 min of
  // tempo work, the §CE bug).
  const deloadNoQuality = trainingWeek && fmt != null && inputs.maxQualityRuns === 0;
  const wantsQuality = (raceWeek ? slots >= 1 : slots >= 2)
    && (trainingWeek ? fmt != null : true) && !omit.has('quality') && !deloadNoQuality;
  if (slots >= 2 && trainingWeek && fmt != null && omit.has('quality')) guardNote('quality run');
  if (deloadNoQuality && slots >= 2) adjustments.push(`W${weekIndex}: quality run left out (deload: the last loaded week held none)`);
  if (trainingWeek && fmt != null && slots < 2) adjustments.push(`W${weekIndex}: quality run left out (${slots} run slot${slots === 1 ? '' : 's'}, the long run first)`);
  let quality: Workout | null = null;
  if (wantsQuality) {
    if (fmt) {
      quality = generateHyroxRun({ ...runParams, kind: fmt.kind, targetMinutes: 0, format: fmt, slotIndex: weekIndex });
    } else if (raceWeek) {
      quality = generateHyroxRun({ ...runParams, kind: 'run_tempo', targetMinutes: HYROX_RACE_WEEK_PRIMER_MIN, slotIndex: weekIndex });
    } else {
      // Taper week 1: the taper tempo, sized from the running share the long
      // run leaves (as the week's one other run: its easy runs take the
      // week's unspent minutes, below), then shortened (down to the primer's
      // size) until it is no longer than the week's long run and the
      // single-run ceiling. Before (review 2026-10-13) the long run was
      // stretched to the tempo's distance, so a taper long run came out above
      // TAPER_LONG_RUN_FRACTION. Before round 5 the tempo shared the running
      // share with the easy runs, so a taper week inheriting one more easy
      // run from its reference week held a tempo of 25 min where it had held
      // 43, with the chosen sessions full (intermediate 14 weeks, 10 h against
      // 11 h: taper week 1 held 18 min less at the higher hours).
      const room = fitRoom * scale - (longMin ?? 0);
      const sized = Math.max(HYROX_RUN_FLOOR_MIN, Math.min(HYROX_SESSION_MAX_MIN.run_tempo, Math.round(room)));
      const maxKm = Math.min(
        longMin != null ? (longMin * 60) / easyPace : Infinity,
        inputs.runCeilingKm ?? Infinity,
      );
      for (let t = Math.max(sized, HYROX_RACE_WEEK_PRIMER_MIN); t >= HYROX_RACE_WEEK_PRIMER_MIN && !quality; t--) {
        const q = generateHyroxRun({ ...runParams, kind: 'run_tempo', targetMinutes: t, slotIndex: weekIndex });
        if (hyroxRunLengthKm(q) <= maxKm + 1e-9) quality = q;
      }
      if (!quality) adjustments.push(`W${weekIndex}: Tempo Run longer than the long run or the 110% single-run ceiling at its shortest, run easy`);
    }
  }
  const qMin = () => quality?.estimatedDurationMin ?? 0;

  // No run above the single-run ceiling (a hard rule), and no other run
  // longer than the long run (both by distance; Frandsen 2025 measured
  // distance, and the long run's minutes at easy pace stand in for it). In a
  // training week the long run and the quality run are the first allocation
  // (the constraint hierarchy, buildHyroxTrainingWeeks): the running share
  // does not size them, only the easy runs after them, and the week's size
  // (the ceilings) is what takes the long run's growth for the quality run
  // (D3) and then the quality run. A quality run longer than the long run
  // (the 8 x 1 km session against a 70-min long run) stretches the long run
  // to its distance when the tier cap and the ceiling allow, and in week 1
  // never above the long-run start (review 2026-10-13: a no-history
  // beginner's 3-week plan opened with a 39-min long run against the 30-min
  // start); otherwise the quality run takes its easy sibling. Taper weeks
  // never stretch the long run (their tempo is sized to it above). Before
  // round 6 (2026-10-13) the running share sized both: the long run gave up
  // its growth and the quality run left the week whenever 0.40 of the chosen
  // hours could not hold them, whatever room the week had.
  const longWanted = longMin;
  if (quality && inputs.runCeilingKm != null && hyroxRunLengthKm(quality) > inputs.runCeilingKm + 1e-9) {
    adjustments.push(`W${weekIndex}: ${quality.n} above the 110% single-run ceiling, run easy`);
    quality = null;
  }
  // The hard-session limits (at most HYROX_MAX_HARD_SESSIONS hard sessions
  // and HYROX_MAX_HARD_RUNS hard runs; a deload at most the last loaded
  // week's hard sessions): a quality run over them takes an easy run's slot
  // here, before the runs are sized, rather than turning into an easy run of
  // its own length after the week is built (demoteOne, below, which the
  // allocation order and the ceilings' scale never reached: round 7, novice
  // 4 h 10 weeks W4, a deload, kept a 40-min easy run from its tempo while a
  // ceiling cut the long run from 45 to 43 min). The station and brick
  // sessions count as the injury gates leave them.
  if (quality && trainingWeek) {
    const gatedNonRun = weekIndex < (state.w ?? 1) ? nonRun : applyHyroxInjuryGates(nonRun, (state as any).injuryState as InjuryState | undefined);
    const maxHard = Math.min(HYROX_MAX_HARD_SESSIONS, inputs.maxHardSessions ?? Infinity);
    if (gatedNonRun.filter(isHyroxHardSession).length + 1 > maxHard || gatedNonRun.filter(isHardRun).length + 1 > HYROX_MAX_HARD_RUNS) {
      adjustments.push(`W${weekIndex}: ${quality.n} run easy (at most ${maxHard} hard session${maxHard === 1 ? '' : 's'}${inputs.maxHardSessions != null ? ', the last loaded week\'s' : ''})`);
      quality = null;
    }
  }
  let longFit = longMin;
  if (quality && longFit != null) {
    const qKm = hyroxRunLengthKm(quality);
    const longKm = (longFit * 60) / easyPace;
    if (qKm > longKm + 1e-9) {
      const stretched = Math.ceil((qKm * easyPace) / 60);
      const startCap = weekIndex === 1 && inputs.longRunMin != null ? inputs.longRunMin : Infinity;
      const stretchCap = Math.min(HYROX_LONG_RUN[tier].capMin, ceilingMin, startCap);
      if (trainingWeek && !inputs.longFixed && stretched <= stretchCap) {
        longFit = stretched;
      } else {
        adjustments.push(`W${weekIndex}: ${quality.n} longer than the long run, run easy`);
        quality = null;
      }
    }
  }
  longMin = quality ? longFit : longWanted;
  // No training-week long run under the run floor (review 2026-10-13: a
  // 50-TSS logged load held long runs to 4 to 17 min): one a ceiling sizes
  // under it is left out.
  const runFloor = inputs.runFloorMin ?? HYROX_RUN_FLOOR_MIN;
  if (trainingWeek && longMin != null && longMin < runFloor) {
    if (longMin > 0) adjustments.push(`W${weekIndex}: Long Run left out (${longMin} min, under the ${runFloor}-min run floor)`);
    longMin = null;
  }
  if (longMin != null && longMin <= 0) longMin = null;

  let longRun: Workout | null = null;
  if (longMin != null) {
    longRun = generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: longMin, longRun: true, slotIndex: weekIndex });
    slots--;
  }
  if (quality) {
    runs.push(quality);
    slots--;
  }
  // Deloads (round 7, Tristan 2026-10-14): the easy run ranks above the
  // mini brick. When the running share at the chosen hours funds the easy
  // run's hold (easyHoldMin) only without the mini brick's run segments, the
  // mini brick leaves (never as the week's last station session or brick, as
  // the injury gates leave the week) and the easy run holds the run floor.
  // Before, beginner-tier deloads kept the circuit, the mini brick and the
  // long run and left the easy run out (open question 8 of round 6).
  let miniRunFreed = 0;
  if (inputs.easyHoldMin != null && slots > 0 && !omit.has('easy')) {
    const holdBase = Math.max(0, (inputs.easyHoldRunBudgetMin ?? runBudget) - brickRunMin) - (longMin ?? 0) - qMin();
    const minis = nonRun.filter(w => w.t === 'hyrox_mini_brick');
    if (holdBase < inputs.easyHoldMin && minis.length > 0) {
      const gatedRest = weekIndex < (state.w ?? 1)
        ? nonRun.filter(w => w.t !== 'hyrox_mini_brick')
        : applyHyroxInjuryGates(nonRun.filter(w => w.t !== 'hyrox_mini_brick'), (state as any).injuryState as InjuryState | undefined);
      const miniRun = runningOf(minis);
      if (gatedRest.some(isHyroxWork) && Math.max(0, (inputs.easyHoldRunBudgetMin ?? runBudget) - brickRunMin + miniRun) - (longMin ?? 0) - qMin() >= inputs.easyHoldMin) {
        for (const m of minis) nonRun.splice(nonRun.indexOf(m), 1);
        miniRunFreed = miniRun;
        adjustments.push(`W${weekIndex}: ${minis.map(m => m.n).join(' and ')} left out (deload: the easy run ranks above it)`);
      }
    }
  }
  const runRoom = Math.max(0, Math.max(0, runBudget - brickRunMin + miniRunFreed) * scale - (longMin ?? 0) - qMin());
  const easyScaled = inputs.easyRunCapMin != null ? Math.min(runRoom, Math.max(0, inputs.easyRunCapMin)) : runRoom;
  // A deload's easy runs hold the run floor under the scale when the
  // running share at full size funds it (easyHoldMin).
  const holdRoom = Math.max(0, (inputs.easyHoldRunBudgetMin ?? runBudget) - brickRunMin + miniRunFreed) - (longMin ?? 0) - qMin();
  const easyRoom = inputs.easyHoldMin != null && holdRoom >= inputs.easyHoldMin
    ? Math.max(easyScaled, inputs.easyHoldMin)
    : easyScaled;
  // What holds the easy runs: the week's ceiling when its scale or its size
  // shrinks them, otherwise the running share.
  const easyWhy = scale < 1 || inputs.ceilingSized ? ceilingName : 'running share';
  // Easy runs share what is left, each at most the long run (race week, which
  // holds none: the week before's long run; easyMaxMin) and the ceiling, and
  // at least HYROX_RUN_FLOOR_MIN; a share below the floor is merged into
  // fewer runs. Taper weeks and race week keep the run count (Bosquet et al.
  // 2007: no benefit from cutting frequency; the existing race-week rule) and
  // never fall below the floor. Taper week 1's easy runs may use the week's
  // unspent minutes beyond the running share; race week's take what the
  // running share leaves after the primer, so the primer stays the one quality
  // touch and a shorter circuit does not lengthen them.
  // A full-sim week holds no long run: its easy runs are no longer than the
  // long run the week would have held (no other run longer than the long
  // run, sheet long_run.cap).
  const easyCapMin = Math.min(longMin ?? (raceWeek ? inputs.easyMaxMin ?? Infinity
    : sim?.kind === 'full' ? (inputs.longRunMin ?? HYROX_LONG_RUN[tier].capMin) : Infinity), ceilingMin);
  // Run slots the running share leaves unfunded in a training week (lane
  // H2b part 2): they stay run slots, so no easy erg session stands in them
  // (easyErgFor). Before, a 75-min easy erg session took the slot at one
  // chosen hour and a 40-min easy run at the next, and the smaller weeks
  // carried into the deload, the guard and the taper (Q1).
  let shareUnfunded = 0;
  const keepRunCount = kindPhase === 'taper';
  if (omit.has('easy') && !keepRunCount && slots > 0) { guardNote(`${slots} easy run(s)`); slots = 0; }
  if (keepRunCount && slots > 0) {
    const nonRunMin = nonRun.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
    const weekRoom = inputs.budgetMin * scale - nonRunMin - (longMin ?? 0) - qMin();
    // Taper week 1: never more running than the week before; the count is
    // the slots, rounded down only when the floor would lift the week's
    // running above it (running's rule, SCIENCE_LOG §CV.4), never for a short
    // run share alone. Race week keeps the peak structure's runs up to the
    // reference week's run count (maxRuns, D6: the primer takes one of
    // them), and its total stays under the week before's (the taper never
    // rises, buildHyroxTrainingWeeks).
    const runCapRoom = raceWeek ? Infinity : (inputs.prevRunMin ?? Infinity) - (longMin ?? 0) - qMin();
    const room = Math.min(raceWeek ? runRoom : Math.max(runRoom, weekRoom), runCapRoom);
    let n = slots;
    if (runCapRoom < n * HYROX_RUN_FLOOR_MIN) n = Math.max(0, Math.floor(runCapRoom / HYROX_RUN_FLOOR_MIN));
    // Race week's easy runs keep the size the structure's run slots give
    // them: when the reference week's run count holds race week to fewer runs
    // (D6), the running they leave goes to easy erg work, not into longer runs
    // (race week holds no long run). Before, one easy run took it all (66 min
    // in an intermediate 8 h race week).
    const shareSlots = raceWeek ? Math.max(n, structureRuns - (quality ? 1 : 0)) : n;
    const each = n > 0 ? Math.floor(Math.min(easyCapMin, Math.max(HYROX_RUN_FLOOR_MIN, room / shareSlots))) : 0;
    // Race week holds a run whenever it holds a run slot (review 2026-10-13:
    // at a logged load of 30 TSS or less, 25 to 30 race weeks held nothing,
    // the primer above the 110% single-run ceiling and the easy runs under
    // the run floor beside a taper long run trimmed under it). With no primer
    // and easy runs sized under the floor, one easy run at the run floor
    // stays, the single-run ceiling allowing.
    const floorFallback = raceWeek && !quality && n > 0 && each < HYROX_RUN_FLOOR_MIN
      ? Math.min(HYROX_RUN_FLOOR_MIN, ceilingMin)
      : 0;
    if (each >= HYROX_RUN_FLOOR_MIN) {
      for (let i = 0; i < n; i++) {
        runs.push(generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: each, slotIndex: i + weekIndex }));
      }
    } else if (floorFallback >= runFloor) {
      runs.push(generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: Math.floor(floorFallback), slotIndex: weekIndex }));
      adjustments.push(`W${weekIndex}: 1 easy run of ${Math.floor(floorFallback)} min (race week holds a run: the run floor, above the week before's ${Math.floor(inputs.easyMaxMin ?? easyCapMin)}-min long run)`);
      if (n > 1) adjustments.push(`W${weekIndex}: ${n - 1} easy run(s) left out (no longer than the ${Math.floor(easyCapMin)}-min long run, under the ${HYROX_RUN_FLOOR_MIN}-min run floor)`);
    } else if (n > 0) {
      // No easy run under the floor: the taper's long run (race week: the
      // week before's) caps them below it.
      adjustments.push(`W${weekIndex}: ${n} easy run(s) left out (no longer than the ${Math.floor(easyCapMin)}-min long run, under the ${HYROX_RUN_FLOOR_MIN}-min run floor)`);
    }
    if (n < slots) adjustments.push(`W${weekIndex}: ${slots - n} easy run(s) left out (the taper never rises)`);
  } else if (slots > 0 && easyRoom >= HYROX_RUN_FLOOR_MIN) {
    let n = slots;
    let each = easyRoom / n;
    if (each < HYROX_RUN_FLOOR_MIN) {
      n = Math.max(1, Math.floor(easyRoom / HYROX_RUN_FLOOR_MIN));
      each = easyRoom / n;
    }
    // Whole minutes: the share's spare minute goes to the first runs rather
    // than being floored off each (lane H2b part 2: flooring each of two easy
    // runs let the effort lever's longer long run cost the week a minute).
    const total = Math.floor(Math.min(easyRoom, n * easyCapMin));
    each = Math.floor(Math.min(each, easyCapMin));
    if (each >= HYROX_RUN_FLOOR_MIN) {
      const extra = Math.max(0, Math.min(n - 1, total - each * n));
      for (let i = 0; i < n; i++) {
        const m = i < extra && each + 1 <= easyCapMin ? each + 1 : each;
        runs.push(generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: m, slotIndex: i + weekIndex }));
      }
    } else {
      n = 0;
    }
    if (n < slots) adjustments.push(`W${weekIndex}: ${slots - n} easy run(s) left out (${easyWhy})`);
    if (n < slots && easyWhy === 'running share') shareUnfunded = slots - n;
  } else if (slots > 0) {
    adjustments.push(`W${weekIndex}: ${slots} easy run(s) left out (${easyWhy})`);
    if (easyWhy === 'running share') shareUnfunded = slots;
  }
  if (longRun) runs.unshift(longRun);

  const workouts: Workout[] = [...runs, ...nonRun];

  // Add commute runs. Appended on top of prescribed HYROX sessions (model
  // revised 2026-05-20). Bidirectional commutes emit two slots per day
  // (morning + evening) at one-way distance. Marked with `discipline: 'run'`
  // so the scheduler treats them like other run sessions, and
  // `commute: true` so matching can prefer commute actuals.
  if (commuteDays > 0 && state.commuteConfig) {
    const oneWayKm = state.commuteConfig.distanceKm;
    const bi = state.commuteConfig.isBidirectional;
    // Duration at the generator's own easy pace, as generateHyroxRun prices an
    // easy run. Without it Mark as Done recorded no load and the planned-day
    // pricer fell back to 60 minutes (estimateTriWorkoutMin).
    const commuteMin = Math.round((oneWayKm * easyPace) / 60);
    const commute = (n: string): Workout => ({
      t: 'easy', n, d: `${oneWayKm}km`, rpe: 3, r: 3, discipline: 'run', commute: true, estimatedDurationMin: commuteMin,
    });
    for (let i = 0; i < commuteDays; i++) {
      if (bi) {
        workouts.push(commute(`Commute ${i + 1} (morning)`));
        workouts.push(commute(`Commute ${i + 1} (evening)`));
      } else {
        workouts.push(commute(`Commute ${i + 1}`));
      }
    }
  }

  // Injury-mode discipline gating. Runs are gated by canRun; stations and
  // bricks are gated by canUpperLoad / canLowerLoad (HYROX stations mix
  // upper-body load. Wall ball, sandbag, carries, burpee. With lower-body
  // load. Sled, lunges. So if either side is blocked the whole station is
  // dropped at this coarse level). Per-component station gating is future
  // work.
  // Past weeks are skipped: a current injury cannot retroactively rewrite
  // a week the user has already trained through. main.ts's version-bump
  // regen calls this for every week 1..tw, so without this guard past
  // triWorkouts get rewritten with current-injury gate downmixes.
  const injuryState = (state as any).injuryState as InjuryState | undefined;
  const isPastWeek = weekIndex < (state.w ?? 1);
  const weeksFromCurrent = Math.max(0, weekIndex - (state.w ?? 1));
  const gated = isPastWeek
    ? workouts
    : applyHyroxInjuryGates(workouts, injuryState, weeksFromCurrent);
  // What the injury gates took (minutes and sessions): easy erg work never
  // fills it. Replacing gated training is the capability substitution's
  // offer, which the athlete accepts (buildCapabilityOffers), not an
  // automatic refill.
  const injuryFreedMin = hyroxPlannedMinutes(workouts) - hyroxPlannedMinutes(gated);
  const injuryFreedSlots = prescribed(workouts).length - prescribed(gated).length;

  // Enforce the MTL cap: easy running first, then station rounds and
  // stations; the long run and the quality run are never cut (enforceMTLCap).
  let week = enforceMTLCap(gated, hx.mtlCap, adjustments, weekIndex, {
    remake: (w, minutes) => ({
      ...generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: minutes, longRun: isHyroxLongRun(w), slotIndex: weekIndex }),
      ...(w.modReason ? { modReason: w.modReason } : {}),
    }),
    easyFloorMin: HYROX_RUN_FLOOR_MIN,
    keepRunCount,
  });

  // Hard-session limits: at most HYROX_MAX_HARD_RUNS hard runs and
  // HYROX_MAX_HARD_SESSIONS hard sessions (the structure holds both; a slider
  // or gate change that breaks them turns a hard session into its easy sibling).
  const toEasy = (w: Workout): Workout => {
    const easyMin = Math.max(HYROX_RUN_FLOOR_MIN, Math.min(w.estimatedDurationMin ?? HYROX_RUN_FLOOR_MIN, easyCapMin));
    return generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: easyMin, slotIndex: weekIndex });
  };
  const toTechnique = (w: Workout): Workout => makeStation('station_technique', 1 + week.indexOf(w));
  const demoteOne = (): boolean => {
    const q = week.find(w => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals');
    if (q) { week = week.map(w => (w === q ? toEasy(w) : w)); adjustments.push(`W${weekIndex}: ${q.n} run easy`); return true; }
    const d = week.find(w => w.t === 'hyrox_station_density');
    if (d) { week = week.map(w => (w === d ? toTechnique(w) : w)); adjustments.push(`W${weekIndex}: race-pace station session in technique format`); return true; }
    return false;
  };
  const maxHard = Math.min(HYROX_MAX_HARD_SESSIONS, inputs.maxHardSessions ?? Infinity);
  while (week.filter(isHardRun).length > HYROX_MAX_HARD_RUNS || week.filter(isHyroxHardSession).length > maxHard) {
    if (!demoteOne()) break;
  }

  // Easy erg work (D1, Tristan 2026-10-13; parameter sheet
  // split.running_share: hours left unprescribed go to easy erg work, not to
  // more running). What the week's sessions leave of its volume target
  // (fillMin, the phase budget) becomes easy SkiErg or row work: first more
  // sessions, up to the athlete's chosen weekly total (maxSessions: the run
  // slots the running share could not fund and the slots the phase structure
  // leaves empty), then longer ones. Each session at least HYROX_RUN_FLOOR_MIN
  // and at most the tier's long-run cap (HYROX_LONG_RUN capMin: no easy
  // session longer than the tier's longest easy session; a reused bound, a
  // product choice), in a taper week at most the taper's long run
  // (easyMaxMin, so race week holds no long easy session either). The
  // ceilings take it away first (ergCapMin), and it fits
  // in the MTL the week leaves under the cap, so it never costs a station
  // round. Neither hard nor eccentric, so the spacing rules never move it.
  // Without erg access the minutes stay unprescribed. The withdrawn draft of
  // 2026-10-13 sized it only for unfunded run slots, so a larger budget that
  // funded the runs held less volume.
  const easyErgFor = (ws: readonly Workout[], capLeft?: number): Workout[] => {
    // What the ceilings leave of the easy erg minutes once the finishers took
    // theirs (fillSpare).
    const ergCap = capLeft ?? inputs.ergCapMin ?? Infinity;
    // The run slots a race simulation takes are not free (simSlotsTaken).
    const maxSessions = Math.min(inputs.maxSessions ?? 7, 7) - simSlotsTaken;
    const sessionsName = inputs.maxSessionsName ?? `${maxSessions} sessions`;
    // Free slots: the structure's (a slot the phase leaves empty, one the
    // guard or the session count frees) and the run slots the running share
    // leaves unfunded (part 2). Easy erg work stands in an unfunded run slot
    // only at the shortest easy session (HYROX_RUN_FLOOR_MIN), so the easy run
    // one more hour funds there (at least the run floor) is never shorter
    // than what it replaces: before, a 75-min easy erg session took the slot
    // at one chosen hour and a 40-min easy run at the next, and the smaller
    // weeks carried into the deload, the guard and the taper (Q1).
    const freeAll = maxSessions - prescribed(ws).length - injuryFreedSlots;
    const runSlots = Math.max(0, Math.min(shareUnfunded, freeAll));
    const structSlots = Math.max(0, freeAll - runSlots);
    const unused = (inputs.fillMin ?? inputs.budgetMin) - hyroxPlannedMinutes(ws) - injuryFreedMin;
    if (unused < HYROX_RUN_FLOOR_MIN) return [];
    if (freeAll <= 0) {
      // The session count binds: the athlete's chosen total is never exceeded
      // (D1), so what is left stays unprescribed, and the week says so.
      adjustments.push(`W${weekIndex}: ${Math.round(unused)} min left unprescribed (${sessionsName} are full)`);
      return [];
    }
    const mtlPerMin = hyroxEasyErgMtlPerMin(hx.stationAccess, bodyWeightKg);
    if (mtlPerMin == null) {
      adjustments.push(`W${weekIndex}: ${Math.round(unused)} min left unprescribed (no erg access for easy erg work)`);
      return [];
    }
    const mtlRoom = hx.mtlCap - ws.reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
    const byMtl = mtlPerMin > 0 ? Math.max(0, mtlRoom) / mtlPerMin : Infinity;
    const total = Math.min(unused, ergCap, byMtl);
    const maxEach = Math.min(HYROX_LONG_RUN[tier].capMin, inputs.easyMaxMin ?? Infinity);
    // The structure's free slots first, each up to maxEach; then the unfunded
    // run slots at the shortest easy session.
    const k1 = maxEach >= HYROX_RUN_FLOOR_MIN ? Math.min(structSlots, Math.floor(total / HYROX_RUN_FLOOR_MIN)) : 0;
    const each = k1 > 0 ? Math.floor(Math.min(maxEach, total / k1)) : 0;
    const runEach = HYROX_RUN_FLOOR_MIN;
    const k2 = maxEach >= runEach ? Math.min(runSlots, Math.floor((total - k1 * each) / runEach)) : 0;
    const k = k1 + k2;
    if (k <= 0) {
      const why = byMtl < Math.min(unused, ergCap) ? `MTL cap ${hx.mtlCap}` : ceilingName;
      adjustments.push(`W${weekIndex}: ${Math.round(unused)} min left unprescribed (${why})`);
      return [];
    }
    const ergs: Workout[] = [];
    for (let i = 0; i < k; i++) {
      const e = generateHyroxEasyErg({ targetMinutes: i < k1 ? each : runEach, stationAccess: hx.stationAccess, slotIndex: weekIndex + i, bodyWeightKg });
      if (e) ergs.push(e);
    }
    // The injury gates scale easy erg work with the station capacity, or
    // drop it; the notes name what the week holds.
    const kept = isPastWeek ? ergs : applyHyroxInjuryGates(ergs, injuryState, weeksFromCurrent);
    if (kept.length === 0) {
      adjustments.push(`W${weekIndex}: ${Math.round(unused)} min left unprescribed (injury: no easy erg work at the current station capacity)`);
      return [];
    }
    const keptEach = kept[0].estimatedDurationMin ?? (k1 > 0 ? each : runEach);
    const held = total < unused - 1e-6 ? ` (${byMtl < Math.min(unused, ergCap) ? `MTL cap ${hx.mtlCap}` : ceilingName} holds it)` : '';
    const lengths = kept.map(e => e.estimatedDurationMin ?? 0);
    const same = lengths.every(x => x === lengths[0]);
    adjustments.push(same
      ? `W${weekIndex}: ${kept.length} easy erg session${kept.length === 1 ? '' : 's'} of ${keptEach} min (unprescribed minutes)${held}`
      : `W${weekIndex}: ${kept.length} easy erg sessions of ${lengths.join(', ')} min (unprescribed minutes)${held}`);
    // Every slot taken and each session at its longest: the rest of the
    // budget stays unprescribed.
    const left = Math.round(total - k1 * each - k2 * runEach);
    if (!held && left >= HYROX_RUN_FLOOR_MIN) {
      adjustments.push(runSlots > 0
        ? `W${weekIndex}: ${left} min left unprescribed (${sessionsName} are full; the running share leaves ${runSlots} run slot${runSlots === 1 ? '' : 's'} unfunded, easy erg work holds ${runEach} min of each)`
        : `W${weekIndex}: ${left} min left unprescribed (${sessionsName} are full, an easy erg session at most ${maxEach} min)`);
    }
    if (keptEach < each) adjustments.push(`W${weekIndex}: easy erg sessions cut to ${keptEach} min (injury: station capacity)`);
    return kept;
  };


  // Lane H2b part 2 (Tristan's direction: fill the chosen hours): the station
  // sessions' easy erg finishers take the week's spare minutes first, each
  // session up to the session cap, the tier long-run cap (HYROX_LONG_RUN
  // capMin, 60 / 75 / 90 min: the tier's longest easy session, the bound easy
  // erg sessions already take), in a deload or taper week also no longer than
  // its counterpart in the reference week (sessionCaps). So spare hours
  // lengthen the week's sessions instead of creating easy erg sessions that
  // compete with runs for a slot. The finishers share the minutes evenly
  // (water-filling), each at least HYROX_FINISHER_MIN_MIN; they fit in the
  // MTL the week leaves under the cap and the ceilings' erg cap (ergCapMin),
  // as easy erg work does. Without erg access, or with an active injury (the
  // injury gates and the capability offers decide that week), none.
  const sessionCapMin = HYROX_LONG_RUN[tier].capMin;
  const finisherRoomOf = (w: Workout): number => {
    if (!(w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density') || !w.hyroxSpec) return 0;
    const ref = sessionCapFor(inputs.sessionCaps, w.t);
    const cap = Math.min(sessionCapMin, ref?.min ?? Infinity);
    const own = (w.estimatedDurationMin ?? 0) - (w.hyroxSpec.finisher?.min ?? 0);
    let room = cap - own;
    // A deload or taper session is no heavier than its counterpart either
    // (capSessionLoad): the finisher's MTL fits under the reference's.
    if (ref) {
      const perMin = hyroxEasyErgMtlPerMin(hx.stationAccess, bodyWeightKg) ?? 0;
      const ownMtl = (w.musculoTendonLoad ?? 0) - (w.hyroxSpec.finisher?.mtl ?? 0);
      if (perMin > 0) room = Math.min(room, (ref.mtl - ownMtl) / perMin);
    }
    return Math.max(0, Math.floor(room + 1e-9));
  };
  const finishersAllowed = (): boolean => !(!isPastWeek && injuryState?.active) && hyroxEasyErgMtlPerMin(hx.stationAccess, bodyWeightKg) != null;
  const fillFinishers = (ws: readonly Workout[]): { ws: Workout[]; used: number } => {
    const out = [...ws];
    if (!finishersAllowed()) return { ws: out, used: 0 };
    const mtlPerMin = hyroxEasyErgMtlPerMin(hx.stationAccess, bodyWeightKg) as number;
    const unused = (inputs.fillMin ?? inputs.budgetMin) - hyroxPlannedMinutes(ws) - injuryFreedMin;
    const mtlRoom = hx.mtlCap - ws.reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
    const byMtl = mtlPerMin > 0 ? Math.max(0, mtlRoom) / mtlPerMin : Infinity;
    const total = Math.floor(Math.min(unused, inputs.ergCapMin ?? Infinity, byMtl));
    if (total < HYROX_FINISHER_MIN_MIN) return { ws: out, used: 0 };
    let pool = out.map((w, idx) => ({ idx, room: finisherRoomOf(w) }))
      .filter(c => c.room >= HYROX_FINISHER_MIN_MIN)
      .sort((a, b) => a.room - b.room);
    // Fewer sessions when the minutes cannot give each the shortest finisher.
    while (pool.length > 1 && total < pool.length * HYROX_FINISHER_MIN_MIN) pool = pool.slice(1);
    let remaining = total;
    let used = 0;
    const parts: string[] = [];
    pool.forEach((c, k) => {
      const give = Math.min(c.room, Math.floor(remaining / (pool.length - k)));
      if (give < HYROX_FINISHER_MIN_MIN) return;
      out[c.idx] = withHyroxFinisher(out[c.idx], give, hx.stationAccess, weekIndex + c.idx, bodyWeightKg);
      remaining -= give;
      used += give;
      parts.push(`${give}-min easy erg finisher on the ${out[c.idx].n}`);
    });
    if (parts.length > 0) adjustments.push(`W${weekIndex}: ${parts.join(', ')} (spare minutes)`);
    return { ws: out, used };
  };
  // The week's spare minutes: the finishers first, then easy erg sessions in
  // the free slots for what the finishers cannot hold (easyErgFor).
  const fillSpare = (ws: readonly Workout[]): { ws: Workout[]; ergs: Workout[] } => {
    const f = fillFinishers(ws);
    const capLeft = inputs.ergCapMin != null ? Math.max(0, inputs.ergCapMin - f.used) : undefined;
    return { ws: f.ws, ergs: easyErgFor(f.ws, capLeft) };
  };

  // Easy erg work absorbs the hours the session count or the MTL cap leaves
  // (decision C, Tristan 2026-10-13; round 7, Tristan 2026-10-14): when the
  // chosen sessions are full, or the MTL cap holds the easy erg work the free
  // slots could take, a training week can give one easy run's slot (or its
  // MTL) to easy erg work. The options, each the week without its shortest
  // easy run:
  //   - the easy runs left take its minutes (each no longer than the long run,
  //     the 110% single-run ceiling or the tier long-run cap);
  //   - nothing takes its minutes, so its MTL goes to easy erg work (less MTL
  //     a minute) when the MTL cap is what holds the week.
  // The schedule step (below) keeps the option whose week then holds the most
  // minutes with its easy erg work, and the week as it is when none holds
  // more. One slot a week, never the long run, the quality run or the easy
  // run standing in a missing quality run's slot, and never with an active
  // injury: the injury gates and the capability substitution's offers decide
  // that week (round 6; review 2026-10-13: with stations gated and runs open,
  // 138 of 630 training weeks lost an easy run, the injured athlete's only
  // gate-safe training, for an erg session the gates then dropped). Round 6
  // took the slot only when the easy runs left kept every running minute
  // (easy running ranking above easy erg work), so one more hour that funded
  // an easy run could take the slot, or the MTL room, a longer easy erg
  // session held: with the 7-session choice, at a logged 200 TSS and with a
  // logged 25-min run, 4, 10 and 2 adjacent-hour pairs of 972 fell by more
  // than one easy session in total plan minutes (novice 24 weeks with a
  // logged 25-min run, 6 to 7 h, W21: two 37-min easy runs in place of a
  // 50-min easy run and a 75-min easy erg session). Round 7 lets easy erg
  // work take the slot whenever the week then holds more minutes: lower
  // impact, and it fills the chosen hours. Before (review 2026-10-13), one
  // more hour funded another short run that took the easy erg's slot, so the
  // week held less: intermediate 23 weeks at 7 h held 36 to 51 min less a
  // week than at 6 h through build and peak. A product choice: no source
  // ranks an easy run against easy erg work when the session count binds.
  // Two bounds (2026-10-14, after round 7):
  //   - the week's running (standalone runs and the run segments of its
  //     station and brick sessions, runningOf) stays at or above the D2
  //     running share, HYROX_RUN_SHARE x the chosen weekly minutes: an
  //     option that takes it under leaves the easy run in place. Round 7's
  //     swap took competitive 12 h to 0.21 of the chosen hours as running in
  //     the median training week (0.28 before);
  //   - never in a deload: a deload ranks the easy run above the mini brick
  //     and the secondary brick (round 7), and the swap traded a deload's
  //     25-min easy run for a 52-min easy erg session while its 60-min
  //     secondary brick stayed (competitive 12 and 20 h, 19 weeks, W16).
  const runShareFloorMin = HYROX_RUN_SHARE * (hx.weeklyHoursAvailable ?? 0) * 60;
  const ergSlotOptions = (ws: Workout[]): Array<{ ws: Workout[]; note: string }> => {
    if (!trainingWeek) return [];
    if (inputs.deload) return [];
    if (!isPastWeek && injuryState?.active) return [];
    // The run slots a race simulation takes are not free (simSlotsTaken).
    const maxSessions = Math.min(inputs.maxSessions ?? 7, 7) - simSlotsTaken;
    const mtlPerMin = hyroxEasyErgMtlPerMin(hx.stationAccess, bodyWeightKg);
    if (mtlPerMin == null) return [];
    const maxEach = Math.min(HYROX_LONG_RUN[tier].capMin, inputs.easyMaxMin ?? Infinity);
    // What easy erg work can hold beside a week (its free slots, each at its
    // longest, the ceilings' erg cap and the MTL the week leaves under the
    // cap).
    const mtlRoomOf = (x: readonly Workout[]) => hx.mtlCap - x.reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
    const byMtlOf = (x: readonly Workout[]) => (mtlPerMin > 0 ? Math.max(0, mtlRoomOf(x)) / mtlPerMin : Infinity);
    const unusedOf = (x: readonly Workout[]) => (inputs.fillMin ?? inputs.budgetMin) - hyroxPlannedMinutes(x) - injuryFreedMin;
    // Free slots whose easy erg sessions already hold what the week leaves:
    // no slot or MTL to free. (Round 6: with one slot free and its session
    // at the cap, one more hour funded a third 22-min easy run in the slot a
    // 63-min easy erg session held.)
    const free = maxSessions - prescribed(ws).length - injuryFreedSlots;
    const unusedNow = unusedOf(ws);
    // The finishers hold spare minutes too (lane H2b part 2): a week whose
    // finishers and free slots hold what it leaves has no slot to free.
    const finisherRoom = finishersAllowed() ? ws.reduce((a, w) => a + finisherRoomOf(w), 0) : 0;
    const holdsNow = Math.min(finisherRoom + (free > 0 ? free * maxEach : 0), inputs.ergCapMin ?? Infinity, byMtlOf(ws));
    if (unusedNow - holdsNow < HYROX_RUN_FLOOR_MIN) return [];
    // What one easy erg session could hold beside a week.
    const ergRoom = (x: readonly Workout[]): number => Math.floor(Math.min(unusedOf(x), inputs.ergCapMin ?? Infinity, byMtlOf(x), maxEach));
    // A week whose tier format calls for a quality run and that holds none
    // (the running share, a ceiling or the spacing left it out) keeps one
    // easy run in its slot, the longest: the slot the quality run takes when
    // one more hour funds it. Easy erg work never takes it, so the quality
    // run's arrival does not shorten the week (monotonicity, reported).
    const holdsQuality = ws.some(w => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals');
    const standIn = fmt != null && structureRuns >= 2 && !holdsQuality ? 1 : 0;
    const all = ws.filter(isPlainEasyRun).sort((a, b) => (a.estimatedDurationMin ?? 0) - (b.estimatedDurationMin ?? 0));
    const candidates = all.slice(0, Math.max(0, all.length - standIn));
    if (candidates.length === 0) return [];
    const out = candidates[0];
    const rest = all.filter(w => w !== out);
    const easyMin = all.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
    // What holds the easy erg work now: the MTL cap when it holds less than
    // the free slots could, otherwise the session count.
    const why = free > 0 && byMtlOf(ws) < Math.min(free * maxEach, inputs.ergCapMin ?? Infinity) ? `MTL cap ${hx.mtlCap}` : 'the chosen sessions are full';
    const options: Array<{ ws: Workout[]; note: string }> = [];
    // With an easy run standing in a missing quality run's slot, no easy run
    // grows past the quality run's length: when one more hour funds it, it
    // takes that slot without shortening the week.
    const qualityMin = standIn && fmt
      ? (generateHyroxRun({ ...runParams, kind: fmt.kind, targetMinutes: 0, format: fmt, slotIndex: weekIndex }).estimatedDurationMin ?? Infinity)
      : Infinity;
    const each = rest.length > 0 ? Math.floor(Math.min(easyCapMin, HYROX_LONG_RUN[tier].capMin, qualityMin, easyMin / rest.length)) : 0;
    if (rest.some(w => (w.estimatedDurationMin ?? 0) < each)) {
      // The easy runs left take its minutes.
      const resized = new Map(rest.map(w => [w, (w.estimatedDurationMin ?? 0) >= each ? w : {
        ...generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: each, slotIndex: weekIndex }),
        ...(w.modReason ? { modReason: w.modReason } : {}),
      }] as const));
      const next = ws.filter(w => w !== out).map(w => resized.get(w) ?? w);
      const room = ergRoom(next);
      if (room >= HYROX_RUN_FLOOR_MIN && runningOf(next) >= runShareFloorMin - 1e-6) {
        const kept = next.filter(isPlainEasyRun).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
        options.push({ ws: next, note: `W${weekIndex}: Easy Run of ${out.estimatedDurationMin} min left out for an easy erg session of up to ${room} min, ${kept} of the ${easyMin} easy-run min kept by ${rest.length} easy run${rest.length === 1 ? '' : 's'} (${why})` });
      }
    }
    // Nothing takes its minutes: its slot and MTL go to easy erg work.
    const next = ws.filter(w => w !== out);
    const room = ergRoom(next);
    if (room >= HYROX_RUN_FLOOR_MIN && runningOf(next) >= runShareFloorMin - 1e-6) {
      options.push({ ws: next, note: `W${weekIndex}: Easy Run of ${out.estimatedDurationMin} min left out for an easy erg session of up to ${room} min (${why})` });
    }
    return options;
  };

  // Schedule. Race week: each session only on the days the race-day rules
  // allow; one that finds no free allowed day is left out (raceWeekDays).
  // Other weeks: the hard-day and 48 h rules always hold; when no placement
  // keeps them, a hard session takes its easy sibling, then the
  // lowest-priority session leaves the week.
  let scheduled: Workout[];
  const placed = raceWeek?.layout ? { ...raceWeek, layout: raceWeek.layout } : null;
  if (raceWeek) {
    const raceFill = fillSpare(week);
    week = raceFill.ws;
    const raceErgs = raceFill.ergs;
    const scheduleRaceWeek = (ws: Workout[]) => {
      const dropped: Workout[] = [];
      const out = scheduleHyroxWeek(
        ws, band,
        placed ? (w) => raceWeekDays(placed, weekIndex, w) : undefined,
        { prevSunday: inputs.prevSunday, dropped },
      );
      return { out, dropped };
    };
    let rw = scheduleRaceWeek([...week, ...raceErgs]);
    // Race week keeps its station work (round 7 decision 4, completed
    // 2026-10-14). A Thursday race week runs Monday to Wednesday, 3, 2 and 1
    // days out: its one day PRIMER_MIN_DAYS_OUT or more days out is the
    // primer's (raceWeekPrimerDow) and the circuit's only day, so the circuit
    // was left out and race week held no station work (every Thursday race in
    // the round 7 review). When the circuit finds no day and the week holds no
    // other station work, the circuit takes the day and the primer is left
    // out: the race-day rules drop a primer with no day (race-day-rules.ts,
    // rule 2), and the last two days stay easy runs. A race week whose only
    // run was the primer keeps a run: an easy run at the run floor (the
    // single-run ceiling allowing), as race week holds a run whenever it
    // holds a run slot. The race week before the fix kept the primer and no
    // station work.
    const primer = week.find(w => w.t === 'hyrox_run_tempo');
    if (primer && rw.dropped.some(isHyroxWork) && !rw.out.some(isHyroxWork)) {
      const altWs = week.filter(w => w !== primer);
      let standIn: Workout | null = null;
      if (!altWs.some(w => w.discipline === 'run' && w.commute !== true)) {
        const m = Math.floor(Math.min(HYROX_RUN_FLOOR_MIN, ceilingMin));
        if (m >= runFloor) standIn = generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: m, slotIndex: weekIndex });
      }
      const alt = scheduleRaceWeek([...altWs, ...(standIn ? [standIn] : []), ...raceErgs]);
      const work = alt.out.find(isHyroxWork);
      if (work) {
        rw = alt;
        adjustments.push(`W${weekIndex}: ${primer.n} left out (its day, race week's one day ${PRIMER_MIN_DAYS_OUT} or more days out, holds the ${work.n}: race week keeps its station work)`);
        if (standIn && alt.out.some(w => w.discipline === 'run' && w.commute !== true)) adjustments.push(`W${weekIndex}: 1 easy run of ${standIn.estimatedDurationMin} min holds the primer's run slot`);
      }
    }
    scheduled = rw.out;
    for (const d of rw.dropped) adjustments.push(`W${weekIndex}: ${d.n} left out (no race-week day the race-day rules allow)`);
  } else {
    const heldWork = hasHyroxWork(week);
    let found = findHyroxWeekSchedule(week, { prevSunday: inputs.prevSunday });
    while (!found) {
      if (!demoteOne()) {
        // The week's last station session or brick leaves last.
        const hyroxCount = week.filter(x => x.discipline === 'station' || x.discipline === 'brick').length;
        const dropOrder = (w: Workout): number =>
          w.commute ? -1
            : (w.discipline === 'station' || w.discipline === 'brick') && hyroxCount === 1 ? 5
              : w.t === 'hyrox_run_easy' && !isHyroxLongRun(w) ? 0
                : isHyroxStrengthSession(w) ? 0.5
                : w.t === 'hyrox_station_technique' ? 1
                  : w.hyroxLight ? 2
                    : isHyroxLongRun(w) ? 3
                      : 4;
        const candidates = week.filter(w => dropOrder(w) >= 0).sort((a, b) => dropOrder(a) - dropOrder(b));
        if (candidates.length === 0) break;
        week = week.filter(w => w !== candidates[0]);
        adjustments.push(`W${weekIndex}: ${candidates[0].n} left out (spacing rules)`);
      }
      found = findHyroxWeekSchedule(week, { prevSunday: inputs.prevSunday });
    }
    scheduled = found ?? [];
    // Easy erg work takes the days left free: it is neither hard nor
    // eccentric, so a week that placed without it places with it (at most 7
    // sessions, maxSessions).
    // A week whose last station session or brick the spacing rules took
    // holds no easy erg in its place.
    const ergOk = !!found && (!heldWork || hasHyroxWork(week));
    if (ergOk) {
      // A merged or left-out easy run frees a slot (ergSlotFor); the week is
      // placed again with the easy erg work. Leaving out or merging an easy
      // run never breaks the spacing rules, so it places; if it did not, the
      // week keeps its runs and holds no easy erg work.
      // A freed slot is taken only when the week then holds more minutes
      // with its easy erg work than without the swap; otherwise the easy run
      // stays and the swap's notes go.
      const mark = adjustments.length;
      const total = (ws: readonly Workout[], es: readonly Workout[]) => hyroxPlannedMinutes(ws) + hyroxPlannedMinutes(es);
      // The finishers first, then easy erg work (fillSpare).
      const f0 = fillSpare(week);
      let freed = f0.ws;
      let ergs = f0.ergs;
      let notes = adjustments.slice(mark);
      adjustments.length = mark;
      let best = total(freed, ergs);
      for (const o of ergSlotOptions(week)) {
        const fo = fillSpare(o.ws);
        const ns = [o.note, ...adjustments.slice(mark)];
        adjustments.length = mark;
        if (fo.ergs.length > 0 && total(fo.ws, fo.ergs) > best + 1e-6) {
          freed = fo.ws;
          ergs = fo.ergs;
          notes = ns;
          best = total(fo.ws, fo.ergs);
        }
      }
      adjustments.push(...notes);
      if (ergs.length > 0 || freed !== week) {
        const again = findHyroxWeekSchedule([...freed, ...ergs], { prevSunday: inputs.prevSunday });
        if (again) {
          week = freed;
          scheduled = again;
        } else {
          // A finisher changes no session's spacing flags, so the week with
          // its finishers places as it did; the easy erg sessions leave.
          adjustments.length = mark;
          const f = fillFinishers(week);
          const placed = findHyroxWeekSchedule(f.ws, { prevSunday: inputs.prevSunday });
          if (placed) {
            week = f.ws;
            scheduled = placed;
          }
          if (ergs.length > 0) adjustments.push(`W${weekIndex}: ${ergs.reduce((a, e) => a + (e.estimatedDurationMin ?? 0), 0)} min of easy erg work left out (no day the spacing rules leave free)`);
        }
      }
    }
  }

  // Generator check (not a sourced cap): eccentric sessions a week against
  // what the structure produces (HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK).
  const structPhase = phase === 'taper' || raceWeek ? 'peak' : phase;
  const eccentric = prescribed(scheduled).filter(isEccentricSession).length;
  const eccentricCheck = HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK[tier][structPhase];
  if (eccentric > eccentricCheck) {
    adjustments.push(`W${weekIndex}: generator check, ${eccentric} eccentric sessions against ${eccentricCheck}`);
    console.warn(`[hyrox plan] generator check: week ${weekIndex} holds ${eccentric} eccentric sessions (structure produces ${eccentricCheck})`);
  }

  // Stable per-slot ids (W{week}-{type}-{idx}), the triathlon engine's helper.
  // Every HYROX writer keys by `id ?? n` (Mark as Done, quick done, the matcher's
  // station and run branches, the status chip). Without ids a week's two
  // 'Easy Run' or two 'Station Circuit' sessions shared one slot key: one done
  // showed both done, and a second synced run found no free slot.
  stampTriWorkoutIds(scheduled, weekIndex);
  return scheduled;
}

/**
 * Apply per-discipline capacity scaling to a HYROX week. The slider model
 * (0–100 per discipline) replaces the prior 3-tier enum:
 * - Run capacity 0 drops all run workouts (including commute runs); 100
 *   leaves them; in-between scales each run's duration linearly.
 * - Station capacity = MIN(upperLoad, lowerLoad) since HYROX stations are
 *   mixed-modality (any restriction on either side limits the whole
 *   station). 0 drops stations + assessment, 100 leaves them, in-between
 *   scales duration linearly.
 * - Brick = stations + runs stacked → dropped whenever either input
 *   capacity is below 100 (any restriction risks aggravation under
 *   stacked-intensity).
 *
 * Intensity is intentionally NOT capped. The slider is volume-only; the
 * user self-regulates RPE in the moment.
 *
 * `weeksFromCurrent` retained for API compatibility; slider is the
 * gradient so no separate ramp-window logic.
 */
function applyHyroxInjuryGates(
  workouts: Workout[],
  injuryState: InjuryState | undefined,
  _weeksFromCurrent: number = 0
): Workout[] {
  if (!injuryState?.active) return workouts;

  const isRun = (w: Workout): boolean => {
    const t = (w.t || '') as string;
    if (t.startsWith('hyrox_run_')) return true;
    if (t === 'easy' && (w as any).commute === true) return true;
    return false;
  };
  // Easy erg work loads the upper and lower body like a station (the SkiErg
  // and the row erg are HYROX stations), so the station capacity gates it.
  const isStation = (w: Workout): boolean => {
    const t = (w.t || '') as string;
    return t.startsWith('hyrox_station_') || t === 'hyrox_assessment' || isHyroxEasyErg(w);
  };
  // A race simulation stacks runs and stations as a brick does (lane H2b
  // part 2).
  const isBrick = (w: Workout): boolean => {
    const t = (w.t || '') as string;
    return t === 'hyrox_brick' || t === 'hyrox_mini_brick' || t === 'hyrox_sim';
  };

  const runCap   = getDisciplineCapacity(injuryState, 'run');
  const upperCap = getDisciplineCapacity(injuryState, 'upperLoad');
  const lowerCap = getDisciplineCapacity(injuryState, 'lowerLoad');
  // Stations mix both halves. The more restrictive side wins.
  const stationCap = Math.min(upperCap, lowerCap);
  // Brick stacks stations + runs; ANY restriction drops it.
  const brickSafe = runCap >= 100 && stationCap >= 100;

  const scaleWorkout = (w: Workout, cap: number, label: string): Workout => {
    const factor = cap / 100;
    const a = w as any;
    const scaled: any = {
      ...w,
      modReason: `Capacity ${cap}% — ${label} duration scaled to match your reported ability`,
    };
    if (typeof a.estimatedDurationMin === 'number') {
      scaled.estimatedDurationMin = Math.max(1, Math.round(a.estimatedDurationMin * factor));
    }
    if (typeof a.aerobic === 'number')   scaled.aerobic   = Math.round(a.aerobic   * factor);
    if (typeof a.anaerobic === 'number') scaled.anaerobic = Math.round(a.anaerobic * factor);
    if (typeof a.musculoTendonLoad === 'number') {
      scaled.musculoTendonLoad = Math.round(a.musculoTendonLoad * factor);
    }
    return scaled as Workout;
  };

  // Strength (lane H2b part 2): the injury's strength decision, as gym.ts
  // takes it (injury-strength.ts): 'none' pauses loaded strength, 'adapted'
  // swaps a standalone session for the region-safe one; a station session's
  // block leaves under either (the adapted session is the strength work).
  const strengthKind = injuryStrengthDecision(injuryState);
  const out: Workout[] = [];
  for (const w0 of workouts) {
    if (isHyroxStrengthSession(w0)) {
      if (strengthKind.kind === 'none') continue;
      if (strengthKind.kind === 'adapted') {
        out.push({ ...strengthKind.workout, estimatedDurationMin: w0.estimatedDurationMin, modReason: 'Injury: strength adapted to the injured region' });
        continue;
      }
      out.push(w0);
      continue;
    }
    const w = strengthKind.kind !== 'normal' && w0.hyroxSpec?.strength ? withHyroxSessionParts(w0, { strength: null }) : w0;
    if (isRun(w)) {
      if (runCap <= 0) continue;
      if (runCap >= 100) { out.push(w); continue; }
      out.push(scaleWorkout(w, runCap, 'run'));
      continue;
    }
    if (isStation(w)) {
      if (stationCap <= 0) continue;
      if (stationCap >= 100) { out.push(w); continue; }
      out.push(scaleWorkout(w, stationCap, 'stations'));
      continue;
    }
    if (isBrick(w)) {
      if (!brickSafe) continue;
      out.push(w);
      continue;
    }
    out.push(w);
  }
  return out;
}

// ─── Plan builder (weeks in order) ───────────────────────────────────────────

/** One built training week and what later weeks read from it. */
export interface HyroxWeekDetail {
  week: number;
  phase: HyroxPhase;
  deload: boolean;
  raceWeek: boolean;
  /** Minute budget the week was built with: the phase budget at the week's
   *  size, which is the chosen hours unless the acute:chronic guard or the
   *  deload ceiling builds the week smaller (taper weeks: the taper budget). */
  budgetMin: number;
  /** Planned minutes and canonical TSS of the prescribed sessions. */
  plannedMin: number;
  plannedTss: number;
  /** ACWR_SAFE_HIGH × the chronic planned load (null: a taper week, or week 1
   *  without a logged weekly load). */
  acwrCapTss: number | null;
  /** Planned TSS the guard does not count (canonical TSS): week 1's
   *  assessment, a fixed calibration pass, when week 1 is guarded (a logged
   *  weekly load); 0 otherwise. plannedTss - guardExemptTss <= acwrCapTss. */
  guardExemptTss: number;
  /** What the guard's chronic window counts each week before week 1 as
   *  (canonical TSS, D4): the larger of the athlete's logged weekly load
   *  (signalBBaseline) as stored when the plan was created
   *  (hyroxConfig.planChronicSeed) and the nominal week 1 (guardFloorTss);
   *  with no logged load, the nominal week 1. The same on every week. */
  chronicSeedTss: number;
  chronicSeedSource: 'logged' | 'nominal';
  /** The guard's floor (canonical TSS): the nominal week 1, the plan's own
   *  first week as it builds without the guard (a station session in the
   *  assessment's slot). No week's guard sits under it (round 7). The same on
   *  every week. */
  guardFloorTss: number;
  /** Deload weeks: HYROX_DELOAD_FACTOR × the last loaded week's planned
   *  minutes and TSS (null: not a deload week, or no loaded week before it). */
  deloadCapMin: number | null;
  deloadCapTss: number | null;
  /** The long run prescribed (minutes), or null. */
  longRunMin: number | null;
  /** Longest standalone run (km). */
  longestRunKm: number;
  /** Changes the rules forced on the week (dropped or demoted sessions). */
  adjustments: string[];
  workouts: Workout[];
  /** Set when a loaded training week cannot reach its size because the
   *  athlete's chosen session count binds (HyroxHoursFit); unset otherwise. */
  hoursFit?: HyroxHoursFit;
}

/**
 * A loaded training week (not a deload, the taper or race week) whose phase
 * budget is the chosen weekly hours, that holds the athlete's chosen session
 * count, stays HYROX_RUN_FLOOR_MIN or more under the chosen hours with no
 * ceiling sizing or scaling it, no MTL cap and no injury holding it, and that
 * one more chosen session would lift by HYROX_RUN_FLOOR_MIN or more (at the
 * 7-session maximum: room under the guard and the MTL cap for one more easy
 * session at the run floor). The HYROX plan view states it in one line (round
 * 6, item 7): "Your 5 sessions fit about 6 h of your 8 h." Weeks short of the
 * chosen hours by design (the phase budget, a deload, the taper) carry none;
 * with peak at the full hours (HYROX_PEAK_MULT) that leaves peak weeks.
 */
export interface HyroxHoursFit {
  /** Prescribed sessions the week holds (commute runs excluded). */
  sessions: number;
  /** The week's planned minutes (commute runs excluded). */
  plannedMin: number;
  /** The athlete's chosen weekly hours. */
  chosenHours: number;
}

/**
 * One training week of a HYROX plan with the race-day rules applied (mirror of
 * the triathlon triWeekForRace). `trainingWeeks` excludes a closing week, so
 * race week is week `trainingWeeks`.
 *   - Rule 1: nothing on or after race day (shared with running).
 *   - Race week (rules 2 and 4): no brick (the race is the week's brick), the
 *     tempo primer on running's primer day (3 to 5 days out), technique
 *     circuits without the eccentric-heavy or sled stations at least 3 days
 *     out, easy runs only in the last 2 days and on the latest free days
 *     (raceWeekDays). The run the day before the race is at most
 *     HYROX_DAY_BEFORE_RACE_MAX_RUN_MIN (taper.content).
 *   - Rules 3 and 4: in the week before race week, nothing in the last 6 days
 *     before race day; its full brick moves to 7 or more days out, never next
 *     to another hard session (clearStoredPlanRaceWindow), and its long run
 *     to the latest free day 7 or more days out (moveLongRunOutOfRaceWindow),
 *     as running's long run does.
 */
function hyroxWeekForRace(
  state: SimulatorState, weekIndex: number, trainingWeeks: number,
  phase: HyroxPhase, layout: RaceWeekLayout | null, inputs: HyroxWeekInputs, adjustments: string[],
): Workout[] {
  const firstDow = inputs.firstDow ?? firstTrackedDow(state.planStartDate, weekIndex, state.planCreatedAt);
  const raceWeek = isRaceWeek(weekIndex, trainingWeeks, state.continuousMode) ? { layout, firstDow } : undefined;
  // Sessions the race-day rules leave out are noted on the week (by slot id,
  // stamped in generateWeekSessions).
  const noteDropped = (before: readonly Workout[], after: readonly Workout[], why: string) => {
    if (after.length === before.length) return;
    const kept = new Set(after.map(w => w.id ?? w.n));
    for (const w of before) if (w.commute !== true && !kept.has(w.id ?? w.n)) adjustments.push(`W${weekIndex}: ${w.n} left out (${why})`);
  };
  const sessions = generateWeekSessions(state, weekIndex, phase, inputs, adjustments, raceWeek);
  let generated = dropSessionsOnOrAfterRaceDay(sessions, weekIndex, state.planStartDate, state.hyroxConfig?.raceDate);
  noteDropped(sessions, generated, 'on or after race day');
  if (!layout) return generated;
  if (raceWeek) {
    const dayBefore = layout.raceDayIndex - 1 - (weekIndex - 1) * 7;
    generated = generated.map(w => {
      if (w.dayOfWeek !== dayBefore || w.t !== 'hyrox_run_easy' || (w.estimatedDurationMin ?? 0) <= HYROX_DAY_BEFORE_RACE_MAX_RUN_MIN) return w;
      const hx = state.hyroxConfig!;
      const run = generateHyroxRun({
        kind: 'run_easy', targetMinutes: HYROX_DAY_BEFORE_RACE_MAX_RUN_MIN, band: hx.athleteBand, phase,
        slotIndex: weekIndex, bodyWeightKg: state.bodyWeightKg, runPaceSecKm: hx.hyroxRunPaceSecKm, seed: state,
      });
      return { ...run, id: w.id, dayOfWeek: w.dayOfWeek, dayName: w.dayName };
    });
  }
  const windowDropped: Workout[] = [];
  const cleared = clearStoredPlanRaceWindow(moveLongRunOutOfRaceWindow(generated, weekIndex, layout, firstDow), {
    weekIndex,
    layout,
    isLongSession: (w) => w.t === 'hyrox_brick',
    isHard: isHyroxHardSession,
    firstScheduleDow: firstDow,
    dayNames: HYROX_DAY_NAMES,
    onDrop: (w) => windowDropped.push(w),
  });
  // The tempo's easy sibling, for station work with no other day: an easy run
  // of its length, no longer than the week's long run.
  const easySibling = (q: Workout): Workout => {
    const hx = state.hyroxConfig!;
    const long = cleared.find(isHyroxLongRun)?.estimatedDurationMin ?? Infinity;
    return generateHyroxRun({
      kind: 'run_easy', targetMinutes: Math.max(HYROX_RUN_FLOOR_MIN, Math.min(q.estimatedDurationMin ?? HYROX_RUN_FLOOR_MIN, long)),
      band: hx.athleteBand, phase, slotIndex: weekIndex, bodyWeightKg: state.bodyWeightKg, runPaceSecKm: hx.hyroxRunPaceSecKm, seed: state,
    });
  };
  const windowed = placeWorkOutsideRaceWindow(cleared, windowDropped, weekIndex, layout, firstDow, inputs.prevSunday, adjustments, easySibling);
  noteDropped(generated, windowed, 'the last 6 days before race day');
  return windowed;
}

/**
 * The week before race week (a Thursday to Saturday race): a station session
 * or mini brick the race window dropped (clearStoredPlanRaceWindow: the last
 * RACE_DAY_CLEAR_DAYS days before race day carry race-week sessions only)
 * takes a free day at least RACE_DAY_CLEAR_DAYS + 1 days out, the latest
 * first, where the hard-day and 48 h eccentric rules hold (the previous
 * Sunday included), as the window rule moves a long session (running rule 3).
 * Before (round 7 review, 2026-10-14), it was dropped even with Monday to
 * Thursday free: 7 of 1,134 Thursday-race taper week 1s held no station
 * work (total_beginner 2 h 10 weeks: a long run alone). The full brick keeps
 * the window rule's own long-session move. Most important first (the
 * scheduler's priority order).
 */
function placeWorkOutsideRaceWindow(
  ws: Workout[], dropped: readonly Workout[], weekIndex: number, layout: RaceWeekLayout, firstDow: number,
  prevSunday: HyroxPrevSunday | null, adjustments: string[], easySibling?: (w: Workout) => Workout,
): Workout[] {
  const order = (w: Workout) => (w.t === 'hyrox_assessment' ? 0 : w.t === 'hyrox_mini_brick' && !w.hyroxLight ? 1 : w.t === 'hyrox_station_density' ? 2 : w.t === 'hyrox_station_technique' ? 3 : 4);
  const work = dropped.filter(w => isHyroxWork(w) && w.t !== 'hyrox_brick').sort((a, b) => order(a) - order(b));
  if (work.length === 0) return ws;
  const weekStart = (weekIndex - 1) * 7;
  const first = Math.max(0, Math.min(7, firstDow));
  const dayFor = (w: Workout, within: readonly Workout[]): number | null => {
    const hard = isHyroxHardSession(w);
    const ecc = isEccentricSession(w);
    for (let dow = 6; dow >= first; dow--) {
      if (layout.raceDayIndex - (weekStart + dow) <= RACE_DAY_CLEAR_DAYS) continue;
      if (within.some(x => x.commute !== true && x.dayOfWeek === dow)) continue;
      if (dow === 0 && prevSunday && ((hard && prevSunday.hard) || (ecc && prevSunday.eccentric))) continue;
      const near = within.filter(x => x.commute !== true && (x.dayOfWeek === dow - 1 || x.dayOfWeek === dow + 1));
      if (near.some(x => (hard && isHyroxHardSession(x)) || (ecc && isEccentricSession(x)))) continue;
      return dow;
    }
    return null;
  };
  const placeOn = (within: Workout[], w: Workout, day: number): Workout[] => {
    adjustments.push(`W${weekIndex}: ${w.n} moved to ${HYROX_DAY_NAMES[day]}, ${layout.raceDayIndex - (weekStart + day)} days out (the last ${RACE_DAY_CLEAR_DAYS} days before race day carry race-week sessions only)`);
    return [...within, { ...w, dayOfWeek: day, dayName: HYROX_DAY_NAMES[day] }].sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0));
  };
  let out = ws;
  const unplaced: Workout[] = [];
  for (const w of work) {
    const day = dayFor(w, out);
    if (day == null) { unplaced.push(w); continue; }
    out = placeOn(out, w, day);
  }
  // The week keeps its station work over the tempo (H2 integration review,
  // 2026-10-14; round 7 decision 4: no taper week loses all its station
  // work). When the week holds none and no day 7 or more days out is free
  // of a hard neighbour, the quality run takes its easy sibling on its own
  // day, and the station work takes a day beside it. Before, a Thursday race
  // whose week before held a Tuesday tempo and a Thursday long run left its
  // mini brick out: Monday and Wednesday sit next to the hard Tuesday (54 of
  // 25,200 race-dated plans on the review grid).
  if (unplaced.length > 0 && easySibling && !out.some(isHyroxWork)) {
    const q = out.find(x => x.t === 'hyrox_run_tempo' || x.t === 'hyrox_run_intervals');
    if (q) {
      const easy = { ...easySibling(q), id: q.id, dayOfWeek: q.dayOfWeek, dayName: q.dayName };
      const softened = out.map(x => (x === q ? easy : x));
      const w = unplaced[0];
      const day = dayFor(w, softened);
      if (day != null) {
        adjustments.push(`W${weekIndex}: ${q.n} run easy (the week keeps its station work: no other day 7 or more days out)`);
        out = placeOn(softened, w, day);
      }
    }
  }
  return out;
}

/**
 * The week before race week: a long run in the last RACE_DAY_CLEAR_DAYS days
 * before race day moves to the latest free day at least one day earlier
 * (running's rule 3: long sessions sit 7 or more days out), else to the day of
 * the latest easy run there, which leaves the week. The long run is neither a
 * hard nor an eccentric session, so the spacing rules hold. With no such day
 * the window rule drops it (clearStoredPlanRaceWindow). Moved here rather
 * than through clearStoredPlanRaceWindow's long-session move, which takes the
 * latest day not next to a hard session even when a brick sits on it.
 */
function moveLongRunOutOfRaceWindow(ws: Workout[], weekIndex: number, layout: RaceWeekLayout, firstDow: number): Workout[] {
  if (weekIndex >= layout.trainingWeeks) return ws;
  const weekStart = (weekIndex - 1) * 7;
  const daysOut = (dow: number) => layout.raceDayIndex - (weekStart + dow);
  const long = ws.find(isHyroxLongRun);
  if (!long || long.dayOfWeek == null) return ws;
  const d0 = daysOut(long.dayOfWeek);
  if (d0 < 1 || d0 > RACE_DAY_CLEAR_DAYS) return ws;
  const open = (dow: number) => daysOut(dow) > RACE_DAY_CLEAR_DAYS;
  const first = Math.max(0, Math.min(6, firstDow));
  const place = (dow: number, without?: Workout) => ws
    .filter(w => w !== without)
    .map(w => (w === long ? { ...w, dayOfWeek: dow, dayName: HYROX_DAY_NAMES[dow] } : w))
    .sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0));
  for (let dow = 6; dow >= first; dow--) {
    if (open(dow) && !ws.some(w => w !== long && w.commute !== true && w.dayOfWeek === dow)) return place(dow);
  }
  for (let dow = 6; dow >= first; dow--) {
    if (!open(dow)) continue;
    const easy = ws.find(w => w.dayOfWeek === dow && w.t === 'hyrox_run_easy' && !isHyroxLongRun(w));
    if (easy) return place(dow, easy);
  }
  return ws;
}

/** Longest standalone run of a week (km), commute runs excluded. */
function longestRunKm(ws: readonly Workout[]): number {
  let best = 0;
  for (const w of prescribed(ws)) {
    // A race simulation's running is checked as one run against the week's
    // ceiling (generateWeekSessions), but its 1 km legs between stations are
    // no continuous run, so it never raises a later week's ceiling (the
    // conservative reading of sheet sims.week_volume).
    if (w.discipline !== 'run') continue;
    best = Math.max(best, hyroxRunLengthKm(w));
  }
  return best;
}

/** Station and brick work: a station session (the assessment included) or a
 *  brick, the week's HYROX-specific work. Easy erg work is not: it is easy
 *  aerobic volume. */
function isHyroxWork(w: Workout): boolean {
  return (w.discipline === 'station' || w.discipline === 'brick') && !isHyroxEasyErg(w);
}

/** True when a week holds a station session or a brick (isHyroxWork). */
function hasHyroxWork(ws: readonly Workout[]): boolean {
  return prescribed(ws).some(isHyroxWork);
}

/** Session counts of a built week (commute runs excluded; the assessment
 *  counts as a station session; easy erg work counts in none of them, the
 *  week's session total caps it, maxSessions). */
function sessionCountsOf(ws: readonly Workout[]): HyroxSessionCounts {
  const p = prescribed(ws);
  return {
    runs: p.filter(w => w.discipline === 'run').length,
    stations: p.filter(w => w.discipline === 'station' && !isHyroxEasyErg(w)).length,
    bricks: p.filter(w => w.discipline === 'brick').length,
    strength: p.filter(isHyroxStrengthSession).length,
  };
}

/** Running minutes of a built week (standalone runs; commute runs excluded). */
function runMinutesOf(ws: readonly Workout[]): number {
  return prescribed(ws).filter(w => w.discipline === 'run').reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
}

/** Running of a built week as the running share counts it: standalone runs
 *  plus the run components of station and brick sessions (commute runs
 *  excluded). */
function runningOf(ws: readonly Workout[]): number {
  return prescribed(ws).reduce((a, w) => a + (w.discipline === 'run'
    ? (w.estimatedDurationMin ?? 0)
    : (w.hyroxComponents ?? []).filter(c => c.type === 'run').reduce((b, c) => b + ((c.durationSec ?? 0) * (w.hyroxRounds ?? 1)) / 60, 0)), 0);
}

/** Longest duration, most rounds, most stations and highest MTL per station
 *  and brick session type in a week, and per class ('circuit': technique or race pace;
 *  'brick': brick or mini brick). The deload's and the race taper's
 *  per-session caps (sessionCapFor). */
function sessionCapsOf(ws: readonly Workout[]): HyroxSessionCaps {
  const out: HyroxSessionCaps = {};
  const raise = (key: string, w: Workout) => {
    const cur = out[key];
    out[key] = {
      min: Math.max(cur?.min ?? 0, w.estimatedDurationMin ?? 0),
      rounds: Math.max(cur?.rounds ?? 0, w.hyroxRounds ?? 0),
      stations: Math.max(cur?.stations ?? 0, (w.hyroxComponents ?? []).filter(c => c.type !== 'run').length),
      mtl: Math.max(cur?.mtl ?? 0, w.musculoTendonLoad ?? 0),
    };
  };
  for (const w of prescribed(ws)) {
    if (!isHyroxWork(w)) continue;
    if (w.t === 'hyrox_assessment') continue;
    raise(w.t, w);
    raise(sessionCapClass(w.t), w);
  }
  return out;
}

/** Station and brick work of a week: minutes and MTL (the race taper holds
 *  no more of either than its reference week). Easy erg work is not station
 *  work, nor is a station session's easy erg finisher (lane H2b part 2: it
 *  is the week's spare minutes, ergMinOf). */
function stationWorkOf(ws: readonly Workout[]): { min: number; mtl: number } {
  let min = 0;
  let mtl = 0;
  for (const w of prescribed(ws)) {
    if (!isHyroxWork(w)) continue;
    min += (w.estimatedDurationMin ?? 0) - (w.hyroxSpec?.finisher?.min ?? 0);
    mtl += (w.musculoTendonLoad ?? 0) - (w.hyroxSpec?.finisher?.mtl ?? 0);
  }
  return { min, mtl };
}

/** Easy erg minutes of a week: its easy erg sessions and its station
 *  sessions' finishers (lane H2b part 2), the minutes the week's ceilings
 *  take away first. */
function ergMinOf(ws: readonly Workout[]): number {
  let min = 0;
  for (const w of prescribed(ws)) {
    if (isHyroxEasyErg(w)) min += w.estimatedDurationMin ?? 0;
    else min += w.hyroxSpec?.finisher?.min ?? 0;
  }
  return min;
}

/** Largest round count of a week's station circuits (technique or race pace). */
function circuitRoundsOf(ws: readonly Workout[]): number {
  return prescribed(ws)
    .filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density')
    .reduce((m, w) => Math.max(m, w.hyroxRounds ?? 0), 0);
}

/** Order a taper week sheds sessions in when it would rise above the week
 *  before or above its taper fraction: easy erg work, easy runs, the
 *  technique circuit, the secondary brick, the taper brick, then the long
 *  run; the tempo last. -1 = never: a commute run, and race week's primer
 *  (race week holds the primer whenever it holds a run, SCIENCE_LOG §CE
 *  update 4). Easy erg work leaves first because the taper keeps the run
 *  count (taper.content). A product order: no source ranks these sessions. */
function taperDropRank(w: Workout, raceWeek: boolean): number {
  if (w.commute) return -1;
  if (isHyroxEasyErg(w)) return 0;
  if (w.t === 'hyrox_run_easy' && !isHyroxLongRun(w)) return 1;
  if (w.t === 'hyrox_station_technique') return 2;
  if (w.hyroxLight) return 3;
  if (w.discipline === 'brick') return 4;
  if (isHyroxLongRun(w)) return 5;
  if (raceWeek && w.t === 'hyrox_run_tempo') return -1;
  return 6;
}

/** What the guard's chronic window counts each week before week 1 as (D4):
 *  the logged weekly load, or the nominal week 1. */
export type HyroxChronicSeed = NonNullable<HyroxConfig['planChronicSeed']>;

/**
 * The chronic seed a plan created now stores (D4): the athlete's logged
 * weekly load (signalBBaseline: the median completed week of raw
 * physiological TSS, all sports, canonical TSS) when there is one, otherwise
 * the nominal week 1. A missing, non-finite or zero value is no data (§BV).
 * Read once, when the plan is created: the live value is a rolling median
 * every sync refreshes, so it comes to hold the plan's own weeks (review
 * 2026-10-13: re-read at every rollover, it moved the remaining weeks by up
 * to half, unnoted).
 */
export function hyroxChronicSeedSnapshot(signalBBaseline: number | null | undefined): HyroxChronicSeed {
  return signalBBaseline != null && Number.isFinite(signalBBaseline) && signalBBaseline > 0
    ? { source: 'logged', loggedTss: signalBBaseline }
    : { source: 'nominal' };
}

/** The plan's chronic seed: the one stored when the plan was created, else
 *  (a plan built before 2026-10-13) the live baseline. */
function planChronicSeed(state: SimulatorState): HyroxChronicSeed {
  const stored = state.hyroxConfig?.planChronicSeed;
  if (stored?.source === 'nominal') return { source: 'nominal' };
  if (stored?.source === 'logged' && stored.loggedTss != null && Number.isFinite(stored.loggedTss) && stored.loggedTss > 0) {
    return { source: 'logged', loggedTss: stored.loggedTss };
  }
  return hyroxChronicSeedSnapshot(state.signalBBaseline);
}

/** Store the plan's chronic seed when it has none (a plan built before
 *  2026-10-13), from the live baseline, so later regenerations read a fixed
 *  value. The full rebuilds of the same plan (generator version, previous
 *  time, previous format) call it; a new plan (initializeHyroxSimulator)
 *  stores a fresh one. Returns true when it wrote. */
export function ensureHyroxChronicSeed(state: SimulatorState): boolean {
  const hx = state.hyroxConfig;
  if (!hx || hx.planChronicSeed) return false;
  hx.planChronicSeed = hyroxChronicSeedSnapshot(state.signalBBaseline);
  return true;
}

/**
 * The forecast's weakest station now (hyrox-weakest-link: the largest gain
 * the forecast's horizon model projects at the current training dose, the
 * forecast view's "Where to gain"), the station the race-pace session holds
 * first (sheet technique.station_session; the5krunner: one weekly session on
 * the weakest station). The same computation the forecast view shows. Null
 * without a projection (no race date, race day past) or on a partial state.
 * It reads today's date and the stored plan. Planning side.
 */
export function hyroxLiveWeakestStation(state: SimulatorState): HyroxStation | null {
  try {
    return topWeakestLinks(predictHyroxRace(state), 1)[0]?.station ?? null;
  } catch {
    return null;
  }
}

/** The weakest station a plan build reads: the one stored when the plan was
 *  last built in full or rebaked (hyroxConfig.planWeakestStation), so the
 *  rebuilds in between give the same plan; the live forecast when none is
 *  stored. */
export function hyroxPlanWeakestStation(state: SimulatorState): HyroxStation | null {
  const stored = state.hyroxConfig?.planWeakestStation;
  return stored !== undefined ? stored : hyroxLiveWeakestStation(state);
}

/** Store the forecast's weakest station now on the plan (a full build: the
 *  plan's creation, the version regeneration, a re-band, a rollover rebake).
 *  Returns true when it changed. */
export function refreshHyroxPlanWeakestStation(state: SimulatorState): boolean {
  const hx = state.hyroxConfig;
  if (!hx) return false;
  const next = hyroxLiveWeakestStation(state);
  if (hx.planWeakestStation === next) return false;
  hx.planWeakestStation = next;
  return true;
}

/**
 * A beginner's station loads for a stored plan week, for a session added to
 * it (the add-session modal): the load the week's station sessions prescribe
 * for each station they hold (the schedule and its RPE steps, as the plan
 * built them), else the schedule's anchor for the week. Undefined for the
 * intermediate and advanced tiers, who train at race weight.
 */
export function hyroxStoredWeekStationLoads(state: SimulatorState, weekIndex: number): Partial<Record<HyroxStation, number>> | undefined {
  const hx = state.hyroxConfig;
  if (!hx || hyroxTier(hx.athleteBand) !== 'beginner') return undefined;
  const totalWeeks = state.tw || 16;
  const layout = storedPlanRaceLayout(totalWeeks, state.planStartDate, hx.raceDate);
  const trainingWeeks = layout?.trainingWeeks ?? totalWeeks;
  const fullSimWeek = [...hyroxSimWeeks(state, trainingWeeks).entries()].find(([, v]) => v.kind === 'full')?.[0] ?? null;
  const raceWeightWeek = hyroxBeginnerRaceWeightWeek(trainingWeeks, fullSimWeek);
  const loadTier = hyroxLoadTierForState(state);
  const out: Partial<Record<HyroxStation, number>> = {};
  for (const st of HYROX_LOADED_STATIONS) {
    const kg = hyroxLoadKgAt(st, loadTier, hyroxBeginnerLoadFraction(st, weekIndex, raceWeightWeek) ?? 1);
    if (kg != null) out[st] = kg;
  }
  for (const w of state.wks?.[weekIndex - 1]?.triWorkouts ?? []) {
    if (w.t !== 'hyrox_station_technique' && w.t !== 'hyrox_station_density') continue;
    for (const c of w.hyroxComponents ?? []) if (c.loadKg != null) out[c.type as HyroxStation] = c.loadKg;
  }
  return out;
}

/** The stricter of two previous-Sunday readings: hard or eccentric if either
 *  says so (null when both Sundays are empty). */
function mergePrevSundays(a: HyroxPrevSunday | null, b: HyroxPrevSunday | null): HyroxPrevSunday | null {
  if (!a) return b;
  if (!b) return a;
  return { hard: a.hard || b.hard, eccentric: a.eccentric || b.eccentric };
}

/**
 * Build training weeks 1..upto in order, by ONE constraint hierarchy (round 6,
 * 2026-10-13; it replaces the decisions rounds 1 to 5 layered on each other).
 * The levels apply in this order, and a lower level never breaks a higher one.
 *
 * 1. HARD SAFETY, never broken and never traded:
 *    - no single run above 110% of the longest run of the previous
 *      LONG_RUN_LOOKBACK_WEEKS weeks (Frandsen 2025; runCeilingKm);
 *    - no two hard sessions on adjacent days and 48 h between eccentric
 *      sessions, Sunday to Monday included (scheduler.hyrox; a week that
 *      cannot place loses a hard session to its easy sibling, then its
 *      lowest-priority session);
 *    - the race taper at hyroxTaperFraction (0.55, then 0.30) of the reference
 *      week, with its station and brick work as ceilings (never under the
 *      taper's smallest circuit, hyroxRaceTaperFloorCircuit) and never above
 *      the week before (taperDropRank sheds sessions until they hold). Its
 *      smallest circuit (MIN_CIRCUIT_ROUNDS rounds of MIN_CIRCUIT_STATIONS
 *      stations; in a week holding no circuit, its smallest brick at
 *      MIN_CIRCUIT_ROUNDS rounds) is exempt from the fractions in taper week 1
 *      and race week, week 1's assessment too when week 1 is the taper, and
 *      leaves last for any other ceiling; race week may sit above the week
 *      before only by holding the primer and that circuit and nothing else
 *      (round 7); the chosen hours cap every race taper week;
 *    - no brick in base, before HYROX_FIRST_BRICK_WEEK or in race week
 *      (weekSessionCounts), and the race-week closing rules
 *      (hyroxWeekForRace, raceWeekDays).
 * 2. WEEK SIZE = min(the chosen weekly hours, the acute:chronic guard
 *    (ACWR_SAFE_HIGH x the mean of the previous HYROX_CHRONIC_WINDOW_WEEKS
 *    planned weeks, the weeks before week 1 seeded per D4 at the larger of
 *    the logged load and the nominal week 1, and never under the nominal
 *    week 1: round 7), the phase budget (week 1's assessment exempt), the
 *    deload or taper fraction).
 *    - The guard and the deload ceiling do not depend on the chosen hours. A
 *      week they cannot hold at the chosen hours is built at the largest size
 *      in minutes they hold (a bisection over a fixed range, fit; it holds the
 *      weekly hours and the phase budget too when the smallest week does): its
 *      budget-sized inputs (the station sessions' share of the phase budget,
 *      the running share, the easy erg fill) read that size, and step 3
 *      allocates inside it. So that week is the same at every chosen hours
 *      above its size, and so are its load and every later week's guard,
 *      wherever the week's load rises with its size (whole rounds can make it
 *      step down: the bisection then finds a size that holds, not always the
 *      largest). Step 3 decides on feasibility checks (fitOrDefer, feasible)
 *      and fits the week once (round 6 review, pass 3: performance). Round 7:
 *      fit() holds the week whenever its smallest week does (the size search
 *      falls back to it), so for every training week a check reads the week
 *      at the chosen hours and the smallest week only.
 *    - The weekly hours, the phase budget and the taper fractions use plain
 *      proportional sizing (fit, as in round 4): easy erg work gives way
 *      first, then the station sessions, bricks and easy runs shrink by one
 *      scale; the room whole rounds leave goes back to easy running, then to
 *      easy erg work.
 * 3. ALLOCATION inside the week size, in priority order:
 *    a. the tier quality run (when the phase calls for one) and the long run.
 *       A loaded week's long run is never shorter than the previous loaded
 *       week's, unless the taper or a hard rule says so; it gives up only its
 *       growth, and only for the quality run (D3). The running share sizes
 *       neither of them;
 *    b. the week's last station session or brick;
 *    c. the other station and brick sessions the tier structure holds;
 *    d. easy running, up to HYROX_RUN_SHARE x the chosen weekly minutes
 *       (standalone runs plus brick runs);
 *    e. easy erg work for the minutes left, within the athlete's chosen
 *       session count, each session up to the tier long-run cap (60/75/90
 *       min), in its own discipline ('erg'), never a station session. When
 *       the chosen sessions or the MTL cap are full, an easy run's slot (or
 *       its MTL) goes to it whenever the week then holds more minutes (round
 *       7; round 6 required the easy runs left to keep every running minute),
 *       never with an active injury (ergSlotOptions).
 *    A week over its size gives way in reverse order: e, d, c, then a's
 *    long-run growth for the quality run (D3), then the quality run. The one
 *    exception: b leaves only after the long run has shortened to the run
 *    floor and left the week, so every training week keeps HYROX work (the
 *    round-4 guarantee). Measured 2026-10-14 (round 6, before round 7's
 *    guard floor) on 629 plans (every band, its hours grid, lengths 8 to 24),
 *    training weeks after week 1 without station or brick work, strict order
 *    against this exception: 372 (340 at 2 h) against 0 at the nominal seed,
 *    1,865 against 0 at a logged 20 TSS, 725 against 0 at 100 TSS. The
 *    exception costs quality runs (of 5,714 loaded weeks whose format calls
 *    for one): 4,543 against 4,641, 16 against 384 and 3,742 against 4,021.
 *    In a deload the easy run ranks above the mini brick (round 7): the
 *    secondary brick and the beginner tier's brick leave before it, and a
 *    mini brick whose run segments keep the running share from funding the
 *    easy run's hold leaves (never as the week's last station work). A
 *    quality run over the hard-session limits takes an easy slot before the
 *    runs are sized, so a ceiling never cuts the long run while a longer easy
 *    run stays.
 * 4. MTL CAP (the cap alone): easy erg work is sized inside what the cap
 *    leaves, then easy runs shorten and leave (never the long run or the
 *    quality run), then station rounds and stations go (never the week's
 *    last station session); a week still over the cap says so
 *    (enforceMTLCap).
 * 5. MONOTONICITY is reported, not enforced: one more chosen hour may
 *    restructure a week, and no quality run is removed to hold the minutes.
 *    The rules test reports every adjacent-hour pair whose total plan
 *    minutes fall, bounds the fall to one easy session (the tier long-run
 *    cap) and measures the quality runs, for nine variants: the default
 *    sessions, open doubles, open doubles at a logged 100 TSS, the 7-session
 *    choice, logged 20, 50, 100 and 200 TSS and a logged 25-min run (round 7:
 *    1 of 2,916 pairs falls, by 56 min; no quality run lost on the grid).
 * Deloads also hold an easy run at the run floor under the shared scale and
 * take stations out of their circuits before an easy run leaves
 * (easyHoldMin), and hold no station or brick session longer or heavier than
 * its counterpart in the last loaded week (capSessionLoad, round 7). A loaded
 * week the chosen session count holds under its size is marked for the plan
 * view (HyroxHoursFit: the phase budget is the chosen hours, no ceiling sized
 * the week, one more chosen session would hold at least HYROX_RUN_FLOOR_MIN
 * more of it, and the real plan built with one more session does: round 7).
 *
 * Each week reads the weeks before it:
 * the acute:chronic guard (planned TSS at most ACWR_SAFE_HIGH × the mean of the
 * previous HYROX_CHRONIC_WINDOW_WEEKS weeks; Tristan 2026-10-12, Gabbett 2016's
 * 0.8 to 1.3 sweet spot, the same bound as running's week-1 ACWR_SAFETY_CAP),
 * whose window counts each week before week 1 as the larger of the athlete's
 * logged weekly load and the nominal week 1 (D4; round 7), and which never
 * sits under the nominal week 1 (round 7: the plan's own first week as it
 * builds without the guard, a station session in the assessment's slot); the deload
 * ceiling (the last loaded week × HYROX_DELOAD_FACTOR); the single-run rule
 * (110% of the longest run of the previous LONG_RUN_LOOKBACK_WEEKS weeks;
 * Frandsen 2025); the taper's reference week and the week before; and the
 * previous Sunday. Deterministic: the same plan config gives the same weeks
 * (the chronic seed is the one stored when the plan was created, never the
 * live baseline), so one week can be rebuilt alone.
 *
 * `storedBoundaryWeek`: the first week the caller replaces (default s.w, the
 * week from which the in-place regenerations rebuild; regenerateHyroxWeek
 * passes its own week). That week's Sunday-to-Monday spacing also reads the
 * stored week before it, the one the user keeps (moved sessions, an older
 * generator's layout), and holds to the stricter of the two.
 */
export function buildHyroxTrainingWeeks(
  state: SimulatorState, trainingWeeks: number, layout: RaceWeekLayout | null, upto: number = trainingWeeks,
  opts: { storedBoundaryWeek?: number; noHoursLine?: boolean; weakestStation?: HyroxStation | null } = {},
): HyroxWeekDetail[] {
  const hx = state.hyroxConfig!;
  const tier = hyroxTier(hx.athleteBand);
  const planPhases = computeHyroxPlanPhases(trainingWeeks);
  const phaseList = planPhases.map(p => p.ph as TrainingPhase);
  const easyPace = hyroxEasyRunPaceSecKm(hx.athleteBand, hx.hyroxRunPaceSecKm, state);
  const start = hyroxLongRunStart(state, tier, easyPace);
  const lr = HYROX_LONG_RUN[tier];
  const storedBoundary = opts.storedBoundaryWeek ?? (state.w ?? 1);
  // The race taper: the taper weeks that end the plan.
  let taperStart = trainingWeeks + 1;
  for (let w = trainingWeeks; w >= 1 && planPhases[w - 1]?.ph === 'taper'; w--) taperStart = w;
  const taperLen = trainingWeeks - taperStart + 1;
  // Execution → next-week load. Trailing RPE across all HYROX sessions scales the weekly
  // budget, mirroring running's `effortMultiplier`. Only weeks ≥ current are scaled — past
  // weeks keep their real prescribed load (don't rewrite history). See
  // effort-multiplier.hyrox.ts / SCIENCE_LOG §AU.
  const effortNow = hyroxEffortMultiplier(state);
  // The athlete's chosen weekly session total (the stored counts, the build
  // week): easy erg work fills a week's free slots up to it, never past it
  // (D1).
  const def = HYROX_WEEKLY_SESSIONS[hx.athleteBand];
  const chosenSessions = hyroxSessionTotal({
    runs: hx.runsPerWeek ?? def.runs,
    stations: hx.stationSessionsPerWeek ?? def.stations,
    bricks: hx.bricksPerWeek ?? def.bricks,
  });
  // The guard's chronic window before week 1 (D4, Tristan 2026-10-13): the
  // athlete's logged weekly load in canonical TSS (signalBBaseline: the median
  // completed week of raw physiological TSS, all sports, the load currency the
  // plan's planned TSS is in), as running's week-1 ACWR_SAFETY_CAP reads the
  // athlete's baseline; week 1 is then guarded too. Without one, the nominal
  // week 1: its structure with a station session in the assessment's slot,
  // computed when week 1 is built. Before, the window counted the weeks before
  // week 1 as week 1, the light assessment week (novice 6 h: 126 min, 116
  // TSS), which held the whole plan low. A logged zero is no data (§BV), so it
  // falls back to the nominal week. The value is the one stored when the plan
  // was created (hyroxConfig.planChronicSeed), so the same plan config gives
  // the same weeks at every regeneration.
  const seed = planChronicSeed(state);
  const chronicSeedSource = seed.source;
  const loggedSeedTss = seed.source === 'logged' ? (seed.loggedTss as number) : 0;
  // Pre-plan running exposure for the single-run rule (D8). Weeks 2 to
  // LONG_RUN_LOOKBACK_WEEKS count the longest run logged in the 30 days
  // before the plan, as week 1 does (review 2026-10-13: only week 1 counted
  // it, so a 2-week plan whose taper week 1 ran 0.65 x the start dropped the
  // race-week primer for an athlete with a logged 30-min run, 35
  // configurations, while the same athlete with no logged run kept it). With
  // no logged run, week 1 runs the long-run start with no ceiling, so weeks 2
  // to LONG_RUN_LOOKBACK_WEEKS count that start (its distance at easy pace)
  // when week 1 ran it or was a taper week by design; when a ceiling or a
  // gate held week 1 below it, what week 1 ran (review 2026-10-13: a week 1
  // guarded to a 4-min long run let week 2 jump to 110% of the start).
  const startKm = (start.startMin * 60) / easyPace;
  // The shortest training-week long run: the run floor, or the start when a
  // short logged run holds the start under it.
  const runFloorMin = Math.min(HYROX_RUN_FLOOR_MIN, start.startMin);
  // Canonical TSS per minute of easy erg work and of an easy run (the
  // ceilings take them away first).
  const ergTssPerMin = plannedTssPerMin(HYROX_EASY_ERG_TYPE, HYROX_EASY_RPE);
  // Read once per plan build: every build of every week reads them.
  const realRunning = realRunningSignal(state);
  const planStationBenchmarks = hyroxPlanningStationBenchmarks(state);
  const planLoadTier = hyroxLoadTierForState(state);
  const easyRunTssPerMin = plannedTssPerMin('hyrox_run_easy', HYROX_EASY_RPE);
  // The forecast's weakest station (lane H2b): the race-pace session holds it
  // first. One forecast per plan build; the hours line's rebuild reuses it.
  const weakestStation = opts.weakestStation !== undefined ? opts.weakestStation : hyroxPlanWeakestStation(state);
  // The beginner load schedule (lane H2b, sheet technique.station_session):
  // sleds unloaded in weeks 1 and 2, then 50% of race weight, the other loaded
  // stations at 60%, race weight from 4 weeks before race week (no race
  // simulation yet). Between those anchors each station's load steps from the
  // last station session that held it, the way strength-progression's
  // suggestNextWeight steps a lift: up 2.5% (at least one 2.5 kg plate) in
  // base and build when the athlete rated that session easier than its target
  // RPE, held otherwise, in peak, taper and deload weeks, and under an injury
  // that adapts or pauses strength work (current and future weeks). The
  // memory replays the plan's own station sessions with the ratings the
  // athlete entered on their slot ids (athleteRatedRpe: a guided 1-tap RPE,
  // Mark as done, an RPE prompt, the watch's self-reported RPE), so the same
  // ratings give the same loads at every rebuild. An estimate derived from a
  // synced recording (deriveRPE reads a technique session's low average heart
  // rate as RPE 3 or 4) holds the load: suggestNextWeight steps on the
  // athlete's own effort report (lane H2b review). Intermediate and advanced
  // athletes train at race weight (sheet): no schedule.
  const beginnerLoads = tier === 'beginner';
  // The plan's race simulations (lane H2b part 2): a beginner's race weight
  // starts the week before the full sim (sheet technique.station_session).
  const sims = hyroxSimWeeks(state, trainingWeeks);
  const fullSimWeek = [...sims.entries()].find(([, v]) => v.kind === 'full')?.[0] ?? null;
  const raceWeightWeek = hyroxBeginnerRaceWeightWeek(trainingWeeks, fullSimWeek);
  const loadMemory = new Map<HyroxStation, HyroxStationLoadMemory>();
  const injuryKind = injuryStrengthDecision((state as any).injuryState as InjuryState | undefined).kind;
  const stationLoadsFor = (w: number, phase: HyroxPhase, deload: boolean): Partial<Record<HyroxStation, number>> | undefined => {
    if (!beginnerLoads) return undefined;
    const out: Partial<Record<HyroxStation, number>> = {};
    for (const st of HYROX_LOADED_STATIONS) {
      const kg = hyroxBeginnerStationLoadKg({
        station: st,
        loadTier: planLoadTier,
        weekIndex: w,
        raceWeightWeek,
        phase,
        deload: deload || phase === 'taper',
        injuryKind: w >= (state.w ?? 1) ? injuryKind : 'normal',
        memory: loadMemory.get(st),
      });
      if (kg != null) out[st] = kg;
    }
    return out;
  };
  // A load the rating moved above the last session's (the climb), noted on
  // the week when its station work holds the station: the prescription shows
  // the new load, the note says why.
  const noteLoadSteps = (d: HyroxWeekDetail) => {
    if (!beginnerLoads) return;
    const held = new Set<HyroxStation>();
    for (const x of prescribed(d.workouts)) {
      if (!isHyroxWork(x)) continue;
      for (const c of x.hyroxComponents ?? []) if (c.loadKg != null) held.add(c.type as HyroxStation);
    }
    const anchorOf = (st: HyroxStation) => hyroxLoadKgAt(st, planLoadTier, hyroxBeginnerLoadFraction(st, d.week, raceWeightWeek) ?? 1) ?? 0;
    for (const st of held) {
      const m = loadMemory.get(st);
      const kg = d.workouts.flatMap(x => x.hyroxComponents ?? []).find(c => c.type === st && c.loadKg != null)?.loadKg;
      if (!m || kg == null || kg <= m.kg + 1e-9 || kg <= anchorOf(st) + 1e-9) continue;
      d.adjustments = [...d.adjustments, `W${d.week}: ${STATION_DISPLAY[st].name} load ${fmtAmount(m.kg)} to ${fmtAmount(kg)} kg (the last session holding it was rated easier than RPE ${m.targetRpe})`];
    }
  };
  // After a week is built: the load and the rating of each station its
  // station sessions held (bricks read the loads, they do not move them).
  const rememberLoads = (d: HyroxWeekDetail) => {
    if (!beginnerLoads) return;
    const wk = state.wks?.[d.week - 1];
    for (const x of prescribed(d.workouts)) {
      if (x.t !== 'hyrox_station_technique' && x.t !== 'hyrox_station_density') continue;
      const r = x.id != null ? athleteRatedRpe(wk, x.id) : undefined;
      for (const c of x.hyroxComponents ?? []) {
        if (c.loadKg == null) continue;
        loadMemory.set(c.type as HyroxStation, { kg: c.loadKg, ratedRpe: r, targetRpe: x.rpe ?? x.r ?? 5 });
      }
    }
  };

  const last = Math.min(upto, trainingWeeks);
  // The chosen weekly hours (minutes): a ceiling on every training week.
  const hoursMin = (hx.weeklyHoursAvailable ?? 0) * 60;
  // The weeks built so far, in order: each week's rules read them.
  const built: HyroxWeekDetail[] = [];
  // The guard's chronic seed (D4) and its floor (round 7), both set when
  // week 1 is built: the nominal week 1, and the seed the larger of it and
  // the logged weekly load.
  let chronicSeedTss = loggedSeedTss;
  let guardFloorTss = 0;
  // What a week's rules read from the weeks before it: the deload and its
  // reference, the single-run ceiling, the acute:chronic guard and the
  // previous Sunday.
  const historyLimits = (w: number, unguarded = false) => {
    const prevSunday = built.length > 0 ? hyroxSundayFlags(built[built.length - 1].workouts) : null;
    const phase = (planPhases[w - 1]?.ph ?? 'base') as HyroxPhase;
    const raceWeek = isRaceWeek(w, trainingWeeks, state.continuousMode);
    // Honour a holiday-forced deload the same way running's plan_engine.ts does
    // (deload = ctx.forceDeload || isDeloadWeek(...)). The 4-week cycle skips
    // the week right before the race taper (isHyroxDeloadWeek, D5).
    const forceDeload = !!(state.wks?.[w - 1] as any)?.forceDeload;
    const deload = forceDeload || isHyroxDeloadWeek(w, phaseList, phase);
    const lookback = built.slice(-LONG_RUN_LOOKBACK_WEEKS);
    const prevLongest = lookback.reduce((m, b) => Math.max(m, b.longestRunKm), 0);
    const week1 = built[0];
    const week1RanStart = !!week1 && (week1.phase === 'taper' || week1.longestRunKm >= startKm - 0.001);
    const preplanKm = w > LONG_RUN_LOOKBACK_WEEKS ? 0
      : start.recentLongestKm != null ? start.recentLongestKm
        : w >= 2 && week1RanStart ? startKm
          : 0;
    const ceilingRefKm = Math.max(prevLongest, preplanKm) > 0 ? Math.max(prevLongest, preplanKm) : null;
    const runCeilingKm = ceilingRefKm != null ? ceilingRefKm * (1 + LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST) : null;
    const prevLongRun = lookback.reduce((m, b) => Math.max(m, b.longRunMin ?? 0), 0);
    // The last loaded week (not a taper or a deload week): the taper's and the
    // deload's reference. A race-simulation week is skipped while an earlier
    // loaded week exists (lane H2b part 2): its structure (no long run or
    // quality run beside the sim) is not the week a deload or the taper
    // reduces.
    const loadedWeeks = [...built].reverse().filter(b => b.phase !== 'taper' && !b.deload);
    const refWeek = loadedWeeks.find(b => !prescribed(b.workouts).some(isHyroxSim)) ?? loadedWeeks[0];
    // The previous loaded week's long run (minutes; null: none): a loaded
    // week's long run is never shorter, unless the taper or a hard rule says
    // so (step 3 of the constraint hierarchy).
    const prevLoadedLong = refWeek?.longRunMin ?? null;
    // Deload (running's CV.4): the last loaded week × HYROX_DELOAD_FACTOR in
    // planned minutes and planned TSS, with no session, hard session or
    // quality run that week did not hold. Before (review 2026-10-12) the
    // factor scaled an hours budget the weeks filled only 34 to 74% of, so
    // the median deload cut 9.4% and 17% of deloads were longer than the week
    // before.
    const deloadRef = deload && phase !== 'taper' ? refWeek : undefined;

    const chronicMean = () => {
      let sum = 0;
      for (let k = 1; k <= HYROX_CHRONIC_WINDOW_WEEKS; k++) sum += built[w - 1 - k]?.plannedTss ?? chronicSeedTss;
      return sum / HYROX_CHRONIC_WINDOW_WEEKS;
    };
    // The guard never holds a week under the plan's own nominal week 1
    // (round 7, Tristan 2026-10-14): with a logged load of about 25 TSS or
    // less, sessions come in whole units, the guard held each week just under
    // the smallest one that would fit, and the chronic window never grew
    // (competitive plans of 12 weeks or more at 20 TSS: one short race-pace
    // session a week, no run all plan). Running's week-1 ACWR safety cap
    // likewise applies only above a minimum baseline, where the floors govern
    // (athlete-archetype.ts ACWR_CAP_BASELINE_MIN).
    const acwrCapTss = !unguarded && phase !== 'taper' && (w >= 2 || chronicSeedSource === 'logged')
      ? Math.max(ACWR_SAFE_HIGH * chronicMean(), guardFloorTss)
      : null;
    // The Sunday-to-Monday spacing: the week before as built here, and at the
    // first replaced week also the week before as stored.
    const weekPrevSunday = w === storedBoundary && w >= 2
      ? mergePrevSundays(prevSunday, hyroxSundayFlags(state.wks?.[w - 2]?.triWorkouts ?? []))
      : prevSunday;
    return { phase, raceWeek, deload, runCeilingKm, prevLongRun, prevLoadedLong, refWeek, deloadRef, acwrCapTss, weekPrevSunday };
  };
  // One week, built on the weeks before it. `nominal`: week 1 with a station
  // session in the assessment's slot (the D4 chronic seed, below).
  const buildWeek = (w: number, nominal = false, sim?: HyroxSimWeek): HyroxWeekDetail => {
    const { phase, raceWeek, deload, runCeilingKm, prevLongRun, prevLoadedLong, refWeek, deloadRef, acwrCapTss, weekPrevSunday } = historyLimits(w, nominal);
    const effortMult = w >= (state.w ?? 1) ? effortNow : 1.0;
    const firstDow = firstTrackedDow(state.planStartDate, w, state.planCreatedAt);
    // MTL-gap re-anchor (mirror of running's CTL-gap, SCIENCE_LOG §BR): reduce-only,
    // suppressed on deload/taper and past weeks, combined with effort under ONE clamp
    // [HYROX_ADAPTIVE_FLOOR, 1.15] so the two volume levers can't overstack.
    const stationLoads = stationLoadsFor(w, phase, deload);
    const mtlGapMult = (w >= (state.w ?? 1) && !deload && phase !== 'taper')
      ? ctlGapMultiplier((state.wks?.[w - 1] as any)?.ctlRatio ?? 1)
      : 1.0;
    const adaptive = mtlGapMult === 1.0
      ? effortMult
      : Math.max(HYROX_ADAPTIVE_FLOOR, Math.min(1.15, effortMult * mtlGapMult));

    let budgetMin: number;
    let longRunMin: number | null;
    if (phase === 'taper') {
      // The long run in a taper week: TAPER_LONG_RUN_FRACTION of the longest
      // long run of the previous 4 weeks (the start when there is none),
      // never under the run floor when that long run reached it (decision E,
      // Tristan 2026-10-13; the deload's rule). Before, a logged load of 30
      // TSS or less, whose long runs sat at 22 to 29 min, gave taper long
      // runs of 14 to 19 min (28 plans).
      const taperRef = prevLongRun > 0 ? prevLongRun : start.startMin;
      const taperLong = Math.round(taperRef * TAPER_LONG_RUN_FRACTION);
      longRunMin = raceWeek ? null : taperRef >= runFloorMin ? Math.max(runFloorMin, taperLong) : taperLong;
      if (w >= taperStart) {
        // Race taper: hyroxTaperFraction (0.55 then 0.30, Tristan 2026-10-19) of the
        // reference week, the last loaded week before the taper.
        const refMin = refWeek ? refWeek.plannedMin : hoursMin * HYROX_PEAK_MULT;
        budgetMin = hyroxTaperFraction(w - taperStart + 1, taperLen) * refMin;
      } else {
        budgetMin = hoursMin * HYROX_TRANSITION_TAPER_MULT;
      }
    } else {
      budgetMin = hoursMin * trainingPhaseMultiplier(phase, w) * (deload ? HYROX_DELOAD_FACTOR : 1) * adaptive;
      if (raceWeek) {
        longRunMin = null;
      } else {
        const stepped = Math.min(lr.capMin, start.startMin + lr.stepMin * Math.floor((w - 1) / lr.stepEveryWeeks));
        // A deload's long run: the last loaded long run × HYROX_DELOAD_FACTOR
        // (running's CV.2); the levers only reduce it, as the week's ceiling is
        // the last loaded week.
        // Never under the run floor when the last loaded long run was at it or
        // above (the week's deload ceiling still holds: over it, the long run
        // is left out).
        // The tier cap holds under the effort lever too (lane H2b part 2: an
        // EASY rating took an intermediate long run to 77 min against the
        // sheet's 75-min cap).
        const deloaded = deloadRef
          ? Math.round(Math.min(stepped, deloadRef.longRunMin ?? stepped) * HYROX_DELOAD_FACTOR * Math.min(1, adaptive))
          : Math.min(lr.capMin, Math.round(stepped * (deload ? HYROX_DELOAD_FACTOR : 1) * adaptive));
        longRunMin = deloadRef && (deloadRef.longRunMin ?? 0) >= runFloorMin ? Math.max(runFloorMin, deloaded) : deloaded;
      }
    }
    // Running budget of a training week: HYROX_RUN_SHARE of the chosen weekly
    // minutes (D2), the effort and MTL-gap lever only reducing it. A deload
    // keeps it: the deload ceiling (0.75 of the last loaded week) and its
    // deloaded long run do the reducing, so its quality run is not squeezed
    // out by a second cut. A taper week's comes from its own budget (unset).
    const runBudgetMin = phase === 'taper'
      ? undefined
      : HYROX_RUN_SHARE * hoursMin * Math.min(1, adaptive);

    const deloadCapMin = deloadRef ? deloadRef.plannedMin * HYROX_DELOAD_FACTOR : null;
    const deloadCapTss = deloadRef ? deloadRef.plannedTss * HYROX_DELOAD_FACTOR : null;
    // The week's size in minutes (step 2 of the hierarchy). A training week is
    // built at the chosen weekly hours unless a fixed ceiling (the
    // acute:chronic guard, the deload ceiling: neither depends on the chosen
    // hours) cannot hold that week; then it is built at the largest size the
    // ceiling holds (fit, below), its budget-sized inputs (the station
    // sessions' share of the phase budget, the running share, the easy erg
    // fill) read at that size. So a week a fixed ceiling holds is the same week
    // at every chosen hours above that size, and its load, and every later
    // week's guard, are the same too (round 6 review, pass 2: under a binding
    // guard the station sessions were still sized from the chosen hours, whole
    // rounds landed differently at each hour setting, and the chronic window
    // compounded the gap; at a logged 50 TSS, total plan minutes fell by up to
    // 240 min, and 3 quality runs became 1, when one hour was added). Taper
    // weeks are sized from their reference week, never from the hours.
    let sizeMin = hoursMin;
    const budgetPerHourMin = phase === 'taper' || hoursMin <= 0 ? 0 : budgetMin / hoursMin;
    const budgetAt = (x: number): number => (phase === 'taper' || hoursMin <= 0 ? budgetMin : x * budgetPerHourMin);
    const runBudgetAt = (x: number): number | undefined => (phase === 'taper' || runBudgetMin == null || hoursMin <= 0
      ? runBudgetMin
      : runBudgetMin * (x / hoursMin));
    // Easy erg work fills the week's budget at its size; a deload's, at most
    // its ceiling (0.75 of the last loaded week's minutes), so the notes
    // measure what is left against the deload, not against the phase budget.
    const fillAt = (x: number): number => Math.min(budgetAt(x), deloadCapMin ?? Infinity);

    // Taper week 1 and deload weeks hold no session the reference week (the
    // last loaded week) did not: its counts cap theirs. Race week keeps the
    // peak structure minus the brick (generateWeekSessions), with no more runs
    // than the reference week (D6). A deload or taper week also holds no more
    // sessions than the reference week; easy erg work fills free slots up to
    // that total (maxSessions).
    const capRef = phase === 'taper' ? refWeek : deloadRef;
    const capCounts = capRef ? sessionCountsOf(capRef.workouts) : undefined;
    const maxSessions = capRef ? Math.min(chosenSessions, prescribed(capRef.workouts).length) : chosenSessions;
    const maxSessionsName = maxSessions < chosenSessions
      ? `the reference week's ${maxSessions} sessions`
      : `the chosen ${chosenSessions} sessions`;
    const maxRuns = raceWeek && refWeek ? sessionCountsOf(refWeek.workouts).runs : undefined;
    // Easy erg work in a taper week, and race week's easy runs, are no longer
    // than the taper's long run.
    const easyMaxMin = phase === 'taper'
      ? ((raceWeek ? built[w - 2]?.longRunMin : longRunMin) ?? undefined)
      : undefined;
    const maxHardSessions = deloadRef ? prescribed(deloadRef.workouts).filter(isHyroxHardSession).length : undefined;
    const maxQualityRuns = deloadRef
      ? prescribed(deloadRef.workouts).filter(x => x.t === 'hyrox_run_tempo' || x.t === 'hyrox_run_intervals').length
      : undefined;
    // Race taper (both weeks): the reference week caps every station and brick
    // session (length, rounds, stations) and the week's station and brick
    // minutes and MTL. Before (review 2026-10-13) taper weeks rebuilt a full
    // 4-station circuit at its 2-round floor where the reference week's had 2
    // stations or none: taper week 1 sat above 0.80 of the reference week in
    // 111 of 629 configurations, and 153 taper weeks held more station and
    // brick minutes than the reference week.
    const raceTaper = phase === 'taper' && w >= taperStart;
    const taperRef = raceTaper ? refWeek : undefined;
    const sessionCaps = deloadRef ? sessionCapsOf(deloadRef.workouts) : taperRef ? sessionCapsOf(taperRef.workouts) : undefined;
    const refFor = deloadRef ?? (raceTaper ? taperRef : undefined);
    const sessionRefs = refFor ? prescribed(refFor.workouts).filter(x => isHyroxWork(x) && x.t !== 'hyrox_assessment') : undefined;
    let ceilingName: string | undefined = deloadRef ? 'deload ceiling' : raceTaper ? 'taper' : undefined;
    // The race taper's station and brick ceilings: the reference week's
    // minutes and MTL, never under the taper's smallest circuit
    // (hyroxRaceTaperFloorCircuit), still inside the taper fractions.
    const refWork = taperRef ? stationWorkOf(taperRef.workouts) : undefined;
    const floorCircuit = refWork ? hyroxRaceTaperFloorCircuit(state, w, raceWeek, stationLoads) : null;
    const taperWork = refWork && floorCircuit
      ? { min: Math.max(refWork.min, floorCircuit.min), mtl: Math.max(refWork.mtl, floorCircuit.mtl) }
      : refWork;
    const prevRunMin = phase === 'taper' && built[w - 2] ? runMinutesOf(built[w - 2].workouts) : undefined;
    const maxCircuitRounds = raceWeek && built[w - 2]
      ? Math.max(MIN_CIRCUIT_ROUNDS, circuitRoundsOf(built[w - 2].workouts))
      : undefined;
    let scale = 1;
    let omitted: HyroxGuardOmit[] = [];
    let ergCap: number | undefined;
    // Training weeks: the most easy-run minutes the ceilings' scale leaves
    // (fit).
    let easyCap: number | undefined;
    // Deload weeks (item 8 of round 6): the easy runs hold the run floor
    // under the shared scale when the last loaded week held a run besides the
    // long run, so
    // the circuits and bricks shrink instead (and the circuits lose stations
    // before an easy run leaves, the deload's omit order). Review 2026-10-13:
    // beginner-tier circuits at their 2-round floor held their length while
    // floor(scale x the easy minutes) fell under HYROX_RUN_FLOOR_MIN and the
    // easy run left: 57 deloads, all beginner tier, ran half the last loaded
    // week or less (total_beginner 4 h 12 weeks W8: circuit 61, mini brick
    // 34, long run 29, against easy 28, circuit 63, mini brick 47, long run
    // 38).
    // The last loaded week held a run besides the long run (an easy run, or
    // a quality run whose slot a deload gives an easy run).
    const easyHoldMin = deloadRef && prescribed(deloadRef.workouts).filter(x => x.discipline === 'run' && !isHyroxLongRun(x)).length > 0
      ? HYROX_RUN_FLOOR_MIN
      : undefined;
    // Set when a ceiling took the week's last station session or brick: easy
    // erg work does not take its place.
    let ergBlocked = false;
    const noAssessment = nominal;
    // Set while a ceiling shortens the long run (the trim below).
    let longFixed = false;
    // Week 1's assessment is exempt from week 1's guard (review 2026-10-13):
    // it is a fixed calibration pass the guard cannot shrink or leave out, so
    // below about 55 TSS of logged weekly load it alone was over the guard
    // and every other session of week 1 went. The rest of week 1 stays under
    // ACWR_SAFE_HIGH x the logged load. Its load still counts in week 1's
    // planned TSS, so the weeks after it read it in their chronic window. The
    // phase budget exempts its minutes the same way (step 2 of the hierarchy).
    const assessmentOf = (ws: readonly Workout[]): Workout[] => (w === 1
      ? prescribed(ws).filter(x => x.t === 'hyrox_assessment')
      : []);
    const guardExemptTss = (ws: readonly Workout[]): number => hyroxPlannedTss(assessmentOf(ws));
    // The race taper's smallest circuit (round 7, Tristan 2026-10-14): in
    // taper week 1 and race week, the week's shortest station circuit at
    // MIN_CIRCUIT_ROUNDS rounds of MIN_CIRCUIT_STATIONS stations is exempt
    // from the hyroxTaperFraction ceiling, as race week's primer is, so no race
    // taper week loses all its station work to the fractions. Before (round
    // 6, pass 3), 123 of 2,160 taper weeks at 2 h held no station or brick
    // work and 63 race weeks no circuit: a 2-h peak week holding a 34-min
    // circuit beside a 75-min long run left 0.70 of it for a 49-min taper
    // long run and nothing more. The week-before ceiling (the taper never
    // rises), the reference week's station work and the race-week closing
    // rules still apply to it.
    // A week holding no circuit exempts its shortest brick at
    // MIN_CIRCUIT_ROUNDS rounds the same way, its station work then (a taper
    // week 1 the reference week's counts held to a mini brick).
    const isCircuitT = (x: Workout) => x.t === 'hyrox_station_technique' || x.t === 'hyrox_station_density';
    const exemptCircuitOf = (ws: readonly Workout[]): Workout | undefined => {
      if (!raceTaper) return undefined;
      const p = prescribed(ws);
      const circuits = p.some(isCircuitT);
      let best: Workout | undefined;
      for (const x of p) {
        if (circuits ? !isCircuitT(x) : x.discipline !== 'brick') continue;
        if ((x.hyroxRounds ?? 0) > MIN_CIRCUIT_ROUNDS || (circuits && (x.hyroxComponents ?? []).filter(c => c.type !== 'run').length > MIN_CIRCUIT_STATIONS)) continue;
        if (!best || (x.estimatedDurationMin ?? 0) < (best.estimatedDurationMin ?? 0)) best = x;
      }
      return best;
    };
    const attemptOf = (workouts: Workout[], adjustments: string[]) => {
      const work = stationWorkOf(workouts);
      const ergMin = ergMinOf(workouts);
      const easyMin = prescribed(workouts).filter(isPlainEasyRun).reduce((a, x) => a + (x.estimatedDurationMin ?? 0), 0);
      const tss = hyroxPlannedTss(workouts);
      const min = hyroxPlannedMinutes(workouts);
      return {
        workouts, adjustments, tss, guardTss: tss - guardExemptTss(workouts), min,
        budgetedMin: min - hyroxPlannedMinutes(assessmentOf(workouts)),
        workMin: work.min, workMtl: work.mtl, ergMin, easyMin,
        // The race taper's smallest circuit, and week 1's assessment in a
        // plan whose week 1 is the race taper (a fixed calibration pass, as
        // the guard and the phase budget exempt it): exempt from the
        // fractions (round 7).
        // (Its finisher is the week's spare minutes, not exempt.)
        exemptMin: (() => { const e = exemptCircuitOf(workouts); return (e?.estimatedDurationMin ?? 0) - (e?.hyroxSpec?.finisher?.min ?? 0); })() + (raceTaper ? hyroxPlannedMinutes(assessmentOf(workouts)) : 0),
      };
    };
    // Set while the hours line checks the week with one more chosen session.
    let plusOne = false;
    // The week's builds by their inputs: the size search, the feasibility
    // check and the fit that follows it build some weeks more than once. Each
    // caller gets its own notes array (callers add notes to the week they
    // keep).
    const weekBuilds: Map<string, Attempt> = new Map();
    const sessionMemo: Map<string, { w: Workout; notes: string[] }> = new Map();
    const make = (): Attempt => {
      const key = `${sizeMin}|${scale}|${ergCap}|${easyCap}|${omitted.join(',')}|${longRunMin}|${longFixed}|${ergBlocked}|${plusOne}|${ceilingName}`;
      const hit = weekBuilds.get(key);
      if (hit) return { ...hit, adjustments: [...hit.adjustments] };
      const a = makeWeek();
      weekBuilds.set(key, { ...a, adjustments: [...a.adjustments] });
      return a;
    };
    const makeWeek = () => {
      const adjustments: string[] = [];
      const sized = sizeMin < hoursMin - 1e-6;
      const workouts = hyroxWeekForRace(state, w, trainingWeeks, phase, layout, {
        budgetMin: budgetAt(sizeMin), longRunMin, runCeilingKm, prevSunday: weekPrevSunday, scale, omit: omitted, capCounts,
        maxHardSessions, maxQualityRuns, prevRunMin, maxCircuitRounds, sessionCaps, capSessionLoad: deloadRef != null, capBrickLoad: raceTaper, deload: deloadRef != null, sessionRefs, ceilingName,
        runBudgetMin: runBudgetAt(sizeMin), fillMin: fillAt(sizeMin), ergCapMin: ergBlocked ? 0 : ergCap, easyRunCapMin: easyCap,
        easyHoldMin, easyHoldRunBudgetMin: easyHoldMin != null ? runBudgetMin : undefined, ceilingSized: sized,
        longFixed, easyMaxMin, maxSessions: plusOne ? maxSessions + 1 : maxSessions, maxSessionsName, maxRuns, noAssessment,
        runFloorMin, extraSession: plusOne, firstDow, realRunning, sessionMemo, stationBenchmarks: planStationBenchmarks, loadTier: planLoadTier,
        stationLoads, weakestStation, doseFraction: phase === 'taper' ? undefined : budgetPerHourMin / HYROX_PEAK_MULT,
        sim: nominal ? undefined : sim,
      }, adjustments);
      return attemptOf(workouts, adjustments);
    };
    type Attempt = ReturnType<typeof makeWeek>;
    // Step 2 of the constraint hierarchy, the week's size: the acute:chronic
    // guard (training weeks), the deload ceiling (deload weeks), the chosen
    // weekly hours and the phase budget (training weeks; week 1's assessment
    // exempt from the budget) and, in a taper week, the taper budget
    // (hyroxTaperFraction × the reference week), the reference week's station and
    // brick minutes and MTL, and the week before (the taper never rises;
    // running's rule, SCIENCE_LOG §CV.4). A week the guard or the deload
    // ceiling cannot hold at the chosen hours is first built at the largest
    // size they hold (fit, the size search); what is still over after that,
    // and the hours, budget and taper limits, take plain proportional sizing,
    // as in round 4: easy erg work gives way first (its minutes price linearly:
    // `ergPerMin`, what one minute adds to the limit), then every
    // budget-sized session shrinks by the same scale each round, so stations,
    // bricks and easy runs give way together. Session floors and fixed
    // formats move the load in whole sessions, so a training week still over
    // its size then leaves sessions out in the hierarchy's allocation order,
    // lowest first (below). A taper week over its ceiling after the scale
    // takes stations out of its circuits, then leaves sessions out
    // (taperDropRank) until it fits: the fractions hold (review 2026-10-13),
    // the primer alone excepted. Before round 6 (2026-10-13) the phase budget
    // sized the station sessions and the easy erg fill but did not cap the
    // week, so a base week could hold the running share of the chosen hours
    // on top of a station budget of its phase.
    const capTss = Math.min(acwrCapTss ?? Infinity, deloadCapTss ?? Infinity);
    const hoursCapMin = hoursMin > 0 ? hoursMin : Infinity;
    const capMin = phase === 'taper' ? budgetMin : Math.min(deloadCapMin ?? Infinity, hoursCapMin);
    const phaseCapMin = phase !== 'taper' && budgetMin < capMin - 1e-6 ? budgetMin : Infinity;
    const before = built[w - 2];
    const beforeCapMin = phase === 'taper' && before ? before.plannedMin : Infinity;
    const hasCeiling = capTss < Infinity || capMin < Infinity || phaseCapMin < Infinity;
    const trainingCeiling = phase !== 'taper' && hasCeiling;
    // `fixed`: a training week's ceilings that do not depend on the chosen
    // hours (the guard, the deload ceiling): the week's size follows them
    // (fit). The weekly hours and the phase budget scale with the hours.
    const limits: Array<{ cap: number; of: (a: Attempt) => number; ergPerMin: number; fixed?: boolean }> = [];
    if (capTss < Infinity) limits.push({ cap: capTss, of: a => a.guardTss, ergPerMin: ergTssPerMin, fixed: phase !== 'taper' });
    if (phase !== 'taper' && deloadCapMin != null && deloadCapMin < hoursCapMin) {
      limits.push({ cap: deloadCapMin, of: a => a.min, ergPerMin: 1, fixed: true });
    } else if (capMin < Infinity) {
      limits.push({ cap: capMin, of: raceTaper ? a => a.min - a.exemptMin : a => a.min, ergPerMin: 1 });
    }
    // The race taper's fraction ceiling (its smallest circuit exempt).
    const fractionLimit = raceTaper ? limits[limits.length - 1] : undefined;
    let beforeLimit: (typeof limits)[number] | undefined;
    if (phaseCapMin < Infinity) limits.push({ cap: phaseCapMin, of: a => a.budgetedMin, ergPerMin: 1 });
    // The week before (the taper never rises). Race week may sit above it
    // only by holding the primer and its smallest circuit and nothing else
    // (round 7): a taper week 1 the reference week's counts held to a mini
    // brick and a long run left race week no room for the primer and a
    // circuit (13 race weeks at 2 h without one). Exempting the circuit
    // outright let race week rise up to 30 min above taper week 1 with an
    // easy run beside it (open doubles, total_beginner 4 h 10 weeks).
    // A race week whose primer gave its day to the circuit (generateWeekSessions:
    // race week keeps its station work) counts the easy run holding the
    // primer's run slot in the primer's place.
    const primerMinOf = (a: Attempt) => {
      if (!(raceTaper && raceWeek)) return 0;
      const p = prescribed(a.workouts);
      const tempo = p.filter(x => x.t === 'hyrox_run_tempo').reduce((m, x) => m + (x.estimatedDurationMin ?? 0), 0);
      if (tempo > 0 || !a.adjustments.some(n => n.endsWith("holds the primer's run slot"))) return tempo;
      return p.filter(isPlainEasyRun).reduce((m, x) => Math.max(m, x.estimatedDurationMin ?? 0), 0);
    };
    if (beforeCapMin < Infinity) {
      limits.push({
        cap: beforeCapMin,
        of: raceTaper && raceWeek ? a => {
          const e = exemptCircuitOf(a.workouts);
          return a.min - Math.max(0, primerMinOf(a) + (e?.estimatedDurationMin ?? 0) - (e?.hyroxSpec?.finisher?.min ?? 0) - beforeCapMin);
        } : a => a.min,
        ergPerMin: 1,
      });
      beforeLimit = limits[limits.length - 1];
    }
    // The chosen weekly hours cap a race taper week with what it exempts.
    if (raceTaper && hoursMin > 0) limits.push({ cap: hoursMin, of: a => a.min, ergPerMin: 1 });
    if (taperWork) {
      limits.push({ cap: taperWork.min, of: a => a.workMin, ergPerMin: 0 });
      limits.push({ cap: taperWork.mtl, of: a => a.workMtl, ergPerMin: 0 });
    }
    const over = (a: Attempt) => limits.some(l => l.of(a) > l.cap + 1e-6);
    const ratio = (a: Attempt) => limits.reduce((m, l) => Math.min(m, l.of(a) > 0 ? l.cap / l.of(a) : Infinity), Infinity);
    // Solver (round 4): easy erg work first, cut by what the largest
    // overshoot needs (erg minutes price linearly). Then the scale, shrunk by
    // the overshoot each round, at least 3% (a round that lands exactly on a
    // floor otherwise repeats), for at most 16 rounds. Numerical choices with
    // no physiological meaning. In a training week the scale also caps the
    // easy running at the scale times what the week held at full size (review
    // 2026-10-13): the scale on the running share alone left easy runs that
    // the long run caps untouched until the week left them out whole
    // (beginner 5 h 12 weeks W5, stations gated by an injury: a 33-min easy
    // run left out, over the guard by 0.02 TSS, where 32 min fitted).
    // The scale moves station and brick sessions in whole rounds, and easy
    // runs merge under the run floor, so the week can land well under its
    // size: easy erg work takes that room (what it holds the larger rounds
    // could not).
    const withErgRoom = (a: Attempt): Attempt => {
      if (over(a)) return a;
      let room = Infinity;
      for (const l of limits) if (l.ergPerMin > 0) room = Math.min(room, (l.cap - l.of(a)) / l.ergPerMin);
      if (room >= HYROX_RUN_FLOOR_MIN && room < Infinity) {
        const keep = ergCap;
        ergCap = Math.floor(room);
        const b = make();
        if (!over(b) && b.min > a.min) return b;
        ergCap = keep;
      }
      return a;
    };
    // The week's size under a fixed ceiling (step 2): the largest whole-minute
    // size, from 0 to HYROX_SIZE_SEARCH_MAX_MIN, whose week holds the guard
    // and the deload ceiling, found by bisection over that fixed range. The
    // range does not depend on the chosen hours, so the search lands on the
    // same size at every chosen hours above it (a session's whole rounds can
    // make the load step up and down with the size; a range that moved with
    // the hours would land on different steps). When the smallest week holds
    // the weekly hours and the phase budget too, the search holds them as
    // well, so the size it finds holds every limit of the week. Numerical
    // choices with no physiological meaning.
    const fixedLimits = limits.filter(l => l.fixed);
    const fixedOver = (a: Attempt) => fixedLimits.some(l => l.of(a) > l.cap + 1e-6);
    // Set once a build of the week at the chosen hours is over a fixed
    // ceiling: the week's later builds (other sessions left out, another long
    // run) try the smallest size first, and one over the ceiling there is over
    // at every size (every budget-sized session is at its floor), so the
    // build stops there. Before (round 6 review, pass 3), each build made the
    // week at the chosen hours first, and a week the guard held cost up to 60
    // builds.
    let fixedBound = false;
    // Set once a build of the week at the chosen hours is over any limit
    // (fitOrDefer checks the smallest week first from then on).
    let heldAtHours = false;
    // The largest whole-minute size below `top` whose week is not `bad`, the
    // week at size 0 (`smallest`) not being bad: a bisection.
    const sizeSearch = (bad: (a: Attempt) => boolean, top: number, smallest: Attempt): { lo: number; best: Attempt } => {
      let lo = 0;
      let hi = top;
      let best = smallest;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        sizeMin = mid;
        const b = make();
        if (bad(b)) hi = mid; else { lo = mid; best = b; }
      }
      return { lo, best };
    };
    // `full`: the week already built at the chosen hours with the solver
    // reset (the first build of the week, below).
    const fit = (full?: Attempt, quick = false) => {
      scale = 1;
      ergCap = undefined;
      easyCap = undefined;
      let smallest: Attempt | undefined;
      if (fixedBound && !full) {
        sizeMin = 0;
        smallest = make();
        // Even the smallest size is over the ceiling: every budget-sized
        // session is at its floor there (station sessions 35 min, bricks 20,
        // no easy run or easy erg work), so the scale has nothing left to
        // shrink, and the omit order (below) takes it from here.
        if (fixedOver(smallest)) return smallest;
      }
      sizeMin = hoursMin;
      let a = full ?? make();
      if (!over(a)) return a;
      heldAtHours = true;
      if (fixedLimits.length > 0 && fixedOver(a)) fixedBound = true;
      // `quick` (a caller that reads only whether the week holds): a training
      // week whose smallest week is over a limit holds at no size or scale
      // (every budget-sized session is at its floor there), so fit() returns
      // that smallest week and the omit order takes it from here (round 7:
      // before, the size search and the proportional solver ran to the end
      // first, about 30 builds). The steps that trim the long run fit in full:
      // whole rounds can leave the scaled week at the chosen hours smaller
      // than the smallest week, and the trim reads it. A taper week's size is
      // its taper budget, so it keeps the scale.
      if (quick && phase !== 'taper') {
        if (!smallest) {
          sizeMin = 0;
          smallest = make();
        }
        if (over(smallest)) return smallest;
        sizeMin = hoursMin;
      }
      if (fixedLimits.length > 0 && fixedOver(a)) {
        if (!smallest) {
          sizeMin = 0;
          smallest = make();
          if (fixedOver(smallest)) return smallest;
        }
        const bad = over(smallest) ? fixedOver : over;
        let { lo, best } = sizeSearch(bad, HYROX_SIZE_SEARCH_MAX_MIN, smallest);
        // The week at the chosen hours is over while a larger size holds
        // (the MTL cap trims a larger week's easy runs, or whole rounds step
        // the load): the largest size under the chosen hours that holds, by
        // the same bisection over 0 to the chosen hours.
        if (lo >= hoursMin) ({ lo, best } = sizeSearch(bad, hoursMin, smallest));
        sizeMin = lo;
        a = best;
        if (!over(a)) return a;
      }
      // Easy erg work gives way to the limits it counts toward (ergPerMin >
      // 0). A limit it does not count toward (the race taper's station and
      // brick work) is over by the same amount at any erg minutes, so it
      // never takes the erg work: when only such limits are over after the
      // cut, the erg work stays at the cut and the scale and the sheds (below)
      // hold the station work. Before (2026-10-14 merge review), any station
      // work over its cap took all the easy erg work, and a session the taper
      // then shed left its minutes unprescribed: open doubles novice 12 weeks,
      // taper week 1 held 158 min at 4 h and 79 at 5 h (63 min unprescribed).
      let keptErg = 0;
      if (a.ergMin > 0) {
        let cut = 0;
        for (const l of limits) {
          if (l.ergPerMin <= 0) continue;
          const excess = l.of(a) - l.cap;
          if (excess > 1e-6) cut = Math.max(cut, excess / l.ergPerMin);
        }
        if (cut < a.ergMin) {
          ergCap = Math.max(0, Math.floor(a.ergMin - cut));
          a = make();
          if (!over(a)) return a;
          const cutWeek = a;
          if (!limits.some(l => l.ergPerMin > 0 && l.of(cutWeek) > l.cap + 1e-6)) keptErg = ergCap;
        }
      }
      ergCap = keptErg;
      a = make();
      const easyFull = phase !== 'taper' ? a.easyMin : 0;
      const setScale = (x: number) => {
        scale = x;
        easyCap = easyFull > 0 ? Math.floor(easyFull * x) : undefined;
      };
      let overScale = 1;
      for (let i = 0; i < 16 && over(a); i++) {
        overScale = scale;
        setScale(scale * Math.min(0.97, ratio(a)));
        a = make();
      }
      if (!over(a) && scale < 1) {
        // The largest scale between the last two rounds that fits (session
        // rounds and easy runs move in whole steps, so the first fit can sit
        // a round under the size; round 5's refinement, kept so one more
        // hour does not lose a station round it had room for).
        let fitScale = scale;
        for (let i = 0; i < 6 && overScale - fitScale > 1e-3; i++) {
          setScale((fitScale + overScale) / 2);
          const b = make();
          if (over(b)) overScale = scale; else { fitScale = scale; a = b; }
        }
        setScale(fitScale);
        // The room the whole rounds leave goes to easy running first, up to
        // what the week held at full size (easy running ranks above easy erg
        // work), then to easy erg work (withErgRoom). Before round 6, one
        // more hour lengthened an easy run past what the guard could hold,
        // the scale took a station round with it, and the room it left stayed
        // empty (intermediate 12 weeks, W5 at 10 h held 260 min against 273
        // at 9 h, with 29 TSS of the guard unused).
        // (setScale sets easyCap; a cast, as the narrowing does not see it.)
        const capNow = easyCap as number | undefined;
        if (easyFull > 0 && capNow != null && capNow < easyFull) {
          let lo = capNow;
          let hi = easyFull;
          for (let i = 0; i < 6 && hi - lo > 1; i++) {
            const mid = Math.floor((lo + hi) / 2);
            easyCap = mid;
            const b = make();
            if (over(b)) hi = mid; else { lo = mid; a = b; }
          }
          easyCap = hi;
          const top = make();
          if (!over(top)) a = top; else easyCap = lo;
        }
        a = withErgRoom(a);
      }
      if (over(a)) {
        // The proportional solver stops over the week's size while the
        // smallest week holds (whole rounds, the MTL cap's trims): the largest
        // size whose week holds, by the size search (round 7). So fit() holds
        // the week whenever its smallest week does, and a check of the
        // smallest week answers for it (fitOrDefer, feasible).
        const keep = { scale, ergCap, easyCap, sizeMin };
        scale = 1;
        ergCap = undefined;
        easyCap = undefined;
        if (!smallest) {
          sizeMin = 0;
          smallest = make();
        }
        if (!over(smallest)) {
          const found = sizeSearch(over, hoursMin, smallest);
          sizeMin = found.lo;
          return found.best;
        }
        ({ scale, ergCap, easyCap, sizeMin } = keep);
      }
      return a;
    };
    // What fit() would return, without the size search where its outcome is
    // known: `week` is fit()'s week (the solver's state left as fit leaves
    // it), or null when the size search would run and find a size that holds
    // every limit (the smallest week holds them all: `ok`, and `probe` is that
    // smallest week, whose sessions are the fitted week's at their floors).
    const fitOrDefer = (): { week: Attempt | null; ok: boolean; probe: Attempt } => {
      scale = 1;
      ergCap = undefined;
      easyCap = undefined;
      let smallest: Attempt | undefined;
      if (fixedBound || heldAtHours) {
        // A week its size has held once: the smallest week first, which
        // answers yes alone when it holds.
        sizeMin = 0;
        smallest = make();
        if (fixedBound && fixedOver(smallest)) return { week: smallest, ok: false, probe: smallest };
        if (!over(smallest)) return { week: null, ok: true, probe: smallest };
      }
      sizeMin = hoursMin;
      const a = make();
      if (!over(a)) return { week: a, ok: true, probe: a };
      heldAtHours = true;
      if (fixedLimits.length > 0 && fixedOver(a)) fixedBound = true;
      if (!smallest) {
        sizeMin = 0;
        smallest = make();
      }
      // fit() holds the week whenever its smallest week does (its size
      // search falls back to it), so a smallest week holding every limit
      // answers yes; one over a limit answers no, as every budget-sized
      // session is at its floor there (round 7: the week the hours or the
      // phase budget holds no longer runs the proportional solver at every
      // check; competitive 4 h 24 weeks made 1,358 week builds).
      if (!over(smallest)) return { week: null, ok: true, probe: smallest };
      return { week: smallest, ok: false, probe: smallest };
    };
    // Would fit() hold the week within its size? fitOrDefer's answer: the
    // week at the chosen hours holds, or its smallest week does (fit then
    // sizes it; round 7: fit() holds whenever its smallest week does, so the
    // answer is exact and round 6's exact re-check, which ran for 1 week in
    // 4,736, is gone). The solver's state is restored.
    const feasible = (): boolean => {
      const keep = { scale, ergCap, easyCap, sizeMin };
      const ok = fitOrDefer().ok;
      ({ scale, ergCap, easyCap, sizeMin } = keep);
      return ok;
    };
    // The week at the chosen hours with the solver reset: fit's first build,
    // and what the notes name the binding ceiling from.
    scale = 1;
    ergCap = undefined;
    easyCap = undefined;
    sizeMin = hoursMin;
    const fullWeek = make();
    const nameBuilt = ceilingName;
    if (trainingCeiling && !deloadRef && over(fullWeek)) {
      // Name the ceiling that binds hardest at full size in the notes: the
      // guard, the weekly hours or the phase budget. Named before the week is
      // fitted, so it is fitted once (a week that holds at full size names
      // none).
      const named: Array<[string | undefined, number]> = [
        [undefined, capTss < Infinity && fullWeek.guardTss > 0 ? capTss / fullWeek.guardTss : Infinity],
        ['weekly hours', fullWeek.min > 0 ? hoursCapMin / fullWeek.min : Infinity],
        [`${phase} budget`, fullWeek.budgetedMin > 0 ? phaseCapMin / fullWeek.budgetedMin : Infinity],
      ];
      const [name, r] = named.reduce((m, x) => (x[1] < m[1] ? x : m));
      if (r < 1 - 1e-9 && name) ceilingName = name;
    }
    let attempt = fit(ceilingName === nameBuilt ? fullWeek : undefined, true);
    // The week at full size fits its ceilings: no ceiling holds it (the
    // hours line, below).
    const fitsAtFullSize = scale === 1 && ergCap === undefined && easyCap === undefined && omitted.length === 0 && sizeMin >= hoursMin - 1e-6;
    if (trainingCeiling) {
      // Step 3 of the hierarchy run backwards: a training week still over its
      // size after the scale leaves sessions out lowest priority first. The
      // long run and the quality run are the first allocation, the week's
      // last station session or brick the second, the other station and brick
      // work the third, easy running the fourth (easy erg work, the fifth,
      // has already gone in fit):
      //   1. easy runs, stations out of each circuit down to
      //      MIN_CIRCUIT_STATIONS, the technique station session, the
      //      secondary brick, the brick (HYROX_GUARD_OMIT_ORDER); a group whose
      //      omission would leave the week with no station session and no
      //      brick is the week's last station session or brick and waits;
      //   2. the long run gives up its growth over the previous loaded week's
      //      long run for the quality run (D3), the longest length that fits;
      //      then the quality run leaves (the long run keeps its length);
      //   3. what left on the way comes back, highest priority first, when it
      //      fits beside what had to go;
      //   4. the long run shortens toward the run floor, then leaves;
      //   5. last, the week's last station session or brick, only when the
      //      week is still over its size without the long run; the long run
      //      then takes back what fits, up to the length it had.
      // Steps 4 and 5 are where the hierarchy's order yields: every training
      // week keeps HYROX work (the round-4 guarantee, review 2026-10-13: at a
      // logged load of 40 TSS or less, 578 to 679 loaded weeks held a lone
      // long run where a station session and a 20-min long run fitted). In
      // strict order, 372 training weeks held no station session or brick at
      // the nominal seed (340 of them at 2 h), 1,865 at a logged 20 TSS and
      // 725 at 100 TSS (the figures in the comment block at
      // buildHyroxTrainingWeeks). Before round 6 (2026-10-13) the quality run
      // left before the brick.
      const heldWork = hasHyroxWork(attempt.workouts);
      const isQ = (x: Workout) => x.t === 'hyrox_run_tempo' || x.t === 'hyrox_run_intervals';
      const deferred: HyroxGuardOmit[] = [];
      // A deload takes stations out of its circuits before it leaves an easy
      // run out (item 8 of round 6, easyHoldMin above).
      // The easy run ranks above the mini brick in a deload (round 7,
      // Tristan 2026-10-14): the secondary brick, and the beginner tier's
      // brick (a mini brick), leave before it.
      const order: readonly HyroxGuardOmit[] = deloadRef
        ? (tier === 'beginner' ? ['stations', 'light', 'brick', 'easy', 'technique'] : ['stations', 'light', 'easy', 'technique', 'brick'])
        : HYROX_GUARD_OMIT_ORDER;
      // A week whose smallest size is over a fixed ceiling with every group
      // left out (and HYROX work kept) is over with any fewer left out: the
      // loop below would leave them all out, one build each.
      let allOut = false;
      if (over(attempt) && fixedBound) {
        const keep = { omitted, scale, ergCap, easyCap, sizeMin };
        omitted = [...omitted, ...order.filter(o => !omitted.includes(o))];
        scale = 1;
        ergCap = undefined;
        easyCap = undefined;
        sizeMin = 0;
        const trial = make();
        if (fixedOver(trial) && (!heldWork || hasHyroxWork(trial.workouts))) {
          attempt = trial;
          allOut = true;
        } else {
          ({ omitted, scale, ergCap, easyCap, sizeMin } = keep);
        }
      }
      // Set when fit() is known to hold the week (fitOrDefer, feasible) and
      // the week is fitted once, after what left comes back (bringBack),
      // rather than here and again there.
      let pending = false;
      for (const o of allOut ? [] : order) {
        if (pending || !over(attempt)) break;
        const keep = omitted;
        omitted = [...omitted, o];
        const trial = fitOrDefer();
        if (heldWork && !hasHyroxWork(trial.probe.workouts)) {
          omitted = keep;
          deferred.push(o);
          attempt = fit(undefined, true);
          continue;
        }
        if (trial.week) attempt = trial.week;
        else pending = true;
      }
      const longWanted = longRunMin;
      let heldNote: string | undefined;
      // What left on the way comes back, highest priority first, when it fits
      // (feasible), and the week is fitted once with what came back. A week
      // still over its size brings nothing back.
      const bringBack = () => {
        if (!pending && over(attempt)) return;
        const before = omitted;
        for (const o of [...order].reverse()) {
          if (!omitted.includes(o)) continue;
          const keep = omitted;
          omitted = omitted.filter(x => x !== o);
          if (!feasible()) omitted = keep;
        }
        if (omitted !== before || pending) attempt = fit();
        pending = false;
      };
      // D3 and the quality run (step 3 run backwards), then what left comes back.
      if (!pending && over(attempt) && attempt.workouts.some(isQ)) {
        // D3: the long run gives up its growth, never the previous loaded
        // week's length (at least LONG_SOFT_FLOOR_MIN), for the quality run.
        const hold = Math.max(LONG_SOFT_FLOOR_MIN, prevLoadedLong ?? 0);
        if (longWanted != null && longWanted > hold) {
          longRunMin = hold;
          if (feasible()) {
            let lo = hold;
            let hi = longWanted;
            while (lo < hi) {
              const mid = Math.ceil((lo + hi) / 2);
              longRunMin = mid;
              if (!feasible()) hi = mid - 1; else lo = mid;
            }
            longRunMin = lo;
            pending = true;
            if (lo < longWanted) heldNote = `W${w}: Long Run held at ${lo} min, not ${longWanted}, for the quality run (${ceilingName ?? 'acute:chronic guard'})`;
          } else {
            longRunMin = longWanted;
          }
        }
        if (!pending) {
          longRunMin = longWanted;
          omitted = [...omitted, 'quality'];
          if (feasible()) pending = true;
          else attempt = fit(undefined, true);
        }
      }
      bringBack();
      // The long run toward the run floor, then out of the week. Never under
      // the run floor (review 2026-10-13: it was trimmed to 4 min under a
      // 50-TSS logged load, and the week after jumped to 110% of the start).
      let longLeftOut = false;
      const longBeforeTrim = attempt.workouts.find(isHyroxLongRun)?.estimatedDurationMin;
      const trimLongToFloor = () => {
        // The long run is no longer stretched to a longer quality run's
        // distance: the quality run runs easy instead (before, a deload's
        // tempo, later demoted by the hard-session limit, stretched every
        // trimmed long run back and the long run left the week: novice 4 h
        // 10 weeks W4 held a 40-min easy run and no long run).
        if (!over(attempt)) return;
        if (!longFixed) {
          longFixed = true;
          attempt = fit();
          if (!over(attempt)) return;
        }
        // From the length the week holds (the single-run ceiling can hold it
        // under the one asked for).
        const held = attempt.workouts.find(isHyroxLongRun)?.estimatedDurationMin;
        if (longRunMin != null && held != null && held < longRunMin) longRunMin = held;
        for (let i = 0; i < 16 && over(attempt) && longRunMin != null && longRunMin > runFloorMin; i++) {
          longRunMin = Math.max(runFloorMin, Math.floor(longRunMin * Math.min(0.97, ratio(attempt))));
          attempt = make();
        }
        if (over(attempt) && longRunMin != null && attempt.workouts.some(isHyroxLongRun)) {
          longRunMin = null;
          longLeftOut = true;
          attempt = make();
        }
        // The quality step again (H2 integration review, 2026-10-14): a
        // quality run longer than the long run ran easy while the long run
        // stood, so the quality step (D3, then 'quality') found none; with the
        // long run out the demotion lapses and the quality run comes back.
        // While the week is still over, it leaves, as the hierarchy puts it
        // before the long run, and the long run takes back what then fits, up
        // to the length it had. Before, week 1 of a 3- to 5-week race plan for
        // a beginner-tier woman at Pro-tier loads at 2 h held the assessment
        // and a 36-min interval run, 141 of the chosen 120 min (84 of 5,832
        // short race-dated plans on the review grid).
        if (over(attempt) && longLeftOut && attempt.workouts.some(isQ) && !omitted.includes('quality')) {
          omitted = [...omitted, 'quality'];
          attempt = fit();
          if (!over(attempt) && longWanted != null) {
            longRunMin = runFloorMin;
            if (over(make())) {
              longRunMin = null;
            } else {
              let lo = runFloorMin;
              let hi = longWanted;
              while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                longRunMin = mid;
                if (over(make())) hi = mid - 1; else lo = mid;
              }
              longRunMin = lo;
              longLeftOut = false;
            }
            attempt = make();
          }
        }
      };
      trimLongToFloor();
      // Without the long run's growth (or the long run), what fits beside it
      // comes back.
      if (longFixed) bringBack();
      // Last, the week's last station session or brick, only when the week is
      // still over its size without the long run. The long run then takes
      // back what fits, from the run floor up to the length it had: the
      // station session alone was over the size, so the long run never holds
      // more than the station session would have.
      if (over(attempt) && deferred.length > 0) {
        for (const o of deferred) {
          if (!over(attempt)) break;
          omitted = [...omitted, o];
          attempt = fit();
        }
        // Easy erg work never takes the slot of the week's last station
        // session or brick (review 2026-10-13: under a 50-TSS logged load, 24
        // deload weeks held easy erg and no station or brick work).
        if (heldWork && !hasHyroxWork(attempt.workouts)) {
          ergBlocked = true;
          attempt = fit();
        }
        if (!over(attempt) && longWanted != null && (longRunMin ?? 0) < longWanted) {
          const held = longRunMin;
          let lo = held ?? runFloorMin;
          longRunMin = lo;
          if (held == null && over(make())) {
            longRunMin = null;
          } else {
            let hi = longWanted;
            while (lo < hi) {
              const mid = Math.ceil((lo + hi) / 2);
              longRunMin = mid;
              if (over(make())) hi = mid - 1; else lo = mid;
            }
            longRunMin = lo;
          }
          attempt = make();
        }
        trimLongToFloor();
      }
      // The long run held for the quality run, said on the week that keeps
      // the quality run. Before (round 6 review, pass 3) the note was lost
      // whenever a later step built the week again.
      if (heldNote && attempt.workouts.some(isQ)) attempt.adjustments.push(heldNote);
      const longAfter = attempt.workouts.find(isHyroxLongRun)?.estimatedDurationMin;
      if (longLeftOut && longAfter == null) {
        attempt.adjustments.push(`W${w}: Long Run left out (${ceilingName ?? 'acute:chronic guard'})`);
      } else if (longBeforeTrim != null && longAfter != null && longAfter < longBeforeTrim) {
        attempt.adjustments.push(`W${w}: Long Run cut from ${longBeforeTrim} to ${longAfter} min (${ceilingName ?? 'acute:chronic guard'})`);
      }
      if (w === 1 && acwrCapTss != null && attempt.tss > capTss + 1e-6 && attempt.guardTss <= capTss + 1e-6) {
        attempt.adjustments.push(`W${w}: planned load ${Math.round(attempt.tss)} TSS, above the ${Math.round(capTss)} TSS guard by the assessment (${Math.round(attempt.tss - attempt.guardTss)} TSS, not counted by the guard)`);
      }
      if (over(attempt)) {
        attempt.adjustments.push(deloadRef
          ? `W${w}: deload ${Math.round(attempt.min)} min / ${Math.round(attempt.tss)} TSS above ${HYROX_DELOAD_FACTOR} of the last loaded week (${Math.round(deloadRef.plannedMin)} min / ${Math.round(deloadRef.plannedTss)} TSS)`
          : attempt.guardTss > capTss + 1e-6
            ? `W${w}: planned load ${Math.round(attempt.guardTss)} TSS above the ${Math.round(capTss)} TSS guard`
            : attempt.min > hoursCapMin + 1e-6
              ? `W${w}: ${Math.round(attempt.min)} min above the ${Math.round(hoursCapMin)}-min weekly hours`
              : `W${w}: ${Math.round(attempt.budgetedMin)} min above the ${Math.round(phaseCapMin)}-min ${phase} budget`);
      }
    }
    // A taper week sheds sessions while `tooHeavy` holds, lowest priority
    // first (taperDropRank). With `workOnly`, only station and brick sessions
    // qualify (a run never leaves for the station and brick caps). In taper
    // week 1, when one session's removal alone brings the week under, the
    // lowest-priority such session goes instead, so the week keeps as much as
    // fits. Race week sheds strictly by rank (D6, Tristan 2026-10-13): its
    // short station circuit stays over the easy runs (before, the best-fit
    // rule dropped the circuit when that alone fitted: 3 default-hours race
    // weeks held no circuit). Race week keeps its primer.
    const withWorkouts = (a: Attempt, workouts: Workout[]): Attempt => attemptOf(workouts, a.adjustments);
    const fraction = raceTaper ? hyroxTaperFraction(w - taperStart + 1, taperLen) : null;
    const whyOf = (a: Attempt): string => (raceTaper && ((fractionLimit?.of(a) ?? a.min) > capMin + 1e-6 || a.workMin > (taperWork?.min ?? Infinity) + 1e-6 || a.workMtl > (taperWork?.mtl ?? Infinity) + 1e-6))
      ? `taper: ${Math.round(budgetMin)} min, ${fraction} of ${taperRef ? 'the reference week' : 'the weekly hours'}`
      : 'the taper never rises';
    const shed = (tooHeavy: (a: Attempt) => boolean, workOnly: boolean, fixedWhy?: string) => {
      while (tooHeavy(attempt)) {
        const cur = attempt;
        // Race week keeps its last run (it holds a run whenever it holds a
        // run slot; the primer never leaves, SCIENCE_LOG CE update 4).
        const runsLeft = prescribed(cur.workouts).filter(x => x.discipline === 'run').length;
        // The race taper's smallest circuit (and week 1's assessment) never
        // leaves for what exempts it, and leaves for another ceiling only
        // when nothing else is left to go.
        const exempt = exemptCircuitOf(cur.workouts);
        const exemptOk = (l: (typeof limits)[number]) => l === fractionLimit || (raceWeek && l === beforeLimit);
        const exemptStays = !limits.some(l => !exemptOk(l) && l.of(cur) > l.cap + 1e-6);
        const isExempt = (x: Workout) => x === exempt || (raceTaper && w === 1 && x.t === 'hyrox_assessment');
        const all = cur.workouts
          .filter(x => taperDropRank(x, raceWeek) >= 0)
          .filter(x => !(exemptStays && isExempt(x)))
          .filter(x => !workOnly || isHyroxWork(x))
          .filter(x => !(raceWeek && x.discipline === 'run' && !x.commute && runsLeft <= 1))
          .sort((a, b) => taperDropRank(a, raceWeek) - taperDropRank(b, raceWeek));
        const others = raceTaper ? all.filter(x => !isExempt(x)) : all;
        const candidates = others.length > 0 ? others : all;
        if (candidates.length === 0) break;
        const pool = raceWeek ? candidates.filter(x => taperDropRank(x, raceWeek) === taperDropRank(candidates[0], raceWeek)) : candidates;
        const pick = pool.find(x => !tooHeavy(withWorkouts(cur, cur.workouts.filter(y => y !== x)))) ?? candidates[0];
        const why = fixedWhy ?? whyOf(cur);
        attempt = withWorkouts(cur, cur.workouts.filter(x => x !== pick));
        attempt.adjustments.push(`W${w}: ${pick.n} left out (${why})`);
      }
    };
    if (phase === 'taper' && over(attempt)) {
      // Stations out of the circuits first, then whole sessions: the race
      // taper's station and brick work against the reference week's (only
      // station and brick sessions leave for it), then its fractions (of the
      // reference week, or of the weekly hours in a plan too short to hold
      // one), and in every taper week the week before.
      omitted = ['stations'];
      attempt = fit();
      // A circuit already at MIN_CIRCUIT_STATIONS stations (with no circuit,
      // a brick) comes down to MIN_CIRCUIT_ROUNDS rounds before anything
      // leaves: the smallest station work, which the fractions exempt.
      if (raceTaper && over(attempt) && !exemptCircuitOf(attempt.workouts)) {
        const p = prescribed(attempt.workouts);
        const circuits = p.some(isCircuitT);
        const c = p
          .filter(x => (circuits ? isCircuitT(x) && (x.hyroxComponents ?? []).filter(y => y.type !== 'run').length <= MIN_CIRCUIT_STATIONS : x.discipline === 'brick'))
          .sort((x, y) => (x.estimatedDurationMin ?? 0) - (y.estimatedDurationMin ?? 0))[0];
        if (c && (c.hyroxRounds ?? 0) > hyroxMinRounds(c)) {
          const cut = withHyroxRounds(c, hyroxMinRounds(c));
          attempt = withWorkouts(attempt, attempt.workouts.map(x => (x === c ? cut : x)));
          attempt.adjustments.push(`W${w}: ${c.n} cut to ${hyroxMinRounds(c)} rounds (taper: the smallest ${circuits ? 'circuit' : 'brick'}, exempt from the ${fraction} fraction)`);
        }
      }
      if (taperWork) shed(a => a.workMin > taperWork.min + 1e-6 || a.workMtl > taperWork.mtl + 1e-6, true, "taper: the reference week's station and brick work");
      shed(raceTaper ? over : (a: Attempt) => a.min > beforeCapMin + 1e-6, false);
    }

    // What holds a training week under the chosen weekly hours (decision C,
    // Tristan 2026-10-13), read from the limit that binds (review 2026-10-13:
    // the note named the phase budget for weeks the fixed assessment held
    // above it, and 'the chosen sessions are full, each session at its
    // longest' for weeks whose runs sat well under their caps): a deload; the
    // phase budget (base and build weeks ramp toward the chosen hours), or the
    // fixed sessions that hold the week above it; the acute:chronic guard; the
    // MTL cap; the chosen session count, with what holds the sessions (the
    // running share, an easy run kept in a missing quality run's slot, each
    // session at its cap); no erg access; the injury gates. The note itself
    // is written with the week's detail, below.
    // The hours line's check (below): would one more chosen session hold at
    // least HYROX_RUN_FLOOR_MIN more of the week? The week is built again with
    // one more session in its structure and one more free slot, under the same
    // ceilings (fit sizes it). At the 7-session maximum: room under the guard
    // and the MTL cap for one more easy session at the run floor. Null when it
    // would; otherwise what the week's note says instead (round 6 review, pass
    // 3: weeks the line skipped still blamed the session count alone).
    const oneMoreSessionShort = (plannedMin: number): string | null => {
      if (chosenSessions >= 7) {
        const easyRun = generateHyroxRun({ kind: 'run_easy', targetMinutes: HYROX_RUN_FLOOR_MIN, band: hx.athleteBand, phase, slotIndex: w, bodyWeightKg: state.bodyWeightKg, runPaceSecKm: hx.hyroxRunPaceSecKm, seed: state });
        const ergMtlPerMin = hyroxEasyErgMtlPerMin(hx.stationAccess, state.bodyWeightKg);
        const mtlNeed = HYROX_RUN_FLOOR_MIN * Math.max(ergMtlPerMin ?? 0, (easyRun.musculoTendonLoad ?? 0) / HYROX_RUN_FLOOR_MIN);
        const tssNeed = HYROX_RUN_FLOOR_MIN * Math.max(ergTssPerMin, easyRunTssPerMin);
        const mtl = prescribed(attempt.workouts).reduce((a, x) => a + (x.musculoTendonLoad ?? 0), 0);
        if (capTss - attempt.guardTss < tssNeed - 1e-6) return `the acute:chronic guard leaves no room for a ${HYROX_RUN_FLOOR_MIN}-min session more`;
        if (hx.mtlCap - mtl < mtlNeed - 1e-6) return `the MTL cap leaves no room for a ${HYROX_RUN_FLOOR_MIN}-min session more`;
        return null;
      }
      const keep = { scale, ergCap, easyCap, sizeMin, omitted };
      plusOne = true;
      const plus = fit();
      const plusSized = sizeMin < hoursMin - 1e-6;
      plusOne = false;
      ({ scale, ergCap, easyCap, sizeMin, omitted } = keep);
      const more = hyroxPlannedMinutes(plus.workouts) - plannedMin;
      if (!over(plus) && more >= HYROX_RUN_FLOOR_MIN) return null;
      const holder = plusSized || plus.guardTss > capTss + 1e-6 ? 'the acute:chronic guard'
        : plus.adjustments.some(n => /MTL cap \d+/.test(n)) ? 'the MTL cap'
          : null;
      return `one more session would add ${Math.max(0, Math.round(more))} min${holder ? ` under ${holder}` : ''}`;
    };
    const hoursWhy: string[] = [];
    if (phase !== 'taper') {
      const ws = prescribed(attempt.workouts);
      const planned = hyroxPlannedMinutes(attempt.workouts);
      const n = attempt.adjustments.join(' | ');
      // The phase budget is named whenever it sits under the chosen hours
      // (round 6 review, pass 2: it was named only when the week came within
      // HYROX_RUN_FLOOR_MIN of it, so a base week the budget held 5 h under
      // the chosen hours named only the session count).
      const budgetBinds = budgetMin < hoursMin - 0.5;
      if (deloadRef) hoursWhy.push(`a deload holds at most ${HYROX_DELOAD_FACTOR} of the last loaded week`);
      else if (budgetBinds && planned > budgetMin + 0.5) {
        const fixed = ws.some(x => x.t === 'hyrox_assessment') ? 'the fixed assessment holds it above' : 'fixed session lengths hold it above';
        hoursWhy.push(`the ${phase} week's budget is ${Math.round(budgetMin)} min, ${fixed}`);
      } else if (budgetBinds) hoursWhy.push(`the ${phase} week's budget is ${Math.round(budgetMin)} min`);
      if (/acute:chronic guard/.test(n) || (!deloadRef && sizeMin < hoursMin - 1e-6)) hoursWhy.push('the acute:chronic guard holds its load');
      if (/MTL cap \d+/.test(n)) hoursWhy.push(`the MTL cap of ${hx.mtlCap} holds its load`);
      if (/are full/.test(n)) {
        const holds: string[] = [];
        const running = ws.reduce((a, x) => a + (x.discipline === 'run'
          ? (x.estimatedDurationMin ?? 0)
          : (x.hyroxComponents ?? []).filter(c => c.type === 'run').reduce((b, c) => b + ((c.durationSec ?? 0) * (x.hyroxRounds ?? 1)) / 60, 0)), 0);
        const runShare = runBudgetAt(sizeMin);
        const runsAtShare = runShare != null && running >= runShare - HYROX_RUN_FLOOR_MIN;
        if (runsAtShare) holds.push(`the running share of ${Math.round(runShare as number)} min holds the runs`);
        const fmtPhase = !raceWeek ? HYROX_QUALITY_FORMATS[tier][phase as 'base' | 'build' | 'peak'] : null;
        const holdsQuality = ws.some(x => x.t === 'hyrox_run_tempo' || x.t === 'hyrox_run_intervals');
        const standIn = fmtPhase != null && !holdsQuality && ws.some(isPlainEasyRun);
        if (standIn) holds.push("an easy run holds the missing quality run's slot");
        const ergs = ws.filter(isHyroxEasyErg);
        const ergMax = Math.min(lr.capMin, easyMaxMin ?? Infinity);
        const ergsAtCap = ergs.every(x => (x.estimatedDurationMin ?? 0) >= ergMax);
        // A station session is at its longest at the session cap (its
        // finisher full, lane H2b part 2); bricks hold fixed formats.
        const work = ws.filter(x => x.t === 'hyrox_station_technique' || x.t === 'hyrox_station_density');
        const workAtCap = work.every(x => (x.estimatedDurationMin ?? 0) >= lr.capMin - 1);
        if (runsAtShare && !standIn && ergsAtCap && workAtCap) hoursWhy.push(`${maxSessionsName} are full, each session at its longest`);
        else hoursWhy.push(`${maxSessionsName} are full${holds.length > 0 ? `, ${holds.join(', ')}` : ''}`);
      }
      if (/no erg access/.test(n)) hoursWhy.push('no erg access for easy erg work');
      if (/injury/.test(n)) hoursWhy.push('the injury gates');
    }

    const detail: HyroxWeekDetail = {
      week: w,
      phase,
      deload,
      raceWeek,
      budgetMin: Math.round(budgetAt(sizeMin)),
      plannedMin: hyroxPlannedMinutes(attempt.workouts),
      plannedTss: attempt.tss,
      acwrCapTss,
      guardExemptTss: acwrCapTss != null ? guardExemptTss(attempt.workouts) : 0,
      chronicSeedTss,
      chronicSeedSource,
      guardFloorTss,
      deloadCapMin,
      deloadCapTss,
      longRunMin: (() => {
        const l = attempt.workouts.find(isHyroxLongRun);
        return l ? (l.estimatedDurationMin ?? null) : null;
      })(),
      longestRunKm: longestRunKm(attempt.workouts),
      adjustments: attempt.adjustments,
      workouts: attempt.workouts,
    };
    // The chosen session count holds a loaded week under its size
    // (HyroxHoursFit): the week is built at the chosen hours (no ceiling sized
    // it or scaled it), the phase budget is the chosen hours (round 6 review,
    // pass 2: 79% of marked weeks were base and build weeks the phase budget
    // held hours under the chosen hours, which the line must not blame on the
    // sessions), it holds the chosen sessions HYROX_RUN_FLOOR_MIN or more under
    // the hours, the MTL cap holds none of it, and one more chosen session
    // would hold at least HYROX_RUN_FLOOR_MIN more: the same week built with
    // one more session, under the same ceilings (review: in 11% of marked weeks
    // one more session added under 20 min, the guard or the MTL cap holding
    // it). At the 7-session maximum the week has no session to add; its
    // ceilings must leave room for one more easy session at the run floor.
    const plannedMin = detail.plannedMin;
    const injured = !!(state as any).injuryState?.active && w >= (state.w ?? 1);
    const sessionsHeld = prescribed(attempt.workouts).length;
    if (!opts.noHoursLine && phase !== 'taper' && !raceWeek && !deload && !injured && fitsAtFullSize && hoursMin > 0
      && budgetMin >= hoursMin - 0.5
      && sessionsHeld >= chosenSessions && hoursMin - plannedMin >= HYROX_RUN_FLOOR_MIN
      && !attempt.adjustments.some(n => /MTL cap \d+/.test(n))) {
      const short = oneMoreSessionShort(plannedMin);
      if (short == null) detail.hoursFit = { sessions: sessionsHeld, plannedMin, chosenHours: hoursMin / 60 };
      else hoursWhy.push(short);
    }
    // A training week HYROX_RUN_FLOOR_MIN or more under the chosen weekly
    // hours says so in its notes, with what holds it (decision C).
    if (phase !== 'taper' && hoursMin > 0 && hoursMin - plannedMin >= HYROX_RUN_FLOOR_MIN) {
      const text = hoursWhy.length > 0 ? hoursWhy.join('; ') : 'the running share and the session caps hold it';
      detail.adjustments = [...detail.adjustments, `W${w}: ${plannedMin} of the chosen ${Math.round(hoursMin)} min (${text})`];
    }
    return detail;
  };

  for (let w = 1; w <= last; w++) {
    // The nominal week 1 that seeds the chronic window without a logged load
    // (D4): week 1 as the plan builds it with a station session in the
    // assessment's slot, under every rule of week 1 (its size, the
    // allocation order). Week 1 itself is unguarded without a logged load,
    // so it does not read the seed. Before (round 6 review of the solver
    // alone), the seed was the solver's attempt, which at 2 h could sit over
    // the week's own size (novice 2 h 9 weeks: 185 TSS for a 66-min week) and
    // let week 3 jump 2.15 times week 2's load.
    // Round 7 (Tristan 2026-10-14): the nominal week 1 is built without the
    // guard for every plan. It is the guard's floor, and the chronic seed is
    // the larger of it and the logged weekly load, so a logged load under the
    // plan's own first week counts as that week.
    if (w === 1) {
      guardFloorTss = buildWeek(1, true).plannedTss;
      chronicSeedTss = chronicSeedSource === 'logged' ? Math.max(loggedSeedTss, guardFloorTss) : guardFloorTss;
    }
    // The week's race simulation, when it holds one: a full sim the week
    // cannot hold (its size, the hierarchy's omissions) becomes a half sim,
    // and a half sim it cannot hold leaves the week its brick (sheet
    // sims.week_volume).
    let sim = sims.get(w);
    let d = buildWeek(w, false, sim);
    const holdsSim = (x: HyroxWeekDetail) => prescribed(x.workouts).some(isHyroxSim);
    while (sim && !holdsSim(d)) {
      // The week's own rules dropped the sim (the injury gates, the 110%
      // single-run rule): the week was built without it, and says why.
      if (d.adjustments.some(n => /no race simulation \(/.test(n))) break;
      // A full sim the 110% rule made a half: said; otherwise the size.
      const ruled = d.adjustments.some(n => /race simulation becomes a half/.test(n));
      const was = sim;
      sim = was.kind === 'full' && !ruled ? { kind: 'half', halfIndex: 0 } : undefined;
      const next = buildWeek(w, false, sim);
      if (!ruled) {
        next.adjustments = [...next.adjustments, sim
          ? `W${w}: the week holds a half race simulation, not the full (the full sim does not fit the week)`
          : `W${w}: no race simulation (it does not fit the week): the week keeps its brick`];
      }
      d = next;
    }
    built.push(d);
    noteLoadSteps(built[built.length - 1]);
    rememberLoads(built[built.length - 1]);
  }
  // The hours line, checked against the real plan with one more chosen
  // session (round 7; review of round 6, pass 3: in 7 of about 2,700 marked
  // weeks that plan added under HYROX_RUN_FLOOR_MIN to the week, or fewer
  // minutes, because its earlier weeks, built larger, lowered the week's
  // guard). The week-level check above still decides first (the line is
  // judged per week); a marked week whose plan with one more session (the
  // session counts the slider gives, applyHyroxSessionDelta) does not hold
  // HYROX_RUN_FLOOR_MIN more of it loses the line, and its hours note says
  // why. One more plan build, only for a plan with a marked week.
  const marked = opts.noHoursLine ? [] : built.filter(d => d.hoursFit);
  if (marked.length > 0 && chosenSessions < 7) {
    const plusCounts = applyHyroxSessionDelta(def, chosenSessions + 1 - hyroxSessionTotal(def));
    if (hyroxSessionTotal(plusCounts) > chosenSessions) {
      const plusState: SimulatorState = { ...state, hyroxConfig: { ...hx, runsPerWeek: plusCounts.runs, stationSessionsPerWeek: plusCounts.stations, bricksPerWeek: plusCounts.bricks } };
      const plus = buildHyroxTrainingWeeks(plusState, trainingWeeks, layout, marked[marked.length - 1].week, { storedBoundaryWeek: opts.storedBoundaryWeek, noHoursLine: true, weakestStation });
      for (const d of marked) {
        const more = (plus[d.week - 1]?.plannedMin ?? d.plannedMin) - d.plannedMin;
        if (more >= HYROX_RUN_FLOOR_MIN) continue;
        delete d.hoursFit;
        const head = `W${d.week}: ${d.plannedMin} of the chosen `;
        d.adjustments = d.adjustments.map(n => (n.startsWith(head) && n.endsWith(')')
          ? `${n.slice(0, -1)}; the plan with one more session adds ${Math.max(0, Math.round(more))} min to this week)`
          : n));
      }
    }
  }
  return built;
}

// ─── Single-week regenerator (used by injury-gate updates) ───────────────────

/**
 * Regenerate a single HYROX week in-place. Preserves the existing Week's
 * actuals / rated / skip arrays, replaces triWorkouts. Mirrors the tri
 * regenerator and is called after an injury gate change so the plan reflects
 * the new gates immediately (the version-bump path in main.ts only fires
 * when storedVersion < HYROX_GENERATOR_VERSION). The weeks before it are
 * rebuilt in memory, because the week's ceilings read them.
 */
export function regenerateHyroxWeek(state: SimulatorState, weekIndex: number): Week | null {
  return regenerateHyroxWeeksFrom(state, weekIndex, weekIndex)[0] ?? null;
}

/**
 * Regenerate weeks `fromWeek`..`toWeek` (default: the plan's last week) in
 * one build, each in place like regenerateHyroxWeek (actuals, rated and skip
 * kept, triWorkouts, notes and the hours line replaced). `fromWeek`'s
 * Sunday-to-Monday spacing reads the stored week before it; each later week
 * reads the week before as rebuilt here, the week the caller stores. The
 * injury modal regenerates every remaining week this way. Before (round 6
 * review, pass 2) it called regenerateHyroxWeek once per week, and each call
 * rebuilt weeks 1 to that week: up to 269 ms for a 24-week plan. An entry is
 * null for a week index outside the plan.
 */
export function regenerateHyroxWeeksFrom(state: SimulatorState, fromWeek: number, toWeek?: number): Array<Week | null> {
  if (!state.hyroxConfig || !state.wks) return [];
  const last = Math.min(toWeek ?? state.wks.length, state.wks.length);
  if (fromWeek < 1 || fromWeek > last) return [];
  const totalWeeks = state.tw || 16;
  const layout = storedPlanRaceLayout(totalWeeks, state.planStartDate, state.hyroxConfig.raceDate);
  const trainingWeeks = layout?.trainingWeeks ?? totalWeeks;
  const planPhases = computeHyroxPlanPhases(trainingWeeks);
  const builtUpto = Math.min(last, trainingWeeks);
  const built = fromWeek <= trainingWeeks
    ? buildHyroxTrainingWeeks(state, trainingWeeks, layout, builtUpto, { storedBoundaryWeek: fromWeek })
    : [];
  const out: Array<Week | null> = [];
  for (let weekIndex = fromWeek; weekIndex <= last; weekIndex++) {
    const existing = state.wks[weekIndex - 1];
    if (weekIndex > trainingWeeks) {
      // Closing week: it holds only the race.
      out.push({ ...existing, ph: 'taper', raceClosing: true, triWorkouts: [] });
      continue;
    }
    const p = planPhases[weekIndex - 1];
    if (!p) { out.push(null); continue; }
    const workouts = built[weekIndex - 1]?.workouts ?? [];
    const notes = built[weekIndex - 1]?.adjustments ?? [];
    const hoursFit = built[weekIndex - 1]?.hoursFit;
    const { hyroxPlanNotes: _old, hyroxHoursFit: _oldFit, ...rest } = existing;
    out.push({
      ...rest,
      ph: p.ph as any,
      ...(p.checkpoint ? { checkpoint: true } : { checkpoint: existing.checkpoint }),
      triWorkouts: workouts,
      ...(notes.length > 0 ? { hyroxPlanNotes: notes } : {}),
      ...(hoursFit ? { hyroxHoursFit: hoursFit } : {}),
    });
  }
  return out;
}

// ─── Top-level plan generator ─────────────────────────────────────────────────

/** The plan and each training week's detail (budget, planned load, guard,
 *  adjustments). generateHyroxPlan returns the weeks alone. */
export function generateHyroxPlanDetailed(state: SimulatorState): { weeks: Week[]; detail: HyroxWeekDetail[] } {
  if (!state.hyroxConfig) return { weeks: [], detail: [] };

  const totalWeeks = state.tw || 16;
  // Race week and the closing week follow the running layout (mirror of
  // generateTriathlonPlan): phases and the taper ramp run over the training
  // weeks, so race week is the week holding race day minus 3.
  const layout = storedPlanRaceLayout(totalWeeks, state.planStartDate, state.hyroxConfig.raceDate);
  const trainingWeeks = layout?.trainingWeeks ?? totalWeeks;
  const planPhases = computeHyroxPlanPhases(trainingWeeks);
  const detail = buildHyroxTrainingWeeks(state, trainingWeeks, layout);
  const weeks: Week[] = [];

  for (let w = 1; w <= totalWeeks; w++) {
    const closing = w > trainingWeeks;
    const p = closing ? { ph: 'taper' as const, checkpoint: false } : planPhases[w - 1];
    const phase = p.ph;
    const workouts = closing ? [] : (detail[w - 1]?.workouts ?? []);

    weeks.push({
      w,
      ph: phase as any,
      ...(closing ? { raceClosing: true } : {}),
      ...(p.checkpoint ? { checkpoint: true } : {}),
      triWorkouts: workouts,
      ...(!closing && (detail[w - 1]?.adjustments.length ?? 0) > 0 ? { hyroxPlanNotes: detail[w - 1].adjustments } : {}),
      ...(!closing && detail[w - 1]?.hoursFit ? { hyroxHoursFit: detail[w - 1].hoursFit } : {}),
      rated: {},
      skip: [],
      cross: [],
      wkGain: 0,
      workoutMods: [],
      adjustments: [],
      unspentLoad: 0,
      extraRunLoad: 0,
    });
  }

  return { weeks, detail };
}

export function generateHyroxPlan(state: SimulatorState): Week[] {
  return generateHyroxPlanDetailed(state).weeks;
}
