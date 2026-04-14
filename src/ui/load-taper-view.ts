/**
 * Load & Taper detail page.
 * Accessible from the Week Load (TSS) row in both the plan header and home view.
 * Warm earth hero with rolling plains background.
 * Integrates the weekly load breakdown (previously a separate sheet overlay).
 */

import { getState } from '@/state';
import { computeWeekRawTSS, computePlannedSignalB, computeDecayedCarry } from '@/calculations/fitness-model';
import { computeLoadBreakdown, breakdownShade, type LoadSegment } from './home-view';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';

// ── Design tokens ─────────────────────────────────────────────────────────────

const PAGE_BG  = '#FAF9F6';
const TEXT_M   = '#0F172A';
const TEXT_S   = '#64748B';
const TEXT_L   = '#94A3B8';

const CARD = `background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)`;

const RING_R    = 46;
const RING_CIRC = +(2 * Math.PI * RING_R).toFixed(2);

// ── Phase config ────────────────────────────────────────────────────────────

const PHASE_COLORS: Record<string, { accent: string; pillBg: string }> = {
  base:  { accent: '#2563EB', pillBg: 'rgba(59,130,246,0.10)' },
  build: { accent: '#EA580C', pillBg: 'rgba(249,115,22,0.10)' },
  peak:  { accent: '#DC2626', pillBg: 'rgba(239,68,68,0.10)' },
  taper: { accent: '#16A34A', pillBg: 'rgba(34,197,94,0.10)' },
};

// ── Phase content ───────────────────────────────────────────────────────────

interface PhaseInfo {
  label: string;
  body: string;
}

const PHASE_INFO: Record<string, PhaseInfo> = {
  base: {
    label: 'Base',
    body: 'Aerobic development at easy effort. High proportion of Zone 2 running. Load is moderate and consistent. The aim is to raise the aerobic ceiling before intensity is introduced.',
  },
  build: {
    label: 'Build',
    body: 'Quality sessions are introduced: tempo runs, cruise intervals, marathon-pace work. Weekly TSS rises 5 to 10%. A recovery week is scheduled every third or fourth week to allow adaptation.',
  },
  peak: {
    label: 'Peak',
    body: 'The highest-load weeks of the plan. Longest long run, most volume, most stress. Two to three weeks here before load drops into taper.',
  },
  taper: {
    label: 'Taper',
    body: 'Volume drops 30 to 50% while intensity is maintained. The goal is to clear accumulated fatigue before race day. Fitness does not decline over a 2 to 3 week taper. It consolidates.',
  },
};

// ── Hero background (slate watercolour) ─────────────────────────────────────

function heroBackground(): string { return buildSkyBackground('ltp', 'slate'); }

// ── Date helpers ─────────────────────────────────────────────────────────────

