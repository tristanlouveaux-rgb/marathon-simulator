/**
 * Athlete archetype classification. What KIND of athlete is starting this plan.
 *
 * The plan engine's ramp rate and the predictor's confidence band both depend
 * on it. A user running 18 km/wk today could be (a) returning after a layoff
 * with marathon history (high muscle-memory ceiling, can ramp aggressively),
 * (b) a cyclist with no impact tolerance (bone/tendon-limited), or
 * (c) a true novice. Same baseline, totally different plan.
 *
 * Science:
 *  - Bone/tendon adaptation lags VO₂max by 6-12 weeks (Bennell 1996, Warden 2014).
 *  - Detraining: VO₂max -7-10%/mo, but retrained runners regain 2-3× faster
 *    than de-novo (Mujika & Padilla 2000; Egan & Zierath 2013. Satellite-cell
 *    retention).
 *  - ACWR sweet spot 0.8-1.3, danger >1.5 (Gabbett 2016).
 *
 * Inputs: read entirely from existing state (Strava history pipeline +
 * onboarding capture). No DB queries.
 *
 * Re-runs: archetype is a state, not an identity. Detection should run at
 * onboarding completion AND on the existing 7-day historicLastRefreshedAt
 * refresh, so a "detrained-with-history" user becomes "consistent-runner"
 * after 12 weeks of adherence.
 */

import type { SimulatorState } from '@/types/state';

type State = SimulatorState;

export type Archetype =
  | 'high-mileage'
  | 'consistent-runner'
  | 'detrained-with-history'
  | 'cross-trained-impact'
  | 'cross-trained-no-impact'
  | 'sedentary-novice'
  | 'unknown';

export type ArchetypeConfidence = 'high' | 'medium' | 'low' | 'none';

export interface ArchetypeEvidence {
  /** Mean weekly running km across the most recent 4-8 weeks (s.detectedWeeklyKm). */
  currentWeeklyKm: number;
  /** Peak weekly running km in the extended history window (up to 52 weeks). */
  peakWeeklyKmPast52: number;
  /** Longest single run in past 12 months, derived from onboardingRunHistory + history aggregates. */
  longestRunPast12moKm: number;
  /** Weeks since the last week with ≥ 20 km of running. `Infinity` if never. */
  weeksSinceConsistent: number;
  /** Estimated cross-training hours per week, summed across non-run sports. */
  crossTrainingHoursPerWeek: number;
  /** True if any non-running impact sport (soccer, rugby, tennis, basketball, ...) has consistent presence. */
  impactSportPresent: boolean;
  /** True if user has a marathon PB recorded OR a run ≥ 38 km in extended history. */
  hasCompletedMarathon: boolean;
  /** Years since first recorded Strava activity. `null` if Strava not connected or never queried. */
  yearsOfRecordedTraining: number | null;
  /** Coefficient of variation of historicWeeklyKm — how steady the recent volume is. */
  weeklyKmCV: number;
}

export interface ArchetypeResult {
  archetype: Archetype;
  confidence: ArchetypeConfidence;
  evidence: ArchetypeEvidence;
  /** ISO timestamp of this classification — written to s.athleteArchetypeAt. */
  computedAt: string;
}

// ---------------------------------------------------------------------------
// Sport classification (sport labels from supabase/functions/sync-strava-activities/index.ts:809)
// ---------------------------------------------------------------------------

const IMPACT_SPORTS = new Set([
  'running', // already excluded as the primary signal but listed for completeness
  'soccer',
  'rugby',
  'tennis',
  'hiit',
  'climbing',
]);

