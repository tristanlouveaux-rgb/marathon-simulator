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
 *  - Per-discipline floor (`computeTriDisciplineFloorTSS`). The user can
 *    override the recommendation onto any discipline but reductions are
 *    bounded by the floor (suspended in taper or when ramp is hot).
 *
 * Plan-vs-extra rule (per CLAUDE.md "anything in your plan is in your plan"):
 * cross-training is identified by ID membership in `wk.triWorkouts`, not by
 * the `discipline` field. A planned `cross` or `gym` session whose discipline
 * is `undefined` is still part of the plan and should NOT trigger overload.
 */

import type { SimulatorState, Workout, Week } from '@/types/state';
import type { GarminActual } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { computeTriDisciplineFloorTSS } from './tri-discipline-floor';
import { computeDecayedTriCarry } from './tri-cross-training-carry';
import { answeredCrossTrainingTSS, isOpenForTriSuggestion } from './tri-suggestion-handled';
import { isTriQualitySession, triSuggestionTssReduction } from './tri-suggestion-apply';
import { ratedRpeOf, signalBActualTSS, signalBAdhocTSS } from '@/calculations/fitness-model';
import { saturateCredit } from '@/cross-training/universalLoad';
import { isPlannedAdhocId } from '@/workouts/planned-adhoc';

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

const DISCIPLINES: Discipline[] = ['swim', 'bike', 'run'];

/**
 * Cross-training → discipline affinity. Determines which tri discipline a
 * cross-training session most closely substitutes for. Used to anchor the
 * default recommendation on the discipline whose load the cross-training
 * actually displaced.
 *
 * Default = 'run'. Most cross-training (tennis, padel, gym, hiking, soccer,
 * basketball, walking) is leg-impact-loaded and substitutes for running
 * stress more directly than for swim or bike. Bike-affinity and swim-affinity
 * are explicit overrides for sport types that clearly belong elsewhere.
 *
 * Per CLAUDE.md "no made-up numbers": this is a categorical mapping based on
 * obvious biomechanical specificity, not empirically-derived per-discipline
 * transfer coefficients. Future v3 could refine via SPORTS_DB extensions.
 */
type Affinity = Discipline;

const AFFINITY_BIKE_KEYWORDS = ['cycl', 'biking', 'mountainbike', 'mtb', 'spin', 'zwift'];
const AFFINITY_SWIM_KEYWORDS = ['swim', 'aquatic', 'pool'];

function classifyAffinity(rawType?: string | null, name?: string | null): Affinity {
  const blob = `${rawType ?? ''} ${name ?? ''}`.toLowerCase().replace(/[_\s-]/g, '');
  if (AFFINITY_BIKE_KEYWORDS.some(k => blob.includes(k))) return 'bike';
  if (AFFINITY_SWIM_KEYWORDS.some(k => blob.includes(k))) return 'swim';
  return 'run';
}

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
  /** Planned TSS accepting this adjustment takes off the week: the apply
   *  step's own re-pricing (triSuggestionTssReduction), never clipped. */
  tssReduction: number;
}

/** Per-discipline option set. The modal flips between three of these. */
export interface DisciplineOption {
  discipline: Discipline;
  /** Sum of (aerobic + anaerobic) over UPCOMING non-skipped workouts. */
  remainingTSS: number;
  /** Floor below which we won't reduce. 0 means no floor (taper or hot ramp). */
  floorTSS: number;
  /** True if applying the Reduce set (reduceMods) in full would push remaining
   *  below floorTSS (with an empty set: remaining already sits below it). */
  belowFloor: boolean;
  /** True if applying the Replace & Reduce set (replaceMods) in full would push
   *  remaining below floorTSS. False when the set is empty. */
  replaceBelowFloor: boolean;
  /** Reduce-only mods (downgrade quality, trim endurance). Their summed cut
   *  stays within the reduction budget; the floor only warns (belowFloor). */
  reduceMods: OverloadAdjustment[];
  /** Replace-and-reduce mods (swap quality with easy + trim others). Same
   *  budget rule as reduceMods. Empty when the set would hold no swap: it then
   *  holds the Reduce set's kind of change, so the modal hides the option. */
  replaceMods: OverloadAdjustment[];
}

