/**
 * Home tab — the app landing screen.
 * Shows this-week progress, injury risk, today's workout, race countdown, recent activity.
 */

import { getState } from '@/state';
import type { SimulatorState } from '@/types';
import type { Week } from '@/types/state';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';
import { computeWeekTSS, computeWeekRawTSS, computeACWR, computeFitnessModel, computeSameSignalTSB, getWeeklyExcess, computePlannedWeekTSS, computePlannedSignalB, getTrailingEffortScore } from '@/calculations/fitness-model';
import { computeReadiness, readinessColor, computeRecoveryScore, type ReadinessResult } from '@/calculations/readiness';
import { getSleepInsight, fmtSleepDuration, sleepScoreColor, sleepScoreLabel, getSleepContext, buildBarChart } from '@/calculations/sleep-insights';
import type { PhysiologyDayEntry } from '@/types/state';
import { generateWeekWorkouts } from '@/workouts';
import { isInjuryActive } from './injury/modal';
import { formatKm, fmtDateUK, fmtDesc } from '@/utils/format';
import { next, setOnWeekAdvance } from './events';
import { TL_PER_MIN } from '@/constants';
import { normalizeSport } from '@/cross-training/activities';

// ─── Navigation ────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'plan') {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'record') {
    import('./record-view').then(({ renderRecordView }) => renderRecordView());
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderStatsView }) => renderStatsView());
  } else if (tab === 'account') {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

// ─── Data helpers ───────────────────────────────────────────────────────────

/** JS getDay() → Mon-0 … Sun-6 */
function jsToOurDay(jsDay: number): number {
  return jsDay === 0 ? 6 : jsDay - 1;
}

/** Days remaining until an ISO date string */
function daysUntil(isoDate: string): number {
  const race = new Date(isoDate);
  const now = new Date();
  race.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((race.getTime() - now.getTime()) / 86400000));
}

/** Day-of-week short label: Mon, Tue … */
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function todayLabel(): string {
  const ourDay = jsToOurDay(new Date().getDay());
  return DAY_LABELS[ourDay];
}

/** Format ISO date as "Mon 17 Feb" */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const NON_RUN_KW = ['cross', 'gym', 'strength', 'rest', 'yoga', 'swim', 'bike', 'cycl',
  'tennis', 'hiit', 'pilates', 'row', 'hik', 'elliptic', 'walk'];
const isRunKey = (k: string) => !NON_RUN_KW.some(kw => k.toLowerCase().includes(kw));

// ─── Section builders ───────────────────────────────────────────────────────

// ─── Load Breakdown Sheet ───────────────────────────────────────────────────

interface LoadSegment {
  label: string;
  tss: number;
  durationMin: number;
  color: string;
}

function sportColor(sport: string): string {
  const s = normalizeSport(sport);
  const map: Record<string, string> = {
    cycling: '#10b981',
    strength: '#f97316',
    padel: '#8b5cf6',
    tennis: '#7c3aed',
    swimming: '#06b6d4',
    hiking: '#84cc16',
    skiing: '#60a5fa',
    rowing: '#14b8a6',
    yoga: '#f472b6',
    boxing: '#ef4444',
    crossfit: '#ef4444',
    martial_arts: '#ef4444',
    walking: '#a3a3a3',
    extra_run: '#3b82f6',
  };
  return map[s] ?? '#6b7280';
}

function normalizeiTrimpLocal(itrimp: number): number {
  return (itrimp * 100) / 15000;
}

function parseDurMinLocal(d: string): number {
  const m = d.match(/(\d+)min/);
  return m ? parseInt(m[1]) : 30;
}

/**
 * Compute a per-sport breakdown of Signal B TSS for the current week.
 * Mirrors computeWeekRawTSS exactly (same dedup, same formulas) but groups by label.
 */
function computeLoadBreakdown(
  wk: Week,
  ratedMap: Record<string, number | 'skip'>,
  planStartDate?: string,
): LoadSegment[] {
  const segments = new Map<string, LoadSegment>();
  const seenGarminIds = new Set<string>();

  function add(label: string, tss: number, durationMin: number, color: string) {
    const existing = segments.get(label);
    if (existing) {
      existing.tss += tss;
      existing.durationMin += durationMin;
    } else {
      segments.set(label, { label, tss, durationMin, color });
    }
  }

  // Matched activities (garminActuals) — primarily runs
  for (const [workoutId, actual] of Object.entries(wk.garminActuals ?? {})) {
    if (actual.garminId) {
      if (seenGarminIds.has(actual.garminId)) continue;
      seenGarminIds.add(actual.garminId);
    }
    const ratedVal = ratedMap[workoutId];
    const rpe = (typeof ratedVal === 'number') ? ratedVal : 5;
    let tss: number;
    let durationMin: number;
    if (actual.iTrimp != null && actual.iTrimp > 0) {
      tss = normalizeiTrimpLocal(actual.iTrimp);
      durationMin = actual.durationSec / 60;
    } else {
      durationMin = actual.durationSec > 0 ? actual.durationSec / 60 : actual.distanceKm * 6;
      tss = durationMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
    }
    // Label: use displayName for cross-training slots, else "Running"
    const label = (actual.displayName && !actual.workoutName) ? actual.displayName : 'Running';
    const color = label === 'Running' ? '#3b82f6' : sportColor(label.toLowerCase());
    add(label, tss, durationMin, color);
  }

  // Adhoc workouts — all types, no runSpec discount for Signal B
  for (const w of wk.adhocWorkouts ?? []) {
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
    }
    let tss: number;
    let durationMin: number;
    if (w.iTrimp != null && w.iTrimp > 0) {
      tss = (w.iTrimp * 100) / 15000;
      durationMin = parseDurMinLocal(w.d);
    } else {
      const rpe = w.rpe ?? w.r ?? 5;
      durationMin = parseDurMinLocal(w.d);
      tss = durationMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
    }
    const sport = normalizeSport(w.n.replace(' (Garmin)', '').toLowerCase());
    const label = w.n.replace(' (Garmin)', '').replace(' (Strava)', '');
    add(label, tss, durationMin, sportColor(sport));
  }

  // Unspent load items — no runSpec discount
  let weekStartMs: number | null = null;
  let weekEndMs: number | null = null;
  if (planStartDate && wk.w != null) {
    weekStartMs = new Date(planStartDate).getTime() + (wk.w - 1) * 7 * 86400000;
    weekEndMs = weekStartMs + 7 * 86400000;
  }
  for (const item of wk.unspentLoadItems ?? []) {
    if (weekStartMs !== null && weekEndMs !== null && item.date) {
      const itemMs = new Date(item.date).getTime();
      if (itemMs < weekStartMs || itemMs >= weekEndMs) continue;
    }
    if (item.garminId) {
      if (seenGarminIds.has(item.garminId)) continue;
      seenGarminIds.add(item.garminId);
    }
    const tss = item.durationMin * (TL_PER_MIN[5] ?? 1.15);
    add(item.displayName, tss, item.durationMin, sportColor(item.sport));
  }

  return Array.from(segments.values())
    .filter(s => s.tss > 0.5)
    .sort((a, b) => b.tss - a.tss);
}

