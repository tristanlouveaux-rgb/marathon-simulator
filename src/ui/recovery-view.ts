/**
 * Recovery detail page — iPhone-native design language.
 * Opens when tapping the Readiness ring on the Home view.
 * Sky-blue watercolour landscape header, green palette, HRV/RHR/Sleep metrics.
 */

import { getState } from '@/state';
import type { SimulatorState, PhysiologyDayEntry } from '@/types/state';
import { computeRecoveryScore } from '@/calculations/readiness';

// ── Design tokens ─────────────────────────────────────────────────────────────

const APP_BG   = '#F8FAFC';
const GREEN_A  = '#4ADE80';
const GREEN_B  = '#22C55E';
const GREEN_D  = '#16A34A';
const TEXT_M   = '#0F172A';
const TEXT_S   = '#64748B';
const TEXT_L   = '#94A3B8';
const RING_R    = 46;
const RING_C    = +(2 * Math.PI * RING_R).toFixed(2); // ≈ 289.03
const MINI_R    = 20;
const MINI_CIRC = +(2 * Math.PI * MINI_R).toFixed(2);

// ── Date helpers ──────────────────────────────────────────────────────────────

function fmtDateLong(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function fmtDateShort(date: string, today: string): string {
  if (date === today) return 'Today';
  const yest = new Date(today + 'T12:00:00');
  yest.setDate(yest.getDate() - 1);
  if (date === yest.toISOString().split('T')[0]) return 'Yesterday';
  return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function fmtSleep(sec: number | null | undefined): string {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getLast7Days(today: string): string[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() - (6 - i));
    return d.toISOString().split('T')[0];
  });
}

// ── Sparklines ────────────────────────────────────────────────────────────────

/** Area+line sparkline path — returns { line, area } SVG path strings */
function sparklinePaths(values: number[], w = 120, h = 40): { line: string; area: string } {
  const valid = values.map(v => v > 0 ? v : null);
  const maxV = Math.max(...valid.filter(Boolean) as number[], 0.001);
  const pts: [number, number][] = valid.map((v, i) => [
    (i / Math.max(valid.length - 1, 1)) * w,
    h - ((v ?? 0) / maxV) * h * 0.85 + h * 0.075,
  ]);

  if (pts.length < 2) return { line: '', area: '' };

  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1];
    const [x2, y2] = pts[i];
    const mx = ((x1 + x2) / 2).toFixed(1);
    const my = ((y1 + y2) / 2).toFixed(1);
    d += ` Q${x1.toFixed(1)},${y1.toFixed(1)} ${mx},${my}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  d += ` T${lx.toFixed(1)},${ly.toFixed(1)}`;

  const area = `${d} L${lx.toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  return { line: d, area };
}

/** Larger 7-day chart paths (300×120 viewBox) */
function chartPaths(values: number[]): { line: string; area: string } {
  return sparklinePaths(values, 300, 120);
}

// ── Trend helpers ─────────────────────────────────────────────────────────────

interface TrendInfo { label: string; direction: 'up' | 'down' | 'flat'; statusLabel: string; statusColor: string; good: boolean }

function hrvTrend(values: number[], today: number | null): TrendInfo {
  if (!today || today === 0) return { label: '—', direction: 'flat', statusLabel: 'No data', statusColor: TEXT_L, good: false };
  const valids = values.filter(v => v > 0);
  if (valids.length < 2) return { label: '—', direction: 'flat', statusLabel: 'No data', statusColor: TEXT_L, good: false };
  const avg = valids.reduce((a, b) => a + b, 0) / valids.length;
  const pct = ((today - avg) / avg) * 100;
  if (pct > 5)  return { label: `+${pct.toFixed(0)}%`, direction: 'up',   statusLabel: 'Above baseline', statusColor: GREEN_D, good: true };
  if (pct < -5) return { label: `${pct.toFixed(0)}%`, direction: 'down',  statusLabel: 'Below baseline', statusColor: '#F59E0B', good: false };
  return           { label: 'Normal',              direction: 'flat',  statusLabel: 'Normal', statusColor: GREEN_D, good: true };
}

function rhrTrend(values: number[], today: number | null): TrendInfo {
  if (!today || today === 0) return { label: '—', direction: 'flat', statusLabel: 'No data', statusColor: TEXT_L, good: false };
  const valids = values.filter(v => v > 0);
  if (valids.length < 2) return { label: '—', direction: 'flat', statusLabel: 'No data', statusColor: TEXT_L, good: false };
  const avg = valids.reduce((a, b) => a + b, 0) / valids.length;
  const pct = ((today - avg) / avg) * 100;
  if (pct < -5) return { label: `${pct.toFixed(0)}%`, direction: 'down', statusLabel: 'Low (good)',      statusColor: GREEN_D, good: true };
  if (pct > 5)  return { label: `+${pct.toFixed(0)}%`, direction: 'up',  statusLabel: 'Elevated',        statusColor: '#F59E0B', good: false };
  return           { label: 'Normal',              direction: 'flat', statusLabel: 'Normal',           statusColor: GREEN_D, good: true };
}

