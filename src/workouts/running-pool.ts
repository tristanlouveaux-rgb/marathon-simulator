/**
 * World-class, rotating "Running strength" pool.
 *
 * Running strength is multi-modal — heavy compounds (3-5 reps @80%), high-rep
 * eccentric calf work (15-20), timed isometric holds, low-rep explosive plyo,
 * tibialis/foot drills — so a single goal rep-scheme (the Upper/Lower/Full
 * model) does NOT fit. Each exercise therefore carries its OWN prescription.
 *
 * A session is BALANCED (one per category, in priority order), the variant
 * within each category ROTATES by week (`slotIndex`, mirroring the HYROX
 * pickStations rotation), the number of categories scales with the time the
 * user has, and base-phase de-prioritises high-soreness movements. Everything
 * is grounded in docs/SCIENCE_LOG.md §BA. All [PROP] doses endorsed by Tristan.
 *
 * Only used by the on-demand generator's "Running strength" focus. The plan
 * engine's auto-gym (no focus) keeps its phase templates (Phase 2).
 */

import type { Workout, TrainingPhase } from '@/types';
import type { GymGoalScheme } from '@/constants/strength-constants';
import { GYM_INTENSITY_PCT_STEP } from '@/constants/strength-constants';
import { composeExerciseLine, type PoolExercise, type GymRestStyle, type GymIntensity } from './gym-pool';

export type RunningStrengthCategory =
  | 'max-strength' | 'single-leg' | 'posterior' | 'calf-foot'
  | 'hip-stability' | 'plyo' | 'core';

export interface RunningPoolExercise {
  name: string;
  sets: number;
  reps: string;             // "5" | "12 each leg" | "30s" | "20m each side"
  loadPct?: number;         // present => emits "@X% 1RM" => weight-tracks
  cue: string;
  restSec: number;
  /** Eccentric / plyometric / high-CNS — pushed to the back of its category in
   *  the base phase, mirroring HYROX's ECCENTRIC_HEAVY_STATIONS reorder. */
  highSoreness?: boolean;
}

// ── The library (docs/SCIENCE_LOG.md §BB). 4-8 variants per category. ─────────

