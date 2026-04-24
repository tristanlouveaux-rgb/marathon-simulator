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
    run.push(generateRunSessionForTri(phase, i, runSessions, minutes, rating.run as TriSkillSlider, weekIndex));
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
  // Volume ramp within each phase — linear-ish so early base weeks don't
  // blast a beginner with full peak volume on day one (§4 feedback).
  //   Base: 0.55 at week 1 → 0.85 near end of base
  //   Build: 0.85 → 1.00
  //   Peak: 1.00 → 1.05 → 1.00
  //   Taper: 0.75 → 0.55 → 0.30
  switch (phase) {
    case 'base': {
      // How deep into the base phase are we? Week 1 ≈ 0, last base week ≈ 1.
      // Use a simple heuristic: base phase runs from weekIndex 1 up to the
      // last base week. We don't know the exact length here without the
      // distance config, but base weeks are typically 8 (70.3) or 10 (IM).
      // Rough ramp: 0.55 + 0.3 × (weekIndex - 1) / 8, capped at 0.85.
      return Math.min(0.85, 0.55 + 0.3 * ((weekIndex - 1) / 8));
    }
    case 'build': return 0.92;
    case 'peak':  return 1.00;
    case 'taper': {
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

/**
 * Rough Z2 easy pace in sec/km by skill slider. Lets us estimate distance
 * alongside duration for long runs so the user sees "~16 km (1h 45min)"
 * instead of bare minutes.
 */
function easyPaceSecPerKm(skill: TriSkillSlider): number {
  // Skill 1 → 7:00/km, 5 → 4:30/km (linear interpolation)
  return 420 - (skill - 1) * 37.5;
}

function roundMin(mins: number): number {
  return mins >= 30 ? Math.round(mins / 5) * 5 : Math.round(mins);
}

function fmtMin(mins: number): string {
  const r = roundMin(mins);
  const h = Math.floor(r / 60);
  const m = r % 60;
  if (h > 0 && m > 0) return `${h}h ${m}min`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

const LONG_RUN_VARIANTS = [
  (km: number, dur: string) => `~${km}km (${dur}) continuous Z2. Build aerobic endurance.`,
  (km: number, dur: string) => `~${km}km (${dur}) with last 20min steady. Aerobic + mild fatigue resistance.`,
  (km: number, dur: string) => `~${km}km (${dur}) progressive — start Z1, move to Z2 after 30min, hold steady.`,
];

const THRESHOLD_RUN_VARIANTS = [
  () => `15min Warm up, 3×8min @ threshold, 2min recovery, 10min Cool down.`,
  () => `15min Warm up, 4×6min @ threshold, 90s recovery, 10min Cool down.`,
  () => `15min Warm up, 2×12min @ threshold, 3min recovery, 10min Cool down.`,
  () => `15min Warm up, 6×4min @ 10k pace, 90s jog, 10min Cool down.`,
];

const EASY_RUN_VARIANTS = [
  (dur: string) => `${dur} Z1–Z2 easy. Conversational throughout.`,
  (dur: string) => `${dur} easy with 6×20s strides at the end. Strides are smooth, not sprints.`,
  (dur: string) => `${dur} easy on soft surface if available. Recovery priority.`,
];

function generateRunSessionForTri(
  phase: TrainingPhase,
  slotIndex: number,
  totalSlots: number,
  minutes: number,
  skill: TriSkillSlider,
  weekIndex: number
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
    const r = roundMin(minutes);
    const pace = easyPaceSecPerKm(skill);
    const km = Math.round(((r * 60) / pace) * 2) / 2;  // nearest 0.5 km
    const idx = Math.abs(weekIndex - 1) % LONG_RUN_VARIANTS.length;
    name = 'Long run';
    desc = LONG_RUN_VARIANTS[idx](km, fmtMin(r));
    t = 'long';
    rpe = phase === 'peak' ? 6 : 5;
    aerobic = Math.round(r * 1.1);
    anaerobic = Math.round(r * 0.15);
  } else if (isQuality) {
    const idx = Math.abs(weekIndex - 1) % THRESHOLD_RUN_VARIANTS.length;
    name = 'Threshold run';
    desc = THRESHOLD_RUN_VARIANTS[idx]();
    t = 'threshold';
    rpe = 8;
    aerobic = Math.round(minutes * 1.2);
    anaerobic = Math.round(minutes * 0.35);
  } else {
    const r = roundMin(minutes);
    const idx = Math.abs(weekIndex - 1) % EASY_RUN_VARIANTS.length;
    name = 'Easy run';
    desc = EASY_RUN_VARIANTS[idx](fmtMin(r));
    t = 'easy';
    rpe = 4;
    aerobic = Math.round(r * 0.95);
    anaerobic = Math.round(r * 0.05);
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
