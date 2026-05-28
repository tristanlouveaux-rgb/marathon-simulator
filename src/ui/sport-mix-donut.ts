/**
 * Shared sport-mix donut + legend, used in the forecast "You" chip drill-down
 * across all three modes (running / triathlon / HYROX).
 *
 * Visual rules (per docs/UX_PATTERNS.md):
 *   - Running slice uses the caller-supplied accent (mode-specific brand colour).
 *   - All other slices use neutral greys in descending size order.
 *   - Max 2 non-neutral colours per component (the accent + nothing else).
 *   - No decorative gradients on slice fills.
 *   - No drop-shadow on the SVG.
 *   - Solid fills on legend dots.
 *
 * Top-N collapse: `collapseTopN(slices, 3)` rolls the long tail into one
 * "N more sports" entry so cluttered profiles render cleanly.
 */

import type { SimulatorState } from '@/types/state';

export interface SportSlice {
  sport: string;
  label: string;
  weeklyTSS: number;
  sessionsPerWeek: number;
  pct: number;
}

const SPORT_NEUTRALS = ['#94A3B8', '#CBD5E1', '#E2E8F0'];

function sportLabel(sport: string): string {
  const key = sport.toLowerCase();
  if (key === 'running' || key === 'run') return 'Running';
  if (key === 'cycling' || key === 'bike' || key === 'ride' || key === 'mountain_biking') return 'Cycling';
  if (key === 'swimming' || key === 'swim') return 'Swimming';
  if (key === 'strength' || key === 'weight_training' || key === 'gym' || key === 'crossfit' || key === 'workout') return 'Strength';
  if (key === 'hiit' || key === 'circuit_training') return 'HIIT';
  if (key === 'hiking' || key === 'walking') return 'Hiking';
  if (key === 'rowing') return 'Rowing';
  if (key === 'yoga' || key === 'mobility') return 'Mobility';
  return sport.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Build sport slices from per-sport baseline + running-equivalent TSS. */
export function computeSportMix(s: SimulatorState): { slices: SportSlice[]; totalWeeklyTSS: number } {
  const baselineByType = s.sportBaselineByType ?? {};
  const rawSeries = s.historicWeeklyRawTSS ?? [];
  const equivSeries = s.historicWeeklyTSS ?? [];
  const totalSeries = rawSeries.length > 0 ? rawSeries : equivSeries;
  const totalWeeklyTSS = totalSeries.length > 0
    ? totalSeries.reduce((a, b) => a + b, 0) / totalSeries.length
    : 0;

  const nonRunningEntries: Array<Omit<SportSlice, 'pct'>> = Object.entries(baselineByType).map(([sport, agg]) => ({
    sport,
    label: sportLabel(sport),
    weeklyTSS: agg.avgSessionRawTSS * agg.sessionsPerWeek,
    sessionsPerWeek: agg.sessionsPerWeek,
  }));
  const nonRunningTotalTSS = nonRunningEntries.reduce((sum, e) => sum + e.weeklyTSS, 0);
  const runningWeeklyTSS = Math.max(0, totalWeeklyTSS - nonRunningTotalTSS);
  const runningSessionsPerWeek = s.rw ?? 0;

  const all: Array<Omit<SportSlice, 'pct'>> = [];
  if (runningWeeklyTSS > 0 || runningSessionsPerWeek > 0) {
    all.push({
      sport: 'running',
      label: 'Running',
      weeklyTSS: runningWeeklyTSS,
      sessionsPerWeek: runningSessionsPerWeek,
    });
  }
  all.push(...nonRunningEntries);
  all.sort((a, b) => b.weeklyTSS - a.weeklyTSS);

  const grandTotal = all.reduce((sum, e) => sum + e.weeklyTSS, 0);
  return {
    slices: all.map(e => ({ ...e, pct: grandTotal > 0 ? (e.weeklyTSS / grandTotal) * 100 : 0 })),
    totalWeeklyTSS: grandTotal,
  };
}

/** Roll all slices past `keep` into a single "N more sports" entry. */
export function collapseTopN(slices: SportSlice[], keep: number): SportSlice[] {
  if (slices.length <= keep + 1) return slices;
  const top = slices.slice(0, keep);
  const rest = slices.slice(keep);
  return [...top, {
    sport: '__more__',
    label: `${rest.length} more sports`,
    weeklyTSS: rest.reduce((s, x) => s + x.weeklyTSS, 0),
    sessionsPerWeek: rest.reduce((s, x) => s + x.sessionsPerWeek, 0),
    pct: rest.reduce((s, x) => s + x.pct, 0),
  }];
}

function sliceFill(slice: SportSlice, neutralIdx: number, accent: string): string {
  if (slice.sport === 'running' || slice.sport === 'run') return accent;
  return SPORT_NEUTRALS[Math.min(neutralIdx, SPORT_NEUTRALS.length - 1)];
}

function polarToCartesian(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutArcPath(cx: number, cy: number, rOuter: number, rInner: number, startDeg: number, endDeg: number): string {
  const safeEnd = endDeg - startDeg >= 359.99 ? startDeg + 359.99 : endDeg;
  const startOuter = polarToCartesian(cx, cy, rOuter, safeEnd);
  const endOuter = polarToCartesian(cx, cy, rOuter, startDeg);
  const startInner = polarToCartesian(cx, cy, rInner, safeEnd);
  const endInner = polarToCartesian(cx, cy, rInner, startDeg);
  const largeArc = safeEnd - startDeg <= 180 ? 0 : 1;
  return [
    'M', startOuter.x.toFixed(2), startOuter.y.toFixed(2),
    'A', rOuter, rOuter, 0, largeArc, 0, endOuter.x.toFixed(2), endOuter.y.toFixed(2),
    'L', endInner.x.toFixed(2), endInner.y.toFixed(2),
    'A', rInner, rInner, 0, largeArc, 1, startInner.x.toFixed(2), startInner.y.toFixed(2),
    'Z',
  ].join(' ');
}

export interface SportMixTokens {
  textM: string;
  textS: string;
  textL: string;
  accent: string;
}

function escapeText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSportDonut(slices: SportSlice[], totalWeeklyTSS: number, tokens: SportMixTokens): string {
  if (slices.length === 0 || totalWeeklyTSS <= 0) {
    return `<div style="text-align:center;padding:24px 8px;font-size:12px;color:${tokens.textS}">Sport mix appears once Strava history syncs.</div>`;
  }
  const cx = 100, cy = 100, rOuter = 86, rInner = 62;
  const gapDeg = slices.length > 1 ? 1.5 : 0;
  let cursorDeg = 0;
  let neutralIdx = 0;
  const arcs: string[] = [];
  slices.forEach(slice => {
    const sweepDeg = (slice.pct / 100) * 360;
    if (sweepDeg < 0.2) return;
    const startDeg = cursorDeg + gapDeg / 2;
    const endDeg = cursorDeg + sweepDeg - gapDeg / 2;
    cursorDeg += sweepDeg;
    if (endDeg <= startDeg) return;
    const isRunning = slice.sport === 'running' || slice.sport === 'run';
    const fill = sliceFill(slice, neutralIdx, tokens.accent);
    if (!isRunning) neutralIdx += 1;
    arcs.push(`<path d="${donutArcPath(cx, cy, rOuter, rInner, startDeg, endDeg)}" fill="${fill}"/>`);
  });
  return `
    <div style="display:flex;justify-content:center;padding:8px 0 4px">
      <svg viewBox="0 0 200 200" width="200" height="200" style="display:block">
        <g>${arcs.join('')}</g>
        <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-family="var(--f)" font-size="11" fill="${tokens.textS}" font-weight="500">Weekly load</text>
        <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="var(--f)" font-size="26" fill="${tokens.textM}" font-weight="600" font-variant-numeric="tabular-nums" letter-spacing="-0.02em">${Math.round(totalWeeklyTSS)}</text>
        <text x="${cx}" y="${cy + 34}" text-anchor="middle" font-family="var(--f)" font-size="10" fill="${tokens.textL}">TSS</text>
      </svg>
    </div>
  `;
}

export function buildSportLegend(slices: SportSlice[], tokens: SportMixTokens): string {
  if (slices.length === 0) return '';
  let neutralIdx = 0;
  const rows = slices.map(slice => {
    const isRunning = slice.sport === 'running' || slice.sport === 'run';
    const fill = sliceFill(slice, neutralIdx, tokens.accent);
    if (!isRunning) neutralIdx += 1;
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-top:1px solid rgba(0,0,0,0.04);font-size:13px">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${fill};flex-shrink:0"></span>
          <span style="color:${tokens.textM};font-weight:500">${escapeText(slice.label)}</span>
        </div>
        <div style="display:flex;gap:14px;align-items:baseline;color:${tokens.textS};font-variant-numeric:tabular-nums">
          <span>${slice.sessionsPerWeek > 0 ? slice.sessionsPerWeek.toFixed(1).replace(/\.0$/, '') + '/wk' : '—'}</span>
          <span style="color:${tokens.textM};font-weight:500;min-width:42px;text-align:right">${slice.pct.toFixed(0)}%</span>
        </div>
      </div>
    `;
  });
  return `<div style="margin-top:8px">${rows.join('')}</div>`;
}
