/**
 * Rolling Load detail page — warm, card-based design.
 * Opens from the Rolling Load card on the Readiness view.
 * Shows 7-day rolling load, 28-day chart, zone breakdown, activity timeline.
 */

import { getState } from '@/state';
import type { SimulatorState } from '@/types/state';
import {
  computeACWR,
  getDailyLoadHistory,
  type DailyLoadEntry,
  type ZoneLoad,
} from '@/calculations/fitness-model';
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';
import { buildSkyBackground, skyAnimationCSS } from './sky-background';

// ── Design tokens ─────────────────────────────────────────────────────────────

const PAGE_BG  = '#FAF9F6';
const TEXT_M   = '#0F172A';
const TEXT_S   = '#64748B';
const TEXT_L   = '#94A3B8';

const CHART_STROKE = '#64748B';

const ZONE_LOW_AEROBIC  = '#67C9D0';
const ZONE_HIGH_AEROBIC = '#E8924C';
const ZONE_ANAEROBIC    = '#D06B98';

const CARD = `background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)`;

const AMBER_A   = '#E8924C';
const AMBER_B   = '#D97706';
const RING_R    = 46;
const RING_CIRC = +(2 * Math.PI * RING_R).toFixed(2);

// ── Date helpers ─────────────────────────────────────────────────────────────

