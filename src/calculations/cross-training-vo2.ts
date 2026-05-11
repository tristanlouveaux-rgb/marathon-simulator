/**
 * Cross-Training VO2max — sustained-HR aerobic capacity from non-run, non-bike sport.
 *
 * The cardiac ceiling (Uth-Sørensen) tells us how high the heart *can* go —
 * peak HR / resting HR. It does not tell us how much aerobic work the athlete
 * can sustain. A rugby player who briefly hits 195 bpm has the same cardiac
 * ceiling as one who holds 175 bpm for 60 minutes; their aerobic capacities
 * are very different. This estimator measures the second story.
 *
 * Method:
 *
 * 1. For each qualifying cross-training session, compute %HRR (heart rate
 *    reserve fraction sustained during the session):
 *
 *        %HRR = (avgHR − RHR) / (HRmax − RHR)
 *
 * 2. Convert to fractional VO2 reserve using Swain & Leutholtz (1997,
 *    *MSSE* 29:837–843):
 *
 *        %VO2R ≈ %HRR
 *
 *    The linear identity holds well in the 40–85% range against gas-exchange
 *    measurement; drift outside this band is small (~5%) and we accept it.
 *
 * 3. Anchor to the athlete's cardiac ceiling. If the athlete is sustaining
 *    %VO2R during the session, their working VO2 is approximately
 *    %VO2R × VO2max. Cardiac ceiling is the modality-agnostic VO2max upper
 *    bound, so:
 *
 *        sessionVO2 ≈ cardiacCeiling × %VO2R × durationFactor
 *
 *    where durationFactor = min(1, durationMin / 30) credits sustain. A
 *    20-minute session counts at 0.67×; a 30+ minute session at 1.0×. This
 *    captures the physiological reality that *holding* a high HR fraction
 *    is what demonstrates capacity — short HR spikes at the same %HRR are
 *    largely anaerobic and inform cardiac ceiling, not sustained aerobic
 *    capacity.
 *
 * 4. Aggregate across qualifying sessions using a trimmed mean (drop the
 *    lowest 25%, mean of the remainder). This makes the estimate robust to
 *    occasional low-effort sessions that pass the gate.
 *
 * Why this is additive over cardiac ceiling:
 *   - Cardiac ceiling = `15.3 × HRmax/HRrest` — one-shot peak ratio.
 *   - Cross-training = sustained fraction × ceiling × duration credit —
 *     captures the *aerobic* dimension cardiac ceiling cannot see.
 *
 * Why this does not lift running or cycling:
 *   - The running VDOT regression already credits cardiac contribution
 *     implicitly (a heart trained by rugby pumps at lower HR-for-pace during
 *     runs). Lifting running would double-count, the same reason cardiac
 *     ceiling itself was de-blended from per-modality numbers in May 2026.
 *
 * Limitations:
 *   - HR-only methods cannot distinguish aerobic capacity from running
 *     economy or cardiovascular drift. This is a *fitness proxy*, not a lab
 *     measure.
 *   - Swain's linear %HRR↔%VO2R holds in 40–85%; pushed beyond, drifts ~5%.
 *   - Cardiac ceiling anchor inherits Uth-Sørensen's ±10–15% accuracy band.
 *   - Mode-of-effort matters: a session with intervals above LT plus easy
 *     recovery averages to a moderate %HRR even though the actual aerobic
 *     stress is far higher than the average suggests. We accept this for
 *     v1 — it under-credits intervals, which is the safer error.
 *
 * Pure — no state dependency, fully testable.
 */

export interface CrossTrainingActivitySample {
  /** ISO timestamp or Date. */
  startTime: string | Date;
  /** Duration in seconds. */
  durationSec: number;
  /** Average HR across the session. */
  avgHR?: number | null;
  /** Sport key from `SPORTS_DB`. Used to gate run/bike out and to tally
   *  distinct sports for the confidence boost. */
  sport?: string | null;
}

export type CrossTrainingConfidence = 'high' | 'medium' | 'low' | 'none';

