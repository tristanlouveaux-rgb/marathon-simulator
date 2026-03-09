/**
 * Fitness model: CTL/ATL/TSB (Performance Management Chart) using exponential decay on weekly TL.
 *
 * Training Load (TL) is a TSS-calibrated number computed from:
 *   - iTRIMP (preferred when available) normalised to ~55 TL for easy 60min
 *   - RPE × TL_PER_MIN table (fallback)
 *
 * CTL (Chronic Training Load) = 42-day exponential moving average of weekly TL (fitness)
 * ATL (Acute Training Load)   = 7-day exponential moving average  (fatigue)
 * TSB (Training Stress Balance) = CTL − ATL (form)
 *
 * ACWR (Acute:Chronic Workload Ratio) = ATL / CTL
 * Safe upper bound varies by athlete tier (see TIER_ACWR_CONFIG).
 */

import type { Week } from '@/types';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';
import { normalizeSport } from '@/cross-training/activities';

export interface FitnessMetrics {
  week: number;
  ctl: number;      // Chronic Training Load (42-day EMA) — Signal A (run-equivalent)
  atl: number;      // Acute Training Load (7-day EMA) — Signal B (raw physiological)
  tsb: number;      // Training Stress Balance = CTL - ATL
  actualTSS: number;
  rawTSS: number;   // Signal B for this week (no runSpec discount)
}

// Weekly EMA decay constants (7-day weeks)
export const CTL_DECAY = Math.exp(-7 / 42);  // ≈ 0.847
export const ATL_DECAY = Math.exp(-7 / 7);   // ≈ 0.368

/** Normalise iTRIMP to a TSS-equivalent TL value (≈55 for easy 60min) */
function normalizeiTrimp(itrimp: number): number {
  // Using typical LTHR_HRR for average athlete
  const NORMALIZER = 15000;
  return (itrimp * 100) / NORMALIZER;
}

/** Parse duration in minutes from an adhoc workout description (e.g. "45min · 12 Feb") */
function parseDurMinFromDesc(d: string): number {
  const m = d.match(/(\d+)min/);
  return m ? parseInt(m[1]) : 30;
}

/**
 * Compute the Training Stress Score (TSS) for a single week.
 * Uses wk.actualTSS when already stored (fastest path).
 * Falls back to computing from garminActuals, adhocWorkouts, and unspentLoadItems.
 *
 * @param planStartDate - ISO date string of plan start. When provided, unspentLoadItems
 *   are filtered to only those whose date falls within this week's 7-day window, preventing
 *   carry-over items from previous weeks inflating this week's TSS.
 */
