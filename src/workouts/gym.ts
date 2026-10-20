import type { Workout, TrainingPhase } from '@/types';
import type { InjuryState } from '@/types/injury';
import { isRunningDeloadWeek, abilityBandFromVdot } from './plan_engine';
import { injuryStrengthDecision } from './injury-strength';
import type { AbilityBand } from '@/types';
import type { AbilityBand as HyroxAbilityBand } from '@/types/triathlon';
import { buildPoolWorkout, type GymRestStyle, type GymIntensity } from './gym-pool';
import { buildRunningStrengthWorkout } from './running-pool';
import { applyBodyweightProgress } from '@/calculations/bodyweight-progression';
import type { BodyweightProgressEntry } from '@/types/strength-log';
import type { GymGoal } from '@/constants/strength-constants';

/** Phase periodisation for the auto-planned running-strength pool (Phase 2):
 *  base/build = full 45-min sessions, peak = maintenance (30 min), taper =
 *  activation (20 min, lighter). PROPOSED, endorsed by Tristan. See §BA. */
const RUNNING_STRENGTH_PHASE: Record<TrainingPhase, { min: number; intensity: GymIntensity }> = {
  base: { min: 45, intensity: 'standard' },
  build: { min: 45, intensity: 'standard' },
  peak: { min: 30, intensity: 'easier' },
  taper: { min: 20, intensity: 'easier' },
};

/** What a generated gym session targets. 'running'/'lower'/undefined use the
 *  existing running-supportive templates; 'upper'/'full' use the goal-driven
 *  pool (gym-pool.ts); 'plyometrics' is a standalone explosive session built by
 *  buildPlyometricsWorkout in the generator UI; 'hyrox' is handled by the
 *  generator UI, not here. */
export type GymFocus = 'running' | 'lower' | 'upper' | 'full' | 'plyometrics';

/**
 * Generate gym workouts for a given week.
 *
 * Default (focus 'running'/'lower'/undefined): phase-aware, ability-scaled,
 * deload- and injury-aware running-supportive templates, additive, never
 * replacing running sessions. The plan engine calls it this way (no focus), so
 * its behaviour is unchanged.
 *
 * On-demand focus 'upper'/'full' + a goal: a single goal-driven session from the
 * exercise pool (gym-pool.ts), bypassing the phase/ability/deload template path.
 *
 * Description format: exercises separated by \n, one per line.
 * Each line: "{sets}x{reps} {Exercise} {load} ({feel cue}) ({rest period})"
 * Last line is a stretch tip (starts with "Stretch").
 */
