/**
 * MusculoTendon Load (MTL) computation.
 *
 * **Side**: planning + tracking. Quantifies eccentric / mechanical strain from
 * HYROX station work and runs as a third load currency alongside aerobic TSS
 * and impact load.
 *
 * **Model** (research doc §3.3):
 *   rawMTL = IL × modalityFactor × impactFactor × (1 + externalLoadFactor)
 *   where IL = durationMin × sRPE  (internal load, same as session RPE method)
 *   effectiveMTL = cap × (1 - exp(−rawMTL / cap))  (saturation curve)
 *
 * The saturation curve prevents extremely high-load sessions from linearly
 * accumulating. Real tissue tolerance asymptotes at high loads. This mirrors
 * the Banister impulse-response saturation used in some CTL models (Busso 2003).
 *
 * Science log entry: docs/SCIENCE_LOG.md §L.
 */

import type { HyroxStation } from '@/types/triathlon';
import type { Week, SimulatorState, Workout } from '@/types/state';
import { STATION_MTL_FACTORS, RUN_MTL_FACTORS } from '@/constants/hyrox-constants';
import { ctlAdherenceRatio, ROLLING_ACWR_MIN_OBSERVED_DAYS } from '@/calculations/fitness-model';

export type RunIntensity = 'run_easy' | 'run_tempo' | 'run_intervals';

/**
 * Compute raw MTL for a single session component (one station or one run segment).
 *
 * @param durationMin  - Duration of the component in minutes
 * @param sRPE         - Session RPE (1–10) for this component
 * @param component    - Station identifier or run intensity
 * @param externalLoadKg - External load carried/pushed (kg). Null = bodyweight only.
 * @param bodyWeightKg   - Athlete bodyweight (kg). Required when externalLoadKg is set.
 */
export function computeComponentMTL(
  durationMin: number,
  sRPE: number,
  component: HyroxStation | RunIntensity,
  externalLoadKg?: number,
  bodyWeightKg?: number,
): number {
  if (durationMin <= 0 || sRPE <= 0) return 0;

  const il = durationMin * sRPE;

  const factors =
    (STATION_MTL_FACTORS as Record<string, { modality: number; impact: number }>)[component] ??
    (RUN_MTL_FACTORS as Record<string, { modality: number; impact: number }>)[component];

  if (!factors) return 0;

  const { modality, impact } = factors;

  // External load factor: capped at 0.6 (60% amplification) regardless of weight.
  // Ratio of external load to body weight, scaled by 0.5 (conservative linear fit).
  const externalFactor =
    externalLoadKg != null && bodyWeightKg != null && bodyWeightKg > 0
      ? Math.min(0.6, (externalLoadKg / bodyWeightKg) * 0.5)
      : 0;

  return il * modality * impact * (1 + externalFactor);
}

/**
 * Apply the saturation curve to convert raw weekly MTL to effective MTL.
 *
 * Uses a one-minus-exponential saturation: as raw MTL approaches and exceeds
 * `cap`, the marginal return flattens. This prevents naive linear accumulation
 * from overstating injury risk in extremely high-load weeks.
 *
 * @param rawMTL - Sum of component MTLs for a session or week
 * @param cap    - Per-band MTL cap from HYROX_MTL_CAP
 */
export function computeEffectiveMTL(rawMTL: number, cap: number): number {
  if (rawMTL <= 0) return 0;
  if (cap <= 0) return rawMTL;
  return cap * (1 - Math.exp(-rawMTL / cap));
}

/**
 * Sum the planned `musculoTendonLoad` across all workouts in a week.
 * Returns 0 for weeks with no HYROX workouts.
 */
export function computeWeekMTL(wk: Week): number {
  const workouts = wk.triWorkouts ?? [];
  return workouts.reduce((acc, w) => acc + (w.musculoTendonLoad ?? 0), 0);
}