export function computeWeekTSS(
  wk: Week,
  ratedMap: Record<string, number | 'skip'>,
  planStartDate?: string,
): number {
  // Always recompute from raw data — wk.actualTSS may be stale/corrupted
  // (ISSUE-85: cross-training was accumulated without runSpec discount).

  let tl = 0;

  // Dedup set: prevents double-counting when the same activity appears in both
  // garminActuals and adhocWorkouts (e.g. a Strava-matched run that also has an adhoc entry).
  const seenGarminIds = new Set<string>();

  // Matched runs via garminActuals
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const ratedVal = ratedMap[workoutId];
    const rpe = (typeof ratedVal === 'number') ? ratedVal : 5;
    if (actual.iTrimp != null && actual.iTrimp > 0) {
      tl += normalizeiTrimp(actual.iTrimp);
    } else {
      // Duration-based fallback when no HR data (TL_PER_MIN is per minute, not per km)
      const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
      tl += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
    }
  }

  // Adhoc Garmin cross-training workouts
  for (const w of wk.adhocWorkouts ?? []) {
    if (!w.id?.startsWith('garmin-')) continue;
    const rawId = w.id.slice('garmin-'.length);
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
    }
    const sport = normalizeSport(w.n.replace(' (Garmin)', '').toLowerCase());
    const cfg = (SPORTS_DB as any)[sport];
    const runSpec = cfg?.runSpec ?? 0.35;
    if (w.iTrimp != null && w.iTrimp > 0) {
      // Strava HR stream iTrimp available — more accurate than RPE estimate
      tl += (w.iTrimp * 100) / 15000 * runSpec;
    } else {
      const rpe = w.rpe ?? 5;
      const durMin = parseDurMinFromDesc(w.d);
      tl += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15) * runSpec;
    }
  }

  // Unspent load items (cross-training overflow not matched to a plan slot).
  // Filter to this week's date range when planStartDate is known — carry-over items
  // from previous weeks retain their original dates and must not inflate this week's TSS.
  let weekStartMs: number | null = null;
  let weekEndMs: number | null = null;
  if (planStartDate && wk.w != null) {
    weekStartMs = new Date(planStartDate).getTime() + (wk.w - 1) * 7 * 86400000;
    weekEndMs = weekStartMs + 7 * 86400000;
  }
  for (const item of wk.unspentLoadItems ?? []) {
    if (weekStartMs !== null && weekEndMs !== null && item.date) {
      const itemMs = new Date(item.date).getTime();
      if (itemMs < weekStartMs || itemMs >= weekEndMs) continue;
    }
    const sport = normalizeSport(item.sport);
    const cfg = (SPORTS_DB as any)[sport];
    const runSpec = cfg?.runSpec ?? 0.35;
    tl += item.durationMin * (TL_PER_MIN[5] ?? 1.15) * runSpec;
  }

  return Math.round(tl);
}

/** @deprecated Use computeWeekTSS */
export const computeWeekTL = computeWeekTSS;

/**
 * Compute raw physiological TSS for a single week (Signal B).
 * Identical to computeWeekTSS except all cross-training runSpec discounts are removed:
 * cycling, strength, HIIT, etc. all count at full iTRIMP weight.
 *
 * Use this for ACWR/injury risk and weekly load charts — the body doesn't care
 * what sport caused the fatigue.
 */
export function computeWeekRawTSS(
  wk: Week,
  ratedMap: Record<string, number | 'skip'>,
  planStartDate?: string,
): number {
  let tl = 0;

  // Dedup set: tracks garminIds already counted so that the same activity cannot
  // appear in two sources (e.g. both adhocWorkouts AND unspentLoadItems).
  const seenGarminIds = new Set<string>();

  // Matched runs via garminActuals — same as computeWeekTSS (no runSpec for runs)
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const ratedVal = ratedMap[workoutId];
    const rpe = (typeof ratedVal === 'number') ? ratedVal : 5;
    if (actual.iTrimp != null && actual.iTrimp > 0) {
      tl += normalizeiTrimp(actual.iTrimp);
    } else {
      const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
      tl += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
    }
  }

  // Adhoc workouts — runSpec = 1.0 (full physiological cost, Signal B)
  // Include ALL adhoc workouts regardless of ID prefix: Garmin-synced ('garmin-'),
  // GPS-recorded (UUID), and any other manually logged entries.
  for (const w of wk.adhocWorkouts ?? []) {
    // Extract garminId from the adhoc workout id (format: 'garmin-<garminId>')
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
    }
    if (w.iTrimp != null && w.iTrimp > 0) {
      tl += (w.iTrimp * 100) / 15000; // no runSpec discount
    } else {
      const rpe = w.rpe ?? w.r ?? 5;
      const durMin = parseDurMinFromDesc(w.d);
      tl += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15); // no runSpec discount
    }
  }

  // Unspent load items — runSpec = 1.0
  let weekStartMs: number | null = null;
  let weekEndMs: number | null = null;
  if (planStartDate && wk.w != null) {
    weekStartMs = new Date(planStartDate).getTime() + (wk.w - 1) * 7 * 86400000;
    weekEndMs = weekStartMs + 7 * 86400000;
  }
  for (const item of wk.unspentLoadItems ?? []) {
    if (weekStartMs !== null && weekEndMs !== null && item.date) {
      const itemMs = new Date(item.date).getTime();
      if (itemMs < weekStartMs || itemMs >= weekEndMs) continue;
    }
    if (item.garminId) {
      if (seenGarminIds.has(item.garminId)) continue;
      seenGarminIds.add(item.garminId);
    }
    tl += item.durationMin * (TL_PER_MIN[5] ?? 1.15); // no runSpec discount
  }

  return Math.round(tl);
}

