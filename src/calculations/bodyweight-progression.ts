/**
 * Bodyweight progression for beginners / novices.
 *
 * Weight-tracking is meaningless for bodyweight work, so weaker athletes never
 * progressed — the same static template repeated every week and the RIR feedback
 * the guided player collects was discarded. This module fills that gap: it
 * remembers a LADDER RUNG per movement family and advances it from the same RIR
 * autoregulation the weight system uses (`suggestNextWeight`).
 *
 * The ladder is built entirely from movements + loads that already appear in the
 * beginner/novice templates (`gym.ts`), sequenced into a progression: more reps →
 * a harder variant → a light external load (graduating toward the novice
 * templates). Rep/time increments are modest, standard beginner steps.
 *
 * Policy (endorsed by Tristan, 2026-06-03):
 *  - Advance one rung after 2 consecutive "reps-left" (easy) sessions.
 *  - On "barely" (too hard): step DOWN one rung (then climb back up normally).
 *  - "about-right": hold.
 *  - Only in base/build phases (mirrors the weight bump's phase gate).
 *  - Top of the ladder introduces a light load (then weight-tracking takes over).
 */

import type { TrainingPhase } from '@/types/training';
import type { Workout } from '@/types';
import type { BodyweightFamily, BodyweightProgressEntry, RirBucket } from '@/types/strength-log';

/** Sessions of "reps-left" needed to advance a rung. */
export const BODYWEIGHT_ADVANCE_STREAK = 2;

/**
 * The ladder. Each rung is a full, parser-safe prescription line
 * ("SxR Name (cue) (rest)"). Bodyweight rungs lead; the final rung(s) introduce a
 * light load (anchored to the novice template %s), after which weight-tracking
 * owns further progression. Movements + loads all exist in the gym templates.
 */
export const BODYWEIGHT_LADDER: Record<BodyweightFamily, string[]> = {
  squat: [
    '3x10 Bodyweight Squat (Controlled depth, chest up) (60s rest)',
    '3x15 Bodyweight Squat (Controlled depth, chest up) (60s rest)',
    '3x20 Bodyweight Squat (Controlled depth, chest up) (60s rest)',
    '3x8 Goblet Squat @50% 1RM (Moderate, focus on depth and control) (90s rest)',
    '3x8 Goblet Squat @55% 1RM (Moderate, focus on depth and control) (90s rest)',
  ],
  lunge: [
    '3x10 each leg Reverse Lunge (Steady, touch the back knee down lightly) (60s rest)',
    '3x12 each leg Reverse Lunge (Steady, touch the back knee down lightly) (60s rest)',
    '3x10 each leg Walking Lunge (Controlled, knee tracks the toe) (60s rest)',
    '3x8 each leg Lunge @40% 1RM (Controlled descent, knee tracks the toe) (75s rest)',
  ],
  hinge: [
    '3x10 Glute Bridge (Squeeze the glutes at the top) (45s rest)',
    '3x12 Glute Bridge (Squeeze the glutes at the top) (45s rest)',
    '3x10 each leg Single-Leg Glute Bridge (Keep the hips level) (45s rest)',
    '3x10 each leg Single-Leg RDL (Balance first, hinge from the hip) (60s rest)',
    '3x8 Romanian Deadlift @40% 1RM (Hinge from the hips, feel the hamstring) (90s rest)',
  ],
  calf: [
    '3x12 Calf Raises (Full range, pause at the top) (45s rest)',
    '3x15 Calf Raises (Full range, pause at the top) (45s rest)',
    '3x12 each leg Single-Leg Calf Raise (Full height, control the drop) (45s rest)',
    '3x12 Standing Calf Raise @50% 1RM (Full range, pause at the top) (60s rest)',
  ],
  plank: [
    '3x30s Plank (Flat back, brace steadily) (30s rest)',
    '3x45s Plank (Flat back, brace steadily) (30s rest)',
    '3x60s Plank (Flat back, brace steadily) (30s rest)',
    '3x30s each side Side Plank (Stack the hips, brace hard) (30s rest)',
    '3x45s each side Side Plank (Stack the hips, brace hard) (30s rest)',
  ],
  'step-up': [
    '3x10 each leg Step-Ups (Drive through the heel, control the way down) (60s rest)',
    '3x12 each leg Step-Ups (Drive through the heel, control the way down) (60s rest)',
    '3x10 each leg Step-Ups @30% 1RM (Drive through the heel) (60s rest)',
    '3x10 each leg Step-Ups @40% 1RM (Drive through the heel) (75s rest)',
  ],
};

/**
 * Map a movement name (or a whole prescription line) to its progression family,
 * or '' if it isn't a laddered bodyweight movement. Excludes plyometrics (jump /
 * box), already-weight-tracked compounds (hip thrust, kettlebell), single-leg/
 * Bulgarian split squats, and static core/mobility (dead bug, bird dog, wall sit,
 * clamshell) which carry no ladder.
 */
