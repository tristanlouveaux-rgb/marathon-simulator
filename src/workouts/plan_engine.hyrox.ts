/**
 * HYROX plan engine.
 *
 * Generates a full HYROX training plan as Week[] compatible with the rest
 * of the app (triWorkouts field, same Week schema as triathlon mode).
 *
 * Generation flow:
 *   1. Phase each week (base → build → peak → taper) from week fraction
 *   2. Apply phase multiplier + deload factor to weekly available hours
 *   3. Distribute effective hours across runs / stations / bricks by HYROX_TIME_SPLIT
 *   4. Determine session kind mix for the phase (e.g. base = all easy, build = adds tempo+density)
 *   5. Generate each session via hyrox-generators.ts
 *   6. Enforce weekly MTL cap. Downgrade highest-MTL sessions if over cap
 *   7. Schedule onto days via scheduler.hyrox.ts
 *   8. Wrap into Week[]
 */

import { dropSessionsOnOrAfterRaceDay, clearStoredPlanRaceWindow, raceWeekPrimerDow, PRIMER_MIN_DAYS_OUT } from './race-day-rules';
import { storedPlanRaceLayout, type RaceWeekLayout } from './race-week-layout';
import { firstTrackedDow } from '@/ui/workout-status';
import type { SimulatorState, Week, Workout } from '@/types/state';
import type { AbilityBand } from '@/types/triathlon';
import type { InjuryState } from '@/types/injury';
import {
  HYROX_WEEKLY_SESSIONS,
  HYROX_TIME_SPLIT,
  HYROX_SESSION_MAX_MIN,
  HYROX_BUILD_MULT,
  HYROX_PEAK_MULT,
  HYROX_DELOAD_FACTOR,
  hyroxBaseMultiplier,
  computeHyroxPlanPhases,
} from '@/constants/hyrox-constants';
import { generateHyroxRun, generateHyroxStation, generateHyroxBrick, generateHyroxAssessment, hyroxEasyRunPaceSecKm, raceWeekCircuitStations, MIN_CIRCUIT_STATIONS } from './hyrox-generators';
import { hyroxLoadTierForState } from '@/calculations/hyrox-division';
import { hyroxPlanningStationBenchmarks } from '@/calculations/race-prediction.hyrox';
import { scheduleHyroxWeek, isHighIntensity as isHyroxHardSession, HYROX_DAY_NAMES, HYROX_TEMPO_HOME_DOW, hyroxPreferredDays } from './scheduler.hyrox';
import { getDisciplineCapacity } from '@/injury/engine';
import { hyroxEffortMultiplier } from '@/calculations/effort-multiplier.hyrox';
import { ctlGapMultiplier, isFourWeekCycleDeloadWeek, isRaceWeek } from './plan_engine';
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
export const HYROX_GENERATOR_VERSION = 17;

// ─── Phase assignment ─────────────────────────────────────────────────────────
// Phase assignment is delegated to `computeHyroxPlanPhases(totalWeeks)` from
// hyrox-constants.ts, which shares the strategy with running and triathlon and
// adds the double-periodization arc for plans ≥28 weeks.

function phaseMultiplier(
  phase: 'base' | 'build' | 'peak' | 'taper',
  weekIndex: number,
  totalWeeks: number
): number {
  switch (phase) {
    case 'base':  return hyroxBaseMultiplier(weekIndex);
    case 'build': return HYROX_BUILD_MULT;
    case 'peak':  return HYROX_PEAK_MULT;
    case 'taper': {
      const weeksFromEnd = totalWeeks - weekIndex;
      if (weeksFromEnd >= 2) return 0.75;
      if (weeksFromEnd === 1) return 0.55;
      return 0.30; // race week
    }
  }
}

// ─── Session kind selection ───────────────────────────────────────────────────

/**
 * Decide which run kind to use for each run slot in this phase.
 * Returns kinds in order [slot0, slot1, slot2, slot3].
 */
