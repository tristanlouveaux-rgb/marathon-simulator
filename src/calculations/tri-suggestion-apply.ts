/**
 * Apply accepted suggestion mods to `state.wks[*].triWorkouts`.
 *
 * Mirrors how running-side `mergeTimingMods` mutates `wk.workoutMods`. For
 * tri we mutate the planned workouts directly (mark 'reduced', attach a
 * `modReason`) so the plan engine and the matcher both see the change.
 * Cycling reuses eventType 'triathlon' and goes through the same path.
 *
 * Every accepted change, the swap to easy included, sets status 'reduced' (the
 * generic "changed from plan, still to be done" status, "Adjusted" chip), never
 * 'replaced'. Most surfaces read 'replaced' as "no longer to be done": the tri
 * Home Today list and plan-view active-card checks drop it, the run matcher
 * skips it, the overload detector and the readiness lookahead skip it. A swapped
 * session is still to be done, so it must stay on all of them. The Adjust
 * overlay avoids 'replaced' for the same reason (workout-adjust-overlay.ts).
 *
 * **Side of the line**: planning. Mutates state. Caller must `saveState()`.
 *
 * Intensity changes read the canonical ladders and branch on the session's
 * discipline, never on a substring of its type:
 *  - run: RUN_PACE_LADDER (constants/intensity-ladder.ts), one pace category
 *    per step and never up, the generator RPE for the new type, pace tokens
 *    retargeted (retargetDescriptionPace), load re-priced at the canonical
 *    type-keyed rate (loadForTriRun). Same rule as running's timing check and
 *    cross-training suggester.
 *  - bike / swim: BIKE_INTENSITY_LADDER / SWIM_INTENSITY_LADDER, applied the way
 *    the per-session Adjust overlay applies a rung (originalIntensityLevel
 *    stash, intensityLevel, watt ratio or CSS pace tokens, loadForRung), plus
 *    the generator's RPE for that kind (rpeForBike / rpeForSwim).
 * Off-ladder sessions (bike_over_under, bike_vo2_micros, bike_vlamax,
 * bike_hills, swim_openwater, brick, run types off RUN_PACE_LADDER) have no rung
 * to step from: they are left untouched and counted as skipped, pending a
 * decision on where they step to.
 *
 * Every accepted change re-prices aerobic/anaerobic, so the plan header, the
 * Home day target (getPlannedDayTSSContext) and the overload detector read the
 * new prescription's load (canonical TSS, Load Currency Law).
 */

import type { SimulatorState, Workout, Week } from '@/types/state';
import type { TriSuggestionMod } from './tri-suggestion-aggregator';
import { runPaceRung, stepDownRunType, generatorRpeForRunType } from '@/constants/intensity-ladder';
import { BIKE_INTENSITY_LADDER, SWIM_INTENSITY_LADDER } from '@/constants/triathlon-constants';
import { isLongRun } from '@/workouts/long-run';
import { retargetDescriptionPace, scaleWattRanges, setSwimPaceTokens } from '@/workouts/workout-scaling';
import { loadForRung, loadForTriRun } from '@/workouts/rung-load';
import { nameForBike, rpeForBike, type BikeSessionKind } from '@/workouts/bike';
import { nameForSwim, rpeForSwim, type SwimSessionKind } from '@/workouts/swim';
import { gp } from '@/calculations/paces';

export interface ApplyResult {
  applied: number;
  skipped: number;
  /** Workout IDs touched, useful for the modal's "applied X mods" toast. */
  touched: string[];
}

/** Swap-to-easy keeps 75% of the planned minutes (pre-existing cut, unchanged). */
const SWAP_EASY_DURATION_FACTOR = 0.75;
/** Volume-ramp trim keeps 85% of the planned minutes (pre-existing cut, unchanged;
 *  the overload detector's TRIM_FRACTION 0.15 sizes the same action). */
const TRIM_DURATION_FACTOR = 0.85;

/** The easy rung a swap lands on, per discipline. Same aerobic default the
 *  Adjust overlay opens on (endurance: bike ladder idx 0, swim ladder idx 1). */
const SWAP_EASY_RUNG = { bike: 'bike_endurance', swim: 'swim_endurance' } as const;

type Disc = 'run' | 'bike' | 'swim';
type Rung = { key: string };

