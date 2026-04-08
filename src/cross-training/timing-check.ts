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
 * Floor: max(3 km, reduced distance) — approx. 20 min minimum.
 *
 * Intensity ladder (ascending): easy → marathon → threshold → vo2
 * Long run: long → marathon (1 step), long → easy (2 steps)
 *
 * Mods are suggestions only — workout unchanged until user accepts.
 * Recomputed fresh each sync, so they clear on reschedule.
 */

import type { Week, WorkoutMod } from '@/types/state';
import type { SimulatorState } from '@/types/state';
import { generateWeekWorkouts } from '@/workouts';
import { getTrailingEffortScore } from '@/calculations/fitness-model';

const QUALITY_TYPES = new Set(['threshold', 'vo2', 'long']);
const SIGNAL_B_TRIGGER = 50;       // TSS: minimum to show any suggestion
const MIN_DISTANCE_KM  = 3;        // Floor: ~20 min including warm-up
export const TIMING_MOD_PREFIX = 'Timing:';

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

/** Apply distance reduction with floor, returning new distance string. */
function applyDistReduction(originalDesc: string, reduction: number): string {
  if (reduction === 0) return originalDesc;
  const match = originalDesc.match(/(\d+\.?\d*)\s*km/i);
  if (!match) return originalDesc;
  const original = parseFloat(match[1]);
  const reduced  = Math.max(MIN_DISTANCE_KM, Math.round(original * (1 - reduction) * 10) / 10);
  return originalDesc.replace(match[0], `${reduced} km`);
}

// ─── Signal B helpers ─────────────────────────────────────────────────────────

const TSS_PER_MIN: Record<number, number> = {
  1: 0.3, 2: 0.5, 3: 0.65, 4: 0.8, 5: 0.92,
  6: 1.05, 7: 1.25, 8: 1.45, 9: 1.65, 10: 1.9,
};

function actSignalBTSS(iTrimp: number | null | undefined, durationSec: number): number {
  if (iTrimp != null && iTrimp > 0) return (iTrimp * 100) / 15000;
  return (durationSec / 60) * 0.92;
}

function adhocSignalBTSS(iTrimp: number | null | undefined, durationMin: number, rpe: number): number {
  if (iTrimp != null && iTrimp > 0) return (iTrimp * 100) / 15000;
  return durationMin * (TSS_PER_MIN[Math.round(rpe)] ?? 0.92);
}

function dayOfWeekFromISO(isoTimestamp: string, weekStartISO: string): number {
  const actDate = new Date(isoTimestamp);
  const weekStart = new Date(weekStartISO);
  const diff = Math.floor((actDate.getTime() - weekStart.getTime()) / 86400000);
  if (diff < 0 || diff >= 7) return -1;
  // Remap to scheduler convention (0=Monday) — weekStartISO may not be a Monday
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

  // Strava/Garmin matched actuals (garminId may be 'strava-XXXX' — both sources land here)
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
 * Pure function — no state mutation.
 */
export function applyTimingDowngradesFromWorkouts(
  wk: Week,
  workouts: Array<{ id?: string; n: string; t: string; d?: string; dayOfWeek?: number; r?: number; rpe?: number }>,
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

    if (!QUALITY_TYPES.has(wType)) continue;

    // Skip already-completed sessions
    const isRated = typeof rated[id] === 'number' && (rated[id] as number) > 0;
    if (isRated) continue;

    const sessionDay = workout.dayOfWeek;
    if (sessionDay == null) continue;

    const dayBefore    = (sessionDay - 1 + 7) % 7;
    const tssYesterday = dayTSS.get(dayBefore) ?? 0;
    if (tssYesterday < SIGNAL_B_TRIGGER) continue;

    const { steps, distReduction } = getTier(tssYesterday);

    // Compute new type
    const newType = wType === 'long' ? stepDownLong(steps) : stepDown(wType, steps);

    // Compute new distance (stored for when user accepts)
    const newDistance = applyDistReduction(workout.d ?? '', distReduction);

    const newRpe = RPE_BY_TYPE[newType] ?? 5;

    // Build label for button: "Downgrade to marathon pace (−10%)"
    const paceLabel: Record<string, string> = { easy: 'easy pace', marathon: 'marathon pace', threshold: 'threshold pace' };
    const distLabel = distReduction > 0 ? ` · −${Math.round(distReduction * 100)}% distance` : '';
    const suggestionLabel = `${paceLabel[newType] ?? newType}${distLabel}`;

    mods.push({
      name: workout.n,
      dayOfWeek: sessionDay,
      status: 'planned',     // suggestion only — not applied until user accepts
      modReason: `${TIMING_MOD_PREFIX} hard session day before`,
      confidence: 'medium',
      originalDistance: workout.d ?? '',
      newDistance,           // stored for accept action
      newType,
      newRpe,
      // Store suggestion label in confidence field — repurposed as display hint
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
 * Recompute timing mods for the current week and merge into wk.workoutMods,
 * replacing any previous Timing: mods. Does NOT save state — caller must save.
 * Returns true if anything changed.
 */
export function mergeTimingMods(s: SimulatorState, wk: Week): boolean {
  if (!s.planStartDate) return false;

  const ws = weekStartISO(s.planStartDate, wk.w);

  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [],
    s.commuteConfig || undefined, null,
    s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e,
    wk.w, s.tw, s.v, s.gs,
    getTrailingEffortScore(s.wks, wk.w), wk.scheduledAcwrStatus,
  );

  // Apply manual day moves so timing check sees the rescheduled days
  if (wk.workoutMoves) {
    for (const [workoutId, newDay] of Object.entries(wk.workoutMoves)) {
      const w = workouts.find(wo => (wo.id || wo.n) === workoutId);
      if (w) w.dayOfWeek = newDay;
    }
  }

  const prevWk = s.wks?.find((w: Week) => w.w === wk.w - 1);
  const prevWs = prevWk ? weekStartISO(s.planStartDate, prevWk.w) : undefined;
  const newTimingMods = applyTimingDowngradesFromWorkouts(wk, workouts, ws, prevWk, prevWs);
  const nonTimingMods = (wk.workoutMods ?? []).filter(m => !isTimingMod(m.modReason));

  const oldTiming = (wk.workoutMods ?? []).filter(m => isTimingMod(m.modReason));
  if (
    oldTiming.length === newTimingMods.length &&
    newTimingMods.every((m, i) =>
      m.name === oldTiming[i]?.name &&
      m.newType === oldTiming[i]?.newType &&
      m.newDistance === oldTiming[i]?.newDistance
    )
  ) {
    return false; // nothing changed
  }

  wk.workoutMods = [...nonTimingMods, ...newTimingMods];
  return true;
}

// ─── UI helper ────────────────────────────────────────────────────────────────

export function isTimingMod(modReason: string | undefined): boolean {
  return (modReason ?? '').startsWith(TIMING_MOD_PREFIX);
}
