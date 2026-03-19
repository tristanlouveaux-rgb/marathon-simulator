/**
 * Training Readiness — composite 0–100 score.
 *
 * Answers: "Should I do today's specific planned workout as-is?"
 *
 * Four sub-signals:
 *   Fitness Readiness (Freshness)  — TSB                   35% (40% without recovery)
 *   Load Safety                    — ACWR ratio             30% (35% without recovery)
 *   Training Momentum              — CTL trend 4-week       15% (25% without recovery)
 *   Recovery (optional)            — sleep + HRV            20% (excluded when no watch)
 *
 * SAFETY FLOOR: High ACWR caps the score regardless of other signals.
 *   ACWR > 1.5 → score ≤ 39 (Ease Back)
 *   ACWR 1.3–1.5 → score ≤ 59 (Manage Load)
 *
 * Internal names (ATL/CTL/TSB/ACWR) must NEVER appear in user-facing copy.
 * User-facing names: Freshness, Load Safety, Momentum, Recovery.
 */

import { clamp } from '@/utils/helpers';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReadinessLabel = 'Ready to Push' | 'On Track' | 'Manage Load' | 'Ease Back';
export type DrivingSignal = 'fitness' | 'safety' | 'momentum' | 'recovery';

export interface ReadinessInput {
  /** TSB = CTL − ATL. Negative = fatigued, positive = fresh. */
  tsb: number;
  /** ACWR = ATL ÷ CTL. Load Safety signal. */
  acwr: number;
  /** CTL at the current point in the plan (42-day EMA). */
  ctlNow: number;
  /** CTL 4 weeks ago — used for Momentum signal. */
  ctlFourWeeksAgo: number;
  /** Sleep score 0–100 from watch/manual. Null = no data. */
  sleepScore?: number | null;
  /** HRV RMSSD (ms) from watch. Null = no data. */
  hrvRmssd?: number | null;
  /** Athlete's personal HRV average (ms) — used to compute delta. Null = use sleepScore only. */
  hrvPersonalAvg?: number | null;
  /**
   * Number of completed plan weeks with data.
   * < 3 → insufficient history, return safe default "On Track".
   */
  weeksOfHistory?: number;
}

export interface ReadinessResult {
  /** Composite score 0–100. */
  score: number;
  /** Bucketed label. */
  label: ReadinessLabel;
  /** One-sentence user-facing summary from the decision matrix. */
  sentence: string;
  /** The sub-signal with the lowest individual score — drives advice card copy. */
  drivingSignal: DrivingSignal;
  /** Freshness sub-score (0–100), derived from TSB. */
  fitnessScore: number;
  /** Load Safety sub-score (0–100), derived from ACWR. */
  safetyScore: number;
  /** Momentum sub-score (0–100), derived from CTL trend. */
  momentumScore: number;
  /** Recovery sub-score (0–100) when watch data is available, null otherwise. */
  recoveryScore: number | null;
  /** True when at least one recovery metric (sleep or HRV) is present. */
  hasRecovery: boolean;
}

// ─── Decision matrix sentences ────────────────────────────────────────────────

type TsbZone = 'fresh' | 'recovering' | 'fatigued' | 'overtrained';
type AcwrZone = 'safe' | 'moderate' | 'high';

const SENTENCES: Record<TsbZone, Record<AcwrZone, string>> = {
  fresh: {
    safe:     "You're rested and safe. Full session.",
    moderate: "Fresh but ramping — stick to the plan.",
    high:     "Sudden spike. Go easy despite feeling fresh.",
  },
  recovering: {
    safe:     "Good balance. Session as planned.",
    moderate: "Training hard. Prioritise sleep tonight.",
    high:     "Back off. Shorten or swap for easy.",
  },
  fatigued: {
    safe:     "Tired but adapted. Easy effort today.",
    moderate: "You need recovery. Reduce today.",
    high:     "Skip or active recovery only.",
  },
  overtrained: {
    safe:     "Deep fatigue. Rest day.",
    moderate: "Rest. Multiple days off recommended.",
    high:     "Rest. Stop until recovered.",
  },
};

// ─── Main export ─────────────────────────────────────────────────────────────

