/**
 * HYROX forecast view — sums calibrated station benchmarks + run pace and
 * applies venue-specific course factors. Mirrors the pattern of the triathlon
 * race-forecast card.
 */

import { getState, getMutableState } from '@/state/store';
import type { SimulatorState } from '@/types/state';
import { saveState } from '@/state/persistence';
import { buildRingBackground, atmosphereGradient, buildSunGlint } from '@/ui/page-flair';
import { renderTabBar, wireTabBarHandlers, type TabId } from '@/ui/tab-bar';
import { predictHyroxRace, type HyroxStationLine, type HyroxRunLeg, type HyroxProjectionMarkers, type HyroxPrediction, type HyroxStationProjection } from '@/calculations/race-prediction.hyrox';
import { buildHyroxProjection } from '@/calculations/race-projection.hyrox';
import { STATION_DISPLAY, STATION_SEED_TIMES_SEC } from '@/constants/hyrox-benchmarks';
import { getHyroxVenueById, rescaleTimeAcrossVenues } from '@/data/hyrox-venues';
import { getHyroxEventById, getVenueIdForEvent } from '@/data/hyrox-events';
import { getStationPercentile, stationStatus } from '@/calculations/hyrox-population';
import { latestIsPR, latestTestAgeMonths, type HyroxFormat } from '@/calculations/hyrox-station-history';
import { topWeakestLinks } from '@/calculations/hyrox-weakest-link';
import { computeStationPotential } from '@/calculations/hyrox-station-potential';
import { renderPerformanceRadar } from './performance-radar';
import { renderPercentileDistributions } from './percentile-distributions';
import { applyHyroxPrevFormatChange } from '@/state/hyrox-prev-format-fix';

