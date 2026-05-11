/**
 * coach-tools.ts
 * ==============
 * Tool definitions for the AI coach, plus parameter validation and state mutation.
 *
 * Tools are scoped tightly: only current-week workout modifications.
 * Every tool call produces a PendingChange that requires explicit Apply before
 * touching state.
 *
 * Security: all input parameters are validated against actual plan state before
 * a PendingChange is created. Invalid calls are silently dropped — no Apply card.
 */

import { getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { sanitizeField } from './prompt-sanitizer';
import { generateWeekWorkouts } from '@/workouts';
import { getTrailingEffortScore } from '@/calculations/fitness-model';

// ─── Types ────────────────────────────────────────────────────────────────────

export type WorkoutSwapType = 'easy_run' | 'rest' | 'easy_swim' | 'easy_bike' | 'easy_brick' | 'walk';

const VALID_SWAP_TYPES: WorkoutSwapType[] = ['easy_run', 'rest', 'easy_swim', 'easy_bike', 'easy_brick', 'walk'];
const VALID_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export interface PendingChange {
  id: string;
  tool: 'swap_workout' | 'reduce_workout' | 'skip_workout' | 'adjust_intensity';
  headline: string;      // e.g. "Skip Thursday tempo"
  reason: string;        // Claude's sanitized reason
  // Internal mutation params
  _weekIdx: number;
  _workoutIdx: number;
  _params: Record<string, unknown>;
}

// ─── Tool definitions (sent to Anthropic API) ────────────────────────────────

export const COACH_TOOLS = [
  {
    name: 'swap_workout',
    description: 'Replace a planned workout with a different type. Use when recovery or overload signals clearly call for a lighter session.',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: VALID_DAYS, description: 'Day of the week (lowercase)' },
        workout_index: { type: 'number', description: 'Index of the workout in the day (0-based)' },
        new_type: { type: 'string', enum: VALID_SWAP_TYPES, description: 'The replacement workout type' },
        reason: { type: 'string', maxLength: 120, description: 'Brief explanation for the athlete (1–2 sentences)' },
      },
      required: ['day', 'workout_index', 'new_type', 'reason'],
    },
  },
  {
    name: 'reduce_workout',
    description: 'Shorten a workout duration by a percentage. Use when a session is valuable but full duration is inadvisable.',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: VALID_DAYS },
        workout_index: { type: 'number' },
        reduction_pct: { type: 'number', minimum: 10, maximum: 50, description: 'Percentage to remove (10–50)' },
        reason: { type: 'string', maxLength: 120 },
      },
      required: ['day', 'workout_index', 'reduction_pct', 'reason'],
    },
  },
  {
    name: 'skip_workout',
    description: 'Mark a workout as intentionally skipped. Use only when rest is clearly the best option (illness, injury, severe overload).',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: VALID_DAYS },
        workout_index: { type: 'number' },
        reason: { type: 'string', maxLength: 120 },
      },
      required: ['day', 'workout_index', 'reason'],
    },
  },
  {
    name: 'adjust_intensity',
    description: 'Cap a workout at a lower heart rate zone. Use to preserve aerobic stimulus while reducing physiological stress.',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: VALID_DAYS },
        workout_index: { type: 'number' },
        zone_cap: { type: 'number', enum: [2, 3], description: 'Maximum heart rate zone allowed (2 or 3)' },
        reason: { type: 'string', maxLength: 120 },
      },
      required: ['day', 'workout_index', 'zone_cap', 'reason'],
    },
  },
] as const;

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Maps a day name to an index into the current week's triWorkouts or running workouts.
 * Returns null if the day/index combo doesn't exist in the current plan.
 *
 * Note: for running mode, workouts are passed in since they're generated on the fly.
 * For triathlon mode, we read from wk.triWorkouts.
 */
function resolveWorkout(
  day: string,
  workoutIndex: number,
  state: ReturnType<typeof getMutableState>,
): { weekIdx: number; workoutIdx: number; workoutName: string } | null {
  const wkIdx = state.w - 1;
  const wk = state.wks[wkIdx];
  if (!wk) return null;

  if (state.eventType === 'triathlon') {
    const workouts = wk.triWorkouts ?? [];
    // Filter to workouts on the given day
    const dayWorkouts = workouts
      .map((w, i) => ({ w, i }))
      .filter(({ w }) => (w.dayName ?? '').toLowerCase() === day.toLowerCase());

    const entry = dayWorkouts[workoutIndex];
    if (!entry) return null;
    return { weekIdx: wkIdx, workoutIdx: entry.i, workoutName: entry.w.n };
  }

  // Running: generate the same workout list the context builder sent to Claude,
  // then find the actual workout name so workoutMods can match it by name.
  const generatedWorkouts = generateWeekWorkouts(
    wk.ph, state.rw, state.rd, state.typ, [],
    state.commuteConfig ?? undefined, null,
    state.recurringActivities, state.onboarding?.experienceLevel,
    undefined, state.pac?.e, state.w, state.tw, state.v, state.gs,
    getTrailingEffortScore(state.wks, wkIdx), wk.scheduledAcwrStatus,
  );

  const dayWorkouts = generatedWorkouts.filter(
    w => (w.dayName ?? '').toLowerCase() === day.toLowerCase(),
  );
  const match = dayWorkouts[workoutIndex];
  if (!match) return null;

  return { weekIdx: wkIdx, workoutIdx: workoutIndex, workoutName: match.n };
}

