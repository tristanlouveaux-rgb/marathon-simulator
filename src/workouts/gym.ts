import type { Workout, TrainingPhase } from '@/types';
import type { InjuryState } from '@/types/injury';
import { isDeloadWeek, abilityBandFromVdot } from './plan_engine';
import type { AbilityBand } from '@/types';

/**
 * Generate running-focused gym workouts for a given week.
 *
 * Phase-aware templates with ability scaling, deload handling, and injury adaptation.
 * Gym workouts are additive — they never replace running sessions.
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
        d: '2×10 Bodyweight Squat, 2×10 Glute Bridge, 2×12 Calf Raises',
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
// Feel cue per phase — appended to every session description
// ---------------------------------------------------------------------------

const FEEL_CUE: Record<TrainingPhase, string> = {
  base: 'Feel: heavy but controlled, 2-3 reps left in the tank',
  build: 'Feel: explosive and powerful, focus on speed of movement',
  peak: 'Feel: comfortable, just keeping the movement patterns sharp',
  taper: 'Feel: light and snappy, waking up the muscles',
};

const COMPLEMENTARY_NOTE = 'These are running-specific exercises. If you already have a gym routine, just add these key moves to your existing sessions.';

function withCue(d: string, phase: TrainingPhase): string {
  return `${d}. ${FEEL_CUE[phase]}`;
}

// ---------------------------------------------------------------------------
// Full templates (intermediate+, hybrid)
// ---------------------------------------------------------------------------

function getFullTemplates(phase: TrainingPhase): Workout[] {
  switch (phase) {
    case 'base':
      return [
        { t: 'gym', n: 'Heavy Lower Body', d: withCue('3×5 Back Squat @80% 1RM (heavy — ~2 reps in reserve), 3×8 Romanian Deadlift @60% 1RM (moderate load), 3×10 Hip Thrust @60% 1RM, 3×45s Front Plank', phase), r: 7, rpe: 7 },
        { t: 'gym', n: 'Unilateral & Core', d: withCue('3×8 Bulgarian Split Squat each @60% 1RM (challenging but steady), 3×10 Step-Ups @50% 1RM, 3×15 Banded Clamshells, 3×10 Pallof Press', phase), r: 7, rpe: 7 },
        { t: 'gym', n: 'Posterior Chain', d: withCue('3×5 Deadlift @80% 1RM (heavy — ~2 reps in reserve), 3×10 Single-Leg RDL @40% 1RM (moderate), 4×12 Calf Raises, 3×10 Nordic Curl (assisted)', phase), r: 7, rpe: 7 },
      ];
    case 'build':
      return [
        { t: 'gym', n: 'Power & Plyometrics', d: withCue('4×3 Jump Squat (explosive, bodyweight or light), 3×5 Front Squat @85% 1RM (heavy — last rep should be tough), 3×5 Single-Leg Bounds each, 3×8 Glute Bridge @60% 1RM', phase), r: 7, rpe: 7 },
        { t: 'gym', n: 'Explosive Strength', d: withCue('3×5 Trap-Bar Deadlift @85% 1RM (heavy — last rep should be tough), 3×5 Box Jumps, 3×8 Weighted Lunges @50% 1RM (moderate), 2×30s Side Plank each', phase), r: 7, rpe: 7 },
      ];
    case 'peak':
      return [
        { t: 'gym', n: 'Maintenance', d: withCue('2×5 Squat @75% 1RM (moderate — should feel easy), 2×5 Deadlift @75% 1RM (moderate — should feel easy), 2×8 Lunges @40% 1RM, 2×15 Calf Raises', phase), r: 5, rpe: 5 },
      ];
    case 'taper':
      return [
        { t: 'gym', n: 'Activation', d: withCue('2×5 Jump Squat (bodyweight), 2×5 Trap-Bar Deadlift @70% 1RM (light — smooth and fast), 2×8 Lunges (bodyweight), Short core circuit', phase), r: 4, rpe: 4 },
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
        { t: 'gym', n: 'Lower Body Foundation', d: withCue('3×8 Goblet Squat @50% 1RM (moderate — focus on depth), 3×10 Romanian Deadlift @40% 1RM (light, feel the hamstrings stretch), 3×10 Hip Thrust @50% 1RM, 3×30s Plank', phase), r: 6, rpe: 6 },
        { t: 'gym', n: 'Unilateral Strength', d: withCue('3×8 Split Squat each @40% 1RM (steady, balance first), 3×10 Step-Ups @30% 1RM, 3×12 Calf Raises, 3×10 Dead Bug', phase), r: 6, rpe: 6 },
        { t: 'gym', n: 'Posterior Chain', d: withCue('3×8 Kettlebell Deadlift @50% 1RM (moderate, hinge from hips), 3×10 Single-Leg Glute Bridge, 3×12 Calf Raises, 3×30s Side Plank', phase), r: 6, rpe: 6 },
      ];
    case 'build':
      return [
        { t: 'gym', n: 'Power Intro', d: withCue('3×5 Jump Squat (bodyweight, land softly), 3×8 Goblet Squat @55% 1RM, 3×8 Lunges @40% 1RM, 3×10 Glute Bridge', phase), r: 6, rpe: 6 },
        { t: 'gym', n: 'Strength & Core', d: withCue('3×8 Deadlift @60% 1RM (moderate — challenging but good form), 3×5 Box Jumps (low), 3×8 Step-Ups @40% 1RM, 2×30s Plank', phase), r: 6, rpe: 6 },
      ];
    case 'peak':
      return [
        { t: 'gym', n: 'Maintenance', d: withCue('2×8 Goblet Squat @40% 1RM (light), 2×8 Deadlift @40% 1RM (light — easy reps), 2×10 Lunges, 2×12 Calf Raises', phase), r: 5, rpe: 5 },
      ];
    case 'taper':
      return [
        { t: 'gym', n: 'Activation', d: withCue('2×5 Jump Squat (bodyweight), 2×10 Lunges, 2×10 Glute Bridge, Short core circuit', phase), r: 4, rpe: 4 },
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
        { t: 'gym', n: 'Bodyweight Foundation', d: withCue('3×10 Bodyweight Squat (slow, full depth), 3×10 Glute Bridge (squeeze at top), 3×10 Reverse Lunge each leg (steady), 3×30s Plank (flat back)', phase), r: 5, rpe: 5 },
        { t: 'gym', n: 'Core & Balance', d: withCue('3×10 Step-Ups (low box), 3×10 Single-Leg Glute Bridge each, 3×10 Dead Bug (slow), 3×20s Side Plank each', phase), r: 5, rpe: 5 },
        { t: 'gym', n: 'Movement Patterns', d: withCue('3×10 Wall Sit (30s), 3×10 Calf Raises (bodyweight), 3×10 Bird Dog each side, 3×10 Banded Clamshells', phase), r: 5, rpe: 5 },
      ];
    case 'build':
      return [
        { t: 'gym', n: 'Bodyweight Power', d: withCue('3×5 Squat Jumps (land softly), 3×10 Bodyweight Squat, 3×10 Walking Lunges, 3×10 Glute Bridge', phase), r: 5, rpe: 5 },
        { t: 'gym', n: 'Bodyweight Strength', d: withCue('3×10 Step-Ups, 3×10 Single-Leg RDL (bodyweight, balance focus), 3×12 Calf Raises, 2×30s Plank', phase), r: 5, rpe: 5 },
      ];
    case 'peak':
      return [
        { t: 'gym', n: 'Maintenance', d: withCue('2×10 Bodyweight Squat, 2×10 Glute Bridge, 2×10 Lunges, 2×12 Calf Raises', phase), r: 4, rpe: 4 },
      ];
    case 'taper':
      return [
        { t: 'gym', n: 'Activation', d: withCue('2×5 Squat Jumps (bodyweight), 2×10 Lunges, 2×10 Glute Bridge, Short core circuit', phase), r: 3, rpe: 3 },
      ];
  }
}
