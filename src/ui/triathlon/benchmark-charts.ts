/**
 * Shared chart helpers for the triathlon Stats detail pages.
 *
 * Originally inlined inside `progress-detail-view.ts`; extracted so the
 * Fitness detail page can render the same FTP / CSS / LT sparklines without
 * pulling in the whole Progress module.
 */

import { fmtModelPaceKm } from '@/utils/format';

export interface BenchmarkSample { date: string; value: number }

/** Render a 320×50 sparkline + headline number for a benchmark history.
 *  accent/fill give each chart its own identity; delta text turns green/red
 *  based on whether the metric improved.
 */
export function buildBenchmarkTrendChart(
  samples: BenchmarkSample[],
  accent: string,
  fill: string,
  unitSuffix: string,
  inverted = false,
): string {
  if (samples.length < 2) {
    return chartEmptyState(55, 'Fills as your tests accrue', samples.length === 0 ? 'No samples yet' : '1 sample so far, needs 2+');
  }

  const sorted = [...samples].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const n = sorted.length;
  const vals = sorted.map(s => s.value);
  const W = 320, H = 50, padL = 6, padR = 6;
  const usableW = W - padL - padR;
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = Math.max(1, maxV - minV);
  const padding = span * 0.15;
  const lo = minV - padding;
  const hi = maxV + padding;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => {
    const norm = (v - lo) / (hi - lo);
    const flipped = inverted ? norm : 1 - norm;
    return Math.max(2, flipped * (H - 4) + 2);
  };

  const pts: [number, number][] = vals.map((v, i) => [xOf(i), yOf(v)]);
  const topPath = smoothAreaPath(pts);
  const areaPath = `${topPath} L ${xOf(n - 1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  const labelStep = n > 6 ? Math.ceil(n / 6) : 1;
  const labels = sorted.map((s, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '<span></span>';
    const d = new Date(s.date);
    const lbl = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<span style="font-size:9px;color:${i === n - 1 ? 'var(--c-black)' : 'var(--c-faint)'};font-weight:${i === n - 1 ? '600' : '400'}">${lbl}</span>`;
  }).join('');

  const latest = sorted[n - 1].value;
  const first = sorted[0].value;
  const delta = latest - first;
  const deltaSign = delta >= 0 ? '+' : '';
  const better = inverted ? delta < 0 : delta > 0;
  const isFlat = Math.abs(delta) / Math.max(Math.abs(first), 1) < 0.005;
  const deltaCol = isFlat ? 'var(--c-muted)' : (better ? '#34C759' : '#FF3B30');

  return `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${latest.toFixed(unitSuffix === 'W' ? 0 : 1)}${unitSuffix ? `<span style="font-size:11px;color:var(--c-muted);font-weight:400;margin-left:2px">${unitSuffix}</span>` : ''}</span>
        <span style="font-size:11px;color:${deltaCol};font-variant-numeric:tabular-nums">${deltaSign}${delta.toFixed(unitSuffix === 'W' ? 0 : 1)} since first sample</span>
      </div>
      <div style="position:relative">
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block;overflow:visible">
          <path d="${areaPath}" fill="${fill}" stroke="none"/>
          <path d="${topPath}" class="chart-draw" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        </svg>
        <div style="display:flex;justify-content:space-between;padding:3px ${padR}px 0 ${padL}px">${labels}</div>
      </div>
    </div>`;
}

