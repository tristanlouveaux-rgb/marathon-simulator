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

// ── Design tokens ─────────────────────────────────────────────────────────────

const PAGE_BG  = '#FAF9F6';
const TEXT_M   = '#2C3131';
const TEXT_S   = '#6B7280';
const TEXT_L   = '#9CA3AF';

const CHART_STROKE = '#64748B';

const ZONE_LOW_AEROBIC  = '#67C9D0';
const ZONE_HIGH_AEROBIC = '#E8924C';
const ZONE_ANAEROBIC    = '#D06B98';

const CARD = `background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.04),0 6px 16px rgba(0,0,0,0.04)`;

// ── Date helpers ─────────────────────────────────────────────────────────────

function fmtDateCompact(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// ── Warm background (mountains + clouds) ────────────────────────────────────

function warmBackground(): string {
  return `
    <div style="position:absolute;top:0;left:0;width:100%;height:380px;overflow:hidden;pointer-events:none;z-index:0">
      <svg style="width:100%;height:100%" viewBox="0 0 400 380" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="rlSky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#DCC8AC"/>
            <stop offset="30%" stop-color="#E8D8C4"/>
            <stop offset="65%" stop-color="#F0E4D4"/>
            <stop offset="100%" stop-color="${PAGE_BG}"/>
          </linearGradient>
          <filter id="rlSoft"><feGaussianBlur stdDeviation="2.5"/></filter>
          <filter id="rlCloud"><feGaussianBlur stdDeviation="6"/></filter>
          <linearGradient id="rlMtn1" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(160,130,100,0.40)"/>
            <stop offset="100%" stop-color="rgba(175,150,125,0.15)"/>
          </linearGradient>
          <linearGradient id="rlMtn2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(170,140,110,0.30)"/>
            <stop offset="100%" stop-color="rgba(185,160,135,0.10)"/>
          </linearGradient>
        </defs>
        <!-- Sky -->
        <rect width="400" height="380" fill="url(#rlSky)"/>
        <!-- Sun glow -->
        <ellipse cx="310" cy="50" rx="60" ry="45" fill="rgba(255,230,190,0.55)" filter="url(#rlCloud)"/>
        <ellipse cx="310" cy="50" rx="30" ry="25" fill="rgba(255,240,210,0.40)" filter="url(#rlCloud)"/>
        <!-- Clouds -->
        <ellipse cx="60" cy="60" rx="60" ry="16" fill="rgba(255,255,255,0.65)" filter="url(#rlCloud)"/>
        <ellipse cx="110" cy="52" rx="45" ry="13" fill="rgba(255,255,255,0.55)" filter="url(#rlCloud)"/>
        <ellipse cx="220" cy="38" rx="50" ry="14" fill="rgba(255,255,255,0.50)" filter="url(#rlCloud)"/>
        <ellipse cx="350" cy="85" rx="40" ry="11" fill="rgba(255,255,255,0.45)" filter="url(#rlCloud)"/>
        <ellipse cx="160" cy="75" rx="30" ry="10" fill="rgba(255,255,255,0.35)" filter="url(#rlCloud)"/>
        <!-- Distant mountain range -->
        <path d="M-20,210 L30,160 L70,180 L120,135 L165,165 L210,130 L260,155 L310,120 L360,145 L420,115 L420,380 L-20,380 Z"
              fill="url(#rlMtn1)" filter="url(#rlSoft)"/>
        <!-- Mid-ground ridge -->
        <path d="M-20,240 L40,210 L90,228 L140,195 L200,218 L260,190 L330,212 L400,198 L420,205 L420,380 L-20,380 Z"
              fill="url(#rlMtn2)" filter="url(#rlSoft)"/>
        <!-- Foreground hills -->
        <path d="M-20,275 Q60,250 140,262 Q220,275 300,258 Q370,248 420,255 L420,380 L-20,380 Z"
              fill="rgba(195,172,148,0.15)"/>
      </svg>
      <div style="position:absolute;bottom:0;left:0;width:100%;height:100px;background:linear-gradient(to top,${PAGE_BG},transparent)"></div>
    </div>`;
}

// ── Chart builder (sharp angular lines, HTML labels) ────────────────────────

function buildDailyLoadChart(entries: DailyLoadEntry[], dailyAvg: number): string {
  const n = entries.length;
  if (n < 2) return '';

  const W = 320, H = 150;
  const padT = 12, padB = 6;
  const usableH = H - padT - padB;

  const vals = entries.map(e => e.tss);
  const maxVal = Math.max(...vals, dailyAvg * 1.1, 10);
  const scaleMax = maxVal > 200 ? Math.ceil(maxVal / 100) * 100
    : maxVal > 100 ? Math.ceil(maxVal / 50) * 50
    : Math.ceil(maxVal / 25) * 25;

  const xOf = (i: number) => (i / (n - 1)) * W;
  const yOf = (v: number) => padT + usableH - Math.max(0, (v / scaleMax) * usableH);

  // Sharp angular polyline
  const pts = entries.map((e, i) => `${xOf(i).toFixed(1)},${yOf(e.tss).toFixed(1)}`);
  const linePath = `M ${pts.join(' L ')}`;

  // Subtle grid lines
  const gridStep = scaleMax > 200 ? 100 : scaleMax > 100 ? 50 : 25;
  const gridLines: string[] = [];
  for (let v = gridStep; v <= scaleMax; v += gridStep) {
    const gy = yOf(v).toFixed(1);
    gridLines.push(`<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="rgba(0,0,0,0.05)" stroke-width="0.5"/>`);
  }

  // Average dashed line
  const avgY = yOf(dailyAvg).toFixed(1);

  // Y-axis labels (HTML-positioned, right-aligned outside chart)
  const yLabels: string[] = [];
  for (let v = gridStep; v <= scaleMax; v += gridStep) {
    const topPct = ((yOf(v) / H) * 100).toFixed(1);
    yLabels.push(`<span style="position:absolute;right:0;top:${topPct}%;transform:translateY(-50%);font-size:9px;color:${TEXT_L};font-variant-numeric:tabular-nums">${v}</span>`);
  }

  // Day labels (HTML-positioned)
  const dayLabels = entries.map((e, i) => {
    if (i !== 0 && i !== n - 1 && i % 7 !== 0) return '';
    const d = new Date(e.date + 'T12:00:00');
    const label = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const leftPct = ((xOf(i) / W) * 100).toFixed(1);
    return `<span style="position:absolute;left:${leftPct}%;transform:translateX(-50%);font-size:9px;color:${TEXT_L};white-space:nowrap">${label}</span>`;
  }).join('');

  // Chart area width excludes the y-label gutter
  return `
    <div style="position:relative;margin:8px 0 4px;padding-right:36px">
      <div style="position:relative">
        <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;overflow:visible">
          ${gridLines.join('')}
          <line x1="0" y1="${avgY}" x2="${W}" y2="${avgY}" stroke="rgba(0,0,0,0.12)" stroke-width="1" stroke-dasharray="4 3"/>
          <path d="${linePath}" fill="none" stroke="${CHART_STROKE}" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </div>
      <div style="position:absolute;top:0;right:0;width:36px;height:100%">${yLabels.join('')}</div>
      <div style="position:relative;height:18px;margin-top:6px">${dayLabels}</div>
    </div>`;
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
        <div style="display:flex;flex-direction:column;border-radius:4px;overflow:hidden">
          ${anaH > 0.5 ? `<div style="height:${anaH.toFixed(1)}px;background:${ZONE_ANAEROBIC}"></div>` : ''}
          ${highH > 0.5 ? `<div style="height:${highH.toFixed(1)}px;background:${ZONE_HIGH_AEROBIC}"></div>` : ''}
          ${lowH > 0.5 ? `<div style="height:${lowH.toFixed(1)}px;background:${ZONE_LOW_AEROBIC}"></div>` : ''}
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

  // Daily average for chart reference line
  const dailyAvg = entries.length > 0
    ? entries.reduce((sum, e) => sum + e.tss, 0) / entries.length
    : 0;

  const chart = entries.length >= 2 ? buildDailyLoadChart(entries, dailyAvg) : '';
  const hasZoneData = entries.some(e => e.zoneLoad.lowAerobic + e.zoneLoad.highAerobic + e.zoneLoad.anaerobic > 0);
  const dailyZoneBars = hasZoneData ? buildDailyZoneBars(entries) : '';
  const zoneBalance = hasZoneData ? buildZoneBalance(entries) : '';
  const activityList = entries.length > 0 ? buildActivityList(entries) : '';

  // Date range for header pill
  const dateRange = entries.length > 0
    ? `${fmtDateCompact(entries[0].date)} \u2013 ${fmtDateCompact(entries[entries.length - 1].date)}`
    : '';

  return `
    <div class="mosaic-page" style="background:${PAGE_BG};position:relative;overflow-y:auto">
      ${warmBackground()}

      <div style="position:relative;z-index:1;max-width:480px;margin:0 auto;padding:0 20px">
        <!-- Header -->
        <div style="padding:max(16px, env(safe-area-inset-top)) 0 12px;display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <button id="rl-back-btn" style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;font-size:18px;color:${TEXT_M};font-family:var(--f);margin-left:-8px">←</button>
            <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;color:${TEXT_M}">Rolling Load</div>
          </div>
          ${dateRange ? `<div style="font-size:11px;color:${TEXT_S};font-weight:500;padding:4px 10px;border-radius:100px;background:rgba(0,0,0,0.04)">${dateRange}</div>` : ''}
        </div>

        <!-- Hero card -->
        <div style="${CARD};padding:20px;margin:8px 0 16px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:${TEXT_S};margin-bottom:10px">7-Day Rolling Load</div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
            <span style="font-size:44px;font-weight:300;color:${heroColor};line-height:1;letter-spacing:-0.03em">${rollingTSS}</span>
            <span style="font-size:15px;color:${TEXT_S};font-weight:400">TSS</span>
            <span style="font-size:11px;font-weight:600;color:${pillColor};background:${pillBg};padding:3px 10px;border-radius:100px;margin-left:4px">${rollingLabel}</span>
          </div>
          <div style="font-size:13px;color:${TEXT_S}">28-day avg: ${chronicTSS} TSS</div>
          ${chart ? `<div style="margin-top:16px">${chart}</div>` : ''}
        </div>

        ${dailyZoneBars ? `
        <!-- Exercise load -->
        <div style="${CARD};padding:20px;margin-bottom:16px">
          <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:14px">Exercise Load</div>
          ${dailyZoneBars}
        </div>` : ''}

        ${zoneBalance ? `
        <!-- 4-week zone balance -->
        <div style="${CARD};padding:20px;margin-bottom:16px">
          ${zoneBalance}
        </div>` : ''}

        <!-- Activity breakdown -->
        <div style="margin-bottom:24px">
          <div style="font-size:15px;font-weight:700;color:${TEXT_M};margin-bottom:8px;padding-left:4px">Last 7 days</div>
          <div style="${CARD};padding:16px 20px">
            ${activityList}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Event wiring ─────────────────────────────────────────────────────────────

function wireRollingLoadHandlers(): void {
  document.getElementById('rl-back-btn')?.addEventListener('click', () => {
    import('./readiness-view').then(({ renderReadinessView }) => renderReadinessView());
  });
}

// ── Public entry point ───────────────────────────────────────────────────────

export function renderRollingLoadView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  container.innerHTML = getRollingLoadHTML(s);
  wireRollingLoadHandlers();
}
