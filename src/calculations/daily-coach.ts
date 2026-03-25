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
} from '@/calculations/fitness-model';
import { computeReadiness, type ReadinessResult } from '@/calculations/readiness';
import { computeWeekSignals, type WeekSignals } from '@/calculations/coach-insight';
import { getSleepInsight, getSleepBank } from '@/calculations/sleep-insights';

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

  // Plan context
  weekNumber: number;
  totalWeeks: number;
  phase: string;
  todayWorkoutName: string | null;
  todayWorkoutType: string | null;
}

export interface CoachState {
  stance: CoachStance;
  alertLevel: CoachAlertLevel;
  blockers: CoachBlocker[];
  readiness: ReadinessResult;
  weekSignals: WeekSignals;
  sleepInsight: string | null;
  signals: CoachSignals;
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function computeDailyCoach(s: SimulatorState): CoachState {
  const wks = s.wks ?? [];
  const currentWeekIdx = s.w - 1;
  const wk = wks[currentWeekIdx];
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const physio = s.physiologyHistory ?? [];

  // ── Fitness metrics ───────────────────────────────────────────────────────
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(wks, s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const sameSignal = computeSameSignalTSB(wks, s.w, s.ctlBaseline ?? undefined, s.planStartDate);
  const tsb = sameSignal?.tsb ?? 0;
  const ctlNow = sameSignal?.ctl ?? 0;

  const metrics = computeFitnessModel(wks, s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const ctlFourWeeksAgo = metrics[metrics.length - 5]?.ctl ?? ctlNow;
  const ctlDelta = ctlNow - ctlFourWeeksAgo;
  const ctlTrend: 'up' | 'flat' | 'down' = ctlDelta > 0.5 ? 'up' : ctlDelta < -0.5 ? 'down' : 'flat';

  // ── Recovery metrics ──────────────────────────────────────────────────────
  const latestPhysio = physio.slice(-1)[0] ?? null;
  const sleepScore: number | null = latestPhysio?.sleepScore ?? null;
  const hrvRmssd: number | null = latestPhysio?.hrvRmssd ?? null;
  const hrvAll = physio.map(p => p.hrvRmssd).filter((v): v is number => v != null);
  const hrvPersonalAvg: number | null = hrvAll.length >= 3
    ? Math.round(hrvAll.reduce((a, b) => a + b, 0) / hrvAll.length)
    : null;

  const sleepScores7 = physio.slice(-7).map(p => p.sleepScore).filter((v): v is number => v != null);
  const sleepAvg7d = sleepScores7.length >= 2
    ? Math.round(sleepScores7.reduce((a, b) => a + b, 0) / sleepScores7.length)
    : null;

  const sleepBank = getSleepBank(physio);
  const sleepBankHours = sleepBank.nightsWithData >= 3
    ? Math.round((sleepBank.bankSec / 3600) * 10) / 10
    : null;

  // ── Readiness ─────────────────────────────────────────────────────────────
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
  const weekSignals = computeWeekSignals(
    wk?.effortScore ?? trailingEffort ?? null,
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
  } else if (readiness.label === 'Ready to Push') {
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
    hrv: hrvRmssd,
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

    weekNumber: s.w,
    totalWeeks: s.tw,
    phase: wk?.ph ?? 'base',
    todayWorkoutName: todayWorkouts[0]?.n ?? null,
    todayWorkoutType: todayWorkouts[0]?.t ?? null,
  };

  return {
    stance,
    alertLevel,
    blockers,
    readiness,
    weekSignals,
    sleepInsight,
    signals,
  };
}
