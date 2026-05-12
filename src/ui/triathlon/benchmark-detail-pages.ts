/**
 * Triathlon benchmark detail pages — drill-down surfaces for the four bars
 * on the Stats "Your Numbers" card. Mirrors the running LT detail page
 * (`buildLTMetricPage` in `ui/stats-view.ts`) for consistency:
 *
 *   - sub-header with back button
 *   - headline value + confidence chip + provenance one-liner
 *   - sparkline (rendered only when ≥ 2 history points)
 *   - override card with sliders + Save / Reset
 *   - footer plain-language explainer
 *
 * Override semantics by benchmark:
 *
 *   CSS / FTP — saved value flips `cssSource` / `ftpSource` to `'user'` and
 *   confidence to `'high'`, then appends to the per-discipline history. The
 *   existing main.ts launch refresh recognises `'user'` and preserves it,
 *   refreshing only when a derived estimate clearly improves on it.
 *   Reset flips the source back to `'derived'`; the value refreshes from
 *   training data on the next launch (see CHANGELOG 2026-05-07 for the
 *   reasoning — avoids a synchronous activity DB call at click time).
 *
 *   VO2max — sets a top-priority `s.vo2Override`. The display hierarchy in
 *   `vo2max-card.ts:resolveDisplayHeadline` is:
 *      override > toggle (mosaic | device) > computed
 *   The Mosaic / Watch toggle disables and shows a third "Manual" pill while
 *   the override is active. Reset deletes the override and restores the
 *   user's previously-selected source.
 *
 * Tap-through is wired in `triathlon/stats-view.ts → wireTriMetricDetailButtons`.
 */

import type { SimulatorState } from '@/types';
import { getMutableState, getState, saveState } from '@/state';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { buildMetricSubHeader, buildConfidenceChip } from '../stats-view';
import { appendCssSample, appendFtpSample } from '@/calculations/tri-benchmark-history';
import { buildBenchmarkTrendChart, buildCssTrendChart, animateChartDrawOn } from './benchmark-charts';
import { computeVO2Estimates } from '@/calculations/vo2-orchestrator';
import { getVo2Conflict, buildVo2ConflictBanner } from '@/calculations/vo2-sources';

// ────────────────────────────────────────────────────────────────────────────
// Formatters
// ────────────────────────────────────────────────────────────────────────────

