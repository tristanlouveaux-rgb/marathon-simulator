/**
 * timing-check.ts
 * ================
 * Phase 7: Day-proximity → quality session downgrade (suggestion).
 *
 * When a high-load activity (Signal B ≥ 50 TSS) is completed the day before
 * a quality run (threshold, vo2, long), a suggestion mod is generated.
 *
 * The downgrade magnitude scales with prior day TSS:
 *   50–74 TSS  → 1 intensity step down, no distance cut
 *   75–99 TSS  → 1 step down + 10% shorter
 *   100–124 TSS → 2 steps down + 15% shorter
 *   125+ TSS   → 2 steps down + 25% shorter
 *
 * The distance cut shortens the main set: the total of a plain distance run
 * (floor max(3 km, reduced), never lengthened), or the work block of a structured
 * session. A warm-up or cool-down line is never cut.
 *
 * Intensity ladder (ascending): easy → marathon → threshold → vo2
 * Long run: long → marathon (1 step), long → easy (2 steps). "Long run" is the
 * long-run slot in any format (isLongRun), so the fast-finish long run uses this
 * sub-ladder too; stepped to easy, it drops its marathon-pace finish.
 * The ladder's 'marathon' rung is emitted as the canonical workout type
 * 'marathon_pace' (the key TSS_RPE_BY_TYPE, the matcher and the duration
 * estimator read).
 *
 * Mods are suggestions only. Workout unchanged until user accepts.
 * Recomputed fresh each sync from the resolved week (every accepted change already
 * applied), so they clear on reschedule and never undo an earlier cut.
 */

import type { Week, WorkoutMod } from '@/types/state';
import type { SimulatorState } from '@/types/state';
import { normalizeiTrimp } from '@/calculations/fitness-model';
import { TL_PER_MIN } from '@/constants';
import { isLongRun } from '@/workouts/long-run';
import { scaleDescriptionProportional } from '@/workouts/workout-scaling';
import { upsertWorkoutMod, modsTargetSameWorkout } from '@/workouts/workout-mods';
import { resolveWeekWorkouts } from '@/ui/week-resolve';
import {
  TIMING_MOD_PREFIX,
  TIMING_ACCEPTED_PREFIX,
  isTimingMod,
  isTimingAcceptedMod,
} from './timing-mod-reason';

export { TIMING_MOD_PREFIX, TIMING_ACCEPTED_PREFIX, isTimingMod, isTimingAcceptedMod };

const QUALITY_TYPES = new Set(['threshold', 'vo2', 'long']);
const SIGNAL_B_TRIGGER = 50;       // TSS: minimum to show any suggestion
const MIN_DISTANCE_KM  = 3;        // Floor: ~20 min including warm-up

// ─── Intensity ladder ─────────────────────────────────────────────────────────

// Ascending order: index 0 = easiest
const PACE_LADDER = ['easy', 'marathon', 'threshold', 'vo2'] as const;
type PaceType = typeof PACE_LADDER[number];

const RPE_BY_TYPE: Record<string, number> = {
  easy: 4, marathon: 6, threshold: 7, vo2: 9, long: 6,
};

/** Step a run type down the ladder by `steps`. Returns the new type string. */
function stepDown(type: string, steps: number): string {
  const idx = PACE_LADDER.indexOf(type as PaceType);
  if (idx < 0) return type; // type not in ladder (e.g. 'long' handled separately)
  return PACE_LADDER[Math.max(0, idx - steps)];
}

/** Long runs step through their own sub-ladder. */
function stepDownLong(steps: number): string {
  if (steps >= 2) return 'easy';
  return 'marathon'; // 1 step: long → marathon-effort long run
}

/** The workout type a ladder rung is written as. The ladder's 'marathon' rung is
 *  the generator's 'marathon_pace' type; every other rung is already canonical. */
function canonicalType(ladderType: string): string {
  return ladderType === 'marathon' ? 'marathon_pace' : ladderType;
}

// ─── Tier computation ─────────────────────────────────────────────────────────

interface DowngradeTier {
  steps: number;
  distReduction: number; // fraction to remove (0 = no cut)
}

function getTier(tssYesterday: number): DowngradeTier {
  if (tssYesterday >= 125) return { steps: 2, distReduction: 0.25 };
  if (tssYesterday >= 100) return { steps: 2, distReduction: 0.15 };
  if (tssYesterday >= 75)  return { steps: 1, distReduction: 0.10 };
  return                          { steps: 1, distReduction: 0 };    // 50–74
}

