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

import type { Week, Workout, PhysiologyDayEntry, SportKey } from '@/types';
import type { ReadinessLabel } from '@/calculations/readiness';
import { TL_PER_MIN, SPORTS_DB, plannedTssPerMin } from '@/constants';
import {
  normalizeSport, isStrengthActual, resolveActualSport, resolveAdhocSport, isRunSport, signalARunSpec,
} from '@/cross-training/activities';
import { computeRecoveryScore } from '@/calculations/readiness';
import { getEffectiveKUser, getEffectiveSafeUpper } from '@/calculations/adaptive-recovery';
import { computeWeekDoubleDayBonus, computeTodayDoubleDayBonus } from '@/calculations/double-day';
import { plausibleLtHR } from '@/calculations/lt-derivation';
import { getBeta, type BiologicalSex } from '@/calculations/trimp';
import { isPlannedAdhocId } from '@/workouts/planned-adhoc';

/**
 * Passive strain: TSS per minute of non-workout active time.
 *
 * Garmin epochs classify each 15-min window as SEDENTARY / ACTIVE / HIGHLY_ACTIVE.
 * Subtracting known workout duration from total active minutes gives passive active
 * time (commuting, errands, work stress, etc.).
 *
 * Uses TL_PER_MIN[2] = 0.45 (RPE 2, light effort) for passive active minutes.
 * This avoids the double-counting problem with step-based TSS (running steps
 * counted in both workout iTRIMP and step TSS).
 *
 * Calibration: 120 non-workout active minutes × 0.45 = 54 TSS.
 * A typical office worker has ~30-60 active minutes; a city commuter ~90-120.
 * Reference: WHOOP counts all non-workout HR elevation toward daily strain.
 */
export const PASSIVE_TSS_PER_ACTIVE_MIN = TL_PER_MIN[2]; // 0.45

/**
 * Step-based passive TSS: 1 TSS per 1,000 passive steps.
 *
 * Derivation (Banister TRIMP at Zone 1 walking intensity):
 *   Walking cadence ~110 spm (Himann 1988) → 1,000 steps ≈ 9 min.
 *   Walking HR ≈ 50-55% HRmax → HRR ≈ 0.20-0.30.
 *   Banister TRIMP/min = HRR × 0.64 × exp(1.92 × HRR) ≈ 0.19 at HRR=0.25.
 *   9 min × 0.19 = 1.7 raw TRIMP → normalizeiTrimp(1.7, 15000) ≈ 0.011.
 *   BUT TL_PER_MIN[2]=0.45 for RPE2 gives 9 × 0.45 = 4.05. Much higher.
 *   Compromise: 1.0 TSS per 1,000 steps. Conservative enough that background
 *   walking (5-10k steps) adds 5-10 TSS. Meaningful on rest days, noise on
 *   training days. Consistent with WHOOP passive strain magnitudes.
 *
 * Used as a floor when activeMinutes undercount low-intensity walking.
 */
export const PASSIVE_TSS_PER_1000_STEPS = 1.0;

/**
 * Estimated step cadences for subtracting workout steps from daily total.
 * Running: Cavanagh & Kram (1989) report 160-180 spm; 170 is median for recreational.
 * Walking: Himann (1988) report 100-120 spm; 110 is typical for adults.
 * Cycling/swimming/strength: 0 (no meaningful step contribution).
 */
const CADENCE_RUNNING_SPM = 170;
const CADENCE_WALKING_SPM = 110;

// ── Target TSS ────────────────────────────────────────────────────────────────

/**
 * Readiness-modulated daily target TSS.
 *
 * Training days: base target = plannedDayTSS from the plan engine.
 * Adhoc days (unplanned activity): base target = perSessionAvg.
 * Rest days: base target = 30% of perSessionAvg (Menzies 2010: active recovery
 *   at ~30% of training load improves next-day performance vs complete rest).
 *
 * Modulation (Buchheit & Laursen 2013, autoregulation):
 *   - Primed / On Track: 100% of base (plan holds)
 *   - Manage Load: 100% of base (visual nudge only. Amber marker)
 *   - Ease Back: 80% of base (Halson 2014: 20-30% load reduction on suppressed recovery)
 *   - Overreaching: 75% of base (Gabbett 2016: ACWR spike reduction)
 */
const EASE_BACK_MULT     = 0.80;
const OVERREACHING_MULT  = 0.75;
const REST_DAY_TARGET_FRAC = 0.30;

/**
 * Rest-day overreach threshold: 33% of per-session average.
 * Based on Whoop's ~33% recovery-day cap, Seiler's polarised model (Zone 1 recovery
 * sessions ≈ 25-35% of a hard session), and TrainingPeaks rest-day TSS guidance.
 */
export const REST_DAY_OVERREACH_RATIO = 0.33;

export interface TargetTSSRange {
  lo: number;   // lower bound
  mid: number;  // midpoint (used for ring scaling)
  hi: number;   // upper bound
}

/**
 * Target range widths by day type.
 * Training: ±15%. Accounts for pace/effort execution variation.
 * Adhoc:    ±30%. Wider, no specific plan to match.
 * Rest:     0 to base. Anything above the base is overreaching.
 */
const TRAINING_RANGE = 0.15;
const ADHOC_RANGE    = 0.30;

export function computeDayTargetTSS(
  plannedDayTSS: number,
  readinessLabel: ReadinessLabel | null,
  perSessionAvg: number,
  isRestDay: boolean,
  isAdhocDay: boolean,
): TargetTSSRange {
  // Base target
  let base: number;
  if (isRestDay) {
    base = perSessionAvg * REST_DAY_TARGET_FRAC;
  } else if (isAdhocDay) {
    base = perSessionAvg;
  } else {
    base = plannedDayTSS;
  }

  // Readiness modulation
  if (readinessLabel === 'Ease Back')     base *= EASE_BACK_MULT;
  if (readinessLabel === 'Overreaching')  base *= OVERREACHING_MULT;

  // Range
  let lo: number, hi: number;
  if (isRestDay) {
    lo = 0;
    hi = Math.round(base);
  } else if (isAdhocDay) {
    lo = Math.round(base * (1 - ADHOC_RANGE));
    hi = Math.round(base * (1 + ADHOC_RANGE));
  } else {
    lo = Math.round(base * (1 - TRAINING_RANGE));
    hi = Math.round(base * (1 + TRAINING_RANGE));
  }

  return { lo, mid: Math.round(base), hi };
}

// ── Passive TSS ───────────────────────────────────────────────────────────────

/**
 * Compute passive (non-workout) TSS from daily physiology data.
 *
 * Two signals, take the higher:
 *   A. Passive steps → TSS via PASSIVE_TSS_PER_1000_STEPS (catches low-intensity walking)
 *   B. Passive active minutes → TSS via tssPerActiveMinute (catches high-intensity unlogged activity)
 *
 * Both signals subtract logged workout contribution to avoid double-counting:
 *   - Steps: subtract estimated workout steps (duration × sport cadence)
 *   - Minutes: subtract logged workout minutes (simple duration sum)
 *
 * @param totalSteps. Total daily steps from physiologyHistory
 * @param activeMinutes. Total active minutes from Garmin epochs / Apple Watch exercise ring
 * @param loggedActivities. Today's logged activities (for subtraction)
 * @param tssPerActiveMinute. Personal calibration, or PASSIVE_TSS_PER_ACTIVE_MIN fallback
 */
export function computePassiveTSS(
  totalSteps: number | undefined,
  activeMinutes: number | undefined,
  loggedActivities: Array<{ durationSec: number; activityType?: string | null }>,
  tssPerActiveMinute: number = PASSIVE_TSS_PER_ACTIVE_MIN,
): number {
  // Sum logged workout contribution for subtraction
  let loggedMinutes = 0;
  let loggedSteps = 0;
  for (const act of loggedActivities) {
    const durMin = act.durationSec / 60;
    loggedMinutes += durMin;
    const type = (act.activityType ?? '').toUpperCase();
    if (type.includes('RUN'))                            loggedSteps += durMin * CADENCE_RUNNING_SPM;
    else if (type.includes('WALK') || type.includes('HIKE')) loggedSteps += durMin * CADENCE_WALKING_SPM;
    // Cycling, swimming, strength: 0 steps
  }

  // Signal A: passive steps
  let tssFromSteps = 0;
  if (totalSteps != null && totalSteps > 0) {
    const passiveSteps = Math.max(0, totalSteps - loggedSteps);
    tssFromSteps = (passiveSteps / 1000) * PASSIVE_TSS_PER_1000_STEPS;
  }

  // Signal B: passive active minutes
  let tssFromMinutes = 0;
  if (activeMinutes != null && activeMinutes > 0) {
    const passiveActiveMin = Math.max(0, activeMinutes - loggedMinutes);
    tssFromMinutes = passiveActiveMin * tssPerActiveMinute;
  }

  return Math.round(Math.max(tssFromSteps, tssFromMinutes));
}

// ── Personal calibration ──────────────────────────────────────────────────────

/**
 * Calibrate personal TSS-per-active-minute from logged activities.
 * Mirrors computeCrossTrainTSSPerMin pattern: scans garminActuals with
 * both iTrimp and durationSec, computes median(TSS / durationMin).
 *
 * Returns null when < 5 qualifying samples (fallback to PASSIVE_TSS_PER_ACTIVE_MIN).
 */
export function calibrateTssPerActiveMinute(wks: Week[] | undefined | null, norm?: number): number | null {
  if (!wks?.length) return null;
  const MIN_SAMPLES = 5;
  const MIN_DURATION_SEC = 900; // 15 min minimum
  const seen = new Set<string>();
  const ratios: number[] = [];

  for (const wk of wks) {
    for (const actual of Object.values(wk.garminActuals ?? {})) {
      if (!actual.iTrimp || actual.iTrimp <= 0) continue;
      if (!actual.durationSec || actual.durationSec < MIN_DURATION_SEC) continue;
      if (actual.garminId && seen.has(actual.garminId)) continue;
      if (actual.garminId) seen.add(actual.garminId);
      const tss = normalizeiTrimp(actual.iTrimp, norm);
      const durMin = actual.durationSec / 60;
      ratios.push(tss / durMin);
    }
  }

  if (ratios.length < MIN_SAMPLES) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)]; // median
}

/**
 * Compute trailing effort score from the last 2 completed weeks with effort data.
 * Skips injury weeks. Returns 0 when no data available.
 */
export function getTrailingEffortScore(weeks: Week[], currentWeekIdx: number): number {
  const completed: number[] = [];
  for (let i = currentWeekIdx - 2; i >= 0 && completed.length < 2; i--) {
    const w = weeks[i];
    if (w.effortScore != null && !w.injuryState?.active) {
      completed.push(w.effortScore);
    }
  }
  if (completed.length === 0) return 0;
  return completed.reduce((a, b) => a + b, 0) / completed.length;
}

export interface FitnessMetrics {
  week: number;
  ctl: number;      // Chronic Training Load (42-day EMA). Signal A (run-equivalent)
  atl: number;      // Acute Training Load (7-day EMA). Signal B (raw physiological)
  tsb: number;      // Training Stress Balance = CTL - ATL
  actualTSS: number;
  rawTSS: number;   // Signal B for this week (no runSpec discount)
}

