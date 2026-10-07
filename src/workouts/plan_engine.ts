import type { RaceDistance, RunnerType, TrainingPhase, AbilityBand } from '@/types';
import type { SimulatorState } from '@/types/state';
import type { SessionIntent, SlotType } from './intent_to_workout';
import { RUN_PACE_FACTOR_VS_EASY } from './intent_to_workout';
import { weekVolumeBudgetKm, ARCHETYPE_PARAMS, type Archetype } from '@/calculations/athlete-archetype';
import { computePlanPhases, computeRunningPlanPhases, isSharpeningBlock, taperFraction } from './phases';
import { planTrainingWeeks } from './race-week-layout';

export interface PlanContext {
  runsPerWeek: number;
  raceDistance: RaceDistance;
  runnerType: RunnerType;
  phase: TrainingPhase;
  fitnessLevel: string;
  weekIndex: number;   // 1-based
  totalWeeks: number;
  vdot: number;
  effortScore?: number;  // Trailing effort score from recent weeks (used for adaptive scaling)
  acwrStatus?: 'safe' | 'caution' | 'high' | 'unknown'; // ACWR injury risk. Reduces quality sessions when elevated
  /** CTL adherence ratio for the just-completed week: actual chronic load ÷ plan-expected
   *  chronic load (see fitness-model.ctlAdherenceRatio). < 1 means the athlete fell behind the
   *  plan's load; the prescription is re-anchored DOWN in proportion (reduce-only). Omit on the
   *  vanilla/standard plan. Suppressed by the caller on deload weeks and after multi-week detraining. */
  ctlRatio?: number;
  forceDeload?: boolean; // Holiday week. Treated as deload regardless of cycle position
  /** Peak weekly hours target from onboarding. Easy and long sessions are scaled to fit;
   *  quality sessions (threshold / VO2 / marathon-pace) are never shortened below their
   *  minimum effective duration. */
  weeklyHoursTarget?: number;
  /** Slot types the user opted out of on the workout-preview step. Filtered from
   *  the quality priority list before slot allocation. */
  excludedSlots?: string[];
  /** Current baseline weekly running km (s.detectedWeeklyKm). When present together
   *  with `archetype`, week-1 volume is anchored to baseline and ramps toward
   *  ability-driven peak per the archetype-specific slope. Omit to keep legacy
   *  ability-driven behaviour (consistent runner at race-target volume). */
  baselineKm?: number;
  /** Athlete archetype (s.athleteArchetype.archetype). Gates the ramp slope —
   *  detrained-with-history ramps faster than cross-trained-no-impact. Required
   *  alongside `baselineKm` for the ramp to fire. */
  archetype?: Archetype;
  /** Easy pace in seconds per km, used to convert the km budget into a minute
   *  budget. Falls back to 360 s/km (6:00/km) when omitted. Matches
   *  intent_to_workout.minutesToKm. */
  easyPaceSecPerKm?: number;
  /** Phase of every plan week (index i = week i + 1), i.e. `s.wks.map(w => w.ph)`.
   *  The engine replays the weeks before `weekIndex` to read the long runs and
   *  week totals it actually prescribed (the long-run 10% rule and the deload
   *  guards). Used only when its length equals `totalWeeks`; otherwise the
   *  canonical running split stands in (`computeRunningPlanPhases` for a race
   *  plan, `computePlanPhases` in continuous mode). */
  planPhases?: readonly TrainingPhase[];
  /** Continuous (no-race) plan. Its final taper week is a block deload, not a
   *  race week, so it keeps its long run and gets no race-week primer. */
  continuousMode?: boolean;
  /** Sharpening-block start inputs, frozen at plan build (s.sharpenBlock). Read
   *  only when the plan is a sharpening block (isSharpeningBlock on raceDistance
   *  and totalWeeks, not continuous); absent, a block starts from the no-data
   *  anchor. */
  sharpening?: SharpeningInputs;
  /** Live reduce-only long-run cap for the CURRENT week of a sharpening block:
   *  (1 + ramp) x the longest run actually logged in the last 30 days, at least
   *  LONG_SOFT_FLOOR_MIN (generateWeekWorkouts). Never part of the replayed
   *  history. */
  liveLongRunCapMin?: number;
}

/** Where a sharpening block's first long run comes from (s.sharpenBlock.startSource). */
export type SharpenStartSource = 'history-30d' | 'history-no-recent-run' | 'no-data';

/** The sharpening-block inputs that depend on the build date (s.sharpenBlock). */
export interface SharpeningInputs {
  /** Week-1 long run, minutes at easy pace. */
  startLongMin: number;
  startSource: SharpenStartSource;
}

// ---------------------------------------------------------------------------
// Variant rotation arrays (ported from Python)
// ---------------------------------------------------------------------------

export const VO2_VARIANTS = [
  { id: 'vo2_5x3', reps: 5, repMin: 3, recMin: 2 },
  { id: 'vo2_6x2', reps: 6, repMin: 2, recMin: 2 },
  { id: 'vo2_5x4', reps: 5, repMin: 4, recMin: 2.5 },
  { id: 'vo2_12x1', reps: 12, repMin: 1, recMin: 1 },
];

export const THRESH_VARIANTS = [
  { id: 'thr_20cont', workMin: 20 },                                    // continuous
  { id: 'thr_3x8', reps: 3, repMin: 8, recMin: 2 },
  { id: 'thr_2x12', reps: 2, repMin: 12, recMin: 3 },
  { id: 'thr_cruise_5x5', reps: 5, repMin: 5, recMin: 1 },
];

// Race-week primers (final taper week only). Short reps at session intensity keep
// the neuromuscular system primed while adding negligible residual fatigue — the
// taper preserves fitness and sheds fatigue rather than building (Mujika & Padilla
// 2003; Bosquet et al. 2007 meta-analysis: maintain intensity, cut volume). A full
// build-phase block (3×8 = 24 min of threshold) 3 days out is training, not
// sharpening; these replace it with ~4–6 min of quality. See SCIENCE_LOG §race-week.
export const TAPER_PRIMER_THRESHOLD = { id: 'thr_primer', reps: 3, repMin: 2, recMin: 2 } as const;
export const TAPER_PRIMER_VO2 = { id: 'vo2_primer', reps: 4, repMin: 1, recMin: 2 } as const;

// `load` ranks the long-run variant by its ACTUAL rendered intensity (not its
// intended one), so phase-aware selection concentrates the genuinely-heavy long
// run in the peak phase (ISSUE-287). Important caveat: only `long_fast_finish`
// currently renders as a high-load `progressive` session (intent_to_workout.ts:91
// — ~30 TSS over steady, scored RPE 5). `long_with_blocks` was never wired to a
// distinct format and falls through to the plain steady `long` case, so it scores
// identically to `long_steady` today — hence load 0, not the higher rank its name
// implies. (Latent: if the blocks long run is ever implemented, bump its load.)
export const LONG_VARIANTS = [
  { id: 'long_steady', load: 0 },
  { id: 'long_fast_finish', load: 2 },
  { id: 'long_with_blocks', load: 0 },
];

// Float fartlek variants. Hard reps at 10K/HM effort, "float" recovery at ~MP
// Science: moderate-effort recovery trains MCT1/MCT4 lactate transporters (Brooks 2009).
// Sustained blood lactate at 2–3 mmol/L during float segments forces aerobic adaptation
// under mild acidosis. Mimicking the metabolic profile of marathon racing (Coyle 2007).
export const FLOAT_VARIANTS = [
  { id: 'float_6x3_2', reps: 6, repMin: 3, floatMin: 2 },   // 30min main set, classic Hudson format
  { id: 'float_5x4_2', reps: 5, repMin: 4, floatMin: 2 },   // longer reps, sustained clearance
  { id: 'float_8x2_2', reps: 8, repMin: 2, floatMin: 2 },   // shorter/sharper, more transitions
  { id: 'float_4x5_3', reps: 4, repMin: 5, floatMin: 3 },   // Canova-style longer blocks
];

/**
 * Phase-aware variant selection (ISSUE-287).
 *
 * The quality-session variants above carry materially different work loads
 * (e.g. THRESH_VARIANTS' continuous 20 min vs cruise 5×5 = 25 min). The legacy
 * `(weekIndex - 1) % len` rotation scatters those loads across the plan
 * independently of phase, so the heaviest variant can land on a build week and
 * push the LOAD apex into the build phase — ahead of the peak phase, which by
 * periodisation definition should carry the highest load (Bompa & Buzzichelli
 * 2018). This is the variant-noise half of the apex-misplacement bug.
 *
 * Fix: bias variant selection by phase rather than scattering it.
 *   - peak  → rotate among the HIGHEST-work variants (hardest sessions land here)
 *   - base/taper → rotate among the LOWEST-work variants (aerobic emphasis,
 *                  gentler; a taper week wants the steady long run and the
 *                  lightest interval shape, never a fast-finish or 3×8 block)
 *   - build → unchanged `weekIndex` rotation (full variety)
 * Rotation within the biased subset preserves week-to-week variety in multi-week
 * peak/base/taper phases. No load constant is introduced — the variants and their
 * work minutes already exist; this only changes WHICH existing variant a phase draws.
 *
 * `workOf` returns the variant's hard-effort minutes (reps × repMin, or the
 * continuous `workMin`) — the load proxy. Variants are ranked by it.
 */
function pickPhaseVariant<T>(
  variants: readonly T[],
  weekIndex: number,
  phase: TrainingPhase,
  workOf: (v: T) => number,
): T {
  const n = variants.length;
  if (n <= 1 || phase === 'build') {
    return variants[Math.max(0, weekIndex - 1) % n];
  }
  // Stable sort by work load. Peak draws from the top; base and taper from the bottom.
  const ranked = variants
    .map((v, i) => ({ v, i, w: workOf(v) }))
    .sort((a, b) => (a.w - b.w) || (a.i - b.i));
  // Subset size: top/bottom half (≥1) keeps variety without crossing into the
  // middle band, so peak stays strictly heavier than base/taper on average.
  const subsetSize = Math.max(1, Math.floor(n / 2));
  const subset = phase === 'peak'
    ? ranked.slice(n - subsetSize)     // heaviest
    : ranked.slice(0, subsetSize);      // lightest (base, taper)
  return subset[Math.max(0, weekIndex - 1) % subset.length].v;
}

/** Hard-effort minutes for an interval variant (the load proxy used to rank). */
const variantWork = (v: { reps?: number; repMin?: number; workMin?: number }): number =>
  v.reps != null && v.repMin != null ? v.reps * v.repMin : (v.workMin ?? 0);

// ---------------------------------------------------------------------------
// Ability band
// ---------------------------------------------------------------------------

export function abilityBandFromVdot(vdot: number, experience: string): AbilityBand {
  // VDOT-based band
  let vdotBand: AbilityBand;
  if (vdot < 30) vdotBand = 'beginner';
  else if (vdot < 40) vdotBand = 'novice';
  else if (vdot < 50) vdotBand = 'intermediate';
  else if (vdot < 60) vdotBand = 'advanced';
  else vdotBand = 'elite';

  // Experience can cap upward
  const expCap: Record<string, AbilityBand> = {
    total_beginner: 'beginner',
    beginner: 'novice',
    novice: 'novice',
    intermediate: 'intermediate',
    returning: 'intermediate',
    hybrid: 'intermediate',
    advanced: 'advanced',
    competitive: 'elite',
  };

  const cap = expCap[experience] || 'intermediate';
  const order: AbilityBand[] = ['beginner', 'novice', 'intermediate', 'advanced', 'elite'];
  const vIdx = order.indexOf(vdotBand);
  const cIdx = order.indexOf(cap);
  return order[Math.min(vIdx, cIdx)];
}

// ---------------------------------------------------------------------------
// Deload
// ---------------------------------------------------------------------------

export function isDeloadWeek(weekIndex: number, ability: AbilityBand): boolean {
  // No deload on week 1
  if (weekIndex <= 1) return false;
  const cycle =
    ability === 'beginner' || ability === 'novice' ? 3 :
    ability === 'intermediate' ? 4 :
    ability === 'advanced' ? 5 : 6;
  return weekIndex % cycle === 0;
}

export function deloadMultiplier(ability: AbilityBand): number {
  switch (ability) {
    case 'beginner': return 0.80;
    case 'novice': return 0.80;
    case 'intermediate': return 0.85;
    case 'advanced': return 0.87;
    case 'elite': return 0.90;
  }
}

/**
 * Deload rule shared by the triathlon and HYROX engines (plan_engine.triathlon.ts,
 * plan_engine.hyrox.ts): every 4th plan week in base/build/peak. A taper week is
 * never a deload, because the taper is already its own volume reduction. Running
 * uses the ability-banded `isDeloadWeek` above instead. Lives here (a light module)
 * so the weekly load target (`planned-week-target.ts`) can read the same rule the
 * engines generate with, without importing the engines.
 */
export function isFourWeekCycleDeloadWeek(weekIndex: number, phase: TrainingPhase): boolean {
  if (phase === 'taper') return false;
  return weekIndex % 4 === 0;
}

/**
 * Race week = the final week of a race plan, whatever its phase label. It
 * carries the race, so the plan seats a short primer instead of a full quality
 * session (SCIENCE_LOG §CE) and no long run: the race is the week's long effort.
 * Not gated on phase === 'taper': computeSingleArc labels a 1-week plan [build]
 * and a 2-week plan [build, peak], and the triathlon wizard builds plans that
 * short when the race is 1 or 2 weeks out. A continuous (no-race) plan's final
 * week is a block deload, never a race week. Single source for the running and
 * triathlon engines, the generator's ACWR ease-back exemption and the
 * week-debrief preview.
 */
export function isRaceWeek(weekIndex: number, totalWeeks: number, continuousMode?: boolean): boolean {
  return !continuousMode && totalWeeks > 0 && weekIndex === totalWeeks;
}

