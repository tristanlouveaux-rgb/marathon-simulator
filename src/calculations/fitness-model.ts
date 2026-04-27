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

import type { Week, Workout, PhysiologyDayEntry } from '@/types';
import type { ReadinessLabel } from '@/calculations/readiness';
import { TL_PER_MIN, SPORTS_DB } from '@/constants';
import { normalizeSport } from '@/cross-training/activities';
import { computeRecoveryScore } from '@/calculations/readiness';

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
 *   BUT TL_PER_MIN[2]=0.45 for RPE2 gives 9 × 0.45 = 4.05 — much higher.
 *   Compromise: 1.0 TSS per 1,000 steps. Conservative enough that background
 *   walking (5-10k steps) adds 5-10 TSS — meaningful on rest days, noise on
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
 *   - Manage Load: 100% of base (visual nudge only — amber marker)
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
 * Training: ±15% — accounts for pace/effort execution variation.
 * Adhoc:    ±30% — wider, no specific plan to match.
 * Rest:     0 to base — anything above the base is overreaching.
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
 * @param totalSteps        — total daily steps from physiologyHistory
 * @param activeMinutes     — total active minutes from Garmin epochs / Apple Watch exercise ring
 * @param loggedActivities  — today's logged activities (for subtraction)
 * @param tssPerActiveMinute — personal calibration, or PASSIVE_TSS_PER_ACTIVE_MIN fallback
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
  ctl: number;      // Chronic Training Load (42-day EMA) — Signal A (run-equivalent)
  atl: number;      // Acute Training Load (7-day EMA) — Signal B (raw physiological)
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
 * normalizer = 3600 × LTHR_HRR × e^(β × LTHR_HRR) where β = 1.92 (male default).
 * Falls back to 15000 when LTHR data is unavailable.
 */
export function computeAthleteNormalizer(ltHR?: number, restingHR?: number, maxHR?: number): number {
  if (!ltHR || !restingHR || !maxHR || maxHR <= restingHR || ltHR <= restingHR || ltHR >= maxHR) {
    return 15000; // fallback
  }
  const hrr = (ltHR - restingHR) / (maxHR - restingHR);
  const beta = 1.92; // Banister male coefficient (standard)
  return 3600 * hrr * Math.exp(beta * hrr);
}

/** Convenience: compute normalizer from a state-like object. */
export function getNormalizerFromState(s: { ltHR?: number; restingHR?: number; maxHR?: number }): number {
  return computeAthleteNormalizer(s.ltHR, s.restingHR, s.maxHR);
}

// Module-level normalizer — set once on startup via setAthleteNormalizer(),
// then used by all iTRIMP→TSS conversions. Falls back to 15000 if never set.
let _athleteNorm = 15000;

/** Call once on startup (and when HR profile changes) to set the per-athlete normalizer. */
export function setAthleteNormalizer(ltHR?: number, restingHR?: number, maxHR?: number): void {
  _athleteNorm = computeAthleteNormalizer(ltHR, restingHR, maxHR);
}