// Weekly EMA decay constants (7-day weeks)
export const CTL_DECAY = Math.exp(-7 / 42);  // ≈ 0.847
export const ATL_DECAY = Math.exp(-7 / 7);   // ≈ 0.368

/**
 * Compute the per-athlete iTRIMP normalizer from lactate threshold HR.
 * Based on Coggan hrTSS: 1 hour at LTHR = 100 TSS.
 * normalizer = 3600 × LTHR_HRR × e^(β × LTHR_HRR), with β from trimp.ts getBeta
 * (1.67 female, 1.92 otherwise). The β MUST match the one the iTRIMP producers
 * used for this athlete, otherwise 1 hour at LTHR does not decode to 100: a
 * female-β iTRIMP over a male-β normalizer reads e^(−0.25·hrr) ≈ 0.81× low.
 * Falls back to 15000 when LTHR data is unavailable OR implausible —
 * ltHR outside the LTHR plausibility band (80–95% of maxHR, canonical
 * constants + rationale in lt-derivation.ts). A wrong personal normalizer
 * silently rescales every iTRIMP→TSS conversion feeding CTL/ATL, so an
 * implausible profile must never reach the formula.
 * The 15000 fallback is sex-neutral: it has no stated HR profile behind it
 * (back-solved later as ≈ an 84%-HRR male-β profile), so there is no
 * documented derivation to compute a female equivalent from.
 */
export function computeAthleteNormalizer(
  ltHR?: number,
  restingHR?: number,
  maxHR?: number,
  sex?: BiologicalSex | 'prefer_not_to_say' | null,
): number {
  if (!ltHR || !restingHR || !maxHR || maxHR <= restingHR || ltHR <= restingHR || ltHR >= maxHR) {
    return 15000; // fallback
  }
  if (plausibleLtHR(ltHR, maxHR) == null) {
    console.log(`[normalizer] ltHR ${ltHR} is ${((ltHR / maxHR) * 100).toFixed(0)}% of maxHR ${maxHR} — outside plausible LTHR band (80–95%), using population normalizer 15000`);
    return 15000; // implausible profile → population fallback
  }
  const hrr = (ltHR - restingHR) / (maxHR - restingHR);
  const beta = getBeta(sex); // same β as the iTRIMP producers (trimp.ts)
  return 3600 * hrr * Math.exp(beta * hrr);
}

/** The state fields the normalizer reads. A SimulatorState satisfies it. */
export interface AthleteHRProfile {
  ltHR?: number;
  restingHR?: number;
  maxHR?: number;
  biologicalSex?: BiologicalSex | 'prefer_not_to_say' | null;
}

/** Convenience: compute normalizer from a state-like object (sex included). */
export function getNormalizerFromState(s: AthleteHRProfile): number {
  return computeAthleteNormalizer(s.ltHR, s.restingHR, s.maxHR, s.biologicalSex);
}

// Module-level normalizer used by every normalizeiTrimp() call without an
// explicit normalizer. In the app it is BOUND to live state
// (bindAthleteNormalizerToState, called once by launchApp), so any write to
// ltHR / restingHR / maxHR / biologicalSex (Account HR edit, physiology sync,
// LT recompute, HealthKit sex seeding, onboarding) is picked up on the next
// conversion. Before the binding, a cached value set at launch went stale
// after an in-session edit until the next cold launch. Unbound (tests, and
// any entry point that never binds) it is whatever setAthleteNormalizer()
// last set, defaulting to the 15000 population fallback.
let _athleteNorm = 15000;
let _normSource: (() => AthleteHRProfile | null | undefined) | null = null;
let _normSourceKey: string | null = null;

/**
 * Set an explicit per-athlete normalizer. Clears any state binding, so the
 * explicit value wins until the next set or bind. Production code binds to
 * state instead; this is for tests and one-off callers.
 */
export function setAthleteNormalizer(
  ltHR?: number,
  restingHR?: number,
  maxHR?: number,
  sex?: BiologicalSex | 'prefer_not_to_say' | null,
): void {
  _normSource = null;
  _normSourceKey = null;
  _athleteNorm = computeAthleteNormalizer(ltHR, restingHR, maxHR, sex);
}

/**
 * Bind the module normalizer to a live state getter (pass null to unbind).
 * The normalizer is recomputed whenever ltHR / restingHR / maxHR /
 * biologicalSex differ from the last read, so it cannot go stale.
 */
export function bindAthleteNormalizerToState(source: (() => AthleteHRProfile | null | undefined) | null): void {
  _normSource = source;
  _normSourceKey = null;
}

function currentAthleteNorm(): number {
  if (_normSource) {
    const p = _normSource();
    if (p) {
      const key = `${p.ltHR}|${p.restingHR}|${p.maxHR}|${p.biologicalSex}`;
      if (key !== _normSourceKey) {
        _normSourceKey = key;
        _athleteNorm = getNormalizerFromState(p);
      }
    }
  }
  return _athleteNorm;
}

/** Normalise iTRIMP to a TSS-equivalent TL value. 1 hour at LTHR = 100 TSS. */
export function normalizeiTrimp(itrimp: number, normalizer?: number): number {
  return (itrimp * 100) / (normalizer ?? currentAthleteNorm());
}

/**
 * Current athlete normalizer (for ENCODING TSS back into iTRIMP space:
 * iTrimp = tss × normalizer / 100 — the exact inverse of normalizeiTrimp).
 * Every encode/decode pair MUST use the same normalizer or synthetic
 * round-trips inflate/deflate (ISSUE-263, excess-card lesson).
 */
export function getAthleteNormalizer(): number {
  return currentAthleteNorm();
}

/** Parse duration in minutes from an adhoc workout description (e.g. "45min · 12 Feb") */
function parseDurMinFromDesc(d: string): number {
  const m = d.match(/(\d+)min/);
  return m ? parseInt(m[1]) : 30;
}

/**
 * RPE-based TSS override for strength sessions.
 *
 * HR-derived TSS systematically under-counts neuromuscular load on strength work
 * (a 60-min squat session at 70 bpm reads as ~7 TSS but the legs are toast).
 * When the user tags an RPE on a strength activity, replace the iTRIMP path with
 * `durationMin × TL_PER_MIN[rpe] × runSpec`.
 *
 * `discount` controls whether the runSpec discount applies:
 *   - Signal A (computeWeekTSS) → true → SPORTS_DB.strength.runSpec (0.35)
 *   - Signal B (computeWeekRawTSS) → false → full physiological load
 *
 * Returns null when the activity is not a strength session or has no RPE tag.
 */
export function computeStrengthRpeTSS(
  actual: {
    activityType?: string | null;
    manualSport?: string;
    workoutName?: string;
    displayName?: string;
    durationSec: number;
    rpe?: number;
  },
  discount: boolean,
  rpeFallback?: number | null,
): number | null {
  if (!isStrengthActual(actual)) return null;
  // Effective RPE: per-activity tag wins, then fall back to the matched
  // workout's wk.rated entry. This means a session already tagged via the
  // generic RPE chip (writes to wk.rated) still gets the strength override.
  const effRpe = actual.rpe ?? (rpeFallback != null ? rpeFallback : null);
  if (effRpe == null) return null;
  const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : 0;
  if (durMin <= 0) return null;
  const rpe = Math.max(1, Math.min(10, Math.round(effRpe)));
  const tlPerMin = TL_PER_MIN[rpe] ?? 1.15;
  const runSpec = discount ? (SPORTS_DB.strength.runSpec ?? 0.35) : 1.0;
  return durMin * tlPerMin * runSpec;
}

/**
 * One activity's contribution to Signal A (running-specific load), as counted by
 * computeWeekTSS. Exported so a surface that splits Signal A (run vs cross, zone
 * bars) reads the same per-activity numbers that sum to the weekly total.
 */
export interface SignalAEntry {
  /** garminActuals key (plan slot id or `garmin-<id>`) or adhoc workout id. */
  key: string;
  garminId: string | null;
  source: 'actual' | 'adhoc';
  /** The activity's own sport (resolveActualSport / resolveAdhocSport). */
  sport: SportKey;
  isRun: boolean;
  /** Signal A TSS for this activity: full TSS × runSpec of its own sport. */
  tss: number;
}

/**
 * Every synced activity in the week, at most once, with its Signal A contribution.
 *
 * Invariants (audit B3/X7, SCIENCE_LOG "Signal A vs Signal B"):
 *   - Each activity counts at most once. garminActuals win over their adhoc
 *     twin; the dedup keys are garminId and the twin's garminActuals key.
 *   - Scope: garminActuals and `garmin-` adhoc entries only. In-app GPS runs and
 *     manual logs (non-`garmin-` adhoc ids) are outside Signal A (audit B9);
 *     Signal B counts them.
 *   - `unspentLoadItems` are never load. Each one points at an activity (or the
 *     surplus slice of a run) that garminActuals / adhocWorkouts already hold.
 *   - Signal A = TSS × runSpec of the activity's OWN sport, never the slot's.
 *     The strength RPE override already applies the strength runSpec, so it is
 *     not discounted again. It runs before sport resolution, so a rated
 *     strength session takes it even when manualSport names another sport
 *     (computeWeekRawTSS does the same).
 *
 * Per-entry TSS formulas match computeWeekRawTSS: rated RPE (default 5) for a
 * garminActuals no-HR fallback, rated then planned RPE (default 5) for an adhoc
 * one, normalizeiTrimp for HR data.
 */
export function listWeekSignalAEntries(
  wk: Week,
  ratedMap: Record<string, number | 'skip'>,
  norm?: number,
): SignalAEntry[] {
  const out: SignalAEntry[] = [];
  const seenGarminIds = new Set<string>();

  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const garminId = actual.garminId ?? null;
    const ratedVal = ratedMap[workoutId];
    const ratedRpe = (typeof ratedVal === 'number') ? ratedVal : null;
    // Strength override: when the user has tagged RPE on a strength session
    // (per-activity OR via the legacy wk.rated chip), HR-based TSS is wrong
    // (low cardiovascular load ≠ low neuromuscular load). The override applies
    // the strength runSpec itself.
    const strengthOverride = computeStrengthRpeTSS(actual, true, ratedRpe);
    if (strengthOverride != null) {
      out.push({ key: workoutId, garminId, source: 'actual', sport: 'strength', isRun: false, tss: strengthOverride });
      continue;
    }
    const sport = resolveActualSport(workoutId, actual);
    const rpe = ratedRpe ?? 5;
    let raw: number;
    if (actual.iTrimp != null && actual.iTrimp > 0) {
      raw = normalizeiTrimp(actual.iTrimp);
    } else {
      // Duration-based fallback when no HR data (TL_PER_MIN is per minute, not per km)
      const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
      raw = durMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
    }
    out.push({ key: workoutId, garminId, source: 'actual', sport, isRun: isRunSport(sport), tss: raw * signalARunSpec(sport) });
  }

  // Adhoc synced workouts with no garminActuals twin (legacy entries; every
  // current writer also creates the twin, which the loop above has counted).
  for (const w of wk.adhocWorkouts ?? []) {
    if (!w.id?.startsWith('garmin-')) continue;
    if ((wk.garminActuals as any)?.[w.id]) continue;
    const rawId = w.id.slice('garmin-'.length);
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
    }
    const sport = resolveAdhocSport(w);
    let raw: number;
    if (w.iTrimp != null && w.iTrimp > 0) {
      raw = normalizeiTrimp(w.iTrimp, norm);
    } else {
      // Same RPE fallback as computeWeekRawTSS (rated, then planned, then 5), so
      // a legacy row carrying only the planned `r` cannot make A exceed B.
      const rpe = w.rpe ?? w.r ?? 5;
      raw = parseDurMinFromDesc(w.d) * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
    }
    out.push({ key: w.id, garminId: rawId || null, source: 'adhoc', sport, isRun: isRunSport(sport), tss: raw * signalARunSpec(sport) });
  }

  return out;
}

