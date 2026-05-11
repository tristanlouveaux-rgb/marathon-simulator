/**
 * Race-readiness aggregator — wraps `specificEndurancePenalty` per-discipline
 * results into a single shape the UI consumes.
 *
 * Used by:
 *   - `race-readiness-card.ts` (forecast page summary)
 *   - `race-readiness-detail.ts` (drill-down detail view)
 *   - `race-prediction.triathlon.ts` (applies penalties to leg times)
 */

import type { SimulatorState } from '@/types/state';
import type { TriathlonDistance } from '@/types/triathlon';
import {
  computeDisciplineReadiness,
  type DisciplineReadiness,
} from './specific-endurance-penalty';
import { CROSS_DISCIPLINE_TRANSFER, type ReadinessDiscipline } from '@/constants/race-readiness-targets';

/**
 * Default closure window when distance-specific value isn't supplied (legacy
 * call sites + safety fallback). Per-distance `closureWeeks` lives in
 * `RACE_READINESS_TARGETS` — that's the canonical value for production use.
 */
const READINESS_CLOSURE_REFERENCE_WEEKS = 12;

/**
 * Compute the per-discipline share of the readiness penalty that *remains*
 * on the projected race-day prediction. Drives the "race tomorrow" vs
 * "race in 6 months" distinction.
 *
 * **Multiplicative time × dose model.** Time and dose are *independent
 * dimensions* — they don't substitute for each other. Each saturates
 * separately, then they multiply:
 *
 *   timeFactor = 1 - exp(-weeksRemaining / (closureWeeks/3))
 *     - Saturating exponential. Reaches ~95% at `closureWeeks` weeks.
 *     - Captures: adaptation needs TIME. You can't safely ramp to target
 *       volume in 1 week even with maximum commitment (Pfitzinger 10% rule).
 *     - Independent of how many sessions/wk you're planning.
 *
 *   doseFactor = min(1, plannedSessions / refSessions)
 *     - Linear up to reference, capped at 1.0.
 *     - Captures: commitment ceiling. Above-target sessions don't deliver
 *       extra adaptation; below-target sessions never reach full readiness
 *       no matter how long you train.
 *     - Independent of weeksRemaining.
 *
 *   closure = timeFactor × doseFactor
 *   share   = 1 - closure   (penalty share that remains on race-day projection)
 *
 * **Why multiplicative not additive/single-product.** A previous formula
 * collapsed time × dose into a single `power` value, making "12 weeks at
 * half-dose" mathematically equivalent to "6 weeks at full-dose". They're
 * not equivalent physiologically:
 *   - 12w at half-dose: time to ramp + adapt, but never hits target volume
 *     → plateaus below ready
 *   - 6w at full-dose: hits target volume but no time to safely ramp
 *     → also incomplete, but for a different reason
 * Multiplicative captures: BOTH dimensions must be present for full closure.
 *
 * **Comparison table for IM (closureWeeks=12)**:
 *
 *   12w + 5/wk (full dose) → time 0.95, dose 1.0, closure 0.95, share  5%
 *   12w + 2.5/wk (half)    → time 0.95, dose 0.5, closure 0.48, share 52%
 *   6w  + 5/wk (full)      → time 0.78, dose 1.0, closure 0.78, share 22%
 *   6w  + 2.5/wk (half)    → time 0.78, dose 0.5, closure 0.39, share 61%
 *   2w  + 5/wk (full)      → time 0.39, dose 1.0, closure 0.39, share 61%
 *   24w + 5/wk             → time 1.00, dose 1.0, closure 1.00, share  0%
 *
 * Per-discipline because the same `weeksRemaining` but different commitment
 * per discipline gives different per-leg projections. A user committing to
 * bike volume but neglecting run gets bike penalty closed faster than run.
 *
 * @param weeksRemaining     Weeks until race day
 * @param plannedSessions    User's planned sessions/wk for THIS discipline
 * @param refSessions        Reference sessions/wk for this discipline at
 *                           intermediate level (from horizon-params)
 * @param closureWeeks       Weeks of full-dose training needed to fully
 *                           close a maximum penalty. Per-distance from
 *                           `RACE_READINESS_TARGETS[distance].closureWeeks`.
 *                           Defaults to 12 if omitted.
 */
