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
import { computeWeekTSS, computeFitnessModel, computeACWR, TIER_ACWR_CONFIG } from '@/calculations/fitness-model';

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

/** Format a week start date from plan start date + week index */
function weekLabel(s: SimulatorState, weekIndex: number): string {
  const start = s.planStartDate;
  if (!start) return `Wk ${weekIndex + 1}`;
  const d = new Date(start);
  d.setDate(d.getDate() + weekIndex * 7);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------------------
// 8-week Training Load chart

function build8WeekChart(s: SimulatorState, mode: 'load' | 'distance' | 'zones' = 'load'): string {
  const ctl = s.ctlBaseline ?? null;
  const histTSS = s.historicWeeklyTSS ?? [];
  const histKm  = s.historicWeeklyKm  ?? [];

  // Build data: past 7 weeks (historic) + current week actual
  const wk = s.wks?.[s.w - 1];
  const currentTSS = wk ? computeWeekTSS(wk, wk.rated ?? {}) : 0;
  const currentKm = wk
    ? Object.entries(wk.garminActuals ?? {})
        .filter(([k]) => !['cross','gym','strength','rest','yoga','swim','bike','cycl','tennis','hiit','pilates','row','hik','elliptic','walk'].some(kw => k.toLowerCase().includes(kw)))
        .reduce((sum, [, a]) => sum + ((a as any).distanceKm || 0), 0)
    : 0;

  // If no historic data, show placeholder
  if (histTSS.length === 0 && currentTSS === 0) {
    return `
      <div style="height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:rgba(0,0,0,0.02);border-radius:10px">
        <div style="font-size:13px;color:var(--c-muted);text-align:center">Building your baseline</div>
        <div style="font-size:11px;color:var(--c-faint);text-align:center">Comes online in week 4 · log sessions to build history</div>
      </div>`;
  }

  // Past weeks from history (up to 7)
  const past7TSS = histTSS.slice(-7);
  const past7Km  = histKm.slice(-7);

  if (mode === 'distance') {
    return buildBarChart(s, past7Km, currentKm, null, 'km', 'distance');
  }
  if (mode === 'zones') {
    return buildZoneStackChart(s);
  }
  return buildBarChart(s, past7TSS, currentTSS, ctl, 'TL', 'load');
}

function buildBarChart(
  s: SimulatorState,
  pastValues: number[],
  currentValue: number,
  baseline: number | null,
  unit: string,
  mode: 'load' | 'distance',
): string {
  const allValues = [...pastValues, currentValue];
  const maxVal = Math.max(...allValues, baseline ?? 0, 1);

  const chartH = 130; // px height of bar area
  const barCount = allValues.length;
  const BAR_W = 100 / (barCount * 1.4 + 0.4); // % width per bar
  const GAP   = (100 - BAR_W * barCount) / (barCount + 1);

  // Y position as % from bottom
  const toY = (v: number) => Math.max(2, Math.round((v / maxVal) * chartH));

  const baselineY = baseline ? Math.round((baseline / maxVal) * chartH) : null;
  const optimalTop = baseline ? Math.min(chartH, Math.round((baseline * 1.2 / maxVal) * chartH)) : null;

  // Build bars SVG
  const barsHTML = allValues.map((val, i) => {
    const isCurrentWeek = i === allValues.length - 1;
    const inProgress = isCurrentWeek && currentValue > 0;
    const barH = toY(val);
    const x = GAP + i * (BAR_W + GAP);

    // Determine colour
    let barColor: string;
    let capColor: string | null = null;
    if (isCurrentWeek) {
      barColor = 'var(--c-accent)';
    } else if (baseline) {
      const ratio = val / baseline;
      if (ratio > 1.3) { barColor = 'var(--c-ok)'; capColor = 'var(--c-warn)'; }
      else if (ratio > 1.2) { barColor = 'var(--c-ok)'; capColor = 'var(--c-caution)'; }
      else if (ratio >= 0.7) { barColor = 'var(--c-ok)'; }
      else { barColor = 'var(--c-muted)'; }
    } else {
      barColor = 'var(--c-accent)';
    }

    // If over 120% split bar into green body + amber/red cap
    let barSvg = '';
    if (capColor && baseline) {
      const greenH = Math.round((baseline * 1.2 / maxVal) * chartH);
      const capH = Math.max(2, barH - greenH);
      barSvg = `
        <rect x="${x.toFixed(1)}%" y="${(chartH - greenH).toFixed(0)}" width="${BAR_W.toFixed(1)}%" height="${greenH}" fill="${barColor}" rx="2"/>
        <rect x="${x.toFixed(1)}%" y="${(chartH - barH).toFixed(0)}" width="${BAR_W.toFixed(1)}%" height="${capH}" fill="${capColor}" rx="2"/>`;
    } else {
      // Diagonal hatch pattern for in-progress week
      const patternId = inProgress ? 'hatch-current' : null;
      const fill = patternId ? `url(#${patternId})` : barColor;
      barSvg = `<rect x="${x.toFixed(1)}%" y="${(chartH - barH).toFixed(0)}" width="${BAR_W.toFixed(1)}%" height="${barH}" fill="${fill}" rx="2"/>`;
    }

    const label = isCurrentWeek
      ? `<text x="${(x + BAR_W / 2).toFixed(1)}%" y="${chartH + 20}" text-anchor="middle" font-size="9" font-weight="600" fill="var(--c-black)">${weekLabel(s, (s.w ?? 1) - 1)}</text>`
      : `<text x="${(x + BAR_W / 2).toFixed(1)}%" y="${chartH + 20}" text-anchor="middle" font-size="9" fill="var(--c-faint)">${weekLabel(s, (s.w ?? 1) - 1 - (allValues.length - 1 - i))}</text>`;

    return barSvg + label;
  }).join('');

  // Zone bands
  let zoneBands = '';
  let zoneLabels = '';
  if (baseline && optimalTop && baselineY) {
    // Shaded optimal zone (baseline → 120% CTL)
    const optH = optimalTop - baselineY;
    if (optH > 0) {
      zoneBands += `<rect x="0" y="${chartH - optimalTop}" width="100%" height="${optH}" fill="rgba(34,197,94,0.07)" rx="0"/>`;
      zoneLabels += `<text x="1%" y="${chartH - baselineY - (optH / 2)}" dominant-baseline="middle" font-size="8" fill="var(--c-ok)" opacity="0.75">Optimal</text>`;
    }
    // Dashed baseline line
    zoneBands += `<line x1="0" y1="${chartH - baselineY}" x2="100%" y2="${chartH - baselineY}" stroke="var(--c-muted)" stroke-width="1" stroke-dasharray="4 3" opacity="0.5"/>`;
    zoneLabels += `<text x="1%" y="${chartH - baselineY - 3}" font-size="8" fill="var(--c-faint)">Your usual</text>`;
    // "Ease back" label above 120%
    if (optimalTop < chartH) {
      zoneBands += `<line x1="0" y1="${chartH - optimalTop}" x2="100%" y2="${chartH - optimalTop}" stroke="var(--c-caution)" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.4"/>`;
      zoneLabels += `<text x="1%" y="${chartH - optimalTop - 3}" font-size="8" fill="var(--c-caution)" opacity="0.8">Ease back</text>`;
    }
  }

  // Hatch pattern def for current in-progress week
  const defs = currentValue > 0 ? `<defs>
    <pattern id="hatch-current" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="var(--c-accent)" opacity="0.85"/>
      <line x1="0" y1="0" x2="0" y2="6" stroke="white" stroke-width="1.5" opacity="0.3"/>
    </pattern>
  </defs>` : '';

  return `
    <svg width="100%" height="${chartH + 26}" style="overflow:visible;display:block">
      ${defs}
      ${zoneBands}
      ${barsHTML}
      ${zoneLabels}
    </svg>`;
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
  const maxVal = Math.max(...allWeeks.map(w => computeWeekTSS(w, w.rated ?? {})), 1);
  const chartH = 130;

  const BAR_W = 100 / (allWeeks.length * 1.4 + 0.4);
  const GAP   = (100 - BAR_W * allWeeks.length) / (allWeeks.length + 1);

  const barsHTML = allWeeks.map((w, i) => {
    const tss = computeWeekTSS(w, w.rated ?? {});
    const barH = Math.max(2, Math.round((tss / maxVal) * chartH));
    const x = GAP + i * (BAR_W + GAP);
    // Rough zone split: 60% base / 25% threshold / 15% intensity
    const baseH = Math.round(barH * 0.6);
    const threshH = Math.round(barH * 0.25);
    const intH = barH - baseH - threshH;
    return `
      <rect x="${x.toFixed(1)}%" y="${chartH - baseH}" width="${BAR_W.toFixed(1)}%" height="${baseH}" fill="var(--c-ok)" rx="2" opacity="0.85"/>
      <rect x="${x.toFixed(1)}%" y="${chartH - baseH - threshH}" width="${BAR_W.toFixed(1)}%" height="${threshH}" fill="var(--c-caution)" rx="0"/>
      <rect x="${x.toFixed(1)}%" y="${chartH - barH}" width="${BAR_W.toFixed(1)}%" height="${intH}" fill="var(--c-warn)" rx="2 2 0 0"/>
      <text x="${(x + BAR_W / 2).toFixed(1)}%" y="${chartH + 16}" text-anchor="middle" font-size="9" fill="var(--c-faint)">${weekLabel(s, (s.w ?? 1) - 1 - (allWeeks.length - 1 - i))}</text>`;
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
  const currentTSS = wk ? computeWeekTSS(wk, wk.rated ?? {}) : 0;

  let direction: 'building' | 'steady' | 'easing';
  if (currentTSS > recentAvg * 1.1) direction = 'building';
  else if (currentTSS < recentAvg * 0.9) direction = 'easing';
  else direction = 'steady';

  const tier = s.athleteTierOverride ?? s.athleteTier;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined);
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
      high:    'High load this week. Consider swapping one session for rest.',
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

  const wk = s.wks?.[s.w - 1];
  const ctl = s.ctlBaseline ?? null;

  // This Week card
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined);
  const currentTSS = wk ? computeWeekTSS(wk, wk.rated ?? {}) : 0;

  let thisWeekPct: number | null = null;
  let thisWeekLabel = '';
  let thisWeekCopy = '';
  let thisWeekPillClass = 'm-pill-neutral';
  let dirWord = '';

  if (ctl && ctl > 0 && currentTSS > 0) {
    thisWeekPct = Math.round(((currentTSS / ctl) - 1) * 100);
    thisWeekLabel = `${thisWeekPct >= 0 ? '+' : '-'}${Math.abs(thisWeekPct)}%`;
    dirWord = thisWeekPct >= 0 ? 'above your usual' : 'below your usual';

    if (thisWeekPct >= 30) {
      thisWeekCopy = 'Reduce one session before next week.';
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
    <div style="padding:16px 18px 8px">
      <div style="font-size:20px;font-weight:600;letter-spacing:-0.03em;color:var(--c-black)">Your last 8 weeks</div>
      <div style="font-size:13px;color:var(--c-muted);margin-top:3px">${narrative}</div>
    </div>

    <!-- 8-week chart -->
    <div id="stats-chart-wrap" style="padding:0 18px 12px">
      <div class="m-card" style="padding:14px 14px 10px">
        <div id="stats-chart-inner">${build8WeekChart(s, 'load')}</div>
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
          <div style="font-size:11px;color:var(--c-muted);margin-bottom:8px">training load</div>
        `}
        <span class="m-pill ${thisWeekPillClass}" style="font-size:10px"><span class="m-pill-dot"></span>${acwr.status === 'high' ? 'High load' : acwr.status === 'caution' ? 'Elevated' : 'On track'}</span>
        <div style="font-size:11px;color:var(--c-muted);margin-top:6px;line-height:1.4">${thisWeekCopy || 'Building baseline.'}</div>
      </div>

      <!-- Distance card -->
      <div class="m-card" style="flex:1;padding:14px">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:6px">Distance</div>
        <div style="font-size:30px;font-weight:300;letter-spacing:-0.04em;line-height:1;color:var(--c-black);margin-bottom:3px">${kmDone > 0 ? kmDone.toFixed(1) : '—'}</div>
        <div style="font-size:11px;color:var(--c-muted);margin-bottom:8px">km this week</div>
        <span class="m-pill ${kmPillClass}" style="font-size:10px"><span class="m-pill-dot"></span>${kmPillText}</span>
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
          <button class="stats-chart-tab stats-chart-tab-active" data-mode="load"
            style="flex:1;padding:6px 0;font-size:12px;font-weight:500;border:none;cursor:pointer;border-radius:6px;font-family:var(--f);background:var(--c-surface);color:var(--c-black);box-shadow:0 1px 2px rgba(0,0,0,0.08)">
            Training Load
          </button>
          <button class="stats-chart-tab" data-mode="distance"
            style="flex:1;padding:6px 0;font-size:12px;font-weight:500;border:none;cursor:pointer;border-radius:6px;font-family:var(--f);background:transparent;color:var(--c-muted)">
            Distance
          </button>
          <button class="stats-chart-tab" data-mode="zones"
            style="flex:1;padding:6px 0;font-size:12px;font-weight:500;border:none;cursor:pointer;border-radius:6px;font-family:var(--f);background:transparent;color:var(--c-muted)">
            Zones
          </button>
        </div>

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
    style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--c-border-strong);background:none;cursor:pointer;font-size:9px;color:var(--c-muted);font-family:var(--f);flex-shrink:0;vertical-align:middle;margin-left:3px">ⓘ</button>`;
}

const INFO_TEXTS: Record<string, string> = {
  ctl: 'Fitness (CTL) — a 42-day rolling average of your training load. The higher it is, the more training your body is used to handling.',
  atl: 'Fatigue (ATL) — a 7-day rolling average. When fatigue rises above fitness, your form (TSB) goes negative — normal during a hard block.',
  tsb: 'Form (TSB = CTL − ATL) — positive = fresh, negative = fatigued. Aim to race when form is between +5 and +20.',
  acwr: 'Load ratio (ACWR = ATL ÷ CTL) — values above ~1.3 significantly increase injury risk. Safe upper bound varies by your training level.',
};

function buildAdvancedSection(s: SimulatorState): string {
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const tierKey = tier ?? 'recreational';
  const tierCfg = TIER_ACWR_CONFIG[tierKey] ?? TIER_ACWR_CONFIG.recreational;
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined);
  const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined);
  const latest = metrics[metrics.length - 1];

  const ctl   = latest?.ctl  ?? 0;
  const atl   = latest?.atl  ?? 0;
  const tsb   = latest?.tsb  ?? 0;
  const ratio = acwr.ratio;

  // Injury risk bar
  const riskPct = ratio > 0 ? Math.min(100, Math.max(0, Math.round(((ratio - 0.6) / 1.2) * 100))) : 0;
  const riskLabel = acwr.status === 'high' ? 'High — reduce load'
    : acwr.status === 'caution' ? 'Elevated — monitor'
    : acwr.status === 'safe' ? 'Manageable'
    : 'Building baseline';
  const thumbBorder = acwr.status === 'high' ? 'var(--c-warn)'
    : acwr.status === 'caution' ? 'var(--c-caution)'
    : 'var(--c-border-strong)';

  // TSB colour
  const tsbColor = tsb > 5 ? 'var(--c-ok)' : tsb < -15 ? 'var(--c-warn)' : 'var(--c-caution)';
  const tsbLabel = tsb > 5 ? 'Fresh' : tsb > -15 ? 'Neutral' : 'Fatigued';

  // This week vs plan bars
  const wk = s.wks?.[s.w - 1];
  const currentTSS = wk ? computeWeekTSS(wk, wk.rated ?? {}) : 0;
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

          <!-- Bar 2: Training Load vs Plan -->
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
              <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint)">Training Load vs Plan</span>
              <span style="font-size:12px;font-weight:500">${currentTSS} / ${Math.round(plannedTSS)}</span>
            </div>
            <div style="height:8px;background:rgba(0,0,0,0.05);border-radius:4px;overflow:hidden">
              <div style="height:100%;border-radius:4px;background:linear-gradient(to right,var(--c-ok) ${tssGreenPct}%,var(--c-caution) ${tssGreenPct}%);width:${tssGreenPct + tssAmberPct}%"></div>
            </div>
          </div>

        </div>

        <!-- Metrics row: CTL / ATL / TSB / ACWR -->
        <div class="m-card" style="padding:14px;margin-bottom:10px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">

            <div>
              <div style="font-size:11px;color:var(--c-faint);margin-bottom:2px">Fitness (CTL)${buildInfoIcon('ctl')}</div>
              <div style="font-size:22px;font-weight:300;letter-spacing:-0.03em">${ctl > 0 ? ctl.toFixed(0) : '—'}</div>
              <div id="stats-info-ctl" style="display:none;font-size:11px;color:var(--c-muted);line-height:1.4;margin-top:5px">${INFO_TEXTS.ctl}</div>
            </div>

            <div>
              <div style="font-size:11px;color:var(--c-faint);margin-bottom:2px">Fatigue (ATL)${buildInfoIcon('atl')}</div>
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
            <div class="m-signal-fill" style="width:${riskPct}%;background:linear-gradient(to right,#22C55E 0%,#EAB308 50%,#EF4444 100%)"></div>
            ${ratio > 0 ? `<div class="m-signal-thumb" style="left:${riskPct}%;border-color:${thumbBorder}"></div>` : ''}
          </div>
          <div style="font-size:11px;color:var(--c-muted)">Your level: ${tierCfg.label} · Safe ceiling: up to ${((tierCfg.safeUpper - 1) * 100).toFixed(0)}% above your usual</div>
        </div>

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

  return foldedSection('VDOT &amp; Paces', `
    <!-- VDOT hero row -->
    <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(0,0,0,0.03);border-radius:10px;padding:12px 14px;margin-bottom:10px">
      <div>
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:2px">Current VDOT</div>
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:26px;font-weight:700;letter-spacing:-0.02em;color:var(--c-black)">${currentVDOT.toFixed(1)}</span>
          ${vdotBadge}
        </div>
        ${initialVDOT && initialVDOT !== currentVDOT ? `
          <div style="font-size:11px;color:var(--c-faint);margin-top:2px">Started at ${initialVDOT.toFixed(1)}</div>
        ` : ''}
      </div>
      <div style="text-align:right">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--c-faint);margin-bottom:4px">What's VDOT?</div>
        <div style="font-size:11px;color:var(--c-muted);line-height:1.4;max-width:130px">Jack Daniels fitness index. Higher = faster across all distances.</div>
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
  const latest = history.length > 0 ? history[history.length - 1] : null;
  const restingHR = latest?.restingHR ?? s.restingHR;
  const hrv = latest?.hrvRmssd;
  const sleepScore = latest?.sleepScore;
  const garminVO2 = latest?.vo2max ?? s.vo2;
  const hasPhysio = !!(restingHR || hrv !== undefined || sleepScore !== undefined || garminVO2);
  if (!hasPhysio) return '';

  const metrics = [
    restingHR ? { label: 'Resting HR', val: `${Math.round(restingHR)} bpm`, color: '#EF4444' } : null,
    hrv !== undefined ? { label: 'HRV', val: `${Math.round(hrv)} ms`, color: '#A855F7' } : null,
    sleepScore !== undefined ? { label: 'Sleep', val: `${Math.round(sleepScore)}/100`, color: 'var(--c-accent)' } : null,
    garminVO2 ? { label: 'Watch VO2 Max', val: garminVO2.toFixed(1), color: 'var(--c-ok)' } : null,
  ].filter(Boolean);

  return foldedSection('Recovery &amp; Physiology', `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${metrics.map(m => `
        <div style="background:rgba(0,0,0,0.03);border-radius:8px;padding:10px 12px">
          <div style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px">${m!.label}</div>
          <div style="font-size:18px;font-weight:500;color:${m!.color}">${m!.val}</div>
        </div>`).join('')}
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

function getStatsHTML(s: SimulatorState): string {
  return `
    <div class="mosaic-page" style="background:var(--c-bg)">

      ${buildAboveFold(s)}
      ${buildDigDeeper(s)}
      ${buildAdvancedSection(s)}

    </div>
    ${renderTabBar('stats', isSimulatorMode())}
  `;
}

function wireStatsEventHandlers(s: SimulatorState): void {
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

  // Chart switcher tabs
  const chartInner = document.getElementById('stats-chart-inner');
  document.querySelectorAll<HTMLButtonElement>('.stats-chart-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as 'load' | 'distance' | 'zones';
      // Update tab styles
      document.querySelectorAll('.stats-chart-tab').forEach(b => {
        const el = b as HTMLElement;
        const active = b === btn;
        el.style.background = active ? 'var(--c-surface)' : 'transparent';
        el.style.color = active ? 'var(--c-black)' : 'var(--c-muted)';
        el.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none';
        el.style.fontWeight = active ? '500' : '500';
      });
      if (chartInner) chartInner.innerHTML = build8WeekChart(s, mode);
    });
  });

  // ⓘ info buttons — inline expand
  document.querySelectorAll<HTMLButtonElement>('.stats-info-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.infoId!;
      const box = document.getElementById(`stats-info-${id}`);
      if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
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