function trendArrow(direction: 'up' | 'down' | 'flat'): string {
  const col = '#3B82F6';
  if (direction === 'up')   return `<div style="width:20px;height:20px;background:#EFF6FF;border-radius:4px;display:flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg></div>`;
  if (direction === 'down') return `<div style="width:20px;height:20px;background:#EFF6FF;border-radius:4px;display:flex;align-items:center;justify-content:center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div>`;
  return ``;
}

/** Small ring matching the main recovery ring style — score centred, label below. */
function miniRing(score: number | null, label: string): string {
  const pct    = score != null ? Math.min(Math.max(score, 0), 100) : 0;
  const offset = +(MINI_CIRC * (1 - pct / 100)).toFixed(2);
  const color  = score == null  ? '#E2E8F0'
    : score >= 70 ? GREEN_B
    : score >= 45 ? '#F59E0B'
    : '#EF4444';
  return `<div style="text-align:center">
    <div style="position:relative;width:52px;height:52px;margin:0 auto">
      <svg style="width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 52 52">
        <circle cx="26" cy="26" r="${MINI_R}" fill="rgba(255,255,255,0.9)" stroke="#F1F5F9" stroke-width="5"/>
        <circle cx="26" cy="26" r="${MINI_R}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"
          stroke-dasharray="${MINI_CIRC}" stroke-dashoffset="${offset}"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
        <span style="font-size:13px;font-weight:700;color:${score != null ? TEXT_M : TEXT_L}">${score != null ? score : '—'}</span>
      </div>
    </div>
    <div style="font-size:11px;color:${TEXT_L};margin-top:5px;letter-spacing:0.03em">${label}</div>
  </div>`;
}

function statusBadge(label: string, color: string): string {
  const isGood = color === GREEN_D;
  return `<div style="display:flex;align-items:center;gap:5px">
    <div style="width:16px;height:16px;border-radius:50%;background:${isGood ? GREEN_B : '#F59E0B'};display:flex;align-items:center;justify-content:center">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${isGood ? '<polyline points="20 6 9 17 4 12"/>' : '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'}</svg>
    </div>
    <span style="font-size:13px;font-weight:600;color:${color}">${label}</span>
  </div>`;
}

// ── Coaching card ─────────────────────────────────────────────────────────────

function coachingText(
  score: number | null,
  hrv: number | null,
  rhr: number | null,
  hrvTrendLabel: string,
  hrvSubScore: number | null,
): { headline: string; body: string } {
  if (score === null || (!hrv && !rhr)) {
    return { headline: 'No data available', body: 'Sync Garmin for recovery metrics. HRV and resting HR require at least 3 nights of data.' };
  }
  const hrvStr = hrv ? `${hrv.toFixed(1)} ms` : null;
  const rhrStr = rhr ? `${Math.round(rhr)} bpm` : null;

  // Detect the paradox: today's reading up but chronic trend still suppressed.
  // hrvTrendLabel starts with '+' when today is above the 7-day avg.
  const acuteUp       = !!hrvTrendLabel.startsWith('+');
  const chronicLow    = hrvSubScore != null && hrvSubScore < 65;
  const hrvParadox    = hrv != null && acuteUp && chronicLow;

  if (score >= 75) {
    return {
      headline: 'Recovery optimal',
      body: `${hrvStr ? `HRV at ${hrvStr}, ${hrvTrendLabel}.` : ''} ${rhrStr ? `Resting HR at ${rhrStr}.` : ''} Physiological markers indicate full recovery. Normal session load appropriate today.`.trim(),
    };
  }
  if (score >= 50) {
    const hrvLine = hrvParadox
      ? `HRV at ${hrvStr} — today's reading is up, but the 7-day trend remains below your personal norm.`
      : hrvStr ? `HRV at ${hrvStr}.` : '';
    return {
      headline: 'Adequate recovery',
      body: `${hrvLine} ${rhrStr ? `Resting HR at ${rhrStr}.` : ''} Recovery adequate for planned training. Avoid additional high-intensity work.`.trim(),
    };
  }
  const hrvLine = hrvParadox
    ? `HRV at ${hrvStr} — today's reading is up, but the 7-day trend remains suppressed below your personal norm.`
    : hrvStr ? `HRV at ${hrvStr}, below baseline.` : '';
  return {
    headline: 'Recovery limited',
    body: `${hrvLine} ${rhrStr ? `Resting HR at ${rhrStr}.` : ''} Elevated physiological load. Reduce session intensity or take a rest day.`.trim(),
  };
}

// ── SVG watercolour background ────────────────────────────────────────────────

