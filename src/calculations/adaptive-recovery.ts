/**
 * Adaptive recovery. Learns the user's personal recovery rate (`k_user`)
 * over time from observed post-session physiology.
 *
 * The recovery countdown is `k × TSS / ctlDaily × recoveryMult × recoveryAdj`.
 * Today `k = 8` is a fixed population value. This module fits a per-user
 * `k_user` from how quickly the user's HRV/RHR composite z-score returns to
 * personal baseline after each session.
 *
 * The fit composes two terms:
 *   - `recoveryAdj` (transient): today's HRV/RHR/sleep. See readiness.ts.
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
import { normalizeiTrimp } from '@/calculations/fitness-model';

// ─── Constants ───────────────────────────────────────────────────────────────

export const K_USER_DEFAULT = 8;
export const K_USER_MIN = 5;
export const K_USER_MAX = 13;

/** How long we wait for the recovery signal to return to baseline before
 * marking a session as right-censored. 96h = 4 days, matches the upper bound
 * of EPOC clearance for typical aerobic loads. */
export const RECOVERY_OBSERVATION_CAP_HOURS = 96;

/** Physiology is sampled once per day, so the fastest recovery we can resolve
 * is 24h. Also used to convert observedHours into a whole-day window for the
 * clean-window (intervening-session) filter in the fit. */
export const RECOVERY_SAMPLE_GRANULARITY_HOURS = 24;

/**
 * Expected hours for the HRV/RHR composite to return to baseline, by session
 * intensity. The fit compares the athlete's *observed* recovery against these.
 *
 * Source: Stanley, Peake & Buchheit (2013), "Cardiac Parasympathetic
 * Reactivation Following Exercise: Implications for Training Prescription",
 * Sports Med 43(12):1259-77. Complete parasympathetic recovery requires ~24h
 * after low-intensity, 24-48h after threshold, and >=48h after high-intensity
 * exercise. We anchor easy at the 24h figure, moderate at the 24-48h midpoint
 * (36h), and hard between the >=48h floor and the ~72h seen in strength/extreme
 * studies (54h). Anchors approved by Tristan 2026-06-03. See SCIENCE_LOG.
 *
 * The comparison is fitness-relative because the intensity band is read from the
 * athlete's own HR zones (Strava computes time-in-zone against their personal
 * zones), so a fit athlete's easy run is correctly judged against the easy
 * expectation, not a beginner's.
 */
export const EXPECTED_RECOVERY_HOURS = { easy: 24, moderate: 36, hard: 54 } as const;
export type IntensityBand = 'easy' | 'moderate' | 'hard';

export function expectedRecoveryHoursForBand(band: IntensityBand): number {
  return EXPECTED_RECOVERY_HOURS[band];
}

/**
 * Classify a completed session into the three intensity bands Stanley et al. use.
 *
 * Primary: HR time-in-zone. Strava computes z1-z5 against the athlete's own HR
 * zones, so this is automatically fitness-relative. We take the time-weighted
 * mean zone; the band boundaries fall at the integer-rounding midpoints (2.5 and
 * 3.5), so there is no tuned cutoff — Z1-2 = below aerobic threshold (easy),
 * Z3 = threshold (moderate), Z4-5 = above anaerobic threshold (hard).
 *
 * Fallback: session-RPE (Foster 2001 CR10 convention) when no HR zones exist —
 * RPE <=4 easy, 5-6 moderate, >=7 hard.
 *
 * Returns null when neither signal is present; such sessions can't be placed on
 * the recovery scale and are excluded from the fit (not guessed).
 *
 * Known limitation: the mean-zone rule under-weights a short hard-interval block
 * inside an otherwise easy session, which the literature says still delays
 * recovery. A threshold-crossing classifier is a deferred refinement (needs a
 * "meaningful time above threshold" cutoff, which would be a tuned constant).
 */
export function classifySessionIntensity(
  hrZones: { z1: number; z2: number; z3: number; z4: number; z5: number } | null | undefined,
  rpe?: number | null,
): IntensityBand | null {
  if (hrZones) {
    const total = hrZones.z1 + hrZones.z2 + hrZones.z3 + hrZones.z4 + hrZones.z5;
    if (total > 0) {
      const meanZone =
        (1 * hrZones.z1 + 2 * hrZones.z2 + 3 * hrZones.z3 + 4 * hrZones.z4 + 5 * hrZones.z5) / total;
      if (meanZone >= 3.5) return 'hard';
      if (meanZone >= 2.5) return 'moderate';
      return 'easy';
    }
  }
  if (rpe != null && rpe > 0) {
    if (rpe >= 7) return 'hard';
    if (rpe >= 5) return 'moderate';
    return 'easy';
  }
  return null;
}

