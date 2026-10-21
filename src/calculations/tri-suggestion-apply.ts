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
 *  - off-ladder bike / swim kinds (bike_over_under, bike_vlamax, bike_hills,
 *    bike_vo2_micros, swim_openwater) downgrade to the rung
 *    OFF_LADDER_DOWNGRADE_RUNG maps them to (one category down, never up). Their
 *    interval structure has no single %FTP / CSS offset to scale, so the
 *    description is rebuilt for the new kind at the same minutes with the
 *    generator's builders (describeBikeSession / describeSwimSession); load and
 *    RPE as for a ladder rung. A mapped step that would raise the planned load
 *    is not offered (raisesPlannedLoad, judged by rate at the same minutes:
 *    neuromuscular sprints price below sweet spot).
 * Sessions with no rung to step from are left untouched and counted as
 * skipped: a brick, run types off RUN_PACE_LADDER, a swap to easy on an
 * off-ladder kind (not decided), and a session already on the bottom rung.
 * canApplyTriSuggestion is the one gate: the detectors filter their targets
 * with it, so they do not propose those changes. isTriQualitySession is the
 * one quality classifier the detectors pick a downgrade with, and it counts
 * every OFF_LADDER_DOWNGRADE_RUNG kind, so the classifier and the gate read the
 * same table. triSuggestionTssReduction is the TSS an accepted change takes off
 * the plan, priced by the same landing type or rung, minutes and load rule the
 * apply step writes (triDowngradeTssReduction, triSwapEasyTssReduction,
 * triTrimTssReduction), so the overload modal's "-N TSS" is the applied change.
 *
 * Every accepted change re-prices aerobic/anaerobic, so the plan header, the
 * Home day target (getPlannedDayTSSContext) and the overload detector read the
 * new prescription's load (canonical TSS, Load Currency Law).
 */

import type { SimulatorState, Workout, Week } from '@/types/state';
import type { TriSuggestionMod } from './tri-suggestion-aggregator';
import { runPaceRung, stepDownRunType, generatorRpeForRunType } from '@/constants/intensity-ladder';
import { BIKE_INTENSITY_LADDER, SWIM_INTENSITY_LADDER, OFF_LADDER_DOWNGRADE_RUNG } from '@/constants/triathlon-constants';
import type { TriSkillSlider } from '@/types/triathlon';
import { isLongRun } from '@/workouts/long-run';
import { retargetDescriptionPace, scaleWattRanges, setSwimPaceTokens } from '@/workouts/workout-scaling';
import { loadForRung, loadForTriRun, type PlannedLoad } from '@/workouts/rung-load';
import { describeBikeSession, nameForBike, rpeForBike, type BikeSessionKind } from '@/workouts/bike';
import { describeSwimSession, estimateDistanceMetres, nameForSwim, rpeForSwim, type SwimSessionKind } from '@/workouts/swim';
import { triRunEasyPaceSec } from '@/workouts/tri-run-pace';

export interface ApplyResult {
  applied: number;
  skipped: number;
  /** Workout IDs touched, useful for the modal's "applied X mods" toast. */
  touched: string[];
}

/** Swap-to-easy keeps 75% of the planned minutes (pre-existing cut, unchanged). */
const SWAP_EASY_DURATION_FACTOR = 0.75;
/** A trim keeps 85% of the planned minutes (pre-existing cut, unchanged). The
 *  overload detector prices a trim from this same cut (triTrimTssReduction). */
const TRIM_DURATION_FACTOR = 0.85;

/** The easy rung a swap lands on, per discipline. Same aerobic default the
 *  Adjust overlay opens on (endurance: bike ladder idx 0, swim ladder idx 1). */
const SWAP_EASY_RUNG = { bike: 'bike_endurance', swim: 'swim_endurance' } as const;

type Disc = 'run' | 'bike' | 'swim';
type Rung = { key: string };

/**
 * Apply accepted mods. At most one mod changes a given session per call: a later
 * mod whose target an earlier mod in the same batch already changed is counted
 * as skipped. The RPE-blown row and the readiness row both target today's first
 * open session, and both are ticked by default, so without this one "Apply
 * selected" stepped the session twice (threshold run -> easy -> recovery; swim
 * threshold -> endurance -> technique) or cut its minutes twice (60 -> 45 -> 34).
 * The first mod for a target wins; collectTriSuggestions already merges rows on
 * one target into the strongest, so in the modal this guard is the backstop.
 * Across launches, isOpenForTriSuggestion keeps a changed session out of new
 * proposals.
 */