// ---------------------------------------------------------------------------
// Effort multiplier (within-band adaptive scaling)
// ---------------------------------------------------------------------------

export function effortMultiplier(score: number): number {
  return Math.max(0.85, Math.min(1.15, 1 - score * 0.05));
}

/**
 * CTL-gap re-anchor multiplier — reduce-only.
 *
 * `ctlRatio` is actualCTL ÷ expectedCTL for the just-completed week (see
 * fitness-model.ctlAdherenceRatio). The next week's prescribed volume scales in DIRECT
 * proportion to the chronic load the athlete actually carries versus what the plan assumed.
 * This is the foundational ACWR / ramp-rate principle: progress load relative to your CURRENT
 * chronic load, not an aspirational one (Gabbett 2016). When the athlete is on or above plan
 * (ratio ≥ 1) this is a no-op — increasing the prescription off the back of under-training is
 * the effort multiplier's job (for the sessions actually done) and ACWR's job (when acute load
 * spikes), never this lever's. The combined floor is applied at the application site.
 */
export function ctlGapMultiplier(ctlRatio: number): number {
  if (!Number.isFinite(ctlRatio) || ctlRatio >= 1) return 1.0;
  return Math.max(0, ctlRatio);
}

// ---------------------------------------------------------------------------
// Quality cap
// ---------------------------------------------------------------------------

export function qualityCap(ability: AbilityBand, experience: string, runsPerWeek: number): number {
  let base: number;
  switch (ability) {
    case 'beginner': base = 1; break;
    case 'novice': base = 1; break;
    case 'intermediate': base = 2; break;
    case 'advanced': base = 2; break;
    case 'elite': base = 3; break;
  }
  // Can't have more quality than runs - 1 (need at least one easy)
  return Math.min(base, Math.max(0, runsPerWeek - 1));
}

// ---------------------------------------------------------------------------
// Time-based session budgets
// ---------------------------------------------------------------------------

/**
 * Peak long-run minute ceiling per ability and race distance.
 *
 * Non-marathon distances keep the general ability caps (half tops at 120 min,
 * close to the half readiness target). The MARATHON ceilings are raised so the
 * plan actually builds the long run to the marathon-readiness threshold the
 * app's own predictor uses (`LONG_RUN_THRESHOLD_SEC.marathon` = 165 min ≈ 30 km,
 * Daniels' minimum for time-goal marathoners). Previously every distance shared
 * the general table, so an intermediate marathoner's long run topped out at
 * 120 min ≈ 18-24 km — short of the 30 km the same codebase calls "ready", and
 * well below the 32 km peak long run in mainstream marathon plans (Pfitzinger &
 * Douglas 2009; Higdon novice peaks at 20 mi). Grading by ability:
 *   - beginner 150 min (~25 km): Daniels' finish-focused minimum, one notch below
 *     the time-goal threshold to protect the least-durable athletes.
 *   - novice / intermediate 165 min (~30 km): the readiness threshold itself.
 *   - advanced / elite 180 min (~33 km, 3 h): the Pfitzinger upper bound. Long
 *     runs rarely exceed 3 h — beyond it injury/recovery cost outweighs the
 *     aerobic return.
 * The values deliberately match `LONG_RUN_THRESHOLD_SEC.marathon`; same
 * literature (Karp 2007, Daniels 2014, Pfitzinger 2009). Kept as a local table
 * (not imported from the prediction module) to preserve the tracking/planning
 * separation — this is a planning decision that happens to share the anchor.
 */
function longRunCapMin(ability: AbilityBand, race: RaceDistance): number {
  if (race === 'marathon') {
    const cap: Record<AbilityBand, number> = {
      beginner: 150, novice: 165, intermediate: 165, advanced: 180, elite: 180,
    };
    return cap[ability];
  }
  const cap: Record<AbilityBand, number> = {
    beginner: 90, novice: 100, intermediate: 120, advanced: 150, elite: 180,
  };
  return cap[ability];
}

/**
 * Long-run progression ceiling. A long run may be at most 10% longer than the
 * longest long run the plan prescribed in the previous 4 weeks (~30 days).
 *
 * Source: Frandsen et al. 2025, Br J Sports Med, "How much running is too much?"
 * In a large prospective running cohort, single sessions that exceeded the
 * longest run of the preceding 30 days by more than 10% were associated with a
 * higher rate of running-related injury. Approved for the plan engine by
 * Tristan on 2026-10-06. The study measured distance; the engine prescribes long
 * runs in minutes at a constant easy pace, so minutes stand in for distance.
 *
 * Planning-side rule (it caps a prescription). It is not a tracking or forecast
 * input.
 */
export const LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST = 0.10;
/** The lookback for the rule above: 4 plan weeks (28 days), the plan-week form
 *  of the study's 30-day window. */
export const LONG_RUN_LOOKBACK_WEEKS = 4;

/** Taper long run as a fraction of the build long run. Pre-existing value (the
 *  taper phase cap longRunMinutes always applied), named so the taper path and
 *  the ramp fallback share it. planWeekSessions applies it to the long run the
 *  plan actually prescribed, not the untrimmed ramp. */
export const TAPER_LONG_RUN_FRACTION = 0.65;

/** Ceiling for this week's long run given the longest recent long run. */
export function longRunCeilingMin(recentLongestMin: number): number {
  return Math.floor(recentLongestMin * (1 + LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST));
}

/**
 * Position (0 to 1) on the long-run ramp for `weekIndex`.
 *
 * The ramp reaches full progress at 75% of the plan (existing anchor). Scheduled
 * deload weeks do NOT advance it: a deload week holds the previous week's ramp
 * position (then takes the deload multiplier), and the week after it resumes
 * one step above the pre-deload week. Indexing by raw weekIndex instead put the
 * week after a deload two ramp steps above the last full long run. The span is
 * shortened by the same deload count so full progress still lands at 75% of the
 * plan, keeping the peak long run of SCIENCE_LOG §BW. No new constant: the
 * deload cycle is `isDeloadWeek`.
 */
function longRunRampProgress(weekIndex: number, totalWeeks: number, ability: AbilityBand): number {
  const deloadsThrough = (w: number): number => {
    let n = 0;
    for (let j = 2; j <= Math.floor(w); j++) if (isDeloadWeek(j, ability)) n++;
    return n;
  };
  const fullAt = totalWeeks * 0.75;
  const span = fullAt - deloadsThrough(fullAt);
  if (!(span > 0)) return 1;
  const position = weekIndex - deloadsThrough(weekIndex);
  return Math.min(1, Math.max(0, position / span));
}

export function longRunMinutes(
  weekIndex: number, totalWeeks: number, ability: AbilityBand,
  race: RaceDistance, phase: TrainingPhase
): number {
  // Base long run by race
  const baseLong: Record<RaceDistance, number> = {
    '5k': 50, '10k': 60, half: 80, marathon: 90,
  };
  // Progressive ramp across the plan (1.0 by totalWeeks * 0.75), held through
  // scheduled deload weeks (longRunRampProgress).
  const progress = longRunRampProgress(weekIndex, totalWeeks, ability);

  let base: number;
  if (race === 'marathon') {
    // The marathon long run BUILDS from a conservative week-1 anchor (90 min) to
    // the ability readiness ceiling (150/165/180 — see longRunCapMin). Ramping
    // toward that ceiling, rather than the narrow 80%->100% band the shorter
    // distances use, is what makes the plan marathon-specific: an intermediate
    // reaches ~30 km (165 min) by the peak, not ~24 km. Linear progression is
    // standard periodisation; the endpoints are the sourced anchors.
    const startMin = baseLong.marathon;             // 90 min week-1 long run (existing anchor)
    const peakTarget = longRunCapMin(ability, race);
    base = startMin + Math.max(0, peakTarget - startMin) * progress;
  } else {
    // Shorter distances: ramp from 80% to 100% of the distance base.
    base = baseLong[race] * (0.80 + 0.20 * progress);
  }

  // Phase caps. (planWeekSessions scales a taper long run from the long run it
  // actually prescribed; this ramp value is the fallback with no history.)
  if (phase === 'taper') base *= TAPER_LONG_RUN_FRACTION;
  else if (phase === 'peak') base *= 1.05;

  // Ability + distance ceiling
  return Math.round(Math.min(base, longRunCapMin(ability, race)));
}

export function easyRunMinutes(ability: AbilityBand, race: RaceDistance, phase: TrainingPhase): number {
  const base: Record<AbilityBand, number> = {
    beginner: 30, novice: 35, intermediate: 40, advanced: 45, elite: 50,
  };
  let mins = base[ability];
  // Race multiplier
  if (race === 'marathon') mins *= 1.15;
  else if (race === 'half') mins *= 1.05;
  // Phase
  if (phase === 'taper') mins *= 0.70;
  return Math.round(mins);
}

export function thresholdWorkMinutes(
  ability: AbilityBand, phase: TrainingPhase,
  weekIndex: number, totalWeeks: number
): number {
  const base: Record<AbilityBand, number> = {
    beginner: 12, novice: 15, intermediate: 20, advanced: 25, elite: 30,
  };
  let mins = base[ability];

  // Progressive
  const progress = Math.min(1, weekIndex / (totalWeeks * 0.8));
  mins = mins * (0.75 + 0.25 * progress);

  // Phase
  if (phase === 'base') mins *= 0.85;
  else if (phase === 'build') mins *= 1.0;
  else if (phase === 'peak') mins *= 1.05;
  else if (phase === 'taper') mins *= 0.60;

  return Math.round(mins);
}

export function vo2WorkMinutes(ability: AbilityBand, phase: TrainingPhase): number {
  const base: Record<AbilityBand, number> = {
    beginner: 8, novice: 10, intermediate: 14, advanced: 18, elite: 22,
  };
  let mins = base[ability];
  if (phase === 'base') mins *= 0.6;
  else if (phase === 'build') mins *= 0.9;
  else if (phase === 'peak') mins *= 1.1;
  else if (phase === 'taper') mins *= 0.5;
  return Math.round(mins);
}

export function mpWorkMinutes(
  race: RaceDistance, ability: AbilityBand, phase: TrainingPhase
): number {
  // Marathon pace only for marathon (and optionally half)
  if (race !== 'marathon' && race !== 'half') return 0;
  if (phase === 'base' || phase === 'taper') return 0;

  const base: Record<AbilityBand, number> = {
    beginner: 15, novice: 20, intermediate: 30, advanced: 40, elite: 50,
  };
  let mins = base[ability];
  if (race === 'half') mins *= 0.6;
  if (phase === 'build') mins *= 0.85;
  // peak: 1.0
  return Math.round(mins);
}

/**
 * Float fartlek work minutes (hard rep time only, not counting float recovery).
 * Only for half/marathon, build/peak phases, intermediate+ ability.
 * Replaces one quality slot per week when conditions are met.
 */
export function floatWorkMinutes(
  race: RaceDistance, ability: AbilityBand, phase: TrainingPhase
): number {
  // Float only for half/marathon. Shorter races don't benefit (race effort is above LT)
  if (race !== 'marathon' && race !== 'half') return 0;
  // Build and peak only. Base is aerobic development, taper clears fatigue
  if (phase !== 'build' && phase !== 'peak') return 0;
  // Intermediate+ only. Requires pacing discipline to hold float (not jog, not tempo)
  const eligible: AbilityBand[] = ['intermediate', 'advanced', 'elite'];
  if (!eligible.includes(ability)) return 0;

  const base: Record<AbilityBand, number> = {
    beginner: 0, novice: 0, intermediate: 18, advanced: 22, elite: 26,
  };
  let mins = base[ability];
  if (race === 'half') mins *= 0.8;
  if (phase === 'build') mins *= 0.90;
  // peak: 1.0
  return Math.round(mins);
}

// ---------------------------------------------------------------------------
// Workout priority by race + phase (ported from Python)
// ---------------------------------------------------------------------------

function workoutPriority(race: RaceDistance, phase: TrainingPhase): SlotType[] {
  if (race === 'marathon') {
    if (phase === 'base') return ['threshold', 'vo2', 'marathon_pace'];
    if (phase === 'build') return ['marathon_pace', 'float', 'threshold', 'vo2'];
    if (phase === 'peak') return ['marathon_pace', 'float', 'vo2', 'threshold'];
    return ['threshold']; // taper
  }
  if (race === 'half') {
    if (phase === 'base') return ['threshold', 'vo2'];
    if (phase === 'build') return ['threshold', 'float', 'vo2', 'marathon_pace'];
    if (phase === 'peak') return ['vo2', 'float', 'threshold'];
    return ['threshold'];
  }
  if (race === '10k') {
    if (phase === 'base') return ['threshold', 'vo2'];
    if (phase === 'build') return ['vo2', 'threshold'];
    if (phase === 'peak') return ['vo2', 'threshold'];
    return ['threshold'];
  }
  // 5k
  if (phase === 'base') return ['threshold', 'vo2'];
  if (phase === 'build') return ['vo2', 'threshold'];
  if (phase === 'peak') return ['vo2', 'threshold'];
  return ['vo2'];
}

function applyRunnerTypeBias(priority: SlotType[], runnerType: RunnerType): SlotType[] {
  if (runnerType === 'Balanced') return priority;
  // Speed runners: promote endurance work (threshold up)
  // Endurance runners: promote speed work (vo2 up)
  const boost: SlotType = runnerType === 'Speed' ? 'threshold' : 'vo2';
  const idx = priority.indexOf(boost);
  if (idx > 0) {
    const arr = [...priority];
    arr.splice(idx, 1);
    arr.unshift(boost);
    return arr;
  }
  return priority;
}