export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const {
    tsb, acwr, ctlNow, ctlFourWeeksAgo,
    sleepScore, hrvRmssd, hrvPersonalAvg,
    weeksOfHistory = 0,
  } = input;

  // Edge case: insufficient history → safe default "On Track"
  if (weeksOfHistory < 3) {
    return {
      score: 65,
      label: 'On Track',
      sentence: 'Keep training consistently — your baseline builds over the first 4 weeks.',
      drivingSignal: 'momentum',
      fitnessScore: 65,
      safetyScore: 65,
      momentumScore: 65,
      recoveryScore: null,
      hasRecovery: false,
    };
  }

  // ── Sub-signal scores ──────────────────────────────────────────────────────

  // Freshness: TSB −40 → 0%, TSB +30 → 100%
  const fitnessScore = clamp(((tsb + 40) / 70) * 100, 0, 100);

  // Load Safety: ACWR 2.0 → 0%, ACWR 0.8 → 100%
  const safetyScore = clamp(((2.0 - acwr) / 1.2) * 100, 0, 100);

  // Momentum: rising CTL = fit, stable = OK, dropping = concerning
  const momentumScore = ctlNow > ctlFourWeeksAgo ? 100
    : ctlNow > ctlFourWeeksAgo * 0.9 ? 65
    : 30;

  // Recovery: only when real watch data exists — no dummy defaults
  const hasRecovery = sleepScore != null || hrvRmssd != null;
  let recoveryScore: number | null = null;
  if (sleepScore != null) {
    recoveryScore = sleepScore; // already 0–100
  }
  if (hrvRmssd != null && hrvPersonalAvg != null && hrvPersonalAvg > 0) {
    const hrvDelta = (hrvRmssd - hrvPersonalAvg) / hrvPersonalAvg;
    recoveryScore = clamp((recoveryScore ?? 50) + hrvDelta * 30, 0, 100);
  }

  // ── Composite score ────────────────────────────────────────────────────────

  let score: number;
  if (hasRecovery && recoveryScore != null) {
    score = fitnessScore * 0.35 + safetyScore * 0.30 + momentumScore * 0.15 + recoveryScore * 0.20;
  } else {
    score = fitnessScore * 0.40 + safetyScore * 0.35 + momentumScore * 0.25;
  }

  // ── Safety floor ───────────────────────────────────────────────────────────
  // A good sleep doesn't make a load spike safe. ACWR is a hard constraint.
  if (acwr > 1.5)                 score = Math.min(score, 39);
  else if (acwr > 1.3)            score = Math.min(score, 59);

  score = Math.round(score);

  // ── Label ──────────────────────────────────────────────────────────────────

  let label: ReadinessLabel;
  if (score >= 80)      label = 'Ready to Push';
  else if (score >= 60) label = 'On Track';
  else if (score >= 40) label = 'Manage Load';
  else                  label = 'Ease Back';

  // ── Driving signal ─────────────────────────────────────────────────────────
  // The sub-metric with the lowest individual score determines the advice copy.

  const signals: { key: DrivingSignal; score: number }[] = [
    { key: 'fitness',  score: fitnessScore },
    { key: 'safety',   score: safetyScore },
    { key: 'momentum', score: momentumScore },
  ];
  if (hasRecovery && recoveryScore != null) {
    signals.push({ key: 'recovery', score: recoveryScore });
  }
  signals.sort((a, b) => a.score - b.score);
  const drivingSignal = signals[0].key;

  // ── Decision matrix sentence ───────────────────────────────────────────────

  const tsbZone: TsbZone = tsb > 0   ? 'fresh'
    : tsb >= -10 ? 'recovering'
    : tsb >= -25 ? 'fatigued'
    :              'overtrained';

  const acwrZone: AcwrZone = acwr <= 1.3 ? 'safe'
    : acwr <= 1.5 ? 'moderate'
    :               'high';

  const sentence = SENTENCES[tsbZone][acwrZone];

  return { score, label, sentence, drivingSignal, fitnessScore, safetyScore, momentumScore, recoveryScore, hasRecovery };
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

/** CSS colour variable for a readiness label. */
export function readinessColor(label: ReadinessLabel): string {
  if (label === 'Ready to Push') return 'var(--c-ok)';
  if (label === 'On Track')      return 'var(--c-accent)';
  if (label === 'Manage Load')   return 'var(--c-caution)';
  return 'var(--c-warn)';
}

/** Short display string for each driving signal's pill label. */
export function drivingSignalLabel(signal: DrivingSignal): string {
  if (signal === 'fitness')  return 'Freshness is low';
  if (signal === 'safety')   return 'Load spike';
  if (signal === 'momentum') return 'Fitness dropping';
  return 'Poor recovery';
}

// ─── Recovery Trend Multiplier ───────────────────────────────────────────────

/**
 * Compute a recovery trend multiplier for excess-load reduction sizing.
 *
 * Uses computeRecoveryScore over the last `days` days. Poor recovery = larger
 * reduction recommended. Returns 1.0 when no data is available (graceful degradation).
 *
 * Multiplier table (from LOAD_BUDGET_SPEC §6):
 *   ≥ 70 → 1.00  (normal)
 *   50–69 → 1.15  (mildly suppressed)
 *   30–49 → 1.30  (poor recovery)
 *   < 30  → 1.50  (serious deficit)
 */
