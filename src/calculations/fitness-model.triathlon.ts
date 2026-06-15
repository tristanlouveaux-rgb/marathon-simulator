/**
 * Per-discipline fitness model for triathlon.
 *
 * Maintains independent CTL/ATL/TSB tracks for swim, bike, and run, plus a
 * combined CTL derived from the transfer matrix and COMBINED_CTL_WEIGHTS
 * (§18.3). All three disciplines share the same time constants (42-day CTL,
 * 7-day ATL). Banister 1975, same as running mode.
 *
 * **Side of the line**: tracking. The model describes where fitness is given
 * the activities that have happened.
 */

import type { SimulatorState, Week } from '@/types/state';
import type { Discipline, PerDisciplineFitness } from '@/types/triathlon';
import { CTL_TAU_DAYS, ATL_TAU_DAYS } from '@/constants/triathlon-constants';
import { sportToTransferSource, transferWeight, type TransferSourceSport } from '@/constants/transfer-matrix';
import { ctlAdherenceRatio } from '@/calculations/fitness-model';

/**
 * Record of an activity contributing to fitness. Generic across all sports —
 * feed the transfer matrix to fan out to per-discipline contributions.
 */
export interface FitnessContribution {
  sport: TransferSourceSport;       // Source activity sport
  rawTSS: number;                    // Signal B. Real physiological TSS
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
  const acc: Record<Discipline, { ctlSum: number; atlSum: number; directCount: number }> = {
    swim: { ctlSum: 0, atlSum: 0, directCount: 0 },
    bike: { ctlSum: 0, atlSum: 0, directCount: 0 },
    run:  { ctlSum: 0, atlSum: 0, directCount: 0 },
  };

  // Combined CTL (and ATL) is the raw EMA across ALL activities without
  // transfer weighting. This is the honest total-fatigue number. Every
  // activity contributes at full weight regardless of sport, so padel, gym,
  // hiking etc. all count toward combined even though they only contribute
  // partially to swim/bike/run CTLs. (§8 feedback, 2026-04-24.)
  let combinedCtlSum = 0;

  for (const c of contributions) {
    const ctlDecay = decay(c.dayIndex, CTL_TAU_DAYS);
    const atlDecay = decay(c.dayIndex, ATL_TAU_DAYS);

    // Per-discipline: apply transfer matrix.
    for (const d of disciplines) {
      const w = transferWeight(c.sport, d);
      if (w <= 0) continue;
      const contribution = c.rawTSS * w;
      acc[d].ctlSum += contribution * ctlDecay;
      acc[d].atlSum += contribution * atlDecay;
      // Only count as a direct activity when this sport IS this discipline (weight 1.0)
      if (w === 1.0) acc[d].directCount++;
    }

    // Combined: raw contribution at full weight (no matrix). Every activity
    // adds to combined fatigue at 1.0 regardless of sport.
    combinedCtlSum += c.rawTSS * ctlDecay;
  }

  // Normalise: CTL is a weekly-equivalent EMA (TrainingPeaks convention) —
  // we divide by τ (42 or 7) and multiply by 7 so the output equals weekly TSS.
  const normalise = (sum: number, tau: number) => (sum / tau) * 7;

  const swim: PerDisciplineFitness = finaliseFitness(acc.swim, normalise);
  const bike: PerDisciplineFitness = finaliseFitness(acc.bike, normalise);
  const run:  PerDisciplineFitness = finaliseFitness(acc.run,  normalise);

  const combinedCtl = normalise(combinedCtlSum, CTL_TAU_DAYS);

  return { swim, bike, run, combinedCtl: Math.round(combinedCtl * 10) / 10 };
}

