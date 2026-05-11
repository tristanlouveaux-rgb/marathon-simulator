/**
 * HYROX plan engine.
 *
 * Generates a full HYROX training plan as Week[] compatible with the rest
 * of the app (triWorkouts field, same Week schema as triathlon mode).
 *
 * Generation flow:
 *   1. Phase each week (base → build → peak → taper) from week fraction
 *   2. Apply phase multiplier + deload factor to weekly available hours
 *   3. Distribute effective hours across runs / stations / bricks by HYROX_TIME_SPLIT
 *   4. Determine session kind mix for the phase (e.g. base = all easy, build = adds tempo+density)
 *   5. Generate each session via hyrox-generators.ts
 *   6. Enforce weekly MTL cap — downgrade highest-MTL sessions if over cap
 *   7. Schedule onto days via scheduler.hyrox.ts
 *   8. Wrap into Week[]
 */

import type { SimulatorState, Week, Workout } from '@/types/state';
import type { AbilityBand, HyroxStation } from '@/types/triathlon';
import {
  HYROX_WEEKLY_SESSIONS,
  HYROX_TIME_SPLIT,
  HYROX_SESSION_MAX_MIN,
  HYROX_BUILD_MULT,
  HYROX_PEAK_MULT,
  HYROX_DELOAD_FACTOR,
  hyroxBaseMultiplier,
  hyroxPhasesForLen,
} from '@/constants/hyrox-constants';
import { generateHyroxRun, generateHyroxStation, generateHyroxBrick, generateHyroxAssessment } from './hyrox-generators';
import { scheduleHyroxWeek } from './scheduler.hyrox';

/**
 * Bump when plan output changes in a way that should invalidate cached plans.
 * main.ts checks this on launch and regenerates if stored version is lower.
 */
export const HYROX_GENERATOR_VERSION = 9;

// ─── Phase assignment ─────────────────────────────────────────────────────────

/**
 * Resolve the phase for a given week using length-aware compression. Short
 * plans (e.g. a 7-week race window) used to slip a fraction-based bucketing
 * that left the final week in `peak` with no taper. `hyroxPhasesForLen`
 * compresses base→build→peak→taper proportionally and floors the taper at 1
 * week so race week is always tapered.
 */
function phaseForWeek(weekIndex: number, totalWeeks: number): 'base' | 'build' | 'peak' | 'taper' {
  const { base, build, peak } = hyroxPhasesForLen(totalWeeks);
  if (weekIndex <= base) return 'base';
  if (weekIndex <= base + build) return 'build';
  if (weekIndex <= base + build + peak) return 'peak';
  return 'taper';
}

function phaseMultiplier(
  phase: 'base' | 'build' | 'peak' | 'taper',
  weekIndex: number,
  totalWeeks: number
): number {
  switch (phase) {
    case 'base':  return hyroxBaseMultiplier(weekIndex);
    case 'build': return HYROX_BUILD_MULT;
    case 'peak':  return HYROX_PEAK_MULT;
    case 'taper': {
      const weeksFromEnd = totalWeeks - weekIndex;
      if (weeksFromEnd >= 2) return 0.75;
      if (weeksFromEnd === 1) return 0.55;
      return 0.30; // race week
    }
  }
}

function isDeloadWeek(weekIndex: number, phase: 'base' | 'build' | 'peak' | 'taper'): boolean {
  if (phase === 'taper') return false; // taper is its own volume reduction
  return weekIndex % 4 === 0;
}

// ─── Session kind selection ───────────────────────────────────────────────────

/**
 * Decide which run kind to use for each run slot in this phase.
 * Returns kinds in order [slot0, slot1, slot2, slot3].
 */