/**
 * TRACKING side: did the athlete complete this planned session? True when the
 * session carries a matched activity (`matchedActivityId`, set by the
 * triathlon matcher and the cross-source twin rebind) or an activity record
 * sits on its slot key (`wk.garminActuals[id || n]`). HYROX writes only the
 * second: the matcher's station and run branches, in-app GPS runs, Mark as
 * Done records (runs and, since 2026-10-06, bike / erg / swim cross sessions)
 * and quick-done station records all key the record by the slot. Same
 * completion test as the status chip (deriveWorkoutStatus) minus the bare
 * rating: a rating with no record (a future-week tick) is not counted.
 *
 * The MTL sums below read wk.triWorkouts. HYROX cross sessions are injury
 * capability offers stored in wk.adhocWorkouts and carry no
 * musculoTendonLoad (the MTL model has factors for stations and runs only,
 * hyrox-constants STATION_MTL_FACTORS / RUN_MTL_FACTORS), so a completed cross
 * session adds no MTL, ticked or recorded.
 */
export function isMtlSessionCompleted(wk: Week, w: Workout): boolean {
  if (w.matchedActivityId) return true;
  const key = w.id || w.n;
  return !!key && !!wk.garminActuals?.[key];
}

/**
 * Sum `musculoTendonLoad` across **completed** workouts in a week
 * (isMtlSessionCompleted). Returns 0 when no completions yet.
 *
 * Mirrors `computeWeekMTL`'s scope (all triWorkouts incl. runs) so the
 * actual / planned / chronic / acute display numbers share one source of
 * truth. Replaces the stored `hyroxConfig.weeklyActualMTL` accumulator,
 * which only the matcher's station branch added to and which is no longer
 * written.
 */
export function computeWeekActualMTL(wk: Week): number {
  const workouts = wk.triWorkouts ?? [];
  return workouts.reduce(
    (acc, w) => acc + (isMtlSessionCompleted(wk, w) ? (w.musculoTendonLoad ?? 0) : 0),
    0,
  );
}

export interface DisciplineMTL { run: number; station: number; brick: number; }

/** Discipline-split weekly MTL (planned): each workout's MTL bucketed by
 *  discipline. Used by plan-engine cap enforcement at generation time. */
export function computeWeekMTLByDiscipline(wk: Week): DisciplineMTL {
  const workouts = wk.triWorkouts ?? [];
  let run = 0, station = 0, brick = 0;
  for (const w of workouts) {
    const mtl = w.musculoTendonLoad ?? 0;
    const disc = (w as { discipline?: string }).discipline;
    if (disc === 'station') station += mtl;
    else if (disc === 'brick') brick += mtl;
    else run += mtl;
  }
  return { run, station, brick };
}

/** Discipline-split weekly MTL (actuals): only completed workouts
 *  (isMtlSessionCompleted) contribute. Used by the CTL/ATL impulse-response EMAs
 *  so chronic and acute reflect completed training, mirroring running CTL/ATL. */
export function computeWeekActualMTLByDiscipline(wk: Week): DisciplineMTL {
  const workouts = wk.triWorkouts ?? [];
  let run = 0, station = 0, brick = 0;
  for (const w of workouts) {
    if (!isMtlSessionCompleted(wk, w)) continue;
    const mtl = w.musculoTendonLoad ?? 0;
    const disc = (w as { discipline?: string }).discipline;
    if (disc === 'station') station += mtl;
    else if (disc === 'brick') brick += mtl;
    else run += mtl;
  }
  return { run, station, brick };
}

export interface DisciplineFitnessFatigue {
  runMtlCTL: number; stationMtlCTL: number; brickMtlCTL: number;
  runMtlATL: number; stationMtlATL: number; brickMtlATL: number;
}