/**
 * Weekly Signal B excess above the athlete's historical baseline.
 * Returns 0 if no baseline is available (prevents phantom reductions on new users).
 */
export function getWeeklyExcess(
  wk: Week,
  signalBBaseline: number,
  planStartDate?: string,
): number {
  if (!signalBBaseline) return 0;
  return Math.max(0, computeWeekRawTSS(wk, wk.rated ?? {}, planStartDate) - signalBBaseline);
}

// ---------------------------------------------------------------------------
// Planned Load Model (ISSUE-79)
// ---------------------------------------------------------------------------

/**
 * Phase multipliers by athlete tier.
 * Higher-tier athletes tolerate bigger week-to-week ramps.
 * Base = maintain, Build = progressive overload, Peak = max sustainable,
 * Deload = recovery, Taper = linear ramp down.
 */
const PHASE_MULTIPLIERS: Record<string, Record<string, number>> = {
  beginner:    { base: 0.95, build: 1.05, peak: 1.08, deload: 0.70 },
  recreational:{ base: 0.97, build: 1.08, peak: 1.10, deload: 0.70 },
  trained:     { base: 1.00, build: 1.10, peak: 1.13, deload: 0.68 },
  performance: { base: 1.00, build: 1.12, peak: 1.15, deload: 0.65 },
  high_volume: { base: 1.00, build: 1.15, peak: 1.18, deload: 0.65 },
};

/**
 * Compute taper multiplier: linear ramp from 0.85 → 0.55 over taper weeks.
 */
function taperMultiplier(weekInTaper: number, totalTaperWeeks: number): number {
  if (totalTaperWeeks <= 1) return 0.70;
  const t = Math.min(weekInTaper, totalTaperWeeks) / totalTaperWeeks;
  return 0.85 - t * 0.30; // 0.85 → 0.55
}

/**
 * Compute the planned weekly TSS target for a given phase.
 *
 * Uses the MEDIAN of historicWeeklyTSS as baseline (not the EMA).
 * Median reflects "what you normally do" without being dragged down by rest
 * weeks or up by outlier peaks. Falls back to ctlBaseline (EMA) if no
 * weekly history, then to runs/week × 50 as last resort.
 *
 * @param historicWeeklyTSS - Array of recent weekly Signal A TSS values
 * @param ctlBaseline - 42-day EMA of Signal A (fallback)
 * @param phase - Training phase: base/build/peak/deload/taper
 * @param athleteTier - Athlete tier for multiplier selection
 * @param runsPerWeek - Fallback when no history at all
 * @param weekInPhase - For taper: which week within taper (0-indexed)
 * @param totalPhaseWeeks - For taper: total taper weeks
 */
export function computePlannedWeekTSS(
  historicWeeklyTSS: number[] | undefined,
  ctlBaseline: number | undefined,
  phase: string,
  athleteTier?: string,
  runsPerWeek?: number,
  weekInPhase?: number,
  totalPhaseWeeks?: number,
): number {
  // 1. Determine baseline: median of history > EMA > fallback
  let baseline: number;
  const hist = historicWeeklyTSS?.filter(v => v > 0) ?? [];
  if (hist.length >= 3) {
    const sorted = [...hist].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    baseline = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  } else if (ctlBaseline && ctlBaseline > 0) {
    baseline = ctlBaseline;
  } else {
    baseline = (runsPerWeek ?? 3) * 50; // last resort
  }

  // 2. Apply phase multiplier
  const tier = athleteTier ?? 'recreational';
  const tierMults = PHASE_MULTIPLIERS[tier] ?? PHASE_MULTIPLIERS.recreational;

  let multiplier: number;
  const ph = phase?.toLowerCase() ?? 'base';
  if (ph === 'taper') {
    multiplier = taperMultiplier(weekInPhase ?? 0, totalPhaseWeeks ?? 3);
  } else {
    multiplier = tierMults[ph] ?? tierMults.base;
  }

  return Math.round(baseline * multiplier);
}

