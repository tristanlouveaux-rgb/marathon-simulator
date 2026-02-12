import type { Workout, TrainingPhase } from '@/types';
import type { InjuryState } from '@/types/injury';
import { isDeloadWeek, abilityBandFromVdot } from './plan_engine';
import type { AbilityBand } from '@/types';

/**
 * Generate running-focused gym workouts for a given week.
 *
 * Phase-aware templates with ability scaling, deload handling, and injury adaptation.
 * Gym workouts are additive — they never replace running sessions.
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
  injuryState?: InjuryState | null
): Workout[] {
  if (gymSessionsPerWeek <= 0) return [];

  // ---- Injury filtering ----
  if (injuryState && injuryState.active) {
    const ip = injuryState.injuryPhase;
    if (ip === 'acute' || ip === 'rehab' || ip === 'test_capacity') return [];
    if (ip === 'return_to_run') {
      if (injuryState.returnToRunLevel < 5) return [];
      // Levels 5-8: one light return session
      return [{
        t: 'gym',
        n: 'Return Strength',
        d: [
          '2x10 Bodyweight Squat (Slow and controlled — no pain) (60s rest)',
          '2x10 Glute Bridge (Light activation) (30s rest)',
          '2x12 Calf Raises (Easy — full range) (30s rest)',
          'Stretch between sets: focus on injured area',
        ].join('\n'),
        r: 3,
        rpe: 3,
      }];
    }
    // 'resolved' or other — fall through to normal generation
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
  let isDeload = false;
  if (weekIndex != null && weekIndex > 0) {
    isDeload = isDeloadWeek(weekIndex, ability);
    if (isDeload) {
      sessionCount = Math.max(0, sessionCount - 1);
    }
  }
  if (sessionCount <= 0) return [];

  // ---- Generate templates ----
  let templates: Workout[];
  if (isBeginner) {
    templates = getBeginnerTemplates(phase);
  } else if (isNovice) {
    templates = getNoviceTemplates(phase);
  } else {
    templates = getFullTemplates(phase);
  }

  // Take only the number of sessions we need
  const workouts = templates.slice(0, sessionCount);

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
// Full templates (intermediate+, hybrid)
// ---------------------------------------------------------------------------

function getFullTemplates(phase: TrainingPhase): Workout[] {
  switch (phase) {
    case 'base':
      return [
        { t: 'gym', n: 'Heavy Lower Body', d: [
          '3x5 Back Squat @80% 1RM (Should feel heavy — 2 reps in reserve) (2-3 min rest)',
          '3x8 Romanian Deadlift @60% 1RM (Moderate — feel the hamstring stretch) (90s rest)',
          '3x10 Hip Thrust @60% 1RM (Squeeze glutes at the top for 1s) (60-90s rest)',
          '3x45s Front Plank (Flat back, brace core) (30-60s rest)',
          'Stretch between sets: hip flexors, quads, calves',
        ].join('\n'), r: 7, rpe: 7 },
        { t: 'gym', n: 'Unilateral & Core', d: [
          '3x8 each leg Bulgarian Split Squat @60% 1RM (Challenging but steady) (90s rest)',
          '3x10 each leg Step-Ups @50% 1RM (Drive through the heel) (60-90s rest)',
          '3x15 Banded Clamshells (Slow and controlled) (30s rest)',
          '3x10 Pallof Press (Resist rotation, brace core) (30-60s rest)',
          'Stretch between sets: hip flexors, glutes, ankles',
        ].join('\n'), r: 7, rpe: 7 },
        { t: 'gym', n: 'Posterior Chain', d: [
          '3x5 Deadlift @80% 1RM (Should feel heavy — 2 reps in reserve) (2-3 min rest)',
          '3x10 each leg Single-Leg RDL @40% 1RM (Balance first, then load) (60-90s rest)',
          '4x12 Calf Raises (Full range — pause at the top) (30-60s rest)',
          '3x10 Nordic Curl assisted (Slow eccentric, push back up to reset) (60-90s rest)',
          'Stretch between sets: hamstrings, calves, hip flexors',
        ].join('\n'), r: 7, rpe: 7 },
      ];
    case 'build':
      return [
        { t: 'gym', n: 'Power & Plyometrics', d: [
          '4x3 Jump Squat bodyweight or light (Explosive — maximum height, land soft) (90s rest)',
          '3x5 Front Squat @85% 1RM (Heavy — last rep should be tough) (2-3 min rest)',
          '3x5 each leg Single-Leg Bounds (Powerful push through the ankle) (60-90s rest)',
          '3x8 Glute Bridge @60% 1RM (Squeeze 2s at top) (60s rest)',
          'Stretch between sets: hip flexors, quads, ankles',
        ].join('\n'), r: 7, rpe: 7 },
        { t: 'gym', n: 'Explosive Strength', d: [
          '3x5 Trap-Bar Deadlift @85% 1RM (Heavy — last rep should be tough) (2-3 min rest)',
          '3x5 Box Jumps (Land softly, step down to reset) (60-90s rest)',
          '3x8 each leg Weighted Lunges @50% 1RM (Controlled descent) (60-90s rest)',
          '2x30s each side Side Plank (Stack hips, brace hard) (30s rest)',
          'Stretch between sets: hamstrings, hip flexors, calves',
        ].join('\n'), r: 7, rpe: 7 },
      ];
    case 'peak':
      return [
        { t: 'gym', n: 'Maintenance', d: [
          '2x5 Squat @75% 1RM (Should feel comfortable — maintaining patterns) (2 min rest)',
          '2x5 Deadlift @75% 1RM (Smooth reps — not grinding) (2 min rest)',
          '2x8 each leg Lunges @40% 1RM (Light and controlled) (60s rest)',
          '2x15 Calf Raises (Easy — maintain range of motion) (30s rest)',
          'Stretch between sets: full lower body',
        ].join('\n'), r: 5, rpe: 5 },
      ];
    case 'taper':
      return [
        { t: 'gym', n: 'Activation', d: [
          '2x5 Jump Squat bodyweight (Light and snappy — wake up the legs) (60s rest)',
          '2x5 Trap-Bar Deadlift @70% 1RM (Smooth and fast — no grinding) (90s rest)',
          '2x8 each leg Lunges bodyweight (Just moving well) (30s rest)',
          'Core circuit: 30s plank + 20s each side plank (No rest between exercises)',
          'Stretch to finish: 5 min full lower body',
        ].join('\n'), r: 4, rpe: 4 },
      ];
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
          '3x8 Goblet Squat @50% 1RM (Moderate — focus on depth and control) (90s rest)',
          '3x10 Romanian Deadlift @40% 1RM (Light — feel the hamstring stretch) (60-90s rest)',
          '3x10 Hip Thrust @50% 1RM (Squeeze glutes at the top) (60s rest)',
          '3x30s Plank (Flat back, breathe steadily) (30s rest)',
          'Stretch between sets: hip flexors, hamstrings, calves',
        ].join('\n'), r: 6, rpe: 6 },
        { t: 'gym', n: 'Unilateral Strength', d: [
          '3x8 each leg Split Squat @40% 1RM (Steady — balance first) (90s rest)',
          '3x10 each leg Step-Ups @30% 1RM (Drive through the heel) (60s rest)',
          '3x12 Calf Raises (Full range of motion) (30s rest)',
          '3x10 Dead Bug (Slow — keep lower back flat) (30s rest)',
          'Stretch between sets: hip flexors, quads, calves',
        ].join('\n'), r: 6, rpe: 6 },
        { t: 'gym', n: 'Posterior Chain', d: [
          '3x8 Kettlebell Deadlift @50% 1RM (Moderate — hinge from hips) (90s rest)',
          '3x10 each leg Single-Leg Glute Bridge (Squeeze at the top) (30-60s rest)',
          '3x12 Calf Raises (Full range of motion) (30s rest)',
          '3x30s each side Side Plank (Stack hips, breathe steadily) (30s rest)',
          'Stretch between sets: hamstrings, glutes, calves',
        ].join('\n'), r: 6, rpe: 6 },
      ];
    case 'build':
      return [
        { t: 'gym', n: 'Power Intro', d: [
          '3x5 Jump Squat bodyweight (Land softly — absorb through the knees) (60-90s rest)',
          '3x8 Goblet Squat @55% 1RM (Moderate — controlled depth) (90s rest)',
          '3x8 each leg Lunges @40% 1RM (Steady descent) (60s rest)',
          '3x10 Glute Bridge (Squeeze at the top) (30s rest)',
          'Stretch between sets: hip flexors, quads, ankles',
        ].join('\n'), r: 6, rpe: 6 },
        { t: 'gym', n: 'Strength & Core', d: [
          '3x8 Deadlift @60% 1RM (Moderate — challenging but good form) (90s rest)',
          '3x5 Box Jumps low box (Land softly, step down) (60-90s rest)',
          '3x8 each leg Step-Ups @40% 1RM (Drive through the heel) (60s rest)',
          '2x30s Plank (Flat back, brace core) (30s rest)',
          'Stretch between sets: hamstrings, hip flexors, calves',
        ].join('\n'), r: 6, rpe: 6 },
      ];
    case 'peak':
      return [
        { t: 'gym', n: 'Maintenance', d: [
          '2x8 Goblet Squat @40% 1RM (Light — just maintaining the pattern) (60s rest)',
          '2x8 Deadlift @40% 1RM (Light — easy reps) (60s rest)',
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
          '3x10 Bodyweight Squat (Slow and controlled — full depth) (60s rest)',
          '3x10 Glute Bridge (Squeeze at the top for 1s) (30-60s rest)',
          '3x10 each leg Reverse Lunge (Steady — touch knee gently to floor) (60s rest)',
          '3x30s Plank (Flat back — breathe steadily) (30s rest)',
          'Stretch between sets: hip flexors, quads, calves',
        ].join('\n'), r: 5, rpe: 5 },
        { t: 'gym', n: 'Core & Balance', d: [
          '3x10 each leg Step-Ups low box (Drive through the heel) (60s rest)',
          '3x10 each leg Single-Leg Glute Bridge (Squeeze at the top) (30-60s rest)',
          '3x10 Dead Bug (Slow — keep lower back pressed into floor) (30s rest)',
          '3x20s each side Side Plank (Hips stacked, breathe steadily) (30s rest)',
          'Stretch between sets: hip flexors, glutes, ankles',
        ].join('\n'), r: 5, rpe: 5 },
        { t: 'gym', n: 'Movement Patterns', d: [
          '3x30s Wall Sit (Back flat against wall, thighs parallel) (30-60s rest)',
          '3x10 Calf Raises bodyweight (Full range — pause at the top) (30s rest)',
          '3x10 each side Bird Dog (Slow — opposite arm and leg) (30s rest)',
          '3x10 Banded Clamshells (Slow and controlled) (30s rest)',
          'Stretch between sets: hip flexors, calves, hamstrings',
        ].join('\n'), r: 5, rpe: 5 },
      ];
    case 'build':
      return [
        { t: 'gym', n: 'Bodyweight Power', d: [
          '3x5 Squat Jumps (Land softly — absorb through knees) (60-90s rest)',
          '3x10 Bodyweight Squat (Controlled depth) (60s rest)',
          '3x10 each leg Walking Lunges (Steady pace) (60s rest)',
          '3x10 Glute Bridge (Squeeze at the top) (30s rest)',
          'Stretch between sets: hip flexors, quads, calves',
        ].join('\n'), r: 5, rpe: 5 },
        { t: 'gym', n: 'Bodyweight Strength', d: [
          '3x10 each leg Step-Ups (Drive through the heel) (60s rest)',
          '3x10 each leg Single-Leg RDL bodyweight (Balance focus — hold a wall if needed) (60s rest)',
          '3x12 Calf Raises (Full range of motion) (30s rest)',
          '2x30s Plank (Flat back, brace core) (30s rest)',
          'Stretch between sets: hamstrings, calves, hip flexors',
        ].join('\n'), r: 5, rpe: 5 },
      ];
    case 'peak':
      return [
        { t: 'gym', n: 'Maintenance', d: [
          '2x10 Bodyweight Squat (Easy — just maintaining movement) (30-60s rest)',
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
