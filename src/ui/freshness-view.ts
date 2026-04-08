/**
 * Freshness detail page — same design language as recovery-view.
 * Sky-blue watercolour background, blue palette.
 * Shows TSB (Training Stress Balance), weekly trend, CTL vs ATL, zone explainer.
 */

import { getState } from '@/state';
import type { SimulatorState } from '@/types/state';
import {
  computeSameSignalTSB,
  computeFitnessModel,
  computeWeekRawTSS,
  computeTodaySignalBTSS,
  CTL_DECAY,
  ATL_DECAY,
} from '@/calculations/fitness-model';

// ── Design tokens ─────────────────────────────────────────────────────────────

const APP_BG  = '#F8FAFC';
const BLUE_A  = '#60A5FA';   // blue-400
const BLUE_B  = '#3B82F6';   // blue-500
const BLUE_D  = '#2563EB';   // blue-600
const TEXT_M  = '#0F172A';
const TEXT_S  = '#64748B';
const TEXT_L  = '#94A3B8';
const RING_R  = 46;
const RING_C  = +(2 * Math.PI * RING_R).toFixed(2);

// ── Zone helpers ──────────────────────────────────────────────────────────────

interface TsbZone { label: string; color: string; bg: string; }

/** Accepts raw weekly TSB, converts to daily-equivalent for zone classification.
 *  Must match readiness-view.ts thresholds exactly. */
function tsbZone(rawTsb: number): TsbZone {
  const d = Math.round(rawTsb / 7);
  if (d > 0)     return { label: 'Fresh',       color: '#22C55E', bg: 'rgba(34,197,94,0.08)' };
  if (d >= -3)   return { label: 'Recovering',  color: BLUE_B,    bg: 'rgba(59,130,246,0.08)' };
  if (d >= -8)   return { label: 'Fatigued',    color: '#F59E0B', bg: 'rgba(245,158,11,0.08)' };
  if (d >= -15)  return { label: 'Heavy',       color: '#F59E0B', bg: 'rgba(245,158,11,0.08)' };
  if (d >= -25)  return { label: 'Overloaded',  color: '#EF4444', bg: 'rgba(239,68,68,0.08)' };
  return            { label: 'Overreaching', color: '#EF4444', bg: 'rgba(239,68,68,0.08)' };
}

function tsbBarColor(rawTsb: number): string {
  return tsbZone(rawTsb).color;
}

// ── Coaching text ─────────────────────────────────────────────────────────────

function freshnessCoaching(tsb: number, _ctl: number, _atl: number, weeksOfData: number): { headline: string; body: string } {
  if (weeksOfData < 3) {
    return { headline: 'Building baseline', body: 'At least 3 completed weeks of data needed. Freshness becomes reliable once there is enough training history to separate fitness from fatigue.' };
  }

  const zone = tsbZone(tsb);
  const d = Math.round(Math.abs(tsb) / 7);

  if (zone.label === 'Fresh') {
    return {
      headline: 'Ready for hard effort',
      body: `Fatigue has cleared faster than fitness has decayed. TSB at +${d} means the body is primed for a quality session or race effort.`,
    };
  }
  if (zone.label === 'Recovering') {
    return {
      headline: 'Mild fatigue, normal balance',
      body: `TSB at -${d}. Slight residual fatigue from recent training. Normal state during consistent training. No action needed.`,
    };
  }
  if (zone.label === 'Fatigued') {
    return {
      headline: 'Fatigue building',
      body: `TSB at -${d}. Recent load is above what the body is adapted to. Expected during build phases. Legs may feel heavy. An easy day or two brings this back.`,
    };
  }
  if (zone.label === 'Heavy') {
    return {
      headline: 'Heavy fatigue',
      body: `TSB at -${d}. Sustained hard training. Expect sore legs and reduced performance. Easy sessions or rest until this clears.`,
    };
  }
  if (zone.label === 'Overloaded') {
    return {
      headline: 'Significant fatigue accumulation',
      body: `TSB at -${d}. Rest or very easy movement only. Hard sessions at this level will not produce useful adaptation.`,
    };
  }
  return {
    headline: 'Recovery week needed',
    body: `TSB at -${d}. Sustained overload. Full rest days needed before resuming any structured training.`,
  };
}