/**
 * The two live volume levers combined: effort (effortMultiplier) and the CTL-gap
 * re-anchor (ctlGapMultiplier, suppressed on deload weeks), clamped to the
 * effort band (no lower than the ability deload, no higher than +15%) when both
 * apply. Shared by the full-plan week, the sharpening block (which uses it
 * reduce-only) and the taper makeup room.
 */
function adaptiveVolumeMultiplier(ctx: PlanContext, ability: AbilityBand, deload: boolean): number {
  const eMult = ctx.effortScore != null ? effortMultiplier(ctx.effortScore) : 1.0;
  const cMult = (!deload && ctx.ctlRatio != null) ? ctlGapMultiplier(ctx.ctlRatio) : 1.0;
  return cMult === 1.0 ? eMult : Math.max(deloadMultiplier(ability), Math.min(1.15, eMult * cMult));
}

// ---------------------------------------------------------------------------
// Session-duration floors (single source for the budget logic and the
// volume-aware quality cap). An easy run below EASY_FLOOR_MIN is not worth
// prescribing; the long run keeps a two-tier floor.
// ---------------------------------------------------------------------------
export const EASY_FLOOR_MIN = 25;
const LONG_STD_FLOOR_MIN = 40;
export const LONG_SOFT_FLOOR_MIN = 30;

/**
 * The effective weekly minute budget = the tighter of the archetype ramp
 * budget (km anchored to the athlete's current volume) and the user's weekly
 * hours target. `Infinity` when neither is set (legacy generous behaviour).
 * Single source so the quality cap and `applyHoursBudget` agree.
 */
function effectiveWeeklyBudgetMin(ctx: PlanContext): number {
  const hoursCapMin = (ctx.weeklyHoursTarget != null && ctx.weeklyHoursTarget > 0)
    ? ctx.weeklyHoursTarget * 60
    : Infinity;

  if (ctx.baselineKm != null && ctx.archetype != null && ctx.baselineKm > 0) {
    const easyPaceSecPerKm = ctx.easyPaceSecPerKm ?? 360;
    const peakKm = computePeakWeeklyKm(ctx);
    const weekKm = weekVolumeBudgetKm(ctx.weekIndex, ctx.baselineKm, peakKm, ctx.archetype);
    const rampBudgetMin = Math.round((weekKm * easyPaceSecPerKm) / 60);
    if (!Number.isFinite(hoursCapMin)) return rampBudgetMin;

    // RC2 — periodise WITHIN the hours cap. Previously the budget was
    // `min(rampBudgetMin, hoursCap)` per week, which pinned every week to the same
    // flat value whenever the hours target bound, so a capped plan stopped
    // periodising. Fix: cap the DESTINATION (the peak), then ramp toward the capped
    // peak using the SAME geometric ramp fraction the uncapped budget uses. No new
    // constants. When baseline >= peak (established runner) the fraction is 1 every
    // week, so this is flat at the capped peak — which is correct: an athlete
    // already at peak volume periodises via intensity, not a volume ramp.
    const peakBudgetMin = Math.round((peakKm * easyPaceSecPerKm) / 60);
    const rampFraction = peakBudgetMin > 0 ? rampBudgetMin / peakBudgetMin : 1;
    const cappedPeakMin = Math.min(peakBudgetMin, hoursCapMin);
    return Math.round(cappedPeakMin * rampFraction);
  }

  // No archetype/baseline ramp info: flat hours cap (legacy) or no budget at all.
  return hoursCapMin;
}

// ---------------------------------------------------------------------------
// Main entry: planWeekSessions
// ---------------------------------------------------------------------------

/** Slots that count as quality sessions (never trimmed by the budget). */
const QUALITY_SLOT_SET: ReadonlySet<string> = new Set(['threshold', 'vo2', 'marathon_pace', 'float']);

/**
 * What the plan prescribed for one week, as the cross-week rules read it: the
 * long run, the week's total minutes and its quality-session count.
 */
interface PrescribedWeek {
  longMin: number | null;
  totalMin: number;
  qualityCount: number;
  /** Duration of every running session of the week (minutes). */
  runMins: number[];
  /** Longest easy run of the week (minutes), null when none. */
  easyMin: number | null;
}

function summariseWeek(intents: SessionIntent[]): PrescribedWeek {
  const easy = intents.filter(i => i.slot === 'easy').map(i => i.totalMinutes);
  return {
    longMin: intents.find(i => i.slot === 'long')?.totalMinutes ?? null,
    totalMin: intents.reduce((s, i) => s + i.totalMinutes, 0),
    qualityCount: intents.filter(i => QUALITY_SLOT_SET.has(i.slot)).length,
    runMins: intents.map(i => i.totalMinutes),
    easyMin: easy.length ? Math.max(...easy) : null,
  };
}

/** Phase of each plan week: the caller's list when it covers the whole plan,
 *  otherwise the canonical running split (race plans: computeRunningPlanPhases,
 *  the split initializeWeeks builds a running race plan with). */
function resolvePlanPhases(ctx: PlanContext): TrainingPhase[] {
  const given = ctx.planPhases;
  if (given && given.length === ctx.totalWeeks && given.every(p => typeof p === 'string')) {
    return [...given];
  }
  const split = ctx.continuousMode
    ? computePlanPhases(ctx.totalWeeks)
    : computeRunningPlanPhases(ctx.totalWeeks, ctx.raceDistance);
  return split.map(p => p.ph);
}

// Replayed nominal weeks, keyed by every input that shapes a nominal week. The
// value is the prefix computed so far (weeks 1..n); it only ever grows, and the
// same inputs always give the same weeks, so entries never go stale.
const NOMINAL_PLAN_CACHE_MAX = 32;
const nominalPlanCache = new Map<string, PrescribedWeek[]>();

/**
 * The weeks the plan prescribed before `ctx.weekIndex`, replayed with the
 * static plan inputs only (no effort score, ACWR status, CTL ratio or holiday
 * deload: those adjust one week as it is generated and are not known for past
 * weeks here). Each replayed week applies the same cross-week rules from its own
 * replayed history, so week k reads exactly the long runs weeks k-4..k-1 were
 * given, budget trims included.
 */
function nominalHistory(ctx: PlanContext): PrescribedWeek[] {
  const upto = Math.max(0, ctx.weekIndex - 1);
  if (upto === 0 || ctx.totalWeeks <= 0) return [];
  const phases = resolvePlanPhases(ctx);
  const key = JSON.stringify([
    ctx.runsPerWeek, ctx.raceDistance, ctx.runnerType, ctx.fitnessLevel, ctx.totalWeeks, ctx.vdot,
    ctx.weeklyHoursTarget ?? null, [...(ctx.excludedSlots ?? [])].sort(), ctx.baselineKm ?? null,
    ctx.archetype ?? null, ctx.easyPaceSecPerKm ?? null, !!ctx.continuousMode, phases,
    ctx.sharpening ? [ctx.sharpening.startLongMin, ctx.sharpening.startSource] : null,
  ]);
  let weeks = nominalPlanCache.get(key);
  if (!weeks) {
    weeks = [];
    nominalPlanCache.set(key, weeks);
    if (nominalPlanCache.size > NOMINAL_PLAN_CACHE_MAX) {
      const oldest = nominalPlanCache.keys().next().value;
      if (oldest !== undefined) nominalPlanCache.delete(oldest);
    }
  }
  while (weeks.length < upto) {
    const w = weeks.length + 1;
    const nominalCtx: PlanContext = {
      runsPerWeek: ctx.runsPerWeek,
      raceDistance: ctx.raceDistance,
      runnerType: ctx.runnerType,
      fitnessLevel: ctx.fitnessLevel,
      totalWeeks: ctx.totalWeeks,
      vdot: ctx.vdot,
      weeklyHoursTarget: ctx.weeklyHoursTarget,
      excludedSlots: ctx.excludedSlots,
      baselineKm: ctx.baselineKm,
      archetype: ctx.archetype,
      easyPaceSecPerKm: ctx.easyPaceSecPerKm,
      continuousMode: ctx.continuousMode,
      sharpening: ctx.sharpening,
      planPhases: phases,
      weekIndex: w,
      phase: phases[Math.min(w, phases.length) - 1],
    };
    weeks.push(summariseWeek(buildWeekSessions(nominalCtx, weeks)));
  }
  return weeks.slice(0, upto);
}

/** Longest long run prescribed in the LONG_RUN_LOOKBACK_WEEKS weeks before
 *  `weekIndex`, or null when none of them had one. */
function recentLongestLongRun(history: PrescribedWeek[], weekIndex: number): number | null {
  let best: number | null = null;
  for (let w = Math.max(1, weekIndex - LONG_RUN_LOOKBACK_WEEKS); w < weekIndex; w++) {
    const l = history[w - 1]?.longMin;
    if (l != null && l > 0 && (best == null || l > best)) best = l;
  }
  return best;
}

export function planWeekSessions(ctx: PlanContext): SessionIntent[] {
  return buildWeekSessions(ctx, nominalHistory(ctx));
}

/**
 * Room for carried easy makeups in a taper week of a running race plan (rule 5,
 * race-day-rules.ts fitTaperEasyMakeups; M4 design v4 review, major 1). An easy
 * makeup is carried at the week's taper easy length, and only while the week's
 * running minutes stay at or under f x the reference total, so skipped easy runs
 * can never lift a taper week above the week it tapers from.
 *   - Sharpening block: the reference, f, lever and easy length the block's own
 *     taper week uses (assembleBlockTaperWeek).
 *   - Full plan: reference = the last pre-taper week as prescribed that is not a
 *     deload (the replayed plan, nominalHistory), f = taperFraction at the week's
 *     position in the trailing taper, the live levers reduce-only (a makeup never
 *     refills a week a lever cut); easy length = the week's own longest easy run,
 *     else f x the reference week's longest easy run (at least EASY_FLOOR_MIN).
 *     With no pre-taper week there is no reference: ceiling 0, nothing carried.
 *   - Race week: ceiling 0 (it carries no makeup at all).
 * Null when the week is not in the plan's trailing taper (continuous mode, a
 * build week, or a mid-plan recovery week labelled 'taper'): no bound applies.
 */
export interface TaperMakeupRoom {
  /** Length an easy makeup is carried at, minutes. */
  easyMin: number;
  /** The week's running minutes, makeups included, may not pass this. 0 = none carried. */
  ceilingMin: number;
}

export function taperMakeupRoom(ctx: PlanContext): TaperMakeupRoom | null {
  const n = ctx.totalWeeks;
  const k = ctx.weekIndex;
  if (ctx.continuousMode || !(n > 0) || !(k >= 1) || k > n) return null;
  const raceWeek = isRaceWeek(k, n, false);
  if (!raceWeek && ctx.phase !== 'taper') return null;
  const phases = resolvePlanPhases(ctx);
  let taperWeeks = 0;
  for (let j = n; j >= 1 && (j === n || phases[j - 1] === 'taper'); j--) taperWeeks++;
  const firstTaper = n - taperWeeks + 1;
  if (k < firstTaper) return null;
  if (raceWeek) return { easyMin: 0, ceilingMin: 0 };
  const history = nominalHistory(ctx);

  if (isSharpeningBlock(ctx.raceDistance, n)) {
    const out: { taperRoom?: TaperMakeupRoom } = {};
    buildSharpeningWeek(ctx, history, out);
    return out.taperRoom ?? null;
  }

  const ability = abilityBandFromVdot(ctx.vdot, ctx.fitnessLevel);
  let ref: PrescribedWeek | undefined;
  for (let j = firstTaper - 1; j >= 1 && !ref; j--) if (!isDeloadWeek(j, ability)) ref = history[j - 1];
  if (!ref) ref = history[firstTaper - 2];
  if (!ref) return { easyMin: 0, ceilingMin: 0 };
  const f = taperFraction(Math.min(taperWeeks, k - firstTaper + 1), taperWeeks);
  const deload = !!ctx.forceDeload || isDeloadWeek(k, ability);
  const lever = Math.min(1, adaptiveVolumeMultiplier(ctx, ability, deload));
  const own = summariseWeek(buildWeekSessions(ctx, history)).easyMin;
  const easyMin = own ?? (ref.easyMin != null ? Math.max(EASY_FLOOR_MIN, Math.round(f * ref.easyMin * lever)) : 0);
  return { easyMin, ceilingMin: easyMin > 0 ? Math.round(f * ref.totalMin * lever) : 0 };
}

/** The static plan inputs: everything that shapes the nominal plan, without the
 *  per-week phase/index and the adaptive levers (effort, ACWR, CTL gap, holiday). */
export type PlanShapeInputs = Omit<
  PlanContext,
  'phase' | 'weekIndex' | 'effortScore' | 'acwrStatus' | 'ctlRatio' | 'forceDeload' | 'liveLongRunCapMin'
>;

/**
 * Duration (minutes) of every running session the plan prescribes in each week
 * 1..totalWeeks, from the static inputs: the same replay the 10% rule and the
 * deload guards read (nominalHistory). Index i = week i + 1; the race week has no
 * long run, so its list holds only the primer and easy runs. This is the plan's
 * own prescription, read by the race-day forecast so the forecast assumes the
 * long runs the plan actually builds (race-day-durability raceDayPlanDurability).
 */
export function plannedRunMinutesByWeek(inputs: PlanShapeInputs): number[][] {
  if (!(inputs.totalWeeks > 0)) return [];
  return nominalHistory({ ...inputs, weekIndex: inputs.totalWeeks + 1, phase: 'taper' })
    .map(w => [...w.runMins]);
}

/**
 * Whether one more run a week seats one more quality session in plan week
 * `weekIndex` (the nominal week, no live levers). The ability quality cap
 * (qualityCap) and, in a sharpening block, the week's budget often hold the
 * count, and then the extra run is an easy run (M4 design v4 review, minor 7).
 * The "Add a quality session" buttons read it so they never promise a session
 * the plan will not seat.
 */
