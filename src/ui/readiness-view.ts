/**
 * Readiness detail page — composite training readiness breakdown.
 * Shows Freshness (TSB), Load Ratio (ACWR), and Recovery sub-signals.
 * Opens from the Readiness ring on the Home view.
 * Copies the sky-gradient design language from recovery-view.
 */

import { getState } from '@/state';
import type { SimulatorState } from '@/types/state';
import {
  computeACWR,
  computeSameSignalTSB,
  computeFitnessModel,
  computeTodaySignalBTSS,
  computePlannedDaySignalBTSS,
  estimateWorkoutDurMin,
  getTrailingEffortScore,
  computeToBaseline,
  REST_DAY_OVERREACH_RATIO,
} from '@/calculations/fitness-model';
import {
  computeReadiness,
  readinessColor,
  computeRecoveryScore,
} from '@/calculations/readiness';
import { getSleepBank, deriveSleepTarget, computeSleepDebt, buildDailySignalBTSS } from '@/calculations/sleep-insights';
import { generateWeekWorkouts } from '@/workouts';
import { TL_PER_MIN } from '@/constants';
import { computeDailyCoach } from '@/calculations/daily-coach';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';

// ── Design tokens ─────────────────────────────────────────────────────────────

const APP_BG = '#FAF9F6';
const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const RING_R = 46;
const RING_C = +(2 * Math.PI * RING_R).toFixed(2);

// ── Sky background (same visual language as recovery-view) ────────────────────
// Gradient IDs are prefixed "rdn" to avoid conflicts when both views exist in DOM

function skyBackground(): string { return buildSkyBackground('rdn', 'blue'); }

// ── Explanatory copy ──────────────────────────────────────────────────────────

