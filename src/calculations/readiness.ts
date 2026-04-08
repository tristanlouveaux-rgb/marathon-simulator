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
 * Sleep uses Garmin's 0–100 score directly (already population-normalised).
 * HRV and RHR are scored relative to the athlete's 28-day personal baseline.
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

/** Population standard deviation of an array of numbers. Returns 0 for < 2 values. */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Leg load decay ──────────────────────────────────────────────────────────

/** 36-hour half-life exponential decay for leg fatigue signal. */
const LEG_LOAD_K = Math.LN2 / 36;

/** Thresholds for leg load note generation (decayed sum). */
const LEG_LOAD_MODERATE = 20;
const LEG_LOAD_HEAVY = 60;

function computeDecayedLegLoad(
  entries: Array<{ load: number; sport: string; sportLabel: string; timestampMs: number }>,
  nowMs: number,
): { total: number; topEntry: { sportLabel: string; timestampMs: number } | null } {
  const sevenDaysMs = 7 * 24 * 3_600_000;
  const recent = entries.filter(e => nowMs - e.timestampMs < sevenDaysMs);
  if (recent.length === 0) return { total: 0, topEntry: null };

  let total = 0;
  let topDecayed = 0;
  let topEntry: { sportLabel: string; timestampMs: number } | null = null;

  for (const e of recent) {
    const hoursAgo = (nowMs - e.timestampMs) / 3_600_000;
    const decayed = e.load * Math.exp(-LEG_LOAD_K * hoursAgo);
    total += decayed;
    if (decayed > topDecayed) {
      topDecayed = decayed;
      topEntry = { sportLabel: e.sportLabel, timestampMs: e.timestampMs };
    }
  }

  return { total, topEntry };
}

