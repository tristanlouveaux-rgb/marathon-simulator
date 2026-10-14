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
 *      previous 4 planned weeks; weeks before week 1 count as the logged
 *      weekly load, else the nominal week 1, fixed when the plan is created).
 *      A week the guard or the deload ceiling cannot hold at the chosen hours
 *      is built at the largest size they hold, the same week at every chosen
 *      hours above it.
 *      Taper weeks: taperFraction (0.70 then 0.55) of the reference week's
 *      planned minutes, with the reference week's station and brick sessions,
 *      minutes and MTL as ceilings (never under the taper's smallest
 *      circuit).
 *   3. Sessions from the tier's weekly structure (HYROX_WEEKLY_STRUCTURE) and
 *      the athlete's session-count choice; no brick in base, before week 5 or
 *      in race week; race week holds no more runs than the reference week.
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
 *      session to its easy sibling, then its lowest-priority session.
 *   7. Easy erg work (discipline 'erg'): what the sessions leave of the
 *      week's size becomes easy SkiErg or row work, up to the athlete's
 *      chosen session total, in the MTL the week leaves under the cap, each
 *      session up to the tier long-run cap. An easy run's slot goes to it when
 *      the easy runs left keep every running minute and the week holds more.
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
 *      holding 20 min or more of it) is marked for the plan view's hours line
 *      (HyroxHoursFit).
 *  10. Wrap into Week[].
 */

import { dropSessionsOnOrAfterRaceDay, clearStoredPlanRaceWindow, raceWeekPrimerDow, PRIMER_MIN_DAYS_OUT, RACE_DAY_CLEAR_DAYS } from './race-day-rules';
import { storedPlanRaceLayout, type RaceWeekLayout } from './race-week-layout';
import { firstTrackedDow } from '@/ui/workout-status';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import type { HyroxConfig, HyroxStation } from '@/types/triathlon';
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
  HYROX_MAX_HARD_SESSIONS,
  HYROX_MAX_HARD_RUNS,
  HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK,
  HYROX_DAY_BEFORE_RACE_MAX_RUN_MIN,
  HYROX_RACE_WEEK_PRIMER_MIN,
  HYROX_EASY_RPE,
  HYROX_HOURS_RANGE,
  applyHyroxSessionDelta,
  hyroxSessionTotal,
  hyroxTier,
  hyroxBaseMultiplier,
  computeHyroxPlanPhases,
  type HyroxSessionCounts,
  type HyroxTier,
} from '@/constants/hyrox-constants';
import { ACWR_SAFE_HIGH } from '@/constants/triathlon-constants';
import { plannedTssPerMin } from '@/constants';
import {
  generateHyroxRun, generateHyroxStation, generateHyroxBrick, generateHyroxAssessment, hyroxEasyRunPaceSecKm, raceWeekCircuitStations, MIN_CIRCUIT_STATIONS, MIN_CIRCUIT_ROUNDS, hyroxRunLengthKm,
  withHyroxRounds, withoutHyroxStation, generateHyroxEasyErg, hyroxEasyErgMtlPerMin, isHyroxEasyErg, HYROX_EASY_ERG_TYPE,
} from './hyrox-generators';
import {
  findHyroxWeekSchedule, scheduleHyroxWeek, isHighIntensity as isHyroxHardSession, isHardRun, isEccentricSession,
  isHyroxLongRun, hyroxSundayFlags, HYROX_DAY_NAMES, HYROX_TEMPO_HOME_DOW, hyroxPreferredDays,
  type HyroxPrevSunday,
} from './scheduler.hyrox';
import { getDisciplineCapacity } from '@/injury/engine';
import { hyroxEffortMultiplier } from '@/calculations/effort-multiplier.hyrox';
import { hasRealRunningFitnessSignal } from '@/calculations/physiological-vdot';
import {
  ctlGapMultiplier, isHyroxDeloadWeek, isRaceWeek,
  LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, LONG_RUN_LOOKBACK_WEEKS, TAPER_LONG_RUN_FRACTION, LONG_SOFT_FLOOR_MIN,
} from './plan_engine';
import { taperFraction } from './phases';
import { loggedRuns, longestRunMinBetween, RECENT_LONGEST_WINDOW_DAYS } from './sharpening-block';
import { stampTriWorkoutIds } from './plan_engine.triathlon';

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
export const HYROX_GENERATOR_VERSION = 18;

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
function prescribed(ws: readonly Workout[]): Workout[] {
  return ws.filter(w => w.commute !== true);
}

/** Planned minutes of a HYROX week (commute runs excluded). */
export function hyroxPlannedMinutes(ws: readonly Workout[]): number {
  return prescribed(ws).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
}

/** Planned load of a HYROX week in canonical TSS (commute runs excluded):
 *  duration × plannedTssPerMin(type, RPE), the valuation the planned-day
 *  pricer applies to HYROX sessions (ui/planned-day-tss.ts). */
