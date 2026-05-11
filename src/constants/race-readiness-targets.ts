/**
 * Race-readiness volume targets per distance × discipline × ability band.
 *
 * Calibrated to Friel *Triathlete's Training Bible* 4th ed. (2018) volume
 * tables, scaled across 5 ability bands. Two signals per discipline:
 *
 *   1. Recent weekly volume (endurance reservoir)  — sustained training base
 *   2. Longest single session (specific peak prep) — race-distance-specific work
 *
 * Both feed into a *weighted* geometric-mean readiness score (see
 * `src/calculations/specific-endurance-penalty.ts`). Per-distance weights
 * recognise that:
 *   - Sprint is volume-heavy (no point doing 90+ min sessions for a 1-hour race)
 *   - IM is longest-heavy (weekly volume can't substitute for actually having
 *     done a 4-hour ride and 2:30 run — those peak sessions are non-negotiable)
 *
 * Per-band scaling reflects athlete adaptation capacity:
 *   - Beginner (~0.55× intermediate) — low ceiling; 60 km/wk would be over-training
 *   - Novice (~0.75×)
 *   - Intermediate (Friel baseline = 1.00×)
 *   - Advanced (~1.25×) — higher ceiling, needs more volume to be race-ready
 *   - Elite (~1.45×) — highest sustainable load
 *
 * Sources:
 *   - Friel J (2018) *The Triathlete's Training Bible* 4th ed., VeloPress
 *     (Tables 7.1, 8.x — intermediate-band targets)
 *   - Daniels (2014) *Daniels' Running Formula* 3rd ed. — VDOT-band running
 *     volume scaling (intermediate vs advanced plans)
 *   - Skinner & Strudwick coaching observations on IM volume × outcome
 *   - Coyle (1984) + Mujika & Padilla (2000) — fractional utilization decay
 *     scales with race distance
 */

import type { TriathlonDistance } from '@/types/triathlon';
import type { AbilityBand } from '@/types/training';

/** Discipline keys used throughout the race-readiness model. */
export type ReadinessDiscipline = 'swim' | 'bike' | 'run';

/** Distance keys spanning all triathlon races + standalone running. */
export type ReadinessDistance = TriathlonDistance | 'sprint' | 'olympic'
  | 'marathon' | 'half' | '10k' | '5k';

interface BandTargets {
  /** Recent weekly volume target. Hours for swim/bike, km for run. */
  weeklyVolume: number;
  /** Longest single session target in hours. */
  longestSessionHours: number;
}

interface DisciplineTargets {
  /** Per-band targets (5 Daniels bands). Higher bands = higher ceilings. */
  byBand: Record<AbilityBand, BandTargets>;
}

interface DistanceTargets {
  swim: DisciplineTargets;
  bike: DisciplineTargets;
  run: DisciplineTargets;
  /** Maximum penalty multiplier when fully unprepared (score = 0).
   *  Sprint barely volume-sensitive (race fits within glycolytic capacity);
   *  IM massively so (fractional utilization decay over 8-12 hours). */
  maxPenalty: number;
  /** Reference weeks of full-dose training to fully close a maximum penalty.
   *  Sprint: 4w (small gap, technique-bound). IM: 12w (largest gap, full
   *  Friel mesocycle). */
  closureWeeks: number;
  /** Per-distance weighting for the score's weighted geometric mean.
   *  `score = volumeRatio^volumeW × longestRatio^longestW × 100`.
   *  Sprint: weighted toward weekly volume (no time for 4hr rides to matter).
   *  IM: weighted toward longest sessions (you MUST have done long rides). */
  scoreWeights: { volume: number; longest: number };
}

// ───────────────────────────────────────────────────────────────────────────
// Per-band scaling helper.
// Generates a 5-band lookup from a single intermediate baseline. Multipliers
// chosen to match Daniels/Pfitzinger inter-band volume ratios for marathon
// running, then applied symmetrically to swim/bike (where Friel doesn't
// publish explicit per-band tables — closest analogue is Coggan W/kg tiers
// which scale similarly).
// ───────────────────────────────────────────────────────────────────────────

const ABILITY_VOLUME_MULTIPLIER: Record<AbilityBand, number> = {
  beginner:     0.55,
  novice:       0.75,
  intermediate: 1.00,
  advanced:     1.25,
  elite:        1.45,
};

