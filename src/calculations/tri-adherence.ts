/**
 * Per-discipline plan adherence. Drives the horizon adjuster's
 * adherence-penalty input. Mirrors the marathon `calculateAdherencePenalty`
 * (`src/calculations/predictions.ts:22`) but split per discipline so a missed
 * long swim does not penalise the bike projection.
 *
 * **Side of the line**: tracking. Pure functions over `state.wks`.
 *
 * Penalty curve (matches marathon shape):
 *   - +0.5% per missed long session in the discipline
 *   - +0.3% per missed quality session in the discipline
 *   - +2.0% additional if overall adherence in the discipline is below 80%
 *
 * The result is subtracted from each horizon adjuster's `improvement_pct`
 * before bounds are applied.
 */

import type { SimulatorState } from '@/types/state';
import type { Workout } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { wasIllnessRestDay } from './illness-rules';

/** ISO 'YYYY-MM-DD' date `days` after `iso` (noon-UTC to dodge DST/timezone). */
function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export interface DisciplineAdherenceSummary {
  plannedSessions: number;
  completedSessions: number;
  missedLongSessions: number;
  missedQualitySessions: number;
  /** completedSessions / plannedSessions, 0–1. 1.0 if no planned sessions. */
  ratio: number;
  /** % to subtract from `improvement_pct` in the horizon adjuster. */
  penaltyPct: number;
}

export type TriAdherence = Record<Discipline, DisciplineAdherenceSummary>;

const QUALITY_TYPE_KEYWORDS = [
  'threshold',
  'vo2',
  'tempo',
  'sweet_spot',
  'sweetspot',
  'speed',
  'race_pace',
  'intervals',
  'hills',
];

const LONG_TYPE_KEYWORDS = ['long', 'endurance'];

function isQuality(workout: Workout): boolean {
  const t = (workout.t ?? '').toLowerCase();
  return QUALITY_TYPE_KEYWORDS.some(k => t.includes(k));
}

function isLong(workout: Workout): boolean {
  const t = (workout.t ?? '').toLowerCase();
  if (LONG_TYPE_KEYWORDS.some(k => t.includes(k))) return true;
  // Long session by duration: bike ≥ 120 min, run ≥ 90 min, swim ≥ 60 min.
  const min = workout.estimatedDurationMin ?? 0;
  if (workout.discipline === 'bike' && min >= 120) return true;
  if (workout.discipline === 'run' && min >= 90)  return true;
  if (workout.discipline === 'swim' && min >= 60) return true;
  return false;
}

function emptySummary(): DisciplineAdherenceSummary {
  return {
    plannedSessions: 0,
    completedSessions: 0,
    missedLongSessions: 0,
    missedQualitySessions: 0,
    ratio: 1.0,
    penaltyPct: 0,
  };
}

/**
 * Compute per-discipline adherence over the last `weeks` completed weeks.
 * The current week (`wks[s.w - 1]`, `s.w` is 1-based) is excluded. It's still
 * in progress.
 */
export function computeTriAdherence(
  state: SimulatorState,
  weeks: number = 4,
): TriAdherence {
  const out: TriAdherence = {
    swim: emptySummary(),
    bike: emptySummary(),
    run:  emptySummary(),
  };

  const wks = state.wks ?? [];
  // The last completed week is wks[s.w - 2], as plan-adherence.triathlon.ts
  // reads it.
  const lastCompletedIdx = (state.w ?? 1) - 2;
  const startWeek = Math.max(0, lastCompletedIdx - weeks + 1);
  const illness = (state as any).illnessState;
  const planStart = state.planStartDate;

  for (let w = lastCompletedIdx; w >= startWeek; w--) {
    const wk = wks[w];
    const planned = wk?.triWorkouts;
    if (!planned) continue;
    const weekStart = planStart ? addDaysISO(planStart, w * 7) : null;

    for (const workout of planned) {
      const disc = workout.discipline;
      // Only tri disciplines (swim/bike/run) have adherence summary slots.
      if (!disc || disc === 'station' || disc === 'brick' || disc === 'erg') continue;
      const summary = out[disc as Discipline];
      if (!summary) continue;

      // Illness-rested sessions don't count for OR against adherence (the
      // banner promises rest is unpenalised). Exclude them entirely rather than
      // counting a no-show as a completion.
      if (weekStart && illness?.schedule?.length && typeof workout.dayOfWeek === 'number'
          && wasIllnessRestDay(illness, addDaysISO(weekStart, workout.dayOfWeek))) {
        continue;
      }

      summary.plannedSessions += 1;
      const skipped = workout.status === 'skipped';
      if (!skipped) {
        summary.completedSessions += 1;
      } else {
        if (isLong(workout)) summary.missedLongSessions += 1;
        else if (isQuality(workout)) summary.missedQualitySessions += 1;
      }
    }
  }

  for (const disc of ['swim', 'bike', 'run'] as Discipline[]) {
    const summary = out[disc];
    summary.ratio = summary.plannedSessions > 0
      ? summary.completedSessions / summary.plannedSessions
      : 1.0;

    let penalty = 0;
    penalty += summary.missedLongSessions * 0.5;
    penalty += summary.missedQualitySessions * 0.3;
    if (summary.plannedSessions > 0 && summary.ratio < 0.80) penalty += 2.0;
    summary.penaltyPct = penalty;
  }

  return out;
}
