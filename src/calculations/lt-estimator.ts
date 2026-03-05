/**
 * LT Pace Estimator — Core estimation engine for automatic LT pace updates.
 *
 * Two estimation methods:
 *   1. Threshold Direct — extract LT from steady-state threshold runs with HR in Z4
 *   2. Cardiac Efficiency Trend — track pace:HR ratio on easy runs over weeks
 *
 * Pure functions, no state mutation.
 */

import type { HRZones } from './heart-rate';
import type { StreamAnalysis } from './stream-processor';

// ─── Types ───────────────────────────────────────────────────────────────

export type LTConfidence = 'high' | 'medium' | 'low';
export type LTEstimateSource = 'threshold_direct' | 'cardiac_efficiency' | 'manual' | 'benchmark';

export interface LTEstimate {
  ltPaceSecPerKm: number;
  confidence: LTConfidence;
  source: LTEstimateSource;
  week: number;
  timestamp: string;
  workoutType?: string;
  details?: string;
}

export interface EfficiencyDataPoint {
  week: number;
  avgPaceSecPerKm: number;
  avgHeartRateBpm: number;
  efficiencyIndex: number;   // pace / hr
  workoutType: string;
}

export interface LTEstimationState {
  estimates: LTEstimate[];
  efficiencyHistory: EfficiencyDataPoint[];
  lastAutoUpdateWeek: number | null;
  latestAutoLT: number | null;
  pendingConfirmation?: {
    estimate: LTEstimate;
    currentLT: number;
    deviationPct: number;
  } | null;
}

// ─── Initialization ──────────────────────────────────────────────────────

export function initLTEstimationState(): LTEstimationState {
  return {
    estimates: [],
    efficiencyHistory: [],
    lastAutoUpdateWeek: null,
    latestAutoLT: null,
    pendingConfirmation: null,
  };
}

// ─── Method 1: Threshold Direct ──────────────────────────────────────────

/**
 * Estimate LT pace from a threshold workout with stream data.
 *
 * Requirements:
 *   - Steady state (paceCV < 0.08)
 *   - HR in Z4 range (±5% tolerance)
 *   - Work segment duration ≥ 15 minutes (900 sec)
 *
 * Returns null if any check fails.
 */
export function estimateFromThresholdRun(
  analysis: StreamAnalysis,
  hrZones: HRZones,
): LTEstimate | null {
  const ws = analysis.workSegment;

  // Check 1: steady state
  if (!analysis.isSteadyState) return null;

  // Check 2: work segment long enough (≥15 min)
  if (ws.durationSec < 900) return null;

  // Check 3: HR in Z4 range with ±5% tolerance
  const z4Min = hrZones.z4.min * 0.95;
  const z4Max = hrZones.z4.max * 1.05;
  if (ws.avgHeartRateBpm < z4Min || ws.avgHeartRateBpm > z4Max) return null;

  return {
    ltPaceSecPerKm: ws.avgPaceSecPerKm,
    confidence: 'high',
    source: 'threshold_direct',
    week: 0,  // Caller sets this
    timestamp: new Date().toISOString(),
    workoutType: 'threshold',
    details: `Steady-state threshold: ${Math.round(ws.avgPaceSecPerKm)}s/km, HR ${Math.round(ws.avgHeartRateBpm)}bpm, CV ${ws.paceCV.toFixed(3)}`,
  };
}

// ─── Method 2: Cardiac Efficiency Trend ──────────────────────────────────

/**
 * Estimate LT pace improvement from efficiency trend on easy/long runs.
 *
 * Requires ≥3 data points from different weeks. Uses linear regression
 * of Cardiac Efficiency Index (pace/HR) over weeks.
 *
 * Improving trend (negative slope = getting faster at same HR) implies
 * proportional LT improvement.
 *
 * Returns null if insufficient data or trend is flat/worsening.
 */