/**
 * TRACKING side: the starting value of the MTL EMAs. Weeks before plan week 1
 * carry no MTL record for anyone: MTL exists only on plan sessions, so no
 * activity history can stand in for it. Starting both EMAs at 0 read those
 * weeks as rest weeks, so a plan-compliant athlete showed a load ratio of 3.06
 * in week 2 and still 1.68 in week 6 (intermediate), and the readiness MTL
 * floor held Home at Ease Back through the base phase.
 *
 * Same rule as running's rolling load ratio for unrecorded days
 * (fitness-model.ts computeRollingLoadRatio, SCIENCE_LOG "Unrecorded days"):
 * missing weeks are valued at the athlete's own mean weekly load, taken from
 * the completed plan weeks before the current week. With no completed week
 * there is nothing to value them at, and the EMAs start at 0 as before.
 * `weekValue` picks the series (total, or one discipline), so the discipline
 * EMAs, seeded the same way, still sum to the total.
 */
function observedBaselineWeeklyMTL(
  weeks: Week[],
  currentWeekIndex: number,
  weekValue: (wk: Week) => number,
): number {
  const completed = Math.max(0, Math.min(currentWeekIndex, weeks.length - 1));
  if (completed === 0) return 0;
  let sum = 0;
  for (let i = 0; i < completed; i++) sum += weekValue(weeks[i]);
  return sum / completed;
}

/**
 * Discipline-split CTL/ATL. Separate impulse-response EMAs per
 * run / station / brick. Reads **completed** workouts only
 * (isMtlSessionCompleted), mirroring how running CTL/ATL is fed by actual TSS
 * rather than planned. Each EMA starts at that discipline's observed baseline
 * (observedBaselineWeeklyMTL), so the three sum to computeMTLFitnessFatigue.
 * Returns daily-equivalent values (÷7).
 */
export function computeMTLFitnessFatigueByDiscipline(
  weeks: Week[],
  currentWeekIndex: number,
): DisciplineFitnessFatigue {
  const CTL_DECAY = Math.exp(-7 / 42);
  const ATL_DECAY = Math.exp(-7 / 7);

  const runSeed     = observedBaselineWeeklyMTL(weeks, currentWeekIndex, wk => computeWeekActualMTLByDiscipline(wk).run);
  const stationSeed = observedBaselineWeeklyMTL(weeks, currentWeekIndex, wk => computeWeekActualMTLByDiscipline(wk).station);
  const brickSeed   = observedBaselineWeeklyMTL(weeks, currentWeekIndex, wk => computeWeekActualMTLByDiscipline(wk).brick);
  let runCtl = runSeed, runAtl = runSeed;
  let stationCtl = stationSeed, stationAtl = stationSeed;
  let brickCtl = brickSeed, brickAtl = brickSeed;
  const limit = Math.min(currentWeekIndex + 1, weeks.length);
  for (let i = 0; i < limit; i++) {
    const m = computeWeekActualMTLByDiscipline(weeks[i]);
    runCtl     = runCtl     * CTL_DECAY + m.run     * (1 - CTL_DECAY);
    runAtl     = runAtl     * ATL_DECAY + m.run     * (1 - ATL_DECAY);
    stationCtl = stationCtl * CTL_DECAY + m.station * (1 - CTL_DECAY);
    stationAtl = stationAtl * ATL_DECAY + m.station * (1 - ATL_DECAY);
    brickCtl   = brickCtl   * CTL_DECAY + m.brick   * (1 - CTL_DECAY);
    brickAtl   = brickAtl   * ATL_DECAY + m.brick   * (1 - ATL_DECAY);
  }

  return {
    runMtlCTL: runCtl / 7,
    runMtlATL: runAtl / 7,
    stationMtlCTL: stationCtl / 7,
    stationMtlATL: stationAtl / 7,
    brickMtlCTL: brickCtl / 7,
    brickMtlATL: brickAtl / 7,
  };
}