export interface ProjectionPenaltyInputs {
  /** Weeks until race day. */
  weeksRemaining: number;
  /** User's planned sessions/wk for THIS discipline (`plannedSessionsPerWeekByDiscipline`). */
  plannedSessions: number;
  /** Reference sessions/wk for this discipline at intermediate level. */
  refSessions: number;
  /** Weeks of full-dose training to fully close a max penalty (per-distance). */
  closureWeeks?: number;
  /** Per-discipline taper duration (subtracted from usefulWeeks). */
  taperWeeks?: number;
  /**
   * User's planned hours/wk for THIS discipline (`plannedHoursPerWeekByDiscipline`).
   * Optional — when supplied, the dose factor uses the geometric mean of
   * session-ratio AND hours-ratio. This captures that 5 short bike sessions
   * ≠ 5 long bike sessions: same session count, very different volume. When
   * omitted, falls back to session-count-only.
   */
  plannedHours?: number;
  /** Reference hours/wk for this discipline at intermediate level. */
  refHours?: number;
  /**
   * Athlete's current readiness score for this discipline (0-100). When
   * supplied, scales the closure window by the gap size — a near-ready
   * athlete (score=80) needs fewer weeks to close than a far-from-ready one
   * (score=20). `effectiveClosureWeeks = closureWeeks × sqrt(1 - score/100)`.
   * Omitted → uses full closureWeeks (legacy behaviour, equivalent to
   * assuming worst-case gap).
   */
  currentScore?: number;
}

export function computeProjectionPenaltyShare(
  weeksRemainingOrInputs: number | ProjectionPenaltyInputs,
  plannedSessions?: number,
  refSessions?: number,
  closureWeeks: number = READINESS_CLOSURE_REFERENCE_WEEKS,
  taperWeeks: number = 0,
): number {
  // Backwards-compat positional signature OR new object signature.
  const inputs: ProjectionPenaltyInputs = typeof weeksRemainingOrInputs === 'object'
    ? weeksRemainingOrInputs
    : {
        weeksRemaining: weeksRemainingOrInputs,
        plannedSessions: plannedSessions ?? 0,
        refSessions: refSessions ?? 0,
        closureWeeks,
        taperWeeks,
      };

  const {
    weeksRemaining,
    plannedSessions: pSess,
    refSessions: rSess,
    closureWeeks: cWeeks = READINESS_CLOSURE_REFERENCE_WEEKS,
    taperWeeks: tWeeks = 0,
    plannedHours,
    refHours,
    currentScore,
  } = inputs;

  if (rSess <= 0) return 0; // safety — no target = no closure to compute
  if (weeksRemaining <= 0) return 1.0; // race today/tomorrow → full penalty stays
  if (pSess <= 0) return 1.0; // zero training is categorical, not gradient

  // Useful build time = weeksRemaining minus taper. Taper weeks build freshness
  // (already captured separately via the horizon's `taper_bonus`), not raw
  // endurance volume. Subtracting them from the closure timeFactor recognises
  // that "1 week to race" is functionally taper, not training. Without this:
  // a 1-week-out IM showed ~14 min faster on the run leg from "training" that
  // can't actually happen (you don't ramp volume in race week).
  const usefulWeeks = Math.max(0, weeksRemaining - tWeeks);

  // Gap-aware closure window: a near-ready athlete needs fewer weeks to close
  // than one starting far from ready. Scales the effective closure window by
  // sqrt(gap fraction) — sqrt because closure is non-linear (last few percent
  // are easier than the first 50%). Without currentScore, falls back to
  // worst-case full window (legacy behaviour). For score=80 → effective
  // window = closureWeeks × 0.45; score=20 → × 0.89; score=0 → × 1.0.
  let effectiveClosureWeeks = cWeeks;
  if (currentScore != null && currentScore > 0) {
    const gapFraction = Math.max(0, Math.min(1, 1 - currentScore / 100));
    effectiveClosureWeeks = cWeeks * Math.sqrt(gapFraction);
  }

  // Time factor: saturating exponential on USEFUL weeks. tau = effectiveClosureWeeks/3
  // means timeFactor reaches ~95% at the gap-adjusted closure window.
  const tau = Math.max(0.1, effectiveClosureWeeks / 3);
  const timeFactor = 1 - Math.exp(-usefulWeeks / tau);

  // Dose factor combines session count AND weekly hours when both are
  // available — geometric mean so both dimensions must be present. Captures
  // that 5 short bike sessions ≠ 5 long bike sessions (same session count,
  // half the volume → half the dose factor). When hours data isn't supplied,
  // fall back to session-count-only (legacy behaviour).
  const sessionRatio = Math.min(1, pSess / rSess);
  let doseFactor: number;
  if (plannedHours != null && refHours != null && refHours > 0) {
    const hoursRatio = Math.min(1, plannedHours / refHours);
    doseFactor = Math.sqrt(sessionRatio * hoursRatio);
  } else {
    doseFactor = sessionRatio;
  }

  const closure = timeFactor * doseFactor;
  return Math.max(0, Math.min(1, 1 - closure));
}

