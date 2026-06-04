/**
 * Canonical max-HR estimator — one algorithm for every source.
 *
 * Before 2026-06-04 the three sync pipes each estimated max HR differently:
 * Garmin edge fn used p95 of session maxes (median below 5 readings — the
 * path that once wrote 144), Strava used p95 client-side, Apple Health used
 * a raw Math.max of workout peaks (spike-fragile: a single wrist cadence-lock
 * reading would be ratcheted in forever). All three fed the same up-only
 * ratchet on `s.maxHR`, so the stored ceiling depended on which pipe a
 * session arrived through.
 *
 * Estimate = the highest CORROBORATED reading: a session max counts only if
 * a second session on a DIFFERENT calendar day peaked within
 * MAX_HR_WITNESS_WINDOW_BPM of it. Rationale:
 *   - A single uncorroborated spike (optical cadence-lock, cold-start sensor
 *     jump) has no witness and is discarded — e.g. a lone 216 next to a
 *     201/202/203 cluster.
 *   - The different-day rule means cross-source duplicates of the SAME
 *     session (Strava + Garmin webhook twins) cannot witness each other.
 *   - p95-of-session-maxes is NOT used: it measures the training intensity
 *     distribution (most sessions are submaximal), so it sits permanently
 *     below true max and drifts with training mix, not physiology.
 *
 * Known limitation (deliberate, logged in SCIENCE_LOG): no downward revision.
 * Max HR declines ~0.7 bpm/yr with age (Tanaka 2001), so a years-old ceiling
 * goes stale-high. Deferred until the app's lifetime makes the drift material.
 */

export interface MaxHRReading {
  /** Session max heart rate, bpm */
  maxHR: number;
  /** Session date — ISO string; only the YYYY-MM-DD prefix is compared */
  date: string;
}

/**
 * Hard-effort floor. A reading below this cannot define or witness a max:
 * walking/swimming wrist HR and easy-session peaks say nothing about the
 * athlete's ceiling. Reuses the Apple Health observed-max gate ("hard
 * interval sessions land within 1–2 bpm of lab max; require peaks ≥ 150").
 * This is also what prevents the historical 144-bpm write: two easy sessions
 * corroborating each other at 144 no longer produce an estimate.
 */
export const MAX_HR_FLOOR_BPM = 150;

/** Plausibility ceiling (was stravaSync's `< 230` gate). */
export const MAX_HR_CEILING_BPM = 230;

/** A witness must peak within this many bpm of the candidate reading. */
export const MAX_HR_WITNESS_WINDOW_BPM = 5;

/**
 * Highest corroborated session max across `readings`, or null when no
 * reading has a witness (including: fewer than 2 valid readings).
 */
export function corroboratedMaxHR(readings: MaxHRReading[]): number | null {
  const valid = readings
    .map(r => ({ maxHR: r.maxHR, day: (r.date ?? '').slice(0, 10) }))
    .filter(r =>
      Number.isFinite(r.maxHR)
      && r.maxHR >= MAX_HR_FLOOR_BPM
      && r.maxHR < MAX_HR_CEILING_BPM
      && r.day.length === 10,
    )
    .sort((a, b) => b.maxHR - a.maxHR);

  for (const candidate of valid) {
    const witnessed = valid.some(other =>
      other.day !== candidate.day
      && Math.abs(other.maxHR - candidate.maxHR) <= MAX_HR_WITNESS_WINDOW_BPM,
    );
    if (witnessed) return candidate.maxHR;
  }
  return null;
}

/**
 * Apply the corroborated estimate to state with the shared ratchet rule:
 * max HR is a physiological ceiling — only raise, never lower. A lower
 * estimate is expected (the athlete simply hasn't maxed out recently or the
 * corroborated cluster sits below a manually-entered value) and is not an
 * anomaly, so it logs at info level, not warn.
 *
 * Caller is responsible for saveState() when `changed` is true.
 */
export function applyCorroboratedMaxHR(
  s: { maxHR?: number },
  readings: MaxHRReading[],
  source: string,
): { estimate: number | null; changed: boolean } {
  const estimate = corroboratedMaxHR(readings);
  if (estimate == null) return { estimate, changed: false };
  const current = s.maxHR ?? 0;
  if (estimate > current) {
    console.log(`[${source}] maxHR ${current || 'unset'} → ${estimate} (corroborated max of ${readings.length} readings)`);
    s.maxHR = estimate;
    return { estimate, changed: true };
  }
  if (estimate < current) {
    console.log(`[${source}] Corroborated maxHR estimate ${estimate} ≤ current ${current} — keeping ceiling.`);
  }
  return { estimate, changed: false };
}
