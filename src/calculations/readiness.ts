/**
 * Training Readiness — composite 0–100 score.
 *
 * Answers: "Should I do today's specific planned workout as-is?"
 *
 * Four sub-signals:
 *   Fitness Readiness (Freshness)  — TSB                   28% (40% without recovery)
 *   Load Safety                    — ACWR ratio             27% (35% without recovery)
 *   Training Momentum              — CTL trend 4-week       10% (25% without recovery)
 *   Recovery (optional)            — sleep + HRV            35% (excluded when no watch)
 *
 * Sleep is scored RELATIVE to the athlete's 28-day personal baseline (not population norms).
 * 7-day rolling average = chronic signal; last night = acute modifier.
 *
 * SAFETY FLOORS: Hard caps applied regardless of other signals.
 *   ACWR > 1.5           → score ≤ 39 (Ease Back)
 *   ACWR 1.3–1.5         → score ≤ 59 (Manage Load)
 *   Sleep < 45           → score ≤ 59 (Manage Load)
 *   Sleep < 60           → score ≤ 74 (prevents Ready to Push on a bad night)
 *   Sleep bank > 5h debt → score ≤ 59 (Manage Load)
 *   Sleep bank > 3h debt → score ≤ 74 (prevents Ready to Push on chronic deficit)
 *   Strain 50–100%       → floor slides linearly 100→59 (session in progress)
 *   Strain 100–130%      → score ≤ 59 (Manage Load — daily target hit)
 *   Strain > 130%        → score ≤ 39 (Ease Back — well exceeded target)
 *
 * Internal names (ATL/CTL/TSB/ACWR) must NEVER appear in user-facing copy.
 * User-facing names: Freshness, Load Safety, Momentum, Recovery.
 */

import { clamp } from '@/utils/helpers';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReadinessLabel = 'Ready to Push' | 'On Track' | 'Manage Load' | 'Ease Back';
export type DrivingSignal = 'fitness' | 'safety' | 'recovery';