export function validateAndBuildPendingChange(
  toolName: string,
  input: Record<string, unknown>,
): PendingChange | null {
  const state = getMutableState();

  const day = typeof input.day === 'string' ? input.day.toLowerCase() : '';
  if (!VALID_DAYS.includes(day)) return null;

  const workoutIndex = typeof input.workout_index === 'number' ? Math.floor(input.workout_index) : -1;
  if (workoutIndex < 0 || workoutIndex > 20) return null;

  const reason = sanitizeField(String(input.reason ?? ''), 120);
  if (!reason) return null;

  const resolved = resolveWorkout(day, workoutIndex, state);
  if (!resolved) return null;

  const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);

  if (toolName === 'swap_workout') {
    const newType = input.new_type as string;
    if (!VALID_SWAP_TYPES.includes(newType as WorkoutSwapType)) return null;
    const typeLabel = newType.replace(/_/g, ' ');
    return {
      id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool: 'swap_workout',
      headline: `Swap ${dayLabel} workout to ${typeLabel}`,
      reason,
      _weekIdx: resolved.weekIdx,
      _workoutIdx: resolved.workoutIdx,
      _params: { day, workoutIndex, newType, workoutName: resolved.workoutName },
    };
  }

  if (toolName === 'reduce_workout') {
    const pct = typeof input.reduction_pct === 'number' ? Math.round(input.reduction_pct) : 0;
    if (pct < 10 || pct > 50) return null;
    return {
      id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool: 'reduce_workout',
      headline: `Reduce ${dayLabel} workout by ${pct}%`,
      reason,
      _weekIdx: resolved.weekIdx,
      _workoutIdx: resolved.workoutIdx,
      _params: { day, workoutIndex, pct, workoutName: resolved.workoutName },
    };
  }

  if (toolName === 'skip_workout') {
    return {
      id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool: 'skip_workout',
      headline: `Skip ${dayLabel} ${resolved.workoutName}`,
      reason,
      _weekIdx: resolved.weekIdx,
      _workoutIdx: resolved.workoutIdx,
      _params: { day, workoutIndex, workoutName: resolved.workoutName },
    };
  }

  if (toolName === 'adjust_intensity') {
    const zoneCap = typeof input.zone_cap === 'number' ? input.zone_cap : 0;
    if (zoneCap !== 2 && zoneCap !== 3) return null;
    return {
      id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool: 'adjust_intensity',
      headline: `Cap ${dayLabel} workout at Zone ${zoneCap}`,
      reason,
      _weekIdx: resolved.weekIdx,
      _workoutIdx: resolved.workoutIdx,
      _params: { day, workoutIndex, zoneCap },
    };
  }

  return null;
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/** Apply a confirmed pending change to state. Called only after user taps Apply. */
export function applyPendingChange(change: PendingChange): void {
  const state = getMutableState();
  const wk = state.wks[change._weekIdx];
  if (!wk) return;

  const p = change._params;

  if (change.tool === 'swap_workout' || change.tool === 'reduce_workout' || change.tool === 'adjust_intensity') {
    if (state.eventType === 'triathlon' && wk.triWorkouts) {
      const w = wk.triWorkouts[change._workoutIdx];
      if (!w) return;

      if (change.tool === 'swap_workout') {
        const newType = p.newType as WorkoutSwapType;
        w.t = newType;
        w.status = 'replaced';
        w.modReason = change.reason;
        const typeLabel = newType.replace(/_/g, ' ');
        w.n = typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1);
        w.d = `${typeLabel} — adjusted by AI coach`;
      } else if (change.tool === 'reduce_workout') {
        const pct = p.pct as number;
        if (w.estimatedDurationMin) {
          w.estimatedDurationMin = Math.round(w.estimatedDurationMin * (1 - pct / 100));
        }
        w.status = 'reduced';
        w.modReason = change.reason;
      } else if (change.tool === 'adjust_intensity') {
        const zoneCap = p.zoneCap as number;
        w.modReason = `Zone ${zoneCap} cap — ${change.reason}`;
        w.status = 'reduced';
      }
    } else {
      // Running: append to workoutMods for plan-view to pick up
      if (!wk.workoutMods) wk.workoutMods = [];

      if (change.tool === 'swap_workout') {
        const newType = p.newType as string;
        wk.workoutMods.push({
          name: p.workoutName as string,
          status: 'replaced',
          modReason: change.reason,
          newDistance: '',
          newType,
          newRpe: 1,
        });
      } else if (change.tool === 'reduce_workout') {
        wk.workoutMods.push({
          name: p.workoutName as string,
          status: 'reduced',
          modReason: change.reason,
          newDistance: '',
          autoReduceNote: `Reduced ${p.pct}% by AI coach`,
        });
      }
    }
  }

  if (change.tool === 'skip_workout') {
    if (state.eventType === 'triathlon' && wk.triWorkouts) {
      const w = wk.triWorkouts[change._workoutIdx];
      if (w) {
        w.skipped = true;
        w.status = 'skipped';
        w.modReason = change.reason;
      }
    } else {
      if (!wk.workoutMods) wk.workoutMods = [];
      wk.workoutMods.push({
        name: p.workoutName as string,
        status: 'skipped',
        modReason: change.reason,
        newDistance: '',
      });
    }
  }

  saveState();
}
