/**
 * HYROX plan engine.
 *
 * Generates a full HYROX training plan as Week[] compatible with the rest
 * of the app (triWorkouts field, same Week schema as triathlon mode).
 *
 * Generation flow (planning side; parameter sheet 2026-10-12 and Tristan's
 * decisions of the same day). Weeks are built in order, because each week's
 * ceiling reads the weeks before it:
 *   1. Phase each week (base → build → peak → taper) from computeHyroxPlanPhases
 *      (2-week race taper, HYROX_TAPER_WEEKS_MIN).
 *   2. Week budget: weekly hours × the nominal phase multiplier × deload
 *      (0.75 every 4th week, never the week right before the race taper,
 *      isHyroxDeloadWeek) × the effort / MTL-gap lever. Taper weeks:
 *      taperFraction (0.70 then 0.55) of the reference week's planned minutes,
 *      with the reference week's station and brick sessions, minutes and MTL
 *      as ceilings.
 *   3. Sessions from the tier's weekly structure (HYROX_WEEKLY_STRUCTURE) and
 *      the athlete's session-count choice; no brick in base, before week 5 or
 *      in race week; race week holds no more runs than the reference week.
 *   4. Running is at most HYROX_RUN_SHARE of the chosen weekly hours in a
 *      training week, of the week's own budget in a taper week (standalone
 *      runs plus brick runs): the long run first (tier start, step and cap,
 *      the 110% single-run rule), then the quality run (tier format; the long
 *      run gives up its growth for it, never its previous length), then easy
 *      runs, none longer than the long run. Station sessions and bricks share
 *      the rest of the week's budget.
 *   5. Weekly MTL cap: easy runs shorten and leave first, then the long run
 *      gives up its growth (never its previous length), then station and
 *      brick rounds and stations go (real volume); the week's last station
 *      work stays.
 *   6. Schedule with the hard-day and 48 h eccentric rules, Sunday to Monday
 *      included (scheduler.hyrox). A week the rules cannot hold loses a hard
 *      session to its easy sibling, then its lowest-priority session.
 *   7. Easy erg work (discipline 'erg'): what the sessions leave of the
 *      week's budget becomes easy SkiErg or row work, up to the athlete's
 *      chosen session total, in the MTL the week leaves under the cap, each
 *      session up to the tier long-run cap. With the chosen sessions full, a
 *      training week's shortest easy run gives up its slot when the easy erg
 *      session holds more (the easy runs left keep its minutes). Neither hard
 *      nor eccentric. It never fills what the injury gates took, nor the slot
 *      of the week's last station session or brick, nor a missing quality
 *      run's slot.
 *   8. Acute:chronic guard: a training week's planned load (canonical TSS) is
 *      at most ACWR_SAFE_HIGH × the mean of the previous 4 planned weeks (weeks
 *      before week 1 count as the athlete's logged weekly load, else as the
 *      nominal week 1, fixed when the plan is created; week 1's assessment is
 *      exempt from week 1's guard). Over it, easy erg work gives way first,
 *      then easy running, then the station work shrinks and the week is
 *      rebuilt; the long run is
 *      trimmed to the run floor, then left out, before the week's last
 *      station session or brick, which leaves only when the week is still
 *      over without the long run.
 *   9. Wrap into Week[].
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
): HyroxSessionCounts {
  const def = HYROX_WEEKLY_SESSIONS[hx.athleteBand];
  const chosen = hyroxSessionTotal({
    runs: hx.runsPerWeek ?? def.runs,
    stations: hx.stationSessionsPerWeek ?? def.stations,
    bricks: hx.bricksPerWeek ?? def.bricks,
  });
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
  /** Minutes at easy pace that cover a distance (km): the long run never
   *  shortens under another run's distance (no other run longer than the
   *  long run). */
  easyMinFor: (km: number) => number;
  /** Taper weeks keep their run count: easy runs shorten, never leave. */
  keepRunCount: boolean;
  /** The longest long run of the previous LONG_RUN_LOOKBACK_WEEKS weeks
   *  (minutes; unset: none). The cap takes the long run's growth, never its
   *  previous length (the D3 rule). */
  prevLongRunMin?: number;
}

/** A standalone easy run that is not the long run (commute runs excluded). */
function isPlainEasyRun(w: Workout): boolean {
  return w.t === 'hyrox_run_easy' && !isHyroxLongRun(w) && w.commute !== true;
}

/**
 * Weekly MTL cap (rules_to_code 16). While the week's MTL is above the cap,
 * easy running gives way first and the HYROX-specific station work last
 * (Tristan 2026-10-13, decision A):
 *   1. easy runs shorten toward the run floor, then leave the week, shortest
 *      first (taper weeks keep their run count: shortened only); the runs
 *      left take back what the cut freed, up to their length;
 *   2. the long run gives up its growth: it shortens down to the longest
 *      long run of the previous 4 weeks (at least LONG_SOFT_FLOOR_MIN, or its
 *      own length when that is shorter), never under it (the D3 rule);
 *   3. one round off the highest-MTL station or brick session above
 *      MIN_CIRCUIT_ROUNDS (withHyroxRounds cuts the real volume: work, rest,
 *      duration and the description's round count);
 *   4. with every session at MIN_CIRCUIT_ROUNDS, the highest-MTL station out
 *      of the highest-MTL circuit holding more than MIN_CIRCUIT_STATIONS
 *      (withoutHyroxStation);
 *   5. then the technique station session leaves the week, when that brings
 *      the week under the cap, never as its last station session or brick.
 * Easy erg work is sized after the cap, inside the MTL the week leaves under
 * it, so it never costs a run minute or a station round. The quality run is
 * never cut (a fixed format). A week still over the cap after that is left as
 * it is and reported. Each step is noted on the week. Before 2026-10-13 the
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
    // 2. The long run gives up its growth: the last run cut, down to the
    // longest long run of the previous weeks (at least LONG_SOFT_FLOOR_MIN),
    // never under it, as it gives way to the quality run (D3). It stays at
    // least as long as every other run of the week (by distance). Before
    // (review 2026-10-13) it was cut to the soft floor, and the 110%
    // single-run rule then held the weeks after it to the shorter run: novice
    // 6 h 16 weeks peaked at a 53-min long run where it had reached 68.
    const long = out.find(w => isHyroxLongRun(w) && w.commute !== true);
    if (long && total() > cap) {
      const otherKm = Math.max(0, ...out.filter(w => w !== long && w.discipline === 'run' && w.commute !== true).map(hyroxRunLengthKm));
      const longFloor = Math.min(minOf(long), Math.max(LONG_SOFT_FLOOR_MIN, runTrim.prevLongRunMin ?? 0, runTrim.easyMinFor(otherKm)));
      const cut = perMin(long) > 0 ? Math.ceil((total() - cap) / perMin(long)) : 0;
      const to = Math.max(longFloor, minOf(long) - cut);
      if (to < minOf(long)) {
        out = out.map(w => (w === long ? runTrim.remake(w, to) : w));
        adjustments.push(`W${weekIndex}: Long Run cut from ${minOf(long)} to ${to} min (MTL cap ${cap})`);
      }
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
   *  or the quality run) the week may hold. The week's ceilings take easy
   *  running away after easy erg work and before the station work
   *  (buildHyroxTrainingWeeks fit). Unset: no limit. */
  easyRunCapMin?: number;
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
  /** Training weeks: the longest long run of the previous
   *  LONG_RUN_LOOKBACK_WEEKS weeks (minutes). The long run gives up its growth
   *  for the tier quality run, never this length (D3). */
  prevLongRunMin?: number;
  /** The shortest long run a training week prescribes: HYROX_RUN_FLOOR_MIN,
   *  or the athlete's long-run start when that is shorter (a start held under
   *  it by a short logged run). One sized under it is left out. Unset:
   *  HYROX_RUN_FLOOR_MIN. */
  runFloorMin?: number;
}

