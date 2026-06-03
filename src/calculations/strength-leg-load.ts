/**
 * Derived leg load from a strength / gym session.
 *
 * The gym is a participant in the SAME leg-fatigue ledger that runs and
 * cross-training already feed (`s.recentLegLoads`, decayed + RBE-discounted in
 * readiness.ts). It is NOT a parallel model. This module only computes the raw
 * leg-load units a gym session contributes; the existing decay (48 h half-life),
 * Repeated Bout Effect, and readiness floors (LEG_LOAD_MODERATE=20 /
 * LEG_LOAD_HEAVY=60) consume it unchanged.
 *
 * ── Science (see SCIENCE_LOG §BD) ─────────────────────────────────────────────
 * Exercise-induced muscle damage (EIMD) and the functional force-deficit that the
 * leg-load floor models (Clarkson & Hubal 2002 — the same basis readiness.ts
 * cites) are driven by mechanical tension and eccentric exposure. The three
 * standard, literature-backed determinants are:
 *
 *   legScore       — volume of leg-muscle work as HARD SETS (Schoenfeld/Krieger:
 *                    "hard sets" is the dose currency). Reuses the canonical
 *                    muscle-group attribution (`deriveWorkedMuscleGroups`), summed
 *                    over the leg groups only. An upper/core day scores ~0 on legs
 *                    automatically — a leg day scores high. No new anatomy guesses.
 *   intensityMult  — relative mechanical tension ≈ %1RM (weight ÷ est-1RM).
 *                    Linear in %1RM, referenced to a heavy working intensity (80%).
 *   effortMult     — proximity to failure via session RPE (Foster 2001 sRPE, the
 *                    same effort signal the app's strength TSS uses). Higher RPE =
 *                    more reps taken near failure = more eccentric damage.
 *
 *   legLoadRaw = K_STRENGTH × legScore × intensityMult × effortMult
 *
 * K_STRENGTH is calibrated so a canonical hard leg day (5×5 back squat @80% +
 * 3×8 RDL + 3×12 split squat, RPE 7) lands at ≈16 raw units — reproducing the
 * pre-existing `legFeel: 'heavy'` scaffold (≈0.35 load/min × ~45 min, state.ts).
 * That session's legScore = 18 (quads 8 + glutes 7 + hams 3), intensity 1.0,
 * effort 1.0 → 0.9 × 18 = 16.2. The richer model then varies objectively around
 * the already-accepted anchor.
 *
 * ── Tracking, not planning ────────────────────────────────────────────────────
 * Leg load feeds the readiness leg-load FLOOR only. It is NOT added to CTL/ATL or
 * any TSS path (gym TSS is already counted separately via the RPE-TSS route), so
 * there is no double-count. This is a "describe the legs' state" signal, per the
 * CLAUDE.md tracking/planning separation.
 *
 * ── Known limitations ─────────────────────────────────────────────────────────
 * - Dose currency is hard SETS, not reps × load. intensityMult + effortMult stand
 *   in for the rep/failure dimension; explicit per-lift RIR is a future refinement.
 * - Bodyweight / plyometric leg work has no %1RM → intensityMult defaults to 1.0
 *   (a working set imposes meaningful tension regardless of external load). Plyos
 *   are arguably under-weighted (high eccentric cost); an eccentric tier is a
 *   future refinement.
 * - The RBE key is sport identity ('strength'), so two leg days in a fortnight
 *   discount each other but a run does not protect against squats (conservative).
 */

import type { Workout } from '@/types/state';
import { applyRbeDiscount, LEG_LOAD_MODERATE, computeLegLoadBreakdown } from './readiness';
import { parseStrengthSession } from '@/guided/strength-model';
import { deriveWorkedMuscleGroups } from './strength-muscle-groups';

/** Leg muscle groups (excludes core/back) — keys from strength-muscle-groups.ts. */
const LEG_GROUPS = new Set(['quads', 'glutes', 'hamstrings', 'calves']);

/** Global calibration constant. Anchored to the `legFeel: 'heavy'` scaffold —
 *  canonical hard leg day (legScore 18, intensity 1.0, effort 1.0) ≈ 16 units. */
export const K_STRENGTH = 0.9;

/** Reference working intensity for the intensity term. 80% 1RM = a heavy set = 1.0. */
const PCT_ONE_RM_REF = 0.80;
const INTENSITY_MIN = 0.5;
const INTENSITY_MAX = 1.25;

/** Reference session RPE for the effort term. RPE 7 (hard, ~2 RIR) = 1.0. */
const RPE_REF = 7;
const EFFORT_MIN = 0.6;
const EFFORT_MAX = 1.25;

/**
 * Per-session raw-load thresholds that map a strength session to a leg-load decay
 * override. Greater EIMD → longer functional recovery (Clarkson & Hubal 2002,
 * severity-dependent), so a heavy leg day decays slower than the 48 h baseline.
 * Multipliers (1.05 / 1.20) reuse the pre-existing `legFeel` scaffold. Thresholds
 * are derived from the anchor: HEAVY ≈ the anchor (16), MODERATE ≈ half.
 */
