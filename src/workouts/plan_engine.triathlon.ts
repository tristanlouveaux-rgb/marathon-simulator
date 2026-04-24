/**
 * Triathlon plan engine — top-level entry for generating a triathlon plan.
 *
 * Generation flow:
 *   1. Phase each week (base → build → peak → taper) via phaseForWeek()
 *   2. Compute weekly total hours from time-available × phase multiplier
 *   3. Split total hours into per-discipline hours via triConfig.volumeSplit
 *   4. Emit sessions per discipline via swim/bike/run generators
 *   5. Hand to scheduler.triathlon.ts for day assignment
 *   6. Wrap into a Week[] compatible with the rest of the app
 *
 * Reuses the running workout library for run sessions to keep the running
 * code path canonical (no fork for the run leg — it's the same muscle as
 * marathon training).
 */

import type { SimulatorState, Week, Workout } from '@/types/state';
import type { TrainingPhase } from '@/types/training';
import type { TriSkillSlider } from '@/types/triathlon';
import { PHASE_WEEKS } from '@/constants/triathlon-constants';
import { generateSwimSession, pickSwimKind } from './swim';
import { generateBikeSession, pickBikeKind } from './bike';
import { generateBrick } from './brick';
import { scheduleTriathlonWeek } from './scheduler.triathlon';

/**
 * Generate a full triathlon plan for the current state.
 */
export function generateTriathlonPlan(state: SimulatorState): Week[] {
  const tri = state.triConfig;
  if (!tri) return [];

  const totalWeeks = state.tw || 20;
  const weeks: Week[] = [];

  for (let w = 1; w <= totalWeeks; w++) {
    const phase = phaseForWeek(w, totalWeeks, tri.distance);
    const weekWorkouts = generateWeekForTriathlon(state, w, totalWeeks, phase);

    weeks.push({
      w,
      ph: phase,
      triWorkouts: weekWorkouts,
      rated: {},
      skip: [],
      cross: [],
      wkGain: 0,
      workoutMods: [],
      adjustments: [],
      unspentLoad: 0,
      extraRunLoad: 0,
    } as Week);
  }

  return weeks;
}

/**
 * Regenerate a single triathlon week (e.g., after a skip or ACWR spike).
 */
