/**
 * daily-coach.ts
 * ==============
 * Central coaching aggregator. Takes full SimulatorState and returns a
 * structured CoachState with stance, blockers, and all signals needed
 * to render the Coach modal and call the LLM narrative edge function.
 *
 * Pure function — no side effects, no network calls.
 */

import type { SimulatorState } from '@/types';
import {
  computeReadinessACWR,
  computeLiveSameSignalTSB,
  computeFitnessModel,
  computeWeekTSS,
  computePlannedWeekTSS,
  getTrailingEffortScore,
  computeTodaySignalBTSS,
  computePlannedDaySignalBTSS,
  estimateWorkoutDurMin,
  REST_DAY_OVERREACH_RATIO,
} from '@/calculations/fitness-model';
import { computeReadiness, computeRecoveryScore, type ReadinessResult } from '@/calculations/readiness';
import { computeWeekSignals, type WeekSignals } from '@/calculations/coach-insight';
import { getSleepInsight, getSleepBank, deriveSleepTarget, computeSleepDebt, fmtSleepDebt, buildDailySignalBTSS } from '@/calculations/sleep-insights';
import { generateWeekWorkouts } from '@/workouts';
import { isHardWorkout } from '@/workouts/scheduler';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CoachStance = 'push' | 'normal' | 'reduce' | 'rest';
export type CoachBlocker = 'injury' | 'illness' | 'overload' | 'sleep';
export type CoachAlertLevel = 'ok' | 'caution' | 'warning';

/**
 * Structured signals passed to the LLM narrative edge function.
 * All numeric values are user-facing scale (TSB ÷7, CTL ÷7, etc.).
 */
export interface CoachSignals {
  // Readiness
  readinessScore: number;
  readinessLabel: string;
  readinessSentence: string;

  // Freshness / Fitness
  tsb: number;            // daily-equivalent (÷7)
  tsbZone: string;        // Fresh / Recovering / Fatigued / Overtrained
  ctlNow: number;         // daily-equivalent (÷7)
  ctlTrend: 'up' | 'flat' | 'down';

  // Load Safety
  acwr: number;
  acwrStatus: 'safe' | 'caution' | 'high';

  // Recovery
  sleepLastNight: number | null;   // Garmin sleep score 0-100
  sleepAvg7d: number | null;
  hrv: number | null;              // RMSSD ms
  hrvBaseline: number | null;
  sleepBankHours: number | null;   // negative = deficit (rounded to 0.1h, kept for LLM payload)
  sleepDebtSec: number | null;     // canonical cumulative debt in seconds (use for display)

  // Week signals
  weekTSS: number | null;
  plannedTSS: number | null;
  weekRPE: 'hard' | 'on-target' | 'easy' | null;
  hrDrift: 'efficient' | 'moderate' | 'stressed' | null;
  fitnessTrend: 'up' | 'flat' | 'down' | null;
  trackOnlyEmptyWeek: boolean;  // true when no activities logged yet in current track-only week

  // Status
  injuryActive: boolean;
  injuryLocation: string | null;
  illnessActive: boolean;
  illnessSeverity: string | null;

  // Athlete context
  athleteTier: string | null;
  recoveryScore: number | null;
  acwrSafeUpper: number | null;

  // Plan context
  weekNumber: number;
  totalWeeks: number;
  phase: string;
  todayWorkoutName: string | null;
  todayWorkoutType: string | null;
  todayWorkoutDescription: string | null;
  todayPlannedTSS: number | null;
  todayPlannedDurationMin: number | null;

  // Subjective
  todayFeeling: 'struggling' | 'ok' | 'good' | 'great' | null;
}

/** Extra context from the view layer that daily-coach can't derive from state alone. */
export interface StrainContext {
  /** Today's actual TSS as % of target (0 = nothing logged yet). */
  strainPct: number;
  /** True when no planned workout AND no matched activity today. */
  isRestDay: boolean;
  /** Rest day but load > 33% of chronic daily TSS. */
  isRestDayOverreaching: boolean;
  /** Any activity logged today (garminActuals or adhoc). */
  trainedToday: boolean;
  /** Today's planned workout is a quality/hard session. */
  todayIsHard: boolean;
  /** Recent cross-training label + TSS in last 48h (null if none > 25 TSS). */
  recentCrossTraining: { label: string; tss: number } | null;
  /** Today's raw Signal B TSS (0 if nothing logged). Used to judge session weight on adhoc days. */
  actualTSS: number;
  /** Full today-planned workout shape (if any) — used to expose richer context to the LLM. */
  todayPlannedWorkout?: {
    name: string;
    type: string;
    description: string | null;
    plannedTSS: number | null;
    plannedDurationMin: number | null;
  } | null;
}

export interface CoachState {
  stance: CoachStance;
  alertLevel: CoachAlertLevel;
  blockers: CoachBlocker[];
  readiness: ReadinessResult;
  weekSignals: WeekSignals;
  sleepInsight: string | null;
  signals: CoachSignals;
  /** Single authoritative sentence for today — replaces readiness.sentence + HRV banner. */
  primaryMessage: string;
  /** Pre-session context note (e.g. long-run drift warning). Null when not applicable. */
  sessionNote: string | null;
  /**
   * UI ring label. Same as `readiness.label` by default, but swaps to
   * "Recovery" / "Recovering" when the low readiness is purely driven by a
   * completed session (covers both planned and adhoc/rest-day sessions).
   * See `derivePostSessionLabel()`.
   */
  ringLabel: string;
  /**
   * Instruction to the plan renderer, derived from stance (docs/BRAIN.md §How it
   * affects the plan):
   *   stance 'rest'   → 'skip'
   *   stance 'reduce' → 'downgrade'
   *   otherwise       → 'none'
   */
  workoutMod: 'none' | 'downgrade' | 'skip';
}

// ─── Daily feeling helper ────────────────────────────────────────────────────

/**
 * Returns the stored todayFeeling value ONLY when its date matches today.
 * Expires at end of day — stale feelings from yesterday don't leak into today's
 * stance computation.
 */
export function getTodayFeeling(s: SimulatorState): 'struggling' | 'ok' | 'good' | 'great' | null {
  const tf = s.todayFeeling;
  if (!tf) return null;
  const today = new Date().toISOString().split('T')[0];
  if (tf.date !== today) return null;
  return tf.value;
}

// ─── Strain context auto-derivation ─────────────────────────────────────────
// When no StrainContext is passed (e.g. from coach-view), derive it from state.

