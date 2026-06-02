/**
 * Canonical exercise identity for strength tracking.
 *
 * Three jobs over the FINITE exercise vocabulary the app prescribes
 * (src/workouts/gym.ts + src/workouts/injury-strength.ts):
 *
 *  1. `isWeightTrackable(name)` — is this a loaded barbell/dumbbell/kettlebell
 *     movement where remembering a kg makes sense? Rejects plyometrics, timed
 *     isometric core holds, mobility, and explicitly-bodyweight movements.
 *  2. `normalizeExerciseKey(name)` — a stable slug ("back-squat") that joins the
 *     same lift across sessions even as the template string varies. Returns ''
 *     for anything not weight-trackable, so callers skip it.
 *  3. `cleanExerciseName(name)` — strips the "@80% 1RM" garnish for display.
 *     The percentage-of-a-max-you-never-set is exactly the noise we're removing.
 *
 * Ordered first-match-wins rules, mirroring `muscleGroupsForExercise` in
 * strength-muscle-groups.ts. More specific patterns precede generic ones.
 * Nothing here is guessed: every pattern maps to a real line in the templates.
 */

/** "@80% 1RM", "@ 60 % 1rm" — the load-percentage garnish we drop from display. */
const LOAD_MARKER = /@\s*\d+\s*%\s*1\s*rm/i;

/** Never trackable: power/plyometric, isometric core, mobility. */
const NON_TRACKABLE = /plank|dead\s*bug|bird\s*dog|pallof|clamshell|wall\s*sit|core\s*circuit|nordic|jump|bound|box\s*jump|\bhop\b|mobility|stretch/i;

/** Explicitly bodyweight — no external load to remember. */
const BODYWEIGHT = /bodyweight|\bbw\b/i;

/** The loadable movement patterns in the vocabulary (lower-body + the on-demand
 *  generator's upper-body pool: press / row / pulldown / curl). */
const LOADABLE = /squat|deadlift|\brdl\b|romanian|hip\s*thrust|glute\s*bridge|split\s*squat|step-?up|lunge|calf\s*raise|tibialis\s*raise|bench|overhead\s*press|shoulder\s*press|\brow\b|pulldown|curl/i;

/**
 * Trackable = a loadable movement whose prescription specifies a load target
 * (the "@X% 1RM" marker). Requiring the marker (rather than merely an implement
 * word) is deliberate: it excludes the bodyweight beginner variants AND the
 * injury-rehab sessions (which prescribe light/band work with no load target),
 * so a rehab-light "Dumbbell Row" never pollutes a lift's est-1RM trend. Every
 * loaded template line, and every line the generator composes, carries the
 * marker.
 */
export function isWeightTrackable(name: string): boolean {
  if (!name) return false;
  if (NON_TRACKABLE.test(name)) return false;
  if (BODYWEIGHT.test(name)) return false;
  if (!LOADABLE.test(name)) return false;
  return LOAD_MARKER.test(name);
}

interface KeyRule {
  test: RegExp;
  key: string;
}

/**
 * Ordered slug rules. Squat variants stay DISTINCT (front/back/goblet progress
 * independently); true synonyms merge (romanian deadlift -> rdl; bulgarian
 * split squat -> split-squat). Specific before generic: single-leg-rdl before
 * rdl before deadlift; trap-bar / kettlebell deadlift before bare deadlift;
 * split-squat and the named squats before bare squat; single-leg glute bridge
 * before glute bridge.
 */
const KEY_RULES: KeyRule[] = [
  { test: /single-?leg\s*rdl/i, key: 'single-leg-rdl' },
  { test: /\brdl\b|romanian\s*deadlift/i, key: 'rdl' },
  { test: /trap-?bar\s*deadlift/i, key: 'trap-bar-deadlift' },
  { test: /kettlebell\s*deadlift/i, key: 'kettlebell-deadlift' },
  { test: /deadlift/i, key: 'deadlift' },
  { test: /hip\s*thrust/i, key: 'hip-thrust' },
  { test: /single-?leg\s*glute\s*bridge/i, key: 'single-leg-glute-bridge' },
  { test: /glute\s*bridge/i, key: 'glute-bridge' },
  { test: /bulgarian\s*split\s*squat|split\s*squat/i, key: 'split-squat' },
  { test: /front\s*squat/i, key: 'front-squat' },
  { test: /back\s*squat/i, key: 'back-squat' },
  { test: /goblet\s*squat/i, key: 'goblet-squat' },
  { test: /squat/i, key: 'squat' },
  { test: /step-?up/i, key: 'step-up' },
  { test: /lunge/i, key: 'lunge' },
  { test: /calf\s*raise/i, key: 'calf-raise' },
  { test: /tibialis\s*raise/i, key: 'tibialis-raise' },
  // Upper-body (on-demand generator pool). Specific before generic.
  { test: /bench\s*press|bench/i, key: 'bench-press' },
  { test: /overhead\s*press|shoulder\s*press/i, key: 'overhead-press' },
  { test: /lat\s*pulldown|pulldown/i, key: 'lat-pulldown' },
  { test: /\brow\b/i, key: 'row' },
  { test: /curl/i, key: 'curl' },
];

/** Canonical slug for a lift, or '' when the movement isn't weight-trackable. */
export function normalizeExerciseKey(name: string): string {
  if (!isWeightTrackable(name)) return '';
  for (const rule of KEY_RULES) {
    if (rule.test.test(name)) return rule.key;
  }
  return '';
}

/** Strip the "@80% 1RM" load garnish for display; collapse whitespace. */
export function cleanExerciseName(name: string): string {
  return name.replace(LOAD_MARKER, '').replace(/\s{2,}/g, ' ').trim();
}
