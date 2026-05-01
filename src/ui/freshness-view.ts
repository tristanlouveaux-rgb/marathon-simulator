/**
 * Freshness detail page — same design language as recovery-view.
 * Sky-blue watercolour background, blue palette.
 * Shows TSB (Training Stress Balance), weekly trend, CTL vs ATL, zone explainer.
 */

import { getState } from '@/state';
import type { SimulatorState } from '@/types/state';
import {
  computeLiveSameSignalTSB,
  computeFitnessModel,
  computeWeekRawTSS,
  computeToBaseline,
  CTL_DECAY,
  ATL_DECAY,
} from '@/calculations/fitness-model';

import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';

// ── Design tokens ─────────────────────────────────────────────────────────────

const APP_BG  = '#FAF9F6';
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

/** One-line action sentence per zone — single source of truth for ring caption.
 *  Mirrors the descriptions previously shown in the Zone Reference card. */
function tsbZoneDescription(rawTsb: number): string {
  const d = Math.round(rawTsb / 7);
  if (d > 0)    return 'Fatigue has cleared. Good window for a hard session or race.';
  if (d >= -3)  return 'Mild residual fatigue. Normal during consistent training.';
  if (d >= -8)  return 'Recent load above adaptation. Legs may feel heavy. Expected in build phases.';
  if (d >= -15) return 'Sustained hard training. Easy sessions or rest recommended.';
  if (d >= -25) return 'Significant fatigue. Rest or very easy movement only.';
  return            'Sustained overload. Full rest days needed.';
}

// ── Coaching text ─────────────────────────────────────────────────────────────

// ── SVG watercolour background (shared with recovery) ─────────────────────────

function skyBackground(): string { return buildSkyBackground('frs', 'mint'); }

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

  // Include archived plans so the trend chart still has data immediately after
  // a plan reset (current `wks` only has the new plan's completed weeks).
  const archivedPlans = ((s as any).previousPlanWks ?? []) as Array<{ planStartDate: string; weeks: any[] }>;
  const sortedArchives = [...archivedPlans].sort((a, b) =>
    (a.planStartDate ?? '').localeCompare(b.planStartDate ?? ''),
  );
  for (const archive of sortedArchives) {
    for (const aw of (archive.weeks ?? [])) {
      const weekRawTSS = computeWeekRawTSS(aw as any, (aw as any).rated ?? {}, archive.planStartDate);
      ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY);
      atl = atl * ATL_DECAY + weekRawTSS * (1 - ATL_DECAY);
      results.push({ week: (aw as any).w, tss: weekRawTSS, ctl, atl, tsb: ctl - atl });
    }
  }

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

function tsbBarChart(entries: WeekTsbEntry[], liveTsbDaily?: number): string {
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

  // Note when live TSB differs from last completed week (fatigue clearing mid-week)
  if (liveTsbDaily != null && latest !== liveTsbDaily) {
    const diff = liveTsbDaily - latest;
    if (diff > 0) {
      commentary += ` Current freshness has improved to ${liveTsbDaily > 0 ? '+' : ''}${liveTsbDaily} as fatigue clears during the week.`;
    } else if (diff < -2) {
      commentary += ` Current freshness has dropped to ${liveTsbDaily} from load added this week.`;
    }
  }

  return `
    <div style="display:flex;gap:8px;align-items:stretch;padding:4px 0;overflow:visible">${bars}</div>
    <div style="font-size:12px;color:${TEXT_S};margin-top:8px;line-height:1.4">${commentary}</div>
  `;
}

// ── CTL vs ATL gauge card ─────────────────────────────────────────────────────

