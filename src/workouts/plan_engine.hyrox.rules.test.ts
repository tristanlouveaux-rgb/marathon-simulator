/**
 * HYROX plan rules over plan lengths 8 to 24, every band and the hours range
 * (lane H2a, parameter sheet 2026-10-12 and Tristan's decisions of the same
 * day; round 4 decisions D1 to D8 of 2026-10-13). Real initializer, real
 * generator. Every week of every plan must hold:
 *   - the acute:chronic guard: a training week's planned load (canonical TSS)
 *     at most ACWR_SAFE_HIGH x the mean of the previous 4 planned weeks, weeks
 *     before week 1 counting as the plan's chronic seed (D4: the larger of the
 *     logged weekly load and the nominal week 1; deload weeks and the week
 *     after them included), or the nominal week 1 when that is larger (round
 *     7: the guard never holds a week under the plan's own first week);
 *   - the single-run rule: no run longer than 110% of the longest run of the
 *     previous 4 weeks (LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, distance),
 *     within the metre the generator rounds distances to;
 *   - no two hard sessions on consecutive days, Sunday to the next Monday
 *     included; at most 3 hard sessions and 2 hard runs a week;
 *   - 48 h between eccentric sessions (no two on consecutive days, across
 *     weeks too) and at most the structure's eccentric count (a generator
 *     check, not a sourced cap);
 *   - taper weeks at most taperFraction (0.70, then 0.55) of the reference
 *     week (the last loaded week before the taper), race week tolerated above
 *     0.55 only by its fixed 25-min primer when the primer is all it holds,
 *     and the smallest circuit (MIN_CIRCUIT_ROUNDS rounds of
 *     MIN_CIRCUIT_STATIONS stations) exempt in both weeks, week 1's
 *     assessment too when week 1 is the taper (round 7); never above the week
 *     before, race week excepted by the primer alone (SCIENCE_LOG §CE update
 *     4) or by the primer and its smallest circuit and nothing else (round
 *     7); never above the chosen weekly hours; no more station and brick minutes, and
 *     no more station and brick MTL, than the reference week, or than the
 *     taper's smallest circuit when that is larger (round 6 review, pass 2); the taper long
 *     run at most TAPER_LONG_RUN_FRACTION of the longest long run of the 4
 *     weeks before (review 2026-10-13: taper week 1 sat up to 0.98 of the
 *     reference week, race week up to 0.93);
 *   - deload weeks at most HYROX_DELOAD_FACTOR of the last loaded week in
 *     planned minutes and TSS, with no more hard sessions or quality runs
 *     than that week (running's CV.4; review 2026-10-12: the median deload
 *     cut 9.4%);
 *   - race week holds the primer whenever it holds a run, at
 *     HYROX_RACE_WEEK_PRIMER_MIN with 10 min of tempo work, and its circuit
 *     no more rounds than the week before's;
 *   - every training week whose tier format calls for a quality run holds
 *     one, or the week's hyroxPlanNotes say why it does not (the share, the
 *     110% ceiling, the long run, the guard, the deload, the run slots);
 *   - the weekly MTL at most the cap, or a note says the floors held it above;
 *   - the long run is the week's longest run; week 1's long run at most the
 *     long-run start (no logged runs: 30 min for the beginner tier, the tier
 *     start otherwise);
 *   - every training week after week 1 holds a station session or a brick,
 *     easy erg work not counting as either (review 2026-10-13: at 6 h the
 *     guard emptied up to 10 weeks in a row), and a training week holding
 *     easy erg work always holds one;
 *   - no standalone run under HYROX_RUN_FLOOR_MIN but the primer, and no
 *     race-week easy run longer than the week before's long run;
 *   - no brick in base, before plan week 5 or in race week;
 *   - one prescribed session a day;
 *   - no week above the chosen weekly hours (review 2026-10-13: 2-h peak
 *     weeks reached 113%);
 *   - D1: no week holds more prescribed sessions than the athlete's chosen
 *     total; easy erg work is neither hard nor eccentric, each session at
 *     least HYROX_RUN_FLOOR_MIN and at most the tier long-run cap, never lifts
 *     a week above its budget or its MTL above the cap; a week with a free
 *     session slot and HYROX_RUN_FLOOR_MIN or more of its budget unprescribed
 *     says why in its notes;
 *   - D2: a training week's running (runs and brick runs) at most
 *     HYROX_RUN_SHARE x the chosen weekly minutes;
 *   - D3: at the default hours of 6 h or more, no training week loses its tier
 *     quality run to the guard or the weekly hours;
 *   - D5: the week right before the race taper is never a deload;
 *   - D6: race week holds no more runs than the reference week, and keeps its
 *     circuit while it keeps an easy run unless the reference week's station
 *     work or the race-week days excluded it.
 * The round-4 review fixes (2026-10-13, second pass) add: the chronic seed
 * fixed at plan creation (D4), a done easy erg recording its load, the 110%
 * rule's pre-plan exposure counting a logged run in weeks 2 to 4 (D8), and a
 * low logged load giving no run under the floor, no erg-only week and no
 * single-run jump. The third pass adds logged loads of 20, 30, 40, 50 and 100
 * TSS run through every rule above: station work every training week (a ceiling
 * leaves the long run out before the last station session or brick), a
 * guard or deload ceiling exceeded only by a week holding just its last
 * station session or brick and saying so, week 1's assessment exempt from
 * week 1's guard and noted, and race week holding a run whenever it holds a
 * run slot (the primer, or one easy run at the run floor when the primer is
 * above the 110% ceiling, noted).
 * Round 6 (2026-10-13, one constraint hierarchy, buildHyroxTrainingWeeks):
 * D2's share sizes the easy runs only (the long run, the quality run and the
 * brick runs alone may sit above it, with no easy run); a loaded week's long
 * run is never shorter than the previous loaded week's unless the week's
 * size cut it and the week says so; decision B is a report (total minutes
 * fall by at most one easy session), not a constraint. Pass 2 of the round-6
 * review: a week the guard or the deload ceiling holds is the same week at
 * every chosen hours above its size, race week keeps a circuit unless its
 * days or the taper fractions exclude it, and the hours line marks only weeks
 * whose phase budget is the chosen hours and where one more session holds
 * 20 min or more.
 * Round 7 (2026-10-14): the guard never sits under the nominal week 1 and
 * the chronic seed is the larger of the logged load and that week; the race
 * taper's smallest circuit is exempt from its fractions (week 1's assessment
 * too when week 1 is the taper), race week rising above the week before only
 * by the primer and that circuit; no deload session longer or heavier than
 * the last loaded week's; a deload's easy run ranks above the mini brick; a
 * week whose long run a ceiling cut keeps no easy run above the run floor;
 * the B sweep asserts its bound and the quality runs for all nine variants;
 * the hours line holds against the real plan with one more session.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  get length() { return Object.keys(store).length; },
  key: (i: number) => Object.keys(store)[i] ?? null,
});
vi.stubGlobal('alert', vi.fn());
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { getState, getMutableState, resetState } from '@/state/store';
import { defaultOnboardingState, type OnboardingState } from '@/types/onboarding';
import type { SimulatorState, Week, Workout } from '@/types';
import type { AbilityBand, HyroxStation } from '@/types/triathlon';
import { plannedTssPerMin } from '@/constants';
import { ACWR_SAFE_HIGH } from '@/constants/triathlon-constants';
import {
  HYROX_HOURS_RANGE, HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK, HYROX_FIRST_BRICK_WEEK,
  HYROX_MAX_HARD_SESSIONS, HYROX_MAX_HARD_RUNS, HYROX_MTL_CAP, HYROX_WEEKLY_SESSIONS,
  HYROX_QUALITY_FORMATS, HYROX_DELOAD_FACTOR, HYROX_RACE_WEEK_PRIMER_MIN, HYROX_WEEKLY_STRUCTURE,
  HYROX_RUN_SHARE, HYROX_RUN_FLOOR_MIN, HYROX_LONG_RUN, HYROX_EASY_RPE,
  hyroxTier, hyroxSessionTotal,
} from '@/constants/hyrox-constants';
import { isHyroxDeloadWeek, LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, LONG_RUN_LOOKBACK_WEEKS, TAPER_LONG_RUN_FRACTION, LONG_SOFT_FLOOR_MIN } from './plan_engine';
import { taperFraction } from './phases';
import { isHighIntensity, isHardRun, isEccentricSession, isHyroxLongRun } from './scheduler.hyrox';
import {
  hyroxRunLengthKm, generateHyroxRun, generateHyroxStation, withHyroxRounds, withoutHyroxStation,
  generateHyroxEasyErg, isHyroxEasyErg, MIN_CIRCUIT_ROUNDS, MIN_CIRCUIT_STATIONS,
} from './hyrox-generators';
import { resolvePlannedWeekPhase } from '@/calculations/planned-week-target';
import { generateHyroxPlan, generateHyroxPlanDetailed, regenerateHyroxWeek, regenerateHyroxWeeksFrom, buildHyroxTrainingWeeks, hyroxRaceTaperFloorCircuit } from './plan_engine.hyrox';
import { planTrainingWeeks, storedPlanRaceLayout } from './race-week-layout';
import { applyHyroxGeneratorRegen } from '@/state/hyrox-plan-regen';

const BANDS: AbilityBand[] = ['total_beginner', 'beginner', 'novice', 'intermediate', 'advanced', 'competitive'];
/** Previous open-singles finish time that bands an athlete; null = first-timer.
 *  The planning band reads the pooled Open Singles field (no sex in these
 *  fixtures; thresholds 3774, 4869, 6318 and 7853 s, S8-S9). Beginner is that
 *  band's median finish (8662 s, HYROX_S89_BAND_SEEDS): the old 7800 s banded
 *  beginner on the global scale but novice on the planning field. */
const BAND_PREV_SEC: Record<AbilityBand, number | null> = {
  total_beginner: null, beginner: 8662, novice: 6600, intermediate: 5400, advanced: 4200, competitive: 3300,
};
const EPS = 1e-6;
/** Distances are stored to the metre (generateHyroxRun), so the 110% rule is
 *  checked within 1 m. */
const METRE_KM = 0.001;
/** Week-1 long run with no logged runs (HYROX_LONG_RUN start; beginner tier 30). */
const START_NO_HISTORY: Record<'beginner' | 'intermediate' | 'advanced', number> = { beginner: 30, intermediate: 60, advanced: 75 };

beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

/** A plan from the real initializer. `loggedWeeklyTss`: the athlete's logged
 *  weekly load (signalBBaseline) when the plan is created. `loggedRunMin`: a
 *  run of that many minutes logged 10 days before the plan (no distance: its
 *  duration stands in). */
function build(band: AbilityBand, hours: number, weeks: number, over: Partial<OnboardingState> = {}, loggedWeeklyTss?: number, loggedRunMin?: number): SimulatorState {
  resetState();
  const ms = getMutableState();
  if (loggedWeeklyTss != null) ms.signalBBaseline = loggedWeeklyTss;
  if (loggedRunMin != null) {
    ms.onboardingRunHistory = [{ startTime: new Date(Date.now() - 10 * 86400000).toISOString(), activityType: 'RUNNING', distKm: 0, durSec: loggedRunMin * 60 } as never];
  }
  const sec = BAND_PREV_SEC[band];
  initializeHyroxSimulator({
    ...defaultOnboardingState, name: 'QA', currentStep: 'initializing',
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: hours, planDurationWeeks: weeks, customRaceDate: null,
    ...(sec != null ? { previousHyroxTimeSec: sec, hyroxPreviousTimeFormat: 'open_singles' } : {}),
    ...(loggedRunMin != null ? { onboardingRunHistory: ms.onboardingRunHistory } : {}),
    ...over,
  } as OnboardingState);
  return getState();
}

const prescribed = (wk: Week | undefined): Workout[] => (wk?.triWorkouts ?? []).filter(w => w.commute !== true);
const minutes = (wk: Week | undefined) => prescribed(wk).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
const tss = (wk: Week | undefined) =>
  prescribed(wk).reduce((a, w) => a + (w.estimatedDurationMin ?? 0) * plannedTssPerMin(w.t, w.rpe ?? w.r ?? 5), 0);
const runs = (wk: Week | undefined) => prescribed(wk).filter(w => w.discipline === 'run');
const longestKm = (wk: Week | undefined) => Math.max(0, ...runs(wk).map(hyroxRunLengthKm));
const isQuality = (w: Workout) => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals';
const isCircuit = (w: Workout) => w.t === 'hyrox_station_technique' || w.t === 'hyrox_station_density';
const notes = (wk: Week | undefined) => wk?.hyroxPlanNotes ?? [];
/** Station and brick work: a station session or a brick, not easy erg work. */
const isWork = (w: Workout) => (w.discipline === 'station' || w.discipline === 'brick') && !isHyroxEasyErg(w);
/** Station and brick work of a week: minutes and MTL. */
const stationWork = (wk: Week | undefined) => prescribed(wk)
  .filter(isWork)
  .reduce((a, w) => ({ min: a.min + (w.estimatedDurationMin ?? 0), mtl: a.mtl + (w.musculoTendonLoad ?? 0) }), { min: 0, mtl: 0 });
/** Running of a week: standalone runs plus the run components of station and brick sessions. */
const runningMin = (wk: Week | undefined) => prescribed(wk).reduce((a, w) => a + (w.discipline === 'run'
  ? (w.estimatedDurationMin ?? 0)
  : (w.hyroxComponents ?? []).filter(c => c.type === 'run').reduce((b, c) => b + ((c.durationSec ?? 0) * (w.hyroxRounds ?? 1)) / 60, 0)), 0);
const brickRunMin = (wk: Week | undefined) => runningMin(wk) - runs(wk).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
/** The race taper's smallest station work, exempt from the 0.70 / 0.55
 *  fractions in taper week 1 and race week (round 7): the week's shortest
 *  station circuit of at most MIN_CIRCUIT_ROUNDS rounds and
 *  MIN_CIRCUIT_STATIONS stations, or, in a week holding no circuit, its
 *  shortest brick of at most MIN_CIRCUIT_ROUNDS rounds, in minutes (0: none). */