function fmtMmSs(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtShortDelta(sec: number): string {
  const abs = Math.abs(sec);
  if (abs < 60) return `${Math.round(abs)}s`;
  const m = Math.floor(abs / 60);
  const s = Math.round(abs - m * 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')}/km`;
}

function daysUntil(isoDate: string): number {
  const target = new Date(isoDate).getTime();
  const now = new Date().setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((target - now) / 86400000));
}

/**
 * Render the 8 run legs.
 *
 * When `projectedRunSec` is provided and yields a meaningful per-leg
 * improvement (≥ 1s on any leg), each row shows "current → projected" pace
 * inline plus a race-day delta in the rightmost column. The bar continues to
 * show in-race fatigue drift visually, so we don't lose that information.
 *
 * Per-leg projection is derived by scaling the current leg pace by the ratio
 * of projected total run time to current total run time. This preserves the
 * exact drift shape across legs (R1 is still proportionally faster than R8).
 * It mirrors the headline `byDiscipline.run` improvement, just allocated
 * across legs.
 */
function renderRunLegsTable(legs: HyroxRunLeg[], currentRunSec: number, projectedRunSec?: number): string {
  const fastest = Math.min(...legs.map(l => l.paceSecKm));
  const maxSlip = Math.max(...legs.map(l => l.paceSecKm - fastest));
  const ratio = projectedRunSec && currentRunSec > 0 ? projectedRunSec / currentRunSec : 1;
  const projectedLegs = legs.map(l => Math.round(l.paceSecKm * ratio));
  const showProjection = ratio < 1 && legs.some((l, i) => l.paceSecKm - projectedLegs[i] >= 1);
  return legs.map((leg, i) => {
    const slipSec = leg.paceSecKm - fastest;
    // Bar width = fraction of worst-leg slip. Minimum 2px so zero-slip legs still show a tick.
    const barPct = maxSlip > 0 ? Math.round((slipSec / maxSlip) * 100) : 0;
    // Colour by % slip relative to fastest (not absolute seconds).
    const pctSlipOfFastest = fastest > 0 ? (slipSec / fastest) * 100 : 0;
    const barColour = pctSlipOfFastest > 6 ? '#ef4444' : pctSlipOfFastest > 3 ? '#f59e0b' : '#7a845c';
    const projectedSec = projectedLegs[i];
    const projDelta = leg.paceSecKm - projectedSec;
    const paceCell = showProjection
      ? `${fmtPace(leg.paceSecKm).replace('/km', '')} → ${fmtPace(projectedSec)}`
      : fmtPace(leg.paceSecKm);
    const rightCell = showProjection
      ? (projDelta >= 1 ? `−${Math.round(projDelta)}s` : '—')
      : (slipSec > 0 ? `+${Math.round(slipSec)}s` : '—');
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid rgba(0,0,0,0.04);font-size:12px">
        <span style="width:28px;text-align:center;color:var(--c-faint);font-weight:600;flex-shrink:0">R${leg.legNumber}</span>
        <div style="flex:1;height:4px;background:#F1F5F9;border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${Math.max(2, barPct)}%;background:${barColour};border-radius:2px"></div>
        </div>
        <span style="min-width:${showProjection ? 110 : 70}px;text-align:right;color:var(--c-black);font-variant-numeric:tabular-nums">${paceCell}</span>
        <span style="min-width:36px;text-align:right;color:var(--c-faint);font-variant-numeric:tabular-nums;font-size:11px">${rightCell}</span>
      </div>
    `;
  }).join('');
}

/**
 * Race-order interleaved card (singles only). 16 rows alternating runs and
 * stations: R1 → SkiErg → R2 → Sled Push → ... → R8 → Wall Balls. Each row
 * shows current → projected (delta), driven by `HyroxProjectionMarkers` for
 * stations and the run-discipline ratio for legs.
 *
 * Percentile chips are intentionally absent. Benchmark times are max-effort
 * fresh; the population dataset captures mid-race fatigued splits — the
 * comparison would be apples-to-oranges. Race-day percentile lives on the
 * headline finish-time card where the comparison is valid.
 *
 * Doubles still uses the legacy split layout because the athlete only does 4
 * of 8 stations, breaking the simple alternation.
 */
function renderRaceOrderTable(
  prediction: HyroxPrediction,
  projectedRunSec: number | undefined,
  state: SimulatorState,
): string {
  const fmt = (state.hyroxConfig?.format ?? 'open_singles') as HyroxFormat;
  const legs = prediction.runLegs;
  const stations = prediction.stations;
  const stationProjections = prediction.projection?.stations ?? [];
  const stationProjByName = new Map<string, HyroxStationProjection>(
    stationProjections.map(p => [p.station, p]),
  );

  const runRatio = projectedRunSec && prediction.runSec > 0 ? projectedRunSec / prediction.runSec : 1;
  const showRunProjection = runRatio < 1;

  const fastestLegPace = Math.min(...legs.map(l => l.paceSecKm));
  const maxLegSlip = Math.max(...legs.map(l => l.paceSecKm - fastestLegPace));

  const rows: string[] = [];
  let rowIndex = 0;

  for (let i = 0; i < legs.length; i++) {
    rows.push(renderRunLegRow(legs[i], runRatio, showRunProjection, fastestLegPace, maxLegSlip, rowIndex++));
    if (i < stations.length) {
      const line = stations[i];
      const proj = stationProjByName.get(line.station);
      rows.push(renderStationOrderRow(line, proj, state, fmt, rowIndex++));
    }
  }

  return rows.join('');
}

function renderRunLegRow(
  leg: HyroxRunLeg,
  ratio: number,
  showProjection: boolean,
  fastestLegPace: number,
  maxLegSlip: number,
  rowIndex: number,
): string {
  const projectedPace = Math.round(leg.paceSecKm * ratio);
  const slipSec = leg.paceSecKm - fastestLegPace;
  const barPct = maxLegSlip > 0 ? Math.round((slipSec / maxLegSlip) * 100) : 0;
  const pctSlipOfFastest = fastestLegPace > 0 ? (slipSec / fastestLegPace) * 100 : 0;
  const barColour = pctSlipOfFastest > 6 ? '#ef4444' : pctSlipOfFastest > 3 ? '#f59e0b' : '#7a845c';
  const projDelta = leg.paceSecKm - projectedPace;
  const showRowProjection = showProjection && projDelta >= 1;

  const paceCell = showRowProjection
    ? `${fmtPace(leg.paceSecKm).replace('/km', '')} → ${fmtPace(projectedPace)}`
    : fmtPace(leg.paceSecKm);
  const deltaCell = showRowProjection
    ? `−${Math.round(projDelta)}s`
    : (slipSec > 0 ? `+${Math.round(slipSec)}s` : '—');

  return `
    <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:${rowIndex === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'};font-size:12px">
      <span style="width:36px;text-align:left;color:var(--c-faint);font-weight:600;flex-shrink:0;font-size:11px;text-transform:uppercase;letter-spacing:0.05em">R${leg.legNumber}</span>
      <div style="flex:1;height:3px;background:#F1F5F9;border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${Math.max(2, barPct)}%;background:${barColour};border-radius:2px"></div>
      </div>
      <span style="min-width:${showRowProjection ? 120 : 80}px;text-align:right;color:var(--c-black);font-variant-numeric:tabular-nums;font-size:12px">${paceCell}</span>
      <span style="min-width:40px;text-align:right;color:var(--c-faint);font-variant-numeric:tabular-nums;font-size:11px">${deltaCell}</span>
      <span style="width:14px;flex-shrink:0"></span>
    </div>
  `;
}

function renderStationOrderRow(
  line: HyroxStationLine,
  proj: HyroxStationProjection | undefined,
  state: SimulatorState,
  fmt: HyroxFormat,
  rowIndex: number,
): string {
  const display = STATION_DISPLAY[line.station];
  const sourceTag = line.source === 'calibrated' ? 'Your time' : 'Estimated';

  // Show "current → projected" when the horizon model produces a meaningful
  // gain (≥ 1s). Anchor `currentSec` to baseSec (test-pace), not adjustedSec
  // (post-venue), so today's number matches the BENCHMARKS card.
  const currentSec = Math.round(line.baseSec);
  const projectedSec = proj ? proj.projectedSec : currentSec;
  const projDelta = currentSec - projectedSec;
  const showProjection = projDelta >= 1;

  // PR badge when the latest history entry beats all priors.
  const isPR = line.source === 'calibrated' && latestIsPR(state, line.station, fmt);
  const prBadge = isPR
    ? `<span style="font-size:10px;font-weight:600;color:#4f5a3b;background:rgba(122,132,92,0.16);border-radius:6px;padding:2px 7px;flex-shrink:0">PR</span>`
    : '';

  // Test-age caption only when stale (≥ 4 mo) — matches the BENCHMARKS card
  // convention.
  const ageMo = line.source === 'calibrated' ? latestTestAgeMonths(state, line.station) : null;
  const ageCaption = (ageMo != null && ageMo >= 4)
    ? `<span style="font-size:10px;color:var(--c-faint)">Tested ${Math.round(ageMo)} mo ago</span>`
    : '';

  const timeCell = showProjection
    ? `${fmtMmSs(currentSec)} → ${fmtMmSs(projectedSec)}`
    : fmtMmSs(currentSec);
  const deltaCell = showProjection ? `−${fmtShortDelta(projDelta)}` : '—';

  return `
    <div data-hx-station-row="${line.station}" role="button" tabindex="0" style="display:flex;align-items:center;gap:10px;padding:11px 0;font-size:13px;border-top:${rowIndex === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'};cursor:pointer;-webkit-tap-highlight-color:transparent">
      <span style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0">
        <span style="color:var(--c-black)">${display.name}</span>
        <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.06em">${sourceTag}</span>
          ${prBadge}
          ${ageCaption}
        </span>
      </span>
      <span style="min-width:${showProjection ? 120 : 80}px;text-align:right;color:var(--c-black);font-variant-numeric:tabular-nums">${timeCell}</span>
      <span style="min-width:40px;text-align:right;color:var(--c-faint);font-variant-numeric:tabular-nums;font-size:11px">${deltaCell}</span>
      <span style="color:var(--c-faint);font-size:14px;line-height:1;flex-shrink:0">›</span>
    </div>
  `;
}

function renderStationsTable(stations: HyroxStationLine[], state: SimulatorState): string {
  const fmt = (state.hyroxConfig?.format ?? 'open_singles') as HyroxFormat;
  return stations.map((line, i) => {
    const display = STATION_DISPLAY[line.station];
    const sourceTag = line.source === 'calibrated' ? 'Your time' : 'Estimated';
    const delta = line.adjustedSec - line.baseSec;
    const showDelta = Math.abs(delta) >= 1;
    const pct = line.source === 'calibrated' ? getStationPercentile(line.station, line.baseSec) : null;
    const status = pct != null ? stationStatus(pct) : null;
    const statusChip = status === 'strength'
      ? `<span style="font-size:10px;font-weight:600;color:#4f5a3b;background:rgba(122,132,92,0.12);border-radius:6px;padding:2px 7px;flex-shrink:0">Strength</span>`
      : status === 'limiter'
      ? `<span style="font-size:10px;font-weight:500;color:var(--c-black);border:1px solid rgba(0,0,0,0.12);border-radius:6px;padding:2px 7px;flex-shrink:0">Target</span>`
      : '';

    // Inline percentile (e.g. "p73") — only when calibrated, since seed-based
    // entries have no athlete-personal percentile.
    const pctChip = pct != null
      ? `<span style="font-size:10px;color:var(--c-muted);font-variant-numeric:tabular-nums">p${pct}</span>`
      : '';

    // PR badge when the latest history entry beats all priors.
    const isPR = line.source === 'calibrated' && latestIsPR(state, line.station, fmt);
    const prBadge = isPR
      ? `<span style="font-size:10px;font-weight:600;color:#4f5a3b;background:rgba(122,132,92,0.16);border-radius:6px;padding:2px 7px;flex-shrink:0">New PR</span>`
      : '';

    // Test staleness caption — surfaces when the latest test is more than ~4 mo
    // old. Below that, no caption (recent enough to trust).
    const ageMo = line.source === 'calibrated' ? latestTestAgeMonths(state, line.station) : null;
    const ageCaption = (ageMo != null && ageMo >= 4)
      ? `<span style="font-size:10px;color:var(--c-faint)">Tested ${Math.round(ageMo)} mo ago</span>`
      : '';

    return `
      <div data-hx-station-row="${line.station}" role="button" tabindex="0" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;font-size:13px;border-top:${i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'};cursor:pointer;-webkit-tap-highlight-color:transparent">
        <span style="display:flex;flex-direction:column;gap:3px;flex:1;min-width:0">
          <span style="color:var(--c-black)">${display.name}</span>
          <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.06em">${sourceTag}</span>
            ${pctChip}
            ${statusChip}
            ${prBadge}
            ${ageCaption}
          </span>
        </span>
        <span style="display:flex;gap:14px;align-items:baseline;flex-shrink:0">
          <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(line.adjustedSec)}</span>
          ${showDelta ? `<span style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums;min-width:40px;text-align:right">${delta > 0 ? '+' : '−'}${fmtShortDelta(Math.abs(delta))}</span>` : '<span style="min-width:40px"></span>'}
          <span style="color:var(--c-faint);font-size:14px;line-height:1;flex-shrink:0">›</span>
        </span>
      </div>
    `;
  }).join('');
}

/**
 * Footer caption explaining where the trajectory's gain numbers come from.
 * Surfaced under the race-order card when a horizon projection is present,
 * so users can see the dose ("1.5 sessions/wk for 6.0 weeks") and the
 * scientific anchor for the gain rates.
 */
function renderTrajectoryFooter(proj: HyroxProjectionMarkers): string {
  if (proj.weeksRemaining <= 0) return '';
  const sessions = proj.plannedSessionsPerWeek;
  const sessionsLabel = sessions > 0
    ? `${sessions.toFixed(1)} session${sessions >= 1.5 ? 's' : ''}/wk`
    : 'no planned sessions yet';
  return `<div style="font-size:11px;color:var(--c-faint);padding:10px 0 0;border-top:1px solid rgba(0,0,0,0.05);margin-top:8px;line-height:1.5">${sessionsLabel} for ${proj.weeksRemaining.toFixed(1)} weeks. Gain rates anchored on rowing, local muscular endurance, and HIFT adaptation literature; per-class differences applied (cardio, strength-endurance, grip-carry). Taper is gradiented (Mujika 2002) — gains shrink toward race day.</div>`;
}

/**
 * "Where to gain" card — top stations ranked by absolute gainable seconds at
 * the user's current training dose (per ISSUE-194). Reads the weakest-link
 * helper which reuses the existing per-station horizon model.
 *
 * Hidden when no race date is set (projection produces no gain) or when no
 * station has ≥1 second of gain available.
 */
function renderWhereToGainCard(prediction: HyroxPrediction): string {
  const top = topWeakestLinks(prediction, 2);
  if (top.length === 0) return '';
  const totalGain = top.reduce((sum, r) => sum + r.gainableSec, 0);
  const rows = top.map((r, i) => {
    const display = STATION_DISPLAY[r.station];
    const sub = r.source === 'calibrated' ? 'Your time' : 'Estimated';
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;font-size:13px;border-top:${i === 0 ? 'none' : '1px solid rgba(0,0,0,0.05)'}">
        <span style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">
          <span style="color:var(--c-black)">${display.name}</span>
          <span style="font-size:10px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.06em">${sub}</span>
        </span>
        <span style="display:flex;gap:14px;align-items:baseline;flex-shrink:0">
          <span style="color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(r.currentSec)} → ${fmtMmSs(r.projectedSec)}</span>
          <span style="font-size:12px;color:#4f5a3b;font-weight:600;font-variant-numeric:tabular-nums;min-width:40px;text-align:right">−${Math.round(r.gainableSec)}s</span>
        </span>
      </div>
    `;
  }).join('');
  return `
    <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Where to gain</div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:8px;line-height:1.5">Highest-impact stations at your current training dose. Total gain available: ~${Math.round(totalGain)} sec.</div>
      ${rows}
    </div>
  `;
}

function renderSkillsAnalysis(stations: HyroxStationLine[], athleteBand: string): string {
  const calibrated = stations.filter(l => l.source === 'calibrated');
  if (calibrated.length < 2) return '';

  // Use the new station-potential helper: ranks by time-savings vs the
  // next-band-up seed, not just population percentile. Couples to the
  // forward-looking "if you closed the gap" framing.
  const potential = computeStationPotential(athleteBand as any, stations);
  if (potential.topTargets.length === 0) return '';

  const fmtSec = (s: number) => {
    const total = Math.round(s);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const targetBandLabel = potential.topTargets[0]?.targetBand
    ? potential.topTargets[0].targetBand.replace(/_/g, ' ')
    : 'next band';

  // Green saving pill — universal "improvement = green" signal, matching the
  // trend-card delta colour. Distinct from the radar (indigo) and the four
  // percentile-row hues, and reads instantly as "good thing".
  const limiterRows = potential.topTargets.map(p => {
    const pct = getStationPercentile(p.station, p.currentSec);
    return `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;padding:10px 0;border-top:1px solid rgba(0,0,0,0.05)">
        <div style="flex:1">
          <div style="font-size:13px;color:#0F172A;font-weight:500">${p.label}</div>
          <div style="font-size:11px;color:var(--c-muted);margin-top:2px">${p.currentSec}s now → ${p.targetSec}s at ${targetBandLabel}</div>
        </div>
        <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:3px">
          <span style="font-size:11px;font-weight:600;color:#15803D;background:rgba(34,197,94,0.14);border-radius:100px;padding:2px 8px;font-variant-numeric:tabular-nums">−${p.savingSec}s</span>
          <span style="font-size:10px;color:var(--c-faint);font-variant-numeric:tabular-nums">${fmtSec(p.currentSec)} · p${pct}</span>
        </div>
      </div>
    `;
  }).join('');

  const totalSavingLine = potential.totalSavingSec >= 30
    ? `<div style="font-size:11px;color:var(--c-faint);padding:10px 0 0;border-top:1px solid rgba(0,0,0,0.05);margin-top:4px">Combined upside if all targets close: ~${Math.round(potential.totalSavingSec)}s.</div>`
    : '';

  return `
    <div class="hf" style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
      <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Biggest targets</div>
      <div style="font-size:12px;color:var(--c-muted);margin-bottom:2px">Closing the gap to ${targetBandLabel}-band on these would deliver the most time back.</div>
      ${limiterRows}
      ${totalSavingLine}
    </div>
  `;
}

export function renderHyroxForecastView(): void {
  const root = document.getElementById('app-root');
  if (!root) return;
  const s = getState();
  const hx = s.hyroxConfig;
  if (!hx) return;

  const prediction = predictHyroxRace(s);
  const venue = hx.venueId ? getHyroxVenueById(hx.venueId) : undefined;

  const initials = (s.onboarding?.name || 'You')
    .split(' ').slice(0, 2).map((n: string) => n[0]?.toUpperCase() || '').join('');
  const raceDate = hx.raceDate ?? s.onboarding?.customRaceDate;
  const raceDays = raceDate ? daysUntil(raceDate) : 0;
  const raceCountdownDisplay = raceDays > 14 ? `${Math.floor(raceDays / 7)}` : `${raceDays}`;
  const raceCountdownUnit = raceDays > 14 ? 'weeks' : 'days';

  const body = !prediction
    ? `
      <div style="font-size:14px;color:var(--c-muted);line-height:1.6;background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;padding:20px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)">
        Forecast not yet available. Set your previous Hyrox time or calibrate station benchmarks to get a prediction.
      </div>
    `
    : (() => {
        // Hoisted: shared between the headline race-day projection card and
        // the per-leg run breakdown so both cards read from the same source.
        const proj = buildHyroxProjection(s, prediction);
        const projectedRunSec = proj.weeksRemaining > 0 ? proj.byDiscipline.run.projectedSec : undefined;
        const rawForPct = Math.max(prediction.rawSec, 1);
        const factorRows = (prediction.courseFactors ?? []).map(f => {
          const pct = (f.deltaSec / rawForPct) * 100;
          const isZero = Math.abs(pct) < 0.05;
          const sign = isZero ? '' : (pct > 0 ? '+' : '−');
          const pctText = isZero ? '0.0%' : `${sign}${Math.abs(pct).toFixed(1)}%`;
          const pctColor = isZero ? 'var(--c-faint)' : 'var(--c-muted)';
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12px;border-top:1px solid rgba(0,0,0,0.05)">
              <span style="color:var(--c-muted)">${f.label}</span>
              <span style="display:flex;gap:14px;align-items:center">
                <span style="color:var(--c-black)">${f.value}</span>
                <span style="color:${pctColor};font-variant-numeric:tabular-nums;min-width:56px;text-align:right">${pctText}</span>
              </span>
            </div>
          `;
        }).join('');

        const totalDelta = prediction.totalSec - prediction.rawSec;
        const totalPct = (totalDelta / rawForPct) * 100;
        const totalSign = totalPct >= 0 ? '+' : '−';
        const slowerOrFaster = totalPct >= 0 ? 'slower' : 'faster';
        const venueNote = venue?.notes
          ? `<div style="font-size:12px;color:var(--c-faint);padding:0 0 10px;line-height:1.5;font-style:italic">${venue.notes}</div>`
          : '';
        const factorsPanel = prediction.courseFactors.length === 0
          ? `<div style="font-size:12px;color:var(--c-faint);padding:10px 0">No race picked yet. Set your race in onboarding to apply floor, lap, and temperature adjustments for the venue.</div>`
          : `
            <div style="font-size:12px;color:var(--c-muted);padding:6px 0 10px;line-height:1.5">Athletes tend to finish ${totalSign}${Math.abs(totalPct).toFixed(1)}% ${slowerOrFaster} at this venue. Raw fitness: ${fmtMmSs(prediction.rawSec)}.</div>
            ${venueNote}
            ${factorRows}
            <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 4px;font-size:13px;border-top:1px solid rgba(0,0,0,0.10);margin-top:4px">
              <span style="color:var(--c-black);font-weight:600">Adjusted finish</span>
              <span style="display:flex;gap:14px;align-items:center">
                <span style="color:var(--c-black);font-weight:600;font-variant-numeric:tabular-nums">${fmtMmSs(prediction.totalSec)}</span>
                <span style="color:var(--c-muted);font-variant-numeric:tabular-nums;min-width:56px;text-align:right">${totalSign}${Math.abs(totalPct).toFixed(1)}%</span>
              </span>
            </div>
          `;

        const confidenceLabel =
          prediction.confidence === 'high'   ? 'High confidence'   :
          prediction.confidence === 'medium' ? 'Medium confidence' :
                                                'Low confidence';
        const confidenceCaption =
          prediction.confidence === 'high'
            ? `Based on ${prediction.calibratedCount}/${prediction.stations.length} calibrated benchmarks${venue ? ` and venue factors` : ''}.`
          : prediction.confidence === 'medium'
            ? `${prediction.calibratedCount}/${prediction.stations.length} stations calibrated. Calibrate more to sharpen the prediction.`
            : `Mostly seed data — only ${prediction.calibratedCount}/${prediction.stations.length} stations calibrated. Best treated as a rough benchmark.`;
        const conversionNote = prediction.crossFormatConversion === 'doubles_to_singles'
          ? `Forecast based on seed times — your benchmarks are from a doubles race. Add singles splits to calibrate.`
          : prediction.crossFormatConversion === 'singles_to_doubles'
          ? `Forecast based on seed times — your benchmarks are from a singles race. Add doubles splits to calibrate.`
          : '';

        // Previous-time race-equivalent line: if user logged a previous race at a different
        // venue, surface what that time would translate to at the target venue.
        const prevRaceId = hx.hyroxPreviousTimeRaceId;
        const prevTimeSec = hx.previousHyroxTimeSec;
        const prevEvent = prevRaceId ? getHyroxEventById(prevRaceId) : undefined;
        const prevVenueId = prevRaceId ? getVenueIdForEvent(prevRaceId) : undefined;
        const equivalentNote = (prevEvent && prevTimeSec && hx.venueId && prevVenueId && prevVenueId !== hx.venueId)
          ? `Your ${fmtMmSs(prevTimeSec)} from ${prevEvent.city} ≈ ${fmtMmSs(rescaleTimeAcrossVenues(prevTimeSec, prevVenueId, hx.venueId))} at ${venue?.city ?? 'this venue'}.`
          : '';

        // Race-age staleness chip. Surfaces when the previous race is at least
        // 'aging' (>6 months); strong physiology mitigation softens the copy.
        const stale = prediction.staleness;
        const stalenessNote = (() => {
          if (!stale || stale.category === 'fresh' || stale.category === 'unknown') return '';
          const months = Math.round(stale.ageMonths);
          const monthLabel = months === 1 ? 'month' : 'months';
          const mitigated = stale.physiologyMitigation > 0.85;
          const mitigationCopy = mitigated ? ' Strong current physiology mitigates the gap.' : '';
          if (stale.category === 'aging')      return `Race ${months} ${monthLabel} ago. Confidence reduced. Add a recent benchmark for sharper forecasts.${mitigationCopy}`;
          if (stale.category === 'stale')      return `Race ${months} ${monthLabel} ago. Forecast leans on current physiology evidence.${mitigationCopy}`;
          if (stale.category === 'very_stale') return `Race ${months} ${monthLabel} ago. Forecast is mostly modelled from current physiology.${mitigationCopy}`;
          return '';
        })();

        // Run-pace source caption — surfaces when the run pace is VDOT-derived
        // or seed-fallback (vs user-set), so users see why the headline number
        // moved.
        const runPaceSourceNote = prediction.runPaceSource === 'derived'
          ? `Run pace updated from your VDOT.`
          : prediction.runPaceSource === 'seed'
          ? `Run pace estimated from population data. Add a recent run for VDOT-anchored prediction.`
          : '';

        // Station-test CTA banner — promotes the existing half-test calibration
        // flow on the plan view. Surfaces whenever any station is still on a
        // population seed. Two copy variants:
        //   - Recent race (≤ 6 mo, staleness 'fresh'): softer 'optional
        //     sharpening' nudge — the race time is doing the calibration work.
        //   - Otherwise: direct CTA — testing is the primary calibration path.
        const pendingStations = prediction.stations.length - prediction.calibratedCount;
        const showCalibrationBanner = pendingStations > 0;
        const hasFreshRace = prediction.staleness?.category === 'fresh';
        const calibrationBannerHtml = showCalibrationBanner ? (() => {
          const stationsLabel = pendingStations === 1
            ? '1 station is using a population average'
            : `${pendingStations} stations are using population averages`;
          const headline = hasFreshRace
            ? 'Your race time is anchoring this forecast.'
            : 'Test your stations to sharpen this forecast.';
          const caption = hasFreshRace
            ? `${stationsLabel}. Station tests are optional with a recent race, but they sharpen the per-leg detail.`
            : `${stationsLabel}. A short half-distance test of each gives a personal anchor instead of population data.`;
          return `
            <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
              <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Sharpen this forecast</div>
              <div style="font-size:13px;font-weight:600;color:var(--c-black);line-height:1.5;margin-bottom:4px">${headline}</div>
              <div style="font-size:12px;color:var(--c-muted);line-height:1.5;margin-bottom:12px">${caption}</div>
              <button id="hx-test-stations-cta" style="font-size:12px;font-weight:600;color:var(--c-black);background:transparent;border:1px solid var(--c-border);border-radius:8px;padding:8px 14px;cursor:pointer">Test stations →</button>
            </div>
          `;
        })() : '';

        return `
          <!-- Hero finish time -->
          <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:24px 22px 20px;margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
              <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em">${venue ? `${venue.city} · ${venue.name}` : 'Predicted finish'}</div>
              <button id="hx-conf-badge" style="font-size:10px;color:var(--c-muted);background:transparent;border:1px solid rgba(0,0,0,0.10);border-radius:6px;padding:2px 8px;cursor:pointer">${confidenceLabel}</button>
            </div>
            <div style="font-size:54px;font-weight:200;color:var(--c-black);font-variant-numeric:tabular-nums;letter-spacing:-0.025em;line-height:1">${fmtMmSs(prediction.totalSec)}</div>
            <div style="display:flex;gap:18px;margin-top:12px;font-size:12px;color:var(--c-muted)">
              <span>Run ${fmtMmSs(prediction.runSec)}</span>
              <span>Stations ${fmtMmSs(prediction.stationsSec)}</span>
              <span>RoxZone ${fmtMmSs(prediction.roxzoneSec)}</span>
            </div>
            <button id="hx-set-target-cta" style="margin-top:14px;padding:0;background:transparent;border:none;color:var(--c-muted);font-size:12px;cursor:pointer;text-align:left">${
              hx.targetFinishTimeSec
                ? `Target ${fmtMmSs(hx.targetFinishTimeSec)} · Edit ›`
                : `Set a target finish ›`
            }</button>
            ${prevTimeSec != null ? (() => {
              const label = (() => {
                switch (hx.hyroxPreviousTimeFormat) {
                  case 'open_singles': return 'Open Singles';
                  case 'open_doubles': return 'Open Doubles';
                  case 'pro_singles':  return 'Pro Singles';
                  case 'pro_doubles':  return 'Pro Doubles';
                  default:             return 'Format unset';
                }
              })();
              return `<button id="hx-verify-prev-format" style="margin-top:6px;padding:0;background:transparent;border:none;color:var(--c-muted);font-size:12px;cursor:pointer;text-align:left;display:block">Previous race: ${label} · ${fmtMmSs(prevTimeSec)} · Change ›</button>`;
            })() : ''}
            <div id="hx-conf-detail" style="display:none;margin-top:14px;padding:10px 12px;border-radius:10px;background:#F8FAFC;border:1px solid var(--c-border)">
              <div style="font-size:12px;color:var(--c-black);line-height:1.5">${confidenceCaption}</div>
              ${conversionNote ? `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">${conversionNote}</div>` : ''}
              ${stalenessNote ? `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">${stalenessNote}</div>` : ''}
              ${runPaceSourceNote ? `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">${runPaceSourceNote}</div>` : ''}
              ${equivalentNote ? `<div style="font-size:11px;color:var(--c-muted);margin-top:4px">${equivalentNote}</div>` : ''}
              <div style="font-size:11px;color:var(--c-faint);margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.06)">Calibrated against 89,868 real HYROX finishers from Seasons 4–6.</div>
            </div>
          </div>

          ${calibrationBannerHtml}

          <!-- Race-day projection -->
          ${(() => {
            if (proj.weeksRemaining === 0 && proj.factors.length === 0) return '';
            const fmtDelta = (sec: number) => sec === 0 ? '—' : (sec > 0 ? `+${sec}s` : `−${Math.abs(sec)}s`);
            // UX_PATTERNS: neutrals only — direction comes from the +/− sign,
            // not from green/amber tone. Avoid mixing semantic colours per row.
            const factorRows = proj.factors.map(f => `
                <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;padding:8px 0;font-size:12px;border-top:1px solid rgba(0,0,0,0.05)">
                  <div style="flex:1">
                    <div style="color:var(--c-black);font-weight:500">${f.name}</div>
                    <div style="font-size:11px;color:var(--c-muted);margin-top:1px;line-height:1.4">${f.explanation}</div>
                  </div>
                  <div style="color:var(--c-muted);font-variant-numeric:tabular-nums;min-width:48px;text-align:right">${fmtDelta(f.deltaSec)}</div>
                </div>
              `).join('');
            const improveLabel = proj.improvementSec < 0 ? 'faster' : proj.improvementSec > 0 ? 'slower' : 'no change';
            return `
              <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
                <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Race-day projection</div>
                ${proj.weeksRemaining > 0 ? `<div style="font-size:12px;color:var(--c-muted);margin-bottom:8px;line-height:1.5">If you stick with the plan, by race day (~${proj.weeksRemaining.toFixed(1)} weeks):</div>` : ''}
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:6px 0 8px">
                  <span style="color:var(--c-black);font-weight:600;font-size:13px">Projected finish</span>
                  <span style="display:flex;gap:14px;align-items:baseline">
                    <span style="font-size:22px;font-weight:300;color:var(--c-black);font-variant-numeric:tabular-nums">${fmtMmSs(proj.projectedTotalSec)}</span>
                    <span style="font-size:11px;color:var(--c-muted);font-variant-numeric:tabular-nums;min-width:62px;text-align:right">${proj.improvementSec === 0 ? '—' : `${fmtDelta(proj.improvementSec)} ${improveLabel}`}</span>
                  </span>
                </div>
                <div style="font-size:11px;color:var(--c-faint);font-variant-numeric:tabular-nums;padding:0 0 6px">Likely range: ${fmtMmSs(proj.confidenceRangeSec[0])} – ${fmtMmSs(proj.confidenceRangeSec[1])}</div>
                ${proj.improvementSec !== 0 ? `
                  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;padding:8px 0;border-top:1px solid rgba(0,0,0,0.05);margin:4px 0">
                    ${[
                      { label: 'Run',      d: proj.byDiscipline.run },
                      { label: 'Stations', d: proj.byDiscipline.stations },
                      { label: 'RoxZone',  d: proj.byDiscipline.roxzone },
                    ].map(({label, d}) => `
                      <div>
                        <div style="font-size:10px;color:var(--c-faint)">${label}</div>
                        <div style="font-size:13px;color:var(--c-black);font-variant-numeric:tabular-nums;margin-top:2px">${fmtMmSs(d.projectedSec)}</div>
                        <div style="font-size:10px;color:var(--c-muted);font-variant-numeric:tabular-nums">${d.deltaSec === 0 ? '—' : (d.deltaSec > 0 ? `+${d.deltaSec}s` : `−${Math.abs(d.deltaSec)}s`)}</div>
                      </div>
                    `).join('')}
                  </div>
                ` : ''}
                ${factorRows}
                <div style="font-size:10px;color:var(--c-faint);padding:10px 0 0;border-top:1px solid rgba(0,0,0,0.05);margin-top:6px;line-height:1.4">Factor weights are heuristic — anchored on running and triathlon prediction models, not yet validated against HYROX outcome data. Treat the projection as directional, not precise.</div>
              </div>
            `;
          })()}

          <!-- Course factors -->
          <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
            <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">Course factors</div>
            ${factorsPanel}
          </div>

          <!-- Race-order forecast: runs and stations interleaved (singles only).
               Each row shows current → projected with delta. Doubles falls back
               to separate Run Legs + Per-station forecast cards because the
               athlete only does 4 of 8 stations. -->
          ${(hx.format !== 'open_doubles' && hx.format !== 'pro_doubles') ? (() => {
            // Average 1km run pace before fatigue/venue itemisation. Computed from
            // total run time (post-venue) ÷ 8 so the header matches what the
            // run rows below sum to. Projected pace uses the same projectedRunSec
            // already wired to the headline card.
            const avgPaceSecKm = Math.round(prediction.runSec / 8);
            const avgProjPaceSecKm = projectedRunSec ? Math.round(projectedRunSec / 8) : null;
            const showAvgProj = avgProjPaceSecKm != null && avgPaceSecKm - avgProjPaceSecKm >= 1;
            const avgPaceCell = showAvgProj
              ? `${fmtPace(avgPaceSecKm).replace('/km', '')} → ${fmtPace(avgProjPaceSecKm!)}`
              : fmtPace(avgPaceSecKm);
            return `
            <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
              <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Race order</div>
              <div style="font-size:12px;color:var(--c-muted);margin-bottom:10px;line-height:1.4">Run, station, run, station — your race in sequence. Times show today → race day projection where the horizon model expects gain.</div>
              <div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-top:1px solid rgba(0,0,0,0.05);border-bottom:1px solid rgba(0,0,0,0.05);margin-bottom:2px">
                <div style="display:flex;flex-direction:column;gap:2px">
                  <span style="font-size:12px;color:var(--c-black);font-weight:500">Average run pace</span>
                  <span style="font-size:10px;color:var(--c-faint)">Across all 8 × 1km legs, post-venue</span>
                </div>
                <span style="font-size:13px;color:var(--c-black);font-variant-numeric:tabular-nums">${avgPaceCell}</span>
              </div>
              ${renderRaceOrderTable(prediction, projectedRunSec, s)}
              ${prediction.projection ? renderTrajectoryFooter(prediction.projection) : ''}
            </div>
          `;
          })() : `
            <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
              <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Run legs</div>
              <div style="font-size:11px;color:var(--c-faint);margin-bottom:8px">${projectedRunSec ? 'Each 1km. Bar shows in-race fatigue. Right column shows projected race-day pace gain.' : 'Each 1km. Pace drifts with cumulative station fatigue.'}</div>
              ${renderRunLegsTable(prediction.runLegs, prediction.runSec, projectedRunSec)}
            </div>
            <div style="background:rgba(255,255,255,0.78);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06);padding:18px 20px;margin-bottom:14px">
              <div style="font-size:11px;color:var(--c-faint);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Your stations</div>
              <div style="font-size:12px;color:var(--c-muted);margin-bottom:10px;line-height:1.4">In doubles you complete 4 of 8 stations; partner takes the others. Times shown are your active stations only.</div>
              ${renderStationsTable(prediction.stations, s)}
            </div>
          `}

          <!-- Skills analysis (strengths vs limiters) -->
          ${renderSkillsAnalysis(prediction.stations, hx.athleteBand)}

          <!-- Where to gain (top stations ranked by absolute gainable seconds) -->
          ${renderWhereToGainCard(prediction)}

          <!-- Performance radar (8-axis percentile) -->
          ${renderPerformanceRadar({ stations: prediction.stations })}

          <!-- Percentile distributions (per-metric kernel density) -->
          ${renderPercentileDistributions(prediction)}
        `;
      })();

  root.innerHTML = `
    <div class="mosaic-page" style="min-height:100vh;background:${atmosphereGradient('sky')};position:relative;overflow:hidden">
      <div style="position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0">
        ${buildRingBackground('hxf', { variant: 'sweep', palette: 'sky', pulse: true })}
      </div>
      ${buildSunGlint('low')}
      ${renderTabBar('forecast')}
      <div style="position:relative;z-index:10;padding:56px 16px 120px;max-width:560px;margin:0 auto">
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:18px">
          ${raceDays > 0 ? `
            <div style="display:flex;align-items:baseline;gap:4px;padding:4px 14px;border-radius:100px;background:rgba(255,255,255,0.7);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-shadow:0 1px 4px rgba(0,0,0,0.06)">
              <span style="font-size:11px;font-weight:500;color:#64748B">Race in</span>
              <span style="font-size:22px;font-weight:700;letter-spacing:-0.03em;color:#0F172A;line-height:1">${raceCountdownDisplay}</span>
              <span style="font-size:11px;font-weight:500;color:#64748B">${raceCountdownUnit}</span>
            </div>
          ` : ''}
          <button id="hx-forecast-account-btn" class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">${initials || 'Me'}</button>
        </div>
        <div style="font-size:24px;font-weight:300;color:var(--c-black);letter-spacing:-0.01em;margin:0 0 16px">Forecast</div>
        ${body}
      </div>
    </div>
  `;

  // Account button → navigate to account view.
  document.getElementById('hx-forecast-account-btn')?.addEventListener('click', () => {
    import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
  });

  // Confidence badge: toggle the explanation panel.
  document.getElementById('hx-conf-badge')?.addEventListener('click', () => {
    const detail = document.getElementById('hx-conf-detail');
    if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
  });

  // "Set a target finish" CTA → goal-back-calc modal (ISSUE-196).
  document.getElementById('hx-set-target-cta')?.addEventListener('click', () => {
    const currentPrediction = predictHyroxRace(getState());
    if (!currentPrediction) return;
    import('./goal-modal').then(({ openHyroxGoalModal }) => {
      openHyroxGoalModal(currentPrediction);
    });
  });

  // "Previous race format · Change" affordance → opens a small modal listing
  // the four formats. Confirming a different format slot-moves benchmarks,
  // re-bands using the cross-format factor, regenerates the plan, and re-renders.
  // Repairs states broken by the pre-fix wizard render that pre-lit the format
  // pill matching the target format.
  document.getElementById('hx-verify-prev-format')?.addEventListener('click', () => {
    openHyroxPrevFormatModal();
  });

  // Per-station row tap → station detail sub-page (ISSUE-193).
  document.querySelectorAll<HTMLElement>('[data-hx-station-row]').forEach(row => {
    row.addEventListener('click', () => {
      const station = row.getAttribute('data-hx-station-row') as import('@/types/triathlon').HyroxStation;
      if (!station) return;
      import('./station-detail-view').then(({ renderHyroxStationDetailView }) => {
        renderHyroxStationDetailView(station);
      });
    });
  });

  // "Test stations" CTA — un-dismiss the benchmark card so it surfaces on the
  // plan view we're navigating to, then navigate. Without the un-dismiss, a
  // user who previously dismissed the card would land on the plan with nowhere
  // to enter station times.
  const wireCalibrateCta = (id: string) => {
    document.getElementById(id)?.addEventListener('click', () => {
      const ms = getMutableState();
      if (ms.hyroxConfig && (ms.hyroxConfig as { dismissedBenchmarkCard?: boolean }).dismissedBenchmarkCard) {
        (ms.hyroxConfig as { dismissedBenchmarkCard?: boolean }).dismissedBenchmarkCard = false;
        saveState();
      }
      import('@/ui/hyrox/plan-view').then(({ renderHyroxPlanView }) => renderHyroxPlanView());
    });
  };
  wireCalibrateCta('hx-test-stations-cta');
  wireCalibrateCta('hx-radar-calibrate-cta');

  wireTabBarHandlers((tab: TabId) => {
    if (tab === 'home') {
      import('@/ui/home-view').then(({ renderHomeView }) => renderHomeView());
    } else if (tab === 'plan') {
      import('@/ui/hyrox/plan-view').then(({ renderHyroxPlanView }) => renderHyroxPlanView());
    } else if (tab === 'stats') {
      import('@/ui/hyrox/stats-view').then(({ renderHyroxStatsView }) => renderHyroxStatsView());
    } else if (tab === 'account') {
      import('@/ui/account-view').then(({ renderAccountView }) => renderAccountView());
    }
  });
}

function openHyroxPrevFormatModal(): void {
  const hx = getState().hyroxConfig;
  if (!hx) return;
  const current = hx.hyroxPreviousTimeFormat;
  const options: Array<{ id: HyroxFormat; label: string }> = [
    { id: 'open_singles', label: 'Open Singles' },
    { id: 'open_doubles', label: 'Open Doubles' },
    { id: 'pro_singles',  label: 'Pro Singles' },
    { id: 'pro_doubles',  label: 'Pro Doubles' },
  ];
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.32);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
  overlay.innerHTML = `
    <div role="dialog" aria-modal="true" style="width:100%;max-width:380px;background:#FDFCF7;border-radius:18px;padding:22px 20px 18px;box-shadow:0 12px 40px rgba(0,0,0,0.18)">
      <div style="font-size:16px;font-weight:500;color:var(--c-black);margin-bottom:6px">Previous race format</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5;margin-bottom:14px">Doubles times scale differently to singles. Confirming the right format keeps your benchmarks and prediction honest.</div>
      <div id="hx-prev-fmt-options" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
        ${options.map(o => `
          <button data-fmt="${o.id}" class="hx-prev-fmt-pill" style="padding:10px 8px;border-radius:12px;border:1px solid ${current === o.id ? 'var(--c-black)' : 'rgba(0,0,0,0.10)'};background:${current === o.id ? 'var(--c-black)' : 'rgba(255,255,255,0.95)'};color:${current === o.id ? '#FDFCF7' : 'var(--c-black)'};font-size:13px;cursor:pointer;transition:all 0.15s ease">${o.label}</button>
        `).join('')}
      </div>
      <div style="font-size:11px;color:var(--c-faint);line-height:1.5;margin-bottom:14px">If the format changes, your training plan will be regenerated against the corrected ability band. Completed activities are preserved.</div>
      <div style="display:flex;gap:10px">
        <button id="hx-prev-fmt-cancel" style="flex:1;padding:11px;border-radius:10px;border:1px solid rgba(0,0,0,0.10);background:transparent;font-size:13px;color:var(--c-muted);cursor:pointer">Cancel</button>
        <button id="hx-prev-fmt-save" style="flex:1;padding:11px;border-radius:10px;border:none;background:#0F172A;color:#fff;font-size:13px;font-weight:500;cursor:pointer;opacity:0.5" disabled>Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let picked: HyroxFormat | undefined = current;
  const saveBtn = overlay.querySelector('#hx-prev-fmt-save') as HTMLButtonElement;
  const refreshSave = () => {
    const dirty = picked != null && picked !== current;
    saveBtn.disabled = !dirty;
    saveBtn.style.opacity = dirty ? '1' : '0.5';
  };
  overlay.querySelectorAll<HTMLButtonElement>('[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      picked = btn.getAttribute('data-fmt') as HyroxFormat;
      overlay.querySelectorAll<HTMLButtonElement>('[data-fmt]').forEach(b => {
        const isPicked = b === btn;
        b.style.borderColor = isPicked ? 'var(--c-black)' : 'rgba(0,0,0,0.10)';
        b.style.background = isPicked ? 'var(--c-black)' : 'rgba(255,255,255,0.95)';
        b.style.color = isPicked ? '#FDFCF7' : 'var(--c-black)';
      });
      refreshSave();
    });
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#hx-prev-fmt-cancel')?.addEventListener('click', () => overlay.remove());
  saveBtn.addEventListener('click', () => {
    if (picked == null || picked === current) { overlay.remove(); return; }
    const result = applyHyroxPrevFormatChange(picked);
    overlay.remove();
    if (result.changed) renderHyroxForecastView();
  });
}