/**
 * Compute MTL CTL (chronic) and ATL (acute) from **completed** weekly MTL.
 * Only completed workouts (isMtlSessionCompleted) contribute, mirroring how
 * running CTL/ATL is fed by actual TSS rather than planned. Until the user
 * completes a session, both are zero. That is correct: a fresh user has no history
 * to smooth.
 *
 * Both EMAs start at the athlete's observed baseline (observedBaselineWeeklyMTL):
 * the weeks before the plan are missing, not rest.
 *
 * Uses Banister impulse-response EMA constants (same as running CTL/ATL):
 *   CTL τ = 42 days → weekly decay factor exp(−7/42)
 *   ATL τ = 7 days  → weekly decay factor exp(−7/7)
 *
 * Returns daily-equivalent values (÷7) so they are comparable to running CTL.
 * Pass all plan weeks up to and including the current one.
 *
 * Science: Banister et al. 1975; Busso 2003. Same model as aerobic CTL/ATL —
 * defensible because MTL load has the same impulse-response structure as
 * cardiovascular load: acute fatigue decays faster than chronic fitness.
 */
export function computeMTLFitnessFatigue(
  weeks: Week[],
  currentWeekIndex: number,
): { mtlCTL: number; mtlATL: number } {
  const series = computeMTLFitnessFatigueSeries(weeks, currentWeekIndex);
  return series[series.length - 1] ?? { mtlCTL: 0, mtlATL: 0 };
}

/**
 * The same walk as computeMTLFitnessFatigue, one entry per plan week from
 * week 1 to the current week (daily-equivalent). The whole series uses the
 * current week's observed baseline as its starting value, so the last entry is
 * exactly computeMTLFitnessFatigue(weeks, currentWeekIndex) and the trend line
 * on the MTL page ends on the numbers printed above it.
 */
export function computeMTLFitnessFatigueSeries(
  weeks: Week[],
  currentWeekIndex: number,
): Array<{ mtlCTL: number; mtlATL: number }> {
  return mtlEmaSeries(weeks, currentWeekIndex, computeWeekActualMTL);
}

/**
 * The MTL impulse-response walk behind computeMTLFitnessFatigueSeries, over any
 * weekly series: completed MTL (computeWeekActualMTL) for the athlete's chronic
 * and acute load, or planned MTL (computeWeekMTL) for the load the plan
 * prescribed. Both EMAs start at that series' own observed baseline
 * (observedBaselineWeeklyMTL). Daily-equivalent (÷7).
 */
function mtlEmaSeries(
  weeks: Week[],
  currentWeekIndex: number,
  weekValue: (wk: Week) => number,
): Array<{ mtlCTL: number; mtlATL: number }> {
  const CTL_DECAY = Math.exp(-7 / 42);
  const ATL_DECAY = Math.exp(-7 / 7);

  const seed = observedBaselineWeeklyMTL(weeks, currentWeekIndex, weekValue);
  let ctl = seed;
  let atl = seed;

  const out: Array<{ mtlCTL: number; mtlATL: number }> = [];
  const limit = Math.min(currentWeekIndex + 1, weeks.length);
  for (let i = 0; i < limit; i++) {
    const weeklyMTL = weekValue(weeks[i]);
    ctl = ctl * CTL_DECAY + weeklyMTL * (1 - CTL_DECAY);
    atl = atl * ATL_DECAY + weeklyMTL * (1 - ATL_DECAY);
    out.push({ mtlCTL: ctl / 7, mtlATL: atl / 7 });
  }
  return out;
}

/** Plan weeks completed before the current week (0-based current index). */
function completedPlanWeeks(weeks: Week[], currentWeekIndex: number): number {
  return Math.max(0, Math.min(currentWeekIndex, weeks.length - 1));
}

/**
 * The MTL history guard: fewer than ROLLING_ACWR_MIN_OBSERVED_DAYS of completed
 * plan weeks. Before then the observed baseline the EMAs start from rests on a
 * single week (or none). Shared by computeMtlAcwr and computeMtlChronicVsPlan.
 */
function mtlHistoryTooShort(completedWeeks: number): boolean {
  return completedWeeks * 7 < ROLLING_ACWR_MIN_OBSERVED_DAYS;
}

/**
 * Daily-equivalent chronic MTL below which the load ratio is withheld. The
 * value is the gate Home, Readiness, Stats and the MTL detail page each wrote
 * inline (`mtlCTL >= 15`); it lives here now so every surface reads one rule.
 */
