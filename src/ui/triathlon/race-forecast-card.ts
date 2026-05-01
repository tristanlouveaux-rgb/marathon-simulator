/**
 * Race forecast card (§18.8).
 *
 * Headline = projected race-day time (assumes plan execution). Sub-line shows
 * "if you raced today" plus the gap the plan delivers. Confidence range
 * narrows with weeks remaining + years of training.
 *
 * Below the headline:
 *   - Limiting-factor banner (when run leg is capped by long-session shortfall)
 *   - Per-leg breakdown
 *   - T1 / T2
 *   - Course factors panel (climate, altitude, elevation, wind, swim type)
 *   - Sprint/Olympic side-effects
 */

import type { SimulatorState } from '@/types/state';
import type { CourseFactorEntry, LimitingFactor, TriRacePrediction } from '@/types/triathlon';
import { predictTriathlonRace } from '@/calculations/race-prediction.triathlon';
import { DISCIPLINE_COLOURS } from './colours';

export function renderRaceForecastCard(state: SimulatorState): string {
  const tri = state.triConfig;
  if (!tri) return '';

  const p: TriRacePrediction | null = tri.prediction ?? predictTriathlonRace(state);
  if (!p) return '';

  const distLabel = tri.distance === 'ironman' ? 'Ironman' : '70.3';

  // Half-band as a "± minutes" tolerance for the headline. The model's full
  // ±range stays on TriRacePrediction for callers that want it, but the user
  // sees a single confident number plus a tighter tolerance.
  const halfBandSec = Math.round((p.totalRangeSec[1] - p.totalRangeSec[0]) / 4);
  const halfBandMin = Math.max(1, Math.round(halfBandSec / 60));
  // Range narrows as race day approaches because the horizon-driven uncertainty
  // (more weeks of training to unfold) shrinks. Show this when we're > 4 weeks
  // out so the user knows the number tightens up.
  const weeksRemaining = p.projection?.weeksRemaining ?? 0;
  const willNarrow = weeksRemaining > 4;

  return `
    <div style="margin-bottom:20px">
      <h2 style="font-size:13px;font-weight:500;color:var(--c-muted);letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px">Race forecast</h2>
      <div style="background:rgba(255,255,255,0.92);border:1px solid rgba(0,0,0,0.05);border-radius:14px;padding:18px">

        <!-- Headline: ONE big decisive number; tolerance as small footnote -->
        <div style="margin-bottom:16px">
          <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${distLabel} race-day target</div>
          <div style="font-size:38px;font-weight:300;color:var(--c-black);font-variant-numeric:tabular-nums;letter-spacing:-0.01em;line-height:1.1">${fmtDuration(p.totalSec)}</div>
          <div style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums;margin-top:4px">±${halfBandMin} min${willNarrow ? ' &middot; narrows as race day approaches' : ''}</div>
          ${renderCurrentVsProjected(p)}
        </div>

        <!-- Per-leg breakdown -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
          ${legCell('Swim', p.swimSec, DISCIPLINE_COLOURS.swim.accent, p.currentSwimSec, swimLowConfidenceFlag(state))}
          ${legCell('Bike', p.bikeSec, DISCIPLINE_COLOURS.bike.accent, p.currentBikeSec, bikeLowConfidenceFlag(state))}
          ${legCell('Run', p.runSec, DISCIPLINE_COLOURS.run.accent, p.currentRunSec)}
        </div>

        <div style="display:flex;gap:12px;font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums">
          <span>T1: ${fmtShort(p.t1Sec)}</span>
          <span>T2: ${fmtShort(p.t2Sec)}</span>
        </div>

        ${renderProjectedMarkers(p)}
        ${renderCourseFactorsPanel(p.courseFactors ?? [])}

        ${p.sprintTotalSec || p.olympicTotalSec ? `
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.06);font-size:12px;color:var(--c-muted);line-height:1.6">
            ${p.sprintTotalSec ? `Sprint: <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(p.sprintTotalSec)}</span>` : ''}
            ${p.sprintTotalSec && p.olympicTotalSec ? ' · ' : ''}
            ${p.olympicTotalSec ? `Olympic: <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(p.olympicTotalSec)}</span>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

// ───────────────────────────────────────────────────────────────────────────
// Sub-renders
// ───────────────────────────────────────────────────────────────────────────

function renderCurrentVsProjected(p: TriRacePrediction): string {
  if (p.currentTotalSec == null) return '';
  const gap = p.currentTotalSec - p.totalSec;  // positive = projection faster than today
  if (Math.abs(gap) < 60) return '';
  const lines: string[] = [
    `<div style="font-size:11px;color:var(--c-muted);margin-top:6px">If you raced today: <span style="font-variant-numeric:tabular-nums">${fmtDuration(p.currentTotalSec)}</span></div>`,
  ];
  // Surface adaptation when materially divergent from neutral.
  if (p.adaptation) {
    const deltas = [
      { d: 'Run',  v: (p.adaptation.run  - 1) * 100 },
      { d: 'Bike', v: (p.adaptation.bike - 1) * 100 },
      { d: 'Swim', v: (p.adaptation.swim - 1) * 100 },
    ].filter(x => Math.abs(x.v) >= 5);
    if (deltas.length > 0) {
      const phrase = deltas
        .map(x => `${x.d.toLowerCase()} ${x.v > 0 ? '+' : ''}${x.v.toFixed(0)}%`)
        .join(', ');
      lines.push(
        `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">Fitness responding ${phrase} vs expected — projection adjusted.</div>`,
      );
    }
  }
  return lines.join('');
}

