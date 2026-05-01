/**
 * Cross-training overload detector for triathlon mode (v2).
 *
 * Triggers when accumulated cross-training TSS this week (anything not in
 * `wk.triWorkouts`) exceeds a threshold fraction of planned tri-discipline
 * TSS. v2 emits per-discipline reduce/replace mod sets so the modal can
 * surface a chip switcher and the user can flip the recommendation onto any
 * of swim/bike/run, bounded by a hard floor.
 *
 * **Side of the line**: planning. Pure read-only function.
 *
 * Mirrors running's suggester (`src/cross-training/suggester.ts`):
 *  - Severity classification (light / heavy / extreme) at 15% / 25% thresholds.
 *    These mirror the user's accepted v1 values; tri uses smaller bands
 *    (15/25) than running (25/55) because tri has fewer mod-able workouts
 *    per discipline so over-modding fragments the week.
 *  - Multi-mod by severity (heavy → 1–2; extreme → 2–3).
 *  - Saturation curve borrowed from running (`saturateCredit`) caps how much
 *    a single cross-training session can credit toward reductions.
 *  - Per-discipline floor (`computeTriDisciplineFloorTSS`) — the user can
 *    override the recommendation onto any discipline but reductions are
 *    bounded by the floor (suspended in taper or when ramp is hot).
 *
 * Plan-vs-extra rule (per CLAUDE.md "anything in your plan is in your plan"):
 * cross-training is identified by ID membership in `wk.triWorkouts`, not by
 * the `discipline` field. A planned `cross` or `gym` session whose discipline
 * is `undefined` is still part of the plan and should NOT trigger overload.
 */

import type { SimulatorState, Workout, Week } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { computeTriDisciplineFloorTSS } from './tri-discipline-floor';

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

/** Cross-training TSS / planned TSS — minimum overshoot to fire any flag. */
const OVERLOAD_THRESHOLD = 0.15;

/** Above this overshoot we move from 'heavy' to 'extreme' severity. */
const EXTREME_THRESHOLD = 0.25;

/** Max number of mods we'll propose per discipline at each severity tier. */
const MAX_MODS_HEAVY = 2;
const MAX_MODS_EXTREME = 3;

/** Saturation curve constants (mirror running's `suggester.ts:60-62`). */
const SATURATION_CAP = 1500;
const SATURATION_TAU = 800;

/** Workout-type substrings marking a session as quality (intensity-heavy). */
const QUALITY_KEYWORDS = [
  'threshold',
  'vo2',
  'tempo',
  'sweet_spot',
  'sweetspot',
  'speed',
  'race_pace',
  'intervals',
  'hills',
  'brick',
];

/** Trim fraction for endurance reductions (15% off planned duration). */
const TRIM_FRACTION = 0.15;

/** Replace-with-easy reduces the session's TSS by ~50% (intensity drop). */
const REPLACE_WITH_EASY_TSS_REDUCTION = 0.50;

/** Quality downgrade reduces TSS by ~25% (one tier down on the intensity ladder). */
const DOWNGRADE_TSS_REDUCTION = 0.25;

const DISCIPLINES: Discipline[] = ['swim', 'bike', 'run'];

// ───────────────────────────────────────────────────────────────────────────
// Output shape
// ───────────────────────────────────────────────────────────────────────────

/**
 * One proposed plan adjustment within a discipline option set.
 * Same shape as `TriSuggestionMod` actions but tagged with the workout's
 * own metadata so the modal can render line items.
 */
export interface OverloadAdjustment {
  workoutId: string;
  workoutLabel: string;
  discipline: Discipline;
  action: 'trim_volume' | 'downgrade_today' | 'swap_easy';
  /** Estimated TSS this adjustment removes from the week. */
  tssReduction: number;
}

