/**
 * Load Ratio detail page — same design language as freshness-view / recovery-view.
 * Sky-blue watercolour background, amber/red palette for risk.
 * Shows ACWR ratio, acute vs chronic load, weekly trend, zone reference, science backing.
 */

import { getState } from '@/state';
import type { SimulatorState } from '@/types/state';
import {
  computeReadinessACWR,
  computeWeekRawTSS,
  TIER_ACWR_CONFIG,
  CTL_DECAY,
  ATL_DECAY,
} from '@/calculations/fitness-model';
import { detectDurabilityFlag } from '@/calculations/daily-coach';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';

// ── Design tokens ─────────────────────────────────────────────────────────────

const APP_BG  = '#FAF9F6';
const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';
const RING_R  = 46;
const RING_C  = +(2 * Math.PI * RING_R).toFixed(2);

// ── Zone helpers ──────────────────────────────────────────────────────────────

interface AcwrZone { label: string; color: string; }

function acwrZone(ratio: number, safeUpper: number): AcwrZone {
  if (ratio <= 0)               return { label: 'No Data',   color: TEXT_L };
  if (ratio < 0.8)              return { label: 'Low',       color: TEXT_S };
  if (ratio <= safeUpper)       return { label: 'Optimal',   color: '#22C55E' };
  if (ratio <= safeUpper + 0.2) return { label: 'High',      color: '#F59E0B' };
  return                               { label: 'Very High', color: '#EF4444' };
}

// ── Coaching text ─────────────────────────────────────────────────────────────

function injuryCoaching(ratio: number, safeUpper: number, acute: number, chronic: number, latestWeekRatio?: number, durabilityElevated?: boolean): { headline: string; body: string } {
  if (ratio <= 0) {
    return { headline: 'Insufficient data', body: 'At least 14 days of activity data needed to compute load ratio. Keep logging activities.' };
  }

  const zone = acwrZone(ratio, safeUpper);
  const ratioStr = ratio.toFixed(2);
  const acuteDisp = Math.round(acute);
  const chronicDisp = Math.round(chronic);

  const weeklyContext = latestWeekRatio != null && Math.abs(latestWeekRatio - ratio) > 0.15
    ? latestWeekRatio > ratio
      ? ` However, the most recent completed week hit ${latestWeekRatio.toFixed(1)}x${latestWeekRatio > safeUpper ? ', above the safe zone' : ', at the upper end of the safe zone'}. Today's ratio (${ratioStr}) is lower because injury risk accumulates across weeks, not just the latest one.`
      : ` The most recent completed week was ${latestWeekRatio.toFixed(1)}x, lower than the rolling average as prior weeks were heavier.`
    : '';

  // Reconciliation: ACWR looks fine but drift says the load isn't being absorbed.
  // Only surfaced on Low/Optimal because High/Very High already agrees with the flag.
  const durabilityContext = (durabilityElevated && (zone.label === 'Low' || zone.label === 'Optimal'))
    ? ' Load ratio is within range, but recent HR drift suggests the current load is not being fully absorbed. See Durability Signal below.'
    : '';

  if (zone.label === 'Low') {
    return {
      headline: 'Training below baseline',
      body: `This week's load (${acuteDisp} TSS) is well below the 4-week average (${chronicDisp} TSS). Normal during a deload or recovery week.${weeklyContext}${durabilityContext}`,
    };
  }
  if (zone.label === 'Optimal') {
    return {
      headline: 'Load increase is within range',
      body: `This week's load (${acuteDisp} TSS) is close to the 4-week average (${chronicDisp} TSS). The body is adapted to the current training level.${weeklyContext}${durabilityContext}`,
    };
  }
  if (zone.label === 'High') {
    return {
      headline: 'Load increasing faster than adaptation',
      body: `This week's load (${acuteDisp} TSS) exceeds the 4-week average (${chronicDisp} TSS) by more than the safe margin. Monitor for soreness and prioritise sleep.${weeklyContext}`,
    };
  }
  return {
    headline: 'Load spike detected',
    body: `This week's load (${acuteDisp} TSS) is significantly above the 4-week average (${chronicDisp} TSS). Reduce volume or intensity.${weeklyContext}`,
  };
}