export const RUNNING_POOL: Record<RunningStrengthCategory, RunningPoolExercise[]> = {
  'max-strength': [
    { name: 'Back Squat', sets: 4, reps: '5', loadPct: 80, restSec: 180, cue: 'Brace, sit between the hips, drive up' },
    { name: 'Trap-Bar Deadlift', sets: 3, reps: '5', loadPct: 80, restSec: 180, cue: 'Flat back, push the floor away' },
    { name: 'Front Squat', sets: 3, reps: '5', loadPct: 80, restSec: 180, cue: 'Tall chest, elbows up' },
    { name: 'Deadlift', sets: 3, reps: '5', loadPct: 80, restSec: 180, cue: 'Heavy, 2 reps in reserve' },
  ],
  'single-leg': [
    { name: 'Bulgarian Split Squat', sets: 3, reps: '8 each leg', loadPct: 60, restSec: 90, cue: 'Tall torso, drive through the front heel' },
    { name: 'Step-Up', sets: 3, reps: '10 each leg', loadPct: 50, restSec: 75, cue: 'Drive through the heel, control the way down' },
    { name: 'Weighted Lunge', sets: 3, reps: '8 each leg', loadPct: 50, restSec: 75, cue: 'Controlled descent, knee tracks the toe' },
    { name: 'Single-Leg Squat to box', sets: 3, reps: '6 each leg', cue: 'Sit to the box, stand without rocking', restSec: 90 },
  ],
  'posterior': [
    { name: 'Romanian Deadlift', sets: 3, reps: '8', loadPct: 60, restSec: 90, cue: 'Hinge from the hips, feel the hamstring stretch' },
    { name: 'Single-Leg RDL', sets: 3, reps: '10 each leg', loadPct: 40, restSec: 75, cue: 'Balance first, then load' },
    { name: 'Nordic Curl', sets: 3, reps: '6', cue: 'Slow eccentric, push back up to reset', restSec: 90, highSoreness: true },
    { name: 'Hip Thrust', sets: 3, reps: '10', loadPct: 60, restSec: 75, cue: 'Squeeze the glutes 1s at the top' },
  ],
  'calf-foot': [
    { name: 'Standing Calf Raise', sets: 4, reps: '12', loadPct: 50, restSec: 60, cue: 'Full range, pause at the top' },
    { name: 'Soleus Calf Raise', sets: 4, reps: '15', loadPct: 50, restSec: 60, cue: 'Knee bent 90 degrees, slow up and down' },
    { name: 'Single-Leg Calf Raise', sets: 3, reps: '12 each leg', cue: 'Full height, no hop, control the drop', restSec: 60 },
    { name: 'Eccentric Calf Drop', sets: 3, reps: '15 each leg', cue: 'Lower for 3s below the step, reset with both feet', restSec: 60, highSoreness: true },
    { name: 'Isometric Calf Hold', sets: 4, reps: '30s', cue: 'Hold mid-range, drive the ball of the foot down', restSec: 60 },
    { name: 'Tibialis Raise', sets: 3, reps: '18', loadPct: 40, restSec: 45, cue: 'Back to the wall, pull the toes up slowly' },
    { name: 'Heel Walks', sets: 3, reps: '20m', cue: 'Toes up, walk on the heels', restSec: 45 },
  ],
  'hip-stability': [
    { name: 'Copenhagen Plank', sets: 3, reps: '20s each side', cue: 'Top foot on the bench, lift the hips, hold level', restSec: 45 },
    { name: 'Banded Lateral Walk', sets: 3, reps: '15 each way', cue: 'Band above the knees, stay low, no torso lean', restSec: 45 },
    { name: 'Banded Clamshell', sets: 3, reps: '15 each side', cue: 'Slow and controlled, hips stacked', restSec: 30 },
    { name: 'Single-Leg Glute Bridge', sets: 3, reps: '10 each leg', cue: 'Squeeze at the top, keep the hips level', restSec: 45 },
    { name: 'Side-Lying Hip Abduction', sets: 3, reps: '15 each side', cue: 'Lead with the heel, no hip roll', restSec: 30 },
  ],
  'plyo': [
    { name: 'Pogo Hops', sets: 4, reps: '20', cue: 'Stiff legs, tiny fast ground contacts', restSec: 60 },
    { name: 'Box Jumps', sets: 3, reps: '5', cue: 'Land softly, step down to reset', restSec: 90 },
    { name: 'Single-Leg Bounds', sets: 3, reps: '5 each leg', cue: 'Powerful push through the ankle', restSec: 90, highSoreness: true },
    { name: 'Jump Squat', sets: 4, reps: '3', cue: 'Explosive, maximum height, land soft', restSec: 90 },
    { name: 'Depth Jump', sets: 3, reps: '5', cue: 'Drop from a low box, rebound instantly', restSec: 120, highSoreness: true },
  ],
  'core': [
    { name: 'Pallof Press', sets: 3, reps: '10 each side', cue: 'Resist the rotation, brace the core', restSec: 45 },
    { name: 'Suitcase Carry', sets: 3, reps: '20m each side', cue: 'Tall, level shoulders, do not lean', restSec: 60 },
    { name: 'Side Plank', sets: 3, reps: '30s each side', cue: 'Stack the hips, brace hard', restSec: 30 },
    { name: 'Dead Bug', sets: 3, reps: '10', cue: 'Slow, keep the lower back flat', restSec: 30 },
    { name: 'Bird Dog', sets: 3, reps: '10 each side', cue: 'Opposite arm and leg, no hip rock', restSec: 30 },
  ],
};

/** Session build order: the essentials lead, plyo/core fill as time grows. */
const CATEGORY_ORDER: RunningStrengthCategory[] = [
  'max-strength', 'single-leg', 'posterior', 'calf-foot', 'hip-stability', 'core', 'plyo',
];

/** How many exercises (categories) to include for a target session length.
 *  Running strength scales BREADTH with time, not just sets. */
function exerciseCountForTime(targetMin: number): number {
  if (targetMin <= 20) return 4;
  if (targetMin <= 30) return 5;
  if (targetMin <= 45) return 6;
  if (targetMin <= 60) return 7;
  if (targetMin <= 75) return 8;
  return 9;
}

/** Categories to draw a SECOND exercise from, in order, once the count exceeds
 *  the 7 base categories (75 -> +1 from calf-foot, 90 -> + single-leg too). */
const SECOND_PICK_ORDER: RunningStrengthCategory[] = ['calf-foot', 'single-leg'];

/** Rotate a category's variant by week. Base phase pushes high-soreness moves
 *  to the back first so early-block sessions aren't the sorest. */
