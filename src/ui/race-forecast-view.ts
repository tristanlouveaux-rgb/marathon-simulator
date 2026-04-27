/**
 * Race Forecast detail page — race mode only.
 * Opens from the race forecast card on Home.
 *
 * Shows:
 *   - Hero: predicted finish time + delta vs target
 *   - Line chart: actual VDOT-derived race-time progression (solid)
 *     extended with a dotted projection to s.forecastTime at week s.tw
 *   - Horizontal dashed reference line at the goal time (s.initialBaseline)
 *   - Optional "Add a quality session" CTA when forecast lags goal materially
 *   - Race-day pacing disclaimer footnote
 */

import { getState, getMutableState, saveState } from '@/state';
import type { SimulatorState } from '@/types/state';
import { tv, rdKm } from '@/calculations/vdot';
import { ft } from '@/utils/format';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';

// ── Design tokens ─────────────────────────────────────────────────────────────

const PAGE_BG = '#FAF9F6';
const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';

const CHART_STROKE = '#64748B';
const GOAL_STROKE  = '#C48A3A'; // warm amber — distinct from the grey projection line
const CARD = `background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)`;

const RING_GREEN_A = '#7BB37D';
const RING_GREEN_B = '#4F8A52';
const RING_AMBER_A = '#E8B154';
const RING_AMBER_B = '#C4884E';
const RING_RED_A   = '#D6726B';
const RING_RED_B   = '#A14B47';
const RING_R       = 46;
const RING_CIRC    = +(2 * Math.PI * RING_R).toFixed(2);