function skyBackground(): string {
  return `
    <div style="position:absolute;top:0;left:0;width:100%;height:480px;overflow:hidden;pointer-events:none;z-index:0">
      <svg style="width:100%;height:100%" viewBox="0 0 400 480" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="skyGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#C5DFF8"/>
            <stop offset="30%" stop-color="#E3F0FA"/>
            <stop offset="70%" stop-color="#F0F7FC"/>
            <stop offset="100%" stop-color="#F8FAFC"/>
          </linearGradient>
          <linearGradient id="mountFar" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#8BB8D8" stop-opacity="0.6"/>
            <stop offset="60%" stop-color="#A8CDE8" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#E8F4FC" stop-opacity="0.05"/>
          </linearGradient>
          <linearGradient id="mountMid" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#6BA3C9" stop-opacity="0.75"/>
            <stop offset="50%" stop-color="#8FC4E3" stop-opacity="0.4"/>
            <stop offset="100%" stop-color="#C8E6F5" stop-opacity="0.1"/>
          </linearGradient>
          <linearGradient id="mountNear" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#5CB8A8" stop-opacity="0.5"/>
            <stop offset="40%" stop-color="#7ACCB8" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="#A8E0D4" stop-opacity="0.15"/>
          </linearGradient>
          <linearGradient id="mistLayer" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95"/>
            <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.5"/>
            <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="sunGlow" x1="50%" y1="50%" r="50%">
            <stop offset="0%" stop-color="#FFF8E7" stop-opacity="0.8"/>
            <stop offset="100%" stop-color="#FEF9E7" stop-opacity="0"/>
          </linearGradient>
          <filter id="softBlur"><feGaussianBlur stdDeviation="6"/></filter>
          <filter id="heavyBlur"><feGaussianBlur stdDeviation="20"/></filter>
          <filter id="wc"><feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="1.5"/></filter>
        </defs>
        <rect width="100%" height="100%" fill="url(#skyGrad)"/>
        <ellipse cx="200" cy="130" rx="100" ry="80" fill="url(#sunGlow)" filter="url(#softBlur)" opacity="0.7"/>
        <path d="M-60,190 Q20,150 80,180 T200,160 T350,170 T460,150 L460,480 L-60,480 Z" fill="url(#mountFar)" filter="url(#wc)"/>
        <ellipse cx="100" cy="210" rx="80" ry="25" fill="white" filter="url(#heavyBlur)" opacity="0.45"/>
        <ellipse cx="320" cy="195" rx="60" ry="20" fill="white" filter="url(#heavyBlur)" opacity="0.35"/>
        <path d="M-40,270 Q50,210 130,250 T280,220 T420,250 L420,480 L-40,480 Z" fill="url(#mountMid)" filter="url(#wc)"/>
        <ellipse cx="280" cy="285" rx="120" ry="40" fill="#FFFFFF" opacity="0.45" filter="url(#heavyBlur)"/>
        <path d="M-20,350 Q60,290 150,330 T320,310 T440,340 L440,480 L-20,480 Z" fill="url(#mountNear)" filter="url(#wc)"/>
        <path d="M0,370 Q100,330 200,370 T400,350 L400,480 L0,480 Z" fill="url(#mistLayer)" filter="url(#softBlur)"/>
        <path d="M0,410 Q150,390 300,420 T400,410 L400,480 L0,480 Z" fill="url(#mistLayer)" opacity="0.7" filter="url(#heavyBlur)"/>
        <ellipse cx="50" cy="90" rx="40" ry="15" fill="white" filter="url(#heavyBlur)" opacity="0.28"/>
        <ellipse cx="350" cy="110" rx="30" ry="12" fill="white" filter="url(#heavyBlur)" opacity="0.22"/>
      </svg>
      <div style="position:absolute;bottom:0;left:0;width:100%;height:120px;background:linear-gradient(to top,${APP_BG},transparent)"></div>
    </div>`;
}

// ── Main HTML ─────────────────────────────────────────────────────────────────

