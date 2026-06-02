/**
 * Strength progression logic. Pure functions, no state access.
 *
 * Two jobs:
 *  1. `estimate1RM` — Epley estimate from a working set, the basis for the
 *     per-lift est1RM benchmark and trend chart.
 *  2. `suggestNextWeight` — the phase-aware ramp. Strength serves the endurance
 *     plan: weight only climbs in base/build, and only when the last session
 *     left reps in reserve. Peak holds; taper/deload holds; injury suppresses.
 *
 * Science (see SCIENCE_LOG, Strength Tracking):
 *  - Epley 1957: 1RM = w * (1 + reps/30). Rep term capped at EPLEY_REP_CAP (12)
 *    because the linear approximation degrades above ~10-12 reps.
 *  - RIR autoregulation (Helms et al. 2016): >=2 reps in reserve is the cue
 *    that load can rise. "About right" / "barely" hold.
 *  - 2.5% linear step, rounded to a real plate jump (STRENGTH_MIN_INCREMENT_KG).
 */

import type { TrainingPhase } from '@/types/training';
import type { RirBucket } from '@/types/strength-log';
import {
  STRENGTH_PROGRESSION_PCT,
  STRENGTH_MIN_INCREMENT_KG,
  EPLEY_REP_CAP,
} from '@/constants/strength-constants';

/** Epley estimated 1RM (kg). Returns 0 for non-positive / unparseable input. */
export function estimate1RM(weightKg: number, reps: number): number {
  if (!(weightKg > 0) || !(reps > 0)) return 0;
  const r = Math.min(reps, EPLEY_REP_CAP);
  return weightKg * (1 + r / 30);
}

/** Round a weight to the nearest achievable plate jump (2.5 kg granularity). */
export function plateRound(kg: number): number {
  return Math.round(kg / STRENGTH_MIN_INCREMENT_KG) * STRENGTH_MIN_INCREMENT_KG;
}

export interface NextWeightArgs {
  lastWeightKg: number;
  lastRir: RirBucket | undefined;
  phase: TrainingPhase;
  /** taper or a forced/scheduled deload week. */
  isDeload: boolean;
  /** Injury-strength decision kind for the session. */
  injuryKind: 'normal' | 'none' | 'adapted';
}

export interface NextWeightSuggestion {
  /** Suggested working weight for next session (kg). */
  weightKg: number;
  /** True only when we actually bumped above last weight. */
  changed: boolean;
  reason: 'bump' | 'hold' | 'suppressed';
}

/**
 * Phase-gated next-weight suggestion. The gating order encodes "strength yields
 * to the run/tri plan":
 *  - injury (adapted or paused) -> suppressed, hold last weight
 *  - peak -> hold (maintenance, no new fatigue)
 *  - taper / deload -> hold (the plan already cuts strength volume; we don't
 *    auto-strip weight)
 *  - base / build + "reps left" (>=2 RIR) -> bump 2.5%, min one plate
 *  - otherwise hold
 */
export function suggestNextWeight(a: NextWeightArgs): NextWeightSuggestion {
  const hold = (reason: NextWeightSuggestion['reason']): NextWeightSuggestion => ({
    weightKg: a.lastWeightKg,
    changed: false,
    reason,
  });

  if (!(a.lastWeightKg > 0)) return hold('hold');
  if (a.injuryKind !== 'normal') return hold('suppressed');
  if (a.phase === 'peak') return hold('hold');
  if (a.isDeload || a.phase === 'taper') return hold('hold');

  const building = a.phase === 'base' || a.phase === 'build';
  if (building && a.lastRir === 'reps-left') {
    const raw = a.lastWeightKg * STRENGTH_PROGRESSION_PCT;
    const inc = Math.max(STRENGTH_MIN_INCREMENT_KG, plateRound(raw));
    return { weightKg: a.lastWeightKg + inc, changed: true, reason: 'bump' };
  }
  return hold('hold');
}
