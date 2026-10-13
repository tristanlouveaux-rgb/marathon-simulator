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
 *      (0.75 every 4th week) × the effort / MTL-gap lever. Taper weeks:
 *      taperFraction (0.70 then 0.55) of the reference week's planned minutes.
 *   3. Sessions from the tier's weekly structure (HYROX_WEEKLY_STRUCTURE) and
 *      the athlete's session-count choice; no brick in base, before week 5 or
 *      in race week.
 *   4. Running is at most HYROX_RUN_SHARE of the budget (standalone runs plus
 *      brick runs): the long run first (tier start, step and cap, the 110%
 *      single-run rule), then the quality run (tier format), then easy runs,
 *      none longer than the long run. Station sessions and bricks share the
 *      rest. What is left stays unprescribed: hours are a ceiling.
 *   5. Weekly MTL cap: cut station and brick rounds (real volume).
 *   6. Schedule with the hard-day and 48 h eccentric rules, Sunday to Monday
 *      included (scheduler.hyrox). A week the rules cannot hold loses a hard
 *      session to its easy sibling, then its lowest-priority session.
 *   7. Acute:chronic guard: a training week's planned load (canonical TSS) is
 *      at most ACWR_SAFE_HIGH × the mean of the previous 4 planned weeks (weeks
 *      before week 1 count as week 1). Over it, the budget shrinks and the week
 *      is rebuilt.
 *   8. Wrap into Week[].
 */

import { dropSessionsOnOrAfterRaceDay, clearStoredPlanRaceWindow, raceWeekPrimerDow, PRIMER_MIN_DAYS_OUT, RACE_DAY_CLEAR_DAYS } from './race-day-rules';
import { storedPlanRaceLayout, type RaceWeekLayout } from './race-week-layout';
import { firstTrackedDow } from '@/ui/workout-status';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';
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
  withHyroxRounds, withoutHyroxStation,
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
  ctlGapMultiplier, isFourWeekCycleDeloadWeek, isRaceWeek,
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
 *  assessment, a single calibration pass). */
function mtlCuttable(s: Workout): boolean {
  return (s.discipline === 'station' || s.discipline === 'brick') && s.t !== 'hyrox_assessment';
}

/**
 * Weekly MTL cap (rules_to_code 16). While the week's MTL is above the cap:
 *   1. take one round off the highest-MTL station or brick session above
 *      MIN_CIRCUIT_ROUNDS (withHyroxRounds cuts the real volume: work, rest,
 *      duration and the description's round count);
 *   2. with every session at MIN_CIRCUIT_ROUNDS, take the highest-MTL station
 *      out of the highest-MTL circuit holding more than MIN_CIRCUIT_STATIONS
 *      (withoutHyroxStation);
 *   3. then the technique station session leaves the week, when that brings
 *      the week under the cap (the runs alone can hold a week above it).
 * A week still over the cap after that is left as it is and reported. Each
 * step is noted on the week. Before 2026-10-12 the cap scaled only the
 * reported MTL numbers and left every session as prescribed; the v18 draft
 * stopped at 2 rounds and left 4% of weeks over the cap (review 2026-10-12).
 * The cap values are still initial estimates (HYROX_MTL_CAP), and the order
 * (highest MTL first, technique before race pace) is a product order: no
 * source ranks the cuts.
 */