export function extraRunAddsQualitySession(inputs: PlanShapeInputs, weekIndex: number): boolean {
  if (!(inputs.totalWeeks > 0) || weekIndex < 1 || weekIndex > inputs.totalWeeks) return false;
  const phases = resolvePlanPhases({ ...inputs, weekIndex, phase: 'build' });
  const phase = phases[weekIndex - 1];
  const quality = (rw: number) => planWeekSessions({ ...inputs, runsPerWeek: rw, weekIndex, phase })
    .filter(i => QUALITY_SLOT_SET.has(i.slot)).length;
  return quality(inputs.runsPerWeek + 1) > quality(inputs.runsPerWeek);
}

/**
 * Weekly running volume the plan builds to (km), the forecast's race-approach
 * volume anchor (ISSUE-297: credit the volume the plan delivers). Tracking-side
 * reader of the plan.
 *  - Full plan: computePeakWeeklyKm, the destination every week ramps toward.
 *  - Sharpening block: it never reaches that destination in 1 to 7 weeks, so it
 *    reads its own highest pre-taper week as prescribed (the replayed plan,
 *    minutes at easy pace, the computePeakWeeklyKm convention); a taper-only
 *    block, the current weekly volume it starts from.
 */
export function plannedPeakWeeklyKm(inputs: PlanShapeInputs): number {
  const easyPace = inputs.easyPaceSecPerKm ?? 360;
  if (inputs.continuousMode || !isSharpeningBlock(inputs.raceDistance, inputs.totalWeeks)) {
    return computePeakWeeklyKm(inputs);
  }
  const phases = resolvePlanPhases({ ...inputs, weekIndex: 1, phase: 'build' });
  const weeks = nominalHistory({ ...inputs, weekIndex: inputs.totalWeeks + 1, phase: 'taper' });
  let peakMin = 0;
  weeks.forEach((w, i) => {
    const raceWeek = i + 1 === inputs.totalWeeks;
    if (!raceWeek && phases[i] !== 'taper' && w.totalMin > peakMin) peakMin = w.totalMin;
  });
  if (peakMin > 0) return (peakMin * 60) / easyPace;
  if (inputs.baselineKm != null && inputs.baselineKm > 0) return inputs.baselineKm;
  return computePeakWeeklyKm(inputs);
}

/**
 * The plan-engine inputs generateWeekWorkouts reads from state rather than from
 * its arguments: the ramp baseline (detected weekly km; in continuous mode the
 * plan's own starting volume s.wkm) and the athlete archetype (in continuous mode
 * the neutral 'unknown'). Lives here so the generator, the week-debrief preview
 * and the race-day forecast read one definition (re-exported by generator.ts).
 */
export function planEngineStateInputs(
  s: Pick<SimulatorState, 'detectedWeeklyKm' | 'continuousMode' | 'wkm' | 'athleteArchetype'>
    & Partial<Pick<SimulatorState, 'sharpenBlock'>>,
): { baselineKm: number | undefined; archetype: Archetype | undefined } {
  // A sharpening block needs a weekly volume too (its budgets ramp from current
  // volume), so it takes the continuous-mode fallback when nothing is synced:
  // the plan's own starting volume s.wkm and the neutral 'unknown' archetype.
  const fallback = !!s.continuousMode || !!s.sharpenBlock;
  const baselineKm = s.detectedWeeklyKm
    ?? (fallback && s.wkm && s.wkm > 0 ? s.wkm : undefined);
  const archetype = s.athleteArchetype?.archetype
    ?? (fallback ? 'unknown' as const : undefined);
  return { baselineKm, archetype };
}

/** State fields the running plan is generated from. */
export type RunningPlanState = Pick<
  SimulatorState,
  'rw' | 'rd' | 'typ' | 'tw' | 'v' | 'pac' | 'wks' | 'onboarding' | 'continuousMode'
  | 'detectedWeeklyKm' | 'wkm' | 'athleteArchetype'
> & Partial<Pick<SimulatorState, 'sharpenBlock'>>;

/** The sharpening-block engine inputs stored on state (s.sharpenBlock), or undefined. */
export function sharpeningInputsFromState(
  s: Partial<Pick<SimulatorState, 'sharpenBlock'>>,
): SharpeningInputs | undefined {
  const b = s.sharpenBlock;
  return b ? { startLongMin: b.startLongMin, startSource: b.startSource } : undefined;
}

/**
 * The static plan inputs for a running plan, read from state exactly as the
 * committed plan reads them: the arguments every generateWeekWorkouts caller
 * passes (s.rw, s.rd, s.typ, s.onboarding experience level, s.pac.e, s.tw, s.v,
 * weekly hours, excluded workouts) with the generator's own fallbacks
 * ('intermediate', VDOT 45), plus planEngineStateInputs, the week phases and
 * continuous mode (generator.ts).
 */
export function runningPlanShapeInputs(s: RunningPlanState): PlanShapeInputs {
  const { baselineKm, archetype } = planEngineStateInputs(s);
  // Training weeks: a closing week (a Monday to Wednesday race's own week) holds
  // only the race and is not part of the plan the engine builds.
  const trainingWeeks = planTrainingWeeks(s);
  return {
    runsPerWeek: s.rw,
    raceDistance: s.rd,
    runnerType: s.typ,
    fitnessLevel: s.onboarding?.experienceLevel || 'intermediate',
    totalWeeks: trainingWeeks,
    vdot: s.v || 45,
    weeklyHoursTarget: s.onboarding?.weeklyTrainingHours,
    excludedSlots: s.onboarding?.runningExcludedWorkouts,
    baselineKm,
    archetype,
    easyPaceSecPerKm: s.pac?.e,
    planPhases: s.wks?.slice(0, trainingWeeks).map(w => w.ph),
    continuousMode: !!s.continuousMode,
    sharpening: sharpeningInputsFromState(s),
  };
}

/**
 * One week's sessions. `history[i]` is what the plan prescribed in week i + 1,
 * for every week before `ctx.weekIndex` (see nominalHistory).
 */
