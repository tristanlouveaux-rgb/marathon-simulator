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
 */

export interface PlanPhaseWeek {
  ph: TrainingPhase;
  /** True for the time-trial week at the end of cycle 1 (double-periodization plans only). */
  checkpoint?: boolean;
}

const PHASE_CAPS = {
  taper: 3,
  peak: 4,
  build: 8,
} as const;

const DOUBLE_PERIODIZATION_THRESHOLD = 33;
const TRANSITION_WEEKS = 2;

/**
 * Compute the phase (and optional checkpoint flag) for every week of a plan.
 * Returned array length === totalWeeks. Index i is plan week i+1.
 */
export function computePlanPhases(totalWeeks: number): PlanPhaseWeek[] {
  if (totalWeeks <= 0) return [];

  if (totalWeeks >= DOUBLE_PERIODIZATION_THRESHOLD) {
    return computeDoublePeriodization(totalWeeks);
  }

  return computeSingleArc(totalWeeks).map(ph => ({ ph }));
}

/**
 * Single-arc phase split: Base → Build → Peak → Taper.
 * - Taper: capped at 3 weeks (Pfitzinger's longest)
 * - Peak: capped at 4 weeks (real peak is short)
 * - Build: capped at 8 weeks (beyond 8w of specific work, athletes plateau)
 * - Base: absorbs the remainder (long base is correct training science)
 *
 * Very short plans (4–7 weeks) naturally collapse base to 0–2 weeks via these
 * ratios, producing a "sharpening block" with no real aerobic-development phase —
 * which is the honest answer: you cannot build fitness in a month.
 */
function computeSingleArc(totalWeeks: number): TrainingPhase[] {
  if (totalWeeks <= 0) return [];

  const taperWeeks = Math.min(PHASE_CAPS.taper, Math.max(1, Math.ceil(totalWeeks * 0.12)));
  const peakWeeks = Math.min(PHASE_CAPS.peak, Math.max(1, Math.round(totalWeeks * 0.10)));
  const buildWeeks = Math.min(PHASE_CAPS.build, Math.max(1, Math.round(totalWeeks * 0.40)));
  const baseWeeks = Math.max(0, totalWeeks - buildWeeks - peakWeeks - taperWeeks);

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
 * Double-periodization: two cycles for plans ≥33 weeks.
 * - Cycle 1 (preparation): Base → Build → Peak ending in a Checkpoint (TT) week
 * - Transition: 2 easy weeks (labelled as base; load drops in the workout generator)
 * - Cycle 2 (race-specific): full Base → Build → Peak → Taper arc
 *
 * Cycle 2 is ~55% of total weeks because it carries the race; cycle 1 prepares.
 */
function computeDoublePeriodization(totalWeeks: number): PlanPhaseWeek[] {
  const cycle2Length = Math.max(12, Math.round(totalWeeks * 0.55));
  const cycle1Length = Math.max(8, totalWeeks - cycle2Length - TRANSITION_WEEKS);

  const c1Peak = Math.min(3, Math.max(1, Math.round(cycle1Length * 0.18)));
  const c1Build = Math.min(6, Math.max(1, Math.round(cycle1Length * 0.35)));
  const c1Base = Math.max(0, cycle1Length - c1Build - c1Peak);

  const cycle2Phases = computeSingleArc(cycle2Length);

  const phases: PlanPhaseWeek[] = [];
  for (let i = 0; i < c1Base; i++) phases.push({ ph: 'base' });
  for (let i = 0; i < c1Build; i++) phases.push({ ph: 'build' });
  for (let i = 0; i < c1Peak; i++) {
    const isLastPeak = i === c1Peak - 1;
    phases.push(isLastPeak ? { ph: 'peak', checkpoint: true } : { ph: 'peak' });
  }
  for (let i = 0; i < TRANSITION_WEEKS; i++) phases.push({ ph: 'base' });
  for (const ph of cycle2Phases) phases.push({ ph });

  if (phases.length > totalWeeks) return phases.slice(0, totalWeeks);
  while (phases.length < totalWeeks) phases.push({ ph: 'base' });
  return phases;
}
