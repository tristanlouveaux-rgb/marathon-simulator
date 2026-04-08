/**
 * Injury Risk detail page — same design language as freshness-view / recovery-view.
 * Sky-blue watercolour background, amber/red palette for risk.
 * Shows ACWR ratio, acute vs chronic load, weekly trend, zone reference, science backing.
 */

import { getState } from '@/state';
import type { SimulatorState } from '@/types/state';
import {
  computeACWR,
  computeRollingLoadRatio,
  computeWeekRawTSS,
  TIER_ACWR_CONFIG,
  CTL_DECAY,
  ATL_DECAY,
} from '@/calculations/fitness-model';

// ── Design tokens ─────────────────────────────────────────────────────────────

const APP_BG  = '#F8FAFC';
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

function injuryCoaching(ratio: number, safeUpper: number, acute: number, chronic: number): { headline: string; body: string } {
  if (ratio <= 0) {
    return { headline: 'Insufficient data', body: 'At least 14 days of activity data needed to compute load ratio. Keep logging activities.' };
  }

  const zone = acwrZone(ratio, safeUpper);
  const ratioStr = ratio.toFixed(2);
  const acuteDisp = Math.round(acute);
  const chronicDisp = Math.round(chronic);

  if (zone.label === 'Low') {
    return {
      headline: 'Training below baseline',
      body: `Load ratio at ${ratioStr}. This week's load (${acuteDisp} TSS) is well below the 4-week average (${chronicDisp} TSS). This is normal during a deload or recovery week.`,
    };
  }
  if (zone.label === 'Optimal') {
    return {
      headline: 'Load increase is within range',
      body: `Load ratio at ${ratioStr}. This week's load (${acuteDisp} TSS) is close to the 4-week average (${chronicDisp} TSS). The body is adapted to the current training level.`,
    };
  }
  if (zone.label === 'High') {
    return {
      headline: 'Load increasing faster than adaptation',
      body: `Load ratio at ${ratioStr}. This week's load (${acuteDisp} TSS) exceeds the 4-week average (${chronicDisp} TSS) by more than the safe margin. Monitor for soreness and prioritise sleep.`,
    };
  }
  return {
    headline: 'Load spike detected',
    body: `Load ratio at ${ratioStr}. This week's load (${acuteDisp} TSS) is significantly above the 4-week average (${chronicDisp} TSS). Reduce volume or intensity.`,
  };
}

// ── SVG watercolour background ────────────────────────────────────────────────

function skyBackground(): string {
  return `
    <div style="position:absolute;top:0;left:0;width:100%;height:480px;overflow:hidden;pointer-events:none;z-index:0">
      <svg style="width:100%;height:100%" viewBox="0 0 400 480" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="irSkyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#B8D4F0"/>
            <stop offset="30%" stop-color="#D6E8F8"/>
            <stop offset="70%" stop-color="#EAF2FB"/>
            <stop offset="100%" stop-color="#F8FAFC"/>
          </linearGradient>
          <linearGradient id="irMountFar" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#7BAED0" stop-opacity="0.6"/>
            <stop offset="100%" stop-color="#E0F0FC" stop-opacity="0.05"/>
          </linearGradient>
          <linearGradient id="irMountMid" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#5A98C0" stop-opacity="0.75"/>
            <stop offset="100%" stop-color="#C0DDF0" stop-opacity="0.1"/>
          </linearGradient>
          <linearGradient id="irMist" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95"/>
            <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.5"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </linearGradient>
          <filter id="irBlur"><feGaussianBlur stdDeviation="6"/></filter>
          <filter id="irHeavy"><feGaussianBlur stdDeviation="20"/></filter>
          <filter id="irWc"><feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="1.5"/></filter>
        </defs>
        <rect width="100%" height="100%" fill="url(#irSkyGrad)"/>
        <ellipse cx="200" cy="130" rx="100" ry="80" fill="#E8F0FF" filter="url(#irBlur)" opacity="0.5"/>
        <path d="M-60,190 Q20,150 80,180 T200,160 T350,170 T460,150 L460,480 L-60,480 Z" fill="url(#irMountFar)" filter="url(#irWc)"/>
        <path d="M-40,270 Q50,210 130,250 T280,220 T420,250 L420,480 L-40,480 Z" fill="url(#irMountMid)" filter="url(#irWc)"/>
        <ellipse cx="280" cy="285" rx="120" ry="40" fill="#FFFFFF" opacity="0.45" filter="url(#irHeavy)"/>
        <path d="M0,370 Q100,330 200,370 T400,350 L400,480 L0,480 Z" fill="url(#irMist)" filter="url(#irBlur)"/>
        <path d="M0,410 Q150,390 300,420 T400,410 L400,480 L0,480 Z" fill="url(#irMist)" opacity="0.7" filter="url(#irHeavy)"/>
      </svg>
      <div style="position:absolute;bottom:0;left:0;width:100%;height:120px;background:linear-gradient(to top,${APP_BG},transparent)"></div>
    </div>`;
}

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

  // Safe zone band
  const safeTopPct = ((maxRatio - safeUpper) / maxRatio) * 100;
  const safeBotPct = ((maxRatio - 0.8) / maxRatio) * 100;

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
      <div style="position:absolute;left:0;right:0;top:${safeTopPct}%;bottom:${100 - safeBotPct}%;background:rgba(34,197,94,0.06);border-top:1px dashed rgba(34,197,94,0.3);border-bottom:1px dashed rgba(34,197,94,0.3);pointer-events:none;z-index:0"></div>
      <div style="display:flex;gap:8px;align-items:flex-end;padding:4px 0;position:relative;z-index:1">${bars}</div>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:4px">
      <span style="font-size:10px;color:rgba(34,197,94,0.6)">Optimal zone: 0.8 to ${safeUpper.toFixed(1)}</span>
    </div>
    <div style="font-size:12px;color:${TEXT_S};margin-top:8px;line-height:1.4">${commentary}</div>
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