function weekRangeFmt(planStartDate: string | undefined, weekNum: number): string {
  if (!planStartDate) return '';
  const start = new Date(planStartDate);
  start.setDate(start.getDate() + (weekNum - 1) * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  return `${start.toLocaleDateString('en-GB', opts)} \u2013 ${end.toLocaleDateString('en-GB', opts)}`;
}

// ── Breakdown card (integrated from the old sheet overlay) ──────────────────

function buildBreakdownCard(
  segments: LoadSegment[],
  tssActual: number,
  tssPlan: number,
  tssCarry: number,
  runningTSSPlan: number,
  crossTrainingBudget: number,
): string {
  const barDenom = Math.max(tssActual, tssPlan, 1);
  const barScale = tssActual >= tssPlan ? 100 / tssActual : 100 / tssPlan;

  const shaded = segments.map((seg, i) => ({ ...seg, color: breakdownShade(i) }));

  // Include carry in the stacked bar as an orange segment
  const carryBarSeg = tssCarry > 0
    ? `<div style="height:100%;width:${(tssCarry * barScale).toFixed(1)}%;background:var(--c-caution);flex-shrink:0"></div>`
    : '';

  const stackedBar = tssActual > 0
    ? shaded.map(seg => {
      const pct = seg.tss * barScale;
      return `<div style="height:100%;width:${pct.toFixed(1)}%;background:${seg.color};flex-shrink:0"></div>`;
    }).join('') + carryBarSeg
    : `<div style="height:100%;width:4%;background:rgba(0,0,0,0.08);flex-shrink:0;border-radius:3px"></div>`;

  const remaining = Math.max(0, Math.round(tssPlan) - tssActual);
  const remainingPct = remaining > 5 ? remaining * barScale : 0;
  const remainingBar = remaining > 5
    ? `<div style="height:100%;width:${remainingPct.toFixed(1)}%;background:rgba(0,0,0,0.06);flex-shrink:0;border-radius:0 3px 3px 0"></div>`
    : '';

  // Legend: compact inline dots — include carry if present
  const carryLegend = tssCarry > 0
    ? `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:${TEXT_S}"><div style="width:7px;height:7px;border-radius:50%;background:var(--c-caution);flex-shrink:0"></div>Carried</div>`
    : '';
  const legend = shaded.length > 0 || tssCarry > 0
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:8px">
        ${shaded.map(seg => `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:${TEXT_S}"><div style="width:7px;height:7px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>${seg.label}</div>`).join('')}
        ${carryLegend}
        ${remaining > 5 ? `<div style="display:flex;align-items:center;gap:4px;font-size:11px;color:${TEXT_L}"><div style="width:7px;height:7px;border-radius:3px;background:rgba(0,0,0,0.06);flex-shrink:0"></div>Remaining</div>` : ''}
      </div>`
    : '';

  // Sport rows
  const sportRows = shaded.map(seg => {
    const barWidth = tssActual > 0 ? Math.min(100, Math.round((seg.tss / tssActual) * 100)) : 0;
    const dur = seg.durationMin >= 60
      ? `${Math.floor(seg.durationMin / 60)}h ${Math.round(seg.durationMin % 60)}m`
      : `${Math.round(seg.durationMin)}m`;
    return `
      <div style="display:flex;flex-direction:column;gap:5px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:10px;height:10px;border-radius:50%;background:${seg.color};flex-shrink:0"></div>
            <span style="font-size:14px;color:${TEXT_M}">${seg.label}</span>
            <span style="font-size:12px;color:${TEXT_L}">${dur}</span>
          </div>
          <span style="font-size:14px;font-weight:600;color:${TEXT_M};font-variant-numeric:tabular-nums">${Math.round(seg.tss)}</span>
        </div>
        <div style="background:rgba(0,0,0,0.04);border-radius:3px;height:4px;overflow:hidden">
          <div style="background:${seg.color};height:100%;width:${barWidth}%;border-radius:3px"></div>
        </div>
      </div>`;
  }).join('');

  const emptyState = segments.length === 0
    ? `<p style="color:${TEXT_L};font-size:14px;text-align:center;padding:20px 0">No activities logged yet this week</p>`
    : '';

  // Carry row
  const carryRow = tssCarry > 0 ? (() => {
    const carryBarWidth = tssActual > 0 ? Math.min(100, Math.round((tssCarry / tssActual) * 100)) : 0;
    return `
      <div style="display:flex;flex-direction:column;gap:5px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:10px;height:10px;border-radius:50%;background:var(--c-caution);flex-shrink:0"></div>
            <span style="font-size:14px;color:${TEXT_M}">Carried from last week</span>
          </div>
          <span style="font-size:14px;font-weight:600;color:${TEXT_M};font-variant-numeric:tabular-nums">${tssCarry}</span>
        </div>
        <div style="background:rgba(0,0,0,0.04);border-radius:3px;height:4px;overflow:hidden">
          <div style="background:var(--c-caution);height:100%;width:${carryBarWidth}%;border-radius:3px"></div>
        </div>
      </div>`;
  })() : '';

  // Target footer
  const targetFooter = `
    <div style="background:${PAGE_BG};border-radius:10px;padding:10px 14px;display:flex;flex-direction:column;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:${TEXT_S}">Running planned</span>
        <span style="font-size:13px;font-weight:500;color:${TEXT_M};font-variant-numeric:tabular-nums">${runningTSSPlan} TSS</span>
      </div>
      ${crossTrainingBudget > 0 ? `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:${TEXT_S}">Cross-training expected</span>
        <span style="font-size:13px;font-weight:500;color:${TEXT_M};font-variant-numeric:tabular-nums">${crossTrainingBudget} TSS</span>
      </div>` : ''}
      <div style="height:1px;background:rgba(0,0,0,0.06)"></div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;font-weight:600;color:${TEXT_M}">Total target</span>
        <span style="font-size:13px;font-weight:600;color:${TEXT_M};font-variant-numeric:tabular-nums">${Math.round(tssPlan)} TSS</span>
      </div>
    </div>`;

  return `
    <div style="${CARD};padding:20px;display:flex;flex-direction:column;gap:16px">
      <div>
        <div style="font-size:12px;color:${TEXT_S};margin-bottom:2px">All sports · running + cross-training</div>
      </div>

      <!-- Stacked bar -->
      <div>
        <div style="background:rgba(0,0,0,0.04);border-radius:4px;height:10px;overflow:hidden;display:flex">
          ${stackedBar}
          ${remainingBar}
        </div>
        ${legend}
      </div>

      ${segments.length > 0 ? '<div style="height:1px;background:rgba(0,0,0,0.05)"></div>' : ''}

      <!-- Sport rows -->
      <div style="display:flex;flex-direction:column;gap:12px">
        ${sportRows}
        ${emptyState}
      </div>

      ${carryRow ? `${carryRow}` : ''}

      ${targetFooter}
    </div>`;
}

// ── TSS explainer card ──────────────────────────────────────────────────────

function buildTssExplainer(): string {
  const ranges = [
    { range: 'Under 150', desc: 'Recovery or base maintenance' },
    { range: '150\u2013350', desc: 'Productive training for most runners' },
    { range: '350\u2013500', desc: 'High load. Recovery needs careful management' },
    { range: '500+',         desc: 'Elite volume. Injury risk rises if sustained' },
  ];

  const rows = ranges.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.05)">
      <span style="font-size:13px;font-weight:600;color:${TEXT_M};min-width:80px;font-variant-numeric:tabular-nums">${r.range}</span>
      <span style="font-size:12px;color:${TEXT_S};text-align:right">${r.desc}</span>
    </div>`).join('');

  return `
    <div style="${CARD};padding:20px">
      <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:4px">Training Stress Score</div>
      <p style="font-size:13px;color:${TEXT_S};line-height:1.6;margin:0 0 14px">
        TSS combines duration and intensity into a single weekly number.
        A 45-min easy run scores around 40. A 90-min long run at marathon pace is closer to 120.
      </p>
      <div>${rows}</div>
    </div>`;
}