/** Composite z-score (HRV positive, RHR sign-flipped) at or above this counts
 * as "recovered". A small negative tolerance acknowledges noise. Strict
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

/** Bayesian prior — equivalent to N "ghost" samples at recovery index 1.0
 * (ln 1 = 0, i.e. k=8 is typical). Smooths early estimates toward typical while
 * data accumulates. */
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
 * session date. No peeking forward. The baseline must reflect the user's
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
  // De-dupe by garminId. Re-running historical backfill or replaying a webhook
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
 * `k_user = 8 × recovery index`, where the index is how the athlete's observed
 * recovery compares to the literature expectation *for the intensity of each
 * session* (index 1.0 = typical; <1 faster; >1 slower). This replaces the old
 * absolute observed/predicted ratio, which compared two different physiological
 * scales (readiness-debt hours vs autonomic-return hours) and pinned every fit
 * athlete at the ceiling. See SCIENCE_LOG / ISSUE-256.
 *
 * Algorithm:
 *   - Usable = closed entries that have an intensity band (→ expectedRecoveryHours)
 *     AND recovered in a CLEAN window: no other session fell on the *intervening*
 *     days T+1 .. T+(k-1) where observed = k×24h. Physiology is a morning reading,
 *     so a session on the recovery day itself happens after that reading and does
 *     not contaminate — hence strict `< windowDays`. A 24h recovery is therefore
 *     always clean. This is what keeps high-frequency athletes from looking slow:
 *     train-through sessions are excluded, not counted against them.
 *   - index_i = observedHours_i / expectedRecoveryHours_i.
 *   - Aggregate in LOG space (recovery ratios are right-skewed; a few very slow
 *     sessions would drag a linear mean). Prior: ln(index)=0 (index 1) weight 4.
 *   - Weight by source (live 1.0 / historical 0.7) × recency decay.
 *   - k_user = clamp(8 × exp(weighted mean log index), [5, 13]).
 *   - Confidence from N clean usable entries. `densityLimited` flags the case of
 *     many closed sessions but few clean ones (trains too densely to read).
 */
export function fitKUser(
  s: Pick<SimulatorState, 'sessionImpactLog' | 'adaptiveRecovery'>,
  options?: FitOptions,
): AdaptiveRecovery {
  const ar: AdaptiveRecovery = s.adaptiveRecovery ?? defaultAdaptiveRecovery();
  const halfLife = options?.halfLifeWeeks ?? ar.emaHalfLifeWeeks ?? EMA_HALF_LIFE_WEEKS_DEFAULT;
  const now = options?.now ?? new Date();
  const nowIso = isoDate(now);

  const log = s.sessionImpactLog ?? [];
  // Need an observed recovery AND an intensity-banded expectation to place the
  // session on the recovery scale. Sessions we can't classify are excluded, not
  // guessed.
  const closed = log.filter(e =>
    e.observedHours != null && (e.expectedRecoveryHours ?? 0) > 0,
  );

  // Clean-window filter. observed = k × 24h, so the intervening days are
  // T+1 .. T+(k-1). A session on any of those days kept the markers suppressed
  // and inflated this session's observed recovery, so the reading is confounded
  // by training density rather than this session's recovery cost — drop it.
  // (A session on the recovery day T+k itself is post-morning-reading, so it does
  // not contaminate; hence strict `gap < windowDays`. observed=24h → windowDays=1
  // → no intervening days possible → always clean.)
  const allDates = log.map(e => e.date);
  const usable = closed.filter(e => {
    const windowDays = Math.round((e.observedHours as number) / RECOVERY_SAMPLE_GRANULARITY_HOURS);
    const interveningSession = allDates.some(d => {
      if (d === e.date) return false;
      const gap = daysBetween(e.date, d);
      return gap > 0 && gap < windowDays;
    });
    return !interveningSession;
  });

  // Log-space weighted mean. ln(prior index 1) = 0.
  let weightedLogSum = PRIOR_WEIGHT * 0;
  let weightTotal = PRIOR_WEIGHT;

  for (const e of usable) {
    const index = (e.observedHours as number) / (e.expectedRecoveryHours as number);
    const logIndex = Math.log(index);
    const ageWeeks = Math.max(0, daysBetween(e.date, nowIso)) / 7;
    const recency = Math.pow(0.5, ageWeeks / halfLife);
    const w = (e.fitWeight ?? LIVE_FIT_WEIGHT) * recency;
    weightedLogSum += w * logIndex;
    weightTotal += w;
  }

  const index = weightTotal > 0 ? Math.exp(weightedLogSum / weightTotal) : 1.0;
  const kNew = clamp(K_USER_DEFAULT * index, K_USER_MIN, K_USER_MAX);
  const n = usable.length;
  const confidence = confidenceFromN(n);
  // Many closed sessions but few clean ones → we can't read this athlete cleanly.
  const densityLimited = closed.length >= CONF_MEDIUM_FLOOR && n < CONF_LOW_FLOOR;

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
    densityLimited,
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
  intensityBand?: IntensityBand;       // session intensity (fit basis); falls through if absent
}

interface BackfillResult {
  added: number;
  skipped: number;
  closedOut: number;
}