const taperExemptMin = (wk: Week | undefined): number => {
  const circuits = prescribed(wk).some(isCircuit);
  const m = Math.min(Infinity, ...prescribed(wk).filter(x => (circuits
    ? isCircuit(x) && (x.hyroxComponents ?? []).filter(c => c.type !== 'run').length <= MIN_CIRCUIT_STATIONS
    : x.discipline === 'brick') && (x.hyroxRounds ?? 0) <= MIN_CIRCUIT_ROUNDS).map(x => x.estimatedDurationMin ?? 0));
  return Number.isFinite(m) ? m : 0;
};
/** The athlete's chosen weekly session total (the stored counts). */
const chosenSessions = (s: SimulatorState) => {
  const hx = s.hyroxConfig!;
  const def = HYROX_WEEKLY_SESSIONS[hx.athleteBand];
  return hyroxSessionTotal({ runs: hx.runsPerWeek ?? def.runs, stations: hx.stationSessionsPerWeek ?? def.stations, bricks: hx.bricksPerWeek ?? def.bricks });
};
/** Deload weeks of a built plan (isHyroxDeloadWeek, 0-indexed). */
const deloadOf = (wks: readonly Week[]) => {
  const phases = wks.map(w => w.ph);
  return (i: number) => isHyroxDeloadWeek(i + 1, phases);
};

/** A week holding only its last station session or brick: no run, no easy
 *  erg work, one station or brick session. A ceiling never takes that session
 *  (review 2026-10-13), so at its floor it may sit above the guard or the
 *  deload ceiling, and the week's notes say so. */
const lastWorkOnly = (wk: Week | undefined) => {
  const ws = prescribed(wk);
  return runs(wk).length === 0 && !ws.some(isHyroxEasyErg) && ws.filter(isWork).length === 1;
};

/** Every rule violation of a built plan, as readable strings. `defaultHours`:
 *  the plan sits at its band's default hours (the D3 coverage rule). */
function violations(s: SimulatorState, opts: { defaultHours?: boolean } = {}): string[] {
  const out: string[] = [];
  const tw = planTrainingWeeks(s);
  const wks = s.wks.slice(0, tw);
  const hx = s.hyroxConfig!;
  const tier = hyroxTier(hx.athleteBand);
  const isDeload = deloadOf(wks);
  const { detail } = generateHyroxPlanDetailed(structuredClone(s));
  const seed = detail[0]?.chronicSeedTss ?? 0;
  const chosen = chosenSessions(s);
  const hoursMin = hx.weeklyHoursAvailable * 60;
  const ergAccess = hx.stationAccess.skiErg || hx.stationAccess.rowErg;
  let taperStart = tw + 1;
  for (let w = tw; w >= 1 && wks[w - 1].ph === 'taper'; w--) taperStart = w;
  const taperLen = tw - taperStart + 1;
  // The last loaded week before week i (0-indexed): not a taper or deload week.
  const lastLoaded = (i: number) => {
    for (let k = i - 1; k >= 0; k--) if (wks[k].ph !== 'taper' && !isDeload(k)) return k;
    return -1;
  };
  // D5: the week right before the race taper never deloads.
  if (taperStart >= 2 && taperStart <= tw && isDeload(taperStart - 2)) out.push(`W${taperStart - 1}: deload right before the taper`);
  if (taperStart >= 2 && taperStart <= tw && detail[taperStart - 2]?.deload) out.push(`W${taperStart - 1}: the generator deloads the week before the taper`);

  // Placement across the whole plan: hard and eccentric adjacency, Sun to Mon included.
  const flat: Array<{ day: number; w: Workout; week: number }> = [];
  wks.forEach((wk, i) => {
    const days = prescribed(wk).map(w => w.dayOfWeek);
    if (new Set(days).size !== days.length) out.push(`W${i + 1}: two sessions on one day`);
    for (const w of prescribed(wk)) flat.push({ day: i * 7 + (w.dayOfWeek ?? 0), w, week: i + 1 });
  });
  flat.sort((a, b) => a.day - b.day);
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length && flat[j].day - flat[i].day <= 1; j++) {
      const a = flat[i]; const b = flat[j];
      if (isHighIntensity(a.w) && isHighIntensity(b.w)) out.push(`W${a.week}/W${b.week}: hard ${a.w.n} and ${b.w.n} on consecutive days`);
      if (isEccentricSession(a.w) && isEccentricSession(b.w)) out.push(`W${a.week}/W${b.week}: eccentric ${a.w.n} and ${b.w.n} within 48 h`);
    }
  }

  for (let i = 0; i < wks.length; i++) {
    const wk = wks[i];
    const w = i + 1;
    const ph = wk.ph as 'base' | 'build' | 'peak' | 'taper';
    const ws = prescribed(wk);
    const raceWeek = w === tw;
    // Weekly hours are a ceiling (scope item 9).
    if (minutes(wk) > s.hyroxConfig!.weeklyHoursAvailable * 60 + EPS) out.push(`W${w}: ${minutes(wk)} min above the ${s.hyroxConfig!.weeklyHoursAvailable} h chosen`);
    // D1: the chosen session total, and easy erg work.
    const refI = ph === 'taper' || isDeload(i) ? lastLoaded(i) : -1;
    const maxSessions = refI >= 0 ? Math.min(chosen, prescribed(wks[refI]).length) : chosen;
    if (ws.length > chosen) out.push(`W${w}: ${ws.length} sessions above the chosen ${chosen}`);
    const ergs = ws.filter(isHyroxEasyErg);
    for (const e of ergs) {
      if (isHighIntensity(e) || isEccentricSession(e)) out.push(`W${w}: easy erg counted hard or eccentric`);
      if ((e.estimatedDurationMin ?? 0) < HYROX_RUN_FLOOR_MIN || (e.estimatedDurationMin ?? 0) > HYROX_LONG_RUN[tier].capMin) out.push(`W${w}: easy erg ${e.estimatedDurationMin} min`);
      if (e.rpe !== HYROX_EASY_RPE) out.push(`W${w}: easy erg at RPE ${e.rpe}`);
    }
    if (ergs.length > 0) {
      if (minutes(wk) > (detail[i]?.budgetMin ?? Infinity) + 1) out.push(`W${w}: easy erg lifts the week to ${minutes(wk)} min above its ${detail[i]?.budgetMin}-min budget`);
      const mtlWithErg = (wk.triWorkouts ?? []).reduce((a, x) => a + (x.musculoTendonLoad ?? 0), 0);
      if (mtlWithErg > hx.mtlCap + EPS) out.push(`W${w}: easy erg lifts the week's MTL to ${mtlWithErg.toFixed(0)} above the ${hx.mtlCap} cap`);
    }
    // Easy erg work fills what the sessions leave of the week's budget (a
    // deload's, up to its ceiling): a week HYROX_RUN_FLOOR_MIN or more under
    // it says why (a ceiling or the MTL cap holds it, the chosen sessions are
    // full, no erg access, or a session left out).
    const fillTarget = Math.min(detail[i]?.budgetMin ?? 0, detail[i]?.deloadCapMin ?? Infinity);
    if (minutes(wk) < fillTarget - HYROX_RUN_FLOOR_MIN
      && !notes(wk).some(n => /left unprescribed|holds it\)|left out/.test(n))) {
      out.push(`W${w}: ${ws.length} of ${maxSessions} sessions, ${minutes(wk)} of ${Math.round(fillTarget)} min and no note why`);
    }
    // D2: training-week running at most HYROX_RUN_SHARE x the chosen
    // minutes. The share sizes the easy runs only: the long run and the
    // quality run are the first allocation and the brick runs come with the
    // bricks (round 6), so they alone may sit above it, with no easy run.
    const fixedRunMin = brickRunMin(wk) + runs(wk).filter(r => isHyroxLongRun(r) || isQuality(r)).reduce((a, r) => a + (r.estimatedDurationMin ?? 0), 0);
    if (ph !== 'taper' && !raceWeek && runningMin(wk) > Math.max(HYROX_RUN_SHARE * hoursMin, fixedRunMin) + 1) {
      out.push(`W${w}: running ${runningMin(wk).toFixed(0)} min above ${HYROX_RUN_SHARE} x ${hoursMin}`);
    }
    // Hard-session counts.
    if (ws.filter(isHighIntensity).length > HYROX_MAX_HARD_SESSIONS) out.push(`W${w}: ${ws.filter(isHighIntensity).length} hard sessions`);
    if (ws.filter(isHardRun).length > HYROX_MAX_HARD_RUNS) out.push(`W${w}: ${ws.filter(isHardRun).length} hard runs`);
    // Eccentric generator check.
    const structPhase = ph === 'taper' || raceWeek ? 'peak' : ph;
    const ecc = ws.filter(isEccentricSession).length;
    if (ecc > HYROX_ECCENTRIC_SESSIONS_GENERATOR_CHECK[tier][structPhase]) out.push(`W${w}: ${ecc} eccentric sessions`);
    // Bricks.
    const bricks = ws.filter(x => x.discipline === 'brick');
    if (bricks.length > 0 && (ph === 'base' || w < HYROX_FIRST_BRICK_WEEK || raceWeek)) out.push(`W${w}: brick in ${raceWeek ? 'race week' : ph} week ${w}`);
    // Long run is the longest run.
    const long = ws.find(isHyroxLongRun);
    if (long) {
      for (const r of runs(wk)) if (hyroxRunLengthKm(r) > hyroxRunLengthKm(long) + EPS) out.push(`W${w}: ${r.n} longer than the long run`);
    }
    if (raceWeek && long) out.push(`W${w}: long run in race week`);
    // Step 3 of the constraint hierarchy (round 6): a loaded week's long run
    // is never shorter than the previous loaded week's, unless the week's
    // size cut it (noted: the station-work guarantee, or nothing below it
    // left to give way). Deload and taper weeks follow their own fractions.
    if (ph !== 'taper' && !raceWeek && !isDeload(i)) {
      const k = lastLoaded(i);
      const prevLong = k >= 0 ? prescribed(wks[k]).find(isHyroxLongRun)?.estimatedDurationMin ?? 0 : 0;
      if ((long?.estimatedDurationMin ?? 0) < prevLong && !notes(wk).some(n => /Long Run (cut from \d+ to \d+ min \(|left out)/.test(n))) {
        out.push(`W${w}: long run ${long?.estimatedDurationMin ?? 0} min under the previous loaded week's ${prevLong} with no note`);
      }
    }
    if (w === 1 && long && (long.estimatedDurationMin ?? 0) > START_NO_HISTORY[tier]) out.push(`W1: long run ${long.estimatedDurationMin} min above the ${START_NO_HISTORY[tier]}-min start`);
    // HYROX work every training week after week 1.
    // Station or brick work: easy erg work is not (review 2026-10-13: an
    // erg-only week passed this check).
    if (w >= 2 && ph !== 'taper' && !raceWeek && !ws.some(isWork)) out.push(`W${w}: no station session or brick`);
    // A training week holding easy erg work holds station or brick work too:
    // easy erg never takes the slot of the week's last station session or brick.
    if (ph !== 'taper' && !raceWeek && ergs.length > 0 && !ws.some(isWork)) out.push(`W${w}: easy erg work and no station session or brick`);
    // The easy erg slot (round 7, bounded 2026-10-14): an easy run leaves for
    // easy erg work only while the week's running (standalone runs and the
    // run segments of station and brick sessions) stays at or above the D2
    // running share, HYROX_RUN_SHARE x the chosen weekly minutes, and never
    // in a deload.
    if (notes(wk).some(n => /left out for an easy erg session/.test(n))) {
      if (isDeload(i)) out.push(`W${w}: deload easy run left out for easy erg work`);
      if (runningMin(wk) < HYROX_RUN_SHARE * hoursMin - EPS) out.push(`W${w}: easy run left out for easy erg work, running ${runningMin(wk).toFixed(1)} min under the ${HYROX_RUN_SHARE * hoursMin}-min running share`);
    }
    // No standalone run under the run floor (the primer excepted): the plans
    // here have no logged runs, so the floor is HYROX_RUN_FLOOR_MIN. A taper
    // long run included (decision E: it rises to the floor when the long run
    // before it reached it).
    for (const r of runs(wk)) {
      if (!isQuality(r) && (r.estimatedDurationMin ?? 0) < HYROX_RUN_FLOOR_MIN) out.push(`W${w}: ${r.n} ${r.estimatedDurationMin} min, under the ${HYROX_RUN_FLOOR_MIN}-min run floor`);
    }
    // Single-run rule.
    if (w >= 2) {
      const prev = Math.max(0, ...wks.slice(Math.max(0, i - LONG_RUN_LOOKBACK_WEEKS), i).map(longestKm));
      if (prev > 0 && longestKm(wk) > prev * (1 + LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST) + METRE_KM) {
        out.push(`W${w}: longest run ${longestKm(wk).toFixed(2)} km above 110% of ${prev.toFixed(2)} km`);
      }
    }
    // A week whose long run a ceiling cut or left out keeps no easy run longer
    // than the run floor: lower priority gives way first (round 7; the
    // review of round 6 found 2 to 36 deloads per variant holding an easy run
    // of 36 to 40 min while a ceiling cut the long run).
    if (notes(wk).some(n => /Long Run (cut from \d+ to \d+ min|left out) \((acute:chronic guard|weekly hours|base budget|build budget|peak budget|deload ceiling)\)/.test(n))) {
      for (const e of ws.filter(x => x.t === 'hyrox_run_easy' && !isHyroxLongRun(x))) {
        if ((e.estimatedDurationMin ?? 0) > HYROX_RUN_FLOOR_MIN) out.push(`W${w}: long run cut while an easy run of ${e.estimatedDurationMin} min stays`);
      }
    }
    // Deload ceiling: the last loaded week x HYROX_DELOAD_FACTOR.
    if (ph !== 'taper' && isDeload(i)) {
      const ref = lastLoaded(i);
      if (ref >= 0) {
        const r = wks[ref];
        // The deload's easy run ranks above the mini brick (round 7): a
        // deload holding a mini brick beside other station work, and no run
        // besides the long run where the last loaded week held one, is one
        // whose running share at the chosen hours cannot fund a run-floor easy
        // run beside its long run, quality run and full-brick runs, or whose
        // easy running the MTL cap cut.
        const minis = ws.filter(x => x.t === 'hyrox_mini_brick');
        if (prescribed(r).some(x => x.discipline === 'run' && !isHyroxLongRun(x)) && minis.length > 0
          && ws.some(x => isWork(x) && x.t !== 'hyrox_mini_brick') && !ws.some(x => x.discipline === 'run' && !isHyroxLongRun(x))) {
          const fixedRun = runs(wk).reduce((m, x) => m + (x.estimatedDurationMin ?? 0), 0)
            + ws.filter(x => x.discipline === 'brick' && x.t !== 'hyrox_mini_brick').reduce((m, x) => m + (x.hyroxComponents ?? []).filter(c => c.type === 'run').reduce((b, c) => b + ((c.durationSec ?? 0) * (x.hyroxRounds ?? 1)) / 60, 0), 0);
          if (HYROX_RUN_SHARE * hoursMin - fixedRun >= HYROX_RUN_FLOOR_MIN && !notes(wk).some(n => /MTL cap/.test(n))) out.push(`W${w}: deload holds a mini brick and no easy run where the running share funds one`);
        }
        // Over it only when the week holds just its last station session or
        // brick at its floor, and the week says so.
        const heldOver = lastWorkOnly(wk) && notes(wk).some(n => /deload \d+ min \/ \d+ TSS above/.test(n));
        if (!heldOver && minutes(wk) > HYROX_DELOAD_FACTOR * minutes(r) + EPS) out.push(`W${w}: deload ${minutes(wk)} min above ${HYROX_DELOAD_FACTOR} x W${ref + 1} (${minutes(r)})`);
        if (!heldOver && tss(wk) > HYROX_DELOAD_FACTOR * tss(r) + EPS) out.push(`W${w}: deload ${tss(wk).toFixed(1)} TSS above ${HYROX_DELOAD_FACTOR} x W${ref + 1} (${tss(r).toFixed(1)})`);
        if (ws.filter(isHighIntensity).length > prescribed(r).filter(isHighIntensity).length) out.push(`W${w}: deload holds more hard sessions than W${ref + 1}`);
        if (ws.filter(isQuality).length > prescribed(r).filter(isQuality).length) out.push(`W${w}: deload holds more quality runs than W${ref + 1}`);
      }
    }
    // Race week: the primer whenever it holds a run, at its fixed size; the
    // circuit no more rounds than the week before's.
    if (raceWeek) {
      const primer = ws.filter(isQuality);
      // Race week holds a run whenever it holds a run slot: the primer, or,
      // when the 110% ceiling excludes it and the easy runs would sit under
      // the run floor, one easy run at the floor (noted).
      const floorRun = primer.length === 0 && runs(wk).length === 1 && runs(wk)[0].estimatedDurationMin === HYROX_RUN_FLOOR_MIN
        && notes(wk).some(n => /race week holds a run/.test(n)) && notes(wk).some(n => /Tempo Run above the 110% single-run ceiling/.test(n));
      if (runs(wk).length > 0 && primer.length !== 1 && !floorRun) out.push(`W${w}: race week holds ${primer.length} primers`);
      const refRW = lastLoaded(i);
      if (refRW >= 0 && runs(wks[refRW]).length > 0 && runs(wk).length === 0) out.push(`W${w}: race week holds no run, the reference week ${runs(wks[refRW]).length}`);
      for (const p of primer) {
        if (p.estimatedDurationMin !== HYROX_RACE_WEEK_PRIMER_MIN || !/ 10 min at /.test(p.d ?? '')) out.push(`W${w}: race-week primer ${p.estimatedDurationMin} min (${p.d})`);
      }
      const prevRounds = Math.max(0, ...prescribed(wks[i - 1]).filter(isCircuit).map(x => x.hyroxRounds ?? 0));
      for (const c of ws.filter(isCircuit)) {
        if ((c.hyroxRounds ?? 0) > Math.max(prevRounds, MIN_CIRCUIT_ROUNDS)) out.push(`W${w}: race-week circuit ${c.hyroxRounds} rounds, the week before ${prevRounds}`);
      }
      // Race-week easy runs are no longer than the week before's long run
      // (review 2026-10-13: up to 60 min against a 49-min taper long run).
      const beforeLong = prescribed(wks[i - 1]).find(isHyroxLongRun)?.estimatedDurationMin;
      for (const e of ws.filter(x => x.t === 'hyrox_run_easy')) {
        if (beforeLong != null && (e.estimatedDurationMin ?? 0) > beforeLong && !floorRun) out.push(`W${w}: race-week easy run ${e.estimatedDurationMin} min, the week before's long run ${beforeLong}`);
      }
      // D6: no more runs than the reference week; the circuit stays over the
      // easy runs unless the reference week's station work or the race-week
      // days excluded it.
      const ref = lastLoaded(i);
      if (ref >= 0 && runs(wk).length > runs(wks[ref]).length) out.push(`W${w}: race week holds ${runs(wk).length} runs, the reference week ${runs(wks[ref]).length}`);
      const easyRuns = ws.filter(x => x.t === 'hyrox_run_easy');
      if (ergAccess && easyRuns.length > 0 && !ws.some(isCircuit)
        && !notes(wk).some(n => /Station Circuit left out \(taper: the reference week's station and brick work\)|Station Circuit left out \(no race-week day/.test(n))
        && HYROX_WEEKLY_STRUCTURE[tier].peak.stations > 0) {
        out.push(`W${w}: race week keeps ${easyRuns.length} easy run(s) and drops its circuit`);
      }
    }
    // Quality coverage: present, or a note says why not; at the default hours
    // of 6 h or more never for the guard or the weekly hours (D3).
    if (ph !== 'taper' && !raceWeek && HYROX_QUALITY_FORMATS[tier][ph as 'base' | 'build' | 'peak'] && !ws.some(isQuality)) {
      if (!notes(wk).some(n => /quality run|Tempo Run|Interval Run/.test(n))) out.push(`W${w}: no quality run and no note why`);
      if (opts.defaultHours && hx.weeklyHoursAvailable >= 6 && notes(wk).some(n => /quality run left out \((acute:chronic guard|weekly hours)\)/.test(n))) {
        out.push(`W${w}: default hours, quality run lost to the guard`);
      }
    }
    if (notes(wk).some(n => /Long Run held at/.test(n)) && !ws.some(isQuality)) out.push(`W${w}: long run held for a quality run the week does not hold`);
    // Weekly MTL cap.
    const mtl = ws.reduce((a, x) => a + (x.musculoTendonLoad ?? 0), 0);
    if (mtl > s.hyroxConfig!.mtlCap + EPS && !notes(wk).some(n => /MTL/.test(n))) out.push(`W${w}: MTL ${mtl.toFixed(0)} above the ${s.hyroxConfig!.mtlCap} cap with no note`);
    // Acute:chronic guard on training weeks: the weeks before week 1 count
    // as the plan's chronic seed (D4); week 1 is guarded when the seed is the
    // athlete's logged weekly load.
    if (ph !== 'taper' && (w >= 2 || detail[0]?.chronicSeedSource === 'logged')) {
      let chronic = 0;
      for (let k = 1; k <= 4; k++) chronic += i - k >= 0 ? tss(wks[i - k]) : seed;
      chronic /= 4;
      // Week 1's assessment is exempt from week 1's guard (a fixed
      // calibration pass), and noted when the week sits above it.
      const exempt = w === 1 ? tss({ triWorkouts: ws.filter(x => x.t === 'hyrox_assessment') } as Week) : 0;
      // The guard never sits under the nominal week 1 (round 7).
      const guardCap = Math.max(ACWR_SAFE_HIGH * chronic, detail[0]?.guardFloorTss ?? 0);
      if (exempt > 0 && tss(wk) > guardCap + EPS && !notes(wk).some(n => /by the assessment/.test(n))) out.push(`W1: planned ${tss(wk).toFixed(1)} TSS above the guard and no assessment note`);
      // Over the guard only when the week holds just its last station session
      // or brick at its floor, and the week says so.
      const heldOver = lastWorkOnly(wk) && notes(wk).some(n => /planned load \d+ TSS above the \d+ TSS guard/.test(n));
      if (!heldOver && tss(wk) - exempt > guardCap + EPS) out.push(`W${w}: planned ${(tss(wk) - exempt).toFixed(1)} TSS above ${guardCap.toFixed(1)}`);
    }
    // Taper fractions, station work and the taper long run.
    if (ph === 'taper' && w >= taperStart) {
      const refK = lastLoaded(taperStart - 1);
      const ref: Week | null = refK >= 0 ? wks[refK] : null;
      if (ref) {
        const ceiling = taperFraction(w - taperStart + 1, taperLen) * minutes(ref);
        // Race week may sit above 0.55 by its fixed primer when the primer is
        // all it holds.
        const allowed = raceWeek ? Math.max(ceiling, HYROX_RACE_WEEK_PRIMER_MIN) : ceiling;
        // The smallest circuit is exempt from the fractions, and so is week
        // 1's assessment when week 1 is the race taper (round 7).
        const exemptMin = taperExemptMin(wk) + (w === 1 ? minutes({ triWorkouts: ws.filter(x => x.t === 'hyrox_assessment') } as Week) : 0);
        if (minutes(wk) - exemptMin > allowed + EPS) out.push(`W${w}: taper ${minutes(wk)} min (${exemptMin} exempt) above ${taperFraction(w - taperStart + 1, taperLen)} x the reference week (${minutes(ref)})`);
        // Above the reference week's station and brick work only up to the
        // taper's smallest circuit (round 6 review, pass 2: MIN_CIRCUIT_ROUNDS
        // rounds of MIN_CIRCUIT_STATIONS stations, hyroxRaceTaperFloorCircuit).
        const floor = hyroxRaceTaperFloorCircuit(s, w, raceWeek) ?? { min: 0, mtl: 0 };
        const workCap = { min: Math.max(stationWork(ref).min, floor.min), mtl: Math.max(stationWork(ref).mtl, floor.mtl) };
        if (stationWork(wk).min > workCap.min + EPS) out.push(`W${w}: taper station and brick ${stationWork(wk).min} min above the reference week's ${stationWork(ref).min} and the smallest circuit's ${floor.min}`);
        if (stationWork(wk).mtl > workCap.mtl + EPS) out.push(`W${w}: taper station and brick MTL ${stationWork(wk).mtl.toFixed(0)} above the reference week's ${stationWork(ref).mtl.toFixed(0)} and the smallest circuit's ${floor.mtl.toFixed(0)}`);
      }
      const raw = w >= 2 ? minutes(wks[i - 1]) : Infinity;
      const before = raceWeek ? Math.max(raw, HYROX_RACE_WEEK_PRIMER_MIN) : raw;
      // Race week sits above the week before only by holding the primer and
      // its smallest circuit and nothing else (round 7).
      const primerAndCircuit = raceWeek && taperExemptMin(wk) > 0 ? ws.filter(isQuality).reduce((m, x) => m + (x.estimatedDurationMin ?? 0), 0) + taperExemptMin(wk) : 0;
      if (minutes(wk) > Math.max(before, primerAndCircuit) + EPS) out.push(`W${w}: taper ${minutes(wk)} min above the week before (${raw})`);
      if (minutes(wk) > hoursMin + EPS) out.push(`W${w}: taper ${minutes(wk)} min above the chosen hours`);
      if (long) {
        const prevLong = Math.max(0, ...wks.slice(Math.max(0, i - 4), i).map(x => prescribed(x).find(isHyroxLongRun)?.estimatedDurationMin ?? 0));
        const allowed = prevLong >= HYROX_RUN_FLOOR_MIN ? Math.max(HYROX_RUN_FLOOR_MIN, Math.round(prevLong * TAPER_LONG_RUN_FRACTION)) : Math.round(prevLong * TAPER_LONG_RUN_FRACTION);
        if ((long.estimatedDurationMin ?? 0) > allowed) out.push(`W${w}: taper long run ${long.estimatedDurationMin} min above ${TAPER_LONG_RUN_FRACTION} x ${prevLong}`);
      }
    }
  }
  return out;
}

/** Hours a band's plans are checked at: its minimum, default and maximum and
 *  every one of 4, 6, 8, 10 and 12 inside its range (review 2026-10-13: the
 *  zero-station weeks sat at 6 h, which the min / default / max grid missed). */
function hoursGrid(band: AbilityBand): number[] {
  const r = HYROX_HOURS_RANGE[band];
  return [r.min, 4, 6, 8, r.default, 10, 12, r.max]
    .filter((h, i, a) => a.indexOf(h) === i && h >= r.min && h <= r.max)
    .sort((a, b) => a - b);
}

describe('HYROX plan rules: plan lengths 8 to 24, every band, the hours range', () => {
  for (const band of BANDS) {
    it(`${band}`, () => {
      const hours = hoursGrid(band);
      const found: string[] = [];
      let plans = 0;
      for (let len = 8; len <= 24; len++) {
        for (const hrs of hours) {
          const s = build(band, hrs, len);
          plans++;
          for (const v of violations(s, { defaultHours: hrs === HYROX_HOURS_RANGE[band].default })) found.push(`${len}w ${hrs}h: ${v}`);
        }
      }
      expect(hours).toContain(6);
      expect(hours).toContain(HYROX_HOURS_RANGE[band].default);
      expect(plans).toBe(17 * hours.length);
      expect(found.slice(0, 10)).toEqual([]);
    }, 120000);
  }

  it('race-date plans (Thursday and Saturday races, Sunday and Wednesday onboarding) hold the same rules', () => {
    const found: string[] = [];
    const ORIGINAL_TZ = process.env.TZ;
    process.env.TZ = 'Europe/London';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const now of ['2026-10-04T12:00:00', '2026-10-07T12:00:00']) {
        vi.setSystemTime(new Date(now));
        for (const race of ['2026-12-03', '2026-12-05', '2027-02-20']) {
          for (const band of BANDS) {
            const s = build(band, HYROX_HOURS_RANGE[band].default, 0, { customRaceDate: race } as Partial<OnboardingState>);
            for (const v of violations(s)) found.push(`${now.slice(0, 10)} ${race} ${band}: ${v}`);
          }
        }
      }
    } finally {
      vi.useRealTimers();
      if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
    }
    expect(found.slice(0, 10)).toEqual([]);
  });
});