/**
 * Shorten a session's main set by `reduction` (a fraction), returning the new
 * description. Output keeps the generator's "<n>km" form (no space), which every
 * planned-TSS and distance parser reads.
 *
 *   - Structured session ("Wkm warm up …" / main set / "Wkm cool down …"): only the
 *     main-set line(s) are scaled, with the proportional rule the Adjust control
 *     uses (scaleDescriptionProportional: km, min and m tokens scale, paces stay).
 *     The warm-up and cool-down are left as written.
 *   - Plain distance run ("16km @ 4:50/km", "24km: last 5 @ MP"): the leading total
 *     is cut, floored at MIN_DISTANCE_KM, and never lengthened (a run already under
 *     the floor keeps its distance).
 *   - Time-based session with no warm-up line ("5×4min @ …", "20min @ …"): the whole
 *     description is the main set and is scaled.
 */
export function applyDistReduction(originalDesc: string, reduction: number): string {
  if (reduction === 0 || !originalDesc) return originalDesc;
  const factor = 1 - reduction;

  const lines = originalDesc.split('\n');
  if (lines.length >= 3 && /warm up/i.test(lines[0])) {
    const main = lines.slice(1, -1).map(l => scaleDescriptionProportional(l, factor));
    return [lines[0], ...main, lines[lines.length - 1]].join('\n');
  }

  const lead = /^(\s*)(\d+(?:\.\d+)?)\s*km/i.exec(originalDesc);
  if (lead) {
    const original = parseFloat(lead[2]);
    const reduced = Math.min(original, Math.max(MIN_DISTANCE_KM, Math.round(original * factor * 10) / 10));
    return `${lead[1]}${reduced}km${originalDesc.slice(lead[0].length)}`;
  }

  return scaleDescriptionProportional(originalDesc, factor);
}

/** The leading total distance of a description ("24km: last 5 @ MP" → "24km"). */
function leadingDistance(desc: string): string {
  const match = desc.match(/(\d+\.?\d*)\s*km/i);
  return match ? `${match[1]}km` : desc;
}

// ─── Signal B helpers ─────────────────────────────────────────────────────────

// ISSUE-263: this file used to carry its OWN RPE→TSS/min curve (a fourth
// scale, shifted ~1 RPE from the canonical table). It now reads TL_PER_MIN.

function actSignalBTSS(iTrimp: number | null | undefined, durationSec: number): number {
  if (iTrimp != null && iTrimp > 0) return normalizeiTrimp(iTrimp);
  return (durationSec / 60) * 0.92;
}

function adhocSignalBTSS(iTrimp: number | null | undefined, durationMin: number, rpe: number): number {
  if (iTrimp != null && iTrimp > 0) return normalizeiTrimp(iTrimp);
  return durationMin * (TL_PER_MIN[Math.max(1, Math.min(10, Math.round(rpe)))] ?? 0.92);
}

function dayOfWeekFromISO(isoTimestamp: string, weekStartISO: string): number {
  const actDate = new Date(isoTimestamp);
  const weekStart = new Date(weekStartISO);
  const diff = Math.floor((actDate.getTime() - weekStart.getTime()) / 86400000);
  if (diff < 0 || diff >= 7) return -1;
  // Remap to scheduler convention (0=Monday). WeekStartISO may not be a Monday
  const weekStartJsDay = weekStart.getUTCDay(); // JS: 0=Sun
  const offset = (weekStartJsDay + 6) % 7;      // Convert to 0=Mon
  return (diff + offset) % 7;
}

// ─── Day TSS map ──────────────────────────────────────────────────────────────

/**
 * Build a map of day-of-week → max Signal B TSS for all completed activities
 * (both Strava/Garmin actuals and adhoc entries).
 */
function buildDayTSSMap(wk: Week, weekStartISO: string): Map<number, number> {
  const map = new Map<number, number>();
  const add = (day: number, tss: number) => {
    if (day >= 0) map.set(day, Math.max(map.get(day) ?? 0, tss));
  };

  // Strava/Garmin matched actuals (garminId may be 'strava-XXXX'. Both sources land here)
  for (const actual of Object.values(wk.garminActuals ?? {})) {
    if (!actual.startTime) continue;
    add(dayOfWeekFromISO(actual.startTime, weekStartISO), actSignalBTSS(actual.iTrimp, actual.durationSec));
  }

  // Adhoc workouts (Strava/Garmin-synced, GPS-recorded, manually logged)
  for (const w of wk.adhocWorkouts ?? []) {
    if (w.dayOfWeek == null) continue;
    add(w.dayOfWeek, adhocSignalBTSS(w.iTrimp, (w as any).dur ?? 0, w.rpe ?? w.r ?? 5));
  }

  return map;
}

