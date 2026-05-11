/**
 * Readiness detail page — composite training readiness breakdown.
 * Shows Freshness (TSB), Load Ratio (ACWR), and Recovery sub-signals.
 * Opens from the Readiness ring on the Home view.
 * Copies the sky-gradient design language from recovery-view.
 */

import { getState } from '@/state';
import type { SimulatorState, Week } from '@/types/state';
import {
  computeReadinessACWR,
  computeLiveSameSignalTSB,
  computeFitnessModel,
  computeTodayStrainTSS,
  computePlannedDaySignalBTSS,
  estimateWorkoutDurMin,
  getTrailingEffortScore,
  computeToBaseline,
  REST_DAY_OVERREACH_RATIO,
} from '@/calculations/fitness-model';
import {
  computeReadiness,
  readinessColor,
  readinessColorStops,
  computeRecoveryScore,
  LEG_LOAD_MODERATE,
  LEG_LOAD_HEAVY,
} from '@/calculations/readiness';
import { getSleepBank, deriveSleepTarget, computeSleepDebt, fmtSleepDebt, buildDailySignalBTSS, computeSleepDebtOutlook } from '@/calculations/sleep-insights';
import { generateWeekWorkouts } from '@/workouts';
import { TL_PER_MIN } from '@/constants';
import { computeDailyCoach } from '@/calculations/daily-coach';
import { computeTriReadiness } from '@/calculations/tri-readiness';
import { classifyActivity } from '@/calculations/tri-benchmarks-from-history';
import { CTL_TAU_DAYS, ATL_TAU_DAYS } from '@/constants/triathlon-constants';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';
import { buildFloweyHaloBackground, floweyHaloAnimationCSS, buildSunGlint, atmosphereGradient } from './page-flair';
// Suppress unused warnings — keeping legacy sky imports for safety
void buildSkyBackground; void skyAnimationCSS;
const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const RING_R = 46;
const RING_C = +(2 * Math.PI * RING_R).toFixed(2);

// ── Sky background (same visual language as recovery-view) ────────────────────
// Gradient IDs are prefixed "rdn" to avoid conflicts when both views exist in DOM

function skyBackground(_isHyrox: boolean): string {
  return buildFloweyHaloBackground('rdn', 'blue') + buildSunGlint('low');
}

// ── Explanatory copy ──────────────────────────────────────────────────────────

function freshnessExplanation(tsb: number): string {
  // Thresholds on daily-equivalent (tsb already in weekly units, ÷7 for display)
  const d = Math.round(tsb / 7);
  if (d > 5)     return 'Fatigue has cleared faster than fitness has decayed. Good window for a hard session or race.';
  if (d > 0)     return 'Slightly fresh. Normal training today is fine.';
  if (d >= -3)   return 'Mild fatigue from recent training. Normal training today is fine.';
  if (d >= -8)   return 'Moderate fatigue. Legs may feel heavy. Easy effort recommended today.';
  if (d >= -15)  return 'Heavy recent load. Expect sore legs and reduced performance. Easy sessions or rest until this clears.';
  if (d >= -25)  return 'Significant fatigue accumulation. Rest or very easy movement only. Hard sessions will not produce useful adaptation.';
  return 'Sustained overload. Full rest days needed before resuming any structured training.';
}

function loadRatioExplanation(status: string, ratio: number): string {
  if (ratio <= 0 || status === 'unknown') return 'Insufficient training history to compute a reliable ratio. At least 3 weeks of data needed.';
  if (status === 'low')     return 'Acute load is well below chronic baseline. Deload week or reduced training phase.';
  if (status === 'safe')    return 'Load increase is within the optimal window relative to recent training.';
  if (status === 'caution') return 'This week\'s load exceeds the 4-week average. Monitor for soreness.';
  return 'Acute load significantly exceeds chronic baseline. Reduce intensity or volume.';
}

function recoveryExplanation(score: number | null, hasData: boolean): string {
  if (!hasData || score === null) return 'Connect a watch to unlock HRV and sleep data.';
  if (score >= 80) return 'Sleep and heart rate data indicate strong overnight recovery.';
  if (score >= 60) return 'Physiology signals are moderate.';
  return 'Poor physiology signals. Easy training is advisable.';
}

// ── Main HTML ──────────────────────────────────────────────────────────────────