function fmtCssPace(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** CSS-specific wrapper that pace-formats the headline and delta. */
export function buildCssTrendChart(samples: BenchmarkSample[]): string {
  if (samples.length < 2) {
    return chartEmptyState(55, 'Fills as your tests accrue', samples.length === 0 ? 'No samples yet' : '1 sample so far, needs 2+');
  }
  const sorted = [...samples].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = sorted[sorted.length - 1].value;
  const first = sorted[0].value;
  const delta = latest - first;
  const better = delta < 0;
  const deltaCol = Math.abs(delta) < 0.5 ? 'var(--c-muted)' : (better ? '#5a8050' : '#c06a50');
  const sign = delta >= 0 ? '+' : '';
  const inner = buildBenchmarkTrendChart(samples, '#38BDF8', 'rgba(56,189,248,0.08)', '/100m', /*inverted*/ true)
    .replace(/<span style="font-size:14px;font-weight:600[^>]*>[^<]*(?:<span[^>]*>[^<]*<\/span>)?<\/span>/,
      `<span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${fmtCssPace(latest)}<span style="font-size:11px;color:var(--c-muted);font-weight:400;margin-left:2px">/100m</span></span>`)
    .replace(/<span style="font-size:11px;color:[^"]+;font-variant-numeric:tabular-nums">[^<]*<\/span>/,
      `<span style="font-size:11px;color:${deltaCol};font-variant-numeric:tabular-nums">${sign}${delta.toFixed(1)}s since first sample</span>`);
  return inner;
}

/** LT and critical pace (model paces, unrounded): the whole second
 *  (displayPaceSec), minute carried, so 299.6 reads 5:00, never 4:60. */
function fmtLtPace(secPerKm: number): string {
  return fmtModelPaceKm(secPerKm);
}

/** LT-specific wrapper that pace-formats the headline and delta. */
export function buildLtTrendChart(samples: BenchmarkSample[]): string {
  if (samples.length < 2) {
    return chartEmptyState(55, 'Fills as your tests accrue', samples.length === 0 ? 'No samples yet' : '1 sample so far, needs 2+');
  }
  const sorted = [...samples].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = sorted[sorted.length - 1].value;
  const first = sorted[0].value;
  const delta = latest - first;
  const better = delta < 0;
  const deltaCol = Math.abs(delta) < 0.5 ? 'var(--c-muted)' : (better ? '#5a8050' : '#c06a50');
  const sign = delta >= 0 ? '+' : '';
  const inner = buildBenchmarkTrendChart(samples, '#14B8A6', 'rgba(20,184,166,0.08)', '/km', /*inverted*/ true)
    .replace(/<span style="font-size:14px;font-weight:600[^>]*>[^<]*(?:<span[^>]*>[^<]*<\/span>)?<\/span>/,
      `<span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${fmtLtPace(latest)}<span style="font-size:11px;color:var(--c-muted);font-weight:400;margin-left:2px">/km</span></span>`)
    .replace(/<span style="font-size:11px;color:[^"]+;font-variant-numeric:tabular-nums">[^<]*<\/span>/,
      `<span style="font-size:11px;color:${deltaCol};font-variant-numeric:tabular-nums">${sign}${delta.toFixed(1)}s since first sample</span>`);
  return inner;
}

/** Critical-pace wrapper. Pace-formats the headline and delta (sec/km, lower
 *  is better), violet accent to distinguish it from LT (teal) and VDOT (green). */
export function buildCpTrendChart(samples: BenchmarkSample[]): string {
  if (samples.length < 2) {
    return chartEmptyState(55, 'Fills as your VDOT updates', samples.length === 0 ? 'No samples yet' : '1 sample so far, needs 2+');
  }
  const sorted = [...samples].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = sorted[sorted.length - 1].value;
  const first = sorted[0].value;
  const delta = latest - first;
  const better = delta < 0;
  const deltaCol = Math.abs(delta) < 0.5 ? 'var(--c-muted)' : (better ? '#5a8050' : '#c06a50');
  const sign = delta >= 0 ? '+' : '';
  const inner = buildBenchmarkTrendChart(samples, '#8B5CF6', 'rgba(139,92,246,0.10)', '/km', /*inverted*/ true)
    .replace(/<span style="font-size:14px;font-weight:600[^>]*>[^<]*(?:<span[^>]*>[^<]*<\/span>)?<\/span>/,
      `<span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${fmtLtPace(latest)}<span style="font-size:11px;color:var(--c-muted);font-weight:400;margin-left:2px">/km</span></span>`)
    .replace(/<span style="font-size:11px;color:[^"]+;font-variant-numeric:tabular-nums">[^<]*<\/span>/,
      `<span style="font-size:11px;color:${deltaCol};font-variant-numeric:tabular-nums">${sign}${delta.toFixed(1)}s since first sample</span>`);
  return inner;
}

