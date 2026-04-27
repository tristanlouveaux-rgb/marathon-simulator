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
 *   Sleep < 60           → score ≤ 74 (prevents Primed on a bad night)
 *   Sleep bank > 5h debt → score ≤ 59 (Manage Load)
 *   Sleep bank > 3h debt → score ≤ 74 (prevents Primed on chronic deficit)
 *   Strain 50–100%       → floor slides linearly 100→59 (session in progress)
 *   Strain 100–130%      → score ≤ 59 (Manage Load — daily target hit)
 *   Strain > 130%        → score ≤ 39 (Ease Back — well exceeded target)
 *   Leg load >= 20       → score ≤ 54 (Manage Load — moderate eccentric/impact damage)
 *   Leg load >= 60       → score ≤ 34 (Ease Back — heavy EIMD, 72-96h recovery window)
 *
 * Internal names (ATL/CTL/TSB/ACWR) must NEVER appear in user-facing copy.
 * User-facing names: Freshness, Load Safety, Momentum, Recovery.
 */

import { clamp } from '@/utils/helpers';
import { SPORTS_DB } from '@/constants/sports';

/** Population standard deviation of an array of numbers. Returns 0 for < 2 values. */
function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Leg load decay ──────────────────────────────────────────────────────────

/**
 * Base half-life for leg fatigue decay: 48 hours.
 *
 * Basis: Clarkson & Hubal 2002 — functional force-absorption recovery from
 * eccentric loading takes 72-168h. 48h half-life → ~95% clearance in 4 half-lives
 * (~8 days), which envelopes that range. Sport-specific: scaled by recoveryMult
 * from SPORTS_DB (hiking 0.95x ≈ 46h, rugby 1.30x ≈ 62h).
 */
const LEG_LOAD_BASE_HALFLIFE_H = 48;

/**
 * Thresholds for leg load callout + readiness floor (decayed sum).
 *
 * NOTE: these are PRAGMATIC PRODUCT BANDS, not calibrated against tissue metrics
 * (CK, MVC decrement, soreness VAS). Expressed in units of sport-weighted minutes
 * (see SPORTS_DB.legLoadPerMin × duration). Defensible as reasonable cut-offs for
 * "mild deficit" / "functional deficit", not as derived constants.
 */
export const LEG_LOAD_MODERATE = 20;
export const LEG_LOAD_HEAVY = 60;

/**
 * Repeated Bout Effect (RBE) — McHugh 2003; Nosaka & Clarkson 1995; Nosaka & Aoki 2011.
 *
 * A prior bout of the same (or biomechanically similar) eccentric stimulus within
 * ~2 weeks confers protection: the second bout produces 40-60% less damage (CK
 * rise, MVC decrement, DOMS) than the first. Protection fades over 2-6 weeks.
 *
 * We apply this as an entry-time DISCOUNT on the raw load contribution, not a
 * clearance penalty. Same sport within RBE_WINDOW_H gets RBE_DISCOUNT applied
 * (conservative end of the 0.4-0.6 attenuation range). First-in-window bout is
 * unprotected (full load). Protection is stimulus-specific, so we key on sport
 * identity — hiking does not protect against skiing.
 *
 * Replaces the previous 1.3× reload-clearance penalty (2026-04-17), which was
 * scientifically backwards: that treated repeated same-sport bouts as slowing
 * recovery, when RBE says the opposite.
 */
const RBE_DISCOUNT = 0.6;
const RBE_WINDOW_H = 14 * 24;

export interface LegLoadEntryDecayed {
  sport: string;
  sportLabel: string;
  timestampMs: number;
  rawLoad: number;
  decayedLoad: number;
  halfLifeH: number;
  /** True if the raw load was discounted at entry-time by RBE (same-sport prior bout within 14d). */
  rbeProtected: boolean;
}

/**
 * Apply the Repeated Bout Effect discount to a new leg-load entry. Returns the
 * effective raw load that should be stored. If a prior entry of the same sport
 * exists within RBE_WINDOW_H of the given timestamp, the load is multiplied by
 * RBE_DISCOUNT. First bout in the window is unprotected.
 *
 * Call this at the write site (recordLegLoad, reclassify, reconcile) so the
 * discount is baked into the stored value and persists even after the protective
 * prior bout ages out of the 7-day cache.
 */