function runKinds(
  phase: 'base' | 'build' | 'peak' | 'taper',
  runsPerWeek: number,
  band: AbilityBand = 'novice'
): Array<'run_easy' | 'run_tempo' | 'run_intervals'> {
  const isExperienced = band !== 'total_beginner' && band !== 'beginner';

  // Single weekly run: vary quality by phase instead of always easy.
  // With only 1 run/week the quality slot (index 1) is never reached,
  // so we assign the phase-appropriate kind directly to the single slot.
  if (runsPerWeek === 1 && isExperienced) {
    switch (phase) {
      case 'base':   return ['run_easy'];
      case 'build':  return ['run_tempo'];
      case 'peak':   return ['run_intervals'];
      case 'taper':  return ['run_easy'];
    }
  }

  switch (phase) {
    case 'base':
      if (isExperienced && runsPerWeek >= 2) {
        return Array.from({ length: runsPerWeek }, (_, i) =>
          i === 1 ? 'run_tempo' : 'run_easy'
        ) as Array<'run_easy' | 'run_tempo' | 'run_intervals'>;
      }
      return Array(runsPerWeek).fill('run_easy');
    case 'build':
      return Array.from({ length: runsPerWeek }, (_, i) =>
        i === 1 ? 'run_tempo' : 'run_easy'
      ) as Array<'run_easy' | 'run_tempo' | 'run_intervals'>;
    case 'peak':
      return Array.from({ length: runsPerWeek }, (_, i) => {
        if (i === 1) return 'run_intervals';
        if (i === 2 && runsPerWeek >= 3) return 'run_tempo';
        return 'run_easy';
      }) as Array<'run_easy' | 'run_tempo' | 'run_intervals'>;
    case 'taper':
      return Array.from({ length: runsPerWeek }, (_, i) =>
        i === 1 ? 'run_tempo' : 'run_easy'
      ) as Array<'run_easy' | 'run_tempo' | 'run_intervals'>;
  }
}

/**
 * Station kind progression: technique-heavy in base, density-added in build/peak.
 */
function stationKinds(
  phase: 'base' | 'build' | 'peak' | 'taper',
  stationsPerWeek: number
): Array<'station_technique' | 'station_density'> {
  switch (phase) {
    case 'base':
    case 'taper':
      return Array(stationsPerWeek).fill('station_technique');
    case 'build':
      // 1 density + rest technique
      return Array.from({ length: stationsPerWeek }, (_, i) =>
        i === stationsPerWeek - 1 ? 'station_density' : 'station_technique'
      ) as Array<'station_technique' | 'station_density'>;
    case 'peak':
      // Majority density in peak — race specificity
      return Array.from({ length: stationsPerWeek }, (_, i) =>
        i === 0 ? 'station_technique' : 'station_density'
      ) as Array<'station_technique' | 'station_density'>;
  }
}

/**
 * Brick kind: mini_brick for total_beginner/beginner only, full brick otherwise.
 * In taper: downgrade full brick → mini_brick to protect eccentric load.
 */
function brickKind(
  band: AbilityBand,
  phase: 'base' | 'build' | 'peak' | 'taper'
): 'brick' | 'mini_brick' {
  if (band === 'total_beginner' || band === 'beginner') return 'mini_brick';
  if (phase === 'taper') return 'mini_brick';
  return 'brick';
}

// ─── MTL cap enforcement ──────────────────────────────────────────────────────

/**
 * If the sum of session MTLs exceeds the cap, downgrade the highest-MTL
 * station or brick session to its lower-intensity sibling:
 *   station_density → station_technique
 *   brick → mini_brick (or reduce rounds in description — here we use a simple
 *           flag approach: mark the session r and rpe down by 1, halve its MTL)
 *
 * This is intentionally simple — the MTL model is still calibrating (initial estimates).
 * A proportional scale-down avoids over-engineering when the caps may shift after dogfooding.
 */
function enforceMTLCap(sessions: Workout[], cap: number): Workout[] {
  const total = sessions.reduce((sum, s) => sum + (s.musculoTendonLoad ?? 0), 0);
  if (total <= cap) return sessions;

  const ratio = cap / total;
  // Scale all MTL values proportionally rather than surgical downgrade (v1 simplicity).
  return sessions.map(s => ({
    ...s,
    musculoTendonLoad: s.musculoTendonLoad ? Math.round(s.musculoTendonLoad * ratio) : undefined,
    hyroxComponents: s.hyroxComponents?.map(c => ({
      ...c,
      mtl: Math.round(c.mtl * ratio),
    })),
  }));
}

// ─── Per-week generation ──────────────────────────────────────────────────────