export function bodyweightFamilyKey(name: string): BodyweightFamily | '' {
  const n = name.toLowerCase();
  if (/jump|box\s*jump|\bhop\b|split\s*squat|bulgarian|dead\s*bug|bird\s*dog|wall\s*sit|clamshell|pallof|suitcase|hip\s*thrust|kettlebell/.test(n)) return '';
  if (/side\s*plank|plank/.test(n)) return 'plank';
  if (/glute\s*bridge|\brdl\b|romanian/.test(n)) return 'hinge';
  if (/calf/.test(n)) return 'calf';
  if (/step-?up/.test(n)) return 'step-up';
  if (/lunge/.test(n)) return 'lunge';
  if (/squat/.test(n)) return 'squat';
  return '';
}

/** Clamp a level into a family's ladder. */
function clampLevel(family: BodyweightFamily, level: number): number {
  return Math.max(0, Math.min(BODYWEIGHT_LADDER[family].length - 1, level));
}

/**
 * Apply one session's RIR outcome to a family's progress entry, returning the
 * next entry. Mirrors `suggestNextWeight`'s structure: only base/build advance;
 * "reps-left" builds the streak (advance at the threshold); "barely" steps down
 * a rung; "about-right" holds (resets the streak).
 */
export function applyBodyweightOutcome(
  prev: BodyweightProgressEntry | undefined,
  family: BodyweightFamily,
  rir: RirBucket | undefined,
  phase: TrainingPhase | undefined,
  dateISO: string,
): BodyweightProgressEntry {
  const base: BodyweightProgressEntry = prev ?? { family, level: 0, easyStreak: 0, lastDate: dateISO };
  const next: BodyweightProgressEntry = { ...base, family, lastRir: rir, lastDate: dateISO };

  const building = phase === 'base' || phase === 'build';
  if (!building || !rir) { next.easyStreak = 0; return next; }

  if (rir === 'reps-left') {
    const streak = base.easyStreak + 1;
    if (streak >= BODYWEIGHT_ADVANCE_STREAK) {
      next.level = clampLevel(family, base.level + 1);
      next.easyStreak = 0;
    } else {
      next.easyStreak = streak;
    }
  } else if (rir === 'barely') {
    next.level = clampLevel(family, base.level - 1);
    next.easyStreak = 0;
  } else {
    next.easyStreak = 0; // 'about-right' → hold
  }
  return next;
}

/** Per-exercise record shape we read from (subset of SetRecord). */
interface BwRecord { exerciseName: string; exerciseIndex: number; rirBucket?: RirBucket; }

/**
 * Update the bodyweight progress map from a completed session's set records.
 * Mutates `progress` in place and returns whether anything changed. One update
 * per family (first occurrence), using that exercise's logged RIR.
 */
export function persistBodyweightProgress(
  records: BwRecord[],
  progress: Record<string, BodyweightProgressEntry>,
  phase: TrainingPhase | undefined,
  dateISO: string,
): boolean {
  const seen = new Set<BodyweightFamily>();
  let changed = false;
  for (const r of records) {
    const family = bodyweightFamilyKey(r.exerciseName);
    if (!family || seen.has(family)) continue;
    // The RIR bucket is captured on the exercise's final set; find it for this exercise.
    const rir = records.filter(x => x.exerciseIndex === r.exerciseIndex).map(x => x.rirBucket).filter(Boolean).pop();
    if (!rir) continue;
    seen.add(family);
    progress[family] = applyBodyweightOutcome(progress[family], family, rir as RirBucket, phase, dateISO);
    changed = true;
  }
  return changed;
}

/**
 * Read-back: rewrite a beginner/novice workout's bodyweight lines to the
 * athlete's earned rung. Only rewrites a movement the athlete has PROGRESSED
 * (level > 0), so a fresh athlete's session is unchanged (regression-safe). One
 * rewrite per family (first occurrence); the stretch / core-circuit lines and
 * non-laddered movements pass through untouched.
 */
export function applyBodyweightProgress(
  wo: Workout,
  progress: Record<string, BodyweightProgressEntry> | undefined,
): Workout {
  if (!progress) return wo;
  const seen = new Set<BodyweightFamily>();
  const lines = String(wo.d ?? '').split('\n').map(line => {
    const t = line.trim();
    if (!t || /^stretch|^core circuit/i.test(t)) return line;
    const family = bodyweightFamilyKey(line);
    if (!family || seen.has(family)) return line;
    const entry = progress[family];
    if (!entry || entry.level <= 0) return line; // fresh → unchanged
    seen.add(family);
    return BODYWEIGHT_LADDER[family][clampLevel(family, entry.level)];
  });
  return { ...wo, d: lines.join('\n') };
}
