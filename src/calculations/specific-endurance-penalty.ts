/**
 * Specific endurance penalty — generalises the existing marathon-specificity
 * pattern across triathlon's three disciplines and the four IM/70.3/Olympic/
 * Sprint distances (plus standalone running 5K/10K/Half/Marathon).
 *
 * **The problem**: prediction engines compute "today's race time" from fitness
 * markers (FTP, CSS, VDOT) and assume the athlete can sustain those for the
 * full race distance. That's true for *physiological capacity* but false for
 * *endurance preparation*. An IM is 8-12 hours of work; without specific
 * volume the athlete blows up on the bike, walks the marathon, struggles on
 * the swim. Markers are necessary but not sufficient.
 *
 * **The fix**: per-discipline penalty multiplier scaled by a 0-100 readiness
 * score. Score combines (geometric mean):
 *   1. Recent weekly volume (endurance reservoir)
 *   2. Longest single session (specific peak prep + recency proxy via
 *      12-week window)
 *
 * For RUN discipline only, an additional PB-recency factor reduces the
 * penalty when the athlete has a recent race PB demonstrating full-distance
 * capability — preserves existing `marathonSpecificityPenalty` behaviour.
 *
 * **Side of the line**: tracking. This describes "what fitness reality is
 * given the athlete's training so far", not "what the plan should prescribe".
 * The penalty applies to TODAY's prediction; race-day projection uses the
 * plan's prescribed dose and gets full readiness by definition.
 *
 * Sources: Friel 2018 *Triathlete's Training Bible* 4th ed.; Coyle 1984 +
 * Mujika & Padilla 2000 (fractional utilization decay); existing pattern
 * in `predictions.ts` `marathonSpecificityPenalty`.
 */

import type { SimulatorState } from '@/types/state';
import type { ReadinessDiscipline, ReadinessDistance } from '@/constants/race-readiness-targets';
import {
  RACE_READINESS_TARGETS,
  READINESS_VOLUME_WINDOW_WEEKS,
  READINESS_LONGEST_WINDOW_WEEKS,
  READINESS_BANDS,
  RUN_PB_RECENCY_BANDS,
  TRI_DISTANCE_CROSS_CREDIT,
  SCORE_TO_PENALTY_SIGMOID_K,
} from '@/constants/race-readiness-targets';
import type { CrossCreditDiscipline } from '@/constants/race-readiness-targets';
import type { TriathlonDistance } from '@/types/triathlon';
import type { AbilityBand } from '@/types/training';
import { recentHoursByDiscipline, longestSessionByDiscipline } from './tri-volume-by-discipline';
import { computePredictionInputs } from './prediction-inputs';
import { collectRunsFromState } from './blended-fitness';
import { getAbilityBand as getRunAbilityBandFromVdot } from './fatigue';

// Local band classifiers — duplicated rather than imported to avoid a
// circular dependency (race-prediction → race-readiness → this file). The
// canonical versions live in `race-prediction.triathlon.ts`; if those bands
// change, mirror here. Tests below pin the boundaries.
function localCssToBand(cssSec: number): AbilityBand {
  if (cssSec < 90)  return 'elite';
  if (cssSec < 100) return 'advanced';
  if (cssSec < 115) return 'intermediate';
  if (cssSec < 140) return 'novice';
  return 'beginner';
}
function localFtpToBand(ftpW: number): AbilityBand {
  if (ftpW < 175) return 'beginner';
  if (ftpW < 220) return 'novice';
  if (ftpW < 270) return 'intermediate';
  if (ftpW < 320) return 'advanced';
  return 'elite';
}

/**
 * Result for one discipline's readiness assessment. UI surfaces consume
 * `score` + `label` + `penaltyMultiplier`; debug surfaces consume the
 * `*Actual` / `*Required` fields to explain *why* the score is what it is.
 */
export interface DisciplineReadiness {
  discipline: ReadinessDiscipline;
  /** 0-100 readiness percentage. 100 = fully ready, 0 = unprepared. */
  score: number;
  /** UI band label per `READINESS_BANDS`. */
  label: string;
  /** UI tone hint ('ok' / 'caution' / 'warn') for colour mapping. */
  tone: 'ok' | 'caution' | 'warn';
  /** Multiplier applied to "today's" predicted leg time. ≥ 1.0; 1.0 = no penalty. */
  penaltyMultiplier: number;
  // Diagnostic fields for the "why this score" UI surface
  weeklyVolumeActual: number;
  weeklyVolumeRequired: number;
  /** Units of the volume value: 'km' for run, 'hours' for swim/bike. */
  weeklyVolumeUnit: 'km' | 'hours';
  longestSessionActualHours: number;
  longestSessionRequiredHours: number;
  /** Athlete's ability band for THIS discipline — drives target lookup. */
  abilityBand: AbilityBand;
  /** Volume ratio used in score (post cross-discipline transfer if any). */
  volumeRatio: number;
  /** Longest-session ratio used in score. */
  longestRatio: number;
  /** Run discipline only: was the PB-recency factor applied? */
  pbRecencyApplied?: boolean;
  pbAgeDays?: number;
}

