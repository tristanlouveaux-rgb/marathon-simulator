/**
 * Triathlon Fitness detail page — mirrors `buildFitnessDetailPage` from the
 * running stats but with per-discipline thresholds (CSS · FTP · LT) instead
 * of one Running Load + VO2 Max + LT triple.
 *
 * Layout:
 *   1. Your Numbers card — three zone bars (Swim CSS, Bike FTP, Run LT) with
 *      a per-discipline adaptation caption above each bar (from the
 *      `triConfig.prediction.adaptation` ratios) and a shared signals
 *      footer (HRV / RPE / Pa:Hr / etc.) when any are populated.
 *   2. Trend cards — sparkline per benchmark using existing helpers exported
 *      from `progress-detail-view.ts`. LT trend is derived from `vdotHistory`
 *      via `gp(vdot).t`.
 *   3. Current race estimates — Sprint, Olympic, plus the user's race-day
 *      target distance. Pulls from `triConfig.prediction`.
 */

import { getState } from '@/state/store';
import type { SimulatorState, VO2Estimate, VO2Confidence } from '@/types';
import { isCyclingOnlyMode } from '@/calculations/cycling-mode';
import { renderTabBar, wireTabBarHandlers, type TabId } from '../tab-bar';
import { gp } from '@/calculations/paces';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import {
  buildBenchmarkTrendChart,
  buildLtTrendChart,
  buildCssTrendChart,
  animateChartDrawOn,
} from './benchmark-charts';

// ────────────────────────────────────────────────────────────────────────────
// Navigation
// ────────────────────────────────────────────────────────────────────────────