function buildWeekSessions(ctx: PlanContext, history: PrescribedWeek[]): SessionIntent[] {
  if (!ctx.continuousMode && isSharpeningBlock(ctx.raceDistance, ctx.totalWeeks)) {
    return buildSharpeningWeek(ctx, history);
  }
  const {
    runsPerWeek, raceDistance, runnerType, fitnessLevel,
    weekIndex, totalWeeks, vdot, acwrStatus,
  } = ctx;
  const excludedSlots = new Set(ctx.excludedSlots ?? []);
  // Race week = the final week of a race plan (isRaceWeek). Its single quality
  // session is a short primer (a few minutes at intensity), not a build-phase
  // block, regardless of which slot the priority list seats (threshold for most
  // distances, vo2 for 5K), and it has no long run (the race is the week's long
  // effort). It is always sized as a taper week: a 1- or 2-week plan's final week
  // carries a build/peak label (computeSingleArc), and sizing it by that label
  // seated a full marathon-pace session in race week.
  const raceWeek = isRaceWeek(weekIndex, totalWeeks, ctx.continuousMode);
  const phase: TrainingPhase = raceWeek ? 'taper' : ctx.phase;

  const ability = abilityBandFromVdot(vdot, fitnessLevel);
  const deload = ctx.forceDeload || isDeloadWeek(weekIndex, ability);
  // Variant selection phase. A deload week is a recovery week, so it draws the
  // LIGHTEST variants (same subset as a base week) — a steady long run, gentler
  // intervals — rather than a `fast_finish` long run or the hardest interval
  // session that the blind `weekIndex` rotation could otherwise land on it. This
  // both honours the "lighter recovery week in every block" contract and removes
  // the contrast that drove the post-deload load bounce (ISSUE-287): with the
  // deload genuinely light, the following week resumes the ramp instead of
  // spiking above the peak phase. dMult still scales the volume on top.
  const variantPhase: TrainingPhase = deload ? 'base' : phase;
  // CTL-gap re-anchor: reduce volume when the athlete fell behind the plan's load. Suppressed on
  // deload weeks (already a planned reduction — re-anchoring a deload down would double up the same
  // "go easy"). Effort and CTL-gap both scale duration, so THESE TWO adaptive levers have their
  // COMBINED effect clamped to the effort band (no lower than the ability deload, no higher than
  // +15%) — they cannot stack past what either alone may do. When ctlRatio is absent, adaptive ===
  // eMult and dMult is byte-identical to the effort-only path. (adaptiveVolumeMultiplier)
  const adaptive = adaptiveVolumeMultiplier(ctx, ability, !!deload);
  // deload × effort IS allowed to compound (deloadMult × eMult, e.g. 0.85 × 0.85 ≈ 0.72). This is
  // intentional autoregulation, not the stacking the clamp above prevents: a deload week where
  // recent sessions were rated harder than prescribed signals accumulated fatigue, and a deeper
  // recovery week is the correct response (RPE-based autoregulation, Helms 2018). The clamp scopes
  // only the two volume-re-anchor levers (effort + CTL-gap), which CAN measure the same shortfall.
  const dMult = (deload ? deloadMultiplier(ability) : 1.0) * adaptive;

  // What the plan prescribed in the weeks before this one (see nominalHistory).
  const prevWeek = weekIndex >= 2 ? history[weekIndex - 2] : undefined;
  const recentLongest = recentLongestLongRun(history, weekIndex);

  /**
   * This week's long run in minutes, before the budget fit.
   *  - Taper: TAPER_LONG_RUN_FRACTION of the longest long run actually prescribed
   *    in the last 4 weeks (trimmed values included), not of the untrimmed ramp,
   *    which could put a taper long run far above every build long run.
   *  - Otherwise: the ramp (held through deloads), capped at the 10% rule
   *    (longRunCeilingMin) BEFORE the deload/effort multiplier, so a deload long
   *    run is a reduction of the long run the athlete would otherwise have run.
   *  - These history rules never cut a long run below LONG_SOFT_FLOOR_MIN, the
   *    shortest long run the budget fit keeps, unless the ramp value itself is
   *    shorter (a 5K taper long run, as before). Without this a deload or taper
   *    week after floor-bound long runs fell to 16 to 28 min, shorter than its
   *    easy runs.
   *  - The 10% rule is applied last: neither that floor nor an upward effort
   *    multiplier lifts a long run past it.
   */
  const longRunForWeek = (): number => {
    const rampMin = longRunMinutes(weekIndex, totalWeeks, ability, raceDistance, phase);
    let target: number;
    if (phase === 'taper' && recentLongest != null) {
      target = recentLongest * TAPER_LONG_RUN_FRACTION;
    } else {
      target = rampMin;
      if (recentLongest != null) target = Math.min(target, longRunCeilingMin(recentLongest));
    }
    let mins = Math.round(target * dMult);
    mins = Math.max(mins, Math.min(Math.round(rampMin * dMult), LONG_SOFT_FLOOR_MIN));
    return recentLongest != null ? Math.min(mins, longRunCeilingMin(recentLongest)) : mins;
  };

  const intents: SessionIntent[] = [];
  let maxQuality = qualityCap(ability, fitnessLevel, runsPerWeek);

  // The weekly minute budget. A deload week takes the same deload reduction its
  // sessions take (deloadMultiplier), so the budget fit and the quality cap read a
  // reduced budget too. Before, the budget kept ramping through the deload, and a
  // week whose predecessor was budget-bound refilled the higher budget: the deload
  // came out heavier than the week before, sometimes with an extra quality session.
  let weeklyBudgetMin = effectiveWeeklyBudgetMin(ctx) * (deload ? deloadMultiplier(ability) : 1);
  if (deload && prevWeek) {
    // Backstop: a deload week is never heavier than the week before it.
    weeklyBudgetMin = Math.min(weeklyBudgetMin, prevWeek.totalMin);
  }
  weeklyBudgetMin = Number.isFinite(weeklyBudgetMin) ? Math.round(weeklyBudgetMin) : weeklyBudgetMin;

  // Volume-aware quality cap. A quality session only earns its slot if the
  // weekly volume budget can also seat a long run and at least one easy run at
  // their floors. Low-volume weeks (early ramp, deload, taper) therefore carry
  // fewer quality sessions, climbing to the ability cap as volume grows — this
  // keeps the intensity distribution near 80/20 (Seiler 2010) instead of
  // stacking intervals on a small base, and scales correctly with plan length
  // (a short plan ramps volume faster, so the cap lifts sooner). Derived from
  // the existing floors and the threshold-session cost — no new constants.
  // Floored at 1 so a fit athlete keeps one quality session for intensity
  // retention even at the lowest volume (the residual overflow is accepted and
  // surfaced by the plan-view budget banner).
  if (Number.isFinite(weeklyBudgetMin)) {
    const approxQualityMin = thresholdWorkMinutes(ability, phase, weekIndex, totalWeeks) + 20;
    const aerobicReserve = LONG_SOFT_FLOOR_MIN + EASY_FLOOR_MIN;
    const affordable = Math.floor((weeklyBudgetMin - aerobicReserve) / Math.max(1, approxQualityMin));
    maxQuality = Math.max(1, Math.min(maxQuality, affordable));
  }
  // A deload week never carries more quality sessions than the week before it.
  if (deload && prevWeek) maxQuality = Math.min(maxQuality, prevWeek.qualityCount);

  // ACWR-driven quality session reduction — CAUTION only (ISSUE-295).
  // HIGH-ACWR weeks are no longer reduced here by dropping quality slots + freezing the long run.
  // Instead the full standard week is built, then shed by the intensity-first ease-back ladder
  // (computeAcwrEaseBack) as a post-pass — in generator.ts for the committed plan and in the
  // week-debrief preview — so the athlete can choose to keep ramping or ease back, and the cut is
  // sized to exactly the overshoot. Caution keeps the gentle one-quality-session swap (orthogonal
  // to the CTL-gap re-anchor above, which trims DURATION when chronic load fell LOW).
  const acwrNote = acwrStatus === 'caution'
    ? 'ACWR caution — one quality session replaced with easy'
    : '';
  if (acwrStatus === 'caution') maxQuality = Math.max(0, maxQuality - 1);

  // For 1 run/week: single combined session. In a race week the race is that run.
  if (runsPerWeek <= 1) {
    if (raceWeek) return intents;
    const mins = longRunForWeek();
    intents.push({
      dayIndex: 0,
      slot: 'long',
      totalMinutes: mins,
      workMinutes: mins,
      variantId: 'long_steady',
      notes: deload ? 'Deload week' : '',
    });
    return intents;
  }

  // Place long run (last slot) for half/marathon or >= 3 runs
  const needsLong = raceDistance === 'half' || raceDistance === 'marathon' || runsPerWeek >= 3;
  let slotsRemaining = runsPerWeek;

  if (needsLong && raceWeek) {
    // Race week: the race takes the long-run slot. No long run is prescribed, so
    // the long-run day (Sunday in the scheduler) stays free for a Sunday race.
    slotsRemaining--;
  } else if (needsLong) {
    const longMins = longRunForWeek();
    // (ACWR-high long-run freeze removed — the ease-back ladder protects the long run distance
    //  until last resort, then trims it by the computed overshoot. ISSUE-295.)
    const longVar = pickPhaseVariant(LONG_VARIANTS, weekIndex, variantPhase, v => v.load);
    const longNote = acwrNote || (deload ? 'Deload week' : '');
    intents.push({
      dayIndex: runsPerWeek - 1, // last day
      slot: 'long',
      totalMinutes: longMins,
      workMinutes: longMins,
      variantId: longVar.id,
      notes: longNote,
    });
    slotsRemaining--;
  }

  // Quality sessions, then easy runs, then the budget fit. A closure so a deload
  // week can be re-assembled with one quality session fewer (the backstop below).
  const longOnly = intents;              // the long run (or nothing in race week)
  const slotsAfterLong = slotsRemaining;
  const assemble = (qualityLimit: number): SessionIntent[] => {
    const week: SessionIntent[] = longOnly.map(i => ({ ...i }));
    let slots = slotsAfterLong;

    // Fill quality sessions. Filter any slots the user has opted out of
    let qualityFilled = 0;
    const rawPriority = applyRunnerTypeBias(workoutPriority(raceDistance, phase), runnerType);
    // Base-first periodisation: no VO2 intervals in the base phase. The aerobic
    // and musculoskeletal base is built at lower intensity first; VO2 work enters
    // in build/peak (Daniels; Bompa). This makes the base quality session a
    // tempo, which is both gentler on a low-volume base and the right stimulus.
    const priority = rawPriority.filter(s => !excludedSlots.has(s) && !(phase === 'base' && s === 'vo2'));
    let dayIdx = 0;

    for (const slot of priority) {
      if (qualityFilled >= qualityLimit || slots <= 0) break;
      // Reserve at least 1 slot for easy (unless we're the last slot)
      if (slots <= 1 && qualityFilled > 0) break;

      const qualityNote = acwrNote || (deload ? 'Deload week' : '');

      if (slot === 'threshold') {
        // Race week: fixed short primer (not dMult-scaled — it is already minimal).
        const variant = raceWeek
          ? TAPER_PRIMER_THRESHOLD
          : pickPhaseVariant(THRESH_VARIANTS, weekIndex, variantPhase, variantWork);
        const workMins = raceWeek
          ? variant.reps! * variant.repMin!
          : Math.round(thresholdWorkMinutes(ability, phase, weekIndex, totalWeeks) * dMult);
        const totalMins = variant.reps
          ? Math.round(variant.reps * (variant.repMin! + variant.recMin!) + 15) // warmup/cooldown
          : workMins + 20; // continuous: warmup + cooldown
        week.push({
          dayIndex: dayIdx++,
          slot: 'threshold',
          totalMinutes: raceWeek ? totalMins : Math.round(totalMins * dMult),
          workMinutes: workMins,
          reps: variant.reps,
          repMinutes: variant.repMin,
          recoveryMinutes: variant.recMin,
          variantId: variant.id,
          notes: raceWeek ? 'Race-week primer' : qualityNote,
        });
      } else if (slot === 'vo2') {
        // Race week: short sharp primer (5K taper seats vo2 here, not threshold).
        const variant = raceWeek
          ? TAPER_PRIMER_VO2
          : pickPhaseVariant(VO2_VARIANTS, weekIndex, variantPhase, variantWork);
        const workMins = raceWeek
          ? variant.reps * variant.repMin
          : Math.round(vo2WorkMinutes(ability, phase) * dMult);
        const totalMins = Math.round(variant.reps * (variant.repMin + variant.recMin) + 15);
        week.push({
          dayIndex: dayIdx++,
          slot: 'vo2',
          totalMinutes: raceWeek ? totalMins : Math.round(totalMins * dMult),
          workMinutes: workMins,
          reps: variant.reps,
          repMinutes: variant.repMin,
          recoveryMinutes: variant.recMin,
          variantId: variant.id,
          notes: raceWeek ? 'Race-week primer' : qualityNote,
        });
      } else if (slot === 'marathon_pace') {
        const workMins = Math.round(mpWorkMinutes(raceDistance, ability, phase) * dMult);
        if (workMins <= 0) continue; // skip if not applicable
        week.push({
          dayIndex: dayIdx++,
          slot: 'marathon_pace',
          totalMinutes: workMins + 20,
          workMinutes: workMins,
          variantId: 'mp_continuous',
          notes: qualityNote,
        });
      } else if (slot === 'float') {
        const workMins = Math.round(floatWorkMinutes(raceDistance, ability, phase) * dMult);
        if (workMins <= 0) continue; // skip if not eligible (beginner/novice, base/taper, 5K/10K)
        const variant = pickPhaseVariant(FLOAT_VARIANTS, weekIndex, variantPhase, variantWork);
        const totalMins = Math.round(variant.reps * (variant.repMin + variant.floatMin) + 15);
        week.push({
          dayIndex: dayIdx++,
          slot: 'float',
          totalMinutes: Math.round(totalMins * dMult),
          workMinutes: workMins,
          reps: variant.reps,
          repMinutes: variant.repMin,
          recoveryMinutes: variant.floatMin,
          variantId: variant.id,
          notes: qualityNote,
        });
      }

      qualityFilled++;
      slots--;
    }

    // Fill remaining with easy. An easy run is never longer than the week's long
    // run: the long run is by definition the week's longest run. When the 10% rule
    // holds the long run low, the easy runs are held to it instead of outgrowing it.
    const longCapMin = week.find(i => i.slot === 'long')?.totalMinutes;
    while (slots > 0) {
      const naturalEasy = Math.round(easyRunMinutes(ability, raceDistance, phase) * dMult);
      const easyMins = longCapMin != null ? Math.min(naturalEasy, longCapMin) : naturalEasy;
      week.push({
        dayIndex: dayIdx++,
        slot: 'easy',
        totalMinutes: easyMins,
        workMinutes: easyMins,
        variantId: 'easy_steady',
        notes: deload ? 'Deload week' : '',
      });
      slots--;
    }

    // Fit the sessions into the effective weekly budget — the tighter of the
    // archetype ramp budget (km anchored to the athlete's current volume, ramping
    // geometrically toward the ability-driven peak) and the user's weekly hours
    // target. Easy runs are consolidated and the long run trimmed to its floors;
    // quality minutes are preserved (stimulus depends on work-interval duration,
    // Seiler 2010 / Billat 2001). `Infinity` (no ramp, no target) is a no-op.
    if (Number.isFinite(weeklyBudgetMin)) {
      applyHoursBudget(week, weeklyBudgetMin);
    }
    return week;
  };

  let week = assemble(maxQuality);

  // Deload backstop, last resort. When every flexible session is already at its
  // floor, the budget fit cannot pull a deload week under the week before. Seen
  // on tiny budgets where the deload week opens a new phase and its first quality
  // session (marathon pace) is longer than the previous phase's (threshold). The
  // deload week then swaps quality sessions for easy runs one at a time (the
  // ACWR-caution move) until it is no heavier than the week before. Only here does
  // the volume-aware cap's floor of one quality session give way.
  if (deload && prevWeek) {
    const totalOf = (xs: SessionIntent[]) => xs.reduce((s, i) => s + i.totalMinutes, 0);
    const qualityOf = (xs: SessionIntent[]) => xs.filter(i => QUALITY_SLOT_SET.has(i.slot)).length;
    for (let q = qualityOf(week) - 1; q >= 0 && totalOf(week) > prevWeek.totalMin; q--) {
      const candidate = assemble(q);
      if (totalOf(candidate) < totalOf(week)) week = candidate;
    }
  }

  return week;
}

// ---------------------------------------------------------------------------
// Sharpening block: a running marathon under 8 weeks out, or a half under 4
// (isSharpeningBlock, phases.ts; Tristan 2026-10-05). Planning side: every rule
// below prescribes. Design: M4 design v4 as amended by its review (2026-10-06).
//
// The block has no time to ramp toward the full-plan destination, so it builds
// from what the runner does now:
//   - Long run: week 1 is the longest run of the 30 days before build
//     (s.sharpenBlock.startLongMin); each later loaded week grows by at most
//     the archetype weekly ramp (3 to 10%, ARCHETYPE_PARAMS.weeklyRampPct) over
//     the longest long run seated so far, never above 10% (Frandsen et al. 2025,
//     LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST) and never above the ability ceiling.
//   - No session covers more distance than the week's long run (Frandsen
//     measured every single session against the 30-day longest), distance
//     taken as minutes at easy pace (sessionEasyEquivalentMin).
//   - Weekly volume: a loaded week is the lower of the archetype budget for its
//     loaded-week index, (1 + ramp) x the larger of the last loaded week and
//     current volume, and the weekly hours target. With an hours target below
//     what the block would build, the block starts at the target and holds
//     there (RC2's rule for an athlete already at the capped destination,
//     plan_engine effectiveWeeklyBudgetMin; owner decision 2026-10-06).
//   - Deload weeks (build weeks on the ability cycle) take deloadMultiplier of
//     the last loaded week, with no more quality sessions than it had.
//   - Taper weeks: taperFraction (0.70 / 0.55 for a 2-week taper, 0.55 for
//     race week alone) of the last pre-taper loaded week, for the week
//     ceiling, the long run and the easy-run length; one threshold session;
//     race week holds the primer and no long run. Reduce-only: a taper week
//     never adds a session type its reference week lacked.
//   - Live levers (effort, CTL gap) can only reduce a block week. Rows are
//     ceilings set by the ramp and Frandsen caps; a +15% lift would break them.
//     (Running full plans and triathlon keep their two-way lever.)
// ---------------------------------------------------------------------------

/**
 * Distance a running session covers, as minutes at easy pace: work at the
 * session's pace (RUN_PACE_FACTOR_VS_EASY), warm-up, cool-down and jog
 * recoveries at easy pace, float recoveries at marathon pace. A long run is
 * its minutes (the fast-finish variant covers the same distance). Used by the
 * sharpening block's single-session cap.
 */
export function sessionEasyEquivalentMin(i: SessionIntent): number {
  const total = i.totalMinutes;
  if (i.slot === 'easy' || i.slot === 'long') return total;
  const factor = RUN_PACE_FACTOR_VS_EASY[i.slot];
  if (!factor) return total;
  const fast = i.reps != null && i.repMinutes != null ? i.reps * i.repMinutes : i.workMinutes;
  const fastMin = Math.max(0, Math.min(total, fast));
  if (i.slot === 'float' && i.reps != null && i.recoveryMinutes != null) {
    const floatMin = Math.max(0, Math.min(total - fastMin, i.reps * i.recoveryMinutes));
    const rest = Math.max(0, total - fastMin - floatMin);
    return rest + fastMin / factor + floatMin / RUN_PACE_FACTOR_VS_EASY.marathon_pace;
  }
  return (total - fastMin) + fastMin / factor;
}

/** The no-data start of a sharpening block: the existing week-1 long-run anchor
 *  (marathon 90 min, half 80 x 0.80 = 64; longRunMinutes at ramp progress 0). */
export function sharpeningNoDataStartMin(
  raceDistance: RaceDistance, ability: AbilityBand, totalWeeks: number,
): number {
  return longRunMinutes(0, totalWeeks, ability, raceDistance, 'build');
}

/** Clamp a block's week-1 long run to [LONG_SOFT_FLOOR_MIN, ability ceiling]. */
export function clampSharpeningStartMin(min: number, ability: AbilityBand, raceDistance: RaceDistance): number {
  return Math.round(Math.max(LONG_SOFT_FLOOR_MIN, Math.min(longRunCapMin(ability, raceDistance), min)));
}

/** The weekly ramp a sharpening block grows by (archetype, never above 10%). */
export function sharpeningRampPct(archetype: Archetype | undefined): number {
  return Math.min(LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, ARCHETYPE_PARAMS[archetype ?? 'unknown'].weeklyRampPct);
}

interface BlockWeekRow {
  /** Sizing phase for quality work minutes and priority ('base' in a case-b block). */
  sessionPhase: TrainingPhase;
  variantPhase: TrainingPhase;
  /** Long run before the fit (null: no long run this week). */
  longTarget: number | null;
  /** Long run with this week's growth given up (the longest seated so far). */
  longHold: number | null;
  /** Single-session cap when the week has no long run (the last long run prescribed). */
  sessionCapMin: number | null;
  budgetMin: number;
  qualityLimit: number;
  /** Duration scale for quality and natural easy runs (deload multiplier x live lever). */
  sizeMult: number;
  deload: boolean;
  acwrNote: string;
  /** The weekly hours target is the binding budget of this loaded week. */
  hoursBound?: boolean;
  /** The weekly hours target in minutes (absent: none). No week passes it, whichever
   *  ceiling binds, accepted past-floor overflow included. */
  hoursCapMin?: number;
}