export function applyRbeDiscount(
  sport: string,
  timestampMs: number,
  rawLoad: number,
  priorEntries: Array<{ sport: string; timestampMs: number }>,
): { load: number; protected: boolean } {
  for (const p of priorEntries) {
    if (p.sport !== sport) continue;
    const gapH = (timestampMs - p.timestampMs) / 3_600_000;
    if (gapH > 0 && gapH <= RBE_WINDOW_H) {
      return { load: rawLoad * RBE_DISCOUNT, protected: true };
    }
  }
  return { load: rawLoad, protected: false };
}

export interface LegLoadBreakdown {
  total: number;
  topEntry: { sportLabel: string; timestampMs: number } | null;
  entries: LegLoadEntryDecayed[];
}

export function computeLegLoadBreakdown(
  entries: Array<{ load: number; sport: string; sportLabel: string; timestampMs: number }>,
  nowMs: number,
): LegLoadBreakdown {
  const sevenDaysMs = 7 * 24 * 3_600_000;
  const recent = entries
    .filter(e => nowMs - e.timestampMs < sevenDaysMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (recent.length === 0) return { total: 0, topEntry: null, entries: [] };

  let total = 0;
  let topDecayed = 0;
  let topEntry: { sportLabel: string; timestampMs: number } | null = null;
  const out: LegLoadEntryDecayed[] = [];

  for (let i = 0; i < recent.length; i++) {
    const e = recent[i];
    const hoursAgo = (nowMs - e.timestampMs) / 3_600_000;
    const sportConfig = SPORTS_DB[e.sport as keyof typeof SPORTS_DB];
    const recovMult = sportConfig?.recoveryMult ?? 1.0;
    const halfLife = LEG_LOAD_BASE_HALFLIFE_H * recovMult;

    // RBE-protected entries are discounted at write-time; `e.load` is already the
    // effective load. `rbeProtected` lives on the stored entry (see SimulatorState).
    const k = Math.LN2 / halfLife;
    const decayed = e.load * Math.exp(-k * hoursAgo);
    total += decayed;
    if (decayed > topDecayed) {
      topDecayed = decayed;
      topEntry = { sportLabel: e.sportLabel, timestampMs: e.timestampMs };
    }
    out.push({
      sport: e.sport,
      sportLabel: e.sportLabel,
      timestampMs: e.timestampMs,
      rawLoad: e.load,
      decayedLoad: decayed,
      halfLifeH: halfLife,
      rbeProtected: (e as { rbeProtected?: boolean }).rbeProtected === true,
    });
  }

  return { total, topEntry, entries: out };
}

function computeDecayedLegLoad(
  entries: Array<{ load: number; sport: string; sportLabel: string; timestampMs: number }>,
  nowMs: number,
): { total: number; topEntry: { sportLabel: string; timestampMs: number } | null } {
  const b = computeLegLoadBreakdown(entries, nowMs);
  return { total: b.total, topEntry: b.topEntry };
}

function legLoadTimeframe(timestampMs: number, nowMs: number): string {
  const hoursAgo = (nowMs - timestampMs) / 3_600_000;
  if (hoursAgo < 12)  return 'earlier today';
  if (hoursAgo < 36)  return 'yesterday';
  if (hoursAgo < 60)  return '2 days ago';
  return '3 days ago';
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ReadinessLabel = 'Primed' | 'On Track' | 'Manage Load' | 'Ease Back' | 'Overreaching';
export type DrivingSignal = 'fitness' | 'safety' | 'recovery' | 'legLoad';

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
  /** Decayed leg load sum (0+). 0 = fresh. >= LEG_LOAD_MODERATE caps readiness; >= LEG_LOAD_HEAVY hard caps. */
  legLoadTotal: number;
  /** Which hard floor (if any) is actively capping the readiness score. Null when no floor is binding. */
  hardFloor: 'acwr' | 'sleep' | 'hrv' | 'sleepBank' | 'strain' | 'legLoad' | null;
  /**
   * How many consecutive days the active sleep-related floor has been suppressing the score.
   * Only set for sleep/sleepBank floors with ≥ 2 days. Null otherwise.
   */
  suppressStreak: number | null;
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
      legLoadTotal,
      hardFloor: null,
      suppressStreak: null,
    };
  }

  // Tier-aware ACWR threshold (used in both sub-score and hard floors)
  const safeUpper = input.acwrSafeUpper ?? 1.3;
  const cautionUpper = safeUpper + 0.2;

  // ── Sub-signal scores (non-linear mapping) ─────────────────────────────────
  //
  // Each sub-score uses a power curve that's gentle in the safe zone and
  // accelerates the penalty in the danger zone. This reflects the underlying
  // physiology: injury risk (Gabbett 2016), sleep deprivation effects (Van Dongen
  // 2003), and overtraining markers all show non-linear, accelerating risk curves.
  //
  // Method: compute a linear 0-1 fraction, then apply pow(fraction, exponent).
  // Exponent < 1 = concave curve (gentle at the bottom, aggressive at the top).
  // Exponent > 1 = convex curve (gentle at the top, aggressive at the bottom).
  // We want scores to drop faster as signals worsen → convex → exponent > 1.

  // Freshness: daily-equivalent TSB −25 → 0%, +30 → 100%
  // Exponent 1.2: mild non-linearity. Fresh end stays comfortable, fatigued end
  // drops slightly faster than linear. TSB is not as exponentially risky as ACWR —
  // negative TSB is normal during training blocks — so the curve is gentler.
  // TSB daily 0 → 39% (was 45 linear). TSB daily -10 → 21% (was 27 linear).
  const tsbDailyEq = tsb / 7;
  const fitnessFrac = clamp((tsbDailyEq + 25) / 55, 0, 1);
  const fitnessScore = Math.pow(fitnessFrac, 1.2) * 100;

  // Load Safety — tier-aware, non-linear.
  // Anchored to athlete's personal safeUpper: score hits 0 at safeUpper + 0.6,
  // hits 100 at safeUpper - 0.6. This means the same ACWR produces different
  // scores for different tiers: ACWR 1.35 is comfortable for elite (safeUpper 1.5)
  // but alarming for a beginner (safeUpper 1.3).
  // Exponent 1.6: matches Gabbett's finding that injury risk accelerates
  // exponentially above the safe zone.
  const safetyFrac = clamp((safeUpper + 0.6 - acwr) / 1.2, 0, 1);
  const safetyScore = Math.pow(safetyFrac, 1.6) * 100;

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

  // ── Sleep cap — decays with bad nights, recovers symmetrically ────────────
  // Walk up to 14 nights of history (oldest → newest), then apply today.
  // Bad night (score < threshold): cap -= STEP, floored at MIN.
  // Good night (score >= threshold): cap += STEP, ceilinged at MAX.
  // Today is applied separately (sleepScore input covers both Garmin + manual).
  // History is excluded for today's date to avoid double-counting.
  const SLEEP_CAP_THRESHOLD = 65;   // below this = bad night
  const SLEEP_CAP_MAX = 54;         // starting cap (no recent bad sleep)
  const SLEEP_CAP_MIN = 34;         // floor — Ease Back boundary after ~11 bad nights
  const SLEEP_CAP_STEP = 2;         // pts per night, same rate both directions (symmetric)

  const todayIso = new Date().toISOString().slice(0, 10);
  const historyExclToday = [...(sleepHistory ?? [])]
    .filter(e => e.date != null && e.date !== todayIso && e.sleepScore != null)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    .slice(-14);

  let effectiveSleepCap = SLEEP_CAP_MAX;
  for (const entry of historyExclToday) {
    effectiveSleepCap = (entry.sleepScore ?? 100) < SLEEP_CAP_THRESHOLD
      ? Math.max(SLEEP_CAP_MIN, effectiveSleepCap - SLEEP_CAP_STEP)
      : Math.min(SLEEP_CAP_MAX, effectiveSleepCap + SLEEP_CAP_STEP);
  }
  if (sleepScore != null) {
    effectiveSleepCap = sleepScore < SLEEP_CAP_THRESHOLD
      ? Math.max(SLEEP_CAP_MIN, effectiveSleepCap - SLEEP_CAP_STEP)
      : Math.min(SLEEP_CAP_MAX, effectiveSleepCap + SLEEP_CAP_STEP);
  }

  // Streak for annotation — consecutive bad nights ending today (desc walk).
  let sleepStreak = (sleepScore != null && sleepScore < SLEEP_CAP_THRESHOLD) ? 1 : 0;
  if (sleepStreak > 0) {
    const sortedDesc = [...historyExclToday].reverse();
    for (const entry of sortedDesc) {
      if ((entry.sleepScore ?? 100) < SLEEP_CAP_THRESHOLD) sleepStreak++;
      else break;
    }
  }

  // ── Safety floor ───────────────────────────────────────────────────────────
  // A good sleep doesn't make a load spike safe. ACWR is a hard constraint.
  // Track which hard floor is the most restrictive (lowest cap wins).
  // Thresholds are tier-aware: safeUpper from TIER_ACWR_CONFIG, caution = safeUpper + 0.2.
  let hardFloor: 'acwr' | 'sleep' | 'hrv' | 'sleepBank' | 'strain' | 'legLoad' | null = null;

  // ── Hard floors — recalibrated for non-linear sub-scores ─────────────────
  // Label boundaries: Primed >= 75, On Track >= 55, Manage Load >= 35, Ease Back < 35.
  // Old caps (59/74/39) mapped to old boundaries (60/80/40).
  // New caps: 54 = top of Manage Load, 74 = just below Primed, 34 = top of Ease Back.

  if (acwr > cautionUpper) {
    score = Math.min(score, 34);
    hardFloor = 'acwr';
  } else if (acwr > safeUpper) {
    score = Math.min(score, 54);
    hardFloor = 'acwr';
  }

  // Sleep floor — severe bad night (< 45) caps at effectiveSleepCap (decays/recovers over time).
  // Moderate bad night (45–60) keeps fixed 74 cap — decay only applies to the severe tier.
  if (sleepScore != null) {
    if (sleepScore < 45 && score > effectiveSleepCap) { score = Math.min(score, effectiveSleepCap); hardFloor = 'sleep'; }
    else if (sleepScore < 60 && score > 74)           { score = Math.min(score, 74); hardFloor = 'sleep'; }
  }

  // HRV floor — a large acute drop signals autonomic stress that overrides other signals.
  if (hrvRmssd != null && hrvPersonalAvg != null && hrvPersonalAvg > 0) {
    const hrvDropFraction = (hrvPersonalAvg - hrvRmssd) / hrvPersonalAvg;
    if (hrvDropFraction > 0.30 && score > 54)      { score = Math.min(score, 54); hardFloor = 'hrv'; }
    else if (hrvDropFraction > 0.20 && score > 74) { score = Math.min(score, 74); hardFloor = 'hrv'; }
  }

  // Sleep bank floor — fixed 54 cap (independent of consecutive-night decay).
  // sleepBank is accumulated debt, not a streak signal — keep them separate.
  if (sleepBankSec != null && sleepBankSec < 0) {
    if (sleepBankSec < -9000 && score > SLEEP_CAP_MAX) { score = Math.min(score, SLEEP_CAP_MAX); hardFloor = 'sleepBank'; }
    else if (sleepBankSec < -5400 && score > 74)        { score = Math.min(score, 74); hardFloor = 'sleepBank'; }
  }

  // Recovery floor — sliding scale so low recovery caps readiness even when fitness/safety are maxed.
  // floor = 35 + (recoveryScore × 0.60): recovery=100 → no cap, recovery=55 → cap 68 (On Track),
  // recovery=33 → cap 55 (On Track boundary), recovery=0 → cap 35 (Ease Back boundary).
  if (precomputedRecoveryScore != null) {
    const recoveryFloor = Math.round(35 + precomputedRecoveryScore * 0.60);
    score = Math.min(score, recoveryFloor);
  }

  // Strain floor — today's accumulated load reduces "readiness for more" as target is approached.
  // 50-100%: linear floor 100→54 (approaching target).
  // 100-130%: floor 54 (hit target, Manage Load).
  // >130%: floor 34 (well exceeded, Ease Back).
  const sp = strainPct;
  if (sp != null && sp > 50) {
    let strainFloor: number;
    if (sp >= 130)      strainFloor = 34;
    else if (sp >= 100) strainFloor = 54;
    else                strainFloor = Math.round(100 - (sp - 50) * (46 / 50));
    if (strainFloor < score) {
      score = strainFloor;
      hardFloor = 'strain';
    }
  }

  // Leg load floor — localised muscle/impact damage from cross-training caps readiness.
  // Heavy (>=60): 72-96h functional deficit window (Clarkson & Hubal 2002; Paulsen 2012).
  // Force absorption is impaired, gait alters, impact tissues take more load. Cap at Ease Back.
  // Moderate (>=20): mild deficit, training through is fine but not at full intensity. Cap at Manage Load.
  // Soft taper (10-20): linear onset so crossing 20 isn't a cliff. No hardFloor (no callout).
  // Precedence: each branch checks `score > cap` so a stricter prior floor (ACWR, sleep) is
  // never overwritten — legLoad only wins when it is the strictest constraint.
  if (legLoadTotal >= LEG_LOAD_HEAVY && score > 34) {
    score = 34;
    hardFloor = 'legLoad';
  } else if (legLoadTotal >= LEG_LOAD_MODERATE && score > 54) {
    score = 54;
    hardFloor = 'legLoad';
  } else if (legLoadTotal >= 10 && legLoadTotal < LEG_LOAD_MODERATE) {
    // Soft penalty: 10 → cap 100, 20 → cap 54. Linear interpolation.
    const softCap = Math.round(100 - (legLoadTotal - 10) * 4.6);
    if (softCap < score) score = softCap;
  }

  score = Math.round(score);

  // ── Label ──────────────────────────────────────────────────────────────────

  let label: ReadinessLabel;
  if (hardFloor === 'acwr' && acwr > cautionUpper) label = 'Overreaching';
  else if (score >= 75)      label = 'Primed';
  else if (score >= 55) label = 'On Track';
  else if (score >= 35) label = 'Manage Load';
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
  // When leg fatigue is the active hard floor, it is the driving signal — the cap
  // the user needs to address, even if another sub-score happens to be lower.
  const drivingSignal: DrivingSignal = hardFloor === 'legLoad' ? 'legLoad' : signals[0].key;

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

  const suppressStreak = (hardFloor === 'sleep' || hardFloor === 'sleepBank') && sleepStreak >= 2
    ? sleepStreak
    : null;

  return { score, label, sentence, drivingSignal, fitnessScore, safetyScore, recoveryScore, hasRecovery, legLoadNote, legLoadTotal, hardFloor, suppressStreak };
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