export interface ReadinessInput {
  /** TSB = CTL − ATL. Negative = fatigued, positive = fresh. */
  tsb: number;
  /** ACWR = ATL ÷ CTL. Load Safety signal. */
  acwr: number;
  /** CTL at the current point in the plan (42-day EMA). */
  ctlNow: number;
  /** Sleep score 0–100 from last night (watch/manual). Null = no data. */
  sleepScore?: number | null;
  /**
   * Historical sleep entries for relative scoring (28-day baseline + 7-day rolling avg).
   * Each entry needs at least { sleepScore, date }. Compatible with PhysiologyDayEntry[].
   * When absent or < 3 entries, falls back to using raw sleepScore directly.
   */
  sleepHistory?: Array<{ sleepScore?: number | null; date?: string }>;
  /** HRV RMSSD (ms) from watch. Null = no data. */
  hrvRmssd?: number | null;
  /** Athlete's personal HRV average (ms) — used to compute delta. Null = use sleepScore only. */
  hrvPersonalAvg?: number | null;
  /**
   * 7-day cumulative sleep bank in seconds (sum of actual_sleep − sleep_need per night).
   * Negative = deficit. Applied as a hard floor below the composite score.
   * > 3h deficit → score ≤ 74; > 5h deficit → score ≤ 59.
   */
  sleepBankSec?: number | null;
  /**
   * Number of completed plan weeks with data.
   * < 3 → insufficient history, return safe default "On Track".
   */
  weeksOfHistory?: number;
  /**
   * Today's actual load as a % of the daily target (0–100+).
   * Applied as a gradual floor: hitting target signals the session is done,
   * reducing "readiness for more" accordingly.
   * Null or absent = no activity yet, no effect on score.
   */
  strainPct?: number | null;
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
    tsb, acwr, ctlNow,
    sleepScore, sleepHistory, hrvRmssd, hrvPersonalAvg, sleepBankSec,
    weeksOfHistory = 0,
    strainPct,
  } = input;

  // Edge case: insufficient history → safe default "On Track"
  if (weeksOfHistory < 3) {
    return {
      score: 65,
      label: 'On Track',
      sentence: 'Keep training consistently — your baseline builds over the first 4 weeks.',
      drivingSignal: 'fitness',
      fitnessScore: 65,
      safetyScore: 65,
      recoveryScore: null,
      hasRecovery: false,
    };
  }

  // ── Sub-signal scores ──────────────────────────────────────────────────────

  // Freshness: TSB −40 → 0%, TSB +30 → 100%
  const fitnessScore = clamp(((tsb + 40) / 70) * 100, 0, 100);

  // Load Safety: ACWR 2.0 → 0%, ACWR 0.8 → 100%
  const safetyScore = clamp(((2.0 - acwr) / 1.2) * 100, 0, 100);

  // Recovery: only when real watch data exists — no dummy defaults
  const hasRecovery = sleepScore != null || hrvRmssd != null;
  let recoveryScore: number | null = null;
  if (sleepScore != null) {
    // Relative scoring: personal 28-day baseline = 65 reference point.
    // 7-day rolling avg is the chronic signal; last night is an acute modifier.
    const hist28 = (sleepHistory ?? []).slice(-28)
      .map(d => d.sleepScore).filter((v): v is number => v != null);
    const hist7 = (sleepHistory ?? []).slice(-7)
      .map(d => d.sleepScore).filter((v): v is number => v != null);

    if (hist28.length >= 3) {
      const baselineAvg = hist28.reduce((a, b) => a + b, 0) / hist28.length;
      const weekAvg = hist7.length > 0
        ? hist7.reduce((a, b) => a + b, 0) / hist7.length
        : baselineAvg;

      // Chronic: 7-day avg vs 28-day baseline (+20% → 100, at baseline → 65, −30% → 0)
      const chronicDelta = (weekAvg - baselineAvg) / baselineAvg;
      const chronicScore = clamp(65 + chronicDelta * 175, 0, 100);

      // Acute: last night vs 7-day avg (bad night hurts more than good helps)
      const acuteDelta = (sleepScore - weekAvg) / Math.max(weekAvg, 1);
      const acuteModifier = acuteDelta * (acuteDelta < 0 ? 50 : 20);

      recoveryScore = clamp(chronicScore + acuteModifier, 0, 100);
    } else {
      // Not enough history — use raw score as fallback
      recoveryScore = sleepScore;
    }
  }
  // Single-night HRV is too noisy to modify the composite score (one drink, warm room, etc).
  // A large acute drop acts as a hard floor below (the "flag"), not a continuous modifier.

  // ── Composite score ────────────────────────────────────────────────────────

  let score: number;
  if (hasRecovery && recoveryScore != null) {
    // Fitness 35%, Safety 30%, Recovery 35% — momentum removed (CTL trend ≠ session readiness).
    score = fitnessScore * 0.35 + safetyScore * 0.30 + recoveryScore * 0.35;
  } else {
    score = fitnessScore * 0.55 + safetyScore * 0.45;
  }

  // ── Safety floor ───────────────────────────────────────────────────────────
  // A good sleep doesn't make a load spike safe. ACWR is a hard constraint.
  if (acwr > 1.5)                 score = Math.min(score, 39);
  else if (acwr > 1.3)            score = Math.min(score, 59);

  // Sleep floor — acute bad night caps readiness regardless of other signals.
  // A good TSB or high fitness doesn't offset genuine sleep deprivation.
  if (sleepScore != null) {
    if (sleepScore < 45)      score = Math.min(score, 59);
    else if (sleepScore < 60) score = Math.min(score, 74);
  }

  // HRV floor — a large acute drop signals autonomic stress that overrides other signals.
  if (hrvRmssd != null && hrvPersonalAvg != null && hrvPersonalAvg > 0) {
    const hrvDropFraction = (hrvPersonalAvg - hrvRmssd) / hrvPersonalAvg;
    if (hrvDropFraction > 0.30)      score = Math.min(score, 59);
    else if (hrvDropFraction > 0.20) score = Math.min(score, 74);
  }

  // Sleep bank floor — cumulative 7-day sleep debt caps readiness.
  // A large deficit means adaptation from hard sessions is impaired regardless of last night's score.
  if (sleepBankSec != null && sleepBankSec < 0) {
    if (sleepBankSec < -18000)      score = Math.min(score, 59); // >5h deficit
    else if (sleepBankSec < -10800) score = Math.min(score, 74); // >3h deficit
  }

  // Strain floor — today's accumulated load reduces "readiness for more" as target is approached.
  // 0–50% of target: no effect (early in the day, session not yet complete).
  // 50–100%: linear floor 100→59 (you're getting into the session).
  // 100–130%: floor 59 (hit target — session complete, Manage Load).
  // >130%: floor 39 (well exceeded — Ease Back).
  const sp = strainPct;
  if (sp != null && sp > 50) {
    let strainFloor: number;
    if (sp >= 130)      strainFloor = 39;
    else if (sp >= 100) strainFloor = 59;
    else                strainFloor = Math.round(100 - (sp - 50) * (41 / 50));
    score = Math.min(score, strainFloor);
  }

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

  return { score, label, sentence, drivingSignal, fitnessScore, safetyScore, recoveryScore, hasRecovery };
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
  /** Most recent single-night sleep score (0–100). Used for "Last night: X" display. */
  lastNightSleep: number | null;
  /** ISO date of lastNightSleep entry. */
  lastNightSleepDate: string | null;
  /** HRV score 0–100: chronic trend only (7-day avg vs 28-day baseline). Single-night too noisy. */
  hrvScore: number | null;
  /** Most recent single-night HRV value (ms). Shown as context, not used in score. */
  lastNightHrv: number | null;
  /** ISO date of the lastNightHrv entry, so UI can say "2 nights ago" when stale. */
  lastNightHrvDate: string | null;
  /** RHR score 0–100: lower RHR = better (relative to personal baseline). */
  rhrScore: number | null;
  /** True when enough data to show the composite score. */
  hasData: boolean;
  /**
   * True when history exists but the most recent entry with any recovery data
   * is >3 days old. Score is suppressed; user should sync their watch.
   */
  dataStale: boolean;
  /** ISO date (YYYY-MM-DD) of the most recent entry that had any recovery metric. Null if no history. */
  lastSyncDate: string | null;
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
  options?: {
    /**
     * When true: if the most-recent sleep entry is not from today, treat sleep
     * as unavailable (set sleepScore = null) so it is excluded from the
     * composite and the bar is hidden. Historical entries still contribute to
     * the chronic HRV/RHR baselines. Use when today's Garmin data hasn't
     * arrived yet and no manual sleep has been entered.
     */
    suppressSleepIfNotToday?: boolean;
    /**
     * When set, bypass the chronic/acute formula and use this value directly
     * as the sleep sub-score. Manual entries are explicit 0–100 ratings — the
     * user is saying "my sleep was X/100", not providing a Garmin reading to
     * normalise against their personal baseline. Using the formula would dampen
     * a 23 to ~49 by anchoring on the 7-day chronic average, which is wrong.
     */
    manualSleepScore?: number;
  },
): RecoveryScoreResult {
  const noData: RecoveryScoreResult = {
    score: null, zone: 'Fair', sleepScore: null, lastNightSleep: null, lastNightSleepDate: null,
    hrvScore: null, lastNightHrv: null, lastNightHrvDate: null, rhrScore: null,
    hasData: false, dataStale: false, lastSyncDate: null,
  };

  if (!history || history.length < 3) return noData;

  // ── Staleness gate ────────────────────────────────────────────────────────
  // If the most recent entry with any recovery metric is >3 days old, treat as
  // unavailable — showing a score based on week-old data is actively misleading.
  const todayMs = Date.now();
  const latestWithData = [...history]
    .reverse()
    .find(d => d.sleepScore != null || d.hrvRmssd != null || d.restingHR != null);
  const lastSyncDate = latestWithData?.date ?? null;
  const dataDaysOld = lastSyncDate
    ? Math.floor((todayMs - new Date(lastSyncDate).getTime()) / 86400000)
    : 999;
  if (dataDaysOld > 3) {
    return { ...noData, dataStale: true, lastSyncDate };
  }

  // Use last 7 days for the current score
  const recent = history.slice(-7);
  // Use last 28 days (or all available) as personal baseline
  const baseline = history.slice(-28);

  // ── Sleep score — chronic trend + mild acute modifier ────────────────────
  // Unlike HRV, a single bad night of sleep is a direct, well-established
  // performance impactor (not noise). Acute modifier is mild but real.
  //   Chronic: 7-day avg vs 28-day baseline (+20% → 100, at baseline → 65, −30% → 0)
  //   Acute:   last night vs 7-day avg — ×30 down / ×10 up (asymmetric)
  const baselineSleeps = baseline.map(d => d.sleepScore).filter((v): v is number => v != null);
  const recentSleeps   = recent.map(d => d.sleepScore).filter((v): v is number => v != null);
  let sleepScore: number | null = null;
  let lastNightSleep: number | null = null;
  let lastNightSleepDate: string | null = null;
  if (recentSleeps.length > 0) {
    const weekAvg = recentSleeps.reduce((a, b) => a + b, 0) / recentSleeps.length;
    const lastSleepEntry = [...recent].reverse().find(d => d.sleepScore != null);
    lastNightSleep = lastSleepEntry?.sleepScore ?? null;
    lastNightSleepDate = lastSleepEntry?.date ?? null;

    let chronicScore: number;
    if (baselineSleeps.length >= 3) {
      const baselineAvg = baselineSleeps.reduce((a, b) => a + b, 0) / baselineSleeps.length;
      const chronicDelta = (weekAvg - baselineAvg) / baselineAvg;
      chronicScore = clamp(65 + chronicDelta * 175, 0, 100);
    } else {
      chronicScore = weekAvg; // not enough history — use raw avg
    }

    // Only treat the most-recent entry as an acute modifier when it is genuinely
    // from last night. Garmin dates sleep to the day you woke up, so today's
    // date = last night's sleep. Yesterday's date = two nights ago — it is
    // already priced into the 7-day chronic average and must not be double-counted
    // as an acute signal while we wait for today's entry to arrive.
    const todayDateStr = new Date().toISOString().split('T')[0];
    const isTrulyLastNight = lastNightSleepDate === todayDateStr;

    if (lastNightSleep != null && isTrulyLastNight) {
      const acuteDelta = (lastNightSleep - weekAvg) / Math.max(weekAvg, 1);
      const acuteModifier = acuteDelta * (acuteDelta < 0 ? 30 : 10);
      sleepScore = clamp(Math.round(chronicScore + acuteModifier), 0, 100);
    } else {
      sleepScore = clamp(Math.round(chronicScore), 0, 100);
    }

    // Suppress if today's data is absent and caller requested it.
    // The chronic score would be valid historically but misleading to display
    // as "your sleep score" when we're actually just waiting for Garmin.
    if (options?.suppressSleepIfNotToday && !isTrulyLastNight) {
      sleepScore = null;
    }
  }

  // Manual sleep score bypasses the chronic/acute formula entirely.
  // The user rated their sleep directly — use it as-is.
  if (options?.manualSleepScore != null) {
    sleepScore = clamp(Math.round(options.manualSleepScore), 0, 100);
    lastNightSleep = options.manualSleepScore;
    lastNightSleepDate = new Date().toISOString().split('T')[0];
  }

  // ── HRV score — relative to 28-day personal average, with acute last-night modifier ──
  const baselineHrvs = baseline.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const recentHrvs   = recent.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  let hrvScore: number | null = null;
  let lastNightHrv: number | null = null;
  let lastNightHrvDate: string | null = null;
  if (baselineHrvs.length >= 3 && recentHrvs.length > 0) {
    const baselineAvg = baselineHrvs.reduce((a, b) => a + b, 0) / baselineHrvs.length;
    const recentAvg   = recentHrvs.reduce((a, b) => a + b, 0) / recentHrvs.length;

    // Chronic: 7-day avg vs 28-day baseline (+20% → 100, at baseline → 65, −30% → 0)
    const chronicDelta = (recentAvg - baselineAvg) / baselineAvg;
    const chronicScore = clamp(65 + chronicDelta * 175, 0, 100);

    // Capture last-night HRV for the detail sheet flag — not used in the score.
    // Single-night readings are too noisy (one drink, warm room, sleep position) to
    // modify the composite. The score reflects only the chronic trend (7d vs 28d).
    const lastHrvEntry = [...recent].reverse().find(d => d.hrvRmssd != null && d.hrvRmssd > 0);
    lastNightHrv = lastHrvEntry?.hrvRmssd ?? recentHrvs[recentHrvs.length - 1];
    lastNightHrvDate = lastHrvEntry?.date ?? null;

    hrvScore = clamp(Math.round(chronicScore), 0, 100);
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

  return { score, zone, sleepScore, lastNightSleep, lastNightSleepDate, hrvScore, lastNightHrv, lastNightHrvDate, rhrScore, hasData: true, dataStale: false, lastSyncDate };
}