export interface RaceReadinessResult {
  swim: DisciplineReadiness;
  bike: DisciplineReadiness;
  run: DisciplineReadiness;
  /**
   * Overall readiness score (0-100). Weighted by discipline duration share
   * — run weighted highest in IM (run leg dominates fatigue), bike highest
   * in 70.3 (bike is longest leg). Weighting per Friel 2018 race-time
   * decomposition tables.
   */
  overallScore: number;
  /** UI band label for the overall score. */
  overallLabel: string;
  overallTone: 'ok' | 'caution' | 'warn';
}

/**
 * Compute per-discipline + overall race-readiness for a triathlon race.
 *
 * **Two-pass with cross-discipline transfer.**
 *   1. First pass: compute each discipline's raw readiness from its own
 *      volume + longest signals.
 *   2. Second pass: apply `CROSS_DISCIPLINE_TRANSFER` matrix — credit each
 *      discipline's volumeRatio with fractional contributions from the OTHER
 *      disciplines' raw volumeRatios. Captures shared cardiac/aerobic-base
 *      adaptations across modalities (Bassett & Howley 2000) while respecting
 *      mode-specific endurance limits (Tanaka 1995, Mutton 1993). Bike→Run
 *      gets the largest transfer (~30%); swim contributes least to others.
 *
 * Standalone running mode should call `computeDisciplineReadiness` directly
 * with `discipline='run'` and the appropriate distance — no need for the
 * tri-shaped wrapper.
 */
export function computeTriRaceReadiness(
  state: SimulatorState,
  distance: TriathlonDistance,
): RaceReadinessResult {
  // First pass: raw readiness per discipline (no transfers)
  const rawSwim = computeDisciplineReadiness(state, 'swim', distance);
  const rawBike = computeDisciplineReadiness(state, 'bike', distance);
  const rawRun  = computeDisciplineReadiness(state, 'run',  distance);
  const rawByDisc = { swim: rawSwim, bike: rawBike, run: rawRun };

  // Second pass: apply transfer credits to volumeRatios, recompute readiness.
  // For each target discipline, sum: own raw volumeRatio + transfer × other-
  // discipline raw volumeRatios. Cap at 1.2 (matches base ratio cap).
  const applyTransfer = (target: ReadinessDiscipline): number => {
    const matrixRow = CROSS_DISCIPLINE_TRANSFER;
    let credit = 0;
    for (const from of ['swim', 'bike', 'run'] as ReadinessDiscipline[]) {
      const transferFactor = matrixRow[from][target];
      credit += transferFactor * rawByDisc[from].volumeRatio;
    }
    // `credit` already includes own contribution at 1.0× transfer (matrix
    // diagonal = 1.0), so this IS the new volumeRatio (capped).
    return Math.min(1.2, credit);
  };

  const swim = computeDisciplineReadiness(state, 'swim', distance, {
    volumeRatioOverride: applyTransfer('swim'),
  });
  const bike = computeDisciplineReadiness(state, 'bike', distance, {
    volumeRatioOverride: applyTransfer('bike'),
  });
  const run  = computeDisciplineReadiness(state, 'run',  distance, {
    volumeRatioOverride: applyTransfer('run'),
  });

  // Discipline weights for the overall score. Approximates each leg's share
  // of total race time at intermediate level — bike dominates time, run
  // dominates fatigue/perception, swim is shortest. Friel 2018 averaged.
  // Sprint/Olympic share weights with 70.3 (run share rises with distance).
  const weights = distance === 'ironman'
    ? { swim: 0.10, bike: 0.55, run: 0.35 }
    : { swim: 0.12, bike: 0.55, run: 0.33 };

  const overallScore = Math.round(
    swim.score * weights.swim +
    bike.score * weights.bike +
    run.score  * weights.run,
  );

  // Map overall score to the same band labels as per-discipline.
  const band =
    overallScore >= 90 ? { label: 'Race ready',    tone: 'ok' as const } :
    overallScore >= 70 ? { label: 'On track',      tone: 'ok' as const } :
    overallScore >= 50 ? { label: 'Building',      tone: 'caution' as const } :
    overallScore >= 30 ? { label: 'Underprepared', tone: 'warn' as const } :
                         { label: 'Not ready',     tone: 'warn' as const };

  return {
    swim, bike, run,
    overallScore,
    overallLabel: band.label,
    overallTone: band.tone,
  };
}
