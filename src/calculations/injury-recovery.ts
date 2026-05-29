/**
 * Injury-aware recovery math, shared by the running and triathlon predictors.
 *
 * A current injury costs the athlete only the disciplines they have restricted,
 * and only until each one's captured resume week. We debit each discipline its
 * own recovery weeks of effective build time. A blocked discipline (capacity 0)
 * loses its whole window; a reduced one (e.g. bike at 50%) loses only the
 * fraction it cannot train, so it still banks partial build.
 *
 * This is the SAME formula the triathlon predictor has always used; lifting it
 * here keeps running and triathlon in parity (CLAUDE.md "Mirror rule").
 * See SCIENCE_LOG "Injury-aware projection".
 */

import type { InjuryState } from '@/types/injury';
import { getDisciplineCapacity, type DisciplineKey } from '@/injury/engine';

/** Per-discipline recovery state read off a current injury. */
export interface DisciplineRecovery {
  /** Weeks until the discipline returns to full, clamped to the race horizon.
   *  0 = unrestricted or no captured window (legacy state). */
  resumeWeeks: number;
  /** Current capacity 0–100. 0 = blocked, 1–99 = reduced, 100 = full. */
  capacity: number;
}

/**
 * Recovery info owed to a current injury for one discipline.
 * Returns the no-restriction value (resumeWeeks 0, capacity 100) when there is
 * no active injury or no captured resume window for the discipline.
 */
export function disciplineRecovery(
  inj: InjuryState | undefined,
  disc: DisciplineKey,
  weeksRemaining: number,
): DisciplineRecovery {
  if (!inj?.active || !inj.resumeWeeksByDiscipline) return { resumeWeeks: 0, capacity: 100 };
  const w = inj.resumeWeeksByDiscipline[disc];
  return {
    resumeWeeks: typeof w === 'number' && w > 0 ? Math.min(w, weeksRemaining) : 0,
    capacity: getDisciplineCapacity(inj, disc),
  };
}

/** Build-time debit (weeks) for a discipline: full window when blocked,
 *  fractional when still trainable at reduced capacity. */
export function recoveryDebitWeeks(r: DisciplineRecovery): number {
  return r.resumeWeeks * (1 - Math.max(0, Math.min(100, r.capacity)) / 100);
}

/**
 * Effective build weeks for one discipline after debiting injury recovery.
 * Use this to feed a forecast horizon so the projection builds from the return
 * date instead of crediting build during weeks the athlete cannot train.
 * Never negative; 0 means the discipline is blocked for the whole horizon.
 */
export function injuryAdjustedBuildWeeks(
  inj: InjuryState | undefined,
  disc: DisciplineKey,
  weeksRemaining: number,
): number {
  const rec = disciplineRecovery(inj, disc, weeksRemaining);
  return Math.max(0, weeksRemaining - recoveryDebitWeeks(rec));
}