describe('HYROX weekly structure and session counts', () => {
  it('slider extra sessions go to easy runs (up to 5), never bricks or station sessions', () => {
    for (const band of BANDS) {
      const def = HYROX_WEEKLY_SESSIONS[band];
      const s = build(band, HYROX_HOURS_RANGE[band].max, 16, { hyroxWeeklySessionCount: 7 } as Partial<OnboardingState>);
      const hx = s.hyroxConfig!;
      expect(hx.stationSessionsPerWeek).toBe(def.stations);
      expect(hx.bricksPerWeek).toBe(def.bricks);
      expect(hx.runsPerWeek).toBe(Math.min(5, def.runs + (7 - def.runs - def.stations - def.bricks)));
      for (const wk of s.wks) {
        expect(prescribed(wk).filter(w => w.discipline === 'station' && !isHyroxEasyErg(w)).length).toBeLessThanOrEqual(def.stations);
        expect(prescribed(wk).filter(w => w.discipline === 'brick').length).toBeLessThanOrEqual(hyroxTier(band) === 'advanced' ? 2 : 1);
      }
    }
  });

  it('advanced peak holds a key brick and a secondary brick that is not a hard session', () => {
    const s = build('advanced', 10, 18);
    const peak = s.wks.filter(wk => wk.ph === 'peak');
    expect(peak.length).toBeGreaterThan(0);
    const withTwo = peak.filter(wk => prescribed(wk).filter(w => w.discipline === 'brick').length === 2);
    expect(withTwo.length).toBeGreaterThan(0);
    for (const wk of withTwo) {
      const bricks = prescribed(wk).filter(w => w.discipline === 'brick');
      expect(bricks.filter(isHighIntensity)).toHaveLength(1);
      const light = bricks.find(w => w.hyroxLight)!;
      expect(isEccentricSession(light)).toBe(false);
    }
  });

  it('every week of a plan of 3 or more weeks ends in a 2-week taper', () => {
    for (const len of [8, 12, 18, 24]) {
      const s = build('intermediate', 8, len);
      expect(s.wks.filter(wk => wk.ph === 'taper')).toHaveLength(2);
    }
  });
});