function getRecoveryHTML(s: SimulatorState, displayDate: string): string {
  const today = new Date().toISOString().split('T')[0];
  const history = s.physiologyHistory ?? [];

  // Recovery score — always today's composite
  const recoveryResult = computeRecoveryScore(history);
  const score = recoveryResult.score;
  const ringPct = Math.min(Math.max(score ?? 0, 0), 100);
  const targetOffset = +(RING_C * (1 - ringPct / 100)).toFixed(2);
  const ringColor = ringPct >= 70 ? GREEN_B : ringPct >= 45 ? '#F59E0B' : '#EF4444';

  // Selected date entry
  const entry: PhysiologyDayEntry | undefined = history.find(e => e.date === displayDate)
    ?? history[history.length - 1];

  // 7-day arrays for sparklines + charts (oldest → newest)
  const last7Dates = getLast7Days(today);
  const hrv7  = last7Dates.map(d => history.find(e => e.date === d)?.hrvRmssd ?? 0);
  const rhr7  = last7Dates.map(d => history.find(e => e.date === d)?.restingHR ?? 0);
  const day7Labels = last7Dates.map((d, i) => i === 6 ? 'Today' : new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }));

  // Entry may exist from step sync but lack HRV/RHR (Garmin pushes those later).
  // Fall back to the most recent entry that has the value. Do NOT fall back for
  // sleep — sleep is date-specific and should show "—" if missing.
  const todayHrv = entry?.hrvRmssd ?? [...history].reverse().find(e => e.hrvRmssd != null)?.hrvRmssd ?? null;
  const todayRhr = entry?.restingHR ?? [...history].reverse().find(e => e.restingHR != null)?.restingHR ?? null;
  const todaySleep = entry?.sleepScore ?? null;
  const todaySleepDur = entry?.sleepDurationSec ?? null;

  const { hrvDataSufficient, hrvScore: hrvSubScore, sleepScore: sleepSubScore, rhrScore: rhrSubScore } = recoveryResult;
  const hrvT = hrvTrend(hrv7, todayHrv);
  const rhrT = rhrTrend(rhr7, todayRhr);

  // Sparklines for tiles
  const { line: hrvLine, area: hrvArea } = sparklinePaths(hrv7);
  const { line: rhrLine, area: rhrArea } = sparklinePaths(rhr7);

  // Large chart paths
  const { line: hrvChartLine, area: hrvChartArea } = chartPaths(hrv7);
  const { line: rhrChartLine, area: rhrChartArea } = chartPaths(rhr7);

  // Coaching
  const { headline: coachHead, body: coachBody } = coachingText(score, todayHrv, todayRhr, hrvT.label, hrvSubScore);

  // Sleep label + progress
  const sleepLabel = todaySleep == null ? null
    : todaySleep >= 85 ? 'Optimal' : todaySleep >= 65 ? 'Good' : 'Low';
  const sleepBadgeColor = sleepLabel === 'Optimal' ? '#8B5CF6' : sleepLabel === 'Good' ? '#3B82F6' : '#F59E0B';

  // Date pills
  const sevenDays = getLast7Days(today);
  const datePills = sevenDays.map(d => {
    const active = d === displayDate;
    return `<button class="rec-date-pill" data-date="${d}" style="
      padding:5px 14px;border-radius:100px;border:none;cursor:pointer;
      font-size:13px;font-weight:${active ? '600' : '400'};font-family:var(--f);
      background:${active ? 'rgba(34,197,94,0.15)' : 'transparent'};
      color:${active ? GREEN_D : TEXT_S};
      white-space:nowrap;transition:background 0.15s;
    ">${fmtDateShort(d, today)}</button>`;
  }).join('');

  // 7-day averages and 28-day baselines — mirrors what computeRecoveryScore uses for scoring.
  const baseline28 = history.slice(-28);
  const hrvLast = hrv7.filter(v => v > 0);
  const hrvAvg = hrvLast.length > 0 ? hrvLast.reduce((a, b) => a + b, 0) / hrvLast.length : null;
  const rhrLast = rhr7.filter(v => v > 0);
  const rhrAvg = rhrLast.length > 0 ? rhrLast.reduce((a, b) => a + b, 0) / rhrLast.length : null;

  const baselineHrvs = baseline28.map(d => d.hrvRmssd).filter((v): v is number => v != null && v > 0);
  const baselineRhrs = baseline28.map(d => d.restingHR).filter((v): v is number => v != null && v > 0);
  const baselineHrvAvg = baselineHrvs.length >= 3 ? baselineHrvs.reduce((a, b) => a + b, 0) / baselineHrvs.length : null;
  const baselineRhrAvg = baselineRhrs.length >= 3 ? baselineRhrs.reduce((a, b) => a + b, 0) / baselineRhrs.length : null;

  const hrvVsBaseline = hrvAvg != null && baselineHrvAvg != null ? ((hrvAvg - baselineHrvAvg) / baselineHrvAvg * 100) : null;
  const rhrVsBaseline = rhrAvg != null && baselineRhrAvg != null ? (rhrAvg - baselineRhrAvg) : null;

  // HRV tile: chronic badge (driven by score, not acute delta) + context line vs 28-day baseline.
  const hrvChronicBadge = hrvSubScore == null ? null
    : hrvSubScore >= 65 ? { label: 'Normal', color: GREEN_D }
    : hrvSubScore >= 45 ? { label: 'Slightly suppressed', color: '#F59E0B' }
    : { label: 'Below personal norm', color: '#F59E0B' };
  const hrvAcuteStr = hrvVsBaseline != null
    ? `7-day avg ${hrvVsBaseline > 0 ? '+' : ''}${hrvVsBaseline.toFixed(0)}% vs 28-day baseline`
    : null;

  // RHR tile: same pattern — chronic badge from score, context line shows 7-day avg vs 28-day baseline.
  // rhrSubScore is inverted (lower RHR = better), so score < 65 means RHR is elevated vs baseline.
  const rhrChronicBadge = rhrSubScore == null ? null
    : rhrSubScore >= 65 ? { label: 'Normal', color: GREEN_D }
    : rhrSubScore >= 45 ? { label: 'Slightly elevated', color: '#F59E0B' }
    : { label: 'Elevated vs baseline', color: '#F59E0B' };
  const rhrAcuteStr = rhrVsBaseline != null
    ? `7-day avg ${rhrVsBaseline > 0 ? '+' : ''}${rhrVsBaseline.toFixed(0)} bpm vs 28-day baseline`
    : null;

  const dayLabelRow = day7Labels.map(l => `<span style="font-size:10px;font-weight:500;color:${TEXT_L};letter-spacing:0.04em;text-transform:uppercase">${l}</span>`).join('');

  return `
    <style>
      #rec-view { box-sizing:border-box; }
      #rec-view *, #rec-view *::before, #rec-view *::after { box-sizing:inherit; }
      @keyframes recFloatUp { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      .r-fade { opacity:0; animation:recFloatUp 0.55s ease-out forwards; }
      .rec-date-pill:hover { background:rgba(34,197,94,0.1)!important; }
    </style>

    <div id="rec-view" style="
      position:relative;min-height:100vh;background:${APP_BG};
      font-family:var(--f);overflow-x:hidden;
    ">
      ${skyBackground()}

      <div style="position:relative;z-index:10;padding-bottom:48px">

        <!-- Header -->
        <div style="padding:56px 20px 12px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50">
          <button id="rec-back-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:${TEXT_M};
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>

          <div style="text-align:center">
            <div style="font-size:20px;font-weight:700;color:${TEXT_M};letter-spacing:-0.01em">Recovery</div>
            <button id="rec-date-btn" style="
              display:flex;align-items:center;gap:4px;margin:3px auto 0;
              font-size:12px;color:${TEXT_S};font-weight:500;
              background:none;border:none;cursor:pointer;font-family:var(--f);
            ">
              ${fmtDateLong(displayDate)}
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>

          <button id="rec-info-btn" style="
            width:36px;height:36px;border-radius:50%;border:none;cursor:pointer;
            background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);
            display:flex;align-items:center;justify-content:center;color:${TEXT_S};
            box-shadow:0 1px 4px rgba(0,0,0,0.08);
            border:1px solid rgba(203,213,225,0.6);
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="1"/></svg>
          </button>
        </div>

        <!-- Date picker -->
        <div id="rec-date-picker" style="
          display:none;overflow-x:auto;padding:0 16px 12px;
          scrollbar-width:none;-ms-overflow-style:none;
        ">
          <div style="display:flex;gap:6px;width:max-content;padding-bottom:2px">${datePills}</div>
        </div>

        <!-- Recovery ring -->
        <div class="r-fade" style="animation-delay:0.08s;display:flex;justify-content:center;margin:8px 0 28px">
          <div style="position:relative;width:220px;height:220px;display:flex;align-items:center;justify-content:center">
            <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="recGauge" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#34D399"/>
                  <stop offset="100%" stop-color="#84CC16"/>
                </linearGradient>
                <filter id="recGlow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="4" result="blur"/>
                  <feComposite in="SourceGraphic" in2="blur" operator="over"/>
                </filter>
              </defs>
              <circle cx="50" cy="50" r="${RING_R}" fill="rgba(255,255,255,0.85)" stroke="rgba(241,245,249,0.5)" stroke-width="8"/>
              <circle id="rec-ring-circle" cx="50" cy="50" r="${RING_R}" fill="none"
                stroke="${score != null ? 'url(#recGauge)' : 'rgba(0,0,0,0.08)'}"
                stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"
                style="transition:stroke-dashoffset 1.5s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"
                ${score != null ? 'filter="url(#recGlow)"' : ''}
              />
            </svg>
            <div style="
              position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;
              background:rgba(255,255,255,0.95);backdrop-filter:blur(8px);
              width:180px;height:180px;border-radius:50%;
              box-shadow:inset 0 2px 8px rgba(0,0,0,0.03);border:1px solid rgba(255,255,255,0.5);
            ">
              <div style="display:flex;align-items:flex-start;color:${ringColor};margin-top:8px">
                <span style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1">${score != null ? Math.round(ringPct) : '—'}</span>
                ${score != null ? `<span style="font-size:22px;font-weight:700;line-height:1;margin-top:4px">%</span>` : ''}
              </div>
              <span style="font-size:14px;font-weight:500;color:${TEXT_S};margin-top:2px">recovered</span>
            </div>
          </div>
        </div>

        <!-- Sub-scores row -->
        ${recoveryResult.hasData ? `
        <div class="r-fade" style="animation-delay:0.14s;display:flex;justify-content:center;gap:28px;margin:-8px 0 24px">
          ${hrvSubScore != null ? miniRing(hrvSubScore, 'HRV') : ''}
          ${sleepSubScore != null ? miniRing(sleepSubScore, 'Sleep') : ''}
          ${rhrSubScore != null ? miniRing(rhrSubScore, 'RHR') : ''}
        </div>` : ''}

        <!-- HRV + RHR tiles -->
        <div class="r-fade" style="animation-delay:0.18s;padding:0 16px;display:flex;gap:14px;margin-bottom:14px">

          <!-- HRV tile -->
          <div style="flex:1;background:white;border-radius:24px;padding:16px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.03),0 0 3px rgba(0,0,0,0.02)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${TEXT_L}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              <span style="font-size:14px;font-weight:600;color:${TEXT_S}">Resting HRV</span>
            </div>
            <div style="display:flex;align-items:baseline;gap:4px;margin-bottom:4px">
              <span style="font-size:24px;font-weight:700;color:${TEXT_M};letter-spacing:-0.02em;line-height:1">${todayHrv != null ? todayHrv.toFixed(1) : '—'}</span>
              ${todayHrv != null ? `<span style="font-size:13px;font-weight:500;color:${TEXT_S}">ms</span>` : ''}
              <div style="margin-left:auto">${trendArrow(hrvT.direction)}</div>
            </div>
            ${hrvChronicBadge ? statusBadge(hrvChronicBadge.label, hrvChronicBadge.color) : ''}
            ${hrvAcuteStr ? `<div style="font-size:11px;color:${TEXT_L};margin-top:4px">${hrvAcuteStr}</div>` : ''}
            <div style="height:40px;margin-top:10px;margin-left:-4px;margin-right:-4px">
              ${hrvLine ? `<svg viewBox="0 0 120 40" style="width:100%;height:100%;overflow:visible" preserveAspectRatio="none">
                <defs><linearGradient id="hrvFillMini" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${GREEN_A}" stop-opacity="0.25"/><stop offset="100%" stop-color="${GREEN_A}" stop-opacity="0"/></linearGradient></defs>
                <path d="${hrvArea}" fill="url(#hrvFillMini)"/>
                <path d="${hrvLine}" fill="none" stroke="${GREEN_A}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>` : `<div style="color:${TEXT_L};font-size:11px;padding-top:12px">No data</div>`}
            </div>
            ${todayHrv != null && !hrvDataSufficient ? `<div style="font-size:11px;color:${TEXT_L};margin-top:6px;line-height:1.4">Score improves after 10 nights of data.</div>` : ''}
          </div>

          <!-- RHR tile -->
          <div style="flex:1;background:white;border-radius:24px;padding:16px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.03),0 0 3px rgba(0,0,0,0.02)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="${TEXT_L}" stroke="${TEXT_L}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              <span style="font-size:14px;font-weight:600;color:${TEXT_S}">Resting HR</span>
            </div>
            <div style="display:flex;align-items:baseline;gap:4px;margin-bottom:4px">
              <span style="font-size:24px;font-weight:700;color:${TEXT_M};letter-spacing:-0.02em;line-height:1">${todayRhr != null ? Math.round(todayRhr) : '—'}</span>
              ${todayRhr != null ? `<span style="font-size:13px;font-weight:500;color:${TEXT_S}">bpm</span>` : ''}
              <div style="margin-left:auto">${trendArrow(rhrT.direction)}</div>
            </div>
            ${rhrChronicBadge ? statusBadge(rhrChronicBadge.label, rhrChronicBadge.color) : ''}
            ${rhrAcuteStr ? `<div style="font-size:11px;color:${TEXT_L};margin-top:4px">${rhrAcuteStr}</div>` : ''}
            <div style="height:40px;margin-top:10px;margin-left:-4px;margin-right:-4px">
              ${rhrLine ? `<svg viewBox="0 0 120 40" style="width:100%;height:100%;overflow:visible" preserveAspectRatio="none">
                <defs><linearGradient id="rhrFillMini" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${GREEN_A}" stop-opacity="0.25"/><stop offset="100%" stop-color="${GREEN_A}" stop-opacity="0"/></linearGradient></defs>
                <path d="${rhrArea}" fill="url(#rhrFillMini)"/>
                <path d="${rhrLine}" fill="none" stroke="${GREEN_A}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>` : `<div style="color:${TEXT_L};font-size:11px;padding-top:12px">No data</div>`}
            </div>
          </div>
        </div>

        <!-- Sleep card -->
        ${todaySleep != null || todaySleepDur != null ? `
        <div class="r-fade" style="animation-delay:0.25s;padding:0 16px;margin-bottom:14px">
          <div id="rec-sleep-card" style="background:white;border-radius:24px;padding:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.03),0 0 3px rgba(0,0,0,0.02);cursor:pointer">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
              <div style="display:flex;align-items:center;gap:8px">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                <span style="font-size:16px;font-weight:700;color:${TEXT_M}">Sleep Score</span>
              </div>
              ${sleepLabel ? `<div style="background:${sleepBadgeColor}18;color:${sleepBadgeColor};padding:3px 10px;border-radius:100px;font-size:12px;font-weight:600">${sleepLabel}</div>` : ''}
            </div>
            <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:16px">
              <div style="display:flex;align-items:baseline;gap:6px">
                <span style="font-size:32px;font-weight:700;color:${TEXT_M};line-height:1">${todaySleep != null ? Math.round(todaySleep) : '—'}</span>
                ${todaySleep != null ? `<span style="font-size:14px;font-weight:500;color:${TEXT_S}">/ 100</span>` : ''}
              </div>
              ${todaySleepDur != null ? `<div style="text-align:right">
                <div style="font-size:14px;font-weight:500;color:${TEXT_M}">${fmtSleep(todaySleepDur)}</div>
                <div style="font-size:12px;color:${TEXT_S}">Total sleep</div>
              </div>` : ''}
            </div>
            ${todaySleep != null ? `<div style="width:100%;background:#F1F5F9;height:8px;border-radius:100px;overflow:hidden">
              <div style="width:${Math.min(todaySleep, 100)}%;height:100%;background:#8B5CF6;border-radius:100px;position:relative">
                <div style="position:absolute;inset:0;background:rgba(255,255,255,0.2)"></div>
              </div>
            </div>` : ''}
          </div>
        </div>` : ''}

        <!-- Coaching card -->
        <div class="r-fade" style="animation-delay:0.32s;padding:0 16px;margin-bottom:20px">
          <div style="
            background:rgba(255,255,255,0.9);backdrop-filter:blur(12px);
            border-radius:24px;padding:20px;
            box-shadow:0 10px 40px -10px rgba(224,242,254,0.5),0 4px 20px -2px rgba(0,0,0,0.03);
            border:1px solid rgba(255,255,255,0.6);
          ">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
              <div style="font-size:16px;font-weight:700;color:${TEXT_M}">${coachHead}</div>
            </div>
            <p style="font-size:14px;line-height:1.6;color:${TEXT_M};font-weight:500;margin:0;opacity:0.9">${coachBody}</p>
          </div>
        </div>

        <!-- Detailed metrics -->
        <div class="r-fade" style="animation-delay:0.40s;padding:0 16px">
          <h2 style="font-size:17px;font-weight:700;color:${TEXT_M};margin:0 0 16px 2px;letter-spacing:-0.01em">Detailed Metrics</h2>

          <!-- HRV chart -->
          ${hrvChartLine ? `<div style="background:white;border-radius:24px;padding:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.03),0 0 3px rgba(0,0,0,0.02);margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
              <div>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${TEXT_S}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                  <span style="font-size:15px;font-weight:600;color:${TEXT_M}">Heart Rate Variability</span>
                </div>
                <div style="display:flex;align-items:baseline;gap:4px">
                  <span style="font-size:28px;font-weight:700;color:${TEXT_M}">${todayHrv != null ? todayHrv.toFixed(1) : '—'}</span>
                  <span style="font-size:14px;font-weight:500;color:${TEXT_S}">ms</span>
                </div>
              </div>
              ${hrvVsBaseline != null ? `<div style="background:${hrvVsBaseline >= 0 ? '#F0FDF4' : '#FEF3C7'};color:${hrvVsBaseline >= 0 ? GREEN_D : '#92400E'};padding:4px 8px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase">
                ${hrvVsBaseline >= 0 ? '+' : ''}${hrvVsBaseline.toFixed(1)}% vs baseline
              </div>` : ''}
            </div>
            <div style="height:120px;position:relative">
              <svg width="100%" height="100%" viewBox="0 0 300 120" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="hrvChartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${GREEN_A}" stop-opacity="0.25"/><stop offset="100%" stop-color="${GREEN_A}" stop-opacity="0.05"/></linearGradient>
                  <linearGradient id="hrvChartLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#86EFAC"/><stop offset="100%" stop-color="${GREEN_B}"/></linearGradient>
                </defs>
                <g stroke="#F1F5F9" stroke-width="1" stroke-dasharray="4 4"><line x1="0" y1="20" x2="300" y2="20"/><line x1="0" y1="60" x2="300" y2="60"/><line x1="0" y1="100" x2="300" y2="100"/></g>
                <path d="${hrvChartArea}" fill="url(#hrvChartFill)"/>
                <path d="${hrvChartLine}" fill="none" stroke="url(#hrvChartLine)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:8px;padding:0 2px">${dayLabelRow}</div>
          </div>` : ''}

          <!-- RHR chart -->
          ${rhrChartLine ? `<div style="background:white;border-radius:24px;padding:20px;box-shadow:0 4px 20px -2px rgba(0,0,0,0.03),0 0 3px rgba(0,0,0,0.02);margin-bottom:20px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
              <div>
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="${TEXT_S}" stroke="${TEXT_S}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  <span style="font-size:15px;font-weight:600;color:${TEXT_M}">Resting Heart Rate</span>
                </div>
                <div style="display:flex;align-items:baseline;gap:4px">
                  <span style="font-size:28px;font-weight:700;color:${TEXT_M}">${todayRhr != null ? Math.round(todayRhr) : '—'}</span>
                  <span style="font-size:14px;font-weight:500;color:${TEXT_S}">bpm</span>
                </div>
              </div>
              ${rhrVsBaseline != null ? `<div style="background:${rhrVsBaseline <= 0 ? '#F0FDF4' : '#FEF3C7'};color:${rhrVsBaseline <= 0 ? GREEN_D : '#92400E'};padding:4px 8px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase">
                ${rhrVsBaseline >= 0 ? '+' : ''}${rhrVsBaseline.toFixed(1)} bpm vs baseline
              </div>` : ''}
            </div>
            <div style="height:120px;position:relative">
              <svg width="100%" height="100%" viewBox="0 0 300 120" preserveAspectRatio="none">
                <defs><linearGradient id="rhrChartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${GREEN_A}" stop-opacity="0.25"/><stop offset="100%" stop-color="${GREEN_A}" stop-opacity="0.05"/></linearGradient></defs>
                <g stroke="#F1F5F9" stroke-width="1" stroke-dasharray="4 4"><line x1="0" y1="20" x2="300" y2="20"/><line x1="0" y1="60" x2="300" y2="60"/><line x1="0" y1="100" x2="300" y2="100"/></g>
                <path d="${rhrChartArea}" fill="url(#rhrChartFill)"/>
                <path d="${rhrChartLine}" fill="none" stroke="${GREEN_B}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:8px;padding:0 2px">${dayLabelRow}</div>
          </div>` : ''}

          <!-- Sleep detail CTA -->
          <button id="rec-sleep-btn" style="
            width:100%;background:white;border-radius:20px;padding:16px 18px;
            display:flex;justify-content:space-between;align-items:center;
            box-shadow:0 4px 20px -2px rgba(0,0,0,0.03);border:none;cursor:pointer;
            font-family:var(--f);transition:box-shadow 0.15s;
          ">
            <div style="display:flex;align-items:center;gap:12px">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${TEXT_M}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              <span style="font-size:15px;font-weight:700;color:${TEXT_M}">View Sleep Details</span>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${TEXT_S}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>

      </div>
    </div>
  `;
}

// ── Info overlay ──────────────────────────────────────────────────────────────

function showRecoveryInfoOverlay(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,0.4)';
  overlay.innerHTML = `
    <div style="background:white;border-radius:24px;padding:24px;max-width:380px;width:100%">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="font-size:17px;font-weight:700;margin:0;color:${TEXT_M}">What is Recovery?</h2>
        <button id="rec-info-close" style="border:none;background:rgba(0,0,0,0.07);border-radius:50%;width:32px;height:32px;cursor:pointer;color:${TEXT_S};display:flex;align-items:center;justify-content:center;font-size:16px">✕</button>
      </div>
      <p style="font-size:14px;line-height:1.6;color:${TEXT_S};margin:0 0 12px">
        Recovery is a composite score (0–100) based on three signals: HRV (45%), sleep quality (35%), and resting heart rate (20%).
      </p>
      <p style="font-size:14px;line-height:1.6;color:${TEXT_S};margin:0 0 16px">
        All scores are relative to your own 28-day baseline, not population norms. A score of 73% means your body is 73% recovered relative to your personal optimal.
      </p>
      <div style="background:#F0FDF4;border-radius:14px;padding:14px">
        <div style="font-size:11px;font-weight:600;color:${GREEN_D};margin-bottom:10px;letter-spacing:0.05em">SCORE ZONES</div>
        <div style="font-size:13px;color:${TEXT_S};line-height:2">
          <div><strong style="color:${TEXT_M}">75–100</strong> — Optimal. Full session appropriate.</div>
          <div><strong style="color:${TEXT_M}">50–74</strong> — Adequate. Planned training is fine.</div>
          <div><strong style="color:${TEXT_M}">25–49</strong> — Partial. Reduce intensity.</div>
          <div><strong style="color:${TEXT_M}">0–24</strong> — Limited. Rest or very easy movement only.</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('rec-info-close')?.addEventListener('click', () => overlay.remove());
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function wireRecoveryHandlers(s: SimulatorState, displayDate: string): void {
  const recoveryResult = computeRecoveryScore(s.physiologyHistory ?? []);
  const ringPct = Math.min(Math.max(recoveryResult.score ?? 0, 0), 100);

  // Animate ring
  setTimeout(() => {
    const circle = document.getElementById('rec-ring-circle') as SVGCircleElement | null;
    if (circle && recoveryResult.score != null) {
      circle.style.strokeDashoffset = String((RING_C * (1 - ringPct / 100)).toFixed(2));
    }
  }, 50);

  // Back → home
  document.getElementById('rec-back-btn')?.addEventListener('click', () => {
    import('./home-view').then(({ renderHomeView }) => renderHomeView());
  });

  // Date picker toggle
  const picker = document.getElementById('rec-date-picker');
  document.getElementById('rec-date-btn')?.addEventListener('click', () => {
    if (!picker) return;
    picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  });

  // Date pill selection
  document.querySelectorAll<HTMLElement>('.rec-date-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const date = btn.dataset.date;
      if (date) renderRecoveryView(date);
    });
  });

  // Info overlay
  document.getElementById('rec-info-btn')?.addEventListener('click', () => showRecoveryInfoOverlay());

  // Sleep card → sleep detail page
  const openSleepView = () => {
    import('./sleep-view').then(({ renderSleepView }) => {
      renderSleepView(undefined, s.physiologyHistory ?? [], s.wks ?? [], () => renderRecoveryView());
    });
  };
  document.getElementById('rec-sleep-card')?.addEventListener('click', openSleepView);
  document.getElementById('rec-sleep-btn')?.addEventListener('click', openSleepView);
}

// ── Public entry point ────────────────────────────────────────────────────────

export function renderRecoveryView(date?: string): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  const today = new Date().toISOString().split('T')[0];
  const displayDate = date ?? today;
  container.innerHTML = getRecoveryHTML(s, displayDate);
  wireRecoveryHandlers(s, displayDate);
}
