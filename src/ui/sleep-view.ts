/**
 * Sleep detail page — same design language as strain-view and recovery-view.
 * Dark indigo gradient hero, cream body, white cards, purple ring.
 * Opens from the Sleep Score card in recovery-view, or from readiness pill sheets.
 */

import { getState } from '@/state';
import type { PhysiologyDayEntry } from '@/types/state';
import {
  getSleepInsight,
  fmtSleepDuration,
  sleepScoreLabel,
  getSleepContext,
  stageQuality,
  getSleepBank,
  fmtSleepBank,
  fmtNightlyShortfall,
  getStageInsight,
  deriveSleepTarget,
  buildSleepBankLineChart,
  computeLoadAdjustedTarget,
  computeSleepDebt,
  computeSleepDebtSeries,
  classifySleepDebt,
  buildDailySignalBTSS,
} from '@/calculations/sleep-insights';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';

// ── Design tokens ──────────────────────────────────────────────────────────────

const CREAM      = '#FAF9F6';
const TEXT_M     = '#0F172A';
const TEXT_S     = '#64748B';
const PURPLE_A   = '#A78BFA';   // violet-400
const PURPLE_B   = '#8B5CF6';   // violet-500
const RING_R     = 46;
const RING_CIRC  = +(2 * Math.PI * RING_R).toFixed(2);

// ── Date helpers ───────────────────────────────────────────────────────────────

function fmtDateLong(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtDateShort(date: string, today: string): string {
  if (date === today) return 'Today';
  const yest = new Date(today + 'T12:00:00');
  yest.setDate(yest.getDate() - 1);
  if (date === yest.toISOString().split('T')[0]) return 'Yesterday';
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function getLast7Days(today: string): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() - (6 - i));
    return d.toISOString().split('T')[0];
  });
}

// ── Sparkline ──────────────────────────────────────────────────────────────────

function sparklinePath(values: number[]): string {
  const max = Math.max(...values, 0.001);
  if (max === 0.001) return '';
  const w = 100; const h = 30;
  const pts = values.map((v, i) => [
    (i / Math.max(values.length - 1, 1)) * w,
    h - (v / max) * h * 0.85 + h * 0.075,
  ] as [number, number]);
  if (pts.length < 2) return '';
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    const mx = ((x1 + x2) / 2).toFixed(1);
    const my = ((y1 + y2) / 2).toFixed(1);
    d += ` Q${x1.toFixed(1)},${y1.toFixed(1)} ${mx},${my}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  d += ` T${lx.toFixed(1)},${ly.toFixed(1)}`;
  return d;
}

// ── Score helpers ──────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  // Green when genuinely good; purple as neutral/page tint; orange when poor.
  if (score >= 75) return '#34C759';
  if (score >= 55) return PURPLE_B;
  return '#FF9500';
}

// ── Stage rows (light theme) ───────────────────────────────────────────────────

type StageKey = 'deep' | 'rem' | 'light' | 'awake';

function stageRow(name: string, key: StageKey, barCol: string, sec: number | null | undefined, totalSec: number | null | undefined): string {
  if (!sec || !totalSec) return '';
  const pct  = Math.round((sec / totalSec) * 100);
  const dur  = fmtSleepDuration(sec);
  const qual = stageQuality(key, pct);
  const qualColor = qual.label === 'Excellent' ? '#34C759'
    : qual.label === 'Good'      ? '#3B82F6'
    : qual.label === 'Poor'      ? '#FF9500'
    : '#94A3B8';
  const fill = key === 'awake' && pct > 15 ? '#FF9500' : barCol;
  return `
    <div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:14px;font-weight:500;color:#0F172A">${name}</span>
          ${qual.label ? `<span style="font-size:11px;color:${qualColor}">${qual.label}</span>` : ''}
        </div>
        <span style="font-size:12px;color:#64748B">${dur} · ${pct}%</span>
      </div>
      <div style="height:4px;border-radius:2px;background:#E2E8F0">
        <div style="height:4px;border-radius:2px;width:${Math.min(100, pct)}%;background:${fill}"></div>
      </div>
    </div>`;
}

// ── 7-night score bar chart ───────────────────────────────────────────────────

function scoreTrendChart(entries: PhysiologyDayEntry[]): string {
  const withScores = entries.filter(d => d.sleepScore != null).slice(-7);
  if (withScores.length < 2) return '';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const scores = withScores.map(e => Math.round(e.sleepScore!));
  const BAR_H = 100;

  const bars = withScores.map((e, i) => {
    const score = scores[i];
    const day = DAYS[new Date(e.date + 'T12:00:00').getDay()];
    const barPct = score; // 0-100 maps directly to %
    const barHeight = (barPct / 100) * BAR_H;
    const color = scoreColor(score);

    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
      <div style="height:${BAR_H}px;display:flex;flex-direction:column;justify-content:flex-end;width:100%;padding:0 4px">
        <div style="font-size:9px;font-weight:600;color:#64748B;text-align:center;margin-bottom:2px;font-variant-numeric:tabular-nums">${score}</div>
        <div style="height:${barHeight.toFixed(1)}px;background:${color};border-radius:4px;opacity:0.85;min-height:2px"></div>
      </div>
      <div style="font-size:9px;color:#94A3B8">${day}</div>
    </div>`;
  }).join('');

  return `
    <div style="display:flex;gap:2px;margin-top:10px">${bars}</div>`;
}

