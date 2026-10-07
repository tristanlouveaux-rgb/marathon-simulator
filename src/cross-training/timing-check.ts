/**
 * timing-check.ts
 * ================
 * Phase 7: Day-proximity → quality session downgrade (suggestion).
 *
 * When a high-load activity (Signal B ≥ 50 TSS) is completed the day before a
 * session above easy pace (vo2, threshold, float, marathon pace, progressive) or
 * the long run, a suggestion mod is generated.
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
 * Each step is one pace category down the canonical running ladder
 * (constants/intensity-ladder.ts): vo2 → threshold → marathon pace → easy →
 * recovery, never up. Float sits on the threshold rung, progressive on the
 * marathon-pace rung. "Long run" is the long-run slot in any format (isLongRun):
 * the fast-finish long run steps to an easy long run ('long', its marathon-pace
 * finish dropped), the steady long run to recovery pace, at the same distance
 * before the tier's cut. The accepted session carries the new type's generator
 * RPE and, when easy pace is known, the new type's pace in its description.
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
import { scaleDescriptionProportional, retargetDescriptionPace } from '@/workouts/workout-scaling';
import { runPaceRung, stepDownRunType, generatorRpeForRunType } from '@/constants/intensity-ladder';
import { upsertWorkoutMod, modsTargetSameWorkout } from '@/workouts/workout-mods';
import { resolveWeekForPlanChanges } from '@/ui/week-resolve';
import { renderLayerOf } from '@/workouts/render-layer';
import { localDateKey, calendarDaysBetween } from '@/utils/local-date';
import {
  TIMING_MOD_PREFIX,
  TIMING_ACCEPTED_PREFIX,
  isTimingMod,
  isTimingAcceptedMod,
} from './timing-mod-reason';

export { TIMING_MOD_PREFIX, TIMING_ACCEPTED_PREFIX, isTimingMod, isTimingAcceptedMod };

const SIGNAL_B_TRIGGER = 50;       // TSS: minimum to show any suggestion
const MIN_DISTANCE_KM  = 3;        // Floor: ~20 min including warm-up

// ─── Intensity ladder ─────────────────────────────────────────────────────────

const EASY_RUNG = runPaceRung('easy');
const MARATHON_RUNG = runPaceRung('marathon_pace');

/** A session the day-after check protects: any run above easy pace, plus the
 *  long run in any format. Easy and recovery runs are left alone. */