/** Format a finish time as h:mm:ss or m:ss (mirrors `ft` in utils/format). */
function fmtFinishTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Predicted-finish-time wrapper. The series is a race-time prediction in
 * seconds (lower = faster = better), so the headline and delta are formatted
 * as times rather than raw seconds. Green accent, inverted (improvement reads
 * as up). Used by the no-target-race forecast drill-down.
 */
export function buildPredictedTimeTrendChart(samples: BenchmarkSample[]): string {
  if (samples.length < 2) {
    return chartEmptyState(55, 'Fills in as your fitness is recorded', samples.length === 0 ? 'No samples yet' : '1 sample so far, needs 2+');
  }
  const sorted = [...samples].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const latest = sorted[sorted.length - 1].value;
  const first = sorted[0].value;
  const delta = latest - first; // seconds; negative = got faster
  const absD = Math.abs(delta);
  const isFlat = absD < 1; // < 1s either way reads as no movement
  const better = delta < 0;
  const deltaCol = isFlat ? 'var(--c-muted)' : (better ? '#34C759' : '#FF3B30');
  const deltaStr = isFlat
    ? 'No change yet'
    : `${better ? '−' : '+'}${absD >= 60 ? `${Math.floor(absD / 60)}:${String(Math.round(absD % 60)).padStart(2, '0')}` : `${Math.round(absD)}s`} since first sample`;
  return buildBenchmarkTrendChart(samples, '#16A34A', 'rgba(22,163,74,0.10)', '', /*inverted*/ true)
    .replace(/<span style="font-size:14px;font-weight:600[^>]*>[^<]*(?:<span[^>]*>[^<]*<\/span>)?<\/span>/,
      `<span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${fmtFinishTime(latest)}</span>`)
    .replace(/<span style="font-size:11px;color:[^"]+;font-variant-numeric:tabular-nums">[^<]*<\/span>/,
      `<span style="font-size:11px;color:${deltaCol};font-variant-numeric:tabular-nums">${deltaStr}</span>`);
}

/**
 * Forward race-time projection ("if you hold the plan"). Rendered with the SAME
 * canonical renderer as the swim/CSS trend sparkline (`buildBenchmarkTrendChart`
 * — full-width area fill + solid line, draws in via `animateChartDrawOn`), which
 * is the look Tristan signed off on. The custom liquid-glass variant kept
 * fighting the edge-to-edge fill, so this defers entirely to the shared chart.
 *
 * The projected series is scaled multiplicatively onto `opts.nowSec` (the
 * adjusted hero) so the left end equals the predicted finish the user already
 * sees, then mapped to weekly synthetic dates (today + w·7d) so the shared
 * chart's date axis spans the full width. Headline + delta are time-formatted
 * via the same regex-replace the LT/CSS wrappers use. Returns the title + chart
 * inner; the caller wraps it in a card and appends the horizon selector.
 *
 * `projected` is `getStandardForecastProjection` output (index 0 = now).
 */