const NON_IMPACT_AEROBIC = new Set([
  'cycling',
  'swimming',
  'rowing',
  'paddle',
  'walking',
  'skiing',
  'cardio',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coefficientOfVariation(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

function yearsBetween(isoFrom: string | null | undefined, isoTo: Date): number | null {
  if (!isoFrom) return null;
  const from = new Date(isoFrom);
  if (Number.isNaN(from.getTime())) return null;
  return (isoTo.getTime() - from.getTime()) / (365.25 * 24 * 3600 * 1000);
}

/** The state fields gatherEvidence reads. */
export type ArchetypeEvidenceState = Pick<
  State,
  | 'detectedWeeklyKm' | 'extendedHistoryKm' | 'historicWeeklyKm' | 'onboardingRunHistory'
  | 'sportBaselineByType' | 'onboarding' | 'firstStravaActivityISO'
>;

/**
 * Build the evidence object from state. Pure. No side effects.
 */
export function gatherEvidence(s: ArchetypeEvidenceState, now: Date = new Date()): ArchetypeEvidence {
  const currentWeeklyKm = s.detectedWeeklyKm ?? 0;
  const weeklyKmHistory: number[] = s.extendedHistoryKm?.length
    ? s.extendedHistoryKm
    : (s.historicWeeklyKm ?? []);

  const peakWeeklyKmPast52 = weeklyKmHistory.length > 0
    ? Math.max(...weeklyKmHistory)
    : 0;

  // Longest single run in past 12 months: onboardingRunHistory holds individual runs,
  // extendedHistory is per-week aggregates so the best we can do there is bound the
  // longest by the peak weekly km (if peak week had only one run, that's the long run).
  const longestFromOnboarding = (s.onboardingRunHistory ?? [])
    .filter((r: { activityType: string }) => /run/i.test(r.activityType))
    .reduce((max: number, r: { distKm: number }) => Math.max(max, r.distKm), 0);
  const longestRunPast12moKm = longestFromOnboarding;

  // Weeks since last consistent week. Scan the most recent extended history.
  const REVERSED = [...weeklyKmHistory].reverse();
  let weeksSinceConsistent = Infinity;
  for (let i = 0; i < REVERSED.length; i++) {
    if (REVERSED[i] >= 20) { weeksSinceConsistent = i; break; }
  }

  // Cross-training: sportBaselineByType already excludes running.
  // We approximate hours/week using sessionsPerWeek × 1 hour as a coarse proxy when no duration is available.
  // (sportBaselineByType stores sessionsPerWeek but not durationPerSession; using 1 hour avoids over-claiming.)
  let crossTrainingHoursPerWeek = 0;
  let impactSportPresent = false;
  const sportEntries = Object.entries(s.sportBaselineByType ?? {}) as Array<
    [string, { avgSessionRawTSS: number; sessionsPerWeek: number }]
  >;
  for (const [sport, agg] of sportEntries) {
    if (sport === 'running') continue;
    const approxHours = (agg.sessionsPerWeek ?? 0) * 1.0;
    crossTrainingHoursPerWeek += approxHours;
    if (IMPACT_SPORTS.has(sport) && (agg.sessionsPerWeek ?? 0) >= 0.5) {
      impactSportPresent = true;
    }
  }
  crossTrainingHoursPerWeek = Math.round(crossTrainingHoursPerWeek * 10) / 10;

  // Marathon completion: PB recorded OR a run ≥ 38 km in onboardingRunHistory.
  const pbs = s.onboarding?.pbs;
  const hasMarathonPB = pbs?.m != null && pbs.m > 0;
  const hasMarathonRun = (s.onboardingRunHistory ?? []).some((r: { distKm: number }) => r.distKm >= 38);
  const hasCompletedMarathon = hasMarathonPB || hasMarathonRun;

  const yearsOfRecordedTraining = yearsBetween(s.firstStravaActivityISO ?? null, now);

  const weeklyKmCV = coefficientOfVariation(weeklyKmHistory.slice(-12));

  return {
    currentWeeklyKm,
    peakWeeklyKmPast52,
    longestRunPast12moKm,
    weeksSinceConsistent,
    crossTrainingHoursPerWeek,
    impactSportPresent,
    hasCompletedMarathon,
    yearsOfRecordedTraining,
    weeklyKmCV,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify the athlete from evidence.
 *
 * Decision order (top-down. The first matching archetype wins):
 *   1. high-mileage. Current ≥ 50 km/wk AND CV < 0.35
 *   2. consistent-runner. Current ≥ 20 km/wk AND recent (weeksSinceConsistent ≤ 2)
 *      OR currentWk < 20 with recent consistency (a stable low-volume runner who
 *      just dipped below 20 km last week is "consistent at their level", not
 *      detrained. Detrained requires an actual gap of 3+ weeks).
 *   3. detrained-with-history. Current < 20 km/wk, hasn't been ≥ 20 for 3+ weeks,
 *      AND has running history (peak past year ≥ 25 km / longest run ≥ 15 km /
 *      completed marathon).
 *   4. cross-trained-impact. Current < 15 km/wk AND impactSportPresent
 *   5. cross-trained-no-impact. Current < 15 km/wk AND crossTrainingHours ≥ 2
 *   6. sedentary-novice. Everything else with current < 10 km/wk
 *   else `consistent-runner` (fallback for ambiguous mid-range without history)
 */
export function classify(e: ArchetypeEvidence): Archetype {
  if (e.currentWeeklyKm >= 50 && e.weeklyKmCV < 0.35) {
    return 'high-mileage';
  }
  if (e.currentWeeklyKm >= 20 && e.weeksSinceConsistent <= 2) {
    return 'consistent-runner';
  }
  if (e.currentWeeklyKm < 20) {
    const hasHistory =
      e.peakWeeklyKmPast52 >= 25 ||
      e.longestRunPast12moKm >= 15 ||
      e.hasCompletedMarathon;
    // Stable low-volume runner with history. They hit ≥ 20 km recently and
    // have demonstrable running base. Not detrained, just a low-volume athlete.
    // Detrained requires an actual layoff of 3+ weeks below 20 km.
    if (hasHistory && e.weeksSinceConsistent <= 2) return 'consistent-runner';
    if (hasHistory) return 'detrained-with-history';
    if (e.impactSportPresent) return 'cross-trained-impact';
    if (e.crossTrainingHoursPerWeek >= 2) return 'cross-trained-no-impact';
    if (e.currentWeeklyKm < 10) return 'sedentary-novice';
  }
  // Ambiguous mid-range with no signal. Treat as consistent. The ramp slope
  // for consistent-runner is conservative enough to be safe if wrong.
  return 'consistent-runner';
}

/**
 * Confidence in the classification.
 *
 *  - high. 26+ weeks of extended history AND Strava tenure > 1 yr
 *  - medium. 8-26 weeks of history
 *  - low. Only onboardingRunHistory or < 8 weeks
 *  - none. Strava not connected and no run history at all
 */
export function confidenceFromState(s: State, e: ArchetypeEvidence): ArchetypeConfidence {
  const extWeeks = s.extendedHistoryKm?.length ?? 0;
  const histWeeks = s.historicWeeklyKm?.length ?? 0;
  const onboardingRuns = s.onboardingRunHistory?.length ?? 0;
  const stravaConnected = Boolean(s.stravaHistoryFetched);

  if (!stravaConnected && onboardingRuns === 0) return 'none';
  if (extWeeks >= 26 && (e.yearsOfRecordedTraining ?? 0) > 1) return 'high';
  if (extWeeks >= 8 || histWeeks >= 8) return 'medium';
  return 'low';
}

/**
 * One-shot entry point: classify the athlete given the current state.
 */
export function detectArchetype(s: State, now: Date = new Date()): ArchetypeResult {
  const evidence = gatherEvidence(s, now);
  const confidence = confidenceFromState(s, evidence);
  const archetype: Archetype = confidence === 'none' ? 'unknown' : classify(evidence);
  return {
    archetype,
    confidence,
    evidence,
    computedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Typed weekly volume (no sync): the same classifier, fed the typed km
// ---------------------------------------------------------------------------

/** The state fields the typed-volume archetype reads. */
export type TypedVolumeState = ArchetypeEvidenceState & Pick<State, 'weeklyVolumeConfirmed'>;

/**
 * The weekly running km the athlete typed (manual entry or the review-step
 * slider: both write s.detectedWeeklyKm and set s.weeklyVolumeConfirmed), or
 * undefined when none was typed or confirmed. A sync that aggregates history
 * overwrites detectedWeeklyKm with its own 4-week mean, so after a sync this
 * returns the synced km; every caller reads synced fields (athleteArchetype,
 * historicWeeklyTSS, ctlBaseline) first, so the typed reading only applies
 * while no sync has written them.
 */
export function typedWeeklyKm(s: Pick<State, 'detectedWeeklyKm' | 'weeklyVolumeConfirmed'>): number | undefined {
  if (!s.weeklyVolumeConfirmed) return undefined;
  const km = s.detectedWeeklyKm;
  return km != null && km > 0 ? km : undefined;
}

/**
 * Archetype for an athlete whose only volume signal is a typed weekly km
 * (Tristan, 2026-10-09: typed weekly km shapes the plan). Runs the same
 * classifier a sync runs (gatherEvidence + classify) on the typed km.
 *
 * A typed number supplies the current weekly km only. A classifier branch whose
 * deciding input a typed number cannot supply does not fire, and the athlete
 * falls through to the next branch, ending at the classifier's own fallback
 * (consistent-runner, "conservative enough to be safe if wrong"):
 *  - Week-to-week variability (weeklyKmCV) is unknown, so high-mileage
 *    (>= 50 km AND CV < 0.35) never fires: typed 50 km or more is
 *    consistent-runner (x1.05 start, 7% ramp), the same as typed 20 to 50 km.
 *    Reading the missing CV as 0 instead made typing more km buy a slower ramp
 *    (3%), which shortened a sharpening block's long-run build (review,
 *    2026-10-09).
 *  - Recency of a 20 km week (weeksSinceConsistent) is unknown, so neither
 *    history branch fires: detrained-with-history (needs a 3+ week layoff) and
 *    "consistent at their level" (needs a 20 km week in the last 2). The
 *    history evidence (marathon PB, peak week, longest run) decides only those
 *    two branches, so a typed km is classified as it would be without it: a PB
 *    never lowers the start (typed 5 km with or without a marathon PB is
 *    sedentary-novice, 10 km floor).
 *  - Cross-training (sportBaselineByType) is read from state as the classifier
 *    does; a sync writes it, so with typed km alone it is absent and claims nothing.
 * Runs per week is not a classifier input.
 *
 * Undefined when nothing was typed, or when synced weekly history exists: that
 * athlete is classified from the history (detectArchetype in the sync paths,
 * the main.ts launch back-fill).
 */
export function typedVolumeArchetype(s: TypedVolumeState): Archetype | undefined {
  if (typedWeeklyKm(s) == null) return undefined;
  if ((s.historicWeeklyKm?.length ?? 0) > 0 || (s.extendedHistoryKm?.length ?? 0) > 0) return undefined;
  return classify({
    ...gatherEvidence(s),
    // Unknown, not steady: NaN fails the high-mileage CV < 0.35 test.
    weeklyKmCV: Number.NaN,
    // Only the two recency-gated history branches read these; recency is unknown.
    peakWeeklyKmPast52: 0,
    longestRunPast12moKm: 0,
    hasCompletedMarathon: false,
  });
}

/**
 * The archetype every reader of the volume ramp uses: the synced
 * classification (s.athleteArchetype, written by the Strava and Apple Health
 * syncs) when present, else the typed-volume classification. One source for
 * the plan engine (planEngineStateInputs) and the race forecasts that
 * integrate the same ramp (planForecastWeeklyKm, race-forecast-simulation,
 * the onboarding forecast), so a forecast credits the ramp the plan builds.
 */
export function planRampArchetype(
  s: TypedVolumeState & { athleteArchetype?: { archetype?: Archetype } | null },
): Archetype | undefined {
  return s.athleteArchetype?.archetype ?? typedVolumeArchetype(s);
}

// ---------------------------------------------------------------------------
// Ramp + prediction parameters keyed by archetype
// ---------------------------------------------------------------------------

/**
 * Plan-engine ramp parameters.
 *
 *  - `startingWeeklyKmCap`. Week-1 ceiling expressed as `current_km × multiplier
 *    + headroom`. Floor for `cross-trained-impact` is 15 km because the bone is
 *    adapted; for `cross-trained-no-impact` we deliberately stay near current
 *    running km regardless of aerobic capacity.
 *  - `weeklyRampPct`. Additive % progression per week toward `peakWeeklyKm`,
 *    derived from Reilly's 10% guideline and Gabbett ACWR safe zone. Lower for
 *    bone-limited cohorts.
 *  - `predictionBandPctWidth`. ± uncertainty added to predicted finish time;
 *    narrows as wkAdherenceRecent rises (handled by the predictor).
 */
export const ARCHETYPE_PARAMS: Record<Archetype, {
  startingWeeklyKmMultiplier: number;
  startingWeeklyKmHeadroom: number;
  startingWeeklyKmFloor: number;
  weeklyRampPct: number;
  predictionBandPctWidth: number;
}> = {
  'high-mileage':            { startingWeeklyKmMultiplier: 1.00, startingWeeklyKmHeadroom: 0,  startingWeeklyKmFloor: 0,  weeklyRampPct: 0.03, predictionBandPctWidth: 0.03 },
  'consistent-runner':       { startingWeeklyKmMultiplier: 1.05, startingWeeklyKmHeadroom: 0,  startingWeeklyKmFloor: 0,  weeklyRampPct: 0.07, predictionBandPctWidth: 0.04 },
  'detrained-with-history':  { startingWeeklyKmMultiplier: 1.10, startingWeeklyKmHeadroom: 5,  startingWeeklyKmFloor: 15, weeklyRampPct: 0.10, predictionBandPctWidth: 0.07 },
  'cross-trained-impact':    { startingWeeklyKmMultiplier: 1.15, startingWeeklyKmHeadroom: 0,  startingWeeklyKmFloor: 15, weeklyRampPct: 0.08, predictionBandPctWidth: 0.10 },
  'cross-trained-no-impact': { startingWeeklyKmMultiplier: 1.00, startingWeeklyKmHeadroom: 0,  startingWeeklyKmFloor: 10, weeklyRampPct: 0.05, predictionBandPctWidth: 0.12 },
  'sedentary-novice':        { startingWeeklyKmMultiplier: 1.00, startingWeeklyKmHeadroom: 0,  startingWeeklyKmFloor: 10, weeklyRampPct: 0.05, predictionBandPctWidth: 0.15 },
  'unknown':                 { startingWeeklyKmMultiplier: 1.00, startingWeeklyKmHeadroom: 0,  startingWeeklyKmFloor: 0,  weeklyRampPct: 0.07, predictionBandPctWidth: 0.10 },
};

/**
 * Maximum acute:chronic workload ratio applied to the week-1 starting volume.
 * Gabbett (2016) identifies the "sweet spot" at 0.8-1.3 and the "danger zone"
 * above 1.5. We cap at 1.30 so the very first week is at the upper edge of
 * the sweet spot. Never higher.
 *
 * Only applied when baseline > 10 km. Below that, the absolute load is small
 * enough that even a +50% jump remains low-risk, and the archetype floors
 * (15 km for cross-trained-impact, 10 km for sedentary) govern.
 */
const ACWR_SAFETY_CAP = 1.30;
const ACWR_CAP_BASELINE_MIN = 10;

/**
 * Starting weekly km cap for week 1 of the plan, given the user's current
 * baseline and the detected archetype.
 *
 *   raw_start = max(floor, current × multiplier + headroom)
 *   start_km  = (baseline > 10) ? min(raw_start, baseline × 1.30) : raw_start
 *
 * The ACWR cap protects users with moderate-to-high baseline from
 * archetype-floor-induced spikes (e.g. detrained-with-history at 18 km/wk
 * would otherwise start at 24.8 km. A +36% jump in week 1, above safe
 * ACWR). Below 10 km baseline, the floor governs because the absolute load
 * is tiny and the relative ratio isn't a meaningful injury signal.
 *
 * If baseline is 0 (no data), starts at the floor.
 */
export function startingWeeklyKm(baselineKm: number, archetype: Archetype): number {
  const p = ARCHETYPE_PARAMS[archetype];
  const rawStart = Math.max(
    p.startingWeeklyKmFloor,
    baselineKm * p.startingWeeklyKmMultiplier + p.startingWeeklyKmHeadroom,
  );
  if (baselineKm > ACWR_CAP_BASELINE_MIN) {
    return Math.min(rawStart, baselineKm * ACWR_SAFETY_CAP);
  }
  return rawStart;
}

/**
 * Plan-week km target with archetype-gated ramp.
 *
 *   week_km = min(peak_km, start_km × (1 + ramp_pct)^(weekIndex - 1))
 *
 * Geometric (compounding) progression matches Reilly/Gabbett safe-loading
 * literature better than linear, because absolute weekly increases scale with
 * current load. Capped at `peakWeeklyKm` so the plan never overshoots target.
 *
 * `weekIndex` is 1-based: week 1 of the plan = `startingWeeklyKm`.
 */
export function weekVolumeBudgetKm(
  weekIndex: number,
  baselineKm: number,
  peakKm: number,
  archetype: Archetype,
): number {
  if (weekIndex < 1) return baselineKm;
  const start = startingWeeklyKm(baselineKm, archetype);
  if (start >= peakKm) return peakKm;
  const { weeklyRampPct } = ARCHETYPE_PARAMS[archetype];
  const target = start * Math.pow(1 + weeklyRampPct, weekIndex - 1);
  return Math.min(peakKm, target);
}