export function computeRecoveryTrend(
  history: Array<{ sleepScore?: number | null; hrvRmssd?: number | null; restingHR?: number | null; date?: string }>,
): number {
  // Pass the full history so computeRecoveryScore has its 28-day baseline window.
  // Slicing to 5 days first breaks HRV and RHR scores — both baseline and recent
  // would be the same 5 entries, producing a delta of ~0 and always scoring ~65.
  const result = computeRecoveryScore(history);
  if (!result.hasData || result.score == null) return 1.0;
  const s = result.score;
  if (s >= 70) return 1.00;
  if (s >= 50) return 1.15;
  if (s >= 30) return 1.30;
  return 1.50;
}

// ─── Recovery Score (Stats Recovery card) ────────────────────────────────────

export interface RecoveryScoreResult {
  /** Composite 0–100. Null when insufficient data (<3 days). */
  score: number | null;
  /** Zone label for the position bar. */
  zone: 'Poor' | 'Fair' | 'Good' | 'Excellent';
  /** Individual metric scores 0–100. Null when metric unavailable. */
  sleepScore: number | null;
  /** HRV score 0–100: relative to user's 28-day personal baseline. */
  hrvScore: number | null;
  /** RHR score 0–100: lower RHR = better (relative to personal baseline). */
  rhrScore: number | null;
  /** True when enough data to show the composite score. */
  hasData: boolean;
}

/**
 * Compute a recovery score from physiologyHistory entries.
 *
 * Weights (provisional — tune with real data):
 *   HRV: 45%  (primary — strongest autonomic recovery signal per sports science)
 *   Sleep: 35%  (context + quality gate)
 *   RHR: 20%  (secondary — noisier day-to-day)
 *
 * All scores are relative to the user's own 28-day baseline, not population norms.
 * Returns hasData=false when fewer than 3 days of data are available.
 */
export function computeRecoveryScore(
  history: Array<{ sleepScore?: number | null; hrvRmssd?: number | null; restingHR?: number | null; date?: string }>,
): RecoveryScoreResult {
  const noData: RecoveryScoreResult = {
    score: null, zone: 'Fair', sleepScore: null, hrvScore: null, rhrScore: null, hasData: false,
  };

  if (!history || history.length < 3) return noData;

  // Use last 7 days for the current score
  const recent = history.slice(-7);
  // Use last 28 days (or all available) as personal baseline
  const baseline = history.slice(-28);

  // ── Sleep score ──────────────────────────────────────────────────────────
  const recentSleeps = recent.map(d => d.sleepScore).filter((v): v is number => v != null);
  const sleepScore = recentSleeps.length > 0
    ? Math.round(recentSleeps.reduce((a, b) => a + b, 0) / recentSleeps.length)
    : null;

  // ── HRV score — relative to 28-day personal average ─────────────────────
  const baselineHrvs = baseline.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const recentHrvs   = recent.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  let hrvScore: number | null = null;
  if (baselineHrvs.length >= 3 && recentHrvs.length > 0) {
    const baselineAvg = baselineHrvs.reduce((a, b) => a + b, 0) / baselineHrvs.length;
    const recentAvg   = recentHrvs.reduce((a, b) => a + b, 0) / recentHrvs.length;
    // +20% above baseline = 100, at baseline = 65, -30% below = 0
    const delta = (recentAvg - baselineAvg) / baselineAvg;
    hrvScore = clamp(Math.round(65 + delta * 175), 0, 100);
  }

  // ── RHR score — inverted (lower = better), relative to 28-day baseline ──
  const baselineRhrs = baseline.map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  const recentRhrs   = recent.map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  let rhrScore: number | null = null;
  if (baselineRhrs.length >= 3 && recentRhrs.length > 0) {
    const baselineAvg = baselineRhrs.reduce((a, b) => a + b, 0) / baselineRhrs.length;
    const recentAvg   = recentRhrs.reduce((a, b) => a + b, 0) / recentRhrs.length;
    // Lower RHR = better: -5 bpm vs baseline = 100, at baseline = 65, +10 bpm = 0
    const delta = (baselineAvg - recentAvg) / baselineAvg;
    rhrScore = clamp(Math.round(65 + delta * 350), 0, 100);
  }

  // ── Composite — require at least one metric ───────────────────────────────
  const hasHrv   = hrvScore != null;
  const hasSleep = sleepScore != null;
  const hasRhr   = rhrScore != null;
  if (!hasHrv && !hasSleep && !hasRhr) return noData;

  // Apply weights only to available signals, renormalised
  let totalWeight = 0;
  let weightedSum = 0;
  if (hasHrv)   { weightedSum += hrvScore!   * 0.45; totalWeight += 0.45; }
  if (hasSleep) { weightedSum += sleepScore! * 0.35; totalWeight += 0.35; }
  if (hasRhr)   { weightedSum += rhrScore!   * 0.20; totalWeight += 0.20; }

  const score = Math.round(weightedSum / totalWeight);
  const zone: RecoveryScoreResult['zone'] =
    score >= 75 ? 'Excellent' : score >= 55 ? 'Good' : score >= 35 ? 'Fair' : 'Poor';

  return { score, zone, sleepScore, hrvScore, rhrScore, hasData: true };
}
