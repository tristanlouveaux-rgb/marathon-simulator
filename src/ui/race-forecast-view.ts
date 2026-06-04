/**
 * Race Forecast detail page. Race mode only.
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
import { predictStandardDistances, getStandardForecastDetail, getStandardForecastProjection } from '@/calculations/blended-fitness';
import { hasRunningFitnessSignal } from '@/calculations/physiological-vdot';
import { buildPredictedTimeTrendChart, buildForecastTrajectoryChart } from './triathlon/benchmark-charts';
import { formatKm, formatPace } from '@/utils/format';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from './page-flair';
import { renderMarathonPopulationCard } from './marathon-population-card';
import { renderForecastFingerprint } from './race-forecast-fingerprint';
import { renderRunConeCard, wireRunConeCard } from './race-forecast-cone-card';
import { wireForecastChips } from './forecast-chip-detail-view';

// ── Design tokens ─────────────────────────────────────────────────────────────

const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';

const CHART_STROKE = '#64748B';
const GOAL_STROKE  = '#C48A3A'; // warm amber. Distinct from the grey projection line
const CARD = `background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)`;
// Glassy card for the no-target-race (On-demand / continuous) forecast, so it reads
// like the other modes' forecast surfaces rather than flat white tiles. Canonical
// glass recipe (mirrors the track Plan's tp-week-row): white-translucent + blur +
// light inner border. White rgba (not black) so it passes the tinted-bg UI lint.
const GLASS_CARD = `background:rgba(255,255,255,0.72);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,0.6);border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04),0 8px 24px rgba(0,0,0,0.07)`;

const RACE_DIST_LABEL: Record<string, string> = {
  '5k': '5K',
  '10k': '10K',
  'half': 'Half marathon',
  'marathon': 'Marathon',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * "Last race" retro card. Renders above the hero when the most recent
 * RunRaceLogEntry shows the user finished at least 60s faster than the
 * blended prediction at race-detection time. Mirrors the tri pattern in
 * `triathlon/forecast-view.ts:42`.
 */
function buildRunRaceOutcomeRetroCard(s: SimulatorState): string {
  const log = s.runRaceLog;
  if (!log || log.length === 0) return '';
  const latest = log[log.length - 1];
  const gap = latest.predictedTotalSec - latest.actualTotalSec;
  if (gap < 60) return '';

  const gapMin = Math.floor(gap / 60);
  const gapTxt = gapMin === 1 ? '1 min' : `${gapMin} min`;

  return `
    <div class="rfc-fade" style="animation-delay:0.02s;padding:0 16px;margin-bottom:14px">
      <div style="background:#E8F2E5;border:1px solid #B8D6AE;border-radius:14px;padding:16px">
        <div style="font-size:11px;font-weight:600;color:#5a8050;margin-bottom:6px">Last race</div>
        <div style="font-size:15px;font-weight:600;color:#0F172A;margin-bottom:4px">You beat your prediction by ${gapTxt}</div>
        <div style="font-size:12px;color:#64748B;line-height:1.5">Predicted ${ft(latest.predictedTotalSec)}, actual ${ft(latest.actualTotalSec)}.</div>
      </div>
    </div>
  `;
}