function pickVariant(category: RunningStrengthCategory, slotIndex: number, offset: number, phase?: TrainingPhase): RunningPoolExercise {
  let pool = RUNNING_POOL[category];
  if (phase === 'base') {
    pool = [...pool.filter(e => !e.highSoreness), ...pool.filter(e => e.highSoreness)];
  }
  // Euclidean modulo: JS `%` keeps the sign, so a negative slotIndex (e.g. an
  // s.w that drifted negative — a documented incident class) would index past
  // the start and return undefined → crash. This keeps the pick in range.
  const n = pool.length;
  return pool[(((slotIndex + offset) % n) + n) % n];
}

const INTENSITY_RPE: Record<GymIntensity, number> = { easier: 6, standard: 7, harder: 8 };

function intensityLoadStep(intensity: GymIntensity): number {
  return intensity === 'easier' ? -GYM_INTENSITY_PCT_STEP : intensity === 'harder' ? GYM_INTENSITY_PCT_STEP : 0;
}

/** Compose one prescription line via the shared composer (parser-safe + marker-
 *  correct), applying the intensity load shift to loaded exercises. */
function lineFor(ex: RunningPoolExercise, restStyle: GymRestStyle, loadStep: number): string {
  const loadPct = ex.loadPct != null ? Math.min(90, Math.max(40, ex.loadPct + loadStep)) : undefined;
  const scheme: GymGoalScheme = {
    sets: ex.sets,
    reps: ex.reps,
    loadPct: loadPct ?? 0,
    restSec: ex.restSec,
    restCircuitSec: Math.max(20, Math.round(ex.restSec * 0.6)),
  };
  const poolEx: PoolExercise = loadPct != null
    ? { name: ex.name, region: 'lower', loadable: true, cue: ex.cue }
    : { name: ex.name, region: 'core', loadable: false, cue: ex.cue, fixedSets: ex.sets, fixedReps: ex.reps, fixedRestSec: ex.restSec };
  return composeExerciseLine(poolEx, scheme, restStyle);
}

/** The plyo move that pairs with a heavy lead lift (dynamic correspondence): a
 *  squat pattern → Jump Squat (vertical), a hinge/deadlift → Box Jumps. */
function matchedPlyoFor(leadName: string): RunningPoolExercise {
  const plyo = RUNNING_POOL['plyo'];
  const find = (n: string) => plyo.find(e => e.name === n)!;
  return /squat/i.test(leadName) ? find('Jump Squat') : find('Box Jumps');
}

/**
 * Build a rotating, balanced running-strength session. `slotIndex` (the week)
 * drives variant rotation so sessions vary week to week; `targetMin` scales the
 * number of categories; `intensity` shifts loaded %s + RPE; `phase` reorders
 * high-soreness moves in base. Owns its own sizing (do NOT run tuneGymWorkout).
 *
 * `contrastPairing` (build phase only) pairs the heavy lead lift with a matched
 * jump as a power block (post-activation potentiation, Science for Sport). The
 * pairing instruction lives in the lead's CUE — never a bare label line, which
 * `parseStrengthSession` would turn into a junk set. When on, the standalone plyo
 * pick is dropped so the session never prescribes two jumps.
 */