/**
 * Signal A (running-specific) Training Stress Score for a single week: the sum
 * of listWeekSignalAEntries. Always recomputed from raw data (wk.actualTSS may be
 * stale, ISSUE-85).
 *
 * Tracking side: it describes running-specific load. It also feeds planning
 * through the running CTL-gap re-anchor (resolveCtlAdherence → wk.ctlRatio).
 *
 * @param planStartDate - unused since unspentLoadItems stopped counting as load
 *   (their date window was its only use). Kept so existing call sites compile.
 */
export function computeWeekTSS(
  wk: Week,
  ratedMap: Record<string, number | 'skip'>,
  planStartDate?: string,
  norm?: number,
): number {
  let tl = 0;
  for (const e of listWeekSignalAEntries(wk, ratedMap, norm)) tl += e.tss;
  return Math.round(tl);
}

/** @deprecated Use computeWeekTSS */
export const computeWeekTL = computeWeekTSS;

/**
 * Compute raw physiological TSS for a single week (Signal B).
 * Counts the same activities as computeWeekTSS, once each, with no runSpec discount:
 * cycling, strength, HIIT, etc. all count at full iTRIMP weight. Its adhoc scope is
 * wider (GPS-recorded and manual entries count too). unspentLoadItems never count.
 *
 * Use this for ACWR/injury risk and weekly load charts. The body doesn't care
 * what sport caused the fatigue.
 */
export function computeWeekRawTSS(
  wk: Week,
  ratedMap: Record<string, number | 'skip'>,
  planStartDate?: string,
  norm?: number,
): number {
  let tl = 0;

  // Dedup set: tracks garminIds already counted so that the same activity cannot
  // count twice (a garminActuals twin and its adhoc entry).
  const seenGarminIds = new Set<string>();

  // garminActuals. Same activities as computeWeekTSS, no runSpec discount
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const ratedVal = ratedMap[workoutId];
    const ratedRpe = (typeof ratedVal === 'number') ? ratedVal : null;
    // Strength override: Signal B uses no runSpec discount (full physiological load).
    const strengthOverride = computeStrengthRpeTSS(actual, false, ratedRpe);
    if (strengthOverride != null) {
      tl += strengthOverride;
      continue;
    }
    const rpe = ratedRpe ?? 5;
    if (actual.iTrimp != null && actual.iTrimp > 0) {
      tl += normalizeiTrimp(actual.iTrimp);
    } else {
      const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
      tl += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
    }
  }

  // Adhoc workouts. RunSpec = 1.0 (full physiological cost, Signal B)
  // Include ALL adhoc workouts regardless of ID prefix: Garmin-synced ('garmin-'),
  // GPS-recorded (UUID), and any other manually logged entries.
  // Skip planned sessions (adhoc-/holiday-/benchmark-). They are prescriptions,
  // not real activity; the synced activity carries the load once they are done.
  for (const w of wk.adhocWorkouts ?? []) {
    if (isPlannedAdhocId(w.id)) continue;
    // Skip if garminActuals already covers this entry (Strava-upgraded data wins)
    if (w.id && (wk.garminActuals as any)?.[w.id]) continue;
    // Extract garminId from the adhoc workout id (format: 'garmin-<garminId>')
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
    }
    if (w.iTrimp != null && w.iTrimp > 0) {
      tl += normalizeiTrimp(w.iTrimp, norm); // no runSpec discount
    } else {
      const rpe = w.rpe ?? w.r ?? 5;
      const durMin = parseDurMinFromDesc(w.d);
      tl += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15); // no runSpec discount
    }
  }

  // unspentLoadItems are decision records, never load: each one points at an
  // activity (or the surplus slice of a run) already counted above. Counting
  // them only ever added orphans left behind after the activity was removed.

  // Double-day compounding bonus: ≥2 same-day sessions (≥20 min each, planned
  // bricks excluded) carry more physiological cost than pure additive TSS.
  // See src/calculations/double-day.ts + docs/SCIENCE_LOG.md.
  tl += computeWeekDoubleDayBonus(wk, planStartDate, norm);

  return Math.round(tl);
}

/**
 * Compute today's Signal B TSS from activities completed so far today.
 * Mirrors computeWeekRawTSS but scoped to a single calendar day via startTime.
 * Used for the live Strain Score on the Home view.
 *
 * @param wk. Current plan week
 * @param today. ISO date string (YYYY-MM-DD)
 * @param passiveActivity. Today's epoch data { activeMinutes, highlyActiveMinutes } from Garmin.
 *                          Null = no data, passive strain excluded.
 */
export function computeTodaySignalBTSS(
  wk: Week,
  today: string,
  passiveActivity?: { activeMinutes?: number; highlyActiveMinutes?: number } | null,
  norm?: number,
): number {
  let tl = 0;
  let workoutMinutes = 0; // track to subtract from active minutes later
  const seenGarminIds = new Set<string>();

  // today's day-of-week index (0=Mon, 6=Sun) for adhocWorkout matching
  const d = new Date(today + 'T12:00:00');
  const ourDay = (d.getDay() + 6) % 7;

  // garminActuals. Filter to today by startTime
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (!actual.startTime?.startsWith(today)) continue;
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const actDurMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
    workoutMinutes += actDurMin;
    // Strength override: Signal B uses full physiological load (no runSpec discount).
    const ratedVal = wk.rated?.[workoutId];
    const ratedRpe = (typeof ratedVal === 'number') ? ratedVal : null;
    const strengthOverride = computeStrengthRpeTSS(actual, false, ratedRpe);
    if (strengthOverride != null) {
      tl += strengthOverride;
      continue;
    }
    if (actual.iTrimp != null && actual.iTrimp > 0) {
      tl += normalizeiTrimp(actual.iTrimp);
    } else {
      tl += actDurMin * (TL_PER_MIN[5] ?? 1.15);
    }
  }

  // adhocWorkouts. Garmin-prefixed filtered by garminTimestamp; non-garmin matched by dayOfWeek
  // Skip planned sessions (adhoc-/holiday-/benchmark-). They are prescriptions, not real activity.
  for (const w of wk.adhocWorkouts ?? []) {
    if (isPlannedAdhocId(w.id)) continue;
    // Skip if garminActuals already covers this entry (Strava-upgraded data wins)
    if (w.id && (wk.garminActuals as any)?.[w.id]) continue;
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      // Use garminTimestamp (stored by addAdhocWorkoutFromPending) to filter by date
      const ts = (w as any).garminTimestamp as string | undefined;
      if (!ts?.startsWith(today)) continue;
      seenGarminIds.add(rawId);
      const adhocDur = parseDurMinFromDesc(w.d);
      workoutMinutes += adhocDur;
      if (w.iTrimp != null && w.iTrimp > 0) {
        tl += normalizeiTrimp(w.iTrimp, norm);
      } else {
        const rpe = w.rpe ?? w.r ?? 5;
        tl += adhocDur * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
      }
      continue;
    }
    if ((w as any).dayOfWeek !== ourDay) continue;
    const adhocDur2 = parseDurMinFromDesc(w.d);
    workoutMinutes += adhocDur2;
    if (w.iTrimp != null && w.iTrimp > 0) {
      tl += normalizeiTrimp(w.iTrimp, norm);
    } else {
      const rpe = w.rpe ?? w.r ?? 5;
      tl += adhocDur2 * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
    }
  }

  // unspentLoadItems are decision records, never load (see computeWeekRawTSS).

  // Passive strain: non-workout active minutes contribute background TSS.
  // Subtract workout duration from total active minutes to avoid double-counting
  // (epochs include workout time as HIGHLY_ACTIVE).
  if (passiveActivity?.activeMinutes != null && passiveActivity.activeMinutes > 0) {
    const passiveActiveMin = Math.max(0, passiveActivity.activeMinutes - workoutMinutes);
    tl += passiveActiveMin * PASSIVE_TSS_PER_ACTIVE_MIN;
  }

  // Double-day compounding bonus for today specifically.
  tl += computeTodayDoubleDayBonus(wk, today, undefined, norm);

  return Math.round(tl);
}

/**
 * Single source of truth for Today's Strain TSS across Home, Readiness, and Strain views.
 *
 * Combines:
 *   - Logged workout TSS + passive active-minute TSS (via computeTodaySignalBTSS)
 *   - Step-based passive excess (when step-derived TSS exceeds minute-derived TSS)
 *
 * The excess term covers days where Garmin active-minute epochs undercount low-intensity
 * walking (e.g. slow commuting). Mirrors the strain-view calculation so every surface
 * shows the same number.
 */
export function computeTodayStrainTSS(
  wk: Week,
  date: string,
  physioEntry: PhysiologyDayEntry | null | undefined,
  tssPerActiveMinute: number = PASSIVE_TSS_PER_ACTIVE_MIN,
): number {
  const loggedTSS = computeTodaySignalBTSS(wk, date, physioEntry);

  // Collect logged activities for this date so step-subtraction in computePassiveTSS
  // matches exactly what computeTodaySignalBTSS counted.
  const loggedActivities: Array<{ durationSec: number; activityType?: string | null }> = [];
  const seen = new Set<string>();
  for (const a of Object.values(wk.garminActuals ?? {})) {
    if (!a.startTime?.startsWith(date)) continue;
    if (a.garminId) {
      if (seen.has(a.garminId)) continue;
      seen.add(a.garminId);
    }
    loggedActivities.push({ durationSec: a.durationSec, activityType: a.activityType });
  }
  for (const w of wk.adhocWorkouts ?? []) {
    // An adhoc whose id is a garminActuals key is that actual's twin, already
    // collected above (computeTodaySignalBTSS skips it the same way). After a
    // Strava upgrade the twin's garminId no longer matches the id suffix.
    if (w.id && (wk.garminActuals as any)?.[w.id]) continue;
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (!rawId) continue;
    const ts = (w as any).garminTimestamp as string | undefined;
    if (!ts?.startsWith(date)) continue;
    if (seen.has(rawId)) continue;
    seen.add(rawId);
    loggedActivities.push({
      durationSec: Math.round(((w as any).garminDurationMin ?? 0) * 60),
      activityType: (w as any).activityType ?? null,
    });
  }

  const passiveTSS = computePassiveTSS(
    physioEntry?.steps,
    physioEntry?.activeMinutes,
    loggedActivities,
    tssPerActiveMinute,
  );
  const loggedMinutes = loggedActivities.reduce((s, a) => s + a.durationSec / 60, 0);
  const minuteComponent = physioEntry?.activeMinutes != null
    ? Math.max(0, physioEntry.activeMinutes - loggedMinutes) * tssPerActiveMinute
    : 0;
  const passiveExcess = Math.max(0, passiveTSS - minuteComponent);
  return loggedTSS + Math.round(passiveExcess);
}

