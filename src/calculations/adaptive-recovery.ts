/**
 * Adaptive recovery — learns the user's personal recovery rate (`k_user`)
 * over time from observed post-session physiology.
 *
 * The recovery countdown is `k × TSS / ctlDaily × recoveryMult × recoveryAdj`.
 * Today `k = 8` is a fixed population value. This module fits a per-user
 * `k_user` from how quickly the user's HRV/RHR composite z-score returns to
 * personal baseline after each session.
 *
 * The fit composes two terms:
 *   - `recoveryAdj` (transient): today's HRV/RHR/sleep — see readiness.ts.
 *   - `k_user`     (persistent trait): how this athlete clears load in general.
 *
 * Confidence gates:
 *   - none/low (< 16 sessions): use population default of 8.
 *   - medium  (16+):            use learned k_user in countdown only.
 *   - high    (30+):            use learned k_user in countdown AND ACWR ceiling shift.
 *
 * On first launch, a one-shot historical backfill walks `garminActuals` and
 * `physiologyHistory` to seed evidence so a user with rich Garmin history
 * lands at confidence ≥ medium without waiting weeks. Historical evidence is
 * weighted at 0.7× because it lacks RPE/check-in corrections.
 *
 * See `docs/SCIENCE_LOG.md` for the rationale and limitations.
 */

import type {
  AdaptiveRecovery,
  PhysiologyDayEntry,
  SessionImpactEntry,
  SimulatorState,
} from '@/types/state';
import { clamp } from '@/utils/helpers';
import { SPORTS_DB } from '@/constants/sports';

// ─── Constants ───────────────────────────────────────────────────────────────

export const K_USER_DEFAULT = 8;
export const K_USER_MIN = 5;
export const K_USER_MAX = 13;

/** How long we wait for the recovery signal to return to baseline before
 * marking a session as right-censored. 96h = 4 days, matches the upper bound
 * of EPOC clearance for typical aerobic loads. */
export const RECOVERY_OBSERVATION_CAP_HOURS = 96;

/** Composite z-score (HRV positive, RHR sign-flipped) at or above this counts
 * as "recovered". A small negative tolerance acknowledges noise — strict
 * z ≥ 0 would inflate observed hours. */
export const RECOVERY_Z_THRESHOLD = -0.25;

/** Recency decay half-life for the weighted mean, in weeks. */
export const EMA_HALF_LIFE_WEEKS_DEFAULT = 4;

export const LIVE_FIT_WEIGHT = 1.0;
/** Historical evidence is thinner — physiology only, no RPE / check-in. */
export const HISTORICAL_FIT_WEIGHT = 0.7;

export const CONF_LOW_FLOOR = 8;
export const CONF_MEDIUM_FLOOR = 16;
export const CONF_HIGH_FLOOR = 30;

/** Maximum ACWR safeUpper shift (positive or negative) at confidence = high. */
export const CEILING_SHIFT_MAX = 0.10;
/** Per-hour shift coefficient: shift = (8 - k_user) × this, then clamped. */
export const CEILING_SHIFT_PER_HOUR = 0.025;

/** SessionImpactEntry rolling window. */
export const IMPACT_LOG_MAX_DAYS = 90;

/** Bayesian prior — equivalent to N "ghost" samples that say k=8 is correct.
 * Smooths early estimates toward population while data accumulates. */
const PRIOR_RATIO = 1.0;
const PRIOR_WEIGHT = 4;

// ─── Defaults ────────────────────────────────────────────────────────────────

export function defaultAdaptiveRecovery(): AdaptiveRecovery {
  return {
    kUserHours: K_USER_DEFAULT,
    confidence: 'none',
    sessionsObserved: 0,
    emaHalfLifeWeeks: EMA_HALF_LIFE_WEEKS_DEFAULT,
  };
}

// ─── Confidence + effective values ───────────────────────────────────────────

