/**
 * Recent weeks drill-down. Tapped from the aggregate summary card on the
 * triathlon Stats page.
 *
 * Layout (top to bottom):
 *  1. Trend card. Three mini bar charts (Hours / Sessions / TSS), one bar
 *     per week, latest on the right. Uses the canonical `buildBarChart`
 *     helper so the look matches sleep / HRV / RHR charts elsewhere.
 *  2. Per-week list. Done vs planned hours / sessions / TSS, one row per
 *     week, tap a row to open that week's plan view.
 *
 * Charts (Total weekly load + per-discipline km) used to live here too, but
 * Total moved into the unified "Weekly load (TSS)" chart on the Stats page
 * and the km cards were dropped as redundant. Composite TSS already covers
 * load, and Recent weeks per-week rows show sessions instead of distance.
 *
 * Page-flair shell mirrors the benchmark drill-downs (CSS / FTP / VO2 / LT):
 * warm-cream base + sky-tinted scroll atmosphere + sun glint, centred hero
 * with a plain "← Back" pill, glassy nested cards on the content area.
 */

import { getState } from '@/state/store';
import type { SimulatorState } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { buildScrollAtmosphereBackground, buildSunGlint } from '../page-flair';
import { animateChartDrawOn } from './benchmark-charts';
import { summarizeWeekActuals, renderTriathlonPlanViewAtWeek } from './plan-view';
import { disciplineOf, forEachActual, iTrimpToTSS } from './progress-detail-view';

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('../home-view').then(({ renderHomeView }) => renderHomeView());
  else if (tab === 'plan') import('../main-view').then(({ renderMainView }) => renderMainView());
  else if (tab === 'forecast') import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  else if (tab === 'account') import('../account-view').then(({ renderAccountView }) => renderAccountView());
  else if (tab === 'stats') import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
}