function finaliseFitness(
  sums: { ctlSum: number; atlSum: number; directCount: number },
  normalise: (sum: number, tau: number) => number
): PerDisciplineFitness {
  const ctl = Math.round(normalise(sums.ctlSum, CTL_TAU_DAYS) * 10) / 10;
  const atl = Math.round(normalise(sums.atlSum, ATL_TAU_DAYS) * 10) / 10;
  const tsb = Math.round((ctl - atl) * 10) / 10;
  return { ctl, atl, tsb, directCount: sums.directCount };
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

// ─── Per-discipline load-gap re-anchor (triathlon mirror of running's CTL-gap) ──────────────────

export interface TriDisciplineAdherence {
  valid: boolean;
  /** Only disciplines that fell BEHIND (ratio < 1) appear, so the generator scales just those. */
  byDiscipline: { swim?: number; bike?: number; run?: number };
  pctByDiscipline: { swim?: number; bike?: number; run?: number };
}

/**
 * Sum a week's prescribed per-discipline tri load (aerobic + anaerobic). `matchedOnly` restricts to
 * completed sessions — that is the "actual": the prescribed load of the sessions the athlete
 * actually did (a completion signal, exactly like HYROX's computeWeekActualMTL). Illness/holiday-
 * rested sessions are excluded so legitimate rest never reads as a miss (mirror getPlannedDayTSSContext).
 */
function sumTriDisciplineLoad(wk: Week | undefined, d: Discipline, matchedOnly: boolean): number {
  const ws = (wk as any)?.triWorkouts ?? [];
  let sum = 0;
  for (const w of ws) {
    if ((w.discipline ?? 'run') !== d) continue;
    if (matchedOnly && !w.matchedActivityId) continue;
    const rested = w.illnessSeverity === 'resting' || ((w.illnessMod || w.holidayMod) && (w.rpe ?? w.r) === 0);
    if (rested) continue;
    sum += (w.aerobic ?? 0) + (w.anaerobic ?? 0);
  }
  return sum;
}

/**
 * Triathlon mirror of `resolveCtlAdherence` — PER DISCIPLINE. After a completed week, for each of
 * swim/bike/run, a one-step ratio of completed vs prescribed load (seeded from the prior weeks'
 * completed load, same CTL_DECAY damping) re-anchors next week's per-discipline durations
 * (applyTriEffortMultipliers → ctlGapMultiplier). Per-discipline because a tri athlete can keep up
 * on the bike while skipping every swim — a combined ratio would wrongly cut the bike.
 *
 * No baseline-contamination temp-clear is needed (cf. running): the tri re-anchor scales DURATION,
 * never aerobic/anaerobic, so the load summed here is always the un-reduced prescription. Converges
 * because completing the (shorter) prescribed sessions matches them, lifting the ratio back to ~1.
 */
export function resolveTriDisciplineAdherence(s: SimulatorState, completedWeek: number): TriDisciplineAdherence {
  const neutral: TriDisciplineAdherence = { valid: false, byDiscipline: {}, pctByDiscipline: {} };
  if (s.eventType !== 'triathlon' || !s.wks) return neutral;
  if (completedWeek < 1 || completedWeek > s.wks.length) return neutral;
  const wk = s.wks[completedWeek - 1] as any;
  // Excused weeks: injury / silent-advance gap / taper (don't re-anchor race prep). Mirrors running.
  if (wk?.injuryState?.active || wk?.detrainApplied || wk?.ph === 'taper') return neutral;

  const CTL_DECAY = Math.exp(-7 / 42);
  const disciplines: Discipline[] = ['swim', 'bike', 'run'];
  const byDiscipline: { swim?: number; bike?: number; run?: number } = {};
  const pctByDiscipline: { swim?: number; bike?: number; run?: number } = {};
  let valid = false;

  for (const d of disciplines) {
    const planned = sumTriDisciplineLoad(wk, d, false);
    if (planned <= 0) continue; // discipline not prescribed this week — nothing to fall behind on
    valid = true; // the week has a tri plan, so we have a verdict (even if on-track) — clears stale stamps
    const actual = sumTriDisciplineLoad(wk, d, true);
    let seed = 0;
    for (let i = 0; i < completedWeek - 1; i++) {
      seed = seed * CTL_DECAY + sumTriDisciplineLoad(s.wks[i], d, true) * (1 - CTL_DECAY);
    }
    const ratio = ctlAdherenceRatio(seed, planned, actual);
    pctByDiscipline[d] = Math.max(0, Math.round((actual / planned) * 100));
    if (ratio < 1) byDiscipline[d] = ratio; // reduce-only: store just the disciplines that are behind
  }

  return { valid, byDiscipline, pctByDiscipline };
}