export function showLoadBreakdownSheet(s: SimulatorState, weekNum?: number): void {
  const wkIndex = (weekNum ?? s.w) - 1;
  const wk = s.wks?.[wkIndex];
  const tssActual = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  // Use computePlannedSignalB so the target matches the plan bar exactly (same corrected formula).
  // Derive the cross-training component for display; running = remainder.
  let crossTrainingBudget = 0;
  if (s.sportBaselineByType) {
    for (const sport of Object.values(s.sportBaselineByType)) {
      crossTrainingBudget += sport.avgSessionRawTSS * sport.sessionsPerWeek;
    }
  }
  crossTrainingBudget = Math.round(crossTrainingBudget);
  const tssPlan = computePlannedSignalB(s.historicWeeklyTSS, s.ctlBaseline, wk?.ph ?? 'base', s.athleteTierOverride ?? s.athleteTier, s.rw, undefined, undefined, s.sportBaselineByType);
  const runningTSSPlan = Math.max(0, tssPlan - crossTrainingBudget);

  const segments = wk ? computeLoadBreakdown(wk, wk.rated ?? {}, s.planStartDate) : [];
  // Use tssActual (from computeWeekRawTSS) as the authoritative total so bar widths
  // always match the number shown on the home page. Never use the sum of rounded segments.
  const totalTss = tssActual;

  // Stacked bar segments — proportions relative to tssActual so widths add up exactly
  // When over target, fill the full bar width (100%); when under, scale to target position
  const barDenom = Math.max(totalTss, tssPlan, 1);
  const barScale = totalTss >= tssPlan ? 100 / totalTss : 100 / tssPlan;
  const stackedBar = totalTss > 0
    ? segments.map(seg => {
      const pct = seg.tss * barScale;
      return `<div style="height:100%;width:${pct.toFixed(1)}%;background:${seg.color};flex-shrink:0"></div>`;
    }).join('')
    : `<div style="height:100%;width:4%;background:var(--c-border);flex-shrink:0;border-radius:3px"></div>`;

  // Remaining planned — only shown when under target
  const remaining = Math.max(0, Math.round(tssPlan) - tssActual);
  const remainingPct = remaining > 5 ? remaining * barScale : 0;
  const remainingBar = remaining > 5
    ? `<div style="height:100%;width:${remainingPct.toFixed(1)}%;background:var(--c-border);flex-shrink:0;border-radius:0 3px 3px 0"></div>`
    : '';

  // Legend rows
  const legendRows = segments.map(seg => {
    const barWidth = totalTss > 0 ? Math.min(100, Math.round((seg.tss / totalTss) * 100)) : 0;
    const dur = seg.durationMin >= 60
      ? `${Math.floor(seg.durationMin / 60)}h ${Math.round(seg.durationMin % 60)}m`
      : `${Math.round(seg.durationMin)}m`;
    return `
      <div style="display:flex;flex-direction:column;gap:5px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:10px;height:10px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>
            <span style="font-size:14px;color:var(--c-black)">${seg.label}</span>
            <span style="font-size:12px;color:var(--c-faint)">${dur}</span>
          </div>
          <span style="font-size:14px;font-weight:600;color:var(--c-black)">${Math.round(seg.tss)}</span>
        </div>
        <div style="background:rgba(0,0,0,0.06);border-radius:3px;height:4px;overflow:hidden">
          <div style="background:${seg.color};height:100%;width:${barWidth}%;border-radius:3px"></div>
        </div>
      </div>`;
  }).join('');

  const emptyState = segments.length === 0
    ? `<p style="color:var(--c-faint);font-size:14px;text-align:center;padding:20px 0">No activities logged yet this week</p>`
    : '';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:50;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--c-surface);border-radius:16px;width:100%;max-width:480px;padding-bottom:0;max-height:85vh;overflow-y:auto">
      <div style="padding:16px 18px 12px;border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between">
        <div>
          <h2 style="font-size:16px;font-weight:600;color:var(--c-black)">Weekly Load Breakdown</h2>
          <p style="font-size:12px;color:var(--c-faint);margin-top:2px">All sports · running + cross-training</p>
        </div>
        <button id="lbd-close" style="color:var(--c-muted);font-size:18px;background:none;border:none;cursor:pointer;padding:0;line-height:1">✕</button>
      </div>

      <div style="padding:16px 18px;display:flex;flex-direction:column;gap:16px">

        <!-- Big number + stacked bar -->
        <div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
            <span style="font-size:28px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">${tssActual}</span>
            <span style="font-size:14px;color:var(--c-muted)">/ ${Math.round(tssPlan)} TSS target</span>
          </div>
          <div style="background:rgba(0,0,0,0.06);border-radius:4px;height:10px;overflow:hidden;display:flex">
            ${stackedBar}
            ${remainingBar}
          </div>
          ${segments.length > 0 ? `
          <div style="display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px">
            ${segments.map(seg => `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--c-muted)"><div style="width:7px;height:7px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>${seg.label}</div>`).join('')}
            ${remaining > 5 ? `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--c-faint)"><div style="width:7px;height:7px;border-radius:3px;background:var(--c-border);flex-shrink:0"></div>Remaining</div>` : ''}
          </div>` : ''}
        </div>

        <!-- Divider -->
        ${segments.length > 0 ? '<div style="height:1px;background:var(--c-border)"></div>' : ''}

        <!-- Sport rows -->
        <div style="display:flex;flex-direction:column;gap:12px">
          ${legendRows}
          ${emptyState}
        </div>

        <!-- Planned target footer -->
        <div style="background:var(--c-bg);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;color:var(--c-muted)">Running planned</span>
            <span style="font-size:13px;font-weight:500;color:var(--c-black)">${runningTSSPlan} TSS</span>
          </div>
          ${crossTrainingBudget > 0 ? `
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;color:var(--c-muted)">Cross-training expected</span>
            <span style="font-size:13px;font-weight:500;color:var(--c-black)">${crossTrainingBudget} TSS</span>
          </div>` : ''}
          <div style="height:1px;background:var(--c-border)"></div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:13px;font-weight:600;color:var(--c-black)">Total target</span>
            <span style="font-size:13px;font-weight:600;color:var(--c-black)">${Math.round(tssPlan)} TSS</span>
          </div>
        </div>

      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#lbd-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}


function buildProgressBars(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];

  // Sessions done this week — prefer synced activity count (Strava or Garmin) over rated count
  const syncedSessions = wk
    ? Object.keys(wk.garminActuals || {}).length
    + (wk.adhocWorkouts || []).filter((w: any) =>
      w.id?.startsWith('garmin-') || w.id?.startsWith('strava-')
    ).length
    : 0;
  const ratedSessions = wk
    ? Object.values(wk.rated || {}).filter(v => typeof v === 'number' && v > 0).length
    : 0;
  const sessionsDone = Math.max(syncedSessions, ratedSessions);
  // Count all planned non-rest sessions (runs + gym + cross-training + adhoc)
  const plannedWorkouts = wk
    ? generateWeekWorkouts(
      wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
      null, s.recurringActivities,
      s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
      getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus,
    )
    : [];
  const adhocExtra = wk
    ? (wk.adhocWorkouts || []).filter((w: any) => !(w.id || '').startsWith('garmin-') && !(w.id || '').startsWith('strava-')).length
    : 0;
  const sessionsPlan = plannedWorkouts.filter((w: any) => w.t !== 'rest').length + adhocExtra || s.rw || 5;

  // Distance this week (running only from garmin, or completedKm)
  const kmDone = wk
    ? Object.entries(wk.garminActuals || {})
      .filter(([k]) => isRunKey(k))
      .reduce((sum, [, a]) => sum + ((a as any).distanceKm || 0), 0)
    : 0;
  const kmPlan = (s.rw || 5) * ((s.wks?.[s.w - 1] as any)?.targetKmPerRun || 10);

  // TSS this week vs plan — Signal B actual vs phase-adjusted planned target
  // Always use computePlannedWeekTSS (not signalBBaseline) so the phase multiplier is applied,
  // matching the modal which uses the same formula.
  const tssActual = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  const tssPlan = computePlannedWeekTSS(s.historicWeeklyTSS, s.ctlBaseline, wk?.ph ?? 'base', s.athleteTierOverride ?? s.athleteTier, s.rw);

  function bar(actual: number, plan: number, fmt: (v: number) => string, planFmt: (v: number) => string): string {
    if (plan <= 0) return '';
    const ratio = actual / plan;
    const overRatio = Math.max(0, ratio - 1);

    // Bar fill: cap the visual at 88% of container width
    // Within 88%: green portion = min(ratio, 1) × 88, amber = overshoot portion
    const greenWidth = Math.min(ratio, 1) * 88;
    const amberWidth = Math.min(overRatio, 0.3) * 88; // cap amber at 30% over
    const totalWidth = greenWidth + amberWidth;

    // Overflow label (+X%)
    const overPct = Math.round(overRatio * 100);
    const overLabel = overPct >= 5
      ? `<span class="absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-bold" style="color:${overPct >= 30 ? 'var(--c-warn)' : 'var(--c-caution)'}">${overPct >= 30 ? '+' + overPct + '%' : '+' + overPct + '%'}</span>`
      : '';

    // Colour: grey until 70%, then green, cap segments for over-target
    let fillStyle: string;
    if (ratio < 0.7) {
      fillStyle = `background:var(--c-muted);width:${totalWidth}%`;
    } else if (ratio <= 1.05) {
      fillStyle = `background:var(--c-ok);width:${totalWidth}%`;
    } else {
      // green to target, amber cap
      const targetPx = Math.min(1, 1) * 88; // target position within 88%
      fillStyle = `background:linear-gradient(to right, var(--c-ok) ${(88 / totalWidth * 100).toFixed(1)}%, var(--c-warn) ${(88 / totalWidth * 100).toFixed(1)}%);width:${totalWidth}%`;
    }

    return `<div class="m-prog-fill" style="${fillStyle}"></div>`;
  }

  // Simplified colour logic
  function fillBar(actual: number, plan: number): string {
    if (plan <= 0) return '';
    const ratio = actual / plan;
    const capWidth = 88; // max bar % width
    const targetPct = Math.min(ratio, 1) * capWidth;
    const overPct = Math.min(Math.max(0, ratio - 1), 0.42) * capWidth;
    const totalWidth = targetPct + overPct;

    if (ratio < 0.7) {
      return `<div class="m-prog-fill" style="width:${totalWidth}%;background:var(--c-muted)"></div>`;
    }
    if (ratio <= 1.05) {
      return `<div class="m-prog-fill" style="width:${totalWidth}%;background:var(--c-ok)"></div>`;
    }
    // overshoot: green body + red cap via gradient
    const greenPct = (targetPct / totalWidth * 100).toFixed(1);
    return `<div class="m-prog-fill" style="width:${totalWidth}%;background:linear-gradient(to right,var(--c-ok) ${greenPct}%,var(--c-warn) ${greenPct}%)"></div>`;
  }

  function overLabel(actual: number, plan: number, label = ''): string {
    if (plan <= 0) return '';
    const overPct = Math.round(((actual / plan) - 1) * 100);
    if (overPct < 5) return '';
    const text = label ? `+${overPct}% ${label}` : `+${overPct}%`;
    return `<span class="absolute right-0 top-1/2 -translate-y-1/2 text-[10px] font-bold" style="color:var(--c-warn)">${text}</span>`;
  }

  // Status pill
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeedProgress = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeedProgress);
  let pillHtml: string;
  let pillCaption: string;
  if (acwr.ratio <= 0 || (s.w < 3)) {
    pillHtml = `<span class="m-pill m-pill-neutral"><span class="m-pill-dot"></span>Building Consistency</span>`;
    pillCaption = 'Keep logging sessions — your baseline builds over the first 4 weeks.';
  } else if (acwr.status === 'high') {
    pillHtml = `<span class="m-pill m-pill-caution"><span class="m-pill-dot"></span>Consider slowing down</span>`;
    pillCaption = 'Load is spiking. Protect recovery before next week.';
  } else if (acwr.status === 'caution') {
    pillHtml = `<span class="m-pill m-pill-caution"><span class="m-pill-dot"></span>Training Hard!</span>`;
    pillCaption = 'Load is rising fast. Keep today\'s session easy if possible.';
  } else {
    pillHtml = `<span class="m-pill m-pill-ok"><span class="m-pill-dot"></span>On Track!</span>`;
    pillCaption = sessionsDone >= sessionsPlan
      ? 'Great week — you hit all your sessions.'
      : `${sessionsPlan - sessionsDone} session${sessionsPlan - sessionsDone > 1 ? 's' : ''} left this week.`;
  }

  return `
    <div class="section px-[18px] mb-[14px]">
      <div class="m-sec-label">This Week</div>
      <div class="m-card p-4 flex flex-col gap-[13px]">

        <div class="flex flex-col gap-[7px]">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Sessions</span>
            <span class="text-[12px] font-medium" style="letter-spacing:-0.01em">${sessionsDone} / ${sessionsPlan}</span>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(sessionsDone, sessionsPlan)}</div>
            ${overLabel(sessionsDone, sessionsPlan)}
          </div>
        </div>

        <div class="flex flex-col gap-[7px]">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Distance</span>
            <span class="text-[12px] font-medium" style="letter-spacing:-0.01em">${formatKm(kmDone, s.unitPref ?? 'km')} / ${formatKm(kmPlan, s.unitPref ?? 'km', 0)}</span>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(kmDone, kmPlan)}</div>
            ${overLabel(kmDone, kmPlan)}
          </div>
        </div>

        <div id="home-tss-row" class="flex flex-col gap-[7px]" style="cursor:pointer">
          <div class="flex justify-between items-baseline">
            <span class="text-[11px] font-semibold" style="color:var(--c-muted)">Training Load (TSS)</span>
            <div class="flex items-center gap-[6px]">
              <span class="text-[12px] font-medium" style="letter-spacing:-0.01em">${tssActual} / ${Math.round(tssPlan)} TSS</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.25"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
            </div>
          </div>
          <div class="relative" style="height:5px">
            <div class="m-prog-track w-[88%]">${fillBar(tssActual, tssPlan)}</div>
            ${overLabel(tssActual, tssPlan, 'excess load')}
          </div>
        </div>

        <div class="flex items-center gap-2 pt-[2px]">
          ${pillHtml}
          <span class="text-[12px]" style="color:var(--c-muted)">${pillCaption}</span>
        </div>
      </div>
    </div>
  `;
}

// ─── SVG arc helpers ────────────────────────────────────────────────────────

function polarToCart(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const s = polarToCart(cx, cy, r, startDeg);
  const e = polarToCart(cx, cy, r, endDeg);
  const large = (endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

// ─── Training Readiness Ring ────────────────────────────────────────────────

function buildReadinessRing(s: SimulatorState): string {
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);

  // For readiness: same-signal TSB (Signal B for both CTL and ATL)
  // so cross-trainers aren't penalised by the A/B discount gap
  const sameSignal = computeSameSignalTSB(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate);
  const tsb = sameSignal?.tsb ?? 0;
  const ctlNow = sameSignal?.ctl ?? 0;

  // Original mixed-signal metrics still needed for 4-week CTL lookback (momentum signal)
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const fourBack = metrics[metrics.length - 5]; // 4 weeks ago
  const ctlFourWeeksAgo = fourBack?.ctl ?? ctlNow;

  // Recovery data: prefer today's manual entry, fall back to latest physiology
  const today = new Date().toISOString().split('T')[0];
  const manualToday = s.lastRecoveryPromptDate === today
    ? (s.recoveryHistory ?? []).slice().reverse().find((e: any) => e.date === today && e.source === 'manual')
    : undefined;
  const latestPhysio = s.physiologyHistory?.slice(-1)[0];
  const sleepScore: number | null = manualToday?.sleepScore ?? latestPhysio?.sleepScore ?? null;
  const hrvRmssd: number | null = latestPhysio?.hrvRmssd ?? null;
  const hrvAll = (s.physiologyHistory ?? []).map((p: any) => p.hrvRmssd).filter((v: any) => v != null) as number[];
  const hrvPersonalAvg: number | null = hrvAll.length >= 3
    ? Math.round(hrvAll.reduce((a, b) => a + b, 0) / hrvAll.length)
    : null;

  const readiness: ReadinessResult = computeReadiness({
    tsb,
    acwr: acwr.ratio,
    ctlNow,
    ctlFourWeeksAgo,
    sleepScore,
    hrvRmssd,
    hrvPersonalAvg,
    weeksOfHistory: metrics.length,
  });

  const color = readinessColor(readiness.label);

  // SVG ring: 270° arc, starts bottom-left (135°), fills clockwise
  const CX = 80, CY = 80, R = 58, SW = 10;
  const START = 135;
  const SWEEP = 270;
  const fillEnd = START + (readiness.score / 100) * SWEEP;
  const trackPath = arcPath(CX, CY, R, START, START + SWEEP);
  const fillPathStr = readiness.score > 0 ? arcPath(CX, CY, R, START, Math.min(fillEnd, START + SWEEP - 0.01)) : '';

  // Sub-signal display values
  // ÷7: display in daily-equivalent units (TrainingPeaks-compatible)
  const tsbDisp = Math.round(tsb / 7);
  const tsbLabel = tsbDisp > 0 ? `+${tsbDisp}` : `${tsbDisp}`;
  const tsbZone = tsb > 0 ? 'Fresh' : tsb >= -10 ? 'Recovering' : tsb >= -25 ? 'Fatigued' : 'Overtrained';
  const safetyLabel = acwr.ratio <= 0 ? '—' : acwr.status === 'safe' ? 'Safe' : acwr.status === 'caution' ? 'Elevated' : 'High Risk';
  const safetyColor = acwr.status === 'high' ? 'var(--c-warn)' : acwr.status === 'caution' ? 'var(--c-caution)' : 'var(--c-ok)';
  const momentumArrow = ctlNow > ctlFourWeeksAgo ? '↗' : ctlNow > ctlFourWeeksAgo * 0.95 ? '→' : '↘';
  const momentumColor = ctlNow > ctlFourWeeksAgo ? 'var(--c-ok)' : ctlNow > ctlFourWeeksAgo * 0.9 ? 'var(--c-caution)' : 'var(--c-warn)';

  // Recovery score from physiologyHistory — uses RHR, HRV, sleep (whichever is available)
  const recoveryResult = computeRecoveryScore(s.physiologyHistory ?? []);
  const recoveryScoreColor = recoveryResult.hasData
    ? (recoveryResult.score! < 40 ? 'var(--c-warn)' : recoveryResult.score! < 65 ? 'var(--c-caution)' : 'var(--c-ok)')
    : 'var(--c-faint)';

  // ISSUE 1: Driving signal highlight — coloured left border + "⬇ Main factor" label
  const isDriving = (sig: string) => readiness.drivingSignal === sig;
  const drivingBorderStyle = (sig: string) => isDriving(sig)
    ? 'border-left:3px solid var(--c-warn);padding-left:9px;margin-left:-3px;'
    : '';
  const drivingTag = (sig: string) => isDriving(sig)
    ? `<div style="font-size:9px;color:var(--c-warn);margin-top:3px;font-weight:600">⬇ Main factor</div>`
    : '';

  // ISSUE 3: Adjust button text varies by driving signal
  const adjustText = readiness.drivingSignal === 'fitness' ? 'Swap to easy run'
    : readiness.drivingSignal === 'safety' ? 'Reduce session load'
      : readiness.drivingSignal === 'recovery' ? 'Take it lighter today'
        : "Keep consistency — don't skip";

  const recoveryPillHtml = recoveryResult.hasData
    ? `<div class="home-readiness-pill" data-pill="recovery" style="flex:1;min-width:80px;cursor:pointer;${drivingBorderStyle('recovery')}">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Recovery</div>
        <div style="font-size:14px;font-weight:500;color:${recoveryScoreColor}">${recoveryResult.score}/100</div>
        ${drivingTag('recovery')}
      </div>`
    : `<div class="home-readiness-pill" data-pill="recovery" style="flex:1;min-width:80px;opacity:0.45;cursor:pointer">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Recovery</div>
        <div style="font-size:11px;color:var(--c-faint)">Connect watch</div>
      </div>`;

  // Recovery row (RHR sub-caption)
  let rhrCaption = '';
  if (latestPhysio?.restingHR != null) {
    const rhrValues = (s.physiologyHistory ?? []).map((p: any) => p.restingHR).filter((v: any) => v != null) as number[];
    const rhrAvg = rhrValues.length > 1 ? Math.round(rhrValues.slice(0, -1).reduce((a, b) => a + b, 0) / (rhrValues.length - 1)) : null;
    const rhrDiff = rhrAvg != null ? latestPhysio.restingHR - rhrAvg : 0;
    const arrow = rhrDiff > 2 ? ' ↑' : rhrDiff < -2 ? ' ↓' : '';
    rhrCaption = `RHR: ${latestPhysio.restingHR}bpm${arrow} · `;
  }

  return `
    <div class="section px-[18px] mb-[14px]">
      <div class="m-sec-label">Training Readiness</div>
      <div id="home-readiness-card" class="m-card overflow-hidden" style="cursor:pointer">

        <!-- Ring + score -->
        <div style="display:flex;flex-direction:column;align-items:center;padding:20px 16px 14px">
          <div style="position:relative;width:160px;height:160px">
            <svg viewBox="0 0 160 160" width="160" height="160" style="display:block;overflow:visible">
              <!-- Background track -->
              <path d="${trackPath}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="${SW}" stroke-linecap="round"/>
              <!-- Score fill -->
              ${fillPathStr
      ? `<path d="${fillPathStr}" fill="none" stroke="${color}" stroke-width="${SW}" stroke-linecap="round"/>`
      : ''}
            </svg>
            <!-- Center text -->
            <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;margin-top:-6px">
              <div style="font-size:38px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:${color}">${readiness.score}</div>
              <div style="font-size:12px;font-weight:600;letter-spacing:0.01em;margin-top:2px;color:var(--c-black)">${readiness.label}</div>
            </div>
          </div>

          <!-- Sentence -->
          <p style="font-size:13px;color:var(--c-muted);text-align:center;line-height:1.45;margin-top:4px;max-width:260px">${readiness.sentence}</p>
        </div>

        <!-- Expandable pills (tap ring to open; each pill tappable for detail) -->
        <div id="home-readiness-pills" style="display:none;border-top:1px solid var(--c-border);padding:12px 14px">
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">

            <div class="home-readiness-pill" data-pill="fitness" style="flex:1;min-width:80px;cursor:pointer;${drivingBorderStyle('fitness')}">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Freshness</div>
              <div style="font-size:14px;font-weight:500;color:${readiness.fitnessScore < 40 ? 'var(--c-warn)' : readiness.fitnessScore < 65 ? 'var(--c-caution)' : 'var(--c-ok)'}">${tsbLabel}</div>
              <div style="font-size:10px;color:var(--c-faint)">${tsbZone}</div>
              ${drivingTag('fitness')}
            </div>

            <div class="home-readiness-pill" data-pill="safety" style="flex:1;min-width:80px;cursor:pointer;${drivingBorderStyle('safety')}">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Injury Risk</div>
              <div style="font-size:14px;font-weight:500;color:${safetyColor}">${safetyLabel}</div>
              <div style="font-size:10px;color:var(--c-faint)">${acwr.ratio > 0 ? acwr.ratio.toFixed(2) + '×' : 'No data'}</div>
              ${drivingTag('safety')}
            </div>

            <div class="home-readiness-pill" data-pill="momentum" style="flex:1;min-width:80px;cursor:pointer;${drivingBorderStyle('momentum')}">
              <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Momentum</div>
              <div style="font-size:14px;font-weight:500;color:${momentumColor}">${momentumArrow} ${ctlNow > ctlFourWeeksAgo ? 'Building' : ctlNow > ctlFourWeeksAgo * 0.95 ? 'Stable' : 'Declining'}</div>
              ${drivingTag('momentum')}
            </div>

            ${recoveryPillHtml}

          </div>
          <p style="font-size:11px;color:var(--c-faint);margin-top:4px">${recoveryResult.hasData ? rhrCaption.replace(/ · $/, '') + (sleepScore != null ? (rhrCaption ? ' · ' : '') + `Sleep ${Math.round(sleepScore)}/100` : '') : 'Connect a watch to unlock Recovery signal.'}</p>

          ${readiness.score <= 59 ? `
          <button id="readiness-adjust-btn" style="margin-top:10px;width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--c-border);cursor:pointer;font-size:13px;font-weight:500;background:rgba(0,0,0,0.04);color:var(--c-black);font-family:var(--f);text-align:left">
            ${adjustText}
          </button>` : ''}
        </div>

      </div>
    </div>
  `;
}

// ─── Readiness pill info sheets ──────────────────────────────────────────────

type PillSignal = 'fitness' | 'safety' | 'momentum' | 'recovery';

interface PillSheetData {
  tsb: number; tsbZone: string; tsbLabel: string; fitnessScore: number;
  acwrRatio: number; safetyLabel: string;
  ctlNow: number; ctlFourWeeksAgo: number; momentumArrow: string;
  recoveryScore: number | null; sleepScore: number | null; rhrCaption: string; hasRecovery: boolean;
  // Rich recovery breakdown (from computeRecoveryScore)
  recoveryHasData?: boolean;
  recoveryCompositeScore?: number | null;
  sleepSubScore?: number | null;
  hrvSubScore?: number | null;
  rhrSubScore?: number | null;
  rhrRawBpm?: number | null;
  rhrTrend?: string;
}

function showReadinessPillSheet(signal: PillSignal, d: PillSheetData): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4';

  const scaleBar = (zones: Array<{ label: string; flex: number; color: string }>, markerPct: number | null) => `
    <div style="position:relative;height:10px;border-radius:5px;overflow:hidden;display:flex;gap:1px;margin-top:12px">
      ${zones.map(z => `<div style="flex:${z.flex};height:100%;background:${z.color}"></div>`).join('')}
      ${markerPct != null ? `<div style="position:absolute;top:-3px;left:${markerPct}%;transform:translateX(-50%);width:4px;height:16px;background:var(--c-black);border-radius:2px;border:1.5px solid white;z-index:2"></div>` : ''}
    </div>
    <div style="display:flex;gap:1px;margin-top:3px">
      ${zones.map(z => `<div style="flex:${z.flex};font-size:8px;color:var(--c-faint);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${z.label}</div>`).join('')}
    </div>`;

  let title = '', subtitle = '', body = '';

  if (signal === 'fitness') {
    title = 'Freshness'; subtitle = 'How recovered you are right now';
    const markerPct = Math.min(98, Math.max(2, ((d.tsb + 40) / 60) * 100));
    const what = d.tsb > 0
      ? "You're feeling fresh — your short-term load is lower than your fitness baseline."
      : d.tsb >= -10 ? "You've trained recently but your body is handling it well."
        : d.tsb >= -25 ? "You've built up meaningful fatigue. Your body is under training stress."
          : "Your short-term load far exceeds your fitness baseline. Deep accumulated fatigue.";
    const action = d.tsbZone === 'Overtrained' ? 'Take 1–2 rest days. When you do train, keep effort very easy.'
      : d.tsbZone === 'Fatigued' ? 'Consider an easy effort or a lighter day to let your body recover.'
        : d.tsbZone === 'Recovering' ? 'Good balance. Session as planned.'
          : "You're fresh — full session, or a little extra if you feel good.";
    body = `
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.02em">${d.tsbLabel} <span style="font-size:13px;color:var(--c-muted)">${d.tsbZone}</span></div>
        <p style="font-size:12px;color:var(--c-muted);margin-top:4px">${what}</p>
      </div>
      ${scaleBar([
      { label: 'Overtrained', flex: 15, color: 'rgba(255,69,58,0.6)' },
      { label: 'Fatigued', flex: 15, color: 'rgba(255,159,10,0.55)' },
      { label: 'Recovering', flex: 10, color: 'rgba(78,159,229,0.4)' },
      { label: 'Fresh', flex: 10, color: 'rgba(52,199,89,0.55)' },
      { label: 'Peaked', flex: 10, color: 'rgba(52,199,89,0.85)' },
    ], markerPct)}
      <p style="font-size:12px;color:var(--c-muted);margin-top:10px"><strong>What to do:</strong> ${action}</p>`;

  } else if (signal === 'safety') {
    title = 'Load Safety (Injury Risk)'; subtitle = 'How fast your training load is increasing';
    const markerPct = d.acwrRatio > 0
      ? Math.min(98, Math.max(2, ((d.acwrRatio - 0.5) / 1.5) * 100))
      : null;
    const what = d.acwrRatio <= 0 ? 'Not enough training history to calculate.'
      : d.acwrRatio <= 1.3 ? "Your recent load is similar to your long-term baseline — safe territory."
        : d.acwrRatio <= 1.5 ? "Your load is ramping faster than usual. Consider whether it's sustainable."
          : "Significant load spike. Your body may not have had time to adapt.";
    body = `
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.02em">${d.acwrRatio > 0 ? d.acwrRatio.toFixed(2) + '×' : '—'} <span style="font-size:13px;color:var(--c-muted)">${d.safetyLabel}</span></div>
        <p style="font-size:12px;color:var(--c-muted);margin-top:4px">${what}</p>
      </div>
      ${scaleBar([
      { label: 'Safe', flex: 8, color: 'rgba(52,199,89,0.55)' },
      { label: 'Elevated',      flex: 2, color: 'rgba(255,159,10,0.55)' },
      { label: 'High Risk', flex: 5, color: 'rgba(255,69,58,0.55)' },
    ], markerPct)}`;

  } else if (signal === 'momentum') {
    title = 'Running Fitness Momentum'; subtitle = 'Whether your running fitness is trending up or down';
    const direction = d.ctlNow > d.ctlFourWeeksAgo ? 'Building'
      : d.ctlNow > d.ctlFourWeeksAgo * 0.95 ? 'Stable' : 'Declining';
    const what = direction === 'Building'
      ? 'Your training load over the last 4 weeks has been increasing — your body is adapting and getting fitter.'
      : direction === 'Stable'
        ? 'Your training load over the last 4 weeks has been consistent. Your body has a solid baseline to work from.'
        : 'Your training load has dropped compared to 4 weeks ago. Try to stay consistent — skipping sessions compounds quickly.';
    const whyItMatters = "Momentum isn't about today's recovery — it's about your body's capacity to handle training. A stable or rising baseline means your tendons, muscles, and aerobic system are conditioned for the work ahead.";
    body = `
      <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
        <div style="font-size:22px;font-weight:300">${d.momentumArrow} ${direction}</div>
        <p style="font-size:12px;color:var(--c-muted);margin-top:4px">${what}</p>
      </div>
      <p style="font-size:12px;color:var(--c-muted);margin-top:10px">${whyItMatters}</p>`;

  } else {
    title = 'Recovery'; subtitle = 'Sleep, HRV and resting heart rate';
    const recHasData = d.recoveryHasData ?? d.hasRecovery;
    if (!recHasData) {
      body = `
        <div class="rounded-lg p-3 text-center" style="background:rgba(0,0,0,0.04)">
          <p style="font-size:13px;color:var(--c-muted)">Connect a Garmin watch to see your recovery data — sleep score, HRV, and resting heart rate.</p>
        </div>`;
    } else {
      const rs = d.recoveryCompositeScore ?? d.recoveryScore ?? 0;
      const zone = rs >= 75 ? 'Excellent' : rs >= 55 ? 'Good' : rs >= 35 ? 'Fair' : 'Poor';
      const advice = rs >= 75 ? "You're well rested. Full session as planned."
        : rs >= 55 ? 'Reasonable recovery. Listen to your body during the session.'
          : 'Prioritise sleep tonight. Consider a lighter effort today.';

      // Mini position bar for each recovery metric
      const recBar = (score: number | null | undefined, label: string, rawLine?: string) => {
        if (score == null) return '';
        const markerPct = Math.min(98, Math.max(2, score));
        const barZones = [
          { l: 'Poor', f: 35, c: 'rgba(255,69,58,0.55)' },
          { l: 'Fair', f: 20, c: 'rgba(255,159,10,0.50)' },
          { l: 'Good', f: 20, c: 'rgba(52,199,89,0.45)' },
          { l: 'Excellent', f: 25, c: 'rgba(52,199,89,0.75)' },
        ];
        const metricZone = score >= 75 ? 'Excellent' : score >= 55 ? 'Good' : score >= 35 ? 'Fair' : 'Poor';
        const metricColor = score >= 55 ? 'var(--c-ok)' : score >= 35 ? 'var(--c-caution)' : 'var(--c-warn)';
        return `
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
              <span style="font-size:11px;font-weight:600;color:var(--c-black)">${label}</span>
              <span style="font-size:11px;color:${metricColor};font-variant-numeric:tabular-nums"><strong>${Math.round(score)}/100</strong> · ${metricZone}</span>
            </div>
            ${rawLine ? `<div style="font-size:10px;color:var(--c-faint);margin-bottom:4px">${rawLine}</div>` : ''}
            <div style="position:relative;height:8px;margin:3px 0">
              <div style="height:8px;border-radius:4px;overflow:hidden;display:flex;gap:1px">
                ${barZones.map(z => `<div style="flex:${z.f};height:100%;background:${z.c}"></div>`).join('')}
              </div>
              <div style="position:absolute;top:-3px;left:${markerPct}%;transform:translateX(-50%);width:3px;height:14px;background:var(--c-black);border-radius:2px;border:1.5px solid white;z-index:2"></div>
            </div>
            <div style="display:flex;gap:1px;margin-top:2px">
              ${barZones.map(z => `<div style="flex:${z.f};font-size:8px;color:var(--c-faint);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${z.l}</div>`).join('')}
            </div>
          </div>`;
      };

      const rhrRawLine = d.rhrRawBpm != null
        ? `${d.rhrRawBpm} bpm${d.rhrTrend ? ' ' + d.rhrTrend : ''} (vs your baseline)`
        : undefined;
      const sleepRawLine = d.sleepScore != null
        ? `Last night: ${d.sleepScore}/100`
        : undefined;

      body = `
        <div class="rounded-lg p-3" style="background:rgba(0,0,0,0.04)">
          <div style="font-size:22px;font-weight:300">${Math.round(rs)}/100 <span style="font-size:13px;color:var(--c-muted)">${zone}</span></div>
          <p style="font-size:12px;color:var(--c-muted);margin-top:2px">${advice}</p>
          <p style="font-size:10px;color:var(--c-faint);margin-top:4px">Composite of sleep score, HRV trend, and resting HR vs your 14-day baseline.</p>
          <div id="recovery-sleep-row" style="cursor:pointer">
            ${recBar(d.sleepSubScore, 'Sleep', sleepRawLine)}
          </div>
          ${recBar(d.hrvSubScore, 'HRV')}
          ${recBar(d.rhrSubScore, 'Resting Heart Rate', rhrRawLine)}
        </div>`;
    }
  }

  const btnLabel = signal === 'recovery' ? 'Sleep detail' : 'View full breakdown in Stats';

  overlay.innerHTML = `
    <div class="rounded-2xl w-full max-w-lg" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <div>
          <h2 class="font-semibold" style="color:var(--c-black)">${title}</h2>
          <p style="font-size:12px;color:var(--c-muted);margin-top:1px">${subtitle}</p>
        </div>
        <button id="pill-sheet-close" class="text-xl leading-none" style="color:var(--c-muted)">✕</button>
      </div>
      <div class="px-4 py-4 space-y-3 text-sm">${body}</div>
      <div class="px-4 pb-4">
        <button id="pill-sheet-to-stats" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--c-border);cursor:pointer;font-size:13px;font-weight:500;background:rgba(0,0,0,0.04);color:var(--c-black);font-family:var(--f)">
          ${btnLabel}
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#pill-sheet-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#pill-sheet-to-stats')?.addEventListener('click', () => {
    close();
    if (signal === 'recovery') {
      const s3 = getState();
      showSleepSheet(s3.physiologyHistory ?? [], s3.wks ?? []);
    } else {
      import('./stats-view').then(({ renderStatsView }) => renderStatsView());
    }
  });
  overlay.querySelector('#recovery-sleep-row')?.addEventListener('click', () => {
    close();
    const s3 = getState();
    showSleepSheet(s3.physiologyHistory ?? [], s3.wks ?? []);
  });
}