// ---------------------------------------------------------------------------
// ACWR — Acute:Chronic Workload Ratio
// ---------------------------------------------------------------------------

export type AthleteACWRStatus = 'safe' | 'caution' | 'high' | 'unknown';

export interface AthleteACWR {
  ratio: number;          // ATL / CTL
  safeUpper: number;      // Tier-specific safe upper bound
  status: AthleteACWRStatus;
  atl: number;
  ctl: number;
}

/** Per-tier ACWR thresholds and display labels (from spec §2) */
export const TIER_ACWR_CONFIG: Record<string, { safeUpper: number; label: string }> = {
  beginner:     { safeUpper: 1.2, label: 'New to structured training' },
  recreational: { safeUpper: 1.3, label: 'Recreational runner' },
  trained:      { safeUpper: 1.4, label: 'Trained runner' },
  performance:  { safeUpper: 1.5, label: 'Performance athlete' },
  high_volume:  { safeUpper: 1.6, label: 'High-volume athlete' },
};

/**
 * Compute the Acute:Chronic Workload Ratio for the current point in the plan.
 *
 * Requires at least 3 weeks of history for a meaningful signal — returns
 * status='unknown' until that threshold is met.
 *
 * @param wks - All weeks in the plan
 * @param currentWeek - Current 1-indexed week number (computes up to but not including this week)
 * @param athleteTier - Optional athlete tier key; defaults to 'recreational'
 * @param ctlSeed - Optional CTL seed from Strava history (seeds the CTL loop instead of starting from 0)
 * @param planStartDate - ISO date string used to filter unspentLoadItems to their correct week
 */
export function computeACWR(
  wks: Week[],
  currentWeek: number,
  athleteTier?: string,
  ctlSeed?: number,
  planStartDate?: string,
  atlSeed?: number,
): AthleteACWR {
  const tier = athleteTier ?? 'recreational';
  const tierCfg = TIER_ACWR_CONFIG[tier] ?? TIER_ACWR_CONFIG.recreational;
  const { safeUpper } = tierCfg;

  const metrics = computeFitnessModel(wks, currentWeek, ctlSeed, planStartDate, atlSeed);

  if (metrics.length < 3) {
    // Not enough history for a reliable ratio
    const latest = metrics[metrics.length - 1];
    return { ratio: 0, safeUpper, status: 'unknown', atl: latest?.atl ?? 0, ctl: latest?.ctl ?? 0 };
  }

  const latest = metrics[metrics.length - 1];
  const { ctl, atl } = latest;

  if (ctl < 1) {
    // CTL too low to compute a meaningful ratio (first few weeks of zero training)
    return { ratio: 0, safeUpper, status: 'unknown', atl, ctl };
  }

  const ratio = atl / ctl;

  let status: AthleteACWRStatus;
  if (ratio < 0.8) {
    status = 'unknown'; // undertraining / intentional deload
  } else if (ratio <= safeUpper) {
    status = 'safe';
  } else if (ratio <= safeUpper + 0.2) {
    status = 'caution';
  } else {
    status = 'high';
  }

  return { ratio, safeUpper, status, atl, ctl };
}

/**
 * Compute CTL, ATL, TSB for each completed week in order.
 * Returns one entry per week up to (but not including) currentWeek.
 *
 * @param ctlSeed - Optional CTL starting value from Strava history (seeds Signal A chronic baseline)
 * @param planStartDate - ISO date string used to filter unspentLoadItems to their correct week
 * @param atlSeed - Optional Signal B ATL seed. When omitted, derived from ctlSeed × 1.0.
 *   Callers who know the user's cross-training history should pass a higher value (e.g. ctlSeed × 1.2
 *   for gym-heavy athletes) so ACWR reflects real fatigue from day one.
 */