function navigateTab(tab: TabId): void {
  if (tab === 'home') {
    import('../home-view').then(({ renderHomeView }) => renderHomeView());
  } else if (tab === 'plan') {
    import('../main-view').then(({ renderMainView }) => renderMainView());
  } else if (tab === 'forecast') {
    import('./forecast-view').then(({ renderTriathlonForecastView }) => renderTriathlonForecastView());
  } else if (tab === 'account') {
    import('../account-view').then(({ renderAccountView }) => renderAccountView());
  } else if (tab === 'stats') {
    import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Position bar (local — tri-specific zone definitions and adaptation caption)
// ────────────────────────────────────────────────────────────────────────────

type ZoneName = 'Building' | 'Foundation' | 'Trained' | 'Well-Trained' | 'Performance' | 'Elite';
const ZONE_LABELS: ZoneName[] = ['Building', 'Foundation', 'Trained', 'Well-Trained', 'Performance', 'Elite'];

const ZONE_FILL: Record<ZoneName, string> = {
  'Building':     '#38BDF8',
  'Foundation':   '#3B82F6',
  'Trained':      '#4F46E5',
  'Well-Trained': '#7C3AED',
  'Performance':  '#9333EA',
  'Elite':        '#6D28D9',
};
const ZONE_TINT: Record<ZoneName, string> = {
  'Building':     'rgba(56,189,248,0.18)',
  'Foundation':   'rgba(59,130,246,0.20)',
  'Trained':      'rgba(79,70,229,0.22)',
  'Well-Trained': 'rgba(124,58,237,0.25)',
  'Performance':  'rgba(147,51,234,0.28)',
  'Elite':        'rgba(109,40,217,0.35)',
};

interface BarOpts {
  title: string;
  /** Adaptation caption rendered above the bar (e.g. "adapting 7% faster than expected"). */
  caption?: { text: string; tone: 'ok' | 'warn' | 'neutral' };
  /** Display value text on the right of the title row (e.g. "1:42/100m"). */
  valueLabel: string | null;
  /** Score 0-100 — drives the marker position regardless of the underlying unit. */
  score: number | null;
  zoneName: ZoneName | null;
  /** Equal-fraction zones; bar always shows all 6 segments. */
  // (Kept simple — running stats has variable widths but the tri benchmarks
  //  use even sixths since the score is already normalised 0–100.)
  subtitle?: string;
  /** When set, the bar renders inside a clickable container with
   *  `data-tri-metric-detail="${tapId}"`. Click handlers are wired in
   *  `triathlon/stats-view.ts → wireTriMetricDetailButtons`. */
  tapId?: string;
}

function buildBar(opts: BarOpts): string {
  const { title, caption, valueLabel, score, zoneName, subtitle, tapId } = opts;
  const fillColor = zoneName ? ZONE_FILL[zoneName] : '#3B82F6';
  const markerPct = score != null ? Math.min(98, Math.max(2, score)) : null;

  const bgSegments = ZONE_LABELS.map(z =>
    `<div style="flex:1;height:100%;background:${ZONE_TINT[z]}"></div>`,
  ).join('');

  const dividerTicks = [16.67, 33.33, 50, 66.67, 83.33].map(pct =>
    `<div style="position:absolute;top:0;left:${pct}%;width:1.5px;height:100%;background:rgba(255,255,255,0.55);z-index:1"></div>`,
  ).join('');

  const segmentLabels = ZONE_LABELS.map((z, i) => {
    const midPct = (i + 0.5) * (100 / 6);
    const isActive = z === zoneName;
    return `<span style="position:absolute;left:${midPct.toFixed(1)}%;transform:translateX(-50%);font-size:8px;white-space:nowrap;${isActive ? `color:${fillColor};font-weight:700` : 'color:var(--c-faint);font-weight:400'}">${z}</span>`;
  }).join('');

  const captionColour = caption?.tone === 'ok' ? '#5a8050'
    : caption?.tone === 'warn' ? '#a06050'
    : 'var(--c-muted)';
  const captionHTML = caption
    ? `<div style="font-size:11px;color:${captionColour};margin-bottom:6px;line-height:1.3">${caption.text}</div>`
    : '';

  const tapAttrs = tapId
    ? ` data-tri-metric-detail="${tapId}" style="margin-bottom:22px;cursor:pointer;-webkit-tap-highlight-color:transparent"`
    : ' style="margin-bottom:22px"';

  return `
    <div${tapAttrs}>
      ${captionHTML}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-size:12px;font-weight:600;color:var(--c-black)">${title}</span>
        <span style="font-size:12px;color:var(--c-muted);font-variant-numeric:tabular-nums">
          ${valueLabel != null && zoneName != null
            ? `<strong style="color:var(--c-black);margin-right:3px">${valueLabel}</strong>· ${zoneName}${tapId ? ' ›' : ''}`
            : '—'}
        </span>
      </div>
      <div style="position:relative;height:14px;border-radius:7px;overflow:hidden;display:flex">
        ${bgSegments}
        ${markerPct != null ? `<div style="position:absolute;left:0;top:0;height:100%;width:${markerPct}%;background:${fillColor};z-index:2;transition:width 0.4s ease"></div>` : ''}
        ${dividerTicks}
        ${markerPct != null ? `<div style="position:absolute;top:0;left:${markerPct}%;transform:translateX(-50%);width:3px;height:100%;background:white;z-index:4"></div>` : ''}
      </div>
      <div style="position:relative;height:18px;margin-top:5px">${segmentLabels}</div>
      ${subtitle ? `<div style="font-size:10px;color:var(--c-faint);margin-top:1px;text-align:right">${subtitle}</div>` : ''}
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Score helpers — convert raw benchmark to 0-100 score + zone name
// ────────────────────────────────────────────────────────────────────────────

/**
 * CSS sec/100m → score. Lower is faster. Anchors derived from the tri
 * predictor's `cssToAbilityBand` thresholds (90/100/115/140 sec/100m).
 *   score 100 = 1:20/100m (elite swimmer)
 *   score   0 = 2:50/100m (very early on)
 */
function cssScore(cssSec: number | null | undefined): { score: number | null; zone: ZoneName | null } {
  if (cssSec == null || cssSec <= 0) return { score: null, zone: null };
  const slow = 170;  // 2:50/100m → score 0
  const fast = 80;   // 1:20/100m → score 100
  const score = Math.min(100, Math.max(0, ((slow - cssSec) / (slow - fast)) * 100));
  const zone = scoreToZone(score);
  return { score, zone };
}

/** FTP watts → score. Anchored on the predictor's ftpToAbilityBand
 * (175/220/270/320 W) for a ~70 kg rider. Sex-neutral. */
function ftpScore(ftpW: number | null | undefined): { score: number | null; zone: ZoneName | null } {
  if (ftpW == null || ftpW <= 0) return { score: null, zone: null };
  const floor = 100;
  const ceiling = 400;
  const score = Math.min(100, Math.max(0, ((ftpW - floor) / (ceiling - floor)) * 100));
  return { score, zone: scoreToZone(score) };
}

/** LT pace sec/km → score. Mirrors running stats LT score, sex-aware. */
function ltScore(ltSec: number | null | undefined, isFemale: boolean): { score: number | null; zone: ZoneName | null } {
  if (ltSec == null || ltSec <= 0) return { score: null, zone: null };
  const slow = isFemale ? 380 : 360;  // 6:20/km or 6:00/km → score 0
  const fast = isFemale ? 180 : 160;  // 3:00/km or 2:40/km → score 100
  const score = Math.min(100, Math.max(0, ((slow - ltSec) / (slow - fast)) * 100));
  return { score, zone: scoreToZone(score) };
}

/** VO2max ml/kg/min → score. Sex-aware breaks match the existing tier labels
 *  used by the running stats fitness card (35/42/52/60/70 male, 28/35/45/55/65
 *  female). */
function vo2Score(vo2: number | null | undefined, isFemale: boolean): { score: number | null; zone: ZoneName | null } {
  if (vo2 == null || vo2 <= 0) return { score: null, zone: null };
  const floor = isFemale ? 25 : 30;
  const ceiling = isFemale ? 70 : 75;
  const score = Math.min(100, Math.max(0, ((vo2 - floor) / (ceiling - floor)) * 100));
  return { score, zone: scoreToZone(score) };
}

function scoreToZone(score: number): ZoneName {
  if (score < 16.67) return 'Building';
  if (score < 33.33) return 'Foundation';
  if (score < 50)    return 'Trained';
  if (score < 66.67) return 'Well-Trained';
  if (score < 83.33) return 'Performance';
  return 'Elite';
}

// ────────────────────────────────────────────────────────────────────────────
// Adaptation captions
// ────────────────────────────────────────────────────────────────────────────

function adaptationCaption(ratio: number | undefined): BarOpts['caption'] | undefined {
  if (ratio == null) return undefined;
  const deltaPct = (ratio - 1) * 100;
  // No caption for the neutral band — clean visual default; only surface when
  // adaptation diverges meaningfully from plan expectation.
  if (Math.abs(deltaPct) < 5) return undefined;
  if (deltaPct > 0) {
    return { text: `Adapting ${deltaPct.toFixed(0)}% faster than expected`, tone: 'ok' };
  }
  return { text: `Adapting ${Math.abs(deltaPct).toFixed(0)}% slower than expected`, tone: 'warn' };
}

// ────────────────────────────────────────────────────────────────────────────
// Format helpers
// ────────────────────────────────────────────────────────────────────────────

function fmtCss(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')}/100m`;
}

function fmtPaceKm(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, '0')}/km`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = Math.round(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`;
  return `${m}:${ss.toString().padStart(2, '0')}`;
}