function fmtCss(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${String(s).padStart(2, '0')}/100m`;
}

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('../home-view').then(({ renderHomeView }) => renderHomeView());
  else if (tab === 'plan') import('../main-view').then(({ renderMainView }) => renderMainView());
  else if (tab === 'forecast') import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  else if (tab === 'account') import('../account-view').then(({ renderAccountView }) => renderAccountView());
  else if (tab === 'stats') import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
}

// ────────────────────────────────────────────────────────────────────────────
// Shared shell — keeps the four pages structurally identical.
// ────────────────────────────────────────────────────────────────────────────

function buildShell(opts: {
  title: string;
  headline: string;
  subline?: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  provenance: string;
  sparkline: string;
  overrideCard: string;
  footer: string;
}): string {
  return `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildMetricSubHeader(opts.title)}
      <div style="max-width:600px;margin:0 auto;padding:18px;overflow-y:auto">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-wrap:wrap">
          <span style="font-size:28px;font-weight:300;color:var(--c-black)">${opts.headline}</span>
          ${opts.subline ? `<span style="font-size:14px;color:var(--c-muted)">· ${opts.subline}</span>` : ''}
          ${opts.confidence ? buildConfidenceChip(opts.confidence) : ''}
        </div>
        <div style="font-size:12px;color:var(--c-faint);margin-bottom:20px">${opts.provenance}</div>
        ${opts.sparkline}
        ${opts.overrideCard}
        <div style="font-size:11px;color:var(--c-faint);line-height:1.5;margin-top:14px">${opts.footer}</div>
      </div>
    </div>
    ${renderTabBar('stats')}`;
}

// ────────────────────────────────────────────────────────────────────────────
// CSS (Swim) detail page
// ────────────────────────────────────────────────────────────────────────────

export function buildCSSDetailPage(s: SimulatorState): string {
  const swim = s.triConfig?.swim;
  const css = swim?.cssSecPer100m ?? null;
  const conf = swim?.cssConfidence ?? null;
  const isUser = swim?.cssSource === 'user';
  const history = swim?.cssHistory ?? [];

  const headline = css != null ? fmtCss(css) : '—';
  const provenance = css == null
    ? 'No CSS yet — set one below or do a 400m + 200m TT.'
    : isUser
      ? 'Manually set by you'
      : `Auto-derived from your swim history${swim?.pbs?.m400 && swim?.pbs?.m200 ? ' + 400m/200m PBs' : ''}`;

  const sparkline = history.length >= 2
    ? `<div class="m-card" style="padding:14px;margin-bottom:8px">
         <div style="font-size:13px;color:var(--c-black);margin-bottom:10px">Trend</div>
         ${buildCssTrendChart(history)}
       </div>`
    : '';

  const overrideCard = buildCSSOverrideCard(css, isUser);
  const footer = 'CSS (Critical Swim Speed) is the fastest pace you can hold for ~30 minutes. It anchors swim training paces and feeds race-time predictions. Override below if you trust a recent test or race time more.';

  return buildShell({
    title: 'Swim CSS',
    headline,
    confidence: confidenceForChip(conf),
    provenance,
    sparkline,
    overrideCard,
    footer,
  });
}

function buildCSSOverrideCard(currentCss: number | null, isUser: boolean): string {
  // Slider range: ±20 sec/100m around current, clamped to a sensible band
  // (1:00/100m elite floor → 3:00/100m beginner ceiling).
  const seed = currentCss && currentCss > 0 ? Math.round(currentCss) : 110;
  const min = Math.max(60, seed - 20);
  const max = Math.min(180, seed + 20);
  return `
    <div class="m-card" style="padding:16px;margin-bottom:8px">
      <div style="font-size:13px;color:var(--c-black);margin-bottom:6px">Override</div>
      <div style="font-size:11px;color:var(--c-muted);line-height:1.5;margin-bottom:12px">Saved overrides flow through to swim paces and race-time predictions immediately. Auto-clears when your training data clearly beats it.</div>
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:11px;color:var(--c-muted)">CSS pace</span>
          <span id="css-override-label" style="font-size:14px;font-weight:600;color:var(--c-black)">${fmtCss(seed)}</span>
        </div>
        <input type="range" id="css-override-slider" class="m-slider-glass" min="${min}" max="${max}" step="1" value="${seed}">
        <div style="display:flex;justify-content:space-between;margin-top:2px">
          <span style="font-size:10px;color:var(--c-faint)">${fmtCss(min)}</span>
          <span style="font-size:10px;color:var(--c-faint)">${fmtCss(max)}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button id="css-override-save" style="flex:1;padding:10px;border:1px solid var(--c-border);background:transparent;border-radius:6px;cursor:pointer;font-family:var(--f);font-size:13px;color:var(--c-black)">Save override</button>
        ${isUser ? `<button id="css-override-reset" style="flex:1;padding:10px;border:1px solid var(--c-border);background:transparent;border-radius:6px;cursor:pointer;font-family:var(--f);font-size:13px;color:var(--c-muted)">Reset to derived</button>` : ''}
      </div>
    </div>`;
}

export function wireCSSDetailHandlers(rerender: () => void): void {
  const slider = document.getElementById('css-override-slider') as HTMLInputElement | null;
  const label = document.getElementById('css-override-label');
  if (slider && label) {
    slider.addEventListener('input', () => {
      label.textContent = fmtCss(parseInt(slider.value, 10));
    });
  }
  document.getElementById('css-override-save')?.addEventListener('click', () => {
    if (!slider) return;
    const value = parseInt(slider.value, 10);
    const m = getMutableState();
    if (!m.triConfig) return;
    m.triConfig.swim = {
      ...(m.triConfig.swim ?? {}),
      cssSecPer100m: value,
      cssSource: 'user',
      cssConfidence: 'high',
    };
    appendCssSample(m.triConfig.swim, value, 'user', 'high');
    if (m.triConfig.prediction) m.triConfig.prediction = undefined;
    saveState();
    rerender();
  });
  document.getElementById('css-override-reset')?.addEventListener('click', () => {
    const m = getMutableState();
    if (!m.triConfig?.swim) return;
    m.triConfig.swim = { ...m.triConfig.swim, cssSource: 'derived' };
    if (m.triConfig.prediction) m.triConfig.prediction = undefined;
    saveState();
    rerender();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// FTP (Bike) detail page
// ────────────────────────────────────────────────────────────────────────────

export function buildFTPDetailPage(s: SimulatorState): string {
  const bike = s.triConfig?.bike;
  const ftp = bike?.ftp ?? null;
  const conf = bike?.ftpConfidence ?? null;
  const isUser = bike?.ftpSource === 'user';
  const history = bike?.ftpHistory ?? [];

  const headline = ftp != null ? `${Math.round(ftp)} W` : '—';
  const wkg = ftp != null && s.bodyWeightKg ? (ftp / s.bodyWeightKg).toFixed(2) : null;
  const subline = wkg != null ? `${wkg} W/kg` : null;
  const provenance = ftp == null
    ? 'No FTP yet — set one below or do a 20-min FTP test.'
    : isUser
      ? (bike?.twentyMinW ? `Test result: 95% of your ${Math.round(bike.twentyMinW)}W 20-min effort` : 'Manually set by you')
      : `Auto-derived from your power data (${conf ?? 'medium'} confidence)`;

  const sparkline = history.length >= 2
    ? `<div class="m-card" style="padding:14px;margin-bottom:8px">
         <div style="font-size:13px;color:var(--c-black);margin-bottom:10px">Trend</div>
         ${buildBenchmarkTrendChart(history, '#8B5CF6', 'rgba(139,92,246,0.08)', 'W', false)}
       </div>`
    : '';

  const overrideCard = buildFTPOverrideCard(ftp, isUser);
  const footer = 'FTP (Functional Threshold Power) is the highest power you can hold for ~60 minutes. It anchors bike training zones and feeds race-time predictions. Override below if you trust a recent test or lab result more.';

  return buildShell({
    title: 'Bike FTP',
    headline,
    subline,
    confidence: confidenceForChip(conf),
    provenance,
    sparkline,
    overrideCard,
    footer,
  });
}

function buildFTPOverrideCard(currentFtp: number | null, isUser: boolean): string {
  // Slider range: ±60W around current, clamped to 80W floor / 500W ceiling.
  const seed = currentFtp && currentFtp > 0 ? Math.round(currentFtp) : 200;
  const min = Math.max(80, seed - 60);
  const max = Math.min(500, seed + 60);
  return `
    <div class="m-card" style="padding:16px;margin-bottom:8px">
      <div style="font-size:13px;color:var(--c-black);margin-bottom:6px">Override</div>
      <div style="font-size:11px;color:var(--c-muted);line-height:1.5;margin-bottom:12px">Saved overrides flow through to bike zones and race-time predictions immediately. Auto-clears when your training data clearly beats it.</div>
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:11px;color:var(--c-muted)">FTP</span>
          <span id="ftp-override-label" style="font-size:14px;font-weight:600;color:var(--c-black)">${seed} W</span>
        </div>
        <input type="range" id="ftp-override-slider" class="m-slider-glass" min="${min}" max="${max}" step="1" value="${seed}">
        <div style="display:flex;justify-content:space-between;margin-top:2px">
          <span style="font-size:10px;color:var(--c-faint)">${min} W</span>
          <span style="font-size:10px;color:var(--c-faint)">${max} W</span>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button id="ftp-override-save" style="flex:1;padding:10px;border:1px solid var(--c-border);background:transparent;border-radius:6px;cursor:pointer;font-family:var(--f);font-size:13px;color:var(--c-black)">Save override</button>
        ${isUser ? `<button id="ftp-override-reset" style="flex:1;padding:10px;border:1px solid var(--c-border);background:transparent;border-radius:6px;cursor:pointer;font-family:var(--f);font-size:13px;color:var(--c-muted)">Reset to derived</button>` : ''}
      </div>
    </div>`;
}

export function wireFTPDetailHandlers(rerender: () => void): void {
  const slider = document.getElementById('ftp-override-slider') as HTMLInputElement | null;
  const label = document.getElementById('ftp-override-label');
  if (slider && label) {
    slider.addEventListener('input', () => {
      label.textContent = `${parseInt(slider.value, 10)} W`;
    });
  }
  document.getElementById('ftp-override-save')?.addEventListener('click', () => {
    if (!slider) return;
    const value = parseInt(slider.value, 10);
    const m = getMutableState();
    if (!m.triConfig) return;
    m.triConfig.bike = {
      ...(m.triConfig.bike ?? {}),
      ftp: value,
      ftpSource: 'user',
      ftpConfidence: 'high',
    };
    appendFtpSample(m.triConfig.bike, value, 'user', 'high');
    if (m.triConfig.prediction) m.triConfig.prediction = undefined;
    saveState();
    rerender();
  });
  document.getElementById('ftp-override-reset')?.addEventListener('click', () => {
    const m = getMutableState();
    if (!m.triConfig?.bike) return;
    m.triConfig.bike = { ...m.triConfig.bike, ftpSource: 'derived' };
    if (m.triConfig.prediction) m.triConfig.prediction = undefined;
    saveState();
    rerender();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// VO2max detail page — adds the override hierarchy on top of the existing
// Mosaic / Watch toggle. Computed value is shown as the source-of-record when
// no override is set; override pins a value above both.
// ────────────────────────────────────────────────────────────────────────────

export function buildVO2DetailPage(s: SimulatorState): string {
  // Refresh the orchestrator's per-discipline picture for the methods card.
  const est = s.vo2Estimates ?? computeVO2Estimates(s);
  const watch = s.vo2 ?? null;
  const hasWatch = watch != null && watch > 0;
  const override = s.vo2Override ?? null;
  const source = s.vo2Source ?? 'mosaic';
  const mosaicVal = est.headline.value;

  // Resolve the displayed value via the override > toggle > computed chain.
  let displayVal: number | null;
  let provenance: string;
  if (override) {
    displayVal = override.value;
    provenance = `Manually set ${formatRelativeShort(override.setAt)}`;
  } else if (source === 'device' && hasWatch) {
    displayVal = watch;
    provenance = 'From your watch';
  } else if (mosaicVal != null) {
    displayVal = mosaicVal;
    const sportLabel = est.headline.sport ?? 'fitness';
    provenance = `Best demonstrated in ${sportLabel}`;
  } else {
    displayVal = null;
    provenance = 'No VO2max data yet — set one below or sync activity history.';
  }

  const headline = displayVal != null ? `${Math.round(displayVal)}` : '—';
  const conf = override
    ? 'high' as const
    : (source === 'device' && hasWatch
        ? 'medium' as const
        : (est.headline.confidence === 'none' ? null : est.headline.confidence));

  // Source toggle (with a third "Manual" state when override is active).
  const toggle = buildVO2SourceToggle({ override, hasWatch, source });

  const overrideCard = buildVO2OverrideCard(displayVal, !!override);

  const methods = buildVO2MethodsCard(est);
  const conflict = getVo2Conflict(s);
  const conflictBanner = buildVo2ConflictBanner(conflict);

  const footer = 'VO2max is your peak rate of oxygen use during exercise (ml/kg/min). Cross-sport, lab-grade. We estimate it from your training data; your watch estimates it from HR variability during activities; neither is ground truth. Set a manual value if you have a lab test.';

  return buildShell({
    title: 'VO2max',
    headline,
    confidence: conf,
    provenance,
    sparkline: methods + conflictBanner + toggle,
    overrideCard,
    footer,
  });
}

function buildVO2SourceToggle(args: {
  override: SimulatorState['vo2Override'] | null;
  hasWatch: boolean;
  source: 'mosaic' | 'device';
}): string {
  const { override, hasWatch, source } = args;
  const overrideActive = !!override;
  const activeStyle = 'background:var(--c-black);color:#fff';
  const inactiveStyle = 'background:transparent;color:var(--c-muted)';
  const disabledStyle = 'background:transparent;color:var(--c-faint);cursor:not-allowed';

  const mosaicStyle = overrideActive ? disabledStyle : (source === 'mosaic' ? activeStyle : inactiveStyle);
  const watchStyle = overrideActive
    ? disabledStyle
    : (hasWatch ? (source === 'device' ? activeStyle : inactiveStyle) : disabledStyle);
  const manualStyle = overrideActive ? activeStyle : disabledStyle;

  return `
    <div class="m-card" style="padding:14px 16px;margin-bottom:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;color:var(--c-black)">Source</div>
          <div style="font-size:11px;color:var(--c-faint);margin-top:2px">${overrideActive
            ? 'Manual override is active. Reset to use your watch or our estimate again.'
            : 'Choose between our estimate and your watch reading.'}</div>
        </div>
        <div style="display:flex;border:1px solid var(--c-border-strong);border-radius:8px;overflow:hidden;flex-shrink:0">
          <button id="vo2-detail-source-mosaic"${overrideActive ? ' disabled' : ''} style="padding:6px 14px;font-size:12px;font-weight:500;border:none;font-family:var(--f);${mosaicStyle}">Mosaic</button>
          <button id="vo2-detail-source-device"${(!hasWatch || overrideActive) ? ' disabled' : ''} style="padding:6px 14px;font-size:12px;font-weight:500;border:none;font-family:var(--f);${watchStyle}">Watch</button>
          <button disabled style="padding:6px 14px;font-size:12px;font-weight:500;border:none;font-family:var(--f);${manualStyle}">Manual</button>
        </div>
      </div>
    </div>`;
}

/**
 * Per-source breakdown rendered as a bar chart with the cardiac ceiling drawn
 * as a dashed cap above the measured bars. Visualises that cardiac ceiling is
 * an upper bound, not a fourth measurement competing with running/cycling/
 * cross-training. The explainer beneath quantifies the headroom.
 *
 * Domain: 0 → max(cardiacCeiling, allBars) × 1.10 so the ceiling sits inside
 * the chart with vertical margin for its label.
 */
function buildVO2MethodsCard(est: NonNullable<SimulatorState['vo2Estimates']>): string {
  const r = est.running, c = est.cycling, ca = est.cardiac, ct = est.crossTraining;
  const ceiling = ca.value;

  type BarSpec = { key: 'running' | 'cycling' | 'crossTraining'; label: string; value: number };
  const bars: BarSpec[] = [];
  if (r.value != null) bars.push({ key: 'running', label: 'Running', value: r.value });
  if (c.value != null) bars.push({ key: 'cycling', label: 'Cycling', value: c.value });
  if (ct.value != null) bars.push({ key: 'crossTraining', label: 'Cross-training', value: ct.value });

  // Best-of bar gets the accent fill; others read in neutral grey. Length still
  // encodes value — colour only differentiates which source is currently the
  // headline. Keeps the chart within the 2-non-neutral colour budget.
  const bestValue = bars.length > 0 ? Math.max(...bars.map(b => b.value)) : null;

  // No measured bars and no ceiling — render the original row layout as a
  // graceful fallback. Doesn't happen in practice (ceiling needs HRmax/RHR
  // which any user with synced activity has) but defends against edge cases.
  if (bars.length === 0 && ceiling == null) {
    return `<div class="m-card" style="padding:14px 16px;margin-bottom:8px"><div style="font-size:11px;color:var(--c-muted)">No VO2max sources yet.</div></div>`;
  }

  const allValues = [...bars.map(b => b.value)];
  if (ceiling != null) allValues.push(ceiling);
  const domainMax = Math.max(...allValues, 1) * 1.10;

  const ceilingPct = ceiling != null ? Math.min(100, (ceiling / domainMax) * 100) : null;

  const barRow = (b: BarSpec): string => {
    const pct = Math.min(100, Math.max(0, (b.value / domainMax) * 100));
    const isBest = bestValue != null && b.value === bestValue;
    const fill = isBest ? 'var(--c-black)' : 'rgba(0,0,0,0.25)';
    return `
      <div style="margin-bottom:10px">
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:12px;color:var(--c-muted)">${b.label}</span>
          <span style="font-size:13px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${Math.round(b.value)}</span>
        </div>
        <div style="position:relative;height:10px;border-radius:5px;background:var(--c-border);overflow:hidden">
          <div style="position:absolute;left:0;top:0;height:100%;width:${pct.toFixed(1)}%;background:${fill};border-radius:5px"></div>
        </div>
      </div>`;
  };

  // Best measured value drives the headroom narrative.
  const bestMeasured = bestValue;
  const headroomCopy = (ceiling != null && bestMeasured != null)
    ? `Best measured ${Math.round(bestMeasured)} · ceiling ${Math.round(ceiling)} — ${Math.round(ceiling - bestMeasured)} points of theoretical headroom. Not a target to chase; the ceiling rises naturally as your underlying fitness builds.`
    : (ceiling != null ? `Cardiac ceiling ${Math.round(ceiling)} — your aerobic upper bound from peak HR ÷ resting HR. Not a measure of current fitness.` : '');

  // Ceiling line: dashed vertical line spanning the chart area at the
  // ceiling's x-position, with a small label above. Pure HTML/CSS so we
  // dodge the SVG sizing class of bug entirely.
  const ceilingMarker = ceilingPct != null && ceiling != null ? `
    <div style="position:absolute;left:${ceilingPct.toFixed(1)}%;top:-4px;bottom:24px;border-left:1.5px dashed var(--c-muted);transform:translateX(-1px)"></div>
    <div style="position:absolute;left:${ceilingPct.toFixed(1)}%;top:-20px;transform:translateX(-50%);font-size:10px;color:var(--c-muted);white-space:nowrap;font-variant-numeric:tabular-nums">Ceiling ${Math.round(ceiling)}</div>
  ` : '';

  return `
    <div class="m-card" style="padding:14px 16px;margin-bottom:8px">
      <div style="font-size:13px;color:var(--c-black);margin-bottom:14px">Per source</div>
      <div style="position:relative;padding-top:24px">
        ${ceilingMarker}
        ${bars.map(barRow).join('')}
        ${bars.length > 0 ? '<div style="height:6px"></div>' : ''}
      </div>
      ${headroomCopy ? `<div style="font-size:11px;color:var(--c-black);line-height:1.5;margin-top:6px;padding-top:10px;border-top:1px solid var(--c-border)">${headroomCopy}</div>` : ''}
    </div>`;
}

function buildVO2OverrideCard(currentVal: number | null, hasOverride: boolean): string {
  const seed = currentVal != null && currentVal > 0 ? Math.round(currentVal) : 45;
  const min = Math.max(20, seed - 15);
  const max = Math.min(85, seed + 15);
  return `
    <div class="m-card" style="padding:16px;margin-bottom:8px">
      <div style="font-size:13px;color:var(--c-black);margin-bottom:6px">Override</div>
      <div style="font-size:11px;color:var(--c-muted);line-height:1.5;margin-bottom:12px">A saved override pins this value above both the Mosaic estimate and your watch, and feeds race predictions. Use this if you have a lab test. The override will auto-clear when your training data clearly beats it (≥ 3 ml/kg/min, medium+ confidence), so you can set it once and move on.</div>
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <span style="font-size:11px;color:var(--c-muted)">VO2max</span>
          <span id="vo2-override-label" style="font-size:14px;font-weight:600;color:var(--c-black)">${seed}</span>
        </div>
        <input type="range" id="vo2-override-slider" class="m-slider-glass" min="${min}" max="${max}" step="1" value="${seed}">
        <div style="display:flex;justify-content:space-between;margin-top:2px">
          <span style="font-size:10px;color:var(--c-faint)">${min}</span>
          <span style="font-size:10px;color:var(--c-faint)">${max}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button id="vo2-override-save" style="flex:1;padding:10px;border:1px solid var(--c-border);background:transparent;border-radius:6px;cursor:pointer;font-family:var(--f);font-size:13px;color:var(--c-black)">Save override</button>
        ${hasOverride ? `<button id="vo2-override-reset" style="flex:1;padding:10px;border:1px solid var(--c-border);background:transparent;border-radius:6px;cursor:pointer;font-family:var(--f);font-size:13px;color:var(--c-muted)">Reset</button>` : ''}
      </div>
    </div>`;
}

export function wireVO2DetailHandlers(rerender: () => void): void {
  const slider = document.getElementById('vo2-override-slider') as HTMLInputElement | null;
  const label = document.getElementById('vo2-override-label');
  if (slider && label) {
    slider.addEventListener('input', () => {
      label.textContent = String(parseInt(slider.value, 10));
    });
  }
  document.getElementById('vo2-override-save')?.addEventListener('click', () => {
    if (!slider) return;
    const value = parseInt(slider.value, 10);
    const m = getMutableState();
    m.vo2Override = { value, setAt: new Date().toISOString() };
    saveState();
    rerender();
  });
  document.getElementById('vo2-override-reset')?.addEventListener('click', () => {
    const m = getMutableState();
    delete m.vo2Override;
    saveState();
    rerender();
  });
  document.getElementById('vo2-detail-source-mosaic')?.addEventListener('click', () => {
    const m = getMutableState();
    if (m.vo2Override) return;
    m.vo2Source = 'mosaic';
    saveState();
    rerender();
  });
  document.getElementById('vo2-detail-source-device')?.addEventListener('click', () => {
    const sv = getState();
    if (!(sv.vo2 != null && sv.vo2 > 0)) return;
    const m = getMutableState();
    if (m.vo2Override) return;
    m.vo2Source = 'device';
    saveState();
    rerender();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function confidenceForChip(c: 'high' | 'medium' | 'low' | 'none' | null | undefined): 'high' | 'medium' | 'low' | null {
  if (c === 'high' || c === 'medium' || c === 'low') return c;
  return null;
}

function formatRelativeShort(iso: string): string {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toISOString().slice(0, 10);
}

// Re-export helpers used by the dispatcher.
export { animateChartDrawOn, wireTabBarHandlers, navigateTab };