/**
 * Estimate duration in minutes for a planned workout.
 * Handles km-based descriptions (most common), interval formats, and min-based fallback.
 * Pace multipliers by workout type match the plan-view planned-TSS calculation exactly.
 *
 * @param w             Planned workout.
 * @param baseMinPerKm  Easy pace in min/km (s.pac.e / 60). Defaults to 5.5 if unknown.
 */
export function estimateWorkoutDurMin(w: Workout, baseMinPerKm: number): number {
  const t = (w.t || '').toLowerCase();
  const desc: string = w.d || '';
  const lines = desc.split('\n').filter((l: string) => l.trim());
  let mainDesc = desc;
  let wucdMin = 0;
  if (lines.length >= 3 && lines[0].includes('warm up')) {
    mainDesc = lines[1];
    const wuKm = parseFloat((lines[0].match(/^(\d+\.?\d*)km/) || [])[1] || '0');
    const cdKm = parseFloat((lines[lines.length - 1].match(/^(\d+\.?\d*)km/) || [])[1] || '0');
    wucdMin = (wuKm + cdKm) * baseMinPerKm;
  }
  const intervalTimeMatch = mainDesc.match(/(\d+)×(\d+\.?\d*)min/);
  if (intervalTimeMatch) {
    const reps = parseInt(intervalTimeMatch[1]);
    const repDur = parseFloat(intervalTimeMatch[2]);
    const recMatch = mainDesc.match(/(\d+\.?\d*)\s*min\s*recovery/);
    const recMin = recMatch ? parseFloat(recMatch[1]) : 0;
    return Math.max(reps * repDur + (reps - 1) * recMin + wucdMin, 1);
  }
  const kmMatch = mainDesc.match(/(\d+\.?\d*)km/);
  if (kmMatch) {
    const km = parseFloat(kmMatch[1]);
    let paceMinPerKm = baseMinPerKm;
    if (t === 'threshold' || t === 'tempo') paceMinPerKm = baseMinPerKm * 0.82;
    else if (t === 'vo2' || t === 'intervals') paceMinPerKm = baseMinPerKm * 0.73;
    else if (t === 'race_pace') paceMinPerKm = baseMinPerKm * 0.78;
    else if (t === 'marathon_pace') paceMinPerKm = baseMinPerKm * 0.87;
    else if (t === 'long') paceMinPerKm = baseMinPerKm * 1.03;
    return Math.max(km * paceMinPerKm + wucdMin, 1);
  }
  const minMatch = mainDesc.match(/(\d+)min/);
  return Math.max(minMatch ? parseInt(minMatch[1]) + wucdMin : (wucdMin || 40), 1);
}

/**
 * True when a planned workout's status says it is no longer to be done this week:
 * 'replaced' (the run was fully covered by other training, suggester.ts / injury
 * engine) or 'skipped' (dropped or pushed by a skip handler).
 *
 * Running semantics only. In the stored-plan modes (triathlon, cycling, HYROX)
 * 'replaced' marks a session swapped to an easier one that is still to be done
 * (tri-suggestion-apply.ts), so getPlannedDayTSSContext's tri branch checks
 * 'skipped' alone.
 *
 * A running skip recorded only as `wk.rated[id] === 'skip'` is a rating, not a
 * plan change. It stays priced: resolveCtlAdherence reads the same planned-day
 * context after next() auto-skips unrated runs, and an unpriced skip would read
 * an all-skipped week as "nothing planned" and never re-anchor.
 */
export function isUnscheduledPlannedWorkout(w: Pick<Workout, 'status'>): boolean {
  return w.status === 'replaced' || w.status === 'skipped';
}

/**
 * Planned Signal B TSS for ONE running-plan workout (no actual data yet), unrounded.
 *
 * PLANNING side. The canonical per-session pricer: computePlannedDaySignalBTSS
 * sums it for the day's strain target, and the Plan tab's per-workout "Planned
 * load" bar (plan-view.ts) and the activity-detail "Load vs plan" card read it
 * directly, so the bar and the day target show the same number for the same run.
 *
 * Type-keyed valuation (ISSUE-263): an easy run is prescribed RPE 3 but valued
 * at the RPE-4 row (0.92 TSS/min), the same rule as calculateWorkoutLoad.
 *
 * Replaced and skipped sessions price at 0 (isUnscheduledPlannedWorkout). A
 * fully replaced run keeps the description '0km (replaced)', which
 * estimateWorkoutDurMin floors to a 1-minute run: before this guard the day
 * priced at 1 TSS, counted as a training day with a 1-TSS target, and pulled
 * perSessionAvg down (audit B11). calculateWorkoutLoad (workouts/load.ts) already
 * returns 0 for replaced descriptions.
 *
 * @param w             Planned workout (mods applied, e.g. from resolveWeekWorkouts).
 * @param baseMinPerKm  Easy pace in min/km (s.pac.e / 60). Defaults to 5.5.
 */
export function computePlannedWorkoutSignalBTSS(w: Workout, baseMinPerKm = 5.5): number {
  if (isUnscheduledPlannedWorkout(w)) return 0;
  const rpe = w.rpe ?? w.r ?? 5;
  return estimateWorkoutDurMin(w, baseMinPerKm) * plannedTssPerMin(w.t, rpe);
}

/**
 * Estimate Signal B TSS for a day's planned workouts (no actual data yet).
 * Used as the strain target on training days so 100% = "you completed your plan".
 *
 * Sums computePlannedWorkoutSignalBTSS (no runSpec discount: Signal B counts full
 * physiological load regardless of sport). Falls back to 0 when no workouts are
 * scheduled for this day-of-week, or when every one is replaced or skipped.
 *
 * @param workouts      Full week's generated workouts.
 * @param dayOfWeek     0=Mon … 6=Sun (same convention as Workout.dayOfWeek).
 * @param baseMinPerKm  Easy pace in min/km (s.pac.e / 60). Defaults to 5.5.
 */
export function computePlannedDaySignalBTSS(workouts: Workout[], dayOfWeek: number, baseMinPerKm = 5.5): number {
  let tl = 0;
  for (const w of workouts) {
    if (w.dayOfWeek !== dayOfWeek) continue;
    tl += computePlannedWorkoutSignalBTSS(w, baseMinPerKm);
  }
  return Math.round(tl);
}

/**
 * Compute decayed carry-forward from previous weeks' excess TSS.
 *
 * Uses real-time daily decay so the carry genuinely clears as the week
 * progresses. This week's own activities are unaffected (they stay constant);
 * only the residual from previous weeks degrades.
 *
 * Each previous week's excess is approximated at its midpoint (activities
 * spread Mon-Sun, midpoint ≈ Wed/Thu). Decay uses the 7-day ATL time
 * constant measured from that midpoint to right now:
 *
 *   Monday after a heavy week:    e^(-3.5/7) ≈ 0.61 → 61% remains
 *   Thursday after a heavy week:  e^(-6.5/7) ≈ 0.40 → 40% remains
 *   Sunday (full week later):     e^(-10.5/7) ≈ 0.22 → 22% remains
 *
 * Recomputes each week's excess from scratch using getWeeklyExcess (Signal B
 * vs planned) rather than reading wk.carriedTSS.
 *
 * Looks back up to 3 weeks. `plannedBaseline` is either:
 *   - a function of the 1-indexed plan week, returning THAT week's own target
 *     (the plan path: `computeCurrentWeekCarry` in planned-week-target.ts passes
 *     `computePlannedWeekTarget`). Each past week is judged against what it was
 *     planned to be. Judging a peak week against the following taper week's
 *     lower target invented "excess" that was never trained (audit A10).
 *   - a single number, used for every lookback week. Only correct when the
 *     target does not vary by week (activity-review's phase-independent
 *     `signalBBaseline`).
 */
export function computeDecayedCarry(
  wks: Week[],
  currentWeek: number,
  plannedBaseline: number | ((weekNum: number) => number),
  planStartDate?: string,
): number {
  if (!plannedBaseline || !planStartDate) return 0;
  const targetFor = typeof plannedBaseline === 'function'
    ? plannedBaseline
    : () => plannedBaseline;

  const nowMs = new Date().setHours(12, 0, 0, 0); // noon today
  const planStartMs = new Date(planStartDate).getTime();
  const ATL_TAU = 7; // 7-day time constant

  let total = 0;
  const maxLookback = Math.min(3, currentWeek - 1);
  for (let age = 1; age <= maxLookback; age++) {
    const idx = currentWeek - 1 - age; // 0-indexed
    const wk = wks[idx];
    if (!wk) continue;
    // Raw excess for that week against its own target (no carry. Avoids circularity)
    const weekTarget = targetFor(idx + 1);
    if (!weekTarget) continue;
    const weekExcess = getWeeklyExcess(wk, weekTarget, planStartDate);
    if (weekExcess <= 0) continue;
    // Days from midpoint of that week to now
    const weekMidMs = planStartMs + (currentWeek - 1 - age) * 7 * 86400000 + 3.5 * 86400000;
    const daysElapsed = Math.max(0, (nowMs - weekMidMs) / 86400000);
    const decay = Math.exp(-daysElapsed / ATL_TAU);
    total += weekExcess * decay;
  }
  return Math.round(total);
}

/**
 * Weekly Signal B excess above the athlete's historical baseline.
 * Returns 0 if no baseline is available (prevents phantom reductions on new users).
 *
 * When carriedLoad is provided (decayed excess from previous weeks), it is added
 * to the actual side. Training load does not reset at week boundaries.
 */
export function getWeeklyExcess(
  wk: Week,
  signalBBaseline: number,
  planStartDate?: string,
  carriedLoad?: number,
): number {
  if (!signalBBaseline) return 0;
  const actual = computeWeekRawTSS(wk, wk.rated ?? {}, planStartDate) + (carriedLoad ?? 0);
  return Math.max(0, actual - signalBBaseline);
}

// ---------------------------------------------------------------------------
// Cross-training TSS calibration
// ---------------------------------------------------------------------------

/**
 * Compute median TSS-per-minute for a sport from the user's actual history.
 * Uses iTrimp-based TSS (same scale as actual TSS display) so planned estimates
 * stay consistent with actuals. Returns null when < 2 samples exist.
 *
 * Special case: `generic_sport` is a catch-all plan slot that can match any
 * cross-training activity. For it we scan ALL non-running actuals rather than
 * trying to match a specific sport name (Strava labels will vary).
 */