export function buildForecastTrajectoryChart(
  projected: { weeksAhead: number; value: number }[],
  opts: { nowSec: number; label: string },
): string {
  const title = `<div style="font-size:13px;color:var(--c-muted);font-weight:600;margin-bottom:10px">Projected ${opts.label} time if you hold the plan</div>`;
  if (projected.length < 2) {
    return `${title}<div style="font-size:13px;color:var(--c-faint);line-height:1.5">Keep training and a forecast appears here.</div>`;
  }

  const nowRaw = projected[0].value;
  const scale = opts.nowSec > 0 && nowRaw > 0 ? opts.nowSec / nowRaw : 1;
  const horizonWeeks = projected[projected.length - 1].weeksAhead;
  const base = Date.now();
  const DAY = 86400000;
  const samples = projected.map(p => ({
    date: new Date(base + p.weeksAhead * 7 * DAY).toISOString(),
    value: p.value * scale,
  }));
  const nowSec = samples[0].value;
  const endSec = samples[samples.length - 1].value;
  const delta = endSec - nowSec; // negative = faster
  const absD = Math.abs(delta);
  const isFlat = absD < 1;
  const better = delta < 0;
  const deltaCol = isFlat ? 'var(--c-muted)' : (better ? '#34C759' : '#FF3B30');
  const dStr = absD >= 60 ? `${Math.floor(absD / 60)}:${String(Math.round(absD % 60)).padStart(2, '0')}` : `${Math.round(absD)}s`;
  const deltaStr = isFlat ? `holding steady over ${horizonWeeks} weeks` : `${better ? '−' : '+'}${dStr} in ${horizonWeeks} weeks`;

  const chart = buildBenchmarkTrendChart(samples, '#14B8A6', 'rgba(20,184,166,0.12)', '', /*inverted*/ true)
    .replace(/<span style="font-size:14px;font-weight:600[^>]*>[^<]*(?:<span[^>]*>[^<]*<\/span>)?<\/span>/,
      `<span style="font-size:14px;font-weight:600;color:#0F172A;font-variant-numeric:tabular-nums">${fmtFinishTime(endSec)}<span style="font-size:11px;color:var(--c-muted);font-weight:400;margin-left:4px">in ${horizonWeeks} wk</span></span>`)
    .replace(/<span style="font-size:11px;color:[^"]+;font-variant-numeric:tabular-nums">[^<]*<\/span>/,
      `<span style="font-size:11px;color:${deltaCol};font-variant-numeric:tabular-nums">${deltaStr}</span>`);
  // Reveal the chart left-to-right with a CSS clip-path wipe. Pure CSS so it
  // runs on insert (and re-runs whenever the card is rebuilt on a horizon/shoe
  // switch) — no stroke-dashoffset/getTotalLength, which is unreliable on this
  // preserveAspectRatio="none" + non-scaling-stroke chart (it stuck mid-draw).
  return `
    <style>
      @keyframes stdProjWipe { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
      .std-proj-wipe { animation: stdProjWipe 2.2s cubic-bezier(0.33,0,0.2,1) forwards; will-change: clip-path; }
    </style>
    ${title}
    <div class="std-proj-wipe">${chart}</div>`;
}

export function smoothAreaPath(pts: [number, number][]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  return `M ${pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`;
}

export function chartEmptyState(height = 65, msg = 'Not enough data yet', sub = 'Needs at least 2 weeks'): string {
  return `<div style="height:${height}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:rgba(0,0,0,0.02);border-radius:10px">
    <div style="font-size:13px;color:var(--c-muted);text-align:center">${msg}</div>
    <div style="font-size:11px;color:var(--c-faint);text-align:center">${sub}</div>
  </div>`;
}

/**
 * Animate every `path.chart-draw` SVG path on the page from invisible to
 * fully drawn over 1.2 s. Idempotent. Calls itself inside requestAnimationFrame.
 */
export function animateChartDrawOn(): void {
  requestAnimationFrame(() => {
    document.querySelectorAll<SVGPathElement>('path.chart-draw').forEach(path => {
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      path.getBoundingClientRect();
      path.style.transition = 'stroke-dashoffset 1.2s ease-out';
      path.style.strokeDashoffset = '0';
      const clear = () => {
        path.style.strokeDasharray = '';
        path.style.strokeDashoffset = '';
        path.removeEventListener('transitionend', clear);
      };
      path.addEventListener('transitionend', clear, { once: true });
      setTimeout(clear, 1400);
    });
  });
}