export const STRENGTH_LEG_LOAD_HEAVY_RAW = 14;
export const STRENGTH_LEG_LOAD_MODERATE_RAW = 7;
const STRENGTH_HALFLIFE_MULT_HEAVY = 1.20;
const STRENGTH_HALFLIFE_MULT_MODERATE = 1.05;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export interface StrengthLegLoad {
  /** Raw leg-load units, comparable to run km-equivalents (pre-decay, pre-RBE). */
  raw: number;
  /** Sum of leg-group hard-set scores (quads + glutes + hamstrings + calves). */
  legScore: number;
  intensityMult: number;
  effortMult: number;
}

/**
 * Compute the raw leg load for a completed/parsed strength session.
 *
 * @param muscleGroups worked-group scores from `deriveWorkedMuscleGroups` (each
 *   `score` = primary 1× + secondary 0.5× × sets). Pass the SAME array the recap
 *   uses so the number can't diverge from the "Worked" chips.
 * @param loggedLifts per-lift weights for the %1RM term; null/empty → intensity 1.0.
 * @param sessionRpe session RPE (1–10) the user rated, or the prescribed RPE on a
 *   quick "mark as done".
 */
export function deriveStrengthLegLoad(
  muscleGroups: Array<{ group: string; score: number }>,
  loggedLifts: Array<{ weightKg?: number; estimatedOneRmKg?: number }> | null | undefined,
  sessionRpe: number,
): StrengthLegLoad {
  const legScore = muscleGroups
    .filter(g => LEG_GROUPS.has(g.group))
    .reduce((sum, g) => sum + (g.score > 0 ? g.score : 0), 0);

  if (legScore <= 0) return { raw: 0, legScore: 0, intensityMult: 1, effortMult: 1 };

  // Mean %1RM across the loaded leg-relevant lifts. Bodyweight / plyometric work
  // carries no weight → contributes no %1RM sample; if none, default to 1.0.
  const pcts: number[] = [];
  for (const l of loggedLifts ?? []) {
    if (l.weightKg && l.weightKg > 0 && l.estimatedOneRmKg && l.estimatedOneRmKg > 0) {
      pcts.push(l.weightKg / l.estimatedOneRmKg);
    }
  }
  const meanPct = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  const intensityMult = meanPct == null
    ? 1.0
    : clamp(meanPct / PCT_ONE_RM_REF, INTENSITY_MIN, INTENSITY_MAX);

  const rpe = Number.isFinite(sessionRpe) && sessionRpe > 0 ? sessionRpe : RPE_REF;
  const effortMult = clamp(rpe / RPE_REF, EFFORT_MIN, EFFORT_MAX);

  const raw = K_STRENGTH * legScore * intensityMult * effortMult;
  return { raw, legScore, intensityMult, effortMult };
}

/**
 * Manual leg-involvement tag (`legFeel`) for ambiguous SYNCED sessions that carry
 * no exercise detail — e.g. a Garmin/Strava "HIIT" logged as General Sport, or a
 * synced strength activity. There's no way to infer leg work from such a row, so
 * the user tags it and we convert duration → leg load with a per-minute rate.
 *
 * Rates and decay multipliers are the values the original `legFeel` scaffold
 * documented (state.ts) and that Tristan signed off in earlier leg-load work
 * (CHANGELOG 2026-05): moderate ≈ 0.15 load/min, half-life ×1.05; heavy ≈ 0.35
 * load/min, half-life ×1.20. `none`/unset writes nothing.
 */
export const LEG_FEEL_RATE = { moderate: 0.15, heavy: 0.35 } as const;
const LEG_FEEL_HALFLIFE_MULT = { moderate: 1.05, heavy: 1.20 } as const;

export function legFeelRawLoad(legFeel: string | undefined, durationMin: number): number {
  if (durationMin <= 0) return 0;
  if (legFeel === 'heavy') return durationMin * LEG_FEEL_RATE.heavy;
  if (legFeel === 'moderate') return durationMin * LEG_FEEL_RATE.moderate;
  return 0;
}

export function legFeelRecoveryMult(legFeel: string | undefined): number | undefined {
  if (legFeel === 'heavy') return LEG_FEEL_HALFLIFE_MULT.heavy;
  if (legFeel === 'moderate') return LEG_FEEL_HALFLIFE_MULT.moderate;
  return undefined;
}

/** Map a raw strength leg load to its leg-load decay half-life multiplier. */
export function strengthRecoveryMult(raw: number): number {
  if (raw >= STRENGTH_LEG_LOAD_HEAVY_RAW) return STRENGTH_HALFLIFE_MULT_HEAVY;
  if (raw >= STRENGTH_LEG_LOAD_MODERATE_RAW) return STRENGTH_HALFLIFE_MULT_MODERATE;
  return 1.0;
}

