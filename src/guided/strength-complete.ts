/**
 * Mode-agnostic strength-session completion. Writes `wk.rated[workoutId] = rpe`
 * via the existing `rate()` function (events.ts) — the field every mode's plan
 * view reads to render "done". Passing `expected === rpe` makes `rate()` skip
 * its running-specific VDOT adjustment, so a gym RPE never moves a runner's
 * VDOT.
 *
 * Beyond marking the slot done, completion now LOGS the session as a completed
 * activity in `wk.garminActuals` so it appears on the shared activity log and
 * carries its physiological load into the model (previously a quick "mark done"
 * gym session contributed zero TSS — only synced gym sessions counted). The log
 * entry:
 *   - stores the worked muscle groups (for the post-session "Worked" chips),
 *   - uses a `guided-…` garminId so a later watch/Strava sync UPGRADES it with
 *     HR instead of double-logging (mirrors the HYROX guided-upgrade path), and
 *   - auto-attaches HR if a matching synced activity is already pending review,
 *     falling back to the manual "Match heart rate" picker on the summary card.
 *
 * Used by:
 * - the quick "Mark as done" action on any strength card / modal, and
 * - the guided-session finish (passes the user's 1-tap RPE + measured duration).
 *
 * HYROX sessions keep their dedicated benchmark-learning + recap path.
 */

import type { Workout } from '@/types';
import type { GarminActual, SimulatorState, Week } from '@/types/state';
import { rate } from '@/ui/events';
import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { applyHyroxSessionBenchmarks, buildHyroxSessionRecap } from '@/calculations/hyrox-session-benchmarks';
import { parseStrengthSession } from './strength-model';
import { deriveWorkedMuscleGroups, type WorkedMuscleGroup } from '@/calculations/strength-muscle-groups';
import type { SetRecord } from './strength-controller';
import { persistStrengthLifts, summariseLoggedLifts } from './strength-log-persist';
import { persistBodyweightProgress } from '@/calculations/bodyweight-progression';
import type { TrainingPhase } from '@/types/training';
import { snapshotNotifiedStrengthPrs } from '@/calculations/strength-marker-bumps';
import { deriveStrengthLegLoad, buildStrengthLegLoadEntry, dropSupersededStrengthEntries } from '@/calculations/strength-leg-load';

export interface CompleteStrengthOpts {
  /** RPE the user actually rated; defaults to the workout's prescribed RPE so
   *  the quick "Mark as done" path produces no VDOT shift (expected === rpe). */
  rpe?: number;
  /** Actually-measured session duration in seconds, when available (e.g. from
   *  the guided overlay's elapsed clock). Falls back to the prescribed estimate. */
  durationSec?: number;
  /** Target week (1-based). Defaults to the current week. */
  targetWeek?: number;
  /** Per-set / per-station time records captured by the guided overlay. For
   *  HYROX workouts these feed `stationBenchmarkHistory` so the prediction
   *  model picks up the measured times. */
  records?: SetRecord[];
}

/** What completion produced, so the UI can open the post-session summary card
 *  without re-reading state. `actual` is the logged activity (null for HYROX,
 *  which uses its own recap). */
export interface StrengthCompletionResult {
  workoutId: string;
  weekIdx: number;
  rpe: number;
  durationSec: number;
  muscleGroups: WorkedMuscleGroup[];
  actual: GarminActual | null;
  /** True when an already-synced HR activity was auto-linked at completion. */
  hrAutoMatched: boolean;
  isHyrox: boolean;
}