export function estimateFromEfficiencyTrend(
  history: EfficiencyDataPoint[],
  currentLT: number | null,
): LTEstimate | null {
  if (!currentLT || currentLT <= 0) return null;

  // Need ≥3 data points from different weeks
  const uniqueWeeks = new Set(history.map(d => d.week));
  if (uniqueWeeks.size < 3) return null;

  // Average CEI per week (in case of multiple runs per week)
  const weeklyAvg = new Map<number, { sumCEI: number; count: number }>();
  for (const dp of history) {
    const existing = weeklyAvg.get(dp.week) || { sumCEI: 0, count: 0 };
    existing.sumCEI += dp.efficiencyIndex;
    existing.count += 1;
    weeklyAvg.set(dp.week, existing);
  }

  const points: Array<{ week: number; cei: number }> = [];
  for (const [week, { sumCEI, count }] of weeklyAvg) {
    points.push({ week, cei: sumCEI / count });
  }

  if (points.length < 3) return null;

  // Linear regression: cei = slope * week + intercept
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.week, 0);
  const sumY = points.reduce((s, p) => s + p.cei, 0);
  const sumXY = points.reduce((s, p) => s + p.week * p.cei, 0);
  const sumX2 = points.reduce((s, p) => s + p.week * p.week, 0);

  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return null;

  const slope = (n * sumXY - sumX * sumY) / denom;

  // Negative slope = improving (lower CEI = faster at same HR)
  if (slope >= 0) return null; // Not improving — no estimate

  // Compute improvement percentage from slope relative to mean CEI
  const meanCEI = sumY / n;
  if (meanCEI <= 0) return null;

  // Weekly improvement rate
  const weeklyImprovementPct = Math.abs(slope) / meanCEI;

  // Total improvement over the span of weeks observed
  const weeks = Array.from(uniqueWeeks);
  const span = Math.max(...weeks) - Math.min(...weeks);
  const totalImprovementPct = weeklyImprovementPct * span;

  // Require >10% improvement for statistical significance — avoids firing on
  // normal week-to-week CEI variation from terrain, temperature, or hydration.
  if (totalImprovementPct < 0.10) return null;

  // Also require implied change > 1 sec/km (absolute floor)
  const impliedChange = currentLT * totalImprovementPct;
  if (impliedChange < 1) return null;

  const newLT = currentLT * (1 - totalImprovementPct);

  return {
    ltPaceSecPerKm: newLT,
    confidence: 'medium',
    source: 'cardiac_efficiency',
    week: 0, // Caller sets this
    timestamp: new Date().toISOString(),
    details: `CEI trend over ${span} weeks: ${(totalImprovementPct * 100).toFixed(1)}% improvement (slope ${slope.toFixed(4)})`,
  };
}

// ─── Safeguards ──────────────────────────────────────────────────────────

/**
 * Determine whether an LT estimate should be auto-applied.
 *
 * Gates:
 *   - Injury → no
 *   - Already updated this week → no
 *   - >15% deviation from current → needs confirmation
 *   - High/medium confidence → apply
 *   - Low confidence → never auto-apply
 */
export function shouldAutoApply(
  estimate: LTEstimate,
  currentLT: number | null,
  lastAutoUpdateWeek: number | null,
  currentWeek: number,
  isInjured: boolean,
): { apply: boolean; needsConfirmation: boolean; reason: string } {
  // Gate: injury weeks excluded
  if (isInjured) {
    return { apply: false, needsConfirmation: false, reason: 'Injury active — LT auto-update skipped' };
  }

  // Gate: max 1 update per week
  if (lastAutoUpdateWeek !== null && lastAutoUpdateWeek >= currentWeek) {
    return { apply: false, needsConfirmation: false, reason: 'Already auto-updated LT this week' };
  }

  // Gate: low confidence never auto-applies
  if (estimate.confidence === 'low') {
    return { apply: false, needsConfirmation: false, reason: 'Low confidence — stored but not applied' };
  }

  // Gate: >15% deviation → needs confirmation
  if (currentLT && currentLT > 0) {
    const deviation = Math.abs(estimate.ltPaceSecPerKm - currentLT) / currentLT;
    if (deviation > 0.15) {
      return {
        apply: false,
        needsConfirmation: true,
        reason: `LT change of ${(deviation * 100).toFixed(1)}% exceeds 15% — needs confirmation`,
      };
    }
  }

  return { apply: true, needsConfirmation: false, reason: 'Auto-applied' };
}
