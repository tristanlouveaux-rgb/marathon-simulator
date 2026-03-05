/**
 * Stats tab — redesigned light theme.
 * Above fold: 8-week Training Load chart + summary cards.
 * Dig deeper: chart switcher + explainers.
 * Advanced: CTL/ATL/TSB metrics with inline ⓘ explanations.
 * Folded: Race Prediction, Paces, Fitness Trend, Recovery, Phase Timeline.
 */

import { getState } from '@/state';
import type { SimulatorState, PhysiologyDayEntry } from '@/types';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { isSimulatorMode } from '@/main';
import { fp, ft } from '@/utils/format';
import { computeWeekTSS, computeWeekRawTSS, computeFitnessModel, computeACWR, TIER_ACWR_CONFIG } from '@/calculations/fitness-model';
import { fetchExtendedHistory } from '@/data/stravaSync';

// ---------------------------------------------------------------------------
// Navigation

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('./plan-view').then(({ renderPlanView }) => renderPlanView());
  } else if (tab === 'record') {
    import('./record-view').then(({ renderRecordView }) => renderRecordView());
  } else if (tab === 'account') {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  }
}

// ---------------------------------------------------------------------------
// Data helpers

function computeCurrentVDOT(s: SimulatorState): number {
  let wg = 0;
  for (let i = 0; i < s.w - 1; i++) {
    if (s.wks?.[i]) wg += s.wks[i].wkGain;
  }
  return s.v + wg + s.rpeAdj + (s.physioAdj || 0);
}

function last7(
  history: PhysiologyDayEntry[] | undefined,
  field: keyof PhysiologyDayEntry,
): number[] {
  if (!history || history.length === 0) return [];
  return history.slice(-7)
    .map(d => d[field] as number | undefined)
    .filter((v): v is number => typeof v === 'number');
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// Load History Chart (Phase D) — stacked area, aerobic/anaerobic split

type ChartRange = '8w' | '16w' | 'all';

const NON_RUN_KW_CHART = ['cross','gym','strength','rest','yoga','swim','bike','cycl','tennis','hiit','pilates','row','hik','elliptic','walk'];

function runKmFromWeek(wk: import('@/types').Week): number {
  return Object.entries(wk.garminActuals ?? {})
    .filter(([k]) => !NON_RUN_KW_CHART.some(kw => k.toLowerCase().includes(kw)))
    .reduce((sum, [, a]) => sum + ((a as any).distanceKm || 0), 0);
}

function getChartData(s: SimulatorState, range: ChartRange): {
  tss: number[];
  zones: ({ base: number; threshold: number; intensity: number } | null)[];
  km: number[];
  histWeekCount: number;
} {
  const wk = s.wks?.[s.w - 1];
  // Signal B for current week — raw physiological load (no runSpec discount)
  const currentTSS = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  const currentKm = wk ? runKmFromWeek(wk) : 0;

  const useExtended = (range === '16w' || range === 'all') && (s.extendedHistoryTSS?.length ?? 0) > 0;
  // Signal B history: prefer historicWeeklyRawTSS (raw iTRIMP, no runSpec) when available.
  // Fallback: historicWeeklyTSS × 1.4 proxy (sanctioned in PRINCIPLES.md §Signal B history gap).
  // This ensures all bars on the Training Load chart are Signal B — consistent with currentTSS above.
  const histTSSraw = useExtended ? (s.extendedHistoryTSS ?? []) : (s.historicWeeklyTSS ?? []);
  const histRaw    = s.historicWeeklyRawTSS;
  let histTSS    = (histRaw && histRaw.length > 0 && !useExtended)
    ? [...histRaw]
    : histTSSraw.map(v => Math.round(v * 1.4));
  let histKm       = [...(useExtended ? (s.extendedHistoryKm ?? []) : (s.historicWeeklyKm ?? []))];
  let histZonesRaw = [...(useExtended ? (s.extendedHistoryZones ?? []) : (s.historicWeeklyZones ?? []))];

  // Fix 2: slice to the requested range before appending current week.
  // Keeps bar counts consistent with the selected time window.
  const sliceCount = range === '8w' ? 8 : range === '16w' ? 16 : undefined;
  if (sliceCount !== undefined) {
    histTSS      = histTSS.slice(-sliceCount);
    histKm       = histKm.slice(-sliceCount);
    histZonesRaw = histZonesRaw.slice(-sliceCount);
  }

  // Fix 4: for any of the last 4 hist entries that are suspiciously near-zero (< 5 TSS),
  // fall back to live computeWeekRawTSS for the corresponding plan week. This closes the gap
  // where the Strava edge function has not yet bucketed the most recent completed weeks.
  const wks = s.wks ?? [];
  for (let k = 1; k <= Math.min(4, histTSS.length); k++) {
    const idx = histTSS.length - k;
    if (histTSS[idx] < 5) {
      const planWeekIdx = s.w - 1 - k; // 0-based: s.w-1 = current, s.w-1-k = k weeks back
      if (planWeekIdx >= 0 && wks[planWeekIdx]) {
        const pw = wks[planWeekIdx];
        const live = computeWeekRawTSS(pw, pw.rated ?? {}, s.planStartDate);
        if (live > 0) histTSS[idx] = live;
      }
    }
  }

  // Pad zone array to match (possibly sliced + patched) histTSS length.
  const paddedHistZones: ({ base: number; threshold: number; intensity: number } | null)[] =
    histTSS.map((_, i) => histZonesRaw[i] ?? null);

  // Current week zone split — use stored zone fields when available, else proportion-based fallback.
  const currentZone = wk
    ? { base: (wk as any).zoneBase ?? currentTSS * 0.6, threshold: (wk as any).zoneThreshold ?? currentTSS * 0.28, intensity: (wk as any).zoneIntensity ?? currentTSS * 0.12 }
    : { base: 0, threshold: 0, intensity: 0 };

  return {
    tss:   [...histTSS, currentTSS],
    zones: [...paddedHistZones, currentZone],
    km:    [...histKm, currentKm],
    histWeekCount: histTSS.length,
  };
}

/** Build a smooth SVG path through points as cubic bezier segments. */
function smoothAreaPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const c = pts[i];
    const tension = 0.35;
    const cp1x = p[0] + (c[0] - p[0]) * tension;
    const cp2x = c[0] - (c[0] - p[0]) * tension;
    d += ` C ${cp1x.toFixed(1)} ${p[1].toFixed(1)}, ${cp2x.toFixed(1)} ${c[1].toFixed(1)}, ${c[0].toFixed(1)} ${c[1].toFixed(1)}`;
  }
  return d;
}