function getReadinessHTML(s: SimulatorState): string {
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeReadinessACWR(s);
  // Live TSB with intra-week decay through today (shared with home-view so scores match).
  const completedWeek = Math.max(0, s.w - 1);
  const archivedPlans = s.previousPlanWks ?? undefined;
  const liveTSB = computeLiveSameSignalTSB(s.wks ?? [], s.w, s.signalBBaseline ?? undefined, s.ctlBaseline ?? undefined, s.planStartDate, archivedPlans);
  const tsb = liveTSB.tsb;
  const ctlNow = liveTSB.ctl;
  const metrics = computeFitnessModel(s.wks ?? [], completedWeek, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, undefined, archivedPlans);

  const today = new Date().toISOString().split('T')[0];
  const manualToday = (s.recoveryHistory ?? []).slice().reverse().find(
    (e: any) => e.date === today && e.source === 'manual',
  );
  const latestPhysio = s.physiologyHistory?.slice(-1)[0];
  const garminTodaySleep = (s.physiologyHistory ?? []).find(p => p.date === today && p.sleepScore != null);
  const latestWithSleep = (s.physiologyHistory ?? []).slice().reverse().find(p => p.sleepScore != null);
  const sleepScore: number | null = garminTodaySleep?.sleepScore
    ?? (manualToday as any)?.sleepScore
    ?? latestWithSleep?.sleepScore
    ?? null;
  const latestWithHrv = (s.physiologyHistory ?? []).slice().reverse().find(p => p.hrvRmssd != null);
  const hrvRmssd: number | null = latestWithHrv?.hrvRmssd ?? null;
  const hrvAll = (s.physiologyHistory ?? [])
    .map((p: any) => p.hrvRmssd).filter((v: any) => v != null) as number[];
  const hrvPersonalAvg: number | null = hrvAll.length >= 3
    ? Math.round(hrvAll.reduce((a: number, b: number) => a + b, 0) / hrvAll.length)
    : null;
  const effectiveSleepTarget = s.sleepTargetSec ?? deriveSleepTarget(s.physiologyHistory ?? []);
  const sleepBank = getSleepBank(s.physiologyHistory ?? [], effectiveSleepTarget);
  const dailyTSSByDate = buildDailySignalBTSS(s.wks ?? [], archivedPlans);
  const debtOutlook = computeSleepDebtOutlook(
    s.physiologyHistory ?? [], dailyTSSByDate, s.athleteTier ?? 'recreational', effectiveSleepTarget,
  );
  // Excess above personal baseline: positive = worse than usual, negative = better than usual.
  // null when fewer than 14 nights of history (computeSleepDebtOutlook returns typicalDebtSec: null).
  const sleepDebtExcessSec = debtOutlook.typicalDebtSec != null
    ? debtOutlook.debtSec - debtOutlook.typicalDebtSec
    : null;

  // ── Recovery sub-signal (computed first — feeds into readiness composite) ──
  const noGarminSleep = !(s.physiologyHistory ?? []).find(p => p.date === today && p.sleepScore != null);
  const physioForRecovery = (() => {
    const h = s.physiologyHistory ?? [];
    if (!(manualToday as any)?.sleepScore || !noGarminSleep) return h;
    const idx = h.findIndex(p => p.date === today);
    if (idx >= 0) return h.map((p, i) => i === idx ? { ...p, sleepScore: (manualToday as any).sleepScore } : p);
    return [...h, { date: today, sleepScore: (manualToday as any).sleepScore }];
  })();
  const suppressSleep = noGarminSleep && !(manualToday as any)?.sleepScore;
  const sleepDebtForRecovery = sleepBank.bankSec < 0 ? Math.abs(sleepBank.bankSec) : 0;
  const recoveryResult = computeRecoveryScore(physioForRecovery, {
    manualSleepScore: noGarminSleep ? ((manualToday as any)?.sleepScore ?? undefined) : undefined,
    sleepDebtSec: sleepDebtForRecovery,
  });

  // ── Strain % (must match home-view logic so readiness score is consistent) ──
  const strainWk = (s.wks ?? [])[s.w - 1];
  const todayPhysioR = (s.physiologyHistory ?? []).find(e => e.date === today);
  const todaySignalBTSS = strainWk ? computeTodayStrainTSS(strainWk, today, todayPhysioR, s.tssPerActiveMinute) : 0;
  const todayDayOfWeek = (new Date(today + 'T12:00:00').getDay() + 6) % 7;
  // Just-Track users have no plan — skip the planned-workout comparison entirely.
  // Plan-derived fields (s.rd, s.v, s.pac) are stale defaults in trackOnly and
  // would produce a bogus "planned" list that poisons plannedDayTSS maths.
  const plannedWorkouts = (strainWk && !s.trackOnly) ? generateWeekWorkouts(
    strainWk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e,
    s.w, s.tw, s.v, s.gs, getTrailingEffortScore(s.wks, s.w), strainWk.scheduledAcwrStatus, undefined,
    s.onboarding?.weeklyTrainingHours, s.onboarding?.runningExcludedWorkouts,
  ) : [];
  if (strainWk?.workoutMoves) {
    for (const [workoutId, newDay] of Object.entries(strainWk.workoutMoves)) {
      const w = plannedWorkouts.find((wo: any) => (wo.id || wo.n) === workoutId);
      if (w) (w as any).dayOfWeek = newDay;
    }
  }
  const baseMinPerKmR = s.pac?.e ? s.pac.e / 60 : 5.5;
  // Exclude cross-training from planned strain targets
  const runWorkouts = plannedWorkouts.filter((w: any) => w.t !== 'cross');
  const plannedDayTSS = computePlannedDaySignalBTSS(runWorkouts, todayDayOfWeek, baseMinPerKmR);
  // Per-session average: planned week TSS / training day count (tracks plan intent, not CTL history)
  const trainingDayCount = [0,1,2,3,4,5,6]
    .filter(d => computePlannedDaySignalBTSS(runWorkouts, d, baseMinPerKmR) > 0).length || 4;
  const plannedWeekTSS = [0,1,2,3,4,5,6]
    .reduce((sum, d) => sum + computePlannedDaySignalBTSS(runWorkouts, d, baseMinPerKmR), 0);
  const perSessionAvg = trainingDayCount > 0 ? plannedWeekTSS / trainingDayCount : 0;
  // Detect matched activity on a day with no generated workout
  let matchedActivityToday = false;
  if (plannedDayTSS === 0 && strainWk) {
    for (const [, actual] of Object.entries(strainWk.garminActuals ?? {})) {
      if (!actual.startTime?.startsWith(today)) continue;
      matchedActivityToday = true;
      break;
    }
  }
  const hasPlannedWorkout = plannedDayTSS > 0;
  const isRestDay = !hasPlannedWorkout && !matchedActivityToday;
  // Rest-day overreach: activity exceeds 50% of per-session average
  const restDayOverreachThreshold = perSessionAvg * REST_DAY_OVERREACH_RATIO;
  const isRestDayOverreaching = isRestDay && todaySignalBTSS > 0 && perSessionAvg > 0 && todaySignalBTSS > restDayOverreachThreshold;
  // Strain: planned days vs plan, adhoc vs per-session avg
  const strainPct = hasPlannedWorkout && todaySignalBTSS > 0 && plannedDayTSS > 0
    ? (todaySignalBTSS / plannedDayTSS) * 100
    : 0;
  const adhocPct = matchedActivityToday && perSessionAvg > 0 ? (todaySignalBTSS / perSessionAvg) * 100 : 0;

  const isHyroxMode = s.eventType === 'hyrox';
  const hxMtlCTL = s.hyroxConfig?.mtlCTL ?? 0;
  const hxMtlATL = s.hyroxConfig?.mtlATL ?? 0;
  const mtlAcwrValue = isHyroxMode && hxMtlCTL >= 15 ? hxMtlATL / hxMtlCTL : null;

  const readiness = computeReadiness({
    tsb,
    acwr: acwr.ratio,
    ctlNow,
    sleepScore,
    hrvRmssd,
    sleepHistory: s.physiologyHistory ?? [],
    hrvPersonalAvg,
    sleepBankSec: sleepBank.nightsWithData >= 3 ? sleepBank.bankSec : null,
    sleepDebtExcessSec,
    weeksOfHistory: metrics.length,
    strainPct: todaySignalBTSS > 0 ? strainPct : null,
    recentLegLoads: s.recentLegLoads ?? [],
    precomputedRecoveryScore: recoveryResult.hasData ? recoveryResult.score : null,
    acwrSafeUpper: acwr.safeUpper,
    mtlAcwr: mtlAcwrValue,
  });

  const isTri = s.eventType === 'triathlon';
  const isHyrox = isHyroxMode;
  const triReadiness = isTri ? computeTriReadiness(s) : null;

  // Cross-training readiness for non-tri modes — compute ATL/CTL from non-run garminActuals.
  // Tri mode reads crossTrainingAtl/Ctl from triConfig.fitness (already computed at launch).
  const crossTrainingLoad = (() => {
    if (isTri) return null;  // tri mode uses triReadiness.crossTraining instead
    const archivedWks = (s.previousPlanWks ?? []).flatMap(p => p.weeks as Week[]);
    const allWks: Week[] = [...archivedWks, ...(s.wks ?? [])];
    const now = Date.now();
    const normalise = (sum: number, tau: number) => (sum / tau) * 7;
    let atlSum = 0, ctlSum = 0;
    for (const wk of allWks) {
      for (const a of Object.values(wk.garminActuals ?? {})) {
        if (!a.startTime) continue;
        const sport = classifyActivity(a.activityType);
        if (sport === 'run') continue;  // only cross-training
        const day = Math.floor((now - Date.parse(a.startTime)) / 86400000);
        if (day < 0 || day > 120) continue;
        const tss = a.iTrimp != null && a.iTrimp > 0 ? a.iTrimp / 150
          : (a.durationSec ?? 0) / 60 * 0.8;
        if (tss <= 0) continue;
        atlSum += tss * Math.exp(-day / ATL_TAU_DAYS);
        ctlSum += tss * Math.exp(-day / CTL_TAU_DAYS);
      }
    }
    const atl = Math.round(normalise(atlSum, ATL_TAU_DAYS) * 10) / 10;
    const ctl = Math.round(normalise(ctlSum, CTL_TAU_DAYS) * 10) / 10;
    if (atl <= 0) return null;
    return { atl, ctl, result: computeReadiness({
      tsb: (ctl - atl) / 7,
      acwr: ctl >= 10 ? atl / ctl : 1.0,
      ctlNow: ctl / 7,
      sleepScore: null, sleepHistory: [], hrvRmssd: null, hrvPersonalAvg: null,
      sleepDebtExcessSec: null, weeksOfHistory: 0,
    }) };
  })();

  // Use the central daily-coach for the sentence (auto-derives strain context)
  const _coach = computeDailyCoach(s);
  const coachMessage = (() => {
    if (!isTri || !triReadiness) return _coach.primaryMessage;

    // Determine the most important systemic signal (sleep, HRV, load) — may override
    // or augment the discipline sentence depending on severity.
    const hrvDrop = (hrvRmssd != null && hrvPersonalAvg != null && hrvPersonalAvg > 0)
      ? (hrvPersonalAvg - hrvRmssd) / hrvPersonalAvg
      : null;
    const debtExcessHours = debtOutlook.typicalDebtSec != null
      ? (debtOutlook.debtSec - debtOutlook.typicalDebtSec) / 3600
      : null;

    const systemicNote = (() => {
      if (hrvDrop != null && hrvDrop > 0.30)
        return 'HRV is significantly suppressed. Avoid high-intensity work today.';
      if (hrvDrop != null && hrvDrop > 0.20)
        return 'HRV is moderately suppressed. High-intensity work carries more risk today.';
      if (sleepScore != null && sleepScore < 50)
        return 'Last night\'s sleep was poor. Recovery is reduced.';
      if (debtExcessHours != null && debtExcessHours >= 2)
        return `Sleep debt is ${Math.round(debtExcessHours)}h above your typical level. Prioritise sleep tonight.`;
      return null;
    })();

    // If systemic signals are the primary driver (HRV or sleep) and disciplines are clear,
    // lead with the systemic note rather than defaulting to "all disciplines are clear".
    const discIssue = triReadiness.overall !== 'On Track' && triReadiness.overall !== 'Primed';
    if (!discIssue && systemicNote) return systemicNote;

    // Disciplines have an issue — lead with that, append systemic context if notable.
    const discSentence = triReadiness.sentence;
    if (systemicNote) return `${discSentence} ${systemicNote}`;
    return discSentence;
  })();
  const sessionNote = _coach.sessionNote;
  const activeStrainPct = todaySignalBTSS > 0 ? strainPct : 0;

  // Big ring = global recovery readiness (mirrors home card big ring).
  const ringColor = readinessColor(readiness.label);
  const ringStops = readinessColorStops(readiness.label);
  const score = readiness.score;
  const targetOffset = +(RING_C * (1 - score / 100)).toFixed(2);
  const ringLabel = _coach.ringLabel;

  // ── Freshness sub-signal ───────────────────────────────────────────────────
  const tsbDisp = Math.round(tsb / 7);
  const tsbLabel = tsbDisp > 0 ? `+${tsbDisp}` : `${tsbDisp}`;
  // Zone thresholds on daily-equivalent TSB (Coggan/TrainingPeaks standard)
  const tsbZone = tsbDisp > 0 ? 'Fresh' : tsbDisp >= -3 ? 'Recovering' : tsbDisp >= -8 ? 'Fatigued' : tsbDisp >= -15 ? 'Heavy' : tsbDisp >= -25 ? 'Overloaded' : 'Overreaching';
  const tsbColor = tsbDisp > 0 ? 'var(--c-ok)' : tsbDisp >= -3 ? 'var(--c-accent)' : tsbDisp >= -15 ? 'var(--c-caution)' : 'var(--c-warn)';

  // ── To Baseline — stacked session recovery ──────────────────────────────────
  // Same model as freshness page: all recent sessions stacked, sport-adjusted,
  // sleep/HRV-adjusted. See computeToBaseline() in fitness-model.ts.
  const ctlForBaseline = liveTSB.ctl / 7;
  const baselineResult = computeToBaseline(s.wks ?? [], completedWeek, ctlForBaseline, s.planStartDate, s.physiologyHistory, s.adaptiveRecovery);
  const fatigueDecayHours = baselineResult?.hours ?? null;

  // ── Load Ratio sub-signal ───────────────────────────────────────────────────
  const safetyLabel = acwr.ratio <= 0 ? '—'
    : acwr.status === 'low' ? 'Low'
    : acwr.status === 'unknown' ? 'No Data'
    : acwr.status === 'safe' ? 'Optimal'
    : acwr.status === 'caution' ? 'High'
    : 'Very High';
  const safetyColor = acwr.status === 'high' ? 'var(--c-warn)'
    : acwr.status === 'caution' ? 'var(--c-caution)'
    : acwr.status === 'low' || acwr.status === 'unknown' ? TEXT_S
    : 'var(--c-ok)';
  const acwrRatioStr = acwr.ratio > 0 ? acwr.ratio.toFixed(2) + '×' : '—';
  const acuteDaily = Math.round(acwr.atl / 7);
  const chronicDaily = Math.round(acwr.ctl / 7);
  const acuteChronicStr = acwr.ratio > 0 ? `7d: ${Math.round(acwr.atl)} TSS / 28d avg: ${Math.round(acwr.ctl)} TSS` : '';
  const recScoreColor = recoveryResult.hasData
    ? (recoveryResult.score! >= 80 ? 'var(--c-ok)' : recoveryResult.score! >= 65 ? 'var(--c-ok-muted)' : recoveryResult.score! >= 50 ? 'var(--c-caution)' : 'var(--c-warn)')
    : TEXT_S;
  const recValueStr = recoveryResult.hasData && recoveryResult.score != null
    ? `${recoveryResult.score}/100` : '—';

  // ── Strain sub-signal ──────────────────────────────────────────────────────
  // Round before bucketing so the displayed "130%" matches the "Exceeded" state.
  const displayStrainPct = Math.round(activeStrainPct);
  const displayAdhocPct = Math.round(adhocPct);
  let strainLabel: string;
  let strainColor: string;
  if (isRestDay) {
    strainLabel = isRestDayOverreaching ? 'Overreaching' : (todaySignalBTSS > 0 ? 'Active rest' : 'Rest day');
    strainColor = isRestDayOverreaching ? 'var(--c-warn)' : (todaySignalBTSS > 0 ? 'var(--c-ok)' : TEXT_S);
  } else if (matchedActivityToday && !hasPlannedWorkout) {
    // Adhoc activity on a non-planned day — match home-view logic
    strainLabel = displayAdhocPct >= 150 ? 'High' : displayAdhocPct >= 80 ? 'Optimal' : displayAdhocPct >= 50 ? 'Moderate' : 'Light';
    strainColor = displayAdhocPct >= 150 ? 'var(--c-warn)' : displayAdhocPct >= 80 ? 'var(--c-ok)' : TEXT_S;
  } else {
    strainLabel = displayStrainPct >= 130 ? 'Exceeded'
      : displayStrainPct >= 100 ? 'Complete'
      : displayStrainPct >= 50 ? 'In Progress'
      : displayStrainPct > 0 ? 'Starting'
      : 'Not started';
    strainColor = displayStrainPct >= 130 ? 'var(--c-warn)'
      : displayStrainPct >= 100 ? 'var(--c-ok)'
      : displayStrainPct >= 50 ? 'var(--c-caution)'
      : TEXT_S;
  }

  // ── Card builder ───────────────────────────────────────────────────────────
  const card = (content: string, id?: string, extraStyle?: string) =>
    `<div ${id ? `id="${id}"` : ''} style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.65);border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);margin-bottom:12px;cursor:pointer;${extraStyle ?? ''}">${content}</div>`;

  // Adhoc activity on a non-planned day: show TSS + adhocPct label (no plan to compare %)
  const isAdhoc = matchedActivityToday && !hasPlannedWorkout;
  const showTSSValue = isRestDay || isAdhoc;
  const strainValueHTML = showTSSValue
    ? `<div style="font-size:24px;font-weight:600;color:${strainColor};line-height:1">${Math.round(todaySignalBTSS)} TSS</div>
       <div style="font-size:13px;color:#94A3B8">${strainLabel}</div>`
    : `<div style="font-size:24px;font-weight:600;color:${strainColor};line-height:1">${displayStrainPct}%</div>
       <div style="font-size:13px;color:#94A3B8">${strainLabel}</div>`;
  const strainExplanation =
      isRestDayOverreaching ? 'High load on a rest day. This level of activity impairs recovery rather than aiding it.'
      : isRestDay && todaySignalBTSS > 0 ? 'Light activity on a rest day. No significant effect on recovery.'
      : isRestDay ? 'Scheduled rest day. No activity expected.'
      : isAdhoc ? `${Math.round(todaySignalBTSS)} TSS from unplanned activity. Readiness adjusted accordingly.`
      : displayStrainPct >= 130 ? `Big session logged (${Math.round(todaySignalBTSS)} TSS). Daily target well exceeded. Recovery is the priority for the next 24 hours.`
      : displayStrainPct >= 100 ? `Daily target reached (${Math.round(todaySignalBTSS)} TSS). Session complete. Readiness reduced accordingly.`
      : displayStrainPct >= 50 ? 'Session in progress. Readiness adjusts downward as load accumulates.'
      : displayStrainPct > 0 ? 'Light activity logged. No significant effect on readiness yet.'
      : 'Planned session not yet logged.';
  const strainCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Today's Strain</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">${strainValueHTML}</div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${strainExplanation}</div>
  `, 'rdn-card-strain');

  const fatigueDecayStr = fatigueDecayHours != null
    ? (fatigueDecayHours < 72
      ? `~${fatigueDecayHours}h`
      : `~${Math.ceil(fatigueDecayHours / 24)}d`)
    : null;
  const fatigueDecayLine = fatigueDecayStr != null
    ? `<div style="font-size:12px;color:${TEXT_S};margin-top:4px">${fatigueDecayStr} to baseline</div>`
    : '';

  const freshCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Freshness</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <div style="font-size:24px;font-weight:600;color:${tsbColor};line-height:1">${tsbLabel}</div>
      <div style="font-size:13px;color:#94A3B8">${tsbZone}</div>
    </div>
    ${fatigueDecayLine}
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${freshnessExplanation(tsb)}</div>
  `, 'rdn-card-freshness');

  const isLoadRatioDriving = readiness.hardFloor === 'acwr';
  const loadRatioCardBorder = isLoadRatioDriving ? 'border-left:3px solid var(--c-warn);padding-left:13px;' : '';

  // Leg Fatigue sub-signal — permanent card. Mechanical/tissue load from
  // cross-training, caps readiness at ≥20 (Manage Load) and ≥60 (Ease Back).
  // Surface here rather than in Rolling Load so the signal is visible alongside
  // the other readiness components it competes with.
  const legTotal = readiness.legLoadTotal;
  const legLabel = legTotal >= LEG_LOAD_HEAVY ? 'Heavy'
    : legTotal >= LEG_LOAD_MODERATE ? 'Moderate'
    : legTotal >= 10 ? 'Light'
    : legTotal > 0 ? 'Minimal'
    : 'Fresh';
  const legColor = legTotal >= LEG_LOAD_HEAVY ? 'var(--c-warn)'
    : legTotal >= LEG_LOAD_MODERATE ? 'var(--c-caution)'
    : legTotal >= 10 ? TEXT_M
    : 'var(--c-ok)';
  const legCopy = legTotal >= LEG_LOAD_HEAVY
    ? 'Recent cross-training has left heavy eccentric and impact load. Force absorption is impaired. Skip pounding sessions today.'
    : legTotal >= LEG_LOAD_MODERATE
      ? 'Moderate residual leg load from cross-training. Easy effort is fine. Avoid hard intervals or long impact sessions.'
      : legTotal >= 10
        ? 'Light residual leg load from recent cross-training. No effect on today\'s session.'
        : legTotal > 0
          ? 'Minor residual load. Mechanical recovery is nearly complete.'
          : 'No residual leg load. Mechanical recovery is complete.';
  const isLegDriving = readiness.hardFloor === 'legLoad';
  const legCardBorder = isLegDriving ? 'border-left:3px solid var(--c-warn);padding-left:13px;' : '';
  const legLoadCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Leg Fatigue</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <div style="font-size:24px;font-weight:600;color:${legColor};line-height:1">${legTotal.toFixed(0)}</div>
      <div style="font-size:13px;color:#94A3B8">${legLabel}</div>
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${legCopy}</div>
  `, 'rdn-card-leg-load', legCardBorder);
  const injuryCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Load Ratio</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <div style="font-size:24px;font-weight:600;color:${safetyColor};line-height:1">${acwrRatioStr}</div>
      <div style="font-size:13px;color:#94A3B8">${safetyLabel}</div>
    </div>
    ${acuteChronicStr ? `<div style="font-size:12px;color:${TEXT_S};margin-top:4px">${acuteChronicStr}</div>` : ''}
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${loadRatioExplanation(acwr.status, acwr.ratio)}</div>
  `, 'rdn-card-injury', loadRatioCardBorder);

  const recLabel = recoveryResult.hasData && recoveryResult.score != null
    ? (recoveryResult.score >= 80 ? 'Strong' : recoveryResult.score >= 65 ? 'Moderate' : recoveryResult.score >= 50 ? 'Low' : 'Poor')
    : '';
  const recoveryCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Physiology</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <div style="font-size:24px;font-weight:600;color:${recScoreColor};line-height:1">${recValueStr}</div>
      ${recLabel ? `<div style="font-size:13px;color:#94A3B8">${recLabel}</div>` : ''}
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${recoveryExplanation(recoveryResult.score ?? null, recoveryResult.hasData)}</div>
    ${(noGarminSleep && !(manualToday as any)?.sleepScore) ? `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:1px solid var(--c-border)">
      <span style="font-size:12px;color:var(--c-muted)">Sleep not included, no Garmin data yet</span>
      <button id="rdn-sleep-sync-btn" style="font-size:12px;color:var(--c-accent);background:none;border:none;padding:0;cursor:pointer;font-family:var(--f)">Sync</button>
    </div>` : ''}
  `, 'rdn-card-recovery');

  // Sleep History card — 14d rolling average, debt-adjusted
  const sleepHistAvg = recoveryResult.sleepHistoryAvg;
  const sleepHistScore = recoveryResult.sleepHistoryScore;
  const sleepHistColor = sleepHistScore != null
    ? (sleepHistScore >= 80 ? 'var(--c-ok)' : sleepHistScore >= 65 ? 'var(--c-ok-muted)' : sleepHistScore >= 50 ? 'var(--c-caution)' : 'var(--c-warn)')
    : TEXT_S;
  // Match Sleep detail view: use load-adjusted cumulative debt with exponential decay,
  // not the simple 7-night bank. The bank feeds the recovery score; the card shows the
  // same debt number the user sees when they tap through.
  const cumulativeDebtSec = computeSleepDebt(
    s.physiologyHistory ?? [],
    buildDailySignalBTSS(s.wks ?? [], s.previousPlanWks),
    s.athleteTier ?? 'recreational',
    effectiveSleepTarget,
  );
  const sleepHistLabel = sleepHistScore != null
    ? (sleepHistScore >= 80 ? 'Strong' : sleepHistScore >= 65 ? 'Steady' : sleepHistScore >= 50 ? 'Low' : 'Poor')
    : '';
  const sleepHistMeta = sleepHistAvg != null
    ? `14d avg ${sleepHistAvg}${cumulativeDebtSec > 2700 ? ` · ${fmtSleepDebt(cumulativeDebtSec)} debt` : ''}`
    : '';
  const sleepHistCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Sleep History</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <div style="font-size:24px;font-weight:600;color:${sleepHistColor};line-height:1">${sleepHistScore != null ? sleepHistScore : '—'}</div>
      ${sleepHistLabel ? `<div style="font-size:13px;color:#94A3B8">${sleepHistLabel}</div>` : ''}
    </div>
    ${sleepHistMeta ? `<div style="font-size:12px;color:${TEXT_S};margin-top:4px">${sleepHistMeta}</div>` : ''}
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${
      sleepHistScore == null
        ? 'Not enough sleep data yet. Needs at least 3 nights in the last 14 days.'
        : cumulativeDebtSec >= 7200 && sleepHistScore < 65
          ? `Cumulative sleep debt of ${fmtSleepDebt(cumulativeDebtSec)} is impairing recovery. Duration deficit compounds even when individual night scores appear adequate.`
          : cumulativeDebtSec >= 7200
            ? `Sleep quality scores are reasonable but ${fmtSleepDebt(cumulativeDebtSec)} of cumulative duration debt is accumulating. Prioritise sleep duration.`
            : sleepHistScore >= 75
              ? 'Sleep trend is consistent. No recovery concern from chronic sleep.'
              : sleepHistScore >= 55
                ? 'Sleep trend is slightly depressed. Minor effect on recovery capacity.'
                : 'Sleep trend is poor. Cumulative sleep restriction impairs recovery and adaptation.'
    }</div>
  `, 'rdn-card-sleep-history');

  // Tri mode: per-discipline readiness bars shown at top of the sub-signal section
  const triDiscCard = (() => {
    if (!triReadiness) return '';
    const LABEL_RANK: Record<string, number> = {
      'Primed': 0, 'On Track': 1, 'Manage Load': 2, 'Ease Back': 3, 'Overreaching': 4,
    };
    const shortStatus = (label: string) =>
      label === 'Overreaching' ? 'Back off'
      : label === 'Ease Back' ? 'Ease back'
      : label === 'Manage Load' ? 'Manage'
      : label === 'On Track' ? 'Clear'
      : 'Primed';
    // No bar can show a better label than the overall ring — avoids "Clear" bars
    // alongside an "Ease Back" ring, which would imply permission to push.
    const capLabel = (discLabel: string) =>
      LABEL_RANK[discLabel] >= LABEL_RANK[triReadiness.overall] ? discLabel : triReadiness.overall;
    const makeBar = (discName: string, result: { score: number; label: string }, last = false) => {
      const label = capLabel(result.label);
      const col = readinessColor(label as any);
      return `<div style="${last ? '' : 'margin-bottom:14px'}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <div style="font-size:12px;font-weight:600;color:${TEXT_M}">${discName}</div>
          <div style="display:flex;align-items:baseline;gap:6px">
            <div style="font-size:14px;font-weight:600;color:${col}">${result.score}</div>
            <div style="font-size:11px;color:${TEXT_S}">${shortStatus(label)}</div>
          </div>
        </div>
        <div style="position:relative;height:8px;border-radius:4px;background:rgba(0,0,0,0.07);overflow:hidden">
          <div style="position:absolute;left:0;top:0;height:100%;width:${result.score}%;background:${col};border-radius:4px;transition:width 0.8s cubic-bezier(0.2,0.8,0.2,1)"></div>
        </div>
      </div>`;
    };
    const fit = s.triConfig?.fitness;
    type DiscEntry = { name: string; key: 'swim' | 'bike' | 'run'; result: typeof triReadiness.swim };
    const allDiscs: DiscEntry[] = [
      { name: 'Swim', key: 'swim', result: triReadiness.swim },
      { name: 'Bike', key: 'bike', result: triReadiness.bike },
      { name: 'Run',  key: 'run',  result: triReadiness.run  },
    ];
    // Require both meaningful training volume (CTL ≥ 1) and at least one direct
    // activity — a single ghost swim from months ago decays to ~0.1 CTL and
    // shouldn't surface the discipline in readiness bars.
    const discs = allDiscs.filter(d => (fit?.[d.key]?.directCount ?? 0) > 0 && (fit?.[d.key]?.ctl ?? 0) >= 1);

    if (discs.length === 0) return '';
    const crossTrainingBar = triReadiness.crossTraining
      ? makeBar('Cross-training', triReadiness.crossTraining, true)
      : '';
    const bars = discs.map(d => makeBar(d.name, d.result)).join('');
    return card(`
      <div style="font-size:11px;color:${TEXT_S};margin-bottom:14px;font-weight:500">Discipline Readiness</div>
      ${bars}
      ${crossTrainingBar ? `<div style="margin-top:14px">${crossTrainingBar}</div>` : ''}
    `, 'rdn-card-disciplines');
  })();

  // Cross-training card for non-tri modes — shown when there is any non-run load.
  const crossTrainingCard = (() => {
    if (isTri || !crossTrainingLoad) return '';
    const shortStatus = (label: string) =>
      label === 'Overreaching' ? 'Back off'
      : label === 'Ease Back' ? 'Ease back'
      : label === 'Manage Load' ? 'Manage'
      : label === 'On Track' ? 'Clear'
      : 'Primed';
    const LABEL_RANK: Record<string, number> = {
      'Primed': 0, 'On Track': 1, 'Manage Load': 2, 'Ease Back': 3, 'Overreaching': 4,
    };
    const rawLabel = crossTrainingLoad.result.label;
    const label = LABEL_RANK[rawLabel] >= LABEL_RANK[readiness.label] ? rawLabel : readiness.label;
    const col = readinessColor(label as any);
    return card(`
      <div style="font-size:11px;color:${TEXT_S};margin-bottom:14px;font-weight:500">Cross-training Load</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
        <div style="font-size:12px;font-weight:600;color:${TEXT_M}">Cross-training</div>
        <div style="display:flex;align-items:baseline;gap:6px">
          <div style="font-size:14px;font-weight:600;color:${col}">${crossTrainingLoad.result.score}</div>
          <div style="font-size:11px;color:${TEXT_S}">${shortStatus(label)}</div>
        </div>
      </div>
      <div style="position:relative;height:8px;border-radius:4px;background:rgba(0,0,0,0.07);overflow:hidden">
        <div style="position:absolute;left:0;top:0;height:100%;width:${crossTrainingLoad.result.score}%;background:${col};border-radius:4px;transition:width 0.8s cubic-bezier(0.2,0.8,0.2,1)"></div>
      </div>
    `, 'rdn-card-cross-training');
  })();

  return `
    <style>
      #rdn-view { box-sizing:border-box; }
      #rdn-view *, #rdn-view *::before, #rdn-view *::after { box-sizing:inherit; }
      @keyframes rdnFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .rdn-fade { opacity:0; animation:rdnFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${floweyHaloAnimationCSS('rdn')}
    </style>

    <div id="rdn-view" data-readiness-label="${readiness.label}" style="
      position:relative;min-height:100vh;background:${atmosphereGradient('blue')};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${skyBackground(isHyrox)}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:48px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="rdn-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="font-size:20px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em">Readiness</div>
          <div style="width:36px"></div>
        </div>

        <!-- Ring -->
        <div class="rdn-fade" style="animation-delay:0.05s;display:flex;flex-direction:column;align-items:center;margin:12px 0 28px">
          <div style="
            position:relative;width:220px;height:220px;
            display:flex;align-items:center;justify-content:center;
            background:rgba(255,255,255,0.55);backdrop-filter:blur(16px);
            border-radius:50%;border:1px solid rgba(255,255,255,0.6);
            box-shadow:0 6px 40px -8px rgba(0,0,0,0.15);
          ">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <!-- Same gradient recipe as the page-flair rings, tinted to the readiness colour.
                     SVG is rotated -90deg overall, so visual upper-left = local lower-left.
                     Stops chosen so visually the highlight falls on the upper-left arc. -->
                <linearGradient id="rdn-ring-grad" x1="20%" y1="90%" x2="80%" y2="10%">
                  <stop offset="0%"  stop-color="${ringStops.highlight}"/>
                  <stop offset="50%" stop-color="${ringStops.mid}"/>
                  <stop offset="100%" stop-color="${ringStops.shadow}"/>
                </linearGradient>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="8"/>
              <circle id="rdn-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="url(#rdn-ring-grad)" stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_C}"
                stroke-dashoffset="${RING_C}"
                data-target-offset="${targetOffset}"
                style="transition:stroke-dashoffset 1.2s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
              />
            </svg>
            <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1;color:${ringColor}">${score}</div>
              <div style="font-size:12px;font-weight:600;color:${TEXT_M};margin-top:4px">${ringLabel}</div>
            </div>
          </div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:16px;text-align:center;padding:0 32px;line-height:1.45">${coachMessage}</div>
          ${sessionNote ? `<div style="font-size:13px;color:${TEXT_S};margin-top:10px;text-align:center;padding:0 32px;line-height:1.45;border-top:1px solid var(--c-border);padding-top:10px">${sessionNote}</div>` : ''}
          ${readiness.hardFloor === 'acwr' ? `<div style="margin-top:12px;padding:8px 16px;border-radius:12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.15)">
            <div style="font-size:12px;color:var(--c-warn);font-weight:600;line-height:1.45">Load ratio (${acwrRatioStr}) is the primary constraint. 7-day load ${acwr.status === 'high' ? 'significantly exceeds' : 'exceeds'} 28-day average.</div>
          </div>` : ''}
        </div>

        <!-- Sub-signal cards -->
        <div class="rdn-fade" style="animation-delay:0.18s;padding:0 16px">
          ${triDiscCard}
          ${crossTrainingCard}
          ${isHyrox ? (() => {
            const weeklyActualMTL = s.hyroxConfig?.weeklyActualMTL ?? 0;
            const weeklyPlannedMTL = s.hyroxConfig?.weeklyMTL ?? 0;
            const mtlCap = s.hyroxConfig?.mtlCap ?? 1000;
            const mtlPct = mtlCap > 0 ? Math.min(1, weeklyActualMTL / mtlCap) : 0;
            const acwrVal = mtlAcwrValue;
            const zone = acwrVal == null ? 'safe'
              : acwrVal > 1.5 ? 'high' : acwrVal > 1.3 ? 'caution' : 'safe';
            const zoneLabel = zone === 'high' ? 'Ease Back' : zone === 'caution' ? 'Manage Load' : 'Safe';
            const zoneColor = zone === 'high' ? 'var(--c-warn)' : zone === 'caution' ? 'var(--c-caution)' : 'var(--c-ok)';
            const zoneNote = zone === 'high'
              ? 'Eccentric load spiked this week. Skip or downgrade density sessions.'
              : zone === 'caution'
              ? 'Mechanical load is elevated. Avoid adding extra eccentric work.'
              : weeklyActualMTL < 1 && weeklyPlannedMTL < 1
              ? 'Mechanical load is building. No concern yet.'
              : 'Mechanical load is progressing safely.';
            const plannedLine = weeklyPlannedMTL > 0 && Math.round(weeklyPlannedMTL) !== Math.round(weeklyActualMTL)
              ? ` · ${Math.round(weeklyPlannedMTL)} planned`
              : '';
            return card(`
              <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">MusculoTendon Load</div>
              <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
                <div style="font-size:24px;font-weight:600;color:${zoneColor};line-height:1">${acwrVal != null ? acwrVal.toFixed(2) + '×' : '—'}</div>
                <div style="font-size:13px;color:#94A3B8">${zoneLabel}</div>
              </div>
              <div style="height:5px;background:rgba(0,0,0,0.06);border-radius:3px;overflow:hidden;margin:8px 0">
                <div style="height:100%;width:${Math.round(mtlPct * 100)}%;background:${mtlPct > 0.9 ? 'var(--c-warn)' : mtlPct > 0.65 ? 'var(--c-caution)' : '#b8742c'};border-radius:3px;transition:width 0.4s"></div>
              </div>
              <div style="font-size:12px;color:${TEXT_S};margin-top:2px">${Math.round(weeklyActualMTL)} / ${Math.round(mtlCap)} MTL this week${plannedLine}</div>
              <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${zoneNote}</div>
            `, 'rdn-card-mtl');
          })() : ''}
          ${strainCard}
          ${freshCard}
          ${injuryCard}
          ${recoveryCard}
          ${sleepHistCard}
          ${acwr.atl > 0 ? (() => {
            const rollingTSS = Math.round(acwr.atl);
            const chronicTSS = Math.round(acwr.ctl);
            const rollingLabel = rollingTSS > chronicTSS * 1.3 ? 'High' : rollingTSS > chronicTSS * 0.8 ? 'Normal' : 'Low';
            const rollingColor = rollingTSS > chronicTSS * 1.3 ? 'var(--c-warn)' : rollingTSS > chronicTSS * 0.8 ? 'var(--c-ok)' : TEXT_S;
            return card(`
              <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">7-Day Rolling Load</div>
              <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
                <div style="font-size:24px;font-weight:600;color:${rollingColor};line-height:1">${rollingTSS} TSS</div>
                <div style="font-size:13px;color:#94A3B8">${rollingLabel}</div>
              </div>
              <div style="font-size:12px;color:${TEXT_S};margin-top:4px">28-day avg: ${chronicTSS} TSS</div>
            `, 'rdn-card-rolling-load');
          })() : ''}
          ${legLoadCard}
        </div>

      </div>
    </div>
    ${renderTabBar('home')}
  `;
}