export interface CrossTrainingVO2Result {
  /** Estimated cross-training VO2max in ml/kg/min, or null when inputs are
   *  missing or below the minimum-session threshold. */
  vo2: number | null;
  /** Number of qualifying sessions in the window. */
  n: number;
  /** Distinct cross-training sports represented. Drives confidence boost. */
  distinctSports: number;
  /** Confidence tier. */
  confidence: CrossTrainingConfidence;
  /** Reason for null result, when applicable. */
  reason?: 'no-cardiac-ceiling' | 'no-rhr' | 'no-hrmax' | 'insufficient-sessions';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_WEEKS = 8;
/** Minimum session duration to qualify. Below this, we cannot credibly
 *  argue that the athlete sustained an aerobic intensity rather than
 *  spiking through it. */
const MIN_DURATION_SEC = 20 * 60;
/** Minimum %HRmax — sessions averaging below this are not aerobic enough
 *  to inform VO2max. 75% HRmax ≈ Z2 upper / Z3 lower. */
const MIN_PCT_HRMAX = 0.75;
/** Minimum qualifying sessions to surface a value at all. Below this,
 *  the estimator returns null with reason 'insufficient-sessions' and the
 *  card hides the row entirely. */
const MIN_SESSIONS = 3;
/** Duration at which a session earns full credit. Linear ramp from 20→30 min.
 *  Beyond 30 min, no further credit (a 60-min session does not count more
 *  than a 30-min one — sustain is sustain, longer doesn't make VO2max bigger). */
const FULL_CREDIT_MIN = 30;
/** Sports that are NOT cross-training in this estimator's view. Running and
 *  cycling have their own dedicated estimators (effort-calibrated VDOT and
 *  ACSM FTP) which are more accurate; we should not also feed them in here. */
const EXCLUDED_SPORTS = new Set([
  'running', 'extra_run',
  'cycling', 'mountain_biking',
]);

/**
 * Compute a cross-training VO2max estimate from sustained-HR data in
 * non-run, non-bike activities.
 *
 * @param activities       Recent aerobic sessions across all sports. Filter
 *                         is applied internally — caller doesn't need to
 *                         pre-screen.
 * @param restingHR        Resting heart rate, bpm.
 * @param maxHR            Athlete's max HR, bpm.
 * @param cardiacCeiling   Anchor — the athlete's modality-agnostic VO2max
 *                         upper bound from `computeCardiacCeiling`. Without
 *                         it, we cannot convert sustained intensity to
 *                         absolute VO2 demand.
 * @param now              Anchor time for the 8-week window.
 */
export function computeCrossTrainingVO2(
  activities: CrossTrainingActivitySample[],
  restingHR: number | null | undefined,
  maxHR: number | null | undefined,
  cardiacCeiling: number | null | undefined,
  now: Date = new Date(),
): CrossTrainingVO2Result {
  const empty: CrossTrainingVO2Result = {
    vo2: null,
    n: 0,
    distinctSports: 0,
    confidence: 'none',
  };

  if (!cardiacCeiling || cardiacCeiling <= 0) {
    return { ...empty, reason: 'no-cardiac-ceiling' };
  }
  if (!restingHR || restingHR <= 0) {
    return { ...empty, reason: 'no-rhr' };
  }
  if (!maxHR || maxHR <= 0) {
    return { ...empty, reason: 'no-hrmax' };
  }

  const windowStartMs = now.getTime() - WINDOW_WEEKS * 7 * DAY_MS;
  const minHRForAerobic = MIN_PCT_HRMAX * maxHR;
  const hrr = maxHR - restingHR;
  if (hrr <= 0) return { ...empty, reason: 'no-hrmax' };

  const sessionEstimates: number[] = [];
  const sports = new Set<string>();

  for (const a of activities ?? []) {
    if (!a.avgHR || a.avgHR <= 0) continue;
    if (!a.durationSec || a.durationSec < MIN_DURATION_SEC) continue;
    if (a.avgHR < minHRForAerobic) continue;

    // Exclude run/bike — they have dedicated estimators.
    const sport = (a.sport ?? '').toLowerCase();
    if (!sport) continue;  // need a sport to know it isn't a run/bike
    if (EXCLUDED_SPORTS.has(sport)) continue;

    const startMs = new Date(a.startTime).getTime();
    if (!isFinite(startMs) || startMs < windowStartMs) continue;

    const pctHRR = Math.min(1, Math.max(0, (a.avgHR - restingHR) / hrr));
    const durationMin = a.durationSec / 60;
    const durationFactor = Math.min(1, durationMin / FULL_CREDIT_MIN);

    // sessionVO2 = cardiacCeiling × %VO2R × durationFactor
    // Swain: %VO2R ≈ %HRR.
    const sessionVO2 = cardiacCeiling * pctHRR * durationFactor;
    sessionEstimates.push(sessionVO2);
    sports.add(sport);
  }

  const n = sessionEstimates.length;
  if (n < MIN_SESSIONS) {
    return { ...empty, n, distinctSports: sports.size, reason: 'insufficient-sessions' };
  }

  // Trimmed mean: drop the bottom 25% of sessions (warm-ups, light efforts
  // that just passed the gate), take the mean of the remainder. More robust
  // than a plain mean to occasional weak sessions.
  const sorted = sessionEstimates.slice().sort((a, b) => a - b);
  const trimCount = Math.floor(n * 0.25);
  const kept = sorted.slice(trimCount);
  const aggregate = kept.reduce((s, v) => s + v, 0) / kept.length;

  // Cap at cardiac ceiling — by construction sessionVO2 ≤ cardiacCeiling, but
  // be defensive in case durationFactor logic changes and to make the
  // invariant explicit.
  const vo2 = Math.min(aggregate, cardiacCeiling);

  // Confidence model:
  //   high   = ≥ 8 sessions AND ≥ 2 distinct sports — well-sampled, diverse
  //   medium = ≥ 5 sessions
  //   low    = ≥ 3 sessions
  // Sport diversity matters because a single sport's HR profile is
  // idiosyncratic (e.g., touch rugby's stop-start nature averages low even
  // when capacity is high). Multiple sports cross-validate the estimate.
  let confidence: CrossTrainingConfidence;
  if (n >= 8 && sports.size >= 2) confidence = 'high';
  else if (n >= 5) confidence = 'medium';
  else confidence = 'low';

  return {
    vo2,
    n,
    distinctSports: sports.size,
    confidence,
  };
}