/** Normalise iTRIMP to a TSS-equivalent TL value. 1 hour at LTHR = 100 TSS. */
function normalizeiTrimp(itrimp: number, normalizer?: number): number {
  return (itrimp * 100) / (normalizer ?? _athleteNorm);
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
  norm?: number,
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
    // Skip if garminActuals already covers this entry (Strava-upgraded data wins)
    if (w.id && (wk.garminActuals as any)?.[w.id]) continue;
    const rawId = w.id.slice('garmin-'.length);
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
    }
    // If the workout type indicates a run, always use runSpec=1.0 regardless of name.
    // This handles activities logged with a non-run name (e.g. "General Sport 1") that
    // were originally classified as runs (appType='run' → t='easy').
    const NON_RUN_TYPES = new Set(['cross', 'gym', 'strength', 'rest']);
    const isRunType = !NON_RUN_TYPES.has(w.t ?? 'cross');
    let runSpec: number;
    if (isRunType) {
      runSpec = 1.0;
    } else {
      const sport = normalizeSport(w.n.replace(' (Garmin)', '').toLowerCase());
      const cfg = (SPORTS_DB as any)[sport];
      runSpec = cfg?.runSpec ?? 0.35;
    }
    if (w.iTrimp != null && w.iTrimp > 0) {
      // Strava HR stream iTrimp available — more accurate than RPE estimate
      tl += normalizeiTrimp(w.iTrimp, norm) * runSpec;
    } else {
      const rpe = w.rpe ?? 5;
      const durMin = parseDurMinFromDesc(w.d);
      tl += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15) * runSpec;
    }
  }

  // Unspent load items (cross-training overflow not matched to a plan slot).
  // Filter to this week's date range when planStartDate is known — carry-over items
  // from previous weeks retain their original dates and must not inflate this week's TSS.
  // Skip 'surplus_run' items — the full activity is already counted in garminActuals above;
  // adding the surplus portion again would double-count that load.
  let weekStartMs: number | null = null;
  let weekEndMs: number | null = null;
  if (planStartDate && wk.w != null) {
    weekStartMs = new Date(planStartDate).getTime() + (wk.w - 1) * 7 * 86400000;
    weekEndMs = weekStartMs + 7 * 86400000;
  }
  for (const item of wk.unspentLoadItems ?? []) {
    if (item.reason === 'surplus_run') continue;
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
  norm?: number,
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
  // Skip holiday-generated sessions ('holiday-') — these are suggestions, not real activity.
  for (const w of wk.adhocWorkouts ?? []) {
    if (w.id?.startsWith('holiday-') || w.id?.startsWith('adhoc-')) continue;
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

  // Unspent load items — runSpec = 1.0
  // Skip 'surplus_run' items — the full activity is already counted in garminActuals above;
  // the surplus portion is part of that activity and must not be added again.
  let weekStartMs: number | null = null;
  let weekEndMs: number | null = null;
  if (planStartDate && wk.w != null) {
    weekStartMs = new Date(planStartDate).getTime() + (wk.w - 1) * 7 * 86400000;
    weekEndMs = weekStartMs + 7 * 86400000;
  }
  for (const item of wk.unspentLoadItems ?? []) {
    if (item.reason === 'surplus_run') continue;
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
 * Compute today's Signal B TSS from activities completed so far today.
 * Mirrors computeWeekRawTSS but scoped to a single calendar day via startTime.
 * Used for the live Strain Score on the Home view.
 *
 * @param wk    — current plan week
 * @param today — ISO date string (YYYY-MM-DD)
 * @param passiveActivity — today's epoch data { activeMinutes, highlyActiveMinutes } from Garmin.
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

  // garminActuals — filter to today by startTime
  for (const [, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (!actual.startTime?.startsWith(today)) continue;
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const actDurMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
    workoutMinutes += actDurMin;
    if (actual.iTrimp != null && actual.iTrimp > 0) {
      tl += normalizeiTrimp(actual.iTrimp);
    } else {
      tl += actDurMin * (TL_PER_MIN[5] ?? 1.15);
    }
  }

  // adhocWorkouts — garmin-prefixed filtered by garminTimestamp; non-garmin matched by dayOfWeek
  // Skip holiday-generated sessions ('holiday-') — these are suggestions, not real activity.
  for (const w of wk.adhocWorkouts ?? []) {
    if (w.id?.startsWith('holiday-') || w.id?.startsWith('adhoc-')) continue;
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

  // unspentLoadItems — filter by exact date match
  for (const item of wk.unspentLoadItems ?? []) {
    if (item.date !== today) continue;
    if (item.garminId) {
      if (seenGarminIds.has(item.garminId)) continue;
      seenGarminIds.add(item.garminId);
    }
    tl += item.durationMin * (TL_PER_MIN[5] ?? 1.15);
  }

  // Passive strain: non-workout active minutes contribute background TSS.
  // Subtract workout duration from total active minutes to avoid double-counting
  // (epochs include workout time as HIGHLY_ACTIVE).
  if (passiveActivity?.activeMinutes != null && passiveActivity.activeMinutes > 0) {
    const passiveActiveMin = Math.max(0, passiveActivity.activeMinutes - workoutMinutes);
    tl += passiveActiveMin * PASSIVE_TSS_PER_ACTIVE_MIN;
  }

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
 * Estimate Signal B TSS for a day's planned workouts (no actual data yet).
 * Used as the strain target on training days so 100% = "you completed your plan".
 *
 * Uses the same RPE × TL_PER_MIN fallback as computeTodaySignalBTSS (no runSpec
 * discount — Signal B counts full physiological load regardless of sport).
 * Falls back to 0 when no workouts are scheduled for this day-of-week.
 *
 * @param workouts      Full week's generated workouts.
 * @param dayOfWeek     0=Mon … 6=Sun (same convention as Workout.dayOfWeek).
 * @param baseMinPerKm  Easy pace in min/km (s.pac.e / 60). Defaults to 5.5.
 */
export function computePlannedDaySignalBTSS(workouts: Workout[], dayOfWeek: number, baseMinPerKm = 5.5): number {
  let tl = 0;
  for (const w of workouts) {
    if (w.dayOfWeek !== dayOfWeek) continue;
    const rpe = w.rpe ?? w.r ?? 5;
    const durMin = estimateWorkoutDurMin(w, baseMinPerKm);
    tl += durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
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
 * Looks back up to 3 weeks. Uses the current planned baseline as a stable
 * approximation for all lookback weeks (baseline changes slowly via CTL EMA).
 */
export function computeDecayedCarry(
  wks: Week[],
  currentWeek: number,
  plannedBaseline: number,
  planStartDate?: string,
): number {
  if (!plannedBaseline || !planStartDate) return 0;

  const nowMs = new Date().setHours(12, 0, 0, 0); // noon today
  const planStartMs = new Date(planStartDate).getTime();
  const ATL_TAU = 7; // 7-day time constant

  let total = 0;
  const maxLookback = Math.min(3, currentWeek - 1);
  for (let age = 1; age <= maxLookback; age++) {
    const idx = currentWeek - 1 - age; // 0-indexed
    const wk = wks[idx];
    if (!wk) continue;
    // Raw excess for that week (no carry — avoids circularity)
    const weekExcess = getWeeklyExcess(wk, plannedBaseline, planStartDate);
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
 * to the actual side — training load does not reset at week boundaries.
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
        // Exclude running activities — use activityType if present, otherwise
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
 * Never compare Signal B actual to computePlannedWeekTSS — that's a cross-signal mismatch.
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
  // historicWeeklyTSS is Signal A — it includes cross-training at runSpec-discounted weight.
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
// ACWR — Acute:Chronic Workload Ratio
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
 * Compute rolling 7-day (acute) and 28-day (chronic) load from actual daily TSS.
 * Returns null if fewer than 14 days of plan data available.
 *
 * For days before the plan started, uses signalBSeed / 7 as a daily fill so that
 * early plan weeks have a reasonable chronic baseline. This fill naturally phases
 * out as real data fills the 28-day window.
 */
export function computeRollingLoadRatio(
  wks: Week[],
  planStartDate: string,
  signalBSeed?: number,
  norm?: number,
): { acute: number; chronic: number } | null {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const planStart = new Date(planStartDate + 'T12:00:00');
  const seedDaily = signalBSeed != null ? signalBSeed / 7 : 0;

  // Need at least 14 days since plan start for a meaningful chronic window
  const daysSincePlanStart = Math.floor((now.getTime() - planStart.getTime()) / 86400000);
  if (daysSincePlanStart < 14 && seedDaily === 0) return null;

  // Collect daily Signal B TSS for the last 28 days (index 0 = 27 days ago)
  const daily: number[] = [];
  for (let daysAgo = 27; daysAgo >= 0; daysAgo--) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    const dateStr = d.toISOString().split('T')[0];

    const elapsed = Math.floor((d.getTime() - planStart.getTime()) / 86400000);
    const weekIdx = Math.floor(elapsed / 7);

    if (weekIdx < 0 || weekIdx >= wks.length) {
      // Before plan or beyond plan — use historical daily average
      daily.push(seedDaily);
    } else {
      daily.push(computeTodaySignalBTSS(wks[weekIdx], dateStr, null, norm));
    }
  }

  const acute   = daily.slice(-7).reduce((a, b) => a + b, 0);
  const chronic = daily.reduce((a, b) => a + b, 0) / 4; // 28-day sum / 4 = weekly average
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
 * Used by the rolling-load detail view.
 */
export function getDailyLoadHistory(
  wks: Week[],
  planStartDate: string,
  signalBSeed?: number,
  norm?: number,
  maxHR?: number,
): DailyLoadEntry[] {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const planStart = new Date(planStartDate + 'T12:00:00');
  const seedDaily = signalBSeed != null ? signalBSeed / 7 : 0;

  const entries: DailyLoadEntry[] = [];
  for (let daysAgo = 27; daysAgo >= 0; daysAgo--) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    const dateStr = d.toISOString().split('T')[0];

    const elapsed = Math.floor((d.getTime() - planStart.getTime()) / 86400000);
    const weekIdx = Math.floor(elapsed / 7);

    if (weekIdx < 0 || weekIdx >= wks.length) {
      entries.push({ date: dateStr, tss: Math.round(seedDaily), activities: [], zoneLoad: { lowAerobic: 0, highAerobic: 0, anaerobic: 0 } });
      continue;
    }

    const wk = wks[weekIdx];
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

    // Adhoc workouts — skip holiday-generated sessions (suggestions, not real activity)
    const ourDay = (d.getDay() + 6) % 7;
    for (const w of wk.adhocWorkouts ?? []) {
      if (w.id?.startsWith('holiday-') || w.id?.startsWith('adhoc-')) continue;
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
      // Last resort — attribute to low aerobic
      zoneLoad.lowAerobic += a.tss;
    }
    entries.push({ date: dateStr, tss: Math.round(tss), activities, zoneLoad });
  }
  return entries;
}

/**
 * Compute the Acute:Chronic Workload Ratio for the current point in the plan.
 *
 * Requires at least 3 weeks of history for a meaningful signal — returns
 * status='unknown' until that threshold is met.
 *
 * When signalBSeed is provided (recommended), both CTL and ATL use Signal B
 * (raw physiological TSS, no runSpec discount). This correctly handles cross-training
 * athletes whose Signal A CTL understates their true chronic load — using a mixed
 * signal (Signal A CTL, Signal B ATL) causes ACWR to appear artificially low.
 *
 * Two computation modes:
 * 1. **Rolling (preferred)**: When planStartDate is available, uses a true rolling
 *    7-day (acute) / 28-day (chronic) window over actual daily TSS. No weekly
 *    bucket artifacts — a half marathon on Saturday is fully reflected on Sunday.
 *    Pre-plan days are filled with signalBSeed / 7 (historical daily average).
 * 2. **Weekly EMA (fallback)**: When planStartDate is missing or rolling data is
 *    insufficient, falls back to the EMA-based approach on completed weeks only.
 *
 * @param wks - All weeks in the plan
 * @param currentWeek - Current 1-indexed week number
 * @param athleteTier - Optional athlete tier key; defaults to 'recreational'
 * @param ctlSeed - Signal A CTL seed from Strava history (legacy fallback path only)
 * @param planStartDate - ISO date string; required for rolling mode
 * @param atlSeed - Signal B ATL seed (legacy fallback path only)
 * @param signalBSeed - Signal B historical baseline — used as pre-plan daily fill
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
): AthleteACWR {
  const tier = athleteTier ?? 'recreational';
  const tierCfg = TIER_ACWR_CONFIG[tier] ?? TIER_ACWR_CONFIG.recreational;
  const { safeUpper } = tierCfg;

  let ctl: number;
  let atl: number;

  // ── Rolling 7d/28d approach (preferred) ──────────────────────────────────────
  // Uses actual daily TSS from activities. No weekly-bucket artifacts: a hard
  // session on Saturday is immediately reflected on Sunday, and a partial week
  // doesn't cliff-drop the ratio.
  if (planStartDate && wks.length > 0) {
    const rolling = computeRollingLoadRatio(wks, planStartDate, signalBSeed, norm);
    if (rolling) {
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
  }

  // ── Weekly EMA fallback ──────────────────────────────────────────────────────
  // Used when planStartDate is missing or rolling data is insufficient.
  const completedLimit = Math.min(Math.max(0, currentWeek - 1), wks.length);

  if (completedLimit < 3) {
    return { ratio: 0, safeUpper, status: 'unknown', atl: 0, ctl: 0 };
  }

  if (signalBSeed != null) {
    const result = computeSameSignalTSB(wks, Math.max(0, currentWeek - 1), signalBSeed, planStartDate);
    if (!result) return { ratio: 0, safeUpper, status: 'unknown', atl: 0, ctl: 0 };
    ctl = result.ctl;
    atl = result.atl;
  } else {
    const metrics = computeFitnessModel(wks, completedLimit, ctlSeed, planStartDate, atlSeed);
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
  norm?: number,
): FitnessMetrics[] {
  const results: FitnessMetrics[] = [];
  let ctl = ctlSeed ?? 0;
  let atl = atlSeed ?? ctlSeed ?? 0; // Signal B seed — higher than CTL for cross-training athletes

  const limit = Math.min(currentWeek, wks.length);
  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const rated = wk.rated ?? {};
    const weekTSS = computeWeekTSS(wk, rated, planStartDate, norm);
    // Signal B: raw physiological TSS (no runSpec discount) — used for ATL/fatigue
    const weekRawTSS = computeWeekRawTSS(wk, rated, planStartDate, norm);

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
  norm?: number,
): { ctl: number; atl: number; tsb: number } | null {
  // s.w is 1-indexed: wks[s.w-1] is the current week. limit = currentWeek (not +1)
  // so the loop covers wks[0..s.w-1], including today's completed activities without
  // inadvertently processing wks[s.w] (next week, 0 actuals) which would collapse ATL.
  const limit = Math.min(currentWeek, wks.length);
  if (limit === 0) return null;

  let ctl = ctlSeed ?? 0;
  let atl = ctlSeed ?? 0; // same seed — no gym-inflation offset

  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const rated = wk.rated ?? {};
    const weekRawTSS = computeWeekRawTSS(wk, rated, planStartDate, norm);

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
): { ctl: number; atl: number; tsb: number } {
  const completedWeek = Math.max(0, currentWeekIdx - 1);
  const seed = signalBBaseline ?? ctlBaseline ?? 0;
  const sameSignal = computeSameSignalTSB(wks ?? [], completedWeek, seed, planStartDate);
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
 * previous week). Each session adds `8 × TSS / ctlDaily × recoveryMult × recoveryAdj`
 * hours to the running total. Elapsed time ticks down between sessions and after the last.
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
      for (const [, actual] of Object.entries(wk.garminActuals)) {
        if (!actual.startTime?.startsWith(session.date)) continue;
        const sportKey = actual.activityType ? normalizeSport(actual.activityType) : 'generic_sport';
        const config = SPORTS_DB[sportKey];
        const rm = config?.recoveryMult ?? 1.0;
        const actTss = actual.iTrimp ? actual.iTrimp / 150 : (actual.durationSec ?? 0) / 60;
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

    const sessionRecovery = 8 * session.tss / ctlDaily * weightedRecoveryMult * recoveryAdj;
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
