/**
 * HYROX Performance Radar — 8-axis station percentile chart.
 *
 * Renders an octagon (one axis per HYROX station). Each axis represents the
 * percentile (0..100) the user beats vs the population: centre = bottom of
 * the field, outer ring = top 1%. The user's polygon is drawn over the grid.
 *
 * **Layout**: SVG holds the geometry (rings, axis spokes, user polygon, dots).
 * Station labels are HTML <span> elements absolutely-positioned via left%/top%
 * around the SVG. This is non-negotiable — long labels like "Burpee Broad Jumps"
 * and "Sandbag Lunges" will NOT clip in any container width and can wrap to
 * two lines on narrow screens. SVG <text> in a stretched chart distorts the
 * size and clips at the viewBox edge — see UX_PATTERNS § "SVG text is banned".
 *
 * Mounts on forecast-view between Skills Analysis and Stations table.
 */

import { HYROX_STATION_ORDER, STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { getStationPercentile } from '@/calculations/hyrox-population';
import {
  POPULATION_DATA_AVAILABLE,
  LAST_VERIFIED_SEASON,
} from '@/data/hyrox-population-distributions';
import type { HyroxStation } from '@/types/triathlon';
import type { HyroxStationLine } from '@/calculations/race-prediction.hyrox';

interface RadarOpts {
  /** Per-station benchmark lines from the prediction. */
  stations: HyroxStationLine[];
  /** Subset of stations to plot (pass active stations for doubles to get 4 axes). */
  axisOrder?: HyroxStation[];
}

/* ── Geometry ───────────────────────────────────────────────
 * The radar lives inside a square wrapper. The SVG is inset to leave gutters
 * for HTML labels on every side. Labels snap to one of nine zones (top, top-
 * right, right, bottom-right, bottom, bottom-left, left, top-left, centre)
 * based on the axis angle — this guarantees they sit inside dedicated gutter
 * space and never collide with the chart.
 */
const SVG_VIEW = 200;                         // SVG viewBox is square 200×200
const SVG_CENTRE = SVG_VIEW / 2;
const SVG_RADIUS = SVG_VIEW * 0.42;            // outer ring inside the SVG
const SVG_INSET_PCT = 19;                      // % of wrapper reserved per side for labels

// Vibrant indigo — the radar gets its own distinct hue, separate from the
// four percentile-row colours below it (pink / teal / orange / amber). Cool
// tone reads as analytical, fitting "where you sit on each station".
const STROKE_OUTER = '#6366F1';                // indigo-500 — outermost grid + polygon stroke
const STROKE_DARK = '#4338CA';                 // indigo-700 — gradient end stop, dot fill
const FILL_INNER = 'rgba(99,102,241,0.18)';
const FILL_OUTER = 'rgba(99,102,241,0.04)';
const DOT_FILLED = '#4338CA';                  // deep indigo — calibrated benchmark
const HALO = 'rgba(255,255,255,0.95)';

function pointAt(angleRad: number, radius: number): [number, number] {
  return [SVG_CENTRE + radius * Math.cos(angleRad), SVG_CENTRE + radius * Math.sin(angleRad)];
}

function gridPolygon(axes: number, radius: number): string {
  const pts: string[] = [];
  for (let i = 0; i < axes; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / axes;
    const [x, y] = pointAt(ang, radius);
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

export function renderPerformanceRadar(opts: RadarOpts): string {
  const axes = opts.axisOrder ?? HYROX_STATION_ORDER;
  const N = axes.length;
  if (N < 3) return '';

  type AxisPoint = { station: HyroxStation; pct: number; label: string; calibrated: boolean };
  const points: AxisPoint[] = axes.map(st => {
    const line = opts.stations.find(l => l.station === st);
    const pct = line ? getStationPercentile(st, line.baseSec) : 0;
    return {
      station: st,
      pct,
      label: STATION_DISPLAY[st]?.name ?? st,
      calibrated: line?.source === 'calibrated',
    };
  });

  // Build user polygon (in SVG coords).
  const userPolyPts: string[] = points.map((p, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    const radius = (p.pct / 100) * SVG_RADIUS;
    const [x, y] = pointAt(ang, radius);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  // Axis spokes + on-axis dots (in SVG coords). Dots fade-in with a small
  // scale-up after the polygon has drawn (delay scales with axis index).
  const axisSvg = points.map((p, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    const [ox, oy] = pointAt(ang, SVG_RADIUS);
    const radius = (p.pct / 100) * SVG_RADIUS;
    const [dx, dy] = pointAt(ang, radius);
    const delay = (1100 + i * 40); // ms — dots arrive once the polygon has settled
    const dotMain = p.calibrated
      ? `<circle class="hx-radar-dot" style="animation-delay:${delay}ms" cx="${dx.toFixed(2)}" cy="${dy.toFixed(2)}" r="3.4" fill="${DOT_FILLED}"/>`
      : `<circle class="hx-radar-dot" style="animation-delay:${delay}ms" cx="${dx.toFixed(2)}" cy="${dy.toFixed(2)}" r="3.0" fill="#fff" stroke="${DOT_FILLED}" stroke-width="1.2"/>`;
    const dotHalo = p.calibrated
      ? `<circle class="hx-radar-dot" style="animation-delay:${delay - 30}ms" cx="${dx.toFixed(2)}" cy="${dy.toFixed(2)}" r="5.2" fill="${HALO}"/>`
      : '';
    return `
      <line x1="${SVG_CENTRE}" y1="${SVG_CENTRE}" x2="${ox.toFixed(2)}" y2="${oy.toFixed(2)}" stroke="rgba(0,0,0,0.07)" stroke-width="0.6"/>
      ${dotHalo}${dotMain}
    `;
  }).join('');

  // HTML labels: snapped to gutter zones based on axis angle. Zones live
  // outside the SVG inset so labels never overlap the chart geometry. Long
  // labels wrap to multiple lines naturally.
  const labelsHtml = points.map((p, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    const eps = 0.20;
    let left: number, top: number, translate: string, textAlign: string, maxWidth: string;
    if (Math.abs(cosA) < eps) {
      // Pure top or bottom: spans the full top/bottom gutter.
      left = 50;
      top = sinA < 0 ? 0 : 100;
      translate = sinA < 0 ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
      textAlign = 'center';
      maxWidth = '54%';
    } else if (Math.abs(sinA) < eps) {
      // Pure left or right: pinned to wrapper edge with vertical centring.
      if (cosA > 0) { left = 100; translate = 'translate(-100%, -50%)'; textAlign = 'right'; }
      else          { left = 0;   translate = 'translate(0, -50%)';     textAlign = 'left';  }
      top = 50;
      maxWidth = '20%';
    } else {
      // Corners: pinned to top/bottom inset corners, anchored to outer edge.
      if (cosA > 0) {
        left = 100;
        translate = sinA < 0 ? 'translate(-100%, 0)' : 'translate(-100%, -100%)';
        textAlign = 'right';
      } else {
        left = 0;
        translate = sinA < 0 ? 'translate(0, 0)' : 'translate(0, -100%)';
        textAlign = 'left';
      }
      top = sinA < 0 ? 13 : 87;
      maxWidth = '28%';
    }
    const colour = p.calibrated ? 'var(--c-black)' : 'var(--c-muted)';
    const weight = p.calibrated ? 600 : 500;
    return `
      <span style="position:absolute;left:${left}%;top:${top}%;transform:${translate};font-size:10.5px;font-weight:${weight};color:${colour};line-height:1.2;text-align:${textAlign};max-width:${maxWidth};white-space:normal;letter-spacing:-0.01em">${p.label}</span>
    `;
  }).join('');

  const calibratedCount = points.filter(p => p.calibrated).length;
  const allCalibrated = calibratedCount === N;

  // Empty state when zero stations are calibrated. The polygon would otherwise
  // plot every axis at the band's seed percentile — a regular N-gon that reads
  // as a circle and carries no signal about strengths vs limiters. Replace
  // with a calibration prompt so the user knows what's missing.
  if (calibratedCount === 0) {
    return `
      <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;padding:18px 20px;margin-bottom:14px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
        <div style="font-size:11px;color:var(--c-faint);margin-bottom:6px">Performance radar</div>
        <div style="font-size:13px;color:var(--c-black);margin-bottom:6px;line-height:1.4">Calibrate stations to see your strengths and limiters.</div>
        <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;line-height:1.5">Without per-station times we can only show your ability-band estimate, which plots every spoke at the same percentile and tells you nothing. One pass through each station, fresh, surfaces the real shape of your race.</div>
        <button id="hx-radar-calibrate-cta" style="font-size:12px;font-weight:600;color:var(--c-black);background:transparent;border:1px solid var(--c-border);border-radius:8px;padding:8px 14px;cursor:pointer">Test stations →</button>
      </div>
    `;
  }

  // Lead-with-data subtitle (when real population data is available).
  const subtitle = POPULATION_DATA_AVAILABLE
    ? `Each spoke shows where you sit on that station vs ${LAST_VERIFIED_SEASON.replace(/\s*\(.*\)\s*/, '').trim()} field. Outer ring is top 1%.`
    : 'Each spoke shows where you sit on that station vs the population. Outer ring is top 1%.';

  // Build the user polygon as a closed `<path>` so we can normalise its length
  // to 1 via `pathLength="1"` and animate stroke-dashoffset to draw it on. The
  // dasharray `1 0.0001` keeps the closing segment from being skipped on Safari.
  const userPathD = `M${userPolyPts.join(' L')} Z`;

  return `
    <style>
      @keyframes hxRadarDraw {
        from { stroke-dashoffset: 1; }
        to   { stroke-dashoffset: 0; }
      }
      @keyframes hxRadarFill {
        from { fill-opacity: 0; }
        to   { fill-opacity: 1; }
      }
      @keyframes hxRadarFadeIn {
        from { opacity: 0; transform: scale(0.6); }
        to   { opacity: 1; transform: scale(1); }
      }
      .hx-radar-poly  {
        stroke-dasharray: 1 0.0001;
        stroke-dashoffset: 1;
        animation: hxRadarDraw 1.1s cubic-bezier(0.4,0,0.2,1) forwards;
      }
      .hx-radar-fill  { fill-opacity: 0; animation: hxRadarFill 0.5s ease 0.9s forwards; }
      .hx-radar-dot   { opacity: 0; transform-origin: center; transform-box: fill-box; animation: hxRadarFadeIn 0.35s cubic-bezier(0.2,1.6,0.4,1) forwards; }
    </style>
    <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;padding:18px 20px 16px;margin-bottom:14px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
      <div style="font-size:11px;color:var(--c-faint);margin-bottom:6px">Performance radar</div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:14px;line-height:1.4">${subtitle}</div>
      <div style="position:relative;width:100%;max-width:380px;margin:0 auto;aspect-ratio:1/1">
        <svg viewBox="0 0 ${SVG_VIEW} ${SVG_VIEW}" style="position:absolute;top:${SVG_INSET_PCT}%;left:${SVG_INSET_PCT}%;width:${100 - SVG_INSET_PCT * 2}%;height:${100 - SVG_INSET_PCT * 2}%;display:block;overflow:visible">
          <defs>
            <radialGradient id="hx-radar-fill" cx="50%" cy="50%" r="50%">
              <stop offset="0%"  stop-color="${FILL_INNER}"/>
              <stop offset="100%" stop-color="${FILL_OUTER}"/>
            </radialGradient>
            <linearGradient id="hx-radar-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stop-color="${STROKE_DARK}"/>
              <stop offset="100%" stop-color="${STROKE_OUTER}"/>
            </linearGradient>
          </defs>
          <!-- Concentric grid rings -->
          <polygon points="${gridPolygon(N, SVG_RADIUS * 0.25)}" fill="none" stroke="rgba(0,0,0,0.04)" stroke-width="0.6"/>
          <polygon points="${gridPolygon(N, SVG_RADIUS * 0.50)}" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="0.6"/>
          <polygon points="${gridPolygon(N, SVG_RADIUS * 0.75)}" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="0.6"/>
          <polygon points="${gridPolygon(N, SVG_RADIUS)}"        fill="none" stroke="${STROKE_OUTER}" stroke-width="1" stroke-opacity="0.55"/>
          <!-- Axis spokes + dots -->
          ${axisSvg}
          <!-- User polygon: olive fill + gradient stroke, drawn in via dashoffset. -->
          <path d="${userPathD}" pathLength="1"
            class="hx-radar-fill"
            fill="url(#hx-radar-fill)"
            stroke="none"/>
          <path d="${userPathD}" pathLength="1"
            class="hx-radar-poly"
            fill="none"
            stroke="url(#hx-radar-stroke)"
            stroke-width="1.7"
            stroke-opacity="${allCalibrated ? '1' : '0.7'}"
            stroke-linejoin="round"
            stroke-linecap="round"/>
        </svg>
        ${labelsHtml}
      </div>
      <div style="font-size:10px;color:var(--c-faint);text-align:center;margin-top:10px;line-height:1.4">${calibratedCount}/${N} stations calibrated. Solid dot is your benchmark, hollow dot is a seed estimate.</div>
    </div>
  `;
}
