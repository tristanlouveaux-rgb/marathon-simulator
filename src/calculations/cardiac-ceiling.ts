/**
 * Cardiac Ceiling — aerobic upper bound from peak HR ÷ resting HR.
 *
 * Uth-Sørensen formula (Uth, Sørensen, Overgaard, Pedersen 2004,
 * *Eur J Appl Physiol* 91:111–115):
 *
 *     VO2max ≈ 15.3 × (HRmax / HRrest)
 *
 * The constant 15.3 (ml·kg⁻¹·min⁻¹·beat⁻¹) was derived from a regression of
 * VO2max against HRmax/HRrest in trained runners and validated against
 * gas-exchange measurements with ±10–15% accuracy. The formula leverages the
 * fact that maximal cardiac output (HRmax × stroke volume) and resting HR
 * together encode central cardiovascular capacity — the component of VO2max
 * that is *modality-independent* (Bassett & Howley 2000, *MSSE* 32:70–84).
 *
 * What this is and is not:
 *   - IT IS: an aerobic upper bound. The maximum VO2max consistent with the
 *     athlete's HRmax/HRrest ratio. A theoretical ceiling — "if you trained
 *     perfectly across all sports, this is the value your cardiac function
 *     would support". Useful as a headroom indicator when set against the
 *     measured per-modality numbers (running, cycling, cross-training).
 *   - IT IS NOT: a measure of current fitness or sustained aerobic capacity.
 *     A short HR spike during touch rugby contributes to HRmax just as much
 *     as a sustained race effort would; the formula cannot tell the
 *     difference. Aerobic capacity demonstrated under load is what the
 *     `cross-training-vo2.ts` estimator captures (Swain & Leutholtz 1997,
 *     %HRR ≈ %VO2R, anchored to this ceiling × duration sustained).
 *
 * The 2026-05-06 build added the cross-training row precisely so cardiac
 * ceiling no longer has to do double duty as both "your aerobic ceiling" and
 * "your cross-training credit". Cross-training is the sustained-fitness
 * sibling that this ceiling caps. Don't reintroduce framing that implies
 * cardiac ceiling itself credits cross-training fitness — it doesn't.
 *
 * HRmax determination is the dominant source of error: we use *observed*
 * peak HR across recent activity, not a maximal effort test. The 8-week
 * window plus a session-duration filter (≥ 60s) screens out stray spikes
 * (e.g. monitor connection artefacts at the start of a session). Users who
 * never go truly maximal will under-estimate; we never over-credit.
 *
 * Pure — no state dependency, fully testable.
 */

export interface ActivityHRSample {
  /** ISO timestamp or Date. */
  startTime: string | Date;
  /** Duration in seconds. */
  durationSec: number;
  /** Maximum HR observed during the activity. */
  maxHR?: number | null;
  /** Sport key from `SPORTS_DB` (e.g. 'running', 'cycling', 'padel'). Used
   *  for the diversity-of-sources confidence boost. */
  sport?: string | null;
}

export type CardiacConfidence = 'high' | 'medium' | 'low' | 'none';