/** A `recentLegLoads` ledger entry (matches the SimulatorState shape). */
export interface RecentLegLoadEntry {
  load: number;
  sport: string;
  sportLabel: string;
  timestampMs: number;
  garminId?: string;
  rbeProtected?: boolean;
  recoveryMultOverride?: number;
}

/**
 * Build the `recentLegLoads` entry for a completed strength session from its
 * stamped `legLoadRaw`. Single source for both write sites (completion in
 * strength-complete.ts and the reconcile sweep in sport-picker-modal.ts) so the
 * two can't diverge. Applies the Repeated Bout Effect against prior STRENGTH
 * bouts (two leg days in a fortnight discount each other; `applyRbeDiscount`
 * keys on sport identity, so non-strength priors are ignored) and sets the
 * heavy-day decay override. Returns null when there is no leg load to record.
 */
export function buildStrengthLegLoadEntry(
  actual: { legLoadRaw?: number; garminId?: string },
  priorEntries: Array<{ sport: string; timestampMs: number }>,
  timestampMs: number,
): RecentLegLoadEntry | null {
  const raw = actual.legLoadRaw ?? 0;
  if (raw <= 0) return null;
  const { load, protected: rbeProtected } = applyRbeDiscount('strength', timestampMs, raw, priorEntries);
  return {
    load,
    sport: 'strength',
    sportLabel: 'Strength',
    timestampMs,
    garminId: actual.garminId,
    rbeProtected,
    recoveryMultOverride: strengthRecoveryMult(raw),
  };
}

/**
 * Remove leg-load entries superseded by a (re-)completed strength session before
 * writing the fresh one: the same activity (same garminId) and any STRENGTH entry
 * within ±10 min (a re-completion that minted a new `guided-{ts}` id, or a
 * duplicate the reconcile sweep would otherwise collapse). Same ±10-min same-sport
 * rule reconcileRecentLegLoads uses. Run / cross-training entries are preserved so
 * the Repeated Bout Effect still applies against them.
 */
export function dropSupersededStrengthEntries<T extends { garminId?: string; sport: string; timestampMs: number }>(
  entries: T[],
  garminId: string | undefined,
  timestampMs: number,
): T[] {
  const TEN_MIN = 10 * 60_000;
  return entries.filter(e =>
    e.garminId !== garminId &&
    !(e.sport === 'strength' && Math.abs(e.timestampMs - timestampMs) <= TEN_MIN),
  );
}

/**
 * Read side: should we nudge the user to ease an upcoming leg session because the
 * legs are already loaded from recent training?
 *
 * Suggest-only (no plan mutation): the nudge fires when the planned gym session
 * is a genuine leg day (estimated raw ≥ the moderate per-session threshold) AND
 * the current decayed leg-load total is already at the "Manage Load" floor
 * (LEG_LOAD_MODERATE). Returns the consultant-tone copy, or null when no nudge.
 *
 * @param plannedSessionRaw estimated leg load of the upcoming session
 *   (deriveStrengthLegLoad on the parsed planned workout).
 * @param decayedLegLoadTotal current decayed `recentLegLoads` total
 *   (computeLegLoadBreakdown(...).total).
 * @param sourceLabel lower-cased label of the dominant recent leg-load bout
 *   (e.g. "running"), and its timeframe (e.g. "yesterday").
 */
export function buildGymLegLoadNudge(opts: {
  plannedSessionRaw: number;
  decayedLegLoadTotal: number;
  sourceLabel?: string | null;
  timeframe?: string | null;
}): string | null {
  if (opts.plannedSessionRaw < STRENGTH_LEG_LOAD_MODERATE_RAW) return null;
  if (opts.decayedLegLoadTotal < LEG_LOAD_MODERATE) return null;
  const label = (opts.sourceLabel ?? '').trim().toLowerCase();
  const src = label
    ? `${label}${opts.timeframe ? ` ${opts.timeframe}` : ''}`
    : 'recent training';
  return `Legs are still loaded from ${src}. Consider easing today's leg session. Drop a set or back off the weight.`;
}

/**
 * Convenience for plan-view gym cards (running + tri): given a planned strength
 * workout and the current leg-load ledger, return the nudge copy or null. One
 * source so the running and triathlon cards can't drift. Estimates the planned
 * session's leg load from its exercises (no logged weights yet → intensity 1.0).
 */
export function gymLegLoadNudgeForWorkout(
  workout: Workout,
  recentLegLoads: Array<{ load: number; sport: string; sportLabel: string; timestampMs: number; recoveryMultOverride?: number }>,
  plannedRpe: number,
  nowMs: number,
): string | null {
  const planned = parseStrengthSession(workout);
  if (!planned) return null;
  const { raw } = deriveStrengthLegLoad(deriveWorkedMuscleGroups(planned), null, plannedRpe);
  const bd = computeLegLoadBreakdown(recentLegLoads, nowMs);
  return buildGymLegLoadNudge({
    plannedSessionRaw: raw,
    decayedLegLoadTotal: bd.total,
    sourceLabel: bd.topEntry?.sportLabel ?? null,
  });
}