// ── SVG watercolour background (shared with recovery) ─────────────────────────

function skyBackground(): string {
  return `
    <div style="position:absolute;top:0;left:0;width:100%;height:480px;overflow:hidden;pointer-events:none;z-index:0">
      <svg style="width:100%;height:100%" viewBox="0 0 400 480" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="fSkyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#B8D4F0"/>
            <stop offset="30%" stop-color="#D6E8F8"/>
            <stop offset="70%" stop-color="#EAF2FB"/>
            <stop offset="100%" stop-color="#F8FAFC"/>
          </linearGradient>
          <linearGradient id="fMountFar" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#7BAED0" stop-opacity="0.6"/>
            <stop offset="60%" stop-color="#9CC4E0" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#E0F0FC" stop-opacity="0.05"/>
          </linearGradient>
          <linearGradient id="fMountMid" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#5A98C0" stop-opacity="0.75"/>
            <stop offset="50%" stop-color="#82B8D8" stop-opacity="0.4"/>
            <stop offset="100%" stop-color="#C0DDF0" stop-opacity="0.1"/>
          </linearGradient>
          <linearGradient id="fMountNear" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#4A9CC8" stop-opacity="0.5"/>
            <stop offset="40%" stop-color="#6AB8D8" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="#98D4E8" stop-opacity="0.15"/>
          </linearGradient>
          <linearGradient id="fMist" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95"/>
            <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.5"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </linearGradient>
          <filter id="fBlur"><feGaussianBlur stdDeviation="6"/></filter>
          <filter id="fHeavy"><feGaussianBlur stdDeviation="20"/></filter>
          <filter id="fWc"><feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="1.5"/></filter>
        </defs>
        <rect width="100%" height="100%" fill="url(#fSkyGrad)"/>
        <ellipse cx="200" cy="130" rx="100" ry="80" fill="#E8F0FF" filter="url(#fBlur)" opacity="0.5"/>
        <path d="M-60,190 Q20,150 80,180 T200,160 T350,170 T460,150 L460,480 L-60,480 Z" fill="url(#fMountFar)" filter="url(#fWc)"/>
        <ellipse cx="100" cy="210" rx="80" ry="25" fill="white" filter="url(#fHeavy)" opacity="0.45"/>
        <path d="M-40,270 Q50,210 130,250 T280,220 T420,250 L420,480 L-40,480 Z" fill="url(#fMountMid)" filter="url(#fWc)"/>
        <ellipse cx="280" cy="285" rx="120" ry="40" fill="#FFFFFF" opacity="0.45" filter="url(#fHeavy)"/>
        <path d="M-20,350 Q60,290 150,330 T320,310 T440,340 L440,480 L-20,480 Z" fill="url(#fMountNear)" filter="url(#fWc)"/>
        <path d="M0,370 Q100,330 200,370 T400,350 L400,480 L0,480 Z" fill="url(#fMist)" filter="url(#fBlur)"/>
        <path d="M0,410 Q150,390 300,420 T400,410 L400,480 L0,480 Z" fill="url(#fMist)" opacity="0.7" filter="url(#fHeavy)"/>
      </svg>
      <div style="position:absolute;bottom:0;left:0;width:100%;height:120px;background:linear-gradient(to top,${APP_BG},transparent)"></div>
    </div>`;
}

// ── Weekly TSB data ───────────────────────────────────────────────────────────

interface WeekTsbEntry {
  week: number;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
}