// ── Main HTML ──────────────────────────────────────────────────────────────────

function getSleepHTML(physiologyHistory: PhysiologyDayEntry[], wks: any[], displayDate: string): string {
  const today  = new Date().toISOString().split('T')[0];
  const days7  = getLast7Days(today);

  // Find entry for display date.
  // Only fall back to the most recent scored entry when viewing a past date.
  // For today, show no data rather than silently mirroring yesterday's numbers.
  const withScores = physiologyHistory.filter(d => d.sleepScore != null);
  const exactEntry = physiologyHistory.find(d => d.date === displayDate) ?? null;
  const entry = exactEntry ?? (displayDate !== today ? (withScores[withScores.length - 1] ?? null) : null);
  const noDataForDate = exactEntry == null;

  const bigScore    = entry?.sleepScore != null ? Math.round(entry.sleepScore) : null;
  const scoreLabel  = bigScore != null ? sleepScoreLabel(bigScore) : null;
  const durationStr = entry?.sleepDurationSec ? fmtSleepDuration(entry.sleepDurationSec) : null;
  const ringCol     = bigScore != null ? scoreColor(bigScore) : '#94A3B8';
  const ringPct     = bigScore ?? 0;
  const ringOffset  = +(RING_CIRC * (1 - ringPct / 100)).toFixed(2);

  // Context
  const ctx             = entry != null ? getSleepContext(physiologyHistory, entry) : null;
  const durationAvgStr  = ctx?.durationAvgSec ? fmtSleepDuration(ctx.durationAvgSec) : null;
  const score7Days = physiologyHistory.slice(-7).filter(d => d.sleepScore != null);
  const avgScore7  = score7Days.length >= 3
    ? Math.round(score7Days.reduce((s, d) => s + d.sleepScore!, 0) / score7Days.length)
    : null;

  const avg30Days = physiologyHistory.slice(-30).filter(d => d.sleepDurationSec != null);
  const avg30Str  = avg30Days.length >= 14
    ? fmtSleepDuration(Math.round(avg30Days.reduce((s, d) => s + d.sleepDurationSec!, 0) / avg30Days.length))
    : null;
  const durationTarget  = ctx?.durationVsTarget === 'optimal' ? 'In target range (7–9h)'
    : ctx?.durationVsTarget === 'short' ? 'Below target'
    : ctx?.durationVsTarget === 'long'  ? 'Above target'
    : null;
  const targetCol = ctx?.durationVsTarget === 'optimal' ? '#34C759'
    : ctx?.durationVsTarget === 'short'  ? '#FF9500'
    : '#64748B';

  // Stale check
  const latestDate  = entry?.date ?? null;
  const daysSince   = latestDate
    ? Math.floor((new Date(today).getTime() - new Date(latestDate + 'T12:00:00').getTime()) / 86400000)
    : null;
  const isStale     = daysSince != null && daysSince >= 2;
  const latestFmt   = latestDate
    ? new Date(latestDate + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : null;

  // Sleep stages
  const lightSec = entry?.sleepLightSec != null
    ? entry.sleepLightSec
    : (entry?.sleepDurationSec && entry?.sleepDeepSec != null && entry?.sleepRemSec != null && entry?.sleepAwakeSec != null)
      ? Math.max(0, entry.sleepDurationSec - (entry.sleepDeepSec ?? 0) - (entry.sleepRemSec ?? 0) - (entry.sleepAwakeSec ?? 0))
      : null;
  const stageRows = [
    stageRow('Deep',  'deep',  '#3B82F6',              entry?.sleepDeepSec,  entry?.sleepDurationSec),
    stageRow('REM',   'rem',   PURPLE_B,               entry?.sleepRemSec,   entry?.sleepDurationSec),
    stageRow('Light', 'light', 'rgba(78,159,229,0.55)', lightSec,            entry?.sleepDurationSec),
    stageRow('Awake', 'awake', '#CBD5E1',               entry?.sleepAwakeSec, entry?.sleepDurationSec),
  ].join('');
  const hasStages = stageRows.length > 0;

  // Insights
  const stageInsight   = entry != null ? getStageInsight(entry, physiologyHistory) : null;
  const generalInsight = getSleepInsight({ history: physiologyHistory, recentWeeklyTSS: wks.slice(-4).map((w: any) => w.actualTSS ?? 0) });
  const primaryInsight = stageInsight ?? generalInsight;

  const state = getState();
  const dailyTSSByDate = buildDailySignalBTSS(state.wks ?? []);

  // Sleep bank
  const effectiveSleepTarget = state.sleepTargetSec ?? deriveSleepTarget(physiologyHistory);
  const athleteTier           = state.athleteTier ?? 'recreational';
  const hasEnoughHistory      = physiologyHistory.filter(d => d.sleepDurationSec != null).length >= 5;

  // Yesterday's load-adjusted target (for transparency card)
  const yesterday             = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr          = yesterday.toISOString().split('T')[0];
  const yesterdayTSS          = dailyTSSByDate[yesterdayStr] ?? 0;
  const lastNightTarget       = computeLoadAdjustedTarget(effectiveSleepTarget, yesterdayTSS, athleteTier);
  const lastNightLoadBonus    = lastNightTarget - effectiveSleepTarget;

  // Today's load bonus — heavy exercise today raises tonight's sleep target.
  const todayTSS              = dailyTSSByDate[today] ?? 0;
  const tonightLoadBonusSec   = computeLoadAdjustedTarget(effectiveSleepTarget, todayTSS, athleteTier) - effectiveSleepTarget;

  const bank            = getSleepBank(physiologyHistory, effectiveSleepTarget);
  const debtSec         = hasEnoughHistory ? computeSleepDebt(physiologyHistory, dailyTSSByDate, athleteTier, effectiveSleepTarget) : null;
  const nightlyStr      = bank.nightsWithData >= 3 ? fmtNightlyShortfall(bank.avgNightlyShortfallSec) : null;
  const bankTargetL     = fmtSleepDuration(effectiveSleepTarget);

  // Headline: debt > 1h dominates over nightly average — they can tell contradictory stories.
  // "On target" nightly avg + 2h debt is confusing; show the debt as the primary signal.
  const debtDominates   = debtSec != null && debtSec > 3600;
  const fmtDebt = (s: number): string => {
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  };
  const bankHeadline    = debtDominates
    ? fmtDebt(debtSec!)
    : (nightlyStr ?? null);
  const bankSubLabel    = debtDominates ? 'sleep debt' : null;
  // Only show nightly-avg context when it adds information. "On target" contradicts a large debt
  // (debt uses load-adjusted targets per night; avg uses the flat base — they diverge legitimately).
  const bankNightlyCtx  = debtDominates && nightlyStr && nightlyStr !== 'On target' ? `7-night avg: ${nightlyStr}` : null;
  // Recovery target: base + debt-scaled extension + quality bump if recent quality is poor.
  // Debt bands from Walker/Van Dongen sleep extension research.
  // Quality bump: poor quality (avg score < 65) means less restorative sleep → need more time.
  // Bump is one band up, capped so it doesn't push the target past +60 min.
  const poorQuality = avgScore7 != null && avgScore7 < 65;
  const rawIncrementSec = debtSec == null ? 0
    : debtSec < 5400  ? 1200   // < 1.5h debt  → +20 min
    : debtSec < 10800 ? 1800   // 1.5–3h debt  → +30 min
    : debtSec < 18000 ? 2700   // 3–5h debt    → +45 min
    :                   3600;  // > 5h debt     → +60 min
  // Poor quality bumps one band up (e.g. +30 min → +45 min), max +60 min
  const recoveryIncrementSec = poorQuality
    ? Math.min(rawIncrementSec === 1200 ? 1800 : rawIncrementSec === 1800 ? 2700 : rawIncrementSec === 2700 ? 3600 : 3600, 3600)
    : rawIncrementSec;
  const recoveryTargetSec  = effectiveSleepTarget + recoveryIncrementSec + tonightLoadBonusSec;
  const recoveryTargetStr  = fmtSleepDuration(recoveryTargetSec);
  const bankTotalStr    = !debtDominates && debtSec != null && debtSec > 900 ? fmtSleepBank(-debtSec) : null;
  const bankColor       = debtDominates
    ? (debtSec! > 7200 ? '#FF9500' : '#F59E0B')
    : (bank.avgNightlyShortfallSec < -1800 ? '#FF9500' : bank.avgNightlyShortfallSec > 1800 ? '#34C759' : '#64748B');
  // Nightly vs base target chart — always orange
  const bankNights      = physiologyHistory
    .slice(-7)
    .filter(d => d.sleepDurationSec != null)
    .map(d => ({ date: d.date, delta: d.sleepDurationSec! - effectiveSleepTarget }));
  const scoreTrendHTML  = scoreTrendChart(physiologyHistory);
  const combinedCard    = bankNights.length >= 2 || scoreTrendHTML;
  const bankChartHTML   = bankNights.length >= 2
    ? buildSleepBankLineChart(bankNights, '#F97316', '#CBD5E1', !!scoreTrendHTML)
    : '';

  // Cumulative debt chart — same recurrence as the headline (computeSleepDebt):
  // debt_n = debt_{n-1} * DEBT_DECAY + max(0, target_n − actual_n).
  // Plot −debt so the line sits below the target line when in deficit (matches
  // the "below = bad" metaphor used by the duration chart above).
  // Headline + chart line + gradient fill all colour-graduate through the tier,
  // so a small residual looks reassuring and a real deficit looks concerning.
  const debtSeriesAll = computeSleepDebtSeries(physiologyHistory, dailyTSSByDate, athleteTier, effectiveSleepTarget);
  const cumulativeNights = debtSeriesAll.slice(-7).map(n => ({ date: n.date, delta: -n.debt }));
  const debtTier = debtSec != null ? classifySleepDebt(debtSec) : null;
  const debtColor = debtTier?.color ?? '#64748B';
  const cumulativeChartHTML = cumulativeNights.length >= 2
    ? buildSleepBankLineChart(cumulativeNights, debtColor, '#CBD5E1', !!scoreTrendHTML, true, true, true)
    : '';

  // Date picker pills
  const datePills = days7.map(d => {
    const active = d === displayDate;
    return `<button class="sleep-date-pill" data-date="${d}" style="
      padding:6px 16px;border-radius:100px;border:none;cursor:pointer;
      font-size:13px;font-weight:${active ? '600' : '400'};font-family:var(--f);
      background:${active ? 'rgba(0,0,0,0.06)' : 'transparent'};
      color:${active ? TEXT_M : TEXT_S};
      white-space:nowrap;transition:background 0.15s,color 0.15s;
    ">${fmtDateShort(d, today)}</button>`;
  }).join('');

  // 7-night sparkline (score values per date pill)
  const scoreByDate: Record<string, number> = {};
  physiologyHistory.forEach(p => { if (p.sleepScore != null) scoreByDate[p.date] = Math.round(p.sleepScore); });
  const sparkValues = days7.map(d => scoreByDate[d] ?? 0);
  const sparkPath   = sparklinePath(sparkValues);

  return `
    <style>
      #sleep-view { box-sizing: border-box; }
      #sleep-view *, #sleep-view *::before, #sleep-view *::after { box-sizing: inherit; }
      @keyframes sleepFloatUp {
        from { opacity:0; transform:translateY(16px) scale(0.97); }
        to   { opacity:1; transform:translateY(0) scale(1); }
      }
      .sl-fade { opacity:0; animation:sleepFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      .sleep-date-pill:hover { background:rgba(0,0,0,0.04)!important; color:${TEXT_M}!important; }
      ${skyAnimationCSS('slp')}
    </style>

    <div id="sleep-view" style="
      position:relative;min-height:100vh;background:${CREAM};
      font-family:var(--f);overflow-x:hidden;
    ">

      ${buildSkyBackground('slp', 'indigo')}

      <!-- Scrollable content -->
      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="sleep-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div style="text-align:center">
            <div style="font-size:20px;font-weight:700;color:${TEXT_M}">Sleep</div>
            <button id="sleep-date-btn" style="
              display:flex;align-items:center;gap:4px;margin:3px auto 0;
              font-size:12px;color:${TEXT_S};font-weight:500;
              background:none;border:none;cursor:pointer;font-family:var(--f);
            ">
              ${fmtDateLong(displayDate)}
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>

          <div style="width:36px"></div>
        </div>

        <!-- Date picker -->
        <div id="sleep-date-picker" style="
          display:none;overflow-x:auto;padding:0 16px 12px;
          scrollbar-width:none;-ms-overflow-style:none;
        ">
          <div style="display:flex;gap:6px;width:max-content;padding-bottom:2px">${datePills}</div>
        </div>

        <!-- Ring -->
        <div class="sl-fade" style="animation-delay:0.08s;display:flex;justify-content:center;margin:12px 0 28px">
          <div style="position:relative;width:220px;height:220px;display:flex;align-items:center;justify-content:center">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="sleepRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${PURPLE_A}"/>
                  <stop offset="100%" stop-color="${PURPLE_B}"/>
                </linearGradient>
              </defs>
              <!-- Track -->
              <circle cx="50" cy="50" r="${RING_R}"
                fill="none"
                fill="rgba(255,255,255,0.85)" stroke="rgba(241,245,249,0.5)"
                stroke-width="8"
                stroke-linecap="round"/>
              <!-- Fill -->
              ${bigScore != null ? `<circle id="sleep-ring-circle" cx="50" cy="50" r="${RING_R}"
                fill="none"
                stroke="${bigScore >= 55 ? 'url(#sleepRingGrad)' : '#FF9500'}"
                stroke-width="8"
                stroke-linecap="round"
                stroke-dasharray="${RING_CIRC}"
                stroke-dashoffset="${RING_CIRC}"
                style="transition:stroke-dashoffset 1.0s cubic-bezier(0.34,1.2,0.64,1)"/>` : ''}
            </svg>
            <!-- Centre text -->
            <div style="
              position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;
              background:rgba(255,255,255,0.95);backdrop-filter:blur(8px);
              width:180px;height:180px;border-radius:50%;
              box-shadow:inset 0 2px 8px rgba(0,0,0,0.03);border:1px solid rgba(255,255,255,0.5);
            ">
              ${bigScore != null
                ? `<div style="display:flex;align-items:baseline;color:${TEXT_M}">
                    <span style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1">${bigScore}</span>
                    <span style="font-size:14px;font-weight:500;line-height:1;margin-left:2px;color:${TEXT_S}">/100</span>
                   </div>
                   <span style="font-size:12px;color:${TEXT_S};margin-top:4px;font-weight:500">${scoreLabel ?? ''}</span>`
                : `<span style="font-size:14px;color:#94A3B8">No data</span>`}
            </div>
          </div>
        </div>

        <!-- ── Last night ──────────────────────────────────────────────── -->

        <!-- No data for today banner -->
        ${noDataForDate && displayDate === today ? `
        <div class="sl-fade" style="animation-delay:0.14s;margin:0 16px 10px;padding:12px 14px;border-radius:12px;border:1px solid rgba(148,163,184,0.3);background:white">
          <p style="font-size:13px;font-weight:600;color:#0F172A;margin:0 0 4px">No sleep data yet for today</p>
          <p style="font-size:12px;color:#64748B;margin:0;line-height:1.45">Open the Garmin Connect app and sync your device to pull in last night's data.</p>
        </div>` : ''}

        <!-- Stale banner — only when viewing today, not historic dates -->
        ${isStale && displayDate === today ? `
        <div class="sl-fade" style="animation-delay:0.14s;margin:0 16px 10px;padding:10px 14px;border-radius:12px;border:1px solid rgba(255,149,0,0.25);background:white">
          <p style="font-size:12px;color:#FF9500;margin:0;line-height:1.4">Last synced ${latestFmt ?? ''}. Open Garmin Connect to update.</p>
        </div>` : ''}

        <!-- Duration tile -->
        ${durationStr ? `
        <div class="sl-fade" style="animation-delay:0.14s;padding:0 16px;margin-bottom:10px">
          <div style="background:white;border-radius:16px;padding:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="font-size:11px;color:#94A3B8;margin-bottom:6px">Last night</div>
            <div style="font-size:26px;font-weight:300;color:#0F172A;line-height:1">${durationStr}</div>
            ${durationTarget ? `<div style="font-size:11px;color:${targetCol};margin-top:4px">${durationTarget}</div>` : ''}
          </div>
        </div>` : ''}

        <!-- Sleep stages -->
        ${hasStages ? `
        <div class="sl-fade" style="animation-delay:0.18s;margin:0 16px 14px">
          <div style="background:white;border-radius:16px;padding:18px 18px 4px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="font-size:12px;color:#94A3B8;margin-bottom:14px">Sleep stages</div>
            ${stageRows}
          </div>
        </div>` : bigScore != null ? `
        <div class="sl-fade" style="animation-delay:0.18s;margin:0 16px 14px;padding:12px 16px;background:white;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
          <p style="font-size:12px;color:#94A3B8;margin:0">Stage breakdown not available. Garmin typically syncs within a few hours of waking.</p>
        </div>` : ''}

        <!-- ── Analysis ────────────────────────────────────────────────── -->

        ${primaryInsight ? `
        <div class="sl-fade" style="animation-delay:0.22s;margin:0 16px 14px;padding:16px;background:white;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
          <div style="font-size:13px;font-weight:600;color:#0F172A;margin-bottom:6px">Analysis</div>
          <div style="font-size:13px;line-height:1.55;color:#64748B">${primaryInsight}</div>
        </div>` : ''}

        <!-- ── Weekly summary ──────────────────────────────────────────── -->

        <!-- 7-night + 30-day avg tiles -->
        ${durationAvgStr || avg30Str ? `
        <div class="sl-fade" style="animation-delay:0.26s;display:flex;gap:10px;padding:0 16px;margin-bottom:10px">
          ${durationAvgStr ? `
          <div style="flex:1;background:white;border-radius:16px;padding:14px 16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="font-size:11px;color:#94A3B8;margin-bottom:5px">7-night avg</div>
            <div style="font-size:22px;font-weight:300;color:#0F172A;line-height:1">${durationAvgStr}</div>
            <div style="font-size:11px;color:#94A3B8;margin-top:3px">per night</div>
            ${avgScore7 != null ? `<div style="font-size:11px;color:${scoreColor(avgScore7)};margin-top:4px;padding-top:4px;border-top:1px solid #F1F5F9">Score ${avgScore7}/100</div>` : ''}
          </div>` : ''}
          ${avg30Str ? `
          <div style="flex:1;background:white;border-radius:16px;padding:14px 16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="font-size:11px;color:#94A3B8;margin-bottom:5px">30-day avg</div>
            <div style="font-size:22px;font-weight:300;color:#0F172A;line-height:1">${avg30Str}</div>
            <div style="font-size:11px;color:#94A3B8;margin-top:3px">per night</div>
          </div>` : ''}
        </div>` : ''}

        <!-- ── Sleep debt ───────────────────────────────────────────────── -->

        <!-- Tonight's target -->
        ${hasEnoughHistory && debtDominates ? `
        <div class="sl-fade" style="animation-delay:0.30s;margin:0 16px 14px;padding:16px;background:white;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
          <div style="font-size:12px;color:#94A3B8;margin-bottom:6px">Tonight's target</div>
          <div style="font-size:34px;font-weight:300;color:#0F172A;line-height:1">${recoveryTargetStr}</div>
          <div style="font-size:12px;color:#94A3B8;margin-top:6px;line-height:1.5">Base ${bankTargetL}${recoveryIncrementSec > 0 ? ` + ${Math.round(recoveryIncrementSec / 60)} min debt recovery` : ''}${tonightLoadBonusSec > 0 ? ` + ${Math.round(tonightLoadBonusSec / 60)} min from high exercise load` : ''}</div>
        </div>` : !hasEnoughHistory ? `
        <div class="sl-fade" style="animation-delay:0.30s;margin:0 16px 14px;padding:16px;background:white;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
          <div style="font-size:12px;color:#94A3B8;margin-bottom:4px">Sleep target</div>
          <div style="font-size:15px;font-weight:500;color:#1e293b">${bankTargetL}/night</div>
          <div style="font-size:12px;color:#94A3B8;margin-top:4px">Personalises after 5 nights of data</div>
        </div>` : ''}

        <!-- Last 7 nights: duration + debt + score combined -->
        ${combinedCard ? `
        <div class="sl-fade" style="animation-delay:0.32s;margin:0 16px 14px;padding:16px;background:white;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
          <div style="font-size:12px;color:#94A3B8;margin-bottom:2px">Last 7 nights</div>
          ${bankChartHTML ? `
          <div style="margin-bottom:8px">
            <div style="font-size:10px;color:#94A3B8;margin-top:10px;margin-bottom:-8px">Duration vs ${bankTargetL} target</div>
            ${bankChartHTML}
          </div>` : ''}
          ${cumulativeChartHTML ? `
          <div style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;align-items:baseline">
              <div style="font-size:10px;color:#94A3B8">Cumulative sleep debt</div>
              <div style="font-size:11px;font-weight:600;color:${debtColor}">${
                debtTier == null
                  ? 'On target'
                  : debtTier.showNumber
                    ? `${fmtDebt(debtSec!)}<span style="font-weight:400;font-size:10px;opacity:0.85"> · ${debtTier.label}</span>`
                    : debtTier.label[0].toUpperCase() + debtTier.label.slice(1)
              }</div>
            </div>
            ${cumulativeChartHTML}
          </div>` : ''}
          ${scoreTrendHTML ? `
          <div>
            <div style="font-size:10px;color:#94A3B8;margin-bottom:-6px">Sleep score</div>
            ${scoreTrendHTML}
          </div>` : ''}
        </div>` : ''}

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

// ── Handlers ───────────────────────────────────────────────────────────────────

function wireSleepHandlers(physiologyHistory: PhysiologyDayEntry[], wks: any[], displayDate: string, onBack?: () => void): void {
  // Animate ring
  setTimeout(() => {
    const circle = document.getElementById('sleep-ring-circle') as SVGCircleElement | null;
    if (circle) {
      const score = physiologyHistory.find(d => d.date === displayDate)?.sleepScore
        ?? physiologyHistory.filter(d => d.sleepScore != null).slice(-1)[0]?.sleepScore
        ?? null;
      if (score != null) {
        circle.style.strokeDashoffset = String((RING_CIRC * (1 - Math.min(score, 100) / 100)).toFixed(2));
      }
    }
  }, 50);

  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Back
  document.getElementById('sleep-back-btn')?.addEventListener('click', () => {
    if (onBack) {
      onBack();
    } else {
      import('./recovery-view').then(({ renderRecoveryView }) => renderRecoveryView());
    }
  });

  // Date picker toggle
  const picker = document.getElementById('sleep-date-picker');
  document.getElementById('sleep-date-btn')?.addEventListener('click', () => {
    if (!picker) return;
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  });

  // Date pill selection
  document.querySelectorAll<HTMLElement>('.sleep-date-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const date = btn.dataset.date;
      if (date) renderSleepView(date, physiologyHistory, wks, onBack);
    });
  });
}

// ── Public entry point ─────────────────────────────────────────────────────────

export function renderSleepView(
  date?: string,
  physiologyHistory?: PhysiologyDayEntry[],
  wks?: any[],
  onBack?: () => void,
): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const ph  = physiologyHistory ?? s.physiologyHistory ?? [];
  const wkd = wks ?? s.wks ?? [];
  const today = new Date().toISOString().split('T')[0];
  const displayDate = date ?? today;
  container.innerHTML = getSleepHTML(ph, wkd, displayDate);
  wireSleepHandlers(ph, wkd, displayDate, onBack);
}