function fmtDateCompact(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Dark hero gradient with integrated mountains ────────────────────────────

function heroBackground(): string { return buildSkyBackground('rl', 'deepBlue'); }

// ── Chart builder (sharp angular lines, HTML labels) ────────────────────────

function buildDailyLoadChart(entries: DailyLoadEntry[]): string {
  const n = entries.length;
  if (n < 2) return '';

  const CHART_FILL = 'rgba(100,116,139,0.12)';
  const W = 320, H = 65, padL = 6, padR = 6;
  const usableW = W - padL - padR;

  const vals = entries.map(e => e.tss);
  const maxVal = Math.max(...vals, 10) * 1.1;

  const xOf = (i: number) => padL + (n <= 1 ? usableW / 2 : i * usableW / (n - 1));
  const yOf = (v: number) => H - Math.max(2, (v / maxVal) * (H - 8));

  // Sharp angular polyline
  const pts: [number, number][] = entries.map((e, i) => [xOf(i), yOf(e.tss)]);
  const topPath = `M ${pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')}`;
  const areaPath = `${topPath} L ${xOf(n - 1).toFixed(1)} ${H} L ${xOf(0).toFixed(1)} ${H} Z`;

  // Grid lines (matching stats-view pattern)
  const gridStep = maxVal <= 50 ? 10 : maxVal <= 100 ? 25 : maxVal <= 200 ? 50 : 100;
  const gridLines: string[] = [];
  for (let v = gridStep; v <= maxVal * 0.95; v += gridStep) {
    const gy = yOf(v).toFixed(1);
    gridLines.push(`<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="rgba(0,0,0,0.05)" stroke-width="0.5"/>`);
  }

  // Y-axis labels
  const yAxisHtml: string[] = [];
  for (let v = gridStep; v <= maxVal * 0.95; v += gridStep) {
    yAxisHtml.push(`<span style="position:absolute;top:${(yOf(v) / H * 100).toFixed(1)}%;right:0;transform:translateY(-50%);font-size:9px;color:${TEXT_L};line-height:1;font-variant-numeric:tabular-nums">${v}</span>`);
  }

  // Day labels
  const labelStep = n > 20 ? 7 : n > 12 ? 4 : 1;
  const dayLabels = entries.map((e, i) => {
    if (i !== 0 && i !== n - 1 && i % labelStep !== 0) return '';
    const d = new Date(e.date + 'T12:00:00');
    const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const leftPct = ((xOf(i) / W) * 100).toFixed(1);
    const isCurrent = i === n - 1;
    return `<span style="position:absolute;left:${leftPct}%;transform:translateX(-50%);font-size:9px;color:${isCurrent ? TEXT_M : TEXT_L};font-weight:${isCurrent ? '600' : '400'};white-space:nowrap">${label}</span>`;
  }).join('');

  return `
    <div style="position:relative;padding-right:36px">
      <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
        ${gridLines.join('')}
        <path d="${areaPath}" fill="${CHART_FILL}" stroke="none"/>
        <path d="${topPath}" class="chart-draw" fill="none" stroke="${CHART_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <div style="position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none">${yAxisHtml.join('')}</div>
    </div>
    <div style="position:relative;height:18px;margin-top:4px;padding-right:36px">${dayLabels}</div>`;
}

// ── Activity list (last 7 days) ─────────────────────────────────────────────

function buildActivityList(entries: DailyLoadEntry[]): string {
  const recent = entries.slice(-7).reverse().filter(e => e.activities.length > 0);
  if (recent.length === 0) {
    return `<div style="font-size:13px;color:${TEXT_S};padding:8px 0">No activities in the last 7 days.</div>`;
  }

  return recent.map(day => {
    const d = new Date(day.date + 'T12:00:00');
    const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const actRows = day.activities.map(a => {
      const durLabel = a.durationMin >= 60
        ? `${Math.floor(a.durationMin / 60)}h ${a.durationMin % 60}m`
        : `${a.durationMin}m`;
      return `
        <div style="display:flex;align-items:center;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.04)">
          <div style="flex:1;font-size:13px;font-weight:500;color:${TEXT_M}">${a.name}</div>
          <div style="display:flex;gap:8px;align-items:center;font-size:12px;color:${TEXT_S}">
            <span>${durLabel}</span>
            <span style="color:${TEXT_L}">·</span>
            <span style="font-weight:500;font-variant-numeric:tabular-nums">${a.tss} TSS</span>
          </div>
        </div>`;
    }).join('');

    return `
      <div style="margin-bottom:4px">
        <div style="font-size:12px;color:${TEXT_S};font-weight:500;padding:8px 0 2px">${dayLabel}</div>
        ${actRows}
      </div>`;
  }).join('');
}

// ── Daily exercise load by zone (stacked bars) ──────────────────────────────

function buildDailyZoneBars(entries: DailyLoadEntry[]): string {
  const last7 = entries.slice(-7);
  const maxDayLoad = Math.max(...last7.map(e => e.tss), 10);
  const scaleTop = maxDayLoad > 200 ? Math.ceil(maxDayLoad / 100) * 100 : Math.ceil(maxDayLoad / 50) * 50;
  const BAR_H = 120;

  const bars = last7.map(e => {
    const d = new Date(e.date + 'T12:00:00');
    const dayLabel = ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getDay()];
    const { lowAerobic, highAerobic, anaerobic } = e.zoneLoad;
    const total = lowAerobic + highAerobic + anaerobic;
    const barTotal = Math.max(total, e.tss);

    if (barTotal < 1) {
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
        <div style="height:${BAR_H}px"></div>
        <div style="font-size:9px;color:${TEXT_L}">${dayLabel}</div>
      </div>`;
    }

    const barH = (barTotal / scaleTop) * BAR_H;
    const lowH = total > 0 ? (lowAerobic / barTotal) * barH : barH;
    const highH = total > 0 ? (highAerobic / barTotal) * barH : 0;
    const anaH = total > 0 ? (anaerobic / barTotal) * barH : 0;

    const tssLabel = Math.round(barTotal);
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
      <div style="height:${BAR_H}px;display:flex;flex-direction:column;justify-content:flex-end;width:100%;padding:0 3px">
        <div style="font-size:8px;font-weight:600;color:${TEXT_S};text-align:center;margin-bottom:2px;font-variant-numeric:tabular-nums">${tssLabel}</div>
        <div style="position:relative;display:flex;flex-direction:column;border-radius:4px;overflow:hidden">
          ${anaH > 0.5 ? `<div style="height:${anaH.toFixed(1)}px;background:${ZONE_ANAEROBIC};position:relative">${anaH >= 14 ? `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:600;color:rgba(255,255,255,0.85);font-variant-numeric:tabular-nums">${Math.round(anaerobic)}</span>` : ''}</div>` : ''}
          ${highH > 0.5 ? `<div style="height:${highH.toFixed(1)}px;background:${ZONE_HIGH_AEROBIC};position:relative">${highH >= 14 ? `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:600;color:rgba(255,255,255,0.85);font-variant-numeric:tabular-nums">${Math.round(highAerobic)}</span>` : ''}</div>` : ''}
          ${lowH > 0.5 ? `<div style="height:${lowH.toFixed(1)}px;background:${ZONE_LOW_AEROBIC};position:relative">${lowH >= 14 ? `<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:600;color:rgba(255,255,255,0.85);font-variant-numeric:tabular-nums">${Math.round(lowAerobic)}</span>` : ''}</div>` : ''}
        </div>
      </div>
      <div style="font-size:9px;color:${TEXT_L}">${dayLabel}</div>
    </div>`;
  }).join('');

  const legend = `<div style="display:flex;gap:14px;align-items:center">
    <div style="display:flex;align-items:center;gap:5px"><div style="width:8px;height:8px;border-radius:50%;background:${ZONE_ANAEROBIC}"></div><span style="font-size:11px;color:${TEXT_S}">Anaerobic</span></div>
    <div style="display:flex;align-items:center;gap:5px"><div style="width:8px;height:8px;border-radius:50%;background:${ZONE_HIGH_AEROBIC}"></div><span style="font-size:11px;color:${TEXT_S}">High Aerobic</span></div>
    <div style="display:flex;align-items:center;gap:5px"><div style="width:8px;height:8px;border-radius:50%;background:${ZONE_LOW_AEROBIC}"></div><span style="font-size:11px;color:${TEXT_S}">Low Aerobic</span></div>
  </div>`;

  return `
    ${legend}
    <div style="display:flex;gap:2px;margin-top:14px">${bars}</div>`;
}

// ── 4-week zone balance (horizontal bars with target ranges) ────────────────

function buildZoneBalance(entries: DailyLoadEntry[]): string {
  let totalLow = 0, totalHigh = 0, totalAna = 0;
  let activitiesWithZones = 0, activitiesTotal = 0;
  for (const e of entries) {
    totalLow += e.zoneLoad.lowAerobic;
    totalHigh += e.zoneLoad.highAerobic;
    totalAna += e.zoneLoad.anaerobic;
    for (const a of e.activities) {
      activitiesTotal++;
      if (a.hrZones && (a.hrZones.z1 + a.hrZones.z2 + a.hrZones.z3 + a.hrZones.z4 + a.hrZones.z5 > 0)) {
        activitiesWithZones++;
      }
    }
  }
  const totalAll = totalLow + totalHigh + totalAna;
  if (totalAll < 1) return '';

  const pctLow = totalLow / totalAll * 100;
  const pctHigh = totalHigh / totalAll * 100;
  const pctAna = totalAna / totalAll * 100;

  const targets = {
    lowAerobic:  { min: 40, max: 55 },
    highAerobic: { min: 30, max: 40 },
    anaerobic:   { min: 10, max: 20 },
  };

  const lowDelta = pctLow < targets.lowAerobic.min ? targets.lowAerobic.min - pctLow : pctLow > targets.lowAerobic.max ? pctLow - targets.lowAerobic.max : 0;
  const highDelta = pctHigh < targets.highAerobic.min ? targets.highAerobic.min - pctHigh : pctHigh > targets.highAerobic.max ? pctHigh - targets.highAerobic.max : 0;
  const anaDelta = pctAna < targets.anaerobic.min ? targets.anaerobic.min - pctAna : pctAna > targets.anaerobic.max ? pctAna - targets.anaerobic.max : 0;
  const maxDelta = Math.max(lowDelta, highDelta, anaDelta);

  let diagnosis: string;
  if (maxDelta < 5) {
    diagnosis = 'Balanced';
  } else if (lowDelta === maxDelta && pctLow < targets.lowAerobic.min) {
    diagnosis = 'Low Aer. Shortage';
  } else if (highDelta === maxDelta && pctHigh > targets.highAerobic.max) {
    diagnosis = 'High Aer. Surplus';
  } else if (highDelta === maxDelta && pctHigh < targets.highAerobic.min) {
    diagnosis = 'High Aer. Shortage';
  } else if (anaDelta === maxDelta && pctAna > targets.anaerobic.max) {
    diagnosis = 'Anaerobic Heavy';
  } else {
    diagnosis = 'Balanced';
  }

  const maxZoneVal = Math.max(totalLow, totalHigh, totalAna);

  const buildBar = (label: string, value: number, color: string, target: { min: number; max: number }) => {
    const barPct = maxZoneVal > 0 ? (value / maxZoneVal) * 100 : 0;
    const targetMinPct = maxZoneVal > 0 ? (totalAll * target.min / 100 / maxZoneVal) * 100 : 0;
    const targetMaxPct = maxZoneVal > 0 ? (totalAll * target.max / 100 / maxZoneVal) * 100 : 0;
    const valRounded = Math.round(value);
    const pct = totalAll > 0 ? value / totalAll * 100 : 0;
    const inTarget = pct >= target.min && pct <= target.max;

    return `<div style="margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
        <span style="font-size:13px;color:${TEXT_M};flex:1">${label}</span>
        <span style="font-size:14px;font-weight:600;color:${TEXT_M};font-variant-numeric:tabular-nums">${valRounded}</span>
      </div>
      <div style="position:relative;height:10px;border-radius:5px;background:rgba(0,0,0,0.04)">
        <div style="position:absolute;left:0;top:0;height:100%;width:${Math.min(barPct, 100).toFixed(1)}%;background:${color};border-radius:5px;opacity:0.75"></div>
        <div style="position:absolute;left:${targetMinPct.toFixed(1)}%;top:-2px;width:${(targetMaxPct - targetMinPct).toFixed(1)}%;height:calc(100% + 4px);border:1.5px dashed rgba(0,0,0,0.18);border-radius:5px;pointer-events:none"></div>
      </div>
      ${inTarget ? `<div style="text-align:center;margin-top:4px;font-size:10px;color:var(--c-ok);font-weight:500">Optimal</div>` : ''}
    </div>`;
  };

  return `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:16px">
      <div style="font-size:15px;font-weight:700;color:${TEXT_M}">4-Week Load Focus</div>
      <div style="font-size:14px;font-weight:600;color:${TEXT_M}">${diagnosis}</div>
    </div>
    ${buildBar('Anaerobic', totalAna, ZONE_ANAEROBIC, targets.anaerobic)}
    ${buildBar('High Aerobic', totalHigh, ZONE_HIGH_AEROBIC, targets.highAerobic)}
    ${buildBar('Low Aerobic', totalLow, ZONE_LOW_AEROBIC, targets.lowAerobic)}
    ${activitiesTotal > 0 && activitiesWithZones < activitiesTotal ? `<div style="font-size:11px;color:${TEXT_L};margin-top:8px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.05)">${activitiesWithZones} of ${activitiesTotal} activities have HR zone data. Activities without HR streams are attributed to Low Aerobic.</div>` : ''}`;
}

// ── Main HTML ────────────────────────────────────────────────────────────────

function getRollingLoadHTML(s: SimulatorState): string {
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(
    s.wks ?? [], s.w, s.athleteTier, s.ctlBaseline ?? undefined,
    s.planStartDate, atlSeed, atlSeed,
  );

  const rollingTSS = Math.round(acwr.atl);
  const chronicTSS = Math.round(acwr.ctl);
  const rollingLabel = rollingTSS > chronicTSS * 1.3 ? 'High'
    : rollingTSS > chronicTSS * 0.8 ? 'Normal' : 'Low';
  const heroColor = rollingTSS > chronicTSS * 1.3 ? '#C4553A'
    : rollingTSS > chronicTSS * 0.8 ? TEXT_M : TEXT_S;
  const pillBg = rollingTSS > chronicTSS * 1.3 ? 'rgba(196,85,58,0.10)'
    : rollingTSS > chronicTSS * 0.8 ? 'rgba(34,197,94,0.10)' : 'rgba(0,0,0,0.05)';
  const pillColor = rollingTSS > chronicTSS * 1.3 ? '#C4553A'
    : rollingTSS > chronicTSS * 0.8 ? '#15803D' : TEXT_S;

  const entries = s.planStartDate
    ? getDailyLoadHistory(s.wks ?? [], s.planStartDate, atlSeed, undefined, s.maxHR)
    : [];

  const chart = entries.length >= 2 ? buildDailyLoadChart(entries) : '';
  const hasZoneData = entries.some(e => e.zoneLoad.lowAerobic + e.zoneLoad.highAerobic + e.zoneLoad.anaerobic > 0);
  const dailyZoneBars = hasZoneData ? buildDailyZoneBars(entries) : '';
  const zoneBalance = hasZoneData ? buildZoneBalance(entries) : '';
  const activityList = entries.length > 0 ? buildActivityList(entries) : '';

  // Date range for header pill
  const dateRange = entries.length > 0
    ? `${fmtDateCompact(entries[0].date)} \u2013 ${fmtDateCompact(entries[entries.length - 1].date)}`
    : '';

  // Ring: 7-day load as % of chronic (100% = matching, 130% = full ring)
  const loadRatio = chronicTSS > 0 ? rollingTSS / chronicTSS : 0;
  const ringPct = Math.min(loadRatio / 1.3 * 100, 100); // 130% of chronic = full ring
  const ringOffset = +(RING_CIRC * (1 - ringPct / 100)).toFixed(2);
  const ringColor = rollingTSS > chronicTSS * 1.3 ? '#FF3B30'
    : rollingTSS > chronicTSS * 0.8 ? '#34C759'
    : '#94A3B8';

  return `
    <style>
      #rl-view { box-sizing:border-box; }
      #rl-view *, #rl-view *::before, #rl-view *::after { box-sizing:inherit; }
      @keyframes rlFloatUp { from { opacity:0; transform:translateY(16px) scale(0.97); } to { opacity:1; transform:translateY(0) scale(1); } }
      .rl-fade { opacity:0; animation:rlFloatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
      ${skyAnimationCSS('rl')}
    </style>

    <div id="rl-view" style="
      position:relative;min-height:100vh;background:${PAGE_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${heroBackground()}

      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header -->
        <div style="
          padding:56px 20px 12px;
          display:flex;align-items:center;justify-content:space-between;
          position:sticky;top:0;z-index:50;
        ">
          <button id="rl-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.8);backdrop-filter:blur(8px);
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div style="text-align:center">
            <div style="font-size:20px;font-weight:700;color:${TEXT_M}">Rolling Load</div>
            ${dateRange ? `<div style="font-size:12px;color:${TEXT_S};margin-top:3px;font-weight:500">${dateRange}</div>` : ''}
          </div>

          <div style="width:36px"></div>
        </div>

        <!-- Ring -->
        <div class="rl-fade" style="animation-delay:0.08s;display:flex;justify-content:center;margin:12px 0 28px">
          <div style="
            position:relative;width:220px;height:220px;
            display:flex;align-items:center;justify-content:center;
          ">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="rlRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stop-color="${AMBER_A}"/>
                  <stop offset="100%" stop-color="${AMBER_B}"/>
                </linearGradient>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="rgba(255,255,255,0.85)" stroke="rgba(241,245,249,0.5)" stroke-width="8"/>
              <circle id="rl-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="${ringColor === '#34C759' ? ringColor : ringColor === '#FF3B30' ? ringColor : 'url(#rlRingGrad)'}"
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
                <span style="font-size:48px;letter-spacing:-0.03em;line-height:1;font-weight:700">${rollingTSS}</span>
                <span style="font-size:14px;margin-left:3px;font-weight:400;color:${TEXT_S}">TSS</span>
              </div>
              <span style="color:${TEXT_S};font-size:12px;font-weight:500;margin-top:4px">${rollingLabel}</span>
              <span style="color:${TEXT_L};font-size:11px;margin-top:2px">28d avg: ${chronicTSS}</span>
            </div>
          </div>
        </div>

        <!-- Chart card -->
        ${chart ? `
        <div class="rl-fade" style="animation-delay:0.14s;padding:0 16px;margin-bottom:14px">
          <div style="${CARD};padding:20px">
            <div style="font-size:12px;color:${TEXT_S};margin-bottom:8px;font-weight:500">Daily load, 28 days</div>
            ${chart}
          </div>
        </div>` : ''}

        ${dailyZoneBars ? `
        <!-- Exercise load -->
        <div class="rl-fade" style="animation-delay:0.20s;padding:0 16px;margin-bottom:14px">
          <div style="${CARD};padding:20px">
            <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:14px">7-Day Exercise Load</div>
            ${dailyZoneBars}
          </div>
        </div>` : ''}

        ${zoneBalance ? `
        <!-- 4-week zone balance -->
        <div class="rl-fade" style="animation-delay:0.26s;padding:0 16px;margin-bottom:14px">
          <div style="${CARD};padding:20px">
            ${zoneBalance}
          </div>
        </div>` : ''}

        <!-- Activity breakdown -->
        <div class="rl-fade" style="animation-delay:0.32s;padding:0 16px;margin-bottom:24px">
          <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:8px;padding-left:4px">Last 7 days</div>
          <div style="${CARD};padding:16px 20px">
            ${activityList}
          </div>
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

// ── Event wiring ─────────────────────────────────────────────────────────────

function animateChartDrawOn(): void {
  requestAnimationFrame(() => {
    document.querySelectorAll<SVGPathElement>('path.chart-draw').forEach(path => {
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      path.getBoundingClientRect();
      path.style.transition = 'stroke-dashoffset 1.2s ease-out';
      path.style.strokeDashoffset = '0';
    });
  });
}

function wireRollingLoadHandlers(ringOffset: number): void {
  wireTabBarHandlers(navigateTab);

  // Animate ring
  setTimeout(() => {
    const circle = document.getElementById('rl-ring-circle') as SVGCircleElement | null;
    if (circle) circle.style.strokeDashoffset = String(ringOffset.toFixed(2));
  }, 50);

  animateChartDrawOn();

  document.getElementById('rl-back-btn')?.addEventListener('click', () => {
    import('./readiness-view').then(({ renderReadinessView }) => renderReadinessView());
  });
}

// ── Public entry point ───────────────────────────────────────────────────────

export function renderRollingLoadView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const html = getRollingLoadHTML(s);
  container.innerHTML = html;
  // Extract ringOffset from the rendered state
  const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
  const acwr = computeACWR(s.wks ?? [], s.w, s.athleteTier, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, atlSeed);
  const rollingTSS = Math.round(acwr.atl);
  const chronicTSS = Math.round(acwr.ctl);
  const loadRatio = chronicTSS > 0 ? rollingTSS / chronicTSS : 0;
  const ringPct = Math.min(loadRatio / 1.3 * 100, 100);
  const ringOffset = +(RING_CIRC * (1 - ringPct / 100)).toFixed(2);
  wireRollingLoadHandlers(ringOffset);
}