// ─── Core computation ─────────────────────────────────────────────────────────

/**
 * Compute timing suggestion mods for the given workout list.
 * Pure function. No state mutation.
 */
export function applyTimingDowngradesFromWorkouts(
  wk: Week,
  workouts: Array<{ id?: string; n: string; t: string; d?: string; dayOfWeek?: number; r?: number; rpe?: number; longRun?: boolean; originalDistance?: string }>,
  weekStartISO: string,
  prevWeek?: Week,
  prevWeekStartISO?: string,
): WorkoutMod[] {
  if (!wk || !workouts.length) return [];

  const dayTSS = buildDayTSSMap(wk, weekStartISO);

  // Carry over Sunday (day 6) TSS from previous week so Monday quality sessions see it
  if (prevWeek && prevWeekStartISO && !dayTSS.has(6)) {
    const prevMap = buildDayTSSMap(prevWeek, prevWeekStartISO);
    const sundayTSS = prevMap.get(6) ?? 0;
    if (sundayTSS > 0) dayTSS.set(6, Math.max(dayTSS.get(6) ?? 0, sundayTSS));
  }
  const rated  = wk.rated ?? {};
  const mods: WorkoutMod[] = [];

  for (const workout of workouts) {
    const id    = workout.id || workout.n;
    const wType = workout.t?.toLowerCase() ?? '';
    // The fast-finish long run is t:'progressive'. isLongRun puts it on the
    // long-run sub-ladder with the steady long run (audit X5).
    const longRun = isLongRun(workout);

    if (!QUALITY_TYPES.has(wType) && !longRun) continue;

    // Skip already-completed sessions
    const isRated = typeof rated[id] === 'number' && (rated[id] as number) > 0;
    if (isRated) continue;

    const sessionDay = workout.dayOfWeek;
    if (sessionDay == null) continue;

    const dayBefore    = (sessionDay - 1 + 7) % 7;
    const tssYesterday = dayTSS.get(dayBefore) ?? 0;
    if (tssYesterday < SIGNAL_B_TRIGGER) continue;

    const { steps, distReduction } = getTier(tssYesterday);

    // Compute new type (ladder rung; written below as its canonical workout type)
    const newLadderType = longRun ? stepDownLong(steps) : stepDown(wType, steps);
    const newType = canonicalType(newLadderType);

    // Compute new distance (stored for when user accepts). The fast-finish long
    // run stepped down to easy loses its marathon-pace finish: only its total
    // distance carries over, so the accepted session is a plain easy run rather
    // than an easy-typed run that still reads "last 5 @ MP".
    const baseDesc = longRun && wType !== 'long' && newType === 'easy'
      ? leadingDistance(workout.d ?? '')
      : (workout.d ?? '');
    const newDistance = applyDistReduction(baseDesc, distReduction);

    const newRpe = RPE_BY_TYPE[newLadderType] ?? 5;

    // Build label for button: "Downgrade to marathon pace (−10%)"
    const paceLabel: Record<string, string> = { easy: 'easy pace', marathon_pace: 'marathon pace', threshold: 'threshold pace' };
    const distLabel = distReduction > 0 ? ` · −${Math.round(distReduction * 100)}% distance` : '';
    const suggestionLabel = `${paceLabel[newType] ?? newType}${distLabel}`;

    mods.push({
      name: workout.n,
      dayOfWeek: sessionDay,
      // Stable slot id: the resolver matches by id before applying moves, so the
      // suggestion (and its accepted mod) lands on a drag-moved session too.
      workoutId: workout.id,
      status: 'planned',     // suggestion only. Not applied until user accepts
      modReason: `${TIMING_MOD_PREFIX} hard session day before`,
      confidence: 'medium',
      // The plan's original description. The session may already carry a cut
      // (the input is the resolved week), whose originalDistance is the plan's.
      originalDistance: workout.originalDistance ?? workout.d ?? '',
      newDistance,           // stored for accept action
      newType,
      newRpe,
      // Store suggestion label in confidence field. Repurposed as display hint
      // (avoids adding a new field to WorkoutMod)
    } as WorkoutMod & { suggestionLabel?: string });

    // Attach label for UI (non-persisted, set on object directly)
    (mods[mods.length - 1] as any).suggestionLabel = suggestionLabel;
    (mods[mods.length - 1] as any).tssYesterday    = Math.round(tssYesterday);
  }

  return mods;
}

