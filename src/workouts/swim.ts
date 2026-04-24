/**
 * Swim workout library.
 *
 * Generates structured swim sessions by phase and skill level. Each workout
 * returns a `Workout` shape compatible with the running plan so the rest of
 * the app (plan view, load bars, activity matching) can render it unchanged.
 *
 * Session types (§18.9 / §9.1):
 *   - technique — drills + short reps, low intensity. Core of base phase.
 *   - endurance — longer continuous or long-interval aerobic volume.
 *   - threshold — CSS intervals (100/200m reps at threshold pace).
 *   - speed — short sharp work above CSS (typically late build / peak).
 *
 * Load (aerobic / anaerobic) is a rough first approximation — Phase 4 will
 * recompute from the real swim-TSS formula (cubed IF) once CSS is available
 * on state.
 */

import type { Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import type { Discipline, TriSkillSlider, TriWorkoutType } from '@/types/triathlon';

export type SwimSessionKind = 'technique' | 'endurance' | 'threshold' | 'speed';

interface SwimSessionInput {
  phase: TrainingPhase;
  skill: TriSkillSlider;      // 1-5
  weekIndex: number;           // 1-based
  totalWeeks: number;
  targetMinutes: number;       // Target session duration in minutes
  kind: SwimSessionKind;
  cssSecPer100m?: number;      // If known, renders target pace on the card
}

const swimTypeMap: Record<SwimSessionKind, TriWorkoutType> = {
  technique: 'swim_technique',
  endurance: 'swim_endurance',
  threshold: 'swim_threshold',
  speed:     'swim_speed',
};

/**
 * Pick the right session kind for the phase + week position.
 * Base → mostly technique + endurance. Build → add threshold. Peak → speed.
 */
export function pickSwimKind(phase: TrainingPhase, slotIndex: number): SwimSessionKind {
  // Each week we generate up to 3 swim sessions; slotIndex is 0-based across the week's swim slots.
  if (phase === 'base') {
    return slotIndex === 0 ? 'technique' : slotIndex === 1 ? 'endurance' : 'technique';
  }
  if (phase === 'build') {
    return slotIndex === 0 ? 'threshold' : slotIndex === 1 ? 'endurance' : 'technique';
  }
  if (phase === 'peak') {
    return slotIndex === 0 ? 'threshold' : slotIndex === 1 ? 'speed' : 'endurance';
  }
  // taper
  return slotIndex === 0 ? 'technique' : 'endurance';
}

/**
 * Generate a single swim session.
 */
export function generateSwimSession(input: SwimSessionInput): Workout {
  const { phase, skill, kind, targetMinutes, cssSecPer100m } = input;

  const totalM = estimateDistanceMetres(targetMinutes, skill, cssSecPer100m);
  const desc = describeSwimSession(kind, totalM, cssSecPer100m, skill, input.weekIndex);
  const rpe = rpeForSwim(kind, phase);

  const { aerobic, anaerobic } = loadForSwim(kind, targetMinutes);

  const t: TriWorkoutType = swimTypeMap[kind];
  const discipline: Discipline = 'swim';

  return {
    n: nameForSwim(kind),
    d: desc,
    r: rpe,
    t,
    discipline,
    rpe,
    aerobic,
    anaerobic,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function estimateDistanceMetres(minutes: number, skill: TriSkillSlider, css?: number): number {
  // Estimate average pace from skill (sec/100m) if CSS not supplied.
  // Rough: skill 1 ≈ 2:45/100m, skill 5 ≈ 1:25/100m — linear interpolation.
  const paceSecPer100 = css ?? (165 - (skill - 1) * 20);  // 1→165, 5→85
  const totalSec = minutes * 60;
  const metres = Math.round((totalSec / paceSecPer100) * 100);
  // Round to nearest 100m for display.
  return Math.round(metres / 100) * 100;
}

function nameForSwim(kind: SwimSessionKind): string {
  switch (kind) {
    case 'technique': return 'Swim technique';
    case 'endurance': return 'Endurance swim';
    case 'threshold': return 'CSS intervals';
    case 'speed':     return 'Swim speed';
  }
}

/**
 * Variant rotation per kind — avoids generating the same workout every week.
 * Pick by `weekIndex % variants.length`.
 */
const SWIM_VARIANTS: Record<SwimSessionKind, Array<(totalM: number, paceHint: string) => string>> = {
  technique: [
    (m, _) => `${m}m total. 200m Warm up. Drills: 4×50m catch-up. Main: 6×100m easy @ +10s/100m, focus body position. 200m Cool down.`,
    (m, _) => `${m}m total. 200m Warm up. Drills: 4×50m single-arm + 4×50m fingertip drag. Main: 4×150m easy. 200m Cool down.`,
    (m, _) => `${m}m total. 200m Warm up. Drills: 6×25m fist swim + 4×50m 6-kick switch. Main: 8×75m easy pull. 200m Cool down.`,
  ],
  endurance: [
    (m, hint) => {
      const mainM = Math.max(200, m - 400);
      const reps = Math.max(2, Math.round(mainM / 400));
      const repM = Math.round(mainM / reps / 100) * 100;
      return `${m}m total. 200m Warm up. Main: ${reps}×${repM}m steady${hint}, 30s rest. 200m Cool down.`;
    },
    (m, hint) => {
      const mainM = Math.max(300, m - 400);
      const reps = Math.max(3, Math.round(mainM / 200));
      return `${m}m total. 200m Warm up. Main: ${reps}×200m pulling with paddles${hint}, 20s rest. 200m Cool down.`;
    },
    (m, hint) => `${m}m total. 200m Warm up. Main: ${Math.max(600, m - 400)}m continuous easy-steady${hint}. 200m Cool down.`,
  ],
  threshold: [
    (m, hint) => {
      const mainM = Math.max(400, m - 400);
      const reps = Math.min(16, Math.max(6, Math.round(mainM / 100)));
      return `${m}m total. 200m Warm up. Main: ${reps}×100m${hint}, 15s rest. 200m Cool down.`;
    },
    (m, hint) => {
      const mainM = Math.max(400, m - 400);
      const reps = Math.max(3, Math.round(mainM / 200));
      return `${m}m total. 200m Warm up. Main: ${reps}×200m${hint}, 25s rest. 200m Cool down.`;
    },
    (m, hint) => {
      const mainM = Math.max(400, m - 400);
      const reps = Math.max(2, Math.round(mainM / 400));
      return `${m}m total. 200m Warm up. Main: ${reps}×400m steady${hint}, 45s rest. 200m Cool down.`;
    },
  ],
  speed: [
    (m, _) => {
      const mainM = Math.max(300, m - 400);
      const reps = Math.min(12, Math.max(6, Math.round(mainM / 50)));
      void mainM;
      return `${m}m total. 200m Warm up. Main: ${reps}×50m fast (CSS −5s/100m), 30s rest. 200m Cool down.`;
    },
    (m, _) => {
      const mainM = Math.max(300, m - 400);
      const reps = Math.min(16, Math.max(8, Math.round(mainM / 25)));
      void mainM;
      return `${m}m total. 200m Warm up. Main: ${reps}×25m sprint on 30s. 200m Cool down.`;
    },
    (m, _) => `${m}m total. 200m Warm up. Main: 8×75m as 25m fast + 50m easy, 20s rest. 200m Cool down.`,
  ],
};

function describeSwimSession(
  kind: SwimSessionKind,
  totalM: number,
  css: number | undefined,
  skill: TriSkillSlider,
  weekIndex: number
): string {
  const paceHint = css ? ` @ ${formatPace(css)}/100m (CSS)` : '';
  const drillHint = skill <= 2 ? ' Focus on body position and breathing.' : '';
  const variants = SWIM_VARIANTS[kind];
  const idx = Math.abs(weekIndex - 1) % variants.length;
  return variants[idx](totalM, paceHint) + (kind === 'technique' ? drillHint : '');
}

function rpeForSwim(kind: SwimSessionKind, phase: TrainingPhase): number {
  const base: Record<SwimSessionKind, number> = {
    technique: 3,
    endurance: 5,
    threshold: 7,
    speed: 8,
  };
  let rpe = base[kind];
  if (phase === 'taper') rpe = Math.max(3, rpe - 1);
  return rpe;
}

function loadForSwim(kind: SwimSessionKind, minutes: number): { aerobic: number; anaerobic: number } {
  // Rough TSS-per-minute multipliers for swim placeholder. Phase 4 replaces
  // this with the real cubed-IF formula once CSS lands on state.
  const tssPerMin: Record<SwimSessionKind, number> = {
    technique: 0.6,
    endurance: 1.0,
    threshold: 1.5,
    speed: 1.7,
  };
  const anaerobicShare: Record<SwimSessionKind, number> = {
    technique: 0.05,
    endurance: 0.1,
    threshold: 0.3,
    speed: 0.5,
  };
  const total = tssPerMin[kind] * minutes;
  return {
    aerobic: Math.round(total * (1 - anaerobicShare[kind])),
    anaerobic: Math.round(total * anaerobicShare[kind]),
  };
}

function formatPace(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