export function applyTriSuggestions(state: SimulatorState, mods: TriSuggestionMod[]): ApplyResult {
  let applied = 0;
  let skipped = 0;
  const touched: string[] = [];
  const changedThisBatch = new Set<string>();

  for (const mod of mods) {
    if (!mod.targetWorkoutId) { skipped += 1; continue; }
    if (changedThisBatch.has(mod.targetWorkoutId)) { skipped += 1; continue; }
    const hit = findWorkoutById(state, mod.targetWorkoutId);
    if (!hit) { skipped += 1; continue; }
    const { workout, week } = hit;
    if (!canApplyTriSuggestion(workout, mod.action)) { skipped += 1; continue; }

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
        // 15% shorter at the same intensity (volume ramp, cross-training overload).
        ok = applyTrim(workout, mod);
        break;
    }
    if (ok) {
      applied += 1;
      touched.push(workout.id ?? '');
      changedThisBatch.add(mod.targetWorkoutId);
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

/** True when the session's type is not on its discipline's ladder. */
function isOffLadder(w: Workout, d: 'bike' | 'swim'): boolean {
  return ladderFor(d).findIndex(r => r.key === w.t) < 0;
}

/**
 * Index of the rung a downgrade lands on, or -1 when there is none.
 *  - type on the ladder: one rung below currentRungIdx (none on the bottom rung);
 *  - off-ladder type: the rung OFF_LADDER_DOWNGRADE_RUNG maps it to. When the
 *    Adjust overlay has stamped a rung on it (intensityLevel), the session is
 *    priced and shown at that rung (loadForRung, intensityTargetLabel), so it
 *    steps one rung below that instead: the mapped rung could sit at or above
 *    it (an over-under Adjusted to tempo would otherwise step UP to sweet spot).
 *    An off-ladder step that would raise the session's planned load is not a
 *    downgrade and is not offered (raisesPlannedLoad).
 */
function downgradeRungIdx(w: Workout, d: 'bike' | 'swim'): number {
  const ladder = ladderFor(d);
  if (!isOffLadder(w, d)) {
    const cur = currentRungIdx(w, d);
    return cur > 0 ? cur - 1 : -1;
  }
  const stamped = w.intensityLevel ? ladder.findIndex(r => r.key === w.intensityLevel) : -1;
  const mapped = OFF_LADDER_DOWNGRADE_RUNG[w.t];
  const to = stamped >= 0 ? stamped - 1 : mapped ? ladder.findIndex(r => r.key === mapped) : -1;
  if (to < 0) return -1;
  return raisesPlannedLoad(w, ladder[to].key) ? -1 : to;
}

/** Total planned TSS of a load; NaN when unknown (no load, or a kind with no
 *  rate: loadForSwim returns NaN shares for swim_openwater). */
function totalOf(load: PlannedLoad | null): number {
  return load ? load.aerobic + load.anaerobic : NaN;
}

/**
 * Planned TSS of a bike / swim session's current prescription at `minutes`, by
 * its own rate: loadForRung for the rung it is written at (an Adjust-stamped
 * intensityLevel, else its type), the rate the generator, the Adjust overlay
 * and the apply step price with. The stored aerobic + anaerobic is the fallback
 * only for a kind with no rate (swim_openwater), because it goes stale on the
 * canonical path: applyTriEffortMultipliers (effort-multiplier.triathlon.ts)
 * scales estimatedDurationMin by 0.85 to 1.15 at every week-rollover rebake
 * (events.ts rebakeFutureWeeksInPlace -> generateTriathlonPlan) and does not
 * re-price the load. NaN when neither is known.
 */
function ownLoadTotal(w: Workout, minutes: number): number {
  const own = totalOf(loadForRung(w.intensityLevel ?? w.t, minutes));
  if (Number.isFinite(own) && own > 0) return own;
  const stored = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
  return stored > 0 ? stored : NaN;
}

/**
 * True when rung `toKey` prices above the session's current prescription, both
 * at its planned minutes (ownLoadTotal vs loadForRung). The ladders rise in TSS
 * per minute rung by rung (loadForBike / loadForSwim), so a step down a ladder
 * never trips this. An off-ladder kind's rate is its own: neuromuscular sprints
 * (bike_vlamax, loadForBike 1.10 TSS/min, rest-dominated) sit below sweet spot
 * (1.5), so the mapped step would add load under a "downgrade" label. Judged by
 * rate, not against the stored load, so an effort-scaled session (minutes x
 * 1.05, load unchanged) keeps its step: over-under / hills (1.65 -> 1.5) and VO2
 * micros (1.75 -> 1.7) pass at any multiplier. When either side is unknown
 * nothing is blocked.
 */
function raisesPlannedLoad(w: Workout, toKey: string): boolean {
  const minutes = minutesOf(w);
  const next = totalOf(loadForRung(toKey, minutes));
  const current = ownLoadTotal(w, minutes);
  if (!Number.isFinite(next) || !Number.isFinite(current)) return false;
  return next > current;
}

/**
 * The load applyDowngrade stamps on the session: the landing run type
 * (stepDownRunType, loadForTriRun) or bike / swim rung (downgradeRungIdx,
 * loadForRung), at the session's planned minutes. Null when no downgrade
 * applies (canApplyTriSuggestion).
 */
function downgradeLandingLoad(w: Workout): PlannedLoad | null {
  if (!canApplyTriSuggestion(w, 'downgrade_today')) return null;
  const d = ladderDiscipline(w);
  const minutes = minutesOf(w);
  if (!d) return null;
  if (d === 'run') return loadForTriRun(stepDownRunType(w.t, 1, { longRun: isLongRun(w) }), minutes);
  return loadForRung(ladderFor(d)[downgradeRungIdx(w, d)].key, minutes);
}

/**
 * Planned TSS an accepted downgrade_today takes off the session: its stored
 * aerobic + anaerobic minus the load the apply step stamps at the landing rung
 * or type (downgradeLandingLoad, the same downgradeRungIdx / loadForRung /
 * loadForTriRun applyDowngrade prices with). That is exactly the change in the
 * plan header, and it is in the currency the cross-training overload detector
 * does all its arithmetic in (plannedTriTSS, remainingTSS and the floor are
 * stored sums), so the modal's "-N TSS" and the applied change come from one
 * computation. A generated 60-min VO2 micros ride steps 105 -> 102 TSS (-3);
 * a 60-min threshold ride to sweet spot 102 -> 91 (-11).
 * 0 when no downgrade applies, or when the landing load is not below the
 * stored one. That happens when the stored load is stale:
 * applyTriEffortMultipliers scaled the minutes up and left the load (a VO2
 * micros session at x1.05: 105 stored, threshold at 63 min prices 107). The
 * overload builders then book no reduction and skip the downgrade, while the
 * readiness row, which books no TSS, still offers it (raisesPlannedLoad judges
 * by rate).
 */
export function triDowngradeTssReduction(w: Workout): number {
  const landing = totalOf(downgradeLandingLoad(w));
  const stored = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
  if (!Number.isFinite(landing) || stored <= 0) return 0;
  return Math.max(0, stored - landing);
}

/** The run type a swap to easy lands on: easy ('long' for the long-run slot),
 *  never up (a session already at or below easy keeps its type). */
function swapEasyRunType(w: Workout): string {
  const easyT = isLongRun(w) ? 'long' : 'easy';
  return runPaceRung(w.t) > runPaceRung(easyT) ? easyT : w.t;
}

/** The bike / swim rung a swap to easy lands on: SWAP_EASY_RUNG, never up (a
 *  session already at or below it keeps its rung). */
function swapEasyRung(w: Workout, d: 'bike' | 'swim'): Rung {
  const ladder = ladderFor(d);
  const cur = currentRungIdx(w, d);
  const easyIdx = ladder.findIndex(r => r.key === SWAP_EASY_RUNG[d]);
  return cur > easyIdx ? ladder[easyIdx] : ladder[cur];
}

/** Minutes a swap to easy leaves (SWAP_EASY_DURATION_FACTOR, rounded). */
function swapEasyMinutes(w: Workout): number {
  return Math.round(minutesOf(w) * SWAP_EASY_DURATION_FACTOR);
}

/**
 * The load applySwapEasy stamps on the session: the landing run type
 * (swapEasyRunType, loadForTriRun) or bike / swim rung (swapEasyRung,
 * loadForRung) at the shortened minutes (swapEasyMinutes). Null when no swap
 * applies (canApplyTriSuggestion) or the shortened minutes round to 0 (the
 * apply step then leaves the load as it is).
 */
function swapEasyLandingLoad(w: Workout): PlannedLoad | null {
  if (!canApplyTriSuggestion(w, 'swap_easy')) return null;
  const d = ladderDiscipline(w);
  const minutes = swapEasyMinutes(w);
  if (!d || !(minutes > 0)) return null;
  if (d === 'run') return loadForTriRun(swapEasyRunType(w), minutes);
  return loadForRung(swapEasyRung(w, d).key, minutes);
}

/**
 * Planned TSS an accepted swap_easy takes off the session: its stored
 * aerobic + anaerobic minus the load applySwapEasy stamps (swapEasyLandingLoad,
 * the easy type or rung at 75% of the minutes). The same rule as
 * triDowngradeTssReduction, so the overload modal's "-N TSS" is the change the
 * plan receives. It replaced a flat 50% of the stored load, which understated
 * the cut: a 60-min threshold run (107 TSS at TL_PER_MIN[7] 1.78/min) lands on
 * 45 min easy (41 TSS at TL_PER_MIN[4] 0.92/min), 66 TSS or 62% of its load.
 * 0 when no swap applies or the landing load is not below the stored one.
 */
export function triSwapEasyTssReduction(w: Workout): number {
  const landing = totalOf(swapEasyLandingLoad(w));
  const stored = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
  if (!Number.isFinite(landing) || stored <= 0) return 0;
  return Math.max(0, stored - landing);
}

/**
 * The minutes and load applyTrim writes: TRIM_DURATION_FACTOR of the planned
 * minutes, rounded, and each stored load share scaled by the same ratio and
 * rounded (load is proportional to duration at a fixed intensity, the Adjust
 * overlay's duration-only rule, workout-adjust-overlay.ts applyObjectScale). A
 * share the session does not carry stays undefined.
 */
function trimmedPrescription(w: Workout): { minutes: number; aerobic?: number; anaerobic?: number } {
  const oldMin = minutesOf(w);
  const minutes = Math.round(oldMin * TRIM_DURATION_FACTOR);
  const f = oldMin > 0 ? minutes / oldMin : 1;
  return {
    minutes,
    aerobic: typeof w.aerobic === 'number' ? Math.round(w.aerobic * f) : undefined,
    anaerobic: typeof w.anaerobic === 'number' ? Math.round(w.anaerobic * f) : undefined,
  };
}

/**
 * Planned TSS an accepted trim_volume takes off the session: its stored load
 * minus the load applyTrim writes (trimmedPrescription). Close to 15% of the
 * stored load, but exact: the minutes round, so a 45-min session keeps 38 min
 * (15.6% off), and each share rounds. 0 when no trim applies.
 */
export function triTrimTssReduction(w: Workout): number {
  if (!canApplyTriSuggestion(w, 'trim_volume')) return 0;
  const stored = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
  const next = trimmedPrescription(w);
  return Math.max(0, stored - ((next.aerobic ?? 0) + (next.anaerobic ?? 0)));
}

/**
 * Planned TSS accepting `action` on this session takes off the plan, priced by
 * the apply step's own re-pricing (one function per action above). The
 * cross-training overload builders book this figure against their budget and
 * show it in the modal, so the "-N TSS" a user accepts is the change the plan
 * header then shows (Load Currency Law: a credit can't exceed its load, and the
 * credit is what Apply takes). 0 when the apply step would not change the
 * session or would not lower its load.
 */
export function triSuggestionTssReduction(w: Workout, action: TriSuggestionMod['action']): number {
  switch (action) {
    case 'downgrade_today': return triDowngradeTssReduction(w);
    case 'swap_easy': return triSwapEasyTssReduction(w);
    case 'trim_volume': return triTrimTssReduction(w);
  }
}

/** Type substrings marking a tri / cycling session as quality. The list both
 *  detectors carried (tri-suggestion-aggregator.ts, tri-cross-training-overload.ts),
 *  unchanged. */
const TRI_QUALITY_TYPE_KEYWORDS = ['threshold', 'vo2', 'tempo', 'sweet_spot', 'sweetspot', 'speed', 'race_pace', 'intervals', 'hills', 'brick'];

/**
 * True when the session is a quality session for the readiness row and the
 * cross-training overload builders (they propose a downgrade or swap for it,
 * a trim otherwise). The keyword list plus every OFF_LADDER_DOWNGRADE_RUNG kind
 * (bike_over_under, bike_vlamax, bike_hills, bike_vo2_micros, swim_openwater),
 * the table canApplyTriSuggestion lands their downgrade with, so the classifier
 * and the gate cannot drift: over-unders, sprints and open-water swims match
 * no keyword. A kind the gate still refuses (bike_vlamax: sweet spot would add
 * load) is quality but gets no downgrade, so neither detector proposes one; the
 * overload builders do not trim it either (a quality session gets a downgrade,
 * a swap or nothing, as a brick does).
 */
export function isTriQualitySession(w: Workout): boolean {
  const t = (w.t ?? '').toLowerCase();
  return TRI_QUALITY_TYPE_KEYWORDS.some(k => t.includes(k))
    || Object.prototype.hasOwnProperty.call(OFF_LADDER_DOWNGRADE_RUNG, w.t ?? '');
}

/** Planned minutes, or 0 when the session carries none. A swap or downgrade
 *  needs minutes to price the new prescription (Load Currency Law), so a
 *  session without them is left untouched and counted as skipped rather than
 *  changing type, targets and RPE under its old load. estimateTriWorkoutMin
 *  (week-resolve.triathlon.ts) is not a usable fallback here: it reads the
 *  largest single "Nmin" token, so a structured session reads as one block (a
 *  generated 80-min bike threshold reads 15 min, which would re-price 105 TSS
 *  as about 17). Generated sessions always carry estimatedDurationMin. */
function minutesOf(w: Workout): number {
  return typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0 ? w.estimatedDurationMin : 0;
}

/**
 * True when accepting `action` on this session would change it. The single
 * gate shared by the apply step and every detector that proposes a target (the
 * cross-training overload Reduce / Replace builders, the readiness gate and the
 * RPE-blown row), so no row promises a change the apply step then skips, and an
 * overload's reduction budget goes to sessions that can take it.
 *  - every action needs planned minutes (minutesOf) to price the result;
 *  - trim_volume: any session with minutes (same intensity, 15% shorter);
 *  - swap_easy / downgrade_today need a single ladder (ladderDiscipline): never
 *    a brick;
 *  - run: the type on RUN_PACE_LADDER; downgrade_today also needs a pace
 *    category below it;
 *  - bike / swim swap_easy: the type on BIKE_INTENSITY_LADDER /
 *    SWIM_INTENSITY_LADDER (an off-ladder kind's swap is not decided);
 *  - bike / swim downgrade_today: a rung to land on (downgradeRungIdx), which
 *    off-ladder kinds get from OFF_LADDER_DOWNGRADE_RUNG when it does not raise
 *    their planned load.
 * A swap on a session already at or below easy still applies (it keeps its type
 * and loses 25% of the minutes).
 */
export function canApplyTriSuggestion(w: Workout, action: TriSuggestionMod['action']): boolean {
  if (minutesOf(w) <= 0) return false;
  if (action === 'trim_volume') return true;
  const d = ladderDiscipline(w);
  if (!d) return false;
  if (d === 'run') {
    if (runPaceRung(w.t) < 0) return false;
    return action === 'swap_easy' || stepDownRunType(w.t, 1, { longRun: isLongRun(w) }) !== w.t;
  }
  if (action === 'downgrade_today') return downgradeRungIdx(w, d) >= 0;
  return currentRungIdx(w, d) >= 0;
}

/** Easy pace the run pace tokens are anchored to: triRunEasyPaceSec, the pace
 *  the tri generator wrote the session from (gp(s.v, s.lt).e, else the run
 *  skill estimate), so a retargeted rep pace comes from the same source as the
 *  pace already in the description. Not s.pac: that is built from effective
 *  VDOT (events.ts) and differs from s.v whenever the two diverge. */
function easyPaceSec(state: SimulatorState): number {
  return triRunEasyPaceSec(state);
}

// ── Adjust overlay baseline ────────────────────────────────────────────────
// The per-session Adjust overlay (workout-adjust-overlay.ts applyObjectScale)
// stashes the plan baseline the first time it scales a session
// (originalDistance, originalDurationMin, originalAerobic, originalAnaerobic)
// and derives every later adjustment, and Reset, from it. It reads the rung the
// baseline description is written at as originalIntensityLevel ?? w.t. An
// accepted suggestion is a plan change, so it moves that baseline with the live
// session: otherwise a later Adjust scales watts from the wrong rung (the
// suggestion rewrote w.t) and Reset restores the pre-suggestion description and
// load under the suggestion's type and name.

/** Adjust's stashed load, written by the overlay on the stored object. */
type AdjustBaseline = Workout & { originalAerobic?: number; originalAnaerobic?: number };

/** Minutes the Adjust baseline load is priced at: the stashed plan minutes, else
 *  the live minutes (Adjust stashes plan minutes only when it had some). */
function baselineMinutes(w: Workout, liveMinutes: number): number {
  return typeof w.originalDurationMin === 'number' && w.originalDurationMin > 0 ? w.originalDurationMin : liveMinutes;
}

/** Re-price Adjust's stashed baseline load, when there is one. */
function repriceBaselineLoad(w: Workout, load: PlannedLoad | null): void {
  const b = w as AdjustBaseline;
  if (!load || (b.originalAerobic == null && b.originalAnaerobic == null)) return;
  b.originalAerobic = load.aerobic;
  b.originalAnaerobic = load.anaerobic;
}

/** Scale Adjust's stashed baseline minutes by the factor a swap or trim applied
 *  to the live session, rounded the same way. Returns [old, new] baseline minutes. */
function scaleBaselineMinutes(w: Workout, factor: number, liveMinutesBefore: number): [number, number] {
  const before = baselineMinutes(w, liveMinutesBefore);
  const after = Math.round(before * factor);
  if (typeof w.originalDurationMin === 'number' && w.originalDurationMin > 0) w.originalDurationMin = after;
  return [before, after];
}

/** Rewrite a description's bike watts / swim paces from rung `fromKey` to `toKey`
 *  (bike: watt ratio; swim: CSS + the new rung's offset), as Adjust does. */
function retargetRung(state: SimulatorState, d: 'bike' | 'swim', desc: string, fromKey: string, toKey: string): string {
  if (d === 'bike') {
    const from = BIKE_INTENSITY_LADDER.find(r => r.key === fromKey);
    const toB = BIKE_INTENSITY_LADDER.find(r => r.key === toKey);
    return from && toB ? scaleWattRanges(desc, toB.pct / from.pct) : desc;
  }
  const toS = SWIM_INTENSITY_LADDER.find(r => r.key === toKey);
  const css = state.triConfig?.swim?.cssSecPer100m;
  return toS && css && css > 0 ? setSwimPaceTokens(desc, css + toS.cssOffsetSec) : desc;
}

/** Move a run to `newT` and price it at `minutes`. Type, RPE and pace tokens
 *  change only when the type changes. Adjust's baseline follows. */
function setRunType(state: SimulatorState, w: Workout, newT: string, minutes: number): void {
  if (newT !== w.t) {
    // OPEN DECISION (Tristan): this writes running mode's generator RPE
    // (RUN_GENERATOR_RPE: easy 3, marathon pace 6, threshold 7, vo2 8). The tri
    // generator writes its own run RPEs (plan_engine.triathlon.ts
    // generateRunSessionForTri: easy 4, long 5 / 6 at peak, threshold 8, vo2 9)
    // and has no value for marathon pace or recovery, the rungs a downgrade can
    // reach. So a tri run swapped to easy expects 3 where a generated easy run
    // expects 4, and a rating of 5 trips detectRpeBlownSession (RPE_BLOWN_DELTA
    // 2) the next day on the swapped session only. A tri-native table needs
    // marathon-pace and recovery values that do not exist yet; until decided,
    // the running scale stays (one table for every rung a downgrade writes).
    const rpe = generatorRpeForRunType(newT);
    if (rpe != null) { w.rpe = rpe; w.r = rpe; }
    const easy = easyPaceSec(state);
    if (w.d) w.d = retargetDescriptionPace(w.d, newT, easy);
    // Pace retargeting is absolute (easy pace x the type's factor), so the
    // baseline needs no source type.
    if (w.originalDistance) w.originalDistance = retargetDescriptionPace(w.originalDistance, newT, easy);
    w.t = newT;
  }
  const load = minutes > 0 ? loadForTriRun(newT, minutes) : null;
  if (load) { w.aerobic = load.aerobic; w.anaerobic = load.anaerobic; }
  const baseMin = baselineMinutes(w, minutes);
  repriceBaselineLoad(w, baseMin > 0 ? loadForTriRun(newT, baseMin) : null);
}

/** The generator's description for rung `toKey` at `minutes` (bike.ts
 *  describeBikeSession / swim.ts describeSwimSession, the builders the plan
 *  engine uses), for a session whose own description has no rung to scale
 *  from. Variant from the week number, slot 0 (as the ad-hoc session generator
 *  does); skill falls back to 3 as the plan engine does
 *  (plan_engine.triathlon.ts: tri.skillRating ?? { swim: 3, bike: 3, run: 3 }). */
function describeAtRung(state: SimulatorState, week: Week, d: 'bike' | 'swim', toKey: string, minutes: number): string {
  const kind = toKey.slice(d.length + 1);
  const weekNo = week.w ?? 1;
  if (d === 'bike') {
    const bike = state.triConfig?.bike;
    return describeBikeSession(kind as BikeSessionKind, minutes, bike?.ftp, bike?.hasPowerMeter, weekNo, 0);
  }
  const skill = (state.triConfig?.skillRating?.swim ?? 3) as TriSkillSlider;
  const css = state.triConfig?.swim?.cssSecPer100m;
  const desc = describeSwimSession(kind as SwimSessionKind, estimateDistanceMetres(minutes, skill, css), css, skill, weekNo, 0);
  // Paces at the rung's CSS offset, as a ladder step writes them (retargetRung),
  // so the description agrees with the rung target the card shows.
  return retargetRung(state, 'swim', desc, toKey, toKey);
}

/** Move a bike/swim session to rung `to` and price it at `minutes`, the way the
 *  Adjust overlay applies a rung (workout-adjust-overlay.ts applyObjectScale).
 *  Adjust's baseline follows. An off-ladder session's description (and Adjust's
 *  baseline description) is rebuilt for the new rung rather than scaled. */
function setRung(state: SimulatorState, week: Week, w: Workout, d: 'bike' | 'swim', to: Rung, minutes: number): void {
  const fromKey = w.intensityLevel ?? w.t;
  const offLadder = isOffLadder(w, d);
  if (to.key !== fromKey || offLadder) {
    if (offLadder) {
      if (w.d && minutes > 0) w.d = describeAtRung(state, week, d, to.key, minutes);
      const baseMin = baselineMinutes(w, minutes);
      if (w.originalDistance && baseMin > 0) w.originalDistance = describeAtRung(state, week, d, to.key, baseMin);
    } else {
      // Rung Adjust's baseline description is written at: its own anchor once it
      // has changed a rung (originalIntensityLevel defined), else the session's.
      const baseKey = w.originalIntensityLevel !== undefined ? (w.originalIntensityLevel ?? w.t) : fromKey;
      if (w.d) w.d = retargetRung(state, d, w.d, fromKey, to.key);
      if (w.originalDistance) w.originalDistance = retargetRung(state, d, w.originalDistance, baseKey, to.key);
    }
    w.intensityLevel = to.key;
    w.t = to.key;
    // The description (and Adjust's baseline) is now written at to.key = w.t,
    // so Adjust's rung anchor (originalIntensityLevel ?? w.t) must resolve to
    // w.t: null ("no generation-stamped rung"). A stashed generation rung would
    // point re-adjusts and Reset at a rung the description no longer carries.
    w.originalIntensityLevel = null;
    const kind = to.key.slice(d.length + 1);
    const rpe = d === 'bike'
      ? rpeForBike(kind as BikeSessionKind, week.ph)
      : rpeForSwim(kind as SwimSessionKind, week.ph);
    w.rpe = rpe;
    w.r = rpe;
  }
  const load = minutes > 0 ? loadForRung(to.key, minutes) : null;
  if (load) { w.aerobic = load.aerobic; w.anaerobic = load.anaerobic; }
  const baseMin = baselineMinutes(w, minutes);
  repriceBaselineLoad(w, baseMin > 0 ? loadForRung(to.key, baseMin) : null);
}

function swapReason(source: TriSuggestionMod['source']): string {
  switch (source) {
    case 'rpe_blown': return 'high RPE yesterday';
    case 'readiness': return 'low readiness';
    case 'cross_training_overload': return 'cross-training load';
    case 'volume_ramp': return 'volume ramp';
  }
}

// applySwapEasy / applyDowngrade / applyTrim run only after
// canApplyTriSuggestion passed: the session has minutes, a ladder and a rung on
// it, and (downgrade) a rung below. The remaining checks narrow types.

function applySwapEasy(state: SimulatorState, week: Week, w: Workout, mod: TriSuggestionMod): boolean {
  const d = ladderDiscipline(w);
  if (!d) return false;
  const oldMin = minutesOf(w);
  const newMin = swapEasyMinutes(w);

  // Landing type / rung and minutes from the same helpers swapEasyLandingLoad
  // prices with (triSwapEasyTssReduction), so the booked cut is the applied one.
  const oldT = w.t;
  if (d === 'run') {
    // Easy rung ('long' for the long-run slot). Never up: a session already at
    // or below easy keeps its type and only loses the minutes.
    const newT = swapEasyRunType(w);
    stampOriginal(w);
    if (newMin > 0) w.estimatedDurationMin = newMin;
    if (newMin > 0) scaleBaselineMinutes(w, SWAP_EASY_DURATION_FACTOR, oldMin);
    setRunType(state, w, newT, newMin);
  } else {
    const to = swapEasyRung(w, d);
    stampOriginal(w);
    if (newMin > 0) w.estimatedDurationMin = newMin;
    if (newMin > 0) scaleBaselineMinutes(w, SWAP_EASY_DURATION_FACTOR, oldMin);
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
    const newT = stepDownRunType(w.t, 1, { longRun: isLongRun(w) });
    stampOriginal(w);
    setRunType(state, w, newT, minutes);
    w.n = `${capitalize(newT.replace(/_/g, ' '))} run (downgrade)`;
  } else {
    const to = ladderFor(d)[downgradeRungIdx(w, d)];
    stampOriginal(w);
    setRung(state, week, w, d, to, minutes);
    const kind = to.key.slice(d.length + 1);
    w.n = `${d === 'bike' ? nameForBike(kind as BikeSessionKind) : nameForSwim(kind as SwimSessionKind)} (downgrade)`;
  }

  w.status = 'reduced';
  w.modReason = mod.source === 'readiness' ? 'Readiness downgrade' : 'Manage load';
  return true;
}

function applyTrim(w: Workout, mod: TriSuggestionMod): boolean {
  const oldMin = minutesOf(w);
  // Minutes and load from trimmedPrescription, the rule triTrimTssReduction
  // prices with (duration-only: load scales with the minutes).
  const next = trimmedPrescription(w);
  stampOriginal(w);
  w.estimatedDurationMin = next.minutes;
  if (next.aerobic !== undefined) w.aerobic = next.aerobic;
  if (next.anaerobic !== undefined) w.anaerobic = next.anaerobic;
  // Adjust's baseline takes the same trim, so Reset keeps it.
  const [baseBefore, baseAfter] = scaleBaselineMinutes(w, TRIM_DURATION_FACTOR, oldMin);
  const b = w as AdjustBaseline;
  if (baseBefore > 0) {
    const bf = baseAfter / baseBefore;
    if (typeof b.originalAerobic === 'number') b.originalAerobic = Math.round(b.originalAerobic * bf);
    if (typeof b.originalAnaerobic === 'number') b.originalAnaerobic = Math.round(b.originalAnaerobic * bf);
  }
  w.status = 'reduced';
  // The reason names what asked for the trim, as applyDowngrade does: an
  // overload trim read "Volume ramp trim" (volume-ramp suggestions are off,
  // TRI_VOLUME_RAMP_SUGGESTIONS_LIVE, so every trim was an overload trim).
  // modReason reaches the AI coach's plan context (coach-context-builder).
  w.modReason = mod.source === 'volume_ramp' ? 'Volume ramp trim' : 'Manage load';
  return true;
}

function stampOriginal(w: Workout): void {
  w.originalName = w.originalName ?? w.n;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
