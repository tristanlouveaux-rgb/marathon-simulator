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
 * accumulating — real tissue tolerance asymptotes at high loads. This mirrors
 * the Banister impulse-response saturation used in some CTL models (Busso 2003).
 *
 * Science log entry: docs/SCIENCE_LOG.md §L.
 */

import type { HyroxStation } from '@/types/triathlon';
import type { Week } from '@/types/state';
import { STATION_MTL_FACTORS, RUN_MTL_FACTORS } from '@/constants/hyrox-constants';

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
 * Sum `musculoTendonLoad` across **completed** workouts in a week (those
 * with a `matchedActivityId`). Returns 0 when no completions yet.
 *
 * Mirrors `computeWeekMTL`'s scope (all triWorkouts incl. runs) so the
 * actual / planned / chronic / acute display numbers share one source of
 * truth. Replaces the dead `hyroxConfig.weeklyActualMTL` field, which was
 * never populated despite its type comment claiming activity-match
 * computation.
 */
export function computeWeekActualMTL(wk: Week): number {
  const workouts = wk.triWorkouts ?? [];
  return workouts.reduce(
    (acc, w) => acc + (w.matchedActivityId ? (w.musculoTendonLoad ?? 0) : 0),
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

/** Discipline-split weekly MTL (actuals): only workouts with a matched
 *  activity contribute. Used by the CTL/ATL impulse-response EMAs so chronic
 *  and acute reflect completed training, mirroring running CTL/ATL behaviour. */
export function computeWeekActualMTLByDiscipline(wk: Week): DisciplineMTL {
  const workouts = wk.triWorkouts ?? [];
  let run = 0, station = 0, brick = 0;
  for (const w of workouts) {
    if (!w.matchedActivityId) continue;
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
 * Discipline-split CTL/ATL — separate impulse-response EMAs per
 * run / station / brick. Reads **completed** workouts only (those with a
 * `matchedActivityId`), mirroring how running CTL/ATL is fed by actual TSS
 * rather than planned. Returns daily-equivalent values (÷7).
 */
export function computeMTLFitnessFatigueByDiscipline(
  weeks: Week[],
  currentWeekIndex: number,
): DisciplineFitnessFatigue {
  const CTL_DECAY = Math.exp(-7 / 42);
  const ATL_DECAY = Math.exp(-7 / 7);

  let runCtl = 0, runAtl = 0, stationCtl = 0, stationAtl = 0, brickCtl = 0, brickAtl = 0;
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
 * Only workouts with a `matchedActivityId` contribute, mirroring how running
 * CTL/ATL is fed by actual TSS rather than planned. Until the user matches
 * activities, both are zero — that is correct: a fresh user has no history
 * to smooth.
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
  const CTL_DECAY = Math.exp(-7 / 42);
  const ATL_DECAY = Math.exp(-7 / 7);

  let ctl = 0;
  let atl = 0;

  const limit = Math.min(currentWeekIndex + 1, weeks.length);
  for (let i = 0; i < limit; i++) {
    const weeklyMTL = computeWeekActualMTL(weeks[i]);
    ctl = ctl * CTL_DECAY + weeklyMTL * (1 - CTL_DECAY);
    atl = atl * ATL_DECAY + weeklyMTL * (1 - ATL_DECAY);
  }

  return {
    mtlCTL: ctl / 7,
    mtlATL: atl / 7,
  };
}
