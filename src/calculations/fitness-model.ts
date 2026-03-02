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
  ctl: number;   // Chronic Training Load (42-day EMA)
  atl: number;   // Acute Training Load (7-day EMA)
  tsb: number;   // Training Stress Balance = CTL - ATL
  actualTSS: number;
}

// Weekly EMA decay constants (7-day weeks)
const CTL_DECAY = Math.exp(-7 / 42);  // ≈ 0.847
const ATL_DECAY = Math.exp(-7 / 7);   // ≈ 0.368

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
 */
export function computeWeekTSS(
  wk: Week,
  ratedMap: Record<string, number | 'skip'>,
): number {
  if (wk.actualTSS != null) return wk.actualTSS;
  // Backward compat: migrate old actualTL field
  if ((wk as any).actualTL != null) return (wk as any).actualTL;

  let tl = 0;

  // Matched runs via garminActuals
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
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

  // Unspent load items (cross-training overflow not matched to a plan slot)
  for (const item of wk.unspentLoadItems ?? []) {
    const sport = normalizeSport(item.sport);
    const cfg = (SPORTS_DB as any)[sport];
    const runSpec = cfg?.runSpec ?? 0.35;
    tl += item.durationMin * (TL_PER_MIN[5] ?? 1.15) * runSpec;
  }

  return Math.round(tl);
}

/** @deprecated Use computeWeekTSS */
export const computeWeekTL = computeWeekTSS;

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
 */
export function computeACWR(
  wks: Week[],
  currentWeek: number,
  athleteTier?: string,
  ctlSeed?: number,
): AthleteACWR {
  const tier = athleteTier ?? 'recreational';
  const tierCfg = TIER_ACWR_CONFIG[tier] ?? TIER_ACWR_CONFIG.recreational;
  const { safeUpper } = tierCfg;

  const metrics = computeFitnessModel(wks, currentWeek, ctlSeed);

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
 * @param ctlSeed - Optional CTL starting value from Strava history (avoids starting from 0)
 */
export function computeFitnessModel(
  wks: Week[],
  currentWeek: number,
  ctlSeed?: number,
): FitnessMetrics[] {
  const results: FitnessMetrics[] = [];
  let ctl = ctlSeed ?? 0;
  let atl = ctlSeed ?? 0; // seed ATL from CTL baseline so ratio starts near 1.0

  const limit = Math.min(currentWeek, wks.length);
  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const rated = wk.rated ?? {};
    const weekTSS = computeWeekTSS(wk, rated);

    // When user overrode a reduction recommendation, add 15% synthetic ATL debt.
    // Recovery debt from check-in adds further ATL inflation (orange +10%, red +20%).
    // CTL remains accurate (actual fitness); ATL is inflated to reflect suppressed fatigue.
    let atlMultiplier = 1.0;
    if (wk.acwrOverridden)             atlMultiplier = 1.15;
    if (wk.recoveryDebt === 'orange')  atlMultiplier = Math.max(atlMultiplier, 1.10);
    if (wk.recoveryDebt === 'red')     atlMultiplier = Math.max(atlMultiplier, 1.20);
    const atlTSS = atlMultiplier > 1.0 ? Math.round(weekTSS * atlMultiplier) : weekTSS;

    ctl = ctl * CTL_DECAY + weekTSS * (1 - CTL_DECAY);
    atl = atl * ATL_DECAY + atlTSS * (1 - ATL_DECAY);
    const tsb = ctl - atl;

    results.push({ week: wk.w, ctl, atl, tsb, actualTSS: weekTSS });
  }

  return results;
}
