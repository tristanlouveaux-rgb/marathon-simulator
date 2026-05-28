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

/** Memory: max number of facts the coach can keep about the athlete. When at
 *  capacity, a new `remember` drops the oldest fact silently. */
export const MEMORY_FACT_MAX = 15;
/** Memory: max length per fact (after sanitisation). */
const MEMORY_FACT_MAX_LEN = 160;

export type CoachToolName = 'swap_workout' | 'reduce_workout' | 'skip_workout' | 'adjust_intensity' | 'remember' | 'forget';

export interface PendingChange {
  id: string;
  tool: CoachToolName;
  headline: string;      // e.g. "Skip Thursday tempo"
  reason: string;        // Claude's sanitized reason
  // Internal mutation params — workout-mod tools use _weekIdx + _workoutIdx;
  // memory tools (remember / forget) leave both at -1 and put everything in _params.
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
        workout_index: { type: 'number', description: 'Per-day workout index (0-based) from the this_week_plan context.' },
        workout_name: { type: 'string', maxLength: 60, description: 'Workout name from context (helps the system resolve the right session if the index is ambiguous).' },
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
        workout_index: { type: 'number', description: 'Per-day workout index (0-based) from the this_week_plan context.' },
        workout_name: { type: 'string', maxLength: 60, description: 'Workout name from context (helps the system resolve the right session if the index is ambiguous).' },
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
        workout_index: { type: 'number', description: 'Per-day workout index (0-based) from the this_week_plan context.' },
        workout_name: { type: 'string', maxLength: 60, description: 'Workout name from context (helps the system resolve the right session if the index is ambiguous).' },
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
        workout_index: { type: 'number', description: 'Per-day workout index (0-based) from the this_week_plan context.' },
        workout_name: { type: 'string', maxLength: 60, description: 'Workout name from context (helps the system resolve the right session if the index is ambiguous).' },
        zone_cap: { type: 'number', enum: [2, 3], description: 'Maximum heart rate zone allowed (2 or 3)' },
        reason: { type: 'string', maxLength: 120 },
      },
      required: ['day', 'workout_index', 'zone_cap', 'reason'],
    },
  },
  {
    name: 'remember',
    description: 'Save a short fact about the athlete (a preference, constraint, motivation, or training history) to persistent memory so future sessions know it. Use ONLY when the athlete tells you something they would want you to remember next time. Examples: "I prefer Tuesday/Thursday quality days", "I always cut long runs short when work is busy", "I come from a cycling background". Do NOT use for one-off observations from data (those live in the athlete context already).',
    input_schema: {
      type: 'object',
      properties: {
        fact: { type: 'string', maxLength: 160, description: 'The fact to remember, in third person ("Athlete prefers..."). Keep under 20 words.' },
        reason: { type: 'string', maxLength: 120, description: 'Why this fact is worth remembering (shown on the Apply card so the athlete confirms).' },
      },
      required: ['fact', 'reason'],
    },
  },
  {
    name: 'forget',
    description: 'Remove a fact from persistent memory. Use when the athlete corrects something you remembered wrong, or says a previous preference no longer applies. The fact_index is the position in the memory_facts array (0-based) from the athlete context.',
    input_schema: {
      type: 'object',
      properties: {
        fact_index: { type: 'number', description: 'Index of the fact to remove from memory_facts (0-based).' },
        reason: { type: 'string', maxLength: 120, description: 'Why this fact should be forgotten (shown on the Apply card).' },
      },
      required: ['fact_index', 'reason'],
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
  workoutName?: string,
): { weekIdx: number; workoutIdx: number; workoutName: string } | null {
  const wkIdx = state.w - 1;
  const wk = state.wks[wkIdx];
  if (!wk) return null;

  const nameNorm = (workoutName ?? '').trim().toLowerCase();

  // Triathlon AND HYROX both store sessions in `wk.triWorkouts` (the field is
  // historical — HYROX added later and reused the schema). Running uses generated
  // workouts that aren't on state. Only the running branch needs the regenerator.
  if (state.eventType === 'triathlon' || state.eventType === 'hyrox') {
    const workouts = wk.triWorkouts ?? [];
    const dayWorkouts = workouts
      .map((w, i) => ({ w, i }))
      .filter(({ w }) => (w.dayName ?? '').toLowerCase() === day.toLowerCase());

    // Primary: by per-day index
    const byIndex = dayWorkouts[workoutIndex];
    if (byIndex) return { weekIdx: wkIdx, workoutIdx: byIndex.i, workoutName: byIndex.w.n };

    // Fallback 1: by name within that day
    if (nameNorm) {
      const byName = dayWorkouts.find(({ w }) => (w.n ?? '').toLowerCase().includes(nameNorm)
        || nameNorm.includes((w.n ?? '').toLowerCase()));
      if (byName) return { weekIdx: wkIdx, workoutIdx: byName.i, workoutName: byName.w.n };
    }

    // Fallback 2: if only one workout that day, use it regardless of index
    if (dayWorkouts.length === 1) {
      const only = dayWorkouts[0];
      return { weekIdx: wkIdx, workoutIdx: only.i, workoutName: only.w.n };
    }

    return null;
  }

  // Running mode
  const generatedWorkouts = generateWeekWorkouts(
    wk.ph, state.rw, state.rd, state.typ, [],
    state.commuteConfig ?? undefined, state.injuryState,
    state.recurringActivities, state.onboarding?.experienceLevel,
    undefined, state.pac?.e, state.w, state.tw, state.v, state.gs,
    getTrailingEffortScore(state.wks, wkIdx), wk.scheduledAcwrStatus,
  );

  const dayWorkouts = generatedWorkouts.filter(
    w => (w.dayName ?? '').toLowerCase() === day.toLowerCase(),
  );

  const byIndex = dayWorkouts[workoutIndex];
  if (byIndex) return { weekIdx: wkIdx, workoutIdx: workoutIndex, workoutName: byIndex.n };

  if (nameNorm) {
    const byName = dayWorkouts.find(w => (w.n ?? '').toLowerCase().includes(nameNorm)
      || nameNorm.includes((w.n ?? '').toLowerCase()));
    if (byName) {
      const idx = dayWorkouts.indexOf(byName);
      return { weekIdx: wkIdx, workoutIdx: idx, workoutName: byName.n };
    }
  }

  if (dayWorkouts.length === 1) {
    return { weekIdx: wkIdx, workoutIdx: 0, workoutName: dayWorkouts[0].n };
  }

  return null;
}

/** Diagnostic detail for the latest dropped tool call. Read by the UI fallback
 *  message so the user sees *why* a change couldn't be applied. Kept around as
 *  a back-compat shim; new callers should use `validateToolCall` (below) which
 *  returns the reason inline so two near-simultaneous tool calls can't race. */
export let lastToolDropReason: string | null = null;

function dropTool(reason: string): null {
  lastToolDropReason = reason;
  console.warn(`[coach-tools] Dropped tool call: ${reason}`);
  return null;
}

/** Race-safe variant: returns either the built PendingChange or the drop reason
 *  inline, so concurrent tool-use blocks in a stream don't clobber each other's
 *  diagnostics. UI code should prefer this over reading `lastToolDropReason`. */
export function validateToolCall(
  toolName: string,
  input: Record<string, unknown>,
): { change: PendingChange } | { dropReason: string } {
  const change = validateAndBuildPendingChange(toolName, input);
  if (change) return { change };
  return { dropReason: lastToolDropReason ?? 'unknown' };
}

export function validateAndBuildPendingChange(
  toolName: string,
  input: Record<string, unknown>,
): PendingChange | null {
  const state = getMutableState();
  lastToolDropReason = null;

  // ── Memory tools (no day / workout — handled before the workout-mod path) ──
  if (toolName === 'remember') {
    const fact = sanitizeField(String(input.fact ?? ''), MEMORY_FACT_MAX_LEN);
    if (!fact) return dropTool('remember: empty fact');
    const reason = sanitizeField(String(input.reason ?? ''), 120) || 'Saved to memory';
    return {
      id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool: 'remember',
      headline: 'Remember this',
      reason,
      _weekIdx: -1,
      _workoutIdx: -1,
      _params: { fact },
    };
  }

  if (toolName === 'forget') {
    const factIndex = typeof input.fact_index === 'number' ? Math.floor(input.fact_index) : -1;
    const facts = state.coachMemory?.facts ?? [];
    if (factIndex < 0 || factIndex >= facts.length) {
      return dropTool(`forget: fact_index ${factIndex} out of range (0..${facts.length - 1})`);
    }
    const reason = sanitizeField(String(input.reason ?? ''), 120) || 'No longer applies';
    return {
      id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tool: 'forget',
      headline: `Forget: "${facts[factIndex].text.slice(0, 60)}${facts[factIndex].text.length > 60 ? '…' : ''}"`,
      reason,
      _weekIdx: -1,
      _workoutIdx: -1,
      _params: { factIndex },
    };
  }

  const day = typeof input.day === 'string' ? input.day.toLowerCase() : '';
  if (!VALID_DAYS.includes(day)) return dropTool(`invalid day "${input.day ?? ''}"`);

  const workoutIndex = typeof input.workout_index === 'number' ? Math.floor(input.workout_index) : 0;
  const workoutName = typeof input.workout_name === 'string' ? input.workout_name : undefined;

  const reason = sanitizeField(String(input.reason ?? ''), 120);
  if (!reason) return dropTool('missing reason');

  const resolved = resolveWorkout(day, workoutIndex, state, workoutName);
  if (!resolved) return dropTool(`could not resolve workout on ${day} (index=${workoutIndex}, name="${workoutName ?? ''}")`);

  const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);

  if (toolName === 'swap_workout') {
    const newType = input.new_type as string;
    if (!VALID_SWAP_TYPES.includes(newType as WorkoutSwapType)) return dropTool(`invalid swap target "${newType}"`);
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
    if (pct < 10 || pct > 50) return dropTool(`reduction_pct ${pct} out of range (10–50)`);
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
    if (zoneCap !== 2 && zoneCap !== 3) return dropTool(`zone_cap must be 2 or 3, got ${zoneCap}`);
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

  return dropTool(`unknown tool name "${toolName}"`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Scale primary distance + duration tokens in a workout description by `factor`.
 *  Handles "3300m", "3.3km", "60 min", "1h 15min". Leaves pace/zone tokens alone
 *  (those are intensity, not volume). Pragmatic — known to mis-scale exotic
 *  descriptions; the plan-engine remains the source of truth for fresh weeks. */
export function scaleWorkoutDescription(desc: string, factor: number): string {
  if (!desc || factor === 1) return desc;

  const round50 = (n: number) => Math.round(n / 50) * 50;

  // metres: "3300m" or "200m". Skip:
  //   - pace tokens like "/100m" (handled by lookbehind on '/')
  //   - interval rep distances like "8x100m" / "4 x 400m" / "6×200m" (multiplier
  //     prefix captured in an optional group; when present we return the match
  //     unchanged so reductions don't destroy interval prescriptions).
  // Real fixture covered by this guard: "8x400m threshold" must NOT become
  // "8x300m threshold" under a 30% reduce.
  desc = desc.replace(/(\d+\s*[x×]\s*)?(?<![\/\d])(\d{2,5})\s*m\b/g, (full, multiplier: string | undefined, n: string) => {
    if (multiplier) return full;
    const v = parseInt(n, 10);
    if (!isFinite(v) || v < 100) return `${n}m`; // skip tiny tokens — likely pace
    return `${round50(v * factor)}m`;
  });

  // kilometres: "3.3km" or "10 km" — whole numbers stay whole, fractional get .1
  desc = desc.replace(/(\d+(?:\.\d+)?)\s*km\b/g, (_m, n: string) => {
    const v = parseFloat(n);
    if (!isFinite(v)) return _m;
    const scaled = v * factor;
    const display = Math.round(scaled * 10) / 10 === Math.round(scaled)
      ? Math.round(scaled).toString()
      : scaled.toFixed(1);
    return `${display}km`;
  });

  // Minutes — single combined pass so h+min compounds aren't re-scaled by the
  // bare-min pattern. Alternation order matters: h+min first, then bare min.
  desc = desc.replace(
    /(\d+)\s*h\s*(\d+)\s*min\b|\b(\d+)\s*min\b/gi,
    (match, h: string | undefined, mm: string | undefined, m2: string | undefined) => {
      if (h !== undefined && mm !== undefined) {
        const total = parseInt(h, 10) * 60 + parseInt(mm, 10);
        if (!isFinite(total)) return match;
        const scaled = Math.max(5, Math.round(total * factor));
        const hh = Math.floor(scaled / 60);
        const mins = scaled % 60;
        return hh > 0 ? `${hh}h ${mins}min` : `${mins}min`;
      }
      const v = parseInt(m2 ?? '', 10);
      if (!isFinite(v) || v < 5) return match;
      return `${Math.max(5, Math.round(v * factor))}min`;
    },
  );

  return desc;
}

// ─── Apply ────────────────────────────────────────────────────────────────────

/** Capitalise first letter of each word in a snake_case type. */
function prettyType(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

/** Sensible default workout description for a swap-target type. Preserves the
 *  duration of the original workout when known, so a 60-min threshold swap to
 *  easy_run becomes a ~60-min easy run, not a generic stub. */
function defaultDescriptionForSwap(newType: WorkoutSwapType, originalDurationMin?: number): string {
  const dur = typeof originalDurationMin === 'number' && originalDurationMin > 0 ? originalDurationMin : null;
  const durStr = dur ? `${dur} min` : '';
  switch (newType) {
    case 'easy_run':   return durStr ? `${durStr} easy at conversational pace. Z2 only.` : 'Easy at conversational pace. Z2 only.';
    case 'easy_swim':  return durStr ? `${durStr} easy swim. Aerobic only, no hard sets.` : 'Easy swim, aerobic only.';
    case 'easy_bike':  return durStr ? `${durStr} easy spin. Z2 only, no efforts.` : 'Easy spin, Z2 only.';
    case 'easy_brick': return durStr ? `${durStr} easy brick. Both segments Z2.` : 'Easy brick, both segments Z2.';
    case 'walk':       return durStr ? `${durStr} walk. Movement, no training stress.` : 'Walk only — movement, no training stress.';
    case 'rest':       return 'Full rest day. No training.';
  }
}

/** Snapshot pre-mod fields once (so subsequent mods don't overwrite the
 *  original snapshot — first mod is what Undo should restore). */
function snapshotIfFirst(w: import('@/types/state').Workout): void {
  if (w.aiPreModSnapshot) return;
  w.aiPreModSnapshot = {
    n: w.n,
    d: w.d,
    t: w.t,
    aerobic: w.aerobic,
    anaerobic: w.anaerobic,
    estimatedDurationMin: w.estimatedDurationMin,
    status: w.status,
  };
}

/** Apply a confirmed pending change to state. Called only after user taps Apply. */
export function applyPendingChange(change: PendingChange): void {
  const state = getMutableState();
  const nowISO = new Date().toISOString();

  // ── Memory operations: not tied to a week ─────────────────────────────────
  if (change.tool === 'remember') {
    const fact = String(change._params.fact ?? '').trim();
    if (!fact) return;
    if (!state.coachMemory) state.coachMemory = { lastUpdatedISO: nowISO, facts: [] };
    state.coachMemory.facts.push({ text: fact, addedISO: nowISO });
    // Cap at MEMORY_FACT_MAX — drop oldest.
    if (state.coachMemory.facts.length > MEMORY_FACT_MAX) {
      state.coachMemory.facts.splice(0, state.coachMemory.facts.length - MEMORY_FACT_MAX);
    }
    state.coachMemory.lastUpdatedISO = nowISO;
    saveState();
    return;
  }

  if (change.tool === 'forget') {
    const idx = change._params.factIndex as number;
    if (!state.coachMemory || idx < 0 || idx >= state.coachMemory.facts.length) return;
    state.coachMemory.facts.splice(idx, 1);
    state.coachMemory.lastUpdatedISO = nowISO;
    saveState();
    return;
  }

  // ── Workout-mod operations: need a week ───────────────────────────────────
  const wk = state.wks[change._weekIdx];
  if (!wk) return;

  const p = change._params;
  // Triathlon AND HYROX both put sessions in `wk.triWorkouts` and want in-place
  // mutation. Only running uses the workoutMods regeneration path.
  const isStructured = (state.eventType === 'triathlon' || state.eventType === 'hyrox') && !!wk.triWorkouts;

  // ─── Triathlon / HYROX: in-place mutation of wk.triWorkouts ───────────────
  if (isStructured) {
    const w = wk.triWorkouts![change._workoutIdx];
    if (!w) return;
    snapshotIfFirst(w);

    if (change.tool === 'swap_workout') {
      const newType = p.newType as WorkoutSwapType;
      const typeLabel = prettyType(newType);
      w.n = typeLabel;
      w.d = defaultDescriptionForSwap(newType, w.estimatedDurationMin);
      w.t = newType;
      w.status = newType === 'rest' ? 'skipped' : 'replaced';
      w.modReason = change.reason;
      w.aiModifiedAt = nowISO;
      // Easy / rest swaps blunt intensity — zero anaerobic, halve aerobic for easy variants.
      if (newType === 'rest') {
        w.aerobic = 0;
        w.anaerobic = 0;
        w.estimatedDurationMin = 0;
      } else {
        w.anaerobic = 0;
        w.aerobic = Math.max(1, Math.round((w.aerobic ?? 0) * 0.6));
      }
    } else if (change.tool === 'reduce_workout') {
      const pct = p.pct as number;
      const factor = 1 - pct / 100;
      if (w.estimatedDurationMin) {
        w.estimatedDurationMin = Math.round(w.estimatedDurationMin * factor);
      }
      w.d = scaleWorkoutDescription(w.d, factor);
      if (!/\(reduced /i.test(w.n)) {
        w.n = `${w.n} (reduced ${pct}%)`;
      }
      // Scale both load components — keeps weekly TSS chip honest.
      w.aerobic = Math.round((w.aerobic ?? 0) * factor);
      w.anaerobic = Math.round((w.anaerobic ?? 0) * factor);
      w.status = 'reduced';
      w.modReason = change.reason;
      w.aiModifiedAt = nowISO;
    } else if (change.tool === 'adjust_intensity') {
      const zoneCap = p.zoneCap as 2 | 3;
      // Prepend a clear cap line; remove or downgrade hard interval tokens.
      const cap = `Z${zoneCap} cap — easy effort only. `;
      w.d = cap + w.d.replace(/\b(threshold|tempo|vo2|hard|sprint|race|tt)\b/gi, 'easy');
      if (!/Zone \d cap/i.test(w.n)) {
        w.n = `${w.n} (Z${zoneCap} cap)`;
      }
      // Zone 2/3 cap → drop anaerobic to zero; trim aerobic slightly.
      w.anaerobic = 0;
      w.aerobic = Math.round((w.aerobic ?? 0) * (zoneCap === 2 ? 0.7 : 0.85));
      w.status = 'reduced';
      w.modReason = `Z${zoneCap} cap — ${change.reason}`;
      w.aiModifiedAt = nowISO;
    } else if (change.tool === 'skip_workout') {
      w.skipped = true;
      w.status = 'skipped';
      w.modReason = change.reason;
      w.aiModifiedAt = nowISO;
      w.aerobic = 0;
      w.anaerobic = 0;
    }

    saveState();
    return;
  }

  // ─── Running: workoutMods entries that plan-view applies on render ───────────
  if (!wk.workoutMods) wk.workoutMods = [];
  const baseModFields = {
    name: p.workoutName as string,
    modReason: change.reason,
    aiModifiedAt: nowISO,
  };

  if (change.tool === 'swap_workout') {
    const newType = p.newType as WorkoutSwapType;
    wk.workoutMods.push({
      ...baseModFields,
      status: newType === 'rest' ? 'skipped' : 'replaced',
      newDistance: '',
      newType,
      newRpe: newType === 'rest' ? 0 : 2,
    });
  } else if (change.tool === 'reduce_workout') {
    wk.workoutMods.push({
      ...baseModFields,
      status: 'reduced',
      newDistance: '',
      autoReduceNote: `Reduced ${p.pct}% by AI coach`,
    });
  } else if (change.tool === 'adjust_intensity') {
    const zoneCap = p.zoneCap as 2 | 3;
    wk.workoutMods.push({
      ...baseModFields,
      status: 'reduced',
      newDistance: '',
      newType: 'easy',
      newRpe: zoneCap === 2 ? 2 : 3,
      zoneCap,
      autoReduceNote: `Capped at Zone ${zoneCap} by AI coach`,
    });
  } else if (change.tool === 'skip_workout') {
    wk.workoutMods.push({
      ...baseModFields,
      status: 'skipped',
      newDistance: '',
    });
  }

  saveState();
}

/** Restore the pre-AI snapshot for the most recently modified workout. */
export function undoPendingChange(change: PendingChange): boolean {
  const state = getMutableState();
  const wk = state.wks[change._weekIdx];
  if (!wk) return false;

  if ((state.eventType === 'triathlon' || state.eventType === 'hyrox') && wk.triWorkouts) {
    const w = wk.triWorkouts[change._workoutIdx];
    if (!w || !w.aiPreModSnapshot) return false;
    const s = w.aiPreModSnapshot;
    w.n = s.n;
    w.d = s.d;
    w.t = s.t;
    w.aerobic = s.aerobic;
    w.anaerobic = s.anaerobic;
    w.estimatedDurationMin = s.estimatedDurationMin;
    w.status = s.status;
    w.skipped = false;
    w.modReason = undefined;
    w.aiModifiedAt = undefined;
    w.aiPreModSnapshot = undefined;
    saveState();
    return true;
  }

  // Running: remove the last AI mod for this workout name.
  if (wk.workoutMods) {
    const name = change._params.workoutName as string;
    const idx = [...wk.workoutMods].reverse().findIndex(m => m.name === name && m.aiModifiedAt);
    if (idx === -1) return false;
    const realIdx = wk.workoutMods.length - 1 - idx;
    wk.workoutMods.splice(realIdx, 1);
    saveState();
    return true;
  }

  return false;
}