function freshnessExplanation(tsb: number): string {
  // Thresholds on daily-equivalent (tsb already in weekly units, ÷7 for display)
  const d = Math.round(tsb / 7);
  if (d > 5)     return 'Fatigue has cleared faster than fitness has decayed. Good window for a hard session or race.';
  if (d > 0)     return 'Slightly fresh. Normal training as planned.';
  if (d >= -3)   return 'Mild fatigue from recent training. Training as planned.';
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
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, s.signalBBaseline ?? undefined);
  // Use completed weeks for TSB seed, then apply intra-week decay to get live value
  const completedWeek = Math.max(0, s.w - 1);
  const sameSignal = computeSameSignalTSB(s.wks ?? [], completedWeek, s.signalBBaseline ?? s.ctlBaseline ?? 0, s.planStartDate);
  const atlWeekEnd = sameSignal?.atl ?? 0;
  const ctlWeekEnd = sameSignal?.ctl ?? 0;

  // Intra-week decay: daily ATL/CTL decay from end of completed week to today,
  // incorporating current-week load. Matches freshness-view logic.
  const ATL_DAILY_DECAY = Math.exp(-1 / 7);
  const CTL_DAILY_DECAY = Math.exp(-1 / 42);
  let atlLive = atlWeekEnd;
  let ctlLive = ctlWeekEnd;
  if (s.planStartDate) {
    const weekStartDate = new Date(s.planStartDate + 'T12:00:00');
    weekStartDate.setDate(weekStartDate.getDate() + completedWeek * 7);
    const todayDate = new Date();
    todayDate.setHours(12, 0, 0, 0);
    const daysIntoWeek = Math.max(0, Math.round((todayDate.getTime() - weekStartDate.getTime()) / 86400000));
    const currentWk = (s.wks ?? [])[completedWeek];
    for (let d = 0; d < daysIntoWeek; d++) {
      const dayD = new Date(weekStartDate);
      dayD.setDate(dayD.getDate() + d);
      const dayDate = dayD.toISOString().split('T')[0];
      const dayTSS = currentWk ? computeTodaySignalBTSS(currentWk, dayDate) : 0;
      const weekEquiv = dayTSS * 7;
      atlLive = atlLive * ATL_DAILY_DECAY + weekEquiv * (1 - ATL_DAILY_DECAY);
      ctlLive = ctlLive * CTL_DAILY_DECAY + weekEquiv * (1 - CTL_DAILY_DECAY);
    }
  }
  const tsb = ctlLive - atlLive;
  const ctlNow = ctlLive;
  const metrics = computeFitnessModel(s.wks ?? [], completedWeek, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);

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
  const todaySignalBTSS = strainWk ? computeTodaySignalBTSS(strainWk, today) : 0;
  const todayDayOfWeek = (new Date(today + 'T12:00:00').getDay() + 6) % 7;
  const plannedWorkouts = strainWk ? generateWeekWorkouts(
    strainWk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e,
    s.w, s.tw, s.v, s.gs, getTrailingEffortScore(s.wks, s.w), strainWk.scheduledAcwrStatus,
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

  const readiness = computeReadiness({
    tsb,
    acwr: acwr.ratio,
    ctlNow,
    sleepScore,
    hrvRmssd,
    sleepHistory: s.physiologyHistory ?? [],
    hrvPersonalAvg,
    sleepBankSec: sleepBank.nightsWithData >= 3 ? sleepBank.bankSec : null,
    weeksOfHistory: metrics.length,
    strainPct: todaySignalBTSS > 0 ? strainPct : null,
    recentLegLoads: s.recentLegLoads ?? [],
    precomputedRecoveryScore: recoveryResult.hasData ? recoveryResult.score : null,
    acwrSafeUpper: acwr.safeUpper,
  });

  // Use the central daily-coach for the sentence (auto-derives strain context)
  const coachMessage = computeDailyCoach(s).primaryMessage;
  const activeStrainPct = todaySignalBTSS > 0 ? strainPct : 0;

  const ringColor = readinessColor(readiness.label);
  const score = readiness.score;
  const targetOffset = +(RING_C * (1 - score / 100)).toFixed(2);

  // ── Freshness sub-signal ───────────────────────────────────────────────────
  const tsbDisp = Math.round(tsb / 7);
  const tsbLabel = tsbDisp > 0 ? `+${tsbDisp}` : `${tsbDisp}`;
  // Zone thresholds on daily-equivalent TSB (Coggan/TrainingPeaks standard)
  const tsbZone = tsbDisp > 0 ? 'Fresh' : tsbDisp >= -3 ? 'Recovering' : tsbDisp >= -8 ? 'Fatigued' : tsbDisp >= -15 ? 'Heavy' : tsbDisp >= -25 ? 'Overloaded' : 'Overreaching';
  const tsbColor = tsbDisp > 0 ? 'var(--c-ok)' : tsbDisp >= -3 ? 'var(--c-accent)' : tsbDisp >= -15 ? 'var(--c-caution)' : 'var(--c-warn)';

  // ── To Baseline — stacked session recovery ──────────────────────────────────
  // Same model as freshness page: all recent sessions stacked, sport-adjusted,
  // sleep/HRV-adjusted. See computeToBaseline() in fitness-model.ts.
  const ctlForBaseline = (sameSignal?.ctl ?? 0) / 7;
  const baselineResult = computeToBaseline(s.wks ?? [], completedWeek, ctlForBaseline, s.planStartDate, s.physiologyHistory);
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
  let strainLabel: string;
  let strainColor: string;
  if (isRestDay) {
    strainLabel = isRestDayOverreaching ? 'Overreaching' : (todaySignalBTSS > 0 ? 'Active rest' : 'Rest day');
    strainColor = isRestDayOverreaching ? 'var(--c-warn)' : (todaySignalBTSS > 0 ? 'var(--c-ok)' : TEXT_S);
  } else if (matchedActivityToday && !hasPlannedWorkout) {
    // Adhoc activity on a non-planned day — match home-view logic
    strainLabel = adhocPct >= 150 ? 'High' : adhocPct >= 80 ? 'Optimal' : adhocPct >= 50 ? 'Moderate' : 'Light';
    strainColor = adhocPct >= 150 ? 'var(--c-warn)' : adhocPct >= 80 ? 'var(--c-ok)' : TEXT_S;
  } else {
    strainLabel = activeStrainPct >= 130 ? 'Exceeded'
      : activeStrainPct >= 100 ? 'Complete'
      : activeStrainPct >= 50 ? 'In Progress'
      : activeStrainPct > 0 ? 'Starting'
      : 'No Activity';
    strainColor = activeStrainPct >= 130 ? 'var(--c-warn)'
      : activeStrainPct >= 100 ? 'var(--c-ok)'
      : activeStrainPct >= 50 ? 'var(--c-caution)'
      : TEXT_S;
  }

  // ── Card builder ───────────────────────────────────────────────────────────
  const card = (content: string, id?: string, extraStyle?: string) =>
    `<div ${id ? `id="${id}"` : ''} style="background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);margin-bottom:12px;cursor:pointer;${extraStyle ?? ''}">${content}</div>`;

  // Adhoc activity on a non-planned day: show TSS + adhocPct label (no plan to compare %)
  const isAdhoc = matchedActivityToday && !hasPlannedWorkout;
  const strainCard = todaySignalBTSS > 0 ? card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Today's Strain</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      ${isRestDay || isAdhoc
        ? `<div style="font-size:24px;font-weight:600;color:${strainColor};line-height:1">${Math.round(todaySignalBTSS)} TSS</div>
           <div style="font-size:13px;color:#94A3B8">${strainLabel}</div>`
        : `<div style="font-size:24px;font-weight:600;color:${strainColor};line-height:1">${Math.round(activeStrainPct)}%</div>
           <div style="font-size:13px;color:#94A3B8">${strainLabel}</div>`
      }
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${
      isRestDayOverreaching ? 'High load on a rest day. This level of activity impairs recovery rather than aiding it.'
      : isRestDay ? 'Light activity on a rest day. No significant effect on recovery.'
      : isAdhoc ? `${Math.round(todaySignalBTSS)} TSS from unplanned activity. Readiness adjusted accordingly.`
      : activeStrainPct >= 130 ? 'Daily load well exceeded target. Additional training raises injury risk. Readiness capped.'
      : activeStrainPct >= 100 ? 'Daily target reached. Session complete. Readiness reduced accordingly.'
      : activeStrainPct >= 50 ? 'Session in progress. Readiness adjusts downward as load accumulates.'
      : 'Light activity logged. No significant effect on readiness yet.'
    }</div>
  `, 'rdn-card-strain') : '';

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
    buildDailySignalBTSS(s.wks ?? []),
    s.athleteTier ?? 'recreational',
    effectiveSleepTarget,
  );
  const debtHours = cumulativeDebtSec > 0 ? Math.round(cumulativeDebtSec / 3600 * 10) / 10 : 0;
  const sleepHistCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Sleep History</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
      <div style="font-size:32px;font-weight:300;letter-spacing:-0.04em;color:${sleepHistColor};line-height:1">${sleepHistScore != null ? sleepHistScore : '—'}</div>
      ${sleepHistAvg != null ? `<div style="font-size:14px;color:${TEXT_S}">14d avg ${sleepHistAvg}${debtHours > 0 ? `, ${debtHours}h debt` : ''}</div>` : ''}
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.45;margin-top:8px">${
      sleepHistScore == null
        ? 'Not enough sleep data yet. Needs at least 3 nights in the last 14 days.'
        : debtHours >= 2 && sleepHistScore < 65
          ? `Cumulative sleep debt of ${debtHours}h is impairing recovery. Duration deficit compounds even when individual night scores appear adequate.`
          : debtHours >= 2
            ? `Sleep quality scores are reasonable but ${debtHours}h of cumulative duration debt is accumulating. Prioritise sleep duration.`
            : sleepHistScore >= 75
              ? 'Sleep trend is consistent. No recovery concern from chronic sleep.'
              : sleepHistScore >= 55
                ? 'Sleep trend is slightly depressed. Minor effect on recovery capacity.'
                : 'Sleep trend is poor. Cumulative sleep restriction impairs recovery and adaptation.'
    }</div>
  `, 'rdn-card-sleep-history');

  return `
    <style>
      #rdn-view { box-sizing:border-box; }
      #rdn-view *, #rdn-view *::before, #rdn-view *::after { box-sizing:inherit; }
      @keyframes rdnFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .rdn-fade { opacity:0; animation:rdnFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('rdn')}
    </style>

    <div id="rdn-view" data-readiness-label="${readiness.label}" style="
      position:relative;min-height:100vh;background:${APP_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${skyBackground()}

      <div style="position:relative;z-index:10;padding-bottom:48px">

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
              <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="8"/>
              <circle id="rdn-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="${ringColor}" stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_C}"
                stroke-dashoffset="${RING_C}"
                data-target-offset="${targetOffset}"
                style="transition:stroke-dashoffset 1.2s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
              />
            </svg>
            <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1;color:${ringColor}">${score}</div>
              <div style="font-size:12px;font-weight:600;color:${TEXT_M};margin-top:4px">${readiness.label}</div>
            </div>
          </div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:16px;text-align:center;padding:0 32px;line-height:1.45">${coachMessage}</div>
          ${readiness.hardFloor === 'acwr' ? `<div style="margin-top:12px;padding:8px 16px;border-radius:12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.15)">
            <div style="font-size:12px;color:var(--c-warn);font-weight:600;line-height:1.45">Load ratio (${acwrRatioStr}) is the primary constraint. 7-day load ${acwr.status === 'high' ? 'significantly exceeds' : 'exceeds'} 28-day average.</div>
          </div>` : ''}
        </div>

        <!-- Sub-signal cards -->
        <div class="rdn-fade" style="animation-delay:0.18s;padding:0 16px">
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
        </div>

      </div>
    </div>
    ${renderTabBar('home')}
  `;
}

// ── Navigation ───────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./plan-view').then(m => m.renderPlanView());
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
    import('./recovery-view').then(({ renderRecoveryView }) => renderRecoveryView());
  });

  document.getElementById('rdn-card-freshness')?.addEventListener('click', () => {
    import('./freshness-view').then(({ renderFreshnessView }) => renderFreshnessView());
  });

  document.getElementById('rdn-card-injury')?.addEventListener('click', () => {
    import('./injury-risk-view').then(({ renderInjuryRiskView }) => renderInjuryRiskView());
  });

  document.getElementById('rdn-card-strain')?.addEventListener('click', () => {
    const label = document.getElementById('rdn-view')?.dataset.readinessLabel ?? null;
    import('./strain-view').then(({ renderStrainView }) => renderStrainView(undefined, label as any));
  });

  document.getElementById('rdn-card-rolling-load')?.addEventListener('click', () => {
    import('./rolling-load-view').then(({ renderRollingLoadView }) => renderRollingLoadView());
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
