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

    const newReps = repCount(reps);
    const est = estimate1RM(weightKg, newReps);
    if (est > 0) {
      const newEst = Math.round(est * 10) / 10;
      // 1RM estimates inflate with reps and are not comparable across rep
      // schemes (Epley is only valid near the load tested — a 12-rep set's
      // estimate routinely exceeds a heavier 5-rep set's). Advance the 1RM
      // benchmark + trend history ONLY on a comparable-or-stronger effort: reps
      // <= the prior best's reps AND a higher estimate. A higher-rep day still
      // updates working-weight memory (above) but does not move the benchmark or
      // mint a false PR. First observation sets the baseline. See SCIENCE_LOG §BD.
      const prevEst = entry.est1rmKg;
      const prevReps = entry.est1rmReps;
      const comparable = prevReps == null || (Number.isFinite(newReps) && newReps <= prevReps);
      if (prevEst == null || (comparable && newEst > prevEst)) {
        entry.est1rmKg = newEst;
        entry.est1rmReps = Number.isFinite(newReps) ? newReps : undefined;
        entry.est1rmSource = 'derived';
        entry.est1rmUpdatedAt = date;
        appendEst1rmSample(entry, newEst, Number.isFinite(newReps) ? newReps : undefined);
      }
    }

    log.lifts[key] = entry;
    wrote = true;
  }

  if (wrote) state.strengthLog = log;
  return wrote;
}

/**
 * Seed (or correct) a lift's estimated-1RM from a manual entry on the Stats
 * strength page. The athlete supplies EITHER a direct 1RM (caller passes
 * `reps = 1`) OR a working weight x reps (caller passes the real reps); both
 * land here as a (weightKg, reps) pair and we Epley-derive the 1RM the same way
 * a logged set does. Marked `est1rmSource: 'user'`.
 *
 * Manual entry is authoritative: it overwrites whatever was there (the user is
 * stating their current number), unlike the auto-derive path which only
 * advances. A later logged set still overrides this via the est1rmReps gate in
 * persistStrengthLifts (provenance flips back to 'derived' on a comparable PR).
 *
 * `lastWeightKg` / `lastReps` are seeded too so future workout prescriptions can
 * target a real load instead of the "@X% 1RM" placeholder.
 */
export function seedManualLift(
  state: SimulatorState,
  opts: { key: string; displayName: string; weightKg: number; reps: number },
): boolean {
  const { key, displayName, weightKg, reps } = opts;
  if (!key || !(weightKg > 0) || !(reps > 0)) return false;
  // A 1-rep effort IS the 1RM — don't run Epley (which returns w*(1+1/30) at
  // reps=1 and would inflate a directly-entered max by ~3%). Only weight x reps
  // gets the Epley estimate.
  const est = reps === 1 ? weightKg : estimate1RM(weightKg, reps);
  if (!(est > 0)) return false;
  const newEst = Math.round(est * 10) / 10;
  const date = todayISO();

  const log: StrengthLog = state.strengthLog ?? { lifts: {} };
  if (!log.lifts) log.lifts = {};

  const entry: StrengthLiftEntry = log.lifts[key] ?? { key, displayName, lastDate: date };
  entry.displayName = displayName || entry.displayName;
  // Working-weight memory is seeded ONLY from a real working set (weight x reps).
  // A direct 1RM is not a working weight — seeding lastWeightKg=1RM would make the
  // next session prescribe "Last: <1RM> x 1" and bump from a max. For a pure 1RM we
  // set the benchmark only and leave any existing working-weight memory untouched.
  if (reps > 1) {
    entry.lastWeightKg = weightKg;
    entry.lastReps = String(reps);
  }
  entry.lastDate = date;
  entry.est1rmKg = newEst;
  entry.est1rmReps = reps;
  entry.est1rmSource = 'user';
  entry.est1rmUpdatedAt = date;
  appendEst1rmSample(entry, newEst, reps);

  log.lifts[key] = entry;
  state.strengthLog = log;
  return true;
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
      sets: group.length,   // working sets logged for this exercise (for tonnage)
      estimatedOneRmKg: est > 0 ? Math.round(est * 10) / 10 : undefined,
      liftKey: weighted.liftKey,
    });
  }
  return out.length ? out : undefined;
}