function runKinds(
  phase: 'base' | 'build' | 'peak' | 'taper',
  runsPerWeek: number,
  band: AbilityBand = 'novice'
): Array<'run_easy' | 'run_tempo' | 'run_intervals'> {
  const isExperienced = band !== 'total_beginner' && band !== 'beginner';

  // Single weekly run: vary quality by phase instead of always easy.
  // With only 1 run/week the quality slot (index 1) is never reached,
  // so we assign the phase-appropriate kind directly to the single slot.
  if (runsPerWeek === 1 && isExperienced) {
    switch (phase) {
      case 'base':   return ['run_easy'];
      case 'build':  return ['run_tempo'];
      case 'peak':   return ['run_intervals'];
      case 'taper':  return ['run_easy'];
    }
  }

  switch (phase) {
    case 'base':
      if (isExperienced && runsPerWeek >= 2) {
        return Array.from({ length: runsPerWeek }, (_, i) =>
          i === 1 ? 'run_tempo' : 'run_easy'
        ) as Array<'run_easy' | 'run_tempo' | 'run_intervals'>;
      }
      return Array(runsPerWeek).fill('run_easy');
    case 'build':
      return Array.from({ length: runsPerWeek }, (_, i) =>
        i === 1 ? 'run_tempo' : 'run_easy'
      ) as Array<'run_easy' | 'run_tempo' | 'run_intervals'>;
    case 'peak':
      return Array.from({ length: runsPerWeek }, (_, i) => {
        if (i === 1) return 'run_intervals';
        if (i === 2 && runsPerWeek >= 3) return 'run_tempo';
        return 'run_easy';
      }) as Array<'run_easy' | 'run_tempo' | 'run_intervals'>;
    case 'taper':
      return Array.from({ length: runsPerWeek }, (_, i) =>
        i === 1 ? 'run_tempo' : 'run_easy'
      ) as Array<'run_easy' | 'run_tempo' | 'run_intervals'>;
  }
}

/**
 * Station kind progression: technique-heavy in base, density-added in build/peak.
 */
function stationKinds(
  phase: 'base' | 'build' | 'peak' | 'taper',
  stationsPerWeek: number
): Array<'station_technique' | 'station_density'> {
  switch (phase) {
    case 'base':
    case 'taper':
      return Array(stationsPerWeek).fill('station_technique');
    case 'build':
      // 1 density + rest technique
      return Array.from({ length: stationsPerWeek }, (_, i) =>
        i === stationsPerWeek - 1 ? 'station_density' : 'station_technique'
      ) as Array<'station_technique' | 'station_density'>;
    case 'peak':
      // Majority density in peak. Race specificity
      return Array.from({ length: stationsPerWeek }, (_, i) =>
        i === 0 ? 'station_technique' : 'station_density'
      ) as Array<'station_technique' | 'station_density'>;
  }
}

/**
 * Brick kind: mini_brick for total_beginner/beginner only, full brick otherwise.
 * In taper: downgrade full brick → mini_brick to protect eccentric load.
 */
function brickKind(
  band: AbilityBand,
  phase: 'base' | 'build' | 'peak' | 'taper'
): 'brick' | 'mini_brick' {
  if (band === 'total_beginner' || band === 'beginner') return 'mini_brick';
  if (phase === 'taper') return 'mini_brick';
  return 'brick';
}

// ─── MTL cap enforcement ──────────────────────────────────────────────────────

/**
 * If the sum of session MTLs exceeds the cap, downgrade the highest-MTL
 * station or brick session to its lower-intensity sibling:
 *   station_density → station_technique
 *   brick → mini_brick (or reduce rounds in description. Here we use a simple
 *           flag approach: mark the session r and rpe down by 1, halve its MTL)
 *
 * This is intentionally simple. The MTL model is still calibrating (initial estimates).
 * A proportional scale-down avoids over-engineering when the caps may shift after dogfooding.
 */