function buildTodayWorkout(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  if (!wk) {
    return buildNoWorkoutHero('No plan this week', 'Complete onboarding to generate your training plan.', false);
  }

  const workouts = generateWeekWorkouts(
    wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined,
    null, s.recurringActivities,
    s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs,
    getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus,
  );

  // Apply mods
  if (wk.workoutMods) {
    for (const mod of wk.workoutMods) {
      const w = workouts.find((wo: any) => wo.n === mod.name && (mod.dayOfWeek == null || wo.dayOfWeek === mod.dayOfWeek));
      if (w) { (w as any).d = mod.newDistance; (w as any).status = mod.status; }
    }
  }

  // Apply day moves (drag-and-drop reorder from plan tab)
  if ((wk as any).workoutMoves) {
    for (const [workoutId, newDay] of Object.entries((wk as any).workoutMoves as Record<string, number>)) {
      const w = workouts.find((wo: any) => (wo.id || wo.n) === workoutId);
      if (w) (w as any).dayOfWeek = newDay;
    }
  }

  const jsDay = new Date().getDay();
  const ourDay = jsDay === 0 ? 6 : jsDay - 1;

  // Find today's workout — run or cross-training
  const active = workouts.filter((w: any) =>
    w.status !== 'skip' && w.status !== 'replaced',
  );
  let todayW = active.find((w: any) => w.dayOfWeek === ourDay);
  if (!todayW) {
    const unrated = active.filter((w: any) => !wk.rated[w.id || w.n]);
    todayW = unrated[0] || null;
  }

  if (!todayW) {
    // Check if it's a rest day
    return buildNoWorkoutHero('Rest Day', 'No structured training today. Walk, stretch, sleep.', true, s);
  }

  const isRest = (todayW as any).t === 'rest' || (todayW as any).n?.toLowerCase().includes('rest');
  if (isRest) {
    return buildNoWorkoutHero('Rest Day', 'No structured training today. Walk, stretch, sleep.', true, s);
  }

  const isGym = (todayW as any).t === 'gym';
  const rawName = (todayW as any).n || 'Workout';
  // For gym sessions, append "Gym Session" if not already in the name
  const name = isGym && !rawName.toLowerCase().includes('gym') ? `${rawName} Gym Session` : rawName;
  const rawDesc = (todayW as any).d || '';
  const distKm = (todayW as any).km || (todayW as any).distanceKm || null;
  const durationMin = (todayW as any).dur || null;
  const rpe = (todayW as any).rpe || null;
  const workoutId = (todayW as any).id || (todayW as any).n;
  const alreadyRated = wk.rated[workoutId] && wk.rated[workoutId] !== 'skip';

  // For gym sessions: render exercises as an expandable list
  const exercises = isGym && rawDesc ? rawDesc.split('\n').filter(Boolean) : [];
  const desc = isGym ? '' : fmtDesc(rawDesc, s.unitPref ?? 'km'); // convert km/pace for display

  const metaItems = [
    durationMin ? { val: `~${Math.round(durationMin)} min`, lbl: 'Duration' } : null,
    distKm ? { val: formatKm(typeof distKm === 'number' ? distKm : parseFloat(distKm), s.unitPref ?? 'km'), lbl: 'Distance' } : null,
    rpe ? { val: `RPE ${rpe}`, lbl: 'Effort' } : null,
  ].filter(Boolean);

  const metaHtml = metaItems.map((item, i) => `
    <div class="flex flex-col gap-[2px] flex-1 ${i > 0 ? 'border-l pl-[14px]' : ''}" style="${i > 0 ? 'border-color:rgba(0,0,0,0.09)' : ''}">
      <span style="font-size:16px;font-weight:400;letter-spacing:-0.02em">${item!.val}</span>
      <span class="text-[10px] font-semibold uppercase tracking-[0.08em]" style="color:var(--c-faint)">${item!.lbl}</span>
    </div>
  `).join('');

  const startBtn = !alreadyRated
    ? `<button id="home-start-btn" data-workout-id="${workoutId}" data-name="${name.replace(/"/g, '&quot;')}" data-desc="${rawDesc.replace(/"/g, '&quot;')}" class="m-btn-primary">
        <span style="width:12px;height:12px;background:white;clip-path:polygon(0 0,100% 50%,0 100%);display:inline-block;flex-shrink:0"></span>
        Start
      </button>`
    : `<span class="m-pill m-pill-ok" style="pointer-events:none"><span class="m-pill-dot"></span>Done</span>`;

  return `
    <div class="workout-hero-bg mb-[14px]">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:0.9" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(78,159,229,0.18)" stroke-width="1"/>
        <circle cx="100" cy="100" r="55" stroke="rgba(78,159,229,0.14)" stroke-width="1"/>
        <circle cx="100" cy="100" r="82" stroke="rgba(78,159,229,0.10)" stroke-width="1"/>
        <circle cx="100" cy="100" r="112" stroke="rgba(78,159,229,0.07)" stroke-width="1"/>
        <circle cx="100" cy="100" r="145" stroke="rgba(78,159,229,0.04)" stroke-width="1"/>
        <line x1="100" y1="0" x2="100" y2="200" stroke="rgba(78,159,229,0.08)" stroke-width="0.8"/>
        <line x1="0" y1="100" x2="200" y2="100" stroke="rgba(78,159,229,0.08)" stroke-width="0.8"/>
      </svg>
      <div class="relative z-10 px-[22px] py-[20px]">
        <div class="flex justify-between items-start mb-[14px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
          ${startBtn}
        </div>
        <div style="font-size:28px;font-weight:300;letter-spacing:-0.04em;line-height:1.05;margin-bottom:5px">${name}</div>
        ${desc ? `<div class="m-text-caption mb-[16px]">${desc}</div>` : ''}
        ${exercises.length > 0 ? `
        <details class="mb-[16px]" style="cursor:pointer">
          <summary style="list-style:none;font-size:12px;font-weight:600;letter-spacing:0.04em;color:var(--c-faint);text-transform:uppercase;display:flex;align-items:center;gap:6px">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style="transition:transform 0.15s;flex-shrink:0"><path d="M2 3l3 4 3-4"/></svg>
            Exercises (${exercises.length})
          </summary>
          <div style="margin-top:10px;display:flex;flex-direction:column;gap:5px">
            ${exercises.map((ex: string) => `<div style="font-size:13px;color:var(--c-muted);line-height:1.4;padding-left:4px">• ${ex}</div>`).join('')}
          </div>
        </details>` : ''}
        <div class="flex gap-0 items-center pt-[14px]" style="border-top:1px solid rgba(0,0,0,0.09)">
          ${metaHtml}
          <button id="home-view-plan-btn" class="m-btn-link ml-auto pl-[14px]" style="border-left:1px solid rgba(0,0,0,0.09);white-space:nowrap">
            View
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildNoWorkoutHero(title: string, subtitle: string, isRest: boolean, s?: SimulatorState): string {
  const ourDay = jsToOurDay(new Date().getDay());
  // Find next upcoming workout
  let nextLabel = '';
  if (isRest && s) {
    const wk = s.wks?.[s.w - 1];
    if (wk) {
      const workouts = generateWeekWorkouts(wk.ph, s.rw, s.rd, s.typ, [], s.commuteConfig || undefined, null, s.recurringActivities, s.onboarding?.experienceLevel, undefined, s.pac?.e, s.w, s.tw, s.v, s.gs, getTrailingEffortScore(s.wks, s.w), wk.scheduledAcwrStatus);
      // Apply day moves so "Next workout" reflects any plan-tab reorders
      if ((wk as any).workoutMoves) {
        for (const [workoutId, newDay] of Object.entries((wk as any).workoutMoves as Record<string, number>)) {
          const wo = workouts.find((w: any) => (w.id || w.n) === workoutId);
          if (wo) (wo as any).dayOfWeek = newDay;
        }
      }
      const upcoming = workouts.filter((w: any) => w.dayOfWeek > ourDay && w.t !== 'rest');
      if (upcoming.length > 0) {
        const next = upcoming[0] as any;
        nextLabel = `Next: ${DAY_LABELS[next.dayOfWeek]} — ${next.n}${next.km ? ` ${formatKm(next.km, s.unitPref ?? 'km')}` : ''}`;
      }
    }
  }

  return `
    <div class="workout-hero-bg mb-[14px]" style="background:#F7F5F0">
      <svg style="position:absolute;right:-60px;top:50%;transform:translateY(-50%);pointer-events:none" width="200" height="200" viewBox="0 0 200 200" fill="none">
        <circle cx="100" cy="100" r="30" stroke="rgba(0,0,0,0.06)" stroke-width="1"/>
        <circle cx="100" cy="100" r="60" stroke="rgba(0,0,0,0.05)" stroke-width="1"/>
        <circle cx="100" cy="100" r="95" stroke="rgba(0,0,0,0.04)" stroke-width="1"/>
        <circle cx="100" cy="100" r="135" stroke="rgba(0,0,0,0.03)" stroke-width="1"/>
      </svg>
      <div class="relative z-10 px-[22px] py-[20px]">
        <div class="flex justify-between items-start mb-[14px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">${DAY_LABELS[ourDay]} · Today</span>
        </div>
        <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em;opacity:0.45;margin-bottom:5px">${title}</div>
        <div class="m-text-caption mb-[16px]">${subtitle}</div>
        <div class="flex justify-between items-center pt-[14px]" style="border-top:1px solid rgba(0,0,0,0.09)">
          <span class="text-[12px]" style="color:var(--c-muted)">${nextLabel}</span>
          <button id="home-view-plan-btn" class="m-btn-link">
            View plan
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

function buildRaceCountdown(s: SimulatorState): string {
  const raceDate = s.selectedMarathon?.date || s.onboarding?.customRaceDate;
  const raceName = s.selectedMarathon?.name || 'Your Race';
  if (!raceDate || s.continuousMode) return '';

  const days = daysUntil(raceDate);
  if (days <= 0) return '';

  const weeks = Math.floor(days / 7);
  const display = days <= 14 ? `${days}` : `${weeks}`;
  const unit = days <= 14 ? 'days' : 'weeks';

  return `
    <div class="px-[18px] mb-[14px]">
      <div class="m-card px-[18px] py-[14px] flex items-center justify-between">
        <div class="flex flex-col gap-[3px]">
          <span class="text-[10px] font-semibold uppercase tracking-[0.1em]" style="color:var(--c-faint)">Race Day</span>
          <span style="font-size:15px;font-weight:400;letter-spacing:-0.02em">${raceName}</span>
        </div>
        <div class="flex items-baseline gap-[5px]">
          <span style="font-size:44px;font-weight:300;letter-spacing:-0.05em;line-height:1">${display}</span>
          <span style="font-size:13px;color:var(--c-muted)">${unit}</span>
        </div>
      </div>
    </div>
  `;
}

function buildRecentActivity(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  const prevWk = s.wks?.[s.w - 2];

  // Collect recent completed activities (garminActuals + adhoc from current + prev week)
  type ActivityRow = { name: string; sub: string; value: string; icon: 'run' | 'gym' | 'swim' | 'bike'; id: string; workoutKey?: string; weekNum?: number };
  const rows: ActivityRow[] = [];

  function addFromWk(week: typeof wk, weekNum: number) {
    if (!week) return;
    const isCurrentWeek = weekNum === s.w;
    // Garmin synced actuals
    Object.entries(week.garminActuals || {}).forEach(([key, act]: [string, any]) => {
      if (rows.length >= 5) return;
      const isRun = isRunKey(key);
      const dateStr = act.date ? fmtDate(act.date) : (isCurrentWeek ? 'This week' : 'Last week');
      const val = isRun && act.distanceKm ? formatKm(act.distanceKm, s.unitPref ?? 'km') : act.durationMin ? `${Math.round(act.durationMin)} min` : '';
      const actName = act.workoutName || act.displayName
        || key.replace(/^[Ww]\d+[-_]?/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      rows.push({ name: actName, sub: dateStr, value: val, icon: isRun ? 'run' : 'gym', id: `garmin-${key}-${act.date || ''}`, workoutKey: key, weekNum });
    });
    // Adhoc workouts
    (week.adhocWorkouts || []).forEach((w: any) => {
      if (rows.length >= 5) return;
      const dateStr = isCurrentWeek ? 'This week' : 'Last week';
      const val = w.distanceKm ? formatKm(w.distanceKm, s.unitPref ?? 'km') : w.durationMin ? `${Math.round(w.durationMin)} min` : '';
      rows.push({ name: w.workoutName || w.displayName || w.name || w.n || 'Workout', sub: dateStr, value: val, icon: 'run', id: w.id || w.name });
    });
  }

  addFromWk(wk, s.w);
  addFromWk(prevWk, s.w - 1);

  if (rows.length === 0) return '';

  function iconSvg(type: ActivityRow['icon']): string {
    if (type === 'run') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 4a1 1 0 100-2 1 1 0 000 2z" fill="var(--c-accent)" stroke="none"/><path d="M6.5 20l3-5.5 2.5 2 3.5-7 2.5 4.5"/></svg>`;
    if (type === 'gym') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-muted)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>`;
    if (type === 'swim') return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c1.5 0 3-1 4.5-1s3 1 4.5 1 3-1 4.5-1 3 1 4.5 1M3 12c1.5 0 3-1 4.5-1s3 1 4.5 1 3-1 4.5-1 3 1 4.5 1"/></svg>`;
    return `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="var(--c-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>`;
  }

  const rowsHtml = rows.map(r => `
    <div class="m-list-item${r.workoutKey ? ' home-act-row' : ''}"
      data-activity-id="${r.id}"
      ${r.workoutKey ? `data-workout-key="${r.workoutKey}" data-week-num="${r.weekNum}"` : ''}
      style="cursor:${r.workoutKey ? 'pointer' : 'default'}">
      <div style="width:34px;height:34px;border-radius:50%;background:${r.icon === 'run' ? 'rgba(78,159,229,0.08)' : 'rgba(0,0,0,0.05)'};display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${iconSvg(r.icon)}
      </div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:400;letter-spacing:-0.01em;margin-bottom:1px">${r.name}</div>
        <div style="font-size:11px;color:var(--c-muted)">${r.sub}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:-0.01em">${r.value}</span>
        ${r.workoutKey ? `<span style="opacity:0.25"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-black)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>` : ''}
      </div>
    </div>
  `).join('');

  return `
    <div class="px-[18px] mb-[14px]">
      <div class="m-sec-label">Recent</div>
      <div class="m-card overflow-hidden">${rowsHtml}</div>
    </div>
  `;
}