export function completeStrengthSession(workout: Workout, opts: CompleteStrengthOpts = {}): StrengthCompletionResult {
  const id = String((workout as any).id ?? workout.n);
  const prescribed = (workout.rpe ?? (workout as any).r ?? 5) as number;
  const chosen = typeof opts.rpe === 'number' ? opts.rpe : prescribed;
  const type = workout.t || 'gym';

  // `expected === chosen` => rpeDif=0 => no VDOT/efficiency change for gym.
  rate(id, workout.n, chosen, chosen, type, false, undefined, opts.targetWeek);

  const state = getMutableState();
  const weekIdx = (opts.targetWeek ?? state.w) - 1;

  // Prescribed estimate is the duration fallback when nothing was measured.
  const estSec = (workout.estimatedDurationMin ?? 0) * 60;
  const durationSec = Math.max(0, Math.round(opts.durationSec && opts.durationSec > 0 ? opts.durationSec : estSec));

  if (durationSec > 0) {
    // eslint-disable-next-line no-console
    console.log(`[strength] completed ${workout.n}: ${Math.round(durationSec / 60)} min, RPE ${chosen}`);
  }

  const isHyrox = Array.isArray((workout as any).hyroxComponents) && (workout as any).hyroxComponents.length > 0;

  // ── HYROX: dedicated benchmark-learning + recap path (unchanged) ──────────
  if (isHyrox) {
    let dirty = false;
    if (opts.records && opts.records.length) {
      const applied = applyHyroxSessionBenchmarks(workout, opts.records, state);
      if (applied.length) {
        dirty = true;
        for (const u of applied) {
          // eslint-disable-next-line no-console
          console.log(`[hyrox session-bench] ${u.displayName}: ${u.fromSec ?? '—'}s → ${u.toSec}s (best round beat the benchmark)`);
        }
      }
      if (logGuidedHyroxActivity(workout, opts.records, durationSec, opts.targetWeek, state)) dirty = true;
    }
    if (dirty) saveState();
    const wk = state.wks?.[weekIdx];
    return {
      workoutId: id, weekIdx, rpe: chosen, durationSec,
      muscleGroups: [], actual: wk?.garminActuals?.[id] ?? null,
      hrAutoMatched: false, isHyrox: true,
    };
  }

  // ── Standard gym / strength session ───────────────────────────────────────
  const session = parseStrengthSession(workout);
  const muscleGroups = session ? deriveWorkedMuscleGroups(session) : [];

  const wk = state.wks?.[weekIdx];
  const result: StrengthCompletionResult = {
    workoutId: id, weekIdx, rpe: chosen, durationSec,
    muscleGroups, actual: null, hrAutoMatched: false, isHyrox: false,
  };
  if (!wk) return result;

  const { actual, hrAutoMatched } = logGuidedStrengthActivity(
    workout, id, durationSec, chosen, muscleGroups.map(g => g.group), wk,
  );
  result.actual = actual;
  result.hrAutoMatched = hrAutoMatched;

  // Stamp the per-lift breakdown onto the activity so a past gym session shows
  // what was hit and at what weight (independent of the rolling per-lift memory).
  const loggedLifts = summariseLoggedLifts(opts.records);
  if (loggedLifts && actual) actual.loggedLifts = loggedLifts;

  // Derive the session's leg load and feed it into the shared leg-fatigue ledger
  // (`recentLegLoads`) so a heavy leg day suppresses readiness the same way a long
  // run does. Stamp the raw value on the actual so the reconcile sweep
  // (sport-picker-modal.ts) reads the same number. Leg-group score × %1RM × RPE;
  // an upper/core day scores 0 and writes nothing. See strength-leg-load.ts.
  if (actual) {
    const { raw } = deriveStrengthLegLoad(muscleGroups, loggedLifts, chosen);
    if (raw > 0) {
      actual.legLoadRaw = raw;
      const rawTs = actual.startTime ? Date.parse(actual.startTime) : Date.now();
      const ts = Number.isFinite(rawTs) ? rawTs : Date.now();
      // Drop any prior entry for this same activity (re-completion reusing the id)
      // AND any strength entry within ±10 min (re-completion that minted a fresh
      // `guided-{ts}` id, or a duplicate the reconcile sweep would later collapse).
      // Same ±10-min same-sport rule reconcileRecentLegLoads uses, so a re-rate
      // updates the one entry instead of stacking a second. Run/cross-training
      // entries are untouched (RBE then applies against them correctly).
      const prior = dropSupersededStrengthEntries(state.recentLegLoads ?? [], actual.garminId, ts);
      const entry = buildStrengthLegLoadEntry(actual, prior, ts);
      if (entry) {
        state.recentLegLoads = [...prior, entry];
        // eslint-disable-next-line no-console
        console.log(`[strength] leg load ${raw.toFixed(1)} → recentLegLoads (${entry.rbeProtected ? 'RBE-discounted' : 'full'})`);
      }
    }
  }

  // Persist the working weights the user entered (guided overlay merges them
  // onto the records; quick "Mark as done" synthesises records with weights).
  const wroteWeights = persistStrengthLifts(opts.records, state);
  // Advance the beginner/novice bodyweight ladder from the same RIR feedback that
  // drives the weight bump. Bodyweight movements have no liftKey, so they were
  // previously dropped; this remembers a rung per movement family instead.
  const bwPhase = state.wks?.[(state.w ?? 1) - 1]?.ph as TrainingPhase | undefined;
  if (!state.bodyweightProgress) state.bodyweightProgress = {};
  persistBodyweightProgress(opts.records ?? [], state.bodyweightProgress, bwPhase, new Date().toISOString().slice(0, 10));
  // Snapshot the PR baseline at completion so the launch toast can't re-surface
  // a PR the summary card already showed (the card detects new bests from the
  // est1RM history, independent of this snapshot).
  if (wroteWeights) snapshotNotifiedStrengthPrs(state);

  saveState();
  return result;
}