// ── Zone reference card ───────────────────────────────────────────────────────

function zoneReferenceCard(safeUpper: number): string {
  const zones = [
    { label: 'Low',      range: `below 0.8`,             color: TEXT_S,    desc: 'Training well below baseline. Normal during deload or recovery weeks.' },
    { label: 'Optimal',  range: `0.8 to ${safeUpper.toFixed(1)}`, color: '#22C55E', desc: 'Load increase is within the range the body can adapt to. Optimal training zone.' },
    { label: 'High',     range: `${safeUpper.toFixed(1)} to ${(safeUpper + 0.2).toFixed(1)}`, color: '#F59E0B', desc: 'Load is rising faster than adaptation. Monitor for soreness and sleep quality.' },
    { label: 'Very High', range: `above ${(safeUpper + 0.2).toFixed(1)}`,   color: '#EF4444', desc: 'Significant load spike. Reduce volume or intensity.' },
  ];

  return zones.map(z => `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;${z.label !== 'Low Load' ? 'border-top:1px solid #F1F5F9;' : ''}">
      <div style="width:8px;height:8px;border-radius:50%;background:${z.color};margin-top:5px;flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:13px;font-weight:600;color:${TEXT_M}">${z.label}</span>
          <span style="font-size:11px;color:${TEXT_L}">${z.range}</span>
        </div>
        <div style="font-size:12px;color:${TEXT_S};margin-top:2px;line-height:1.4">${z.desc}</div>
      </div>
    </div>
  `).join('');
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
  const tier = s.athleteTierOverride ?? s.athleteTier;
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, tier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, s.signalBBaseline ?? undefined);

  // Rolling 7d/28d for the acute vs chronic display
  const rolling = s.planStartDate ? computeRollingLoadRatio(s.wks ?? [], s.planStartDate, s.signalBBaseline ?? undefined) : null;
  const acute = rolling?.acute ?? acwr.atl;
  const chronic = rolling?.chronic ?? acwr.ctl;

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

  const { headline, body } = injuryCoaching(acwr.ratio, acwr.safeUpper, acute, chronic);

  const card = (title: string, content: string, delay: string) =>
    `<div class="ir-fade" style="animation-delay:${delay};background:white;border-radius:20px;padding:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04);margin-bottom:14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${TEXT_L};margin-bottom:14px">${title}</div>
      ${content}
    </div>`;

  return `
    <style>
      #ir-view { box-sizing:border-box; }
      #ir-view *, #ir-view *::before, #ir-view *::after { box-sizing:inherit; }
      @keyframes irFloatUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      .ir-fade { opacity:0; animation:irFloatUp 0.55s ease-out forwards; }
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
          <div style="font-size:20px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em">Load Ratio</div>
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
          <div style="background:white;border-radius:20px;padding:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
            <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:6px">${headline}</div>
            <div style="font-size:13px;color:${TEXT_S};line-height:1.55">${body}</div>
          </div>
        </div>

        <!-- Cards -->
        <div style="padding:0 16px">

          ${card('Acute vs Chronic Load', acuteVsChronicCard(acute, chronic, acwr.ratio, acwr.safeUpper), '0.22s')}

          ${card('Weekly Trend', acwrBarChart(weeklyAcwr, acwr.safeUpper), '0.30s')}

          ${card('Zone Reference', zoneReferenceCard(acwr.safeUpper), '0.38s')}

          ${card('How It Works', howItWorksCard(), '0.46s')}

        </div>
      </div>
    </div>
  `;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireInjuryRiskHandlers(): void {
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
  container.innerHTML = getInjuryRiskHTML(s);
  wireInjuryRiskHandlers();
}