/** Build one quality session (same shapes and sizes as the full-plan engine). */
function blockQualityIntent(
  slot: SlotType, ctx: PlanContext, ability: AbilityBand, row: BlockWeekRow,
): SessionIntent | null {
  const { raceDistance, weekIndex, totalWeeks } = ctx;
  const ph = row.sessionPhase;
  const m = row.sizeMult;
  const note = row.acwrNote || (row.deload ? 'Deload week' : '');
  if (slot === 'threshold') {
    const variant = pickPhaseVariant(THRESH_VARIANTS, weekIndex, row.variantPhase, variantWork);
    const workMins = Math.round(thresholdWorkMinutes(ability, ph, weekIndex, totalWeeks) * m);
    const totalMins = variant.reps
      ? Math.round(variant.reps * (variant.repMin! + variant.recMin!) + 15)
      : workMins + 20;
    return {
      dayIndex: 0, slot: 'threshold', totalMinutes: Math.round(totalMins * m), workMinutes: workMins,
      reps: variant.reps, repMinutes: variant.repMin, recoveryMinutes: variant.recMin,
      variantId: variant.id, notes: note,
    };
  }
  if (slot === 'vo2') {
    const variant = pickPhaseVariant(VO2_VARIANTS, weekIndex, row.variantPhase, variantWork);
    const workMins = Math.round(vo2WorkMinutes(ability, ph) * m);
    const totalMins = Math.round(variant.reps * (variant.repMin + variant.recMin) + 15);
    return {
      dayIndex: 0, slot: 'vo2', totalMinutes: Math.round(totalMins * m), workMinutes: workMins,
      reps: variant.reps, repMinutes: variant.repMin, recoveryMinutes: variant.recMin,
      variantId: variant.id, notes: note,
    };
  }
  if (slot === 'marathon_pace') {
    const workMins = Math.round(mpWorkMinutes(raceDistance, ability, ph) * m);
    if (workMins <= 0) return null;
    return { dayIndex: 0, slot: 'marathon_pace', totalMinutes: workMins + 20, workMinutes: workMins, variantId: 'mp_continuous', notes: note };
  }
  if (slot === 'float') {
    const workMins = Math.round(floatWorkMinutes(raceDistance, ability, ph) * m);
    if (workMins <= 0) return null;
    const variant = pickPhaseVariant(FLOAT_VARIANTS, weekIndex, row.variantPhase, variantWork);
    const totalMins = Math.round(variant.reps * (variant.repMin + variant.floatMin) + 15);
    return {
      dayIndex: 0, slot: 'float', totalMinutes: Math.round(totalMins * m), workMinutes: workMins,
      reps: variant.reps, repMinutes: variant.repMin, recoveryMinutes: variant.floatMin,
      variantId: variant.id, notes: note,
    };
  }
  return null;
}

/**
 * Fit a loaded or deload block week to its row (design 4.5):
 *   1. Seat the long run at its row length and quality sessions at their natural
 *      lengths, up to the row's limit; a quality session covering more distance
 *      than the long run is not seated (single-session cap).
 *   2. Easy runs consolidate first (fewest runs at natural length, each at least
 *      EASY_FLOOR_MIN, sized by floor so rounding never overflows).
 *   3. If one EASY_FLOOR_MIN easy run does not fit, the long run gives up this
 *      week's growth (holds at the longest long run already seated), but only
 *      when the held long run keeps every quality session it holds for: a held
 *      long run that lowers the single-session cap below one of them gains
 *      nothing, so the long run keeps its growth.
 *   4. Still no room with more than one quality session: the lowest-priority one
 *      is not seated (its slot joins the easy runs), and the long run gets its
 *      growth back to try again.
 *   5. One quality session left: one easy run at the floor, the long run trimmed
 *      toward the longest long run already seated (LONG_SOFT_FLOOR_MIN when
 *      there is none), residual overflow accepted (the existing past-all-floors
 *      rule) up to the one EASY_FLOOR_MIN easy run the week holds (no overflow
 *      in a 2-run week, which holds none), never past the hours target.
 *      When that trim would unseat the quality session through the
 *      single-session cap, or would leave more overflow than that (the held long
 *      run plus the session alone pass the budget), the long run keeps its
 *      growth and the week holds no quality session instead: the freed slot is
 *      an easy run. The session returns once the budget, growing with the
 *      chain, seats it (review 2026-10-07: holding the long run to seat the
 *      session let loaded weeks jump 50 to 60% past the ramp).
 *   6. Past every floor without a quality session: the long run holds at the
 *      longest long run already seated, residual overflow accepted, unless that
 *      passes the hours target; then it is cut to what the target leaves (never
 *      below LONG_SOFT_FLOOR_MIN), as under a binding target.
 *
 * Binding hours target (owner decision 2026-10-06: start at the target and hold;
 * the long run still grows each week): the long run's growth comes before every
 * quality session. Quality sessions give way first, the lowest priority first,
 * down to none; only when the grown long run and one floor-length easy run alone
 * pass the target is the long run cut to what the target leaves (as close to its
 * row length as the target allows, never below LONG_SOFT_FLOOR_MIN), residual
 * overflow accepted.
 */
function assembleBlockLoadedWeek(
  ctx: PlanContext, ability: AbilityBand, row: BlockWeekRow,
): SessionIntent[] {
  const { runsPerWeek, raceDistance, runnerType } = ctx;
  const excluded = new Set(ctx.excludedSlots ?? []);
  const longNote = row.acwrNote || (row.deload ? 'Deload week' : '');
  const budget = row.budgetMin;
  const hoursCap = row.hoursCapMin ?? Infinity;

  if (runsPerWeek <= 1) {
    if (row.longTarget != null) {
      let mins = Math.round(row.longTarget);
      // A binding hours target: the single run is as long as the target allows.
      // Any set target is a ceiling, whichever budget binds.
      const cap = row.hoursBound ? budget : hoursCap;
      if (Number.isFinite(cap)) mins = Math.max(LONG_SOFT_FLOOR_MIN, Math.min(mins, Math.floor(cap)));
      return [{ dayIndex: 0, slot: 'long', totalMinutes: mins, workMinutes: mins, variantId: 'long_steady', notes: longNote }];
    }
    // No long run this week (a deload long run under LONG_SOFT_FLOOR_MIN): the
    // single run is an easy run sized from the week's own budget (the last loaded
    // week x the deload multiplier), at least EASY_FLOOR_MIN, so the deload stays
    // below the week before. It used to fall back to the last long run.
    const ref = row.sessionCapMin ?? LONG_SOFT_FLOOR_MIN;
    const sized = Number.isFinite(budget) ? Math.round(budget) : ref;
    const mins = Math.max(EASY_FLOOR_MIN, Math.min(ref, sized));
    return [{ dayIndex: 0, slot: 'easy', totalMinutes: mins, workMinutes: mins, variantId: 'easy_steady', notes: row.deload ? 'Deload week' : '' }];
  }

  const priority = applyRunnerTypeBias(workoutPriority(raceDistance, row.sessionPhase), runnerType)
    .filter(sl => !excluded.has(sl) && !(row.sessionPhase === 'base' && sl === 'vo2'));
  const candidates: SessionIntent[] = [];
  for (const sl of priority) {
    const q = blockQualityIntent(sl, ctx, ability, row);
    if (q) candidates.push(q);
  }
  // Without a long run the long slot is an easy run.
  const slotsAfterLong = row.longTarget != null ? runsPerWeek - 1 : runsPerWeek;
  // The existing slot rule: at least one easy run unless a single slot is left.
  const maxQuality = Math.min(row.qualityLimit, slotsAfterLong >= 2 ? slotsAfterLong - 1 : slotsAfterLong);
  const naturalEasy = Math.round(easyRunMinutes(ability, raceDistance, 'build') * row.sizeMult);

  interface Fit { long: number | null; quality: SessionIntent[]; easyCount: number; easyLen: number }
  const capOf = (longMin: number | null) => longMin ?? row.sessionCapMin;
  const underCap = (qs: SessionIntent[], longMin: number | null) => {
    const capRef = capOf(longMin);
    return capRef != null ? qs.filter(q => sessionEasyEquivalentMin(q) <= capRef) : qs;
  };
  /** Steps 1 and 2 for one long run and one set of quality sessions; null when one
   *  floor-length easy run does not fit beside them. */
  const fit = (longMin: number | null, qs: SessionIntent[]): Fit | null => {
    const capRef = capOf(longMin);
    const quality = underCap(qs, longMin);
    const easySlots = slotsAfterLong - quality.length;
    const easyNatural = capRef != null ? Math.min(naturalEasy, Math.max(EASY_FLOOR_MIN, capRef)) : naturalEasy;
    const fixed = (longMin ?? 0) + quality.reduce((a, q) => a + q.totalMinutes, 0);
    if (!Number.isFinite(budget) || fixed + easySlots * easyNatural <= budget) {
      return { long: longMin, quality, easyCount: easySlots, easyLen: easyNatural };
    }
    const easyBudget = budget - fixed;
    if (easySlots === 0) return easyBudget >= 0 ? { long: longMin, quality, easyCount: 0, easyLen: 0 } : null;
    if (easyBudget < EASY_FLOOR_MIN) return null;
    const fewestAtNatural = Math.max(1, Math.ceil(easyBudget / easyNatural));
    const mostAboveFloor = Math.max(1, Math.floor(easyBudget / EASY_FLOOR_MIN));
    const easyCount = Math.min(easySlots, fewestAtNatural, mostAboveFloor);
    const easyLen = Math.min(easyNatural, Math.max(EASY_FLOOR_MIN, Math.floor(easyBudget / easyCount)));
    return { long: longMin, quality, easyCount, easyLen };
  };
  /** Past every floor: one floor-length easy run and the long run cut to the room
   *  left, never below `floorMin`; residual overflow accepted. */
  const pastFloors = (qs: SessionIntent[], floorMin: number): Fit => {
    const easyCount = Math.min(Math.max(0, slotsAfterLong - qs.length), 1);
    let long = row.longTarget;
    if (long != null) {
      const room = budget - qs.reduce((a, q) => a + q.totalMinutes, 0) - easyCount * EASY_FLOOR_MIN;
      long = Math.max(Math.min(long, floorMin), Math.min(long, Math.floor(room)));
    }
    return { long, quality: underCap(qs, long), easyCount, easyLen: EASY_FLOOR_MIN };
  };
  const totalOf = (f: Fit) => (f.long ?? 0) + f.quality.reduce((a, q) => a + q.totalMinutes, 0) + f.easyCount * f.easyLen;

  const target = row.longTarget;
  const hold = row.longHold;
  const seatable = underCap(candidates.slice(0, Math.max(0, maxQuality)), target);
  let chosen: Fit | null = null;

  if (row.hoursBound) {
    for (let nq = seatable.length; nq >= 0 && !chosen; nq--) chosen = fit(target, seatable.slice(0, nq));
    if (!chosen) chosen = pastFloors([], LONG_SOFT_FLOOR_MIN);
  } else {
    for (let nq = seatable.length; nq >= 1 && !chosen; nq--) {
      const set = seatable.slice(0, nq);
      chosen = fit(target, set);
      if (!chosen && target != null && hold != null && target > hold) {
        const held = fit(hold, set);
        if (held && held.quality.length === set.length) chosen = held;
      }
    }
    if (!chosen && seatable.length > 0) {
      // Step 5: the trim keeps one quality session only while the overflow it
      // leaves is at most the floor-length easy run the week holds (none in a
      // 2-run week) and the week stays inside the hours target.
      const last = seatable.slice(0, 1);
      const trimmed = pastFloors(last, hold ?? LONG_SOFT_FLOOR_MIN);
      const overflowOk = totalOf(trimmed) <= Math.min(budget + trimmed.easyCount * EASY_FLOOR_MIN, hoursCap);
      if (trimmed.quality.length === last.length && overflowOk) chosen = trimmed;
    }
    if (!chosen) chosen = fit(target, []);
    if (!chosen) {
      // Step 6.
      const held = pastFloors([], hold ?? LONG_SOFT_FLOOR_MIN);
      chosen = totalOf(held) <= hoursCap ? held : pastFloors([], LONG_SOFT_FLOOR_MIN);
    }
  }

  const { long, quality, easyCount, easyLen } = chosen;
  const week: SessionIntent[] = [];
  let dayIdx = 0;
  if (long != null) {
    const longVar = pickPhaseVariant(LONG_VARIANTS, ctx.weekIndex, row.variantPhase, v => v.load);
    week.push({ dayIndex: runsPerWeek - 1, slot: 'long', totalMinutes: long, workMinutes: long, variantId: longVar.id, notes: longNote });
  }
  for (const q of quality) week.push({ ...q, dayIndex: dayIdx++ });
  for (let i = 0; i < easyCount; i++) {
    week.push({ dayIndex: dayIdx++, slot: 'easy', totalMinutes: easyLen, workMinutes: easyLen, variantId: 'easy_steady', notes: row.deload ? 'Deload week' : '' });
  }
  return week;
}