function buildCourseFactorsPanel(
  factors: SimulatorState['forecastCourseFactors'],
  raceName: string | undefined,
  rawSec: number,
  adjustedSec: number,
): string {
  if (!factors || factors.length === 0) return '';
  const rows = factors.map(f => {
    const pct = (f.multiplier - 1) * 100;
    const sign = pct >= 0 ? '+' : '−';
    const tone = pct >= 0 ? '#9A6A20' : '#1F7A3D';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:13px;border-top:1px solid rgba(0,0,0,0.04)">
        <span style="color:${TEXT_S}">${f.label}</span>
        <span style="display:flex;gap:14px;align-items:center">
          <span style="color:${TEXT_M}">${f.value}</span>
          <span style="color:${tone};font-variant-numeric:tabular-nums;min-width:56px;text-align:right">${sign}${Math.abs(pct).toFixed(1)}%</span>
        </span>
      </div>
    `;
  }).join('');

  const compoundedMult = factors.reduce((acc, f) => acc * f.multiplier, 1);
  const totalPct = (compoundedMult - 1) * 100;
  const totalSign = totalPct >= 0 ? '+' : '−';
  const slowerOrFaster = totalPct >= 0 ? 'slower' : 'faster';

  return `
    <div class="rfc-fade" style="animation-delay:0.13s;padding:0 16px;margin-bottom:14px">
      <div style="${CARD};padding:18px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div style="font-size:12px;color:${TEXT_S};font-weight:500">Course factors${raceName ? ` · ${raceName}` : ''}</div>
          <div style="font-size:11px;color:${TEXT_L}">Lower is faster</div>
        </div>
        <div style="font-size:11px;color:${TEXT_L};line-height:1.5;margin-bottom:10px">
          Athletes tend to run ${totalSign}${Math.abs(totalPct).toFixed(1)}% ${slowerOrFaster} here than on a flat, cool, sea-level course. Climate, altitude, and elevation each contribute. Your finish-time impact scales with your pace.
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0 12px;font-size:12px">
          <span style="color:${TEXT_S}">Raw fitness pace</span>
          <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${ft(rawSec)}</span>
        </div>
        ${rows}
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 4px;font-size:13px;border-top:1px solid rgba(0,0,0,0.10);margin-top:4px">
          <span style="color:${TEXT_M};font-weight:600">Adjusted finish</span>
          <span style="display:flex;gap:14px;align-items:center">
            <span style="color:${TEXT_M};font-weight:600;font-variant-numeric:tabular-nums">${ft(adjustedSec)}</span>
            <span style="color:${TEXT_S};font-variant-numeric:tabular-nums;min-width:56px;text-align:right">${totalSign}${Math.abs(totalPct).toFixed(1)}%</span>
          </span>
        </div>
      </div>
    </div>
  `;
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
  // Combine for axis range. Started anchor + every actual + projection endpoint
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
  // anchor from the current value. That produces a misleading flat line when
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

  // Horizontal reference line at goal. Warm amber so it is visually distinct
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

  // Goal label (right of chart, in gutter). Amber tint matches the goal line
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
  const rawForecastSec = s.forecastTime ?? s.blendedRaceTimeSec ?? s.currentFitness ?? 0;
  // Adjusted time is the realistic prediction (climate / altitude / elevation
  // applied). Falls back to the raw VDOT forecast when no race profile.
  const forecastSec = s.forecastTimeAdjusted ?? rawForecastSec;
  const courseFactors = s.forecastCourseFactors ?? [];

  const totalWeeks = s.tw ?? (s.wks?.length ?? 16);
  const currentWeek = Math.max(1, Math.min(totalWeeks, s.w ?? 1));

  // Header chrome. Initials avatar + race-name subtitle. Mirrors tri/hyrox tabs.
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');
  const raceName = s.selectedMarathon?.name;
  const raceNameLine = raceName
    ? (s.onboarding?.name ? `${s.onboarding.name}'s ${raceName}` : raceName)
    : `Your ${distLabel}`;

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

  // Projection chart shows the FITNESS trajectory (raw VDOT-derived). Course
  // factors are a separate constant adjustment shown in the panel below. Mixing
  // them into the trajectory line would imply weather/elevation are training-
  // sensitive, which they are not.
  const projection: ChartPoint[] = [];
  if (rawForecastSec > 0 && currentWeek < totalWeeks) {
    projection.push({ week: totalWeeks, timeSec: rawForecastSec, kind: 'projection' });
  }

  const chart = buildForecastChart(nowSec, goalSec, history, projection, totalWeeks);
  // Course factors panel removed from the main forecast view — the Venue chip
  // in the fingerprint already drills into a dedicated page with the same
  // factor breakdown. Keeping it here was a duplicate surface.

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

  return `
    <style>
      #rfc-view { box-sizing:border-box; }
      #rfc-view *, #rfc-view *::before, #rfc-view *::after { box-sizing:inherit; }
      @keyframes rfcFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .rfc-fade { opacity:0; animation:rfcFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="rfc-view" style="
      position:relative;min-height:100vh;background:${atmosphereGradient('sky')};
      font-family:var(--f);overflow-x:hidden;
    ">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('rfc', { variant: 'sweep', palette: 'sky', pulse: true })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:48px">

        <!-- Header: tab-style (no back-button. Forecast is now a tab destination) -->
        <div style="padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px">
          <button id="rfc-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div style="text-align:center;padding:20px 20px 12px">
          <div style="font-size:32px;font-weight:700;color:${TEXT_M};letter-spacing:-0.02em;line-height:1">${distLabel} forecast</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">${raceNameLine}. Week ${currentWeek} of ${totalWeeks}</div>
        </div>

        ${buildRunRaceOutcomeRetroCard(s)}

        ${renderForecastFingerprint(s)}

        ${renderMarathonPopulationCard(s)}

        ${renderRunConeCard(s)}

        ${ctaCard}

        <!-- Disclaimer footnote -->
        <div class="rfc-fade" style="animation-delay:0.24s;padding:0 22px;margin-top:6px">
          <div style="font-size:11px;color:${TEXT_L};line-height:1.5">
            Race-day pacing is subject to course profile, weather, fueling, and how the build finishes. The forecast tracks fitness, not the day itself.
          </div>
        </div>

        <div class="rfc-fade" style="animation-delay:0.26s;padding:10px 22px 24px;text-align:center">
          <button id="rfc-methodology-btn" type="button" style="font:inherit;font-size:12px;color:var(--c-muted);background:none;border:none;cursor:pointer;padding:0">How this is calculated →</button>
        </div>

      </div>
    </div>
    ${renderTabBar('forecast')}
  `;
}

// ── Navigation ───────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
  else if (tab === 'forecast') { /* already here */ }
  else if (tab === 'account') import('./account-view').then(m => m.renderAccountView());
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

function wireRaceForecastHandlers(): void {
  wireTabBarHandlers(navigateTab);

  animateChartDrawOn();
  wireRunConeCard();
  wireForecastChips();

  document.getElementById('rfc-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  document.getElementById('rfc-methodology-btn')?.addEventListener('click', () => {
    import('./methodology-view').then(({ renderMethodologyRunning }) =>
      renderMethodologyRunning(() => renderRaceForecastView()));
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

  // No target race (just-training / general fitness, or pre-baseline): show
  // live standard-distance predictions instead of the targeted goal forecast.
  if (s.continuousMode || !s.rd || !s.initialBaseline) {
    container.innerHTML = getStandardForecastHTML(s);
    wireStandardForecastHandlers();
    return;
  }

  container.innerHTML = getRaceForecastHTML(s);
  wireRaceForecastHandlers();
}

// ── Standard-distance forecast (no target race) ──────────────────────────────

const STD_DISTANCES: { key: 'half' | 'marathon' | '5k' | '10k'; label: string; note: string }[] = [
  { key: '5k',       label: '5K',            note: 'speed' },
  { key: '10k',      label: '10K',           note: 'speed-endurance' },
  { key: 'half',     label: 'Half marathon', note: 'threshold' },
  { key: 'marathon', label: 'Marathon',      note: 'endurance' },
];

function buildStdDistanceTile(key: string, label: string, note: string, sec: number | null): string {
  const tappable = !!sec && sec > 0;
  const value = tappable
    ? `<div style="font-size:24px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em;font-variant-numeric:tabular-nums">${ft(sec)}</div>`
    : `<div style="font-size:18px;font-weight:600;color:${TEXT_L}">—</div>`;
  // Tappable tiles render as buttons (drill into the per-distance detail page);
  // empty tiles stay inert divs.
  const tag = tappable ? 'button' : 'div';
  const attrs = tappable
    ? `class="std-tile" data-dist="${key}" type="button" style="${GLASS_CARD};position:relative;padding:16px 14px;text-align:center;cursor:pointer;font:inherit;font-family:var(--f);-webkit-tap-highlight-color:transparent"`
    : `style="${GLASS_CARD};padding:16px 14px;text-align:center;opacity:0.7"`;
  // Drill-in affordance: a corner chevron on tappable tiles so it's obvious each one
  // opens its own detail page (trend + the factors behind the prediction).
  const chevron = tappable
    ? `<span style="position:absolute;top:10px;right:11px;color:${TEXT_L};font-size:13px;line-height:1">&rsaquo;</span>`
    : '';
  return `
    <${tag} ${attrs}>
      ${chevron}
      <div style="font-size:12px;color:${TEXT_S};font-weight:600;margin-bottom:8px">${label}</div>
      ${value}
      <div style="font-size:11px;color:${TEXT_L};margin-top:6px">${note}</div>
    </${tag}>`;
}

function buildStdGrid(s: SimulatorState): string {
  const preds = predictStandardDistances(s);
  const tiles = STD_DISTANCES.map(d => buildStdDistanceTile(d.key, d.label, d.note, preds[d.key])).join('');
  return `
    <div id="std-forecast-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      ${tiles}
    </div>`;
}

// Segmented shoes toggle. Mirrors buildShoesToggleCardHTML in
// forecast-chip-detail-view.ts, but drives the standard-distance grid (no
// targeted s.forecastTime to read).
function buildStdShoesCard(s: SimulatorState): string {
  const isCarbon = (s.shoeKind ?? 'standard') === 'supershoes';
  const tone = isCarbon ? '#16A34A' : TEXT_S;
  const headline = isCarbon ? '+3% pace' : 'No boost';
  const segTrack = 'background:rgba(15,23,42,0.05);border-radius:100px;padding:4px;box-shadow:inset 0 1px 2px rgba(15,23,42,0.10),inset 0 0 0 1px rgba(15,23,42,0.04)';
  const segActive = `background:#fff;color:${TEXT_M};box-shadow:0 1px 2px rgba(15,23,42,0.08),0 4px 10px rgba(15,23,42,0.10),inset 0 0 0 1px rgba(15,23,42,0.04)`;
  const segInactive = `background:transparent;color:${TEXT_S};box-shadow:none`;
  const segBtn = (id: string, label: string, active: boolean) => `
    <button id="${id}" type="button" style="
      flex:1;padding:10px 14px;border-radius:100px;border:none;font:inherit;font-size:13px;
      font-weight:600;cursor:pointer;font-family:var(--f);-webkit-tap-highlight-color:transparent;
      transition:background 0.18s cubic-bezier(0.2,0.8,0.2,1),color 0.18s cubic-bezier(0.2,0.8,0.2,1),box-shadow 0.18s cubic-bezier(0.2,0.8,0.2,1);
      ${active ? segActive : segInactive}
    ">${label}</button>`;
  return `
    <div id="std-shoes-card" style="${GLASS_CARD};padding:18px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
        <span style="font-size:14px;color:${TEXT_M};font-weight:600">Racing shoes</span>
        <span style="font-size:18px;font-weight:600;color:${tone};font-variant-numeric:tabular-nums">${headline}</span>
      </div>
      <div style="font-size:12px;color:${TEXT_S};line-height:1.5;margin-bottom:14px">Carbon-plated racing flats add about 3% pace. Toggle to see every distance update live.</div>
      <div style="display:flex;gap:0;${segTrack}">
        ${segBtn('std-shoes-standard',   'Standard',   !isCarbon)}
        ${segBtn('std-shoes-supershoes', 'Supershoes',  isCarbon)}
      </div>
    </div>`;
}

function getStandardForecastHTML(s: SimulatorState): string {
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  const preds = predictStandardDistances(s);
  // Canonical gate: identical to the Stats "VO2 Max" bar's show/hide predicate,
  // so a thin-data athlete sees both surfaces populate or both show their empty
  // state. `predictStandardDistances` always yields times when this is true
  // (it falls back to the resolved VDOT), so the two stay in lock-step.
  const hasAny = hasRunningFitnessSignal(s);

  const body = hasAny
    ? `
      ${buildStdShoesCard(s)}
      ${buildStdGrid(s)}
      <div style="font-size:11px;color:${TEXT_L};line-height:1.5;margin-top:14px;padding:0 4px">
        Tap a distance for its trend and the factors behind it. Predictions come from your current fitness, not a target race, and move as your training does.
      </div>`
    : `
      <div style="${GLASS_CARD};padding:22px;text-align:center">
        <div style="font-size:15px;font-weight:600;color:${TEXT_M};margin-bottom:6px">No predictions yet</div>
        <div style="font-size:13px;color:${TEXT_S};line-height:1.5;margin-bottom:16px">Sync or import a few runs and your 5K to marathon times appear here.</div>
        <button id="std-import-runs" style="
          padding:11px 18px;border-radius:100px;border:1px solid var(--c-border);
          background:transparent;color:${TEXT_M};font-family:var(--f);font-size:13px;font-weight:600;
          cursor:pointer;-webkit-tap-highlight-color:transparent;
        ">Import run history</button>
      </div>`;

  return `
    <style>
      #std-view { box-sizing:border-box; }
      #std-view *, #std-view *::before, #std-view *::after { box-sizing:inherit; }
      @keyframes stdFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .std-fade { opacity:0; animation:stdFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="std-view" style="
      position:relative;min-height:100vh;background:${atmosphereGradient('sky')};
      font-family:var(--f);overflow-x:hidden;
    ">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('std', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div class="std-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:flex-end;gap:8px">
          <button id="std-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div class="std-fade" style="animation-delay:0.06s;padding:14px 20px 18px">
          <div style="font-size:11px;color:${TEXT_S};font-weight:500">Forecast</div>
          <div style="font-size:30px;font-weight:600;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.1;margin-top:6px">Race predictions</div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">What you could run today at each distance</div>
        </div>

        <div class="std-fade" style="animation-delay:0.12s;padding:0 16px">
          ${body}
        </div>

      </div>

      ${renderTabBar('forecast')}
    </div>`;
}

function wireStandardForecastHandlers(): void {
  document.getElementById('std-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });

  document.getElementById('std-import-runs')?.addEventListener('click', () => {
    import('./import-activity-modal').then(({ openImportActivityModal }) => {
      openImportActivityModal({ onComplete: () => renderRaceForecastView() });
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.std-tile').forEach(btn => {
    btn.addEventListener('click', () => {
      const dist = btn.dataset.dist as 'half' | 'marathon' | '5k' | '10k' | undefined;
      if (dist) renderStdDistanceDetail(dist);
    });
  });

  // Shoes toggle: write shoeKind, then swap the toggle card + grid in place so
  // every distance updates live without a full-page reload. predictStandardDistances
  // reads the 3% boost straight from s.shoeKind, so no blend refresh is needed.
  const setShoeKind = (kind: 'standard' | 'supershoes') => {
    const ms = getMutableState();
    if ((ms.shoeKind ?? 'standard') === kind) return;
    ms.shoeKind = kind;
    saveState();
    const s = getState();
    const card = document.getElementById('std-shoes-card');
    if (card) card.outerHTML = buildStdShoesCard(s);
    const grid = document.getElementById('std-forecast-grid');
    if (grid) grid.outerHTML = buildStdGrid(s);
    wireShoeButtons();
  };
  const wireShoeButtons = () => {
    document.getElementById('std-shoes-standard')?.addEventListener('click', () => setShoeKind('standard'));
    document.getElementById('std-shoes-supershoes')?.addEventListener('click', () => setShoeKind('supershoes'));
  };
  wireShoeButtons();

  wireTabBarHandlers(navigateStdTab);
}

function navigateStdTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./main-view').then(m => m.renderMainView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
  else if (tab === 'forecast') renderRaceForecastView();
  else if (tab === 'account') import('./account-view').then(m => m.renderAccountView());
}

// ── Per-distance detail (drill-down from a grid tile) ────────────────────────

function stdStatRow(label: string, value: string, hint?: string): string {
  return `
    <div style="padding:9px 0;border-top:1px solid rgba(0,0,0,0.04)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px">
        <span style="color:${TEXT_S}">${label}</span>
        <span style="color:${TEXT_M};font-variant-numeric:tabular-nums">${value}</span>
      </div>
      ${hint ? `<div style="font-size:11px;color:${TEXT_S};line-height:1.45;margin-top:4px;max-width:88%">${hint}</div>` : ''}
    </div>`;
}

/** Round seconds to a clean "N min" for the durability threshold hint. */
function fmtMinThreshold(sec: number): string {
  return `${Math.round(sec / 60)} min`;
}

// Selected projection horizon for the no-race forecast drill-down. Module-level
// so it survives the in-place re-render but resets between visits (ephemeral UI
// pref, not worth a state field). Default 8 weeks (mid of 4/8/12).
const STD_PROJ_HORIZONS = [4, 8, 12] as const;
let stdProjWeeks: number = 8;

/** Segmented 4 / 8 / 12-week horizon selector. Mirrors the shoes toggle track. */
function buildStdHorizonSelector(selected: number): string {
  const segTrack = 'background:rgba(15,23,42,0.05);border-radius:100px;padding:4px;box-shadow:inset 0 1px 2px rgba(15,23,42,0.10),inset 0 0 0 1px rgba(15,23,42,0.04)';
  const segActive = `background:#fff;color:${TEXT_M};box-shadow:0 1px 2px rgba(15,23,42,0.08),0 4px 10px rgba(15,23,42,0.10),inset 0 0 0 1px rgba(15,23,42,0.04)`;
  const segInactive = `background:transparent;color:${TEXT_S};box-shadow:none`;
  const btn = (w: number) => `
    <button id="stdd-horizon-${w}" type="button" style="
      flex:1;padding:8px 12px;border-radius:100px;border:none;font:inherit;font-size:12px;
      font-weight:600;cursor:pointer;font-family:var(--f);-webkit-tap-highlight-color:transparent;
      transition:background 0.18s cubic-bezier(0.2,0.8,0.2,1),color 0.18s cubic-bezier(0.2,0.8,0.2,1),box-shadow 0.18s cubic-bezier(0.2,0.8,0.2,1);
      ${w === selected ? segActive : segInactive}
    ">${w} wk</button>`;
  return `<div style="display:flex;gap:0;${segTrack};margin-top:12px">${STD_PROJ_HORIZONS.map(btn).join('')}</div>`;
}

function fmtBias(sec: number): string {
  const sign = sec >= 0 ? '+' : '−';
  const abs = Math.abs(sec);
  return abs >= 60 ? `${sign}${Math.floor(abs / 60)}:${String(Math.round(abs % 60)).padStart(2, '0')}` : `${sign}${Math.round(abs)}s`;
}

/** One row of the prediction waterfall: a step label (with its signed delta)
 *  on the left, the running cumulative time on the right. Slower = red,
 *  faster = green; the base/total rows pass `deltaSec = null`. */
function stdWaterfallRow(label: string, cumStr: string, deltaSec: number | null, opts?: { total?: boolean; hint?: string }): string {
  const isTotal = opts?.total === true;
  const deltaHtml = deltaSec == null || Math.abs(deltaSec) < 1
    ? ''
    : `<span style="font-size:11px;font-variant-numeric:tabular-nums;margin-left:8px;color:${deltaSec > 0 ? '#FF3B30' : '#16A34A'}">${fmtBias(deltaSec)}</span>`;
  return `
    <div style="padding:9px 0;border-top:${isTotal ? '1px solid rgba(0,0,0,0.10)' : '1px solid rgba(0,0,0,0.04)'}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:13px">
        <span style="color:${isTotal ? TEXT_M : TEXT_S};font-weight:${isTotal ? '600' : '400'}">${label}${deltaHtml}</span>
        <span style="color:${TEXT_M};font-weight:${isTotal ? '700' : '400'};font-variant-numeric:tabular-nums">${cumStr}</span>
      </div>
      ${opts?.hint ? `<div style="font-size:11px;color:${TEXT_S};line-height:1.45;margin-top:4px;max-width:88%">${opts.hint}</div>` : ''}
    </div>`;
}

type StdDist = 'half' | 'marathon' | '5k' | '10k';

/**
 * The dynamic body of the detail page (hero + cards). Extracted so the shoes
 * toggle and horizon selector can rebuild just this region in place — preserving
 * scroll and letting the chart's own line/dot animations replay — instead of
 * re-rendering the whole page (which scrolled to top and flashed). `animate`
 * adds the entrance float-up on first paint only; refreshes pass false so the
 * cards appear instantly while the chart still animates.
 */
function buildStdDetailInner(s: SimulatorState, dist: StdDist, animate: boolean): string {
  const unit = s.unitPref ?? 'km';
  const label = RACE_DIST_LABEL[dist] ?? 'Race';
  const detail = getStandardForecastDetail(s, dist);
  const fade = (delay: string) => animate ? `class="stdd-fade" style="animation-delay:${delay};` : `style="`;

  const heroTime = detail.predictedSec && detail.predictedSec > 0 ? ft(detail.predictedSec) : '—';
  // Target pace = even pace for the predicted finish. Well-defined at every
  // distance (unlike a split-by-split race plan), and the single most actionable
  // readout — so it sits with the headline, not in the inputs card.
  const paceSecPerKm = detail.predictedSec && detail.predictedSec > 0
    ? detail.predictedSec / rdKm(dist)
    : null;
  const heroPace = paceSecPerKm ? formatPace(paceSecPerKm, unit) : null;

  // Trend: raw VDOT-derived predicted time over time. Lower time = better, so
  // invert the chart (improvement reads as up). Mirrors the targeted forecast's
  // "fitness trajectory" line vs adjusted headline split. Gate the chart behind
  // ≥3 points spanning ≥7 days — two points a day apart is not a trend, it just
  // draws a flat line that reads as filler.
  const trendDatesMs = detail.trend.map(p => Date.parse(p.date)).filter(t => !isNaN(t)).sort((a, b) => a - b);
  const trendSpanDays = trendDatesMs.length >= 2
    ? (trendDatesMs[trendDatesMs.length - 1] - trendDatesMs[0]) / (24 * 3600 * 1000)
    : 0;
  const trendReady = detail.trend.length >= 3 && trendSpanDays >= 7;

  // Forward projection: "what you could run if you hold the plan" for the
  // selected horizon, rendered as a dashed continuation of the trajectory. Null
  // for users with no plan to project along (just-track, no sessions) — then we
  // fall back to the historical-only trend behaviour.
  const projection = getStandardForecastProjection(s, dist, stdProjWeeks);
  let trendCard: string;
  if (projection) {
    trendCard = `
    <div style="${GLASS_CARD};padding:18px;margin-bottom:14px">
      ${buildForecastTrajectoryChart(projection, { nowSec: detail.predictedSec ?? 0, label })}
      ${buildStdHorizonSelector(stdProjWeeks)}
    </div>`;
  } else if (trendReady) {
    trendCard = `
    <div style="${GLASS_CARD};padding:18px;margin-bottom:14px">
      <div style="font-size:13px;color:${TEXT_S};font-weight:500;margin-bottom:10px">Predicted ${label} time over time</div>
      ${buildPredictedTimeTrendChart(detail.trend)}
    </div>`;
  } else {
    trendCard = `
    <div style="${GLASS_CARD};padding:18px;margin-bottom:14px">
      <div style="font-size:13px;color:${TEXT_M};font-weight:600;margin-bottom:6px">Predicted ${label} time over time</div>
      <div style="font-size:13px;color:${TEXT_S};line-height:1.5">A trend needs a few weeks of recorded fitness. It appears here once there are at least three data points across a week or more.</div>
    </div>`;
  }

  // Durability factor name + hint (shared by the waterfall row). For short
  // races the deficit is aerobic economy, not a missing "long run", so the
  // factor is named honestly per distance. The hint distinguishes the
  // no-history case (longest run = 0, penalty maxes) from a measured short run.
  const isShortRace = dist === '5k' || dist === '10k';
  const durFactorName = isShortRace ? 'aerobic durability' : 'long-run shortfall';
  const durThreshStr = fmtMinThreshold(detail.durabilityThresholdSec);
  const durabilityHint = detail.durabilityCapped
    ? (detail.durabilityLongestRunSec <= 0
        ? `No recent runs of ${durThreshStr}+ on record, so the endurance base for ${label} is unproven. Log a longer run to clear this.`
        : (isShortRace
            ? `Longest recent run is under ${durThreshStr}, the easy-run duration that signals ${label}-ready economy.`
            : `Longest recent run is under ${durThreshStr}, below the long-run base that supports a ${label}.`))
    : undefined;

  // Waterfall: capacity blend → race calibration → durability → supershoes,
  // each row showing the running cumulative time and the delta it applied. The
  // final row reconciles to the hero because both read `detail.stages.finalSec`
  // (same computation as the grid tile). Steps that move the time < 1s are
  // hidden. Only renders when the blend produced an estimate.
  const stages = detail.stages;
  const waterfallCard = stages ? (() => {
    const rows: string[] = [];
    rows.push(stdWaterfallRow('Capacity', ft(stages.blendedSec), null));
    const calDelta = stages.calibratedSec - stages.blendedSec;
    if (Math.abs(calDelta) >= 1) {
      rows.push(stdWaterfallRow(`Race calibration`, ft(stages.calibratedSec), calDelta));
    }
    const afterDur = stages.calibratedSec * stages.durability.multiplier;
    const durDelta = afterDur - stages.calibratedSec;
    if (Math.abs(durDelta) >= 1) {
      rows.push(stdWaterfallRow(`Durability · ${durFactorName}`, ft(afterDur), durDelta, { hint: durabilityHint }));
    }
    const shoeDelta = stages.finalSec - afterDur;
    if (Math.abs(shoeDelta) >= 1) {
      rows.push(stdWaterfallRow('Supershoes', ft(stages.finalSec), shoeDelta));
    }
    rows.push(stdWaterfallRow('Predicted finish', ft(stages.finalSec), null, { total: true }));
    const onlyBase = rows.length === 2; // capacity + total, nothing in between
    return `
    <div style="${GLASS_CARD};padding:18px;margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_M};font-weight:600;margin-bottom:4px">How we reach ${heroTime}</div>
      ${onlyBase ? `<div style="font-size:11px;color:${TEXT_S};line-height:1.45;margin-bottom:2px">No adjustments apply right now, so the prediction equals your capacity blend.</div>` : ''}
      ${rows.join('')}
    </div>`;
  })() : '';

  const calibrationVal = detail.calibrationBiasSec != null
    ? `${fmtBias(detail.calibrationBiasSec)} from ${detail.calibrationRaceCount} race${detail.calibrationRaceCount === 1 ? '' : 's'}`
    : 'No race data yet';

  // Feeds card: the raw capacity signals behind the blend (the "Capacity" row
  // of the waterfall). Adjustments (durability, calibration delta) live in the
  // waterfall; only the calibration *status* sits here.
  const factorsCard = `
    <div style="${GLASS_CARD};padding:18px;margin-bottom:14px">
      <div style="font-size:14px;color:${TEXT_M};font-weight:600;margin-bottom:4px">What feeds your capacity</div>
      ${detail.vdot != null ? stdStatRow('Aerobic capacity', `VDOT ${detail.vdot.toFixed(1)}`) : ''}
      ${detail.ltSecPerKm != null ? stdStatRow('Lactate threshold pace', formatPace(detail.ltSecPerKm, unit)) : ''}
      ${detail.weeklyKm != null ? stdStatRow('Training volume', `${formatKm(detail.weeklyKm, unit)}/wk`) : ''}
      ${stdStatRow('Race calibration', calibrationVal)}
    </div>`;

  return `
    <div ${fade('0.06s')}text-align:center;padding:20px 20px 16px">
      <div style="font-size:11px;color:${TEXT_S};font-weight:500">Predicted finish</div>
      <div style="font-size:40px;font-weight:700;color:${TEXT_M};letter-spacing:-0.02em;line-height:1.05;margin-top:6px;font-variant-numeric:tabular-nums">${heroTime}</div>
      ${heroPace ? `<div style="font-size:16px;color:${TEXT_S};margin-top:6px;font-weight:600;font-variant-numeric:tabular-nums">${heroPace}</div>` : ''}
      <div style="font-size:13px;color:${TEXT_S};margin-top:6px;font-weight:500">${label} · from your current fitness</div>
    </div>

    <div ${fade('0.12s')}padding:0 16px">
      ${waterfallCard}
      ${factorsCard}
      ${buildStdShoesCard(s)}
      ${trendCard}
    </div>`;
}

/** Re-attach the shoe-toggle + horizon-selector listeners after a content
 *  rebuild. Both mutate state/module-horizon then refresh the content region
 *  in place (scroll preserved), so the chart re-animates without a page flash. */
function wireStdDetailContent(dist: StdDist): void {
  const refresh = () => {
    const el = document.getElementById('stdd-content');
    if (!el) return;
    const y = window.scrollY;
    el.innerHTML = buildStdDetailInner(getState(), dist, /*animate*/ false);
    wireStdDetailContent(dist);
    window.scrollTo(0, y);
    // The projection chart re-runs its CSS clip-path wipe on insert — no JS draw.
  };

  const setShoeKindDetail = (kind: 'standard' | 'supershoes') => {
    const ms = getMutableState();
    if ((ms.shoeKind ?? 'standard') === kind) return;
    ms.shoeKind = kind;
    saveState();
    refresh();
  };
  document.getElementById('std-shoes-standard')?.addEventListener('click', () => setShoeKindDetail('standard'));
  document.getElementById('std-shoes-supershoes')?.addEventListener('click', () => setShoeKindDetail('supershoes'));

  for (const w of STD_PROJ_HORIZONS) {
    document.getElementById(`stdd-horizon-${w}`)?.addEventListener('click', () => {
      if (stdProjWeeks === w) return;
      stdProjWeeks = w;
      refresh();
    });
  }
}

export function renderStdDistanceDetail(dist: StdDist): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');

  container.innerHTML = `
    <style>
      #stdd-view { box-sizing:border-box; }
      #stdd-view *, #stdd-view *::before, #stdd-view *::after { box-sizing:inherit; }
      @keyframes stddFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .stdd-fade { opacity:0; animation:stddFloatUp 0.55s cubic-bezier(0.2,0.8,0.2,1) forwards; }
    </style>

    <div id="stdd-view" style="
      position:relative;min-height:100dvh;background:${atmosphereGradient('sky')};
      font-family:var(--f);overflow-x:hidden;
    ">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('stdd', { variant: 'whisper', palette: 'sky' })}
      </div>
      ${buildSunGlint('low')}

      <div style="position:relative;z-index:10;max-width:600px;margin:0 auto;padding-bottom:100px">

        <div class="stdd-fade" style="animation-delay:0.02s;padding:56px 20px 0;display:flex;align-items:center;justify-content:space-between">
          <button id="stdd-back-btn" style="background:transparent;border:none;font-size:14px;color:${TEXT_S};cursor:pointer;padding:0;font-family:var(--f)">← Back</button>
          <button id="stdd-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>

        <div id="stdd-content">${buildStdDetailInner(s, dist, /*animate*/ true)}</div>

      </div>

      ${renderTabBar('forecast')}
    </div>`;

  document.getElementById('stdd-back-btn')?.addEventListener('click', () => renderRaceForecastView());
  document.getElementById('stdd-account-btn')?.addEventListener('click', () => {
    import('./account-view').then(({ renderAccountView }) => renderAccountView());
  });
  wireStdDetailContent(dist);
  wireTabBarHandlers(navigateStdTab);
}
