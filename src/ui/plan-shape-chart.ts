import type { SimulatorState } from '@/types';
import {
  derivePlanShape,
  deriveDisciplineLoad,
  type PlanShape,
  type DiscShape,
  type PhaseSegment,
} from '@/calculations/plan-shape';

/**
 * Stats "training load across your plan" card.
 *
 * The same plan-shape visual the onboarding coach-contract step shows, brought
 * to the Stats page so a mid-plan user can see their whole load arc and where
 * they are in it. Numbers come from the canonical derivers in
 * `@/calculations/plan-shape` (`derivePlanShape` for running, `deriveDisciplineLoad`
 * for tri/HYROX), so the Stats arc and the onboarding arc can never diverge.
 *
 * The one thing onboarding does NOT have is the "you are here" marker: on Stats
 * the user is mid-plan, so we draw a current-week rule + a true-circle dot on the
 * running curve + a "Now · wk X" pill. The pill mirrors the top "Peak · wk X"
 * pill and sits at the BOTTOM of the chart, so the two pills occupy disjoint
 * vertical zones and can never overlap (the dot stays in the safe mid-band).
 *
 * Renders nothing (returns '') when there is no drawable phased plan — just-track
 * mode and any state with fewer than two plan weeks fall out here.
 */

/* ── palette (mirrors coach-contract.ts; presentation-only) ─────────────────── */
const LOAD_LINE = '#4A7FA5';                 // single calm blue — the running load curve
const LOAD_FILL = 'rgba(74,127,165,0.13)';   // its soft fill
const DISC_SOLID: Record<string, string> = { swim: '#38BDF8', bike: '#E05A4E', run: '#14B8A6', brick: '#E0883E', station: '#E0883E' };
const DISC_FILL: Record<string, string> = {
  swim: 'rgba(56,189,248,0.88)',
  bike: 'rgba(224,90,78,0.88)',
  run: 'rgba(20,184,166,0.88)',
  brick: 'rgba(224,136,62,0.88)',
  station: 'rgba(224,136,62,0.88)',
};
const PHASE_LABEL: Record<string, string> = { base: 'Base', build: 'Build', peak: 'Peak', taper: 'Taper' };

const CHART_PX = 128; // chart body height; viewBox 0..100 maps onto this

/** Scoped CSS for the card. Injected once per card render (one card per page). */
const PSC_CSS = `
  .psc-card .psc-h { font-size:13px; font-weight:600; color:var(--c-black); margin:0 0 2px; }
  .psc-card .psc-sub { font-size:10px; color:var(--c-faint); margin:0 0 12px; }
  .psc-card .psc-p { font-size:12.5px; color:var(--c-muted); line-height:1.55; margin:12px 0 0; }
  .psc-card .psc-p strong { color:var(--c-black); font-weight:600; }
  .psc-card .psc-arc { width:100%; height:${CHART_PX}px; display:block; }
  .psc-card .psc-axis { position:relative; height:15px; margin-top:7px; }
  .psc-card .psc-axis > span { position:absolute; transform:translateX(-50%); font-size:10.5px; color:var(--c-faint); white-space:nowrap; }
  .psc-card .psc-legend { display:flex; flex-wrap:wrap; gap:14px; margin-top:12px; }
  .psc-card .psc-legend span.k { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; color:var(--c-muted); }
  .psc-card .psc-legend span.sw { width:9px; height:9px; border-radius:2px; flex:0 0 auto; }
  .psc-card .psc-pill { position:absolute; transform:translateX(-50%); font-size:10px; font-weight:600; color:var(--c-black); background:#fff; border:1px solid var(--c-border); padding:1px 7px; border-radius:100px; white-space:nowrap; box-shadow:0 1px 2px rgba(0,0,0,0.06); }
  .psc-card .psc-now-rule { position:absolute; top:0; bottom:0; width:1.5px; background:${LOAD_LINE}; opacity:0.4; }
  .psc-card .psc-now-dot { position:absolute; width:11px; height:11px; border-radius:50%; background:${LOAD_LINE}; border:2px solid #fff; box-shadow:0 1px 2px rgba(0,0,0,0.2); transform:translate(-50%,-50%); }
`;