// ── Navigation ───────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'forecast') import('./triathlon/forecast-view').then(m => m.renderTriathlonForecastView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireReadinessHandlers(): void {
  // Animate ring on load
  setTimeout(() => {
    const circle = document.getElementById('rdn-ring-circle');
    const target = (circle as HTMLElement | null)?.dataset.targetOffset;
    if (circle && target) circle.style.strokeDashoffset = target;
  }, 50);

  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Back → home
  document.getElementById('rdn-back-btn')?.addEventListener('click', () => {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  // Card taps → detail pages
  document.getElementById('rdn-card-recovery')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'rdn-sleep-sync-btn') return;
    import('./recovery-view').then(({ renderRecoveryView }) => renderRecoveryView(undefined, () => renderReadinessView()));
  });

  document.getElementById('rdn-card-freshness')?.addEventListener('click', () => {
    import('./freshness-view').then(({ renderFreshnessView }) => renderFreshnessView());
  });

  document.getElementById('rdn-card-injury')?.addEventListener('click', () => {
    import('./injury-risk-view').then(({ renderInjuryRiskView }) => renderInjuryRiskView());
  });

  document.getElementById('rdn-card-strain')?.addEventListener('click', () => {
    const label = document.getElementById('rdn-view')?.dataset.readinessLabel ?? null;
    import('./strain-view').then(({ renderStrainView }) => renderStrainView(undefined, label as any, () => renderReadinessView()));
  });

  document.getElementById('rdn-card-disciplines')?.addEventListener('click', () => {
    import('./rolling-load-view').then(({ renderRollingLoadView }) => renderRollingLoadView());
  });

  document.getElementById('rdn-card-rolling-load')?.addEventListener('click', () => {
    import('./rolling-load-view').then(({ renderRollingLoadView }) => renderRollingLoadView());
  });

  document.getElementById('rdn-card-leg-load')?.addEventListener('click', () => {
    import('./leg-load-view').then(({ renderLegLoadView }) => renderLegLoadView(() => renderReadinessView()));
  });

  document.getElementById('rdn-card-mtl')?.addEventListener('click', () => {
    import('./mtl-load-view').then(({ renderMtlLoadView }) => renderMtlLoadView(() => renderReadinessView()));
  });

  document.getElementById('rdn-card-sleep-history')?.addEventListener('click', () => {
    import('./sleep-view').then(({ renderSleepView }) => renderSleepView(undefined, undefined, undefined, () => renderReadinessView()));
  });

  // Sleep sync nudge — pull fresh physiology then re-render
  document.getElementById('rdn-sleep-sync-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('rdn-sleep-sync-btn') as HTMLButtonElement | null;
    if (btn) { btn.textContent = 'Syncing…'; btn.disabled = true; }
    try {
      const { syncPhysiologySnapshot } = await import('@/data/physiologySync');
      await syncPhysiologySnapshot(7);
    } finally {
      renderReadinessView();
    }
  });
}

// ── Public entry point ────────────────────────────────────────────────────────

export function renderReadinessView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  container.innerHTML = getReadinessHTML(s);
  wireReadinessHandlers();
}