// ────────────────────────────────────────────────────────────────────────────
// VO2max helpers — honour watch/device source preference
// ────────────────────────────────────────────────────────────────────────────

/** Mirror the toggle logic in vo2max-card.ts: device wins when the user
 *  picked 'device' or Mosaic has no signal yet. */
function resolveVO2Value(s: SimulatorState): { value: number | null; isDevice: boolean } {
  const deviceVal = (s.vo2 != null && s.vo2 > 0) ? s.vo2 : null;
  const mosaicVal = s.vo2Estimates?.headline?.value ?? null;
  const useDevice = deviceVal != null && (s.vo2Source === 'device' || mosaicVal == null);
  return { value: useDevice ? deviceVal : mosaicVal, isDevice: useDevice };
}

const VO2_SOURCE_DOT: Record<'running' | 'cycling' | 'cardiac' | 'crossTraining', string> = {
  running: '#7B9E89',
  cycling: '#C58D6A',
  cardiac: '#D97757',
  crossTraining: '#9C8FB5',
};

function vo2ConfLabel(c: VO2Confidence): string {
  if (c === 'high') return 'High confidence';
  if (c === 'medium') return 'Medium confidence';
  if (c === 'low') return 'Low confidence';
  return '—';
}

function buildVO2SubRow(key: 'running' | 'cycling' | 'cardiac' | 'crossTraining', label: string, est: VO2Estimate, isLast: boolean): string {
  const val = est.value != null ? Math.round(est.value).toString() : '—';
  const conf = est.value != null ? vo2ConfLabel(est.confidence) : 'No data';
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0${isLast ? '' : ';border-bottom:1px solid var(--c-border)'}">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="width:5px;height:5px;border-radius:50%;background:${VO2_SOURCE_DOT[key]};flex-shrink:0;display:inline-block"></span>
        <span style="font-size:12px;color:var(--c-muted)">${label}</span>
      </div>
      <div style="display:flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums">
        <span style="font-size:12px;font-weight:600;color:var(--c-black)">${val}</span>
        <span style="font-size:11px;color:var(--c-faint)">·</span>
        <span style="font-size:11px;color:var(--c-muted)">${conf}</span>
      </div>
    </div>`;
}

function buildVO2SubRows(s: SimulatorState): string {
  const est = s.vo2Estimates;
  if (!est) return '';
  const cycling = isCyclingOnlyMode(s);
  const showCT = est.crossTraining.value != null;
  return `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.06)">
      ${cycling ? '' : buildVO2SubRow('running', 'Running', est.running, false)}
      ${buildVO2SubRow('cycling', 'Cycling', est.cycling, false)}
      ${buildVO2SubRow('cardiac', 'Cardiac ceiling', est.cardiac, !showCT)}
      ${showCT ? buildVO2SubRow('crossTraining', 'Cross-training', est.crossTraining, true) : ''}
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Build "Your Numbers" card
// ────────────────────────────────────────────────────────────────────────────