export function generateGymWorkouts(
  phase: TrainingPhase,
  gymSessionsPerWeek: number,
  fitnessLevel: string,
  weekIndex?: number,
  totalWeeks?: number,
  vdot?: number,
  injuryState?: InjuryState | null,
  focus?: GymFocus,
  goal?: GymGoal,
  restStyle?: GymRestStyle,
  plyoInGym = false,
  bodyweightProgress?: Record<string, BodyweightProgressEntry>,
  /** Continuous (no-race) plan: strength deloads the block's Deload week, the
   *  week the runs deload (isRunningDeloadWeek). */
  continuousMode = false,
): Workout[] {
  if (gymSessionsPerWeek <= 0) return [];

  // ---- Injury adaptation (region-aware, shared with triathlon/HYROX) ----
  // A leg injury keeps upper-body + core strength; a shoulder injury keeps
  // lower-body + core; the acute phase or a trunk injury pauses loaded
  // strength. Replaces the previous "drop everything in early phases" rule so
  // an injured runner maintains the unaffected regions (relative rest +
  // regional load substitution). See src/workouts/injury-strength.ts.
  // Injury wins over the chosen focus, a generated upper session still yields
  // to the region-aware adapted session when injured.
  const strength = injuryStrengthDecision(injuryState);
  if (strength.kind === 'none') return [];
  if (strength.kind === 'adapted') return [strength.workout];
  // kind === 'normal' (not injured / resolved) → fall through.

  // ---- On-demand Upper / Lower / Full focus: goal-driven pool session ----
  // Not phase/deload-scaled, the user asked for this session, and the goal sets
  // the scheme. Only 'running' falls through to the running-supportive templates.
  if (focus === 'upper' || focus === 'lower' || focus === 'full') {
    return [buildPoolWorkout(focus, goal ?? 'general', restStyle ?? 'traditional')];
  }

  // ---- Ability band ----
  const ability: AbilityBand = vdot
    ? abilityBandFromVdot(vdot, fitnessLevel)
    : 'intermediate';
  const isBeginner = fitnessLevel === 'total_beginner' || fitnessLevel === 'beginner';
  const isNovice = fitnessLevel === 'novice' || fitnessLevel === 'returning';

  // ---- Session count by phase ----
  let sessionCount = getPhaseSessionCount(phase, gymSessionsPerWeek);

  // ---- Deload handling ----
  // Same week as the running engine (isRunningDeloadWeek): the ability cycle in
  // a race plan, the block's Deload week ('taper') in a continuous plan. On the
  // ability cycle a beginner's continuous plan cut strength in its Intensify
  // week while the runs deloaded the week after.
  let isDeload = false;
  if (weekIndex != null && weekIndex > 0) {
    isDeload = isRunningDeloadWeek(weekIndex, ability, phase, continuousMode);
    if (isDeload) {
      sessionCount = Math.max(0, sessionCount - 1);
    }
  }
  if (sessionCount <= 0) return [];

  // ---- Generate the week's sessions ----
  // Beginner / novice keep their bodyweight-appropriate templates. Intermediate+
  // get the world-class rotating running-strength pool (Phase 2), phase-
  // periodised, each session a distinct rotation slot so the week varies.
  let workouts: Workout[];
  if (isBeginner) {
    // Bodyweight progression: rewrite each movement to the athlete's earned rung
    // (no-op for a fresh athlete, so the template is unchanged until they progress).
    workouts = getBeginnerTemplates(phase).slice(0, sessionCount).map(w => applyBodyweightProgress(w, bodyweightProgress));
  } else if (isNovice) {
    workouts = getNoviceTemplates(phase).slice(0, sessionCount).map(w => applyBodyweightProgress(w, bodyweightProgress));
  } else {
    const { min, intensity } = RUNNING_STRENGTH_PHASE[phase];
    workouts = [];
    for (let i = 0; i < sessionCount; i++) {
      const w = buildRunningStrengthWorkout((weekIndex ?? 1) * 3 + i, min, intensity, 'traditional', phase, plyoInGym);
      if (sessionCount > 1) w.n = `Running Strength ${String.fromCharCode(65 + i)}`; // A / B / C
      workouts.push(w);
    }
  }

  // Apply deload suffix
  if (isDeload) {
    for (const w of workouts) {
      w.n += ' (Deload)';
      w.rpe = Math.max(2, (w.rpe || w.r) - 1);
      w.r = w.rpe;
    }
  }

  return workouts;
}

// ---------------------------------------------------------------------------
// HYROX strength content (lane H2b part 2)
// ---------------------------------------------------------------------------

/** Minutes gym.ts gives a running-strength session in a phase
 *  (RUNNING_STRENGTH_PHASE: base and build 45, peak 30, taper 20). */
export function runningStrengthPhaseMinutes(phase: TrainingPhase): number {
  return RUNNING_STRENGTH_PHASE[phase].min;
}

/** True for a prescription line that loads the lower body heavily (an
 *  "@X% 1RM" lift: every loaded line in these templates and the running pool
 *  is a lower-body lift) or holds plyometrics (jumps, bounds, hops): the
 *  sheet's eccentric.min_gap list ("heavy lower-body strength or
 *  plyometrics"). */
function isEccentricStrengthLine(line: string): boolean {
  return /@\s*\d+\s*%\s*1RM/i.test(line) || /\b(jumps?|bounds?|hops?)\b/i.test(line);
}

/**
 * Strength content for a HYROX plan (lane H2b part 2; parameter sheet
 * strength.content: heavy compound lifts, single-leg work, Romanian
 * deadlifts, calf raises with isometric holds, plyometrics). Drawn from this
 * module's own dosing by ability band, as generateGymWorkouts draws it:
 * total_beginner and beginner the bodyweight templates, novice the novice
 * templates, intermediate and above the rotating running-strength pool at
 * the phase's intensity (RUNNING_STRENGTH_PHASE). A deload takes RPE 1 lower,
 * as generateGymWorkouts' deload does. `light`: the week before race week's
 * light session, the activation template (bodyweight; heavy lifting stops 7
 * days before the race, sheet taper.content). `minutes`: the running pool
 * sizes its exercise count by it (exerciseCountForTime); the templates hold
 * their own 4 exercises. The closing stretch line is kept only for a
 * standalone session (`standalone`). Planning side.
 */