function enforceMTLCap(sessions: Workout[], cap: number): Workout[] {
  const total = sessions.reduce((sum, s) => sum + (s.musculoTendonLoad ?? 0), 0);
  if (total <= cap) return sessions;

  const ratio = cap / total;
  // Scale all MTL values proportionally rather than surgical downgrade (v1 simplicity).
  return sessions.map(s => ({
    ...s,
    musculoTendonLoad: s.musculoTendonLoad ? Math.round(s.musculoTendonLoad * ratio) : undefined,
    hyroxComponents: s.hyroxComponents?.map(c => ({
      ...c,
      mtl: Math.round(c.mtl * ratio),
    })),
  }));
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
  totalWeeks: number,
  phase: 'base' | 'build' | 'peak' | 'taper',
  raceWeek?: HyroxRaceWeek,
): Workout[] {
  // Note (2026-05-26): clinical phase replacement removed for the same
  // reason as in plan_engine.triathlon.ts. The discipline gates are
  // the right mechanism for HYROX, not blanket "Complete Rest" cards
  // that ignore which components the user can still do.

  const hx = state.hyroxConfig!;
  const band = hx.athleteBand;
  // Use per-athlete session counts from hyroxConfig (set at init from onboarding slider),
  // falling back to band defaults if not set (e.g. older state without slider).
  const sessions = {
    runs:     hx.runsPerWeek     ?? HYROX_WEEKLY_SESSIONS[band].runs,
    stations: hx.stationSessionsPerWeek ?? HYROX_WEEKLY_SESSIONS[band].stations,
    bricks:   hx.bricksPerWeek   ?? HYROX_WEEKLY_SESSIONS[band].bricks,
  };
  const bodyWeightKg = state.bodyWeightKg;
  // Station loads for MTL follow the athlete's division (hyrox-division.ts).
  const loadTier = hyroxLoadTierForState(state);

  // Hours available this week
  const mult = phaseMultiplier(phase, weekIndex, totalWeeks);
  // Honour a holiday-forced deload the same way running's plan_engine.ts does
  // (deload = ctx.forceDeload || isDeloadWeek(...)). The holiday modal sets
  // wk.forceDeload on weeks that overlap the holiday; without this the HYROX
  // engine ignored it and regenerated those weeks at full load.
  const forceDeload = !!(state.wks?.[weekIndex - 1] as any)?.forceDeload;
  const deload = forceDeload || isFourWeekCycleDeloadWeek(weekIndex, phase);
  // Execution → next-week load. Trailing RPE across all HYROX sessions scales the weekly
  // budget, mirroring running's `effortMultiplier` (applied multiplicatively on top of
  // phase + deload, per plan_engine.ts dMult). Only weeks ≥ current are scaled — past
  // weeks keep their real prescribed load (don't rewrite history). Non-compounding:
  // regeneration rebuilds the baseline budget before re-applying the current multiplier.
  // See effort-multiplier.hyrox.ts / SCIENCE_LOG §AU.
  const effortMult = weekIndex >= (state.w ?? 1) ? hyroxEffortMultiplier(state) : 1.0;
  // MTL-gap re-anchor (mirror of running's CTL-gap, SCIENCE_LOG §BR). When chronic MTL fell behind
  // the plan, scale the week's hours down in proportion (reduce-only). Suppressed on deload/taper
  // (already reduced) and on past weeks. Combined with effort under ONE clamp [HYROX_DELOAD_FACTOR,
  // 1.15] so the two volume levers can't overstack. Reading the stored wk.ctlRatio mirrors the
  // forceDeload read above. Converges because effectiveHours drives both duration and planned MTL.
  const mtlGapMult = (weekIndex >= (state.w ?? 1) && !deload && phase !== 'taper')
    ? ctlGapMultiplier((state.wks?.[weekIndex - 1] as any)?.ctlRatio ?? 1)
    : 1.0;
  const adaptive = mtlGapMult === 1.0
    ? effortMult
    : Math.max(HYROX_DELOAD_FACTOR, Math.min(1.15, effortMult * mtlGapMult));
  const effectiveHours = hx.weeklyHoursAvailable * mult * (deload ? HYROX_DELOAD_FACTOR : 1) * adaptive;

  // Distribute hours
  let runHours       = effectiveHours * HYROX_TIME_SPLIT.runs;
  const stationHours = effectiveHours * HYROX_TIME_SPLIT.stations;
  const brickHours   = effectiveHours * HYROX_TIME_SPLIT.bricks;

  // Commute runs are appended on top of the prescribed HYROX run sessions,
  // not substituted for them (revised 2026-05-20. See SCIENCE_LOG §AK).
  // Commute-slot emission happens after the prescribed sessions are built.
  const commuteDays = state.commuteConfig?.enabled && state.commuteConfig.commuteDaysPerWeek > 0
    ? state.commuteConfig.commuteDaysPerWeek
    : 0;

  // Clamp session duration to per-type caps (minimum 35 min for station sessions).
  function clampDur(kind: string, raw: number): number {
    const minDur = kind.includes('station') ? 35 : 20;
    return Math.max(minDur, Math.min(HYROX_SESSION_MAX_MIN[kind] ?? 90, Math.round(raw)));
  }

  const runMin     = sessions.runs     > 0 ? (runHours     / sessions.runs)     * 60 : 0;
  const stationMin = sessions.stations > 0 ? (stationHours / sessions.stations) * 60 : 0;
  const brickMin   = sessions.bricks   > 0 ? (brickHours   / sessions.bricks)   * 60 : 0;

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
  const stationBenchmarks = hyroxPlanningStationBenchmarks(state);
  const workouts: Workout[] = [];

  // Race week is sharpening, not training (SCIENCE_LOG §CE): its sessions take
  // the taper kinds whatever the phase label (tempo primer, technique circuits).
  const kindPhase = raceWeek ? 'taper' : phase;

  // Run sessions
  const rKinds = runKinds(kindPhase, sessions.runs, band);
  for (let i = 0; i < sessions.runs; i++) {
    const kind = rKinds[i];
    workouts.push(generateHyroxRun({
      kind,
      targetMinutes: clampDur(kind, runMin),
      band,
      phase,
      slotIndex: i + weekIndex,  // week-level slot so rotation varies across weeks
      bodyWeightKg,
      runPaceSecKm: hx.hyroxRunPaceSecKm,
    }));
  }

  // Station sessions. Week 1, first station slot is the assessment for everyone.
  // Users with existing benchmarks can skip/replace it like any other workout; taking
  // it again refreshes their numbers. Race week has no assessment: it passes
  // through every station, sleds included.
  const needsAssessment = weekIndex === 1 && !raceWeek;
  const sKinds = stationKinds(kindPhase, sessions.stations);
  // Race week: technique circuits without the eccentric-heavy and sled stations
  // (RACE_WEEK_EXCLUDED_STATIONS). Without enough of the remaining stations (no
  // erg access) race week has no station circuit and the slot is left out.
  // Before (review 2026-10-08) each slot became an easy run, a rule with no
  // taper precedent that raised race-week running above the week before's in
  // 363 of 648 no-erg plans (total_beginner: four 20-min runs against 48 min).
  // Running's taper never adds a run (rule 5 carries an easy makeup only
  // under the taper ceiling), and a slot that has no safe content is dropped,
  // as a primer with no window day is.
  const raceWeekCircuitOk = !raceWeek || raceWeekCircuitStations(hx.stationAccess).length >= MIN_CIRCUIT_STATIONS;
  for (let i = 0; i < sessions.stations; i++) {
    if (needsAssessment && i === 0) {
      workouts.push(generateHyroxAssessment({ band, stationAccess: hx.stationAccess, bodyWeightKg, loadTier }));
      continue;
    }
    if (!raceWeekCircuitOk) continue;
    const kind = sKinds[i];
    workouts.push(generateHyroxStation({
      kind,
      targetMinutes: clampDur(kind, stationMin),
      band,
      stationAccess: hx.stationAccess,
      phase,
      slotIndex: i + weekIndex,
      bodyWeightKg,
      stationBenchmarks,
      raceWeek: !!raceWeek,
      loadTier,
    }));
  }

  // Brick sessions. Race week has none: the race is the week's brick, as it
  // takes the long-run slot in running and triathlon (SCIENCE_LOG §CT).
  if (!raceWeek && sessions.bricks > 0 && (phase !== 'base' || band === 'beginner' || band === 'total_beginner')) {
    // Bricks appear from week 1 for beginners (mini_brick), from build phase for others.
    const phaseAllowsBrick = phase !== 'base' || band === 'beginner' || band === 'total_beginner';
    for (let i = 0; i < sessions.bricks; i++) {
      if (!phaseAllowsBrick && i === 0) continue;
      const kind = brickKind(band, phase);
      workouts.push(generateHyroxBrick({
        kind,
        targetMinutes: clampDur(kind, brickMin),
        band,
        stationAccess: hx.stationAccess,
        phase,
        slotIndex: i + weekIndex,
        bodyWeightKg,
        stationBenchmarks,
        loadTier,
      }));
    }
  }

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
    const commuteMin = Math.round((oneWayKm * hyroxEasyRunPaceSecKm(band, hx.hyroxRunPaceSecKm)) / 60);
    for (let i = 0; i < commuteDays; i++) {
      if (bi) {
        workouts.push({
          t: 'easy',
          n: `Commute ${i + 1} (morning)`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          discipline: 'run',
          commute: true,
          estimatedDurationMin: commuteMin,
        });
        workouts.push({
          t: 'easy',
          n: `Commute ${i + 1} (evening)`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          discipline: 'run',
          commute: true,
          estimatedDurationMin: commuteMin,
        });
      } else {
        workouts.push({
          t: 'easy',
          n: `Commute ${i + 1}`,
          d: `${oneWayKm}km`,
          rpe: 3,
          r: 3,
          discipline: 'run',
          commute: true,
          estimatedDurationMin: commuteMin,
        });
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

  // Enforce MTL cap
  const capped = enforceMTLCap(gated, hx.mtlCap);

  // Stable per-slot ids (W{week}-{type}-{idx}), the triathlon engine's helper.
  // Every HYROX writer keys by `id ?? n` (Mark as Done, quick done, the matcher's
  // station and run branches, the status chip). Without ids a week's two
  // 'Easy Run' or two 'Station Circuit' sessions shared one slot key: one done
  // showed both done, and a second synced run found no free slot.
  // Race week: each session only on the days the race-day rules allow; one
  // that finds no free allowed day is left out (raceWeekDays).
  const placed = raceWeek?.layout ? { ...raceWeek, layout: raceWeek.layout } : null;
  const scheduled = scheduleHyroxWeek(
    capped, band,
    placed ? (w) => raceWeekDays(placed, weekIndex, w) : undefined,
  );
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

// ─── Single-week regenerator (used by injury-gate updates) ───────────────────

/**
 * Regenerate a single HYROX week in-place. Preserves the existing Week's
 * actuals / rated / skip arrays, replaces triWorkouts. Mirrors the tri
 * regenerator and is called after an injury gate change so the plan reflects
 * the new gates immediately (the version-bump path in main.ts only fires
 * when storedVersion < HYROX_GENERATOR_VERSION).
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
  const workouts = hyroxWeekForRace(state, weekIndex, trainingWeeks, p.ph, layout);
  return {
    ...existing,
    ph: p.ph as any,
    ...(p.checkpoint ? { checkpoint: true } : { checkpoint: existing.checkpoint }),
    triWorkouts: workouts,
  };
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
 *     (raceWeekDays).
 *   - Rules 3 and 4: in the week before race week, nothing in the last 6 days
 *     before race day; its full brick moves to 7 or more days out, never next
 *     to another hard session (clearStoredPlanRaceWindow).
 */
function hyroxWeekForRace(
  state: SimulatorState, weekIndex: number, trainingWeeks: number,
  phase: 'base' | 'build' | 'peak' | 'taper', layout: RaceWeekLayout | null,
): Workout[] {
  const firstDow = firstTrackedDow(state.planStartDate, weekIndex, state.planCreatedAt);
  const raceWeek = isRaceWeek(weekIndex, trainingWeeks, state.continuousMode) ? { layout, firstDow } : undefined;
  const generated = dropSessionsOnOrAfterRaceDay(
    generateWeekSessions(state, weekIndex, trainingWeeks, phase, raceWeek), weekIndex, state.planStartDate, state.hyroxConfig?.raceDate,
  );
  if (!layout) return generated;
  return clearStoredPlanRaceWindow(generated, {
    weekIndex,
    layout,
    isLongSession: (w) => w.t === 'hyrox_brick',
    isHard: isHyroxHardSession,
    firstScheduleDow: firstDow,
    dayNames: HYROX_DAY_NAMES,
  });
}

// ─── Top-level plan generator ─────────────────────────────────────────────────

export function generateHyroxPlan(state: SimulatorState): Week[] {
  if (!state.hyroxConfig) return [];

  const totalWeeks = state.tw || 16;
  // Race week and the closing week follow the running layout (mirror of
  // generateTriathlonPlan): phases and the taper ramp run over the training
  // weeks, so race week is the week holding race day minus 3.
  const layout = storedPlanRaceLayout(totalWeeks, state.planStartDate, state.hyroxConfig.raceDate);
  const trainingWeeks = layout?.trainingWeeks ?? totalWeeks;
  const planPhases = computeHyroxPlanPhases(trainingWeeks);
  const weeks: Week[] = [];

  for (let w = 1; w <= totalWeeks; w++) {
    const closing = w > trainingWeeks;
    const p = closing ? { ph: 'taper' as const, checkpoint: false } : planPhases[w - 1];
    const phase = p.ph;
    const workouts = closing ? [] : hyroxWeekForRace(state, w, trainingWeeks, phase, layout);

    weeks.push({
      w,
      ph: phase as any,
      ...(closing ? { raceClosing: true } : {}),
      ...(p.checkpoint ? { checkpoint: true } : {}),
      triWorkouts: workouts,
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

  return weeks;
}
