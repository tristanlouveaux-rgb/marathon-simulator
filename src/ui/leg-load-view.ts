/**
 * Leg Fatigue detail page — localised mechanical fatigue from cross-training.
 *
 * Opens from the Leg Fatigue card on the Rolling Load view (permanent home) or
 * from the Readiness callout banner when the floor is active. Models the same
 * sky-gradient design language as recovery/sleep/readiness detail pages, with
 * a sage palette (muted green-grey) to evoke tissue recovery.
 *
 * Surfaces the `recentLegLoads` decay curve that drives the `legLoadNote` text
 * and (since 2026-04-15) the readiness hard floor.
 */

import { getState, saveState } from '@/state';
import {
  computeLegLoadBreakdown,
  LEG_LOAD_MODERATE,
  LEG_LOAD_HEAVY,
  type LegLoadEntryDecayed,
} from '@/calculations/readiness';
import { reconcileRecentLegLoads } from './sport-picker-modal';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';

// ── Design tokens ─────────────────────────────────────────────────────────────

const APP_BG = '#FAF9F6';
const TEXT_M = '#0F172A';
const TEXT_S = '#64748B';
const TEXT_L = '#94A3B8';
const RING_R = 46;
const RING_C = +(2 * Math.PI * RING_R).toFixed(2);

// Bronze palette — distinct from strain (red) and load ratio (amber)
const ZONE_FRESH    = '#22C55E'; // green when legs are fresh
const ZONE_MODERATE = '#F59E0B'; // amber at MODERATE threshold
const ZONE_HEAVY    = '#DC2626'; // deep red at HEAVY threshold

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusLabel(decayedPct: number): string {
  if (decayedPct >= 50) return 'still loading legs';
  if (decayedPct >= 10) return 'mostly cleared';
  return 'cleared';
}

function fmtRelative(timestampMs: number, nowMs: number): string {
  const hoursAgo = (nowMs - timestampMs) / 3_600_000;
  if (hoursAgo < 1)  return 'just now';
  if (hoursAgo < 12) return `${Math.round(hoursAgo)}h ago`;
  if (hoursAgo < 36) return 'yesterday';
  if (hoursAgo < 60) return '2 days ago';
  if (hoursAgo < 84) return '3 days ago';
  if (hoursAgo < 108) return '4 days ago';
  if (hoursAgo < 132) return '5 days ago';
  return `${Math.round(hoursAgo / 24)} days ago`;
}