export function hyroxStrengthContent(
  band: HyroxAbilityBand,
  phase: TrainingPhase,
  slotIndex: number,
  opts: { minutes: number; light?: boolean; deload?: boolean; standalone?: boolean },
): { name: string; lines: string[]; rpe: number; eccentric: boolean } {
  const isBeginner = band === 'total_beginner' || band === 'beginner';
  const pick = (ws: Workout[]): Workout => ws[((slotIndex % ws.length) + ws.length) % ws.length];
  let w: Workout;
  if (opts.light) w = (isBeginner ? getBeginnerTemplates('taper') : getNoviceTemplates('taper'))[0];
  else if (isBeginner) w = pick(getBeginnerTemplates(phase));
  else if (band === 'novice') w = pick(getNoviceTemplates(phase));
  else {
    const { intensity } = RUNNING_STRENGTH_PHASE[phase];
    w = buildRunningStrengthWorkout(slotIndex, opts.minutes, intensity, 'traditional', phase);
  }
  const all = String(w.d ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const lines = opts.standalone ? all : all.filter(l => !/^stretch\b/i.test(l));
  const base = w.rpe ?? w.r ?? 5;
  const rpe = opts.deload ? Math.max(2, base - 1) : base;
  return { name: w.n, lines, rpe, eccentric: lines.some(isEccentricStrengthLine) };
}

// ---------------------------------------------------------------------------
// Phase session count scaling
// ---------------------------------------------------------------------------

function getPhaseSessionCount(phase: TrainingPhase, maxSessions: number): number {
  //  User selected | Base | Build | Peak | Taper
  //  3             | 3    | 2     | 1    | 1
  //  2             | 2    | 2     | 1    | 1
  //  1             | 1    | 1     | 1    | 0
  switch (phase) {
    case 'base':
      return maxSessions;
    case 'build':
      return Math.min(maxSessions, 2);
    case 'peak':
      return 1;
    case 'taper':
      return maxSessions >= 2 ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Novice templates (lighter loads, standard exercises)
// ---------------------------------------------------------------------------

function getNoviceTemplates(phase: TrainingPhase): Workout[] {
  switch (phase) {
    case 'base':
      return [
        { t: 'gym', n: 'Lower Body Foundation', d: [
          '3x8 Goblet Squat @50% 1RM (Moderate, focus on depth and control) (90s rest)',
          '3x10 Romanian Deadlift @40% 1RM (Light, feel the hamstring stretch) (60-90s rest)',
          '3x10 Hip Thrust @50% 1RM (Squeeze glutes at the top) (60s rest)',
          '3x30s Plank (Flat back, breathe steadily) (30s rest)',
          'Stretch between sets: hip flexors, hamstrings, calves',
        ].join('\n'), r: 6, rpe: 6 },
        { t: 'gym', n: 'Unilateral Strength', d: [
          '3x8 each leg Split Squat @40% 1RM (Steady, balance first) (90s rest)',
          '3x10 each leg Step-Ups @30% 1RM (Drive through the heel) (60s rest)',
          '3x12 Calf Raises (Full range of motion) (30s rest)',
          '3x10 Dead Bug (Slow, keep lower back flat) (30s rest)',
          'Stretch between sets: hip flexors, quads, calves',
        ].join('\n'), r: 6, rpe: 6 },
        { t: 'gym', n: 'Posterior Chain', d: [
          '3x8 Kettlebell Deadlift @50% 1RM (Moderate, hinge from hips) (90s rest)',
          '3x10 each leg Single-Leg Glute Bridge (Squeeze at the top) (30-60s rest)',
          '3x12 Calf Raises (Full range of motion) (30s rest)',
          '3x30s each side Side Plank (Stack hips, breathe steadily) (30s rest)',
          'Stretch between sets: hamstrings, glutes, calves',
        ].join('\n'), r: 6, rpe: 6 },
      ];
    case 'build':
      return [
        { t: 'gym', n: 'Power Intro', d: [
          '3x5 Jump Squat bodyweight (Land softly, absorb through the knees) (60-90s rest)',
          '3x8 Goblet Squat @55% 1RM (Moderate, controlled depth) (90s rest)',
          '3x8 each leg Lunges @40% 1RM (Steady descent) (60s rest)',
          '3x10 Glute Bridge (Squeeze at the top) (30s rest)',
          'Stretch between sets: hip flexors, quads, ankles',
        ].join('\n'), r: 6, rpe: 6 },
        { t: 'gym', n: 'Strength & Core', d: [
          '3x8 Deadlift @60% 1RM (Moderate, challenging but good form) (90s rest)',
          '3x5 Box Jumps low box (Land softly, step down) (60-90s rest)',
          '3x8 each leg Step-Ups @40% 1RM (Drive through the heel) (60s rest)',
          '2x30s Plank (Flat back, brace core) (30s rest)',
          'Stretch between sets: hamstrings, hip flexors, calves',
        ].join('\n'), r: 6, rpe: 6 },
      ];
    case 'peak':
      return [
        { t: 'gym', n: 'Maintenance', d: [
          '2x8 Goblet Squat @40% 1RM (Light, just maintaining the pattern) (60s rest)',
          '2x8 Deadlift @40% 1RM (Light, easy reps) (60s rest)',
          '2x10 each leg Lunges bodyweight (Controlled movement) (30s rest)',
          '2x12 Calf Raises (Easy) (30s rest)',
          'Stretch between sets: full lower body',
        ].join('\n'), r: 5, rpe: 5 },
      ];
    case 'taper':
      return [
        { t: 'gym', n: 'Activation', d: [
          '2x5 Jump Squat bodyweight (Light and snappy) (60s rest)',
          '2x10 each leg Lunges bodyweight (Just moving well) (30s rest)',
          '2x10 Glute Bridge (Easy activation) (30s rest)',
          'Core circuit: 30s plank + 20s each side plank (No rest between)',
          'Stretch to finish: 5 min full lower body',
        ].join('\n'), r: 4, rpe: 4 },
      ];
  }
}

// ---------------------------------------------------------------------------
// Beginner templates (bodyweight, lower RPE, form cues)
// ---------------------------------------------------------------------------

function getBeginnerTemplates(phase: TrainingPhase): Workout[] {
  switch (phase) {
    case 'base':
      return [
        { t: 'gym', n: 'Bodyweight Foundation', d: [
          '3x10 Bodyweight Squat (Slow and controlled, full depth) (60s rest)',
          '3x10 Glute Bridge (Squeeze at the top for 1s) (30-60s rest)',
          '3x10 each leg Reverse Lunge (Steady, touch knee gently to floor) (60s rest)',
          '3x30s Plank (Flat back, breathe steadily) (30s rest)',
          'Stretch between sets: hip flexors, quads, calves',
        ].join('\n'), r: 5, rpe: 5 },
        { t: 'gym', n: 'Core & Balance', d: [
          '3x10 each leg Step-Ups low box (Drive through the heel) (60s rest)',
          '3x10 each leg Single-Leg Glute Bridge (Squeeze at the top) (30-60s rest)',
          '3x10 Dead Bug (Slow, keep lower back pressed into floor) (30s rest)',
          '3x20s each side Side Plank (Hips stacked, breathe steadily) (30s rest)',
          'Stretch between sets: hip flexors, glutes, ankles',
        ].join('\n'), r: 5, rpe: 5 },
        { t: 'gym', n: 'Movement Patterns', d: [
          '3x30s Wall Sit (Back flat against wall, thighs parallel) (30-60s rest)',
          '3x10 Calf Raises bodyweight (Full range, pause at the top) (30s rest)',
          '3x10 each side Bird Dog (Slow, opposite arm and leg) (30s rest)',
          '3x10 Banded Clamshells (Slow and controlled) (30s rest)',
          'Stretch between sets: hip flexors, calves, hamstrings',
        ].join('\n'), r: 5, rpe: 5 },
      ];
    case 'build':
      return [
        { t: 'gym', n: 'Bodyweight Power', d: [
          '3x5 Squat Jumps (Land softly, absorb through knees) (60-90s rest)',
          '3x10 Bodyweight Squat (Controlled depth) (60s rest)',
          '3x10 each leg Walking Lunges (Steady pace) (60s rest)',
          '3x10 Glute Bridge (Squeeze at the top) (30s rest)',
          'Stretch between sets: hip flexors, quads, calves',
        ].join('\n'), r: 5, rpe: 5 },
        { t: 'gym', n: 'Bodyweight Strength', d: [
          '3x10 each leg Step-Ups (Drive through the heel) (60s rest)',
          '3x10 each leg Single-Leg RDL bodyweight (Balance focus, hold a wall if needed) (60s rest)',
          '3x12 Calf Raises (Full range of motion) (30s rest)',
          '2x30s Plank (Flat back, brace core) (30s rest)',
          'Stretch between sets: hamstrings, calves, hip flexors',
        ].join('\n'), r: 5, rpe: 5 },
      ];
    case 'peak':
      return [
        { t: 'gym', n: 'Maintenance', d: [
          '2x10 Bodyweight Squat (Easy, just maintaining movement) (30-60s rest)',
          '2x10 Glute Bridge (Light activation) (30s rest)',
          '2x10 each leg Lunges (Controlled) (30s rest)',
          '2x12 Calf Raises (Easy) (30s rest)',
          'Stretch between sets: full lower body',
        ].join('\n'), r: 4, rpe: 4 },
      ];
    case 'taper':
      return [
        { t: 'gym', n: 'Activation', d: [
          '2x5 Squat Jumps bodyweight (Light and snappy) (60s rest)',
          '2x10 each leg Lunges (Just moving well) (30s rest)',
          '2x10 Glute Bridge (Easy activation) (30s rest)',
          'Core circuit: 20s plank + 15s each side plank (No rest between)',
          'Stretch to finish: 5 min full lower body',
        ].join('\n'), r: 3, rpe: 3 },
      ];
  }
}