/* ── phase axis: faint dividers + a label centred under each phase segment ───── */
function phaseAxis(phases: PhaseSegment[]): { dividers: string; labels: string } {
  const totalW = phases.reduce((a, p) => a + p.weeks, 0) || 1;
  let cum = 0;
  const dividers: string[] = [];
  const labels: string[] = [];
  for (let k = 0; k < phases.length; k++) {
    const seg = phases[k];
    const startFrac = cum / totalW;
    cum += seg.weeks;
    const endFrac = cum / totalW;
    const midPct = ((startFrac + endFrac) / 2) * 100;
    labels.push(`<span style="left:${midPct.toFixed(1)}%">${PHASE_LABEL[seg.ph] ?? seg.ph}</span>`);
    if (k < phases.length - 1) {
      dividers.push(`<div style="position:absolute;left:${(endFrac * 100).toFixed(1)}%;top:0;bottom:0;width:1px;background:var(--c-border)"></div>`);
    }
  }
  return { dividers: dividers.join(''), labels: labels.join('') };
}

/** Edge-aware horizontal anchoring for a bottom pill so it stays attached to its
 *  rule line yet never clips the chart edge. */
function pillAnchor(xPct: number): string {
  if (xPct < 15) return 'left:0;transform:none';
  if (xPct > 85) return 'right:0;transform:none';
  return `left:${xPct.toFixed(1)}%;transform:translateX(-50%)`;
}

/** Current-week index within the plan, or null when there's nothing to mark. */
function currentWeekIdx(s: SimulatorState, n: number): number | null {
  const w = s.w;
  if (typeof w !== 'number' || n < 2) return null;
  if (w < 1 || w > n) return null; // pre-start / plan complete → no "now" marker
  return Math.min(n - 1, Math.max(0, w - 1));
}

/* ════════════════════════════════════════════════════════════════════════════
 *  RUNNING — single-accent load line + you-are-here dot.
 * ════════════════════════════════════════════════════════════════════════════ */
function renderRunningCard(s: SimulatorState, shape: PlanShape): string {
  const series = shape.weeklyTss;
  const n = series.length;
  const peak = shape.peakTss || 1;
  const PAD_TOP = 18; // top headroom so the peak clears the pill
  const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
  const y = (v: number) => PAD_TOP + (1 - v / peak) * (100 - PAD_TOP);

  const linePts = series.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const areaPts = `0,100 ${linePts} 100,100`;

  const peakIdx = series.indexOf(peak);
  const peakX = Math.min(82, Math.max(16, x(peakIdx)));
  const peakWk = peakIdx + 1;
  const lastTss = series[n - 1] || 0;
  const taperPct = Math.max(0, Math.round((1 - lastTss / peak) * 100));

  // You-are-here marker. Rule (full height) + true-circle dot on the curve. The
  // dot sits at the week's value, which for any realistic current week lands in
  // the safe mid-band — never in the top pill zone nor the bottom pill zone.
  const nowIdx = currentWeekIdx(s, n);
  let nowMarker = '';
  let nowPill = '';
  if (nowIdx != null) {
    const nx = x(nowIdx);
    const dotTopPx = (y(series[nowIdx]) / 100) * CHART_PX;
    nowMarker = `
      <div class="psc-now-rule" style="left:${nx.toFixed(2)}%"></div>
      <div class="psc-now-dot" style="left:${nx.toFixed(2)}%;top:${dotTopPx.toFixed(1)}px"></div>`;
    nowPill = `<div class="psc-pill" style="bottom:6px;${pillAnchor(nx)}">Now · wk ${nowIdx + 1}</div>`;
  }

  const axis = phaseAxis(shape.phases);
  const chart = `
    <div style="position:relative">
      <div style="position:relative;height:${CHART_PX}px">
        <svg class="psc-arc" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points="${areaPts}" fill="${LOAD_FILL}" />
          <polyline points="${linePts}" fill="none" stroke="${LOAD_LINE}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        </svg>
        ${axis.dividers}
        <div class="psc-pill" style="top:0;left:${peakX.toFixed(1)}%">Peak · wk ${peakWk}</div>
        ${nowMarker}
        ${nowPill}
      </div>
      <div class="psc-axis">${axis.labels}</div>
    </div>`;

  const noEvent = !!s.continuousMode;
  const caption = noEvent
    ? `Your weekly training load. It cycles up and down on purpose, with a lighter recovery week built into every block. About <strong>${shape.totalKm} km</strong> of running in all, peaking near <strong>${shape.peakKm} km</strong> in your biggest week.`
    : `Your weekly training load across ${shape.weeks} weeks. It builds to a peak around week ${peakWk}, eases off in a recovery week each block, then sheds about <strong>${taperPct}%</strong> in the taper. About <strong>${shape.totalKm} km</strong> in all, peaking near <strong>${shape.peakKm} km</strong>.`;

  return cardShell(`
    <p class="psc-h">Training load across your plan</p>
    <p class="psc-sub">Prescribed weekly load · canonical TSS</p>
    ${chart}
    <p class="psc-p">${caption}</p>
  `);
}