const RACE_DIST_LABEL: Record<string, string> = {
  '5k': '5K',
  '10k': '10K',
  'half': 'Half marathon',
  'marathon': 'Marathon',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function deltaString(forecastSec: number, goalSec: number): { text: string; tone: 'on'|'slow'|'fast' } {
  const d = Math.round(forecastSec - goalSec);
  if (Math.abs(d) < 60) return { text: 'On pace', tone: 'on' };
  const m = Math.round(Math.abs(d) / 60);
  return d > 0
    ? { text: `+${m} min`, tone: 'slow' }
    : { text: `\u2212${m} min`, tone: 'fast' };
}

function fmtWeekLabel(week: number, tw: number): string {
  if (week <= 1) return 'Wk 1';
  if (week >= tw) return `Wk ${tw}`;
  return `Wk ${week}`;
}

// ── Chart builder ────────────────────────────────────────────────────────────

interface ChartPoint {
  week: number;          // 1-indexed plan week
  timeSec: number;       // race-time in seconds at this point
  kind: 'actual' | 'projection';
}

function buildForecastChart(
  startedSec: number,
  goalSec: number,
  history: ChartPoint[],
  projection: ChartPoint[],
  totalWeeks: number,
): string {
  // Combine for axis range — started anchor + every actual + projection endpoint
  const allSecs = [
    startedSec,
    goalSec,
    ...history.map(p => p.timeSec),
    ...projection.map(p => p.timeSec),
  ].filter(v => v > 0);
  if (allSecs.length < 2) return '';

  // Y-axis: faster times sit higher on the chart.
  const minY = Math.min(...allSecs);
  const maxY = Math.max(...allSecs);
  const padY = Math.max(60, (maxY - minY) * 0.18); // at least 1 min headroom
  const yLo  = minY - padY;
  const yHi  = maxY + padY;
  const yRange = Math.max(1, yHi - yLo);

  const W = 320, H = 130, padL = 6, padR = 6;
  const usableW = W - padL - padR;

  const xOf = (week: number) => padL + ((week - 1) / Math.max(1, totalWeeks - 1)) * usableW;
  // Lower (faster) time → higher on chart (smaller y)
  const yOf = (sec: number) => {
    const t = (sec - yLo) / yRange;
    return H - t * (H - 8) - 4;
  };

  // Solid actual polyline from real history only. Do not synthesise a week-1
  // anchor from the current value — that produces a misleading flat line when
  // we only have one data point. When history has <2 points, skip the actual
  // line and render a single marker circle at the current point instead, so
  // the user sees "we don't have progression data yet" truthfully.
  const actualPts: [number, number][] = history.map(p => [xOf(p.week), yOf(p.timeSec)]);

  // Anchor for the projection segment and the "today" split marker. Use the
  // last real history point when available, otherwise fall back to (currentWeek,
  // startedSec) so the projection still draws from today's estimate.
  const projectionAnchor: [number, number] = actualPts.length > 0
    ? actualPts[actualPts.length - 1]
    : [xOf(Math.min(history.length > 0 ? history[history.length - 1].week : 1, totalWeeks)), yOf(startedSec)];
  const lastActual = projectionAnchor;

  const projPts: [number, number][] = [projectionAnchor];
  for (const p of projection) {
    projPts.push([xOf(p.week), yOf(p.timeSec)]);
  }

  const actualPath = actualPts.length >= 2
    ? `M ${actualPts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`
    : '';
  const projPath = projPts.length >= 2
    ? `M ${projPts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`
    : '';

  // Single-point marker: when we have ≤1 history point we can't draw an actual
  // line, so render a filled circle at the anchor to give the user something to
  // orient the projection against.
  const showMarker = actualPts.length < 2;
  const markerCircle = showMarker
    ? `<circle cx="${projectionAnchor[0].toFixed(1)}" cy="${projectionAnchor[1].toFixed(1)}" r="3" fill="${CHART_STROKE}"/>`
    : '';

  // Horizontal reference line at goal — warm amber so it is visually distinct
  // from the grey dashed projection. Solid stroke (not dashed) reinforces the
  // distinction with the projection line which uses dash-pattern.
  const goalY = yOf(goalSec);
  const goalLine = `<line x1="${padL}" y1="${goalY.toFixed(1)}" x2="${W - padR}" y2="${goalY.toFixed(1)}" stroke="${GOAL_STROKE}" stroke-width="1.25" opacity="0.7"/>`;

  // Vertical split marker at "today" (last actual point)
  const splitX = lastActual[0];
  const splitLine = projection.length > 0
    ? `<line x1="${splitX.toFixed(1)}" y1="0" x2="${splitX.toFixed(1)}" y2="${H}" stroke="rgba(0,0,0,0.10)" stroke-width="1" stroke-dasharray="2 3"/>`
    : '';

  // X-axis labels: Wk 1 / Wk now / Wk tw
  const nowWeek = history.length > 0 ? history[history.length - 1].week : 1;
  const xLabels: Array<{ left: number; label: string; bold: boolean }> = [
    { left: xOf(1), label: 'Wk 1', bold: false },
  ];
  if (nowWeek > 1 && nowWeek < totalWeeks) {
    xLabels.push({ left: xOf(nowWeek), label: `Wk ${nowWeek}`, bold: true });
  }
  xLabels.push({ left: xOf(totalWeeks), label: fmtWeekLabel(totalWeeks, totalWeeks), bold: false });

  const xLabelHtml = xLabels.map(l => {
    const leftPct = ((l.left / W) * 100).toFixed(1);
    return `<span style="position:absolute;left:${leftPct}%;transform:translateX(-50%);font-size:9px;color:${l.bold ? TEXT_M : TEXT_L};font-weight:${l.bold ? '600' : '400'};white-space:nowrap">${l.label}</span>`;
  }).join('');

  // Goal label (right of chart, in gutter) — amber tint matches the goal line
  const goalLabelHtml = `<span style="position:absolute;top:${((goalY / H) * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:${GOAL_STROKE};line-height:1;font-variant-numeric:tabular-nums;font-weight:600">Goal ${ft(goalSec)}</span>`;

  return `
    <div style="position:relative;padding-right:64px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${goalLine}
        ${splitLine}
        ${actualPath ? `<path d="${actualPath}" class="rfc-draw-actual" fill="none" stroke="${CHART_STROKE}" stroke-width="1.6" stroke-linejoin="round"/>` : ''}
        ${projPath ? `<path d="${projPath}" class="rfc-draw-proj" fill="none" stroke="${CHART_STROKE}" stroke-width="1.6" stroke-linejoin="round" stroke-dasharray="4 3" opacity="0.55"/>` : ''}
        ${markerCircle}
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${goalLabelHtml}</div>
    </div>
    <div style="position:relative;height:18px;margin-top:6px;padding-right:64px">${xLabelHtml}</div>`;
}

// ── HTML assembly ────────────────────────────────────────────────────────────

function getRaceForecastHTML(s: SimulatorState): string {
  const distKey = s.rd ?? 'marathon';
  const distLabel = RACE_DIST_LABEL[distKey] ?? 'Race';
  const distKm = rdKm(distKey);

  const goalSec = s.initialBaseline ?? 0;
  const forecastSec = s.forecastTime ?? s.blendedRaceTimeSec ?? s.currentFitness ?? 0;

  const totalWeeks = s.tw ?? (s.wks?.length ?? 16);
  const currentWeek = Math.max(1, Math.min(totalWeeks, s.w ?? 1));

  // Build actual history points from vdotHistory. One point per plan week,
  // latest entry wins. Drop entries beyond the current week.
  const vh = s.vdotHistory ?? [];
  const weekMap = new Map<number, number>();
  for (const h of vh) {
    if (!h.vdot || h.vdot <= 0) continue;
    if (h.week < 1 || h.week > currentWeek) continue;
    weekMap.set(h.week, tv(h.vdot, distKm));
  }

  const history: ChartPoint[] = Array.from(weekMap.entries())
    .map(([week, timeSec]) => ({ week, timeSec, kind: 'actual' as const }))
    .sort((a, b) => a.week - b.week);

  const nowSec = history.length > 0
    ? history[history.length - 1].timeSec
    : (s.blendedRaceTimeSec ?? s.currentFitness ?? forecastSec);

  // Projection: from currentWeek to totalWeeks ending at forecastSec
  const projection: ChartPoint[] = [];
  if (forecastSec > 0 && currentWeek < totalWeeks) {
    projection.push({ week: totalWeeks, timeSec: forecastSec, kind: 'projection' });
  }

  // Hero ring: amber by default (warm palette), red when seriously off-track.
  const delta = deltaString(forecastSec, goalSec);
  const slowSec = Math.max(0, forecastSec - goalSec);
  let ringA = RING_AMBER_A, ringB = RING_AMBER_B;
  if (slowSec > 900) { ringA = RING_RED_A; ringB = RING_RED_B; }

  // Ring fill: completion toward race day. (Visual progress, not delta encoding —
  // delta lives in the ring colour and the central numerals.)
  const progressPct = totalWeeks > 1 ? ((currentWeek - 1) / (totalWeeks - 1)) * 100 : 100;
  const ringOffset = +(RING_CIRC * (1 - Math.min(100, Math.max(0, progressPct)) / 100)).toFixed(2);

  const deltaColor = delta.tone === 'on' ? TEXT_M
    : delta.tone === 'fast' ? '#1F7A3D'
    : (slowSec > 900 ? '#A33A33' : '#9A6A20');

  const chart = buildForecastChart(nowSec, goalSec, history, projection, totalWeeks);

  // CTA conditions: race mode, forecast ≥ +20 min slower than goal, not in taper, epw < 7
  const inTaper = (s.wks ?? [])[currentWeek - 1]?.ph === 'taper';
  const epw = s.epw ?? s.rw ?? 0;
  const showCTA = !inTaper
    && epw < 7
    && forecastSec > 0
    && goalSec > 0
    && (forecastSec - goalSec) >= 1200;

  const ctaCard = showCTA ? `
    <div class="rfc-fade" style="animation-delay:0.20s;padding:0 16px;margin-bottom:14px">
      <div style="${CARD};padding:18px">
        <div style="font-size:12px;color:${TEXT_S};font-weight:500;margin-bottom:4px">Lagging the goal</div>
        <div style="font-size:14px;color:${TEXT_M};line-height:1.45;margin-bottom:14px">
          Adding one quality session per week increases the training stimulus over the remaining ${Math.max(1, totalWeeks - currentWeek + 1)} weeks. Forecast updates immediately.
        </div>
        <button id="rfc-add-session" style="
          width:100%;padding:11px 16px;border-radius:100px;border:1px solid var(--c-border);
          background:transparent;color:${TEXT_M};font-family:var(--f);
          font-size:13px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;
        ">Add a quality session</button>
      </div>
    </div>
  ` : '';

  // Stat row: Target · Current · Forecast
  const statRow = `
    <div class="rfc-fade" style="animation-delay:0.10s;padding:0 16px;margin-bottom:14px">
      <div style="${CARD};padding:18px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500;margin-bottom:4px">Target</div>
          <div style="font-size:18px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em;line-height:1">${ft(goalSec)}</div>
        </div>
        <div style="flex:1;min-width:0;border-left:1px solid rgba(0,0,0,0.06);padding-left:12px">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500;margin-bottom:4px">Current</div>
          <div style="font-size:18px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em;line-height:1">${ft(nowSec)}</div>
        </div>
        <div style="flex:1;min-width:0;border-left:1px solid rgba(0,0,0,0.06);padding-left:12px">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500;margin-bottom:4px">Forecast</div>
          <div style="font-size:18px;font-weight:600;color:${TEXT_M};letter-spacing:-0.01em;line-height:1">${ft(forecastSec)}</div>
        </div>
      </div>
    </div>
  `;

  return `
    <style>
      #rfc-view { box-sizing:border-box; }
      #rfc-view *, #rfc-view *::before, #rfc-view *::after { box-sizing:inherit; }
      @keyframes rfcFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .rfc-fade { opacity:0; animation:rfcFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('rfc')}
    </style>

    <div id="rfc-view" style="
      position:relative;min-height:100vh;background:${PAGE_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${buildSkyBackground('rfc', 'amber')}

      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="rfc-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div style="text-align:center">
            <div style="font-size:20px;font-weight:700;color:${TEXT_M}">${distLabel} forecast</div>
            <div style="font-size:12px;color:${TEXT_S};margin-top:3px;font-weight:500">Week ${currentWeek} of ${totalWeeks}</div>
          </div>

          <div style="width:36px"></div>
        </div>

        <!-- Hero ring -->
        <div class="rfc-fade" style="animation-delay:0.04s;display:flex;justify-content:center;margin:12px 0 28px">
          <div style="position:relative;width:220px;height:220px;display:flex;align-items:center;justify-content:center">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="rfcRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${ringA}"/>
                  <stop offset="100%" stop-color="${ringB}"/>
                </linearGradient>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="rgba(255,255,255,0.85)" stroke="rgba(241,245,249,0.5)" stroke-width="8"/>
              <circle id="rfc-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="url(#rfcRingGrad)"
                stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_CIRC}"
                stroke-dashoffset="${RING_CIRC}"
                style="transition:stroke-dashoffset 1.4s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
              />
            </svg>
            <div style="
              position:absolute;width:180px;height:180px;border-radius:50%;
              background:rgba(255,255,255,0.75);backdrop-filter:blur(12px);
              box-shadow:inset 0 0 12px rgba(255,255,255,0.5);
              display:flex;flex-direction:column;align-items:center;justify-content:center;
              top:50%;left:50%;transform:translate(-50%,-50%);padding-top:4px;
            ">
              <div style="font-size:40px;letter-spacing:-0.03em;line-height:1;font-weight:700;color:${TEXT_M}">${ft(forecastSec)}</div>
              <div style="color:${TEXT_S};font-size:12px;font-weight:500;margin-top:6px">Predicted finish</div>
              <div style="color:${deltaColor};font-size:13px;font-weight:600;margin-top:4px">${delta.text}<span style="color:${TEXT_S};font-weight:400"> vs target ${ft(goalSec)}</span></div>
            </div>
          </div>
        </div>

        ${statRow}

        ${chart ? `
        <!-- Chart card -->
        <div class="rfc-fade" style="animation-delay:0.16s;padding:0 16px;margin-bottom:14px">
          <div style="${CARD};padding:20px">
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
              <div style="font-size:12px;color:${TEXT_S};font-weight:500">Race-time progression</div>
              <div style="font-size:11px;color:${TEXT_L}">Lower is faster</div>
            </div>
            ${chart}
            <div style="display:flex;align-items:center;gap:14px;margin-top:14px;font-size:11px;color:${TEXT_S};flex-wrap:wrap">
              <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:18px;height:2px;background:${CHART_STROKE}"></span>Actual</span>
              <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:18px;height:2px;background:repeating-linear-gradient(to right,${CHART_STROKE} 0 4px,transparent 4px 7px);opacity:0.55"></span>Projection</span>
              <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:18px;height:2px;background:${GOAL_STROKE};opacity:0.7"></span>Goal</span>
            </div>
          </div>
        </div>` : ''}

        ${ctaCard}

        <!-- Disclaimer footnote -->
        <div class="rfc-fade" style="animation-delay:0.24s;padding:0 22px;margin-top:6px">
          <div style="font-size:11px;color:${TEXT_L};line-height:1.5">
            Race-day pacing is subject to course profile, weather, fueling, and how the build finishes. The forecast tracks fitness, not the day itself.
          </div>
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

// ── Event wiring ─────────────────────────────────────────────────────────────

function animateChartDrawOn(): void {
  requestAnimationFrame(() => {
    document.querySelectorAll<SVGPathElement>('path.rfc-draw-actual, path.rfc-draw-proj').forEach(path => {
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      path.getBoundingClientRect();
      path.style.transition = 'stroke-dashoffset 1.2s ease-out';
      path.style.strokeDashoffset = '0';
    });
  });
}

function wireRaceForecastHandlers(ringOffset: number): void {
  wireTabBarHandlers(navigateTab);

  setTimeout(() => {
    const circle = document.getElementById('rfc-ring-circle') as SVGCircleElement | null;
    if (circle) circle.style.strokeDashoffset = String(ringOffset.toFixed(2));
  }, 50);

  animateChartDrawOn();

  document.getElementById('rfc-back-btn')?.addEventListener('click', () => {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  document.getElementById('rfc-add-session')?.addEventListener('click', () => {
    const ms = getMutableState();
    ms.rw = Math.min((ms.rw ?? 0) + 1, 7);
    ms.epw = Math.min((ms.epw ?? 0) + 1, 10);
    saveState();
    import('@/calculations/blended-fitness').then(({ refreshBlendedFitness }) => {
      refreshBlendedFitness(ms);
      saveState();
      renderRaceForecastView();
    });
  });
}

// ── Public entry point ───────────────────────────────────────────────────────

export function renderRaceForecastView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();

  // Guard: only meaningful in race mode with a goal time set
  if (s.continuousMode || !s.rd || !s.initialBaseline) {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
    return;
  }

  container.innerHTML = getRaceForecastHTML(s);

  const totalWeeks = s.tw ?? (s.wks?.length ?? 16);
  const currentWeek = Math.max(1, Math.min(totalWeeks, s.w ?? 1));
  const progressPct = totalWeeks > 1 ? ((currentWeek - 1) / (totalWeeks - 1)) * 100 : 100;
  const ringOffset = +(RING_CIRC * (1 - Math.min(100, Math.max(0, progressPct)) / 100)).toFixed(2);

  wireRaceForecastHandlers(ringOffset);
}