export const MTL_ACWR_MIN_CHRONIC = 15;

export interface MtlAcwr {
  /** acute ÷ chronic, or null when withheld (see `reason`). */
  ratio: number | null;
  /** Daily-equivalent chronic MTL (computeMTLFitnessFatigue mtlCTL). */
  chronic: number;
  /** Daily-equivalent acute MTL (computeMTLFitnessFatigue mtlATL). */
  acute: number;
  /** 'history': fewer than ROLLING_ACWR_MIN_OBSERVED_DAYS of completed plan weeks.
   *  'lowChronic': chronic below MTL_ACWR_MIN_CHRONIC. */
  reason: 'ok' | 'history' | 'lowChronic';
}

/**
 * TRACKING side: the MTL acute:chronic load ratio, the one computation behind
 * the readiness `mtlAcwr` input (Home, Readiness), the Stats "Load ratio" row,
 * the MTL detail page, and the chronic / acute numbers shown beside them.
 *
 * Withheld until ROLLING_ACWR_MIN_OBSERVED_DAYS of plan weeks are complete,
 * the same guard as running's rolling load ratio without a seed: before that
 * the observed baseline the EMAs start from rests on a single week. Plan weeks
 * count as observed whether or not the athlete trained, as plan days do for
 * running. A plan week is 7 days, so the guard opens on day 1 of week 3, the
 * same day the running guard opens for a plan started on that date.
 */
export function computeMtlAcwr(weeks: Week[], currentWeekIndex: number): MtlAcwr {
  const { mtlCTL, mtlATL } = computeMTLFitnessFatigue(weeks, currentWeekIndex);
  const base = { chronic: mtlCTL, acute: mtlATL };
  if (mtlHistoryTooShort(completedPlanWeeks(weeks, currentWeekIndex))) return { ...base, ratio: null, reason: 'history' };
  if (mtlCTL < MTL_ACWR_MIN_CHRONIC) return { ...base, ratio: null, reason: 'lowChronic' };
  return { ...base, ratio: mtlATL / mtlCTL, reason: 'ok' };
}

/** computeMtlAcwr for the current week of a HYROX plan; null in every other mode. */
export function hyroxMtlAcwr(s: SimulatorState): MtlAcwr | null {
  if (s.eventType !== 'hyrox') return null;
  return computeMtlAcwr(s.wks ?? [], Math.max(0, (s.w ?? 1) - 1));
}

export interface MtlChronicVsPlan {
  /** completed ÷ prescribed chronic MTL, or null when withheld (see `reason`). */
  ratio: number | null;
  /** Daily-equivalent chronic MTL from completed sessions at the end of the last completed week. */
  actual: number;
  /** Daily-equivalent chronic MTL the plan prescribed for the same weeks. */
  prescribed: number;
  /** Plan weeks the comparison covers (weeks before the current one). */
  completedWeeks: number;
  /** 'history': computeMtlAcwr's history guard is still closed.
   *  'noPlan': the completed weeks prescribed no MTL. */
  reason: 'ok' | 'history' | 'noPlan';
}

/**
 * TRACKING side: the athlete's chronic MTL against the chronic MTL the plan
 * prescribed, over the completed plan weeks (the current, partial week is
 * left out on both sides so a mid-week read is not a shortfall). Both sides
 * run the same impulse-response walk with the same starting rule
 * (mtlEmaSeries), so a plan-compliant athlete reads exactly 1. The actual side
 * equals computeMTLFitnessFatigue at the last completed week.
 *
 * Reads below 1 when completed load fell short of the prescription. It cannot
 * exceed 1 on plan sessions alone: completed MTL counts plan sessions only
 * (isMtlSessionCompleted), and a session the athlete adds joins the plan.
 *
 * Withheld behind computeMtlAcwr's history guard. The race projection's
 * "Training fitness" factor and the staleness model's MTL mitigation signal
 * read this one computation.
 */