export function computeCrossTrainTSSPerMin(wks: Week[] | undefined | null, sportKey: string, norm?: number): number | null {
  if (!wks?.length) return null;
  const isGeneric = sportKey === 'generic_sport';
  const seen = new Set<string>();
  const samples: number[] = [];
  for (const wk of wks) {
    for (const actual of Object.values(wk.garminActuals ?? {})) {
      if (!actual.iTrimp || actual.iTrimp <= 0) continue;
      if (!actual.durationSec || actual.durationSec < 600) continue; // skip < 10 min
      if (actual.garminId && seen.has(actual.garminId)) continue;
      if (actual.garminId) seen.add(actual.garminId);
      if (isGeneric) {
        // Exclude running activities. Use activityType if present, otherwise
        // treat sessions with avgPaceSecKm as running proxies.
        const aType = (actual.activityType || '').toUpperCase();
        const isRun = aType === 'RUNNING' || aType.includes('RUN') || (!aType && actual.avgPaceSecKm != null && actual.avgPaceSecKm > 0);
        if (isRun) continue;
      } else {
        const sport = normalizeSport(actual.displayName || actual.workoutName || '');
        if (sport !== sportKey) continue;
      }
      const durMin = actual.durationSec / 60;
      const tss = normalizeiTrimp(actual.iTrimp, norm);
      samples.push(tss / durMin);
    }
  }
  if (samples.length < 2) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// ---------------------------------------------------------------------------
// Planned Load Model (ISSUE-79)
// ---------------------------------------------------------------------------

/**
 * Phase multipliers by athlete tier.
 * Higher-tier athletes tolerate bigger week-to-week ramps.
 * Base = maintain, Build = progressive overload, Peak = max sustainable,
 * Deload = recovery, Taper = linear ramp down.
 *
 * Week.ph never holds 'deload': callers resolve a week's effective phase
 * (deload status, race-taper position) through `computePlannedWeekTarget`
 * in planned-week-target.ts, which reads the same plan data the generator does.
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
 * `weekInTaper` is 0-indexed (the contract the JSDoc of computePlannedWeekTSS
 * states): a 3-week taper gives 0.85 / 0.75 / 0.65, a 2-week taper 0.85 / 0.70,
 * and a 1-week taper 0.70.
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

/**
 * Compute the composite planned Signal B target for the week.
 *
 * plannedSignalB = runningPlanTSS + crossTrainingBudget
 *
 * Running plan TSS: same as computePlannedWeekTSS (phase-adjusted Signal A baseline).
 * Cross-training budget: Σ(avgSessionRawTSS × sessionsPerWeek) across all sports
 *   in sportBaselineByType. Falls back to zero when no history exists.
 *
 * Use this wherever Signal B actual is compared to a target (plan bar, excess detection).
 * Never compare Signal B actual to computePlannedWeekTSS. That's a cross-signal mismatch.
 */
export function computePlannedSignalB(
  historicWeeklyTSS: number[] | undefined,
  ctlBaseline: number | undefined,
  phase: string,
  athleteTier?: string,
  runsPerWeek?: number,
  weekInPhase?: number,
  totalPhaseWeeks?: number,
  sportBaselineByType?: Record<string, { avgSessionRawTSS: number; sessionsPerWeek: number }>,
): number {
  // historicWeeklyTSS is Signal A. It includes cross-training at runSpec-discounted weight.
  // We need the running-only baseline so we can add the full Signal B cross-training budget
  // without double-counting the discounted portion.
  //
  // Correction: subtract the average discounted cross-training from each historical week
  // to isolate running-only TSS before computing the planned running target.
  let discountedCrossTraining = 0;
  let crossTrainingBudget = 0;
  if (sportBaselineByType) {
    for (const [sportKey, sport] of Object.entries(sportBaselineByType)) {
      const cfg = (SPORTS_DB as any)[sportKey];
      const runSpec: number = cfg?.runSpec ?? 0.35;
      const weeklyRaw = sport.avgSessionRawTSS * sport.sessionsPerWeek;
      crossTrainingBudget += weeklyRaw;
      discountedCrossTraining += weeklyRaw * runSpec;
    }
  }

  // Shift historical TSS to running-only values (clamp to 0 to avoid negatives
  // in weeks where cross-training was below the average).
  const runningOnlyTSS = historicWeeklyTSS?.map(v => Math.max(0, v - discountedCrossTraining));
  const runningOnlyCTL = ctlBaseline != null
    ? Math.max(0, ctlBaseline - discountedCrossTraining)
    : undefined;

  const runningTSS = computePlannedWeekTSS(
    runningOnlyTSS, runningOnlyCTL, phase, athleteTier, runsPerWeek, weekInPhase, totalPhaseWeeks,
  );

  return Math.round(runningTSS + crossTrainingBudget);
}

// ---------------------------------------------------------------------------
// ACWR. Acute:Chronic Workload Ratio
// ---------------------------------------------------------------------------

export type AthleteACWRStatus = 'safe' | 'caution' | 'high' | 'low' | 'unknown';

export interface AthleteACWR {
  ratio: number;          // ATL / CTL
  safeUpper: number;      // Tier-specific safe upper bound
  status: AthleteACWRStatus;
  atl: number;
  ctl: number;
}

/**
 * Per-tier ACWR thresholds and display labels.
 *
 * Range compressed to 1.3-1.5 (was 1.2-1.6) based on science audit:
 * - Gabbett 2016: 0.8-1.3 "sweet spot" is the only range with direct evidence
 * - ACWR >= 1.5 consistently associated with elevated injury risk across populations
 * - Lolli et al. 2019: absolute thresholds are questionable (ratio coupling artifact)
 * - No published per-tier thresholds exist; these are pragmatic interpolations
 *   within the empirically supported 1.3-1.5 range
 * - Higher chronic load (fitness) is protective (Hulin 2016), justifying the gradient
 */
export const TIER_ACWR_CONFIG: Record<string, { safeUpper: number; label: string }> = {
  beginner:     { safeUpper: 1.30, label: 'Building' },
  recreational: { safeUpper: 1.35, label: 'Foundation' },
  trained:      { safeUpper: 1.40, label: 'Trained / Well-Trained' },
  performance:  { safeUpper: 1.45, label: 'Performance' },
  high_volume:  { safeUpper: 1.50, label: 'Elite' },
};

/**
 * Minimum completed days of observed load before an UNSEEDED rolling ACWR is
 * reported. This is the 14-day guard computeRollingLoadRatio has always had; it
 * used to count calendar days since planStartDate (and any archive entry, even
 * an empty one, switched it off). It now counts days that the live plan or an
 * archived plan actually covers, so it measures data, not plan age.
 */
export const ROLLING_ACWR_MIN_OBSERVED_DAYS = 14;

/**
 * Compute rolling 7-day (acute) and 28-day (chronic) Signal B load from actual
 * daily TSS. chronic = 28-day sum / 4 (weekly average); the acute week sits
 * inside the chronic window (coupled ratio, Hulin 2014 / Gabbett 2016).
 *
 * A day is OBSERVED when the live plan or an archived plan has a week covering
 * it: activities are only ever stored on plan weeks, so any other day in the
 * window has no record at all.
 *
 * - With a Signal B seed (signalBSeed > 0): unobserved days are filled with
 *   signalBSeed / 7, the athlete's measured pre-plan weekly load. Unchanged.
 * - Without a seed: an unobserved day is MISSING, not a rest day. Counting it as
 *   0 understated chronic and read steady training as a spike (1.87 'high' on
 *   plan day 14; 4.00 from day 0 once an archive entry bypassed the old guard).
 *   Returns null until ROLLING_ACWR_MIN_OBSERVED_DAYS completed days are
 *   observed. After that the 21 days before the acute week are valued at the
 *   athlete's own mean daily load B/7, taken from the most recent whole weeks
 *   (multiples of 7 days) of observed days in that span, so the weekday mix
 *   cannot bias it:
 *       chronic = (acute + 21 · B/7) / 4 = (acute + 3B) / 4
 *   which is the 28-day coupled chronic the athlete would show had those 21 days
 *   matched their observed baseline (Windt & Gabbett 2019: coupled and uncoupled
 *   ratios map onto each other deterministically for fixed windows). When all 21
 *   days are observed this equals the plain 28-day sum / 4 exactly. A missing day
 *   inside the acute week is valued at B/7 for the same reason.
 *
 * Tracking calculation (describes recent load against chronic load). Planning
 * consumes it: the week advance stamps scheduledAcwrStatus / scheduledChronicTSS
 * from computeACWR, and the ease-back ladder sizes L_max = safeUpper × chronic.
 */
export function computeRollingLoadRatio(
  wks: Week[],
  planStartDate: string,
  signalBSeed?: number,
  norm?: number,
  archivedPlans?: Array<{ planStartDate: string; weeks: any[] }>,
): { acute: number; chronic: number } | null {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const seedDaily = signalBSeed != null && signalBSeed > 0 ? signalBSeed / 7 : 0;

  // Daily Signal B TSS for the last 28 days (index 0 = 27 days ago, 27 = today).
  // null = no live or archived plan week covers the day. _resolveWeekForDate
  // also checks archived plans, so activities from a prior plan keep
  // contributing to ACWR after the user generates a new plan.
  const observed: (number | null)[] = [];
  for (let daysAgo = 27; daysAgo >= 0; daysAgo--) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    const dateStr = d.toISOString().split('T')[0];
    const wk = _resolveWeekForDate(d.getTime(), wks, planStartDate, archivedPlans);
    observed.push(wk ? computeTodaySignalBTSS(wk, dateStr, null, norm) : null);
  }

  if (seedDaily > 0) {
    const daily = observed.map(v => v ?? seedDaily);
    const acute   = daily.slice(-7).reduce((a, b) => a + b, 0);
    const chronic = daily.reduce((a, b) => a + b, 0) / 4; // 28-day sum / 4 = weekly average
    return { acute, chronic };
  }

  // No seed: count observed COMPLETED days (today is still in progress), matching
  // the old guard's "days since plan start".
  const completedObserved = observed.slice(0, 27).filter(v => v != null).length;
  if (completedObserved < ROLLING_ACWR_MIN_OBSERVED_DAYS) return null;

  // Observed days in the 21 days before the acute week. The guard guarantees at
  // least 8 (14 completed observed days, at most 6 of them in the acute week).
  const beforeAcute = observed.slice(0, 21).filter((v): v is number => v != null);
  const wholeWeekDays = Math.floor(beforeAcute.length / 7) * 7;
  if (wholeWeekDays === 0) return null;
  const baselineDays = beforeAcute.slice(beforeAcute.length - wholeWeekDays);
  const baselineDaily = baselineDays.reduce((a, b) => a + b, 0) / baselineDays.length;

  const acute   = observed.slice(-7).reduce<number>((a, v) => a + (v ?? baselineDaily), 0);
  const chronic = (acute + 21 * baselineDaily) / 4;
  return { acute, chronic };
}

// ── Daily load history (for rolling-load chart) ──────────────────────────────

export interface ZoneLoad {
  lowAerobic: number;   // z1 + z2 load-weighted TSS
  highAerobic: number;  // z3 + z4
  anaerobic: number;    // z5
}

export interface DailyLoadEntry {
  date: string;       // ISO YYYY-MM-DD
  tss: number;        // Signal B TSS for the day
  zoneLoad: ZoneLoad; // per-day zone breakdown (load-weighted)
  activities: Array<{
    name: string;     // display name or activity type
    tss: number;
    durationMin: number;
    avgHR?: number | null;
    hrZones?: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
  }>;
}

/**
 * Build 28-day daily load history with per-day activity breakdown.
 * Used by the rolling-load detail view. Days no live or archived plan week
 * covers are drawn at signalBSeed / 7 when a seed is passed, and omitted
 * otherwise (there is no record of them), so the list can be shorter than 28.
 */