function buildSyncActions(s: SimulatorState): string {
  const wk = s.wks?.[s.w - 1];
  const hasPending = (s as any).pendingActivities?.length > 0;
  const allRated = wk
    ? Object.values(wk.rated || {}).filter(v => (typeof v === 'number' && v > 0) || v === 'skip').length >= (s.rw || 5)
    : false;

  const buttons: string[] = [];
  if (hasPending) {
    buttons.push(`<button id="home-sync-btn" class="m-btn-secondary flex-1">↻ Sync Activities</button>`);
  }
  if (allRated && !(wk as any)?.weekCompleted) {
    buttons.push(`<button id="home-complete-week-btn" class="m-btn-secondary flex-1">✓ Complete Week</button>`);
  }
  if (buttons.length === 0) return '';

  return `
    <div class="px-[18px] mb-[14px] flex gap-[10px]">
      ${buttons.join('')}
    </div>
  `;
}

// ─── Main render ────────────────────────────────────────────────────────────

function getHomeHTML(s: SimulatorState): string {
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      <!-- Header -->
      <div style="padding:14px 18px 10px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:24px;font-weight:600;letter-spacing:-0.03em;color:var(--c-black);line-height:1.1">Mosaic</div>
          ${s.w && s.tw ? `<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-top:2px">Week ${s.w} of ${s.tw}${s.wks?.[s.w - 1]?.ph ? ` · ${s.wks[s.w - 1].ph.charAt(0).toUpperCase() + s.wks[s.w - 1].ph.slice(1)}` : ''}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button id="home-injured-btn" style="height:32px;padding:0 10px;border-radius:16px;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;gap:5px;font-size:11px;font-weight:600;cursor:pointer;color:var(--c-black);font-family:var(--f)">🩹 Report Injury</button>
          <button id="home-account-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:0.02em;cursor:pointer;color:var(--c-black);font-family:var(--f)">${initials || 'Me'}</button>
        </div>
      </div>

      ${buildProgressBars(s)}
      ${buildReadinessRing(s)}
      ${buildTodayWorkout(s)}
      ${buildRaceCountdown(s)}
      ${buildSyncActions(s)}
      ${buildRecentActivity(s)}

    </div>
    ${renderTabBar('home', isSimulatorMode())}
  `;
}

function wireHomeHandlers(): void {
  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Account button
  document.getElementById('home-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Injured button
  document.getElementById('home-injured-btn')?.addEventListener('click', () => {
    import('./injury/modal').then(({ openInjuryModal }) => openInjuryModal());
  });

  // Start workout button — launches structured GPS tracking for the selected workout
  document.getElementById('home-start-btn')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    const name = btn.getAttribute('data-name') || 'Workout';
    const desc = btn.getAttribute('data-desc') || '';
    if (window.trackWorkout) {
      window.trackWorkout(name, desc);
    } else {
      import('./record-view').then(({ renderRecordView }) => renderRecordView());
    }
  });

  // View plan button (from workout hero)
  document.getElementById('home-view-plan-btn')?.addEventListener('click', () => {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });

  // Sync button → go to plan (which has sync)
  document.getElementById('home-sync-btn')?.addEventListener('click', () => {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  });

  // Complete week button
  document.getElementById('home-complete-week-btn')?.addEventListener('click', () => {
    next();
  });

  // Readiness ring — tap toggles pills open/closed
  const readinessCard = document.getElementById('home-readiness-card');
  const readinessPills = document.getElementById('home-readiness-pills');
  if (readinessCard && readinessPills) {
    readinessCard.addEventListener('click', () => {
      readinessPills.style.display = readinessPills.style.display === 'none' ? 'block' : 'none';
    });
  }

  // Pill info sheets — each pill opens a detail sheet; stop propagation so card doesn't toggle
  document.querySelectorAll<HTMLElement>('.home-readiness-pill[data-pill]').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const signal = pill.dataset.pill as PillSignal;
      const s2 = getState();
      const tier2 = s2.athleteTierOverride ?? s2.athleteTier;
      const atlSeed2 = (s2.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s2.gs ?? 0), 0.3));
      const acwr2 = computeACWR(s2.wks ?? [], s2.w, tier2, s2.ctlBaseline ?? undefined, s2.planStartDate, atlSeed2);
      const sameSignal2 = computeSameSignalTSB(s2.wks ?? [], s2.w, s2.ctlBaseline ?? undefined, s2.planStartDate);
      const tsb2 = sameSignal2?.tsb ?? 0;
      const ctlNow2 = sameSignal2?.ctl ?? 0;
      const metrics2 = computeFitnessModel(s2.wks ?? [], s2.w, s2.ctlBaseline ?? undefined, s2.planStartDate, atlSeed2);
      const fourBack2 = metrics2[metrics2.length - 5];
      const ctlFourWeeksAgo2 = fourBack2?.ctl ?? ctlNow2;
      const today2 = new Date().toISOString().split('T')[0];
      const manualToday2 = s2.lastRecoveryPromptDate === today2
        ? (s2.recoveryHistory ?? []).slice().reverse().find((e: any) => e.date === today2 && e.source === 'manual')
        : undefined;
      const latestPhysio2 = s2.physiologyHistory?.slice(-1)[0];
      const sleepScore2: number | null = manualToday2?.sleepScore ?? latestPhysio2?.sleepScore ?? null;
      const hrvRmssd2: number | null = latestPhysio2?.hrvRmssd ?? null;
      const hrvAll2 = (s2.physiologyHistory ?? []).map((p: any) => p.hrvRmssd).filter((v: any) => v != null) as number[];
      const hrvPersonalAvg2: number | null = hrvAll2.length >= 3
        ? Math.round(hrvAll2.reduce((a: number, b: number) => a + b, 0) / hrvAll2.length) : null;
      const readiness2 = computeReadiness({
        tsb: tsb2, acwr: acwr2.ratio, ctlNow: ctlNow2, ctlFourWeeksAgo: ctlFourWeeksAgo2,
        sleepScore: sleepScore2, hrvRmssd: hrvRmssd2, hrvPersonalAvg: hrvPersonalAvg2,
        weeksOfHistory: metrics2.length,
      });
      let rhrCaption2 = '';
      let rhrRawBpm2: number | null = null;
      let rhrTrend2 = '';
      if (latestPhysio2?.restingHR != null) {
        const rhrVals = (s2.physiologyHistory ?? []).map((p: any) => p.restingHR).filter((v: any) => v != null) as number[];
        const rhrAvg2 = rhrVals.length > 1 ? Math.round(rhrVals.slice(0, -1).reduce((a: number, b: number) => a + b, 0) / (rhrVals.length - 1)) : null;
        const rhrDiff2 = rhrAvg2 != null ? latestPhysio2.restingHR - rhrAvg2 : 0;
        rhrTrend2 = rhrDiff2 > 2 ? '↑' : rhrDiff2 < -2 ? '↓' : '';
        rhrRawBpm2 = latestPhysio2.restingHR;
        rhrCaption2 = `RHR: ${latestPhysio2.restingHR}bpm${rhrTrend2 ? ' ' + rhrTrend2 : ''} · `;
      }
      const tsbZone2 = tsb2 > 0 ? 'Fresh' : tsb2 >= -10 ? 'Recovering' : tsb2 >= -25 ? 'Fatigued' : 'Overtrained';
      const safetyLabel2 = acwr2.ratio <= 0 ? '—' : acwr2.status === 'safe' ? 'Safe' : acwr2.status === 'caution' ? 'Elevated' : 'High Risk';
      const momentumArrow2 = ctlNow2 > ctlFourWeeksAgo2 ? '↗' : ctlNow2 > ctlFourWeeksAgo2 * 0.95 ? '→' : '↘';
      const recoveryResult2 = computeRecoveryScore(s2.physiologyHistory ?? []);
      showReadinessPillSheet(signal, {
        tsb: tsb2, tsbZone: tsbZone2, tsbLabel: tsb2 > 0 ? `+${Math.round(tsb2)}` : `${Math.round(tsb2)}`,
        fitnessScore: readiness2.fitnessScore,
        acwrRatio: acwr2.ratio, safetyLabel: safetyLabel2,
        ctlNow: ctlNow2, ctlFourWeeksAgo: ctlFourWeeksAgo2, momentumArrow: momentumArrow2,
        recoveryScore: readiness2.recoveryScore, sleepScore: sleepScore2,
        rhrCaption: rhrCaption2, hasRecovery: readiness2.hasRecovery,
        recoveryHasData: recoveryResult2.hasData,
        recoveryCompositeScore: recoveryResult2.score,
        sleepSubScore: recoveryResult2.sleepScore,
        hrvSubScore: recoveryResult2.hrvScore,
        rhrSubScore: recoveryResult2.rhrScore,
        rhrRawBpm: rhrRawBpm2,
        rhrTrend: rhrTrend2,
      });
    });
  });

  // Adjust session button — shown when readiness ≤ 59
  document.getElementById('readiness-adjust-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const s2 = getState();
    const wk2 = s2.wks?.[s2.w - 1];
    const hasUnrated = (wk2?.unspentLoadItems?.length ?? 0) > 0
      || (wk2?.workoutMods?.some(m => !m.status) ?? false);
    if (hasUnrated || true) {
      // Route through ACWR reduction modal (handles swap/reduce logic)
      import('./main-view').then(({ triggerACWRReduction }) => triggerACWRReduction());
    }
  });

  // TSS row → load breakdown sheet
  document.getElementById('home-tss-row')?.addEventListener('click', () => {
    const s = getState();
    showLoadBreakdownSheet(s, s.w);
  });

  // Recent activity click-through → activity detail page
  document.querySelectorAll<HTMLElement>('.home-act-row').forEach(el => {
    el.addEventListener('click', async () => {
      const workoutKey = el.dataset.workoutKey || '';
      const weekNum = parseInt(el.dataset.weekNum || '0', 10);
      if (!workoutKey || !weekNum) return;
      const s2 = getState();
      const actual = s2.wks?.[weekNum - 1]?.garminActuals?.[workoutKey];
      if (!actual) return;
      const { renderActivityDetail } = await import('./activity-detail');
      renderActivityDetail(actual, actual.workoutName || actual.displayName || workoutKey, 'home');
    });
  });
}