export function computeFitnessModel(
  wks: Week[],
  currentWeek: number,
  ctlSeed?: number,
  planStartDate?: string,
  atlSeed?: number,
): FitnessMetrics[] {
  const results: FitnessMetrics[] = [];
  let ctl = ctlSeed ?? 0;
  let atl = atlSeed ?? ctlSeed ?? 0; // Signal B seed — higher than CTL for cross-training athletes

  const limit = Math.min(currentWeek, wks.length);
  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const rated = wk.rated ?? {};
    const weekTSS = computeWeekTSS(wk, rated, planStartDate);
    // Signal B: raw physiological TSS (no runSpec discount) — used for ATL/fatigue
    const weekRawTSS = computeWeekRawTSS(wk, rated, planStartDate);

    // When user overrode a reduction recommendation, add 15% synthetic ATL debt.
    // Recovery debt from check-in adds further ATL inflation (orange +10%, red +20%).
    // CTL (Signal A) stays accurate; ATL (Signal B raw) is inflated to reflect suppressed fatigue.
    let atlMultiplier = 1.0;
    if (wk.acwrOverridden)             atlMultiplier = 1.15;
    if (wk.recoveryDebt === 'orange')  atlMultiplier = Math.max(atlMultiplier, 1.10);
    if (wk.recoveryDebt === 'red')     atlMultiplier = Math.max(atlMultiplier, 1.20);
    const atlTSS = atlMultiplier > 1.0 ? Math.round(weekRawTSS * atlMultiplier) : weekRawTSS;

    ctl = ctl * CTL_DECAY + weekTSS * (1 - CTL_DECAY);    // CTL = Signal A
    atl = atl * ATL_DECAY + atlTSS * (1 - ATL_DECAY);     // ATL = Signal B
    const tsb = ctl - atl;

    results.push({ week: wk.w, ctl, atl, tsb, actualTSS: weekTSS, rawTSS: weekRawTSS });
  }

  return results;
}

/**
 * Compute same-signal CTL and ATL using Signal B (raw physiological TSS) for BOTH.
 * Used by readiness to get a fair freshness reading for cross-trainers.
 *
 * Problem solved: the mixed-signal model (CTL=Signal A, ATL=Signal B) produces permanently
 * negative TSB for athletes doing significant cross-training, because cross-training is
 * discounted in Signal A but counted at full weight in Signal B. That's correct for load
 * management (the plan view), but wrong for readiness ("how fatigued are you overall?").
 *
 * By using Signal B for both CTL and ATL, the steady-state TSB converges near 0 for a
 * consistent training load — reflecting actual balance, not the A/B discount gap.
 */
export function computeSameSignalTSB(
  wks: Week[],
  currentWeek: number,
  ctlSeed?: number,
  planStartDate?: string,
): { ctl: number; atl: number; tsb: number } | null {
  const limit = Math.min(currentWeek, wks.length);
  if (limit === 0) return null;

  let ctl = ctlSeed ?? 0;
  let atl = ctlSeed ?? 0; // same seed — no gym-inflation offset

  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const rated = wk.rated ?? {};
    const weekRawTSS = computeWeekRawTSS(wk, rated, planStartDate);

    // ATL inflation from overrides/recovery debt still applies (reflects suppressed fatigue)
    let atlMultiplier = 1.0;
    if (wk.acwrOverridden)            atlMultiplier = 1.15;
    if (wk.recoveryDebt === 'orange') atlMultiplier = Math.max(atlMultiplier, 1.10);
    if (wk.recoveryDebt === 'red')    atlMultiplier = Math.max(atlMultiplier, 1.20);
    const atlTSS = atlMultiplier > 1.0 ? Math.round(weekRawTSS * atlMultiplier) : weekRawTSS;

    ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY); // Signal B for both
    atl = atl * ATL_DECAY + atlTSS   * (1 - ATL_DECAY);   // Signal B for both
  }

  return { ctl, atl, tsb: ctl - atl };
}