export function confidenceFromN(n: number): AdaptiveRecovery['confidence'] {
  if (n >= CONF_HIGH_FLOOR) return 'high';
  if (n >= CONF_MEDIUM_FLOOR) return 'medium';
  if (n >= CONF_LOW_FLOOR) return 'low';
  return 'none';
}

/** The k_user value to actually use in the recovery countdown. Falls back to
 * the population default until confidence reaches medium. */
export function getEffectiveKUser(ar: AdaptiveRecovery | undefined): number {
  if (!ar) return K_USER_DEFAULT;
  if (ar.confidence === 'medium' || ar.confidence === 'high') return ar.kUserHours;
  return K_USER_DEFAULT;
}

/** Shift to apply to per-tier ACWR safeUpper. Only non-zero at confidence = high. */
export function recoveryShiftForCeiling(ar: AdaptiveRecovery | undefined): number {
  if (!ar || ar.confidence !== 'high') return 0;
  const raw = (K_USER_DEFAULT - ar.kUserHours) * CEILING_SHIFT_PER_HOUR;
  return clamp(raw, -CEILING_SHIFT_MAX, CEILING_SHIFT_MAX);
}

/** Effective ACWR safeUpper — base tier value plus the personalisation shift. */
export function getEffectiveSafeUpper(baseSafeUpper: number, ar: AdaptiveRecovery | undefined): number {
  return baseSafeUpper + recoveryShiftForCeiling(ar);
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function daysBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso + 'T12:00:00').getTime();
  const b = new Date(bIso + 'T12:00:00').getTime();
  return Math.round((b - a) / 86400000);
}