/* ════════════════════════════════════════════════════════════════════════════
 *  TRIATHLON / HYROX — stacked-by-discipline load ramp + you-are-here rule.
 * ════════════════════════════════════════════════════════════════════════════ */
function smoothPath(P: Array<{ x: number; y: number }>): string {
  if (P.length === 0) return '';
  if (P.length < 3) return `M ${P.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')}`;
  let d = `M ${P[0].x.toFixed(2)} ${P[0].y.toFixed(2)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2] || P[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function renderDisciplineCard(
  s: SimulatorState,
  shape: DiscShape,
  opts: { order: string[]; legend: { key: string; label: string }[]; caption: string },
): string {
  const n = shape.perWeek.length;
  if (n < 2 || shape.peak <= 0) return '';
  const peak = shape.peak;
  const PAD_TOP = 16;
  const x = (i: number) => (i / (n - 1)) * 100;
  const yOf = (v: number) => 100 - PAD_TOP - (v / peak) * (100 - PAD_TOP);

  const cum = new Array(n).fill(0);
  const bands: string[] = [];
  const seps: string[] = [];
  for (const g of opts.order) {
    const upper: Array<{ x: number; y: number }> = [];
    const lower: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < n; i++) {
      const below = cum[i];
      const top = below + (shape.perWeek[i].loads[g] ?? 0);
      upper.push({ x: x(i), y: yOf(top) });
      lower.push({ x: x(i), y: yOf(below) });
      cum[i] = top;
    }
    const upperD = smoothPath(upper);
    const lowerD = 'L' + smoothPath([...lower].reverse()).slice(1);
    bands.push(`<path d="${upperD} ${lowerD} Z" fill="${DISC_FILL[g] ?? 'rgba(0,0,0,0.2)'}" />`);
    seps.push(`<path d="${upperD}" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="1" vector-effect="non-scaling-stroke" />`);
  }

  // You-are-here: rule + bottom pill only (a stacked area has no single line to
  // pin a dot to, so a dot would read as ambiguous).
  const nowIdx = currentWeekIdx(s, n);
  let nowMarker = '';
  let nowPill = '';
  if (nowIdx != null) {
    const nx = x(nowIdx);
    nowMarker = `<div class="psc-now-rule" style="left:${nx.toFixed(2)}%"></div>`;
    nowPill = `<div class="psc-pill" style="bottom:6px;${pillAnchor(nx)}">Now · wk ${nowIdx + 1}</div>`;
  }

  const axis = phaseAxis(shape.phases);
  const chart = `
    <div style="position:relative">
      <div style="position:relative;height:${CHART_PX}px">
        <svg class="psc-arc" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${bands.join('')}${seps.join('')}</svg>
        ${axis.dividers}
        ${nowMarker}
        ${nowPill}
      </div>
      <div class="psc-axis">${axis.labels}</div>
    </div>`;

  const legend = opts.legend
    .map((l) => `<span class="k"><span class="sw" style="background:${DISC_SOLID[l.key] ?? '#888'}"></span>${l.label}</span>`)
    .join('');

  const totals = shape.perWeek.map((d) => Object.values(d.loads).reduce((a, b) => a + b, 0));
  const peakHours = Math.round((shape.perWeek[totals.indexOf(Math.max(...totals))].mins / 60) * 10) / 10;
  const caption = peakHours > 0 ? `${opts.caption} It peaks at about <strong>${peakHours} hours</strong> a week.` : opts.caption;

  return cardShell(`
    <p class="psc-h">Training load across your plan</p>
    <p class="psc-sub">Prescribed weekly load by discipline · canonical TSS</p>
    ${chart}
    <div class="psc-legend">${legend}</div>
    <p class="psc-p">${caption}</p>
  `);
}

function renderTriCard(s: SimulatorState): string {
  const shape = deriveDisciplineLoad(
    s,
    (d) => (d === 'swim' || d === 'bike' || d === 'run' || d === 'brick') ? d : null,
    ['swim', 'bike', 'run', 'brick'],
  );
  const hasBrick = shape.perWeek.some((w) => (w.loads.brick ?? 0) > 0);
  return renderDisciplineCard(s, shape, {
    order: hasBrick ? ['bike', 'run', 'brick', 'swim'] : ['bike', 'run', 'swim'],
    legend: [
      { key: 'swim', label: 'Swim' },
      { key: 'bike', label: 'Bike' },
      { key: 'run', label: 'Run' },
      ...(hasBrick ? [{ key: 'brick', label: 'Brick' }] : []),
    ],
    caption: hasBrick
      ? 'Your weekly load across swim, bike, run and brick sessions. It ramps through build into your peak weeks, then tapers for race day.'
      : 'Your weekly load across swim, bike and run. It ramps through build into your peak weeks, then tapers for race day.',
  });
}

function renderHyroxCard(s: SimulatorState): string {
  const shape = deriveDisciplineLoad(
    s,
    (d) => d === 'run' ? 'run' : (d === 'station' || d === 'brick') ? 'station' : null,
    ['run', 'station'],
  );
  return renderDisciplineCard(s, shape, {
    order: ['run', 'station'],
    legend: [
      { key: 'run', label: 'Running' },
      { key: 'station', label: 'Stations' },
    ],
    caption: 'Your weekly load across running and station work. It ramps through build into your peak weeks, then tapers for race day.',
  });
}

function cardShell(inner: string): string {
  return `<div class="m-card psc-card" style="padding:16px;margin-bottom:10px"><style>${PSC_CSS}</style>${inner}</div>`;
}

/**
 * The Stats "training load across your plan" card for the active mode, or '' when
 * there's no phased plan to draw. Mode is read from `s.eventType` so a single
 * call works from every per-mode stats view.
 */
export function renderPlanShapeCard(s: SimulatorState): string {
  try {
    if (s.eventType === 'triathlon') return renderTriCard(s);
    if (s.eventType === 'hyrox') return renderHyroxCard(s);
    const shape = derivePlanShape(s);
    if (shape.weeks < 2 || shape.peakTss <= 0) return '';
    return renderRunningCard(s, shape);
  } catch (e) {
    console.warn('[PlanShapeCard] derivation failed, hiding card:', e);
    return '';
  }
}