function generateWeekSessions(
  state: SimulatorState,
  weekIndex: number,
  totalWeeks: number,
  phase: 'base' | 'build' | 'peak' | 'taper'
): Workout[] {
  const hx = state.hyroxConfig!;
  const band = hx.athleteBand;
  // Use per-athlete session counts from hyroxConfig (set at init from onboarding slider),
  // falling back to band defaults if not set (e.g. older state without slider).
  const sessions = {
    runs:     hx.runsPerWeek     ?? HYROX_WEEKLY_SESSIONS[band].runs,
    stations: hx.stationSessionsPerWeek ?? HYROX_WEEKLY_SESSIONS[band].stations,
    bricks:   hx.bricksPerWeek   ?? HYROX_WEEKLY_SESSIONS[band].bricks,
  };
  const bodyWeightKg = state.bodyWeightKg;

  // Hours available this week
  const mult = phaseMultiplier(phase, weekIndex, totalWeeks);
  const deload = isDeloadWeek(weekIndex, phase);
  const effectiveHours = hx.weeklyHoursAvailable * mult * (deload ? HYROX_DELOAD_FACTOR : 1);

  // Distribute hours
  const runHours     = effectiveHours * HYROX_TIME_SPLIT.runs;
  const stationHours = effectiveHours * HYROX_TIME_SPLIT.stations;
  const brickHours   = effectiveHours * HYROX_TIME_SPLIT.bricks;

  // Clamp session duration to per-type caps (minimum 35 min for station sessions).
  function clampDur(kind: string, raw: number): number {
    const minDur = kind.includes('station') ? 35 : 20;
    return Math.max(minDur, Math.min(HYROX_SESSION_MAX_MIN[kind] ?? 90, Math.round(raw)));
  }

  const runMin     = sessions.runs     > 0 ? (runHours     / sessions.runs)     * 60 : 0;
  const stationMin = sessions.stations > 0 ? (stationHours / sessions.stations) * 60 : 0;
  const brickMin   = sessions.bricks   > 0 ? (brickHours   / sessions.bricks)   * 60 : 0;

  // Read benchmarks from the format-specific slot, falling back to legacy pooled field.
  const isDoublesFormat = hx.format === 'open_doubles' || hx.format === 'pro_doubles';
  const stationBenchmarks = (
    isDoublesFormat ? hx.stationBenchmarksDoubles : hx.stationBenchmarksSingles
  ) ?? hx.stationBenchmarks as Partial<Record<HyroxStation, number>> | undefined;
  const workouts: Workout[] = [];

  // Run sessions
  const rKinds = runKinds(phase, sessions.runs, band);
  for (let i = 0; i < sessions.runs; i++) {
    const kind = rKinds[i];
    workouts.push(generateHyroxRun({
      kind,
      targetMinutes: clampDur(kind, runMin),
      band,
      phase,
      slotIndex: i + weekIndex,  // week-level slot so rotation varies across weeks
      bodyWeightKg,
      runPaceSecKm: hx.hyroxRunPaceSecKm,
    }));
  }

  // Station sessions — Week 1, first station slot is the assessment for everyone.
  // Users with existing benchmarks can skip/replace it like any other workout; taking
  // it again refreshes their numbers.
  const needsAssessment = weekIndex === 1;
  const sKinds = stationKinds(phase, sessions.stations);
  for (let i = 0; i < sessions.stations; i++) {
    if (needsAssessment && i === 0) {
      workouts.push(generateHyroxAssessment({ band, stationAccess: hx.stationAccess, bodyWeightKg }));
      continue;
    }
    const kind = sKinds[i];
    workouts.push(generateHyroxStation({
      kind,
      targetMinutes: clampDur(kind, stationMin),
      band,
      stationAccess: hx.stationAccess,
      phase,
      slotIndex: i + weekIndex,
      bodyWeightKg,
      stationBenchmarks,
    }));
  }

  // Brick sessions
  if (sessions.bricks > 0 && (phase !== 'base' || band === 'beginner' || band === 'total_beginner')) {
    // Bricks appear from week 1 for beginners (mini_brick), from build phase for others.
    const phaseAllowsBrick = phase !== 'base' || band === 'beginner' || band === 'total_beginner';
    for (let i = 0; i < sessions.bricks; i++) {
      if (!phaseAllowsBrick && i === 0) continue;
      const kind = brickKind(band, phase);
      workouts.push(generateHyroxBrick({
        kind,
        targetMinutes: clampDur(kind, brickMin),
        band,
        stationAccess: hx.stationAccess,
        phase,
        slotIndex: i + weekIndex,
        bodyWeightKg,
        stationBenchmarks,
      }));
    }
  }

  // Enforce MTL cap
  const capped = enforceMTLCap(workouts, hx.mtlCap);

  return scheduleHyroxWeek(capped, band);
}

// ─── Top-level plan generator ─────────────────────────────────────────────────

export function generateHyroxPlan(state: SimulatorState): Week[] {
  if (!state.hyroxConfig) return [];

  const totalWeeks = state.tw || 16;
  const weeks: Week[] = [];

  for (let w = 1; w <= totalWeeks; w++) {
    const phase = phaseForWeek(w, totalWeeks);
    const workouts = generateWeekSessions(state, w, totalWeeks, phase);

    weeks.push({
      w,
      ph: phase as any,
      triWorkouts: workouts,
      rated: {},
      skip: [],
      cross: [],
      wkGain: 0,
      workoutMods: [],
      adjustments: [],
      unspentLoad: 0,
      extraRunLoad: 0,
    });
  }

  return weeks;
}