export function buildYourNumbersCard(s: SimulatorState): string {
  const tri = s.triConfig!;
  const isFemale = s.biologicalSex === 'female';
  const adaptation = tri.prediction?.adaptation;

  const cssSec = tri.swim?.cssSecPer100m ?? null;
  const ftpW = tri.bike?.ftp ?? null;
  const ltSec = s.lt ?? null;
  const deviceVal = (s.vo2 != null && s.vo2 > 0) ? s.vo2 : null;
  const { value: vo2, isDevice: vo2FromDevice } = resolveVO2Value(s);
  const cs = cssScore(cssSec);
  const fs = ftpScore(ftpW);
  const ls = ltScore(ltSec, isFemale);
  const vs = vo2Score(vo2, isFemale);

  const ltSubtitle = (() => {
    if (s.ltHR && s.ltHR > 0) {
      const pct = s.maxHR ? Math.round((s.ltHR / s.maxHR) * 100) : null;
      return pct ? `${s.ltHR} bpm · ${pct}% max HR` : `${s.ltHR} bpm`;
    }
    return undefined;
  })();

  const cssBar = buildBar({
    title: 'Swim CSS',
    caption: adaptationCaption(adaptation?.swim),
    valueLabel: cssSec != null ? fmtCss(cssSec) : null,
    score: cs.score,
    zoneName: cs.zone,
    tapId: 'css',
  });
  const ftpBar = buildBar({
    title: 'Bike FTP',
    caption: adaptationCaption(adaptation?.bike),
    valueLabel: ftpW != null ? `${Math.round(ftpW)} W` : null,
    score: fs.score,
    zoneName: fs.zone,
    tapId: 'ftp',
  });
  const ltBar = buildBar({
    title: 'Run Threshold (LT)',
    caption: adaptationCaption(adaptation?.run),
    valueLabel: ltSec != null ? fmtPaceKm(ltSec) : null,
    score: ls.score,
    zoneName: ls.zone,
    subtitle: ltSubtitle,
    tapId: 'lt',
  });
  const vo2Bar = vs.score != null ? buildBar({
    title: 'VO2max',
    valueLabel: vo2 != null ? Math.round(vo2).toString() : null,
    score: vs.score,
    zoneName: vs.zone,
    tapId: 'vo2',
  }) : '';

  // Source toggle + info button — only shown when there is something to toggle between.
  const hasWatchVo2 = deviceVal != null;
  const hasMosaicVo2 = s.vo2Estimates?.headline?.value != null;
  const showToggle = hasWatchVo2 || hasMosaicVo2;
  const activeStyle = 'background:var(--c-surface);color:var(--c-black);box-shadow:0 1px 2px rgba(0,0,0,0.08)';
  const inactiveStyle = 'background:transparent;color:var(--c-muted)';
  const vo2SrcToggle = showToggle ? `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <div style="display:flex;background:rgba(0,0,0,0.05);border-radius:6px;padding:2px;gap:1px">
        <button id="vo2-src-mosaic" style="padding:3px 8px;font-size:11px;font-weight:500;border:none;cursor:pointer;border-radius:4px;font-family:var(--f);${!vo2FromDevice ? activeStyle : inactiveStyle}">Mosaic</button>
        <button id="vo2-src-device" ${!hasWatchVo2 ? 'disabled' : ''} style="padding:3px 8px;font-size:11px;font-weight:500;border:none;cursor:${hasWatchVo2 ? 'pointer' : 'default'};border-radius:4px;font-family:var(--f);${vo2FromDevice ? activeStyle : inactiveStyle};${!hasWatchVo2 ? 'color:var(--c-faint)' : ''}">${hasWatchVo2 ? `Watch (${Math.round(deviceVal!)})` : 'Watch'}</button>
      </div>
      <button id="vo2-info-btn" style="width:18px;height:18px;border-radius:50%;border:1px solid var(--c-border);background:transparent;color:var(--c-muted);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--f);display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1">i</button>
    </div>` : '';

  const cycling = isCyclingOnlyMode(s);
  return `
    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:14px">Your Numbers</div>
      ${cycling ? '' : cssBar}
      ${ftpBar}
      ${cycling ? '' : ltBar}
      ${vo2Bar ? `${vo2Bar}${vo2SrcToggle}${buildVO2SubRows(s)}` : ''}
    </div>`;
}