function fmtHM(mins: number): string {
  if (mins <= 0) return '0h';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function estimateWorkoutMin(w: any): number {
  if (typeof w.estimatedDurationMin === 'number' && w.estimatedDurationMin > 0) return w.estimatedDurationMin;
  if (w.brickSegments) return (w.brickSegments[0]?.durationMin ?? 0) + (w.brickSegments[1]?.durationMin ?? 0);
  const d = String(w.d || '');
  const hm = d.match(/(\d+)\s*h\s*(\d+)\s*min/i);
  if (hm) return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
  const ms = Array.from(d.matchAll(/(\d+)\s*min/g)) as RegExpMatchArray[];
  if (!ms.length) return 60;
  return ms.reduce((acc, m) => Math.max(acc, parseInt(m[1], 10)), 0);
}

interface RecentWindow {
  startIdx: number;
  endIdx: number;
}

/** Last `windowWeeks` completed-or-in-progress plan weeks. */
function recentWindow(s: SimulatorState, windowWeeks = 4): RecentWindow | null {
  const wks = s.wks ?? [];
  if (wks.length === 0 || !s.w) return null;
  const endIdx = Math.min(s.w - 1, wks.length - 1);
  const startIdx = Math.max(0, endIdx - (windowWeeks - 1));
  return { startIdx, endIdx };
}

interface AggregateTotals {
  min: number;
  count: number;
  tss: number;
  weeksCovered: number;
}

export function aggregateRecentWeeks(s: SimulatorState, windowWeeks = 4): AggregateTotals | null {
  const win = recentWindow(s, windowWeeks);
  if (!win) return null;
  const wks = s.wks ?? [];
  let min = 0, count = 0, tss = 0;
  for (let i = win.startIdx; i <= win.endIdx; i++) {
    const wk = wks[i];
    if (!wk) continue;
    const done = summarizeWeekActuals((wk as any).garminActuals ?? {});
    min += done.min;
    count += done.count;
    tss += done.tss;
  }
  return { min, count, tss, weeksCovered: win.endIdx - win.startIdx + 1 };
}

// ────────────────────────────────────────────────────────────────────────────
// Per-week list. Same rows that used to render on the Stats page
// ────────────────────────────────────────────────────────────────────────────

function buildPerWeekList(s: SimulatorState): string {
  const wks = s.wks ?? [];
  if (wks.length === 0 || !s.w) return '';

  const endIdx = Math.min(s.w - 1, wks.length - 1);
  const startIdx = Math.max(0, endIdx - 7); // last 8 weeks

  const rows: string[] = [];
  for (let i = endIdx; i >= startIdx; i--) {
    const wk = wks[i];
    if (!wk) continue;
    const wkNum = i + 1;
    const isCurrent = wkNum === s.w;
    const workouts = ((wk as any).triWorkouts ?? []) as any[];
    const plannedMin = workouts.reduce((acc, w) => acc + estimateWorkoutMin(w), 0);
    const plannedSessions = workouts.length;
    const plannedTss = workouts.reduce((acc, w) => acc + (w.aerobic ?? 0) + (w.anaerobic ?? 0), 0);
    const done = summarizeWeekActuals((wk as any).garminActuals ?? {});
    const phase = wk.ph ? wk.ph.charAt(0).toUpperCase() + wk.ph.slice(1) : '';
    const tag = isCurrent ? 'This week' : phase;

    rows.push(`
      <div data-tri-recent-week="${wkNum}" style="display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid rgba(0,0,0,0.05);cursor:pointer">
        <div style="min-width:42px">
          <div style="font-size:13px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">Wk ${wkNum}</div>
          ${tag ? `<div style="font-size:10px;color:var(--c-faint);margin-top:1px">${tag}</div>` : ''}
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-variant-numeric:tabular-nums">
          <div>
            <div style="font-size:13px;font-weight:600;color:#0F172A">${fmtHM(done.min)}</div>
            <div style="font-size:10px;color:var(--c-faint)">of ${fmtHM(plannedMin)}</div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:600;color:#0F172A">${done.count} / ${plannedSessions}</div>
            <div style="font-size:10px;color:var(--c-faint)">sessions</div>
          </div>
          <div>
            <div style="font-size:13px;font-weight:600;color:#0F172A">${Math.round(done.tss)}</div>
            <div style="font-size:10px;color:var(--c-faint)">of ${Math.round(plannedTss)} TSS</div>
          </div>
        </div>
        <svg style="color:var(--c-faint)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
      </div>
    `);
  }

  if (rows.length === 0) return '';

  return `
    <div class="m-card" style="padding:6px 14px;margin-bottom:10px">
      ${rows.join('')}
    </div>
  `;
}

// ────────────────────────────────────────────────────────────────────────────
// Trend card. Three stacked bar charts (Hours / Sessions / TSS) split by
// discipline (Swim / Bike / Run / Other). Each bar is one week of completed
// training, latest on the right. Discipline colours mirror the unified load
// chart on the Stats page so the two views read as one system.
// ────────────────────────────────────────────────────────────────────────────

// Discipline palette mirrors `DISCIPLINE_COLOURS` in `colours.ts`. // Swim blue / bike red / run green (Tristan 2026-05-20). Other = light
// slate so cross-training quiets visually (it's a catch-all, not a primary
// signal). Per-discipline label colour ensures contrast holds on the
// light Other segments.
const DISC_COLORS = {
  swim:  '#3B82F6',
  bike:  '#DC2626',
  run:   '#16A34A',
  other: '#94A3B8',
} as const;
const DISC_LABEL_COLORS = {
  swim:  '#FFFFFF',
  bike:  '#FFFFFF',
  run:   '#FFFFFF',
  other: '#1F2937',
} as const;

const DISC_LABELS = {
  swim: 'Swim',
  bike: 'Bike',
  run: 'Run',
  other: 'Other',
} as const;

type DiscKey = keyof typeof DISC_COLORS;

interface WeekDiscStack {
  swim: number;
  bike: number;
  run: number;
  other: number;
  /** Total = swim + bike + run + other. */
  total: number;
  wkNum: number;
  isCurrent: boolean;
}

/** Per-week stack of {swim,bike,run,other} totals for the given metric. */
function buildWeekStacks(
  s: SimulatorState,
  metric: 'min' | 'count' | 'tss',
): WeekDiscStack[] {
  const wks = s.wks ?? [];
  if (wks.length === 0 || !s.w) return [];
  const endIdx = Math.min(s.w - 1, wks.length - 1);
  const startIdx = Math.max(0, endIdx - 7);

  const out: WeekDiscStack[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const wk = wks[i];
    if (!wk) continue;
    const wkNum = i + 1;
    const stack: WeekDiscStack = {
      swim: 0, bike: 0, run: 0, other: 0, total: 0,
      wkNum, isCurrent: wkNum === s.w,
    };
    forEachActual(wk, a => {
      const d = disciplineOf(a);
      const bucket: DiscKey = d ?? 'other';
      const value = metric === 'min' ? ((a.durationSec ?? 0) / 60)
        : metric === 'count' ? 1
        : iTrimpToTSS(a.iTrimp);
      stack[bucket] += value;
    });
    stack.total = stack.swim + stack.bike + stack.run + stack.other;
    out.push(stack);
  }
  return out;
}

/** ThinkCell-style stacked vertical bar chart. One bar per week, segments
 * stack proportionally by discipline. Each segment carries a small white
 * label with its value (when tall enough to fit), with thin white gaps
 * between segments acting as visual separators. Total label sits above
 * each bar. Current week's bar uses a darker bottom rail to mark it.
 *
 * @param segmentLabel  How to render the in-segment value (e.g. "1.2" for
 *                      hours, integer for sessions/TSS). Distinct from
 *                      `totalLabel` so the unit suffix on the total ("h",
 *                      "TSS") doesn't repeat inside every segment. */
function buildStackedBarChart(
  stacks: WeekDiscStack[],
  totalLabel: (v: number) => string,
  segmentLabel: (v: number) => string,
): string {
  if (stacks.length < 2) return '<span style="font-size:11px;color:var(--c-faint)">Building history…</span>';

  const BAR_MAX = 92;
  const maxTotal = Math.max(...stacks.map(s => s.total), 1);
  const order: DiscKey[] = ['swim', 'bike', 'run', 'other'];
  const SEP_PX = 2;          // white gap between segments
  const MIN_LABEL_PX = 14;   // skip in-segment label if segment is too small

  const barRow = stacks.map(s => {
    const totalPx = s.total > 0 ? Math.max(3, Math.round((s.total / maxTotal) * BAR_MAX)) : 3;
    const present = s.total > 0 ? order.filter(k => s[k] > 0) : [];

    // Allocate pixel heights per segment. Subtract separator gaps from the
    // pool before distributing so the bar height matches the value mapping.
    const gapsPx = Math.max(0, (present.length - 1) * SEP_PX);
    const innerPx = Math.max(present.length, totalPx - gapsPx);
    const segPx: number[] = present.map(k => Math.max(1, Math.round((s[k] / s.total) * innerPx)));

    const segments = s.total > 0
      ? present.map((k, idx) => {
          const px = segPx[idx];
          const isTop = idx === present.length - 1;
          const isBottom = idx === 0;
          const radius = `${isTop ? 3 : 0}px ${isTop ? 3 : 0}px ${isBottom ? 2 : 0}px ${isBottom ? 2 : 0}px`;
          const gap = isTop ? '' : `margin-top:${SEP_PX}px;`;
          const showLabel = px >= MIN_LABEL_PX;
          const labelText = showLabel ? segmentLabel(s[k]) : '';
          const label = labelText
            ? `<span style="font-size:9px;font-weight:600;color:${DISC_LABEL_COLORS[k]};line-height:1;font-variant-numeric:tabular-nums;letter-spacing:0">${labelText}</span>`
            : '';
          return `<div style="height:${px}px;background:${DISC_COLORS[k]};border-radius:${radius};${gap}display:flex;align-items:center;justify-content:center;overflow:hidden">${label}</div>`;
        })
          .reverse()
          .join('')
      : `<div style="height:3px;background:#E2E8F0;border-radius:3px 3px 0 0"></div>`;

    const value = s.total > 0 ? totalLabel(s.total) : '';
    const valueLabel = value
      ? `<div style="text-align:center;font-size:10px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums;line-height:1;margin-bottom:6px">${value}</div>`
      : `<div style="height:10px;margin-bottom:6px"></div>`;
    const currentRail = s.isCurrent
      ? `<div style="height:2px;background:#0F172A;border-radius:0 0 2px 2px;margin-top:1px"></div>`
      : '';

    return `
      <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end">
        ${valueLabel}
        <div style="display:flex;flex-direction:column">${segments}</div>
        ${currentRail}
      </div>`;
  }).join('');

  const dayRow = stacks.map(s => `
    <div style="flex:1;text-align:center;font-size:10px;color:${s.isCurrent ? '#0F172A' : 'var(--c-muted)'};font-weight:${s.isCurrent ? '600' : '400'};letter-spacing:0">
      Wk ${s.wkNum}
    </div>
  `).join('');

  // Mean reference line. Faint dashed horizontal across the bar area at the
  // average of completed weeks (excluding the in-progress current week so the
  // mean isn't dragged down by a partial week). Sits behind the bars; gives
  // an at-a-glance sense of which weeks are above / below typical.
  const completedTotals = stacks.filter(s => !s.isCurrent).map(s => s.total);
  const mean = completedTotals.length > 0
    ? completedTotals.reduce((a, b) => a + b, 0) / completedTotals.length
    : 0;
  const meanPx = mean > 0 && maxTotal > 0
    ? Math.round((mean / maxTotal) * BAR_MAX)
    : 0;
  // Bar area lives in the bottom of a (BAR_MAX + 16)-tall row. 16 = Value
  // label (10) + its margin-bottom (6). The reference line sits at meanPx
  // above the row's bottom.
  const meanLine = meanPx > 4
    ? `<div style="position:absolute;left:0;right:0;bottom:${meanPx}px;height:0;border-top:1px dashed rgba(15,23,42,0.18);pointer-events:none"></div>`
    : '';

  return `
    <div>
      <div style="position:relative;display:flex;gap:8px;align-items:flex-end;min-height:${BAR_MAX + 16}px">
        ${meanLine}
        ${barRow}
      </div>
      <div style="display:flex;gap:8px;margin-top:8px">${dayRow}</div>
    </div>
  `;
}

function buildDisciplineLegend(): string {
  const chip = (k: DiscKey) => `
    <span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#475569">
      <span style="width:8px;height:8px;border-radius:2px;background:${DISC_COLORS[k]}"></span>${DISC_LABELS[k]}
    </span>`;
  return `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:18px">${chip('swim')}${chip('bike')}${chip('run')}${chip('other')}</div>`;
}

function buildTrendCard(s: SimulatorState): string {
  const wks = s.wks ?? [];
  if (wks.length === 0 || !s.w) return '';

  const hourStacks = buildWeekStacks(s, 'min');
  const sessionStacks = buildWeekStacks(s, 'count');
  const tssStacks = buildWeekStacks(s, 'tss');

  if (hourStacks.length < 2) return '';

  const fmtHoursTotal = (totalMin: number) => {
    const m = Math.round(totalMin);
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h === 0) return `${mm}m`;
    if (mm === 0) return `${h}h`;
    return `${h}h${mm.toString().padStart(2, '0')}`;
  };
  // In-segment hours: compact decimal (e.g. "1.5", "0.8"): no unit because
  // the section label ("Hours") already supplies it.
  const fmtHoursSegment = (minPerDisc: number) => {
    const h = minPerDisc / 60;
    if (h >= 10) return Math.round(h).toString();
    return h.toFixed(1).replace(/\.0$/, '');
  };
  const fmtInt = (v: number) => String(Math.round(v));

  const section = (label: string, chart: string, last = false) => `
    <div style="margin-bottom:${last ? '0' : '22px'}">
      <div style="font-size:11px;font-weight:500;color:var(--c-muted);margin-bottom:10px;letter-spacing:0">${label}</div>
      ${chart}
    </div>`;

  return `
    <div class="m-card" style="padding:20px;margin-bottom:10px">
      <div style="font-size:14px;font-weight:600;color:#0F172A;margin-bottom:4px">Last ${hourStacks.length} weeks</div>
      <div style="font-size:11px;color:var(--c-faint);margin-bottom:18px">Dashed line is your ${hourStacks.length - 1}-week average.</div>
      ${buildDisciplineLegend()}
      ${section('Hours', buildStackedBarChart(hourStacks, fmtHoursTotal, fmtHoursSegment))}
      ${section('Sessions', buildStackedBarChart(sessionStacks, fmtInt, fmtInt))}
      ${section('TSS', buildStackedBarChart(tssStacks, fmtInt, fmtInt), true)}
    </div>
  `;
}