function todayIso(): string {
  return isoDate(new Date());
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Composite recovery z-score ──────────────────────────────────────────────

interface BaselineStats {
  hrvMean: number | null;
  hrvSd: number | null;
  rhrMean: number | null;
  rhrSd: number | null;
}

/** Compute personal HRV / RHR baselines from the 28 days strictly BEFORE a
 * session date. No peeking forward — the baseline must reflect the user's
 * normal pre-session state. Returns null fields when fewer than 5 readings. */
export function computeBaselineStats(
  history: PhysiologyDayEntry[],
  beforeDate: string,
): BaselineStats {
  const window: PhysiologyDayEntry[] = [];
  for (const d of history) {
    if (!d.date) continue;
    const delta = daysBetween(d.date, beforeDate);
    if (delta > 0 && delta <= 28) window.push(d);
  }

  const hrvs = window.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const rhrs = window.map(d => d.restingHR).filter((v): v is number => v != null && v > 0);

  return {
    hrvMean: hrvs.length >= 5 ? hrvs.reduce((a, b) => a + b, 0) / hrvs.length : null,
    hrvSd:   hrvs.length >= 5 ? stddev(hrvs) : null,
    rhrMean: rhrs.length >= 5 ? rhrs.reduce((a, b) => a + b, 0) / rhrs.length : null,
    rhrSd:   rhrs.length >= 5 ? stddev(rhrs) : null,
  };
}

/** Composite z for a single day. Positive = above baseline (recovered or better);
 * negative = below baseline (still depleted). HRV uses positive z; RHR is
 * sign-flipped (lower RHR = better). Returns null if no signal is available. */
export function composeRecoveryZ(
  day: PhysiologyDayEntry | undefined,
  baseline: BaselineStats,
): { z: number; signals: Array<'hrv' | 'rhr'> } | null {
  if (!day) return null;
  const zs: number[] = [];
  const signals: Array<'hrv' | 'rhr'> = [];

  if (day.hrvRmssd != null && day.hrvRmssd > 0 && baseline.hrvMean != null && baseline.hrvSd && baseline.hrvSd > 0) {
    zs.push((day.hrvRmssd - baseline.hrvMean) / baseline.hrvSd);
    signals.push('hrv');
  }
  if (day.restingHR != null && day.restingHR > 0 && baseline.rhrMean != null && baseline.rhrSd && baseline.rhrSd > 0) {
    zs.push(-(day.restingHR - baseline.rhrMean) / baseline.rhrSd);
    signals.push('rhr');
  }

  if (zs.length === 0) return null;
  return { z: zs.reduce((a, b) => a + b, 0) / zs.length, signals };
}

// ─── Observed recovery hours ─────────────────────────────────────────────────

interface ObservedRecovery {
  hours: number;
  censored: boolean;
  signalsUsed: Array<'hrv' | 'rhr'>;
}

/** Walk forward day-by-day from the day after the session, looking for the
 * first day on which the composite z is at or above the recovery threshold.
 * Returns null when no baseline can be established (insufficient pre-session
 * physiology) or when no usable post-session readings exist within the cap. */
export function findObservedRecoveryHours(
  history: PhysiologyDayEntry[],
  sessionDate: string,
): ObservedRecovery | null {
  const baseline = computeBaselineStats(history, sessionDate);
  if (baseline.hrvMean == null && baseline.rhrMean == null) return null;

  const byDate = new Map<string, PhysiologyDayEntry>();
  for (const d of history) if (d.date) byDate.set(d.date, d);

  // Walk T+1 .. T+4 (24h, 48h, 72h, 96h)
  const usedSignals = new Set<'hrv' | 'rhr'>();
  let sawAnySignal = false;
  for (let dayOffset = 1; dayOffset <= 4; dayOffset++) {
    const probeDate = addDays(sessionDate, dayOffset);
    const probe = byDate.get(probeDate);
    const composed = composeRecoveryZ(probe, baseline);
    if (!composed) continue;
    sawAnySignal = true;
    composed.signals.forEach(s => usedSignals.add(s));
    if (composed.z >= RECOVERY_Z_THRESHOLD) {
      return {
        hours: dayOffset * 24,
        censored: false,
        signalsUsed: Array.from(usedSignals),
      };
    }
  }

  if (!sawAnySignal) return null;
  return {
    hours: RECOVERY_OBSERVATION_CAP_HOURS,
    censored: true,
    signalsUsed: Array.from(usedSignals),
  };
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

// ─── Session impact log mutators ─────────────────────────────────────────────

/** Append a SessionImpactEntry to state. Caller computes predicted hours and
 * provides the inputs that went into it. observedHours is filled in later by
 * `closeOutObservedRecovery` once enough days have passed. */
export function logSessionImpact(
  s: Pick<SimulatorState, 'sessionImpactLog'>,
  args: Omit<SessionImpactEntry, 'fitWeight'> & { fitWeight?: number },
): void {
  const entry: SessionImpactEntry = {
    ...args,
    fitWeight: args.fitWeight ?? (args.source === 'historical-backfill' ? HISTORICAL_FIT_WEIGHT : LIVE_FIT_WEIGHT),
  };

  const log = s.sessionImpactLog ?? [];
  // De-dupe by garminId — re-running historical backfill or replaying a webhook
  // shouldn't multiply evidence.
  const idx = log.findIndex(e => e.garminId === entry.garminId);
  if (idx >= 0) log.splice(idx, 1);
  log.push(entry);
  pruneImpactLog(log);
  s.sessionImpactLog = log;
}

function pruneImpactLog(log: SessionImpactEntry[]): void {
  const today = todayIso();
  const cutoffDays = IMPACT_LOG_MAX_DAYS;
  for (let i = log.length - 1; i >= 0; i--) {
    const age = daysBetween(log[i].date, today);
    if (age > cutoffDays) log.splice(i, 1);
  }
}

/** Try to fill `observedHours` on entries that don't have it yet. Called after
 * physiology sync. Returns the number of entries closed in this pass. */
export function closeOutObservedRecovery(
  s: Pick<SimulatorState, 'sessionImpactLog' | 'physiologyHistory'>,
  todayOverride?: string,
): number {
  const log = s.sessionImpactLog ?? [];
  const physio = s.physiologyHistory ?? [];
  if (log.length === 0 || physio.length === 0) return 0;

  const today = todayOverride ?? todayIso();
  let closed = 0;
  for (const entry of log) {
    if (entry.observedHours != null) continue;
    // Only attempt closeout once the 96h window has fully elapsed, otherwise
    // we'd settle for early "looks recovered" readings without giving the
    // signal time to dip and recover. Strict: cap-hours since session date.
    const hoursSince = daysBetween(entry.date, today) * 24;
    if (hoursSince < RECOVERY_OBSERVATION_CAP_HOURS) continue;

    const observed = findObservedRecoveryHours(physio, entry.date);
    if (!observed) continue;
    entry.observedHours = observed.hours;
    entry.rightCensored = observed.censored;
    // Merge HRV/RHR signals into whatever the entry already had.
    const sigs = new Set<'hrv' | 'rhr' | 'checkin' | 'rpe'>(entry.signalsUsed);
    observed.signalsUsed.forEach(sig => sigs.add(sig));
    entry.signalsUsed = Array.from(sigs);
    closed++;
  }
  return closed;
}

// ─── The fit ─────────────────────────────────────────────────────────────────

interface FitOptions {
  /** Override "now" for tests. Defaults to system clock. */
  now?: Date;
  /** Override half-life for tests. */
  halfLifeWeeks?: number;
}

/** Recompute `k_user` from the closed-out evidence and update state's
 * `adaptiveRecovery`. Returns the updated AdaptiveRecovery snapshot.
 *
 * Algorithm:
 *   - For each closed entry: ratio = observedHours / predictedHours.
 *   - Apply weighting: source weight (live=1.0 / historical=0.7) × recency
 *     decay (0.5^(ageWeeks / halfLife)).
 *   - Bayesian prior: ghost samples with ratio=1.0 and total weight 4 — keeps
 *     low-N estimates anchored near population while data accumulates.
 *   - Weighted mean ratio × 8, clamped to [5, 13], gives k_user.
 *   - Confidence band derives from N closed entries.
 */
export function fitKUser(
  s: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'>,
  options?: FitOptions,
): AdaptiveRecovery {
  const ar: AdaptiveRecovery = s.adaptiveRecovery ?? defaultAdaptiveRecovery();
  const halfLife = options?.halfLifeWeeks ?? ar.emaHalfLifeWeeks ?? EMA_HALF_LIFE_WEEKS_DEFAULT;
  const now = options?.now ?? new Date();
  const nowIso = isoDate(now);

  const closed = (s.sessionImpactLog ?? []).filter(e =>
    e.observedHours != null && e.predictedHours > 0,
  );

  let weightedSum = PRIOR_WEIGHT * PRIOR_RATIO;
  let weightTotal = PRIOR_WEIGHT;

  for (const e of closed) {
    const ratio = (e.observedHours as number) / e.predictedHours;
    const ageDays = Math.max(0, daysBetween(e.date, nowIso));
    const ageWeeks = ageDays / 7;
    const recency = Math.pow(0.5, ageWeeks / halfLife);
    const w = (e.fitWeight ?? LIVE_FIT_WEIGHT) * recency;
    weightedSum += w * ratio;
    weightTotal += w;
  }

  const meanRatio = weightTotal > 0 ? weightedSum / weightTotal : 1.0;
  const kNew = clamp(K_USER_DEFAULT * meanRatio, K_USER_MIN, K_USER_MAX);
  const n = closed.length;
  const confidence = confidenceFromN(n);

  const history = ar.history ? ar.history.slice() : [];
  // Append a history point if k or n changed materially since last fit.
  const last = history[history.length - 1];
  if (!last || Math.abs(last.k - kNew) > 0.05 || last.n !== n) {
    history.push({ date: nowIso, k: Number(kNew.toFixed(3)), n });
    while (history.length > 12) history.shift();
  }

  const updated: AdaptiveRecovery = {
    ...ar,
    kUserHours: Number(kNew.toFixed(3)),
    confidence,
    sessionsObserved: n,
    lastFitAt: nowIso,
    emaHalfLifeWeeks: halfLife,
    history,
  };

  s.adaptiveRecovery = updated;
  return updated;
}

// ─── Historical backfill ─────────────────────────────────────────────────────

interface HistoricalSession {
  garminId: string;
  date: string;                        // YYYY-MM-DD
  tss: number;                         // run-equiv TSS (signal A)
  ctlAtTime: number;                   // daily-equiv CTL on that date
  recoveryMultAtTime: number;          // sport-derived
  recoveryAdjAtTime: number;           // transient adjustment used at the time
}

interface BackfillResult {
  added: number;
  skipped: number;
  closedOut: number;
}

/** One-shot historical pass: ingest a list of pre-computed historical sessions
 * and try to close them out against the current physiology history. Sessions
 * that can't be closed (no baseline, no post-session readings) are dropped
 * rather than stored open — historical entries don't get a second chance. */
export function backfillHistoricalImpacts(
  s: Pick<SimulatorState, 'sessionImpactLog' | 'physiologyHistory' | 'adaptiveRecovery'>,
  sessions: HistoricalSession[],
): BackfillResult {
  const physio = s.physiologyHistory ?? [];
  let added = 0;
  let skipped = 0;
  let closedOut = 0;

  for (const sess of sessions) {
    const observed = findObservedRecoveryHours(physio, sess.date);
    if (!observed) { skipped++; continue; }

    const predicted =
      K_USER_DEFAULT *
      sess.tss /
      Math.max(1, sess.ctlAtTime) *
      sess.recoveryMultAtTime *
      sess.recoveryAdjAtTime;

    const entry: SessionImpactEntry = {
      garminId: sess.garminId,
      date: sess.date,
      tss: sess.tss,
      ctlAtTime: sess.ctlAtTime,
      recoveryMultAtTime: sess.recoveryMultAtTime,
      recoveryAdjAtTime: sess.recoveryAdjAtTime,
      predictedHours: predicted,
      observedHours: observed.hours,
      rightCensored: observed.censored,
      signalsUsed: observed.signalsUsed,
      source: 'historical-backfill',
      fitWeight: HISTORICAL_FIT_WEIGHT,
    };

    logSessionImpact(s, entry);
    added++;
    closedOut++;
  }

  return { added, skipped, closedOut };
}

// ─── Sport recovery multiplier helper ────────────────────────────────────────

/** Resolve a sport's recoveryMult, defaulting to 1.0 when unknown. Mirrors
 * the lookup used by `computeToBaseline` in fitness-model.ts. */
export function recoveryMultForSport(sportKey: string | null | undefined): number {
  if (!sportKey) return 1.0;
  const cfg = (SPORTS_DB as Record<string, { recoveryMult?: number }>)[sportKey];
  return cfg?.recoveryMult ?? 1.0;
}

/** Approximate the transient recoveryAdj that would have applied on a given
 * date, derived from physiology rows up to that day. Mirrors the formula used
 * in `computeToBaseline` (1 + (50 - recoveryScore) × 0.006, clamped 0.7–1.3),
 * but evaluated on a historical window. Returns 1.0 when not enough data. */
function recoveryAdjOnDate(
  history: PhysiologyDayEntry[],
  date: string,
): number {
  if (history.length === 0) return 1.0;
  // Use the most recent reading at or before the session date to approximate
  // composite recovery on that day. Cheap proxy: take the day's hrv/rhr/sleep
  // z-scores against the prior 28d baseline.
  const baseline = computeBaselineStats(history, date);
  const sameDay = history.find(d => d.date === date);
  const composed = composeRecoveryZ(sameDay, baseline);
  if (!composed) return 1.0;
  // Map z (typically -2 .. +2) to a recoveryScore-equivalent (0..100), then
  // apply the same transform as computeToBaseline. z=0 → 80, z=+1 → 100.
  const recScore = clamp(80 + composed.z * 20, 0, 100);
  const adj = 1.0 + (50 - recScore) * 0.006;
  return clamp(adj, 0.7, 1.3);
}

interface ActualLike {
  garminId: string;
  startTime?: string | null;
  durationSec: number;
  iTrimp?: number | null;
  activityType?: string | null;
}

interface WeekLike {
  garminActuals?: Record<string, ActualLike>;
}

/** Walk recent weeks of `wk.garminActuals` (current plan + archived plans) and
 * log a SessionImpactEntry for any completed session not yet in the impact log
 * and within the 90-day rolling window. Sessions that pre-date the rolling
 * window are tagged `historical-backfill` (lower fit weight) — this is the
 * day-one personalisation path for users with rich Strava/Garmin history.
 *
 * Idempotent (de-duped by garminId in `logSessionImpact`); safe to run on
 * every launch. */
export function ingestNewActualsAsImpacts(
  s: Pick<SimulatorState, 'sessionImpactLog' | 'physiologyHistory' | 'ctlBaseline'> & {
    wks?: WeekLike[];
    previousPlanWks?: Array<{ weeks: WeekLike[] }>;
  },
): { added: number; addedHistorical: number } {
  const log = s.sessionImpactLog ?? [];
  const known = new Set(log.map(e => e.garminId));
  const physio = s.physiologyHistory ?? [];
  const ctlDaily = (s.ctlBaseline ?? 0) / 7;
  if (ctlDaily <= 0) return { added: 0, addedHistorical: 0 };

  // Build the union of all weeks to walk: current plan first, then archived.
  const allWeeks: WeekLike[] = [...(s.wks ?? [])];
  for (const archived of (s.previousPlanWks ?? [])) {
    if (Array.isArray(archived?.weeks)) {
      for (const w of archived.weeks) if (w) allWeeks.push(w);
    }
  }

  let added = 0;
  let addedHistorical = 0;
  for (const wk of allWeeks) {
    const actuals = wk?.garminActuals;
    if (!actuals) continue;
    for (const actual of Object.values(actuals)) {
      if (!actual.startTime) continue;
      if (known.has(actual.garminId)) continue;

      const date = actual.startTime.split('T')[0];
      const ageDays = daysBetween(date, todayIso());
      if (ageDays < 0 || ageDays > IMPACT_LOG_MAX_DAYS) continue;

      // Run-equiv TSS — mirrors the fallback used in computeToBaseline. Uses
      // iTRIMP / 150 when available, otherwise rough duration-based fallback.
      const tss = actual.iTrimp != null
        ? actual.iTrimp / 150
        : (actual.durationSec ?? 0) / 60 / 100 * 30;
      if (tss < 5) continue;  // skip tiny sessions; not enough load to fit on

      const recoveryMultAtTime = recoveryMultForSport(actual.activityType ?? null);
      const recoveryAdjAtTime = recoveryAdjOnDate(physio, date);
      const predictedHours = K_USER_DEFAULT * tss / Math.max(1, ctlDaily) * recoveryMultAtTime * recoveryAdjAtTime;

      // Sessions older than 7 days are tagged historical — they post-date the
      // current launch but pre-date the active engagement window where we
      // typically have RPE / check-in corrections. Down-weighted in the fit.
      const isHistorical = ageDays > 7;
      const source: 'live' | 'historical-backfill' = isHistorical ? 'historical-backfill' : 'live';
      const fitWeight = isHistorical ? HISTORICAL_FIT_WEIGHT : LIVE_FIT_WEIGHT;

      logSessionImpact(s, {
        garminId: actual.garminId,
        date,
        tss,
        ctlAtTime: ctlDaily,
        recoveryMultAtTime,
        recoveryAdjAtTime,
        predictedHours,
        signalsUsed: [],   // closeOutObservedRecovery will populate
        source,
        fitWeight,
      });
      added++;
      if (isHistorical) addedHistorical++;
      // De-dupe protection within this pass — same activity may appear in both
      // current plan and an archived plan during overlap. logSessionImpact
      // already de-dupes, but we want our local known set to reflect this so
      // we don't double-count `added` either.
      known.add(actual.garminId);
    }
  }
  return { added, addedHistorical };
}