function fmtClock(timestampMs: number): string {
  const d = new Date(timestampMs);
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

/** Convert decayed sum (0+, open-ended) to a 0-100 fill for the ring.
 * Piecewise linear so threshold zones occupy visually distinct arc segments:
 *   0 → 0%, MODERATE (20) → 30%, HEAVY (60) → 70%, extreme (120+) → 100%.
 * Keeps HEAVY visibly short of full so an extreme reload still reads as worse. */
function loadToRingPct(total: number): number {
  if (total <= 0) return 0;
  if (total <= LEG_LOAD_MODERATE) {
    return Math.round((total / LEG_LOAD_MODERATE) * 30);
  }
  if (total <= LEG_LOAD_HEAVY) {
    const frac = (total - LEG_LOAD_MODERATE) / (LEG_LOAD_HEAVY - LEG_LOAD_MODERATE);
    return Math.round(30 + frac * 40);
  }
  if (total <= LEG_LOAD_HEAVY * 2) {
    const frac = (total - LEG_LOAD_HEAVY) / LEG_LOAD_HEAVY;
    return Math.round(70 + frac * 30);
  }
  return 100;
}

function loadColor(total: number): string {
  if (total >= LEG_LOAD_HEAVY) return ZONE_HEAVY;
  if (total >= LEG_LOAD_MODERATE) return ZONE_MODERATE;
  return ZONE_FRESH;
}

function loadLabel(total: number): string {
  if (total >= LEG_LOAD_HEAVY) return 'Heavy';
  if (total >= LEG_LOAD_MODERATE) return 'Moderate';
  if (total > 0) return 'Light';
  return 'Fresh';
}

function loadHeadline(total: number): string {
  if (total >= LEG_LOAD_HEAVY)
    return 'Heavy eccentric and impact load is sitting on your legs. Force absorption is impaired and impact tissues take more strain. Skip pounding sessions until this clears.';
  if (total >= LEG_LOAD_MODERATE)
    return 'Moderate leg load from recent cross-training. Easy effort is fine. Avoid hard intervals or long impact sessions today.';
  if (total > 0)
    return 'Light residual leg load from recent activity. No effect on today\'s session.';
  return 'No recent cross-training has loaded your legs. Mechanical recovery is complete.';
}

// ── Decay curve SVG ───────────────────────────────────────────────────────────

/**
 * Canonical area chart (docs/UX_PATTERNS.md → Area Charts):
 * 7-day retrospective (solid fill + stroke) + 4-day decay projection (lighter
 * fill + dashed stroke). No dots, no inner <text>, no "Now" bar. Axis labels
 * are absolute-positioned spans injected around the SVG by the caller.
 */
function buildDecayCurve(entries: LegLoadEntryDecayed[], nowMs: number): string {
  if (entries.length === 0) {
    return `<div style="font-size:13px;color:${TEXT_S};text-align:center;padding:24px">No leg-loading sessions in the last 7 days.</div>`;
  }

  const W = 320, H = 120;
  const PAD_L = 4, PAD_R = 4, PAD_T = 8, PAD_B = 4;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const minH = -7 * 24;
  const maxH = 4 * 24;
  const totalH = maxH - minH;

  const samples: { hOffset: number; sum: number }[] = [];
  for (let h = minH; h <= maxH; h += 2) {
    let sum = 0;
    for (const e of entries) {
      const ageAtSampleH = (nowMs - e.timestampMs) / 3_600_000 + h;
      if (ageAtSampleH < 0) continue;
      const k = Math.LN2 / e.halfLifeH;
      sum += e.rawLoad * Math.exp(-k * ageAtSampleH);
    }
    samples.push({ hOffset: h, sum });
  }

  const maxY = Math.max(LEG_LOAD_HEAVY * 1.1, ...samples.map(s => s.sum));
  const x = (h: number) => PAD_L + ((h - minH) / totalH) * plotW;
  const y = (v: number) => PAD_T + plotH - (v / maxY) * plotH;
  const yBase = PAD_T + plotH;

  const pastPts = samples.filter(s => s.hOffset <= 0);
  const futPts  = samples.filter(s => s.hOffset >= 0);

  const lineD = (pts: typeof samples) =>
    pts.length === 0 ? ''
      : `M ${x(pts[0].hOffset).toFixed(1)} ${y(pts[0].sum).toFixed(1)} ` +
        pts.slice(1).map(p => `L ${x(p.hOffset).toFixed(1)} ${y(p.sum).toFixed(1)}`).join(' ');

  const areaD = (pts: typeof samples) => {
    if (pts.length === 0) return '';
    const first = pts[0], last = pts[pts.length - 1];
    return `M ${x(first.hOffset).toFixed(1)} ${yBase.toFixed(1)} ` +
      pts.map(p => `L ${x(p.hOffset).toFixed(1)} ${y(p.sum).toFixed(1)}`).join(' ') +
      ` L ${x(last.hOffset).toFixed(1)} ${yBase.toFixed(1)} Z`;
  };

  // Split marker (today) — thin dashed vertical, very muted (per UX_PATTERNS forecast pattern)
  const xNow = x(0).toFixed(1);

  return `
    <svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:120px;display:block">
      <path d="${areaD(pastPts)}" fill="${TEXT_M}" opacity="0.18"/>
      <path d="${areaD(futPts)}"  fill="${TEXT_M}" opacity="0.07"/>
      <path d="${lineD(pastPts)}" fill="none" stroke="${TEXT_M}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <path d="${lineD(futPts)}"  fill="none" stroke="${TEXT_M}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      <line x1="${xNow}" y1="${PAD_T}" x2="${xNow}" y2="${yBase.toFixed(1)}" stroke="rgba(0,0,0,0.10)" stroke-width="1" stroke-dasharray="2 3"/>
    </svg>
  `;
}

// ── Page HTML ─────────────────────────────────────────────────────────────────

function getLegLoadHTML(): string {
  const s = getState();
  const nowMs = Date.now();
  const breakdown = computeLegLoadBreakdown(s.recentLegLoads ?? [], nowMs);
  const total = breakdown.total;
  const ringPct = loadToRingPct(total);
  const ringCol = loadColor(total);
  const label = loadLabel(total);
  const headline = loadHeadline(total);

  // Ring math: 270° arc, fills clockwise. Standard pattern from readiness-view.
  const targetOffset = (RING_C * (1 - ringPct / 100)).toFixed(2);

  // Sort entries newest first for the contributors list
  const recentFirst = [...breakdown.entries].sort((a, b) => b.timestampMs - a.timestampMs);

  const card = (content: string, id?: string) =>
    `<div ${id ? `id="${id}"` : ''} style="background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);margin-bottom:12px">${content}</div>`;

  // ── Contributors card ──
  const contributorsCard = (() => {
    if (recentFirst.length === 0) {
      return card(`
        <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Recent Sessions</div>
        <div style="font-size:13px;color:${TEXT_S};line-height:1.45">No leg-loading cross-training in the last 7 days.</div>
      `);
    }
    const rows = recentFirst.map(e => {
      const rawPct = e.rawLoad > 0 ? Math.round((e.decayedLoad / e.rawLoad) * 100) : 0;
      const status = statusLabel(rawPct);
      return `
        <div style="padding:10px 0;border-top:1px solid #F1F5F9">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:2px">
            <div style="font-size:13px;font-weight:600;color:${TEXT_M}">${e.sportLabel}</div>
            <div style="font-size:11px;color:${TEXT_L}">${fmtRelative(e.timestampMs, nowMs)}</div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
            <div style="font-size:11px;color:${TEXT_S}">${fmtClock(e.timestampMs)}</div>
            <div style="font-size:11px;color:${TEXT_S}">${status}</div>
          </div>
        </div>
      `;
    }).join('');
    return card(`
      <div style="font-size:11px;color:${TEXT_S};margin-bottom:4px;font-weight:500">Recent Sessions</div>
      ${rows}
    `);
  })();

  // ── Decay curve card ──
  const hasChart = breakdown.entries.length > 0;
  const curveCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Decay Timeline</div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
      <div style="font-size:24px;font-weight:600;color:${ringCol};line-height:1">${total.toFixed(1)}</div>
      <div style="font-size:12px;color:${TEXT_S}">${recentFirst.length} session${recentFirst.length === 1 ? '' : 's'} · 7d</div>
    </div>
    <div style="position:relative">
      ${buildDecayCurve(breakdown.entries, nowMs)}
      ${hasChart ? `
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:9px;color:var(--c-faint,${TEXT_L})">
          <span>7d ago</span>
          <span>today</span>
          <span>+4d</span>
        </div>
      ` : ''}
    </div>
    ${hasChart ? `
      <div style="display:flex;gap:14px;margin-top:10px;font-size:11px;color:${TEXT_S}">
        <span><span style="display:inline-block;width:10px;height:2px;background:${TEXT_M};vertical-align:middle;margin-right:4px"></span>Past load</span>
        <span><span style="display:inline-block;width:10px;height:2px;background:${TEXT_M};opacity:0.5;vertical-align:middle;margin-right:4px"></span>Decay projection</span>
      </div>
    ` : ''}
  `);

  // ── Explainer card ──
  const explainerCard = card(`
    <div style="font-size:11px;color:${TEXT_S};margin-bottom:8px;font-weight:500">How it works</div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.55">
      <p style="margin:0 0 10px">Leg fatigue tracks localised mechanical load from cross-training. Activities load the legs at different rates: hiking and skiing are highest (eccentric quad damage), cycling and rowing are sustained but lower-impact, walking is minimal.</p>
      <p style="margin:0 0 10px">Each session decays with a 48h base half-life, scaled by sport. A subsequent session within 72h slows clearance by 1.3x per reload (capped at three).</p>
      <p style="margin:0 0 10px">Above ${LEG_LOAD_MODERATE}, readiness is capped at Manage Load. Above ${LEG_LOAD_HEAVY}, capped at Ease Back. Calibrated against EIMD recovery research (Clarkson and Hubal 2002, Paulsen 2012): functional force-absorption deficits last 72 to 96 hours after heavy eccentric loading and measurably increase impact-injury risk.</p>
      <p style="margin:0;color:${TEXT_L}">This signal is independent of TSB and HRV. Cardiovascular metrics rebound faster than tissue does.</p>
    </div>
  `);

  return `
    <style>
      #legload-view { box-sizing:border-box; }
      #legload-view *, #legload-view *::before, #legload-view *::after { box-sizing:inherit; }
      @keyframes llFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .ll-fade { opacity:0; animation:llFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('ll')}
    </style>

    <div id="legload-view" style="
      position:relative;min-height:100vh;background:${APP_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${buildSkyBackground('ll', 'sage')}

      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="legload-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="font-size:20px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em">Leg Fatigue</div>
          <div style="width:36px"></div>
        </div>

        <!-- Ring -->
        <div class="ll-fade" style="animation-delay:0.05s;display:flex;flex-direction:column;align-items:center;margin:12px 0 28px">
          <div style="
            position:relative;width:220px;height:220px;
            display:flex;align-items:center;justify-content:center;
            background:rgba(255,255,255,0.55);backdrop-filter:blur(16px);
            border-radius:50%;border:1px solid rgba(255,255,255,0.6);
            box-shadow:0 6px 40px -8px rgba(0,0,0,0.15);
          ">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="8"/>
              <circle id="legload-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="${ringCol}" stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_C}"
                stroke-dashoffset="${RING_C}"
                data-target-offset="${targetOffset}"
                style="transition:stroke-dashoffset 1.2s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
              />
            </svg>
            <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
              <div style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1;color:${ringCol}">${total.toFixed(0)}</div>
              <div style="font-size:12px;font-weight:600;color:${TEXT_M};margin-top:4px">${label}</div>
            </div>
          </div>
          <div style="font-size:13px;color:${TEXT_S};margin-top:16px;text-align:center;padding:0 32px;line-height:1.45">${headline}</div>
        </div>

        <!-- Cards -->
        <div class="ll-fade" style="animation-delay:0.18s;padding:0 16px">
          ${curveCard}
          ${contributorsCard}
          ${explainerCard}
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

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireHandlers(onBack: () => void): void {
  setTimeout(() => {
    const circle = document.getElementById('legload-ring-circle');
    const target = (circle as HTMLElement | null)?.dataset.targetOffset;
    if (circle && target) circle.style.strokeDashoffset = target;
  }, 50);

  wireTabBarHandlers(navigateTab);

  document.getElementById('legload-back-btn')?.addEventListener('click', () => onBack());
}

// ── Public entry point ────────────────────────────────────────────────────────

export function renderLegLoadView(onBack?: () => void): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  // Backfill missing recentLegLoads entries for auto-synced cross-training activities
  // (the review flow pushes them, but silent auto-match at sync time doesn't).
  if (reconcileRecentLegLoads()) saveState();
  container.innerHTML = getLegLoadHTML();
  const back = onBack ?? (() => import('./readiness-view').then(({ renderReadinessView }) => renderReadinessView()));
  wireHandlers(back);
}