export function applyTriSuggestions(state: SimulatorState, mods: TriSuggestionMod[]): ApplyResult {
  let applied = 0;
  let skipped = 0;
  const touched: string[] = [];

  for (const mod of mods) {
    if (!mod.targetWorkoutId) { skipped += 1; continue; }
    const hit = findWorkoutById(state, mod.targetWorkoutId);
    if (!hit) { skipped += 1; continue; }
    const { workout, week } = hit;

    let ok = false;
    switch (mod.action) {
      case 'swap_easy':
        // Same discipline, easy rung, 25% shorter.
        ok = applySwapEasy(state, week, workout, mod);
        break;
      case 'downgrade_today':
        // One rung down the discipline's ladder.
        ok = applyDowngrade(state, week, workout, mod);
        break;
      case 'trim_volume':
        // 15% shorter at the same intensity (volume-ramp violations).
        ok = applyTrim(workout);
        break;
    }
    if (ok) {
      applied += 1;
      touched.push(workout.id ?? '');
    } else {
      skipped += 1;
    }
  }

  return { applied, skipped, touched };
}

function findWorkoutById(state: SimulatorState, id: string): { workout: Workout; week: Week } | undefined {
  for (const wk of state.wks ?? []) {
    const w = wk.triWorkouts?.find(x => x.id === id);
    if (w) return { workout: w, week: wk };
  }
  return undefined;
}

/** Discipline whose ladder governs this session, or null when no single
 *  ladder applies (brick = bike + run; HYROX stations; strength). */
function ladderDiscipline(w: Workout): Disc | null {
  if (w.t === 'brick') return null;
  const d = w.discipline ?? 'run';
  return d === 'run' || d === 'bike' || d === 'swim' ? d : null;
}

function ladderFor(d: 'bike' | 'swim'): Rung[] {
  return d === 'bike' ? BIKE_INTENSITY_LADDER : SWIM_INTENSITY_LADDER;
}

/** Index of the rung the session's description is written at, or -1 when the
 *  session type is off the ladder. A type on the ladder whose intensityLevel
 *  was moved by the Adjust overlay sits at that level (Adjust rewrote the
 *  description to it); an off-ladder type keeps its own description even when
 *  Adjust stamped a level, so it stays off-ladder here. */
function currentRungIdx(w: Workout, d: 'bike' | 'swim'): number {
  const ladder = ladderFor(d);
  if (ladder.findIndex(r => r.key === w.t) < 0) return -1;
  return ladder.findIndex(r => r.key === (w.intensityLevel ?? w.t));
}

function minutesOf(w: Workout): number {
  return typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0 ? w.estimatedDurationMin : 0;
}

/** Easy pace the run pace tokens are anchored to. The tri generator writes run
 *  legs (and their easy warm-up / cool-down) from gp(s.v, s.lt).e
 *  (plan_engine.triathlon.ts generateTriathlonPlan), so a retargeted rep pace
 *  comes from the same source as the pace already in the description. The live
 *  pace table is the fallback when no VDOT is set. */
function easyPaceSec(state: SimulatorState): number | undefined {
  if (state.v) return gp(state.v, state.lt ?? null).e;
  return state.pac?.e && state.pac.e > 0 ? state.pac.e : undefined;
}

/** Move a run to `newT` and price it at `minutes`. Type, RPE and pace tokens
 *  change only when the type changes. */
function setRunType(state: SimulatorState, w: Workout, newT: string, minutes: number): void {
  if (newT !== w.t) {
    const rpe = generatorRpeForRunType(newT);
    if (rpe != null) { w.rpe = rpe; w.r = rpe; }
    if (w.d) w.d = retargetDescriptionPace(w.d, newT, easyPaceSec(state));
    w.t = newT;
  }
  const load = minutes > 0 ? loadForTriRun(newT, minutes) : null;
  if (load) { w.aerobic = load.aerobic; w.anaerobic = load.anaerobic; }
}

/** Move a bike/swim session to rung `to` and price it at `minutes`, the way the
 *  Adjust overlay applies a rung (workout-adjust-overlay.ts applyObjectScale). */
function setRung(state: SimulatorState, week: Week, w: Workout, d: 'bike' | 'swim', to: Rung, minutes: number): void {
  const fromKey = w.intensityLevel ?? w.t;
  if (to.key !== fromKey) {
    // Stash the generation-time rung once (null = "had none"), as Adjust does.
    if (w.originalIntensityLevel === undefined) w.originalIntensityLevel = w.intensityLevel ?? null;
    if (w.d) {
      if (d === 'bike') {
        const from = BIKE_INTENSITY_LADDER.find(r => r.key === fromKey);
        const toB = BIKE_INTENSITY_LADDER.find(r => r.key === to.key);
        if (from && toB) w.d = scaleWattRanges(w.d, toB.pct / from.pct);
      } else {
        const toS = SWIM_INTENSITY_LADDER.find(r => r.key === to.key);
        const css = state.triConfig?.swim?.cssSecPer100m;
        if (toS && css && css > 0) w.d = setSwimPaceTokens(w.d, css + toS.cssOffsetSec);
      }
    }
    w.intensityLevel = to.key;
    w.t = to.key;
    const kind = to.key.slice(d.length + 1);
    const rpe = d === 'bike'
      ? rpeForBike(kind as BikeSessionKind, week.ph)
      : rpeForSwim(kind as SwimSessionKind, week.ph);
    w.rpe = rpe;
    w.r = rpe;
  }
  const load = minutes > 0 ? loadForRung(to.key, minutes) : null;
  if (load) { w.aerobic = load.aerobic; w.anaerobic = load.anaerobic; }
}