/** Per-discipline option set. The modal flips between three of these. */
export interface DisciplineOption {
  discipline: Discipline;
  /** Sum of (aerobic + anaerobic) over UPCOMING non-skipped workouts. */
  remainingTSS: number;
  /** Floor below which we won't reduce. 0 means no floor (taper or hot ramp). */
  floorTSS: number;
  /** True if applying ALL reduceMods would push remaining below floorTSS. */
  belowFloor: boolean;
  /** Reduce-only mods (downgrade quality, trim endurance). Capped by floor. */
  reduceMods: OverloadAdjustment[];
  /** Replace-and-reduce mods (swap quality with easy + trim others). Capped by floor. */
  replaceMods: OverloadAdjustment[];
}

export interface CrossTrainingOverloadResult {
  /** Total cross-training TSS this week (after dedup, after carry decay if any). */
  crossTrainingTSS: number;
  /** Sum of planned tri-discipline TSS for the week. */
  plannedTriTSS: number;
  /** crossTrainingTSS / plannedTriTSS. */
  overshootPct: number;
  /** 'heavy' = 15–25%; 'extreme' = >25%. (Below 15% the detector returns null.) */
  severity: 'heavy' | 'extreme';
  /** Discipline with the most remaining planned TSS — the auto-recommendation. */
  recommendedDiscipline: Discipline;
  /** Per-discipline mod options. UI chips switch between these. */
  options: {
    swim: DisciplineOption;
    bike: DisciplineOption;
    run: DisciplineOption;
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────

export function detectCrossTrainingOverload(
  state: SimulatorState,
  /** Today's day-of-week (0=Mon..6=Sun). Defaulted from `new Date()`; tests pass a fixed value. */
  todayDow: number = (new Date().getDay() + 6) % 7,
): CrossTrainingOverloadResult | null {
  if (state.eventType !== 'triathlon') return null;

  const weekIdx = state.w ?? 0;
  const wk = (state.wks ?? [])[weekIdx];
  if (!wk?.triWorkouts?.length) return null;

  const plannedTriTSS = wk.triWorkouts.reduce(
    (acc, w) => acc + (w.aerobic ?? 0) + (w.anaerobic ?? 0),
    0,
  );
  if (plannedTriTSS <= 0) return null;

  const crossTrainingTSS = computeCrossTrainingTSS(wk);
  if (crossTrainingTSS <= 0) return null;

  const overshootPct = crossTrainingTSS / plannedTriTSS;
  if (overshootPct < OVERLOAD_THRESHOLD) return null;

  const severity: 'heavy' | 'extreme' = overshootPct > EXTREME_THRESHOLD ? 'extreme' : 'heavy';
  const maxMods = severity === 'extreme' ? MAX_MODS_EXTREME : MAX_MODS_HEAVY;

  // Saturation: a single huge cross-training session shouldn't unlock
  // unbounded reductions. Cap the "credit" available per discipline by
  // running's saturation curve. The cap is applied to TSS reductions
  // proposed per discipline.
  const reductionCredit = SATURATION_CAP * (1 - Math.exp(-crossTrainingTSS / SATURATION_TAU));

  const options = {
    swim: buildDisciplineOption(state, wk, weekIdx, 'swim', todayDow, maxMods, reductionCredit),
    bike: buildDisciplineOption(state, wk, weekIdx, 'bike', todayDow, maxMods, reductionCredit),
    run:  buildDisciplineOption(state, wk, weekIdx, 'run',  todayDow, maxMods, reductionCredit),
  };

  // Recommended = discipline with most remaining planned TSS. Ties broken
  // by an implicit order (bike, run, swim) — bike is typically the largest
  // share of an Ironman week, so a tie-break that favours it is sane default.
  const recommendedDiscipline =
    options.bike.remainingTSS >= options.run.remainingTSS &&
    options.bike.remainingTSS >= options.swim.remainingTSS
      ? 'bike'
      : options.run.remainingTSS >= options.swim.remainingTSS
        ? 'run'
        : 'swim';

  // If the recommended discipline has zero remaining TSS (everything done or
  // skipped), the detector has nothing to act on. Don't emit a flag.
  if (options[recommendedDiscipline].remainingTSS <= 0) return null;

  return {
    crossTrainingTSS: Math.round(crossTrainingTSS),
    plannedTriTSS: Math.round(plannedTriTSS),
    overshootPct,
    severity,
    recommendedDiscipline,
    options,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-training TSS sum (with dedup, membership filter)
// ───────────────────────────────────────────────────────────────────────────

function computeCrossTrainingTSS(wk: Week): number {
  // Membership filter: a session is cross-training if its id is NOT in
  // `wk.triWorkouts`. Per "anything in your plan is in your plan" — a
  // planned `cross`/`gym` session in triWorkouts is plan, not overload.
  const planIds = new Set(
    (wk.triWorkouts ?? []).map(w => w.id).filter((id): id is string => !!id),
  );
  const countedIds = new Set<string>();
  let total = 0;

  // Pass 1: adhocWorkouts — manual entries land here exclusively; synced
  // entries land here AND in garminActuals at the same id (we dedupe in pass 2).
  for (const adhoc of wk.adhocWorkouts ?? []) {
    if (adhoc.id && planIds.has(adhoc.id)) continue; // in-plan: skip
    if (adhoc.id) countedIds.add(adhoc.id);
    total += tssOfWorkout(adhoc);
  }

  // Pass 2: garminActuals — only count entries we haven't already attributed
  // to an adhoc, and skip entries matched to a tri-plan workout.
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (countedIds.has(workoutId)) continue;
    if (planIds.has(workoutId)) continue;
    if (actual.iTrimp == null || actual.iTrimp <= 0) continue;
    total += actual.iTrimp / 150;
  }

  return total;
}

function tssOfWorkout(w: Workout): number {
  if (w.iTrimp != null && w.iTrimp > 0) return w.iTrimp / 150;
  return (w.aerobic ?? 0) + (w.anaerobic ?? 0);
}

// ───────────────────────────────────────────────────────────────────────────
// Per-discipline option builder
// ───────────────────────────────────────────────────────────────────────────

function buildDisciplineOption(
  state: SimulatorState,
  wk: Week,
  weekIdx: number,
  discipline: Discipline,
  todayDow: number,
  maxMods: number,
  reductionCredit: number,
): DisciplineOption {
  const candidates = (wk.triWorkouts ?? []).filter(
    w => w.discipline === discipline && isModifiable(w, todayDow),
  );

  const remainingTSS = candidates.reduce(
    (acc, w) => acc + (w.aerobic ?? 0) + (w.anaerobic ?? 0),
    0,
  );

  const floorTSS = computeTriDisciplineFloorTSS(state, discipline, weekIdx);

  const reduceMods = buildReduceMods(candidates, maxMods, reductionCredit);
  const replaceMods = buildReplaceMods(candidates, maxMods, reductionCredit);

  // belowFloor = the proposed Reduce mods would drop remaining below floor.
  // We don't block — the modal warns and lets the user override.
  const totalReduceTSS = reduceMods.reduce((acc, m) => acc + m.tssReduction, 0);
  const belowFloor = floorTSS > 0 && (remainingTSS - totalReduceTSS) < floorTSS;

  return {
    discipline,
    remainingTSS: Math.round(remainingTSS),
    floorTSS: Math.round(floorTSS),
    belowFloor,
    reduceMods,
    replaceMods,
  };
}

/** Modifiable = upcoming, not skipped/replaced/completed, has an id. */
function isModifiable(w: Workout, todayDow: number): boolean {
  if (!w.id) return false;
  const status = w.status as string | undefined;
  if (status === 'skipped' || status === 'replaced' || status === 'completed') return false;
  if (w.dayOfWeek != null && w.dayOfWeek < todayDow) return false;
  return true;
}

function isQualityWorkout(w: Workout): boolean {
  const t = (w.t ?? '').toLowerCase();
  return QUALITY_KEYWORDS.some(k => t.includes(k));
}

// ───────────────────────────────────────────────────────────────────────────
// Mod builders
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reduce-only: downgrade nearest upcoming quality, trim endurance volume.
 * No workouts are removed from the plan; sessions just get easier or shorter.
 *
 * Mods are NOT silently capped by the floor — if the resulting remaining-TSS
 * would breach the floor, the option's `belowFloor` flag fires and the modal
 * warns the user before commit. This matches running's behaviour where the
 * floor is suspended rather than silently enforced.
 */
function buildReduceMods(
  candidates: Workout[],
  maxMods: number,
  reductionCredit: number,
): OverloadAdjustment[] {
  const sorted = sortByDayThenQuality(candidates);
  const mods: OverloadAdjustment[] = [];
  let budget = reductionCredit;

  for (const w of sorted) {
    if (mods.length >= maxMods) break;
    if (budget <= 0) break;
    const planTSS = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
    if (planTSS <= 0) continue;

    const isQuality = isQualityWorkout(w);
    const reductionFraction = isQuality ? DOWNGRADE_TSS_REDUCTION : TRIM_FRACTION;
    const proposedReduction = Math.min(planTSS * reductionFraction, budget);
    if (proposedReduction <= 0) continue;

    mods.push({
      workoutId: w.id!,
      workoutLabel: w.n || w.t || w.id!,
      discipline: w.discipline as Discipline,
      action: isQuality ? 'downgrade_today' : 'trim_volume',
      tssReduction: Math.round(proposedReduction),
    });
    budget -= proposedReduction;
  }

  return mods;
}

/**
 * Replace + reduce: swap the nearest quality session for an easy version of
 * the same discipline, then trim/downgrade subsequent sessions. Mirrors
 * running's `buildReplaceAdjustments` interleave (replace 1, reduce 1, …).
 *
 * Like `buildReduceMods`, this proposes mods freely and lets the option-level
 * `belowFloor` flag drive UI warnings rather than silently capping.
 */
function buildReplaceMods(
  candidates: Workout[],
  maxMods: number,
  reductionCredit: number,
): OverloadAdjustment[] {
  const sorted = sortByDayThenQuality(candidates);
  const mods: OverloadAdjustment[] = [];
  let budget = reductionCredit;
  let didReplace = false;

  for (const w of sorted) {
    if (mods.length >= maxMods) break;
    if (budget <= 0) break;
    const planTSS = (w.aerobic ?? 0) + (w.anaerobic ?? 0);
    if (planTSS <= 0) continue;

    const isQuality = isQualityWorkout(w);

    // Pick the action: first quality found becomes a swap_easy; everything
    // else is reduce/downgrade like the Reduce-only path.
    let action: 'swap_easy' | 'downgrade_today' | 'trim_volume';
    let reductionFraction: number;
    if (!didReplace && isQuality) {
      action = 'swap_easy';
      reductionFraction = REPLACE_WITH_EASY_TSS_REDUCTION;
      didReplace = true;
    } else {
      action = isQuality ? 'downgrade_today' : 'trim_volume';
      reductionFraction = isQuality ? DOWNGRADE_TSS_REDUCTION : TRIM_FRACTION;
    }

    const proposedReduction = Math.min(planTSS * reductionFraction, budget);
    if (proposedReduction <= 0) continue;

    mods.push({
      workoutId: w.id!,
      workoutLabel: w.n || w.t || w.id!,
      discipline: w.discipline as Discipline,
      action,
      tssReduction: Math.round(proposedReduction),
    });
    budget -= proposedReduction;
  }

  return mods;
}

/**
 * Sort by day ascending (nearest first), then quality before endurance within
 * the same day. Mirrors how a coach would walk the week — touch tomorrow's
 * quality before next week's, and quality before endurance because quality is
 * higher-cost-per-minute.
 */
function sortByDayThenQuality(ws: Workout[]): Workout[] {
  return [...ws].sort((a, b) => {
    const da = a.dayOfWeek ?? 7;
    const db = b.dayOfWeek ?? 7;
    if (da !== db) return da - db;
    const qa = isQualityWorkout(a) ? 0 : 1;
    const qb = isQualityWorkout(b) ? 0 : 1;
    return qa - qb;
  });
}