/**
 * Reconstruct a StrengthCompletionResult for an ALREADY-logged session, reading
 * the stored `garminActual` rather than re-completing. Lets a tapped "Logged"
 * strength card open the same recap (openStrengthSummary) the user saw at
 * completion, instead of the Start/Mark-done overlay. Pure: never mutates state.
 * Returns null when nothing is logged at this slot (caller falls back to the
 * editable detail view).
 */
export function buildLoggedStrengthResult(workout: Workout, weekIdx: number): StrengthCompletionResult | null {
  const id = String((workout as any).id ?? workout.n);
  const state = getMutableState();
  const wk = state.wks?.[weekIdx];
  const actual = wk?.garminActuals?.[id] ?? null;
  const isHyrox = Array.isArray((workout as any).hyroxComponents) && (workout as any).hyroxComponents.length > 0;
  const session = parseStrengthSession(workout);
  const muscleGroups = session ? deriveWorkedMuscleGroups(session) : [];
  const rpe = (actual?.rpe ?? workout.rpe ?? (workout as any).r ?? 5) as number;
  const durationSec = actual?.durationSec && actual.durationSec > 0
    ? actual.durationSec
    : Math.round((workout.estimatedDurationMin ?? 0) * 60);
  return { workoutId: id, weekIdx, rpe, durationSec, muscleGroups, actual, hrAutoMatched: false, isHyrox };
}

/**
 * Write (or preserve) the completed strength session in `wk.garminActuals`.
 *
 * - A richer SYNCED actual already at this slot wins — we don't clobber it.
 * - Otherwise, look for an already-pending synced activity with HR for the same
 *   day (auto-match): if exactly one clear candidate exists, consume it (attach
 *   its HR/zones, mark it matched, drop it from pending) so the log entry has
 *   real HR. If zero or several, write a `guided-` entry with no HR — the user
 *   can attach one via the summary card's "Match heart rate" picker, or a later
 *   sync will upgrade it.
 */
