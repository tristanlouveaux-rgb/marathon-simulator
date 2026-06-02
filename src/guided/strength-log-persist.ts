/**
 * Persist working weights from a completed strength session into the per-lift
 * memory (`state.strengthLog`). Tracking only: records the actual kg + reps the
 * user lifted and the Epley estimated-1RM, and appends to the est1RM history
 * that powers the trend chart. The phase-aware progression SUGGESTION is
 * computed on demand at display time (it depends on the current week's phase),
 * not here.
 *
 * Weight + RIR are merged onto the SetRecords by the guided overlay (the
 * controller stays weight-agnostic so HYROX can reuse it). HYROX never reaches
 * here — completeStrengthSession returns on its own branch first.
 */

import type { SimulatorState, GarminActual } from '@/types/state';
import type { StrengthLog, StrengthLiftEntry } from '@/types/strength-log';
import type { SetRecord } from './strength-controller';
import { estimate1RM } from '@/calculations/strength-progression';
import { appendEst1rmSample } from '@/calculations/strength-log-history';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Lowest integer rep count from a reps string ("8", "8 each leg" -> 8). */
function repCount(reps: string): number {
  const m = String(reps).match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

/**
 * Upsert each trackable, weight-bearing exercise from `records` into
 * `state.strengthLog`. Returns true when anything was written (so the caller
 * can decide to saveState). Records without a `liftKey` or `weightKg` are
 * skipped — bodyweight / plyometric / isometric movements and un-entered lifts.
 */
export function persistStrengthLifts(records: SetRecord[] | undefined, state: SimulatorState): boolean {
  if (!records || !records.length) return false;

  // Group by exercise. Weight is per-exercise; RIR is the final set's bucket.
  const byExercise = new Map<number, SetRecord[]>();
  for (const r of records) {
    if (!r.liftKey) continue;
    const list = byExercise.get(r.exerciseIndex) ?? [];
    list.push(r);
    byExercise.set(r.exerciseIndex, list);
  }
  if (byExercise.size === 0) return false;

  const log: StrengthLog = state.strengthLog ?? { lifts: {} };
  if (!log.lifts) log.lifts = {};
  let wrote = false;

  for (const group of byExercise.values()) {
    const key = group[0].liftKey!;
    const weighted = group.find(r => typeof r.weightKg === 'number' && r.weightKg! > 0);
    if (!weighted) continue; // user skipped weight entry for this lift

    const weightKg = weighted.weightKg!;
    const reps = weighted.reps || group[0].reps;
    const rir = [...group].reverse().find(r => r.rirBucket)?.rirBucket;
    const date = todayISO();

    const entry: StrengthLiftEntry = log.lifts[key] ?? {
      key,
      displayName: weighted.exerciseName,
      lastWeightKg: weightKg,
      lastReps: reps,
      lastDate: date,
    };
    entry.displayName = weighted.exerciseName || entry.displayName;
    entry.lastWeightKg = weightKg;
    entry.lastReps = reps;
    entry.lastRir = rir;
    entry.lastDate = date;

    const est = estimate1RM(weightKg, repCount(reps));
    if (est > 0) {
      entry.est1rmKg = Math.round(est * 10) / 10;
      entry.est1rmSource = 'derived';
      entry.est1rmUpdatedAt = date;
      appendEst1rmSample(entry, entry.est1rmKg);
    }

    log.lifts[key] = entry;
    wrote = true;
  }

  if (wrote) state.strengthLog = log;
  return wrote;
}

/**
 * Summarise the weighted lifts in a completed session for the activity record,
 * so a past gym session can show "what you hit and what weights" independent of
 * the rolling per-lift memory. One entry per trackable exercise that has a
 * weight; bodyweight / non-trackable movements are omitted.
 */
export function summariseLoggedLifts(records: SetRecord[] | undefined): GarminActual['loggedLifts'] {
  if (!records || !records.length) return undefined;
  const byExercise = new Map<number, SetRecord[]>();
  for (const r of records) {
    if (!r.liftKey) continue;
    const list = byExercise.get(r.exerciseIndex) ?? [];
    list.push(r);
    byExercise.set(r.exerciseIndex, list);
  }
  const out: NonNullable<GarminActual['loggedLifts']> = [];
  for (const group of byExercise.values()) {
    const weighted = group.find(r => typeof r.weightKg === 'number' && r.weightKg! > 0);
    if (!weighted) continue;
    const reps = weighted.reps || group[0].reps;
    const est = estimate1RM(weighted.weightKg!, repCount(reps));
    out.push({
      exerciseName: weighted.exerciseName,
      weightKg: weighted.weightKg,
      reps,
      estimatedOneRmKg: est > 0 ? Math.round(est * 10) / 10 : undefined,
      liftKey: weighted.liftKey,
    });
  }
  return out.length ? out : undefined;
}
