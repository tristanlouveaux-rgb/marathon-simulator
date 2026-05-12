import type { TrainingPhase } from '@/types';

/**
 * Phase assignment for training plans. Replaces the legacy "<=16w single arc,
 * >16w block-cycle prefix" model with a single rule that scales coherently from
 * 4-week sharpening blocks up to 50-week double-periodization arcs.
 *
 * Science basis: see docs/SCIENCE_LOG.md (Plan Phasing).
 *   - Single-arc caps reflect canonical mesocycle limits (Bompa & Buzzichelli 2018,
 *     Pfitzinger & Douglas 2009, Daniels 2014): taper ≤ 3w, peak ≤ 4w, build ≤ 8w.
 *   - Double periodization for ≥33-week plans matches the annual-periodization
 *     structure described in Issurin (2010) and observed in Tønnessen et al. (2014).
 *
 * Format-specific configs (running, triathlon, hyrox) override the defaults via
 * `PhaseConfig` to reflect each format's mesocycle norms. See `RUNNING_CONFIG`
 * here and `triathlon-constants.ts:TRI_PHASE_CONFIGS` /
 * `hyrox-constants.ts:HYROX_PHASE_CONFIG`.
 */

export interface PlanPhaseWeek {
  ph: TrainingPhase;
  /** True for the time-trial week at the end of cycle 1 (double-periodization plans only). */
  checkpoint?: boolean;
}

/**
 * Configurable knobs for the phase-assignment strategy. Different formats
 * (running / triathlon / hyrox) use different caps and ratios; the algorithm
 * structure is the same.
 */
export interface PhaseConfig {
  // Phase caps (single-arc)
  taperCap: number;
  peakCap: number;
  buildCap: number;
  // Phase ratios (used before caps kick in)
  taperRatio: number;
  peakRatio: number;
  buildRatio: number;
  // Double periodization
  doublePeriodizationThreshold: number; // plan length at which 2 cycles kick in
  cycle2Fraction: number;               // fraction of totalWeeks allocated to cycle 2
  transitionWeeks: number;              // taper-labelled weeks between cycles
  // Cycle 1 internal proportions
  cycle1PeakCap: number;
  cycle1BuildCap: number;
  cycle1PeakRatio: number;
  cycle1BuildRatio: number;
  // Minimum cycle sizes
  cycle1Min: number;
  cycle2Min: number;
}

export const RUNNING_PHASE_CONFIG: PhaseConfig = {
  taperCap: 3,
  peakCap: 4,
  buildCap: 8,
  taperRatio: 0.12,
  peakRatio: 0.10,
  buildRatio: 0.40,
  doublePeriodizationThreshold: 33,
  cycle2Fraction: 0.55,
  transitionWeeks: 2,
  cycle1PeakCap: 3,
  cycle1BuildCap: 6,
  cycle1PeakRatio: 0.18,
  cycle1BuildRatio: 0.35,
  cycle1Min: 8,
  cycle2Min: 12,
};

/**
 * Compute the phase (and optional checkpoint flag) for every week of a plan.
 * Returned array length === totalWeeks. Index i is plan week i+1.
 */
export function computePlanPhases(
  totalWeeks: number,
  config: PhaseConfig = RUNNING_PHASE_CONFIG,
): PlanPhaseWeek[] {
  if (totalWeeks <= 0) return [];

  if (totalWeeks >= config.doublePeriodizationThreshold) {
    return computeDoublePeriodization(totalWeeks, config);
  }

  return computeSingleArc(totalWeeks, config).map(ph => ({ ph }));
}

/**
 * Single-arc phase split: Base → Build → Peak → Taper.
 * - Taper: capped per config
 * - Peak: capped per config
 * - Build: capped per config (beyond cap, athletes plateau)
 * - Base: absorbs the remainder (long base is correct training science)
 *
 * Very short plans (4–7 weeks) naturally collapse base to 0–2 weeks via these
 * ratios, producing a "sharpening block" with no real aerobic-development phase —
 * which is the honest answer: you cannot build fitness in a month.
 */
function computeSingleArc(totalWeeks: number, cfg: PhaseConfig): TrainingPhase[] {
  if (totalWeeks <= 0) return [];

  const taperWeeks = Math.min(cfg.taperCap, Math.max(1, Math.ceil(totalWeeks * cfg.taperRatio)));
  const peakWeeks  = Math.min(cfg.peakCap,  Math.max(1, Math.round(totalWeeks * cfg.peakRatio)));
  const buildWeeks = Math.min(cfg.buildCap, Math.max(1, Math.round(totalWeeks * cfg.buildRatio)));
  const baseWeeks  = Math.max(0, totalWeeks - buildWeeks - peakWeeks - taperWeeks);

  const phases: TrainingPhase[] = [];
  for (let i = 0; i < baseWeeks; i++) phases.push('base');
  for (let i = 0; i < buildWeeks; i++) phases.push('build');
  for (let i = 0; i < peakWeeks; i++) phases.push('peak');
  for (let i = 0; i < taperWeeks; i++) phases.push('taper');

  if (phases.length === totalWeeks) return phases;
  if (phases.length > totalWeeks) return phases.slice(0, totalWeeks);
  while (phases.length < totalWeeks) phases.unshift('base');
  return phases;
}

/**
 * Double-periodization: two cycles for plans ≥ config.doublePeriodizationThreshold.
 * - Cycle 1 (preparation): Base → Build → Peak ending in a Checkpoint (TT) week
 * - Inter-cycle taper: configurable count of reduced-volume weeks
 *   ("intra-cycle recovery", Mujika & Padilla 2003). Labelled `'taper'` so the
 *   workout generator's existing taper-phase volume drop fires automatically.
 * - Cycle 2 (race-specific): full Base → Build → Peak → Taper arc into the race
 *
 * Cycle 2 carries the race so it gets the larger fraction.
 */
function computeDoublePeriodization(totalWeeks: number, cfg: PhaseConfig): PlanPhaseWeek[] {
  const cycle2Length = Math.max(cfg.cycle2Min, Math.round(totalWeeks * cfg.cycle2Fraction));
  const cycle1Length = Math.max(cfg.cycle1Min, totalWeeks - cycle2Length - cfg.transitionWeeks);

  const c1Peak  = Math.min(cfg.cycle1PeakCap,  Math.max(1, Math.round(cycle1Length * cfg.cycle1PeakRatio)));
  const c1Build = Math.min(cfg.cycle1BuildCap, Math.max(1, Math.round(cycle1Length * cfg.cycle1BuildRatio)));
  const c1Base  = Math.max(0, cycle1Length - c1Build - c1Peak);

  const cycle2Phases = computeSingleArc(cycle2Length, cfg);

  const phases: PlanPhaseWeek[] = [];
  for (let i = 0; i < c1Base; i++) phases.push({ ph: 'base' });
  for (let i = 0; i < c1Build; i++) phases.push({ ph: 'build' });
  for (let i = 0; i < c1Peak; i++) {
    const isLastPeak = i === c1Peak - 1;
    phases.push(isLastPeak ? { ph: 'peak', checkpoint: true } : { ph: 'peak' });
  }
  for (let i = 0; i < cfg.transitionWeeks; i++) phases.push({ ph: 'taper' });
  for (const ph of cycle2Phases) phases.push({ ph });

  if (phases.length > totalWeeks) return phases.slice(0, totalWeeks);
  while (phases.length < totalWeeks) phases.push({ ph: 'base' });
  return phases;
}
