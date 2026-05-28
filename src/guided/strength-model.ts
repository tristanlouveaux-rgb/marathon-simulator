/**
 * Strength-session model. Parses a gym/strength workout's newline-separated
 * description into a flat, ordered list of guided sets so the guided-strength
 * controller can walk exercise -> set -> rest. Mode-agnostic: works for the
 * injury-adapted sessions (src/workouts/injury-strength.ts) and the normal
 * gym templates (src/workouts/gym.ts), which share the line format:
 *
 *   "{sets}x{reps} {Name} ({cue}) ({rest period})"
 *   last line may be a "Stretch ..." note (not a set).
 *
 * Rest periods are read from the description (existing data). Never invented.
 */

import type { Workout } from '@/types';
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';

/** One working set in the flattened guided sequence. */
export interface GuidedSet {
  exerciseName: string;
  exerciseIndex: number;   // 0-based index of the parent exercise
  setIndex: number;        // 0-based set within the exercise
  setCount: number;        // total sets for this exercise
  reps: string;            // "12", "10 each leg", "40s", "" when not parseable
  cue: string;             // feel cue(s), joined with " · "
  restSec: number;         // rest AFTER this set (0 = none parsed)
}

export interface StrengthSession {
  title: string;
  sets: GuidedSet[];       // flattened, in prescribed order
  exerciseCount: number;
  stretch: string | null;  // closing stretch/mobility note, if present
  /** When true, the guided overlay surfaces a "Take your time" pause between
   *  sets (no countdown) and the user manually advances. HYROX training / test
   *  sessions set this. Rest between stations is athlete-paced. */
  manualAdvance?: boolean;
}

/** Parse a rest period like "45s rest", "2-3 min rest", "60-90s rest" to the
 *  lower-bound seconds. Lower bound is the conservative default; the user can
 *  extend with +30s in the overlay. Returns 0 when no rest is expressed. */
export function parseRestSeconds(note: string): number {
  const m = note.match(/(\d+)(?:\s*[-–]\s*\d+)?\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toLowerCase();
  return /^m/.test(unit) ? n * 60 : n;
}

/** Number of sets from a "{N}x..." prefix; 1 when there is no Nx prefix. */
function parseSetCount(main: string): number {
  const m = main.match(/^\s*(\d+)\s*[x×]/i);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Split "3x10 each leg Reverse Lunge" into reps ("10 each leg") and name. */
function parseRepsAndName(main: string): { reps: string; name: string } {
  // "{sets}x{reps}{ each X?} {Name}". Reps is the token after the x, plus an
  // optional "each leg/side/arm" qualifier; the remainder is the exercise name.
  const m = main.match(/^\s*\d+\s*[x×]\s*(\S+(?:\s+each\s+\w+)?)\s+(.+)$/i);
  if (m) return { reps: m[1].trim(), name: m[2].trim() };
  // No Nx prefix (e.g. "Core circuit: ..."): whole line is the name.
  return { reps: '', name: main.trim() };
}

/** True for the closing stretch / mobility line. */
function isStretchLine(line: string): boolean {
  return /^stretch\b/i.test(line.trim());
}

/**
 * Parse a workout into a guided strength session. Each exercise line expands
 * into `setCount` working sets; the rest period attaches to each set (the
 * controller suppresses rest after the final set). Returns null when the
 * workout has no parseable exercises.
 */
export function parseStrengthSession(workout: Workout): StrengthSession | null {
  const desc = String((workout as any).d || '');
  const rawLines = desc.split('\n').map(l => l.trim()).filter(Boolean);
  if (!rawLines.length) return null;

  const sets: GuidedSet[] = [];
  let stretch: string | null = null;
  let exerciseIndex = 0;

  for (const line of rawLines) {
    if (isStretchLine(line)) { stretch = line; continue; }

    const notes = Array.from(line.matchAll(/\(([^)]*)\)/g)).map(m => m[1].trim());
    const main = line.replace(/\s*\([^)]*\)/g, '').trim();
    if (!main) continue;

    // The rest period is the note that mentions "rest"; the others are cues.
    const restNote = notes.find(n => /rest/i.test(n)) ?? '';
    const restSec = parseRestSeconds(restNote);
    const cue = notes.filter(n => n !== restNote).join(' · ');

    const setCount = parseSetCount(main);
    const { reps, name } = parseRepsAndName(main);

    for (let i = 0; i < setCount; i++) {
      sets.push({
        exerciseName: name,
        exerciseIndex,
        setIndex: i,
        setCount,
        reps,
        cue,
        restSec,
      });
    }
    exerciseIndex++;
  }

  if (!sets.length) return null;

  return {
    title: workout.n || 'Strength',
    sets,
    exerciseCount: exerciseIndex,
    stretch,
  };
}

/** Is this workout a strength/gym session the guided flow applies to? */
export function isStrengthWorkout(workout: Workout): boolean {
  const t = (workout.t || '').toLowerCase();
  if (t === 'gym' || t === 'strength') return true;
  return /strength|gym/i.test(workout.n || '');
}

// ───────────────────────────────────────────────────────────────────────────
// HYROX: each component (station or run) becomes one GuidedSet with setCount=1
// so the existing controller, overlay and progress rings work unchanged. HYROX
// is continuous between components in a race, so the default restSec is 0;
// the overlay still surfaces an in-active timer the athlete can use as the
// station clock.
// ───────────────────────────────────────────────────────────────────────────

/** Describe one HYROX component as a name + target for the guided UI. */
function describeHyroxComponent(c: HyroxComponent): { name: string; amount: string } {
  if (c.type === 'run') {
    const distM = c.distanceM ?? 1000;
    const km = distM / 1000;
    const amount = km >= 1
      ? `${km % 1 === 0 ? km : km.toFixed(1)} km`
      : `${distM} m`;
    return { name: 'Run', amount };
  }
  const display = STATION_DISPLAY[c.type as HyroxStation];
  const name = display?.name ?? String(c.type);
  // Prefer the component's explicit reps; otherwise the race-standard distance/reps.
  const amount = typeof c.reps === 'number' ? `${c.reps} reps` : (display?.distance ?? '');
  return { name, amount };
}

/** Parse a HYROX station/brick workout into the same flat guided shape used
 *  by strength sessions, so the overlay / controller / progress rings are
 *  reused unchanged. Returns null if there are no components. */
export function parseHyroxSession(workout: Workout): StrengthSession | null {
  const components = (workout as any).hyroxComponents as HyroxComponent[] | undefined;
  if (!components || components.length === 0) return null;

  const sets: GuidedSet[] = components.map((c, i) => {
    const { name, amount } = describeHyroxComponent(c);
    return {
      exerciseName: name,
      exerciseIndex: i,
      setIndex: 0,
      setCount: 1,
      reps: amount,
      cue: '',
      restSec: 0,
    };
  });

  return {
    title: workout.n || 'HYROX session',
    sets,
    exerciseCount: components.length,
    stretch: null,
    // HYROX training/testing is athlete-paced between components: hit a station
    // hard, take as much rest as you need, start the next when ready.
    manualAdvance: true,
  };
}

/** Pick the right parser based on workout shape. HYROX workouts carry a
 *  `hyroxComponents` array; strength/gym workouts carry the newline `.d`. */
export function parseGuidedSession(workout: Workout): StrengthSession | null {
  const components = (workout as any).hyroxComponents;
  if (Array.isArray(components) && components.length > 0) {
    return parseHyroxSession(workout);
  }
  return parseStrengthSession(workout);
}