function logGuidedStrengthActivity(
  workout: Workout,
  workoutId: string,
  durationSec: number,
  rpe: number,
  muscleGroups: string[],
  wk: Week,
): { actual: GarminActual; hrAutoMatched: boolean } {
  if (!wk.garminActuals) wk.garminActuals = {};
  const existing = wk.garminActuals[workoutId];

  // A synced (non-guided) actual already present is richer — keep it, just make
  // sure it carries the muscle-group summary.
  if (existing && !String(existing.garminId).startsWith('guided-')) {
    if (muscleGroups.length && !existing.workedMuscleGroups) existing.workedMuscleGroups = muscleGroups;
    return { actual: existing, hrAutoMatched: false };
  }

  const candidate = findCompletionHRMatch(wk);

  const actual: GarminActual = candidate
    ? {
        garminId: candidate.garminId,
        startTime: candidate.startTime,
        distanceKm: (candidate.distanceM ?? 0) / 1000,
        durationSec: candidate.durationSec > 0 ? candidate.durationSec : durationSec,
        avgPaceSecKm: null,
        avgHR: candidate.avgHR,
        maxHR: candidate.maxHR,
        calories: candidate.calories ?? null,
        iTrimp: candidate.iTrimp ?? null,
        hrZones: candidate.hrZones ?? null,
        activityType: candidate.activityType || 'STRENGTH_TRAINING',
        plannedType: workout.t ?? null,
        rpe,
        workoutName: workout.n,
        displayName: workout.n,
        workedMuscleGroups: muscleGroups.length ? muscleGroups : undefined,
      }
    : {
        garminId: `guided-${Date.now()}`,
        startTime: new Date().toISOString(),
        distanceKm: 0,
        durationSec,
        avgPaceSecKm: null,
        avgHR: null,
        maxHR: null,
        calories: null,
        activityType: 'STRENGTH_TRAINING',
        plannedType: workout.t ?? null,
        rpe,
        workoutName: workout.n,
        displayName: workout.n,
        workedMuscleGroups: muscleGroups.length ? muscleGroups : undefined,
      };

  wk.garminActuals[workoutId] = actual;

  // Consume the auto-matched pending item so it isn't queued for review or
  // counted twice.
  if (candidate) {
    if (!wk.garminMatched) wk.garminMatched = {};
    wk.garminMatched[candidate.garminId] = workoutId;
    wk.garminPending = (wk.garminPending ?? []).filter(p => p.garminId !== candidate.garminId);
  }

  return { actual, hrAutoMatched: !!candidate };
}

/**
 * Find a single unambiguous pending strength activity to auto-link at
 * completion: a gym-type pending item that carries HR. Returns it only when
 * exactly one such candidate exists (so an ambiguous day falls back to manual).
 */
function findCompletionHRMatch(wk: Week) {
  const candidates = (wk.garminPending ?? []).filter(
    p => p.appType === 'gym' && p.avgHR != null && p.avgHR > 0,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Write a guided HYROX session to `wk.garminActuals` as a completed activity.
 * `garminId` is `'guided-…'` so the matcher can tell it apart from a synced
 * activity and upgrade it later. Does not clobber an existing richer (synced)
 * actual. Returns true if it wrote.
 */
function logGuidedHyroxActivity(
  workout: Workout,
  records: SetRecord[],
  durationSec: number,
  targetWeek: number | undefined,
  state: SimulatorState,
): boolean {
  const recap = buildHyroxSessionRecap(workout, records);
  if (!recap) return false; // non-HYROX or nothing measured

  const weekIdx = (targetWeek ?? state.w) - 1;
  const wk = state.wks?.[weekIdx];
  if (!wk) return false;

  const workoutId = (workout as any).id ?? workout.n;
  if (!wk.garminActuals) wk.garminActuals = {};
  const existing = wk.garminActuals[workoutId];
  // A synced activity (non-guided garminId) already present wins — don't overwrite.
  if (existing && !String(existing.garminId).startsWith('guided-')) return false;

  const distanceKm = recap.runs.reduce((sum, r) => sum + r.distanceM / 1000, 0);
  wk.garminActuals[workoutId] = {
    garminId: `guided-${Date.now()}`,
    startTime: new Date().toISOString(),
    distanceKm,
    durationSec: Math.max(0, Math.round(durationSec)),
    avgPaceSecKm: null,
    avgHR: null,
    maxHR: null,
    calories: null,
    activityType: 'hyrox',
    plannedType: workout.t ?? null,
    workoutName: workout.n,
    displayName: workout.n,
    hyroxSession: recap,
  };
  return true;
}