// ── Carry-through card ──────────────────────────────────────────────────────

function buildCarryThroughCard(currentCarry: number): string {
  const carryNote = currentCarry > 0
    ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.05);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--c-caution)">Carried into this week</span>
        <span style="font-size:13px;font-weight:600;color:var(--c-caution);font-variant-numeric:tabular-nums">${currentCarry} TSS</span>
      </div>`
    : '';
  return `
    <div style="${CARD};padding:20px;display:flex;flex-direction:column;gap:10px">
      <div style="font-size:15px;font-weight:700;color:${TEXT_M}">Carry-through</div>
      <p style="font-size:13px;color:${TEXT_S};line-height:1.6;margin:0">
        Training load does not reset at week boundaries. Excess from one week creates residual fatigue that decays into the next.
      </p>
      <p style="font-size:13px;color:${TEXT_S};line-height:1.6;margin:0">
        The decay follows a 7-day time constant and updates daily. On Monday after a heavy week, roughly 61% of the excess remains. By Thursday, 40%. By the following Sunday, 22%. The carried load decreases through the week as the body recovers. This week's own activities are unaffected.
      </p>
      <p style="font-size:13px;color:${TEXT_S};line-height:1.6;margin:0">
        If last week exceeded its target by 100 TSS, Monday's effective load includes approximately 61 TSS of residual fatigue. By Friday that drops to around 35 TSS. This is when plan adjustments matter most: early in the week, when residual fatigue is highest.
      </p>
      ${carryNote}
    </div>`;
}

// ── Phase cards ─────────────────────────────────────────────────────────────

function buildPhaseCards(currentPh: string): string {
  const phases = ['base', 'build', 'peak', 'taper'];
  return `
    <div style="${CARD};overflow:hidden">
      ${phases.map((ph, i) => {
        const info = PHASE_INFO[ph];
        const c = PHASE_COLORS[ph] ?? { accent: TEXT_S, pillBg: 'rgba(0,0,0,0.06)' };
        const isCurrent = ph === currentPh;
        const border = i < phases.length - 1 ? 'border-bottom:1px solid rgba(0,0,0,0.05);' : '';
        return `
          <div style="padding:14px 18px;${border}${isCurrent ? `border-left:3px solid ${c.accent};` : 'border-left:3px solid transparent;'}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
              <span style="font-size:12px;font-weight:700;color:${c.accent}">${info.label}</span>
              ${isCurrent ? `<span style="font-size:10px;font-weight:600;color:${c.accent};opacity:0.7">current</span>` : ''}
            </div>
            <p style="font-size:12px;color:${TEXT_S};line-height:1.6;margin:0">${info.body}</p>
          </div>`;
      }).join('')}
    </div>`;
}

// ── Taper section card ──────────────────────────────────────────────────────

function buildTaperCard(): string {
  return `
    <div style="${CARD};padding:20px;display:flex;flex-direction:column;gap:10px">
      <div style="font-size:15px;font-weight:700;color:${TEXT_M}">Why taper works</div>
      <p style="font-size:13px;color:${TEXT_S};line-height:1.6;margin:0">
        Training creates fatigue that sits on top of fitness. During taper, fatigue clears while fitness remains elevated.
        Glycogen stores top up, soft tissue repairs, and the nervous system recovers.
      </p>
      <p style="font-size:13px;color:${TEXT_S};line-height:1.6;margin:0">
        Most recreational runners perform 2 to 3% faster after a proper 2 to 3 week taper versus maintaining full load into race week.
        The restlessness during taper is normal. Resist adding sessions.
      </p>
    </div>`;
}

// ── Main render ─────────────────────────────────────────────────────────────

export function renderLoadTaperView(viewWeek?: number, returnTo: 'plan' | 'home' = 'plan'): void {
  const container = document.getElementById('app-root');
  if (!container) return;

  const s = getState();
  const weekNum = viewWeek ?? s.w;
  const wk = s.wks?.[weekNum - 1];
  const ph = wk?.ph ?? 'base';

  const tssRaw = wk ? Math.round(computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate)) : 0;
  const tssPlan = Math.round(computePlannedSignalB(
    s.historicWeeklyTSS,
    s.ctlBaseline,
    ph,
    s.athleteTierOverride ?? s.athleteTier,
    s.rw,
    undefined,
    undefined,
    s.sportBaselineByType,
  ));

  const tssCarry = computeDecayedCarry(s.wks ?? [], weekNum, tssPlan, s.planStartDate);
  const tssActual = tssRaw + tssCarry;

  const barPct = tssPlan > 0 ? Math.round((tssActual / tssPlan) * 100) : 0;
  const dateRange = weekRangeFmt(s.planStartDate, weekNum);
  const hasRace = !!s.selectedMarathon;
  const weeksToRace = s.tw - weekNum;

  // Ring
  const ringPct = Math.min(barPct, 100);
  const ringOffset = +(RING_CIRC * (1 - ringPct / 100)).toFixed(2);
  const ringColor = barPct >= 100 ? '#34C759' : barPct >= 70 ? '#E8924C' : TEXT_L;

  // Phase badge
  const phaseC = PHASE_COLORS[ph] ?? { accent: TEXT_S, pillBg: 'rgba(0,0,0,0.06)' };

  // Breakdown data
  const segments = wk ? computeLoadBreakdown(wk, wk.rated ?? {}, s.planStartDate) : [];
  let crossTrainingBudget = 0;
  if (s.sportBaselineByType) {
    for (const sport of Object.values(s.sportBaselineByType)) {
      crossTrainingBudget += sport.avgSessionRawTSS * sport.sessionsPerWeek;
    }
  }
  crossTrainingBudget = Math.round(crossTrainingBudget);
  const runningTSSPlan = Math.max(0, tssPlan - crossTrainingBudget);

  container.innerHTML = `
    <style>
      #ltp-view { box-sizing:border-box; }
      #ltp-view *, #ltp-view *::before, #ltp-view *::after { box-sizing:inherit; }
      @keyframes ltpFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .ltp-fade { opacity:0; animation:ltpFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('ltp')}
    </style>

    <div id="ltp-view" style="
      position:relative;min-height:100vh;background:${PAGE_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${heroBackground()}

      <div style="position:relative;z-index:10;padding-bottom:48px;max-width:480px;margin:0 auto">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="ltp-back" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div style="text-align:center">
            <div style="font-size:20px;font-weight:700;color:${TEXT_M}">Load &amp; Taper</div>
            ${dateRange ? `<div style="font-size:12px;color:${TEXT_S};margin-top:3px;font-weight:500">Week ${weekNum} of ${s.tw} \u00b7 ${dateRange}</div>` : `<div style="font-size:12px;color:${TEXT_S};margin-top:3px;font-weight:500">Week ${weekNum} of ${s.tw}</div>`}
          </div>

          <div style="width:36px"></div>
        </div>

        <!-- Ring -->
        <div class="ltp-fade" style="animation-delay:0.08s;display:flex;justify-content:center;margin:12px 0 28px">
          <div style="
            position:relative;width:220px;height:220px;
            display:flex;align-items:center;justify-content:center;
          ">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="ltpRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="#E8924C"/>
                  <stop offset="100%" stop-color="#D97706"/>
                </linearGradient>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="rgba(255,255,255,0.85)" stroke="rgba(241,245,249,0.5)" stroke-width="8"/>
              <circle id="ltp-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="${ringColor === '#34C759' ? ringColor : ringColor === TEXT_L ? ringColor : 'url(#ltpRingGrad)'}"
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
              <div style="display:flex;align-items:baseline;color:${TEXT_M};font-weight:700">
                <span style="font-size:48px;letter-spacing:-0.03em;line-height:1;font-weight:700">${tssActual}</span>
                <span style="font-size:14px;margin-left:3px;font-weight:400;color:${TEXT_S}">TSS</span>
              </div>
              <span style="color:${TEXT_S};font-size:12px;font-weight:500;margin-top:4px">${barPct}% of target</span>
              <span style="color:${TEXT_L};font-size:11px;margin-top:2px">Target: ${tssPlan} TSS${hasRace && weeksToRace > 0 ? ` \u00b7 ${weeksToRace}w to race` : ''}</span>
            </div>
          </div>
        </div>

        <!-- Phase heading -->
        <div class="ltp-fade" style="animation-delay:0.11s;text-align:center;margin-bottom:20px">
          <div style="font-size:16px;font-weight:600;color:${phaseC.accent};letter-spacing:-0.01em">${(PHASE_INFO[ph]?.label ?? ph).charAt(0).toUpperCase() + (PHASE_INFO[ph]?.label ?? ph).slice(1)} Phase</div>
        </div>

        <!-- Weekly breakdown card (integrated from old sheet) -->
        <div class="ltp-fade" style="animation-delay:0.14s;padding:0 16px;margin-bottom:14px">
          ${buildBreakdownCard(segments, tssActual, tssPlan, tssCarry, runningTSSPlan, crossTrainingBudget)}
        </div>

        <!-- TSS explainer -->
        <div class="ltp-fade" style="animation-delay:0.20s;padding:0 16px;margin-bottom:14px">
          ${buildTssExplainer()}
        </div>

        <!-- Carry-through -->
        <div class="ltp-fade" style="animation-delay:0.26s;padding:0 16px;margin-bottom:14px">
          ${buildCarryThroughCard(tssCarry)}
        </div>

        <!-- Plan structure label -->
        <div class="ltp-fade" style="animation-delay:0.30s;padding:0 20px;margin-bottom:8px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:${TEXT_S}">Plan structure</div>
        </div>

        <!-- Phase cards -->
        <div class="ltp-fade" style="animation-delay:0.32s;padding:0 16px;margin-bottom:14px">
          ${buildPhaseCards(ph)}
        </div>

        <!-- Taper explainer -->
        <div class="ltp-fade" style="animation-delay:0.38s;padding:0 16px;margin-bottom:24px">
          ${buildTaperCard()}
        </div>

      </div>
    </div>
    ${renderTabBar('home')}
  `;

  // Wire handlers
  wireTabBarHandlers(navigateTab);

  // Animate ring
  setTimeout(() => {
    const circle = document.getElementById('ltp-ring-circle') as SVGCircleElement | null;
    if (circle) circle.style.strokeDashoffset = String(ringOffset.toFixed(2));
  }, 50);

  document.getElementById('ltp-back')?.addEventListener('click', () => {
    if (returnTo === 'plan') {
      import('./plan-view').then(({ renderPlanView }) => renderPlanView());
    } else {
      import('./home-view').then(({ renderHomeView }) => renderHomeView());
    }
  });
}

// ── Navigation ───────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') import('./home-view').then(m => m.renderHomeView());
  else if (tab === 'plan') import('./plan-view').then(m => m.renderPlanView());
  else if (tab === 'record') import('./record-view').then(m => m.renderRecordView());
  else if (tab === 'stats') import('./stats-view').then(m => m.renderStatsView());
}
