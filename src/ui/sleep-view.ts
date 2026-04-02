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
  getStageInsight,
  deriveSleepTarget,
  buildSleepBankLineChart,
} from '@/calculations/sleep-insights';

// ── Design tokens ──────────────────────────────────────────────────────────────

const CREAM      = '#FDF7F2';
const GRAD_BG    = 'linear-gradient(180deg, #1a0d2e 0%, #2d1a4a 40%, #3d2460 100%)';
const PURPLE_A   = '#A78BFA';   // violet-400
const PURPLE_B   = '#8B5CF6';   // violet-500
const RING_R     = 57;
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

// ── 7-night trend chart ────────────────────────────────────────────────────────

function scoreTrendChart(entries: PhysiologyDayEntry[]): string {
  const withScores = entries.filter(d => d.sleepScore != null).slice(-7);
  if (withScores.length < 2) return '';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const TW = 320; const TH = 60; const TPV = 6;
  const scores = withScores.map(e => Math.round(e.sleepScore!));
  const minS = Math.max(0, Math.min(...scores) - 8);
  const maxS = Math.min(100, Math.max(...scores) + 8);
  const range = maxS - minS || 1;
  const yOf = (v: number) => TPV + ((maxS - v) / range) * (TH - TPV * 2);
  const xOf = (i: number) => withScores.length > 1 ? (i / (withScores.length - 1)) * TW : TW / 2;
  const pts = withScores.map((e, i) => ({ x: xOf(i), y: yOf(e.sleepScore!) }));
  const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L${pts[pts.length - 1].x.toFixed(1)},${TH} L${pts[0].x.toFixed(1)},${TH} Z`;
  const trendCol = scores[scores.length - 1] >= scores[0] ? '#34C759' : '#FF453A';
  const xLabels = withScores.map((e, i) => {
    const pct = (pts[i].x / TW * 100).toFixed(1);
    const day = DAYS[new Date(e.date + 'T12:00:00').getDay()];
    return `<span style="position:absolute;left:${pct}%;transform:translateX(-50%);font-size:9px;color:#94A3B8;bottom:0;text-align:center;line-height:1.3">${day}<br>${scores[i]}</span>`;
  }).join('');
  return `
    <div style="position:relative;margin-top:10px">
      <svg width="100%" height="${TH}" viewBox="0 0 ${TW} ${TH}" preserveAspectRatio="none">
        <path d="${areaD}" fill="${trendCol}" opacity="0.15"/>
        <path d="${lineD}" fill="none" stroke="${trendCol}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <div style="position:relative;height:28px;margin-top:4px">${xLabels}</div>
    </div>`;
}

// ── Main HTML ──────────────────────────────────────────────────────────────────

function getSleepHTML(physiologyHistory: PhysiologyDayEntry[], wks: any[], displayDate: string): string {
  const today  = new Date().toISOString().split('T')[0];
  const days7  = getLast7Days(today);

  // Find entry for display date
  const withScores = physiologyHistory.filter(d => d.sleepScore != null);
  const entry = physiologyHistory.find(d => d.date === displayDate) ?? withScores[withScores.length - 1] ?? null;

  const bigScore    = entry?.sleepScore != null ? Math.round(entry.sleepScore) : null;
  const scoreLabel  = bigScore != null ? sleepScoreLabel(bigScore) : null;
  const durationStr = entry?.sleepDurationSec ? fmtSleepDuration(entry.sleepDurationSec) : null;
  const ringCol     = bigScore != null ? scoreColor(bigScore) : '#94A3B8';
  const ringPct     = bigScore ?? 0;
  const ringOffset  = +(RING_CIRC * (1 - ringPct / 100)).toFixed(2);

  // Context
  const ctx             = entry != null ? getSleepContext(physiologyHistory, entry) : null;
  const durationAvgStr  = ctx?.durationAvgSec ? fmtSleepDuration(ctx.durationAvgSec) : null;
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

  // Sleep bank
  const effectiveSleepTarget = getState().sleepTargetSec ?? deriveSleepTarget(physiologyHistory);
  const bank        = getSleepBank(physiologyHistory, effectiveSleepTarget);
  const bankStr     = bank.nightsWithData >= 3 ? fmtSleepBank(bank.bankSec) : null;
  const bankTargetL = fmtSleepDuration(effectiveSleepTarget);
  const bankColor   = bank.bankSec < -3600 ? '#FF9500' : bank.bankSec > 3600 ? '#34C759' : '#64748B';
  const bankNights  = physiologyHistory
    .slice(-14)
    .filter(d => d.sleepDurationSec != null)
    .map(d => ({ date: d.date, delta: d.sleepDurationSec! - effectiveSleepTarget }));
  const bankChartHTML = bankNights.length >= 2
    ? buildSleepBankLineChart(bankNights, bankColor, '#CBD5E1')
    : '';

  // Date picker pills
  const datePills = days7.map(d => {
    const active = d === displayDate;
    return `<button class="sleep-date-pill" data-date="${d}" style="
      padding:6px 16px;border-radius:100px;border:none;cursor:pointer;
      font-size:13px;font-weight:${active ? '600' : '400'};font-family:var(--f);
      background:${active ? 'rgba(255,255,255,0.22)' : 'transparent'};
      color:${active ? 'white' : 'rgba(255,255,255,0.55)'};
      backdrop-filter:${active ? 'blur(8px)' : 'none'};
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
        from { opacity:0; transform:translateY(10px); }
        to   { opacity:1; transform:translateY(0); }
      }
      .sl-fade { opacity:0; animation:sleepFloatUp 0.55s ease-out forwards; }
      .sleep-date-pill:hover { background:rgba(255,255,255,0.15)!important; color:white!important; }
    </style>

    <div id="sleep-view" style="
      position:relative;min-height:100vh;background:${CREAM};
      font-family:var(--f);overflow-x:hidden;
    ">

      <!-- Dark gradient hero -->
      <div style="
        position:absolute;top:0;left:0;right:0;height:480px;
        background:${GRAD_BG};overflow:hidden;pointer-events:none;z-index:0;
      ">
        <div style="position:absolute;width:260px;height:260px;border-radius:50%;background:${PURPLE_A};filter:blur(90px);opacity:0.45;top:-60px;left:-70px"></div>
        <div style="position:absolute;width:220px;height:220px;border-radius:50%;background:${PURPLE_B};filter:blur(80px);opacity:0.4;top:160px;right:-50px"></div>
        <div style="position:absolute;width:150px;height:150px;border-radius:50%;background:#6D28D9;filter:blur(60px);opacity:0.35;bottom:70px;left:30%"></div>
        <div style="position:absolute;inset:0;background:linear-gradient(to bottom,transparent 55%,${CREAM})"></div>
      </div>

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
            background:rgba(255,255,255,0.15);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:white;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div style="text-align:center">
            <div style="font-size:20px;font-weight:600;color:white;text-shadow:0 1px 4px rgba(0,0,0,0.2)">Sleep</div>
            <button id="sleep-date-btn" style="
              display:flex;align-items:center;gap:4px;margin:3px auto 0;
              font-size:12px;color:rgba(255,255,255,0.78);font-weight:500;
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
          <div style="
            position:relative;width:220px;height:220px;
            display:flex;align-items:center;justify-content:center;
            background:rgba(255,255,255,0.18);backdrop-filter:blur(20px);
            border-radius:50%;border:1px solid rgba(255,255,255,0.3);
            box-shadow:0 8px 60px -10px rgba(0,0,0,0.35);
          ">
            <svg width="160" height="160" viewBox="0 0 160 160" style="position:absolute">
              <defs>
                <linearGradient id="sleepRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${PURPLE_A}"/>
                  <stop offset="100%" stop-color="${PURPLE_B}"/>
                </linearGradient>
              </defs>
              <!-- Track -->
              <circle cx="80" cy="80" r="${RING_R}"
                fill="none"
                stroke="rgba(255,255,255,0.15)"
                stroke-width="9"
                stroke-linecap="round"
                transform="rotate(-90 80 80)"/>
              <!-- Fill -->
              ${bigScore != null ? `<circle id="sleep-ring-circle" cx="80" cy="80" r="${RING_R}"
                fill="none"
                stroke="${bigScore >= 75 ? '#34C759' : bigScore >= 55 ? 'url(#sleepRingGrad)' : '#FF9500'}"
                stroke-width="9"
                stroke-linecap="round"
                stroke-dasharray="${RING_CIRC}"
                stroke-dashoffset="${RING_CIRC}"
                transform="rotate(-90 80 80)"
                style="transition:stroke-dashoffset 1.0s cubic-bezier(0.34,1.2,0.64,1)"/>` : ''}
            </svg>
            <!-- Centre text -->
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:1">
              ${bigScore != null
                ? `<div style="display:flex;align-items:flex-start;color:white">
                    <span style="font-size:52px;font-weight:700;letter-spacing:-0.03em;line-height:1">${bigScore}</span>
                    <span style="font-size:20px;font-weight:700;line-height:1;margin-top:5px">/100</span>
                   </div>
                   <span style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:2px">${scoreLabel ?? ''}</span>`
                : `<span style="font-size:14px;color:rgba(255,255,255,0.5)">No data</span>`}
            </div>
          </div>
        </div>

        <!-- Duration + avg tiles -->
        ${durationStr || durationAvgStr ? `
        <div class="sl-fade" style="animation-delay:0.14s;display:flex;gap:10px;padding:0 16px;margin-bottom:14px">
          ${durationStr ? `
          <div style="flex:1;background:white;border-radius:20px;padding:16px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
            <div style="font-size:11px;color:#94A3B8;margin-bottom:6px">Duration</div>
            <div style="font-size:26px;font-weight:300;color:#0F172A;line-height:1">${durationStr}</div>
            ${durationTarget ? `<div style="font-size:11px;color:${targetCol};margin-top:4px">${durationTarget}</div>` : ''}
          </div>` : ''}
          ${durationAvgStr ? `
          <div style="flex:1;background:white;border-radius:20px;padding:16px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
            <div style="font-size:11px;color:#94A3B8;margin-bottom:6px">7-night avg</div>
            <div style="font-size:26px;font-weight:300;color:#0F172A;line-height:1">${durationAvgStr}</div>
            <div style="font-size:11px;color:#94A3B8;margin-top:4px">per night</div>
          </div>` : ''}
        </div>` : ''}

        <!-- Stale banner -->
        ${isStale ? `
        <div class="sl-fade" style="animation-delay:0.16s;margin:0 16px 14px;padding:10px 14px;border-radius:12px;border:1px solid rgba(255,149,0,0.25);background:white">
          <p style="font-size:12px;color:#FF9500;margin:0;line-height:1.4">Last synced ${latestFmt ?? ''}. Open Garmin Connect to update.</p>
        </div>` : ''}

        <!-- Sleep stages -->
        ${hasStages ? `
        <div class="sl-fade" style="animation-delay:0.20s;margin:0 16px 14px">
          <div style="background:white;border-radius:20px;padding:18px 18px 4px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
            <div style="font-size:12px;color:#94A3B8;margin-bottom:14px">Sleep stages</div>
            ${stageRows}
          </div>
        </div>` : bigScore != null ? `
        <div class="sl-fade" style="animation-delay:0.20s;margin:0 16px 14px;padding:12px 16px;background:white;border-radius:16px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
          <p style="font-size:12px;color:#94A3B8;margin:0">Stage breakdown not available. Garmin typically syncs within a few hours of waking.</p>
        </div>` : `
        <div style="padding:24px;text-align:center">
          <div style="font-size:13px;color:#94A3B8">No sleep data. Garmin syncs within a few hours of waking.</div>
        </div>`}

        <!-- Analysis card -->
        ${primaryInsight ? `
        <div class="sl-fade" style="animation-delay:0.24s;margin:0 16px 14px;padding:16px;background:white;border-radius:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
          <div style="font-size:13px;font-weight:600;color:#0F172A;margin-bottom:6px">Analysis</div>
          <div style="font-size:13px;line-height:1.55;color:#64748B">${primaryInsight}</div>
        </div>` : ''}

        <!-- 7-night trend -->
        ${scoreTrendChart(physiologyHistory) ? `
        <div class="sl-fade" style="animation-delay:0.28s;margin:0 16px 14px;padding:16px;background:white;border-radius:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
          <div style="font-size:12px;color:#94A3B8;margin-bottom:2px">Last 7 nights</div>
          ${scoreTrendChart(physiologyHistory)}
        </div>` : ''}

        <!-- Sleep bank -->
        ${bankStr ? `
        <div class="sl-fade" style="animation-delay:0.32s;margin:0 16px 14px;padding:16px;background:white;border-radius:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <div style="font-size:12px;color:#94A3B8">Sleep bank · last ${bank.nightsWithData} night${bank.nightsWithData === 1 ? '' : 's'}</div>
            <div style="font-size:11px;color:#94A3B8">vs ${bankTargetL}/night</div>
          </div>
          <div style="font-size:28px;font-weight:300;color:${bankColor};margin-top:6px">${bankStr}</div>
          ${bankChartHTML}
        </div>` : ''}

      </div>
    </div>
  `;
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