/**
 * Resolve which Week (from current `wks` or any archived plan) covers a given
 * date, by mapping the date against each plan's start. Returns null when the
 * date falls outside every plan's range (truly pre-plan history).
 */
function _resolveWeekForDate(
  dateMs: number,
  wks: Week[],
  planStartDate: string,
  archivedPlans?: Array<{ planStartDate: string; weeks: any[] }>,
): Week | null {
  const planStartMs = new Date(planStartDate + 'T12:00:00').getTime();
  const idx = Math.floor((dateMs - planStartMs) / (7 * 86400000));
  if (idx >= 0 && idx < wks.length) return wks[idx];
  // Fall back to archived plans (e.g. previous plan that ended before this one started)
  if (archivedPlans?.length) {
    for (const archive of archivedPlans) {
      const archStartMs = new Date(archive.planStartDate + 'T12:00:00').getTime();
      const aIdx = Math.floor((dateMs - archStartMs) / (7 * 86400000));
      if (aIdx >= 0 && aIdx < archive.weeks.length) return archive.weeks[aIdx] as Week;
    }
  }
  return null;
}

export function getDailyLoadHistory(
  wks: Week[],
  planStartDate: string,
  signalBSeed?: number,
  norm?: number,
  maxHR?: number,
  archivedPlans?: Array<{ planStartDate: string; weeks: any[] }>,
): DailyLoadEntry[] {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const seedDaily = signalBSeed != null && signalBSeed > 0 ? signalBSeed / 7 : 0;

  const entries: DailyLoadEntry[] = [];
  for (let daysAgo = 27; daysAgo >= 0; daysAgo--) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    const dateStr = d.toISOString().split('T')[0];

    const wk = _resolveWeekForDate(d.getTime(), wks, planStartDate, archivedPlans);
    if (!wk) {
      // No plan week covers this day, so there is no record of it. Without a
      // seed it is missing, not a rest day: leave it off the chart rather than
      // draw a zero bar (same rule as computeRollingLoadRatio).
      if (seedDaily > 0) {
        entries.push({ date: dateStr, tss: Math.round(seedDaily), activities: [], zoneLoad: { lowAerobic: 0, highAerobic: 0, anaerobic: 0 } });
      }
      continue;
    }
    const tss = computeTodaySignalBTSS(wk, dateStr, null, norm);
    const activities: DailyLoadEntry['activities'] = [];
    const seenIds = new Set<string>();

    // Collect activities for this day
    for (const [, actual] of Object.entries(wk.garminActuals ?? {})) {
      if (!actual.startTime?.startsWith(dateStr)) continue;
      if (actual.garminId) {
        if (seenIds.has(actual.garminId)) continue;
        seenIds.add(actual.garminId);
      }
      const durMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
      let actTss = 0;
      if (actual.iTrimp != null && actual.iTrimp > 0) {
        actTss = normalizeiTrimp(actual.iTrimp);
      } else {
        actTss = durMin * (TL_PER_MIN[5] ?? 1.15);
      }
      const name = actual.displayName ?? actual.workoutName
        ?? (actual.activityType ? actual.activityType.charAt(0) + actual.activityType.slice(1).toLowerCase().replace(/_/g, ' ') : 'Activity');
      activities.push({ name, tss: Math.round(actTss), durationMin: Math.round(durMin), avgHR: actual.avgHR ?? null, hrZones: actual.hrZones ?? null });
    }

    // Adhoc workouts. Skip planned sessions (adhoc-/holiday-/benchmark-): prescriptions, not real activity
    const ourDay = (d.getDay() + 6) % 7;
    for (const w of wk.adhocWorkouts ?? []) {
      if (isPlannedAdhocId(w.id)) continue;
      // Twin of a garminActuals entry: listed above, and skipped by
      // computeTodaySignalBTSS (the day's tss), even after a Strava upgrade
      // has changed the twin's garminId.
      if (w.id && (wk.garminActuals as any)?.[w.id]) continue;
      const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
      if (rawId) {
        if (seenIds.has(rawId)) continue;
        const ts = (w as any).garminTimestamp as string | undefined;
        if (!ts?.startsWith(dateStr)) continue;
        seenIds.add(rawId);
      } else {
        if ((w as any).dayOfWeek !== ourDay) continue;
      }
      const durMin = parseDurMinFromDesc(w.d);
      let actTss = 0;
      if (w.iTrimp != null && w.iTrimp > 0) {
        actTss = normalizeiTrimp(w.iTrimp, norm);
      } else {
        const rpe = w.rpe ?? w.r ?? 5;
        actTss = durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
      }
      const name = w.n ?? w.t ?? 'Activity';
      // Don't double-count if already seen via garminActuals
      if (!activities.some(a => a.name === name && Math.abs(a.durationMin - Math.round(durMin)) < 2)) {
        activities.push({ name, tss: Math.round(actTss), durationMin: Math.round(durMin) });
      }
    }

    // Compute per-day zone load: for each activity with HR zones, distribute TSS
    // proportionally by time spent in each zone bucket.
    // When hrZones is missing but avgHR is available, estimate zone from avgHR.
    const zoneLoad: ZoneLoad = { lowAerobic: 0, highAerobic: 0, anaerobic: 0 };
    for (const a of activities) {
      if (a.hrZones) {
        const { z1, z2, z3, z4, z5 } = a.hrZones;
        const total = z1 + z2 + z3 + z4 + z5;
        if (total > 0) {
          zoneLoad.lowAerobic += a.tss * (z1 + z2) / total;
          zoneLoad.highAerobic += a.tss * (z3 + z4) / total;
          zoneLoad.anaerobic += a.tss * z5 / total;
          continue;
        }
      }
      // Estimate zone from avgHR when stream data is unavailable.
      // Uses same %maxHR thresholds as calculateHRZones in the edge function.
      if (a.avgHR && a.avgHR > 0 && maxHR && maxHR > 0) {
        const pct = a.avgHR / maxHR;
        if (pct >= 0.90)      zoneLoad.anaerobic += a.tss;
        else if (pct >= 0.70) zoneLoad.highAerobic += a.tss;
        else                  zoneLoad.lowAerobic += a.tss;
        continue;
      }
      // Last resort. Attribute to low aerobic
      zoneLoad.lowAerobic += a.tss;
    }
    entries.push({ date: dateStr, tss: Math.round(tss), activities, zoneLoad });
  }
  return entries;
}

/**
 * Compute the Acute:Chronic Workload Ratio for the current point in the plan.
 *
 * Rolling mode returns status='unknown' until there is a Signal B seed or
 * ROLLING_ACWR_MIN_OBSERVED_DAYS observed days (see computeRollingLoadRatio).
 * The weekly-EMA fallback (no planStartDate) needs 3 completed weeks.
 *
 * When signalBSeed is provided (recommended), both CTL and ATL use Signal B
 * (raw physiological TSS, no runSpec discount). This correctly handles cross-training
 * athletes whose Signal A CTL understates their true chronic load. Using a mixed
 * signal (Signal A CTL, Signal B ATL) causes ACWR to appear artificially low.
 *
 * Two computation modes:
 * 1. **Rolling (preferred)**: When planStartDate is available, uses a true rolling
 *    7-day (acute) / 28-day (chronic) window over actual daily TSS. No weekly
 *    bucket artifacts. A half marathon on Saturday is fully reflected on Sunday.
 *    Days no plan covers are filled with signalBSeed / 7 (historical daily
 *    average); without a seed they are missing and valued at the athlete's own
 *    observed baseline.
 * 2. **Weekly EMA (fallback)**: Only when planStartDate is missing (or there are
 *    no weeks at all). Uses the EMA-based approach on completed weeks only.
 *
 * @param wks - All weeks in the plan
 * @param currentWeek - Current 1-indexed week number
 * @param athleteTier - Optional athlete tier key; defaults to 'recreational'
 * @param ctlSeed - Signal A CTL seed from Strava history (legacy fallback path only)
 * @param planStartDate - ISO date string; required for rolling mode
 * @param atlSeed - Signal B ATL seed (legacy fallback path only)
 * @param signalBSeed - Signal B historical baseline. Used as pre-plan daily fill
 */