export function hyroxPlannedTss(ws: readonly Workout[]): number {
  return prescribed(ws).reduce(
    (a, w) => a + (w.estimatedDurationMin ?? 0) * plannedTssPerMin(w.t ?? '', w.rpe ?? w.r ?? 5),
    0,
  );
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
  return (s.discipline === 'station' || s.discipline === 'brick') && s.t !== 'hyrox_assessment' && !isHyroxEasyErg(s);
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
      if (!mtlCuttable(s) || (s.hyroxRounds ?? 0) <= MIN_CIRCUIT_ROUNDS) continue;
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
      const heaviest = (out[circuit].hyroxComponents ?? [])
        .filter(c => c.type !== 'run')
        .reduce((a, c) => (c.mtl > a.mtl ? c : a));
      out[circuit] = withoutHyroxStation(out[circuit], heaviest.type as HyroxStation);
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
type HyroxSessionCaps = Partial<Record<string, { min: number; rounds: number; stations: number }>>;

/** Cap class of a station or brick session type. */
function sessionCapClass(t: string): 'circuit' | 'brick' {
  return t === 'hyrox_brick' || t === 'hyrox_mini_brick' ? 'brick' : 'circuit';
}

/** The cap for a session type: its own entry, else its class's (a deload or
 *  taper week holding a type the reference week did not, e.g. the taper's
 *  technique circuit after a race-pace peak). */
function sessionCapFor(caps: HyroxSessionCaps | undefined, t: string): { min: number; rounds: number; stations: number } | undefined {
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
  /** The week's first schedulable weekday (workout-status firstTrackedDow)
   *  and realRunningSignal(state), computed once per plan build
   *  (buildHyroxTrainingWeeks) rather than at every build of the week. Unset:
   *  computed here. */
  firstDow?: number;
  realRunning?: boolean;
}

/** What a training week over its size (the acute:chronic guard, the deload
 *  ceiling, the weekly hours, the phase budget) leaves out, in this order,
 *  when cutting easy erg work and scaling the station work and easy runs
 *  down to their floors still leave it above: easy runs, stations out of
 *  each circuit down to MIN_CIRCUIT_STATIONS (the circuit stays; a station
 *  session's floor is 2 rounds of every station, 50 to 65 min, so before
 *  2026-10-13 a deload at low hours lost the whole circuit), the technique
 *  station session, the secondary brick, the brick (the constraint
 *  hierarchy's allocation order run backwards, buildHyroxTrainingWeeks). A
 *  deload takes the stations out of its circuits before its easy runs. Then
 *  the long run gives up its growth for the quality run (D3) and the quality
 *  run leaves ('quality'). A group whose omission would leave the week with
 *  no station session and no brick waits until the long run is trimmed to
 *  the run floor and left out (review 2026-10-13, round 2 and third pass); it
 *  leaves only when the week is still over without the long run, and the
 *  long run then takes back what fits. Within the station work, a product
 *  order: no source ranks sessions for this. */
const HYROX_GUARD_OMIT_ORDER = ['easy', 'stations', 'technique', 'light', 'brick'] as const;

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

/** The athlete's station benchmarks for the plan's format (the
 *  format-specific slot, falling back to the legacy pooled field). */
function hyroxStationBenchmarksOf(hx: HyroxConfig): Partial<Record<HyroxStation, number>> | undefined {
  const isDoublesFormat = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  return (isDoublesFormat ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles)
    ?? hx.stationBenchmarks as Partial<Record<HyroxStation, number>> | undefined;
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
 * per variant). The injury gates apply to it as to the week's own circuit
 * (current and future weeks). Null when the week cannot hold a circuit (race
 * week without enough of the remaining stations, or stations the injury gates
 * drop).
 */
export function hyroxRaceTaperFloorCircuit(state: SimulatorState, weekIndex: number, raceWeek: boolean): { min: number; mtl: number } | null {
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
    stationBenchmarks: hyroxStationBenchmarksOf(hx),
    raceWeek,
  });
  c = withHyroxRounds(c, MIN_CIRCUIT_ROUNDS);
  for (;;) {
    const st = (c.hyroxComponents ?? []).filter(x => x.type !== 'run');
    if (st.length <= MIN_CIRCUIT_STATIONS) break;
    const next = withoutHyroxStation(c, st.reduce((m, x) => (x.mtl > m.mtl ? x : m)).type as HyroxStation);
    if (next === c) break;
    c = next;
  }
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

  const scale = inputs.scale ?? 1;
  // Running: HYROX_RUN_SHARE of the chosen weekly minutes in a training week
  // (D2), of the week's own budget in a taper week. Station sessions and
  // bricks share the rest of the week's budget, as before.
  const runBudget = inputs.runBudgetMin ?? inputs.budgetMin * HYROX_RUN_SHARE;
  const nonRunBudget = inputs.budgetMin * (1 - HYROX_RUN_SHARE);
  const easyPace = hyroxEasyRunPaceSecKm(band, hx.hyroxRunPaceSecKm);
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
      const rounds = Math.max(MIN_CIRCUIT_ROUNDS, refCap.rounds);
      adjustments.push(`W${weekIndex}: ${out.n} cut to ${rounds} rounds (${ceilingName}: the reference week's)`);
      out = withHyroxRounds(out, rounds);
    }
    const maxStations = Math.max(MIN_CIRCUIT_STATIONS, refCap.stations);
    let cut = 0;
    for (;;) {
      const st = (out.hyroxComponents ?? []).filter(c => c.type !== 'run');
      if (st.length <= maxStations) break;
      const next = withoutHyroxStation(out, st.reduce((a, c) => (c.mtl > a.mtl ? c : a)).type as HyroxStation);
      if (next === out) break;
      out = next;
      cut++;
    }
    if (cut > 0) adjustments.push(`W${weekIndex}: ${cut} station(s) taken out of the ${out.n} (${ceilingName}: the reference week's ${maxStations})`);
    return out;
  };

  // Read benchmarks from the format-specific slot, falling back to legacy pooled field.
  const stationBenchmarks = hyroxStationBenchmarksOf(hx);

  // ── Station sessions and bricks share the non-running budget ──────────────
  // Week 1, first station slot is the assessment for everyone. Users with
  // existing benchmarks can skip/replace it like any other workout; taking it
  // again refreshes their numbers. Race week has no assessment: it passes
  // through every station, sleds included.
  const needsAssessment = weekIndex === 1 && !raceWeek && !inputs.noAssessment;
  const omit = new Set(inputs.omit ?? []);
  const guardNote = (what: string) => adjustments.push(`W${weekIndex}: ${what} left out (${ceilingName})`);
  const allKinds = stationKinds(tier, kindPhase, counts.stations);
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
  const nonRunSlots = sKinds.length + bKinds.length;
  const share = nonRunSlots > 0 ? nonRunBudget / nonRunSlots : 0;

  const makeStation = (kind: 'station_technique' | 'station_density', i: number): Workout => {
    const w = generateHyroxStation({
      kind,
      targetMinutes: clampDur(kind, share),
      band,
      stationAccess: hx.stationAccess,
      phase,
      slotIndex: i + weekIndex,
      bodyWeightKg,
      stationBenchmarks,
      raceWeek: !!raceWeek,
    });
    const maxRounds = inputs.maxCircuitRounds;
    let out = w;
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
        const heaviest = st.reduce((a, c) => (c.mtl > a.mtl ? c : a));
        const next = withoutHyroxStation(out, heaviest.type as HyroxStation);
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
      nonRun.push(generateHyroxAssessment({ band, stationAccess: hx.stationAccess, bodyWeightKg }));
      continue;
    }
    if (!raceWeekCircuitOk) continue;
    nonRun.push(makeStation(sKinds[i], i));
  }
  for (let i = 0; i < bKinds.length; i++) {
    const { kind, light } = bKinds[i];
    const b = generateHyroxBrick({
      kind,
      targetMinutes: clampDur(kind, share),
      band,
      stationAccess: hx.stationAccess,
      phase,
      slotIndex: i + weekIndex,
      bodyWeightKg,
      stationBenchmarks,
    });
    const capped = capToRef(b);
    nonRun.push(light ? { ...capped, n: 'Secondary Brick', hyroxLight: true } : capped);
  }
  // Running inside station and brick sessions counts toward the running
  // share: the run components of every station and brick session (today the
  // brick runs; the technique circuit's closing easy run is not a component
  // yet, it sits in the station content lane H2b owns, so the share does not
  // see it until H2b makes it one).
  const brickRunMin = nonRun
    .filter(w => w.discipline === 'brick' || w.discipline === 'station')
    .reduce((sum, w) => sum + (w.hyroxComponents ?? [])
      .filter(c => c.type === 'run')
      .reduce((a, c) => a + ((c.durationSec ?? 0) * (w.hyroxRounds ?? 1)) / 60, 0), 0);

  // ── Runs: the long run, the quality run, then easy runs ───────────────────
  const runParams = { band, phase, bodyWeightKg, runPaceSecKm: hx.hyroxRunPaceSecKm, thresholdPaceSecKm, maxHR: state.maxHR };
  const runs: Workout[] = [];
  // The running share left after the bricks' run segments: what the easy
  // runs get after the long run and the quality run (the hierarchy's
  // allocation step "running up to 0.40 x the chosen weekly minutes"); the
  // ceilings' scale shrinks it. A taper week's long run follows the taper
  // rule and is not trimmed here.
  const fitRoom = Math.max(0, runBudget - brickRunMin);
  let slots = counts.runs;
  const ceilingMin = inputs.runCeilingKm != null ? Math.floor((inputs.runCeilingKm * easyPace) / 60) : Infinity;

  let longMin = inputs.longRunMin != null && slots >= 1 ? Math.min(inputs.longRunMin, ceilingMin) : null;
  const trainingWeek = !raceWeek && kindPhase !== 'taper';
  const fmt = trainingWeek ? HYROX_QUALITY_FORMATS[tier][kindPhase as 'base' | 'build' | 'peak'] : null;
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
  const runRoom = Math.max(0, fitRoom * scale - (longMin ?? 0) - qMin());
  const easyScaled = inputs.easyRunCapMin != null ? Math.min(runRoom, Math.max(0, inputs.easyRunCapMin)) : runRoom;
  // A deload's easy runs hold the run floor under the scale when the
  // running share at full size funds it (easyHoldMin).
  const holdRoom = Math.max(0, (inputs.easyHoldRunBudgetMin ?? runBudget) - brickRunMin) - (longMin ?? 0) - qMin();
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
  const easyCapMin = Math.min(longMin ?? (raceWeek ? inputs.easyMaxMin ?? Infinity : Infinity), ceilingMin);
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
    each = Math.floor(Math.min(each, easyCapMin));
    if (each >= HYROX_RUN_FLOOR_MIN) {
      for (let i = 0; i < n; i++) {
        runs.push(generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: each, slotIndex: i + weekIndex }));
      }
    } else {
      n = 0;
    }
    if (n < slots) adjustments.push(`W${weekIndex}: ${slots - n} easy run(s) left out (${easyWhy})`);
  } else if (slots > 0) {
    adjustments.push(`W${weekIndex}: ${slots} easy run(s) left out (${easyWhy})`);
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
  const easyErgFor = (ws: readonly Workout[]): Workout[] => {
    const maxSessions = Math.min(inputs.maxSessions ?? 7, 7);
    const sessionsName = inputs.maxSessionsName ?? `${maxSessions} sessions`;
    const free = maxSessions - prescribed(ws).length - injuryFreedSlots;
    const unused = (inputs.fillMin ?? inputs.budgetMin) - hyroxPlannedMinutes(ws) - injuryFreedMin;
    if (unused < HYROX_RUN_FLOOR_MIN) return [];
    if (free <= 0) {
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
    const total = Math.min(unused, inputs.ergCapMin ?? Infinity, byMtl);
    const maxEach = Math.min(HYROX_LONG_RUN[tier].capMin, inputs.easyMaxMin ?? Infinity);
    const k = maxEach >= HYROX_RUN_FLOOR_MIN ? Math.min(free, Math.floor(total / HYROX_RUN_FLOOR_MIN)) : 0;
    if (k <= 0) {
      const why = byMtl < Math.min(unused, inputs.ergCapMin ?? Infinity) ? `MTL cap ${hx.mtlCap}` : ceilingName;
      adjustments.push(`W${weekIndex}: ${Math.round(unused)} min left unprescribed (${why})`);
      return [];
    }
    const each = Math.floor(Math.min(maxEach, total / k));
    const ergs: Workout[] = [];
    for (let i = 0; i < k; i++) {
      const e = generateHyroxEasyErg({ targetMinutes: each, stationAccess: hx.stationAccess, slotIndex: weekIndex + i, bodyWeightKg });
      if (e) ergs.push(e);
    }
    // The injury gates scale easy erg work with the station capacity, or
    // drop it; the notes name what the week holds.
    const kept = isPastWeek ? ergs : applyHyroxInjuryGates(ergs, injuryState, weeksFromCurrent);
    if (kept.length === 0) {
      adjustments.push(`W${weekIndex}: ${Math.round(unused)} min left unprescribed (injury: no easy erg work at the current station capacity)`);
      return [];
    }
    const keptEach = kept[0].estimatedDurationMin ?? each;
    const held = total < unused - 1e-6 ? ` (${byMtl < Math.min(unused, inputs.ergCapMin ?? Infinity) ? `MTL cap ${hx.mtlCap}` : ceilingName} holds it)` : '';
    adjustments.push(`W${weekIndex}: ${kept.length} easy erg session${kept.length === 1 ? '' : 's'} of ${keptEach} min (unprescribed minutes)${held}`);
    // Every slot taken and each session at its longest: the rest of the
    // budget stays unprescribed.
    const left = Math.round(total - k * each);
    if (!held && left >= HYROX_RUN_FLOOR_MIN) {
      adjustments.push(`W${weekIndex}: ${left} min left unprescribed (${sessionsName} are full, an easy erg session at most ${maxEach} min)`);
    }
    if (keptEach < each) adjustments.push(`W${weekIndex}: easy erg sessions cut to ${keptEach} min (injury: station capacity)`);
    return kept;
  };

  // Easy erg work absorbs the hours the session count leaves (decision C,
  // Tristan 2026-10-13): when the chosen sessions are full and easy erg work
  // could hold at least HYROX_RUN_FLOOR_MIN of what is left, a training week
  // frees a slot for it: its shortest easy run leaves, the easy runs left
  // take its minutes (each no longer than the long run, the 110% single-run
  // ceiling or the tier long-run cap), and the slot holds easy erg work, when
  // that gives the week more minutes. One slot a week, never the long run,
  // the quality run or the easy run standing in a missing quality run's slot.
  // Only when the easy runs left keep every running minute (round 6: easy
  // running ranks above easy erg work in the hierarchy's allocation), and
  // never with an active injury: the injury gates and the capability
  // substitution's offers decide that week (round 6; review 2026-10-13: with
  // stations gated and runs open, 138 of 630 training weeks lost an easy run,
  // the injured athlete's only gate-safe training, for an erg session the
  // gates then dropped). Before (review
  // 2026-10-13), one more hour funded another short run that took the easy
  // erg's slot, so the week held less: intermediate 23 weeks at 7 h held 36 to
  // 51 min less a week than at 6 h through build and peak (an easy run of 22
  // min in place of an easy erg session of 60 to 75), and total plan minutes
  // fell as hours rose in 26 band/length pairs. A product choice: no source
  // ranks an easy run against easy erg work when the session count binds.
  const ergSlotFor = (ws: Workout[]): Workout[] => {
    if (!trainingWeek) return ws;
    if (!isPastWeek && injuryState?.active) return ws;
    const maxSessions = Math.min(inputs.maxSessions ?? 7, 7);
    const mtlPerMin = hyroxEasyErgMtlPerMin(hx.stationAccess, bodyWeightKg);
    if (mtlPerMin == null) return ws;
    const maxEach = Math.min(HYROX_LONG_RUN[tier].capMin, inputs.easyMaxMin ?? Infinity);
    // Free slots whose easy erg sessions, each at its longest, already hold
    // what the week leaves: no slot to free. (Round 6: with one slot free and
    // its session at the cap, one more hour funded a third 22-min easy run in
    // the slot a 63-min easy erg session held, intermediate 4 weeks at 7 h
    // with the 7-session choice, and the week held 29 min less than at 6 h.)
    const free = maxSessions - prescribed(ws).length - injuryFreedSlots;
    const unusedNow = (inputs.fillMin ?? inputs.budgetMin) - hyroxPlannedMinutes(ws) - injuryFreedMin;
    if (free > 0 && unusedNow - free * maxEach < HYROX_RUN_FLOOR_MIN) return ws;
    // What one easy erg session could hold beside a week.
    const ergRoom = (x: readonly Workout[]): number => {
      const unused = (inputs.fillMin ?? inputs.budgetMin) - hyroxPlannedMinutes(x) - injuryFreedMin;
      const mtlRoom = hx.mtlCap - x.reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
      const byMtl = mtlPerMin > 0 ? Math.max(0, mtlRoom) / mtlPerMin : Infinity;
      return Math.floor(Math.min(unused, inputs.ergCapMin ?? Infinity, byMtl, maxEach));
    };
    // A week whose tier format calls for a quality run and that holds none
    // (the running share, a ceiling or the spacing left it out) keeps one
    // easy run in its slot, the longest: the slot the quality run takes when
    // one more hour funds it. Easy erg work never takes it, so the quality
    // run's arrival does not shorten the week (monotonicity, reported).
    const holdsQuality = ws.some(w => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals');
    const standIn = fmt != null && structureRuns >= 2 && !holdsQuality ? 1 : 0;
    const all = ws.filter(isPlainEasyRun).sort((a, b) => (a.estimatedDurationMin ?? 0) - (b.estimatedDurationMin ?? 0));
    const candidates = all.slice(0, Math.max(0, all.length - standIn));
    if (candidates.length === 0) return ws;
    // The shortest easy run gives up its slot; the easy runs left share the
    // week's easy running, each no longer than the long run, the 110%
    // single-run ceiling or the tier long-run cap.
    const out = candidates[0];
    const rest = all.filter(w => w !== out);
    const easyMin = all.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
    // With an easy run standing in a missing quality run's slot, no easy run
    // grows past the quality run's length: when one more hour funds it, it
    // takes that slot without shortening the week.
    const qualityMin = standIn && fmt
      ? (generateHyroxRun({ ...runParams, kind: fmt.kind, targetMinutes: 0, format: fmt, slotIndex: weekIndex }).estimatedDurationMin ?? Infinity)
      : Infinity;
    const each = rest.length > 0 ? Math.floor(Math.min(easyCapMin, HYROX_LONG_RUN[tier].capMin, qualityMin, easyMin / rest.length)) : 0;
    const resized = new Map(rest.map(w => [w, (w.estimatedDurationMin ?? 0) >= each ? w : {
      ...generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: each, slotIndex: weekIndex }),
      ...(w.modReason ? { modReason: w.modReason } : {}),
    }] as const));
    const next = ws.filter(w => w !== out).map(w => resized.get(w) ?? w);
    // The easy runs left keep the week's easy running (whole minutes: each
    // run's share is rounded down).
    const easyAfter = next.filter(isPlainEasyRun).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
    if (easyAfter < easyMin - rest.length) return ws;
    const room = ergRoom(next);
    if (room < HYROX_RUN_FLOOR_MIN) return ws;
    const probe = generateHyroxEasyErg({ targetMinutes: room, stationAccess: hx.stationAccess, slotIndex: weekIndex, bodyWeightKg });
    if ((probe?.estimatedDurationMin ?? 0) <= 0) return ws;
    const kept = rest.length > 0 ? `, the easy running shared by ${rest.length} easy run${rest.length === 1 ? '' : 's'} of ${Math.max(each, ...rest.map(w => w.estimatedDurationMin ?? 0))} min` : '';
    adjustments.push(`W${weekIndex}: Easy Run of ${out.estimatedDurationMin} min left out for an easy erg session of up to ${room} min${kept} (the chosen sessions are full)`);
    return next;
  };

  // Schedule. Race week: each session only on the days the race-day rules
  // allow; one that finds no free allowed day is left out (raceWeekDays).
  // Other weeks: the hard-day and 48 h rules always hold; when no placement
  // keeps them, a hard session takes its easy sibling, then the
  // lowest-priority session leaves the week.
  let scheduled: Workout[];
  const placed = raceWeek?.layout ? { ...raceWeek, layout: raceWeek.layout } : null;
  if (raceWeek) {
    const dropped: Workout[] = [];
    scheduled = scheduleHyroxWeek(
      [...week, ...easyErgFor(week)], band,
      placed ? (w) => raceWeekDays(placed, weekIndex, w) : undefined,
      { prevSunday: inputs.prevSunday, dropped },
    );
    for (const d of dropped) adjustments.push(`W${weekIndex}: ${d.n} left out (no race-week day the race-day rules allow)`);
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
      let freed = ergSlotFor(week);
      let ergs = easyErgFor(freed);
      if (freed !== week) {
        const swapNotes = adjustments.slice(mark);
        adjustments.length = mark;
        const plain = easyErgFor(week);
        const total = (ws: readonly Workout[], es: readonly Workout[]) => hyroxPlannedMinutes(ws) + hyroxPlannedMinutes(es);
        if (ergs.length > 0 && total(freed, ergs) > total(week, plain)) {
          adjustments.length = mark;
          adjustments.push(...swapNotes);
        } else {
          freed = week;
          ergs = plain;
        }
      }
      if (ergs.length > 0) {
        const again = findHyroxWeekSchedule([...freed, ...ergs], { prevSunday: inputs.prevSunday });
        if (again) {
          week = freed;
          scheduled = again;
        } else {
          adjustments.length = mark;
          adjustments.push(`W${weekIndex}: ${ergs.reduce((a, e) => a + (e.estimatedDurationMin ?? 0), 0)} min of easy erg work left out (no day the spacing rules leave free)`);
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
  const isBrick = (w: Workout): boolean => {
    const t = (w.t || '') as string;
    return t === 'hyrox_brick' || t === 'hyrox_mini_brick';
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

  const out: Workout[] = [];
  for (const w of workouts) {
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
   *  (canonical TSS, D4): the athlete's logged weekly load (signalBBaseline)
   *  as stored when the plan was created (hyroxConfig.planChronicSeed),
   *  otherwise the nominal week 1 (its structure with a station session in
   *  the assessment's slot). The same on every week. */
  chronicSeedTss: number;
  chronicSeedSource: 'logged' | 'nominal';
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
        slotIndex: weekIndex, bodyWeightKg: state.bodyWeightKg, runPaceSecKm: hx.hyroxRunPaceSecKm,
      });
      return { ...run, id: w.id, dayOfWeek: w.dayOfWeek, dayName: w.dayName };
    });
  }
  const windowed = clearStoredPlanRaceWindow(moveLongRunOutOfRaceWindow(generated, weekIndex, layout, firstDow), {
    weekIndex,
    layout,
    isLongSession: (w) => w.t === 'hyrox_brick',
    isHard: isHyroxHardSession,
    firstScheduleDow: firstDow,
    dayNames: HYROX_DAY_NAMES,
  });
  noteDropped(generated, windowed, 'the last 6 days before race day');
  return windowed;
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

/** Longest duration, most rounds and most stations per station and brick
 *  session type in a week, and per class ('circuit': technique or race pace;
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
 *  work. */
function stationWorkOf(ws: readonly Workout[]): { min: number; mtl: number } {
  let min = 0;
  let mtl = 0;
  for (const w of prescribed(ws)) {
    if (!isHyroxWork(w)) continue;
    min += w.estimatedDurationMin ?? 0;
    mtl += w.musculoTendonLoad ?? 0;
  }
  return { min, mtl };
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
 *    - the race taper at taperFraction (0.70, then 0.55) of the reference
 *      week, with its station and brick work as ceilings (never under the
 *      taper's smallest circuit, hyroxRaceTaperFloorCircuit) and never above
 *      the week before (taperDropRank sheds sessions until they hold);
 *    - no brick in base, before HYROX_FIRST_BRICK_WEEK or in race week
 *      (weekSessionCounts), and the race-week closing rules
 *      (hyroxWeekForRace, raceWeekDays).
 * 2. WEEK SIZE = min(the chosen weekly hours, the acute:chronic guard
 *    (ACWR_SAFE_HIGH x the mean of the previous HYROX_CHRONIC_WINDOW_WEEKS
 *    planned weeks, the weeks before week 1 seeded per D4), the phase budget
 *    (week 1's assessment exempt), the deload or taper fraction).
 *    - The guard and the deload ceiling do not depend on the chosen hours. A
 *      week they cannot hold at the chosen hours is built at the largest size
 *      in minutes they hold (a bisection over a fixed range, fit): its
 *      budget-sized inputs (the station sessions' share of the phase budget,
 *      the running share, the easy erg fill) read that size, and step 3
 *      allocates inside it. So that week is the same at every chosen hours
 *      above its size, and so are its load and every later week's guard.
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
 *       min), in its own discipline ('erg'), never a station session. An easy
 *       run's slot goes to it only when the easy runs left keep every running
 *       minute, and never with an active injury (ergSlotFor).
 *    A week over its size gives way in reverse order: e, d, c, then a's
 *    long-run growth for the quality run (D3), then the quality run. The one
 *    exception: b leaves only after the long run has shortened to the run
 *    floor and left the week, so every training week keeps HYROX work (the
 *    round-4 guarantee). Measured 2026-10-14 on 629 plans (every band, its
 *    hours grid, lengths 8 to 24), training weeks after week 1 without
 *    station or brick work, strict order against this exception: 372 (340 at
 *    2 h) against 0 at the nominal seed, 1,865 against 0 at a logged 20 TSS,
 *    725 against 0 at 100 TSS. The exception costs quality runs (of 5,714
 *    loaded weeks whose format calls for one): 4,543 against 4,641, 16
 *    against 384 and 3,742 against 4,021.
 * 4. MTL CAP (the cap alone): easy erg work is sized inside what the cap
 *    leaves, then easy runs shorten and leave (never the long run or the
 *    quality run), then station rounds and stations go (never the week's
 *    last station session); a week still over the cap says so
 *    (enforceMTLCap).
 * 5. MONOTONICITY is reported, not enforced: one more chosen hour may
 *    restructure a week, and no quality run is removed to hold the minutes.
 *    The rules test reports every adjacent-hour pair whose total plan
 *    minutes fall and bounds the fall to one easy session (the tier long-run
 *    cap) at the default sessions, in open doubles and at logged loads of 20,
 *    50 and 100 TSS. With the 7-session choice and at 200 TSS a few pairs
 *    fall further, all from step 3's easy running ranking above easy erg
 *    work: one more hour funds an easy run that takes the slot, or the MTL
 *    room, an easy erg session held.
 * Deloads also hold an easy run at the run floor under the shared scale and
 * take stations out of their circuits before an easy run leaves
 * (easyHoldMin). A loaded week the chosen session count holds under its size
 * is marked for the plan view (HyroxHoursFit: the phase budget is the chosen
 * hours, no ceiling sized the week, and one more chosen session would hold
 * at least HYROX_RUN_FLOOR_MIN more of it).
 *
 * Each week reads the weeks before it:
 * the acute:chronic guard (planned TSS at most ACWR_SAFE_HIGH × the mean of the
 * previous HYROX_CHRONIC_WINDOW_WEEKS weeks; Tristan 2026-10-12, Gabbett 2016's
 * 0.8 to 1.3 sweet spot, the same bound as running's week-1 ACWR_SAFETY_CAP),
 * whose window counts each week before week 1 as the athlete's logged weekly
 * load when it exists, otherwise as the nominal week 1 (D4); the deload
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
  opts: { storedBoundaryWeek?: number } = {},
): HyroxWeekDetail[] {
  const hx = state.hyroxConfig!;
  const tier = hyroxTier(hx.athleteBand);
  const planPhases = computeHyroxPlanPhases(trainingWeeks);
  const phaseList = planPhases.map(p => p.ph as TrainingPhase);
  const easyPace = hyroxEasyRunPaceSecKm(hx.athleteBand, hx.hyroxRunPaceSecKm);
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
  const easyRunTssPerMin = plannedTssPerMin('hyrox_run_easy', HYROX_EASY_RPE);

  const last = Math.min(upto, trainingWeeks);
  // The chosen weekly hours (minutes): a ceiling on every training week.
  const hoursMin = (hx.weeklyHoursAvailable ?? 0) * 60;
  // The weeks built so far, in order: each week's rules read them.
  const built: HyroxWeekDetail[] = [];
  // The guard's chronic seed (D4): the logged weekly load, or the nominal
  // week 1, computed when week 1 is built.
  let chronicSeedTss = loggedSeedTss;
  let seedSet = chronicSeedSource === 'logged';
  // What a week's rules read from the weeks before it: the deload and its
  // reference, the single-run ceiling, the acute:chronic guard and the
  // previous Sunday.
  const historyLimits = (w: number) => {
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
    // deload's reference.
    const refWeek = [...built].reverse().find(b => b.phase !== 'taper' && !b.deload);
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
    const acwrCapTss = phase !== 'taper' && (w >= 2 || chronicSeedSource === 'logged')
      ? ACWR_SAFE_HIGH * chronicMean()
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
  const buildWeek = (w: number, nominal = false): HyroxWeekDetail => {
    const { phase, raceWeek, deload, runCeilingKm, prevLongRun, prevLoadedLong, refWeek, deloadRef, acwrCapTss, weekPrevSunday } = historyLimits(w);
    const effortMult = w >= (state.w ?? 1) ? effortNow : 1.0;
    const firstDow = firstTrackedDow(state.planStartDate, w, state.planCreatedAt);
    // MTL-gap re-anchor (mirror of running's CTL-gap, SCIENCE_LOG §BR): reduce-only,
    // suppressed on deload/taper and past weeks, combined with effort under ONE clamp
    // [HYROX_ADAPTIVE_FLOOR, 1.15] so the two volume levers can't overstack.
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
        // Race taper: taperFraction (0.70 then 0.55; SCIENCE_LOG §CV.4) of the
        // reference week, the last loaded week before the taper.
        const refMin = refWeek ? refWeek.plannedMin : hoursMin * HYROX_PEAK_MULT;
        budgetMin = taperFraction(w - taperStart + 1, taperLen) * refMin;
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
        const deloaded = deloadRef
          ? Math.round(Math.min(stepped, deloadRef.longRunMin ?? stepped) * HYROX_DELOAD_FACTOR * Math.min(1, adaptive))
          : Math.round(stepped * (deload ? HYROX_DELOAD_FACTOR : 1) * adaptive);
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
    let ceilingName: string | undefined = deloadRef ? 'deload ceiling' : raceTaper ? 'taper' : undefined;
    // The race taper's station and brick ceilings: the reference week's
    // minutes and MTL, never under the taper's smallest circuit
    // (hyroxRaceTaperFloorCircuit), still inside the 0.70 / 0.55 fractions.
    const refWork = taperRef ? stationWorkOf(taperRef.workouts) : undefined;
    const floorCircuit = refWork ? hyroxRaceTaperFloorCircuit(state, w, raceWeek) : null;
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
    const attemptOf = (workouts: Workout[], adjustments: string[]) => {
      const work = stationWorkOf(workouts);
      const ergMin = prescribed(workouts).filter(isHyroxEasyErg).reduce((a, x) => a + (x.estimatedDurationMin ?? 0), 0);
      const easyMin = prescribed(workouts).filter(isPlainEasyRun).reduce((a, x) => a + (x.estimatedDurationMin ?? 0), 0);
      const tss = hyroxPlannedTss(workouts);
      const min = hyroxPlannedMinutes(workouts);
      return {
        workouts, adjustments, tss, guardTss: tss - guardExemptTss(workouts), min,
        budgetedMin: min - hyroxPlannedMinutes(assessmentOf(workouts)),
        workMin: work.min, workMtl: work.mtl, ergMin, easyMin,
      };
    };
    // Set while the hours line checks the week with one more chosen session.
    let plusOne = false;
    // The week's builds by their inputs: the size search, the feasibility
    // check and the fit that follows it build some weeks more than once. Each
    // caller gets its own notes array (callers add notes to the week they
    // keep).
    const weekBuilds: Map<string, Attempt> = new Map();
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
        maxHardSessions, maxQualityRuns, prevRunMin, maxCircuitRounds, sessionCaps, ceilingName,
        runBudgetMin: runBudgetAt(sizeMin), fillMin: fillAt(sizeMin), ergCapMin: ergBlocked ? 0 : ergCap, easyRunCapMin: easyCap,
        easyHoldMin, easyHoldRunBudgetMin: easyHoldMin != null ? runBudgetMin : undefined, ceilingSized: sized,
        longFixed, easyMaxMin, maxSessions: plusOne ? maxSessions + 1 : maxSessions, maxSessionsName, maxRuns, noAssessment,
        runFloorMin, extraSession: plusOne, firstDow, realRunning,
      }, adjustments);
      return attemptOf(workouts, adjustments);
    };
    type Attempt = ReturnType<typeof makeWeek>;
    // Step 2 of the constraint hierarchy, the week's size: the acute:chronic
    // guard (training weeks), the deload ceiling (deload weeks), the chosen
    // weekly hours and the phase budget (training weeks; week 1's assessment
    // exempt from the budget) and, in a taper week, the taper budget
    // (taperFraction × the reference week), the reference week's station and
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
      limits.push({ cap: capMin, of: a => a.min, ergPerMin: 1 });
    }
    if (phaseCapMin < Infinity) limits.push({ cap: phaseCapMin, of: a => a.budgetedMin, ergPerMin: 1 });
    if (beforeCapMin < Infinity) limits.push({ cap: beforeCapMin, of: a => a.min, ergPerMin: 1 });
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
    const fit = (full?: Attempt) => {
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
      if (fixedLimits.length > 0 && fixedOver(a)) {
        fixedBound = true;
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
      if (a.ergMin > 0) {
        let cut = 0;
        let ergCan = true;
        for (const l of limits) {
          const excess = l.of(a) - l.cap;
          if (excess <= 1e-6) continue;
          if (l.ergPerMin <= 0) { ergCan = false; break; }
          cut = Math.max(cut, excess / l.ergPerMin);
        }
        if (ergCan && cut < a.ergMin) {
          ergCap = Math.max(0, Math.floor(a.ergMin - cut));
          a = make();
          if (!over(a)) return a;
        }
      }
      ergCap = 0;
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
      if (fixedBound) {
        sizeMin = 0;
        smallest = make();
        if (fixedOver(smallest)) return { week: smallest, ok: false, probe: smallest };
      }
      sizeMin = hoursMin;
      const a = make();
      if (!over(a)) return { week: a, ok: true, probe: a };
      if (fixedLimits.length > 0 && fixedOver(a)) {
        fixedBound = true;
        if (!smallest) {
          sizeMin = 0;
          smallest = make();
          if (fixedOver(smallest)) return { week: smallest, ok: false, probe: smallest };
        }
        if (!over(smallest)) return { week: null, ok: true, probe: smallest };
      }
      const f = fit();
      return { week: f, ok: !over(f), probe: f };
    };
    // Would fit() hold the week within its size? The same answer as
    // !over(fit()) (fitOrDefer). The solver's state is restored.
    const feasible = (): boolean => {
      const keep = { scale, ergCap, easyCap, sizeMin };
      const { ok } = fitOrDefer();
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
    let attempt = fit(ceilingName === nameBuilt ? fullWeek : undefined);
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
      const order: readonly HyroxGuardOmit[] = deloadRef
        ? ['stations', 'easy', 'technique', 'light', 'brick']
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
          attempt = fit();
          continue;
        }
        if (trial.week) attempt = trial.week;
        else pending = true;
      }
      const longWanted = longRunMin;
      let heldNote: string | undefined;
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
          else attempt = fit();
        }
      }
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
    const fraction = raceTaper ? taperFraction(w - taperStart + 1, taperLen) : null;
    const whyOf = (a: Attempt): string => (raceTaper && (a.min > capMin + 1e-6 || a.workMin > (taperWork?.min ?? Infinity) + 1e-6 || a.workMtl > (taperWork?.mtl ?? Infinity) + 1e-6))
      ? `taper: ${Math.round(budgetMin)} min, ${fraction} of ${taperRef ? 'the reference week' : 'the weekly hours'}`
      : 'the taper never rises';
    const shed = (tooHeavy: (a: Attempt) => boolean, workOnly: boolean, fixedWhy?: string) => {
      while (tooHeavy(attempt)) {
        const cur = attempt;
        // Race week keeps its last run (it holds a run whenever it holds a
        // run slot; the primer never leaves, SCIENCE_LOG CE update 4).
        const runsLeft = prescribed(cur.workouts).filter(x => x.discipline === 'run').length;
        const candidates = cur.workouts
          .filter(x => taperDropRank(x, raceWeek) >= 0)
          .filter(x => !workOnly || isHyroxWork(x))
          .filter(x => !(raceWeek && x.discipline === 'run' && !x.commute && runsLeft <= 1))
          .sort((a, b) => taperDropRank(a, raceWeek) - taperDropRank(b, raceWeek));
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
    // and the MTL cap for one more easy session at the run floor.
    const oneMoreSessionHolds = (plannedMin: number): boolean => {
      if (chosenSessions >= 7) {
        const easyRun = generateHyroxRun({ kind: 'run_easy', targetMinutes: HYROX_RUN_FLOOR_MIN, band: hx.athleteBand, phase, slotIndex: w, bodyWeightKg: state.bodyWeightKg, runPaceSecKm: hx.hyroxRunPaceSecKm });
        const ergMtlPerMin = hyroxEasyErgMtlPerMin(hx.stationAccess, state.bodyWeightKg);
        const mtlNeed = HYROX_RUN_FLOOR_MIN * Math.max(ergMtlPerMin ?? 0, (easyRun.musculoTendonLoad ?? 0) / HYROX_RUN_FLOOR_MIN);
        const tssNeed = HYROX_RUN_FLOOR_MIN * Math.max(ergTssPerMin, easyRunTssPerMin);
        const mtl = prescribed(attempt.workouts).reduce((a, x) => a + (x.musculoTendonLoad ?? 0), 0);
        return capTss - attempt.guardTss >= tssNeed - 1e-6 && hx.mtlCap - mtl >= mtlNeed - 1e-6;
      }
      const keep = { scale, ergCap, easyCap, sizeMin, omitted };
      plusOne = true;
      const plus = fit();
      plusOne = false;
      ({ scale, ergCap, easyCap, sizeMin, omitted } = keep);
      return !over(plus) && hyroxPlannedMinutes(plus.workouts) - plannedMin >= HYROX_RUN_FLOOR_MIN;
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
        const work = ws.filter(isHyroxWork).filter(x => x.t !== 'hyrox_assessment');
        const workAtCap = work.every(x => (x.estimatedDurationMin ?? 0) >= (HYROX_SESSION_MAX_MIN[(x.t ?? '').replace(/^hyrox_/, '')] ?? 90) - 1);
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
    if (phase !== 'taper' && !raceWeek && !deload && !injured && fitsAtFullSize && hoursMin > 0
      && budgetMin >= hoursMin - 0.5
      && sessionsHeld >= chosenSessions && hoursMin - plannedMin >= HYROX_RUN_FLOOR_MIN
      && !attempt.adjustments.some(n => /MTL cap \d+/.test(n))
      && oneMoreSessionHolds(plannedMin)) {
      detail.hoursFit = { sessions: sessionsHeld, plannedMin, chosenHours: hoursMin / 60 };
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
    if (w === 1 && !seedSet) {
      chronicSeedTss = buildWeek(1, true).plannedTss;
      seedSet = true;
    }
    built.push(buildWeek(w));
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