function deriveStrainContext(s: SimulatorState): StrainContext {
  const wk = (s.wks ?? [])[s.w - 1];
  if (!wk) return { strainPct: 0, isRestDay: true, isRestDayOverreaching: false, trainedToday: false, todayIsHard: false, recentCrossTraining: null, actualTSS: 0 };

  const today = new Date().toISOString().split('T')[0];
  const todayDayOfWeek = (new Date(today + 'T12:00:00').getDay() + 6) % 7;
  const todayTSS = computeTodaySignalBTSS(wk, today);

  // Just-Track users have no plan — skip workout generation entirely. Plan-
  // derived fields (s.rd, s.v, s.pac) are stale defaults in trackOnly and
  // would produce a bogus planned list that poisons the coach ring + copy.
  // Downstream: plannedDayTSS stays 0, hasPlannedWorkout=false, which lets
  // isRestDay / matchedActivityToday drive the ring label off real actuals.
  const plannedWorkouts = s.trackOnly ? [] : generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e,
    s.w, s.tw, s.v, s.gs, getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus,
  );
  if (wk.workoutMoves) {
    for (const [workoutId, newDay] of Object.entries(wk.workoutMoves)) {
      const w = plannedWorkouts.find((wo: any) => (wo.id || wo.n) === workoutId);
      if (w) (w as any).dayOfWeek = newDay;
    }
  }

  const runWorkouts = plannedWorkouts.filter((w: any) => w.t !== 'cross');
  const baseMinPerKm = s.pac?.e ? s.pac.e / 60 : 5.5;
  const plannedDayTSS = computePlannedDaySignalBTSS(runWorkouts, todayDayOfWeek, baseMinPerKm);
  const hasPlannedWorkout = plannedDayTSS > 0;

  // Detect matched activity on a day with no generated workout
  let matchedActivityToday = false;
  if (!hasPlannedWorkout) {
    for (const [, actual] of Object.entries(wk.garminActuals ?? {})) {
      if (!actual.startTime?.startsWith(today)) continue;
      matchedActivityToday = true;
      break;
    }
  }

  const isRestDay = !hasPlannedWorkout && !matchedActivityToday;
  const trainingDayCount = [0,1,2,3,4,5,6]
    .filter(d => computePlannedDaySignalBTSS(runWorkouts, d, baseMinPerKm) > 0).length || 4;
  // Per-session average: planned week TSS / training day count (tracks plan intent, not CTL history)
  const plannedWeekTSS = [0,1,2,3,4,5,6]
    .reduce((sum, d) => sum + computePlannedDaySignalBTSS(runWorkouts, d, baseMinPerKm), 0);
  const perSessionAvg = trainingDayCount > 0 ? plannedWeekTSS / trainingDayCount : 0;
  const isRestDayOverreaching = isRestDay && todayTSS > 0 && perSessionAvg > 0 && todayTSS > perSessionAvg * REST_DAY_OVERREACH_RATIO;

  const strainPct = hasPlannedWorkout && todayTSS > 0 && plannedDayTSS > 0
    ? (todayTSS / plannedDayTSS) * 100 : 0;

  const todayPlanned = plannedWorkouts
    .filter((w: any) => w.status !== 'skip' && w.status !== 'replaced')
    .find((w: any) => w.dayOfWeek === todayDayOfWeek);
  const todayIsHard = todayPlanned ? isHardWorkout(todayPlanned.t) : false;

  // Expose the planned workout shape so Brain/LLM can prescribe concrete action.
  let todayPlannedWorkout: StrainContext['todayPlannedWorkout'] = null;
  if (todayPlanned) {
    const rpe = (todayPlanned as any).rpe ?? (todayPlanned as any).r ?? 5;
    const durMin = Math.round(estimateWorkoutDurMin(todayPlanned as any, baseMinPerKm));
    const plannedDayTSSForToday = computePlannedDaySignalBTSS([todayPlanned as any], todayDayOfWeek, baseMinPerKm);
    todayPlannedWorkout = {
      name: (todayPlanned as any).n ?? '',
      type: (todayPlanned as any).t ?? '',
      description: (todayPlanned as any).d ?? null,
      plannedTSS: plannedDayTSSForToday > 0 ? Math.round(plannedDayTSSForToday) : null,
      plannedDurationMin: durMin > 0 ? durMin : null,
    };
    void rpe;
  }

  return {
    strainPct,
    isRestDay,
    isRestDayOverreaching,
    trainedToday: todayTSS > 0,
    todayIsHard,
    recentCrossTraining: null,
    actualTSS: todayTSS,
    todayPlannedWorkout,
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function computeDailyCoach(s: SimulatorState, strain?: StrainContext): CoachState {
  // Auto-derive strain context when not provided (e.g. from coach-view)
  if (!strain) strain = deriveStrainContext(s);

  const wks = s.wks ?? [];
  const currentWeekIdx = s.w - 1;
  const wk = wks[currentWeekIdx];
  // In track-only mode, week buckets beyond the original plan are empty scaffolding
  // added by advanceWeekToToday. Flag them so per-week signals default to null
  // rather than showing "0 TSS / 0% of plan," which looks like missing data.
  const isEmptyTrackOnlyWeek = !!(s as any).trackOnly
    && !!wk
    && Object.keys(wk.garminActuals ?? {}).length === 0
    && (wk.adhocWorkouts ?? []).filter((w: any) => !w.id?.startsWith('holiday-')).length === 0;
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const physio = s.physiologyHistory ?? [];

  // ── Fitness metrics ───────────────────────────────────────────────────────
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeReadinessACWR(s);
  // Live TSB with intra-week decay through today (shared helper — matches all readiness surfaces).
  const archivedPlans = (s as any).previousPlanWks ?? undefined;
  const liveTSB = computeLiveSameSignalTSB(wks, s.w, s.signalBBaseline ?? undefined, s.ctlBaseline ?? undefined, s.planStartDate, archivedPlans);
  const tsb = liveTSB.tsb;
  const ctlNow = liveTSB.ctl;

  const metrics = computeFitnessModel(wks, s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, undefined, archivedPlans);
  const ctlFourWeeksAgo = metrics[metrics.length - 5]?.ctl ?? ctlNow;
  const ctlDelta = ctlNow - ctlFourWeeksAgo;
  const ctlTrend: 'up' | 'flat' | 'down' = ctlDelta > 0.5 ? 'up' : ctlDelta < -0.5 ? 'down' : 'flat';

  // ── Recovery metrics ──────────────────────────────────────────────────────
  const latestPhysio = physio.slice(-1)[0] ?? null;
  const latestWithSleep = physio.slice().reverse().find(p => p.sleepScore != null) ?? null;
  const sleepScore: number | null = latestWithSleep?.sleepScore ?? null;
  const latestWithHrv = physio.slice().reverse().find(p => p.hrvRmssd != null) ?? null;
  const hrvRmssd: number | null = latestWithHrv?.hrvRmssd ?? null;
  // 7-day avg vs 28-day baseline (matches recovery-view formula).
  // Previous code used last-night vs all-time mean, causing the coach nudge
  // to contradict the recovery card.
  const hrv7 = physio.slice(-7).map(p => p.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const hrvAvg7d: number | null = hrv7.length > 0
    ? hrv7.reduce((a, b) => a + b, 0) / hrv7.length
    : null;
  const baseline28Hrvs = physio.slice(-28).map(p => p.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const hrvPersonalAvg: number | null = baseline28Hrvs.length >= 3
    ? Math.round(baseline28Hrvs.reduce((a, b) => a + b, 0) / baseline28Hrvs.length)
    : null;

  const sleepScores7 = physio.slice(-7).map(p => p.sleepScore).filter((v): v is number => v != null);
  const sleepAvg7d = sleepScores7.length >= 2
    ? Math.round(sleepScores7.reduce((a, b) => a + b, 0) / sleepScores7.length)
    : null;

  const sleepTarget = s.sleepTargetSec ?? deriveSleepTarget(physio);
  const sleepBank = getSleepBank(physio, sleepTarget);
  const dailyTSSByDate = buildDailySignalBTSS(wks, (s as any).previousPlanWks);
  const sleepDebtSec = sleepBank.nightsWithData >= 3
    ? computeSleepDebt(physio, dailyTSSByDate, tier ?? 'recreational', sleepTarget)
    : null;
  const sleepBankHours = sleepDebtSec != null
    ? -Math.round((sleepDebtSec / 3600) * 10) / 10
    : null;

  // ── Readiness ─────────────────────────────────────────────────────────────
  const sleepDebtForRecovery = sleepBank.bankSec < 0 ? Math.abs(sleepBank.bankSec) : 0;
  const recoveryResult = computeRecoveryScore(physio, { sleepDebtSec: sleepDebtForRecovery });
  const readiness = computeReadiness({
    tsb,
    acwr: acwr.ratio,
    ctlNow,
    sleepScore,
    hrvRmssd,
    sleepHistory: physio,
    hrvPersonalAvg,
    sleepBankSec: sleepBank.nightsWithData >= 3 ? sleepBank.bankSec : null,
    weeksOfHistory: metrics.length,
    recentLegLoads: s.recentLegLoads ?? [],
    precomputedRecoveryScore: recoveryResult.hasData ? recoveryResult.score : null,
    strainPct: strain?.trainedToday ? strain.strainPct : null,
    acwrSafeUpper: acwr.safeUpper,
  });

  // ── Week signals ──────────────────────────────────────────────────────────
  const weekTSS = (wk && !isEmptyTrackOnlyWeek)
    ? computeWeekTSS(wk, wk.rated ?? {}, s.planStartDate)
    : null;
  const plannedTSS = computePlannedWeekTSS(
    s.historicWeeklyTSS,
    s.ctlBaseline ?? undefined,
    wk?.ph ?? 'base',
    s.athleteTier,
    s.rw,
  );
  const tssPct = (plannedTSS > 0 && weekTSS != null && weekTSS > 0)
    ? Math.round((weekTSS / plannedTSS) * 100)
    : null;

  const actuals = isEmptyTrackOnlyWeek ? [] : Object.values(wk?.garminActuals ?? {});
  const hrDriftVals = actuals
    .map(a => typeof a.hrDrift === 'number' && !isNaN(a.hrDrift) ? heatAdjust(a.hrDrift, a.ambientTempC) : null)
    .filter((v): v is number => v != null);
  const avgHrDrift = hrDriftVals.length > 0
    ? hrDriftVals.reduce((a, b) => a + b, 0) / hrDriftVals.length
    : null;

  const trailingEffort = getTrailingEffortScore(wks, currentWeekIdx);
  // Compute average HR effort from garminActuals
  const _runTypes = new Set(['RUNNING', 'TREADMILL_RUNNING', 'TRAIL_RUNNING', 'VIRTUAL_RUN', 'TRACK_RUNNING']);
  const hrEffortVals = actuals
    .filter(a => _runTypes.has(a.activityType ?? '') && a.hrEffortScore != null)
    .map(a => a.hrEffortScore as number);
  const avgHrEffort = hrEffortVals.length > 0
    ? hrEffortVals.reduce((a, b) => a + b, 0) / hrEffortVals.length : null;
  const weekSignals = computeWeekSignals(
    wk?.rpeEffort ?? wk?.effortScore ?? trailingEffort ?? null,
    avgHrEffort,
    tssPct,
    ctlDelta,
    avgHrDrift,
  );

  // ── Sleep insight ─────────────────────────────────────────────────────────
  const sleepInsight = getSleepInsight({
    history: physio,
    recentWeeklyTSS: (s.historicWeeklyTSS ?? []).slice(-3),
  });

  // ── Status ────────────────────────────────────────────────────────────────
  const injuryActive = !!(s.injuryState?.active);
  const injuryLocation = s.injuryState?.location ?? null;
  const illnessActive = !!(s.illnessState?.active);
  const illnessSeverity = s.illnessState?.severity ?? null;

  // ── Today's workout ───────────────────────────────────────────────────────
  // Sourced from the strain-context lookup (which already calls generateWeekWorkouts).
  // Previous `_cachedWorkouts` path never populated, so today's workout was missing
  // from signals sent to the LLM — restored here via StrainContext.todayPlannedWorkout.
  const todayPlannedW = strain?.todayPlannedWorkout ?? null;
  const todayWorkouts: Array<{ n: string; t: string }> = todayPlannedW
    ? [{ n: todayPlannedW.name, t: todayPlannedW.type }]
    : [];

  // ── Derive stance ─────────────────────────────────────────────────────────
  const blockers: CoachBlocker[] = [];

  if (injuryActive) blockers.push('injury');
  if (illnessActive) blockers.push('illness');
  if (acwr.status === 'high') blockers.push('overload');
  if (sleepScore != null && sleepScore < 55) blockers.push('sleep');
  else if (sleepBankHours != null && sleepBankHours < -5) blockers.push('sleep');

  // Base stance from blockers + readiness label.
  // Illness tiering: 'resting' → full rest; 'light' → at most 'reduce' (applied below).
  let stance: CoachStance;
  if (blockers.includes('injury')) {
    stance = 'rest';
  } else if (blockers.includes('illness') && illnessSeverity === 'resting') {
    stance = 'rest';
  } else if (blockers.includes('overload')) {
    stance = 'reduce';
  } else if (blockers.includes('sleep') || readiness.label === 'Ease Back') {
    stance = 'reduce';
  } else if (readiness.label === 'Manage Load') {
    stance = readiness.score < 50 ? 'reduce' : 'normal';
  } else if (readiness.label === 'Primed') {
    stance = 'push';
  } else {
    stance = 'normal';
  }

  // Light illness cap: never higher than 'reduce'. Overrides any feeling boost below.
  if (blockers.includes('illness') && illnessSeverity === 'light') {
    if (stance === 'push' || stance === 'normal') stance = 'reduce';
  }

  // ── Daily feeling modifier ──────────────────────────────────────────────
  // Subjective wellness ratings are a well-validated fatigue indicator in sports
  // science (Saw 2016 meta-analysis on athlete self-report). Applied after base
  // stance but gated so a "good/great" boost cannot override active blockers.
  //   struggling → drop one level (push → normal, normal → reduce, reduce → rest)
  //   ok         → no change
  //   good/great → promote 'normal' to 'push' when readiness is at/above Primed
  //                (readiness.ts: score >= 75) AND no blockers are active
  const feeling = getTodayFeeling(s);
  if (feeling === 'struggling') {
    if (stance === 'push') stance = 'normal';
    else if (stance === 'normal') stance = 'reduce';
    else if (stance === 'reduce') stance = 'rest';
    // 'rest' → 'rest'
  } else if ((feeling === 'good' || feeling === 'great')
      && stance === 'normal'
      && blockers.length === 0
      && readiness.score >= 75) {
    // 75 = Primed threshold from readiness.ts.
    stance = 'push';
  }

  const alertLevel: CoachAlertLevel =
    blockers.length > 0 ? 'warning' :
    readiness.label === 'Manage Load' ? 'caution' :
    'ok';

  // Workout modifier derived from final stance (docs/BRAIN.md §How it affects the plan).
  const workoutMod: 'none' | 'downgrade' | 'skip' =
    stance === 'rest' ? 'skip' :
    stance === 'reduce' ? 'downgrade' :
    'none';

  // ── TSB display (÷7 for daily-equivalent) ─────────────────────────────────
  const tsbDisplay = Math.round(tsb / 7);
  const tsbZone = tsb > 0 ? 'Fresh' : tsb >= -10 ? 'Recovering' : tsb >= -25 ? 'Fatigued' : 'Overtrained';

  const signals: CoachSignals = {
    readinessScore: readiness.score,
    readinessLabel: readiness.label,
    readinessSentence: readiness.sentence,

    tsb: tsbDisplay,
    tsbZone,
    ctlNow: Math.round(ctlNow / 7),
    ctlTrend,

    acwr: Math.round(acwr.ratio * 100) / 100,
    acwrStatus: (acwr.status === 'high' || acwr.status === 'safe' || acwr.status === 'caution') ? acwr.status : 'safe',

    sleepLastNight: sleepScore,
    sleepAvg7d,
    hrv: hrvAvg7d != null ? Math.round(hrvAvg7d) : hrvRmssd,
    hrvBaseline: hrvPersonalAvg,
    sleepBankHours,
    sleepDebtSec,

    weekTSS: weekTSS != null ? Math.round(weekTSS) : null,
    plannedTSS: Math.round(plannedTSS),
    weekRPE: weekSignals.rpe,
    hrDrift: weekSignals.hrDrift,
    fitnessTrend: weekSignals.fitness,
    trackOnlyEmptyWeek: isEmptyTrackOnlyWeek,

    injuryActive,
    injuryLocation,
    illnessActive,
    illnessSeverity,

    athleteTier: tier ?? null,
    recoveryScore: recoveryResult.hasData && recoveryResult.score != null ? Math.round(recoveryResult.score) : null,
    acwrSafeUpper: Math.round(acwr.safeUpper * 100) / 100,

    weekNumber: s.w,
    totalWeeks: s.tw,
    phase: wk?.ph ?? 'base',
    todayWorkoutName: todayWorkouts[0]?.n ?? null,
    todayWorkoutType: todayWorkouts[0]?.t ?? null,
    todayWorkoutDescription: todayPlannedW?.description ?? null,
    todayPlannedTSS: todayPlannedW?.plannedTSS ?? null,
    todayPlannedDurationMin: todayPlannedW?.plannedDurationMin ?? null,

    todayFeeling: getTodayFeeling(s),
  };

  const primaryMessage = derivePrimaryMessage(signals, readiness, blockers, strain ?? null);
  const sessionNote = computeLongRunDriftNote(s, todayWorkouts[0]?.t ?? null);

  const postSessionLabel = derivePostSessionLabel(readiness, strain ?? null, signals.ctlNow);
  const ringLabel = postSessionLabel ?? readiness.label;
  if (postSessionLabel) signals.readinessLabel = postSessionLabel;

  return {
    stance,
    alertLevel,
    blockers,
    readiness,
    weekSignals,
    sleepInsight,
    signals,
    primaryMessage,
    sessionNote,
    ringLabel,
    workoutMod,
  };
}

/**
 * Returns "Recovery" / "Recovering" when low readiness is session-driven,
 * otherwise null (caller keeps the underlying readiness label).
 *
 * Handles two cases:
 *   1. Planned session completed → uses `strainCtx.strainPct` (actual vs plan)
 *   2. Adhoc / rest-day session  → uses `actualTSS / dailyCTL` (actual vs chronic)
 *      so a big kitesurf on an unplanned day still flips the label.
 *
 * Guarded against ACWR / legLoad hard floors — those mean the athlete *does*
 * need to manage load beyond the single session, so the warning label stays.
 */
export function derivePostSessionLabel(
  readiness: ReadinessResult,
  strainCtx: StrainContext | null,
  dailyCTL: number,
): 'Recovery' | 'Recovering' | null {
  if (!strainCtx) return null;
  if (readiness.hardFloor === 'acwr' || readiness.hardFloor === 'legLoad') return null;

  let pct = Math.round(strainCtx.strainPct);

  // Adhoc/rest-day path: no planned target, but an actual session landed.
  if (pct <= 0 && strainCtx.actualTSS > 0 && dailyCTL > 0) {
    pct = Math.round((strainCtx.actualTSS / dailyCTL) * 100);
  }

  if (pct >= 130) return 'Recovering';
  if (pct >= 100) return 'Recovery';
  return null;
}

/**
 * Pre-long-run drift nudge. Fires when today is a planned long run AND at least
 * 2 of the last 3 completed long runs drifted >8%. Returns null otherwise.
 *
 * Drift on long runs at steady pace is a reliable proxy for aerobic durability —
 * persistent high drift usually means fuelling/hydration or pace control broke down
 * in the back half. The nudge lets the athlete pre-empt a repeat.
 */
function computeLongRunDriftNote(s: SimulatorState, todayType: string | null): string | null {
  if (todayType !== 'long') return null;

  const weeksToScan = 6;
  const currentIdx = Math.max(0, (s.w ?? 1) - 1);
  const startIdx = Math.max(0, currentIdx - weeksToScan);
  const longRunDrifts: number[] = [];

  for (let i = startIdx; i <= currentIdx; i++) {
    const wk = (s.wks ?? [])[i];
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (actual.plannedType === 'long' && typeof actual.hrDrift === 'number' && !isNaN(actual.hrDrift)) {
        longRunDrifts.push(heatAdjust(actual.hrDrift, actual.ambientTempC));
      }
    }
  }

  const recent = longRunDrifts.slice(-3);
  if (recent.length < 2) return null;

  const highDrift = recent.filter(d => d > 8).length;
  if (highDrift < 2) return null;

  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgRounded = Math.round(avg);

  return `Recent long runs have drifted ${avgRounded}% on average. Consider earlier fuelling (every 25 min instead of 40) and holding back on the opening kilometres. Pace control in the first half protects the back end.`;
}

/**
 * Detects sustained HR drift on easy runs over the last 3 weeks. Returns a note
 * when ≥3 easy runs have drift data and the mean exceeds 5%. Signal: easy pace
 * is sitting too close to aerobic threshold — the athlete's "easy" isn't easy enough.
 *
 * Pure function — pass in SimulatorState, returns string | null for the UI.
 */
// ─── Durability flag (drift-based injury risk signal) ───────────────────────
//
// Strict matching: only `plannedType === 'easy'` or `'long'`. These are the
// only session types where cardiovascular drift is meaningfully "higher than
// expected" — drift on intervals or tempo is an artefact of the effort
// profile, not under-recovery.
//
// Heat-adjusted: every sample has ~0.15% per °C above 15°C subtracted before
// comparison. Hot days produce elevated drift even with a fully-recovered
// athlete, so unadjusted averages would over-fire the flag in summer.
//
// Personal baseline: once ≥ 5 samples exist per category across the last 16
// weeks, the flag compares the recent 4-week mean against the athlete's own
// rolling mean + 1 SD. Before that, it falls back to population thresholds:
//   - easy: > 5% (aerobic system should be coping easily)
//   - long: > 8% (moderate drift is normal on longer durations)
//
// Returns null unless ≥ 3 matching samples (easy) or ≥ 2 (long) exist in the
// recent window AND the average exceeds the personal or fallback threshold.

// Heat correction — literature-approximate 0.15%/°C rise in HR drift above
// 15°C neutral. Used across durability detection and coach commentary.
export function heatAdjust(drift: number, tempC: number | null | undefined): number {
  if (tempC == null) return drift;
  return drift - 0.15 * Math.max(0, tempC - 15);
}

export interface DriftBaseline {
  mean: number;
  sd: number;
  samples: number;
}

export function computeDriftBaselines(s: SimulatorState): {
  easy: DriftBaseline | null;
  long: DriftBaseline | null;
} {
  const weeksToScan = 16;
  const currentIdx = Math.max(0, (s.w ?? 1) - 1);
  const startIdx = Math.max(0, currentIdx - weeksToScan + 1);

  const easyAdj: number[] = [];
  const longAdj: number[] = [];

  for (let i = startIdx; i <= currentIdx; i++) {
    const wk = (s.wks ?? [])[i];
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (typeof actual.hrDrift !== 'number' || isNaN(actual.hrDrift)) continue;
      const adj = heatAdjust(actual.hrDrift, actual.ambientTempC);
      if (actual.plannedType === 'easy') easyAdj.push(adj);
      else if (actual.plannedType === 'long') longAdj.push(adj);
    }
  }

  const stats = (arr: number[]): DriftBaseline | null => {
    if (arr.length < 5) return null;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return { mean, sd: Math.sqrt(variance), samples: arr.length };
  };

  return { easy: stats(easyAdj), long: stats(longAdj) };
}

export interface DurabilityFlag {
  level: 'elevated' | 'high';
  headline: string;
  body: string;
  samples: number;
  avgDrift: number;
  category: 'easy' | 'long' | 'mixed';
}

export function detectDurabilityFlag(s: SimulatorState): DurabilityFlag | null {
  const weeksToScan = 4;
  const currentIdx = Math.max(0, (s.w ?? 1) - 1);
  const startIdx = Math.max(0, currentIdx - weeksToScan + 1);

  const easyAdj: number[] = [];
  const longAdj: number[] = [];

  for (let i = startIdx; i <= currentIdx; i++) {
    const wk = (s.wks ?? [])[i];
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      if (typeof actual.hrDrift !== 'number' || isNaN(actual.hrDrift)) continue;
      const adj = heatAdjust(actual.hrDrift, actual.ambientTempC);
      if (actual.plannedType === 'easy') easyAdj.push(adj);
      else if (actual.plannedType === 'long') longAdj.push(adj);
    }
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const easyAvg = easyAdj.length >= 3 ? avg(easyAdj) : null;
  const longAvg = longAdj.length >= 2 ? avg(longAdj) : null;

  const baselines = computeDriftBaselines(s);
  const easyThreshold = baselines.easy ? baselines.easy.mean + baselines.easy.sd : 5;
  const longThreshold = baselines.long ? baselines.long.mean + baselines.long.sd : 8;
  const basedOnSelf = baselines.easy != null || baselines.long != null;

  const easyElevated = easyAvg != null && easyAvg > easyThreshold;
  const longElevated = longAvg != null && longAvg > longThreshold;

  if (!easyElevated && !longElevated) return null;

  const bothElevated = easyElevated && longElevated;
  const headlineDrift = easyElevated && longElevated
    ? Math.round((easyAvg! + longAvg!) / 2)
    : easyElevated ? Math.round(easyAvg!) : Math.round(longAvg!);

  const category: DurabilityFlag['category'] = bothElevated ? 'mixed' : easyElevated ? 'easy' : 'long';
  const samples = easyAdj.length + longAdj.length;

  const easyExcess = easyElevated ? easyAvg! - easyThreshold : 0;
  const longExcess = longElevated ? longAvg! - longThreshold : 0;
  const maxExcess = Math.max(easyExcess, longExcess);
  const level: DurabilityFlag['level'] = maxExcess > 3 ? 'high' : 'elevated';

  const baselineClause = basedOnSelf
    ? 'relative to your personal rolling baseline'
    : 'against population thresholds (personal baseline needs more data)';

  let body: string;
  if (bothElevated) {
    body = `Easy runs average ${Math.round(easyAvg!)}% heat-adjusted drift and long runs average ${Math.round(longAvg!)}% across the last ${weeksToScan} weeks, elevated ${baselineClause}. Persistent decoupling on both types points to the aerobic system under-recovering. Consider a lighter week or easing off easy-run pace by 10–15 sec/km.`;
  } else if (easyElevated) {
    body = `Easy runs average ${Math.round(easyAvg!)}% heat-adjusted drift across the last ${weeksToScan} weeks, elevated ${baselineClause}. Easy pace may be sitting too close to aerobic threshold, preventing proper recovery between hard sessions. Ease off 10–15 sec/km.`;
  } else {
    body = `Long runs average ${Math.round(longAvg!)}% heat-adjusted drift across the last ${weeksToScan} weeks, elevated ${baselineClause}. Sustained decoupling on long efforts points to dehydration, under-fuelling, or a long-run pace that is too aggressive. Slow the opening kilometres and fuel earlier.`;
  }

  const headline = level === 'high'
    ? 'Aerobic strain flagged'
    : 'Aerobic strain building';

  void headlineDrift;

  return { level, headline, body, samples, avgDrift: headlineDrift, category };
}

// Week-debrief wrapper. Delegates to `detectDurabilityFlag` so the threshold
// logic lives in one place. Returns copy only when the easy-run signal is the
// sole trigger — mixed (easy + long) flags surface on the injury-risk page
// instead, to avoid duplicating the same narrative in two places.
export function detectEasyDriftPattern(s: SimulatorState): string | null {
  const flag = detectDurabilityFlag(s);
  if (!flag || flag.category !== 'easy') return null;
  return flag.body;
}

// ─── Primary Message Derivation ──────────────────────────────────────────────
//
// Single authoritative sentence that replaces readiness.sentence + HRV banner +
// adjust button copy. Priority chain: highest-priority signal wins, then the
// sentence is shaped by today's workout context (hard/easy/rest) and secondary
// modifiers (phase, CTL trend, week RPE, recent cross-training).

function derivePrimaryMessage(
  sig: CoachSignals,
  readiness: ReadinessResult,
  blockers: CoachBlocker[],
  strain: StrainContext | null,
): string {
  const wn = sig.todayWorkoutName || 'the session';
  const hard = strain?.todayIsHard ?? (sig.todayWorkoutType ? isHardType(sig.todayWorkoutType) : false);
  const restDay = strain?.isRestDay ?? false;
  const sp = strain?.strainPct ?? 0;
  const trained = strain?.trainedToday ?? false;

  // Was today's actual session heavy relative to chronic daily load?
  // CTL in signals is already ÷7 (daily equivalent). Compare raw TSS to that.
  const actualTSS = strain?.actualTSS ?? 0;
  const dailyCTL = sig.ctlNow > 0 ? sig.ctlNow : null;
  const sessionHeavy = trained && dailyCTL != null && actualTSS > dailyCTL * 1.2;

  // HRV delta
  const hrvPct = (sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0)
    ? Math.round((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline * 100)
    : null;

  // ── Tier 0: Hard blockers ───────────────────────────────────────────────
  if (blockers.includes('injury'))
    return 'Injury is active. Training is paused until cleared.';
  if (blockers.includes('illness'))
    return 'Illness flag is set. Rest until symptoms resolve.';

  // ── Tier 1: Session complete (strain-based) ─────────────────────────────
  // Round before comparing so the threshold matches the displayed percent.
  const spRounded = Math.round(sp);
  if (strain?.isRestDayOverreaching)
    return 'High load on a rest day. Recovery for upcoming sessions is impaired.';
  if (spRounded >= 130)
    return `Big session today (${Math.round(actualTSS)} TSS). Rest up and prioritise recovery for the next 24 hours.`;
  if (spRounded >= 100)
    return `Solid session today (${Math.round(actualTSS)} TSS). Rest up and recover.`;

  // ── Tier 2: Red flags ───────────────────────────────────────────────────
  // Hard-floor signals first — the message must explain whatever is capping
  // the readiness score, otherwise the badge ("Manage Load"), CTA, and copy
  // disagree across surfaces.
  if (readiness.hardFloor === 'legLoad' && readiness.legLoadNote) {
    return readiness.legLoadNote;
  }

  if (sig.acwrStatus === 'high') {
    if (trained)
      return sessionHeavy
        ? `Load spike (${sig.acwr}x). Heavy session compounds the risk. Rest tomorrow.`
        : `Load spike (${sig.acwr}x). Light session was the right call.`;
    return `Load spike (${sig.acwr}x). Reduce or skip today.`;
  }

  // Combined sleep + HRV suppression
  const poorSleep = sig.sleepLastNight != null && sig.sleepLastNight < 45;
  const deepHrvDrop = hrvPct != null && hrvPct < -20;
  if (poorSleep && deepHrvDrop) {
    if (trained)
      return sessionHeavy
        ? `Sleep ${sig.sleepLastNight}/100, HRV ${Math.abs(hrvPct!)}% down. Hard session on poor recovery blunts adaptation.`
        : `Sleep ${sig.sleepLastNight}/100, HRV ${Math.abs(hrvPct!)}% down. Light session was appropriate.`;
    return hard
      ? `Sleep ${sig.sleepLastNight}/100 and HRV ${Math.abs(hrvPct!)}% below baseline. Convert ${wn} to easy or rest.`
      : 'Sleep and HRV both suppressed. Rest or very easy movement today.';
  }
  if (poorSleep) {
    if (trained)
      return sessionHeavy
        ? `Sleep ${sig.sleepLastNight}/100. Hard session on poor sleep blunts the training stimulus.`
        : `Sleep ${sig.sleepLastNight}/100. Light session was appropriate.`;
    return hard
      ? `Sleep ${sig.sleepLastNight}/100 last night. Consider converting ${wn} to easy effort.`
      : 'Poor sleep last night. Rest or easy movement is appropriate.';
  }
  if (deepHrvDrop) {
    if (trained)
      return sessionHeavy
        ? `HRV ${Math.abs(hrvPct!)}% below baseline. Hard session on suppressed HRV produces lower adaptation.`
        : `HRV ${Math.abs(hrvPct!)}% below baseline. Light session was the right call.`;
    return hard
      ? `HRV ${Math.abs(hrvPct!)}% below baseline. Hard sessions on suppressed HRV produce lower adaptation.`
      : `HRV ${Math.abs(hrvPct!)}% below baseline. Keep effort low today.`;
  }

  // Heavy sleep debt leads the message whenever present. The recoveryFloor in
  // readiness.ts caps the score when sleep debt is heavy, so surfacing freshness
  // or other drivers here would misdiagnose the actual constraint.
  const heavySleepDebt = sig.sleepBankHours != null && sig.sleepBankHours < -5;
  if (heavySleepDebt) {
    const debtStr = fmtSleepDebt(sig.sleepDebtSec ?? 0);
    if (trained && sessionHeavy)
      return `${debtStr} sleep debt. Hard session won't produce full adaptation until sleep recovers.`;
    return hard
      ? `${debtStr} sleep debt this week. ${wn} won't produce full adaptation until sleep recovers.`
      : `${debtStr} sleep debt this week. Prioritise sleep tonight.`;
  }

  // Freshness-driven message when fitness is the biggest drag on readiness.
  // Gate on TSB being meaningfully negative — the fitness sub-score reads ~39
  // at neutral TSB due to the non-linear mapping, so `drivingSignal === 'fitness'`
  // can fire at TSB ≈ 0 where freshness is fine. Requiring tsb <= -5 keeps copy
  // truthful against the Freshness drill-down.
  if (readiness.drivingSignal === 'fitness' && sig.readinessScore < 75 && sig.tsb <= -5) {
    const fatigueLevel = sig.tsb <= -15 ? 'Fatigue is high' : sig.tsb <= -8 ? 'Fatigue is building' : 'Freshness is below normal';
    if (trained)
      return sessionHeavy
        ? `${fatigueLevel}. Heavy session adds to accumulated load.`
        : `${fatigueLevel}. Light session was the right call.`;
    return hard
      ? `${fatigueLevel}. Monitor effort on ${wn}. Back off if RPE feels high.`
      : `${fatigueLevel}. Easy effort is appropriate today.`;
  }

  // ── Tier 3: Amber signals ──────────────────────────────────────────────
  if (sig.acwrStatus === 'caution') {
    if (trained)
      return sessionHeavy
        ? `Training load spiking (${sig.acwr}x). Heavy session adds to the spike. Ease off tomorrow.`
        : `Training load spiking (${sig.acwr}x). Light session today was the right call.`;
    return hard
      ? `Training load spiking (${sig.acwr}x). Keep ${wn} controlled.`
      : `Training load spiking (${sig.acwr}x). Easy session is well placed today.`;
  }

  const modSleep = sig.sleepLastNight != null && sig.sleepLastNight < 60;
  const modHrvDrop = hrvPct != null && hrvPct < -12;

  if (modSleep && modHrvDrop) {
    if (trained)
      return sessionHeavy
        ? `Sleep ${sig.sleepLastNight}/100, HRV ${Math.abs(hrvPct!)}% down. Heavy session on below-par recovery. Prioritise sleep tonight.`
        : `Sleep ${sig.sleepLastNight}/100, HRV ${Math.abs(hrvPct!)}% down. Light session was appropriate. Prioritise sleep tonight.`;
    return hard
      ? `Sleep ${sig.sleepLastNight}/100 and HRV ${Math.abs(hrvPct!)}% below average. Back off ${wn} if effort feels high.`
      : 'Sleep and HRV below baseline. Keep today easy. Prioritise sleep tonight.';
  }
  if (modSleep) {
    if (trained)
      return sessionHeavy
        ? `Sleep ${sig.sleepLastNight}/100. Heavy session on below-par sleep. Back off if fatigued tomorrow.`
        : `Sleep ${sig.sleepLastNight}/100. Light session was appropriate.`;
    return hard
      ? `Sleep ${sig.sleepLastNight}/100. Monitor effort on ${wn}. Back off if RPE feels high.`
      : 'Sleep below par. Easy effort is appropriate today.';
  }
  if (modHrvDrop) {
    if (trained)
      return sessionHeavy
        ? `HRV ${Math.abs(hrvPct!)}% below average. Heavy session on suppressed HRV. Monitor recovery tomorrow.`
        : `HRV ${Math.abs(hrvPct!)}% below average. Light session was the right call.`;
    return hard
      ? `HRV ${Math.abs(hrvPct!)}% below 7-day average. Monitor effort on ${wn}.`
      : `HRV ${Math.abs(hrvPct!)}% below 7-day average. Keep effort easy today.`;
  }

  // Moderate sleep debt
  if (sig.sleepBankHours != null && sig.sleepBankHours < -3) {
    const debtStr = fmtSleepDebt(sig.sleepDebtSec ?? 0);
    if (trained)
      return sessionHeavy
        ? `Sleep debt accumulating (${debtStr}). Heavy session adds load. Prioritise sleep.`
        : `Sleep debt accumulating (${debtStr}). Light session today. Prioritise sleep.`;
    return hard
      ? `${debtStr} sleep debt this week. Complete ${wn} but don't add extras.`
      : `Sleep debt accumulating (${debtStr}). Prioritise earlier bedtime.`;
  }

  // Recovery driving (below baseline, 65 = baseline) but no specific sleep/HRV flag
  if (readiness.drivingSignal === 'recovery' && readiness.recoveryScore != null && readiness.recoveryScore < 65) {
    if (trained)
      return sessionHeavy
        ? 'Recovery below baseline. Heavy session on incomplete recovery. Rest tomorrow.'
        : 'Recovery below baseline. Light session was appropriate.';
    return hard
      ? `Recovery below baseline. ${wn} as planned, but back off if RPE feels high.`
      : 'Recovery below baseline. Keep today easy.';
  }

  // Recent cross-training adding residual fatigue
  if (strain?.recentCrossTraining && strain.recentCrossTraining.tss > 25) {
    const ct = strain.recentCrossTraining;
    if (trained)
      return sessionHeavy
        ? `${ct.label} added ${ct.tss} TSS in the last 48h. Heavy session adds to residual fatigue.`
        : `${ct.label} added ${ct.tss} TSS recently. Light session today aids recovery.`;
    return hard
      ? `${ct.label} added ${ct.tss} TSS in the last 48h. Factor residual fatigue into ${wn}.`
      : `${ct.label} added ${ct.tss} TSS recently. Easy session aids recovery.`;
  }

  // ── Tier 4: Session logged, partial strain ──────────────────────────────
  if (trained && sp > 0 && sp < 100) {
    if (sp >= 80)
      return 'Nearly at today\'s target. Finish the session as planned.';
    return 'Session in progress. On track for today\'s load target.';
  }

  // ── Tier 4b: Low score catch-all ──────────────────────────────────────
  // If no specific signal fired above but the composite score is genuinely low,
  // name the actual sub-signals dragging the score down.
  if (sig.readinessScore < 55) {
    const weak: string[] = [];
    if (readiness.fitnessScore < 50) weak.push('freshness is low');
    if (readiness.safetyScore < 60) weak.push('training load is elevated');
    if (readiness.recoveryScore != null && readiness.recoveryScore < 60) weak.push('recovery is below baseline');
    const reason = weak.length > 0
      ? weak.join(weak.length === 2 ? ' and ' : ', ') + '.'
      : 'overall readiness is low.';
    const cap = reason.charAt(0).toUpperCase() + reason.slice(1);

    if (trained) {
      return sessionHeavy
        ? `${cap} Heavy session on low readiness. Rest tomorrow.`
        : `${cap} Light session was the right call.`;
    }
    if (sig.readinessScore < 40) {
      return restDay
        ? `${cap} Rest day is appropriate.`
        : hard
          ? `${cap} Consider converting ${wn} to easy effort.`
          : `${cap} Keep effort very easy today.`;
    }
    return hard
      ? `${cap} Monitor effort on ${wn}. Back off if RPE is high.`
      : restDay
        ? `${cap} Rest is appropriate.`
        : `${cap} Keep today easy.`;
  }

  // ── Tier 5: Positive / go conditions ────────────────────────────────────
  const fresh = sig.tsbZone === 'Fresh';
  const safe = sig.acwrStatus === 'safe';
  const goodRecovery = readiness.recoveryScore != null && readiness.recoveryScore >= 70;
  const hrvElevated = hrvPct != null && hrvPct > 12;
  const phase = sig.phase;

  // Taper phase — only when readiness is reasonable (score ≥ 50).
  if ((phase === 'taper' || phase === 'race') && sig.readinessScore >= 50) {
    if (trained)
      return 'Taper week. Session done. Fatigue is clearing while fitness remains.';
    if (hard)
      return `Taper week. Maintain intensity on ${wn}. Volume is reduced by design.`;
    if (restDay)
      return 'Taper week. Rest day. Fatigue is clearing while fitness remains.';
    return 'Taper week. Keep easy runs short. Freshness is the priority.';
  }

  // HRV elevated
  if (hrvElevated) {
    if (trained)
      return `HRV ${hrvPct}% above baseline. Strong recovery. Good session today.`;
    if (hard)
      return `HRV ${hrvPct}% above baseline. Strong recovery. Good conditions for ${wn}.`;
    return `HRV ${hrvPct}% above baseline. Physiological recovery is strong.`;
  }

  // Fresh + safe + good recovery
  if (fresh && safe && goodRecovery) {
    if (trained)
      return 'Well recovered. Good session today.';
    if (hard)
      return `Well recovered. Full session. Good conditions for ${wn}.`;
    if (restDay)
      return 'Fresh and well recovered. Rest day as planned.';
    return 'Well recovered. Easy effort today builds aerobic base.';
  }

  // Fresh + safe, no recovery data
  if (fresh && safe && !readiness.hasRecovery) {
    if (trained)
      return 'Freshness and load are good. Good session today.';
    if (hard)
      return `Freshness and load are good. ${wn} as planned.`;
    if (restDay)
      return 'Freshness is high. Rest day.';
    return 'Freshness and load are good. Session as planned.';
  }

  // Fresh + safe but recovery data is middling (not flagged, not great)
  if (fresh && safe) {
    if (trained)
      return 'Rested with safe training load. Good session today.';
    if (hard)
      return `Rested with safe training load. ${wn} as planned.`;
    return 'Rested with safe training load. Session as planned.';
  }

  // Recovering TSB
  if (sig.tsbZone === 'Recovering' && safe) {
    if (sig.ctlTrend === 'up') {
      if (trained)
        return 'Fitness is building. Good session today.';
      return hard
        ? `Fitness is building. Stick to ${wn} as planned.`
        : 'Fitness is building. Easy session maintains momentum.';
    }
    if (sig.ctlTrend === 'down') {
      if (trained)
        return 'Fitness has dipped recently. Good to stay consistent.';
      return hard
        ? `Fitness has dipped over recent weeks. ${wn} helps reverse that. Consistency is the priority.`
        : 'Fitness has dipped recently. Consistency is the priority.';
    }
    if (trained)
      return 'Good balance of load and recovery. Good session today.';
    return hard
      ? `Good balance of load and recovery. ${wn} as planned.`
      : 'Good balance of load and recovery. Session as planned.';
  }

  // Fatigued TSB but safe ACWR (adapted load)
  if (sig.tsbZone === 'Fatigued' && safe) {
    if (trained)
      return sessionHeavy
        ? 'Accumulated fatigue. Heavy session adds to it. Rest tomorrow.'
        : 'Accumulated fatigue. Light session today allows recovery.';
    return hard
      ? `Accumulated fatigue is present but load is safe. Keep ${wn} controlled.`
      : 'Accumulated fatigue. Easy effort today allows recovery.';
  }

  // Overtrained TSB + safe ACWR
  if (sig.tsbZone === 'Overtrained' && safe) {
    if (trained)
      return sessionHeavy
        ? 'Deep fatigue. Heavy session is risky here. Rest tomorrow.'
        : 'Deep fatigue. Light session was the right call.';
    return restDay
      ? 'Deep fatigue. Rest day is appropriate.'
      : 'Deep fatigue but load is controlled. Easy effort only.';
  }

  // ── Tier 6: Week context modifier ──────────────────────────────────────
  if (sig.weekRPE === 'hard') {
    if (trained)
      return sessionHeavy
        ? 'Hard week. Heavy session adds to accumulated load. Ease off tomorrow.'
        : 'Hard week. Light session today was the right call.';
    if (hard)
      return `The week has been hard. Monitor effort on ${wn}. Back off if fatigued.`;
  }

  // ── Trained fallback (no specific signal fired) ─────────────────────────
  if (trained)
    return 'Session logged. Rest for the remainder of the day.';

  // ── Fallback: readiness matrix sentence ─────────────────────────────────
  return readiness.sentence;
}

/** Matches isHardWorkout from scheduler — duplicated here to avoid circular import. */
const HARD_TYPES = ['threshold', 'tempo', 'vo2max', 'intervals', 'long', 'mp', 'race', 'time_trial', 'progression', 'marathon_pace', 'steady', 'float'];
function isHardType(t: string): boolean {
  return HARD_TYPES.includes(t);
}

// ─── LLM payload builder ────────────────────────────────────────────────────
//
// Flat, ≤ ~18 fields, strings kept short. Fed into the coach-narrative edge
// function. Kept here (not in the view) so the schema is one place and the
// edge function's signal-hash skip produces stable hashes for unchanged state.

export interface CoachNarrativePayload {
  stance: CoachStance;
  readinessScore: number;
  readinessLabel: string;
  freshness: number;              // TSB daily-equivalent
  loadSafety: number;             // ACWR ratio
  sleepLastNight: number | null;
  sleep7dAvg: number | null;
  sleepBankHours: number | null;
  hrvMs: number | null;
  hrvPctVsBaseline: number | null;
  weekTss: number | null;
  weekTssPlan: number | null;
  weekTssPct: number | null;
  injury: { bodyPart: string; severity: string } | null;
  illness: { severity: string } | null;
  todayFeeling: 'struggling' | 'ok' | 'good' | 'great' | null;
  todayWorkout: {
    title: string;
    description: string;
    plannedTss: number | null;
    plannedDurationMin: number | null;
  } | null;
  phase: string;
  primaryMessageFallback: string;
}

export function buildCoachSignalsPayload(coach: CoachState): CoachNarrativePayload {
  const sig = coach.signals;

  const hrvPct = (sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0)
    ? Math.round(((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline) * 100)
    : null;

  const weekTssPct = (sig.weekTSS != null && sig.plannedTSS != null && sig.plannedTSS > 0)
    ? Math.round((sig.weekTSS / sig.plannedTSS) * 100)
    : null;

  const injury = sig.injuryActive
    ? {
        bodyPart: (sig.injuryLocation ?? 'unspecified').slice(0, 40),
        severity: 'active',
      }
    : null;

  const illness = sig.illnessActive
    ? { severity: (sig.illnessSeverity === 'resting' ? 'resting' : 'light') as 'resting' | 'light' }
    : null;

  const todayWorkout = (sig.todayWorkoutName && sig.todayWorkoutType)
    ? {
        title: sig.todayWorkoutName.slice(0, 60),
        description: (sig.todayWorkoutDescription ?? '').slice(0, 90),
        plannedTss: sig.todayPlannedTSS,
        plannedDurationMin: sig.todayPlannedDurationMin,
      }
    : null;

  return {
    stance: coach.stance,
    readinessScore: sig.readinessScore,
    readinessLabel: sig.readinessLabel,
    freshness: sig.tsb,
    loadSafety: sig.acwr,
    sleepLastNight: sig.sleepLastNight,
    sleep7dAvg: sig.sleepAvg7d,
    sleepBankHours: sig.sleepBankHours,
    hrvMs: sig.hrv,
    hrvPctVsBaseline: hrvPct,
    weekTss: sig.weekTSS,
    weekTssPlan: sig.plannedTSS,
    weekTssPct,
    injury,
    illness,
    todayFeeling: sig.todayFeeling,
    todayWorkout,
    phase: sig.phase,
    primaryMessageFallback: coach.primaryMessage.slice(0, 280),
  };
}