export function computeACWR(
  wks: Week[],
  currentWeek: number,
  athleteTier?: string,
  ctlSeed?: number,
  planStartDate?: string,
  atlSeed?: number,
  signalBSeed?: number,
  norm?: number,
  archivedPlans?: Array<{ planStartDate: string; weeks: any[] }>,
  adaptiveRecovery?: import('@/types/state').AdaptiveRecovery,
): AthleteACWR {
  const tier = athleteTier ?? 'recreational';
  const tierCfg = TIER_ACWR_CONFIG[tier] ?? TIER_ACWR_CONFIG.recreational;
  // Effective ceiling: tier baseline plus any personal-recovery shift (only
  // non-zero at adaptiveRecovery confidence = high). See adaptive-recovery.ts.
  const safeUpper = getEffectiveSafeUpper(tierCfg.safeUpper, adaptiveRecovery);

  let ctl: number;
  let atl: number;

  // ── Rolling 7d/28d approach (preferred) ──────────────────────────────────────
  // Uses actual daily TSS from activities. No weekly-bucket artifacts: a hard
  // session on Saturday is immediately reflected on Sunday, and a partial week
  // doesn't cliff-drop the ratio.
  if (planStartDate && (wks.length > 0 || archivedPlans?.length)) {
    const rolling = computeRollingLoadRatio(wks, planStartDate, signalBSeed, norm, archivedPlans);
    // null = no Signal B seed and fewer than ROLLING_ACWR_MIN_OBSERVED_DAYS
    // observed days. Report 'unknown'. The weekly-EMA fallback below must not
    // stand in: for an unseeded athlete it starts from zero (pre-plan weeks read
    // as rest), and it is only reachable here when s.w runs ahead of the
    // calendar (simulator / "Complete week"), where it read a false spike.
    if (!rolling) return { ratio: 0, safeUpper, status: 'unknown', atl: 0, ctl: 0 };

    ctl = rolling.chronic;
    atl = rolling.acute;

    if (ctl < 1) {
      return { ratio: 0, safeUpper, status: 'unknown', atl, ctl };
    }

    const ratio = atl / ctl;
    let status: AthleteACWRStatus;
    if (ratio < 0.8) status = 'low';
    else if (ratio <= safeUpper) status = 'safe';
    else if (ratio <= safeUpper + 0.2) status = 'caution';
    else status = 'high';
    return { ratio, safeUpper, status, atl, ctl };
  }

  // ── Weekly EMA fallback ──────────────────────────────────────────────────────
  // Used when planStartDate is missing or rolling data is insufficient.
  const completedLimit = Math.min(Math.max(0, currentWeek - 1), wks.length);

  if (completedLimit < 3) {
    return { ratio: 0, safeUpper, status: 'unknown', atl: 0, ctl: 0 };
  }

  if (signalBSeed != null) {
    const result = computeSameSignalTSB(wks, Math.max(0, currentWeek - 1), signalBSeed, planStartDate, undefined, archivedPlans);
    if (!result) return { ratio: 0, safeUpper, status: 'unknown', atl: 0, ctl: 0 };
    ctl = result.ctl;
    atl = result.atl;
  } else {
    const metrics = computeFitnessModel(wks, completedLimit, ctlSeed, planStartDate, atlSeed, undefined, archivedPlans);
    if (metrics.length < 3) {
      const latest = metrics[metrics.length - 1];
      return { ratio: 0, safeUpper, status: 'unknown', atl: latest?.atl ?? 0, ctl: latest?.ctl ?? 0 };
    }
    const latest = metrics[metrics.length - 1];
    ctl = latest.ctl;
    atl = latest.atl;
  }

  if (ctl < 1) {
    // CTL too low to compute a meaningful ratio (first few weeks of zero training)
    return { ratio: 0, safeUpper, status: 'unknown', atl, ctl };
  }

  const ratio = atl / ctl;

  let status: AthleteACWRStatus;
  if (ratio < 0.8) {
    status = 'low'; // undertraining / intentional deload
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
 * Compute the weekly running km floor for a given training week.
 * Floor scales linearly from an early-phase minimum to a peak-phase target,
 * based on the athlete's marathon pace tier.
 * Returns 0 during taper (volume drop is deliberate, not a problem to fix).
 *
 * Tiers: fast (sub 3:30) → 20–35 km, mid (3:30–4:30) → 15–25 km, finish (4:30+) → 10–18 km.
 */
export function computeRunningFloorKm(
  marathonPaceSecPerKm: number | undefined,
  currentWeek: number,
  totalWeeks: number,
  phase?: string,
): number {
  if (phase === 'taper') return 0;
  const mTimeSec = (marathonPaceSecPerKm ?? 360) * 42.195;
  const floorTier = mTimeSec < 3.5 * 3600 ? 'fast' : mTimeSec < 4.5 * 3600 ? 'mid' : 'finish';
  const peakFloor = floorTier === 'fast' ? 35 : floorTier === 'mid' ? 25 : 18;
  const earlyFloor = floorTier === 'fast' ? 20 : floorTier === 'mid' ? 15 : 10;
  return earlyFloor + (peakFloor - earlyFloor) * Math.min(1, Math.max(0, (currentWeek - 2)) / Math.max(1, totalWeeks - 1));
}

/**
 * Compute CTL, ATL, TSB for each completed week in order.
 * Returns one entry per week up to (but not including) currentWeek.
 *
 * @param ctlSeed - Optional CTL starting value from Strava history (seeds Signal A chronic baseline)
 * @param planStartDate - ISO date of plan week 1 (Signal B's double-day bonus maps workout days to dates)
 * @param atlSeed - Optional Signal B ATL seed. When omitted, derived from ctlSeed × 1.0.
 *   Callers who know the user's cross-training history should pass a higher value (e.g. ctlSeed × 1.2
 *   for gym-heavy athletes) so ACWR reflects real fatigue from day one.
 */
/**
 * Walk archived plans + current `wks` chronologically. Yields every completed
 * week tagged with the planStartDate it belongs to (matters for
 * computeWeekRawTSS's double-day bonus, which maps each workout's dayOfWeek to
 * a date from the plan's own start date. Passing the current plan's date when
 * iterating an archived week would put its sessions on the wrong dates).
 *
 * Why this exists: when the user generates a new plan, every chronic-load
 * walker (computeSameSignalTSB, computeFitnessModel) needs to keep seeing the
 * training that came before, otherwise CTL collapses to whatever signalBBaseline
 * happens to be and the freshness ring reports a phantom "Overloaded" state.
 *
 * Archive truncation in `_truncateArchivesAtPlanBoundary` already prevents
 * archive weeks overlapping with current `wks`, so chronological concatenation
 * cannot double-count.
 */
export type ArchivedPlan = { planStartDate: string; weeks: any[] };

function* _walkChronologicalWeeks(
  wks: Week[],
  currentWeek: number,
  planStartDate: string | undefined,
  archivedPlans: ArchivedPlan[] | undefined,
): Generator<{ wk: Week; planStartDate: string | undefined }> {
  if (archivedPlans?.length) {
    const sorted = [...archivedPlans].sort((a, b) =>
      (a.planStartDate ?? '').localeCompare(b.planStartDate ?? ''),
    );
    for (const archive of sorted) {
      for (const wk of (archive.weeks ?? [])) {
        yield { wk: wk as Week, planStartDate: archive.planStartDate };
      }
    }
  }
  const limit = Math.min(currentWeek, wks.length);
  for (let i = 0; i < limit; i++) {
    yield { wk: wks[i], planStartDate };
  }
}

export function computeFitnessModel(
  wks: Week[],
  currentWeek: number,
  ctlSeed?: number,
  planStartDate?: string,
  atlSeed?: number,
  norm?: number,
  archivedPlans?: ArchivedPlan[],
): FitnessMetrics[] {
  const results: FitnessMetrics[] = [];
  let ctl = ctlSeed ?? 0;
  let atl = atlSeed ?? ctlSeed ?? 0; // Signal B seed. Higher than CTL for cross-training athletes

  for (const { wk, planStartDate: wkPlanStart } of _walkChronologicalWeeks(wks, currentWeek, planStartDate, archivedPlans)) {
    const rated = wk.rated ?? {};
    const weekTSS = computeWeekTSS(wk, rated, wkPlanStart, norm);
    // Signal B: raw physiological TSS (no runSpec discount). Used for ATL/fatigue
    const weekRawTSS = computeWeekRawTSS(wk, rated, wkPlanStart, norm);

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
 * One-step CTL adherence ratio for a single completed week: actual chronic load ÷ the chronic
 * load the plan expected, both advanced one CTL step from the SAME prior-week seed.
 *
 *   expectedCTL = priorCtl·d + plannedWeekTSS·(1−d)
 *   actualCTL   = priorCtl·d + actualWeekTSS·(1−d)        where d = CTL_DECAY (≈ 0.847)
 *   ratio       = actualCTL / expectedCTL
 *
 * Because the shared seed is weighted ~85%, a single missed week moves the ratio by only ~15% of
 * the load shortfall — the dead-zone intuition (Mujika & Padilla 2000: one week off detrains
 * little) falls out of the arithmetic rather than from a hand-picked constant. The effect
 * compounds correctly across consecutive weeks because next week's seed is this week's now-lower
 * actual CTL, and it self-limits because expectedCTL also decays toward the maintenance load.
 *
 * Returns 1.0 (neutral) when there is no prescribed load to fall behind on (taper / rest /
 * no plan) or the inputs are degenerate. The consumer treats ratio < 1 as "behind".
 *
 * Tracking-vs-planning note: this is a PLANNING signal (it prescribes next week's volume), and it
 * scales DURATION only. It is deliberately orthogonal to the existing adherence→VDOT-gain gate
 * (events.ts), which withholds VDOT increments — an intensity/pace axis — when runs are missed.
 * Two different axes, no double-count.
 */
export function ctlAdherenceRatio(
  priorCtl: number,
  plannedWeekTSS: number,
  actualWeekTSS: number,
): number {
  if (!Number.isFinite(plannedWeekTSS) || plannedWeekTSS <= 0) return 1;
  const seed = Number.isFinite(priorCtl) && priorCtl > 0 ? priorCtl : 0;
  const expected = seed * CTL_DECAY + plannedWeekTSS * (1 - CTL_DECAY);
  const actual = seed * CTL_DECAY + Math.max(0, actualWeekTSS) * (1 - CTL_DECAY);
  if (expected <= 0) return 1;
  // Zero-seed (brand-new athlete, no chronic-load history): the shared seed·d term vanishes, so the
  // ratio collapses to actualWeekTSS / plannedWeekTSS — the un-damped completion fraction. That's
  // the correct behaviour: with no fitness history there is no "you've banked load" cushion, so a
  // missed first week re-anchors fully rather than gently. The damping returns as CTL accrues.
  return actual / expected;
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
 * consistent training load. Reflecting actual balance, not the A/B discount gap.
 */
export function computeSameSignalTSB(
  wks: Week[],
  currentWeek: number,
  ctlSeed?: number,
  planStartDate?: string,
  norm?: number,
  archivedPlans?: ArchivedPlan[],
): { ctl: number; atl: number; tsb: number } | null {
  // s.w is 1-indexed: wks[s.w-1] is the current week. limit = currentWeek (not +1)
  // so the loop covers wks[0..s.w-1], including today's completed activities without
  // inadvertently processing wks[s.w] (next week, 0 actuals) which would collapse ATL.
  const limit = Math.min(currentWeek, wks.length);
  const archivedWeekCount = archivedPlans?.reduce((n, a) => n + (a.weeks?.length ?? 0), 0) ?? 0;
  if (limit === 0 && archivedWeekCount === 0) return null;

  let ctl = ctlSeed ?? 0;
  let atl = ctlSeed ?? 0; // same seed. No gym-inflation offset

  for (const { wk, planStartDate: wkPlanStart } of _walkChronologicalWeeks(wks, currentWeek, planStartDate, archivedPlans)) {
    const rated = wk.rated ?? {};
    const weekRawTSS = computeWeekRawTSS(wk, rated, wkPlanStart, norm);

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

/**
 * Same-signal (Signal B) CTL at the end of each walked week, oldest first.
 * Same seed and same walk as computeSameSignalTSB, so the last entry equals
 * computeSameSignalTSB(...).ctl for the same arguments.
 *
 * Use it wherever "CTL now" (computeLiveSameSignalTSB, Signal B) is compared
 * with CTL some weeks ago: both ends of a trend must be on one signal. Mixing
 * a Signal B "now" with a Signal A history reads the runSpec discount on
 * cross-training as a fitness gain.
 */
export function computeSameSignalCtlHistory(
  wks: Week[],
  currentWeek: number,
  ctlSeed?: number,
  planStartDate?: string,
  norm?: number,
  archivedPlans?: ArchivedPlan[],
): number[] {
  const out: number[] = [];
  let ctl = ctlSeed ?? 0;
  for (const { wk, planStartDate: wkPlanStart } of _walkChronologicalWeeks(wks, currentWeek, planStartDate, archivedPlans)) {
    const weekRawTSS = computeWeekRawTSS(wk, wk.rated ?? {}, wkPlanStart, norm);
    ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY);
    out.push(ctl);
  }
  return out;
}

export interface WeeklyAcwrEntry { week: number; ratio: number; rawTSS: number; }

/**
 * Weekly Signal B ACWR (EMA ATL ÷ EMA CTL) at the end of each completed live-plan
 * week. Feeds the Load Ratio page's weekly trend bars and its "most recent
 * completed week hit N×" line.
 *
 * - Seeded (seed > 0): both EMAs start at the seed. Unchanged.
 * - Unseeded: there is no record before week 1, so starting both EMAs at 0
 *   treated every earlier week as rest and read steady training as a spike
 *   (4.1, 3.1, 2.4, 2.0 in weeks 1 to 4). Each EMA is instead bias-corrected:
 *   after t weeks it is divided by (1 − decay^t), the share of its weight that
 *   sits on observed weeks, which makes it the decay-weighted mean of the
 *   observed weeks only. This is the standard correction for a zero-initialised
 *   EMA (Kingma & Ba 2015). Steady training reads 1.0 from week 1. Limitation:
 *   with only a few weeks the chronic mean leans on the latest week, so an early
 *   spike reads lower than a seeded athlete's would (never higher).
 *
 * Tracking calculation (display only; no plan logic reads it).
 */
export function computeWeeklyAcwrHistory(
  wks: Week[],
  completedWeek: number,
  seed: number | undefined,
  planStartDate?: string,
): WeeklyAcwrEntry[] {
  const hasSeed = seed != null && seed > 0;
  let ctl = hasSeed ? seed : 0;
  let atl = hasSeed ? seed : 0;
  let ctlUnobservedWeight = 1; // CTL_DECAY^t: weight still sitting on the (missing) start value
  let atlUnobservedWeight = 1; // ATL_DECAY^t
  const results: WeeklyAcwrEntry[] = [];
  const limit = Math.min(completedWeek, wks.length);
  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const weekRawTSS = computeWeekRawTSS(wk, wk.rated ?? {}, planStartDate);
    ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY);
    atl = atl * ATL_DECAY + weekRawTSS * (1 - ATL_DECAY);
    ctlUnobservedWeight *= CTL_DECAY;
    atlUnobservedWeight *= ATL_DECAY;
    const ctlEst = hasSeed ? ctl : ctl / (1 - ctlUnobservedWeight);
    const atlEst = hasSeed ? atl : atl / (1 - atlUnobservedWeight);
    const ratio = ctlEst > 1 ? atlEst / ctlEst : 0;
    results.push({ week: wk.w, ratio, rawTSS: weekRawTSS });
  }
  return results;
}

/**
 * Canonical ACWR call for the readiness surfaces. Centralised so home, readiness,
 * daily-coach, and any future view share one set of arguments and one result.
 */
export function computeReadinessACWR(s: {
  wks?: Week[];
  w: number;
  athleteTier?: string | null;
  athleteTierOverride?: string | null;
  ctlBaseline?: number | null;
  signalBBaseline?: number | null;
  planStartDate?: string;
  gs?: number | null;
  previousPlanWks?: Array<{ planStartDate: string; weeks: any[] }>;
  adaptiveRecovery?: import('@/types/state').AdaptiveRecovery;
}) {
  const tier = s.athleteTierOverride ?? s.athleteTier ?? undefined;
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  return computeACWR(
    s.wks ?? [],
    s.w,
    tier ?? undefined,
    s.ctlBaseline ?? undefined,
    s.planStartDate,
    atlSeed,
    s.signalBBaseline ?? undefined,
    undefined,
    s.previousPlanWks,
    s.adaptiveRecovery,
  );
}

/**
 * Same-signal TSB with intra-week decay applied from the end of the last completed
 * week up to today, so the value reflects accumulated load this week (not the stale
 * week-end snapshot). Used by Home + Readiness views so their scores stay in sync.
 *
 * Math: seeds from `computeSameSignalTSB(wks, s.w - 1)`, then for each elapsed day
 * of the current week applies daily ATL/CTL decay with that day's Signal-B TSS.
 */
export function computeLiveSameSignalTSB(
  wks: Week[],
  currentWeekIdx: number, // s.w (1-indexed)
  signalBBaseline: number | undefined,
  ctlBaseline: number | undefined,
  planStartDate?: string,
  archivedPlans?: ArchivedPlan[],
): { ctl: number; atl: number; tsb: number } {
  const completedWeek = Math.max(0, currentWeekIdx - 1);
  const seed = signalBBaseline ?? ctlBaseline ?? 0;
  const sameSignal = computeSameSignalTSB(wks ?? [], completedWeek, seed, planStartDate, undefined, archivedPlans);
  let atl = sameSignal?.atl ?? 0;
  let ctl = sameSignal?.ctl ?? 0;

  if (planStartDate) {
    const ATL_DAILY_DECAY = Math.exp(-1 / 7);
    const CTL_DAILY_DECAY = Math.exp(-1 / 42);
    const weekStartDate = new Date(planStartDate + 'T12:00:00');
    weekStartDate.setDate(weekStartDate.getDate() + completedWeek * 7);
    const todayDate = new Date();
    todayDate.setHours(12, 0, 0, 0);
    const daysIntoWeek = Math.max(0, Math.round((todayDate.getTime() - weekStartDate.getTime()) / 86400000));
    const currentWk = (wks ?? [])[completedWeek];
    for (let d = 0; d < daysIntoWeek; d++) {
      const dayD = new Date(weekStartDate);
      dayD.setDate(dayD.getDate() + d);
      const dayDate = dayD.toISOString().split('T')[0];
      const dayTSS = currentWk ? computeTodaySignalBTSS(currentWk, dayDate) : 0;
      const weekEquiv = dayTSS * 7;
      atl = atl * ATL_DAILY_DECAY + weekEquiv * (1 - ATL_DAILY_DECAY);
      ctl = ctl * CTL_DAILY_DECAY + weekEquiv * (1 - CTL_DAILY_DECAY);
    }
  }

  return { ctl, atl, tsb: ctl - atl };
}

/**
 * Stacked session recovery: "To Baseline" hours.
 *
 * Walks forward chronologically through recent sessions (current week + last 3 days of
 * previous week). Each session adds `k × TSS / ctlDaily × recoveryMult × recoveryAdj`
 * hours to the running total. Elapsed time ticks down between sessions and after the last.
 *
 * `k` defaults to the population value of 8 but is replaced by the user's
 * learned `kUserHours` when `adaptiveRecovery` confidence reaches medium. See
 * `adaptive-recovery.ts` for the fitter.
 *
 * recoveryAdj comes from sleep/HRV/RHR (computeRecoveryScore).
 * recoveryMult comes from sport type (SPORTS_DB).
 */
export function computeToBaseline(
  wks: Week[],
  completedWeek: number,
  ctlDaily: number,
  planStartDate: string | undefined,
  physiologyHistory: PhysiologyDayEntry[] | undefined,
  adaptiveRecovery?: import('@/types/state').AdaptiveRecovery,
): { hours: number; totalHours: number } | null {
  if (!planStartDate || ctlDaily <= 0) return null;

  const weekStartDate = new Date(planStartDate + 'T12:00:00');
  weekStartDate.setDate(weekStartDate.getDate() + completedWeek * 7);
  const nowMs = Date.now();

  // Global recovery adjustment from sleep/HRV/RHR
  let recoveryAdj = 1.0;
  const recScore = computeRecoveryScore(physiologyHistory ?? []);
  if (recScore?.score != null) {
    recoveryAdj = 1.0 + (50 - recScore.score) * 0.006;
    recoveryAdj = Math.max(0.7, Math.min(1.3, recoveryAdj));
  }

  // Personal recovery rate (k_user). Falls back to population default of 8
  // until adaptiveRecovery confidence reaches medium. See `getEffectiveKUser`
  // in adaptive-recovery.ts for the gating policy.
  const kUser = getEffectiveKUser(adaptiveRecovery);

  // Collect recent days
  type DayEntry = { date: string; tss: number; noonMs: number; weekIdx: number };
  const recentDays: DayEntry[] = [];

  // Previous week's last 3 days
  if (completedWeek > 0) {
    const prevWk = wks[completedWeek - 1];
    if (prevWk) {
      for (let d = 4; d < 7; d++) {
        const dayD = new Date(weekStartDate);
        dayD.setDate(dayD.getDate() - (7 - d));
        const dayDate = dayD.toISOString().split('T')[0];
        const tss = computeTodaySignalBTSS(prevWk, dayDate);
        recentDays.push({ date: dayDate, tss, noonMs: dayD.getTime(), weekIdx: completedWeek - 1 });
      }
    }
  }

  // Current week: day 0 to today
  const todayLocal = new Date();
  todayLocal.setHours(12, 0, 0, 0);
  const daysToCheck = Math.max(0, Math.round((todayLocal.getTime() - weekStartDate.getTime()) / 86400000)) + 1;
  const currentWk = wks[completedWeek];
  for (let d = 0; d < daysToCheck; d++) {
    const dayD = new Date(weekStartDate);
    dayD.setDate(dayD.getDate() + d);
    const dayDate = dayD.toISOString().split('T')[0];
    const tss = currentWk ? computeTodaySignalBTSS(currentWk, dayDate) : 0;
    recentDays.push({ date: dayDate, tss, noonMs: dayD.getTime(), weekIdx: completedWeek });
  }

  const sessions = recentDays
    .filter(d => d.tss > 10)
    .sort((a, b) => a.noonMs - b.noonMs);

  if (sessions.length === 0) return null;

  let runningRecoveryMs = 0;
  let lastEndMs = sessions[0].noonMs;
  let totalRecoverySum = 0;

  for (const session of sessions) {
    let weightedRecoveryMult = 1.0;
    let sessionEndMs = session.noonMs;
    const wk = wks[session.weekIdx];
    if (wk?.garminActuals) {
      let totalTss = 0;
      let weightedSum = 0;
      for (const [id, actual] of Object.entries(wk.garminActuals)) {
        if (!actual.startTime?.startsWith(session.date)) continue;
        const sportKey = actual.activityType ? normalizeSport(actual.activityType) : 'generic_sport';
        const config = SPORTS_DB[sportKey];
        const rm = config?.recoveryMult ?? 1.0;
        // RPE-aware fallback when iTrimp is missing. Mirrors the Signal A/B pattern
        // at line 1148-1150. Without this, no-HR cross-training contributed only raw
        // duration to the recovery countdown, so a brutal 90-min Padel session with
        // no HR signal but rated 9/10 read identically to an easy 90-min walk.
        let actTss: number;
        if (actual.iTrimp != null && actual.iTrimp > 0) {
          actTss = normalizeiTrimp(actual.iTrimp); // personal normalizer (ISSUE-262)
        } else {
          const durMin = (actual.durationSec ?? 0) / 60;
          const rated = wk.rated?.[id];
          const adhoc = wk.adhocWorkouts?.find(w => w.id === id);
          const rpe = (typeof rated === 'number' ? rated : null)
            ?? adhoc?.rpe
            ?? adhoc?.r
            ?? 5;
          actTss = durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
        }
        totalTss += actTss;
        weightedSum += actTss * rm;
        const startMs = new Date(actual.startTime).getTime();
        const endMs = startMs + (actual.durationSec ?? 0) * 1000;
        if (endMs > sessionEndMs) sessionEndMs = endMs;
      }
      if (totalTss > 0) weightedRecoveryMult = weightedSum / totalTss;
    }

    const elapsed = Math.max(0, sessionEndMs - lastEndMs);
    runningRecoveryMs = Math.max(0, runningRecoveryMs - elapsed);

    const sessionRecovery = kUser * session.tss / ctlDaily * weightedRecoveryMult * recoveryAdj;
    runningRecoveryMs += sessionRecovery * 3600000;
    totalRecoverySum += sessionRecovery;
    lastEndMs = sessionEndMs;
  }

  const elapsedSinceLast = Math.max(0, nowMs - lastEndMs);
  runningRecoveryMs = Math.max(0, runningRecoveryMs - elapsedSinceLast);

  return {
    hours: Math.round(runningRecoveryMs / 3600000),
    totalHours: Math.round(totalRecoverySum),
  };
}