export function buildRunningStrengthWorkout(
  slotIndex: number,
  targetMin: number,
  intensity: GymIntensity,
  restStyle: GymRestStyle,
  phase?: TrainingPhase,
  contrastPairing = false,
): Workout {
  const count = exerciseCountForTime(targetMin);
  const loadStep = intensityLoadStep(intensity);
  const useContrast = contrastPairing && phase === 'build';

  const chosen: RunningPoolExercise[] = [];
  // First pass: one per category in priority order, up to count.
  CATEGORY_ORDER.forEach((cat, i) => {
    if (chosen.length < Math.min(count, CATEGORY_ORDER.length)) {
      chosen.push(pickVariant(cat, slotIndex, i, phase));
    }
  });
  // Second pass: extra variants for longer sessions (different from the first).
  let extra = 0;
  while (chosen.length < count) {
    const cat = SECOND_PICK_ORDER[extra % SECOND_PICK_ORDER.length];
    const offset = CATEGORY_ORDER.indexOf(cat) + 1 + Math.floor(extra / SECOND_PICK_ORDER.length);
    chosen.push(pickVariant(cat, slotIndex, offset, phase));
    extra++;
  }

  const pairedPlyo = useContrast ? matchedPlyoFor(chosen[0].name) : null;
  const lines: string[] = [];
  chosen.forEach((ex, idx) => {
    if (pairedPlyo && idx === 0) {
      // Heavy lead lift carries the pairing note in its cue; the matched jump
      // follows as its own (parser-safe) line.
      // NB: the pairing cue must not contain the word "rest" — parseStrengthSession
      // classifies the first parenthetical matching /rest/i as the rest note, which
      // would swallow the cue (found in Playwright dogfooding).
      const paired = { ...ex, cue: `${ex.cue}. Power pair: after each set, explode into the ${pairedPlyo.name.toLowerCase()} below, then take 2 to 3 min` };
      lines.push(lineFor(paired, restStyle, loadStep));
      lines.push(lineFor(pairedPlyo, restStyle, 0));
      return;
    }
    // The standalone plyo pick (only present on long sessions) is delivered as
    // the power pair instead, so skip it to avoid two jumps.
    if (useContrast && categoryOf(ex.name) === 'plyo') return;
    lines.push(lineFor(ex, restStyle, loadStep));
  });
  lines.push('Stretch to finish: 3-5 min full body');

  const rpe = INTENSITY_RPE[intensity];
  const name = restStyle === 'circuit' ? 'Running Strength (circuit)' : 'Running Strength';
  return { t: 'gym', n: name, d: lines.join('\n'), r: rpe, rpe, estimatedDurationMin: targetMin } as Workout;
}

/**
 * A standalone plyometric session, drawing ONLY from the plyo category. It is
 * the on-demand "Plyometrics" focus — a deliberate menu choice, no opt-in.
 *
 * The easier/standard/harder lever selects a difficulty TIER rather than a load
 * shift (plyo is bodyweight, so the loaded-% step is already a no-op on it). The
 * `highSoreness` flag already marks the two high-CNS moves (Single-Leg Bounds,
 * Depth Jump), so it doubles as the tier signal — no new constant:
 *   easier   → low-CNS only (Pogo Hops, Box Jumps, Jump Squat); never depth jumps
 *   harder   → leads with the high-CNS moves, still includes low ones
 *   standard → low-led spread; spicy moves sit at the back
 * Base phase pushes the high-CNS moves to the back unless the user explicitly
 * picked `harder` (they asked for it), mirroring `pickVariant`'s base reorder.
 *
 * A plyo session is SHORT by design. Within a ~12–30 min window, time scales
 * both the number of moves and the per-move sets to land near a foot-contact
 * target. Total contacts run from a literature floor (60) up to the athlete's
 * ability ceiling (`contactCeiling`, the caller passes 100 / 120 / 140 by
 * experience — beginner / intermediate / advanced, the 80→140 progression range
 * in the plyometrics literature). Sets are the standard plyometric volume dial;
 * rep counts stay as the pool prescribes (`[PROP]`-endorsed). Bodyweight lines
 * carry no load marker → no `liftKey` → not weight-tracked, but the session
 * still logs as an activity and feeds leg-load like any gym session.
 */
export const PLYO_CONTACT_FLOOR = 60;
const PLYO_MIN_MIN = 12;
const PLYO_MAX_MIN = 30;

/** Foot contacts one set of a plyo move produces (counts both legs for unilateral). */
function plyoContactsPerSet(reps: string): number {
  const m = reps.match(/(\d+)/);
  const n = m ? Number(m[1]) : 0;
  return /each\s+(leg|side)/i.test(reps) ? n * 2 : n;
}