export interface CrossTrainingOverloadResult {
  /** Cross-training TSS this week not yet answered in the modal (after dedup,
   *  plus decayed carry, minus Week.triSuggestionsHandled.crossTrainingTSS). */
  crossTrainingTSS: number;
  /** Sum of planned tri-discipline TSS for the week. */
  plannedTriTSS: number;
  /** crossTrainingTSS / plannedTriTSS. */
  overshootPct: number;
  /** 'heavy' = 15–25%; 'extreme' = >25%. (Below 15% the detector returns null.) */
  severity: 'heavy' | 'extreme';
  /** The auto-recommendation: the first discipline in affinity order whose
   *  option holds a change (pickRecommendedDiscipline). */
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

/**
 * How much planned load the overload proposal may take off the week, in TSS,
 * for `unansweredTSS` of cross-training the athlete has not answered yet.
 *
 * Running's replacement-credit curve (saturateCredit, universalLoad.ts):
 * TAU × (1 − e^(−load / TAU)) with TAU 491 TSS (universal-load-constants.ts).
 * Slope 1 at the origin and below 1 everywhere else, so the budget never
 * exceeds the load that unlocked it (Load Currency Law: a credit can't exceed
 * its load; load-currency anchor 4). A small load unlocks almost its own
 * size (50 TSS → 47.5); a very large one saturates toward 491.
 *
 * Before 2026-10-21 this detector kept the pre-ISSUE-263 two-parameter form,
 * 1500 × (1 − e^(−load / 800)): slope 1500 / 800 = 1.875 at the origin, so
 * 50 TSS of cross-training unlocked about 91 TSS of cuts. Running moved off
 * that form in ISSUE-263; triathlon was missed. SCIENCE_LOG §DP.
 *
 * Planning side: it sizes a prescription. Exported for the anchor test.
 */
export function overloadReductionBudget(unansweredTSS: number): number {
  if (!(unansweredTSS > 0)) return 0;
  return saturateCredit(unansweredTSS);
}

export function detectCrossTrainingOverload(
  state: SimulatorState,
  /** Today's day-of-week (0=Mon..6=Sun). Defaulted from `new Date()`; tests pass a fixed value. */
  todayDow: number = (new Date().getDay() + 6) % 7,
): CrossTrainingOverloadResult | null {
  if (state.eventType !== 'triathlon') return null;

  // s.w is 1-based (store.ts default w: 1). weekIdx is the 0-based array index
  // of the week the user is in; the carry and floor helpers take that index.
  const weekIdx = (state.w ?? 1) - 1;
  const wk = (state.wks ?? [])[weekIdx];
  if (!wk?.triWorkouts?.length) return null;

  const plannedTriTSS = wk.triWorkouts.reduce(
    (acc, w) => acc + (w.aerobic ?? 0) + (w.anaerobic ?? 0),
    0,
  );
  if (plannedTriTSS <= 0) return null;

  const summary = computeCrossTrainingTSS(wk);
  // Decayed carry from prior weeks (push-to-next-week mechanism). Adds to
  // this week's cross-training stimulus so a deferred load doesn't disappear
  //. It just spreads out exponentially. Attributed to run-affinity since
  // the carry is sport-agnostic by the time it lands here, and run-anchor is
  // our default recommendation.
  const carriedTSS = computeDecayedTriCarry(state, weekIdx);
  if (carriedTSS > 0) {
    summary.totalTSS += carriedTSS;
    summary.byAffinity.run += carriedTSS;
  }
  if (summary.totalTSS <= 0) return null;

  // Notify-once: cross-training the user already answered this week (Reduce,
  // Replace & Reduce, Keep, Push, or closing the modal) is out of the count.
  // Without this the proposal re-fired on every launch: Keep stored nothing,
  // Push left the load in this week, and after Reduce the re-priced plan made
  // the overshoot RISE. New cross-training later in the week is judged on its
  // own against the same threshold. Pushed load counts once, next week, through
  // the carry. The affinity mix (byAffinity) stays the whole week's.
  const unansweredTSS = summary.totalTSS - answeredCrossTrainingTSS(wk);
  if (unansweredTSS <= 0) return null;

  const overshootPct = unansweredTSS / plannedTriTSS;
  if (overshootPct < OVERLOAD_THRESHOLD) return null;

  const severity: 'heavy' | 'extreme' = overshootPct > EXTREME_THRESHOLD ? 'extreme' : 'heavy';
  const maxMods = severity === 'extreme' ? MAX_MODS_EXTREME : MAX_MODS_HEAVY;

  // Saturation: a single huge cross-training session shouldn't unlock
  // unbounded reductions. Cap the "credit" available per discipline by
  // running's saturation curve (overloadReductionBudget). Each option set's
  // applied cut stays within it (the builders propose only changes whose full
  // cut fits), so accepting a proposal never takes more planned TSS off the
  // week than the unanswered load.
  const reductionCredit = overloadReductionBudget(unansweredTSS);

  const options = {
    swim: buildDisciplineOption(state, wk, weekIdx, 'swim', todayDow, maxMods, reductionCredit),
    bike: buildDisciplineOption(state, wk, weekIdx, 'bike', todayDow, maxMods, reductionCredit),
    run:  buildDisciplineOption(state, wk, weekIdx, 'run',  todayDow, maxMods, reductionCredit),
  };

  // Never a pop-up with nothing to act on (Tristan, 2026-10-21): the
  // recommendation is the first discipline in affinity order with a change.
  // With none (every session done, skipped or already changed, or every change
  // larger than the budget), no pop-up. Nothing is recorded as answered, so the
  // load still counts in the week's load and is judged again with any later
  // cross-training this week.
  const recommendedDiscipline = pickRecommendedDiscipline(summary.byAffinity, options);
  if (!recommendedDiscipline) return null;

  return {
    crossTrainingTSS: Math.round(unansweredTSS),
    plannedTriTSS: Math.round(plannedTriTSS),
    overshootPct,
    severity,
    recommendedDiscipline,
    options,
  };
}

/**
 * Recommendation logic. Anchored to RUN by default.
 *
 * Most cross-training is leg-impact-loaded (tennis, padel, gym, hiking, soccer)
 * and substitutes for running stress more directly than for swim or bike.
 * Running is also the highest-injury-risk discipline in tri training, so the
 * conservative default protects the run.
 *
 * Affinity order: disciplines sorted by the cross-training TSS that resembles
 * each (byAffinity), ties to run, then bike, then swim. Cycling puts bike
 * first, swimming swim, everything else run.
 *
 * The recommendation is the first discipline in that order whose option holds
 * a change (a Reduce set or a Replace & Reduce set). A discipline with planned
 * work but no change that fits (every session done, skipped or already
 * changed, a quality session whose downgrade exceeds the budget) is passed
 * over, so the pop-up never opens on an empty list. Null when no discipline
 * has a change: the caller then emits no pop-up.
 */
function pickRecommendedDiscipline(
  byAffinity: { swim: number; bike: number; run: number },
  options: { swim: DisciplineOption; bike: DisciplineOption; run: DisciplineOption },
): Discipline | null {
  const affinityOrder: Discipline[] = ['run', 'bike', 'swim'];
  affinityOrder.sort((a, b) => byAffinity[b] - byAffinity[a]);
  return affinityOrder.find(d => hasChange(options[d])) ?? null;
}

/** The option holds at least one change the user can accept. */
function hasChange(opt: DisciplineOption): boolean {
  return opt.reduceMods.length > 0 || opt.replaceMods.length > 0;
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-training TSS sum (with dedup, membership filter)
// ───────────────────────────────────────────────────────────────────────────

interface CrossTrainingSummary {
  totalTSS: number;
  /** TSS broken down by which discipline the activity most resembles. */
  byAffinity: { swim: number; bike: number; run: number };
}

function computeCrossTrainingTSS(wk: Week): CrossTrainingSummary {
  // Membership filter: a session is cross-training if its id is NOT in
  // `wk.triWorkouts`. Per "anything in your plan is in your plan". A
  // planned `cross`/`gym` session in triWorkouts is plan, not overload.
  // Planned sessions stored in adhocWorkouts are plan too (isPlannedAdhocId:
  // user-added `adhoc-` sessions and injury capability offers, `holiday-`,
  // `benchmark-`), with any done record under the same id. Signal B
  // (computeWeekRawTSS) skips the planned entries too but counts their done
  // records as load; here a completed planned session is plan, on purpose
  // (the question is load outside the plan). SCIENCE_LOG §DP item 2.
  const planIds = new Set(
    (wk.triWorkouts ?? []).map(w => w.id).filter((id): id is string => !!id),
  );
  const countedIds = new Set<string>();
  let total = 0;
  const byAffinity = { swim: 0, bike: 0, run: 0 };

  const credit = (tss: number, affinity: Affinity) => {
    total += tss;
    byAffinity[affinity] += tss;
  };

  // Pass 1: adhocWorkouts. Manual entries land here exclusively; synced
  // entries land here AND in garminActuals at the same id (we dedupe in pass 2).
  for (const adhoc of wk.adhocWorkouts ?? []) {
    if (adhoc.id && planIds.has(adhoc.id)) continue; // in-plan: skip
    if (isPlannedAdhocId(adhoc.id)) continue;         // planned adhoc session: plan
    if (adhoc.id) countedIds.add(adhoc.id);
    const tss = tssOfAdhoc(wk, adhoc);
    if (tss <= 0) continue;
    // For adhocs we read the workout name (`n`) since manual entries don't
    // carry a Garmin/Strava activityType. Synced ones may have either.
    const affinity = classifyAffinity(adhocActivityType(wk, adhoc.id), adhoc.n);
    credit(tss, affinity);
  }

  // Pass 2: garminActuals. Only count entries we haven't already attributed
  // to an adhoc, and skip entries matched to a tri-plan workout.
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (countedIds.has(workoutId)) continue;
    if (planIds.has(workoutId)) continue;
    if (isPlannedAdhocId(workoutId)) continue; // done record of a planned adhoc session
    // Signal B's per-activity rule in full (signalBActualTSS: rated strength
    // override, else iTRIMP through the personal normalizer, else rated
    // minutes), so an activity record counts what the weekly total counts. The
    // iTRIMP check that used to come first skipped the strength override: a
    // 60-min gym session rated 7 with heart rate counted its small HR-based
    // iTRIMP here and 60 x TL_PER_MIN[7] in Signal B (D9, 2026-10-21).
    const tss = signalBActualTSS(actual, ratedRpeOf(wk.rated?.[workoutId]));
    if (tss <= 0) continue;
    const affinity = classifyAffinity(actual.activityType, actual.displayName);
    credit(tss, affinity);
  }

  return { totalTSS: total, byAffinity };
}

/**
 * One adhoc entry's load, canonical TSS, by Signal B's own per-activity rule,
 * so the detector and the weekly total (computeWeekRawTSS) value every
 * activity alike:
 *   - an activity record under the same id (a synced entry's twin, or a
 *     GPS-recorded run's record) is valued first, with signalBActualTSS and
 *     its rating, exactly as computeWeekRawTSS values it (it skips the adhoc
 *     half when the record exists);
 *   - otherwise the entry itself, with signalBAdhocTSS (its iTRIMP through the
 *     personal normalizer, else its minutes at its RPE).
 * This pass used to read the entry's own iTRIMP, then its stamped aerobic +
 * anaerobic, before the record. So a rated strength session with heart rate
 * counted its HR iTRIMP (about 20) here and the strength override (107) in
 * Signal B; an HR-less session re-rated after ingest kept its ingest RPE; a
 * Strava-upgraded twin kept the Garmin load (the upgrade refreshes the record,
 * not the entry's load); and a legacy entry's stamped load differed from its
 * minutes at its RPE (2026-10-22, E3; SCIENCE_LOG §DP item 3).
 */
function tssOfAdhoc(wk: Week, w: Workout): number {
  const twin: GarminActual | undefined = w.id ? wk.garminActuals?.[w.id] : undefined;
  if (twin) return signalBActualTSS(twin, ratedRpeOf(wk.rated?.[w.id!]));
  return signalBAdhocTSS(w);
}

/** When an adhoc has a twin in garminActuals, read the activityType from there
 *  for affinity classification. It's the canonical raw sport string. */
function adhocActivityType(wk: Week, adhocId: string | undefined): string | null {
  if (!adhocId) return null;
  const twin: GarminActual | undefined = wk.garminActuals?.[adhocId];
  return twin?.activityType ?? null;
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
  const upcoming = (wk.triWorkouts ?? []).filter(
    w => w.discipline === discipline && isUpcoming(w, todayDow),
  );

  // Remaining load counts every upcoming session, including one an earlier
  // suggestion already reduced (it is still on the plan at its new load).
  const remainingTSS = upcoming.reduce(
    (acc, w) => acc + (w.aerobic ?? 0) + (w.anaerobic ?? 0),
    0,
  );

  // Proposals skip sessions already changed: re-proposing a trim or downgrade on
  // a 'reduced' session steps it down again on every launch. The builders below
  // also skip a session the apply step cannot change with the chosen action
  // (canApplyTriSuggestion: a brick, a swap on an off-ladder kind such as
  // bike_vo2_micros / bike_over_under, a downgrade that would raise planned load,
  // sessions without planned minutes), a change that would not lower the stored
  // load (triSuggestionTssReduction 0), and a change whose cut is larger than
  // the budget left, so the budget goes to sessions that can take it.
  const candidates = upcoming.filter(w => isOpenForTriSuggestion(w));

  const floorTSS = computeTriDisciplineFloorTSS(state, discipline, weekIdx);

  const reduceMods = buildReduceMods(candidates, maxMods, reductionCredit);
  // Replace & Reduce is offered only when it replaces something. A set with no
  // swap (no quality session the apply step can swap, or every swap larger
  // than the budget) holds the Reduce set's kind of change and would duplicate
  // Reduce (Tristan, 2026-10-21).
  const replaceSet = buildReplaceMods(candidates, maxMods, reductionCredit);
  const replaceMods = replaceSet.some(m => m.action === 'swap_easy') ? replaceSet : [];

  // One floor flag per set: applying that set in full would drop remaining
  // below the floor. Since D1/D2 Replace & Reduce can be the only set offered
  // (Reduce empty), and its cut can differ from Reduce's either way, so the
  // modal warns on the set it names, not on Reduce alone (2026-10-22).
  // belowFloor keeps its meaning (also true for an empty Reduce set when the
  // discipline already sits below its floor), which dims the chip.
  // We don't block. The modal warns and lets the user override.
  const cutOf = (mods: OverloadAdjustment[]) => mods.reduce((acc, m) => acc + m.tssReduction, 0);
  const belowFloor = floorTSS > 0 && (remainingTSS - cutOf(reduceMods)) < floorTSS;
  const replaceBelowFloor = floorTSS > 0 && replaceMods.length > 0
    && (remainingTSS - cutOf(replaceMods)) < floorTSS;

  return {
    discipline,
    remainingTSS: Math.round(remainingTSS),
    floorTSS: Math.round(floorTSS),
    belowFloor,
    replaceBelowFloor,
    reduceMods,
    replaceMods,
  };
}

/** Upcoming = still on this week's plan: not skipped/replaced/completed, today
 *  or later, has an id. Proposals additionally need isOpenForTriSuggestion. */
function isUpcoming(w: Workout, todayDow: number): boolean {
  if (!w.id) return false;
  const status = w.status as string | undefined;
  if (status === 'skipped' || status === 'replaced' || status === 'completed') return false;
  if (w.dayOfWeek != null && w.dayOfWeek < todayDow) return false;
  return true;
}

/** Quality = isTriQualitySession (tri-suggestion-apply.ts): the type keywords
 *  plus every off-ladder kind canApplyTriSuggestion lands a downgrade for
 *  (OFF_LADDER_DOWNGRADE_RUNG), shared with the readiness row so the classifier
 *  and the gate cannot drift. */
function isQualityWorkout(w: Workout): boolean {
  return isTriQualitySession(w);
}

/**
 * Planned TSS `action` takes off the session, booked against the reduction
 * budget and shown in the modal ("-N TSS"), when that full cut fits the budget
 * left; else 0 and the change is not proposed. The cut is the apply step's own
 * re-pricing (triSuggestionTssReduction: the stored load minus the load the
 * downgrade, swap or trim stamps), so the modal number is the change Apply makes
 * and the plan header then shows. It is 0 when the apply step would not change
 * the session (canApplyTriSuggestion) or would not lower its stored load.
 *
 * Never clipped to the budget left: before 2026-10-21 the last change of a set
 * showed min(estimate, budget), while Apply took the whole change, so the modal
 * understated the cut and the plan could lose more than the unanswered load
 * (Load Currency Law). The swap and trim estimates were also fixed fractions
 * (50%, 15%) of the stored load where Apply re-priced the session. SCIENCE_LOG
 * §DP item 4.
 */
function fittingReduction(w: Workout, action: OverloadAdjustment['action'], budget: number): number {
  const cut = triSuggestionTssReduction(w, action);
  return cut > 0 && cut <= budget ? cut : 0;
}

function adjustmentFor(w: Workout, action: OverloadAdjustment['action'], cut: number): OverloadAdjustment {
  return {
    workoutId: w.id!,
    workoutLabel: w.n || w.t || w.id!,
    discipline: w.discipline as Discipline,
    action,
    tssReduction: Math.round(cut),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Mod builders
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reduce-only: downgrade nearest upcoming quality, trim endurance volume.
 * No workouts are removed from the plan; sessions just get easier or shorter.
 * A session whose change would take more than the budget left is passed over
 * for a later one that fits (fittingReduction), so the set's applied cut stays
 * within the budget.
 *
 * Mods are NOT silently capped by the floor. If the resulting remaining-TSS
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
    const action = isQualityWorkout(w) ? 'downgrade_today' : 'trim_volume';
    const cut = fittingReduction(w, action, budget);
    if (cut <= 0) continue;
    mods.push(adjustmentFor(w, action, cut));
    budget -= cut;
  }

  return mods;
}

/**
 * Replace + reduce: swap the nearest quality session for an easy version of
 * the same discipline, then trim/downgrade subsequent sessions. Mirrors
 * running's `buildReplaceAdjustments` interleave (replace 1, reduce 1, …).
 *
 * The swap goes to the first quality session the apply step can swap whose
 * full cut fits the budget left. A quality session whose swap is too large
 * takes the Reduce path's downgrade instead when that fits, and the swap stays
 * open for a later quality session. Like `buildReduceMods`, the floor only
 * drives the option-level `belowFloor` warning.
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
    const isQuality = isQualityWorkout(w);

    let action: OverloadAdjustment['action'] = isQuality ? 'downgrade_today' : 'trim_volume';
    let cut = 0;
    if (!didReplace && isQuality) {
      cut = fittingReduction(w, 'swap_easy', budget);
      if (cut > 0) { action = 'swap_easy'; didReplace = true; }
    }
    if (cut <= 0) cut = fittingReduction(w, action, budget);
    if (cut <= 0) continue;
    mods.push(adjustmentFor(w, action, cut));
    budget -= cut;
  }

  return mods;
}

/**
 * Sort by day ascending (nearest first), then quality before endurance within
 * the same day. Mirrors how a coach would walk the week. Touch tomorrow's
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