/**
 * Determine an athlete's ability band for a specific discipline.
 *   - Run: from VDOT (`getAbilityBand` in fatigue.ts) — uses Daniels VDOT bands
 *   - Bike: from FTP (W) — Coggan-tier approximation at ~70kg
 *   - Swim: from CSS (sec/100m)
 * Falls back to 'intermediate' when the marker is missing — matches the
 * existing horizon-model band default. Per-discipline bands let an athlete
 * be 'advanced' on bike but 'novice' on swim — the readiness model treats
 * each leg separately rather than projecting one ability across all three.
 */
export function getReadinessAbilityBand(
  state: SimulatorState,
  discipline: ReadinessDiscipline,
): AbilityBand {
  if (discipline === 'run') {
    const vdot = state.v ?? 0;
    if (vdot > 0) return getRunAbilityBandFromVdot(vdot);
    return 'intermediate';
  }
  if (discipline === 'bike') {
    const ftp = state.triConfig?.bike?.ftp;
    if (ftp != null && ftp > 0) return localFtpToBand(ftp);
    return 'intermediate';
  }
  // swim
  const css = state.triConfig?.swim?.cssSecPer100m;
  if (css != null && css > 0) return localCssToBand(css);
  return 'intermediate';
}

/**
 * Optional per-discipline readiness inputs that override the normal
 * state-derived volume signal. Used by the cross-discipline transfer
 * pass — a discipline's `volumeRatio` can be inflated by fractional
 * credit from other disciplines' raw volumeRatios. See
 * `computeTriRaceReadiness` in `race-readiness.ts`.
 */
export interface DisciplineReadinessOverrides {
  /** If supplied, replaces the state-derived volumeRatio for this call. */
  volumeRatioOverride?: number;
}

/**
 * Compute one discipline's race-readiness for a target race distance.
 *
 * @param state    Simulator state (read-only — this is a pure tracking calc)
 * @param discipline  'swim' | 'bike' | 'run'
 * @param distance Race distance key (triathlon: sprint/olympic/70.3/ironman;
 *                 running: marathon/half/10k/5k)
 * @param overrides Optional input overrides (used by cross-discipline transfer pass)
 */
