/**
 * daily-coach.ts
 * ==============
 * Central coaching aggregator. Takes full SimulatorState and returns a
 * structured CoachState with stance, blockers, and all signals needed
 * to render the Coach modal and call the LLM narrative edge function.
 *
 * Pure function. No side effects, no network calls.
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
  REST_DAY_OVERREACH_RATIO,
} from '@/calculations/fitness-model';
import { computeReadiness, computeRecoveryScore, type ReadinessResult } from '@/calculations/readiness';
import { isImpactBlockedByInjury } from '@/injury/engine';
import { heatStrainRatioForState } from '@/calculations/body-mass-adaptations';
import { computeWeekSignals, type WeekSignals } from '@/calculations/coach-insight';
import { getSleepInsight, getSleepBank, deriveSleepTarget, computeSleepDebt, fmtSleepDebt, buildDailySignalBTSS } from '@/calculations/sleep-insights';
import { getPlannedDayTSSContext } from '@/ui/planned-day-tss';
import { computeCapacityStrain, postSessionSentence, injuryCapOvershootSentence } from './capacity-strain';
import {
  computeRhrDeltaFromHistory, detectRaceCollision, getRaceDateISO,
  resolveEffectiveEntry,
} from './illness-rules';

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
  /**
   * Today's TSS as % of the capacity anchor (max(planned, CTL/7)) — the
   * canonical `computeCapacityStrain(s).pctCapacity`. This is what feeds the
   * readiness strain floor; `strainPct` (plan-relative) stays for copy tiers.
   */
  capacityStrainPct?: number;
  /** True when no planned workout AND no matched activity today. */
  isRestDay: boolean;
  /** Rest day but load > 33% of chronic daily TSS. */
  isRestDayOverreaching: boolean;
  /** Any activity logged today (garminActuals or adhoc). */
  trainedToday: boolean;
  /** Today's planned workout is a quality/hard session. */
  todayIsHard: boolean;
  /** First hard session in the next 1-2 days (excluding today). Null when nothing hard is upcoming.
   *  Day labels are 'tomorrow' / 'the day after' so copy reads naturally without absolute weekday. */
  upcomingHard: { whenLabel: string; type: string } | null;
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
   * UI ring label. Always the underlying `readiness.label`. The post-session
   * wording lives in the sentence below the ring (see `postSessionSentence`),
   * since the ring is too narrow for long copy.
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
 * Expires at end of day. Stale feelings from yesterday don't leak into today's
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
  if (!wk) return { strainPct: 0, isRestDay: true, isRestDayOverreaching: false, trainedToday: false, todayIsHard: false, upcomingHard: null, recentCrossTraining: null, actualTSS: 0 };

  const today = new Date().toISOString().split('T')[0];
  const todayDayOfWeek = (new Date(today + 'T12:00:00').getDay() + 6) % 7;
  const todayTSS = computeTodaySignalBTSS(wk, today);

  // Canonical mode-aware planned TSS (src/ui/planned-day-tss.ts): reads the
  // real plan per mode (running resolver / tri-cycling-HYROX stored weeks).
  // Just-Track returns zeros (no plan): plannedDayTSS stays 0,
  // hasPlannedWorkout=false, which lets isRestDay / matchedActivityToday drive
  // the ring label off real actuals.
  const plannedCtx = getPlannedDayTSSContext(s, s.w);
  const plannedDayTSS = plannedCtx.plannedTSSForDay(todayDayOfWeek);
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
  // Per-session average: planned week TSS / training day count (tracks plan intent, not CTL history)
  const perSessionAvg = plannedCtx.perSessionAvg;
  const isRestDayOverreaching = isRestDay && todayTSS > 0 && perSessionAvg > 0 && todayTSS > perSessionAvg * REST_DAY_OVERREACH_RATIO;

  const strainPct = hasPlannedWorkout && todayTSS > 0 && plannedDayTSS > 0
    ? (todayTSS / plannedDayTSS) * 100 : 0;

  const todayPlanned = plannedCtx.workoutsForDay(todayDayOfWeek)
    .find(w => w.status !== 'skip' && w.status !== 'replaced');
  const todayIsHard = todayPlanned?.isHard ?? false;

  // Expose the planned workout shape so Brain/LLM can prescribe concrete action.
  let todayPlannedWorkout: StrainContext['todayPlannedWorkout'] = null;
  if (todayPlanned) {
    todayPlannedWorkout = {
      name: todayPlanned.name,
      type: todayPlanned.type,
      description: todayPlanned.description,
      plannedTSS: todayPlanned.plannedTSS > 0 ? todayPlanned.plannedTSS : null,
      plannedDurationMin: todayPlanned.plannedDurationMin > 0 ? todayPlanned.plannedDurationMin : null,
    };
  }

  // Look ahead 1-2 days for the next quality/hard session. Used by primary-message
  // copy so prescriptive advice ("ease into…", "back off") names what's coming
  // rather than firing generically on rest days.
  let upcomingHard: StrainContext['upcomingHard'] = null;
  for (let offset = 1; offset <= 2; offset++) {
    const targetDow = (todayDayOfWeek + offset) % 7;
    if (targetDow < todayDayOfWeek) break; // wraps to next week. The context only covers this week
    const hit = plannedCtx.workoutsForDay(targetDow)
      .find(w => w.status !== 'skip' && w.status !== 'replaced' && w.isHard);
    if (hit) {
      upcomingHard = { whenLabel: offset === 1 ? 'tomorrow' : 'the day after', type: hit.type };
      break;
    }
  }

  return {
    strainPct,
    // Canonical capacity-anchored percent — what the readiness strain floor
    // reads. Keeps the coach's internal readiness consistent with the Home
    // card and the Readiness detail page (same computeCapacityStrain source).
    capacityStrainPct: computeCapacityStrain(s).pctCapacity,
    isRestDay,
    isRestDayOverreaching,
    trainedToday: todayTSS > 0,
    todayIsHard,
    upcomingHard,
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
  // Live TSB with intra-week decay through today (shared helper. Matches all readiness surfaces).
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
    impactBlocked: isImpactBlockedByInjury(s.injuryState),
    precomputedRecoveryScore: recoveryResult.hasData ? recoveryResult.score : null,
    // Capacity-anchored percent (canonical computeCapacityStrain) feeds the
    // strain floor; the plan-relative strainPct stays for sentence tiers.
    strainPct: strain?.trainedToday ? (strain.capacityStrainPct ?? strain.strainPct) : null,
    acwrSafeUpper: acwr.safeUpper,
    hasUpcomingHardSession: strain?.upcomingHard != null || (strain?.todayIsHard ?? false),
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
    .map(a => typeof a.hrDrift === 'number' && !isNaN(a.hrDrift) ? heatAdjust(a.hrDrift, a.ambientTempC, heatStrainRatioForState(s)) : null)
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
  // Today's effective capacity = max(schedule capacity, user override). Used to
  // derive coach stance: 'rest' → full rest, 'easy_only' / 'reduced' → reduce.
  // Legacy severity is the fallback for pre-v2 state.
  const illnessSeverity: 'light' | 'resting' | null = (() => {
    const illness = s.illnessState;
    if (!illness?.active) return null;
    if (illness.schedule && illness.schedule.length > 0) {
      const todayMs = new Date(new Date().toISOString().split('T')[0] + 'T12:00:00').getTime();
      const startMs = new Date(illness.startDate + 'T12:00:00').getTime();
      const offset = Math.round((todayMs - startMs) / 86400000);
      const scheduleEntry = illness.schedule.find(e => e.dateOffsetDays === offset) ?? null;
      const entry = resolveEffectiveEntry(scheduleEntry, illness.userCapacityOverride);
      if (!entry || entry.capacity === 'full') return null;
      return entry.capacity === 'rest' ? 'resting' : 'light';
    }
    return illness.severity ?? null;
  })();

  // ── Today's workout ───────────────────────────────────────────────────────
  // Sourced from the strain-context lookup (mode-aware planned-day-tss context).
  // Previous `_cachedWorkouts` path never populated, so today's workout was missing
  // from signals sent to the LLM. Restored here via StrainContext.todayPlannedWorkout.
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
    // Stance depends on whether the injury actually blocks all training.
    // - acute phase → always 'rest' (clinical 72h+ window)
    // - no gates set → 'rest' (conservative legacy default; preserves
    //   behaviour for injuries created before the discipline-gate system)
    // - any explicit gate allows training → 'reduce' (partial restriction)
    // - every relevant gate says 'no' → 'rest'
    const inj = s.injuryState;
    const eventType: 'running' | 'triathlon' | 'hyrox' = (s as any).eventType || 'running';
    const isCyclingOnly = !!((s as any).onboarding?.trainingMode === 'cycling');
    const anyGateSet = !!(inj && (
      inj.canBike !== undefined || inj.canSwim !== undefined
      || inj.canUpperLoad !== undefined || inj.canLowerLoad !== undefined
    ));
    if (inj?.injuryPhase === 'acute') {
      stance = 'rest';
    } else if (!anyGateSet) {
      stance = 'rest';
    } else {
      const allows = (g: 'yes' | 'limited' | 'no' | undefined) => g === 'yes' || g === 'limited';
      let anyDisciplineAllowed = false;
      if (isCyclingOnly) {
        anyDisciplineAllowed = allows(inj?.canBike);
      } else if (eventType === 'triathlon') {
        anyDisciplineAllowed = allows(inj?.canRun) || allows(inj?.canBike) || allows(inj?.canSwim);
      } else if (eventType === 'hyrox') {
        anyDisciplineAllowed = allows(inj?.canRun) || allows(inj?.canUpperLoad) || allows(inj?.canLowerLoad);
      } else {
        anyDisciplineAllowed = allows(inj?.canRun);
      }
      stance = anyDisciplineAllowed ? 'reduce' : 'rest';
    }
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

  const primaryMessage = derivePrimaryMessage(signals, readiness, blockers, strain ?? null, stance);
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

// Post-session + injury-cap-overshoot sentences live in the canonical
// capacity-strain module (single source with the strain percent itself).
// Re-exported here so existing imports keep working.
export { postSessionSentence, injuryCapOvershootSentence };

/**
 * Legacy wrapper kept for the existing `coach.ringLabel` plumbing. Returns
 * null in all cases now. The underlying readiness label stays in the ring
 * (it has to fit a narrow circle), and post-session copy is surfaced in
 * the sentence below the ring instead.
 */
export function derivePostSessionLabel(
  _readiness: ReadinessResult,
  _strainCtx: StrainContext | null,
  _dailyCTL: number,
): null {
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
        longRunDrifts.push(heatAdjust(actual.hrDrift, actual.ambientTempC, heatStrainRatioForState(s)));
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
 * is sitting too close to aerobic threshold. The athlete's "easy" isn't easy enough.
 *
 * Pure function. Pass in SimulatorState, returns string | null for the UI.
 */
// ─── Durability flag (drift-based injury risk signal) ───────────────────────
//
// Strict matching: only `plannedType === 'easy'` or `'long'`. These are the
// only session types where cardiovascular drift is meaningfully "higher than
// expected". Drift on intervals or tempo is an artefact of the effort
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

// Heat correction. Literature-approximate 0.15%/°C rise in HR drift above
// 15°C neutral. Used across durability detection and coach commentary.
//
// `heatStrainRatio` scales the correction by body size (larger athletes store
// heat faster, so more of their hot-day drift is heat-driven). Defaults to 1.0
// = the reference build, which reproduces the original formula EXACTLY. So any
// caller that omits the argument is unchanged (regression-locked in
// daily-coach.heatAdjust.test.ts). Ratio comes from heatStrainRatioForState().
export function heatAdjust(drift: number, tempC: number | null | undefined, heatStrainRatio: number = 1.0): number {
  if (tempC == null) return drift;
  return drift - 0.15 * heatStrainRatio * Math.max(0, tempC - 15);
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
      const adj = heatAdjust(actual.hrDrift, actual.ambientTempC, heatStrainRatioForState(s));
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
      const adj = heatAdjust(actual.hrDrift, actual.ambientTempC, heatStrainRatioForState(s));
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
// sole trigger. Mixed (easy + long) flags surface on the injury-risk page
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
  stance: CoachStance,
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
  if (blockers.includes('injury')) {
    // Session exceeded the injury-capped plan by the "Load exceeded" margin
    // (sp ≥ 130% of plan). Mirrors the tri-mode home-view call-out: the ring
    // stays capacity-based, the sentence carries the rehab-cap message.
    if (trained && sp >= 130 && actualTSS > 0) {
      const plannedTSS = actualTSS / (sp / 100);
      const capacityAnchor = Math.max(plannedTSS, dailyCTL ?? 0);
      const capacityPct = capacityAnchor > 0 ? (actualTSS / capacityAnchor) * 100 : sp;
      return injuryCapOvershootSentence(actualTSS, plannedTSS, capacityPct);
    }
    // Tailor the message to whether the user actually has training options.
    // Full-stop message only when the stance routed to 'rest' above; for
    // partially-restricted injuries (e.g. tri user with shoulder injury still
    // running and biking), surface a "reduce" message instead of "paused".
    if (stance === 'rest') {
      return 'Injury is active. Training is paused until cleared.';
    }
    return 'Injury is active. Train only the disciplines you marked as available, at reduced intensity.';
  }
  if (blockers.includes('illness'))
    return 'Illness flag is set. Rest until symptoms resolve.';

  // ── Tier 1: Session complete (strain-based) ─────────────────────────────
  if (strain?.isRestDayOverreaching)
    return 'High load on a rest day. Recovery for upcoming sessions is impaired.';
  const postNote = postSessionSentence(actualTSS, sp);
  if (postNote) return postNote;

  // ── Tier 2: Red flags ───────────────────────────────────────────────────
  // Hard-floor signals first. The message must explain whatever is capping
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
    if (hard)
      return `Load spike (${sig.acwr}x). Reduce or skip ${wn}.`;
    if (restDay)
      return strain?.upcomingHard
        ? `Load spike (${sig.acwr}x). Rest is well placed. Treat ${strain.upcomingHard.whenLabel}'s ${strain.upcomingHard.type.replace(/_/g, ' ')} as a chance to ease in.`
        : `Load spike (${sig.acwr}x). Rest is well placed. No hard sessions in the next couple of days.`;
    return strain?.upcomingHard
      ? `Load spike (${sig.acwr}x). Keep today easy. Treat ${strain.upcomingHard.whenLabel}'s ${strain.upcomingHard.type.replace(/_/g, ' ')} as a chance to ease in.`
      : `Load spike (${sig.acwr}x). Keep today easy. Nothing hard is planned in the next couple of days.`;
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
  // Gate on TSB being meaningfully negative. The fitness sub-score reads ~39
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
    if (hard)
      return `Training load spiking (${sig.acwr}x). Keep ${wn} controlled.`;
    if (restDay)
      return strain?.upcomingHard
        ? `Training load spiking (${sig.acwr}x). Rest is well placed. ${strain.upcomingHard.whenLabel.charAt(0).toUpperCase() + strain.upcomingHard.whenLabel.slice(1)}'s ${strain.upcomingHard.type.replace(/_/g, ' ')} is the next thing to watch.`
        : `Training load spiking (${sig.acwr}x). Rest is well placed.`;
    return strain?.upcomingHard
      ? `Training load spiking (${sig.acwr}x). Easy session is well placed today. ${strain.upcomingHard.whenLabel.charAt(0).toUpperCase() + strain.upcomingHard.whenLabel.slice(1)}'s ${strain.upcomingHard.type.replace(/_/g, ' ')} is the next thing to watch.`
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

  // Taper phase. Only when readiness is reasonable (score ≥ 50).
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
  /**
   * Active injury signal. Includes the discipline gates so the LLM can
   * suggest concrete swaps ("you can still bike. Let's move today's run to
   * a bike at zone 2"). `phase` lets the coach acknowledge clinical stage.
   */
  injury: {
    bodyPart: string;
    severity: string;
    phase?: string;
    pain?: number;
    canRun?: 'yes' | 'limited' | 'no';
    canBike?: 'yes' | 'limited' | 'no';
    canSwim?: 'yes' | 'limited' | 'no';
    canUpperLoad?: 'yes' | 'limited' | 'no';
    canLowerLoad?: 'yes' | 'limited' | 'no';
    /**
     * Return-ramp counters per discipline. When a gate transitions from
     * 'no'/'limited' back to 'yes', that discipline gets 2 weeks of downmix
     * before resuming full volume. The LLM should reference this so it can
     * say "you are 1 week into a swim return. Keep it easy" instead of
     * recommending full intensity.
     */
    returnRampWeeksLeft?: Partial<Record<'run' | 'bike' | 'swim' | 'stations', number>>;
  } | null;
  /**
   * Active illness signal. `severity` is the legacy two-tier field, retained
   * for prompts that already key off it. The v2 fields (set when the user has
   * gone through the new illness form) give the LLM enough context to give
   * specific advice. "Day 3 of below-neck recovery, two rest days remaining"
   * rather than just "you're ill".
   */
  illness: {
    severity: 'light' | 'resting';                    // legacy tier
    neckRule?: 'above' | 'below';
    severityTier?: 'mild' | 'moderate' | 'severe';
    hasSystemic?: boolean;
    rhrFlag?: 'normal' | 'elevated' | 'high';
    todayCapacity?: 'rest' | 'easy_only' | 'reduced' | 'full';
    effectiveCapacity?: 'rest' | 'easy_only' | 'reduced' | 'full';
    todayVolumePct?: number | null;                   // 0–100, null when capacity = full
    daysSinceOnset?: number;
    daysRemainingAcute?: number;                      // remaining rest days in schedule
    daysRemainingRamp?: number;                       // remaining graded-return days
    pastSchedule?: boolean;                            // true if today is beyond schedule end
    staleRhrElevated?: boolean;                        // past schedule AND RHR still +5 bpm
    raceCollision?: 'acute' | 'ramp' | 'safe' | null;
    raceDaysFromToday?: number | null;
    symptoms?: Array<'fever' | 'body_aches' | 'cough' | 'runny_nose' | 'sore_throat' | 'gi' | 'headache' | 'fatigue'>;
    userCapacityOverride?: 'easy_only' | 'walks' | 'rest';
  } | null;
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

/**
 * Build the v2 illness payload that the LLM sees. Returns null when illness
 * isn't active. Falls back to the legacy `{ severity }` shape when state is
 * missing (callers without state argument) or when the user is on a pre-v2
 * illnessState that has no classification or schedule.
 *
 * Why this lives here and not in illness-rules.ts: it depends on `sig`
 * (CoachSignals) for the legacy severity passthrough, which is already
 * computed in this module.
 */
function buildIllnessPayloadForCoach(
  state: SimulatorState | undefined,
  sig: CoachSignals,
): CoachNarrativePayload['illness'] {
  if (!sig.illnessActive) return null;
  const legacy = (sig.illnessSeverity === 'resting' ? 'resting' : 'light') as 'resting' | 'light';

  if (!state) return { severity: legacy };
  const illness = state.illnessState;
  if (!illness?.active) return { severity: legacy };

  // No v2 fields → return legacy shape only.
  if (!illness.schedule || illness.schedule.length === 0) {
    return {
      severity: legacy,
      neckRule: illness.classification?.neckRule,
      severityTier: illness.classification?.severityTier,
      hasSystemic: illness.classification?.hasSystemic,
      rhrFlag: illness.classification?.rhrFlag,
      symptoms: illness.symptoms,
      userCapacityOverride: illness.userCapacityOverride,
    };
  }

  // Date math (noon-UTC, same trick used elsewhere).
  const todayISO = new Date().toISOString().split('T')[0];
  const todayMs = new Date(todayISO + 'T12:00:00').getTime();
  const startMs = new Date(illness.startDate + 'T12:00:00').getTime();
  const onsetISO = illness.onsetDate ?? illness.startDate;
  const onsetMs = new Date(onsetISO + 'T12:00:00').getTime();

  const scheduleOffset = Math.max(0, Math.round((todayMs - startMs) / 86400000));
  const daysSinceOnset = Math.max(0, Math.round((todayMs - onsetMs) / 86400000));

  const scheduleEntry = illness.schedule.find(e => e.dateOffsetDays === scheduleOffset) ?? null;
  const effective = resolveEffectiveEntry(scheduleEntry, illness.userCapacityOverride);
  const maxOffset = Math.max(...illness.schedule.map(e => e.dateOffsetDays));
  const pastSchedule = scheduleOffset > maxOffset;

  // Remaining rest and ramp days are counted from offsets *after* today,
  // so the LLM can say "two more rest days" accurately.
  let daysRemainingAcute = 0;
  let daysRemainingRamp = 0;
  for (const e of illness.schedule) {
    if (e.dateOffsetDays <= scheduleOffset) continue;
    if (e.capacity === 'rest') daysRemainingAcute++;
    else if (e.capacity === 'reduced' || e.capacity === 'easy_only') daysRemainingRamp++;
  }

  const rhrDelta = computeRhrDeltaFromHistory(state.physiologyHistory);
  const staleRhrElevated = pastSchedule && rhrDelta != null && rhrDelta >= 5;

  const raceISO = getRaceDateISO(state);
  const collision = detectRaceCollision(raceISO, illness.startDate, illness.schedule);

  return {
    severity: legacy,
    neckRule: illness.classification?.neckRule,
    severityTier: illness.classification?.severityTier,
    hasSystemic: illness.classification?.hasSystemic,
    rhrFlag: illness.classification?.rhrFlag,
    todayCapacity: scheduleEntry?.capacity,
    effectiveCapacity: effective?.capacity ?? 'full',
    todayVolumePct: effective && effective.capacity !== 'full'
      ? Math.round(effective.volumeFactor * 100) : null,
    daysSinceOnset,
    daysRemainingAcute,
    daysRemainingRamp,
    pastSchedule,
    staleRhrElevated,
    raceCollision: collision?.phase ?? null,
    raceDaysFromToday: collision?.daysFromToday ?? null,
    symptoms: illness.symptoms,
    userCapacityOverride: illness.userCapacityOverride,
  };
}

export function buildCoachSignalsPayload(coach: CoachState, state?: SimulatorState): CoachNarrativePayload {
  const sig = coach.signals;

  const hrvPct = (sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0)
    ? Math.round(((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline) * 100)
    : null;

  const weekTssPct = (sig.weekTSS != null && sig.plannedTSS != null && sig.plannedTSS > 0)
    ? Math.round((sig.weekTSS / sig.plannedTSS) * 100)
    : null;

  // Surface gates + phase so the LLM can recommend discipline swaps instead
  // of a generic "rest" response (e.g. tri user with shoulder injury can
  // still bike + run. The coach should propose those, not blanket rest).
  const injuryState = state?.injuryState;
  const injury = sig.injuryActive
    ? {
        bodyPart: (sig.injuryLocation ?? 'unspecified').slice(0, 40),
        severity: 'active',
        phase: injuryState?.injuryPhase,
        pain: injuryState?.currentPain,
        canRun: injuryState?.canRun,
        canBike: injuryState?.canBike,
        canSwim: injuryState?.canSwim,
        canUpperLoad: injuryState?.canUpperLoad,
        canLowerLoad: injuryState?.canLowerLoad,
        returnRampWeeksLeft: injuryState?.returnRampWeeksLeft,
      }
    : null;

  const illness = buildIllnessPayloadForCoach(state, sig);

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