// ────────────────────────────────────────────────────────────────────────────
// Page render
// ────────────────────────────────────────────────────────────────────────────

export function renderTriRecentWeeksView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  if (!s.triConfig) return;

  container.innerHTML = `
    <style>
      @keyframes floatUpRW {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .rw-hf { opacity:0; animation:floatUpRW 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .rw-glass .m-card {
        background: rgba(255, 255, 255, 0.78);
        backdrop-filter: blur(16px) saturate(1.2);
        -webkit-backdrop-filter: blur(16px) saturate(1.2);
        border: 1px solid rgba(255, 255, 255, 0.55);
        box-shadow:
          0 1px 2px rgba(15, 23, 42, 0.04),
          0 12px 32px rgba(15, 23, 42, 0.06),
          inset 0 1px 0 rgba(255, 255, 255, 0.5);
      }
    </style>
    <div class="mosaic-page" style="background:#FAF9F6;position:relative;min-height:100vh">
      ${buildScrollAtmosphereBackground('rw', 'sky', { haloCenter: { cx: 200, cy: 200 } })}
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div style="padding:max(20px, env(safe-area-inset-top)) 20px 0;display:flex;align-items:center" class="rw-hf" data-delay="0.02">
          <button id="rw-back-btn" style="background:transparent;border:none;font-size:14px;color:var(--c-muted);cursor:pointer;padding:8px 0;font-family:var(--f)">← Back</button>
        </div>

        <div class="rw-hf" data-delay="0.06" style="text-align:center;padding:18px 20px 20px">
          <div style="font-size:28px;font-weight:700;color:#0F172A;letter-spacing:-0.02em;line-height:1">Recent weeks</div>
          <div style="font-size:12px;color:#64748B;margin-top:8px;max-width:440px;margin-left:auto;margin-right:auto;line-height:1.5">Per-week training breakdown. Done vs planned hours, sessions, and TSS. Tap a week to open its plan view.</div>
        </div>

        <div class="rw-hf rw-glass" data-delay="0.10" style="padding:0 18px">
          ${buildTrendCard(s)}
          ${buildPerWeekList(s)}
        </div>

      </div>

      ${renderTabBar('stats')}
    </div>
  `;

  animateChartDrawOn();
  wireTabBarHandlers(navigateTab);

  document.getElementById('rw-back-btn')?.addEventListener('click', () => {
    import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
  });

  // Per-week rows → open that week's plan view
  document.querySelectorAll<HTMLElement>('[data-tri-recent-week]').forEach(el => {
    el.addEventListener('click', () => {
      const wkNum = parseInt(el.getAttribute('data-tri-recent-week') || '0', 10);
      if (!wkNum) return;
      const sv = getState();
      renderTriathlonPlanViewAtWeek(wkNum, sv.w);
    });
  });
}