export function computeDisciplineReadiness(
  state: SimulatorState,
  discipline: ReadinessDiscipline,
  distance: ReadinessDistance,
  overrides: DisciplineReadinessOverrides = {},
): DisciplineReadiness {
  const targets = RACE_READINESS_TARGETS[distance];
  const targetForDisc = targets[discipline];
  const maxPenalty = targets.maxPenalty;
  const scoreWeights = targets.scoreWeights;

  // ─── Ability band per discipline → target lookup ────────────────────
  const abilityBand = getReadinessAbilityBand(state, discipline);
  const bandTarget = targetForDisc.byBand[abilityBand];

  // ─── Volume reservoir (weekly volume in last 8 weeks) ─────────────────
  const { actual: weeklyVolumeActual, unit: weeklyVolumeUnit } =
    readWeeklyVolume(state, discipline);

  // ─── Specific peak prep (longest single session in last 12 weeks) ─────
  const longestSec = longestSessionByDiscipline(state, READINESS_LONGEST_WINDOW_WEEKS)[discipline];
  const longestSessionActualHours = longestSec / 3600;

  // ─── Ratios (cap each at 1.2 — over-preparing doesn't keep boosting) ──
  const baseVolumeRatio = bandTarget.weeklyVolume > 0
    ? Math.min(1.2, weeklyVolumeActual / bandTarget.weeklyVolume)
    : 1.2; // no target → treat as fully ready (e.g. running mode for swim/bike)
  const longestRatio = bandTarget.longestSessionHours > 0
    ? Math.min(1.2, longestSessionActualHours / bandTarget.longestSessionHours)
    : 1.2;

  // Apply override if supplied (cross-discipline transfer pass) — capped at 1.2
  const volumeRatio = overrides.volumeRatioOverride != null
    ? Math.min(1.2, overrides.volumeRatioOverride)
    : baseVolumeRatio;

  // ─── Weighted geometric mean ──────────────────────────────────────────
  // `score = volumeRatio^volumeW × longestRatio^longestW × 100`
  // Per-distance weights (Sprint volume-heavy, IM longest-heavy) recognise
  // that the relative importance of weekly volume vs single-session peak
  // shifts with race distance. For IM, you MUST have done long rides/runs;
  // weekly volume can't substitute. For Sprint, the inverse.
  // Both ratios still required (zero × anything = zero).
  const combined = Math.pow(volumeRatio, scoreWeights.volume)
                 * Math.pow(longestRatio, scoreWeights.longest);
  const score = Math.min(100, combined * 100);

  // ─── Sigmoid penalty curve ────────────────────────────────────────────
  // `penaltyShare = 1 - 1/(1 + exp(k × (50 - score)))`. Captures "almost-
  // ready is much different from not-ready" — linear would over-penalise
  // 90% ready (4% of max instead of 10%) and under-penalise 30% (83% of
  // max instead of 70%). Midpoint preserved at score=50 → 50% of max.
  const penaltyShare = 1 - 1 / (1 + Math.exp(SCORE_TO_PENALTY_SIGMOID_K * (50 - score)));
  let penaltyMultiplier = 1 + Math.max(0, Math.min(1, penaltyShare)) * maxPenalty;

  // ─── PB/race-recency factor (run: from race PBs; bike/swim: from raceLog) ──
  // A recent performance demonstrating full-distance capability reduces the
  // penalty's *excess* (the part above 1.0) by a recency factor. Run uses
  // standalone race PBs (preserving existing `marathonSpecificityPenalty`
  // behaviour). Bike/swim use completed triathlon entries from `raceLog` with
  // cross-distance credit weights (TRI_DISTANCE_CROSS_CREDIT).
  let pbRecencyApplied = false;
  let pbAgeDays: number | undefined = undefined;
  if (penaltyMultiplier > 1.0) {
    let ageDays: number | undefined;
    let crossCreditWeight = 1.0;
    if (discipline === 'run') {
      ageDays = readRunPbAgeDays(state, distance);
    } else {
      const recency = readTriRaceRecencyDays(
        state,
        discipline as CrossCreditDiscipline,
        distance as TriathlonDistance,
      );
      if (recency) { ageDays = recency.ageDays; crossCreditWeight = recency.crossCreditWeight; }
    }
    pbAgeDays = ageDays;
    if (ageDays != null) {
      const recencyBand = RUN_PB_RECENCY_BANDS.find(b => ageDays! < b.maxAgeDays);
      const bandFactor = recencyBand?.factor ?? 1.0;
      // effectiveFactor: scale band reduction by cross-credit weight so a
      // shorter-than-target race delivers partial (not full) penalty reduction.
      const effectiveFactor = 1 - (1 - bandFactor) * crossCreditWeight;
      if (effectiveFactor < 1.0) {
        const excess = penaltyMultiplier - 1.0;
        penaltyMultiplier = 1.0 + excess * effectiveFactor;
        pbRecencyApplied = true;
      }
    }
  }

  const band = READINESS_BANDS.find(b => score >= b.min) ?? READINESS_BANDS[READINESS_BANDS.length - 1];

  return {
    discipline,
    score: Math.round(score),
    label: band.label,
    tone: band.tone,
    penaltyMultiplier,
    weeklyVolumeActual,
    weeklyVolumeRequired: bandTarget.weeklyVolume,
    weeklyVolumeUnit,
    longestSessionActualHours,
    longestSessionRequiredHours: bandTarget.longestSessionHours,
    abilityBand,
    volumeRatio,
    longestRatio,
    ...(pbAgeDays != null ? { pbAgeDays } : {}),
    ...(pbRecencyApplied ? { pbRecencyApplied: true } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read recent weekly volume per discipline. Run uses `weeklyKm` from the
 * existing prediction-inputs computation (8w window, km). Swim/bike use
 * `recentHoursByDiscipline` (hours over the same window).
 *
 * Run uses km because the existing horizon model and marathon-specificity
 * penalty already operate in km — keeps the unified framework's run output
 * consistent with prior behaviour. Swim/bike use hours because triathlon
 * activities don't always have a cleanly extractable distance signal (open-
 * water swims with manual entry, indoor rides on smart trainers).
 */
function readWeeklyVolume(
  state: SimulatorState,
  discipline: ReadinessDiscipline,
): { actual: number; unit: 'km' | 'hours' } {
  if (discipline === 'run') {
    const runs = collectRunsFromState(state);
    const inputs = computePredictionInputs(runs);
    return { actual: inputs.weeklyKm ?? 0, unit: 'km' };
  }
  // Swim/bike: hours/week from the 8-week window. recentHoursByDiscipline
  // defaults to 12w — pass the readiness-specific 8w window explicitly so
  // the volume signal aligns with the run side.
  const hours = recentHoursByDiscipline(state, READINESS_VOLUME_WINDOW_WEEKS)[discipline];
  return { actual: hours, unit: 'hours' };
}

/**
 * Look up the run PB date for a given race distance and return age in days.
 * Returns undefined if no PB is recorded for that distance, no date is
 * persisted, or the distance is non-running.
 *
 * Reads from `state.onboarding.pbDates` which is populated by
 * `review.ts` during Strava best_efforts auto-fill. The existing
 * `marathonSpecificityPenalty` already uses this field — we reuse it here
 * so the PB-recency behaviour is identical between old and new code paths.
 */
function readRunPbAgeDays(
  state: SimulatorState,
  distance: ReadinessDistance,
): number | undefined {
  const pbKey = pbKeyForDistance(distance);
  if (!pbKey) return undefined;
  const dateISO = state.onboarding?.pbDates?.[pbKey];
  if (!dateISO) return undefined;
  const ageMs = Date.now() - new Date(dateISO).getTime();
  if (!isFinite(ageMs) || ageMs < 0) return undefined;
  return Math.floor(ageMs / (24 * 60 * 60 * 1000));
}

function pbKeyForDistance(distance: ReadinessDistance): 'k5' | 'k10' | 'h' | 'm' | null {
  // Run distances map directly to the PB keys.
  if (distance === '5k') return 'k5';
  if (distance === '10k') return 'k10';
  if (distance === 'half') return 'h';
  if (distance === 'marathon') return 'm';
  // Triathlon distances: use the run-leg's marathon/half PB as the recency proxy
  // (the run leg of an IM is a marathon; the run leg of a 70.3 is a half).
  if (distance === 'ironman') return 'm';
  if (distance === '70.3') return 'h';
  // Sprint/Olympic run legs are 5K/10K respectively — use those PBs.
  if (distance === 'olympic') return 'k10';
  if (distance === 'sprint') return 'k5';
  return null;
}

/**
 * Scan `triConfig.raceLog` for the most recent completed triathlon entry that
 * credits the target discipline at the target distance. Returns the age in days
 * of that entry and the cross-credit weight (from TRI_DISTANCE_CROSS_CREDIT).
 * Returns null when no qualifying entry exists.
 *
 * Cross-credit: a richer (longer) race fully credits shorter target distances;
 * a shorter race partially credits longer ones (reduced factor per
 * TRI_DISTANCE_CROSS_CREDIT). An entry qualifies when `actualPerLeg[discipline]
 * > 0` — the leg was actually completed.
 */
function readTriRaceRecencyDays(
  state: SimulatorState,
  discipline: CrossCreditDiscipline,
  targetDistance: TriathlonDistance,
): { ageDays: number; fromDistance: TriathlonDistance; crossCreditWeight: number } | null {
  const log = state.triConfig?.raceLog;
  if (!log || log.length === 0) return null;

  let best: { ageDays: number; fromDistance: TriathlonDistance; crossCreditWeight: number } | null = null;

  for (const entry of log) {
    if (!entry.dateISO) continue;
    const leg = entry.actualPerLeg?.[discipline];
    if (!leg || leg <= 0) continue;

    const fromDist = entry.distance as TriathlonDistance;
    const creditRow = TRI_DISTANCE_CROSS_CREDIT[fromDist];
    if (!creditRow) continue;
    const creditByDiscipline = creditRow[targetDistance];
    if (!creditByDiscipline) continue;
    const weight = creditByDiscipline[discipline] ?? 0;
    if (weight <= 0) continue;

    const ageMs = Date.now() - new Date(entry.dateISO).getTime();
    if (!isFinite(ageMs) || ageMs < 0) continue;
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

    // Best entry: highest cross-credit weight first (a completed IM is more
    // relevant for IM readiness than a recent Olympic regardless of recency).
    // Break ties by recency (smaller ageDays).
    if (best == null
        || weight > best.crossCreditWeight
        || (weight === best.crossCreditWeight && ageDays < best.ageDays)) {
      best = { ageDays, fromDistance: fromDist, crossCreditWeight: weight };
    }
  }

  return best;
}
