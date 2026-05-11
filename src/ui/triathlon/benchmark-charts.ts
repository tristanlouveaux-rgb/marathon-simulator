/**
 * Shared chart helpers for the triathlon Stats detail pages.
 *
 * Originally inlined inside `progress-detail-view.ts`; extracted so the
 * Fitness detail page can render the same FTP / CSS / LT sparklines without
 * pulling in the whole Progress module.
 */

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
    return chartEmptyState(55, 'Fills as your tests accrue', samples.length === 0 ? 'No samples yet' : '1 sample so far — needs 2+');
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
    return chartEmptyState(55, 'Fills as your tests accrue', samples.length === 0 ? 'No samples yet' : '1 sample so far — needs 2+');
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

function fmtLtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** LT-specific wrapper that pace-formats the headline and delta. */
export function buildLtTrendChart(samples: BenchmarkSample[]): string {
  if (samples.length < 2) {
    return chartEmptyState(55, 'Fills as your tests accrue', samples.length === 0 ? 'No samples yet' : '1 sample so far — needs 2+');
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
 * fully drawn over 1.2 s. Idempotent — calls itself inside requestAnimationFrame.
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