export function buildPlyometricsWorkout(
  slotIndex: number,
  targetMin: number,
  intensity: GymIntensity,
  restStyle: GymRestStyle,
  phase?: TrainingPhase,
  contactCeiling = 120,
): Workout {
  const pool = RUNNING_POOL['plyo'];
  const low = pool.filter(e => !e.highSoreness);   // Pogo Hops, Box Jumps, Jump Squat
  const high = pool.filter(e => e.highSoreness);    // Single-Leg Bounds, Depth Jump

  // Rotate WITHIN the low/high groups so week-to-week variety can never defeat
  // the tier ordering. (A global rotation could lead a base-phase session with
  // depth jumps and rotate the cheap high-contact pogos out of a short session,
  // which also inflated sets past time-feasibility — caught in dogfooding.)
  // Euclidean modulo guards a drifted-negative slotIndex.
  const rot = (arr: RunningPoolExercise[], k: number): RunningPoolExercise[] => {
    const len = arr.length;
    if (len === 0) return arr;
    const start = ((k % len) + len) % len;
    return [...arr.slice(start), ...arr.slice(0, start)];
  };
  let rotated: RunningPoolExercise[];
  if (intensity === 'easier') rotated = rot(low, slotIndex);
  else if (intensity === 'harder') rotated = [...rot(high, slotIndex), ...rot(low, slotIndex)];
  else rotated = [...rot(low, slotIndex), ...rot(high, slotIndex)]; // standard: low always leads (base-safe by construction)
  const n = rotated.length;

  // Time → foot-contact target (floor → ability ceiling) over the short plyo
  // window, and → move count. Both scale, so the slider always changes the
  // session.
  const minutes = Math.max(PLYO_MIN_MIN, Math.min(PLYO_MAX_MIN, targetMin));
  const frac = (minutes - PLYO_MIN_MIN) / (PLYO_MAX_MIN - PLYO_MIN_MIN);
  const targetContacts = Math.round(PLYO_CONTACT_FLOOR + (contactCeiling - PLYO_CONTACT_FLOOR) * frac);
  const count = minutes <= 17 ? 3 : minutes <= 24 ? 4 : 5;
  const chosen = rotated.slice(0, Math.min(count, n));

  // Scale sets to approach the contact target (min 2, max 6 sets per move — a
  // sane plyo range, not a model constant). rep counts are untouched.
  const baseContacts = chosen.reduce((sum, ex) => sum + ex.sets * plyoContactsPerSet(ex.reps), 0);
  const volumeScale = baseContacts > 0 ? targetContacts / baseContacts : 1;

  const loadStep = intensityLoadStep(intensity); // no-op on bodyweight plyo, real on the loaded strength below
  const lines: string[] = chosen.map(ex => {
    const sets = Math.max(2, Math.min(6, Math.round(ex.sets * volumeScale)));
    return lineFor({ ...ex, sets }, restStyle, loadStep);
  });

  // Past the short plyo window the jumping dose is already capped (contacts clamp
  // at PLYO_MAX_MIN). Extra time becomes strength work placed AFTER the plyo
  // (explosive first, while the CNS is fresh), drawn from the running-strength
  // categories. The caller caps the slider at PLYO_MAX_MIN for beginners, so only
  // intermediate+ reach the loaded compounds here.
  const hasStrength = targetMin > PLYO_MAX_MIN;
  if (hasStrength) {
    const STRENGTH_AFTER_PLYO: RunningStrengthCategory[] = ['max-strength', 'single-leg', 'posterior', 'calf-foot', 'hip-stability', 'core'];
    const strengthCount = Math.min(STRENGTH_AFTER_PLYO.length, Math.ceil((targetMin - PLYO_MAX_MIN) / 8));
    for (let i = 0; i < strengthCount; i++) {
      lines.push(lineFor(pickVariant(STRENGTH_AFTER_PLYO[i], slotIndex, i, phase), restStyle, loadStep));
    }
  }

  lines.push('Stretch to finish: 3-5 min full body');

  const rpe = INTENSITY_RPE[intensity];
  const base = hasStrength ? 'Power + Strength' : 'Plyometrics';
  const name = restStyle === 'circuit' ? `${base} (circuit)` : base;
  return { t: 'gym', n: name, d: lines.join('\n'), r: rpe, rpe, estimatedDurationMin: targetMin } as Workout;
}

/** Exposed for tests: the category of a given exercise name (or null). */
export function categoryOf(name: string): RunningStrengthCategory | null {
  for (const cat of CATEGORY_ORDER) {
    if (RUNNING_POOL[cat].some(e => e.name === name)) return cat;
  }
  return null;
}

/** Find a pool exercise by exact (case-insensitive) name, or null. Used by the
 *  exercise-swap feature to resolve a remembered substitute back to its full
 *  prescription. */
export function findRunningPoolExercise(name: string): RunningPoolExercise | null {
  const want = name.trim().toLowerCase();
  for (const cat of CATEGORY_ORDER) {
    const hit = RUNNING_POOL[cat].find(e => e.name.toLowerCase() === want);
    if (hit) return hit;
  }
  return null;
}

/** Compose one canonical, parser-safe prescription line for a pool exercise at
 *  standard intensity (the swap feature substitutes a movement's own vetted
 *  prescription, not a franken-line spliced from the original). */
export function composeRunningPoolLine(ex: RunningPoolExercise, restStyle: GymRestStyle = 'traditional'): string {
  return lineFor(ex, restStyle, 0);
}