// ─── State integration ────────────────────────────────────────────────────────

function weekStartISO(planStartDate: string, weekNum: number): string {
  const d = new Date(planStartDate);
  d.setDate(d.getDate() + (weekNum - 1) * 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Sessions a timing suggestion may target, from the resolved week. Excluded:
 *   - replaced or skipped sessions (nothing left to downgrade);
 *   - a session whose suggestion was already accepted (so it does not come back);
 *   - a session the user scaled by hand (their explicit choice);
 *   - sessions an illness or holiday adjustment is already managing.
 */
function timingCandidates(workouts: any[]): any[] {
  return workouts.filter(w =>
    w.status !== 'replaced'
    && w.status !== 'skipped'
    && !isTimingAcceptedMod(w.modReason)
    && !w.userScaledAt
    && !w.illnessMod
    && !w.holidayMod,
  );
}

/**
 * Recompute timing mods for the current week and merge into wk.workoutMods,
 * replacing any previous Timing: mods. Does NOT save state. Caller must save.
 * Returns true if anything changed.
 *
 * The suggestions are computed from the canonical resolved week
 * (resolveWeekWorkouts): the same generator arguments as the Plan tab, every
 * accepted change, move, illness and holiday adjustment applied. A suggestion is
 * therefore built from what the Plan tab shows, and accepting it never reverses an
 * earlier cut. Planning side only.
 */
export function mergeTimingMods(s: SimulatorState, wk: Week): boolean {
  if (!s.planStartDate) return false;

  const ws = weekStartISO(s.planStartDate, wk.w);
  const workouts = timingCandidates(resolveWeekWorkouts(s, wk.w));

  const prevWk = s.wks?.find((w: Week) => w.w === wk.w - 1);
  const prevWs = prevWk ? weekStartISO(s.planStartDate, prevWk.w) : undefined;
  const newTimingMods = applyTimingDowngradesFromWorkouts(wk, workouts, ws, prevWk, prevWs);
  const nonTimingMods = (wk.workoutMods ?? []).filter(m => !isTimingMod(m.modReason));

  const oldTiming = (wk.workoutMods ?? []).filter(m => isTimingMod(m.modReason));
  if (
    oldTiming.length === newTimingMods.length &&
    newTimingMods.every((m, i) =>
      m.name === oldTiming[i]?.name &&
      m.workoutId === oldTiming[i]?.workoutId &&
      m.newType === oldTiming[i]?.newType &&
      m.newDistance === oldTiming[i]?.newDistance
    )
  ) {
    return false; // nothing changed
  }

  wk.workoutMods = [...nonTimingMods, ...newTimingMods];
  return true;
}

/** Identifies the session whose pending timing suggestion is being accepted. */
export interface TimingSuggestionKey {
  workoutId?: string;
  name: string;
  dayOfWeek?: number;
}

/**
 * Accept a pending timing suggestion: replace it with a real plan change.
 *
 * The accepted mod carries the suggestion's stable slot id (so it applies to a
 * drag-moved session), its new type, description and RPE, and the plan's original
 * description. It is written with upsertWorkoutMod, so it replaces (and keeps
 * underneath, for undo) any cut the session already carried, rather than stacking.
 * Returns false when no pending suggestion matches the key.
 */
export function acceptTimingSuggestion(wk: Week, key: TimingSuggestionKey): boolean {
  const mods = wk.workoutMods ?? [];
  const suggestion = mods.find(m => isTimingMod(m.modReason) && (
    key.workoutId && m.workoutId
      ? m.workoutId === key.workoutId
      : modsTargetSameWorkout(m, key)
  ));
  if (!suggestion || !suggestion.newType) return false;

  wk.workoutMods = mods.filter(m => m !== suggestion);
  upsertWorkoutMod(wk, {
    name: suggestion.name,
    dayOfWeek: suggestion.dayOfWeek,
    workoutId: suggestion.workoutId,
    status: 'reduced',
    modReason: `${TIMING_ACCEPTED_PREFIX} hard session day before`,
    confidence: 'medium',
    originalDistance: suggestion.originalDistance,
    newDistance: suggestion.newDistance,
    newType: suggestion.newType,
    newRpe: suggestion.newRpe,
  });
  return true;
}