describe('HYROX long run', () => {
  it('starts at the tier start (no logged runs; beginners 30 min) and steps 5 min every 3 weeks to the tier cap', () => {
    const first = (s: SimulatorState) => prescribed(s.wks[0]).find(isHyroxLongRun)!.estimatedDurationMin;
    expect(first(build('total_beginner', 4, 18))).toBe(30);
    expect(first(build('intermediate', 8, 18))).toBe(60);
    expect(first(build('advanced', 10, 18))).toBe(75);
    const s = build('advanced', 16, 24);
    const longs = s.wks.filter(wk => wk.ph !== 'taper').map(wk => prescribed(wk).find(isHyroxLongRun)?.estimatedDurationMin ?? 0);
    expect(Math.max(...longs)).toBeLessThanOrEqual(90);
  });

  it('starts at no more than 110% of the longest run logged in the 30 days before the plan', () => {
    resetState();
    const ms = getMutableState();
    // A 25-min run 10 days before today (no distance: its duration stands in).
    ms.onboardingRunHistory = [{ startTime: new Date(Date.now() - 10 * 86400000).toISOString(), activityType: 'RUNNING', distKm: 0, durSec: 25 * 60 } as never];
    initializeHyroxSimulator({
      ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'hyrox', hyroxFormat: 'open_singles',
      triTimeAvailableHoursPerWeek: 8, planDurationWeeks: 16, customRaceDate: null,
      previousHyroxTimeSec: 5400, hyroxPreviousTimeFormat: 'open_singles',
      onboardingRunHistory: ms.onboardingRunHistory,
    } as unknown as OnboardingState);
    const s = getState();
    const long = prescribed(s.wks[0]).find(isHyroxLongRun)!;
    expect(long.estimatedDurationMin).toBe(Math.floor(25 * (1 + LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST)));
  });
});

describe('HYROX quality runs', () => {
  it('tier formats: intermediate peak 8 x 1 km at HYROX race pace, advanced peak 6 x 4 min by heart rate, beginner base easy only', () => {
    const s = build('intermediate', 12, 18);
    const peak = s.wks.find((wk, i) => wk.ph === 'peak' && !deloadOf(s.wks)(i))!;
    const q = prescribed(peak).find(w => w.t === 'hyrox_run_intervals');
    expect(q?.d).toMatch(/8 × 1 km at HYROX race pace/);
    const adv = build('advanced', 12, 18);
    const advPeak = adv.wks.find((wk, i) => wk.ph === 'peak' && !deloadOf(adv.wks)(i))!;
    expect(prescribed(advPeak).find(w => w.t === 'hyrox_run_intervals')?.d).toMatch(/6 × 4 min at about 90% of max HR/);
    const beg = build('beginner', 5, 18);
    for (const wk of beg.wks.filter(w => w.ph === 'base')) {
      expect(prescribed(wk).some(w => w.t === 'hyrox_run_tempo' || w.t === 'hyrox_run_intervals')).toBe(false);
    }
    expect(HYROX_QUALITY_FORMATS.beginner.base).toBeNull();
  });

  it('tempo pace: threshold pace with a real running-fitness signal, HYROX race pace (labelled) without one', () => {
    const fmt = { kind: 'run_tempo' as const, workMin: 25 };
    const withLt = generateHyroxRun({ kind: 'run_tempo', targetMinutes: 0, format: fmt, band: 'intermediate', phase: 'build', slotIndex: 1, runPaceSecKm: 330, thresholdPaceSecKm: 290 });
    expect(withLt.d).toContain('25 min at threshold pace (~4:50/km)');
    expect(withLt.estimatedDurationMin).toBe(40);
    const without = generateHyroxRun({ kind: 'run_tempo', targetMinutes: 0, format: fmt, band: 'intermediate', phase: 'build', slotIndex: 1, runPaceSecKm: 330 });
    expect(without.d).toContain('25 min at HYROX race pace (~5:30/km)');
  });
});