// ── SVG watercolour background ────────────────────────────────────────────────

function skyBackground(): string { return buildSkyBackground('ir', 'amber'); }

// ── Weekly ACWR trend ─────────────────────────────────────────────────────────

interface WeekAcwrEntry { week: number; ratio: number; rawTSS: number; }

function getWeeklyAcwrHistory(s: SimulatorState): WeekAcwrEntry[] {
  const wks = s.wks ?? [];
  const completedWeek = Math.max(0, (s.w ?? 1) - 1);
  const seed = s.signalBBaseline ?? s.ctlBaseline ?? 0;
  const results: WeekAcwrEntry[] = [];

  let ctl = seed;
  let atl = seed;

  const limit = Math.min(completedWeek, wks.length);
  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const weekRawTSS = computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate);
    ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY);
    atl = atl * ATL_DECAY + weekRawTSS * (1 - ATL_DECAY);
    const ratio = ctl > 1 ? atl / ctl : 0;
    results.push({ week: wk.w, ratio, rawTSS: weekRawTSS });
  }

  return results;
}

function acwrBarChart(entries: WeekAcwrEntry[], safeUpper: number): string {
  if (entries.length < 2) return `<div style="color:${TEXT_L};font-size:13px;padding:8px 0">Not enough data for a trend chart. At least 2 completed weeks needed.</div>`;

  const recent = entries.slice(-8);
  const maxRatio = Math.max(2.0, ...recent.map(e => e.ratio));
  const barAreaH = 120;

  // Safe zone band — must use same scale as bars (barAreaH - 8 usable, anchored to bottom)
  const usableH = barAreaH - 8;
  const safeBotPx = (0.8 / maxRatio) * usableH;
  const safeTopPx = (safeUpper / maxRatio) * usableH;
  // Convert to CSS: positioned from bottom of the barAreaH container
  const safeBandBottomPct = ((barAreaH - safeBotPx) / barAreaH) * 100;
  const safeBandTopPct = ((barAreaH - safeTopPx) / barAreaH) * 100;

  const bars = recent.map((e) => {
    const ratio = e.ratio;
    const barH = Math.max(2, (ratio / maxRatio) * (barAreaH - 8));
    const color = ratio <= 0 ? TEXT_L : ratio < 0.8 ? TEXT_S : ratio <= safeUpper ? '#22C55E' : ratio <= safeUpper + 0.2 ? '#F59E0B' : '#EF4444';

    return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0">
      <div style="position:relative;width:100%;height:${barAreaH}px">
        <div style="
          position:absolute;left:15%;right:15%;
          bottom:0;height:${barH}px;
          background:${color};border-radius:4px 4px 0 0;
          opacity:0.85;
        "></div>
        <div style="
          position:absolute;left:0;right:0;
          bottom:${barH + 4}px;
          text-align:center;font-size:11px;font-weight:600;color:${color};
        ">${ratio > 0 ? ratio.toFixed(1) : '—'}</div>
      </div>
      <div style="font-size:10px;color:${TEXT_L};margin-top:4px;text-align:center;white-space:nowrap">Wk ${e.week}</div>
    </div>`;
  }).join('');

  // Trend commentary
  const latest = recent[recent.length - 1].ratio;
  const prev = recent.length >= 2 ? recent[recent.length - 2].ratio : latest;
  let commentary = '';
  if (latest > safeUpper) commentary = 'Load ratio above safe ceiling. Reduce this week or schedule recovery.';
  else if (latest > prev + 0.15) commentary = 'Load ratio rising. Monitor how the body responds.';
  else if (latest < 0.8) commentary = 'Load below baseline. Deload or reduced training phase.';
  else commentary = 'Load ratio within the safe zone.';

  return `
    <div style="position:relative">
      <div style="position:absolute;left:0;right:0;top:${safeBandTopPct.toFixed(1)}%;bottom:${(100 - safeBandBottomPct).toFixed(1)}%;background:rgba(34,197,94,0.06);border-top:1px dashed rgba(34,197,94,0.3);border-bottom:1px dashed rgba(34,197,94,0.3);pointer-events:none;z-index:0"></div>
      <div style="display:flex;gap:8px;align-items:flex-end;padding:4px 0;position:relative;z-index:1">${bars}</div>
    </div>
    <div style="font-size:12px;color:${TEXT_S};margin-top:8px;line-height:1.4">${commentary}</div>
    <div style="font-size:11px;color:${TEXT_L};margin-top:8px;line-height:1.4">Green band: optimal zone (0.8 to ${safeUpper.toFixed(1)})</div>
  `;
}

// ── Acute vs Chronic gauge ────────────────────────────────────────────────────

function acuteVsChronicCard(acute: number, chronic: number, ratio: number, safeUpper: number): string {
  const maxVal = Math.max(acute, chronic, 1);
  const acutePct = Math.round((acute / maxVal) * 100);
  const chronicPct = Math.round((chronic / maxVal) * 100);
  const cautionUpper = safeUpper + 0.2;

  const acuteColor = ratio > cautionUpper ? '#EF4444' : ratio > safeUpper ? '#F59E0B' : '#3B82F6';

  let explanation: string;
  if (ratio > safeUpper) explanation = `This week's load is ${Math.round((ratio - 1) * 100)}% above the 4-week average. The body has not had time to adapt to this increase.`;
  else if (ratio >= 0.8) explanation = `This week\u2019s load is close to the 4-week average. The body is adapted to the current training level.`;
  else explanation = `This week's load is ${Math.round((1 - ratio) * 100)}% below the 4-week average. Deload or recovery week.`;

  return `
    <div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:13px;font-weight:600;color:${TEXT_M}">This week (acute)</span>
        <span style="font-size:15px;font-weight:700;color:${acuteColor}">${Math.round(acute)} TSS</span>
      </div>
      <div style="height:10px;background:#F1F5F9;border-radius:5px;overflow:hidden">
        <div style="height:100%;width:${acutePct}%;background:${acuteColor};border-radius:5px;transition:width 0.6s ease"></div>
      </div>
    </div>
    <div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:13px;font-weight:600;color:${TEXT_M}">4-week average (chronic)</span>
        <span style="font-size:15px;font-weight:700;color:#64748B">${Math.round(chronic)} TSS</span>
      </div>
      <div style="height:10px;background:#F1F5F9;border-radius:5px;overflow:hidden">
        <div style="height:100%;width:${chronicPct}%;background:#94A3B8;border-radius:5px;transition:width 0.6s ease"></div>
      </div>
    </div>
    <div style="font-size:12px;color:${TEXT_S};line-height:1.5">${explanation}</div>
  `;
}

// ── How it works + science card ───────────────────────────────────────────────

function howItWorksCard(): string {
  return `
    <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:16px">
      Injury risk measures how fast training load is increasing relative to what the body is used to.
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:16px">
      It compares the last 7 days of total training stress (acute load) against the average weekly load over the past 28 days (chronic load).
      The ratio between the two is the Acute:Chronic Workload Ratio, or ACWR.
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:16px">
      A ratio near 1.0 means this week matches the recent average. The body is adapted. A ratio above 1.3 to 1.5 (depending on training history) means
      load is increasing faster than the body can keep up with. Injury risk rises sharply in that range.
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:20px">
      The safe ceiling varies by training history. More experienced athletes tolerate higher spikes. All activity counts: runs, gym, cross-training.
      The body does not distinguish between sources of fatigue.
    </div>

    <div style="border-top:1px solid #F1F5F9;padding-top:16px">
      <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:12px">
        The ACWR was developed by Tim Gabbett and colleagues studying injury rates in team sports. Their 2016 paper found that athletes
        whose ACWR exceeded 1.5 had 2 to 4 times the injury rate of those in the 0.8 to 1.3 range. The "sweet spot" of 0.8 to 1.3 has since been
        validated across rugby, cricket, football, and endurance sports.
      </div>
      <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:12px">
        Blanch and Gabbett (2016) extended this with the "training-Loss prevention" framework: sudden load spikes (not high load itself) are
        the primary injury driver. Athletes who build load gradually can safely sustain high volumes. Those who spike load rapidly cannot.
      </div>
      <div style="font-size:11px;color:${TEXT_L};line-height:1.5;margin-top:14px">
        Gabbett TJ. <em>The training-injury prevention paradox: should athletes be training smarter and harder?</em> Br J Sports Med. 2016;50(5):273-80.<br>
        Blanch P, Gabbett TJ. <em>Has the athlete trained enough to return to play safely?</em> Br J Sports Med. 2016;50(8):471-5.<br>
        Hulin BT, Gabbett TJ, Lawson DW, et al. <em>The ACWR reveals new insights into the training-injury relationship.</em> Br J Sports Med. 2014;48(6):535-42.
      </div>
    </div>
  `;
}

// ── Main HTML ─────────────────────────────────────────────────────────────────

function getInjuryRiskHTML(s: SimulatorState): string {
  // Single source of truth — must match the Load Ratio card on Readiness.
  // computeReadinessACWR already feeds rolling 7d/28d into atl/ctl when planStartDate exists,
  // so the bars below display the same numbers as the ratio.
  const acwr = computeReadinessACWR(s);
  const acute = acwr.atl;
  const chronic = acwr.ctl;

  // Weekly history
  const weeklyAcwr = getWeeklyAcwrHistory(s);

  const zone = acwrZone(acwr.ratio, acwr.safeUpper);
  const ratioStr = acwr.ratio > 0 ? acwr.ratio.toFixed(2) : '—';

  // Ring: map ratio to 0-100 where 0.0=0%, 1.0=50%, 2.0=100%
  const ringPct = acwr.ratio > 0 ? Math.min(100, Math.max(0, (acwr.ratio / 2.0) * 100)) : 0;
  const targetOffset = +(RING_C * (1 - ringPct / 100)).toFixed(2);

  // Ring color based on zone
  const ringColor = zone.color;
  const ringGradA = zone.label === 'Very High' ? '#EF4444' : zone.label === 'High' ? '#F59E0B' : zone.label === 'Optimal' ? '#22C55E' : '#94A3B8';
  const ringGradB = zone.label === 'Very High' ? '#DC2626' : zone.label === 'High' ? '#D97706' : zone.label === 'Optimal' ? '#16A34A' : '#64748B';

  const latestWeekRatio = weeklyAcwr.length > 0 ? weeklyAcwr[weeklyAcwr.length - 1].ratio : undefined;

  const durability = detectDurabilityFlag(s);
  const { headline, body } = injuryCoaching(acwr.ratio, acwr.safeUpper, acute, chronic, latestWeekRatio, durability != null);
  const durabilityColor = durability?.level === 'high' ? '#EF4444' : '#F59E0B';
  const durabilityCard = durability ? `
    <div class="ir-fade" style="animation-delay:0.18s;padding:0 16px;margin-bottom:14px">
      <div style="background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);border-left:3px solid ${durabilityColor}">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${durabilityColor};margin-bottom:8px">Durability Signal</div>
        <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:6px">${durability.headline}</div>
        <div style="font-size:13px;color:${TEXT_S};line-height:1.55">${durability.body}</div>
      </div>
    </div>` : '';

  const card = (title: string, content: string, delay: string) =>
    `<div class="ir-fade" style="animation-delay:${delay};background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);margin-bottom:14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${TEXT_L};margin-bottom:14px">${title}</div>
      ${content}
    </div>`;

  return `
    <style>
      #ir-view { box-sizing:border-box; }
      #ir-view *, #ir-view *::before, #ir-view *::after { box-sizing:inherit; }
      @keyframes irFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .ir-fade { opacity:0; animation:irFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('ir')}
    </style>

    <div id="ir-view" style="
      position:relative;min-height:100vh;background:${APP_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${skyBackground()}

      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header -->
        <div style="padding:56px 20px 12px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50">
          <button id="ir-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="font-size:20px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em">Load Ratio & Injury Risk</div>
          <div style="width:36px"></div>
        </div>

        <!-- Ring -->
        <div class="ir-fade" style="animation-delay:0.08s;display:flex;justify-content:center;margin:8px 0 28px">
          <div style="position:relative;width:220px;height:220px;display:flex;align-items:center;justify-content:center">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="irGauge" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="${ringGradA}"/>
                  <stop offset="100%" stop-color="${ringGradB}"/>
                </linearGradient>
                <filter id="irGlow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="4" result="blur"/>
                  <feComposite in="SourceGraphic" in2="blur" operator="over"/>
                </filter>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="rgba(255,255,255,0.85)" stroke="rgba(241,245,249,0.5)" stroke-width="8"/>
              <circle id="ir-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="url(#irGauge)"
                stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"
                data-target="${targetOffset}"
                style="transition:stroke-dashoffset 1.5s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
                filter="url(#irGlow)"
              />
            </svg>
            <div style="
              position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;
              background:rgba(255,255,255,0.95);backdrop-filter:blur(8px);
              width:180px;height:180px;border-radius:50%;
              box-shadow:inset 0 2px 8px rgba(0,0,0,0.03);border:1px solid rgba(255,255,255,0.5);
            ">
              <div style="display:flex;align-items:flex-start;color:${ringColor};margin-top:8px">
                <span style="font-size:42px;font-weight:700;letter-spacing:-0.03em;line-height:1">${ratioStr}</span>
              </div>
              <span style="font-size:14px;font-weight:500;color:${TEXT_S};margin-top:2px">${zone.label}</span>
            </div>
          </div>
        </div>

        <!-- Coaching card -->
        <div class="ir-fade" style="animation-delay:0.14s;padding:0 16px;margin-bottom:14px">
          <div style="background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:6px">${headline}</div>
            <div style="font-size:13px;color:${TEXT_S};line-height:1.55">${body}</div>
          </div>
        </div>

        ${durabilityCard}

        <!-- Cards -->
        <div style="padding:0 16px">

          ${card('Acute vs Chronic Load', acuteVsChronicCard(acute, chronic, acwr.ratio, acwr.safeUpper), '0.22s')}

          ${card('Weekly Trend', acwrBarChart(weeklyAcwr, acwr.safeUpper), '0.30s')}

          ${card('How It Works', howItWorksCard(), '0.46s')}

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

function wireInjuryRiskHandlers(): void {
  // Tab bar
  wireTabBarHandlers(navigateTab);

  // Animate ring
  setTimeout(() => {
    const circle = document.getElementById('ir-ring-circle');
    const target = (circle as HTMLElement | null)?.dataset.target;
    if (circle && target) circle.style.strokeDashoffset = target;
  }, 50);

  // Back → readiness
  document.getElementById('ir-back-btn')?.addEventListener('click', () => {
    import('./readiness-view').then(({ renderReadinessView }) => renderReadinessView());
  });
}

// ── Public entry point ────────────────────────────────────────────────────────

export function renderInjuryRiskView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  // Render the running-side page exactly as it always was. In tri mode we ALSO
  // want per-discipline acute-vs-chronic context, but that's added inline by
  // injecting an extra card into the existing layout via DOM manipulation
  // after first render — keeps the existing page structure intact and avoids
  // any chance of breaking running. See `injectTriPerDisciplineLoad` below.
  container.innerHTML = getInjuryRiskHTML(s);
  wireInjuryRiskHandlers();
  if (s.eventType === 'triathlon' && s.triConfig) {
    injectTriPerDisciplineLoad(s);
  }
}

/**
 * In tri mode, append per-discipline acute-vs-chronic cards AFTER the
 * existing combined "Acute vs Chronic Load" card. Additive — does not modify
 * any of the running-mode rendering. Form is intentionally NOT shown here:
 * it lives on the Freshness page where it belongs.
 */
function injectTriPerDisciplineLoad(s: SimulatorState): void {
  const tri = s.triConfig;
  if (!tri?.fitness) return;
  // Find the existing acute-vs-chronic card by its title text.
  const cards = document.querySelectorAll('.ir-fade');
  let anchor: Element | null = null;
  for (const el of Array.from(cards)) {
    if (el.textContent?.includes('Acute vs Chronic Load')) { anchor = el; break; }
  }
  if (!anchor) return;

  const fit = tri.fitness;
  const div = (sport: 'swim' | 'bike' | 'run', label: string) => {
    const f = fit[sport];
    // Display in weekly TSS (matches the combined Acute vs Chronic card above —
    // f.ctl / f.atl are weekly EMA in TSS units).
    const acuteW = Math.round(f.atl);
    const chronicW = Math.round(f.ctl);
    const ratio = f.ctl > 0 ? f.atl / f.ctl : 0;
    if (acuteW === 0 && chronicW === 0) {
      return `
        <div style="padding:14px 0;border-top:1px solid #F1F5F9">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <span style="font-size:13px;font-weight:600;color:${TEXT_M}">${label}</span>
            <span style="font-size:12px;color:${TEXT_L}">No direct activity</span>
          </div>
        </div>
      `;
    }
    const maxVal = Math.max(acuteW, chronicW, 1);
    const acutePct = Math.round((acuteW / maxVal) * 100);
    const chronicPct = Math.round((chronicW / maxVal) * 100);
    const ratioColor = ratio > 1.5 ? '#EF4444' : ratio > 1.3 ? '#F59E0B' : ratio >= 0.8 ? '#22C55E' : '#94A3B8';
    return `
      <div style="padding:14px 0;border-top:1px solid #F1F5F9">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <span style="font-size:13px;font-weight:600;color:${TEXT_M}">${label}</span>
          <span style="font-size:22px;font-weight:700;color:${ratioColor};font-variant-numeric:tabular-nums;letter-spacing:-0.02em">${ratio > 0 ? ratio.toFixed(2) : '—'}</span>
        </div>
        <!-- Tiny acute bar (zone-coloured) -->
        <div style="height:3px;background:#F1F5F9;border-radius:2px;overflow:hidden;margin-bottom:3px">
          <div style="height:100%;width:${acutePct}%;background:${ratioColor};border-radius:2px"></div>
        </div>
        <!-- Tiny chronic bar (neutral) -->
        <div style="height:3px;background:#F1F5F9;border-radius:2px;overflow:hidden;margin-bottom:6px">
          <div style="height:100%;width:${chronicPct}%;background:#94A3B8;border-radius:2px"></div>
        </div>
        <div style="font-size:11px;color:${TEXT_L};font-variant-numeric:tabular-nums">${acuteW} vs ${chronicW} TSS · this week vs 4-week avg</div>
      </div>
    `;
  };

  const insertedHTML = `
    <div class="ir-fade" style="animation-delay:0.34s;background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);margin-bottom:14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${TEXT_L};margin-bottom:14px">By Discipline</div>
      ${div('swim', 'Swim')}
      ${div('bike', 'Bike')}
      ${div('run', 'Run')}
      <div style="font-size:11px;color:${TEXT_L};line-height:1.5;margin-top:8px;border-top:1px solid #F1F5F9;padding-top:10px">
        Direct per-discipline activity (own sport only). Cross-training transfer is included in the combined ratio at the top — your bike work boosts overall load even on a rest swim day.
      </div>
    </div>
  `;

  // Insert after the anchor card.
  const wrapper = document.createElement('div');
  wrapper.innerHTML = insertedHTML;
  const node = wrapper.firstElementChild;
  if (node && anchor.parentNode) {
    anchor.parentNode.insertBefore(node, anchor.nextSibling);
  }
}