export interface CardiacCeilingResult {
  /** Estimated cardiac VO2max in ml/kg/min, or null when inputs are missing. */
  vo2: number | null;
  /** Observed peak HR across the qualifying window. */
  hrMaxObserved: number | null;
  /** Resting HR used (passthrough of input). */
  restingHR: number | null;
  /** Confidence tier. */
  confidence: CardiacConfidence;
  /** Number of qualifying sessions feeding HRmax. */
  n: number;
  /** Distinct sports represented (drives the confidence boost). */
  distinctSports: number;
  /** Reason for null result, when applicable. */
  reason?: 'no-rhr' | 'no-hrmax' | 'no-activity';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_WEEKS = 8;
const MIN_SESSION_DURATION_SEC = 60;
const UTH_SORENSEN_K = 15.3;
/** Population maximum HR — anything higher is a sensor glitch, not physiology.
 *  Tanaka 2001 (`HRmax = 208 − 0.7 × age`) tops out around 208 for newborns. */
const PLAUSIBLE_HRMAX_CAP = 220;
/** Cardiac VO2max ceiling cap. Highest measured human VO2max is ~88–95
 *  (Bjørn Dæhlie). For a recreational app, anything above 85 is almost
 *  certainly Uth-Sørensen breaking down at extreme HR ratios — clamp rather
 *  than emit a number that will erode user trust. */
const PLAUSIBLE_VO2_CAP = 85;

/**
 * Compute the cardiac VO2max ceiling.
 *
 * @param activities  Recent aerobic sessions with HR data (any window — function filters to 8w).
 * @param restingHR   Resting heart rate, bpm.
 * @param now         Anchor time for window. Defaults to now.
 * @param athleteMaxHR Optional stored max HR for the athlete. When provided,
 *                     activities reading more than 10 bpm above it are
 *                     filtered as sensor glitches. The population cap (220)
 *                     is too lax for a specific athlete: if this user's
 *                     known max is 193, a single 216-bpm reading inflates
 *                     cardiac by 13 ml/kg/min and shouldn't pass.
 */
export function computeCardiacCeiling(
  activities: ActivityHRSample[],
  restingHR: number | null | undefined,
  now: Date = new Date(),
  athleteMaxHR: number | null | undefined = null,
): CardiacCeilingResult {
  const empty: CardiacCeilingResult = {
    vo2: null, hrMaxObserved: null, restingHR: restingHR ?? null,
    confidence: 'none', n: 0, distinctSports: 0,
  };

  if (!restingHR || restingHR <= 0) {
    return { ...empty, reason: 'no-rhr' };
  }
  if (!activities || activities.length === 0) {
    return { ...empty, reason: 'no-activity' };
  }

  const windowStartMs = now.getTime() - WINDOW_WEEKS * 7 * DAY_MS;

  let hrMaxObserved = 0;
  let n = 0;
  const sports = new Set<string>();

  // Athlete-specific upper bound: 10 bpm above stored max accepts normal
  // session-to-session HRmax variability while rejecting sensor spikes.
  // Falls back to the population cap when stored max is missing.
  const athleteMaxCap = athleteMaxHR && athleteMaxHR > 0
    ? athleteMaxHR + 10
    : PLAUSIBLE_HRMAX_CAP;

  for (const a of activities) {
    if (!a.maxHR || a.maxHR <= 0) continue;
    // Sensor-glitch filter: reject readings above population cap OR more
    // than 10 bpm above the athlete's known max.
    if (a.maxHR > PLAUSIBLE_HRMAX_CAP) continue;
    if (a.maxHR > athleteMaxCap) continue;
    if (!a.durationSec || a.durationSec < MIN_SESSION_DURATION_SEC) continue;

    const startMs = new Date(a.startTime).getTime();
    if (!isFinite(startMs) || startMs < windowStartMs) continue;

    n += 1;
    if (a.maxHR > hrMaxObserved) hrMaxObserved = a.maxHR;
    if (a.sport) sports.add(a.sport);
  }

  if (hrMaxObserved <= restingHR) {
    return { ...empty, n, distinctSports: sports.size, reason: 'no-hrmax' };
  }

  // Clamp Uth-Sørensen output to physiologically plausible upper limit.
  const vo2 = Math.min(UTH_SORENSEN_K * (hrMaxObserved / restingHR), PLAUSIBLE_VO2_CAP);

  // Confidence model:
  //   high   = ≥ 8 sessions AND ≥ 2 distinct sports — diverse, well-sampled HR exposure
  //   medium = ≥ 4 sessions
  //   low    = ≥ 1 session
  // Sport diversity matters because HRmax is more reliable when multiple
  // sports have probed the cardiac ceiling — single-sport HRmax may understate
  // true peak (e.g. a habitually slow runner who never spikes HR).
  let confidence: CardiacConfidence = 'low';
  if (n >= 8 && sports.size >= 2) confidence = 'high';
  else if (n >= 4) confidence = 'medium';

  return {
    vo2,
    hrMaxObserved,
    restingHR,
    confidence,
    n,
    distinctSports: sports.size,
  };
}