function isProtectedSession(type: string, longRun: boolean): boolean {
  return longRun || runPaceRung(type) > EASY_RUNG;
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
  // Calendar days from the week start to the activity's LOCAL day (the day the
  // matcher files it under), not the UTC-instant difference.
  const diff = calendarDaysBetween(weekStartISO, localDateKey(isoTimestamp));
  if (!Number.isFinite(diff) || diff < 0 || diff >= 7) return -1;
  // Remap to scheduler convention (0=Monday). WeekStartISO may not be a Monday
  const weekStart = new Date(weekStartISO + 'T00:00:00Z'); // calendar date at UTC midnight
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

/** Button and banner wording for each type a downgrade can write. */
const PACE_LABEL: Record<string, string> = {
  recovery: 'recovery pace',
  easy: 'easy pace',
  long: 'easy pace',
  marathon_pace: 'marathon pace',
  threshold: 'threshold pace',
};

/**
 * Compute timing suggestion mods for the given workout list.
 * Pure function. No state mutation. `easyPaceSecPerKm` (the athlete's easy pace)
 * lets the new description carry the new type's pace; without it the
 * description keeps its pace tokens.
 */
export function applyTimingDowngradesFromWorkouts(
  wk: Week,
  workouts: Array<{ id?: string; n: string; t: string; d?: string; dayOfWeek?: number; r?: number; rpe?: number; longRun?: boolean; originalDistance?: string }>,
  weekStartISO: string,
  prevWeek?: Week,
  prevWeekStartISO?: string,
  easyPaceSecPerKm?: number,
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
    // The fast-finish long run is t:'progressive'. isLongRun gives it the
    // long-run slot's treatment (audit X5).
    const longRun = isLongRun(workout);

    if (!isProtectedSession(wType, longRun)) continue;

    // Skip already-completed sessions
    const isRated = typeof rated[id] === 'number' && (rated[id] as number) > 0;
    if (isRated) continue;

    const sessionDay = workout.dayOfWeek;
    if (sessionDay == null) continue;

    const dayBefore    = (sessionDay - 1 + 7) % 7;
    const tssYesterday = dayTSS.get(dayBefore) ?? 0;
    if (tssYesterday < SIGNAL_B_TRIGGER) continue;

    const { steps, distReduction } = getTier(tssYesterday);

    // One pace category down per step (never up). The long-run slot stepped onto
    // the easy rung stays a long run ('long').
    const newType = stepDownRunType(wType, steps, { longRun });
    if (newType === wType) continue; // already at the bottom rung

    // New description (stored for when the user accepts). A progressive or
    // fast-finish run stepped below marathon pace drops its finish: only its total
    // distance carries over, so the accepted session does not still read
    // "last 5 @ MP". The pace tokens then follow the new type.
    const dropsFinish = wType === 'progressive' && runPaceRung(newType) < MARATHON_RUNG;
    const baseDesc = dropsFinish ? leadingDistance(workout.d ?? '') : (workout.d ?? '');
    const newDistance = retargetDescriptionPace(applyDistReduction(baseDesc, distReduction), newType, easyPaceSecPerKm);

    // The generator's RPE for the new type, so the card's effort and the debrief
    // read the new prescription.
    const newRpe = generatorRpeForRunType(newType) ?? workout.rpe ?? workout.r;

    // Build label for button: "easy pace · −10% distance"
    const distLabel = distReduction > 0 ? ` · −${Math.round(distReduction * 100)}% distance` : '';
    const suggestionLabel = `${PACE_LABEL[newType] ?? newType}${distLabel}`;

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
  // Calendar arithmetic on the date components (no DST or time-zone shift).
  const [y, m, d] = localDateKey(planStartDate).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + (weekNum - 1) * 7)).toISOString().slice(0, 10);
}

/**
 * Sessions a timing suggestion may target, from the plan-layers week. Excluded:
 *   - replaced or skipped sessions (nothing left to downgrade);
 *   - a session whose suggestion was already accepted (so it does not come back);
 *   - a session the user scaled by hand (their explicit choice);
 *   - sessions an illness, holiday or post-holiday bridge layer already adjusts
 *     (renderLayer). The bridge already eases the session, and a suggestion built
 *     from its plan values would not read like the card the Plan shows.
 */
function timingCandidates(workouts: any[]): any[] {
  return workouts.filter(w =>
    w.status !== 'replaced'
    && w.status !== 'skipped'
    && !isTimingAcceptedMod(w.modReason)
    && !w.userScaledAt
    && !renderLayerOf(w),
  );
}

/**
 * Recompute timing mods for the current week and merge into wk.workoutMods,
 * replacing any previous Timing: mods. Does NOT save state. Caller must save.
 * Returns true if anything changed.
 *
 * The suggestions are computed from the canonical resolver with the plan layers
 * only (resolveWeekForPlanChanges): the same generator arguments as the Plan tab,
 * every accepted change and move applied, so accepting a suggestion never reverses
 * an earlier cut. The illness, holiday and bridge layers are left out because an
 * accepted suggestion becomes a mod and those layers are re-applied on top of it at
 * render; the sessions they adjust get no suggestion. Planning side only.
 */
export function mergeTimingMods(s: SimulatorState, wk: Week): boolean {
  if (!s.planStartDate) return false;

  const ws = weekStartISO(s.planStartDate, wk.w);
  const workouts = timingCandidates(resolveWeekForPlanChanges(s, wk.w));

  const prevWk = s.wks?.find((w: Week) => w.w === wk.w - 1);
  const prevWs = prevWk ? weekStartISO(s.planStartDate, prevWk.w) : undefined;
  const newTimingMods = applyTimingDowngradesFromWorkouts(wk, workouts, ws, prevWk, prevWs, s.pac?.e);
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