describe('HYROX MTL cap cuts real station volume', () => {
  it('withHyroxRounds cuts rounds, MTL, duration and the description together', () => {
    const w = generateHyroxStation({
      kind: 'station_density', targetMinutes: 55, band: 'advanced', stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      phase: 'build', slotIndex: 1,
    });
    expect(w.hyroxRounds).toBeGreaterThan(2);
    const cut = withHyroxRounds(w, 2);
    expect(cut.hyroxRounds).toBe(2);
    expect(cut.musculoTendonLoad!).toBeCloseTo(w.musculoTendonLoad! * 2 / w.hyroxRounds!, 6);
    expect(cut.estimatedDurationMin!).toBeLessThan(w.estimatedDurationMin!);
    expect(cut.d.startsWith('2 rounds')).toBe(true);
  });

  it('a week over its MTL cap prescribes fewer station or brick rounds, not just smaller numbers', () => {
    // Half the band's cap, so the easy running the cap cuts first (decision
    // A) cannot bring every week under it and station rounds go too.
    const s = build('intermediate', 14, 18);
    const cap = Math.round(HYROX_MTL_CAP.intermediate / 2);
    const plan = (mtlCap: number) => {
      const ms = getMutableState();
      const saved = ms.hyroxConfig!.mtlCap;
      ms.hyroxConfig!.mtlCap = mtlCap;
      const out = generateHyroxPlan(ms);
      ms.hyroxConfig!.mtlCap = saved;
      return out;
    };
    const uncapped = plan(1e9);
    const capped = plan(cap);
    let cutWeeks = 0;
    capped.forEach((wk, i) => {
      const before = prescribed(uncapped[i]).filter(w => w.discipline !== 'run').reduce((a, w) => a + (w.hyroxRounds ?? 0), 0);
      const after = prescribed(wk).filter(w => w.discipline !== 'run').reduce((a, w) => a + (w.hyroxRounds ?? 0), 0);
      // Easy erg work is one continuous block with no components.
      const sets = prescribed(wk).filter(w => !isHyroxEasyErg(w));
      const mtl = sets.reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
      if (after < before) {
        cutWeeks++;
        // The reported MTL is the sum of what the sessions prescribe.
        expect(mtl).toBeCloseTo(sets.reduce((a, w) => a + (w.hyroxComponents ?? []).reduce((b, c) => b + c.mtl, 0), 0), 6);
      }
    });
    expect(cutWeeks).toBeGreaterThan(0);
  });

  it('MTL cap order (round 6): easy erg work, then easy runs, then station rounds and stations; never the long run, the quality run or the last station work', () => {
    // The constraint hierarchy's step 4. Every week the cap cut station work
    // in holds no easy run (a taper week keeps its runs at the run floor);
    // the cap never shortens the long run (round 5 cut it down to its
    // previous length) nor cuts the quality run; a training week keeps its
    // last station session or brick; a week still over the cap says so.
    const cases: Array<[AbilityBand, number, number, number]> = [
      ['intermediate', 14, 18, 0.5], ['novice', 6, 18, 1], ['competitive', 12, 20, 0.6], ['beginner', 10, 16, 1], ['novice', 6, 16, 1],
    ];
    let checked = 0;
    for (const [band, hrs, len, f] of cases) {
      build(band, hrs, len);
      const ms = getMutableState();
      ms.hyroxConfig!.mtlCap = Math.round(HYROX_MTL_CAP[band] * f);
      const plan = generateHyroxPlanDetailed(ms);
      const uncapped = (() => {
        const saved = ms.hyroxConfig!.mtlCap;
        ms.hyroxConfig!.mtlCap = 1e9;
        const out = generateHyroxPlanDetailed(ms);
        ms.hyroxConfig!.mtlCap = saved;
        return out;
      })();
      const wks = plan.weeks.slice(0, plan.detail.length);
      wks.forEach((wk, i) => {
        const label = `${band} ${hrs}h ${len}w W${i + 1}`;
        expect(notes(wk).some(n => /Long Run cut from \d+ to \d+ min \(MTL cap/.test(n)), label).toBe(false);
        const cutStations = notes(wk).some(n => /station or brick round\(s\) cut \(MTL cap|station\(s\) taken out of a circuit \(MTL cap/.test(n));
        if (!cutStations) return;
        checked++;
        const taper = wk.ph === 'taper';
        const easy = prescribed(wk).filter(w => w.t === 'hyrox_run_easy' && !isHyroxLongRun(w));
        if (!taper) expect(easy, label).toEqual([]);
        else for (const e of easy) expect(e.estimatedDurationMin, label).toBe(HYROX_RUN_FLOOR_MIN);
        if (!taper && i < plan.detail.length - 1) expect(prescribed(wk).some(isWork), label).toBe(true);
        const mtl = prescribed(wk).reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
        if (mtl > ms.hyroxConfig!.mtlCap + EPS) expect(notes(wk).some(n => /above the \d+ cap with every station and brick session at its floor/.test(n)), label).toBe(true);
        // The week the cap cut keeps the quality run the uncapped week holds
        // when the rest of the week (guard, spacing) is the same.
        const capQ = prescribed(wk).filter(isQuality).length;
        const freeQ = prescribed(uncapped.weeks[i]).filter(isQuality).length;
        if (freeQ > capQ) expect(notes(wk).some(n => /quality run left out|Tempo Run|Interval Run/.test(n)) && !notes(wk).some(n => /(Tempo|Interval) Run .*\(MTL cap/.test(n)), label).toBe(true);
      });
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('HYROX plan detail', () => {
  it('reports the guard and the taper budgets it built each week with', () => {
    const s = build('intermediate', 8, 18);
    const { detail } = generateHyroxPlanDetailed(s);
    expect(detail).toHaveLength(18);
    for (const d of detail) {
      if (d.acwrCapTss != null) expect(d.plannedTss - d.guardExemptTss).toBeLessThanOrEqual(d.acwrCapTss + EPS);
    }
    const loaded = detail.filter(d => d.phase !== 'taper' && !d.deload);
    const ref = loaded[loaded.length - 1];
    expect(detail[16].budgetMin).toBe(Math.round(0.70 * ref.plannedMin));
    expect(detail[17].budgetMin).toBe(Math.round(0.55 * ref.plannedMin));
  });
});

describe('HYROX review fixes (2026-10-13)', () => {
  /** Training weeks of every band at its default hours over lengths 8 to 24. */
  function grid(): SimulatorState[] {
    const out: SimulatorState[] = [];
    for (const band of BANDS) {
      for (let len = 8; len <= 24; len += 2) out.push(structuredClone(build(band, HYROX_HOURS_RANGE[band].default, len)));
    }
    return out;
  }

  it('every deload week is at most HYROX_DELOAD_FACTOR of the last loaded week (minutes and TSS)', () => {
    let checked = 0;
    let worst = 0;
    for (const s of grid()) {
      const { detail } = generateHyroxPlanDetailed(s);
      let last: (typeof detail)[number] | null = null;
      for (const d of detail) {
        if (d.phase === 'taper') continue;
        if (!d.deload) { last = d; continue; }
        if (!last) continue;
        checked++;
        worst = Math.max(worst, d.plannedMin / last.plannedMin, d.plannedTss / last.plannedTss);
        expect(d.deloadCapMin).toBeCloseTo(HYROX_DELOAD_FACTOR * last.plannedMin, 6);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(worst).toBeLessThanOrEqual(HYROX_DELOAD_FACTOR + EPS);
  });

  it('a deload holds no session longer, heavier (MTL) or with more rounds than the same session in the last loaded week', () => {
    // Round 7 (review of round 6, pass 3): in 356 deload weeks at the default
    // sessions a circuit with the reference week's rounds held more minutes
    // and MTL (total_beginner 4 h 8 weeks W4: 67 min and 215 MTL against W3's
    // 63 min and 155), the station rotation picking heavier stations. A
    // deload session over its counterpart loses rounds, then stations.
    let checked = 0;
    const plans = [...grid(), ...BANDS.flatMap(band => [8, 12, 16, 20, 24].map(len => structuredClone(build(band, 4, len)))),
      ...BANDS.flatMap(band => [8, 16, 24].map(len => structuredClone(build(band, HYROX_HOURS_RANGE[band].default, len, {}, 100))))];
    for (const s of plans) {
      const tw = planTrainingWeeks(s);
      let last: Week | null = null;
      for (let i = 0; i < tw; i++) {
        const wk = s.wks[i];
        if (wk.ph === 'taper') continue;
        if (!deloadOf(s.wks.slice(0, tw))(i)) { last = wk; continue; }
        if (!last) continue;
        for (const w of prescribed(wk).filter(x => (x.discipline === 'station' || x.discipline === 'brick') && x.t !== 'hyrox_assessment')) {
          const same = prescribed(last).filter(x => x.t === w.t);
          if (same.length === 0) continue;
          checked++;
          const label = `${s.hyroxConfig!.athleteBand} ${s.hyroxConfig!.weeklyHoursAvailable}h W${i + 1} ${w.n}`;
          expect(w.hyroxRounds ?? 0, label).toBeLessThanOrEqual(Math.max(...same.map(x => x.hyroxRounds ?? 0)));
          expect(w.estimatedDurationMin ?? 0, label).toBeLessThanOrEqual(Math.max(...same.map(x => x.estimatedDurationMin ?? 0)) + EPS);
          expect(w.musculoTendonLoad ?? 0, label).toBeLessThanOrEqual(Math.max(...same.map(x => x.musculoTendonLoad ?? 0)) + EPS);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('race week holds the primer whenever it holds a run: 10 min of tempo work, never sized from the budget', () => {
    let seen = 0;
    for (const s of grid()) {
      const rw = s.wks[planTrainingWeeks(s) - 1];
      const primer = prescribed(rw).filter(isQuality);
      if (runs(rw).length > 0) { expect(primer).toHaveLength(1); seen++; }
      for (const p of primer) {
        expect(p.estimatedDurationMin).toBe(HYROX_RACE_WEEK_PRIMER_MIN);
        expect(p.d).toMatch(/ 10 min at /);
      }
    }
    expect(seen).toBeGreaterThan(50);
  });

  it('race week keeps the peak structure minus the brick, or a note names the taper rule that cut it', () => {
    for (const band of BANDS) {
      const peak = HYROX_WEEKLY_STRUCTURE[hyroxTier(band)].peak;
      // 16 and 18 weeks: the week before the taper is a loaded week (D5: the
      // 4-week cycle no longer deloads week 16 of 18).
      for (const len of [16, 18]) {
        const s = build(band, HYROX_HOURS_RANGE[band].default, len);
        const rw = s.wks[planTrainingWeeks(s) - 1];
        const ws = prescribed(rw);
        const runsHeld = ws.filter(w => w.discipline === 'run').length;
        const stationsHeld = ws.filter(w => w.discipline === 'station' && !isHyroxEasyErg(w)).length;
        expect(runsHeld).toBeLessThanOrEqual(peak.runs);
        expect(stationsHeld).toBeLessThanOrEqual(peak.stations);
        expect(ws.filter(w => w.discipline === 'brick')).toHaveLength(0);
        if (runsHeld + stationsHeld < peak.runs + peak.stations) {
          expect(notes(rw).some(n => /\(taper: |the taper never rises|race week holds no more runs than the reference week/.test(n))).toBe(true);
        }
        // At the default hours and 16 weeks race week keeps the primer and a
        // station circuit (the 0.55 ceiling takes easy runs first).
        if (len === 16) {
          expect(ws.some(isQuality)).toBe(true);
          expect(ws.some(isCircuit)).toBe(true);
        }
      }
    }
  });

  it('the generator notes persist on the week (Week.hyroxPlanNotes) and match the plan detail', () => {
    const s = build('advanced', 4, 12);
    const { weeks, detail } = generateHyroxPlanDetailed(s);
    let noted = 0;
    detail.forEach((d, i) => {
      expect(weeks[i].hyroxPlanNotes ?? []).toEqual(d.adjustments);
      if (d.adjustments.length > 0) noted++;
    });
    expect(noted).toBeGreaterThan(0);
    // The stored plan carries them too.
    expect(s.wks.some(wk => (wk.hyroxPlanNotes ?? []).length > 0)).toBe(true);
  });

  it('the long run and the quality run are the first allocation: the running share no longer sizes them (round 6)', () => {
    // Review 2026-10-12: advanced, 4 h, 12 weeks, week 5 trimmed its long run
    // to 34 min for a tempo run that then left the week. Since D3 the long
    // run gives up only its growth for the quality run, and since round 6
    // (2026-10-13) the running share sizes only the easy runs: week 5 holds
    // the tempo beside a long run no shorter than the last loaded week's.
    const s = build('advanced', 4, 12);
    const longOf = (wk: Week) => prescribed(wk).find(isHyroxLongRun)?.estimatedDurationMin ?? 0;
    expect(prescribed(s.wks[4]).some(isQuality)).toBe(true);
    expect(notes(s.wks[4]).some(n => /running share \d+ min, the long run holds/.test(n))).toBe(false);
    expect(longOf(s.wks[4])).toBeGreaterThanOrEqual(longOf(s.wks[2]));
  });

  it('withoutHyroxStation takes one station out of a circuit: component, MTL, duration and description', () => {
    const w = generateHyroxStation({
      kind: 'station_technique', targetMinutes: 50, band: 'intermediate', stationAccess: { sled: 'always', skiErg: true, rowErg: true },
      phase: 'build', slotIndex: 1,
    });
    const stations = (w.hyroxComponents ?? []).filter(c => c.type !== 'run');
    expect(stations.length).toBeGreaterThan(MIN_CIRCUIT_STATIONS);
    const gone = stations[0].type as HyroxStation;
    const cut = withoutHyroxStation(w, gone);
    expect((cut.hyroxComponents ?? []).some(c => c.type === gone)).toBe(false);
    expect(cut.musculoTendonLoad!).toBeCloseTo((cut.hyroxComponents ?? []).reduce((a, c) => a + c.mtl, 0), 6);
    expect(cut.estimatedDurationMin!).toBeLessThan(w.estimatedDurationMin!);
    expect(cut.d.split(' + ').length).toBe(w.d.split(' + ').length - 1);
    // Never below MIN_CIRCUIT_STATIONS.
    let floor = cut;
    for (const c of stations.slice(1)) floor = withoutHyroxStation(floor, c.type as never);
    expect((floor.hyroxComponents ?? []).filter(c => c.type !== 'run').length).toBe(MIN_CIRCUIT_STATIONS);
  });

  it('the weekly MTL cap cuts rounds, then stations, then the technique session, and notes each step', () => {
    const s = build('total_beginner', 8, 16);
    const ms = getMutableState();
    ms.hyroxConfig!.mtlCap = 1; // every week over: every lever fires
    const plan = generateHyroxPlanDetailed(ms);
    const all = plan.detail.flatMap(d => d.adjustments).join('\n');
    expect(all).toMatch(/round\(s\) cut \(MTL cap 1\)|station\(s\) taken out of a circuit \(MTL cap 1\)|technique station session left out \(MTL cap 1\)/);
    for (const d of plan.detail) {
      const mtl = prescribed({ triWorkouts: d.workouts } as Week).reduce((a, w) => a + (w.musculoTendonLoad ?? 0), 0);
      if (mtl > 1) expect(d.adjustments.some(n => /MTL/.test(n))).toBe(true);
    }
    expect(s.hyroxConfig!.mtlCap).toBe(1);
  });

  it('regenerating the current week reads the stored week before: no hard Monday after a stored hard Sunday', () => {
    const s = build('advanced', 10, 16);
    const ms = getMutableState();
    ms.w = 6;
    // The user moved a hard session to the stored week 5's Sunday.
    const hardSunday: Workout = {
      ...generateHyroxRun({ kind: 'run_tempo', targetMinutes: 40, band: 'advanced', phase: 'build', slotIndex: 5 }),
      id: 'W5-moved', dayOfWeek: 6, dayName: 'Sun',
    };
    ms.wks[4].triWorkouts = [...(ms.wks[4].triWorkouts ?? []).filter(w => w.dayOfWeek !== 6), hardSunday];
    const regen = regenerateHyroxWeek(ms, 6)!;
    const monday = (regen.triWorkouts ?? []).filter(w => w.dayOfWeek === 0);
    expect(monday.some(isHighIntensity)).toBe(false);
    // The full regeneration from s.w (rebake, version bump) holds it as well.
    const plan = generateHyroxPlan(ms);
    expect((plan[5].triWorkouts ?? []).filter(w => w.dayOfWeek === 0).some(isHighIntensity)).toBe(false);
    expect(s.tw).toBe(16);
  });
});

describe('HYROX review fixes, round 2 (2026-10-13)', () => {
  it('at 6 h every training week after week 1 holds a station session or a brick (novice, intermediate)', () => {
    // Review: novice 18 w at 6 h held runs only in weeks 3 to 8 ('Tempo 40 +
    // Long 50'); 72 of 221 training weeks had no station or brick work.
    for (const band of ['novice', 'intermediate'] as AbilityBand[]) {
      for (const len of [12, 18, 24]) {
        const s = build(band, 6, len);
        const tw = planTrainingWeeks(s);
        for (let i = 1; i < tw; i++) {
          if (s.wks[i].ph === 'taper') continue;
          expect(prescribed(s.wks[i]).some(isWork)).toBe(true);
        }
      }
    }
  });

  it('a ceiling trims the long run to its floor before it takes the last station session', () => {
    const s = build('novice', 6, 18);
    for (const wk of s.wks.slice(1, planTrainingWeeks(s) - 2)) {
      const left = notes(wk).filter(n => /technique station session left out|brick left out/.test(n));
      if (left.length === 0) continue;
      // The week kept HYROX work, so whatever left was not its last session.
      expect(prescribed(wk).some(isWork)).toBe(true);
    }
  });

  it('the race taper holds its fractions and the reference week caps its station work (reviewer examples)', () => {
    // Review: total_beginner 4 h 11 w taper week 1 at 0.93 of the reference
    // week with a 61-min circuit against 32; novice 6 h 11 w at 0.96, race
    // week 0.84.
    for (const [band, hrs] of [['total_beginner', 4], ['novice', 6]] as Array<[AbilityBand, number]>) {
      const s = build(band, hrs, 11);
      const tw = planTrainingWeeks(s);
      let ref = -1;
      for (let k = tw - 3; k >= 0; k--) if (!deloadOf(s.wks.slice(0, tw))(k)) { ref = k; break; }
      const refWk = s.wks[ref];
      // The smallest circuit is exempt from the fractions (round 7), and the
      // reference week's station work caps the taper's unless that circuit is
      // all the taper holds (round 6 review, pass 2).
      expect(minutes(s.wks[tw - 2]) - taperExemptMin(s.wks[tw - 2])).toBeLessThanOrEqual(0.70 * minutes(refWk) + EPS);
      expect(minutes(s.wks[tw - 1]) - taperExemptMin(s.wks[tw - 1])).toBeLessThanOrEqual(Math.max(0.55 * minutes(refWk), HYROX_RACE_WEEK_PRIMER_MIN) + EPS);
      for (const wk of [s.wks[tw - 2], s.wks[tw - 1]]) {
        const floor = hyroxRaceTaperFloorCircuit(s, wk.w, wk === s.wks[tw - 1]) ?? { min: 0, mtl: 0 };
        expect(stationWork(wk).min).toBeLessThanOrEqual(Math.max(stationWork(refWk).min, floor.min) + EPS);
        expect(stationWork(wk).mtl).toBeLessThanOrEqual(Math.max(stationWork(refWk).mtl, floor.mtl) + EPS);
        const refCircuitStations = Math.max(0, ...prescribed(refWk).filter(isCircuit).map(w => (w.hyroxComponents ?? []).filter(c => c.type !== 'run').length));
        for (const c of prescribed(wk).filter(isCircuit)) {
          expect((c.hyroxComponents ?? []).filter(x => x.type !== 'run').length).toBeLessThanOrEqual(Math.max(MIN_CIRCUIT_STATIONS, refCircuitStations));
        }
      }
    }
  });

  it('week 1 of a short plan never stretches the long run past the start, and taper weeks never stretch it', () => {
    // Review: total_beginner 4 h 3 w opened with a 39-min long run beside an
    // interval session (start 30); beginner-tier 7-session taper long runs came
    // out at 27 min against 23 to 25.
    for (const [band, hrs, len] of [['total_beginner', 4, 3], ['total_beginner', 4, 5], ['beginner', 5, 4], ['novice', 8, 3], ['intermediate', 10, 2]] as Array<[AbilityBand, number, number]>) {
      const s = build(band, hrs, len);
      const long = prescribed(s.wks[0]).find(isHyroxLongRun);
      expect(long?.estimatedDurationMin ?? 0).toBeLessThanOrEqual(START_NO_HISTORY[hyroxTier(band)]);
    }
    for (const band of ['total_beginner', 'beginner'] as AbilityBand[]) {
      for (const len of [10, 14, 18]) {
        const s = build(band, HYROX_HOURS_RANGE[band].max, len, { hyroxWeeklySessionCount: 7 } as Partial<OnboardingState>);
        const tw = planTrainingWeeks(s);
        const taperLong = prescribed(s.wks[tw - 2]).find(isHyroxLongRun);
        if (!taperLong) continue;
        const prevLong = Math.max(...s.wks.slice(tw - 6, tw - 2).map(wk => prescribed(wk).find(isHyroxLongRun)?.estimatedDurationMin ?? 0));
        expect(taperLong.estimatedDurationMin).toBeLessThanOrEqual(Math.round(prevLong * TAPER_LONG_RUN_FRACTION));
        // The taper tempo is no longer than the taper long run.
        for (const q of prescribed(s.wks[tw - 2]).filter(isQuality)) expect(hyroxRunLengthKm(q)).toBeLessThanOrEqual(hyroxRunLengthKm(taperLong) + METRE_KM);
      }
    }
  });
});

describe('HYROX round 4 decisions (2026-10-13)', () => {
  const ALL_ERGS = { sled: 'always' as const, skiErg: true, rowErg: true };

  it('D1: an easy erg session is time-defined easy aerobic work: RPE 4, neither hard nor eccentric, no station sets, null without ergs', () => {
    const a = generateHyroxEasyErg({ targetMinutes: 45, stationAccess: ALL_ERGS, slotIndex: 0 })!;
    const b = generateHyroxEasyErg({ targetMinutes: 45, stationAccess: ALL_ERGS, slotIndex: 1 })!;
    for (const e of [a, b]) {
      expect(isHyroxEasyErg(e)).toBe(true);
      expect(e.rpe).toBe(HYROX_EASY_RPE);
      expect(e.estimatedDurationMin).toBe(45);
      expect(isHighIntensity(e)).toBe(false);
      expect(isEccentricSession(e)).toBe(false);
      expect(e.hyroxComponents).toBeUndefined();
      // Decision D: its own discipline, never 'station'.
      expect(e.discipline).toBe('erg');
      expect(e.musculoTendonLoad ?? 0).toBeGreaterThan(0);
      expect(e.d).not.toMatch(/—/);
    }
    // The SkiErg and the row erg alternate by slot.
    expect(a.d).not.toBe(b.d);
    expect(generateHyroxEasyErg({ targetMinutes: 45, stationAccess: { sled: 'always', skiErg: false, rowErg: false }, slotIndex: 0 })).toBeNull();
  });

  it('D1: what the sessions leave of a base week becomes easy erg work, and a larger budget never holds less of it', () => {
    // Beginner, 16 weeks, the chosen 4 sessions: base weeks hold 2 runs and a
    // circuit, so the fourth slot takes easy erg work sized from the unused
    // budget (the withdrawn 2026-10-13 draft sized it from unfunded run slots,
    // so a larger budget that funded the runs held less volume). From 5 h:
    // at 4 h week 2's circuit on the real S8-S9 seeds (62 min, 2 rounds of 4
    // stations) leaves 19 min of the 141-min budget, under the 20-min floor
    // of an easy erg session (2026-10-14 merge).
    let prev = 0;
    for (const hrs of [5, 6, 7]) {
      const s = build('beginner', hrs, 16);
      const { detail } = generateHyroxPlanDetailed(structuredClone(s));
      const w2 = s.wks[1];
      expect(prescribed(w2).some(isHyroxEasyErg)).toBe(true);
      expect(prescribed(w2).length).toBe(4);
      // The budget is filled, or the erg session is at its cap (the tier
      // long-run cap, 60 min) with every slot taken, noted.
      expect(minutes(w2) >= detail[1].budgetMin - HYROX_RUN_FLOOR_MIN
        || notes(w2).some(n => /left unprescribed \(the chosen 4 sessions are full, an easy erg session at most 60 min\)/.test(n))).toBe(true);
      // Never less (equal at 6 and 7 h: the session count and the erg cap
      // hold week 2, and since 2026-10-14 the easy erg slot never takes the
      // running under the D2 share).
      expect(minutes(w2)).toBeGreaterThanOrEqual(prev);
      prev = minutes(w2);
    }
  });

  it('D1: the chosen session total is never exceeded, and a full week says so when its budget is left over', () => {
    // Competitive at 12 h (the default 6 sessions): peak weeks hold 6 sessions
    // of 6 and leave the rest of the 720 min unprescribed, noted.
    const s = build('competitive', 12, 16);
    const tw = planTrainingWeeks(s);
    const peak = s.wks.slice(0, tw).filter((wk, i) => wk.ph === 'peak' && !deloadOf(s.wks.slice(0, tw))(i));
    expect(peak.length).toBeGreaterThan(0);
    for (const wk of peak) {
      expect(prescribed(wk).length).toBe(6);
      expect(notes(wk).some(n => /min left unprescribed \(the chosen 6 sessions are full\)/.test(n))).toBe(true);
    }
  });

  it('D1: the 7-session choice at 8 h: every loaded week from week 3 holds 7 sessions, or a guard or the MTL cap holds it and the week says so', () => {
    for (const band of ['beginner', 'novice', 'intermediate', 'advanced', 'competitive'] as AbilityBand[]) {
      const s = build(band, 8, 16, { hyroxWeeklySessionCount: 7 } as Partial<OnboardingState>);
      const { detail } = generateHyroxPlanDetailed(structuredClone(s));
      const tw = planTrainingWeeks(s);
      let seven = 0;
      let loaded = 0;
      for (let i = 2; i < tw; i++) {
        const wk = s.wks[i];
        if (wk.ph === 'taper' || detail[i].deload) continue;
        expect(prescribed(wk).length).toBeLessThanOrEqual(7);
        // Weeks the MTL cap cut sessions in hold fewer by decision A (easy
        // runs leave before station rounds); every other loaded week counts.
        const capped = notes(wk).some(n => /easy run\(s\) left out \(MTL cap/.test(n));
        if (!capped) loaded++;
        if (prescribed(wk).length === 7) { seven++; continue; }
        // Short of 7: the week's budget is spent (under one easy erg session
        // left), or a ceiling or the MTL cap holds it, noted.
        if (minutes(wk) >= detail[i].budgetMin - HYROX_RUN_FLOOR_MIN) continue;
        expect(notes(wk).some(n => /holds it\)|left unprescribed \((acute:chronic guard|MTL cap|weekly hours)/.test(n)), `${band} W${i + 1}`).toBe(true);
      }
      expect(seven).toBeGreaterThanOrEqual(loaded / 2);
    }
  });

  it('D2: the running budget is 0.40 of the chosen weekly hours, not of the phase budget', () => {
    // Intermediate, 8 h, 16 weeks: base week 2 has a 282-min budget, so the
    // old share funded 113 min of running; it now funds up to 192 (0.40 x 480).
    const s = build('intermediate', 8, 16);
    const runMin = runs(s.wks[1]).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
    expect(runMin).toBeGreaterThan(HYROX_RUN_SHARE * 282);
    expect(runMin).toBeLessThanOrEqual(HYROX_RUN_SHARE * 480);
  });

  it('D3: beside the quality run the long run never sits under the previous loaded week\'s length; a hold for it says so', () => {
    // Round 6: the running share no longer sizes the long run and the
    // quality run, so a hold can only come from the week's size (the guard
    // at a logged load, the weekly hours, the phase budget), and on a wide
    // grid none does (the week's last station session or brick, which the
    // hierarchy keeps, is what costs the quality run). Every loaded week
    // with a quality run keeps a long run no shorter than the previous loaded
    // week's; a hold, if one occurs, is noted and holds that length.
    let held = 0;
    let checked = 0;
    for (const logged of [undefined, 100]) {
      for (const band of BANDS) {
        for (const hrs of hoursGrid(band)) {
          const s = build(band, hrs, 16, {}, logged);
          const tw = planTrainingWeeks(s);
          const isDeload = deloadOf(s.wks.slice(0, tw));
          for (let i = 1; i < tw; i++) {
            const wk = s.wks[i];
            const label = `${logged ?? '-'} ${band} ${hrs}h W${i + 1}`;
            let prevLoaded = 0;
            for (let k = i - 1; k >= 0; k--) {
              if (s.wks[k].ph !== 'taper' && !isDeload(k)) { prevLoaded = prescribed(s.wks[k]).find(isHyroxLongRun)?.estimatedDurationMin ?? 0; break; }
            }
            const long = prescribed(wk).find(isHyroxLongRun);
            if (wk.ph !== 'taper' && !isDeload(i) && prescribed(wk).some(isQuality) && prevLoaded > 0) {
              checked++;
              expect(long?.estimatedDurationMin ?? 0, label).toBeGreaterThanOrEqual(prevLoaded);
            }
            const n = notes(wk).find(x => /Long Run held at \d+ min, not \d+, for the quality run/.test(x));
            if (!n) continue;
            held++;
            expect(prescribed(wk).some(isQuality), label).toBe(true);
            expect(long?.estimatedDurationMin ?? 0, label).toBeGreaterThanOrEqual(Math.min(Math.max(LONG_SOFT_FLOOR_MIN, prevLoaded), Number(n.match(/not (\d+)/)![1])));
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(held).toBeGreaterThanOrEqual(0);
  });

  it('D4: the chronic window before week 1 is the larger of the logged weekly load (week 1 guarded) and the nominal week 1, else the nominal week 1; no guard under the nominal week 1 (round 7)', () => {
    const shape = (wks: Week[]) => wks.map(wk => prescribed(wk).map(w => `${w.dayOfWeek} ${w.t} ${w.estimatedDurationMin}`).join(' | '));
    for (const band of BANDS) {
      const s = structuredClone(build(band, HYROX_HOURS_RANGE[band].default, 16));
      const nominal = generateHyroxPlanDetailed(structuredClone(s)).detail;
      expect(nominal[0].chronicSeedSource).toBe('nominal');
      expect(nominal[0].acwrCapTss).toBeNull();
      expect(nominal[0].guardFloorTss).toBe(nominal[0].chronicSeedTss);
      for (const d of nominal) if (d.acwrCapTss != null) expect(d.acwrCapTss).toBeGreaterThanOrEqual(d.guardFloorTss - EPS);
      // The nominal week 1 (a station session in the assessment's slot, under
      // week 1's size) holds at least what week 1 holds besides the
      // assessment, which the phase budget exempts (round 6).
      const w1Assessment = tss({ triWorkouts: nominal[0].workouts.filter(w => w.t === 'hyrox_assessment') } as Week);
      expect(nominal[0].chronicSeedTss).toBeGreaterThanOrEqual(nominal[0].plannedTss - w1Assessment - EPS);
      expect(nominal[1].acwrCapTss).toBeCloseTo(ACWR_SAFE_HIGH * (nominal[0].plannedTss + 3 * nominal[0].chronicSeedTss) / 4, 6);

      const low = structuredClone(build(band, HYROX_HOURS_RANGE[band].default, 16, {}, 100));
      const logged = generateHyroxPlanDetailed(low).detail;
      expect(logged[0].chronicSeedSource).toBe('logged');
      // The nominal week 1 is the same plan's first week built without the
      // guard; the seed is the larger of it and the logged load.
      expect(logged[0].guardFloorTss).toBeCloseTo(nominal[0].guardFloorTss, 6);
      const seed = Math.max(100, logged[0].guardFloorTss);
      expect(logged[0].chronicSeedTss).toBeCloseTo(seed, 6);
      expect(logged[0].acwrCapTss).toBeCloseTo(ACWR_SAFE_HIGH * seed, 6);
      // Week 1's assessment is exempt from week 1's guard (a fixed
      // calibration pass); the rest of week 1 is guarded.
      const assessment = prescribed({ triWorkouts: logged[0].workouts } as Week).filter(w => w.t === 'hyrox_assessment');
      expect(assessment).toHaveLength(1);
      expect(logged[0].guardExemptTss).toBeCloseTo(tss({ triWorkouts: assessment } as Week), 6);
      expect(logged[0].plannedTss - logged[0].guardExemptTss).toBeLessThanOrEqual(ACWR_SAFE_HIGH * seed + EPS);
      // A logged load under the nominal week 1 counts as that week (round 7):
      // the plan is the plan with no logged load (at 20 TSS the guard held
      // competitive plans to one short race-pace session a week).
      const tiny = structuredClone(build(band, HYROX_HOURS_RANGE[band].default, 16, {}, 20));
      expect(generateHyroxPlanDetailed(tiny).detail[0].chronicSeedTss).toBeCloseTo(nominal[0].guardFloorTss, 6);
      expect(shape(tiny.wks)).toEqual(shape(s.wks));
      expect(logged[1].guardExemptTss).toBe(0);
      expect(nominal[0].guardExemptTss).toBe(0);

      // A logged zero is no data (§BV): the nominal week stands in.
      const zero = structuredClone(build(band, HYROX_HOURS_RANGE[band].default, 16, {}, 0));
      expect(zero.hyroxConfig!.planChronicSeed).toEqual({ source: 'nominal' });
      expect(generateHyroxPlanDetailed(zero).detail[0].chronicSeedSource).toBe('nominal');
    }
  });

  it('D4: the chronic seed is fixed when the plan is created; a later baseline change moves no regenerated week', () => {
    // Review 2026-10-13: the seed was re-read from the live signalBBaseline (a
    // rolling median every sync refreshes) at every rollover and single-week
    // rebuild: intermediate 8 h logged 150 then 350 lifted weeks 6 to 16 by
    // about 40% (W6 222 to 315 min), competitive 12 h 400 then 150 halved them.
    const shape = (wk: Week | null | undefined) => prescribed(wk ?? undefined).map(w => `${w.dayOfWeek} ${w.t} ${w.estimatedDurationMin}`).join(' | ');
    const cases: Array<[AbilityBand, number, number | undefined, number]> = [
      ['intermediate', 8, 150, 350], ['competitive', 12, 400, 150], ['intermediate', 8, undefined, 120], ['novice', 6, 200, 60],
    ];
    for (const [band, hrs, x, y] of cases) {
      const s = structuredClone(build(band, hrs, 16, {}, x));
      expect(s.hyroxConfig!.planChronicSeed).toEqual(x != null ? { source: 'logged', loggedTss: x } : { source: 'nominal' });
      const stored = s.wks.map(shape);
      s.w = 6;
      s.signalBBaseline = y;
      const fresh = generateHyroxPlan(s);
      for (let i = 5; i < stored.length; i++) expect(shape(fresh[i]), `${band} ${x}->${y} W${i + 1}`).toBe(stored[i]);
      expect(shape(regenerateHyroxWeek(s, 9))).toBe(stored[8]);
      expect(generateHyroxPlanDetailed(s).detail[0].chronicSeedSource).toBe(x != null ? 'logged' : 'nominal');
    }
    // A plan built before the seed was stored fixes it at the version
    // regeneration, from the live value; a new plan stores a fresh one.
    const legacy = structuredClone(build('intermediate', 8, 16));
    delete legacy.hyroxConfig!.planChronicSeed;
    legacy.hyroxConfig!.generatorVersion = 17;
    legacy.signalBBaseline = 260;
    expect(applyHyroxGeneratorRegen(legacy)).toBe(true);
    expect(legacy.hyroxConfig!.planChronicSeed).toEqual({ source: 'logged', loggedTss: 260 });
    expect(build('intermediate', 8, 16, {}, 333).hyroxConfig!.planChronicSeed).toEqual({ source: 'logged', loggedTss: 333 });
  });

  it('D5: the week right before the race taper never deloads; the weekly load target agrees', () => {
    const phases = ['base', 'base', 'base', 'base', 'build', 'build', 'peak', 'peak', 'taper', 'taper'] as const;
    expect(isHyroxDeloadWeek(4, [...phases])).toBe(true);
    expect(isHyroxDeloadWeek(8, [...phases])).toBe(false);
    // A closing week after race week extends the taper run: week 8 is still
    // the week right before it.
    expect(isHyroxDeloadWeek(8, [...phases, 'taper'])).toBe(false);
    // No race taper (a continuous plan): the plain 4-week cycle.
    expect(isHyroxDeloadWeek(8, ['base', 'base', 'base', 'base', 'build', 'build', 'build', 'build', 'build'])).toBe(true);
    for (const len of [10, 14, 18, 22]) {
      const s = build('novice', 6, len);
      const tw = planTrainingWeeks(s);
      const { detail } = generateHyroxPlanDetailed(structuredClone(s));
      expect(s.wks[tw - 3].ph).not.toBe('taper');
      expect(detail[tw - 3].deload).toBe(false);
      expect(resolvePlannedWeekPhase(s, tw - 2).phase).not.toBe('deload');
      expect(detail[3].deload).toBe(true);
      expect(resolvePlannedWeekPhase(s, 4).phase).toBe('deload');
    }
  });

  it('D6: race week holds no more runs than the reference week and keeps its circuit over easy runs', () => {
    // Review: novice 6 h 11 w trained on 1 to 2 runs a week and raced off 3
    // runs with no circuit.
    const s = build('novice', 6, 11);
    const tw = planTrainingWeeks(s);
    const rw = prescribed(s.wks[tw - 1]);
    expect(rw.filter(w => w.discipline === 'run').length).toBeLessThanOrEqual(runs(s.wks[tw - 3]).length);
    expect(rw.some(isCircuit)).toBe(true);
    expect(rw.some(isQuality)).toBe(true);
    // Review minor 1: the never-rises ceiling takes stations out of circuits
    // before it drops whole sessions.
    const tb = build('total_beginner', 5, 10);
    expect(prescribed(tb.wks[planTrainingWeeks(tb) - 2]).some(isCircuit)).toBe(true);
    const two = build('competitive', 8, 14, { hyroxWeeklySessionCount: 2 } as Partial<OnboardingState>);
    const twoRw = prescribed(two.wks[planTrainingWeeks(two) - 1]);
    expect(twoRw.length).toBeGreaterThan(1);
    expect(twoRw.some(isCircuit)).toBe(true);
  });

  it('D7: a first-timer is capped at the intermediate tier whatever the running fitness; a previous result is not', () => {
    // A 35:00 10K (VDOT about 60) and no previous HYROX result.
    const fast = build('total_beginner', 8, 16, { pbs: { k10: 2100 } } as Partial<OnboardingState>);
    expect(fast.hyroxConfig!.athleteBand).toBe('intermediate');
    expect(hyroxTier(fast.hyroxConfig!.athleteBand)).toBe('intermediate');
    expect(build('competitive', 12, 16).hyroxConfig!.athleteBand).toBe('competitive');
  });

  it('D8: with no logged run, a 2-week plan keeps its race-week primer under the 110% rule', () => {
    // Week 1 of a 2-week plan is a taper week (long run 0.65 x the start); the
    // start counts as recent exposure, so the 25-min primer fits under 110%.
    for (const band of ['total_beginner', 'beginner'] as AbilityBand[]) {
      for (const hrs of [4, 6, 8, 10].filter(h => h >= HYROX_HOURS_RANGE[band].min && h <= HYROX_HOURS_RANGE[band].max)) {
        const s = build(band, hrs, 2);
        const tw = planTrainingWeeks(s);
        const rw = prescribed(s.wks[tw - 1]);
        if (!rw.some(w => w.discipline === 'run')) continue;
        expect(rw.some(isQuality), `${band} ${hrs}h`).toBe(true);
        expect(notes(s.wks[tw - 1]).some(n => /110% single-run ceiling/.test(n))).toBe(false);
      }
    }
  });

  it('D8: a logged run counts as exposure in weeks 2 to 4 too: 2-week plans keep the primer; race-week easy runs never exceed the week before\'s long run', () => {
    // Review 2026-10-13: only week 1 counted the logged run, so an athlete
    // with a logged 30-min run dropped the race-week primer in 35 short-plan
    // configurations the same athlete with no logged run kept it in.
    const mon = new Date(); mon.setHours(12, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) - 3);
    let checked = 0;
    for (const band of BANDS) {
      for (const hrs of hoursGrid(band)) {
        for (const len of [2, 3, 5, 7]) {
          resetState();
          const hist = [{ startTime: mon.toISOString(), activityType: 'RUNNING', distKm: 0, durSec: 30 * 60 } as never];
          getMutableState().onboardingRunHistory = hist;
          const sec = BAND_PREV_SEC[band];
          initializeHyroxSimulator({
            ...defaultOnboardingState, name: 'QA', currentStep: 'initializing', trainingMode: 'hyrox', hyroxFormat: 'open_singles',
            triTimeAvailableHoursPerWeek: hrs, planDurationWeeks: len, customRaceDate: null, onboardingRunHistory: hist,
            ...(sec != null ? { previousHyroxTimeSec: sec, hyroxPreviousTimeFormat: 'open_singles' } : {}),
          } as unknown as OnboardingState);
          const s = getState();
          const tw = planTrainingWeeks(s);
          const rw = prescribed(s.wks[tw - 1]);
          if (rw.some(w => w.discipline === 'run')) {
            checked++;
            expect(rw.some(isQuality), `${band} ${hrs}h ${len}w`).toBe(true);
          }
          const beforeLong = tw >= 2 ? prescribed(s.wks[tw - 2]).find(isHyroxLongRun)?.estimatedDurationMin : undefined;
          for (const e of rw.filter(w => w.t === 'hyrox_run_easy')) {
            if (beforeLong != null) expect(e.estimatedDurationMin!, `${band} ${hrs}h ${len}w`).toBeLessThanOrEqual(beforeLong);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  for (const logged of [20, 30, 40, 50, 100]) it(`a logged load of ${logged} TSS: every rule holds, station work every training week, no run under the floor, race week holds a run whenever it holds a run slot`, () => {
    // Review 2026-10-13 (second pass): the guard trimmed long runs to 4 min
    // and week 2 then jumped to 110% of the start. Review 2026-10-13 (third
    // pass): at 40 TSS or less the guard left out the week's last station
    // session before the long run (578 to 679 loaded weeks held a lone long
    // run where a station session and a 20-min long run fitted), week 1's
    // fixed assessment alone broke week 1's guard, and 49 to 95 race weeks
    // held nothing. A ceiling now trims the long run to the run floor and
    // leaves it out before it takes the last station session or brick; such
    // a session at its floor may sit above the guard or the deload ceiling,
    // noted (violations: lastWorkOnly). Week 1's assessment is exempt from
    // week 1's guard.
    let plans = 0;
    let trainingWeeks = 0;
    let emptyRaceWeeks = 0;
    const found: string[] = [];
    {
      for (const band of BANDS) {
        const r = HYROX_HOURS_RANGE[band];
        for (const hrs of [r.min, 4, r.default].filter((h, i, a) => a.indexOf(h) === i && h >= r.min && h <= r.max)) {
          for (const len of [8, 12, 16, 20, 24]) {
            const s = structuredClone(build(band, hrs, len, {}, logged));
            plans++;
            expect(s.hyroxConfig!.planChronicSeed).toEqual({ source: 'logged', loggedTss: logged });
            for (const v of violations(s)) found.push(`${logged} TSS ${band} ${hrs}h ${len}w: ${v}`);
            const tw = planTrainingWeeks(s);
            const wks = s.wks.slice(0, tw);
            wks.forEach((wk, i) => {
              if (wk.ph !== 'taper' && i < tw - 1) trainingWeeks++;
              if (prescribed(wk).some(isHyroxEasyErg) && wk.ph !== 'taper') expect(prescribed(wk).some(isWork), `${logged} ${band} ${hrs}h ${len}w W${i + 1}`).toBe(true);
            });
            if (prescribed(wks[tw - 1]).length === 0) {
              // Only when race week holds no run slot: the reference week
              // held no run (D6).
              emptyRaceWeeks++;
              expect(notes(wks[tw - 1]).some(n => /race week holds no more runs than the reference week's 0/.test(n)), `${logged} ${band} ${hrs}h ${len}w`).toBe(true);
            }
          }
        }
      }
    }
    expect(plans).toBeGreaterThan(60);
    expect(trainingWeeks).toBeGreaterThan(700);
    expect(found.slice(0, 10)).toEqual([]);
    expect(emptyRaceWeeks).toBeLessThan(plans / 5);
  }, 30000);
});


describe('HYROX round 5 decisions (2026-10-13)', () => {
  it('B (reporting): one more chosen hour drops total plan minutes by at most one easy session, and no quality run', () => {
    // Round 6 (2026-10-13): the hard decision-B constraint and the hours
    // ladder are dropped. One more hour may restructure a week (a quality run
    // the week's size now holds, one more easy run the larger running share
    // funds), and no quality run is removed to hold the minutes. The sweep
    // reports every adjacent-hour pair whose total plan minutes fall. The
    // bound is one easy session: the tier long-run cap (HYROX_LONG_RUN
    // capMin), the longest easy session the plan prescribes (an easy erg
    // session lengthens up to it). Asserted on total plan minutes and per
    // training week, and quality runs measured on this grid (not guaranteed),
    // for nine variants: the default sessions, open doubles, open doubles at
    // a logged 100 TSS, the 7-session choice, logged 20, 50, 100 and 200 TSS
    // and a logged 25-min run.
    // History: under a binding guard the week was sized from the chosen hours
    // (round 6 review, pass 2: at a logged 50 TSS 36 pairs fell by more than
    // one easy session, up to 240 min); easy running ranked above easy erg
    // work when the session count or the MTL cap was full (round 6, pass 3:
    // the 7-session choice, 200 TSS and a logged 25-min run fell further, 4,
    // 10 and 2 pairs of 972 on the review sweep); in open doubles at 100 TSS
    // the MTL cap and the chronic window cost 2 quality runs on this grid.
    // Round 7 lets easy erg work take an easy run's slot or MTL whenever the
    // week then holds more minutes, and the guard never sits under the
    // nominal week 1: every variant held the bound and its quality runs on
    // this grid. Since 2026-10-14 the easy erg slot never takes the week's
    // running under the D2 share, so one more hour that funds more running
    // (two run-floor easy runs where the share funded none) can hold fewer
    // minutes than the easy erg sessions those slots held: 7 sessions,
    // competitive 8 to 9 h, peak weeks 480 to 386 min with running 174 to 214
    // min. The bound holds for every week whose running did not rise and for
    // the total those weeks lose; a week whose running rose (D2 funding it)
    // is reported.
    // [name, onboarding, logged weekly TSS, logged run minutes]
    const doubles = { hyroxFormat: 'open_doubles' } as Partial<OnboardingState>;
    const variants: Array<[string, Partial<OnboardingState>, number | undefined, number | undefined]> = [
      ['default', {}, undefined, undefined],
      ['open doubles', doubles, undefined, undefined],
      ['open doubles 100 TSS', doubles, 100, undefined],
      ['7 sessions', { hyroxWeeklySessionCount: 7 } as Partial<OnboardingState>, undefined, undefined],
      ['logged 20 TSS', {}, 20, undefined],
      ['logged 50 TSS', {}, 50, undefined],
      ['logged 100 TSS', {}, 100, undefined],
      ['logged 200 TSS', {}, 200, undefined],
      ['logged 25-min run', {}, undefined, 25],
    ];
    const lengths = [2, 8, 12, 16, 19, 24];
    const fell: string[] = [];
    const tooFar: string[] = [];
    const weekTooFar: string[] = [];
    const qualityFell: string[] = [];
    // Falls beyond one easy session in weeks whose running rose (reported).
    const moreRunning: string[] = [];
    let pairs = 0;
    for (const [name, over, logged, runMin] of variants) {
      for (const band of BANDS) {
        const easyMax = HYROX_LONG_RUN[hyroxTier(band)].capMin;
        const r = HYROX_HOURS_RANGE[band];
        for (const len of lengths) {
          let prev: { total: number; quality: number; weeks: Week[] } | null = null;
          for (let h = Math.max(2, r.min); h <= Math.min(12, r.max); h++) {
            const s = build(band, h, len, over, logged, runMin);
            const weeks = s.wks.slice(0, planTrainingWeeks(s));
            const total = weeks.reduce((a, wk) => a + minutes(wk), 0);
            const quality = weeks.reduce((a, wk) => a + prescribed(wk).filter(isQuality).length, 0);
            if (prev != null) {
              pairs++;
              const label = `${name} ${band} ${len}w ${h - 1}->${h} h`;
              // What the weeks whose running did not rise lose.
              let sameRunFall = 0;
              weeks.forEach((wk, i) => {
                const before = prev!.weeks[i];
                if (!before) return;
                const fall = minutes(before) - minutes(wk);
                const runRose = runningMin(wk) > runningMin(before) + EPS;
                if (fall > EPS && !runRose) sameRunFall += fall;
                if (fall > easyMax + EPS) {
                  const line = `${label} W${i + 1}: ${minutes(before)} -> ${minutes(wk)} min, running ${runningMin(before).toFixed(0)} -> ${runningMin(wk).toFixed(0)}`;
                  if (runRose) moreRunning.push(line); else weekTooFar.push(line);
                }
              });
              if (total < prev.total - EPS) {
                fell.push(`${label}: ${prev.total} -> ${total} min`);
                if (sameRunFall > easyMax + EPS) tooFar.push(`${label}: ${prev.total} -> ${total} min, ${sameRunFall} min in weeks whose running did not rise (more than the ${easyMax}-min easy session)`);
              }
              if (quality < prev.quality) qualityFell.push(`${label}: ${prev.quality} -> ${quality} quality runs`);
            }
            prev = { total, quality, weeks: structuredClone(weeks) };
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(variants.length * BANDS.length * lengths.length * 5);
    // The report: every pair whose total plan minutes fall.
    console.info(`[hyrox B report] ${fell.length} of ${pairs} adjacent-hour pairs hold fewer total plan minutes${fell.length > 0 ? `:\n  ${fell.join('\n  ')}` : ''}`);
    console.info(`[hyrox B report] ${moreRunning.length} weeks fall by more than one easy session where one more hour funds more running${moreRunning.length > 0 ? `:\n  ${moreRunning.join('\n  ')}` : ''}`);
    expect(tooFar.slice(0, 10)).toEqual([]);
    expect(weekTooFar.slice(0, 10)).toEqual([]);
    expect(qualityFell.slice(0, 10)).toEqual([]);
  }, 900000);

  it('C: a training week under the chosen hours says so plainly, with what holds it', () => {
    let short = 0;
    for (const band of BANDS) {
      for (const hrs of hoursGrid(band)) {
        for (const len of [8, 16, 24]) {
          const s = build(band, hrs, len);
          const tw = planTrainingWeeks(s);
          for (let i = 0; i < tw; i++) {
            const wk = s.wks[i];
            if (wk.ph === 'taper') continue;
            const n = notes(wk).find(x => /^W\d+: \d+ of the chosen \d+ min \(/.test(x));
            if (hrs * 60 - minutes(wk) >= HYROX_RUN_FLOOR_MIN) {
              short++;
              expect(n, `${band} ${hrs}h ${len}w W${i + 1}`).toBeDefined();
              expect(n!).toContain(`${minutes(wk)} of the chosen ${hrs * 60} min`);
              expect(n!).not.toMatch(/—/);
            } else {
              expect(n, `${band} ${hrs}h ${len}w W${i + 1}`).toBeUndefined();
            }
          }
        }
      }
    }
    expect(short).toBeGreaterThan(0);
  }, 120000);

  it('an injury that gates the stations never trades an easy run for an easy erg session the gates drop', () => {
    // Review 2026-10-13: with the station capacity at 0 and running open,
    // the chosen sessions counted as full (the gated stations' slots), the
    // shortest easy run left for an easy erg session, and the gates then
    // dropped the erg: 138 of 630 training weeks lost an easy run, the
    // injured athlete's only gate-safe training (novice 10 h 12 weeks, W5: 3
    // runs and 170 min became 2 runs and 105 min).
    let weeks = 0;
    for (const band of BANDS) {
      const r = HYROX_HOURS_RANGE[band];
      for (const hrs of [r.default, 10, 12].filter((h, i, a) => a.indexOf(h) === i && h >= r.min && h <= r.max)) {
        for (const len of [12, 16, 20]) {
          const s = structuredClone(build(band, hrs, len));
          (s as unknown as { injuryState: unknown }).injuryState = { active: true, runCapacity: 100, upperLoadCapacity: 0, lowerLoadCapacity: 100 };
          const { detail } = generateHyroxPlanDetailed(s);
          // The same athlete without erg access, where no easy run can leave
          // for erg work: the runs must be the same.
          const noErg = structuredClone(s);
          noErg.hyroxConfig!.stationAccess = { ...noErg.hyroxConfig!.stationAccess, skiErg: false, rowErg: false };
          const ref = generateHyroxPlanDetailed(noErg).detail;
          const runMin = (ws: Workout[]) => ws.filter(w => w.discipline === 'run' && w.commute !== true).map(w => w.estimatedDurationMin ?? 0).sort((a, b) => a - b).join(',');
          for (const d of detail) {
            if (d.phase === 'taper') continue;
            weeks++;
            const label = `${band} ${hrs}h ${len}w W${d.week}`;
            expect(d.workouts.some(isHyroxEasyErg), label).toBe(false);
            expect(d.adjustments.some(n => /left out for an easy erg session/.test(n)), label).toBe(false);
            expect(d.workouts.some(isWork), label).toBe(false);
            expect(runMin(d.workouts), label).toBe(runMin(ref[d.week - 1].workouts));
          }
        }
      }
    }
    expect(weeks).toBeGreaterThan(500);
  });

  it('the hours line (round 6, item 7): only a loaded week the chosen session count holds, with the week\'s own numbers', () => {
    // Week.hyroxHoursFit drives the plan view's one muted line ("Your 5
    // sessions fit about 6 h of your 8 h."). Review 2026-10-13: 2,271 of
    // 14,147 hours notes stated a budget below the week's own minutes, so
    // every number is checked against the week. Round 6 review, pass 2: 79% of
    // marked weeks were base and build weeks whose phase budget held them
    // hours under the chosen hours, and in 11% one more session added under
    // 20 min. A marked week's size is the chosen hours (the phase budget is
    // not under them), and one more chosen session holds at least
    // HYROX_RUN_FLOOR_MIN more of it.
    let marked = 0;
    let liftChecked = 0;
    const tooSmall: string[] = [];
    for (const band of BANDS) {
      for (const hrs of hoursGrid(band)) {
        for (const len of [8, 16, 24]) {
          const s = build(band, hrs, len);
          const tw = planTrainingWeeks(s);
          const { detail } = generateHyroxPlanDetailed(structuredClone(s));
          const chosen = chosenSessions(s);
          let plus: SimulatorState | null = null;
          for (let i = 0; i < tw; i++) {
            const wk = s.wks[i];
            const fit = wk.hyroxHoursFit;
            const d = detail[i];
            const label = `${band} ${hrs}h ${len}w W${i + 1}`;
            expect(fit, label).toEqual(d.hoursFit);
            if (!fit) continue;
            marked++;
            expect(wk.ph === 'taper' || d.deload || d.raceWeek, label).toBe(false);
            expect(fit.sessions, label).toBe(prescribed(wk).length);
            expect(fit.sessions, label).toBeGreaterThanOrEqual(chosen);
            expect(fit.plannedMin, label).toBe(minutes(wk));
            expect(fit.chosenHours, label).toBe(hrs);
            // The week's size is the chosen hours: its phase budget is not
            // under them, and it sits at least one easy session's floor under.
            expect(d.budgetMin, label).toBeGreaterThanOrEqual(hrs * 60 - 0.5);
            expect(hrs * 60 - fit.plannedMin, label).toBeGreaterThanOrEqual(HYROX_RUN_FLOOR_MIN - 0.5);
            // No ceiling and no MTL cap held it.
            expect(notes(wk).some(n => /\((acute:chronic guard|weekly hours|base budget|build budget|peak budget)\)|MTL cap \d+|guard holds its load/.test(n)), label).toBe(false);
            // The line's rounded figure sits under the chosen hours.
            expect(Math.round(fit.plannedMin / 30) / 2, label).toBeLessThan(hrs);
            // One more chosen session holds at least HYROX_RUN_FLOOR_MIN more.
            if (chosen < 7) {
              plus ??= build(band, hrs, len, { hyroxWeeklySessionCount: chosen + 1 } as Partial<OnboardingState>);
              liftChecked++;
              if (minutes(plus.wks[i]) - fit.plannedMin < HYROX_RUN_FLOOR_MIN) tooSmall.push(`${label}: ${fit.plannedMin} -> ${minutes(plus.wks[i])} min with ${chosen + 1} sessions`);
            }
          }
        }
      }
    }
    expect(marked).toBeGreaterThan(20);
    expect(liftChecked).toBeGreaterThan(10);
    expect(tooSmall.slice(0, 10)).toEqual([]);
    // The line never shows for a week the phase budget, a deload or the taper
    // holds: a base week that fills its budget carries none, nor does a base
    // or build week the phase budget holds hours under the chosen hours
    // (competitive 12 h 16 weeks, weeks 2 and 3: about 6.5 h of a 7 to 7.5 h
    // budget, review pass 2).
    expect(build('intermediate', 8, 16).wks[1].hyroxHoursFit).toBeUndefined();
    const c12 = build('competitive', 12, 16);
    for (const wk of c12.wks) if (wk.ph !== 'peak') expect(wk.hyroxHoursFit, `competitive 12h 16w W${wk.w}`).toBeUndefined();
  }, 300000);

  it('beginner-tier deloads keep at least half the last loaded week\'s running (round 6, item 8)', () => {
    // Review 2026-10-13: a technique circuit at its 2-round floor held its
    // length under the deload's shared scale while floor(scale x the easy
    // minutes) fell under the run floor and the easy run left: 57 deloads,
    // all beginner tier, ran half the last loaded week or less
    // (total_beginner 4 h 12 weeks W8: circuit 61, mini brick 34, long run
    // 29, against easy 28, circuit 63, mini brick 47, long run 38). A deload
    // now holds its easy run at the run floor and takes stations out of its
    // circuits first. At 2 h the deload ceiling cannot hold the long run at
    // the run floor beside the circuit at its floor, and the week keeps its
    // station work (the round-4 guarantee), so 2 h is outside this check.
    const run = (wk: Week) => runningMin(wk);
    let deloads = 0;
    for (const band of ['total_beginner', 'beginner', 'novice', 'intermediate'] as AbilityBand[]) {
      const r = HYROX_HOURS_RANGE[band];
      for (const hrs of [4, 6, r.default].filter((h, i, a) => a.indexOf(h) === i && h >= r.min && h <= r.max)) {
        for (let len = 8; len <= 24; len += 2) {
          const s = build(band, hrs, len);
          const tw = planTrainingWeeks(s);
          const wks = s.wks.slice(0, tw);
          const isDeload = deloadOf(wks);
          for (let i = 1; i < tw; i++) {
            if (wks[i].ph === 'taper' || !isDeload(i)) continue;
            let k = i - 1;
            while (k >= 0 && (wks[k].ph === 'taper' || isDeload(k))) k--;
            if (k < 0) continue;
            deloads++;
            expect(run(wks[i]), `${band} ${hrs}h ${len}w W${i + 1}`).toBeGreaterThanOrEqual(0.5 * run(wks[k]) - EPS);
          }
        }
      }
    }
    expect(deloads).toBeGreaterThan(100);
    // The easy run ranks above the mini brick in a deload (round 7):
    // beginner 3 h 24 weeks, W20, leaves its mini brick so the running share
    // funds the easy run's hold, and says so.
    const b3 = build('beginner', 3, 24);
    expect(prescribed(b3.wks[19]).some(w => w.t === 'hyrox_run_easy' && !isHyroxLongRun(w))).toBe(true);
    expect(prescribed(b3.wks[19]).some(w => w.t === 'hyrox_mini_brick')).toBe(false);
    expect(notes(b3.wks[19]).some(n => /Mini Brick left out \(deload: the easy run ranks above it\)/.test(n))).toBe(true);
    // beginner 5 h 12 weeks: W7 holds an easy run of 38 min, a 71-min circuit,
    // a 60-min mini brick and a 38-min long run; the W8 deload keeps its easy
    // run at the run floor or above and shortens the circuit (a station out:
    // no longer or heavier than W7's, round 7) and the mini brick. (Before the
    // 2026-10-14 merge the example was 4 h: with the real S8-S9 seeds its
    // W7 circuit is heavier and the guard leaves W7's easy run out, so its
    // deload holds none to keep.)
    const s = build('beginner', 5, 12);
    expect(prescribed(s.wks[6]).some(w => w.t === 'hyrox_run_easy' && !isHyroxLongRun(w))).toBe(true);
    expect(prescribed(s.wks[7]).find(w => w.t === 'hyrox_run_easy' && !isHyroxLongRun(w))?.estimatedDurationMin).toBeGreaterThanOrEqual(HYROX_RUN_FLOOR_MIN);
  });

  it('with an active injury the easy erg slot swap never runs, whatever the capacities (round 6, item 6)', () => {
    // The injury gates and the capability substitution's offers decide an
    // injured week; the swap (an easy run's slot freed for easy erg work)
    // does not run, even with every capacity open. The same athlete without
    // the injury swaps in some of these weeks.
    // Since 2026-10-14 the swap keeps the week's running at or above the D2
    // share, so it is rare: intermediate 7 h 24 weeks with 6 sessions (W9) is
    // one of the 2 swaps in 17,760 training weeks of the default, 6- and
    // 7-session grids, and stands in for the swap here.
    let swappedHealthy = 0;
    let weeks = 0;
    const configs: Array<[AbilityBand, number, number, number]> = [['intermediate', 7, 24, 6]];
    for (const band of ['intermediate', 'advanced', 'competitive'] as AbilityBand[]) {
      for (const hrs of [8, 10, 12]) {
        for (const sess of [6, 7]) configs.push([band, hrs, 16, sess]);
      }
    }
    {
      for (const [band, hrs, len, sess] of configs) {
        {
          const s = structuredClone(build(band, hrs, len, { hyroxWeeklySessionCount: sess } as Partial<OnboardingState>));
          const healthy = generateHyroxPlanDetailed(structuredClone(s)).detail;
          swappedHealthy += healthy.filter(d => d.adjustments.some(n => /left out for an easy erg session/.test(n))).length;
          for (const caps of [{ runCapacity: 100, upperLoadCapacity: 100, lowerLoadCapacity: 100 }, { runCapacity: 100, upperLoadCapacity: 50, lowerLoadCapacity: 100 }]) {
            const inj = structuredClone(s);
            (inj as unknown as { injuryState: unknown }).injuryState = { active: true, ...caps };
            for (const d of generateHyroxPlanDetailed(inj).detail) {
              weeks++;
              expect(d.adjustments.some(n => /left out for an easy erg session/.test(n)), `${band} ${hrs}h ${sess} W${d.week}`).toBe(false);
            }
          }
        }
      }
    }
    expect(weeks).toBeGreaterThan(500);
    expect(swappedHealthy).toBeGreaterThan(0);
  });

  it('E: no long run under the run floor at low logged loads, the taper long run included', () => {
    for (const logged of [20, 30]) {
      for (const band of BANDS) {
        for (const len of [8, 10, 14]) {
          const s = build(band, HYROX_HOURS_RANGE[band].default, len, {}, logged);
          for (const wk of s.wks.slice(0, planTrainingWeeks(s))) {
            const long = prescribed(wk).find(isHyroxLongRun);
            if (long) expect(long.estimatedDurationMin!, `${band} ${len}w ${logged} TSS`).toBeGreaterThanOrEqual(HYROX_RUN_FLOOR_MIN);
          }
        }
      }
    }
  });

  it('race week keeps a circuit whenever the athlete has the stations, the race-week days allow it and the week before holds the primer beside the smallest circuit (round 6 review, pass 2; round 7)', () => {
    // Review: once the long run and the quality run came first, a reference
    // week holding a short race-pace block capped the taper's station work
    // under any circuit, and 106 to 249 of 1,020 race weeks per variant held
    // none (21 to 23, all at 2 h, at round 4). The taper's station ceilings now
    // never sit under its smallest circuit (MIN_CIRCUIT_ROUNDS rounds of
    // MIN_CIRCUIT_STATIONS stations), and round 7 exempts that circuit from
    // the 0.70 / 0.55 fractions in taper week 1 and race week (2-h plans lost
    // it to them: 123 taper weeks with no station work and 63 race weeks with
    // no circuit per 1,080 plans). A race week without a circuit is one the
    // race-day rules left no day for, or one whose week before (the taper
    // never rising) cannot hold the primer beside it.
    let withCircuit = 0;
    let weeks = 0;
    let taper1Work = 0;
    for (const [over, logged] of [[{}, undefined], [{ hyroxFormat: 'open_doubles' }, undefined], [{}, 100]] as Array<[Partial<OnboardingState>, number | undefined]>) {
      for (const band of BANDS) {
        if (HYROX_WEEKLY_STRUCTURE[hyroxTier(band)].peak.stations === 0) continue;
        for (const hrs of hoursGrid(band)) {
          for (let len = 8; len <= 24; len += 4) {
            const s = build(band, hrs, len, over, logged);
            const tw = planTrainingWeeks(s);
            const wks = s.wks.slice(0, tw);
            const rw = wks[tw - 1];
            const label = `${JSON.stringify(over)} ${logged ?? '-'} ${band} ${hrs}h ${len}w`;
            weeks++;
            // Taper week 1 keeps station or brick work, 2-h plans included.
            if (prescribed(wks[tw - 2]).some(isWork)) taper1Work++;
            else expect(notes(wks[tw - 2]).some(n => /left out \((no race-week day|the taper never rises|taper: the reference week's station and brick work)/.test(n)), `${label} taper week 1`).toBe(true);
            if (prescribed(rw).some(isCircuit)) { withCircuit++; continue; }
            if (notes(rw).some(n => /Station Circuit left out \(no race-week day/.test(n))) continue;
            const isDeload = deloadOf(wks);
            let taperStart = tw;
            while (taperStart > 1 && wks[taperStart - 2].ph === 'taper') taperStart--;
            let ref = taperStart - 2;
            while (ref >= 0 && (wks[ref].ph === 'taper' || isDeload(ref))) ref--;
            const floor = hyroxRaceTaperFloorCircuit(s, tw, true);
            expect(floor, label).not.toBeNull();
            const cap = tw >= 2 ? minutes(wks[tw - 2]) : Infinity;
            const primer = prescribed(rw).filter(isQuality).reduce((a, w) => a + (w.estimatedDurationMin ?? 0), 0);
            expect(primer + floor!.min, label).toBeGreaterThan(cap + EPS);
          }
        }
      }
    }
    expect(withCircuit).toBeGreaterThan(0.95 * weeks);
    expect(taper1Work).toBeGreaterThan(0.95 * weeks);
  }, 300000);

  it('the injury modal rebuilds every remaining week in one build, as the full plan builds them (round 6 review, pass 2)', () => {
    const s = structuredClone(build('intermediate', 8, 16));
    s.w = 5;
    (s as unknown as { injuryState: unknown }).injuryState = { active: true, runCapacity: 100, upperLoadCapacity: 0, lowerLoadCapacity: 100 };
    const many = regenerateHyroxWeeksFrom(s, 5);
    expect(many).toHaveLength(s.wks.length - 4);
    const full = generateHyroxPlanDetailed(structuredClone(s)).weeks;
    many.forEach((wk, i) => {
      expect(wk?.triWorkouts, `W${5 + i}`).toEqual(full[4 + i].triWorkouts);
      expect(wk?.hyroxPlanNotes, `W${5 + i}`).toEqual(full[4 + i].hyroxPlanNotes);
    });
    expect(regenerateHyroxWeek(s, 5)).toEqual(many[0]);
    expect(regenerateHyroxWeek(s, 0)).toBeNull();
    expect(regenerateHyroxWeek(s, s.wks.length + 1)).toBeNull();
  });
});
