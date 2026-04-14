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
  computeACWR,
  computeSameSignalTSB,
  computeFitnessModel,
  computeWeekTSS,
  computePlannedWeekTSS,
  getTrailingEffortScore,
  computeTodaySignalBTSS,
  computePlannedDaySignalBTSS,
  REST_DAY_OVERREACH_RATIO,
} from '@/calculations/fitness-model';
import { computeReadiness, computeRecoveryScore, type ReadinessResult } from '@/calculations/readiness';
import { computeWeekSignals, type WeekSignals } from '@/calculations/coach-insight';
import { getSleepInsight, getSleepBank, deriveSleepTarget, computeSleepDebt, buildDailySignalBTSS } from '@/calculations/sleep-insights';
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
  sleepBankHours: number | null;   // negative = deficit

  // Week signals
  weekTSS: number | null;
  plannedTSS: number | null;
  weekRPE: 'hard' | 'on-target' | 'easy' | null;
  hrDrift: 'efficient' | 'moderate' | 'stressed' | null;
  fitnessTrend: 'up' | 'flat' | 'down' | null;

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
}

// ─── Strain context auto-derivation ─────────────────────────────────────────
// When no StrainContext is passed (e.g. from coach-modal), derive it from state.

function deriveStrainContext(s: SimulatorState): StrainContext {
  const wk = (s.wks ?? [])[s.w - 1];
  if (!wk) return { strainPct: 0, isRestDay: true, isRestDayOverreaching: false, trainedToday: false, todayIsHard: false, recentCrossTraining: null, actualTSS: 0 };

  const today = new Date().toISOString().split('T')[0];
  const todayDayOfWeek = (new Date(today + 'T12:00:00').getDay() + 6) % 7;
  const todayTSS = computeTodaySignalBTSS(wk, today);

  const plannedWorkouts = generateWeekWorkouts(
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

  return {
    strainPct,
    isRestDay,
    isRestDayOverreaching,
    trainedToday: todayTSS > 0,
    todayIsHard,
    recentCrossTraining: null,
    actualTSS: todayTSS,
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function computeDailyCoach(s: SimulatorState, strain?: StrainContext): CoachState {
  // Auto-derive strain context when not provided (e.g. from coach-modal)
  if (!strain) strain = deriveStrainContext(s);

  const wks = s.wks ?? [];
  const currentWeekIdx = s.w - 1;
  const wk = wks[currentWeekIdx];
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const physio = s.physiologyHistory ?? [];

  // ── Fitness metrics ───────────────────────────────────────────────────────
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(wks, s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, s.signalBBaseline ?? undefined);
  const sameSignal = computeSameSignalTSB(wks, s.w, s.signalBBaseline ?? s.ctlBaseline ?? 0, s.planStartDate);
  const tsb = sameSignal?.tsb ?? 0;
  const ctlNow = sameSignal?.ctl ?? 0;

  const metrics = computeFitnessModel(wks, s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
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
  const dailyTSSByDate = buildDailySignalBTSS(wks);
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
  const weekTSS = wk
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

  const actuals = Object.values(wk?.garminActuals ?? {});
  const hrDriftVals = actuals
    .map(a => a.hrDrift)
    .filter((v): v is number => typeof v === 'number' && !isNaN(v));
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
  const today = new Date();
  const dayOfWeek = (today.getDay() + 6) % 7; // Mon=0, Sun=6
  const todayWorkouts = wk ? [] as Array<{ n: string; t: string }> : [];
  if (wk) {
    const allWorkouts = (s as any)._cachedWorkouts?.[s.w] ?? null;
    if (allWorkouts) {
      const tw = allWorkouts.filter((w: any) => w.dayOfWeek === dayOfWeek);
      tw.forEach((w: any) => todayWorkouts.push({ n: w.n, t: w.t }));
    }
  }

  // ── Derive stance ─────────────────────────────────────────────────────────
  const blockers: CoachBlocker[] = [];

  if (injuryActive) blockers.push('injury');
  if (illnessActive) blockers.push('illness');
  if (acwr.status === 'high') blockers.push('overload');
  if (sleepScore != null && sleepScore < 55) blockers.push('sleep');
  else if (sleepBankHours != null && sleepBankHours < -5) blockers.push('sleep');

  let stance: CoachStance;
  if (blockers.includes('injury') || blockers.includes('illness')) {
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

  const alertLevel: CoachAlertLevel =
    blockers.length > 0 ? 'warning' :
    readiness.label === 'Manage Load' ? 'caution' :
    'ok';

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

    weekTSS: weekTSS != null ? Math.round(weekTSS) : null,
    plannedTSS: Math.round(plannedTSS),
    weekRPE: weekSignals.rpe,
    hrDrift: weekSignals.hrDrift,
    fitnessTrend: weekSignals.fitness,

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
  };

  const primaryMessage = derivePrimaryMessage(signals, readiness, blockers, strain ?? null);

  return {
    stance,
    alertLevel,
    blockers,
    readiness,
    weekSignals,
    sleepInsight,
    signals,
    primaryMessage,
  };
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
  if (strain?.isRestDayOverreaching)
    return 'High load on a rest day. Recovery for upcoming sessions is impaired.';
  if (sp >= 130)
    return 'Daily load well exceeded target. Additional training raises injury risk.';
  if (sp >= 100)
    return 'Daily load target reached. Training is complete for today.';

  // ── Tier 2: Red flags ───────────────────────────────────────────────────
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

  // Heavy sleep debt — only lead with this when recovery is the driving signal.
  // When freshness or load safety is worse, defer to Tier 3 where it becomes secondary context.
  const heavySleepDebt = sig.sleepBankHours != null && sig.sleepBankHours < -5;
  if (heavySleepDebt && readiness.drivingSignal === 'recovery') {
    if (trained)
      return sessionHeavy
        ? `${Math.abs(sig.sleepBankHours!)}h sleep debt. Hard session won't produce full adaptation until sleep recovers.`
        : `${Math.abs(sig.sleepBankHours!)}h sleep debt. Light session today, prioritise sleep tonight.`;
    return hard
      ? `${Math.abs(sig.sleepBankHours!)}h sleep debt this week. ${wn} won't produce full adaptation until sleep recovers.`
      : `${Math.abs(sig.sleepBankHours!)}h sleep debt this week. Prioritise sleep.`;
  }

  // Freshness-driven message when fitness is the biggest drag on readiness.
  // Gate on readiness not being Primed (< 75) — aligns with the label bands.
  if (readiness.drivingSignal === 'fitness' && sig.readinessScore < 75) {
    const debtSuffix = heavySleepDebt ? ` ${Math.abs(sig.sleepBankHours!)}h sleep debt compounds recovery.` : '';
    const fatigueLevel = sig.tsb <= -15 ? 'Fatigue is high' : sig.tsb <= -8 ? 'Fatigue is building' : 'Freshness is below normal';
    if (trained)
      return sessionHeavy
        ? `${fatigueLevel}. Heavy session adds to accumulated load.${debtSuffix}`
        : `${fatigueLevel}. Light session was the right call.${debtSuffix}`;
    return hard
      ? `${fatigueLevel}. Monitor effort on ${wn}. Back off if RPE feels high.${debtSuffix}`
      : `${fatigueLevel}. Easy effort is appropriate today.${debtSuffix}`;
  }

  // Heavy sleep debt — fitness isn't the driver but sleep debt is significant
  if (heavySleepDebt) {
    if (trained)
      return sessionHeavy
        ? `${Math.abs(sig.sleepBankHours!)}h sleep debt. Hard session won't produce full adaptation until sleep recovers.`
        : `${Math.abs(sig.sleepBankHours!)}h sleep debt. Light session today, prioritise sleep tonight.`;
    return hard
      ? `${Math.abs(sig.sleepBankHours!)}h sleep debt this week. ${wn} won't produce full adaptation until sleep recovers.`
      : `${Math.abs(sig.sleepBankHours!)}h sleep debt this week. Prioritise sleep.`;
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
    if (trained)
      return sessionHeavy
        ? `Sleep debt accumulating (${Math.abs(sig.sleepBankHours)}h). Heavy session adds load. Prioritise sleep.`
        : `Sleep debt accumulating (${Math.abs(sig.sleepBankHours)}h). Light session today. Prioritise sleep.`;
    return hard
      ? `${Math.abs(sig.sleepBankHours)}h sleep debt this week. Complete ${wn} but don't add extras.`
      : `Sleep debt accumulating (${Math.abs(sig.sleepBankHours)}h). Prioritise earlier bedtime.`;
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