/** What a training week's ceiling (the acute:chronic guard, the deload
 *  ceiling) takes away, in this order, when cutting easy erg work and easy
 *  running (the solver's first steps, decision A's order) and scaling the
 *  station work down to its floor still leave the week above it: easy runs,
 *  stations out of each circuit down to MIN_CIRCUIT_STATIONS
 *  (the circuit stays; a station session's floor is 2 rounds of every station,
 *  50 to 65 min, so before 2026-10-13 a deload at low hours lost the whole
 *  circuit), the technique station session, the secondary brick, the quality
 *  run, then the brick. The long run is trimmed only after all of them (it is
 *  the cheapest load per minute and carries the progression), down to its
 *  soft floor (LONG_SOFT_FLOOR_MIN). A group whose omission would leave the
 *  week with no station session and no brick waits until the long run is
 *  trimmed to the run floor and left out (review 2026-10-13, round 2 and
 *  third pass); it leaves only when the week is still over without the long
 *  run, and the long run then takes back what fits. A product order: no
 *  source ranks sessions for this. */
const HYROX_GUARD_OMIT_ORDER = ['easy', 'stations', 'technique', 'light', 'quality', 'brick'] as const;
type HyroxGuardOmit = typeof HYROX_GUARD_OMIT_ORDER[number];

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
  const counts = weekSessionCounts(hx, tier, phase, weekIndex, !!raceWeek);
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
  const thresholdPaceSecKm = realRunningSignal(state) && state.pac?.t != null && state.pac.t > 0 ? state.pac.t : undefined;

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
    const minDur = kind.includes('station') ? 35 : 20;
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
  const isDoublesFormat = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const stationBenchmarks = (
    isDoublesFormat ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles
  ) ?? hx.stationBenchmarks as Partial<Record<HyroxStation, number>> | undefined;

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
  // The running share left after the bricks' run segments. The long run and
  // the quality run fit inside it unscaled; the guard's and the taper's scale
  // shrinks only what the easy runs get. A taper week's long run follows the
  // taper rule and is not trimmed here.
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

  // No run above the single-run ceiling, and no other run longer than the
  // long run (both by distance; Frandsen 2025 measured distance, and the long
  // run's minutes at easy pace stand in for it). Then the long run and the
  // quality run fit inside the running share: the long run gives way first,
  // down to LONG_SOFT_FLOOR_MIN; below that the quality run leaves the week.
  // In a training week, a quality run longer than the long run (the 8 x 1 km
  // session against a 70-min long run) stretches the long run to its distance
  // when the tier cap, the ceiling and the running share allow, and in week 1
  // never above the long-run start (review 2026-10-13: a no-history
  // beginner's 3-week plan opened with a 39-min long run against the 30-min
  // start); otherwise the quality run takes its easy sibling. Taper weeks
  // never stretch the long run (their tempo is sized to it above). A long run
  // trimmed for a quality run that then leaves the week keeps its full length
  // (review 2026-10-12: an advanced 4 h week 5 ran a 34-min long run beside no
  // quality run).
  const longWanted = longMin;
  if (quality && inputs.runCeilingKm != null && hyroxRunLengthKm(quality) > inputs.runCeilingKm + 1e-9) {
    adjustments.push(`W${weekIndex}: ${quality.n} above the 110% single-run ceiling, run easy`);
    quality = null;
  }
  // The quality run ranks ahead of the long run's growth, not of its length
  // (D3, Tristan 2026-10-13): the long run gives up what it would add over
  // the longest long run of the previous weeks (prevLongRunMin), never less
  // than LONG_SOFT_FLOOR_MIN; when the quality run still does not fit, it
  // leaves. Before, the long run was trimmed to 30 min for it.
  let longFit = longMin;
  if (trainingWeek && longMin != null && quality && longMin + qMin() > fitRoom) {
    const holdMin = Math.min(longMin, Math.max(LONG_SOFT_FLOOR_MIN, inputs.prevLongRunMin ?? 0));
    if (fitRoom - qMin() >= holdMin) {
      longFit = Math.floor(fitRoom - qMin());
    } else {
      adjustments.push(`W${weekIndex}: quality run left out (running share ${Math.round(fitRoom)} min, the long run holds ${holdMin} min)`);
      quality = null;
    }
  }
  if (quality && longFit != null) {
    const qKm = hyroxRunLengthKm(quality);
    const longKm = (longFit * 60) / easyPace;
    if (qKm > longKm + 1e-9) {
      const stretched = Math.ceil((qKm * easyPace) / 60);
      const startCap = weekIndex === 1 && inputs.longRunMin != null ? inputs.longRunMin : Infinity;
      const stretchCap = Math.min(HYROX_LONG_RUN[tier].capMin, ceilingMin, startCap);
      if (trainingWeek && stretched <= stretchCap && stretched + qMin() <= fitRoom) {
        longFit = stretched;
      } else {
        adjustments.push(`W${weekIndex}: ${quality.n} longer than the long run, run easy`);
        quality = null;
      }
    }
  }
  longMin = quality ? longFit : longWanted;
  if (quality && trainingWeek && longWanted != null && longFit != null && longFit < longWanted) {
    adjustments.push(`W${weekIndex}: Long Run held at ${longFit} min, not ${longWanted}, for the quality run (running share)`);
  }
  if (trainingWeek && longMin != null && longMin > fitRoom) longMin = Math.floor(fitRoom);
  // No training-week long run under the run floor (review 2026-10-13: a
  // 50-TSS logged load held long runs to 4 to 17 min): one the running share
  // or a ceiling sizes under it is left out.
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
  // A training week's ceiling holds its easy running (easyRunCapMin) before
  // it shrinks the station work.
  const easyHeld = inputs.easyRunCapMin != null && inputs.easyRunCapMin < runRoom - 1e-9;
  const easyRoom = easyHeld ? Math.max(0, inputs.easyRunCapMin as number) : runRoom;
  const easyWhy = easyHeld ? ceilingName : 'running share';
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
    if (n > 0 && easyHeld) adjustments.push(`W${weekIndex}: easy runs held to ${n * each} min (${ceilingName})`);
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

  // Enforce the MTL cap: easy running first, then the long run, then station
  // rounds and stations (enforceMTLCap, decision A).
  let week = enforceMTLCap(gated, hx.mtlCap, adjustments, weekIndex, {
    remake: (w, minutes) => ({
      ...generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: minutes, longRun: isHyroxLongRun(w), slotIndex: weekIndex }),
      ...(w.modReason ? { modReason: w.modReason } : {}),
    }),
    easyFloorMin: HYROX_RUN_FLOOR_MIN,
    easyMinFor: (km) => Math.ceil((km * easyPace) / 60),
    keepRunCount,
    prevLongRunMin: inputs.prevLongRunMin,
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
  // the quality run or the easy run standing in a missing quality run's slot. Before (review
  // 2026-10-13), one more hour funded another short run that took the easy
  // erg's slot, so the week held less: intermediate 23 weeks at 7 h held 36 to
  // 51 min less a week than at 6 h through build and peak (an easy run of 22
  // min in place of an easy erg session of 60 to 75), and total plan minutes
  // fell as hours rose in 26 band/length pairs. A product choice: no source
  // ranks an easy run against easy erg work when the session count binds.
  const ergSlotFor = (ws: Workout[]): Workout[] => {
    if (!trainingWeek) return ws;
    const maxSessions = Math.min(inputs.maxSessions ?? 7, 7);
    if (maxSessions - prescribed(ws).length - injuryFreedSlots > 0) return ws;
    const mtlPerMin = hyroxEasyErgMtlPerMin(hx.stationAccess, bodyWeightKg);
    if (mtlPerMin == null) return ws;
    const maxEach = Math.min(HYROX_LONG_RUN[tier].capMin, inputs.easyMaxMin ?? Infinity);
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
    // run's arrival never shortens the week (decision B).
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
    const room = ergRoom(next);
    if (room < HYROX_RUN_FLOOR_MIN) return ws;
    // The easy erg session as the injury gates leave it: the station capacity
    // scales it or drops it, and an easy run never leaves for an erg session
    // the gates then take (review 2026-10-13: with stations gated and runs
    // open, 138 of 630 training weeks lost an easy run, the injured
    // athlete's only gate-safe training, for an erg session that was then
    // dropped).
    const probe = generateHyroxEasyErg({ targetMinutes: room, stationAccess: hx.stationAccess, slotIndex: weekIndex, bodyWeightKg });
    const gatedErg = !probe ? [] : isPastWeek ? [probe] : applyHyroxInjuryGates([probe], injuryState, weeksFromCurrent);
    const ergMin = gatedErg[0]?.estimatedDurationMin ?? 0;
    if (ergMin <= 0 || hyroxPlannedMinutes(next) + ergMin <= hyroxPlannedMinutes(ws)) return ws;
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
      // A freed slot is taken only when the week then holds easy erg work;
      // otherwise the easy run stays and the swap's notes go.
      const mark = adjustments.length;
      let freed = ergSlotFor(week);
      let ergs = easyErgFor(freed);
      if (freed !== week && ergs.length === 0) {
        adjustments.length = mark;
        freed = week;
        ergs = easyErgFor(week);
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
  /** The weekly hours the week was built with: the chosen hours, or fewer
   *  when the week built at the chosen hours held fewer minutes or less load
   *  than the plan at one hour less (the hours ladder, decision B). */
  builtAtHours: number;
  /** Minute budget the week was built with (after the acute:chronic guard). */
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
  const firstDow = firstTrackedDow(state.planStartDate, weekIndex, state.planCreatedAt);
  const raceWeek = isRaceWeek(weekIndex, trainingWeeks, state.continuousMode) ? { layout, firstDow } : undefined;
  // Sessions the race-day rules leave out are noted on the week (by slot id,
  // stamped in generateWeekSessions).
  const noteDropped = (before: readonly Workout[], after: readonly Workout[], why: string) => {
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
 * Build training weeks 1..upto in order. Each week reads the weeks before it:
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
 *
 * `hoursLadder: false` builds at the chosen hours alone, without the hours
 * ladder (decision B); for tests and measurement only.
 */
export function buildHyroxTrainingWeeks(
  state: SimulatorState, trainingWeeks: number, layout: RaceWeekLayout | null, upto: number = trainingWeeks,
  opts: { storedBoundaryWeek?: number; hoursLadder?: boolean } = {},
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
  const easyRunTssPerMin = plannedTssPerMin('hyrox_run_easy', HYROX_EASY_RPE);

  const last = Math.min(upto, trainingWeeks);
  // What a week's rules read from the weeks before it on a rung of the hours
  // ladder: the deload and its reference, the single-run ceiling, the
  // acute:chronic guard and the previous Sunday. Shared by the week build and
  // by the ladder's check of a lower rung's week on this rung's weeks.
  const historyLimits = (w: number, lv: HyroxHoursRung) => {
    const built = lv.built;
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
    // Deload (running's CV.4): the last loaded week × HYROX_DELOAD_FACTOR in
    // planned minutes and planned TSS, with no session, hard session or
    // quality run that week did not hold. Before (review 2026-10-12) the
    // factor scaled an hours budget the weeks filled only 34 to 74% of, so
    // the median deload cut 9.4% and 17% of deloads were longer than the week
    // before.
    const deloadRef = deload && phase !== 'taper' ? refWeek : undefined;

    const chronicMean = () => {
      let sum = 0;
      for (let k = 1; k <= HYROX_CHRONIC_WINDOW_WEEKS; k++) sum += built[w - 1 - k]?.plannedTss ?? lv.seedTss;
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
    return { phase, raceWeek, deload, runCeilingKm, prevLongRun, refWeek, deloadRef, acwrCapTss, weekPrevSunday };
  };
  // One week of one rung of the hours ladder (below): built on the rung's
  // weeks before it, with the minute budget, running share and hours ceiling
  // of `hoursMin` (the rung's own hours, or fewer).
  const buildWeek = (w: number, lv: HyroxHoursRung, hoursMin: number): HyroxWeekDetail => {
    const built = lv.built;
    const { phase, raceWeek, deload, runCeilingKm, prevLongRun, refWeek, deloadRef, acwrCapTss, weekPrevSunday } = historyLimits(w, lv);
    const effortMult = w >= (state.w ?? 1) ? effortNow : 1.0;
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
    // Easy erg work fills the week's budget; a deload's, at most its ceiling
    // (0.75 of the last loaded week's minutes), so the notes measure what is
    // left against the deload, not against the phase budget.
    const fillMin = Math.min(budgetMin, deloadCapMin ?? Infinity);

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
    const taperWork = taperRef ? stationWorkOf(taperRef.workouts) : undefined;
    const prevRunMin = phase === 'taper' && built[w - 2] ? runMinutesOf(built[w - 2].workouts) : undefined;
    const maxCircuitRounds = raceWeek && built[w - 2]
      ? Math.max(MIN_CIRCUIT_ROUNDS, circuitRoundsOf(built[w - 2].workouts))
      : undefined;
    let scale = 1;
    let omitted: HyroxGuardOmit[] = [];
    let ergCap: number | undefined;
    // Training weeks: the most easy-run minutes the ceilings leave (fit).
    let easyCap: number | undefined;
    // Set when a ceiling took the week's last station session or brick: easy
    // erg work does not take its place.
    let ergBlocked = false;
    let noAssessment = false;
    // Week 1's assessment is exempt from week 1's guard (review 2026-10-13):
    // it is a fixed calibration pass the guard cannot shrink or leave out, so
    // below about 55 TSS of logged weekly load it alone was over the guard
    // and every other session of week 1 went. The rest of week 1 stays under
    // ACWR_SAFE_HIGH x the logged load. Its load still counts in week 1's
    // planned TSS, so the weeks after it read it in their chronic window.
    const guardExemptTss = (ws: readonly Workout[]): number => (w === 1
      ? hyroxPlannedTss(prescribed(ws).filter(x => x.t === 'hyrox_assessment'))
      : 0);
    const make = () => {
      const adjustments: string[] = [];
      const workouts = hyroxWeekForRace(state, w, trainingWeeks, phase, layout, {
        budgetMin, longRunMin, runCeilingKm, prevSunday: weekPrevSunday, scale, omit: omitted, capCounts,
        maxHardSessions, maxQualityRuns, prevRunMin, maxCircuitRounds, sessionCaps, ceilingName,
        runBudgetMin, fillMin, ergCapMin: ergBlocked ? 0 : ergCap, easyRunCapMin: easyCap, easyMaxMin, maxSessions, maxSessionsName, maxRuns, noAssessment,
        prevLongRunMin: prevLongRun > 0 ? prevLongRun : undefined, runFloorMin,
      }, adjustments);
      const work = stationWorkOf(workouts);
      const ergMin = prescribed(workouts).filter(isHyroxEasyErg).reduce((a, x) => a + (x.estimatedDurationMin ?? 0), 0);
      const easyMin = prescribed(workouts).filter(isPlainEasyRun).reduce((a, x) => a + (x.estimatedDurationMin ?? 0), 0);
      const tss = hyroxPlannedTss(workouts);
      return { workouts, adjustments, tss, guardTss: tss - guardExemptTss(workouts), min: hyroxPlannedMinutes(workouts), workMin: work.min, workMtl: work.mtl, ergMin, easyMin };
    };
    type Attempt = ReturnType<typeof make>;
    // Ceilings: the acute:chronic guard (training weeks), the deload ceiling
    // (deload weeks), the weekly hours (training weeks; scope item 9: hours
    // are a ceiling) and, in a taper week, the taper budget (taperFraction ×
    // the reference week), the reference week's station and brick minutes and
    // MTL, and the week before (the taper never rises; running's rule,
    // SCIENCE_LOG §CV.4). Easy erg work gives way first (its minutes price
    // linearly: `ergPerMin`, what one minute adds to the limit), then every
    // budget-sized session shrinks by the same scale each round, so stations,
    // bricks and easy runs give way together. Session floors and fixed
    // formats move the load in whole sessions, so a training week still over
    // its ceiling then takes stations out of circuits and leaves sessions out
    // (HYROX_GUARD_OMIT_ORDER) and, last, trims the long run. A taper week
    // over its ceiling after the scale takes stations out of its circuits,
    // then leaves sessions out (taperDropRank) until it fits: the fractions
    // hold (review 2026-10-13), the primer alone excepted. Before (review
    // 2026-10-13) the session floors held 2-h plans at up to 113% of the hours
    // in their peak weeks, and the never-rises rule dropped whole sessions
    // without trying the stations cut first.
    const capTss = Math.min(acwrCapTss ?? Infinity, deloadCapTss ?? Infinity);
    const hoursCapMin = hoursMin > 0 ? hoursMin : Infinity;
    const capMin = phase === 'taper' ? budgetMin : Math.min(deloadCapMin ?? Infinity, hoursCapMin);
    const before = built[w - 2];
    const beforeCapMin = phase === 'taper' && before ? before.plannedMin : Infinity;
    const hasCeiling = capTss < Infinity || capMin < Infinity;
    const trainingCeiling = phase !== 'taper' && hasCeiling;
    // `hours`: the limit is the chosen weekly hours alone (a loaded training
    // week); the easy-running step of the solver applies to it only.
    const limits: Array<{ cap: number; of: (a: Attempt) => number; ergPerMin: number; easyPerMin: number; hours?: boolean }> = [];
    if (capTss < Infinity) limits.push({ cap: capTss, of: a => a.guardTss, ergPerMin: ergTssPerMin, easyPerMin: easyRunTssPerMin });
    if (capMin < Infinity) limits.push({ cap: capMin, of: a => a.min, ergPerMin: 1, easyPerMin: 1, hours: phase !== 'taper' && capMin === hoursCapMin });
    if (beforeCapMin < Infinity) limits.push({ cap: beforeCapMin, of: a => a.min, ergPerMin: 1, easyPerMin: 1 });
    if (taperWork) {
      limits.push({ cap: taperWork.min, of: a => a.workMin, ergPerMin: 0, easyPerMin: 0 });
      limits.push({ cap: taperWork.mtl, of: a => a.workMtl, ergPerMin: 0, easyPerMin: 0 });
    }
    const over = (a: Attempt) => limits.some(l => l.of(a) > l.cap + 1e-6);
    const ratio = (a: Attempt) => limits.reduce((m, l) => Math.min(m, l.of(a) > 0 ? l.cap / l.of(a) : Infinity), Infinity);
    // Solver: easy erg work first, cut by what the largest overshoot needs
    // (erg minutes price linearly). Then, when the chosen weekly hours are
    // the only limit the week is over, easy running, cut the same way
    // (decision A's order, easy running before the HYROX-specific station
    // work; it costs no minutes against an hours limit). Under the
    // acute:chronic guard, the deload ceiling and the taper limits, station
    // sessions and easy runs shrink together by one scale, as before round 5
    // (review 2026-10-13:
    // decision A covers the MTL cap; cutting easy running first under the
    // guard, the lowest load per minute, cost the most minutes, and deloads
    // came out station-heavy, 873 of 1,813 holding the last loaded week's
    // station rounds). The scale shrinks by the overshoot each round, at
    // least 3% (a round that lands exactly on a floor otherwise repeats), for
    // at most 16 rounds, then the largest scale between the last two rounds
    // that fits (8 halvings). Numerical choices with no physiological
    // meaning. Before 2026-10-13 the scale stopped at the first fit, up to 3%
    // under it: a week at one more hour lost a station round it had room for
    // (intermediate 10 weeks, W5 at 9 h against 10 h: a 50-min race-pace
    // circuit of 3 rounds became 33 min of 2).
    const cutFor = (a: Attempt, perMin: (l: typeof limits[number]) => number): number | null => {
      let cut = 0;
      for (const l of limits) {
        const excess = l.of(a) - l.cap;
        if (excess <= 1e-6) continue;
        if (perMin(l) <= 0) return null;
        cut = Math.max(cut, excess / perMin(l));
      }
      return cut;
    };
    // The scale moves station and brick sessions in whole rounds, and easy
    // runs merge under the run floor, so the week can land well under its
    // ceiling: easy erg work takes that room (what it holds the larger rounds
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
    const fit = () => {
      scale = 1;
      ergCap = undefined;
      easyCap = undefined;
      let a = make();
      if (!over(a)) return a;
      if (a.ergMin > 0) {
        const cut = cutFor(a, l => l.ergPerMin);
        if (cut != null && cut < a.ergMin) {
          ergCap = Math.max(0, Math.floor(a.ergMin - cut));
          a = make();
          if (!over(a)) return a;
        }
      }
      ergCap = 0;
      a = make();
      const hoursOnly = limits.every(l => l.hours || l.of(a) <= l.cap + 1e-6);
      if (phase !== 'taper' && hoursOnly && over(a) && a.easyMin > 0) {
        const cut = cutFor(a, l => l.easyPerMin);
        if (cut != null && cut < a.easyMin) {
          easyCap = Math.max(0, Math.floor(a.easyMin - cut));
          a = make();
          if (!over(a)) return withErgRoom(a);
        }
        easyCap = 0;
        a = make();
        if (!over(a)) return withErgRoom(a);
      }
      if (!over(a)) return a;
      // Under the guard or the deload ceiling, a training week's easy running
      // shrinks with the station work by the same scale: its minutes are
      // capped at the scale times what the week held at full size. The scale
      // on the running share alone left easy runs capped by the long run
      // untouched until the week left them out whole (beginner 5 h 12 weeks
      // W5, stations gated by an injury: a 33-min easy run left out where 32
      // min fitted).
      const easyFull = a.easyMin;
      const propEasy = phase !== 'taper' && !hoursOnly && easyFull > 0;
      const setScale = (x: number) => {
        scale = x;
        if (propEasy) easyCap = Math.floor(easyFull * x);
      };
      let fitScale = 1;
      let overScale = 1;
      for (let i = 0; i < 16 && over(a); i++) {
        overScale = scale;
        setScale(scale * Math.min(0.97, ratio(a)));
        a = make();
      }
      if (!over(a) && scale < 1) {
        fitScale = scale;
        for (let i = 0; i < 8 && overScale - fitScale > 1e-4; i++) {
          setScale((fitScale + overScale) / 2);
          const b = make();
          if (over(b)) overScale = scale; else { fitScale = scale; a = b; }
        }
        setScale(fitScale);
        a = make();
        a = withErgRoom(a);
      }
      return a;
    };
    // The nominal week 1 that seeds the chronic window without a logged load
    // (D4): week 1 as generated with a station session in the assessment's
    // slot, under week 1's own ceiling (the weekly hours), at the rung's own
    // hours, and never lighter than the rung below's (a week the rung below
    // built stays inside this rung's guard).
    if (w === 1 && chronicSeedSource === 'nominal' && !lv.seedSet) {
      noAssessment = true;
      lv.seedTss = Math.max(fit().tss, lv.seedFloor);
      lv.seedSet = true;
      noAssessment = false;
    }
    let attempt = fit();
    if (trainingCeiling && !deloadRef) {
      // Name the ceiling that binds in the notes: the guard when the week at
      // full size is over it, otherwise the weekly hours.
      scale = 1;
      ergCap = undefined;
      const full = make();
      if (full.guardTss <= capTss + 1e-6 && full.min > hoursCapMin + 1e-6) {
        ceilingName = 'weekly hours';
        attempt = fit();
      }
    }
    if (trainingCeiling) {
      // A ceiling never takes a week's last station session or brick before
      // the long run is trimmed to its floor (review 2026-10-13: at 6 h the
      // guard left novice and intermediate plans with no station or brick
      // work for up to 10 weeks in a row, 33% of training weeks, to keep the
      // tempo and the long run). A group whose omission would leave the week
      // with no HYROX work waits until the long run is at its floor.
      const heldWork = hasHyroxWork(attempt.workouts);
      const deferred: HyroxGuardOmit[] = [];
      for (const o of HYROX_GUARD_OMIT_ORDER) {
        if (!over(attempt)) break;
        // The quality run ranks ahead of the long run's growth (D3, Tristan
        // 2026-10-13): before it leaves, the long run holds the longest
        // length of the previous weeks, or the longest length up to the one
        // wanted that fits beside it. When that is not enough the long run
        // keeps its growth and the quality run leaves.
        if (o === 'quality' && longRunMin != null && prevLongRun > 0 && longRunMin > prevLongRun
          && attempt.workouts.some(x => x.t === 'hyrox_run_tempo' || x.t === 'hyrox_run_intervals')) {
          const wanted = longRunMin;
          longRunMin = prevLongRun;
          const held = fit();
          if (!over(held)) {
            let lo = prevLongRun;
            let hi = wanted;
            while (lo < hi) {
              const mid = Math.ceil((lo + hi) / 2);
              longRunMin = mid;
              if (over(fit())) hi = mid - 1; else lo = mid;
            }
            longRunMin = lo;
            attempt = fit();
            if (lo < wanted) attempt.adjustments.push(`W${w}: Long Run held at ${lo} min, not ${wanted}, for the quality run (${ceilingName ?? 'acute:chronic guard'})`);
            break;
          }
          longRunMin = wanted;
          attempt = fit();
        }
        const keep = omitted;
        omitted = [...omitted, o];
        const trial = fit();
        if (heldWork && !hasHyroxWork(trial.workouts)) {
          omitted = keep;
          deferred.push(o);
          attempt = fit();
          continue;
        }
        attempt = trial;
      }
      // Bring back any group left out on the way that fits beside the ones
      // that had to go (an easy run left out before the quality run went).
      for (const o of HYROX_GUARD_OMIT_ORDER) {
        if (!omitted.includes(o) || over(attempt)) continue;
        const keep = omitted;
        omitted = omitted.filter(x => x !== o);
        const trial = fit();
        if (over(trial)) { omitted = keep; attempt = fit(); } else attempt = trial;
      }
      // The long run down to its floor (LONG_SOFT_FLOOR_MIN, or its own
      // length when that is shorter: a deload or a 30-min start).
      const longWanted = longRunMin;
      const longFloor = Math.min(LONG_SOFT_FLOOR_MIN, longRunMin ?? 0);
      for (let i = 0; i < 16 && over(attempt) && longRunMin != null && longRunMin > longFloor; i++) {
        longRunMin = Math.max(longFloor, Math.floor(longRunMin * Math.min(0.97, ratio(attempt))));
        attempt = make();
      }
      // Then the long run down to the run floor, then out of the week, before
      // the week's last station session or brick (review 2026-10-13: at a
      // logged load of 40 TSS or less the station session left first and the
      // long run grew back into its room, so 578 to 679 loaded weeks held a
      // lone 30 to 54-min long run where a station session and a 20-min long
      // run fitted). The long run is never trimmed under the run floor
      // (review 2026-10-13: it was trimmed to 4 min under a 50-TSS logged
      // load, and the week after jumped to 110% of the start).
      let longLeftOut = false;
      const trimLongToFloor = () => {
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
      // Last, the week's last station session or brick, only when the week is
      // still over its ceiling without the long run. The long run then takes
      // back what fits, from the run floor up to the length it had: the
      // station session alone was over the ceiling, so the long run never
      // holds more than the station session would have.
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
      if (longLeftOut && !attempt.workouts.some(isHyroxLongRun)) {
        attempt.adjustments.push(`W${w}: Long Run left out (${ceilingName ?? 'acute:chronic guard'})`);
      }
      if (w === 1 && acwrCapTss != null && attempt.tss > capTss + 1e-6 && attempt.guardTss <= capTss + 1e-6) {
        attempt.adjustments.push(`W${w}: planned load ${Math.round(attempt.tss)} TSS, above the ${Math.round(capTss)} TSS guard by the assessment (${Math.round(attempt.tss - attempt.guardTss)} TSS, not counted by the guard)`);
      }
      if (over(attempt)) {
        attempt.adjustments.push(deloadRef
          ? `W${w}: deload ${Math.round(attempt.min)} min / ${Math.round(attempt.tss)} TSS above ${HYROX_DELOAD_FACTOR} of the last loaded week (${Math.round(deloadRef.plannedMin)} min / ${Math.round(deloadRef.plannedTss)} TSS)`
          : attempt.guardTss > capTss + 1e-6
            ? `W${w}: planned load ${Math.round(attempt.guardTss)} TSS above the ${Math.round(capTss)} TSS guard`
            : `W${w}: ${Math.round(attempt.min)} min above the ${Math.round(hoursCapMin)}-min weekly hours`);
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
    const withWorkouts = (a: Attempt, workouts: Workout[]): Attempt => {
      const work = stationWorkOf(workouts);
      const ergMin = prescribed(workouts).filter(isHyroxEasyErg).reduce((x, y) => x + (y.estimatedDurationMin ?? 0), 0);
      const easyMin = prescribed(workouts).filter(isPlainEasyRun).reduce((x, y) => x + (y.estimatedDurationMin ?? 0), 0);
      const tss = hyroxPlannedTss(workouts);
      return { ...a, workouts, tss, guardTss: tss - guardExemptTss(workouts), min: hyroxPlannedMinutes(workouts), workMin: work.min, workMtl: work.mtl, ergMin, easyMin };
    };
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
    // is written once the hours ladder has picked the week (hoursNote).
    const hoursWhy: string[] = [];
    if (phase !== 'taper') {
      const ws = prescribed(attempt.workouts);
      const planned = hyroxPlannedMinutes(attempt.workouts);
      const n = attempt.adjustments.join(' | ');
      const budgetBinds = budgetMin < hoursMin - HYROX_RUN_FLOOR_MIN;
      if (deloadRef) hoursWhy.push(`a deload holds at most ${HYROX_DELOAD_FACTOR} of the last loaded week`);
      else if (budgetBinds && planned > budgetMin + 0.5) {
        const fixed = ws.some(x => x.t === 'hyrox_assessment') ? 'the fixed assessment holds it above' : 'session floors hold it above';
        hoursWhy.push(`the ${phase} week's budget is ${Math.round(budgetMin)} min, ${fixed}`);
      } else if (budgetBinds && fillMin - planned < HYROX_RUN_FLOOR_MIN) hoursWhy.push(`the ${phase} week's budget is ${Math.round(budgetMin)} min`);
      if (/acute:chronic guard/.test(n)) hoursWhy.push('the acute:chronic guard holds its load');
      if (/MTL cap \d+/.test(n)) hoursWhy.push(`the MTL cap of ${hx.mtlCap} holds its load`);
      if (/are full/.test(n)) {
        const holds: string[] = [];
        const running = ws.reduce((a, x) => a + (x.discipline === 'run'
          ? (x.estimatedDurationMin ?? 0)
          : (x.hyroxComponents ?? []).filter(c => c.type === 'run').reduce((b, c) => b + ((c.durationSec ?? 0) * (x.hyroxRounds ?? 1)) / 60, 0)), 0);
        const runsAtShare = runBudgetMin != null && running >= runBudgetMin - HYROX_RUN_FLOOR_MIN;
        if (runsAtShare) holds.push(`the running share of ${Math.round(runBudgetMin as number)} min holds the runs`);
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
      builtAtHours: hoursMin / 60,
      budgetMin: Math.round(budgetMin),
      plannedMin: hyroxPlannedMinutes(attempt.workouts),
      plannedTss: attempt.tss,
      acwrCapTss,
      guardExemptTss: acwrCapTss != null ? guardExemptTss(attempt.workouts) : 0,
      chronicSeedTss: lv.seedTss,
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
    HOURS_WHY.set(detail, hoursWhy);
    return detail;
  };

  // The hours ladder (decision B, Tristan 2026-10-13: for the same athlete
  // and plan length, one more chosen hour never gives fewer total plan
  // minutes or a lighter peak week). A plan is built at every whole hour from
  // the band's lowest choice up to the chosen hours, lowest first, and the
  // rung of the chosen hours is the plan. Each rung holds at least what the
  // rung below holds: total minutes, and the peak week's minutes and planned
  // load (canonical TSS), over the training weeks and over all weeks. A rung
  // is its own build when that holds; otherwise the weeks the rung below
  // needs are held to its same week (minutes and load), fewest first:
  //   1. the week that sets each of the rung below's peaks above this rung's,
  //      and, for the total, the weeks furthest under the rung below's until
  //      they cover the shortfall; again, up to HYROX_LADDER_ROUNDS rounds;
  //   2. else every week;
  //   3. else every week, and where no week holds as much, the rung below's
  //      weeks up to that one (this always holds).
  // A held week is the week built with the rung below's hours on this rung's
  // weeks before it (a week built for fewer hours sits inside every ceiling of
  // more hours: the running share, the weekly hours and the phase budget are
  // larger, and the guard, the single-run ceiling and the deload read the same
  // weeks), else the rung below's own week when every rule that reads the
  // weeks before holds on this rung's (lowerWeekFits). A rung depends only on
  // the rungs below it, so the plan at one hour less is the rung below and B
  // holds by construction. Before (review 2026-10-13) one more hour gave fewer
  // total plan minutes in 11 of 1,380 adjacent-hour pairs at the default
  // sessions and 189 with a logged load of 100 TSS: under a binding guard or
  // MTL cap, the larger running share brings the tier quality run (denser
  // work, more load per minute), which holds fewer minutes, and the guard
  // then reads the lighter weeks after it. The order (the rung's own build
  // first, the fewest held weeks) is a product rule; HYROX_LADDER_ROUNDS is a
  // cost bound. With more than one rung every rung builds all training weeks,
  // so a week rebuilt alone (upto) is the week of the full plan.
  const chosenHours = hx.weeklyHoursAvailable ?? 0;
  const lowest = HYROX_HOURS_RANGE[hx.athleteBand]?.min ?? chosenHours;
  const ladder: number[] = [];
  if (Number.isFinite(chosenHours) && opts.hoursLadder !== false) for (let h = lowest; h < chosenHours - 1e-9; h++) ladder.push(h);
  ladder.push(chosenHours);
  const weeksToBuild = ladder.length > 1 ? trainingWeeks : last;
  const holdsAtLeast = (a: HyroxWeekDetail, b: HyroxWeekDetail): boolean =>
    a.plannedMin >= b.plannedMin && a.plannedTss >= b.plannedTss - 1e-6;
  const minOf = (d: HyroxWeekDetail) => d.plannedMin;
  const tssOf = (d: HyroxWeekDetail) => d.plannedTss;
  const sumOf = (p: readonly HyroxWeekDetail[], f: (d: HyroxWeekDetail) => number) => p.reduce((x, d) => x + f(d), 0);
  const peakOf = (p: readonly HyroxWeekDetail[], f: (d: HyroxWeekDetail) => number, training: boolean) =>
    Math.max(0, ...p.filter(d => !training || d.phase !== 'taper').map(f));
  const planHoldsAtLeast = (a: readonly HyroxWeekDetail[], b: readonly HyroxWeekDetail[]): boolean =>
    sumOf(a, minOf) >= sumOf(b, minOf)
    && [true, false].every(t => peakOf(a, minOf, t) >= peakOf(b, minOf, t) && peakOf(a, tssOf, t) >= peakOf(b, tssOf, t) - 1e-6);
  // A week taken onto a rung's weeks before it: its guard, seed and deload
  // ceiling read from those weeks.
  const retag = (w: number, lv: HyroxHoursRung, d: HyroxWeekDetail): HyroxWeekDetail => {
    const h = historyLimits(w, lv);
    const exempt = w === 1 ? hyroxPlannedTss(prescribed(d.workouts).filter(x => x.t === 'hyrox_assessment')) : 0;
    const out: HyroxWeekDetail = {
      ...d,
      acwrCapTss: h.acwrCapTss,
      guardExemptTss: h.acwrCapTss != null ? exempt : 0,
      chronicSeedTss: lv.seedTss,
      deloadCapMin: h.deloadRef ? h.deloadRef.plannedMin * HYROX_DELOAD_FACTOR : null,
      deloadCapTss: h.deloadRef ? h.deloadRef.plannedTss * HYROX_DELOAD_FACTOR : null,
    };
    HOURS_WHY.set(out, HOURS_WHY.get(d) ?? []);
    return out;
  };
  // The rung below's week taken as it is onto this rung's weeks before it: a
  // loaded training week or a deload, when every rule that reads the weeks
  // before holds on this rung's (the acute:chronic guard, the single-run
  // ceiling, the Sunday-to-Monday spacing; a deload's ceiling, its reference
  // week's session caps, counts, hard sessions and quality runs). Taper weeks
  // are not taken this way.
  const lowerWeekFits = (w: number, lv: HyroxHoursRung, d: HyroxWeekDetail): HyroxWeekDetail | null => {
    const h = historyLimits(w, lv);
    if (h.phase === 'taper' || h.raceWeek || h.deload !== d.deload) return null;
    const ws = prescribed(d.workouts);
    const exempt = w === 1 ? hyroxPlannedTss(ws.filter(x => x.t === 'hyrox_assessment')) : 0;
    if (h.acwrCapTss != null && d.plannedTss - exempt > h.acwrCapTss + 1e-6) return null;
    if (h.runCeilingKm != null && d.longestRunKm > h.runCeilingKm + 0.001) return null;
    const monday = ws.filter(x => x.dayOfWeek === 0);
    if (h.weekPrevSunday?.hard && monday.some(isHyroxHardSession)) return null;
    if (h.weekPrevSunday?.eccentric && monday.some(isEccentricSession)) return null;
    const ref = h.deloadRef;
    if (ref) {
      if (d.plannedMin > ref.plannedMin * HYROX_DELOAD_FACTOR + 1e-6 || d.plannedTss > ref.plannedTss * HYROX_DELOAD_FACTOR + 1e-6) return null;
      const caps = sessionCapsOf(ref.workouts);
      for (const x of ws) {
        if (!isHyroxWork(x) || x.t === 'hyrox_assessment') continue;
        const c = sessionCapFor(caps, x.t ?? '');
        if (!c) continue;
        const minDur = (x.t ?? '').includes('station') ? 35 : 20;
        const stations = (x.hyroxComponents ?? []).filter(k => k.type !== 'run').length;
        if ((x.estimatedDurationMin ?? 0) > Math.max(minDur, c.min) || (x.hyroxRounds ?? 0) > Math.max(MIN_CIRCUIT_ROUNDS, c.rounds)
          || stations > Math.max(MIN_CIRCUIT_STATIONS, c.stations)) return null;
      }
      const rc = sessionCountsOf(ref.workouts);
      const dc = sessionCountsOf(d.workouts);
      const isQ = (x: Workout) => x.t === 'hyrox_run_tempo' || x.t === 'hyrox_run_intervals';
      const rp = prescribed(ref.workouts);
      if (dc.runs > rc.runs || dc.stations > rc.stations || dc.bricks > rc.bricks
        || ws.length > Math.min(chosenSessions, rp.length)
        || ws.filter(isHyroxHardSession).length > rp.filter(isHyroxHardSession).length
        || ws.filter(isQ).length > rp.filter(isQ).length) return null;
    }
    return retag(w, lv, d);
  };
  // A rung, built from week `from` on (the weeks before it kept from `base`,
  // built the same way). `held(w)`: week w is held to the rung below's;
  // `takeBelow`: where no week holds as much, the rung takes the rung below's
  // weeks up to that one.
  const runRung = (
    li: number, below: HyroxHoursRung | null, base: HyroxHoursRung | null, from: number,
    held: (w: number) => boolean, takeBelow: boolean,
  ): HyroxHoursRung => {
    const lv: HyroxHoursRung = {
      hoursMin: ladder[li] * 60, built: [],
      seedTss: loggedSeedTss, seedSet: chronicSeedSource === 'logged', seedFloor: below?.seedTss ?? 0,
    };
    if (base && from > 1) {
      lv.built = base.built.slice(0, from - 1);
      lv.seedTss = base.seedTss;
      lv.seedSet = base.seedSet;
    }
    for (let w = lv.built.length + 1; w <= weeksToBuild; w++) {
      let wk = buildWeek(w, lv, lv.hoursMin);
      const lower = below?.built[w - 1];
      if (below && lower && held(w) && !holdsAtLeast(wk, lower)) {
        let pick: HyroxWeekDetail | null = null;
        if (li >= 1) {
          const cand = buildWeek(w, lv, ladder[li - 1] * 60);
          if (holdsAtLeast(cand, lower)) pick = cand;
        }
        pick ??= lowerWeekFits(w, lv, lower);
        if (pick) wk = pick;
        else if (takeBelow) {
          const taken: HyroxWeekDetail[] = [];
          for (let v = 1; v <= w; v++) taken.push(retag(v, { ...lv, built: taken }, below.built[v - 1]));
          lv.built = taken;
          continue;
        }
      }
      lv.built.push(wk);
    }
    return lv;
  };
  // The weeks to hold next (step 1): for each peak of the rung below's above
  // this rung's, its week (the largest); else, for the total, the weeks
  // furthest under the rung below's until they cover the shortfall.
  const weeksToHold = (a: readonly HyroxWeekDetail[], b: readonly HyroxWeekDetail[], held: ReadonlySet<number>): number[] => {
    const open = (i: number) => !!b[i] && !!a[i] && !held.has(i + 1) && !holdsAtLeast(a[i], b[i]);
    const out = new Set<number>();
    for (const t of [true, false]) {
      for (const f of [minOf, tssOf]) {
        const mine = peakOf(a, f, t);
        let best = -1;
        b.forEach((d, i) => {
          if ((!t || d.phase !== 'taper') && open(i) && f(d) > mine + 1e-6 && (best < 0 || f(d) > f(b[best]))) best = i;
        });
        if (best >= 0) out.add(best + 1);
      }
    }
    if (out.size > 0) return [...out];
    const short = sumOf(b, minOf) - sumOf(a, minOf);
    if (short > 0) {
      const under = b.map((_, i) => i)
        .filter(i => open(i) && b[i].plannedMin > a[i].plannedMin)
        .sort((x, y) => (b[y].plannedMin - a[y].plannedMin) - (b[x].plannedMin - a[x].plannedMin));
      let cover = 0;
      for (const i of under) {
        out.add(i + 1);
        cover += b[i].plannedMin - a[i].plannedMin;
        if (cover >= short) break;
      }
    }
    return [...out];
  };
  // The first week of a rung under the rung below's same week.
  const firstUnder = (r: HyroxHoursRung, f: HyroxHoursRung): number => {
    const i = r.built.findIndex((d, k) => !!f.built[k] && !holdsAtLeast(d, f.built[k]));
    return i < 0 ? r.built.length + 1 : i + 1;
  };
  let below: HyroxHoursRung | null = null;
  for (let li = 0; li < ladder.length; li++) {
    let rung = runRung(li, below, null, 1, () => false, false);
    if (below && !planHoldsAtLeast(rung.built, below.built)) {
      const f = below;
      const held = new Set<number>();
      let ok = false;
      for (let round = 0; round < HYROX_LADDER_ROUNDS && !ok; round++) {
        const add = weeksToHold(rung.built, f.built, held);
        if (add.length === 0) break;
        for (const w of add) held.add(w);
        rung = runRung(li, f, rung, Math.min(...add), w => held.has(w), false);
        ok = planHoldsAtLeast(rung.built, f.built);
      }
      if (!ok) {
        rung = runRung(li, f, rung, firstUnder(rung, f), () => true, false);
        if (!planHoldsAtLeast(rung.built, f.built)) rung = runRung(li, f, rung, firstUnder(rung, f), () => true, true);
      }
    }
    below = rung;
  }
  const plan = below as HyroxHoursRung;
  return plan.built.slice(0, last).map(d => hoursNote(d, plan.hoursMin));
}

/** Rounds of the hours ladder's step 1 (buildHyroxTrainingWeeks), each holding
 *  more weeks to the rung below's before every week is held: a cost bound on
 *  the plan build, no physiological meaning. */
const HYROX_LADDER_ROUNDS = 4;

/** One rung of the hours ladder (buildHyroxTrainingWeeks): the weeks built so
 *  far at `hoursMin`, and the guard's chronic seed. */
interface HyroxHoursRung {
  hoursMin: number;
  built: HyroxWeekDetail[];
  /** The chronic seed (canonical TSS): the logged weekly load, or the nominal
   *  week 1 at the rung's hours, never under the rung below's (seedFloor: a
   *  week the rung below built then stays inside this rung's guard). */
  seedTss: number;
  seedSet: boolean;
  seedFloor: number;
}

/** What holds a built week under the chosen weekly hours (decision C), keyed
 *  by the week's detail; read by hoursNote. */
const HOURS_WHY = new WeakMap<HyroxWeekDetail, string[]>();

/**
 * The plan's week with its notes against the chosen weekly hours: a week the
 * hours ladder held to the plan at fewer hours says so (decision B), and a
 * training week HYROX_RUN_FLOOR_MIN or more under the chosen hours says so,
 * with what holds it (decision C). A held week's reason is the hold: the
 * reasons its lower-hours build recorded (a running share, a budget) are
 * those of the fewer hours.
 */
function hoursNote(d: HyroxWeekDetail, hoursMin: number): HyroxWeekDetail {
  const notes = [...d.adjustments];
  const held = d.builtAtHours * 60 < hoursMin - 1e-6;
  const heldText = `held to the ${d.builtAtHours} h week`;
  if (held) {
    notes.push(`W${d.week}: ${heldText} (built for ${hoursMin / 60} h this week held fewer minutes or less load, and one more chosen hour never holds less)`);
  }
  if (d.phase !== 'taper' && hoursMin > 0 && hoursMin - d.plannedMin >= HYROX_RUN_FLOOR_MIN) {
    const why = held ? [heldText] : [...(HOURS_WHY.get(d) ?? [])];
    const text = why.length > 0 ? why.join('; ') : 'the running share and the session caps hold it';
    notes.push(`W${d.week}: ${d.plannedMin} of the chosen ${Math.round(hoursMin)} min (${text})`);
  }
  return notes.length === d.adjustments.length ? d : { ...d, adjustments: notes };
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
  if (!state.hyroxConfig || !state.wks || weekIndex < 1 || weekIndex > state.wks.length) return null;
  const totalWeeks = state.tw || 16;
  const layout = storedPlanRaceLayout(totalWeeks, state.planStartDate, state.hyroxConfig.raceDate);
  const trainingWeeks = layout?.trainingWeeks ?? totalWeeks;
  const existing = state.wks[weekIndex - 1];
  if (weekIndex > trainingWeeks) {
    // Closing week: it holds only the race.
    return { ...existing, ph: 'taper', raceClosing: true, triWorkouts: [] };
  }
  const planPhases = computeHyroxPlanPhases(trainingWeeks);
  const p = planPhases[weekIndex - 1];
  if (!p) return null;
  const built = buildHyroxTrainingWeeks(state, trainingWeeks, layout, weekIndex, { storedBoundaryWeek: weekIndex });
  const workouts = built[weekIndex - 1]?.workouts ?? [];
  const notes = built[weekIndex - 1]?.adjustments ?? [];
  const { hyroxPlanNotes: _old, ...rest } = existing;
  return {
    ...rest,
    ph: p.ph as any,
    ...(p.checkpoint ? { checkpoint: true } : { checkpoint: existing.checkpoint }),
    triWorkouts: workouts,
    ...(notes.length > 0 ? { hyroxPlanNotes: notes } : {}),
  };
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