function swapReason(source: TriSuggestionMod['source']): string {
  switch (source) {
    case 'rpe_blown': return 'high RPE yesterday';
    case 'readiness': return 'low readiness';
    case 'cross_training_overload': return 'cross-training load';
    case 'volume_ramp': return 'volume ramp';
  }
}

function applySwapEasy(state: SimulatorState, week: Week, w: Workout, mod: TriSuggestionMod): boolean {
  const d = ladderDiscipline(w);
  if (!d) return false;
  const longRun = isLongRun(w);
  const oldMin = minutesOf(w);
  const newMin = oldMin > 0 ? Math.round(oldMin * SWAP_EASY_DURATION_FACTOR) : 0;

  const oldT = w.t;
  if (d === 'run') {
    const rung = runPaceRung(w.t);
    if (rung < 0) return false; // off RUN_PACE_LADDER
    // Easy rung ('long' for the long-run slot). Never up: a session already at
    // or below easy keeps its type and only loses the minutes.
    const easyT = longRun ? 'long' : 'easy';
    const newT = rung > runPaceRung(easyT) ? easyT : w.t;
    stampOriginal(w);
    if (newMin > 0) w.estimatedDurationMin = newMin;
    setRunType(state, w, newT, newMin);
  } else {
    const ladder = ladderFor(d);
    const cur = currentRungIdx(w, d);
    if (cur < 0) return false; // off-ladder kind
    const easyIdx = ladder.findIndex(r => r.key === SWAP_EASY_RUNG[d]);
    const to = cur > easyIdx ? ladder[easyIdx] : ladder[cur];
    stampOriginal(w);
    if (newMin > 0) w.estimatedDurationMin = newMin;
    setRung(state, week, w, d, to, newMin);
  }

  w.status = 'reduced';
  w.modReason = `Swapped to easy: ${swapReason(mod.source)}`;
  // A session that was already easy keeps its name (it is the same session,
  // shorter); one that changed intensity reads as the easy swap.
  if (w.t !== oldT) w.n = `Easy ${capitalize(d)}`;
  return true;
}

function applyDowngrade(state: SimulatorState, week: Week, w: Workout, mod: TriSuggestionMod): boolean {
  const d = ladderDiscipline(w);
  if (!d) return false;
  const minutes = minutesOf(w);

  if (d === 'run') {
    if (runPaceRung(w.t) < 0) return false; // off RUN_PACE_LADDER
    const newT = stepDownRunType(w.t, 1, { longRun: isLongRun(w) });
    if (newT === w.t) return false; // already on the bottom rung
    stampOriginal(w);
    setRunType(state, w, newT, minutes);
    w.n = `${capitalize(newT.replace(/_/g, ' '))} run (downgrade)`;
  } else {
    const ladder = ladderFor(d);
    const cur = currentRungIdx(w, d);
    if (cur < 0) return false; // off-ladder kind
    if (cur === 0) return false; // already on the bottom rung
    const to = ladder[cur - 1];
    stampOriginal(w);
    setRung(state, week, w, d, to, minutes);
    const kind = to.key.slice(d.length + 1);
    w.n = `${d === 'bike' ? nameForBike(kind as BikeSessionKind) : nameForSwim(kind as SwimSessionKind)} (downgrade)`;
  }

  w.status = 'reduced';
  w.modReason = mod.source === 'readiness' ? 'Readiness downgrade' : 'Manage load';
  return true;
}

function applyTrim(w: Workout): boolean {
  const oldMin = minutesOf(w);
  if (oldMin <= 0) return false; // nothing to trim
  const newMin = Math.round(oldMin * TRIM_DURATION_FACTOR);
  stampOriginal(w);
  w.estimatedDurationMin = newMin;
  // Load is proportional to duration at a fixed intensity (the Adjust overlay's
  // duration-only rule, workout-adjust-overlay.ts applyObjectScale).
  const f = newMin / oldMin;
  if (typeof w.aerobic === 'number') w.aerobic = Math.round(w.aerobic * f);
  if (typeof w.anaerobic === 'number') w.anaerobic = Math.round(w.anaerobic * f);
  w.status = 'reduced';
  w.modReason = 'Volume ramp trim';
  return true;
}

function stampOriginal(w: Workout): void {
  w.originalName = w.originalName ?? w.n;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