function renderLimitingBanner(limitingFactor: LimitingFactor | undefined): string {
  if (!limitingFactor) return '';
  // The projection assumes the plan delivers long sessions, so its number
  // does NOT include the durability cap. The banner is informational about
  // the user's CURRENT state ("if you raced today") — neutral framing only.
  const msg = (() => {
    switch (limitingFactor) {
      case 'long_ride_volume':
        return 'Today\'s run leg would suffer from limited long-ride volume. The plan\'s long rides will close this gap.';
      case 'long_run_volume':
        return 'Today\'s run leg would suffer from limited long-run volume. The plan\'s long runs will close this gap.';
      case 'volume_durability':
        return 'Today\'s run leg would suffer from limited long-session volume in both disciplines. The plan\'s long sessions will close this gap.';
    }
  })();
  return `
    <div style="margin-bottom:14px;padding:10px 12px;border-radius:10px;background:#F4F1E8;border:1px solid #DDD3B6;font-size:12px;color:#6B5B2E;line-height:1.45">
      ${msg}
    </div>
  `;
}

function renderCourseFactorsPanel(factors: CourseFactorEntry[]): string {
  const rows = factors.map(f => {
    const sign = f.deltaSec > 0 ? '+' : '−';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px">
        <span style="color:var(--c-muted)">${f.label} (${f.leg})</span>
        <span style="display:flex;gap:10px;align-items:center">
          <span style="color:var(--c-black)">${f.value}</span>
          <span style="color:var(--c-faint);font-variant-numeric:tabular-nums">${sign}${fmtShort(Math.abs(f.deltaSec))}</span>
        </span>
      </div>
    `;
  }).join('');
  return `
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(0,0,0,0.06)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">Course factors</div>
        <button id="tri-bike-setup-btn" style="background:transparent;border:none;padding:0;font-size:11px;color:var(--c-muted);cursor:pointer">Bike &amp; aero →</button>
      </div>
      ${factors.length > 0 ? rows : `<div style="font-size:12px;color:var(--c-faint);padding:4px 0">Set climate, elevation, and wind on the race plan to refine the forecast.</div>`}
    </div>
  `;
}

function legCell(label: string, sec: number, accent: string, currentSec?: number, lowConfidenceFlag?: string): string {
  const gap = currentSec != null ? currentSec - sec : null;
  const showGap = gap != null && Math.abs(gap) >= 30;
  return `
    <div style="background:rgba(255,255,255,0.6);border-left:2px solid ${accent};border-radius:8px;padding:10px 12px">
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${label}</span>
        ${lowConfidenceFlag ? `<span title="${lowConfidenceFlag}" style="font-size:9px;color:#a89060;background:#FAF3E2;padding:1px 5px;border-radius:6px">${lowConfidenceFlag}</span>` : ''}
      </div>
      <div style="font-size:16px;font-weight:500;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtDuration(sec)}</div>
      ${showGap ? `<div style="font-size:10px;color:${gap! > 0 ? '#5a8050' : 'var(--c-faint)'};font-variant-numeric:tabular-nums;margin-top:2px">${gap! > 0 ? '−' : '+'}${fmtShort(Math.abs(gap!))} vs today</div>` : ''}
    </div>
  `;
}

function renderProjectedMarkers(p: TriRacePrediction): string {
  if (!p.projection) return '';
  const swim = p.projection.swimCss;
  const bike = p.projection.bikeFtp;
  const run  = p.projection.runVdot;
  const parts: string[] = [];
  if (swim.current != null && swim.projected != null && Math.abs(swim.current - swim.projected) >= 1) {
    parts.push(`CSS ${fmtCss(swim.current)} → ${fmtCss(swim.projected)}`);
  }
  if (bike.current != null && bike.projected != null && Math.abs(bike.current - bike.projected) >= 2) {
    parts.push(`FTP ${Math.round(bike.current)}W → ${Math.round(bike.projected)}W`);
  }
  if (run.current != null && run.projected != null && Math.abs(run.current - run.projected) >= 0.5) {
    parts.push(`VDOT ${run.current.toFixed(1)} → ${run.projected.toFixed(1)}`);
  }
  if (parts.length === 0) return '';
  return `
    <div style="margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(0,0,0,0.02);border:1px solid var(--c-border);font-size:11px;color:var(--c-muted);line-height:1.5">
      <span style="display:block;font-weight:500;color:var(--c-black);margin-bottom:4px">Projected fitness markers</span>
      ${parts.join(' &middot; ')}
    </div>
  `;
}

/**
 * Surface a small chip on the swim leg showing the source/quality of CSS.
 * Only "high"-confidence reads (paired-TT test or recent strong-data derived
 * estimate) get NO chip — everything else carries a hint so the user knows
 * the swim split rests on incomplete information.
 */
function swimLowConfidenceFlag(state: SimulatorState): string | undefined {
  const swim = state.triConfig?.swim;
  if (!swim?.cssSecPer100m) return 'no test';
  const conf = swim.cssConfidence;
  if (conf === 'high') return undefined;
  // Anything below 'high' or unknown — always tell the user it's not a hard test.
  if (conf === 'low' || conf === 'none') return 'estimate';
  if (swim.cssSource === 'derived') return 'derived';
  return 'no test';   // user-set but not paired-TT verified
}

/** Same idea for bike — flag when FTP isn't paired-TT high-confidence. */
function bikeLowConfidenceFlag(state: SimulatorState): string | undefined {
  const bike = state.triConfig?.bike;
  if (!bike?.ftp) return 'no test';
  const conf = (bike as { ftpConfidence?: string }).ftpConfidence;
  if (conf === 'high') return undefined;
  if (conf === 'low' || conf === 'none') return 'estimate';
  if ((bike as { ftpSource?: string }).ftpSource === 'derived') return 'derived';
  return 'no test';
}

function fmtCss(secPer100m: number): string {
  const m = Math.floor(secPer100m / 60);
  const s = Math.round(secPer100m % 60);
  return `${m}:${s.toString().padStart(2, '0')}/100m`;
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtShort(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