function buildLoadHistoryChart(s: SimulatorState, range: ChartRange = '8w'): string {
  const data = getChartData(s, range);
  const { tss, zones, km, histWeekCount } = data;
  const n = tss.length;

  if (n === 0 || (n === 1 && tss[0] === 0)) {
    return `
      <div style="height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:rgba(0,0,0,0.02);border-radius:10px">
        <div style="font-size:13px;color:var(--c-muted);text-align:center">Building your history</div>
        <div style="font-size:11px;color:var(--c-faint);text-align:center">Syncs from Strava after a few sessions</div>
      </div>`;
  }

  // SVG coordinate space: 320 wide × 155 tall (viewBox, stretched to fill container)
  const W = 320;
  const H = 155;
  const padL = 6;
  const padR = 6;
  const usableW = W - padL - padR;

  const baseline = s.ctlBaseline ?? null;
  // Only show reference lines when we have ≥4 weeks — fewer weeks gives an unreliable CTL
  const showRefLines = !!baseline && histWeekCount >= 4;
  const maxVal = Math.max(...tss, showRefLines ? (baseline ?? 0) * 1.25 : 0, 1);

  const xOf  = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf  = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  // Y-axis scale labels (absolute HTML overlay — avoids SVG text stretching)
  const tickStep = maxVal <= 100 ? 25 : maxVal <= 200 ? 50 : maxVal <= 500 ? 100 : 200;
  const yAxisHtml: string[] = [];
  for (let v = tickStep; v <= maxVal * 0.98; v += tickStep) {
    const topPx = yOf(v).toFixed(1);
    yAxisHtml.push(`<span style="position:absolute;top:${topPx}px;right:4px;transform:translateY(-50%);font-size:8px;color:rgba(0,0,0,0.25);line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }
  const yAxisOverlay = `<div style="position:absolute;top:0;left:0;right:0;height:${H}px;pointer-events:none">${yAxisHtml.join('')}</div>`;

  // Single Signal B area — total physiological load, no aerobic/intensity split.
  // The zone split was based on zone data that is unavailable most of the time and fell back to a
  // hardcoded 88%/12% ratio, which was misleading. A single clean area is more honest.
  const totalPts: [number, number][] = tss.map((t, i) => [xOf(i), yOf(t)]);
  const totalTopPath = smoothAreaPath(totalPts);
  const totalArea = `${totalTopPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  // Baseline + ease-back reference lines (only shown when data is reliable)
  let refLines = '';
  if (showRefLines) {
    const by = yOf(baseline!);
    const ey = yOf(baseline! * 1.2);
    refLines = `
      <line x1="${padL}" y1="${by.toFixed(0)}" x2="${W - padR}" y2="${by.toFixed(0)}" stroke="rgba(0,0,0,0.18)" stroke-width="0.8" stroke-dasharray="3 3"/>
      <line x1="${padL}" y1="${ey.toFixed(0)}" x2="${W - padR}" y2="${ey.toFixed(0)}" stroke="rgba(245,158,11,0.4)" stroke-width="0.8" stroke-dasharray="3 3"/>`;
  }

  // Current week highlight (last bar: vertical line)
  const nowX = xOf(n - 1);
  const nowLine = `<line x1="${nowX.toFixed(1)}" y1="0" x2="${nowX.toFixed(1)}" y2="${H}" stroke="rgba(37,99,235,0.2)" stroke-width="${n > 12 ? 2 : 3}"/>`;

  // Week labels: anchored on Monday of the current ISO week so historic bars align with
  // real training week boundaries. The rightmost label uses today's date for "now" context.
  const todayMs = new Date();
  const dow = (todayMs.getDay() + 6) % 7; // 0=Mon…6=Sun
  const monday = new Date(todayMs);
  monday.setDate(monday.getDate() - dow);
  const labelStep = n > 20 ? 4 : n > 12 ? 2 : 1;
  const labels = tss.map((_, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '<span></span>';
    const weeksAgo = n - 1 - i;
    const d = i === n - 1
      ? new Date(todayMs)
      : (() => { const x = new Date(monday); x.setDate(monday.getDate() - weeksAgo * 7); return x; })();
    const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<span style="font-size:9px;color:${i === n-1 ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${i === n-1 ? '600' : '400'}">${label}</span>`;
  }).join('');

  // History footnote: when baseline exists but < 4 weeks logged
  const baselineNote = baseline && histWeekCount < 4
    ? `<div style="font-size:10px;color:var(--c-faint);margin-top:4px">Baseline builds from week 4 — reference lines will appear then</div>`
    : '';

  // Legend — single area chip + reference line entries when baseline is available
  const legend = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:4px">
        <div style="width:10px;height:10px;border-radius:2px;background:rgba(99,149,255,0.65)"></div>
        <span style="font-size:11px;color:var(--c-muted)">Total load (all sports)</span>
      </div>
      ${showRefLines ? `
      <div style="display:flex;align-items:center;gap:4px">
        <svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="rgba(0,0,0,0.35)" stroke-width="1" stroke-dasharray="3 2"/></svg>
        <span style="font-size:11px;color:var(--c-faint)">Your running base</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        <svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="rgba(245,158,11,0.6)" stroke-width="1" stroke-dasharray="3 2"/></svg>
        <span style="font-size:11px;color:var(--c-faint)">Ease back</span>
      </div>` : ''}
    </div>`;

  return `
    ${legend}
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        ${refLines}
        <path d="${totalArea}" fill="rgba(99,149,255,0.35)" stroke="none"/>
        <path d="${totalTopPath}" fill="none" stroke="rgba(99,149,255,0.85)" stroke-width="1.5"/>
        ${nowLine}
      </svg>
      ${yAxisOverlay}
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">
        ${labels}
      </div>
    </div>
    ${baselineNote}
    <div style="font-size:10px;color:var(--c-faint);margin-top:4px;line-height:1.4">History from Strava · current week includes all training at full physiological weight</div>`;
}

// ---------------------------------------------------------------------------
// Distance area chart for Dig Deeper

function buildDistanceAreaChart(s: SimulatorState, range: ChartRange = '8w'): string {
  const wk = s.wks?.[s.w - 1];
  const currentRunKm = wk ? runKmFromWeek(wk) : 0;

  // Show pre-plan Strava km + completed plan week km + current week km (same logic as getChartData)
  const useExtended = (range === '16w' || range === 'all') && (s.extendedHistoryKm?.length ?? 0) > 0;
  const histKm = useExtended ? (s.extendedHistoryKm ?? []) : (s.historicWeeklyKm ?? []);
  const completedPlanWks = (s.wks ?? []).slice(0, Math.max(0, s.w - 1));
  const planKmArr = completedPlanWks.map(runKmFromWeek);
  const overlap = Math.min(completedPlanWks.length, histKm.length);
  const prePlanKm = histKm.slice(0, histKm.length - overlap);

  const allKm = [...prePlanKm, ...planKmArr, currentRunKm];
  const n = allKm.length;

  if (n === 0 || allKm.every(v => v === 0)) {
    return `<div style="height:130px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--c-muted)">No distance data yet</div>`;
  }

  const W = 320, H = 130;
  const padL = 6, padR = 6;
  const usableW = W - padL - padR;

  const planKm = (s.rw ?? 4) * ((wk as any)?.targetKmPerRun ?? 10);
  const maxVal = Math.max(...allKm, planKm * 1.1, 1);

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  const pts: [number, number][] = allKm.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  // Plan target reference line
  let refLines = '';
  if (planKm > 0) {
    const py = yOf(planKm);
    refLines = `<line x1="${padL}" y1="${py.toFixed(0)}" x2="${W - padR}" y2="${py.toFixed(0)}" stroke="rgba(0,0,0,0.18)" stroke-width="0.8" stroke-dasharray="3 3"/>`;
  }

  // Current week marker
  const nowX = xOf(n - 1);
  const nowLine = `<line x1="${nowX.toFixed(1)}" y1="0" x2="${nowX.toFixed(1)}" y2="${H}" stroke="rgba(37,99,235,0.2)" stroke-width="3"/>`;

  // Calendar date labels
  const today = new Date();
  const labels = allKm.map((_, i) => {
    const weeksAgo = n - 1 - i;
    const d = new Date(today);
    d.setDate(d.getDate() - weeksAgo * 7);
    const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<span style="font-size:9px;color:${i === n-1 ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${i === n-1 ? '600' : '400'}">${label}</span>`;
  }).join('');

  const legend = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:4px">
        <div style="width:10px;height:10px;border-radius:2px;background:rgba(37,99,235,0.5)"></div>
        <span style="font-size:11px;color:var(--c-muted)">Running km</span>
      </div>
      ${planKm > 0 ? `
      <div style="display:flex;align-items:center;gap:4px">
        <svg width="14" height="6"><line x1="0" y1="3" x2="14" y2="3" stroke="rgba(0,0,0,0.35)" stroke-width="1" stroke-dasharray="3 2"/></svg>
        <span style="font-size:11px;color:var(--c-faint)">Plan target</span>
      </div>` : ''}
    </div>`;

  return `
    ${legend}
    <div style="position:relative">
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
        ${refLines}
        <path d="${areaPath}" fill="rgba(37,99,235,0.40)" stroke="none"/>
        <path d="${topPath}" fill="none" stroke="rgba(37,99,235,0.7)" stroke-width="1.2"/>
        ${nowLine}
      </svg>
      <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">
        ${labels}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Dig Deeper chart dispatcher

function build8WeekChart(s: SimulatorState, mode: 'distance' | 'zones', range: ChartRange = '8w'): string {
  if (mode === 'zones') return buildZoneStackChart(s);
  return buildDistanceAreaChart(s, range);
}


function buildZoneStackChart(s: SimulatorState): string {
  // Collect zone split data from last 8 completed weeks + current
  const completedWeeks = (s.wks ?? []).slice(0, s.w - 1).slice(-7);
  const wk = s.wks?.[s.w - 1];

  const hasZones = completedWeeks.some(w => w.actualTSS != null);
  if (!hasZones) {
    return `<div style="height:130px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--c-muted)">Zone breakdown requires HR data — connect your watch</div>`;
  }

  const allWeeks = [...completedWeeks, ...(wk ? [wk] : [])];
  const maxVal = Math.max(...allWeeks.map(w => computeWeekTSS(w, w.rated ?? {}, s.planStartDate)), 1);
  const chartH = 130;

  const BAR_W = 100 / (allWeeks.length * 1.4 + 0.4);
  const GAP   = (100 - BAR_W * allWeeks.length) / (allWeeks.length + 1);

  const zoneToday = new Date();
  const barsHTML = allWeeks.map((w, i) => {
    const tss = computeWeekTSS(w, w.rated ?? {}, s.planStartDate);
    const barH = Math.max(2, Math.round((tss / maxVal) * chartH));
    const x = GAP + i * (BAR_W + GAP);
    // Rough zone split: 60% base / 25% threshold / 15% intensity
    const baseH = Math.round(barH * 0.6);
    const threshH = Math.round(barH * 0.25);
    const intH = barH - baseH - threshH;
    const weeksAgo = allWeeks.length - 1 - i;
    const d = new Date(zoneToday);
    d.setDate(d.getDate() - weeksAgo * 7);
    const lbl = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `
      <rect x="${x.toFixed(1)}%" y="${chartH - baseH}" width="${BAR_W.toFixed(1)}%" height="${baseH}" fill="var(--c-ok)" rx="2" opacity="0.85"/>
      <rect x="${x.toFixed(1)}%" y="${chartH - baseH - threshH}" width="${BAR_W.toFixed(1)}%" height="${threshH}" fill="var(--c-caution)" rx="0"/>
      <rect x="${x.toFixed(1)}%" y="${chartH - barH}" width="${BAR_W.toFixed(1)}%" height="${intH}" fill="var(--c-warn)" rx="2 2 0 0"/>
      <text x="${(x + BAR_W / 2).toFixed(1)}%" y="${chartH + 16}" text-anchor="middle" font-size="9" fill="var(--c-faint)">${lbl}</text>`;
  }).join('');

  return `
    <svg width="100%" height="${chartH + 22}" style="overflow:visible;display:block">
      ${barsHTML}
    </svg>
    <div style="display:flex;gap:12px;margin-top:6px">
      <span style="font-size:10px;color:var(--c-faint)"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--c-ok);margin-right:3px;vertical-align:middle"></span>Base</span>
      <span style="font-size:10px;color:var(--c-faint)"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--c-caution);margin-right:3px;vertical-align:middle"></span>Threshold</span>
      <span style="font-size:10px;color:var(--c-faint)"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--c-warn);margin-right:3px;vertical-align:middle"></span>Intensity</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// Narrative sentence (3×3 matrix: direction × ACWR status)

function buildNarrativeSentence(s: SimulatorState): string {
  const hist = s.historicWeeklyTSS ?? [];
  if (hist.length < 4) return 'Every session builds your base.';

  const recentAvg = avg(hist.slice(-4));
  const wk = s.wks?.[s.w - 1];
  // Signal B: raw physiological load — narrative is about injury risk, not running adherence
  const currentTSS = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;

  let direction: 'building' | 'steady' | 'easing';
  if (currentTSS > recentAvg * 1.1) direction = 'building';
  else if (currentTSS < recentAvg * 0.9) direction = 'easing';
  else direction = 'steady';

  const tier = s.athleteTierOverride ?? s.athleteTier;
  const acwrAtlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, acwrAtlSeed);
  const status = acwr.status;

  const matrix: Record<string, Record<string, string>> = {
    building: {
      safe:    'Load is building well — stay consistent.',
      caution: 'Load is building fast. Keep quality sessions short this week.',
      high:    'Load has spiked. Protect recovery before adding more.',
      unknown: 'Load is building — great foundation work.',
    },
    steady: {
      safe:    'Consistent week. Your fitness base is solidifying.',
      caution: 'Holding a hard week. Prioritise sleep and easy efforts.',
      high:    'High load this week. Shorten or ease your remaining sessions.',
      unknown: 'Steady week — keep the habit going.',
    },
    easing: {
      safe:    'Lighter week. Good time to absorb recent training.',
      caution: 'Easing off — the right call given recent load.',
      high:    'Reduce load further this week to protect your training.',
      unknown: 'Lower load this week — recovery is training too.',
    },
  };

  return matrix[direction][status] ?? 'Load is building well — stay consistent.';
}

// ---------------------------------------------------------------------------
// Above-fold sections

function buildAboveFold(s: SimulatorState): string {
  const narrative = buildNarrativeSentence(s);
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  const wk = s.wks?.[s.w - 1];
  const ctl = s.ctlBaseline ?? null;

  // This Week card — uses Signal B (raw physiological TSS) for honest "how hard was this week?"
  // ATL seed accounts for gym sessions: users who train cross-sport have higher base fatigue
  // than their running CTL suggests (each gym session adds ~10% to seed, max 30% for 3+ sessions)
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeedMultiplier = 1 + Math.min(0.1 * (s.gs ?? 0), 0.3);
  const atlSeed = (s.ctlBaseline ?? 0) * atlSeedMultiplier;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const currentTSS = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;

  let thisWeekPct: number | null = null;
  let thisWeekLabel = '';
  let thisWeekCopy = '';
  let thisWeekPillClass = 'm-pill-neutral';
  let dirWord = '';

  if (ctl && ctl > 0 && currentTSS > 0) {
    // Prorate the baseline by day of week so a Tuesday partial week isn't -74%.
    // Mon=1 … Sun=7. On Sat/Sun (dow≥6) the week is nearly complete — compare normally.
    const dow = (new Date().getDay() + 6) % 7 + 1; // 1=Mon … 7=Sun
    const proratedBaseline = dow >= 6 ? ctl : ctl * (dow / 7);
    const dayName = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
    thisWeekPct = Math.round(((currentTSS - proratedBaseline) / proratedBaseline) * 100);
    thisWeekLabel = `${thisWeekPct >= 0 ? '+' : '-'}${Math.abs(thisWeekPct)}%`;
    // "vs your running base" — Signal B fatigue compared against Signal A CTL
    dirWord = dow >= 6 ? 'vs your running base' : `${dayName} · week in progress`;

    if (thisWeekPct >= 30) {
      thisWeekCopy = 'Your total load this week is above your usual base. Consider a lighter day.';
      thisWeekPillClass = 'm-pill-caution';
    } else if (thisWeekPct >= 10) {
      thisWeekCopy = 'High load. Watch how you feel tomorrow.';
      thisWeekPillClass = 'm-pill-caution';
    } else if (thisWeekPct >= -10) {
      thisWeekCopy = 'Keep this week\'s plan as-is.';
      thisWeekPillClass = 'm-pill-ok';
    } else {
      thisWeekCopy = 'Good time to add a quality session.';
      thisWeekPillClass = 'm-pill-neutral';
    }
  } else if (currentTSS > 0) {
    thisWeekPillClass = 'm-pill-neutral';
    thisWeekCopy = 'Keep logging sessions to build your baseline.';
  }

  // Distance card
  const NON_RUN_KW = ['cross','gym','strength','rest','yoga','swim','bike','cycl','tennis','hiit','pilates','row','hik','elliptic','walk'];
  const isRunKey = (k: string) => !NON_RUN_KW.some(kw => k.toLowerCase().includes(kw));
  const kmDone = wk
    ? Object.entries(wk.garminActuals ?? {})
        .filter(([k]) => isRunKey(k))
        .reduce((sum, [, a]) => sum + ((a as any).distanceKm || 0), 0)
    : 0;
  const kmPlan = (s.rw ?? 5) * ((wk as any)?.targetKmPerRun || 10);
  const kmPct  = kmPlan > 0 ? Math.round(((kmDone / kmPlan) - 1) * 100) : null;
  const kmPillClass = kmPct === null ? 'm-pill-neutral'
    : kmPct >= 20 ? 'm-pill-caution'
    : kmPct >= -10 ? 'm-pill-ok'
    : 'm-pill-neutral';
  const kmPillText = kmPct === null ? 'No data' : `${kmDone.toFixed(1)} / ${kmPlan.toFixed(0)} km`;

  return `
    <!-- Heading -->
    <div style="padding:16px 18px 8px;display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-size:20px;font-weight:600;letter-spacing:-0.03em;color:var(--c-black)">Your last 8 weeks</div>
        <div style="font-size:13px;color:var(--c-muted);margin-top:3px">${narrative}</div>
      </div>
      <button id="stats-account-btn" style="width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border-strong);background:transparent;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;letter-spacing:0.02em;cursor:pointer;color:var(--c-black);font-family:var(--f);flex-shrink:0">${initials || 'Me'}</button>
    </div>

    <!-- Load history chart -->
    <div id="stats-chart-wrap" style="padding:0 18px 12px">
      <div class="m-card" style="padding:14px 14px 10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black)">Training Load</div>
          <div style="display:flex;background:rgba(0,0,0,0.05);border-radius:6px;padding:2px;gap:1px">
            <button class="history-range-btn history-range-active" data-range="8w"
              style="padding:3px 9px;font-size:11px;font-weight:500;border:none;cursor:pointer;border-radius:4px;font-family:var(--f);background:var(--c-surface);color:var(--c-black);box-shadow:0 1px 2px rgba(0,0,0,0.08)">8w</button>
            <button class="history-range-btn" data-range="16w"
              style="padding:3px 9px;font-size:11px;font-weight:500;border:none;cursor:pointer;border-radius:4px;font-family:var(--f);background:transparent;color:var(--c-muted)">16w</button>
            <button class="history-range-btn" data-range="all"
              style="padding:3px 9px;font-size:11px;font-weight:500;border:none;cursor:pointer;border-radius:4px;font-family:var(--f);background:transparent;color:var(--c-muted)">Full</button>
          </div>
        </div>
        <div id="stats-chart-inner">${buildLoadHistoryChart(s, '8w')}</div>
      </div>
    </div>

    <!-- Two summary cards -->
    <div style="padding:0 18px 14px;display:flex;gap:10px">

      <!-- This Week card -->
      <div class="m-card" style="flex:1;padding:14px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:6px">This Week</div>
        ${ctl && ctl > 0 && currentTSS > 0 && thisWeekPct !== null ? `
          <div style="font-size:30px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:var(--c-black);margin-bottom:3px">${thisWeekLabel}</div>
          <div style="font-size:11px;color:var(--c-muted);margin-bottom:8px">${dirWord}</div>
        ` : `
          <div style="font-size:24px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:var(--c-black);margin-bottom:3px">${currentTSS > 0 ? currentTSS : '—'}</div>
          <div style="font-size:11px;color:var(--c-muted);margin-bottom:8px">total load (runs + gym + sport)</div>
        `}
        <span class="m-pill ${thisWeekPillClass}" style="font-size:10px"><span class="m-pill-dot"></span>${acwr.status === 'high' ? 'High load' : acwr.status === 'caution' ? 'Elevated' : 'On track'}</span>
        <div style="font-size:11px;color:var(--c-muted);margin-top:6px;line-height:1.4">${thisWeekCopy || ((s.historicWeeklyTSS ?? []).length < 4 ? 'Building baseline — keep logging sessions.' : 'Steady training this week.')}</div>
      </div>

      <!-- Distance card -->
      <div class="m-card" style="flex:1;padding:14px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:6px">Distance</div>
        <div style="font-size:30px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:var(--c-black);margin-bottom:3px">${kmDone > 0 ? kmDone.toFixed(1) : '—'}</div>
        <div style="font-size:11px;color:var(--c-muted);margin-bottom:8px">km this week</div>
        <span class="m-pill ${kmPillClass}" style="font-size:10px"><span class="m-pill-dot"></span>${kmPillText}</span>
      </div>

    </div>
    ${buildRunningFitnessChart(s)}
  `;
}

// ---------------------------------------------------------------------------
// Running Fitness chart (Signal A CTL trend)

function buildRunningFitnessChart(s: SimulatorState): string {
  // Signal A weekly load: historic from historicWeeklyTSS (Strava, runSpec-discounted — correct for
  // running fitness) + current week from computeWeekTSS (live plan data, Signal A).
  // CTL is overlaid as a dashed reference line — the 42-day moving average of this same signal.
  const wk = s.wks?.[s.w - 1];
  const histSignalA = (s.historicWeeklyTSS ?? []).slice(-8);
  const currentSignalA = wk ? computeWeekTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  const allSignalA = [...histSignalA, currentSignalA];
  const n = allSignalA.length;

  if (n === 0 || allSignalA.every(v => v === 0)) return '';

  // CTL trend for top-right display
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate);
  const latest = metrics.length > 0 ? metrics[metrics.length - 1] : null;
  const prev   = metrics.length > 1 ? metrics[metrics.length - 2] : null;
  const delta  = latest && prev ? latest.ctl - prev.ctl : 0;
  const trend  = delta > 0.5 ? '↑' : delta < -0.5 ? '↓' : '→';
  const trendColor = delta > 0.5 ? 'var(--c-ok)' : delta < -0.5 ? 'var(--c-muted)' : 'var(--c-faint)';
  const ctlDisplay = latest ? latest.ctl : (s.ctlBaseline ?? 0);

  const ctl = s.ctlBaseline ?? null;
  const maxVal = Math.max(...allSignalA, ctl ? ctl * 1.3 : 0, 1);

  const W = 320;
  const H = 90;
  const padL = 4;
  const padR = 4;
  const usableW = W - padL - padR;
  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  // Weekly Signal A area
  const pts: [number, number][] = allSignalA.map((v, i) => [xOf(i), yOf(v)]);
  const topPath  = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n-1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  // CTL dashed reference line — 42-day fitness base, same style as Training Load chart
  const ctlLine = ctl
    ? `<line x1="${padL}" y1="${yOf(ctl).toFixed(1)}" x2="${W - padR}" y2="${yOf(ctl).toFixed(1)}" stroke="rgba(34,197,94,0.5)" stroke-width="0.8" stroke-dasharray="4 3"/>`
    : '';

  // Current week marker
  const nowX = xOf(n - 1);
  const nowLine = `<line x1="${nowX.toFixed(1)}" y1="0" x2="${nowX.toFixed(1)}" y2="${H}" stroke="rgba(34,197,94,0.2)" stroke-width="3"/>`;

  // Week x-axis labels — Monday-anchored (same fix as Training Load chart)
  const todayMs = new Date();
  const dow = (todayMs.getDay() + 6) % 7; // 0=Mon…6=Sun
  const monday = new Date(todayMs);
  monday.setDate(monday.getDate() - dow);
  const labelStep = n > 12 ? 2 : 1;
  const labels = allSignalA.map((_, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '<span></span>';
    const weeksAgo = n - 1 - i;
    const d = i === n - 1
      ? new Date(todayMs)
      : (() => { const x = new Date(monday); x.setDate(monday.getDate() - weeksAgo * 7); return x; })();
    const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<span style="font-size:9px;color:${i === n-1 ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${i === n-1 ? '600' : '400'}">${label}</span>`;
  }).join('');

  return `
    <div style="padding:0 18px 14px">
      <div class="m-card" style="padding:14px 14px 10px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px">
          <div style="font-size:12px;font-weight:600;color:var(--c-black)">Running Fitness</div>
          <div style="font-size:11px;color:var(--c-muted)">
            CTL <span style="font-size:16px;font-weight:500;letter-spacing:-0.02em;color:var(--c-black)">${ctlDisplay.toFixed(0)}</span>
            <span style="color:${trendColor};font-size:12px;margin-left:2px">${trend}</span>
          </div>
        </div>
        <div style="position:relative">
          <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
            ${ctlLine}
            <path d="${areaPath}" fill="rgba(52,199,89,0.25)" stroke="none"/>
            <path d="${topPath}" fill="none" stroke="rgba(52,199,89,0.75)" stroke-width="1.5"/>
            ${nowLine}
          </svg>
          <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">
            ${labels}
          </div>
        </div>
        <div style="font-size:10px;color:var(--c-faint);margin-top:6px">Weekly running-equivalent load · dashed line = 42-day fitness base</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// "Dig deeper" accordion

function buildDigDeeper(s: SimulatorState): string {
  const hist = s.historicWeeklyTSS ?? [];
  const avgLoad = hist.length > 0 ? Math.round(avg(hist)) : null;
  const avgSessions = s.rw ?? null;
  // Consistency: weeks in plan with at least 1 rated session
  const planWeekCount = Math.max(1, s.w - 1);
  const activeWeeks = (s.wks ?? []).slice(0, s.w - 1).filter(w => Object.values(w.rated ?? {}).some(v => typeof v === 'number' && v > 0)).length;
  const consistencyPct = planWeekCount > 0 ? Math.round((activeWeeks / planWeekCount) * 100) : null;

  return `
    <div id="dig-deeper-section" style="padding:0 18px 14px">
      <button id="dig-deeper-btn" style="width:100%;background:none;border:none;cursor:pointer;text-align:left;padding:12px 0;display:flex;align-items:center;justify-content:space-between;font-family:var(--f)">
        <span style="font-size:14px;color:var(--c-accent);font-weight:500">Dig deeper</span>
        <span id="dig-deeper-chevron" style="font-size:14px;color:var(--c-accent);transform:rotate(0deg);transition:transform 0.2s">↓</span>
      </button>
      <div id="dig-deeper-body" style="display:none">

        <!-- Chart switcher -->
        <div style="display:flex;background:rgba(0,0,0,0.04);border-radius:8px;padding:2px;margin-bottom:12px">
          <button class="stats-chart-tab stats-chart-tab-active" data-mode="distance"
            style="flex:1;padding:6px 0;font-size:12px;font-weight:500;border:none;cursor:pointer;border-radius:6px;font-family:var(--f);background:var(--c-surface);color:var(--c-black);box-shadow:0 1px 2px rgba(0,0,0,0.08)">
            Distance
          </button>
          <button class="stats-chart-tab" data-mode="zones"
            style="flex:1;padding:6px 0;font-size:12px;font-weight:500;border:none;cursor:pointer;border-radius:6px;font-family:var(--f);background:transparent;color:var(--c-muted)">
            Running Zones
          </button>
        </div>

        <div id="dig-deeper-chart" style="margin-bottom:12px">${build8WeekChart(s, 'distance')}</div>

        <!-- Explainer bullets -->
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
          ${['Training load combines how long and how hard each session was.',
             'The dashed line is your typical weekly load — a rolling 42-day average.',
             'Bars above the line are harder weeks; significantly above = higher injury risk.',
            ].map(t => `
            <div style="display:flex;gap:8px;align-items:flex-start">
              <span style="color:var(--c-accent);font-size:12px;flex-shrink:0;margin-top:1px">•</span>
              <span style="font-size:12px;color:var(--c-muted);line-height:1.45">${t}</span>
            </div>`).join('')}
        </div>

        <!-- 8-week summary row -->
        ${avgLoad !== null ? `
        <div class="m-card" style="padding:12px 14px;display:flex;justify-content:space-between">
          <div style="text-align:center">
            <div style="font-size:16px;font-weight:500;letter-spacing:-0.02em">${avgLoad}</div>
            <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-top:1px">Avg load/wk</div>
          </div>
          <div style="width:1px;background:var(--c-border)"></div>
          <div style="text-align:center">
            <div style="font-size:16px;font-weight:500;letter-spacing:-0.02em">${avgSessions ?? '—'}</div>
            <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-top:1px">Avg sessions/wk</div>
          </div>
          <div style="width:1px;background:var(--c-border)"></div>
          <div style="text-align:center">
            <div style="font-size:16px;font-weight:500;letter-spacing:-0.02em">${consistencyPct !== null ? consistencyPct + '%' : '—'}</div>
            <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-top:1px">Consistency</div>
          </div>
        </div>` : ''}

      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Advanced accordion — CTL/ATL/TSB + ACWR

function buildInfoIcon(id: string): string {
  return `<button class="stats-info-btn" data-info-id="${id}"
    style="display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;width:16px;height:16px;border-radius:50%;border:1px solid var(--c-border-strong);background:none;cursor:pointer;font-size:9px;color:var(--c-muted);font-family:var(--f);flex-shrink:0;vertical-align:middle;margin-left:3px;touch-action:manipulation">ⓘ</button>`;
}

const INFO_TEXTS: Record<string, string> = {
  ctl: 'Running Fitness (CTL) — a 42-day rolling average of your run-equivalent training load. It only counts running and activities with strong running transfer (e.g. cycling at 55%, gym at 35%). Cross-training boosts fitness but counts less here — because it doesn\'t fully replace running-specific adaptation.',
  atl: 'Fatigue (ATL) — a 7-day rolling average of your total physiological load: runs, gym, cross-training, everything. Your body doesn\'t care what sport caused the fatigue — hard is hard. When this rises well above your Running Fitness, injury risk increases even if you haven\'t been running much.',
  tsb: 'Form (TSB = Running Fitness − Fatigue) — positive means you\'re fresh and ready to perform. Negative means you\'re carrying fatigue. Aim to race when form is between +5 and +20.',
  acwr: 'Load Ratio (Fatigue ÷ Running Fitness) — compares total body fatigue against what you\'re adapted to run. A cross-training-heavy week correctly raises this even without much running. Values above your safe ceiling significantly increase injury risk.',
  vdot: 'Your VDOT score reflects your current running fitness. It adjusts automatically based on: how your recent runs felt vs. what was planned (RPE feedback), analysis of your training data over time, and updates to your threshold pace from GPS workouts. A drop usually means recent sessions have been harder than expected, or your threshold data was recalibrated. A rise means your fitness is building on schedule.',
};

function buildCalibrationStatus(s: SimulatorState): string {
  if (!s.stravaHistoryFetched) return '';
  const thresh = s.intensityThresholds;
  // Only show calibration status when thresholds exist (calibratedFrom > 0)
  if (!thresh || !thresh.calibratedFrom || thresh.calibratedFrom === 0) return '';
  const n = thresh.calibratedFrom;
  const MIN = 3;
  const calibrated = n >= MIN * 2;
  const needed = Math.max(0, MIN * 2 - n);
  const msg = calibrated
    ? `Intensity zones calibrated from ${n} training sessions`
    : `Calibrating intensity zones — ${needed} more labelled session${needed !== 1 ? 's' : ''} to personalise`;
  const color = calibrated ? 'var(--c-ok)' : 'var(--c-caution)';
  return `
    <div class="m-card" style="padding:12px 14px;margin-bottom:10px;display:flex;align-items:center;gap:10px">
      <div style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <span style="font-size:12px;color:var(--c-muted)">${msg}</span>
    </div>
  `;
}

function buildAdvancedSection(s: SimulatorState): string {
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const tierKey = tier ?? 'recreational';
  const tierCfg = TIER_ACWR_CONFIG[tierKey] ?? TIER_ACWR_CONFIG.recreational;
  const atlSeedMultiplier = 1 + Math.min(0.1 * (s.gs ?? 0), 0.3);
  const atlSeed = (s.ctlBaseline ?? 0) * atlSeedMultiplier;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const latest = metrics[metrics.length - 1];

  const ctl   = latest?.ctl  ?? 0;
  const atl   = latest?.atl  ?? 0;
  const tsb   = latest?.tsb  ?? 0;
  const ratio = acwr.ratio;

  // Injury risk bar
  const riskPct = ratio > 0 ? Math.min(100, Math.max(0, Math.round(((ratio - 0.6) / 1.2) * 100))) : 0;
  const histLen = (s.historicWeeklyTSS ?? []).length;
  const riskLabel = acwr.status === 'high' ? 'High — reduce load'
    : acwr.status === 'caution' ? 'Elevated — monitor'
    : acwr.status === 'safe' ? 'Manageable'
    : histLen < 4 ? 'Building baseline' : 'Not enough recent data';
  const thumbBorder = acwr.status === 'high' ? 'var(--c-warn)'
    : acwr.status === 'caution' ? 'var(--c-caution)'
    : 'var(--c-border-strong)';

  // TSB colour
  const tsbColor = tsb > 5 ? 'var(--c-ok)' : tsb < -15 ? 'var(--c-warn)' : 'var(--c-caution)';
  const tsbLabel = tsb > 5 ? 'Fresh' : tsb > -15 ? 'Neutral' : 'Fatigued';

  // This week vs plan bars — Signal B (total load) for honest training volume tracking
  const wk = s.wks?.[s.w - 1];
  const currentTSS = wk ? computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate) : 0;
  const plannedTSS = (wk as any)?.plannedTSS ?? (s.rw ?? 5) * 50;
  const tssPct = plannedTSS > 0 ? Math.min(150, Math.round((currentTSS / plannedTSS) * 100)) : 0;
  const tssGreenPct = Math.min(tssPct, 100);
  const tssAmberPct = Math.max(0, Math.min(tssPct - 100, 30));

  const NON_RUN_KW = ['cross','gym','strength','rest','yoga','swim','bike','cycl','tennis','hiit','pilates','row','hik','elliptic','walk'];
  const isRunKey2 = (k: string) => !NON_RUN_KW.some(kw => k.toLowerCase().includes(kw));
  const kmDone = wk
    ? Object.entries(wk.garminActuals ?? {})
        .filter(([k]) => isRunKey2(k))
        .reduce((sum, [, a]) => sum + ((a as any).distanceKm || 0), 0)
    : 0;
  const kmPlan = (s.rw ?? 5) * ((wk as any)?.targetKmPerRun || 10);
  const kmPct = kmPlan > 0 ? Math.min(150, Math.round((kmDone / kmPlan) * 100)) : 0;
  const kmGreenPct = Math.min(kmPct, 100);
  const kmAmberPct = Math.max(0, Math.min(kmPct - 100, 30));

  const advancedOpen = typeof localStorage !== 'undefined' && localStorage.getItem('mosaic_stats_advanced_open') === '1';

  return `
    <div id="advanced-section" style="padding:0 18px 14px">
      <div style="height:1px;background:var(--c-border);margin-bottom:14px"></div>
      <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px">For coaches &amp; data-driven athletes</div>

      <button id="advanced-btn" style="width:100%;background:none;border:none;cursor:pointer;text-align:left;padding:0 0 12px;display:flex;align-items:center;justify-content:space-between;font-family:var(--f)">
        <span style="font-size:14px;color:var(--c-black);font-weight:500">Advanced</span>
        <span id="advanced-chevron" style="font-size:14px;color:var(--c-muted);transition:transform 0.2s;transform:rotate(${advancedOpen ? '180' : '0'}deg)">↓</span>
      </button>

      <div id="advanced-body" style="display:${advancedOpen ? 'block' : 'none'}">

        <!-- Training Bars -->
        <div class="m-card" style="padding:14px;margin-bottom:10px">

          <!-- Bar 1: Distance vs Plan -->
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
              <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Distance vs Plan</span>
              <span style="font-size:12px;font-weight:500">${kmDone.toFixed(1)} / ${kmPlan.toFixed(0)} km</span>
            </div>
            <div style="height:8px;background:rgba(0,0,0,0.05);border-radius:4px;overflow:hidden">
              <div style="height:100%;border-radius:4px;background:linear-gradient(to right,var(--c-ok) ${kmGreenPct}%,var(--c-caution) ${kmGreenPct}%);width:${kmGreenPct + kmAmberPct}%"></div>
            </div>
          </div>

          <!-- Bar 2: Total Load vs Plan (Signal B — includes gym, cross-training, runs) -->
          <div style="margin-bottom:4px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
              <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Total Load vs Plan</span>
              <span style="font-size:12px;font-weight:500">${currentTSS} / ${Math.round(plannedTSS)}</span>
            </div>
            <div style="height:8px;background:rgba(0,0,0,0.05);border-radius:4px;overflow:hidden">
              <div style="height:100%;border-radius:4px;background:linear-gradient(to right,var(--c-ok) ${tssGreenPct}%,var(--c-caution) ${tssGreenPct}%);width:${tssGreenPct + tssAmberPct}%"></div>
            </div>
            <div style="font-size:10px;color:var(--c-faint);margin-top:4px">Includes runs, gym &amp; cross-training at full physiological weight</div>
          </div>

        </div>

        <!-- Metrics row: ATL / TSB / ACWR -->
        <div class="m-card" style="padding:14px;margin-bottom:10px">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">

            <div>
              <div style="font-size:11px;color:var(--c-faint);margin-bottom:1px">Fatigue (ATL)${buildInfoIcon('atl')}</div>
              <div style="font-size:9px;color:var(--c-faint);margin-bottom:4px;letter-spacing:0.04em">total load · 7-day avg</div>
              <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em">${atl > 0 ? atl.toFixed(0) : '—'}</div>
              <div id="stats-info-atl" style="display:none;font-size:11px;color:var(--c-muted);line-height:1.4;margin-top:5px">${INFO_TEXTS.atl}</div>
            </div>

            <div>
              <div style="font-size:11px;color:var(--c-faint);margin-bottom:2px">Form (TSB)${buildInfoIcon('tsb')}</div>
              <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em" style="color:${tsbColor}">${latest ? (tsb > 0 ? '+' : '') + tsb.toFixed(0) : '—'}</div>
              <div style="font-size:10px;color:${tsbColor}">${latest ? tsbLabel : ''}</div>
              <div id="stats-info-tsb" style="display:none;font-size:11px;color:var(--c-muted);line-height:1.4;margin-top:5px">${INFO_TEXTS.tsb}</div>
            </div>

            <div>
              <div style="font-size:11px;color:var(--c-faint);margin-bottom:2px">Load ratio${buildInfoIcon('acwr')}</div>
              <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em">${ratio > 0 ? ratio.toFixed(2) + '×' : '—'}</div>
              <div id="stats-info-acwr" style="display:none;font-size:11px;color:var(--c-muted);line-height:1.4;margin-top:5px">${INFO_TEXTS.acwr}</div>
            </div>

          </div>
        </div>

        <!-- ACWR gradient bar -->
        <div class="m-card" style="padding:14px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Injury Risk</span>
            <span style="font-size:12px;font-weight:500;color:${acwr.status === 'high' ? 'var(--c-warn)' : acwr.status === 'caution' ? 'var(--c-caution)' : 'var(--c-ok)'}">${riskLabel}</span>
          </div>
          <div class="m-signal-track" style="margin-bottom:8px">
            <div class="m-signal-fill" style="width:${riskPct}%;background:${acwr.status === 'high' ? 'var(--c-warn)' : acwr.status === 'caution' ? 'var(--c-caution)' : 'var(--c-ok)'}"></div>
            ${ratio > 0 ? `<div class="m-signal-thumb" style="left:${riskPct}%;border-color:${thumbBorder}"></div>` : ''}
          </div>
          <div style="font-size:11px;color:var(--c-muted)">Your level: ${tierCfg.label} · Safe ceiling: up to ${((tierCfg.safeUpper - 1) * 100).toFixed(0)}% above your usual</div>
          <div style="font-size:11px;color:var(--c-faint);margin-top:4px;line-height:1.4">Fatigue includes all training (runs + gym + cross-training). Your Running Fitness is the running-specific baseline. A heavy load sports or heavy gym week correctly raises this even if you barely ran.</div>
        </div>

        <!-- Intensity calibration status -->
        ${buildCalibrationStatus(s)}

        <!-- Folded existing sections -->
        ${buildFoldedRacePrediction(s)}
        ${buildFoldedPaces(s)}
        ${buildFoldedRecovery(s)}
        ${buildFoldedPhaseTimeline(s)}

      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Folded sub-sections (light theme versions of old dark sections)

function buildFoldedRacePrediction(s: SimulatorState): string {
  if (s.continuousMode || (!s.initialBaseline && !s.currentFitness)) return '';
  const initial  = s.initialBaseline ? ft(s.initialBaseline) : '--';
  const current  = s.currentFitness  ? ft(s.currentFitness)  : '--';
  const forecast = s.forecastTime    ? ft(s.forecastTime)     : '--';
  const totalImp = (s.initialBaseline || 0) - (s.forecastTime || 0);
  const curImp   = (s.initialBaseline || 0) - (s.currentFitness || 0);
  const pct = totalImp > 0 ? Math.min(100, Math.max(0, Math.round((curImp / totalImp) * 100))) : 0;

  return foldedSection('Race Prediction', `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center;margin-bottom:12px">
      <div>
        <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Starting</div>
        <div style="font-size:18px;font-weight:300;color:var(--c-muted)">${initial}</div>
      </div>
      <div style="border-left:1px solid var(--c-border);border-right:1px solid var(--c-border)">
        <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Today</div>
        <div style="font-size:18px;font-weight:500;color:var(--c-black)">${current}</div>
      </div>
      <div>
        <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Forecast</div>
        <div style="font-size:20px;font-weight:600;color:var(--c-ok)">${forecast}</div>
      </div>
    </div>
    ${totalImp > 0 ? `
    <div style="margin-bottom:4px;display:flex;justify-content:space-between;font-size:11px;color:var(--c-muted)">
      <span>Progress to goal</span><span style="color:var(--c-ok);font-weight:600">${pct}%</span>
    </div>
    <div style="height:6px;background:rgba(0,0,0,0.06);border-radius:3px;overflow:hidden">
      <div style="height:100%;background:var(--c-ok);border-radius:3px;width:${pct}%"></div>
    </div>` : ''}
  `);
}

function buildVdotSparkline(history: Array<{ week: number; vdot: number; date?: string }>): string {
  const n = history.length;
  if (n < 2) return '';
  const W = 200, H = 28;
  const vals = history.map(h => h.vdot);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const range = hi - lo || 1;
  const step = W / Math.max(n - 1, 1);
  const pts = vals.map((v, i) =>
    `${(i * step).toFixed(1)},${(H - ((v - lo) / range) * H).toFixed(1)}`
  ).join(' ');
  const lastVal = vals[n - 1];
  const prevVal = vals[n - 2];
  const color = lastVal >= prevVal ? 'var(--c-ok)' : 'var(--c-warn)';
  const firstDate = history[0].date?.slice(5) ?? '';
  const lastDate  = history[n - 1].date?.slice(5) ?? '';
  return `
    <svg width="${W}" height="${H + 14}" viewBox="0 0 ${W} ${H + 14}" style="display:block;max-width:100%;overflow:visible;margin-top:4px">
      <polyline points="${pts}" stroke="${color}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${((n-1)*step).toFixed(1)}" cy="${(H - ((lastVal - lo)/range)*H).toFixed(1)}" r="2.5" fill="${color}"/>
      <text x="0" y="${H+12}" font-size="9" fill="var(--c-faint)">${firstDate}</text>
      <text x="${W}" y="${H+12}" font-size="9" fill="var(--c-faint)" text-anchor="end">${lastDate}</text>
    </svg>`;
}

function buildVdotChangeNote(history: Array<{ week: number; vdot: number; date?: string }>): string {
  if (history.length < 2) return '';
  const latest = history[history.length - 1];
  const prev   = history[history.length - 2];
  const delta  = latest.vdot - prev.vdot;
  const absDelta = Math.abs(delta).toFixed(1);
  const sinceDate = prev.date ?? `week ${prev.week}`;
  if (Math.abs(delta) < 0.1) {
    return `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">Steady — consistent with your recent training.</div>`;
  } else if (delta < 0) {
    return `<div style="font-size:11px;color:var(--c-warn);margin-top:4px">↓ ${absDelta} pts since ${sinceDate} — your recent runs have felt harder than planned, or your threshold pace was recalibrated.</div>`;
  } else {
    return `<div style="font-size:11px;color:var(--c-ok);margin-top:4px">↑ ${absDelta} pts since ${sinceDate} — fitness is building.</div>`;
  }
}

function buildFoldedPaces(s: SimulatorState): string {
  const currentVDOT = computeCurrentVDOT(s);
  const initialVDOT = s.iv || s.v || 0;
  const vdotDelta = currentVDOT - initialVDOT;
  const vdotPct = initialVDOT ? (vdotDelta / initialVDOT) * 100 : 0;

  const paces = s.pac ? [
    { label: 'Easy',      value: s.pac.e, color: 'var(--c-ok)' },
    { label: 'Marathon',  value: s.pac.m, color: 'var(--c-accent)' },
    { label: 'Threshold', value: s.pac.t, color: 'var(--c-caution)' },
    { label: 'VO2',       value: s.pac.i, color: 'var(--c-warn)' },
  ].filter(p => p.value) : [];

  const vdotBadge = vdotPct !== 0 ? `
    <span style="font-size:11px;font-weight:600;color:${vdotPct > 0 ? 'var(--c-ok)' : 'var(--c-warn)'};background:${vdotPct > 0 ? 'var(--c-ok-bg)' : '#fee2e2'};padding:2px 7px;border-radius:10px">
      ${vdotPct > 0 ? '↑' : '↓'} ${Math.abs(vdotPct).toFixed(1)}%
    </span>
  ` : '';

  const vdotHistory = s.vdotHistory ?? [];
  const sparkline = buildVdotSparkline(vdotHistory);
  const changeNote = buildVdotChangeNote(vdotHistory);

  return foldedSection('VDOT &amp; Paces', `
    <!-- VDOT hero row -->
    <div style="background:rgba(0,0,0,0.03);border-radius:10px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        <div>
          <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">
            <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Current VDOT</div>
            ${buildInfoIcon('vdot')}
          </div>
          <div style="display:flex;align-items:baseline;gap:8px">
            <span style="font-size:26px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">${currentVDOT.toFixed(1)}</span>
            ${vdotBadge}
          </div>
          ${initialVDOT && initialVDOT !== currentVDOT ? `
            <div style="font-size:11px;color:var(--c-faint);margin-top:2px">Started at ${initialVDOT.toFixed(1)}</div>
          ` : ''}
        </div>
      </div>
      ${sparkline ? `
        <div style="margin-top:8px">
          ${sparkline}
          ${changeNote}
        </div>
      ` : changeNote}
      <div id="stats-info-vdot" style="display:none;margin-top:8px;font-size:11px;color:var(--c-muted);line-height:1.5;background:rgba(0,0,0,0.04);border-radius:8px;padding:10px 12px">
        Your VDOT score reflects your current running fitness. It adjusts automatically based on:<br>
        &bull; How your recent runs felt vs. what was planned (RPE feedback)<br>
        &bull; Analysis of your training data over time<br>
        &bull; Updates to your threshold pace from GPS workouts<br><br>
        A drop usually means recent sessions have been harder than expected, or your threshold data was recalibrated. A rise means your fitness is building on schedule.
      </div>
    </div>

    ${paces.length > 0 ? `
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:6px">Training paces</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${paces.map(p => `
          <div style="background:rgba(0,0,0,0.03);border-radius:8px;padding:9px 11px;display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:11px;color:var(--c-muted)">${p.label}</span>
            <span style="font-size:14px;font-weight:600;color:${p.color}">${fp(p.value!)}</span>
          </div>`).join('')}
      </div>
    ` : ''}
  `);
}

function buildFoldedRecovery(s: SimulatorState): string {
  const history = s.physiologyHistory || [];
  const latest  = history.length > 0 ? history[history.length - 1] : null;

  // Rolling helpers
  const rollingAvg = (vals: (number | undefined)[]) => {
    const nums = vals.filter((v): v is number => v !== undefined);
    return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  };
  const rollingPeak = (vals: (number | undefined)[]) => {
    const nums = vals.filter((v): v is number => v !== undefined);
    return nums.length ? Math.max(...nums) : null;
  };

  // RHR and HRV as rolling averages — daily values are noisy
  const restingHR  = rollingAvg(history.map(h => h.restingHR)) ?? (s.restingHR ? Math.round(s.restingHR) : null);
  const hrv        = rollingAvg(history.map(h => h.hrvRmssd));
  // Max HR: peak across the window — more likely to reflect true physiological max
  const peakMaxHR  = rollingPeak(history.map(h => h.maxHR)) ?? s.maxHR ?? null;
  const sleepScore = latest?.sleepScore;
  const garminVO2  = latest?.vo2max ?? s.vo2;
  const ltPace     = latest?.ltPace ?? s.lt;
  const ltHR       = latest?.ltHR ?? (s as any).ltHR;

  const hasPhysio = !!(restingHR || peakMaxHR || hrv !== null || sleepScore !== undefined || garminVO2 || ltPace || ltHR);
  if (!hasPhysio) return '';

  const fmtPace = (sec: number) => {
    const m = Math.floor(sec / 60), s2 = sec % 60;
    return `${m}:${String(s2).padStart(2, '0')}/km`;
  };

  // SVG line chart for expanded view
  const miniChart = (vals: (number | undefined)[], color: string): string => {
    const nums = vals.filter((v): v is number => v !== undefined);
    if (nums.length < 3) return `<span style="font-size:11px;color:var(--c-faint)">Building history…</span>`;
    const W = 200, H = 32;
    const lo = Math.min(...nums), hi = Math.max(...nums), range = hi - lo || 1;
    const step = W / Math.max(vals.length - 1, 1);
    const pts = vals.map((v, i) => v !== undefined
      ? `${(i * step).toFixed(1)},${(H - ((v - lo) / range) * H).toFixed(1)}` : null)
      .filter(Boolean).join(' ');
    const circles = vals.map((v, i) => v !== undefined
      ? `<circle cx="${(i * step).toFixed(1)}" cy="${(H - ((v - lo) / range) * H).toFixed(1)}" r="2.5" fill="${color}"/>` : '').join('');
    const d0 = history[0]?.date?.slice(5) ?? '';
    const d1 = history[history.length - 1]?.date?.slice(5) ?? '';
    return `<svg width="${W}" height="${H + 14}" viewBox="0 0 ${W} ${H + 14}" style="display:block;max-width:100%;margin-top:4px;overflow:visible">
      <polyline points="${pts}" stroke="${color}" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
      ${circles}
      <text x="0" y="${H + 12}" font-size="9" fill="var(--c-faint)">${d0}</text>
      <text x="${W}" y="${H + 12}" font-size="9" fill="var(--c-faint)" text-anchor="end">${d1}</text>
    </svg>`;
  };

  type M = { label: string; val: string; color: string; chartVals: (number | undefined)[]; sub?: string };
  const metrics: M[] = ([
    restingHR ? {
      label: 'Resting HR', val: `${restingHR} bpm`, color: '#EF4444',
      chartVals: history.map(h => h.restingHR), sub: '7-day avg',
    } : null,
    peakMaxHR ? {
      label: 'Peak HR', val: `${Math.round(peakMaxHR)} bpm`, color: '#F97316',
      chartVals: history.map(h => h.maxHR), sub: '7-day peak',
    } : null,
    hrv !== null ? {
      label: 'HRV (RMSSD)', val: `${hrv} ms`, color: '#A855F7',
      chartVals: history.map(h => h.hrvRmssd), sub: '7-day avg',
    } : null,
    sleepScore !== undefined ? {
      label: 'Sleep', val: `${Math.round(sleepScore)}/100`, color: 'var(--c-accent)',
      chartVals: history.map(h => h.sleepScore),
    } : null,
    garminVO2 ? {
      label: 'VO2max', val: (garminVO2 as number).toFixed(1), color: 'var(--c-ok)',
      chartVals: history.map(h => h.vo2max),
    } : null,
    ltPace ? {
      label: 'LT Pace', val: fmtPace(ltPace as number), color: 'var(--c-accent)',
      chartVals: history.map(h => h.ltPace),
    } : null,
    ltHR ? {
      label: 'LT Heart Rate', val: `${Math.round(ltHR)} bpm`, color: '#06B6D4',
      chartVals: history.map(h => h.ltHR),
    } : null,
  ] as (M | null)[]).filter((m): m is M => m !== null);

  return foldedSection('Recovery &amp; Physiology', `
    <div style="display:flex;flex-direction:column;gap:4px">
      ${metrics.map(m => `
        <details style="border-radius:8px;overflow:hidden">
          <summary style="list-style:none;-webkit-appearance:none;display:flex;align-items:center;justify-content:space-between;background:rgba(0,0,0,0.03);padding:10px 12px;cursor:pointer">
            <div>
              <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${m.label}</div>
              ${m.sub ? `<div style="font-size:9px;color:var(--c-faint);margin-top:1px">${m.sub}</div>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:18px;font-weight:500;color:${m.color}">${m.val}</span>
              <span style="font-size:10px;color:var(--c-faint)">▾</span>
            </div>
          </summary>
          <div style="padding:10px 12px;border-top:1px solid var(--c-border);background:rgba(0,0,0,0.02)">
            ${miniChart(m.chartVals, m.color)}
          </div>
        </details>
      `).join('')}
    </div>
  `);
}

function buildFoldedPhaseTimeline(s: SimulatorState): string {
  const weeks = s.wks ?? [];
  if (weeks.length === 0) return '';

  const phaseColors: Record<string, string> = {
    base: 'var(--c-accent)', build: 'var(--c-ok)', peak: '#A855F7', taper: 'var(--c-caution)',
  };
  const phaseText: Record<string, string> = {
    base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper',
  };

  type Seg = { phase: string; start: number; end: number };
  const segs: Seg[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const ph = weeks[i].ph || 'base';
    if (!segs.length || segs[segs.length - 1].phase !== ph) segs.push({ phase: ph, start: i + 1, end: i + 1 });
    else segs[segs.length - 1].end = i + 1;
  }

  const total = weeks.length;
  const bars = segs.map((seg, si) => {
    const w = ((seg.end - seg.start + 1) / total * 100).toFixed(1);
    const color = phaseColors[seg.phase] ?? 'var(--c-muted)';
    const label = phaseText[seg.phase] ?? seg.phase;
    const isCurr = s.w >= seg.start && s.w <= seg.end;
    const isFirst = si === 0;
    const isLast  = si === segs.length - 1;
    const dotPct  = seg.end > seg.start ? ((s.w - seg.start) / (seg.end - seg.start) * 100) : 50;
    return `
      <div style="display:flex;flex-direction:column;width:${w}%">
        <div style="height:6px;border-radius:${isFirst ? '3px 0 0 3px' : ''}${isLast ? '0 3px 3px 0' : ''};background:${color};opacity:${isCurr ? '1' : '0.35'};position:relative">
          ${isCurr ? `<div style="position:absolute;top:50%;left:${Math.max(8, Math.min(92, dotPct))}%;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;background:white;border:2px solid ${color};box-shadow:0 1px 3px rgba(0,0,0,0.2)"></div>` : ''}
        </div>
        <span style="font-size:9px;color:var(--c-faint);margin-top:4px;font-weight:${isCurr ? '600' : '400'}">${label}</span>
      </div>`;
  }).join('');

  return foldedSection('Phase Timeline', `
    <div style="display:flex;width:100%;gap:2px;margin-bottom:4px">${bars}</div>
    <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--c-faint)"><span>Start</span><span>Week ${s.w} of ${s.tw}</span><span>Race day</span></div>
  `);
}

function foldedSection(title: string, body: string): string {
  return `
    <div style="margin-bottom:10px;border:1px solid var(--c-border);border-radius:10px;overflow:hidden">
      <button class="stats-fold-btn" style="width:100%;background:none;border:none;cursor:pointer;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;font-family:var(--f)">
        <span style="font-size:13px;font-weight:500;color:var(--c-black)">${title}</span>
        <span class="stats-fold-chevron" style="font-size:12px;color:var(--c-muted);transition:transform 0.2s">↓</span>
      </button>
      <div class="stats-fold-body" style="display:none;padding:0 14px 14px;border-top:1px solid var(--c-border)">
        ${body}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Main render

function buildRaceSimulatorEntry(s: SimulatorState): string {
  // Only show if we have enough fitness data to make a race prediction meaningful
  const hasFitness = !!(s.currentFitness || s.initialBaseline || s.forecastTime);
  if (!hasFitness) return '';
  return `
    <div style="padding:0 18px 14px">
      <button id="stats-race-sim-btn"
        style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:13px 16px;
               background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;
               cursor:pointer;font-family:var(--f);text-align:left">
        <div>
          <div style="font-size:14px;font-weight:600;color:var(--c-black);margin-bottom:2px">Simulate race day</div>
          <div style="font-size:12px;color:var(--c-muted)">See your predicted finish time</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 12h14M13 6l6 6-6 6"/>
        </svg>
      </button>
    </div>
  `;
}

function getStatsHTML(s: SimulatorState): string {
  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      ${buildAboveFold(s)}
      ${buildRaceSimulatorEntry(s)}
      ${buildDigDeeper(s)}
      ${buildAdvancedSection(s)}

    </div>
    ${renderTabBar('stats', isSimulatorMode())}
  `;
}

function wireStatsEventHandlers(s: SimulatorState): void {
  // Account button
  document.getElementById('stats-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Race simulator entry point — opens the Race Prediction section in Advanced
  document.getElementById('stats-race-sim-btn')?.addEventListener('click', () => {
    // Expand the Advanced section and scroll to the Race Prediction folded card
    const advBody = document.getElementById('advanced-body');
    const advChevron = document.getElementById('advanced-chevron');
    if (advBody && advBody.style.display === 'none') {
      advBody.style.display = 'block';
      if (advChevron) advChevron.style.transform = 'rotate(180deg)';
      localStorage.setItem('mosaic_stats_advanced_open', '1');
    }
    // Scroll to the Race Prediction folded card (first .stats-fold-btn)
    setTimeout(() => {
      const foldBtns = document.querySelectorAll<HTMLButtonElement>('.stats-fold-btn');
      const racePredBtn = Array.from(foldBtns).find(b => b.textContent?.includes('Race Prediction'));
      if (racePredBtn) {
        // Expand it if not already open
        const body = racePredBtn.nextElementSibling as HTMLElement;
        const chevron = racePredBtn.querySelector('.stats-fold-chevron') as HTMLElement;
        if (body && body.style.display === 'none') {
          body.style.display = 'block';
          if (chevron) chevron.style.transform = 'rotate(180deg)';
        }
        racePredBtn.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 80);
  });

  // Dig deeper accordion
  const digBtn = document.getElementById('dig-deeper-btn');
  const digBody = document.getElementById('dig-deeper-body');
  const digChevron = document.getElementById('dig-deeper-chevron');
  if (digBtn && digBody && digChevron) {
    digBtn.addEventListener('click', () => {
      const open = digBody.style.display !== 'none';
      digBody.style.display = open ? 'none' : 'block';
      digChevron.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
    });
  }

  // Advanced accordion
  const advBtn = document.getElementById('advanced-btn');
  const advBody = document.getElementById('advanced-body');
  const advChevron = document.getElementById('advanced-chevron');
  if (advBtn && advBody && advChevron) {
    advBtn.addEventListener('click', () => {
      const open = advBody.style.display !== 'none';
      advBody.style.display = open ? 'none' : 'block';
      advChevron.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
      localStorage.setItem('mosaic_stats_advanced_open', open ? '0' : '1');
    });
  }

  // Time range selector (main chart)
  const chartInner = document.getElementById('stats-chart-inner');
  let currentRange: ChartRange = '8w';
  document.querySelectorAll<HTMLButtonElement>('.history-range-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const range = btn.dataset.range as ChartRange;
      document.querySelectorAll<HTMLElement>('.history-range-btn').forEach(b => {
        const active = b === btn;
        b.style.background = active ? 'var(--c-surface)' : 'transparent';
        b.style.color = active ? 'var(--c-black)' : 'var(--c-muted)';
        b.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none';
      });
      currentRange = range;
      if ((range === '16w' || range === 'all') && !s.extendedHistoryTSS?.length) {
        if (chartInner) chartInner.innerHTML = `<div style="height:155px;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--c-muted)">Loading…</div>`;
        await fetchExtendedHistory(range === '16w' ? 16 : 52);
      }
      // Check if extended history added any new weeks beyond the default 8w
      const defaultWeeks = s.historicWeeklyTSS?.length ?? 0;
      const extendedWeeks = s.extendedHistoryTSS?.length ?? 0;
      const hasMoreHistory = (range === '16w' || range === 'all') && extendedWeeks > defaultWeeks;
      if ((range === '16w' || range === 'all') && !hasMoreHistory && defaultWeeks > 0) {
        // No additional history available — show info then render with available data
        if (chartInner) chartInner.innerHTML =
          buildLoadHistoryChart(s, '8w') +
          `<div style="margin-top:6px;font-size:10px;color:var(--c-faint);text-align:center">
            ${defaultWeeks} week${defaultWeeks !== 1 ? 's' : ''} synced so far — more history will appear as you keep training
          </div>`;
      } else {
        if (chartInner) chartInner.innerHTML = buildLoadHistoryChart(s, currentRange);
      }
      // Also refresh the dig deeper distance chart so it shows the same time range
      const activeTab = document.querySelector<HTMLElement>('.stats-chart-tab-active');
      const activeMode = (activeTab?.dataset.mode ?? 'distance') as 'distance' | 'zones';
      const digChartEl2 = document.getElementById('dig-deeper-chart');
      if (digChartEl2) digChartEl2.innerHTML = build8WeekChart(s, activeMode, currentRange);
    });
  });

  // Dig deeper chart switcher tabs (distance / zones only)
  document.querySelectorAll<HTMLButtonElement>('.stats-chart-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as 'distance' | 'zones';
      document.querySelectorAll('.stats-chart-tab').forEach(b => {
        const el = b as HTMLElement;
        const active = b === btn;
        el.style.background = active ? 'var(--c-surface)' : 'transparent';
        el.style.color = active ? 'var(--c-black)' : 'var(--c-muted)';
        el.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none';
      });
      const digChartEl = document.getElementById('dig-deeper-chart');
      if (digChartEl) digChartEl.innerHTML = build8WeekChart(s, mode, currentRange);
    });
  });

  // ⓘ info buttons — inline expand
  // iOS silently drops click events on non-interactive elements, so we wire both
  // click (desktop/Android) and touchstart (iOS). touchstart calls preventDefault()
  // to suppress the subsequent ghost click.
  document.querySelectorAll<HTMLButtonElement>('.stats-info-btn').forEach(btn => {
    const infoHandler = (e: Event) => {
      e.stopPropagation();
      const id = btn.dataset.infoId!;
      const box = document.getElementById(`stats-info-${id}`);
      if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    };
    btn.addEventListener('click', infoHandler);
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); infoHandler(e); }, { passive: false });
  });

  // Folded section accordions
  document.querySelectorAll<HTMLButtonElement>('.stats-fold-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.nextElementSibling as HTMLElement;
      const chevron = btn.querySelector('.stats-fold-chevron') as HTMLElement;
      if (!body) return;
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      if (chevron) chevron.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
    });
  });
}

export function renderStatsView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  container.innerHTML = getStatsHTML(s);
  wireTabBarHandlers(navigateTab);
  wireStatsEventHandlers(s);
}