function fitnessVsFatigueCard(ctl: number, atl: number, tsbDisp: number): string {
  const ctlDisp = Math.round(ctl / 7);
  const atlDisp = Math.round(atl / 7);
  const maxVal = Math.max(ctlDisp, atlDisp, 1);

  const ctlPct = Math.round((ctlDisp / maxVal) * 100);
  const atlPct = Math.round((atlDisp / maxVal) * 100);

  // Derive balance from the canonical TSB so this matches the ring exactly.
  // Computing it as ctlDisp - atlDisp drifts by 1 from independent rounding.
  const balance = tsbDisp;
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
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));

  // Live TSB with intra-week decay through today (shared helper — matches home + readiness).
  const archivedPlans = (s as any).previousPlanWks ?? undefined;
  const liveTSB = computeLiveSameSignalTSB(s.wks ?? [], s.w ?? 1, s.signalBBaseline ?? undefined, s.ctlBaseline ?? undefined, s.planStartDate, archivedPlans);
  const atl = liveTSB.atl;
  const ctl = liveTSB.ctl;
  const tsb = liveTSB.tsb;

  // Fitness model for week count
  const metrics = computeFitnessModel(s.wks ?? [], completedWeek, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, undefined, archivedPlans);
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

  // ── Recovery countdown — two models ──────────────────────────────────────────
  //
  //  1. "To Baseline" — stacked session recovery (Garmin/Firstbeat-style).
  //     See computeToBaseline() in fitness-model.ts.
  //
  //  2. "To Fully Clear" — TSB-based: hours until TSB ≥ 0 (ATL decays to CTL).

  const ctlDaily = ctl / 7;

  const baseline = computeToBaseline(s.wks ?? [], completedWeek, ctlDaily, s.planStartDate, s.physiologyHistory);
  const sessionRecoveryHours = baseline?.hours ?? null;
  const sessionTotalHours = baseline?.totalHours ?? null;

  // Full Fresh: hours until TSB ≥ 0 (ATL decays to CTL)
  let freshHours: number | null = null;
  if (tsb < 0 && atl > ctl && ctl > 0) {
    const days = -7 * Math.log(ctl / atl);
    freshHours = Math.max(1, Math.round(days * 24));
  }

  function fmtDecay(hours: number | null): { str: string; unit: string } | null {
    if (hours == null || hours <= 0) return null;
    if (hours < 72) return { str: `${hours}`, unit: 'Hours' };
    return { str: `${Math.ceil(hours / 24)}`, unit: 'Days' };
  }
  const recoveryDecay = fmtDecay(sessionRecoveryHours);
  const freshDecay = fmtDecay(freshHours);

  // Recovery ring color based on absolute hours remaining (not percentage)
  // Thresholds reflect how concerning the remaining time is, not just progress
  function hoursToColor(hours: number | null, thresholds: [number, number, number]): string {
    if (hours == null || hours <= 0) return '#22C55E'; // green = done
    const [greenBelow, amberBelow, redAbove] = thresholds;
    const stops: [number, number, number][] = [
      [34, 197, 94],   // green  #22C55E
      [234, 179, 8],   // amber  #EAB308
      [249, 115, 22],  // orange #F97316
      [239, 68, 68],   // red    #EF4444
    ];
    let pct: number;
    if (hours <= greenBelow) pct = 0;
    else if (hours <= amberBelow) pct = 0.33 + 0.33 * ((hours - greenBelow) / (amberBelow - greenBelow));
    else if (hours <= redAbove) pct = 0.66 + 0.34 * ((hours - amberBelow) / (redAbove - amberBelow));
    else pct = 1;
    const t = pct * (stops.length - 1);
    const i = Math.min(Math.floor(t), stops.length - 2);
    const f = t - i;
    const r = Math.round(stops[i][0] + (stops[i + 1][0] - stops[i][0]) * f);
    const g = Math.round(stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f);
    const b = Math.round(stops[i][2] + (stops[i + 1][2] - stops[i][2]) * f);
    return `rgb(${r},${g},${b})`;
  }
  // Recovery: < 6h green, 6-16h amber, 16-30h orange, > 30h red
  const recoveryRingColor = hoursToColor(sessionRecoveryHours, [6, 16, 30]);
  // Full fresh: < 24h green, 24-48h amber, 48-96h orange, > 96h red
  const freshRingColor = hoursToColor(freshHours, [24, 48, 96]);

  // Status logic removed — explanations are now inline in the recovery card
  // alongside each number (baseline implication, fresh implication, TSB explanation).

  // Card builder
  const card = (title: string, content: string, delay: string) =>
    `<div class="f-fade" style="animation-delay:${delay};background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);margin-bottom:14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${TEXT_L};margin-bottom:14px">${title}</div>
      ${content}
    </div>`;

  return `
    <style>
      #fresh-view { box-sizing:border-box; }
      #fresh-view *, #fresh-view *::before, #fresh-view *::after { box-sizing:inherit; }
      @keyframes fFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .f-fade { opacity:0; animation:fFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('frs')}
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
        <div class="f-fade" style="animation-delay:0.08s;display:flex;flex-direction:column;align-items:center;margin:8px 0 28px">
          <div style="position:relative;width:220px;height:220px;display:flex;align-items:center;justify-content:center">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="freshGauge" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="${zone.color === '#22C55E' ? '#4ADE80' : zone.color === '#EF4444' ? '#F87171' : zone.color === '#F59E0B' ? '#FBBF24' : BLUE_A}"/>
                  <stop offset="100%" stop-color="${zone.color === '#22C55E' ? '#16A34A' : zone.color === '#EF4444' ? '#DC2626' : zone.color === '#F59E0B' ? '#D97706' : BLUE_D}"/>
                </linearGradient>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="rgba(255,255,255,0.85)" stroke="rgba(241,245,249,0.5)" stroke-width="8"/>
              <circle id="fresh-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="url(#freshGauge)"
                stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"
                style="transition:stroke-dashoffset 1.5s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
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
          <div style="font-size:13px;color:${TEXT_S};line-height:1.5;text-align:center;max-width:320px;margin:14px 16px 0">${tsbZoneDescription(tsb)}</div>
        </div>

        <!-- Recovery countdown -->
        ${(recoveryDecay || freshDecay) ? (() => {
          const maxHoursRecovery = 48;
          const maxHoursFresh = 96;

          function miniRing(hours: number | null, maxH: number, label: string, sublabel: string, color: string, decay: { str: string; unit: string } | null): string {
            if (!decay) return `
              <div style="text-align:center;flex:1">
                <div style="position:relative;width:64px;height:64px;margin:0 auto">
                  <svg viewBox="0 0 64 64" width="64" height="64" style="transform:rotate(-90deg)">
                    <circle cx="32" cy="32" r="27" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="5"/>
                  </svg>
                  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
                    <div style="font-size:13px;font-weight:600;color:var(--c-ok);line-height:1">0</div>
                  </div>
                </div>
                <div style="font-size:11px;font-weight:600;color:${TEXT_M};margin-top:6px">${label}</div>
                <div style="font-size:10px;color:${TEXT_S};margin-top:1px">${sublabel}</div>
              </div>`;
            const remaining = Math.min(hours ?? 0, maxH);
            const pct = remaining / maxH;
            const circ = 2 * Math.PI * 27;
            const offset = circ * (1 - pct);
            return `
              <div style="text-align:center;flex:1">
                <div style="position:relative;width:64px;height:64px;margin:0 auto">
                  <svg viewBox="0 0 64 64" width="64" height="64" style="transform:rotate(-90deg)">
                    <circle cx="32" cy="32" r="27" fill="none" stroke="rgba(0,0,0,0.06)" stroke-width="5"/>
                    <circle cx="32" cy="32" r="27" fill="none"
                      stroke="${color}" stroke-width="5" stroke-linecap="round"
                      stroke-dasharray="${circ.toFixed(1)}"
                      stroke-dashoffset="${offset.toFixed(1)}"
                    />
                  </svg>
                  <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">
                    <div style="font-size:16px;font-weight:700;color:${color};line-height:1">${decay.str}</div>
                    <div style="font-size:9px;font-weight:500;color:${TEXT_S};margin-top:1px">${decay.unit}</div>
                  </div>
                </div>
                <div style="font-size:11px;font-weight:600;color:${TEXT_M};margin-top:6px">${label}</div>
                <div style="font-size:10px;color:${TEXT_S};margin-top:1px">${sublabel}</div>
              </div>`;
          }

          // Build unified commentary tying all three numbers together
          const baselineStr = recoveryDecay
            ? `${recoveryDecay.str} ${recoveryDecay.unit.toLowerCase()}`
            : '0 hours';
          const freshStr = freshDecay
            ? `${freshDecay.str} ${freshDecay.unit.toLowerCase()}`
            : null;

          // Training direction based on combined state
          let direction: string;
          if (weeksOfData < 3) {
            direction = 'Freshness needs at least 3 completed weeks of training data. These numbers will stabilise as more sessions are logged.';
          } else if (sessionRecoveryHours == null || sessionRecoveryHours <= 0) {
            // At baseline — direction depends on chronic load
            if (tsbDisp >= 0) {
              direction = 'All fatigue cleared. Peak performance window for a key session or race.';
            } else if (tsbDisp >= -5) {
              direction = `Session fatigue cleared. ${freshStr ? `${freshStr} until fully clear.` : ''} Normal training can continue.`;
            } else if (tsbDisp >= -15) {
              direction = `Session fatigue cleared, but accumulated load is elevated at ${tsbLabel}. Easy or moderate sessions are fine. Avoid stacking hard efforts.${freshStr ? ` ${freshStr} until fully clear.` : ''}`;
            } else {
              direction = `Session fatigue cleared, but cumulative load is high at ${tsbLabel}. Easy sessions only. Hard efforts at this level do not produce useful adaptation.${freshStr ? ` ${freshStr} of easy training or rest to fully clear.` : ''}`;
            }
          } else if (sessionRecoveryHours <= 6) {
            direction = `${baselineStr} until recent session fatigue clears. Light activity is fine. Hard sessions best delayed.${freshStr ? ` ${freshStr} until all accumulated load clears.` : ''}`;
          } else if (sessionRecoveryHours <= 16) {
            direction = `${baselineStr} until recent session fatigue clears. Easy movement only. Avoid intensity.${freshStr ? ` ${freshStr} until fully clear.` : ''}`;
          } else {
            direction = `${baselineStr} of recovery needed from recent sessions. Rest or very easy movement. Hard sessions will not produce useful adaptation.${freshStr ? ` ${freshStr} until all accumulated load clears.` : ''}`;
          }

          return `
        <div class="f-fade" style="animation-delay:0.12s;padding:0 16px;margin-bottom:14px">
          <div style="background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
            <div style="display:flex;gap:12px;justify-content:center;margin-bottom:16px">
              ${miniRing(sessionRecoveryHours, maxHoursRecovery, 'To Baseline', 'Session fatigue', recoveryRingColor, recoveryDecay)}
              ${miniRing(freshHours, maxHoursFresh, 'Fully Clear', 'All fatigue', freshRingColor, freshDecay)}
            </div>
            <div style="font-size:13px;color:${TEXT_S};line-height:1.55">${direction}</div>
          </div>
        </div>`;
        })() : ''}

        <!-- Cards -->
        <div style="padding:0 16px">

          ${card('Weekly Trend', tsbBarChart(weeklyTsb, tsbDisp), '0.22s')}

          ${card('Fitness vs Fatigue', fitnessVsFatigueCard(ctl, atl, tsbDisp), '0.30s')}

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

function wireFreshnessHandlers(): void {
  // Animate ring
  setTimeout(() => {
    const circle = document.getElementById('fresh-ring-circle');
    const offset = circle?.getAttribute('stroke-dashoffset');
    if (circle) {
      // Read the target from our computed value
      const s = getState();
      const liveTSB = computeLiveSameSignalTSB(s.wks ?? [], s.w ?? 1, s.signalBBaseline ?? undefined, s.ctlBaseline ?? undefined, s.planStartDate, (s as any).previousPlanWks);
      const tsb = liveTSB.tsb;
      const tsbDisp = Math.round(tsb / 7);
      const ringPct = Math.min(100, Math.max(0, ((tsbDisp + 40) / 60) * 100));
      const target = +(RING_C * (1 - ringPct / 100)).toFixed(2);
      circle.style.strokeDashoffset = `${target}`;
    }
  }, 50);

  // Tab bar
  wireTabBarHandlers(navigateTab);

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
  // Tri mode: additively inject per-discipline Form so an athlete can see
  // whether their swim, bike, or run Form differs from the combined number.
  // Does NOT modify any of the running-mode rendering — pure DOM append.
  if (s.eventType === 'triathlon' && s.triConfig?.fitness) {
    injectTriPerDisciplineForm(s);
  }
}

function injectTriPerDisciplineForm(s: SimulatorState): void {
  const fit = s.triConfig?.fitness;
  if (!fit) return;
  // Anchor: insert AFTER the existing "Fitness vs Fatigue" card on the
  // freshness page so per-discipline Form sits next to per-discipline
  // CTL/ATL context. The freshness page uses `.f-fade` on each card.
  const cards = Array.from(document.querySelectorAll('.f-fade'));
  let anchor: Element | null = null;
  for (const el of cards) {
    if (el.textContent?.includes('Fitness vs Fatigue')) { anchor = el; break; }
  }
  // Fallback: insert after the last card if we can't find the named one.
  if (!anchor && cards.length > 0) anchor = cards[cards.length - 1];

  const TEXT_M = '#0F172A';
  const TEXT_L = '#94A3B8';

  // Common scale across all three disciplines so the tiny bars are comparable
  // (a Run with high CTL should clearly outweigh a Swim with low CTL visually).
  const maxScale = Math.max(
    1,
    fit.swim.ctl / 7, fit.swim.atl / 7,
    fit.bike.ctl / 7, fit.bike.atl / 7,
    fit.run.ctl  / 7, fit.run.atl  / 7,
  );

  const row = (sport: 'swim' | 'bike' | 'run', label: string) => {
    const f = fit[sport];
    const formD = f.tsb / 7;
    const ctlD = f.ctl / 7;
    const atlD = f.atl / 7;
    if (ctlD === 0 && atlD === 0) {
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-top:1px solid #F1F5F9">
          <span style="font-size:13px;font-weight:600;color:${TEXT_M}">${label}</span>
          <span style="font-size:12px;color:${TEXT_L}">No direct activity</span>
        </div>
      `;
    }
    const colour = formD < -10 ? '#EF4444' : formD < 0 ? '#F59E0B' : '#22C55E';
    const ctlPct = Math.round((ctlD / maxScale) * 100);
    const atlPct = Math.round((atlD / maxScale) * 100);
    return `
      <div style="padding:12px 0;border-top:1px solid #F1F5F9">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-size:13px;font-weight:600;color:${TEXT_M}">${label}</span>
          <span style="font-size:18px;font-weight:600;color:${colour};font-variant-numeric:tabular-nums">${formD >= 0 ? '+' : ''}${formD.toFixed(1)}</span>
        </div>
        <!-- tiny fitness bar (blue, matches the running Fitness vs Fatigue card colour) -->
        <div style="height:3px;background:#F1F5F9;border-radius:2px;overflow:hidden;margin-bottom:3px">
          <div style="height:100%;width:${ctlPct}%;background:#3B82F6;border-radius:2px"></div>
        </div>
        <!-- tiny fatigue bar (orange/amber) -->
        <div style="height:3px;background:#F1F5F9;border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${atlPct}%;background:#F59E0B;border-radius:2px"></div>
        </div>
      </div>
    `;
  };

  const insertedHTML = `
    <div class="f-fade" style="animation-delay:0.34s;background:white;border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);margin:0 16px 14px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${TEXT_L};margin-bottom:8px">Form by Discipline</div>
      <div style="font-size:12px;color:${TEXT_S};line-height:1.5;margin-bottom:6px">Each discipline's Fitness − Fatigue, separately. A single discipline can be carrying significant fatigue while another is fresh — useful when planning today's session.</div>
      ${row('swim', 'Swim')}
      ${row('bike', 'Bike')}
      ${row('run',  'Run')}
    </div>
  `;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = insertedHTML;
  const node = wrapper.firstElementChild;
  if (node && anchor?.parentNode) {
    anchor.parentNode.insertBefore(node, anchor.nextSibling);
  }
}