function legLoadTimeframe(timestampMs: number, nowMs: number): string {
  const hoursAgo = (nowMs - timestampMs) / 3_600_000;
  if (hoursAgo < 12)  return 'earlier today';
  if (hoursAgo < 36)  return 'yesterday';
  if (hoursAgo < 60)  return '2 days ago';
  return '3 days ago';
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReadinessLabel = 'Ready to Push' | 'On Track' | 'Manage Load' | 'Ease Back' | 'Overreaching';
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
   * Historical sleep entries — used to find the most recent Garmin sleep score.
   * Each entry needs at least { sleepScore, date }. Compatible with PhysiologyDayEntry[].
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
  /**
   * Pre-computed recovery score (0–100) from computeRecoveryScore (HRV + sleep + RHR composite).
   * When provided, this replaces the internal sleep-only recovery sub-score so that the
   * displayed Recovery metric and the readiness composite use the same value.
   * sleepScore is still used for the sleep safety floors when provided.
   */
  precomputedRecoveryScore?: number | null;
  /**
   * Recent cross-training leg load entries (last 7 days).
   * Each entry has raw load score, sport label, and timestamp.
   * Decayed with 36-hour half-life and summed to produce a current leg fatigue signal.
   */
  recentLegLoads?: Array<{ load: number; sport: string; sportLabel: string; timestampMs: number }>;
  /**
   * Tier-adjusted ACWR safe upper bound from TIER_ACWR_CONFIG.
   * Used for the ACWR hard floor so it matches the Load Ratio card thresholds.
   * Defaults to 1.3 if not provided (beginner-level conservative).
   */
  acwrSafeUpper?: number;
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
  /** Explanatory note for the Load Ratio pill when leg fatigue is elevated. Null when load is negligible. */
  legLoadNote: string | null;
  /** Which hard floor (if any) is actively capping the readiness score. Null when no floor is binding. */
  hardFloor: 'acwr' | 'sleep' | 'hrv' | 'sleepBank' | 'strain' | null;
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
    recentLegLoads,
    precomputedRecoveryScore,
  } = input;

  const nowMs = Date.now();
  const { total: legLoadTotal, topEntry: legLoadTop } = recentLegLoads?.length
    ? computeDecayedLegLoad(recentLegLoads, nowMs)
    : { total: 0, topEntry: null };

  let legLoadNote: string | null = null;
  if (legLoadTotal >= LEG_LOAD_HEAVY && legLoadTop) {
    const tf = legLoadTimeframe(legLoadTop.timestampMs, nowMs);
    legLoadNote = `Leg load elevated from ${legLoadTop.sportLabel} ${tf}. Running today raises impact risk. Shorter, flat effort or rest recommended.`;
  } else if (legLoadTotal >= LEG_LOAD_MODERATE && legLoadTop) {
    const tf = legLoadTimeframe(legLoadTop.timestampMs, nowMs);
    legLoadNote = `Moderate leg load from ${legLoadTop.sportLabel} ${tf}. Impact risk slightly elevated if running.`;
  }

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
      legLoadNote,
      hardFloor: null,
    };
  }

  // ── Sub-signal scores ──────────────────────────────────────────────────────

  // Freshness: daily-equivalent TSB −25 → 0%, +30 → 100%
  // (weekly TSB ÷ 7 for daily; daily −10 ≈ 27, daily −25 = 0)
  const tsbDailyEq = tsb / 7;
  const fitnessScore = clamp(((tsbDailyEq + 25) / 55) * 100, 0, 100);

  // Load Safety: ACWR 2.0 → 0%, ACWR 0.8 → 100%
  const safetyScore = clamp(((2.0 - acwr) / 1.2) * 100, 0, 100);

  // Recovery sub-score: use the pre-computed composite (HRV + sleep + RHR) when provided.
  // This ensures the recovery value feeding into readiness matches what is displayed to the user.
  // Falls back to sleep-only formula when no pre-computed score is available.
  const hasRecovery = precomputedRecoveryScore != null || sleepScore != null || hrvRmssd != null;
  let recoveryScore: number | null = null;
  if (precomputedRecoveryScore != null) {
    recoveryScore = precomputedRecoveryScore;
  } else if (sleepScore != null) {
    // Fallback: relative scoring from sleep history only.
    const hist28 = (sleepHistory ?? []).slice(-28)
      .map(d => d.sleepScore).filter((v): v is number => v != null);
    const hist7 = (sleepHistory ?? []).slice(-7)
      .map(d => d.sleepScore).filter((v): v is number => v != null);

    if (hist28.length >= 3) {
      const baselineAvg = hist28.reduce((a, b) => a + b, 0) / hist28.length;
      const weekAvg = hist7.length > 0
        ? hist7.reduce((a, b) => a + b, 0) / hist7.length
        : baselineAvg;

      const chronicDelta = (weekAvg - baselineAvg) / baselineAvg;
      const chronicScore = clamp(80 + chronicDelta * 175, 0, 100);

      const acuteDelta = (sleepScore - weekAvg) / Math.max(weekAvg, 1);
      const acuteModifier = acuteDelta * (acuteDelta < 0 ? 50 : 20);

      recoveryScore = clamp(chronicScore + acuteModifier, 0, 100);
    } else {
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
  // Track which hard floor is the most restrictive (lowest cap wins).
  // Thresholds are tier-aware: safeUpper from TIER_ACWR_CONFIG, caution = safeUpper + 0.2.
  let hardFloor: 'acwr' | 'sleep' | 'hrv' | 'sleepBank' | 'strain' | null = null;
  const safeUpper = input.acwrSafeUpper ?? 1.3;
  const cautionUpper = safeUpper + 0.2;

  if (acwr > cautionUpper) {
    score = Math.min(score, 39);
    hardFloor = 'acwr';
  } else if (acwr > safeUpper) {
    score = Math.min(score, 59);
    hardFloor = 'acwr';
  }

  // Sleep floor — acute bad night caps readiness regardless of other signals.
  // A good TSB or high fitness doesn't offset genuine sleep deprivation.
  if (sleepScore != null) {
    if (sleepScore < 45 && score > 59)      { score = Math.min(score, 59); hardFloor = 'sleep'; }
    else if (sleepScore < 60 && score > 74) { score = Math.min(score, 74); hardFloor = 'sleep'; }
  }

  // HRV floor — a large acute drop signals autonomic stress that overrides other signals.
  if (hrvRmssd != null && hrvPersonalAvg != null && hrvPersonalAvg > 0) {
    const hrvDropFraction = (hrvPersonalAvg - hrvRmssd) / hrvPersonalAvg;
    if (hrvDropFraction > 0.30 && score > 59)      { score = Math.min(score, 59); hardFloor = 'hrv'; }
    else if (hrvDropFraction > 0.20 && score > 74) { score = Math.min(score, 74); hardFloor = 'hrv'; }
  }

  // Sleep bank floor — 7-night rolling deficit caps readiness.
  // Thresholds recalibrated for 7-night window (≈same avg nightly shortfall as prior 14-night thresholds):
  //   >1.5h (5400s) ≈ 13 min/night avg → cap 74
  //   >2.5h (9000s) ≈ 21 min/night avg → cap 59
  if (sleepBankSec != null && sleepBankSec < 0) {
    if (sleepBankSec < -9000 && score > 59)      { score = Math.min(score, 59); hardFloor = 'sleepBank'; }
    else if (sleepBankSec < -5400 && score > 74) { score = Math.min(score, 74); hardFloor = 'sleepBank'; }
  }

  // Recovery floor — sliding scale so low recovery caps readiness even when fitness/safety are maxed.
  // floor = 40 + (recoveryScore × 0.60): recovery=100 → no cap, recovery=55 → cap 73 (no "Ready to Push"),
  // recovery=38 → cap 63 (On Track at best), recovery=0 → cap 40 (Ease Back boundary).
  if (precomputedRecoveryScore != null) {
    const recoveryFloor = Math.round(40 + precomputedRecoveryScore * 0.60);
    score = Math.min(score, recoveryFloor);
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
    if (strainFloor < score) {
      score = strainFloor;
      hardFloor = 'strain';
    }
  }

  score = Math.round(score);

  // ── Label ──────────────────────────────────────────────────────────────────

  let label: ReadinessLabel;
  if (hardFloor === 'acwr' && acwr > cautionUpper) label = 'Overreaching';
  else if (score >= 80)      label = 'Ready to Push';
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

  // Convert to daily-equivalent for zone classification (Coggan/TrainingPeaks thresholds)
  const tsbDaily = Math.round(tsb / 7);
  const tsbZone: TsbZone = tsbDaily > 0   ? 'fresh'
    : tsbDaily >= -10 ? 'recovering'
    : tsbDaily >= -25 ? 'fatigued'
    :                   'overtrained';

  const acwrZone: AcwrZone = acwr <= safeUpper ? 'safe'
    : acwr <= cautionUpper ? 'moderate'
    :                        'high';

  const sentence = SENTENCES[tsbZone][acwrZone];

  return { score, label, sentence, drivingSignal, fitnessScore, safetyScore, recoveryScore, hasRecovery, legLoadNote, hardFloor };
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

/** CSS colour variable for a readiness label. */
export function readinessColor(label: ReadinessLabel): string {
  if (label === 'Ready to Push') return 'var(--c-ok)';
  if (label === 'On Track')      return 'var(--c-accent)';
  if (label === 'Manage Load')   return 'var(--c-caution)';
  if (label === 'Overreaching')  return 'var(--c-warn)';
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
   * True when the HRV score is computed from the scientifically-grounded SD/z-score method
   * (requires ≥ 10 baseline readings). False = percentage fallback (first ~10 days of use).
   */
  hrvDataSufficient: boolean;
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
 * HRV and RHR are scored relative to the user's 28-day personal baseline. Sleep uses Garmin's score directly.
 * Returns hasData=false when fewer than 3 days of data are available.
 */
export function computeRecoveryScore(
  history: Array<{ sleepScore?: number | null; hrvRmssd?: number | null; restingHR?: number | null; date?: string }>,
  options?: {
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
    hasData: false, dataStale: false, lastSyncDate: null, hrvDataSufficient: false,
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

  // ── Sleep score — use Garmin's score directly ────────────────────────────
  // Garmin's 0–100 sleep score is already absolute and calibrated (sleep stages,
  // duration, HRV, respiration, stress). Unlike HRV/RHR where personal baseline
  // matters (a 40ms RMSSD means different things for different athletes), Garmin's
  // sleep score is already population-normalised: 60 = Fair for everyone.
  // Re-deriving it from chronic/acute relative trends distorts a signal the user
  // already sees in their Garmin app.
  let sleepScore: number | null = null;
  let lastNightSleep: number | null = null;
  let lastNightSleepDate: string | null = null;
  const lastSleepEntry = [...recent].reverse().find(d => d.sleepScore != null);
  if (lastSleepEntry != null) {
    lastNightSleep = lastSleepEntry.sleepScore ?? null;
    lastNightSleepDate = lastSleepEntry.date ?? null;

    // Only use data from last night. If Garmin hasn't synced today's sleep yet,
    // exclude sleep from the composite entirely — stale data is worse than no data.
    const todayDateStr = new Date().toISOString().split('T')[0];
    const isTrulyLastNight = lastNightSleepDate === todayDateStr;
    sleepScore = isTrulyLastNight ? lastNightSleep : null;
  }

  // Manual sleep score bypasses the chronic/acute formula entirely.
  // The user rated their sleep directly — use it as-is.
  if (options?.manualSleepScore != null) {
    sleepScore = clamp(Math.round(options.manualSleepScore), 0, 100);
    lastNightSleep = options.manualSleepScore;
    lastNightSleepDate = new Date().toISOString().split('T')[0];
  }

  // ── HRV score — z-score method (Plews/Flatt/Buchheit) when ≥ 10 baseline readings ──
  // Measures how many personal SDs the 7-day average is from the 28-day baseline.
  // SD-based because a 10ms swing means different things for different athletes.
  // z = (7d avg − 28d avg) / 28d SD → mapped: z=0 → 80 (baseline = ready), z=+1 → 100, z=−2 → 40
  // Fallback (< 10 nights): percentage method used in early days of use.
  const baselineHrvs = baseline.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const recentHrvs   = recent.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  let hrvScore: number | null = null;
  let lastNightHrv: number | null = null;
  let lastNightHrvDate: string | null = null;
  let hrvDataSufficient = false;
  if (baselineHrvs.length >= 3 && recentHrvs.length > 0) {
    const baselineAvg = baselineHrvs.reduce((a, b) => a + b, 0) / baselineHrvs.length;
    const recentAvg   = recentHrvs.reduce((a, b) => a + b, 0) / recentHrvs.length;

    let chronicScore: number;
    if (baselineHrvs.length >= 10) {
      // Science-based: SD z-score. 20 pts per SD → z=0 (baseline) = 80, z=+1 = 100, z=−2 = 40.
      hrvDataSufficient = true;
      const sd = stddev(baselineHrvs);
      const z  = sd > 0 ? (recentAvg - baselineAvg) / sd : 0;
      chronicScore = clamp(80 + z * 20, 0, 100);
    } else {
      // Fallback for first ~10 days: percentage method.
      const chronicDelta = (recentAvg - baselineAvg) / baselineAvg;
      chronicScore = clamp(80 + chronicDelta * 175, 0, 100);
    }

    // Capture last-night HRV for the detail sheet flag — not used in the score.
    // Single-night readings are too noisy (one drink, warm room, sleep position) to
    // modify the composite. The score reflects only the chronic trend (7d vs 28d).
    const lastHrvEntry = [...recent].reverse().find(d => d.hrvRmssd != null && d.hrvRmssd > 0);
    lastNightHrv = lastHrvEntry?.hrvRmssd ?? recentHrvs[recentHrvs.length - 1];
    lastNightHrvDate = lastHrvEntry?.date ?? null;

    hrvScore = clamp(Math.round(chronicScore), 0, 100);
  }

  // ── RHR score — absolute bpm deviation from 28-day baseline ──────────────
  // Lower RHR = better cardiac recovery. Anchored at personal baseline = 80 (ready to train).
  // Uses absolute bpm, not percentage, because research thresholds (Buchheit 2014) are in bpm:
  //   at baseline → 80, −5 bpm below → 105 (clamped 100), +7 bpm above → 45, +13 bpm above → 15
  // Slope of 5 pts/bpm sourced from "+7 bpm above baseline = meaningful concern" (Buchheit 2014).
  const baselineRhrs = baseline.map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  const recentRhrs   = recent.map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  let rhrScore: number | null = null;
  if (baselineRhrs.length >= 3 && recentRhrs.length > 0) {
    const baselineAvg = baselineRhrs.reduce((a, b) => a + b, 0) / baselineRhrs.length;
    const recentAvg   = recentRhrs.reduce((a, b) => a + b, 0) / recentRhrs.length;
    const deltaBpm    = recentAvg - baselineAvg; // positive = elevated (worse)
    rhrScore = clamp(Math.round(80 - deltaBpm * 5), 0, 100);
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
    score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 45 ? 'Fair' : 'Poor';

  return { score, zone, sleepScore, lastNightSleep, lastNightSleepDate, hrvScore, lastNightHrv, lastNightHrvDate, rhrScore, hasData: true, dataStale: false, lastSyncDate, hrvDataSufficient };
}