export function renderHomeView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  container.innerHTML = getHomeHTML(s);
  wireHomeHandlers();
  setOnWeekAdvance(() => {
    window.location.reload();
  });
}

// ─── Sleep detail sheet ───────────────────────────────────────────────────────

export function showSleepSheet(physiologyHistory: PhysiologyDayEntry[], wks: any[]): void {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4';

  const withScores = physiologyHistory.filter(d => d.sleepScore != null).slice(-7);
  const latest = withScores[withScores.length - 1] ?? null;

  // Stale data detection
  const today = new Date().toISOString().split('T')[0];
  const latestDate = latest?.date ?? null;
  const daysSinceSync = latestDate
    ? Math.floor((new Date(today).getTime() - new Date(latestDate + 'T12:00:00').getTime()) / 86400000)
    : null;
  const isStale = daysSinceSync != null && daysSinceSync >= 2;

  const bigScore = latest?.sleepScore != null ? Math.round(latest.sleepScore) : null;
  const headlineColor = bigScore != null ? sleepScoreColor(bigScore) : 'var(--c-faint)';
  const scoreLabel = bigScore != null ? sleepScoreLabel(bigScore) : null;
  const durationStr = latest?.sleepDurationSec ? fmtSleepDuration(latest.sleepDurationSec) : null;

  // Contextualisation vs personal history + population target
  const ctx = latest != null ? getSleepContext(physiologyHistory, latest) : null;
  const durationAvgStr  = ctx?.durationAvgSec  ? fmtSleepDuration(ctx.durationAvgSec)  : null;
  const durationBestStr = ctx?.durationBestSec ? fmtSleepDuration(ctx.durationBestSec) : null;
  const durationTargetLabel = ctx?.durationVsTarget === 'optimal' ? 'In target range (7–9h)'
    : ctx?.durationVsTarget === 'short' ? 'Below target (< 7h)'
    : ctx?.durationVsTarget === 'long'  ? 'Exceeds target (> 9h)'
    : null;
  const durationVsAvgLabel = ctx?.durationVsAvg === 'above' ? 'Above your recent avg'
    : ctx?.durationVsAvg === 'below' ? 'Below your recent avg'
    : ctx?.durationVsAvg === 'on_par' ? 'On par with recent avg'
    : null;
  const scoreVsAvgLabel = ctx?.scoreVsAvg === 'above' ? 'Sleeping better than your weekly avg'
    : ctx?.scoreVsAvg === 'below' ? 'Sleeping below your weekly avg'
    : ctx?.scoreVsAvg === 'on_par' ? 'On par with your weekly avg'
    : null;
  const durationTargetColor = ctx?.durationVsTarget === 'optimal' ? 'var(--c-ok)'
    : ctx?.durationVsTarget === 'short' ? 'var(--c-caution)' : 'var(--c-warn)';

  // Stage progress bars
  const stageBar = (stageName: string, sec: number | null | undefined, totalSec: number | null | undefined, color: string) => {
    if (!sec || !totalSec) return '';
    const pct = Math.round((sec / totalSec) * 100);
    const dur = fmtSleepDuration(sec);
    const barColor = stageName === 'Awake' && pct > 15 ? 'var(--c-warn)' : color;
    return `
      <div style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <span style="font-size:12px;font-weight:600;color:var(--c-black)">${stageName}</span>
          <span style="font-size:12px;color:var(--c-muted)">${dur} · ${pct}%</span>
        </div>
        <div style="height:6px;border-radius:3px;background:rgba(0,0,0,0.07)">
          <div style="height:6px;border-radius:3px;width:${Math.min(100, pct)}%;background:${barColor}"></div>
        </div>
      </div>`;
  };
  // Derive light sleep if we have enough data
  const lightSec = (latest?.sleepDurationSec && latest?.sleepDeepSec != null && latest?.sleepRemSec != null && latest?.sleepAwakeSec != null)
    ? Math.max(0, latest.sleepDurationSec - (latest.sleepDeepSec ?? 0) - (latest.sleepRemSec ?? 0) - (latest.sleepAwakeSec ?? 0))
    : null;

  const deepBar  = stageBar('Deep',  latest?.sleepDeepSec,  latest?.sleepDurationSec, 'var(--c-accent)');
  const remBar   = stageBar('REM',   latest?.sleepRemSec,   latest?.sleepDurationSec, '#A855F7');
  const lightBar = stageBar('Light', lightSec,              latest?.sleepDurationSec, 'rgba(78,159,229,0.60)');
  const awakeBar = stageBar('Awake', latest?.sleepAwakeSec, latest?.sleepDurationSec, 'rgba(0,0,0,0.30)');

  const hasAnyStages = !!(latest?.sleepDeepSec || latest?.sleepRemSec || latest?.sleepAwakeSec || latest?.sleepDurationSec);
  const stagesPlaceholder = (bigScore != null && !hasAnyStages)
    ? `<div style="margin-top:10px;padding:8px 10px;border-radius:6px;background:rgba(0,0,0,0.04);font-size:11px;color:var(--c-faint);line-height:1.5">Duration and stage breakdown will appear after your next Garmin Connect sync.</div>`
    : '';

  // 7-night bar chart
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const barEntries = withScores.map((e, i) => ({
    value: e.sleepScore != null ? Math.round(e.sleepScore) : null,
    day: DAYS[new Date(e.date + 'T12:00:00').getDay()],
    isLatest: i === withScores.length - 1,
    subLabel: e.sleepDurationSec ? fmtSleepDuration(e.sleepDurationSec) : null,
  }));
  const barChart = withScores.length >= 2 ? buildBarChart(barEntries, sleepScoreColor) : '';

  const insight = getSleepInsight({
    history: physiologyHistory,
    recentWeeklyTSS: wks.slice(-4).map((w: any) => w.actualTSS ?? 0),
  });

  overlay.innerHTML = `
    <div class="rounded-2xl w-full max-w-lg" style="background:var(--c-surface);max-height:85vh;overflow-y:auto">
      <div class="px-4 pt-4 pb-3 border-b flex items-center justify-between" style="border-color:var(--c-border)">
        <div>
          <h2 class="font-semibold" style="color:var(--c-black)">Sleep</h2>
          <p style="font-size:12px;color:var(--c-muted);margin-top:1px">From Garmin Connect</p>
        </div>
        <button id="sleep-sheet-close" class="text-xl leading-none" style="color:var(--c-muted)">&#10005;</button>
      </div>
      <div class="px-4 py-4">

        ${isStale ? `
          <div style="margin-bottom:14px;padding:10px 12px;border-radius:8px;background:rgba(255,159,10,0.08);border:1px solid rgba(255,159,10,0.20)">
            <p style="font-size:12px;color:var(--c-caution);line-height:1.4;margin:0">Data last synced ${fmtDateUK(latestDate!)}. Open Garmin Connect and resync to update.</p>
          </div>` : ''}

        ${bigScore != null ? `
          <div style="display:flex;gap:16px;margin-bottom:4px">
            <div style="flex:1">
              <div style="font-size:38px;font-weight:300;line-height:1;color:${headlineColor}">${bigScore}<span style="font-size:16px;color:var(--c-faint);margin-left:2px">/100</span></div>
              <div style="font-size:11px;font-weight:600;color:${headlineColor};margin-top:3px">${scoreLabel}</div>
              ${ctx?.scoreAvg != null ? `<div style="font-size:11px;color:var(--c-muted);margin-top:5px">Avg: ${ctx.scoreAvg} \u00b7 Best: ${ctx.scoreBest}</div>` : ''}
              ${scoreVsAvgLabel ? `<div style="font-size:10px;color:var(--c-faint);margin-top:1px">${scoreVsAvgLabel}</div>` : ''}
            </div>
            ${durationStr ? `
            <div style="flex:1;text-align:right">
              <div style="font-size:30px;font-weight:300;line-height:1;color:var(--c-black)">${durationStr}</div>
              ${durationTargetLabel ? `<div style="font-size:11px;font-weight:600;color:${durationTargetColor};margin-top:3px">${durationTargetLabel}</div>` : ''}
              ${durationAvgStr ? `<div style="font-size:11px;color:var(--c-muted);margin-top:5px">Avg: ${durationAvgStr}${durationBestStr ? ` \u00b7 Best: ${durationBestStr}` : ''}</div>` : ''}
              ${durationVsAvgLabel ? `<div style="font-size:10px;color:var(--c-faint);margin-top:1px">${durationVsAvgLabel}</div>` : ''}
            </div>` : ''}
          </div>

          ${deepBar}${remBar}${lightBar}${awakeBar}
          ${stagesPlaceholder}
        ` : `
          <div style="padding:12px 0;color:var(--c-faint);font-size:13px">Sleep score not yet available \u2014 Garmin usually syncs within a few hours of waking.</div>
        `}

        ${barChart ? `
          <div style="margin-top:20px">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:var(--c-faint);margin-bottom:10px">Last ${withScores.length} nights</div>
            ${barChart}
          </div>` : ''}

        ${insight ? `
          <div style="margin-top:14px;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.04);font-size:12px;color:var(--c-muted);line-height:1.5">${insight}</div>` : ''}

      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#sleep-sheet-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}