export function computeMtlChronicVsPlan(weeks: Week[], currentWeekIndex: number): MtlChronicVsPlan {
  const completedWeeks = completedPlanWeeks(weeks, currentWeekIndex);
  if (mtlHistoryTooShort(completedWeeks)) {
    return { ratio: null, actual: 0, prescribed: 0, completedWeeks, reason: 'history' };
  }
  const last = completedWeeks - 1;
  const actual = mtlEmaSeries(weeks, last, computeWeekActualMTL)[last]?.mtlCTL ?? 0;
  const prescribed = mtlEmaSeries(weeks, last, computeWeekMTL)[last]?.mtlCTL ?? 0;
  if (prescribed <= 0) return { ratio: null, actual, prescribed, completedWeeks, reason: 'noPlan' };
  return { ratio: actual / prescribed, actual, prescribed, completedWeeks, reason: 'ok' };
}

/** computeMtlChronicVsPlan for the current week of a HYROX plan; null in every other mode. */
export function hyroxMtlChronicVsPlan(s: SimulatorState): MtlChronicVsPlan | null {
  if (s.eventType !== 'hyrox') return null;
  return computeMtlChronicVsPlan(s.wks ?? [], Math.max(0, (s.w ?? 1) - 1));
}

export interface MtlAdherence {
  /** actual MTL chronic load ÷ plan-expected, for the completed week. < 1 = behind. */
  ratio: number;
  pctOfPlanned: number;
  plannedMTL: number;
  actualMTL: number;
  valid: boolean;
}

/**
 * HYROX mirror of `resolveCtlAdherence` (running). One-step MTL-gap: did the completed week's
 * actual musculo-tendon load keep up with what the plan prescribed? The ratio re-anchors next
 * week's `effectiveHours` down when behind (plan_engine.hyrox → ctlGapMultiplier).
 *
 * Self-contained, weekly-unit throughout (unlike computeMTLFitnessFatigue, which returns daily ÷7):
 * the seed is the completed-only chronic MTL EMA across all weeks BEFORE the completed week, so the
 * shared seed weighting (~85%) gives the same gentle one-week / compounding behaviour as running.
 * HYROX converges because `effectiveHours` drives both duration AND the generated MTL, so a reduced
 * week lowers next week's planned MTL too. HYROX-only guard mirrors the running mode guard.
 */
export function resolveMtlAdherence(s: SimulatorState, completedWeek: number): MtlAdherence {
  const neutral: MtlAdherence = { ratio: 1, pctOfPlanned: 100, plannedMTL: 0, actualMTL: 0, valid: false };
  if (s.eventType !== 'hyrox' || !s.wks) return neutral;
  if (completedWeek < 1 || completedWeek > s.wks.length) return neutral;
  const wk = s.wks[completedWeek - 1] as any;
  // Excused: injury detrains on its own curve, a silently-advanced gap is already handled, and a
  // taper week must not be re-anchored down before a race. Mirrors the running resolver's guards.
  if (wk?.injuryState?.active || wk?.detrainApplied || wk?.ph === 'taper') return neutral;

  const plannedMTL = computeWeekMTL(wk);
  if (plannedMTL <= 0) return neutral;
  const actualMTL = computeWeekActualMTL(wk);

  // Prior-week chronic MTL seed in weekly units (completed-only EMA, same constant as
  // computeMTLFitnessFatigue but without the ÷7 daily normalisation).
  const CTL_DECAY = Math.exp(-7 / 42);
  let seed = 0;
  for (let i = 0; i < completedWeek - 1; i++) {
    seed = seed * CTL_DECAY + computeWeekActualMTL(s.wks[i]) * (1 - CTL_DECAY);
  }

  const ratio = ctlAdherenceRatio(seed, plannedMTL, actualMTL);
  const pctOfPlanned = Math.max(0, Math.round((actualMTL / plannedMTL) * 100));
  return { ratio, pctOfPlanned, plannedMTL, actualMTL, valid: true };
}