/**
 * A taper week of a sharpening block (design 4.6). `ref` is the last pre-taper
 * loaded week as prescribed; `f` its taper fraction.
 *   - Long run f x the reference long run; none in race week; none below
 *     LONG_SOFT_FLOOR_MIN (that slot is an easy run).
 *   - Easy runs: each f x the reference easy-run length, at least EASY_FLOOR_MIN,
 *     never longer than the long run (or the last long run prescribed). Because f
 *     falls week to week, easy runs never lengthen through the taper.
 *   - Week ceiling f x the reference total. Runs are kept and shortened (Bosquet
 *     et al. 2007: no benefit from cutting frequency); the easy-run count is the
 *     whole number of runs nearest the easy budget, so a week overshoots its
 *     ceiling by at most half an easy run, or by the long run plus quality
 *     sessions alone when those already pass it. A primer that alone fills the
 *     ceiling leaves no easy run.
 *   - The taper never rises: when rounding the easy-run count up would make the
 *     week longer than the week before it (`prevTotalMin`, race week included),
 *     the count rounds down instead. Makeup room never passes that total either.
 *   - One threshold session (continuous, the existing taper work minutes) in a
 *     taper week, the primer in race week; neither when the reference week held
 *     no quality session. Single-session cap applies.
 */
function assembleBlockTaperWeek(
  ctx: PlanContext, ability: AbilityBand, ref: PrescribedWeek, f: number, raceWeek: boolean,
  lastLongMin: number | null, lever: number, acwrCaution: boolean, prevTotalMin: number | null,
  out?: { taperRoom?: TaperMakeupRoom },
): SessionIntent[] {
  const { runsPerWeek, raceDistance, runnerType, weekIndex, totalWeeks } = ctx;
  const excluded = new Set(ctx.excludedSlots ?? []);
  const ceiling = Math.round(f * ref.totalMin * lever);
  const roomCeiling = prevTotalMin != null ? Math.min(ceiling, prevTotalMin) : ceiling;
  let long: number | null = null;
  if (!raceWeek && ref.longMin != null) {
    const l = Math.round(f * ref.longMin * lever);
    long = l >= LONG_SOFT_FLOOR_MIN ? l : null;
  }
  const capRef = long ?? (lastLongMin != null ? Math.round(lastLongMin) : null);
  // Easy runs: f x the reference easy-run length, held to the long run.
  const refEasy = ref.easyMin ?? easyRunMinutes(ability, raceDistance, 'build');
  let easyLen = Math.max(EASY_FLOOR_MIN, Math.round(f * refEasy * lever));
  if (capRef != null && capRef >= EASY_FLOOR_MIN) easyLen = Math.min(easyLen, capRef);
  // Makeup room (taperMakeupRoom): race week carries none.
  if (out) out.taperRoom = raceWeek ? { easyMin: 0, ceilingMin: 0 } : { easyMin: easyLen, ceilingMin: roomCeiling };
  if (raceWeek && runsPerWeek <= 1) return [];

  if (runsPerWeek <= 1) {
    const mins = Math.max(EASY_FLOOR_MIN, long ?? Math.round(f * (ref.longMin ?? ref.totalMin) * lever));
    return [{ dayIndex: 0, slot: long != null ? 'long' : 'easy', totalMinutes: mins, workMinutes: mins, variantId: long != null ? 'long_steady' : 'easy_steady', notes: '' }];
  }

  let quality: SessionIntent | null = null;
  const taperPriority = applyRunnerTypeBias(workoutPriority(raceDistance, 'taper'), runnerType)
    .filter(sl => !excluded.has(sl));
  const qSlot = taperPriority[0];
  if (ref.qualityCount >= 1 && !acwrCaution && (qSlot === 'threshold' || qSlot === 'vo2')) {
    if (raceWeek) {
      const v = qSlot === 'vo2' ? TAPER_PRIMER_VO2 : TAPER_PRIMER_THRESHOLD;
      const total = Math.round(v.reps * (v.repMin + v.recMin) + 15);
      quality = {
        dayIndex: 0, slot: qSlot, totalMinutes: total, workMinutes: v.reps * v.repMin,
        reps: v.reps, repMinutes: v.repMin, recoveryMinutes: v.recMin, variantId: v.id, notes: 'Race-week primer',
      };
    } else if (qSlot === 'threshold') {
      const work = Math.round(thresholdWorkMinutes(ability, 'taper', weekIndex, totalWeeks) * lever);
      quality = { dayIndex: 0, slot: 'threshold', totalMinutes: work + 20, workMinutes: work, variantId: 'thr_20cont', notes: '' };
    } else {
      const v = pickPhaseVariant(VO2_VARIANTS, weekIndex, 'taper', variantWork);
      const work = Math.round(vo2WorkMinutes(ability, 'taper') * lever);
      quality = {
        dayIndex: 0, slot: 'vo2', totalMinutes: Math.round(v.reps * (v.repMin + v.recMin) + 15), workMinutes: work,
        reps: v.reps, repMinutes: v.repMin, recoveryMinutes: v.recMin, variantId: v.id, notes: '',
      };
    }
    if (quality && capRef != null && sessionEasyEquivalentMin(quality) > capRef) quality = null;
  }

  const slots = runsPerWeek - 1 /* long run, or the race in race week */ - (quality ? 1 : 0)
    + (!raceWeek && long == null ? 1 : 0);
  const fixedMin = (long ?? 0) + (quality?.totalMinutes ?? 0);
  const easyBudget = ceiling - fixedMin;
  let easyCount = Math.max(0, Math.min(slots, Math.round(Math.max(0, easyBudget) / easyLen)));
  if (prevTotalMin != null && easyCount > 0 && fixedMin + easyCount * easyLen > prevTotalMin) {
    easyCount = Math.max(0, Math.min(easyCount, Math.floor(Math.max(0, easyBudget) / easyLen)));
  }

  const week: SessionIntent[] = [];
  let dayIdx = 0;
  if (long != null) week.push({ dayIndex: runsPerWeek - 1, slot: 'long', totalMinutes: long, workMinutes: long, variantId: 'long_steady', notes: '' });
  if (quality) week.push({ ...quality, dayIndex: dayIdx++ });
  for (let i = 0; i < easyCount; i++) {
    week.push({ dayIndex: dayIdx++, slot: 'easy', totalMinutes: easyLen, workMinutes: easyLen, variantId: 'easy_steady', notes: '' });
  }
  return week;
}

/** One week of a sharpening block. `history[i]` = what the block prescribed in week i + 1. */
function buildSharpeningWeek(
  ctx: PlanContext, history: PrescribedWeek[], out?: { taperRoom?: TaperMakeupRoom },
): SessionIntent[] {
  const { raceDistance, weekIndex: k, totalWeeks: n, fitnessLevel, vdot } = ctx;
  const ability = abilityBandFromVdot(vdot, fitnessLevel);
  const phases = resolvePlanPhases(ctx);
  const raceWeek = isRaceWeek(k, n, false);
  const phaseOf = (j: number): TrainingPhase => (j === k ? ctx.phase : (phases[j - 1] ?? 'build'));
  const phase: TrainingPhase = raceWeek ? 'taper' : phaseOf(k);
  const start = ctx.sharpening ?? {
    startLongMin: sharpeningNoDataStartMin(raceDistance, ability, n),
    startSource: 'no-data' as const,
  };
  const startLong = clampSharpeningStartMin(start.startLongMin, ability, raceDistance);
  const caseB = start.startSource === 'history-no-recent-run';
  const archetype = ctx.archetype;
  const ramp = sharpeningRampPct(archetype);
  const longCap = longRunCapMin(ability, raceDistance);
  const easyPace = ctx.easyPaceSecPerKm ?? 360;
  const kmToMin = (km: number) => (km * easyPace) / 60;
  const hoursCapMin = ctx.weeklyHoursTarget != null && ctx.weeklyHoursTarget > 0 ? ctx.weeklyHoursTarget * 60 : Infinity;
  const isDeloadAt = (j: number, ph: TrainingPhase) => isSharpeningDeloadWeek(j, ability, phases, ph);
  const isLoadedAt = (j: number) => {
    const ph = j === n ? 'taper' : phaseOf(j);
    return (ph === 'build' || ph === 'peak') && !isDeloadAt(j, ph);
  };

  // Live levers, reduce-only (rows are ceilings).
  const forced = !!ctx.forceDeload && phase !== 'taper';
  const deload = phase !== 'taper' && (forced || isDeloadAt(k, phase));
  const lever = Math.min(1, adaptiveVolumeMultiplier(ctx, ability, deload));
  const acwrCaution = ctx.acwrStatus === 'caution';
  const acwrNote = acwrCaution ? 'ACWR caution — one quality session replaced with easy' : '';

  const longestSeated = (hist: PrescribedWeek[]): number | null => {
    let best: number | null = null;
    for (const w of hist) if (w.longMin != null && (best == null || w.longMin > best)) best = w.longMin;
    return best;
  };
  const lastLongOf = (hist: PrescribedWeek[]): number | null => {
    for (let j = hist.length - 1; j >= 0; j--) if (hist[j].longMin != null) return hist[j].longMin;
    return null;
  };
  const lastLoadedOf = (hist: PrescribedWeek[]): PrescribedWeek | null => {
    for (let j = hist.length; j >= 1; j--) if (isLoadedAt(j)) return hist[j - 1] ?? null;
    return null;
  };

  /** The loaded-week row for week j (1-based) given the weeks before it. */
  const loadedRow = (j: number, hist: PrescribedWeek[], ph: TrainingPhase): BlockWeekRow => {
    const seated = longestSeated(hist);
    let longTarget = seated == null ? startLong : Math.min(longCap, Math.floor(seated * (1 + ramp)));
    const recent = recentLongestLongRun(hist, j);
    if (recent != null) longTarget = Math.min(longTarget, longRunCeilingMin(recent));
    const longHold = seated != null ? Math.min(longTarget, seated) : null;
    let loadedIndex = 0;
    for (let i = 1; i <= j; i++) if (i === j || isLoadedAt(i)) loadedIndex++;
    let archBudget = Infinity;
    if (ctx.baselineKm != null && ctx.archetype != null) {
      const km = weekVolumeBudgetKm(loadedIndex, ctx.baselineKm, computePeakWeeklyKm(ctx), ctx.archetype);
      if (km > 0) archBudget = kmToMin(km);
    }
    const lastLoaded = lastLoadedOf(hist);
    const currentMin = ctx.baselineKm != null && ctx.baselineKm > 0 ? kmToMin(ctx.baselineKm) : 0;
    const chainRef = Math.max(lastLoaded?.totalMin ?? 0, currentMin);
    const chainBudget = chainRef > 0 ? chainRef * (1 + ramp) : Infinity;
    const budgetMin = Math.min(archBudget, chainBudget, hoursCapMin);
    // The hours target binds when it is the lowest of the three ceilings.
    const hoursBound = Number.isFinite(hoursCapMin) && hoursCapMin <= Math.min(archBudget, chainBudget);
    return {
      hoursBound,
      hoursCapMin: Number.isFinite(hoursCapMin) ? hoursCapMin : undefined,
      sessionPhase: caseB ? 'base' : ph,
      variantPhase: caseB ? 'base' : ph,
      longTarget,
      longHold,
      sessionCapMin: null,
      budgetMin: Number.isFinite(budgetMin) ? Math.round(budgetMin) : budgetMin,
      qualityLimit: qualityCap(ability, fitnessLevel, ctx.runsPerWeek),
      sizeMult: 1,
      deload: false,
      acwrNote: '',
    };
  };

  /** Summary of a virtual week-1 build week: the taper reference of a taper-only block. */
  const virtualReference = (): PrescribedWeek => {
    const row = loadedRow(1, [], 'build');
    const vctx: PlanContext = { ...ctx, weekIndex: 1, phase: 'build', effortScore: undefined, acwrStatus: undefined, ctlRatio: undefined, forceDeload: undefined };
    return summariseWeek(assembleBlockLoadedWeek(vctx, ability, row));
  };

  if (phase === 'taper') {
    // Taper position: the trailing run of taper weeks in the plan.
    let taperWeeks = 0;
    for (let j = n; j >= 1 && (j === n || phases[j - 1] === 'taper'); j--) taperWeeks++;
    const firstTaper = n - taperWeeks + 1;
    const pos = Math.min(taperWeeks, Math.max(1, k - firstTaper + 1));
    const f = taperFraction(pos, taperWeeks);
    const ref = lastLoadedOf(history.slice(0, Math.max(0, firstTaper - 1))) ?? virtualReference();
    const prevTotal = history[k - 2]?.totalMin ?? null;
    let week = assembleBlockTaperWeek(ctx, ability, ref, f, raceWeek, lastLongOf(history) ?? ref.longMin, lever, acwrCaution, prevTotal, out);
    if (ctx.liveLongRunCapMin != null) week = capLongRun(week, ctx.liveLongRunCapMin);
    return week;
  }

  const lastLoaded = lastLoadedOf(history);
  let row: BlockWeekRow;
  if (deload) {
    const dm = deloadMultiplier(ability);
    const base = lastLoaded ?? summariseWeek(assembleBlockLoadedWeek({ ...ctx, phase: 'build' }, ability, loadedRow(k, history, 'build')));
    const longD = base.longMin != null ? Math.round(base.longMin * dm * lever) : null;
    row = {
      sessionPhase: caseB ? 'base' : phase,
      variantPhase: 'base',
      longTarget: longD != null && longD >= LONG_SOFT_FLOOR_MIN ? longD : null,
      longHold: null,
      sessionCapMin: lastLongOf(history),
      budgetMin: Math.round(base.totalMin * dm * lever),
      hoursCapMin: Number.isFinite(hoursCapMin) ? hoursCapMin : undefined,
      qualityLimit: Math.min(qualityCap(ability, fitnessLevel, ctx.runsPerWeek), base.qualityCount),
      sizeMult: dm * lever,
      deload: true,
      acwrNote,
    };
  } else {
    row = loadedRow(k, history, phase);
    row.acwrNote = acwrNote;
    if (lever < 1) {
      row.longTarget = row.longTarget != null ? Math.round(row.longTarget * lever) : null;
      row.longHold = row.longHold != null ? Math.min(row.longHold, row.longTarget ?? row.longHold) : null;
      row.budgetMin = Math.round(row.budgetMin * lever);
      row.sizeMult = lever;
    }
  }
  if (acwrCaution) row.qualityLimit = Math.max(0, row.qualityLimit - 1);
  if (ctx.liveLongRunCapMin != null && row.longTarget != null) {
    row.longTarget = Math.min(row.longTarget, Math.max(LONG_SOFT_FLOOR_MIN, Math.floor(ctx.liveLongRunCapMin)));
    if (row.longHold != null) row.longHold = Math.min(row.longHold, row.longTarget);
  }
  return assembleBlockLoadedWeek(ctx, ability, row);
}

