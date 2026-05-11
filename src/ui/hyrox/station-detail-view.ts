/**
 * HYROX per-station detail sub-page.
 *
 * Drill-down from `renderStationsTable` on the forecast view. Surfaces the
 * single station's progression over time (sparkline + history list), best vs
 * current, fresh-test → race-day fade, and a CTA to test again.
 *
 * Reads:
 *   - `stationBenchmarkHistory` for progression and PR detection
 *   - `prediction.stations[].adjustedSec` for race-day-fatigued time
 *   - `getStationPercentile()` for cohort ranking
 *
 * Side: tracking. No new constants; all data comes from the existing prediction
 * + history pipeline.
 */

import { getState, getMutableState } from '@/state/store';
import { saveState } from '@/state/persistence';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from '@/ui/page-flair';
import type { HyroxStation } from '@/types/triathlon';
import { STATION_DISPLAY, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import { predictHyroxRace } from '@/calculations/race-prediction.hyrox';
import { getStationPercentile } from '@/calculations/hyrox-population';
import {
  getStationHistory,
  bestStationTime,
  type HyroxFormat,
  type StationTestEntry,
} from '@/calculations/hyrox-station-history';

const SOURCE_LABEL: Record<StationTestEntry['source'], string> = {
  half_test: 'Half test',
  full_test: 'Full test',
  race: 'Race split',
  manual: 'Manual entry',
};

function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** SVG sparkline of test times chronologically (faster = up).
 *  Per CLAUDE.md SVG rules: explicit width/height, preserveAspectRatio="none",
 *  vector-effect="non-scaling-stroke" so the line stays crisp under stretch. */
function buildSparkline(entries: StationTestEntry[]): string {
  if (entries.length < 2) return '';
  const W = 320;
  const H = 80;
  const pad = 6;
  const secs = entries.map(e => e.sec);
  const minSec = Math.min(...secs);
  const maxSec = Math.max(...secs);
  const range = Math.max(maxSec - minSec, 1);
  const xStep = (W - pad * 2) / Math.max(entries.length - 1, 1);
  // Invert y so faster = top.
  const points = entries.map((e, i) => {
    const x = pad + i * xStep;
    const y = pad + ((e.sec - minSec) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M ${points.join(' L ')}`;
  const areaPath = `${linePath} L ${pad + (entries.length - 1) * xStep},${H - pad} L ${pad},${H - pad} Z`;
  const dots = entries.map((e, i) => {
    const x = pad + i * xStep;
    const y = pad + ((e.sec - minSec) / range) * (H - pad * 2);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#7a845c" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  return `
    <svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block">
      <path d="${areaPath}" fill="rgba(122,132,92,0.10)" vector-effect="non-scaling-stroke"/>
      <path d="${linePath}" fill="none" stroke="#7a845c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      ${dots}
    </svg>
  `;
}

export function renderHyroxStationDetailView(station: HyroxStation): void {
  const root = document.getElementById('app-root');
  if (!root) return;
  const s = getState();
  const hx = s.hyroxConfig;
  if (!hx) return;

  const display = STATION_DISPLAY[station];
  const fmt = (hx.format ?? 'open_singles') as HyroxFormat;

  // Filter history to current format so we don't mix singles + doubles times
  // on the same chart. A user racing both should see two separate progressions.
  const history = getStationHistory(s, station).filter(e => e.format === fmt);

  // Race-day adjusted time from the predictor — this is the in-race-fatigued
  // version after run-leg fatigue accumulation but before within-station fade
  // (which we don't model yet, see ISSUE-197).
  const prediction = predictHyroxRace(s);
  const stationLine = prediction?.stations.find(l => l.station === station);
  const raceDaySec = stationLine?.adjustedSec ?? null;
  const baseSec = stationLine?.baseSec ?? null;

  const latest = history[history.length - 1] ?? null;
  const best = bestStationTime(s, station, fmt);
  const seedSec = STATION_SEED_TIMES_SEC[hx.athleteBand][station];
  const pct = baseSec != null && stationLine?.source === 'calibrated'
    ? getStationPercentile(station, baseSec)
    : null;

  // Improvement since FIRST test (chronologically) — anchored at oldest, not best.
  const first = history[0] ?? null;
  const improvementSec = (latest && first && history.length > 1)
    ? latest.sec - first.sec
    : null;

  // Race-day fade: how much slower the predicted race-day time is vs the latest
  // fresh test. ISSUE-195 Phase 1 — purely informational, no new math.
  const fadePct = (latest && raceDaySec != null && latest.sec > 0)
    ? ((raceDaySec - latest.sec) / latest.sec) * 100
    : null;

  // ── Hero ────────────────────────────────────────────────────────────────
  const heroTime = baseSec != null ? fmtMmSs(baseSec) : '—';
  const sourceLabel = stationLine?.source === 'calibrated' ? 'Your latest test' : 'Population estimate';
  const pctText = pct != null ? `· p${pct} in your band` : '';

  const hero = `
    <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:24px 22px 20px;margin-bottom:14px">
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">${display.name}</div>
      <div style="font-size:48px;font-weight:200;color:var(--c-black);font-variant-numeric:tabular-nums;letter-spacing:-0.025em;line-height:1">${heroTime}</div>
      <div style="font-size:12px;color:var(--c-muted);margin-top:8px">${sourceLabel} ${pctText}</div>
    </div>
  `;

  // ── Sparkline + history ─────────────────────────────────────────────────
  const sparklineHtml = buildSparkline(history);
  const sparklineCard = sparklineHtml ? `
    <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Progression</div>
      ${sparklineHtml}
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--c-faint);margin-top:8px">
        <span>${fmtDate(history[0].dateISO)}</span>
        <span>${fmtDate(history[history.length - 1].dateISO)}</span>
      </div>
    </div>
  ` : '';

  // ── Stats panel ──────────────────────────────────────────────────────────
  const statRow = (label: string, value: string, sub?: string) => `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;padding:8px 0;border-top:1px solid rgba(0,0,0,0.05)">
      <span style="font-size:12px;color:var(--c-muted)">${label}</span>
      <span style="text-align:right">
        <span style="font-size:13px;color:var(--c-black);font-variant-numeric:tabular-nums">${value}</span>
        ${sub ? `<div style="font-size:10px;color:var(--c-faint);margin-top:1px">${sub}</div>` : ''}
      </span>
    </div>
  `;
  const improvementText = improvementSec != null
    ? (improvementSec < 0
        ? `${Math.abs(improvementSec)}s faster`
        : improvementSec > 0 ? `${improvementSec}s slower` : 'No change')
    : 'Need 2+ tests';
  const fadeText = fadePct != null
    ? `${fadePct >= 0 ? '+' : ''}${fadePct.toFixed(1)}%`
    : '—';
  const statsCard = `
    <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Stats</div>
      ${best ? statRow('Best', fmtMmSs(best.sec), fmtDate(best.dateISO)) : ''}
      ${latest ? statRow('Latest', fmtMmSs(latest.sec), fmtDate(latest.dateISO)) : ''}
      ${statRow('Population estimate', fmtMmSs(seedSec), `Band: ${hx.athleteBand.replace(/_/g, ' ')}`)}
      ${first && history.length > 1 ? statRow('Since first test', improvementText, fmtDate(first.dateISO)) : ''}
      ${raceDaySec != null && latest ? statRow('Race-day fade', fadeText, `Fresh ${fmtMmSs(latest.sec)} → race ${fmtMmSs(raceDaySec)}`) : ''}
    </div>
  `;

  // ── History list ─────────────────────────────────────────────────────────
  const historyRows = history.length > 0
    ? [...history].reverse().map((e, i) => {
        const isBest = best && e.sec === best.sec && e.dateISO === best.dateISO;
        const bestBadge = isBest
          ? `<span style="font-size:10px;font-weight:600;color:#4f5a3b;background:rgba(122,132,92,0.16);border-radius:6px;padding:2px 7px;margin-left:6px">Best</span>`
          : '';
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-top:${i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'}">
            <span>
              <span style="font-size:12px;color:var(--c-black)">${fmtDate(e.dateISO)}</span>
              ${bestBadge}
              <div style="font-size:10px;color:var(--c-faint);margin-top:1px">${SOURCE_LABEL[e.source]}${e.proWeights ? ' · Pro weights' : ''}</div>
            </span>
            <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(e.sec)}</span>
          </div>
        `;
      }).join('')
    : `<div style="font-size:12px;color:var(--c-faint);padding:12px 0">No history yet. Test this station to start tracking.</div>`;

  const historyCard = `
    <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">All tests</div>
      ${historyRows}
    </div>
  `;

  const ctaCard = `
    <div style="margin-bottom:14px">
      <button id="hx-station-detail-test-cta" style="width:100%;font-size:13px;font-weight:600;color:var(--c-black);background:transparent;border:1px solid var(--c-border);border-radius:12px;padding:14px;cursor:pointer">Test ${display.name.toLowerCase()} again →</button>
    </div>
  `;

  root.innerHTML = `
    <div class="mosaic-page" style="min-height:100vh;background:${atmosphereGradient('sky')};position:relative;overflow:hidden">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxsd', { variant: 'sweep', palette: 'sky', pulse: false })}
      </div>
      ${buildSunGlint('low')}
      <div style="position:relative;z-index:10;padding:24px 16px 80px;max-width:560px;margin:0 auto">
        <button id="hx-station-detail-back" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--c-muted);background:transparent;border:none;padding:0 0 18px;cursor:pointer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back to forecast
        </button>
        ${hero}
        ${sparklineCard}
        ${statsCard}
        ${historyCard}
        ${ctaCard}
      </div>
    </div>
  `;

  // Back nav → forecast.
  document.getElementById('hx-station-detail-back')?.addEventListener('click', () => {
    import('./forecast-view').then(({ renderHyroxForecastView }) => renderHyroxForecastView());
  });

  // Test-again CTA → un-dismiss benchmark card + navigate to plan view.
  // Mirrors the forecast-view banner pattern (see CHANGELOG 2026-05-08).
  document.getElementById('hx-station-detail-test-cta')?.addEventListener('click', () => {
    const ms = getMutableState();
    if (ms.hyroxConfig && (ms.hyroxConfig as { dismissedBenchmarkCard?: boolean }).dismissedBenchmarkCard) {
      (ms.hyroxConfig as { dismissedBenchmarkCard?: boolean }).dismissedBenchmarkCard = false;
      saveState();
    }
    import('./plan-view').then(({ renderHyroxPlanView }) => renderHyroxPlanView());
  });
}