/** CSS colour variable for a readiness label. */
export function readinessColor(label: ReadinessLabel): string {
  if (label === 'Primed')        return 'var(--c-ok)';
  if (label === 'On Track')      return 'var(--c-info)';
  if (label === 'Manage Load')   return 'var(--c-caution)';
  return 'var(--c-warn)';
}

/** Short display string for each driving signal's pill label. */
export function drivingSignalLabel(signal: DrivingSignal): string {
  if (signal === 'fitness')  return 'Freshness is low';
  if (signal === 'safety')   return 'Load spike';
  if (signal === 'legLoad')  return 'Leg fatigue';
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
  /** Non-null when RHR is elevated ≥2 SD above baseline, triggering a score cap. */
  rhrOverride: { deviationSD: number; cap: number } | null;
  /** Sleep history z-score 0–100: 7d avg vs 28d baseline, personal z-score method. Used in composite. */
  sleepHistoryScore: number | null;
  /** Raw 7-day average of sleep scores. Displayed on the Sleep History ring (user-recognisable). */
  sleepHistoryAvg: number | null;
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
 * Composite: HRV 50% + Last Night Sleep 25% + Sleep History 25%
 * (renormalised when one or more signals are missing).
 * RHR is NOT a weighted input — it acts as a graduated hard floor when
 * elevated >= 2 SD above personal baseline (caps at 55/40/25 by severity).
 * Rationale: RHR has high specificity but low sensitivity (Buchheit 2014);
 * weighting it continuously adds noise from caffeine/heat/hydration.
 *
 * Both sleep signals are z-scored against the user's 28-day personal baseline
 * for composite weighting (handles Garmin's compressed 30-95 range), but the
 * raw scores are returned for display so the user sees values matching their watch.
 * Returns hasData=false when fewer than 3 days of data are available.
 */
export function computeRecoveryScore(
  history: Array<{ sleepScore?: number | null; hrvRmssd?: number | null; restingHR?: number | null; date?: string; sleepDurationSec?: number | null }>,
  options?: {
    /**
     * When set, bypass the chronic/acute formula and use this value directly
     * as the sleep sub-score. Manual entries are explicit 0–100 ratings — the
     * user is saying "my sleep was X/100", not providing a Garmin reading to
     * normalise against their personal baseline. Using the formula would dampen
     * a 23 to ~49 by anchoring on the 7-day chronic average, which is wrong.
     */
    manualSleepScore?: number;
    /**
     * Cumulative sleep debt in seconds (from computeSleepDebt).
     * When provided, depresses the sleep history sub-score proportionally.
     * This connects the physiology composite with the readiness sleep debt signal.
     */
    sleepDebtSec?: number;
  },
): RecoveryScoreResult {
  const noData: RecoveryScoreResult = {
    score: null, zone: 'Fair', sleepScore: null, lastNightSleep: null, lastNightSleepDate: null,
    hrvScore: null, lastNightHrv: null, lastNightHrvDate: null, rhrScore: null, rhrOverride: null,
    sleepHistoryScore: null, sleepHistoryAvg: null,
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

    // Accept sleep from today or yesterday. Garmin records sleep under the date
    // you fell asleep (e.g. night of April 11 → calendar_date April 11), so on
    // April 12 morning the most recent sleep entry is yesterday's date. Requiring
    // today's date excluded sleep from the composite almost every morning.
    const todayDate = new Date();
    const todayDateStr = todayDate.toISOString().split('T')[0];
    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterdayDateStr = yesterdayDate.toISOString().split('T')[0];
    const isRecent = lastNightSleepDate === todayDateStr || lastNightSleepDate === yesterdayDateStr;
    sleepScore = isRecent ? lastNightSleep : null;
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

  // ── RHR — SD-based override (not a weighted input) ──────────────────────
  // RHR is a high-specificity, low-sensitivity signal (Buchheit 2014). Rather than
  // weighting it continuously (where noise from caffeine/heat drags the score around),
  // it acts as a graduated hard floor when elevated ≥2 SD above personal baseline.
  // This plays to its strength: when RHR is genuinely elevated, something is wrong.
  const baselineRhrs = baseline.map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  const recentRhrs   = recent.map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  let rhrScore: number | null = null;
  let rhrOverride: { deviationSD: number; cap: number } | null = null;
  if (baselineRhrs.length >= 3 && recentRhrs.length > 0) {
    const baselineAvg = baselineRhrs.reduce((a, b) => a + b, 0) / baselineRhrs.length;
    const recentAvg   = recentRhrs.reduce((a, b) => a + b, 0) / recentRhrs.length;
    const deltaBpm    = recentAvg - baselineAvg; // positive = elevated (worse)
    // Keep rhrScore for display/detail view (same 0-100 scale as before)
    rhrScore = clamp(Math.round(80 - deltaBpm * 5), 0, 100);

    // Graduated override: SD-based detection of genuinely elevated RHR
    const rhrSD = stddev(baselineRhrs);
    if (rhrSD > 0) {
      const deviationSD = deltaBpm / rhrSD;
      if (deviationSD >= 3.0) {
        rhrOverride = { deviationSD, cap: 25 };       // severe: illness/overtraining
      } else if (deviationSD >= 2.5) {
        rhrOverride = { deviationSD, cap: 40 };       // strong: triggers load reduction
      } else if (deviationSD >= 2.0) {
        rhrOverride = { deviationSD, cap: 55 };       // mild: caps at Fair zone
      }
    }
  }

  // ── Sleep History — 14d rolling avg, debt-adjusted ─────────────────────────
  // Chronic sleep restriction has cumulative effects (Van Dongen 2003, Halson 2014).
  // 14-day window matches the effective range of sleep debt (half-life 7d, so 14d
  // captures ~93% of the signal). Unlike HRV, Garmin/Apple sleep scores are already
  // population-normalised, so we use raw scores directly.
  // When sleep debt is provided, it depresses the history score proportionally —
  // this connects physiology with the readiness sleep debt signal so they tell
  // the same story. 1h debt = ~3pt penalty, scaling linearly.
  const last14 = history.slice(-14);
  const recentSleeps = last14.map(d => d.sleepScore).filter((v): v is number => v != null && v > 0);
  let sleepHistoryScore: number | null = null;
  let sleepHistoryAvg: number | null = null;

  if (recentSleeps.length >= 3) {
    sleepHistoryAvg = Math.round(recentSleeps.reduce((a, b) => a + b, 0) / recentSleeps.length);
    // Depress by sleep debt: each hour of debt reduces history score by ~3 points.
    // 5.5h debt → -16pts. Keeps the ring and composite aligned with readiness messaging.
    // Linear 3pt/hour, capped at -25pts (~8.3h debt). Cognitive deficits accumulate
    // roughly linearly with sleep restriction (Van Dongen 2003), but beyond ~8h of debt
    // the athlete is already in the danger zone — further debt adds little signal.
    const debtPenalty = options?.sleepDebtSec != null && options.sleepDebtSec > 0
      ? Math.min(Math.round((options.sleepDebtSec / 3600) * 3), 25)
      : 0;
    sleepHistoryScore = clamp(sleepHistoryAvg - debtPenalty, 0, 100);
  }

  // ── Composite — HRV 50%, Last Night Sleep + Sleep History 50% ─────────────
  // RHR removed from weighted input per Buchheit 2014: low sensitivity means it
  // adds noise to the composite. It acts as an override (above) instead.
  // HRV uses z-scoring (personal baseline matters — 40ms is good for some, bad for others).
  // Sleep uses raw Garmin/Apple scores (already population-normalised).
  //
  // Asymmetric sleep weighting (Fullagar 2015, Reilly & Edwards 2007):
  // When last night is worse than 7d avg, shift weight toward last night (35/15).
  // Acute sleep restriction has disproportionate next-day performance impact —
  // sleep loss hurts more than sleep surplus helps (Halson 2014).
  // When last night >= 7d avg, even split (25/25).
  const hasHrv          = hrvScore != null;
  const hasSleep        = sleepScore != null;
  const hasSleepHistory = sleepHistoryScore != null;
  const hasRhr          = rhrScore != null;
  if (!hasHrv && !hasSleep && !hasSleepHistory && !hasRhr) return noData;
  if (!hasHrv && !hasSleep && !hasSleepHistory) return noData;

  // Asymmetric weighting: when last night is worse than the 14d history, shift weight
  // toward last night. Ramps linearly with the gap (last night vs history), saturating
  // at ±0.10 when the gap reaches 20 points — roughly a full sleep-quality tier.
  // Rationale: acute sleep loss has disproportionate next-day impact (Fullagar 2015;
  // Reilly & Edwards 2007), but a 1–2 pt dip shouldn't flip the weighting meaningfully.
  let wLastNight = 0.25;
  let wSleepHist = 0.25;
  if (hasSleep && hasSleepHistory) {
    const gap = sleepHistoryScore! - sleepScore!;
    const shift = clamp(gap / 20, 0, 1) * 0.10;
    wLastNight = 0.25 + shift;
    wSleepHist = 0.25 - shift;
  }

  let totalWeight = 0;
  let weightedSum = 0;
  if (hasHrv)          { weightedSum += hrvScore!          * 0.50;        totalWeight += 0.50; }
  if (hasSleep)        { weightedSum += sleepScore!        * wLastNight;  totalWeight += wLastNight; }
  if (hasSleepHistory) { weightedSum += sleepHistoryScore! * wSleepHist;  totalWeight += wSleepHist; }

  let score = Math.round(weightedSum / totalWeight);

  // Apply RHR override cap after composite
  if (rhrOverride) score = Math.min(score, rhrOverride.cap);
  const zone: RecoveryScoreResult['zone'] =
    score >= 80 ? 'Excellent' : score >= 65 ? 'Good' : score >= 45 ? 'Fair' : 'Poor';

  return { score, zone, sleepScore, lastNightSleep, lastNightSleepDate, hrvScore, lastNightHrv, lastNightHrvDate, rhrScore, rhrOverride, sleepHistoryScore, sleepHistoryAvg, hasData: true, dataStale: false, lastSyncDate, hrvDataSufficient };
}
