/**
 * Per-discipline fitness model for triathlon.
 *
 * Maintains independent CTL/ATL/TSB tracks for swim, bike, and run, plus a
 * combined CTL derived from the transfer matrix and COMBINED_CTL_WEIGHTS
 * (§18.3). All three disciplines share the same time constants (42-day CTL,
 * 7-day ATL) — Banister 1975, same as running mode.
 *
 * **Side of the line**: tracking. The model describes where fitness is given
 * the activities that have happened.
 */

import type { SimulatorState } from '@/types/state';
import type { Discipline, PerDisciplineFitness } from '@/types/triathlon';
import { CTL_TAU_DAYS, ATL_TAU_DAYS } from '@/constants/triathlon-constants';
import { COMBINED_CTL_WEIGHTS, sportToTransferSource, transferWeight, type TransferSourceSport } from '@/constants/transfer-matrix';

/**
 * Record of an activity contributing to fitness. Generic across all sports —
 * feed the transfer matrix to fan out to per-discipline contributions.
 */
export interface FitnessContribution {
  sport: TransferSourceSport;       // Source activity sport
  rawTSS: number;                    // Signal B — real physiological TSS
  dayIndex: number;                  // 0 = today, 1 = yesterday, ... (for decay)
}

/**
 * Exponential decay factor for a given time constant and lag in days.
 * f = e^(-lag/tau). Same shape as Banister 1975.
 */
function decay(lagDays: number, tau: number): number {
  return Math.exp(-lagDays / tau);
}

/**
 * Compute per-discipline fitness (CTL, ATL, TSB) and a combined CTL from a
 * list of weighted contributions.
 */
export function computePerDisciplineFitness(contributions: FitnessContribution[]): {
  swim: PerDisciplineFitness;
  bike: PerDisciplineFitness;
  run:  PerDisciplineFitness;
  combinedCtl: number;
} {
  const disciplines: Discipline[] = ['swim', 'bike', 'run'];

  // Accumulate weighted sums per discipline for CTL (42d) and ATL (7d).
  const acc: Record<Discipline, { ctlSum: number; atlSum: number }> = {
    swim: { ctlSum: 0, atlSum: 0 },
    bike: { ctlSum: 0, atlSum: 0 },
    run:  { ctlSum: 0, atlSum: 0 },
  };

  for (const c of contributions) {
    const ctlDecay = decay(c.dayIndex, CTL_TAU_DAYS);
    const atlDecay = decay(c.dayIndex, ATL_TAU_DAYS);
    for (const d of disciplines) {
      const w = transferWeight(c.sport, d);
      if (w <= 0) continue;
      const contribution = c.rawTSS * w;
      acc[d].ctlSum += contribution * ctlDecay;
      acc[d].atlSum += contribution * atlDecay;
    }
  }

  // Normalise: CTL is a weekly-equivalent EMA (TrainingPeaks convention) —
  // we divide by τ (42 or 7) and multiply by 7 so the output equals weekly TSS.
  const normalise = (sum: number, tau: number) => (sum / tau) * 7;

  const swim: PerDisciplineFitness = finaliseFitness(acc.swim, normalise);
  const bike: PerDisciplineFitness = finaliseFitness(acc.bike, normalise);
  const run:  PerDisciplineFitness = finaliseFitness(acc.run,  normalise);

  const combinedCtl =
    swim.ctl * COMBINED_CTL_WEIGHTS.swim +
    bike.ctl * COMBINED_CTL_WEIGHTS.bike +
    run.ctl  * COMBINED_CTL_WEIGHTS.run;

  return { swim, bike, run, combinedCtl: Math.round(combinedCtl * 10) / 10 };
}

function finaliseFitness(
  sums: { ctlSum: number; atlSum: number },
  normalise: (sum: number, tau: number) => number
): PerDisciplineFitness {
  const ctl = Math.round(normalise(sums.ctlSum, CTL_TAU_DAYS) * 10) / 10;
  const atl = Math.round(normalise(sums.atlSum, ATL_TAU_DAYS) * 10) / 10;
  const tsb = Math.round((ctl - atl) * 10) / 10;
  return { ctl, atl, tsb };
}

/**
 * Per-discipline ACWR. Ratio of ATL (acute) to CTL (chronic). 0.8–1.3 is safe
 * (Gabbett 2016). Returns undefined when CTL is too small to be meaningful.
 */
export function perDisciplineACWR(fit: PerDisciplineFitness): number | undefined {
  if (fit.ctl < 10) return undefined;
  return Math.round((fit.atl / fit.ctl) * 100) / 100;
}

/**
 * Read a state's tri fitness snapshot, or a zeroed fallback if none exists.
 */
export function readTriFitness(state: SimulatorState): {
  swim: PerDisciplineFitness;
  bike: PerDisciplineFitness;
  run:  PerDisciplineFitness;
  combinedCtl: number;
} {
  const f = state.triConfig?.fitness;
  if (!f) {
    return {
      swim: { ctl: 0, atl: 0, tsb: 0 },
      bike: { ctl: 0, atl: 0, tsb: 0 },
      run:  { ctl: 0, atl: 0, tsb: 0 },
      combinedCtl: 0,
    };
  }
  return { swim: f.swim, bike: f.bike, run: f.run, combinedCtl: f.combinedCtl };
}

/**
 * Rebuild fitness from an activity log. Expected shape: activities with a
 * sport label, rawTSS (Signal B), and a date. Returns the fresh fitness
 * structure ready to write back to state.triConfig.fitness.
 */
export function rebuildTriFitnessFromActivities(
  activities: Array<{ sport?: string; rawTSS?: number; dateISO: string }>,
  referenceDateISO: string
): ReturnType<typeof computePerDisciplineFitness> {
  const refTs = Date.parse(referenceDateISO);
  const contributions: FitnessContribution[] = [];
  for (const a of activities) {
    if (!a.rawTSS || a.rawTSS <= 0) continue;
    const aTs = Date.parse(a.dateISO);
    if (!Number.isFinite(aTs)) continue;
    const dayIndex = Math.floor((refTs - aTs) / 86400000);
    if (dayIndex < 0 || dayIndex > 120) continue;  // 120-day window covers 42d CTL safely
    contributions.push({
      sport: sportToTransferSource(a.sport),
      rawTSS: a.rawTSS,
      dayIndex,
    });
  }
  return computePerDisciplineFitness(contributions);
}