function buildAdaptationSignalsFooter(signals: { hrv: number | null; rpeSwim: number | null; rpeBike: number | null; rpeRun: number | null; hrAtPower: number | null; pahrBike: number | null; pahrRun: number | null; cssSd: number | null } | undefined): string {
  if (!signals) return '';
  const parts: string[] = [];
  const fmt = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  if (signals.hrv != null) parts.push(`HRV ${fmt(signals.hrv)}`);
  if (signals.rpeSwim != null) parts.push(`Swim RPE ${fmt(signals.rpeSwim)}`);
  if (signals.rpeBike != null) parts.push(`Bike RPE ${fmt(signals.rpeBike)}`);
  if (signals.rpeRun != null) parts.push(`Run RPE ${fmt(signals.rpeRun)}`);
  if (signals.hrAtPower != null) parts.push(`Bike HR/W ${fmt(signals.hrAtPower)}`);
  if (signals.pahrBike != null) parts.push(`Bike Pa:Hr ${fmt(signals.pahrBike)}`);
  if (signals.pahrRun != null) parts.push(`Run Pa:Hr ${fmt(signals.pahrRun)}`);
  if (signals.cssSd != null) parts.push(`Swim SD ${fmt(signals.cssSd)}`);
  if (parts.length === 0) return '';
  return `
    <div style="margin-top:6px;padding-top:10px;border-top:1px solid rgba(0,0,0,0.06);font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums;line-height:1.5">
      ${parts.join(' · ')}
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Build trend cards (sparkline per benchmark)
// ────────────────────────────────────────────────────────────────────────────

export function buildTrendCards(s: SimulatorState): string {
  const tri = s.triConfig!;
  const cssHistory = tri.swim?.cssHistory ?? [];
  const ftpHistory = tri.bike?.ftpHistory ?? [];

  // LT pace samples derived from vdotHistory via Daniels' formula, with the
  // latest point pinned to s.lt so the trend headline matches "Your Numbers".
  const ltSamples = (s.vdotHistory ?? [])
    .filter(h => h.date != null && h.vdot > 0)
    .map(h => ({ date: h.date as string, value: gp(h.vdot).t }));
  if (s.lt != null && s.lt > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const lastIdx = ltSamples.length - 1;
    if (lastIdx >= 0 && ltSamples[lastIdx].date === today) {
      ltSamples[lastIdx] = { date: today, value: s.lt };
    } else {
      ltSamples.push({ date: today, value: s.lt });
    }
  }

  // VO2max samples: same vdotHistory base, latest point pinned to the
  // resolved VO2max value (honours watch/device preference) so it matches "Your Numbers".
  const canonicalVo2 = resolveVO2Value(s).value;
  const vo2Samples = (s.vdotHistory ?? [])
    .filter(h => h.date != null && h.vdot > 0)
    .map(h => ({ date: h.date as string, value: h.vdot }));
  if (canonicalVo2 != null) {
    const today = new Date().toISOString().slice(0, 10);
    const lastIdx = vo2Samples.length - 1;
    if (lastIdx >= 0 && vo2Samples[lastIdx].date === today) {
      vo2Samples[lastIdx] = { date: today, value: canonicalVo2 };
    } else {
      vo2Samples.push({ date: today, value: canonicalVo2 });
    }
  }

  const cycling = isCyclingOnlyMode(s);
  return `
    ${cycling ? '' : `<div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Swim CSS trend</div>
      <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Critical swim speed · faster pace = lower number</div>
      ${buildCssTrendChart(cssHistory)}
    </div>`}

    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Bike FTP trend</div>
      <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Functional threshold power · auto-derived from rides + your tests</div>
      ${buildBenchmarkTrendChart(ftpHistory, '#8B5CF6', 'rgba(139,92,246,0.08)', 'W', /*inverted*/ false)}
    </div>

    ${cycling ? '' : `<div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">Run threshold (LT) trend</div>
      <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Threshold pace derived from VO2max history · faster pace = lower number</div>
      ${buildLtTrendChart(ltSamples)}
    </div>`}

    ${vo2Samples.length >= 2 ? `
      <div class="m-card" style="padding:16px;margin-bottom:10px">
        <div style="font-size:12px;font-weight:600;color:var(--c-black);margin-bottom:2px">VO2max trend</div>
        <div style="font-size:10px;color:var(--c-faint);margin-bottom:10px">Aerobic capacity over time · higher = better</div>
        ${buildBenchmarkTrendChart(vo2Samples, '#34C759', 'rgba(52,199,89,0.08)', 'ml/kg/min', /*inverted*/ false)}
      </div>` : ''}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Build current race estimates card
// ────────────────────────────────────────────────────────────────────────────

function buildRaceEstimatesCard(s: SimulatorState): string {
  const tri = s.triConfig!;
  const p = tri.prediction ?? predictTriathlonRace(s);
  if (!p) return '';

  const targetLabel = tri.distance === 'ironman' ? 'Ironman' : '70.3';
  const rows: Array<{ label: string; value: string }> = [];
  if (p.sprintTotalSec) rows.push({ label: 'Sprint',  value: fmtDuration(p.sprintTotalSec) });
  if (p.olympicTotalSec) rows.push({ label: 'Olympic', value: fmtDuration(p.olympicTotalSec) });
  rows.push({ label: targetLabel, value: fmtDuration(p.totalSec) });

  if (rows.length === 0) return '';

  const rowsHtml = rows.map((r, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0${i < rows.length - 1 ? ';border-bottom:1px solid var(--c-border)' : ''}">
      <span style="font-size:13px;color:var(--c-muted)">${r.label}</span>
      <span style="font-size:13px;font-weight:600;color:var(--c-black);font-variant-numeric:tabular-nums">${r.value}</span>
    </div>`).join('');

  return `
    <div class="m-card" style="padding:16px;margin-bottom:10px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--c-faint);margin-bottom:4px">Current race estimates</div>
      <div style="font-size:11px;color:var(--c-muted);margin-bottom:6px">Estimated finish times if racing today</div>
      ${rowsHtml}
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Detail header
// ────────────────────────────────────────────────────────────────────────────

function buildDetailHeader(title: string): string {
  return `
    <div style="padding:max(16px, env(safe-area-inset-top)) 18px 12px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--c-border)">
      <button id="tri-fitness-back" style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;font-size:20px;color:var(--c-black);font-family:var(--f);flex-shrink:0;margin-left:-8px">←</button>
      <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em;color:var(--c-black)">${title}</div>
    </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Public render
// ────────────────────────────────────────────────────────────────────────────

export function renderTriFitnessDetailView(): void {
  const container = document.getElementById('app-root');
  if (!container) return;
  const s = getState();
  if (!s.triConfig) return;

  container.innerHTML = `
    <div class="mosaic-page" style="background:var(--c-bg)">
      ${buildDetailHeader('Fitness')}

      <div style="max-width:600px;margin:0 auto;padding:12px 18px 80px;overflow-y:auto">
        ${buildYourNumbersCard(s)}
        ${buildTrendCards(s)}
        ${buildRaceEstimatesCard(s)}
      </div>
    </div>
    ${renderTabBar('stats')}`;

  animateChartDrawOn();
  wireTabBarHandlers(navigateTab);

  document.getElementById('tri-fitness-back')?.addEventListener('click', () => {
    import('./stats-view').then(({ renderTriathlonStatsView }) => renderTriathlonStatsView());
  });
}