function enforceMTLCap(sessions: Workout[], cap: number, adjustments: string[], weekIndex: number): Workout[] {
  let out = [...sessions];
  const total = () => out.reduce((sum, s) => sum + (s.musculoTendonLoad ?? 0), 0);
  const mtlOf = (s: Workout) => s.musculoTendonLoad ?? 0;
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
    // compliance.
    const tech = out.findIndex(s => s.t === 'hyrox_station_technique');
    if (tech >= 0 && total() - mtlOf(out[tech]) <= cap) {
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
   *  week is exempt: it keeps the peak structure minus the brick, whatever a
   *  reference week thinned by the guard or the running share held (§CE
   *  update 4: race week holds the primer whenever it holds a run). */
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
  /** Deload weeks: per session type (station circuits, bricks), the longest
   *  duration and the most rounds the last loaded week held. A deload holds
   *  no session longer than its counterpart there (review 2026-10-12: a
   *  deload brick of 90 min and 6 rounds against 75 min and 5 in the week
   *  before). */
  sessionCaps?: Partial<Record<string, { min: number; rounds: number }>>;
  /** Race week: circuit rounds at most the week before's (the taper never
   *  rises). Before (review 2026-10-12) race week's one circuit took the whole
   *  non-running budget: 64 to 73 min and 4 to 5 rounds against 2 rounds the
   *  week before. */
  maxCircuitRounds?: number;
}

/** What a training week's ceiling (the acute:chronic guard, the deload
 *  ceiling) takes away, in this order, when scaling every budget-sized
 *  session down to its floor still leaves the week above it: easy runs,
 *  stations out of each circuit down to MIN_CIRCUIT_STATIONS
 *  (the circuit stays; a station session's floor is 2 rounds of every station,
 *  50 to 65 min, so before 2026-10-13 a deload at low hours lost the whole
 *  circuit), the technique station session, the secondary brick, the quality
 *  run, then the brick. The long run is trimmed only after all of them (it is
 *  the cheapest load per minute and carries the progression). A product
 *  order: no source ranks sessions for this. */
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

  const scale = inputs.scale ?? 1;
  const runBudget = inputs.budgetMin * HYROX_RUN_SHARE;
  const nonRunBudget = inputs.budgetMin - runBudget;
  const easyPace = hyroxEasyRunPaceSecKm(band, hx.hyroxRunPaceSecKm);
  const thresholdPaceSecKm = realRunningSignal(state) && state.pac?.t != null && state.pac.t > 0 ? state.pac.t : undefined;

  // Commute runs are appended on top of the prescribed HYROX run sessions,
  // not substituted for them (revised 2026-05-20. See SCIENCE_LOG §AK).
  const commuteDays = state.commuteConfig?.enabled && state.commuteConfig.commuteDaysPerWeek > 0
    ? state.commuteConfig.commuteDaysPerWeek
    : 0;

  // Clamp a budget-sized station or brick to its caps (minimum 35 min for
  // station sessions, 20 for a brick), then apply the week's scale.
  function clampDur(kind: string, raw: number): number {
    const minDur = kind.includes('station') ? 35 : 20;
    const capped = Math.min(HYROX_SESSION_MAX_MIN[kind] ?? 90, raw);
    const sized = Math.max(minDur, Math.round(capped * scale));
    const refCap = inputs.sessionCaps?.[`hyrox_${kind}`];
    return refCap ? Math.min(sized, Math.max(minDur, refCap.min)) : sized;
  }
  // Deload weeks: no station or brick session longer, or with more rounds,
  // than the same session in the last loaded week.
  const capToRef = (w: Workout): Workout => {
    const refCap = inputs.sessionCaps?.[w.t];
    if (!refCap || (w.hyroxRounds ?? 0) <= refCap.rounds) return w;
    adjustments.push(`W${weekIndex}: ${w.n} cut to ${refCap.rounds} rounds (deload: the last loaded week's)`);
    return withHyroxRounds(w, refCap.rounds);
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
  const needsAssessment = weekIndex === 1 && !raceWeek;
  const omit = new Set(inputs.omit ?? []);
  // Deload weeks carry their reference week's session caps; the ceiling that
  // took something out is named in the note.
  const ceilingName = inputs.sessionCaps ? 'deload ceiling' : 'acute:chronic guard';
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
  const brickRunMin = nonRun
    .filter(w => w.discipline === 'brick')
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
  // an easy run's place on a tight budget (SCIENCE_LOG §CE update 4). Before
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
      const others = slots - (longMin != null ? 1 : 0);
      const room = fitRoom * scale - (longMin ?? 0);
      const tempoMin = Math.max(HYROX_RUN_FLOOR_MIN, Math.min(HYROX_SESSION_MAX_MIN.run_tempo, Math.round(room / Math.max(1, others))));
      quality = generateHyroxRun({ ...runParams, kind: 'run_tempo', targetMinutes: tempoMin, slotIndex: weekIndex });
    }
  }
  const qMin = () => quality?.estimatedDurationMin ?? 0;

  // No run above the single-run ceiling, and no other run longer than the
  // long run (both by distance; Frandsen 2025 measured distance, and the long
  // run's minutes at easy pace stand in for it). Then the long run and the
  // quality run fit inside the running share: the long run gives way first,
  // down to LONG_SOFT_FLOOR_MIN; below that the quality run leaves the week.
  // A quality run longer than the long run (the 8 x 1 km session against a
  // 70-min long run) stretches the long run to its distance when the tier cap,
  // the ceiling and the running share allow; otherwise it takes its easy
  // sibling. A long run trimmed for a quality run that then leaves the week
  // keeps its full length (review 2026-10-12: an advanced 4 h week 5 ran a
  // 34-min long run beside no quality run).
  const longWanted = longMin;
  if (quality && inputs.runCeilingKm != null && hyroxRunLengthKm(quality) > inputs.runCeilingKm + 1e-9) {
    adjustments.push(`W${weekIndex}: ${quality.n} above the 110% single-run ceiling, run easy`);
    quality = null;
  }
  let longFit = longMin;
  if (trainingWeek && longMin != null && quality && longMin + qMin() > fitRoom) {
    if (fitRoom - qMin() >= LONG_SOFT_FLOOR_MIN) {
      longFit = Math.floor(fitRoom - qMin());
    } else {
      adjustments.push(`W${weekIndex}: quality run left out (running share ${Math.round(fitRoom)} min)`);
      quality = null;
    }
  }
  if (quality && longFit != null) {
    const qKm = hyroxRunLengthKm(quality);
    const longKm = (longFit * 60) / easyPace;
    if (qKm > longKm + 1e-9) {
      const stretched = Math.ceil((qKm * easyPace) / 60);
      if (stretched <= Math.min(HYROX_LONG_RUN[tier].capMin, ceilingMin) && stretched + qMin() <= fitRoom) {
        longFit = stretched;
      } else {
        adjustments.push(`W${weekIndex}: ${quality.n} longer than the long run, run easy`);
        quality = null;
      }
    }
  }
  longMin = quality ? longFit : longWanted;
  if (trainingWeek && longMin != null && longMin > fitRoom) longMin = Math.floor(fitRoom);
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
  // Easy runs share what is left, each at most the long run (or the ceiling)
  // and at least HYROX_RUN_FLOOR_MIN; a share below the floor is merged into
  // fewer runs. Taper weeks and race week keep the run count (Bosquet et al.
  // 2007: no benefit from cutting frequency; the existing race-week rule) and
  // never fall below the floor. Taper week 1's easy runs may use the week's
  // unspent minutes beyond the running share; race week's take what the
  // running share leaves after the primer, so the primer stays the one quality
  // touch and a shorter circuit does not lengthen them.
  const easyCapMin = Math.min(longMin ?? Infinity, ceilingMin);
  const keepRunCount = kindPhase === 'taper';
  if (omit.has('easy') && !keepRunCount && slots > 0) { guardNote(`${slots} easy run(s)`); slots = 0; }
  if (keepRunCount && slots > 0) {
    const nonRunMin = nonRun.reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
    const weekRoom = inputs.budgetMin * scale - nonRunMin - (longMin ?? 0) - qMin();
    // Taper week 1: never more running than the week before; the count is
    // the slots, rounded down only when the floor would lift the week's
    // running above it (running's rule, SCIENCE_LOG §CV.4), never for a short
    // run share alone. Race week keeps the peak structure's runs, as running's
    // race week keeps rw − 1: the week before can be thin because its
    // reference week lost runs to the guard or the running share, and race
    // week's total stays under the week before's (the taper never rises,
    // buildHyroxTrainingWeeks).
    const runCapRoom = raceWeek ? Infinity : (inputs.prevRunMin ?? Infinity) - (longMin ?? 0) - qMin();
    const room = Math.min(raceWeek ? runRoom : Math.max(runRoom, weekRoom), runCapRoom);
    let n = slots;
    if (runCapRoom < n * HYROX_RUN_FLOOR_MIN) n = Math.max(0, Math.floor(runCapRoom / HYROX_RUN_FLOOR_MIN));
    const each = n > 0 ? Math.floor(Math.min(easyCapMin, Math.max(HYROX_RUN_FLOOR_MIN, room / n))) : 0;
    if (each >= 1) {
      for (let i = 0; i < n; i++) {
        runs.push(generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: each, slotIndex: i + weekIndex }));
      }
    }
    if (n < slots) adjustments.push(`W${weekIndex}: ${slots - n} easy run(s) left out (the taper never rises)`);
  } else if (slots > 0 && runRoom >= HYROX_RUN_FLOOR_MIN) {
    let n = slots;
    let each = runRoom / n;
    if (each < HYROX_RUN_FLOOR_MIN) {
      n = Math.max(1, Math.floor(runRoom / HYROX_RUN_FLOOR_MIN));
      each = runRoom / n;
    }
    each = Math.floor(Math.min(each, easyCapMin));
    if (each >= HYROX_RUN_FLOOR_MIN) {
      for (let i = 0; i < n; i++) {
        runs.push(generateHyroxRun({ ...runParams, kind: 'run_easy', targetMinutes: each, slotIndex: i + weekIndex }));
      }
    } else {
      n = 0;
    }
    if (n < slots) adjustments.push(`W${weekIndex}: ${slots - n} easy run(s) left out (running share)`);
  } else if (slots > 0) {
    adjustments.push(`W${weekIndex}: ${slots} easy run(s) left out (running share)`);
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

  // Enforce the MTL cap by cutting rounds, then stations (enforceMTLCap).
  let week = enforceMTLCap(gated, hx.mtlCap, adjustments, weekIndex);

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
      week, band,
      placed ? (w) => raceWeekDays(placed, weekIndex, w) : undefined,
      { prevSunday: inputs.prevSunday, dropped },
    );
    for (const d of dropped) adjustments.push(`W${weekIndex}: ${d.n} left out (no race-week day the race-day rules allow)`);
  } else {
    let found = findHyroxWeekSchedule(week, { prevSunday: inputs.prevSunday });
    while (!found) {
      if (!demoteOne()) {
        const dropOrder = (w: Workout): number =>
          w.commute ? -1
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
  const isStation = (w: Workout): boolean => {
    const t = (w.t || '') as string;
    return t.startsWith('hyrox_station_') || t === 'hyrox_assessment';
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
  /** Minute budget the week was built with (after the acute:chronic guard). */
  budgetMin: number;
  /** Planned minutes and canonical TSS of the prescribed sessions. */
  plannedMin: number;
  plannedTss: number;
  /** ACWR_SAFE_HIGH × the chronic planned load (null: week 1 or a taper week). */
  acwrCapTss: number | null;
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

/** Session counts of a built week (commute runs excluded; the assessment
 *  counts as a station session). */
function sessionCountsOf(ws: readonly Workout[]): HyroxSessionCounts {
  const p = prescribed(ws);
  return {
    runs: p.filter(w => w.discipline === 'run').length,
    stations: p.filter(w => w.discipline === 'station').length,
    bricks: p.filter(w => w.discipline === 'brick').length,
  };
}

/** Running minutes of a built week (standalone runs; commute runs excluded). */
function runMinutesOf(ws: readonly Workout[]): number {
  return prescribed(ws).filter(w => w.discipline === 'run').reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
}

/** Longest duration and most rounds per station and brick session type in a
 *  week (the deload's per-session caps). */
function sessionCapsOf(ws: readonly Workout[]): Partial<Record<string, { min: number; rounds: number }>> {
  const out: Partial<Record<string, { min: number; rounds: number }>> = {};
  for (const w of prescribed(ws)) {
    if (w.discipline !== 'station' && w.discipline !== 'brick') continue;
    if (w.t === 'hyrox_assessment') continue;
    const cur = out[w.t];
    out[w.t] = {
      min: Math.max(cur?.min ?? 0, w.estimatedDurationMin ?? 0),
      rounds: Math.max(cur?.rounds ?? 0, w.hyroxRounds ?? 0),
    };
  }
  return out;
}

/** Largest round count of a week's station circuits (technique or race pace). */
function circuitRoundsOf(ws: readonly Workout[]): number {
  return prescribed(ws)
    .filter(w => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density')
    .reduce((m, w) => Math.max(m, w.hyroxRounds ?? 0), 0);
}

/** Order a taper week sheds sessions in when it would rise above the week
 *  before: easy runs, the technique circuit, the secondary brick, the taper
 *  brick, then the long run; the tempo last. -1 = never: a commute run, and
 *  race week's primer (race week holds the primer whenever it holds a run,
 *  SCIENCE_LOG §CE update 4). A product order: no source ranks these
 *  sessions. */
function taperDropRank(w: Workout, raceWeek: boolean): number {
  if (w.commute) return -1;
  if (w.t === 'hyrox_run_easy' && !isHyroxLongRun(w)) return 0;
  if (w.t === 'hyrox_station_technique') return 1;
  if (w.hyroxLight) return 2;
  if (w.discipline === 'brick') return 3;
  if (isHyroxLongRun(w)) return 4;
  if (raceWeek && w.t === 'hyrox_run_tempo') return -1;
  return 5;
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
 * previous HYROX_CHRONIC_WINDOW_WEEKS weeks, weeks before week 1 counting as
 * week 1; Tristan 2026-10-12, Gabbett 2016's 0.8 to 1.3 sweet spot, the same
 * bound as running's week-1 ACWR_SAFETY_CAP), the deload ceiling (the last
 * loaded week × HYROX_DELOAD_FACTOR), the single-run rule (110% of the
 * longest run of the previous LONG_RUN_LOOKBACK_WEEKS weeks; Frandsen 2025),
 * the taper's reference week and the previous Sunday. Deterministic: the same
 * state gives the same weeks, so one week can be rebuilt alone.
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
  const easyPace = hyroxEasyRunPaceSecKm(hx.athleteBand, hx.hyroxRunPaceSecKm);
  const start = hyroxLongRunStart(state, tier, easyPace);
  const lr = HYROX_LONG_RUN[tier];
  const hoursMin = (hx.weeklyHoursAvailable ?? 0) * 60;
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

  const built: HyroxWeekDetail[] = [];
  let prevSunday: HyroxPrevSunday | null = null;
  const last = Math.min(upto, trainingWeeks);
  for (let w = 1; w <= last; w++) {
    const phase = (planPhases[w - 1]?.ph ?? 'base') as HyroxPhase;
    const raceWeek = isRaceWeek(w, trainingWeeks, state.continuousMode);
    // Honour a holiday-forced deload the same way running's plan_engine.ts does
    // (deload = ctx.forceDeload || isDeloadWeek(...)).
    const forceDeload = !!(state.wks?.[w - 1] as any)?.forceDeload;
    const deload = forceDeload || isFourWeekCycleDeloadWeek(w, phase);
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

    const lookback = built.slice(-LONG_RUN_LOOKBACK_WEEKS);
    const prevLongest = lookback.reduce((m, b) => Math.max(m, b.longestRunKm), 0);
    const ceilingRefKm = prevLongest > 0 ? prevLongest : (w === 1 ? start.recentLongestKm : null);
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

    let budgetMin: number;
    let longRunMin: number | null;
    if (phase === 'taper') {
      // The long run in a taper week: TAPER_LONG_RUN_FRACTION of the longest
      // long run of the previous 4 weeks (the start when there is none).
      longRunMin = raceWeek ? null : Math.round((prevLongRun > 0 ? prevLongRun : start.startMin) * TAPER_LONG_RUN_FRACTION);
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
        longRunMin = deloadRef
          ? Math.round(Math.min(stepped, deloadRef.longRunMin ?? stepped) * HYROX_DELOAD_FACTOR * Math.min(1, adaptive))
          : Math.round(stepped * (deload ? HYROX_DELOAD_FACTOR : 1) * adaptive);
      }
    }

    const chronicWindow = [];
    for (let k = 1; k <= HYROX_CHRONIC_WINDOW_WEEKS; k++) chronicWindow.push(built[w - 1 - k] ?? built[0]);
    const acwrCapTss = w >= 2 && phase !== 'taper'
      ? ACWR_SAFE_HIGH * (chronicWindow.reduce((a, b) => a + (b?.plannedTss ?? 0), 0) / HYROX_CHRONIC_WINDOW_WEEKS)
      : null;
    const deloadCapMin = deloadRef ? deloadRef.plannedMin * HYROX_DELOAD_FACTOR : null;
    const deloadCapTss = deloadRef ? deloadRef.plannedTss * HYROX_DELOAD_FACTOR : null;

    // Taper week 1 and deload weeks hold no session the reference week (the
    // last loaded week) did not: its counts cap theirs. Race week keeps the
    // peak structure minus the brick (generateWeekSessions).
    const capRef = phase === 'taper' ? refWeek : deloadRef;
    const capCounts = capRef ? sessionCountsOf(capRef.workouts) : undefined;
    const maxHardSessions = deloadRef ? prescribed(deloadRef.workouts).filter(isHyroxHardSession).length : undefined;
    const maxQualityRuns = deloadRef
      ? prescribed(deloadRef.workouts).filter(x => x.t === 'hyrox_run_tempo' || x.t === 'hyrox_run_intervals').length
      : undefined;
    const sessionCaps = deloadRef ? sessionCapsOf(deloadRef.workouts) : undefined;
    const prevRunMin = phase === 'taper' && built[w - 2] ? runMinutesOf(built[w - 2].workouts) : undefined;
    const maxCircuitRounds = raceWeek && built[w - 2]
      ? Math.max(MIN_CIRCUIT_ROUNDS, circuitRoundsOf(built[w - 2].workouts))
      : undefined;
    // The Sunday-to-Monday spacing: the week before as built here, and at the
    // first replaced week also the week before as stored.
    const weekPrevSunday = w === storedBoundary && w >= 2
      ? mergePrevSundays(prevSunday, hyroxSundayFlags(state.wks?.[w - 2]?.triWorkouts ?? []))
      : prevSunday;
    let scale = 1;
    let omitted: HyroxGuardOmit[] = [];
    const make = () => {
      const adjustments: string[] = [];
      const workouts = hyroxWeekForRace(state, w, trainingWeeks, phase, layout, {
        budgetMin, longRunMin, runCeilingKm, prevSunday: weekPrevSunday, scale, omit: omitted, capCounts,
        maxHardSessions, maxQualityRuns, prevRunMin, maxCircuitRounds, sessionCaps,
      }, adjustments);
      return { workouts, adjustments, tss: hyroxPlannedTss(workouts), min: hyroxPlannedMinutes(workouts) };
    };
    // Ceilings: the acute:chronic guard (training weeks), the deload ceiling
    // (deload weeks) and the taper budget (taper weeks: planned minutes at
    // most taperFraction × the reference week). Every budget-sized session
    // shrinks by the same scale each round, so stations, bricks and easy runs
    // give way together. Session floors and fixed formats move the load in
    // whole sessions, so a training week still over its ceiling then takes
    // stations out of circuits and leaves sessions out
    // (HYROX_GUARD_OMIT_ORDER) and, last, trims the long run. A taper week keeps its run count and its long run and may sit
    // above its ceiling by the session floors.
    const capTss = Math.min(acwrCapTss ?? Infinity, deloadCapTss ?? Infinity);
    const capMin = phase === 'taper' ? budgetMin : (deloadCapMin ?? Infinity);
    const hasCeiling = capTss < Infinity || capMin < Infinity;
    const trainingCeiling = phase !== 'taper' && hasCeiling;
    const over = (a: { tss: number; min: number }) => a.tss > capTss + 1e-6 || a.min > capMin + 1e-6;
    const ratio = (a: { tss: number; min: number }) => Math.min(
      a.tss > 0 ? capTss / a.tss : Infinity,
      a.min > 0 ? capMin / a.min : Infinity,
    );
    // Solver step: shrink by the overshoot each round, at least 3% (a round
    // that lands exactly on a floor otherwise repeats), for at most 16
    // rounds. Numerical choices with no physiological meaning.
    const fit = () => {
      scale = 1;
      let a = make();
      for (let i = 0; i < 16 && over(a); i++) {
        scale *= Math.min(0.97, ratio(a));
        a = make();
      }
      return a;
    };
    let attempt = fit();
    if (trainingCeiling) {
      for (const o of HYROX_GUARD_OMIT_ORDER) {
        if (!over(attempt)) break;
        omitted = [...omitted, o];
        attempt = fit();
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
      for (let i = 0; i < 16 && over(attempt) && longRunMin != null && longRunMin > 0; i++) {
        longRunMin = Math.floor(longRunMin * Math.min(0.97, ratio(attempt)));
        attempt = make();
      }
      if (over(attempt)) {
        attempt.adjustments.push(deloadRef
          ? `W${w}: deload ${Math.round(attempt.min)} min / ${Math.round(attempt.tss)} TSS above ${HYROX_DELOAD_FACTOR} of the last loaded week (${Math.round(deloadRef.plannedMin)} min / ${Math.round(deloadRef.plannedTss)} TSS)`
          : `W${w}: planned load ${Math.round(attempt.tss)} TSS above the ${Math.round(capTss)} TSS guard`);
      }
    }
    // The taper never rises (running's rule, SCIENCE_LOG §CV.4): a taper week
    // whose session floors hold it above the week before loses sessions,
    // lowest priority first, until it is no heavier. Race week keeps its
    // primer.
    const before = built[w - 2];
    if (phase === 'taper' && before) {
      while (attempt.min > before.plannedMin + 1e-6) {
        const pick = attempt.workouts
          .filter(x => taperDropRank(x, raceWeek) >= 0)
          .sort((a, b) => taperDropRank(a, raceWeek) - taperDropRank(b, raceWeek))[0];
        if (!pick) break;
        attempt.workouts = attempt.workouts.filter(x => x !== pick);
        attempt.adjustments.push(`W${w}: ${pick.n} left out (the taper never rises)`);
        attempt.tss = hyroxPlannedTss(attempt.workouts);
        attempt.min = hyroxPlannedMinutes(attempt.workouts);
      }
    }

    built.push({
      week: w,
      phase,
      deload,
      raceWeek,
      budgetMin: Math.round(budgetMin),
      plannedMin: hyroxPlannedMinutes(attempt.workouts),
      plannedTss: attempt.tss,
      acwrCapTss,
      deloadCapMin,
      deloadCapTss,
      longRunMin: (() => {
        const l = attempt.workouts.find(isHyroxLongRun);
        return l ? (l.estimatedDurationMin ?? null) : null;
      })(),
      longestRunKm: longestRunKm(attempt.workouts),
      adjustments: attempt.adjustments,
      workouts: attempt.workouts,
    });
    prevSunday = hyroxSundayFlags(attempt.workouts);
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
