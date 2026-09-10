/**
 * coach-context-builder.ts
 * ========================
 * Serializes SimulatorState into a structured JSON context for the AI coach.
 * All user-controlled strings are sanitized against prompt injection.
 *
 * Two modes: running and triathlon. Both include recent activity history,
 * readiness signals, current plan workouts, and athlete benchmarks.
 */

import type { SimulatorState } from '@/types/state';
import type { GarminActual } from '@/types/state';
import { computeDailyCoach, buildCoachSignalsPayload } from '@/calculations/daily-coach';
import { computeTriReadiness } from '@/calculations/tri-readiness';
import { generateWeekWorkouts } from '@/workouts';
import { getTrailingEffortScore } from '@/calculations/fitness-model';
import { sanitizeField } from './prompt-sanitizer';

// Max activities to include per week (keeps context bounded)
const MAX_ACTIVITIES_PER_WEEK = 5;
const WEEKS_OF_HISTORY = 4;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPace(secKm: number | null | undefined): string | null {
  if (!secKm || !isFinite(secKm)) return null;
  const m = Math.floor(secKm / 60);
  const s = Math.round(secKm % 60);
  return `${m}:${s.toString().padStart(2, '0')} min/km`;
}

function fmtTime(sec: number | null | undefined): string | null {
  if (!sec || !isFinite(sec)) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function roundTo(n: number | null | undefined, decimals: number): number | null {
  if (n == null || !isFinite(n)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

/** Collect recent activities across the last N weeks, newest first.
 *  Exported for the Strava-exclusion anchor test. */
export function collectRecentActivities(
  wks: SimulatorState['wks'],
  currentWeekIdx: number,
  weeksBack: number,
  maxPerWeek: number,
): ReturnType<typeof formatActivity>[] {
  const results: ReturnType<typeof formatActivity>[] = [];
  const start = Math.max(0, currentWeekIdx - weeksBack + 1);
  for (let i = currentWeekIdx; i >= start; i--) {
    const wk = wks[i];
    if (!wk?.garminActuals) continue;
    // Strava API Agreement §5.3 forbids sending Strava-sourced data to any AI
    // service, even with user consent. Only Garmin/Apple-sourced actuals may
    // reach the coach context. support.html states this publicly.
    const acts = Object.values(wk.garminActuals)
      .filter(a => !a.garminId?.startsWith('strava-'))
      .sort((a, b) => (b.startTime ?? '').localeCompare(a.startTime ?? ''))
      .slice(0, maxPerWeek);
    for (const act of acts) {
      const formatted = formatActivity(act);
      if (formatted) results.push(formatted);
    }
  }
  return results;
}

function formatActivity(act: GarminActual) {
  if (!act.startTime && !act.distanceKm) return null;
  return {
    date: act.startTime?.slice(0, 10) ?? null,
    type: sanitizeField(act.displayName ?? act.activityType, 40),
    matched_workout: sanitizeField(act.workoutName, 50),
    distance_km: roundTo(act.distanceKm, 1),
    duration_min: act.durationSec ? Math.round(act.durationSec / 60) : null,
    avg_pace: fmtPace(act.avgPaceSecKm),
    avg_pace_sec_km: roundTo(act.avgPaceSecKm, 0),
    avg_hr: act.avgHR ? Math.round(act.avgHR) : null,
    hr_drift_pct: roundTo(act.hrDrift, 1),
    hr_effort_score: roundTo(act.hrEffortScore, 2),
    pace_adherence: roundTo(act.paceAdherence, 2),
    elevation_gain_m: act.elevationGainM ? Math.round(act.elevationGainM) : null,
    avg_power_w: act.averageWatts ? Math.round(act.averageWatts) : null,
    normalized_power_w: act.normalizedPowerW ? Math.round(act.normalizedPowerW) : null,
    km_splits: act.kmSplits?.slice(0, 20) ?? null,
  };
}

/** Plan skeleton: every week of the program compressed to a one-line summary
 *  so the coach can see the *shape* of the build, not just this week.
 *  Per-week ~30 tokens × 16 weeks ≈ 500 tokens. */
export function buildPlanSkeleton(state: SimulatorState): Array<Record<string, unknown>> {
  const currentW = state.w;
  return state.wks.map((wk, i) => {
    const weekNum = i + 1;
    const isPast = weekNum < currentW;
    const isCurrent = weekNum === currentW;
    const marker = isCurrent ? 'current' : isPast ? 'past' : 'future';

    // Triathlon AND HYROX both store sessions in wk.triWorkouts. Both should
    // get the structured per-week skeleton. Running falls through to the
    // simpler (phase + actual TSS) shape below.
    if ((state.eventType === 'triathlon' || state.eventType === 'hyrox') && wk.triWorkouts) {
      const tss = wk.triWorkouts.reduce((s, w) => s + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);
      const hours = wk.triWorkouts.reduce((s, w) => s + (w.estimatedDurationMin ?? 0), 0) / 60;
      const swimCount = wk.triWorkouts.filter(w => w.discipline === 'swim').length;
      const bikeCount = wk.triWorkouts.filter(w => w.discipline === 'bike').length;
      const runCount  = wk.triWorkouts.filter(w => (w.discipline ?? 'run') === 'run').length;
      const keyTypes  = [...new Set(wk.triWorkouts
        .filter(w => ['threshold', 'tempo', 'vo2', 'brick', 'long'].some(k => (w.t ?? '').toLowerCase().includes(k)))
        .map(w => sanitizeField(w.t, 20)))].slice(0, 3);
      return {
        week: weekNum, phase: wk.ph ?? null,
        planned_tss: Math.round(tss),
        planned_hours: roundTo(hours, 1),
        sessions: { swim: swimCount, bike: bikeCount, run: runCount },
        key_sessions: keyTypes,
        marker,
      };
    }

    // Running: only phase + week is reliably available without regenerating.
    // Actual TSS for past weeks is on wk.actualTSS. Useful for the coach.
    return {
      week: weekNum,
      phase: wk.ph ?? null,
      actual_tss: typeof wk.actualTSS === 'number' ? Math.round(wk.actualTSS) : null,
      completed_km: typeof wk.completedKm === 'number' ? roundTo(wk.completedKm, 1) : null,
      marker,
    };
  });
}

/** Athlete-stated priorities: what they care about + what's limiting them.
 *  Captured by the one-time 2-click flow in coach-view. Coach uses these to
 *  weight recommendations. Null when the athlete hasn't picked yet. */
function buildPriorities(state: SimulatorState): Record<string, unknown> | null {
  const p = state.coachPriorities;
  if (!p) return null;
  return {
    priority: p.priority,
    constraint: p.constraint,
    set_at: p.setISO.slice(0, 10),
  };
}

/** Memory facts the coach has stored about this athlete across sessions.
 *  Indexed so the `forget` tool can reference fact_index. */
function buildMemoryFacts(state: SimulatorState): Array<{ index: number; text: string; added: string }> {
  const mem = state.coachMemory;
  if (!mem?.facts || mem.facts.length === 0) return [];
  return mem.facts.map((f, i) => ({
    index: i,
    text: sanitizeField(f.text, 200) ?? f.text,
    added: f.addedISO.slice(0, 10),
  }));
}

/** Adaptation log: signals the program has changed over time. */
function buildAdaptationLog(state: SimulatorState): Record<string, unknown> {
  const s = state;
  const out: Record<string, unknown> = {};

  if (s.triConfig?.notifiedMarkers) {
    out.last_notified_markers = {
      ftp_w: s.triConfig.notifiedMarkers.ftp ?? null,
      css_sec_per_100m: s.triConfig.notifiedMarkers.cssSecPer100m ?? null,
      vdot: roundTo(s.triConfig.notifiedMarkers.vdot ?? null, 1),
    };
  }

  if (s.triConfig?.fitnessHistory && s.triConfig.fitnessHistory.length > 0) {
    out.tri_fitness_trend_8w = s.triConfig.fitnessHistory.slice(-8).map(h => ({
      week: h.weekISO,
      swim_ctl: roundTo(h.swimCtl / 7, 1),
      bike_ctl: roundTo(h.bikeCtl / 7, 1),
      run_ctl: roundTo(h.runCtl / 7, 1),
    }));
  }

  if (Array.isArray(s.previousPlanWks)) {
    out.plan_reset_count = s.previousPlanWks.length;
  }

  return out;
}

// ─── Running context ──────────────────────────────────────────────────────────

export function buildRunningCoachContext(state: SimulatorState): object {
  const s = state;
  const wkIdx = s.w - 1;
  const wk = s.wks[wkIdx];
  const coach = computeDailyCoach(s);
  const sig = coach.signals;
  const payload = buildCoachSignalsPayload(coach, s);

  // AI modifications applied this week (so the coach sees its own past calls
  // rather than re-proposing the same change). Workout-engine auto-reductions
  // are filtered out. Those aren't ours.
  const aiModifications = (wk?.workoutMods ?? [])
    .filter(m => !!m.aiModifiedAt)
    .map(m => ({
      workout_name: sanitizeField(m.name, 60),
      status: m.status,
      reason: sanitizeField(m.modReason, 120),
      note: sanitizeField(m.autoReduceNote ?? '', 100),
      zone_cap: m.zoneCap ?? null,
      applied_at: (m.aiModifiedAt ?? '').slice(0, 10),
    }));

  // This week's running workouts (same call as plan-view.ts:1626)
  const thisWeekWorkouts = wk ? generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    s.injuryState, s.recurringActivities, s.onboarding?.experienceLevel,
    undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
    getTrailingEffortScore(s.wks, wkIdx), wk.scheduledAcwrStatus,
  ).map((w, _i, arr) => {
    const dayKey = (w.dayName ?? '').toLowerCase();
    const dayIdx = arr.filter(x => (x.dayName ?? '').toLowerCase() === dayKey).indexOf(w);
    return {
      name: sanitizeField(w.n, 60),
      type: sanitizeField(w.t, 30),
      description: sanitizeField(w.d, 100),
      day: w.dayName ?? null,
      workout_index: dayIdx,
      target_pace: fmtPace(w.targetPaceSecKm ?? s.pac?.e),
      est_duration_min: w.estimatedDurationMin ?? null,
      rpe: w.r ?? null,
      status: w.status ?? 'planned',
    };
  }) : [];

  // Paces
  const paces = s.pac ? {
    easy: fmtPace(s.pac.e),
    marathon: fmtPace(s.pac.m),
    threshold: fmtPace(s.pac.t),
    vo2max: fmtPace(s.pac.i),
  } : null;

  // PBs
  const pbs: Record<string, string | null> = {};
  if (s.pbs?.k5) pbs['5k'] = fmtTime(s.pbs.k5);
  if (s.pbs?.k10) pbs['10k'] = fmtTime(s.pbs.k10);
  if (s.pbs?.h) pbs['half'] = fmtTime(s.pbs.h);
  if (s.pbs?.m) pbs['marathon'] = fmtTime(s.pbs.m);

  return {
    mode: 'running',
    today: new Date().toISOString().slice(0, 10),
    athlete: {
      vdot: roundTo(s.v, 1),
      lt_pace: fmtPace(s.lt),
      lt_confidence: s.ltConfidence ?? null,
      vo2max: roundTo(s.vo2, 1),
      race: s.rd,
      goal_time: s.forecastTime ? fmtTime(s.forecastTime) : null,
      current_fitness_time: s.currentFitness ? fmtTime(s.currentFitness) : null,
      tier: s.athleteTier ?? null,
      runner_type: s.typ,
      pbs,
      paces,
      week: s.w,
      total_weeks: s.tw,
      phase: sig.phase,
      weeks_to_race: s.tw - s.w,
    },
    readiness: {
      score: sig.readinessScore,
      label: sig.readinessLabel,
      stance: coach.stance,
      primary_message: sanitizeField(coach.primaryMessage, 280),
      tsb_daily: roundTo(sig.tsb, 1),
      tsb_zone: sig.tsbZone,
      acwr: roundTo(sig.acwr, 2),
      acwr_status: sig.acwrStatus,
      hrv_ms: sig.hrv,
      hrv_pct_vs_baseline: sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0
        ? Math.round(((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline) * 100) : null,
      sleep_last_night: sig.sleepLastNight,
      sleep_7d_avg: sig.sleepAvg7d,
      sleep_debt_hours: sig.sleepBankHours,
      today_feeling: payload.todayFeeling,
      blockers: coach.blockers,
    },
    fitness_trend: {
      tss_8_weeks: s.historicWeeklyTSS?.slice(-8) ?? [],
      km_8_weeks: s.historicWeeklyKm?.slice(-8) ?? [],
      ctl_daily_equiv: roundTo(sig.ctlNow, 1),
      ctl_trend: sig.ctlTrend,
      week_tss: sig.weekTSS,
      planned_week_tss: sig.plannedTSS,
      week_tss_pct: payload.weekTssPct,
      rpe_signal: sig.weekRPE,
      hr_drift_signal: sig.hrDrift,
    },
    priorities: buildPriorities(s),
    memory_facts: buildMemoryFacts(s),
    ai_modifications: aiModifications,
    injury: payload.injury,
    illness: payload.illness,
    this_week_plan: thisWeekWorkouts,
    plan_skeleton: buildPlanSkeleton(s),
    adaptation_log: buildAdaptationLog(s),
    recent_activities: collectRecentActivities(
      s.wks, wkIdx, WEEKS_OF_HISTORY, MAX_ACTIVITIES_PER_WEEK,
    ),
  };
}

// ─── Triathlon context ────────────────────────────────────────────────────────

export function buildTriathlonCoachContext(state: SimulatorState): object {
  const s = state;
  const tc = s.triConfig;
  if (!tc) return buildRunningCoachContext(state); // fallback

  const wkIdx = s.w - 1;
  const wk = s.wks[wkIdx];
  const coach = computeDailyCoach(s);
  const sig = coach.signals;
  const payload = buildCoachSignalsPayload(coach, s);
  const triReadiness = computeTriReadiness(s);

  // This week's tri workouts. Include a per-day index so the LLM can pass it
  // to tool calls (validateAndBuildPendingChange filters by day then indexes).
  const triDayCounter: Record<string, number> = {};
  const thisWeekWorkouts = (wk?.triWorkouts ?? []).map(w => {
    const dayKey = (w.dayName ?? '').toLowerCase();
    const idx = triDayCounter[dayKey] ?? 0;
    triDayCounter[dayKey] = idx + 1;
    return {
      name: sanitizeField(w.n, 60),
      type: sanitizeField(w.t, 30),
      discipline: w.discipline ?? 'run',
      description: sanitizeField(w.d, 100),
      day: w.dayName ?? null,
      workout_index: idx,
      est_duration_min: w.estimatedDurationMin ?? null,
      rpe: w.r ?? null,
      status: w.status ?? 'planned',
      ai_modified: !!w.aiModifiedAt,
      mod_reason: w.modReason ? sanitizeField(w.modReason, 120) : null,
    };
  });

  // Per-discipline fitness (daily-equiv for readability)
  const fit = tc.fitness;
  const disciplines = fit ? {
    swim: {
      ctl: roundTo(fit.swim.ctl / 7, 1),
      atl: roundTo(fit.swim.atl / 7, 1),
      tsb: roundTo(fit.swim.tsb / 7, 1),
      readiness: triReadiness?.swim.label ?? null,
    },
    bike: {
      ctl: roundTo(fit.bike.ctl / 7, 1),
      atl: roundTo(fit.bike.atl / 7, 1),
      tsb: roundTo(fit.bike.tsb / 7, 1),
      readiness: triReadiness?.bike.label ?? null,
    },
    run: {
      ctl: roundTo(fit.run.ctl / 7, 1),
      atl: roundTo(fit.run.atl / 7, 1),
      tsb: roundTo(fit.run.tsb / 7, 1),
      readiness: triReadiness?.run.label ?? null,
    },
    combined_ctl: roundTo(fit.combinedCtl / 7, 1),
    overall_readiness: triReadiness?.overall ?? null,
    binding_signal: triReadiness?.sentence ?? null,
  } : null;

  // Fitness history (last 8 weeks)
  const fitnessHistory = (tc.fitnessHistory ?? []).slice(-8).map(h => ({
    week: h.weekISO,
    swim_ctl: roundTo(h.swimCtl / 7, 1),
    bike_ctl: roundTo(h.bikeCtl / 7, 1),
    run_ctl: roundTo(h.runCtl / 7, 1),
  }));

  // Prediction
  const pred = tc.prediction;
  const prediction = pred ? {
    total: fmtTime(pred.totalSec),
    swim: fmtTime(pred.swimSec),
    t1: fmtTime(pred.t1Sec),
    bike: fmtTime(pred.bikeSec),
    t2: fmtTime(pred.t2Sec),
    run: fmtTime(pred.runSec),
    confidence_range: pred.totalRangeSec
      ? [fmtTime(pred.totalRangeSec[0]), fmtTime(pred.totalRangeSec[1])]
      : null,
    current_fitness_total: fmtTime(pred.currentTotalSec),
    limiting_factor: pred.limitingFactor ?? null,
    adaptation: pred.adaptation ? {
      swim: roundTo(pred.adaptation.swim, 2),
      bike: roundTo(pred.adaptation.bike, 2),
      run: roundTo(pred.adaptation.run, 2),
    } : null,
  } : null;

  return {
    mode: 'triathlon',
    today: new Date().toISOString().slice(0, 10),
    athlete: {
      race_distance: tc.distance,
      race_date: tc.raceDate ?? null,
      weeks_to_race: tc.weeksToRace,
      week: s.w,
      total_weeks: s.tw,
      phase: sig.phase,
      tier: s.athleteTier ?? null,
      hours_per_week: tc.timeAvailableHoursPerWeek ?? null,
      skill_ratings: tc.skillRating ?? null,
      volume_split: tc.volumeSplit ?? null,
    },
    benchmarks: {
      swim: {
        css_sec_per_100m: tc.swim?.cssSecPer100m ?? null,
        css_display: tc.swim?.cssSecPer100m
          ? `${Math.floor(tc.swim.cssSecPer100m / 60)}:${Math.round(tc.swim.cssSecPer100m % 60).toString().padStart(2, '0')} /100m`
          : null,
        confidence: tc.swim?.cssConfidence ?? null,
        source: tc.swim?.cssSource ?? null,
      },
      bike: {
        ftp_watts: tc.bike?.ftp ?? null,
        ftp_confidence: tc.bike?.ftpConfidence ?? null,
        ftp_source: tc.bike?.ftpSource ?? null,
        lthr: tc.bike?.lthr ?? null,
        has_power_meter: tc.bike?.hasPowerMeter ?? null,
      },
      run: {
        vdot: roundTo(s.v, 1),
        lt_pace: fmtPace(s.lt),
        lt_confidence: s.ltConfidence ?? null,
      },
    },
    disciplines,
    fitness_history_8w: fitnessHistory,
    race_prediction: prediction,
    readiness: {
      score: sig.readinessScore,
      label: sig.readinessLabel,
      stance: coach.stance,
      primary_message: sanitizeField(coach.primaryMessage, 280),
      tsb_daily: roundTo(sig.tsb, 1),
      acwr: roundTo(sig.acwr, 2),
      acwr_status: sig.acwrStatus,
      hrv_ms: sig.hrv,
      hrv_pct_vs_baseline: sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0
        ? Math.round(((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline) * 100) : null,
      sleep_last_night: sig.sleepLastNight,
      sleep_7d_avg: sig.sleepAvg7d,
      sleep_debt_hours: sig.sleepBankHours,
      today_feeling: payload.todayFeeling,
      blockers: coach.blockers,
    },
    fitness_trend: {
      tss_8_weeks: s.historicWeeklyRawTSS?.slice(-8) ?? [],
      week_tss: sig.weekTSS,
      planned_week_tss: sig.plannedTSS,
      week_tss_pct: payload.weekTssPct,
    },
    priorities: buildPriorities(s),
    memory_facts: buildMemoryFacts(s),
    injury: payload.injury,
    illness: payload.illness,
    this_week_plan: thisWeekWorkouts,
    plan_skeleton: buildPlanSkeleton(s),
    adaptation_log: buildAdaptationLog(s),
    recent_activities: collectRecentActivities(
      s.wks, wkIdx, WEEKS_OF_HISTORY, MAX_ACTIVITIES_PER_WEEK,
    ),
  };
}

/** Returns the appropriate context builder based on current mode.
 *  Triathlon and HYROX both use the structured-workout builder because both
 *  store sessions in `wk.triWorkouts`; running uses the regenerator builder.
 *
 *  Wraps the per-mode builders with a token-budget guard. If the JSON payload
 *  would exceed ~10K input tokens (~40K chars at 4 chars/token), we trim the
 *  least-essential blocks (adaptation_log + non-adjacent plan_skeleton weeks)
 *  before returning. The aim is to stay under the Anthropic input ceiling and
 *  keep per-call cost bounded. */
export function buildCoachContext(state: SimulatorState): object {
  const raw = state.eventType === 'triathlon'
    ? buildTriathlonCoachContext(state)
    : state.eventType === 'hyrox'
      ? buildHyroxCoachContext(state)
      : buildRunningCoachContext(state);
  return applyTokenBudget(raw, state.w);
}

/** Chars-per-token estimate (Anthropic Haiku: roughly 4 chars/token for English). */
const APPROX_CHARS_PER_TOKEN = 4;
/** Soft cap: warn + truncate above this. */
const TOKEN_BUDGET_CHARS = 10_000 * APPROX_CHARS_PER_TOKEN;

/** Trim large optional blocks if the payload approaches the token budget.
 *  Order of trimming (least to most essential):
 *    1. adaptation_log
 *    2. plan_skeleton weeks far from current (keep current ± 2)
 *    3. recent_activities (drop oldest first)
 *  Bails early if any pass brings the payload under budget. */
function applyTokenBudget(ctx: any, currentWeek: number): object {
  const sizeOf = (o: any) => JSON.stringify(o).length;
  if (sizeOf(ctx) <= TOKEN_BUDGET_CHARS) return ctx;

  console.warn(`[coach-context] Token budget exceeded (${sizeOf(ctx)} chars). Trimming.`);

  // 1. Drop adaptation_log
  if (ctx.adaptation_log && Object.keys(ctx.adaptation_log).length > 0) {
    ctx = { ...ctx, adaptation_log: {} };
    if (sizeOf(ctx) <= TOKEN_BUDGET_CHARS) return ctx;
  }

  // 2. Trim plan_skeleton to current ± 2 weeks
  if (Array.isArray(ctx.plan_skeleton) && ctx.plan_skeleton.length > 5) {
    const trimmed = ctx.plan_skeleton.filter((w: any) =>
      typeof w.week === 'number' && Math.abs(w.week - currentWeek) <= 2,
    );
    ctx = { ...ctx, plan_skeleton: trimmed };
    if (sizeOf(ctx) <= TOKEN_BUDGET_CHARS) return ctx;
  }

  // 3. Drop oldest recent_activities one at a time
  if (Array.isArray(ctx.recent_activities) && ctx.recent_activities.length > 5) {
    let acts = [...ctx.recent_activities];
    while (acts.length > 5 && sizeOf({ ...ctx, recent_activities: acts }) > TOKEN_BUDGET_CHARS) {
      acts = acts.slice(0, -1); // drop oldest (sorted newest-first)
    }
    ctx = { ...ctx, recent_activities: acts };
  }

  console.warn(`[coach-context] After trim: ${sizeOf(ctx)} chars.`);
  return ctx;
}

/** HYROX context: mirrors the triathlon shape so the coach has workouts to
 *  reason about, but reads from `hyroxConfig` rather than `triConfig`. */
export function buildHyroxCoachContext(state: SimulatorState): object {
  const s = state;
  const hc = s.hyroxConfig;
  const wkIdx = s.w - 1;
  const wk = s.wks[wkIdx];
  const coach = computeDailyCoach(s);
  const sig = coach.signals;
  const payload = buildCoachSignalsPayload(coach, s);

  const hyroxDayCounter: Record<string, number> = {};
  const thisWeekWorkouts = (wk?.triWorkouts ?? []).map(w => {
    const dayKey = (w.dayName ?? '').toLowerCase();
    const idx = hyroxDayCounter[dayKey] ?? 0;
    hyroxDayCounter[dayKey] = idx + 1;
    return {
      name: sanitizeField(w.n, 60),
      type: sanitizeField(w.t, 30),
      discipline: w.discipline ?? 'run',
      description: sanitizeField(w.d, 120),
      day: w.dayName ?? null,
      workout_index: idx,
      est_duration_min: w.estimatedDurationMin ?? null,
      rpe: w.r ?? null,
      musculo_tendon_load: w.musculoTendonLoad ?? null,
      status: w.status ?? 'planned',
    };
  });

  return {
    mode: 'hyrox',
    today: new Date().toISOString().slice(0, 10),
    athlete: {
      race_date: hc?.raceDate ?? null,
      week: s.w,
      total_weeks: s.tw,
      phase: sig.phase,
      tier: s.athleteTier ?? null,
    },
    readiness: {
      score: sig.readinessScore,
      label: sig.readinessLabel,
      stance: coach.stance,
      primary_message: sanitizeField(coach.primaryMessage, 280),
      tsb_daily: roundTo(sig.tsb, 1),
      acwr: roundTo(sig.acwr, 2),
      acwr_status: sig.acwrStatus,
      hrv_ms: sig.hrv,
      hrv_pct_vs_baseline: sig.hrv != null && sig.hrvBaseline != null && sig.hrvBaseline > 0
        ? Math.round(((sig.hrv - sig.hrvBaseline) / sig.hrvBaseline) * 100) : null,
      sleep_last_night: sig.sleepLastNight,
      sleep_7d_avg: sig.sleepAvg7d,
      sleep_debt_hours: sig.sleepBankHours,
      today_feeling: payload.todayFeeling,
      blockers: coach.blockers,
    },
    fitness_trend: {
      tss_8_weeks: s.historicWeeklyTSS?.slice(-8) ?? [],
      week_tss: sig.weekTSS,
      planned_week_tss: sig.plannedTSS,
      week_tss_pct: payload.weekTssPct,
    },
    priorities: buildPriorities(s),
    memory_facts: buildMemoryFacts(s),
    injury: payload.injury,
    illness: payload.illness,
    this_week_plan: thisWeekWorkouts,
    plan_skeleton: buildPlanSkeleton(s),
    adaptation_log: buildAdaptationLog(s),
    recent_activities: collectRecentActivities(
      s.wks, wkIdx, WEEKS_OF_HISTORY, MAX_ACTIVITIES_PER_WEEK,
    ),
  };
}