/**
 * Deload rule of a sharpening block: a build week on the ability cycle
 * (isDeloadWeek), except the last week before the taper, which takes the place
 * of the peak week (a block without a real fitness signal has no peak week) and
 * never deloads, like the peak. Peak and taper weeks never deload in a block:
 * the taper is the block's reduction. `phase` overrides phases[weekIndex - 1]
 * (the caller's label for the week being generated). Shared with the weekly
 * load target (planned-week-target.ts) so target and plan agree.
 */
export function isSharpeningDeloadWeek(
  weekIndex: number, ability: AbilityBand, phases: readonly TrainingPhase[], phase?: TrainingPhase,
): boolean {
  const ph = phase ?? phases[weekIndex - 1];
  if (ph !== 'build' || !isDeloadWeek(weekIndex, ability)) return false;
  let firstTaper = phases.length + 1;
  for (let j = phases.length; j >= 1 && phases[j - 1] === 'taper'; j--) firstTaper = j;
  return weekIndex !== firstTaper - 1;
}

/**
 * The longest long run a sharpening block can reach: its nominal long-run chain
 * (week 1 = the start, each later loaded week (1 + ramp) x the longest so far,
 * capped at the ability ceiling; deload and taper weeks never grow it) before a
 * weekly budget holds any week's growth. An upper bound on what the block
 * prescribes, for the race page, which reads it before the plan exists. A built
 * plan's own longest run comes from the plan (plannedRunMinutesByWeek).
 */
export function projectedSharpeningPeakLongMin(
  startLongMin: number, phases: readonly TrainingPhase[], ability: AbilityBand,
  archetype: Archetype | undefined, raceDistance: RaceDistance,
): number {
  const ramp = sharpeningRampPct(archetype);
  const cap = longRunCapMin(ability, raceDistance);
  let longest = clampSharpeningStartMin(startLongMin, ability, raceDistance);
  let seated = false;
  const n = phases.length;
  for (let j = 1; j <= n; j++) {
    const ph = j === n ? 'taper' : phases[j - 1];
    const loaded = (ph === 'build' || ph === 'peak') && !isSharpeningDeloadWeek(j, ability, phases, ph);
    if (!loaded) continue;
    if (seated) longest = Math.min(cap, Math.floor(longest * (1 + ramp)));
    seated = true;
  }
  return longest;
}

/** Reduce-only: hold a week's long run (and every easy run) to `capMin`. */
function capLongRun(week: SessionIntent[], capMin: number): SessionIntent[] {
  const cap = Math.max(LONG_SOFT_FLOOR_MIN, Math.floor(capMin));
  return week.map(i => (i.slot === 'long' || i.slot === 'easy') && i.totalMinutes > cap
    ? { ...i, totalMinutes: cap, workMinutes: cap }
    : i);
}

/**
 * Peak weekly km the plan is ramping toward. Derived from the ability-driven
 * minute budgets and easy pace. Matches the volume an established consistent
 * runner would see today (which is why their plan generation looks the same:
 * baseline ≥ peak → ramp clamps at peak from week 1).
 *
 * Mirrors the shape of `getPlanPrescribedMeanWeeklyKm` but at the peak point
 * of the plan rather than the build-phase mean.
 */
/**
 * Peak weekly running km the plan ramps toward. This is the single source of
 * the plan's volume destination: `effectiveWeeklyBudgetMin` ramps every week
 * toward it (see line ~409). It is therefore also the correct volume to feed
 * the race-day FORECAST — by race day the athlete has been holding this peak
 * for weeks, so the marathon-specificity / low-volume penalties must be
 * evaluated here, not at the athlete's pre-plan maintenance volume. Exported
 * (with a narrowed input type) so `blended-fitness.refreshBlendedFitness` can
 * read the same number the plan builds toward instead of recomputing it.
 */
export type PeakWeeklyKmInputs = Pick<
  PlanContext,
  'runsPerWeek' | 'raceDistance' | 'fitnessLevel' | 'totalWeeks' | 'vdot' | 'easyPaceSecPerKm'
>;

export function computePeakWeeklyKm(ctx: PeakWeeklyKmInputs): number {
  const ability = abilityBandFromVdot(ctx.vdot, ctx.fitnessLevel);
  const easyPaceSecPerKm = ctx.easyPaceSecPerKm ?? 360;
  // Long-run peak: distance-aware ability ceiling (marathon intermediate = 165 min
  // ≈ 30 km readiness threshold; shorter distances keep the general caps).
  const longMin = longRunCapMin(ability, ctx.raceDistance);
  const easyMin = easyRunMinutes(ability, ctx.raceDistance, 'peak');
  // Quality minutes (rough estimate, used as a constant): threshold + vo2 + mp.
  const qualityMin = thresholdWorkMinutes(ability, 'peak', ctx.totalWeeks, ctx.totalWeeks)
    + 20 // continuous threshold has warm/cool 20m baked in
    + vo2WorkMinutes(ability, 'peak') + 15
    + mpWorkMinutes(ctx.raceDistance, ability, 'peak') + 20;
  // RC3: a marathon (or half) at 3 runs/wk computes 3-2-1 = 0 here, crediting zero
  // easy aerobic volume in the peak-km estimate — undershooting the budget below
  // what the generator actually produces (which keeps one easy run). Floor at 1
  // for marathon when runsPerWeek >= 3 so the budget heuristic stops starving the
  // plan. Cross-training stays scheduled alongside (adapts on logging).
  const rawEasyCount = ctx.runsPerWeek - 2 - (ctx.raceDistance === 'marathon' || ctx.raceDistance === 'half' ? 1 : 0);
  const easyCount = ctx.raceDistance === 'marathon' && ctx.runsPerWeek >= 3
    ? Math.max(1, rawEasyCount)
    : Math.max(0, rawEasyCount);
  const totalMin = longMin + qualityMin + easyMin * easyCount;
  // km at easy pace (quality reps cover less ground per minute, but the integral
  // assumption is close enough for a budget heuristic. The goal here is a
  // realistic peak that an intermediate marathoner trains at, ~70-80 km).
  return (totalMin * 60) / easyPaceSecPerKm;
}

/**
 * Fit flexible sessions (easy, then long) into a weekly minute budget.
 * Quality sessions (threshold, vo2, marathon_pace, float) are never trimmed —
 * their stimulus depends on work-interval duration (Seiler 2010, Billat 2001).
 *
 * Easy-run policy (2026-06-02): a single floor, `EASY_FLOOR_MIN = 25` min. An
 * easy run below 25 min is not worth prescribing — the aerobic stimulus is
 * negligible relative to the fixed per-session overhead. When the budget
 * cannot give every planned easy run-day at least the floor, we CONSOLIDATE:
 * drop run-days and lengthen the survivors, rather than shrink them all into
 * 15-min fragments. At equal weekly volume, fewer longer easy runs deliver
 * more aerobic stimulus than many short ones — the continuous-duration
 * adaptations (mitochondrial density, capillarisation, fat oxidation) are
 * non-linear near the low end. The dropped run-days return automatically as
 * the volume budget ramps; the plan-view note surfaces the reduction.
 *
 * We never consolidate to ZERO easy runs: at least one survives (at the floor)
 * even when that overflows the budget. A week of intervals + a long run alone
 * is too little easy aerobic volume; the easy base matters more than a tidy
 * total. The volume-aware quality cap upstream keeps that overflow small by
 * limiting how much budget the quality sessions can claim.
 *
 * The long run has first claim on the budget after quality: the easy budget is
 * what is left once the full long run is seated, and no easy run is sized
 * longer than the long run (the long run is the week's longest run). When the
 * 10% rule holds the long run low, the minutes it frees are not handed to the
 * easy runs past the long run's length; they stay unprescribed.
 *
 * The long run keeps its two-tier floor (40 min standard, 30 min soft) and is
 * trimmed only by the overflow: first down to no lower than the standard floor,
 * then, if the week still overflows, down to no lower than the soft floor. A
 * long run already below a floor is never snapped down to the next one. Past
 * all floors we accept the residual overflow; the plan-view budget banner is
 * the user-facing surface for it.
 */
function applyHoursBudget(intents: SessionIntent[], budgetMin: number): void {
  const EASY_MIN = EASY_FLOOR_MIN;
  const STD_LONG_MIN = LONG_STD_FLOOR_MIN;
  const SOFT_LONG_MIN = LONG_SOFT_FLOOR_MIN;

  const total = () => intents.reduce((s, i) => s + i.totalMinutes, 0);
  if (total() <= budgetMin) return;

  const longIntent = intents.find(i => i.slot === 'long');

  // ── Consolidate easy runs ──────────────────────────────────────────────────
  // Compute the budget left for easy running after the untrimmable quality
  // sessions and the full long run. Then choose the FEWEST easy run-days such
  // that each survivor lands within [EASY_MIN, easyCapMin], dropping the
  // rest. Never shrink an easy run below the floor, and never size one longer
  // than the long run.
  const easyIntents = intents.filter(i => i.slot === 'easy');
  if (easyIntents.length > 0) {
    const nonEasyTotal = intents
      .filter(i => i.slot !== 'easy')
      .reduce((s, i) => s + i.totalMinutes, 0);
    const easyBudget = budgetMin - nonEasyTotal;
    // All easy intents share the same natural length (easyRunMinutes), already
    // held to the long run's length when the week was assembled. The cap is
    // re-applied here so the sizing below never lengthens an easy run past the
    // long run (the floor only takes over if the long run is itself under it).
    const naturalEasyMin = Math.max(...easyIntents.map(i => i.totalMinutes));
    const easyCapMin = longIntent
      ? Math.min(naturalEasyMin, Math.max(EASY_MIN, longIntent.totalMinutes))
      : naturalEasyMin;
    const desired = easyIntents.length;

    let finalCount: number;
    if (easyBudget < EASY_MIN) {
      // Not enough budget for even one floor-length easy run, but keep ONE
      // anyway (sized to the floor below): a week needs some dedicated easy
      // aerobic running. The resulting overflow is accepted and surfaced.
      finalCount = 1;
    } else {
      // Fewest runs keeping each survivor ≤ the cap; capped so each ≥ floor.
      const fewestAtNatural = Math.max(1, Math.ceil(easyBudget / easyCapMin));
      const mostAboveFloor = Math.floor(easyBudget / EASY_MIN);
      finalCount = Math.min(desired, fewestAtNatural, mostAboveFloor);
    }

    // Remove the dropped easy intents (keep the earliest `finalCount`).
    let toRemove = desired - finalCount;
    for (let i = intents.length - 1; i >= 0 && toRemove > 0; i--) {
      if (intents[i].slot === 'easy') { intents.splice(i, 1); toRemove--; }
    }
    // Size the survivors: split the easy budget evenly, clamped to the floor
    // and the cap. Rounded DOWN so the split never overflows the budget it was
    // sized from. Rounding to nearest overflowed by up to a minute, and that
    // minute was then taken off the long run (and with a long run under the
    // standard floor, the whole long run went to the soft floor).
    if (finalCount > 0) {
      const per = Math.min(easyCapMin, Math.max(EASY_MIN, Math.floor(easyBudget / finalCount)));
      for (const e of intents) {
        if (e.slot === 'easy') { e.totalMinutes = per; e.workMinutes = per; }
      }
    }
  }

  if (total() <= budgetMin) return;

  // ── Trim the long run by the overflow (two-tier floor) ─────────────────────
  // Tier 1 trims no lower than the standard floor, tier 2 no lower than the soft
  // floor. Each tier removes only the overflow and never lengthens the long run.
  // Before, tier 2 set the long run to the soft floor on ANY remaining overflow:
  // a 37-min long run one minute over budget became 30, which also lowered the
  // next weeks' 10% ceiling and kept the long run pinned near the floor.
  if (longIntent) {
    const trimLongTo = (floorMin: number): void => {
      const nonLongTotal = intents.filter(i => i.slot !== 'long').reduce((s, i) => s + i.totalMinutes, 0);
      const target = Math.max(floorMin, budgetMin - nonLongTotal);
      if (target < longIntent.totalMinutes) {
        longIntent.totalMinutes = target;
        longIntent.workMinutes = target;
      }
    };
    trimLongTo(STD_LONG_MIN);
    if (total() <= budgetMin) return;
    trimLongTo(SOFT_LONG_MIN);
    // The long run stays the week's longest run (only binds when the long run
    // was trimmed below an easy run that is itself above the easy floor).
    for (const e of intents) {
      if (e.slot !== 'easy') continue;
      const capped = Math.min(e.totalMinutes, Math.max(EASY_MIN, longIntent.totalMinutes));
      e.totalMinutes = capped;
      e.workMinutes = capped;
    }
  }

  if (total() <= budgetMin) return;

  // Past all floors. Accept the overflow rather than compress further. The
  // plan-view budget banner reads the actual total vs. budget on render and
  // lets the user pick a resolution.
  const qualityTotal = intents.filter(i => QUALITY_SLOT_SET.has(i.slot)).reduce((s, i) => s + i.totalMinutes, 0);
  if (qualityTotal > budgetMin) {
    console.warn(`[planWeekSessions] Quality sessions alone (${qualityTotal}min) exceed budget (${budgetMin}min). Budget not enforced on quality sessions.`);
  }
}