function getWeeklyTsbHistory(s: SimulatorState): WeekTsbEntry[] {
  const wks = s.wks ?? [];
  const completedWeek = Math.max(0, (s.w ?? 1) - 1);
  const seed = s.signalBBaseline ?? s.ctlBaseline ?? 0;
  const results: WeekTsbEntry[] = [];

  let ctl = seed;
  let atl = seed;

  const limit = Math.min(completedWeek, wks.length);
  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const weekRawTSS = computeWeekRawTSS(wk, wk.rated ?? {}, s.planStartDate);
    ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY);
    atl = atl * ATL_DECAY + weekRawTSS * (1 - ATL_DECAY);
    results.push({ week: wk.w, tss: weekRawTSS, ctl, atl, tsb: ctl - atl });
  }

  return results;
}

// ── Bar chart ─────────────────────────────────────────────────────────────────

function tsbBarChart(entries: WeekTsbEntry[]): string {
  if (entries.length < 2) return '<div style="color:#94A3B8;font-size:13px;padding:8px 0">Not enough data for a trend chart. At least 2 completed weeks needed.</div>';

  const recent = entries.slice(-8); // last 8 weeks
  const values = recent.map(e => Math.round(e.tsb / 7)); // display scale (daily equivalent)
  const maxAbs = Math.max(10, ...values.map(Math.abs));
  const labelH = 18; // space reserved for value labels above/below bars
  const barAreaH = 120;
  const midY = barAreaH / 2;

  const bars = recent.map((e, i) => {
    const v = values[i];
    const barH = Math.max(2, Math.abs(v) / maxAbs * (barAreaH / 2 - labelH - 4));
    const isPos = v >= 0;
    const top = isPos ? midY - barH : midY;
    const color = tsbBarColor(e.tsb);
    const w = `calc((100% - ${(recent.length - 1) * 8}px) / ${recent.length})`;

    return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0">
      <div style="position:relative;width:100%;height:${barAreaH}px">
        <div style="position:absolute;left:0;right:0;top:${midY}px;height:1px;background:#E2E8F0"></div>
        <div style="
          position:absolute;left:15%;right:15%;
          top:${top}px;height:${barH}px;
          background:${color};border-radius:4px;
          opacity:0.85;
        "></div>
        <div style="
          position:absolute;left:0;right:0;
          ${isPos ? `top:${top - 18}px` : `top:${top + barH + 4}px`};
          text-align:center;font-size:11px;font-weight:600;color:${color};
        ">${v > 0 ? '+' : ''}${v}</div>
      </div>
      <div style="font-size:10px;color:${TEXT_L};margin-top:4px;text-align:center;white-space:nowrap">Wk ${e.week}</div>
    </div>`;
  }).join('');

  // Trend commentary — combine direction with current zone for a single coherent message
  const latest = values[values.length - 1];
  const prev = values.length >= 2 ? values[values.length - 2] : latest;
  const delta = latest - prev;
  const latestZone = tsbZone(recent[recent.length - 1].tsb).label;
  let commentary = '';
  if (delta > 3 && latest > 0) commentary = 'Freshness rising into positive territory. Good window for quality work.';
  else if (delta > 3) commentary = `Freshness rising. Currently ${latestZone.toLowerCase()}, trending toward recovery.`;
  else if (delta < -5) commentary = `Freshness dropped sharply. Currently ${latestZone.toLowerCase()}. Recent load is above baseline.`;
  else if (delta < -2) commentary = `Freshness drifting down. Currently ${latestZone.toLowerCase()}.`;
  else if (latest > 0) commentary = 'Freshness stable and positive. Rested.';
  else if (latest >= -3) commentary = 'Freshness stable near zero. Normal training balance.';
  else commentary = `Freshness stable at ${latest}. Currently ${latestZone.toLowerCase()}.`;

  return `
    <div style="display:flex;gap:8px;align-items:stretch;padding:4px 0;overflow:visible">${bars}</div>
    <div style="font-size:12px;color:${TEXT_S};margin-top:8px;line-height:1.4">${commentary}</div>
  `;
}

// ── CTL vs ATL gauge card ─────────────────────────────────────────────────────

function fitnessVsFatigueCard(ctl: number, atl: number): string {
  const ctlDisp = Math.round(ctl / 7);
  const atlDisp = Math.round(atl / 7);
  const maxVal = Math.max(ctlDisp, atlDisp, 1);

  const ctlPct = Math.round((ctlDisp / maxVal) * 100);
  const atlPct = Math.round((atlDisp / maxVal) * 100);

  const balance = ctlDisp - atlDisp;
  let balanceText: string;
  if (balance > 5) balanceText = `Fitness exceeds fatigue by ${balance}. Body is adapted above current load.`;
  else if (balance < -5) balanceText = `Fatigue exceeds fitness by ${Math.abs(balance)}. Recent training load is above what the body has adapted to.`;
  else balanceText = 'Fitness and fatigue are roughly in balance. Current load matches adaptation level.';

  return `
    <div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:13px;font-weight:600;color:${TEXT_M}">Fitness (CTL)</span>
        <span style="font-size:15px;font-weight:700;color:${BLUE_D}">${ctlDisp}</span>
      </div>
      <div style="height:10px;background:#F1F5F9;border-radius:5px;overflow:hidden">
        <div style="height:100%;width:${ctlPct}%;background:${BLUE_B};border-radius:5px;transition:width 0.6s ease"></div>
      </div>
    </div>
    <div style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:13px;font-weight:600;color:${TEXT_M}">Fatigue (ATL)</span>
        <span style="font-size:15px;font-weight:700;color:#F59E0B">${atlDisp}</span>
      </div>
      <div style="height:10px;background:#F1F5F9;border-radius:5px;overflow:hidden">
        <div style="height:100%;width:${atlPct}%;background:#F59E0B;border-radius:5px;transition:width 0.6s ease"></div>
      </div>
    </div>
    <div style="font-size:12px;color:${TEXT_S};line-height:1.5">${balanceText}</div>
  `;
}

// ── Zone reference card ───────────────────────────────────────────────────────

function zoneExplainerCard(): string {
  const zones = [
    { label: 'Fresh',        range: 'above 0',     color: '#22C55E', desc: 'Fatigue has cleared. Good window for a hard session or race.' },
    { label: 'Recovering',   range: '0 to -3',     color: BLUE_B,    desc: 'Mild residual fatigue. Normal during consistent training.' },
    { label: 'Fatigued',     range: '-3 to -8',    color: '#F59E0B', desc: 'Recent load above adaptation. Legs may feel heavy. Expected in build phases.' },
    { label: 'Heavy',        range: '-8 to -15',   color: '#F59E0B', desc: 'Sustained hard training. Easy sessions or rest recommended.' },
    { label: 'Overloaded',   range: '-15 to -25',  color: '#EF4444', desc: 'Significant fatigue. Rest or very easy movement only.' },
    { label: 'Overreaching', range: 'below -25',   color: '#EF4444', desc: 'Sustained overload. Full rest days needed.' },
  ];

  return zones.map(z => `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;${z.label !== 'Fresh' ? 'border-top:1px solid #F1F5F9;' : ''}">
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
      Freshness is Fitness minus Fatigue.
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:16px">
      Training creates two competing effects. Fitness builds slowly over weeks of consistent load and decays slowly when you stop.
      Fatigue spikes quickly after hard sessions and clears within days. Freshness is the gap between the two.
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:16px">
      During a training block, fatigue rises faster than fitness, so freshness drops. During a taper or easy week, fatigue clears quickly while fitness
      holds. That is when freshness rises and performance peaks.
    </div>
    <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:20px">
      The number shown is the daily difference between your fitness and fatigue scores. Zero means balanced. Positive means rested. Negative means
      carrying fatigue.
    </div>

    <div style="border-top:1px solid #F1F5F9;padding-top:16px">
      <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:12px">
        This model is based on the Fitness-Fatigue (impulse-response) model first published by
        Banister et al. in 1975. The core idea: performance at any point in time equals a slow-building fitness effect minus a fast-decaying
        fatigue effect. Both are driven by training load but operate on different timescales.
      </div>
      <div style="font-size:13px;color:${TEXT_S};line-height:1.6;margin-bottom:12px">
        Andrew Coggan later adapted this into the CTL/ATL/TSB framework used by TrainingPeaks, where CTL (Chronic Training Load) tracks fitness
        as a 42-day rolling average and ATL (Acute Training Load) tracks fatigue as a 7-day rolling average.
        TSB = CTL minus ATL. The zone thresholds (0, -10, -25) are empirical guidelines widely used in endurance coaching.
      </div>
      <div style="font-size:11px;color:${TEXT_L};line-height:1.5;margin-top:14px">
        Banister EW, Calvert TW, Savage MV, Bach T. <em>A systems model of training for athletic performance.</em> Aust J Sports Med. 1975;7:57-61.<br>
        Busso T. <em>Variable dose-response relationship between exercise training and performance.</em> Med Sci Sports Exerc. 2003;35(7):1188-95.
      </div>
    </div>
  `;
}

// ── Main HTML ─────────────────────────────────────────────────────────────────

function getFreshnessHTML(s: SimulatorState): string {
  const completedWeek = Math.max(0, (s.w ?? 1) - 1);
  const seed = s.signalBBaseline ?? s.ctlBaseline ?? 0;
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));

  // TSB from completed weeks
  const sameSignal = computeSameSignalTSB(s.wks ?? [], completedWeek, seed, s.planStartDate);
  const tsb = sameSignal?.tsb ?? 0;
  const ctl = sameSignal?.ctl ?? 0;
  const atl = sameSignal?.atl ?? 0;

  // Fitness model for week count
  const metrics = computeFitnessModel(s.wks ?? [], completedWeek, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
  const weeksOfData = metrics.length;

  // Weekly TSB history for bar chart
  const weeklyTsb = getWeeklyTsbHistory(s);

  // Ring
  const zone = tsbZone(tsb);
  const tsbDisp = Math.round(tsb / 7);
  const tsbLabel = tsbDisp > 0 ? `+${tsbDisp}` : `${tsbDisp}`;

  // Ring fill: map TSB to a 0-100 percentage for visual
  // +20 = 100%, 0 = 50%, -40 = 0%
  const ringPct = Math.min(100, Math.max(0, ((tsbDisp + 40) / 60) * 100));
  const targetOffset = +(RING_C * (1 - ringPct / 100)).toFixed(2);
  const ringColor = zone.color;

  // Coaching
  const { headline, body } = freshnessCoaching(tsb, ctl, atl, weeksOfData);

  // Fatigue decay projection — estimate hours until daily TSB reaches -3
  let fatigueDecayHours: number | null = null;
  if (tsbDisp < -3 && atl > 0) {
    const targetWeeklyTsb = -3 * 7; // daily -3 in weekly units
    const targetAtl = ctl - targetWeeklyTsb; // ATL at which TSB = target
    if (atl > targetAtl && targetAtl > 0) {
      const days = -7 * Math.log(targetAtl / atl);
      fatigueDecayHours = Math.max(1, Math.round(days * 24));
    }
  }
  const fatigueDecayStr = fatigueDecayHours != null
    ? (fatigueDecayHours < 72 ? `${fatigueDecayHours}` : `${Math.ceil(fatigueDecayHours / 24)}`)
    : null;
  const fatigueDecayUnit = fatigueDecayHours != null
    ? (fatigueDecayHours < 72 ? 'Hours' : 'Days')
    : null;

  // Recovery status — compare today's load to determine if recovery is progressing
  const today = new Date().toISOString().split('T')[0];
  const wks = s.wks ?? [];
  const currentWk = wks[s.w ?? 0];
  const prevWk = wks[Math.max(0, (s.w ?? 0) - 1)];
  const todayTSS = currentWk ? computeTodaySignalBTSS(currentWk, today) : 0;
  // Check yesterday too — may be in previous week (e.g. Monday, yesterday = Sunday)
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const yesterdayTSS = (currentWk ? computeTodaySignalBTSS(currentWk, yesterday) : 0)
    || (prevWk ? computeTodaySignalBTSS(prevWk, yesterday) : 0);

  let recoveryStatus: 'recovering' | 'paused' | 'fresh' = 'fresh';
  let recoveryStatusLabel = '';
  let recoveryStatusDesc = '';
  if (tsbDisp >= -3) {
    recoveryStatus = 'fresh';
    recoveryStatusLabel = 'Recovered';
    recoveryStatusDesc = 'Fatigue has cleared. Ready for normal training.';
  } else if (todayTSS > 30) {
    recoveryStatus = 'paused';
    recoveryStatusLabel = 'Recovery Paused';
    recoveryStatusDesc = 'Session logged today. Recovery timeline extended.';
  } else if (yesterdayTSS > 50) {
    recoveryStatus = 'paused';
    recoveryStatusLabel = 'Recovery Delayed';
    recoveryStatusDesc = 'Yesterday\'s session added load. Expect slower clearance.';
  } else {
    recoveryStatus = 'recovering';
    recoveryStatusLabel = 'Recovering as Expected';
    recoveryStatusDesc = 'No significant load in the last 24h. Fatigue clearing normally.';
  }

  // Card builder
  const card = (title: string, content: string, delay: string) =>
    `<div class="f-fade" style="animation-delay:${delay};background:white;border-radius:20px;padding:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04);margin-bottom:14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${TEXT_L};margin-bottom:14px">${title}</div>
      ${content}
    </div>`;

  return `
    <style>
      #fresh-view { box-sizing:border-box; }
      #fresh-view *, #fresh-view *::before, #fresh-view *::after { box-sizing:inherit; }
      @keyframes fFloatUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      .f-fade { opacity:0; animation:fFloatUp 0.55s ease-out forwards; }
    </style>

    <div id="fresh-view" style="
      position:relative;min-height:100vh;background:${APP_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${skyBackground()}

      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header -->
        <div style="padding:56px 20px 12px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50">
          <button id="fresh-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div style="font-size:20px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em">Freshness</div>
          <div style="width:36px"></div>
        </div>

        <!-- Ring -->
        <div class="f-fade" style="animation-delay:0.08s;display:flex;justify-content:center;margin:8px 0 28px">
          <div style="position:relative;width:220px;height:220px;display:flex;align-items:center;justify-content:center">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="freshGauge" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="${BLUE_A}"/>
                  <stop offset="100%" stop-color="${BLUE_D}"/>
                </linearGradient>
                <filter id="freshGlow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="4" result="blur"/>
                  <feComposite in="SourceGraphic" in2="blur" operator="over"/>
                </filter>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="rgba(255,255,255,0.85)" stroke="rgba(241,245,249,0.5)" stroke-width="8"/>
              <circle id="fresh-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="url(#freshGauge)"
                stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"
                style="transition:stroke-dashoffset 1.5s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
                filter="url(#freshGlow)"
              />
            </svg>
            <div style="
              position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;
              background:rgba(255,255,255,0.95);backdrop-filter:blur(8px);
              width:180px;height:180px;border-radius:50%;
              box-shadow:inset 0 2px 8px rgba(0,0,0,0.03);border:1px solid rgba(255,255,255,0.5);
            ">
              <div style="display:flex;align-items:flex-start;color:${ringColor};margin-top:8px">
                <span style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1">${tsbLabel}</span>
              </div>
              <span style="font-size:14px;font-weight:500;color:${TEXT_S};margin-top:2px">${zone.label}</span>
            </div>
          </div>
        </div>

        <!-- Recovery countdown -->
        ${fatigueDecayStr != null ? (() => {
          const maxHours = 96; // 4 days = full ring
          const remaining = Math.min(fatigueDecayHours ?? 0, maxHours);
          const pct = remaining / maxHours; // 1.0 = full ring (lots of fatigue), 0.0 = empty (recovered)
          const circ = 2 * Math.PI * 34;
          const offset = circ * (1 - pct); // ring drains as hours decrease
          const statusColor = recoveryStatus === 'paused' ? 'var(--c-caution)' : recoveryStatus === 'recovering' ? ringColor : 'var(--c-ok)';
          return `
        <div class="f-fade" style="animation-delay:0.12s;padding:0 16px;margin-bottom:14px">
          <div style="background:white;border-radius:20px;padding:24px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04);display:flex;align-items:center;gap:20px">
            <div style="position:relative;width:80px;height:80px;flex-shrink:0">
              <svg viewBox="0 0 80 80" width="80" height="80" style="transform:rotate(-90deg)">
                <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="6"/>
                <circle cx="40" cy="40" r="34" fill="none"
                  stroke="${statusColor}" stroke-width="6" stroke-linecap="round"
                  stroke-dasharray="${circ.toFixed(1)}"
                  stroke-dashoffset="${offset.toFixed(1)}"
                />
              </svg>
              <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
                <div style="font-size:22px;font-weight:700;color:${statusColor};line-height:1">${fatigueDecayStr}</div>
                <div style="font-size:10px;font-weight:500;color:${TEXT_S};margin-top:1px">${fatigueDecayUnit}</div>
              </div>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;color:${TEXT_M};margin-bottom:4px">${recoveryStatusLabel}</div>
              <div style="font-size:12px;color:${TEXT_S};line-height:1.45">${recoveryStatusDesc}</div>
            </div>
          </div>
        </div>`;
        })() : ''}

        <!-- Coaching card -->
        <div class="f-fade" style="animation-delay:0.14s;padding:0 16px;margin-bottom:14px">
          <div style="background:white;border-radius:20px;padding:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.04)">
            <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:6px">${headline}</div>
            <div style="font-size:13px;color:${TEXT_S};line-height:1.55">${body}</div>
          </div>
        </div>

        <!-- Cards -->
        <div style="padding:0 16px">

          ${card('Weekly Trend', tsbBarChart(weeklyTsb), '0.22s')}

          ${card('Fitness vs Fatigue', fitnessVsFatigueCard(ctl, atl), '0.30s')}

          ${card('Zone Reference', zoneExplainerCard(), '0.38s')}

          ${card('How It Works', howItWorksCard(), '0.46s')}

        </div>
      </div>
    </div>
  `;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireFreshnessHandlers(): void {
  // Animate ring
  setTimeout(() => {
    const circle = document.getElementById('fresh-ring-circle');
    const offset = circle?.getAttribute('stroke-dashoffset');
    if (circle) {
      // Read the target from our computed value
      const s = getState();
      const completedWeek = Math.max(0, (s.w ?? 1) - 1);
      const seed = s.signalBBaseline ?? s.ctlBaseline ?? 0;
      const sameSignal = computeSameSignalTSB(s.wks ?? [], completedWeek, seed, s.planStartDate);
      const tsb = sameSignal?.tsb ?? 0;
      const tsbDisp = Math.round(tsb / 7);
      const ringPct = Math.min(100, Math.max(0, ((tsbDisp + 40) / 60) * 100));
      const target = +(RING_C * (1 - ringPct / 100)).toFixed(2);
      circle.style.strokeDashoffset = `${target}`;
    }
  }, 50);

  // Back → readiness
  document.getElementById('fresh-back-btn')?.addEventListener('click', () => {
    import('./readiness-view').then(({ renderReadinessView }) => renderReadinessView());
  });
}

// ── Public entry point ────────────────────────────────────────────────────────

export function renderFreshnessView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  container.innerHTML = getFreshnessHTML(s);
  wireFreshnessHandlers();
}