/** Longest-session ceiling scales less aggressively than weekly volume —
 *  a beginner doing IM still needs to have done a 3-4hr ride to handle the
 *  bike leg; the absolute target floor is bounded by race demands, not just
 *  athlete adaptation ceiling. So multipliers are compressed (less spread). */
const ABILITY_LONGEST_MULTIPLIER: Record<AbilityBand, number> = {
  beginner:     0.70,
  novice:       0.85,
  intermediate: 1.00,
  advanced:     1.15,
  elite:        1.25,
};

function makeBandTargets(intermediateVolume: number, intermediateLongest: number): Record<AbilityBand, BandTargets> {
  const out = {} as Record<AbilityBand, BandTargets>;
  for (const band of ['beginner', 'novice', 'intermediate', 'advanced', 'elite'] as AbilityBand[]) {
    out[band] = {
      weeklyVolume:        intermediateVolume * ABILITY_VOLUME_MULTIPLIER[band],
      longestSessionHours: intermediateLongest * ABILITY_LONGEST_MULTIPLIER[band],
    };
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Targets table.
//
// Intermediate-row volumes from Friel 2018 (run targets cross-checked with
// Pfitzinger 2009 + Daniels 2014). Other bands derived via the multipliers
// above so the table stays consistent if we ever recalibrate one tier.
// ───────────────────────────────────────────────────────────────────────────

export const RACE_READINESS_TARGETS: Record<ReadinessDistance, DistanceTargets> = {
  // ─── Triathlon distances ────────────────────────────────────────────────
  sprint: {
    swim: { byBand: makeBandTargets(1.0,  0.5) },   // ~1.5 km longest
    bike: { byBand: makeBandTargets(2.0,  1.5) },
    run:  { byBand: makeBandTargets(17.5, 1.0) },   // ~17 km/wk run
    maxPenalty: 0.03,
    closureWeeks: 4,
    scoreWeights: { volume: 0.70, longest: 0.30 },  // volume-heavy (race < 1.5h)
  },
  olympic: {
    swim: { byBand: makeBandTargets(1.5,  0.65) },  // ~2 km longest
    bike: { byBand: makeBandTargets(3.5,  2.5)  },
    run:  { byBand: makeBandTargets(30,   1.5)  },
    maxPenalty: 0.05,
    closureWeeks: 6,
    scoreWeights: { volume: 0.60, longest: 0.40 },
  },
  '70.3': {
    swim: { byBand: makeBandTargets(2.0,  0.85) },  // ~2.5 km longest
    bike: { byBand: makeBandTargets(5.5,  3.0)  },
    run:  { byBand: makeBandTargets(42,   1.75) },
    maxPenalty: 0.10,
    closureWeeks: 10,
    scoreWeights: { volume: 0.50, longest: 0.50 },  // balanced
  },
  ironman: {
    swim: { byBand: makeBandTargets(3.0,  1.2) },   // ~3.5 km longest
    bike: { byBand: makeBandTargets(9.0,  4.5) },
    run:  { byBand: makeBandTargets(60,   2.5) },
    maxPenalty: 0.15,
    closureWeeks: 12,
    scoreWeights: { volume: 0.40, longest: 0.60 },  // longest-heavy (must have
                                                    //   done long rides + runs)
  },

  // ─── Standalone running distances ───────────────────────────────────────
  // Swim/bike fields are zero-filled and never read by the running-mode call
  // site. Run-only volume targets per Daniels/Pfitzinger intermediate plans.
  '5k': {
    swim: { byBand: makeBandTargets(0, 0) },
    bike: { byBand: makeBandTargets(0, 0) },
    run:  { byBand: makeBandTargets(25, 0.75) },
    maxPenalty: 0.04,
    closureWeeks: 4,
    scoreWeights: { volume: 0.70, longest: 0.30 },
  },
  '10k': {
    swim: { byBand: makeBandTargets(0, 0) },
    bike: { byBand: makeBandTargets(0, 0) },
    run:  { byBand: makeBandTargets(35, 1.0) },
    maxPenalty: 0.06,
    closureWeeks: 6,
    scoreWeights: { volume: 0.60, longest: 0.40 },
  },
  half: {
    swim: { byBand: makeBandTargets(0, 0) },
    bike: { byBand: makeBandTargets(0, 0) },
    run:  { byBand: makeBandTargets(50, 1.5) },
    maxPenalty: 0.08,
    closureWeeks: 8,
    scoreWeights: { volume: 0.50, longest: 0.50 },
  },
  marathon: {
    swim: { byBand: makeBandTargets(0, 0) },
    bike: { byBand: makeBandTargets(0, 0) },
    run:  { byBand: makeBandTargets(65, 2.5) },
    maxPenalty: 0.15,
    closureWeeks: 12,
    scoreWeights: { volume: 0.40, longest: 0.60 },
  },
};

/**
 * Window for "recent weekly volume" computation. Matches the existing
 * `WINDOW_WEEKS = 8` in `prediction-inputs.ts` so the run-discipline signal
 * is identical between the new framework and the existing run-side blend.
 */
export const READINESS_VOLUME_WINDOW_WEEKS = 8;

/**
 * Window for "longest single session" lookup. Matches the existing
 * `applyDurabilityCap` 12-week window so the longest-session signal is
 * naturally recent (any session counted is ≤ 84 days old).
 */
export const READINESS_LONGEST_WINDOW_WEEKS = 12;

/**
 * Score thresholds for UI band labels. Values are score percentages (0-100).
 * Bands map to colours via `readinessColor()` in `src/calculations/readiness.ts`.
 */
export const READINESS_BANDS = [
  { min: 90, label: 'Race ready',    tone: 'ok' as const },
  { min: 70, label: 'On track',      tone: 'ok' as const },
  { min: 50, label: 'Building',      tone: 'caution' as const },
  { min: 30, label: 'Underprepared', tone: 'warn' as const },
  { min: 0,  label: 'Not ready',     tone: 'warn' as const },
];

/**
 * PB-recency scaling for run discipline only. A recent marathon/half/10K/5K
 * PB demonstrates current full-distance capability beyond what training-only
 * data shows; reduces the penalty's *excess* (the part above 1.0) by the
 * recency factor. Carried over from the existing `marathonSpecificityPenalty`
 * (see SCIENCE_LOG entry "PB-recency scaling for marathon-specificity penalty
 * 2026-05-05") so users with recent run PBs aren't penalised harder by the
 * new framework than by the old.
 */
export const RUN_PB_RECENCY_BANDS = [
  { maxAgeDays: 365,  factor: 0.5  },  // Within 1y → halve penalty
  { maxAgeDays: 730,  factor: 0.75 },  // 1-2y → 75%
  { maxAgeDays: Infinity, factor: 1.0 }, // > 2y → full penalty
];

/**
 * Cross-distance credit weights for triathlon bike/swim PB-recency reduction.
 *
 * When a user has completed a full-distance triathlon, their bike and swim legs
 * each get a recency-reduction credit. The credit weight depends on the
 * relationship between the race completed ("from") and the target race ("to").
 *
 * Design principles:
 *   - Richer-counts-for-shorter: completing a longer race fully credits shorter
 *     distances (finishing an IM proves you can handle a sprint's bike/swim leg).
 *   - Partial reverse credit: a shorter race partially credits longer distances
 *     because bike/swim endurance at shorter durations transfers upward, but
 *     incomplete distance-specific conditioning still applies.
 *   - Bike/swim values are lower than run for short-to-long credit. A sprint
 *     bike (20km, ~30min) doesn't prove much about sustaining 180km on the IM
 *     bike (Coyle 1984: fractional utilization decays meaningfully between 30min
 *     and 5+ hour efforts). Run cross-credit stays at 1.0 (Daniels-precedented
 *     up-distance run transfer via VDOT equivalence).
 *   - Missing entries default to 0 (no credit).
 *
 * Indexed as TRI_DISTANCE_CROSS_CREDIT[fromDistance][toDistance][discipline].
 *
 * Sources: Coyle 1984 (*J Appl Physiol*, fractional utilization vs duration);
 * Daniels' Running Formula (up-distance run equivalence via VDOT).
 */
export type CrossCreditDiscipline = 'swim' | 'bike' | 'run';

/** Distance keys for the tri cross-credit table — broader than `TriathlonDistance`
 *  (which is only 70.3/ironman) because we need to express credit between sprint,
 *  olympic, 70.3 and ironman. */
export type TriCrossCreditDistance = 'sprint' | 'olympic' | '70.3' | 'ironman';

export const TRI_DISTANCE_CROSS_CREDIT: Partial<Record<
  TriCrossCreditDistance,
  Partial<Record<TriCrossCreditDistance, Partial<Record<CrossCreditDiscipline, number>>>>
>> = {
  ironman: {
    ironman: { swim: 1.0, bike: 1.0, run: 1.0 },
    '70.3':  { swim: 1.0, bike: 1.0, run: 1.0 },
    olympic: { swim: 1.0, bike: 1.0, run: 1.0 },
    sprint:  { swim: 1.0, bike: 1.0, run: 1.0 },
  },
  '70.3': {
    ironman: { swim: 0.6, bike: 0.6, run: 0.5 },
    '70.3':  { swim: 1.0, bike: 1.0, run: 1.0 },
    olympic: { swim: 1.0, bike: 1.0, run: 1.0 },
    sprint:  { swim: 1.0, bike: 1.0, run: 1.0 },
  },
  olympic: {
    ironman: { swim: 0.3, bike: 0.3, run: 0.3 },
    '70.3':  { swim: 0.6, bike: 0.6, run: 0.5 },
    olympic: { swim: 1.0, bike: 1.0, run: 1.0 },
    sprint:  { swim: 1.0, bike: 1.0, run: 1.0 },
  },
  sprint: {
    ironman: { swim: 0.2, bike: 0.2, run: 0.2 },
    '70.3':  { swim: 0.3, bike: 0.3, run: 0.3 },
    olympic: { swim: 0.7, bike: 0.7, run: 1.0 },
    sprint:  { swim: 1.0, bike: 1.0, run: 1.0 },
  },
};

/**
 * Cross-discipline transfer factors for race-readiness.
 *
 * When computing one discipline's readiness, fractionally credit the
 * volumeRatios of *other* disciplines. Captures shared cardiac/aerobic-base
 * adaptations across modalities (Bassett & Howley 2000: ~70-85% of VO2max
 * adaptations are central/cardiac, so partially shared) while respecting
 * mode-specific endurance limits (Tanaka 1995, Mutton 1993: peripheral
 * adaptations remain mode-specific, so transfer is partial not full).
 *
 * Asymmetric matrix:
 *   - Bike → Run: largest transfer (~30%) because cycling delivers ~50% of
 *     run-specific cardiovascular adaptations (Mutton 1993) but minimal
 *     run-economy gains (Bassett & Howley 2000) — net ~30% for endurance prep.
 *   - Run → Bike: ~25% — cardiac transfer plus some shared leg-pattern
 *     endurance, but cycling-specific power demands aren't trained.
 *   - Swim ↔ Bike/Run: ~10% one way, ~5% the other — swim is technique-bound
 *     and the leg-vs-arm mechanical separation makes peripheral transfer minimal.
 *
 * Sources: Tanaka 1995 (cross-training meta-review), Bassett & Howley 2000
 * (cardiac vs peripheral VO2 adaptations), Mutton et al. 1993 (cycling-to-
 * running transfer), Loy 1995 (cross-training maintenance), Millet & Vleck
 * 2000 (concurrent training in triathlon).
 *
 * Indexed as `CROSS_DISCIPLINE_TRANSFER[from][to]`.
 */
export const CROSS_DISCIPLINE_TRANSFER: Record<ReadinessDiscipline, Record<ReadinessDiscipline, number>> = {
  swim: { swim: 1.00, bike: 0.10, run: 0.10 }, // swim → others: small cardiac transfer
  bike: { swim: 0.05, bike: 1.00, run: 0.30 }, // bike → run: largest off-diagonal
  run:  { swim: 0.05, bike: 0.25, run: 1.00 }, // run → bike: substantial cardiac
};

/**
 * Sigmoid steepness for the score → penalty curve. `k=0.08` gives a clean
 * S-shape: 90% ready → 4% of max penalty (low impact), 50% ready → 50% of max
 * penalty (midpoint), 30% ready → 83% of max (steep), 0% ready → 98% of max.
 * Captures "almost-ready is much different from not-ready" — linear would
 * over-penalise nearly-ready athletes and under-penalise unprepared ones.
 */
export const SCORE_TO_PENALTY_SIGMOID_K = 0.08;