/** One-shot historical pass: ingest a list of pre-computed historical sessions
 * and try to close them out against the current physiology history. Sessions
 * that can't be closed (no baseline, no post-session readings) are dropped
 * rather than stored open. Historical entries don't get a second chance. */
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
      intensityBand: sess.intensityBand,
      expectedRecoveryHours: sess.intensityBand ? expectedRecoveryHoursForBand(sess.intensityBand) : undefined,
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
  hrZones?: { z1: number; z2: number; z3: number; z4: number; z5: number } | null;
}

interface WeekLike {
  garminActuals?: Record<string, ActualLike>;
  /** User-rated RPE per workout id (1–10) or 'skip'. Used as the intensity
   *  fallback when an activity has no HR zones. */
  rated?: Record<string, number | 'skip'>;
}

/** Walk recent weeks of `wk.garminActuals` (current plan + archived plans) and
 * log a SessionImpactEntry for any completed session not yet in the impact log
 * and within the 90-day rolling window. Sessions that pre-date the rolling
 * window are tagged `historical-backfill` (lower fit weight). This is the
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
    for (const [id, actual] of Object.entries(actuals)) {
      if (!actual.startTime) continue;
      if (known.has(actual.garminId)) continue;

      const date = actual.startTime.split('T')[0];
      const ageDays = daysBetween(date, todayIso());
      if (ageDays < 0 || ageDays > IMPACT_LOG_MAX_DAYS) continue;

      // Run-equiv TSS. Mirrors the fallback used in computeToBaseline. Uses
      // the personal-gated normalizer when iTRIMP is available (ISSUE-262),
      // otherwise rough duration-based fallback.
      const tss = actual.iTrimp != null
        ? normalizeiTrimp(actual.iTrimp)
        : (actual.durationSec ?? 0) / 60 / 100 * 30;
      if (tss < 5) continue;  // skip tiny sessions; not enough load to fit on

      const recoveryMultAtTime = recoveryMultForSport(actual.activityType ?? null);
      const recoveryAdjAtTime = recoveryAdjOnDate(physio, date);
      const predictedHours = K_USER_DEFAULT * tss / Math.max(1, ctlDaily) * recoveryMultAtTime * recoveryAdjAtTime;

      // Intensity band → literature-anchored expected recovery (the fit basis).
      // HR zones (Strava, fitness-relative) preferred; RPE fallback.
      const ratedRpe = typeof wk.rated?.[id] === 'number' ? (wk.rated[id] as number) : null;
      const intensityBand = classifySessionIntensity(actual.hrZones, ratedRpe) ?? undefined;
      const expectedRecoveryHours = intensityBand ? expectedRecoveryHoursForBand(intensityBand) : undefined;

      // Sessions older than 7 days are tagged historical. They post-date the
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
        intensityBand,
        expectedRecoveryHours,
        signalsUsed: [],   // closeOutObservedRecovery will populate
        source,
        fitWeight,
      });
      added++;
      if (isHistorical) addedHistorical++;
      // De-dupe protection within this pass. Same activity may appear in both
      // current plan and an archived plan during overlap. logSessionImpact
      // already de-dupes, but we want our local known set to reflect this so
      // we don't double-count `added` either.
      known.add(actual.garminId);
    }
  }
  return { added, addedHistorical };
}

/** Retrofit `intensityBand` / `expectedRecoveryHours` onto existing impact-log
 * entries that pre-date the intensity-banded model (ISSUE-256 redesign). Matches
 * each entry back to its activity by garminId across current + archived weeks and
 * classifies it from HR zones (or RPE). Idempotent: skips entries that already
 * have an expectation. Returns the count filled. Without this, a user's existing
 * 90-day log would carry no band and contribute nothing to the new fit until it
 * aged out. */
export function backfillIntensityBands(
  s: Pick<SimulatorState, 'sessionImpactLog'> & {
    wks?: WeekLike[];
    previousPlanWks?: Array<{ weeks: WeekLike[] }>;
  },
): number {
  const log = s.sessionImpactLog ?? [];
  if (log.length === 0) return 0;

  const allWeeks: WeekLike[] = [...(s.wks ?? [])];
  for (const archived of (s.previousPlanWks ?? [])) {
    if (Array.isArray(archived?.weeks)) {
      for (const w of archived.weeks) if (w) allWeeks.push(w);
    }
  }

  // Index activity intensity signals by garminId.
  const signalById = new Map<string, { hrZones: ActualLike['hrZones']; rpe: number | null }>();
  for (const wk of allWeeks) {
    if (!wk?.garminActuals) continue;
    for (const [id, actual] of Object.entries(wk.garminActuals)) {
      const rpe = typeof wk.rated?.[id] === 'number' ? (wk.rated[id] as number) : null;
      signalById.set(actual.garminId, { hrZones: actual.hrZones, rpe });
    }
  }

  let filled = 0;
  for (const e of log) {
    if (e.expectedRecoveryHours != null) continue;
    const sig = signalById.get(e.garminId);
    if (!sig) continue;
    const band = classifySessionIntensity(sig.hrZones, sig.rpe);
    if (!band) continue;
    e.intensityBand = band;
    e.expectedRecoveryHours = expectedRecoveryHoursForBand(band);
    filled++;
  }
  return filled;
}
