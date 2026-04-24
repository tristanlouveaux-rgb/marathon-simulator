/**
 * Brick workouts — bike → run combined sessions.
 *
 * Almost always bike-to-run (§18.1). The physiological value is in training
 * the run-off-the-bike transition: altered blood flow, muscle recruitment
 * after cycling, and race-day pacing discipline.
 *
 * Load accounting: both segments contribute their full TSS to the brick
 * workout (§18.4 — no training-load discount). The 5–11% pace discount is
 * race-time prediction only (tracking side), never applied here.
 */

import type { Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import type { Discipline, DisciplineTarget, TriSkillSlider, TriWorkoutType } from '@/types/triathlon';

interface BrickInput {
  phase: TrainingPhase;
  skill: TriSkillSlider;
  bikeMinutes: number;
  runMinutes: number;
  ftp?: number;
  hasPowerMeter?: boolean;
}

export function generateBrick(input: BrickInput): Workout {
  const { phase, bikeMinutes, runMinutes, ftp, hasPowerMeter } = input;

  const bikePower = hasPowerMeter && ftp
    ? `${Math.round(ftp * (phase === 'peak' ? 0.82 : 0.78))}W`
    : phase === 'peak' ? 'tempo Z3' : 'endurance Z2';
  const runTarget = phase === 'peak' ? 'race pace' : 'steady Z2';

  const bikeSeg: DisciplineTarget = {
    discipline: 'bike',
    durationMin: bikeMinutes,
    targetPctFtp: phase === 'peak' ? 0.82 : 0.78,
    targetWatts: hasPowerMeter && ftp ? Math.round(ftp * (phase === 'peak' ? 0.82 : 0.78)) : undefined,
  };

  const runSeg: DisciplineTarget = {
    discipline: 'run',
    durationMin: runMinutes,
  };

  const t: TriWorkoutType = 'brick';
  const discipline: Discipline = 'bike';  // Brick "belongs to" bike for scheduling

  const totalMin = bikeMinutes + runMinutes;
  const { aerobic, anaerobic } = loadForBrick(phase, bikeMinutes, runMinutes);

  const desc = `BIKE ${bikeMinutes}min @ ${bikePower}, straight into RUN ${runMinutes}min @ ${runTarget}. Practice transition: rack, shoes, out the door in under 2 min.`;

  return {
    n: 'Brick — bike + run',
    d: desc,
    r: phase === 'peak' ? 8 : 7,
    t,
    discipline,
    rpe: phase === 'peak' ? 8 : 7,
    aerobic,
    anaerobic,
    brickSegments: [bikeSeg, runSeg],
    estimatedDurationMin: totalMin,
  };
}

function loadForBrick(
  phase: TrainingPhase,
  bikeMinutes: number,
  runMinutes: number
): { aerobic: number; anaerobic: number } {
  // Bike contribution: endurance/tempo depending on phase
  const bikeTssPerMin = phase === 'peak' ? 1.1 : 0.9;
  const runTssPerMin = phase === 'peak' ? 1.3 : 1.1;
  const aerobic = Math.round(bikeMinutes * bikeTssPerMin * 0.85 + runMinutes * runTssPerMin * 0.80);
  const anaerobic = Math.round(bikeMinutes * bikeTssPerMin * 0.15 + runMinutes * runTssPerMin * 0.20);
  return { aerobic, anaerobic };
}