export function regenerateTriathlonWeek(state: SimulatorState, weekIndex: number): Week | null {
  const tri = state.triConfig;
  if (!tri || !state.wks || weekIndex < 1 || weekIndex > state.wks.length) return null;

  const totalWeeks = state.tw;
  const phase = phaseForWeek(weekIndex, totalWeeks, tri.distance);
  const weekWorkouts = generateWeekForTriathlon(state, weekIndex, totalWeeks, phase);

  const existing = state.wks[weekIndex - 1];
  return {
    ...existing,
    ph: phase,
    triWorkouts: weekWorkouts,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Phase assignment
// ───────────────────────────────────────────────────────────────────────────

function phaseForWeek(weekIndex: number, totalWeeks: number, distance: '70.3' | 'ironman'): TrainingPhase {
  const { base, build, peak } = PHASE_WEEKS[distance];
  // Taper = remaining weeks after base + build + peak
  const taperStart = base + build + peak + 1;
  if (weekIndex <= base) return 'base';
  if (weekIndex <= base + build) return 'build';
  if (weekIndex <= base + build + peak) return 'peak';
  void totalWeeks;
  void taperStart;
  return 'taper';
}

// ───────────────────────────────────────────────────────────────────────────
// Per-week workout generation
// ───────────────────────────────────────────────────────────────────────────

function generateWeekForTriathlon(
  state: SimulatorState,
  weekIndex: number,
  totalWeeks: number,
  phase: TrainingPhase
): Workout[] {
  const tri = state.triConfig!;
  const timeAvailable = tri.timeAvailableHoursPerWeek ?? 10;
  const split = tri.volumeSplit ?? { swim: 0.175, bike: 0.475, run: 0.35 };
  const rating = tri.skillRating ?? { swim: 3, bike: 3, run: 3 };
  const gymSessions = state.gs ?? 0;

  // Phase multiplier (fraction of peak hours this week represents)
  const phaseMult = phaseMultiplier(phase, weekIndex, totalWeeks);
  const isDeload = isDeloadWeek(weekIndex, phase);
  const effectiveMult = isDeload ? phaseMult * 0.7 : phaseMult;
  const weekHours = timeAvailable * effectiveMult;

  // Per-discipline hours
  const swimHours = weekHours * split.swim;
  const bikeHours = weekHours * split.bike;
  const runHours  = weekHours * split.run;

  // Session counts by phase
  const swimSessions = countSessions(swimHours, 0.75, 3);
  const bikeSessions = countSessions(bikeHours, 1.3,  3);
  const runSessions  = countSessions(runHours,  0.9,  3);

  // Generate swim sessions
  const swim: Workout[] = [];
  for (let i = 0; i < swimSessions; i++) {
    const kind = pickSwimKind(phase, i);
    const minutes = Math.max(30, Math.round((swimHours * 60) / swimSessions));
    swim.push(generateSwimSession({
      phase,
      skill: rating.swim as TriSkillSlider,
      weekIndex,
      totalWeeks,
      targetMinutes: minutes,
      kind,
      cssSecPer100m: tri.swim?.cssSecPer100m,
    }));
  }

  // Generate bike sessions. Last one is the "long" — we might swap for a brick.
  const bike: Workout[] = [];
  for (let i = 0; i < bikeSessions; i++) {
    const kind = pickBikeKind(phase, i);
    // Long ride gets bigger slice
    const share = i === bikeSessions - 1 ? 0.45 : (0.55 / Math.max(1, bikeSessions - 1));
    const minutes = Math.max(30, Math.round(bikeHours * 60 * share));
    bike.push(generateBikeSession({
      phase,
      skill: rating.bike as TriSkillSlider,
      weekIndex,
      totalWeeks,
      targetMinutes: minutes,
      kind,
      ftp: tri.bike?.ftp,
      hasPowerMeter: tri.bike?.hasPowerMeter,
    }));
  }

  // Run sessions (simple: 1 quality, 1 easy, 1 long)
  const run: Workout[] = [];
  for (let i = 0; i < runSessions; i++) {
    const share = i === runSessions - 1 ? 0.45 : (0.55 / Math.max(1, runSessions - 1));
    const minutes = Math.max(30, Math.round(runHours * 60 * share));
    run.push(generateRunSessionForTri(phase, i, runSessions, minutes));
  }

  // Brick (phase: build or peak, weekly in those phases)
  let brick: Workout | null = null;
  if ((phase === 'build' || phase === 'peak') && bike.length > 0) {
    const bikeMinutes = Math.round(bikeHours * 60 * 0.40);  // Slightly shorter than solo long ride
    const runMinutes = Math.round(runHours * 60 * 0.25);
    if (bikeMinutes >= 45 && runMinutes >= 15) {
      brick = generateBrick({
        phase,
        skill: rating.bike as TriSkillSlider,
        bikeMinutes,
        runMinutes,
        ftp: tri.bike?.ftp,
        hasPowerMeter: tri.bike?.hasPowerMeter,
      });
    }
  }

  // Gym sessions
  const gym: Workout[] = [];
  for (let i = 0; i < gymSessions && i < 2; i++) {
    gym.push({
      n: 'Strength',
      d: '45min full-body strength. Core, hip stability, upper-body pull for swim.',
      r: 6,
      t: 'gym',
      rpe: 6,
      aerobic: 20,
      anaerobic: 10,
    });
  }

  return scheduleTriathlonWeek(swim, bike, run, brick, phase, gym);
}

// ───────────────────────────────────────────────────────────────────────────
// Session count helpers
// ───────────────────────────────────────────────────────────────────────────

function countSessions(hours: number, avgSessionHours: number, maxSessions: number): number {
  if (hours <= 0) return 0;
  return Math.min(maxSessions, Math.max(1, Math.round(hours / avgSessionHours)));
}

function phaseMultiplier(phase: TrainingPhase, weekIndex: number, totalWeeks: number): number {
  // Base: 0.7 → 0.95 (linear ramp across the phase)
  // Build: 0.95 → 1.0
  // Peak: 1.0 → 1.05 → 1.0 (climbs then holds)
  // Taper: 0.75 → 0.45 → 0.30 (steep ramp down)
  switch (phase) {
    case 'base':  return 0.75;
    case 'build': return 0.95;
    case 'peak':  return 1.00;
    case 'taper': {
      // Count weeks remaining from taper start
      const weeksFromEnd = totalWeeks - weekIndex;
      if (weeksFromEnd >= 2) return 0.75;
      if (weeksFromEnd === 1) return 0.55;
      return 0.30;  // race week
    }
  }
}

function isDeloadWeek(weekIndex: number, phase: TrainingPhase): boolean {
  if (phase === 'taper') return false;   // Taper is already its own reduction
  // Every 4th week in base + build
  return weekIndex % 4 === 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Run session generator (tri-aware, not a fork of the running engine)
// ───────────────────────────────────────────────────────────────────────────

function generateRunSessionForTri(
  phase: TrainingPhase,
  slotIndex: number,
  totalSlots: number,
  minutes: number
): Workout {
  const isLong = slotIndex === totalSlots - 1;
  const isQuality = slotIndex === 0 && (phase === 'build' || phase === 'peak');

  let name: string;
  let desc: string;
  let t: string;
  let rpe: number;
  let aerobic: number;
  let anaerobic: number;

  if (isLong) {
    name = 'Long run';
    desc = `${minutes}min continuous Z2. Build aerobic endurance.`;
    t = 'long';
    rpe = phase === 'peak' ? 6 : 5;
    aerobic = Math.round(minutes * 1.1);
    anaerobic = Math.round(minutes * 0.15);
  } else if (isQuality) {
    name = 'Threshold run';
    desc = `15min WU, 3×8min @ threshold, 2min rec, 10min CD.`;
    t = 'threshold';
    rpe = 8;
    aerobic = Math.round(minutes * 1.2);
    anaerobic = Math.round(minutes * 0.35);
  } else {
    name = 'Easy run';
    desc = `${minutes}min Z1-Z2 easy. Conversational throughout.`;
    t = 'easy';
    rpe = 4;
    aerobic = Math.round(minutes * 0.95);
    anaerobic = Math.round(minutes * 0.05);
  }

  return {
    n: name,
    d: desc,
    r: rpe,
    t,
    discipline: 'run',
    rpe,
    aerobic,
    anaerobic,
  };
}
